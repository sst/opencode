export * as ConfigInstructionPlugin from "./instruction.js"

import { define } from "@opencode/plugin/effect/plugin"
import { FSUtil } from "@opencode/util/fs-util"
import { Global } from "@opencode/util/global"
import { dirname, join, relative } from "path"
import { Effect, PubSub, Semaphore, Stream } from "effect"
import { Watcher } from "../../filesystem/watcher.js"
import { InstructionDiscovery } from "../../instruction-discovery.js"
import { Instructions } from "../../instructions/index.js"
import { Location } from "../../location.js"
import { AbsolutePath } from "../../schema.js"

type Loaded =
  | { readonly type: "available"; readonly files: InstructionDiscovery.File[] }
  | { readonly type: "unavailable" }

export const Plugin = define({
  id: "opencode.config.instruction",
  effect: Effect.fn(function* () {
    const discovery = yield* InstructionDiscovery.Service
    // Nothing this plugin watches or loads can contribute when both scopes
    // are disabled; skip the resolves, the watcher fiber, and the transform.
    if (!discovery.project && !discovery.global) return
    yield* Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const global = yield* Global.Service
      const location = yield* Location.Service
      const watcher = yield* Watcher.Service
      const changes = yield* PubSub.sliding<string>(1)
      const lock = Semaphore.makeUnsafe(1)
      const start = yield* fs.resolve(location.directory)
      const root = yield* fs.resolve(location.project.directory)
      const home = yield* fs.resolve(global.home)
      const project = discovery.project && FSUtil.contains(root, start)
      const stop = FSUtil.contains(home, start) ? home : root
      const ancestors = project ? ancestorDirectories(start, stop) : []
      const boundary = ancestors.at(-1) ?? stop
      const globalFile = yield* fs.resolve(join(global.config, "AGENTS.md"))
      const loaded: { current: Loaded } = { current: { type: "available", files: [] } }

      const publish = (update: Watcher.Update) => PubSub.publish(changes, update.path).pipe(Effect.asVoid)
      // The ancestor walk can reach the global file when the location sits
      // beneath the global config dir; global: false excludes it there too.
      const candidates = [
        ...(discovery.global ? [globalFile] : []),
        ...(project
          ? ancestors
              .map((directory) => join(directory, "AGENTS.md"))
              .filter((file) => discovery.global || file !== globalFile)
          : []),
      ]
      for (const path of new Set(candidates)) {
        const updates = yield* watcher.subscribe({ path, type: "file" })
        yield* updates.pipe(Stream.runForEach(publish), Effect.forkScoped({ startImmediately: true }))
      }

      const read = Effect.fn("ConfigInstructionPlugin.read")(function* (path: string) {
        const content = yield* fs.readFileStringSafe(path)
        if (content !== undefined) return new InstructionDiscovery.File({ path: AbsolutePath.make(path), content })
        yield* Effect.logDebug("instruction file skipped", { path, reason: "unavailable" })
      })

      const globalSource = Effect.fn("ConfigInstructionPlugin.globalSource")(function* () {
        if (!discovery.global) return []
        const file = yield* read(globalFile)
        return file ? [file] : []
      })

      const projectSource = Effect.fn("ConfigInstructionPlugin.projectSource")(function* () {
        if (!project) return []
        const walked = yield* Effect.forEach(
          yield* fs.up({ targets: ["AGENTS.md"], start, stop: boundary }),
          fs.resolve,
        )
        const discovered = new Set(walked.filter((file) => discovery.global || file !== globalFile))
        const files = yield* Effect.forEach(discovered, read, { concurrency: "unbounded" })
        if (files.some((file) => file === undefined)) return Instructions.unavailable
        return files.filter((file): file is InstructionDiscovery.File => file !== undefined)
      })

      const isolate = <A, E, R>(source: string, effect: Effect.Effect<A, E, R>) =>
        effect.pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("failed to load instruction source", { source, cause }).pipe(
              Effect.as(Instructions.unavailable),
            ),
          ),
        )

      const refresh = Effect.fn("ConfigInstructionPlugin.refresh")(
        function* (file?: string) {
          const sources = yield* Effect.all({
            global: isolate("global", globalSource()),
            project: isolate("project", projectSource()),
          })
          loaded.current =
            Array.isArray(sources.global) && Array.isArray(sources.project)
              ? { type: "available", files: [...sources.global, ...sources.project] }
              : { type: "unavailable" }
          if (!file) return
          yield* Effect.logDebug("instructions rescanned", {
            file,
            instructions:
              loaded.current.type === "available" ? loaded.current.files.map((item) => item.path) : "unavailable",
          })
        },
        (effect, ..._args: [file?: string]) => lock.withPermit(effect),
      )

      // Editor saves arrive as bursts of watcher events; settle before rescanning once. Subscribe
      // before debouncing so no update slips through while the debounce starts its pull.
      const updates = yield* PubSub.subscribe(changes)
      yield* Stream.fromSubscription(updates).pipe(
        Stream.debounce("100 millis"),
        Stream.runForEach((file) => refresh(file).pipe(Effect.andThen(discovery.reload()))),
        Effect.forkScoped({ startImmediately: true }),
      )
      yield* refresh()
      yield* discovery.transform((editor) => {
        if (loaded.current.type === "unavailable") {
          editor.unavailable()
          return
        }
        for (const file of loaded.current.files) editor.add(file)
      })
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("failed to activate instruction source", { cause }).pipe(
          Effect.andThen(discovery.transform((editor) => editor.unavailable())),
          Effect.asVoid,
        ),
      ),
    )
  }),
})

function ancestorDirectories(start: string, stop: string): string[] {
  const result = [start]
  if (relative(start, stop) === "") return result
  const parent = dirname(start)
  if (parent === start) throw new Error(`Instruction boundary ${stop} is not an ancestor of ${start}`)
  return [...result, ...ancestorDirectories(parent, stop)]
}
