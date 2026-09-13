import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { LLM, LLMEvent, LLMRequest, Message, ToolDefinition, type LLMResponse } from "../../src/index.js"
import { Alibaba } from "../../src/providers.js"
import { LLMClient } from "../../src/route.js"
import { compileRequest } from "../../src/route/client.js"
import { recordedTests } from "../recorded-test.js"

const alibaba = Alibaba.configure({ region: "ap-southeast-1", apiKey: process.env.ALIBABA_API_KEY ?? "fixture" })
const weather = ToolDefinition.make({
  name: "get_weather",
  description: "Get the current weather in a city",
  inputSchema: {
    type: "object",
    properties: { city: { type: "string", enum: ["Paris"] } },
    required: ["city"],
    additionalProperties: false,
  },
})

for (const api of ["chat", "messages", "responses"] as const) {
  const recorded = recordedTests({
    prefix: `alibaba-${api}`,
    provider: "alibaba",
    protocol: `alibaba-${api}`,
    requires: ["ALIBABA_API_KEY"],
    tags: ["region:ap-southeast-1"],
  })
  describe(`Alibaba ${api}`, () => {
    for (const effort of api === "messages"
      ? [undefined, "low", "medium", "high", "xhigh", "max"]
      : [undefined, "none", "minimal", "low", "medium", "high", "xhigh", "max"]) {
      recorded.effect.with(
        `Qwen 3.8 Max streams ${effort ?? "default"} effort`,
        { tags: ["text", "reasoning", "usage"] },
        () =>
          Effect.gen(function* () {
            const request = LLM.request({
              model: alibaba[api]("qwen3.8-max"),
              prompt: "What is 173 multiplied by 219? Reply with only the final integer.",
              providerOptions: api === "messages" ? { effort } : { reasoningEffort: effort },
              generation: { maxTokens: 4096 },
            })
            const compiled = yield* compileRequest(request)
            expect(compiled.body.enable_thinking).toBeUndefined()
            expect(compiled.body.thinking).toBeUndefined()
            expect(
              api === "chat"
                ? compiled.body.reasoning_effort
                : api === "messages"
                  ? compiled.body.output_config?.effort
                  : compiled.body.reasoning?.effort,
            ).toBe(effort)
            const response = yield* LLMClient.generate(request)
            expect(response.text.replaceAll(",", "")).toContain("37887")
            expect(response.reasoning.length > 0).toBe(effort !== "none")
            expect(response.finishReason.normalized).toBe("stop")
            expectUsage(response)
          }),
        120_000,
      )
    }

    recorded.effect.with(
      "Qwen 3.8 Max replays reasoning through a tool loop and follow-up",
      { tags: ["tool", "tool-loop", "reasoning", "continuation"] },
      () =>
        Effect.gen(function* () {
          const request = LLM.request({
            model: alibaba[api]("qwen3.8-max"),
            providerOptions:
              api === "messages"
                ? { effort: "medium" }
                : api === "chat"
                  ? { reasoningEffort: "medium", preserveThinking: true, toolStream: true }
                  : { reasoningEffort: "medium", store: false },
            prompt:
              "We have a budget of 38000 dollars for 219 trips costing 173 dollars each. Calculate whether that is affordable. If it is, use get_weather to look up the current weather in Paris. After receiving the result, report the weather in one short sentence.",
            tools: [weather],
            generation: { maxTokens: 4096 },
          })
          const first = yield* LLMClient.generate(request)
          expect(first.toolCalls).toMatchObject([{ name: "get_weather", input: { city: "Paris" } }])
          expect(first.finishReason.normalized).toBe("tool-calls")
          expect(first.reasoning.length).toBeGreaterThan(0)
          expect(first.events.some(LLMEvent.is.toolInputDelta)).toBe(true)
          expectUsage(first)
          const continuation = LLMRequest.update(request, {
            messages: [
              ...request.messages,
              first.message,
              ...first.toolCalls.map((call) =>
                Message.tool({ id: call.id, name: call.name, result: { condition: "sunny", temperature: "18C" } }),
              ),
            ],
          })
          expectReasoning(api, (yield* compileRequest(continuation)).body, first)
          const second = yield* LLMClient.generate(continuation)
          expect(second.text.toLowerCase()).toContain("sunny")
          expect(second.toolCalls).toHaveLength(0)
          expect(second.finishReason.normalized).toBe("stop")
          expectUsage(second)
          const followUp = LLMRequest.update(continuation, {
            messages: [
              ...continuation.messages,
              second.message,
              Message.user("What temperature did the tool report? Reply with only the temperature."),
            ],
          })
          expectReasoning(api, (yield* compileRequest(followUp)).body, first)
          const third = yield* LLMClient.generate(followUp)
          expect(third.text).toContain("18")
          expect(third.toolCalls).toHaveLength(0)
          expect(third.finishReason.normalized).toBe("stop")
          expectUsage(third)
        }),
      180_000,
    )
  })
}

function expectUsage(response: LLMResponse) {
  expect(response.usage?.inputTokens).toBeGreaterThan(0)
  expect(response.usage?.outputTokens).toBeGreaterThan(0)
  expect(response.events.filter(LLMEvent.is.finish)).toHaveLength(1)
}

function expectReasoning(
  api: "chat" | "messages" | "responses",
  body: Readonly<Record<string, unknown>>,
  response: LLMResponse,
) {
  if (api === "chat") {
    expect(body.messages).toEqual(
      expect.arrayContaining([expect.objectContaining({ role: "assistant", reasoning_content: response.reasoning })]),
    )
    return
  }
  for (const part of response.message.content.filter((part) => part.type === "reasoning")) {
    if (api === "messages") {
      expect(body.messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: "assistant",
            content: expect.arrayContaining([
              { type: "thinking", thinking: part.text, signature: part.providerMetadata?.alibaba?.signature ?? "" },
            ]),
          }),
        ]),
      )
      continue
    }
    expect(body.input).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "reasoning",
          id: part.providerMetadata?.alibaba?.itemId,
          summary: expect.arrayContaining([{ type: "summary_text", text: part.text }]),
        }),
      ]),
    )
  }
}
