#!/usr/bin/env bun

import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Effect } from "effect"
import { Commands } from "./commands/commands"
import { Runtime } from "./framework/runtime"
import { Observability } from "@opencode/util/observability"
import { Updater } from "./services/updater"
import { OPENCODE_ARTIFACT, OPENCODE_CHANNEL, OPENCODE_LOCAL, OPENCODE_VERSION } from "./version"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Global } from "@opencode/util/global"
import { AppProcess } from "@opencode/util/process"
import { Config } from "./config"
import { Npm } from "@opencode/util/npm"
import { Heap } from "./heap"
import { CpuProfile } from "./cpu-profile"

if (process.env.OPENCODE_SSH_ASKPASS_PORT) {
  const { askpass } = await import("./ssh-askpass")
  process.exit(await Effect.runPromise(askpass.pipe(Effect.provide(NodeServices.layer))))
}

const Handlers = Runtime.handlers(Commands, {
  $: () => import("./commands/handlers/default"),
  upgrade: () => import("./commands/handlers/upgrade"),
  uninstall: () => import("./commands/handlers/uninstall"),
  acp: () => import("./commands/handlers/acp"),
  api: () => import("./commands/handlers/api"),
  auth: {
    list: () => import("./commands/handlers/auth/list"),
    login: () => import("./commands/handlers/auth/login"),
    logout: () => import("./commands/handlers/auth/logout"),
    switch: () => import("./commands/handlers/auth/switch"),
  },
  debug: {
    agents: () => import("./commands/handlers/debug/agents"),
    config: () => import("./commands/handlers/debug/config"),
    paths: () => import("./commands/handlers/debug/paths"),
  },
  mcp: {
    list: () => import("./commands/handlers/mcp/list"),
    add: () => import("./commands/handlers/mcp/add"),
    auth: () => import("./commands/handlers/mcp/auth"),
    logout: () => import("./commands/handlers/mcp/logout"),
  },
  plugin: {
    list: () => import("./commands/handlers/plugin/list"),
    add: () => import("./commands/handlers/plugin/add"),
    check: () => import("./commands/handlers/plugin/check"),
    update: () => import("./commands/handlers/plugin/update"),
    remove: () => import("./commands/handlers/plugin/remove"),
  },
  models: () => import("./commands/handlers/models"),
  stats: () => import("./commands/handlers/stats"),
  mini: () => import("./commands/handlers/mini"),
  run: () => import("./commands/handlers/run"),
  pair: () => import("./commands/handlers/pair"),
  session: {
    list: () => import("./commands/handlers/session/list"),
    delete: () => import("./commands/handlers/session/delete"),
    export: () => import("./commands/handlers/session/export"),
    import: () => import("./commands/handlers/session/import"),
  },
  service: {
    start: () => import("./commands/handlers/service/start"),
    restart: () => import("./commands/handlers/service/restart"),
    status: () => import("./commands/handlers/service/status"),
    stop: () => import("./commands/handlers/service/stop"),
    get: () => import("./commands/handlers/service/get"),
    set: () => import("./commands/handlers/service/set"),
    unset: () => import("./commands/handlers/service/unset"),
  },
  serve: () => import("./commands/handlers/serve"),
})

Effect.gen(function* () {
  yield* Heap.listen
  yield* CpuProfile.listen
  const runFork = Effect.runForkWith(yield* Effect.context<never>())
  const uncaughtException = (cause: Error, origin: "uncaughtException" | "unhandledRejection") => {
    runFork(Effect.logError("uncaught exception", { cause, origin }))
  }
  const unhandledRejection = (cause: unknown) => {
    runFork(Effect.logError("unhandled rejection", { cause }))
  }
  process.on("uncaughtException", uncaughtException)
  process.on("unhandledRejection", unhandledRejection)
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      process.off("uncaughtException", uncaughtException)
      process.off("unhandledRejection", unhandledRejection)
    }),
  )
  yield* Effect.logInfo("cli starting", {
    version: OPENCODE_VERSION,
    channel: OPENCODE_CHANNEL,
    local: OPENCODE_LOCAL,
    args: process.argv.slice(2),
  })
  return yield* Runtime.run(Commands, Handlers, { version: OPENCODE_VERSION })
}).pipe(
  Effect.catchCause((cause) =>
    Effect.logError("cli process failed", {
      cause,
      args: process.argv.slice(2),
    }).pipe(Effect.andThen(Effect.failCause(cause))),
  ),
  Effect.annotateLogs({ role: "cli" }),
  Effect.provide(Config.layer),
  Effect.provide(Updater.layer),
  Effect.provide(
    LayerNode.compile(LayerNode.group([Global.node, AppProcess.node, Npm.node]), {
      replacements: [
        Global.node.replace(
          Global.layerWith(process.env.OPENCODE_CONFIG_DIR ? { config: process.env.OPENCODE_CONFIG_DIR } : {}),
        ),
      ],
    }),
  ),
  Effect.provide(
    Observability.layer({
      endpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
      headers: process.env.OTEL_EXPORTER_OTLP_HEADERS,
      client: process.env.OPENCODE_CLIENT ?? OPENCODE_ARTIFACT,
      version: OPENCODE_VERSION,
      channel: OPENCODE_CHANNEL,
    }),
  ),
  Effect.provide(NodeServices.layer),
  Effect.scoped,
  Effect.tap(() => Effect.sync(() => process.exit(process.exitCode ?? 0))),
  NodeRuntime.runMain,
)
