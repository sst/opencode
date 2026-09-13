export * as SessionCompaction from "./compaction"

import {
  LLM,
  LLMError,
  LLMEvent,
  Message,
  mergeGenerationOptions,
  type LLMRequest,
  type Model,
  type Usage,
} from "@opencode-ai/llm"
import { SessionCompaction } from "@opencode-ai/schema/session-compaction"
import { DateTime, Effect, Stream } from "effect"
import type { Config } from "../config"
import type { EventV2 } from "../event"
import { SessionEvent } from "./event"
import { SessionMessage } from "./message"
import { SessionSchema } from "./schema"
import {
  SessionCompactionSuffix,
  SUMMARY_OUTPUT_TOKENS,
  SUMMARY_TEMPLATE,
  SUMMARY_UPDATE_INSTRUCTIONS,
} from "./compaction-suffix"
import { Token } from "../util/token"

const DEFAULT_BUFFER = 20_000
const DEFAULT_KEEP_TOKENS = 8_000
const TOOL_OUTPUT_MAX_CHARS = 2_000
type Entry = {
  readonly seq: number
  readonly message: SessionMessage.Message
}

type Selected = {
  readonly head: string
  readonly recent: string
  readonly firstRecent?: Entry
  readonly recentMessageCount: number
  readonly recentTurnCount: number
}

type Settings = {
  readonly auto: boolean
  readonly buffer: number
  readonly tokens: number
  readonly mode: "prepend" | "suffix"
}

type Dependencies = {
  readonly events: Pick<EventV2.Interface, "publish">
  readonly llm: {
    readonly stream: (request: LLMRequest) => Stream.Stream<LLMEvent, LLMError>
  }
  readonly config: readonly Config.Entry[]
}

type Input = {
  readonly sessionID: SessionSchema.ID
  readonly entries: readonly Entry[]
  readonly model: Model
  readonly request: LLMRequest
}

const estimate = (value: unknown) => Token.estimate(JSON.stringify(value))

const truncate = (value: string) =>
  value.length <= TOOL_OUTPUT_MAX_CHARS ? value : `${value.slice(0, TOOL_OUTPUT_MAX_CHARS)}\n[truncated]`

export const serializeToolContent = (content: SessionMessage.ToolStateCompleted["content"]) =>
  content
    .map((item) =>
      item.type === "text" ? item.text : `[Attached ${item.mime}${item.name === undefined ? "" : `: ${item.name}`}]`,
    )
    .join("\n")

const serialize = (message: SessionMessage.Message) => {
  if (message.type === "user") {
    const files = message.files?.map((file) => `[Attached ${file.mime}: ${file.name ?? file.uri}]`) ?? []
    return [`[User]: ${message.text}`, ...files].join("\n")
  }
  if (message.type === "assistant") {
    return message.content
      .flatMap((part) => {
        if (part.type === "text") return [`[Assistant]: ${part.text}`]
        if (part.type === "reasoning") return part.text ? [`[Assistant reasoning]: ${part.text}`] : []
        const input = typeof part.state.input === "string" ? part.state.input : JSON.stringify(part.state.input)
        if (part.state.status === "completed")
          return [
            `[Assistant tool call]: ${part.name}(${input})`,
            `[Tool result]: ${truncate(serializeToolContent(part.state.content))}`,
          ]
        if (part.state.status === "error")
          return [`[Assistant tool call]: ${part.name}(${input})`, `[Tool error]: ${part.state.error.message}`]
        return [`[Assistant tool call]: ${part.name}(${input})`]
      })
      .join("\n")
  }
  if (message.type === "system") return `[System update]: ${message.text}`
  if (message.type === "synthetic") return `[Synthetic context]: ${message.text}`
  if (message.type === "shell") return `[Shell]: ${message.command}\n${truncate(message.output)}`
  return ""
}

const settings = (documents: readonly Config.Entry[]) => {
  const configured = documents
    .filter((entry): entry is Config.Document => entry.type === "document")
    .flatMap((entry) => (entry.info.compaction ? [entry.info.compaction] : []))
  return configured.reduce<Settings>(
    (result, current) => ({
      auto: current.auto ?? result.auto,
      buffer: current.buffer ?? result.buffer,
      tokens: current.keep?.tokens ?? result.tokens,
      mode: current.mode ?? result.mode,
    }),
    { auto: true, buffer: DEFAULT_BUFFER, tokens: DEFAULT_KEEP_TOKENS, mode: "prepend" },
  )
}

const select = (entries: readonly Entry[], tokens: number): Selected | undefined => {
  const conversation = entries
    .filter((entry) => entry.message.type !== "compaction")
    .map((entry) => ({ entry, text: serialize(entry.message) }))
    .filter((item) => Boolean(item.text))
  if (conversation.length === 0) return
  let total = 0
  let split = conversation.length
  for (let index = conversation.length - 1; index >= 0; index--) {
    const next = total + Token.estimate(conversation[index].text)
    if (next > tokens) break
    total = next
    split = index
  }
  return {
    head: conversation
      .slice(0, split)
      .map((item) => item.text)
      .join("\n\n"),
    recent: conversation
      .slice(split)
      .map((item) => item.text)
      .join("\n\n"),
    firstRecent: conversation[split]?.entry,
    recentMessageCount: conversation.length - split,
    recentTurnCount: conversation.slice(split).filter((item) => item.entry.message.type === "user").length,
  }
}

