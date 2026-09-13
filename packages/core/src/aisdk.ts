export * as AISDK from "./aisdk.js"

import { makeLocationNode } from "@opencode/util/effect/app-node"
import { APICallError } from "@ai-sdk/provider"
import type {
  JSONSchema7,
  JSONValue,
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3FinishReason,
  LanguageModelV3FunctionTool,
  LanguageModelV3Message,
  LanguageModelV3Prompt,
  LanguageModelV3StreamPart,
  LanguageModelV3ToolChoice,
  SharedV3ProviderOptions,
} from "@ai-sdk/provider"
import {
  FinishReason,
  LLMEvent,
  AIError,
  LanguageModel,
  ProviderID,
  ProviderMetadata,
  TransportError,
  ToolResultValue,
  type ContentPart,
  type LLMRequest,
  type ToolDefinition,
  type UsageInput,
} from "@opencode/ai"
import { classifyProviderFailure } from "@opencode/ai/provider-error"
import { Auth, Endpoint, RequestExecutor, type AnyRoute } from "@opencode/ai/route"
import { ProviderShared } from "@opencode/ai/protocols/shared"
import { Cause, Context, Effect, Layer, Option, Schema, Scope, Stream } from "effect"
import { makeParser } from "effect/unstable/encoding/Sse"
import type { ID, Info } from "./model.js"
import { Provider } from "./provider.js"
import { State } from "./state.js"

type SDK = any
type UserContent = Extract<LanguageModelV3Message, { role: "user" }>["content"]
type AssistantContent = Extract<LanguageModelV3Message, { role: "assistant" }>["content"]
type ToolResultContent = Extract<AssistantContent[number], { type: "tool-result" }>

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))

export interface SDKEvent {
  readonly model: Info
  readonly package: string
  readonly options: Record<string, any>
  sdk?: SDK
}

export interface LanguageEvent {
  readonly model: Info
  readonly sdk: SDK
  readonly options: Record<string, any>
  language?: LanguageModelV3
}

function wrapSSE(res: Response, ms: number, ctl: AbortController) {
  if (typeof ms !== "number" || ms <= 0) return res
  if (!res.body) return res
  if (!res.headers.get("content-type")?.includes("text/event-stream")) return res

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let deadline: number | undefined
  const parser = makeParser((event) => {
    if (event._tag === "Event") deadline = Date.now() + ms
  })
  const body = new ReadableStream<Uint8Array>({
    async pull(ctrl) {
      const expires = deadline ?? Date.now() + ms
      deadline = expires
      const part = await new Promise<Awaited<ReturnType<typeof reader.read>>>((resolve, reject) => {
        const remaining = Math.max(0, expires - Date.now())
        const id = setTimeout(() => {
          const err = new Error("SSE read timed out")
          ctl.abort(err)
          void reader.cancel(err)
          reject(err)
        }, remaining)

        reader.read().then(
          (part) => {
            clearTimeout(id)
            resolve(part)
          },
          (err) => {
            clearTimeout(id)
            reject(err)
          },
        )
      })

      if (part.done) {
        ctrl.close()
        return
      }

      parser.feed(decoder.decode(part.value, { stream: true }))
      ctrl.enqueue(part.value)
    },
    async cancel(reason) {
      ctl.abort(reason)
      await reader.cancel(reason)
    },
  })

  return new Response(body, {
    headers: new Headers(res.headers),
    status: res.status,
    statusText: res.statusText,
  })
}

