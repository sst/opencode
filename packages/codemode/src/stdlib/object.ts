import { Effect } from "effect"
import { toProgram } from "../data.js"
import { constructor, methods, receiver } from "../interpreter/native.js"
import {
  type AstNode,
  AsyncIteratorSymbol,
  invalidData,
  IteratorSymbol,
  rangeError,
  typeError,
} from "../interpreter/model.js"
import {
  Callable,
  define,
  entries,
  enumerableKeys,
  getOwn,
  hasOwn,
  hasPrototype,
  hidden,
  keys,
  own,
  ProgramArray,
  ProgramDate,
  ProgramError,
  ProgramObject,
  ProgramPromise,
  ProgramRegExp,
  set,
} from "../interpreter/objects.js"
import { containsOpaqueReference, describeValue, rejectCircularInsertion } from "../interpreter/references.js"
import { preserveConsumerError, type Runner } from "../interpreter/runner.js"
import { ToolReference } from "../tool-runtime.js"
import { groupBy } from "./collections.js"
import { coerceToString } from "./value.js"

// ToObject for enumeration.
export const enumerableSource = <R>(
  runner: Runner<R>,
  label: string,
  value: unknown,
  node?: AstNode,
): ProgramObject => {
  if (value === null || value === undefined) {
    throw typeError(`${label} cannot convert ${describeValue(value)} to an object.`, node)
  }
  if (value instanceof ProgramPromise) {
    throw invalidData(`${label} received an un-awaited Promise; await it before inspecting the result.`, node)
  }
  if (value instanceof ToolReference) {
    throw invalidData(
      `${label} cannot read tool references: they are not plain data. Use Object.keys(tools) for names, or search({ query }) for signatures.`,
      node,
    )
  }
  if (typeof value === "string") return new ProgramArray(runner.prototypes.Array, [...value])
  if (value instanceof ProgramObject) return value
  return new ProgramObject(runner.prototypes.Object)
}

export const objectAssign = <R>(runner: Runner<R>, args: Array<unknown>): unknown => {
  const target = args[0]
  // JS would box a primitive target; wrappers and primitives cannot hold fields here.
  if (!(target instanceof ProgramObject)) {
    throw typeError(`Object.assign expects a data object or array target, received ${describeValue(target)}.`)
  }
  const seen = new Set<object>()
  for (const source of args.slice(1)) {
    if (source === null || source === undefined) continue
    const from = enumerableSource(runner, "Object.assign(...)", source)
    for (const key of enumerableKeys(from)) {
      rejectCircularInsertion(target, getOwn(from, key), "Object.assign result", seen)
      if (!set(target, key, getOwn(from, key))) {
        if (target instanceof ProgramArray && key === "length") throw rangeError("Invalid array length")
        throw typeError(`Cannot assign to read only property '${String(key)}'.`)
      }
    }
  }
  return target
}

const objectFromEntries = <R>(runner: Runner<R>, source: unknown): Effect.Effect<ProgramObject, unknown, R> => {
  const out = new ProgramObject(runner.prototypes.Object)
  return Effect.gen(function* () {
    const cursor = yield* runner.syncIterator(source)
    if (cursor === undefined) {
      throw typeError("Object.fromEntries expects a synchronous iterable of entries.")
    }
    while (true) {
      const step = yield* cursor.next
      if (step.done) return out
      yield* preserveConsumerError(
        cursor,
        Effect.sync(() => {
          if (!(step.value instanceof ProgramObject) || containsOpaqueReference(step.value)) {
            throw typeError("Object.fromEntries expects [key, value] entry objects.")
          }
          define(out, coerceToString(getOwn(step.value, 0)), getOwn(step.value, 1))
        }),
      )
    }
  })
}

