import { ProviderPolicy } from "@opencode/core/provider-policy"
import { describe, expect } from "bun:test"
import { LLM, LanguageModel, Message } from "@opencode/ai"
import { OpenAIChat } from "@opencode/ai/protocols"
import { compileRequest } from "@opencode/ai/route/client"
import { ConfigProvider, Effect, Layer } from "effect"
import { Headers } from "effect/unstable/http"
import { Credential } from "@opencode/core/credential"
import { Integration } from "@opencode/core/integration"
import { Compatibility, ID, Info, VariantID } from "@opencode/core/model"
import { Provider } from "@opencode/core/provider"
import { ModelResolver } from "@opencode/core/model-resolver"
import { Catalog } from "@opencode/core/catalog"
import { AISDK } from "@opencode/core/aisdk"
import { Npm } from "@opencode/util/npm"
import { it } from "./lib/effect"

interface ModelOptions {
  readonly providerID?: Provider.ID
  readonly canonical?: Provider.ID
  readonly modelID?: string
  readonly compatibility?: Compatibility
  readonly settings?: Info["settings"]
  readonly headers?: Info["headers"]
  readonly body?: Info["body"]
  readonly variants?: Info["variants"]
  readonly limit?: Info["limit"]
}

const model = (packageName: string | undefined, options: ModelOptions = {}) =>
  Info.make({
    id: ID.make("test-model"),
    modelID: ID.make(options.modelID ?? "api-test-model"),
    providerID: options.providerID ?? Provider.ID.make("test-provider"),
    canonical: options.canonical,
    name: "Test model",
    compatibility: options.compatibility,
    package: packageName,
    settings: options.settings ?? {},
    headers: options.headers ?? { "x-test": "header" },
    body: options.body ?? { custom_extension: { enabled: true } },
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    variants: options.variants ?? [],
    time: { released: 0 },
    cost: [],
    status: "active",
    enabled: true,
    limit: options.limit ?? { context: 100, output: 20 },
  })

function withEnv<A, E, R>(variables: Record<string, string | undefined>, effect: () => Effect.Effect<A, E, R>) {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = Object.fromEntries(Object.keys(variables).map((key) => [key, process.env[key]]))
      Object.entries(variables).forEach(([key, value]) => {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      })
      return previous
    }),
    effect,
    (previous) =>
      Effect.sync(() => {
        Object.entries(previous).forEach(([key, value]) => {
          if (value === undefined) delete process.env[key]
          else process.env[key] = value
        })
      }),
  )
}

function withConfigEnv<A, E, R>(env: Record<string, string>, effect: () => Effect.Effect<A, E, R>) {
  return effect().pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))))
}