function prepareOptions(model: Info, pkg: string) {
  const projected = mapBodyToProviderOptions(model, pkg)
  const options: Record<string, any> = {
    name: model.canonical ?? model.providerID,
    ...(model.settings ?? {}),
    headers: model.headers,
    body: projected.body,
  }

  const customFetch = options.fetch
  const chunkTimeout = options.chunkTimeout
  delete options.chunkTimeout
  options.fetch = async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const opts = { ...(init ?? {}) }
    const signals = [
      opts.signal,
      typeof chunkTimeout === "number" && chunkTimeout > 0 ? new AbortController() : undefined,
      options.timeout !== undefined && options.timeout !== null && options.timeout !== false
        ? AbortSignal.timeout(options.timeout)
        : undefined,
    ].filter((item): item is AbortSignal | AbortController => item !== undefined && item !== null)
    const chunkAbortCtl = signals.find((item): item is AbortController => item instanceof AbortController)
    const abortSignals = signals.map((item) => (item instanceof AbortController ? item.signal : item))
    if (abortSignals.length === 1) opts.signal = abortSignals[0]
    if (abortSignals.length > 1) opts.signal = AbortSignal.any(abortSignals)

    if (typeof opts.body === "string" && model.body !== undefined) {
      const decoded = Option.getOrUndefined(decodeJson(opts.body))
      if (Schema.is(Schema.Record(Schema.String, Schema.Json))(decoded)) {
        opts.body = JSON.stringify(Provider.mergeOverlay(decoded, model.body))
      }
    }

    const res = await (typeof customFetch === "function" ? customFetch : fetch)(input, {
      ...opts,
      timeout: false,
    })
    if (!chunkAbortCtl || typeof chunkTimeout !== "number") return res
    return wrapSSE(res, chunkTimeout, chunkAbortCtl)
  }

  return options
}

export class InitError extends Schema.TaggedError<InitError>()("AISDK.InitError", {
  providerID: Provider.ID,
  cause: Schema.Defect(),
}) {}

function initError(providerID: Provider.ID) {
  return Effect.catchCause((cause) => Effect.fail(new InitError({ providerID, cause: Cause.squash(cause) })))
}

