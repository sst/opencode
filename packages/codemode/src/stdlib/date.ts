import { Effect } from "effect"
import { constructor, type Method, methods, prototypeFrom, receiver } from "../interpreter/native.js"
import { type AstNode, rangeError } from "../interpreter/model.js"
import { ProgramDate, ProgramObject } from "../interpreter/objects.js"
import { type Runner, toPrimitive, toPrimitiveNumber } from "../interpreter/runner.js"
import { coerceToNumber, coerceToString } from "./value.js"

const constructDate = <R>(runner: Runner<R>, args: Array<unknown>, proto: ProgramObject, node: AstNode) => {
  if (args.length === 0) return Effect.succeed(new ProgramDate(proto, Date.now()))
  if (args.length === 1) {
    const arg = args[0]
    if (arg instanceof ProgramDate) return Effect.succeed(new ProgramDate(proto, arg.time))
    return Effect.map(toPrimitive(runner, arg, "default", node), (value) =>
      typeof value === "string"
        ? new ProgramDate(proto, Date.parse(value))
        : new ProgramDate(proto, new Date(coerceToNumber(value)).getTime()),
    )
  }
  const parts = args.map((arg) => coerceToNumber(arg))
  return Effect.succeed(new ProgramDate(proto, new Date(...(parts as [number, number])).getTime()))
}

type Getter = keyof {
  [K in keyof Date as Date[K] extends () => number ? K : never]: never
}

const getters: ReadonlyArray<Getter> = [
  "getFullYear",
  "getMonth",
  "getDate",
  "getDay",
  "getHours",
  "getMinutes",
  "getSeconds",
  "getMilliseconds",
  "getUTCFullYear",
  "getUTCMonth",
  "getUTCDate",
  "getUTCDay",
  "getUTCHours",
  "getUTCMinutes",
  "getUTCSeconds",
  "getUTCMilliseconds",
  "getTimezoneOffset",
]

type Setter = keyof {
  [K in keyof Date as Date[K] extends (value: number, ...rest: Array<number>) => number ? K : never]: never
}

const setters: ReadonlyArray<readonly [Setter, number]> = [
  ["setTime", 1],
  ["setMilliseconds", 1],
  ["setUTCMilliseconds", 1],
  ["setSeconds", 2],
  ["setUTCSeconds", 2],
  ["setMinutes", 3],
  ["setUTCMinutes", 3],
  ["setHours", 4],
  ["setUTCHours", 4],
  ["setDate", 1],
  ["setUTCDate", 1],
  ["setMonth", 2],
  ["setUTCMonth", 2],
  ["setFullYear", 3],
  ["setUTCFullYear", 3],
]

export const dateGlobal = <R>(runner: Runner<R>) => {
  const protos = runner.prototypes
  const proto = protos.Date
  const date = constructor<R>(protos, proto, {
    name: "Date",
    length: 7,
    // ISO instead of the host's locale string: date strings are deterministic and must not leak the host timezone.
    call: () => Effect.sync(() => new Date().toISOString()),
    construct: (args, newTarget, node) => constructDate(runner, args, prototypeFrom(newTarget, proto), node),
  })
  methods(protos, date, [
    ["now", 0, () => Date.now()],
    ["parse", 1, (_, args) => Date.parse(coerceToString(args[0]))],
    ["UTC", 7, (_, args) => Date.UTC(...(args.map((arg) => coerceToNumber(arg)) as Parameters<typeof Date.UTC>))],
  ])

  const self = (thisValue: unknown, name: string, node: AstNode) =>
    receiver(ProgramDate, thisValue, `Date.prototype.${name}`, node)
  const iso = (value: ProgramDate, node: AstNode) => {
    if (!Number.isFinite(value.time)) throw rangeError("Invalid time value.", node)
    return new Date(value.time).toISOString()
  }
  methods(protos, proto, [
    ["getTime", 0, (thisValue, _, node) => self(thisValue, "getTime", node).time],
    ["valueOf", 0, (thisValue, _, node) => self(thisValue, "valueOf", node).time],
    ["toISOString", 0, (thisValue, _, node) => iso(self(thisValue, "toISOString", node), node)],
    [
      "toJSON",
      1,
      (thisValue, _, node) => {
        const value = self(thisValue, "toJSON", node)
        return Number.isFinite(value.time) ? iso(value, node) : null
      },
    ],
    ["toString", 0, (thisValue, _, node) => coerceToString(self(thisValue, "toString", node))],
    ["toDateString", 0, (thisValue, _, node) => new Date(self(thisValue, "toDateString", node).time).toDateString()],
    ["toTimeString", 0, (thisValue, _, node) => new Date(self(thisValue, "toTimeString", node).time).toTimeString()],
    ["toUTCString", 0, (thisValue, _, node) => new Date(self(thisValue, "toUTCString", node).time).toUTCString()],
    ["toGMTString", 0, (thisValue, _, node) => new Date(self(thisValue, "toGMTString", node).time).toUTCString()],
    ...getters.map(
      (name): Method => [name, 0, (thisValue, _, node) => new Date(self(thisValue, name, node).time)[name]()],
    ),
    ...setters.map(
      ([name, length]): Method => [
        name,
        length,
        (thisValue, args, node) => {
          const target = self(thisValue, name, node)
          // Native setters read the current time before argument coercion, whose callbacks may mutate the Date.
          const hosted = new Date(target.time)
          return Effect.map(
            Effect.forEach(args.slice(0, length), (arg) => toPrimitiveNumber(runner, arg, node), {
              concurrency: 1,
            }),
            (values) => {
              target.time = hosted[name](...(values as [number, number, number, number]))
              return target.time
            },
          )
        },
      ],
    ),
  ])
  return date
}