describe("ModelResolver", () => {
  it.effect("constructs native Azure requests with deployment IDs and projected resource URLs", () =>
    Effect.gen(function* () {
      const responses = yield* ModelResolver.fromCatalogModel(
        model(Provider.aisdk("@ai-sdk/azure"), {
          providerID: Provider.ID.azure,
          modelID: "responses-deployment",
          settings: { resourceName: "modern-resource", apiVersion: "2025-01-01-preview" },
        }),
        Credential.Key.make({ type: "key", key: "secret" }),
      )
      const chat = yield* ModelResolver.fromCatalogModel(
        model(Provider.aisdk("@ai-sdk/azure"), {
          providerID: Provider.ID.azure,
          modelID: "chat-deployment",
          settings: { resourceName: "modern-resource", useCompletionUrls: true },
        }),
      )
      const deployment = yield* ModelResolver.fromCatalogModel(
        model(Provider.aisdk("@ai-sdk/azure"), {
          providerID: Provider.ID.azure,
          modelID: "legacy-url-deployment",
          settings: {
            resourceName: "modern-resource",
            apiVersion: "2025-01-01-preview",
            useDeploymentBasedUrls: true,
          },
        }),
      )
      const compatible = yield* ModelResolver.fromCatalogModel(
        model(Provider.aisdk("@ai-sdk/openai-compatible"), {
          providerID: Provider.ID.azure,
          modelID: "legacy-deployment",
          settings: {
            resourceName: "legacy-resource",
            baseURL: "https://legacy-resource.cognitiveservices.azure.com/openai",
          },
        }),
      )

      expect(responses).toMatchObject({ id: "responses-deployment", provider: "azure" })
      expect(responses.route).toMatchObject({
        id: "azure-openai-responses",
        endpoint: {
          baseURL: "https://modern-resource.openai.azure.com/openai/v1",
          query: { "api-version": "2025-01-01-preview" },
        },
      })
      expect(chat).toMatchObject({ id: "chat-deployment", provider: "azure" })
      expect(chat.route.id).toBe("azure-openai-chat")
      expect(deployment).toMatchObject({ id: "legacy-url-deployment", provider: "azure" })
      expect(deployment.route.endpoint).toMatchObject({
        baseURL: "https://modern-resource.openai.azure.com/openai/deployments/legacy-url-deployment",
        query: { "api-version": "2025-01-01-preview" },
      })
      expect(compatible).toMatchObject({ id: "legacy-deployment", provider: "azure" })
      expect(compatible.route.endpoint.baseURL).toBe("https://legacy-resource.cognitiveservices.azure.com/openai")
    }),
  )

  it.effect("keeps explicitly selected compatible packages generic for known provider IDs", () =>
    Effect.gen(function* () {
      for (const providerID of ["baseten", "cerebras", "deepinfra", "deepseek", "fireworks-ai", "groq", "togetherai"]) {
        const selected = yield* ModelResolver.fromCatalogModel(
          model(Provider.aisdk("@ai-sdk/openai-compatible"), {
            providerID: Provider.ID.make(providerID),
            settings: { baseURL: "https://provider.example/v1/openai", apiKey: "fixture" },
          }),
        )
        expect(String(selected.provider)).toBe(providerID)
        expect(selected.route.id).toBe("openai-compatible-chat")
        expect(selected.route.endpoint.baseURL).toBe("https://provider.example/v1/openai")
        const prepared = yield* compileRequest(LLM.request({ model: selected, prompt: "Hello" }))
        expect(prepared.body.messages).toEqual([{ role: "user", content: "Hello" }])
        expect(prepared.body).not.toHaveProperty("apiKey")
      }
    }),
  )

  it.effect("resolves environment templates before native providers inspect endpoints", () =>
    withEnv({ AZURE_HOST: "resource.openai.azure.com" }, () =>
      Effect.gen(function* () {
        const resolved = yield* ModelResolver.fromCatalogModel(
          model(Provider.aisdk("@ai-sdk/azure"), {
            providerID: Provider.ID.azure,
            settings: { baseURL: "https://${AZURE_HOST}/openai" },
          }),
        )

        expect(resolved.route.endpoint).toMatchObject({
          baseURL: "https://resource.openai.azure.com/openai/v1",
          query: { "api-version": "v1" },
        })
      }),
    ),
  )

  it.effect("maps Bedrock Mantle GPT-OSS models to Chat and other models to Responses", () =>
    Effect.gen(function* () {
      const credential = Credential.Key.make({ type: "key", key: "secret" })
      const responses = yield* ModelResolver.fromCatalogModel(
        model(Provider.aisdk("@ai-sdk/amazon-bedrock/mantle"), {
          modelID: "openai.gpt-5.5",
          settings: { region: "us-east-2" },
        }),
        credential,
      )
      const chat = yield* ModelResolver.fromCatalogModel(
        model(Provider.aisdk("@ai-sdk/amazon-bedrock/mantle"), {
          modelID: "openai.gpt-oss-20b",
          settings: { region: "us-east-2" },
        }),
        credential,
      )

      expect(responses.route).toMatchObject({
        id: "bedrock-mantle-responses",
        endpoint: { baseURL: "https://bedrock-mantle.us-east-2.api.aws/v1" },
      })
      expect(chat.route).toMatchObject({
        id: "bedrock-mantle-chat",
        endpoint: { baseURL: "https://bedrock-mantle.us-east-2.api.aws/v1" },
      })
    }),
  )

  it.effect("resolves Bedrock Mantle catalog endpoints from the configured region", () =>
    withEnv({ AWS_REGION: undefined }, () =>
      Effect.gen(function* () {
        const catalog = model(Provider.aisdk("@ai-sdk/amazon-bedrock/mantle"), {
          providerID: Provider.ID.amazonBedrock,
          modelID: "openai.gpt-5.5",
          settings: {
            region: "us-west-2",
            baseURL: "https://bedrock-mantle.${AWS_REGION}.api.aws/openai/v1",
          },
        })
        const resolved = yield* ModelResolver.fromCatalogModel(catalog)

        expect(resolved.route).toMatchObject({
          id: "bedrock-mantle-responses",
          endpoint: { baseURL: "https://bedrock-mantle.us-west-2.api.aws/openai/v1" },
        })
        expect(catalog.settings?.baseURL).toBe("https://bedrock-mantle.${AWS_REGION}.api.aws/openai/v1")
      }),
    ),
  )

  it.effect("prefers the configured Mantle region over the environment", () =>
    withEnv({ AWS_REGION: "us-east-1" }, () =>
      Effect.gen(function* () {
        const resolved = yield* ModelResolver.fromCatalogModel(
          model(Provider.aisdk("@ai-sdk/amazon-bedrock/mantle"), {
            modelID: "openai.gpt-5.5",
            settings: {
              region: "us-west-2",
              baseURL: "https://bedrock-mantle.${AWS_REGION}.api.aws/openai/v1",
            },
          }),
        )

        expect(resolved.route.endpoint.baseURL).toBe("https://bedrock-mantle.us-west-2.api.aws/openai/v1")
      }),
    ),
  )

  it.effect("uses the API modelID instead of the catalog ID for native OpenAI routes", () =>
    Effect.gen(function* () {
      const catalog = model(Provider.aisdk("@ai-sdk/openai"), {
        settings: { baseURL: "https://openai.example/v1" },
        limit: { context: 100, input: 80, output: 20 },
      })
      const resolved = yield* ModelResolver.fromCatalogModel(
        catalog,
        Credential.Key.make({ type: "key", key: "secret" }),
      )

      expect(catalog.id).toBe(ID.make("test-model"))
      expect(resolved).toMatchObject({ id: "api-test-model", provider: "test-provider" })
      expect(resolved.route).toMatchObject({
        id: "openai-responses",
        providerMetadataKey: "openai",
        endpoint: { baseURL: "https://openai.example/v1" },
        defaults: {
          headers: { "x-test": "header" },
          http: { body: { custom_extension: { enabled: true } } },
        },
      })
      const prepared = yield* compileRequest(LLM.request({ model: resolved, prompt: "Hello" }))
      expect(prepared.body.max_output_tokens).toBeUndefined()
      expect(JSON.stringify(prepared.body)).not.toContain("max_output_tokens")
    }),
  )

  it.effect("keeps catalog apiKey credentials out of provider JSON", () =>
    Effect.gen(function* () {
      const resolved = yield* ModelResolver.fromCatalogModel(
        model(Provider.aisdk("@ai-sdk/openai"), {
          settings: { apiKey: "secret", baseURL: "https://openai.example/v1" },
        }),
      )
      const prepared = yield* compileRequest(LLM.request({ model: resolved, prompt: "Hello" }))

      expect(JSON.stringify(prepared.body)).not.toContain("apiKey")
      expect(JSON.stringify(prepared.body)).not.toContain("secret")
    }),
  )

  it.effect("treats an empty configured API key as omitted", () =>
    withConfigEnv({ OPENAI_API_KEY: "environment-key" }, () =>
      Effect.gen(function* () {
        const resolved = yield* ModelResolver.fromCatalogModel(
          model(Provider.aisdk("@ai-sdk/openai"), {
            settings: { apiKey: "", baseURL: "https://openai.example/v1" },
          }),
        )
        const headers = yield* resolved.route.auth.apply({
          request: LLM.request({ model: resolved, prompt: "Hello" }),
          method: "POST",
          url: "https://openai.example/v1/responses",
          body: "{}",
          headers: Headers.empty,
        })

        expect(headers.authorization).toBe("Bearer environment-key")
      }),
    ),
  )

  it.effect("uses no native API-key auth for explicitly enabled providers without credentials", () => {
    const selected = model(Provider.aisdk("@ai-sdk/google"), {
      providerID: Provider.ID.make("gateway"),
      canonical: Provider.ID.google,
      settings: { baseURL: "https://gateway.example.com/v1" },
      headers: { "cf-access-token": "access-token" },
    })
    const selections = [
      selected,
      model(Provider.aisdk("@ai-sdk/mistral"), {
        providerID: Provider.ID.make("gateway"),
        settings: { baseURL: "https://mistral.example.com/v1" },
        headers: { "cf-access-token": "access-token" },
      }),
      model("@opencode/ai/providers/mistral", {
        providerID: Provider.ID.make("gateway"),
        settings: { baseURL: "https://native-mistral.example.com/v1" },
        headers: { "cf-access-token": "access-token" },
      }),
      ...["baseten", "cloudflare-ai-gateway", "cloudflare-workers-ai", "deepseek", "fireworks"].map((name) =>
        model(`@opencode/ai/providers/${name}`, {
          providerID: Provider.ID.make("gateway"),
          settings: { baseURL: `https://${name}.example.com/v1` },
          headers: { "cf-access-token": "access-token" },
        }),
      ),
    ]
    const provider = Provider.Info.make({
      ...Provider.Info.empty(selected.providerID),
      activation: "enabled",
      package: selected.package ?? "",
      settings: selected.settings,
      headers: selected.headers,
    })
    const catalog = Layer.mock(Catalog.Service, {
      provider: {
        get: () => Effect.succeed(provider),
        all: () => Effect.die("unused"),
        available: () => Effect.die("unused"),
      },
      model: {
        get: () => Effect.succeed(selected),
        all: () => Effect.die("unused"),
        available: () => Effect.die("unused"),
        default: () => Effect.die("unused"),
        small: () => Effect.die("unused"),
      },
    })
    const integrations = Layer.mock(Integration.Service, {
      connection: {
        active: (id) => {
          expect(id).toBe(Integration.ID.make("gateway"))
          return Effect.undefined
        },
        resolve: () => Effect.die("unused"),
        key: () => Effect.die("unused"),
        activate: () => Effect.die("unused"),
        update: () => Effect.die("unused"),
        remove: () => Effect.die("unused"),
      },
      oauth: {
        connect: () => Effect.die("unused"),
        status: () => Effect.die("unused"),
        complete: () => Effect.die("unused"),
        cancel: () => Effect.die("unused"),
      },
      command: {
        connect: () => Effect.die("unused"),
        status: () => Effect.die("unused"),
        cancel: () => Effect.die("unused"),
      },
    })
    const npm = Layer.mock(Npm.Service, {
      add: () => Effect.die("unused"),
      which: () => Effect.die("unused"),
    })
    const aisdk = Layer.mock(AISDK.Service, {
      hook: {
        sdk: () => Effect.die("unused"),
        language: () => Effect.die("unused"),
      },
      model: () => Effect.die("unused"),
    })
    const layer = ModelResolver.layer.pipe(
      Layer.provide(Layer.mock(ProviderPolicy.Service, { assert: () => Effect.void })),
      Layer.provide(Layer.mergeAll(catalog, integrations, npm, aisdk)),
    )

    return withConfigEnv({}, () =>
      Effect.gen(function* () {
        const resolver = yield* ModelResolver.Service
        yield* Effect.forEach(selections, (selection) =>
          Effect.gen(function* () {
            const resolved = yield* resolver.resolveModel(selection)
            const headers = yield* resolved.model.route.auth.apply({
              request: LLM.request({ model: resolved.model, prompt: "Hello" }),
              method: "POST",
              url: resolved.model.route.endpoint.baseURL ?? "",
              body: "{}",
              headers: Headers.fromInput(resolved.model.route.defaults.headers),
            })

            expect(resolved.limit).toEqual(selection.limit)
            expect(resolved.ref.providerID).toBe(selection.providerID)
            expect(String(resolved.model.provider)).toBe(selection.canonical ?? selection.providerID)
            expect(headers["cf-access-token"]).toBe("access-token")
            expect(headers.authorization).toBeUndefined()
            expect(headers["x-goog-api-key"]).toBeUndefined()
          }),
        )
      }).pipe(Effect.provide(layer)),
    )
  })

  it.effect("keeps native provider environment auth strict when no API key is configured", () =>
    withConfigEnv({}, () =>
      Effect.gen(function* () {
        const resolved = yield* ModelResolver.fromCatalogModel(
          model(Provider.aisdk("@ai-sdk/google"), {
            settings: { baseURL: "https://google.example.com/v1" },
          }),
        )
        const exit = yield* Effect.exit(
          resolved.route.auth.apply({
            request: LLM.request({ model: resolved, prompt: "Hello" }),
            method: "POST",
            url: "https://google.example.com/v1",
            body: "{}",
            headers: Headers.empty,
          }),
        )

        expect(exit._tag).toBe("Failure")
      }),
    ),
  )

  it.effect("uses merged API settings for OpenAI-compatible auth and request defaults", () =>
    Effect.gen(function* () {
      const resolved = yield* ModelResolver.fromCatalogModel(
        model(Provider.aisdk("@ai-sdk/openai-compatible"), {
          canonical: Provider.ID.make("deepseek"),
          compatibility: {
            reasoningField: "vendor_reasoning",
            requireReasoning: true,
            maxTokensField: "max_completion_tokens",
            requireFinishReason: false,
            requireAssistantAfterTool: true,
          },
          settings: {
            apiKey: "settings-secret",
            baseURL: "https://compatible.example/v1",
            compatibility: "strict",
          },
          headers: {},
          body: {},
        }),
      )
      const request = LLM.request({ model: resolved, prompt: "Hello", generation: { maxTokens: 10 } })
      const prepared = yield* compileRequest(request)
      const headers = yield* resolved.route.auth.apply({
        request,
        method: "POST",
        url: "https://compatible.example/v1/chat/completions",
        body: "{}",
        headers: Headers.empty,
      })

      expect(headers.authorization).toBe("Bearer settings-secret")
      expect(resolved.route.id).toBe("openai-compatible-chat")
      expect(String(resolved.provider)).toBe("deepseek")
      expect(resolved.route.providerMetadataKey).toBe("deepseek")
      expect(resolved.compatibility?.reasoningField).toBe("vendor_reasoning")
      expect(resolved.compatibility?.requireReasoning).toBe(true)
      expect(resolved.compatibility?.maxTokensField).toBe("max_completion_tokens")
      expect(resolved.compatibility?.requireFinishReason).toBe(false)
      expect(resolved.compatibility?.requireAssistantAfterTool).toBe(true)
      expect(prepared.body).toMatchObject({ max_completion_tokens: 10 })
      expect(prepared.body).not.toHaveProperty("max_tokens")
      expect(resolved.route.endpoint.baseURL).toBe("https://compatible.example/v1")
      expect(resolved.route.defaults.http?.body).toEqual({})
    }),
  )

  it.effect("resolves provider URLs from environment without mutating the catalog model", () =>
    withEnv({ ACME_HOST: "api.acme.test" }, () =>
      Effect.gen(function* () {
        const catalog = model(Provider.aisdk("@ai-sdk/openai-compatible"), {
          settings: { baseURL: "https://${ACME_HOST}/v1" },
        })
        const resolved = yield* ModelResolver.fromCatalogModel(catalog)

        expect(resolved.route.endpoint.baseURL).toBe("https://api.acme.test/v1")
        expect(catalog.settings?.baseURL).toBe("https://${ACME_HOST}/v1")
      }),
    ),
  )

  it.effect("rejects unresolved variables in constructed provider routes", () =>
    withEnv({ REQUIRED_HOST: undefined }, () =>
      Effect.gen(function* () {
        const failure = yield* ModelResolver.fromCatalogModel(
          model(Provider.aisdk("@ai-sdk/openai-compatible"), {
            settings: { baseURL: "https://${REQUIRED_HOST}/${REQUIRED_PATH}/v1" },
          }),
        ).pipe(Effect.flip)

        expect(failure).toMatchObject({
          _tag: "SessionRunnerModel.UnresolvedProviderVariablesError",
          providerID: "test-provider",
          modelID: "test-model",
          variables: ["REQUIRED_HOST", "REQUIRED_PATH"],
        })
        expect(failure.message).toBe(
          "Cannot initialize test-provider/test-model: REQUIRED_HOST, REQUIRED_PATH are required to resolve the provider endpoint",
        )
      }),
    ),
  )

  it.effect("overlays selected OpenAI variant settings and bodies", () =>
    Effect.gen(function* () {
      const catalog = model(Provider.aisdk("@ai-sdk/openai"), {
        settings: { baseURL: "https://openai.example/v1" },
        variants: [
          {
            id: VariantID.make("xhigh"),
            settings: {
              reasoningEffort: "xhigh",
              reasoningSummary: "auto",
              include: ["reasoning.encrypted_content"],
            },
            headers: { "x-variant": "high" },
            body: {
              store: false,
              service_tier: "priority",
              temperature: 0.2,
            },
          },
        ],
      })
      const resolved = yield* ModelResolver.resolveModel(
        catalog,
        VariantID.make("xhigh"),
        Credential.Key.make({ type: "key", key: "secret" }),
      )

      expect(resolved.route.defaults.headers).toMatchObject({ "x-test": "header", "x-variant": "high" })
      expect(resolved.route.defaults.http?.body).toEqual({
        custom_extension: { enabled: true },
        store: false,
        service_tier: "priority",
        temperature: 0.2,
      })
      expect(resolved.route.defaults.providerOptions).toEqual({
        store: false,
        reasoningEffort: "xhigh",
        reasoningSummary: "auto",
        include: ["reasoning.encrypted_content"],
      })
      const prepared = yield* compileRequest(LLM.request({ model: resolved, prompt: "Hello" }))
      expect(prepared.body).toMatchObject({
        include: ["reasoning.encrypted_content"],
        reasoning: { effort: "xhigh", summary: "auto" },
      })
    }),
  )

  it.effect("overlays selected OpenAI-compatible variant bodies", () =>
    Effect.gen(function* () {
      const catalog = model(Provider.aisdk("@ai-sdk/openai-compatible"), {
        settings: { baseURL: "https://compatible.example/v1" },
        variants: [
          {
            id: VariantID.make("high"),
            settings: {},
            headers: {},
            body: { store: false, reasoning_effort: "high" },
          },
        ],
      })
      const resolved = yield* ModelResolver.resolveModel(catalog, VariantID.make("high"))

      expect(resolved.route.defaults.http?.body).toEqual({
        custom_extension: { enabled: true },
        store: false,
        reasoning_effort: "high",
      })
    }),
  )

  it.effect("rejects an explicit unavailable variant during model resolution", () =>
    Effect.gen(function* () {
      const catalog = model(Provider.aisdk("@ai-sdk/openai"), {
        settings: { baseURL: "https://openai.example/v1" },
      })
      const failure = yield* ModelResolver.resolveModel(catalog, VariantID.make("unknown")).pipe(Effect.flip)

      expect(failure).toMatchObject({
        _tag: "SessionRunnerModel.VariantUnavailableError",
        providerID: "test-provider",
        modelID: "test-model",
        variant: "unknown",
      })
      expect(failure.message).toBe("Variant unavailable for test-provider/test-model: unknown")
    }),
  )

  it.effect("overlays selected Anthropic variant settings", () =>
    Effect.gen(function* () {
      const catalog = model(Provider.aisdk("@ai-sdk/anthropic"), {
        settings: { baseURL: "https://anthropic.example/v1" },
        variants: [
          {
            id: VariantID.make("high"),
            settings: { thinking: { type: "enabled", budgetTokens: 12000 } },
            headers: {},
            body: {},
          },
        ],
      })
      const resolved = yield* ModelResolver.resolveModel(catalog, VariantID.make("high"))

      expect(resolved.route.defaults.http?.body).toEqual({
        custom_extension: { enabled: true },
      })
      expect(resolved.route.defaults.providerOptions).toEqual({
        thinking: { type: "enabled", budgetTokens: 12000 },
      })
    }),
  )

  it.effect("maps catalog Anthropic AI SDK models into native routes", () =>
    Effect.gen(function* () {
      const resolved = yield* ModelResolver.fromCatalogModel(
        model(Provider.aisdk("@ai-sdk/anthropic"), {
          settings: { baseURL: "https://anthropic.example/v1" },
        }),
      )

      expect(resolved.route).toMatchObject({
        id: "anthropic-messages",
        providerMetadataKey: "anthropic",
        endpoint: { baseURL: "https://anthropic.example/v1" },
      })
    }),
  )

  it.effect("uses resolved credentials for bearer auth", () =>
    Effect.gen(function* () {
      const resolved = yield* ModelResolver.fromCatalogModel(
        model(Provider.aisdk("@ai-sdk/openai"), {
          settings: { baseURL: "https://openai.example/v1" },
          headers: {},
          body: {},
        }),
        Credential.Key.make({ type: "key", key: "secret" }),
      )
      const request = LLM.request({ model: resolved, prompt: "Hello" })
      const headers = yield* resolved.route.auth.apply({
        request,
        method: "POST",
        url: "https://openai.example/v1/responses",
        body: "{}",
        headers: Headers.empty,
      })

      expect(headers.authorization).toBe("Bearer secret")
    }),
  )

  it.effect("prefers stored credentials over configured auth", () =>
    Effect.gen(function* () {
      const credential = Credential.Key.make({ type: "key", key: "stored-secret", metadata: { tenant: "work" } })
      const resolved = yield* ModelResolver.fromCatalogModel(
        model(Provider.aisdk("@ai-sdk/openai"), {
          settings: { apiKey: "configured-secret", baseURL: "https://openai.example/v1" },
          headers: {},
          body: {},
        }),
        credential,
      )
      const headers = yield* resolved.route.auth.apply({
        request: LLM.request({ model: resolved, prompt: "Hello" }),
        method: "POST",
        url: "https://openai.example/v1/responses",
        body: "{}",
        headers: Headers.empty,
      })

      expect(headers.authorization).toBe("Bearer stored-secret")
      expect(resolved.route.defaults.http?.body).toEqual({ tenant: "work" })
    }),
  )

  it.effect("does not project OAuth account metadata into the request body", () =>
    Effect.gen(function* () {
      const resolved = yield* ModelResolver.fromCatalogModel(
        model(Provider.aisdk("@ai-sdk/openai"), {
          settings: { baseURL: "https://openai.example/v1" },
          headers: {},
          body: {},
        }),
        Credential.OAuth.make({
          type: "oauth",
          methodID: Integration.MethodID.make("device"),
          access: "secret",
          refresh: "refresh",
          expires: Date.now() + 60_000,
          metadata: { server: "https://console.example", orgID: "org_123" },
        }),
      )

      expect(resolved.route.defaults.http?.body).toEqual({})
    }),
  )

  it.effect("applies plugin-projected OpenAI endpoint and headers", () =>
    Effect.gen(function* () {
      const resolved = yield* ModelResolver.fromCatalogModel(
        model("@opencode/ai/providers/openai", {
          settings: { baseURL: "https://chatgpt.com/backend-api/codex" },
          headers: { "chatgpt-account-id": "acct_123" },
          body: {},
        }),
        Credential.OAuth.make({
          type: "oauth",
          methodID: Integration.MethodID.make("chatgpt-browser"),
          access: "chatgpt-token",
          refresh: "refresh",
          expires: Date.now() + 60_000,
          metadata: { accountID: "acct_123" },
        }),
      )
      const request = LLM.request({
        model: resolved,
        system: [
          { type: "text", text: "Base instructions." },
          { type: "text", text: "Project instructions." },
        ],
        messages: [Message.user("Hello"), Message.system("Updated instructions.")],
      })
      const prepared = yield* compileRequest(request)
      const headers = yield* resolved.route.auth.apply({
        request,
        method: "POST",
        url: "https://chatgpt.com/backend-api/codex/responses",
        body: "{}",
        headers: Headers.empty,
      })

      expect(resolved.route).toMatchObject({
        id: "openai-responses",
        endpoint: { baseURL: "https://chatgpt.com/backend-api/codex" },
      })
      expect(resolved.route.defaults.headers).toMatchObject({ "chatgpt-account-id": "acct_123" })
      expect(headers.authorization).toBe("Bearer chatgpt-token")
      expect(prepared.body).toMatchObject({
        instructions: "Base instructions.\nProject instructions.",
        input: [
          { role: "user", content: [{ type: "input_text", text: "Hello" }] },
          { role: "developer", content: "Updated instructions." },
        ],
      })
    }),
  )

  it.effect("does not route native OpenAI-compatible packages to the codex backend", () =>
    Effect.gen(function* () {
      const resolved = yield* ModelResolver.fromCatalogModel(
        model("@opencode/ai/providers/openai-compatible", {
          settings: { baseURL: "https://compatible.example/v1" },
        }),
        Credential.OAuth.make({
          type: "oauth",
          methodID: Integration.MethodID.make("chatgpt-browser"),
          access: "chatgpt-token",
          refresh: "refresh",
          expires: Date.now() + 60_000,
          metadata: { accountID: "acct_123" },
        }),
      )

      expect(resolved.route.id).toBe("openai-compatible-chat")
      expect(resolved.route.endpoint.baseURL).toBe("https://compatible.example/v1")
    }),
  )

  it.effect("maps legacy OpenAI organization and project settings to headers", () =>
    Effect.gen(function* () {
      const resolved = yield* ModelResolver.fromCatalogModel(
        model(Provider.aisdk("@ai-sdk/openai"), {
          settings: { organization: "org_123", project: "proj_123" },
        }),
      )

      expect(resolved.route.defaults.headers).toMatchObject({
        "OpenAI-Organization": "org_123",
        "OpenAI-Project": "proj_123",
      })
    }),
  )

  it.effect("keeps non-ChatGPT OAuth credentials on the configured endpoint", () =>
    Effect.gen(function* () {
      const resolved = yield* ModelResolver.fromCatalogModel(
        model(Provider.aisdk("@ai-sdk/openai"), {
          settings: { baseURL: "https://openai.example/v1" },
          headers: {},
          body: {},
        }),
        Credential.OAuth.make({
          type: "oauth",
          methodID: Integration.MethodID.make("device"),
          access: "oauth-token",
          refresh: "refresh",
          expires: Date.now() + 60_000,
          metadata: { accountID: "acct_123" },
        }),
      )
      const request = LLM.request({ model: resolved, prompt: "Hello" })
      const headers = yield* resolved.route.auth.apply({
        request,
        method: "POST",
        url: "https://openai.example/v1/responses",
        body: "{}",
        headers: Headers.empty,
      })

      expect(resolved.route.endpoint.baseURL).toBe("https://openai.example/v1")
      expect(headers.authorization).toBe("Bearer oauth-token")
      expect(headers["chatgpt-account-id"]).toBeUndefined()
    }),
  )

  it.effect("loads dynamic native provider packages through the injected package loader", () =>
    Effect.gen(function* () {
      const native = yield* ModelResolver.fromCatalogModel(
        model(Provider.aisdk("@ai-sdk/openai"), {
          settings: { baseURL: "https://openai.example/v1" },
        }),
      )
      const resolved = yield* ModelResolver.fromCatalogModel(
        model("@opencode/ai/providers/custom", {
          settings: { region: "test" },
          headers: { "x-package": "header" },
          body: { custom: true },
        }),
        undefined,
        {
          loadPackage: (specifier) => {
            expect(specifier).toBe("@opencode/ai/providers/custom")
            return Effect.succeed({
              model: (modelID, settings) => {
                expect(modelID).toBe("api-test-model")
                expect(settings).toEqual({
                  region: "test",
                  headers: { "x-package": "header" },
                  body: { custom: true },
                })
                return LanguageModel.make({ id: modelID, provider: "package-provider", route: native.route })
              },
            })
          },
        },
      )

      expect(resolved).toMatchObject({ id: "api-test-model", provider: "test-provider" })
    }),
  )

  it.effect("maps OAuth credentials to native provider auth settings", () =>
    Effect.gen(function* () {
      const native = yield* ModelResolver.fromCatalogModel(
        model(Provider.aisdk("@ai-sdk/openai"), {
          settings: { baseURL: "https://openai.example/v1" },
        }),
      )
      const credential = Credential.OAuth.make({
        type: "oauth",
        methodID: Integration.MethodID.make("device"),
        access: "oauth-token",
        refresh: "refresh",
        expires: Date.now() + 60_000,
      })
      const packages = [
        ["@opencode/ai/providers/google-vertex", "accessToken"],
        ["@opencode/ai/providers/google-vertex/gemini", "accessToken"],
        ["@opencode/ai/providers/google-vertex/chat", "accessToken"],
        ["@opencode/ai/providers/google-vertex/responses", "accessToken"],
        ["@opencode/ai/providers/google-vertex/messages", "accessToken"],
        ["@opencode/ai/providers/anthropic", "authToken"],
        ["@opencode/ai/providers/anthropic-compatible", "authToken"],
      ] as const

      yield* Effect.forEach(packages, ([specifier, key]) =>
        ModelResolver.fromCatalogModel(model(specifier, { settings: { apiKey: "configured-key" } }), credential, {
          loadPackage: () =>
            Effect.succeed({
              model: (modelID, settings) => {
                expect(settings).toMatchObject({ [key]: "oauth-token" })
                expect(settings).not.toHaveProperty("apiKey")
                return LanguageModel.make({ id: modelID, provider: "package-provider", route: native.route })
              },
            }),
        }),
      )
    }),
  )

  it.effect("routes supported AISDK catalog packages through native provider packages", () =>
    Effect.gen(function* () {
      const native = yield* ModelResolver.fromCatalogModel(model(Provider.aisdk("@ai-sdk/openai")))
      const packages = [
        [
          "@ai-sdk/openai",
          "@opencode/ai/providers/openai",
          {
            reasoningEffort: "xhigh",
            reasoningSummary: "auto",
            include: ["reasoning.encrypted_content"],
          },
          {
            reasoningEffort: "xhigh",
            reasoningSummary: "auto",
            include: ["reasoning.encrypted_content"],
          },
        ],
        [
          "@ai-sdk/anthropic",
          "@opencode/ai/providers/anthropic",
          { thinking: { type: "adaptive", display: "summarized" }, effort: "high" },
          { thinking: { type: "adaptive", display: "summarized" }, effort: "high" },
        ],
        [
          "@ai-sdk/cerebras",
          "@opencode/ai/providers/cerebras",
          { reasoningEffort: "high" },
          { reasoningEffort: "high" },
        ],
        [
          "@ai-sdk/deepinfra",
          "@opencode/ai/providers/deepinfra",
          { reasoningEffort: "none" },
          { reasoningEffort: "none" },
        ],
        [
          "@ai-sdk/openai-compatible",
          "@opencode/ai/providers/openai-compatible",
          { reasoningEffort: "high" },
          { reasoningEffort: "high" },
        ],
        [
          "@ai-sdk/google",
          "@opencode/ai/providers/google",
          { thinkingConfig: { thinkingLevel: "high" } },
          { thinkingConfig: { thinkingLevel: "high" } },
        ],
        [
          "@ai-sdk/google-vertex",
          "@opencode/ai/providers/google-vertex",
          { thinkingConfig: { thinkingLevel: "high" } },
          { thinkingConfig: { thinkingLevel: "high" } },
        ],
        [
          "@openrouter/ai-sdk-provider",
          "@opencode/ai/providers/openrouter",
          { reasoning: { effort: "high" } },
          { reasoning: { effort: "high" } },
        ],
        [
          "@ai-sdk/groq",
          "@opencode/ai/providers/groq",
          { reasoningEffort: "high", parallelToolCalls: false },
          { reasoningEffort: "high", parallelToolCalls: false },
        ],
        [
          "@ai-sdk/mistral",
          "@opencode/ai/providers/mistral",
          {
            safePrompt: true,
            documentImageLimit: 4,
            promptCacheKey: "session-123",
            promptMode: "reasoning",
            reasoningEffort: "high",
          },
          {
            safePrompt: true,
            documentImageLimit: 4,
            promptCacheKey: "session-123",
            promptMode: "reasoning",
            reasoningEffort: "high",
          },
        ],
        [
          "@ai-sdk/togetherai",
          "@opencode/ai/providers/togetherai",
          { reasoningEffort: "high" },
          { reasoningEffort: "high" },
        ],
        ["@ai-sdk/xai", "@opencode/ai/providers/xai", { reasoningEffort: "high" }, { reasoningEffort: "high" }],
      ] as const

      yield* Effect.forEach(packages, ([catalogPackage, nativePackage, sourceOptions, providerOptions]) =>
        ModelResolver.fromCatalogModel(
          model(Provider.aisdk(catalogPackage), {
            modelID: "api-model",
            settings: { baseURL: "https://provider.example/v1", ...sourceOptions },
            headers: { "x-provider": "header" },
            body: { custom: true },
          }),
          Credential.Key.make({ type: "key", key: "secret" }),
          {
            loadPackage: (specifier) => {
              expect(specifier).toBe(nativePackage)
              return Effect.succeed({
                model: (modelID, settings) => {
                  expect(modelID).toBe("api-model")
                  expect(settings).toMatchObject({
                    apiKey: "secret",
                    baseURL: "https://provider.example/v1",
                    headers: { "x-provider": "header" },
                    body: { custom: true },
                    ...providerOptions,
                  })
                  return LanguageModel.make({ id: modelID, provider: "native-provider", route: native.route })
                },
              })
            },
            loadAISDK: () => Effect.die("AI SDK loader should not be called"),
          },
        ),
      )
    }),
  )

  it.effect("never loads the AI SDK for packages with native implementations", () =>
    Effect.gen(function* () {
      const packages = [
        ["@ai-sdk/anthropic", "@opencode/ai/providers/anthropic", "api-model"],
        ["@ai-sdk/amazon-bedrock", "@opencode/ai/providers/amazon-bedrock", "api-model"],
        ["@ai-sdk/amazon-bedrock/mantle", "@opencode/ai/providers/amazon-bedrock/mantle/chat", "openai.gpt-oss-120b"],
        ["@ai-sdk/azure", "@opencode/ai/providers/azure/responses", "api-model"],
        ["@ai-sdk/cerebras", "@opencode/ai/providers/cerebras", "api-model"],
        ["@ai-sdk/deepinfra", "@opencode/ai/providers/deepinfra", "api-model"],
        ["@ai-sdk/google", "@opencode/ai/providers/google", "api-model"],
        ["@ai-sdk/google-vertex", "@opencode/ai/providers/google-vertex", "api-model"],
        ["@ai-sdk/google-vertex/anthropic", "@opencode/ai/providers/google-vertex/messages", "claude-sonnet-4-6"],
        ["@ai-sdk/groq", "@opencode/ai/providers/groq", "api-model"],
        ["@ai-sdk/mistral", "@opencode/ai/providers/mistral", "api-model"],
        ["@ai-sdk/openai", "@opencode/ai/providers/openai", "api-model"],
        ["@ai-sdk/openai-compatible", "@opencode/ai/providers/openai-compatible", "api-model"],
        ["@openrouter/ai-sdk-provider", "@opencode/ai/providers/openrouter", "api-model"],
        ["@ai-sdk/togetherai", "@opencode/ai/providers/togetherai", "api-model"],
        ["@ai-sdk/xai", "@opencode/ai/providers/xai", "api-model"],
      ] as const

      yield* Effect.forEach(packages, ([catalogPackage, nativePackage, modelID]) =>
        ModelResolver.fromCatalogModel(
          model(Provider.aisdk(catalogPackage), {
            modelID,
            settings: { baseURL: "https://provider.example/v1", region: "us-east-1" },
          }),
          undefined,
          {
            loadPackage: (specifier) => {
              expect(specifier).toBe(nativePackage)
              return Effect.succeed({
                model: (id) => LanguageModel.make({ id, provider: "native-provider", route: OpenAIChat.route }),
              })
            },
            loadAISDK: () => Effect.die(`AI SDK loader called for ${catalogPackage}`),
          },
        ),
      )
    }),
  )

  it.effect("routes Vertex Anthropic catalog models through native Messages", () =>
    Effect.gen(function* () {
      const native = yield* ModelResolver.fromCatalogModel(model(Provider.aisdk("@ai-sdk/openai")))
      const credential = Credential.OAuth.make({
        type: "oauth",
        methodID: Integration.MethodID.make("device"),
        access: "vertex-token",
        refresh: "refresh",
        expires: Date.now() + 60_000,
      })

      const resolved = yield* ModelResolver.fromCatalogModel(
        model(Provider.aisdk("@ai-sdk/google-vertex/anthropic"), {
          modelID: "claude-sonnet-4-6",
          settings: {
            location: "eu",
            project: "vertex-project",
            thinking: { type: "adaptive", display: "summarized" },
            effort: "high",
          },
        }),
        credential,
        {
          loadPackage: (specifier) => {
            expect(specifier).toBe("@opencode/ai/providers/google-vertex/messages")
            return Effect.succeed({
              model: (modelID, settings) => {
                expect(modelID).toBe("claude-sonnet-4-6")
                expect(settings).toMatchObject({
                  accessToken: "vertex-token",
                  location: "eu",
                  project: "vertex-project",
                  thinking: { type: "adaptive", display: "summarized" },
                  effort: "high",
                })
                return LanguageModel.make({ id: modelID, provider: "native-provider", route: native.route })
              },
            })
          },
          loadAISDK: () => Effect.die("AI SDK loader should not be called"),
        },
      )

      expect(resolved).toMatchObject({ id: "claude-sonnet-4-6", provider: "test-provider" })
    }),
  )

  it.effect("merges mapped OpenRouter headers and body with catalog overlays", () =>
    ModelResolver.fromCatalogModel(
      model(Provider.aisdk("@openrouter/ai-sdk-provider"), {
        settings: {
          appName: "OpenCode",
          appUrl: "https://opencode.ai",
          extraBody: { transforms: ["middle-out"], provider: { sort: "price" } },
        },
        headers: { "X-OpenRouter-Title": "Custom" },
        body: { provider: { only: ["anthropic"] } },
      }),
      undefined,
      {
        loadPackage: () =>
          Effect.succeed({
            model: (modelID, settings) => {
              expect(settings.headers).toEqual({
                "HTTP-Referer": "https://opencode.ai",
                "X-OpenRouter-Title": "Custom",
              })
              expect(settings.body).toEqual({
                transforms: ["middle-out"],
                provider: { sort: "price", only: ["anthropic"] },
              })
              return LanguageModel.make({ id: modelID, provider: "openrouter", route: OpenAIChat.route })
            },
          }),
      },
    ),
  )

  it.effect("merges mapped Mistral headers and body with catalog overlays", () =>
    ModelResolver.fromCatalogModel(
      model(Provider.aisdk("@ai-sdk/mistral"), {
        settings: {
          headers: { "x-factory": "factory", "x-shared": "factory" },
          extraBody: { factory: true, custom: { source: true } },
        },
        headers: { "x-shared": "catalog" },
        body: { custom: { catalog: true } },
      }),
      undefined,
      {
        loadPackage: () =>
          Effect.succeed({
            model: (modelID, settings) => {
              expect(settings.headers).toEqual({
                "x-factory": "factory",
                "x-shared": "catalog",
              })
              expect(settings.body).toEqual({
                factory: true,
                custom: { source: true, catalog: true },
              })
              return LanguageModel.make({ id: modelID, provider: "mistral", route: OpenAIChat.route })
            },
          }),
      },
    ),
  )

  it.effect("loads supported AISDK catalog packages as native routes", () =>
    Effect.gen(function* () {
      const google = yield* ModelResolver.fromCatalogModel(
        model(Provider.aisdk("@ai-sdk/google"), { settings: { thinkingConfig: { thinkingBudget: 1_024 } } }),
      )
      const openrouter = yield* ModelResolver.fromCatalogModel(
        model(Provider.aisdk("@openrouter/ai-sdk-provider"), {
          settings: { reasoning: { effort: "high" } },
        }),
      )
      const cerebras = yield* ModelResolver.fromCatalogModel(
        model(Provider.aisdk("@ai-sdk/cerebras"), { settings: { reasoningEffort: "high" } }),
      )
      const deepinfra = yield* ModelResolver.fromCatalogModel(
        model(Provider.aisdk("@ai-sdk/deepinfra"), {
          settings: { baseURL: "https://deepinfra.example/provider-root", reasoningEffort: "none" },
        }),
      )
      const togetherai = yield* ModelResolver.fromCatalogModel(
        model(Provider.aisdk("@ai-sdk/togetherai"), { settings: { reasoningEffort: "high" } }),
      )
      const groq = yield* ModelResolver.fromCatalogModel(
        model(Provider.aisdk("@ai-sdk/groq"), {
          settings: { reasoningEffort: "high", parallelToolCalls: false },
        }),
      )
      const mistral = yield* ModelResolver.fromCatalogModel(
        model(Provider.aisdk("@ai-sdk/mistral"), {
          settings: { safePrompt: true, promptCacheKey: "session-123", reasoningEffort: "high" },
        }),
      )
      const xai = yield* ModelResolver.fromCatalogModel(
        model(Provider.aisdk("@ai-sdk/xai"), { settings: { reasoningEffort: "high" } }),
      )
      const bedrock = yield* ModelResolver.fromCatalogModel(
        model(Provider.aisdk("@ai-sdk/amazon-bedrock"), {
          settings: { region: "us-east-1", topP: 0.8, serviceTier: "priority" },
          body: {},
        }),
      )
      const mantle = yield* ModelResolver.fromCatalogModel(
        model(Provider.aisdk("@ai-sdk/amazon-bedrock/mantle"), {
          modelID: "openai.gpt-oss-120b",
          settings: { region: "us-east-1", topP: 0.6 },
        }),
      )

      expect(google.route.id).toBe("gemini")
      expect(google.route.defaults.providerOptions).toEqual({ thinkingConfig: { thinkingBudget: 1_024 } })
      expect(openrouter.route.id).toBe("openrouter")
      expect(openrouter.route.defaults.providerOptions).toEqual({ reasoning: { effort: "high" } })
      expect(cerebras.route.id).toBe("cerebras-chat")
      expect(cerebras.route.defaults.providerOptions).toEqual({ reasoningEffort: "high" })
      expect(String(cerebras.provider)).toBe("test-provider")
      expect(deepinfra.route.id).toBe("deepinfra-chat")
      expect(deepinfra.route.endpoint.baseURL).toBe("https://deepinfra.example/provider-root/openai")
      expect(deepinfra.route.defaults.providerOptions).toEqual({ reasoningEffort: "none" })
      expect(String(deepinfra.provider)).toBe("test-provider")
      expect(togetherai.route.id).toBe("togetherai-chat")
      expect(togetherai.route.defaults.providerOptions).toEqual({ reasoningEffort: "high" })
      expect(String(togetherai.provider)).toBe("test-provider")
      expect(groq.route.id).toBe("groq-chat")
      expect(groq.route.protocol).toBe("groq-chat")
      expect(groq.route.defaults.providerOptions).toEqual({ reasoningEffort: "high", parallelToolCalls: false })
      expect(String(groq.provider)).toBe("test-provider")
      expect(mistral.route.id).toBe("mistral-chat")
      expect(mistral.route.defaults.providerOptions).toEqual({
        safePrompt: true,
        promptCacheKey: "session-123",
        reasoningEffort: "high",
      })
      expect(String(mistral.provider)).toBe("test-provider")
      expect(xai.route.id).toBe("openai-responses")
      expect(xai.route.defaults.providerOptions).toEqual({
        reasoningEffort: "high",
        store: false,
        include: ["reasoning.encrypted_content"],
      })
      expect(bedrock.route.id).toBe("bedrock-converse")
      expect(bedrock.route.defaults.generation).toEqual({ topP: 0.8 })
      expect(bedrock.route.defaults.http?.body).toEqual({ serviceTier: { type: "priority" } })
      expect(mantle.route.id).toBe("bedrock-mantle-chat")
      expect(mantle.route.defaults.generation).toEqual({ topP: 0.6 })
    }),
  )

  it.effect("loads arbitrary AISDK packages through the injected AISDK loader", () =>
    Effect.gen(function* () {
      const native = yield* ModelResolver.fromCatalogModel(
        model(Provider.aisdk("@ai-sdk/openai"), {
          settings: { baseURL: "https://openai.example/v1" },
        }),
      )
      const resolved = yield* ModelResolver.fromCatalogModel(
        model(Provider.aisdk("@ai-sdk/cohere"), {
          modelID: "cohere-api-model",
          settings: { project: "test" },
          headers: { "x-aisdk": "header" },
          body: { custom: true },
        }),
        Credential.Key.make({
          type: "key",
          key: "fallback-secret",
          configuration: { accountId: "account" },
        }),
        {
          loadAISDK: (runtime) =>
            Effect.sync(() => {
              expect(runtime).toMatchObject({
                id: "test-model",
                modelID: "cohere-api-model",
                providerID: "test-provider",
                package: Provider.aisdk("@ai-sdk/cohere"),
                settings: { project: "test", apiKey: "fallback-secret", accountId: "account" },
                headers: { "x-aisdk": "header" },
                body: { custom: true },
              })
              return LanguageModel.make({
                id: runtime.modelID ?? runtime.id,
                provider: runtime.providerID,
                route: native.route,
              })
            }),
        },
      )

      expect(resolved).toMatchObject({ id: "cohere-api-model", provider: "test-provider" })
    }),
  )

  it.effect("rejects unresolved variables before loading opaque AISDK packages", () =>
    withEnv({ REQUIRED_HOST: undefined }, () =>
      Effect.gen(function* () {
        const failure = yield* ModelResolver.fromCatalogModel(
          model(Provider.aisdk("@ai-sdk/cohere"), {
            settings: { baseURL: "https://${REQUIRED_HOST}/v1" },
          }),
          undefined,
          { loadAISDK: () => Effect.die("AI SDK loader should not be called") },
        ).pipe(Effect.flip)

        expect(failure).toMatchObject({
          _tag: "SessionRunnerModel.UnresolvedProviderVariablesError",
          variables: ["REQUIRED_HOST"],
        })
      }),
    ),
  )

  it.effect("rejects placeholders introduced by environment expansion before loading providers", () =>
    withEnv({ PROVIDER_HOST: "${MISSING_HOST}", MISSING_HOST: undefined }, () =>
      Effect.gen(function* () {
        const failure = yield* ModelResolver.fromCatalogModel(
          model(Provider.aisdk("@ai-sdk/cohere"), {
            settings: { baseURL: "https://${PROVIDER_HOST}/v1" },
          }),
          undefined,
          { loadAISDK: () => Effect.die("AI SDK loader should not be called") },
        ).pipe(Effect.flip)

        expect(failure).toMatchObject({
          _tag: "SessionRunnerModel.UnresolvedProviderVariablesError",
          variables: ["MISSING_HOST"],
        })
      }),
    ),
  )

  it.effect("rejects unresolved variables before loading native provider packages", () =>
    withEnv({ REQUIRED_HOST: undefined }, () =>
      Effect.gen(function* () {
        const failure = yield* ModelResolver.fromCatalogModel(
          model(Provider.aisdk("@ai-sdk/google"), {
            settings: { baseURL: "https://${REQUIRED_HOST}/v1" },
          }),
          undefined,
          { loadPackage: () => Effect.die("Native package loader should not be called") },
        ).pipe(Effect.flip)

        expect(failure).toMatchObject({
          _tag: "SessionRunnerModel.UnresolvedProviderVariablesError",
          variables: ["REQUIRED_HOST"],
        })
      }),
    ),
  )

  it.effect("rejects AISDK packages without an available loader", () =>
    Effect.gen(function* () {
      const failure = yield* ModelResolver.fromCatalogModel(
        model(Provider.aisdk("@ai-sdk/cohere"), {
          settings: { baseURL: "https://cohere.example/v1" },
        }),
      ).pipe(Effect.flip)

      expect(failure).toMatchObject({
        _tag: "SessionRunnerModel.UnsupportedPackageError",
        providerID: "test-provider",
        modelID: "test-model",
        package: "aisdk:@ai-sdk/cohere",
      })
      expect(failure.message).toBe("Unsupported package for test-provider/test-model: aisdk:@ai-sdk/cohere")
    }),
  )

  it.effect("reports provider configuration errors from supported packages", () =>
    Effect.gen(function* () {
      const failure = yield* ModelResolver.fromCatalogModel(
        model(Provider.aisdk("@ai-sdk/azure"), {
          providerID: Provider.ID.azure,
          modelID: "gpt-5.4-nano",
        }),
        Credential.OAuth.make({
          type: "oauth",
          methodID: Integration.MethodID.make("oauth"),
          access: "oauth-token",
          refresh: "refresh",
          expires: Date.now() + 60_000,
        }),
      ).pipe(Effect.flip)

      expect(failure).toMatchObject({
        _tag: "SessionRunnerModel.ModelConfigurationError",
        providerID: "azure",
        modelID: "test-model",
        package: "aisdk:@ai-sdk/azure",
        detail: "Azure requires resourceName or baseURL",
      })
      expect(failure.message).toBe("Cannot initialize azure/test-model: Azure requires resourceName or baseURL")
    }),
  )

  it.effect("distinguishes unexpected constructor failures from configuration errors", () =>
    Effect.gen(function* () {
      const failure = yield* ModelResolver.fromCatalogModel(model("@opencode/ai/providers/custom"), undefined, {
        loadPackage: () =>
          Effect.succeed({
            model: () => {
              throw new Error("custom provider crashed")
            },
          }),
      }).pipe(Effect.flip)

      expect(failure).toMatchObject({
        _tag: "SessionRunnerModel.ModelInitializationError",
        phase: "construct",
        detail: "custom provider crashed",
      })
    }),
  )

  it.effect("reports package load and AISDK initialization failures with their causes", () =>
    Effect.gen(function* () {
      const load = yield* ModelResolver.fromCatalogModel(model("@opencode/ai/providers/custom"), undefined, {
        loadPackage: (specifier) =>
          Effect.fail(
            new Provider.LoadError({ package: specifier, cause: new Error(`Provider package ${specifier} is broken`) }),
          ),
      }).pipe(Effect.flip)
      expect(load).toMatchObject({
        _tag: "SessionRunnerModel.ModelInitializationError",
        phase: "load",
        detail: "Provider package @opencode/ai/providers/custom is broken",
      })

      const init = yield* ModelResolver.fromCatalogModel(model(Provider.aisdk("@ai-sdk/cohere")), undefined, {
        loadAISDK: (runtime) =>
          Effect.fail(
            new AISDK.InitError({ providerID: runtime.providerID, cause: new Error("Cohere plugin failed") }),
          ),
      }).pipe(Effect.flip)
      expect(init).toMatchObject({
        _tag: "SessionRunnerModel.ModelInitializationError",
        phase: "init",
        detail: "Cohere plugin failed",
      })
      expect(init.message).toBe("Cannot initialize test-provider/test-model: Cohere plugin failed")
    }),
  )

  it.effect("drops an empty API key before loading an AISDK package", () =>
    Effect.gen(function* () {
      const native = yield* ModelResolver.fromCatalogModel(
        model(Provider.aisdk("@ai-sdk/openai"), {
          settings: { baseURL: "https://openai.example/v1" },
        }),
      )
      yield* ModelResolver.fromCatalogModel(
        model(Provider.aisdk("@ai-sdk/cohere"), {
          settings: { apiKey: "", baseURL: "https://cohere.example/v1" },
        }),
        undefined,
        {
          loadAISDK: (runtime) =>
            Effect.sync(() => {
              expect(runtime.settings).not.toHaveProperty("apiKey")
              return native
            }),
        },
      )
    }),
  )

  it.effect("reports whether a catalog model declares a provider package", () =>
    Effect.sync(() => {
      expect(ModelResolver.hasPackage(model(Provider.aisdk("@ai-sdk/openai")))).toBe(true)
      expect(ModelResolver.hasPackage(model("@opencode/ai/providers/custom"))).toBe(true)
      expect(ModelResolver.hasPackage(model(undefined))).toBe(false)
    }),
  )
})
