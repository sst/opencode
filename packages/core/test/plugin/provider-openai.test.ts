import { Money } from "@opencode/schema/money"
import { Agent } from "@opencode/schema/agent"
import { Session } from "@opencode/schema/session"
import { OpenAIResponses } from "@opencode/ai/protocols/openai-responses"
import { describe, expect } from "bun:test"
import { ConfigProvider, DateTime, Effect } from "effect"
import { Catalog } from "@opencode/core/catalog"
import { Credential } from "@opencode/core/credential"
import { Integration } from "@opencode/core/integration"
import { Location } from "@opencode/core/location"
import { Model } from "@opencode/core/model"
import { Plugin } from "@opencode/core/plugin"
import { PluginHost } from "@opencode/core/plugin/host"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { GithubCopilotPlugin } from "@opencode/core/plugin/provider/github-copilot"
import { OpenAIPlugin } from "@opencode/core/plugin/provider/openai"
import { Project } from "@opencode/core/project"
import { Provider } from "@opencode/core/provider"
import { AbsolutePath } from "@opencode/core/schema"
import { SessionModelRequest } from "@opencode/core/session/model-request"
import { SessionModelTransport } from "@opencode/core/session/model-transport"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const it = testEffect(PluginTestLayer)

const addPlugin = Effect.fn(function* () {
  const plugin = yield* Plugin.Service
  const host = yield* PluginHost.make(plugin)
  yield* OpenAIPlugin.effect(host)
})

const addGithubCopilotPlugin = Effect.fn(function* () {
  const plugin = yield* Plugin.Service
  const host = yield* PluginHost.make(plugin)
  yield* GithubCopilotPlugin.effect(host)
})

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected value")
  return value
}

const request = Effect.fn(function* (providerID: Provider.ID, baseURL: string) {
  const hooks = yield* PluginHooks.Service
  const event = yield* hooks.trigger("session", "model.request", {
    sessionID: Session.ID.make("ses_test"),
    agent: Agent.ID.make("build"),
    model: Model.Ref.make({ providerID, id: Model.ID.make("gpt-5.5") }),
    kind: "primary",
    baseURL,
    headers: {},
  })
  return {
    baseURL: event.baseURL,
    headers: event.headers,
    hasHttpHooks:
      (yield* hooks.has("session", "http.request", providerID)) ||
      (yield* hooks.has("session", "http.response", providerID)),
  }
})

