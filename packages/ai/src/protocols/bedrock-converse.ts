import { Effect, Encoding, Schema } from "effect"
import { Route } from "../route/client.js"
import { Endpoint } from "../route/endpoint.js"
import { Protocol } from "../route/protocol.js"
import {
  AIError,
  LLMEvent,
  Usage,
  type CacheHint,
  type FinishReason,
  type FinishReasonDetails,
  type JsonSchema,
  type LLMRequest,
  type LanguageModelToolSchemaCompatibility,
  type ProviderMetadata,
  type ReasoningPart,
  type ToolCallPart,
  type ToolDefinition,
  type ToolResultPart,
} from "../schema/index.js"
import { BedrockEventStream } from "./bedrock-event-stream.js"
import { classifyProviderFailure } from "../provider-error.js"
import { JsonObject, optionalArray, ProviderShared } from "./shared.js"
import { BedrockAuth } from "./utils/bedrock-auth.js"
import { BedrockCache } from "./utils/bedrock-cache.js"
import { BedrockMedia } from "./utils/bedrock-media.js"
import { Lifecycle } from "./utils/lifecycle.js"
import { ToolSchemaProjection } from "./utils/tool-schema.js"
import { ToolStream } from "./utils/tool-stream.js"

const ADAPTER = "bedrock-converse"

export type { Credentials as BedrockCredentials } from "./utils/bedrock-auth.js"

// =============================================================================
// Request Body Schema
// =============================================================================
const BedrockTextBlock = Schema.Struct({
  text: Schema.String,
})
type BedrockTextBlock = Schema.Schema.Type<typeof BedrockTextBlock>

const BedrockToolUseBlock = Schema.Struct({
  toolUse: Schema.Struct({
    toolUseId: Schema.String,
    name: Schema.String,
    input: Schema.Unknown,
  }),
})
type BedrockToolUseBlock = Schema.Schema.Type<typeof BedrockToolUseBlock>

const BedrockToolResultContentItem = Schema.Union([
  Schema.Struct({ text: Schema.String }),
  Schema.Struct({ json: Schema.Unknown }),
  BedrockMedia.ImageBlock,
  BedrockMedia.DocumentBlock,
])

const BedrockToolResultBlock = Schema.Struct({
  toolResult: Schema.Struct({
    toolUseId: Schema.String,
    content: Schema.Array(BedrockToolResultContentItem),
    status: Schema.optional(Schema.Literals(["success", "error"])),
  }),
})
type BedrockToolResultBlock = Schema.Schema.Type<typeof BedrockToolResultBlock>

const BedrockReasoningBlock = Schema.Struct({
  reasoningContent: Schema.Union([
    Schema.Struct({
      reasoningText: Schema.Struct({
        text: Schema.String,
        signature: Schema.optional(Schema.String),
      }),
    }),
    Schema.Struct({ redactedContent: Schema.String }),
  ]),
})

const BedrockUserBlock = Schema.Union([
  BedrockTextBlock,
  BedrockMedia.ImageBlock,
  BedrockMedia.DocumentBlock,
  BedrockToolResultBlock,
  BedrockCache.CachePointBlock,
])
type BedrockUserBlock = Schema.Schema.Type<typeof BedrockUserBlock>

const BedrockAssistantBlock = Schema.Union([
  BedrockTextBlock,
  BedrockReasoningBlock,
  BedrockToolUseBlock,
  BedrockCache.CachePointBlock,
])
type BedrockAssistantBlock = Schema.Schema.Type<typeof BedrockAssistantBlock>

const BedrockMessage = Schema.Union([
  Schema.Struct({ role: Schema.Literal("user"), content: Schema.Array(BedrockUserBlock) }),
  Schema.Struct({ role: Schema.Literal("assistant"), content: Schema.Array(BedrockAssistantBlock) }),
]).pipe(Schema.toTaggedUnion("role"))
type BedrockMessage = Schema.Schema.Type<typeof BedrockMessage>

const BedrockSystemBlock = Schema.Union([BedrockTextBlock, BedrockCache.CachePointBlock])
type BedrockSystemBlock = Schema.Schema.Type<typeof BedrockSystemBlock>

