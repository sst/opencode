import { Effect } from "effect"
import { constants, type Method, methods } from "../interpreter/native.js"
import { type AstNode, InterpreterRuntimeError } from "../interpreter/model.js"
import { ProgramObject } from "../interpreter/objects.js"
import { preserveConsumerError, type Runner } from "../interpreter/runner.js"

// Bun exposes ES2026 Math.sumPrecise before TypeScript's standard library types.
declare global {
  interface Math {
    sumPrecise(values: Iterable<number>): number
  }
}

// Validate only the arguments a method consumes; like JS, extras are ignored
// (so built-ins work as callbacks receiving (element, index, array)).
const number = (name: string, args: Array<unknown>, index: number, node: AstNode): number => {
  if (index >= args.length) return Number.NaN
  const arg = args[index]
  if (typeof arg !== "number") throw new InterpreterRuntimeError(`Math.${name} expects number arguments.`, node)
  return arg
}

const unary = (name: string, op: (a: number) => number): Method => [
  name,
  1,
  (_, args, node) => op(number(name, args, 0, node)),
]

const binary = (name: string, op: (a: number, b: number) => number): Method => [
  name,
  2,
  (_, args, node) => op(number(name, args, 0, node), number(name, args, 1, node)),
]

const variadic = (name: string, op: (...values: Array<number>) => number): Method => [
  name,
  2,
  (_, args, node) =>
    op(
      ...args.map((arg) => {
        if (typeof arg !== "number") throw new InterpreterRuntimeError(`Math.${name} expects number arguments.`, node)
        return arg
      }),
    ),
]

export const mathGlobal = <R>(runner: Runner<R>) => {
  const protos = runner.prototypes
  const math = new ProgramObject(protos.Object)
  constants(math, {
    PI: Math.PI,
    E: Math.E,
    LN2: Math.LN2,
    LN10: Math.LN10,
    LOG2E: Math.LOG2E,
    LOG10E: Math.LOG10E,
    SQRT2: Math.SQRT2,
    SQRT1_2: Math.SQRT1_2,
  })
  methods(protos, math, [
    ["random", 0, () => Math.random()],
    variadic("max", Math.max),
    variadic("min", Math.min),
    variadic("hypot", Math.hypot),
    unary("abs", Math.abs),
    unary("acos", Math.acos),
    unary("acosh", Math.acosh),
    unary("asin", Math.asin),
    unary("asinh", Math.asinh),
    unary("atan", Math.atan),
    binary("atan2", Math.atan2),
    unary("atanh", Math.atanh),
    unary("floor", Math.floor),
    unary("ceil", Math.ceil),
    unary("round", Math.round),
    unary("trunc", Math.trunc),
    unary("sign", Math.sign),
    unary("sqrt", Math.sqrt),
    unary("cbrt", Math.cbrt),
    binary("pow", Math.pow),
    unary("cos", Math.cos),
    unary("cosh", Math.cosh),
    unary("sin", Math.sin),
    unary("sinh", Math.sinh),
    unary("tan", Math.tan),
    unary("tanh", Math.tanh),
    unary("log", Math.log),
    unary("log2", Math.log2),
    unary("log10", Math.log10),
    unary("log1p", Math.log1p),
    unary("exp", Math.exp),
    unary("expm1", Math.expm1),
    unary("f16round", Math.f16round),
    unary("fround", Math.fround),
    unary("clz32", Math.clz32),
    binary("imul", Math.imul),
    [
      "sumPrecise",
      1,
      (_, args, node) =>
        Effect.gen(function* () {
          const cursor = yield* runner.syncIterator(args[0], node)
          if (cursor === undefined) {
            throw new InterpreterRuntimeError("Math.sumPrecise expects a synchronous iterable.", node)
          }
          const numbers: Array<number> = []
          while (true) {
            const step = yield* cursor.next
            if (step.done) return Math.sumPrecise(numbers)
            yield* preserveConsumerError(
              cursor,
              Effect.sync(() => {
                if (typeof step.value !== "number") {
                  throw new InterpreterRuntimeError("Math.sumPrecise expects an iterable of numbers.", node)
                }
                numbers.push(step.value)
              }),
            )
          }
        }),
    ],
  ])
  return math
}
