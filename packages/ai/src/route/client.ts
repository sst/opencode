import { Cause, Context, Effect, Layer, Schema, Stream } from "effect"
import { Auth } from "./auth.js"
import { Endpoint, type EndpointPatch } from "./endpoint.js"
import { RequestExecutor } from "./executor.js"
import { Framing } from "./framing.js"
import { HttpTransport } from "./transport/index.js"
import type { HttpMiddleware, Transport, TransportRuntime, WebSocketChannelExecutor } from "./transport/index.js"
import type { Protocol } from "./protocol.js"
import { applyCachePolicy } from "../cache-policy.js"
import { normalizeToolHistory } from "../tool-history.js"
import { sanitizeSurrogates } from "../utils/sanitize.js"
import * as ProviderShared from "../protocols/shared.js"
import type { ProtocolID, ProviderOptions } from "../schema/index.js"
import {
  AIError,
  CompactionResponse,
  CompactionCheckpointResponse,
  AIErrorReason,
  GenerationOptions,
  HttpOptions,
  LLMRequest,
  LLMResponse,
  LanguageModel,
  LLMEvent,
  InvalidProviderOutputError,
  ProviderConfigurationError,
  ProviderID,
  mergeGenerationOptions,
  mergeHttpOptions,
  mergeProviderOptions,
} from "../schema/index.js"

export interface RouteBody<Body> {
  /** Schema for the validated provider-native body sent as the JSON request. */
  readonly schema: Schema.Codec<Body, unknown>
  /** Build the provider-native body from a common `LLMRequest`. */
  readonly from: (request: LLMRequest) => Effect.Effect<Body, AIError>
}

export interface Route<
  Body,
  Prepared = unknown,
  Compact extends CompactionOperations | undefined = CompactionOperations | undefined,
> {
  readonly compact: Compact
  readonly id: string
  readonly provider?: ProviderID
  /** ProviderMetadata namespace emitted and consumed by this route. */
  readonly providerMetadataKey?: string
  readonly protocol: ProtocolID
  readonly endpoint: Endpoint.Definition<Body>
  readonly auth: Auth.Definition
  /** Deployment headers resolved once for every operation, before transport authentication. */
  readonly headers?: (input: { readonly request: LLMRequest }) => Record<string, string>
  readonly transport: Transport<Body, Prepared, unknown>
  readonly defaults: RouteDefaults
  readonly body: RouteBody<Body>
  readonly with: {
    <Next extends CompactionOperations | undefined>(
      patch: RoutePatch<Body, Prepared> & { readonly compact: Next },
    ): Route<Body, Prepared, Next>
    (
      patch: Omit<RoutePatch<Body, Prepared>, "compact"> & { readonly compact?: undefined },
    ): Route<Body, Prepared, Compact>
    (patch: RoutePatch<Body, Prepared>): Route<Body, Prepared>
  }
  readonly model: <Options extends ProviderOptions = ProviderOptions>(
    input: RouteMappedLanguageModelInput,
  ) => LanguageModel<Options, Compact>
  readonly prepareTransport: (
    body: Body,
    request: LLMRequest,
    options?: StreamOptions,
  ) => Effect.Effect<Prepared, AIError>
  readonly streamPrepared: (
    prepared: Prepared,
    request: LLMRequest,
    runtime: TransportRuntime,
    options?: StreamOptions,
  ) => Stream.Stream<LLMEvent, AIError>
}

// Route registries intentionally erase body generics after construction.
// Normal call sites use `OpenAIChat.route`; callers only need body types
// when preparing a request with a protocol-specific type assertion.
// oxlint-disable-next-line typescript-eslint/no-explicit-any
export type AnyRoute<Compact extends CompactionOperations | undefined = CompactionOperations | undefined> = Route<
  any,
  any,
  Compact
>

export type HttpOptionsInput = HttpOptions.Input

export type RouteLanguageModelInput = Omit<LanguageModel.Input, "provider" | "route">

export type RouteRoutedLanguageModelInput = Omit<LanguageModel.Input, "route">

