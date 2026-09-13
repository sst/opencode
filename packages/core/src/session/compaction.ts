export * as SessionCompaction from "./compaction.js"

import {
  AIError,
  InvalidProviderOutputError,
  UnknownProviderError,
  isContextOverflowFailure,
  LLMClient,
  LLMEvent,
  LLMRequest,
  Message,
  type ContentPart,
} from "@opencode/ai"
import type { SessionCompactionResult } from "@opencode/plugin/effect/session"
import { SessionError } from "@opencode/schema/session-error"
import { Context, Effect, Layer, Stream } from "effect"
import { Bus } from "../bus.js"
import { Database } from "../database/database.js"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { llmClient } from "../effect/app-node-platform.js"
import { SessionEvent } from "./event.js"
import type { SessionContext } from "./context.js"
import { SessionHistory } from "./history.js"
import type { SessionMessage } from "./message.js"
import { SessionModelRequest } from "./model-request.js"
import { SessionProviderContext } from "./provider-context.js"
import type { SessionRunnerModel } from "./runner/model.js"
import { SessionRunnerRetry } from "./runner/retry.js"
import { SessionSchema } from "./schema.js"
import { toSessionError } from "./to-session-error.js"
import { Token } from "../util/token.js"
import { SessionUsage } from "./usage.js"
import { State } from "../state.js"
import { toLLMMessages } from "./runner/to-llm-message.js"
import type { AgentNotFoundError } from "./error.js"
import type { Instructions } from "../instructions/index.js"

const DEFAULT_BUFFER = 20_000
const DEFAULT_KEEP_TOKENS = 15_000
const OUTPUT_TOKEN_MAX = 32_000
const TOOL_OUTPUT_MAX_CHARS = 2_000
const IMAGE_TOKEN_ESTIMATE = 1_500
const PDF_TOKEN_ESTIMATE = 2_000
const SUMMARY_TEMPLATE = `You MUST use this format for your response (you may omit sections that aren't applicable). Do not include the <template> tags in your response.
<template>
## Objective
- [one or two brief sentences describing what the user is trying to accomplish]

## Requirements
- [constraints, preferences, requirements, and scope boundaries stated by the user, or "(none)"]

## Decisions
- [decisions already made and why, or "(none)"]

## Work State
Break the objective into smaller goals and report which are completed, which are being worked on, and which are blocked.
### Completed
- [goals that have been completed; otherwise "(none)"]

### Active
- [goals currently being worked on; otherwise "(none)"]

### Blocked
- [anything blocking progress, and why; otherwise "(none)"]

## Next Move
1. [ordered list of next actions, or "(none)"]

## Relevant Files
List the files and directories, other than the current working directory, that another agent would need to open to continue this work. Include at most 15, most important first. Do not list every file that was read or changed. Include paths outside the current working directory when relevant. If none, write "(none)".
- \`[file or directory path]\`: [brief reason it matters]

## Important Context
- [facts the next agent cannot continue without and cannot easily find on its own; or "(none)"]
</template>`

const SUMMARY_RULES = `Rules:
- Keep each section concise. Use terse, single-line bullets, not prose paragraphs or nested lists.
- Prefer short references over detailed restatement. It is fine to leave out information the next agent can recover from the code or the files listed above.
- Preserve exact file paths, symbols, commands, error strings, URLs, and identifiers.
- Carry forward only user questions or requests that remain unanswered or require further action. Do not repeat ones that newer history has answered or resolved. Preserve exact wording when carrying one forward.
- Preserve consequential workflow state, including whether changes are uncommitted, committed, pushed, under review, or merged.
- Do not mention the summary process or that context was compacted.`

const SUMMARY_HEADINGS = SUMMARY_TEMPLATE.split("\n").filter((line) => line.startsWith("##"))
const LEGACY_HEADING = "## Additional Context"

export type Settings = {
  auto: boolean
  buffer: number
  tokens: number
}

export type Editor = {
  configure: (settings: Partial<Settings>) => void
}

export type AutoInput = {
  readonly context: SessionContext.Loaded
  readonly prepare: SessionModelRequest.Interface["compaction"]
  /** Known overflow must recover from durable history, not submit the overflowing native window again. */
  readonly overflow?: boolean
}

type RequiredInput = {
  readonly messages: readonly SessionMessage.Info[]
  readonly resolved: SessionRunnerModel.Resolved
  readonly context: SessionContext.Loaded
}

