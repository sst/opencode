export * as SessionStep from "./step.js"

import {
  AIError,
  InvalidProviderOutputError,
  LLMClient,
  LLMEvent,
  isContextOverflowFailure,
  type ProviderErrorEvent,
  type ToolCall,
} from "@opencode/ai"
import type { Agent } from "@opencode/schema/agent"
import { Cause, Data, Effect, Exit, Fiber, Option, Stream } from "effect"
import { SessionError } from "@opencode/schema/session-error"
import { Bus } from "../../bus.js"
import { Permission } from "../../permission.js"
import { Snapshot } from "../../snapshot.js"
import { Tool } from "../../tool.js"
import { ToolOutput } from "../../tool-output.js"
import { QuestionTool } from "../../tool/plugin/question.js"
import { StepFailedError } from "../error.js"
import { SessionEvent } from "../event.js"
import { SessionMessage } from "../message.js"
import { SessionModelRequest } from "../model-request.js"
import { SessionSchema } from "../schema.js"
import { toSessionError } from "../to-session-error.js"
import { SessionUsage } from "../usage.js"
import { SessionRunnerModel } from "./model.js"
import { createLLMEventPublisher } from "./publish-llm-event.js"
import { SessionRunnerRetry } from "./retry.js"

export type Outcome = Data.TaggedEnum<{
  Completed: { readonly needsContinuation: boolean }
  Retry: { readonly error: SessionError.Error; readonly decision: SessionRunnerRetry.Decision }
  Continue: {
    readonly error: SessionError.Error
    readonly decision: SessionRunnerRetry.Decision
  }
  RecoverFull: {}
  Compacted: {}
}>
export const Outcome = Data.taggedEnum<Outcome>()

interface Input {
  readonly sessionID: SessionSchema.ID
  readonly assistantMessageID: SessionMessage.ID
  readonly agent: Agent.ID
  readonly model: SessionRunnerModel.Resolved
  readonly prepared: Omit<SessionModelRequest.Prepared, "event">
  readonly retry: (
    cause: AIError,
    error: SessionError.Error,
    retry: boolean,
  ) => Effect.Effect<{ readonly retry: false } | SessionRunnerRetry.Decision>
  readonly recoverContinuation: boolean
  /** The runner owns compaction policy; the attempt invokes it only before durable output. */
  readonly recoverOverflow: Effect.Effect<boolean>
}

const TOOLS_INTERRUPTED = { type: "aborted", message: "Tool execution interrupted" } as const
const STEP_INTERRUPTED = { type: "aborted", message: "Step interrupted" } as const
const RESULT_MISSING = { type: "tool.result-missing", message: "Provider did not return a tool result" } as const

