import { Effect, Option, Schema, SchemaGetter } from "effect"
import type { Content } from "@opencode/schema/tool"
import { HttpTransport } from "../route/transport/index.js"
import { Protocol } from "../route/protocol.js"
import {
  AIError,
  LLMEvent,
  ProviderInternalError,
  Usage,
  type FinishReason,
  type JsonSchema,
  type LLMRequest,
  type MediaPart,
  type ProviderMetadata,
  type ReasoningPart,
  type TextPart,
  type ToolCallPart,
  type ToolDefinition,
  type ToolResultPart,
} from "../schema/index.js"
import { JsonObject, optionalArray, optionalNull, ProviderShared } from "./shared.js"
import { classifyProviderFailure } from "../provider-error.js"
import { OpenResponsesOptions } from "./utils/open-responses-options.js"
import { Lifecycle } from "./utils/lifecycle.js"
import { ToolSchemaProjection } from "./utils/tool-schema.js"
import { ToolStream } from "./utils/tool-stream.js"

const ADAPTER = "open-responses"
const NAME = "Open Responses"
export const PATH = "/responses"

// =============================================================================
// Request Body Schema
// =============================================================================
export const OpenResponsesInputText = Schema.Struct({
  type: Schema.tag("input_text"),
  text: Schema.String,
})
export const OpenResponsesInputImage = Schema.Struct({
  type: Schema.tag("input_image"),
  image_url: Schema.String,
  detail: Schema.optional(Schema.String),
})
export const OpenResponsesInputFile = Schema.Struct({
  type: Schema.tag("input_file"),
  filename: Schema.String,
  detail: Schema.optional(Schema.String),
  file_data: Schema.optional(Schema.String),
  file_url: Schema.optional(Schema.String),
})
const OpenResponsesInputVideo = Schema.Struct({
  type: Schema.tag("input_video"),
  video_url: Schema.String,
})
const MediaInput = Schema.Union([OpenResponsesInputImage, OpenResponsesInputFile])
export type MediaInput = Schema.Schema.Type<typeof MediaInput>
const OpenResponsesInputContent = Schema.Union([OpenResponsesInputText, MediaInput])

export const OpenResponsesOutputText = Schema.Struct({
  type: Schema.tag("output_text"),
  text: Schema.String,
})

export const MessagePhase = Schema.NullOr(Schema.Literals(["commentary", "final_answer"]))
type MessagePhase = Schema.Schema.Type<typeof MessagePhase>

export const MessageMetadata = Schema.Struct({
  itemId: Schema.optional(Schema.String),
  type: Schema.optional(Schema.Literal("message")),
  status: Schema.optional(Schema.String),
  phase: Schema.optional(MessagePhase),
})

const messagePhase = (value: unknown): MessagePhase | undefined => {
  if (value === null || value === "commentary" || value === "final_answer") return value
  return undefined
}

const OpenResponsesReasoningSummaryText = Schema.Struct({
  type: Schema.tag("summary_text"),
  text: Schema.String,
})

export const OpenResponsesReasoningItem = Schema.Struct({
  type: Schema.tag("reasoning"),
  id: Schema.optionalKey(Schema.String),
  summary: Schema.Array(OpenResponsesReasoningSummaryText),
  encrypted_content: optionalNull(Schema.String),
})

const OpenResponsesWebSearchCall = Schema.StructWithRest(
  Schema.Struct({
    type: Schema.tag("web_search_call"),
    id: Schema.String,
    status: Schema.optional(Schema.String),
    action: optionalNull(JsonObject),
  }),
  [JsonObject],
)

const OpenResponsesFileSearchCall = Schema.StructWithRest(
  Schema.Struct({
    type: Schema.tag("file_search_call"),
    id: Schema.String,
    status: Schema.optional(Schema.String),
    queries: Schema.optional(Schema.Array(Schema.String)),
    results: optionalNull(Schema.Array(JsonObject)),
  }),
  [JsonObject],
)

const OpenResponsesCodeInterpreterCall = Schema.StructWithRest(
  Schema.Struct({
    type: Schema.tag("code_interpreter_call"),
    id: Schema.String,
    status: Schema.optional(Schema.String),
    code: optionalNull(Schema.String),
    container_id: optionalNull(Schema.String),
    outputs: optionalNull(Schema.Array(JsonObject)),
  }),
  [JsonObject],
)

const OpenResponsesMCPCall = Schema.StructWithRest(
  Schema.Struct({
    type: Schema.tag("mcp_call"),
    id: Schema.String,
    status: Schema.optional(Schema.String),
    server_label: Schema.optional(Schema.String),
    name: Schema.optional(Schema.String),
    arguments: Schema.optional(Schema.String),
    output: optionalNull(Schema.String),
    error: Schema.optional(Schema.Unknown),
  }),
  [JsonObject],
)

export const HostedToolItem = Schema.Union([
  OpenResponsesWebSearchCall,
  OpenResponsesFileSearchCall,
  OpenResponsesCodeInterpreterCall,
  OpenResponsesMCPCall,
])
export type HostedToolItem = Schema.Schema.Type<typeof HostedToolItem>

// `function_call_output.output` accepts either a plain string or an ordered
// array of content items so tools can return images and files in addition to text.
// https://www.openresponses.org/reference
const OpenResponsesFunctionCallOutputContent = Schema.Union([
  OpenResponsesInputText,
  OpenResponsesInputImage,
  OpenResponsesInputFile,
  OpenResponsesInputVideo,
])

const OpenResponsesFunctionCallOutput = Schema.Union([
  Schema.String,
  Schema.Array(OpenResponsesFunctionCallOutputContent),
])

export const CompactionItem = Schema.Struct({
  type: Schema.Literal("compaction"),
  id: optionalNull(Schema.String),
  encrypted_content: Schema.String,
})

export const InputItem = Schema.Union([
  CompactionItem,
  Schema.Struct({ role: Schema.tag("system"), content: Schema.String }),
  Schema.Struct({ role: Schema.tag("developer"), content: Schema.String }),
  Schema.Struct({
    role: Schema.tag("user"),
    content: Schema.Array(OpenResponsesInputContent),
    type: Schema.optional(Schema.Literal("message")),
    id: Schema.optional(Schema.String),
    status: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    type: Schema.tag("message"),
    id: Schema.optionalKey(Schema.String),
    role: Schema.tag("assistant"),
    content: Schema.Array(OpenResponsesOutputText),
    phase: Schema.optionalKey(MessagePhase),
    status: Schema.optional(Schema.String),
  }),
  OpenResponsesReasoningItem,
  Schema.Struct({
    type: Schema.tag("function_call"),
    id: Schema.optionalKey(Schema.String),
    call_id: Schema.String,
    name: Schema.String,
    namespace: Schema.optional(Schema.String),
    arguments: Schema.String,
  }),
  Schema.Struct({
    type: Schema.tag("function_call_output"),
    call_id: Schema.String,
    output: OpenResponsesFunctionCallOutput,
  }),
  HostedToolItem,
])
type OpenResponsesInputItem = Schema.Schema.Type<typeof InputItem>
export type HostedToolReplayItem = {
  readonly type: string
  readonly id: string
  readonly [key: string]: unknown
}
type LoweredInputItem =
  | OpenResponsesInputItem
  | HostedToolReplayItem
  | {
      readonly type: "message"
      readonly id?: string
      readonly role: "assistant"
      readonly content: ReadonlyArray<{ readonly type: "output_text"; readonly text: string }>
      readonly phase?: MessagePhase | null
    }

