import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { ProviderTransform } from "@/provider/transform"
import { LLMRequestPrep } from "@/session/llm/request"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { ModelsDev } from "@opencode-ai/core/models-dev"
import { generateText, jsonSchema, type ModelMessage } from "ai"
import { createAmazonBedrock, type AmazonBedrockLanguageModelOptions } from "@ai-sdk/amazon-bedrock"
import { createAnthropic } from "@ai-sdk/anthropic"
import { createVertexAnthropic } from "@ai-sdk/google-vertex/anthropic"

describe("ProviderTransform.options - setCacheKey", () => {
  const sessionID = "test-session-123"

  const mockModel = {
    id: "anthropic/claude-3-5-sonnet",
    providerID: "anthropic",
    api: {
      id: "claude-3-5-sonnet-20241022",
      url: "https://api.anthropic.com",
      npm: "@ai-sdk/anthropic",
    },
    name: "Claude 3.5 Sonnet",
    capabilities: {
      temperature: true,
      reasoning: false,
      attachment: true,
      toolcall: true,
      input: { text: true, audio: false, image: true, video: false, pdf: true },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    cost: {
      input: 0.003,
      output: 0.015,
      cache: { read: 0.0003, write: 0.00375 },
    },
    limit: {
      context: 200000,
      output: 8192,
    },
    status: "active",
    options: {},
    headers: {},
  } as any

  test("should set promptCacheKey when providerOptions.setCacheKey is true", () => {
    const result = ProviderTransform.options({
      model: mockModel,
      sessionID,
      providerOptions: { setCacheKey: true },
    })
    expect(result.promptCacheKey).toBe(sessionID)
  })

  test("should not set promptCacheKey when providerOptions.setCacheKey is false", () => {
    const result = ProviderTransform.options({
      model: mockModel,
      sessionID,
      providerOptions: { setCacheKey: false },
    })
    expect(result.promptCacheKey).toBeUndefined()
  })

  test("should not set promptCacheKey when providerOptions is undefined", () => {
    const result = ProviderTransform.options({
      model: mockModel,
      sessionID,
      providerOptions: undefined,
    })
    expect(result.promptCacheKey).toBeUndefined()
  })

  test("should not set promptCacheKey when providerOptions does not have setCacheKey", () => {
    const result = ProviderTransform.options({ model: mockModel, sessionID, providerOptions: {} })
    expect(result.promptCacheKey).toBeUndefined()
  })

  test("should set promptCacheKey for openai provider by default", () => {
    const openaiModel = {
      ...mockModel,
      providerID: "openai",
      api: {
        id: "gpt-4",
        url: "https://api.openai.com",
        npm: "@ai-sdk/openai",
      },
    }
    const result = ProviderTransform.options({ model: openaiModel, sessionID, providerOptions: {} })
    expect(result.promptCacheKey).toBe(sessionID)
  })

  test("should set promptCacheKey for the OpenAI SDK regardless of provider ID", () => {
    const result = ProviderTransform.options({
      model: {
        ...mockModel,
        providerID: "custom-openai",
        api: { id: "gpt-5", url: "https://example.com", npm: "@ai-sdk/openai" },
      },
      sessionID,
      providerOptions: {},
    })
    expect(result.promptCacheKey).toBe(sessionID)
  })

  test("should not set promptCacheKey for the OpenAI-compatible SDK by provider name", () => {
    const result = ProviderTransform.options({
      model: {
        ...mockModel,
        providerID: "openai",
        api: { id: "gpt-5", url: "https://example.com", npm: "@ai-sdk/openai-compatible" },
      },
      sessionID,
      providerOptions: {},
    })
    expect(result.promptCacheKey).toBeUndefined()
  })

  test("should not set promptCacheKey for openai when explicitly disabled", () => {
    const openaiModel = {
      ...mockModel,
      providerID: "openai",
      api: {
        id: "gpt-4",
        url: "https://api.openai.com",
        npm: "@ai-sdk/openai",
      },
    }
    const result = ProviderTransform.options({
      model: openaiModel,
      sessionID,
      providerOptions: { setCacheKey: false },
    })
    expect(result.promptCacheKey).toBeUndefined()
  })

  test("should set promptCacheKey for the xAI SDK by default regardless of provider ID", () => {
    const xaiModel = {
      ...mockModel,
      providerID: "custom-xai",
      api: {
        id: "grok-4",
        url: "https://api.x.ai",
        npm: "@ai-sdk/xai",
      },
    }
    const result = ProviderTransform.options({ model: xaiModel, sessionID, providerOptions: {} })
    expect(result.promptCacheKey).toBe(sessionID)
  })

  test("should not set promptCacheKey for the xAI SDK when explicitly disabled", () => {
    const xaiModel = {
      ...mockModel,
      providerID: "xai",
      api: {
        id: "grok-4",
        url: "https://api.x.ai",
        npm: "@ai-sdk/xai",
      },
    }
    const result = ProviderTransform.options({
      model: xaiModel,
      sessionID,
      providerOptions: { setCacheKey: false },
    })
    expect(result.promptCacheKey).toBeUndefined()
  })

  test("should set store=false for openai provider", () => {
    const openaiModel = {
      ...mockModel,
      providerID: "openai",
      api: {
        id: "gpt-4",
        url: "https://api.openai.com",
        npm: "@ai-sdk/openai",
      },
    }
    const result = ProviderTransform.options({
      model: openaiModel,
      sessionID,
      providerOptions: {},
    })
    expect(result.store).toBe(false)
  })

  test("should set store=false for xAI provider by default", () => {
    const xaiModel = {
      ...mockModel,
      providerID: "xai",
      api: {
        id: "grok-4",
        url: "https://api.x.ai",
        npm: "@ai-sdk/xai",
      },
    }
    const result = ProviderTransform.options({
      model: xaiModel,
      sessionID,
      providerOptions: {},
    })
    expect(result.store).toBe(false)
    expect(result.promptCacheKey).toBe(sessionID)
  })

  test("should set store=false for xAI SDK regardless of provider ID", () => {
    const xaiModel = {
      ...mockModel,
      providerID: "custom-xai",
      api: {
        id: "grok-4",
        url: "https://api.x.ai",
        npm: "@ai-sdk/xai",
      },
    }
    const result = ProviderTransform.options({
      model: xaiModel,
      sessionID,
      providerOptions: {},
    })
    expect(result.store).toBe(false)
  })

  test("should set store=false for azure provider by default", () => {
    const azureModel = {
      ...mockModel,
      providerID: "azure",
      api: {
        id: "gpt-4",
        url: "https://azure.com",
        npm: "@ai-sdk/azure",
      },
    }
    const result = ProviderTransform.options({
      model: azureModel,
      sessionID,
      providerOptions: {},
    })
    expect(result.store).toBe(false)
    expect(result.promptCacheKey).toBe(sessionID)
  })

  test("should disable the Azure cache key without disabling store=false", () => {
    const result = ProviderTransform.options({
      model: {
        ...mockModel,
        providerID: "azure",
        api: { id: "gpt-5", url: "https://azure.com", npm: "@ai-sdk/azure" },
      },
      sessionID,
      providerOptions: { setCacheKey: false },
    })
    expect(result.store).toBe(false)
    expect(result.promptCacheKey).toBeUndefined()
  })

  test("should keep the Azure cache key for gpt-5.5 early return", () => {
    const result = ProviderTransform.options({
      model: {
        ...mockModel,
        providerID: "azure",
        api: { id: "gpt-5.5", url: "https://azure.com", npm: "@ai-sdk/azure" },
      },
      sessionID,
      providerOptions: {},
    })
    expect(result.store).toBe(false)
    expect(result.reasoningSummary).toBe("auto")
    expect(result.promptCacheKey).toBe(sessionID)
  })

  for (const npm of ["@ai-sdk/deepinfra", "@ai-sdk/cerebras"]) {
    test(`should set the snake-case cache key for ${npm}`, () => {
      const result = ProviderTransform.options({
        model: { ...mockModel, providerID: "custom", api: { ...mockModel.api, npm } },
        sessionID,
        providerOptions: {},
      })
      expect(result.prompt_cache_key).toBe(sessionID)
      expect(result.promptCacheKey).toBeUndefined()
    })
  }

  test("should set promptCacheKey for the Mistral SDK", () => {
    const result = ProviderTransform.options({
      model: { ...mockModel, providerID: "custom", api: { ...mockModel.api, npm: "@ai-sdk/mistral" } },
      sessionID,
      providerOptions: {},
    })
    expect(result.promptCacheKey).toBe(sessionID)
  })

  test("should not send an undocumented OpenRouter prompt_cache_key", () => {
    const result = ProviderTransform.options({
      model: {
        ...mockModel,
        providerID: "openrouter",
        api: { ...mockModel.api, npm: "@openrouter/ai-sdk-provider" },
      },
      sessionID,
      providerOptions: {},
    })
    expect(result.prompt_cache_key).toBeUndefined()
  })
})

describe("ProviderTransform.options - zai/zhipuai thinking", () => {
  const sessionID = "test-session-123"

  const createModel = (providerID: string) =>
    ({
      id: `${providerID}/glm-4.6`,
      providerID,
      api: {
        id: "glm-4.6",
        url: "https://open.bigmodel.cn/api/paas/v4",
        npm: "@ai-sdk/openai-compatible",
      },
      name: "GLM 4.6",
      capabilities: {
        temperature: true,
        reasoning: true,
        attachment: true,
        toolcall: true,
        input: { text: true, audio: false, image: true, video: false, pdf: true },
        output: { text: true, audio: false, image: false, video: false, pdf: false },
        interleaved: false,
      },
      cost: {
        input: 0.001,
        output: 0.002,
        cache: { read: 0.0001, write: 0.0002 },
      },
      limit: {
        context: 128000,
        output: 8192,
      },
      status: "active",
      options: {},
      headers: {},
    }) as any

  for (const providerID of ["zai-coding-plan", "zai", "zhipuai-coding-plan", "zhipuai"]) {
    test(`${providerID} should set thinking cfg`, () => {
      const result = ProviderTransform.options({
        model: createModel(providerID),
        sessionID,
        providerOptions: {},
      })

      expect(result.thinking).toEqual({
        type: "enabled",
        clear_thinking: false,
      })
    })
  }
})

describe("ProviderTransform.options - minimax m3 thinking", () => {
  const createModel = (npm: string) =>
    ({
      id: "minimax/minimax-m3",
      providerID: "minimax",
      api: {
        id: "minimax-m3",
        url: "https://api.minimax.com",
        npm,
      },
      capabilities: { reasoning: true },
      limit: { output: 64_000 },
    }) as any

  test("explicitly enables adaptive thinking with the anthropic SDK", () => {
    expect(
      ProviderTransform.options({
        model: createModel("@ai-sdk/anthropic"),
        sessionID: "test-session-123",
      }).thinking,
    ).toEqual({ type: "adaptive" })
  })

  test("uses the native default with the openai-compatible SDK", () => {
    expect(
      ProviderTransform.options({
        model: createModel("@ai-sdk/openai-compatible"),
        sessionID: "test-session-123",
      }).thinking,
    ).toBeUndefined()
  })
})

describe("ProviderTransform.options - google thinkingConfig gating", () => {
  const sessionID = "test-session-123"

  const createGoogleModel = (reasoning: boolean, npm: "@ai-sdk/google" | "@ai-sdk/google-vertex") =>
    ({
      id: `${npm === "@ai-sdk/google" ? "google" : "google-vertex"}/gemini-2.0-flash`,
      providerID: npm === "@ai-sdk/google" ? "google" : "google-vertex",
      api: {
        id: "gemini-2.0-flash",
        url: npm === "@ai-sdk/google" ? "https://generativelanguage.googleapis.com" : "https://vertexai.googleapis.com",
        npm,
      },
      name: "Gemini 2.0 Flash",
      capabilities: {
        temperature: true,
        reasoning,
        attachment: true,
        toolcall: true,
        input: { text: true, audio: false, image: true, video: false, pdf: true },
        output: { text: true, audio: false, image: false, video: false, pdf: false },
        interleaved: false,
      },
      cost: {
        input: 0.001,
        output: 0.002,
        cache: { read: 0.0001, write: 0.0002 },
      },
      limit: {
        context: 1_000_000,
        output: 8192,
      },
      status: "active",
      options: {},
      headers: {},
    }) as any

  test("does not set thinkingConfig for google models without reasoning capability", () => {
    const result = ProviderTransform.options({
      model: createGoogleModel(false, "@ai-sdk/google"),
      sessionID,
      providerOptions: {},
    })
    expect(result.thinkingConfig).toBeUndefined()
  })

  test("sets thinkingConfig for google models with reasoning capability", () => {
    const result = ProviderTransform.options({
      model: createGoogleModel(true, "@ai-sdk/google"),
      sessionID,
      providerOptions: {},
    })
    expect(result.thinkingConfig).toEqual({
      includeThoughts: true,
    })
  })

  test("does not set thinkingConfig for vertex models without reasoning capability", () => {
    const result = ProviderTransform.options({
      model: createGoogleModel(false, "@ai-sdk/google-vertex"),
      sessionID,
      providerOptions: {},
    })
    expect(result.thinkingConfig).toBeUndefined()
  })
})

describe("ProviderTransform.options - gpt-5 textVerbosity", () => {
  const sessionID = "test-session-123"

  const createGpt5Model = (apiId: string) =>
    ({
      id: `openai/${apiId}`,
      providerID: "openai",
      api: {
        id: apiId,
        url: "https://api.openai.com",
        npm: "@ai-sdk/openai",
      },
      name: apiId,
      capabilities: {
        temperature: true,
        reasoning: true,
        attachment: true,
        toolcall: true,
        input: { text: true, audio: false, image: true, video: false, pdf: false },
        output: { text: true, audio: false, image: false, video: false, pdf: false },
        interleaved: false,
      },
      cost: { input: 0.03, output: 0.06, cache: { read: 0.001, write: 0.002 } },
      limit: { context: 128000, output: 4096 },
      status: "active",
      options: {},
      headers: {},
    }) as any

  test("gpt-5.2 should have textVerbosity set to low", () => {
    const model = createGpt5Model("gpt-5.2")
    const result = ProviderTransform.options({ model, sessionID, providerOptions: {} })
    expect(result.textVerbosity).toBe("low")
    expect(result.include).toEqual(["reasoning.encrypted_content"])
  })

  test("Bedrock Mantle gpt-5.5 uses OpenAI Responses defaults", () => {
    const model = {
      ...createGpt5Model("openai.gpt-5.5"),
      id: "amazon-bedrock/openai.gpt-5.5",
      providerID: "amazon-bedrock",
      api: {
        id: "openai.gpt-5.5",
        url: "https://bedrock-mantle.us-east-2.api.aws/openai/v1",
        npm: "@ai-sdk/amazon-bedrock/mantle",
      },
    }
    const result = ProviderTransform.options({ model, sessionID, providerOptions: {} })
    expect(result.store).toBe(false)
    expect(result.reasoningEffort).toBe("medium")
    expect(result.reasoningSummary).toBe("auto")
    expect(result.include).toEqual(["reasoning.encrypted_content"])
    expect(result.textVerbosity).toBe("low")
  })

  test("openai-compatible gpt-5 models omit Responses-only reasoningSummary", () => {
    const model = {
      ...createGpt5Model("gpt-5.4"),
      id: "cortecs/gpt-5.4",
      providerID: "cortecs",
      api: {
        id: "gpt-5.4",
        url: "https://api.cortecs.ai/v1",
        npm: "@ai-sdk/openai-compatible",
      },
    }
    const result = ProviderTransform.options({ model, sessionID, providerOptions: {} })
    expect(result.reasoningEffort).toBe("medium")
    expect(result.reasoningSummary).toBeUndefined()
    expect(result.include).toBeUndefined()
    expect(result.textVerbosity).toBeUndefined()
  })

  test("azure chat completions omit Responses-only reasoning options after variants merge", async () => {
    const model = {
      ...createGpt5Model("gpt-5.4"),
      id: "azure/gpt-5.4",
      providerID: "azure",
      api: {
        id: "gpt-5.4",
        url: "https://azure.com",
        npm: "@ai-sdk/azure",
      },
      variants: {
        high: {
          reasoningEffort: "high",
          reasoningSummary: "auto",
          include: ["reasoning.encrypted_content"],
        },
      },
    }
    const result = await Effect.runPromise(
      LLMRequestPrep.prepare({
        user: {
          id: "msg_user-test",
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: "test",
          model: { providerID: "azure", modelID: "gpt-5.4", variant: "high" },
        } as any,
        sessionID,
        model,
        agent: {
          name: "test",
          mode: "primary",
          options: {},
          permission: [],
        } as any,
        system: [],
        messages: [{ role: "user", content: "Hello" }],
        tools: {
          lookup: {
            description: "Look up a value",
            inputSchema: jsonSchema({ type: "object", properties: {} }),
          },
        },
        provider: { id: "azure", options: { useCompletionUrls: true } } as any,
        auth: undefined,
        plugin: {
          trigger: (_name: string, _input: unknown, output: unknown) => Effect.succeed(output),
          list: () => Effect.succeed([]),
          init: () => Effect.void,
        } as any,
        flags: { outputTokenMax: 32_000, client: "test" } as any,
        isWorkflow: false,
      }),
    )
    expect(result.params.options.reasoningEffort).toBe("high")
    expect(result.params.options.reasoningSummary).toBeUndefined()
    expect(result.params.options.include).toBeUndefined()
    expect(result.tools.lookup.strict).toBe(false)
  })

  test("gpt-5.1 should have textVerbosity set to low", () => {
    const model = createGpt5Model("gpt-5.1")
    const result = ProviderTransform.options({ model, sessionID, providerOptions: {} })
    expect(result.textVerbosity).toBe("low")
  })

  test("gpt-5.2-chat-latest should NOT have textVerbosity set (only supports medium)", () => {
    const model = createGpt5Model("gpt-5.2-chat-latest")
    const result = ProviderTransform.options({ model, sessionID, providerOptions: {} })
    expect(result.textVerbosity).toBeUndefined()
  })

  test("gpt-5.1-chat-latest should NOT have textVerbosity set (only supports medium)", () => {
    const model = createGpt5Model("gpt-5.1-chat-latest")
    const result = ProviderTransform.options({ model, sessionID, providerOptions: {} })
    expect(result.textVerbosity).toBeUndefined()
  })

  test("gpt-5.2-chat should NOT have textVerbosity set", () => {
    const model = createGpt5Model("gpt-5.2-chat")
    const result = ProviderTransform.options({ model, sessionID, providerOptions: {} })
    expect(result.textVerbosity).toBeUndefined()
  })

  test("gpt-5-chat should NOT have textVerbosity set", () => {
    const model = createGpt5Model("gpt-5-chat")
    const result = ProviderTransform.options({ model, sessionID, providerOptions: {} })
    expect(result.textVerbosity).toBeUndefined()
  })

  test("gpt-5.2-codex should NOT have textVerbosity set (codex models excluded)", () => {
    const model = createGpt5Model("gpt-5.2-codex")
    const result = ProviderTransform.options({ model, sessionID, providerOptions: {} })
    expect(result.textVerbosity).toBeUndefined()
  })
})

describe("ProviderTransform.options - gpt-5 reasoningEffort", () => {
  const sessionID = "test-session-123"

  const createModel = (apiId: string) =>
    ({
      id: `azure/${apiId}`,
      providerID: "azure",
      api: {
        id: apiId,
        url: "https://azure.com",
        npm: "@ai-sdk/azure",
      },
      name: apiId,
      capabilities: {
        temperature: true,
        reasoning: true,
        attachment: true,
        toolcall: true,
        input: {
          text: true,
          audio: false,
          image: true,
          video: false,
          pdf: false,
        },
        output: {
          text: true,
          audio: false,
          image: false,
          video: false,
          pdf: false,
        },
        interleaved: false,
      },
      cost: {
        input: 0.03,
        output: 0.06,
        cache: { read: 0.001, write: 0.002 },
      },
      limit: {
        context: 128000,
        output: 4096,
      },
      status: "active",
      options: {},
      headers: {},
    }) as any

  test("gpt-5-chat should NOT set reasoningEffort", () => {
    const result = ProviderTransform.options({
      model: createModel("gpt-5-chat"),
      sessionID,
      providerOptions: {},
    })

    expect(result.reasoningEffort).toBeUndefined()
  })

  test("gpt-5.5 should NOT set reasoningEffort for the completions API", () => {
    const result = ProviderTransform.options({
      model: createModel("gpt-5.5"),
      sessionID,
      providerOptions: { useCompletionUrls: true },
    })

    expect(result.reasoningEffort).toBeUndefined()
  })

  test("gpt-5.6 should NOT set reasoningEffort for the completions API", () => {
    const result = ProviderTransform.options({
      model: createModel("gpt-5.6"),
      sessionID,
      providerOptions: { useCompletionUrls: true },
    })

    expect(result.reasoningEffort).toBeUndefined()
  })

  test("gpt-5.6 should set reasoningEffort for the responses API", () => {
    const result = ProviderTransform.options({
      model: createModel("gpt-5.6"),
      sessionID,
      providerOptions: {},
    })

    expect(result.reasoningEffort).toBe("medium")
  })
})

describe("ProviderTransform.options - gateway", () => {
  const sessionID = "test-session-123"

  const createModel = (id: string) =>
    ({
      id,
      providerID: "vercel",
      api: {
        id,
        url: "https://ai-gateway.vercel.sh/v3/ai",
        npm: "@ai-sdk/gateway",
      },
      name: id,
      capabilities: {
        temperature: true,
        reasoning: true,
        attachment: true,
        toolcall: true,
        input: { text: true, audio: false, image: true, video: false, pdf: true },
        output: { text: true, audio: false, image: false, video: false, pdf: false },
        interleaved: false,
      },
      cost: {
        input: 0.001,
        output: 0.002,
        cache: { read: 0.0001, write: 0.0002 },
      },
      limit: {
        context: 200_000,
        output: 8192,
      },
      status: "active",
      options: {},
      headers: {},
      release_date: "2024-01-01",
    }) as any

  test("puts gateway defaults under gateway key", () => {
    const model = createModel("anthropic/claude-sonnet-4")
    const result = ProviderTransform.options({ model, sessionID, providerOptions: {} })
    expect(result).toEqual({
      gateway: {
        caching: "auto",
      },
    })
  })
})

describe("ProviderTransform.providerOptions", () => {
  const createModel = (overrides: Partial<any> = {}) =>
    ({
      id: "test/test-model",
      providerID: "test",
      api: {
        id: "test-model",
        url: "https://api.test.com",
        npm: "@ai-sdk/openai",
      },
      name: "Test Model",
      capabilities: {
        temperature: true,
        reasoning: true,
        attachment: true,
        toolcall: true,
        input: { text: true, audio: false, image: true, video: false, pdf: false },
        output: { text: true, audio: false, image: false, video: false, pdf: false },
        interleaved: false,
      },
      cost: {
        input: 0.001,
        output: 0.002,
        cache: { read: 0.0001, write: 0.0002 },
      },
      limit: {
        context: 200_000,
        output: 64_000,
      },
      status: "active",
      options: {},
      headers: {},
      release_date: "2024-01-01",
      ...overrides,
    }) as any

  test("uses sdk key for non-gateway models", () => {
    const model = createModel({
      providerID: "my-bedrock",
      api: {
        id: "anthropic.claude-sonnet-4",
        url: "https://bedrock.aws",
        npm: "@ai-sdk/amazon-bedrock",
      },
    })

    expect(ProviderTransform.providerOptions(model, { cachePoint: { type: "default" } })).toEqual({
      bedrock: { cachePoint: { type: "default" } },
    })
  })

  test("forces reasoning for custom OpenAI package models with explicit effort", () => {
    const model = createModel({
      providerID: "meta",
      api: {
        id: "muse-spark",
        url: "https://api.ai.meta.com/v1",
        npm: "@ai-sdk/openai",
      },
    })

    expect(ProviderTransform.providerOptions(model, { reasoningEffort: "xhigh", reasoningSummary: "auto" })).toEqual({
      openai: { forceReasoning: true, reasoningEffort: "xhigh", reasoningSummary: "auto" },
    })
  })

  test("forces reasoning for OpenAI package models marked reasoning-capable", () => {
    expect(ProviderTransform.providerOptions(createModel(), { store: false })).toEqual({
      openai: { forceReasoning: true, store: false },
    })
  })

  test("uses canonical sdk key for custom xAI models", () => {
    const model = createModel({
      providerID: "my-xai",
      api: { id: "grok-4", url: "https://api.x.ai", npm: "@ai-sdk/xai" },
    })

    expect(ProviderTransform.providerOptions(model, { promptCacheKey: "session" })).toEqual({
      xai: { promptCacheKey: "session" },
    })
  })

  describe("anthropic thinking block binding", () => {
    const binding = { prefixMismatchBehavior: "drop_block" }
    const claude = (npm: string, id: string) =>
      createModel({ providerID: "custom", api: { id, url: "https://example.com", npm } })
    const sdks = [
      { npm: "@ai-sdk/anthropic", key: "anthropic", option: "thinking" },
      { npm: "@ai-sdk/google-vertex/anthropic", key: "anthropic", option: "thinking" },
      { npm: "@ai-sdk/amazon-bedrock", key: "bedrock", option: "reasoningConfig" },
    ]

    test("adds blockBinding to explicit adaptive thinking on @ai-sdk/anthropic", () => {
      const model = claude("@ai-sdk/anthropic", "claude-fable-5-1")
      expect(ProviderTransform.providerOptions(model, { thinking: { type: "adaptive" }, effort: "high" })).toEqual({
        anthropic: { thinking: { type: "adaptive", blockBinding: binding }, effort: "high" },
      })
    })

    test("leaves explicit enabled thinking on older models alone", () => {
      const model = claude("@ai-sdk/anthropic", "claude-haiku-4-5")
      expect(ProviderTransform.providerOptions(model, { thinking: { type: "enabled", budgetTokens: 4000 } })).toEqual({
        anthropic: { thinking: { type: "enabled", budgetTokens: 4000 } },
      })
    })

    sdks.forEach((sdk) => {
      describe(sdk.npm, () => {
        test.each([
          "claude-fable-5-1",
          "claude-fable-5.1",
          "claude-5.1-fable",
          "global.anthropic.claude-fable-5-1",
          "us.anthropic.claude-fable-5-1-v1:0",
          "claude-fable-5-1@default",
          "CLAUDE-FABLE-5-1",
          "claude-opus-5-1",
          "claude-sonnet-5-2",
          "claude-mythos-5-2",
          "claude-mythos-5-10",
          "claude-opus-6",
          "claude-6-opus",
          "claude-mythos-6-20270901",
        ])("adds binding for %s", (id) => {
          const model = claude(sdk.npm, id)
          expect(ProviderTransform.providerOptions(model, {})).toEqual({
            [sdk.key]: { [sdk.option]: { type: "adaptive", blockBinding: binding } },
          })
          expect(
            ProviderTransform.providerOptions(model, { [sdk.option]: { type: "adaptive", display: "summarized" } }),
          ).toEqual({
            [sdk.key]: { [sdk.option]: { type: "adaptive", display: "summarized", blockBinding: binding } },
          })
          expect(
            ProviderTransform.providerOptions(model, { [sdk.option]: { type: "enabled", budgetTokens: 4000 } }),
          ).toEqual({
            [sdk.key]: { [sdk.option]: { type: "enabled", budgetTokens: 4000, blockBinding: binding } },
          })
          expect(ProviderTransform.providerOptions(model, { [sdk.option]: { type: "disabled" } })).toEqual({
            [sdk.key]: { [sdk.option]: { type: "disabled" } },
          })
        })

        test.each([
          "claude-haiku-4-5",
          "claude-opus-4-8",
          "claude-sonnet-4-6",
          "claude-opus-5",
          "claude-sonnet-5",
          "claude-fable-5",
          "claude-opus-5-0",
          "claude-opus-5-20260724",
          "global.anthropic.claude-opus-5",
          "us.anthropic.claude-opus-5",
          "claude-sonnet-5@default",
          "claude-mythos-5-1",
          "claude-mythos-5.1",
          "claude-5.1-mythos",
          "global.anthropic.claude-mythos-5-1-v1:0",
          "claude-mythos-5-1@default",
          "CLAUDE-MYTHOS-5-1",
          "claude-future",
        ])("leaves thinking unchanged for %s", (id) => {
          const model = claude(sdk.npm, id)
          expect(ProviderTransform.providerOptions(model, {})).toEqual({ [sdk.key]: {} })
          expect(
            ProviderTransform.providerOptions(model, { [sdk.option]: { type: "adaptive", display: "summarized" } }),
          ).toEqual({ [sdk.key]: { [sdk.option]: { type: "adaptive", display: "summarized" } } })
          expect(
            ProviderTransform.providerOptions(model, { [sdk.option]: { type: "enabled", budgetTokens: 4000 } }),
          ).toEqual({ [sdk.key]: { [sdk.option]: { type: "enabled", budgetTokens: 4000 } } })
        })

        test.each(["claude-fable-5-1", "claude-opus-5"])("honors explicit binding controls for %s", (id) => {
          const model = claude(sdk.npm, id)
          const options = Object.freeze({
            [sdk.option]: Object.freeze({ type: "adaptive", blockBinding: false }),
          })
          expect(ProviderTransform.providerOptions(model, options)).toEqual({
            [sdk.key]: { [sdk.option]: { type: "adaptive" } },
          })
          expect(ProviderTransform.providerOptions(model, { [sdk.option]: { blockBinding: false } })).toEqual({
            [sdk.key]: {},
          })
          const custom = { [sdk.option]: { type: "adaptive", blockBinding: { prefixMismatchBehavior: "error" } } }
          expect(ProviderTransform.providerOptions(model, custom)).toEqual({ [sdk.key]: custom })
        })

        test.each([
          ["claude-opus-5", "default"],
          ["claude-opus-5", "high"],
          ["claude-sonnet-5", "default"],
          ["claude-sonnet-5", "high"],
          ["claude-mythos-5-1", "default"],
          ["claude-mythos-5-1", "high"],
          ["claude-haiku-4-5", "title"],
        ])("omits binding from the %s %s request body and betas", async (id, mode) => {
          const requests: Request[] = []
          const capture = Object.assign(
            async (...args: Parameters<typeof fetch>) => {
              requests.push(new Request(...args))
              return Response.json(
                sdk.key === "bedrock"
                  ? {
                      output: { message: { role: "assistant", content: [{ text: "ok" }] } },
                      stopReason: "end_turn",
                      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
                    }
                  : {
                      type: "message",
                      id: "msg_1",
                      model: "test-model",
                      role: "assistant",
                      content: [{ type: "text", text: "ok" }],
                      stop_reason: "end_turn",
                      usage: { input_tokens: 1, output_tokens: 1 },
                    },
              )
            },
            { preconnect: () => undefined },
          )
          const provider =
            sdk.key === "bedrock"
              ? createAmazonBedrock({ apiKey: "test-key", region: "ap-southeast-1", fetch: capture })
              : sdk.npm === "@ai-sdk/google-vertex/anthropic"
                ? createVertexAnthropic({
                    project: "test-project",
                    location: "global",
                    generateAuthToken: async () => "test-token",
                    fetch: capture,
                  })
                : createAnthropic({ apiKey: "test-key", fetch: capture })
          const model = claude(
            sdk.npm,
            sdk.key === "bedrock"
              ? `global.anthropic.${id}`
              : sdk.npm === "@ai-sdk/google-vertex/anthropic"
                ? `${id}@default`
                : id,
          )
          const variants = ProviderTransform.variants(model)
          const options =
            mode === "title"
              ? ProviderTransform.smallOptions({ ...model, variants })
              : mode === "high"
                ? variants.high
                : {}
          await generateText({
            model: provider(model.api.id),
            prompt: "hi",
            maxOutputTokens: 32000,
            providerOptions: ProviderTransform.providerOptions(model, options),
          })
          expect(requests).toHaveLength(1)
          const body = await requests[0].json()
          const fields = sdk.key === "bedrock" ? (body.additionalModelRequestFields ?? {}) : body
          expect(fields.thinking).toEqual(
            mode === "title"
              ? { type: "enabled", budget_tokens: 16000 }
              : mode === "high"
                ? { type: "adaptive", display: "summarized" }
                : undefined,
          )
          expect(fields.output_config).toEqual(mode === "high" ? { effort: "high" } : undefined)
          expect(fields.anthropic_beta ?? []).not.toContain("thinking-binding-controls-2026-08-01")
          expect(requests[0].headers.get("anthropic-beta")?.split(",") ?? []).not.toContain(
            "thinking-binding-controls-2026-08-01",
          )
        })
      })
    })

    test("leaves disabled thinking alone", () => {
      const model = claude("@ai-sdk/anthropic", "claude-fable-5-1")
      expect(ProviderTransform.providerOptions(model, { thinking: { type: "disabled" } })).toEqual({
        anthropic: { thinking: { type: "disabled" } },
      })
    })

    test("applies to vertex anthropic", () => {
      const model = claude("@ai-sdk/google-vertex/anthropic", "claude-fable-5-1")
      expect(ProviderTransform.providerOptions(model, { thinking: { type: "adaptive" }, effort: "max" })).toEqual({
        anthropic: { thinking: { type: "adaptive", blockBinding: binding }, effort: "max" },
      })
    })

    test("applies to bedrock reasoningConfig", () => {
      const model = claude("@ai-sdk/amazon-bedrock", "us.anthropic.claude-fable-5-1-v1:0")
      expect(
        ProviderTransform.providerOptions(model, { reasoningConfig: { type: "adaptive", maxReasoningEffort: "high" } }),
      ).toEqual({
        bedrock: { reasoningConfig: { type: "adaptive", maxReasoningEffort: "high", blockBinding: binding } },
      })
      expect(ProviderTransform.providerOptions(model, {})).toEqual({
        bedrock: { reasoningConfig: { type: "adaptive", blockBinding: binding } },
      })
    })

    test("does not touch bedrock non-anthropic models", () => {
      const model = claude("@ai-sdk/amazon-bedrock", "amazon.nova-pro-v1:0")
      expect(ProviderTransform.providerOptions(model, { reasoningConfig: { type: "enabled" } })).toEqual({
        bedrock: { reasoningConfig: { type: "enabled" } },
      })
    })

    test("does not touch non-claude models on anthropic-compatible transports", () => {
      const model = claude("@ai-sdk/anthropic", "kimi-k2-thinking")
      expect(ProviderTransform.providerOptions(model, { thinking: { type: "adaptive" } })).toEqual({
        anthropic: { thinking: { type: "adaptive" } },
      })
    })

    test("reaches the anthropic wire as block_binding plus beta header", async () => {
      const model = claude("@ai-sdk/anthropic", "claude-fable-5-1")
      let sent: { headers: Headers; body: any } | undefined
      const provider = createAnthropic({
        apiKey: "test-key",
        fetch: Object.assign(
          async (...args: Parameters<typeof fetch>) => {
            sent = { headers: new Headers(args[1]?.headers), body: JSON.parse(String(args[1]?.body)) }
            return Response.json({
              type: "message",
              id: "msg_1",
              model: "claude-fable-5-1",
              role: "assistant",
              content: [{ type: "text", text: "ok" }],
              stop_reason: "end_turn",
              usage: { input_tokens: 1, output_tokens: 1 },
              input_transformations: [
                { type: "thinking_dropped", path: "messages.1.content.0", reason: "prefix_binding_mismatch" },
              ],
            })
          },
          { preconnect: () => undefined },
        ),
      })
      const result = await generateText({
        model: provider("claude-fable-5-1"),
        prompt: "hi",
        providerOptions: ProviderTransform.providerOptions(model, {}),
      })
      expect(sent?.body.thinking).toEqual({
        type: "adaptive",
        block_binding: { prefix_mismatch_behavior: "drop_block" },
      })
      expect(sent?.headers.get("anthropic-beta")?.split(",")).toContain("thinking-binding-controls-2026-08-01")
      expect(result.providerMetadata?.anthropic?.inputTransformations).toEqual([
        { type: "thinking_dropped", path: "messages.1.content.0", reason: "prefix_binding_mismatch" },
      ])
    })

    test("reaches the vertex anthropic wire as block_binding plus beta header", async () => {
      const model = claude("@ai-sdk/google-vertex/anthropic", "claude-fable-5-1")
      let sent: { url: string; headers: Headers; body: any } | undefined
      const provider = createVertexAnthropic({
        project: "test-project",
        location: "global",
        generateAuthToken: async () => "test-token",
        fetch: Object.assign(
          async (...args: Parameters<typeof fetch>) => {
            sent = {
              url: String(args[0]),
              headers: new Headers(args[1]?.headers),
              body: JSON.parse(String(args[1]?.body)),
            }
            return Response.json({
              type: "message",
              id: "msg_1",
              model: "claude-fable-5-1",
              role: "assistant",
              content: [{ type: "text", text: "ok" }],
              stop_reason: "end_turn",
              usage: { input_tokens: 1, output_tokens: 1 },
            })
          },
          { preconnect: () => undefined },
        ),
      })
      await generateText({
        model: provider("claude-fable-5-1"),
        prompt: "hi",
        providerOptions: ProviderTransform.providerOptions(model, {}),
      })
      // Same wire shape Anthropic's own Vertex SDK produces: rawPredict URL, model moved
      // out of the body, anthropic_version added, betas carried in the anthropic-beta header.
      expect(sent?.url).toBe(
        "https://aiplatform.googleapis.com/v1/projects/test-project/locations/global/publishers/anthropic/models/claude-fable-5-1:rawPredict",
      )
      expect(sent?.body.model).toBeUndefined()
      expect(sent?.body.anthropic_version).toBe("vertex-2023-10-16")
      expect(sent?.body.thinking).toEqual({
        type: "adaptive",
        block_binding: { prefix_mismatch_behavior: "drop_block" },
      })
      expect(sent?.headers.get("anthropic-beta")?.split(",")).toContain("thinking-binding-controls-2026-08-01")
    })

    test("reaches the bedrock wire as additionalModelRequestFields", async () => {
      const model = claude("@ai-sdk/amazon-bedrock", "us.anthropic.claude-fable-5-1-v1:0")
      let body: any
      const provider = createAmazonBedrock({
        apiKey: "test-key",
        region: "us-east-1",
        fetch: Object.assign(
          async (...args: Parameters<typeof fetch>) => {
            body = JSON.parse(String(args[1]?.body))
            return Response.json({
              output: { message: { role: "assistant", content: [{ text: "ok" }] } },
              stopReason: "end_turn",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            })
          },
          { preconnect: () => undefined },
        ),
      })
      await generateText({
        model: provider("us.anthropic.claude-fable-5-1-v1:0"),
        prompt: "hi",
        providerOptions: ProviderTransform.providerOptions(model, {
          reasoningConfig: { type: "adaptive", maxReasoningEffort: "high" },
        }),
      })
      expect(body.additionalModelRequestFields.thinking).toEqual({
        type: "adaptive",
        block_binding: { prefix_mismatch_behavior: "drop_block" },
      })
      expect(body.additionalModelRequestFields.anthropic_beta).toContain("thinking-binding-controls-2026-08-01")
    })
  })

  test("forces reasoning for explicit effort even when model is not marked reasoning-capable", () => {
    const model = createModel({
      capabilities: {
        temperature: true,
        reasoning: false,
        attachment: true,
        toolcall: true,
        input: { text: true, audio: false, image: true, video: false, pdf: false },
        output: { text: true, audio: false, image: false, video: false, pdf: false },
        interleaved: false,
      },
    })

    expect(ProviderTransform.providerOptions(model, { reasoningEffort: "xhigh" })).toEqual({
      openai: { forceReasoning: true, reasoningEffort: "xhigh" },
    })
  })

  test("forces reasoning for Azure OpenAI models with explicit effort", () => {
    const model = createModel({
      providerID: "azure",
      api: {
        id: "custom-gpt-5-deployment",
        url: "https://azure.openai.example.com/openai/v1",
        npm: "@ai-sdk/azure",
      },
    })

    expect(ProviderTransform.providerOptions(model, { reasoningEffort: "xhigh" })).toEqual({
      openai: { forceReasoning: true, reasoningEffort: "xhigh" },
      azure: { forceReasoning: true, reasoningEffort: "xhigh" },
    })
  })

  test("forces reasoning for Bedrock Mantle OpenAI models with explicit effort", () => {
    const model = createModel({
      providerID: "amazon-bedrock",
      api: {
        id: "openai.gpt-5-custom",
        url: "https://bedrock-mantle.us-east-2.api.aws/openai/v1",
        npm: "@ai-sdk/amazon-bedrock/mantle",
      },
    })

    expect(ProviderTransform.providerOptions(model, { reasoningEffort: "xhigh" })).toEqual({
      openai: { forceReasoning: true, reasoningEffort: "xhigh" },
    })
  })

  test("overrides forceReasoning false when reasoning should be forced", () => {
    expect(
      ProviderTransform.providerOptions(createModel(), { forceReasoning: false, reasoningEffort: "xhigh" }),
    ).toEqual({
      openai: { forceReasoning: true, reasoningEffort: "xhigh" },
    })
  })

  test("uses gateway model provider slug for gateway models", () => {
    const model = createModel({
      providerID: "vercel",
      api: {
        id: "anthropic/claude-sonnet-4",
        url: "https://ai-gateway.vercel.sh/v3/ai",
        npm: "@ai-sdk/gateway",
      },
    })

    expect(ProviderTransform.providerOptions(model, { thinking: { type: "enabled", budgetTokens: 12_000 } })).toEqual({
      anthropic: { thinking: { type: "enabled", budgetTokens: 12_000 } },
    })
  })

  test("falls back to gateway key when gateway api id is unscoped", () => {
    const model = createModel({
      id: "anthropic/claude-sonnet-4",
      providerID: "vercel",
      api: {
        id: "claude-sonnet-4",
        url: "https://ai-gateway.vercel.sh/v3/ai",
        npm: "@ai-sdk/gateway",
      },
    })

    expect(ProviderTransform.providerOptions(model, { thinking: { type: "enabled", budgetTokens: 12_000 } })).toEqual({
      gateway: { thinking: { type: "enabled", budgetTokens: 12_000 } },
    })
  })

  test("splits gateway routing options from provider-specific options", () => {
    const model = createModel({
      providerID: "vercel",
      api: {
        id: "anthropic/claude-sonnet-4",
        url: "https://ai-gateway.vercel.sh/v3/ai",
        npm: "@ai-sdk/gateway",
      },
    })

    expect(
      ProviderTransform.providerOptions(model, {
        gateway: { order: ["vertex", "anthropic"] },
        thinking: { type: "enabled", budgetTokens: 12_000 },
      }),
    ).toEqual({
      gateway: { order: ["vertex", "anthropic"] },
      anthropic: { thinking: { type: "enabled", budgetTokens: 12_000 } },
    } as any)
  })

  test("falls back to gateway key when model id has no provider slug", () => {
    const model = createModel({
      id: "claude-sonnet-4",
      providerID: "vercel",
      api: {
        id: "claude-sonnet-4",
        url: "https://ai-gateway.vercel.sh/v3/ai",
        npm: "@ai-sdk/gateway",
      },
    })

    expect(ProviderTransform.providerOptions(model, { reasoningEffort: "high" })).toEqual({
      gateway: { reasoningEffort: "high" },
    })
  })

  test("maps amazon slug to bedrock for provider options", () => {
    const model = createModel({
      providerID: "vercel",
      api: {
        id: "amazon/nova-2-lite",
        url: "https://ai-gateway.vercel.sh/v3/ai",
        npm: "@ai-sdk/gateway",
      },
    })

    expect(ProviderTransform.providerOptions(model, { reasoningConfig: { type: "enabled" } })).toEqual({
      bedrock: { reasoningConfig: { type: "enabled" } },
    })
  })

  test("maps Bedrock Mantle provider options to OpenAI namespace", () => {
    const model = createModel({
      providerID: "amazon-bedrock",
      api: {
        id: "openai.gpt-5.5",
        url: "https://bedrock-mantle.us-east-2.api.aws/openai/v1",
        npm: "@ai-sdk/amazon-bedrock/mantle",
      },
    })

    expect(ProviderTransform.providerOptions(model, { reasoningEffort: "medium" })).toEqual({
      openai: { forceReasoning: true, reasoningEffort: "medium" },
    })
  })

  test("uses groq slug for groq models", () => {
    const model = createModel({
      providerID: "vercel",
      api: {
        id: "groq/llama-3.3-70b-versatile",
        url: "https://ai-gateway.vercel.sh/v3/ai",
        npm: "@ai-sdk/gateway",
      },
    })

    expect(ProviderTransform.providerOptions(model, { reasoningFormat: "parsed" })).toEqual({
      groq: { reasoningFormat: "parsed" },
    })
  })
})

describe("ProviderTransform.schema - gemini array items", () => {
  test("adds missing items for array properties", () => {
    const geminiModel = {
      providerID: "google",
      api: {
        id: "gemini-3-pro",
      },
    } as any

    const schema = {
      type: "object",
      properties: {
        nodes: { type: "array" },
        edges: { type: "array", items: { type: "string" } },
      },
    } as any

    const result = ProviderTransform.schema(geminiModel, schema) as any

    expect(result.properties.nodes.items).toBeDefined()
    expect(result.properties.edges.items.type).toBe("string")
  })
})

describe("ProviderTransform.schema - gemini nested array items", () => {
  const geminiModel = {
    providerID: "google",
    api: {
      id: "gemini-3-pro",
    },
  } as any

  test("adds type to 2D array with empty inner items", () => {
    const schema = {
      type: "object",
      properties: {
        values: {
          type: "array",
          items: {
            type: "array",
            items: {}, // Empty items object
          },
        },
      },
    } as any

    const result = ProviderTransform.schema(geminiModel, schema) as any

    // Inner items should have a default type
    expect(result.properties.values.items.items.type).toBe("string")
  })

  test("adds items and type to 2D array with missing inner items", () => {
    const schema = {
      type: "object",
      properties: {
        data: {
          type: "array",
          items: { type: "array" }, // No items at all
        },
      },
    } as any

    const result = ProviderTransform.schema(geminiModel, schema) as any

    expect(result.properties.data.items.items).toBeDefined()
    expect(result.properties.data.items.items.type).toBe("string")
  })

  test("handles deeply nested arrays (3D)", () => {
    const schema = {
      type: "object",
      properties: {
        matrix: {
          type: "array",
          items: {
            type: "array",
            items: {
              type: "array",
              // No items
            },
          },
        },
      },
    } as any

    const result = ProviderTransform.schema(geminiModel, schema) as any

    expect(result.properties.matrix.items.items.items).toBeDefined()
    expect(result.properties.matrix.items.items.items.type).toBe("string")
  })

  test("preserves existing item types in nested arrays", () => {
    const schema = {
      type: "object",
      properties: {
        numbers: {
          type: "array",
          items: {
            type: "array",
            items: { type: "number" }, // Has explicit type
          },
        },
      },
    } as any

    const result = ProviderTransform.schema(geminiModel, schema) as any

    // Should preserve the explicit type
    expect(result.properties.numbers.items.items.type).toBe("number")
  })

  test("handles mixed nested structures with objects and arrays", () => {
    const schema = {
      type: "object",
      properties: {
        spreadsheetData: {
          type: "object",
          properties: {
            rows: {
              type: "array",
              items: {
                type: "array",
                items: {}, // Empty items
              },
            },
          },
        },
      },
    } as any

    const result = ProviderTransform.schema(geminiModel, schema) as any

    expect(result.properties.spreadsheetData.properties.rows.items.items.type).toBe("string")
  })
})

describe("ProviderTransform.schema - gemini type arrays", () => {
  // Mirrors @ai-sdk/google's convertJSONSchemaToOpenAPISchema: JSON Schema type
  // arrays (e.g. `["number","string"]`, common in MCP tool schemas) become an
  // `anyOf` of single-type schemas, with `null` lifted into `nullable`. Plain
  // @ai-sdk/google rewrites these, but OpenAI-compatible transports such as
  // GitHub Copilot (proxying to Gemini) forward them verbatim and the backend
  // rejects the array form.
  const geminiModel = {
    providerID: "google",
    api: {
      id: "gemini-3-pro",
    },
  } as any

  test("splits a multi-type array into anyOf and drops the type array", () => {
    const schema = {
      type: "object",
      properties: {
        status: { type: ["number", "string"], description: "status filter" },
      },
    } as any

    const result = ProviderTransform.schema(geminiModel, schema) as any

    expect(result.properties.status.type).toBeUndefined()
    expect(result.properties.status.anyOf).toEqual([{ type: "number" }, { type: "string" }])
    expect(result.properties.status.nullable).toBeUndefined()
    // Sibling keywords stay alongside the generated anyOf.
    expect(result.properties.status.description).toBe("status filter")
  })

  test("lifts null into nullable for a nullable type array", () => {
    const schema = {
      type: "object",
      properties: {
        maybe: { type: ["string", "null"], description: "nullable string" },
      },
    } as any

    const result = ProviderTransform.schema(geminiModel, schema) as any

    expect(result.properties.maybe.type).toBeUndefined()
    expect(result.properties.maybe.anyOf).toEqual([{ type: "string" }])
    expect(result.properties.maybe.nullable).toBe(true)
  })

  test("collapses an all-null type array to type null", () => {
    const schema = {
      type: "object",
      properties: {
        nothing: { type: ["null"] },
      },
    } as any

    const result = ProviderTransform.schema(geminiModel, schema) as any

    expect(result.properties.nothing.type).toBe("null")
    expect(result.properties.nothing.anyOf).toBeUndefined()
  })

  test("rewrites type arrays for gemini served through github-copilot", () => {
    const copilotGeminiModel = {
      providerID: "github-copilot",
      api: {
        id: "gemini-3.5-flash",
        npm: "@ai-sdk/github-copilot",
      },
    } as any

    const schema = {
      type: "object",
      properties: {
        hook_id: { type: "number", description: "ID of the webhook" },
        status: { type: ["number", "string"], description: "Filter by response status code" },
      },
      required: ["hook_id"],
      additionalProperties: false,
    } as any

    const result = ProviderTransform.schema(copilotGeminiModel, schema) as any

    expect(result.properties.status.anyOf).toEqual([{ type: "number" }, { type: "string" }])
    expect(result.properties.status.type).toBeUndefined()
    expect(result.properties.hook_id.type).toBe("number")
  })
})

describe("ProviderTransform.schema - gemini combiner nodes", () => {
  const geminiModel = {
    providerID: "google",
    api: {
      id: "gemini-3-pro",
    },
  } as any

  const walk = (node: any, cb: (node: any, path: (string | number)[]) => void, path: (string | number)[] = []) => {
    if (node === null || typeof node !== "object") {
      return
    }
    if (Array.isArray(node)) {
      node.forEach((item, i) => walk(item, cb, [...path, i]))
      return
    }
    cb(node, path)
    Object.entries(node).forEach(([key, value]) => walk(value, cb, [...path, key]))
  }

  test("keeps edits.items.anyOf without adding type", () => {
    const schema = {
      type: "object",
      properties: {
        edits: {
          type: "array",
          items: {
            anyOf: [
              {
                type: "object",
                properties: {
                  old_string: { type: "string" },
                  new_string: { type: "string" },
                },
                required: ["old_string", "new_string"],
              },
              {
                type: "object",
                properties: {
                  old_string: { type: "string" },
                  new_string: { type: "string" },
                  replace_all: { type: "boolean" },
                },
                required: ["old_string", "new_string"],
              },
            ],
          },
        },
      },
      required: ["edits"],
    } as any

    const result = ProviderTransform.schema(geminiModel, schema) as any

    expect(Array.isArray(result.properties.edits.items.anyOf)).toBe(true)
    expect(result.properties.edits.items.type).toBeUndefined()
  })

  test("does not add sibling keys to combiner nodes during sanitize", () => {
    const schema = {
      type: "object",
      properties: {
        edits: {
          type: "array",
          items: {
            anyOf: [{ type: "string" }, { type: "number" }],
          },
        },
        value: {
          oneOf: [{ type: "string" }, { type: "boolean" }],
        },
        meta: {
          allOf: [
            {
              type: "object",
              properties: { a: { type: "string" } },
            },
            {
              type: "object",
              properties: { b: { type: "string" } },
            },
          ],
        },
      },
    } as any
    const input = JSON.parse(JSON.stringify(schema))
    const result = ProviderTransform.schema(geminiModel, schema) as any

    walk(result, (node, path) => {
      const hasCombiner = Array.isArray(node.anyOf) || Array.isArray(node.oneOf) || Array.isArray(node.allOf)
      if (!hasCombiner) {
        return
      }
      const before = path.reduce((acc: any, key) => acc?.[key], input)
      const added = Object.keys(node).filter((key) => !(key in before))
      expect(added).toEqual([])
    })
  })
})

describe("ProviderTransform.schema - gemini non-object properties removal", () => {
  const geminiModel = {
    providerID: "google",
    api: {
      id: "gemini-3-pro",
    },
  } as any

  test("removes properties from non-object types", () => {
    const schema = {
      type: "object",
      properties: {
        data: {
          type: "string",
          properties: { invalid: { type: "string" } },
        },
      },
    } as any

    const result = ProviderTransform.schema(geminiModel, schema) as any

    expect(result.properties.data.type).toBe("string")
    expect(result.properties.data.properties).toBeUndefined()
  })

  test("removes required from non-object types", () => {
    const schema = {
      type: "object",
      properties: {
        data: {
          type: "array",
          items: { type: "string" },
          required: ["invalid"],
        },
      },
    } as any

    const result = ProviderTransform.schema(geminiModel, schema) as any

    expect(result.properties.data.type).toBe("array")
    expect(result.properties.data.required).toBeUndefined()
  })

  test("removes properties and required from nested non-object types", () => {
    const schema = {
      type: "object",
      properties: {
        outer: {
          type: "object",
          properties: {
            inner: {
              type: "number",
              properties: { bad: { type: "string" } },
              required: ["bad"],
            },
          },
        },
      },
    } as any

    const result = ProviderTransform.schema(geminiModel, schema) as any

    expect(result.properties.outer.properties.inner.type).toBe("number")
    expect(result.properties.outer.properties.inner.properties).toBeUndefined()
    expect(result.properties.outer.properties.inner.required).toBeUndefined()
  })

  test("keeps properties and required on object types", () => {
    const schema = {
      type: "object",
      properties: {
        data: {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
        },
      },
    } as any

    const result = ProviderTransform.schema(geminiModel, schema) as any

    expect(result.properties.data.type).toBe("object")
    expect(result.properties.data.properties).toBeDefined()
    expect(result.properties.data.required).toEqual(["name"])
  })

  test("does not affect non-gemini providers", () => {
    const openaiModel = {
      providerID: "openai",
      api: {
        id: "gpt-4",
      },
    } as any

    const schema = {
      type: "object",
      properties: {
        data: {
          type: "string",
          properties: { invalid: { type: "string" } },
        },
      },
    } as any

    const result = ProviderTransform.schema(openaiModel, schema) as any

    expect(result.properties.data.properties).toBeDefined()
  })
})

describe("ProviderTransform.schema - openai supported schema subset", () => {
  const openaiModel = {
    providerID: "openai",
    api: {
      id: "gpt-4.1",
      npm: "@ai-sdk/openai",
    },
  } as any

  test("removes unsupported JSON Schema keywords recursively", () => {
    const result = ProviderTransform.schema(openaiModel, {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      title: "Search",
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query",
          format: "uri",
          pattern: "^https://",
          minLength: 1,
          maxLength: 100,
          default: "https://example.com",
        },
        count: {
          type: "integer",
          minimum: 1,
          maximum: 10,
          multipleOf: 1,
        },
        createdAt: {
          format: "date-time",
        },
        mode: {
          const: "fast",
        },
        tags: {
          type: "array",
          minItems: 1,
          maxItems: 3,
          uniqueItems: true,
        },
        tuple: {
          type: "array",
          items: [
            { type: "number", minimum: 0 },
            { type: "string", pattern: "^ok$" },
          ],
        },
        metadata: {
          type: "object",
          patternProperties: {
            "^x-": { type: "string" },
          },
          additionalProperties: {
            type: "string",
            pattern: "^safe$",
          },
        },
      },
      patternProperties: {
        "^extra": { type: "string" },
      },
      required: ["query"],
      additionalProperties: false,
    } as any) as any

    expect(result).toEqual({
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query",
        },
        count: {
          type: "integer",
        },
        createdAt: {
          type: "string",
        },
        mode: {
          enum: ["fast"],
          type: "string",
        },
        tags: {
          type: "array",
          items: { type: "string" },
        },
        tuple: {
          type: "array",
          items: [{ type: "number" }, { type: "string" }],
        },
        metadata: {
          type: "object",
          properties: {},
          additionalProperties: {
            type: "string",
          },
        },
      },
      required: ["query"],
      additionalProperties: false,
    })
  })

  test("keeps local references and sanitizes definitions", () => {
    const result = ProviderTransform.schema(openaiModel, {
      type: "object",
      properties: {
        value: {
          $ref: "#/$defs/Value",
          description: "Referenced value",
          examples: ["ignored"],
        },
      },
      $defs: {
        Value: {
          type: "string",
          pattern: "^value$",
          description: "Definition description",
        },
        Unused: {
          type: "number",
          minimum: 0,
        },
      },
    } as any) as any

    expect(result.properties.value).toEqual({
      $ref: "#/$defs/Value",
      description: "Referenced value",
    })
    expect(result.$defs).toEqual({
      Value: {
        type: "string",
        description: "Definition description",
      },
      Unused: {
        type: "number",
      },
    })
  })

  test("does not sanitize non-openai providers", () => {
    const result = ProviderTransform.schema(
      {
        providerID: "anthropic",
        api: {
          id: "claude-sonnet-4",
          npm: "@ai-sdk/anthropic",
        },
      } as any,
      {
        type: "object",
        properties: {
          query: {
            type: "string",
            pattern: "^https://",
          },
        },
      } as any,
    ) as any

    expect(result.properties.query.pattern).toBe("^https://")
  })

  test.each([
    ["opencode", "@ai-sdk/openai"],
    ["custom-openai-compatible", "@ai-sdk/openai"],
    ["azure", "@ai-sdk/azure"],
  ])("sanitizes %s models using %s", (providerID, npm) => {
    expect(
      ProviderTransform.schema(
        {
          providerID,
          api: {
            id: "custom-model",
            npm,
          },
        } as any,
        {
          type: "object",
          properties: {
            query: {
              type: "string",
              pattern: "^https://",
            },
          },
        } as any,
      ),
    ).toEqual({
      type: "object",
      properties: {
        query: {
          type: "string",
        },
      },
    })
  })
})

