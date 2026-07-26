import { Config } from "@/config/config"
import { Provider } from "@/provider/provider"
import { RuntimeFlags } from "@/effect/runtime-flags"
import * as InstanceState from "@/effect/instance-state"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { markInstanceForDisposal } from "../lifecycle"

export const configHandlers = HttpApiBuilder.group(InstanceHttpApi, "config", (handlers) =>
  Effect.gen(function* () {
    const providerSvc = yield* Provider.Service
    const configSvc = yield* Config.Service
    const flags = yield* RuntimeFlags.Service

    const get = Effect.fn("ConfigHttpApi.get")(function* () {
      const info = yield* configSvc.get()
      // Surface the subagent-interrupt runtime flag in the TUI-visible config.
      // The HTTP endpoint (and TUI UX) is off-by-default and gated by env var.
      return {
        ...info,
        experimental: {
          ...info.experimental,
          subagent_interrupt: flags.experimentalSubagentInterrupt,
        },
      }
    })

    const update = Effect.fn("ConfigHttpApi.update")(function* (ctx) {
      yield* configSvc.update(ctx.payload)
      yield* markInstanceForDisposal(yield* InstanceState.context)
      return ctx.payload
    })

    const providers = Effect.fn("ConfigHttpApi.providers")(function* () {
      const providers = yield* providerSvc.list()
      return {
        providers: Object.values(providers).map(Provider.toPublicInfo),
        default: Provider.defaultModelIDs(providers),
      }
    })

    return handlers.handle("get", get).handle("update", update).handle("providers", providers)
  }),
)
