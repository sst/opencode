export * as SessionV1 from "./session"

import { Effect, Schema, Types } from "effect"
import { define, inventory } from "../event"
import { FileDiff } from "../file-diff"
import { Project } from "../project"
import { Provider } from "../provider"
import { Model } from "../model"
import { NonNegativeInt, optional, statics } from "../schema"
import { ascending } from "../identifier"
import { SessionID } from "../session-id"
import { WorkspaceID } from "../workspace-id"
import { PermissionV1 } from "./permission"
import { SessionCompaction } from "../session-compaction"

const Timestamp = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))

export const MessageID = Schema.String.check(Schema.isStartsWith("msg")).pipe(
  Schema.brand("MessageID"),
  statics((schema) => ({ ascending: (id?: string) => schema.make(id ?? "msg_" + ascending()) })),
)
export type MessageID = typeof MessageID.Type

export const PartID = Schema.String.check(Schema.isStartsWith("prt")).pipe(
  Schema.brand("PartID"),
  statics((schema) => ({ ascending: (id?: string) => schema.make(id ?? "prt_" + ascending()) })),
)
export type PartID = typeof PartID.Type

const namedError = <Name extends string, Fields extends Schema.Struct.Fields>(name: Name, fields: Fields) => {
  const schema = Schema.Struct({ name: Schema.Literal(name), data: Schema.Struct(fields) }).annotate({
    identifier: name,
  })
  return { Schema: schema, EffectSchema: schema }
}

export const OutputLengthError = namedError("MessageOutputLengthError", {})

export const AuthError = namedError("ProviderAuthError", {
  providerID: Schema.String,
  message: Schema.String,
})

export const AbortedError = namedError("MessageAbortedError", { message: Schema.String })
export const StructuredOutputError = namedError("StructuredOutputError", {
  message: Schema.String,
  retries: NonNegativeInt,
})
export const APIError = namedError("APIError", {
  message: Schema.String,
  statusCode: Schema.optional(NonNegativeInt),
  isRetryable: Schema.Boolean,
  responseHeaders: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  responseBody: Schema.optional(Schema.String),
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.String)),
})
export type APIError = Schema.Schema.Type<typeof APIError.Schema>
export const ContextOverflowError = namedError("ContextOverflowError", {
  message: Schema.String,
  responseBody: Schema.optional(Schema.String),
})
export const ContentFilterError = namedError("ContentFilterError", {
  message: Schema.String,
})

export class OutputFormatText extends Schema.Class<OutputFormatText>("OutputFormatText")({
  type: Schema.Literal("text"),
}) {}

export class OutputFormatJsonSchema extends Schema.Class<OutputFormatJsonSchema>("OutputFormatJsonSchema")({
  type: Schema.Literal("json_schema"),
  schema: Schema.Record(Schema.String, Schema.Any).annotate({ identifier: "JSONSchema" }),
  retryCount: NonNegativeInt.pipe(Schema.optional, Schema.withDecodingDefault(Effect.succeed(2))),
}) {}

export const Format = Schema.Union([OutputFormatText, OutputFormatJsonSchema]).annotate({
  discriminator: "type",
  identifier: "OutputFormat",
})
export type OutputFormat = Schema.Schema.Type<typeof Format>

const partBase = {
  id: PartID,
  sessionID: SessionID,
  messageID: MessageID,
}

export const SnapshotPart = Schema.Struct({
  ...partBase,
  type: Schema.Literal("snapshot"),
  snapshot: Schema.String,
}).annotate({ identifier: "SnapshotPart" })
export type SnapshotPart = Types.DeepMutable<Schema.Schema.Type<typeof SnapshotPart>>

export const PatchPart = Schema.Struct({
  ...partBase,
  type: Schema.Literal("patch"),
  hash: Schema.String,
  files: Schema.Array(Schema.String),
}).annotate({ identifier: "PatchPart" })
export type PatchPart = Types.DeepMutable<Schema.Schema.Type<typeof PatchPart>>

export const TextPart = Schema.Struct({
  ...partBase,
  type: Schema.Literal("text"),
  text: Schema.String,
  synthetic: Schema.optional(Schema.Boolean),
  ignored: Schema.optional(Schema.Boolean),
  time: Schema.optional(
    Schema.Struct({
      start: NonNegativeInt,
      end: Schema.optional(NonNegativeInt),
    }),
  ),
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Any)),
}).annotate({ identifier: "TextPart" })
export type TextPart = Types.DeepMutable<Schema.Schema.Type<typeof TextPart>>