const tokens = (usage: Usage | undefined) => {
  const value = (field: "inputTokens" | "cacheReadInputTokens" | "outputTokens") => {
    const current = usage?.[field]
    return typeof current === "number" && Number.isFinite(current) ? current : undefined
  }
  const input = value("inputTokens")
  const cached = value("cacheReadInputTokens")
  const output = value("outputTokens")
  const result = {
    ...(input === undefined ? {} : { input: Math.max(0, Math.round(input)) }),
    ...(cached === undefined ? {} : { cached: Math.max(0, Math.round(cached)) }),
    ...(output === undefined ? {} : { output: Math.max(0, Math.round(output)) }),
  }
  if (!Object.keys(result).length) return
  return result
}

export const buildPrompt = (input: { readonly previousSummary?: string; readonly context: readonly string[] }) => {
  const conversation = `Here is the conversation so far:\n\n<conversation>\n${input.context.join("\n\n")}\n</conversation>`
  if (!input.previousSummary)
    return [
      conversation,
      "Create a new anchored summary from the conversation history in the <conversation> tags above so another coding agent can continue the work.",
      SUMMARY_TEMPLATE,
    ].join("\n\n")
  return [
    conversation,
    `Here is the summary of the conversation before the <conversation> above:\n\n<prior-summary>\n${input.previousSummary}\n</prior-summary>`,
    SUMMARY_UPDATE_INSTRUCTIONS,
    SUMMARY_TEMPLATE,
  ].join("\n\n")
}

