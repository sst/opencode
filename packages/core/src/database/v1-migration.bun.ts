export * as V1Migration from "./v1-migration.js"

import { Cause, Effect, Layer, Option, Schema, Semaphore } from "effect"
import { Database } from "./database.js"
import { SessionMessageTable, SessionTable } from "../session/sql.js"
import { SessionV1 } from "@opencode/schema/session-v1"
import { SessionMessage } from "../session/message.js"
import { SessionSchema } from "../session/schema.js"
import { KVTable } from "../kv/sql.js"
import { EventSequenceTable } from "../event/sql.js"
import { eq, sql } from "drizzle-orm"
import { Global } from "@opencode/util/global"
import { existsSync } from "node:fs"
import path from "node:path"
import type { Database as SQLiteDatabase } from "bun:sqlite"
import { Project } from "@opencode/schema/project"

export type SourceMessage = {
  readonly id: string
  readonly session_id: string
  readonly time_created: number
  readonly time_updated: number
  readonly data: string
}

export type SourcePart = {
  readonly id: string
  readonly message_id: string
  readonly session_id: string
  readonly time_created: number
  readonly time_updated: number
  readonly data: string
}

export type TransformInput = {
  readonly session: typeof SessionTable.$inferSelect
  readonly messages: ReadonlyArray<SourceMessage>
  readonly parts: ReadonlyArray<SourcePart>
}

export type Warning = {
  readonly reason: string
  readonly sessionID: string
  readonly messageID?: string
  readonly partID?: string
  readonly observedType?: string
}

export type TransformResult = {
  readonly messages: ReadonlyArray<{
    readonly id: string
    readonly session_id: string
    readonly type: SessionMessage.Type
    readonly seq: number
    readonly time_created: number
    readonly time_updated: number
    readonly data: Record<string, unknown>
  }>
  readonly session: Pick<
    typeof SessionTable.$inferInsert,
    | "agent"
    | "model"
    | "cost"
    | "tokens_input"
    | "tokens_output"
    | "tokens_reasoning"
    | "tokens_cache_read"
    | "tokens_cache_write"
    | "revert"
    | "time_compacting"
  >
  readonly watermark: number
  readonly warnings: ReadonlyArray<Warning>
}

type Progress = {
  readonly label: string
  readonly numerator?: number
  readonly denominator?: number
}

export type Status =
  | { readonly status: "required" | "completed" }
  | { readonly status: "running"; readonly progress: Progress }
  | { readonly status: "error"; readonly error: string }

type RunResult = {
  readonly status: "completed"
}

type Options = {
  readonly nextDatabasePath?: string
}

type MigrationState = { readonly phase: "sessions"; readonly cursor?: string } | { readonly phase: "completed" }

type RuntimeState =
  | { readonly status: "idle" }
  | { readonly status: "running"; readonly progress: Progress }
  | { readonly status: "error"; readonly error: string }

type NextProject = {
  readonly id: string
  readonly worktree: string
  readonly vcs: string | null
  readonly name: string | null
  readonly icon_url: string | null
  readonly icon_url_override: string | null
  readonly icon_color: string | null
  readonly time_created: number
  readonly time_updated: number
  readonly time_initialized: number | null
  readonly sandboxes: string
  readonly commands: string | null
}

type NextColumns<A> = Record<keyof A, "required" | "nullable" | { readonly fallback: keyof A & string }>

const NEXT_PROJECT_COLUMNS = {
  id: "required",
  worktree: "required",
  vcs: "nullable",
  name: "nullable",
  icon_url: "nullable",
  icon_url_override: { fallback: "icon_url" },
  icon_color: "nullable",
  time_created: "required",
  time_updated: "required",
  time_initialized: "nullable",
  sandboxes: "required",
  commands: "nullable",
} satisfies NextColumns<NextProject>

type NextSession = {
  readonly id: string
  readonly project_id: string
  readonly workspace_id: string | null
  readonly parent_id: string | null
  readonly fork_session_id: string | null
  readonly fork_boundary: string | null
  readonly slug: string
  readonly directory: string
  readonly path: string | null
  readonly title: string | null
  readonly version: string
  readonly share_url: string | null
  readonly summary_additions: number | null
  readonly summary_deletions: number | null
  readonly summary_files: number | null
  readonly summary_diffs: string | null
  readonly metadata: string | null
  readonly cost: number
  readonly tokens_input: number
  readonly tokens_output: number
  readonly tokens_reasoning: number
  readonly tokens_cache_read: number
  readonly tokens_cache_write: number
  readonly revert: string | null
  readonly permission: string | null
  readonly agent: string | null
  readonly model: string | null
  readonly time_created: number
  readonly time_updated: number
  readonly time_compacting: number | null
  readonly time_archived: number | null
  readonly time_suspended: number | null
}

