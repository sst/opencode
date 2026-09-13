export * as SessionDiff from "./diff.js"

import { and, asc, eq, gt, inArray, lt, or, sql } from "drizzle-orm"
import { Context, Effect, Schema } from "effect"
import { Location } from "@opencode/schema/location"
import { Database } from "../database/database.js"
import { LocationServiceMap } from "../location-service-map.js"
import { Snapshot } from "../snapshot.js"
import { PATCH_CONTEXT_LINES } from "../vcs/patch.js"
import { MessageNotFoundError } from "./error.js"
import { SessionMessage } from "./message.js"
import { SessionSchema } from "./schema.js"
import { SessionMessageTable } from "./sql.js"

export class TurnRangeError extends Schema.TaggedError<TurnRangeError>()("Session.TurnRangeError", {
  sessionID: SessionSchema.ID,
  field: Schema.Literals(["from", "to"]),
  message: Schema.String,
}) {}

const decodeLocation = Schema.decodeUnknownSync(Schema.fromJsonString(Location.Ref))

/**
 * Diff the files changed by the turn containing a user message. A turn runs from
 * the first prompt after the Session was last idle until the next idle marker, so
 * prompts steered in while it was busy belong to the same turn; `to` extends the
 * range through the turn containing a later user message. Compares the range's
 * first recorded start snapshot with its last recorded end snapshot; only a step
 * still running in the active Session compares against the working copy. Like VCS
 * diffs, an omitted `context` yields full-file patches.
 *
 * A Session without any idle marker predates them, so its prompts span until the
 * next user message instead.
 *
 * Snapshot trees live in the repository of the Location that captured them, so a
 * range spanning a location switch is rejected rather than diffed wrongly.
 */
export const turn = Effect.fn("SessionDiff.turn")(function* (
  db: Database.Interface["db"],
  locations: Context.Service.Shape<typeof LocationServiceMap.Service>,
  input: {
    readonly session: SessionSchema.Info
    /** The process is currently executing this Session. */
    readonly active: boolean
    readonly from?: SessionMessage.ID
    readonly to?: SessionMessage.ID
    readonly context?: number
  },
) {
  const sessionID = input.session.id
  const rows = yield* db
    .select({ id: SessionMessageTable.id, type: SessionMessageTable.type, seq: SessionMessageTable.seq })
    .from(SessionMessageTable)
    .where(
      and(
        eq(SessionMessageTable.session_id, sessionID),
        or(
          inArray(SessionMessageTable.type, ["user", "idle"]),
          input.from ? eq(SessionMessageTable.id, input.from) : undefined,
          input.to ? eq(SessionMessageTable.id, input.to) : undefined,
        ),
      ),
    )
    .orderBy(asc(SessionMessageTable.seq))
    .all()
    .pipe(Effect.orDie)
  const users = rows.filter((row) => row.type === "user")
  const markers = rows.filter((row) => row.type === "idle")
  const resolve = Effect.fn(function* (field: "from" | "to", id: SessionMessage.ID) {
    const row = rows.find((row) => row.id === id)
    if (!row) return yield* new MessageNotFoundError({ sessionID, messageID: id })
    if (row.type !== "user")
      return yield* new TurnRangeError({ sessionID, field, message: `Message ${id} is not a user message` })
    return row
  })
  const anchor = input.from ? yield* resolve("from", input.from) : users[users.length - 1]
  if (!anchor) return []
  const last = input.to ? yield* resolve("to", input.to) : anchor
  if (last.seq < anchor.seq)
    return yield* new TurnRangeError({ sessionID, field: "to", message: `Message ${last.id} precedes ${anchor.id}` })
  // Without any marker, history predates idle markers and a prompt's turn ends at the next prompt.
  const legacy = markers.length === 0
  // The turn opens with the first prompt after the previous idle marker; the anchor itself is the latest candidate.
  const opened = markers.findLast((row) => row.seq < anchor.seq)?.seq ?? -1
  const start = legacy ? anchor.seq : (users.find((row) => row.seq > opened)?.seq ?? anchor.seq)
  const end = legacy ? users.find((row) => row.seq > last.seq)?.seq : markers.find((row) => row.seq > last.seq)?.seq
  const steps = yield* db
    .select({
      seq: SessionMessageTable.seq,
      start: sql<string | null>`json_extract(${SessionMessageTable.data}, '$.snapshot.start')`,
      end: sql<string | null>`json_extract(${SessionMessageTable.data}, '$.snapshot.end')`,
      completed: sql<number | null>`json_extract(${SessionMessageTable.data}, '$.time.completed')`,
    })
    .from(SessionMessageTable)
    .where(
      and(
        eq(SessionMessageTable.session_id, sessionID),
        eq(SessionMessageTable.type, "assistant"),
        gt(SessionMessageTable.seq, start),
        end === undefined ? undefined : lt(SessionMessageTable.seq, end),
      ),
    )
    .orderBy(asc(SessionMessageTable.seq))
    .all()
    .pipe(Effect.orDie)
  const first = steps[0]
  const final = steps[steps.length - 1]
  const from = steps.find((step) => step.start)?.start
  if (!first || !final || !from) return []
  const switches = yield* db
    .select({
      seq: SessionMessageTable.seq,
      location: sql<string>`json_extract(${SessionMessageTable.data}, '$.location')`,
      previous: sql<string | null>`json_extract(${SessionMessageTable.data}, '$.previous.location')`,
    })
    .from(SessionMessageTable)
    .where(and(eq(SessionMessageTable.session_id, sessionID), eq(SessionMessageTable.type, "location-switched")))
    .orderBy(asc(SessionMessageTable.seq))
    .all()
    .pipe(Effect.orDie)
  if (switches.some((row) => row.seq > first.seq && row.seq < final.seq))
    return yield* new TurnRangeError({ sessionID, field: "to", message: "Turn range spans a location change" })
  const before = switches.findLast((row) => row.seq < first.seq)?.location
  const after = switches.find((row) => row.seq > first.seq)?.previous
  const location = before ? decodeLocation(before) : after ? decodeLocation(after) : input.session.location
  const recorded = steps.findLast((step) => step.end)?.end
  return yield* Effect.gen(function* () {
    const snapshot = yield* Snapshot.Service
    const running = input.active && final.completed === null
    const to = running ? ((yield* snapshot.capture()) ?? recorded) : recorded
    if (!to) return []
    return yield* snapshot.diff({
      from: Snapshot.ID.make(from),
      to: Snapshot.ID.make(to),
      context: input.context ?? PATCH_CONTEXT_LINES,
    })
  }).pipe(Effect.provide(locations.get(location)))
})
