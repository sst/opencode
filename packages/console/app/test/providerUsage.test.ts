import { describe, expect, test } from "bun:test"
import type { ZenData } from "@opencode-ai/console-core/model.js"
import type { ProviderHelper } from "../src/routes/zen/util/provider/provider"
import { anthropicHelper } from "../src/routes/zen/util/provider/anthropic"
import { googleHelper } from "../src/routes/zen/util/provider/google"
import { oaCompatHelper } from "../src/routes/zen/util/provider/openai-compatible"
import { openaiHelper } from "../src/routes/zen/util/provider/openai"

const providers = {
  anthropic: anthropicHelper({ reqModel: "claude-haiku-4-5", providerModel: "claude-haiku-4-5" }),
  google: googleHelper({ reqModel: "gemini-3-flash", providerModel: "gemini-3-flash" }),
  openai: openaiHelper({ reqModel: "gpt-5", providerModel: "gpt-5" }),
  "oa-compat": oaCompatHelper({ reqModel: "gpt-5-nano", providerModel: "gpt-5-nano" }),
} satisfies Record<ZenData.Format, ReturnType<ProviderHelper>>

describe("provider usage extraction", () => {
  test("extracts Google non-stream usage metadata", () => {
    const usage = providers.google.extractUsage({
      usageMetadata: {
        promptTokenCount: 10,
        candidatesTokenCount: 3,
        thoughtsTokenCount: 2,
        cachedContentTokenCount: 4,
      },
    })

    expect(providers.google.normalizeUsage(usage)).toEqual({
      inputTokens: 6,
      outputTokens: 5,
      reasoningTokens: 2,
      cacheReadTokens: 4,
      cacheWrite5mTokens: undefined,
      cacheWrite1hTokens: undefined,
    })
  })

  test("parses Google stream usage metadata", () => {
    const usageParser = providers.google.createUsageParser()
    usageParser.parse(
      'data: {"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":3,"thoughtsTokenCount":2,"cachedContentTokenCount":4}}',
    )

    expect(providers.google.normalizeUsage(usageParser.retrieve())).toEqual({
      inputTokens: 6,
      outputTokens: 5,
      reasoningTokens: 2,
      cacheReadTokens: 4,
      cacheWrite5mTokens: undefined,
      cacheWrite1hTokens: undefined,
    })
  })

  test("extracts nested OpenAI Responses usage", () => {
    expect(
      providers.openai.extractUsage({
        response: {
          usage: {
            input_tokens: 5,
            output_tokens: 7,
          },
        },
      }),
    ).toEqual({
      input_tokens: 5,
      output_tokens: 7,
    })
  })

  test("parses OpenAI stream cache write usage", () => {
    const usageParser = providers.openai.createUsageParser()
    usageParser.parse(
      'event: response.completed\ndata: {"response":{"usage":{"input_tokens":10,"input_tokens_details":{"cached_tokens":4,"cache_write_tokens":3},"output_tokens":2}}}',
    )

    expect(providers.openai.normalizeUsage(usageParser.retrieve())).toEqual({
      inputTokens: 3,
      outputTokens: 2,
      reasoningTokens: undefined,
      cacheReadTokens: 4,
      cacheWrite5mTokens: 3,
      cacheWrite1hTokens: undefined,
    })
  })

  test("clamps input tokens when detail fields overlap", () => {
    const usageParser = providers.openai.createUsageParser()
    usageParser.parse(
      'event: response.completed\ndata: {"response":{"usage":{"input_tokens":5,"input_tokens_details":{"cached_tokens":4,"cache_write_tokens":3},"output_tokens":2}}}',
    )

    expect(providers.openai.normalizeUsage(usageParser.retrieve())).toEqual({
      inputTokens: 0,
      outputTokens: 2,
      reasoningTokens: undefined,
      cacheReadTokens: 4,
      cacheWrite5mTokens: 3,
      cacheWrite1hTokens: undefined,
    })
  })
})
