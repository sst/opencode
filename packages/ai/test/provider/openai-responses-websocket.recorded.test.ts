import { describe, expect } from "bun:test"
import { Effect, Stream } from "effect"
import { Socket } from "effect/unstable/socket"
import { LLM, LLMRequest, Message, ToolRuntime } from "../../src/index.js"
import {
  LLMClient,
  WebSocketTransport,
  type ChannelCheckpoint,
  type ChannelObservation,
  type WebSocketChannelExchange,
  type WebSocketChannelExecutor,
  type WebSocketConnection,
} from "../../src/route.js"
import { configure } from "../../src/providers/openai.js"
import { decodeJson } from "../../src/protocols/shared.js"
import { weatherRuntimeTool, weatherTool, weatherToolName } from "../recorded-scenarios.js"
import { recordedTests } from "../recorded-test.js"

const model = configure({ apiKey: process.env.OPENAI_API_KEY ?? "fixture" }).responses("gpt-5.5")
const recorded = recordedTests({
  prefix: "openai-responses-websocket",
  provider: "openai",
  protocol: "openai-responses",
  requires: ["OPENAI_API_KEY"],
  tags: ["transport:websocket"],
  metadata: { transport: "websocket", model: model.id },
})

const observationFrame = (observation: ChannelObservation) => {
  if (observation.type === "frame" || observation.type === "completed" || observation.type === "incomplete")
    return Effect.succeed(observation.frame)
  return Effect.fail(observation.error)
}

const terminal = (observation: ChannelObservation) => observation.type !== "frame"

// This channel fixture supports sequential test traffic.
const makeChannel = Effect.gen(function* () {
  const constructor = yield* Socket.WebSocketConstructor
  let connection: WebSocketConnection | undefined
  let checkpoint: ChannelCheckpoint | undefined
  let pending: ChannelCheckpoint | undefined
  let opens = 0
  const sent: unknown[] = []

  const close = Effect.suspend(() => {
    const current = connection
    connection = undefined
    return current ? current.close : Effect.void
  })
  yield* Effect.addFinalizer(() => close)

  const executor: WebSocketChannelExecutor = {
    execute: (exchange: WebSocketChannelExchange) =>
      Effect.gen(function* () {
        if (!connection) {
          connection = yield* WebSocketTransport.open(exchange.connect).pipe(
            Effect.provideService(Socket.WebSocketConstructor, constructor),
          )
          opens += 1
        }
        const current = connection
        const create = yield* exchange.driver.create(checkpoint)
        if (create.mode === "full") checkpoint = undefined
        pending = undefined
        sent.push(decodeJson(create.message))
        yield* current.sendText(create.message)
        const decoder = new TextDecoder()
        return {
          frames: current.messages.pipe(
            Stream.map((message) => WebSocketTransport.messageText(message, decoder)),
            Stream.mapEffect((frame) => exchange.driver.observe(create, frame)),
            Stream.tap((observation) =>
              Effect.sync(() => {
                if (!terminal(observation)) return
                pending = observation.type === "completed" ? observation.checkpoint : undefined
                if (observation.type !== "completed") checkpoint = undefined
              }),
            ),
            Stream.takeUntil(terminal),
            Stream.mapEffect(observationFrame),
          ),
          complete: Effect.sync(() => {
            checkpoint = pending
            pending = undefined
          }),
        }
      }),
  }

  return {
    executor,
    sent,
    opens: () => opens,
    reconnect: (preserveCheckpoint = false) =>
      close.pipe(
        Effect.andThen(
          Effect.sync(() => {
            pending = undefined
            if (!preserveCheckpoint) checkpoint = undefined
          }),
        ),
      ),
  }
})

