import { Buffer } from "node:buffer"
import { Effect, Option, Schema } from "effect"
import { Tool } from "@opencode/schema/tool"
import { Route } from "../route/client.js"
import { Auth } from "../route/auth.js"
import { Endpoint } from "../route/endpoint.js"
import { Framing } from "../route/framing.js"
import { Protocol } from "../route/protocol.js"
import { Headers } from "effect/unstable/http"
import { HttpTransport } from "../route/transport/index.js"
import {
  AIError,
  HttpOptions,
  LLMRequest,
  LLMEvent,
  mergeJsonRecords,
  Usage,
  type CacheHint,
  type FinishReasonDetails,
  type FinishReason,
  type JsonSchema,
  type MediaPart,
  type ProviderMetadata,
  type ToolCallPart,
  type ToolDefinition,
  type ToolResultPart,
} from "../schema/index.js"
import { JsonObject, optionalArray, optionalNull, ProviderShared } from "./shared.js"
import { classifyProviderFailure } from "../provider-error.js"
import * as Cache from "./utils/cache.js"
import { Lifecycle } from "./utils/lifecycle.js"
import { ToolSchemaProjection } from "./utils/tool-schema.js"
import { ToolStream } from "./utils/tool-stream.js"

const ADAPTER = "anthropic-messages"
export const DEFAULT_BASE_URL = "https://api.anthropic.com/v1"
export const PATH = "/messages"
export const DEFAULT_MAX_TOKENS = 32_000

const SSE_EVENTS = new Set([
  "message",
  "message_start",
  "message_delta",
  "message_stop",
  "content_block_start",
  "content_block_delta",
  "content_block_stop",
  "ping",
  "error",
])
export const framing = Framing.sseEvents(SSE_EVENTS)

export type ThinkingBlockBinding = {
  readonly prefix_mismatch_behavior?: "error" | "drop_block" | (string & {})
}

export type ThinkingInput =
  | {
      readonly type: "adaptive"
      readonly display?: "summarized" | "omitted"
      readonly block_binding?: ThinkingBlockBinding
    }
  | {
      readonly type: "disabled"
    }
  | ({
      readonly type: "enabled"
      readonly display?: "summarized" | "omitted"
      readonly block_binding?: ThinkingBlockBinding
    } & (
      | { readonly budgetTokens: number; readonly budget_tokens?: number }
      | { readonly budgetTokens?: number; readonly budget_tokens: number }
    ))

export interface OptionsInput {
  /** Advanced in-band compaction. The caller owns checkpoint persistence and recovery. */
  readonly contextManagement?: ContextManagement
  readonly [key: string]: unknown
  readonly thinking?: ThinkingInput
  readonly effort?: string
  readonly service_tier?: "auto" | "standard_only"
  readonly serviceTier?: "auto" | "standard_only"
  // SDK Metadata:2649 {user_id?: string | null}
  readonly metadata?: { readonly user_id?: string | null }
  // SDK MessageCreateParamsContainer:2596 ContainerParams|string
  readonly container?:
    | string
    | { readonly id?: string | null; readonly skills?: ReadonlyArray<Record<string, unknown>> | null }
  readonly inference_geo?: string | null
  readonly inferenceGeo?: string | null
  readonly cache_control?: { readonly type: "ephemeral"; readonly ttl?: "5m" | "1h" }
  readonly cacheControl?: { readonly type: "ephemeral"; readonly ttl?: "5m" | "1h" }
  // SDK OutputConfig:2684 {effort, format: JSONOutputFormat}
  readonly output_config?: {
    readonly effort?: string | null
    readonly format?: { readonly type: "json_schema"; readonly schema: Record<string, unknown> } | null
  }
  readonly outputConfig?: {
    readonly effort?: string | null
    readonly format?: { readonly type: "json_schema"; readonly schema: Record<string, unknown> } | null
  }
}

export type ProviderOptionsInput = OptionsInput

export const ContextManagement = Schema.Struct({
  edits: Schema.Array(
    Schema.Struct({
      type: Schema.Literal("compact_20260112"),
      trigger: Schema.optional(
        Schema.Struct({
          type: Schema.Literal("input_tokens"),
          value: Schema.Int.check(Schema.isGreaterThanOrEqualTo(50000)),
        }),
      ),
      pauseAfterCompaction: Schema.optional(Schema.Boolean),
      instructions: Schema.optional(Schema.String),
    }),
  ),
})
export type ContextManagement = typeof ContextManagement.Type

// =============================================================================
// Request Body Schema
// =============================================================================
const AnthropicCacheControl = Schema.Struct({
  type: Schema.tag("ephemeral"),
  ttl: Schema.optional(Schema.Literals(["5m", "1h"])),
})

const AnthropicTextBlock = Schema.Struct({
  type: Schema.tag("text"),
  text: Schema.String,
  cache_control: Schema.optional(AnthropicCacheControl),
})
type AnthropicTextBlock = Schema.Schema.Type<typeof AnthropicTextBlock>

// SDK: Base64ImageSource:201 {type:"base64", media_type:"image/jpeg"|... , data}, URLImageSource:3817 {type:"url", url}, FileImageSource:2350 {type:"file", file_id}
// SDK: ImageBlockParam:2356 {source: Base64|URL|File, cache_control, transformations:2381 {oversized_image?}}
const AnthropicBase64ImageSource = Schema.Struct({
  type: Schema.tag("base64"),
  media_type: Schema.String,
  data: Schema.String,
})
const AnthropicURLImageSource = Schema.Struct({ type: Schema.tag("url"), url: Schema.String })
const AnthropicFileImageSource = Schema.Struct({ type: Schema.tag("file"), file_id: Schema.String })
const AnthropicImageSource = Schema.Union([
  AnthropicBase64ImageSource,
  AnthropicURLImageSource,
  AnthropicFileImageSource,
])
const AnthropicImageTransformations = Schema.Struct({
  oversized_image: Schema.optional(Schema.Literals(["downsize", "error"])),
})

const AnthropicImageBlock = Schema.Struct({
  type: Schema.tag("image"),
  source: AnthropicImageSource,
  cache_control: Schema.optional(AnthropicCacheControl),
  transformations: Schema.optional(AnthropicImageTransformations),
})
type AnthropicImageBlock = Schema.Schema.Type<typeof AnthropicImageBlock>

// SDK: Base64PDFSource:209 {type:"base64", media_type:"application/pdf", data}, PlainTextSource:2716 {type:"text", media_type:"text/plain", data},
// SDK: URLPDFSource:3823 {type:"url", url}, FileDocumentSource:2344 {type:"file", file_id}, ContentBlockSource:2266 {type:"content", content}
// SDK: DocumentBlockParam:2297 {source: 5-way union, cache_control, citations, context, title}
const AnthropicBase64PDFSource = Schema.Struct({
  type: Schema.tag("base64"),
  media_type: Schema.Literal("application/pdf"),
  data: Schema.String,
})
const AnthropicPlainTextSource = Schema.Struct({
  type: Schema.tag("text"),
  media_type: Schema.Literal("text/plain"),
  data: Schema.String,
})
const AnthropicURLPDFSource = Schema.Struct({ type: Schema.tag("url"), url: Schema.String })
const AnthropicFileDocumentSource = Schema.Struct({ type: Schema.tag("file"), file_id: Schema.String })
const AnthropicDocumentSource = Schema.Union([
  AnthropicBase64PDFSource,
  AnthropicPlainTextSource,
  AnthropicURLPDFSource,
  AnthropicFileDocumentSource,
])

const AnthropicDocumentBlock = Schema.Struct({
  type: Schema.tag("document"),
  source: AnthropicDocumentSource,
  cache_control: Schema.optional(AnthropicCacheControl),
  title: Schema.optional(Schema.String),
  context: Schema.optional(Schema.String),
  citations: Schema.optional(Schema.Struct({ enabled: Schema.Boolean })),
})
type AnthropicDocumentBlock = Schema.Schema.Type<typeof AnthropicDocumentBlock>

const AnthropicThinkingBlock = Schema.Struct({
  type: Schema.tag("thinking"),
  thinking: Schema.String,
  signature: Schema.String,
  cache_control: Schema.optional(AnthropicCacheControl),
})

// Safety-filtered thinking arrives as an opaque encrypted `data` payload with
// no visible text. It must round-trip verbatim so multi-turn thinking + tool
// use conversations keep their reasoning continuity.
const AnthropicRedactedThinkingBlock = Schema.Struct({
  type: Schema.tag("redacted_thinking"),
  data: Schema.String,
  cache_control: Schema.optional(AnthropicCacheControl),
})

const AnthropicToolUseBlock = Schema.Struct({
  type: Schema.tag("tool_use"),
  id: Schema.String,
  name: Schema.String,
  input: Schema.Unknown,
  cache_control: Schema.optional(AnthropicCacheControl),
})
type AnthropicToolUseBlock = Schema.Schema.Type<typeof AnthropicToolUseBlock>

const AnthropicServerToolUseBlock = Schema.Struct({
  type: Schema.tag("server_tool_use"),
  id: Schema.String,
  name: Schema.String,
  input: Schema.Unknown,
  cache_control: Schema.optional(AnthropicCacheControl),
})
type AnthropicServerToolUseBlock = Schema.Schema.Type<typeof AnthropicServerToolUseBlock>

