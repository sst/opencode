export * as Session from "./session.js"
export * from "./session/schema.js"

import { Effect, Layer, Schema, Context, Stream } from "effect"
import { LLMClient } from "@opencode/ai"
import { ListAnchor } from "@opencode/schema/session"
import { and, asc, desc, eq, lt, lte, sql } from "drizzle-orm"
import { Project } from "./project.js"
import { Model } from "@opencode/schema/model"
import { Location } from "./location.js"
import { SessionMessage } from "./session/message.js"
import { PromptInput } from "@opencode/schema/prompt-input"
import { Bus } from "./bus.js"
import { Instance } from "./instance/service.js"
import { Database } from "./database/database.js"
import { SessionProjector } from "./session/projector.js"
import { SessionMessageTable } from "./session/sql.js"
import { SessionSchema } from "./session/schema.js"
import { RelativePath } from "./schema.js"
import { Agent } from "@opencode/schema/agent"
import type { Permission } from "@opencode/schema/permission"
import { App } from "./app.js"
import { Slug } from "./util/slug.js"
import path from "path"
import { SessionRunner } from "./session/runner/index.js"
import { SessionStore } from "./session/store.js"
import { decodeMessageRow } from "./session/history.js"
import { SessionExecution } from "./session/execution.js"
import {
  AttachmentError,
  BusyError,
  CompactionConflictError,
  ForkEmptyError,
  InboxConflictError,
  MessageDecodeError,
  MessageNotFoundError,
  NotFoundError,
  PromptConflictError,
  SkillNotFoundError,
  SyntheticConflictError,
} from "./session/error.js"
import { Node } from "@opencode/util/effect/app-node"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { SessionEvent } from "./session/event.js"
import { SessionInbox } from "./session/inbox.js"
import { InstructionState } from "./session/instruction-state.js"
import { SessionGenerate } from "./session/generate.js"
import { SessionCommand } from "./session/command.js"
import {
  SessionMove,
  DestinationNotFoundError,
  DestinationNotDirectoryError,
  DestinationUnavailableError,
} from "./session/move.js"
import { SessionModelTransport } from "./session/model-transport.js"
import { llmClient } from "./effect/app-node-platform.js"
import { Snapshot } from "./snapshot.js"
import { Session } from "./session/session.js"
import { SessionDiff, TurnRangeError } from "./session/diff.js"
import { LocationServiceMap } from "./location-service-map.js"
import { FSUtil } from "@opencode/util/fs-util"
import type { EventLog } from "@opencode/schema/event-log"
import type { FileDiff } from "@opencode/schema/file-diff"
import { Job } from "./job.js"
import type { Command } from "./command.js"
import { SessionEnvironment } from "./session/environment.js"
import { InstructionEntry } from "./session/instruction-entry.js"

// get project -> project.locations
//
// get all sessions
//

// - by project
//   - by subpath
// - by workspace (home is special)

export { ListAnchor }

export const ListInput = SessionStore.ListInput
export type ListInput = SessionStore.ListInput

type CreateBaseInput = {
  id?: SessionSchema.ID
  title?: string
  agent?: Agent.ID
  model?: Model.Ref
  metadata?: SessionSchema.Metadata
  permissions?: Permission.Ruleset
}
type CreateInput = CreateBaseInput &
  ({ location: Location.Ref; parentID?: never } | { parentID: SessionSchema.ID; location?: never })

type CompactInput = Parameters<Session.Handle["compact"]>[0] & { sessionID: SessionSchema.ID }

type ForkInput = {
  sessionID: SessionSchema.ID
  boundary: SessionSchema.ForkRequestBoundary
  filter?: (messages: readonly SessionMessage.Info[]) => readonly SessionMessage.Info[]
}

export {
  AttachmentError,
  BusyError,
  CompactionConflictError,
  InboxConflictError,
  MessageDecodeError,
  MessageNotFoundError,
  NotFoundError,
  PromptConflictError,
  SkillNotFoundError,
  SyntheticConflictError,
}
type InboxItemRef = { readonly sessionID: SessionSchema.ID; readonly inboxID: SessionMessage.ID }

export { DestinationNotFoundError, DestinationNotDirectoryError, DestinationUnavailableError }
export { TurnRangeError }

