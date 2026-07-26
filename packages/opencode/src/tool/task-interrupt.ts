import { Effect, Schema, Option } from "effect"
import * as Tool from "./tool"
import { Interrupt } from "../session/interrupt"
import { Session } from "@/session/session"
import { BackgroundJob } from "@/background/job"
import { Permission } from "@/permission"
import { Agent } from "@/agent/agent"
import { SessionID } from "../session/schema"
import STEER_DESCRIPTION from "./task-steer.txt"
import CANCEL_DESCRIPTION from "./task-cancel.txt"
import ABORT_DESCRIPTION from "./task-abort.txt"

const SteerParameters = Schema.Struct({
  task_id: Schema.String.annotate({ description: "task_id of the subagent you spawned" }),
  reason: Schema.String.annotate({ description: "Short course-correction the subagent will read and adapt to" }),
})
const CancelParameters = Schema.Struct({
  task_id: Schema.String.annotate({ description: "task_id of the subagent you spawned" }),
  reason: Schema.String.annotate({ description: "Why it should stop; the subagent wraps up acting on this" }),
})
const AbortParameters = Schema.Struct({
  task_id: Schema.String.annotate({ description: "task_id of the subagent you spawned" }),
  reason: Schema.optional(Schema.String).annotate({ description: "Optional reason, recorded on the aborted task" }),
})

const resolveChild = (
  sessions: Session.Interface,
  background: BackgroundJob.Interface,
  taskId: string,
  callerSessionID: SessionID,
) =>
  Effect.gen(function* () {
    const childID = SessionID.make(taskId)
    const child = yield* sessions.get(childID).pipe(Effect.option)
    if (Option.isNone(child) || child.value.id === callerSessionID) return { kind: "not_found" as const }

    let ancestorID = child.value.parentID
    // Parent links should be acyclic, but corrupted data must not trap an interrupt request forever.
    for (let hop = 0; hop < 64; hop++) {
      if (!ancestorID) return { kind: "not_found" as const }
      if (ancestorID === callerSessionID) {
        const job = yield* background.get(childID)
        const running = !!job && job.status === "running"
        return { kind: "resolved" as const, childID, running }
      }
      const ancestor = yield* sessions.get(ancestorID).pipe(Effect.option)
      if (Option.isNone(ancestor)) return { kind: "not_found" as const }
      ancestorID = ancestor.value.parentID
    }
    return { kind: "not_found" as const }
  })

export const TaskSteerTool = Tool.define<
  typeof SteerParameters,
  { task_id: string; state: string },
  Interrupt.Service | Session.Service | BackgroundJob.Service | Permission.Service | Agent.Service
>(
  "task_steer",
  Effect.gen(function* () {
    const interrupt = yield* Interrupt.Service
    const sessions = yield* Session.Service
    const background = yield* BackgroundJob.Service
    const permission = yield* Permission.Service
    const agents = yield* Agent.Service
    return {
      description: STEER_DESCRIPTION,
      parameters: SteerParameters,
      execute: (params, ctx) =>
        Effect.gen(function* () {
          const resolved = yield* resolveChild(sessions, background, params.task_id, ctx.sessionID)
          if (resolved.kind === "not_found")
            return {
              title: "Steer: not found",
              metadata: { task_id: params.task_id, state: "not_found" },
              output: `task_id ${params.task_id} is not a descendant of this session`,
            }
          if (!resolved.running)
            return {
              title: "Steer: already finished",
              metadata: { task_id: params.task_id, state: "already_finished" },
              output: `Subagent ${params.task_id} has already finished; nothing to steer.`,
            }
          const agent = yield* agents.get(ctx.agent)
          yield* permission.ask({
            permission: "interrupt",
            patterns: ["task_steer"],
            sessionID: ctx.sessionID,
            metadata: { task_id: params.task_id },
            always: ["task_steer"],
            ruleset: agent.permission,
          })
          yield* interrupt.request({
            sessionID: resolved.childID,
            intent: "steer",
            reason: params.reason,
            origin: "parent",
          })
          return {
            title: "Steered subagent",
            metadata: { task_id: params.task_id, state: "delivered" },
            output: "Steer delivered; the subagent will adapt at its next step.",
          }
        }).pipe(Effect.orDie),
    }
  }),
)

