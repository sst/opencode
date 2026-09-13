import { expect } from "bun:test"
import { NodeServices, NodeSocketServer } from "@effect/platform-node"
import { Deferred, Effect, Fiber, FileSystem, Layer, Path, Stream } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { testEffect } from "../../../../core/test/lib/effect"
import { createSshController } from "./controller"
import { quote } from "./command"

const it = testEffect(Layer.merge(NodeServices.layer, FetchHttpClient.layer))
// The askpass ProxyCommand fixture is a POSIX shell executable.
const posix = process.platform === "win32" ? it.live.skip : it.live

it.live(
  "resolution validates a live tunnel and rediscovers changed remote credentials and ports",
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const file = path.join(yield* fs.makeTempDirectoryScoped({ prefix: "ssh-resolve-test-" }), "registration.json")
    const state = { password: "first", tunnels: 0 }
    const remote = () =>
      Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: (request) =>
          new Response(null, {
            status:
              request.headers.get("authorization") ===
              `Basic ${Buffer.from(`opencode:${state.password}`).toString("base64")}`
                ? 200
                : 401,
          }),
      })
    const first = remote()
    yield* Effect.addFinalizer(() => Effect.sync(() => first.stop(true)))
    yield* fs.writeFileString(
      file,
      JSON.stringify({ url: first.url.href.replace(/\/$/, ""), password: state.password, version: "2.0.0", pid: 1 }),
    )
    const config = { id: "fixture", target: "fixture", name: "Fixture" }
    const controller = yield* createSshController({
      configs: [config],
      binary: process.execPath,
      version: "2.0.0",
      save: () => Effect.void,
    }).pipe(
      Effect.provideService(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make((command) => {
          if (command._tag !== "StandardCommand") return spawner.spawn(command)
          if (command.args.includes("-L")) state.tunnels++
          return spawner.spawn(
            ChildProcess.make(
              process.execPath,
              [path.join(import.meta.dirname, "../../../test/ssh/transport.ts"), file, ...command.args],
              command.options,
            ),
          )
        }),
      ),
    )
    yield* controller.start(config, 1)
    const initial = yield* controller.resolve(config.id)
    expect((yield* controller.state()).servers[0]).toMatchObject({ stage: "ready" })
    expect(initial?.password).toBe("first")
    expect(yield* controller.resolve(config.id)).toEqual(initial)
    expect(state.tunnels).toBe(1)

    state.password = "second"
    yield* fs.writeFileString(
      file,
      JSON.stringify({ url: first.url.href.replace(/\/$/, ""), password: state.password, version: "2.0.0", pid: 2 }),
    )
    const refreshed = yield* Effect.all([controller.resolve(config.id), controller.resolve(config.id)], {
      concurrency: "unbounded",
    })
    expect(refreshed[0]?.password).toBe("second")
    expect(refreshed[0]).toEqual(refreshed[1])
    expect(refreshed[0]?.url).not.toBe(initial?.url)
    expect(state.tunnels).toBe(2)

    const second = remote()
    yield* Effect.addFinalizer(() => Effect.sync(() => second.stop(true)))
    yield* fs.writeFileString(
      file,
      JSON.stringify({ url: second.url.href.replace(/\/$/, ""), password: state.password, version: "2.0.0", pid: 3 }),
    )
    yield* Effect.promise(() => first.stop(true))
    const moved = yield* controller.resolve(config.id)
    expect(moved?.url).not.toBe(refreshed[0]?.url)
    expect(state.tunnels).toBe(3)
    expect((yield* controller.state()).servers[0]?.stage).toBe("ready")
    expect(yield* controller.resolve(config.id)).toEqual(moved)
    expect(state.tunnels).toBe(3)
  }).pipe(Effect.timeout("20 seconds")),
)

posix(
  "cancelling an authentication attempt restores the previous state and permits another attempt",
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const configFile = path.join(yield* fs.makeTempDirectoryScoped({ prefix: "ssh-cancel-test-" }), "config")
    yield* fs.writeFileString(configFile, "")
    const proxy = path.join(path.dirname(configFile), "proxy")
    yield* fs.writeFileString(proxy, '#!/bin/sh\n"$SSH_ASKPASS" "Password:" >/dev/null\nexec sleep 30\n', {
      mode: 0o755,
    })
    const config = {
      id: "fixture",
      name: "Fixture",
      target: `ssh -F ${quote(configFile)} -o ${quote(`ProxyCommand=${quote(proxy)}`)} fixture`,
    }
    const controller = yield* createSshController({
      configs: [config],
      binary: process.execPath,
      command: [process.execPath, "run", path.resolve("../cli/src/index.ts")],
      version: "2.0.0",
      save: () => Effect.die("must not save"),
    })
    yield* controller.start({ ...config, background: true })
    expect(yield* controller.resolve(config.id)).toBeNull()
    expect((yield* controller.state()).servers[0]?.stage).toBe("authentication")
    for (const owner of [1, 2]) {
      const prompted = yield* controller.changes(owner).pipe(
        Stream.filter((state) => !!state.servers[0]?.prompt),
        Stream.runHead,
        Effect.forkScoped({ startImmediately: true }),
      )
      yield* controller.start(config, owner)
      yield* Fiber.join(prompted)
      const prompt = (yield* controller.state(owner)).servers[0]?.prompt
      expect((yield* controller.state(owner + 10)).servers[0]?.authenticatingElsewhere).toBe(true)
      yield* controller.start(config, owner + 10)
      expect((yield* controller.state(owner)).servers[0]?.prompt).toEqual(prompt)
      expect((yield* controller.state(owner + 10)).servers[0]?.prompt).toBeUndefined()
      yield* controller.cancel(config.id, owner + 10)
      expect((yield* controller.state(owner)).servers[0]?.prompt).toBeDefined()
      yield* controller.cancel(config.id, owner)
      const item = (yield* controller.state(owner)).servers[0]
      expect(item?.stage).toBe("authentication")
      expect(item?.prompt).toBeUndefined()
      expect(item?.error).toBeUndefined()
      expect(item?.config).toEqual(config)
      expect((yield* controller.state(owner + 10)).servers[0]?.authenticatingElsewhere).toBe(false)
      expect(yield* controller.resolve(config.id)).toBeNull()
    }
  }).pipe(Effect.timeout("20 seconds")),
)