export const ReasoningPart = Schema.Struct({
  ...partBase,
  type: Schema.Literal("reasoning"),
  text: Schema.String,
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Any)),
  time: Schema.Struct({
    start: NonNegativeInt,
    end: Schema.optional(NonNegativeInt),
  }),
}).annotate({ identifier: "ReasoningPart" })
export type ReasoningPart = Types.DeepMutable<Schema.Schema.Type<typeof ReasoningPart>>

const filePartSourceBase = {
  text: Schema.Struct({
    value: Schema.String,
    start: Schema.Finite,
    end: Schema.Finite,
  }).annotate({ identifier: "FilePartSourceText" }),
}

export const Range = Schema.Struct({
  start: Schema.Struct({ line: NonNegativeInt, character: NonNegativeInt }),
  end: Schema.Struct({ line: NonNegativeInt, character: NonNegativeInt }),
}).annotate({ identifier: "Range" })
export type Range = typeof Range.Type

export const FileSource = Schema.Struct({
  ...filePartSourceBase,
  type: Schema.Literal("file"),
  path: Schema.String,
}).annotate({ identifier: "FileSource" })

export const SymbolSource = Schema.Struct({
  ...filePartSourceBase,
  type: Schema.Literal("symbol"),
  path: Schema.String,
  range: Range,
  name: Schema.String,
  kind: NonNegativeInt,
}).annotate({ identifier: "SymbolSource" })

export const ResourceSource = Schema.Struct({
  ...filePartSourceBase,
  type: Schema.Literal("resource"),
  clientName: Schema.String,
  uri: Schema.String,
}).annotate({ identifier: "ResourceSource" })

export const FilePartSource = Schema.Union([FileSource, SymbolSource, ResourceSource]).annotate({
  discriminator: "type",
  identifier: "FilePartSource",
})

export const FilePart = Schema.Struct({
  ...partBase,
  type: Schema.Literal("file"),
  mime: Schema.String,
  filename: Schema.optional(Schema.String),
  url: Schema.String,
  source: Schema.optional(FilePartSource),
}).annotate({ identifier: "FilePart" })
export type FilePart = Types.DeepMutable<Schema.Schema.Type<typeof FilePart>>

export const AgentPart = Schema.Struct({
  ...partBase,
  type: Schema.Literal("agent"),
  name: Schema.String,
  source: Schema.optional(
    Schema.Struct({
      value: Schema.String,
      start: NonNegativeInt,
      end: NonNegativeInt,
    }),
  ),
}).annotate({ identifier: "AgentPart" })
export type AgentPart = Types.DeepMutable<Schema.Schema.Type<typeof AgentPart>>

export const CompactionPart = Schema.Struct({
  ...partBase,
  type: Schema.Literal("compaction"),
  auto: Schema.Boolean,
  overflow: Schema.optional(Schema.Boolean),
  tail_start_id: Schema.optional(MessageID),
  diagnostics: SessionCompaction.Diagnostics.pipe(optional),
}).annotate({ identifier: "CompactionPart" })
export type CompactionPart = Types.DeepMutable<Schema.Schema.Type<typeof CompactionPart>>

export const SubtaskPart = Schema.Struct({
  ...partBase,
  type: Schema.Literal("subtask"),
  prompt: Schema.String,
  description: Schema.String,
  agent: Schema.String,
  model: Schema.optional(
    Schema.Struct({
      providerID: Provider.ID,
      modelID: Model.ID,
    }),
  ),
  command: Schema.optional(Schema.String),
}).annotate({ identifier: "SubtaskPart" })
export type SubtaskPart = Types.DeepMutable<Schema.Schema.Type<typeof SubtaskPart>>

export const RetryPart = Schema.Struct({
  ...partBase,
  type: Schema.Literal("retry"),
  attempt: NonNegativeInt,
  error: APIError.EffectSchema,
  time: Schema.Struct({
    created: NonNegativeInt,
  }),
}).annotate({ identifier: "RetryPart" })
export type RetryPart = Omit<Types.DeepMutable<Schema.Schema.Type<typeof RetryPart>>, "error"> & {
  error: APIError
}

export const StepStartPart = Schema.Struct({
  ...partBase,
  type: Schema.Literal("step-start"),
  snapshot: Schema.optional(Schema.String),
}).annotate({ identifier: "StepStartPart" })
export type StepStartPart = Types.DeepMutable<Schema.Schema.Type<typeof StepStartPart>>