export interface Interface {
  readonly hook: {
    readonly sdk: (
      callback: (event: SDKEvent) => Effect.Effect<void> | void,
    ) => Effect.Effect<State.Registration, never, Scope.Scope>
    readonly language: (
      callback: (event: LanguageEvent) => Effect.Effect<void> | void,
    ) => Effect.Effect<State.Registration, never, Scope.Scope>
  }
  readonly runSDK: (event: SDKEvent) => Effect.Effect<SDKEvent>
  readonly runLanguage: (event: LanguageEvent) => Effect.Effect<LanguageEvent>
  readonly language: (model: Info) => Effect.Effect<LanguageModelV3, InitError>
  readonly model: (model: Info) => Effect.Effect<LanguageModel, InitError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/AISDK") {}

export const locationLayer = Layer.effect(
  Service,
  Effect.gen(function* () {
    let sdkHooks: ((event: SDKEvent) => Effect.Effect<void> | void)[] = []
    let languageHooks: ((event: LanguageEvent) => Effect.Effect<void> | void)[] = []
    const languages = new Map<string, LanguageModelV3>()
    const sdks = new Map<string, SDK>()
    const functionIDs = new WeakMap<object, number>()
    let nextFunctionID = 0
    const cacheKey = (input: unknown) =>
      JSON.stringify(input, (_key, value: unknown) => {
        if (typeof value !== "function") return value
        const existing = functionIDs.get(value)
        if (existing !== undefined) return `function:${existing}`
        const id = nextFunctionID++
        functionIDs.set(value, id)
        return `function:${id}`
      }) ?? ""

    const register = <Event>(
      hooks: () => ((event: Event) => Effect.Effect<void> | void)[],
      update: (hooks: ((event: Event) => Effect.Effect<void> | void)[]) => void,
    ) =>
      Effect.fn("AISDK.hook")(function* (callback: (event: Event) => Effect.Effect<void> | void) {
        const scope = yield* Scope.Scope
        let active = true
        update([...hooks(), callback])
        const dispose = Effect.sync(() => {
          if (!active) return
          active = false
          update(hooks().filter((item) => item !== callback))
        })
        yield* Scope.addFinalizer(scope, dispose)
        return { dispose }
      })

    const run = Effect.fnUntraced(function* <Event>(
      hooks: readonly ((event: Event) => Effect.Effect<void> | void)[],
      event: Event,
    ) {
      for (const hook of hooks) {
        const result = hook(event)
        if (Effect.isEffect(result)) yield* result
      }
      return event
    })

    const service = Service.of({
      hook: {
        sdk: register(
          () => sdkHooks,
          (next) => (sdkHooks = next),
        ),
        language: register(
          () => languageHooks,
          (next) => (languageHooks = next),
        ),
      },
      runSDK: (event) => run(sdkHooks, event),
      runLanguage: (event) => run(languageHooks, event),
      language: Effect.fn("AISDK.language")(function* (model) {
        const key = cacheKey({
          providerID: model.providerID,
          canonical: model.canonical,
          id: model.id,
          modelID: model.modelID,
          package: model.package,
          settings: model.settings,
          headers: model.headers,
          body: model.body,
          limit: model.limit,
        })
        const existing = languages.get(key)
        if (existing) return existing
        if (!Provider.isAISDK(model.package))
          return yield* new InitError({
            providerID: model.providerID,
            cause: new Error(`Unsupported package ${model.package}`),
          })

        const packageName = Provider.packageName(model.package)
        const options = prepareOptions(model, packageName)
        const sdkKey = cacheKey({
          providerID: model.providerID,
          canonical: model.canonical,
          package: packageName,
          settings: model.settings,
          headers: model.headers,
          body: model.body,
        })
        const sdk =
          sdks.get(sdkKey) ??
          (yield* service.runSDK({ model, package: packageName, options }).pipe(initError(model.providerID))).sdk
        if (!sdk)
          return yield* new InitError({
            providerID: model.providerID,
            cause: new Error("No AISDK provider plugin returned an SDK"),
          })
        sdks.set(sdkKey, sdk)
        const result = yield* service.runLanguage({ model, sdk, options }).pipe(initError(model.providerID))
        const language = yield* Effect.sync(() => result.language ?? sdk.languageModel(model.modelID ?? model.id)).pipe(
          initError(model.providerID),
        )
        languages.set(key, language)
        return language
      }),
      model: Effect.fn("AISDK.model")(function* (model) {
        return modelFromLanguage(model, yield* service.language(model))
      }),
    })
    return service
  }),
)

function modelFromLanguage(info: Info, language: LanguageModelV3) {
  const packageName = Provider.packageName(info.package!)
  const projected = mapBodyToProviderOptions(info, packageName)
  const providerID = info.canonical ?? info.providerID
  const optionKey = providerOptionKey(packageName, providerID)
  const route: AnyRoute = {
    compact: undefined,
    id: `ai-sdk:${packageName}`,
    provider: ProviderID.make(providerID),
    providerMetadataKey: optionKey,
    protocol: "ai-sdk",
    endpoint: Endpoint.path("/", { baseURL: "https://ai-sdk.local" }),
    auth: Auth.none,
    transport: {
      id: "ai-sdk",
      prepare: (input) => Effect.succeed(input.body),
      execute: () => Effect.succeed({ frames: Stream.empty }),
    },
    defaults: {
      headers: info.headers,
      http:
        projected.body === undefined && info.headers === undefined
          ? undefined
          : {
              body: projected.body === undefined ? undefined : { ...projected.body },
              headers: info.headers,
            },
      providerOptions: projected.settings,
    },
    body: {
      schema: Schema.Unknown,
      from: (request) =>
        Effect.try({
          try: () => callOptions(request, packageName, info.modelID ?? info.id, optionKey),
          catch: (cause) =>
            cause instanceof AIError ? cause : ProviderShared.invalidRequest("Invalid AI SDK request", cause),
        }),
    },
    with: () => route,
    model: (input) =>
      LanguageModel.make({ ...input, provider: "provider" in input ? input.provider : providerID, route }),
    prepareTransport: (body) => Effect.succeed(body),
    streamPrepared: (prepared) => streamLanguage(language, prepared as LanguageModelV3CallOptions),
  }
  return LanguageModel.make({
    id: info.modelID ?? info.id,
    provider: providerID,
    route,
    compatibility: info.compatibility,
  })
}

function gatewayProviderOptions(modelID: ID, settings: Readonly<Record<string, unknown>>) {
  const gateway =
    typeof settings.gateway === "object" && settings.gateway !== null && !Array.isArray(settings.gateway)
      ? Object.fromEntries(Object.entries(settings.gateway))
      : undefined
  const model = Object.fromEntries(Object.entries(settings).filter(([key]) => key !== "gateway"))
  if (Object.keys(model).length === 0) return gateway === undefined ? undefined : { gateway }

  const separator = modelID.indexOf("/")
  const prefix = separator > 0 ? modelID.slice(0, separator) : undefined
  if (prefix)
    return { ...(gateway === undefined ? {} : { gateway }), [prefix === "amazon" ? "bedrock" : prefix]: model }
  if (gateway !== undefined) return { gateway: { ...gateway, ...model } }
  return { gateway: model }
}

function providerOptionKey(packageName: string | undefined, providerID: Provider.ID) {
  if (packageName === "@ai-sdk/google") return "google"
  if (packageName === "@ai-sdk/google-vertex") return "vertex"
  if (packageName === "@ai-sdk/google-vertex/anthropic") return "anthropic"
  if (packageName === "@ai-sdk/amazon-bedrock") return "bedrock"
  if (packageName === "@ai-sdk/amazon-bedrock/mantle") return "openai"
  if (packageName === "@ai-sdk/azure") return "azure"
  if (packageName === "@ai-sdk/github-copilot") return "copilot"
  if (packageName === "@jerome-benoit/sap-ai-provider-v2") return "sap-ai"
  if (packageName === "@ai-sdk/openai-compatible") return providerID.split(".")[0]
  if (packageName === "@openrouter/ai-sdk-provider") return "openrouter"
  if (packageName === "ai-gateway-provider") return "openaiCompatible"
  if (packageName?.startsWith("@ai-sdk/")) return packageName.slice("@ai-sdk/".length)
  return providerID
}

function requestSettings(settings: Readonly<Record<string, unknown>> | undefined) {
  if (settings === undefined) return undefined
  const result = Object.fromEntries(
    Object.entries(settings).filter(
      ([key]) => !["apiKey", "authToken", "baseURL", "chunkTimeout", "fetch", "timeout"].includes(key),
    ),
  )
  return Object.keys(result).length === 0 ? undefined : result
}

function mapBodyToProviderOptions(model: Info, packageName: string) {
  const settings = requestSettings(model.settings)
  const pro = Schema.is(Schema.Struct({ mode: Schema.Literal("pro") }))(model.body?.reasoning)
  const forceReasoning =
    ["@ai-sdk/openai", "@ai-sdk/azure", "@ai-sdk/amazon-bedrock/mantle"].includes(packageName) &&
    (pro || settings?.reasoningEffort !== undefined || settings?.reasoningSummary !== undefined)
  const normalized = forceReasoning ? Provider.mergeOverlay(settings, { forceReasoning: true }) : settings
  if (!pro) return { settings: normalized, body: model.body }
  const body = { ...model.body }
  delete body.reasoning
  return {
    settings: Provider.mergeOverlay(normalized, { reasoningMode: "pro" }),
    body: Object.keys(body).length === 0 ? undefined : body,
  }
}

function callOptions(
  request: LLMRequest,
  packageName: string | undefined,
  modelID: ID,
  optionKey: string,
): LanguageModelV3CallOptions {
  const flattened = ProviderShared.flattenToolRequest(request)
  return {
    prompt: prompt(flattened.request),
    maxOutputTokens: request.generation?.maxTokens,
    temperature: request.generation?.temperature,
    stopSequences: request.generation?.stop === undefined ? undefined : [...request.generation.stop],
    topP: request.generation?.topP,
    topK: request.generation?.topK,
    presencePenalty: request.generation?.presencePenalty,
    frequencyPenalty: request.generation?.frequencyPenalty,
    seed: request.generation?.seed,
    tools: flattened.tools.map(tool),
    toolChoice: toolChoice(request.toolChoice),
    headers: request.http?.headers,
    providerOptions: requestProviderOptions(request.providerOptions, packageName, modelID, optionKey),
  }
}

function prompt(request: LLMRequest): LanguageModelV3Prompt {
  const system = request.system
    .map((part) => part.text)
    .filter(Boolean)
    .join("\n\n")
  const pending: UserContent = []
  const messages = request.messages.flatMap((input, index) => {
    if (input.role !== "tool") return message(input)
    const lowered = toolMessage(input)
    pending.push(...lowered.media)
    if (request.messages[index + 1]?.role === "tool" || pending.length === 0) return lowered.messages
    const media = [...pending]
    pending.length = 0
    return [
      ...lowered.messages,
      {
        role: "user" as const,
        content: [{ type: "text" as const, text: "Attached media from tool result:" }, ...media],
      },
    ]
  })
  if (!system.length) return messages
  return [{ role: "system", content: system }, ...messages]
}

function message(input: LLMRequest["messages"][number]): LanguageModelV3Message[] {
  switch (input.role) {
    case "system":
      // The initial privileged prompt lives in `request.system` and is prepended above. A system message here is a
      // chronological instruction update, but opaque AI SDK providers do not uniformly allow the system role after
      // conversation history, so preserve its position using the safe wrapped-user fallback.
      return [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: ProviderShared.wrapSystemUpdate(input.content.filter((part) => part.type === "text")),
            },
          ],
        },
      ]
    case "user":
      return [{ role: "user", content: input.content.flatMap(userPart) }]
    case "assistant":
      return [{ role: "assistant", content: input.content.flatMap(assistantPart) }]
    case "tool":
      return toolMessage(input).messages
  }
}

