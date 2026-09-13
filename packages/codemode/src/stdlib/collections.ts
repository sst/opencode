import { Effect } from "effect"
import { constructor, fn, type Method, methods, prototypeFrom, receiver, requiresNew } from "../interpreter/native.js"
import { type AstNode, InterpreterRuntimeError } from "../interpreter/model.js"
import {
  define,
  defineAccessor,
  get,
  getOwn,
  hidden,
  isWrapper,
  ProgramArray,
  ProgramMap,
  ProgramObject,
  ProgramPromise,
  ProgramSet,
} from "../interpreter/objects.js"
import { describeValue, isRuntimeReference } from "../interpreter/references.js"
import {
  applyCollectionCallback,
  isSupportedCallback,
  preserveConsumerError,
  type Runner,
  toPrimitiveNumber,
  toPrimitiveString,
} from "../interpreter/runner.js"

const coerceGroupByPropertyKey = <R>(
  runner: Runner<R>,
  value: unknown,
  node: AstNode,
): Effect.Effect<string, unknown, R> => {
  if (value instanceof ProgramPromise) return Effect.succeed("[object Promise]")
  if (!isWrapper(value) && isRuntimeReference(value)) {
    throw new InterpreterRuntimeError(
      `Object.groupBy callback must return a data value, received ${describeValue(value)}.`,
      node,
      "InvalidDataValue",
    )
  }
  return toPrimitiveString(runner, value, node)
}

/** `Map.groupBy` and `Object.groupBy`: the same iteration, keyed into a Map or a data object. */
export const groupBy = <R>(runner: Runner<R>, namespace: "Map" | "Object") =>
  fn<R>(runner.prototypes, "groupBy", 2, (_, args, node) => {
    const protos = runner.prototypes
    const source = args[0]
    if (source === null || source === undefined) {
      throw new InterpreterRuntimeError(`${namespace}.groupBy expects an iterable collection.`, node)
    }
    const apply = applyCollectionCallback(runner, args[1], `${namespace}.groupBy`, node)
    return Effect.gen(function* () {
      const cursor = yield* runner.syncIterator(source, node)
      if (cursor === undefined) {
        throw new InterpreterRuntimeError(`${namespace}.groupBy expects an iterable collection.`, node)
      }
      if (namespace === "Map") {
        const result = new ProgramMap(protos.Map)
        let index = 0
        while (true) {
          const step = yield* cursor.next
          if (step.done) return result
          const item = step.value
          const key = yield* preserveConsumerError(cursor, apply([item, index]))
          const group = result.map.get(key)
          if (group === undefined) result.map.set(key, new ProgramArray(protos.Array, [item]))
          else (group as ProgramArray).items.push(item)
          index += 1
        }
      }

      // Object.groupBy returns a null-prototype object, so group names never collide with inherited methods.
      const result = new ProgramObject(null)
      let index = 0
      while (true) {
        const step = yield* cursor.next
        if (step.done) return result
        const item = step.value
        const key = yield* preserveConsumerError(
          cursor,
          Effect.flatMap(apply([item, index]), (value) => coerceGroupByPropertyKey(runner, value, node)),
        )
        const group = getOwn(result, key)
        if (group === undefined) define(result, key, new ProgramArray(protos.Array, [item]))
        else (group as ProgramArray).items.push(item)
        index += 1
      }
    })
  })

const constructMap = <R>(runner: Runner<R>, init: unknown, proto: ProgramObject, node: AstNode) => {
  const target = new ProgramMap(proto)
  if (init === undefined || init === null) return Effect.succeed(target)
  return Effect.gen(function* () {
    const cursor = yield* runner.syncIterator(init, node)
    if (cursor === undefined) {
      throw new InterpreterRuntimeError("new Map(...) expects an iterable of [key, value] pairs or no argument.", node)
    }
    while (true) {
      const step = yield* cursor.next
      if (step.done) return target
      yield* preserveConsumerError(
        cursor,
        Effect.sync(() => {
          if (!(step.value instanceof ProgramObject)) {
            throw new InterpreterRuntimeError("new Map(...) expects [key, value] pairs as entry objects.", node)
          }
          target.map.set(getOwn(step.value, 0), getOwn(step.value, 1))
        }),
      )
    }
  })
}

const constructSet = <R>(runner: Runner<R>, init: unknown, proto: ProgramObject, node: AstNode) => {
  const target = new ProgramSet(proto)
  if (init === undefined || init === null) return Effect.succeed(target)
  return Effect.gen(function* () {
    const cursor = yield* runner.syncIterator(init, node)
    if (cursor === undefined) {
      throw new InterpreterRuntimeError("new Set(...) expects a synchronous iterable or no argument.", node)
    }
    while (true) {
      const step = yield* cursor.next
      if (step.done) return target
      target.set.add(step.value)
    }
  })
}