export const StepFinishPart = Schema.Struct({
  ...partBase,
  type: Schema.Literal("step-finish"),
  reason: Schema.String,
  snapshot: Schema.optional(Schema.String),
  cost: Schema.Finite,
  tokens: Schema.Struct({
    total: Schema.optional(Schema.Finite),
    input: Schema.Finite,
    output: Schema.Finite,
    reasoning: Schema.Finite,
    cache: Schema.Struct({
      read: Schema.Finite,
      write: Schema.Finite,
    }),
  }),
}).annotate({ identifier: "StepFinishPart" })
export type StepFinishPart = Types.DeepMutable<Schema.Schema.Type<typeof StepFinishPart>>

export const ToolStatePending = Schema.Struct({
  status: Schema.Literal("pending"),
  input: Schema.Record(Schema.String, Schema.Any),
  raw: Schema.String,
}).annotate({ identifier: "ToolStatePending" })
export type ToolStatePending = Types.DeepMutable<Schema.Schema.Type<typeof ToolStatePending>>

export const ToolStateRunning = Schema.Struct({
  status: Schema.Literal("running"),
  input: Schema.Record(Schema.String, Schema.Any),
  title: Schema.optional(Schema.String),
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Any)),
  time: Schema.Struct({
    start: NonNegativeInt,
  }),
}).annotate({ identifier: "ToolStateRunning" })
export type ToolStateRunning = Types.DeepMutable<Schema.Schema.Type<typeof ToolStateRunning>>

export const ToolStateCompleted = Schema.Struct({
  status: Schema.Literal("completed"),
  input: Schema.Record(Schema.String, Schema.Any),
  output: Schema.String,
  title: Schema.String,
  metadata: Schema.Record(Schema.String, Schema.Any),
  time: Schema.Struct({
    start: NonNegativeInt,
    end: NonNegativeInt,
    compacted: Schema.optional(NonNegativeInt),
  }),
  attachments: Schema.optional(Schema.Array(FilePart)),
}).annotate({ identifier: "ToolStateCompleted" })
export type ToolStateCompleted = Types.DeepMutable<Schema.Schema.Type<typeof ToolStateCompleted>>

export const ToolStateError = Schema.Struct({
  status: Schema.Literal("error"),
  input: Schema.Record(Schema.String, Schema.Any),
  error: Schema.String,
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Any)),
  time: Schema.Struct({
    start: NonNegativeInt,
    end: NonNegativeInt,
  }),
}).annotate({ identifier: "ToolStateError" })
export type ToolStateError = Types.DeepMutable<Schema.Schema.Type<typeof ToolStateError>>

export const ToolState = Schema.Union([
  ToolStatePending,
  ToolStateRunning,
  ToolStateCompleted,
  ToolStateError,
]).annotate({
  discriminator: "status",
  identifier: "ToolState",
})
export type ToolState = ToolStatePending | ToolStateRunning | ToolStateCompleted | ToolStateError

export const ToolPart = Schema.Struct({
  ...partBase,
  type: Schema.Literal("tool"),
  callID: Schema.String,
  tool: Schema.String,
  state: ToolState,
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Any)),
}).annotate({ identifier: "ToolPart" })
export type ToolPart = Omit<Types.DeepMutable<Schema.Schema.Type<typeof ToolPart>>, "state"> & {
  state: ToolState
}

const messageBase = {
  id: MessageID,
  sessionID: partBase.sessionID,
}

export const User = Schema.Struct({
  ...messageBase,
  role: Schema.Literal("user"),
  time: Schema.Struct({
    created: Timestamp,
  }),
  format: Schema.optional(Format),
  summary: Schema.optional(
    Schema.Struct({
      title: Schema.optional(Schema.String),
      body: Schema.optional(Schema.String),
      diffs: Schema.Array(FileDiff.Info),
    }),
  ),
  agent: Schema.String,
  model: Schema.Struct({
    providerID: Provider.ID,
    modelID: Model.ID,
    variant: Schema.optional(Schema.String),
  }),
  system: Schema.optional(Schema.String),
  tools: Schema.optional(Schema.Record(Schema.String, Schema.Boolean)),
}).annotate({ identifier: "UserMessage" })
export type User = Types.DeepMutable<Schema.Schema.Type<typeof User>>

