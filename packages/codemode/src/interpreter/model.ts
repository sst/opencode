import type { Node } from "acorn"
import type { ErrorType } from "./intrinsics.js"
import type { DiagnosticKind } from "../codemode.js"

/** Any parsed node; the interpreter narrows on `type` and reads `loc` for diagnostics. */
export type AstNode = Node

export type Binding = {
  mutable: boolean
  value: unknown
  initialized?: boolean
}

export type StatementResult =
  | { kind: "none" }
  | { kind: "return"; value: unknown }
  | { kind: "break"; label?: string }
  | { kind: "continue"; label?: string }

export type GeneratorRequestKind = "next" | "return" | "throw"

export const AsyncIteratorSymbol: unique symbol = Symbol("codemode.async-iterator")
export const IteratorSymbol: unique symbol = Symbol("codemode.iterator")
export const IteratorSymbols = [AsyncIteratorSymbol, IteratorSymbol] as const

export class ProgramThrow {
  constructor(readonly value: unknown) {}
}

export class GeneratorReturn {
  constructor(readonly value: unknown) {}
}

export const OptionalShortCircuit: unique symbol = Symbol("codemode.optional-short-circuit")

export class InterpreterRuntimeError extends Error {
  readonly node?: AstNode

  constructor(
    message: string,
    node?: AstNode,
    readonly kind: DiagnosticKind = "ExecutionFailure",
    readonly suggestions?: ReadonlyArray<string>,
    /** The JS error class a program sees when it catches this failure. */
    readonly type: ErrorType = "TypeError",
  ) {
    super(message)
    this.name = "InterpreterRuntimeError"
    if (node) this.node = node
  }
}

/** Attaches a source location to a failure raised where none was known, such as inside a property accessor. */
export const locate = (error: unknown, node: AstNode): unknown =>
  error instanceof InterpreterRuntimeError && error.node === undefined
    ? new InterpreterRuntimeError(error.message, node, error.kind, error.suggestions, error.type)
    : error

const failure = (type: ErrorType) => (message: string, node?: AstNode) =>
  new InterpreterRuntimeError(message, node, "ExecutionFailure", undefined, type)

export const rangeError = failure("RangeError")
export const referenceError = failure("ReferenceError")
export const syntaxError = failure("SyntaxError")
export const uriError = failure("URIError")

// Orient the agent rather than enumerate JavaScript; interpreter-support.md is the full matrix.
export const supportedSyntaxMessage =
  "This is a restricted JavaScript-like language. Supported: plain and async functions, data literals, destructuring, standard control flow, await and Promise, and built-ins such as Array, Object, Math, JSON, Date, RegExp, Map, Set, and URL. Unsupported: classes, this, getters/setters, tagged templates, BigInt, and custom Symbols. Use plain functions and data objects instead."

export const unsupportedSyntax = (kind: string, node: AstNode): InterpreterRuntimeError =>
  new InterpreterRuntimeError(
    `Syntax '${kind}' is not supported. ${supportedSyntaxMessage}`,
    node,
    "UnsupportedSyntax",
    [supportedSyntaxMessage],
    "SyntaxError",
  )

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

export const sourceLocation = (node: AstNode): { readonly line: number; readonly column: number } => ({
  line: Math.max(1, (node.loc?.start.line ?? 2) - 1),
  column: Math.max(1, (node.loc?.start.column ?? 4) - 3),
})

export const formatLocation = (node?: AstNode): string => {
  if (!node?.loc) return ""
  const location = sourceLocation(node)
  return ` (line ${location.line}, col ${location.column})`
}