it.live(
  "saved hosts do not connect until requested and forgetting never starts SSH",
  Effect.gen(function* () {
    const saves: unknown[] = []
    const config = { id: "fixture", target: "unreachable.invalid", name: "Fixture" }
    const controller = yield* createSshController({
      configs: [config],
      binary: "unused",
      version: "2.0.0",
      save: (configs) =>
        Effect.sync(() => {
          saves.push(configs)
        }),
    })
    expect(yield* controller.resolve(config.id)).toBeNull()
    yield* controller.disconnect(config.id)
    expect((yield* controller.state()).servers[0]?.stage).toBe("disconnected")
    yield* controller.forget(config.id)
    expect((yield* controller.state()).servers).toEqual([])
    expect(saves).toEqual([[]])
  }),
)

it.live(
  "invalid commands fail without persisting an incomplete connection",
  Effect.gen(function* () {
    const controller = yield* createSshController({
      configs: [],
      binary: "unused",
      version: "2.0.0",
      save: () => Effect.die("must not save"),
    })
    const settled = yield* controller.changes().pipe(
      Stream.filter((state) => state.servers[0]?.stage === "failed"),
      Stream.runHead,
      Effect.forkScoped({ startImmediately: true }),
    )
    yield* controller.start({ id: "fixture", target: "ssh host whoami", name: "" }, 1)
    yield* Fiber.join(settled)
    const state = yield* controller.state()
    expect(state.servers[0]?.error).toBe("input")
    expect(state.servers[0]?.saved).toBe(false)
  }),
)

it.live(
  "a failed edit does not replace the saved connection",
  Effect.gen(function* () {
    const config = { id: "fixture", target: "devbox", name: "Original" }
    const saves: unknown[] = []
    const controller = yield* createSshController({
      configs: [config],
      binary: "unused",
      version: "2.0.0",
      save: (configs) =>
        Effect.sync(() => {
          saves.push(configs)
        }),
    })
    const settled = yield* controller.changes().pipe(
      Stream.filter((state) => state.servers[0]?.stage === "failed"),
      Stream.runHead,
      Effect.forkScoped({ startImmediately: true }),
    )
    yield* controller.start({ ...config, target: "ssh devbox whoami", name: "Invalid edit" }, 1)
    yield* Fiber.join(settled)
    expect((yield* controller.state()).servers[0]?.config).toEqual(config)
    yield* controller.forget("missing")
    expect(saves).toEqual([[config]])
  }),
)

it.live(
  "disconnect interrupts a live SSH handshake and releases endpoint waiters",
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const config = path.join(yield* fs.makeTempDirectoryScoped({ prefix: "ssh-handshake-test-" }), "config")
    yield* fs.writeFileString(config, "")
    const connected = yield* Deferred.make<void>()
    const closed = yield* Deferred.make<void>()
    const server = yield* NodeSocketServer.make({ host: "127.0.0.1", port: 0 })
    if (server.address._tag !== "TcpAddress") return yield* Effect.die("missing port")
    yield* server
      .run((socket) =>
        socket
          .run(() => Effect.void, { onOpen: Deferred.succeed(connected, undefined).pipe(Effect.asVoid) })
          .pipe(Effect.ensuring(Deferred.succeed(closed, undefined)), Effect.ignore),
      )
      .pipe(Effect.forkScoped({ startImmediately: true }))
    const controller = yield* createSshController({
      configs: [],
      binary: "unused",
      version: "2.0.0",
      save: () => Effect.die("must not save"),
    })
    yield* controller.start(
      { id: "fixture", target: `ssh -F ${quote(config)} -p ${server.address.port} 127.0.0.1`, name: "" },
      1,
    )
    yield* Deferred.await(connected)
    const waiting = yield* controller.resolve("fixture").pipe(Effect.forkScoped)
    yield* controller.disconnect("fixture")
    yield* Deferred.await(closed)
    expect(yield* Fiber.join(waiting)).toBeNull()
    expect((yield* controller.state()).servers[0]?.stage).toBe("disconnected")
    return undefined
  }).pipe(Effect.timeout("10 seconds")),
)