export interface RouteDefaults {
  readonly headers?: Record<string, string>
  readonly generation?: GenerationOptions
  readonly providerOptions?: ProviderOptions
  readonly http?: HttpOptions
}

export interface RouteDefaultsInput {
  readonly headers?: Record<string, string>
  readonly generation?: GenerationOptions.Input
  readonly providerOptions?: ProviderOptions
  readonly http?: HttpOptions.Input
}

export interface RoutePatch<Body, Prepared> extends RouteDefaultsInput {
  readonly compact?: CompactionOperations
  readonly id?: string
  readonly provider?: string | ProviderID
  readonly providerMetadataKey?: string
  readonly auth?: Auth.Definition
  readonly transport?: Transport<Body, Prepared, unknown>
  readonly endpoint?: EndpointPatch<Body>
}

type RouteMappedLanguageModelInput = RouteLanguageModelInput | RouteRoutedLanguageModelInput

const makeRouteLanguageModel = <Options extends ProviderOptions, Compact extends CompactionOperations | undefined>(
  route: AnyRoute<Compact>,
  mapped: RouteMappedLanguageModelInput,
) => {
  const provider = route.provider ?? ("provider" in mapped ? mapped.provider : undefined)
  if (!provider) throw new Error(`Route.model(${route.id}) requires a provider`)
  if (!endpointBaseURL(route.endpoint))
    throw new ProviderConfigurationError({
      provider: ProviderID.make(provider),
      message: `Route.model(${route.id}) requires an endpoint baseURL — configure it on the route first`,
    })
  return LanguageModel.make<Options, Compact>({
    ...mapped,
    provider,
    route,
  })
}

const mergeRouteDefaults = (base: RouteDefaults | undefined, patch: RouteDefaultsInput): RouteDefaults => {
  const headers = mergeHeaders(base?.headers, patch.headers)
  return {
    ...base,
    ...patch,
    headers,
    generation: mergeGenerationOptions(generationOptions(base?.generation), generationOptions(patch.generation)),
    providerOptions: mergeProviderOptions(base?.providerOptions, patch.providerOptions),
    http: mergeHttpOptions(
      base?.http,
      httpOptions(patch.http),
      headers === undefined ? undefined : new HttpOptions({ headers }),
    ),
  }
}

const endpointBaseURL = <Body>(endpoint: Endpoint.Definition<Body>) =>
  typeof endpoint.baseURL === "string" ? endpoint.baseURL : undefined

const mergeHeaders = (...items: ReadonlyArray<Record<string, string> | undefined>) => {
  const entries = items.flatMap((item) =>
    item === undefined ? [] : Object.entries(item).filter((entry): entry is [string, string] => entry[1] !== undefined),
  )
  if (entries.length === 0) return undefined
  return Object.fromEntries(entries)
}

export const generationOptions = (input: GenerationOptions.Input | undefined) =>
  input === undefined ? undefined : GenerationOptions.make(input)

export const httpOptions = (input: HttpOptionsInput | undefined) => {
  if (input === undefined) return input
  return HttpOptions.make(input)
}

export interface Interface {
  readonly compact: CompactMethod
  readonly stream: StreamMethod
  readonly generate: GenerateMethod
}

export interface StreamOptions {
  readonly http?: HttpMiddleware
  readonly webSocket?: WebSocketChannelExecutor
}

export interface StreamMethod {
  (request: LLMRequest, options?: StreamOptions): Stream.Stream<LLMEvent, AIError>
}

export interface GenerateMethod {
  (request: LLMRequest, options?: StreamOptions): Effect.Effect<LLMResponse, AIError>
}

export type CompactOperation = (
  request: LLMRequest,
  executor: RequestExecutor.Interface,
  options?: Pick<StreamOptions, "http">,
) => Effect.Effect<CompactionResponse, AIError>

export type TriggerCompactOperation = (
  request: LLMRequest,
  executor: RequestExecutor.Interface,
  options: TriggerCompactOptions,
) => Effect.Effect<CompactionCheckpointResponse, AIError>

