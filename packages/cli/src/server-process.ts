export * as ServerProcess from "./server-process"

import { NodeServices } from "@effect/platform-node"
import { Service, type DiscoverOptions } from "@opencode/client/effect/service"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Global } from "@opencode/util/global"
import { OPENCODE_ARTIFACT, OPENCODE_CHANNEL, OPENCODE_VERSION } from "./version"
import { AppProcess } from "@opencode/util/process"
import { randomBytes, randomUUID } from "node:crypto"
import { Effect, Option, Redacted, Schedule, Schema } from "effect"
import { PersistentPty } from "@opencode/schema/persistent-pty"
import { HttpServer } from "effect/unstable/http"
import { Env } from "./env"
import { ServiceConfig } from "./services/service-config"
import { ServiceRegistration } from "./services/service-registration"
import { Updater } from "./services/updater"
import { WebUi } from "./services/web-ui"
import { databasePath } from "./database-path"

export type Mode = "default" | "service" | "stdio"

export type Options = {
  readonly mode: Mode
  readonly hostname?: string
  readonly port?: number
  readonly cors?: readonly string[]
}

// The process effect lives until server shutdown; tracing it would parent every request to one process-lifetime trace.
export const run = Effect.fnUntraced(function* (options: Options) {
  return yield* processEffect(options).pipe(
    Effect.provide(
      LayerNode.compile(LayerNode.group([Global.node, AppProcess.node]), {
        replacements: [
          Global.node.replace(
            Global.layerWith(process.env.OPENCODE_CONFIG_DIR ? { config: process.env.OPENCODE_CONFIG_DIR } : {}),
          ),
        ],
      }),
    ),
    Effect.provide(NodeServices.layer),
  )
})