export const Part = Schema.Union([
  TextPart,
  SubtaskPart,
  ReasoningPart,
  FilePart,
  ToolPart,
  StepStartPart,
  StepFinishPart,
  SnapshotPart,
  PatchPart,
  AgentPart,
  RetryPart,
  CompactionPart,
]).annotate({ discriminator: "type", identifier: "Part" })
export type Part =
  | TextPart
  | SubtaskPart
  | ReasoningPart
  | FilePart
  | ToolPart
  | StepStartPart
  | StepFinishPart
  | SnapshotPart
  | PatchPart
  | AgentPart
  | RetryPart
  | CompactionPart

const AssistantErrorSchema = Schema.Union([
  AuthError.EffectSchema,
  namedError("UnknownError", { message: Schema.String, ref: Schema.optional(Schema.String) }).EffectSchema,
  OutputLengthError.EffectSchema,
  AbortedError.EffectSchema,
  StructuredOutputError.EffectSchema,
  ContextOverflowError.EffectSchema,
  ContentFilterError.EffectSchema,
  APIError.EffectSchema,
]).annotate({ discriminator: "name" })
type AssistantError = Schema.Schema.Type<typeof AssistantErrorSchema>

export const TextPartInput = Schema.Struct({
  id: Schema.optional(PartID),
  type: Schema.Literal("text"),
  text: Schema.String,
  synthetic: Schema.optional(Schema.Boolean),
  ignored: Schema.optional(Schema.Boolean),
  time: Schema.optional(
    Schema.Struct({
      start: NonNegativeInt,
      end: Schema.optional(NonNegativeInt),
    }),
  ),
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Any)),
}).annotate({ identifier: "TextPartInput" })
export type TextPartInput = Types.DeepMutable<Schema.Schema.Type<typeof TextPartInput>>

export const FilePartInput = Schema.Struct({
  id: Schema.optional(PartID),
  type: Schema.Literal("file"),
  mime: Schema.String,
  filename: Schema.optional(Schema.String),
  url: Schema.String,
  source: Schema.optional(FilePartSource),
}).annotate({ identifier: "FilePartInput" })
export type FilePartInput = Types.DeepMutable<Schema.Schema.Type<typeof FilePartInput>>

export const AgentPartInput = Schema.Struct({
  id: Schema.optional(PartID),
  type: Schema.Literal("agent"),
  name: Schema.String,
  source: Schema.optional(
    Schema.Struct({
      value: Schema.String,
      start: NonNegativeInt,
      end: NonNegativeInt,
    }),
  ),
}).annotate({ identifier: "AgentPartInput" })
export type AgentPartInput = Types.DeepMutable<Schema.Schema.Type<typeof AgentPartInput>>

export const SubtaskPartInput = Schema.Struct({
  id: Schema.optional(PartID),
  type: Schema.Literal("subtask"),
  prompt: Schema.String,
  description: Schema.String,
  agent: Schema.String,
  model: Schema.optional(
    Schema.Struct({
      providerID: Provider.ID,
      modelID: Model.ID,
    }),
  ),
  command: Schema.optional(Schema.String),
}).annotate({ identifier: "SubtaskPartInput" })
export type SubtaskPartInput = Types.DeepMutable<Schema.Schema.Type<typeof SubtaskPartInput>>

export const Assistant = Schema.Struct({
  ...messageBase,
  role: Schema.Literal("assistant"),
  time: Schema.Struct({
    created: NonNegativeInt,
    completed: Schema.optional(NonNegativeInt),
  }),
  error: Schema.optional(AssistantErrorSchema),
  parentID: MessageID,
  modelID: Model.ID,
  providerID: Provider.ID,
  mode: Schema.String,
  agent: Schema.String,
  path: Schema.Struct({
    cwd: Schema.String,
    root: Schema.String,
  }),
  summary: Schema.optional(Schema.Boolean),
  cost: Schema.Finite,
  tokens: Schema.Struct({
    total: Schema.optional(Schema.Finite),
    input: Schema.Finite,
    output: Schema.Finite,
    reasoning: Schema.Finite,
    cache: Schema.Struct({
      read: Schema.Finite,
      write: Schema.Finite,
    }),
  }),
  structured: Schema.optional(Schema.Any),
  variant: Schema.optional(Schema.String),
  finish: Schema.optional(Schema.String),
}).annotate({ identifier: "AssistantMessage" })
export type Assistant = Omit<Types.DeepMutable<Schema.Schema.Type<typeof Assistant>>, "error"> & {
  error?: AssistantError
}