const BedrockToolSpec = Schema.Struct({
  toolSpec: Schema.Struct({
    name: Schema.String,
    description: Schema.optional(Schema.String),
    inputSchema: Schema.Struct({
      json: JsonObject,
    }),
  }),
})
type BedrockToolSpec = Schema.Schema.Type<typeof BedrockToolSpec>

const BedrockTool = Schema.Union([BedrockToolSpec, BedrockCache.CachePointBlock])
type BedrockTool = Schema.Schema.Type<typeof BedrockTool>

const BedrockToolChoice = Schema.Union([
  Schema.Struct({ auto: Schema.Struct({}) }),
  Schema.Struct({ any: Schema.Struct({}) }),
  Schema.Struct({ tool: Schema.Struct({ name: Schema.String }) }),
])

const BedrockBodyFields = {
  modelId: Schema.String,
  messages: Schema.Array(BedrockMessage),
  system: optionalArray(BedrockSystemBlock),
  inferenceConfig: Schema.optional(
    Schema.Struct({
      maxTokens: Schema.optional(Schema.Number),
      temperature: Schema.optional(Schema.Number),
      topP: Schema.optional(Schema.Number),
      stopSequences: optionalArray(Schema.String),
    }),
  ),
  toolConfig: Schema.optional(
    Schema.Struct({
      tools: Schema.Array(BedrockTool),
      toolChoice: Schema.optional(BedrockToolChoice),
    }),
  ),
  additionalModelRequestFields: Schema.optional(JsonObject),
}
const BedrockConverseBody = Schema.Struct(BedrockBodyFields)
export type BedrockConverseBody = Schema.Schema.Type<typeof BedrockConverseBody>

const BedrockUsageSchema = Schema.Struct({
  inputTokens: Schema.optional(Schema.Number),
  outputTokens: Schema.optional(Schema.Number),
  totalTokens: Schema.optional(Schema.Number),
  cacheReadInputTokens: Schema.optional(Schema.Number),
  cacheWriteInputTokens: Schema.optional(Schema.Number),
})
type BedrockUsageSchema = Schema.Schema.Type<typeof BedrockUsageSchema>

const BedrockStreamException = Schema.Struct({
  message: Schema.optional(Schema.String),
  originalMessage: Schema.optional(Schema.String),
  originalStatusCode: Schema.optional(Schema.Number),
})

// Streaming event shape — the AWS event stream wraps each JSON payload by its
// `:event-type` header (e.g. `messageStart`, `contentBlockDelta`). We
// reconstruct that wrapping in `decodeFrames` below so the event schema can
// stay a plain discriminated record.
const BedrockEvent = Schema.Struct({
  messageStart: Schema.optional(Schema.Struct({ role: Schema.String })),
  contentBlockStart: Schema.optional(
    Schema.Struct({
      contentBlockIndex: Schema.Number,
      start: Schema.optional(
        Schema.Struct({
          toolUse: Schema.optional(Schema.Struct({ toolUseId: Schema.String, name: Schema.String })),
        }),
      ),
    }),
  ),
  contentBlockDelta: Schema.optional(
    Schema.Struct({
      contentBlockIndex: Schema.Number,
      delta: Schema.optional(
        Schema.Struct({
          text: Schema.optional(Schema.String),
          toolUse: Schema.optional(Schema.Struct({ input: Schema.String })),
          reasoningContent: Schema.optional(
            Schema.Struct({
              text: Schema.optional(Schema.String),
              signature: Schema.optional(Schema.String),
              // Blob fields in Bedrock's JSON event stream are base64 strings.
              redactedContent: Schema.optional(Schema.String),
              // Vercel's Bedrock provider exposes the same delta under
              // Anthropic's shorter `data` spelling.
              data: Schema.optional(Schema.String),
            }),
          ),
        }),
      ),
    }),
  ),
  contentBlockStop: Schema.optional(Schema.Struct({ contentBlockIndex: Schema.Number })),
  messageStop: Schema.optional(
    Schema.Struct({
      stopReason: Schema.String,
      additionalModelResponseFields: Schema.optional(Schema.Unknown),
    }),
  ),
  metadata: Schema.optional(
    Schema.Struct({
      usage: Schema.optional(BedrockUsageSchema),
      metrics: Schema.optional(Schema.Unknown),
    }),
  ),
  exception: Schema.optional(Schema.Struct({ type: Schema.String, details: BedrockStreamException })),
})
type BedrockEvent = Schema.Schema.Type<typeof BedrockEvent>