const NEXT_SESSION_COLUMNS = {
  id: "required",
  project_id: "required",
  workspace_id: "nullable",
  parent_id: "nullable",
  fork_session_id: "nullable",
  fork_boundary: "nullable",
  slug: "required",
  directory: "required",
  path: "nullable",
  title: "nullable",
  version: "required",
  share_url: "nullable",
  summary_additions: "nullable",
  summary_deletions: "nullable",
  summary_files: "nullable",
  summary_diffs: "nullable",
  metadata: "nullable",
  cost: "required",
  tokens_input: "required",
  tokens_output: "required",
  tokens_reasoning: "required",
  tokens_cache_read: "required",
  tokens_cache_write: "required",
  revert: "nullable",
  permission: "nullable",
  agent: "nullable",
  model: "nullable",
  time_created: "required",
  time_updated: "required",
  time_compacting: "nullable",
  time_archived: "nullable",
  time_suspended: "nullable",
} satisfies NextColumns<NextSession>

type NextMessage = {
  readonly id: string
  readonly session_id: string
  readonly type: string
  readonly seq: number
  readonly time_created: number
  readonly time_updated: number
  readonly data: string
}

const lock = Semaphore.makeUnsafe(1)
const MIGRATION_STATE_KEY = "migration.v1-v2"
const EVENT_DELETE_BATCH_SIZE = 1_000
const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))
const decodeMessage = Schema.decodeUnknownOption(SessionV1.Info)
const decodePart = Schema.decodeUnknownOption(SessionV1.Part)
let runtimeState: RuntimeState = { status: "idle" }

