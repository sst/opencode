import * as Tool from "./tool"
import DESCRIPTION from "./task.txt"
import { ToolJsonSchema } from "./json-schema"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { BackgroundJob } from "@/background/job"
import { Session } from "@/session/session"
import { SESSION_SLUG_PATTERN } from "@/session/session"
import { SessionID, MessageID } from "../session/schema"
import { MessageV2 } from "../session/message-v2"
import { Agent } from "../agent/agent"
import { deriveSubagentSessionPermission } from "../agent/subagent-permissions"
import type { SessionPrompt } from "../session/prompt"
import { Config } from "@/config/config"
import { Effect, Exit, Option, Schema, Scope } from "effect"
import { EffectBridge } from "@/effect/bridge"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Database } from "@opencode-ai/core/database/database"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { PositiveInt } from "@opencode-ai/core/schema"
import { createHash } from "crypto"

export interface TaskPromptOps {
  cancel(sessionID: SessionID): Effect.Effect<void>
  cancelRun(sessionID: SessionID): Effect.Effect<void>
  resolvePromptParts(template: string): Effect.Effect<SessionPrompt.PromptInput["parts"]>
  prompt(input: SessionPrompt.PromptInput): Effect.Effect<SessionV1.WithParts>
}

const id = "task"
const BACKGROUND_DESCRIPTION = [
  "Background mode: background=true launches the subagent asynchronously and returns immediately.",
  "Foreground is the default; use it when you need the result before continuing.",
  "Use background only for independent work that can run while you continue elsewhere.",
  "You will be notified automatically when it finishes.",
].join(" ")
const BACKGROUND_STARTED = [
  "The task is working in the background. You will be notified automatically when it finishes.",
  "DO NOT sleep, poll for progress, ask the task for status, or duplicate this task's work — avoid working with the same files or topics it is using.",
  "Work on non-overlapping tasks, or briefly tell the user what you launched and end your response.",
].join("\n")
const BACKGROUND_UPDATED = [
  "Additional context sent to the running background task.",
  "The task is still working in the background. You will be notified automatically when it finishes.",
  "DO NOT sleep, poll for progress, ask the task for status, or duplicate this task's work — avoid working with the same files or topics it is using.",
  "Work on non-overlapping tasks, or briefly tell the user what you sent and end your response.",
].join("\n")

function isSlug(taskId: string): boolean {
  return !taskId.startsWith("ses_")
}

function deriveSlugSessionID(slug: string, rootID: SessionID): SessionID {
  // The 12-hex root hash namespaces the slug per session tree so different roots
  // can reuse the same slug; within a tree the slug itself makes the ID unique.
  const hash = createHash("sha256").update(rootID).digest("hex").slice(0, 12)
  return SessionID.descending(`ses_${hash}_${slug}`)
}

const BaseParameterFields = {
  description: Schema.String.annotate({ description: "A short (3-5 words) description of the task" }),
  prompt: Schema.String.annotate({ description: "The task for the agent to perform" }),
  subagent_type: Schema.String.annotate({ description: "The type of specialized agent to use for this task" }),
  model: Schema.optional(Schema.String).annotate({
    description:
      "Override the model for this subagent. Format: provider/model (e.g. anthropic/claude-sonnet-4, openai/gpt-4o). Takes precedence over the agent's configured model.",
  }),
  variant: Schema.optional(Schema.String).annotate({
    description:
      'Model variant for this dispatch (e.g. "thinking", "high", "none"). Variants are model-specific reasoning/effort presets; an unknown variant is ignored. Takes precedence over the parent turn\'s variant.',
  }),
  task_id: Schema.optional(Schema.String).annotate({
    description:
      'A human-readable slug (e.g. "explore-auth") to create or resume a named task session within this root session. If the slug has not been used yet, a new task is created with that identifier and the child session adopts the slug as its display handle. If it already exists, the existing session is resumed. Also accepts full "ses_..." session IDs to resume a specific session directly.',
  }),
  resume: Schema.optional(Schema.Boolean).annotate({
    description:
      "Explicit consent to resume an existing idle task session named by task_id. Required when task_id refers to a session with no currently-running background job. A live background task still accepts task_id updates without this flag.",
  }),
  command: Schema.optional(Schema.String).annotate({ description: "The command that triggered this task" }),
  timeout: Schema.optional(PositiveInt).annotate({
    description:
      "Maximum time in milliseconds for the subagent attempt. On expiry the attempt is interrupted; if fallback_model is set, the task is retried once on it, otherwise the task fails.",
  }),
  fallback_model: Schema.optional(Schema.String).annotate({
    description:
      "Model to retry on once (provider/model format) if the primary attempt times out or fails. Requires the model_override permission.",
  }),
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Any)).annotate({
    description:
      "Opaque structured metadata stored on the child task session (visible to plugins, events, and session queries). Not shown to the subagent. On resume, keys are shallow-merged into the existing metadata.",
  }),
}