function toolMessage(input: LLMRequest["messages"][number]) {
  const media: UserContent = []
  const content = input.content.flatMap((part) => {
    if (part.type !== "tool-result" || part.result.type !== "content") return toolResultPart(part)
    const value = part.result.value.filter((item) => {
      if (item.type !== "file") return true
      if (!item.mime.startsWith("image/") && item.mime !== "application/pdf") return true
      media.push({ type: "file", mediaType: item.mime, data: fileData(item.uri), filename: item.name })
      return false
    })
    return toolResultPart({
      ...part,
      result:
        value.length === 0
          ? { type: "text", value: "Media attached in the following user message." }
          : { ...part.result, value },
    })
  })
  return {
    messages: content.length ? ([{ role: "tool", content }] satisfies LanguageModelV3Message[]) : [],
    media,
  }
}

function text(part: ContentPart) {
  return part.type === "text" ? [part.text] : []
}

function userPart(part: ContentPart): UserContent {
  if (part.type === "text") return [{ type: "text", text: part.text }]
  if (part.type === "media")
    return [{ type: "file", mediaType: part.mediaType, data: fileData(part.data), filename: part.filename }]
  return []
}

function assistantPart(part: ContentPart): AssistantContent {
  switch (part.type) {
    case "compaction":
      throw ProviderShared.unsupportedOperation({
        operation: "compaction-replay",
        provider: part.provider,
        message: "AI SDK routes cannot replay native provider compaction state",
      })
    case "text":
      return [{ type: "text", text: part.text, providerOptions: metadataProviderOptions(part.providerMetadata) }]
    case "media":
      return [{ type: "file", mediaType: part.mediaType, data: fileData(part.data), filename: part.filename }]
    case "reasoning":
      return [{ type: "reasoning", text: part.text, providerOptions: metadataProviderOptions(part.providerMetadata) }]
    case "tool-call":
      return [
        {
          type: "tool-call",
          toolCallId: part.id,
          toolName: part.name,
          input: part.input,
          providerExecuted: part.providerExecuted,
          providerOptions: metadataProviderOptions(part.providerMetadata),
        },
      ]
    case "tool-result":
      return toolResultPart(part)
  }
}

