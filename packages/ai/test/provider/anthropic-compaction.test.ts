import { expect } from "bun:test"
import { Effect, Schema } from "effect"
import { LLM, LLMRequest, Message } from "../../src/index.js"
import { LLMClient } from "../../src/route/client.js"
import { Anthropic, GoogleVertexMessages } from "../../src/providers/index.js"
import { testEffect } from "../lib/effect.js"
import { dynamicResponse, fixedResponse } from "../lib/http.js"
import { sseEvents } from "../lib/sse.js"

for (const fixture of [
  {
    name: "empty iterations fall back to top-level usage",
    usage: { input_tokens: 2, output_tokens: 3, cache_read_input_tokens: null, iterations: [] },
    expected: { inputTokens: 2, outputTokens: 3, totalTokens: 5, contextTokens: undefined },
  },
  {
    name: "compaction-only usage has no post-compaction context size",
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      iterations: [{ type: "compaction", input_tokens: 7, cache_read_input_tokens: 3, output_tokens: 2 }],
    },
    expected: { inputTokens: 10, outputTokens: 2, totalTokens: 12, contextTokens: undefined },
  },
  {
    name: "partially reported iterations preserve known totals",
    usage: {
      iterations: [
        { type: "compaction", input_tokens: 7, cache_creation_input_tokens: 2 },
        { type: "message", output_tokens: 3 },
      ],
    },
    expected: { inputTokens: 9, outputTokens: 3, totalTokens: 12, contextTokens: undefined },
  },
  {
    name: "missing counters remain unknown rather than zero",
    usage: { iterations: [{ type: "message" }] },
    expected: { inputTokens: undefined, outputTokens: undefined, totalTokens: undefined, contextTokens: undefined },
  },
]) {
  testEffect(
    fixedResponse(
      sseEvents(
        { type: "message_start", message: { usage: fixture.usage } },
        { type: "message_delta", delta: { stop_reason: "end_turn" } },
        { type: "message_stop" },
      ),
    ),
  ).effect(fixture.name, () =>
    Effect.gen(function* () {
      const result = yield* LLMClient.generate(
        LLM.request({
          model: Anthropic.configure({ apiKey: "test" }).model("claude-opus-4-6"),
          prompt: "hello",
        }),
      )
      expect(result.usage).toMatchObject(fixture.expected)
    }),
  )
}

for (const model of [
  Anthropic.configure({ apiKey: "test" }).model("claude-opus-4-6"),
  GoogleVertexMessages.configure({ accessToken: "test", project: "test" }).model("claude-opus-4-6"),
]) {
  for (const summary of ["Summary of the conversation", null]) {
    const block = { type: "compaction", content: summary }
    testEffect(
      dynamicResponse(({ request, text, respond }) =>
        Effect.sync(() => {
          const body = JSON.parse(text)
          expect(request.headers["anthropic-beta"]).toBe(
            "existing-beta,interleaved-thinking-2025-05-14,compact-2026-01-12",
          )
          if (body.messages.length === 1) {
            expect(body.context_management.edits).toEqual([
              {
                type: "compact_20260112",
                trigger: { type: "input_tokens", value: 50000 },
                pause_after_compaction: true,
              },
            ])
          }
          if (body.messages.length > 1) {
            expect(body.messages[1].content).toEqual([block])
            expect(body.context_management).toBeUndefined()
          }
          return respond(
            sseEvents(
              { type: "message_start", message: { usage: { input_tokens: 50000, output_tokens: 0 } } },
              { type: "content_block_start", index: 0, content_block: { type: "compaction", content: null } },
              { type: "content_block_delta", index: 0, delta: { type: "compaction_delta", content: summary } },
              { type: "content_block_stop", index: 0 },
              {
                type: "message_delta",
                delta: { stop_reason: "compaction" },
                usage: {
                  input_tokens: 1000,
                  output_tokens: 5,
                  iterations: [
                    { type: "compaction", input_tokens: 50000, output_tokens: 1000, cache_read_input_tokens: 10 },
                    { type: "message", input_tokens: 1000, output_tokens: 5 },
                  ],
                },
              },
              { type: "message_stop" },
            ),
            { headers: { "content-type": "text/event-stream" } },
          )
        }),
      ),
    ).effect(
      `${model.provider} replays ${summary === null ? "failed" : "successful"} compaction with billing and context usage`,
      () =>
        Effect.gen(function* () {
          const request = LLM.request({
            model,
            prompt: "hello",
            http: { headers: { "anthropic-beta": "existing-beta" } },
            providerOptions: {
              contextManagement: {
                edits: [
                  {
                    type: "compact_20260112",
                    trigger: { type: "input_tokens", value: 50000 },
                    pauseAfterCompaction: true,
                  },
                ],
              },
            },
          })
          const first = yield* LLMClient.generate(request)
          expect(first.finishReason.raw).toBe("compaction")
          expect(first.message.content).toEqual([{ type: "compaction", provider: model.provider, text: summary }])
          expect(first.text).toBe("")
          expect(first.usage?.inputTokens).toBe(51010)
          expect(first.usage?.outputTokens).toBe(1005)
          expect(first.usage?.totalTokens).toBe(52015)
          expect(first.usage?.contextTokens).toBe(1000)
          const codec = Schema.fromJsonString(Message)
          const message = Schema.decodeSync(codec)(Schema.encodeSync(codec)(first.message))
          yield* LLMClient.generate(
            LLMRequest.update(request, {
              providerOptions: {},
              messages: [...request.messages, message, Message.user("continue")],
            }),
          )
        }),
    )
  }
}

for (const events of [
  [{ type: "content_block_start", index: 0, content_block: { type: "compaction", content: 42 } }],
  [{ type: "content_block_delta", index: 0, delta: { type: "compaction_delta", content: "no start" } }],
  [
    { type: "content_block_start", index: 0, content_block: { type: "compaction", content: null } },
    { type: "message_stop" },
  ],
]) {
  testEffect(fixedResponse(sseEvents(...events))).effect(
    `rejects malformed compaction lifecycle: ${JSON.stringify(events)}`,
    () =>
      Effect.gen(function* () {
        const error = yield* LLMClient.generate(
          LLM.request({ model: Anthropic.configure({ apiKey: "test" }).model("claude-opus-4-6"), prompt: "hello" }),
        ).pipe(Effect.flip)
        expect(error.reason._tag).toBe("InvalidProviderOutput")
        expect(error.reason.http?.status).toBe(200)
      }),
  )
}
