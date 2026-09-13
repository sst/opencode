import { Cause, Effect, Exit, Formatter, Schema } from "effect"
import { fromData, toData, ToolRuntimeError } from "./data.js"
import type { Prototypes } from "./interpreter/intrinsics.js"
import { toolError } from "./tool-error.js"
import {
  decodeInput as decodeToolInput,
  decodeOutput as decodeToolOutput,
  identifierSegment,
  inputProperties,
  inputTypeScript,
  isEmptyInput,
  outputTypeScript,
} from "./tool-schema.js"
import { isNamespace, type Namespace } from "./namespace.js"
import { isTool, type Tool } from "./tool.js"
import type { Tools } from "./tools.js"

export const compareText = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0)

export type Services<T> = ServicesOf<T, []>

type ServicesOf<T, Depth extends ReadonlyArray<unknown>> = Depth["length"] extends 8
  ? never
  : T extends {
        readonly _tag: "CodeModeTool"
        readonly execute: (input: unknown) => Effect.Effect<unknown, unknown, infer R>
      }
    ? R
    : T extends object
      ? string extends keyof T
        ? ServicesOf<T[string], [...Depth, unknown]>
        : ServicesOf<T[keyof T], [...Depth, unknown]>
      : never

export type ToolCall = {
  readonly name: string
}

export type ToolCallStarted = {
  readonly index: number
  readonly name: string
  readonly input: unknown
}

export type ToolCallEnded = {
  readonly index: number
  readonly name: string
  readonly input: unknown
  readonly durationMs: number
  readonly outcome: "success" | "failure" | "interrupted"
  readonly message?: string
}

export type ToolCallHooks<R = never> = {
  /** Observes decoded tool input immediately before tool execution. */
  readonly onToolCallStart?: ((call: ToolCallStarted) => Effect.Effect<void, never, R>) | undefined
  /** Observes each admitted tool call as it succeeds, fails, or is interrupted. */
  readonly onToolCallEnd?: ((call: ToolCallEnded) => Effect.Effect<void, never, R>) | undefined
}

export type ToolDescription = {
  readonly path: string
  readonly description: string
  readonly signature: string
}

const defaultSearchLimit = 10
const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0))
const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const SearchInput = Schema.Struct({
  query: Schema.optionalKey(Schema.String),
  namespace: Schema.optionalKey(Schema.String),
  limit: Schema.optionalKey(PositiveInt),
  offset: Schema.optionalKey(NonNegativeInt),
})
const SearchItem = Schema.Struct({
  path: Schema.String,
  description: Schema.String,
  signature: Schema.String,
})
const SearchOutput = Schema.Struct({
  items: Schema.Array(SearchItem),
  remaining: NonNegativeInt,
  next: Schema.NullOr(Schema.Struct({ offset: NonNegativeInt })),
})
export const toolExpression = (path: string) =>
  "tools" +
  path
    .split(".")
    .map((segment) => (identifierSegment.test(segment) ? `.${segment}` : `[${JSON.stringify(segment)}]`))
    .join("")

export class ToolReference {
  constructor(readonly path: ReadonlyArray<string>) {}
}

// Dots in tool names are namespace separators; the last tool for a canonical path wins.
type ToolNode<R> = {
  tool?: Tool<R>
  namespace?: Namespace<R>
  readonly children: Map<string, ToolNode<R>>
}

const toolTrie = <R>(tools: Tools<R>): ToolNode<R> => {
  const root: ToolNode<R> = { children: new Map() }
  const insert = (node: ToolNode<R>, group: Tools<R>): void => {
    for (const [name, value] of Object.entries(group)) {
      let current = node
      for (const segment of name.split(".")) {
        if (segment === "") throw new TypeError(`Tool name '${name}' contains an empty segment.`)
        const child = current.children.get(segment) ?? { children: new Map() }
        current.children.set(segment, child)
        current = child
      }
      if (isTool<R>(value)) current.tool = value
      else if (isNamespace<R>(value)) {
        current.namespace = value
        insert(current, value.tools)
      } else insert(current, value)
    }
  }
  insert(root, tools)
  return root
}

const canonicalSegments = (path: ReadonlyArray<string>): ReadonlyArray<string> =>
  path.flatMap((segment) => segment.split("."))

type VisibleTool<R> = {
  readonly path: string
  readonly tool: Tool<R>
  readonly namespaces: ReadonlyArray<Namespace<R>>
}

const flattenTools = <R>(
  node: ToolNode<R>,
  path: ReadonlyArray<string> = [],
  namespaces: ReadonlyArray<Namespace<R>> = [],
): Array<VisibleTool<R>> => {
  const next = node.namespace === undefined ? namespaces : [...namespaces, node.namespace]
  return [
    ...(node.tool === undefined ? [] : [{ path: path.join("."), tool: node.tool, namespaces: next }]),
    ...Array.from(node.children).flatMap(([name, child]) => flattenTools(child, [...path, name], next)),
  ]
}