describe("ProviderTransform.schema - moonshot $ref siblings", () => {
  const moonshotModel = {
    providerID: "moonshotai",
    api: {
      id: "kimi-k2",
    },
  } as any

  test("removes sibling descriptions from referenced tool parameter schemas", () => {
    const schema = {
      type: "object",
      properties: {
        deviceType: {
          description: "Optional. The type of device that captured the screenshot, e.g. mobile or desktop.",
          enum: ["DEVICE_TYPE_UNSPECIFIED", "MOBILE", "DESKTOP", "TABLET", "AGNOSTIC"],
          type: "string",
        },
        modelId: {
          description: "Optional. The model to use for generation.",
          enum: ["MODEL_ID_UNSPECIFIED", "GEMINI_3_PRO", "GEMINI_3_FLASH", "GEMINI_3_1_PRO"],
          type: "string",
        },
        projectId: {
          description: "Required. The project ID of screens to generate variants for.",
          type: "string",
        },
        prompt: {
          description: "Required. The input text used to generate the variants.",
          type: "string",
        },
        selectedScreenIds: {
          description: "Required. The screen ids of screen to generate variants for.",
          items: {
            type: "string",
          },
          type: "array",
        },
        variantOptions: {
          $ref: "#/$defs/VariantOptions",
          description:
            "Required. The variant options for generation, including the number of variants, creative range, and aspects to focus on.",
        },
      },
      required: ["projectId", "selectedScreenIds", "prompt", "variantOptions"],
      $defs: {
        VariantOptions: {
          description:
            "Configuration options for design variant generation. This message captures all parameters used to generate variants, allowing the configuration to be stored, replayed, or analyzed.",
          properties: {
            aspects: {
              description: "Optional. Specific aspects to focus on. If empty, all aspects may be varied.",
              items: {
                enum: ["VARIANT_ASPECT_UNSPECIFIED", "LAYOUT", "COLOR_SCHEME", "IMAGES", "TEXT_FONT", "TEXT_CONTENT"],
                type: "string",
              },
              type: "array",
            },
            creativeRange: {
              description: "Optional. Creative range for variations. Default: EXPLORE",
              enum: ["CREATIVE_RANGE_UNSPECIFIED", "REFINE", "EXPLORE", "REIMAGINE"],
              type: "string",
            },
            variantCount: {
              description: "Optional. Number of variants to generate (1-5). Default: 3",
              format: "int32",
              type: "integer",
            },
          },
          type: "object",
        },
      },
      description: "Request message for GenerateVariants.",
      additionalProperties: false,
    } as any

    const result = ProviderTransform.schema(moonshotModel, schema) as any

    expect(result.properties.variantOptions).toEqual({
      $ref: "#/$defs/VariantOptions",
    })
    expect(result.$defs.VariantOptions.description).toBe(schema.$defs.VariantOptions.description)
  })

  test("also runs for kimi models outside the moonshot provider", () => {
    const result = ProviderTransform.schema(
      {
        providerID: "openrouter",
        name: "Kimi K2",
        api: {
          id: "moonshotai/kimi-k2",
        },
      } as any,
      {
        type: "object",
        properties: {
          value: {
            $ref: "#/$defs/Value",
            description: "Moonshot rejects this sibling after ref expansion.",
          },
        },
        $defs: {
          Value: {
            description: "Referenced schema description stays here.",
            type: "object",
          },
        },
      } as any,
    ) as any

    expect(result.properties.value).toEqual({
      $ref: "#/$defs/Value",
    })
  })

  test("converts tuple-style array items to a single item schema", () => {
    const result = ProviderTransform.schema(moonshotModel, {
      type: "object",
      properties: {
        codeSpec: {
          type: "object",
          properties: {
            accessibility: {
              type: "object",
              properties: {
                renderedSize: {
                  description: "Rendered size [width, height] in px",
                  type: "array",
                  items: [{ type: "number" }, { type: "number" }],
                  minItems: 2,
                  maxItems: 2,
                },
              },
            },
          },
        },
      },
    } as any) as any

    expect(result.properties.codeSpec.properties.accessibility.properties.renderedSize.items).toEqual({
      type: "number",
    })
  })
})

