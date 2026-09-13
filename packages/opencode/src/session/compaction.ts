import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { Session } from "./session"
import { SessionID, MessageID, PartID } from "./schema"
import { Provider } from "@/provider/provider"
import { MessageV2 } from "./message-v2"
import { Token } from "@/util/token"
import { SessionProcessor } from "./processor"
import { Agent } from "@/agent/agent"
import { Plugin } from "@/plugin"
import { Config } from "@/config/config"
import { NotFoundError } from "@/storage/storage"

import { Effect, Layer, Context } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { isOverflow as overflow, usable } from "./overflow"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { buildPrompt } from "@opencode-ai/core/session/compaction"
import { SessionCompactionEvent } from "@opencode-ai/schema/session-compaction-event"
import { SessionCompaction } from "@opencode-ai/schema/session-compaction"
import { SessionCompactionSuffix, SUMMARY_OUTPUT_TOKENS } from "@opencode-ai/core/session/compaction-suffix"
import { LLM } from "./llm"
import type { Tool } from "ai"

export const Event = SessionCompactionEvent

export const PRUNE_MINIMUM = 20_000
export const PRUNE_PROTECT = 40_000
const TOOL_OUTPUT_MAX_CHARS = 2_000
const PRUNE_PROTECTED_TOOLS = ["skill"]
const MIN_PRESERVE_RECENT_TOKENS = 2_000
const MAX_PRESERVE_RECENT_TOKENS = 15_000
type Turn = {
  start: number
  end: number
  id: MessageID
}

type Tail = {
  start: number
  id: MessageID
}

type CompletedCompaction = {
  userIndex: number
  assistantIndex: number
  summary: string | undefined
}

const truncate = (value: string) =>
  value.length <= TOOL_OUTPUT_MAX_CHARS ? value : `${value.slice(0, TOOL_OUTPUT_MAX_CHARS)}\n[truncated]`

const serialize = (message: SessionV1.WithParts) => {
  if (message.info.role === "user") {
    const text = message.parts
      .filter((part): part is SessionV1.TextPart => part.type === "text" && !part.ignored)
      .map((part) => part.text)
      .filter(Boolean)
      .join("\n")
    const files = message.parts.flatMap((part) =>
      part.type === "file" ? [`[Attached ${part.mime}: ${part.filename ?? "file"}]`] : [],
    )
    return [...(text ? [`[User]: ${text}`] : []), ...files].join("\n")
  }
  return message.parts
    .flatMap((part) => {
      if (part.type === "text") return part.text ? [`[Assistant]: ${part.text}`] : []
      if (part.type === "reasoning") return part.text ? [`[Assistant reasoning]: ${part.text}`] : []
      if (part.type !== "tool") return []
      const call = `[Assistant tool call]: ${part.tool}(${JSON.stringify(part.state.input)})`
      if (part.state.status === "completed") {
        const attachments = (part.state.attachments ?? []).map(
          (item) => `[Attached ${item.mime}: ${item.filename ?? "file"}]`,
        )
        const output = part.state.time.compacted
          ? "[Old tool result content cleared]"
          : truncate([part.state.output, ...attachments].join("\n"))
        return [call, `[Tool result]: ${output}`]
      }
      if (part.state.status === "error") return [call, `[Tool error]: ${part.state.error}`]
      return [call]
    })
    .join("\n")
}

function summaryText(message: SessionV1.WithParts) {
  const text = message.parts
    .filter((part): part is SessionV1.TextPart => part.type === "text")
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join("\n\n")
    .trim()
  return text || undefined
}

function completedCompactions(messages: SessionV1.WithParts[]) {
  const users = new Map<MessageID, number>()
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (msg.info.role !== "user") continue
    if (!msg.parts.some((part) => part.type === "compaction")) continue
    users.set(msg.info.id, i)
  }

  return messages.flatMap((msg, assistantIndex): CompletedCompaction[] => {
    if (msg.info.role !== "assistant") return []
    if (!msg.info.summary || !msg.info.finish || msg.info.error) return []
    const userIndex = users.get(msg.info.parentID)
    if (userIndex === undefined) return []
    return [{ userIndex, assistantIndex, summary: summaryText(msg) }]
  })
}