/** Protocol capabilities, not deployment/model eligibility. */
export interface CompactionOperations {
  readonly endpoint?: CompactOperation
  readonly trigger?: TriggerCompactOperation
}

export interface EndpointCompactOptions extends Pick<StreamOptions, "http"> {
  readonly mechanism?: "endpoint"
  readonly webSocket?: never
}

export interface TriggerCompactOptions extends StreamOptions {
  readonly mechanism: "trigger"
}

// Keep the required route shape explicit: the schema class's self type erases its model parameter in assignability.
export type CompactionRequest = LLMRequest & {
  readonly model: LanguageModel<ProviderOptions, { readonly endpoint: CompactOperation }>
}
export type CheckpointRequest = LLMRequest & {
  readonly model: LanguageModel<ProviderOptions, { readonly trigger: TriggerCompactOperation }>
}

export interface CompactMethod<R = never> {
  (request: CheckpointRequest, options: TriggerCompactOptions): Effect.Effect<CompactionCheckpointResponse, AIError, R>
  (request: CompactionRequest, options?: EndpointCompactOptions): Effect.Effect<CompactionResponse, AIError, R>
}

export function canCompact(
  request: LLMRequest,
  options?: { readonly mechanism?: "endpoint" },
): request is CompactionRequest
export function canCompact(
  request: LLMRequest,
  options: { readonly mechanism: "trigger" },
): request is CheckpointRequest
export function canCompact(request: LLMRequest, options?: { readonly mechanism?: string }) {
  if (options?.mechanism === "trigger") return request.model.route.compact?.trigger !== undefined
  if (options?.mechanism !== undefined && options.mechanism !== "endpoint") return false
  return request.model.route.compact?.endpoint !== undefined
}

const unsupportedCompaction = (request: LLMRequest, mechanism: string | undefined) => {
  if (mechanism !== undefined && mechanism !== "endpoint" && mechanism !== "trigger")
    return ProviderShared.invalidRequest(`Unknown compaction mechanism: ${mechanism}`)
  return ProviderShared.unsupportedOperation({
    operation: mechanism === "trigger" ? "compact.trigger" : "compact",
    provider: request.model.provider,
    route: request.model.route.id,
    message: `${request.model.provider}/${request.model.route.id} does not support ${mechanism === "trigger" ? "trigger" : "explicit"} compaction`,
  })
}

export class Service extends Context.Service<Service, Interface>()("@opencode/LLMClient") {}

const resolveRequestOptions = (request: LLMRequest) => {
  const messages = normalizeToolHistory(request.messages)
  const normalized = messages === request.messages ? request : LLMRequest.update(request, { messages })
  const routeDefaults = normalized.model.route.defaults
  const modelDefaults = normalized.model.defaults
  const generation = mergeGenerationOptions(routeDefaults.generation, modelDefaults?.generation, normalized.generation)
  return LLMRequest.update(normalized, {
    generation: generation ?? new GenerationOptions({}),
    providerOptions: mergeProviderOptions(
      routeDefaults.providerOptions,
      modelDefaults?.providerOptions,
      normalized.providerOptions,
    ),
    http: mergeHttpOptions(routeDefaults.http, modelDefaults?.http, normalized.http),
  })
}

export interface MakeInput<Body, Frame, Event, State> {
  readonly compact?: CompactionOperations
  /** Route id used in diagnostics and prepared request metadata. */
  readonly id: string
  /** Provider identity for route-owned model construction. */
  readonly provider?: string | ProviderID
  /** ProviderMetadata namespace emitted and consumed by this route. */
  readonly providerMetadataKey?: string
  /** Semantic API contract — owns body construction, body schema, and parsing. */
  readonly protocol: Protocol<Body, Frame, Event, State>
  /** Where the request is sent. */
  readonly endpoint: Endpoint.Definition<Body>
  /** Per-request transport auth. Provider facades override this via `route.with(...)`. */
  readonly auth?: Auth.Definition
  /** Stream framing — bytes -> frames before `protocol.stream.event` decoding. */
  readonly framing: Framing.Definition<Frame>
  /** Static / per-request headers added before `auth` runs. */
  readonly headers?: (input: { readonly request: LLMRequest }) => Record<string, string>
  /** Route/request defaults used when compiling requests for this route. */
  readonly defaults?: RouteDefaultsInput
}

