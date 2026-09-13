import { SessionMessage } from "@opencode/schema/session-message"
import { SessionTransfer } from "@opencode/schema/session-transfer"
import { SessionInbox } from "@opencode/schema/session-inbox"
import { PromptInput } from "@opencode/schema/prompt-input"
import { Session } from "@opencode/schema/session"
import { SessionStats } from "@opencode/schema/session-stats"
import { InstructionEntry } from "@opencode/schema/instruction-entry"
import { Project } from "@opencode/schema/project"
import { AbsolutePath, NonNegativeInt, PositiveInt, RelativePath, statics } from "@opencode/schema/schema"
import { Event } from "@opencode/schema/event"
import { Workspace } from "@opencode/schema/workspace"
import { Context, Effect, Encoding, Result, Schema, SchemaGetter, Struct } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import {
  ConflictError,
  CommandExecutionError,
  CommandNotFoundError,
  InvalidCursorError,
  InvalidRequestError,
  MessageNotFoundError,
  ServiceUnavailableError,
  SessionBusyError,
  SessionNotFoundError,
  SkillNotFoundError,
  UnknownError,
} from "../errors.js"
import { Agent } from "@opencode/schema/agent"
import { Skill } from "@opencode/schema/skill"
import { Model } from "@opencode/schema/model"
import { Permission } from "@opencode/schema/permission"
import { Location } from "@opencode/schema/location"
import { SessionEvent } from "@opencode/schema/session-event"
import { EventLog } from "@opencode/schema/event-log"
import { FileDiff } from "@opencode/schema/file-diff"

const ParentIDFilter = Schema.Union([
  Session.ID,
  Schema.Null.pipe(
    Schema.encodeTo(Schema.Literal("null"), {
      decode: SchemaGetter.transform(() => null),
      encode: SchemaGetter.transform(() => "null" as const),
    }),
  ),
]).annotate({
  description: "Filter by parent session. Use null to return only root sessions.",
})

const SessionsQueryFields = {
  workspace: Workspace.ID.pipe(Schema.optional),
  limit: Schema.NumberFromString.pipe(Schema.decodeTo(PositiveInt), Schema.optional).annotate({
    description: "Maximum number of sessions to return. Defaults to the newest 50 sessions.",
  }),
  order: Schema.optional(Schema.Union([Schema.Literal("asc"), Schema.Literal("desc")])).annotate({
    description: "Session order for the first page. Use desc for newest first or asc for oldest first.",
  }),
  search: Schema.optional(Schema.String),
  parentID: ParentIDFilter.pipe(Schema.optional),
}

const SessionsDirectoryQuery = Schema.Struct({
  ...SessionsQueryFields,
  directory: AbsolutePath,
})

const SessionsProjectQuery = Schema.Struct({
  ...SessionsQueryFields,
  project: Project.ID,
  subpath: RelativePath.pipe(Schema.optional),
})

const SessionsAllQuery = Schema.Struct(SessionsQueryFields)

const withCursor = <Fields extends Schema.Struct.Fields>(schema: Schema.Struct<Fields>) =>
  schema.mapFields((fields) => ({
    ...Struct.omit(fields, ["limit"]),
    anchor: Session.ListAnchor,
  }))

const SessionsCursorInput = Schema.Union([
  withCursor(SessionsDirectoryQuery),
  withCursor(SessionsProjectQuery),
  withCursor(SessionsAllQuery),
])
const SessionsCursorJson = Schema.fromJsonString(SessionsCursorInput)
const encodeSessionsCursor = Schema.encodeSync(SessionsCursorJson)
const decodeSessionsCursor = Schema.decodeUnknownEffect(SessionsCursorJson)
const invalidCursor = "Invalid cursor" as const

