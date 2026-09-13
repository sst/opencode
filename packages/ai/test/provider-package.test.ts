import { describe, expect, test } from "bun:test"
import { model } from "@opencode/ai/providers/openai"
import { LLM } from "../src/index.js"
import { Endpoint } from "../src/route/endpoint.js"

const configuration = (provider: string, message: string) =>
  expect.objectContaining({ _tag: "ProviderConfiguration", provider, message })

describe("provider package entrypoints", () => {
  test("semantic API aliases expose the same contract", async () => {
    const modules = await Promise.all([
      import("@opencode/ai/providers/openai"),
      import("@opencode/ai/providers/openai/responses"),
      import("@opencode/ai/providers/openai/chat"),
      import("@opencode/ai/providers/anthropic"),
      import("@opencode/ai/providers/anthropic-compatible"),
      import("@opencode/ai/providers/openai-compatible"),
      import("@opencode/ai/providers/openai-compatible/responses"),
      import("@opencode/ai/providers/amazon-bedrock"),
      import("@opencode/ai/providers/azure"),
      import("@opencode/ai/providers/azure/responses"),
      import("@opencode/ai/providers/azure/chat"),
      import("@opencode/ai/providers/google"),
      import("@opencode/ai/providers/google-vertex"),
      import("@opencode/ai/providers/google-vertex/gemini"),
      import("@opencode/ai/providers/google-vertex/chat"),
      import("@opencode/ai/providers/google-vertex/responses"),
      import("@opencode/ai/providers/google-vertex/messages"),
      import("@opencode/ai/providers/openrouter"),
      import("@opencode/ai/providers/xai"),
      import("@opencode/ai/providers/amazon-bedrock/mantle"),
      import("@opencode/ai/providers/amazon-bedrock/mantle/chat"),
      import("@opencode/ai/providers/amazon-bedrock/mantle/responses"),
      import("@opencode/ai/providers/togetherai"),
      import("@opencode/ai/providers/cerebras"),
      import("@opencode/ai/providers/deepinfra"),
      import("@opencode/ai/providers/groq"),
      import("@opencode/ai/providers/baseten"),
      import("@opencode/ai/providers/deepseek"),
      import("@opencode/ai/providers/fireworks"),
      import("@opencode/ai/providers/cloudflare-ai-gateway"),
      import("@opencode/ai/providers/cloudflare-workers-ai"),
      import("@opencode/ai/providers/minimax"),
      import("@opencode/ai/providers/minimax/messages"),
      import("@opencode/ai/providers/minimax/chat"),
      import("@opencode/ai/providers/minimax/responses"),
      import("@opencode/ai/providers/moonshot"),
      import("@opencode/ai/providers/moonshot/chat"),
      import("@opencode/ai/providers/moonshot/messages"),
      import("@opencode/ai/providers/moonshot/responses"),
      import("@opencode/ai/providers/zai"),
      import("@opencode/ai/providers/zai/chat"),
      import("@opencode/ai/providers/zai-coding-plan"),
      import("@opencode/ai/providers/zai-coding-plan/chat"),
      import("@opencode/ai/providers/zai-coding-plan/messages"),
      import("@opencode/ai/providers/zai-coding-plan/responses"),
      import("@opencode/ai/providers/alibaba"),
      import("@opencode/ai/providers/alibaba/chat"),
      import("@opencode/ai/providers/alibaba/messages"),
      import("@opencode/ai/providers/alibaba/responses"),
    ])

    for (const module of modules) expect(module.model).toBeFunction()
    expect(modules[0].model).toBe(modules[1].model)
    expect(modules[8].model).toBe(modules[9].model)
    expect(modules[12].model).toBe(modules[13].model)
    expect(modules[19].model).toBe(modules[21].model)
    expect(modules[19].model).not.toBe(modules[20].model)
  })

  test("maps Alibaba API entrypoints onto explicit regional routes", async () => {
    const modules = await Promise.all([
      import("@opencode/ai/providers/alibaba"),
      import("@opencode/ai/providers/alibaba/chat"),
      import("@opencode/ai/providers/alibaba/messages"),
      import("@opencode/ai/providers/alibaba/responses"),
    ])
    expect(modules[0].model).toBe(modules[1].model)
    const settings = {
      region: "eu-central-1",
      workspaceID: "llm-fixture",
      apiKey: "fixture",
      headers: { "x-test": "fixture" },
      body: { extension: true },
    }
    const routes = ["alibaba-chat", "alibaba-chat", "alibaba-messages", "alibaba-responses"]
    modules.forEach((module, index) => {
      const model = module.model("qwen3.8-max", settings)
      expect(model.provider).toBe("alibaba")
      expect(model.route.id).toBe(routes[index])
      expect(model.route.endpoint.baseURL).toBe(
        `https://llm-fixture.eu-central-1.maas.aliyuncs.com/${index === 2 ? "apps/anthropic/v1" : "compatible-mode/v1"}`,
      )
      expect(model.route.defaults.headers).toEqual(settings.headers)
      expect(model.route.defaults.http?.body).toEqual(settings.body)
    })
  })

  test("maps Moonshot API entrypoints onto provider-owned routes", async () => {
    const modules = await Promise.all([
      import("@opencode/ai/providers/moonshot"),
      import("@opencode/ai/providers/moonshot/chat"),
      import("@opencode/ai/providers/moonshot/messages"),
      import("@opencode/ai/providers/moonshot/responses"),
    ])
    expect(modules[0].model).toBe(modules[1].model)
    const settings = {
      apiKey: "fixture",
      baseURL: "https://gateway.example/v1",
      headers: { "x-application": "fixture" },
      body: { future_option: true },
    }
    const routes = ["moonshot-chat", "moonshot-chat", "moonshot-messages", "moonshot-responses"]
    modules.forEach((module, index) => {
      const selected = module.model("kimi-k3", settings)
      expect(selected.provider).toBe("moonshotai")
      expect(selected.route.id).toBe(routes[index])
      expect(selected.route.endpoint.baseURL).toBe(settings.baseURL)
      expect(selected.route.defaults.headers).toEqual(settings.headers)
      expect(selected.route.defaults.http?.body).toEqual(settings.body)
    })
  })

  test("maps MiniMax API entrypoints onto provider-owned routes", async () => {
    const modules = await Promise.all([
      import("@opencode/ai/providers/minimax"),
      import("@opencode/ai/providers/minimax/messages"),
      import("@opencode/ai/providers/minimax/chat"),
      import("@opencode/ai/providers/minimax/responses"),
    ])
    expect(modules[0].model).toBe(modules[1].model)
    const settings = {
      apiKey: "fixture",
      baseURL: "https://gateway.example/v1",
      headers: { "x-application": "opencode" },
      body: { service_tier: "priority" },
    }
    const routes = ["minimax-messages", "minimax-messages", "minimax-chat", "minimax-responses"]
    modules.forEach((module, index) => {
      const selected = module.model("MiniMax-M3", settings)
      expect(selected.provider).toBe("minimax")
      expect(selected.route.id).toBe(routes[index])
      expect(selected.route.endpoint.baseURL).toBe(settings.baseURL)
      expect(selected.route.defaults.headers).toEqual(settings.headers)
      expect(selected.route.defaults.http?.body).toEqual(settings.body)
    })
  })

  test("maps ZAI and Coding Plan entrypoints onto distinct provider-owned routes", async () => {
    const modules = await Promise.all([
      import("@opencode/ai/providers/zai"),
      import("@opencode/ai/providers/zai/chat"),
      import("@opencode/ai/providers/zai-coding-plan"),
      import("@opencode/ai/providers/zai-coding-plan/chat"),
      import("@opencode/ai/providers/zai-coding-plan/messages"),
      import("@opencode/ai/providers/zai-coding-plan/responses"),
    ])
    expect(modules[0].model).toBe(modules[1].model)
    expect(modules[2].model).toBe(modules[3].model)
    const routes = [
      "zai-chat",
      "zai-chat",
      "zai-coding-chat",
      "zai-coding-chat",
      "zai-coding-messages",
      "zai-coding-responses",
    ]
    const settings = {
      apiKey: "fixture",
      baseURL: "https://gateway.example/custom",
      headers: { "x-test": "fixture" },
      body: { extension: true },
    }
    modules.forEach((module, index) => {
      const selected = module.model("glm-5.3", settings)
      expect(selected.provider).toBe(index < 2 ? "zai" : "zai-coding-plan")
      expect(selected.route.id).toBe(routes[index])
      expect(selected.route.endpoint.baseURL).toBe(settings.baseURL)
      expect(selected.route.defaults.headers).toEqual(settings.headers)
      expect(selected.route.defaults.http?.body).toEqual(settings.body)
    })
  })

  test("maps DeepInfra package settings onto its native executable model", async () => {
    const DeepInfra = await import("@opencode/ai/providers/deepinfra")
    const settings = {
      apiKey: "fixture",
      baseURL: "https://provider.example.test/v1/",
      headers: { "x-application": "opencode" },
      body: { service_tier: "priority" },
      reasoningEffort: "high" as const,
    }
    const deepinfra = DeepInfra.model("google/gemma-3-27b-it", settings)

    expect(deepinfra.route.id).toBe("deepinfra-chat")
    expect(deepinfra.route.endpoint.baseURL).toBe("https://provider.example.test/v1/openai")
    expect(deepinfra.route.defaults.providerOptions).toEqual({ reasoningEffort: "high" })
    expect(deepinfra.route.defaults.headers).toEqual(settings.headers)
    expect(deepinfra.route.defaults.http?.body).toEqual(settings.body)
  })

  test("maps Cloudflare package settings onto provider-owned models", async () => {
    const modules = await Promise.all([
      import("@opencode/ai/providers/cloudflare-ai-gateway"),
      import("@opencode/ai/providers/cloudflare-workers-ai"),
    ])
    for (const provider of modules) {
      const selected = provider.model("provider-model", {
        accountId: "account",
        apiKey: "fixture",
        headers: { "x-application": "opencode" },
        body: { custom: true },
        reasoningEffort: "high",
      })
      expect(selected.provider).toBe(provider.id)
      expect(selected.route.endpoint.baseURL).toBe(provider.baseURL({ accountId: "account" }))
      expect(selected.route.defaults.headers).toEqual({ "x-application": "opencode" })
      expect(selected.route.defaults.http?.body).toEqual({ custom: true })
      expect(selected.route.defaults.providerOptions).toEqual({ reasoningEffort: "high" })
    }
  })

  test("maps OpenRouter and xAI package settings onto executable models", async () => {
    const OpenRouter = await import("@opencode/ai/providers/openrouter")
    const XAI = await import("@opencode/ai/providers/xai")
    const settings = {
      apiKey: "fixture",
      baseURL: "https://provider.example.test/v1",
      headers: { "x-application": "opencode" },
      body: { service_tier: "priority" },
    }
    const openrouter = OpenRouter.model("anthropic/claude-sonnet-4", {
      ...settings,
      usage: true,
    })
    const xai = XAI.model("grok-4", {
      ...settings,
      reasoningEffort: "high",
    })

    for (const selected of [openrouter, xai]) {
      expect(selected.route.endpoint.baseURL).toBe(settings.baseURL)
      expect(selected.route.defaults.headers).toEqual(settings.headers)
      expect(selected.route.defaults.http?.body).toEqual(settings.body)
    }
    expect(openrouter.route.defaults.providerOptions).toEqual({ usage: true })
    expect(xai.route.defaults.providerOptions).toMatchObject({ reasoningEffort: "high", store: false })
  })

  test("maps package settings onto the executable model", () => {
    const selected = model("gpt-5", {
      apiKey: "fixture",
      baseURL: "https://api.openai.test/v1",
      headers: { "x-application": "opencode" },
      body: { service_tier: "priority" },
      unrelatedInheritedSetting: true,
    })

    expect(selected.route.id).toBe("openai-responses")
    expect(selected.route.defaults.headers).toEqual({ "x-application": "opencode" })
    expect(selected.route.defaults.http?.body).toEqual({ service_tier: "priority" })
  })

  test("maps OpenAI-compatible Responses settings onto the executable model", async () => {
    const OpenAICompatibleResponses = await import("@opencode/ai/providers/openai-compatible/responses")
    const selected = OpenAICompatibleResponses.model("custom-model", {
      apiKey: "fixture",
      baseURL: "https://responses.example.test/v1",
      provider: "example",
      headers: { "x-application": "opencode" },
      body: { service_tier: "priority" },
      reasoningEffort: "low",
      store: true,
    })

    expect(String(selected.provider)).toBe("example")
    expect(selected.route.id).toBe("openai-compatible-responses")
    expect(selected.route.endpoint).toMatchObject({
      baseURL: "https://responses.example.test/v1",
      path: "/responses",
    })
    expect(selected.route.defaults.headers).toEqual({ "x-application": "opencode" })
    expect(selected.route.defaults.http?.body).toEqual({ service_tier: "priority" })
    expect(selected.route.defaults.providerOptions).toEqual({
      reasoningEffort: "low",
      store: true,
      include: ["reasoning.encrypted_content"],
    })
  })

  test("maps Anthropic-compatible settings onto the executable model", async () => {
    const AnthropicCompatible = await import("@opencode/ai/providers/anthropic-compatible")
    const selected = AnthropicCompatible.model("compatible-model", {
      apiKey: "fixture",
      baseURL: "https://messages.example.test/v1",
      provider: "example",
      headers: { "x-application": "opencode" },
      body: { metadata: { user_id: "user_1" } },
      effort: "low",
    })

    expect(String(selected.provider)).toBe("example")
    expect(selected.route.id).toBe("anthropic-messages")
    expect(selected.route.endpoint).toMatchObject({
      baseURL: "https://messages.example.test/v1",
    })
    expect(
      Endpoint.render(selected.route.endpoint, { request: LLM.request({ model: selected }), body: {} }).toString(),
    ).toBe("https://messages.example.test/v1/messages")
    expect(selected.route.defaults.headers).toEqual({ "x-application": "opencode" })
    expect(selected.route.defaults.http?.body).toEqual({ metadata: { user_id: "user_1" } })
    expect(selected.route.defaults.providerOptions).toEqual({ effort: "low" })
  })

  test("maps Anthropic provider options onto the executable model", async () => {
    const Anthropic = await import("@opencode/ai/providers/anthropic")
    const selected = Anthropic.model("claude-sonnet-4-6", {
      apiKey: "fixture",
      thinking: { type: "adaptive" },
    })

    expect(selected.route.defaults.providerOptions).toEqual({ thinking: { type: "adaptive" } })
  })

  test("requires an Anthropic-compatible base URL at runtime", async () => {
    const AnthropicCompatible = await import("@opencode/ai/providers/anthropic-compatible")
    expect(() =>
      Reflect.apply(AnthropicCompatible.model, undefined, ["compatible-model", { apiKey: "fixture" }]),
    ).toThrow(configuration("anthropic-compatible", "Anthropic-compatible providers require a baseURL"))
  })

  test("rejects conflicting Anthropic-compatible auth settings at runtime", async () => {
    const Anthropic = await import("@opencode/ai/providers/anthropic")
    const AnthropicCompatible = await import("@opencode/ai/providers/anthropic-compatible")
    expect(() =>
      Reflect.apply(AnthropicCompatible.model, undefined, [
        "compatible-model",
        {
          apiKey: "fixture",
          authToken: "token",
          baseURL: "https://messages.example.test/v1",
        },
      ]),
    ).toThrow(configuration("anthropic-compatible", "Anthropic-compatible apiKey cannot be combined with authToken"))
    expect(() =>
      Reflect.apply(Anthropic.model, undefined, ["claude-sonnet-4-6", { apiKey: "fixture", authToken: "token" }]),
    ).toThrow(configuration("anthropic", "Anthropic apiKey cannot be combined with authToken"))
  })

  test("maps legacy OpenAI organization and project settings to headers", () => {
    const selected = model("gpt-5", {
      apiKey: "fixture",
      organization: "org_123",
      project: "proj_123",
    })

    expect(selected.route.defaults.headers).toMatchObject({
      "OpenAI-Organization": "org_123",
      "OpenAI-Project": "proj_123",
    })
  })

  test("selects Azure API entrypoints with the same model contract", async () => {
    const Azure = await import("@opencode/ai/providers/azure")
    const AzureChat = await import("@opencode/ai/providers/azure/chat")
    const AzureResponses = await import("@opencode/ai/providers/azure/responses")
    const settings = {
      apiKey: "fixture",
      resourceName: "opencode-test",
      headers: { "x-application": "opencode" },
      body: { service_tier: "priority" },
    }

    const responses = AzureResponses.model("deployment", settings)
    const chat = AzureChat.model("deployment", settings)

    expect(Azure.model("deployment", settings).route.id).toBe("azure-openai-responses")
    expect(responses.route.id).toBe("azure-openai-responses")
    expect(responses.route.endpoint.baseURL).toBe("https://opencode-test.openai.azure.com/openai/v1")
    expect(responses.route.defaults.headers).toEqual({ "x-application": "opencode" })
    expect(responses.route.defaults.http?.body).toEqual({ service_tier: "priority" })
    expect(chat.route.id).toBe("azure-openai-chat")
  })

  test("constructs Azure deployment URLs and preserves custom gateway URLs", async () => {
    const Azure = await import("@opencode/ai/providers/azure")
    const deployment = Azure.model("custom-deployment", {
      apiKey: "fixture",
      resourceName: "opencode-test",
      apiVersion: "2025-01-01-preview",
      useDeploymentBasedUrls: true,
    })
    const gateway = Azure.model("gateway-model", {
      apiKey: "fixture",
      baseURL: "https://gateway.example/azure/",
    })

    expect(deployment.route.endpoint).toMatchObject({
      baseURL: "https://opencode-test.openai.azure.com/openai/deployments/custom-deployment",
      query: { "api-version": "2025-01-01-preview" },
    })
    expect(gateway.route.endpoint.baseURL).toBe("https://gateway.example/azure")
    expect(gateway.route.endpoint.query).toBeUndefined()
  })

  test("maps Google package settings onto the Gemini model", async () => {
    const Google = await import("@opencode/ai/providers/google")
    const selected = Google.model("gemini-2.5-flash", {
      apiKey: "fixture",
      baseURL: "https://generativelanguage.test/v1beta",
      headers: { "x-application": "opencode" },
      body: { safetySettings: [] },
      thinkingConfig: { thinkingBudget: 1_024 },
    })

    expect(selected.route.id).toBe("gemini")
    expect(selected.route.endpoint.baseURL).toBe("https://generativelanguage.test/v1beta")
    expect(selected.route.defaults.headers).toEqual({ "x-application": "opencode" })
    expect(selected.route.defaults.http?.body).toEqual({ safetySettings: [] })
    expect(selected.route.defaults.providerOptions).toEqual({ thinkingConfig: { thinkingBudget: 1_024 } })
  })

  test("selects Vertex entrypoints with the same model contract", async () => {
    const GoogleVertex = await import("@opencode/ai/providers/google-vertex")
    const GoogleVertexGemini = await import("@opencode/ai/providers/google-vertex/gemini")
    const GoogleVertexChat = await import("@opencode/ai/providers/google-vertex/chat")
    const GoogleVertexResponses = await import("@opencode/ai/providers/google-vertex/responses")
    const GoogleVertexMessages = await import("@opencode/ai/providers/google-vertex/messages")
    const gemini = GoogleVertex.model("gemini-3.5-flash", {
      apiKey: "fixture",
      headers: { "x-application": "opencode" },
      body: { safetySettings: [] },
    })
    const messages = GoogleVertexMessages.model("claude-sonnet-4-6", {
      accessToken: "fixture",
      location: "global",
      project: "vertex-project",
    })
    const chat = GoogleVertexChat.model("deepseek-ai/deepseek-v3.2-maas", {
      accessToken: "fixture",
      location: "global",
      project: "vertex-project",
    })
    const responses = GoogleVertexResponses.model("xai/grok-4.20-reasoning", {
      accessToken: "fixture",
      location: "global",
      project: "vertex-project",
    })

    expect(GoogleVertexGemini.model).toBe(GoogleVertex.model)
    expect(gemini.route.id).toBe("google-vertex-gemini")
    expect(gemini.route.protocol).toBe("gemini")
    expect(gemini.route.endpoint.baseURL).toBe("https://aiplatform.googleapis.com/v1/publishers/google")
    expect(gemini.route.defaults.headers).toEqual({ "x-application": "opencode" })
    expect(gemini.route.defaults.http?.body).toEqual({ safetySettings: [] })
    expect(
      GoogleVertex.model("gemini-3.5-flash", {
        accessToken: "fixture",
        location: "eu",
        project: "vertex-project",
      }).route.endpoint.baseURL,
    ).toBe("https://aiplatform.eu.rep.googleapis.com/v1beta1/projects/vertex-project/locations/eu/publishers/google")
    expect(messages.route.id).toBe("google-vertex-messages")
    expect(messages.route.protocol).toBe("anthropic-messages")
    expect(messages.route.endpoint.baseURL).toBe(
      "https://aiplatform.googleapis.com/v1/projects/vertex-project/locations/global/publishers/anthropic/models",
    )
    expect(chat.route.id).toBe("google-vertex-chat")
    expect(chat.route.protocol).toBe("openai-chat")
    expect(chat.route.endpoint).toMatchObject({
      baseURL: "https://aiplatform.googleapis.com/v1/projects/vertex-project/locations/global/endpoints/openapi",
      path: "/chat/completions",
    })
    expect(responses.route.id).toBe("google-vertex-responses")
    expect(responses.route.protocol).toBe("open-responses")
    expect(responses.route.endpoint).toMatchObject({
      baseURL: "https://aiplatform.googleapis.com/v1/projects/vertex-project/locations/global/endpoints/openapi",
      path: "/responses",
    })
    expect(responses.route.defaults.providerOptions).toEqual({
      store: false,
      include: ["reasoning.encrypted_content"],
    })
  })

  test("rejects conflicting Vertex auth settings at runtime", async () => {
    const GoogleVertex = await import("@opencode/ai/providers/google-vertex")
    const GoogleVertexChat = await import("@opencode/ai/providers/google-vertex/chat")
    const GoogleVertexMessages = await import("@opencode/ai/providers/google-vertex/messages")
    const GoogleVertexResponses = await import("@opencode/ai/providers/google-vertex/responses")
    const Providers = await import("@opencode/ai/providers")
    expect(() =>
      Reflect.apply(GoogleVertex.model, undefined, [
        "gemini-3.5-flash",
        { accessToken: "token", apiKey: "fixture", project: "vertex-project" },
      ]),
    ).toThrow(configuration("google-vertex", "Google Vertex apiKey cannot be combined with accessToken or auth"))
    const configured = Reflect.apply(GoogleVertex.configure, undefined, [
      { accessToken: "token", auth: {}, project: "vertex-project" },
    ])
    expect(() => configured.model("gemini-3.5-flash")).toThrow(
      configuration("google-vertex", "Google Vertex accessToken cannot be combined with auth"),
    )
    expect(() =>
      Reflect.apply(GoogleVertexMessages.model, undefined, [
        "claude-sonnet-4-6",
        { apiKey: "fixture", project: "vertex-project" },
      ]),
    ).toThrow(configuration("google-vertex", "Google Vertex Messages does not support API keys"))
    expect(() =>
      Reflect.apply(Providers.GoogleVertexMessages.configure, undefined, [
        { apiKey: "fixture", project: "vertex-project" },
      ]),
    ).toThrow(configuration("google-vertex", "Google Vertex Messages does not support API keys"))
    expect(() =>
      Reflect.apply(GoogleVertexChat.model, undefined, [
        "deepseek-ai/deepseek-v3.2-maas",
        { apiKey: "fixture", project: "vertex-project" },
      ]),
    ).toThrow(configuration("google-vertex", "Google Vertex Chat does not support API keys"))
    expect(() =>
      Reflect.apply(Providers.GoogleVertexChat.configure, undefined, [
        { apiKey: "fixture", project: "vertex-project" },
      ]),
    ).toThrow(configuration("google-vertex", "Google Vertex Chat does not support API keys"))
    expect(() =>
      Reflect.apply(GoogleVertexResponses.model, undefined, [
        "xai/grok-4.20-reasoning",
        { apiKey: "fixture", project: "vertex-project" },
      ]),
    ).toThrow(configuration("google-vertex", "Google Vertex Responses does not support API keys"))
    expect(() =>
      Reflect.apply(Providers.GoogleVertexResponses.configure, undefined, [
        { apiKey: "fixture", project: "vertex-project" },
      ]),
    ).toThrow(configuration("google-vertex", "Google Vertex Responses does not support API keys"))
  })
})
