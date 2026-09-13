import { NodeSocketServer } from "@effect/platform-node"
import {
  Cause,
  Clock,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Path,
  PubSub,
  Ref,
  Schedule,
  Scope,
  Stream,
} from "effect"
import { HttpClient } from "effect/unstable/http"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import type { SshConfig, SshHttp, SshItem, SshStart, SshState } from "@opencode/app/ssh"
import { createAskpass } from "./askpass"
import { bootstrap } from "./bootstrap"
import { parseTarget, quote, runSsh, sshArgs, sshExecutable, tunnelArgs, SshFailure } from "./command"

type Connection = {
  owner?: number
  before?: SshItem
  ready: Deferred.Deferred<SshHttp | null>
  respond?: (id: string, value: string) => Effect.Effect<void>
}
type Attempt = Connection & { fiber: Fiber.Fiber<void> }

export const createSshController = Effect.fn("Ssh.controller")(function* (input: {
  version: string
  development?: boolean
  binary: string
  command?: readonly string[]
  configs: readonly SshConfig[]
  save: (configs: readonly SshConfig[]) => Effect.Effect<void, SshFailure>
}) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const httpClient = yield* HttpClient.HttpClient
  const parent = yield* Scope.Scope
  const lifetime = yield* Scope.fork(parent)
  const changed = yield* PubSub.unbounded<void>()
  yield* Scope.addFinalizer(lifetime, PubSub.shutdown(changed))

  const items = new Map<string, SshItem>(
    input.configs.map((config) => [config.id, { config, saved: true, stage: "disconnected", detail: "" }]),
  )
  const configs = new Map(input.configs.map((config) => [config.id, config]))
  const attempts = new Map<string, Attempt>()
  const paused = new Set(items.keys())
  const failures = new Map<string, number>()
  const lifecycle = { closed: false }
  const emit = PubSub.publish(changed, undefined).pipe(Effect.asVoid)
  const state = (owner?: number): Effect.Effect<SshState> =>
    Effect.sync(() => ({
      servers: [...items.values()].map((item) => ({
        ...item,
        prompt: attempts.get(item.config.id)?.owner === owner ? item.prompt : undefined,
        authenticatingElsewhere:
          item.stage === "authentication" &&
          attempts.get(item.config.id)?.owner !== undefined &&
          attempts.get(item.config.id)?.owner !== owner,
      })),
    }))
  const update = Effect.fnUntraced(function* (id: string, value: Partial<SshItem>) {
    const item = items.get(id)
    if (!item) return
    items.set(id, { ...item, ...value })
    yield* emit
  })
  const run = (options: Parameters<typeof runSsh>[0]) =>
    runSsh(options).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner))

  const connect = Effect.fn("Ssh.connect")(function* (config: SshConfig, connection: Connection, replace = false) {
    const target = yield* Effect.try({ try: () => parseTarget(config.target), catch: SshFailure.from })
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "oc-ssh-" })
    const control = path.join(directory, "s")
    const helper =
      input.command && input.command.length > 1 && process.platform !== "win32"
        ? path.join(directory, "askpass")
        : input.binary
    if (helper !== input.binary)
      yield* fs.writeFileString(helper, `#!/bin/sh\nexec ${input.command?.map(quote).join(" ")} "$@"\n`, {
        mode: 0o700,
      })
    if (process.platform !== "win32") {
      target.args.unshift("-o", "ControlMaster=auto", "-o", "ControlPersist=60", "-o", `ControlPath=${control}`)
      // Close only our local SSH master. The remote OpenCode service owns its
      // own lifetime and must survive disconnect, failure, and app shutdown.
      yield* Effect.addFinalizer(() =>
        run({ args: ["-o", `ControlPath=${control}`, "-O", "exit", target.host], timeout: 2000 }).pipe(Effect.ignore),
      )
    }

    const authentication = yield* Deferred.make<void>()
    const askpass = yield* createAskpass({
      binary: helper,
      prompt: Effect.fnUntraced(function* (prompt) {
        if (connection.owner === undefined) {
          paused.add(config.id)
          yield* update(config.id, { stage: "authentication" })
          yield* Deferred.succeed(authentication, undefined)
          return
        }
        yield* update(config.id, { stage: "authentication", prompt })
      }),
      clear: (id) =>
        items.get(config.id)?.prompt?.id === id
          ? update(config.id, { prompt: undefined, stage: "connecting" })
          : Effect.void,
    })
    connection.respond = askpass.respond

    yield* Effect.gen(function* () {
      const resolved = yield* run({ args: [...sshArgs(target), "-G", target.host], timeout: 10_000 }).pipe(
        Effect.orElseSucceed(() => ""),
      )
      const fields = new Map(
        resolved.split(/\r?\n/).map((line) => {
          const separator = line.indexOf(" ")
          return [line.slice(0, separator), line.slice(separator + 1)] as const
        }),
      )
      if (fields.has("hostname"))
        yield* update(config.id, {
          destination: `${fields.get("user") ?? ""}@${fields.get("hostname")}:${fields.get("port") ?? "22"}`,
        })
      const remote = yield* bootstrap({
        target,
        version: input.version,
        development: input.development,
        env: askpass.env,
        replace,
        stage: (stage) => update(config.id, { stage, prompt: undefined }),
      }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(HttpClient.HttpClient, httpClient),
      )
      const port = yield* freePort
      const http = { url: `http://127.0.0.1:${port}`, password: remote.password }
      const tunnel = yield* spawner.spawn(
        ChildProcess.make(sshExecutable(), tunnelArgs(target, port, remote), {
          env: askpass.env,
          extendEnv: true,
          windowsHide: true,
          stdin: "pipe",
          stdout: "ignore",
          killSignal: "SIGTERM",
          forceKillAfter: "2 seconds",
        }),
      )
      const detail = yield* Ref.make("")
      const stderr = yield* tunnel.stderr.pipe(
        Stream.decodeText(),
        Stream.runForEach((text) => Ref.update(detail, (tail) => (tail + text).slice(-8192))),
        Effect.forkScoped,
      )
      const closed = Effect.gen(function* () {
        const exitCode = yield* tunnel.exitCode
        yield* Fiber.join(stderr)
        return yield* Effect.fail(
          new SshFailure("connection", (yield* Ref.get(detail)) || JSON.stringify({ exitCode })),
        )
      })
      yield* waitReady(http, () => items.get(config.id)?.stage === "authentication").pipe(
        Effect.provideService(HttpClient.HttpClient, httpClient),
        Effect.catch(() =>
          Ref.get(detail).pipe(Effect.flatMap((detail) => Effect.fail(new SshFailure("service", detail)))),
        ),
        Effect.raceFirst(closed),
      )
      const saved = new Map(configs).set(config.id, config)
      yield* input.save([...saved.values()])
      configs.set(config.id, config)
      failures.delete(config.id)
      yield* update(config.id, { http, stage: "ready", saved: true, detail: "", prompt: undefined, error: undefined })
      yield* Deferred.succeed(connection.ready, http)
      yield* closed
    }).pipe(
      Effect.raceFirst(askpass.closed),
      Effect.raceFirst(Deferred.await(authentication).pipe(Effect.andThen(Effect.interrupt))),
    )
  }, Effect.scoped)

  const start = Effect.fn("Ssh.start")(function* (request: SshStart, owner?: number) {
    const id = request.id
    if (lifecycle.closed || !/^[a-zA-Z0-9-]{1,80}$/.test(id)) return
    const previous = attempts.get(id)
    // A second window must not replace an interactive attempt while its owner
    // is connecting or answering a challenge.
    if (previous?.owner !== undefined && previous.owner !== owner && items.get(id)?.stage !== "ready") return
    const config = { id, target: request.target.trim(), name: request.name.trim() }
    const connection: Connection = {
      owner,
      before: items.get(id),
      ready: yield* Deferred.make<SshHttp | null>(),
    }
    const admitted = yield* Deferred.make<void>()
    const fiber = yield* Effect.gen(function* () {
      yield* Deferred.await(admitted)
      if (previous) yield* Fiber.interrupt(previous.fiber)
      yield* connect(config, connection, request.replace)
    }).pipe(
      Effect.catchCause(
        Effect.fnUntraced(function* (cause) {
          if (Cause.hasInterruptsOnly(cause) || paused.has(id) || attempts.get(id)?.ready !== connection.ready) return
          const failure = SshFailure.from(Cause.squash(cause))
          failures.set(id, (failures.get(id) ?? 0) + 1)
          const code = /REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed/.test(failure.message)
            ? "host-key"
            : /spawn .*ENOENT/.test(failure.message)
              ? "ssh-missing"
              : failure.code
          if (
            ["version", "input", "unpublished", "platform", "host-key", "ssh-missing"].includes(code) ||
            /Permission denied/.test(failure.message) ||
            (failures.get(id) ?? 0) >= 5
          )
            paused.add(id)
          yield* update(id, {
            stage: code === "version" ? "incompatible" : "failed",
            error: code,
            detail: failure.message,
            prompt: undefined,
            ...(configs.has(id) ? { config: configs.get(id) } : {}),
          })
        }),
      ),
      Effect.ensuring(
        Effect.gen(function* () {
          yield* Deferred.succeed(connection.ready, null)
          if (attempts.get(id)?.ready !== connection.ready) return
          attempts.delete(id)
          yield* update(id, { prompt: undefined })
        }),
      ),
      Effect.forkIn(lifetime, { uninterruptible: false }),
    )
    attempts.set(id, Object.assign(connection, { fiber }))
    items.set(id, {
      config,
      saved: items.get(id)?.saved ?? false,
      http: items.get(id)?.http,
      stage: "connecting",
      detail: "",
    })
    paused.delete(id)
    if (!request.background) failures.delete(id)
    yield* emit
    yield* Deferred.succeed(admitted, undefined)
  }, Effect.uninterruptible)

  const disconnect = Effect.fn("Ssh.disconnect")(function* (id: string) {
    paused.add(id)
    const attempt = attempts.get(id)
    yield* update(id, {
      stage: "disconnected",
      prompt: undefined,
      ...(configs.has(id) ? { config: configs.get(id) } : {}),
    })
    if (attempt) yield* Fiber.interrupt(attempt.fiber)
  })
  const cancel = Effect.fn("Ssh.cancel")(function* (id: string, owner: number) {
    const attempt = attempts.get(id)
    if (!attempt || attempt.owner !== owner) return
    paused.add(id)
    // Restore before interrupting: askpass cleanup must not transition the
    // cancelled attempt back to connecting or expose an expired prompt.
    const before = attempt.before
    yield* update(id, {
      ...before,
      stage:
        before?.stage === "authentication" || before?.stage === "failed" || before?.stage === "incompatible"
          ? before.stage
          : "disconnected",
      prompt: undefined,
      error: before?.error,
      detail: before?.detail ?? "",
    })
    yield* Fiber.interrupt(attempt.fiber)
  })
  const close = Effect.gen(function* () {
    if (lifecycle.closed) return
    lifecycle.closed = true
    yield* Effect.forEach([...attempts.keys()], disconnect, { concurrency: "unbounded", discard: true })
    yield* Scope.close(lifetime, Exit.void)
  })
  yield* Effect.addFinalizer(() => close)

  return {
    state,
    changes: (owner?: number) => Stream.fromPubSub(changed).pipe(Stream.mapEffect(() => state(owner))),
    start,
    resolve: Effect.fn("Ssh.resolve")(function* (id: string) {
      const item = items.get(id)
      if (lifecycle.closed || !item || paused.has(id)) return null
      if (item.stage === "ready" && item.http) {
        const healthy = yield* checkHealth(item.http).pipe(Effect.provideService(HttpClient.HttpClient, httpClient))
        if (lifecycle.closed || paused.has(id)) return null
        // Another window may already have replaced this tunnel during the probe.
        if (items.get(id) === item) {
          if (healthy) return item.http
          yield* start({ ...item.config, background: true })
        }
      }
      if (!attempts.has(id) && items.has(id)) yield* start({ ...item.config, background: true })
      const attempt = attempts.get(id)
      return attempt ? yield* Deferred.await(attempt.ready) : null
    }),
    respond: Effect.fn("Ssh.respond")(function* (id: string, prompt: string, value: string, owner: number) {
      const attempt = attempts.get(id)
      if (attempt?.owner === owner && attempt.respond) yield* attempt.respond(prompt, value)
    }),
    disconnect,
    cancel,
    forget: Effect.fn("Ssh.forget")(function* (id: string) {
      yield* disconnect(id)
      items.delete(id)
      configs.delete(id)
      yield* input.save([...configs.values()])
      yield* emit
    }),
    detach: Effect.fn("Ssh.detach")(function* (owner: number) {
      yield* Effect.forEach(
        [...attempts].filter(([id, attempt]) => attempt.owner === owner && items.get(id)?.stage !== "ready"),
        ([id]) => cancel(id, owner),
        { concurrency: "unbounded", discard: true },
      )
    }),
    close,
  }
})

