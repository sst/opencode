export * as SessionStats from "./stats.js"

import { DateTime, Effect, Option, Schema } from "effect"
import { and, eq, gte, inArray, lt, sql } from "drizzle-orm"
import { Model } from "@opencode/schema/model"
import { Money } from "@opencode/schema/money"
import { Project } from "@opencode/schema/project"
import { Provider } from "@opencode/schema/provider"
import { SessionEvent } from "@opencode/schema/session-event"
import { ToolMode } from "@opencode/schema/session-stats"
import { TokenUsage } from "@opencode/schema/token-usage"
import { Database } from "../database/database.js"
import { EventTable } from "../event/sql.js"
import { SessionMessageTable, SessionTable } from "./sql.js"

type Input = {
  readonly from?: number
  readonly to?: number
  readonly projectID?: Project.ID
  readonly timezone?: string
  readonly tools?: ToolMode
}

type Tokens = {
  input: number
  output: number
  reasoning: number
  cache: { read: number; write: number }
}

type MessageRow = {
  sessionID: string
  parentID: string | null
  type: "user" | "assistant"
  timeCreated: number
  providerID: string | null
  modelID: string | null
  variant: string | null
  input: number | null
  output: number | null
  reasoning: number | null
  cacheRead: number | null
  cacheWrite: number | null
  cost: number | null
}

type ToolRow = {
  name: string | null
  status: string | null
  duration: number | null
}

type ToolSummaryRow = {
  calls: number
  succeeded: number
  failed: number
  unfinished: number
}

type ModelAggregate = {
  model: Model.Ref
  steps: number
  tokens: Tokens
  cost: number
}

type ToolAggregate = {
  name: string
  calls: number
  succeeded: number
  failed: number
  unfinished: number
  durations: number[]
}

const decodeUsage = Schema.decodeUnknownOption(SessionEvent.UsageRecorded.data)
const Window = 31 * 24 * 60 * 60 * 1_000

export class InvalidRangeError extends Schema.TaggedError<InvalidRangeError>()("SessionStats.InvalidRangeError", {
  from: Schema.Finite,
  to: Schema.Finite,
}) {}