export interface Interface {
  readonly list: (input?: ListInput) => Effect.Effect<{
    readonly data: SessionSchema.Info[]
  }>
  readonly create: (input: CreateInput) => Effect.Effect<SessionSchema.Info, NotFoundError>
  readonly fork: (
    input: ForkInput,
  ) => Effect.Effect<SessionSchema.Info, NotFoundError | MessageNotFoundError | ForkEmptyError>
  readonly get: (sessionID: SessionSchema.ID) => Effect.Effect<SessionSchema.Info, NotFoundError>
  readonly environment: (input: {
    readonly sessionID: SessionSchema.ID
    readonly variables?: SessionEnvironment.Variables
  }) => Effect.Effect<SessionEnvironment.Variables | undefined, NotFoundError>
  readonly view: (input: { sessionID: SessionSchema.ID; idle: number }) => Effect.Effect<void, NotFoundError>
  readonly remove: (sessionID: SessionSchema.ID) => Effect.Effect<void, NotFoundError>
  readonly messages: (
    input: SessionStore.MessagesInput,
  ) => Effect.Effect<SessionMessage.Info[], NotFoundError | MessageDecodeError>
  readonly message: (input: {
    sessionID: SessionSchema.ID
    messageID: SessionMessage.ID
  }) => Effect.Effect<SessionMessage.Info | undefined>
  readonly context: (
    sessionID: SessionSchema.ID,
  ) => Effect.Effect<SessionMessage.Info[], NotFoundError | MessageDecodeError>
  /** Structured diffs of the files changed by a turn or range of turns; see `SessionDiff.turn`. */
  readonly diff: (input: {
    readonly sessionID: SessionSchema.ID
    readonly from?: SessionMessage.ID
    readonly to?: SessionMessage.ID
    readonly context?: number
  }) => Effect.Effect<readonly FileDiff.Info[], NotFoundError | MessageNotFoundError | TurnRangeError | Snapshot.Error>
  /**
   * Durable admitted session work not yet visible in projected history,
   * ordered by admission. Includes unpromoted user and synthetic inputs and
   * unhandled compaction barriers.
   */
  readonly inbox: (sessionID: SessionSchema.ID) => Effect.Effect<SessionInbox.Info[], NotFoundError>
  readonly cancelInbox: (input: InboxItemRef) => Effect.Effect<void, NotFoundError | InboxConflictError>
  readonly steerInbox: (input: InboxItemRef) => Effect.Effect<void, NotFoundError | InboxConflictError>
  readonly queueInbox: (input: InboxItemRef) => Effect.Effect<void, NotFoundError | InboxConflictError>
  /**
   * Durable, ordered session log read. Replays durable session bus after
   * the exclusive `after` cursor, emits a `Synced` marker at the captured
   * replay watermark, then continues live when `follow` is set.
   * The marker's seq may exceed the last emitted event because other durable
   * bus share the aggregate's sequence space.
   */
  readonly log: (input: {
    sessionID: SessionSchema.ID
    after?: number
    follow?: boolean
  }) => Stream.Stream<SessionEvent.DurableEvent | EventLog.Synced, NotFoundError>
  readonly switchAgent: (input: { sessionID: SessionSchema.ID; agent: Agent.ID }) => Effect.Effect<void, NotFoundError>
  readonly switchModel: (input: { sessionID: SessionSchema.ID; model: Model.Ref }) => Effect.Effect<void, NotFoundError>
  readonly rename: (input: { sessionID: SessionSchema.ID; title: string }) => Effect.Effect<void, NotFoundError>
  readonly setPermissions: (input: {
    sessionID: SessionSchema.ID
    permissions: Permission.Ruleset
  }) => Effect.Effect<void, NotFoundError>
  readonly move: SessionMove.Interface["move"]
  readonly prompt: (
    input: Parameters<Session.Handle["prompt"]>[0] & { sessionID: SessionSchema.ID },
  ) => ReturnType<Session.Handle["prompt"]>
  /** Generates text from current Session context without admitting input or mutating history. */
  readonly generate: (input: {
    sessionID: SessionSchema.ID
    prompt: string
  }) => Effect.Effect<string, NotFoundError | SessionGenerate.Error>
  readonly command: (input: {
    sessionID: SessionSchema.ID
    command: string
    text: string
    files?: PromptInput.Prompt["files"]
    agents?: PromptInput.Prompt["agents"]
    skills?: PromptInput.Prompt["skills"]
    delivery?: SessionInbox.Delivery
  }) => Effect.Effect<void, NotFoundError | Command.NotFoundError | Command.ExecutionError>
  readonly shell: (
    input: Parameters<Session.Handle["shell"]>[0] & { sessionID: SessionSchema.ID },
  ) => ReturnType<Session.Handle["shell"]>
  readonly skill: (
    input: Parameters<Session.Handle["skill"]>[0] & { sessionID: SessionSchema.ID },
  ) => ReturnType<Session.Handle["skill"]>
  readonly compact: (
    input: CompactInput,
  ) => Effect.Effect<SessionInbox.Compaction, NotFoundError | CompactionConflictError>
  readonly wait: (id: SessionSchema.ID) => Effect.Effect<void, NotFoundError>
  readonly active: Effect.Effect<ReadonlySet<SessionSchema.ID>>
  readonly background: (sessionID: SessionSchema.ID) => Effect.Effect<void, NotFoundError>
  readonly resume: (sessionID: SessionSchema.ID) => Effect.Effect<void, NotFoundError | SessionRunner.RunError>
  readonly interrupt: (sessionID: SessionSchema.ID, options?: { readonly continue?: boolean }) => Effect.Effect<boolean>
  readonly synthetic: (
    input: Parameters<Session.Handle["synthetic"]>[0] & { sessionID: SessionSchema.ID },
  ) => ReturnType<Session.Handle["synthetic"]>
  readonly revert: {
    readonly stage: (input: {
      sessionID: SessionSchema.ID
      messageID: SessionMessage.ID
      files?: boolean
    }) => Effect.Effect<SessionSchema.Revert, NotFoundError | MessageNotFoundError | BusyError | Snapshot.Error>
    readonly clear: (sessionID: SessionSchema.ID) => Effect.Effect<void, NotFoundError | BusyError | Snapshot.Error>
    readonly commit: (sessionID: SessionSchema.ID) => Effect.Effect<void, NotFoundError | BusyError>
  }
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Session") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const app = yield* App.Metadata
    const database = yield* Database.Service
    const db = database.db
    const bus = yield* Bus.Service
    const projects = yield* Project.Service
    const execution = yield* SessionExecution.Service
    const llm = yield* LLMClient.Service
    const transport = yield* SessionModelTransport.Service
    const store = yield* SessionStore.Service
    const instances = yield* Instance.Service
    const moves = yield* SessionMove.Service
    const jobs = yield* Job.Service
    const environments = yield* SessionEnvironment.Service
    const locations = yield* LocationServiceMap.Service
    const sessions = yield* Session.make()
    const isDurableSessionEvent = Schema.is(SessionEvent.Durable)