describe("OpenAI Responses WebSocket recorded", () => {
  recorded.effect.with("continues a tool call over one socket", { tags: ["tool", "continuation"] }, () =>
    Effect.gen(function* () {
      const channel = yield* makeChannel
      const request = LLM.request({
        id: "recorded_openai_responses_websocket_tool",
        model,
        system: "Call get_weather once, then reply exactly: Paris is sunny.",
        prompt: "What is the weather in Paris?",
        tools: [weatherTool],
        generation: { maxTokens: 50 },
        cache: "none",
      })
      const first = yield* LLMClient.generate(request, { webSocket: channel.executor })
      const call = first.toolCalls[0]
      if (!call) yield* Effect.die("Expected get_weather tool call")
      const result = yield* ToolRuntime.dispatch({ [weatherToolName]: weatherRuntimeTool }, call)
      const second = yield* LLMClient.generate(
        LLMRequest.update(request, {
          messages: [
            ...request.messages,
            first.message,
            Message.tool({ id: call.id, name: call.name, result: result.result }),
          ],
        }),
        { webSocket: channel.executor },
      )

      expect(second.text).toBe("Paris is sunny.")
      expect(channel.opens()).toBe(1)
      expect(channel.sent).toHaveLength(2)
      expect(channel.sent[1]).toMatchObject({
        instructions: "Call get_weather once, then reply exactly: Paris is sunny.",
        previous_response_id: expect.any(String),
        input: [{ type: "function_call_output", call_id: call.id, output: expect.any(String) }],
      })
    }),
  )

  recorded.effect.with("reconstructs full context after reconnect", { tags: ["reconnect", "full-context"] }, () =>
    Effect.gen(function* () {
      const channel = yield* makeChannel
      const request = LLM.request({
        id: "recorded_openai_responses_websocket_reconnect",
        model,
        system: "Follow the user's exact reply instruction.",
        prompt: "Reply exactly: Alpha.",
        generation: { maxTokens: 30 },
        cache: "none",
      })
      const first = yield* LLMClient.generate(request, { webSocket: channel.executor })
      yield* channel.reconnect()
      const second = yield* LLMClient.generate(
        LLMRequest.update(request, {
          messages: [...request.messages, first.message, Message.user("Reply exactly: Beta.")],
        }),
        { webSocket: channel.executor },
      )

      expect(first.text).toBe("Alpha.")
      expect(second.text).toBe("Beta.")
      expect(channel.opens()).toBe(2)
      expect(channel.sent[1]).not.toHaveProperty("previous_response_id")
      expect(channel.sent[1]).toMatchObject({
        instructions: "Follow the user's exact reply instruction.",
        input: [
          { role: "user", content: [{ type: "input_text", text: "Reply exactly: Alpha." }] },
          { role: "assistant", status: "completed", content: [{ type: "output_text", text: "Alpha." }] },
          { role: "user", content: [{ type: "input_text", text: "Reply exactly: Beta." }] },
        ],
      })
    }),
  )

  recorded.effect.with("recovers from explicit continuation rejection", { tags: ["continuation", "recovery"] }, () =>
    Effect.gen(function* () {
      const channel = yield* makeChannel
      const request = LLM.request({
        id: "recorded_openai_responses_websocket_rejection",
        model,
        system: "Follow the user's exact reply instruction.",
        prompt: "Reply exactly: Ready.",
        generation: { maxTokens: 30 },
        cache: "none",
      })
      const first = yield* LLMClient.generate(request, { webSocket: channel.executor })
      const continuation = LLMRequest.update(request, {
        messages: [...request.messages, first.message, Message.user("Reply exactly: Recovered.")],
      })
      yield* channel.reconnect(true)
      const rejected = yield* LLMClient.generate(continuation, { webSocket: channel.executor }).pipe(Effect.flip)
      const recovered = yield* LLMClient.generate(continuation, { webSocket: channel.executor })

      expect(rejected).toMatchObject({
        reason: { _tag: "Transport", delivery: "rejected", recovery: "retry-full" },
      })
      expect(recovered.text).toBe("Recovered.")
      expect(channel.opens()).toBe(2)
      expect(channel.sent[1]).toHaveProperty("previous_response_id", expect.any(String))
      expect(channel.sent[2]).not.toHaveProperty("previous_response_id")
      expect(channel.sent[2]).toMatchObject({
        instructions: "Follow the user's exact reply instruction.",
        input: [
          { role: "user", content: [{ type: "input_text", text: "Reply exactly: Ready." }] },
          { role: "assistant", status: "completed", content: [{ type: "output_text", text: "Ready." }] },
          { role: "user", content: [{ type: "input_text", text: "Reply exactly: Recovered." }] },
        ],
      })
    }),
  )
})
