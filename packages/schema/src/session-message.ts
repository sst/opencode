export * as SessionMessage from "./session-message.js"

import { Schema } from "effect"
import { SessionProviderContext } from "./session-provider-context.js"
import { optional } from "./schema.js"
import { Content } from "./tool.js"
import { Location } from "./location.js"
import { Model } from "./model.js"
import { Project } from "./project.js"
import { Prompt } from "./prompt.js"
import { DateTimeUtcFromMillis, PositiveInt, RelativePath, statics } from "./schema.js"
import { ascending } from "./identifier.js"
import { Event } from "./event.js"
import { Shell as ShellSchema } from "./shell.js"
import { FinishReason } from "./llm.js"
import { SessionError } from "./session-error.js"
import { Agent } from "./agent.js"
import { Skill as SkillSchema } from "./skill.js"
import { Money } from "./money.js"
import { Snapshot } from "./snapshot.js"
import { TokenUsage } from "./token-usage.js"

export const ID = Schema.String.check(Schema.isStartsWith("msg_")).pipe(
  Schema.brand("Session.Message.ID"),
  statics((schema) => ({
    create: () => schema.make("msg_" + ascending()),
    fromEvent: (eventID: Event.ID) => schema.make(eventID.replace(/^evt_/, "msg_")),
  })),
)
export type ID = typeof ID.Type

const Base = {
  id: ID,
  metadata: Schema.Record(Schema.String, Schema.Unknown).pipe(optional),
  time: Schema.Struct({ created: DateTimeUtcFromMillis }),
}

export const ProviderState = Schema.Record(Schema.String, Schema.Unknown).annotate({
  identifier: "Session.Message.ProviderState",
})
export type ProviderState = typeof ProviderState.Type

export interface AgentSelected extends Schema.Schema.Type<typeof AgentSelected> {}
export const AgentSelected = Schema.Struct({
  ...Base,
  type: Schema.tag("agent-switched"),
  agent: Agent.ID,
  previous: Agent.ID.pipe(optional),
}).annotate({ identifier: "Session.Message.AgentSelected" })

export interface ModelSelected extends Schema.Schema.Type<typeof ModelSelected> {}
export const ModelSelected = Schema.Struct({
  ...Base,
  type: Schema.tag("model-switched"),
  model: Model.Ref,
  previous: Model.Ref.pipe(optional),
}).annotate({ identifier: "Session.Message.ModelSelected" })

export interface LocationSwitched extends Schema.Schema.Type<typeof LocationSwitched> {}
export const LocationSwitched = Schema.Struct({
  ...Base,
  type: Schema.tag("location-switched"),
  location: Location.Ref,
  projectID: Project.ID.pipe(optional),
  subpath: RelativePath.pipe(optional),
  previous: Schema.Struct({
    location: Location.Ref,
    projectID: Project.ID.pipe(optional),
    subpath: RelativePath.pipe(optional),
  }).pipe(optional),
}).annotate({ identifier: "Session.Message.LocationSwitched" })

export interface User extends Schema.Schema.Type<typeof User> {}
export const User = Schema.Struct({
  ...Base,
  text: Prompt.fields.text,
  files: Prompt.fields.files,
  agents: Prompt.fields.agents,
  skills: Prompt.fields.skills,
  type: Schema.tag("user"),
}).annotate({ identifier: "Session.Message.User" })

export interface Synthetic extends Schema.Schema.Type<typeof Synthetic> {}
export const Synthetic = Schema.Struct({
  ...Base,
  text: Schema.String,
  description: Schema.String.pipe(optional),
  type: Schema.tag("synthetic"),
}).annotate({ identifier: "Session.Message.Synthetic" })

export interface System extends Schema.Schema.Type<typeof System> {}
export const System = Schema.Struct({
  ...Base,
  type: Schema.tag("system"),
  /** The model-facing update text, frozen at emit time. */
  text: Schema.String,
  /** A short human-readable summary for transcript display. */
  description: Schema.String.pipe(optional),
}).annotate({ identifier: "Session.Message.System" })

export interface Skill extends Schema.Schema.Type<typeof Skill> {}
export const Skill = Schema.Struct({
  ...Base,
  type: Schema.tag("skill"),
  skill: SkillSchema.ID,
  name: SkillSchema.Name,
  text: Schema.String,
}).annotate({ identifier: "Session.Message.Skill" })

