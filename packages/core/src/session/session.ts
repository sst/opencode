export * as Session from "./session.js"

import { DateTime, Effect, Fiber, Scope } from "effect"
import type { Agent } from "@opencode/schema/agent"
import type { Model } from "@opencode/schema/model"
import type { Permission } from "@opencode/schema/permission"
import { Event } from "@opencode/schema/event"
import { FSUtil } from "@opencode/util/fs-util"
import { Bus } from "../bus.js"
import { Database } from "../database/database.js"
import { Instance } from "../instance/service.js"
import { ShellResult } from "../shell/result.js"
import type { Skill } from "../skill.js"
import {
  BusyError,
  CompactionConflictError,
  InboxConflictError,
  MessageNotFoundError,
  NotFoundError,
  PromptConflictError,
  SyntheticConflictError,
} from "./error.js"
import { SessionEvent } from "./event.js"
import { SessionExecution } from "./execution.js"
import { SessionInbox } from "./inbox.js"
import { SessionMessage } from "./message.js"
import { SessionPrompt } from "./prompt.js"
import { SessionRevert } from "./revert.js"
import { SessionShell } from "./shell.js"
import { SessionSkill } from "./skill.js"
import { SessionSchema } from "./schema.js"
import { SessionStore } from "./store.js"

type PromptRequest = SessionPrompt.Input & {
  id?: SessionMessage.ID
  resume?: boolean
}

/**
 * Build once in the host Scope: `const sessions = yield* Session.make()`.
 * Use `sessions.forSession(id)` for handles that share host services and reload current state.
 */
