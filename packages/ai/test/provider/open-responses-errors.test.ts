import { expect } from "bun:test"
import { Effect, Schema } from "effect"
import { LLM, LLMClient } from "../../src/index.js"
import { OpenResponses } from "../../src/protocols/open-responses.js"
import { Meta } from "../../src/providers/index.js"
import { configure } from "../../src/providers/openai-compatible-responses.js"
import { it } from "../lib/effect.js"
import { fixedResponse } from "../lib/http.js"
import { sseEvents } from "../lib/sse.js"

const decodeEvent = Schema.decodeUnknownEffect(OpenResponses.protocol.stream.event)

it.effect("normalizes flat errors in shared SSE and WebSocket decoding", () =>
  Effect.gen(function* () {
    const frame = {
      type: "error",
      sequence_number: 4,
      code: "server_shutting_down",
      message: "Server is shutting down. Please retry your request.",
      param: null,
    }
    for (const decode of [decodeEvent, OpenResponses.decodeChannelEvent]) {
      const event = yield* decode(JSON.stringify(frame))
      expect(event).toEqual({
        type: "error",
        sequence_number: 4,
        error: { code: frame.code, message: frame.message, param: null },
      })

      for (const unchanged of [
        event,
        { type: "error" },
        {
          type: "response.failed",
          response: { id: "resp_failed", error: { code: "server_error", message: "Internal server error" } },
        },
        { type: "response.output_text.delta", item_id: "msg_text", delta: "Hello" },
      ]) {
        expect(yield* decode(JSON.stringify(unchanged))).toEqual(unchanged)
      }
    }
  }),
)

it.effect("continues to normalize untyped xAI WebSocket errors", () =>
  Effect.gen(function* () {
    const frame = { error: { type: "api_error", message: "gRPC error: Response with id=resp_missing not found" } }
    expect(yield* OpenResponses.decodeChannelEvent(JSON.stringify(frame))).toEqual({ ...frame, type: "error" })
  }),
)

it.effect("retains classification and original error bodies through Meta and generic Responses routes", () =>
  Effect.gen(function* () {
    const raw = `{
  "type": "error",
  "sequence_number": 4,
  "code": "server_shutting_down",
  "message": "Server is shutting down. Please retry your request.",
  "param": null,
  "diagnostic": "retain-original-frame"
}`
    for (const model of [
      Meta.configure({ apiKey: "fixture" }).responses("muse-spark-1.3"),
      configure({ apiKey: "fixture", provider: "gateway", baseURL: "https://responses.example.test/v1" }).model(
        "example-model",
      ),
    ]) {
      const error = yield* LLMClient.generate(LLM.request({ model, prompt: "Hello" })).pipe(
        Effect.provide(fixedResponse(sseEvents(raw.replaceAll("\n", "\ndata: ")))),
        Effect.flip,
      )
      expect(error.reason._tag).toBe("ProviderInternal")
      expect(error.message).toBe("server_shutting_down: Server is shutting down. Please retry your request.")
      expect(error.reason.body).toBe(raw)
      expect(error.reason.http?.status).toBe(200)
    }
  }),
)