export function transformSession(input: TransformInput): TransformResult {
  const warnings: Warning[] = []
  const messages = input.messages
    .map((row) => {
      const value = Option.getOrUndefined(decodeJson(row.data))
      const decoded =
        value && typeof value === "object"
          ? Option.getOrUndefined(decodeMessage({ ...value, id: row.id, sessionID: row.session_id }))
          : undefined
      if (decoded) return { row, value: decoded }
      warnings.push({ reason: "invalid-message", sessionID: input.session.id, messageID: row.id })
      return undefined
    })
    .filter((item): item is NonNullable<typeof item> => item !== undefined)
    .sort((a, b) => a.row.time_created - b.row.time_created || a.row.id.localeCompare(b.row.id))
  const messageIDs = new Set(input.messages.map((row) => row.id))
  const parts = input.parts
    .map((row) => {
      const value = Option.getOrUndefined(decodeJson(row.data))
      const observedType = value && typeof value === "object" && "type" in value ? String(value.type) : undefined
      if (!messageIDs.has(row.message_id)) {
        warnings.push({
          reason: "orphan-part",
          sessionID: input.session.id,
          messageID: row.message_id,
          partID: row.id,
          observedType,
        })
        return undefined
      }
      const decoded =
        value && typeof value === "object"
          ? Option.getOrUndefined(
              decodePart({ ...value, id: row.id, messageID: row.message_id, sessionID: row.session_id }),
            )
          : undefined
      if (decoded) return { row, value: decoded }
      warnings.push({
        reason: "invalid-part",
        sessionID: input.session.id,
        messageID: row.message_id,
        partID: row.id,
        observedType,
      })
      return undefined
    })
    .filter((item): item is NonNullable<typeof item> => item !== undefined)
    .sort((a, b) => a.row.id.localeCompare(b.row.id))
  const byMessage = Map.groupBy(parts, (item) => item.row.message_id)
  const paired = new Set<string>()
  const used = new Set(messages.map((item) => item.row.id))
  const projected = messages
    .flatMap((item) => {
      if (paired.has(item.row.id)) return []
      const owned = byMessage.get(item.row.id)?.map((part) => part.value) ?? []
      if (item.value.role === "user") {
        const compaction = owned.find((part): part is SessionV1.CompactionPart => part.type === "compaction")
        if (compaction) {
          const pairedSummary = messages.find(
            (candidate): candidate is (typeof messages)[number] & { value: SessionV1.Assistant } =>
              candidate.value.role === "assistant" &&
              candidate.value.parentID === item.row.id &&
              candidate.value.summary === true,
          )
          if (!pairedSummary) return []
          paired.add(pairedSummary.row.id)
          if (pairedSummary.value.error || pairedSummary.value.time.completed === undefined) return []
          const summary = pairedSummary
          const summaryText = (byMessage.get(summary.row.id) ?? [])
            .map((part) => part.value)
            .filter((part): part is SessionV1.TextPart => part.type === "text" && part.text.length > 0)
            .map((part) => part.text)
            .join("\n\n")
          const tailIndex = compaction.tail_start_id
            ? messages.findIndex((candidate) => candidate.row.id === compaction.tail_start_id)
            : -1
          const compactionIndex = messages.findIndex((candidate) => candidate.row.id === item.row.id)
          const tail = tailIndex < 0 ? [] : messages.slice(tailIndex, compactionIndex)
          return [
            row(
              { ...item.row, time_updated: Math.max(item.row.time_updated, summary.row.time_updated) },
              {
                id: item.row.id,
                type: "compaction",
                status: "completed",
                reason: compaction.auto ? "auto" : "manual",
                summary: summaryText,
                recent: serializeRecent(tail, byMessage),
                time: { created: item.row.time_created },
              },
            ),
          ]
        }
        const subtasks = owned.filter((part) => part.type === "subtask")
        const visible = owned.filter((part): part is SessionV1.TextPart => part.type === "text" && !part.ignored)
        const files = owned.filter((part): part is SessionV1.FilePart => part.type === "file")
        const agents = owned.filter((part): part is SessionV1.AgentPart => part.type === "agent")
        if (subtasks.length > 0 && visible.length === 0 && files.length === 0 && agents.length === 0) return []
        const ordinary = visible.filter((part) => !part.synthetic)
        const synthetic = visible.filter((part) => part.synthetic)
        const attachments = files.flatMap((part) => migrateFile(part))
        const unavailable = files.flatMap((part) => (!part.url.startsWith("data:") ? [unavailableFile(part)] : []))
        const text = owned
          .flatMap((part) => {
            if (part.type === "text" && !part.ignored && !part.synthetic) return [part.text]
            if (part.type === "file" && !part.url.startsWith("data:")) return [unavailableFile(part)]
            return []
          })
          .join("\n\n")
        const agentAttachments = agents.map((part) => ({
          name: part.name,
          ...(part.source
            ? { mention: { text: part.source.value, start: part.source.start, end: part.source.end } }
            : {}),
        }))
        if (
          ordinary.length === 0 &&
          unavailable.length === 0 &&
          synthetic.length > 0 &&
          attachments.length === 0 &&
          agentAttachments.length === 0
        )
          return [
            row(item.row, {
              id: item.row.id,
              type: "synthetic",
              text: synthetic.map((part) => part.text).join("\n\n"),
              time: { created: item.row.time_created },
            }),
          ]
        const user = row(item.row, {
          id: item.row.id,
          type: "user",
          text,
          ...(attachments.length ? { files: attachments } : {}),
          ...(agentAttachments.length ? { agents: agentAttachments } : {}),
          time: { created: item.row.time_created },
        })
        if (synthetic.length === 0) return [user]
        return [
          user,
          row(item.row, {
            id: syntheticID(item.row.id, used),
            type: "synthetic",
            text: synthetic.map((part) => part.text).join("\n\n"),
            time: { created: item.row.time_created },
          }),
        ]
      }
      if (item.value.role !== "assistant") return []
      const assistant = item.value
      const parent = messages.find((candidate) => candidate.row.id === assistant.parentID)
      const parentParts = parent ? (byMessage.get(parent.row.id)?.map((part) => part.value) ?? []) : []
      if (
        parentParts.some((part) => part.type === "subtask") &&
        owned.some((part) => part.type === "tool" && part.tool === "task")
      )
        return []
      const content = owned.flatMap((part): Array<Record<string, unknown>> => {
        if (part.type === "text")
          return [{ type: "text", text: part.text, ...(part.metadata ? { state: part.metadata } : {}) }]
        if (part.type === "reasoning")
          return [
            {
              type: "reasoning",
              text: part.text,
              ...(part.metadata ? { state: part.metadata } : {}),
              time: { created: part.time.start, ...(part.time.end === undefined ? {} : { completed: part.time.end }) },
            },
          ]
        if (part.type !== "tool") return []
        return [migrateTool(part, item.row.time_created)]
      })
      const start =
        owned.flatMap((part) => (part.type === "step-start" && part.snapshot ? [part.snapshot] : []))[0] ??
        owned.flatMap((part) => (part.type === "snapshot" ? [part.snapshot] : []))[0] ??
        owned.flatMap((part) => (part.type === "patch" ? [part.hash] : []))[0]
      const end = owned.flatMap((part) => (part.type === "step-finish" && part.snapshot ? [part.snapshot] : [])).at(-1)
      const snapshotFiles = Array.from(new Set(owned.flatMap((part) => (part.type === "patch" ? part.files : []))))
      const finish = normalizeFinish(assistant.finish)
      return [
        row(item.row, {
          id: item.row.id,
          type: "assistant",
          agent: assistant.agent,
          model: {
            providerID: assistant.providerID,
            id: assistant.modelID,
            variant: assistant.variant ?? "default",
          },
          content,
          ...(start || end || snapshotFiles.length
            ? {
                snapshot: {
                  ...(start ? { start } : {}),
                  ...(end ? { end } : {}),
                  ...(snapshotFiles.length ? { files: snapshotFiles } : {}),
                },
              }
            : {}),
          ...(finish ? { finish } : {}),
          cost: assistant.cost,
          tokens: {
            input: assistant.tokens.input,
            output: assistant.tokens.output,
            reasoning: assistant.tokens.reasoning,
            cache: assistant.tokens.cache,
          },
          ...(assistant.error ? { error: migrateError(assistant.error) } : {}),
          time: {
            created: item.row.time_created,
            ...(assistant.time.completed === undefined ? {} : { completed: item.row.time_updated }),
          },
        }),
      ]
    })
    .map((item, seq) => ({ ...item, seq }))
  const assistants = messages
    .map((item) => item.value)
    .filter((item): item is SessionV1.Assistant => item.role === "assistant")
  const latestUser = messages.findLast((item) => {
    if (item.value.role !== "user") return false
    const owned = byMessage.get(item.row.id) ?? []
    if (owned.some((part) => part.value.type === "compaction")) return false
    return !owned.some((part) => part.value.type === "subtask") || !owned.every((part) => part.value.type === "subtask")
  })
  return {
    messages: projected,
    session: {
      agent: input.session.agent ?? (latestUser?.value.role === "user" ? latestUser.value.agent : null),
      model:
        input.session.model ??
        (latestUser?.value.role === "user"
          ? {
              id: latestUser.value.model.modelID,
              providerID: latestUser.value.model.providerID,
              variant: latestUser.value.model.variant ?? "default",
            }
          : null),
      cost: assistants.reduce((total, item) => total + item.cost, 0),
      tokens_input: assistants.reduce((total, item) => total + item.tokens.input, 0),
      tokens_output: assistants.reduce((total, item) => total + item.tokens.output, 0),
      tokens_reasoning: assistants.reduce((total, item) => total + item.tokens.reasoning, 0),
      tokens_cache_read: assistants.reduce((total, item) => total + item.tokens.cache.read, 0),
      tokens_cache_write: assistants.reduce((total, item) => total + item.tokens.cache.write, 0),
      revert: null,
      time_compacting: null,
    },
    watermark: projected.length - 1,
    warnings,
  }
}