export interface MakeTransportInput<Body, Prepared, Frame, Event, State> {
  readonly compact?: CompactionOperations
  /** Route id used in diagnostics and prepared request metadata. */
  readonly id: string
  /** Provider identity for route-owned model construction. */
  readonly provider?: string | ProviderID
  /** ProviderMetadata namespace emitted and consumed by this route. */
  readonly providerMetadataKey?: string
  /** Semantic API contract — owns body construction, body schema, and parsing. */
  readonly protocol: Protocol<Body, Frame, Event, State>
  /** Where the request is sent. */
  readonly endpoint: Endpoint.Definition<Body>
  /** Per-request transport auth. Provider facades override this via `route.with(...)`. */
  readonly auth?: Auth.Definition
  /** Static / per-request headers added before `auth` runs. */
  readonly headers?: (input: { readonly request: LLMRequest }) => Record<string, string>
  /** Runnable transport route. */
  readonly transport: Transport<Body, Prepared, Frame>
  /** Route/request defaults used when compiling requests for this route. */
  readonly defaults?: RouteDefaultsInput
}

const streamError = (route: string, message: string, cause: Cause.Cause<unknown>) => {
  const failed = cause.reasons.find(Cause.isFailReason)?.error
  if (failed instanceof AIError) return failed
  return ProviderShared.eventError(route, message, undefined, cause)
}

const incompleteStreamError = (route: string) =>
  new AIError({
    reason: new InvalidProviderOutputError({
      message: "The provider response ended unexpectedly.",
      classification: "incomplete-stream",
      route,
    }),
  })

const requireTerminalEvent = (route: string) => (events: Stream.Stream<LLMEvent, AIError>) =>
  Stream.suspend(() => {
    let terminal = false
    return events.pipe(
      Stream.mapEffect((event) => {
        if (terminal)
          return Effect.fail(
            ProviderShared.eventError(route, `Provider emitted ${event.type} after the terminal event`),
          )
        if (LLMEvent.is.finish(event) || LLMEvent.is.providerError(event)) terminal = true
        return Effect.succeed(event)
      }),
      Stream.onEnd(Effect.suspend(() => (terminal ? Effect.void : Effect.fail(incompleteStreamError(route))))),
    )
  })