/** Captures Location-scoped dependencies without introducing another service or execution loop. */
export const make = Effect.gen(function* () {
  const bus = yield* Bus.Service
  const llm = yield* LLMClient.Service
  const snapshots = yield* Snapshot.Service
  const toolOutput = yield* ToolOutput.Service

  const attempt = Effect.fn("SessionStep.attempt")(function* (input: Input) {
    const startSnapshot = yield* snapshots.capture()
    const publisher = createLLMEventPublisher(bus, {
      sessionID: input.sessionID,
      assistantMessageID: input.assistantMessageID,
      agent: input.agent,
      model: input.model.ref,
      providerMetadataKey: input.model.model.route.providerMetadataKey ?? input.model.model.provider,
      snapshot: startSnapshot,
    })
    const toolRuns: Array<{
      readonly call: ToolCall
      readonly fiber: Fiber.Fiber<void, Permission.DeclinedError | QuestionTool.CancelledError>
    }> = []
    const interruptTools = Effect.suspend(() => Fiber.interruptAll(toolRuns.map((run) => run.fiber)))
    const executeTool = (call: ToolCall) => {
      if (input.prepared.request.toolChoice?.type === "none")
        return new Tool.Error({ message: "Tools are disabled after the maximum agent steps" })
      return input.prepared.executeTool({
        sessionID: input.sessionID,
        agent: input.agent,
        messageID: input.assistantMessageID,
        call,
        progress: (update) => publisher.progress(call.id, update),
      })
    }

    // Provider and tool fibers retain per-source order without a shared writer queue.
    // A local execution starts only after its Tool.Called publication completes.
    let overflowFailure: ProviderErrorEvent | undefined
    // Read to the end, not just the finish event, so the next request can reuse this response.
    const providerStream = llm.stream(input.prepared.request, input.prepared.options).pipe(
      Stream.runForEach((event) =>
        Effect.gen(function* () {
          if (overflowFailure || publisher.hasProviderError()) return
          if (
            LLMEvent.is.providerError(event) &&
            isContextOverflowFailure(event) &&
            !publisher.record().outputStarted
          ) {
            overflowFailure = event
            return
          }
          yield* publisher.publish(event)
          if (event.type !== "tool-call" || event.providerExecuted) return
          toolRuns.push({
            call: event,
            fiber: yield* Effect.uninterruptibleMask((restore) =>
              restore(executeTool(event)).pipe(
                Effect.flatMap(toolOutput.truncate),
                Effect.flatMap((outcome) => publisher.toolExecution(event.id, event.name, outcome)),
                Effect.catchTag("Tool.Error", (error) =>
                  publisher.failTool(event.id, toSessionError(error), error.metadata).pipe(Effect.asVoid),
                ),
              ),
            ).pipe(Effect.forkScoped),
          })
        }),
      ),
      Effect.ensuring(publisher.flush()),
    )

    // Keep the final tool and Step events uninterruptible, even when the work itself is cancelled.
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const stream = yield* restore(providerStream).pipe(Effect.exit)
        const streamFailure = Option.getOrUndefined(Exit.findErrorOption(stream))
        const streamInterrupted = Exit.hasInterrupts(stream)
        if (!overflowFailure && publisher.hasStarted()) yield* publisher.streamed()
        if (streamInterrupted) yield* interruptTools
        const joined = yield* restore(Fiber.awaitAll(toolRuns.map((run) => run.fiber))).pipe(Effect.exit)
        if (Exit.isFailure(joined)) yield* interruptTools
        const tools = classifyToolExits(joined, toolRuns)

        if (
          !publisher.record().outputStarted &&
          isContextOverflowFailure(overflowFailure ?? streamFailure) &&
          (yield* restore(input.recoverOverflow))
        )
          return Outcome.Compacted()

        if (overflowFailure) yield* publisher.publish(overflowFailure)
        const recorded = publisher.record()
        const unknownFinish =
          Exit.isSuccess(stream) && recorded.finish?.finish === "unknown"
            ? new AIError({
                reason: new InvalidProviderOutputError({
                  message: "The provider response ended with an unknown finish reason.",
                  classification: "incomplete-stream",
                }),
              })
            : undefined
        const llmFailure = streamFailure instanceof AIError ? streamFailure : unknownFinish
        const llmError = llmFailure && !recorded.providerFailed ? toSessionError(llmFailure) : undefined
        if (
          input.recoverContinuation &&
          llmFailure?.reason._tag === "Transport" &&
          (llmFailure.reason.recovery === "retry-full" || llmFailure.reason.recovery === "rotate-and-retry-full") &&
          !recorded.outputStarted
        )
          return Outcome.RecoverFull()
        const retry =
          llmFailure && llmError && !isContextOverflowFailure(llmFailure)
            ? yield* restore(
                input.retry(
                  llmFailure,
                  llmError,
                  SessionRunnerRetry.isRetryable(llmFailure) ||
                    (recorded.outputStarted && isInterruptedStream(llmFailure)),
                ),
              )
            : undefined
        if (llmFailure && llmError && retry?.retry && !recorded.outputStarted) {
          // Retry state projects onto the existing assistant, even before it has produced output.
          yield* publisher.startAssistant()
          return Outcome.Retry({ error: llmError, decision: retry })
        }
        if (llmError) yield* publisher.failAssistant(llmError)

        for (const decline of tools.declines)
          yield* publisher.failTool(decline.call.id, {
            type: "aborted",
            message:
              decline.reason._tag === "QuestionTool.CancelledError"
                ? decline.reason.message
                : "The user declined this tool call",
          })
        const interrupted = tools.declines.length > 0 || streamInterrupted || tools.interrupted
        const toolFailure = interrupted
          ? TOOLS_INTERRUPTED
          : tools.failure !== undefined
            ? toSessionError(Cause.squash(tools.failure))
            : recorded.providerFailed
              ? TOOLS_INTERRUPTED
              : undefined
        if (toolFailure) yield* publisher.failUnsettledTools(toolFailure)
        if (interrupted) yield* publisher.failAssistant(STEP_INTERRUPTED)

        // All local fibers have joined; only provider-hosted results can still be missing.
        if (llmError || (Exit.isSuccess(stream) && !recorded.providerFailed)) {
          const missing = yield* publisher.failUnsettledTools(RESULT_MISSING, "hosted")
          if (missing && !llmError && !recorded.finish) yield* publisher.failAssistant(RESULT_MISSING)
        }

        const record = publisher.record()
        if (record.finish || record.failure) {
          const snapshot = yield* snapshots.capture()
          const files =
            startSnapshot && snapshot
              ? startSnapshot === snapshot
                ? []
                : yield* snapshots
                    .files({ from: startSnapshot, to: snapshot })
                    .pipe(Effect.orElseSucceed(() => undefined))
              : undefined
          const usage = record.finish
            ? { cost: SessionUsage.calculateCost(input.model.cost, record.finish.tokens), tokens: record.finish.tokens }
            : undefined
          if (record.failure) yield* publisher.publishStepFailure({ ...usage, snapshot, files })
          if (record.finish && usage && !record.failure)
            yield* bus.publish(SessionEvent.Step.Ended, {
              sessionID: input.sessionID,
              assistantMessageID: yield* publisher.startAssistant(),
              finish: record.finish.finish,
              rawFinish: record.finish.rawFinish,
              providerState: record.finish.providerState,
              ...usage,
              snapshot,
              files,
            })
        }

        if (
          llmFailure &&
          llmError &&
          retry?.retry &&
          record.outputStarted &&
          tools.declines.length === 0 &&
          !tools.interrupted
        )
          return Outcome.Continue({ error: llmError, decision: retry })

        if (Exit.isFailure(stream)) return yield* Effect.failCause(stream.cause)
        if (tools.declines.length > 0) return yield* Effect.interrupt
        if (tools.interrupted && tools.failure) return yield* Effect.failCause(tools.failure)
        if (tools.interrupted && Exit.isFailure(joined)) return yield* Effect.failCause(joined.cause)
        if (record.failure) return yield* new StepFailedError({ error: record.failure })
        return Outcome.Completed({
          needsContinuation: input.prepared.request.toolChoice?.type !== "none" && record.needsContinuation,
        })
      }),
    )
  }, Effect.scoped)

  return { attempt }
})

