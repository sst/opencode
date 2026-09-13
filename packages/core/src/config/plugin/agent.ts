export * as ConfigAgentPlugin from "./agent.js"

import { define } from "@opencode/plugin/effect/plugin"
import { Document, Info, type Entry } from "@opencode/schema/config"
import { ConfigAgent } from "@opencode/schema/config/agent"
import path from "path"
import { Effect, Option, PubSub, Schema, Stream } from "effect"
import { Agent } from "../../agent.js"
import { Config } from "../../config.js"
import { ConfigMarkdown } from "../markdown.js"
import { FSUtil } from "@opencode/util/fs-util"
import { ConfigAgentV1 } from "../../v1/config/agent.js"
import { ConfigMigrateV1 } from "../../v1/config/migrate.js"
import { Global } from "@opencode/util/global"
import { Permission } from "../../permission.js"
import type { FileAccess } from "../../file-access.js"
import type { ReadTool } from "../../tool/plugin/read.js"
import type { EditTool } from "../../tool/plugin/edit.js"
import { AbsolutePath } from "../../schema.js"

const legacySources = [
  { pattern: "{agent,agents}/**/*.md", primary: false },
  { pattern: "{mode,modes}/*.md", primary: true },
] as const
// Keep in sync with the legacySources patterns and the name-strip regex in decode.
const sourceDirectories = ["agent", "agents", "mode", "modes"] as const
const decodeAgent = Schema.decodeUnknownOption(ConfigAgent.Info)
const decodeLegacyAgent = Schema.decodeUnknownOption(ConfigAgentV1.Info)
const decodeConfig = Schema.decodeUnknownOption(Info)
type PathAction = FileAccess.ExternalDirectoryAuthorization["action"] | typeof ReadTool.name | typeof EditTool.name
const pathActions = ["external_directory", "read", "edit"] as const satisfies readonly PathAction[]
const agentKeys = new Set(["variant", ...Object.keys(ConfigAgent.Info.fields)])

export const Plugin = define({
  id: "opencode.config.agent",
  effect: Effect.fn(function* (ctx) {
    const config = yield* Config.Service
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    const loadEntry = Effect.fnUntraced(function* (entry: Entry) {
      if (entry.type === "document") return [entry]
      if (entry.type !== "directory") return []
      const files = yield* discover(fs, entry.path)
      return yield* Effect.forEach(files, (file) =>
        fs.readFileStringSafe(file.filepath).pipe(
          Effect.map((content) => (content ? decode(file, content) : undefined)),
          Effect.orElseSucceed(() => undefined),
        ),
      ).pipe(Effect.map((documents) => documents.filter((document): document is Document => document !== undefined)))
    })
    const load = Effect.fn("ConfigAgentPlugin.load")(function* () {
      return yield* Effect.forEach(yield* config.entries(), loadEntry).pipe(Effect.map((documents) => documents.flat()))
    })
    const loaded = { documents: [] as Document[] }
    const reload = load().pipe(
      Effect.tap((documents) => Effect.sync(() => (loaded.documents = documents))),
      Effect.andThen(ctx.agent.reload()),
    )
    // One trigger feed serializes reloads and shares one debounce window;
    // subscribing before the initial scan means updates racing the scan still
    // trigger a rebuild. Each source is subscribed eagerly on its own fiber
    // (Stream.merge and Stream.debounce both open upstream a fiber hop later)
    // so no update slips through while the debounce starts its pull.
    const changes = yield* PubSub.sliding<void>(1)
    const notify = () => PubSub.publish(changes, undefined)
    yield* config.changes().pipe(
      Stream.filterEffect((update) => Effect.map(config.entries(), (entries) => isAgentSource(entries, update.path))),
      Stream.runForEach(notify),
      Effect.forkScoped({ startImmediately: true }),
    )
    yield* ctx.event.subscribe().pipe(
      Stream.filter((event) => event.type === "config.updated"),
      Stream.runForEach(notify),
      Effect.forkScoped({ startImmediately: true }),
    )
    const updates = yield* PubSub.subscribe(changes)
    yield* Stream.fromSubscription(updates).pipe(
      Stream.debounce("100 millis"),
      Stream.runForEach(() => reload),
      Effect.forkScoped({ startImmediately: true }),
    )
    loaded.documents = yield* load()
    yield* ctx.agent.transform((editor) => {
      const permissions = expandPermissions(
        loaded.documents.flatMap((document) => document.info.permissions ?? []),
        global.home,
      )
      const configuredDefault = Config.latest(loaded.documents, "default_agent")
      if (configuredDefault !== undefined) editor.default(Agent.ID.make(configuredDefault))
      for (const current of editor.list()) {
        editor.update(current.id, (agent) => agent.permissions.push(...permissions))
      }

      for (const document of loaded.documents) {
        for (const [id, item] of Object.entries(document.info.agents ?? {})) {
          const agentID = Agent.ID.make(id)
          if (item.disabled) {
            editor.remove(agentID)
            continue
          }

          const exists = editor.get(agentID) !== undefined
          editor.update(agentID, (agent) => {
            if (!exists) agent.permissions.push(...permissions)
            if (item.model !== undefined)
              agent.model = {
                id: item.model.model,
                providerID: item.model.providerID,
                ...(item.model.variant === undefined ? {} : { variant: item.model.variant }),
              }
            if (item.request !== undefined) {
              Object.assign(agent.request.headers, item.request.headers ?? {})
              Object.assign(agent.request.body, item.request.body ?? {})
            }
            if (item.system !== undefined) agent.system = item.system
            if (item.description !== undefined) agent.description = item.description
            if (item.mode !== undefined) agent.mode = item.mode
            if (item.hidden !== undefined) agent.hidden = item.hidden
            if (item.color !== undefined) agent.color = item.color
            if (item.steps !== undefined) agent.steps = item.steps
            if (item.permissions !== undefined) {
              agent.permissions.push(...expandPermissions(item.permissions, global.home))
            }
          })
        }
      }
    })
  }),
})

