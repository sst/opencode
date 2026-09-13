export * as ConfigCommandPlugin from "./command.js"

import { define } from "@opencode/plugin/effect/plugin"
import { Info, type Entry } from "@opencode/schema/config"
import { ConfigCommand } from "@opencode/schema/config/command"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { AppProcess } from "@opencode/util/process"
import path from "path"
import { Effect, Option, PubSub, Schema, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { Agent } from "../../agent.js"
import { Config } from "../../config.js"
import { Location } from "../../location.js"
import { Session } from "../../session.js"
import { SubagentJob } from "../../session/subagent-job.js"
import { ShellSelect } from "../../shell/select.js"
import { FSUtil } from "@opencode/util/fs-util"
import { ConfigMarkdown } from "../markdown.js"

const decodeCommand = Schema.decodeUnknownOption(ConfigCommand.Info)

export const Plugin = define({
  id: "opencode.config.command",
  effect: Effect.fn(function* (ctx) {
    const config = yield* Config.Service
    const fs = yield* FSUtil.Service
    const loadEntry = Effect.fnUntraced(function* (entry: Entry) {
      if (entry.type === "document") return [{ commands: entry.info.commands }]
      if (entry.type !== "directory") return []
      const commands = yield* loadDirectory(fs, entry.path)
      return [{ commands: Object.fromEntries(commands.map((command) => [command.name, command.info])) }]
    })
    const location = yield* Location.Service
    const processes = yield* AppProcess.Service
    const shell = yield* ShellSelect.Service
    const sessions = yield* Session.Service
    const agents = yield* Agent.Service
    const subagents = yield* SubagentJob.make
    const load = Effect.fn("ConfigCommandPlugin.load")(function* () {
      return yield* Effect.forEach(yield* config.entries(), loadEntry).pipe(Effect.map((documents) => documents.flat()))
    })
    const loaded = { documents: [] as { commands: Info["commands"] }[] }
    const reload = load().pipe(
      Effect.tap((documents) => Effect.sync(() => (loaded.documents = documents))),
      Effect.andThen(ctx.command.reload()),
    )
    // One trigger feed serializes reloads and shares one debounce window;
    // subscribing before the initial scan means updates racing the scan still
    // trigger a rebuild. Each source is subscribed eagerly on its own fiber
    // (Stream.merge and Stream.debounce both open upstream a fiber hop later)
    // so no update slips through while the debounce starts its pull.
    const changes = yield* PubSub.sliding<void>(1)
    const notify = () => PubSub.publish(changes, undefined)
    yield* config.changes().pipe(
      Stream.filterEffect((update) => Effect.map(config.entries(), (entries) => isCommandSource(entries, update.path))),
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
    yield* ctx.command.transform((editor) => {
      for (const document of loaded.documents) {
        for (const [name, command] of Object.entries(document.commands ?? {})) {
          const subagent = command.subagent ?? command.subtask
          editor.add({
            name,
            description: command.description,
            execute: (input) =>
              Effect.gen(function* () {
                const agent = command.agent === undefined ? undefined : Agent.ID.make(command.agent)
                const commandAgent = agent === undefined ? undefined : (yield* ctx.agent.get({ agentID: agent })).data
                const model =
                  command.model === undefined
                    ? commandAgent?.model
                    : {
                        id: Model.ID.make(command.model.model),
                        providerID: Provider.ID.make(command.model.providerID),
                        ...(command.model.variant === undefined
                          ? {}
                          : { variant: Model.VariantID.make(command.model.variant) }),
                      }
                const text = yield* evaluateTemplate(command.template, input.prompt.text, {
                  location,
                  processes,
                  shell,
                })
                if (subagent ?? commandAgent?.mode === "subagent") {
                  const parent = yield* sessions.get(input.sessionID)
                  const selected = yield* agents.select(agent ?? parent.agent)
                  const child = yield* sessions.create({
                    parentID: parent.id,
                    title: command.description ?? name,
                    agent: selected.id,
                    model: model ?? selected.info?.model ?? parent.model,
                  })
                  yield* sessions.prompt({
                    ...input.prompt,
                    sessionID: child.id,
                    text: ["You are a subagent spawned by another session.", text].join("\n"),
                    resume: false,
                  })
                  const recovery = {
                    kind: "subagent" as const,
                    parentSessionID: parent.id,
                    childSessionID: child.id,
                    agent: selected.id,
                    description: command.description ?? name,
                  }
                  yield* subagents.start(recovery)
                  yield* subagents.background(recovery)
                  return
                }
                if (agent !== undefined) {
                  const session = yield* ctx.session.get({ sessionID: input.sessionID })
                  if (session.agent !== agent) yield* ctx.session.switchAgent({ sessionID: input.sessionID, agent })
                }
                if (model !== undefined) yield* ctx.session.switchModel({ sessionID: input.sessionID, model })
                yield* ctx.session.prompt({
                  ...input.prompt,
                  sessionID: input.sessionID,
                  text,
                  delivery: input.delivery,
                })
              }).pipe(Effect.asVoid),
          })
        }
      }
    })
  }),
})

// Keep in sync with the loadDirectory scan pattern and the name-strip regex in decode.
const sourceDirectories = ["command", "commands"] as const

// Matches anything at or under <root>/{command,commands}. No file-suffix check:
// directory-level events such as renames carry no per-file paths.
function isCommandSource(entries: Entry[], file: string) {
  return entries.some(
    (entry) =>
      entry.type === "directory" &&
      sourceDirectories.some((name) => FSUtil.contains(path.join(entry.path, name), file)),
  )
}

function loadDirectory(fs: FSUtil.Interface, directory: string) {
  return Effect.gen(function* () {
    const files = yield* fs
      .scan("{command,commands}/**/*.md", { cwd: directory, absolute: true, dot: true, symlink: true })
      .pipe(Effect.orElseSucceed(() => [] as string[]))
    return yield* Effect.forEach(files.toSorted(), (filepath) =>
      fs.readFileStringSafe(filepath).pipe(
        Effect.map((content) => (content === undefined ? undefined : decode(directory, filepath, content))),
        Effect.orElseSucceed(() => undefined),
      ),
    ).pipe(
      Effect.map((commands) =>
        commands.filter((command): command is { name: string; info: ConfigCommand.Info } => command !== undefined),
      ),
    )
  })
}

function decode(directory: string, filepath: string, content: string) {
  const markdown = ConfigMarkdown.parseOption(content)
  if (!markdown) return
  const info = Option.getOrUndefined(decodeCommand({ ...markdown.data, template: markdown.content.trim() }))
  if (!info) return
  return {
    name: path
      .relative(directory, filepath)
      .replaceAll("\\", "/")
      .replace(/^(command|commands)\//, "")
      .replace(/\.md$/, ""),
    info,
  }
}

function evaluateTemplate(
  template: string,
  input: string,
  services: {
    readonly location: Location.Info
    readonly processes: AppProcess.Interface
    readonly shell: ShellSelect.Interface
  },
) {
  return Effect.gen(function* () {
    const args = parseArguments(input)
    const placeholders = template.match(placeholderRegex) ?? []
    const last = Math.max(0, ...placeholders.map((item) => Number(item.slice(1))))
    const expanded = template.replaceAll(placeholderRegex, (_, index) => {
      const position = Number(index)
      const argIndex = position - 1
      if (argIndex >= args.length) return ""
      if (position === last) return args.slice(argIndex).join(" ")
      return args[argIndex]
    })
    const withArguments = expanded.replaceAll("$ARGUMENTS", () => input)
    const text =
      placeholders.length === 0 && !template.includes("$ARGUMENTS") && input.trim()
        ? `${withArguments}\n\n${input}`.trim()
        : withArguments.trim()
    const matches = Array.from(text.matchAll(shellRegex))
    if (matches.length === 0) return text
    const shell = yield* services.shell.resolve({ priority: "config" })
    const outputs = yield* Effect.forEach(
      matches,
      (match) => {
        const source = match[1] ?? ""
        return services.processes
          .run(
            ChildProcess.make(shell, ShellSelect.args(shell, source), {
              cwd: services.location.directory,
              stdin: "ignore",
            }),
            { combineOutput: true },
          )
          .pipe(
            Effect.map((result) => (result.output ?? Buffer.concat([result.stdout, result.stderr])).toString("utf8")),
            Effect.mapError(
              (error) => new Error(`Shell interpolation failed for ${JSON.stringify(source)}: ${error.message}`),
            ),
          )
      },
      { concurrency: 2 },
    )
    const iterator = outputs[Symbol.iterator]()
    return text.replace(shellRegex, () => iterator.next().value ?? "")
  })
}

function parseArguments(input: string) {
  return (input.match(argsRegex) ?? []).map((arg) => arg.replace(quoteTrimRegex, ""))
}

const argsRegex = /(?:\[Image\s+\d+\]|"[^"]*"|'[^']*'|[^\s"']+)/gi
const placeholderRegex = /\$(\d+)/g
const quoteTrimRegex = /^["']|["']$/g
const shellRegex = /!`([^`]+)`/g
