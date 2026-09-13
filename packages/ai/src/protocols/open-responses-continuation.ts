import { AIError, TransportError } from "../schema/index.js"
import type { ChannelCheckpoint, ChannelObservation, WebSocketChannelDriver } from "../route/transport/index.js"
import { Effect, Option, Schema } from "effect"
import * as ProviderShared from "./shared.js"
import { OpenResponses } from "./open-responses.js"

const PROTOCOL = "open-responses.websocket.v1"
const VERSION = 1

interface CheckpointValue {
  readonly version: typeof VERSION
  readonly responseID: string
  readonly request: Readonly<Record<string, unknown>>
  readonly output: ReadonlyArray<unknown>
}

/**
 * Fields to send next to `previous_response_id` on an incremental step, or undefined to send the step in full.
 * Whether omitted fields carry over from the continued response is provider behavior the route must know.
 */
export type Shape = (request: Readonly<Record<string, unknown>>) => Readonly<Record<string, unknown>> | undefined

export interface DriverInput {
  readonly id: string
  readonly name: string
  readonly request: Readonly<Record<string, unknown>>
  readonly message: string
  readonly base: WebSocketChannelDriver
  readonly continuation?: Shape
}

const checkpointValue = (checkpoint: ChannelCheckpoint | undefined): CheckpointValue | undefined => {
  if (checkpoint?.protocol !== PROTOCOL || !ProviderShared.isRecord(checkpoint.value)) return undefined
  if (checkpoint.value.version !== VERSION) return undefined
  if (typeof checkpoint.value.responseID !== "string" || checkpoint.value.responseID.trim().length === 0)
    return undefined
  if (!ProviderShared.isRecord(checkpoint.value.request) || !Array.isArray(checkpoint.value.output)) return undefined
  return {
    version: VERSION,
    responseID: checkpoint.value.responseID,
    request: checkpoint.value.request,
    output: checkpoint.value.output,
  }
}

const canonical = (value: unknown): string => {
  if (value === undefined) return "undefined"
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (!ProviderShared.isRecord(value)) return ProviderShared.encodeJson(value)
  return `{${Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort()
    .map((key) => `${ProviderShared.encodeJson(key)}:${canonical(value[key])}`)
    .join(",")}}`
}

const json = (value: unknown) => {
  if (typeof value !== "string") return value
  return Option.getOrElse(Schema.decodeUnknownOption(ProviderShared.Json)(value), () => value)
}

const comparable = (value: unknown) => {
  if (!ProviderShared.isRecord(value)) return value
  if (value.type === "message" && value.role === "assistant")
    return {
      role: "assistant",
      // Annotations and logprobs describe the response, not the text replayed in model input.
      content: Array.isArray(value.content)
        ? value.content.map((part) =>
            ProviderShared.isRecord(part) && part.type === "output_text" ? { type: part.type, text: part.text } : part,
          )
        : value.content,
      ...(value.phase === undefined ? {} : { phase: value.phase }),
    }
  if (value.type === "function_call")
    return {
      type: value.type,
      call_id: value.call_id,
      name: value.name,
      arguments: json(value.arguments),
    }
  if (value.type === "reasoning")
    return {
      type: value.type,
      summary: value.summary,
      encrypted_content: value.encrypted_content,
    }
  return value
}

const invariant = (request: Readonly<Record<string, unknown>>) => {
  const { type: _type, input: _input, previous_response_id: _previousResponseID, ...rest } = request
  return rest
}

const incremental = (
  request: Readonly<Record<string, unknown>>,
  checkpoint: CheckpointValue,
): ReadonlyArray<unknown> | undefined => {
  const input = request.input
  const previousInput = checkpoint.request.input
  if (!Array.isArray(input) || !Array.isArray(previousInput)) return undefined
  if (canonical(invariant(request)) !== canonical(invariant(checkpoint.request))) return undefined
  const baseline = [...previousInput, ...checkpoint.output]
  if (input.length <= baseline.length) return undefined
  if (!baseline.every((item, index) => canonical(comparable(item)) === canonical(comparable(input[index]))))
    return undefined
  return input.slice(baseline.length)
}