// =============================================================================
// Request Lowering
// =============================================================================
const lowerToolSpec = (tool: ToolDefinition, inputSchema: JsonSchema): BedrockToolSpec => ({
  toolSpec: {
    name: tool.name,
    ...(tool.description.trim().length > 0 ? { description: tool.description } : {}),
    inputSchema: { json: inputSchema },
  },
})

const lowerTools = (
  compatibility: LanguageModelToolSchemaCompatibility | undefined,
  breakpoints: BedrockCache.Breakpoints,
  tools: ReadonlyArray<ToolDefinition>,
): BedrockTool[] => {
  const result: BedrockTool[] = []
  for (const tool of tools) {
    result.push(lowerToolSpec(tool, ToolSchemaProjection.modelCompatibility(tool.inputSchema, compatibility)))
    const cachePoint = BedrockCache.block(breakpoints, tool.cache)
    if (cachePoint) result.push(cachePoint)
  }
  return result
}

const textWithCache = (
  breakpoints: BedrockCache.Breakpoints,
  text: string,
  cache: CacheHint | undefined,
): Array<BedrockTextBlock | BedrockCache.CachePointBlock> => {
  const cachePoint = BedrockCache.block(breakpoints, cache)
  return cachePoint ? [{ text }, cachePoint] : [{ text }]
}

const lowerToolChoice = (toolChoice: NonNullable<LLMRequest["toolChoice"]>) =>
  ProviderShared.matchToolChoice("Bedrock Converse", toolChoice, {
    auto: () => ({ auto: {} }) as const,
    none: () => undefined,
    required: () => ({ any: {} }) as const,
    tool: (name) => ({ tool: { name } }) as const,
  })

const providerMetadata = (key: string, metadata: Record<string, unknown>): ProviderMetadata => ({ [key]: metadata })

const reasoningSignature = (part: ReasoningPart, providerMetadataKey: string) => {
  const metadata = part.providerMetadata?.[providerMetadataKey]
  if (part.encrypted !== undefined) return part.encrypted
  if (ProviderShared.isRecord(metadata) && typeof metadata.signature === "string") return metadata.signature
}

const reasoningRedactedData = (part: ReasoningPart, providerMetadataKey: string) => {
  const metadata = part.providerMetadata?.[providerMetadataKey]
  if (ProviderShared.isRecord(metadata) && typeof metadata.redactedData === "string") return metadata.redactedData
}

const removeEmptyToolInputKeys = (input: unknown): unknown => {
  if (Array.isArray(input)) return input.map(removeEmptyToolInputKeys)
  if (!ProviderShared.isRecord(input)) return input
  return Object.fromEntries(
    Object.entries(input).flatMap(([key, value]) => (key === "" ? [] : [[key, removeEmptyToolInputKeys(value)]])),
  )
}

const lowerToolCall = (part: ToolCallPart): BedrockToolUseBlock => ({
  toolUse: {
    toolUseId: part.id,
    // Models can emit names that Converse rejects when replayed in history.
    name: part.name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) || "_",
    input: removeEmptyToolInputKeys(part.input),
  },
})

const lowerToolResultContent = Effect.fn("BedrockConverse.lowerToolResultContent")(function* (part: ToolResultPart) {
  if (part.result.type === "text" || part.result.type === "error")
    return [{ text: ProviderShared.toolResultText(part) }]
  if (part.result.type === "json") return [{ json: part.result.value }]

  const content: Array<Schema.Schema.Type<typeof BedrockToolResultContentItem>> = []
  for (const item of part.result.value) {
    if (item.type === "text") {
      content.push({ text: item.text })
      continue
    }
    const media = yield* BedrockMedia.lower({
      type: "media",
      mediaType: item.mime,
      data: item.uri,
      filename: item.name,
    })
    content.push(media)
  }
  return content
})

const lowerToolResult = Effect.fn("BedrockConverse.lowerToolResult")(function* (part: ToolResultPart) {
  return {
    toolResult: {
      toolUseId: part.id,
      content: yield* lowerToolResultContent(part),
      status: part.result.type === "error" ? "error" : "success",
    },
  } satisfies BedrockToolResultBlock
})