export const classTag = (value: unknown): string => {
  if (value === null) return "Null"
  if (value === undefined) return "Undefined"
  if (value instanceof ProgramArray) return "Array"
  if (value instanceof Callable) return "Function"
  if (value instanceof ProgramError) return "Error"
  if (value instanceof ProgramDate) return "Date"
  if (value instanceof ProgramRegExp) return "RegExp"
  if (typeof value === "string") return "String"
  if (typeof value === "number") return "Number"
  if (typeof value === "boolean") return "Boolean"
  return "Object"
}

const propertyKey = (value: unknown): PropertyKey =>
  value === AsyncIteratorSymbol || value === IteratorSymbol ? value : coerceToString(value)

// Object constructs identically with or without new, like JS. Only `keys` copies its result into the
// program; `values`, `entries`, `assign`, and `fromEntries` hand back the program's own values.
export const objectGlobal = <R>(
  runner: Runner<R>,
  toolKeys: (path: ReadonlyArray<string>) => ReadonlyArray<string>,
) => {
  const protos = runner.prototypes
  const construct = (args: Array<unknown>): unknown => {
    const first = args[0]
    if (first === null || first === undefined) return new ProgramObject(protos.Object)
    if (typeof first === "object") return first
    throw typeError(`Object(${typeof first}) wrapper objects are not supported; use the primitive value directly.`)
  }
  const object = constructor<R>(protos, protos.Object, {
    name: "Object",
    length: 1,
    call: (_, args) => Effect.sync(() => construct(args)),
    construct: (args) => Effect.sync(() => construct(args)),
  })
  methods(protos, object, [
    [
      "keys",
      1,
      (_, args) =>
        toProgram(
          protos,
          args[0] instanceof ToolReference
            ? [...toolKeys(args[0].path)]
            : keys(enumerableSource(runner, "Object.keys(...)", args[0])),
          "Object.keys result",
        ),
    ],
    [
      "values",
      1,
      (_, args) =>
        new ProgramArray(
          protos.Array,
          entries(enumerableSource(runner, "Object.values(...)", args[0])).map((entry) => entry[1]),
        ),
    ],
    [
      "entries",
      1,
      (_, args) =>
        new ProgramArray(
          protos.Array,
          entries(enumerableSource(runner, "Object.entries(...)", args[0])).map(
            (entry) => new ProgramArray(protos.Array, entry),
          ),
        ),
    ],
    ["hasOwn", 2, (_, args) => hasOwn(enumerableSource(runner, "Object.hasOwn(...)", args[0]), propertyKey(args[1]))],
    [
      "is",
      2,
      (_, args) => {
        if (containsOpaqueReference(args[0]) || containsOpaqueReference(args[1])) {
          throw invalidData("Object.is requires data values.")
        }
        return Object.is(args[0], args[1])
      },
    ],
    ["assign", 2, (_, args) => objectAssign(runner, args)],
    ["fromEntries", 1, (_, args) => objectFromEntries(runner, args[0])],
  ])
  define(object, "groupBy", groupBy(runner, "Object"), hidden)
  methods(protos, protos.Object, [
    [
      "hasOwnProperty",
      1,
      (thisValue, args) =>
        hasOwn(receiver(ProgramObject, thisValue, "Object.prototype.hasOwnProperty"), propertyKey(args[0])),
    ],
    [
      "isPrototypeOf",
      1,
      (thisValue, args) => hasPrototype(args[0], receiver(ProgramObject, thisValue, "Object.prototype.isPrototypeOf")),
    ],
    [
      "propertyIsEnumerable",
      1,
      (thisValue, args) =>
        own(receiver(ProgramObject, thisValue, "Object.prototype.propertyIsEnumerable"), propertyKey(args[0]))
          ?.enumerable === true,
    ],
    ["toString", 0, (thisValue) => `[object ${classTag(thisValue)}]`],
    ["toLocaleString", 0, (thisValue) => `[object ${classTag(thisValue)}]`],
    [
      "valueOf",
      0,
      (thisValue) => {
        if (thisValue === null || thisValue === undefined) {
          throw typeError("Object.prototype.valueOf called on null or undefined.")
        }
        return thisValue
      },
    ],
  ])
  return object
}