// Mutable counterpart of the schema reasoning item so `lowerMessages` can fold
// multiple streamed summary parts into the same item before flushing.
type OpenResponsesReasoningInput = {
  type: "reasoning"
  id?: string
  summary: Array<{ type: "summary_text"; text: string }>
  encrypted_content?: string | null
}
export const Tool = Schema.Struct({
  type: Schema.tag("function"),
  name: Schema.String,
  description: Schema.String,
  parameters: JsonObject,
  strict: Schema.optional(Schema.Boolean),
})

export const ToolChoice = Schema.Union([
  Schema.Literals(["auto", "none", "required"]),
  Schema.Struct({ type: Schema.tag("function"), name: Schema.String }),
  Schema.Struct({
    type: Schema.tag("allowed_tools"),
    mode: Schema.Literals(["auto", "none", "required"]),
    tools: Schema.Array(Schema.Struct({ type: Schema.tag("function"), name: Schema.String })),
  }),
])

// Fields shared between the HTTP body and the WebSocket `response.create`
// message. The HTTP body adds `stream: true`; the WebSocket message adds
// `type: "response.create"`. Defining the shared shape once keeps the two
// transports in sync without a destructure-and-strip dance.
export const coreFields = {
  model: Schema.String,
  input: Schema.Array(InputItem),
  instructions: Schema.optional(Schema.String),
  tools: optionalArray(Tool),
  tool_choice: Schema.optional(ToolChoice),
  store: Schema.optional(Schema.Boolean),
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  safety_identifier: Schema.optional(Schema.String),
  stream_options: Schema.optional(
    Schema.Struct({
      include_obfuscation: Schema.optional(Schema.Boolean),
    }),
  ),
  top_logprobs: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 20 }))),
  truncation: Schema.optional(OpenResponsesOptions.TruncationSchema),
  service_tier: Schema.optional(OpenResponsesOptions.ServiceTierSchema),
  prompt_cache_key: Schema.optional(Schema.String),
  include: optionalArray(OpenResponsesOptions.ResponseIncludableSchema),
  reasoning: Schema.optional(
    Schema.Struct({
      effort: Schema.optional(OpenResponsesOptions.ReasoningEffort),
      summary: Schema.optional(Schema.Literals(["auto", "concise", "detailed"])),
    }),
  ),
  text: Schema.optional(
    Schema.Struct({
      verbosity: Schema.optional(OpenResponsesOptions.TextVerbositySchema),
    }),
  ),
  max_output_tokens: Schema.optional(Schema.Number),
  max_tool_calls: Schema.optional(Schema.Int),
  parallel_tool_calls: Schema.optional(Schema.Boolean),
  temperature: Schema.optional(Schema.Number),
  top_p: Schema.optional(Schema.Number),
  presence_penalty: Schema.optional(Schema.Number),
  frequency_penalty: Schema.optional(Schema.Number),
}

const OpenResponsesBody = Schema.Struct({
  ...coreFields,
  stream: Schema.Literal(true),
})
export type OpenResponsesBody = Schema.Schema.Type<typeof OpenResponsesBody>

export const OpenResponsesUsage = Schema.Struct({
  input_tokens: Schema.optional(Schema.Number),
  input_tokens_details: optionalNull(
    Schema.Struct({
      cached_tokens: Schema.optional(Schema.Number),
      cache_write_tokens: Schema.optional(Schema.Number),
    }),
  ),
  output_tokens: Schema.optional(Schema.Number),
  output_tokens_details: optionalNull(Schema.Struct({ reasoning_tokens: Schema.optional(Schema.Number) })),
  total_tokens: Schema.optional(Schema.Number),
})
type OpenResponsesUsage = Schema.Schema.Type<typeof OpenResponsesUsage>

