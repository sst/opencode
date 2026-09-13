import { Effect } from "effect"
import { toProgram, ToolRuntimeError } from "../data.js"
import type { Prototypes } from "../interpreter/intrinsics.js"
import { constructor, fn, type Method, methods, prototypeFrom, receiver, requiresNew } from "../interpreter/native.js"
import { type AstNode, InterpreterRuntimeError, uriError } from "../interpreter/model.js"
import {
  defineAccessor,
  entries,
  isWrapper,
  ProgramArray,
  ProgramObject,
  ProgramURL,
  ProgramURLSearchParams,
} from "../interpreter/objects.js"
import { isRuntimeReference } from "../interpreter/references.js"
import { applyCollectionCallback, preserveConsumerError, type Runner } from "../interpreter/runner.js"
import { coerceToString } from "./value.js"

const urlProperties = [
  "href",
  "origin",
  "protocol",
  "username",
  "password",
  "host",
  "hostname",
  "port",
  "pathname",
  "search",
  "hash",
] as const

export const uriArgument = (protos: Prototypes, value: unknown, label: string): string =>
  coerceToString(toProgram(protos, value, label))

type UriFunction = "encodeURI" | "encodeURIComponent" | "decodeURI" | "decodeURIComponent"

const uriFunctions: Record<UriFunction, (value: string) => string> = {
  encodeURI,
  encodeURIComponent,
  decodeURI,
  decodeURIComponent,
}

export const uriGlobal = <R>(runner: Runner<R>, name: UriFunction) =>
  fn<R>(runner.prototypes, name, 1, (_, args, node) => {
    const value = uriArgument(runner.prototypes, args[0], `${name} input`)
    try {
      return uriFunctions[name](value)
    } catch (error) {
      throw uriError(
        `${name} received malformed URI data: ${error instanceof Error ? error.message : String(error)}`,
        node,
      )
    }
  })

const urlArgument = (protos: Prototypes, value: unknown, label: string): string =>
  value instanceof ProgramURL ? value.url.href : uriArgument(protos, value, label)

export const urlGlobal = <R>(runner: Runner<R>) => {
  const protos = runner.prototypes
  const proto = protos.URL
  const construct = (args: Array<unknown>, into: ProgramObject, node: AstNode): ProgramURL => {
    if (args.length === 0) {
      throw new InterpreterRuntimeError("new URL(...) requires a URL string and an optional base URL.", node)
    }
    const input = urlArgument(protos, args[0], "new URL input")
    const base = args[1] === undefined ? undefined : urlArgument(protos, args[1], "new URL base")
    try {
      return new ProgramURL(into, protos.URLSearchParams, new URL(input, base))
    } catch {
      throw new InterpreterRuntimeError(
        `new URL(...) received an invalid URL${base === undefined ? "" : " or base URL"}.`,
        node,
      )
    }
  }
  const url = constructor<R>(protos, proto, {
    name: "URL",
    length: 1,
    call: requiresNew("URL"),
    construct: (args, newTarget, node) => Effect.sync(() => construct(args, prototypeFrom(newTarget, proto), node)),
  })
  const parse = (name: "canParse" | "parse"): Method => [
    name,
    1,
    (_, args, node) => {
      if (args.length === 0) throw new InterpreterRuntimeError(`URL.${name} requires a URL argument.`, node)
      const input = urlArgument(protos, args[0], `URL.${name} input`)
      const base = args[1] === undefined ? undefined : urlArgument(protos, args[1], `URL.${name} base`)
      try {
        const parsed = new URL(input, base)
        return name === "canParse" ? true : new ProgramURL(proto, protos.URLSearchParams, parsed)
      } catch {
        return name === "canParse" ? false : null
      }
    },
  ]
  methods(protos, url, [parse("canParse"), parse("parse")])

  const self = (thisValue: unknown, name: string, node?: AstNode) =>
    receiver(ProgramURL, thisValue, `URL.prototype.${name}`, node)
  for (const name of urlProperties) {
    defineAccessor(
      proto,
      name,
      (thisValue) => self(thisValue, name).url[name],
      name === "origin"
        ? undefined
        : (thisValue, value) => {
            const target = self(thisValue, name)
            try {
              ;(target.url as unknown as Record<string, string>)[name] = uriArgument(protos, value, `URL.${name} value`)
            } catch (error) {
              if (error instanceof InterpreterRuntimeError || error instanceof ToolRuntimeError) throw error
              throw new InterpreterRuntimeError(`URL.${name} received an invalid value.`)
            }
          },
    )
  }
  defineAccessor(proto, "searchParams", (thisValue) => self(thisValue, "searchParams").searchParams)
  methods(protos, proto, [
    ["toString", 0, (thisValue, _, node) => self(thisValue, "toString", node).url.href],
    ["toJSON", 0, (thisValue, _, node) => self(thisValue, "toJSON", node).url.href],
  ])
  return url
}