describe("ProviderTransform.message - Mistral tool call IDs", () => {
  test.each(["codestral-latest", "pixtral-large-latest", "open-mixtral-8x22b"])(
    "normalizes IDs for custom OpenAI-compatible %s models",
    (id) => {
      const result = ProviderTransform.message(
        [
          {
            role: "assistant",
            content: [
              {
                type: "tool-call",
                toolCallId: "toolu_01CBhTTz95qkd9LJMdC9sf8t",
                toolName: "read",
                input: { filePath: "/tmp/test" },
              },
            ],
          },
          {
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: "toolu_01CBhTTz95qkd9LJMdC9sf8t",
                toolName: "read",
                output: { type: "text", value: "test" },
              },
            ],
          },
        ] as any,
        {
          id: `custom/${id}`,
          providerID: "custom",
          api: {
            id,
            url: "https://example.com/v1",
            npm: "@ai-sdk/openai-compatible",
          },
        } as any,
        {},
      )

      expect(result).toMatchObject([
        { role: "assistant", content: [{ type: "tool-call", toolCallId: "toolu01CB" }] },
        { role: "tool", content: [{ type: "tool-result", toolCallId: "toolu01CB" }] },
      ])
    },
  )
})

describe("ProviderTransform.message - DeepSeek reasoning content", () => {
  test("DeepSeek with tool calls includes reasoning_content in providerOptions", () => {
    const msgs = [
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "Let me think about this..." },
          {
            type: "tool-call",
            toolCallId: "test",
            toolName: "bash",
            input: { command: "echo hello" },
          },
        ],
      },
    ] as any[]

    const result = ProviderTransform.message(
      msgs,
      {
        id: ModelV2.ID.make("deepseek/deepseek-chat"),
        providerID: ProviderV2.ID.make("deepseek"),
        api: {
          id: "deepseek-chat",
          url: "https://api.deepseek.com",
          npm: "@ai-sdk/openai-compatible",
        },
        name: "DeepSeek Chat",
        capabilities: {
          temperature: true,
          reasoning: true,
          attachment: false,
          toolcall: true,
          input: { text: true, audio: false, image: false, video: false, pdf: false },
          output: { text: true, audio: false, image: false, video: false, pdf: false },
          interleaved: {
            field: "reasoning_content",
          },
        },
        cost: {
          input: 0.001,
          output: 0.002,
          cache: { read: 0.0001, write: 0.0002 },
        },
        limit: {
          context: 128000,
          output: 8192,
        },
        status: "active",
        options: {},
        headers: {},
        release_date: "2023-04-01",
      },
      {},
    )

    expect(result).toHaveLength(1)
    expect(result[0].content).toEqual([
      {
        type: "tool-call",
        toolCallId: "test",
        toolName: "bash",
        input: { command: "echo hello" },
      },
    ])
    expect(result[0].providerOptions?.openaiCompatible?.reasoning_content).toBe("Let me think about this...")
  })

  test("Non-DeepSeek providers leave reasoning content unchanged", () => {
    const msgs = [
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "Should not be processed" },
          { type: "text", text: "Answer" },
        ],
      },
    ] as any[]

    const result = ProviderTransform.message(
      msgs,
      {
        id: ModelV2.ID.make("openai/gpt-4"),
        providerID: ProviderV2.ID.make("openai"),
        api: {
          id: "gpt-4",
          url: "https://api.openai.com",
          npm: "@ai-sdk/openai",
        },
        name: "GPT-4",
        capabilities: {
          temperature: true,
          reasoning: false,
          attachment: true,
          toolcall: true,
          input: { text: true, audio: false, image: true, video: false, pdf: false },
          output: { text: true, audio: false, image: false, video: false, pdf: false },
          interleaved: false,
        },
        cost: {
          input: 0.03,
          output: 0.06,
          cache: { read: 0.001, write: 0.002 },
        },
        limit: {
          context: 128000,
          output: 4096,
        },
        status: "active",
        options: {},
        headers: {},
        release_date: "2023-04-01",
      },
      {},
    )

    expect(result[0].content).toEqual([
      { type: "reasoning", text: "Should not be processed" },
      { type: "text", text: "Answer" },
    ])
    expect(result[0].providerOptions?.openaiCompatible?.reasoning_content).toBeUndefined()
  })
})