export function status(): Effect.Effect<Status, never, Database.Service> {
  return Effect.gen(function* () {
    const db = (yield* Database.Service).db
    if (!(yield* hasLegacySessions(db))) return { status: "completed" as const }
    const state = yield* readState(db)
    if (runtimeState.status === "running") return runtimeState
    if (runtimeState.status === "error") return runtimeState
    if (state?.phase === "completed") return { status: "completed" as const }
    return { status: "required" as const }
  })
}

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    runtimeState = { status: "running", progress: { label: "Clearing old events" } }
    yield* run().pipe(
      Effect.matchCauseEffect({
        onFailure: (cause) =>
          Effect.sync(() => {
            runtimeState = { status: "error", error: errorText(Cause.squash(cause)) }
          }).pipe(Effect.andThen(Effect.logError("V1 migration failed", { cause }))),
        onSuccess: () =>
          Effect.sync(() => {
            runtimeState = { status: "idle" }
          }),
      }),
      Effect.forkScoped({ startImmediately: true }),
    )
  }),
)

function errorText(input: unknown): string {
  if (!(input instanceof Error)) return String(input)
  const cause = input.cause
  return cause === undefined ? input.message : `${input.message}\nCaused by: ${errorText(cause)}`
}

function updateProgress(progress: Progress) {
  if (runtimeState.status === "running") runtimeState = { status: "running", progress }
}