// Matches anything at or under <root>/{agent,agents,mode,modes}. No file-suffix
// check: directory-level events such as renames carry no per-file paths.
function isAgentSource(entries: Entry[], file: string) {
  return entries.some(
    (entry) =>
      entry.type === "directory" &&
      sourceDirectories.some((name) => FSUtil.contains(path.join(entry.path, name), file)),
  )
}

function expandPermissions(rules: Permission.Ruleset, home: string): Permission.Ruleset {
  // Expand only resources tools resolve as filesystem paths. Bash resources are raw shell text:
  // rewriting `$HOME/private/**` would miss `$HOME/private/key`, and safe expansion needs shell-aware parsing.
  return rules.map((rule) =>
    isPathAction(rule.action) ? { ...rule, resource: expandHome(rule.resource, home) } : rule,
  )
}

function isPathAction(action: string): action is PathAction {
  return pathActions.some((item) => item === action)
}

function expandHome(resource: string, home: string) {
  if (resource === "~" || resource === "$HOME") return home
  const relative = resource.startsWith("~/")
    ? resource.slice(2)
    : resource.startsWith("$HOME/") || resource.startsWith("$HOME\\")
      ? resource.slice(6)
      : undefined
  if (relative !== undefined) return (path.posix.isAbsolute(home) ? path.posix : path.win32).join(home, relative)
  return resource
}

function discover(fs: FSUtil.Interface, directory: string) {
  return Effect.forEach(legacySources, (source) =>
    fs
      .scan(source.pattern, { cwd: directory, absolute: true, dot: true, symlink: true })
      .pipe(
        Effect.map((files) => files.toSorted().map((filepath) => ({ directory, filepath, primary: source.primary }))),
      ),
  ).pipe(
    Effect.map((files) => files.flat()),
    Effect.orElseSucceed(() => []),
  )
}

function decode(file: { directory: string; filepath: string; primary: boolean }, content: string) {
  const markdown = ConfigMarkdown.parseOption(content)
  if (!markdown) return
  const name = path
    .relative(file.directory, file.filepath)
    .replaceAll("\\", "/")
    .replace(/^(agent|agents|mode|modes)\//, "")
    .replace(/\.md$/, "")
  const body = markdown.content.trim()
  const legacy = Object.keys(markdown.data).some((key) => !agentKeys.has(key))
  // Join legacy model + variant without sending native request/permissions through migration.
  // Embedded and structured native selections, and a variant without a model, stay unchanged.
  const data =
    typeof markdown.data.model === "string" &&
    !markdown.data.model.includes("#") &&
    typeof markdown.data.variant === "string" &&
    /^[^#]+$/.test(markdown.data.variant)
      ? { ...markdown.data, model: `${markdown.data.model}#${markdown.data.variant}` }
      : markdown.data
  const agent = legacy
    ? Option.getOrUndefined(
        Option.map(
          decodeLegacyAgent({ name, ...markdown.data, prompt: body }, { errors: "all", propertyOrder: "original" }),
          ConfigMigrateV1.migrateAgent,
        ),
      )
    : Option.getOrUndefined(decodeAgent({ ...data, system: body }, { errors: "all", propertyOrder: "original" }))
  if (!agent) return
  const info = Option.getOrUndefined(
    decodeConfig({
      agents: { [name]: file.primary ? { ...agent, mode: "primary" } : agent },
    }),
  )
  if (!info) return
  return new Document({ type: "document", path: AbsolutePath.make(file.filepath), info })
}
