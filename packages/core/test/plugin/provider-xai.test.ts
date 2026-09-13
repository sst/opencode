import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { Catalog } from "@opencode/core/catalog"
import { Credential } from "@opencode/core/credential"
import { Integration } from "@opencode/core/integration"
import { Plugin } from "@opencode/core/plugin"
import { PluginHost } from "@opencode/core/plugin/host"
import { XAIPlugin } from "@opencode/core/plugin/provider/xai"
import { Model } from "@opencode/core/model"
import { Provider } from "@opencode/core/provider"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const it = testEffect(PluginTestLayer)

const addPlugin = Effect.fn(function* () {
  const plugin = yield* Plugin.Service
  const host = yield* PluginHost.make(plugin)
  yield* XAIPlugin.effect(host)
})

describe("XAIPlugin", () => {
  it.effect("registers device OAuth and API key methods", () =>
    Effect.gen(function* () {
      yield* addPlugin()
      const integrations = yield* Integration.Service
      const integration = yield* integrations.get(Integration.ID.make("xai"))
      expect(integration?.name).toBe("xAI")
      expect(integration?.methods).toEqual([
        {
          id: Integration.MethodID.make("device"),
          type: "oauth",
          label: "SuperGrok Subscription",
        },
        { type: "key", label: "Manually enter API Key" },
      ])
    }),
  )

  it.effect("migrates browser OAuth credentials to the device method", () =>
    Effect.gen(function* () {
      const credentials = yield* Credential.Service
      const original = yield* credentials.create({
        integrationID: Integration.ID.make("xai"),
        label: "personal",
        value: Credential.OAuth.make({
          type: "oauth",
          methodID: Integration.MethodID.make("browser"),
          access: "access",
          refresh: "refresh",
          expires: 123,
          metadata: { account: "account" },
        }),
      })

      yield* addPlugin()

      expect(yield* credentials.get(original.id)).toEqual({
        ...original,
        value: Credential.OAuth.make({
          type: "oauth",
          methodID: Integration.MethodID.make("device"),
          access: "access",
          refresh: "refresh",
          expires: 123,
          metadata: { account: "account" },
        }),
      })
    }),
  )

  it.effect("enables xAI Responses WebSockets", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const providerID = Provider.ID.make("xai")
      yield* catalog.transform((editor) => {
        editor.provider.update(providerID, (provider) => {
          provider.package = Provider.aisdk("@ai-sdk/xai")
        })
        editor.model.update(providerID, Model.ID.make("grok-4.6"), () => {})
      })

      yield* addPlugin()

      const model = yield* catalog.model.get(providerID, Model.ID.make("grok-4.6"))
      expect(model?.capabilities.responsesWebsockets).toBe(true)
      expect(model?.websocket).toBe(true)
    }),
  )
})