export const make = (dependencies: Dependencies) => {
  const config = settings(dependencies.config)
  const compactAfterOverflow = Effect.fn("SessionCompaction.compactAfterOverflow")(function* (input: Input) {
    const context = input.model.route.defaults.limits?.context
    if (context === undefined || context <= 0) return false
    const output = input.request.generation?.maxTokens ?? input.model.route.defaults.limits?.output ?? 0
    const selected = select(input.entries, config.tokens)
    const previousSummary = input.entries.find((entry) => entry.message.type === "compaction")?.message
    if (!selected || (selected.head.length === 0 && previousSummary?.type !== "compaction")) return false
    const summaryPrompt = buildPrompt({
      previousSummary: previousSummary?.type === "compaction" ? previousSummary.summary : undefined,
      context: [previousSummary?.type === "compaction" ? previousSummary.recent : "", selected.head].filter(Boolean),
    })
    const summaryOutput = Math.min(output || SUMMARY_OUTPUT_TOKENS, SUMMARY_OUTPUT_TOKENS)
    const prependFits = Token.estimate(summaryPrompt) <= context - summaryOutput
    if (config.mode === "prepend" && !prependFits) return false
    const requested = config.mode
    const messageID = SessionMessage.ID.create()
    const started = yield* DateTime.now
    yield* dependencies.events.publish(SessionEvent.Compaction.Started, {
      sessionID: input.sessionID,
      messageID,
      timestamp: started,
      reason: "auto",
      requested,
    })
    let attempted: SessionCompaction.Mode | undefined
    let attemptedUsage: Usage | undefined
    let terminal = false
    const diagnostics = (
      input: { readonly fallback?: SessionCompaction.FallbackReason; readonly usage?: Usage } = {},
    ) =>
      Effect.gen(function* () {
        const diagnosticTokens = tokens(input.usage ?? attemptedUsage)
        return {
          requested,
          ...(attempted ? { used: attempted } : {}),
          ...(input.fallback ? { fallback: input.fallback } : {}),
          durationMs: Math.max(
            0,
            Math.round(DateTime.toEpochMillis(yield* DateTime.now) - DateTime.toEpochMillis(started)),
          ),
          ...(diagnosticTokens ? { tokens: diagnosticTokens } : {}),
        }
      })
    const run = (
      request: LLMRequest,
      mode: SessionCompaction.Mode,
    ): Effect.Effect<
      { summary: string; usage: Usage | undefined } | { failure: SessionCompaction.FallbackReason; usage?: Usage }
    > =>
      Effect.gen(function* () {
        attempted = mode
        attemptedUsage = undefined
        const chunks: string[] = []
        let failure: SessionCompaction.FallbackReason | undefined
        let usage: Usage | undefined
        const streamed = yield* dependencies.llm.stream(request).pipe(
          Stream.runForEach((event) => {
            if (LLMEvent.is.providerError(event)) failure = "provider_error"
            if (LLMEvent.is.toolCall(event)) failure = "tool_call"
            if (LLMEvent.is.textDelta(event)) chunks.push(event.text)
            if (LLMEvent.is.stepFinish(event) || LLMEvent.is.finish(event)) {
              usage = event.usage
              attemptedUsage = usage
            }
            return Effect.void
          }),
          Effect.as(true),
          Effect.catchTag("LLM.Error", () => Effect.succeed(false)),
        )
        const summary = chunks.join("")
        if (!streamed || failure) return { failure: failure ?? "provider_error", usage }
        if (!summary.trim()) return { failure: "empty_summary" as const, usage }
        if (mode === "suffix" && !SessionCompactionSuffix.validateSummary(summary))
          return { failure: "invalid_summary" as const, usage }
        return { summary, usage }
      })
    const prepend = () =>
      prependFits
        ? run(
            LLM.request({
              model: input.model,
              http: input.request.http,
              messages: [Message.user(summaryPrompt)],
              tools: [],
              generation: { maxTokens: summaryOutput },
            }),
            "prepend",
          )
        : Effect.succeed({ failure: "context" as const })
    const suffixPrompt = SessionCompactionSuffix.buildPrompt({
      anchor: selected.firstRecent
        ? {
            role: selected.firstRecent.message.type,
            text: serialize(selected.firstRecent.message),
            recentMessageCount: selected.recentMessageCount,
            recentTurnCount: selected.recentTurnCount,
          }
        : { recentMessageCount: selected.recentMessageCount, recentTurnCount: selected.recentTurnCount },
    })
    const suffixRequest = LLM.updateRequest(input.request, {
      messages: [...input.request.messages, Message.user(suffixPrompt)],
      generation: mergeGenerationOptions(input.request.generation, { maxTokens: summaryOutput }),
    })
    const suffixUnavailable =
      input.request.toolChoice && !["auto", "none"].includes(input.request.toolChoice.type)
        ? ("tool_choice" as const)
        : input.request.tools.some((tool) => tool.native !== undefined)
          ? ("provider_tool" as const)
          : undefined
    const suffixFits =
      estimate({
        system: suffixRequest.system,
        messages: suffixRequest.messages,
        tools: suffixRequest.tools,
        toolChoice: suffixRequest.toolChoice,
      }) <=
      context - summaryOutput
    const execute = Effect.gen(function* () {
      const suffix =
        requested === "suffix" && !suffixUnavailable && suffixFits ? yield* run(suffixRequest, "suffix") : undefined
      const suffixSuccess = suffix && "summary" in suffix
      const final = suffixSuccess ? suffix : yield* prepend()
      const fallback =
        (suffix && "failure" in suffix ? suffix.failure : undefined) ??
        (requested === "suffix" ? (suffixUnavailable ?? (!suffixFits ? "context" : undefined)) : undefined)
      const suffixUsage = suffix && "usage" in suffix ? suffix.usage : undefined
      const finalUsage = "usage" in final ? final.usage : undefined
      const completedDiagnostics = yield* diagnostics({ fallback, usage: suffixUsage ?? finalUsage })
      if (!("summary" in final)) {
        yield* Effect.logWarning("session compaction failed", { failure: final.failure, ...completedDiagnostics })
        terminal = true
        yield* Effect.uninterruptible(
          dependencies.events.publish(SessionEvent.Compaction.Failed, {
            sessionID: input.sessionID,
            messageID,
            timestamp: yield* DateTime.now,
            reason: "auto",
            failure: final.failure,
            diagnostics: completedDiagnostics,
          }),
        )
        return false
      }
      yield* Effect.logInfo("session compaction completed", completedDiagnostics)
      terminal = true
      yield* Effect.uninterruptible(
        dependencies.events.publish(SessionEvent.Compaction.Ended, {
          sessionID: input.sessionID,
          messageID,
          timestamp: yield* DateTime.now,
          reason: "auto",
          text: final.summary,
          recent: selected.recent,
          diagnostics: completedDiagnostics,
        }),
      )
      return true
    })
    return yield* execute.pipe(
      Effect.onInterrupt(() =>
        terminal
          ? Effect.void
          : Effect.uninterruptible(
              Effect.gen(function* () {
                yield* dependencies.events.publish(SessionEvent.Compaction.Failed, {
                  sessionID: input.sessionID,
                  messageID,
                  timestamp: yield* DateTime.now,
                  reason: "auto",
                  failure: "interrupted",
                  diagnostics: yield* diagnostics(),
                })
              }),
            ),
      ),
    )
  })
  const compactIfNeeded = Effect.fn("SessionCompaction.compactIfNeeded")(function* (input: Input) {
    if (!config.auto) return false
    const context = input.model.route.defaults.limits?.context
    if (context === undefined || context <= 0) return false
    const output = input.request.generation?.maxTokens ?? input.model.route.defaults.limits?.output ?? 0
    if (
      estimate({ system: input.request.system, messages: input.request.messages, tools: input.request.tools }) <=
      context - Math.max(output, config.buffer)
    )
      return false
    return yield* compactAfterOverflow(input)
  })
  return {
    compactIfNeeded,
    compactAfterOverflow,
  }
}
