export * as SessionEvent from "./session-event.js"

import { Schema } from "effect"
import { optional } from "./schema.js"
import { Event } from "./event.js"
import { FinishReason } from "./llm.js"
import { Content } from "./tool.js"
import { Model } from "./model.js"
import { NonNegativeInt, PositiveInt, RelativePath } from "./schema.js"
import { FileAttachment } from "./prompt.js"
import { SessionID } from "./session-id.js"
import { SessionMetadata } from "./session-metadata.js"
import { Location } from "./location.js"
import { SessionMessage } from "./session-message.js"
import { Revert } from "./session-revert.js"
import { Shell as ShellSchema } from "./shell.js"
import { SessionError } from "./session-error.js"
import { Instruction } from "./instruction.js"
import { InstructionEntry } from "./instruction-entry.js"
import { Agent } from "./agent.js"
import { Skill as SkillSchema } from "./skill.js"
import { Money } from "./money.js"
import { Snapshot } from "./snapshot.js"
import { TokenUsage } from "./token-usage.js"
import { SessionInbox } from "./session-inbox.js"
import { Project } from "./project.js"
import { SessionFork } from "./session-fork.js"
import { Permission } from "./permission.js"

export { FileAttachment }

export const Source = Schema.Struct({
  start: NonNegativeInt,
  end: NonNegativeInt,
  text: Schema.String,
}).annotate({
  identifier: "Session.Event.Source",
})
export interface Source extends Schema.Schema.Type<typeof Source> {}

const Base = {
  sessionID: SessionID,
}

const options = {
  durable: {
    aggregate: "sessionID",
    version: 1,
  },
} as const
export const Created = Event.durable({
  type: "session.created",
  ...options,
  schema: {
    ...Base,
    projectID: Project.ID,
    location: Location.Ref,
    subpath: RelativePath.pipe(optional),
    parentID: SessionID.pipe(optional),
    slug: Schema.String,
    title: Schema.String.pipe(optional),
    agent: Agent.ID.pipe(optional),
    model: Model.Ref.pipe(optional),
    /** Host-supplied annotations resolved at creation, including any inherited from a parent. */
    metadata: SessionMetadata.pipe(optional),
    permissions: Permission.Ruleset.pipe(optional),
    version: Schema.String,
  },
})
export type Created = typeof Created.Type

export const AgentSelected = Event.durable({
  type: "session.agent.selected",
  ...options,
  schema: {
    ...Base,
    agent: Agent.ID,
    previous: Agent.ID.pipe(optional),
  },
})
export type AgentSelected = typeof AgentSelected.Type

export const ModelSelected = Event.durable({
  type: "session.model.selected",
  ...options,
  schema: {
    ...Base,
    model: Model.Ref,
    previous: Model.Ref.pipe(optional),
  },
})
export type ModelSelected = typeof ModelSelected.Type

export const Moved = Event.durable({
  type: "session.moved",
  ...options,
  schema: {
    ...Base,
    ...SessionInbox.MovePayload.fields,
  },
})
export type Moved = typeof Moved.Type

export const Renamed = Event.durable({
  type: "session.renamed",
  ...options,
  schema: {
    ...Base,
    title: Schema.String,
  },
})
export type Renamed = typeof Renamed.Type

export const PermissionsUpdated = Event.durable({
  type: "session.permissions.updated",
  ...options,
  schema: {
    ...Base,
    permissions: Permission.Ruleset,
  },
})
export type PermissionsUpdated = typeof PermissionsUpdated.Type

export const Viewed = Event.durable({
  type: "session.viewed",
  ...options,
  schema: {
    ...Base,
    /** Epoch-millisecond idle watermark the viewer observed; projection never marks a newer idle transition viewed. */
    idle: Schema.Finite,
  },
})
export type Viewed = typeof Viewed.Type

