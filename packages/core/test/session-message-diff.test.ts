import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { eq, sql } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { MessageDiffTable } from "@opencode-ai/core/database/message-diff.sql"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { FileDiff } from "@opencode-ai/schema/file-diff"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { MessageDiff } from "@opencode-ai/core/session/message-diff"
import { MessageTable, SessionTable } from "@opencode-ai/core/session/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, MessageDiff.node])))
const sessionID = SessionSchema.ID.make("ses_message_diff_test")
const messageID = SessionV1.MessageID.make("msg_message_diff_test")
const first: ReadonlyArray<FileDiff.Info> = [
  { file: "first.ts", additions: 1, deletions: 2, patch: "first", status: "modified" },
]
const second: ReadonlyArray<FileDiff.Info> = [
  { file: "second.ts", additions: 3, deletions: 4, patch: "second", status: "added" },
]

function setup() {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
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
    yield* db.run(
      sql`INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (${messageID}, ${sessionID}, ${0}, ${0}, ${"{}"})`,
    )
    return db
  })
}

describe("MessageDiff", () => {
  it.effect("returns the latest array after an upsert", () =>
    Effect.gen(function* () {
      yield* setup()
      const diffs = yield* MessageDiff.Service
      yield* diffs.put({ messageID, diffs: first })
      yield* diffs.put({ messageID, diffs: second })
      expect(yield* diffs.get(messageID)).toEqual(second)
    }),
  )

  it.effect("removes a diff when its message is deleted", () =>
    Effect.gen(function* () {
      const db = yield* setup()
      yield* db.run("PRAGMA foreign_keys = ON")
      const diffs = yield* MessageDiff.Service
      yield* diffs.put({ messageID, diffs: first })
      yield* db.delete(MessageTable).where(eq(MessageTable.id, messageID)).run()
      expect(yield* diffs.get(messageID)).toBeUndefined()
    }),
  )
})
