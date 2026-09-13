import { Effect } from "effect"
import { toProgram } from "../data.js"
import { constructor, type Method, methods } from "../interpreter/native.js"
import { type AstNode, InterpreterRuntimeError, rangeError } from "../interpreter/model.js"
import { ProgramArray, ProgramPromise, ProgramRegExp, record } from "../interpreter/objects.js"
import { containsOpaqueReference, typeofValue } from "../interpreter/references.js"
import { applyCollectionCallback, isSupportedCallback, type Runner } from "../interpreter/runner.js"
import { matchToValue, toHostRegex } from "./regexp.js"
import { coerceToNumber, coerceToString, coercion } from "./value.js"

// console is intercepted by the interpreter before reaching here.
const requireDataArgument = (name: string, index: number, arg: unknown, node: AstNode): unknown => {
  if (containsOpaqueReference(arg)) {
    throw new InterpreterRuntimeError(
      `String.${name} expects argument ${index + 1} to be a data value.`,
      node,
      "InvalidDataValue",
    )
  }
  return arg
}

const replaceAllNeedsGlobal = (pattern: RegExp, node: AstNode) => {
  if (!pattern.global) {
    throw new InterpreterRuntimeError(
      `String.replaceAll requires a regular expression with the global (g) flag: write /${pattern.source}/${pattern.flags}g, or use String.replace to replace only the first match.`,
      node,
    )
  }
}

const replaceWithCallback = <R>(
  runner: Runner<R>,
  value: string,
  name: "replace" | "replaceAll",
  args: Array<unknown>,
  node: AstNode,
): Effect.Effect<unknown, unknown, R> => {
  const protos = runner.prototypes
  const apply = applyCollectionCallback(runner, args[1], `String.${name}`, node)
  const matches: Array<{ readonly match: string; readonly offset: number; readonly args: Array<unknown> }> = []
  const collect = (...callbackArgs: Array<unknown>): string => {
    const match = callbackArgs[0]
    const groups = callbackArgs[callbackArgs.length - 1]
    const hasGroups = groups !== null && typeof groups === "object"
    const offset = callbackArgs[callbackArgs.length - (hasGroups ? 3 : 2)]
    if (typeof match !== "string" || typeof offset !== "number") {
      throw new InterpreterRuntimeError(`String.${name} produced an invalid replacement match.`, node)
    }
    if (hasGroups) callbackArgs[callbackArgs.length - 1] = record(protos.Object, groups as Record<string, unknown>)
    matches.push({ match, offset, args: callbackArgs })
    return match
  }

  const pattern = args[0]
  if (pattern instanceof ProgramRegExp) {
    if (name === "replaceAll") replaceAllNeedsGlobal(pattern.regex, node)
    if (name === "replace") value.replace(pattern.regex, collect)
    else value.replaceAll(pattern.regex, collect)
  } else {
    const search = coerceToString(requireDataArgument(name, 0, pattern, node))
    if (name === "replace") value.replace(search, collect)
    else value.replaceAll(search, collect)
  }

  return Effect.gen(function* () {
    const output: Array<string> = []
    let end = 0
    for (const match of matches) {
      const replacement = yield* apply(match.args)
      output.push(
        value.slice(end, match.offset),
        replacement instanceof ProgramPromise
          ? "[object Promise]"
          : coerceToString(toProgram(protos, replacement, `String.${name} replacer result`)),
      )
      end = match.offset + match.match.length
    }
    output.push(value.slice(end))
    return output.join("")
  })
}

