import { Effect } from "effect"
import { constructor, type Method, methods, prototypeFrom, receiver } from "../interpreter/native.js"
import { type AstNode, InterpreterRuntimeError, rangeError } from "../interpreter/model.js"
import { get, ProgramArray, ProgramGenerator, ProgramObject } from "../interpreter/objects.js"
import { describeValue, rejectCircularInsertion } from "../interpreter/references.js"
import { applyCollectionCallback, preserveConsumerError, type Runner } from "../interpreter/runner.js"
import { compareText } from "../tool-runtime.js"
import { coerceToNumber, coerceToString } from "./value.js"

const MAX_LENGTH = 4_294_967_295

const arrayLikeSource = (
  source: unknown,
  node: AstNode,
): { readonly length: number; readonly source: ProgramObject } => {
  if (source instanceof ProgramObject && typeof get(source, "length") === "number") {
    const length = get(source, "length") as number
    const normalized = Number.isNaN(length) || length <= 0 ? 0 : Math.trunc(length)
    if (normalized > MAX_LENGTH) throw new RangeError("Invalid array length")
    return { length: normalized, source }
  }
  throw new InterpreterRuntimeError(
    `Array.from expects an array, string, Map, Set, or array-like value, received ${describeValue(source)}.`,
    node,
    "InvalidDataValue",
  )
}

const arrayFrom = <R>(runner: Runner<R>, args: Array<unknown>, node: AstNode): Effect.Effect<unknown, unknown, R> => {
  const source = args[0]
  const proto = runner.prototypes.Array
  const apply =
    args.length < 2 || args[1] === undefined ? undefined : applyCollectionCallback(runner, args[1], "Array.from", node)
  return Effect.gen(function* () {
    const cursor = yield* runner.syncIterator(source, node)
    if (cursor === undefined) {
      if (source instanceof ProgramGenerator) {
        throw new InterpreterRuntimeError("Array.from expects a synchronous iterable or array-like value.", node)
      }
      const arrayLike = arrayLikeSource(source, node)
      const values: Array<unknown> = []
      for (let index = 0; index < arrayLike.length; index += 1) {
        const item = get(arrayLike.source, index)
        values.push(apply === undefined ? item : yield* apply([item, index]))
      }
      return new ProgramArray(proto, values)
    }
    const values: Array<unknown> = []
    let index = 0
    while (true) {
      const step = yield* cursor.next
      if (step.done) return new ProgramArray(proto, values)
      values.push(apply === undefined ? step.value : yield* preserveConsumerError(cursor, apply([step.value, index])))
      index += 1
    }
  })
}

export const sortArray = <R>(
  runner: Runner<R>,
  target: Array<unknown>,
  comparator: unknown,
  name: string,
  node: AstNode,
): Effect.Effect<Array<unknown>, unknown, R> => {
  if (comparator === undefined) {
    return Effect.sync(() => [...target].sort((a, b) => compareText(coerceToString(a), coerceToString(b))))
  }
  const apply = applyCollectionCallback(runner, comparator, name, node)
  const mergeSort = (items: Array<unknown>): Effect.Effect<Array<unknown>, unknown, R> => {
    if (items.length <= 1) return Effect.succeed(items)
    const midpoint = Math.floor(items.length / 2)
    return Effect.gen(function* () {
      const left = yield* mergeSort(items.slice(0, midpoint))
      const right = yield* mergeSort(items.slice(midpoint))
      const merged: Array<unknown> = []
      let leftIndex = 0
      let rightIndex = 0
      while (leftIndex < left.length && rightIndex < right.length) {
        // Treat a NaN comparator result as equal to preserve stable ordering.
        const order = coerceToNumber(yield* apply([left[leftIndex], right[rightIndex]]))
        if (Number.isNaN(order) || order <= 0) merged.push(left[leftIndex++])
        else merged.push(right[rightIndex++])
      }
      return [...merged, ...left.slice(leftIndex), ...right.slice(rightIndex)]
    })
  }
  const defined = target.filter((item) => item !== undefined)
  const undefinedCount = target.length - defined.length
  return Effect.map(mergeSort(defined), (items) => [...items, ...Array(undefinedCount).fill(undefined)])
}