export const Info = Schema.Union([User, Assistant]).annotate({ discriminator: "role", identifier: "Message" })
export type Info = User | Assistant

export const WithParts = Schema.Struct({
  info: Info,
  parts: Schema.Array(Part),
})
export type WithParts = {
  info: Info
  parts: Part[]
}

const options = {
  durable: {
    aggregate: "sessionID",
    version: 1,
  },
} as const

const SessionSummary = Schema.Struct({
  additions: Schema.Finite,
  deletions: Schema.Finite,
  files: Schema.Finite,
  diffs: optional(Schema.Array(FileDiff.Info)),
})

const SessionTokens = Schema.Struct({
  input: Schema.Finite,
  output: Schema.Finite,
  reasoning: Schema.Finite,
  cache: Schema.Struct({
    read: Schema.Finite,
    write: Schema.Finite,
  }),
})

const SessionShare = Schema.Struct({
  url: Schema.String,
})

const SessionRevert = Schema.Struct({
  messageID: MessageID,
  partID: optional(PartID),
  snapshot: optional(Schema.String),
  diff: optional(Schema.String),
})

const SessionModel = Schema.Struct({
  id: Model.ID,
  providerID: Provider.ID,
  variant: optional(Schema.String),
})

export const SessionInfo = Schema.Struct({
  id: SessionID,
  slug: Schema.String,
  projectID: Project.ID,
  workspaceID: optional(WorkspaceID),
  directory: Schema.String,
  path: optional(Schema.String),
  parentID: optional(SessionID),
  summary: optional(SessionSummary),
  cost: optional(Schema.Finite),
  tokens: optional(SessionTokens),
  share: optional(SessionShare),
  title: Schema.String,
  agent: optional(Schema.String),
  model: optional(SessionModel),
  version: Schema.String,
  metadata: optional(Schema.Record(Schema.String, Schema.Any)),
  time: Schema.Struct({
    created: NonNegativeInt,
    updated: NonNegativeInt,
    compacting: optional(NonNegativeInt),
    archived: optional(Schema.Finite),
  }),
  permission: optional(PermissionV1.Ruleset),
  revert: optional(SessionRevert),
}).annotate({ identifier: "Session" })
export type SessionInfo = typeof SessionInfo.Type

const events = {
  Created: define({
    type: "session.created",
    ...options,
    schema: {
      sessionID: SessionID,
      info: SessionInfo,
    },
  }),
  Updated: define({
    type: "session.updated",
    ...options,
    schema: {
      sessionID: SessionID,
      info: SessionInfo,
    },
  }),
  Deleted: define({
    type: "session.deleted",
    ...options,
    schema: {
      sessionID: SessionID,
      info: SessionInfo,
    },
  }),
  MessageUpdated: define({
    type: "message.updated",
    ...options,
    schema: {
      sessionID: SessionID,
      info: Info,
    },
  }),
  MessageRemoved: define({
    type: "message.removed",
    ...options,
    schema: {
      sessionID: SessionID,
      messageID: MessageID,
    },
  }),
  PartUpdated: define({
    type: "message.part.updated",
    ...options,
    schema: {
      sessionID: SessionID,
      part: Part,
      time: Schema.Finite,
    },
  }),
  PartRemoved: define({
    type: "message.part.removed",
    ...options,
    schema: {
      sessionID: SessionID,
      messageID: MessageID,
      partID: PartID,
    },
  }),
}

export const PartDelta = define({
  type: "message.part.delta",
  schema: {
    sessionID: SessionID,
    messageID: MessageID,
    partID: PartID,
    field: Schema.String,
    delta: Schema.String,
  },
})

export const Diff = define({
  type: "session.diff",
  schema: {
    sessionID: SessionID,
    diff: Schema.Array(FileDiff.Info),
  },
})

export const Error = define({
  type: "session.error",
  schema: {
    sessionID: Schema.optional(SessionID),
    error: Assistant.fields.error,
  },
})

export const Event = {
  ...events,
  PartDelta,
  Diff,
  Error,
  Definitions: inventory(
    events.Created,
    events.Updated,
    events.Deleted,
    events.MessageUpdated,
    events.MessageRemoved,
    events.PartUpdated,
    events.PartRemoved,
    PartDelta,
    Diff,
    Error,
  ),
}
