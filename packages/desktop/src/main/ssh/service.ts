export * as Ssh from "./service"

import { Context, Effect, Fiber, FileSystem, Layer, Path, Schema, Scope, Stream } from "effect"
import { NodeChildProcessSpawner } from "@effect/platform-node"
import { FetchHttpClient } from "effect/unstable/http"
import { app, shell, type WebContents } from "electron"
import { homedir } from "node:os"
import { SshConfig, type SshState } from "@opencode/app/ssh"
import { SshChanged } from "../../shared/ipc-rpc/events"
import { DesktopCli } from "../service/desktop-cli"
import { Shutdown } from "../lifecycle/shutdown"
import { getStore } from "../storage/store"
import { emitIpcEvent } from "../ipc-events"
import { createSshController } from "./controller"
import { sshHosts, SshFailure } from "./command"

export class Service extends Context.Service<Service, Effect.Success<ReturnType<typeof make>>>()(
  "opencode/desktop/Ssh",
) {}

const make = Effect.fn("Ssh.make")(function* (cli: DesktopCli.Resolved) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const scope = yield* Scope.Scope
  const runFork = Effect.runForkWith(yield* Effect.context())
  const stored = Schema.decodeUnknownOption(Schema.Array(SshConfig))(getStore().get("ssh.servers"))
  const controller = yield* createSshController({
    version: cli.version,
    development: !app.isPackaged && cli.binary === undefined,
    binary: cli.binary ?? cli.command[0] ?? "opencode",
    command: cli.command,
    configs: stored._tag === "Some" ? stored.value : [],
    save: (configs) => Effect.try({ try: () => getStore().set("ssh.servers", configs), catch: SshFailure.from }),
  })
  const subscriptions = new Map<number, { fiber: Fiber.Fiber<void>; remove: () => void }>()
  const unsubscribeWindow = Effect.fn("Ssh.unsubscribeWindow")(function* (id: number) {
    const entry = subscriptions.get(id)
    if (!entry) return
    subscriptions.delete(id)
    entry.remove()
    yield* Fiber.interrupt(entry.fiber)
    yield* controller.detach(id)
  })
  yield* Effect.addFinalizer(() => Effect.forEach([...subscriptions.keys()], unsubscribeWindow, { discard: true }))
  return {
    ...controller,
    subscribeWindow: Effect.fn("Ssh.subscribeWindow")(function* (sender: WebContents) {
      if (subscriptions.has(sender.id)) return
      const emit = (state: SshState) =>
        Effect.sync(() => {
          if (!sender.isDestroyed()) emitIpcEvent(sender, new SshChanged({ state }))
        })
      const fiber = yield* controller
        .changes(sender.id)
        .pipe(Stream.runForEach(emit), Effect.forkIn(scope, { startImmediately: true }))
      // Electron is the imperative boundary; the callback only schedules a
      // scoped Effect, while controller operations remain Effect-native.
      const detach = () => {
        runFork(unsubscribeWindow(sender.id)).pipe(Fiber.runIn(scope))
      }
      sender.once("destroyed", detach)
      subscriptions.set(sender.id, { fiber, remove: () => sender.removeListener("destroyed", detach) })
      yield* controller.state(sender.id).pipe(Effect.flatMap(emit))
    }),
    unsubscribeWindow,
    hosts: sshHosts,
    openConfig: Effect.fn("Ssh.openConfig")(function* () {
      const file = path.join(homedir(), ".ssh", "config")
      yield* fs.makeDirectory(path.dirname(file), { recursive: true, mode: 0o700 })
      yield* fs
        .writeFileString(file, "", { flag: "wx", mode: 0o600 })
        .pipe(Effect.catch((error) => (error.reason._tag === "AlreadyExists" ? Effect.void : Effect.fail(error))))
      yield* Effect.tryPromise(() => shell.openPath(file))
    }),
  }
})

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const cli = yield* DesktopCli.Service
    const resolved = yield* cli.resolve
    const service = yield* make(resolved)
    const shutdown = yield* Shutdown.Service
    const close = service.close
    const off = yield* shutdown.add(close)
    yield* Effect.addFinalizer(() => Effect.sync(off).pipe(Effect.andThen(close)))
    return service
  }),
).pipe(Layer.provide(NodeChildProcessSpawner.layer), Layer.provide(FetchHttpClient.layer))
