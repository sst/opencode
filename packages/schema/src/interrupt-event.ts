export * as InterruptEvent from "./interrupt-event"

import { Schema } from "effect"
import { Event } from "./event"
import { SessionID } from "./session-id"

export const Intent = Schema.Literals(["steer", "cancel"])
export const Origin = Schema.Literals(["user", "parent"])

export const Requested = Event.define({
  type: "interrupt.requested",
  schema: {
    sessionID: SessionID,
    intent: Intent,
    reason: Schema.String,
    origin: Origin,
  },
})

export const Consumed = Event.define({
  type: "interrupt.consumed",
  schema: {
    sessionID: SessionID,
    intent: Intent,
  },
})

export const Terminal = Event.define({
  type: "interrupt.terminal",
  schema: {
    sessionID: SessionID,
    reason: Schema.String,
  },
})

export const Definitions = Event.inventory(Requested, Consumed, Terminal)