describe("ProviderTransform.message - surrogate sanitization", () => {
  const model = {
    id: "test/test-model",
    providerID: "test",
    api: {
      id: "test-model",
      url: "https://api.test.com",
      npm: "@ai-sdk/openai-compatible",
    },
    name: "Test Model",
    capabilities: {
      temperature: true,
      reasoning: true,
      attachment: true,
      toolcall: true,
      input: { text: true, audio: false, image: true, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    cost: { input: 0.001, output: 0.002, cache: { read: 0.0001, write: 0.0002 } },
    limit: { context: 128000, output: 8192 },
    status: "active",
    options: {},
    headers: {},
  } as any

  test("replaces lone surrogates in model-visible text", () => {
    const lone = "\uD83D"
    const valid = "🚀"
    const sanitized = "�"
    const text = (label: string) => `${label} ${lone} and ${valid}`
    const expected = (label: string) => `${label} ${sanitized} and ${valid}`
    const msgs = [
      { role: "system", content: text("system") },
      { role: "user", content: text("user string") },
      {
        role: "user",
        content: [
          { type: "text", text: text("user text") },
          { type: "image", image: "data:image/png;base64,abcd" },
        ],
      },
      { role: "assistant", content: text("assistant string") },
      {
        role: "assistant",
        content: [
          { type: "text", text: text("assistant text") },
          { type: "reasoning", text: text("assistant reasoning") },
          { type: "tool-call", toolCallId: "call-1", toolName: "Read", input: { filePath: ".opencode/tool/emoji.ts" } },
          {
            type: "tool-result",
            toolCallId: "call-2",
            toolName: "Read",
            output: { type: "text", value: text("assistant tool text") },
          },
          {
            type: "tool-result",
            toolCallId: "call-3",
            toolName: "Read",
            output: { type: "error-text", value: text("assistant tool error") },
          },
          {
            type: "tool-result",
            toolCallId: "call-4",
            toolName: "Read",
            output: { type: "content", value: [{ type: "text", text: text("assistant tool content") }] },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-5",
            toolName: "Read",
            output: { type: "text", value: text("tool text") },
          },
          {
            type: "tool-result",
            toolCallId: "call-6",
            toolName: "Read",
            output: { type: "error-text", value: text("tool error") },
          },
          {
            type: "tool-result",
            toolCallId: "call-7",
            toolName: "Read",
            output: { type: "content", value: [{ type: "text", text: text("tool content") }] },
          },
        ],
      },
    ] as any[]

    const result = ProviderTransform.message(msgs, model, {}) as any[]

    expect(result[0].content).toBe(expected("system"))
    expect(result[1].content).toBe(expected("user string"))
    expect(result[2].content[0].text).toBe(expected("user text"))
    expect(result[3].content).toBe(expected("assistant string"))
    expect(result[4].content[0].text).toBe(expected("assistant text"))
    expect(result[4].content[1].text).toBe(expected("assistant reasoning"))
    expect(result[4].content[3].output.value).toBe(expected("assistant tool text"))
    expect(result[4].content[4].output.value).toBe(expected("assistant tool error"))
    expect(result[4].content[5].output.value[0].text).toBe(expected("assistant tool content"))
    expect(result[5].content[0].output.value).toBe(expected("tool text"))
    expect(result[5].content[1].output.value).toBe(expected("tool error"))
    expect(result[5].content[2].output.value[0].text).toBe(expected("tool content"))
    expect(result[2].content[1]).toEqual({ type: "image", image: "data:image/png;base64,abcd" })
  })
})

describe("ProviderTransform.message - empty image handling", () => {
  const mockModel = {
    id: "anthropic/claude-3-5-sonnet",
    providerID: "anthropic",
    api: {
      id: "claude-3-5-sonnet-20241022",
      url: "https://api.anthropic.com",
      npm: "@ai-sdk/anthropic",
    },
    name: "Claude 3.5 Sonnet",
    capabilities: {
      temperature: true,
      reasoning: false,
      attachment: true,
      toolcall: true,
      input: { text: true, audio: false, image: true, video: false, pdf: true },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    cost: {
      input: 0.003,
      output: 0.015,
      cache: { read: 0.0003, write: 0.00375 },
    },
    limit: {
      context: 200000,
      output: 8192,
    },
    status: "active",
    options: {},
    headers: {},
  } as any

  test("should replace empty base64 image with error text", () => {
    const msgs = [
      {
        role: "user",
        content: [
          { type: "text", text: "What is in this image?" },
          { type: "image", image: "data:image/png;base64," },
        ],
      },
    ] as any[]

    const result = ProviderTransform.message(msgs, mockModel, {})

    expect(result).toHaveLength(1)
    expect(result[0].content).toHaveLength(2)
    expect(result[0].content[0]).toEqual({ type: "text", text: "What is in this image?" })
    expect(result[0].content[1]).toEqual({
      type: "text",
      text: "ERROR: Image file is empty or corrupted. Please provide a valid image.",
    })
  })

  test("should keep valid base64 images unchanged", () => {
    const validBase64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
    const msgs = [
      {
        role: "user",
        content: [
          { type: "text", text: "What is in this image?" },
          { type: "image", image: `data:image/png;base64,${validBase64}` },
        ],
      },
    ] as any[]

    const result = ProviderTransform.message(msgs, mockModel, {})

    expect(result).toHaveLength(1)
    expect(result[0].content).toHaveLength(2)
    expect(result[0].content[0]).toEqual({ type: "text", text: "What is in this image?" })
    expect(result[0].content[1]).toEqual({ type: "image", image: `data:image/png;base64,${validBase64}` })
  })

  test("should handle mixed valid and empty images", () => {
    const validBase64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
    const msgs = [
      {
        role: "user",
        content: [
          { type: "text", text: "Compare these images" },
          { type: "image", image: `data:image/png;base64,${validBase64}` },
          { type: "image", image: "data:image/jpeg;base64," },
        ],
      },
    ] as any[]

    const result = ProviderTransform.message(msgs, mockModel, {})

    expect(result).toHaveLength(1)
    expect(result[0].content).toHaveLength(3)
    expect(result[0].content[0]).toEqual({ type: "text", text: "Compare these images" })
    expect(result[0].content[1]).toEqual({ type: "image", image: `data:image/png;base64,${validBase64}` })
    expect(result[0].content[2]).toEqual({
      type: "text",
      text: "ERROR: Image file is empty or corrupted. Please provide a valid image.",
    })
  })
})

describe("ProviderTransform.message - anthropic empty content filtering", () => {
  const anthropicModel = {
    id: "anthropic/claude-3-5-sonnet",
    providerID: "anthropic",
    api: {
      id: "claude-3-5-sonnet-20241022",
      url: "https://api.anthropic.com",
      npm: "@ai-sdk/anthropic",
    },
    name: "Claude 3.5 Sonnet",
    capabilities: {
      temperature: true,
      reasoning: false,
      attachment: true,
      toolcall: true,
      input: { text: true, audio: false, image: true, video: false, pdf: true },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    cost: {
      input: 0.003,
      output: 0.015,
      cache: { read: 0.0003, write: 0.00375 },
    },
    limit: {
      context: 200000,
      output: 8192,
    },
    status: "active",
    options: {},
    headers: {},
  } as any

  test("filters out messages with empty string content", () => {
    const msgs = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "" },
      { role: "user", content: "World" },
    ] as any[]

    const result = ProviderTransform.message(msgs, anthropicModel, {})

    expect(result).toHaveLength(2)
    expect(result[0].content).toBe("Hello")
    expect(result[1].content).toBe("World")
  })

  test("filters out empty text parts from array content", () => {
    const msgs = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "" },
          { type: "text", text: "Hello" },
          { type: "text", text: "" },
        ],
      },
    ] as any[]

    const result = ProviderTransform.message(msgs, anthropicModel, {})

    expect(result).toHaveLength(1)
    expect(result[0].content).toHaveLength(1)
    expect(result[0].content[0]).toEqual({ type: "text", text: "Hello" })
  })

  test("filters out empty reasoning parts from array content", () => {
    const msgs = [
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "" },
          { type: "text", text: "Answer" },
          { type: "reasoning", text: "" },
        ],
      },
    ] as any[]

    const result = ProviderTransform.message(msgs, anthropicModel, {})

    expect(result).toHaveLength(1)
    expect(result[0].content).toHaveLength(1)
    expect(result[0].content[0]).toEqual({ type: "text", text: "Answer" })
  })

  test("removes entire message when all parts are empty", () => {
    const msgs = [
      { role: "user", content: "Hello" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "" },
          { type: "reasoning", text: "" },
        ],
      },
      { role: "user", content: "World" },
    ] as any[]

    const result = ProviderTransform.message(msgs, anthropicModel, {})

    expect(result).toHaveLength(2)
    expect(result[0].content).toBe("Hello")
    expect(result[1].content).toBe("World")
  })

  test("keeps non-text/reasoning parts even if text parts are empty", () => {
    const msgs = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "" },
          { type: "tool-call", toolCallId: "123", toolName: "bash", input: { command: "ls" } },
        ],
      },
    ] as any[]

    const result = ProviderTransform.message(msgs, anthropicModel, {})

    expect(result).toHaveLength(1)
    expect(result[0].content).toHaveLength(1)
    expect(result[0].content[0]).toEqual({
      type: "tool-call",
      toolCallId: "123",
      toolName: "bash",
      input: { command: "ls" },
    })
  })

  test("keeps messages with valid text alongside empty parts", () => {
    const msgs = [
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "Thinking..." },
          { type: "text", text: "" },
          { type: "text", text: "Result" },
        ],
      },
    ] as any[]

    const result = ProviderTransform.message(msgs, anthropicModel, {})

    expect(result).toHaveLength(1)
    expect(result[0].content).toHaveLength(2)
    expect(result[0].content[0]).toEqual({ type: "reasoning", text: "Thinking..." })
    expect(result[0].content[1]).toEqual({ type: "text", text: "Result" })
  })

  test("filters empty content for bedrock provider", () => {
    const bedrockModel = {
      ...anthropicModel,
      id: "amazon-bedrock/anthropic.claude-opus-4-6",
      providerID: "amazon-bedrock",
      api: {
        id: "anthropic.claude-opus-4-6",
        url: "https://bedrock-runtime.us-east-1.amazonaws.com",
        npm: "@ai-sdk/amazon-bedrock",
      },
    }

    const msgs = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "" },
          { type: "text", text: "Answer" },
        ],
      },
    ] as any[]

    const result = ProviderTransform.message(msgs, bedrockModel, {})

    expect(result).toHaveLength(2)
    expect(result[0].content).toBe("Hello")
    expect(result[1].content).toHaveLength(1)
    expect(result[1].content[0]).toEqual({ type: "text", text: "Answer" })
  })

  describe("Bedrock reasoning replay", () => {
    const model = {
      ...anthropicModel,
      id: "amazon-bedrock/anthropic.claude-opus-4-6",
      providerID: "amazon-bedrock",
      api: {
        id: "anthropic.claude-opus-4-6",
        url: "https://bedrock-runtime.us-east-1.amazonaws.com",
        npm: "@ai-sdk/amazon-bedrock",
      },
    }

    for (const cached of [false, true]) {
      test(`omits unsigned reasoning before SDK conversion (caching: ${cached})`, async () => {
        const selected = cached
          ? model
          : { ...model, id: "amazon-bedrock/openai.gpt-oss-120b", api: { ...model.api, id: "openai.gpt-oss-120b" } }
        const messages = ProviderTransform.message(
          [
            { role: "user", content: "Think" },
            { role: "assistant", content: [{ type: "text", text: "Earlier answer" }] },
            {
              role: "assistant",
              content: [
                { type: "reasoning", text: "Partial thought" },
                { type: "text", text: "" },
              ],
            },
            { role: "user", content: "Continue" },
          ],
          selected,
          {},
        )
        expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "user"])
        expect(messages[1].providerOptions?.bedrock?.cachePoint).toEqual(cached ? { type: "default" } : undefined)
        const provider = createAmazonBedrock({
          apiKey: "test-key",
          region: "us-east-1",
          fetch: Object.assign(
            async (...args: Parameters<typeof fetch>) => {
              const body = JSON.parse(String(args[1]?.body))
              expect(body.messages).toEqual([
                { role: "user", content: [{ text: "Think" }] },
                {
                  role: "assistant",
                  content: [{ text: "Earlier answer" }, ...(cached ? [{ cachePoint: { type: "default" } }] : [])],
                },
                {
                  role: "user",
                  content: [{ text: "Continue" }, ...(cached ? [{ cachePoint: { type: "default" } }] : [])],
                },
              ])
              return Response.json({
                output: { message: { role: "assistant", content: [{ text: "Recovered" }] } },
                stopReason: "end_turn",
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              })
            },
            { preconnect: () => undefined },
          ),
        })
        const result = await generateText({ model: provider(selected.api.id), messages, maxRetries: 0 })
        expect(result.text).toBe("Recovered")
      })
    }

    for (const namespace of ["bedrock", "amazon-bedrock", "custom-bedrock"]) {
      for (const field of ["signature", "redactedContent", "redactedData"]) {
        test(`preserves ${namespace}.${field} on empty reasoning`, () => {
          const result = ProviderTransform.message(
            [
              {
                role: "assistant",
                content: [{ type: "reasoning", text: "", providerOptions: { [namespace]: { [field]: "opaque" } } }],
              },
            ],
            namespace === "custom-bedrock" ? { ...model, providerID: namespace } : model,
            {},
          )
          expect(result).toHaveLength(1)
          expect(result[0].content).toEqual([
            { type: "reasoning", text: "", providerOptions: { bedrock: { [field]: "opaque" } } },
          ])
        })
      }
    }

    test("uses stored provider metadata when it will overwrite the SDK namespace", () => {
      const result = ProviderTransform.message(
        [
          {
            role: "assistant",
            content: [
              {
                type: "reasoning",
                text: "Partial thought",
                providerOptions: { "amazon-bedrock": {}, bedrock: { signature: "overwritten" } },
              },
            ],
          },
        ],
        model,
        {},
      )
      expect(result).toEqual([])
    })

    test("keeps text and tool calls next to unsigned reasoning", () => {
      const content: ModelMessage["content"] = [
        { type: "text", text: "Answer" },
        { type: "tool-call", toolCallId: "call_1", toolName: "lookup", input: {} },
      ]
      const result = ProviderTransform.message(
        [{ role: "assistant", content: [{ type: "reasoning", text: "Partial thought" }, ...content] }],
        model,
        {},
      )
      expect(result).toHaveLength(1)
      expect(result[0].content).toEqual(content)
    })

    test("does not remove unsigned reasoning for other providers", () => {
      const content: ModelMessage["content"] = [{ type: "reasoning", text: "Partial thought" }]
      const result = ProviderTransform.message([{ role: "assistant", content }], anthropicModel, {})
      expect(result[0].content).toEqual(content)
    })
  })

  test("does not filter for non-anthropic providers", () => {
    const openaiModel = {
      ...anthropicModel,
      providerID: "openai",
      api: {
        id: "gpt-4",
        url: "https://api.openai.com",
        npm: "@ai-sdk/openai",
      },
    }

    const msgs = [
      { role: "assistant", content: "" },
      {
        role: "assistant",
        content: [{ type: "text", text: "" }],
      },
    ] as any[]

    const result = ProviderTransform.message(msgs, openaiModel, {})

    expect(result).toHaveLength(2)
    expect(result[0].content).toBe("")
    expect(result[1].content).toHaveLength(1)
  })

  test("leaves valid anthropic assistant tool ordering unchanged", () => {
    const msgs = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "I checked your home directory and looked for PDF files." },
          { type: "tool-call", toolCallId: "toolu_1", toolName: "read", input: { filePath: "/root" } },
          { type: "tool-call", toolCallId: "toolu_2", toolName: "glob", input: { pattern: "**/*.pdf" } },
        ],
      },
    ] as any[]

    const result = ProviderTransform.message(msgs, anthropicModel, {}) as any[]

    expect(result).toHaveLength(1)
    expect(result[0].content).toMatchObject([
      { type: "text", text: "I checked your home directory and looked for PDF files." },
      { type: "tool-call", toolCallId: "toolu_1", toolName: "read", input: { filePath: "/root" } },
      { type: "tool-call", toolCallId: "toolu_2", toolName: "glob", input: { pattern: "**/*.pdf" } },
    ])
  })
})

describe("ProviderTransform.message - strip openai metadata when store=false", () => {
  const openaiModel = {
    id: "openai/gpt-5",
    providerID: "openai",
    api: {
      id: "gpt-5",
      url: "https://api.openai.com",
      npm: "@ai-sdk/openai",
    },
    name: "GPT-5",
    capabilities: {
      temperature: true,
      reasoning: true,
      attachment: true,
      toolcall: true,
      input: { text: true, audio: false, image: true, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    cost: { input: 0.03, output: 0.06, cache: { read: 0.001, write: 0.002 } },
    limit: { context: 128000, output: 4096 },
    status: "active",
    options: {},
    headers: {},
  } as any

  test("strips OpenAI itemId and preserves reasoningEncryptedContent when store=false", () => {
    const msgs = [
      {
        role: "assistant",
        content: [
          {
            type: "reasoning",
            text: "thinking...",
            providerOptions: {
              openai: {
                itemId: "rs_123",
                reasoningEncryptedContent: "encrypted",
              },
            },
          },
          {
            type: "text",
            text: "Hello",
            providerOptions: {
              openai: {
                itemId: "msg_456",
              },
            },
          },
        ],
      },
    ] as any[]

    const result = ProviderTransform.message(msgs, openaiModel, { store: false }) as any[]

    expect(result).toHaveLength(1)
    expect(result[0].content[0].providerOptions?.openai?.itemId).toBeUndefined()
    expect(result[0].content[0].providerOptions?.openai?.reasoningEncryptedContent).toBe("encrypted")
    expect(result[0].content[1].providerOptions?.openai?.itemId).toBeUndefined()
  })

  test("uses the SDK package namespace rather than provider ID", () => {
    const zenModel = {
      ...openaiModel,
      providerID: "zen",
    }
    const msgs = [
      {
        role: "assistant",
        content: [
          {
            type: "reasoning",
            text: "thinking...",
            providerOptions: {
              openai: {
                itemId: "rs_123",
                reasoningEncryptedContent: "encrypted",
              },
            },
          },
          {
            type: "text",
            text: "Hello",
            providerOptions: {
              openai: {
                itemId: "msg_456",
              },
            },
          },
        ],
      },
    ] as any[]

    const result = ProviderTransform.message(msgs, zenModel, { store: false }) as any[]

    expect(result).toHaveLength(1)
    expect(result[0].content[0].providerOptions?.openai?.itemId).toBeUndefined()
    expect(result[0].content[0].providerOptions?.openai?.reasoningEncryptedContent).toBe("encrypted")
    expect(result[0].content[1].providerOptions?.openai?.itemId).toBeUndefined()
  })

  test("preserves other OpenAI options", () => {
    const msgs = [
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "Hello",
            providerOptions: {
              openai: {
                itemId: "msg_123",
                otherOption: "value",
              },
            },
          },
        ],
      },
    ] as any[]

    const result = ProviderTransform.message(msgs, openaiModel, { store: false }) as any[]

    expect(result[0].content[0].providerOptions?.openai?.itemId).toBeUndefined()
    expect(result[0].content[0].providerOptions?.openai?.otherOption).toBe("value")
  })

  test("strips Azure itemId from the Azure namespace", () => {
    const azureModel = {
      ...openaiModel,
      providerID: "azure",
      api: {
        id: "gpt-5",
        url: "https://example.openai.azure.com",
        npm: "@ai-sdk/azure",
      },
    }
    const msgs = [
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "Hello",
            providerOptions: {
              azure: { itemId: "msg_123", otherOption: "value" },
              openai: { itemId: "msg_openai" },
            },
          },
        ],
      },
    ] as any[]

    const result = ProviderTransform.message(msgs, azureModel, { store: false }) as any[]

    expect(result[0].content[0].providerOptions?.azure?.itemId).toBeUndefined()
    expect(result[0].content[0].providerOptions?.azure?.otherOption).toBe("value")
    expect(result[0].content[0].providerOptions?.openai?.itemId).toBe("msg_openai")
  })

  test("strips Bedrock Mantle itemId from the OpenAI namespace", () => {
    const mantleModel = {
      ...openaiModel,
      providerID: "amazon-bedrock",
      api: {
        id: "openai.gpt-5.5",
        url: "https://bedrock-mantle.us-east-2.api.aws/openai/v1",
        npm: "@ai-sdk/amazon-bedrock/mantle",
      },
    }
    const msgs = [
      {
        role: "assistant",
        providerOptions: { openai: { itemId: "msg_root", otherOption: "root-value" } },
        content: [
          {
            type: "reasoning",
            text: "thinking...",
            providerOptions: {
              openai: { itemId: "rs_123", reasoningEncryptedContent: "encrypted" },
            },
          },
        ],
      },
    ] as any[]

    const result = ProviderTransform.message(msgs, mantleModel, { store: false }) as any[]

    expect(result[0].providerOptions?.openai?.itemId).toBeUndefined()
    expect(result[0].providerOptions?.openai?.otherOption).toBe("root-value")
    expect(result[0].content[0].providerOptions?.openai?.itemId).toBeUndefined()
    expect(result[0].content[0].providerOptions?.openai?.reasoningEncryptedContent).toBe("encrypted")
  })

  test("strips GitHub Copilot itemId from the copilot namespace, preserving other copilot options", () => {
    const copilotModel = {
      ...openaiModel,
      id: "github-copilot/gpt-5.5",
      providerID: "github-copilot",
      api: {
        id: "gpt-5.5",
        url: "https://api.githubcopilot.com",
        npm: "@ai-sdk/github-copilot",
      },
    }
    const msgs = [
      {
        role: "assistant",
        content: [
          {
            type: "reasoning",
            text: "thinking...",
            providerOptions: {
              copilot: { itemId: "rs_123", reasoningEncryptedContent: "encrypted" },
            },
          },
          {
            // The stale itemId on tool-call parts is what Copilot echoes back as the
            // `function_call` item `id`, which is what the upstream connection rejects.
            type: "tool-call",
            toolCallId: "call_1",
            toolName: "bash",
            input: { command: "ls" },
            providerOptions: {
              copilot: { itemId: "fc_456", reasoningEffort: "medium" },
            },
          },
        ],
      },
    ] as any[]

    const result = ProviderTransform.message(msgs, copilotModel, { store: false }) as any[]

    expect(result[0].content[0].providerOptions?.copilot?.itemId).toBeUndefined()
    expect(result[0].content[0].providerOptions?.copilot?.reasoningEncryptedContent).toBe("encrypted")
    expect(result[0].content[1].providerOptions?.copilot?.itemId).toBeUndefined()
    expect(result[0].content[1].providerOptions?.copilot?.reasoningEffort).toBe("medium")
  })

  test("leaves a stray openai namespace on a Copilot model untouched, since Copilot's Responses model only reads the copilot namespace", () => {
    const copilotModel = {
      ...openaiModel,
      id: "github-copilot/gpt-5.5",
      providerID: "github-copilot",
      api: {
        id: "gpt-5.5",
        url: "https://api.githubcopilot.com",
        npm: "@ai-sdk/github-copilot",
      },
    }
    const msgs = [
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "Hello",
            providerOptions: {
              openai: { itemId: "msg_456" },
            },
          },
        ],
      },
    ] as any[]

    const result = ProviderTransform.message(msgs, copilotModel, { store: false }) as any[]

    expect(result[0].content[0].providerOptions?.openai?.itemId).toBe("msg_456")
  })

  test("preserves metadata for openai package when store is true", () => {
    const msgs = [
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "Hello",
            providerOptions: {
              openai: {
                itemId: "msg_123",
              },
            },
          },
        ],
      },
    ] as any[]

    // openai package preserves itemId regardless of store value
    const result = ProviderTransform.message(msgs, openaiModel, { store: true }) as any[]

    expect(result[0].content[0].providerOptions?.openai?.itemId).toBe("msg_123")
  })

  test("preserves metadata for non-openai packages when store is false", () => {
    const anthropicModel = {
      ...openaiModel,
      providerID: "anthropic",
      api: {
        id: "claude-3",
        url: "https://api.anthropic.com",
        npm: "@ai-sdk/anthropic",
      },
    }
    const msgs = [
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "Hello",
            providerOptions: {
              openai: {
                itemId: "msg_123",
              },
            },
          },
        ],
      },
    ] as any[]

    // store=false preserves metadata for non-openai packages
    const result = ProviderTransform.message(msgs, anthropicModel, { store: false }) as any[]

    expect(result[0].content[0].providerOptions?.openai?.itemId).toBe("msg_123")
  })

  test("preserves metadata using providerID key when store is false", () => {
    const opencodeModel = {
      ...openaiModel,
      providerID: "opencode",
      api: {
        id: "opencode-test",
        url: "https://api.opencode.ai",
        npm: "@ai-sdk/openai-compatible",
      },
    }
    const msgs = [
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "Hello",
            providerOptions: {
              opencode: {
                itemId: "msg_123",
                otherOption: "value",
              },
            },
          },
        ],
      },
    ] as any[]

    const result = ProviderTransform.message(msgs, opencodeModel, { store: false }) as any[]

    expect(result[0].content[0].providerOptions?.opencode?.itemId).toBe("msg_123")
    expect(result[0].content[0].providerOptions?.opencode?.otherOption).toBe("value")
  })

  test("preserves itemId across all providerOptions keys", () => {
    const opencodeModel = {
      ...openaiModel,
      providerID: "opencode",
      api: {
        id: "opencode-test",
        url: "https://api.opencode.ai",
        npm: "@ai-sdk/openai-compatible",
      },
    }
    const msgs = [
      {
        role: "assistant",
        providerOptions: {
          openai: { itemId: "msg_root" },
          opencode: { itemId: "msg_opencode" },
          extra: { itemId: "msg_extra" },
        },
        content: [
          {
            type: "text",
            text: "Hello",
            providerOptions: {
              openai: { itemId: "msg_openai_part" },
              opencode: { itemId: "msg_opencode_part" },
              extra: { itemId: "msg_extra_part" },
            },
          },
        ],
      },
    ] as any[]

    const result = ProviderTransform.message(msgs, opencodeModel, { store: false }) as any[]

    expect(result[0].providerOptions?.openai?.itemId).toBe("msg_root")
    expect(result[0].providerOptions?.opencode?.itemId).toBe("msg_opencode")
    expect(result[0].providerOptions?.extra?.itemId).toBe("msg_extra")
    expect(result[0].content[0].providerOptions?.openai?.itemId).toBe("msg_openai_part")
    expect(result[0].content[0].providerOptions?.opencode?.itemId).toBe("msg_opencode_part")
    expect(result[0].content[0].providerOptions?.extra?.itemId).toBe("msg_extra_part")
  })

  test("does not strip metadata for non-openai packages when store is not false", () => {
    const anthropicModel = {
      ...openaiModel,
      providerID: "anthropic",
      api: {
        id: "claude-3",
        url: "https://api.anthropic.com",
        npm: "@ai-sdk/anthropic",
      },
    }
    const msgs = [
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "Hello",
            providerOptions: {
              openai: {
                itemId: "msg_123",
              },
            },
          },
        ],
      },
    ] as any[]

    const result = ProviderTransform.message(msgs, anthropicModel, {}) as any[]

    expect(result[0].content[0].providerOptions?.openai?.itemId).toBe("msg_123")
  })
})

describe("ProviderTransform.message - providerOptions key remapping", () => {
  const createModel = (providerID: string, npm: string) =>
    ({
      id: `${providerID}/test-model`,
      providerID,
      api: {
        id: "test-model",
        url: "https://api.test.com",
        npm,
      },
      name: "Test Model",
      capabilities: {
        temperature: true,
        reasoning: false,
        attachment: true,
        toolcall: true,
        input: { text: true, audio: false, image: true, video: false, pdf: true },
        output: { text: true, audio: false, image: false, video: false, pdf: false },
        interleaved: false,
      },
      cost: { input: 0.001, output: 0.002, cache: { read: 0.0001, write: 0.0002 } },
      limit: { context: 128000, output: 8192 },
      status: "active",
      options: {},
      headers: {},
    }) as any

  test("azure keeps 'azure' key and does not remap to 'openai'", () => {
    const model = createModel("azure", "@ai-sdk/azure")
    const msgs = [
      {
        role: "user",
        content: "Hello",
        providerOptions: {
          azure: { someOption: "value" },
        },
      },
    ] as any[]

    const result = ProviderTransform.message(msgs, model, {})

    expect(result[0].providerOptions?.azure).toEqual({ someOption: "value" })
    expect(result[0].providerOptions?.openai).toBeUndefined()
  })

  test("azure cognitive services remaps providerID to 'azure' key", () => {
    const model = createModel("azure-cognitive-services", "@ai-sdk/azure")
    const msgs = [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "Hello",
            providerOptions: {
              "azure-cognitive-services": { part: true },
            },
          },
        ],
        providerOptions: {
          "azure-cognitive-services": { someOption: "value" },
        },
      },
    ] as any[]

    const result = ProviderTransform.message(msgs, model, {}) as any[]
    const part = result[0].content[0] as any

    expect(result[0].providerOptions?.azure).toEqual({ someOption: "value" })
    expect(result[0].providerOptions?.["azure-cognitive-services"]).toBeUndefined()
    expect(part.providerOptions?.azure).toEqual({ part: true })
    expect(part.providerOptions?.["azure-cognitive-services"]).toBeUndefined()
  })

  test("copilot remaps providerID to 'copilot' key", () => {
    const model = createModel("github-copilot", "@ai-sdk/github-copilot")
    const msgs = [
      {
        role: "user",
        content: "Hello",
        providerOptions: {
          copilot: { someOption: "value" },
        },
      },
    ] as any[]

    const result = ProviderTransform.message(msgs, model, {})

    expect(result[0].providerOptions?.copilot).toEqual({ someOption: "value" })
    expect(result[0].providerOptions?.["github-copilot"]).toBeUndefined()
  })

  test("bedrock remaps providerID to 'bedrock' key", () => {
    const model = createModel("my-bedrock", "@ai-sdk/amazon-bedrock")
    const msgs = [
      {
        role: "user",
        content: "Hello",
        providerOptions: {
          "my-bedrock": { someOption: "value" },
        },
      },
    ] as any[]

    const result = ProviderTransform.message(msgs, model, {})

    expect(result[0].providerOptions?.bedrock).toEqual({ someOption: "value" })
    expect(result[0].providerOptions?.["my-bedrock"]).toBeUndefined()
  })
})