function makeFromTransport<Body, Prepared, Frame, Event, State>(
  input: MakeTransportInput<Body, Prepared, Frame, Event, State>,
): Route<Body, Prepared> {
  const protocol = input.protocol
  const encodeBody = Schema.encodeSync(Schema.fromJsonString(protocol.body.schema))
  const decodeEventEffect = Schema.decodeUnknownEffect(protocol.stream.event)
  const decodeEvent = (route: string) => (frame: Frame) =>
    decodeEventEffect(frame).pipe(
      Effect.mapError((cause) =>
        ProviderShared.eventError(
          input.id,
          `Invalid ${route} stream event`,
          typeof frame === "string" ? frame : ProviderShared.encodeJson(frame),
          cause,
        ),
      ),
    )

  type BuiltRouteInput = Omit<MakeTransportInput<Body, Prepared, Frame, Event, State>, "defaults"> & {
    readonly defaults?: RouteDefaults
  }

  const build = (routeInput: BuiltRouteInput): Route<Body, Prepared> => {
    const route: Route<Body, Prepared> = {
      compact: routeInput.compact,
      id: routeInput.id,
      provider: routeInput.provider === undefined ? undefined : ProviderID.make(routeInput.provider),
      providerMetadataKey: routeInput.providerMetadataKey,
      protocol: protocol.id,
      endpoint: routeInput.endpoint,
      auth: routeInput.auth ?? Auth.none,
      headers: routeInput.headers,
      transport: routeInput.transport,
      defaults: routeInput.defaults ?? {},
      body: protocol.body,
      with: (patch: RoutePatch<Body, Prepared>) => {
        const { compact, id, provider, providerMetadataKey, auth, transport, endpoint, ...defaults } = patch
        return build({
          ...routeInput,
          compact: "compact" in patch ? compact : routeInput.compact,
          id: id ?? routeInput.id,
          provider: provider ?? routeInput.provider,
          providerMetadataKey:
            providerMetadataKey ??
            (provider !== undefined && String(provider) !== String(routeInput.provider)
              ? String(provider)
              : routeInput.providerMetadataKey),
          auth: auth ?? routeInput.auth,
          endpoint: endpoint ? Endpoint.merge(routeInput.endpoint, endpoint) : routeInput.endpoint,
          transport: (transport as Transport<Body, Prepared, Frame> | undefined) ?? routeInput.transport,
          defaults: mergeRouteDefaults(route.defaults, defaults),
        })
      },
      model: <Options extends ProviderOptions = ProviderOptions>(input: RouteMappedLanguageModelInput) =>
        makeRouteLanguageModel<Options, CompactionOperations | undefined>(route, input),
      prepareTransport: (body, request, options) =>
        routeInput.transport.prepare({
          body,
          request,
          endpoint: routeInput.endpoint,
          auth: routeInput.auth ?? Auth.none,
          encodeBody,
          middleware: options?.http,
          webSocket: options?.webSocket,
        }),
      streamPrepared: (prepared: Prepared, request: LLMRequest, runtime: TransportRuntime, options?: StreamOptions) => {
        const route = `${request.model.provider}/${request.model.route.id}`
        return Stream.unwrap(
          routeInput.transport.execute(prepared, request, runtime, options).pipe(
            Effect.map((execution) => {
              const terminal = protocol.stream.terminal
              // Preserve assembled inputs; replace only serialized event fallbacks with their original wire data.
              const frameError =
                (frame: Frame, event: Frame | Event = frame) =>
                (error: AIError) =>
                  new AIError({
                    reason: AIErrorReason.make({
                      ...error.reason,
                      message: error.reason.message,
                      cause: error.reason.cause,
                      body:
                        error.reason.body !== undefined && error.reason.body !== ProviderShared.encodeJson(event)
                          ? error.reason.body
                          : (execution.body?.(frame) ??
                            (typeof frame === "string" ? frame : ProviderShared.encodeJson(frame))),
                    }),
                  })
              const events = execution.frames.pipe(
                Stream.mapEffect((frame) =>
                  decodeEvent(route)(frame).pipe(
                    Effect.catchCause((cause) =>
                      Effect.fail(streamError(route, `Failed to decode ${route} event`, cause)),
                    ),
                    Effect.map((event) => ({ event, frame })),
                    Effect.mapError(frameError(frame)),
                  ),
                ),
                terminal ? Stream.takeUntil(({ event }) => terminal(event)) : (stream) => stream,
              )
              const stream = Stream.suspend(() => {
                let state = protocol.stream.initial(request)
                const parsed = events.pipe(
                  Stream.mapEffect(({ event, frame }) =>
                    protocol.stream.step(state, event).pipe(
                      Effect.catchCause((cause) =>
                        Effect.fail(streamError(route, `Failed to parse ${route} event`, cause)),
                      ),
                      Effect.map(([next, output]) => {
                        state = next
                        return output
                      }),
                      Effect.mapError(frameError(frame, event)),
                    ),
                  ),
                  Stream.flatMap(Stream.fromIterable),
                )
                const onHalt = protocol.stream.onHalt
                return onHalt
                  ? parsed.pipe(
                      Stream.concat(
                        Stream.suspend(() => Stream.unwrap(onHalt(state).pipe(Effect.map(Stream.fromIterable)))),
                      ),
                    )
                  : parsed
              }).pipe(
                Stream.catchCause((cause) => Stream.fail(streamError(route, `Failed to read ${route} stream`, cause))),
                requireTerminalEvent(route),
                Stream.mapError(
                  (error) =>
                    new AIError({
                      reason: AIErrorReason.make({
                        ...error.reason,
                        message: error.reason.message,
                        cause: error.reason.cause,
                        http: error.reason.http ?? execution.http,
                      }),
                    }),
                ),
              )
              return execution.complete ? stream.pipe(Stream.onEnd(execution.complete)) : stream
            }),
          ),
        )
      },
    } satisfies Route<Body, Prepared>
    return route
  }

  return build({ ...input, defaults: mergeRouteDefaults(undefined, input.defaults ?? {}) })
}

