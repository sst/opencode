import { expect } from "bun:test"
import { Database } from "bun:sqlite"
import { Effect } from "effect"
import { cliIt } from "../lib/cli-process"

const databaseEnvironment = {
  OPENCODE_DB: "export-test.db",
  OPENCODE_DISABLE_CHANNEL_DB: "1",
}

type ExportData = {
  info: { summary?: { diffs?: unknown } }
  messages: Array<{ info: { id: string; summary?: { diffs?: unknown } } }>
}

function parseExport(output: string): ExportData {
  return JSON.parse(output) as ExportData
}

function exportMessage(data: ExportData, id: string) {
  const found = data.messages.find((item) => item.info.id === id)
  if (!found || !found.info.summary) throw new Error("expected an exported message summary")
  return { id: found.info.id, summary: found.info.summary }
}

cliIt.live("hydrates side-table diffs in raw and sanitized exports", ({ opencode }) =>
  Effect.gen(function* () {
    const created = yield* opencode.run("create an export fixture", {
      env: databaseEnvironment,
    })
    opencode.expectExit(created, 0, "create export fixture")

    const database = yield* opencode.spawn(["db", "path"], {
      env: databaseEnvironment,
    })
    opencode.expectExit(database, 0, "database path")
    const db = new Database(database.stdout.trim())
    const message = db
      .query<{ id: string; session_id: string }, []>(
        "SELECT id, session_id FROM message WHERE json_extract(data, '$.role') = 'user' LIMIT 1",
      )
      .get()
    if (!message) throw new Error("expected a user message")

    db.query("UPDATE message SET data = json_set(data, '$.summary', json(?)) WHERE id = ?").run(
      JSON.stringify({
        additions: 2,
        deletions: 1,
        files: 1,
        diffs: [{ file: "inline.ts", additions: 2, deletions: 1, status: "modified" }],
      }),
      message.id,
    )
    db.query(
      "INSERT INTO message_diff (message_id, data) VALUES (?, json(?)) " +
        "ON CONFLICT(message_id) DO UPDATE SET data = excluded.data",
    ).run(
      message.id,
      JSON.stringify([
        {
          file: "side-table-secret.ts",
          patch: "side-table-secret-patch",
          additions: 2,
          deletions: 1,
          status: "modified",
        },
      ]),
    )
    db.close()

    const raw = yield* opencode.spawn(["export", message.session_id], {
      env: databaseEnvironment,
    })
    opencode.expectExit(raw, 0, "raw export")
    const rawMessage = exportMessage(parseExport(raw.stdout), message.id)
    expect(rawMessage.summary.diffs).toEqual([
      {
        file: "side-table-secret.ts",
        patch: "side-table-secret-patch",
        additions: 2,
        deletions: 1,
        status: "modified",
      },
    ])

    const sanitized = yield* opencode.spawn(["export", message.session_id, "--sanitize"], {
      env: databaseEnvironment,
    })
    opencode.expectExit(sanitized, 0, "sanitized export")
    const sanitizedMessage = exportMessage(parseExport(sanitized.stdout), message.id)
    expect(sanitizedMessage.summary.diffs).toEqual([
      {
        file: "[redacted:message-diff-file:0]",
        patch: "[redacted:message-diff-patch:0]",
        additions: 2,
        deletions: 1,
        status: "modified",
      },
    ])
  }),
)

cliIt.live("exports legacy inline and session summary diffs", ({ opencode }) =>
  Effect.gen(function* () {
    const created = yield* opencode.run("create a legacy export fixture", {
      env: databaseEnvironment,
    })
    opencode.expectExit(created, 0, "create legacy export fixture")

    const database = yield* opencode.spawn(["db", "path"], {
      env: databaseEnvironment,
    })
    opencode.expectExit(database, 0, "database path")
    const db = new Database(database.stdout.trim())
    const message = db
      .query<{ id: string; session_id: string }, []>(
        "SELECT id, session_id FROM message WHERE json_extract(data, '$.role') = 'user' LIMIT 1",
      )
      .get()
    if (!message) throw new Error("expected a user message")

    db.query("UPDATE message SET data = json_set(data, '$.summary', json(?)) WHERE id = ?").run(
      JSON.stringify({
        additions: 3,
        deletions: 2,
        files: 1,
        diffs: [
          {
            file: "legacy-inline-secret.ts",
            patch: "legacy-inline-secret-patch",
            additions: 3,
            deletions: 2,
            status: "modified",
          },
        ],
      }),
      message.id,
    )
    db.query("DELETE FROM message_diff WHERE message_id = ?").run(message.id)
    db.query(
      "UPDATE session SET summary_additions = ?, summary_deletions = ?, summary_files = ?, summary_diffs = json(?) WHERE id = ?",
    ).run(
      4,
      3,
      1,
      JSON.stringify([
        {
          file: "legacy-session-secret.ts",
          patch: "legacy-session-secret-patch",
          additions: 4,
          deletions: 3,
          status: "modified",
        },
      ]),
      message.session_id,
    )
    db.close()

    const raw = yield* opencode.spawn(["export", message.session_id], {
      env: databaseEnvironment,
    })
    opencode.expectExit(raw, 0, "raw legacy export")
    const rawMessage = exportMessage(parseExport(raw.stdout), message.id)
    expect(rawMessage.summary.diffs).toEqual([
      {
        file: "legacy-inline-secret.ts",
        patch: "legacy-inline-secret-patch",
        additions: 3,
        deletions: 2,
        status: "modified",
      },
    ])

    const sanitized = yield* opencode.spawn(["export", message.session_id, "--sanitize"], {
      env: databaseEnvironment,
    })
    opencode.expectExit(sanitized, 0, "sanitized legacy export")
    const sanitizedData = parseExport(sanitized.stdout)
    const sanitizedMessage = exportMessage(sanitizedData, message.id)
    expect(sanitizedMessage.summary.diffs).toEqual([
      {
        file: "[redacted:message-diff-file:0]",
        patch: "[redacted:message-diff-patch:0]",
        additions: 3,
        deletions: 2,
        status: "modified",
      },
    ])
    expect(sanitizedData.info.summary?.diffs).toEqual([
      {
        file: "[redacted:session-diff-file:0]",
        patch: "[redacted:session-diff-patch:0]",
        additions: 4,
        deletions: 3,
        status: "modified",
      },
    ])
  }),
)
