export * as SessionCompaction from "./session-compaction"

import { Schema } from "effect"
import { NonNegativeInt, optional } from "./schema"

export const Mode = Schema.Literals(["prepend", "suffix"])
export type Mode = typeof Mode.Type

export const FallbackReason = Schema.Literals([
  "context",
  "plugin_prompt",
  "provider_tool",
  "provider_error",
  "tool_choice",
  "tool_call",
  "empty_summary",
  "invalid_summary",
])
export type FallbackReason = typeof FallbackReason.Type

export const FailureReason = Schema.Union([FallbackReason, Schema.Literal("interrupted")])
export type FailureReason = typeof FailureReason.Type

export interface Tokens extends Schema.Schema.Type<typeof Tokens> {}
export const Tokens = Schema.Struct({
  input: NonNegativeInt.pipe(optional),
  cached: NonNegativeInt.pipe(optional),
  output: NonNegativeInt.pipe(optional),
}).annotate({ identifier: "Session.Compaction.Tokens" })

export interface Diagnostics extends Schema.Schema.Type<typeof Diagnostics> {}
export const Diagnostics = Schema.Struct({
  requested: Mode.pipe(optional),
  used: Mode.pipe(optional),
  fallback: FallbackReason.pipe(optional),
  durationMs: NonNegativeInt.pipe(optional),
  tokens: Tokens.pipe(optional),
}).annotate({ identifier: "Session.Compaction.Diagnostics" })