export const SessionsCursor = Schema.String.pipe(
  Schema.brand("SessionsCursor"),
  statics((schema) => {
    const make = schema.make.bind(schema)
    return {
      make: (input: typeof SessionsCursorInput.Type) => make(Encoding.encodeBase64Url(encodeSessionsCursor(input))),
      parse: (input: string) =>
        Effect.suspend(() => {
          const result = Encoding.decodeBase64UrlString(input)
          return Result.isFailure(result)
            ? Effect.fail(invalidCursor)
            : decodeSessionsCursor(result.success).pipe(Effect.mapError(() => invalidCursor))
        }),
    }
  }),
)
export type SessionsCursor = typeof SessionsCursor.Type

const SessionActive = Schema.Struct({
  type: Schema.Literal("running"),
}).annotate({ identifier: "SessionActive" })

const BooleanFromString = Schema.Literals(["true", "false"]).pipe(
  Schema.decodeTo(Schema.Boolean, {
    decode: SchemaGetter.transform((value) => value === "true"),
    encode: SchemaGetter.transform((value): "true" | "false" => (value ? "true" : "false")),
  }),
)

const SessionsQueryCursor = SessionsCursor.annotate({
  description: "Opaque pagination cursor returned as cursor.previous or cursor.next in the previous response.",
})

export const SessionsQuery = Schema.Struct({
  ...SessionsQueryFields,
  directory: AbsolutePath.pipe(Schema.optional),
  project: Project.ID.pipe(Schema.optional),
  subpath: RelativePath.pipe(Schema.optional),
  cursor: SessionsQueryCursor.pipe(Schema.optional),
}).annotate({ identifier: "SessionsQuery" })