const lowerMessages = Effect.fn("BedrockConverse.lowerMessages")(function* (
  request: LLMRequest,
  breakpoints: BedrockCache.Breakpoints,
) {
  const messages: BedrockMessage[] = []
  const providerMetadataKey = request.model.route.providerMetadataKey ?? String(request.model.provider)

  for (const message of request.messages) {
    if (message.role === "system") {
      const part = yield* ProviderShared.wrappedSystemUpdate("Bedrock Converse", message)
      const content = textWithCache(breakpoints, part.text, part.cache)
      const previous = messages.at(-1)
      if (previous?.role === "user")
        messages[messages.length - 1] = { role: "user", content: [...previous.content, ...content] }
      else messages.push({ role: "user", content })
      continue
    }

    if (message.role === "user") {
      const content: BedrockUserBlock[] = []
      for (const part of message.content) {
        if (!ProviderShared.supportsContent(part, ["text", "media"]))
          return yield* ProviderShared.unsupportedContent("Bedrock Converse", "user", ["text", "media"])
        if (part.type === "text") {
          content.push(...textWithCache(breakpoints, part.text, part.cache))
          continue
        }
        if (part.type === "media") {
          content.push(yield* BedrockMedia.lower(part))
          continue
        }
      }
      const previous = messages.at(-1)
      if (previous?.role === "user")
        messages[messages.length - 1] = { role: "user", content: [...previous.content, ...content] }
      else messages.push({ role: "user", content })
      continue
    }

    if (message.role === "assistant") {
      const content: BedrockAssistantBlock[] = []
      for (const part of message.content) {
        if (!ProviderShared.supportsContent(part, ["text", "reasoning", "tool-call"]))
          return yield* ProviderShared.unsupportedContent("Bedrock Converse", "assistant", [
            "text",
            "reasoning",
            "tool-call",
          ])
        if (part.type === "text") {
          content.push(...textWithCache(breakpoints, part.text, part.cache))
          continue
        }
        if (part.type === "reasoning") {
          const signature = reasoningSignature(part, providerMetadataKey)
          const redactedData = reasoningRedactedData(part, providerMetadataKey)
          if (signature === undefined && redactedData !== undefined) {
            content.push({ reasoningContent: { redactedContent: redactedData } })
            continue
          }
          if (signature === undefined || signature.trim().length === 0) {
            // Interrupted streams and model switches can leave unsigned reasoning.
            // Preserve readable history as text rather than replay invalid reasoningContent.
            if (part.text.trim().length > 0) content.push(...textWithCache(breakpoints, part.text, part.cache))
            continue
          }
          content.push({ reasoningContent: { reasoningText: { text: part.text, signature } } })
          continue
        }
        if (part.type === "tool-call") {
          content.push(lowerToolCall(part))
          continue
        }
      }
      if (content.length > 0) messages.push({ role: "assistant", content })
      continue
    }

    const content: BedrockUserBlock[] = []
    for (const part of message.content) {
      if (!ProviderShared.supportsContent(part, ["tool-result"]))
        return yield* ProviderShared.unsupportedContent("Bedrock Converse", "tool", ["tool-result"])
      content.push(yield* lowerToolResult(part))
      const cachePoint = BedrockCache.block(breakpoints, part.cache)
      if (cachePoint) content.push(cachePoint)
    }
    const previous = messages.at(-1)
    if (previous?.role === "user")
      messages[messages.length - 1] = { role: "user", content: [...previous.content, ...content] }
    else messages.push({ role: "user", content })
  }

  return messages
})

// System prompts share the cache-point convention: emit the text block, then
// optionally a positional `cachePoint` marker.
const lowerSystem = (breakpoints: BedrockCache.Breakpoints, system: ReadonlyArray<LLMRequest["system"][number]>) => {
  const content = system
    .filter((part) => part.text.length > 0)
    .flatMap((part) => textWithCache(breakpoints, part.text, part.cache))
  return content.length === 0 ? undefined : content
}

