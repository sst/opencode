import { describe, expect } from "bun:test"
import { Effect, Schema } from "effect"
import { LLM, LLMEvent, Message } from "../../src/index.js"
import { configure } from "../../src/providers/organization-routes.js"
import { provider } from "../../src/providers/openai-compatible-responses.js"
import { LLMClient } from "../../src/route.js"
import { compileRequest } from "../../src/route/client.js"
import { it } from "../lib/effect.js"
import { dynamicResponse, fixedResponse } from "../lib/http.js"
import { sseEvents } from "../lib/sse.js"

const model = configure({
  apiKey: "session-test",
  baseURL: "https://console.example.test/inference/route/openai/v1",
  provider: "opencode-routes-org_test",
  headers: { "x-opencode-org-id": "org_test" },
}).model("route/coding")

const fixtures = [
  {
    protocol: "openai-responses",
    content: [
      {
        type: "reasoning",
        id: "rs_native",
        summary: [{ type: "summary_text", text: "Need a lookup" }],
        encrypted_content: "opaque-openai-reasoning",
      },
      { type: "message", id: "msg_native", role: "assistant", content: [{ type: "output_text", text: "Checking." }] },
      {
        type: "function_call",
        id: "fc_native_lookup",
        call_id: "call_lookup",
        name: "lookup",
        arguments: '{"query":"weather"}',
      },
      { type: "function_call", id: "fc_native_clock", call_id: "call_clock", name: "clock", arguments: "{}" },
    ],
  },
  {
    protocol: "google",
    content: [
      { text: "Need a lookup", thought: true },
      { text: "Checking." },
      { functionCall: { name: "lookup", args: { query: "weather" } }, thoughtSignature: "opaque-google-signature" },
      { functionCall: { name: "clock", args: {} } },
    ],
  },
  {
    protocol: "anthropic-messages",
    content: [
      { type: "thinking", thinking: "Need a lookup", signature: "opaque-anthropic-signature" },
      { type: "text", text: "Checking." },
      { type: "tool_use", id: "call_lookup", name: "lookup", input: { query: "weather" } },
      { type: "tool_use", id: "call_clock", name: "clock", input: {} },
    ],
  },
  {
    protocol: "openai-chat",
    content: [
      {
        role: "assistant",
        reasoning_content: "Need a lookup",
        content: "Checking.",
        tool_calls: [
          { id: "call_lookup", type: "function", function: { name: "lookup", arguments: '{"query":"weather"}' } },
          { id: "call_clock", type: "function", function: { name: "clock", arguments: "{}" } },
        ],
      },
    ],
  },
]

const finalText = sseEvents(
  {
    type: "response.output_item.done",
    item: { type: "message", id: "msg_final", content: [{ type: "output_text", text: "Sunny." }] },
  },
  { type: "response.completed", response: { id: "resp_final" } },
)