export interface Shell extends Schema.Schema.Type<typeof Shell> {}
export const Shell = Schema.Struct({
  ...Base,
  type: Schema.tag("shell"),
  shellID: ShellSchema.ID,
  command: Schema.String,
  status: ShellSchema.Status,
  exit: Schema.Number.pipe(optional),
  output: ShellSchema.Output.pipe(optional),
  time: Schema.Struct({
    created: DateTimeUtcFromMillis,
    completed: DateTimeUtcFromMillis.pipe(optional),
  }),
}).annotate({ identifier: "Session.Message.Shell" })

export interface ToolStateStreaming extends Schema.Schema.Type<typeof ToolStateStreaming> {}
export const ToolStateStreaming = Schema.Struct({
  status: Schema.tag("streaming"),
  input: Schema.String,
}).annotate({ identifier: "Session.Message.ToolState.Streaming" })

export interface ToolStateRunning extends Schema.Schema.Type<typeof ToolStateRunning> {}
export const ToolStateRunning = Schema.Struct({
  status: Schema.tag("running"),
  input: Schema.Record(Schema.String, Schema.Unknown),
  metadata: Schema.Record(Schema.String, Schema.Json),
}).annotate({ identifier: "Session.Message.ToolState.Running" })

export interface ToolStateCompleted extends Schema.Schema.Type<typeof ToolStateCompleted> {}
export const ToolStateCompleted = Schema.Struct({
  status: Schema.tag("completed"),
  input: Schema.Record(Schema.String, Schema.Unknown),
  content: Schema.NonEmptyArray(Content),
  metadata: Schema.Record(Schema.String, Schema.Json).pipe(optional),
}).annotate({ identifier: "Session.Message.ToolState.Completed" })

export interface ToolStateError extends Schema.Schema.Type<typeof ToolStateError> {}
export const ToolStateError = Schema.Struct({
  status: Schema.tag("error"),
  input: Schema.Record(Schema.String, Schema.Unknown),
  error: SessionError.Error,
  content: Schema.NonEmptyArray(Content).pipe(optional),
  metadata: Schema.Record(Schema.String, Schema.Json).pipe(optional),
}).annotate({ identifier: "Session.Message.ToolState.Error" })

export const ToolState = Schema.Union([ToolStateStreaming, ToolStateRunning, ToolStateCompleted, ToolStateError]).pipe(
  Schema.toTaggedUnion("status"),
)
export type ToolState = ToolStateStreaming | ToolStateRunning | ToolStateCompleted | ToolStateError

export interface AssistantTool extends Schema.Schema.Type<typeof AssistantTool> {}
export const AssistantTool = Schema.Struct({
  type: Schema.tag("tool"),
  id: Schema.String,
  name: Schema.String,
  executed: Schema.Boolean.pipe(optional),
  providerState: ProviderState.pipe(optional),
  providerResultState: ProviderState.pipe(optional),
  state: ToolState,
  time: Schema.Struct({
    created: DateTimeUtcFromMillis,
    ran: DateTimeUtcFromMillis.pipe(optional),
    completed: DateTimeUtcFromMillis.pipe(optional),
  }),
}).annotate({ identifier: "Session.Message.Assistant.Tool" })

export interface AssistantText extends Schema.Schema.Type<typeof AssistantText> {}
export const AssistantText = Schema.Struct({
  type: Schema.tag("text"),
  text: Schema.String,
  state: ProviderState.pipe(optional),
}).annotate({ identifier: "Session.Message.Assistant.Text" })

export interface AssistantReasoning extends Schema.Schema.Type<typeof AssistantReasoning> {}
export const AssistantReasoning = Schema.Struct({
  type: Schema.tag("reasoning"),
  text: Schema.String,
  state: ProviderState.pipe(optional),
  time: Schema.Struct({
    created: DateTimeUtcFromMillis,
    completed: DateTimeUtcFromMillis.pipe(optional),
  }).pipe(optional),
}).annotate({ identifier: "Session.Message.Assistant.Reasoning" })

export const AssistantContent = Schema.Union([AssistantText, AssistantReasoning, AssistantTool]).pipe(
  Schema.toTaggedUnion("type"),
)
export type AssistantContent = AssistantText | AssistantReasoning | AssistantTool

export const AssistantContentEncoded = Schema.toEncoded(AssistantContent).annotate({
  identifier: "Session.Message.AssistantContent.Encoded",
})
export type AssistantContentEncoded = typeof AssistantContentEncoded.Type