export const mapGlobal = <R>(runner: Runner<R>) => {
  const protos = runner.prototypes
  const proto = protos.Map
  const map = constructor<R>(protos, proto, {
    name: "Map",
    call: requiresNew("Map"),
    construct: (args, newTarget, node) => constructMap(runner, args[0], prototypeFrom(newTarget, proto), node),
  })
  define(map, "groupBy", groupBy(runner, "Map"), hidden)
  const self = (thisValue: unknown, name: string, node: AstNode) =>
    receiver(ProgramMap, thisValue, `Map.prototype.${name}`, node)
  const wrap = (items: Array<unknown>) => new ProgramArray(protos.Array, items)
  defineAccessor(proto, "size", (thisValue) => receiver(ProgramMap, thisValue, "Map.prototype.size").map.size)
  methods(protos, proto, [
    ["get", 1, (thisValue, args, node) => self(thisValue, "get", node).map.get(args[0])],
    ["has", 1, (thisValue, args, node) => self(thisValue, "has", node).map.has(args[0])],
    [
      "set",
      2,
      (thisValue, args, node) => {
        const target = self(thisValue, "set", node)
        target.map.set(args[0], args[1])
        return target
      },
    ],
    ["delete", 1, (thisValue, args, node) => self(thisValue, "delete", node).map.delete(args[0])],
    [
      "clear",
      0,
      (thisValue, _, node) => {
        self(thisValue, "clear", node).map.clear()
        return undefined
      },
    ],
    ["keys", 0, (thisValue, _, node) => wrap(Array.from(self(thisValue, "keys", node).map.keys()))],
    ["values", 0, (thisValue, _, node) => wrap(Array.from(self(thisValue, "values", node).map.values()))],
    [
      "entries",
      0,
      (thisValue, _, node) =>
        wrap(Array.from(self(thisValue, "entries", node).map.entries(), ([key, item]) => wrap([key, item]))),
    ],
    [
      "forEach",
      1,
      (thisValue, args, node) => {
        const target = self(thisValue, "forEach", node)
        const apply = applyCollectionCallback(runner, args[0], "Map.forEach", node)
        return Effect.gen(function* () {
          for (const [key, item] of Array.from(target.map.entries())) yield* apply([item, key, target])
          return undefined
        })
      },
    ],
  ])
  return map
}

type SetRecord<R> = {
  readonly size: number
  readonly has: (item: unknown) => Effect.Effect<boolean, unknown, R>
  readonly keys: () => Effect.Effect<Iterable<unknown>, unknown, R>
}

const loadSetRecord = <R>(
  runner: Runner<R>,
  source: unknown,
  name: string,
  node: AstNode,
): Effect.Effect<SetRecord<R>, unknown, R> => {
  if (source instanceof ProgramSet) {
    return Effect.succeed({
      size: source.set.size,
      has: (item: unknown) => Effect.succeed(source.set.has(item)),
      keys: () => Effect.succeed(source.set.values()),
    })
  }
  if (source instanceof ProgramMap) {
    return Effect.succeed({
      size: source.map.size,
      has: (item: unknown) => Effect.succeed(source.map.has(item)),
      keys: () => Effect.succeed(source.map.keys()),
    })
  }
  if (!(source instanceof ProgramObject)) {
    throw new InterpreterRuntimeError(`Set.${name} expects a Set-like object.`, node)
  }
  return Effect.gen(function* () {
    const size = yield* toPrimitiveNumber(runner, get(source, "size"), node)
    if (Number.isNaN(size)) {
      throw new InterpreterRuntimeError(`Set.${name} received a Set-like object with an invalid size.`, node)
    }
    const has = get(source, "has")
    const keys = get(source, "keys")
    if (!isSupportedCallback(has) || !isSupportedCallback(keys)) {
      throw new InterpreterRuntimeError(`Set.${name} expects callable 'has' and 'keys' methods.`, node)
    }
    return {
      size: Math.max(Math.trunc(size), 0),
      has: (item: unknown) => Effect.map(runner.invokeCallable(has, source, [item], node), Boolean),
      keys: () =>
        Effect.flatMap(runner.invokeCallable(keys, source, [], node), (result) => {
          if (result instanceof ProgramArray) return Effect.succeed(result.items)
          throw new InterpreterRuntimeError(`Set.${name} expected 'keys' to return an iterator.`, node)
        }),
    }
  })
}

