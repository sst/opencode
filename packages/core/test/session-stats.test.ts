import { describe, expect } from "bun:test"
import { Agent } from "@opencode/schema/agent"
import { Event } from "@opencode/schema/event"
import { Model } from "@opencode/schema/model"
import { Money } from "@opencode/schema/money"
import { Project } from "@opencode/schema/project"
import { Provider } from "@opencode/schema/provider"
import { Session } from "@opencode/schema/session"
import { SessionEvent } from "@opencode/schema/session-event"
import { SessionMessage } from "@opencode/schema/session-message"
import { AbsolutePath } from "@opencode/core/schema"
import { Database } from "@opencode/core/database/database"
import { EventSequenceTable, EventTable } from "@opencode/core/event/sql"
import { ProjectTable } from "@opencode/core/project/sql"
import { SessionMessageTable, SessionTable } from "@opencode/core/session/sql"
import { SessionStats } from "@opencode/core/session/stats"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { DateTime, Effect, Schema } from "effect"
import { eq } from "drizzle-orm"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(Database.node))
const projectID = Project.ID.make("stats-project")
const otherProjectID = Project.ID.make("stats-other-project")
const sessionID = Session.ID.make("ses_stats_root")
const childID = Session.ID.make("ses_stats_child")
const forkID = Session.ID.make("ses_stats_fork")
const usageOnlyID = Session.ID.make("ses_stats_usage_only")
const otherSessionID = Session.ID.make("ses_stats_other")
const encodeMessage = Schema.encodeSync(SessionMessage.Info)
const encodeUsage = Schema.encodeSync(SessionEvent.UsageRecorded.data)

