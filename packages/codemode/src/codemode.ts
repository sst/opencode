import { Effect, Schema } from "effect"
import { executeProgram } from "./interpreter/execute.js"
import { type Services, type ToolDescription, ToolRuntime } from "./tool-runtime.js"
import type { Tools } from "./tools.js"

/** A tool call admitted during an execution. */
export type { ToolCall, ToolCallEnded, ToolCallHooks, ToolCallStarted, ToolDescription } from "./tool-runtime.js"
/** Signature-construction helpers for host-owned catalog instructions. */
export { searchSignature, toolExpression } from "./tool-runtime.js"

/** Resource budgets enforced independently during each CodeMode program execution. */
export type ExecutionLimits = {
  /**
   * Wall-clock milliseconds before interruption. Result delivery waits for tool cleanup.
   * No default: absent means no timeout.
   */
  readonly timeoutMs?: number
  /** Maximum number of tool calls admitted by the runtime. No default: absent means unlimited. */
  readonly maxToolCalls?: number
  /**
   * Maximum UTF-8 bytes retained from the result and logs. Warnings have a separate equal budget;
   * truncation notices and host formatting are additional.
   */
  readonly maxOutputBytes?: number
}

export type ResolvedExecutionLimits = {
  readonly timeoutMs: number | undefined
  readonly maxToolCalls: number | undefined
  readonly maxOutputBytes: number | undefined
}

/** Configuration shared by `CodeMode.make` and `CodeMode.execute`. */
export type Options<Provided extends Record<string, unknown> = {}> = ToolRuntime.ToolCallHooks<Services<Provided>> & {
  /** Explicit tools exposed to the program as `tools`. */
  tools?: Provided & Tools<Services<Provided>>
  /** Resource limits enforced on each execution. */
  limits?: ExecutionLimits
}

/** Options for one CodeMode execution. */
export type ExecuteOptions<Provided extends Record<string, unknown> = {}> = Options<Provided> & {
  /** Source for one program in the supported JavaScript subset. */
  code: string
}

/** A JSON value that can cross the confined interpreter boundary. */
export type DataValue = Schema.Json

/** Schema for a host tool input containing CodeMode source. */
export const Input = Schema.Struct({ code: Schema.String })
export type Input = typeof Input.Type

export const DiagnosticKind = Schema.Literals([
  "ParseError",
  "UnsupportedSyntax",
  "UnknownTool",
  "InvalidToolInput",
  "InvalidToolOutput",
  "InvalidDataValue",
  "ToolCallLimitExceeded",
  "TimeoutExceeded",
  "ToolFailure",
  "ExecutionFailure",
  "Truncated",
])
/** Stable categories produced by program, schema, tool, limit, and truncation diagnostics. */
export type DiagnosticKind = typeof DiagnosticKind.Type

export const Diagnostic = Schema.Struct({
  kind: DiagnosticKind,
  message: Schema.String,
  location: Schema.optionalKey(Schema.Struct({ line: Schema.Number, column: Schema.Number })),
  suggestions: Schema.optionalKey(Schema.Array(Schema.String)),
})
/** A normalized program diagnostic safe to return across an agent tool boundary. */
export type Diagnostic = typeof Diagnostic.Type

const ToolCallSchema = Schema.Struct({ name: Schema.String })
export const Success = Schema.Struct({
  ok: Schema.Literal(true),
  value: Schema.Json,
  warnings: Schema.optionalKey(Schema.Array(Diagnostic)),
  logs: Schema.optionalKey(Schema.Array(Schema.String)),
  truncated: Schema.optionalKey(Schema.Boolean),
  toolCalls: Schema.Array(ToolCallSchema),
})
/** Successful execution after the result has crossed the plain-data boundary. */
export type Success = typeof Success.Type

export const Failure = Schema.Struct({
  ok: Schema.Literal(false),
  error: Diagnostic,
  logs: Schema.optionalKey(Schema.Array(Schema.String)),
  truncated: Schema.optionalKey(Schema.Boolean),
  toolCalls: Schema.Array(ToolCallSchema),
})
/** Failed execution with calls admitted before the diagnostic was produced. */
export type Failure = typeof Failure.Type

/** Schema for the structured success or diagnostic returned by CodeMode execution. */
export const Result = Schema.Union([Success, Failure])
/** Result of executing a CodeMode program. Program failures are data, not Effect failures. */
export type Result = typeof Result.Type

/** Reusable confined runtime over explicit tools. */
export type Runtime<R = never> = {
  readonly catalog: ReadonlyArray<ToolDescription>
  readonly execute: (code: string) => Effect.Effect<Result, never, R>
}

const validateLimit = (name: keyof ExecutionLimits, value: number | undefined, minimum: number): number | undefined => {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < minimum)) {
    throw new RangeError(`${name} must be a safe integer greater than or equal to ${minimum}.`)
  }
  return value
}

const resolveExecutionLimits = (limits?: ExecutionLimits): ResolvedExecutionLimits => ({
  timeoutMs: validateLimit("timeoutMs", limits?.timeoutMs, 1),
  maxToolCalls: validateLimit("maxToolCalls", limits?.maxToolCalls, 0),
  maxOutputBytes: validateLimit("maxOutputBytes", limits?.maxOutputBytes, 0),
})

/** Executes one Effect-native CodeMode program without constructing a reusable runtime. */
export const execute = <const Provided extends Record<string, unknown>>(
  options: ExecuteOptions<Provided>,
): Effect.Effect<Result, never, Services<Provided>> => make(options).execute(options.code)

/** Creates an Effect-native runtime over explicit, schema-described tools. */
export const make = <const Provided extends Record<string, unknown> = {}>(
  options: Options<Provided> = {},
): Runtime<Services<Provided>> => {
  const prepared = ToolRuntime.prepare((options.tools ?? {}) as Tools<Services<Provided>>)
  const limits = resolveExecutionLimits(options.limits)
  return {
    catalog: prepared.catalog,
    execute: (code) => executeProgram(code, prepared, limits, options),
  }
}
