import { describe, expect } from "bun:test"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventSequenceTable, EventTable } from "@opencode-ai/core/event/sql"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { desc, eq, inArray } from "drizzle-orm"
import { Effect, Layer } from "effect"
import { Config } from "@/config/config"
import { EventV2Bridge } from "@/event-v2-bridge"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { SessionEventRetention } from "@/session/event-retention"
import { Session } from "@/session/session"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { TestConfig } from "../fixture/config"
import { testEffect } from "../lib/effect"

const day = 24 * 60 * 60 * 1000

function layer(retention?: number) {
  return AppNodeBuilder.build(
    LayerNode.group([
      SessionEventRetention.node,
      Session.node,
      SessionProjector.node,
      Database.node,
      EventV2Bridge.node,
      CrossSpawnSpawner.node,
    ]),
    [
      [
        Config.node,
        Layer.succeed(
          Config.Service,
          TestConfig.make({
            getGlobal: () =>
              Effect.succeed(retention === undefined ? {} : { retention: { event_idle_days: retention } }),
          }),
        ),
      ],
      [RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true })],
    ],
  )
}

const disabled = testEffect(layer())
const enabled = testEffect(layer(7))

function createSession(time_updated: number) {
  return Effect.gen(function* () {
    const sessions = yield* Session.Service
    const { db } = yield* Database.Service
    const session = yield* sessions.create()
    yield* db.update(SessionTable).set({ time_updated }).where(eq(SessionTable.id, session.id)).run()
    return session
  })
}

function eventCount(sessionID: string) {
  return Database.Service.use(({ db }) =>
    db
      .select({ id: EventTable.id })
      .from(EventTable)
      .where(eq(EventTable.aggregate_id, sessionID))
      .all()
      .pipe(Effect.map((rows) => rows.length), Effect.orDie),
  )
}

function hasSequence(sessionID: string) {
  return Database.Service.use(({ db }) =>
    db
      .select({ aggregate_id: EventSequenceTable.aggregate_id })
      .from(EventSequenceTable)
      .where(eq(EventSequenceTable.aggregate_id, sessionID))
      .get()
      .pipe(Effect.map(Boolean), Effect.orDie),
  )
}

function removeEvents(sessionIDs: ReadonlyArray<string>) {
  return EventV2Bridge.Service.use((events) => Effect.forEach(sessionIDs, (sessionID) => events.remove(sessionID)))
}

describe("session event retention", () => {
  disabled.instance("keeps event history when retention is absent", () =>
    Effect.gen(function* () {
      const now = Date.now()
      const session = yield* createSession(now - 30 * day)
      const retention = yield* SessionEventRetention.Service

      expect(yield* eventCount(session.id)).toBeGreaterThan(0)
      expect(yield* retention.sweep(now)).toEqual({ sessions: 0, events: 0 })
      expect(yield* eventCount(session.id)).toBeGreaterThan(0)
      expect(yield* hasSequence(session.id)).toBe(true)
      yield* removeEvents([session.id])
    }),
  )

  enabled.instance("removes only event history for sessions idle beyond retention", () =>
    Effect.gen(function* () {
      const now = Date.now()
      const old = yield* createSession(now - 8 * day)
      const recent = yield* createSession(now - 6 * day)
      const retention = yield* SessionEventRetention.Service

      const result = yield* retention.sweep(now)
      expect(yield* eventCount(old.id)).toBe(0)
      expect(yield* hasSequence(old.id)).toBe(false)
      expect(yield* eventCount(recent.id)).toBe(1)
      expect(yield* hasSequence(recent.id)).toBe(true)
      expect(result).toEqual({ sessions: 1, events: 1 })
      yield* removeEvents([old.id, recent.id])
    }),
  )

  enabled.instance("restarts durable event sequence at zero after retention", () =>
    Effect.gen(function* () {
      const now = Date.now()
      const session = yield* createSession(now - 8 * day)
      const retention = yield* SessionEventRetention.Service
      const events = yield* EventV2Bridge.Service
      const sessions = yield* Session.Service

      yield* retention.sweep(now)
      yield* events.publish(SessionV1.Event.Updated, { sessionID: session.id, info: yield* sessions.get(session.id) })

      const { db } = yield* Database.Service
      const event = yield* db
        .select({ seq: EventTable.seq })
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, session.id))
        .orderBy(desc(EventTable.seq))
        .get()
        .pipe(Effect.orDie)
      expect(event?.seq).toBe(0)
      yield* removeEvents([session.id])
    }),
  )

  enabled.instance("sweeps at most two hundred sessions per run", () =>
    Effect.gen(function* () {
      const now = Date.now()
      const sessions = yield* Effect.forEach(
        Array.from({ length: 201 }),
        () => createSession(now - 10 * day),
        { concurrency: 1 },
      )
      const retention = yield* SessionEventRetention.Service

      expect(yield* retention.sweep(now)).toEqual({ sessions: 200, events: 200 })

      const { db } = yield* Database.Service
      const remaining = yield* db
        .select({ id: EventTable.id })
        .from(EventTable)
        .where(inArray(EventTable.aggregate_id, sessions.map((session) => session.id)))
        .all()
        .pipe(Effect.map((rows) => rows.length), Effect.orDie)
      expect(remaining).toBe(1)
      yield* removeEvents(sessions.map((session) => session.id))
    }),
  )
})