// Replay-only: older releases allowed replacing completed assistant content.
export const MessageContentUpdated = Event.durable({
  type: "session.message.content.updated",
  ...options,
  schema: {
    ...Base,
    messageID: SessionMessage.ID,
    // Public events are framed directly, so timestamps must already be encoded.
    content: Schema.Array(SessionMessage.AssistantContentEncoded),
  },
})
export type MessageContentUpdated = typeof MessageContentUpdated.Type

export const UsageRecorded = Event.durable({
  type: "session.usage.recorded",
  ...options,
  schema: {
    ...Base,
    source: Schema.Literals(["title", "compaction"]),
    cost: Money.USD,
    tokens: TokenUsage.Info,
  },
})
export type UsageRecorded = typeof UsageRecorded.Type

export const UsageUpdated = Event.ephemeral({
  type: "session.usage.updated",
  schema: {
    ...Base,
    cost: Money.USD,
    tokens: TokenUsage.Info,
  },
})
export type UsageUpdated = typeof UsageUpdated.Type

export const Deleted = Event.durable({
  type: "session.deleted",
  durable: {
    aggregate: "sessionID",
    version: 2,
  },
  schema: Base,
})
export type Deleted = typeof Deleted.Type

export const Forked = Event.durable({
  type: "session.forked",
  durable: {
    aggregate: "sessionID",
    version: 2,
  },
  schema: {
    ...Base,
    parentID: SessionID,
    boundary: SessionFork.Boundary,
    instructions: Instruction.Values.pipe(optional),
    instructionEntries: InstructionEntry.Snapshot.pipe(optional),
  },
})
export type Forked = typeof Forked.Type

const InboxRef = {
  ...Base,
  inboxID: SessionMessage.ID,
}

export const InboxDelivered = Event.durable({
  type: "session.inbox.delivered",
  ...options,
  schema: InboxRef,
})
export type InboxDelivered = typeof InboxDelivered.Type

export const InboxEnqueued = Event.durable({
  type: "session.inbox.enqueued",
  ...options,
  schema: {
    ...InboxRef,
    item: SessionInbox.Item,
  },
})
export type InboxEnqueued = typeof InboxEnqueued.Type

export const InboxCancelled = Event.durable({
  type: "session.inbox.cancelled",
  ...options,
  schema: InboxRef,
})
export type InboxCancelled = typeof InboxCancelled.Type

export const InboxDeliveryChanged = Event.durable({
  type: "session.inbox.delivery.changed",
  ...options,
  schema: { ...InboxRef, delivery: SessionInbox.Delivery },
})
export type InboxDeliveryChanged = typeof InboxDeliveryChanged.Type

export namespace Execution {
  export const Started = Event.durable({ type: "session.execution.started", ...options, schema: Base })
  export type Started = typeof Started.Type

  export const Succeeded = Event.durable({ type: "session.execution.succeeded", ...options, schema: Base })
  export type Succeeded = typeof Succeeded.Type

  export const Failed = Event.durable({
    type: "session.execution.failed",
    ...options,
    schema: { ...Base, error: SessionError.Error },
  })
  export type Failed = typeof Failed.Type

  export const Interrupted = Event.durable({
    type: "session.execution.interrupted",
    ...options,
    schema: { ...Base, reason: Schema.Literals(["user", "shutdown", "superseded", "inactivity"]) },
  })
  export type Interrupted = typeof Interrupted.Type
}

export const InstructionsUpdated = Event.durable({
  type: "session.instructions.updated",
  durable: {
    aggregate: "sessionID",
    version: 2,
  },
  schema: {
    ...Base,
    delta: Instruction.Delta,
    /**
     * The rendered chronological update shown to the model, frozen at emit time.
     * Absent for the initial baseline observation and for deltas that render empty.
     */
    text: Schema.String.pipe(optional),
  },
})
export type InstructionsUpdated = typeof InstructionsUpdated.Type

export const Synthetic = Event.durable({
  type: "session.synthetic",
  ...options,
  schema: {
    ...Base,
    text: Schema.String,
    description: Schema.String.pipe(optional),
    metadata: Schema.Record(Schema.String, Schema.Unknown).pipe(optional),
  },
})
export type Synthetic = typeof Synthetic.Type