export const make = Effect.fn("Session.make")(function* () {
  const bus = yield* Bus.Service
  const database = yield* Database.Service
  const store = yield* SessionStore.Service
  const instances = yield* Instance.Service
  const execution = yield* SessionExecution.Service
  const admission = yield* SessionInbox.Service
  const fs = yield* FSUtil.Service
  const scope = yield* Scope.Scope

  const get = Effect.fn("Session.get")(function* (sessionID: SessionSchema.ID) {
    const session = yield* store.get(sessionID)
    if (!session) return yield* new NotFoundError({ sessionID })
    return session
  })
  const message = Effect.fn("Session.message")(function* (sessionID: SessionSchema.ID, messageID: SessionMessage.ID) {
    const stored = yield* store.message(messageID)
    return stored?.sessionID === sessionID ? stored.message : undefined
  })
  const view = Effect.fn("Session.view")(function* (sessionID: SessionSchema.ID, input: { idle: number }) {
    const session = yield* get(sessionID)
    if (
      session.time.idle === undefined ||
      input.idle > DateTime.toEpochMillis(session.time.idle) ||
      (session.time.viewed !== undefined && DateTime.toEpochMillis(session.time.viewed) >= input.idle)
    )
      return
    yield* bus.publish(SessionEvent.Viewed, { sessionID, idle: input.idle })
  })
  const rename = Effect.fn("Session.rename")(function* (sessionID: SessionSchema.ID, input: { title: string }) {
    yield* get(sessionID)
    yield* bus.publish(SessionEvent.Renamed, { sessionID, title: input.title })
  })
  const setPermissions = Effect.fn("Session.setPermissions")(function* (
    sessionID: SessionSchema.ID,
    input: { permissions: Permission.Ruleset },
  ) {
    yield* get(sessionID)
    yield* bus.publish(SessionEvent.PermissionsUpdated, { sessionID, permissions: input.permissions })
  })
  const switchAgent = Effect.fn("Session.switchAgent")(function* (
    sessionID: SessionSchema.ID,
    input: { agent: Agent.ID },
  ) {
    const session = yield* get(sessionID)
    yield* bus.publish(SessionEvent.AgentSelected, { sessionID, agent: input.agent, previous: session.agent })
  })
  const switchModel = Effect.fn("Session.switchModel")(function* (
    sessionID: SessionSchema.ID,
    input: { model: Model.Ref },
  ) {
    const session = yield* get(sessionID)
    if (
      session.model?.providerID === input.model.providerID &&
      session.model.id === input.model.id &&
      (session.model.variant ?? "default") === (input.model.variant ?? "default")
    )
      return
    yield* bus.publish(SessionEvent.ModelSelected, { sessionID, model: input.model, previous: session.model })
  })
  const mutatePending = (
    sessionID: SessionSchema.ID,
    inboxID: SessionMessage.ID,
    mutation: (input: {
      readonly id: SessionMessage.ID
      readonly sessionID: SessionSchema.ID
    }) => Effect.Effect<void, SessionInbox.LifecycleConflict>,
  ) =>
    mutation({ sessionID, id: inboxID }).pipe(
      Effect.catchTag("SessionInbox.LifecycleConflict", () =>
        Effect.gen(function* () {
          yield* get(sessionID)
          return yield* new InboxConflictError({ sessionID, inboxID })
        }),
      ),
    )

  const inbox = Effect.fn("Session.inbox")(function* (sessionID: SessionSchema.ID) {
    yield* get(sessionID)
    return yield* admission.list(sessionID)
  })
  const cancelInbox = Effect.fn("Session.cancelInbox")(
    (sessionID: SessionSchema.ID, inboxID: SessionMessage.ID) => mutatePending(sessionID, inboxID, admission.cancel),
    Effect.uninterruptible,
  )
  const steerInbox = Effect.fn("Session.steerInbox")(function* (
    sessionID: SessionSchema.ID,
    inboxID: SessionMessage.ID,
  ) {
    yield* mutatePending(sessionID, inboxID, admission.steer)
    yield* execution.wake(sessionID)
  }, Effect.uninterruptible)
  const queueInbox = Effect.fn("Session.queueInbox")(
    (sessionID: SessionSchema.ID, inboxID: SessionMessage.ID) => mutatePending(sessionID, inboxID, admission.queue),
    Effect.uninterruptible,
  )
  const prompt = Effect.fn("Session.prompt")((sessionID: SessionSchema.ID, input: PromptRequest) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const session = yield* get(sessionID)
        const messageID = input.id ?? SessionMessage.ID.create()
        const admitted = yield* Effect.gen(function* () {
          const existing = yield* admission.reconcile({
            id: messageID,
            sessionID: session.id,
            type: "user",
            delivery: input.delivery ?? "steer",
          })
          if (existing) return existing
          const item = yield* restore(
            SessionPrompt.prepare({ session, messageID, input }).pipe(
              Effect.provideService(Instance.Service, instances),
              Effect.provideService(FSUtil.Service, fs),
            ),
          )
          // Commit a staged revert only after preparation succeeds, before admitting new work.
          if (session.revert) yield* SessionRevert.commit(bus, session)
          return yield* admission.admit({
            id: messageID,
            sessionID: session.id,
            item,
          })
        }).pipe(
          Effect.catchTag("SessionInbox.LifecycleConflict", () => new PromptConflictError({ sessionID, messageID })),
        )
        if (input.resume !== false) yield* execution.wake(sessionID)
        return admitted
      }),
    ),
  )
  const shell = Effect.fn("Session.shell")(function* (
    sessionID: SessionSchema.ID,
    input: { id?: Event.ID; command: string },
  ) {
    const session = yield* get(sessionID)
    // The server owns completion recording even if the submitting client disconnects.
    const running = yield* Effect.gen(function* () {
      const started = yield* SessionShell.start({ session, command: input.command }).pipe(
        Effect.provideService(Instance.Service, instances),
        Effect.tapError((error) =>
          synthetic(sessionID, {
            text: `User shell command failed to start:\n${input.command}\n\n${error.message}`,
            description: input.command,
            metadata: { source: "shell", state: "error" },
            resume: false,
          }),
        ),
        Effect.orDie,
      )
      yield* bus.publish(
        SessionEvent.Shell.Started,
        {
          sessionID,
          shell: started.info,
        },
        { id: input.id },
      )
      const terminal = yield* started.result
      const preview = yield* started.output
      yield* bus.publish(SessionEvent.Shell.Ended, {
        sessionID,
        shell: terminal.info,
        output: preview,
      })
      yield* synthetic(sessionID, {
        ...ShellResult.userNotification(terminal),
        resume: false,
      }).pipe(
        Effect.catchTag("Session.NotFoundError", () => Effect.void),
        Effect.orDie,
      )
    }).pipe(Effect.forkIn(scope, { startImmediately: true }))
    yield* Fiber.join(running)
  })
  const skill = Effect.fn("Session.skill")(function* (
    sessionID: SessionSchema.ID,
    input: { id?: SessionMessage.ID; skill: Skill.ID; resume?: boolean },
  ) {
    const session = yield* get(sessionID)
    const skill = yield* SessionSkill.get({ session, skill: input.skill }).pipe(
      Effect.provideService(Instance.Service, instances),
    )
    yield* bus.publish(
      SessionEvent.Skill.Activated,
      {
        sessionID,
        id: skill.id,
        name: skill.name,
        text: skill.content,
      },
      { id: input.id ? Event.ID.make(input.id.replace(/^msg_/, "evt_")) : undefined },
    )
    if (input.resume !== false)
      yield* execution
        .resume(sessionID)
        .pipe(Effect.ignore, Effect.forkIn(scope, { startImmediately: true }), Effect.asVoid)
  })
  const compact = Effect.fn("Session.compact")(function* (
    sessionID: SessionSchema.ID,
    input: { id?: SessionMessage.ID; delivery?: SessionInbox.Delivery },
  ) {
    const session = yield* get(sessionID)
    if (session.revert) yield* SessionRevert.commit(bus, session)
    const inputID = input.id ?? SessionMessage.ID.create()
    const admitted = yield* admission
      .admitCompaction({
        id: inputID,
        sessionID,
        delivery: input.delivery ?? "steer",
      })
      .pipe(
        Effect.catchTag("SessionInbox.LifecycleConflict", () => new CompactionConflictError({ sessionID, inputID })),
      )
    yield* execution.wake(sessionID)
    return admitted
  })
  const wait = Effect.fn("Session.wait")(function* (sessionID: SessionSchema.ID) {
    yield* get(sessionID)
    yield* execution.awaitIdle(sessionID)
  })
  const resume = Effect.fn("Session.resume")(function* (sessionID: SessionSchema.ID) {
    yield* get(sessionID)
    yield* execution.resume(sessionID)
  })
  const synthetic = Effect.fn("Session.synthetic")(
    (
      sessionID: SessionSchema.ID,
      input: {
        id?: SessionMessage.ID
        text: string
        description?: string
        metadata?: Record<string, unknown>
        delivery?: SessionInbox.Delivery
        resume?: boolean
      },
    ) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          yield* get(sessionID)
          const inputID = input.id ?? SessionMessage.ID.create()
          const admittedInput = {
            type: "synthetic",
            payload: SessionInbox.SyntheticPayload.make({
              text: input.text,
              description: input.description,
              metadata: input.metadata,
            }),
            delivery: SessionInbox.Delivery.make(input.delivery ?? "steer"),
          } satisfies SessionInbox.Item
          const admitted = yield* admission
            .admit({
              id: inputID,
              sessionID,
              item: admittedInput,
            })
            .pipe(
              Effect.catchTag(
                "SessionInbox.LifecycleConflict",
                () => new SyntheticConflictError({ sessionID, inputID }),
              ),
            )
          if (input.resume !== false && !(yield* get(sessionID)).revert) yield* execution.wake(sessionID)
          return admitted
        }),
      ),
  )
  const interrupt = Effect.fn("Session.interrupt")(
    (sessionID: SessionSchema.ID, options?: { readonly continue?: boolean }) =>
      Effect.uninterruptible(execution.interrupt(sessionID, options)),
  )
  const stage = Effect.fn("Session.revert.stage")(function* (
    sessionID: SessionSchema.ID,
    input: { messageID: SessionMessage.ID; files?: boolean },
  ) {
    const session = yield* get(sessionID)
    if (yield* execution.isActive(sessionID)) return yield* new BusyError({ sessionID })
    return yield* SessionRevert.stage({ session, messageID: input.messageID, files: input.files }).pipe(
      Effect.provideService(Instance.Service, instances),
      Effect.provideService(Database.Service, database),
      Effect.provideService(Bus.Service, bus),
    )
  })
  const clear = Effect.fn("Session.revert.clear")(function* (sessionID: SessionSchema.ID) {
    const session = yield* get(sessionID)
    if (yield* execution.isActive(sessionID)) return yield* new BusyError({ sessionID })
    yield* SessionRevert.clear(session).pipe(
      Effect.provideService(Instance.Service, instances),
      Effect.provideService(Bus.Service, bus),
    )
    return yield* execution.wake(sessionID)
  })
  const commit = Effect.fn("Session.revert.commit")(function* (sessionID: SessionSchema.ID) {
    const session = yield* get(sessionID)
    if (yield* execution.isActive(sessionID)) return yield* new BusyError({ sessionID })
    return yield* SessionRevert.commit(bus, session)
  })
  const revert = { stage, clear, commit }
  const operations = {
    get,
    message,
    view,
    rename,
    setPermissions,
    switchAgent,
    switchModel,
    inbox,
    prompt,
    synthetic,
    shell,
    skill,
    compact,
    wait,
    resume,
    interrupt,
    cancelInbox,
    steerInbox,
    queueInbox,
    revert,
  }

  const forSession = (sessionID: SessionSchema.ID) => {
    const get = operations.get.bind(undefined, sessionID)
    const message = operations.message.bind(undefined, sessionID)
    const view = operations.view.bind(undefined, sessionID)
    const rename = operations.rename.bind(undefined, sessionID)
    const setPermissions = operations.setPermissions.bind(undefined, sessionID)
    const switchAgent = operations.switchAgent.bind(undefined, sessionID)
    const switchModel = operations.switchModel.bind(undefined, sessionID)
    const inbox = operations.inbox.bind(undefined, sessionID)
    const prompt = operations.prompt.bind(undefined, sessionID)
    const synthetic = operations.synthetic.bind(undefined, sessionID)
    const shell = operations.shell.bind(undefined, sessionID)
    const skill = operations.skill.bind(undefined, sessionID)
    const compact = operations.compact.bind(undefined, sessionID)
    const wait = operations.wait.bind(undefined, sessionID)
    const resume = operations.resume.bind(undefined, sessionID)
    const interrupt = operations.interrupt.bind(undefined, sessionID)
    const cancelInbox = operations.cancelInbox.bind(undefined, sessionID)
    const steerInbox = operations.steerInbox.bind(undefined, sessionID)
    const queueInbox = operations.queueInbox.bind(undefined, sessionID)
    const stage = operations.revert.stage.bind(undefined, sessionID)
    const clear = operations.revert.clear.bind(undefined, sessionID)
    const commit = operations.revert.commit.bind(undefined, sessionID)
    const revert = { stage, clear, commit }

    return {
      id: sessionID,
      get,
      message,
      view,
      rename,
      setPermissions,
      switchAgent,
      switchModel,
      inbox,
      prompt,
      synthetic,
      shell,
      skill,
      compact,
      wait,
      resume,
      interrupt,
      cancelInbox,
      steerInbox,
      queueInbox,
      revert,
    }
  }
  return { forSession }
})

export type Handle = ReturnType<Effect.Success<ReturnType<typeof make>>["forSession"]>

// Mirrors the shell tool's in-memory preview safety limit.
