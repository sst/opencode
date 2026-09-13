import { Effect, Schema, Stream } from "effect"
import { Headers } from "effect/unstable/http"
import { Framing } from "../route/framing.js"
import type { HttpContext } from "../schema/index.js"
import {
  HttpTransport,
  WebSocketTransport,
  type Transport,
  type WebSocketChannelDriver,
  type WebSocketChannelExchange,
} from "../route/transport/index.js"
import * as ProviderShared from "./shared.js"
import { OpenResponses } from "./open-responses.js"
import { OpenResponsesContinuation } from "./open-responses-continuation.js"

const WebSocketResponseCreate = Schema.StructWithRest(Schema.Struct({ type: Schema.tag("response.create") }), [
  Schema.Record(Schema.String, Schema.Unknown),
])
const decodeMessage = ProviderShared.validateWith(Schema.decodeUnknownEffect(WebSocketResponseCreate))
const encodeMessage = Schema.encodeSync(Schema.fromJsonString(WebSocketResponseCreate))

export interface Options {
  readonly id: string
  readonly name: string
  readonly rotateAfterMs?: number
  readonly enabled?: (url: string) => boolean
  readonly url?: (url: string) => string
  readonly headers?: (headers: Headers.Headers) => Headers.Headers
  readonly continuation?: OpenResponsesContinuation.Shape
}

export interface Prepared {
  readonly http: HttpTransport.HttpPrepared<string>
  readonly channel?: {
    readonly url: string
    readonly headers: Headers.Headers
    readonly rotateAfterMs?: number
    readonly driver: WebSocketChannelDriver
  }
}

const message = (body: unknown) =>
  Effect.gen(function* () {
    if (!ProviderShared.isRecord(body))
      return yield* ProviderShared.invalidRequest("Open Responses WebSocket body must be a JSON object")
    const { stream: _stream, stream_options: _streamOptions, background: _background, ...request } = body
    const decoded = yield* decodeMessage({ ...request, type: "response.create" })
    return { request: decoded, message: encodeMessage(decoded) }
  })

const driver = (options: Options, body: string): WebSocketChannelDriver => {
  let responseID: string | undefined
  let terminal = false
  return {
    create: () =>
      Effect.sync(() => {
        responseID = undefined
        terminal = false
        return { message: body, mode: "full" }
      }),
    observe: (_create, frame) =>
      Effect.gen(function* () {
        const event = yield* OpenResponses.decodeChannelEvent(frame).pipe(
          Effect.mapError((cause) =>
            ProviderShared.eventError(options.id, `Invalid ${options.name} WebSocket event`, frame, cause),
          ),
        )
        if (terminal)
          return yield* ProviderShared.eventError(
            options.id,
            `${options.name} emitted ${event.type} after a terminal event`,
            frame,
          )
        if (event.type === "error") {
          terminal = true
          yield* OpenResponses.decodeKnownErrorEvent(event).pipe(
            Effect.mapError((cause) =>
              ProviderShared.eventError(options.id, `${options.name} returned a malformed error event`, frame, cause),
            ),
          )
          return {
            type: "provider-failure",
            error: OpenResponses.providerFailure(event, `${options.name} stream error`, frame),
          }
        }
        if (event.type === "response.failed") {
          terminal = true
          if (responseID && event.response?.id && event.response.id !== responseID)
            return yield* ProviderShared.eventError(
              options.id,
              `${options.name} response ID changed during execution`,
              frame,
            )
          return {
            type: "provider-failure",
            error: OpenResponses.providerFailure(event, `${options.name} response failed`, frame),
          }
        }
        if (event.type === "response.created") {
          const created = event.response?.id
          if (responseID)
            return yield* ProviderShared.eventError(
              options.id,
              `${options.name} emitted duplicate response.created`,
              frame,
            )
          if (!created)
            return yield* ProviderShared.eventError(
              options.id,
              `${options.name} response.created is missing response.id`,
              frame,
            )
          responseID = created
          return { type: "frame", frame }
        }
        // Keepalives and provider notifications carry no response state and may precede response.created.
        if (!event.type.startsWith("response.")) return { type: "frame", frame }
        if (!responseID)
          return yield* ProviderShared.eventError(
            options.id,
            `${options.name} emitted ${event.type} before response.created`,
            frame,
          )
        if (event.response?.id && event.response.id !== responseID)
          return yield* ProviderShared.eventError(
            options.id,
            `${options.name} response ID changed during execution`,
            frame,
          )
        if (event.type === "response.completed") {
          terminal = true
          return { type: "completed", frame }
        }
        if (event.type === "response.incomplete") {
          terminal = true
          return { type: "incomplete", frame }
        }
        return { type: "frame", frame }
      }),
  }
}

export const transport = <Body>(options: Options): Transport<Body, Prepared, string> => {
  const http = HttpTransport.sseJson.with<Body>()
  return {
    id: http.id,
    prepare: (input) =>
      Effect.gen(function* () {
        const parts = yield* HttpTransport.jsonRequestParts(input)
        const headers = Headers.remove(options.headers?.(parts.headers) ?? parts.headers, "content-length")
        const channel =
          input.webSocket && (options.enabled?.(parts.url) ?? true)
            ? yield* Effect.gen(function* () {
                const create = yield* message(parts.jsonBody)
                const base = driver(options, create.message)
                return {
                  url: yield* WebSocketTransport.toWebSocketUrl(options.url?.(parts.url) ?? parts.url),
                  headers,
                  rotateAfterMs: options.rotateAfterMs,
                  driver: OpenResponsesContinuation.driver({
                    id: options.id,
                    name: options.name,
                    request: create.request,
                    message: create.message,
                    base,
                    continuation: options.continuation,
                  }),
                }
              })
            : undefined
        return {
          http: {
            request: ProviderShared.jsonPost({ url: parts.url, body: parts.bodyText, headers: parts.headers }),
            framing: Framing.sse,
            middleware: input.middleware,
          },
          channel,
        }
      }),
    execute: (prepared, request, runtime, executeOptions) =>
      Effect.gen(function* () {
        if (!executeOptions?.webSocket || !prepared.channel) return yield* http.execute(prepared.http, request, runtime)
        let fallbackHttp: HttpContext | undefined
        const exchange: WebSocketChannelExchange = {
          id: request.id ?? "request",
          connect: {
            url: prepared.channel.url,
            headers: prepared.channel.headers,
            rotateAfterMs: prepared.channel.rotateAfterMs,
          },
          fallback: () =>
            Stream.unwrap(
              http.execute(prepared.http, request, runtime).pipe(
                Effect.map((execution) => {
                  fallbackHttp = execution.http
                  return execution.frames
                }),
              ),
            ),
          driver: prepared.channel.driver,
        }
        const execution = yield* executeOptions.webSocket.execute(exchange)
        return {
          frames: execution.frames,
          complete: execution.complete,
          get http() {
            return fallbackHttp ?? execution.http
          },
        }
      }),
  }
}

export const OpenResponsesChannel = { transport } as const
