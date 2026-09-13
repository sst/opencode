import { Effect } from "effect"
import { constructor, type Method, methods, prototypeFrom, receiver } from "../interpreter/native.js"
import { rangeError } from "../interpreter/model.js"
import { ProgramDate, ProgramObject } from "../interpreter/objects.js"
import { type Runner, toPrimitive, toPrimitiveNumber } from "../interpreter/runner.js"
import { coerceToNumber, coerceToString } from "./value.js"

const constructDate = <R>(runner: Runner<R>, args: Array<unknown>, proto: ProgramObject) => {
  if (args.length === 0) return Effect.succeed(new ProgramDate(proto, Date.now()))
  if (args.length === 1) {
    const arg = args[0]
    if (arg instanceof ProgramDate) return Effect.succeed(new ProgramDate(proto, arg.time))
    return Effect.map(toPrimitive(runner, arg, "default"), (value) =>
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
    construct: (args, newTarget) => constructDate(runner, args, prototypeFrom(newTarget, proto)),
  })
  methods(protos, date, [
    ["now", 0, () => Date.now()],
    ["parse", 1, (_, args) => Date.parse(coerceToString(args[0]))],
    ["UTC", 7, (_, args) => Date.UTC(...(args.map((arg) => coerceToNumber(arg)) as Parameters<typeof Date.UTC>))],
  ])

  const self = (thisValue: unknown, name: string) => receiver(ProgramDate, thisValue, `Date.prototype.${name}`)
  const iso = (value: ProgramDate) => {
    if (!Number.isFinite(value.time)) throw rangeError("Invalid time value.")
    return new Date(value.time).toISOString()
  }
  methods(protos, proto, [
    ["getTime", 0, (thisValue) => self(thisValue, "getTime").time],
    ["valueOf", 0, (thisValue) => self(thisValue, "valueOf").time],
    ["toISOString", 0, (thisValue) => iso(self(thisValue, "toISOString"))],
    [
      "toJSON",
      1,
      (thisValue) => {
        const value = self(thisValue, "toJSON")
        return Number.isFinite(value.time) ? iso(value) : null
      },
    ],
    ["toString", 0, (thisValue) => coerceToString(self(thisValue, "toString"))],
    ["toDateString", 0, (thisValue) => new Date(self(thisValue, "toDateString").time).toDateString()],
    ["toTimeString", 0, (thisValue) => new Date(self(thisValue, "toTimeString").time).toTimeString()],
    ["toUTCString", 0, (thisValue) => new Date(self(thisValue, "toUTCString").time).toUTCString()],
    ["toGMTString", 0, (thisValue) => new Date(self(thisValue, "toGMTString").time).toUTCString()],
    ...getters.map((name): Method => [name, 0, (thisValue) => new Date(self(thisValue, name).time)[name]()]),
    ...setters.map(
      ([name, length]): Method => [
        name,
        length,
        (thisValue, args) => {
          const target = self(thisValue, name)
          // Native setters read the current time before argument coercion, whose callbacks may mutate the Date.
          const hosted = new Date(target.time)
          return Effect.map(
            Effect.forEach(args.slice(0, length), (arg) => toPrimitiveNumber(runner, arg), {
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
