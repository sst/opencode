import { Effect } from "effect"
import type { Prototypes } from "../interpreter/intrinsics.js"
import { constructor, type Method, methods, prototypeFrom, receiver } from "../interpreter/native.js"
import { type AstNode, InterpreterRuntimeError, syntaxError } from "../interpreter/model.js"
import {
  define,
  defineAccessor,
  getOwn,
  ProgramArray,
  ProgramObject,
  ProgramRegExp,
  record,
  set,
} from "../interpreter/objects.js"
import type { Runner } from "../interpreter/runner.js"
import { coerceToNumber, coerceToString } from "./value.js"

const flagProperties = [
  "hasIndices",
  "global",
  "ignoreCase",
  "multiline",
  "sticky",
  "unicode",
  "unicodeSets",
  "dotAll",
] as const

const regexFailureReason = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).replace(/^Invalid regular expression:\s*/i, "")

const escapeRegexHint =
  'To match special characters like ( ) [ ] { } + * ? . literally, escape them with a backslash (e.g. "\\\\(") or test for them with String.includes instead.'

export const toHostRegex = (arg: unknown, method: string, node: AstNode, extraFlags = ""): RegExp => {
  // Native parity: an undefined pattern behaves as an empty pattern.
  if (arg === undefined) return new RegExp("", extraFlags)
  if (arg instanceof ProgramRegExp) return arg.regex
  if (typeof arg === "string") {
    try {
      return new RegExp(arg, extraFlags)
    } catch (error) {
      throw syntaxError(
        `String.${method} received the string ${JSON.stringify(arg)}, which is not a valid regular expression pattern (${regexFailureReason(error)}). ${escapeRegexHint}`,
        node,
      )
    }
  }
  throw new InterpreterRuntimeError(
    `String.${method} expects a regular expression (a /pattern/flags literal or new RegExp(...)) or a string pattern, not ${arg === null ? "null" : typeof arg}.`,
    node,
  )
}

export const matchToValue = (protos: Prototypes, match: RegExpMatchArray): ProgramArray => {
  const result = new ProgramArray(
    protos.Array,
    Array.from(match, (group) => group),
  )
  if (match.index !== undefined) define(result, "index", match.index)
  if (match.input !== undefined) define(result, "input", match.input)
  if (match.groups) define(result, "groups", record(protos.Object, match.groups))
  if (match.indices) define(result, "indices", indicesToValue(protos, match.indices))
  return result
}

export const constructRegExp = (
  protos: Prototypes,
  args: Array<unknown>,
  node: AstNode,
  proto: ProgramObject = protos.RegExp,
): ProgramRegExp => {
  const first = args[0]
  const pattern = first instanceof ProgramRegExp ? first.regex.source : first === undefined ? "" : coerceToString(first)
  const flagsArg = args[1]
  if (flagsArg !== undefined && typeof flagsArg !== "string") {
    throw syntaxError(
      `RegExp flags must be a string of flag characters (e.g. "g", "gi"), not ${flagsArg === null ? "null" : typeof flagsArg}.`,
      node,
    )
  }
  const flags = flagsArg ?? (first instanceof ProgramRegExp ? first.regex.flags : "")
  try {
    return new ProgramRegExp(proto, pattern, flags)
  } catch (error) {
    const reason = regexFailureReason(error)
    throw syntaxError(
      /flag/i.test(reason)
        ? `new RegExp(...) received invalid flags ${JSON.stringify(flags)} (${reason}). Valid flags are d, g, i, m, s, u, v, and y.`
        : `new RegExp(...) received ${JSON.stringify(pattern)}, which is not a valid regular expression pattern (${reason}). ${escapeRegexHint}`,
      node,
    )
  }
}

const toLength = (value: unknown): number => {
  const number = coerceToNumber(value)
  if (Number.isNaN(number) || number <= 0) return 0
  return Math.min(Math.floor(number), Number.MAX_SAFE_INTEGER)
}

// RegExp constructs identically with or without new, like JS.
export const regexpGlobal = <R>(runner: Runner<R>) => {
  const protos = runner.prototypes
  const proto = protos.RegExp
  const regexp = constructor<R>(protos, proto, {
    name: "RegExp",
    length: 2,
    call: (_, args, node) => Effect.sync(() => constructRegExp(protos, args, node)),
    construct: (args, newTarget, node) =>
      Effect.sync(() => constructRegExp(protos, args, node, prototypeFrom(newTarget, proto))),
  })
  methods(protos, regexp, [
    [
      "escape",
      1,
      (_, args, node) => {
        if (typeof args[0] !== "string") throw new InterpreterRuntimeError("RegExp.escape expects a string.", node)
        return RegExp.escape(args[0])
      },
    ],
  ])

  const self = (thisValue: unknown, name: string, node?: AstNode) =>
    receiver(ProgramRegExp, thisValue, `RegExp.prototype.${name}`, node)
  defineAccessor(proto, "source", (thisValue) => self(thisValue, "source").regex.source)
  defineAccessor(proto, "flags", (thisValue) => self(thisValue, "flags").regex.flags)
  for (const name of flagProperties) defineAccessor(proto, name, (thisValue) => self(thisValue, name).regex[name])
  // exec/test run the host regex from the program-visible lastIndex and write it back only when g or y is set.
  const run = (name: "exec" | "test"): Method => [
    name,
    1,
    (thisValue, args, node) => {
      const value = self(thisValue, name, node)
      const input = coerceToString(args[0])
      const stateful = value.regex.global || value.regex.sticky
      value.regex.lastIndex = toLength(getOwn(value, "lastIndex"))
      const matched = value.regex.exec(input)
      if (stateful) set(value, "lastIndex", value.regex.lastIndex)
      if (name === "test") return matched !== null
      return matched === null ? null : matchToValue(protos, matched)
    },
  ]
  methods(protos, proto, [
    run("exec"),
    run("test"),
    ["toString", 0, (thisValue, _, node) => coerceToString(self(thisValue, "toString", node))],
  ])
  return regexp
}

const indicesToValue = (protos: Prototypes, indices: RegExpIndicesArray): ProgramArray => {
  const range = (pair: [number, number] | undefined) =>
    pair === undefined ? undefined : new ProgramArray(protos.Array, [...pair])
  const result = new ProgramArray(protos.Array, Array.from(indices, range))
  const groups = indices.groups
  define(
    result,
    "groups",
    groups === undefined
      ? undefined
      : record(protos.Object, Object.fromEntries(Object.entries(groups).map(([key, pair]) => [key, range(pair)]))),
  )
  return result
}
