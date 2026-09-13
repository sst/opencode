import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { HttpClientRequest } from "effect/unstable/http"
import { LLM, Message, ToolCallPart } from "../../src/index.js"
import { GoogleVertex, GoogleVertexChat, GoogleVertexMessages, GoogleVertexResponses } from "../../src/providers.js"
import { LLMClient } from "../../src/route.js"
import { compileRequest } from "../../src/route/client.js"
import { it } from "../lib/effect.js"
import { dynamicResponse, fixedResponse } from "../lib/http.js"
import { deltaChunk, finishChunk } from "../lib/openai-chunks.js"
import { sseEvents } from "../lib/sse.js"

describe("Google Vertex providers", () => {
  it.effect("sends Gemini requests to the global Vertex endpoint", () =>
    Effect.gen(function* () {
      const response = yield* LLMClient.generate(
        LLM.request({
          model: GoogleVertex.configure({
            accessToken: "vertex-token",
            location: "global",
            project: "vertex-project",
          }).model("gemini-3.5-flash"),
          prompt: "Say hello.",
        }),
      ).pipe(
        Effect.provide(
          dynamicResponse((input) =>
            Effect.gen(function* () {
              const request = yield* HttpClientRequest.toWeb(input.request).pipe(Effect.orDie)
              expect(request.url).toBe(
                "https://aiplatform.googleapis.com/v1beta1/projects/vertex-project/locations/global/publishers/google/models/gemini-3.5-flash:streamGenerateContent?alt=sse",
              )
              expect(request.headers.get("authorization")).toBe("Bearer vertex-token")
              expect(yield* Effect.promise(() => request.json())).toMatchObject({
                contents: [{ role: "user", parts: [{ text: "Say hello." }] }],
              })
              return input.respond(
                sseEvents({
                  candidates: [
                    {
                      content: { role: "model", parts: [{ text: "Hello." }] },
                      finishReason: "STOP",
                    },
                  ],
                }),
                { headers: { "content-type": "text/event-stream" } },
              )
            }),
          ),
        ),
      )

      expect(response.text).toBe("Hello.")
    }),
  )

  it.effect("adds billing labels to Vertex Gemini requests", () =>
    Effect.gen(function* () {
      const prepared = yield* compileRequest(
        LLM.request({
          model: GoogleVertex.configure({
            accessToken: "vertex-token",
            project: "vertex-project",
            providerOptions: {
              labels: { component: "opencode", environment: "test" },
            },
          }).model("gemini-3.5-flash"),
          prompt: "Say hello.",
        }),
      )

      expect(prepared.body).toMatchObject({
        labels: { component: "opencode", environment: "test" },
      })
    }),
  )

  it.effect("strips function call ids Vertex does not accept from lowered bodies", () =>
    Effect.gen(function* () {
      const prepared = yield* compileRequest(
        LLM.request({
          model: GoogleVertex.configure({
            accessToken: "vertex-token",
            project: "vertex-project",
          }).model("gemini-3.5-flash"),
          messages: [
            Message.assistant([
              ToolCallPart.make({
                id: "call_1",
                name: "lookup",
                input: { query: "weather" },
                providerMetadata: { vertex: { functionCallId: "provider_call_1" } },
              }),
            ]),
            Message.tool({
              id: "call_1",
              name: "lookup",
              result: "sunny",
              resultType: "text",
              providerMetadata: { vertex: { functionCallId: "provider_call_1" } },
            }),
          ],
        }),
      )

      expect(JSON.stringify(prepared.body.contents)).not.toContain('"id"')
      expect(prepared.body.contents).toMatchObject([
        { role: "model", parts: [{ functionCall: { id: undefined, name: "lookup", args: { query: "weather" } } }] },
        {
          role: "user",
          parts: [
            {
              functionResponse: {
                id: undefined,
                name: "lookup",
                response: { name: "lookup", content: "sunny" },
              },
            },
          ],
        },
      ])
    }),
  )

  it.effect("round-trips Vertex Gemini metadata through signed content, tool calls, and usage", () =>
    Effect.gen(function* () {
      const model = GoogleVertex.configure({
        accessToken: "vertex-token",
        project: "vertex-project",
      }).model("gemini-3.5-flash")
      const response = yield* LLMClient.generate(LLM.request({ model, prompt: "Check the weather." })).pipe(
        Effect.provide(
          fixedResponse(
            sseEvents({
              candidates: [
                {
                  content: {
                    role: "model",
                    parts: [
                      { text: "Thinking.", thought: true, thoughtSignature: "reasoning_sig" },
                      { text: "Checking.", thoughtSignature: "text_sig" },
                      {
                        functionCall: { id: "provider_call_1", name: "lookup", args: { query: "weather" } },
                        thoughtSignature: "tool_sig",
                      },
                    ],
                  },
                  finishReason: "STOP",
                },
              ],
              promptFeedback: { blockReasonMessage: "Reviewed" },
              usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2, thoughtsTokenCount: 1 },
            }),
          ),
        ),
      )
      const reasoning = response.events.find((event) => event.type === "reasoning-end")
      const text = response.events.find((event) => event.type === "text-delta")
      const toolCall = response.toolCalls[0]

      expect(reasoning?.providerMetadata).toEqual({ vertex: { thoughtSignature: "reasoning_sig" } })
      expect(text?.providerMetadata).toEqual({ vertex: { thoughtSignature: "text_sig" } })
      expect(toolCall).toMatchObject({
        id: "provider_call_1",
        providerMetadata: { vertex: { thoughtSignature: "tool_sig" } },
      })
      expect(response.usage?.providerMetadata).toEqual({
        vertex: { promptTokenCount: 5, candidatesTokenCount: 2, thoughtsTokenCount: 1 },
      })
      expect(response.events.at(-1)?.providerMetadata).toEqual({
        vertex: { promptFeedback: { blockReasonMessage: "Reviewed" } },
      })

      const prepared = yield* compileRequest(
        LLM.request({
          model,
          messages: [
            Message.assistant([
              { type: "reasoning", text: "Thinking.", providerMetadata: reasoning?.providerMetadata },
              { type: "text", text: "Checking.", providerMetadata: text?.providerMetadata },
              ToolCallPart.make({
                id: toolCall.id,
                name: toolCall.name,
                input: toolCall.input,
                providerMetadata: toolCall.providerMetadata,
              }),
            ]),
            Message.tool({ id: toolCall.id, name: toolCall.name, result: "sunny", resultType: "text" }),
          ],
        }),
      )

      expect(prepared.body.contents).toEqual([
        {
          role: "model",
          parts: [
            { text: "Thinking.", thought: true, thoughtSignature: "reasoning_sig" },
            { text: "Checking.", thoughtSignature: "text_sig" },
            { functionCall: { name: "lookup", args: { query: "weather" } }, thoughtSignature: "tool_sig" },
          ],
        },
        {
          role: "user",
          parts: [{ functionResponse: { name: "lookup", response: { name: "lookup", content: "sunny" } } }],
        },
      ])
    }),
  )

  it.effect("projects Anthropic Messages onto the Vertex raw-predict API", () =>
    Effect.gen(function* () {
      const model = GoogleVertexMessages.configure({
        accessToken: "vertex-token",
        location: "eu",
        project: "vertex-project",
      }).model("claude-sonnet-4-6")
      const response = yield* LLMClient.generate(
        LLM.request({
          model,
          prompt: "Say hello.",
        }),
      ).pipe(
        Effect.provide(
          dynamicResponse((input) =>
            Effect.gen(function* () {
              const request = yield* HttpClientRequest.toWeb(input.request).pipe(Effect.orDie)
              expect(request.url).toBe(
                "https://aiplatform.eu.rep.googleapis.com/v1/projects/vertex-project/locations/eu/publishers/anthropic/models/claude-sonnet-4-6:streamRawPredict",
              )
              expect(request.headers.get("authorization")).toBe("Bearer vertex-token")
              expect(request.headers.get("anthropic-version")).toBe("2023-06-01")
              const body = yield* Effect.promise(() => request.json())
              expect(body).toMatchObject({
                anthropic_version: "vertex-2023-10-16",
                messages: [{ role: "user", content: [{ type: "text", text: "Say hello." }] }],
                stream: true,
              })
              expect(body).not.toHaveProperty("model")
              return input.respond(
                sseEvents(
                  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
                  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello." } },
                  { type: "content_block_stop", index: 0 },
                  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
                  { type: "message_stop" },
                ),
                { headers: { "content-type": "text/event-stream" } },
              )
            }),
          ),
        ),
      )

      expect(model.provider).toBe("google-vertex")
      expect(response.text).toBe("Hello.")
    }),
  )

  it.effect("sends MaaS requests through Vertex Chat Completions", () =>
    Effect.gen(function* () {
      const response = yield* LLMClient.generate(
        LLM.request({
          model: GoogleVertexChat.configure({
            accessToken: "vertex-token",
            location: "global",
            project: "vertex-project",
          }).model("deepseek-ai/deepseek-v3.2-maas"),
          prompt: "Say hello.",
        }),
      ).pipe(
        Effect.provide(
          dynamicResponse((input) =>
            Effect.gen(function* () {
              const request = yield* HttpClientRequest.toWeb(input.request).pipe(Effect.orDie)
              expect(request.url).toBe(
                "https://aiplatform.googleapis.com/v1/projects/vertex-project/locations/global/endpoints/openapi/chat/completions",
              )
              expect(request.headers.get("authorization")).toBe("Bearer vertex-token")
              expect(yield* Effect.promise(() => request.json())).toMatchObject({
                model: "deepseek-ai/deepseek-v3.2-maas",
                messages: [{ role: "user", content: "Say hello." }],
                stream: true,
                stream_options: { include_usage: true },
              })
              return input.respond(sseEvents(deltaChunk({ content: "Hello." }), finishChunk("stop")), {
                headers: { "content-type": "text/event-stream" },
              })
            }),
          ),
        ),
      )

      expect(response.text).toBe("Hello.")
    }),
  )

  it.effect("sends Grok requests through Vertex Responses", () =>
    Effect.gen(function* () {
      const response = yield* LLMClient.generate(
        LLM.request({
          model: GoogleVertexResponses.configure({
            accessToken: "vertex-token",
            location: "global",
            project: "vertex-project",
          }).model("xai/grok-4.20-reasoning"),
          prompt: "Say hello.",
        }),
      ).pipe(
        Effect.provide(
          dynamicResponse((input) =>
            Effect.gen(function* () {
              const request = yield* HttpClientRequest.toWeb(input.request).pipe(Effect.orDie)
              expect(request.url).toBe(
                "https://aiplatform.googleapis.com/v1/projects/vertex-project/locations/global/endpoints/openapi/responses",
              )
              expect(request.headers.get("authorization")).toBe("Bearer vertex-token")
              expect(yield* Effect.promise(() => request.json())).toMatchObject({
                model: "xai/grok-4.20-reasoning",
                input: [{ role: "user", content: [{ type: "input_text", text: "Say hello." }] }],
                store: false,
                stream: true,
              })
              return input.respond(
                sseEvents(
                  { type: "response.output_item.added", item: { type: "message", id: "msg_1" } },
                  { type: "response.output_text.delta", item_id: "msg_1", delta: "Hello." },
                  { type: "response.completed", response: { id: "resp_1" } },
                ),
                { headers: { "content-type": "text/event-stream" } },
              )
            }),
          ),
        ),
      )

      expect(response.text).toBe("Hello.")
    }),
  )

  it.effect("routes tuned Gemini models through their deployed endpoint", () =>
    Effect.gen(function* () {
      const response = yield* LLMClient.generate(
        LLM.request({
          model: GoogleVertex.configure({
            accessToken: "vertex-token",
            location: "us-central1",
            project: "vertex-project",
          }).model("endpoints/1234567890"),
          prompt: "Say hello.",
        }),
      ).pipe(
        Effect.provide(
          dynamicResponse((input) =>
            Effect.gen(function* () {
              const request = yield* HttpClientRequest.toWeb(input.request).pipe(Effect.orDie)
              expect(request.url).toBe(
                "https://us-central1-aiplatform.googleapis.com/v1beta1/projects/vertex-project/locations/us-central1/endpoints/1234567890:streamGenerateContent?alt=sse",
              )
              return input.respond(
                sseEvents({
                  candidates: [
                    {
                      content: { role: "model", parts: [{ text: "Hello." }] },
                      finishReason: "STOP",
                    },
                  ],
                }),
                { headers: { "content-type": "text/event-stream" } },
              )
            }),
          ),
        ),
      )

      expect(response.text).toBe("Hello.")
    }),
  )

  test("rejects tuned Gemini models in express mode", () => {
    expect(() => GoogleVertex.configure({ apiKey: "fixture" }).model("endpoints/1234567890")).toThrow(
      expect.objectContaining({
        _tag: "ProviderConfiguration",
        provider: "google-vertex",
        message: "Google Vertex tuned models do not support Express Mode API keys",
      }),
    )
  })
})