export function make<Body, Prepared, Frame, Event, State, Compact extends CompactionOperations>(
  input: MakeTransportInput<Body, Prepared, Frame, Event, State> & { readonly compact: Compact },
): Route<Body, Prepared, Compact>
export function make<Body, Frame, Event, State, Compact extends CompactionOperations>(
  input: MakeInput<Body, Frame, Event, State> & { readonly compact: Compact },
): Route<Body, HttpTransport.HttpPrepared<Frame>, Compact>
export function make<Body, Prepared, Frame, Event, State>(
  input: MakeTransportInput<Body, Prepared, Frame, Event, State>,
): Route<Body, Prepared>
/**
 * Build a `Route` by composing the four orthogonal pieces of a deployment:
 *
 * - `Protocol` — what is the API I'm speaking?
 * - `Endpoint` — where do I send the request?
 * - `Auth` — how do I authenticate it?
 * - `Framing` — how do I cut the response stream into protocol frames?
 *
 * Plus optional `headers` for cross-cutting deployment concerns (provider
 * version pins, per-deployment quirks).
 *
 * This is the canonical route constructor. If a new route does not fit
 * this four-axis model, add a purpose-built constructor rather than widening
 * the public surface preemptively.
 */
export function make<Body, Frame, Event, State>(
  input: MakeInput<Body, Frame, Event, State>,
): Route<Body, HttpTransport.HttpPrepared<Frame>>
export function make<Body, Prepared, Frame, Event, State>(
  input: MakeInput<Body, Frame, Event, State> | MakeTransportInput<Body, Prepared, Frame, Event, State>,
): Route<Body, Prepared> | Route<Body, HttpTransport.HttpPrepared<Frame>> {
  if ("transport" in input) return makeFromTransport(input)
  const protocol = input.protocol
  return makeFromTransport({
    compact: input.compact,
    id: input.id,
    provider: input.provider,
    providerMetadataKey: input.providerMetadataKey,
    protocol,
    endpoint: input.endpoint,
    auth: input.auth,
    headers: input.headers,
    transport: HttpTransport.httpJson({ framing: input.framing }),
    defaults: input.defaults,
  })
}

const prepareRequest = (request: LLMRequest) => {
  const original = resolveRequestOptions(request)
  const sanitized = LLMRequest.update(original, sanitizeSurrogates({ ...LLMRequest.input(original), model: undefined }))
  // Deduplicate per sibling level; a tool and a namespace may share a name.
  const dedupe = (tools: LLMRequest["tools"]): LLMRequest["tools"] =>
    [...new Map(tools.map((tool) => [`${tool.type}:${tool.name}`, tool])).values()].map((tool) =>
      tool.type === "tool" ? tool : { ...tool, tools: dedupe(tool.tools) },
    )
  const resolved = applyCachePolicy(LLMRequest.update(sanitized, { tools: dedupe(sanitized.tools) }))
  const headers = resolved.model.route.headers?.({ request: resolved })
  return headers === undefined
    ? resolved
    : LLMRequest.update(resolved, { http: mergeHttpOptions(new HttpOptions({ headers }), resolved.http) })
}

const compile = Effect.fn("LLM.compile")(function* (request: LLMRequest, options?: StreamOptions) {
  const resolved = prepareRequest(request)
  const route = resolved.model.route

  const body = yield* route.body
    .from(resolved)
    .pipe(Effect.flatMap(ProviderShared.validateWith(Schema.decodeUnknownEffect(route.body.schema))))
  const prepared = yield* route.prepareTransport(body, resolved, options)

  return {
    request: resolved,
    route,
    body,
    prepared,
  }
})