export const makeSessionGroup = <I extends HttpApiMiddleware.AnyId, S>(sessionLocationMiddleware: Context.Key<I, S>) =>
  HttpApiGroup.make("server.session")
    .add(
      HttpApiEndpoint.get("session.list", "/api/session", {
        query: SessionsQuery,
        success: Schema.Struct({
          data: Schema.Array(Session.Info),
          cursor: Schema.Struct({
            previous: SessionsCursor.pipe(Schema.optional),
            next: SessionsCursor.pipe(Schema.optional),
          }),
        }).annotate({ identifier: "SessionsResponse" }),
        error: [InvalidCursorError, InvalidRequestError],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "v2.session.list",
          summary: "List sessions",
          description:
            "Retrieve sessions in the requested order. Items keep that order across pages; use cursor.next or cursor.previous to move through the ordered list.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.get("session.stats", "/api/session/stats", {
        query: Schema.Struct({
          from: Schema.NumberFromString.pipe(Schema.optional),
          to: Schema.NumberFromString.pipe(Schema.optional),
          project: Project.ID.pipe(Schema.optional),
          timezone: Schema.String.pipe(Schema.optional),
          tools: SessionStats.ToolMode.pipe(Schema.optional),
        }),
        success: Schema.Struct({ data: SessionStats.Info }),
        error: InvalidRequestError,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "v2.session.stats",
          summary: "Get session statistics",
          description: "Aggregate local session activity, usage, and tool reliability for a time range.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.post("session.create", "/api/session", {
        payload: Schema.Struct({
          id: Session.ID.pipe(Schema.optional),
          title: Schema.String.pipe(Schema.optional),
          agent: Agent.ID.pipe(Schema.optional),
          model: Model.Ref.pipe(Schema.optional),
          location: Location.Ref.pipe(Schema.optional),
          metadata: Session.Metadata.pipe(Schema.optional),
          permissions: Permission.Ruleset.pipe(Schema.optional),
        }),
        success: Schema.Struct({ data: Session.Info }),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "v2.session.create",
          summary: "Create session",
          description: "Create a session at the requested location.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.post("session.import", "/api/session/import", {
        payload: Schema.Struct({
          ...SessionTransfer.Data.fields,
          location: Location.Ref.pipe(Schema.optional),
        }),
        success: Schema.Struct({ data: Session.Info }),
        error: [ConflictError, SessionNotFoundError],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "v2.session.import",
          summary: "Import session",
          description:
            "Import a projected session transcript at the requested location. If parentID is supplied, the parent session must already exist; import parents before children.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.get("session.export", "/api/session/:sessionID/export", {
        params: { sessionID: Session.ID },
        query: Schema.Struct({ sanitize: BooleanFromString.pipe(Schema.optional) }),
        success: Schema.Struct({ data: SessionTransfer.Data }),
        error: [SessionNotFoundError, UnknownError],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "v2.session.export",
          summary: "Export session",
          description: "Export a complete projected session transcript.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.get("session.active", "/api/session/active", {
        success: Schema.Struct({ data: Schema.Record(Session.ID, SessionActive) }),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "v2.session.active",
          summary: "List active sessions",
          description:
            "Retrieve foreground Session drains currently owned by this OpenCode process. Sessions absent from the result are inactive.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.get("session.get", "/api/session/:sessionID", {
        params: { sessionID: Session.ID },
        success: Schema.Struct({ data: Session.Info }),
        error: SessionNotFoundError,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "v2.session.get",
          summary: "Get session",
          description: "Retrieve a session by ID.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.delete("session.remove", "/api/session/:sessionID", {
        params: { sessionID: Session.ID },
        success: HttpApiSchema.NoContent,
        error: SessionNotFoundError,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "v2.session.remove",
          summary: "Delete session",
          description: "Delete a session and its child sessions.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.post("session.fork", "/api/session/:sessionID/fork", {
        params: { sessionID: Session.ID },
        payload: Schema.Struct({ boundary: Session.ForkRequestBoundary }),
        success: Schema.Struct({ data: Session.Info }),
        error: [SessionNotFoundError, MessageNotFoundError, InvalidRequestError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.fork",
            summary: "Fork session",
            description: "Create a child session by copying projected history through or before a message boundary.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("session.switchAgent", "/api/session/:sessionID/agent", {
        params: { sessionID: Session.ID },
        payload: Schema.Struct({ agent: Agent.ID }),
        success: HttpApiSchema.NoContent,
        error: SessionNotFoundError,
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.switchAgent",
            summary: "Switch session agent",
            description: "Switch the agent used by subsequent provider turns.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("session.switchModel", "/api/session/:sessionID/model", {
        params: { sessionID: Session.ID },
        payload: Schema.Struct({ model: Model.Ref }),
        success: HttpApiSchema.NoContent,
        error: SessionNotFoundError,
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.switchModel",
            summary: "Switch session model",
            description: "Switch the model used by subsequent provider turns.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("session.rename", "/api/session/:sessionID/rename", {
        params: { sessionID: Session.ID },
        payload: Schema.Struct({ title: Schema.String }),
        success: HttpApiSchema.NoContent,
        error: SessionNotFoundError,
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.rename",
            summary: "Rename session",
            description: "Update the session title.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("session.move", "/api/session/:sessionID/move", {
        params: { sessionID: Session.ID },
        payload: Schema.Struct({ ...Location.Ref.fields, delivery: SessionInbox.Delivery.pipe(Schema.optional) }),
        success: HttpApiSchema.NoContent,
        error: [SessionNotFoundError, InvalidRequestError],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "v2.session.move",
          summary: "Move session",
          description: "Move a session to another project directory, optionally transferring local changes.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.post("session.prompt", "/api/session/:sessionID/prompt", {
        params: { sessionID: Session.ID },
        payload: Schema.Struct({
          id: SessionMessage.ID.pipe(Schema.optional),
          ...PromptInput.Prompt.fields,
          metadata: SessionInbox.UserPayload.fields.metadata,
          delivery: SessionInbox.Delivery.pipe(Schema.optional),
          resume: Schema.Boolean.pipe(Schema.optional),
        }),
        success: Schema.Struct({ data: SessionInbox.User }),
        error: [ConflictError, InvalidRequestError, SessionNotFoundError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.prompt",
            summary: "Send message",
            description: "Durably admit one session input and schedule agent-loop execution unless resume is false.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("session.command", "/api/session/:sessionID/command", {
        params: { sessionID: Session.ID },
        payload: Schema.Struct({
          command: Schema.String,
          ...PromptInput.Prompt.fields,
          delivery: SessionInbox.Delivery.pipe(Schema.optional),
        }),
        success: HttpApiSchema.NoContent,
        error: [SessionNotFoundError, CommandNotFoundError, CommandExecutionError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.command",
            summary: "Run command",
            description: "Execute a slash command callback immediately.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("session.skill", "/api/session/:sessionID/skill", {
        params: { sessionID: Session.ID },
        payload: Schema.Struct({
          id: SessionMessage.ID.pipe(Schema.optional),
          skill: Skill.ID,
          resume: Schema.Boolean.pipe(Schema.optional),
        }),
        success: HttpApiSchema.NoContent,
        error: [SessionNotFoundError, SkillNotFoundError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.skill",
            summary: "Activate skill",
            description: "Activate a skill for a session by appending a skill message and resuming execution.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("session.synthetic", "/api/session/:sessionID/synthetic", {
        params: { sessionID: Session.ID },
        payload: Schema.Struct({
          id: SessionMessage.ID.pipe(Schema.optional),
          text: Schema.String,
          description: Schema.String.pipe(Schema.optional),
          metadata: SessionMessage.Synthetic.fields.metadata,
          delivery: SessionInbox.Delivery.pipe(Schema.optional),
          resume: Schema.Boolean.pipe(Schema.optional),
        }),
        success: Schema.Struct({ data: SessionInbox.Synthetic }),
        error: [ConflictError, SessionNotFoundError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.synthetic",
            summary: "Add synthetic message",
            description: "Durably admit synthetic session input and schedule execution unless resume is false.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("session.shell", "/api/session/:sessionID/shell", {
        params: { sessionID: Session.ID },
        payload: Schema.Struct({
          id: Event.ID.pipe(Schema.optional),
          command: Schema.String,
        }),
        success: HttpApiSchema.NoContent,
        error: SessionNotFoundError,
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.shell",
            summary: "Run shell command",
            description:
              "Execute one shell command in the session's working directory. Emits a shell.started event before execution and a shell.ended event with the merged output after.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("session.compact", "/api/session/:sessionID/compact", {
        params: { sessionID: Session.ID },
        payload: Schema.Struct({
          id: SessionMessage.ID.pipe(Schema.optional),
          delivery: SessionInbox.Delivery.pipe(Schema.optional),
        }),
        success: Schema.Struct({ data: SessionInbox.Compaction }),
        error: [ConflictError, SessionNotFoundError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.compact",
            summary: "Compact session",
            description:
              "Durably admit a session compaction request. Steers by default: it runs at the next step boundary instead of waiting behind queued prompts.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("session.wait", "/api/session/:sessionID/wait", {
        params: { sessionID: Session.ID },
        success: HttpApiSchema.NoContent,
        error: [SessionNotFoundError, ServiceUnavailableError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.wait",
            summary: "Wait for session",
            description: "Wait for a session agent loop to become idle.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("session.revert.stage", "/api/session/:sessionID/revert/stage", {
        params: { sessionID: Session.ID },
        payload: Schema.Struct({ messageID: SessionMessage.ID, files: Schema.Boolean.pipe(Schema.optional) }),
        success: Schema.Struct({ data: Session.Revert }),
        error: [MessageNotFoundError, SessionNotFoundError, SessionBusyError, UnknownError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.revert.stage",
            summary: "Stage session revert",
            description: "Stage or move a reversible session boundary and optionally apply its file changes.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("session.revert.clear", "/api/session/:sessionID/revert/clear", {
        params: { sessionID: Session.ID },
        success: HttpApiSchema.NoContent,
        error: [SessionNotFoundError, SessionBusyError, UnknownError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(OpenApi.annotations({ identifier: "v2.session.revert.clear", summary: "Clear staged revert" })),
    )
    .add(
      HttpApiEndpoint.post("session.revert.commit", "/api/session/:sessionID/revert/commit", {
        params: { sessionID: Session.ID },
        success: HttpApiSchema.NoContent,
        error: [SessionNotFoundError, SessionBusyError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({ identifier: "v2.session.revert.commit", summary: "Commit staged revert" }),
        ),
    )
    .add(
      HttpApiEndpoint.get("session.context", "/api/session/:sessionID/context", {
        params: { sessionID: Session.ID },
        success: Schema.Struct({ data: Schema.Array(SessionMessage.Info) }),
        error: [SessionNotFoundError, UnknownError],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "v2.session.context",
          summary: "Get session context",
          description: "Retrieve the active context messages for a session (all messages after the last compaction).",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.get("session.diff", "/api/session/:sessionID/diff", {
        params: { sessionID: Session.ID },
        query: Schema.Struct({
          from: Schema.optional(SessionMessage.ID).annotate({
            description: "User message whose turn to diff. Defaults to the turn of the newest user message.",
          }),
          to: Schema.optional(SessionMessage.ID).annotate({
            description: "Later user message whose turn ends the range. Defaults to the turn of `from` alone.",
          }),
          context: Schema.NumberFromString.pipe(Schema.decodeTo(NonNegativeInt), Schema.optional).annotate({
            description: "Unchanged lines around each hunk. Omit for full-file patches.",
          }),
        }),
        success: Schema.Struct({ data: Schema.Array(FileDiff.Info) }),
        error: [InvalidRequestError, MessageNotFoundError, SessionNotFoundError, UnknownError],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "v2.session.diff",
          summary: "Diff session turns",
          description:
            "Structured per-file diffs of the files a turn changed. A turn runs from the first prompt after the session was last idle until its next idle marker, so prompts steered in while it was busy belong to the same turn; `to` extends the range through a later turn. Compares the range's first recorded snapshot with its last; a step still running in the active session compares against the working copy. Ranges that span a location change are rejected. In sessions without any idle marker, a prompt's turn spans until the next user message.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.get("session.inbox.list", "/api/session/:sessionID/inbox", {
        params: { sessionID: Session.ID },
        success: Schema.Struct({ data: Schema.Array(SessionInbox.Info) }),
        error: SessionNotFoundError,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "v2.session.inbox.list",
          summary: "List session inbox",
          description:
            "List durable enqueued session work not yet delivered, ordered by enqueue sequence. Includes user, synthetic, compaction, and move items.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.delete("session.inbox.cancel", "/api/session/:sessionID/inbox/:inboxID", {
        params: { sessionID: Session.ID, inboxID: SessionMessage.ID },
        success: HttpApiSchema.NoContent,
        error: [ConflictError, SessionNotFoundError],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "v2.session.inbox.cancel",
          summary: "Cancel inbox input",
          description: "Cancel an inbox item that has not yet been delivered.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.post("session.inbox.steer", "/api/session/:sessionID/inbox/:inboxID/steer", {
        params: { sessionID: Session.ID, inboxID: SessionMessage.ID },
        success: HttpApiSchema.NoContent,
        error: [ConflictError, SessionNotFoundError],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "v2.session.inbox.steer",
          summary: "Steer queued item",
          description: "Change a queued inbox item to steer delivery and wake session execution.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.post("session.inbox.queue", "/api/session/:sessionID/inbox/:inboxID/queue", {
        params: { sessionID: Session.ID, inboxID: SessionMessage.ID },
        success: HttpApiSchema.NoContent,
        error: [ConflictError, SessionNotFoundError],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "v2.session.inbox.queue",
          summary: "Queue steered item",
          description: "Change a steered inbox item to queued delivery.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.get("session.instructions.entry.list", "/api/session/:sessionID/instructions/entries", {
        params: { sessionID: Session.ID },
        success: Schema.Struct({ data: Schema.Array(InstructionEntry.Info) }),
        error: SessionNotFoundError,
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.instructions.entry.list",
            summary: "List instruction entries",
            description: "List API-managed instruction entries attached to the session.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.put("session.instructions.entry.put", "/api/session/:sessionID/instructions/entries/:key", {
        params: { sessionID: Session.ID, key: InstructionEntry.Key },
        payload: Schema.Struct({ value: Schema.Json }),
        success: HttpApiSchema.NoContent,
        error: [SessionNotFoundError, InstructionEntry.ValueTooLargeError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.instructions.entry.put",
            summary: "Put instruction entry",
            description:
              "Attach or replace one durable instruction entry. Changes announce as updates at the next step boundary.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.delete("session.instructions.entry.remove", "/api/session/:sessionID/instructions/entries/:key", {
        params: { sessionID: Session.ID, key: InstructionEntry.Key },
        success: HttpApiSchema.NoContent,
        error: SessionNotFoundError,
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.instructions.entry.remove",
            summary: "Remove instruction entry",
            description:
              "Remove one instruction entry; the removal is announced to the model at the next step boundary.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("session.generate", "/api/session/:sessionID/generate", {
        params: { sessionID: Session.ID },
        payload: Schema.Struct({ prompt: Schema.String }),
        success: Schema.Struct({
          data: Schema.Struct({ text: Schema.String }),
        }).annotate({ identifier: "SessionGenerateResponse" }),
        error: [SessionNotFoundError, ServiceUnavailableError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.generate",
            summary: "Generate text from session context",
            description: "Generate transient text from the current session context without mutating session history.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.get("session.log", "/api/experimental/session/:sessionID/log", {
        params: { sessionID: Session.ID },
        query: {
          after: Schema.NumberFromString.pipe(Schema.decodeTo(Event.Seq), Schema.optional),
          follow: BooleanFromString.pipe(Schema.optional),
        },
        success: HttpApiSchema.StreamSse({
          data: Schema.Union([SessionEvent.Durable, EventLog.Synced]).annotate({ identifier: "SessionLogItem" }),
        }),
        error: SessionNotFoundError,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "v2.session.log",
          summary: "Read the session log",
          description:
            "Experimental durable session event log. Reads events after an exclusive aggregate sequence and continues with live events when follow=true.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.post("session.interrupt", "/api/session/:sessionID/interrupt", {
        params: { sessionID: Session.ID },
        query: { continue: BooleanFromString.pipe(Schema.optional) },
        success: Schema.Struct({
          interrupted: Schema.Boolean.annotate({
            description: "Whether an active execution owned by this OpenCode process was interrupted.",
          }),
        }).annotate({ identifier: "SessionInterruptResponse" }),
        error: SessionNotFoundError,
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.interrupt",
            summary: "Interrupt session execution",
            description:
              "Interrupt active execution owned by this OpenCode process. Returns interrupted=true when an active execution was interrupted and false for the idle no-op. When continue=true, execution resumes pending steering input and next-in-line control items (manual compaction, moves) while queued prompts remain parked.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("session.background", "/api/session/:sessionID/background", {
        params: { sessionID: Session.ID },
        success: HttpApiSchema.NoContent,
        error: SessionNotFoundError,
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.background",
            summary: "Background blocking session tools",
            description:
              "Move active foreground backgroundable tools for this session into background observation. Idle requests are a no-op.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.get("session.message", "/api/session/:sessionID/message/:messageID", {
        params: { sessionID: Session.ID, messageID: SessionMessage.ID },
        success: Schema.Struct({ data: SessionMessage.Info }),
        error: [SessionNotFoundError, MessageNotFoundError],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "v2.session.message",
          summary: "Get session message",
          description: "Retrieve one projected message owned by the Session.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.put("session.environment", "/api/session/:sessionID/environment", {
        params: { sessionID: Session.ID },
        payload: Schema.Struct({ variables: Schema.Record(Schema.String, Schema.String) }),
        success: HttpApiSchema.NoContent,
        error: SessionNotFoundError,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "v2.session.environment",
          summary: "Set session environment",
          description: "Replace the process environment used by local shell commands for this session.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.post("session.view", "/api/session/:sessionID/view", {
        params: { sessionID: Session.ID },
        payload: Schema.Struct({ idle: NonNegativeInt }),
        success: HttpApiSchema.NoContent,
        error: SessionNotFoundError,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "v2.session.view",
          summary: "View session",
          description: "Mark the idle transition observed by the viewer as viewed.",
        }),
      ),
    )
    .annotateMerge(
      OpenApi.annotations({
        title: "session",
        description: "Experimental session routes.",
      }),
    )
