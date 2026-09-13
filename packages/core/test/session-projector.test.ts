import { describe, expect } from "bun:test"
import { DateTime, Effect, Schema } from "effect"
import { asc, eq, sql } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { EventV2 } from "@opencode-ai/core/event"
import { EventTable } from "@opencode-ai/core/event/sql"
import { ModelV2 } from "@opencode-ai/core/model"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { Prompt } from "@opencode-ai/core/session/prompt"
import { SessionMessageUpdater } from "@opencode-ai/core/session/message-updater"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionInput } from "@opencode-ai/core/session/input"
import { SessionInputTable, SessionMessageTable, SessionTable } from "@opencode-ai/core/session/sql"
import { testEffect } from "./lib/effect"
import { Snapshot } from "@opencode-ai/core/snapshot"
import { Location } from "@opencode-ai/core/location"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, SessionProjector.node])))
const sessionsLayer = AppNodeBuilder.build(SessionV2.node, [[SessionExecution.node, SessionExecution.noopLayer]])
const sessionID = SessionV2.ID.make("ses_projector_test")
const created = DateTime.makeUnsafe(0)
const model = { id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.make("provider") }
const encodeMessage = Schema.encodeSync(SessionMessage.Message)

const assistantRow = (
  id: SessionMessage.ID,
  seq: number,
  time: { created: DateTime.Utc; completed?: DateTime.Utc } = { created },
) => {
  const {
    id: _,
    type,
    ...data
  } = encodeMessage(SessionMessage.Assistant.make({ id, type: "assistant", agent: "build", model, content: [], time }))
  return { id, session_id: sessionID, type, seq, time_created: DateTime.toEpochMillis(time.created), data }
}