export namespace Skill {
  export const Activated = Event.durable({
    type: "session.skill.activated",
    ...options,
    schema: {
      ...Base,
      id: SkillSchema.ID,
      name: SkillSchema.Name,
      text: Schema.String,
    },
  })
  export type Activated = typeof Activated.Type
}

export namespace Shell {
  export const Started = Event.durable({
    type: "session.shell.started",
    ...options,
    schema: {
      ...Base,
      shell: ShellSchema.Info,
    },
  })
  export type Started = typeof Started.Type

  export const Ended = Event.durable({
    type: "session.shell.ended",
    ...options,
    schema: {
      ...Base,
      shell: ShellSchema.Info,
      output: ShellSchema.Output,
    },
  })
  export type Ended = typeof Ended.Type
}

export namespace Step {
  export const Started = Event.durable({
    type: "session.step.started",
    ...options,
    schema: {
      ...Base,
      assistantMessageID: SessionMessage.ID,
      agent: Agent.ID,
      model: Model.Ref,
      snapshot: Snapshot.ID.pipe(optional),
    },
  })
  export type Started = typeof Started.Type

  /** Records the provider response-body boundary independently of tool settlement. */
  export const Streamed = Event.durable({
    type: "session.step.streamed",
    ...options,
    schema: {
      ...Base,
      assistantMessageID: SessionMessage.ID,
    },
  })
  export type Streamed = typeof Streamed.Type

  export const Ended = Event.durable({
    type: "session.step.ended",
    ...options,
    schema: {
      ...Base,
      assistantMessageID: SessionMessage.ID,
      finish: FinishReason,
      rawFinish: Schema.String.pipe(optional),
      providerState: SessionMessage.ProviderState.pipe(optional),
      cost: Money.USD,
      tokens: TokenUsage.Info,
      snapshot: Snapshot.ID.pipe(optional),
      files: Schema.Array(RelativePath).pipe(optional),
    },
  })
  export type Ended = typeof Ended.Type

  export const Failed = Event.durable({
    type: "session.step.failed",
    ...options,
    schema: {
      ...Base,
      assistantMessageID: SessionMessage.ID,
      error: SessionError.Error,
      finish: Schema.Literals(["content-filter"]).pipe(optional),
      rawFinish: Schema.String.pipe(optional),
      providerState: SessionMessage.ProviderState.pipe(optional),
      cost: Money.USD.pipe(optional),
      tokens: TokenUsage.Info.pipe(optional),
      snapshot: Snapshot.ID.pipe(optional),
      files: Schema.Array(RelativePath).pipe(optional),
    },
  })
  export type Failed = typeof Failed.Type
}

export namespace Text {
  export const Started = Event.durable({
    type: "session.text.started",
    ...options,
    schema: {
      ...Base,
      assistantMessageID: SessionMessage.ID,
      ordinal: NonNegativeInt,
    },
  })
  export type Started = typeof Started.Type

  // Stream fragments are live-only; Text.Ended is the replayable full-value boundary.
  export const Delta = Event.ephemeral({
    type: "session.text.delta",
    schema: {
      ...Base,
      assistantMessageID: SessionMessage.ID,
      ordinal: NonNegativeInt,
      delta: Schema.String,
    },
  })
  export type Delta = typeof Delta.Type

  export const Ended = Event.durable({
    type: "session.text.ended",
    ...options,
    schema: {
      ...Base,
      assistantMessageID: SessionMessage.ID,
      ordinal: NonNegativeInt,
      text: Schema.String,
      state: SessionMessage.ProviderState.pipe(optional),
    },
  })
  export type Ended = typeof Ended.Type
}

export namespace Reasoning {
  export const Started = Event.durable({
    type: "session.reasoning.started",
    ...options,
    schema: {
      ...Base,
      assistantMessageID: SessionMessage.ID,
      ordinal: NonNegativeInt,
      state: SessionMessage.ProviderState.pipe(optional),
    },
  })
  export type Started = typeof Started.Type