export function run(options: Options = {}): Effect.Effect<RunResult, never, Database.Service | Global.Service> {
  return lock.withPermit(
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const global = yield* Global.Service
      const state = yield* readState(db)
      if (state?.phase === "completed") return { status: "completed" as const }
      if (!(yield* hasLegacySessions(db))) return { status: "completed" as const }
      const now = Date.now()
      yield* db.run(sql`
          INSERT OR IGNORE INTO project (id, worktree, time_created, time_updated, sandboxes)
          VALUES (${Project.ID.global}, ${path.parse(global.data).root}, ${now}, ${now}, '[]')
        `)
      if (state === undefined)
        yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              while (true) {
                yield* tx.run(sql`
                    DELETE FROM event
                    WHERE rowid IN (SELECT rowid FROM event LIMIT ${EVENT_DELETE_BATCH_SIZE})
                  `)
                const deleted = (yield* tx.get<{ value: number }>(sql`SELECT changes() AS value`))?.value ?? 0
                if (deleted < EVENT_DELETE_BATCH_SIZE) break
                yield* Effect.yieldNow
              }
              yield* tx
                .insert(KVTable)
                .values({ key: MIGRATION_STATE_KEY, value: { phase: "sessions" } })
                .run()
            }),
          )
          .pipe(Effect.orDie)
      const sourceTotal = yield* countNextSessions(nextPath(options, global.data))
      const legacyTotal = (yield* db.get<{ value: number }>(sql`SELECT COUNT(*) AS value FROM session`))?.value ?? 0
      const cursor = state?.phase === "sessions" ? state.cursor : undefined
      const migrated =
        cursor !== undefined
          ? ((yield* db.get<{ value: number }>(sql`SELECT COUNT(*) AS value FROM session WHERE id >= ${cursor}`))
              ?.value ?? 0)
          : 0
      const denominator = sourceTotal + legacyTotal
      updateProgress({ label: "Migrating sessions", numerator: migrated, denominator })
      yield* importNextDatabase(db, nextPath(options, global.data), (completed) => {
        updateProgress({ label: "Migrating sessions", numerator: migrated + completed, denominator })
      })
      updateProgress({ label: "Migrating sessions", numerator: migrated + sourceTotal, denominator })
      const projects = new Set(
        (yield* db.all<{ id: string }>(sql`SELECT id FROM project`)).map((project) => project.id),
      )
      while (true) {
        const state = yield* readState(db)
        const cursorValue = state?.phase === "sessions" ? state.cursor : undefined
        const nextID = yield* db.get<{ id: string; project_id: string }>(
          cursorValue === undefined
            ? sql`SELECT id, project_id FROM session ORDER BY id DESC LIMIT 1`
            : sql`SELECT id, project_id FROM session WHERE id < ${cursorValue} ORDER BY id DESC LIMIT 1`,
        )
        if (!nextID) break
        yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              yield* tx
                .insert(KVTable)
                .values({ key: MIGRATION_STATE_KEY, value: { phase: "sessions", cursor: nextID.id } })
                .onConflictDoUpdate({
                  target: KVTable.key,
                  set: { value: { phase: "sessions", cursor: nextID.id }, time_updated: Date.now() },
                })
                .run()
              const projectID = projects.has(nextID.project_id) ? nextID.project_id : Project.ID.global
              if (projectID !== nextID.project_id)
                yield* Effect.logWarning("Reassigned V1 session with missing project", {
                  sessionID: nextID.id,
                  projectID: nextID.project_id,
                })
              yield* tx.run(sql`
                  INSERT OR IGNORE INTO session_v2 (
                    id, project_id, workspace_id, parent_id, slug, directory, path, title, version, share_url,
                    summary_additions, summary_deletions, summary_files, summary_diffs, metadata, cost,
                    tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write,
                    revert, permission, agent, model, time_created, time_updated, time_compacting, time_archived
                  )
                  SELECT
                    id, ${projectID}, workspace_id, parent_id, slug, directory, path, title, version, share_url,
                    summary_additions, summary_deletions, summary_files, summary_diffs, metadata, cost,
                    tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write,
                    revert, NULL, agent, model, time_created, time_updated, time_compacting, time_archived
                  FROM session
                  WHERE id = ${nextID.id}
                `)
              const next = yield* tx
                .select()
                .from(SessionTable)
                .where(eq(SessionTable.id, SessionSchema.ID.make(nextID.id)))
                .get()
              if (!next) return yield* Effect.die(new Error(`Failed to copy V1 session ${nextID.id}`))
              const sourceMessages = yield* tx.all<SourceMessage>(
                sql`SELECT id, session_id, time_created, time_updated, data FROM message WHERE session_id = ${next.id}`,
              )
              const sourceParts = yield* tx.all<SourcePart>(
                sql`SELECT id, message_id, session_id, time_created, time_updated, data FROM part WHERE session_id = ${next.id}`,
              )
              const transformed = transformSession({ session: next, messages: sourceMessages, parts: sourceParts })
              yield* Effect.forEach(transformed.warnings, (warning) =>
                Effect.logWarning("Skipped V1 migration row", warning),
              )
              yield* tx.delete(SessionMessageTable).where(eq(SessionMessageTable.session_id, next.id)).run()
              yield* Effect.forEach(transformed.messages, (message) =>
                tx
                  .insert(SessionMessageTable)
                  .values({
                    id: SessionMessage.ID.make(message.id),
                    session_id: SessionSchema.ID.make(message.session_id),
                    type: message.type,
                    seq: message.seq,
                    time_created: message.time_created,
                    time_updated: message.time_updated,
                    data: sql`${JSON.stringify(message.data)}`,
                  })
                  .run(),
              )
              yield* tx
                .update(SessionTable)
                .set({ ...transformed.session, time_updated: next.time_updated })
                .where(eq(SessionTable.id, next.id))
                .run()
              yield* tx
                .insert(EventSequenceTable)
                .values({ aggregate_id: next.id, seq: transformed.watermark })
                .onConflictDoUpdate({
                  target: EventSequenceTable.aggregate_id,
                  set: { seq: transformed.watermark, owner_id: null },
                })
                .run()
            }),
          )
          .pipe(Effect.orDie)
        if (runtimeState.status === "running")
          runtimeState = {
            status: "running",
            progress: {
              label: "Migrating sessions",
              numerator: (runtimeState.progress.numerator ?? 0) + 1,
              denominator,
            },
          }
        yield* Effect.yieldNow
      }
      yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* tx
              .insert(KVTable)
              .values({ key: MIGRATION_STATE_KEY, value: { phase: "completed" } })
              .onConflictDoUpdate({
                target: KVTable.key,
                set: { value: { phase: "completed" }, time_updated: Date.now() },
              })
              .run()
          }),
        )
        .pipe(Effect.orDie)
      return { status: "completed" as const }
    }).pipe(Effect.orDie),
  )
}