function preserveRecentBudget(input: { cfg: ConfigV1.Info; model: Provider.Model }) {
  return (
    input.cfg.compaction?.preserve_recent_tokens ??
    Math.min(MAX_PRESERVE_RECENT_TOKENS, Math.max(MIN_PRESERVE_RECENT_TOKENS, Math.floor(usable(input) * 0.25)))
  )
}

function turns(messages: SessionV1.WithParts[]) {
  const result: Turn[] = []
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (msg.info.role !== "user") continue
    if (msg.parts.some((part) => part.type === "compaction")) continue
    result.push({
      start: i,
      end: messages.length,
      id: msg.info.id,
    })
  }
  for (let i = 0; i < result.length - 1; i++) {
    result[i].end = result[i + 1].start
  }
  return result
}

function splitTurn(input: {
  messages: SessionV1.WithParts[]
  turn: Turn
  model: Provider.Model
  budget: number
  estimate: (input: { messages: SessionV1.WithParts[]; model: Provider.Model }) => Effect.Effect<number>
}) {
  return Effect.gen(function* () {
    if (input.budget <= 0) return undefined
    if (input.turn.end - input.turn.start <= 1) return undefined
    for (let start = input.turn.start + 1; start < input.turn.end; start++) {
      const size = yield* input.estimate({
        messages: input.messages.slice(start, input.turn.end),
        model: input.model,
      })
      if (size > input.budget) continue
      return {
        start,
        id: input.messages[start]!.info.id,
      } satisfies Tail
    }
    return undefined
  })
}

export interface Interface {
  readonly isOverflow: (input: {
    tokens: SessionV1.Assistant["tokens"]
    model: Provider.Model
  }) => Effect.Effect<boolean>
  readonly prune: (input: { sessionID: SessionID }) => Effect.Effect<void>
  readonly process: (input: {
    parentID: MessageID
    messages: SessionV1.WithParts[]
    sessionID: SessionID
    auto: boolean
    overflow?: boolean
    capture?: { request: LLM.InternalStreamInput; messageIDs: ReadonlySet<MessageID> }
    rebuild?: (input: {
      messages: SessionV1.WithParts[]
      processor: SessionProcessor.Handle
      model: Provider.Model
    }) => Effect.Effect<LLM.InternalStreamInput>
  }) => Effect.Effect<"continue" | "stop">
  readonly create: (input: {
    sessionID: SessionID
    agent: string
    model: { providerID: ProviderV2.ID; modelID: ModelV2.ID }
    auto: boolean
    overflow?: boolean
  }) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionCompaction") {}

export const use = serviceUse(Service)

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const session = yield* Session.Service
    const agents = yield* Agent.Service
    const plugin = yield* Plugin.Service
    const processors = yield* SessionProcessor.Service
    const provider = yield* Provider.Service
    const events = yield* EventV2Bridge.Service
    const flags = yield* RuntimeFlags.Service

    const isOverflow = Effect.fn("SessionCompaction.isOverflow")(function* (input: {
      tokens: SessionV1.Assistant["tokens"]
      model: Provider.Model
    }) {
      return overflow({
        cfg: yield* config.get(),
        tokens: input.tokens,
        model: input.model,
        outputTokenMax: flags.outputTokenMax,
      })
    })

    const estimate = Effect.fn("SessionCompaction.estimate")(function* (input: {
      messages: SessionV1.WithParts[]
      model: Provider.Model
    }) {
      const msgs = yield* MessageV2.toModelMessagesEffect(input.messages, input.model)
      return Token.estimate(JSON.stringify(msgs))
    })