  // Stream fragments are live-only; Reasoning.Ended is the replayable full-value boundary.
  export const Delta = Event.ephemeral({
    type: "session.reasoning.delta",
    schema: {
      ...Base,
      assistantMessageID: SessionMessage.ID,
      ordinal: NonNegativeInt,
      delta: Schema.String,
    },
  })
  export type Delta = typeof Delta.Type

  export const Ended = Event.durable({
    type: "session.reasoning.ended",
    ...options,
    schema: {
      ...Base,
      assistantMessageID: SessionMessage.ID,
      ordinal: NonNegativeInt,
      text: Schema.String,
      state: SessionMessage.ProviderState.pipe(optional),
    },
  })
  export type Ended = typeof Ended.Type
}

export namespace Tool {
  const ToolBase = {
    ...Base,
    assistantMessageID: SessionMessage.ID,
    id: Schema.String,
  }

  export namespace Input {
    export const Started = Event.durable({
      type: "session.tool.input.started",
      ...options,
      schema: {
        ...ToolBase,
        name: Schema.String,
      },
    })
    export type Started = typeof Started.Type

    // Stream fragments are live-only; Input.Ended is the replayable raw-input boundary.
    export const Delta = Event.ephemeral({
      type: "session.tool.input.delta",
      schema: {
        ...ToolBase,
        delta: Schema.String,
      },
    })
    export type Delta = typeof Delta.Type

    export const Ended = Event.durable({
      type: "session.tool.input.ended",
      ...options,
      schema: {
        ...ToolBase,
        text: Schema.String,
      },
    })
    export type Ended = typeof Ended.Type
  }

  export const Called = Event.durable({
    type: "session.tool.called",
    ...options,
    schema: {
      ...ToolBase,
      input: Schema.Record(Schema.String, Schema.Unknown),
      executed: Schema.Boolean,
      state: SessionMessage.ProviderState.pipe(optional),
    },
  })
  export type Called = typeof Called.Type

  /** Live replacement metadata for a running tool. */
  export const Progress = Event.ephemeral({
    type: "session.tool.progress",
    schema: {
      ...ToolBase,
      metadata: Schema.Record(Schema.String, Schema.Json),
    },
  })
  export type Progress = typeof Progress.Type

  /** Canonical terminal success: one non-empty model representation plus optional UI metadata. */
  export const Success = Event.durable({
    type: "session.tool.success",
    durable: {
      aggregate: "sessionID",
      version: 2,
    },
    schema: {
      ...ToolBase,
      content: Schema.NonEmptyArray(Content),
      metadata: Schema.Record(Schema.String, Schema.Json).pipe(optional),
      executed: Schema.Boolean,
      resultState: SessionMessage.ProviderState.pipe(optional),
    },
  })
  export type Success = typeof Success.Type

  /**
   * Canonical terminal failure: one error plus the final bounded snapshot of
   * partial progress. The event is self-contained; projection never reaches
   * into ephemeral progress history.
   */
  export const Failed = Event.durable({
    type: "session.tool.failed",
    durable: {
      aggregate: "sessionID",
      version: 2,
    },
    schema: {
      ...ToolBase,
      error: SessionError.Error,
      content: Schema.NonEmptyArray(Content).pipe(optional),
      metadata: Schema.Record(Schema.String, Schema.Json).pipe(optional),
      executed: Schema.Boolean,
      resultState: SessionMessage.ProviderState.pipe(optional),
    },
  })
  export type Failed = typeof Failed.Type
}

export const RetryScheduled = Event.durable({
  type: "session.retry.scheduled",
  ...options,
  schema: {
    ...Base,
    assistantMessageID: SessionMessage.ID,
    attempt: PositiveInt,
    at: NonNegativeInt,
    error: SessionError.Error,
  },
})
export type RetryScheduled = typeof RetryScheduled.Type

export namespace Compaction {
  export const Started = Event.durable({
    type: "session.compaction.started",
    ...options,
    schema: {
      ...Base,
      reason: Schema.Literals(["auto", "manual"]),
      recent: Schema.String,
      inputID: SessionMessage.ID.pipe(optional),
    },
  })
  export type Started = typeof Started.Type

