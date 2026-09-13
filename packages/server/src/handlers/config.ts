import { Config } from "@opencode/core/config"
import { ShellSelect } from "@opencode/core/shell/select"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"

export const ConfigHandler = HttpApiBuilder.group(Api, "server.config", (handlers) =>
  handlers
    .handle("config.get", () => Config.Service.use((config) => config.entries()))
    .handle(
      "config.preferences",
      Effect.fn(function* () {
        const config = yield* Config.Service
        if (!config.preferences) return yield* Effect.die(new Error("Config preferences are unavailable"))
        return yield* config.preferences().pipe(Effect.orDie)
      }),
    )
    .handle(
      "config.updatePreferences",
      Effect.fn(function* (ctx) {
        const config = yield* Config.Service
        if (!config.updatePreferences) return yield* Effect.die(new Error("Config preference updates are unavailable"))
        return yield* config.updatePreferences(ctx.payload).pipe(Effect.orDie)
      }),
    )
    .handle(
      "config.shells",
      Effect.fn(function* () {
        const shell = yield* ShellSelect.Service
        if (!shell.list) return yield* Effect.die(new Error("Shell discovery is unavailable"))
        return yield* shell.list()
      }),
    ),
)