const fromRequest = Effect.fn("BedrockConverse.fromRequest")(function* (request: LLMRequest) {
  const toolChoice = request.toolChoice ? yield* lowerToolChoice(request.toolChoice) : undefined
  const flattened = ProviderShared.flattenToolRequest(request)
  const generation = request.generation
  // Bedrock-Claude shares Anthropic's 4-breakpoint cap. Spend the budget in
  // tools → system → messages order to favour the highest-impact prefixes.
  const breakpoints = BedrockCache.breakpoints(request.model.id)
  const toolConfig = (() => {
    if (flattened.tools.length === 0) return undefined
    return {
      tools: lowerTools(request.model.compatibility?.toolSchema, breakpoints, flattened.tools),
      // Converse has no native "none". Keep definitions stable for prompt
      // caching and omit only the unsupported choice.
      toolChoice,
    }
  })()
  const system = lowerSystem(breakpoints, request.system)
  const messages = yield* lowerMessages(flattened.request, breakpoints)
  if (breakpoints.dropped > 0) {
    yield* Effect.logWarning(
      `Bedrock Converse: dropped ${breakpoints.dropped} cache breakpoint(s); the API allows at most ${BedrockCache.BEDROCK_BREAKPOINT_CAP} per request.`,
    )
  }
  const inferenceConfig = (() => {
    if (
      generation?.maxTokens === undefined &&
      generation?.temperature === undefined &&
      generation?.topP === undefined &&
      (generation?.stop === undefined || generation.stop.length === 0)
    )
      return undefined
    return {
      maxTokens: generation?.maxTokens,
      temperature: generation?.temperature,
      topP: generation?.topP,
      stopSequences: generation?.stop,
    }
  })()
  return {
    modelId: request.model.id,
    messages,
    system,
    inferenceConfig,
    toolConfig,
    // Converse's base inferenceConfig has no topK; Anthropic/Nova accept it
    // as a model-specific field, so it goes through additionalModelRequestFields.
    additionalModelRequestFields: generation?.topK === undefined ? undefined : { top_k: generation.topK },
  }
})

// =============================================================================
// Stream Parsing
// =============================================================================
const mapFinishReason = (reason: string): FinishReason => {
  if (reason === "end_turn" || reason === "stop_sequence") return "stop"
  if (reason === "max_tokens" || reason === "model_context_window_exceeded") return "length"
  if (reason === "tool_use") return "tool-calls"
  if (reason === "content_filtered" || reason === "guardrail_intervened") return "content-filter"
  return "unknown"
}

// AWS reports inputTokens separately from cache reads and writes.
// Bedrock does not break reasoning out of outputTokens for current models.
const mapUsage = (usage: BedrockUsageSchema | undefined, providerMetadataKey: string): Usage | undefined => {
  if (!usage) return undefined
  const inputTokens = ProviderShared.sumTokens(
    usage.inputTokens,
    usage.cacheReadInputTokens,
    usage.cacheWriteInputTokens,
  )
  return new Usage({
    inputTokens,
    outputTokens: usage.outputTokens,
    nonCachedInputTokens: usage.inputTokens,
    cacheReadInputTokens: usage.cacheReadInputTokens,
    cacheWriteInputTokens: usage.cacheWriteInputTokens,
    totalTokens: ProviderShared.totalTokens(inputTokens, usage.outputTokens, usage.totalTokens),
    providerMetadata: { [providerMetadataKey]: usage },
  })
}

interface ParserState {
  readonly providerMetadataKey: string
  readonly tools: ToolStream.State<number>
  // Bedrock splits the finish into `messageStop` (carries `stopReason`) and
  // `metadata` (carries usage). Hold both in state so `onHalt` can emit exactly
  // one finish after both chunks have had a chance to arrive.
  readonly finishReason: FinishReasonDetails | undefined
  readonly usage: Usage | undefined
  readonly hasToolCalls: boolean
  readonly lifecycle: Lifecycle.State
  readonly reasoningSignatures: Readonly<Record<number, string>>
  readonly reasoningRedactedContent: Readonly<Record<number, ReadonlyArray<Uint8Array>>>
}

const encodeRedactedContent = (chunks: ReadonlyArray<Uint8Array>) => {
  const bytes = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0))
  chunks.reduce((offset, chunk) => {
    bytes.set(chunk, offset)
    return offset + chunk.length
  }, 0)
  return Encoding.encodeBase64(bytes)
}

