import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { InvalidCursorError, SessionNotFoundError, UnknownError } from "../errors.js"

export const SessionMessagesQuery = Schema.Struct({
  limit: Schema.optional(
    Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(200)),
  ).annotate({
    description: "Maximum number of messages to return. When omitted, the endpoint returns its default page size.",
  }),
  order: Schema.optional(Schema.Union([Schema.Literal("asc"), Schema.Literal("desc")])).annotate({
    description: "Message order for the first page. Use desc for newest first or asc for oldest first.",
  }),
  cursor: Schema.optional(
    Schema.String.annotate({
      description:
        "Opaque pagination cursor returned as cursor.previous or cursor.next in the previous response. Do not combine with order.",
    }),
  ),
  type: Schema.optional(
    Schema.Literals([
      "agent-switched",
      "model-switched",
      "location-switched",
      "user",
      "synthetic",
      "system",
      "skill",
      "shell",
      "assistant",
      "compaction",
    ] satisfies ReadonlyArray<SessionMessage.Type>),
  ).annotate({
    description:
      "Filter by message type before pagination. When omitted, all message types are returned. Pass the same type when following cursors.",
  }),
}).annotate({ identifier: "SessionMessagesQuery" })

export const MessageGroup = HttpApiGroup.make("server.message")
  .add(
    HttpApiEndpoint.get("session.messages", "/api/session/:sessionID/message", {
      params: { sessionID: Session.ID },
      query: SessionMessagesQuery,
      success: Schema.Struct({
        data: Schema.Array(SessionMessage.Info),
        cursor: Schema.Struct({
          previous: Schema.String.pipe(Schema.optional),
          next: Schema.String.pipe(Schema.optional),
        }),
      }).annotate({ identifier: "SessionMessagesResponse" }),
      error: [InvalidCursorError, SessionNotFoundError, UnknownError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.message.list",
        summary: "Get session messages",
        description:
          "Retrieve projected messages for a session, optionally filtered by type. Items keep the requested order across pages; use cursor.next or cursor.previous to move through the ordered timeline, passing the same type filter on each page.",
      }),
    ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "session",
      description: "Experimental message routes.",
    }),
  )