describe("OpenAIPlugin", () => {
  it.effect("registers browser and headless ChatGPT OAuth methods", () =>
    Effect.gen(function* () {
      yield* addPlugin()
      const integrations = yield* Integration.Service
      expect((yield* integrations.get(Integration.ID.make("openai")))?.methods).toEqual([
        {
          id: Integration.MethodID.make("chatgpt-browser"),
          type: "oauth",
          label: "ChatGPT Pro/Plus (browser)",
        },
        {
          id: Integration.MethodID.make("chatgpt-headless"),
          type: "oauth",
          label: "ChatGPT Pro/Plus (headless)",
        },
      ])
    }),
  )

  it.effect("filters the OpenAI catalog to codex-eligible models under a ChatGPT connection", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const credentials = yield* Credential.Service
      yield* catalog.transform((catalog) => {
        catalog.provider.update(Provider.ID.openai, (draft) => {
          draft.package = Provider.aisdk("@ai-sdk/openai")
        })
        catalog.model.update(Provider.ID.openai, Model.ID.make("gpt-5.5"), (model) => {
          model.limit = { context: 1_050_000, input: 922_000, output: 128_000 }
          model.cost = [
            {
              input: Money.USDPerMillionTokens.make(1),
              output: Money.USDPerMillionTokens.make(2),
              cache: {
                read: Money.USDPerMillionTokens.make(0.1),
                write: Money.USDPerMillionTokens.zero,
              },
            },
          ]
        })
        catalog.model.update(Provider.ID.openai, Model.ID.make("gpt-5.5-pro"), () => {})
        catalog.model.update(Provider.ID.openai, Model.ID.make("gpt-5.4"), (model) => {
          model.limit = { context: 1_050_000, input: 922_000, output: 64_000 }
        })
        catalog.model.update(Provider.ID.openai, Model.ID.make("gpt-5.4-pro"), (model) => {
          model.modelID = Model.ID.make("gpt-5.4")
          model.body = { reasoning: { mode: "pro" } }
        })
        catalog.model.update(Provider.ID.openai, Model.ID.make("gpt-5.6"), () => {})
        catalog.model.update(Provider.ID.openai, Model.ID.make("gpt-5.6-sol"), (model) => {
          model.limit = { context: 1_050_000, input: 922_000, output: 128_000 }
        })
        catalog.model.update(Provider.ID.openai, Model.ID.make("gpt-4.1"), () => {})
        catalog.model.update(Provider.ID.openai, Model.ID.make("gpt-6-astra"), (model) => {
          model.limit = { context: 1_050_000, input: 922_000, output: 128_000 }
        })
        catalog.model.update(Provider.ID.openai, Model.ID.make("gpt-5.10"), (model) => {
          model.limit = { context: 1_050_000, input: 922_000, output: 128_000 }
        })
        catalog.model.update(Provider.ID.openai, Model.ID.make("gpt-5"), () => {})
        catalog.model.update(Provider.ID.openai, Model.ID.make("gpt-5.04-astra"), () => {})
        catalog.model.update(Provider.ID.openai, Model.ID.make("gpt-4.99"), () => {})
      })
      yield* credentials.create({
        integrationID: Integration.ID.make("openai"),
        value: Credential.OAuth.make({
          type: "oauth",
          methodID: Integration.MethodID.make("chatgpt-browser"),
          access: "chatgpt-token",
          refresh: "refresh",
          expires: Date.now() + 60_000,
          metadata: { accountID: "acct_123" },
        }),
      })
      yield* addPlugin()

      const direct = yield* request(Provider.ID.openai, "https://api.openai.com/v1")
      const custom = yield* request(Provider.ID.make("custom-openai"), "https://custom.example/v1")
      const proxy = yield* request(Provider.ID.openai, "https://proxy.example/v1?region=us")

      const provider = required(yield* catalog.provider.get(Provider.ID.openai))
      expect(provider.package).toBe(Provider.aisdk("@ai-sdk/openai"))
      expect(provider.settings).toMatchObject({ baseURL: "https://chatgpt.com/backend-api/codex" })
      expect(provider.headers).toMatchObject({
        originator: "opencode",
        "chatgpt-account-id": "acct_123",
        "x-codex-beta-features": "remote_compaction_v2",
      })
      expect(direct.baseURL).toBe("https://chatgpt.com/backend-api/codex")
      expect(direct.headers).toMatchObject({ originator: "opencode", "session-id": "ses_test" })
      expect(direct.hasHttpHooks).toBe(false)
      expect(custom.headers).not.toHaveProperty("originator")
      expect(proxy.baseURL).toBe("https://proxy.example/v1?region=us")
      expect(proxy.headers).toMatchObject({ originator: "opencode", "session-id": "ses_test" })
      const eligible = required(yield* catalog.model.get(Provider.ID.openai, Model.ID.make("gpt-5.5")))
      expect(eligible.package).toBe(Provider.aisdk("@ai-sdk/openai"))
      expect(eligible.headers).toMatchObject({ originator: "opencode", "chatgpt-account-id": "acct_123" })
      expect(eligible.cost).toEqual([])
      expect(eligible.limit).toEqual({ context: 400_000, input: 272_000, output: 128_000 })
      expect(eligible.enabled).toBe(true)
      expect(required(yield* catalog.model.get(Provider.ID.openai, Model.ID.make("gpt-5.5-pro"))).enabled).toBe(false)
      expect(required(yield* catalog.model.get(Provider.ID.openai, Model.ID.make("gpt-5.4-pro"))).enabled).toBe(false)
      expect(required(yield* catalog.model.get(Provider.ID.openai, Model.ID.make("gpt-5.4"))).enabled).toBe(false)
      expect(required(yield* catalog.model.get(Provider.ID.openai, Model.ID.make("gpt-5.6"))).enabled).toBe(false)
      const gpt56 = required(yield* catalog.model.get(Provider.ID.openai, Model.ID.make("gpt-5.6-sol")))
      expect(gpt56.enabled).toBe(true)
      expect(gpt56.limit).toEqual({ context: 400_000, input: 272_000, output: 128_000 })
      expect(required(yield* catalog.model.get(Provider.ID.openai, Model.ID.make("gpt-4.1"))).enabled).toBe(false)
      expect(required(yield* catalog.model.get(Provider.ID.openai, Model.ID.make("gpt-6-astra"))).enabled).toBe(true)
      expect(required(yield* catalog.model.get(Provider.ID.openai, Model.ID.make("gpt-5.10"))).enabled).toBe(true)
      expect(required(yield* catalog.model.get(Provider.ID.openai, Model.ID.make("gpt-5"))).enabled).toBe(false)
      expect(required(yield* catalog.model.get(Provider.ID.openai, Model.ID.make("gpt-5.04-astra"))).enabled).toBe(
        false,
      )
      expect(required(yield* catalog.model.get(Provider.ID.openai, Model.ID.make("gpt-4.99"))).enabled).toBe(false)
    }),
  )

  it.effect("keeps the full OpenAI catalog under an API key connection", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const credentials = yield* Credential.Service
      yield* catalog.transform((catalog) => {
        catalog.provider.update(Provider.ID.openai, (draft) => {
          draft.package = Provider.aisdk("@ai-sdk/openai")
        })
        catalog.model.update(Provider.ID.openai, Model.ID.make("gpt-5.5"), (model) => {
          model.limit = { context: 1_050_000, input: 922_000, output: 128_000 }
        })
        catalog.model.update(Provider.ID.openai, Model.ID.make("gpt-4.1"), () => {})
      })
      yield* credentials.create({
        integrationID: Integration.ID.make("openai"),
        value: Credential.Key.make({ type: "key", key: "sk-test" }),
      })
      yield* addPlugin()

      const direct = yield* request(Provider.ID.openai, "https://api.openai.com/v1")

      const provider = required(yield* catalog.provider.get(Provider.ID.openai))
      const model = required(yield* catalog.model.get(Provider.ID.openai, Model.ID.make("gpt-5.5")))
      expect(model.package).toBe(Provider.aisdk("@ai-sdk/openai"))
      expect(model.enabled).toBe(true)
      expect(model.limit).toEqual({ context: 1_050_000, input: 922_000, output: 128_000 })
      expect(model.capabilities.responsesWebsockets).toBe(true)
      expect(model.websocket).toBe(true)
      expect(direct.headers).not.toHaveProperty("originator")
      expect(direct.baseURL).toBe("https://api.openai.com/v1")
      expect(provider.headers).not.toHaveProperty("x-codex-beta-features")
      expect(direct.hasHttpHooks).toBe(false)
      expect(provider.headers).not.toHaveProperty("originator")
      expect(required(yield* catalog.model.get(Provider.ID.openai, Model.ID.make("gpt-4.1"))).enabled).toBe(true)
    }),
  )

  it.effect("selects WebSocket only from explicit policy", () =>
    Effect.gen(function* () {
      const credentials = yield* Credential.Service
      yield* credentials.create({
        integrationID: Integration.ID.make("openai"),
        value: Credential.Key.make({ type: "key", key: "sk-test" }),
      })
      yield* addPlugin()
      yield* addGithubCopilotPlugin()
      const executor = { execute: () => Effect.die("unused WebSocket execution") }
      const transport = SessionModelTransport.Service.of({
        bind: () => executor,
        close: () => Effect.void,
        closeAll: Effect.void,
      })
      const sessionID = Session.ID.make("ses_websocket_hooks")
      const agentID = Agent.ID.make("build")
      const route = OpenAIResponses.route.with({
        id: "deployment-responses",
        provider: Provider.ID.azure,
      })
      const prepare = (websocket?: boolean) =>
        Effect.gen(function* () {
          const model = SessionRunnerModel.resolved(route.model({ id: "gpt-5.5" }), {
            capabilities: { tools: true, input: ["text"], output: ["text"], responsesWebsockets: true },
            cost: [],
            limit: { context: 200_000, output: 32_000 },
            websocket,
          })
          const requests = yield* SessionModelRequest.Service
          return yield* requests.primary({
            session: Session.Info.make({
              id: sessionID,
              projectID: Project.ID.global,
              cost: Money.USD.zero,
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
              location: Location.Ref.make({ directory: AbsolutePath.make("/project") }),
            }),
            agent: agentID,
            model,
            tools: { definitions: [], execute: () => Effect.die("unused tool execution") },
            system: [],
            messages: [],
            webSocket: "session",
          })
        }).pipe(
          Effect.provide(SessionModelRequest.layer),
          Effect.provideService(SessionModelTransport.Service, transport),
        )

      const prepared = yield* prepare(true)
      const defaulted = yield* prepare()
      const disabled = yield* prepare(false)

      expect(prepared.options.webSocket).toBe(executor)
      expect(prepared.options.http).toBeUndefined()
      expect(defaulted.options.webSocket).toBeUndefined()
      expect(disabled.options.webSocket).toBeUndefined()
    }),
  )
})