const step = (state: ParserState, event: BedrockEvent) =>
  Effect.gen(function* () {
    if (event.contentBlockStart?.start?.toolUse) {
      const index = event.contentBlockStart.contentBlockIndex
      const events: LLMEvent[] = []
      const lifecycle = Lifecycle.stepStart(state.lifecycle, events)
      return [
        {
          ...state,
          lifecycle,
          tools: ToolStream.start(state.tools, index, {
            id: event.contentBlockStart.start.toolUse.toolUseId,
            name: event.contentBlockStart.start.toolUse.name,
          }),
        },
        [
          ...events,
          LLMEvent.toolInputStart({
            id: event.contentBlockStart.start.toolUse.toolUseId,
            name: event.contentBlockStart.start.toolUse.name,
          }),
        ],
      ] as const
    }

    if (event.contentBlockDelta?.delta?.text) {
      const events: LLMEvent[] = []
      return [
        {
          ...state,
          lifecycle: Lifecycle.textDelta(
            state.lifecycle,
            events,
            `text-${event.contentBlockDelta.contentBlockIndex}`,
            event.contentBlockDelta.delta.text,
          ),
        },
        events,
      ] as const
    }

    if (event.contentBlockDelta?.delta?.reasoningContent) {
      const index = event.contentBlockDelta.contentBlockIndex
      const reasoning = event.contentBlockDelta.delta.reasoningContent
      const events: LLMEvent[] = []
      const redactedChunks = yield* (() => {
        if (reasoning.redactedContent === undefined) return Effect.succeed(undefined)
        return Effect.fromResult(Encoding.decodeBase64(reasoning.redactedContent)).pipe(
          Effect.map((chunk) => [...(state.reasoningRedactedContent[index] ?? []), chunk]),
          Effect.mapError((cause) =>
            ProviderShared.eventError(
              ADAPTER,
              "Bedrock Converse reasoningContent.redactedContent contains invalid base64 data",
              undefined,
              cause,
            ),
          ),
        )
      })()
      const redactedData = redactedChunks === undefined ? reasoning.data : encodeRedactedContent(redactedChunks)
      const metadata = (() => {
        if (reasoning.signature) return providerMetadata(state.providerMetadataKey, { signature: reasoning.signature })
        if (redactedData !== undefined) return providerMetadata(state.providerMetadataKey, { redactedData })
      })()
      const lifecycle = (() => {
        if (reasoning.text === undefined && metadata === undefined) return state.lifecycle
        return Lifecycle.reasoningDelta(state.lifecycle, events, `reasoning-${index}`, reasoning.text ?? "", metadata)
      })()
      const reasoningRedactedContent = (() => {
        if (redactedChunks !== undefined) return { ...state.reasoningRedactedContent, [index]: redactedChunks }
        if (reasoning.data === undefined) return state.reasoningRedactedContent
        return Object.fromEntries(
          Object.entries(state.reasoningRedactedContent).filter(([key]) => key !== String(index)),
        )
      })()
      const reasoningSignatures = (() => {
        if (!reasoning.signature) return state.reasoningSignatures
        return { ...state.reasoningSignatures, [index]: reasoning.signature }
      })()
      return [
        {
          ...state,
          lifecycle,
          reasoningSignatures,
          reasoningRedactedContent,
        },
        events,
      ] as const
    }

    if (event.contentBlockDelta?.delta?.toolUse) {
      // A delta for a block that is not open, whether it already stopped or never
      // started, has nothing to attach to and is dropped.
      const result = ToolStream.append(
        state.tools,
        event.contentBlockDelta.contentBlockIndex,
        event.contentBlockDelta.delta.toolUse.input,
      )
      if (!result) return [state, []] as const
      const events: LLMEvent[] = []
      const lifecycle = result.events.length ? Lifecycle.stepStart(state.lifecycle, events) : state.lifecycle
      events.push(...result.events)
      return [{ ...state, lifecycle, tools: result.tools }, events] as const
    }

    if (event.contentBlockStop) {
      const index = event.contentBlockStop.contentBlockIndex
      const result = yield* ToolStream.finish(ADAPTER, state.tools, index)
      const events: LLMEvent[] = []
      const resultEvents = result.events ?? []
      const lifecycle = (() => {
        if (resultEvents.length) return Lifecycle.stepStart(state.lifecycle, events)
        const metadata = (() => {
          const signature = state.reasoningSignatures[index]
          if (signature) return providerMetadata(state.providerMetadataKey, { signature })
          const redactedContent = state.reasoningRedactedContent[index]
          if (redactedContent)
            return providerMetadata(state.providerMetadataKey, {
              redactedData: encodeRedactedContent(redactedContent),
            })
        })()
        return Lifecycle.reasoningEnd(
          Lifecycle.textEnd(state.lifecycle, events, `text-${index}`),
          events,
          `reasoning-${index}`,
          metadata,
        )
      })()
      events.push(...resultEvents)
      return [
        {
          ...state,
          hasToolCalls:
            resultEvents.some((event) => LLMEvent.is.toolCall(event) || LLMEvent.is.toolInputError(event)) ||
            state.hasToolCalls,
          lifecycle,
          tools: result.tools,
          reasoningSignatures: Object.fromEntries(
            Object.entries(state.reasoningSignatures).filter(([key]) => key !== String(index)),
          ),
          reasoningRedactedContent: Object.fromEntries(
            Object.entries(state.reasoningRedactedContent).filter(([key]) => key !== String(index)),
          ),
        },
        events,
      ] as const
    }

    if (event.messageStop) {
      if (
        event.messageStop.stopReason === "malformed_model_output" ||
        event.messageStop.stopReason === "malformed_tool_use"
      )
        return yield* ProviderShared.eventError(
          ADAPTER,
          `Bedrock Converse stopped with ${event.messageStop.stopReason}`,
          ProviderShared.encodeJson(event),
        )
      return [
        {
          ...state,
          finishReason: {
            normalized: mapFinishReason(event.messageStop.stopReason),
            raw: event.messageStop.stopReason,
          },
        },
        [],
      ] as const
    }

    if (event.metadata) {
      const usage = mapUsage(event.metadata.usage, state.providerMetadataKey) ?? state.usage
      return [
        {
          ...state,
          usage,
        },
        [],
      ] as const
    }

    if (event.exception) {
      const message =
        event.exception.details.message ?? event.exception.details.originalMessage ?? "Bedrock Converse stream error"
      const body = ProviderShared.encodeJson(event)
      return yield* new AIError({
        reason: classifyProviderFailure({
          message,
          rawBody: body,
        }),
      })
    }

    return [state, []] as const
  })