const code = (event: OpenResponses.Event) => event.code || event.error?.code || event.response?.error?.code || undefined

const rejected = (
  observation: Extract<ChannelObservation, { readonly type: "provider-failure" }>,
  recovery: "retry-full" | "rotate-and-retry-full",
): ChannelObservation => ({
  type: "rejected",
  recovery,
  error: new AIError({
    reason: new TransportError({
      message: observation.error.message,
      body: observation.error.reason.body,
      http: observation.error.reason.http,
      cause: observation.error.reason.cause,
      transport: "websocket",
      operation: "read",
      phase: "receive",
      delivery: "rejected",
      recovery,
    }),
  }),
})

export const driver = (input: DriverInput): WebSocketChannelDriver => {
  const { previous_response_id: _previousResponseID, ...request } = input.request
  const shape = input.continuation ?? ((fields: Readonly<Record<string, unknown>>) => fields)
  let output: OpenResponses.StreamItem[] = []
  return {
    create: (checkpoint) =>
      Effect.sync(() => {
        output = []
        const previous = checkpointValue(checkpoint)
        // Ask the route first: diffing the whole history is wasted when it declines the continuation.
        const fields = previous ? shape(request) : undefined
        const delta = previous && fields ? incremental(request, previous) : undefined
        if (!previous || !fields || !delta)
          return { message: ProviderShared.encodeJson(request), mode: "full" as const }
        return {
          message: ProviderShared.encodeJson({ ...fields, input: delta, previous_response_id: previous.responseID }),
          mode: "incremental" as const,
        }
      }),
    observe: (create, frame) =>
      Effect.gen(function* () {
        const event = yield* OpenResponses.decodeChannelEvent(frame).pipe(
          Effect.mapError((cause) =>
            ProviderShared.eventError(input.id, `Invalid ${input.name} WebSocket event`, frame, cause),
          ),
        )
        const observation = yield* input.base.observe(create, frame)
        if (event.type === "response.output_item.done" && event.item) output.push(event.item)
        if (observation.type === "provider-failure") {
          const rejection = code(event)
          if (rejection === "previous_response_not_found") return rejected(observation, "retry-full")
          if (rejection === "websocket_connection_limit_reached") return rejected(observation, "rotate-and-retry-full")
          // Only the continuation distinguishes an incremental send from a full one, so an unclassified
          // invalid request there is retried full; Codex reports a stale previous_response_id that way, with
          // no code. Classified failures such as context overflow keep their runner-owned recovery.
          if (
            create.mode === "incremental" &&
            observation.error.reason._tag === "InvalidRequest" &&
            observation.error.reason.classification === undefined
          )
            return rejected(observation, "retry-full")
        }
        if (observation.type !== "completed") return observation
        // A trigger installs a different context window. Clear the append baseline, retaining the socket.
        if (
          Array.isArray(request.input) &&
          request.input.some((item) => ProviderShared.isRecord(item) && item.type === "compaction_trigger")
        )
          return observation
        const responseID = event.response?.id
        if (!responseID || responseID.trim().length === 0) return observation
        return {
          ...observation,
          checkpoint: {
            protocol: PROTOCOL,
            value: {
              version: VERSION,
              responseID,
              request,
              // Completion can re-encrypt reasoning. Callers replay the item already emitted by output_item.done.
              output: event.response?.output?.length
                ? event.response.output.map((item) =>
                    item.type === "reasoning" && item.id !== undefined
                      ? (output.find((done) => done.type === item.type && done.id === item.id) ?? item)
                      : item,
                  )
                : output.slice(),
            } satisfies CheckpointValue,
          },
        }
      }),
  }
}

export * as OpenResponsesContinuation from "./open-responses-continuation.js"
