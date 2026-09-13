import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Model } from "../src/model.js"
import { Provider } from "../src/provider.js"

describe("Model.Ref", () => {
  test("parses model references with optional variants", () => {
    const variant = Model.Ref.parse("openrouter/openai/gpt-5#high")
    expect(String(variant.providerID)).toBe("openrouter")
    expect(String(variant.id)).toBe("openai/gpt-5")
    expect(String(variant.variant)).toBe("high")

    const standard = Model.Ref.parse("anthropic/claude-sonnet")
    expect(String(standard.providerID)).toBe("anthropic")
    expect(String(standard.id)).toBe("claude-sonnet")
    expect(standard.variant).toBeUndefined()
  })

  test("rejects malformed model references", () => {
    expect(() => Model.Ref.parse("gpt-5")).toThrow()
    expect(() => Model.Ref.parse("openai/gpt-5#")).toThrow()
    expect(() => Model.Ref.parse("openai/gpt-5#high#extra")).toThrow()
  })
})

describe("Model.ReasoningField", () => {
  test("accepts suggested and custom fields", () => {
    const decode = Schema.decodeUnknownSync(Model.ReasoningField)

    for (const field of ["reasoning", "reasoning_content", "reasoning_text", "vendor_reasoning"])
      expect(decode(field)).toBe(field)
  })
})

describe("Model.Compatibility", () => {
  test("decodes model compatibility overrides", () => {
    const decode = Schema.decodeUnknownSync(Model.Compatibility)

    expect(decode({})).toEqual({})
    expect(
      decode({
        reasoningField: "vendor_reasoning",
        requireReasoning: true,
        maxTokensField: "max_completion_tokens",
        requireFinishReason: false,
        requireAssistantAfterTool: true,
        supportsThinkingBlockBinding: false,
      }),
    ).toEqual({
      reasoningField: "vendor_reasoning",
      requireReasoning: true,
      maxTokensField: "max_completion_tokens",
      requireFinishReason: false,
      requireAssistantAfterTool: true,
      supportsThinkingBlockBinding: false,
    })
  })
})

describe("Model.Info", () => {
  test("provider compaction policy is optional and uses the canonical closed schema", () => {
    const model = Model.Info.default(Provider.ID.openai, Model.ID.make("gpt-5.4-mini"))
    expect(Schema.encodeSync(Model.Info)({ ...model, compaction: undefined })).not.toHaveProperty("compaction")
    expect(Schema.decodeUnknownSync(Model.Info)({ ...model, compaction: { mode: "provider" } }).compaction).toEqual({
      mode: "provider",
    })
    expect(Schema.decodeUnknownSync(Provider.Compaction)({ mode: "local" })).toEqual({ mode: "local" })
    expect(Schema.encodeSync(Provider.Compaction)({ mode: "provider", threshold: undefined })).toEqual({
      mode: "provider",
    })
    expect(Schema.decodeUnknownSync(Provider.Compaction)({ mode: "provider", threshold: 120_000 })).toEqual({
      mode: "provider",
      threshold: 120_000,
    })
    for (const threshold of [0, -1, 1.5])
      expect(() => Schema.decodeUnknownSync(Provider.Compaction)({ mode: "provider", threshold })).toThrow()
    expect(() => Schema.decodeUnknownSync(Provider.Compaction)({ mode: "automatic" })).toThrow()
  })

  test("uses practical token limits for unknown models", () => {
    const model = Model.Info.default(Provider.ID.make("custom"), Model.ID.make("gpt-5.6"))

    expect(model.limit).toEqual({ context: 200_000, output: 32_000 })
  })
})

describe("Model.Capabilities", () => {
  test("decodes optional Responses WebSocket support", () => {
    const decode = Schema.decodeUnknownSync(Model.Capabilities)
    const base = { tools: true, input: ["text"], output: ["text"] }

    expect(decode(base)).toEqual(base)
    expect(decode({ ...base, responsesWebsockets: true })).toEqual({ ...base, responsesWebsockets: true })
  })
})