const BaseParameters = Schema.Struct(BaseParameterFields)

export const Parameters = Schema.Struct({
  ...BaseParameterFields,
  background: Schema.optional(Schema.Boolean).annotate({
    description:
      "Run the agent in the background. You will be notified when it completes. DO NOT sleep, poll, or proactively check on its progress",
  }),
})

function renderOutput(input: {
  sessionID: SessionID
  state: "running" | "completed" | "error"
  summary?: string
  text: string
}) {
  const tag = input.state === "error" ? "task_error" : "task_result"
  return [
    `<task id="${input.sessionID}" state="${input.state}">`,
    ...(input.summary ? [`<summary>${input.summary}</summary>`] : []),
    `<${tag}>`,
    input.text,
    `</${tag}>`,
    "</task>",
  ].join("\n")
}

function parseModelOverride(model: string): Effect.Effect<{ modelID: ModelV2.ID; providerID: ProviderV2.ID }, Error> {
  const slash = model.indexOf("/")
  if (slash <= 0 || slash === model.length - 1) {
    return Effect.fail(
      new Error(`Invalid model format: "${model}". Expected provider/model (e.g. anthropic/claude-sonnet-4)`),
    )
  }
  return Effect.succeed({
    providerID: ProviderV2.ID.make(model.slice(0, slash)),
    modelID: ModelV2.ID.make(model.slice(slash + 1)),
  })
}

