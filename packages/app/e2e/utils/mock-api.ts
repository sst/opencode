import { Schema, SchemaGetter } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/unstable/httpapi"

const Json = Schema.Json.pipe(
  Schema.decodeTo(Schema.Unknown, {
    decode: SchemaGetter.passthrough(),
    encode: SchemaGetter.transform(jsonValue),
  }),
  HttpApiSchema.asJson(),
)
const JsonPayload = Schema.Unknown.pipe(HttpApiSchema.asJson())
const Query = Schema.Struct({
  directory: Schema.optional(Schema.String),
  parentID: Schema.optional(Schema.String),
  search: Schema.optional(Schema.String),
  order: Schema.optional(Schema.String),
  cursor: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.NumberFromString),
  path: Schema.optional(Schema.String),
  query: Schema.optional(Schema.String),
  type: Schema.optional(Schema.String),
})
const SessionParams = { sessionID: Schema.String }
const NoContent = HttpApiSchema.NoContent

export class MockNotFound extends Schema.TaggedError<MockNotFound>()("MockNotFound", {
  message: Schema.String,
}) {}

export class MockBadRequest extends Schema.TaggedError<MockBadRequest>()("MockBadRequest", {
  message: Schema.String,
}) {}

const Group = HttpApiGroup.make("mock")
  .add(HttpApiEndpoint.get("health", "/api/health", { success: Json }))
  .add(
    HttpApiEndpoint.get("event", "/api/event", {
      success: Schema.String.pipe(HttpApiSchema.asText({ contentType: "text/event-stream" })),
    }),
  )
  .add(HttpApiEndpoint.get("reference", "/api/reference", { success: Json }))
  .add(HttpApiEndpoint.get("config", "/api/config", { success: Json }))
  .add(HttpApiEndpoint.get("agent", "/api/agent", { success: Json }))
  .add(HttpApiEndpoint.get("provider", "/api/provider", { success: Json }))
  .add(HttpApiEndpoint.get("model", "/api/model", { success: Json }))
  .add(HttpApiEndpoint.get("modelDefault", "/api/model/default", { success: Json }))
  .add(HttpApiEndpoint.get("integrationList", "/api/integration", { success: Json }))
  .add(
    HttpApiEndpoint.get("integrationGet", "/api/integration/:integrationID", {
      params: { integrationID: Schema.String },
      success: Json,
    }),
  )
  .add(
    HttpApiEndpoint.post("integrationConnect", "/api/integration/:integrationID/connect/key", {
      params: { integrationID: Schema.String },
      payload: JsonPayload,
      success: NoContent,
    }),
  )
  .add(
    HttpApiEndpoint.delete("credentialRemove", "/api/credential/:credentialID", {
      params: { credentialID: Schema.String },
      success: NoContent,
    }),
  )
  .add(HttpApiEndpoint.get("command", "/api/command", { success: Json }))
  .add(HttpApiEndpoint.get("skill", "/api/skill", { success: Json }))
  .add(HttpApiEndpoint.get("plugin", "/api/plugin", { success: Json }))
  .add(HttpApiEndpoint.get("mcp", "/api/mcp", { success: Json }))
  .add(HttpApiEndpoint.get("mcpResource", "/api/mcp/resource", { success: Json }))
  .add(HttpApiEndpoint.get("projectList", "/api/project", { success: Json }))
  .add(
    HttpApiEndpoint.patch("projectUpdate", "/api/project/:projectID", {
      params: { projectID: Schema.String },
      payload: JsonPayload,
      success: Json,
    }),
  )
  .add(HttpApiEndpoint.get("projectCurrent", "/api/project/current", { success: Json }))
  .add(HttpApiEndpoint.get("configPreferences", "/api/config/preferences", { success: Json }))
  .add(
    HttpApiEndpoint.patch("configUpdatePreferences", "/api/config/preferences", {
      payload: JsonPayload,
      success: Json,
    }),
  )
  .add(HttpApiEndpoint.get("configShells", "/api/config/shell", { success: Json }))
  .add(HttpApiEndpoint.get("websearchProviders", "/api/websearch/provider", { success: Json }))
  .add(
    HttpApiEndpoint.get("worktreeList", "/api/worktree", {
      success: Json,
    }),
  )
  .add(
    HttpApiEndpoint.post("worktreeCreate", "/api/worktree", {
      payload: JsonPayload,
      success: Json,
    }),
  )
  .add(
    HttpApiEndpoint.delete("worktreeRemove", "/api/worktree", {
      success: NoContent,
    }),
  )
  .add(
    HttpApiEndpoint.post("worktreeRefresh", "/api/worktree/refresh", {
      success: NoContent,
    }),
  )
  .add(HttpApiEndpoint.get("location", "/api/location", { success: Json }))
  .add(HttpApiEndpoint.get("permissionRequests", "/api/permission/request", { success: Json }))
  .add(HttpApiEndpoint.get("formRequests", "/api/form/request", { success: Json }))
  .add(HttpApiEndpoint.get("vcs", "/api/vcs", { success: Json }))
  .add(HttpApiEndpoint.get("vcsStatus", "/api/vcs/status", { success: Json }))
  .add(HttpApiEndpoint.get("vcsBranches", "/api/vcs/branches", { success: Json }))
  .add(HttpApiEndpoint.get("vcsDiff", "/api/vcs/diff", { success: Json }))
  .add(HttpApiEndpoint.get("fsList", "/api/fs/list", { query: Query, success: Json }))
  .add(
    HttpApiEndpoint.get("fsRead", "/api/fs/read/*", {
      success: Schema.Uint8Array.pipe(HttpApiSchema.asUint8Array()),
    }),
  )
  .add(HttpApiEndpoint.get("fsFind", "/api/fs/find", { query: Query, success: Json }))
  .add(HttpApiEndpoint.get("shell", "/api/shell", { success: Json }))
  .add(
    HttpApiEndpoint.get("ptyConnectToken", "/api/pty/:ptyID/connect-token", {
      params: { ptyID: Schema.String },
      success: Json,
    }),
  )
  .add(
    HttpApiEndpoint.get("sessionList", "/api/session", {
      query: Query,
      success: Json,
      error: MockBadRequest.pipe(HttpApiSchema.status(400)),
    }),
  )
  .add(HttpApiEndpoint.post("sessionCreate", "/api/session", { payload: JsonPayload, success: Json }))
  .add(HttpApiEndpoint.get("sessionActive", "/api/session/active", { success: Json }))
  .add(
    HttpApiEndpoint.get("sessionGet", "/api/session/:sessionID", {
      params: SessionParams,
      success: Json,
      error: MockNotFound.pipe(HttpApiSchema.status(404)),
    }),
  )
  .add(
    HttpApiEndpoint.delete("sessionRemove", "/api/session/:sessionID", {
      params: SessionParams,
      success: NoContent,
    }),
  )
  .add(
    HttpApiEndpoint.post("sessionShell", "/api/session/:sessionID/shell", {
      params: SessionParams,
      success: NoContent,
    }),
  )
  .add(
    HttpApiEndpoint.get("sessionForm", "/api/session/:sessionID/form", {
      params: SessionParams,
      success: Json,
    }),
  )
  .add(
    HttpApiEndpoint.post("sessionFormReply", "/api/session/:sessionID/form/:formID/reply", {
      params: { ...SessionParams, formID: Schema.String },
      payload: JsonPayload,
      success: NoContent,
    }),
  )
  .add(
    HttpApiEndpoint.post("sessionFormCancel", "/api/session/:sessionID/form/:formID/cancel", {
      params: { ...SessionParams, formID: Schema.String },
      success: NoContent,
    }),
  )
  .add(
    HttpApiEndpoint.post("sessionBackground", "/api/session/:sessionID/background", {
      params: SessionParams,
      success: NoContent,
    }),
  )
  .add(
    HttpApiEndpoint.get("sessionInbox", "/api/session/:sessionID/inbox", {
      params: SessionParams,
      success: Json,
    }),
  )
  .add(
    HttpApiEndpoint.post("sessionPrompt", "/api/session/:sessionID/prompt", {
      params: SessionParams,
      payload: JsonPayload,
      success: Json,
    }),
  )
  .add(
    HttpApiEndpoint.post("sessionSwitchAgent", "/api/session/:sessionID/agent", {
      params: SessionParams,
      payload: JsonPayload,
      success: NoContent,
    }),
  )
  .add(
    HttpApiEndpoint.post("sessionSwitchModel", "/api/session/:sessionID/model", {
      params: SessionParams,
      payload: JsonPayload,
      success: NoContent,
    }),
  )
  .add(
    HttpApiEndpoint.delete("sessionInboxCancel", "/api/session/:sessionID/inbox/:inboxID", {
      params: { ...SessionParams, inboxID: Schema.String },
      success: NoContent,
    }),
  )
  .add(
    HttpApiEndpoint.post("sessionInboxSteer", "/api/session/:sessionID/inbox/:inboxID/steer", {
      params: { ...SessionParams, inboxID: Schema.String },
      success: NoContent,
    }),
  )
  .add(
    HttpApiEndpoint.get("sessionPermission", "/api/session/:sessionID/permission", {
      params: SessionParams,
      success: Json,
    }),
  )
  .add(
    HttpApiEndpoint.post("sessionPermissionReply", "/api/session/:sessionID/permission/:permissionID/reply", {
      params: { ...SessionParams, permissionID: Schema.String },
      payload: JsonPayload,
      success: NoContent,
    }),
  )
  .add(
    HttpApiEndpoint.post("sessionRename", "/api/session/:sessionID/rename", {
      params: SessionParams,
      payload: JsonPayload,
      success: NoContent,
    }),
  )
  .add(
    HttpApiEndpoint.post("sessionInterrupt", "/api/session/:sessionID/interrupt", {
      params: SessionParams,
      success: NoContent,
    }),
  )
  .add(
    HttpApiEndpoint.post("sessionRevertStage", "/api/session/:sessionID/revert/stage", {
      params: SessionParams,
      payload: JsonPayload,
      success: Json,
      error: MockBadRequest.pipe(HttpApiSchema.status(400)),
    }),
  )
  .add(
    HttpApiEndpoint.post("sessionRevertClear", "/api/session/:sessionID/revert/clear", {
      params: SessionParams,
      success: NoContent,
    }),
  )
  .add(
    HttpApiEndpoint.post("sessionRevertCommit", "/api/session/:sessionID/revert/commit", {
      params: SessionParams,
      success: NoContent,
    }),
  )
  .add(
    HttpApiEndpoint.get("messageGet", "/api/session/:sessionID/message/:messageID", {
      params: { ...SessionParams, messageID: Schema.String },
      success: Json,
      error: MockNotFound.pipe(HttpApiSchema.status(404)),
    }),
  )
  .add(
    HttpApiEndpoint.get("messageList", "/api/session/:sessionID/message", {
      params: SessionParams,
      query: Query,
      success: Json,
      error: MockBadRequest.pipe(HttpApiSchema.status(400)),
    }),
  )

export const MockApi = HttpApi.make("mock").add(Group)

function jsonValue(value: unknown): Schema.Json {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value
  if (typeof value === "number") return Number.isFinite(value) ? value : null
  if (Array.isArray(value)) return value.map(jsonValue)
  if (!value || typeof value !== "object") return null
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, item]) => (item === undefined ? [] : [[key, jsonValue(item)]])),
  )
}