export const get = Effect.fn("SessionStats.get")(function* (input: Input = {}) {
  const db = (yield* Database.Service).db
  const to = input.to ?? Date.now()
  if (input.from !== undefined && input.from >= to) return yield* new InvalidRangeError({ from: input.from, to })
  const project = input.projectID === undefined ? sql`` : sql`AND session.project_id = ${input.projectID}`
  const from =
    input.from ??
    (yield* db
      .get<{ time: number | null }>(
        sql`
        SELECT min(message.time_created) AS time
        FROM ${SessionMessageTable} AS message
        JOIN ${SessionTable} AS session ON session.id = message.session_id
        WHERE message.type IN ('user', 'assistant')
          AND message.time_created < ${to}
          AND (session.fork_session_id IS NULL
            OR NOT EXISTS (SELECT 1 FROM ${SessionTable} AS parent WHERE parent.id = session.fork_session_id)
            OR message.time_created >= session.time_created)
          ${project}
      `,
      )
      .pipe(Effect.orDie))?.time ??
    to
  const ranges = windows(from, to)
  const toolMode = input.tools ?? "summary"
  const sessions = new Set<string>()
  const subagents = new Set<string>()
  const activity = new Map<string, number>()
  const models = new Map<string, ModelAggregate>()
  const tools = new Map<string, ToolAggregate>()
  const totals = {
    prompts: 0,
    steps: 0,
    tokens: emptyTokens(),
    cost: 0,
  }
  const toolTotals = { calls: 0, succeeded: 0, failed: 0, unfinished: 0 }
  const dateKey = makeDateKey(input.timezone)

  yield* Effect.forEach(
    ranges,
    (range) =>
      db
        .all<MessageRow>(
          sql`
          SELECT
            message.session_id AS sessionID,
            session.parent_id AS parentID,
            message.type AS type,
            message.time_created AS timeCreated,
            json_extract(message.data, '$.model.providerID') AS providerID,
            json_extract(message.data, '$.model.id') AS modelID,
            json_extract(message.data, '$.model.variant') AS variant,
            json_extract(message.data, '$.tokens.input') AS input,
            json_extract(message.data, '$.tokens.output') AS output,
            json_extract(message.data, '$.tokens.reasoning') AS reasoning,
            json_extract(message.data, '$.tokens.cache.read') AS cacheRead,
            json_extract(message.data, '$.tokens.cache.write') AS cacheWrite,
            json_extract(message.data, '$.cost') AS cost
          FROM ${SessionMessageTable} AS message
          JOIN ${SessionTable} AS session ON session.id = message.session_id
          WHERE message.type IN ('user', 'assistant')
            AND message.time_created >= ${range.from}
            AND message.time_created < ${range.to}
            AND (session.fork_session_id IS NULL
              OR NOT EXISTS (SELECT 1 FROM ${SessionTable} AS parent WHERE parent.id = session.fork_session_id)
              OR message.time_created >= session.time_created)
            ${project}
        `,
        )
        .pipe(
          Effect.orDie,
          Effect.tap((rows) =>
            Effect.sync(() => {
              rows.forEach((row) => {
                if (row.parentID === null) sessions.add(row.sessionID)
                else subagents.add(row.sessionID)
                if (row.type === "user") {
                  if (row.parentID === null) totals.prompts++
                  return
                }

                totals.steps++
                const tokens = rowTokens(row)
                addTokens(totals.tokens, tokens)
                totals.cost += row.cost ?? 0
                const day = dateKey(row.timeCreated)
                activity.set(day, (activity.get(day) ?? 0) + 1)
                if (!row.providerID || !row.modelID) return
                const key = `${row.providerID}/${row.modelID}#${row.variant ?? ""}`
                const model = models.get(key) ?? {
                  model: {
                    providerID: Provider.ID.make(row.providerID),
                    id: Model.ID.make(row.modelID),
                    variant: row.variant ? Model.VariantID.make(row.variant) : undefined,
                  },
                  steps: 0,
                  tokens: emptyTokens(),
                  cost: 0,
                }
                models.set(key, model)
                model.steps++
                model.cost += row.cost ?? 0
                addTokens(model.tokens, tokens)
              })
            }),
          ),
        ),
    { concurrency: 1, discard: true },
  )

  if (toolMode !== "none")
    yield* Effect.forEach(
      ranges,
      (range) => {
        if (toolMode === "summary")
          return db
            .get<ToolSummaryRow>(
              sql`
            WITH calls AS MATERIALIZED (
              SELECT json_extract(content.value, '$.state.status') AS status
              FROM ${SessionMessageTable} AS message
              JOIN ${SessionTable} AS session ON session.id = message.session_id,
                json_each(message.data, '$.content') AS content
              WHERE message.type = 'assistant'
                AND message.time_created >= ${range.from}
                AND message.time_created < ${range.to}
                AND (session.fork_session_id IS NULL
                  OR NOT EXISTS (SELECT 1 FROM ${SessionTable} AS parent WHERE parent.id = session.fork_session_id)
                  OR message.time_created >= session.time_created)
                AND json_extract(content.value, '$.type') = 'tool'
                ${project}
            )
            SELECT
              count(*) AS calls,
              count(*) FILTER (WHERE status = 'completed') AS succeeded,
              count(*) FILTER (WHERE status = 'error') AS failed,
              count(*) FILTER (WHERE status IS NULL OR status NOT IN ('completed', 'error')) AS unfinished
            FROM calls
          `,
            )
            .pipe(
              Effect.orDie,
              Effect.tap((row) =>
                Effect.sync(() => {
                  if (!row) return
                  toolTotals.calls += row.calls
                  toolTotals.succeeded += row.succeeded
                  toolTotals.failed += row.failed
                  toolTotals.unfinished += row.unfinished
                }),
              ),
              Effect.asVoid,
            )
        return db
          .all<ToolRow>(
            sql`
          SELECT
            json_extract(content.value, '$.name') AS name,
            json_extract(content.value, '$.state.status') AS status,
            CASE
              WHEN json_extract(content.value, '$.time.completed') IS NULL THEN NULL
              ELSE json_extract(content.value, '$.time.completed')
                - coalesce(json_extract(content.value, '$.time.ran'), json_extract(content.value, '$.time.created'))
            END AS duration
          FROM ${SessionMessageTable} AS message
          JOIN ${SessionTable} AS session ON session.id = message.session_id,
            json_each(message.data, '$.content') AS content
          WHERE message.type = 'assistant'
            AND message.time_created >= ${range.from}
            AND message.time_created < ${range.to}
            AND (session.fork_session_id IS NULL
              OR NOT EXISTS (SELECT 1 FROM ${SessionTable} AS parent WHERE parent.id = session.fork_session_id)
              OR message.time_created >= session.time_created)
            AND json_extract(content.value, '$.type') = 'tool'
            ${project}
        `,
          )
          .pipe(
            Effect.orDie,
            Effect.tap((rows) =>
              Effect.sync(() => {
                rows.forEach((row) => {
                  addToolStatus(toolTotals, row.status)
                  if (!row.name) return
                  const tool = tools.get(row.name) ?? {
                    name: row.name,
                    calls: 0,
                    succeeded: 0,
                    failed: 0,
                    unfinished: 0,
                    durations: [],
                  }
                  tools.set(row.name, tool)
                  addToolStatus(tool, row.status)
                  if (row.duration !== null) tool.durations.push(row.duration)
                })
              }),
            ),
            Effect.asVoid,
          )
      },
      { concurrency: 1, discard: true },
    )

  const ids = yield* db
    .select({ id: SessionTable.id })
    .from(SessionTable)
    .where(input.projectID === undefined ? undefined : eq(SessionTable.project_id, input.projectID))
    .all()
    .pipe(Effect.orDie)
  const events = (yield* Effect.forEach(
    batches(ids.map((row) => row.id)),
    (batch) =>
      db
        .select({ data: EventTable.data })
        .from(EventTable)
        .where(
          and(
            inArray(EventTable.aggregate_id, batch),
            eq(EventTable.type, SessionEvent.UsageRecorded.type),
            sql`json_extract(${EventTable.data}, '$.source') = 'compaction'`,
            gte(EventTable.created, from),
            lt(EventTable.created, to),
          ),
        )
        .all()
        .pipe(Effect.orDie),
    { concurrency: 4 },
  )).flat()
  events.forEach((row) => {
    const decoded = decodeUsage(row.data)
    if (Option.isNone(decoded)) return
    addTokens(totals.tokens, decoded.value.tokens)
    totals.cost += decoded.value.cost
  })

  const days = [...activity.entries()].sort(([a], [b]) => a.localeCompare(b))
  return {
    range: { from: DateTime.makeUnsafe(from), to: DateTime.makeUnsafe(to) },
    sessions: sessions.size,
    subagents: subagents.size,
    prompts: totals.prompts,
    steps: totals.steps,
    tokens: totals.tokens,
    cost: Money.USD.make(totals.cost),
    tools:
      toolMode === "none"
        ? { mode: toolMode }
        : toolMode === "summary"
          ? { mode: toolMode, totals: toolTotals }
          : {
              mode: toolMode,
              totals: toolTotals,
              usage: [...tools.values()]
                .sort((a, b) => b.calls - a.calls)
                .map((tool) => ({
                  name: tool.name,
                  calls: tool.calls,
                  succeeded: tool.succeeded,
                  failed: tool.failed,
                  unfinished: tool.unfinished,
                  durationP50: median(tool.durations),
                })),
            },
    activeDays: days.length,
    streak: longestStreak(days.map(([date]) => date)),
    activity: days.map(([date, steps]) => ({ date, steps })),
    models: [...models.values()]
      .sort((a, b) => TokenUsage.total(b.tokens) - TokenUsage.total(a.tokens))
      .map((model) => ({ ...model, cost: Money.USD.make(model.cost) })),
  }
})