function nextPath(options: Options, data: string) {
  if (options.nextDatabasePath) return options.nextDatabasePath
  if (process.env.OPENCODE_DB === ":memory:") return undefined
  return path.join(data, "opencode-next.db")
}

function openNextDatabase(sourcePath: string) {
  return Effect.acquireRelease(
    Effect.gen(function* () {
      const sqlite = yield* Effect.promise(() => import("bun:sqlite"))
      return new sqlite.Database(sourcePath, { readonly: true, strict: true })
    }),
    (source) => Effect.sync(() => source.close()),
  )
}

function countNextSessions(sourcePath: string | undefined) {
  if (!sourcePath || !existsSync(sourcePath)) return Effect.succeed(0)
  return Effect.scoped(
    Effect.gen(function* () {
      const source = yield* openNextDatabase(sourcePath)
      if (!isNextDatabase(source)) return 0
      return source.query<{ value: number }, []>("SELECT COUNT(*) AS value FROM session").get()?.value ?? 0
    }),
  )
}

function importNextDatabase(
  db: Database.Interface["db"],
  sourcePath: string | undefined,
  onProgress: (completed: number) => void,
): Effect.Effect<void, unknown> {
  if (!sourcePath || !existsSync(sourcePath)) return Effect.void
  return Effect.scoped(
    Effect.gen(function* () {
      const source = yield* openNextDatabase(sourcePath)
      if (!isNextDatabase(source)) {
        yield* Effect.logWarning("Skipped incompatible opencode-next.db", { path: sourcePath })
        return
      }
      source.run("BEGIN")
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (source.inTransaction) source.run("ROLLBACK")
        }),
      )
      const projects = new Map(
        selectNextRows<NextProject>(source, "project", NEXT_PROJECT_COLUMNS).map((project) => [project.id, project]),
      )
      const sessions = selectNextRows<NextSession>(source, "session", NEXT_SESSION_COLUMNS)
      for (const [index, session] of sessions.entries()) {
        const project = projects.get(session.project_id)
        const projectID = project ? session.project_id : Project.ID.global
        if (!project) {
          yield* Effect.logWarning("Reassigned previous V2 session with missing project", {
            sessionID: session.id,
            projectID: session.project_id,
          })
        }
        const messages = source
          .query<
            NextMessage,
            [string]
          >("SELECT id, session_id, type, seq, time_created, time_updated, data FROM session_message WHERE session_id = ? ORDER BY seq")
          .all(session.id)
        yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              if (project)
                yield* tx.run(sql`
                  INSERT OR IGNORE INTO project (
                    id, worktree, vcs, name, icon_url, icon_url_override, icon_color,
                    time_created, time_updated, time_initialized, sandboxes, commands
                  ) VALUES (
                    ${project.id}, ${project.worktree}, ${project.vcs}, ${project.name}, ${project.icon_url},
                    ${project.icon_url_override}, ${project.icon_color}, ${project.time_created}, ${project.time_updated},
                    ${project.time_initialized}, ${project.sandboxes}, ${project.commands}
                  )
                `)
              const existing = yield* tx
                .select({ id: SessionTable.id })
                .from(SessionTable)
                .where(eq(SessionTable.id, SessionSchema.ID.make(session.id)))
                .get()
              if (existing) return
              yield* tx.run(sql`
                INSERT INTO session_v2 (
                  id, project_id, workspace_id, parent_id, fork_session_id, fork_boundary, slug, directory,
                  path, title, version, share_url, summary_additions, summary_deletions, summary_files,
                  summary_diffs, metadata, cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read,
                  tokens_cache_write, revert, permission, agent, model, time_created, time_updated, time_compacting,
                  time_archived, time_suspended
                ) VALUES (
                  ${session.id}, ${projectID}, ${session.workspace_id}, ${session.parent_id},
                  ${session.fork_session_id}, ${session.fork_boundary}, ${session.slug}, ${session.directory},
                  ${session.path}, ${session.title}, ${session.version}, ${session.share_url},
                  ${session.summary_additions}, ${session.summary_deletions}, ${session.summary_files},
                  ${session.summary_diffs}, ${session.metadata}, ${session.cost}, ${session.tokens_input},
                  ${session.tokens_output}, ${session.tokens_reasoning}, ${session.tokens_cache_read},
                  ${session.tokens_cache_write}, ${session.revert}, ${session.permission}, ${session.agent},
                  ${session.model}, ${session.time_created}, ${session.time_updated}, ${session.time_compacting},
                  ${session.time_archived}, ${session.time_suspended}
                )
              `)
              yield* Effect.forEach(messages, (message) =>
                tx
                  .insert(SessionMessageTable)
                  .values({
                    id: SessionMessage.ID.make(message.id),
                    session_id: SessionSchema.ID.make(message.session_id),
                    type: message.type as SessionMessage.Type,
                    seq: message.seq,
                    time_created: message.time_created,
                    time_updated: message.time_updated,
                    data: sql`${message.data}`,
                  })
                  .run(),
              )
              yield* tx
                .insert(EventSequenceTable)
                .values({ aggregate_id: session.id, seq: messages.at(-1)?.seq ?? -1 })
                .onConflictDoUpdate({
                  target: EventSequenceTable.aggregate_id,
                  set: { seq: messages.at(-1)?.seq ?? -1, owner_id: null },
                })
                .run()
            }),
          )
          .pipe(Effect.orDie)
        onProgress(index + 1)
        yield* Effect.yieldNow
      }
      source.run("COMMIT")
    }),
  )
}