function fileData(data: Extract<ContentPart, { type: "media" }>["data"]) {
  if (typeof data !== "string") return data
  const base64 = /^data:[^;,]+(?:;[^,]*)*;base64,(.*)$/s.exec(data)?.[1]
  if (base64 !== undefined) return base64
  if (!URL.canParse(data)) return data
  const url = new URL(data)
  return url.protocol === "http:" || url.protocol === "https:" ? url : data
}

function toolResultPart(part: ContentPart): ToolResultContent[] {
  if (part.type !== "tool-result") return []
  return [
    {
      type: "tool-result",
      toolCallId: part.id,
      toolName: part.name,
      output: toolOutput(part.result),
      providerOptions: metadataProviderOptions(part.providerMetadata),
    },
  ]
}

function toolOutput(result: ToolResultValue) {
  switch (result.type) {
    case "text":
    case "error":
      return { type: "text" as const, value: messageValue(result.value) }
    case "content":
      return {
        type: "content" as const,
        value: result.value.map((item) => {
          if (item.type === "text") return { type: "text" as const, text: item.text }
          const data = /^data:[^;,]+(?:;[^,]*)*;base64,(.*)$/s.exec(item.uri)?.[1]
          const image = item.mime.toLowerCase().startsWith("image/")
          if (data !== undefined)
            return image
              ? { type: "image-data" as const, data, mediaType: item.mime }
              : { type: "file-data" as const, data, mediaType: item.mime, filename: item.name }
          return image ? { type: "image-url" as const, url: item.uri } : { type: "file-url" as const, url: item.uri }
        }),
      }
    case "json":
      return { type: "json" as const, value: jsonValue(result.value) }
  }
}