export type ManualInput = {
  readonly session: SessionSchema.Info
  readonly messages: readonly SessionMessage.Info[]
  readonly inputID: SessionMessage.ID
  readonly started?: boolean
  /** Empty compaction controls do not preflight model or instruction availability. */
  readonly resolveContext: (
    session: SessionSchema.Info,
  ) => Effect.Effect<
    SessionContext.Loaded & { readonly instructionUpdate: string },
    SessionRunnerModel.Error | AgentNotFoundError | Instructions.InitializationBlocked
  >
  readonly prepare: SessionModelRequest.Interface["compaction"]
}

type ExecuteInput = AutoInput & {
  readonly reason: SessionMessage.Compaction["reason"]
  readonly inputID?: SessionMessage.ID
  readonly started?: boolean
  readonly instructionUpdate?: string
}

export type Outcome =
  | (Pick<SessionMessage.CompactionCompleted, "status"> & {
      /** Consumes the logical step's one overflow rebuild even when the native attempt overflowed first. */
      readonly recoveredOverflow?: boolean
    })
  | Pick<SessionMessage.CompactionFailed, "status" | "error">

export interface Interface extends State.Transformable<Editor> {
  readonly enabled: () => boolean
  readonly required: (input: RequiredInput) => boolean
  readonly compact: (input: AutoInput) => Effect.Effect<Outcome>
  readonly compactManual: (input: ManualInput) => Effect.Effect<Outcome>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionCompaction") {}

const hasInputUsage = (message: SessionMessage.Info) =>
  message.type === "assistant" &&
  !message.error &&
  message.tokens !== undefined &&
  message.tokens.input + message.tokens.cache.read + message.tokens.cache.write > 0

export const estimateTokens = (input: RequiredInput) => {
  const index = input.messages.findLastIndex(hasInputUsage)
  const last = input.messages[index]
  // Keep the anchor's local tool results: they are not covered by its provider usage.
  const added = SessionModelRequest.unsupportedParts(
    toLLMMessages(input.messages.slice(Math.max(0, index)), input.resolved.ref),
    input.resolved.capabilities,
  )
    .filter((message) => message.role !== "assistant" || message.id !== last?.id)
    .reduce((sum, message) => sum + message.content.reduce((sum, part) => sum + estimatePart(part), 0), 0)
  if (last?.type === "assistant" && last.tokens)
    return (
      added +
      last.tokens.input +
      last.tokens.cache.read +
      last.tokens.cache.write +
      last.tokens.output +
      last.tokens.reasoning
    )
  const transcript = SessionModelRequest.baseTranscript({
    agent: input.context.agent.info,
    model: input.resolved,
    tools: input.context.tools,
    initial: input.context.initial,
    messages: [],
  })
  return (
    added +
    transcript.system.reduce((sum, part) => sum + Token.estimate(part.text), 0) +
    input.context.tools.definitions.reduce(
      (sum, tool) => sum + Token.estimate(tool.name + tool.description + JSON.stringify(tool.inputSchema)),
      0,
    )
  )
}

const estimateMedia = (mime: string) => {
  const type = mime.toLowerCase()
  return type.startsWith("image/") ? IMAGE_TOKEN_ESTIMATE : type === "application/pdf" ? PDF_TOKEN_ESTIMATE : 0
}

const estimatePart = (part: ContentPart): number => {
  // Encrypted checkpoints have no locally measurable token size.
  if (part.type === "compaction") return Token.estimate(part.text ?? "")
  if (part.type === "text" || part.type === "reasoning") return Token.estimate(part.text)
  if (part.type === "media") return estimateMedia(part.mediaType)
  if (part.type === "tool-call") return Token.estimate(part.name + (JSON.stringify(part.input) ?? ""))
  if (part.result.type === "content")
    return part.result.value.reduce(
      (sum, content) => sum + (content.type === "text" ? Token.estimate(content.text) : estimateMedia(content.mime)),
      0,
    )
  return Token.estimate(
    typeof part.result.value === "string" ? part.result.value : (JSON.stringify(part.result.value) ?? ""),
  )
}

/** Keep whole, real user messages, never synthetic guidance or half an attachment/tool exchange. */
export const retainUsers = (
  messages: readonly SessionMessage.Info[],
  model: Pick<SessionRunnerModel.Resolved, "ref" | "capabilities">,
  keepTokens: number,
) => {
  const users = SessionModelRequest.boundImages(
    SessionModelRequest.unsupportedParts(
      toLLMMessages(
        messages.filter((message) => message.type === "user").map((message) => ({ ...message, skills: undefined })),
        model.ref,
      ),
      model.capabilities,
    ),
  )
  let tokens = 0
  let start = users.length
  for (let index = users.length - 1; index >= 0; index--) {
    const size = users[index].content.reduce((sum, part) => sum + estimatePart(part), 0)
    if (tokens + size > keepTokens) break
    tokens += size
    start = index
  }
  return users.slice(start)
}

export const truncateToolOutput = (value: string) => {
  if (value.length <= TOOL_OUTPUT_MAX_CHARS) return value
  let end = 0
  for (let count = 0; count < TOOL_OUTPUT_MAX_CHARS && end < value.length; count++) {
    const code = value.charCodeAt(end)
    end +=
      code >= 0xd800 && code <= 0xdbff && value.charCodeAt(end + 1) >= 0xdc00 && value.charCodeAt(end + 1) <= 0xdfff
        ? 2
        : 1
  }
  if (end === value.length) return value
  return `${value.slice(0, end)}\n[truncated]`
}

export const serializeToolContent = (content: SessionMessage.ToolStateCompleted["content"]) =>
  content
    .map((item) =>
      item.type === "text" ? item.text : `[Attached ${item.mime}${item.name === undefined ? "" : `: ${item.name}`}]`,
    )
    .join("\n")

const serializeRecentMessage = (message: SessionMessage.Info) => {
  // Checkpoints and instruction updates are handled outside the serialized tail.
  if (message.type === "compaction" || message.type === "system") return ""
  if (message.type === "user") {
    const files =
      message.files?.map(
        (file) =>
          `[Attached ${file.mime}: ${file.name ?? (file.source.type === "uri" ? file.source.uri : "inline attachment")}]`,
      ) ?? []
    const skills =
      message.skills?.flatMap((skill) =>
        skill.text === undefined ? [] : [`[Skill activated: ${skill.name}]\n${skill.text}`],
      ) ?? []
    return [...skills, `[User]: ${message.text}`, ...files].join("\n")
  }
  if (message.type === "location-switched")
    return `[User]: The working directory has been changed to ${message.location.directory}.`
  if (message.type === "assistant") {
    return message.content
      .flatMap((part) => {
        if (part.type === "text") return [`[Assistant]: ${part.text}`]
        if (part.type === "reasoning") return part.text ? [`[Assistant reasoning]: ${part.text}`] : []
        const input = typeof part.state.input === "string" ? part.state.input : JSON.stringify(part.state.input)
        if (part.state.status === "completed")
          return [
            `[Assistant tool call]: ${part.name}(${input})`,
            `[Tool result]: ${truncateToolOutput(serializeToolContent(part.state.content))}`,
          ]
        if (part.state.status === "error")
          return [`[Assistant tool call]: ${part.name}(${input})`, `[Tool error]: ${part.state.error.message}`]
        return [`[Assistant tool call]: ${part.name}(${input})`]
      })
      .join("\n")
  }
  if (message.type === "synthetic") return `[Synthetic context]: ${message.text}`
  if (message.type === "skill") return `[Skill activated: ${message.name}]\n${message.text}`
  if (message.type === "shell")
    return message.metadata?.background === true
      ? ""
      : `[Shell]: ${message.command}\n${truncateToolOutput(message.output?.output ?? "")}`
  return ""
}

const splitHistory = (messages: readonly SessionMessage.Info[], keepTokens: number) => {
  const tailStart = findTailStart(messages, keepTokens)
  if (tailStart === undefined) return
  return {
    messages: messages.slice(0, tailStart),
    recent: messages.slice(tailStart).map(serializeRecentMessage).filter(Boolean).join("\n\n"),
  }
}

const findTailStart = (messages: readonly SessionMessage.Info[], keepTokens: number) => {
  const conversation = messages.flatMap((message, index) => {
    const text = serializeRecentMessage(message)
    return text ? [{ message, text, index }] : []
  })
  if (conversation.length === 0) return undefined

  // Keep at least the newest entry, even if it exceeds the allowance.
  let total = 0
  let start = conversation.length
  for (let index = conversation.length - 1; index >= 0; index--) {
    const next = total + Token.estimate(conversation[index].text)
    if (start < conversation.length && next > keepTokens) break
    total = next
    start = index
  }

  // Start at a user boundary so an assistant's tool calls and results stay together.
  while (start > 0 && conversation[start].message.type !== "user") start--
  if (start > 0) return conversation[start].index

  // If everything fits, retain only the latest exchange to leave an older prefix to summarize.
  const latestUser = conversation.findLastIndex((item) => item.message.type === "user")
  if (latestUser > 0) return conversation[latestUser].index

  const previousSummary = messages.findLast(
    (message): message is SessionMessage.CompactionCompleted =>
      message.type === "compaction" && message.status === "completed",
  )
  // Without an older retained tail to summarize, summarize everything and retain nothing.
  return previousSummary?.recent ? conversation[0].index : messages.length
}

export const buildPrompt = (update: boolean, legacy = false) => {
  const shared = [
    "Summarize only what the user and the assistant said and did. Leave out instructions and setup the assistant was given rather than told by the user: repository conventions, instruction files such as AGENTS.md, and environment details like the session ID. The next agent receives current versions of all of these separately.",
    SUMMARY_TEMPLATE,
    SUMMARY_RULES,
    "Do not continue the task or call tools.",
    "Return only the structured summary in the requested format. Do not include a preamble, explanation, or other commentary.",
  ]
  if (update) {
    return [
      "Update the existing checkpoint in the conversation above into one consolidated summary.",
      ...(legacy
        ? [
            "The existing checkpoint was written with an earlier format that recorded far more detail than this one asks for. Rewrite it at the level of detail described below rather than carrying its detail forward. Keep its requirements, decisions, and open questions; they came from earlier conversation with the user.",
          ]
        : []),
      "Newer history always takes precedence over the existing checkpoint. Preserve previous information unless newer history clearly contradicts, supersedes, resolves, or makes it stale. If something is no longer relevant to continuing the work, you may remove it.",
      "Incorporate newer requirements, decisions, progress, and context. Reconcile Work State and Next Move: move completed work out of Active, remove resolved blockers and answered questions, and preserve unresolved or pending work.",
      "Return only the updated Markdown sections. Do not reproduce the `<conversation-checkpoint>`, `<summary>`, or `<recent-context>` wrapper tags from the previous checkpoint.",
      ...shared,
    ].join("\n\n")
  }
  return [
    "You MUST summarize the conversation above into a structured summary that will be given to another agent to resume the work.",
    ...shared,
  ].join("\n\n")
}

const hasSummarySection = (summary: string) =>
  summary.split("\n").some((line) => SUMMARY_HEADINGS.includes(line.trim()))

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const llm = yield* LLMClient.Service
    const db = (yield* Database.Service).db