const readPair = <R>(runner: Runner<R>, value: unknown, node: AstNode): Effect.Effect<Array<string>, unknown, R> =>
  Effect.gen(function* () {
    const cursor = yield* runner.syncIterator(value, node)
    if (cursor === undefined) {
      throw new InterpreterRuntimeError("new URLSearchParams(...) expects iterable [name, value] pairs.", node)
    }
    const items: Array<string> = []
    while (true) {
      const step = yield* cursor.next
      if (step.done) return items
      items.push(
        yield* preserveConsumerError(
          cursor,
          Effect.sync(() => uriArgument(runner.prototypes, step.value, "URLSearchParams pair value")),
        ),
      )
    }
  })

const constructURLSearchParams = <R>(
  runner: Runner<R>,
  init: unknown,
  proto: ProgramObject,
  node: AstNode,
): Effect.Effect<ProgramURLSearchParams, unknown, R> => {
  const wrap = (params: URLSearchParams) => new ProgramURLSearchParams(proto, params)
  if (init === undefined) return Effect.succeed(wrap(new URLSearchParams()))
  if (init instanceof ProgramURLSearchParams) return Effect.succeed(wrap(new URLSearchParams(init.params)))
  if (typeof init === "string") return Effect.succeed(wrap(new URLSearchParams(init)))
  if (init === null || typeof init === "number" || typeof init === "boolean") {
    return Effect.succeed(wrap(new URLSearchParams(coerceToString(init))))
  }
  return Effect.gen(function* () {
    const cursor = yield* runner.syncIterator(init, node)
    if (cursor !== undefined) {
      const pairs: Array<Array<string>> = []
      while (true) {
        const step = yield* cursor.next
        if (step.done) {
          if (pairs.some((entry) => entry.length !== 2)) {
            throw new InterpreterRuntimeError("new URLSearchParams(...) expects iterable [name, value] pairs.", node)
          }
          return wrap(new URLSearchParams(pairs.map((entry): [string, string] => [entry[0] ?? "", entry[1] ?? ""])))
        }
        pairs.push(yield* preserveConsumerError(cursor, readPair(runner, step.value, node)))
      }
    }
    if (isRuntimeReference(init)) {
      throw new InterpreterRuntimeError(
        "new URLSearchParams(...) expects a query string, data object, or synchronous iterable pairs.",
        node,
      )
    }
    if (isWrapper(init)) return wrap(new URLSearchParams())
    if (!(init instanceof ProgramObject)) {
      throw new InterpreterRuntimeError(
        "new URLSearchParams(...) expects a query string, data object, iterable pairs, or URLSearchParams.",
        node,
      )
    }
    return wrap(
      new URLSearchParams(Object.fromEntries(entries(init).map(([key, value]) => [key, coerceToString(value)]))),
    )
  })
}