  export const Delta = Event.ephemeral({
    type: "session.compaction.delta",
    schema: {
      ...Base,
      text: Schema.String,
    },
  })
  export type Delta = typeof Delta.Type

  export const Ended = Event.durable({
    type: "session.compaction.ended",
    ...options,
    schema: {
      ...Base,
      reason: Started.data.fields.reason,
      model: SessionMessage.CompactionCompleted.fields.model,
      providerState: SessionMessage.CompactionCompleted.fields.providerState,
      providerContext: SessionMessage.CompactionCompleted.fields.providerContext,
      text: Schema.String,
      recent: Schema.String,
      // Repeats the internal `session.usage.recorded` figures: that event never reaches clients, and it
      // stays the accounting source for session totals and stats.
      cost: SessionMessage.CompactionCompleted.fields.cost,
      tokens: SessionMessage.CompactionCompleted.fields.tokens,
    },
  })
  export type Ended = typeof Ended.Type

  export const Failed = Event.durable({
    type: "session.compaction.failed",
    ...options,
    schema: {
      ...Base,
      reason: Started.data.fields.reason,
      error: SessionError.Error,
      inputID: SessionMessage.ID.pipe(optional),
      cost: SessionMessage.CompactionFailed.fields.cost,
      tokens: SessionMessage.CompactionFailed.fields.tokens,
    },
  })
  export type Failed = typeof Failed.Type
}

export namespace RevertEvent {
  export const Staged = Event.durable({
    type: "session.revert.staged",
    ...options,
    schema: { ...Base, revert: Revert },
  })
  export const Cleared = Event.durable({ type: "session.revert.cleared", ...options, schema: Base })
  export const Committed = Event.durable({
    type: "session.revert.committed",
    ...options,
    schema: { ...Base, to: SessionMessage.ID },
  })
}

export const Definitions = Event.inventory(
  Created,
  AgentSelected,
  ModelSelected,
  Moved,
  Renamed,
  PermissionsUpdated,
  Viewed,
  UsageUpdated,
  Deleted,
  Forked,
  InboxDelivered,
  InboxEnqueued,
  InboxCancelled,
  InboxDeliveryChanged,
  Execution.Started,
  Execution.Succeeded,
  Execution.Failed,
  Execution.Interrupted,
  InstructionsUpdated,
  Synthetic,
  Skill.Activated,
  Shell.Started,
  Shell.Ended,
  Step.Started,
  Step.Streamed,
  Step.Ended,
  Step.Failed,
  Text.Started,
  Text.Delta,
  Text.Ended,
  Reasoning.Started,
  Reasoning.Delta,
  Reasoning.Ended,
  Tool.Input.Started,
  Tool.Input.Delta,
  Tool.Input.Ended,
  Tool.Called,
  Tool.Progress,
  Tool.Success,
  Tool.Failed,
  RetryScheduled,
  Compaction.Started,
  Compaction.Delta,
  Compaction.Ended,
  Compaction.Failed,
  RevertEvent.Staged,
  RevertEvent.Cleared,
  RevertEvent.Committed,
)

// Internal and replay-only events are excluded from the public manifest.
export const DurableDefinitions = Event.inventory(
  ...Definitions.filter((definition) => definition.durability === "durable"),
  UsageRecorded,
  MessageContentUpdated,
)
export const EphemeralDefinitions = Event.inventory(
  ...Definitions.filter((definition) => definition.durability === "ephemeral"),
)

export const Durable = Schema.Union(DurableDefinitions, { mode: "oneOf" })
  .pipe(Schema.toTaggedUnion("type"))
  .annotate({ identifier: "Session.Event.Durable" })
export type DurableEvent = typeof Durable.Type

export const All = Schema.Union([Durable, ...EphemeralDefinitions], { mode: "oneOf" }).pipe(
  Schema.toTaggedUnion("type"),
)
export type Event = typeof All.Type
export type Type = Event["type"]