function isNextDatabase(source: SQLiteDatabase) {
  const tables = new Set(
    source
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((table) => table.name),
  )
  return tables.has("project") && tables.has("session") && tables.has("session_message")
}

function selectNextRows<A>(source: SQLiteDatabase, table: "project" | "session", definition: NextColumns<A>) {
  const columns = new Set(
    source
      .query<{ name: string }, [string]>("SELECT name FROM pragma_table_info(?)")
      .all(table)
      .map((column) => column.name),
  )
  const missing = Object.entries(definition)
    .filter(([column, strategy]) => strategy === "required" && !columns.has(column))
    .map(([column]) => column)
  if (missing.length)
    throw new Error(`Incompatible opencode-next.db: ${table} is missing required columns: ${missing.join(", ")}`)
  const projection = Object.entries(definition).map(([column, strategy]) => {
    if (columns.has(column)) return `"${column}"`
    if (
      typeof strategy === "object" &&
      strategy !== null &&
      "fallback" in strategy &&
      typeof strategy.fallback === "string" &&
      columns.has(strategy.fallback)
    )
      return `"${strategy.fallback}" AS "${column}"`
    return `NULL AS "${column}"`
  })
  return source
    .query<A, []>(`SELECT ${projection.join(", ")} FROM "${table}"${table === "session" ? ' ORDER BY "id" DESC' : ""}`)
    .all()
}

function row(
  source: SourceMessage,
  message: {
    readonly id: string
    readonly type: SessionMessage.Type
    readonly time: { readonly created: number }
    readonly [key: string]: unknown
  },
): TransformResult["messages"][number] {
  const { id, type, ...data } = message
  return {
    id,
    session_id: source.session_id,
    type,
    seq: 0,
    time_created: source.time_created,
    time_updated: source.time_updated,
    data,
  }
}

function migrateTool(part: typeof SessionV1.ToolPart.Type, fallback: number) {
  const base = {
    type: "tool" as const,
    id: part.callID,
    name: part.tool,
    ...(part.metadata ? { providerState: part.metadata } : {}),
  }
  if (part.state.status === "completed")
    return {
      ...base,
      state: {
        status: "completed",
        input: part.state.input,
        content:
          part.state.time.compacted === undefined
            ? [
                { type: "text", text: part.state.output },
                ...(part.state.attachments ?? []).map((file) => ({
                  type: "file" as const,
                  uri: file.url,
                  mime: file.mime,
                  ...(file.filename ? { name: file.filename } : {}),
                })),
              ]
            : [{ type: "text", text: "[Old tool result content cleared]" }],
        metadata: part.state.metadata,
      },
      time: { created: part.state.time.start, completed: part.state.time.end },
    }
  if (part.state.status === "error")
    return {
      ...base,
      state: {
        status: "error",
        input: part.state.input,
        error: { type: "tool.execution", message: part.state.error },
        ...(typeof part.state.metadata?.output === "string"
          ? { content: [{ type: "text", text: part.state.metadata.output }] }
          : {}),
        ...(part.state.metadata ? { metadata: part.state.metadata } : {}),
      },
      time: { created: part.state.time.start, completed: part.state.time.end },
    }
  return {
    ...base,
    state: {
      status: "error",
      input: part.state.input,
      error: { type: "tool.interrupted", message: "Tool execution was interrupted before V2 migration" },
      ...(part.state.status === "running" && part.state.metadata ? { metadata: part.state.metadata } : {}),
    },
    time: { created: part.state.status === "running" ? part.state.time.start : fallback },
  }
}