export const urlSearchParamsGlobal = <R>(runner: Runner<R>) => {
  const protos = runner.prototypes
  const proto = protos.URLSearchParams
  const searchParams = constructor<R>(protos, proto, {
    name: "URLSearchParams",
    call: requiresNew("URLSearchParams"),
    construct: (args, newTarget, node) =>
      constructURLSearchParams(runner, args[0], prototypeFrom(newTarget, proto), node),
  })
  const self = (thisValue: unknown, name: string, node?: AstNode) =>
    receiver(ProgramURLSearchParams, thisValue, `URLSearchParams.prototype.${name}`, node)
  const wrap = (items: Array<unknown>) => new ProgramArray(protos.Array, items)
  const arg = (name: string, args: Array<unknown>, index: number): string =>
    uriArgument(protos, args[index], `URLSearchParams.${name} argument ${index + 1}`)
  const requireArgs = (name: string, args: Array<unknown>, count: number, node: AstNode): void => {
    if (args.length < count) {
      throw new InterpreterRuntimeError(
        `URLSearchParams.${name} requires ${count} argument${count === 1 ? "" : "s"}.`,
        node,
      )
    }
  }
  defineAccessor(proto, "size", (thisValue) => self(thisValue, "size").params.size)
  methods(protos, proto, [
    [
      "append",
      2,
      (thisValue, args, node) => {
        requireArgs("append", args, 2, node)
        self(thisValue, "append", node).params.append(arg("append", args, 0), arg("append", args, 1))
        return undefined
      },
    ],
    [
      "delete",
      1,
      (thisValue, args, node) => {
        requireArgs("delete", args, 1, node)
        const params = self(thisValue, "delete", node).params
        if (args[1] !== undefined) params.delete(arg("delete", args, 0), arg("delete", args, 1))
        else params.delete(arg("delete", args, 0))
        return undefined
      },
    ],
    [
      "get",
      1,
      (thisValue, args, node) => {
        requireArgs("get", args, 1, node)
        return self(thisValue, "get", node).params.get(arg("get", args, 0))
      },
    ],
    [
      "getAll",
      1,
      (thisValue, args, node) => {
        requireArgs("getAll", args, 1, node)
        return wrap(self(thisValue, "getAll", node).params.getAll(arg("getAll", args, 0)))
      },
    ],
    [
      "has",
      1,
      (thisValue, args, node) => {
        requireArgs("has", args, 1, node)
        const params = self(thisValue, "has", node).params
        return args[1] !== undefined
          ? params.has(arg("has", args, 0), arg("has", args, 1))
          : params.has(arg("has", args, 0))
      },
    ],
    [
      "set",
      2,
      (thisValue, args, node) => {
        requireArgs("set", args, 2, node)
        self(thisValue, "set", node).params.set(arg("set", args, 0), arg("set", args, 1))
        return undefined
      },
    ],
    [
      "sort",
      0,
      (thisValue, _, node) => {
        self(thisValue, "sort", node).params.sort()
        return undefined
      },
    ],
    ["keys", 0, (thisValue, _, node) => wrap(Array.from(self(thisValue, "keys", node).params.keys()))],
    ["values", 0, (thisValue, _, node) => wrap(Array.from(self(thisValue, "values", node).params.values()))],
    [
      "entries",
      0,
      (thisValue, _, node) =>
        wrap(Array.from(self(thisValue, "entries", node).params.entries(), ([key, value]) => wrap([key, value]))),
    ],
    ["toString", 0, (thisValue, _, node) => self(thisValue, "toString", node).params.toString()],
    [
      "forEach",
      1,
      (thisValue, args, node) => {
        requireArgs("forEach", args, 1, node)
        const target = self(thisValue, "forEach", node)
        const apply = applyCollectionCallback(runner, args[0], "URLSearchParams.forEach", node)
        return Effect.gen(function* () {
          for (const [key, value] of Array.from(target.params.entries())) yield* apply([value, key, target])
          return undefined
        })
      },
    ],
  ])
  return searchParams
}