/** @internal Test-only projection of the execution compiler; not exported from package barrels. */
export const compileRequest = Effect.fn("LLM.compileRequest")(function* (request: LLMRequest) {
  const compiled = yield* compile(request)
  return {
    id: compiled.request.id ?? "request",
    route: compiled.route.id,
    protocol: compiled.route.protocol,
    model: compiled.request.model,
    body: compiled.body,
    metadata: { transport: compiled.route.transport.id },
  }
})

const streamRequestWith = (runtime: TransportRuntime) => (request: LLMRequest, options?: StreamOptions) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const compiled = yield* compile(request, options)
      return compiled.route.streamPrepared(compiled.prepared, compiled.request, runtime, options)
    }),
  )

const generateWith = (stream: Interface["stream"]) =>
  Effect.fn("LLM.generate")(function* (request: LLMRequest, options?: StreamOptions) {
    const state = yield* stream(request, options).pipe(Stream.runFold(LLMResponse.empty, LLMResponse.reduce))
    const response = LLMResponse.complete(state)
    if (response) return response
    return yield* incompleteStreamError(`${request.model.provider}/${request.model.route.id}`)
  })

export function stream(request: LLMRequest, options?: StreamOptions): Stream.Stream<LLMEvent, AIError, Service> {
  return Stream.unwrap(
    Effect.gen(function* () {
      return (yield* Service).stream(request, options)
    }),
  )
}

export function generate(request: LLMRequest, options?: StreamOptions): Effect.Effect<LLMResponse, AIError, Service> {
  return Effect.gen(function* () {
    return yield* (yield* Service).generate(request, options)
  })
}

export function compact(
  request: CheckpointRequest,
  options: TriggerCompactOptions,
): Effect.Effect<CompactionCheckpointResponse, AIError, Service>
export function compact(
  request: CompactionRequest,
  options?: EndpointCompactOptions,
): Effect.Effect<CompactionResponse, AIError, Service>
export function compact(request: LLMRequest, options?: EndpointCompactOptions | TriggerCompactOptions) {
  return Effect.gen(function* () {
    const client = yield* Service
    if (options?.mechanism === "trigger" && canCompact(request, options)) return yield* client.compact(request, options)
    if ((options?.mechanism === undefined || options.mechanism === "endpoint") && canCompact(request))
      return yield* client.compact(request, options)
    return yield* unsupportedCompaction(request, options?.mechanism)
  })
}

export const streamRequest = (request: LLMRequest, options?: StreamOptions) =>
  Stream.unwrap(
    Effect.gen(function* () {
      return (yield* Service).stream(request, options)
    }),
  )

export const layer: Layer.Layer<Service, never, RequestExecutor.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const executor = yield* RequestExecutor.Service
    const stream = streamRequestWith({ http: executor })
    function compact(
      request: CompactionRequest,
      options?: EndpointCompactOptions,
    ): Effect.Effect<CompactionResponse, AIError>
    function compact(
      request: CheckpointRequest,
      options: TriggerCompactOptions,
    ): Effect.Effect<CompactionCheckpointResponse, AIError>
    function compact(request: LLMRequest, options?: EndpointCompactOptions | TriggerCompactOptions) {
      return Effect.suspend((): Effect.Effect<CompactionResponse | CompactionCheckpointResponse, AIError> => {
        if (options?.mechanism === "trigger" && canCompact(request, options))
          return request.model.route.compact.trigger(prepareRequest(request), executor, options)
        if ((options?.mechanism === undefined || options.mechanism === "endpoint") && canCompact(request))
          return request.model.route.compact.endpoint(prepareRequest(request), executor, options)
        return unsupportedCompaction(request, options?.mechanism)
      })
    }
    return Service.of({
      stream,
      generate: generateWith(stream),
      compact,
    })
  }),
)

export const Route = { make } as const

export const LLMClient = {
  canCompact,
  compact,
  Service,
  layer,
  stream,
  generate,
} as const