export const stringGlobal = <R>(runner: Runner<R>) => {
  const protos = runner.prototypes
  const string = constructor<R>(protos, protos.String, {
    name: "String",
    length: 1,
    call: coercion(runner, "String").call,
  })
  const codeUnits = (name: string, op: (...codes: Array<number>) => string): Method => [
    name,
    1,
    (_, args, node) =>
      op(
        ...args.map((arg) => {
          if (typeof arg !== "number") {
            throw new InterpreterRuntimeError(`String.${name} expects number arguments.`, node)
          }
          return arg
        }),
      ),
  ]
  methods(protos, string, [
    codeUnits("fromCharCode", String.fromCharCode),
    codeUnits("fromCodePoint", String.fromCodePoint),
  ])

  const self = (thisValue: unknown, name: string, node: AstNode): string => {
    if (typeof thisValue === "string") return thisValue
    if (thisValue === null || thisValue === undefined) {
      throw new InterpreterRuntimeError(`String.prototype.${name} called on null or undefined.`, node)
    }
    return coerceToString(thisValue)
  }
  // Coerce arguments like native JS; opaque runtime references still reject.
  const str = (name: string, args: Array<unknown>, index: number, node: AstNode): string =>
    coerceToString(requireDataArgument(name, index, args[index], node))
  const num = (name: string, args: Array<unknown>, index: number, node: AstNode): number =>
    coerceToNumber(requireDataArgument(name, index, args[index], node))
  const optNum = (name: string, args: Array<unknown>, index: number, node: AstNode): number | undefined =>
    args[index] === undefined ? undefined : num(name, args, index, node)
  const optStr = (name: string, args: Array<unknown>, index: number, node: AstNode): string | undefined =>
    args[index] === undefined ? undefined : str(name, args, index, node)
  const rejectRegex = (name: string, args: Array<unknown>, node: AstNode): void => {
    if (args[0] instanceof ProgramRegExp) {
      throw new InterpreterRuntimeError(
        `String.${name} cannot take a regular expression; use regex.test(string) or String.search instead.`,
        node,
      )
    }
  }
  const simple = (
    name: string,
    length: number,
    op: (value: string, args: Array<unknown>, node: AstNode) => unknown,
  ): Method => [name, length, (thisValue, args, node) => op(self(thisValue, name, node), args, node)]
  const replace = (name: "replace" | "replaceAll") =>
    simple(name, 2, (value, args, node) => {
      if (isSupportedCallback(args[1])) return replaceWithCallback(runner, value, name, args, node)
      if (typeofValue(args[1]) === "function") {
        throw new InterpreterRuntimeError(
          `String.${name} cannot use this callable as a replacer; wrap it in an arrow function, e.g. (match) => tools.ns.tool(match).`,
          node,
        )
      }
      if (args[0] instanceof ProgramRegExp) {
        const pattern = args[0].regex
        const replacement = str(name, args, 1, node)
        if (name === "replaceAll") replaceAllNeedsGlobal(pattern, node)
        return name === "replace" ? value.replace(pattern, replacement) : value.replaceAll(pattern, replacement)
      }
      if (name === "replace") return value.replace(str(name, args, 0, node), str(name, args, 1, node))
      return value.replaceAll(str(name, args, 0, node), str(name, args, 1, node))
    })

  methods(protos, protos.String, [
    simple("toString", 0, (value) => value),
    simple("valueOf", 0, (value) => value),
    simple("toLowerCase", 0, (value) => value.toLowerCase()),
    simple("toUpperCase", 0, (value) => value.toUpperCase()),
    simple("trim", 0, (value) => value.trim()),
    simple("trimStart", 0, (value) => value.trimStart()),
    simple("trimLeft", 0, (value) => value.trimStart()),
    simple("trimEnd", 0, (value) => value.trimEnd()),
    simple("trimRight", 0, (value) => value.trimEnd()),
    // Locale/options are deliberately unsupported; comparison uses the host default locale.
    simple("localeCompare", 1, (value, args, node) => value.localeCompare(str("localeCompare", args, 0, node))),
    simple("normalize", 0, (value, args, node) => {
      const form = optStr("normalize", args, 0, node)
      try {
        return value.normalize(form)
      } catch {
        throw rangeError(
          `String.normalize expects the form "NFC", "NFD", "NFKC", or "NFKD" (got ${JSON.stringify(form)}).`,
          node,
        )
      }
    }),
    simple("split", 2, (value, args, node) => {
      const wrap = (parts: Array<string>) => new ProgramArray(protos.Array, parts)
      // Native: an undefined separator returns the whole string, not a split on "undefined",
      // unless the limit truncates to zero.
      const requestedLimit = optNum("split", args, 1, node)
      if (args[0] === undefined) {
        return wrap(requestedLimit !== undefined && requestedLimit >>> 0 === 0 ? [] : [value])
      }
      if (args[0] instanceof ProgramRegExp) return wrap(value.split(args[0].regex, requestedLimit))
      return wrap(
        value.split(str("split", args, 0, node), requestedLimit === undefined ? undefined : requestedLimit >>> 0),
      )
    }),
    simple("slice", 2, (value, args, node) =>
      value.slice(optNum("slice", args, 0, node), optNum("slice", args, 1, node)),
    ),
    simple("includes", 1, (value, args, node) => {
      rejectRegex("includes", args, node)
      return value.includes(str("includes", args, 0, node), optNum("includes", args, 1, node))
    }),
    simple("startsWith", 1, (value, args, node) => {
      rejectRegex("startsWith", args, node)
      return value.startsWith(str("startsWith", args, 0, node), optNum("startsWith", args, 1, node))
    }),
    simple("endsWith", 1, (value, args, node) => {
      rejectRegex("endsWith", args, node)
      return value.endsWith(str("endsWith", args, 0, node), optNum("endsWith", args, 1, node))
    }),
    simple("indexOf", 1, (value, args, node) =>
      value.indexOf(str("indexOf", args, 0, node), optNum("indexOf", args, 1, node)),
    ),
    simple("lastIndexOf", 1, (value, args, node) =>
      value.lastIndexOf(str("lastIndexOf", args, 0, node), optNum("lastIndexOf", args, 1, node)),
    ),
    replace("replace"),
    replace("replaceAll"),
    simple("match", 1, (value, args, node) => {
      const pattern = toHostRegex(args[0], "match", node)
      const matched = value.match(pattern)
      if (matched === null) return null
      // Preserve the own `index` and `groups` properties on non-global matches.
      if (pattern.global) return toProgram(protos, matched, "String.match result")
      return matchToValue(protos, matched)
    }),
    simple("matchAll", 1, (value, args, node) => {
      const pattern = toHostRegex(args[0], "matchAll", node, "g")
      if (!pattern.global) {
        throw new InterpreterRuntimeError(
          `String.matchAll requires a regular expression with the global (g) flag: write /${pattern.source}/${pattern.flags}g, or use String.match for a single match.`,
          node,
        )
      }
      return new ProgramArray(
        protos.Array,
        Array.from(value.matchAll(pattern), (match) => matchToValue(protos, match)),
      )
    }),
    simple("search", 1, (value, args, node) => value.search(toHostRegex(args[0], "search", node))),
    simple("repeat", 1, (value, args, node) => {
      const count = num("repeat", args, 0, node)
      if (!Number.isFinite(count) || count < 0) {
        throw rangeError("String.repeat expects a finite non-negative count.", node)
      }
      return value.repeat(count)
    }),
    simple("padStart", 1, (value, args, node) =>
      value.padStart(num("padStart", args, 0, node), optStr("padStart", args, 1, node)),
    ),
    simple("padEnd", 1, (value, args, node) =>
      value.padEnd(num("padEnd", args, 0, node), optStr("padEnd", args, 1, node)),
    ),
    simple("charAt", 1, (value, args, node) => value.charAt(optNum("charAt", args, 0, node) ?? 0)),
    simple("at", 1, (value, args, node) => value.at(optNum("at", args, 0, node) ?? 0)),
    simple("substring", 2, (value, args, node) =>
      value.substring(optNum("substring", args, 0, node) ?? 0, optNum("substring", args, 1, node)),
    ),
    simple("substr", 2, (value, args, node) =>
      value.substr(optNum("substr", args, 0, node) ?? 0, optNum("substr", args, 1, node)),
    ),
    simple("isWellFormed", 0, (value) => value.isWellFormed()),
    simple("toWellFormed", 0, (value) => value.toWellFormed()),
    simple("charCodeAt", 1, (value, args, node) => value.charCodeAt(optNum("charCodeAt", args, 0, node) ?? 0)),
    simple("codePointAt", 1, (value, args, node) => value.codePointAt(optNum("codePointAt", args, 0, node) ?? 0)),
    simple("concat", 1, (value, args, node) =>
      value.concat(...args.map((_, index) => str("concat", args, index, node))),
    ),
  ])
  return string
}
