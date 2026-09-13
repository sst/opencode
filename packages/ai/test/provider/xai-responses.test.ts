import { describe, expect } from "bun:test"
import { Effect, Layer, Stream } from "effect"
import { LLM, LLMEvent, Message } from "../../src/index.js"
import { XAI } from "../../src/providers.js"
import { OpenResponses } from "../../src/protocols/open-responses.js"
import { OpenAIResponses } from "../../src/protocols/openai-responses.js"
import * as ProviderShared from "../../src/protocols/shared.js"
import { XAIResponses } from "../../src/protocols/xai-responses.js"
import {
  LLMClient,
  RequestExecutor,
  WebSocketTransport,
  type ChannelCheckpoint,
  type WebSocketChannelDriver,
} from "../../src/route.js"
import { compileRequest } from "../../src/route/client.js"
import { it } from "../lib/effect.js"
import { fixedResponse } from "../lib/http.js"
import { sseEvents } from "../lib/sse.js"

const model = XAI.configure({ apiKey: "test", baseURL: "https://api.x.ai/v1" }).responses("grok-4.6")

/** Runs a request through the WebSocket transport and hands back its channel driver; the HTTP fallback answers. */
const channelDriver = (request: ReturnType<typeof LLM.request>) =>
  Effect.gen(function* () {
    let driver: WebSocketChannelDriver | undefined
    yield* LLMClient.generate(request, {
      webSocket: {
        execute: (exchange) =>
          Effect.sync(() => {
            driver = exchange.driver
            return { frames: exchange.fallback(), complete: Effect.void }
          }),
      },
    }).pipe(Effect.provide(fixedResponse(sseEvents({ type: "response.completed", response: { id: "http" } }))))
    if (!driver) throw new Error("Expected a WebSocket channel driver")
    return driver
  })

const completed = (driver: WebSocketChannelDriver, id: string) =>
  Effect.gen(function* () {
    const create = yield* driver.create(undefined)
    yield* driver.observe(create, ProviderShared.encodeJson({ type: "response.created", response: { id } }))
    const observation = yield* driver.observe(
      create,
      ProviderShared.encodeJson({ type: "response.completed", response: { id } }),
    )
    if (observation.type !== "completed" || !observation.checkpoint) throw new Error("Expected a checkpoint")
    return observation.checkpoint
  })

