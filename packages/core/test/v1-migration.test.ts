import { describe, expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@opencode/core/database/drizzle"
import { Database } from "@opencode/core/database/database"
import { DatabaseMigration } from "@opencode/core/database/migration"
import { V1Migration } from "@opencode/core/database/v1-migration"
import { SessionMessage } from "@opencode/core/session/message"
import { SessionSchema } from "@opencode/core/session/schema"
import { SessionTable } from "@opencode/core/session/sql"
import { Project } from "@opencode/core/project"
import { ProjectTable } from "@opencode/core/project/sql"
import { AbsolutePath } from "@opencode/core/schema"
import { Global } from "@opencode/util/global"
import { Effect, Fiber, Layer, Logger, Schedule, Schema, Scope } from "effect"
import { eq, sql } from "drizzle-orm"
import type { SqlClient } from "effect/unstable/sql/SqlClient"
import { tmpdir } from "./fixture/tmpdir"
import path from "path"

const makeDb = EffectDrizzleSqlite.makeWithDefaults()
const run = <A, E>(effect: Effect.Effect<A, E, SqlClient | Scope.Scope | Global.Service>) =>
  Effect.runPromise(
    Effect.scoped(
      effect.pipe(
        Effect.provideService(Global.Service, Global.make({ data: path.join(process.cwd(), ".test-data") })),
        Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })),
      ),
    ),
  )

const session = (
  overrides: Partial<V1Migration.TransformInput["session"]> = {},
): V1Migration.TransformInput["session"] => ({
  id: SessionSchema.ID.make("ses_test"),
  project_id: Project.ID.global,
  workspace_id: null,
  parent_id: null,
  fork_session_id: null,
  fork_boundary: null,
  slug: "test",
  directory: "/tmp/test",
  path: null,
  title: "Test",
  version: "1",
  share_url: null,
  summary_additions: null,
  summary_deletions: null,
  summary_files: null,
  summary_diffs: null,
  metadata: null,
  cost: 99,
  tokens_input: 99,
  tokens_output: 99,
  tokens_reasoning: 99,
  tokens_cache_read: 99,
  tokens_cache_write: 99,
  revert: null,
  permission: null,
  agent: null,
  model: null,
  time_created: 1,
  time_updated: 2,
  time_idle: null,
  time_viewed: null,
  idle_outcome: null,
  time_compacting: 3,
  time_archived: null,
  time_suspended: null,
  resume_attempts: 0,
  ...overrides,
})

const user = (id: string, overrides: Record<string, unknown> = {}, time = 10): V1Migration.SourceMessage => ({
  id,
  session_id: "ses_test",
  time_created: time,
  time_updated: time + 1,
  data: JSON.stringify({
    role: "user",
    time: { created: time },
    agent: "build",
    model: { providerID: "provider", modelID: "model" },
    ...overrides,
  }),
})

const assistant = (
  id: string,
  parentID: string,
  overrides: Record<string, unknown> = {},
  time = 20,
): V1Migration.SourceMessage => ({
  id,
  session_id: "ses_test",
  time_created: time,
  time_updated: time + 1,
  data: JSON.stringify({
    role: "assistant",
    time: { created: time, completed: time + 5 },
    parentID,
    modelID: "model",
    providerID: "provider",
    mode: "build",
    agent: "build",
    path: { cwd: "/tmp/test", root: "/tmp/test" },
    cost: 1,
    tokens: { total: 10, input: 2, output: 3, reasoning: 4, cache: { read: 5, write: 6 } },
    ...overrides,
  }),
})

const part = (id: string, messageID: string, data: Record<string, unknown> | string): V1Migration.SourcePart => ({
  id,
  message_id: messageID,
  session_id: "ses_test",
  time_created: 1,
  time_updated: 2,
  data: typeof data === "string" ? data : JSON.stringify(data),
})

const transform = (messages: V1Migration.SourceMessage[], parts: V1Migration.SourcePart[], info = session()) => {
  const result = V1Migration.transformSession({ session: info, messages, parts })
  result.messages.forEach((row) =>
    Schema.decodeUnknownSync(SessionMessage.Info)({ id: row.id, type: row.type, ...row.data }),
  )
  return result
}