// The spec requires `id` on every output item, but some gateways drop it from
// later item events (Bedrock Mantle renames it to `item_id` on
// `output_item.done` and `response.completed.output`). Decode it as optional
// and let `normalize` recover or mint it once before the parser runs.
// https://www.openresponses.org/specification#extending-items
export const StreamItem = Schema.StructWithRest(
  Schema.Struct({
    type: Schema.String,
    id: Schema.optional(Schema.String),
    call_id: Schema.optional(Schema.String),
    name: Schema.optional(Schema.String),
    namespace: Schema.optional(Schema.String),
    arguments: Schema.optional(Schema.String),
    encrypted_content: optionalNull(Schema.String),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
)
export type StreamItem = Schema.Schema.Type<typeof StreamItem>
export type OutputItem = StreamItem & { readonly id: string }

// Responses-compatible providers put streaming error details at the top level or
// under `error`, and response failures under `response.error`. Accept all three shapes.
// https://www.openresponses.org/specification
const OpenResponsesErrorPayload = Schema.Struct({
  type: optionalNull(Schema.String),
  code: optionalNull(Schema.String),
  message: optionalNull(Schema.String),
  param: optionalNull(Schema.String),
})
type OpenResponsesErrorPayload = Schema.Schema.Type<typeof OpenResponsesErrorPayload>

const WebSocketErrorHeader = Schema.Union([Schema.String, Schema.Number, Schema.Boolean])
export const WebSocketErrorEvent = Schema.StructWithRest(
  Schema.Struct({
    type: Schema.tag("error"),
    status: Schema.optional(Schema.Number),
    status_code: Schema.optional(Schema.Number),
    code: optionalNull(Schema.String),
    message: Schema.optional(Schema.String),
    param: optionalNull(Schema.String),
    error: optionalNull(OpenResponsesErrorPayload),
    headers: Schema.optional(Schema.Record(Schema.String, WebSocketErrorHeader)),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
)
const decodeWebSocketErrorEvent = Schema.decodeUnknownEffect(WebSocketErrorEvent)

export const decodeKnownErrorEvent = (event: Event) =>
  decodeWebSocketErrorEvent({
    ...event,
    status: typeof event.status === "number" ? event.status : undefined,
    status_code: typeof event.status_code === "number" ? event.status_code : undefined,
    headers: ProviderShared.isRecord(event.headers)
      ? Object.fromEntries(
          Object.entries(event.headers).filter(
            (entry): entry is [string, string | number | boolean] =>
              typeof entry[1] === "string" || typeof entry[1] === "number" || typeof entry[1] === "boolean",
          ),
        )
      : undefined,
  })

export const Event = Schema.StructWithRest(
  Schema.Struct({
    type: Schema.String,
    delta: Schema.optional(Schema.String),
    arguments: Schema.optional(Schema.String),
    text: Schema.optional(Schema.String),
    item_id: Schema.optional(Schema.String),
    output_index: Schema.optional(Schema.Number),
    summary_index: Schema.optional(Schema.Number),
    // OutputItemAdded/Done permit a null item in the Open Responses OpenAPI schema.
    item: optionalNull(StreamItem),
    response: Schema.optional(
      Schema.StructWithRest(
        Schema.Struct({
          id: Schema.optional(Schema.String),
          service_tier: optionalNull(Schema.String),
          incomplete_details: optionalNull(Schema.Struct({ reason: Schema.optional(Schema.String) })),
          output: Schema.optional(Schema.Array(StreamItem)),
          usage: optionalNull(OpenResponsesUsage),
          error: optionalNull(OpenResponsesErrorPayload),
        }),
        [Schema.Record(Schema.String, Schema.Unknown)],
      ),
    ),
    code: optionalNull(Schema.String),
    message: Schema.optional(Schema.String),
    param: optionalNull(Schema.String),
    error: optionalNull(OpenResponsesErrorPayload),
    status: Schema.optional(Schema.Unknown),
    status_code: Schema.optional(Schema.Unknown),
    headers: Schema.optional(Schema.Unknown),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
).pipe(
  Schema.decode({
    decode: SchemaGetter.transform((event) => {
      if (event.type !== "error" || event.error != null) return event
      const { code, message, param, ...rest } = event
      if (code === undefined && message === undefined && param === undefined) return event
      // Flat errors (for example, Meta's) can also arrive through generic Responses endpoints.
      return { ...rest, error: { code, message, param } }
    }),
    encode: SchemaGetter.passthrough(),
  }),
)
export type Event = Schema.Schema.Type<typeof Event>
export type NormalizedEvent = Event & { readonly item?: OutputItem | null }

const decodeEventValue = Schema.decodeUnknownEffect(Event)
const decodeFrame = Schema.decodeUnknownEffect(ProviderShared.Json)

/**
 * Decodes one WebSocket frame. xAI answers a rejected `response.create` with `{ "error": { "message", "type" } }` and no
 * event type; that envelope reads as an error event so the failure classifies instead of failing decoding.
 */
export const decodeChannelEvent = (frame: string) =>
  decodeFrame(frame).pipe(
    Effect.flatMap((value) =>
      decodeEventValue(
        ProviderShared.isRecord(value) && value.type === undefined && ProviderShared.isRecord(value.error)
          ? { ...value, type: "error" }
          : value,
      ),
    ),
  )

export interface ProviderAdapter {
  readonly id: string
  readonly name: string
  readonly nativeTool?: (
    native: NonNullable<ToolDefinition["native"]>,
  ) => Effect.Effect<{ readonly type: string }, AIError>
  readonly lowerMedia?: (input: {
    readonly part: MediaPart
    readonly media: ProviderShared.NormalizedMedia
    readonly request: LLMRequest
  }) => MediaInput | undefined
  readonly restoreHostedToolItem?: (item: unknown) => HostedToolReplayItem | undefined
}

const BASE_ADAPTER: ProviderAdapter = { id: ADAPTER, name: NAME }

export interface ParserState {
  readonly provider: LLMRequest["model"]["provider"]
  readonly completedCompactions: ReadonlySet<string>
  readonly id: string
  readonly name: string
  readonly providerMetadataKey: string
  readonly tools: ToolStream.State<string>
  readonly hasFunctionCall: boolean
  readonly lifecycle: Lifecycle.State
  readonly outputItems: Readonly<Record<number, string>>
  readonly message: { readonly id: string; readonly phase: MessagePhase | null | undefined } | undefined
  readonly reasoningItems: Readonly<Record<string, ReasoningStreamItem>>
}

type ReasoningSummaryStatus = "active" | "can-conclude" | "concluded"

interface ReasoningStreamItem {
  readonly encryptedContent: string | null | undefined
  // Keyed by the wire protocol's numeric `summary_index`. JS object keys coerce to
  // strings, but typing the map as `Record<number, ...>` documents intent
  // and matches the wire field.
  readonly summaryParts: Readonly<Record<number, ReasoningSummaryStatus>>
  // Summary indexes that received at least one streamed delta. The `:0` block
  // is started eagerly when the item opens, so block existence cannot tell
  // whether a `.done` final would duplicate streamed text.
  readonly deltaIndexes: ReadonlySet<number>
}

// =============================================================================
// Request Lowering
// =============================================================================
export const lowerTool = Effect.fn("OpenResponses.lowerTool")(function* (
  protocolName: string,
  tool: ToolDefinition,
  inputSchema: JsonSchema,
) {
  if (tool.native !== undefined)
    return yield* ProviderShared.invalidRequest(`${protocolName} does not support provider-native tool ${tool.name}`)
  return {
    type: "function" as const,
    name: tool.name,
    description: tool.description,
    parameters: inputSchema,
    // The common tool definition does not currently express Responses strict-schema policy.
    strict: false,
  }
})

export const lowerToolChoice = (protocolName: string, toolChoice: NonNullable<LLMRequest["toolChoice"]>) =>
  ProviderShared.matchToolChoice(protocolName, toolChoice, {
    auto: () => "auto" as const,
    none: () => "none" as const,
    required: () => "required" as const,
    tool: (toolName) => ({ type: "function" as const, name: toolName }),
  })

// Server-issued item ids need a nonempty prefix and suffix, but the prefix is
// provider-defined and does not necessarily identify the item's semantic type.
const itemID = (providerMetadata: ProviderMetadata | undefined, providerMetadataKey: string) => {
  const metadata = providerMetadata?.[providerMetadataKey]
  if (!ProviderShared.isRecord(metadata) || typeof metadata.itemId !== "string") return undefined
  const separator = metadata.itemId.indexOf("_")
  return separator > 0 && separator < metadata.itemId.length - 1 ? metadata.itemId : undefined
}

const lowerToolCall = (part: ToolCallPart, providerMetadataKey: string): OpenResponsesInputItem => {
  const id = itemID(part.providerMetadata, providerMetadataKey)
  return {
    type: "function_call",
    ...(id === undefined ? {} : { id }),
    call_id: part.id,
    name: part.name,
    namespace: part.namespace,
    arguments: ProviderShared.encodeJson(part.input),
  }
}

const lowerReasoning = (part: ReasoningPart, providerMetadataKey: string): OpenResponsesReasoningInput | undefined => {
  const metadata = part.providerMetadata?.[providerMetadataKey]
  if (!ProviderShared.isRecord(metadata)) return undefined
  const id = itemID(part.providerMetadata, providerMetadataKey)
  const encryptedContent =
    typeof metadata.reasoningEncryptedContent === "string" || metadata.reasoningEncryptedContent === null
      ? metadata.reasoningEncryptedContent
      : undefined
  return {
    type: "reasoning",
    ...(id === undefined ? {} : { id }),
    summary: part.text.length > 0 ? [{ type: "summary_text", text: part.text }] : [],
    encrypted_content: encryptedContent,
  }
}

const lowerMedia = Effect.fn("OpenResponses.lowerMedia")(function* (
  part: MediaPart,
  request: LLMRequest,
  adapter: ProviderAdapter,
  target: "message" | "tool-result",
) {
  const media = ProviderShared.normalizeMedia(part)
  const providerMedia = adapter.lowerMedia?.({ part, media, request })
  if (providerMedia) return providerMedia
  const detail = yield* ProviderShared.validateWith(Schema.decodeUnknownEffect(OpenResponsesInputImage.fields.detail))(
    part.providerMetadata?.[metadataKey(request.model)]?.detail,
  )
  const url =
    typeof part.data === "string" && (part.data.startsWith("https://") || part.data.startsWith("http://"))
      ? part.data
      : undefined
  if (!media.mime.startsWith("image/")) {
    if (target === "tool-result" && media.mime.startsWith("video/"))
      return { type: "input_video" as const, video_url: url ?? media.dataUrl }
    return {
      type: "input_file" as const,
      filename: part.filename ?? (media.mime === "application/pdf" ? "document.pdf" : "file"),
      detail,
      ...(url ? { file_url: url } : { file_data: media.dataUrl }),
    }
  }
  return {
    type: "input_image" as const,
    image_url: url ?? media.dataUrl,
    detail,
  }
})

const lowerUserContent = Effect.fnUntraced(function* (
  part: LLMRequest["messages"][number]["content"][number],
  request: LLMRequest,
  adapter: ProviderAdapter,
) {
  if (part.type === "text") return { type: "input_text" as const, text: part.text }
  if (part.type === "media") return yield* lowerMessageMedia(part, request, adapter)
  return yield* ProviderShared.unsupportedContent(adapter.name, "user", ["text", "media"])
})

const lowerMessageMedia = Effect.fnUntraced(function* (part: MediaPart, request: LLMRequest, adapter: ProviderAdapter) {
  const lowered = yield* lowerMedia(part, request, adapter, "message")
  if (lowered.type === "input_video")
    return yield* ProviderShared.invalidRequest(`${adapter.name} user messages do not support input_video`)
  return lowered
})

// Tool results may carry structured text, images, and files. Keep media as provider-native
// content instead of JSON-stringifying base64 into a prompt string.
const lowerToolResultContentItem = Effect.fnUntraced(function* (
  item: Content,
  request: LLMRequest,
  adapter: ProviderAdapter,
) {
  if (item.type === "text") return { type: "input_text" as const, text: item.text }
  return yield* lowerMedia(
    { type: "media", mediaType: item.mime, data: item.uri, filename: item.name },
    request,
    adapter,
    "tool-result",
  )
})

const lowerHostedToolResultContentItem = Effect.fnUntraced(function* (
  item: Content,
  request: LLMRequest,
  adapter: ProviderAdapter,
) {
  if (item.type === "text") return { type: "input_text" as const, text: item.text }
  return yield* lowerMessageMedia(
    { type: "media", mediaType: item.mime, data: item.uri, filename: item.name },
    request,
    adapter,
  )
})

const lowerToolResultOutput = Effect.fnUntraced(function* (
  part: ToolResultPart,
  request: LLMRequest,
  adapter: ProviderAdapter,
) {
  // Text/json/error results are encoded as a plain string for backward
  // compatibility with existing cassettes and provider expectations.
  if (part.result.type !== "content") return ProviderShared.toolResultText(part)
  // Preserve the narrowed array element type when compiled through a consumer package.
  const content: ReadonlyArray<Content> = part.result.value
  return yield* Effect.forEach(content, (item) => lowerToolResultContentItem(item, request, adapter))
})

const lowerMessages = Effect.fn("OpenResponses.lowerMessages")(function* (
  request: LLMRequest,
  adapter: ProviderAdapter,
) {
  const input: LoweredInputItem[] = []
  const providerMetadataKey = metadataKey(request.model)

  for (const message of request.messages) {
    const metadata = yield* ProviderShared.validateWith(
      Schema.decodeUnknownEffect(Schema.UndefinedOr(MessageMetadata)),
    )(message.providerMetadata?.[providerMetadataKey])
    if (message.role === "system") {
      input.push({
        role: "developer",
        content: ProviderShared.joinText(yield* ProviderShared.systemUpdateText(adapter.name, message)),
      })
      continue
    }

    if (message.role === "user") {
      const content = yield* Effect.forEach(message.content, (part) => lowerUserContent(part, request, adapter))
      if (content.length > 0)
        input.push({ role: "user", content, type: metadata?.type, id: metadata?.itemId, status: metadata?.status })
      continue
    }

    if (message.role === "assistant") {
      const content: TextPart[] = []
      const reasoningItems: Record<string, OpenResponsesReasoningInput> = {}
      const hostedToolItems = new Set<string>()
      const flushText = () => {
        if (content.length === 0) return
        const groups = content.reduce<
          Array<{ id: string | undefined; phase: MessagePhase | null | undefined; parts: TextPart[] }>
        >((groups, part) => {
          const partMetadata = part.providerMetadata?.[providerMetadataKey]
          const id = itemID(part.providerMetadata, providerMetadataKey) ?? metadata?.itemId
          const partPhase = messagePhase(partMetadata?.phase)
          const phase = partPhase === undefined ? metadata?.phase : partPhase
          const group = groups.at(-1)
          if (group && group.id === id && group.phase === phase) group.parts.push(part)
          else groups.push({ id, phase, parts: [part] })
          return groups
        }, [])
        input.push(
          ...groups.map((group) => ({
            type: "message" as const,
            ...(group.id === undefined ? {} : { id: group.id }),
            role: "assistant" as const,
            // Replayed text is a finished input item, even if generation was cut short.
            status: "completed",
            content: group.parts.map((part) => ({ type: "output_text" as const, text: part.text })),
            ...(group.phase === undefined ? {} : { phase: group.phase }),
          })),
        )
        content.splice(0, content.length)
      }
      for (const part of message.content) {
        if (part.type === "compaction") {
          flushText()
          if (part.provider !== request.model.provider || part.encrypted === undefined)
            return yield* ProviderShared.invalidRequest(
              "Compaction state must be replayed to its originating provider and API",
            )
          input.push({ type: "compaction", id: part.id, encrypted_content: part.encrypted })
          continue
        }
        if (part.type === "text") {
          content.push(part)
          continue
        }
        if (part.type === "reasoning") {
          flushText()
          const reasoning = lowerReasoning(part, providerMetadataKey)
          if (!reasoning) continue
          const existing = reasoning.id === undefined ? undefined : reasoningItems[reasoning.id]
          if (existing) {
            existing.summary.push(...reasoning.summary)
            if (typeof reasoning.encrypted_content === "string")
              existing.encrypted_content = reasoning.encrypted_content
            continue
          }
          if (reasoning.id !== undefined) reasoningItems[reasoning.id] = reasoning
          input.push(reasoning)
          continue
        }
        if (part.type === "tool-call") {
          flushText()
          if (part.providerExecuted === true) continue
          input.push(lowerToolCall(part, providerMetadataKey))
          continue
        }
        if (part.type === "tool-result" && part.providerExecuted === true) {
          flushText()
          const id = itemID(part.providerMetadata, providerMetadataKey)
          const hosted =
            part.result.type !== "json"
              ? undefined
              : Schema.is(HostedToolItem)(part.result.value)
                ? part.result.value
                : adapter.restoreHostedToolItem?.(part.result.value)
          if (id !== undefined && hosted?.id === id) {
            if (!hostedToolItems.has(id)) {
              input.push(hosted)
              hostedToolItems.add(id)
            }
            continue
          }
          const content: ReadonlyArray<Content> =
            part.result.type === "content"
              ? part.result.value
              : [{ type: "text", text: ProviderShared.toolResultText(part) }]
          input.push({
            role: "user",
            content: yield* Effect.forEach(content, (item) => lowerHostedToolResultContentItem(item, request, adapter)),
          })
          continue
        }
        return yield* ProviderShared.unsupportedContent(adapter.name, "assistant", [
          "text",
          "reasoning",
          "tool-call",
          "tool-result",
        ])
      }
      flushText()
      continue
    }

    for (const part of message.content) {
      if (!ProviderShared.supportsContent(part, ["tool-result"]))
        return yield* ProviderShared.unsupportedContent(adapter.name, "tool", ["tool-result"])
      input.push({
        type: "function_call_output",
        call_id: part.id,
        output: yield* lowerToolResultOutput(part, request, adapter),
      })
    }
  }

  return input
})

export const lowerConversation = Effect.fn("OpenResponses.lowerConversation")(function* (
  request: LLMRequest,
  adapter: ProviderAdapter,
) {
  const instructions = ProviderShared.joinText(request.system)
  return {
    model: request.model.id,
    input: yield* lowerMessages(request, adapter),
    ...(instructions ? { instructions } : {}),
  }
})

export const lowerGeneration = (request: LLMRequest) => {
  const options = OpenResponsesOptions.resolve(request)
  const generation = request.generation
  const cacheKey = ProviderShared.promptCacheKey(request)
  const parallelToolCalls = resolveParallelToolCalls(request)
  return {
    stream: true as const,
    max_output_tokens: generation?.maxTokens,
    temperature: generation?.temperature,
    top_p: generation?.topP,
    presence_penalty: generation?.presencePenalty,
    frequency_penalty: generation?.frequencyPenalty,
    ...(options.store !== undefined ? { store: options.store } : {}),
    ...(options.metadata ? { metadata: options.metadata } : {}),
    ...(options.safetyIdentifier ? { safety_identifier: options.safetyIdentifier } : {}),
    ...(options.streamOptions?.includeObfuscation !== undefined
      ? { stream_options: { include_obfuscation: options.streamOptions.includeObfuscation } }
      : {}),
    ...(options.topLogprobs !== undefined ? { top_logprobs: options.topLogprobs } : {}),
    ...(cacheKey ? { prompt_cache_key: cacheKey } : {}),
    ...(options.include ? { include: options.include } : {}),
    ...(options.reasoningEffort || options.reasoningSummary
      ? { reasoning: { effort: options.reasoningEffort, summary: options.reasoningSummary } }
      : {}),
    ...(options.textVerbosity ? { text: { verbosity: options.textVerbosity } } : {}),
    ...(options.serviceTier ? { service_tier: options.serviceTier } : {}),
    ...(options.maxToolCalls !== undefined ? { max_tool_calls: options.maxToolCalls } : {}),
    ...(parallelToolCalls !== undefined ? { parallel_tool_calls: parallelToolCalls } : {}),
    ...(options.truncation ? { truncation: options.truncation } : {}),
  }
}

export const resolveParallelToolCalls = (request: LLMRequest) => {
  const configured = OpenResponsesOptions.resolve(request).parallelToolCalls
  if (configured !== undefined) return configured
  const disabled = request.toolChoice?.disableParallelToolUse
  return disabled === undefined ? undefined : !disabled
}

export const allowedToolChoice = (request: LLMRequest) => {
  const allowed = OpenResponsesOptions.resolve(request).allowedTools
  if (!allowed) return undefined
  return {
    type: "allowed_tools" as const,
    mode: allowed.mode,
    tools: allowed.toolNames.map((name) => ({ type: "function" as const, name })),
  }
}

export const fromRequestWithAdapter = Effect.fn("OpenResponses.fromRequestWithAdapter")(function* (
  request: LLMRequest,
  adapter: ProviderAdapter,
) {
  const projected = ProviderShared.flattenToolRequest(request)
  const toolSchemaCompatibility = request.model.compatibility?.toolSchema
  return {
    ...(yield* lowerConversation(projected.request, adapter)),
    ...lowerGeneration(request),
    tools:
      projected.tools.length === 0
        ? undefined
        : yield* Effect.forEach(projected.tools, (tool) =>
            tool.native !== undefined && adapter.nativeTool
              ? adapter.nativeTool(tool.native)
              : lowerTool(
                  adapter.name,
                  tool,
                  ToolSchemaProjection.modelCompatibility(tool.inputSchema, toolSchemaCompatibility),
                ),
          ),
    tool_choice:
      allowedToolChoice(request) ??
      (request.toolChoice ? yield* lowerToolChoice(adapter.name, request.toolChoice) : undefined),
  }
})

const decodeBody = ProviderShared.validateWith(Schema.decodeUnknownEffect(OpenResponsesBody))

export const fromRequest = Effect.fn("OpenResponses.fromRequest")(function* (request: LLMRequest) {
  return yield* decodeBody(yield* fromRequestWithAdapter(request, BASE_ADAPTER))
})

// =============================================================================
// Stream Parsing
// =============================================================================
// Responses APIs report `input_tokens` (inclusive total) with a
// cached-read and cache-write subsets, and `output_tokens` (inclusive total)
// with a `reasoning_tokens` subset. Pass the totals through and derive the
// non-cached breakdown.
export const mapUsage = (usage: OpenResponsesUsage | null | undefined, providerMetadataKey: string) => {
  if (!usage) return undefined
  const cached = usage.input_tokens_details?.cached_tokens
  const cacheWrite = usage.input_tokens_details?.cache_write_tokens
  const reasoning = usage.output_tokens_details?.reasoning_tokens
  const nonCached = ProviderShared.subtractTokens(usage.input_tokens, ProviderShared.sumTokens(cached, cacheWrite))
  return new Usage({
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    nonCachedInputTokens: nonCached,
    cacheReadInputTokens: cached,
    cacheWriteInputTokens: cacheWrite,
    reasoningTokens: reasoning,
    totalTokens: ProviderShared.totalTokens(usage.input_tokens, usage.output_tokens, usage.total_tokens),
    providerMetadata: { [providerMetadataKey]: usage },
  })
}

const mapFinishReason = (event: Event, hasFunctionCall: boolean): FinishReason => {
  const reason = event.response?.incomplete_details?.reason
  if (reason === undefined || reason === null) {
    if (hasFunctionCall) return "tool-calls"
    if (event.type === "response.incomplete") return "unknown"
    return "stop"
  }
  if (reason === "max_output_tokens") return "length"
  if (reason === "content_filter") return "content-filter"
  return hasFunctionCall ? "tool-calls" : "unknown"
}

export const metadataKey = (model: LLMRequest["model"]) => model.route.providerMetadataKey ?? "openresponses"

export const providerMetadata = (state: ParserState, metadata: Record<string, unknown>): ProviderMetadata => ({
  [state.providerMetadataKey]: metadata,
})

export type StepResult = readonly [ParserState, ReadonlyArray<LLMEvent>]

const NO_EVENTS: StepResult["1"] = []

// `response.completed` / `response.incomplete` are clean finishes that emit a
// `finish` event; `response.failed` and `error` are hard failures. All four end
// the stream, so keep this set aligned with `step` and the protocol's terminal predicate.
const TERMINAL_TYPES = new Set(["error", "response.completed", "response.incomplete", "response.failed"])
export const terminal = (event: Event) => TERMINAL_TYPES.has(event.type)

const onOutputTextDelta = (state: ParserState, event: Event, id: string): StepResult => {
  if (!event.delta || state.message?.id !== id) return [state, NO_EVENTS]
  const events: LLMEvent[] = []
  const phase = state.message.phase
  const metadata = providerMetadata(state, { itemId: id, ...(phase === undefined ? {} : { phase }) })
  const lifecycle = Lifecycle.textStart(state.lifecycle, events, id, metadata)
  return [{ ...state, lifecycle: Lifecycle.textDelta(lifecycle, events, id, event.delta) }, events]
}

const onOutputTextDone = (state: ParserState, event: Event, id: string): StepResult => {
  if (state.message?.id === id) {
    if (state.lifecycle.text.has(id) || event.text === undefined) return [state, NO_EVENTS]
    return onOutputTextDelta(state, { ...event, delta: event.text }, id)
  }
  const events: LLMEvent[] = []
  return [{ ...state, lifecycle: Lifecycle.textEnd(state.lifecycle, events, id) }, events]
}

const decodeMessagePart = Schema.decodeUnknownOption(
  Schema.Union([OpenResponsesOutputText, Schema.Struct({ type: Schema.tag("refusal"), refusal: Schema.String })]),
)

const decodeSummaryPart = Schema.decodeUnknownOption(OpenResponsesReasoningSummaryText)

const decodeReasoningPart = Schema.decodeUnknownOption(
  Schema.Struct({ type: Schema.tag("reasoning_text"), text: Schema.String }),
)

const joinReasoningText = (parts: ReadonlyArray<string | undefined>) => {
  if (!parts.some((part) => part !== undefined && part.length > 0)) return undefined
  return parts.filter((part) => part !== undefined).join("\n\n")
}

const outputItemID = (state: Pick<ParserState, "outputItems">, event: Event) =>
  event.output_index === undefined ? event.item_id : (state.outputItems[event.output_index] ?? event.item_id)

const ITEM_ID_PREFIX: Readonly<Record<string, string>> = {
  message: "msg",
  reasoning: "rs",
  function_call: "fc",
  compaction: "cmp",
}

// An item without an id adopts the id already open in its output slot,
// otherwise it gets a locally minted one.
const resolveItem = (
  state: Pick<ParserState, "outputItems">,
  item: StreamItem,
  index: number | undefined,
): OutputItem => ({
  ...item,
  id:
    item.id ??
    (index === undefined ? undefined : state.outputItems[index]) ??
    `${ITEM_ID_PREFIX[item.type] ?? "item"}_${crypto.randomUUID().replaceAll("-", "")}`,
})

// Registered output slots are authoritative for `item_id` routing, and items
// are resolved here so everything downstream can rely on `item.id`.
export const normalize = (state: Pick<ParserState, "outputItems">, input: Event): NormalizedEvent => ({
  ...input,
  item_id: input.item_id === undefined ? undefined : outputItemID(state, input),
  item: input.item ? resolveItem(state, input.item, input.output_index) : input.item,
})

const startReasoningSummaryPart = (state: ParserState, itemID: string, index: number): StepResult => {
  const item = state.reasoningItems[itemID]
  if (!item || index === 0 || item.summaryParts[index] !== undefined) return [state, NO_EVENTS]

  const events: LLMEvent[] = []
  const lifecycle = Object.entries(item.summaryParts)
    .filter((entry) => entry[1] !== "concluded")
    .reduce(
      (lifecycle, entry) =>
        Lifecycle.reasoningEnd(lifecycle, events, `${itemID}:${entry[0]}`, providerMetadata(state, { itemId: itemID })),
      state.lifecycle,
    )
  return [
    {
      ...state,
      lifecycle: Lifecycle.reasoningStart(
        lifecycle,
        events,
        `${itemID}:${index}`,
        providerMetadata(state, { itemId: itemID, reasoningEncryptedContent: item.encryptedContent ?? null }),
      ),
      reasoningItems: {
        ...state.reasoningItems,
        [itemID]: {
          ...item,
          summaryParts: {
            ...Object.fromEntries(
              Object.entries(item.summaryParts).map((entry) =>
                entry[1] === "concluded" ? entry : [entry[0], "concluded" as const],
              ),
            ),
            [index]: "active",
          },
        },
      },
    },
    events,
  ]
}

export const onReasoningDelta = (state: ParserState, event: Event, itemID: string): StepResult => {
  const item = state.reasoningItems[itemID]
  if (!event.delta || !item) return [state, NO_EVENTS]
  const index = event.summary_index ?? 0
  if (item.summaryParts[index] === "concluded") return [state, NO_EVENTS]
  const [started, emitted] = startReasoningSummaryPart(state, itemID, index)
  const current = started.reasoningItems[itemID]
  if (!current) return [started, emitted]
  const events: LLMEvent[] = [...emitted]
  return [
    {
      ...started,
      lifecycle: Lifecycle.reasoningDelta(started.lifecycle, events, `${itemID}:${index}`, event.delta),
      reasoningItems: {
        ...started.reasoningItems,
        [itemID]: { ...current, deltaIndexes: new Set([...current.deltaIndexes, index]) },
      },
    },
    events,
  ]
}

// Some compatible gateways emit a reasoning final without streaming any
// deltas, mirroring `response.output_text.done`. Reconcile the complete text
// as a single delta unless that summary index already streamed one.
export const onReasoningDone = (state: ParserState, event: Event, itemID: string): StepResult => {
  const item = state.reasoningItems[itemID]
  if (!item || typeof event.text !== "string") return [state, NO_EVENTS]
  const index = event.summary_index ?? 0
  if (item.deltaIndexes.has(index)) return [state, NO_EVENTS]
  return onReasoningDelta(state, { ...event, delta: event.text }, itemID)
}

const reasoningMetadata = (state: ParserState, item: OutputItem) =>
  providerMetadata(state, { itemId: item.id, reasoningEncryptedContent: item.encrypted_content ?? null })

// Responses APIs normally stream reasoning items in this order:
//   `output_item.added` (reasoning) →
//     `reasoning_summary_part.added` (index=0) →
//     `reasoning_summary_text.delta` →
//     `reasoning_summary_part.done` (index=0) →
//     (repeat for index>0) →
//   `output_item.done` (reasoning).
// `onOutputItemAdded` seeds the per-item entry, while each later part start is
// also an implicit boundary for the previous part. This keeps the common event
// lifecycle ordered when a compatible provider omits or delays a part-done event.
const onOutputItemAdded = (state: ParserState, event: NormalizedEvent): StepResult => {
  const item = event.item
  if (!item) return [state, NO_EVENTS]
  if (item.type === "message") {
    const phase = messagePhase(item.phase)
    // A new message closes earlier messages, including ones that never streamed.
    const events: LLMEvent[] = []
    const lifecycle = [...state.lifecycle.text]
      .filter((id) => id !== item.id)
      .reduce((lifecycle, id) => {
        const openPhase = state.message?.id === id ? state.message.phase : undefined
        return Lifecycle.textEnd(
          lifecycle,
          events,
          id,
          providerMetadata(state, { itemId: id, ...(openPhase === undefined ? {} : { phase: openPhase }) }),
        )
      }, state.lifecycle)
    return [
      {
        ...state,
        lifecycle,
        message: {
          id: item.id,
          phase: phase === undefined && state.message?.id === item.id ? state.message.phase : phase,
        },
      },
      events,
    ]
  }
  if (item.type === "reasoning") {
    if (state.reasoningItems[item.id] !== undefined) return [state, NO_EVENTS]
    const events: LLMEvent[] = []
    return [
      {
        ...state,
        lifecycle: Lifecycle.reasoningStart(state.lifecycle, events, `${item.id}:0`, reasoningMetadata(state, item)),
        reasoningItems: {
          ...state.reasoningItems,
          [item.id]: {
            encryptedContent: item.encrypted_content,
            summaryParts: { 0: "active" },
            deltaIndexes: new Set(),
          },
        },
      },
      events,
    ]
  }
  if (item.type !== "function_call" || !item.call_id) return [state, NO_EVENTS]
  if (state.tools[item.id] !== undefined) return [state, NO_EVENTS]
  const metadata = providerMetadata(state, { itemId: item.id })
  const events: LLMEvent[] = []
  const lifecycle = Lifecycle.stepStart(state.lifecycle, events)
  return [
    {
      ...state,
      lifecycle,
      tools: ToolStream.start(state.tools, item.id, {
        id: item.call_id,
        name: item.name ?? "",
        namespace: item.namespace,
        input: item.arguments ?? "",
        providerMetadata: metadata,
      }),
    },
    [
      ...events,
      LLMEvent.toolInputStart({
        id: item.call_id,
        name: item.name ?? "",
        namespace: item.namespace,
        providerMetadata: metadata,
      }),
    ],
  ]
}

const onReasoningSummaryPartAdded = (state: ParserState, event: Event): StepResult => {
  if (event.item_id === undefined || event.summary_index === undefined) return [state, NO_EVENTS]
  return startReasoningSummaryPart(state, event.item_id, event.summary_index)
}

const onReasoningSummaryPartDone = (state: ParserState, event: Event): StepResult => {
  if (event.item_id === undefined || event.summary_index === undefined) return [state, NO_EVENTS]
  const item = state.reasoningItems[event.item_id]
  if (!item) return [state, NO_EVENTS]
  if (item.summaryParts[event.summary_index] !== "active") return [state, NO_EVENTS]
  return [
    {
      ...state,
      reasoningItems: {
        ...state.reasoningItems,
        [event.item_id]: {
          ...item,
          summaryParts: {
            ...item.summaryParts,
            [event.summary_index]: "can-conclude",
          },
        },
      },
    },
    NO_EVENTS,
  ]
}

const onFunctionCallArgumentsDelta = Effect.fn("OpenResponses.onFunctionCallArgumentsDelta")(function* (
  state: ParserState,
  event: Event,
) {
  if (event.item_id === undefined) return [state, NO_EVENTS] satisfies StepResult
  const tool = state.tools[event.item_id]
  if (!tool) return [state, NO_EVENTS] satisfies StepResult
  const final = event.type === "response.function_call_arguments.done" ? event.arguments : undefined
  if (event.type === "response.function_call_arguments.done" && final === undefined)
    return [state, NO_EVENTS] satisfies StepResult
  if (final !== undefined && !final.startsWith(tool.input))
    return [
      { ...state, tools: ToolStream.start(state.tools, event.item_id, { ...tool, input: final }) },
      NO_EVENTS,
    ] satisfies StepResult
  const delta = final === undefined ? event.delta : final.slice(tool.input.length)
  if (!delta) return [state, NO_EVENTS] satisfies StepResult
  const result = ToolStream.appendExisting(
    state.id,
    state.tools,
    event.item_id,
    delta,
    `${state.name} tool argument delta is missing its tool call`,
  )
  if (ToolStream.isError(result)) return yield* result
  const events: LLMEvent[] = []
  const lifecycle = result.events.length ? Lifecycle.stepStart(state.lifecycle, events) : state.lifecycle
  events.push(...result.events)
  return [{ ...state, lifecycle, tools: result.tools }, events] satisfies StepResult
})

const onOutputItemDone = Effect.fn("OpenResponses.onOutputItemDone")(function* (
  state: ParserState,
  item: NormalizedEvent["item"],
) {
  if (!item) return [state, NO_EVENTS] satisfies StepResult

  if (item.type === "compaction") {
    if (typeof item.encrypted_content !== "string")
      return yield* ProviderShared.eventError(state.id, "Compaction output is missing its encrypted content")
    if (state.completedCompactions.has(item.id)) return [state, NO_EVENTS] satisfies StepResult
    const events: LLMEvent[] = []
    const lifecycle = Lifecycle.stepStart(state.lifecycle, events)
    events.push(
      LLMEvent.compaction({
        provider: state.provider,
        id: item.id,
        encrypted: item.encrypted_content,
      }),
    )
    return [
      { ...state, lifecycle, completedCompactions: new Set([...state.completedCompactions, item.id]) },
      events,
    ] satisfies StepResult
  }

  if (item.type === "message") {
    const active = state.message?.id === item.id
    const itemPhase = messagePhase(item.phase)
    const phase = itemPhase === undefined && active ? state.message?.phase : itemPhase
    const parts: ReadonlyArray<unknown> = Array.isArray(item.content) ? item.content : []
    const content: string[] = []
    for (const part of parts) {
      const decoded = Option.getOrUndefined(decodeMessagePart(part))
      if (!decoded) continue
      content.push(decoded.type === "output_text" ? decoded.text : decoded.refusal)
    }
    const text = content.length > 0 ? content.join("") : undefined
    const metadata = providerMetadata(state, { itemId: item.id, ...(phase === undefined ? {} : { phase }) })
    const events: LLMEvent[] = []
    const lifecycle = text ? Lifecycle.textStart(state.lifecycle, events, item.id, metadata) : state.lifecycle
    return [
      {
        ...state,
        lifecycle: Lifecycle.textEnd(lifecycle, events, item.id, metadata, text),
        message: active ? undefined : state.message,
      },
      events,
    ] satisfies StepResult
  }

  if (item.type === "function_call") {
    if (!item.call_id || !item.name) return [state, NO_EVENTS] satisfies StepResult
    const metadata = providerMetadata(state, { itemId: item.id })
    const registered = state.tools[item.id] !== undefined
    const tools = registered
      ? state.tools
      : ToolStream.start(state.tools, item.id, {
          id: item.call_id,
          name: item.name,
          namespace: item.namespace,
          providerMetadata: metadata,
        })
    const result =
      item.arguments === undefined
        ? yield* ToolStream.finish(state.id, tools, item.id)
        : yield* ToolStream.finishWithInput(state.id, tools, item.id, item.arguments)
    const events: LLMEvent[] = []
    const finished = result.events ?? []
    // A done-only call never streamed a start event, so open its lifecycle here.
    const resultEvents =
      registered || finished.length === 0
        ? finished
        : [
            LLMEvent.toolInputStart({
              id: item.call_id,
              name: item.name,
              namespace: item.namespace,
              providerMetadata: metadata,
            }),
            ...finished,
          ]
    const lifecycle = resultEvents.length ? Lifecycle.stepStart(state.lifecycle, events) : state.lifecycle
    events.push(...resultEvents)
    return [
      {
        ...state,
        lifecycle,
        hasFunctionCall:
          resultEvents.some((event) => LLMEvent.is.toolCall(event) || LLMEvent.is.toolInputError(event)) ||
          state.hasFunctionCall,
        tools: result.tools,
      },
      events,
    ] satisfies StepResult
  }

  if (item.type === "reasoning") {
    const metadata = reasoningMetadata(state, item)
    const summaryParts: ReadonlyArray<unknown> = Array.isArray(item.summary) ? item.summary : []
    const summary: Array<string | undefined> = []
    for (const part of summaryParts) {
      const decoded = Option.getOrUndefined(decodeSummaryPart(part))
      // Keep missing entries so the array still matches the provider's summary indexes.
      summary.push(decoded?.text)
    }
    const reasoningParts: ReadonlyArray<unknown> = Array.isArray(item.content) ? item.content : []
    const content: string[] = []
    for (const part of reasoningParts) {
      const decoded = Option.getOrUndefined(decodeReasoningPart(part))
      if (decoded) content.push(decoded.text)
    }
    const itemText = joinReasoningText(summary) ?? joinReasoningText(content)
    const events: LLMEvent[] = []
    const reasoningItem = state.reasoningItems[item.id]
    if (reasoningItem) {
      const fragments = Object.entries(reasoningItem.summaryParts)
      let lifecycle = state.lifecycle
      for (const [index, status] of fragments) {
        if (status === "concluded") continue
        // Do not repeat earlier summaries that were already emitted as separate fragments.
        const finalText = fragments.length === 1 ? itemText : summary[Number(index)]
        lifecycle = Lifecycle.reasoningEnd(lifecycle, events, `${item.id}:${index}`, metadata, finalText || undefined)
      }
      const reasoningItems = { ...state.reasoningItems }
      delete reasoningItems[item.id]
      return [{ ...state, lifecycle, reasoningItems }, events] satisfies StepResult
    }
    const lifecycle = Lifecycle.stepStart(state.lifecycle, events)
    events.push(LLMEvent.reasoningStart({ id: item.id, providerMetadata: metadata }))
    events.push(LLMEvent.reasoningEnd({ id: item.id, providerMetadata: metadata, text: itemText }))
    return [{ ...state, lifecycle }, events] satisfies StepResult
  }

  return [state, NO_EVENTS] satisfies StepResult
})

const onResponseFinish = Effect.fn("OpenResponses.onResponseFinish")(function* (state: ParserState, event: Event) {
  let current = state
  const events: LLMEvent[] = []
  if (event.type === "response.completed") {
    // An output item's array position is its output index.
    for (const item of (event.response?.output ?? []).map((item, index) => resolveItem(state, item, index))) {
      // Terminal recovery cannot insert a checkpoint before already-emitted content.
      if (item.type === "compaction" && state.lifecycle.stepStarted && !state.completedCompactions.has(item.id))
        return yield* ProviderShared.eventError(
          state.id,
          "Cannot recover a compaction checkpoint after output has been emitted",
        )
      const recoverable =
        item.type === "compaction" || (item.type === "function_call" && current.tools[item.id] !== undefined)
      if (!recoverable) continue
      const [next, emitted] = yield* onOutputItemDone(current, item)
      current = next
      events.push(...emitted)
    }
    // Some compatible providers omit output_item.done even after completing the response.
    const pending = yield* ToolStream.finishAll(current.id, current.tools)
    current = {
      ...current,
      tools: pending.tools,
      hasFunctionCall:
        current.hasFunctionCall ||
        pending.events.some((event) => LLMEvent.is.toolCall(event) || LLMEvent.is.toolInputError(event)),
    }
    events.push(...pending.events)
  }
  const lifecycle = Lifecycle.finish(current.lifecycle, events, {
    reason: {
      normalized: mapFinishReason(event, current.hasFunctionCall),
      raw: event.response?.incomplete_details?.reason,
    },
    usage: mapUsage(event.response?.usage, current.providerMetadataKey),
    providerMetadata:
      event.response?.id || event.response?.service_tier
        ? providerMetadata(current, {
            responseId: event.response.id,
            serviceTier: event.response.service_tier,
          })
        : undefined,
  })
  return [{ ...current, lifecycle }, events] satisfies StepResult
})

// Build the prettiest summary available from whatever the provider supplied.
// When both code and message are present, prefix the code so consumers see
// the failure mode (e.g. `rate_limit_exceeded: Slow down`) instead of just
// the bare message — production rate limits and context-length failures used
// to be indistinguishable from generic stream drops. Returns undefined when
// the payload carries no usable summary.
const providerErrorMessage = (event: Event, nested: OpenResponsesErrorPayload | undefined): string | undefined => {
  const message = event.message || nested?.message || undefined
  const code = event.code || nested?.code || undefined
  if (message && code) return `${code}: ${message}`
  return message || code
}

export const providerFailure = (event: Event, fallback: string, body = ProviderShared.encodeJson(event)) => {
  const nested = event.error ?? event.response?.error ?? undefined
  const summary = providerErrorMessage(event, nested)
  const message = summary ?? (body === "{}" ? fallback : body)
  const status =
    typeof event.status === "number"
      ? event.status
      : typeof event.status_code === "number"
        ? event.status_code
        : undefined
  const reason =
    event.type === "error" &&
    event.error === undefined &&
    event.response === undefined &&
    summary === undefined &&
    status === undefined
      ? new ProviderInternalError({ message, body })
      : classifyProviderFailure({ message, status, rawBody: body })
  return new AIError({ reason })
}

// Callers must pass events through `normalize` first. The OpenAPI requires
// string IDs but imposes no minLength; empty is not missing.
export const step = (state: ParserState, event: NormalizedEvent) => {
  if (event.type === "response.output_text.delta" || event.type === "response.output_text.done") {
    if (event.item_id === undefined) return ProviderShared.eventError(state.id, `${event.type} is missing item_id`)
    return Effect.succeed(
      event.type === "response.output_text.delta"
        ? onOutputTextDelta(state, event, event.item_id)
        : onOutputTextDone(state, event, event.item_id),
    )
  }
  if (event.type === "response.refusal.delta" || event.type === "response.refusal.done") {
    const value = event.type === "response.refusal.delta" ? event.delta : event.refusal
    if (event.item_id === undefined || typeof value !== "string")
      return ProviderShared.eventError(state.id, `${event.type} is malformed`)
    return Effect.succeed(
      event.type === "response.refusal.delta"
        ? onOutputTextDelta(state, event, event.item_id)
        : onOutputTextDone(state, { ...event, text: value }, event.item_id),
    )
  }
  if (event.type === "response.reasoning.delta" || event.type === "response.reasoning_summary_text.delta") {
    if (event.item_id === undefined) return ProviderShared.eventError(state.id, `${event.type} is missing item_id`)
    return Effect.succeed(onReasoningDelta(state, event, event.item_id))
  }
  if (
    event.type === "response.reasoning.done" ||
    event.type === "response.reasoning_summary_text.done" ||
    event.type === "response.reasoning_text.done"
  ) {
    if (event.item_id === undefined) return ProviderShared.eventError(state.id, `${event.type} is missing item_id`)
    return Effect.succeed(onReasoningDone(state, event, event.item_id))
  }
  if (event.type === "response.reasoning_summary_part.added")
    return event.item_id !== undefined
      ? Effect.succeed(onReasoningSummaryPartAdded(state, event))
      : ProviderShared.eventError(state.id, `${event.type} is missing item_id`)
  if (event.type === "response.reasoning_summary_part.done")
    return event.item_id !== undefined
      ? Effect.succeed(onReasoningSummaryPartDone(state, event))
      : ProviderShared.eventError(state.id, `${event.type} is missing item_id`)
  if (event.type === "response.output_item.added") {
    if (
      event.item?.type === "reasoning" &&
      state.reasoningItems[event.item.id] === undefined &&
      state.lifecycle.reasoning.size > 0
    )
      return ProviderShared.eventError(state.id, `${event.type} started reasoning before the previous item ended`)
    return Effect.succeed(
      onOutputItemAdded(
        event.output_index !== undefined && event.item
          ? { ...state, outputItems: { ...state.outputItems, [event.output_index]: event.item.id } }
          : state,
        event,
      ),
    )
  }
  if (event.type === "response.function_call_arguments.delta" || event.type === "response.function_call_arguments.done")
    return event.item_id !== undefined
      ? onFunctionCallArgumentsDelta(state, event)
      : ProviderShared.eventError(state.id, `${event.type} is missing item_id`)
  if (event.type === "response.output_item.done") return onOutputItemDone(state, event.item)
  if (event.type === "response.completed" || event.type === "response.incomplete") return onResponseFinish(state, event)
  if (event.type === "response.failed") return providerFailure(event, `${state.name} response failed`)
  if (event.type === "error")
    return decodeKnownErrorEvent(event).pipe(
      Effect.mapError((cause) =>
        ProviderShared.eventError(
          state.id,
          `${state.name} returned a malformed error event`,
          ProviderShared.encodeJson(event),
          cause,
        ),
      ),
      Effect.flatMap(() => providerFailure(event, `${state.name} stream error`)),
    )
  return Effect.succeed<StepResult>([state, NO_EVENTS])
}

// =============================================================================
// Protocol
// =============================================================================
/**
 * The provider-neutral Open Responses protocol. Provider-specific Responses
 * implementations compose this baseline with their own tools and event variants.
 */
export const initial = (request: LLMRequest, adapter: ProviderAdapter = BASE_ADAPTER): ParserState => ({
  provider: request.model.provider,
  completedCompactions: new Set<string>(),
  id: adapter.id,
  name: adapter.name,
  providerMetadataKey: metadataKey(request.model),
  hasFunctionCall: false,
  tools: ToolStream.empty<string>(),
  lifecycle: Lifecycle.initial(),
  outputItems: {},
  message: undefined,
  reasoningItems: {},
})

export const protocol = Protocol.make({
  id: ADAPTER,
  body: {
    schema: OpenResponsesBody,
    from: fromRequest,
  },
  stream: {
    event: Protocol.jsonEvent(Event),
    initial,
    step: (state: ParserState, event: Event) => step(state, normalize(state, event)),
    terminal,
  },
})

export const httpTransport = HttpTransport.sseJson.with<OpenResponsesBody>()

export * as OpenResponses from "./open-responses.js"