function migrateError(error: NonNullable<(typeof SessionV1.Assistant.Type)["error"]>) {
  const message =
    "message" in error.data
      ? error.data.message
      : error.name === "MessageOutputLengthError"
        ? "The model exceeded its output limit"
        : error.name
  const type =
    error.name === "ProviderAuthError"
      ? "provider.auth"
      : error.name === "ContentFilterError"
        ? "provider.content-filter"
        : error.name === "ContextOverflowError"
          ? "provider.invalid-request"
          : error.name === "StructuredOutputError" || error.name === "MessageOutputLengthError"
            ? "provider.invalid-output"
            : error.name === "MessageAbortedError"
              ? "aborted"
              : error.name === "APIError"
                ? "provider.error"
                : "unknown"
  return { type, message }
}

function normalizeFinish(finish: string | undefined) {
  if (!finish) return undefined
  return (
    (["stop", "length", "tool-calls", "content-filter", "error", "unknown"] as const).find(
      (value) => value === finish,
    ) ?? "unknown"
  )
}

function migrateFile(part: SessionV1.FilePart) {
  if (!part.url.startsWith("data:")) return []
  const comma = part.url.indexOf(",")
  if (comma < 0) return []
  const header = part.url.slice(0, comma)
  const payload = part.url.slice(comma + 1)
  const data = header.endsWith(";base64")
    ? Buffer.from(payload, "base64").toString("base64")
    : Buffer.from(decodeURIComponent(payload)).toString("base64")
  return [
    {
      data,
      mime: part.mime,
      source:
        part.source?.type === "resource" ? { type: "uri" as const, uri: part.source.uri } : { type: "inline" as const },
      ...(part.filename ? { name: part.filename } : {}),
      ...(part.source
        ? { mention: { text: part.source.text.value, start: part.source.text.start, end: part.source.text.end } }
        : {}),
    },
  ]
}

function unavailableFile(part: SessionV1.FilePart) {
  const label = part.filename ?? (part.source?.type === "resource" ? part.source.uri : part.url)
  return `[Attachment unavailable after migration: ${label} (${part.mime})]`
}

function syntheticID(source: string, used: Set<string>) {
  const prefix = source.slice(0, 16)
  const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
  for (let salt = 0; ; salt++) {
    const hex = new Bun.CryptoHasher("sha256").update(`v1-synthetic:${source}${salt ? `:${salt}` : ""}`).digest("hex")
    let value = BigInt(`0x${hex}`)
    let suffix = ""
    while (suffix.length < 14) {
      suffix = alphabet[Number(value % 62n)] + suffix
      value /= 62n
    }
    const id = prefix + suffix
    if (used.has(id)) continue
    used.add(id)
    return id
  }
}

function serializeRecent(
  messages: ReadonlyArray<{ row: SourceMessage; value: typeof SessionV1.Info.Type }>,
  parts: Map<string, Array<{ row: SourcePart; value: typeof SessionV1.Part.Type }>>,
) {
  return messages
    .flatMap((message) => {
      const owned = parts.get(message.row.id)?.map((part) => part.value) ?? []
      if (message.value.role === "user")
        return [
          `[User]: ${owned
            .filter((part) => part.type === "text" && !part.ignored)
            .map((part) => (part.type === "text" ? part.text : ""))
            .join("\n\n")}`,
        ]
      return owned.flatMap((part) =>
        part.type === "text"
          ? [`[Assistant]: ${part.text}`]
          : part.type === "reasoning" && part.text
            ? [`[Assistant reasoning]: ${part.text}`]
            : [],
      )
    })
    .join("\n\n")
}

function readState(db: Database.Interface["db"]): Effect.Effect<MigrationState | undefined> {
  return db
    .select({ value: KVTable.value })
    .from(KVTable)
    .where(eq(KVTable.key, MIGRATION_STATE_KEY))
    .get()
    .pipe(
      Effect.map((row) => parseState(row?.value)),
      Effect.orDie,
    )
}

function parseState(input: unknown): MigrationState | undefined {
  if (!input || typeof input !== "object" || !("phase" in input)) return
  if (input.phase === "completed") return { phase: "completed" }
  if (input.phase !== "sessions") return
  if (!("cursor" in input) || input.cursor === undefined) return { phase: "sessions" }
  if (typeof input.cursor === "string") return { phase: "sessions", cursor: input.cursor }
}

function hasLegacySessions(db: Database.Interface["db"]) {
  return db.get(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session'`).pipe(
    Effect.map((row) => row !== undefined),
    Effect.orDie,
  )
}