describe("SessionStats", () => {
  it.effect("counts inherited fork usage after the parent is deleted", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const parentID = Session.ID.make("ses_stats_deleted_parent")
      const orphanID = Session.ID.make("ses_stats_orphan_fork")
      yield* db
        .insert(ProjectTable)
        .values({ id: projectID, worktree: AbsolutePath.make("/stats"), name: "stats", sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values([
          { id: parentID, project_id: projectID, slug: "parent", directory: "/stats", version: "test" },
          {
            id: orphanID,
            project_id: projectID,
            fork_session_id: parentID,
            slug: "fork",
            directory: "/stats",
            version: "test",
            time_created: Date.UTC(2026, 0, 4),
          },
        ])
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionMessageTable)
        .values([
          messageRow(parentID, 1, assistant("msg_stats_deleted_parent", Date.UTC(2026, 0, 2, 10), [])),
          messageRow(
            orphanID,
            1,
            assistant("msg_stats_orphan_inherited", Date.UTC(2026, 0, 2, 10), [
              SessionMessage.AssistantTool.make({
                type: "tool",
                id: "call_inherited",
                name: "read",
                state: SessionMessage.ToolStateCompleted.make({
                  status: "completed",
                  input: {},
                  content: [{ type: "text", text: "ok" }],
                }),
                time: { created: DateTime.makeUnsafe(Date.UTC(2026, 0, 2, 10)) },
              }),
            ]),
          ),
          messageRow(orphanID, 2, assistant("msg_stats_orphan_new", Date.UTC(2026, 0, 5, 10), [])),
        ])
        .run()
        .pipe(Effect.orDie)

      yield* db.delete(SessionTable).where(eq(SessionTable.id, parentID)).run().pipe(Effect.orDie)

      const stats = yield* SessionStats.get({ to: Date.UTC(2026, 1, 1), timezone: "UTC", tools: "detail" })

      expect(DateTime.toEpochMillis(stats.range.from)).toBe(Date.UTC(2026, 0, 2, 10))
      expect(stats.steps).toBe(2)
      expect(stats.tokens).toEqual({ input: 20, output: 10, reasoning: 4, cache: { read: 8, write: 2 } })
      expect(stats.cost).toBe(Money.USD.make(3))
      expect(stats.tools).toMatchObject({
        mode: "detail",
        totals: { calls: 1, succeeded: 1, failed: 0, unfinished: 0 },
      })
    }),
  )

  it.effect("aggregates activity and tool reliability without reading message payloads outside the range", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      yield* db
        .insert(ProjectTable)
        .values([
          { id: projectID, worktree: AbsolutePath.make("/stats"), name: "stats", sandboxes: [] },
          { id: otherProjectID, worktree: AbsolutePath.make("/other"), name: "other", sandboxes: [] },
        ])
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values([
          { id: sessionID, project_id: projectID, slug: "root", directory: "/stats", version: "test" },
          {
            id: childID,
            project_id: projectID,
            parent_id: sessionID,
            slug: "child",
            directory: "/stats",
            version: "test",
          },
          {
            id: forkID,
            project_id: projectID,
            fork_session_id: sessionID,
            slug: "fork",
            directory: "/stats",
            version: "test",
            time_created: Date.UTC(2026, 0, 4),
          },
          { id: usageOnlyID, project_id: projectID, slug: "usage", directory: "/stats", version: "test" },
          { id: otherSessionID, project_id: otherProjectID, slug: "other", directory: "/other", version: "test" },
        ])
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionMessageTable)
        .values([
          messageRow(
            sessionID,
            1,
            SessionMessage.User.make({
              id: SessionMessage.ID.make("msg_stats_user"),
              type: "user",
              text: "hello",
              time: { created: DateTime.makeUnsafe(Date.UTC(2026, 0, 2, 9)) },
            }),
          ),
          messageRow(
            sessionID,
            2,
            assistant("msg_stats_assistant", Date.UTC(2026, 0, 2, 10), [
              SessionMessage.AssistantTool.make({
                type: "tool",
                id: "call_read",
                name: "read",
                state: SessionMessage.ToolStateCompleted.make({
                  status: "completed",
                  input: {},
                  content: [{ type: "text", text: "ok" }],
                }),
                time: {
                  created: DateTime.makeUnsafe(Date.UTC(2026, 0, 2, 10)),
                  ran: DateTime.makeUnsafe(Date.UTC(2026, 0, 2, 10, 0, 1)),
                  completed: DateTime.makeUnsafe(Date.UTC(2026, 0, 2, 10, 0, 1, 250)),
                },
              }),
              SessionMessage.AssistantTool.make({
                type: "tool",
                id: "call_edit",
                name: "edit",
                state: SessionMessage.ToolStateError.make({
                  status: "error",
                  input: {},
                  error: { type: "tool", message: "failed" },
                }),
                time: {
                  created: DateTime.makeUnsafe(Date.UTC(2026, 0, 2, 10)),
                  completed: DateTime.makeUnsafe(Date.UTC(2026, 0, 2, 10, 0, 2)),
                },
              }),
              SessionMessage.AssistantTool.make({
                type: "tool",
                id: "call_pending",
                name: "pending",
                state: SessionMessage.ToolStateRunning.make({ status: "running", input: {}, metadata: {} }),
                time: { created: DateTime.makeUnsafe(Date.UTC(2026, 0, 2, 10)) },
              }),
            ]),
          ),
          messageRow(childID, 1, assistant("msg_stats_child", Date.UTC(2026, 0, 3, 10), [], "large", 2)),
          messageRow(
            forkID,
            1,
            SessionMessage.User.make({
              id: SessionMessage.ID.make("msg_stats_fork_copied_user"),
              type: "user",
              text: "copied",
              time: { created: DateTime.makeUnsafe(Date.UTC(2026, 0, 2, 9)) },
            }),
          ),
          messageRow(
            forkID,
            2,
            assistant("msg_stats_fork_copied_assistant", Date.UTC(2026, 0, 2, 10), [
              SessionMessage.AssistantTool.make({
                type: "tool",
                id: "call_copied",
                name: "copied",
                state: SessionMessage.ToolStateCompleted.make({
                  status: "completed",
                  input: {},
                  content: [{ type: "text", text: "copied" }],
                }),
                time: {
                  created: DateTime.makeUnsafe(Date.UTC(2026, 0, 2, 10)),
                  completed: DateTime.makeUnsafe(Date.UTC(2026, 0, 2, 10, 0, 1)),
                },
              }),
            ]),
          ),
          messageRow(forkID, 3, assistant("msg_stats_fork_new", Date.UTC(2026, 0, 5, 10), [], "fork-new")),
          messageRow(sessionID, 3, assistant("msg_stats_outside", Date.UTC(2025, 11, 31, 10), [])),
          messageRow(usageOnlyID, 1, assistant("msg_stats_usage_only", Date.UTC(2025, 11, 30, 10), [])),
          messageRow(otherSessionID, 1, assistant("msg_stats_other", Date.UTC(2020, 0, 1, 10), [])),
        ])
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(EventSequenceTable)
        .values([
          { aggregate_id: sessionID, seq: 0 },
          { aggregate_id: childID, seq: 0 },
          { aggregate_id: usageOnlyID, seq: 0 },
        ])
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(EventTable)
        .values([
          {
            id: Event.ID.make("evt_stats_usage"),
            aggregate_id: sessionID,
            seq: 0,
            created: Date.UTC(2026, 0, 2, 10, 0, 3),
            type: SessionEvent.UsageRecorded.type,
            data: encodeUsage({
              sessionID,
              source: "title",
              cost: Money.USD.make(0.5),
              tokens: { input: 1, output: 1, reasoning: 1, cache: { read: 1, write: 1 } },
            }),
          },
          {
            id: Event.ID.make("evt_stats_usage_boundary"),
            aggregate_id: usageOnlyID,
            seq: 0,
            created: Date.UTC(2026, 0, 2, 10, 0, 3),
            type: SessionEvent.UsageRecorded.type,
            data: encodeUsage({
              sessionID: usageOnlyID,
              source: "compaction",
              cost: Money.USD.make(0.25),
              tokens: { input: 2, output: 2, reasoning: 2, cache: { read: 2, write: 2 } },
            }),
          },
        ])
        .run()
        .pipe(Effect.orDie)

      const stats = yield* SessionStats.get({
        from: Date.UTC(2026, 0, 1),
        to: Date.UTC(2026, 1, 1),
        timezone: "UTC",
        tools: "detail",
      })

      expect(stats.sessions).toBe(2)
      expect(stats.subagents).toBe(1)
      expect(stats.prompts).toBe(1)
      expect(stats.steps).toBe(3)
      expect(stats.tokens).toEqual({ input: 42, output: 22, reasoning: 10, cache: { read: 18, write: 6 } })
      expect(stats.cost).toBe(Money.USD.make(6.25))
      expect(stats.tools).toMatchObject({
        mode: "detail",
        totals: { calls: 3, succeeded: 1, failed: 1, unfinished: 1 },
      })
      expect(stats.activity).toEqual([
        { date: "2026-01-02", steps: 1 },
        { date: "2026-01-03", steps: 1 },
        { date: "2026-01-05", steps: 1 },
      ])
      expect(stats.streak).toBe(2)
      expect(stats.models.map((model) => String(model.model.id))).toEqual(["large", "sonnet", "fork-new"])
      expect(stats.tools.mode).toBe("detail")
      if (stats.tools.mode !== "detail") throw new Error("Expected detailed tool statistics")
      expect(stats.tools.usage).toMatchObject([
        { name: "read", calls: 1, succeeded: 1, failed: 0, durationP50: 250 },
        { name: "edit", calls: 1, succeeded: 0, failed: 1, durationP50: 2_000 },
        { name: "pending", calls: 1, succeeded: 0, failed: 0, unfinished: 1 },
      ])

      const summary = yield* SessionStats.get({
        from: Date.UTC(2026, 0, 1),
        to: Date.UTC(2026, 1, 1),
        timezone: "UTC",
      })
      expect(summary.models.map((model) => String(model.model.id))).toEqual(["large", "sonnet", "fork-new"])
      expect(summary.tools).toEqual({
        mode: "summary",
        totals: { calls: 3, succeeded: 1, failed: 1, unfinished: 1 },
      })

      const withoutTools = yield* SessionStats.get({
        from: Date.UTC(2026, 0, 1),
        to: Date.UTC(2026, 1, 1),
        timezone: "UTC",
        tools: "none",
      })
      expect(withoutTools.tools).toEqual({ mode: "none" })

      const project = yield* SessionStats.get({ projectID, timezone: "UTC", tools: "none" })
      expect(DateTime.toEpochMillis(project.range.from)).toBe(Date.UTC(2025, 11, 30, 10))

      const error = yield* Effect.flip(
        SessionStats.get({ from: Date.UTC(2026, 1, 1), to: Date.UTC(2026, 0, 1), tools: "none" }),
      )
      expect(error).toEqual(
        new SessionStats.InvalidRangeError({ from: Date.UTC(2026, 1, 1), to: Date.UTC(2026, 0, 1) }),
      )

      const future = yield* Effect.flip(SessionStats.get({ from: Number.MAX_SAFE_INTEGER, tools: "none" }))
      expect(future._tag).toBe("SessionStats.InvalidRangeError")
    }),
  )
})

function assistant(
  id: string,
  created: number,
  content: SessionMessage.AssistantContent[],
  model = "sonnet",
  scale = 1,
) {
  return SessionMessage.Assistant.make({
    id: SessionMessage.ID.make(id),
    type: "assistant",
    agent: Agent.ID.make("build"),
    model: { id: Model.ID.make(model), providerID: Provider.ID.make("anthropic") },
    content,
    cost: Money.USD.make(1.5 * scale),
    tokens: { input: 10 * scale, output: 5 * scale, reasoning: 2 * scale, cache: { read: 4 * scale, write: scale } },
    time: { created: DateTime.makeUnsafe(created), completed: DateTime.makeUnsafe(created + 2_000) },
  })
}

function messageRow(
  sessionID: Session.ID,
  seq: number,
  message: SessionMessage.Info,
): typeof SessionMessageTable.$inferInsert {
  const encoded = encodeMessage(message)
  const { id, type, ...data } = encoded
  return { id: SessionMessage.ID.make(id), session_id: sessionID, type, seq, time_created: encoded.time.created, data }
}