const describeTool = <R>(visible: VisibleTool<R>): ToolDescription => ({
  path: visible.path,
  description: visible.tool.description,
  signature: isEmptyInput(visible.tool)
    ? `${toolExpression(visible.path)}(): Promise<${outputTypeScript(visible.tool, true)}>`
    : `${toolExpression(visible.path)}(input: ${inputTypeScript(visible.tool, true)}): Promise<${outputTypeScript(visible.tool, true)}>`,
})

/** Tools indexed once per runtime: the lookup trie plus the model-facing catalog and search index. */
export type Prepared<R = never> = {
  readonly root: ToolNode<R>
  readonly catalog: ReadonlyArray<ToolDescription>
  readonly searchIndex: ReadonlyArray<SearchEntry>
}

export type SearchEntry = {
  readonly description: ToolDescription
  readonly searchText: string
}

const tokenize = (query: string): Array<string> =>
  query
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length > 0 && term !== "*")

const termForms = (term: string): Array<string> => {
  const forms = [term]
  if (term.endsWith("es") && term.length > 3) forms.push(term.slice(0, -2))
  if (term.endsWith("s") && term.length > 2) forms.push(term.slice(0, -1))
  return forms
}

const makeSearchTool = (searchIndex: ReadonlyArray<SearchEntry>): Tool => ({
  _tag: "CodeModeTool",
  description: "Search available tools",
  input: SearchInput,
  output: SearchOutput,
  execute: (input) =>
    Effect.sync(() => {
      const request = input as typeof SearchInput.Type
      const query = request.query ?? ""
      const offset = request.offset ?? 0
      const scoped =
        request.namespace === undefined
          ? searchIndex
          : searchIndex.filter(
              (entry) =>
                entry.description.path === request.namespace ||
                entry.description.path.startsWith(`${request.namespace}.`),
            )
      const trimmed = query.trim()
      const pathQuery = trimmed.startsWith("tools.") ? trimmed.slice("tools.".length) : trimmed
      const exact =
        pathQuery === ""
          ? undefined
          : scoped.find(
              (entry) => entry.description.path === pathQuery || toolExpression(entry.description.path) === trimmed,
            )
      const terms = tokenize(query).map(termForms)
      const ranked =
        exact !== undefined
          ? [exact]
          : scoped
              .map((entry) => {
                const path = entry.description.path.toLowerCase()
                const description = entry.description.description.toLowerCase()
                const score = terms.reduce(
                  (total, forms) =>
                    total +
                    (forms.some((form) => path === form || path.endsWith(`.${form}`)) ? 20 : 0) +
                    (forms.some((form) => path.includes(form)) ? 8 : 0) +
                    (forms.some((form) => description.includes(form)) ? 4 : 0) +
                    (forms.some((form) => entry.searchText.includes(form)) ? 2 : 0),
                  0,
                )
                return { entry, score }
              })
              .filter(({ score }) => terms.length === 0 || score > 0)
              .sort(
                (left, right) =>
                  right.score - left.score || compareText(left.entry.description.path, right.entry.description.path),
              )
              .map(({ entry }) => entry)
      const items = ranked.slice(offset, offset + (request.limit ?? defaultSearchLimit)).map(({ description }) => ({
        ...description,
        path: toolExpression(description.path),
      }))
      const remaining = Math.max(0, ranked.length - offset - items.length)
      return {
        items,
        remaining,
        next: remaining > 0 ? { offset: offset + items.length } : null,
      }
    }),
})

/** Exact callable signature of the built-in `search` function, for host-owned instructions. */
export const searchSignature = (() => {
  const tool = makeSearchTool([])
  return `search(input: ${inputTypeScript(tool, true)}): ${outputTypeScript(tool, true)}`
})()

const toSearchEntry = <R>(visible: VisibleTool<R>): SearchEntry => ({
  description: describeTool(visible),
  searchText: [
    visible.path,
    visible.tool.description,
    ...visible.namespaces.flatMap((namespace) => (namespace.description === undefined ? [] : [namespace.description])),
    ...inputProperties(visible.tool).flatMap(({ name, description: property }) =>
      property === undefined ? [name] : [name, property],
    ),
  ]
    .join("\n")
    .toLowerCase(),
})

export const prepare = <R>(tools: Tools<R>): Prepared<R> => {
  const root = toolTrie(tools)
  // Discovery bytes are durable instructions, so order only after canonical-path collisions settle.
  const visible = flattenTools(root).sort((left, right) => compareText(left.path, right.path))
  return {
    root,
    catalog: visible.map(describeTool),
    searchIndex: visible.map(toSearchEntry),
  }
}

const lookup = <R>(root: ToolNode<R>, segments: ReadonlyArray<string>): ToolNode<R> | undefined =>
  segments.reduce<ToolNode<R> | undefined>((node, segment) => node?.children.get(segment), root)

const namespaceKeys = <R>(root: ToolNode<R>, path: ReadonlyArray<string>): ReadonlyArray<string> => {
  const segments = canonicalSegments(path)
  const node = lookup(root, segments)
  if (node === undefined) {
    throw new ToolRuntimeError("UnknownTool", `Unknown tool namespace '${segments.join(".")}'.`)
  }
  return Array.from(node.children.keys())
}

