import { ToolReference } from "../tool-runtime.js"
import { type AstNode, InterpreterRuntimeError } from "./model.js"
import {
  Callable,
  getOwn,
  isWrapper,
  ownKeys,
  ProgramArray,
  ProgramDate,
  ProgramGenerator,
  ProgramMap,
  ProgramObject,
  ProgramPromise,
  ProgramRegExp,
  ProgramSet,
  ProgramURL,
  ProgramURLSearchParams,
} from "./objects.js"

/** Values that cannot cross the data boundary. */
export const isRuntimeReference = (value: unknown): boolean =>
  value instanceof Callable ||
  value instanceof ProgramGenerator ||
  value instanceof ToolReference ||
  value instanceof ProgramPromise ||
  isWrapper(value)

function* childValues(value: object): Generator {
  if (!(value instanceof ProgramObject)) return
  for (const key of ownKeys(value)) yield getOwn(value, key)
}

// Depth-first search over a value tree. `match` stops the walk; `skip` prunes a subtree without matching it.
const find = (
  value: unknown,
  match: (current: unknown) => boolean,
  skip: (current: unknown) => boolean,
  seen: Set<object>,
): boolean => {
  const pending: Array<Iterator<unknown>> = [[value].values()]
  while (pending.length > 0) {
    const next = pending.at(-1)!.next()
    if (next.done) {
      pending.pop()
      continue
    }
    const current = next.value
    if (match(current)) return true
    if (current === null || typeof current !== "object" || skip(current) || seen.has(current)) continue
    seen.add(current)
    pending.push(childValues(current))
  }
  return false
}

const never = () => false

export const containsRuntimeReference = (value: unknown): boolean => find(value, isRuntimeReference, never, new Set())

// Wrapper values are data here, not opaque interpreter references.
export const containsOpaqueReference = (value: unknown): boolean =>
  find(value, (current) => !isWrapper(current) && isRuntimeReference(current), isWrapper, new Set())

// Reject cycles before mutation so later boundary walks remain safe.
export const rejectCircularInsertion = (
  container: object,
  value: unknown,
  label: string,
  node: AstNode,
  seen = new Set<object>(),
): void => {
  if (find(value, (current) => current === container, isRuntimeReference, seen)) {
    throw new InterpreterRuntimeError(`${label} contains a circular value.`, node, "InvalidDataValue")
  }
}

export const describeValue = (value: unknown): string => {
  if (value === null || value === undefined) return String(value)
  if (value instanceof ProgramArray) return "an array"
  if (value instanceof ProgramPromise) return "an un-awaited Promise"
  if (value instanceof ToolReference) return "a tool reference"
  if (value instanceof ProgramDate) return "a Date"
  if (value instanceof ProgramRegExp) return "a RegExp"
  if (value instanceof ProgramMap) return "a Map"
  if (value instanceof ProgramSet) return "a Set"
  if (value instanceof ProgramURL) return "a URL"
  if (value instanceof ProgramURLSearchParams) return "a URLSearchParams"
  if (value instanceof ProgramGenerator) return "a generator"
  if (isRuntimeReference(value)) return "a function"
  if (typeof value === "object") return "a data object"
  return `a ${typeof value}`
}

export const typeofValue = (value: unknown): string => {
  if (value instanceof Callable) return "function"
  if (value instanceof ToolReference) return value.path.length > 0 ? "function" : "object"
  return typeof value
}
