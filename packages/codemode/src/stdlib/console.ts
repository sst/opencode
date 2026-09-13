import { toData, toProgram } from "../data.js"
import type { Prototypes } from "../interpreter/intrinsics.js"
import { type Method, methods } from "../interpreter/native.js"
import {
  entries,
  get,
  ProgramArray,
  ProgramDate,
  ProgramMap,
  ProgramObject,
  ProgramPromise,
  ProgramRegExp,
  ProgramSet,
  ProgramURL,
  ProgramURLSearchParams,
} from "../interpreter/objects.js"
import { containsOpaqueReference, containsRuntimeReference, isRuntimeReference } from "../interpreter/references.js"
import type { Runner } from "../interpreter/runner.js"
import { coerceToString } from "./value.js"

const consoleMethods = ["log", "info", "debug", "warn", "error", "dir", "table"]

/** Captured console: every method appends one formatted line to `logs`. */
export const consoleGlobal = <R>(runner: Runner<R>, logs: Array<string>) => {
  const protos = runner.prototypes
  const console = new ProgramObject(protos.Object)
  methods(
    protos,
    console,
    consoleMethods.map(
      (name): Method => [
        name,
        0,
        (_, args) => {
          logs.push(formatConsoleMessage(protos, name, args))
          return undefined
        },
      ],
    ),
  )
  return console
}

const MAX_CONSOLE_DEPTH = 32

const formatConsoleMessage = (protos: Prototypes, name: string, args: Array<unknown>): string => {
  if (name === "dir") return args.length === 0 ? "undefined" : formatConsoleArgument(args[0])
  if (name === "table") return formatConsoleTable(protos, args[0], args[1])
  const prefix = name === "warn" ? "[warn] " : name === "error" ? "[error] " : name === "debug" ? "[debug] " : ""
  return `${prefix}${args.map((arg) => formatConsoleArgument(arg)).join(" ")}`
}

const formatConsoleArgument = (value: unknown): string => {
  if (value === undefined) return "undefined"
  if (typeof value === "string") return value
  return formatConsoleValue(value, new Set(), 0)
}

const formatConsoleValue = (value: unknown, seen: Set<object>, depth: number): string => {
  if (value === null || value === undefined) return "null"
  if (typeof value === "string") return JSON.stringify(value)
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  if (typeof value !== "object") return String(value)
  if (value instanceof ProgramPromise) return "[Promise (await it to get its value)]"
  if (value instanceof ProgramDate) return coerceToString(value)
  if (value instanceof ProgramRegExp) return coerceToString(value)
  if (value instanceof ProgramURL) return coerceToString(value)
  if (value instanceof ProgramURLSearchParams) return coerceToString(value)
  if (depth > MAX_CONSOLE_DEPTH) return "..."
  if (seen.has(value)) return "[Circular]"
  if (value instanceof ProgramMap) {
    seen.add(value)
    try {
      const items = Array.from(value.map.entries(), ([key, item]) => `[${formatItems([key, item], seen, depth + 1)}]`)
      return `Map(${value.map.size}) [${items.join(",")}]`
    } finally {
      seen.delete(value)
    }
  }
  if (value instanceof ProgramSet) {
    seen.add(value)
    try {
      return `Set(${value.set.size}) [${formatItems([...value.set.values()], seen, depth + 1)}]`
    } finally {
      seen.delete(value)
    }
  }
  if (isRuntimeReference(value)) return "[opaque reference]"
  seen.add(value)
  try {
    if (value instanceof ProgramArray) return `[${formatItems(value.items, seen, depth + 1)}]`
    if (!(value instanceof ProgramObject)) return "[object Object]"
    return `{${entries(value)
      .map(([key, item]) => `${JSON.stringify(key)}:${formatConsoleValue(item, seen, depth + 1)}`)
      .join(",")}}`
  } finally {
    seen.delete(value)
  }
}

const formatItems = (items: Array<unknown>, seen: Set<object>, depth: number): string =>
  items.map((item) => formatConsoleValue(item, seen, depth)).join(",")

const formatConsoleTable = (protos: Prototypes, value: unknown, columnsArgument: unknown): string => {
  if (value === undefined) return "undefined"
  if (containsOpaqueReference(value)) return "[opaque reference]"
  const data = toProgram(protos, value, "console.table argument")
  const columns = consoleTableColumns(columnsArgument)
  const rows = consoleTableRows(data, columns)
  const keys = columns ?? Array.from(new Set(rows.flatMap((row) => Object.keys(row.values))))
  const header = ["(index)", ...keys].join("\t")
  return [
    header,
    ...rows.map((row) => [row.index, ...keys.map((key) => formatConsoleTableCell(row.values[key]))].join("\t")),
  ].join("\n")
}

const consoleTableColumns = (value: unknown): ReadonlyArray<string> | undefined => {
  if (value === undefined) return undefined
  if (containsRuntimeReference(value)) return undefined
  const columns = toData(value, "console.table columns", "result")
  return Array.isArray(columns) ? columns.map((column) => String(column)) : undefined
}

const consoleTableRows = (
  data: unknown,
  columns: ReadonlyArray<string> | undefined,
): Array<{ readonly index: string; readonly values: Record<string, unknown> }> => {
  if (data instanceof ProgramArray) {
    return data.items.map((item, index) => ({ index: String(index), values: consoleTableValues(item, columns) }))
  }
  if (data instanceof ProgramObject) {
    return entries(data).map(([index, item]) => ({ index, values: consoleTableValues(item, columns) }))
  }
  return [{ index: "0", values: { Value: data } }]
}

const consoleTableValues = (value: unknown, columns: ReadonlyArray<string> | undefined): Record<string, unknown> => {
  if (value instanceof ProgramObject && !(value instanceof ProgramArray)) {
    if (columns !== undefined) return Object.fromEntries(columns.map((column) => [column, get(value, column)]))
    return Object.fromEntries(entries(value))
  }
  return { Value: value }
}

const formatConsoleTableCell = (value: unknown): string => {
  if (value === undefined) return ""
  if (typeof value === "string") return value
  return formatConsoleValue(value, new Set(), 0)
}