const resolve = <R>(root: ToolNode<R>, path: ReadonlyArray<string>): Tool<R> => {
  const segments = canonicalSegments(path)
  const node = lookup(root, segments)
  if (node === undefined) {
    throw new ToolRuntimeError("UnknownTool", `Unknown tool '${segments.join(".")}'.`, [
      "The tool may have been removed or renamed. Use search to find available tools.",
    ])
  }
  if (node.tool === undefined) {
    throw new ToolRuntimeError("UnknownTool", `Tool '${segments.join(".")}' is not callable.`)
  }
  return node.tool
}

export type ToolRuntime<R = never> = {
  readonly calls: Array<ToolCall>
  readonly execute: (path: ReadonlyArray<string>, args: Array<unknown>) => Effect.Effect<unknown, unknown, R>
  readonly search: (args: Array<unknown>) => Effect.Effect<unknown, unknown, R>
  readonly keys: (path: ReadonlyArray<string>) => ReadonlyArray<string>
}

/** Per-execution call state over tools prepared once for the runtime. */
export const make = <R>(
  prepared: Prepared<R>,
  prototypes: Prototypes,
  maxToolCalls: number | undefined,
  hooks?: ToolCallHooks<R>,
): ToolRuntime<R> => {
  const calls: Array<ToolCall> = []
  const root = prepared.root
  const searchTool = makeSearchTool(prepared.searchIndex)

  const observeEnd = <A, E>(effect: Effect.Effect<A, E, R>, call: ToolCallStarted): Effect.Effect<A, E, R> => {
    const onEnd = hooks?.onToolCallEnd
    if (onEnd === undefined) return effect
    const startedAt = Date.now()
    return effect.pipe(
      Effect.onExit((exit) => {
        const durationMs = Date.now() - startedAt
        if (Exit.isSuccess(exit)) return onEnd({ ...call, durationMs, outcome: "success" })
        if (Cause.hasInterruptsOnly(exit.cause)) return onEnd({ ...call, durationMs, outcome: "interrupted" })
        const error = Cause.squash(exit.cause)
        const message = error instanceof Error ? error.message : Cause.pretty(exit.cause)
        return onEnd({ ...call, durationMs, outcome: "failure", message })
      }),
    )
  }

  const recordCall = (call: ToolCall): void => {
    if (maxToolCalls !== undefined && calls.length >= maxToolCalls) {
      throw new ToolRuntimeError("ToolCallLimitExceeded", `Execution exceeded its tool-call limit of ${maxToolCalls}.`)
    }
    calls.push(call)
  }

  const executeTool = (name: string, tool: Tool<R>, externalArgs: Array<unknown>) =>
    Effect.gen(function* () {
      const normalized = externalArgs.length === 0 ? [{}] : externalArgs
      if (normalized.length !== 1)
        throw new ToolRuntimeError("InvalidToolInput", `Tool '${name}' expects at most one input object.`)
      const input = yield* Effect.try({
        try: () => decodeToolInput(tool, normalized[0]),
        catch: (cause) =>
          new ToolRuntimeError(
            "InvalidToolInput",
            `Invalid input for tool '${name}': ${String(cause)}`,
            name === "search" ? [] : ["The signature may have changed. Use search to get the current signature."],
          ),
      })
      const index = yield* Effect.sync(() => {
        recordCall({ name })
        return calls.length - 1
      })
      const call = { index, name, input }
      return yield* observeEnd(
        Effect.gen(function* () {
          if (hooks?.onToolCallStart !== undefined) yield* hooks.onToolCallStart(call)
          const raw = yield* Effect.suspend(() => tool.execute(input)).pipe(
            Effect.catchCause((cause) => {
              if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt
              return Effect.fail(
                toolError(
                  Cause.prettyErrors(cause)
                    .map((error) => (error.cause ? Formatter.format(error) : error.message || error.name))
                    .join("\n"),
                ),
              )
            }),
          )
          return yield* Effect.try({
            try: () => fromData(prototypes, decodeToolOutput(tool, raw), `Result from tool '${name}'`),
            catch: (cause) => new ToolRuntimeError("InvalidToolOutput", `Invalid output from tool '${name}': ${cause}`),
          })
        }),
        call,
      )
    })

  return {
    calls,
    keys: (path) => namespaceKeys(root, path),
    search: (args) =>
      Effect.suspend(() =>
        executeTool(
          "search",
          searchTool,
          args.map((arg) => toData(arg, "Arguments for tool 'search'")),
        ),
      ),
    execute: (path, args) =>
      Effect.gen(function* () {
        const name = canonicalSegments(path).join(".")
        const externalArgs = args.map((arg) => toData(arg, `Arguments for tool '${name}'`))
        const tool = resolve(root, path)
        return yield* executeTool(name, tool, externalArgs)
      }),
  }
}

export * as ToolRuntime from "./tool-runtime.js"