describe("organization routes", () => {
  it.effect("uses the Responses route endpoint with stateless portable options", () =>
    Effect.gen(function* () {
      const response = yield* LLMClient.generate(
        LLM.request({
          model,
          system: "Help with code.",
          prompt: "Hello",
          promptCacheKey: "session-cache",
          providerOptions: {
            store: true,
            include: ["reasoning.encrypted_content"],
            previousResponseId: "resp_old",
            reasoningEffort: "low",
            reasoningSummary: "auto",
            serviceTier: "priority",
          },
        }),
      ).pipe(
        Effect.provide(
          dynamicResponse((input) =>
            Effect.gen(function* () {
              expect(input.request.url).toBe("https://console.example.test/inference/route/openai/v1/responses")
              expect(input.request.headers.authorization).toBe("Bearer session-test")
              expect(input.request.headers["x-opencode-org-id"]).toBe("org_test")
              expect(yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(input.text)).toEqual({
                model: "route/coding",
                input: [{ role: "user", content: [{ type: "input_text", text: "Hello" }] }],
                instructions: "Help with code.",
                stream: true,
                store: false,
                provider_options: { "openai-responses": { include: ["reasoning.encrypted_content"] } },
                reasoning: { effort: "low" },
              })
              return input.respond(finalText, { headers: { "content-type": "text/event-stream" } })
            }),
          ),
        ),
      )
      expect(response.text).toBe("Sunny.")
    }),
  )

  it.effect("omits an unknown output limit", () =>
    Effect.gen(function* () {
      const prepared = yield* compileRequest(LLM.request({ model, prompt: "Hello", generation: { maxTokens: 0 } }))
      expect(prepared.body.max_output_tokens).toBeUndefined()
    }),
  )

  for (const fixture of fixtures) {
    it.effect(`preserves ${fixture.protocol} continuation metadata through a streamed parallel tool loop`, () =>
      Effect.gen(function* () {
        const metadata = {
          protocol: fixture.protocol,
          model: "native-model",
          connection_id: "conn_native",
          endpoint_id: "endpoint_native",
          content: fixture.content,
          group_id: "resp_tools",
        }
        const marker = { group_id: "resp_tools" }
        const items = [
          {
            type: "reasoning",
            id: "rs_1",
            summary: [{ type: "summary_text", text: "Need a lookup" }],
            provider_metadata: metadata,
          },
          {
            type: "message",
            id: "msg_1",
            role: "assistant",
            content: [{ type: "output_text", text: "Checking." }],
            provider_metadata: marker,
          },
          {
            type: "function_call",
            id: "fc_lookup",
            call_id: "call_lookup",
            name: "lookup",
            arguments: '{"query":"weather"}',
            provider_metadata: marker,
          },
          {
            type: "function_call",
            id: "fc_clock",
            call_id: "call_clock",
            name: "clock",
            arguments: "{}",
            provider_metadata: marker,
          },
        ]
        const first = yield* LLMClient.generate(LLM.request({ model, prompt: "Check weather and time." })).pipe(
          Effect.provide(
            fixedResponse(
              sseEvents(
                {
                  type: "response.output_item.added",
                  output_index: 0,
                  item: { type: "reasoning", id: "rs_1", summary: [] },
                },
                {
                  type: "response.reasoning_summary_text.delta",
                  item_id: "rs_1",
                  summary_index: 0,
                  delta: "Need a lookup",
                },
                {
                  type: "response.output_item.added",
                  output_index: 1,
                  item: { type: "message", id: "msg_1", role: "assistant", content: [] },
                },
                { type: "response.output_text.delta", item_id: "msg_1", delta: "Checking." },
                {
                  type: "response.output_item.added",
                  output_index: 2,
                  item: {
                    type: "function_call",
                    id: "fc_lookup",
                    call_id: "call_lookup",
                    name: "lookup",
                    arguments: "",
                  },
                },
                { type: "response.function_call_arguments.delta", item_id: "fc_lookup", delta: '{"query":"weather"}' },
                {
                  type: "response.output_item.added",
                  output_index: 3,
                  item: { type: "function_call", id: "fc_clock", call_id: "call_clock", name: "clock", arguments: "" },
                },
                { type: "response.function_call_arguments.delta", item_id: "fc_clock", delta: "{}" },
                ...items.map((item, output_index) => ({ type: "response.output_item.done", output_index, item })),
                { type: "response.completed", response: { id: "resp_tools", output: items } },
              ),
            ),
          ),
        )
        expect(first.toolCalls).toHaveLength(2)
        expect(first.events.filter(LLMEvent.is.toolCall)).toHaveLength(2)
        expect(
          first.message.content.map((part) => part.providerMetadata?.["opencode-routes-org_test"]?.providerMetadata),
        ).toEqual([metadata, marker, marker, marker])

        const second = yield* LLMClient.generate(
          LLM.request({
            model,
            providerOptions: { previousResponseId: "resp_tools" },
            messages: [
              Message.user("Check weather and time."),
              first.message,
              Message.tool({ id: "call_lookup", name: "lookup", result: { weather: "sunny" } }),
              Message.tool({ id: "call_clock", name: "clock", result: { time: "noon" } }),
            ],
          }),
        ).pipe(
          Effect.provide(
            dynamicResponse((input) =>
              Effect.gen(function* () {
                const body = yield* Schema.decodeUnknownEffect(
                  Schema.fromJsonString(
                    Schema.Struct({
                      input: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
                      store: Schema.Boolean,
                      include: Schema.optional(Schema.Array(Schema.String)),
                      previous_response_id: Schema.optional(Schema.String),
                    }),
                  ),
                )(input.text)
                expect(body.store).toBe(false)
                expect(body.include).toBeUndefined()
                expect(body.previous_response_id).toBeUndefined()
                expect(body.input.map((item) => item.type ?? item.role)).toEqual([
                  "user",
                  "reasoning",
                  "message",
                  "function_call",
                  "function_call",
                  "function_call_output",
                  "function_call_output",
                ])
                expect(body.input.slice(1, 5).map((item) => item.provider_metadata)).toEqual([
                  metadata,
                  marker,
                  marker,
                  marker,
                ])
                expect(body.input.slice(3, 5).map((item) => item.call_id)).toEqual(["call_lookup", "call_clock"])
                return input.respond(finalText, { headers: { "content-type": "text/event-stream" } })
              }),
            ),
          ),
        )
        expect(second.text).toBe("Sunny.")
      }),
    )
  }

  it.effect("preserves opaque state on an empty reasoning item", () =>
    Effect.gen(function* () {
      const metadata = {
        protocol: "anthropic-messages",
        content: [{ type: "redacted_thinking", data: "opaque" }],
        group_id: "resp_empty",
      }
      const response = yield* LLMClient.generate(LLM.request({ model, prompt: "Think." })).pipe(
        Effect.provide(
          fixedResponse(
            sseEvents(
              {
                type: "response.output_item.done",
                item: { type: "reasoning", id: "rs_empty", summary: [], provider_metadata: metadata },
              },
              { type: "response.completed", response: { id: "resp_empty" } },
            ),
          ),
        ),
      )
      const replay = yield* compileRequest(LLM.request({ model, messages: [response.message] }))
      expect(replay.body.input).toEqual([
        { type: "reasoning", id: "rs_empty", summary: [], encrypted_content: null, provider_metadata: metadata },
      ])
    }),
  )

  it.effect("keeps opaque route metadata out of other Responses providers", () =>
    Effect.gen(function* () {
      const other = provider
        .configure({
          apiKey: "test-key",
          baseURL: "https://other.example.test/v1",
          provider: "opencode-routes-org_test",
        })
        .model("other")
      const response = yield* LLMClient.generate(LLM.request({ model: other, prompt: "Hello" })).pipe(
        Effect.provide(
          fixedResponse(
            sseEvents(
              {
                type: "response.output_item.done",
                item: {
                  type: "message",
                  id: "msg_1",
                  content: [{ type: "output_text", text: "Hi" }],
                  provider_metadata: { group_id: "resp_1", secret: "opaque" },
                },
              },
              { type: "response.completed", response: { id: "resp_1" } },
            ),
          ),
        ),
      )
      expect(response.message.content[0]?.providerMetadata).toEqual({ "opencode-routes-org_test": { itemId: "msg_1" } })
      const replay = yield* compileRequest(
        LLM.request({
          model: other,
          messages: [
            Message.assistant({
              type: "text",
              text: "Hi",
              providerMetadata: {
                "opencode-routes-org_test": { itemId: "msg_1", providerMetadata: { secret: "opaque" } },
              },
            }),
          ],
        }),
      )
      expect(replay.body.input).toEqual([
        {
          type: "message",
          id: "msg_1",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "Hi" }],
        },
      ])
      expect(replay.body.include).toEqual(["reasoning.encrypted_content"])
    }),
  )
})