function tool(input: ToolDefinition): LanguageModelV3FunctionTool {
  return {
    type: "function",
    name: input.name,
    description: input.description,
    inputSchema: input.inputSchema as JSONSchema7,
  }
}

function toolChoice(input: LLMRequest["toolChoice"]): LanguageModelV3ToolChoice | undefined {
  if (!input) return undefined
  if (input.type === "tool") return input.name === undefined ? undefined : { type: "tool", toolName: input.name }
  return { type: input.type }
}

function requestProviderOptions(
  input: LLMRequest["providerOptions"],
  packageName: string | undefined,
  modelID: ID,
  optionKey: string,
): SharedV3ProviderOptions | undefined {
  if (!input) return undefined
  const options = jsonObject(input)
  if (packageName === "@ai-sdk/gateway") return gatewayProviderOptions(modelID, options)
  if (packageName === "@ai-sdk/azure") return { openai: options, azure: options }
  return { [optionKey]: options }
}

function metadataProviderOptions(input: ProviderMetadata | undefined): SharedV3ProviderOptions | undefined {
  if (!input) return undefined
  return Object.fromEntries(Object.entries(input).map(([key, value]) => [key, jsonObject(value)]))
}

function streamLanguage(language: LanguageModelV3, options: LanguageModelV3CallOptions) {
  const state = { step: 0, toolNames: {} as Record<string, string> }
  return Stream.concat(
    Stream.make(LLMEvent.stepStart({ index: state.step })),
    Stream.unwrap(
      Effect.tryPromise({
        try: () => language.doStream(options),
        catch: (error) => llmError(error, "request"),
      }).pipe(
        Effect.map((result) =>
          Stream.fromReadableStream({
            evaluate: () => result.stream,
            onError: (error) => llmError(error, "read"),
          }).pipe(
            Stream.mapEffect((event) => streamPartEvents(state, event)),
            Stream.flatMap((events) => Stream.fromIterable(events)),
          ),
        ),
      ),
    ),
  )
}