    const select = Effect.fn("SessionCompaction.select")(function* (input: {
      messages: SessionV1.WithParts[]
      cfg: ConfigV1.Info
      model: Provider.Model
    }) {
      const limit = input.cfg.compaction?.tail_turns
      if (limit !== undefined && limit <= 0) return { head: input.messages, tail_start_id: undefined }
      const budget = preserveRecentBudget({ cfg: input.cfg, model: input.model })
      const all = turns(input.messages)
      if (!all.length) return { head: input.messages, tail_start_id: undefined }
      const recent = limit === undefined ? all : all.slice(-limit)

      let total = 0
      let keep: Tail | undefined
      for (let i = recent.length - 1; i >= 0; i--) {
        const turn = recent[i]!
        // estimate lazily so cost stays proportional to the retained tail, not the whole session
        const size = yield* estimate({
          messages: input.messages.slice(turn.start, turn.end),
          model: input.model,
        })
        if (total + size <= budget) {
          total += size
          keep = { start: turn.start, id: turn.id }
          continue
        }
        const remaining = budget - total
        const split = yield* splitTurn({
          messages: input.messages,
          turn,
          model: input.model,
          budget: remaining,
          estimate,
        })
        if (split) keep = split
        else if (!keep) {
          yield* Effect.logInfo("tail fallback", { budget, size, total })
        }
        break
      }

      if (!keep || keep.start === 0) return { head: input.messages, tail_start_id: undefined }
      return {
        head: input.messages.slice(0, keep.start),
        tail_start_id: keep.id,
      }
    })

    // goes backwards through parts until there are PRUNE_PROTECT tokens worth of tool
    // calls, then erases output of older tool calls to free context space
    const prune = Effect.fn("SessionCompaction.prune")(function* (input: { sessionID: SessionID }) {
      const cfg = yield* config.get()
      if (!cfg.compaction?.prune) return
      yield* Effect.logInfo("pruning")

      const msgs = yield* session
        .messages({ sessionID: input.sessionID })
        .pipe(Effect.catchIf(NotFoundError.isInstance, () => Effect.succeed(undefined)))
      if (!msgs) return

      let total = 0
      let pruned = 0
      const toPrune: SessionV1.ToolPart[] = []
      let turns = 0

      loop: for (let msgIndex = msgs.length - 1; msgIndex >= 0; msgIndex--) {
        const msg = msgs[msgIndex]
        if (msg.info.role === "user") turns++
        if (turns < 2) continue
        if (msg.info.role === "assistant" && msg.info.summary) break loop
        for (let partIndex = msg.parts.length - 1; partIndex >= 0; partIndex--) {
          const part = msg.parts[partIndex]
          if (part.type !== "tool") continue
          if (part.state.status !== "completed") continue
          if (PRUNE_PROTECTED_TOOLS.includes(part.tool)) continue
          if (part.state.time.compacted) break loop
          const estimate = Token.estimate(part.state.output)
          total += estimate
          if (total <= PRUNE_PROTECT) continue
          pruned += estimate
          toPrune.push(part)
        }
      }

      yield* Effect.logInfo("found", { pruned, total })
      if (pruned > PRUNE_MINIMUM) {
        for (const part of toPrune) {
          if (part.state.status === "completed") {
            part.state.time.compacted = Date.now()
            yield* session.updatePart(part)
          }
        }
        yield* Effect.logInfo("pruned", { count: toPrune.length })
      }
    })

