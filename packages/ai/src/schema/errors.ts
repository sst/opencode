import { Schema } from "effect"
import { Tool } from "@opencode/schema/tool"
import { ModelID, ProviderID, RouteID } from "./ids.js"

export const ProviderFailureClassification = Schema.Literals(["context-overflow", "payload-too-large"])
export type ProviderFailureClassification = typeof ProviderFailureClassification.Type

export class HttpContext extends Schema.Class<HttpContext>("AI.HttpContext")({
  url: Schema.String,
  status: Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 599 })),
  headers: Schema.Record(Schema.String, Schema.String),
}) {}

export class HttpRateLimitDetails extends Schema.Class<HttpRateLimitDetails>("AI.HttpRateLimitDetails")({
  retryAfterMs: Schema.optional(Schema.Number),
  limit: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  remaining: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  reset: Schema.optional(Schema.Record(Schema.String, Schema.String)),
}) {}

const ReasonFields = {
  message: Schema.String,
  // Preserve the complete original response or triggering event before decoding narrows it.
  body: Schema.optional(Schema.String),
  http: Schema.optional(HttpContext),
  cause: Schema.optional(Schema.Defect({ includeStack: true })),
}

export class InvalidRequestError extends Schema.TaggedError<InvalidRequestError>("AI.Error.InvalidRequest")(
  "InvalidRequest",
  {
    ...ReasonFields,
    parameter: Schema.optional(Schema.String),
    classification: Schema.optional(ProviderFailureClassification),
  },
) {}

/**
 * A caller-requested operation the selected route does not implement, such as
 * explicit compaction on a route without a compact endpoint. Detected locally
 * before any network I/O, so unlike transport or provider-output failures it
 * never carries HTTP context from a provider round-trip.
 */
export class UnsupportedOperationError extends Schema.TaggedError<UnsupportedOperationError>(
  "AI.Error.UnsupportedOperation",
)("UnsupportedOperation", {
  ...ReasonFields,
  operation: Schema.String,
  provider: Schema.optional(ProviderID),
  route: Schema.optional(RouteID),
}) {}

/**
 * Provider settings that are missing, conflicting, or unsupported, such as
 * Azure without `resourceName` or `baseURL`. Thrown synchronously while a
 * provider facade or package entrypoint configures a model, before any
 * request exists, so it is not an `AIError` reason.
 */
export class ProviderConfigurationError extends Schema.TaggedError<ProviderConfigurationError>(
  "AI.Error.ProviderConfiguration",
)("ProviderConfiguration", {
  provider: ProviderID,
  message: Schema.String,
}) {}

export class NoRouteError extends Schema.TaggedError<NoRouteError>("AI.Error.NoRoute")("NoRoute", {
  ...ReasonFields,
  route: RouteID,
  provider: ProviderID,
  model: ModelID,
}) {}

export class AuthenticationError extends Schema.TaggedError<AuthenticationError>("AI.Error.Authentication")(
  "Authentication",
  ReasonFields,
) {}

export class RateLimitError extends Schema.TaggedError<RateLimitError>("AI.Error.RateLimit")("RateLimit", {
  ...ReasonFields,
  retryAfterMs: Schema.optional(Schema.Number),
  rateLimit: Schema.optional(HttpRateLimitDetails),
}) {}

export class QuotaExceededError extends Schema.TaggedError<QuotaExceededError>("AI.Error.QuotaExceeded")(
  "QuotaExceeded",
  ReasonFields,
) {}

export class ContentPolicyError extends Schema.TaggedError<ContentPolicyError>("AI.Error.ContentPolicy")(
  "ContentPolicy",
  ReasonFields,
) {}

export class ProviderInternalError extends Schema.TaggedError<ProviderInternalError>("AI.Error.ProviderInternal")(
  "ProviderInternal",
  {
    ...ReasonFields,
    retryAfterMs: Schema.optional(Schema.Number),
  },
) {}

export const TransportType = Schema.Literals(["http", "websocket"])
export type TransportType = typeof TransportType.Type

export const TransportOperation = Schema.Literals(["request", "read", "write"])
export type TransportOperation = typeof TransportOperation.Type

export class TransportError extends Schema.TaggedError<TransportError>("AI.Error.Transport")("Transport", {
  ...ReasonFields,
  transport: TransportType,
  operation: TransportOperation,
  code: Schema.optional(Schema.String),
  url: Schema.optional(Schema.String),
  phase: Schema.optional(
    Schema.Literals(["prepare", "queue", "connect", "send", "receive", "decode", "complete", "fallback", "close"]),
  ),
  delivery: Schema.optional(Schema.Literals(["not-sent", "rejected", "ambiguous", "accepted"])),
  recovery: Schema.optional(
    Schema.Literals(["retry-connect", "retry-full", "rotate-and-retry-full", "fallback-http", "fail"]),
  ),
}) {}

export class InvalidProviderOutputError extends Schema.TaggedError<InvalidProviderOutputError>(
  "AI.Error.InvalidProviderOutput",
)("InvalidProviderOutput", {
  ...ReasonFields,
  classification: Schema.optional(Schema.Literals(["incomplete-stream"])),
  route: Schema.optional(Schema.String),
}) {}

export class UnknownProviderError extends Schema.TaggedError<UnknownProviderError>("AI.Error.UnknownProvider")(
  "UnknownProvider",
  ReasonFields,
) {}

export const AIErrorReason = Schema.Union([
  InvalidRequestError,
  UnsupportedOperationError,
  NoRouteError,
  AuthenticationError,
  RateLimitError,
  QuotaExceededError,
  ContentPolicyError,
  ProviderInternalError,
  TransportError,
  InvalidProviderOutputError,
  UnknownProviderError,
]).pipe(Schema.toTaggedUnion("_tag"))
export type AIErrorReason = Schema.Schema.Type<typeof AIErrorReason>

export class AIError extends Schema.TaggedError<AIError>()("AI.Error", {
  reason: AIErrorReason,
}) {
  override readonly cause = this.reason

  override get message(): string {
    return this.reason.message
  }
}

/**
 * Failure type for tool execute handlers. Handlers must map their internal
 * errors to this shape; the runtime catches `ToolFailure`s and surfaces them
 * as `tool-error` events plus a `tool-result` of `type: "error"` so the model
 * can self-correct.
 *
 * Anything thrown or yielded by a handler that is not a `ToolFailure` is
 * treated as a defect and fails the stream.
 */
export class ToolFailure extends Tool.Error {}