// Server tool result blocks: web_search_tool_result, code_execution_tool_result,
// and web_fetch_tool_result. The provider executes the tool and inlines the
// structured result into the assistant turn — there is no client tool_result
// round-trip. We round-trip the structured `content` payload as opaque JSON so
// the next request can echo it back when continuing the conversation.
const AnthropicServerToolResultType = Schema.Literals([
  "web_search_tool_result",
  "code_execution_tool_result",
  "web_fetch_tool_result",
])
type AnthropicServerToolResultType = Schema.Schema.Type<typeof AnthropicServerToolResultType>

const AnthropicServerToolResultBlock = Schema.Struct({
  type: AnthropicServerToolResultType,
  tool_use_id: Schema.String,
  content: Schema.Unknown,
  cache_control: Schema.optional(AnthropicCacheControl),
})
type AnthropicServerToolResultBlock = Schema.Schema.Type<typeof AnthropicServerToolResultBlock>

// Anthropic accepts either a plain string or an ordered array of text, image, and
// document blocks inside `tool_result.content`. The array form keeps media as native
// model input instead of JSON-stringifying base64 into prompt text.
const AnthropicToolResultContent = Schema.Union([AnthropicTextBlock, AnthropicImageBlock, AnthropicDocumentBlock])

const AnthropicToolResultBlock = Schema.Struct({
  type: Schema.tag("tool_result"),
  tool_use_id: Schema.String,
  content: Schema.Union([Schema.String, Schema.Array(AnthropicToolResultContent)]),
  is_error: Schema.optional(Schema.Boolean),
  cache_control: Schema.optional(AnthropicCacheControl),
})

const AnthropicUserBlock = Schema.Union([
  AnthropicTextBlock,
  AnthropicImageBlock,
  AnthropicDocumentBlock,
  AnthropicToolResultBlock,
])
type AnthropicUserBlock = Schema.Schema.Type<typeof AnthropicUserBlock>
const AnthropicCompactionBlock = Schema.Struct({
  type: Schema.Literal("compaction"),
  content: Schema.NullOr(Schema.String),
})
const AnthropicAssistantBlock = Schema.Union([
  AnthropicCompactionBlock,
  AnthropicTextBlock,
  AnthropicThinkingBlock,
  AnthropicRedactedThinkingBlock,
  AnthropicToolUseBlock,
  AnthropicServerToolUseBlock,
  AnthropicServerToolResultBlock,
])
type AnthropicAssistantBlock = Schema.Schema.Type<typeof AnthropicAssistantBlock>
type AnthropicToolResultBlock = Schema.Schema.Type<typeof AnthropicToolResultBlock>

const AnthropicMessage = Schema.Union([
  Schema.Struct({ role: Schema.Literal("user"), content: Schema.Array(AnthropicUserBlock) }),
  Schema.Struct({ role: Schema.Literal("assistant"), content: Schema.Array(AnthropicAssistantBlock) }),
  Schema.Struct({ role: Schema.Literal("system"), content: Schema.Array(AnthropicTextBlock) }),
]).pipe(Schema.toTaggedUnion("role"))
type AnthropicMessage = Schema.Schema.Type<typeof AnthropicMessage>

const AnthropicTool = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  input_schema: JsonObject,
  cache_control: Schema.optional(AnthropicCacheControl),
})
type AnthropicTool = Schema.Schema.Type<typeof AnthropicTool>

