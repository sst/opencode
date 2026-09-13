import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { LLM, LLMEvent, Message } from "../../src/index.js"
import { OpenAI } from "../../src/providers.js"
import { configure } from "../../src/providers/openai-compatible-responses.js"
import { compileRequest, LLMClient } from "../../src/route/client.js"
import { it } from "../lib/effect.js"
import { fixedResponse } from "../lib/http.js"
import { sseEvents } from "../lib/sse.js"

for (const model of [
  OpenAI.configure({ apiKey: "test-key" }).responses("example-model"),
  configure({ apiKey: "test-key", baseURL: "https://responses.example.test/v1" }).model("example-model"),
]) {
  describe(`${model.route.protocol} message replay`, () => {
    const key = model.route.providerMetadataKey ?? "openresponses"

    it.effect("marks assistant text completed regardless of stored status", () =>
      Effect.gen(function* () {
        const prepared = yield* compileRequest(
          LLM.request({
            model,
            messages: [
              ...[undefined, "in_progress", "incomplete", "completed"].map((status, index) =>
                Message.make({
                  role: "assistant",
                  providerMetadata: { [key]: { status } },
                  content: [
                    {
                      type: "text",
                      text: `Saved ${index}`,
                      providerMetadata: { [key]: { itemId: `msg_${index}`, phase: "commentary", status } },
                    },
                    {
                      type: "text",
                      text: `Final ${index}`,
                      providerMetadata: { [key]: { itemId: `msg_final_${index}`, phase: "final_answer", status } },
                    },
                  ],
                }),
              ),
              Message.make({
                role: "user",
                content: [{ type: "text", text: "Continue" }],
                providerMetadata: { [key]: { status: "incomplete" } },
              }),
            ],
          }),
        )
        expect(prepared.body.input).toEqual([
          ...[0, 1, 2, 3].flatMap((index) => [
            {
              type: "message",
              role: "assistant",
              id: `msg_${index}`,
              phase: "commentary",
              status: "completed",
              content: [{ type: "output_text", text: `Saved ${index}` }],
            },
            {
              type: "message",
              role: "assistant",
              id: `msg_final_${index}`,
              phase: "final_answer",
              status: "completed",
              content: [{ type: "output_text", text: `Final ${index}` }],
            },
          ]),
          { role: "user", status: "incomplete", content: [{ type: "input_text", text: "Continue" }] },
        ])
      }),
    )

    it.effect("replays truncated text as completed while retaining the response finish reason", () =>
      Effect.gen(function* () {
        const response = yield* LLMClient.generate(LLM.request({ model, prompt: "Respond" })).pipe(
          Effect.provide(
            fixedResponse(
              sseEvents(
                {
                  type: "response.output_item.added",
                  item: { type: "message", id: "msg_partial", status: "in_progress" },
                },
                { type: "response.output_text.delta", item_id: "msg_partial", delta: "The next step is" },
                {
                  type: "response.output_item.done",
                  item: {
                    type: "message",
                    id: "msg_partial",
                    status: "incomplete",
                    content: [{ type: "output_text", text: "The next step is" }],
                  },
                },
                {
                  type: "response.incomplete",
                  response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } },
                },
              ),
            ),
          ),
        )
        expect(response.finishReason.normalized).toBe("length")
        expect(response.events.filter(LLMEvent.is.textEnd)).toHaveLength(1)
        const prepared = yield* compileRequest(
          LLM.request({ model, messages: [response.message, Message.user("Continue")] }),
        )
        expect(prepared.body.input).toEqual([
          {
            type: "message",
            role: "assistant",
            id: "msg_partial",
            status: "completed",
            content: [{ type: "output_text", text: "The next step is" }],
          },
          { role: "user", content: [{ type: "input_text", text: "Continue" }] },
        ])
      }),
    )
  })
}