export interface AssistantRetry extends Schema.Schema.Type<typeof AssistantRetry> {}
export const AssistantRetry = Schema.Struct({
  attempt: PositiveInt,
  at: DateTimeUtcFromMillis,
  error: SessionError.Error,
}).annotate({ identifier: "Session.Message.Assistant.Retry" })

export interface Assistant extends Schema.Schema.Type<typeof Assistant> {}
export const Assistant = Schema.Struct({
  ...Base,
  type: Schema.tag("assistant"),
  agent: Agent.ID,
  model: Model.Ref,
  content: AssistantContent.pipe(Schema.Array),
  snapshot: Schema.Struct({
    start: Snapshot.ID.pipe(optional),
    end: Snapshot.ID.pipe(optional),
    files: Schema.Array(RelativePath).pipe(optional),
  }).pipe(optional),
  finish: FinishReason.pipe(optional),
  rawFinish: Schema.String.pipe(optional),
  providerState: ProviderState.pipe(optional),
  cost: Money.USD.pipe(optional),
  tokens: TokenUsage.Info.pipe(optional),
  error: SessionError.Error.pipe(optional),
  retry: AssistantRetry.pipe(optional),
  time: Schema.Struct({
    created: DateTimeUtcFromMillis,
    /** When the provider response body ended, before tool settlement. */
    streamed: DateTimeUtcFromMillis.pipe(optional),
    completed: DateTimeUtcFromMillis.pipe(optional),
  }),
}).annotate({ identifier: "Session.Message.Assistant" })

const CompactionBase = { type: Schema.tag("compaction"), ...Base }

/** Usage of the compaction request itself, not the size of the resulting context. */
const CompactionUsage = {
  cost: Money.USD.pipe(optional),
  tokens: TokenUsage.Info.pipe(optional),
}

export interface CompactionRunning extends Schema.Schema.Type<typeof CompactionRunning> {}
export const CompactionRunning = Schema.Struct({
  ...CompactionBase,
  status: Schema.tag("running"),
  reason: Schema.Literals(["auto", "manual"]),
  summary: Schema.String,
  recent: Schema.String,
}).annotate({ identifier: "Session.Message.Compaction.Running" })

export interface CompactionCompleted extends Schema.Schema.Type<typeof CompactionCompleted> {}
export const CompactionCompleted = Schema.Struct({
  ...CompactionBase,
  status: Schema.tag("completed"),
  reason: Schema.Literals(["auto", "manual"]),
  model: Model.Ref.pipe(optional),
  providerState: ProviderState.pipe(optional),
  summary: Schema.String,
  recent: Schema.String,
  providerContext: SessionProviderContext.Info.pipe(optional),
  ...CompactionUsage,
}).annotate({ identifier: "Session.Message.Compaction.Completed" })

export interface CompactionFailed extends Schema.Schema.Type<typeof CompactionFailed> {}
export const CompactionFailed = Schema.Struct({
  ...CompactionBase,
  status: Schema.tag("failed"),
  reason: Schema.Literals(["auto", "manual"]),
  error: SessionError.Error,
  ...CompactionUsage,
}).annotate({ identifier: "Session.Message.Compaction.Failed" })

export const Compaction = Schema.Union([CompactionRunning, CompactionCompleted, CompactionFailed]).pipe(
  Schema.toTaggedUnion("status"),
  Schema.annotate({ identifier: "Session.Message.Compaction" }),
)
export type Compaction = CompactionRunning | CompactionCompleted | CompactionFailed

/**
 * Marks the Session going idle: every step since the previous marker belongs to
 * one turn, including prompts steered in while it was busy. A shutdown does not
 * record one, since the resumed execution continues the same turn.
 */
export interface Idle extends Schema.Schema.Type<typeof Idle> {}
export const Idle = Schema.Struct({
  ...Base,
  type: Schema.tag("idle"),
  outcome: Schema.Literals(["succeeded", "failed", "interrupted"]),
}).annotate({ identifier: "Session.Message.Idle" })

export const Info = Schema.Union([
  AgentSelected,
  ModelSelected,
  LocationSwitched,
  User,
  Synthetic,
  System,
  Skill,
  Shell,
  Assistant,
  Compaction,
  Idle,
]).annotate({ identifier: "Session.Message.Info" })
export type Info =
  | AgentSelected
  | ModelSelected
  | LocationSwitched
  | User
  | Synthetic
  | System
  | Skill
  | Shell
  | Assistant
  | Compaction
  | Idle
export type Type = Info["type"]