const processEffect = Effect.fnUntraced(function* (options: Options) {
  const inherited = process.env.OPENCODE_PTY_HANDOFF
  delete process.env.OPENCODE_PTY_HANDOFF
  const handoff =
    inherited === undefined
      ? undefined
      : yield* Schema.decodeUnknownEffect(Schema.fromJsonString(PersistentPty.Handoff))(inherited).pipe(
          Effect.mapError(() => new Error("Invalid PTY restart handoff")),
        )
  const global = yield* Global.Service
  if (options.mode === "service") yield* Effect.sync(() => process.chdir(global.home))
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const foreground = options.mode === "default"
      const serviceOptions = options.mode === "service" ? yield* ServiceConfig.options() : undefined
      const config = options.mode === "service" ? yield* ServiceConfig.read() : {}
      const hostname = options.hostname ?? config.hostname ?? "127.0.0.1"
      const port = options.port ?? config.port ?? (options.mode === "service" ? ServiceConfig.defaultPort() : undefined)
      const incumbent =
        serviceOptions !== undefined && port !== undefined
          ? yield* Service.incumbent({ ...serviceOptions, url: serviceURL(hostname, port) })
          : undefined
      if (incumbent !== undefined) return
      const { start } = yield* Effect.promise(() => import("@opencode/server/process"))
      const environmentPassword = yield* Env.password
      // Keep the lease credential out of the environment inherited by tools.
      if (options.mode === "stdio") {
        delete process.env.OPENCODE_PASSWORD
        delete process.env.OPENCODE_SERVER_PASSWORD
      }
      const password =
        options.mode === "service"
          ? config.password || randomBytes(32).toString("base64url")
          : environmentPassword
            ? Redacted.value(environmentPassword)
            : randomBytes(32).toString("base64url")
      if (!password) return yield* Effect.fail(new Error("Missing server password"))
      const instanceID = randomUUID()
      const transform = yield* WebUi.handler()
      const server = yield* start(
        {
          app: {
            name: process.env.OPENCODE_CLIENT ?? OPENCODE_ARTIFACT,
            version: OPENCODE_VERSION,
            channel: OPENCODE_CHANNEL,
          },
          hostname,
          port,
          cors: options.cors ?? config.cors,
          password,
          pty: { handoff },
          simulation: truthy(process.env.OPENCODE_SIMULATE),
          database: {
            path: databasePath(global.data),
          },
          models: {
            url: process.env.OPENCODE_MODELS_URL,
            file: process.env.OPENCODE_MODELS_PATH,
            fetch: !truthy(process.env.OPENCODE_DISABLE_MODELS_FETCH),
          },
          config: {
            directory: process.env.OPENCODE_CONFIG_DIR,
            project: !truthy(
              process.env.OPENCODE_CONFIG_PROJECT_DISABLE ?? process.env.OPENCODE_DISABLE_PROJECT_CONFIG,
            ),
            file: process.env.OPENCODE_CONFIG,
            content: process.env.OPENCODE_CONFIG_CONTENT,
          },
          windows: {
            gitbash: process.env.OPENCODE_GIT_BASH_PATH,
          },
          fs: {
            filewatcher: !truthy(process.env.OPENCODE_FILEWATCHER_DISABLE ?? process.env.OPENCODE_DISABLE_FILEWATCHER),
            fff:
              process.env.OPENCODE_DISABLE_FFF === undefined
                ? process.platform !== "win32"
                : !truthy(process.env.OPENCODE_DISABLE_FFF),
          },
        },
        serviceOptions === undefined
          ? undefined
          : {
              onListen: (address, shutdown) =>
                Effect.gen(function* () {
                  if (!config.password) yield* ServiceConfig.password(password)
                  return yield* ServiceRegistration.register({
                    address,
                    password,
                    id: instanceID,
                    file: serviceOptions.file,
                    shutdown,
                  })
                }),
            },
        transform,
      ).pipe(
        Effect.catch((error) => {
          if (serviceOptions === undefined || port === undefined || !addressInUse(error)) return Effect.fail(error)
          return recognizeIncumbent(serviceOptions, hostname, port).pipe(
            Effect.flatMap((found) =>
              found
                ? Effect.void
                : Effect.fail(
                    new Error(
                      `Managed service port ${port} on ${hostname} is already in use by another process. ` +
                        "Configure another port with `opencode service set port <port>` and start the service again.",
                      { cause: error },
                    ),
                  ),
            ),
          )
        }),
      )
      if (server === undefined) return
      const url = HttpServer.formatAddress(server.address)
      console.log(options.mode === "stdio" ? JSON.stringify({ url }) : `server listening on ${url}`)
      if (foreground && !environmentPassword) console.log(`server password ${password}`)
      yield* Updater.Service.pipe(
        Effect.flatMap((updater) =>
          Updater.pollUpdates({
            check: updater.run().pipe(
              Effect.flatMap((result) => {
                if (!result) return Effect.void
                if (result.type === "available") return server.updateAvailable(result.version)
                return server.updated(result.version)
              }),
            ),
          }),
        ),
        Effect.provide(Updater.layer),
        Effect.forkScoped,
      )
      return yield* options.mode === "service"
        ? server.shutdown
        : options.mode === "stdio"
          ? waitForStdinClose()
          : Effect.never
    }).pipe(Effect.annotateLogs({ role: "server" })),
  )
})

const recognizeIncumbent = Effect.fnUntraced(function* (options: DiscoverOptions, hostname: string, port: number) {
  const found = yield* Service.incumbent({ ...options, url: serviceURL(hostname, port) }).pipe(
    Effect.filterOrFail((value) => value !== undefined),
    Effect.retry(Schedule.spaced("100 millis")),
    Effect.timeoutOption("15 seconds"),
  )
  return Option.isSome(found)
})

function serviceURL(hostname: string, port: number) {
  return `http://${hostname.includes(":") ? `[${hostname}]` : hostname}:${port}`
}

function truthy(value?: string) {
  return value === "1" || value?.toLowerCase() === "true"
}

function addressInUse(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false
  if ("code" in error && error.code === "EADDRINUSE") return true
  return "cause" in error && addressInUse(error.cause)
}

function waitForStdinClose() {
  return Effect.callback<void>((resume) => {
    const close = () => resume(Effect.void)
    process.stdin.once("end", close)
    process.stdin.once("close", close)
    process.stdin.resume()
    if (process.stdin.readableEnded || process.stdin.destroyed) close()
    return Effect.sync(() => {
      process.stdin.off("end", close)
      process.stdin.off("close", close)
      process.stdin.pause()
    })
  })
}