describe("ProviderTransform.message - claude w/bedrock custom inference profile", () => {
  test("adds cachePoint", () => {
    const model = {
      id: "amazon-bedrock/custom-claude-sonnet-4.5",
      providerID: "amazon-bedrock",
      api: {
        id: "arn:aws:bedrock:xxx:yyy:application-inference-profile/zzz",
        url: "https://api.test.com",
        npm: "@ai-sdk/amazon-bedrock",
      },
      name: "Custom inference profile",
      capabilities: {},
      options: {},
      headers: {},
    } as any

    const msgs = [
      {
        role: "user",
        content: "Hello",
      },
    ] as any[]

    const result = ProviderTransform.message(msgs, model, {})

    expect(result[0].providerOptions?.bedrock).toEqual(
      expect.objectContaining({
        cachePoint: {
          type: "default",
        },
      }),
    )
  })
})

describe("ProviderTransform.message - bedrock caching with non-bedrock providerID", () => {
  test("applies cache options at message level when npm package is amazon-bedrock", () => {
    const model = {
      id: "aws/us.anthropic.claude-opus-4-6-v1",
      providerID: "aws",
      api: {
        id: "us.anthropic.claude-opus-4-6-v1",
        url: "https://bedrock-runtime.us-east-1.amazonaws.com",
        npm: "@ai-sdk/amazon-bedrock",
      },
      name: "Claude Opus 4.6",
      capabilities: {},
      options: {},
      headers: {},
    } as any

    const msgs = [
      {
        role: "system",
        content: "You are a helpful assistant",
      },
      {
        role: "user",
        content: [{ type: "text", text: "Hello" }],
      },
    ] as any[]

    const result = ProviderTransform.message(msgs, model, {}) as any[]

    // Cache should be at the message level and not the content-part level
    expect(result[0].providerOptions?.bedrock).toEqual({
      cachePoint: { type: "default" },
    })
    expect(result[0].content).toBe("You are a helpful assistant")
  })
})

describe("ProviderTransform.message - cache control on gateway", () => {
  const createModel = (overrides: Partial<any> = {}) =>
    ({
      id: "anthropic/claude-sonnet-4",
      providerID: "vercel",
      api: {
        id: "anthropic/claude-sonnet-4",
        url: "https://ai-gateway.vercel.sh/v3/ai",
        npm: "@ai-sdk/gateway",
      },
      name: "Claude Sonnet 4",
      capabilities: {
        temperature: true,
        reasoning: true,
        attachment: true,
        toolcall: true,
        input: { text: true, audio: false, image: true, video: false, pdf: true },
        output: { text: true, audio: false, image: false, video: false, pdf: false },
        interleaved: false,
      },
      cost: { input: 0.001, output: 0.002, cache: { read: 0.0001, write: 0.0002 } },
      limit: { context: 200_000, output: 8192 },
      status: "active",
      options: {},
      headers: {},
      ...overrides,
    }) as any

  test("gateway does not set cache control for anthropic models", () => {
    const model = createModel()
    const msgs = [
      {
        role: "system",
        content: "You are a helpful assistant",
      },
      {
        role: "user",
        content: "Hello",
      },
    ] as any[]

    const result = ProviderTransform.message(msgs, model, {}) as any[]

    expect(result[0].content).toBe("You are a helpful assistant")
    expect(result[0].providerOptions).toBeUndefined()
  })

  test("non-gateway anthropic keeps existing cache control behavior", () => {
    const model = createModel({
      providerID: "anthropic",
      api: {
        id: "claude-sonnet-4",
        url: "https://api.anthropic.com",
        npm: "@ai-sdk/anthropic",
      },
    })
    const msgs = [
      {
        role: "system",
        content: "You are a helpful assistant",
      },
      {
        role: "user",
        content: "Hello",
      },
    ] as any[]

    const result = ProviderTransform.message(msgs, model, {}) as any[]

    expect(result[0].providerOptions).toEqual({
      anthropic: {
        cacheControl: {
          type: "ephemeral",
        },
      },
      openrouter: {
        cacheControl: {
          type: "ephemeral",
        },
      },
      bedrock: {
        cachePoint: {
          type: "default",
        },
      },
      openaiCompatible: {
        cache_control: {
          type: "ephemeral",
        },
      },
      copilot: {
        copilot_cache_control: {
          type: "ephemeral",
        },
      },
      alibaba: {
        cacheControl: {
          type: "ephemeral",
        },
      },
    })
  })

  test("does not add explicit breakpoints when Anthropic automatic caching is enabled", () => {
    const model = createModel({
      providerID: "anthropic",
      api: { id: "claude-sonnet-4", url: "https://api.anthropic.com", npm: "@ai-sdk/anthropic" },
    })
    const msgs = [
      { role: "system", content: "You are a helpful assistant" },
      { role: "user", content: "Hello" },
    ] as any[]

    const result = ProviderTransform.message(msgs, model, { cacheControl: { type: "ephemeral" } }) as any[]
    expect(result.every((message) => message.providerOptions === undefined)).toBe(true)
  })

  test("google-vertex-anthropic applies cache control", () => {
    const model = createModel({
      providerID: "google-vertex-anthropic",
      api: {
        id: "google-vertex-anthropic",
        url: "https://us-central1-aiplatform.googleapis.com",
        npm: "@ai-sdk/google-vertex/anthropic",
      },
      id: "claude-sonnet-4@20250514",
    })
    const msgs = [
      {
        role: "system",
        content: "You are a helpful assistant",
      },
      {
        role: "user",
        content: "Hello",
      },
    ] as any[]

    const result = ProviderTransform.message(msgs, model, {}) as any[]

    expect(result[0].providerOptions).toEqual({
      anthropic: {
        cacheControl: {
          type: "ephemeral",
        },
      },
      openrouter: {
        cacheControl: {
          type: "ephemeral",
        },
      },
      bedrock: {
        cachePoint: {
          type: "default",
        },
      },
      openaiCompatible: {
        cache_control: {
          type: "ephemeral",
        },
      },
      copilot: {
        copilot_cache_control: {
          type: "ephemeral",
        },
      },
      alibaba: {
        cacheControl: {
          type: "ephemeral",
        },
      },
    })
  })
})

describe("ProviderTransform.temperature - Cohere North", () => {
  test("defaults north-mini-code models to 1.0", () => {
    expect(
      ProviderTransform.temperature({
        id: "cohere/North-Mini-Code-1-0-latest",
        api: { id: "North-Mini-Code-1-0-latest" },
      } as any),
    ).toBe(1.0)
  })
})

describe("ProviderTransform sampling defaults - Qwen", () => {
  test.each(["Qwen3.8-27B", "qwen3-coder-30b-a3b-instruct"])('leaves sampling unset for "%s"', (id) => {
    const model = {
      id: `custom/${id}`,
      api: { id },
    } as any

    expect(ProviderTransform.temperature(model)).toBeUndefined()
    expect(ProviderTransform.topP(model)).toBeUndefined()
    expect(ProviderTransform.topK(model)).toBeUndefined()
  })
})

describe("ProviderTransform sampling defaults - Gemini", () => {
  const model = (id: string) =>
    ({
      id: `google/${id}`,
      api: { id },
    }) as any

  const alias = (id: string, apiID: string) =>
    ({
      id,
      api: { id: apiID },
    }) as any

  test.each([
    "gemini-3.5-flash-lite",
    "gemini-3-5-flash-lite",
    "gemini-3.6-flash",
    "gemini-3-6-flash",
    "gemini-4-pro",
    "gemini-future",
  ])("omits deprecated sampling controls for %s", (id) => {
    expect(ProviderTransform.temperature(model(id))).toBeUndefined()
    expect(ProviderTransform.topP(model(id))).toBeUndefined()
    expect(ProviderTransform.topK(model(id))).toBeUndefined()
  })

  test.each([
    "gemini-2.5-flash",
    "gemini-2.5-pro",
    "gemini-2.5-flash-lite",
    "gemini-2-5-flash-lite",
    "gemini-3-flash-preview",
    "gemini-3-pro-image",
    "gemini-3.1-flash-lite",
    "gemini-3.1-pro-preview",
    "gemini-3-1-pro-preview",
    "gemini-3.5-flash",
    "gemini-3-5-flash",
  ])("preserves sampling defaults for %s", (id) => {
    expect(ProviderTransform.temperature(model(id))).toBe(1)
    expect(ProviderTransform.topP(model(id))).toBe(0.95)
    expect(ProviderTransform.topK(model(id))).toBe(64)
  })

  test("uses the API model ID for configured aliases", () => {
    const deprecated = alias("google/gemini-3.5-flash", "google/gemini-3.6-flash")
    expect(ProviderTransform.temperature(deprecated)).toBeUndefined()
    expect(ProviderTransform.topP(deprecated)).toBeUndefined()
    expect(ProviderTransform.topK(deprecated)).toBeUndefined()

    const supported = alias("my-gemini", "google/gemini-2.5-flash")
    expect(ProviderTransform.temperature(supported)).toBe(1)
    expect(ProviderTransform.topP(supported)).toBe(0.95)
    expect(ProviderTransform.topK(supported)).toBe(64)
  })
})

describe("ProviderTransform sampling defaults - DeepSeek", () => {
  const model = (providerID: string, id: string) =>
    ({
      id: `${providerID}/${id}`,
      providerID,
      api: { id },
    }) as any

  test.each([
    ["deepseek", "deepseek-v4-flash"],
    ["opencode", "deepseek-v4-flash"],
    ["opencode-go", "deepseek-v4-flash"],
    ["openrouter", "deepseek/deepseek-v4-flash-0731"],
    ["ollama-cloud", "deepseek-v4-flash:0731"],
  ])("defaults top_p for %s/%s", (providerID, id) => {
    expect(ProviderTransform.temperature(model(providerID, id))).toBeUndefined()
    expect(ProviderTransform.topP(model(providerID, id))).toBe(0.95)
    expect(ProviderTransform.topK(model(providerID, id))).toBeUndefined()
  })

  test.each([
    ["openrouter", "deepseek/deepseek-v4-flash"],
    ["vercel", "deepseek/deepseek-v4-flash"],
    ["custom", "deepseek-ai/DeepSeek-V4-Flash"],
  ])("preserves legacy defaults for %s/%s", (providerID, id) => {
    expect(ProviderTransform.temperature(model(providerID, id))).toBeUndefined()
    expect(ProviderTransform.topP(model(providerID, id))).toBeUndefined()
    expect(ProviderTransform.topK(model(providerID, id))).toBeUndefined()
  })
})

describe("ProviderTransform.reasoningVariants", () => {
  const model = (reasoning_options: ModelsDev.Model["reasoning_options"]) => ({ reasoning_options }) as ModelsDev.Model
  const target = (npm: string, id = "test-model", family = "") =>
    ({
      id,
      providerID: "test",
      family,
      api: { id, npm, url: "" },
      capabilities: { reasoning: true },
      limit: { output: 64_000 },
    }) as any

  test("respects explicitly empty reasoning options", () => {
    expect(ProviderTransform.reasoningVariants(model([]), target("@ai-sdk/openai"))).toEqual({})
  })

  test.each([
    ["@openrouter/ai-sdk-provider", { reasoning: { effort: "high" } }],
    ["@ai-sdk/anthropic", { thinking: { type: "adaptive" }, effort: "high" }, "claude-opus-4-6"],
    [
      "@ai-sdk/google-vertex/anthropic",
      { thinking: { type: "adaptive", display: "summarized" }, effort: "high" },
      "claude-opus-4-7",
    ],
    ["@ai-sdk/anthropic", { thinking: { type: "adaptive", display: "summarized" }, effort: "high" }, "claude-opus-5"],
    ["@ai-sdk/google", { thinkingConfig: { includeThoughts: true, thinkingLevel: "high" } }],
    ["@ai-sdk/google-vertex", { thinkingConfig: { includeThoughts: true, thinkingLevel: "high" } }],
    [
      "@ai-sdk/azure",
      {
        reasoningEffort: "high",
        reasoningSummary: "auto",
        include: ["reasoning.encrypted_content"],
      },
    ],
    [
      "@ai-sdk/openai",
      {
        reasoningEffort: "high",
        reasoningSummary: "auto",
        include: ["reasoning.encrypted_content"],
      },
    ],
    [
      "@ai-sdk/amazon-bedrock/mantle",
      {
        reasoningEffort: "high",
        reasoningSummary: "auto",
        include: ["reasoning.encrypted_content"],
      },
    ],
    [
      "@ai-sdk/github-copilot",
      {
        reasoningEffort: "high",
        reasoningSummary: "auto",
        include: ["reasoning.encrypted_content"],
      },
    ],
    ["@ai-sdk/openai-compatible", { reasoningEffort: "high" }],
    ["@ai-sdk/xai", { reasoningEffort: "high" }],
    ["@ai-sdk/mistral", { reasoningEffort: "high" }],
    ["@ai-sdk/groq", { reasoningEffort: "high" }],
    ["@ai-sdk/cerebras", { reasoningEffort: "high" }],
    ["@ai-sdk/deepinfra", { reasoningEffort: "high" }],
    ["@ai-sdk/togetherai", { reasoningEffort: "high" }],
    ["venice-ai-sdk-provider", { reasoningEffort: "high" }],
    ["ai-gateway-provider", { reasoningEffort: "high" }],
    ["merge-gateway-ai-sdk-provider", { reasoningEffort: "high" }],
    ["@ai-sdk/amazon-bedrock", { reasoningConfig: { type: "enabled", maxReasoningEffort: "high" } }],
  ])("converts effort for %s", (npm, expected, ...args) => {
    const id = args[0] as string | undefined
    expect(ProviderTransform.reasoningVariants(model([{ type: "effort", values: ["high"] }]), target(npm, id))).toEqual(
      { high: expected },
    )
  })

  test.each(["luna", "sol", "terra"])("serializes Bedrock GPT-5.6 %s none effort", async (name) => {
    const item = target("@ai-sdk/amazon-bedrock", `global.openai.gpt-5.6-${name}`)
    const variants = ProviderTransform.reasoningVariants(
      model([{ type: "effort", values: ["none", "low", "medium", "high", "xhigh", "max"] }]),
      item,
    )
    for (const effort of ["low", "medium", "high", "xhigh", "max"]) {
      expect(variants?.[effort]).toEqual({ reasoningConfig: { type: "enabled", maxReasoningEffort: effort } })
    }
    expect(variants?.none).toEqual({
      reasoningConfig: { type: "enabled", maxReasoningEffort: "none" },
    } satisfies AmazonBedrockLanguageModelOptions)
    const sent: unknown[] = []
    const provider = createAmazonBedrock({
      apiKey: "test-key",
      region: "us-east-1",
      fetch: Object.assign(
        async (...args: Parameters<typeof fetch>) => {
          sent.push(JSON.parse(String(args[1]?.body)))
          return Response.json({
            output: { message: { role: "assistant", content: [{ text: "ok" }] } },
            stopReason: "end_turn",
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          })
        },
        { preconnect: () => undefined },
      ),
    })
    await generateText({
      model: provider(item.api.id),
      prompt: "hi",
      providerOptions: ProviderTransform.providerOptions(item, variants?.none ?? {}),
    })
    expect(sent).toEqual([expect.objectContaining({ additionalModelRequestFields: { reasoning: { effort: "none" } } })])
  })

  test("combines effort with extended thinking for Claude Opus 4.5", () => {
    expect(
      ProviderTransform.reasoningVariants(
        model([{ type: "effort", values: ["high"] }]),
        target("@ai-sdk/anthropic", "claude-opus-4-5"),
      ),
    ).toEqual({
      high: {
        thinking: { type: "enabled", budgetTokens: 16_000 },
        effort: "high",
      },
    })
  })

  test("uses explicit effort metadata for Anthropic-compatible models", () => {
    expect(
      ProviderTransform.reasoningVariants(
        model([{ type: "effort", values: ["high"] }]),
        target("@ai-sdk/anthropic", "claude-sonnet-4"),
      ),
    ).toEqual({ high: { effort: "high" } })

    expect(
      ProviderTransform.reasoningVariants(
        model([{ type: "effort", values: ["max"] }]),
        target("@ai-sdk/anthropic", "k3"),
      ),
    ).toEqual({ max: { effort: "max" } })
  })

  test("maps Kimi effort metadata to adaptive thinking", () => {
    expect(
      ProviderTransform.reasoningVariants(
        model([{ type: "effort", values: ["low", "high", "max"] }]),
        target("@ai-sdk/anthropic", "kimi-k3"),
      ),
    ).toEqual({
      low: { thinking: { type: "adaptive", display: "summarized" }, effort: "low" },
      high: { thinking: { type: "adaptive", display: "summarized" }, effort: "high" },
      max: { thinking: { type: "adaptive", display: "summarized" }, effort: "max" },
    })
  })

  test("maps GitLab model efforts to provider-specific options", () => {
    const options = model([{ type: "effort", values: ["max"] }])
    const openai = target("gitlab-ai-provider", "duo-chat-gpt-5-6-sol", "gpt-sol")
    const anthropic = target("gitlab-ai-provider", "duo-chat-opus-4-8", "claude-opus")

    expect(ProviderTransform.reasoningVariants(options, openai)).toEqual({
      max: { reasoningEffort: "max" },
    })
    expect(ProviderTransform.reasoningVariants(options, anthropic)).toEqual({
      max: { thinking: { type: "adaptive", effort: "max" } },
    })
  })

  test("uses adaptive reasoning config for Anthropic models on Bedrock", () => {
    expect(
      ProviderTransform.reasoningVariants(
        model([{ type: "effort", values: ["high"] }]),
        target("@ai-sdk/amazon-bedrock", "anthropic.claude-opus-4-7-v1:0"),
      ),
    ).toEqual({
      high: {
        reasoningConfig: {
          type: "adaptive",
          maxReasoningEffort: "high",
          display: "summarized",
        },
      },
    })
  })

  test("uses adaptive reasoning config for Claude Opus 5 on Bedrock", () => {
    const result = ProviderTransform.reasoningVariants(
      model([{ type: "effort", values: ["low", "medium", "high", "xhigh", "max"] }]),
      target("@ai-sdk/amazon-bedrock", "us.anthropic.claude-opus-5"),
    )
    expect(Object.keys(result ?? {})).toEqual(["low", "medium", "high", "xhigh", "max"])
    expect(result?.high).toEqual({
      reasoningConfig: {
        type: "adaptive",
        maxReasoningEffort: "high",
        display: "summarized",
      },
    })
  })

  test("combines effort with extended thinking for Claude Opus 4.5 on Bedrock", () => {
    expect(
      ProviderTransform.reasoningVariants(
        model([{ type: "effort", values: ["high"] }]),
        target("@ai-sdk/amazon-bedrock", "us.anthropic.claude-opus-4-5-20251101-v1:0"),
      ),
    ).toEqual({
      high: {
        reasoningConfig: {
          type: "enabled",
          budgetTokens: 16_000,
          maxReasoningEffort: "high",
        },
      },
    })
  })

  test("does not replace unsupported Anthropic Bedrock effort options with token budgets", () => {
    expect(
      ProviderTransform.reasoningVariants(
        model([{ type: "effort", values: ["high"] }]),
        target("@ai-sdk/amazon-bedrock", "anthropic.claude-sonnet-4-v1:0"),
      ),
    ).toEqual({})
  })

  test.each([
    ["@openrouter/ai-sdk-provider", { reasoning: { max_tokens: 16_000 } }],
    ["@ai-sdk/anthropic", { thinking: { type: "enabled", budgetTokens: 16_000 } }],
    ["@ai-sdk/google-vertex/anthropic", { thinking: { type: "enabled", budgetTokens: 16_000 } }],
    ["@ai-sdk/google", { thinkingConfig: { includeThoughts: true, thinkingBudget: 16_000 } }],
    ["@ai-sdk/google-vertex", { thinkingConfig: { includeThoughts: true, thinkingBudget: 16_000 } }],
    ["@ai-sdk/amazon-bedrock", { reasoningConfig: { type: "enabled", budgetTokens: 16_000 } }],
    ["@ai-sdk/cohere", { thinking: { type: "enabled", tokenBudget: 16_000 } }],
    ["@ai-sdk/alibaba", { enableThinking: true, thinkingBudget: 16_000 }],
  ])("converts token budgets for %s", (npm, high) => {
    const variants = ProviderTransform.reasoningVariants(model([{ type: "budget_tokens", min: 1_024 }]), target(npm))
    expect(variants?.high).toEqual(high)
    expect(Object.keys(variants ?? {})).toEqual(["high", "max"])
  })

  test("maps null effort to none", () => {
    expect(
      ProviderTransform.reasoningVariants(model([{ type: "effort", values: [null] }]), target("@ai-sdk/openai")),
    ).toEqual({
      none: {
        reasoningEffort: "none",
        reasoningSummary: "auto",
        include: ["reasoning.encrypted_content"],
      },
    })
  })

  test.each([
    ["@ai-sdk/alibaba", { none: { enableThinking: false }, high: { enableThinking: true } }],
    [
      "@ai-sdk/cohere",
      {
        none: { thinking: { type: "disabled" } },
        high: { thinking: { type: "enabled" } },
      },
    ],
  ])("converts toggle options for %s", (npm, expected) => {
    expect(ProviderTransform.reasoningVariants(model([{ type: "toggle" }]), target(npm))).toEqual(expected)
  })

  test("combines Cohere toggle and budget options", () => {
    expect(
      ProviderTransform.reasoningVariants(
        model([{ type: "toggle" }, { type: "budget_tokens", min: 1 }]),
        target("@ai-sdk/cohere"),
      ),
    ).toEqual({
      none: { thinking: { type: "disabled" } },
      high: { thinking: { type: "enabled", tokenBudget: 16_000 } },
      max: { thinking: { type: "enabled", tokenBudget: 31_999 } },
    })
  })

  test("generates bounded high and max token budgets", () => {
    expect(
      ProviderTransform.reasoningVariants(
        model([{ type: "budget_tokens", min: 1_024, max: 64_000 }]),
        target("@ai-sdk/anthropic"),
      ),
    ).toEqual({
      high: { thinking: { type: "enabled", budgetTokens: 16_000 } },
      max: { thinking: { type: "enabled", budgetTokens: 31_999 } },
    })
  })

  test("caps token budgets below the model output limit", () => {
    const anthropic = target("@ai-sdk/anthropic")
    anthropic.limit.output = 5_000
    expect(
      ProviderTransform.reasoningVariants(model([{ type: "budget_tokens", min: 1_024, max: 64_000 }]), anthropic),
    ).toEqual({
      high: { thinking: { type: "enabled", budgetTokens: 2_500 } },
      max: { thinking: { type: "enabled", budgetTokens: 4_999 } },
    })
  })

  test("derives high and max budgets when models.dev omits max", () => {
    expect(
      ProviderTransform.reasoningVariants(
        model([{ type: "budget_tokens", min: 1_024 }]),
        target("@ai-sdk/anthropic", "claude-haiku-4-5"),
      ),
    ).toEqual({
      high: { thinking: { type: "enabled", budgetTokens: 16_000 } },
      max: { thinking: { type: "enabled", budgetTokens: 31_999 } },
    })
  })

  test("preserves explicit inclusive budget maxima", () => {
    expect(
      ProviderTransform.reasoningVariants(
        model([{ type: "budget_tokens", min: 1_024, max: 24_576 }]),
        target("@ai-sdk/google", "gemini-2.5-pro"),
      ),
    ).toEqual({
      high: { thinkingConfig: { includeThoughts: true, thinkingBudget: 12_288 } },
      max: { thinkingConfig: { includeThoughts: true, thinkingBudget: 24_576 } },
    })
  })

  test("prefers effort options over token budgets", () => {
    expect(
      ProviderTransform.reasoningVariants(
        model([
          { type: "budget_tokens", min: 1_024, max: 64_000 },
          { type: "effort", values: ["low"] },
        ]),
        target("@ai-sdk/openai"),
      ),
    ).toEqual({
      low: {
        reasoningEffort: "low",
        reasoningSummary: "auto",
        include: ["reasoning.encrypted_content"],
      },
    })
  })

  test("does not replace unsupported effort options with heuristic variants", () => {
    expect(
      ProviderTransform.reasoningVariants(model([{ type: "effort", values: ["high"] }]), target("@ai-sdk/perplexity")),
    ).toEqual({})
  })

  test("leaves unsupported toggle options for heuristic fallback", () => {
    expect(ProviderTransform.reasoningVariants(model([{ type: "toggle" }]), target("@ai-sdk/openai"))).toBeUndefined()
  })

  test("uses model-family options for gateway and GitHub Copilot", () => {
    const effort = model([{ type: "effort", values: ["high"] }])
    expect(ProviderTransform.reasoningVariants(effort, target("@ai-sdk/gateway", "anthropic/claude-sonnet-4"))).toEqual(
      {
        high: { thinking: { type: "adaptive", display: "summarized" }, effort: "high" },
      },
    )
    expect(ProviderTransform.reasoningVariants(effort, target("@ai-sdk/gateway", "google/gemini-3-pro"))).toEqual({
      high: { thinkingConfig: { includeThoughts: true, thinkingLevel: "high" } },
    })
    expect(ProviderTransform.reasoningVariants(effort, target("@ai-sdk/github-copilot", "gemini-3-pro"))).toEqual({})
  })

  test.each(["@ai-sdk/cohere", "@ai-sdk/perplexity", "@ai-sdk/vercel", "@ai-sdk/alibaba"])(
    "does not invent effort controls for %s",
    (npm) => {
      expect(ProviderTransform.reasoningVariants(model([{ type: "effort", values: ["high"] }]), target(npm))).toEqual(
        {},
      )
    },
  )
})