function streamPartEvents(
  state: { step: number; toolNames: Record<string, string> },
  event: LanguageModelV3StreamPart,
): Effect.Effect<ReadonlyArray<LLMEvent>, AIError> {
  switch (event.type) {
    case "stream-start":
    case "response-metadata":
    case "raw":
    case "file":
    case "source":
    case "tool-approval-request":
      return Effect.succeed([])
    case "text-start":
      return Effect.succeed([
        LLMEvent.textStart({ id: event.id, providerMetadata: providerMetadata(event.providerMetadata) }),
      ])
    case "text-delta":
      return Effect.succeed([
        LLMEvent.textDelta({
          id: event.id,
          text: event.delta,
          providerMetadata: providerMetadata(event.providerMetadata),
        }),
      ])
    case "text-end":
      return Effect.succeed([
        LLMEvent.textEnd({ id: event.id, providerMetadata: providerMetadata(event.providerMetadata) }),
      ])
    case "reasoning-start":
      return Effect.succeed([
        LLMEvent.reasoningStart({ id: event.id, providerMetadata: providerMetadata(event.providerMetadata) }),
      ])
    case "reasoning-delta":
      return Effect.succeed([
        LLMEvent.reasoningDelta({
          id: event.id,
          text: event.delta,
          providerMetadata: providerMetadata(event.providerMetadata),
        }),
      ])
    case "reasoning-end":
      return Effect.succeed([
        LLMEvent.reasoningEnd({ id: event.id, providerMetadata: providerMetadata(event.providerMetadata) }),
      ])
    case "tool-input-start":
      state.toolNames[event.id] = event.toolName
      return Effect.succeed([
        LLMEvent.toolInputStart({
          id: event.id,
          name: event.toolName,
          providerExecuted: event.providerExecuted,
          providerMetadata: providerMetadata(event.providerMetadata),
        }),
      ])
    case "tool-input-delta":
      return Effect.succeed([
        LLMEvent.toolInputDelta({ id: event.id, name: state.toolNames[event.id] ?? "unknown", text: event.delta }),
      ])
    case "tool-input-end":
      return Effect.succeed([
        LLMEvent.toolInputEnd({
          id: event.id,
          name: state.toolNames[event.id] ?? "unknown",
          providerMetadata: providerMetadata(event.providerMetadata),
        }),
      ])
    case "tool-call":
      state.toolNames[event.toolCallId] = event.toolName
      return ProviderShared.parseToolInput("aisdk", event.toolName, event.input).pipe(
        Effect.map((input) => [
          LLMEvent.toolCall({
            id: event.toolCallId,
            name: event.toolName,
            input,
            providerExecuted: event.providerExecuted,
            providerMetadata: providerMetadata(event.providerMetadata),
          }),
        ]),
        Effect.catch((error) =>
          event.providerExecuted
            ? Effect.fail(error)
            : Effect.succeed([
                LLMEvent.toolInputError({
                  id: event.toolCallId,
                  name: event.toolName,
                  raw: event.input,
                }),
              ]),
        ),
      )
    case "tool-result":
      delete state.toolNames[event.toolCallId]
      return Effect.succeed([
        LLMEvent.toolResult({
          id: event.toolCallId,
          name: event.toolName,
          result: ToolResultValue.make(event.result, event.isError ? "error" : "json"),
          providerExecuted: true,
          providerMetadata: providerMetadata(event.providerMetadata),
        }),
      ])
    case "finish":
      return Effect.succeed([
        LLMEvent.stepFinish({
          index: state.step++,
          reason: { normalized: finishReason(event.finishReason), raw: event.finishReason.raw },
          usage: usage(event.usage),
          providerMetadata: providerMetadata(event.providerMetadata),
        }),
        LLMEvent.finish({
          reason: { normalized: finishReason(event.finishReason), raw: event.finishReason.raw },
          usage: usage(event.usage),
          providerMetadata: providerMetadata(event.providerMetadata),
        }),
      ])
    case "error":
      return Effect.fail(llmError(event.error, "read"))
  }
}

function usage(input: Extract<LanguageModelV3StreamPart, { type: "finish" }>["usage"]): UsageInput | undefined {
  const output = {
    inputTokens: input.inputTokens.total,
    nonCachedInputTokens: input.inputTokens.noCache,
    cacheReadInputTokens: input.inputTokens.cacheRead,
    cacheWriteInputTokens: input.inputTokens.cacheWrite,
    outputTokens: input.outputTokens.total,
    reasoningTokens: input.outputTokens.reasoning,
    totalTokens:
      input.inputTokens.total === undefined || input.outputTokens.total === undefined
        ? undefined
        : input.inputTokens.total + input.outputTokens.total,
  }
  return Object.values(output).some((value) => value !== undefined) ? output : undefined
}

function finishReason(value: LanguageModelV3FinishReason): FinishReason {
  return value.unified === "other" ? "unknown" : value.unified
}

function providerMetadata(value: unknown) {
  return Schema.is(ProviderMetadata)(value) ? value : undefined
}

function jsonObject(input: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(input).map(([key, value]) => [key, jsonValue(value)]))
}

function jsonValue(input: unknown): JSONValue {
  try {
    const encoded = JSON.stringify(input)
    return encoded === undefined ? null : (JSON.parse(encoded) as JSONValue)
  } catch {
    return messageValue(input)
  }
}

function messageValue(input: unknown) {
  if (typeof input === "string") return input
  try {
    return JSON.stringify(input) ?? String(input)
  } catch {
    return String(input)
  }
}

function llmError(error: unknown, operation: "request" | "read") {
  if (error instanceof AIError) return error
  if (APICallError.isInstance(error)) return apiCallError(error)
  const network = networkFailure(error)
  if (network)
    return new AIError({
      reason: new TransportError({
        message: network.message.trim() === "" ? unknownErrorMessage(error) : network.message,
        cause: error,
        transport: "http",
        operation,
        code: network.code,
      }),
    })
  return new AIError({
    reason: classifyProviderFailure({
      message: unknownErrorMessage(error),
      rawBody: errorBody(error),
      cause: error,
    }),
  })
}

