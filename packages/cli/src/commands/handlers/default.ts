import { LayerNode } from "@opencode/util/effect/layer-node"
import { Global } from "@opencode/util/global"
import { run } from "@opencode/tui"
import { Commands } from "../commands"
import { Runtime } from "../../framework/runtime"
import { Config } from "../../config"
import { Context, Effect, Fiber, FileSystem, Option, Queue } from "effect"
import { ServerConnection } from "../../services/server-connection"
import { Updater } from "../../services/updater"
import { UpdatePreflight } from "../../services/update-preflight"
import { Npm } from "@opencode/util/npm"
import { OPENCODE_ARTIFACT, OPENCODE_CHANNEL, OPENCODE_VERSION } from "../../version"
import { Env } from "../../env"

export default Runtime.handler(Commands, (input) =>
  Effect.gen(function* () {
    const requestedDirectory = Option.getOrUndefined(input.directory)
    const requestedServer = Option.getOrUndefined(input.server)
    if (requestedDirectory !== undefined) process.chdir(requestedDirectory)
    const preflight = UpdatePreflight.make()
    yield* Effect.addFinalizer(() => Effect.promise(() => preflight.close()))
    const serviceStarts = yield* Queue.unbounded<{
      readonly reason: "missing" | "version-mismatch"
      readonly previousVersion?: string
    }>()
    yield* Queue.take(serviceStarts).pipe(
      Effect.flatMap((event) => Effect.logInfo("background service starting", event)),
      Effect.forever,
      Effect.forkScoped,
    )
    const server = yield* ServerConnection.resolve({
      server: requestedServer,
      standalone: input.standalone,
      mismatch: "replace",
      onStart: (reason, previousVersion) => {
        Queue.offerUnsafe(serviceStarts, { reason, previousVersion })
        if (reason === "version-mismatch" && preflight.begin(previousVersion)) return
        process.stderr.write(
          reason === "version-mismatch"
            ? "Restarting background server (version mismatch)...\n"
            : "Starting background server...\n",
        )
      },
    }).pipe(
      Effect.tapError(() =>
        Effect.promise(() => preflight.fail("OpenCode update could not start the new background service")),
      ),
    )
    const updater = yield* Updater.Service
    const update = yield* updater.run().pipe(Effect.forkScoped)
    preflight.loading()
    const config = yield* Config.Service
    const npm = yield* Npm.Service
    const fileSystem = yield* FileSystem.FileSystem
    const runServicePromise = Effect.runPromiseWith(Context.make(FileSystem.FileSystem, fileSystem))
    const context = yield* Effect.context<FileSystem.FileSystem>()
    const runFork = Effect.runForkWith(context)
    const runPromise = Effect.runPromiseWith(context)
    const service = server.service
    yield* run({
      app: {
        name: process.env.OPENCODE_CLIENT ?? OPENCODE_ARTIFACT,
        version: OPENCODE_VERSION,
        channel: process.env.OPENCODE_TUI_CHANNEL ?? OPENCODE_CHANNEL,
      },
      server: {
        endpoint: server.endpoint,
        service: service
          ? {
              reconnect: (signal) => runServicePromise(service.reconnect(), { signal }),
              restart: () => runServicePromise(service.restart()),
            }
          : undefined,
      },
      args: {
        continue: input.continue,
        sessionID: Option.getOrUndefined(input.session),
        prompt: Option.getOrUndefined(input.prompt),
        model: Option.getOrUndefined(input.model),
        auto: input.auto || input.yolo || input.dangerouslySkipPermissions,
      },
      config: {
        path: config.path,
        get: () => runPromise(config.get()),
        update: (update) => runPromise(config.update(update)),
      },
      updater: {
        remote: requestedServer !== undefined,
        subscribe: (notify, signal) =>
          runPromise(
            Fiber.join(update).pipe(
              Effect.flatMap((result) => (result === undefined ? Effect.void : Effect.sync(() => notify(result)))),
            ),
            { signal },
          ),
        check: (signal) => runPromise(Fiber.join(update).pipe(Effect.flatMap(() => updater.check())), { signal }),
        apply: (version) => runPromise(updater.apply(version)),
      },
      packages: {
        prepare: (spec, install = true) => runPromise(install ? npm.add(spec) : npm.resolve(spec)),
      },
      environment: requestedServer === undefined ? Env.session() : undefined,
      terminalHandoff: () => preflight.finish(),
      log: (level, message, tags) => {
        const effect =
          level === "debug"
            ? Effect.logDebug(message, tags)
            : level === "warn"
              ? Effect.logWarning(message, tags)
              : level === "error"
                ? Effect.logError(message, tags)
                : Effect.logInfo(message, tags)
        runFork(effect)
      },
    }).pipe(Effect.provide(LayerNode.compile(Global.node)))
  }),
)
