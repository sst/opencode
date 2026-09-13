import { AISDK } from "@opencode-ai/core/aisdk"
import { describe, expect } from "bun:test"
import type { LanguageModelV3 } from "@ai-sdk/provider"
import { Effect } from "effect"
import { Catalog } from "@opencode-ai/core/catalog"
import { ModelV2 } from "@opencode-ai/core/model"
import { PluginV2 } from "@opencode-ai/core/plugin"
import { PluginHost } from "@opencode-ai/core/plugin/host"
import { AmazonBedrockPlugin } from "@opencode-ai/core/plugin/provider/amazon-bedrock"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const it = testEffect(PluginTestLayer)

const addPlugin = Effect.fn(function* () {
  const plugin = yield* PluginV2.Service
  const aisdk = yield* AISDK.Service
  const host = yield* PluginHost.make(plugin)
  yield* AmazonBedrockPlugin.effect(host)
})

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected value")
  return value
}

function withEnv<A, E, R>(vars: Record<string, string | undefined>, fx: () => Effect.Effect<A, E, R>) {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]))
      Object.entries(vars).forEach(([key, value]) => {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      })
      return previous
    }),
    fx,
    (previous) =>
      Effect.sync(() => {
        Object.entries(previous).forEach(([key, value]) => {
          if (value === undefined) delete process.env[key]
          else process.env[key] = value
        })
      }),
  )
}

function fakeSelectorSdk(calls: string[]) {
  const make = (method: string) => (id: string) => {
    calls.push(`${method}:${id}`)
    return { modelId: id, provider: method, specificationVersion: "v3" } as unknown as LanguageModelV3
  }
  return {
    responses: make("responses"),
    messages: make("messages"),
    chat: make("chat"),
    languageModel: make("languageModel"),
  }
}

function bedrockBaseURL(sdk: unknown, modelID = "anthropic.claude-sonnet-4-5") {
  const language = (sdk as { languageModel: (id: string) => unknown }).languageModel(modelID)
  return (language as { config: { baseUrl: () => string } }).config.baseUrl()
}

function bedrockFetch(sdk: unknown, modelID = "anthropic.claude-sonnet-4-5") {
  const language = (sdk as { languageModel: (id: string) => unknown }).languageModel(modelID)
  return (
    language as { config: { fetch: (input: Parameters<typeof fetch>[0], init?: RequestInit) => Promise<Response> } }
  ).config.fetch
}

function openAIUrl(language: unknown, path: string, modelId: string) {
  return (language as { config: { url: (input: { path: string; modelId: string }) => string } }).config.url({
    path,
    modelId,
  })
}