function windows(from: number, to: number) {
  return Array.from({ length: Math.ceil((to - from) / Window) }, (_, index) => ({
    from: from + index * Window,
    to: Math.min(to, from + (index + 1) * Window),
  }))
}

function batches(ids: string[]) {
  return Array.from({ length: Math.ceil(ids.length / 500) }, (_, index) => ids.slice(index * 500, (index + 1) * 500))
}

function rowTokens(row: MessageRow): Tokens {
  return {
    input: row.input ?? 0,
    output: row.output ?? 0,
    reasoning: row.reasoning ?? 0,
    cache: { read: row.cacheRead ?? 0, write: row.cacheWrite ?? 0 },
  }
}

function emptyTokens(): Tokens {
  return { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
}

function addTokens(target: Tokens, source: Tokens) {
  target.input += source.input
  target.output += source.output
  target.reasoning += source.reasoning
  target.cache.read += source.cache.read
  target.cache.write += source.cache.write
}

function addToolStatus(
  target: { calls: number; succeeded: number; failed: number; unfinished: number },
  status: string | null,
) {
  target.calls++
  if (status === "completed") {
    target.succeeded++
    return
  }
  if (status === "error") {
    target.failed++
    return
  }
  target.unfinished++
}

function makeDateKey(timezone = "UTC") {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
  return (time: number) => {
    const parts = Object.fromEntries(formatter.formatToParts(time).map((part) => [part.type, part.value]))
    return `${parts.year}-${parts.month}-${parts.day}`
  }
}

function longestStreak(days: string[]) {
  return days.reduce(
    (result, day, index) => {
      const previous = days[index - 1]
      const current = previous && dayOrdinal(day) - dayOrdinal(previous) === 1 ? result.current + 1 : 1
      return { current, longest: Math.max(result.longest, current) }
    },
    { current: 0, longest: 0 },
  ).longest
}

function dayOrdinal(value: string) {
  const [year, month, day] = value.split("-").map(Number)
  return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000)
}

function median(values: number[]) {
  if (values.length === 0) return undefined
  const sorted = values.toSorted((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
}
