import type { Node } from "acorn"
import type { ErrorType } from "./intrinsics.js"
import type { DiagnosticKind } from "../codemode.js"
import type { ProgramError } from "./objects.js"

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

/**
 * A failure raised by the interpreter or a built-in. It travels as a defect and becomes one program Error object
 * the first time a handler observes it, so every observer of the same failure sees the same value.
 */
export class PendingThrow {
  node?: AstNode
  value?: ProgramError

  constructor(
    /** The JS error class a program sees when it catches this failure. */
    readonly type: ErrorType,
    readonly message: string,
    node?: AstNode,
    readonly kind: DiagnosticKind = "ExecutionFailure",
    readonly suggestions?: ReadonlyArray<string>,
  ) {
    if (node) this.node = node
  }
}

const failure = (type: ErrorType, kind?: DiagnosticKind) => (message: string, node?: AstNode) =>
  new PendingThrow(type, message, node, kind)

export const typeError = failure("TypeError")
export const invalidData = failure("TypeError", "InvalidDataValue")
export const rangeError = failure("RangeError")
export const referenceError = failure("ReferenceError")
export const syntaxError = failure("SyntaxError")
export const uriError = failure("URIError")

// Orient the agent rather than enumerate JavaScript; interpreter-support.md is the full matrix.
export const supportedSyntaxMessage =
  "This is a restricted JavaScript-like language. Supported: plain and async functions, data literals, destructuring, standard control flow, await and Promise, and built-ins such as Array, Object, Math, JSON, Date, RegExp, Map, Set, and URL. Unsupported: classes, this, getters/setters, tagged templates, BigInt, and custom Symbols. Use plain functions and data objects instead."

export const unsupportedSyntax = (kind: string, node: AstNode): PendingThrow =>
  new PendingThrow(
    "SyntaxError",
    `Syntax '${kind}' is not supported. ${supportedSyntaxMessage}`,
    node,
    "UnsupportedSyntax",
    [supportedSyntaxMessage],
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