describe("SessionProjector", () => {
  it.effect("projects moved sessions without the transitional context epoch table", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .run()
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: Project.ID.global,
          slug: "test",
          directory: "/project",
          title: "test",
          version: "test",
        })
        .run()
      yield* db.run(sql`DROP TABLE session_context_epoch`)

      yield* events.publish(SessionEvent.Moved, {
        sessionID,
        timestamp: DateTime.makeUnsafe(1),
        location: Location.Ref.make({ directory: AbsolutePath.make("/project/subdir") }),
      })

      expect(yield* db.select({ directory: SessionTable.directory }).from(SessionTable).get()).toEqual({
        directory: "/project/subdir",
      })
    }),
  )

  it.effect("projects staged, cleared, and committed reverts", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .run()
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: Project.ID.global,
          slug: "test",
          directory: "/project",
          title: "test",
          version: "test",
        })
        .run()
      const boundary = SessionMessage.ID.make("msg_boundary")
      yield* db
        .insert(SessionMessageTable)
        .values([assistantRow(boundary, 1), assistantRow(SessionMessage.ID.make("msg_later"), 2)])
        .run()
      const events = yield* EventV2.Service
      yield* events.publish(SessionEvent.RevertEvent.Staged, {
        sessionID,
        timestamp: DateTime.makeUnsafe(1),
        revert: { messageID: boundary, snapshot: Snapshot.ID.make("tree"), diff: "patch", files: [] },
      })
      expect((yield* db.select({ revert: SessionTable.revert }).from(SessionTable).get())?.revert).toMatchObject({
        messageID: boundary,
        snapshot: "tree",
        files: [],
      })
      yield* events.publish(SessionEvent.RevertEvent.Cleared, { sessionID, timestamp: DateTime.makeUnsafe(2) })
      expect((yield* db.select({ revert: SessionTable.revert }).from(SessionTable).get())?.revert).toBeNull()
      yield* events.publish(SessionEvent.RevertEvent.Staged, {
        sessionID,
        timestamp: DateTime.makeUnsafe(3),
        revert: { messageID: boundary, files: [] },
      })
      yield* events.publish(SessionEvent.RevertEvent.Committed, {
        sessionID,
        messageID: boundary,
        timestamp: DateTime.makeUnsafe(4),
      })
      expect(
        (yield* db.select({ id: SessionMessageTable.id }).from(SessionMessageTable).all()).map((row) => row.id),
      ).toEqual([boundary])
    }),
  )

  it.effect("orders projected messages and context by durable aggregate sequence", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: Project.ID.global,
          slug: "test",
          directory: "/project",
          title: "test",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)
      const events = yield* EventV2.Service

      yield* events.publish(
        SessionEvent.Prompted,
        {
          sessionID,
          messageID: SessionMessage.ID.make("msg_first"),
          timestamp: created,
          prompt: Prompt.make({ text: "first" }),
          delivery: "steer",
        },
        { id: EventV2.ID.make("evt_z") },
      )
      yield* events.publish(
        SessionEvent.Prompted,
        {
          sessionID,
          messageID: SessionMessage.ID.make("msg_second"),
          timestamp: created,
          prompt: Prompt.make({ text: "second" }),
          delivery: "steer",
        },
        { id: EventV2.ID.make("evt_a") },
      )

      const sessions = yield* SessionV2.Service
      const firstPage = yield* sessions.messages({ sessionID, limit: 1, order: "asc" })
      expect(firstPage.map((message) => (message.type === "user" ? message.text : message.type))).toEqual(["first"])
      const secondPage = yield* sessions.messages({
        sessionID,
        limit: 1,
        order: "asc",
        cursor: { id: firstPage[0]!.id, direction: "next" },
      })
      expect(secondPage.map((message) => (message.type === "user" ? message.text : message.type))).toEqual(["second"])
      expect(
        (yield* sessions.messages({
          sessionID,
          limit: 1,
          order: "asc",
          cursor: { id: secondPage[0]!.id, direction: "previous" },
        })).map((message) => (message.type === "user" ? message.text : message.type)),
      ).toEqual(["first"])
      expect(
        (yield* sessions.context(sessionID)).map((message) => (message.type === "user" ? message.text : message.type)),
      ).toEqual(["first", "second"])
    }).pipe(Effect.provide(sessionsLayer)),
  )

  it.effect("marks an inbox row promoted with the Prompted event sequence", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: Project.ID.global,
          slug: "test",
          directory: "/project",
          title: "test",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)
      const events = yield* EventV2.Service
      const id = SessionMessage.ID.make("msg_admitted")
      const admitted = yield* SessionInput.admit(db, events, {
        id,
        sessionID,
        prompt: Prompt.make({ text: "promote me" }),
        delivery: "steer",
      })
      if (!admitted) return yield* Effect.die("Prompt admission failed")

      const event = yield* events.publish(SessionEvent.Prompted, {
        sessionID,
        timestamp: admitted.timeCreated,
        messageID: id,
        prompt: Prompt.make({ text: "promote me" }),
        delivery: "steer",
      })

      expect(
        yield* db.select().from(SessionInputTable).where(eq(SessionInputTable.id, id)).get().pipe(Effect.orDie),
      ).toMatchObject({ promoted_seq: event.durable?.seq })
    }),
  )

  it.effect("projects durable context messages supported by the updater", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: Project.ID.global,
          slug: "test",
          directory: "/project",
          title: "test",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)
      const events = yield* EventV2.Service

      yield* events.publish(SessionEvent.AgentSwitched, {
        sessionID,
        messageID: SessionMessage.ID.create(),
        timestamp: created,
        agent: "build",
      })
      yield* events.publish(SessionEvent.ModelSwitched, {
        sessionID,
        messageID: SessionMessage.ID.create(),
        timestamp: created,
        model,
      })
      yield* events.publish(SessionEvent.Synthetic, {
        sessionID,
        messageID: SessionMessage.ID.create(),
        timestamp: created,
        text: "synthetic context",
      })
      yield* events.publish(SessionEvent.Shell.Started, {
        sessionID,
        messageID: SessionMessage.ID.create(),
        timestamp: created,
        callID: "shell-1",
        command: "pwd",
      })
      yield* events.publish(SessionEvent.Shell.Ended, {
        sessionID,
        timestamp: DateTime.makeUnsafe(1),
        callID: "shell-1",
        output: "/project",
      })
      const compactionID = SessionMessage.ID.create()
      yield* events.publish(SessionEvent.Compaction.Started, {
        sessionID,
        messageID: compactionID,
        timestamp: created,
        reason: "manual",
      })
      yield* events.publish(SessionEvent.Compaction.Delta, {
        sessionID,
        messageID: compactionID,
        timestamp: created,
        text: "partial",
      })
      expect(
        yield* db
          .select({ id: EventTable.id })
          .from(EventTable)
          .where(eq(EventTable.type, SessionEvent.Compaction.Delta.type))
          .all()
          .pipe(Effect.orDie),
      ).toEqual([])
      expect(
        yield* db
          .select({ id: SessionMessageTable.id })
          .from(SessionMessageTable)
          .where(eq(SessionMessageTable.type, "compaction"))
          .all()
          .pipe(Effect.orDie),
      ).toEqual([])
      yield* events.publish(SessionEvent.Compaction.Failed, {
        sessionID,
        messageID: SessionMessage.ID.create(),
        timestamp: DateTime.makeUnsafe(1),
        reason: "auto",
        failure: "context",
        diagnostics: { requested: "suffix", fallback: "context", durationMs: 1 },
      })
      expect(
        yield* db
          .select({ id: SessionMessageTable.id })
          .from(SessionMessageTable)
          .where(eq(SessionMessageTable.type, "compaction"))
          .all()
          .pipe(Effect.orDie),
      ).toEqual([])
      yield* events.publish(SessionEvent.Compaction.Ended, {
        sessionID,
        messageID: compactionID,
        timestamp: DateTime.makeUnsafe(1),
        reason: "manual",
        text: "summary",
        recent: "recent context",
        diagnostics: {
          requested: "suffix",
          used: "prepend",
          fallback: "invalid_summary",
          durationMs: 12,
          tokens: { input: 40, cached: 30, output: 10 },
        },
      })

      const rows = yield* db
        .select()
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.session_id, sessionID))
        .orderBy(asc(SessionMessageTable.seq))
        .all()
        .pipe(Effect.orDie)
      const messages = rows.map((row) =>
        Schema.decodeUnknownSync(SessionMessage.Message)({ ...row.data, id: row.id, type: row.type }),
      )

      expect(messages.map((message) => message.type)).toEqual([
        "agent-switched",
        "model-switched",
        "synthetic",
        "shell",
        "compaction",
      ])
      expect(messages.find((message) => message.type === "shell")).toMatchObject({
        output: "/project",
        time: { completed: DateTime.makeUnsafe(1) },
      })
      expect(messages.find((message) => message.type === "compaction")).toMatchObject({
        summary: "summary",
        recent: "recent context",
        diagnostics: {
          requested: "suffix",
          used: "prepend",
          fallback: "invalid_summary",
          durationMs: 12,
          tokens: { input: 40, cached: 30, output: 10 },
        },
      })
      expect(
        yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get().pipe(Effect.orDie),
      ).toMatchObject({
        agent: "build",
        model,
        time_updated: DateTime.toEpochMillis(created),
      })
    }),
  )

  it.effect("rejects distinct creator events that reuse one projected message ID", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: Project.ID.global,
          slug: "test",
          directory: "/project",
          title: "test",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)
      const events = yield* EventV2.Service
      const id = SessionMessage.ID.make("msg_creator_collision")

      yield* events.publish(SessionEvent.Synthetic, { sessionID, messageID: id, timestamp: created, text: "keep me" })
      const exit = yield* events
        .publish(SessionEvent.Step.Started, {
          sessionID,
          assistantMessageID: id,
          timestamp: created,
          agent: "build",
          model,
        })
        .pipe(Effect.exit)

      expect(exit._tag).toBe("Failure")
      expect(
        yield* db.select().from(SessionMessageTable).where(eq(SessionMessageTable.id, id)).get().pipe(Effect.orDie),
      ).toMatchObject({ type: "synthetic" })
    }),
  )

  it.effect("does not revive a stale incomplete in-memory assistant projection", () =>
    Effect.gen(function* () {
      const stale = SessionMessage.Assistant.make({
        id: SessionMessage.ID.make("msg_assistant_stale"),
        type: "assistant",
        agent: "build",
        model,
        content: [],
        time: { created },
      })
      const completed = SessionMessage.Assistant.make({
        id: SessionMessage.ID.make("msg_assistant_completed"),
        type: "assistant",
        agent: "build",
        model,
        content: [],
        time: { created: DateTime.makeUnsafe(1), completed: DateTime.makeUnsafe(2) },
      })

      expect(
        yield* SessionMessageUpdater.memory({ messages: [stale, completed] }).getCurrentAssistant(),
      ).toBeUndefined()
    }),
  )

  it.effect("updates only the newest incomplete assistant projection", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: Project.ID.global,
          slug: "test",
          directory: "/project",
          title: "test",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionMessageTable)
        .values([
          assistantRow(SessionMessage.ID.make("msg_assistant_1"), 0),
          assistantRow(SessionMessage.ID.make("msg_assistant_2"), 1),
        ])
        .run()
        .pipe(Effect.orDie)

      const service = yield* EventV2.Service
      yield* service.publish(SessionEvent.Step.Ended, {
        sessionID,
        timestamp: DateTime.makeUnsafe(1),
        assistantMessageID: SessionMessage.ID.make("msg_assistant_2"),
        finish: "stop",
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      })

      const rows = yield* db
        .select()
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.session_id, sessionID))
        .orderBy(asc(SessionMessageTable.id))
        .all()
        .pipe(Effect.orDie)
      const messages = rows.map((row) =>
        Schema.decodeUnknownSync(SessionMessage.Message)({ ...row.data, id: row.id, type: row.type }),
      )
      expect(messages[0]).not.toHaveProperty("time.completed")
      expect(messages[1]).toMatchObject({
        type: "assistant",
        finish: "stop",
        time: { completed: DateTime.makeUnsafe(1) },
      })
    }),
  )

  it.effect("does not revive a stale incomplete assistant projection", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: Project.ID.global,
          slug: "test",
          directory: "/project",
          title: "test",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionMessageTable)
        .values([
          assistantRow(SessionMessage.ID.make("msg_assistant_stale"), 0),
          assistantRow(SessionMessage.ID.make("msg_assistant_completed"), 1, {
            created: DateTime.makeUnsafe(1),
            completed: DateTime.makeUnsafe(2),
          }),
        ])
        .run()
        .pipe(Effect.orDie)

      const service = yield* EventV2.Service
      yield* service.publish(SessionEvent.Text.Started, {
        sessionID,
        assistantMessageID: SessionMessage.ID.make("msg_assistant_completed"),
        timestamp: DateTime.makeUnsafe(3),
        textID: "text-stale",
      })

      const rows = yield* db
        .select()
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.session_id, sessionID))
        .orderBy(asc(SessionMessageTable.id))
        .all()
        .pipe(Effect.orDie)
      const messages = rows.map((row) =>
        Schema.decodeUnknownSync(SessionMessage.Message)({ ...row.data, id: row.id, type: row.type }),
      )
      expect(messages).toEqual([
        SessionMessage.Assistant.make({
          id: SessionMessage.ID.make("msg_assistant_completed"),
          type: "assistant",
          agent: "build",
          model,
          content: [SessionMessage.AssistantText.make({ type: "text", id: "text-stale", text: "" })],
          time: { created: DateTime.makeUnsafe(1), completed: DateTime.makeUnsafe(2) },
        }),
        SessionMessage.Assistant.make({
          id: SessionMessage.ID.make("msg_assistant_stale"),
          type: "assistant",
          agent: "build",
          model,
          content: [],
          time: { created },
        }),
      ])
    }),
  )
})