    const result = Service.of({
      create: Effect.fn("Session.create")(function* (input) {
        const sessionID = input.id ?? SessionSchema.ID.create()
        const recorded = yield* store.get(sessionID)
        if (recorded) return recorded
        const parent = input.parentID ? yield* store.get(input.parentID) : undefined
        if (input.parentID && parent === undefined) return yield* new NotFoundError({ sessionID: input.parentID })
        const location = parent?.location ?? input.location
        if (location === undefined)
          return yield* Effect.die(new Error("Session.create requires either location or an existing parentID"))
        const project = yield* projects.resolve(location.directory)
        const projected = yield* bus
          .publish(
            SessionEvent.Created,
            {
              sessionID,
              slug: Slug.create(),
              version: app.version,
              projectID: project.id,
              parentID: input.parentID,
              location,
              subpath: RelativePath.make(path.relative(project.directory, location.directory).replaceAll("\\", "/")),
              title: input.title,
              agent: input.agent,
              // Children inherit metadata and permissions the way they inherit
              // location, so host policies that read them treat the family uniformly.
              metadata: input.metadata ?? parent?.metadata,
              permissions: input.permissions ?? parent?.permissions,
              model: input.model
                ? {
                    id: Model.ID.make(input.model.id),
                    providerID: input.model.providerID,
                    variant: input.model.variant,
                  }
                : undefined,
            },
            { location },
          )
          .pipe(
            Effect.as({ type: "created" } as const),
            Effect.catchDefect((defect) => {
              if (!(defect instanceof SessionProjector.SessionAlreadyProjected)) {
                return Effect.die(defect)
              }
              // Concurrent creation lost the projection race. The existing Session identity wins.
              return store
                .get(sessionID)
                .pipe(
                  Effect.flatMap((session) =>
                    session ? Effect.succeed({ type: "existing", session } as const) : Effect.die(defect),
                  ),
                )
            }),
          )
        if (projected.type === "existing") return projected.session
        // TODO: Restore recorded sessions onto replacement synchronized workspaces in a future API slice.
        return yield* result.get(sessionID).pipe(Effect.orDie)
      }),
      fork: Effect.fn("Session.fork")(function* (input) {
        const parent = yield* result.get(input.sessionID)
        const boundary = yield* db
          .select({ id: SessionMessageTable.id, seq: SessionMessageTable.seq })
          .from(SessionMessageTable)
          .where(
            and(
              eq(SessionMessageTable.session_id, input.sessionID),
              input.boundary.type === "before" ? eq(SessionMessageTable.id, input.boundary.messageID) : undefined,
            ),
          )
          .orderBy(desc(SessionMessageTable.seq))
          .limit(1)
          .get()
          .pipe(Effect.orDie)
        if (!boundary && input.boundary.type === "before")
          return yield* new MessageNotFoundError({
            sessionID: input.sessionID,
            messageID: input.boundary.messageID,
          })
        if (!boundary) return yield* new ForkEmptyError({ sessionID: input.sessionID })
        const messages = input.filter
          ? input.filter(
              yield* db
                .select()
                .from(SessionMessageTable)
                .where(
                  and(
                    eq(SessionMessageTable.session_id, parent.id),
                    input.boundary.type === "before"
                      ? lt(SessionMessageTable.seq, boundary.seq)
                      : lte(SessionMessageTable.seq, boundary.seq),
                    sql`${SessionMessageTable.type} != 'assistant' or json_extract(${SessionMessageTable.data}, '$.time.completed') is not null`,
                    sql`${SessionMessageTable.type} != 'shell' or json_extract(${SessionMessageTable.data}, '$.status') != 'running'`,
                    sql`${SessionMessageTable.type} != 'compaction' or json_extract(${SessionMessageTable.data}, '$.status') != 'running'`,
                  ),
                )
                .orderBy(asc(SessionMessageTable.seq))
                .all()
                .pipe(
                  Effect.orDie,
                  Effect.flatMap((rows) => Effect.forEach(rows, decodeMessageRow)),
                  Effect.orDie,
                ),
            )
          : undefined
        const sessionID = SessionSchema.ID.create()
        const inherited = yield* db
          .transaction(() =>
            Effect.all({
              instructions: InstructionState.current(db, parent.id),
              instructionEntries: InstructionEntry.snapshot(db, parent.id),
            }),
          )
          .pipe(Effect.orDie)
        // The fork adopts the parent's newest instruction values rather than the
        // values in effect at the boundary; copied history may contain frozen
        // instruction-update text the initial baseline already reflects.
        yield* bus.publish(SessionEvent.Forked, {
          sessionID,
          parentID: parent.id,
          boundary: { ...input.boundary, messageID: boundary.id },
          messages: messages === undefined ? undefined : Schema.encodeSync(Schema.Array(SessionMessage.Info))(messages),
          ...inherited,
        })
        return yield* result.get(sessionID).pipe(Effect.orDie)
      }),
      get: (sessionID) => sessions.forSession(sessionID).get(),
      environment: Effect.fn("Session.environment")(function* (input) {
        yield* result.get(input.sessionID)
        if (input.variables !== undefined) yield* environments.set(input.sessionID, input.variables)
        return yield* environments.get(input.sessionID)
      }),
      view: (input) => sessions.forSession(input.sessionID).view(input),
      remove: Effect.fn("Session.remove")(function* (sessionID) {
        yield* result.get(sessionID)
        yield* execution.interrupt(sessionID)
        yield* execution.awaitIdle(sessionID)
        yield* transport.close(sessionID)
        const children = yield* result.list({ parentID: sessionID })
        yield* Effect.forEach(children.data, (child) => result.remove(child.id), { concurrency: 1, discard: true })
        yield* environments.clear(sessionID)
        yield* bus.publish(SessionEvent.Deleted, { sessionID })
        yield* bus.remove(sessionID)
      }),
      list: Effect.fn("Session.list")(function* (input) {
        return { data: yield* store.list(input) }
      }),
      messages: Effect.fn("Session.messages")(function* (input) {
        yield* result.get(input.sessionID)
        return yield* store.messages(input)
      }),
      message: (input) => sessions.forSession(input.sessionID).message(input.messageID),
      context: Effect.fn("Session.context")(function* (sessionID) {
        yield* result.get(sessionID)
        return yield* store.context(sessionID)
      }),
      diff: Effect.fn("Session.diff")(function* (input) {
        const session = yield* result.get(input.sessionID)
        const active = yield* execution.isActive(input.sessionID)
        return yield* SessionDiff.turn(db, locations, {
          session,
          active,
          from: input.from,
          to: input.to,
          context: input.context,
        })
      }),
      inbox: (sessionID) => sessions.forSession(sessionID).inbox(),
      cancelInbox: (input) => sessions.forSession(input.sessionID).cancelInbox(input.inboxID),
      steerInbox: (input) => sessions.forSession(input.sessionID).steerInbox(input.inboxID),
      queueInbox: (input) => sessions.forSession(input.sessionID).queueInbox(input.inboxID),
      log: (input) =>
        Stream.unwrap(
          result
            .get(input.sessionID)
            .pipe(Effect.as(bus.log({ aggregateID: input.sessionID, after: input.after, follow: input.follow }))),
        ).pipe(
          Stream.filter(
            (item): item is SessionEvent.DurableEvent | EventLog.Synced =>
              Bus.isSynced(item) || isDurableSessionEvent(item),
          ),
        ),
      prompt: (input) => sessions.forSession(input.sessionID).prompt(input),
      generate: Effect.fn("Session.generate")(function* (input) {
        const session = yield* result.get(input.sessionID)
        return yield* SessionGenerate.generate({ session, prompt: input.prompt }).pipe(
          Effect.provideService(Instance.Service, instances),
          Effect.provideService(Database.Service, database),
          Effect.provideService(LLMClient.Service, llm),
        )
      }),
      command: Effect.fn("Session.command")(function* (input) {
        const session = yield* result.get(input.sessionID)
        return yield* SessionCommand.execute({ ...input, session }).pipe(
          Effect.provideService(Instance.Service, instances),
        )
      }),
      shell: (input) => sessions.forSession(input.sessionID).shell(input),
      skill: (input) => sessions.forSession(input.sessionID).skill(input),
      switchAgent: (input) => sessions.forSession(input.sessionID).switchAgent(input),
      switchModel: (input) => sessions.forSession(input.sessionID).switchModel(input),
      rename: (input) => sessions.forSession(input.sessionID).rename(input),
      setPermissions: (input) => sessions.forSession(input.sessionID).setPermissions(input),
      move: moves.move,
      compact: (input) => sessions.forSession(input.sessionID).compact(input),
      wait: (sessionID) => sessions.forSession(sessionID).wait(),
      active: execution.active,
      background: Effect.fn("Session.background")(function* (sessionID) {
        yield* result.get(sessionID)
        const backgrounded = yield* jobs.backgroundAll({ sessionID })
        if (backgrounded.length === 0) return
        yield* result
          .synthetic({
            sessionID,
            text: [
              "User requested that active blocking work be moved to the background.",
              "",
              "Backgrounded work:",
              ...backgrounded.map((job) => `- ${job.type}: ${job.title && job.title.length > 0 ? job.title : job.id}`),
              "",
              "The backgrounded work is still unfinished. Move on to other work if you can. If there is nothing else useful to do, finish your response. Do not wait, sleep, poll, or report the backgrounded work as complete until a later completion notification is added to the conversation.",
            ].join("\n"),
          })
          .pipe(Effect.catchTag("Session.SyntheticConflictError", Effect.die))
      }),
      resume: (sessionID) => sessions.forSession(sessionID).resume(),
      synthetic: (input) => sessions.forSession(input.sessionID).synthetic(input),
      interrupt: (sessionID, options) => sessions.forSession(sessionID).interrupt(options),
      revert: {
        stage: (input) => sessions.forSession(input.sessionID).revert.stage(input),
        clear: (sessionID) => sessions.forSession(sessionID).revert.clear(),
        commit: (sessionID) => sessions.forSession(sessionID).revert.commit(),
      },
    })

    return result
  }),
)

export const node: LayerNode.Provider<Service, never, typeof Node.tags.values.global> = Node.makeGlobalNode({
  service: Service,
  layer,
  deps: [
    Job.node,
    SessionEnvironment.node,
    Database.node,
    Bus.node,
    Project.node,
    SessionExecution.node,
    SessionModelTransport.node,
    llmClient,
    SessionStore.node,
    Instance.node,
    SessionInbox.node,
    SessionMove.node,
    SessionProjector.node,
    LocationServiceMap.node,
    FSUtil.node,
    App.node,
  ],
})