const isInterruptedStream = (failure: AIError) => {
  if (failure.reason._tag === "InvalidProviderOutput") return failure.reason.classification === "incomplete-stream"
  if (failure.reason._tag === "Transport") return failure.reason.operation === "read"
  return false
}

/** Tool.Error settles in each fiber; only user declines remain in the typed error channel. */
const classifyToolExits = (
  settled: Exit.Exit<Array<Exit.Exit<void, Permission.DeclinedError | QuestionTool.CancelledError>>>,
  runs: ReadonlyArray<{ readonly call: ToolCall }>,
) => {
  const exits = Exit.isSuccess(settled) ? settled.value : []
  const declines = exits.flatMap((exit, index) =>
    Exit.isFailure(exit)
      ? exit.cause.reasons.flatMap((reason) =>
          Cause.isFailReason(reason) ? [{ call: runs[index].call, reason: reason.error }] : [],
        )
      : [],
  )
  const causes = Exit.isFailure(settled)
    ? [settled.cause]
    : exits.flatMap((exit) => (Exit.isFailure(exit) ? [exit.cause] : []))
  const failure = causes
    .flatMap((cause) => {
      if (Cause.hasInterrupts(cause)) return []
      const reasons = cause.reasons.filter(Cause.isDieReason)
      return reasons.length > 0 ? [Cause.fromReasons<never>(reasons)] : []
    })
    .at(0)
  return { interrupted: causes.some(Cause.hasInterrupts), declines, failure }
}