const setOperation = <R>(
  runner: Runner<R>,
  target: ProgramSet,
  name: string,
  source: unknown,
  node: AstNode,
): Effect.Effect<unknown, unknown, R> =>
  Effect.gen(function* () {
    const other = yield* loadSetRecord(runner, source, name, node)
    const copy = () => {
      const result = new ProgramSet(runner.prototypes.Set)
      for (const item of target.set.values()) result.set.add(item)
      return result
    }
    if (name === "union") {
      const result = copy()
      for (const item of yield* other.keys()) result.set.add(item)
      return result
    }
    if (name === "intersection") {
      const result = new ProgramSet(runner.prototypes.Set)
      if (target.set.size <= other.size) {
        for (const item of target.set.values()) {
          if (yield* other.has(item)) result.set.add(item)
        }
        return result
      }
      for (const item of yield* other.keys()) {
        if (target.set.has(item)) result.set.add(item)
      }
      return result
    }
    if (name === "difference") {
      const result = copy()
      if (target.set.size <= other.size) {
        for (const item of result.set.values()) {
          if (yield* other.has(item)) result.set.delete(item)
        }
        return result
      }
      for (const item of yield* other.keys()) result.set.delete(item)
      return result
    }
    if (name === "symmetricDifference") {
      const result = copy()
      for (const item of yield* other.keys()) {
        if (target.set.has(item)) result.set.delete(item)
        else result.set.add(item)
      }
      return result
    }
    if (name === "isSubsetOf") {
      if (target.set.size > other.size) return false
      for (const item of target.set.values()) {
        if (!(yield* other.has(item))) return false
      }
      return true
    }
    if (name === "isSupersetOf") {
      if (target.set.size < other.size) return false
      for (const item of yield* other.keys()) {
        if (!target.set.has(item)) return false
      }
      return true
    }
    if (target.set.size <= other.size) {
      for (const item of target.set.values()) {
        if (yield* other.has(item)) return false
      }
      return true
    }
    for (const item of yield* other.keys()) {
      if (target.set.has(item)) return false
    }
    return true
  })

export const setGlobal = <R>(runner: Runner<R>) => {
  const protos = runner.prototypes
  const proto = protos.Set
  const set = constructor<R>(protos, proto, {
    name: "Set",
    call: requiresNew("Set"),
    construct: (args, newTarget, node) => constructSet(runner, args[0], prototypeFrom(newTarget, proto), node),
  })
  const self = (thisValue: unknown, name: string, node: AstNode) =>
    receiver(ProgramSet, thisValue, `Set.prototype.${name}`, node)
  const wrap = (items: Array<unknown>) => new ProgramArray(protos.Array, items)
  const operation = (name: string): Method => [
    name,
    1,
    (thisValue, args, node) => setOperation(runner, self(thisValue, name, node), name, args[0], node),
  ]
  defineAccessor(proto, "size", (thisValue) => receiver(ProgramSet, thisValue, "Set.prototype.size").set.size)
  methods(protos, proto, [
    ["has", 1, (thisValue, args, node) => self(thisValue, "has", node).set.has(args[0])],
    [
      "add",
      1,
      (thisValue, args, node) => {
        const target = self(thisValue, "add", node)
        target.set.add(args[0])
        return target
      },
    ],
    ["delete", 1, (thisValue, args, node) => self(thisValue, "delete", node).set.delete(args[0])],
    [
      "clear",
      0,
      (thisValue, _, node) => {
        self(thisValue, "clear", node).set.clear()
        return undefined
      },
    ],
    ["keys", 0, (thisValue, _, node) => wrap(Array.from(self(thisValue, "keys", node).set.values()))],
    ["values", 0, (thisValue, _, node) => wrap(Array.from(self(thisValue, "values", node).set.values()))],
    [
      "entries",
      0,
      (thisValue, _, node) =>
        wrap(Array.from(self(thisValue, "entries", node).set.values(), (item) => wrap([item, item]))),
    ],
    [
      "forEach",
      1,
      (thisValue, args, node) => {
        const target = self(thisValue, "forEach", node)
        const apply = applyCollectionCallback(runner, args[0], "Set.forEach", node)
        return Effect.gen(function* () {
          for (const item of Array.from(target.set.values())) yield* apply([item, item, target])
          return undefined
        })
      },
    ],
    operation("union"),
    operation("intersection"),
    operation("difference"),
    operation("symmetricDifference"),
    operation("isSubsetOf"),
    operation("isSupersetOf"),
    operation("isDisjointFrom"),
  ])
  return set
}