describe("AmazonBedrockPlugin", () => {
  it.effect("moves endpoint option to api URL", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      yield* catalog.transform((catalog) => {
        const bedrock = ProviderV2.Info.make({
          ...ProviderV2.Info.empty(ProviderV2.ID.amazonBedrock),
          api: { type: "aisdk", package: "@ai-sdk/amazon-bedrock" },
          request: {
            headers: {},
            body: { endpoint: "https://bedrock.example" },
          },
        })
        catalog.provider.update(bedrock.id, (item) => {
          item.api = bedrock.api
          item.request = bedrock.request
        })
      })
      yield* addPlugin()
      const result = required(yield* catalog.provider.get(ProviderV2.ID.amazonBedrock))
      expect(result.api).toEqual({
        type: "aisdk",
        package: "@ai-sdk/amazon-bedrock",
        url: "https://bedrock.example",
      })
      expect(result.request.body.endpoint).toBeUndefined()
    }),
  )

  it.effect("prefers endpoint over baseURL for SDK base URL", () =>
    withEnv({ AWS_BEARER_TOKEN_BEDROCK: undefined, AWS_PROFILE: undefined, AWS_ACCESS_KEY_ID: undefined }, () =>
      Effect.gen(function* () {
        const plugin = yield* PluginV2.Service
        const aisdk = yield* AISDK.Service
        yield* addPlugin()
        const result = yield* aisdk.runSDK({
          model: ModelV2.Info.make({
            ...ModelV2.Info.empty(ProviderV2.ID.amazonBedrock, ModelV2.ID.make("anthropic.claude-sonnet-4-5")),
            api: { id: ModelV2.ID.make("anthropic.claude-sonnet-4-5"), type: "aisdk", package: "test-provider" },
          }),
          package: "@ai-sdk/amazon-bedrock",
          options: {
            name: "amazon-bedrock",
            bearerToken: "token",
            baseURL: "https://base.example",
            endpoint: "https://endpoint.example",
            region: "us-east-1",
          },
        })
        expect(bedrockBaseURL(result.sdk)).toBe("https://endpoint.example")
      }),
    ),
  )

  it.effect("uses baseURL as SDK base URL", () =>
    withEnv({ AWS_BEARER_TOKEN_BEDROCK: undefined, AWS_PROFILE: undefined, AWS_ACCESS_KEY_ID: undefined }, () =>
      Effect.gen(function* () {
        const plugin = yield* PluginV2.Service
        const aisdk = yield* AISDK.Service
        yield* addPlugin()
        const result = yield* aisdk.runSDK({
          model: ModelV2.Info.make({
            ...ModelV2.Info.empty(ProviderV2.ID.amazonBedrock, ModelV2.ID.make("anthropic.claude-sonnet-4-5")),
            api: { id: ModelV2.ID.make("anthropic.claude-sonnet-4-5"), type: "aisdk", package: "test-provider" },
          }),
          package: "@ai-sdk/amazon-bedrock",
          options: {
            name: "amazon-bedrock",
            bearerToken: "token",
            baseURL: "https://base.example",
            region: "us-east-1",
          },
        })
        expect(bedrockBaseURL(result.sdk)).toBe("https://base.example")
      }),
    ),
  )

  it.effect("creates SDK without explicit credential env so the default AWS chain can resolve credentials", () =>
    withEnv(
      {
        AWS_ACCESS_KEY_ID: undefined,
        AWS_BEARER_TOKEN_BEDROCK: undefined,
        AWS_CONTAINER_CREDENTIALS_FULL_URI: undefined,
        AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: undefined,
        AWS_PROFILE: undefined,
        AWS_REGION: undefined,
        AWS_WEB_IDENTITY_TOKEN_FILE: undefined,
      },
      () =>
        Effect.gen(function* () {
          const plugin = yield* PluginV2.Service
          const aisdk = yield* AISDK.Service
          yield* addPlugin()
          const result = yield* aisdk.runSDK({
            model: ModelV2.Info.make({
              ...ModelV2.Info.empty(ProviderV2.ID.amazonBedrock, ModelV2.ID.make("anthropic.claude-sonnet-4-5")),
              api: {
                id: ModelV2.ID.make("anthropic.claude-sonnet-4-5"),
                type: "aisdk",
                package: "test-provider",
              },
            }),
            package: "@ai-sdk/amazon-bedrock",
            options: { name: "amazon-bedrock" },
          })
          expect(result.sdk).toBeDefined()
          expect(bedrockBaseURL(result.sdk)).toBe("https://bedrock-runtime.us-east-1.amazonaws.com")
        }),
    ),
  )

  it.effect("uses config region over AWS_REGION for SDK base URL", () =>
    withEnv({ AWS_BEARER_TOKEN_BEDROCK: "token", AWS_REGION: "us-east-1" }, () =>
      Effect.gen(function* () {
        const plugin = yield* PluginV2.Service
        const aisdk = yield* AISDK.Service
        yield* addPlugin()
        const result = yield* aisdk.runSDK({
          model: ModelV2.Info.make({
            ...ModelV2.Info.empty(ProviderV2.ID.amazonBedrock, ModelV2.ID.make("anthropic.claude-sonnet-4-5")),
            api: { id: ModelV2.ID.make("anthropic.claude-sonnet-4-5"), type: "aisdk", package: "test-provider" },
          }),
          package: "@ai-sdk/amazon-bedrock",
          options: { name: "amazon-bedrock", region: "eu-west-1" },
        })
        expect(bedrockBaseURL(result.sdk)).toBe("https://bedrock-runtime.eu-west-1.amazonaws.com")
      }),
    ),
  )

  it.effect("uses AWS_REGION for SDK base URL when config region is absent", () =>
    withEnv({ AWS_BEARER_TOKEN_BEDROCK: "token", AWS_REGION: "eu-west-1" }, () =>
      Effect.gen(function* () {
        const plugin = yield* PluginV2.Service
        const aisdk = yield* AISDK.Service
        yield* addPlugin()
        const result = yield* aisdk.runSDK({
          model: ModelV2.Info.make({
            ...ModelV2.Info.empty(ProviderV2.ID.amazonBedrock, ModelV2.ID.make("anthropic.claude-sonnet-4-5")),
            api: { id: ModelV2.ID.make("anthropic.claude-sonnet-4-5"), type: "aisdk", package: "test-provider" },
          }),
          package: "@ai-sdk/amazon-bedrock",
          options: { name: "amazon-bedrock" },
        })
        expect(bedrockBaseURL(result.sdk)).toBe("https://bedrock-runtime.eu-west-1.amazonaws.com")
      }),
    ),
  )

  it.effect("defaults SDK region to us-east-1", () =>
    withEnv({ AWS_BEARER_TOKEN_BEDROCK: "token", AWS_REGION: undefined }, () =>
      Effect.gen(function* () {
        const plugin = yield* PluginV2.Service
        const aisdk = yield* AISDK.Service
        yield* addPlugin()
        const result = yield* aisdk.runSDK({
          model: ModelV2.Info.make({
            ...ModelV2.Info.empty(ProviderV2.ID.amazonBedrock, ModelV2.ID.make("anthropic.claude-sonnet-4-5")),
            api: { id: ModelV2.ID.make("anthropic.claude-sonnet-4-5"), type: "aisdk", package: "test-provider" },
          }),
          package: "@ai-sdk/amazon-bedrock",
          options: { name: "amazon-bedrock" },
        })
        expect(bedrockBaseURL(result.sdk)).toBe("https://bedrock-runtime.us-east-1.amazonaws.com")
      }),
    ),
  )

  it.effect("loads bearer token option into env and uses bearer auth", () =>
    withEnv({ AWS_ACCESS_KEY_ID: undefined, AWS_BEARER_TOKEN_BEDROCK: undefined, AWS_PROFILE: undefined }, () =>
      Effect.gen(function* () {
        const plugin = yield* PluginV2.Service
        const aisdk = yield* AISDK.Service
        const headers: Array<string | null> = []
        yield* addPlugin()
        const result = yield* aisdk.runSDK({
          model: ModelV2.Info.make({
            ...ModelV2.Info.empty(ProviderV2.ID.amazonBedrock, ModelV2.ID.make("anthropic.claude-sonnet-4-5")),
            api: { id: ModelV2.ID.make("anthropic.claude-sonnet-4-5"), type: "aisdk", package: "test-provider" },
          }),
          package: "@ai-sdk/amazon-bedrock",
          options: {
            name: "amazon-bedrock",
            bearerToken: "option-token",
            fetch: async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
              headers.push(new Headers(init?.headers).get("Authorization"))
              return new Response("{}")
            },
          },
        })
        yield* Effect.promise(() => bedrockFetch(result.sdk)("https://bedrock.example", { method: "POST" }))
        expect(process.env.AWS_BEARER_TOKEN_BEDROCK).toBe("option-token")
        expect(headers).toEqual(["Bearer option-token"])
      }),
    ),
  )

  it.effect("prefers bearer token env over bearer token option", () =>
    withEnv({ AWS_BEARER_TOKEN_BEDROCK: "env-token" }, () =>
      Effect.gen(function* () {
        const plugin = yield* PluginV2.Service
        const aisdk = yield* AISDK.Service
        const headers: Array<string | null> = []
        yield* addPlugin()
        const result = yield* aisdk.runSDK({
          model: ModelV2.Info.make({
            ...ModelV2.Info.empty(ProviderV2.ID.amazonBedrock, ModelV2.ID.make("anthropic.claude-sonnet-4-5")),
            api: { id: ModelV2.ID.make("anthropic.claude-sonnet-4-5"), type: "aisdk", package: "test-provider" },
          }),
          package: "@ai-sdk/amazon-bedrock",
          options: {
            name: "amazon-bedrock",
            bearerToken: "option-token",
            fetch: async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
              headers.push(new Headers(init?.headers).get("Authorization"))
              return new Response("{}")
            },
          },
        })
        yield* Effect.promise(() => bedrockFetch(result.sdk)("https://bedrock.example", { method: "POST" }))
        expect(process.env.AWS_BEARER_TOKEN_BEDROCK).toBe("env-token")
        expect(headers).toEqual(["Bearer env-token"])
      }),
    ),
  )

  it.effect("creates Mantle SDK with GPT-5 OpenAI base path", () =>
    withEnv({ AWS_BEARER_TOKEN_BEDROCK: undefined, AWS_PROFILE: undefined, AWS_ACCESS_KEY_ID: undefined }, () =>
      Effect.gen(function* () {
        const plugin = yield* PluginV2.Service
        const aisdk = yield* AISDK.Service
        yield* addPlugin()
        const result = yield* aisdk.runSDK({
          model: ModelV2.Info.make({
            ...ModelV2.Info.empty(ProviderV2.ID.amazonBedrock, ModelV2.ID.make("openai.gpt-5.5")),
            api: {
              id: ModelV2.ID.make("openai.gpt-5.5"),
              type: "aisdk",
              package: "@ai-sdk/amazon-bedrock/mantle",
            },
          }),
          package: "@ai-sdk/amazon-bedrock/mantle",
          options: {
            name: "amazon-bedrock",
            bearerToken: "token",
            baseURL: "https://bedrock-mantle.us-east-2.api.aws/openai/v1",
            region: "us-east-2",
          },
        })
        const language = result.sdk.responses("openai.gpt-5.5")
        expect(openAIUrl(language, "/responses", "openai.gpt-5.5")).toBe(
          "https://bedrock-mantle.us-east-2.api.aws/openai/v1/responses",
        )
      }),
    ),
  )

  it.effect("selects Mantle APIs without Bedrock cross-region prefixes", () =>
    Effect.gen(function* () {
      const plugin = yield* PluginV2.Service
      const aisdk = yield* AISDK.Service
      const calls: string[] = []
      yield* addPlugin()
      yield* aisdk.runLanguage({
        model: ModelV2.Info.make({
          ...ModelV2.Info.empty(ProviderV2.ID.amazonBedrock, ModelV2.ID.make("openai.gpt-5.5")),
          api: {
            id: ModelV2.ID.make("openai.gpt-5.5"),
            type: "aisdk",
            package: "@ai-sdk/amazon-bedrock/mantle",
          },
        }),
        sdk: fakeSelectorSdk(calls),
        options: { baseURL: "https://bedrock-mantle.us-east-2.api.aws/openai/v1", region: "us-east-2" },
      })
      yield* aisdk.runLanguage({
        model: ModelV2.Info.make({
          ...ModelV2.Info.empty(ProviderV2.ID.amazonBedrock, ModelV2.ID.make("openai.gpt-oss-safeguard-120b")),
          api: {
            id: ModelV2.ID.make("openai.gpt-oss-safeguard-120b"),
            type: "aisdk",
            package: "@ai-sdk/amazon-bedrock/mantle",
          },
        }),
        sdk: fakeSelectorSdk(calls),
        options: { region: "us-east-1" },
      })
      expect(calls).toEqual(["responses:openai.gpt-5.5", "chat:openai.gpt-oss-safeguard-120b"])
    }),
  )

  it.effect("ignores other Bedrock provider subpaths", () =>
    Effect.gen(function* () {
      const plugin = yield* PluginV2.Service
      const aisdk = yield* AISDK.Service
      yield* addPlugin()
      const result = yield* aisdk.runSDK({
        model: ModelV2.Info.make({
          ...ModelV2.Info.empty(ProviderV2.ID.amazonBedrock, ModelV2.ID.make("anthropic.claude-sonnet-4-5")),
          api: {
            id: ModelV2.ID.make("anthropic.claude-sonnet-4-5"),
            type: "aisdk",
            package: "@ai-sdk/amazon-bedrock/anthropic",
          },
        }),
        package: "@ai-sdk/amazon-bedrock/anthropic",
        options: { name: "amazon-bedrock" },
      })
      expect(result.sdk).toBeUndefined()
    }),
  )

  it.effect("uses SigV4 credential env when bearer token is absent", () =>
    withEnv(
      {
        AWS_ACCESS_KEY_ID: "test-access-key",
        AWS_BEARER_TOKEN_BEDROCK: undefined,
        AWS_REGION: "us-east-1",
        AWS_SECRET_ACCESS_KEY: "test-secret-key",
        AWS_SESSION_TOKEN: "test-session-token",
      },
      () =>
        Effect.gen(function* () {
          const plugin = yield* PluginV2.Service
          const aisdk = yield* AISDK.Service
          const headers: Array<string | null> = []
          yield* addPlugin()
          const result = yield* aisdk.runSDK({
            model: ModelV2.Info.make({
              ...ModelV2.Info.empty(ProviderV2.ID.amazonBedrock, ModelV2.ID.make("anthropic.claude-sonnet-4-5")),
              api: {
                id: ModelV2.ID.make("anthropic.claude-sonnet-4-5"),
                type: "aisdk",
                package: "test-provider",
              },
            }),
            package: "@ai-sdk/amazon-bedrock",
            options: {
              name: "amazon-bedrock",
              fetch: async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
                headers.push(new Headers(init?.headers).get("Authorization"))
                return new Response("{}")
              },
            },
          })
          yield* Effect.promise(() =>
            bedrockFetch(result.sdk)("https://bedrock-runtime.us-east-1.amazonaws.com/model/test/invoke", {
              body: "{}",
              method: "POST",
            }),
          )
          expect(headers[0]?.startsWith("AWS4-HMAC-SHA256 ")).toBe(true)
        }),
    ),
  )

  it.effect("applies legacy cross-region inference prefixes", () =>
    Effect.gen(function* () {
      const plugin = yield* PluginV2.Service
      const aisdk = yield* AISDK.Service
      const calls: string[] = []
      yield* addPlugin()
      yield* aisdk.runLanguage({
        model: ModelV2.Info.make({
          ...ModelV2.Info.empty(ProviderV2.ID.amazonBedrock, ModelV2.ID.make("anthropic.claude-sonnet-4-5")),
          api: { id: ModelV2.ID.make("anthropic.claude-sonnet-4-5"), type: "aisdk", package: "test-provider" },
        }),
        sdk: { languageModel: fakeSelectorSdk(calls).languageModel },
        options: {},
      })
      yield* aisdk.runLanguage({
        model: ModelV2.Info.make({
          ...ModelV2.Info.empty(ProviderV2.ID.amazonBedrock, ModelV2.ID.make("anthropic.claude-sonnet-4-5")),
          api: { id: ModelV2.ID.make("anthropic.claude-sonnet-4-5"), type: "aisdk", package: "test-provider" },
        }),
        sdk: { languageModel: fakeSelectorSdk(calls).languageModel },
        options: { region: "eu-west-1" },
      })
      yield* aisdk.runLanguage({
        model: ModelV2.Info.make({
          ...ModelV2.Info.empty(ProviderV2.ID.amazonBedrock, ModelV2.ID.make("global.anthropic.claude-sonnet-4-5")),
          api: {
            id: ModelV2.ID.make("global.anthropic.claude-sonnet-4-5"),
            type: "aisdk",
            package: "test-provider",
          },
        }),
        sdk: { languageModel: fakeSelectorSdk(calls).languageModel },
        options: { region: "eu-west-1" },
      })
      yield* aisdk.runLanguage({
        model: ModelV2.Info.make({
          ...ModelV2.Info.empty(ProviderV2.ID.amazonBedrock, ModelV2.ID.make("anthropic.claude-sonnet-4-5")),
          api: { id: ModelV2.ID.make("anthropic.claude-sonnet-4-5"), type: "aisdk", package: "test-provider" },
        }),
        sdk: { languageModel: fakeSelectorSdk(calls).languageModel },
        options: { region: "ap-northeast-1" },
      })
      yield* aisdk.runLanguage({
        model: ModelV2.Info.make({
          ...ModelV2.Info.empty(ProviderV2.ID.amazonBedrock, ModelV2.ID.make("anthropic.claude-sonnet-4-5")),
          api: { id: ModelV2.ID.make("anthropic.claude-sonnet-4-5"), type: "aisdk", package: "test-provider" },
        }),
        sdk: { languageModel: fakeSelectorSdk(calls).languageModel },
        options: { region: "ap-southeast-2" },
      })
      expect(calls).toEqual([
        "languageModel:us.anthropic.claude-sonnet-4-5",
        "languageModel:eu.anthropic.claude-sonnet-4-5",
        "languageModel:global.anthropic.claude-sonnet-4-5",
        "languageModel:jp.anthropic.claude-sonnet-4-5",
        "languageModel:au.anthropic.claude-sonnet-4-5",
      ])
    }),
  )

  it.effect("uses AWS_REGION for language prefixes when region option is absent", () =>
    withEnv({ AWS_REGION: "eu-west-1" }, () =>
      Effect.gen(function* () {
        const plugin = yield* PluginV2.Service
        const aisdk = yield* AISDK.Service
        const calls: string[] = []
        yield* addPlugin()
        yield* aisdk.runLanguage({
          model: ModelV2.Info.make({
            ...ModelV2.Info.empty(ProviderV2.ID.amazonBedrock, ModelV2.ID.make("anthropic.claude-sonnet-4-5")),
            api: { id: ModelV2.ID.make("anthropic.claude-sonnet-4-5"), type: "aisdk", package: "test-provider" },
          }),
          sdk: { languageModel: fakeSelectorSdk(calls).languageModel },
          options: {},
        })
        expect(calls).toEqual(["languageModel:eu.anthropic.claude-sonnet-4-5"])
      }),
    ),
  )

  it.effect("applies the full legacy cross-region prefix matrix", () =>
    Effect.gen(function* () {
      const plugin = yield* PluginV2.Service
      const aisdk = yield* AISDK.Service
      const calls: string[] = []
      const cases = [
        { region: "us-east-1", modelID: "amazon.nova-micro-v1:0", expected: "us.amazon.nova-micro-v1:0" },
        { region: "us-east-1", modelID: "amazon.nova-lite-v1:0", expected: "us.amazon.nova-lite-v1:0" },
        { region: "us-east-1", modelID: "amazon.nova-pro-v1:0", expected: "us.amazon.nova-pro-v1:0" },
        { region: "us-east-1", modelID: "amazon.nova-premier-v1:0", expected: "us.amazon.nova-premier-v1:0" },
        { region: "us-east-1", modelID: "amazon.nova-2-lite-v1:0", expected: "us.amazon.nova-2-lite-v1:0" },
        { region: "us-east-1", modelID: "anthropic.claude-sonnet-4-5", expected: "us.anthropic.claude-sonnet-4-5" },
        { region: "us-east-1", modelID: "deepseek.r1-v1:0", expected: "us.deepseek.r1-v1:0" },
        { region: "us-east-1", modelID: "us.deepseek.r1-v1:0", expected: "us.deepseek.r1-v1:0" },
        { region: "us-east-1", modelID: "deepseek.v3.2", expected: "deepseek.v3.2" },
        {
          region: "us-east-1",
          modelID: "arn:aws:bedrock:us-east-1::foundation-model/deepseek.v3.2",
          expected: "arn:aws:bedrock:us-east-1::foundation-model/deepseek.v3.2",
        },
        { region: "us-gov-west-1", modelID: "anthropic.claude-sonnet-4-5", expected: "anthropic.claude-sonnet-4-5" },
        { region: "us-east-1", modelID: "cohere.command-r-plus-v1:0", expected: "cohere.command-r-plus-v1:0" },
        { region: "eu-west-1", modelID: "anthropic.claude-sonnet-4-5", expected: "eu.anthropic.claude-sonnet-4-5" },
        { region: "eu-west-2", modelID: "amazon.nova-lite-v1:0", expected: "eu.amazon.nova-lite-v1:0" },
        { region: "eu-west-3", modelID: "amazon.nova-micro-v1:0", expected: "eu.amazon.nova-micro-v1:0" },
        {
          region: "eu-north-1",
          modelID: "meta.llama3-70b-instruct-v1:0",
          expected: "eu.meta.llama3-70b-instruct-v1:0",
        },
        { region: "eu-central-1", modelID: "mistral.pixtral-large-v1:0", expected: "eu.mistral.pixtral-large-v1:0" },
        { region: "eu-south-1", modelID: "anthropic.claude-sonnet-4-5", expected: "eu.anthropic.claude-sonnet-4-5" },
        { region: "eu-south-2", modelID: "anthropic.claude-sonnet-4-5", expected: "eu.anthropic.claude-sonnet-4-5" },
        { region: "eu-central-2", modelID: "anthropic.claude-sonnet-4-5", expected: "anthropic.claude-sonnet-4-5" },
        { region: "eu-west-1", modelID: "cohere.command-r-plus-v1:0", expected: "cohere.command-r-plus-v1:0" },
        {
          region: "ap-southeast-2",
          modelID: "anthropic.claude-sonnet-4-5",
          expected: "au.anthropic.claude-sonnet-4-5",
        },
        {
          region: "ap-southeast-4",
          modelID: "anthropic.claude-haiku-v1:0",
          expected: "au.anthropic.claude-haiku-v1:0",
        },
        { region: "ap-southeast-2", modelID: "anthropic.claude-opus-4", expected: "apac.anthropic.claude-opus-4" },
        {
          region: "ap-northeast-1",
          modelID: "anthropic.claude-sonnet-4-5",
          expected: "jp.anthropic.claude-sonnet-4-5",
        },
        { region: "ap-northeast-1", modelID: "amazon.nova-pro-v1:0", expected: "jp.amazon.nova-pro-v1:0" },
        { region: "ap-south-1", modelID: "anthropic.claude-sonnet-4-5", expected: "apac.anthropic.claude-sonnet-4-5" },
        { region: "ap-south-1", modelID: "amazon.nova-lite-v1:0", expected: "apac.amazon.nova-lite-v1:0" },
        { region: "ca-central-1", modelID: "anthropic.claude-sonnet-4-5", expected: "anthropic.claude-sonnet-4-5" },
        {
          region: "us-east-1",
          modelID: "global.anthropic.claude-sonnet-4-5",
          expected: "global.anthropic.claude-sonnet-4-5",
        },
        { region: "us-east-1", modelID: "us.anthropic.claude-sonnet-4-5", expected: "us.anthropic.claude-sonnet-4-5" },
        { region: "eu-west-1", modelID: "eu.anthropic.claude-sonnet-4-5", expected: "eu.anthropic.claude-sonnet-4-5" },
        {
          region: "ap-northeast-1",
          modelID: "jp.anthropic.claude-sonnet-4-5",
          expected: "jp.anthropic.claude-sonnet-4-5",
        },
        {
          region: "ap-south-1",
          modelID: "apac.anthropic.claude-sonnet-4-5",
          expected: "apac.anthropic.claude-sonnet-4-5",
        },
        {
          region: "ap-southeast-2",
          modelID: "au.anthropic.claude-sonnet-4-5",
          expected: "au.anthropic.claude-sonnet-4-5",
        },
      ]
      yield* addPlugin()
      for (const item of cases) {
        yield* aisdk.runLanguage({
          model: ModelV2.Info.make({
            ...ModelV2.Info.empty(ProviderV2.ID.amazonBedrock, ModelV2.ID.make(item.modelID)),
            api: { id: ModelV2.ID.make(item.modelID), type: "aisdk", package: "test-provider" },
          }),
          sdk: { languageModel: fakeSelectorSdk(calls).languageModel },
          options: { region: item.region },
        })
      }
      expect(calls).toEqual(cases.map((item) => `languageModel:${item.expected}`))
    }),
  )

  it.effect("ignores non-Bedrock providers for language selection", () =>
    Effect.gen(function* () {
      const plugin = yield* PluginV2.Service
      const aisdk = yield* AISDK.Service
      const calls: string[] = []
      yield* addPlugin()
      const result = yield* aisdk.runLanguage({
        model: ModelV2.Info.make({
          ...ModelV2.Info.empty(ProviderV2.ID.openai, ModelV2.ID.make("anthropic.claude-sonnet-4-5")),
          api: { id: ModelV2.ID.make("anthropic.claude-sonnet-4-5"), type: "aisdk", package: "test-provider" },
        }),
        sdk: { languageModel: fakeSelectorSdk(calls).languageModel },
        options: { region: "eu-west-1" },
      })
      expect(calls).toEqual([])
      expect(result.language).toBeUndefined()
    }),
  )
})