    const processCompaction = Effect.fn("SessionCompaction.process")(function* (input: {
      parentID: MessageID
      messages: SessionV1.WithParts[]
      sessionID: SessionID
      auto: boolean
      overflow?: boolean
      capture?: { request: LLM.InternalStreamInput; messageIDs: ReadonlySet<MessageID> }
      rebuild?: (input: {
        messages: SessionV1.WithParts[]
        processor: SessionProcessor.Handle
        model: Provider.Model
      }) => Effect.Effect<LLM.InternalStreamInput>
    }) {
      const started = Date.now()
      const parent = input.messages.findLast((m) => m.info.id === input.parentID)
      if (!parent || parent.info.role !== "user") {
        throw new Error(`Compaction parent must be a user message: ${input.parentID}`)
      }
      const userMessage = parent.info
      const compactionPart = parent.parts.find((part): part is SessionV1.CompactionPart => part.type === "compaction")

      let messages = input.messages
      let replay:
        | {
            info: SessionV1.User
            parts: SessionV1.Part[]
          }
        | undefined
      if (input.overflow) {
        const idx = input.messages.findIndex((m) => m.info.id === input.parentID)
        for (let i = idx - 1; i >= 0; i--) {
          const msg = input.messages[i]
          if (msg.info.role === "user" && !msg.parts.some((p) => p.type === "compaction")) {
            replay = { info: msg.info, parts: msg.parts }
            messages = input.messages.slice(0, i)
            break
          }
        }
        const hasContent =
          replay && messages.some((m) => m.info.role === "user" && !m.parts.some((p) => p.type === "compaction"))
        if (!hasContent) {
          replay = undefined
          messages = input.messages
        }
      }

      const compactionAgent = yield* agents.get("compaction")
      const compactionModel = compactionAgent.model
        ? yield* provider.getModel(compactionAgent.model.providerID, compactionAgent.model.modelID).pipe(Effect.orDie)
        : yield* provider.getModel(userMessage.model.providerID, userMessage.model.modelID).pipe(Effect.orDie)
      const cfg = yield* config.get()
      const requested = cfg.compaction?.mode === "suffix" ? "suffix" : "prepend"
      const suffixCapture = requested === "suffix" ? input.capture : undefined
      const history = compactionPart && messages.at(-1)?.info.id === input.parentID ? messages.slice(0, -1) : messages
      const prior = completedCompactions(history)
      const hidden = new Set(prior.flatMap((item) => [item.userIndex, item.assistantIndex]))
      const previousSummary = prior.at(-1)?.summary
      const selected = yield* select({
        messages: history.filter((_, index) => !hidden.has(index)),
        cfg,
        model: suffixCapture?.request.model ?? compactionModel,
      })
      // Allow plugins to inject context or replace compaction prompt.
      const compacting = yield* plugin.trigger(
        "experimental.session.compacting",
        { sessionID: input.sessionID },
        { context: [], prompt: undefined },
      )
      const suffix = suffixCapture && !compacting.prompt ? suffixCapture : undefined
      const suffixRebuild = requested === "suffix" && !suffix && !compacting.prompt ? input.rebuild : undefined
      let fallback: SessionCompaction.FallbackReason | undefined =
        requested === "suffix" && compacting.prompt ? "plugin_prompt" : undefined
      const retained = selected.tail_start_id
        ? history.slice(
            Math.max(
              0,
              history.findIndex((item) => item.info.id === selected.tail_start_id),
            ),
          )
        : []
      const anchor = retained[0]
        ? {
            role: retained[0].info.role,
            text: serialize(retained[0]),
            recentMessageCount: retained.length,
            recentTurnCount: turns(retained).length,
          }
        : undefined
      const suffixPrompt = SessionCompactionSuffix.buildPrompt({ anchor, pluginContext: compacting.context })
      let activeProcessor: SessionProcessor.Handle | undefined
      let activeMode: SessionCompaction.Mode | undefined
      let failedSuffixUsage: ReturnType<SessionProcessor.Handle["latestUsage"]>
      let persistedDiagnostics: SessionCompaction.Diagnostics | undefined
      const suffixUnavailable = (request: LLM.InternalStreamInput): SessionCompaction.FallbackReason | undefined => {
        if (request.toolChoice !== undefined && request.toolChoice !== "auto" && request.toolChoice !== "none") {
          return "tool_choice"
        }
        if (Object.values(request.tools).some((tool) => tool.type === "provider")) {
          return "provider_tool"
        }
        return undefined
      }
      const fitsSuffix = (request: LLM.InternalStreamInput) =>
        Token.estimate(
          JSON.stringify({
            system: request.system,
            messages: request.messages,
            tools: request.tools,
            toolChoice: request.toolChoice,
          }),
        ) <=
        usable({
          cfg,
          model: request.model,
          outputTokenMax: Math.min(SUMMARY_OUTPUT_TOKENS, flags.outputTokenMax ?? SUMMARY_OUTPUT_TOKENS),
        })
      const canSuffix = suffix ? !suffixUnavailable(suffix.request) : !!suffixRebuild
      if (suffix && !canSuffix) fallback = suffixUnavailable(suffix.request)
      const ctx = yield* InstanceState.context
      const makeProcessor = Effect.fn("SessionCompaction.makeProcessor")(function* (attempt?: {
        capture?: typeof suffix
        suffix?: boolean
      }) {
        const capture = attempt?.capture
        const model =
          capture?.request.model ??
          (attempt?.suffix && suffixRebuild
            ? yield* provider.getModel(userMessage.model.providerID, userMessage.model.modelID).pipe(Effect.orDie)
            : compactionModel)
        const agent = capture?.request.agent ?? compactionAgent
        const msg: SessionV1.Assistant = {
          id: MessageID.ascending(),
          role: "assistant",
          parentID: input.parentID,
          sessionID: input.sessionID,
          mode: "compaction",
          agent: "compaction",
          variant: userMessage.model.variant,
          summary: true,
          path: { cwd: ctx.directory, root: ctx.worktree },
          cost: 0,
          tokens: { output: 0, input: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: model.id,
          providerID: model.providerID,
          time: { created: Date.now() },
        }
        yield* session.updateMessage(msg)
        const processor = yield* processors.create({ assistantMessage: msg, sessionID: input.sessionID, model })
        activeProcessor = processor
        const rebuilt =
          !capture && attempt?.suffix && suffixRebuild
            ? yield* suffixRebuild({ messages: history, processor, model })
            : undefined
        const rawRequest = capture?.request ?? rebuilt
        const request = capture
          ? (() => {
              const { prepareSystem: _prepareSystem, onSystemPrepared: _onSystemPrepared, ...prepared } = capture.request
              return { ...prepared, systemPrepared: true }
            })()
          : rawRequest?.prepareSystem
          ? yield* rawRequest.prepareSystem().pipe(
              Effect.map((system) => {
                const { prepareSystem: _prepareSystem, onSystemPrepared: _onSystemPrepared, ...prepared } = rawRequest
                return { ...prepared, system, systemPrepared: true }
              }),
            )
          : rawRequest
        const unavailable = request ? suffixUnavailable(request) : undefined
        if (request && !unavailable) {
          const additions = capture
            ? structuredClone(
                history.filter(
                  (item) =>
                    !capture.messageIDs.has(item.info.id) && !item.parts.some((part) => part.type === "compaction"),
                ),
              )
            : []
          if (additions.length)
            yield* plugin.trigger("experimental.chat.messages.transform", {}, { messages: additions })
          const additionMessages = capture ? yield* MessageV2.toModelMessagesEffect(additions, model) : []
          const suffixRequest = {
            ...request,
            maxOutputTokens: SUMMARY_OUTPUT_TOKENS,
            messages: [...request.messages, ...additionMessages, { role: "user" as const, content: suffixPrompt }],
          }
          if (fitsSuffix(suffixRequest)) {
            const tools: Record<string, Tool> = {}
            for (const [name, definition] of Object.entries(request.tools)) {
              tools[name] = {
                ...definition,
                execute: () => Promise.reject(new Error("Tools cannot execute during compaction")),
              }
            }
            activeMode = "suffix"
            const result = yield* processor.process({
              ...suffixRequest,
              agent: request.agent,
              model,
              tools,
            })
            return { processor, result, suffix: true }
          }
          fallback = "context"
        }
        if (request) {
          fallback = unavailable ?? "context"
          if (attempt?.suffix) return { processor, retryLegacy: true as const }
        }
        const msgs = structuredClone(selected.head)
        yield* plugin.trigger("experimental.chat.messages.transform", {}, { messages: msgs })
        const conversation = msgs.map(serialize).filter(Boolean).join("\n\n")
        const nextPrompt =
          compacting.prompt ??
          [buildPrompt({ previousSummary, context: [conversation] }), ...compacting.context]
            .filter(Boolean)
            .join("\n\n")
        activeMode = "prepend"
        const result = yield* processor.process({
          user: userMessage,
          agent,
          sessionID: input.sessionID,
          tools: {},
          system: [],
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: [
                    nextPrompt,
                    ...(compacting.prompt ? ["The following is the conversation history:", conversation] : []),
                  ]
                    .filter(Boolean)
                    .join("\n\n"),
                },
              ],
            },
          ],
          model,
        })
        return { processor, result, suffix: false }
      })
      const persistDiagnostics = Effect.fn("SessionCompaction.persistDiagnostics")(function* (input?: {
        result?: "continue" | "compact" | "stop"
        interrupted?: boolean
      }) {
        if (persistedDiagnostics) return persistedDiagnostics
        const processor = activeProcessor
        if (!processor) return undefined
        const rawUsage = failedSuffixUsage ?? processor.latestUsage()
        const tokenUsage = rawUsage
          ? {
              ...(rawUsage.inputTokens === undefined ? {} : { input: rawUsage.inputTokens }),
              ...(rawUsage.cacheReadInputTokens === undefined ? {} : { cached: rawUsage.cacheReadInputTokens }),
              ...(rawUsage.outputTokens === undefined ? {} : { output: rawUsage.outputTokens }),
            }
          : undefined
        const diagnostics: SessionCompaction.Diagnostics = {
          requested,
          ...(activeMode ? { used: activeMode } : {}),
          fallback: input?.interrupted
            ? fallback
            : (fallback ??
              (input?.result === "compact" ? "context" : processor.message.error ? "provider_error" : undefined)),
          durationMs: Math.max(0, Date.now() - started),
          tokens: tokenUsage && Object.keys(tokenUsage).length ? tokenUsage : undefined,
        }
        yield* Effect.logInfo("compacted", {
          requested,
          used: activeMode,
          fallback: diagnostics.fallback,
          tokens: diagnostics.tokens,
        })
        yield* Effect.uninterruptible(
          Effect.gen(function* () {
            if (compactionPart) {
              yield* session.updatePart({
                ...compactionPart,
                tail_start_id: selected.tail_start_id ?? compactionPart.tail_start_id,
                diagnostics,
              })
            }
            persistedDiagnostics = diagnostics
          }),
        )
        return diagnostics
      })
      const runProcessor = Effect.fnUntraced(function* (attempt?: { capture?: typeof suffix; suffix?: boolean }) {
        const run = yield* makeProcessor(attempt)
        if (!("retryLegacy" in run)) return run
        yield* session.removeMessage({ sessionID: input.sessionID, messageID: run.processor.message.id })
        const legacy = yield* makeProcessor()
        if ("retryLegacy" in legacy) return yield* Effect.die("Legacy compaction cannot request a legacy retry")
        return legacy
      })
      const runWithDiagnostics = (attempt?: { capture?: typeof suffix; suffix?: boolean }) =>
        runProcessor(attempt).pipe(
          Effect.onInterrupt(() => Effect.uninterruptible(persistDiagnostics({ interrupted: true }))),
        )
      let run = yield* runWithDiagnostics(canSuffix ? { capture: suffix, suffix: true } : undefined)
      const suffixMessage = () =>
        session.messages({ sessionID: input.sessionID }).pipe(
          Effect.map((items) => items.find((item) => item.info.id === run.processor.message.id)),
          Effect.orDie,
        )
      const persistedSuffix = yield* suffixMessage()
      const suffixText = persistedSuffix ? summaryText(persistedSuffix) : undefined
      const suffixToolCall = run.processor.attemptedToolCall()
      const suffixFailed =
        run.suffix &&
        (run.result === "compact" ||
          !!run.processor.message.error ||
          !suffixText ||
          !SessionCompactionSuffix.validateSummary(suffixText) ||
          suffixToolCall)
      if (suffixFailed) {
        yield* Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const suffixUsage = run.processor.latestUsage()
            fallback =
              run.result === "compact"
                ? "context"
                : suffixToolCall
                  ? "tool_call"
                  : run.processor.message.error
                    ? "provider_error"
                    : suffixText
                      ? "invalid_summary"
                      : "empty_summary"
            yield* session.removeMessage({ sessionID: input.sessionID, messageID: run.processor.message.id })
            failedSuffixUsage = suffixUsage
            run = yield* restore(runWithDiagnostics())
          }),
        ).pipe(Effect.onInterrupt(() => Effect.uninterruptible(persistDiagnostics({ interrupted: true }))))
      }
      const processor = run.processor
      const result = run.result

      if (result === "compact") {
        processor.message.error = new SessionV1.ContextOverflowError({
          message: replay
            ? "Conversation history too large to compact - exceeds model context limit"
            : "Session too large to compact - context exceeds model limit even after stripping media",
        }).toObject()
        processor.message.finish = "error"
        yield* session.updateMessage(processor.message)
        yield* persistDiagnostics({ result })
        return "stop"
      }
      if (processor.message.error) {
        yield* persistDiagnostics({ result })
        return "stop"
      }
      const diagnostics = yield* persistDiagnostics({ result })

      if (result === "continue" && input.auto) {
        if (replay) {
          const original = replay.info
          const replayMsg = yield* session.updateMessage({
            id: MessageID.ascending(),
            role: "user",
            sessionID: input.sessionID,
            time: { created: Date.now() },
            agent: original.agent,
            model: original.model,
            format: original.format,
            tools: original.tools,
            system: original.system,
          })
          for (const part of replay.parts) {
            if (part.type === "compaction") continue
            const replayPart =
              part.type === "file" && MessageV2.isMedia(part.mime)
                ? { type: "text" as const, text: `[Attached ${part.mime}: ${part.filename ?? "file"}]` }
                : part
            yield* session.updatePart({
              ...replayPart,
              id: PartID.ascending(),
              messageID: replayMsg.id,
              sessionID: input.sessionID,
            })
          }
        }

        if (!replay) {
          const info = yield* provider.getProvider(userMessage.model.providerID)
          if (
            (yield* plugin.trigger(
              "experimental.compaction.autocontinue",
              {
                sessionID: input.sessionID,
                agent: userMessage.agent,
                model: yield* provider
                  .getModel(userMessage.model.providerID, userMessage.model.modelID)
                  .pipe(Effect.orDie),
                provider: {
                  source: info.source,
                  info,
                  options: info.options,
                },
                message: userMessage,
                overflow: input.overflow === true,
              },
              { enabled: true },
            )).enabled
          ) {
            const continueMsg = yield* session.updateMessage({
              id: MessageID.ascending(),
              role: "user",
              sessionID: input.sessionID,
              time: { created: Date.now() },
              agent: userMessage.agent,
              model: userMessage.model,
            })
            const text =
              (input.overflow
                ? "The previous request exceeded the provider's size limit due to large media attachments. The conversation was compacted and media files were removed from context. If the user was asking about attached images or files, explain that the attachments were too large to process and suggest they try again with smaller or fewer files.\n\n"
                : "") +
              "Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed."
            yield* session.updatePart({
              id: PartID.ascending(),
              messageID: continueMsg.id,
              sessionID: input.sessionID,
              type: "text",
              // Internal marker for auto-compaction followups so provider plugins
              // can distinguish them from manual post-compaction user prompts.
              // This is not a stable plugin contract and may change or disappear.
              metadata: { compaction_continue: true },
              synthetic: true,
              text,
              time: {
                start: Date.now(),
                end: Date.now(),
              },
            })
          }
        }
      }

      if (result === "continue") {
        yield* events.publish(Event.Compacted, { sessionID: input.sessionID, diagnostics })
      }
      return result
    })

    const create = Effect.fn("SessionCompaction.create")(function* (input: {
      sessionID: SessionID
      agent: string
      model: { providerID: ProviderV2.ID; modelID: ModelV2.ID }
      auto: boolean
      overflow?: boolean
    }) {
      const msg = yield* session.updateMessage({
        id: MessageID.ascending(),
        role: "user",
        model: input.model,
        sessionID: input.sessionID,
        agent: input.agent,
        time: { created: Date.now() },
      })
      yield* session.updatePart({
        id: PartID.ascending(),
        messageID: msg.id,
        sessionID: msg.sessionID,
        type: "compaction",
        auto: input.auto,
        overflow: input.overflow,
      })
    })

    return Service.of({
      isOverflow,
      prune,
      process: processCompaction,
      create,
    })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [
    Config.node,
    Session.node,
    Agent.node,
    Plugin.node,
    SessionProcessor.node,
    Provider.node,
    EventV2Bridge.node,
    RuntimeFlags.node,
  ],
})

export * as SessionCompaction from "./compaction"