const AnthropicToolChoice = Schema.Union([
  Schema.Struct({
    type: Schema.Literals(["auto", "any", "none"]),
    disable_parallel_tool_use: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({
    type: Schema.tag("tool"),
    name: Schema.String,
    disable_parallel_tool_use: Schema.optional(Schema.Boolean),
  }),
])

const AnthropicThinkingBlockBinding = Schema.Struct({
  prefix_mismatch_behavior: Schema.optional(Schema.String),
})

const AnthropicThinking = Schema.Union([
  Schema.Struct({
    type: Schema.tag("enabled"),
    budget_tokens: Schema.Number,
    display: Schema.optional(Schema.Literals(["summarized", "omitted"])),
    block_binding: Schema.optional(AnthropicThinkingBlockBinding),
  }),
  Schema.Struct({
    type: Schema.tag("adaptive"),
    display: Schema.optional(Schema.Literals(["summarized", "omitted"])),
    block_binding: Schema.optional(AnthropicThinkingBlockBinding),
  }),
  Schema.Struct({
    type: Schema.tag("disabled"),
  }),
])
type AnthropicThinking = typeof AnthropicThinking.Type

// SDK OutputConfig:2684 {effort?: "low"|"medium"|"high"|"xhigh"|"max"|null, format?: JSONOutputFormat:2399}
const AnthropicJsonOutputFormat = Schema.Struct({
  type: Schema.Literal("json_schema"),
  schema: JsonObject,
})
const AnthropicOutputConfig = Schema.Struct({
  effort: Schema.optional(Schema.String),
  format: Schema.optional(Schema.NullOr(AnthropicJsonOutputFormat)),
})

// SDK Metadata:2649 {user_id?: string|null}
const AnthropicMetadata = Schema.Struct({ user_id: optionalNull(Schema.String) })

// SDK MessageCreateParamsContainer:2596 ContainerParams|string; ContainerParams:2172 {id?, skills?}
const AnthropicContainer = Schema.Union([
  Schema.String,
  Schema.Struct({
    id: optionalNull(Schema.String),
    skills: optionalNull(Schema.Array(JsonObject)),
  }),
])

const AnthropicBodyFields = {
  context_management: Schema.optional(
    Schema.Struct({
      edits: Schema.Array(
        Schema.Struct({
          type: Schema.Literal("compact_20260112"),
          trigger: ContextManagement.fields.edits.value.fields.trigger,
          pause_after_compaction: Schema.optional(Schema.Boolean),
          instructions: Schema.optional(Schema.String),
        }),
      ),
    }),
  ),
  model: Schema.String,
  system: optionalArray(AnthropicTextBlock),
  messages: Schema.Array(AnthropicMessage),
  tools: optionalArray(AnthropicTool),
  tool_choice: Schema.optional(AnthropicToolChoice),
  stream: Schema.Literal(true),
  max_tokens: Schema.Number,
  temperature: Schema.optional(Schema.Number),
  top_p: Schema.optional(Schema.Number),
  top_k: Schema.optional(Schema.Number),
  stop_sequences: optionalArray(Schema.String),
  thinking: Schema.optional(AnthropicThinking),
  output_config: Schema.optional(AnthropicOutputConfig),
  // SDK top-level passthrough: cache_control:4638, container:4643, inference_geo:4649, metadata:4654, service_tier:4670
  cache_control: Schema.optional(AnthropicCacheControl),
  container: Schema.optional(Schema.NullOr(AnthropicContainer)),
  inference_geo: Schema.optional(Schema.NullOr(Schema.String)),
  metadata: Schema.optional(AnthropicMetadata),
  service_tier: Schema.optional(Schema.Literals(["auto", "standard_only"])),
}
export const AnthropicMessagesBody = Schema.Struct(AnthropicBodyFields)
export type AnthropicMessagesBody = Schema.Schema.Type<typeof AnthropicMessagesBody>

const AnthropicIterationUsage = Schema.StructWithRest(
  Schema.Struct({
    input_tokens: optionalNull(Schema.Number),
    output_tokens: Schema.optional(Schema.Number),
    cache_creation_input_tokens: optionalNull(Schema.Number),
    cache_read_input_tokens: optionalNull(Schema.Number),
    server_tool_use: optionalNull(
      Schema.StructWithRest(Schema.Struct({ web_search_requests: Schema.optional(Schema.Number) }), [
        Schema.Record(Schema.String, Schema.Unknown),
      ]),
    ),
    output_tokens_details: optionalNull(
      Schema.StructWithRest(Schema.Struct({ thinking_tokens: Schema.optional(Schema.Number) }), [
        Schema.Record(Schema.String, Schema.Unknown),
      ]),
    ),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
)
const AnthropicUsage = Schema.StructWithRest(
  Schema.Struct({
    ...AnthropicIterationUsage.schema.fields,
    iterations: Schema.optional(Schema.Array(AnthropicIterationUsage)),
  }),
  [JsonObject],
)
type AnthropicUsage = Schema.Schema.Type<typeof AnthropicUsage>

const AnthropicStreamBlock = Schema.Struct({
  type: Schema.String,
  id: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  text: Schema.optional(Schema.String),
  thinking: Schema.optional(Schema.String),
  signature: Schema.optional(Schema.String),
  // redacted_thinking blocks arrive whole in content_block_start with the
  // encrypted payload in `data`; there is no streaming delta sequence.
  data: Schema.optional(Schema.String),
  input: Schema.optional(Schema.Unknown),
  // *_tool_result blocks arrive whole as content_block_start (no streaming
  // delta) with the structured payload in `content` and the originating
  // server_tool_use id in `tool_use_id`.
  tool_use_id: Schema.optional(Schema.String),
  content: Schema.optional(Schema.Unknown),
})
type AnthropicStreamBlock = Schema.Schema.Type<typeof AnthropicStreamBlock>
const decodeAnthropicStreamBlock = Schema.decodeUnknownOption(AnthropicStreamBlock)

const AnthropicStreamDelta = Schema.Struct({
  content: optionalNull(Schema.String),
  type: Schema.optional(Schema.String),
  text: Schema.optional(Schema.String),
  thinking: Schema.optional(Schema.String),
  partial_json: Schema.optional(Schema.String),
  signature: Schema.optional(Schema.String),
  stop_reason: optionalNull(Schema.String),
  stop_sequence: optionalNull(Schema.String),
})
type AnthropicStreamDelta = Schema.Schema.Type<typeof AnthropicStreamDelta>
const decodeAnthropicStreamDelta = Schema.decodeUnknownOption(AnthropicStreamDelta)

const AnthropicEvent = Schema.Struct({
  type: Schema.String,
  index: Schema.optional(Schema.Number),
  message: Schema.optional(Schema.Struct({ usage: Schema.optional(AnthropicUsage) })),
  content_block: Schema.optional(Schema.Unknown),
  delta: Schema.optional(Schema.Unknown),
  usage: Schema.optional(AnthropicUsage),
  // `type` and `message` are both required per Anthropic's spec, but
  // OpenAI-compatible proxies and gateway translations occasionally drop one
  // or the other; mark them optional so a partial payload still parses and
  // the parser can fall back to whichever field is populated.
  error: Schema.optional(
    Schema.Struct({ type: Schema.optional(Schema.String), message: Schema.optional(Schema.String) }),
  ),
})
type AnthropicEvent = Schema.Schema.Type<typeof AnthropicEvent>

interface ParserState {
  readonly provider: LLMRequest["model"]["provider"]
  readonly compactions: Readonly<Record<number, string | null>>
  readonly providerMetadataKey: string
  readonly tools: ToolStream.State<number>
  readonly reasoningSignatures: Readonly<Record<number, string>>
  readonly usage?: Usage
  readonly pendingFinish?: {
    readonly reason: FinishReasonDetails
    readonly providerMetadata?: ProviderMetadata
  }
  readonly lifecycle: Lifecycle.State
}

const invalid = ProviderShared.invalidRequest

// =============================================================================
// Request Lowering
// =============================================================================
// Anthropic accepts at most 4 explicit cache_control breakpoints per request,
// across `tools`, `system`, and `messages`. Beyond the cap the API returns a
// 400 — so the lowering layer counts emitted markers and silently drops any
// that exceed it.
const ANTHROPIC_BREAKPOINT_CAP = 4

const EPHEMERAL_5M = { type: "ephemeral" as const }
const EPHEMERAL_1H = { type: "ephemeral" as const, ttl: "1h" as const }

const cacheControl = (breakpoints: Cache.Breakpoints, cache: CacheHint | undefined) => {
  if (cache?.type !== "ephemeral" && cache?.type !== "persistent") return undefined
  if (breakpoints.remaining <= 0) {
    breakpoints.dropped += 1
    return undefined
  }
  breakpoints.remaining -= 1
  return Cache.ttlBucket(cache.ttlSeconds) === "1h" ? EPHEMERAL_1H : EPHEMERAL_5M
}

const providerMetadata = (key: string, metadata: Record<string, unknown>): ProviderMetadata => ({ [key]: metadata })

const signatureFromMetadata = (metadata: ProviderMetadata | undefined, key: string): string | undefined => {
  const provider = metadata?.[key]
  if (!ProviderShared.isRecord(provider)) return undefined
  return typeof provider.signature === "string" ? provider.signature : undefined
}

const redactedDataFromMetadata = (metadata: ProviderMetadata | undefined, key: string): string | undefined => {
  const provider = metadata?.[key]
  if (!ProviderShared.isRecord(provider)) return undefined
  return typeof provider.redactedData === "string" ? provider.redactedData : undefined
}

const lowerTool = (breakpoints: Cache.Breakpoints, tool: ToolDefinition, inputSchema: JsonSchema): AnthropicTool => ({
  name: tool.name,
  description: tool.description,
  input_schema: inputSchema,
  cache_control: cacheControl(breakpoints, tool.cache),
})

const lowerToolChoice = (toolChoice: NonNullable<LLMRequest["toolChoice"]>) =>
  ProviderShared.matchToolChoice("Anthropic Messages", toolChoice, {
    auto: () => ({
      type: "auto" as const,
      ...(toolChoice.disableParallelToolUse === undefined
        ? {}
        : { disable_parallel_tool_use: toolChoice.disableParallelToolUse }),
    }),
    none: () => ({ type: "none" as const }),
    required: () => ({
      type: "any" as const,
      ...(toolChoice.disableParallelToolUse === undefined
        ? {}
        : { disable_parallel_tool_use: toolChoice.disableParallelToolUse }),
    }),
    tool: (name) => ({
      type: "tool" as const,
      name,
      ...(toolChoice.disableParallelToolUse === undefined
        ? {}
        : { disable_parallel_tool_use: toolChoice.disableParallelToolUse }),
    }),
  })

const scrubToolCallID = (id: string) => id.replace(/[^a-zA-Z0-9_-]/g, "_")

const lowerToolCall = (part: ToolCallPart): AnthropicToolUseBlock => ({
  type: "tool_use",
  id: scrubToolCallID(part.id),
  name: part.name,
  input: part.input,
})

const lowerServerToolCall = (part: ToolCallPart): AnthropicServerToolUseBlock => ({
  type: "server_tool_use",
  id: scrubToolCallID(part.id),
  name: part.name,
  input: part.input,
})

// Server tool result blocks are typed by name. Anthropic ships three today;
// extend this list when new server tools land. The block content is the
// structured payload returned by the provider, which we round-trip as-is.
const serverToolResultType = (name: string): AnthropicServerToolResultType | undefined => {
  if (name === "web_search") return "web_search_tool_result"
  if (name === "code_execution") return "code_execution_tool_result"
  if (name === "web_fetch") return "web_fetch_tool_result"
  return undefined
}

const lowerServerToolResult = Effect.fn("AnthropicMessages.lowerServerToolResult")(function* (
  part: ToolResultPart,
  providerMetadataKey: string,
) {
  const wireType = serverToolResultType(part.name)
  if (!wireType)
    return yield* invalid(`Anthropic Messages does not know how to round-trip server tool result for ${part.name}`)
  // Prefer the provider-owned replay payload; fall back to the result value for
  // histories constructed directly from provider events.
  const payload = part.providerMetadata?.[providerMetadataKey]?.["result"] ?? part.result.value
  return {
    type: wireType,
    tool_use_id: scrubToolCallID(part.id),
    content: payload,
  } satisfies AnthropicServerToolResultBlock
})

const fileIdFromMetadata = (metadata: MediaPart["metadata"]): string | undefined => {
  if (!ProviderShared.isRecord(metadata)) return undefined
  const anthropic = metadata.anthropic
  if (ProviderShared.isRecord(anthropic)) {
    if (typeof anthropic.file_id === "string") return anthropic.file_id
    if (typeof anthropic.fileId === "string") return anthropic.fileId
  }
  if (typeof metadata.file_id === "string") return metadata.file_id
  if (typeof metadata.fileId === "string") return metadata.fileId
  return undefined
}

const transformationsFromMetadata = (
  metadata: MediaPart["metadata"],
): AnthropicImageBlock["transformations"] | undefined => {
  if (!ProviderShared.isRecord(metadata)) return undefined
  const anthropic = ProviderShared.isRecord(metadata.anthropic) ? metadata.anthropic : undefined
  const raw = anthropic?.transformations ?? metadata.transformations
  if (ProviderShared.isRecord(raw)) {
    const value = raw.oversized_image
    if (value === "downsize" || value === "error") return { oversized_image: value }
  }
  if (anthropic && (anthropic.oversized_image === "downsize" || anthropic.oversized_image === "error"))
    return { oversized_image: anthropic.oversized_image }
  return undefined
}

const documentTitleFromPart = (part: MediaPart): string | undefined => {
  if (ProviderShared.isRecord(part.metadata)) {
    const anthropic = part.metadata.anthropic
    if (ProviderShared.isRecord(anthropic) && typeof anthropic.title === "string") return anthropic.title
    if (typeof part.metadata.title === "string") return part.metadata.title
  }
  if (typeof part.filename === "string" && part.filename.length > 0) return part.filename
  return undefined
}

const documentContextFromMetadata = (metadata: MediaPart["metadata"]): string | undefined => {
  if (!ProviderShared.isRecord(metadata)) return undefined
  const anthropic = ProviderShared.isRecord(metadata.anthropic) ? metadata.anthropic : undefined
  if (anthropic && typeof anthropic.context === "string") return anthropic.context
  if (typeof metadata.context === "string") return metadata.context
  return undefined
}

const citationsFromMetadata = (metadata: MediaPart["metadata"]): AnthropicDocumentBlock["citations"] | undefined => {
  if (!ProviderShared.isRecord(metadata)) return undefined
  const raw = ProviderShared.isRecord(metadata.anthropic)
    ? (metadata.anthropic.citations ?? metadata.citations)
    : metadata.citations
  if (ProviderShared.isRecord(raw) && typeof raw.enabled === "boolean") return { enabled: raw.enabled }
  return undefined
}

const isHttpUrl = (value: string) => /^https?:\/\//i.test(value.trim())

const lowerMedia = Effect.fn("AnthropicMessages.lowerMedia")(function* (
  part: MediaPart,
  breakpoints?: Cache.Breakpoints,
) {
  const mime = part.mediaType.toLowerCase()
  const cacheControlValue = breakpoints ? cacheControl(breakpoints, part.cache) : undefined
  const fileId = fileIdFromMetadata(part.metadata)

  // SDK file sources: FileImageSource:2350 / FileDocumentSource:2344 {type:"file", file_id}
  if (fileId) {
    if (mime.startsWith("image/"))
      return {
        type: "image" as const,
        source: { type: "file" as const, file_id: fileId },
        ...(cacheControlValue === undefined ? {} : { cache_control: cacheControlValue }),
        ...(transformationsFromMetadata(part.metadata) === undefined
          ? {}
          : { transformations: transformationsFromMetadata(part.metadata)! }),
      } satisfies AnthropicImageBlock
    return {
      type: "document" as const,
      source: { type: "file" as const, file_id: fileId },
      ...(cacheControlValue === undefined ? {} : { cache_control: cacheControlValue }),
      ...(documentTitleFromPart(part) === undefined ? {} : { title: documentTitleFromPart(part)! }),
      ...(documentContextFromMetadata(part.metadata) === undefined
        ? {}
        : { context: documentContextFromMetadata(part.metadata)! }),
      ...(citationsFromMetadata(part.metadata) === undefined
        ? {}
        : { citations: citationsFromMetadata(part.metadata)! }),
    } satisfies AnthropicDocumentBlock
  }

  const rawString = typeof part.data === "string" ? part.data.trim() : undefined
  // SDK URL sources: URLImageSource:3817 / URLPDFSource:3823 {type:"url", url}
  if (rawString && isHttpUrl(rawString) && !rawString.startsWith("data:")) {
    if (mime.startsWith("image/"))
      return {
        type: "image" as const,
        source: { type: "url" as const, url: rawString },
        ...(cacheControlValue === undefined ? {} : { cache_control: cacheControlValue }),
        ...(transformationsFromMetadata(part.metadata) === undefined
          ? {}
          : { transformations: transformationsFromMetadata(part.metadata)! }),
      } satisfies AnthropicImageBlock
    if (mime === "application/pdf")
      return {
        type: "document" as const,
        source: { type: "url" as const, url: rawString },
        ...(cacheControlValue === undefined ? {} : { cache_control: cacheControlValue }),
        ...(documentTitleFromPart(part) === undefined ? {} : { title: documentTitleFromPart(part)! }),
        ...(documentContextFromMetadata(part.metadata) === undefined
          ? {}
          : { context: documentContextFromMetadata(part.metadata)! }),
        ...(citationsFromMetadata(part.metadata) === undefined
          ? {}
          : { citations: citationsFromMetadata(part.metadata)! }),
      } satisfies AnthropicDocumentBlock
  }

  // SDK PlainTextSource:2716 {type:"text", media_type:"text/plain", data}
  if (mime === "text/plain") {
    const textData =
      typeof part.data !== "string"
        ? Buffer.from(part.data).toString("utf8")
        : part.data.startsWith("data:")
          ? (() => {
              const comma = part.data.indexOf(",")
              const payload = comma >= 0 ? part.data.slice(comma + 1) : part.data
              return part.data.includes(";base64")
                ? Buffer.from(payload, "base64").toString("utf8")
                : decodeURIComponent(payload)
            })()
          : part.data
    return {
      type: "document" as const,
      source: { type: "text" as const, media_type: "text/plain" as const, data: textData },
      ...(cacheControlValue === undefined ? {} : { cache_control: cacheControlValue }),
      ...(documentTitleFromPart(part) === undefined ? {} : { title: documentTitleFromPart(part)! }),
      ...(documentContextFromMetadata(part.metadata) === undefined
        ? {}
        : { context: documentContextFromMetadata(part.metadata)! }),
      ...(citationsFromMetadata(part.metadata) === undefined
        ? {}
        : { citations: citationsFromMetadata(part.metadata)! }),
    } satisfies AnthropicDocumentBlock
  }

  const media = ProviderShared.normalizeMedia(part)
  if (media.mime === "application/pdf")
    return {
      type: "document" as const,
      source: {
        type: "base64" as const,
        media_type: "application/pdf" as const,
        data: media.base64,
      },
      ...(cacheControlValue === undefined ? {} : { cache_control: cacheControlValue }),
      ...(documentTitleFromPart(part) === undefined ? {} : { title: documentTitleFromPart(part)! }),
      ...(documentContextFromMetadata(part.metadata) === undefined
        ? {}
        : { context: documentContextFromMetadata(part.metadata)! }),
      ...(citationsFromMetadata(part.metadata) === undefined
        ? {}
        : { citations: citationsFromMetadata(part.metadata)! }),
    } satisfies AnthropicDocumentBlock
  if (!media.mime.startsWith("image/"))
    return yield* invalid(`Anthropic Messages does not support media type ${part.mediaType}`)
  return {
    type: "image" as const,
    source: {
      type: "base64" as const,
      media_type: media.mime,
      data: media.base64,
    },
    ...(cacheControlValue === undefined ? {} : { cache_control: cacheControlValue }),
    ...(transformationsFromMetadata(part.metadata) === undefined
      ? {}
      : { transformations: transformationsFromMetadata(part.metadata)! }),
  } satisfies AnthropicImageBlock
})

// Tool results may carry structured text, images, and documents. Keep media as provider-native
// content instead of JSON-stringifying base64 into a prompt string.
const lowerToolResultContentItem = Effect.fnUntraced(function* (item: Tool.Content) {
  if (item.type === "text") return { type: "text" as const, text: item.text } satisfies AnthropicTextBlock
  return yield* lowerMedia({ type: "media", mediaType: item.mime, data: item.uri, filename: item.name })
})

const lowerToolResultContent = Effect.fnUntraced(function* (part: ToolResultPart) {
  // Text / json / error results stay as a string for backward compatibility
  // with existing cassettes and provider expectations.
  if (part.result.type !== "content") return ProviderShared.toolResultText(part)
  // Preserve the narrowed array element type when compiled through a consumer package.
  const content: ReadonlyArray<Tool.Content> = part.result.value
  return yield* Effect.forEach(content, lowerToolResultContentItem)
})

const requireThinkingSignature = (request: LLMRequest) => {
  if (request.model.compatibility?.requireSignature !== undefined) return request.model.compatibility.requireSignature
  const provider = request.model.provider.toLowerCase()
  const model = request.model.id.toLowerCase()
  const baseURL = (request.model.route.endpoint.baseURL ?? "").toLowerCase()
  if (
    provider === "kimi-for-coding" ||
    provider === "moonshotai" ||
    provider === "moonshotai-cn" ||
    model.startsWith("kimi-") ||
    baseURL.includes("api.kimi.com/coding") ||
    baseURL.includes("api.moonshot.ai/anthropic") ||
    baseURL.includes("api.moonshot.cn/anthropic")
  )
    return false
  if (provider.includes("xiaomi") || model.includes("mimo") || baseURL.includes("xiaomimimo.com")) return false
  return true
}

// Mid-conversation system messages became available with Opus 4.8 and version
// 5 of the other supported Claude families. Treat later family versions as
// compatible without assuming that every Anthropic Messages model is Claude.
const supportsNativeSystemUpdates = (request: LLMRequest) => {
  const match = /(?:^|[./])claude-(fable|haiku|mythos|opus|sonnet)-(\d+)(?:[.-](\d+))?/.exec(
    String(request.model.id).toLowerCase(),
  )
  if (!match) return false
  const major = Number(match[2])
  if (match[1] !== "opus") return major >= 5
  if (major !== 4) return major >= 5
  return match[3] !== undefined && match[3].length <= 2 && Number(match[3]) >= 8
}

const endsInServerToolUse = (message: LLMRequest["messages"][number]) => {
  const last = message.content.at(-1)
  return message.role === "assistant" && last?.type === "tool-call" && last.providerExecuted === true
}

const canUseNativeSystemUpdate = (request: LLMRequest, index: number) => {
  const previous = request.messages[index - 1]
  const next = request.messages[index + 1]
  // Vertex currently rejects/404s for a system message after local tool results,
  // so fold it into the user tool-result turn across continuations and history.
  if (request.model.route.id === "google-vertex-messages" && previous?.role === "tool") return false
  return (
    previous !== undefined &&
    previous.role !== "system" &&
    (previous.role === "user" || previous.role === "tool" || endsInServerToolUse(previous)) &&
    next?.role !== "system" &&
    (next === undefined || next.role === "assistant")
  )
}

const splitsLocalToolResults = (messages: LLMRequest["messages"], index: number) => {
  const pending = new Set<string>()
  for (const message of messages.slice(0, index)) {
    for (const part of message.content) {
      if (message.role === "assistant" && part.type === "tool-call" && part.providerExecuted !== true)
        pending.add(part.id)
      if (message.role === "tool" && part.type === "tool-result") pending.delete(part.id)
    }
  }
  return pending.size > 0
}

const lowerNativeSystemUpdate = Effect.fn("AnthropicMessages.lowerNativeSystemUpdate")(function* (
  message: LLMRequest["messages"][number],
  breakpoints: Cache.Breakpoints,
) {
  const content = yield* ProviderShared.systemUpdateText("Anthropic Messages", message)
  return {
    role: "system" as const,
    content: content.map((part) => ({
      type: "text" as const,
      text: part.text,
      cache_control: cacheControl(breakpoints, part.cache),
    })),
  }
})

const lowerMessages = Effect.fn("AnthropicMessages.lowerMessages")(function* (
  request: LLMRequest,
  breakpoints: Cache.Breakpoints,
) {
  const messages: AnthropicMessage[] = []
  const providerMetadataKey = request.model.route.providerMetadataKey ?? String(request.model.provider)

  for (const [index, message] of request.messages.entries()) {
    if (message.role === "system") {
      if (splitsLocalToolResults(request.messages, index))
        return yield* invalid("Anthropic Messages system updates cannot split a local tool call from its tool result")
      if (supportsNativeSystemUpdates(request) && canUseNativeSystemUpdate(request, index)) {
        messages.push(yield* lowerNativeSystemUpdate(message, breakpoints))
        continue
      }
      const part = yield* ProviderShared.wrappedSystemUpdate("Anthropic Messages", message)
      const block = { type: "text" as const, text: part.text, cache_control: cacheControl(breakpoints, part.cache) }
      const previous = messages.at(-1)
      if (previous?.role === "user")
        messages[messages.length - 1] = { role: "user", content: [...previous.content, block] }
      else messages.push({ role: "user", content: [block] })
      continue
    }

    if (message.role === "user") {
      const content: AnthropicUserBlock[] = []
      for (const part of message.content) {
        if (part.type === "text") {
          if (part.text.trim().length === 0) continue
          content.push({ type: "text", text: part.text, cache_control: cacheControl(breakpoints, part.cache) })
          continue
        }
        if (part.type === "media") {
          content.push(yield* lowerMedia(part, breakpoints))
          continue
        }
        return yield* ProviderShared.unsupportedContent("Anthropic Messages", "user", ["text", "media"])
      }
      if (content.length > 0) messages.push({ role: "user", content })
      continue
    }

    if (message.role === "assistant") {
      const content: AnthropicAssistantBlock[] = []
      for (const part of message.content) {
        if (part.type === "compaction") {
          if (part.provider !== request.model.provider || part.text === undefined)
            return yield* invalid("Compaction state must be replayed to its originating provider and API")
          content.push({ type: "compaction", content: part.text })
          continue
        }
        if (part.type === "text") {
          if (part.text.trim().length === 0) continue
          content.push({ type: "text", text: part.text, cache_control: cacheControl(breakpoints, part.cache) })
          continue
        }
        if (part.type === "reasoning") {
          // A signature marks visible thinking; only signature-less parts carrying
          // redactedData round-trip as opaque redacted_thinking blocks.
          const signature = part.encrypted ?? signatureFromMetadata(part.providerMetadata, providerMetadataKey)
          const redactedData = redactedDataFromMetadata(part.providerMetadata, providerMetadataKey)
          if (signature === undefined && redactedData !== undefined) {
            content.push({ type: "redacted_thinking", data: redactedData })
            continue
          }
          if (typeof signature !== "string" || signature.trim().length === 0) {
            if (part.text.trim().length === 0) continue
            if (!requireThinkingSignature(request)) {
              content.push({ type: "thinking", thinking: part.text, signature: "" })
              continue
            }
            // Without a signature this cannot be a valid thinking block per
            // the SDK ThinkingBlockParam:3217 — demote to text so the
            // conversation remains sendable.
            content.push({
              type: "text",
              text: part.text,
              cache_control: cacheControl(breakpoints, part.cache),
            })
            continue
          }
          content.push({ type: "thinking", thinking: part.text, signature })
          continue
        }
        if (part.type === "tool-call") {
          content.push(part.providerExecuted ? lowerServerToolCall(part) : lowerToolCall(part))
          continue
        }
        if (part.type === "tool-result" && part.providerExecuted) {
          content.push(yield* lowerServerToolResult(part, providerMetadataKey))
          continue
        }
        return yield* invalid(
          `Anthropic Messages assistant messages only support text, reasoning, and tool-call content for now`,
        )
      }
      if (content.length > 0) messages.push({ role: "assistant", content })
      continue
    }

    const content: AnthropicToolResultBlock[] = []
    for (const part of message.content) {
      if (!ProviderShared.supportsContent(part, ["tool-result"]))
        return yield* ProviderShared.unsupportedContent("Anthropic Messages", "tool", ["tool-result"])
      content.push({
        type: "tool_result",
        tool_use_id: scrubToolCallID(part.id),
        content: yield* lowerToolResultContent(part),
        is_error: part.result.type === "error" ? true : undefined,
        cache_control: cacheControl(breakpoints, part.cache),
      })
    }
    const previous = messages.at(-1)
    if (previous?.role === "user" && previous.content.every((block) => block.type === "tool_result"))
      messages[messages.length - 1] = { role: "user", content: [...previous.content, ...content] }
    else messages.push({ role: "user", content })
  }

  return messages
})

const resolveOptions = Effect.fn("AnthropicMessages.resolveOptions")(function* (request: LLMRequest) {
  const input = request.providerOptions as Record<string, unknown> | undefined
  const rawServiceTier =
    (input as Record<string, unknown> | undefined)?.service_tier ??
    (input as Record<string, unknown> | undefined)?.serviceTier
  const service_tier =
    rawServiceTier === "auto" || rawServiceTier === "standard_only"
      ? (rawServiceTier as "auto" | "standard_only")
      : undefined
  const rawMetadata = (input as Record<string, unknown> | undefined)?.metadata
  const metadata =
    ProviderShared.isRecord(rawMetadata) && (typeof rawMetadata.user_id === "string" || rawMetadata.user_id === null)
      ? { user_id: rawMetadata.user_id as string | null }
      : undefined
  const container =
    typeof (input as Record<string, unknown> | undefined)?.container === "string" ||
    ProviderShared.isRecord((input as Record<string, unknown> | undefined)?.container)
      ? ((input as Record<string, unknown>).container as
          | string
          | { id?: string | null; skills?: ReadonlyArray<Record<string, unknown>> | null })
      : undefined
  const rawInferenceGeo =
    (input as Record<string, unknown> | undefined)?.inference_geo ??
    (input as Record<string, unknown> | undefined)?.inferenceGeo
  const inference_geo = typeof rawInferenceGeo === "string" ? rawInferenceGeo : undefined
  const rawCacheControl =
    (input as Record<string, unknown> | undefined)?.cache_control ??
    (input as Record<string, unknown> | undefined)?.cacheControl
  const cache_control =
    ProviderShared.isRecord(rawCacheControl) && rawCacheControl.type === "ephemeral"
      ? (rawCacheControl as { type: "ephemeral"; ttl?: "5m" | "1h" })
      : undefined
  const rawOutputConfig =
    (input as Record<string, unknown> | undefined)?.output_config ??
    (input as Record<string, unknown> | undefined)?.outputConfig
  const outputConfigEffort =
    typeof (input as Record<string, unknown> | undefined)?.effort === "string"
      ? ((input as Record<string, unknown>).effort as string)
      : ProviderShared.isRecord(rawOutputConfig) && typeof rawOutputConfig.effort === "string"
        ? (rawOutputConfig.effort as string)
        : undefined
  const outputConfigFormat =
    ProviderShared.isRecord(rawOutputConfig) && ProviderShared.isRecord(rawOutputConfig.format)
      ? (rawOutputConfig.format as { type: "json_schema"; schema: Record<string, unknown> })
      : undefined
  const output_config =
    outputConfigEffort === undefined && outputConfigFormat === undefined
      ? undefined
      : {
          ...(outputConfigEffort === undefined ? {} : { effort: outputConfigEffort }),
          ...(outputConfigFormat === undefined ? {} : { format: outputConfigFormat }),
        }
  const thinking = yield* resolveThinking(input?.thinking)
  return {
    thinking: applyThinkingBindingDefault(request.model, thinking),
    effort: outputConfigEffort,
    output_config,
    service_tier,
    metadata,
    container,
    inference_geo,
    cache_control,
  }
})

const supportsThinkingBlockBinding = (model: LLMRequest["model"]) => {
  const override = model.compatibility?.supportsThinkingBlockBinding
  if (override !== undefined) return override
  // Accept gateway namespaces and Vertex suffixes without treating a snapshot date as a minor version.
  const version = /(?:^|[./])claude-[a-z]+-(?<major>\d+)(?:[.-](?<minor>\d{1,2}))?(?:$|[-:@])/i.exec(model.id)?.groups
  if (!version) return false
  const major = Number(version.major)
  const minor = Number(version.minor ?? 0)
  return major > 5 || (major === 5 && minor >= 1)
}

const applyThinkingBindingDefault = (model: LLMRequest["model"], thinking: AnthropicThinking | undefined) => {
  if (thinking?.type === "disabled") return thinking
  if (!supportsThinkingBlockBinding(model)) return thinking
  return {
    ...(thinking ?? { type: "adaptive" as const }),
    block_binding: {
      prefix_mismatch_behavior: "drop_block",
      ...thinking?.block_binding,
    },
  }
}

const resolveThinking = Effect.fn("AnthropicMessages.resolveThinking")(function* (input: unknown) {
  if (!ProviderShared.isRecord(input)) return undefined
  if (input.type === "disabled") return { type: "disabled" as const }
  if (input.type !== "adaptive" && input.type !== "enabled") return undefined
  const block_binding = yield* ProviderShared.validateWith(
    Schema.decodeUnknownEffect(Schema.UndefinedOr(AnthropicThinkingBlockBinding)),
  )(input.block_binding)
  const display =
    input.display === "summarized" || input.display === "omitted"
      ? (input.display as "summarized" | "omitted")
      : undefined
  if (input.type === "adaptive") return { type: "adaptive" as const, display, block_binding }
  const budget =
    typeof input.budgetTokens === "number"
      ? input.budgetTokens
      : typeof input.budget_tokens === "number"
        ? input.budget_tokens
        : undefined
  if (budget === undefined)
    return yield* ProviderShared.invalidRequest("Anthropic thinking provider option requires budgetTokens")
  return { type: "enabled" as const, budget_tokens: budget, display, block_binding }
})

const fromRequest = Effect.fn("AnthropicMessages.fromRequest")(function* (request: LLMRequest) {
  const management = yield* ProviderShared.validateWith(
    Schema.decodeUnknownEffect(Schema.UndefinedOr(ContextManagement)),
  )(request.providerOptions?.contextManagement)
  const generation = request.generation
  const toolSchemaCompatibility = request.model.compatibility?.toolSchema
  // Allocate the 4-breakpoint budget in invalidation order: tools → system →
  // messages. Tools live highest in the cache hierarchy, so when callers
  // over-mark we keep their tool hints and shed the message-tail ones first.
  const breakpoints = Cache.newBreakpoints(ANTHROPIC_BREAKPOINT_CAP)
  const flattened = ProviderShared.flattenToolRequest(request)
  const tools =
    flattened.tools.length === 0
      ? undefined
      : flattened.tools.map((tool) =>
          lowerTool(
            breakpoints,
            tool,
            ToolSchemaProjection.modelCompatibility(tool.inputSchema, toolSchemaCompatibility),
          ),
        )
  // Anthropic rejects tool_choice when tools are absent; "none" is only meaningful with tools present.
  const toolChoice = tools === undefined || !request.toolChoice ? undefined : yield* lowerToolChoice(request.toolChoice)
  const systemParts = request.system.filter((part) => part.text.length > 0)
  const system =
    systemParts.length === 0
      ? undefined
      : systemParts.map((part) => ({
          type: "text" as const,
          text: part.text,
          cache_control: cacheControl(breakpoints, part.cache),
        }))
  const messages = yield* lowerMessages(flattened.request, breakpoints)
  if (breakpoints.dropped > 0) {
    yield* Effect.logWarning(
      `Anthropic Messages: dropped ${breakpoints.dropped} cache breakpoint(s); the API allows at most ${ANTHROPIC_BREAKPOINT_CAP} per request.`,
    )
  }
  const options = yield* resolveOptions(request)
  const body = {
    model: request.model.id,
    system,
    messages,
    tools,
    tool_choice: toolChoice,
    stream: true as const,
    max_tokens: generation?.maxTokens ?? DEFAULT_MAX_TOKENS,
    temperature: generation?.temperature,
    top_p: generation?.topP,
    top_k: generation?.topK,
    stop_sequences: generation?.stop,
    thinking: options.thinking,
    output_config: options.output_config,
    // top-level passthrough per SDK MessageCreateParamsBase:4638,4643,4649,4654,4670
    cache_control: options.cache_control,
    container: options.container,
    inference_geo: options.inference_geo,
    metadata: options.metadata,
    service_tier: options.service_tier,
  }
  if (!management) return body
  return {
    ...body,
    context_management: {
      edits: management.edits.map((edit) => ({
        type: edit.type,
        trigger: edit.trigger,
        pause_after_compaction: edit.pauseAfterCompaction,
        instructions: edit.instructions,
      })),
    },
  }
})

// =============================================================================
// Stream Parsing
// =============================================================================
const mapFinishReason = (reason: string | null | undefined): FinishReason => {
  if (reason === "end_turn" || reason === "stop_sequence" || reason === "pause_turn") return "stop"
  if (reason === "max_tokens" || reason === "model_context_window_exceeded") return "length"
  if (reason === "tool_use") return "tool-calls"
  if (reason === "refusal") return "content-filter"
  return "unknown"
}

// Anthropic reports the non-overlapping breakdown natively — its
// `input_tokens` is the *non-cached* count per the Messages API docs, with
// cache reads and writes as separate fields. We sum them to derive the
// inclusive `inputTokens` the rest of the contract expects. Extended
// thinking tokens are included in `output_tokens`; newer responses also
// expose that subset through `output_tokens_details.thinking_tokens`.
const mapUsage = (usage: AnthropicUsage | undefined, providerMetadataKey: string): Usage | undefined => {
  if (!usage) return undefined
  const iterations = usage.iterations?.length ? usage.iterations : [usage]
  const last = usage.iterations?.at(-1)
  const nonCached = ProviderShared.sumTokens(...iterations.map((item) => item.input_tokens ?? undefined))
  const cacheRead = ProviderShared.sumTokens(...iterations.map((item) => item.cache_read_input_tokens ?? undefined))
  const cacheWrite = ProviderShared.sumTokens(
    ...iterations.map((item) => item.cache_creation_input_tokens ?? undefined),
  )
  const inputTokens = ProviderShared.sumTokens(nonCached, cacheRead, cacheWrite)
  const outputTokens = ProviderShared.sumTokens(...iterations.map((item) => item.output_tokens))
  return new Usage({
    inputTokens,
    outputTokens,
    contextTokens:
      last?.type === "message"
        ? ProviderShared.sumTokens(
            last.input_tokens ?? undefined,
            last.cache_read_input_tokens ?? undefined,
            last.cache_creation_input_tokens ?? undefined,
          )
        : undefined,
    nonCachedInputTokens: nonCached,
    cacheReadInputTokens: cacheRead,
    cacheWriteInputTokens: cacheWrite,
    reasoningTokens: ProviderShared.sumTokens(...iterations.map((item) => item.output_tokens_details?.thinking_tokens)),
    totalTokens: ProviderShared.totalTokens(inputTokens, outputTokens, undefined),
    providerMetadata: { [providerMetadataKey]: usage },
  })
}

// Anthropic emits usage on `message_start` and again on `message_delta` — the
// final delta carries the authoritative totals. Right-biased merge: each
// field prefers `right` when defined, falls back to `left`. `inputTokens` is
// recomputed from the merged breakdown so the inclusive total stays
// consistent with `nonCached + cacheRead + cacheWrite`.
const mergeUsage = (left: Usage | undefined, right: Usage | undefined, providerMetadataKey: string) => {
  if (!left) return right
  if (!right) return left
  const nonCachedInputTokens = right.nonCachedInputTokens ?? left.nonCachedInputTokens
  const cacheReadInputTokens = right.cacheReadInputTokens ?? left.cacheReadInputTokens
  const cacheWriteInputTokens = right.cacheWriteInputTokens ?? left.cacheWriteInputTokens
  const inputTokens = ProviderShared.sumTokens(nonCachedInputTokens, cacheReadInputTokens, cacheWriteInputTokens)
  const outputTokens = right.outputTokens ?? left.outputTokens
  const reasoningTokens = right.reasoningTokens ?? left.reasoningTokens
  return new Usage({
    inputTokens,
    outputTokens,
    contextTokens: right.contextTokens ?? left.contextTokens,
    nonCachedInputTokens,
    cacheReadInputTokens,
    cacheWriteInputTokens,
    reasoningTokens,
    totalTokens: ProviderShared.totalTokens(inputTokens, outputTokens, undefined),
    providerMetadata: {
      [providerMetadataKey]:
        mergeJsonRecords(left.providerMetadata?.[providerMetadataKey], right.providerMetadata?.[providerMetadataKey]) ??
        {},
    },
  })
}

// Server tool result blocks come whole in `content_block_start` (no streaming
// delta sequence). We convert the payload to a `tool-result` event with
// `providerExecuted: true`. The runtime appends it to the assistant message
// for round-trip; downstream consumers can inspect `result.value` for the
// structured payload.
const SERVER_TOOL_RESULT_NAMES: Record<AnthropicServerToolResultType, string> = {
  web_search_tool_result: "web_search",
  code_execution_tool_result: "code_execution",
  web_fetch_tool_result: "web_fetch",
}

const isServerToolResultType = (type: string): type is AnthropicServerToolResultType => type in SERVER_TOOL_RESULT_NAMES

const serverToolResultEvent = (block: AnthropicStreamBlock, providerMetadataKey: string): LLMEvent | undefined => {
  if (!block.type || !isServerToolResultType(block.type)) return undefined
  const errorPayload =
    typeof block.content === "object" && block.content !== null && "type" in block.content
      ? String((block.content as Record<string, unknown>).type)
      : ""
  const isError = errorPayload.endsWith("_tool_result_error")
  return LLMEvent.toolResult({
    id: block.tool_use_id ?? "",
    name: SERVER_TOOL_RESULT_NAMES[block.type],
    result: isError ? { type: "error", value: block.content } : { type: "json", value: block.content },
    providerExecuted: true,
    // The complete payload is irreducible provider replay state: subsequent
    // stateless requests must round-trip the typed result block verbatim.
    providerMetadata: providerMetadata(providerMetadataKey, { blockType: block.type, result: block.content }),
  })
}

type StepResult = readonly [ParserState, ReadonlyArray<LLMEvent>]

const NO_EVENTS: StepResult["1"] = []

const onMessageStart = (state: ParserState, event: AnthropicEvent): StepResult => {
  const usage = mapUsage(event.message?.usage, state.providerMetadataKey)
  return [usage ? { ...state, usage: mergeUsage(state.usage, usage, state.providerMetadataKey) } : state, NO_EVENTS]
}

const onContentBlockStart = (
  state: ParserState,
  event: AnthropicEvent & { readonly content_block: AnthropicStreamBlock },
): StepResult => {
  const block = event.content_block

  if (block.type === "tool_use" || block.type === "server_tool_use") {
    if (event.index === undefined || !block.id) return [state, NO_EVENTS]
    const events: LLMEvent[] = []
    const lifecycle = Lifecycle.stepStart(state.lifecycle, events)
    return [
      {
        ...state,
        lifecycle,
        tools: ToolStream.start(state.tools, event.index, {
          id: block.id,
          name: block.name ?? "",
          input:
            block.input !== undefined && (!ProviderShared.isRecord(block.input) || Object.keys(block.input).length > 0)
              ? ProviderShared.encodeJson(block.input)
              : undefined,
          providerExecuted: block.type === "server_tool_use",
        }),
      },
      [
        ...events,
        LLMEvent.toolInputStart({
          id: block.id,
          name: block.name ?? "",
          providerExecuted: block.type === "server_tool_use" ? true : undefined,
        }),
      ],
    ]
  }

  if (block.type === "text" && block.text !== undefined) {
    const events: LLMEvent[] = []
    const id = `text-${event.index ?? 0}`
    const lifecycle = Lifecycle.textStart(state.lifecycle, events, id)
    return [
      { ...state, lifecycle: block.text ? Lifecycle.textDelta(lifecycle, events, id, block.text) : lifecycle },
      events,
    ]
  }

  if (block.type === "thinking" && block.thinking !== undefined) {
    const events: LLMEvent[] = []
    const id = `reasoning-${event.index ?? 0}`
    const metadata =
      block.signature === undefined
        ? undefined
        : providerMetadata(state.providerMetadataKey, { signature: block.signature })
    const lifecycle = Lifecycle.reasoningStart(state.lifecycle, events, id, metadata)
    return [
      {
        ...state,
        lifecycle: block.thinking
          ? Lifecycle.reasoningDelta(lifecycle, events, id, block.thinking, metadata)
          : lifecycle,
        reasoningSignatures:
          event.index === undefined || block.signature === undefined
            ? state.reasoningSignatures
            : { ...state.reasoningSignatures, [event.index]: block.signature },
      },
      events,
    ]
  }

  // Redacted thinking surfaces as an empty reasoning part carrying the opaque
  // payload as `redactedData` metadata (same model as Vercel's
  // @ai-sdk/anthropic). The existing content_block_stop closes the part.
  if (block.type === "redacted_thinking" && block.data !== undefined) {
    const events: LLMEvent[] = []
    return [
      {
        ...state,
        lifecycle: Lifecycle.reasoningStart(
          state.lifecycle,
          events,
          `reasoning-${event.index ?? 0}`,
          providerMetadata(state.providerMetadataKey, { redactedData: block.data }),
        ),
      },
      events,
    ]
  }

  const result = serverToolResultEvent(block, state.providerMetadataKey)
  if (!result) return [state, NO_EVENTS]
  const events: LLMEvent[] = []
  return [{ ...state, lifecycle: Lifecycle.stepStart(state.lifecycle, events) }, [...events, result]]
}

const onContentBlockDelta = Effect.fn("AnthropicMessages.onContentBlockDelta")(function* (
  state: ParserState,
  event: AnthropicEvent & { readonly delta: AnthropicStreamDelta },
) {
  const delta = event.delta

  if (delta.type === "compaction_delta") {
    if (event.index === undefined || !(event.index in state.compactions) || delta.content === undefined)
      return yield* ProviderShared.eventError(ADAPTER, "Compaction delta is missing its block or content")
    return [
      { ...state, compactions: { ...state.compactions, [event.index]: delta.content } },
      NO_EVENTS,
    ] satisfies StepResult
  }

  if (delta.type === "text_delta" && delta.text) {
    if (!state.lifecycle.text.has(`text-${event.index ?? 0}`)) return [state, NO_EVENTS] satisfies StepResult
    const events: LLMEvent[] = []
    return [
      { ...state, lifecycle: Lifecycle.textDelta(state.lifecycle, events, `text-${event.index ?? 0}`, delta.text) },
      events,
    ] satisfies StepResult
  }

  if (delta.type === "thinking_delta" && delta.thinking) {
    if (!state.lifecycle.reasoning.has(`reasoning-${event.index ?? 0}`)) return [state, NO_EVENTS] satisfies StepResult
    const events: LLMEvent[] = []
    return [
      {
        ...state,
        lifecycle: Lifecycle.reasoningDelta(state.lifecycle, events, `reasoning-${event.index ?? 0}`, delta.thinking),
      },
      events,
    ] satisfies StepResult
  }

  if (delta.type === "signature_delta" && delta.signature) {
    const index = event.index ?? 0
    if (!state.lifecycle.reasoning.has(`reasoning-${index}`)) return [state, NO_EVENTS] satisfies StepResult
    return [
      {
        ...state,
        reasoningSignatures: { ...state.reasoningSignatures, [index]: delta.signature },
      },
      NO_EVENTS,
    ] satisfies StepResult
  }

  if (delta.type === "input_json_delta" && event.index !== undefined) {
    if (!delta.partial_json) return [state, NO_EVENTS] satisfies StepResult
    if (!state.tools[event.index]) return [state, NO_EVENTS] satisfies StepResult
    const result = ToolStream.appendExisting(
      ADAPTER,
      state.tools,
      event.index,
      delta.partial_json,
      "Anthropic Messages tool argument delta is missing its tool call",
    )
    if (ToolStream.isError(result)) return yield* result
    const events: LLMEvent[] = []
    const lifecycle = result.events.length ? Lifecycle.stepStart(state.lifecycle, events) : state.lifecycle
    events.push(...result.events)
    return [{ ...state, lifecycle, tools: result.tools }, events] satisfies StepResult
  }

  return [state, NO_EVENTS] satisfies StepResult
})

const onContentBlockStop = Effect.fn("AnthropicMessages.onContentBlockStop")(function* (
  state: ParserState,
  event: AnthropicEvent,
) {
  if (event.index === undefined) return [state, NO_EVENTS] satisfies StepResult
  if (event.index in state.compactions) {
    const { [event.index]: content, ...compactions } = state.compactions
    const events: LLMEvent[] = []
    const lifecycle = Lifecycle.stepStart(state.lifecycle, events)
    events.push(
      LLMEvent.compaction({
        provider: state.provider,
        text: content,
      }),
    )
    return [{ ...state, compactions, lifecycle }, events] satisfies StepResult
  }
  const result = yield* ToolStream.finish(ADAPTER, state.tools, event.index)
  const events: LLMEvent[] = []
  const resultEvents = result.events ?? []
  const signature = state.reasoningSignatures[event.index]
  const lifecycle = resultEvents.length
    ? Lifecycle.stepStart(state.lifecycle, events)
    : Lifecycle.reasoningEnd(
        Lifecycle.textEnd(state.lifecycle, events, `text-${event.index}`),
        events,
        `reasoning-${event.index}`,
        signature === undefined ? undefined : providerMetadata(state.providerMetadataKey, { signature }),
      )
  events.push(...resultEvents)
  const reasoningSignatures = { ...state.reasoningSignatures }
  delete reasoningSignatures[event.index]
  return [{ ...state, lifecycle, tools: result.tools, reasoningSignatures }, events] satisfies StepResult
})

const onMessageDelta = (
  state: ParserState,
  event: AnthropicEvent & { readonly delta?: AnthropicStreamDelta },
): StepResult => {
  const usage = mergeUsage(state.usage, mapUsage(event.usage, state.providerMetadataKey), state.providerMetadataKey)
  const pendingFinish = (() => {
    const stopReason = event.delta?.stop_reason
    if (stopReason === null || stopReason === undefined) return state.pendingFinish

    const stopSequence = event.delta?.stop_sequence
    const finishMetadata =
      stopSequence === null || stopSequence === undefined
        ? state.pendingFinish?.providerMetadata
        : providerMetadata(state.providerMetadataKey, { stopSequence })
    return {
      reason: {
        normalized: mapFinishReason(stopReason),
        raw: stopReason,
      },
      providerMetadata: finishMetadata,
    }
  })()
  return [
    {
      ...state,
      usage,
      pendingFinish,
    },
    NO_EVENTS,
  ]
}

const onMessageStop = Effect.fn("AnthropicMessages.onMessageStop")(function* (state: ParserState) {
  if (Object.keys(state.compactions).length)
    return yield* ProviderShared.eventError(ADAPTER, "Response ended with an incomplete compaction block")
  const result = yield* ToolStream.finishAll(ADAPTER, state.tools)
  const events: LLMEvent[] = []
  const lifecycle = result.events.length ? Lifecycle.stepStart(state.lifecycle, events) : state.lifecycle
  events.push(...result.events)
  const closed = Object.entries(state.reasoningSignatures).reduce(
    (current, [index, signature]) =>
      Lifecycle.reasoningEnd(
        current,
        events,
        `reasoning-${index}`,
        providerMetadata(state.providerMetadataKey, { signature }),
      ),
    lifecycle,
  )
  const finished = Lifecycle.finish(closed, events, {
    reason: state.pendingFinish?.reason ?? {
      normalized: "unknown",
      raw: undefined,
    },
    usage: state.usage,
    providerMetadata: state.pendingFinish?.providerMetadata,
  })
  return [{ ...state, lifecycle: finished, tools: result.tools }, events] satisfies StepResult
})

// Prefix `error.type` so overloads, rate limits, and quota errors are visible
// even when the provider message is generic or empty.
const providerErrorMessage = (event: AnthropicEvent): string => {
  const type = event.error?.type
  const message = event.error?.message
  if (type && message) return `${type}: ${message}`
  return message || type || "Anthropic Messages stream error"
}

const onError = (event: AnthropicEvent) => {
  const message = providerErrorMessage(event)
  const body = ProviderShared.encodeJson(event)
  return Effect.fail(
    new AIError({
      reason: classifyProviderFailure({ message, rawBody: body }),
    }),
  )
}

const STREAM_BLOCK_TYPES = new Set([
  "compaction",
  "text",
  "thinking",
  "redacted_thinking",
  "tool_use",
  "server_tool_use",
])
const STREAM_DELTA_TYPES = new Set([
  "compaction_delta",
  "text_delta",
  "thinking_delta",
  "signature_delta",
  "input_json_delta",
])

const invalidStreamEvent = (event: AnthropicEvent) =>
  Effect.fail(
    ProviderShared.eventError(
      ADAPTER,
      "Invalid anthropic/anthropic-messages stream event",
      ProviderShared.encodeJson(event),
    ),
  )

const step = (state: ParserState, event: AnthropicEvent) => {
  if (!SSE_EVENTS.has(event.type)) return Effect.succeed<StepResult>([state, NO_EVENTS])
  if (
    event.type !== "content_block_start" &&
    event.content_block !== undefined &&
    Option.isNone(decodeAnthropicStreamBlock(event.content_block))
  )
    return invalidStreamEvent(event)
  if (
    event.type !== "content_block_delta" &&
    event.delta !== undefined &&
    Option.isNone(decodeAnthropicStreamDelta(event.delta))
  )
    return invalidStreamEvent(event)
  if (event.type === "message_start") return Effect.succeed(onMessageStart(state, event))
  if (event.type === "content_block_start") {
    if (!ProviderShared.isRecord(event.content_block) || typeof event.content_block.type !== "string")
      return invalidStreamEvent(event)
    if (event.content_block.type === "compaction") {
      const decoded = Schema.decodeUnknownOption(AnthropicCompactionBlock)(event.content_block)
      if (event.index === undefined || Option.isNone(decoded)) return invalidStreamEvent(event)
      return Effect.succeed<StepResult>([
        { ...state, compactions: { ...state.compactions, [event.index]: decoded.value.content } },
        NO_EVENTS,
      ])
    }
    if (!STREAM_BLOCK_TYPES.has(event.content_block.type) && !isServerToolResultType(event.content_block.type))
      return Effect.succeed<StepResult>([state, NO_EVENTS])
    const decoded = decodeAnthropicStreamBlock(event.content_block)
    if (Option.isNone(decoded)) return invalidStreamEvent(event)
    const block = decoded.value
    if (block.type === "tool_use" || block.type === "server_tool_use") {
      if (event.index === undefined)
        return Effect.fail(ProviderShared.eventError(ADAPTER, `Anthropic ${block.type} missing index`))
      if (!block.id)
        return Effect.fail(ProviderShared.eventError(ADAPTER, `Anthropic tool_use missing id at index ${event.index}`))
    }
    return Effect.succeed(onContentBlockStart(state, { ...event, content_block: block }))
  }
  if (event.type === "content_block_delta") {
    if (!ProviderShared.isRecord(event.delta)) return invalidStreamEvent(event)
    if (typeof event.delta.type === "string" && !STREAM_DELTA_TYPES.has(event.delta.type))
      return Effect.succeed<StepResult>([state, NO_EVENTS])
    const decoded = decodeAnthropicStreamDelta(event.delta)
    if (Option.isNone(decoded)) return invalidStreamEvent(event)
    return onContentBlockDelta(state, { ...event, delta: decoded.value })
  }
  if (event.type === "content_block_stop") return onContentBlockStop(state, event)
  if (event.type === "message_delta") {
    const decoded = decodeAnthropicStreamDelta(event.delta)
    if (Option.isNone(decoded)) return invalidStreamEvent(event)
    return Effect.succeed(onMessageDelta(state, { ...event, delta: decoded.value }))
  }
  if (event.type === "message_stop") return onMessageStop(state)
  if (event.type === "error") return onError(event)
  return Effect.succeed<StepResult>([state, NO_EVENTS])
}

// =============================================================================
// Protocol And Anthropic Route
// =============================================================================
/**
 * The Anthropic Messages protocol — request body construction, body schema,
 * and the streaming-event state machine shared by Anthropic-compatible and
 * Vertex-hosted Messages routes.
 */
export const protocol = Protocol.make({
  id: ADAPTER,
  body: {
    schema: AnthropicMessagesBody,
    from: fromRequest,
  },
  stream: {
    event: Protocol.jsonEvent(AnthropicEvent),
    initial: (request) => ({
      provider: request.model.provider,
      compactions: {},
      providerMetadataKey: request.model.route.providerMetadataKey ?? String(request.model.provider),
      tools: ToolStream.empty<number>(),
      reasoningSignatures: {},
      lifecycle: Lifecycle.initial(),
    }),
    step,
  },
})

export const transport = <
  Body extends Pick<AnthropicMessagesBody, "messages" | "context_management" | "thinking">,
>() => {
  const http = HttpTransport.httpJson<Body, string>({ framing })
  return {
    ...http,
    prepare: (input: Parameters<typeof http.prepare>[0]) => {
      const requiredBetas = requiredBetaHeaders(input.body)
      if (requiredBetas.length === 0) return http.prepare(input)
      const headers = Headers.fromInput(input.request.http?.headers)
      const existingBetas = (headers["anthropic-beta"] ?? "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
      const betas = new Set([...existingBetas, ...requiredBetas])
      return http.prepare({
        ...input,
        request: LLMRequest.update(input.request, {
          http: new HttpOptions({
            ...input.request.http,
            headers: { ...headers, "anthropic-beta": [...betas].join(",") },
          }),
        }),
      })
    },
  }
}

function requiredBetaHeaders(body: Pick<AnthropicMessagesBody, "messages" | "context_management" | "thinking">) {
  // Always request interleaved thinking. The API accepts the header on any
  // model and ignores it where unsupported, while manual-thinking models need
  // it for thinking between tool calls.
  const betas: string[] = ["interleaved-thinking-2025-05-14"]
  const requestsCompaction = (body.context_management?.edits.length ?? 0) > 0
  const replaysCompaction = body.messages.some((message) =>
    message.content.some((block) => block.type === "compaction"),
  )
  if (requestsCompaction || replaysCompaction) betas.push("compact-2026-01-12")

  const thinking = body.thinking
  if (thinking && thinking.type !== "disabled" && thinking.block_binding)
    betas.push("thinking-binding-controls-2026-08-01")
  return betas
}

export const route = Route.make({
  id: ADAPTER,
  provider: "anthropic",
  providerMetadataKey: "anthropic",
  protocol,
  endpoint: Endpoint.path((input) => (input.request.model.provider === "anthropic" ? `${PATH}?beta=true` : PATH), {
    baseURL: DEFAULT_BASE_URL,
  }),
  auth: Auth.none,
  transport: transport<AnthropicMessagesBody>(),
  headers: () => ({ "anthropic-version": "2023-06-01" }),
})

export * as AnthropicMessages from "./anthropic-messages.js"
