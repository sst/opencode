export * as SessionCompactionEvent from "./session-compaction-event"

import { Event } from "./event"
import { SessionID } from "./session-id"
import { SessionCompaction } from "./session-compaction"
import { optional } from "./schema"

export const Compacted = Event.define({
  type: "session.compacted",
  schema: {
    sessionID: SessionID,
    diagnostics: SessionCompaction.Diagnostics.pipe(optional),
  },
})

export const Definitions = Event.inventory(Compacted)