export const TaskCancelTool = Tool.define<
  typeof CancelParameters,
  { task_id: string; state: string },
  Interrupt.Service | Session.Service | BackgroundJob.Service | Permission.Service | Agent.Service
>(
  "task_cancel",
  Effect.gen(function* () {
    const interrupt = yield* Interrupt.Service
    const sessions = yield* Session.Service
    const background = yield* BackgroundJob.Service
    const permission = yield* Permission.Service
    const agents = yield* Agent.Service
    return {
      description: CANCEL_DESCRIPTION,
      parameters: CancelParameters,
      execute: (params, ctx) =>
        Effect.gen(function* () {
          const resolved = yield* resolveChild(sessions, background, params.task_id, ctx.sessionID)
          if (resolved.kind === "not_found")
            return {
              title: "Cancel: not found",
              metadata: { task_id: params.task_id, state: "not_found" },
              output: `task_id ${params.task_id} is not a descendant of this session`,
            }
          if (!resolved.running)
            return {
              title: "Cancel: already finished",
              metadata: { task_id: params.task_id, state: "already_finished" },
              output: `Subagent ${params.task_id} has already finished; nothing to cancel.`,
            }
          const agent = yield* agents.get(ctx.agent)
          yield* permission.ask({
            permission: "interrupt",
            patterns: ["task_cancel"],
            sessionID: ctx.sessionID,
            metadata: { task_id: params.task_id },
            always: ["task_cancel"],
            ruleset: agent.permission,
          })
          yield* interrupt.request({
            sessionID: resolved.childID,
            intent: "cancel",
            reason: params.reason,
            origin: "parent",
          })
          return {
            title: "Cancelling subagent",
            metadata: { task_id: params.task_id, state: "delivered" },
            output: "Cancel delivered; the subagent will wrap up and stop.",
          }
        }).pipe(Effect.orDie),
    }
  }),
)

export const TaskAbortTool = Tool.define<
  typeof AbortParameters,
  { task_id: string; state: string },
  Interrupt.Service | Session.Service | BackgroundJob.Service | Permission.Service | Agent.Service
>(
  "task_abort",
  Effect.gen(function* () {
    const interrupt = yield* Interrupt.Service
    const sessions = yield* Session.Service
    const background = yield* BackgroundJob.Service
    const permission = yield* Permission.Service
    const agents = yield* Agent.Service
    return {
      description: ABORT_DESCRIPTION,
      parameters: AbortParameters,
      execute: (params, ctx) =>
        Effect.gen(function* () {
          const resolved = yield* resolveChild(sessions, background, params.task_id, ctx.sessionID)
          if (resolved.kind === "not_found")
            return {
              title: "Abort: not found",
              metadata: { task_id: params.task_id, state: "not_found" },
              output: `task_id ${params.task_id} is not a descendant of this session`,
            }
          if (!resolved.running)
            return {
              title: "Abort: already finished",
              metadata: { task_id: params.task_id, state: "already_finished" },
              output: `Subagent ${params.task_id} has already finished.`,
            }
          const agent = yield* agents.get(ctx.agent)
          yield* permission.ask({
            permission: "interrupt",
            patterns: ["task_abort"],
            sessionID: ctx.sessionID,
            metadata: { task_id: params.task_id },
            always: ["task_abort"],
            ruleset: agent.permission,
          })
          // Route through the shared abort helper so tool-issued and HTTP-issued
          // aborts produce identical visible markers and terminal records.
          yield* Interrupt.abortChild(
            { sessions, background, interrupt },
            { childID: resolved.childID, origin: "parent", reason: params.reason },
          )
          return {
            title: "Aborted subagent",
            metadata: { task_id: params.task_id, state: "aborted" },
            output: `Aborted subagent ${params.task_id}.`,
          }
        }).pipe(Effect.orDie),
    }
  }),
)