const framing = BedrockEventStream.framing(ADAPTER)

const onHalt = (state: ParserState): ReadonlyArray<LLMEvent> => {
  if (!state.finishReason) return []
  const normalized = (() => {
    if (state.finishReason.normalized === "stop" && state.hasToolCalls) return "tool-calls"
    return state.finishReason.normalized
  })()
  const events: LLMEvent[] = []
  Lifecycle.finish(state.lifecycle, events, {
    reason: {
      ...state.finishReason,
      normalized,
    },
    usage: state.usage,
  })
  return events
}

// =============================================================================
// Protocol And Bedrock Route
// =============================================================================
/**
 * The Bedrock Converse protocol — request body construction, body schema, and
 * the streaming-event state machine.
 */
export const protocol = Protocol.make({
  id: ADAPTER,
  body: {
    schema: BedrockConverseBody,
    from: fromRequest,
  },
  stream: {
    event: BedrockEvent,
    initial: (request) => ({
      providerMetadataKey: request.model.route.providerMetadataKey ?? String(request.model.provider),
      tools: ToolStream.empty<number>(),
      finishReason: undefined,
      usage: undefined,
      hasToolCalls: false,
      lifecycle: Lifecycle.initial(),
      reasoningSignatures: {},
      reasoningRedactedContent: {},
    }),
    step,
    onHalt: (state) => Effect.succeed(onHalt(state)),
  },
})

export const route = Route.make({
  id: ADAPTER,
  provider: "bedrock",
  providerMetadataKey: "bedrock",
  protocol,
  // Bedrock's URL embeds the region in the route endpoint host and the
  // validated modelId in the path. We read the validated body so the URL
  // matches the body that gets signed.
  endpoint: Endpoint.path<BedrockConverseBody>(
    ({ body }) => `/model/${encodeURIComponent(body.modelId)}/converse-stream`,
  ),
  auth: BedrockAuth.auth,
  framing,
})

export const sigV4Auth = BedrockAuth.sigV4

export * as BedrockConverse from "./bedrock-converse.js"
