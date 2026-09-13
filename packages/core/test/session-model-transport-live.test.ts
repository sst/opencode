import { describe, expect, test } from "bun:test"
import { AIError, LLM, Message } from "@opencode/ai"
import {
  LLMClient,
  RequestExecutor,
  WebSocketTransport,
  type ChannelObservation,
  type WebSocketChannelExchange,
} from "@opencode/ai/route"
import { configure } from "@opencode/ai/providers/openai"
import { SessionModelTransport } from "@opencode/core/session/model-transport"
import { WebSocketConstructor } from "@opencode/core/effect/websocket-constructor"
import { Session } from "@opencode/schema/session"
import { Effect, Fiber, Layer, Stream } from "effect"
import { Headers } from "effect/unstable/http"
import { Socket } from "effect/unstable/socket"
import { makeWebSocketServer, type WebSocketServerFixture, type WebSocketServerOptions } from "./lib/websocket-server"

const sessionID = Session.ID.make("ses_live_websocket")

const exchange = (server: WebSocketServerFixture, id: string): WebSocketChannelExchange => ({
  id,
  connect: {
    url: server.url,
    headers: Headers.fromInput({ authorization: "Bearer local-secret", "x-handshake": "visible" }),
  },
  fallback: () => Stream.die("Unexpected HTTP fallback"),
  driver: {
    create: () => Effect.succeed({ message: id, mode: "full" }),
    observe: (_create, frame): Effect.Effect<ChannelObservation, AIError> =>
      Effect.succeed({ type: "completed", frame }),
  },
})

const withServer = <A>(
  options: WebSocketServerOptions,
  effect: (server: WebSocketServerFixture) => Effect.Effect<A, unknown, SessionModelTransport.Service>,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const constructor = yield* Socket.WebSocketConstructor
      const server = yield* makeWebSocketServer(options)
      return yield* effect(server).pipe(
        Effect.provide(
          SessionModelTransport.makeLayer({
            open: (input) =>
              WebSocketTransport.open(input).pipe(Effect.provideService(Socket.WebSocketConstructor, constructor)),
          }),
        ),
      )
    }).pipe(Effect.scoped, Effect.provide(WebSocketConstructor.layer)),
  )

const collect = (transport: SessionModelTransport.Interface, item: WebSocketChannelExchange) =>
  Effect.gen(function* () {
    const execution = yield* transport.bind(sessionID).execute(item)
    return Array.from(yield* Stream.runCollect(execution.frames.pipe(Stream.onEnd(execution.complete))))
  }).pipe(Effect.scoped)

const waitFor = (predicate: () => boolean, remaining = 100): Effect.Effect<void> => {
  if (predicate()) return Effect.void
  if (remaining === 0) return Effect.die("Timed out waiting for local WebSocket server")
  return Effect.sleep("5 millis").pipe(Effect.andThen(Effect.suspend(() => waitFor(predicate, remaining - 1))))
}