// Runtime-generated network failure shapes. The codes mirror the AI SDK's own
// Bun network error list in handleFetchError; the messages are undici's fetch
// TypeError and stream termination strings plus our SSE chunk timeout error.
// Unrecognized shapes still retry via the UnknownProvider default; this match
// only adds transport semantics (continuation eligibility, display).
const NETWORK_ERROR_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EPIPE",
  "ConnectionRefused",
  "ConnectionClosed",
  "FailedToOpenSocket",
])
const NETWORK_ERROR_MESSAGES = new Set([
  "fetch failed",
  "failed to fetch",
  "terminated",
  "other side closed",
  "sse read timed out",
])

const NativeErrorShape = Schema.Struct({
  message: Schema.String,
  code: Schema.optionalKey(Schema.String),
  cause: Schema.optionalKey(Schema.Unknown),
})
const decodeNativeErrorShape = Schema.decodeUnknownOption(NativeErrorShape)

function networkFailure(error: unknown, depth = 0): { message: string; code?: string } | undefined {
  if (depth > 4) return undefined
  const shape = Option.getOrUndefined(decodeNativeErrorShape(error))
  if (!shape) return undefined
  // Prefer the deepest match: wrappers like undici's "fetch failed" TypeError
  // carry the specific network code on their cause.
  const cause = networkFailure(shape.cause, depth + 1)
  if (cause) return cause
  if (shape.code !== undefined && (NETWORK_ERROR_CODES.has(shape.code) || shape.code.startsWith("UND_ERR")))
    return { message: shape.message, code: shape.code }
  if (NETWORK_ERROR_MESSAGES.has(shape.message.trim().toLowerCase()))
    return { message: shape.message, code: shape.code }
  return undefined
}

function apiCallError(error: APICallError) {
  const failure = RequestExecutor.httpFailure({
    message: providerErrorMessage(error),
    url: error.url,
    status: error.statusCode,
    data: error.data,
    responseHeaders: error.responseHeaders,
    responseBody: error.responseBody ?? errorBody(error.data),
    cause: error,
  })
  if (error.statusCode !== undefined || !error.isRetryable) return failure
  return new AIError({
    reason: new TransportError({
      message: failure.message,
      body: failure.reason.body,
      http: failure.reason.http,
      cause: failure.reason.cause,
      transport: "http",
      operation: "request",
      url: error.url,
    }),
  })
}

function errorBody(value: unknown) {
  if (typeof value === "string") return value
  if (value instanceof Error || !Schema.is(Schema.Json)(value)) return undefined
  return ProviderShared.encodeJson(value)
}

const ProviderErrorDetail = Schema.Struct({
  message: Schema.optionalKey(Schema.String),
  code: Schema.optionalKey(Schema.Union([Schema.String, Schema.Finite])),
})
const ProviderErrorBody = Schema.Struct({
  ...ProviderErrorDetail.fields,
  error: Schema.optionalKey(ProviderErrorDetail),
})
const decodeProviderError = Schema.decodeUnknownOption(
  Schema.Union([ProviderErrorBody, Schema.fromJsonString(ProviderErrorBody)]),
)

function unknownErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  return message.trim() === "" ? "Provider request failed" : message
}

function providerErrorMessage(error: APICallError) {
  const data = Option.getOrUndefined(decodeProviderError(error.data))
  const body = Option.getOrUndefined(decodeProviderError(error.responseBody))
  const details = [data?.error, data, body?.error, body]
  const message = details.map((detail) => detail?.message).find((value) => value?.trim())
  const value = details.map((detail) => detail?.code).find((value) => value !== undefined)
  const code = value === undefined ? undefined : String(value)
  const prefix =
    error.statusCode === undefined ? "Provider request failed" : `Provider request failed with HTTP ${error.statusCode}`
  return error.message.trim() !== "" ? error.message : (message ?? (code === undefined ? prefix : `${prefix}: ${code}`))
}

export const node = makeLocationNode({ service: Service, layer: locationLayer, deps: [] })