describe("xAI Responses route", () => {
  it.effect("composes the Open Responses baseline with xAI extensions", () =>
    Effect.gen(function* () {
      expect(XAIResponses.protocol.body).not.toBe(OpenResponses.protocol.body)
      expect(XAIResponses.protocol.body).not.toBe(OpenAIResponses.protocol.body)

      const prepared = yield* compileRequest(LLM.request({ model, prompt: "Hello" }))
      expect(prepared.protocol).toBe("xai-responses")
      expect(prepared.body.store).toBe(false)
      expect(prepared.body.include).toEqual(["reasoning.encrypted_content"])
    }),
  )

  it.effect("allows callers to opt out of encrypted reasoning", () =>
    Effect.gen(function* () {
      const prepared = yield* compileRequest(LLM.request({ model, prompt: "Hello", providerOptions: { include: [] } }))

      expect(prepared.body.store).toBe(false)
      expect(prepared.body.include).toBeUndefined()
    }),
  )

  it.effect("parses xAI reasoning summaries", () =>
    Effect.gen(function* () {
      const response = yield* LLMClient.generate(LLM.request({ model, prompt: "Think" })).pipe(
        Effect.provide(
          fixedResponse(
            sseEvents(
              {
                type: "response.output_item.added",
                item: { type: "reasoning", id: "reasoning_1" },
              },
              // Grok streams reasoning with the standard summary event name.
              {
                type: "response.reasoning_summary_text.delta",
                item_id: "reasoning_1",
                summary_index: 0,
                delta: "Considering.",
              },
              {
                type: "response.output_item.done",
                item: { type: "reasoning", id: "reasoning_1", encrypted_content: "opaque" },
              },
              { type: "response.completed", response: { id: "response_1" } },
            ),
          ),
        ),
      )

      expect(response.message.content.find((part) => part.type === "reasoning")).toMatchObject({
        type: "reasoning",
        text: "Considering.",
        providerMetadata: { xai: { itemId: "reasoning_1", reasoningEncryptedContent: "opaque" } },
      })
    }),
  )

  it.effect("routes xAI reasoning summaries by output index", () =>
    Effect.gen(function* () {
      const response = yield* LLMClient.generate(LLM.request({ model, prompt: "Think" })).pipe(
        Effect.provide(
          fixedResponse(
            sseEvents(
              {
                type: "response.output_item.added",
                output_index: 3,
                item: { type: "reasoning", id: "reasoning_1" },
              },
              {
                type: "response.reasoning_summary_text.delta",
                output_index: 3,
                item_id: "wrong_reasoning",
                summary_index: 0,
                delta: "Considering.",
              },
              {
                type: "response.output_item.done",
                output_index: 3,
                item: { type: "reasoning", id: "reasoning_1", encrypted_content: "opaque" },
              },
              { type: "response.completed", response: { id: "response_1" } },
            ),
          ),
        ),
      )

      expect(response.reasoning).toBe("Considering.")
      expect(response.message.content.find((part) => part.type === "reasoning")).toMatchObject({
        providerMetadata: { xai: { itemId: "reasoning_1", reasoningEncryptedContent: "opaque" } },
      })
    }),
  )

  it.effect("replays xAI hosted tool items when continuing with the same provider", () =>
    Effect.gen(function* () {
      const item = { type: "x_search_call", id: "x_search_1", status: "completed", action: { query: "news" } }
      const prepared = yield* compileRequest(
        LLM.request({
          model,
          messages: [
            Message.assistant([
              {
                type: "tool-result",
                id: "x_search_1",
                name: "x_search",
                result: { type: "json", value: item },
                providerExecuted: true,
                providerMetadata: { xai: { itemId: "x_search_1" } },
              },
            ]),
          ],
        }),
      )

      expect(prepared.body.input).toEqual([item])
    }),
  )

  it.effect("replays shared and xAI hosted tool items but rejects OpenAI extensions", () =>
    Effect.gen(function* () {
      const items = [
        { type: "web_search_call", id: "ws_1", status: "completed" },
        { type: "image_generation_call", id: "ig_1", status: "completed", result: "AQID" },
        { type: "computer_call", id: "computer_1", status: "completed" },
      ]
      const prepared = yield* compileRequest(
        LLM.request({
          model,
          messages: items.map((item) =>
            Message.assistant({
              type: "tool-result",
              id: item.id,
              name: item.type,
              result: { type: "json", value: item },
              providerExecuted: true,
              providerMetadata: { xai: { itemId: item.id } },
            }),
          ),
        }),
      )

      expect(prepared.body.input).toEqual([
        items[0],
        items[1],
        { role: "user", content: [{ type: "input_text", text: JSON.stringify(items[2]) }] },
      ])
    }),
  )

  it.effect("classifies xAI's untyped WebSocket error envelope", () =>
    Effect.gen(function* () {
      // xAI answers a rejected response.create with an error envelope that carries no event type.
      const envelope = ProviderShared.encodeJson({
        error: {
          message:
            'Request validation error: {"code":"400","error":"Argument not supported: instructions and previous_response_id together"}',
          type: "api_error",
        },
      })
      const webSocket = WebSocketTransport.makeDirect({
        open: () =>
          Effect.succeed({ sendText: () => Effect.void, messages: Stream.make(envelope), close: Effect.void }),
      })
      const error = yield* LLMClient.generate(LLM.request({ model, prompt: "Hello" }), { webSocket }).pipe(
        Effect.provide(
          LLMClient.layer.pipe(
            Layer.provide(
              Layer.succeed(
                RequestExecutor.Service,
                RequestExecutor.Service.of({ execute: () => Effect.die("unexpected HTTP request") }),
              ),
            ),
          ),
        ),
        Effect.flip,
      )

      expect(error.reason._tag).toBe("ProviderInternal")
      expect(error.message).toContain("Argument not supported: instructions and previous_response_id together")
      expect(error.reason.body).toBe(envelope)
    }),
  )

  it.effect("continues stored responses without instructions and sends unstored steps in full", () =>
    Effect.gen(function* () {
      const step = (store: boolean, ...prompts: string[]) =>
        LLM.request({
          model,
          system: "You are terse.",
          messages: prompts.map((prompt) => Message.user(prompt)),
          providerOptions: { store },
        })
      const send = (store: boolean, checkpoint: ChannelCheckpoint) =>
        channelDriver(step(store, "First", "Second")).pipe(Effect.flatMap((driver) => driver.create(checkpoint)))

      const stored = yield* send(true, yield* completed(yield* channelDriver(step(true, "First")), "resp_1"))
      expect(stored.mode).toBe("incremental")
      expect(JSON.parse(stored.message)).toEqual({
        type: "response.create",
        model: "grok-4.6",
        store: true,
        include: ["reasoning.encrypted_content"],
        previous_response_id: "resp_1",
        input: [{ role: "user", content: [{ type: "input_text", text: "Second" }] }],
      })

      // The connection cache only serves stored responses, so the default store: false never chains.
      const unstored = yield* send(false, yield* completed(yield* channelDriver(step(false, "First")), "resp_1"))
      expect(unstored.mode).toBe("full")
      expect(JSON.parse(unstored.message)).toMatchObject({
        instructions: "You are terse.",
        store: false,
        input: [
          { role: "user", content: [{ type: "input_text", text: "First" }] },
          { role: "user", content: [{ type: "input_text", text: "Second" }] },
        ],
      })
      expect(JSON.parse(unstored.message).previous_response_id).toBeUndefined()
    }),
  )

  it.effect("parses xAI hosted tool items", () =>
    Effect.gen(function* () {
      const item = { type: "x_search_call", id: "x_search_1", status: "completed", action: { query: "news" } }
      const response = yield* LLMClient.generate(LLM.request({ model, prompt: "Search X" })).pipe(
        Effect.provide(
          fixedResponse(
            sseEvents(
              { type: "response.output_item.done", item },
              { type: "response.completed", response: { id: "response_1" } },
            ),
          ),
        ),
      )

      expect(response.events.find(LLMEvent.is.toolCall)).toMatchObject({
        id: "x_search_1",
        name: "x_search",
        input: { query: "news" },
        providerExecuted: true,
        providerMetadata: { xai: { itemId: "x_search_1" } },
      })
      expect(response.events.find(LLMEvent.is.toolResult)).toMatchObject({
        result: { type: "json", value: item },
        providerMetadata: { xai: { itemId: "x_search_1" } },
      })
    }),
  )
})
