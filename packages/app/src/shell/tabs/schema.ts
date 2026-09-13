export * as TabStorage from "./schema"

import { Schema, SchemaGetter } from "effect"
import { ServerKey } from "@/runtime/server/persistence"
import { Persistence } from "@/runtime/persistence/schema"

export { ServerKey }

export const Session = Persistence.struct({
  type: Schema.Literal("session"),
  server: ServerKey,
  sessionId: Schema.String,
  routeSessionId: Persistence.optional(Schema.String),
  routeParentId: Persistence.optional(Schema.String),
})

export const Draft = Persistence.struct({
  type: Schema.Literal("draft"),
  draftID: Schema.String,
  server: ServerKey,
  directory: Schema.String,
  worktree: Persistence.optional(Schema.String),
  branch: Persistence.optional(Schema.String),
  mcp: Persistence.optional(Persistence.struct({ target: Schema.String, states: Persistence.record(Schema.Boolean) })),
})

const SessionCodec = Session.pipe(
  Schema.decodeTo(Schema.toType(Session), {
    decode: SchemaGetter.transform((tab) => ({
      type: tab.type,
      server: tab.server,
      sessionId: tab.sessionId,
      ...(tab.routeSessionId && tab.routeSessionId !== tab.sessionId
        ? { routeSessionId: tab.routeSessionId, ...(tab.routeParentId ? { routeParentId: tab.routeParentId } : {}) }
        : {}),
    })),
    encode: SchemaGetter.transform((tab) => tab),
  }),
)

export const Tab = Schema.Union([Session, Draft])
export const Tabs = Persistence.array(Schema.Union([SessionCodec, Draft]))
export const Recent = Persistence.struct({
  key: Schema.optional(Schema.String),
})
export const Info = Persistence.struct({
  title: Schema.optional(Schema.String),
  directory: Schema.optional(Schema.String),
})
export const Infos = Schema.Record(Schema.String, Schema.mutableKey(Info))
export const Panes = Schema.Record(
  Schema.String,
  Schema.mutableKey(
    Persistence.struct({
      terminal: Schema.optional(Schema.Boolean),
      review: Schema.optional(Schema.Boolean),
      terminalHeight: Schema.optional(Schema.Finite),
      sessionWidth: Schema.optional(Schema.Finite),
    }),
  ),
)
export const ClosedTab = Schema.Struct({ tab: SessionCodec, index: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)) })
export const Closed = Persistence.array(ClosedTab)