    const state = State.create<Settings, Editor>({
      name: "session-compaction",
      initial: () => ({ auto: true, buffer: DEFAULT_BUFFER, tokens: DEFAULT_KEEP_TOKENS }),
      editor: (editor) => ({
        configure: (settings) => {
          if (settings.auto !== undefined) editor.auto = settings.auto
          if (settings.buffer !== undefined) editor.buffer = settings.buffer
          if (settings.tokens !== undefined) editor.tokens = settings.tokens
        },
      }),
    })
    const failed = Effect.fnUntraced(function* (input: SessionEvent.Compaction.Failed["data"]) {
      yield* bus.publish(SessionEvent.Compaction.Failed, input)
      return { status: "failed" as const, error: input.error }
    })
    const started = (input: ExecuteInput, recent: string) =>
      input.started
        ? Effect.void
        : bus.publish(SessionEvent.Compaction.Started, {
            sessionID: input.context.session.id,
            reason: input.reason,
            recent,
            inputID: input.inputID,
          })
    const supplied = Effect.fn("SessionCompaction.supplied")(function* (
      input: ExecuteInput,
      result: SessionCompactionResult,
      recent: string,
    ) {
      const context = input.context
      const usage = result.tokens
        ? { tokens: result.tokens, cost: SessionUsage.calculateCost(context.model.cost, result.tokens) }
        : undefined
      if (usage)
        yield* bus.publish(SessionEvent.UsageRecorded, {
          sessionID: context.session.id,
          source: "compaction",
          ...usage,
        })
      yield* bus.publish(
        SessionEvent.Compaction.Ended,
        {
          sessionID: context.session.id,
          reason: input.reason,
          model: context.model.ref,
          providerState: result.providerState,
          text: result.summary,
          recent,
          ...usage,
        },
        { metadata: result.metadata },
      )
      return { status: "completed" as const }
    })
    // Manual controls settle through the inbox; only automatic work needs a durable interruption record.
    const interrupted = (input: ExecuteInput) =>
      input.reason === "auto"
        ? failed({
            sessionID: input.context.session.id,
            reason: input.reason,
            inputID: input.inputID,
            error: { type: "compaction.interrupted", message: "Compaction was interrupted" },
          }).pipe(Effect.asVoid)
        : Effect.void
    const compactionRequest = (
      input: ExecuteInput,
      messages: readonly SessionMessage.Info[],
      webSocket?: "session",
    ) => {
      const context = input.context
      const transcript = SessionModelRequest.baseTranscript({
        agent: context.agent.info,
        model: context.model,
        tools: context.tools,
        initial: context.initial,
        messages,
      })
      return input.prepare({
        session: context.session,
        agent: context.agent.id,
        model: context.model,
        tools: context.tools,
        system: transcript.system,
        messages: [
          ...transcript.messages,
          ...(input.instructionUpdate ? [Message.system(input.instructionUpdate)] : []),
        ],
        webSocket,
      })
    }
    /** The durable transcript since the last local summary, re-expanding every native window. */
    const original = (sessionID: SessionSchema.ID) => SessionHistory.load(db, sessionID, "local").pipe(Effect.orDie)
    const recoverLocally = (input: ExecuteInput) =>
      original(input.context.session.id).pipe(
        Effect.flatMap((messages) => execute({ ...input, context: { ...input.context, messages } })),
      )
    const executeProvider = Effect.fn("SessionCompaction.executeProvider")(function* (input: ExecuteInput) {
      const context = input.context
      const reject = (message: string) =>
        failed({
          sessionID: context.session.id,
          reason: input.reason,
          inputID: input.inputID,
          error: { type: "provider.unsupported-operation", message },
        })
      const prepared = yield* compactionRequest(input, context.messages, "session")
      if (prepared.event.result) {
        yield* started(input, "")
        return yield* supplied(input, prepared.event.result, "")
      }
      const request = prepared.request
      const provenance = SessionProviderContext.provenance(context.model)
      if (!provenance) return yield* reject("Provider compaction requires a stable, configured endpoint")
      // History is selected before request hooks. Until that interface can select on the final route,
      // require routing in the catalog; never install a checkpoint that the next request would skip.
      if (
        !SessionProviderContext.compatible(
          provenance,
          SessionProviderContext.provenance({ model: request.model, ref: context.model.ref }),
        )
      )
        return yield* reject(
          "Provider compaction requires the endpoint in provider/model settings, not a model.request rewrite",
        )
      const transient = SessionRunnerRetry.transient(yield* SessionRunnerRetry.policy(context.session.id), {
        agent: context.agent.id,
        model: context.model.ref,
        hook: prepared.retry,
      })
      yield* started(input, "")
      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          // Transient provider failures retry like any other request; only a known automatic overflow permits
          // local recovery, and nothing is installed until the provider returns a checkpoint.
          const result = yield* restore(
            Effect.gen(function* () {
              if (LLMClient.canCompact(request, { mechanism: "trigger" })) {
                const retained = retainUsers(yield* original(context.session.id), context.model, state.get().tokens)
                const result = yield* llm
                  .compact(request, { ...prepared.options, mechanism: "trigger" })
                  .pipe(transient)
                return { replacement: [...retained, Message.assistant(result.checkpoint)], usage: result.usage }
              }
              if (LLMClient.canCompact(request))
                return yield* llm
                  .compact(request, { mechanism: "endpoint", http: prepared.options.http })
                  .pipe(transient)
              // Model resolution admits provider policies only for routes with a compaction operation.
              return yield* Effect.die(
                new Error(`${request.model.provider}/${request.model.route.id} has no compaction operation`),
              )
            }),
          )
          const usage = result.usage ? SessionUsage.record(result.usage, context.model.cost) : undefined
          if (usage)
            yield* bus.publish(SessionEvent.UsageRecorded, {
              sessionID: context.session.id,
              source: "compaction" as const,
              ...usage,
            })
          yield* bus.publish(SessionEvent.Compaction.Ended, {
            sessionID: context.session.id,
            reason: input.reason,
            model: context.model.ref,
            text: "",
            recent: "",
            providerContext: SessionProviderContext.encode(provenance, result.replacement),
            ...usage,
          })
          return { status: "completed" as const }
        }),
      ).pipe(
        Effect.onInterrupt(() => interrupted(input)),
        Effect.catchTag(
          "AI.Error",
          (cause): Effect.Effect<Outcome> =>
            input.reason === "auto" && isContextOverflowFailure(cause)
              ? recoverLocally({ ...input, started: true }).pipe(
                  Effect.map((result) =>
                    result.status === "completed" ? { ...result, recoveredOverflow: true } : result,
                  ),
                )
              : failed({
                  sessionID: context.session.id,
                  reason: input.reason,
                  inputID: input.inputID,
                  error: toSessionError(cause),
                }),
        ),
      )
    })
    const execute = Effect.fn("SessionCompaction.execute")(function* (input: ExecuteInput) {
      const context = input.context
      const history = splitHistory(context.messages, state.get().tokens)
      if (!history)
        return yield* failed({
          sessionID: context.session.id,
          reason: input.reason,
          error: { type: "compaction.unavailable", message: "Nothing to compact yet" },
          inputID: input.inputID,
        })
      yield* started(input, history.recent)

      const chunks: string[] = []
      let failure: SessionError.Error | undefined
      let usage: SessionUsage.Recorded | undefined
      let providerState: SessionMessage.ProviderState | undefined
      const recordUsage = Effect.suspend(() =>
        usage
          ? bus.publish(SessionEvent.UsageRecorded, {
              sessionID: context.session.id,
              source: "compaction",
              ...usage,
            })
          : Effect.void,
      )
      const previous = history.messages.findLast(
        (message): message is SessionMessage.CompactionCompleted =>
          message.type === "compaction" && message.status === "completed",
      )
      // Checkpoints from the previous template ran far longer than this one asks for; its catch-all heading identifies them.
      const legacy = previous?.summary.includes(LEGACY_HEADING) ?? false
      const prepared = yield* compactionRequest(input, history.messages)
      if (prepared.event.result) return yield* supplied(input, prepared.event.result, history.recent)
      // Hooks see the transcript alone; the summary prompt is appended after they run.
      const first = LLMRequest.update(prepared.request, {
        messages: [...prepared.request.messages, Message.user(buildPrompt(previous !== undefined, legacy))],
      })
      // Both requests share the retry allowance; rejected output never enters the reminder request.
      const transient = SessionRunnerRetry.transient(yield* SessionRunnerRetry.policy(context.session.id), {
        agent: context.agent.id,
        model: context.model.ref,
        hook: prepared.retry,
      })
      for (const request of [
        first,
        LLMRequest.update(first, {
          messages: [
            ...first.messages,
            Message.user(
              "The previous response did not fill in the required summary template. Do not call tools. Return the summary as text using the exact section headings from the template.",
            ),
          ],
        }),
      ]) {
        yield* Stream.suspend(() => {
          chunks.length = 0
          providerState = undefined
          failure = undefined
          return llm.stream(request, prepared.options)
        }).pipe(
          Stream.runForEach((event) => {
            if (LLMEvent.is.providerError(event))
              failure = {
                type: event.classification === "context-overflow" ? "provider.invalid-request" : "provider.error",
                message: event.message,
              }
            if (LLMEvent.is.textDelta(event)) {
              chunks.push(event.text)
              return bus.publish(SessionEvent.Compaction.Delta, {
                sessionID: context.session.id,
                text: event.text,
              })
            }
            if (LLMEvent.is.stepFinish(event)) {
              providerState =
                event.providerMetadata?.[context.model.model.route.providerMetadataKey ?? context.model.model.provider]
              const step = SessionUsage.record(event.usage, context.model.cost)
              usage = usage ? SessionUsage.add(usage, step) : step
            }
            if (LLMEvent.is.finish(event)) {
              if (event.reason.normalized === "length")
                failure = { type: "compaction.failed", message: "Compaction summary reached the output token limit" }
              if (event.reason.normalized === "content-filter")
                failure = {
                  type: "provider.content-filter",
                  message: "Compaction summary was blocked by the provider",
                }
              if (event.reason.normalized === "unknown")
                return Effect.fail(
                  new AIError({
                    reason: new InvalidProviderOutputError({
                      message: "The provider response ended with an unknown finish reason.",
                      classification: "incomplete-stream",
                    }),
                  }),
                )
              if (event.reason.normalized === "error")
                return Effect.fail(
                  new AIError({ reason: new UnknownProviderError({ message: "Compaction generation failed" }) }),
                )
            }
            return Effect.void
          }),
          transient,
          Effect.catchTag("AI.Error", (error) =>
            Effect.sync(() => {
              failure = toSessionError(error)
            }),
          ),
          Effect.onInterrupt(() => recordUsage.pipe(Effect.andThen(interrupted(input)))),
        )
        if (failure || hasSummarySection(chunks.join(""))) break
      }
      yield* recordUsage
      const summary = chunks.join("")
      if (failure || !hasSummarySection(summary)) {
        const error = failure ?? {
          type: "compaction.failed" as const,
          message: summary.trim()
            ? "Compaction summary did not match the required template"
            : "Compaction produced no summary",
        }
        return yield* failed({
          sessionID: context.session.id,
          reason: input.reason,
          error,
          inputID: input.inputID,
          ...usage,
        })
      }
      yield* bus.publish(SessionEvent.Compaction.Ended, {
        sessionID: context.session.id,
        reason: input.reason,
        model: context.model.ref,
        providerState,
        text: summary,
        recent: history.recent,
        ...usage,
      })
      return { status: "completed" as const }
    })
    const compact = Effect.fn("SessionCompaction.compact")(function* (input: AutoInput): Effect.fn.Return<Outcome> {
      const request = { ...input, reason: "auto" as const }
      if (input.overflow) return yield* recoverLocally(request)
      if (input.context.model.compaction?.mode !== "provider") return yield* execute(request)
      return yield* executeProvider(request)
    })
    const required = (input: RequiredInput) => {
      const config = state.get()
      if (!config.auto) return false
      // Run the completed checkpoint before considering another automatic compaction.
      const last = input.messages.at(-1)
      if (last?.type === "compaction" && last.status === "completed") return false
      // Native usage describes the compaction operation, not the replacement's size. Wait for
      // a primary response to anchor the new window, including after restart or new admission.
      if (
        input.messages.findLastIndex(hasInputUsage) < input.messages.findLastIndex(SessionProviderContext.isCheckpoint)
      )
        return false
      const limit = input.resolved.limit
      const context = limit.context
      if (context <= 0) return false
      const output = Math.min(limit.output, OUTPUT_TOKEN_MAX)
      const promptCeiling = Math.min(
        limit.input === undefined ? Number.POSITIVE_INFINITY : limit.input - config.buffer,
        context - Math.max(output, config.buffer),
      )
      const policy = input.resolved.compaction
      const threshold =
        policy?.mode === "provider" && policy.threshold !== undefined
          ? Math.min(policy.threshold, promptCeiling)
          : promptCeiling
      return estimateTokens(input) >= threshold
    }
    const compactManual = Effect.fn("SessionCompaction.compactManual")(function* (input: ManualInput) {
      if (findTailStart(input.messages, state.get().tokens) === undefined)
        return yield* failed({
          sessionID: input.session.id,
          reason: "manual",
          error: { type: "compaction.unavailable", message: "Nothing to compact yet" },
          inputID: input.inputID,
        })
      return yield* input.resolveContext(input.session).pipe(
        Effect.matchEffect({
          onFailure: (cause) =>
            failed({
              sessionID: input.session.id,
              reason: "manual",
              error: toSessionError(cause),
              inputID: input.inputID,
            }),
          onSuccess: (context) => {
            const request = {
              context,
              instructionUpdate: context.instructionUpdate,
              prepare: input.prepare,
              reason: "manual" as const,
              inputID: input.inputID,
              started: input.started,
            }
            return context.model.compaction?.mode === "provider" ? executeProvider(request) : execute(request)
          },
        }),
      )
    })
    return Service.of({
      transform: state.transform,
      reload: state.reload,
      enabled: () => state.get().auto,
      required,
      compact,
      compactManual,
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Bus.node, Database.node, llmClient],
})
