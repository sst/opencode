import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Provider } from "@opencode/core/provider"

describe("Provider", () => {
  test("loads bundled native provider entrypoints", async () => {
    const packages = [
      "@opencode/ai/providers/baseten",
      "@opencode/ai/providers/cerebras",
      "@opencode/ai/providers/cloudflare-ai-gateway",
      "@opencode/ai/providers/cloudflare-workers-ai",
      "@opencode/ai/providers/deepinfra",
      "@opencode/ai/providers/deepseek",
      "@opencode/ai/providers/fireworks",
      "@opencode/ai/providers/google-vertex",
      "@opencode/ai/providers/google-vertex/gemini",
      "@opencode/ai/providers/google-vertex/chat",
      "@opencode/ai/providers/google-vertex/responses",
      "@opencode/ai/providers/google-vertex/messages",
      "@opencode/ai/providers/groq",
      "@opencode/ai/providers/mistral",
      "@opencode/ai/providers/organization-routes",
      "@opencode/ai/providers/togetherai",
    ]

    for (const specifier of packages) {
      const loaded = await Effect.runPromise(Provider.loadPackage(specifier))
      expect(loaded.model).toBeFunction()
    }
  })

  test("passes flat settings to native packages without opencode transport keys", () => {
    expect(Provider.nativeSettings({ apiKey: "secret", reasoningEffort: "high", chunkTimeout: 1000 })).toEqual({
      apiKey: "secret",
      reasoningEffort: "high",
    })
  })
})