describe("ProviderTransform.variants", () => {
  const createMockModel = (overrides: Partial<any> = {}): any => ({
    id: "test/test-model",
    providerID: "test",
    api: {
      id: "test-model",
      url: "https://api.test.com",
      npm: "@ai-sdk/openai",
    },
    name: "Test Model",
    capabilities: {
      temperature: true,
      reasoning: true,
      attachment: true,
      toolcall: true,
      input: { text: true, audio: false, image: true, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    cost: {
      input: 0.001,
      output: 0.002,
      cache: { read: 0.0001, write: 0.0002 },
    },
    limit: {
      context: 200_000,
      output: 64_000,
    },
    status: "active",
    options: {},
    headers: {},
    release_date: "2024-01-01",
    ...overrides,
  })

  test("returns empty object when model has no reasoning capabilities", () => {
    const model = createMockModel({
      capabilities: { reasoning: false },
    })
    const result = ProviderTransform.variants(model)
    expect(result).toEqual({})
  })

  test("deepseek returns empty object", () => {
    const model = createMockModel({
      id: "deepseek/deepseek-chat",
      providerID: "deepseek",
      api: {
        id: "deepseek-chat",
        url: "https://api.deepseek.com",
        npm: "@ai-sdk/openai-compatible",
      },
    })
    const result = ProviderTransform.variants(model)
    expect(result).toEqual({})
  })

  test("minimax returns empty object", () => {
    const model = createMockModel({
      id: "minimax/minimax-model",
      providerID: "minimax",
      api: {
        id: "minimax-model",
        url: "https://api.minimax.com",
        npm: "@ai-sdk/openai-compatible",
      },
    })
    const result = ProviderTransform.variants(model)
    expect(result).toEqual({})
  })

  test("minimax m3 using anthropic returns thinking toggles", () => {
    const model = createMockModel({
      id: "minimax/minimax-m3",
      providerID: "minimax",
      api: {
        id: "MiniMax-M3",
        url: "https://api.minimax.com/anthropic/v1",
        npm: "@ai-sdk/anthropic",
      },
    })
    const result = ProviderTransform.variants(model)
    expect(result).toEqual({
      none: { thinking: { type: "disabled" } },
      thinking: { thinking: { type: "adaptive" } },
    })
  })

  test("minimax m3 using openai-compatible returns thinking toggles", () => {
    const model = createMockModel({
      id: "minimax/minimax-m3",
      providerID: "minimax",
      api: {
        id: "minimax-m3",
        url: "https://api.minimax.com/v1",
        npm: "@ai-sdk/openai-compatible",
      },
    })
    expect(ProviderTransform.variants(model)).toEqual({
      none: { thinking: { type: "disabled" } },
      thinking: { thinking: { type: "adaptive" } },
    })
  })

  test.each(["nvidia", "lilac"])("%s minimax m3 returns chat template thinking toggles", (providerID) => {
    const model = createMockModel({
      id: `${providerID}/minimaxai/minimax-m3`,
      providerID,
      api: {
        id: "minimaxai/minimax-m3",
        url: "https://api.example.com/v1",
        npm: "@ai-sdk/openai-compatible",
      },
    })
    expect(ProviderTransform.variants(model)).toEqual({
      none: { chat_template_kwargs: { thinking_mode: "disabled" } },
      thinking: { chat_template_kwargs: { thinking_mode: "enabled" } },
    })
  })

  test("glm returns empty object", () => {
    const model = createMockModel({
      id: "glm/glm-4",
      providerID: "glm",
      api: {
        id: "glm-4",
        url: "https://api.glm.com",
        npm: "@ai-sdk/openai-compatible",
      },
    })
    const result = ProviderTransform.variants(model)
    expect(result).toEqual({})
  })

  test("glm-5.2 returns native effort variants for openai-compatible providers", () => {
    const model = createMockModel({
      id: "zhipuai/glm-5.2",
      providerID: "zhipuai",
      api: {
        id: "glm-5.2",
        url: "https://open.bigmodel.cn/api/paas/v4",
        npm: "@ai-sdk/openai-compatible",
      },
    })
    expect(ProviderTransform.variants(model)).toEqual({
      high: { reasoningEffort: "high" },
      max: { reasoningEffort: "max" },
    })
  })

  test("recognizes GLM-5.2 provider model IDs", () => {
    for (const id of ["accounts/fireworks/models/glm-5p2", "zai-org-glm-5-2", "umans-glm-5.2"]) {
      const model = createMockModel({
        id: `test/${id}`,
        api: {
          id,
          url: "https://api.test.com",
          npm: "@ai-sdk/openai-compatible",
        },
      })
      expect(ProviderTransform.variants(model)).toEqual({
        high: { reasoningEffort: "high" },
        max: { reasoningEffort: "max" },
      })
    }
  })

  test("recognizes GLM-5.2 from the API ID when the configured model ID is an alias", () => {
    const model = createMockModel({
      id: "custom/my-glm",
      api: {
        id: "accounts/fireworks/models/glm-5p2",
        url: "https://api.fireworks.ai/inference/v1",
        npm: "@ai-sdk/openai-compatible",
      },
    })
    expect(ProviderTransform.variants(model)).toEqual({
      high: { reasoningEffort: "high" },
      max: { reasoningEffort: "max" },
    })
  })

  test("glm-5.2 returns openrouter effort variants for openrouter", () => {
    const model = createMockModel({
      id: "openrouter/z-ai/glm-5.2",
      providerID: "openrouter",
      api: {
        id: "z-ai/glm-5.2",
        url: "https://openrouter.ai/api/v1",
        npm: "@openrouter/ai-sdk-provider",
      },
    })
    expect(ProviderTransform.variants(model)).toEqual({
      high: { reasoning: { effort: "high" } },
      xhigh: { reasoning: { effort: "xhigh" } },
    })
  })

  test("glm-5.2 returns effort variants for anthropic-compatible providers", () => {
    const model = createMockModel({
      id: "zai-coding-plan/glm-5.2",
      providerID: "zai-coding-plan",
      api: {
        id: "glm-5.2",
        url: "https://api.z.ai/api/anthropic",
        npm: "@ai-sdk/anthropic",
      },
    })
    expect(ProviderTransform.variants(model)).toEqual({
      high: { effort: "high" },
      max: { effort: "max" },
    })
  })

  test("glm-5.2 falls back to provider defaults for other packages", () => {
    const model = createMockModel({
      id: "test/glm-5.2",
      api: {
        id: "glm-5.2",
        url: "https://api.test.com",
        npm: "@ai-sdk/amazon-bedrock",
      },
    })
    expect(ProviderTransform.variants(model)).toEqual({
      low: { reasoningConfig: { type: "enabled", maxReasoningEffort: "low" } },
      medium: { reasoningConfig: { type: "enabled", maxReasoningEffort: "medium" } },
      high: { reasoningConfig: { type: "enabled", maxReasoningEffort: "high" } },
    })
  })

  test("mistral models with reasoning support return variants", () => {
    const model = createMockModel({
      id: "mistral/mistral-small-latest",
      providerID: "mistral",
      api: {
        id: "mistral-small-latest",
        url: "https://api.mistral.com",
        npm: "@ai-sdk/mistral",
      },
      capabilities: { reasoning: true },
    })
    const result = ProviderTransform.variants(model)
    expect(result).toEqual({
      high: { reasoningEffort: "high" },
    })
  })

  test("mistral-medium-3.5 with reasoning returns variants", () => {
    const model = createMockModel({
      id: "mistral/mistral-medium-3.5",
      providerID: "mistral",
      api: {
        id: "mistral-medium-3.5",
        url: "https://api.mistral.com",
        npm: "@ai-sdk/mistral",
      },
      capabilities: { reasoning: true },
    })
    const result = ProviderTransform.variants(model)
    expect(result).toEqual({
      high: { reasoningEffort: "high" },
    })
  })

  test("mistral without reasoning returns empty object", () => {
    const model = createMockModel({
      id: "mistral/mistral-large",
      providerID: "mistral",
      api: {
        id: "mistral-large-latest",
        url: "https://api.mistral.com",
        npm: "@ai-sdk/mistral",
      },
      capabilities: { reasoning: false },
    })
    const result = ProviderTransform.variants(model)
    expect(result).toEqual({})
  })

  test("mistral large with reasoning returns empty object (only small supports reasoning)", () => {
    const model = createMockModel({
      id: "mistral/mistral-large",
      providerID: "mistral",
      api: {
        id: "mistral-large-latest",
        url: "https://api.mistral.com",
        npm: "@ai-sdk/mistral",
      },
      capabilities: { reasoning: true },
    })
    const result = ProviderTransform.variants(model)
    expect(result).toEqual({})
  })

  describe("@openrouter/ai-sdk-provider", () => {
    test("returns widely supported efforts for other reasoning models", () => {
      const model = createMockModel({
        id: "openrouter/test-model",
        providerID: "openrouter",
        api: {
          id: "test-model",
          url: "https://openrouter.ai",
          npm: "@openrouter/ai-sdk-provider",
        },
      })
      const result = ProviderTransform.variants(model)
      expect(Object.keys(result)).toEqual(["low", "medium", "high"])
      expect(result.medium).toEqual({ reasoning: { effort: "medium" } })
    })

    test("gpt models return OPENAI_EFFORTS with reasoning", () => {
      const model = createMockModel({
        id: "openrouter/gpt-4",
        providerID: "openrouter",
        api: {
          id: "gpt-4",
          url: "https://openrouter.ai",
          npm: "@openrouter/ai-sdk-provider",
        },
      })
      const result = ProviderTransform.variants(model)
      expect(Object.keys(result)).toEqual(["none", "minimal", "low", "medium", "high", "xhigh"])
      expect(result.low).toEqual({ reasoning: { effort: "low" } })
      expect(result.high).toEqual({ reasoning: { effort: "high" } })
    })

    for (const testCase of [
      { id: "openai/o3-mini", efforts: ["none", "minimal", "low", "medium", "high", "xhigh"] },
      { id: "openai/gpt-5.4", efforts: ["none", "low", "medium", "high", "xhigh"] },
      { id: "openai/gpt-5-pro", efforts: ["high"] },
      { id: "openai/gpt-5.5-pro", efforts: ["medium", "high", "xhigh"] },
      { id: "openai/gpt-5.2-codex", efforts: ["low", "medium", "high", "xhigh"] },
      { id: "openai/gpt-5.3-codex", efforts: ["none", "low", "medium", "high", "xhigh"] },
      { id: "openai/gpt-5.3-codex-max", efforts: ["none", "low", "medium", "high", "xhigh"] },
      { id: "openai/gpt-5-chat-latest", efforts: [] },
      { id: "openai/gpt-5.2-chat-latest", efforts: ["medium"] },
    ]) {
      test(`${testCase.id} returns supported OpenAI reasoning efforts`, () => {
        const result = ProviderTransform.variants(
          createMockModel({
            id: testCase.id,
            providerID: "openrouter",
            api: {
              id: testCase.id,
              url: "https://openrouter.ai",
              npm: "@openrouter/ai-sdk-provider",
            },
          }),
        )
        expect(Object.keys(result)).toEqual(testCase.efforts)
      })
    }

    test("gemini-3 returns widely supported efforts with reasoning", () => {
      const model = createMockModel({
        id: "openrouter/gemini-3-5-pro",
        providerID: "openrouter",
        api: {
          id: "gemini-3-5-pro",
          url: "https://openrouter.ai",
          npm: "@openrouter/ai-sdk-provider",
        },
      })
      const result = ProviderTransform.variants(model)
      expect(Object.keys(result)).toEqual(["low", "medium", "high"])
    })

    test("grok-4 uses the provider's standard efforts", () => {
      const model = createMockModel({
        id: "openrouter/grok-4",
        providerID: "openrouter",
        api: {
          id: "grok-4",
          url: "https://openrouter.ai",
          npm: "@openrouter/ai-sdk-provider",
        },
      })
      const result = ProviderTransform.variants(model)
      expect(Object.keys(result)).toEqual(["low", "medium", "high"])
      expect(result.medium).toEqual({ reasoning: { effort: "medium" } })
    })

    test("grok-3-mini returns low and high with reasoning", () => {
      const model = createMockModel({
        id: "openrouter/grok-3-mini",
        providerID: "openrouter",
        api: {
          id: "grok-3-mini",
          url: "https://openrouter.ai",
          npm: "@openrouter/ai-sdk-provider",
        },
      })
      const result = ProviderTransform.variants(model)
      expect(Object.keys(result)).toEqual(["low", "high"])
      expect(result.low).toEqual({ reasoning: { effort: "low" } })
      expect(result.high).toEqual({ reasoning: { effort: "high" } })
    })
  })

  describe("@ai-sdk/gateway", () => {
    test("configured anthropic aliases route by the API ID", () => {
      const model = createMockModel({
        id: "my-claude",
        providerID: "gateway",
        api: {
          id: "anthropic/claude-sonnet-4-6",
          url: "https://gateway.ai",
          npm: "@ai-sdk/gateway",
        },
      })
      const result = ProviderTransform.variants(model)
      expect(Object.keys(result)).toEqual(["low", "medium", "high", "max"])
      expect(result.high).toEqual({
        thinking: {
          type: "adaptive",
        },
        effort: "high",
      })
    })

    test("configured google aliases route by the API ID", () => {
      const model = createMockModel({
        id: "my-gemini",
        providerID: "gateway",
        api: {
          id: "google/gemini-2.5-pro",
          url: "https://gateway.ai",
          npm: "@ai-sdk/gateway",
        },
      })
      expect(ProviderTransform.variants(model)).toEqual({
        high: { thinkingConfig: { includeThoughts: true, thinkingBudget: 16_000 } },
        max: { thinkingConfig: { includeThoughts: true, thinkingBudget: 32_768 } },
      })
    })

    test("anthropic sonnet 4.6 models return adaptive thinking options", () => {
      const model = createMockModel({
        id: "anthropic/claude-sonnet-4-6",
        providerID: "gateway",
        api: {
          id: "anthropic/claude-sonnet-4-6",
          url: "https://gateway.ai",
          npm: "@ai-sdk/gateway",
        },
      })
      const result = ProviderTransform.variants(model)
      expect(Object.keys(result)).toEqual(["low", "medium", "high", "max"])
      expect(result.medium).toEqual({
        thinking: {
          type: "adaptive",
        },
        effort: "medium",
      })
    })

    test("anthropic sonnet 4.6 dot-format models return adaptive thinking options", () => {
      const model = createMockModel({
        id: "anthropic/claude-sonnet-4-6",
        providerID: "gateway",
        api: {
          id: "anthropic/claude-sonnet-4.6",
          url: "https://gateway.ai",
          npm: "@ai-sdk/gateway",
        },
      })
      const result = ProviderTransform.variants(model)
      expect(Object.keys(result)).toEqual(["low", "medium", "high", "max"])
      expect(result.medium).toEqual({
        thinking: {
          type: "adaptive",
        },
        effort: "medium",
      })
    })

    test("anthropic opus 4.6 dot-format models return adaptive thinking options", () => {
      const model = createMockModel({
        id: "anthropic/claude-opus-4-6",
        providerID: "gateway",
        api: {
          id: "anthropic/claude-opus-4.6",
          url: "https://gateway.ai",
          npm: "@ai-sdk/gateway",
        },
      })
      const result = ProviderTransform.variants(model)
      expect(Object.keys(result)).toEqual(["low", "medium", "high", "max"])
      expect(result.high).toEqual({
        thinking: {
          type: "adaptive",
        },
        effort: "high",
      })
    })

    test("anthropic opus 4.7 models return adaptive thinking options with xhigh", () => {
      const model = createMockModel({
        id: "anthropic/claude-opus-4-7",
        providerID: "gateway",
        api: {
          id: "anthropic/claude-opus-4-7",
          url: "https://gateway.ai",
          npm: "@ai-sdk/gateway",
        },
      })
      const result = ProviderTransform.variants(model)
      expect(Object.keys(result)).toEqual(["low", "medium", "high", "xhigh", "max"])
      expect(result.xhigh).toEqual({
        thinking: {
          type: "adaptive",
          display: "summarized",
        },
        effort: "xhigh",
      })
      expect(result.max).toEqual({
        thinking: {
          type: "adaptive",
          display: "summarized",
        },
        effort: "max",
      })
    })

    test("anthropic opus 4.7 dot-format models return adaptive thinking options with xhigh", () => {
      const model = createMockModel({
        id: "anthropic/claude-opus-4-7",
        providerID: "gateway",
        api: {
          id: "anthropic/claude-opus-4.7",
          url: "https://gateway.ai",
          npm: "@ai-sdk/gateway",
        },
      })
      const result = ProviderTransform.variants(model)
      expect(Object.keys(result)).toEqual(["low", "medium", "high", "xhigh", "max"])
    })

    test("anthropic opus 4.8 forces display summarized for adaptive reasoning", () => {
      const model = createMockModel({
        id: "anthropic/claude-opus-4-8",
        providerID: "gateway",
        api: {
          id: "anthropic/claude-opus-4-8",
          url: "https://gateway.ai",
          npm: "@ai-sdk/gateway",
        },
      })
      const result = ProviderTransform.variants(model)
      expect(Object.keys(result)).toEqual(["low", "medium", "high", "xhigh", "max"])
      expect(result.high).toEqual({
        thinking: {
          type: "adaptive",
          display: "summarized",
        },
        effort: "high",
      })
    })

    test("anthropic sonnet 5 returns adaptive thinking options with xhigh", () => {
      const model = createMockModel({
        id: "anthropic/claude-sonnet-5",
        providerID: "gateway",
        api: {
          id: "anthropic/claude-sonnet-5",
          url: "https://gateway.ai",
          npm: "@ai-sdk/gateway",
        },
      })
      const result = ProviderTransform.variants(model)
      expect(Object.keys(result)).toEqual(["low", "medium", "high", "xhigh", "max"])
      expect(result.high).toEqual({
        thinking: {
          type: "adaptive",
          display: "summarized",
        },
        effort: "high",
      })
    })

    test("anthropic opus 4.6 omits display so it keeps the summarized default", () => {
      const model = createMockModel({
        id: "anthropic/claude-opus-4-6",
        providerID: "gateway",
        api: {
          id: "anthropic/claude-opus-4-6",
          url: "https://gateway.ai",
          npm: "@ai-sdk/gateway",
        },
      })
      const result = ProviderTransform.variants(model)
      expect(Object.keys(result)).toEqual(["low", "medium", "high", "max"])
      expect(result.high).toEqual({
        thinking: {
          type: "adaptive",
        },
        effort: "high",
      })
    })

    test("anthropic models return anthropic thinking options", () => {
      const model = createMockModel({
        id: "anthropic/claude-sonnet-4",
        providerID: "gateway",
        api: {
          id: "anthropic/claude-sonnet-4",
          url: "https://gateway.ai",
          npm: "@ai-sdk/gateway",
        },
      })
      const result = ProviderTransform.variants(model)
      expect(Object.keys(result)).toEqual(["high", "max"])
      expect(result.high).toEqual({
        thinking: {
          type: "enabled",
          budgetTokens: 16000,
        },
      })
      expect(result.max).toEqual({
        thinking: {
          type: "enabled",
          budgetTokens: 31999,
        },
      })
    })

    test("returns OPENAI_EFFORTS with reasoningEffort", () => {
      const model = createMockModel({
        id: "gateway/gateway-model",
        providerID: "gateway",
        api: {
          id: "gateway-model",
          url: "https://gateway.ai",
          npm: "@ai-sdk/gateway",
        },
      })
      const result = ProviderTransform.variants(model)
      expect(Object.keys(result)).toEqual(["none", "minimal", "low", "medium", "high", "xhigh"])
      expect(result.low).toEqual({ reasoningEffort: "low" })
      expect(result.high).toEqual({ reasoningEffort: "high" })
    })

    for (const testCase of [
      { id: "openai/gpt-5-5", efforts: ["none", "low", "medium", "high", "xhigh"] },
      { id: "openai/gpt-5-pro", efforts: ["high"] },
      { id: "openai/gpt-5-5-pro", efforts: ["medium", "high", "xhigh"] },
      { id: "openai/gpt-5-2-codex", efforts: ["low", "medium", "high", "xhigh"] },
      { id: "openai/gpt-5-3-codex", efforts: ["none", "low", "medium", "high", "xhigh"] },
      { id: "openai/gpt-5-3-codex-max", efforts: ["none", "low", "medium", "high", "xhigh"] },
      { id: "openai/gpt-5-chat-latest", efforts: [] },
      { id: "openai/gpt-5-2-chat-latest", efforts: ["medium"] },
    ]) {
      test(`${testCase.id} returns supported OpenAI reasoning efforts`, () => {
        const result = ProviderTransform.variants(
          createMockModel({
            id: testCase.id,
            providerID: "gateway",
            api: {
              id: testCase.id,
              url: "https://gateway.ai",
              npm: "@ai-sdk/gateway",
            },
          }),
        )
        expect(Object.keys(result)).toEqual(testCase.efforts)
      })
    }
  })

  describe("@ai-sdk/github-copilot", () => {
    test("standard models return low, medium, high", () => {
      const model = createMockModel({
        id: "gpt-4.5",
        providerID: "github-copilot",
        api: {
          id: "gpt-4.5",
          url: "https://api.githubcopilot.com",
          npm: "@ai-sdk/github-copilot",
        },
      })
      const result = ProviderTransform.variants(model)
      expect(Object.keys(result)).toEqual(["low", "medium", "high"])
      expect(result.low).toEqual({
        reasoningEffort: "low",
        reasoningSummary: "auto",
        include: ["reasoning.encrypted_content"],
      })
    })

    test("gpt-5.1-codex-max includes xhigh", () => {
      const model = createMockModel({
        id: "gpt-5.1-codex-max",
        providerID: "github-copilot",
        api: {
          id: "gpt-5.1-codex-max",
          url: "https://api.githubcopilot.com",
          npm: "@ai-sdk/github-copilot",
        },
      })
      const result = ProviderTransform.variants(model)
      expect(Object.keys(result)).toEqual(["low", "medium", "high", "xhigh"])
    })

    test("gpt-5.1-codex-mini does not include xhigh", () => {
      const model = createMockModel({
        id: "gpt-5.1-codex-mini",
        providerID: "github-copilot",
        api: {
          id: "gpt-5.1-codex-mini",
          url: "https://api.githubcopilot.com",
          npm: "@ai-sdk/github-copilot",
        },
      })
      const result = ProviderTransform.variants(model)
      expect(Object.keys(result)).toEqual(["low", "medium", "high"])
    })

    test("gpt-5.1-codex does not include xhigh", () => {
      const model = createMockModel({
        id: "gpt-5.1-codex",
        providerID: "github-copilot",
        api: {
          id: "gpt-5.1-codex",
          url: "https://api.githubcopilot.com",
          npm: "@ai-sdk/github-copilot",
        },
      })
      const result = ProviderTransform.variants(model)
      expect(Object.keys(result)).toEqual(["low", "medium", "high"])
    })

    test("gpt-5.2 includes xhigh", () => {
      const model = createMockModel({
        id: "gpt-5.2",
        providerID: "github-copilot",
        api: {
          id: "gpt-5.2",
          url: "https://api.githubcopilot.com",
          npm: "@ai-sdk/github-copilot",
        },
      })
      const result = ProviderTransform.variants(model)
      expect(Object.keys(result)).toEqual(["low", "medium", "high", "xhigh"])
      expect(result.xhigh).toEqual({
        reasoningEffort: "xhigh",
        reasoningSummary: "auto",
        include: ["reasoning.encrypted_content"],
      })
    })

    test("gpt-5.2-codex includes xhigh", () => {
      const model = createMockModel({
        id: "gpt-5.2-codex",
        providerID: "github-copilot",
        api: {
          id: "gpt-5.2-codex",
          url: "https://api.githubcopilot.com",
          npm: "@ai-sdk/github-copilot",
        },
      })
      const result = ProviderTransform.variants(model)
      expect(Object.keys(result)).toEqual(["low", "medium", "high", "xhigh"])
    })

    test("gpt-5.3-codex includes xhigh", () => {
      const model = createMockModel({
        id: "gpt-5.3-codex",
        providerID: "github-copilot",
        api: {
          id: "gpt-5.3-codex",
          url: "https://api.githubcopilot.com",
          npm: "@ai-sdk/github-copilot",
        },
      })
      const result = ProviderTransform.variants(model)
      expect(Object.keys(result)).toEqual(["low", "medium", "high", "xhigh"])
    })

    test("gpt-5.4 includes xhigh", () => {
      const model = createMockModel({
        id: "gpt-5.4",
        release_date: "2026-03-05",
        providerID: "github-copilot",
        api: {
          id: "gpt-5.4",
          url: "https://api.githubcopilot.com",
          npm: "@ai-sdk/github-copilot",
        },
      })
      const result = ProviderTransform.variants(model)
      expect(Object.keys(result)).toEqual(["low", "medium", "high", "xhigh"])
    })
  })

  describe("@ai-sdk/cerebras", () => {
    test("returns WIDELY_SUPPORTED_EFFORTS with reasoningEffort", () => {
      const model = createMockModel({
        id: "cerebras/llama-4",
        providerID: "cerebras",
        api: {
          id: "llama-4-sc",
          url: "https://api.cerebras.ai",
          npm: "@ai-sdk/cerebras",
        },
      })
      const result = ProviderTransform.variants(model)
      expect(Object.keys(result)).toEqual(["low", "medium", "high"])
      expect(result.low).toEqual({ reasoningEffort: "low" })
      expect(result.high).toEqual({ reasoningEffort: "high" })
    })
  })

  describe("@ai-sdk/togetherai", () => {
    test("returns WIDELY_SUPPORTED_EFFORTS with reasoningEffort", () => {
      const model = createMockModel({
        id: "togetherai/llama-4",
        providerID: "togetherai",
        api: {
          id: "llama-4-sc",
          url: "https://api.togetherai.com",
          npm: "@ai-sdk/togetherai",
        },
      })
      const result = ProviderTransform.variants(model)
      expect(Object.keys(result)).toEqual(["low", "medium", "high"])
      expect(result.low).toEqual({ reasoningEffort: "low" })
      expect(result.high).toEqual({ reasoningEffort: "high" })
    })
  })

  describe("@ai-sdk/xai", () => {
    test("grok-4.5 uses standard reasoning efforts", () => {
      const model = createMockModel({
        id: "xai/grok-4.5",
        providerID: "xai",
        api: {
          id: "grok-4.5",
          url: "https://api.x.ai",
          npm: "@ai-sdk/xai",
        },
      })
      const result = ProviderTransform.variants(model)
      expect(Object.keys(result)).toEqual(["low", "medium", "high"])
      expect(result.medium).toEqual({ reasoningEffort: "medium" })
    })

    test("grok-3-mini returns low and high with reasoningEffort", () => {
      const model = createMockModel({
        id: "xai/grok-3-mini",
        providerID: "xai",
        api: {
          id: "grok-3-mini",
          url: "https://api.x.ai",
          npm: "@ai-sdk/xai",
        },
      })
      const result = ProviderTransform.variants(model)
      expect(Object.keys(result)).toEqual(["low", "high"])
      expect(result.low).toEqual({ reasoningEffort: "low" })
      expect(result.high).toEqual({ reasoningEffort: "high" })
    })
  })

  describe("@ai-sdk/deepinfra", () => {
    test("returns WIDELY_SUPPORTED_EFFORTS with reasoningEffort", () => {
      const model = createMockModel({
        id: "deepinfra/llama-4",
        providerID: "deepinfra",
        api: {
          id: "llama-4-sc",
          url: "https://api.deepinfra.com",
          npm: "@ai-sdk/deepinfra",
        },
      })
      const result = ProviderTransform.variants(model)
      expect(Object.keys(result)).toEqual(["low", "medium", "high"])
      expect(result.low).toEqual({ reasoningEffort: "low" })
      expect(result.high).toEqual({ reasoningEffort: "high" })
    })
  })

  describe("@ai-sdk/openai-compatible", () => {
    test("returns WIDELY_SUPPORTED_EFFORTS with reasoningEffort", () => {
      const model = createMockModel({
        id: "custom-provider/custom-model",
        providerID: "custom-provider",
        api: {
          id: "custom-model",
          url: "https://api.custom.com",
          npm: "@ai-sdk/openai-compatible",
        },
      })
      const result = ProviderTransform.variants(model)
      expect(Object.keys(result)).toEqual(["low", "medium", "high"])
      expect(result.low).toEqual({ reasoningEffort: "low" })
      expect(result.high).toEqual({ reasoningEffort: "high" })
    })

    test("north-mini-code-1-0 returns only none and high", () => {
      const model = createMockModel({
        id: "cohere/north-mini-code-1-0",
        providerID: "cohere",
        api: {
          id: "North-Mini-Code-1-0-latest",
          url: "https://api.cohere.com/compatibility/v1",
          npm: "@ai-sdk/openai-compatible",
        },
      })
      const result = ProviderTransform.variants(model)
      expect(result).toEqual({
        none: { reasoningEffort: "none" },
        high: { reasoningEffort: "high" },
      })
    })

    test("deepseek-v4 includes none (thinking disabled) and low/medium/high/max with reasoningEffort", () => {
      const model = createMockModel({
        id: "openai-compatible/deepseek-v4-1",
        providerID: "openai-compatible",
        api: {
          id: "deepseek-v4-1-latest",
          url: "https://api.deepseek.com",
          npm: "@ai-sdk/openai-compatible",
        },
      })
      const result = ProviderTransform.variants(model)
      expect(Object.keys(result).sort()).toEqual(["high", "low", "max", "medium", "none"].sort())
      expect(result.none).toEqual({ thinking: { type: "disabled" } })
      expect(result.low).toEqual({ reasoningEffort: "low" })
      expect(result.medium).toEqual({ reasoningEffort: "medium" })
      expect(result.high).toEqual({ reasoningEffort: "high" })
      expect(result.max).toEqual({ reasoningEffort: "max" })
    })
  })

  describe("@ai-sdk/azure", () => {
    test("o1-mini returns empty object", () => {
      const model = createMockModel({
        id: "o1-mini",
        providerID: "azure",
        api: {
          id: "o1-mini",
          url: "https://azure.com",
          npm: "@ai-sdk/azure",
        },
      })
      const result = ProviderTransform.variants(model)
      expect(result).toEqual({})
    })

    test("standard azure models return custom efforts with reasoningSummary", () => {
      const model = createMockModel({
        id: "o1",
        providerID: "azure",
        api: {
          id: "o1",
          url: "https://azure.com",
          npm: "@ai-sdk/azure",
        },
      })
      const result = ProviderTransform.variants(model)
      expect(Object.keys(result)).toEqual(["low", "medium", "high"])
      expect(result.low).toEqual({
        reasoningEffort: "low",
        reasoningSummary: "auto",
        include: ["reasoning.encrypted_content"],
      })
    })

    test("gpt-5 adds minimal effort", () => {
      const model = createMockModel({
        id: "gpt-5",
        providerID: "azure",
        api: {
          id: "gpt-5",
          url: "https://azure.com",
          npm: "@ai-sdk/azure",
        },
      })
      const result = ProviderTransform.variants(model)
      expect(Object.keys(result)).toEqual(["minimal", "low", "medium", "high"])
    })

    for (const testCase of [
      { id: "gpt-5-1", efforts: ["none", "low", "medium", "high"] },
      { id: "gpt-5-4", efforts: ["none", "low", "medium", "high", "xhigh"] },
      { id: "gpt-5.4", efforts: ["none", "low", "medium", "high", "xhigh"] },
      { id: "gpt-5-5", efforts: ["none", "low", "medium", "high", "xhigh"] },
    ]) {
      test(`${testCase.id} returns supported Azure reasoning efforts`, () => {
        const result = ProviderTransform.variants(
          createMockModel({
            id: testCase.id,
            providerID: "azure",
            api: {
              id: testCase.id,
              url: "https://azure.com",
              npm: "@ai-sdk/azure",
            },
          }),
        )
        expect(Object.keys(result)).toEqual(testCase.efforts)
      })
    }
  })

  describe("@ai-sdk/openai", () => {
    test("gpt-5-pro returns only high effort", () => {
      const model = createMockModel({
        id: "gpt-5-pro",
        providerID: "openai",
        api: {
          id: "gpt-5-pro",
          url: "https://api.openai.com",
          npm: "@ai-sdk/openai",
        },
      })
      const result = ProviderTransform.variants(model)
      expect(Object.keys(result)).toEqual(["high"])
    })

    test("standard openai models return custom efforts with reasoningSummary", () => {
      const model = createMockModel({
        id: "gpt-5",
        providerID: "openai",
        api: {
          id: "gpt-5",
          url: "https://api.openai.com",
          npm: "@ai-sdk/openai",
        },
        release_date: "2024-06-01",
      })
      const result = ProviderTransform.variants(model)
      expect(Object.keys(result)).toEqual(["minimal", "low", "medium", "high"])
      expect(result.low).toEqual({
        reasoningEffort: "low",
        reasoningSummary: "auto",
        include: ["reasoning.encrypted_content"],
      })
    })

    test("models after 2025-11-13 include 'none' effort", () => {
      const model = createMockModel({
        id: "gpt-5-nano",
        providerID: "openai",
        api: {
          id: "gpt-5-nano",
          url: "https://api.openai.com",
          npm: "@ai-sdk/openai",
        },
        release_date: "2025-11-14",
      })
      const result = ProviderTransform.variants(model)
      expect(Object.keys(result)).toEqual(["none", "minimal", "low", "medium", "high"])
    })

    test("models after 2025-12-04 include 'xhigh' effort", () => {
      const model = createMockModel({
        id: "openai/gpt-5-reasoning",
        providerID: "openai",
        api: {
          id: "gpt-5-reasoning",
          url: "https://api.openai.com",
          npm: "@ai-sdk/openai",
        },
        release_date: "2025-12-05",
      })
      const result = ProviderTransform.variants(model)
      expect(Object.keys(result)).toEqual(["none", "minimal", "low", "medium", "high", "xhigh"])
    })

    for (const testCase of [
      { id: "o1", releaseDate: "2024-12-17", efforts: ["low", "medium", "high"] },
      { id: "o1-pro", releaseDate: "2025-03-19", efforts: ["low", "medium", "high"] },
      { id: "o3", releaseDate: "2025-04-16", efforts: ["low", "medium", "high"] },
      { id: "o3-mini", releaseDate: "2025-01-31", efforts: ["low", "medium", "high"] },
      { id: "o3-pro", releaseDate: "2025-06-10", efforts: ["low", "medium", "high"] },
      { id: "o4-mini", releaseDate: "2025-04-16", efforts: ["low", "medium", "high"] },
      { id: "o3-deep-research", releaseDate: "2025-06-26", efforts: ["medium"] },
      { id: "o4-mini-deep-research", releaseDate: "2025-06-26", efforts: ["medium"] },
      { id: "gpt-5.1", releaseDate: "2025-11-13", efforts: ["none", "low", "medium", "high"] },
      { id: "gpt-5.4", releaseDate: "2026-03-05", efforts: ["none", "low", "medium", "high", "xhigh"] },
      {
        id: "gpt-5.5",
        modelID: "gpt-5-5",
        releaseDate: "2026-04-23",
        efforts: ["none", "low", "medium", "high", "xhigh"],
      },
      { id: "gpt-5.4-pro", releaseDate: "2026-03-05", efforts: ["medium", "high", "xhigh"] },
      { id: "gpt-5.5-pro", releaseDate: "2026-04-23", efforts: ["medium", "high", "xhigh"] },
      { id: "gpt-5-codex", releaseDate: "2025-09-23", efforts: ["low", "medium", "high"] },
      { id: "gpt-5.1-codex", releaseDate: "2025-11-13", efforts: ["low", "medium", "high"] },
      { id: "gpt-5.1-codex-max", releaseDate: "2025-11-13", efforts: ["low", "medium", "high", "xhigh"] },
      { id: "gpt-5.2-codex", releaseDate: "2025-12-11", efforts: ["low", "medium", "high", "xhigh"] },
      { id: "gpt-5.3-codex", releaseDate: "2026-01-22", efforts: ["none", "low", "medium", "high", "xhigh"] },
      { id: "gpt-5.3-codex-max", releaseDate: "2026-01-22", efforts: ["none", "low", "medium", "high", "xhigh"] },
      { id: "gpt-5-chat-latest", releaseDate: "2025-08-07", efforts: [] },
      { id: "gpt-5.1-chat-latest", releaseDate: "2025-11-13", efforts: ["medium"] },
      { id: "gpt-5.2-chat-latest", releaseDate: "2025-12-11", efforts: ["medium"] },
    ]) {
      test(`${testCase.id} returns supported reasoning efforts`, () => {
        const result = ProviderTransform.variants(
          createMockModel({
            id: testCase.modelID ?? testCase.id,
            providerID: "openai",
            api: {
              id: testCase.id,
              url: "https://api.openai.com",
              npm: "@ai-sdk/openai",
            },
            release_date: testCase.releaseDate,
          }),
        )
        expect(Object.keys(result)).toEqual(testCase.efforts)
      })
    }

    test("gpt-50 (lookalike) does not get gpt-5 family treatment", () => {
      const model = createMockModel({
        id: "gpt-50",
        providerID: "openai",
        api: {
          id: "gpt-50",
          url: "https://api.openai.com",
          npm: "@ai-sdk/openai",
        },
        release_date: "2024-01-01",
      })
      const result = ProviderTransform.variants(model)
      expect(Object.keys(result)).toEqual(["low", "medium", "high"])
    })
  })

  describe("@ai-sdk/amazon-bedrock/mantle", () => {
    test("gpt-5.5 returns OpenAI-style reasoning variants", () => {
      const model = createMockModel({
        id: "openai.gpt-5.5",
        providerID: "amazon-bedrock",
        api: {
          id: "openai.gpt-5.5",
          url: "https://bedrock-mantle.us-east-2.api.aws/openai/v1",
          npm: "@ai-sdk/amazon-bedrock/mantle",
        },
        release_date: "2026-04-23",
      })
      const result = ProviderTransform.variants(model)
      expect(Object.keys(result)).toEqual(["none", "low", "medium", "high", "xhigh"])
      expect(result.medium).toEqual({
        reasoningEffort: "medium",
        reasoningSummary: "auto",
        include: ["reasoning.encrypted_content"],
      })
    })
  })

  describe("@ai-sdk/anthropic", () => {
    for (const testCase of [
      {
        name: "opus 4 dated",
        apiIds: ["claude-opus-4-20250514"],
        efforts: ["high", "max"],
        expectedHigh: { thinking: { type: "enabled", budgetTokens: 16000 } },
      },
      {
        name: "opus 4.5",
        apiIds: ["claude-opus-4-5-20251101", "claude-opus-4.5-20251101"],
        efforts: ["low", "medium", "high"],
        expectedHigh: { thinking: { type: "enabled", budgetTokens: 16000 }, effort: "high" },
      },
      {
        name: "sonnet 4.6",
        apiIds: ["claude-sonnet-4-6", "claude-sonnet-4.6"],
        efforts: ["low", "medium", "high", "max"],
        expectedHigh: { thinking: { type: "adaptive" }, effort: "high" },
      },
      {
        name: "opus 4.6",
        apiIds: ["claude-opus-4-6", "claude-opus-4.6"],
        efforts: ["low", "medium", "high", "max"],
        expectedHigh: { thinking: { type: "adaptive" }, effort: "high" },
      },
      {
        name: "opus 4.7",
        apiIds: ["claude-opus-4-7", "claude-opus-4.7"],
        efforts: ["low", "medium", "high", "xhigh", "max"],
        expectedHigh: { thinking: { type: "adaptive", display: "summarized" }, effort: "high" },
      },
      {
        name: "opus 4.8",
        apiIds: ["claude-opus-4-8", "claude-opus-4.8"],
        efforts: ["low", "medium", "high", "xhigh", "max"],
        expectedHigh: { thinking: { type: "adaptive", display: "summarized" }, effort: "high" },
      },
      {
        name: "sonnet 5",
        apiIds: ["claude-sonnet-5", "claude-sonnet-5-20260630"],
        efforts: ["low", "medium", "high", "xhigh", "max"],
        expectedHigh: { thinking: { type: "adaptive", display: "summarized" }, effort: "high" },
      },
      {
        name: "opus 5",
        apiIds: ["claude-opus-5", "claude-opus-5-20260724"],
        efforts: ["low", "medium", "high", "xhigh", "max"],
        expectedHigh: { thinking: { type: "adaptive", display: "summarized" }, effort: "high" },
      },
      {
        name: "unversioned future model",
        apiIds: ["claude-future"],
        efforts: ["low", "medium", "high", "xhigh", "max"],
        expectedHigh: { thinking: { type: "adaptive", display: "summarized" }, effort: "high" },
      },
      {
        name: "fable 5",
        apiIds: ["claude-fable-5"],
        efforts: ["low", "medium", "high", "xhigh", "max"],
        expectedHigh: { thinking: { type: "adaptive", display: "summarized" }, effort: "high" },
      },
    ]) {
      for (const apiId of testCase.apiIds) {
        test(`${testCase.name} ${apiId} returns supported reasoning efforts`, () => {
          const result = ProviderTransform.variants(
            createMockModel({
              id: `anthropic/${apiId}`,
              providerID: "anthropic",
              api: {
                id: apiId,
                url: "https://api.anthropic.com",
                npm: "@ai-sdk/anthropic",
              },
            }),
          )
          expect(Object.keys(result)).toEqual(testCase.efforts)
          expect(result.high).toEqual(testCase.expectedHigh)
        })
      }
    }

    test("github copilot opus 4.7 returns only medium reasoning effort", () => {
      const model = createMockModel({
        id: "claude-opus-4.7",
        providerID: "github-copilot",
        api: {
          id: "claude-opus-4.7",
          url: "https://api.githubcopilot.com/v1",
          npm: "@ai-sdk/anthropic",
        },
      })
      const result = ProviderTransform.variants(model)
      expect(result).toEqual({
        medium: {
          thinking: {
            type: "adaptive",
            display: "summarized",
          },
          effort: "medium",
        },
      })
    })

    test("returns high and max with thinking config", () => {
      const model = createMockModel({
        id: "anthropic/claude-4",
        providerID: "anthropic",
        api: {
          id: "claude-4",
          url: "https://api.anthropic.com",
          npm: "@ai-sdk/anthropic",
        },
      })
      const result = ProviderTransform.variants(model)
      expect(Object.keys(result)).toEqual(["high", "max"])
      expect(result.high).toEqual({
        thinking: {
          type: "enabled",
          budgetTokens: 16000,
        },
      })
      expect(result.max).toEqual({
        thinking: {
          type: "enabled",
          budgetTokens: 31999,
        },
      })
    })
  })

  describe("@ai-sdk/google-vertex/anthropic", () => {
    test("opus 4.8 uses adaptive reasoning for Vertex model IDs", () => {
      const result = ProviderTransform.variants(
        createMockModel({
          id: "google-vertex-anthropic/claude-opus-4-8@default",
          providerID: "google-vertex-anthropic",
          api: {
            id: "claude-opus-4-8@default",
            url: "https://us-central1-aiplatform.googleapis.com",
            npm: "@ai-sdk/google-vertex/anthropic",
          },
        }),
      )
      expect(Object.keys(result)).toEqual(["low", "medium", "high", "xhigh", "max"])
      expect(result.high).toEqual({
        thinking: {
          type: "adaptive",
          display: "summarized",
        },
        effort: "high",
      })
    })

    test("sonnet 5 uses adaptive reasoning for Vertex model IDs", () => {
      const result = ProviderTransform.variants(
        createMockModel({
          id: "google-vertex-anthropic/claude-sonnet-5@default",
          providerID: "google-vertex-anthropic",
          api: {
            id: "claude-sonnet-5@default",
            url: "https://us-central1-aiplatform.googleapis.com",
            npm: "@ai-sdk/google-vertex/anthropic",
          },
        }),
      )
      expect(Object.keys(result)).toEqual(["low", "medium", "high", "xhigh", "max"])
      expect(result.high).toEqual({
        thinking: {
          type: "adaptive",
          display: "summarized",
        },
        effort: "high",
      })
    })

    test("opus 5 uses adaptive reasoning for Vertex model IDs", () => {
      const result = ProviderTransform.variants(
        createMockModel({
          id: "google-vertex-anthropic/claude-opus-5@default",
          providerID: "google-vertex-anthropic",
          api: {
            id: "claude-opus-5@default",
            url: "https://us-central1-aiplatform.googleapis.com",
            npm: "@ai-sdk/google-vertex/anthropic",
          },
        }),
      )
      expect(Object.keys(result)).toEqual(["low", "medium", "high", "xhigh", "max"])
      expect(result.high).toEqual({
        thinking: {
          type: "adaptive",
          display: "summarized",
        },
        effort: "high",
      })
    })
  })

  describe("@ai-sdk/amazon-bedrock", () => {
    test("anthropic sonnet 4.6 returns adaptive reasoning options", () => {
      const model = createMockModel({
        id: "bedrock/anthropic-claude-sonnet-4-6",
        providerID: "bedrock",
        api: {
          id: "anthropic.claude-sonnet-4-6",
          url: "https://bedrock.amazonaws.com",
          npm: "@ai-sdk/amazon-bedrock",
        },
      })
      const result = ProviderTransform.variants(model)
      expect(Object.keys(result)).toEqual(["low", "medium", "high", "max"])
      expect(result.max).toEqual({
        reasoningConfig: {
          type: "adaptive",
          maxReasoningEffort: "max",
        },
      })
    })

    test("anthropic opus 4.7 returns adaptive reasoning options with xhigh", () => {
      const model = createMockModel({
        id: "bedrock/anthropic-claude-opus-4-7",
        providerID: "bedrock",
        api: {
          id: "anthropic.claude-opus-4-7",
          url: "https://bedrock.amazonaws.com",
          npm: "@ai-sdk/amazon-bedrock",
        },
      })
      const result = ProviderTransform.variants(model)
      expect(Object.keys(result)).toEqual(["low", "medium", "high", "xhigh", "max"])
      expect(result.xhigh).toEqual({
        reasoningConfig: {
          type: "adaptive",
          maxReasoningEffort: "xhigh",
          display: "summarized",
        },
      })
      expect(result.max).toEqual({
        reasoningConfig: {
          type: "adaptive",
          maxReasoningEffort: "max",
          display: "summarized",
        },
      })
    })

    test("anthropic opus 4.8 returns adaptive reasoning options with xhigh", () => {
      const result = ProviderTransform.variants(
        createMockModel({
          id: "bedrock/anthropic-claude-opus-4.8",
          providerID: "bedrock",
          api: {
            id: "anthropic.claude-opus-4.8",
            url: "https://bedrock.amazonaws.com",
            npm: "@ai-sdk/amazon-bedrock",
          },
        }),
      )
      expect(Object.keys(result)).toEqual(["low", "medium", "high", "xhigh", "max"])
      expect(result.high).toEqual({
        reasoningConfig: {
          type: "adaptive",
          maxReasoningEffort: "high",
          display: "summarized",
        },
      })
    })

    test("anthropic sonnet 5 returns adaptive reasoning options with xhigh", () => {
      const result = ProviderTransform.variants(
        createMockModel({
          id: "bedrock/anthropic-claude-sonnet-5",
          providerID: "bedrock",
          api: {
            id: "anthropic.claude-sonnet-5",
            url: "https://bedrock.amazonaws.com",
            npm: "@ai-sdk/amazon-bedrock",
          },
        }),
      )
      expect(Object.keys(result)).toEqual(["low", "medium", "high", "xhigh", "max"])
      expect(result.high).toEqual({
        reasoningConfig: {
          type: "adaptive",
          maxReasoningEffort: "high",
          display: "summarized",
        },
      })
    })

    test("anthropic opus 5 returns adaptive reasoning options with xhigh", () => {
      const result = ProviderTransform.variants(
        createMockModel({
          id: "bedrock/anthropic-claude-opus-5",
          providerID: "bedrock",
          api: {
            id: "us.anthropic.claude-opus-5-v1:0",
            url: "https://bedrock.amazonaws.com",
            npm: "@ai-sdk/amazon-bedrock",
          },
        }),
      )
      expect(Object.keys(result)).toEqual(["low", "medium", "high", "xhigh", "max"])
      expect(result.high).toEqual({
        reasoningConfig: {
          type: "adaptive",
          maxReasoningEffort: "high",
          display: "summarized",
        },
      })
    })

    test("returns WIDELY_SUPPORTED_EFFORTS with reasoningConfig", () => {
      const model = createMockModel({
        id: "bedrock/llama-4",
        providerID: "bedrock",
        api: {
          id: "llama-4-sc",
          url: "https://bedrock.amazonaws.com",
          npm: "@ai-sdk/amazon-bedrock",
        },
      })
      const result = ProviderTransform.variants(model)
      expect(Object.keys(result)).toEqual(["low", "medium", "high"])
      expect(result.low).toEqual({
        reasoningConfig: {
          type: "enabled",
          maxReasoningEffort: "low",
        },
      })
    })
  })

  for (const provider of [
    { name: "@ai-sdk/google", providerID: "google", url: "https://generativelanguage.googleapis.com" },
    { name: "@ai-sdk/google-vertex", providerID: "google-vertex", url: "https://vertexai.googleapis.com" },
  ]) {
    describe(provider.name, () => {
      for (const testCase of [
        {
          apiId: "gemini-2.5-pro",
          efforts: ["high", "max"],
          expectedHigh: { thinkingConfig: { includeThoughts: true, thinkingBudget: 16_000 } },
          expectedMax: { thinkingConfig: { includeThoughts: true, thinkingBudget: 32_768 } },
        },
        {
          apiId: "gemini-2.5-flash",
          efforts: ["high", "max"],
          expectedHigh: { thinkingConfig: { includeThoughts: true, thinkingBudget: 16_000 } },
          expectedMax: { thinkingConfig: { includeThoughts: true, thinkingBudget: 24_576 } },
        },
        {
          apiId: "gemini-3-pro-preview",
          efforts: ["low", "medium", "high"],
          expectedHigh: { thinkingConfig: { includeThoughts: true, thinkingLevel: "high" } },
        },
        {
          apiId: "gemini-3.1-pro-preview",
          efforts: ["low", "medium", "high"],
          expectedHigh: { thinkingConfig: { includeThoughts: true, thinkingLevel: "high" } },
        },
        {
          apiId: "gemini-3-flash-preview",
          efforts: ["minimal", "low", "medium", "high"],
          expectedHigh: { thinkingConfig: { includeThoughts: true, thinkingLevel: "high" } },
        },
        {
          apiId: "gemini-3.1-flash-lite",
          efforts: ["minimal", "low", "medium", "high"],
          expectedHigh: { thinkingConfig: { includeThoughts: true, thinkingLevel: "high" } },
        },
        {
          apiId: "gemini-3.1-flash-image-preview",
          efforts: ["minimal", "high"],
          expectedHigh: { thinkingConfig: { includeThoughts: true, thinkingLevel: "high" } },
        },
        {
          apiId: "gemini-3-pro-image-preview",
          efforts: ["high"],
          expectedHigh: { thinkingConfig: { includeThoughts: true, thinkingLevel: "high" } },
        },
      ]) {
        test(`${testCase.apiId} returns supported thinking controls`, () => {
          const result = ProviderTransform.variants(
            createMockModel({
              id: `${provider.providerID}/${testCase.apiId}`,
              providerID: provider.providerID,
              api: {
                id: testCase.apiId,
                url: provider.url,
                npm: provider.name,
              },
            }),
          )
          expect(Object.keys(result)).toEqual(testCase.efforts)
          expect(result.high).toEqual(testCase.expectedHigh)
          if (testCase.expectedMax) expect(result.max).toEqual(testCase.expectedMax)
        })
      }
    })
  }

  describe("@ai-sdk/cohere", () => {
    test("returns empty object", () => {
      const model = createMockModel({
        id: "cohere/command-r",
        providerID: "cohere",
        api: {
          id: "command-r",
          url: "https://api.cohere.com",
          npm: "@ai-sdk/cohere",
        },
      })
      const result = ProviderTransform.variants(model)
      expect(result).toEqual({})
    })
  })

  describe("@ai-sdk/groq", () => {
    test("returns none and WIDELY_SUPPORTED_EFFORTS with thinkingLevel", () => {
      const model = createMockModel({
        id: "groq/llama-4",
        providerID: "groq",
        api: {
          id: "llama-4-sc",
          url: "https://api.groq.com",
          npm: "@ai-sdk/groq",
        },
      })
      const result = ProviderTransform.variants(model)
      expect(Object.keys(result)).toEqual(["none", "low", "medium", "high"])
      expect(result.none).toEqual({
        reasoningEffort: "none",
      })
      expect(result.low).toEqual({
        reasoningEffort: "low",
      })
    })
  })

  describe("@ai-sdk/perplexity", () => {
    test("returns empty object", () => {
      const model = createMockModel({
        id: "perplexity/sonar-plus",
        providerID: "perplexity",
        api: {
          id: "sonar-plus",
          url: "https://api.perplexity.ai",
          npm: "@ai-sdk/perplexity",
        },
      })
      const result = ProviderTransform.variants(model)
      expect(result).toEqual({})
    })
  })

  describe("@jerome-benoit/sap-ai-provider-v2", () => {
    const sapModel = (apiId: string, releaseDate = "2024-01-01") =>
      createMockModel({
        id: `sap-ai-core/${apiId}`,
        providerID: "sap-ai-core",
        api: {
          id: apiId,
          url: "https://api.ai.sap",
          npm: "@jerome-benoit/sap-ai-provider-v2",
        },
        release_date: releaseDate,
      })

    for (const testCase of [
      {
        name: "sonnet 4.6",
        apiIds: ["anthropic--claude-sonnet-4-6"],
        efforts: ["low", "medium", "high", "max"],
        thinking: { type: "adaptive" },
      },
      {
        name: "opus 4.6",
        apiIds: ["anthropic--claude-4.6-opus", "anthropic--claude-4-6-opus"],
        efforts: ["low", "medium", "high", "max"],
        thinking: { type: "adaptive" },
      },
      {
        name: "opus 4.7",
        apiIds: ["anthropic--claude-4.7-opus", "anthropic--claude-4-7-opus"],
        efforts: ["low", "medium", "high", "xhigh", "max"],
        thinking: { type: "adaptive", display: "summarized" },
      },
      {
        name: "opus 4.8",
        apiIds: ["anthropic--claude-4.8-opus", "anthropic--claude-4-8-opus"],
        efforts: ["low", "medium", "high", "xhigh", "max"],
        thinking: { type: "adaptive", display: "summarized" },
      },
      {
        name: "sonnet 5",
        apiIds: ["anthropic--claude-sonnet-5", "anthropic--claude-5-sonnet"],
        efforts: ["low", "medium", "high", "xhigh", "max"],
        thinking: { type: "adaptive", display: "summarized" },
      },
      {
        name: "opus 5",
        apiIds: ["anthropic--claude-opus-5", "anthropic--claude-5-opus"],
        efforts: ["low", "medium", "high", "xhigh", "max"],
        thinking: { type: "adaptive", display: "summarized" },
      },
    ]) {
      for (const apiId of testCase.apiIds) {
        test(`${testCase.name} ${apiId} returns adaptive thinking variants under modelParams`, () => {
          const result = ProviderTransform.variants(sapModel(apiId))
          expect(Object.keys(result)).toEqual(testCase.efforts)
          for (const effort of testCase.efforts) {
            expect(result[effort]).toEqual({
              modelParams: {
                thinking: testCase.thinking,
                output_config: { effort },
              },
            })
          }
        })
      }
    }

    for (const apiId of ["anthropic--claude-sonnet-4", "anthropic--claude-4.5-opus"]) {
      test(`${apiId} returns budget_tokens variants under modelParams`, () => {
        const result = ProviderTransform.variants(sapModel(apiId))
        expect(Object.keys(result)).toEqual(["high", "max"])
        expect(result.high).toEqual({
          modelParams: { thinking: { type: "enabled", budget_tokens: 16000 } },
        })
        expect(result.max).toEqual({
          modelParams: { thinking: { type: "enabled", budget_tokens: 31999 } },
        })
      })
    }

    for (const testCase of [
      { apiId: "gemini-2.5-pro", maxBudget: 32768 },
      { apiId: "gemini-2.5-flash", maxBudget: 24576 },
    ]) {
      test(`${testCase.apiId} returns thinkingConfig variants under modelParams`, () => {
        const result = ProviderTransform.variants(sapModel(testCase.apiId))
        expect(Object.keys(result)).toEqual(["high", "max"])
        expect(result.high).toEqual({
          modelParams: { thinkingConfig: { includeThoughts: true, thinkingBudget: 16000 } },
        })
        expect(result.max).toEqual({
          modelParams: { thinkingConfig: { includeThoughts: true, thinkingBudget: testCase.maxBudget } },
        })
      })
    }

    for (const testCase of [
      { apiId: "gpt-5", releaseDate: "2025-08-07", efforts: ["minimal", "low", "medium", "high"] },
      { apiId: "gpt-5-mini", releaseDate: "2025-08-07", efforts: ["minimal", "low", "medium", "high"] },
      { apiId: "gpt-5-nano", releaseDate: "2025-08-07", efforts: ["minimal", "low", "medium", "high"] },
      { apiId: "gpt-5.4", releaseDate: "2026-01-15", efforts: ["none", "low", "medium", "high", "xhigh"] },
      { apiId: "azure-openai--o3-mini", releaseDate: "2024-01-01", efforts: ["low", "medium", "high"] },
    ]) {
      test(`${testCase.apiId} returns reasoning_effort variants under modelParams`, () => {
        const result = ProviderTransform.variants(sapModel(testCase.apiId, testCase.releaseDate))
        expect(Object.keys(result)).toEqual(testCase.efforts)
        for (const effort of testCase.efforts) {
          expect(result[effort]).toEqual({ modelParams: { reasoning_effort: effort } })
        }
      })
    }

    for (const apiId of [
      "gemini-3.1-flash-lite",
      "cohere--command-a-reasoning",
      "sonar-deep-research",
      "aws--llama-opus-4.7-fake",
    ]) {
      test(`${apiId} falls through to harmonized reasoning_effort fallback`, () => {
        const result = ProviderTransform.variants(sapModel(apiId))
        expect(Object.keys(result)).toEqual(["low", "medium", "high"])
        for (const effort of ["low", "medium", "high"]) {
          expect(result[effort]).toEqual({ modelParams: { reasoning_effort: effort } })
        }
      })
    }
  })

  describe("ai-gateway-provider (cloudflare-ai-gateway)", () => {
    const cfModel = (apiId: string, releaseDate = "2024-01-01") =>
      createMockModel({
        id: `cloudflare-ai-gateway/${apiId}`,
        providerID: "cloudflare-ai-gateway",
        api: {
          id: apiId,
          url: "https://gateway.ai.cloudflare.com/v1/compat",
          npm: "ai-gateway-provider",
        },
        release_date: releaseDate,
      })

    for (const testCase of [
      { id: "openai/gpt-5.4", efforts: ["none", "low", "medium", "high", "xhigh"] },
      { id: "openai/gpt-5.2-codex", efforts: ["low", "medium", "high", "xhigh"] },
      { id: "openai/gpt-5.3-codex", efforts: ["none", "low", "medium", "high", "xhigh"] },
      { id: "openai/gpt-5-pro", efforts: ["high"] },
      { id: "openai/gpt-5.2-pro", efforts: ["medium", "high", "xhigh"] },
      { id: "openai/gpt-5-chat-latest", efforts: [] },
      { id: "openai/gpt-5.2-chat-latest", efforts: ["medium"] },
    ]) {
      test(`${testCase.id} returns supported reasoning efforts`, () => {
        const result = ProviderTransform.variants(cfModel(testCase.id, "2026-03-05"))
        expect(Object.keys(result)).toEqual(testCase.efforts)
      })
    }

    test("openai gpt-4o (no reasoning) returns empty", () => {
      const model = cfModel("openai/gpt-4o")
      model.capabilities.reasoning = false
      const result = ProviderTransform.variants(model)
      expect(result).toEqual({})
    })

    test("non-openai upstream falls back to widely-supported OAI efforts", () => {
      const result = ProviderTransform.variants(cfModel("anthropic/claude-sonnet-4-6"))
      expect(result).toEqual({
        low: { reasoningEffort: "low" },
        medium: { reasoningEffort: "medium" },
        high: { reasoningEffort: "high" },
      })
    })
  })
})

describe("ProviderTransform.smallOptions - gpt-5 chat/search", () => {
  const createModel = (apiId: string) => {
    const model = {
      id: `openai/${apiId}`,
      providerID: "openai",
      api: {
        id: apiId,
        url: "https://api.openai.com",
        npm: "@ai-sdk/openai",
      },
      capabilities: { reasoning: true },
      limit: { output: 64_000 },
      release_date: "2026-01-01",
    } as any
    model.variants = ProviderTransform.variants(model)
    return model
  }

  for (const testCase of [
    { id: "gpt-5-chat-latest", options: { store: false } },
    {
      id: "gpt-5.1-chat-latest",
      options: {
        store: false,
        reasoningEffort: "medium",
        reasoningSummary: "auto",
        include: ["reasoning.encrypted_content"],
      },
    },
    {
      id: "gpt-5.2-chat-latest",
      options: {
        store: false,
        reasoningEffort: "medium",
        reasoningSummary: "auto",
        include: ["reasoning.encrypted_content"],
      },
    },
    {
      id: "gpt-5-search-api",
      options: {
        store: false,
        reasoningEffort: "none",
        reasoningSummary: "auto",
        include: ["reasoning.encrypted_content"],
      },
    },
  ]) {
    test(`${testCase.id} returns only supported small options`, () => {
      expect(ProviderTransform.smallOptions(createModel(testCase.id))).toEqual(testCase.options)
    })
  }
})

test("ProviderTransform.smallOptions preserves the weakest OpenRouter reasoning effort", () => {
  expect(
    ProviderTransform.smallOptions({
      providerID: "openrouter",
      api: {
        id: "google/gemini-3.5-flash",
        npm: "@openrouter/ai-sdk-provider",
      },
      variants: {
        low: { reasoning: { effort: "low" } },
        medium: { reasoning: { effort: "medium" } },
        high: { reasoning: { effort: "high" } },
      },
    } as any),
  ).toEqual({ reasoning: { effort: "low" } })
})

describe("ProviderTransform.smallOptions - google thinking controls", () => {
  const createGoogleModel = (apiId: string) => {
    const model = {
      id: `google/${apiId}`,
      providerID: "google",
      api: {
        id: apiId,
        url: "https://generativelanguage.googleapis.com",
        npm: "@ai-sdk/google",
      },
      capabilities: { reasoning: true },
      limit: { output: 64_000 },
    } as any
    model.variants = ProviderTransform.variants(model)
    return model
  }

  for (const testCase of [
    { id: "gemini-3-pro-preview", options: { thinkingConfig: { includeThoughts: true, thinkingLevel: "low" } } },
    { id: "gemini-3-flash-preview", options: { thinkingConfig: { includeThoughts: true, thinkingLevel: "minimal" } } },
    {
      id: "gemini-3.1-flash-image-preview",
      options: { thinkingConfig: { includeThoughts: true, thinkingLevel: "minimal" } },
    },
    { id: "gemini-3-pro-image-preview", options: { thinkingConfig: { includeThoughts: true, thinkingLevel: "high" } } },
    { id: "gemini-2.5-pro", options: { thinkingConfig: { includeThoughts: true, thinkingBudget: 16000 } } },
    { id: "gemini-2.5-flash", options: { thinkingConfig: { includeThoughts: true, thinkingBudget: 16000 } } },
  ]) {
    test(`${testCase.id} returns supported small thinking options`, () => {
      expect(ProviderTransform.smallOptions(createGoogleModel(testCase.id))).toEqual(testCase.options)
    })
  }

  test("uses the first configured variant when available", () => {
    expect(
      ProviderTransform.smallOptions({
        ...createGoogleModel("gemini-2.5-pro"),
        variants: {
          high: { thinkingConfig: { includeThoughts: true, thinkingBudget: 16000 } },
          max: { thinkingConfig: { includeThoughts: true, thinkingBudget: 32768 } },
        },
      }),
    ).toEqual({ thinkingConfig: { includeThoughts: true, thinkingBudget: 16000 } })
  })

  test("does not synthesize thinking options when variants are empty", () => {
    expect(ProviderTransform.smallOptions({ ...createGoogleModel("gemini-2.5-pro"), variants: {} })).toEqual({})
  })
})

describe("ProviderTransform.providerOptions - ai-gateway-provider", () => {
  const createModel = (overrides: Partial<any> = {}) =>
    ({
      id: "cloudflare-ai-gateway/openai/gpt-5.4",
      providerID: "cloudflare-ai-gateway",
      api: {
        id: "openai/gpt-5.4",
        url: "https://gateway.ai.cloudflare.com/v1/compat",
        npm: "ai-gateway-provider",
      },
      capabilities: {
        temperature: false,
        reasoning: true,
        attachment: true,
        toolcall: true,
        input: { text: true, audio: false, image: true, video: false, pdf: true },
        output: { text: true, audio: false, image: false, video: false, pdf: false },
        interleaved: false,
      },
      cost: { input: 1, output: 1, cache: { read: 0, write: 0 } },
      limit: { context: 1_000_000, output: 128_000 },
      status: "active",
      options: {},
      headers: {},
      release_date: "2026-03-05",
      ...overrides,
    }) as any

  test("routes options under openaiCompatible (the key @ai-sdk/openai-compatible reads)", () => {
    // Regression: previously fell back to providerID="cloudflare-ai-gateway",
    // which @ai-sdk/openai-compatible never reads, silently dropping reasoningEffort.
    const result = ProviderTransform.providerOptions(createModel(), { reasoningEffort: "high" })
    expect(result).toEqual({ openaiCompatible: { reasoningEffort: "high" } })
  })
})

describe("ProviderTransform.providerOptions - merge-gateway-ai-sdk-provider", () => {
  const model = {
    id: "merge-gateway/openai/gpt-5.6-sol",
    providerID: "merge-gateway",
    api: {
      id: "openai/gpt-5.6-sol",
      url: "https://api-gateway.merge.dev/v1/ai-sdk",
      npm: "merge-gateway-ai-sdk-provider",
    },
    capabilities: { reasoning: true },
  } as any

  test("routes normalized effort under the adapter's mergeGateway key", () => {
    expect(ProviderTransform.providerOptions(model, { reasoningEffort: "high" })).toEqual({
      mergeGateway: { reasoningEffort: "high" },
    })
  })
})

describe("ProviderTransform.options - kimi family adaptive thinking", () => {
  const createModel = (overrides: Record<string, any> = {}) =>
    ({
      id: "moonshotai/kimi-k2-thinking",
      providerID: "moonshotai",
      api: {
        id: "kimi-k2-thinking",
        url: "https://api.moonshot.ai/anthropic",
        npm: "@ai-sdk/anthropic",
      },
      name: "Kimi K2 Thinking",
      capabilities: {
        temperature: true,
        reasoning: true,
        attachment: false,
        toolcall: true,
        input: { text: true, audio: false, image: false, video: false, pdf: false },
        output: { text: true, audio: false, image: false, video: false, pdf: false },
        interleaved: false,
      },
      cost: { input: 0.001, output: 0.002, cache: { read: 0.0001, write: 0.0002 } },
      limit: { context: 262144, output: 262144 },
      status: "active",
      options: {},
      headers: {},
      ...overrides,
    }) as any

  test("uses adaptive thinking with effort instead of budget tokens", () => {
    const result = ProviderTransform.options({ model: createModel(), sessionID: "s1", providerOptions: {} })
    expect(result.thinking).toEqual({ type: "adaptive", display: "summarized" })
    expect(result.effort).toBe("high")
    expect(JSON.stringify(result)).not.toContain("budgetTokens")
  })

  test("uses adaptive thinking through Google Vertex Anthropic", () => {
    const model = createModel()
    model.api.npm = "@ai-sdk/google-vertex/anthropic"
    const result = ProviderTransform.options({ model, sessionID: "s1", providerOptions: {} })
    expect(result.thinking).toEqual({ type: "adaptive", display: "summarized" })
    expect(result.effort).toBe("high")
  })

  test("provides adaptive effort variants without models.dev metadata", () => {
    expect(ProviderTransform.variants(createModel())).toEqual(
      Object.fromEntries(
        ["low", "medium", "high", "xhigh", "max"].map((effort) => [
          effort,
          { thinking: { type: "adaptive", display: "summarized" }, effort },
        ]),
      ),
    )

    const model = createModel()
    model.api.npm = "@ai-sdk/openai-compatible"
    expect(ProviderTransform.variants(model)).toEqual({})
  })

  test("does not enable thinking for kimi models without reasoning capability", () => {
    const model = createModel()
    model.capabilities.reasoning = false
    const result = ProviderTransform.options({ model, sessionID: "s1", providerOptions: {} })
    expect(result.thinking).toBeUndefined()
  })

  test("does not set thinking defaults for non-kimi anthropic models", () => {
    const model = createModel({
      id: "anthropic/claude-sonnet-4-5",
      providerID: "anthropic",
      api: {
        id: "claude-sonnet-4-5",
        url: "https://api.anthropic.com",
        npm: "@ai-sdk/anthropic",
      },
    })
    const result = ProviderTransform.options({ model, sessionID: "s1", providerOptions: {} })
    expect(result.thinking).toBeUndefined()
    expect(result.effort).toBeUndefined()
  })

  test("does not set adaptive thinking for kimi on openai-compatible", () => {
    const model = createModel()
    model.api = {
      id: "kimi-k2-thinking",
      url: "https://api.moonshot.ai/v1",
      npm: "@ai-sdk/openai-compatible",
    }
    const result = ProviderTransform.options({ model, sessionID: "s1", providerOptions: {} })
    expect(result.thinking).toBeUndefined()
  })
})
