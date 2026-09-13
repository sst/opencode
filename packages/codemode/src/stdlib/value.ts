import { toProgram } from "../data.js"
import { fn } from "../interpreter/native.js"
import { type AstNode, InterpreterRuntimeError } from "../interpreter/model.js"
import {
  get,
  isWrapper,
  type NativeFunction,
  ProgramArray,
  ProgramDate,
  ProgramError,
  ProgramMap,
  ProgramRegExp,
  ProgramSet,
  ProgramURL,
  ProgramURLSearchParams,
} from "../interpreter/objects.js"
import type { Runner } from "../interpreter/runner.js"

export const compoundOperators = new Set(["+=", "-=", "*=", "/=", "%=", "**=", "&=", "|=", "^=", "<<=", ">>=", ">>>="])

/** The built-in string form of a value, without consulting program-defined `toString` methods. */
export const coerceToString = (value: unknown): string => {
  if (value === null) return "null"
  if (value === undefined) return "undefined"
  if (value instanceof ProgramDate)
    return Number.isFinite(value.time) ? new Date(value.time).toISOString() : "Invalid Date"
  if (value instanceof ProgramRegExp) return `/${value.regex.source}/${value.regex.flags}`
  if (value instanceof ProgramMap) return "[object Map]"
  if (value instanceof ProgramSet) return "[object Set]"
  if (value instanceof ProgramURL) return value.url.href
  if (value instanceof ProgramURLSearchParams) return value.params.toString()
  if (value instanceof ProgramError) {
    // Match Error.prototype.toString: "name: message", or just one when the other is empty.
    const name = get(value, "name")
    const message = get(value, "message")
    const shownName = typeof name === "string" ? name : "Error"
    const shownMessage = typeof message === "string" ? message : ""
    if (shownMessage === "") return shownName
    if (shownName === "") return shownMessage
    return `${shownName}: ${shownMessage}`
  }
  if (value instanceof ProgramArray) {
    return value.items.map((item) => (item === null || item === undefined ? "" : coerceToString(item))).join(",")
  }
  if (typeof value === "object") return "[object Object]"
  return String(value)
}

export const coerceToNumber = (value: unknown): number => {
  if (value instanceof ProgramDate) return value.time
  if (isWrapper(value)) return Number.NaN
  if (value instanceof ProgramArray) return Number(coerceToString(value))
  return value !== null && typeof value === "object" ? Number.NaN : Number(value)
}

export type Coercion = "Number" | "String" | "Boolean" | "parseInt" | "parseFloat" | "isFinite" | "isNaN"

const coerce = <R>(runner: Runner<R>, name: Coercion, args: Array<unknown>, node: AstNode): unknown => {
  // Native: Number() is 0 and String() is "", unlike their undefined-argument forms; the
  // other coercers match native through the undefined-argument path below.
  if (args.length === 0) {
    if (name === "Number") return 0
    if (name === "String") return ""
  }
  const raw = args[0]
  if (isWrapper(raw)) {
    if (name === "Boolean") return true
    if (name === "Number") return coerceToNumber(raw)
    if (name === "String") return coerceToString(raw)
    if (name === "isFinite") return Number.isFinite(coerceToNumber(raw))
    if (name === "isNaN") return Number.isNaN(coerceToNumber(raw))
    if (name === "parseInt") return parseInt(coerceToString(raw))
    return parseFloat(coerceToString(raw))
  }
  const value = toProgram(runner.prototypes, raw, `${name} input`)
  if (name === "Number") return coerceToNumber(value)
  if (name === "Boolean") return Boolean(value)
  if (name === "isFinite") return Number.isFinite(coerceToNumber(value))
  if (name === "isNaN") return Number.isNaN(coerceToNumber(value))
  if (name === "parseInt") {
    const radix = args[1]
    if (radix !== undefined && typeof radix !== "number") {
      throw new InterpreterRuntimeError("parseInt expects a numeric radix.", node)
    }
    return parseInt(coerceToString(value), radix)
  }
  if (name === "parseFloat") return parseFloat(coerceToString(value))
  return coerceToString(value)
}

/** A global coercion function such as `Number` or `parseInt`. */
export const coercion = <R>(runner: Runner<R>, name: Coercion, length = 1): NativeFunction<R> =>
  fn(runner.prototypes, name, length, (_, args, node) =>
    toProgram(runner.prototypes, coerce(runner, name, args, node), `${name} result`),
  )
