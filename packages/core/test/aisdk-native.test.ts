import { describe, expect, test } from "bun:test"
import { AISDKNative } from "@opencode/core/aisdk-native"

const map = (packageName: string, settings: Readonly<Record<string, unknown>>, modelID = "test-model") =>
  AISDKNative.map({ packageName, settings, modelID, providerID: "test-provider" })

describe("AISDKNative", () => {
  test("maps OpenAI-family packages and request options to native providers", () => {
    expect(
      map("@ai-sdk/openai", {
        apiKey: "secret",
        baseURL: "https://api.meta.ai/v1",
        organization: "org",
        reasoningEffort: "xhigh",
        reasoningSummary: "auto",
        include: ["reasoning.encrypted_content"],
        truncation: "auto",
      }),
    ).toEqual({
      package: "@opencode/ai/providers/openai",
      settings: {
        apiKey: "secret",
        baseURL: "https://api.meta.ai/v1",
        reasoningEffort: "xhigh",
        reasoningSummary: "auto",
        include: ["reasoning.encrypted_content"],
        truncation: "auto",
        organization: "org",
      },
    })
    expect(map("@ai-sdk/openai-compatible", { baseURL: "https://example.com/v1", reasoningEffort: "high" })).toEqual({
      package: "@opencode/ai/providers/openai-compatible",
      settings: {
        baseURL: "https://example.com/v1",
        provider: "test-provider",
        reasoningEffort: "high",
      },
    })
  })

  test("maps Anthropic settings and request options to the native provider", () => {
    expect(
      map("@ai-sdk/anthropic", {
        authToken: "token",
        baseURL: "https://anthropic.example/v1",
        thinking: { type: "adaptive", display: "summarized" },
        effort: "high",
      }),
    ).toEqual({
      package: "@opencode/ai/providers/anthropic",
      settings: {
        authToken: "token",
        baseURL: "https://anthropic.example/v1",
        thinking: { type: "adaptive", display: "summarized" },
        effort: "high",
      },
    })
  })

  test("maps Cerebras, DeepInfra, Groq, and Together AI settings, headers, and reasoning options to native providers", () => {
    for (const name of ["cerebras", "deepinfra", "groq", "togetherai"]) {
      expect(
        map(`@ai-sdk/${name}`, {
          apiKey: "secret",
          baseURL: `https://${name}.example/v1`,
          headers: { "x-provider": name },
          reasoningEffort: "high",
          customOption: { enabled: true },
        }),
      ).toEqual({
        package: `@opencode/ai/providers/${name}`,
        settings: {
          apiKey: "secret",
          baseURL: `https://${name}.example/v1`,
          reasoningEffort: "high",
          customOption: { enabled: true },
        },
        headers: { "x-provider": name },
      })
      expect(map(`@ai-sdk/${name}`, {})).toEqual({
        package: `@opencode/ai/providers/${name}`,
        settings: {},
      })
    }
  })

  test("maps Google Vertex settings to the native provider", () => {
    expect(
      map("@ai-sdk/google-vertex", {
        project: "project",
        location: "us-central1",
        labels: { environment: "test" },
        thinkingConfig: { thinkingLevel: "high" },
      }),
    ).toEqual({
      package: "@opencode/ai/providers/google-vertex",
      settings: {
        project: "project",
        location: "us-central1",
        labels: { environment: "test" },
        thinkingConfig: { thinkingLevel: "high" },
      },
    })
  })

  test("maps supported Mistral settings and request overlays to the native provider", () => {
    expect(
      map("@ai-sdk/mistral", {
        apiKey: "secret",
        baseURL: "https://mistral.example/v1",
        headers: { "x-provider": "mistral" },
        extraBody: { custom: { enabled: true } },
        safePrompt: false,
        documentImageLimit: 4,
        documentPageLimit: 12,
        parallelToolCalls: false,
        promptCacheKey: "session-123",
        reasoningEffort: "high",
        promptMode: "reasoning",
      }),
    ).toEqual({
      package: "@opencode/ai/providers/mistral",
      settings: {
        apiKey: "secret",
        baseURL: "https://mistral.example/v1",
        safePrompt: false,
        documentImageLimit: 4,
        documentPageLimit: 12,
        parallelToolCalls: false,
        promptCacheKey: "session-123",
        reasoningEffort: "high",
        promptMode: "reasoning",
      },
      headers: { "x-provider": "mistral" },
      body: { custom: { enabled: true } },
    })
  })

  test("maps both models.dev Bedrock packages to native providers", () => {
    expect(map("@ai-sdk/amazon-bedrock", { region: "us-east-1" })).toEqual({
      package: "@opencode/ai/providers/amazon-bedrock",
      settings: { region: "us-east-1" },
    })
    expect(map("@ai-sdk/amazon-bedrock/mantle", { region: "us-east-1" }, "openai.gpt-oss-120b")).toEqual({
      package: "@opencode/ai/providers/amazon-bedrock/mantle/chat",
      settings: { region: "us-east-1" },
    })
  })

  test("maps Azure deployments and settings to native routes", () => {
    const settings = {
      apiKey: "secret",
      resourceName: "resource",
      apiVersion: "2025-01-01-preview",
      queryParams: { feature: "enabled" },
      useDeploymentBasedUrls: true,
      reasoningEffort: "high",
    }
    expect(map("@ai-sdk/azure", settings, "deployment")).toEqual({
      package: "@opencode/ai/providers/azure/responses",
      settings: {
        apiKey: "secret",
        resourceName: "resource",
        apiVersion: "2025-01-01-preview",
        queryParams: { feature: "enabled" },
        useDeploymentBasedUrls: true,
        reasoningEffort: "high",
      },
    })
    const chat = map("@ai-sdk/azure", { ...settings, useCompletionUrls: true }, "custom-deployment")
    expect(chat?.package).toBe("@opencode/ai/providers/azure/chat")
    expect(chat?.settings).not.toHaveProperty("useCompletionUrls")
  })

  test("maps Bedrock provider and request options", () => {
    expect(
      map(
        "@ai-sdk/amazon-bedrock",
        {
          region: "us-east-1",
          topP: 0.8,
          headers: { "x-test": "value" },
          additionalModelRequestFields: {
            existing: true,
            anthropic_beta: ["existing-beta"],
            output_config: { format: "text" },
          },
          reasoningConfig: { type: "adaptive", display: "summarized", maxReasoningEffort: "high" },
          anthropicBeta: ["context-1m-2025-08-07"],
          serviceTier: "priority",
        },
        "anthropic.claude-sonnet-4-6-v1",
      ),
    ).toEqual({
      package: "@opencode/ai/providers/amazon-bedrock",
      settings: { region: "us-east-1", topP: 0.8 },
      headers: { "x-test": "value" },
      body: {
        additionalModelRequestFields: {
          existing: true,
          anthropic_beta: ["existing-beta", "context-1m-2025-08-07"],
          thinking: { type: "adaptive", display: "summarized" },
          output_config: { format: "text", effort: "high" },
        },
        serviceTier: { type: "priority" },
      },
    })

    expect(
      map(
        "@ai-sdk/amazon-bedrock",
        { reasoningConfig: { type: "enabled", maxReasoningEffort: "max" } },
        "amazon.nova-2-lite-v1:0",
      )?.body,
    ).toEqual({
      additionalModelRequestFields: {
        reasoningConfig: { type: "enabled", maxReasoningEffort: "max" },
      },
    })

    // gpt-oss (Harmony) keeps the flat chat-completions field.
    expect(
      map("@ai-sdk/amazon-bedrock", { reasoningConfig: { maxReasoningEffort: "high" } }, "openai.gpt-oss-120b-1:0")
        ?.body,
    ).toEqual({ additionalModelRequestFields: { reasoning_effort: "high" } })

    // GPT-5.6+ reject `reasoning_effort` and take the Responses-style nested field.
    for (const modelID of ["global.openai.gpt-5.6-sol", "us.openai.gpt-5.6-sol", "us.openai.gpt-6-astra"]) {
      expect(map("@ai-sdk/amazon-bedrock", { reasoningConfig: { maxReasoningEffort: "none" } }, modelID)?.body).toEqual(
        { additionalModelRequestFields: { reasoning: { effort: "none" } } },
      )
    }
    expect(
      map(
        "@ai-sdk/amazon-bedrock",
        {
          reasoningConfig: { maxReasoningEffort: "high" },
          additionalModelRequestFields: { reasoning: { summary: "auto" } },
        },
        "us.openai.gpt-5.6-sol",
      )?.body,
    ).toEqual({ additionalModelRequestFields: { reasoning: { summary: "auto", effort: "high" } } })
  })

  test("maps Bedrock Mantle models to their supported native APIs", () => {
    const settings = {
      bearerToken: "token",
      region: "us-west-2",
      baseURL: "https://mantle.test/v1",
      headers: { "x-test": "value" },
      reasoningEffort: "high",
      reasoningSummary: "auto",
      include: ["reasoning.encrypted_content"],
    }

    expect(map("@ai-sdk/amazon-bedrock/mantle", settings, "openai.gpt-oss-120b")).toEqual({
      package: "@opencode/ai/providers/amazon-bedrock/mantle/chat",
      settings: {
        apiKey: "token",
        baseURL: "https://mantle.test/v1",
        region: "us-west-2",
        reasoningEffort: "high",
        reasoningSummary: "auto",
        include: ["reasoning.encrypted_content"],
      },
      headers: { "x-test": "value" },
    })
    for (const modelID of ["openai.gpt-oss-safeguard-20b", "openai.gpt-oss-safeguard-120b"]) {
      expect(map("@ai-sdk/amazon-bedrock/mantle", settings, modelID)?.package).toBe(
        "@opencode/ai/providers/amazon-bedrock/mantle/chat",
      )
    }
    expect(
      map(
        "@ai-sdk/amazon-bedrock/mantle",
        {
          region: "us-west-2",
          baseURL: "https://bedrock-mantle.${AWS_REGION}.api.aws/openai/v1",
        },
        "openai.gpt-5.5",
      ),
    ).toMatchObject({ settings: { baseURL: "https://bedrock-mantle.us-west-2.api.aws/openai/v1" } })
  })

  test("maps static Bedrock Mantle credentials without leaking connection options", () => {
    expect(
      map(
        "@ai-sdk/amazon-bedrock/mantle",
        {
          credentials: {
            accessKeyId: "key",
            secretAccessKey: "secret",
            sessionToken: "session",
            region: "eu-west-1",
          },
          baseURL: "https://bedrock-mantle.${AWS_REGION}.api.aws/v1",
          credentialProvider: "ignored",
          store: false,
        },
        "openai.gpt-oss-120b",
      ),
    ).toEqual({
      package: "@opencode/ai/providers/amazon-bedrock/mantle/chat",
      settings: {
        credentials: {
          accessKeyId: "key",
          secretAccessKey: "secret",
          sessionToken: "session",
          region: "eu-west-1",
        },
        baseURL: "https://bedrock-mantle.eu-west-1.api.aws/v1",
        store: false,
      },
    })
  })

  test("forwards Bedrock profile and auth mode for the default credential chain", () => {
    expect(
      map("@ai-sdk/amazon-bedrock", { profile: "work", auth: "sigv4", region: "eu-west-1" }, "anthropic.claude"),
    ).toEqual({
      package: "@opencode/ai/providers/amazon-bedrock",
      settings: { profile: "work", auth: "sigv4", region: "eu-west-1" },
    })
    expect(map("@ai-sdk/amazon-bedrock", { auth: "bogus" }, "anthropic.claude")).toEqual({
      package: "@opencode/ai/providers/amazon-bedrock",
      settings: {},
    })
  })

  test("maps the legacy Bedrock endpoint override", () => {
    expect(
      map(
        "@ai-sdk/amazon-bedrock/mantle",
        { bearerToken: "token", endpoint: "https://mantle.private/v1", region: "us-east-1" },
        "openai.gpt-oss-120b",
      ),
    ).toMatchObject({ settings: { baseURL: "https://mantle.private/v1" } })
  })

  test("maps OpenRouter settings to native destinations", () => {
    expect(
      map("@openrouter/ai-sdk-provider", {
        appName: "OpenCode",
        appUrl: "https://opencode.ai",
        headers: { "x-openrouter-title": "Configured", "x-provider-api-keys": "Configured BYOK" },
        api_keys: { anthropic: "provider-key" },
        extraBody: { transforms: ["middle-out"] },
        models: ["anthropic/claude-sonnet-4.6"],
        provider: { only: ["anthropic"], require_parameters: true },
        reasoning: { effort: "high" },
        future_option: { enabled: true },
      }),
    ).toEqual({
      package: "@opencode/ai/providers/openrouter",
      settings: {
        models: ["anthropic/claude-sonnet-4.6"],
        provider: { only: ["anthropic"], require_parameters: true },
        reasoning: { effort: "high" },
        future_option: { enabled: true },
      },
      headers: {
        "x-openrouter-title": "Configured",
        "HTTP-Referer": "https://opencode.ai",
        "x-provider-api-keys": "Configured BYOK",
      },
      body: { transforms: ["middle-out"] },
    })
  })

  test("maps every Google thinking setting", () => {
    expect(
      map("@ai-sdk/google", {
        cachedContent: "cachedContents/example",
        safetySettings: [{ category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" }],
        serviceTier: "flex",
        thinkingConfig: {
          thinkingBudget: 0,
          includeThoughts: false,
          thinkingLevel: "high",
        },
      }),
    ).toEqual({
      package: "@opencode/ai/providers/google",
      settings: {
        cachedContent: "cachedContents/example",
        safetySettings: [{ category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" }],
        serviceTier: "flex",
        thinkingConfig: {
          thinkingBudget: 0,
          includeThoughts: false,
          thinkingLevel: "high",
        },
      },
    })
  })

  test("maps Google thinking settings independently", () => {
    for (const thinkingConfig of [{ thinkingBudget: -1 }, { includeThoughts: true }, { thinkingLevel: "medium" }]) {
      expect(map("@ai-sdk/google", { thinkingConfig })).toMatchObject({
        settings: { thinkingConfig },
      })
    }
  })

  test("maps Google request options without thinking settings", () => {
    expect(
      map("@ai-sdk/google", {
        cachedContent: "cachedContents/example",
        safetySettings: [{ category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" }],
        serviceTier: "future-tier",
      }),
    ).toMatchObject({
      settings: {
        cachedContent: "cachedContents/example",
        safetySettings: [{ category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" }],
        serviceTier: "future-tier",
      },
    })
  })

  test("maps Vertex Gemini settings to the native Gemini route", () => {
    expect(
      map("@ai-sdk/google-vertex", {
        accessToken: "vertex-token",
        baseURL: "https://vertex.example/v1",
        headers: { "x-test": "value" },
        labels: { component: "opencode", environment: "test" },
        location: "eu",
        project: "vertex-project",
        thinkingConfig: { thinkingLevel: "high" },
      }),
    ).toEqual({
      package: "@opencode/ai/providers/google-vertex",
      settings: {
        accessToken: "vertex-token",
        baseURL: "https://vertex.example/v1",
        location: "eu",
        project: "vertex-project",
        labels: { component: "opencode", environment: "test" },
        thinkingConfig: { thinkingLevel: "high" },
      },
      headers: { "x-test": "value" },
    })
  })

  test("maps Vertex Anthropic settings to native Messages", () => {
    expect(
      map("@ai-sdk/google-vertex/anthropic", {
        accessToken: "vertex-token",
        baseURL: "https://vertex.example/v1",
        headers: { "x-test": "value" },
        location: "eu",
        project: "vertex-project",
        thinking: { type: "adaptive", display: "summarized" },
        effort: "high",
      }),
    ).toEqual({
      package: "@opencode/ai/providers/google-vertex/messages",
      settings: {
        accessToken: "vertex-token",
        baseURL: "https://vertex.example/v1",
        location: "eu",
        project: "vertex-project",
        thinking: { type: "adaptive", display: "summarized" },
        effort: "high",
      },
      headers: { "x-test": "value" },
    })
  })

  test("maps supported xAI settings", () => {
    expect(
      map("@ai-sdk/xai", {
        apiKey: "secret",
        baseURL: "https://xai.example/v1",
        reasoningEffort: "custom",
        store: true,
      }),
    ).toEqual({
      package: "@opencode/ai/providers/xai",
      settings: {
        apiKey: "secret",
        baseURL: "https://xai.example/v1",
        reasoningEffort: "custom",
        store: true,
      },
    })
  })
})