export const TaskTool = Tool.define(
  id,
  Effect.gen(function* () {
    const agent = yield* Agent.Service
    const background = yield* BackgroundJob.Service
    const config = yield* Config.Service
    const sessions = yield* Session.Service
    const scope = yield* Scope.Scope
    const flags = yield* RuntimeFlags.Service
    const database = yield* Database.Service

    const run = Effect.fn("TaskTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context,
    ) {
      const cfg = yield* config.get()
      const runInBackground = params.background === true
      if (runInBackground && !flags.experimentalBackgroundSubagents) {
        return yield* Effect.fail(
          new Error("Background subagents require OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true"),
        )
      }

      const parent = yield* sessions.get(ctx.sessionID)
      let current = parent
      let depth = 0
      while (current.parentID) {
        depth++
        current = yield* sessions.get(current.parentID)
      }
      if (depth >= (cfg.subagent_depth ?? 1)) {
        return yield* Effect.fail(
          new Error(
            `Subagent depth limit reached (${cfg.subagent_depth ?? 1}). Increase "subagent_depth" to allow nested subagents.`,
          ),
        )
      }

      const modelOverride = params.model
      const overrideModel = modelOverride === undefined ? undefined : yield* parseModelOverride(modelOverride)
      const fallbackModel =
        params.fallback_model === undefined ? undefined : yield* parseModelOverride(params.fallback_model)

      const overridePatterns = [modelOverride, params.fallback_model].filter((x): x is string => x !== undefined)
      if (overridePatterns.length > 0) {
        yield* ctx.ask({
          permission: "model_override",
          patterns: overridePatterns,
          always: overridePatterns,
          metadata: {
            description: params.description,
            subagent_type: params.subagent_type,
            ...(modelOverride ? { model: modelOverride } : {}),
            ...(params.fallback_model ? { fallback_model: params.fallback_model } : {}),
          },
        })
      }

      if (!ctx.extra?.bypassAgentCheck) {
        yield* ctx.ask({
          permission: id,
          patterns: [params.subagent_type],
          always: ["*"],
          metadata: {
            description: params.description,
            subagent_type: params.subagent_type,
          },
        })
      }

      const next = yield* agent.get(params.subagent_type)
      if (!next) {
        return yield* Effect.fail(new Error(`Unknown agent type: ${params.subagent_type} is not a valid agent type`))
      }

      const slugTaskId = params.task_id && isSlug(params.task_id) ? params.task_id : undefined
      if (slugTaskId && !SESSION_SLUG_PATTERN.test(slugTaskId)) {
        return yield* Effect.fail(
          new Error(
            `Invalid task_id slug: "${slugTaskId}". Slugs must be lowercase letters, digits, hyphens, or underscores (max 64 chars).`,
          ),
        )
      }
      const derivedID = slugTaskId ? deriveSlugSessionID(slugTaskId, yield* sessions.root(ctx.sessionID)) : undefined

      const found = params.task_id
        ? yield* sessions.get(derivedID ?? SessionID.make(params.task_id)).pipe(Effect.option)
        : Option.none()
      if (Option.isSome(found) && found.value.parentID !== ctx.sessionID) {
        return yield* Effect.fail(
          new Error(
            slugTaskId
              ? `task_id slug "${slugTaskId}" is already used by another session in this session tree`
              : `task_id ${params.task_id} is not a child of this session`,
          ),
        )
      }
      const session = Option.getOrUndefined(found)
      const resumedModel =
        session?.model !== undefined
          ? { modelID: session.model.id, providerID: session.model.providerID }
          : undefined
      const resumedVariant =
        session?.model?.variant && session.model.variant !== "default" ? session.model.variant : undefined
      // Resume gate: an idle (finished) session needs explicit consent; a session with a
      // RUNNING background job passes here and reaches background.extend below unchanged.
      if (session && params.resume !== true) {
        const job = yield* background.get(session.id)
        if (job?.status !== "running")
          return yield* Effect.fail(
            new Error(
              `task_id ${params.task_id} refers to an existing idle task session; pass resume: true to continue it, or omit task_id to start a fresh task`,
            ),
          )
      }
      if (!session && params.resume === true) {
        return yield* Effect.fail(
          new Error(`resume: true was passed but task_id ${params.task_id} does not name an existing task session`),
        )
      }
      const childPermission = deriveSubagentSessionPermission({
        parentSessionPermission: parent.permission ?? [],
        subagent: next,
      })
      const childToolDenies = [
        ...(next.permission.some((rule) => rule.permission === "todowrite")
          ? []
          : [{ permission: "todowrite" as const, pattern: "*" as const, action: "deny" as const }]),
        ...(next.permission.some((rule) => rule.permission === id)
          ? []
          : [{ permission: id, pattern: "*" as const, action: "deny" as const }]),
        ...(cfg.experimental?.primary_tools?.map((permission) => ({
          permission,
          pattern: "*" as const,
          action: "deny" as const,
        })) ?? []),
      ]
      const nextSession =
        session ??
        (yield* sessions.create({
          id: derivedID,
          parentID: ctx.sessionID,
          title: params.description + ` (@${next.name} subagent)`,
          slug: slugTaskId,
          agent: next.name,
          model: overrideModel
            ? { id: overrideModel.modelID, providerID: overrideModel.providerID }
            : undefined,
          permission: [
            ...childPermission,
            ...childToolDenies.filter(
              (deny) =>
                !childPermission.some(
                  (rule) =>
                    rule.permission === deny.permission && rule.pattern === deny.pattern && rule.action === deny.action,
                ),
            ),
          ],
          metadata: params.metadata,
        }))

      if (session && params.metadata) {
        yield* sessions.setMetadata({
          sessionID: session.id,
          metadata: { ...session.metadata, ...params.metadata },
        })
      }

      const msg = yield* MessageV2.get({ sessionID: ctx.sessionID, messageID: ctx.messageID }).pipe(
        Effect.provideService(Database.Service, database),
        Effect.orDie,
      )
      if (msg.info.role !== "assistant") return yield* Effect.fail(new Error("Not an assistant message"))
      const variant = msg.info.variant

      const model = overrideModel ?? resumedModel ?? next.model ?? {
        modelID: msg.info.modelID,
        providerID: msg.info.providerID,
      }
      const metadata = {
        parentSessionId: ctx.sessionID,
        sessionId: nextSession.id,
        model,
        ...(runInBackground ? { background: true } : {}),
      }

      yield* ctx.metadata({
        title: params.description,
        metadata,
      })

      const ops = ctx.extra?.promptOps as TaskPromptOps
      if (!ops) return yield* Effect.fail(new Error("TaskTool requires promptOps in ctx.extra"))

      const runAttempt = Effect.fn("TaskTool.runAttempt")(function* (attempt: {
        modelID: ModelV2.ID
        providerID: ProviderV2.ID
        variant: string | undefined
      }) {
        const parts = yield* ops.resolvePromptParts(params.prompt)
        const result = yield* ops.prompt({
          messageID: MessageID.ascending(),
          sessionID: nextSession.id,
          model: {
            modelID: attempt.modelID,
            providerID: attempt.providerID,
          },
          variant: attempt.variant,
          agent: next.name,
          parts,
        })
        if (result.info.role === "assistant" && result.info.error) {
          const message =
            "message" in result.info.error.data && typeof result.info.error.data.message === "string"
              ? result.info.error.data.message
              : result.info.error.name
          return yield* Effect.fail(new Error(`Subagent failed (task_id: ${nextSession.id}): ${message}`))
        }
        const failed = result.parts.findLast((item) => item.type === "tool" && item.state.status === "error")
        if (failed?.type === "tool" && failed.state.status === "error") {
          return yield* Effect.fail(new Error(`Subagent failed (task_id: ${nextSession.id}): ${failed.state.error}`))
        }
        return result.parts.findLast((item) => item.type === "text")?.text ?? ""
      })

      let fallbackUsed = false
      const runTask = Effect.fn("TaskTool.runTask")(function* () {
        const primaryVariant = params.variant ?? resumedVariant ?? (overrideModel || resumedModel || next.model ? undefined : variant)
        const attempt = (m: { modelID: ModelV2.ID; providerID: ProviderV2.ID }, v: string | undefined) => {
          const eff = runAttempt({ modelID: m.modelID, providerID: m.providerID, variant: v })
          return params.timeout === undefined ? eff : eff.pipe(Effect.timeout(params.timeout))
        }
        const cancelRun = () => ops.cancelRun(nextSession.id).pipe(Effect.ignore)
        const exit = yield* Effect.exit(attempt(model, primaryVariant))
        if (Exit.isSuccess(exit)) return exit.value
        // The timeout interrupts the await, not the child runner; cancelRun stops that
        // runner without canceling the enclosing background job.
        yield* cancelRun()
        if (Exit.hasInterrupts(exit) || Exit.hasDies(exit) || fallbackModel === undefined)
          return yield* Effect.failCause(exit.cause)
        fallbackUsed = true
        const fallbackExit = yield* Effect.exit(attempt(fallbackModel, params.variant ?? resumedVariant))
        if (Exit.isFailure(fallbackExit)) {
          yield* cancelRun()
          return yield* Effect.failCause(fallbackExit.cause)
        }
        return fallbackExit.value
      })

      const inject = Effect.fn("TaskTool.injectBackgroundResult")(function* (
        state: "completed" | "error",
        text: string,
      ) {
        const currentParent = yield* sessions.get(ctx.sessionID)
        yield* ops
          .prompt({
            sessionID: ctx.sessionID,
            agent: currentParent.agent ?? ctx.agent,
            variant,
            parts: [
              {
                type: "text",
                synthetic: true,
                text: renderOutput({
                  sessionID: nextSession.id,
                  state,
                  summary:
                    state === "completed"
                      ? `Background task completed: ${params.description}`
                      : `Background task failed: ${params.description}`,
                  text,
                }),
              },
            ],
          })
          .pipe(Effect.ignore, Effect.forkIn(scope, { startImmediately: true }))
      })

      const notify = Effect.fn("TaskTool.notifyBackgroundResult")(function* (jobID: string) {
        yield* background.wait({ id: jobID }).pipe(
          Effect.flatMap((result) => {
            if (result.info?.status === "completed") return inject("completed", result.info.output ?? "")
            if (result.info?.status === "error") return inject("error", result.info.error ?? "")
            return Effect.void
          }),
          Effect.forkIn(scope, { startImmediately: true }),
        )
      })

      // The resume gate (above) already vetted idle sessions; a RUNNING job reaches
      // this point without the resume: true flag and can be extended normally.
      if (yield* background.extend({ id: nextSession.id, run: runTask() })) {
        return {
          title: params.description,
          metadata: {
            ...metadata,
            background: true,
            jobId: nextSession.id,
          },
          output: renderOutput({
            sessionID: nextSession.id,
            state: "running",
            summary: "Background task updated",
            text: BACKGROUND_UPDATED,
          }),
        }
      }

      const info = yield* background.start({
        id: nextSession.id,
        type: id,
        title: params.description,
        metadata,
        onPromote: Effect.all([
          ctx.metadata({
            title: params.description,
            metadata: { ...metadata, background: true, jobId: nextSession.id },
          }),
          notify(nextSession.id),
        ]),
        run: runTask().pipe(Effect.onInterrupt(() => ops.cancel(nextSession.id))),
      })

      function backgroundResult() {
        return {
          title: params.description,
          metadata: {
            ...metadata,
            background: true,
            jobId: info.id,
          },
          output: renderOutput({
            sessionID: nextSession.id,
            state: "running",
            summary: "Background task started",
            text: BACKGROUND_STARTED,
          }),
        }
      }

      if (runInBackground) {
        yield* notify(info.id)
        return backgroundResult()
      }

      const runCancel = yield* EffectBridge.make()
      const cancel = ops.cancel(nextSession.id)

      function onAbort() {
        runCancel.fork(cancel)
      }

      return yield* Effect.acquireUseRelease(
        Effect.sync(() => {
          ctx.abort.addEventListener("abort", onAbort)
        }),
        () =>
          Effect.gen(function* () {
            const result = yield* Effect.raceFirst(
              background.wait({ id: nextSession.id }).pipe(Effect.map((waited) => waited.info)),
              background.waitForPromotion(nextSession.id),
            )
            if (result?.metadata?.background === true) return backgroundResult()
            if (result?.status === "error") return yield* Effect.fail(new Error(result.error ?? "Task failed"))
            if (result?.status === "cancelled") return yield* Effect.fail(new Error("Task cancelled"))
            const displayMetadata = fallbackUsed ? { ...metadata, fallback_used: true as const } : metadata
            return {
              title: params.description,
              metadata: displayMetadata,
              output: renderOutput({ sessionID: nextSession.id, state: "completed", text: result?.output ?? "" }),
            }
          }),
        (_, exit) =>
          Effect.gen(function* () {
            if (Exit.hasInterrupts(exit))
              yield* Effect.all([cancel, background.cancel(nextSession.id)], { discard: true })
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                ctx.abort.removeEventListener("abort", onAbort)
              }),
            ),
          ),
      )
    })

    return {
      description: flags.experimentalBackgroundSubagents
        ? [DESCRIPTION, BACKGROUND_DESCRIPTION].join("\n\n")
        : DESCRIPTION,
      parameters: Parameters,
      jsonSchema: flags.experimentalBackgroundSubagents ? undefined : ToolJsonSchema.fromSchema(BaseParameters),
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        run(params, ctx).pipe(Effect.orDie),
    }
  }),
)