// Array constructs identically with or without new, like JS.
export const arrayGlobal = <R>(runner: Runner<R>) => {
  const protos = runner.prototypes
  const proto = protos.Array
  const wrap = (items: Array<unknown>) => new ProgramArray(proto, items)
  const construct = (args: Array<unknown>, into: ProgramObject, node: AstNode): ProgramArray => {
    if (args.length !== 1) return new ProgramArray(into, [...args])
    const first = args[0]
    if (typeof first !== "number") return new ProgramArray(into, [first])
    if (!Number.isInteger(first) || first < 0 || first > MAX_LENGTH) throw rangeError("Invalid array length.", node)
    // Sparse like JS: Array(3) has holes, and combinator loops already skip them.
    return new ProgramArray(into, new Array(first))
  }
  const array = constructor<R>(protos, proto, {
    name: "Array",
    length: 1,
    call: (_, args, node) => Effect.sync(() => construct(args, proto, node)),
    construct: (args, newTarget, node) => Effect.sync(() => construct(args, prototypeFrom(newTarget, proto), node)),
  })
  methods(protos, array, [
    ["isArray", 1, (_, args) => args[0] instanceof ProgramArray],
    ["of", 0, (_, args) => wrap([...args])],
    ["from", 1, (_, args, node) => arrayFrom(runner, args, node)],
  ])

  const self = (thisValue: unknown, name: string, node: AstNode) =>
    receiver(ProgramArray, thisValue, `Array.prototype.${name}`, node)
  const optNumber = (name: string, value: unknown, label: string, node: AstNode): number | undefined => {
    if (value === undefined) return undefined
    if (typeof value !== "number") {
      throw new InterpreterRuntimeError(`Array.${name} expects ${label} to be a number.`, node)
    }
    return value
  }
  // Callback methods fix the iteration length while reading existing elements live.
  const iterate = (
    name: string,
    length: number,
    body: (
      target: Array<unknown>,
      receiver: ProgramArray,
      apply: (args: Array<unknown>) => Effect.Effect<unknown, unknown, R>,
      args: Array<unknown>,
      node: AstNode,
    ) => Effect.Effect<unknown, unknown, R>,
  ): Method => [
    name,
    length,
    (thisValue, args, node) => {
      const target = self(thisValue, name, node)
      return body(target.items, target, applyCollectionCallback(runner, args[0], `Array.${name}`, node), args, node)
    },
  ]

  methods(protos, proto, [
    [
      "join",
      1,
      (thisValue, args, node) => {
        const target = self(thisValue, "join", node).items
        if (args.length > 1 || (args.length === 1 && typeof args[0] !== "string")) {
          throw new InterpreterRuntimeError("Array.join expects zero arguments or one string separator.", node)
        }
        return target.map((item) => coerceToString(item ?? "")).join(args.length === 0 ? "," : (args[0] as string))
      },
    ],
    [
      "toString",
      0,
      (thisValue, _, node) =>
        self(thisValue, "toString", node)
          .items.map((item) => coerceToString(item ?? ""))
          .join(","),
    ],
    [
      "includes",
      1,
      (thisValue, args, node) => {
        const target = self(thisValue, "includes", node).items
        if (args.length === 0 || args.length > 2) {
          throw new InterpreterRuntimeError("Array.includes expects a value and optional start index.", node)
        }
        return target.includes(args[0], optNumber("includes", args[1], "start index", node))
      },
    ],
    [
      "indexOf",
      1,
      (thisValue, args, node) =>
        self(thisValue, "indexOf", node).items.indexOf(args[0], optNumber("indexOf", args[1], "start index", node)),
    ],
    [
      "lastIndexOf",
      1,
      (thisValue, args, node) => {
        const target = self(thisValue, "lastIndexOf", node).items
        return args[1] === undefined
          ? target.lastIndexOf(args[0])
          : target.lastIndexOf(args[0], optNumber("lastIndexOf", args[1], "start index", node))
      },
    ],
    [
      "at",
      1,
      (thisValue, args, node) => self(thisValue, "at", node).items.at(optNumber("at", args[0], "index", node) ?? 0),
    ],
    [
      "slice",
      2,
      (thisValue, args, node) =>
        wrap(
          self(thisValue, "slice", node).items.slice(
            optNumber("slice", args[0], "start", node),
            optNumber("slice", args[1], "end", node),
          ),
        ),
    ],
    [
      "concat",
      1,
      (thisValue, args, node) =>
        wrap(
          self(thisValue, "concat", node).items.concat(
            ...args.map((item) => (item instanceof ProgramArray ? item.items : item)),
          ),
        ),
    ],
    [
      "flat",
      0,
      (thisValue, args, node) => {
        const flatten = (items: Array<unknown>, depth: number): Array<unknown> =>
          items.flatMap((item) => (item instanceof ProgramArray && depth > 0 ? flatten(item.items, depth - 1) : [item]))
        return wrap(flatten(self(thisValue, "flat", node).items, optNumber("flat", args[0], "depth", node) ?? 1))
      },
    ],
    [
      "reverse",
      0,
      (thisValue, _, node) => {
        const target = self(thisValue, "reverse", node)
        target.items.reverse()
        return target
      },
    ],
    [
      "sort",
      1,
      (thisValue, args, node) => {
        const target = self(thisValue, "sort", node)
        const items = target.items
        const length = items.length
        const holeCount = Array.from({ length }, (_, index) => Object.hasOwn(items, index)).filter((o) => !o).length
        const itemCount = length - holeCount
        return Effect.map(sortArray(runner, items, args[0], "Array.sort", node), (sorted) => {
          sorted.slice(0, itemCount).forEach((item, index) => {
            items[index] = item
          })
          Array.from({ length: holeCount }, (_, index) => itemCount + index).forEach((index) => {
            Reflect.deleteProperty(items, index)
          })
          return target
        })
      },
    ],
    [
      "toSorted",
      1,
      (thisValue, args, node) =>
        Effect.map(sortArray(runner, self(thisValue, "toSorted", node).items, args[0], "Array.toSorted", node), wrap),
    ],
    ["toReversed", 0, (thisValue, _, node) => wrap([...self(thisValue, "toReversed", node).items].reverse())],
    [
      "with",
      2,
      (thisValue, args, node) => {
        const target = self(thisValue, "with", node).items
        const index = optNumber("with", args[0], "index", node) ?? 0
        const resolved = index < 0 ? target.length + index : index
        if (resolved < 0 || resolved >= target.length) throw rangeError("Array.with index is out of range.", node)
        const copied = [...target]
        copied[resolved] = args[1]
        return wrap(copied)
      },
    ],
    [
      "push",
      1,
      (thisValue, args, node) => {
        const target = self(thisValue, "push", node)
        // Validate all insertions before mutating to avoid partial cyclic updates.
        for (const item of args) rejectCircularInsertion(target, item, "Array.push result", node)
        return target.items.push(...args)
      },
    ],
    [
      "unshift",
      1,
      (thisValue, args, node) => {
        const target = self(thisValue, "unshift", node)
        for (const item of args) rejectCircularInsertion(target, item, "Array.unshift result", node)
        return target.items.unshift(...args)
      },
    ],
    ["pop", 0, (thisValue, _, node) => self(thisValue, "pop", node).items.pop()],
    ["shift", 0, (thisValue, _, node) => self(thisValue, "shift", node).items.shift()],
    [
      "splice",
      2,
      (thisValue, args, node) => {
        const target = self(thisValue, "splice", node)
        if (args.length === 0) return wrap(target.items.splice(0, 0))
        const start = optNumber("splice", args[0], "start", node) ?? 0
        if (args.length === 1) return wrap(target.items.splice(start))
        const deleteCount = optNumber("splice", args[1], "delete count", node) ?? 0
        const inserted = args.slice(2)
        for (const item of inserted) rejectCircularInsertion(target, item, "Array.splice result", node)
        return wrap(target.items.splice(start, deleteCount, ...inserted))
      },
    ],
    [
      "toSpliced",
      2,
      (thisValue, args, node) => {
        const copied = [...self(thisValue, "toSpliced", node).items]
        if (args.length === 0) return wrap(copied)
        const start = optNumber("toSpliced", args[0], "start", node) ?? 0
        if (args.length === 1) copied.splice(start)
        else copied.splice(start, optNumber("toSpliced", args[1], "delete count", node) ?? 0, ...args.slice(2))
        return wrap(copied)
      },
    ],
    [
      "fill",
      1,
      (thisValue, args, node) => {
        const target = self(thisValue, "fill", node)
        rejectCircularInsertion(target, args[0], "Array.fill result", node)
        target.items.fill(args[0], optNumber("fill", args[1], "start", node), optNumber("fill", args[2], "end", node))
        return target
      },
    ],
    [
      "copyWithin",
      2,
      (thisValue, args, node) => {
        const target = self(thisValue, "copyWithin", node)
        target.items.copyWithin(
          optNumber("copyWithin", args[0], "target index", node) ?? 0,
          optNumber("copyWithin", args[1], "start", node) ?? 0,
          optNumber("copyWithin", args[2], "end", node),
        )
        return target
      },
    ],
    ["keys", 0, (thisValue, _, node) => wrap(Array.from(self(thisValue, "keys", node).items.keys()))],
    ["values", 0, (thisValue, _, node) => wrap([...self(thisValue, "values", node).items])],
    [
      "entries",
      0,
      (thisValue, _, node) =>
        wrap(Array.from(self(thisValue, "entries", node).items.entries(), ([index, item]) => wrap([index, item]))),
    ],
    iterate("map", 1, (target, receiver, apply) =>
      Effect.gen(function* () {
        const length = target.length
        const values: Array<unknown> = []
        values.length = length
        for (let index = 0; index < length; index += 1) {
          if (!(index in target)) continue
          values[index] = yield* apply([target[index], index, receiver])
        }
        return wrap(values)
      }),
    ),
    iterate("flatMap", 1, (target, receiver, apply) =>
      Effect.gen(function* () {
        const length = target.length
        const values: Array<unknown> = []
        for (let index = 0; index < length; index += 1) {
          if (!(index in target)) continue
          const mapped = yield* apply([target[index], index, receiver])
          if (mapped instanceof ProgramArray) values.push(...mapped.items)
          else values.push(mapped)
        }
        return wrap(values)
      }),
    ),
    iterate("filter", 1, (target, receiver, apply) =>
      Effect.gen(function* () {
        const length = target.length
        const values: Array<unknown> = []
        for (let index = 0; index < length; index += 1) {
          if (!(index in target)) continue
          const item = target[index]
          if (yield* apply([item, index, receiver])) values.push(item)
        }
        return wrap(values)
      }),
    ),
    iterate("find", 1, (target, receiver, apply) =>
      Effect.gen(function* () {
        const length = target.length
        for (let index = 0; index < length; index += 1) {
          const item = target[index]
          if (yield* apply([item, index, receiver])) return item
        }
        return undefined
      }),
    ),
    iterate("findIndex", 1, (target, receiver, apply) =>
      Effect.gen(function* () {
        const length = target.length
        for (let index = 0; index < length; index += 1) {
          if (yield* apply([target[index], index, receiver])) return index
        }
        return -1
      }),
    ),
    iterate("findLast", 1, (target, receiver, apply) =>
      Effect.gen(function* () {
        for (let index = target.length - 1; index >= 0; index -= 1) {
          const item = target[index]
          if (yield* apply([item, index, receiver])) return item
        }
        return undefined
      }),
    ),
    iterate("findLastIndex", 1, (target, receiver, apply) =>
      Effect.gen(function* () {
        for (let index = target.length - 1; index >= 0; index -= 1) {
          if (yield* apply([target[index], index, receiver])) return index
        }
        return -1
      }),
    ),
    iterate("some", 1, (target, receiver, apply) =>
      Effect.gen(function* () {
        const length = target.length
        for (let index = 0; index < length; index += 1) {
          if (!(index in target)) continue
          if (yield* apply([target[index], index, receiver])) return true
        }
        return false
      }),
    ),
    iterate("every", 1, (target, receiver, apply) =>
      Effect.gen(function* () {
        const length = target.length
        for (let index = 0; index < length; index += 1) {
          if (!(index in target)) continue
          if (!(yield* apply([target[index], index, receiver]))) return false
        }
        return true
      }),
    ),
    iterate("forEach", 1, (target, receiver, apply) =>
      Effect.gen(function* () {
        const length = target.length
        for (let index = 0; index < length; index += 1) {
          if (index in target) yield* apply([target[index], index, receiver])
        }
        return undefined
      }),
    ),
    iterate("reduce", 1, (target, receiver, apply, args, node) =>
      Effect.gen(function* () {
        const length = target.length
        let start = 0
        let accumulator = args[1]
        if (args.length < 2) {
          while (start < length && !(start in target)) start += 1
          if (start === length) {
            throw new InterpreterRuntimeError("Array.reduce of an empty array with no initial value.", node)
          }
          accumulator = target[start]
          start += 1
        }
        for (let index = start; index < length; index += 1) {
          if (!(index in target)) continue
          accumulator = yield* apply([accumulator, target[index], index, receiver])
        }
        return accumulator
      }),
    ),
    iterate("reduceRight", 1, (target, receiver, apply, args, node) =>
      Effect.gen(function* () {
        let start = target.length - 1
        let accumulator = args[1]
        if (args.length < 2) {
          while (start >= 0 && !(start in target)) start -= 1
          if (start < 0) {
            throw new InterpreterRuntimeError("Array.reduceRight of an empty array with no initial value.", node)
          }
          accumulator = target[start]
          start -= 1
        }
        for (let index = start; index >= 0; index -= 1) {
          if (!(index in target)) continue
          accumulator = yield* apply([accumulator, target[index], index, receiver])
        }
        return accumulator
      }),
    ),
  ])
  return array
}