describe("V1Migration.transformSession", () => {
  test("maps ordinary user text, agents, ignored fields, order, and timestamps", () => {
    const message = user("msg_000000000001aaaaaaaaaaaaaa", {
      system: "discard",
      tools: { read: false },
      format: { type: "text" },
      summary: { title: "discard", diffs: [] },
    })
    const result = transform(
      [message],
      [
        part("prt_4", message.id, { type: "agent", name: "review" }),
        part("prt_2", message.id, { type: "text", text: "ignored", ignored: true }),
        part("prt_3", message.id, { type: "agent", name: "build", source: { value: "@build", start: 2, end: 8 } }),
        part("prt_1", message.id, { type: "text", text: "first" }),
        part("prt_5", message.id, { type: "text", text: "second" }),
      ],
    )
    expect(result.messages).toEqual([
      {
        id: message.id,
        session_id: "ses_test",
        type: "user",
        seq: 0,
        time_created: 10,
        time_updated: 11,
        data: {
          text: "first\n\nsecond",
          agents: [{ name: "build", mention: { text: "@build", start: 2, end: 8 } }, { name: "review" }],
          time: { created: 10 },
        },
      },
    ])
    expect(result.watermark).toBe(0)
  })

  test("maps embedded files and deterministic placeholders without external IO", () => {
    const message = user("msg_000000000002aaaaaaaaaaaaaa")
    const result = transform(
      [message],
      [
        part("prt_1", message.id, { type: "text", text: "prompt" }),
        part("prt_2", message.id, {
          type: "file",
          mime: "text/plain",
          filename: "inline.txt",
          url: "data:text/plain,hello%20world",
        }),
        part("prt_3", message.id, {
          type: "file",
          mime: "text/plain",
          url: "data:text/plain;base64,aGk=",
          source: {
            type: "resource",
            clientName: "mcp",
            uri: "resource://item",
            text: { value: "item", start: 1, end: 5 },
          },
        }),
        part("prt_4", message.id, {
          type: "file",
          mime: "text/plain",
          filename: "named.txt",
          url: "file:///tmp/named.txt",
        }),
        part("prt_5", message.id, { type: "file", mime: "application/octet-stream", url: "https://example.test/raw" }),
      ],
    )
    expect(result.messages[0].data).toEqual({
      text: "prompt\n\n[Attachment unavailable after migration: named.txt (text/plain)]\n\n[Attachment unavailable after migration: https://example.test/raw (application/octet-stream)]",
      files: [
        { data: "aGVsbG8gd29ybGQ=", mime: "text/plain", source: { type: "inline" }, name: "inline.txt" },
        {
          data: "aGk=",
          mime: "text/plain",
          source: { type: "uri", uri: "resource://item" },
          mention: { text: "item", start: 1, end: 5 },
        },
      ],
      time: { created: 10 },
    })
  })

  test("maps attachment-only source variants and uses resource URIs as unavailable labels", () => {
    const message = user("msg_000000000049aaaaaaaaaaaaaa")
    const result = transform(
      [message],
      [
        part("prt_1", message.id, {
          type: "file",
          mime: "text/plain",
          url: "data:text/plain,file",
          source: { type: "file", path: "/tmp/a", text: { value: "a", start: 0, end: 1 } },
        }),
        part("prt_2", message.id, {
          type: "file",
          mime: "text/plain",
          url: "data:text/plain,symbol",
          source: {
            type: "symbol",
            path: "/tmp/a",
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
            name: "a",
            kind: 1,
            text: { value: "symbol", start: 2, end: 8 },
          },
        }),
        part("prt_3", message.id, {
          type: "file",
          mime: "application/json",
          url: "https://example.test/resource",
          source: {
            type: "resource",
            clientName: "mcp",
            uri: "resource://fallback",
            text: { value: "resource", start: 0, end: 8 },
          },
        }),
      ],
    )
    expect(result.messages[0].data).toEqual({
      text: "[Attachment unavailable after migration: resource://fallback (application/json)]",
      files: [
        {
          data: "ZmlsZQ==",
          mime: "text/plain",
          source: { type: "inline" },
          mention: { text: "a", start: 0, end: 1 },
        },
        {
          data: "c3ltYm9s",
          mime: "text/plain",
          source: { type: "inline" },
          mention: { text: "symbol", start: 2, end: 8 },
        },
      ],
      time: { created: 10 },
    })
  })

  test("splits mixed synthetic content deterministically and preserves adjacency", () => {
    const all = user("msg_000000000003aaaaaaaaaaaaaa", {}, 1)
    const mixed = user("msg_000000000004aaaaaaaaaaaaaa", {}, 2)
    const later = user("msg_000000000005aaaaaaaaaaaaaa", {}, 3)
    const parts = [
      part("prt_1", all.id, { type: "text", text: "context", synthetic: true }),
      part("prt_2", mixed.id, { type: "text", text: "hello" }),
      part("prt_3", mixed.id, { type: "text", text: "hidden", synthetic: true }),
      part("prt_4", mixed.id, { type: "text", text: "ignored", synthetic: true, ignored: true }),
      part("prt_5", later.id, { type: "text", text: "later" }),
    ]
    const first = transform([later, mixed, all], parts)
    const second = transform([later, mixed, all], parts)
    expect(first.messages.map((row) => row.type)).toEqual(["synthetic", "user", "synthetic", "user"])
    expect(first.messages[0].id).toBe(all.id)
    expect(first.messages[2].id).not.toBe(mixed.id)
    expect(first.messages[2].id).toBe("msg_000000000004ST20Jh98kGJtjL")
    expect(first.messages[2].id.slice(0, 16)).toBe(mixed.id.slice(0, 16))
    expect(first.messages[2].id).toMatch(/^msg_[0-9A-Za-z]{26}$/)
    expect(first.messages[2].id).toBe(second.messages[2].id)
    expect(first.messages[2].data).toEqual({ text: "hidden", time: { created: 2 } })
    const collision = user(first.messages[2].id, {}, 4)
    const collided = transform(
      [all, mixed, later, collision],
      [...parts, part("prt_6", collision.id, { type: "text", text: "collision" })],
    )
    expect(collided.messages[2].id).not.toBe(first.messages[2].id)
    expect(collided.messages[2].id.slice(0, 16)).toBe(mixed.id.slice(0, 16))
  })

  test("preserves assistant content, model, usage, finish, snapshots, and marker filtering", () => {
    const parent = user("msg_000000000006aaaaaaaaaaaaaa")
    const message = assistant("msg_000000000007aaaaaaaaaaaaaa", parent.id, {
      variant: "fast",
      structured: { discard: true },
      finish: "stop",
      cost: 2.5,
    })
    const result = transform(
      [parent, message],
      [
        part("prt_1", message.id, { type: "text", text: "", metadata: { separator: true } }),
        part("prt_2", message.id, {
          type: "reasoning",
          text: "think",
          metadata: { provider: { signature: "sig" } },
          time: { start: 21, end: 22 },
        }),
        part("prt_3", message.id, { type: "step-start", snapshot: "snap_start" }),
        part("prt_4", message.id, { type: "snapshot", snapshot: "snap_ignored" }),
        part("prt_5", message.id, { type: "patch", hash: "snap_patch", files: ["a.ts", "b.ts"] }),
        part("prt_6", message.id, { type: "patch", hash: "snap_patch_2", files: ["b.ts", "c.ts"] }),
        part("prt_7", message.id, {
          type: "step-finish",
          reason: "stop",
          snapshot: "snap_end",
          cost: 99,
          tokens: { input: 99, output: 99, reasoning: 99, cache: { read: 99, write: 99 } },
        }),
        part("prt_8", message.id, {
          type: "retry",
          attempt: 1,
          error: { name: "APIError", data: { message: "retry", isRetryable: true } },
          time: { created: 1 },
        }),
      ],
    )
    expect(result.messages[1].data).toEqual({
      agent: "build",
      model: { id: "model", providerID: "provider", variant: "fast" },
      content: [
        { type: "text", text: "", state: { separator: true } },
        { type: "reasoning", text: "think", state: { signature: "sig" }, time: { created: 21, completed: 22 } },
      ],
      snapshot: { start: "snap_start", end: "snap_end", files: ["a.ts", "b.ts", "c.ts"] },
      finish: "stop",
      cost: 2.5,
      tokens: { input: 2, output: 3, reasoning: 4, cache: { read: 5, write: 6 } },
      time: { created: 20, completed: 21 },
    })
    expect(result.messages[1]).toMatchObject({ time_created: 20, time_updated: 21 })
  })

  test("normalizes every tool state", () => {
    const parent = user("msg_000000000008aaaaaaaaaaaaaa")
    const message = assistant("msg_000000000009aaaaaaaaaaaaaa", parent.id)
    const tool = (id: string, callID: string, state: Record<string, unknown>, metadata?: Record<string, unknown>) =>
      part(id, message.id, { type: "tool", callID, tool: "read", state, ...(metadata ? { metadata } : {}) })
    const result = transform(
      [parent, message],
      [
        tool("prt_1", "pending", { status: "pending", input: { a: 1 }, raw: "{}" }),
        tool("prt_2", "running", {
          status: "running",
          input: { b: 2 },
          metadata: { phase: "read" },
          time: { start: 30 },
        }),
        tool(
          "prt_3",
          "completed",
          {
            status: "completed",
            input: { c: 3 },
            output: "done",
            title: "Read",
            metadata: { result: true },
            time: { start: 31, end: 32 },
            attachments: [
              {
                id: "prt_attachment",
                sessionID: "ses_test",
                messageID: message.id,
                type: "file",
                mime: "text/plain",
                filename: "out.txt",
                url: "file:///out.txt",
              },
            ],
          },
          { provider: { tool: "state" } },
        ),
        tool("prt_4", "compacted", {
          status: "completed",
          input: {},
          output: "secret",
          title: "Read",
          metadata: {},
          time: { start: 33, end: 34, compacted: 35 },
          attachments: [],
        }),
        tool("prt_5", "failed", {
          status: "error",
          input: { e: 5 },
          error: "boom",
          metadata: { output: "partial" },
          time: { start: 36, end: 37 },
        }),
        tool("prt_6", "failed-object-output", {
          status: "error",
          input: { f: 6 },
          error: "object output",
          metadata: { output: { nested: true } },
          time: { start: 38, end: 39 },
        }),
      ],
    )
    const content = result.messages[1].data.content
    if (!Array.isArray(content)) throw new Error("Expected assistant content")
    expect(content[0]).toMatchObject({
      id: "pending",
      state: {
        status: "error",
        error: { type: "tool.interrupted", message: "Tool execution was interrupted before V2 migration" },
      },
      time: { created: 20 },
    })
    expect(content[1]).toMatchObject({
      id: "running",
      state: { status: "error", metadata: { phase: "read" } },
      time: { created: 30 },
    })
    expect(content[2]).toMatchObject({
      id: "completed",
      providerState: { tool: "state" },
      state: {
        status: "completed",
        content: [
          { type: "text", text: "done" },
          { type: "file", uri: "file:///out.txt", mime: "text/plain", name: "out.txt" },
        ],
        metadata: { result: true },
      },
      time: { created: 31, completed: 32 },
    })
    expect(content[3]).toMatchObject({
      id: "compacted",
      state: { content: [{ type: "text", text: "[Old tool result content cleared]" }] },
    })
    expect(content[4]).toMatchObject({
      id: "failed",
      state: {
        status: "error",
        error: { type: "tool.execution", message: "boom" },
        content: [{ type: "text", text: "partial" }],
        metadata: { output: "partial" },
      },
      time: { created: 36, completed: 37 },
    })
    expect(content[5]).toEqual({
      type: "tool",
      id: "failed-object-output",
      name: "read",
      state: {
        status: "error",
        input: { f: 6 },
        error: { type: "tool.execution", message: "object output" },
        metadata: { output: { nested: true } },
      },
      time: { created: 38, completed: 39 },
    })
  })

  test("normalizes assistant errors and finish reasons", () => {
    const parent = user("msg_000000000010aaaaaaaaaaaaaa")
    const cases = [
      ["ProviderAuthError", { providerID: "provider", message: "auth" }, "provider.auth", "auth"],
      ["ContentFilterError", { message: "filtered" }, "provider.content-filter", "filtered"],
      ["ContextOverflowError", { message: "overflow" }, "provider.invalid-request", "overflow"],
      ["StructuredOutputError", { message: "shape", retries: 2 }, "provider.invalid-output", "shape"],
      ["MessageOutputLengthError", {}, "provider.invalid-output", "The model exceeded its output limit"],
      ["MessageAbortedError", { message: "stopped" }, "aborted", "stopped"],
      [
        "APIError",
        { message: "api", statusCode: 503, isRetryable: true, responseBody: "discard" },
        "provider.error",
        "api",
      ],
      ["UnknownError", { message: "unknown", ref: "discard" }, "unknown", "unknown"],
    ] as const
    const messages = cases.map(([name, data], index) =>
      assistant(
        `msg_00000000001${index}aaaaaaaaaaaaaa`,
        parent.id,
        { error: { name, data }, finish: index === 0 ? "new-provider-value" : undefined },
        20 + index,
      ),
    )
    const result = transform([parent, ...messages], [])
    cases.forEach((entry, index) => {
      expect(result.messages[index + 1].data.error).toMatchObject({ type: entry[2], message: entry[3] })
      const error = result.messages[index + 1].data.error
      if (!error || typeof error !== "object") throw new Error("Expected assistant error")
      expect(Object.keys(error).sort()).toEqual(["message", "type"])
    })
    expect(result.messages[1].data.finish).toBe("unknown")
  })

  test("preserves every supported finish reason and omits an absent finish", () => {
    const parent = user("msg_000000000050aaaaaaaaaaaaaa")
    const finishes = ["stop", "length", "tool-calls", "content-filter", "error", "unknown", undefined] as const
    const result = transform(
      [
        parent,
        ...finishes.map((finish, index) =>
          assistant(`msg_00000000005${index + 1}aaaaaaaaaaaaaa`, parent.id, finish ? { finish } : {}, 20 + index),
        ),
      ],
      [],
    )
    expect(result.messages.slice(1).map((row) => row.data.finish)).toEqual([...finishes])
  })

  test("filters subtasks, collapses compactions, and keeps contiguous sequences", () => {
    const subtask = user("msg_000000000020aaaaaaaaaaaaaa", {}, 1)
    const taskAssistant = assistant("msg_000000000021aaaaaaaaaaaaaa", subtask.id, {}, 2)
    const compact = user("msg_000000000022aaaaaaaaaaaaaa", {}, 3)
    const unrelated = assistant("msg_000000000023aaaaaaaaaaaaaa", subtask.id, {}, 4)
    const summary = assistant("msg_000000000024aaaaaaaaaaaaaa", compact.id, { summary: true }, 5)
    const result = transform(
      [summary, compact, unrelated, taskAssistant, subtask],
      [
        part("prt_1", subtask.id, { type: "subtask", prompt: "work", description: "work", agent: "build" }),
        part("prt_2", taskAssistant.id, {
          type: "tool",
          callID: "task",
          tool: "task",
          state: {
            status: "completed",
            input: {},
            output: "done",
            title: "Task",
            metadata: {},
            time: { start: 1, end: 2 },
          },
        }),
        part("prt_3", unrelated.id, { type: "text", text: "keep" }),
        part("prt_4", compact.id, { type: "compaction", auto: false }),
        part("prt_5", summary.id, { type: "text", text: "summary" }),
        part("prt_6", summary.id, { type: "text", text: "" }),
      ],
    )
    expect(result.messages.map((row) => [row.type, row.seq])).toEqual([
      ["compaction", 0],
      ["assistant", 1],
    ])
    expect(result.messages[0]).toMatchObject({
      id: compact.id,
      time_created: 3,
      time_updated: 6,
      data: { status: "completed", reason: "manual", summary: "summary", recent: "" },
    })
  })

  test("serializes the retained compaction tail and preserves existing session selections", () => {
    const tailUser = user("msg_000000000025aaaaaaaaaaaaaa", {}, 1)
    const tailAssistant = assistant("msg_000000000026aaaaaaaaaaaaaa", tailUser.id, {}, 2)
    const compact = user("msg_000000000027aaaaaaaaaaaaaa", {}, 3)
    const summary = assistant("msg_000000000028aaaaaaaaaaaaaa", compact.id, { summary: true }, 4)
    const existing = session({
      agent: "existing",
      model: { id: "existing-model", providerID: "existing-provider", variant: "existing" },
    })
    const result = transform(
      [summary, compact, tailAssistant, tailUser],
      [
        part("prt_1", tailUser.id, { type: "text", text: "question" }),
        part("prt_2", tailAssistant.id, { type: "text", text: "answer" }),
        part("prt_3", compact.id, { type: "compaction", auto: true, tail_start_id: tailUser.id }),
        part("prt_4", summary.id, { type: "text", text: "summary" }),
      ],
      existing,
    )
    expect(result.messages[2].data).toMatchObject({
      reason: "auto",
      summary: "summary",
      recent: "[User]: question\n\n[Assistant]: answer",
    })
    expect(result.session.agent).toBe("existing")
    expect(result.session.model).toEqual(existing.model)
  })

  test("skips malformed rows, reports exact identifiers, and still backfills session aggregates", () => {
    const good = user(
      "msg_000000000030aaaaaaaaaaaaaa",
      { agent: "review", model: { providerID: "p2", modelID: "m2" } },
      2,
    )
    const badJson = { ...user("msg_000000000031aaaaaaaaaaaaaa"), data: "{" }
    const badSchema = { ...user("msg_000000000032aaaaaaaaaaaaaa"), data: JSON.stringify({ role: "user" }) }
    const internal = assistant(
      "msg_000000000033aaaaaaaaaaaaaa",
      good.id,
      { cost: 7, tokens: { input: 8, output: 9, reasoning: 10, cache: { read: 11, write: 12 } } },
      3,
    )
    const source = [good, badJson, badSchema, internal]
    const result = transform(source, [
      part("prt_1", good.id, { type: "text", text: "before" }),
      part("prt_2", good.id, "{"),
      part("prt_3", good.id, { type: "future", value: true }),
      part("prt_4", "msg_missing", { type: "text", text: "orphan" }),
      part("prt_5", good.id, { type: "text", text: "after" }),
    ])
    expect(result.messages[0].data.text).toBe("before\n\nafter")
    expect(result.messages.map((row) => row.seq)).toEqual([0, 1])
    expect(result.warnings).toEqual([
      { reason: "invalid-message", sessionID: "ses_test", messageID: badJson.id },
      { reason: "invalid-message", sessionID: "ses_test", messageID: badSchema.id },
      { reason: "invalid-part", sessionID: "ses_test", messageID: good.id, partID: "prt_2", observedType: undefined },
      { reason: "invalid-part", sessionID: "ses_test", messageID: good.id, partID: "prt_3", observedType: "future" },
      {
        reason: "orphan-part",
        sessionID: "ses_test",
        messageID: "msg_missing",
        partID: "prt_4",
        observedType: "text",
      },
    ])
    expect(result.session).toEqual({
      agent: "review",
      model: { id: "m2", providerID: "p2", variant: "default" },
      cost: 7,
      tokens_input: 8,
      tokens_output: 9,
      tokens_reasoning: 10,
      tokens_cache_read: 11,
      tokens_cache_write: 12,
      revert: null,
      time_compacting: null,
    })
    expect(source[0]).toBe(good)
  })

  test("retains empty ordinary messages and omits failed compactions", () => {
    const empty = user("msg_000000000034aaaaaaaaaaaaaa", {}, 1)
    const assistantMessage = assistant("msg_000000000035aaaaaaaaaaaaaa", empty.id, {}, 2)
    const compact = user("msg_000000000036aaaaaaaaaaaaaa", {}, 3)
    const failed = assistant(
      "msg_000000000037aaaaaaaaaaaaaa",
      compact.id,
      { summary: true, error: { name: "UnknownError", data: { message: "failed" } } },
      4,
    )
    const result = transform(
      [empty, assistantMessage, compact, failed],
      [
        part("prt_1", empty.id, { type: "text", text: "ignored", ignored: true }),
        part("prt_2", assistantMessage.id, { type: "snapshot", snapshot: "standalone" }),
        part("prt_3", compact.id, { type: "compaction", auto: true }),
        part("prt_4", failed.id, { type: "text", text: "not committed" }),
      ],
    )
    expect(result.messages.map((row) => row.type)).toEqual(["user", "assistant"])
    expect(result.messages[0].data).toEqual({ text: "", time: { created: 1 } })
    expect(result.messages[1].data).toMatchObject({ content: [], snapshot: { start: "standalone" } })
    expect(result.watermark).toBe(1)
  })

  test("orders equal-time rows by ID and keeps SQL and payload timestamps consistent", () => {
    const first = user("msg_000000000041aaaaaaaaaaaaaa", { time: { created: 999 } }, 10)
    const second = assistant("msg_000000000042aaaaaaaaaaaaaa", first.id, { time: { created: 998, completed: 997 } }, 10)
    const result = transform(
      [second, first],
      [
        part("prt_1", first.id, { type: "text", text: "first" }),
        part("prt_2", second.id, { type: "text", text: "second" }),
      ],
    )
    expect(result.messages.map((row) => row.id)).toEqual([first.id, second.id])
    expect(result.messages.map((row) => [row.time_created, row.time_updated, row.data.time])).toEqual([
      [10, 11, { created: 10 }],
      [10, 11, { created: 10, completed: 11 }],
    ])
  })

  test("omits incomplete compactions and subtask assistants while retaining their aggregate usage", () => {
    const mixed = user("msg_000000000043aaaaaaaaaaaaaa", {}, 1)
    const task = assistant(
      "msg_000000000044aaaaaaaaaaaaaa",
      mixed.id,
      { cost: 4, tokens: { input: 5, output: 6, reasoning: 7, cache: { read: 8, write: 9 } } },
      2,
    )
    const compact = user("msg_000000000045aaaaaaaaaaaaaa", {}, 3)
    const unfinished = assistant(
      "msg_000000000046aaaaaaaaaaaaaa",
      compact.id,
      { summary: true, time: { created: 4 } },
      4,
    )
    const result = transform(
      [unfinished, compact, task, mixed],
      [
        part("prt_1", mixed.id, { type: "text", text: "keep" }),
        part("prt_2", mixed.id, { type: "subtask", prompt: "work", description: "work", agent: "build" }),
        part("prt_3", task.id, {
          type: "tool",
          callID: "task",
          tool: "task",
          state: { status: "pending", input: {}, raw: "{}" },
        }),
        part("prt_4", compact.id, { type: "compaction", auto: true }),
        part("prt_5", unfinished.id, { type: "text", text: "unfinished" }),
      ],
    )
    expect(result.messages.map((row) => [row.id, row.type])).toEqual([[mixed.id, "user"]])
    expect(result.watermark).toBe(0)
    expect(result.session).toMatchObject({
      cost: 5,
      tokens_input: 7,
      tokens_output: 9,
      tokens_reasoning: 11,
      tokens_cache_read: 13,
      tokens_cache_write: 15,
    })
  })
})