describe("SessionModelTransport local WebSocket server", () => {
  test("continues a real Responses connection with only the appended input", async () => {
    const requests: Array<Record<string, unknown>> = []
    await withServer(
      {
        message: (socket, message) => {
          const request = JSON.parse(message.toString())
          requests.push(request)
          const index = requests.length
          const id = `msg_${index}`
          const text = index === 1 ? "Hello" : "Brief"
          const reasoning = { type: "reasoning", id: `rs_${index}`, summary: [], encrypted_content: "stream-encrypted" }
          const item = {
            type: "message",
            id,
            status: "completed",
            role: "assistant",
            content: [{ type: "output_text", text, annotations: [], logprobs: [] }],
          }
          socket.send(JSON.stringify({ type: "response.created", response: { id: `resp_${index}` } }))
          socket.send(JSON.stringify({ type: "response.output_item.done", item: reasoning }))
          socket.send(JSON.stringify({ type: "response.output_item.added", item: { type: "message", id } }))
          socket.send(JSON.stringify({ type: "response.output_text.delta", item_id: id, delta: text }))
          socket.send(JSON.stringify({ type: "response.output_text.done", item_id: id, text }))
          socket.send(
            JSON.stringify({
              type: "response.output_item.done",
              item,
            }),
          )
          socket.send(
            JSON.stringify({
              type: "response.completed",
              response: {
                id: `resp_${index}`,
                output: [{ ...reasoning, encrypted_content: "terminal-encrypted" }, item],
              },
            }),
          )
        },
      },
      (server) =>
        Effect.gen(function* () {
          const transport = yield* SessionModelTransport.Service
          const executor = transport.bind(sessionID)
          const model = configure({
            baseURL: server.url.replace(/^ws/, "http").replace(/responses$/, ""),
            apiKey: "local",
          }).responses("gpt-5.2")
          const client = LLMClient.Service
          const layer = LLMClient.layer.pipe(
            Layer.provide(
              Layer.succeed(
                RequestExecutor.Service,
                RequestExecutor.Service.of({ execute: () => Effect.die("Unexpected HTTP request") }),
              ),
            ),
          )

          const first = yield* client
            .use((llm) => llm.generate(LLM.request({ model, prompt: "First" }), { webSocket: executor }))
            .pipe(Effect.provide(layer))
          const second = yield* client
            .use((llm) =>
              llm.generate(
                LLM.request({
                  model,
                  messages: [Message.user("First"), first.message, Message.user("Be brief")],
                }),
                { webSocket: executor },
              ),
            )
            .pipe(Effect.provide(layer))

          expect(first.text).toBe("Hello")
          expect(second.text).toBe("Brief")
          expect(server.state.opens).toBe(1)
          expect(requests[1]).toMatchObject({
            previous_response_id: "resp_1",
            input: [{ role: "user", content: [{ type: "input_text", text: "Be brief" }] }],
          })
        }),
    )
  })

  test("clears a rejected continuation and keeps one provider request per attempt", async () => {
    const requests: Array<Record<string, unknown>> = []
    await withServer(
      {
        message: (socket, message) => {
          requests.push(JSON.parse(message.toString()))
          const index = requests.length
          if (index === 2) {
            socket.send(
              JSON.stringify({
                type: "error",
                error: { code: "previous_response_not_found", message: "Missing response" },
              }),
            )
            return
          }
          const id = `msg_${index}`
          const text = index === 1 ? "Hello" : "Recovered"
          socket.send(JSON.stringify({ type: "response.created", response: { id: `resp_${index}` } }))
          socket.send(JSON.stringify({ type: "response.output_item.added", item: { type: "message", id } }))
          socket.send(JSON.stringify({ type: "response.output_text.delta", item_id: id, delta: text }))
          socket.send(JSON.stringify({ type: "response.output_text.done", item_id: id, text }))
          socket.send(
            JSON.stringify({
              type: "response.output_item.done",
              item: {
                type: "message",
                id,
                role: "assistant",
                content: [{ type: "output_text", text }],
              },
            }),
          )
          socket.send(JSON.stringify({ type: "response.completed", response: { id: `resp_${index}` } }))
        },
      },
      (server) =>
        Effect.gen(function* () {
          const transport = yield* SessionModelTransport.Service
          const executor = transport.bind(sessionID)
          const model = configure({
            baseURL: server.url.replace(/^ws/, "http").replace(/responses$/, ""),
            apiKey: "local",
          }).responses("gpt-5.2")
          const layer = LLMClient.layer.pipe(
            Layer.provide(
              Layer.succeed(
                RequestExecutor.Service,
                RequestExecutor.Service.of({ execute: () => Effect.die("Unexpected HTTP request") }),
              ),
            ),
          )
          const request = LLM.request({
            model,
            messages: [Message.user("First"), Message.assistant("Hello"), Message.user("Continue")],
          })

          yield* LLMClient.Service.use((llm) =>
            llm.generate(LLM.request({ model, prompt: "First" }), { webSocket: executor }),
          ).pipe(Effect.provide(layer))
          const rejected = yield* LLMClient.Service.use((llm) => llm.generate(request, { webSocket: executor })).pipe(
            Effect.provide(layer),
            Effect.flip,
          )
          const recovered = yield* LLMClient.Service.use((llm) => llm.generate(request, { webSocket: executor })).pipe(
            Effect.provide(layer),
          )

          expect(rejected.reason).toMatchObject({
            _tag: "Transport",
            delivery: "rejected",
            recovery: "retry-full",
          })
          expect(recovered.text).toBe("Recovered")
          expect(requests).toHaveLength(3)
          expect(requests[1]).toHaveProperty("previous_response_id", "resp_1")
          expect(requests[2]).not.toHaveProperty("previous_response_id")
          expect(server.state.opens).toBe(2)
        }),
    )
  })

  // The browser-compatible client surface cannot originate ping frames, so the server sends one and verifies pong.
  test("reuses one real connection with handshake headers and ping/pong", async () => {
    await withServer(
      {
        open: (socket) => socket.ping("health"),
        message: (socket, message) => socket.send(`completed:${message.toString()}`),
      },
      (server) =>
        Effect.gen(function* () {
          const transport = yield* SessionModelTransport.Service

          expect(yield* collect(transport, exchange(server, "first"))).toEqual(["completed:first"])
          expect(yield* collect(transport, exchange(server, "second"))).toEqual(["completed:second"])
          yield* waitFor(() => server.state.pongs === 1)

          expect(server.state.opens).toBe(1)
          expect(server.state.messages).toEqual(["first", "second"])
          expect(server.state.headers[0]).toMatchObject({
            authorization: "Bearer local-secret",
            "x-handshake": "visible",
          })
        }),
    )
  })

  test("closes a real active connection on cancellation", async () => {
    await withServer({ message: () => {} }, (server) =>
      Effect.gen(function* () {
        const transport = yield* SessionModelTransport.Service
        const running = yield* collect(transport, exchange(server, "blocked")).pipe(
          Effect.forkChild({ startImmediately: true }),
        )
        yield* waitFor(() => server.state.messages.length === 1)

        yield* Fiber.interrupt(running)
        yield* waitFor(() => server.state.closes === 1)

        expect(server.state.messages).toEqual(["blocked"])
      }),
    )
  })

  test("poisons a real connection after an unsupported binary frame", async () => {
    await withServer({ message: (socket) => socket.sendBinary(new Uint8Array([1, 2, 3])) }, (server) =>
      Effect.gen(function* () {
        const transport = yield* SessionModelTransport.Service

        const result = yield* Effect.result(collect(transport, exchange(server, "binary")))
        yield* waitFor(() => server.state.closes === 1)

        expect(result).toMatchObject({
          _tag: "Failure",
          failure: { reason: { _tag: "Transport", code: "message", delivery: "accepted" } },
        })
      }),
    )
  })

  test("closes a real connection after an oversized frame", async () => {
    await withServer({ message: (socket) => socket.send("x".repeat(16 * 1024 * 1024 + 1)) }, (server) =>
      Effect.gen(function* () {
        const transport = yield* SessionModelTransport.Service

        const result = yield* Effect.result(collect(transport, exchange(server, "oversized")))
        yield* waitFor(() => server.state.closes === 1)

        expect(result).toMatchObject({
          _tag: "Failure",
          failure: { reason: { _tag: "Transport", code: "message-too-large", delivery: "ambiguous" } },
        })
      }),
    )
  })

  // Effect's browser-compatible constructor does not expose upgrade response bodies or headers.
  // The real 426 fixture therefore pins the observable contract: a not-sent connect failure and one HTTP fallback.
  test("falls back once after a real rejected upgrade", async () => {
    let fallbacks = 0
    await withServer({ upgrade: () => false }, (server) =>
      Effect.gen(function* () {
        const transport = yield* SessionModelTransport.Service
        const item = exchange(server, "fallback")
        const result = yield* collect(transport, {
          ...item,
          fallback: () => {
            fallbacks++
            return Stream.make("http")
          },
        })

        expect(result).toEqual(["http"])
        expect(fallbacks).toBe(1)
        expect(server.state.opens).toBe(0)
      }),
    )
  })
})
