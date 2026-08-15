import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { EventTable } from "@opencode-ai/core/event/sql"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { Config } from "@/config/config"
import { asc, eq, inArray, lt } from "drizzle-orm"
import { Context, Duration, Effect, Layer, Schedule, Scope } from "effect"

export const BATCH_LIMIT = 200
const DELETE_BATCH_SIZE = 25
const DAY_MS = 24 * 60 * 60 * 1000

export interface SweepResult {
  readonly sessions: number
  readonly events: number
}

export interface Interface {
  readonly sweep: (now: number) => Effect.Effect<SweepResult>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionEventRetention") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const scope = yield* Scope.Scope
    const config = yield* Config.Service
    const { db } = yield* Database.Service
    const events = yield* EventV2.Service

    const sweep = Effect.fn("SessionEventRetention.sweep")(function* (now: number) {
      const days = (yield* config.getGlobal()).retention?.event_idle_days
      if (days === undefined || days <= 0) return { sessions: 0, events: 0 }

      const sessions = yield* db
        .select({ id: SessionTable.id })
        .from(SessionTable)
        .innerJoin(EventTable, eq(EventTable.aggregate_id, SessionTable.id))
        .where(lt(SessionTable.time_updated, now - days * DAY_MS))
        .groupBy(SessionTable.id)
        .orderBy(asc(SessionTable.time_updated))
        .limit(BATCH_LIMIT)
        .all()
        .pipe(Effect.orDie)
      if (!sessions.length) return { sessions: 0, events: 0 }

      const history = yield* db
        .select({ id: EventTable.id })
        .from(EventTable)
        .where(inArray(EventTable.aggregate_id, sessions.map((session) => session.id)))
        .all()
        .pipe(Effect.orDie)

      yield* Effect.forEach(
        sessions,
        (session, index) =>
          events.remove(session.id).pipe(
            Effect.andThen((index + 1) % DELETE_BATCH_SIZE === 0 ? Effect.sleep(Duration.millis(1)) : Effect.void),
          ),
        { concurrency: 1 },
      )

      yield* Effect.logInfo("swept event history", { sessions: sessions.length, events: history.length })
      return { sessions: sessions.length, events: history.length }
    })

    yield* Effect.suspend(() => sweep(Date.now())).pipe(
      Effect.catchCause((cause) => Effect.logError("event history retention sweep failed", { cause })),
      Effect.repeat(Schedule.spaced(Duration.hours(1))),
      Effect.delay(Duration.minutes(1)),
      Effect.forkIn(scope),
    )

    return Service.of({ sweep })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [Config.node, Database.node, EventV2.node] })

export * as SessionEventRetention from "./event-retention"