describe("V1Migration database workflow", () => {
  const createLegacyTables = Effect.fnUntraced(function* (db: Effect.Success<typeof makeDb>) {
    yield* db.run(sql`
      CREATE TABLE session (
        id text PRIMARY KEY,
        project_id text NOT NULL,
        workspace_id text,
        parent_id text,
        slug text NOT NULL,
        directory text NOT NULL,
        path text,
        title text NOT NULL,
        version text NOT NULL,
        share_url text,
        summary_additions integer,
        summary_deletions integer,
        summary_files integer,
        summary_diffs text,
        metadata text,
        cost real DEFAULT 0 NOT NULL,
        tokens_input integer DEFAULT 0 NOT NULL,
        tokens_output integer DEFAULT 0 NOT NULL,
        tokens_reasoning integer DEFAULT 0 NOT NULL,
        tokens_cache_read integer DEFAULT 0 NOT NULL,
        tokens_cache_write integer DEFAULT 0 NOT NULL,
        revert text,
        permission text,
        agent text,
        model text,
        time_created integer NOT NULL,
        time_updated integer NOT NULL,
        time_compacting integer,
        time_archived integer
      )
    `)
    yield* db.run(sql`
      CREATE TABLE message (
        id text PRIMARY KEY,
        session_id text NOT NULL,
        time_created integer NOT NULL,
        time_updated integer NOT NULL,
        data text NOT NULL
      )
    `)
    yield* db.run(sql`
      CREATE TABLE part (
        id text PRIMARY KEY,
        message_id text NOT NULL,
        session_id text NOT NULL,
        time_created integer NOT NULL,
        time_updated integer NOT NULL,
        data text NOT NULL
      )
    `)
  })

  const database = <A, E>(effect: Effect.Effect<A, E, Database.Service | Global.Service | Scope.Scope>) =>
    run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* DatabaseMigration.apply(db)
        yield* createLegacyTables(db)
        return yield* effect.pipe(Effect.provideService(Database.Service, { db }))
      }),
    )

  test("reports required and completed status and completes an empty database idempotently", async () => {
    await database(
      Effect.gen(function* () {
        expect(yield* V1Migration.status()).toEqual({ status: "required" })
        expect(yield* V1Migration.run()).toEqual({ status: "completed" })
        expect(yield* V1Migration.status()).toEqual({ status: "completed" })
        expect(yield* V1Migration.run()).toEqual({ status: "completed" })
      }),
    )
  })

  test("yields while clearing stale events in batches", async () => {
    await database(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* db.run(sql`INSERT INTO event_sequence (aggregate_id, seq) VALUES ('stale', 2500)`)
        yield* db.run(sql`
          WITH RECURSIVE rows(value) AS (
            VALUES(1)
            UNION ALL
            SELECT value + 1 FROM rows WHERE value < 2500
          )
          INSERT INTO event (id, aggregate_id, seq, created, type, data)
          SELECT printf('event_%04d', value), 'stale', value, 1, 'session.renamed.1', '{}'
          FROM rows
        `)
        let yielded = false
        const heartbeat = yield* Effect.yieldNow.pipe(
          Effect.andThen(Effect.sync(() => (yielded = true))),
          Effect.forkChild({ startImmediately: true }),
        )

        expect(yield* V1Migration.run()).toEqual({ status: "completed" })
        expect(yielded).toBe(true)
        yield* Fiber.join(heartbeat)
        expect(yield* db.get<{ value: number }>(sql`SELECT COUNT(*) AS value FROM event`)).toEqual({ value: 0 })
      }),
    )
  })

  test("imports previous V2 sessions and messages containing apostrophes", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "opencode-next.db")
    const sqlite = await import("bun:sqlite")
    const source = new sqlite.Database(filename)
    source.run(`
      CREATE TABLE project (
        id text PRIMARY KEY, worktree text NOT NULL, vcs text, name text, icon_url text, icon_url_override text,
        icon_color text, time_created integer NOT NULL, time_updated integer NOT NULL, time_initialized integer,
        sandboxes text NOT NULL, commands text
      );
      CREATE TABLE session (
        id text PRIMARY KEY, project_id text NOT NULL, workspace_id text, parent_id text, fork_session_id text,
        fork_boundary text, slug text NOT NULL, directory text NOT NULL, path text, title text, version text NOT NULL,
        share_url text, summary_additions integer, summary_deletions integer, summary_files integer, summary_diffs text,
        metadata text, cost real DEFAULT 0 NOT NULL, tokens_input integer DEFAULT 0 NOT NULL,
        tokens_output integer DEFAULT 0 NOT NULL, tokens_reasoning integer DEFAULT 0 NOT NULL,
        tokens_cache_read integer DEFAULT 0 NOT NULL, tokens_cache_write integer DEFAULT 0 NOT NULL, revert text,
        permission text, agent text, model text, time_created integer NOT NULL, time_updated integer NOT NULL,
        time_compacting integer, time_archived integer, time_suspended integer
      );
      CREATE TABLE session_message (
        id text PRIMARY KEY, session_id text NOT NULL, type text NOT NULL, seq integer NOT NULL,
        time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL
      );
      INSERT INTO project VALUES (
        'next-project', 'C:/Users/sewer', 'git', 'Source project', NULL, NULL, NULL, 1, 2, NULL, '[]', NULL
      );
      INSERT INTO session (
        id, project_id, slug, directory, title, version, agent, model, time_created, time_updated
      ) VALUES
        ('ses_next', 'next-project', 'next', 'C:/Users/sewer', 'Imported', '2', 'build',
          '{"id":"model","providerID":"provider"}', 10, 20),
        ('ses_existing', 'next-project', 'source-existing', '/tmp/next', 'Source existing', '2', NULL, NULL, 11, 21),
        ('ses_orphan', 'missing-project', 'orphan', '/tmp/orphan', 'Orphan', '2', NULL, NULL, 12, 22);
      INSERT INTO session_message VALUES
        ('msg_next', 'ses_next', 'user', 4, 12, 13, '{"text":"from next''s history","time":{"created":12}}'),
        ('msg_source_existing', 'ses_existing', 'user', 2, 12, 13, '{"text":"source","time":{"created":12}}'),
        ('msg_orphan', 'ses_orphan', 'user', 0, 12, 13, '{"text":"orphan","time":{"created":12}}');
    `)
    source.close()

    await database(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* db.run(sql`
          INSERT INTO project (id, worktree, name, time_created, time_updated, sandboxes)
          VALUES ('next-project', '/tmp/current', 'Current project', 1, 2, '[]')
        `)
        yield* db.run(sql`
          INSERT INTO session_v2 (id, project_id, slug, directory, title, version, time_created, time_updated)
          VALUES ('ses_existing', 'next-project', 'current-existing', '/tmp/current', 'Current existing', '2', 1, 2)
        `)
        yield* db.run(sql`
          INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data)
          VALUES ('msg_current_existing', 'ses_existing', 'user', 0, 1, 2, '{"text":"current","time":{"created":1}}')
        `)

        expect(yield* V1Migration.status()).toEqual({
          status: "required",
        })
        expect(yield* V1Migration.run({ nextDatabasePath: filename })).toEqual({ status: "completed" })
        expect(yield* V1Migration.status()).toEqual({
          status: "completed",
        })
        expect(yield* db.get(sql`SELECT title, agent, model FROM session_v2 WHERE id = 'ses_next'`)).toEqual({
          title: "Imported",
          agent: "build",
          model: '{"id":"model","providerID":"provider"}',
        })
        expect(
          yield* db
            .select({ directory: SessionTable.directory })
            .from(SessionTable)
            .where(eq(SessionTable.id, SessionSchema.ID.make("ses_next")))
            .get(),
        ).toEqual({ directory: process.platform === "win32" ? "C:\\Users\\sewer" : "C:/Users/sewer" })
        expect(yield* db.all(sql`SELECT id, seq, data FROM session_message WHERE session_id = 'ses_next'`)).toEqual([
          {
            id: "msg_next",
            seq: 4,
            data: '{"text":"from next\'s history","time":{"created":12}}',
          },
        ])
        expect(yield* db.get(sql`SELECT seq, owner_id FROM event_sequence WHERE aggregate_id = 'ses_next'`)).toEqual({
          seq: 4,
          owner_id: null,
        })
        expect(yield* db.get(sql`SELECT title FROM session_v2 WHERE id = 'ses_existing'`)).toEqual({
          title: "Current existing",
        })
        expect(yield* db.all(sql`SELECT id FROM session_message WHERE session_id = 'ses_existing'`)).toEqual([
          { id: "msg_current_existing" },
        ])
        expect(yield* db.get(sql`SELECT project_id FROM session_v2 WHERE id = 'ses_orphan'`)).toEqual({
          project_id: "global",
        })
        expect(yield* db.get(sql`SELECT name, worktree FROM project WHERE id = 'next-project'`)).toEqual({
          name: "Current project",
          worktree: "/tmp/current",
        })
        yield* db.run(sql`UPDATE project SET worktree = 'C:/Users/sewer' WHERE id = 'next-project'`)
        expect(
          yield* db
            .select({ worktree: ProjectTable.worktree })
            .from(ProjectTable)
            .where(eq(ProjectTable.id, Project.ID.make("next-project")))
            .get(),
        ).toEqual({
          worktree: AbsolutePath.make(process.platform === "win32" ? "C:\\Users\\sewer" : "C:/Users/sewer"),
        })
        expect(yield* db.get(sql`SELECT value FROM kv WHERE key = 'migration.v1-v2'`)).toEqual({
          value: '{"phase":"completed"}',
        })
      }),
    )
  })

  test("imports previous V2 databases missing newer nullable columns", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "opencode-next.db")
    const sqlite = await import("bun:sqlite")
    const source = new sqlite.Database(filename)
    source.run(`
      CREATE TABLE project (
        id text PRIMARY KEY, worktree text NOT NULL, vcs text, name text, icon_url text,
        time_created integer NOT NULL, time_updated integer NOT NULL, time_initialized integer,
        sandboxes text NOT NULL
      );
      CREATE TABLE session (
        id text PRIMARY KEY, project_id text NOT NULL, workspace_id text, parent_id text, fork_session_id text,
        slug text NOT NULL, directory text NOT NULL, path text, title text, version text NOT NULL,
        share_url text, summary_additions integer, summary_deletions integer, summary_files integer, summary_diffs text,
        metadata text, cost real DEFAULT 0 NOT NULL, tokens_input integer DEFAULT 0 NOT NULL,
        tokens_output integer DEFAULT 0 NOT NULL, tokens_reasoning integer DEFAULT 0 NOT NULL,
        tokens_cache_read integer DEFAULT 0 NOT NULL, tokens_cache_write integer DEFAULT 0 NOT NULL, revert text,
        permission text, agent text, model text, time_created integer NOT NULL, time_updated integer NOT NULL,
        time_compacting integer, time_archived integer
      );
      CREATE TABLE session_message (
        id text PRIMARY KEY, session_id text NOT NULL, type text NOT NULL, seq integer NOT NULL,
        time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL
      );
      INSERT INTO project VALUES (
        'next-project', '/tmp/next', 'git', 'Source project', 'https://example.com/icon.png', 1, 2, NULL, '[]'
      );
      INSERT INTO session (
        id, project_id, slug, directory, title, version, time_created, time_updated
      ) VALUES ('ses_next', 'next-project', 'next', '/tmp/next', 'Imported', '2', 10, 20);
    `)
    source.close()

    await database(
      Effect.gen(function* () {
        const database = yield* Database.Service
        expect(yield* V1Migration.run({ nextDatabasePath: filename })).toEqual({ status: "completed" })
        expect(
          yield* database.db.get(sql`SELECT fork_boundary, time_suspended FROM session_v2 WHERE id = 'ses_next'`),
        ).toEqual({ fork_boundary: null, time_suspended: null })
        expect(
          yield* database.db.get(
            sql`SELECT icon_url, icon_url_override, icon_color, commands FROM project WHERE id = 'next-project'`,
          ),
        ).toEqual({
          icon_url: "https://example.com/icon.png",
          icon_url_override: "https://example.com/icon.png",
          icon_color: null,
          commands: null,
        })
      }),
    )
  })

  test("derives required status from the durable cursor", async () => {
    await database(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* db.run(
          sql`INSERT INTO project (id, worktree, time_created, time_updated, sandboxes) VALUES ('global', '/tmp/test', 1, 2, '[]')`,
        )
        yield* Effect.forEach(["ses_c", "ses_a", "ses_b"], (id) =>
          db.run(
            sql`INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES (${id}, 'global', ${id}, '/tmp/test', 'Test', '1', 1, 2)`,
          ),
        )
        yield* db.run(
          sql`INSERT INTO kv (key, value, time_created, time_updated) VALUES ('migration.v1-v2', '{"phase":"sessions","cursor":"ses_b"}', 1, 1)`,
        )
        expect(yield* V1Migration.status()).toEqual({ status: "required" })
      }),
    )
  })

  test("reassigns V1 sessions whose projects are missing to the global project", async () => {
    await database(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        const global = yield* Global.Service
        yield* db.run(
          sql`INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES ('ses_orphan', 'missing-project', 'orphan', '/tmp/orphan', 'Orphan', '1', 1, 2)`,
        )

        expect(yield* V1Migration.run()).toEqual({ status: "completed" })
        expect(yield* db.get(sql`SELECT project_id FROM session_v2 WHERE id = 'ses_orphan'`)).toEqual({
          project_id: "global",
        })
        expect(yield* db.get(sql`SELECT worktree FROM project WHERE id = 'global'`)).toEqual({
          worktree: path.parse(global.data).root,
        })
        expect(yield* db.get(sql`SELECT value FROM kv WHERE key = 'migration.v1-v2'`)).toEqual({
          value: '{"phase":"completed"}',
        })
      }),
    )
  })

  test("replaces projections containing apostrophes and checkpoints completion", async () => {
    await database(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* db.run(
          sql`INSERT INTO project (id, worktree, time_created, time_updated, sandboxes) VALUES ('global', '/tmp/test', 1, 2, '[]')`,
        )
        yield* db.run(sql`INSERT INTO session (
          id, project_id, slug, directory, title, version, cost, tokens_input, tokens_output, tokens_reasoning,
          tokens_cache_read, tokens_cache_write, revert, agent, model, metadata, time_created, time_updated,
          time_compacting, time_archived
        ) VALUES (
          'ses_test', 'global', 'test', '/tmp/test', 'Test', '1', 99, 99, 99, 99, 99, 99, '{}', 'preserved',
          '{"id":"selected","providerID":"selected-provider","variant":"selected-variant"}', '{"keep":true}',
          1, 2, 3, 4
        )`)
        const source = user("msg_000000000040aaaaaaaaaaaaaa")
        const sourcePart = part("prt_1", source.id, { type: "text", text: "don't stop" })
        yield* db.run(
          sql`INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (${source.id}, 'ses_test', 10, 11, ${source.data})`,
        )
        yield* db.run(
          sql`INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES ('prt_1', ${source.id}, 'ses_test', 1, 2, ${sourcePart.data})`,
        )
        yield* db.run(
          sql`INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES ('msg_stale', 'ses_test', 'user', 0, 1, 1, '{"text":"stale","time":{"created":1}}')`,
        )
        yield* db.run(sql`INSERT INTO event_sequence (aggregate_id, seq) VALUES ('ses_test', 9)`)
        yield* db.run(
          sql`INSERT INTO event (id, aggregate_id, seq, created, type, data) VALUES ('event_stale', 'ses_test', 9, 1, 'session.renamed.1', '{}')`,
        )
        expect(yield* V1Migration.run()).toEqual({ status: "completed" })
        expect(yield* db.all(sql`SELECT id, type, seq, time_created, time_updated, data FROM session_message`)).toEqual(
          [
            {
              id: source.id,
              type: "user",
              seq: 0,
              time_created: 10,
              time_updated: 11,
              data: '{"text":"don\'t stop","time":{"created":10}}',
            },
          ],
        )
        expect(yield* db.all(sql`SELECT id, data FROM message`)).toEqual([{ id: source.id, data: source.data }])
        expect(yield* db.all(sql`SELECT id, data FROM part`)).toEqual([{ id: "prt_1", data: sourcePart.data }])
        expect(yield* db.get(sql`SELECT seq FROM event_sequence WHERE aggregate_id = 'ses_test'`)).toEqual({ seq: 0 })
        expect(yield* db.all(sql`SELECT id FROM event`)).toEqual([])
        expect(
          yield* db.get(
            sql`SELECT agent, model, metadata, cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, revert, time_created, time_updated, time_compacting, time_archived FROM session_v2 WHERE id = 'ses_test'`,
          ),
        ).toEqual({
          agent: "preserved",
          model: '{"id":"selected","providerID":"selected-provider","variant":"selected-variant"}',
          metadata: '{"keep":true}',
          cost: 0,
          tokens_input: 0,
          tokens_output: 0,
          tokens_reasoning: 0,
          tokens_cache_read: 0,
          tokens_cache_write: 0,
          revert: null,
          time_created: 1,
          time_updated: 2,
          time_compacting: null,
          time_archived: 4,
        })
        expect(yield* db.get(sql`SELECT cost, revert, time_compacting FROM session WHERE id = 'ses_test'`)).toEqual({
          cost: 99,
          revert: "{}",
          time_compacting: 3,
        })
        expect(yield* db.get(sql`SELECT value FROM kv WHERE key = 'migration.v1-v2'`)).toEqual({
          value: '{"phase":"completed"}',
        })
      }),
    )
  })

  test("rolls back one session atomically and resumes from the committed cursor", async () => {
    await database(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* db.run(
          sql`INSERT INTO project (id, worktree, time_created, time_updated, sandboxes) VALUES ('global', '/tmp/test', 1, 2, '[]')`,
        )
        yield* Effect.forEach(["ses_a", "ses_b", "ses_c"], (id) =>
          db.run(
            sql`INSERT INTO session (id, project_id, slug, directory, title, version, cost, time_created, time_updated) VALUES (${id}, 'global', ${id}, '/tmp/test', 'Test', '1', 99, 1, 2)`,
          ),
        )
        yield* db.run(
          sql`CREATE TRIGGER fail_b BEFORE UPDATE ON session_v2 WHEN NEW.id = 'ses_b' BEGIN SELECT RAISE(ABORT, 'stop'); END`,
        )
        yield* db.run(
          sql`INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES ('msg_stale_b', 'ses_b', 'user', 0, 7, 8, '{"text":"stale","time":{"created":7}}')`,
        )
        yield* db.run(sql`INSERT INTO event_sequence (aggregate_id, seq, owner_id) VALUES ('ses_b', 7, 'owner')`)
        yield* db.run(
          sql`INSERT INTO event (id, aggregate_id, seq, created, type, data) VALUES ('event_stale_b', 'ses_b', 7, 1, 'session.renamed.1', '{}')`,
        )
        yield* Layer.launch(V1Migration.layer).pipe(Effect.forkScoped)
        const failed = yield* V1Migration.status().pipe(
          Effect.filterOrFail((status) => status.status === "error"),
          Effect.retry(Schedule.spaced("10 millis")),
        )
        expect(failed.status).toBe("error")
        if (failed.status === "error") expect(failed.error).toContain("stop")
        expect(yield* db.get(sql`SELECT value FROM kv WHERE key = 'migration.v1-v2'`)).toEqual({
          value: '{"phase":"sessions","cursor":"ses_c"}',
        })
        expect(yield* db.get(sql`SELECT cost FROM session_v2 WHERE id = 'ses_c'`)).toEqual({ cost: 0 })
        expect(yield* db.get(sql`SELECT cost FROM session_v2 WHERE id = 'ses_b'`)).toBeUndefined()
        expect(yield* db.get(sql`SELECT cost FROM session WHERE id = 'ses_b'`)).toEqual({ cost: 99 })
        expect(
          yield* db.all(
            sql`SELECT id, seq, time_created, time_updated, data FROM session_message WHERE session_id = 'ses_b'`,
          ),
        ).toEqual([
          {
            id: "msg_stale_b",
            seq: 0,
            time_created: 7,
            time_updated: 8,
            data: '{"text":"stale","time":{"created":7}}',
          },
        ])
        expect(yield* db.get(sql`SELECT seq, owner_id FROM event_sequence WHERE aggregate_id = 'ses_b'`)).toEqual({
          seq: 7,
          owner_id: "owner",
        })
        expect(yield* db.all(sql`SELECT id FROM event WHERE aggregate_id = 'ses_b'`)).toEqual([])
        expect(yield* db.get(sql`SELECT value FROM kv WHERE key = 'migration.v1-v2'`)).toEqual({
          value: '{"phase":"sessions","cursor":"ses_c"}',
        })
        yield* db.run(
          sql`INSERT INTO event (id, aggregate_id, seq, created, type, data) VALUES ('event_after_clear', 'ses_c', 0, 2, 'session.renamed.1', '{}')`,
        )
        yield* db.run(sql`DROP TRIGGER fail_b`)
        yield* Layer.launch(V1Migration.layer).pipe(Effect.forkScoped)
        yield* V1Migration.status().pipe(
          Effect.filterOrFail((status) => status.status === "completed"),
          Effect.retry(Schedule.spaced("10 millis")),
        )
        expect(yield* db.get(sql`SELECT cost FROM session_v2 WHERE id = 'ses_b'`)).toEqual({ cost: 0 })
        expect(yield* db.all(sql`SELECT id FROM session_message WHERE session_id = 'ses_b'`)).toEqual([])
        expect(yield* db.get(sql`SELECT seq, owner_id FROM event_sequence WHERE aggregate_id = 'ses_b'`)).toEqual({
          seq: -1,
          owner_id: null,
        })
        expect(yield* db.all(sql`SELECT id FROM event`)).toEqual([{ id: "event_after_clear" }])
      }),
    )
  })

  test("processes root, child, archived, empty, malformed-only, subtask-only, and incomplete-compaction sessions", async () => {
    const output = new Array<ReturnType<typeof Logger.formatStructured.log>>()
    await database(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* db.run(
          sql`INSERT INTO project (id, worktree, time_created, time_updated, sandboxes) VALUES ('global', '/tmp/test', 1, 2, '[]')`,
        )
        yield* db.run(
          sql`INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES ('ses_root', 'global', 'root', '/tmp/test', 'Root', '1', 1, 2)`,
        )
        yield* db.run(
          sql`INSERT INTO session (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated) VALUES ('ses_child', 'global', 'ses_root', 'child', '/tmp/test', 'Child', '1', 1, 2)`,
        )
        yield* db.run(
          sql`INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated, time_archived) VALUES ('ses_archived', 'global', 'archived', '/tmp/test', 'Archived', '1', 1, 2, 3)`,
        )
        yield* Effect.forEach(["ses_empty", "ses_malformed", "ses_subtask", "ses_compaction"], (id) =>
          db.run(
            sql`INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES (${id}, 'global', ${id}, '/tmp/test', ${id}, '1', 1, 2)`,
          ),
        )
        yield* db.run(
          sql`INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES ('msg_bad', 'ses_malformed', 1, 2, '{')`,
        )
        const subtask = user("msg_000000000047aaaaaaaaaaaaaa")
        yield* db.run(
          sql`INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (${subtask.id}, 'ses_subtask', 10, 11, ${subtask.data})`,
        )
        yield* db.run(
          sql`INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES ('prt_subtask', ${subtask.id}, 'ses_subtask', 1, 2, '{"type":"subtask","prompt":"work","description":"work","agent":"build"}')`,
        )
        const compact = user("msg_000000000048aaaaaaaaaaaaaa")
        yield* db.run(
          sql`INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (${compact.id}, 'ses_compaction', 10, 11, ${compact.data})`,
        )
        yield* db.run(
          sql`INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES ('prt_compaction', ${compact.id}, 'ses_compaction', 1, 2, '{"type":"compaction","auto":true}')`,
        )

        expect(yield* V1Migration.run()).toEqual({ status: "completed" })
        expect(yield* db.all(sql`SELECT aggregate_id, seq FROM event_sequence ORDER BY aggregate_id`)).toEqual([
          { aggregate_id: "ses_archived", seq: -1 },
          { aggregate_id: "ses_child", seq: -1 },
          { aggregate_id: "ses_compaction", seq: -1 },
          { aggregate_id: "ses_empty", seq: -1 },
          { aggregate_id: "ses_malformed", seq: -1 },
          { aggregate_id: "ses_root", seq: -1 },
          { aggregate_id: "ses_subtask", seq: -1 },
        ])
        expect(yield* db.all(sql`SELECT id FROM session_message`)).toEqual([])
        expect(yield* V1Migration.status()).toEqual({ status: "completed" })
        expect(output.map((entry) => entry.message)).toContainEqual([
          "Skipped V1 migration row",
          {
            reason: "invalid-message",
            sessionID: "ses_malformed",
            messageID: "msg_bad",
          },
        ])
      }).pipe(
        Effect.provide(
          Logger.layer([
            Logger.map(Logger.formatStructured, (entry) => {
              output.push(entry)
            }),
          ]),
        ),
      ),
    )
  })

  test("serializes concurrent callers and migrates each session once", async () => {
    await database(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* db.run(
          sql`INSERT INTO project (id, worktree, time_created, time_updated, sandboxes) VALUES ('global', '/tmp/test', 1, 2, '[]')`,
        )
        yield* db.run(
          sql`INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES ('ses_test', 'global', 'test', '/tmp/test', 'Test', '1', 1, 2)`,
        )
        yield* db.run(sql`CREATE TABLE audit (count integer NOT NULL)`)
        yield* db.run(sql`INSERT INTO audit VALUES (0)`)
        yield* db.run(
          sql`CREATE TRIGGER audit_session AFTER UPDATE ON session_v2 BEGIN UPDATE audit SET count = count + 1; END`,
        )
        expect(yield* Effect.all([V1Migration.run(), V1Migration.run()], { concurrency: "unbounded" })).toEqual([
          { status: "completed" },
          { status: "completed" },
        ])
        expect(yield* db.get(sql`SELECT count FROM audit`)).toEqual({ count: 1 })
      }),
    )
  })
})