const freePort = Effect.gen(function* () {
  const server = yield* NodeSocketServer.make({ host: "127.0.0.1", port: 0 })
  if (server.address._tag !== "TcpAddress") return yield* Effect.fail(new SshFailure("connection"))
  return server.address.port
}).pipe(Effect.scoped)

const waitReady = Effect.fn("Ssh.waitReady")(function* (http: SshHttp, authenticating: () => boolean) {
  const clock = { deadline: (yield* Clock.currentTimeMillis) + 30_000 }
  yield* Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis
    if (authenticating()) clock.deadline = now + 30_000
    if (now >= clock.deadline) return yield* Effect.fail(new SshFailure("service"))
    return yield* checkHealth(http)
  }).pipe(Effect.repeat({ until: (ready) => ready, schedule: Schedule.spaced(100) }))
})

const checkHealth = Effect.fn("Ssh.checkHealth")(function* (http: SshHttp) {
  const client = yield* HttpClient.HttpClient
  return yield* client
    .get(`${http.url}/api/health`, {
      headers: { authorization: `Basic ${Buffer.from(`opencode:${http.password}`).toString("base64")}` },
    })
    .pipe(
      Effect.timeout(2000),
      Effect.map((response) => response.status >= 200 && response.status < 300),
      Effect.orElseSucceed(() => false),
    )
})
