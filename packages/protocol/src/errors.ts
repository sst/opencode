import { Schema } from "effect"
import { Skill } from "@opencode/schema/skill"

export class InvalidRequestError extends Schema.TaggedError<InvalidRequestError>()(
  "InvalidRequestError",
  {
    message: Schema.String,
    kind: Schema.optional(Schema.String),
    field: Schema.optional(Schema.String),
  },
  { httpApiStatus: 400 },
) {}

export class RpcError extends Schema.TaggedError<RpcError>()(
  "RpcError",
  {
    type: Schema.String,
    message: Schema.String,
    data: Schema.optional(Schema.Unknown),
  },
  { httpApiStatus: 400 },
) {}

export class RpcInternalError extends Schema.TaggedError<RpcInternalError>()(
  "RpcInternalError",
  {
    type: Schema.Literals(["rpc.internal", "rpc.invalid_output"]),
    message: Schema.String,
    data: Schema.optional(Schema.Unknown),
  },
  { httpApiStatus: 500 },
) {}

export class UnauthorizedError extends Schema.TaggedError<UnauthorizedError>()(
  "UnauthorizedError",
  { message: Schema.String },
  { httpApiStatus: 401 },
) {}

export class ConflictError extends Schema.TaggedError<ConflictError>()(
  "ConflictError",
  {
    message: Schema.String,
    resource: Schema.optional(Schema.String),
  },
  { httpApiStatus: 409 },
) {}

export class SessionBusyError extends Schema.TaggedError<SessionBusyError>()(
  "SessionBusyError",
  {
    sessionID: Schema.String,
    message: Schema.String,
  },
  { httpApiStatus: 409 },
) {}

export class ServiceUnavailableError extends Schema.TaggedError<ServiceUnavailableError>()(
  "ServiceUnavailableError",
  {
    message: Schema.String,
    service: Schema.optional(Schema.String),
  },
  { httpApiStatus: 503 },
) {}

export class UnknownError extends Schema.TaggedError<UnknownError>()(
  "UnknownError",
  {
    message: Schema.String,
    ref: Schema.optional(Schema.String),
  },
  { httpApiStatus: 500 },
) {}

export class ProviderNotFoundError extends Schema.TaggedError<ProviderNotFoundError>()(
  "ProviderNotFoundError",
  {
    providerID: Schema.String,
    message: Schema.String,
  },
  { httpApiStatus: 404 },
) {}

export class ProjectNotFoundError extends Schema.TaggedError<ProjectNotFoundError>()(
  "ProjectNotFoundError",
  {
    projectID: Schema.String,
    message: Schema.String,
  },
  { httpApiStatus: 404 },
) {}

export class FileNotFoundError extends Schema.TaggedError<FileNotFoundError>()(
  "FileNotFoundError",
  {
    path: Schema.String,
    message: Schema.String,
  },
  { httpApiStatus: 404 },
) {}

export class AgentNotFoundError extends Schema.TaggedError<AgentNotFoundError>()(
  "AgentNotFoundError",
  {
    agentID: Schema.String,
    message: Schema.String,
  },
  { httpApiStatus: 404 },
) {}

export class SessionNotFoundError extends Schema.TaggedError<SessionNotFoundError>()(
  "SessionNotFoundError",
  {
    sessionID: Schema.String,
    message: Schema.String,
  },
  { httpApiStatus: 404 },
) {}

export class MessageNotFoundError extends Schema.TaggedError<MessageNotFoundError>()(
  "MessageNotFoundError",
  {
    sessionID: Schema.String,
    messageID: Schema.String,
    message: Schema.String,
  },
  { httpApiStatus: 404 },
) {}

export class SkillNotFoundError extends Schema.TaggedError<SkillNotFoundError>()(
  "SkillNotFoundError",
  {
    skill: Skill.ID,
    message: Schema.String,
  },
  { httpApiStatus: 404 },
) {}

export class McpServerNotFoundError extends Schema.TaggedError<McpServerNotFoundError>()(
  "McpServerNotFoundError",
  {
    server: Schema.String,
    message: Schema.String,
  },
  { httpApiStatus: 404 },
) {}

export class CommandNotFoundError extends Schema.TaggedError<CommandNotFoundError>()(
  "CommandNotFoundError",
  {
    command: Schema.String,
    message: Schema.String,
  },
  { httpApiStatus: 404 },
) {}

export class CommandExecutionError extends Schema.TaggedError<CommandExecutionError>()(
  "CommandExecutionError",
  {
    command: Schema.String,
    message: Schema.String,
  },
  { httpApiStatus: 500 },
) {}

export class InvalidCursorError extends Schema.TaggedError<InvalidCursorError>()(
  "InvalidCursorError",
  { message: Schema.String },
  { httpApiStatus: 400 },
) {}

export class PermissionNotFoundError extends Schema.TaggedError<PermissionNotFoundError>()(
  "PermissionNotFoundError",
  {
    requestID: Schema.String,
    message: Schema.String,
  },
  { httpApiStatus: 404 },
) {}

export class FormNotFoundError extends Schema.TaggedError<FormNotFoundError>()(
  "FormNotFoundError",
  {
    id: Schema.String,
    message: Schema.String,
  },
  { httpApiStatus: 404 },
) {}

export class FormAlreadySettledError extends Schema.TaggedError<FormAlreadySettledError>()(
  "FormAlreadySettledError",
  {
    id: Schema.String,
    message: Schema.String,
  },
  { httpApiStatus: 409 },
) {}

export class FormInvalidAnswerError extends Schema.TaggedError<FormInvalidAnswerError>()(
  "FormInvalidAnswerError",
  {
    id: Schema.String,
    message: Schema.String,
  },
  { httpApiStatus: 400 },
) {}

export class ForbiddenError extends Schema.TaggedError<ForbiddenError>()(
  "ForbiddenError",
  { message: Schema.String },
  { httpApiStatus: 403 },
) {}

export class PtyNotFoundError extends Schema.TaggedError<PtyNotFoundError>()(
  "PtyNotFoundError",
  {
    ptyID: Schema.String,
    message: Schema.String,
  },
  { httpApiStatus: 404 },
) {}

export class ShellNotFoundError extends Schema.TaggedError<ShellNotFoundError>()(
  "ShellNotFoundError",
  {
    id: Schema.String,
    message: Schema.String,
  },
  { httpApiStatus: 404 },
) {}
