import { Effect, Exit } from "effect"
import { coerceToNumber, coerceToString } from "../stdlib/value.js"
import type { Prototypes } from "./intrinsics.js"
import { type AstNode, InterpreterRuntimeError } from "./model.js"
import { Callable, get, NativeFunction, ProgramDate, ProgramObject, ProgramPromise } from "./objects.js"
import { typeofValue } from "./references.js"

export type IteratorCursor<R> = {
  readonly next: Effect.Effect<{ readonly done: boolean; readonly value: unknown }, unknown, R>
  readonly close: Effect.Effect<void, unknown, R>
}

/** Everything a native function needs from the realm: calling back into the program and its intrinsic objects. */
export type Runner<R> = {
  readonly invokeCallable: (
    callable: unknown,
    thisValue: unknown,
    args: Array<unknown>,
    node: AstNode,
  ) => Effect.Effect<unknown, unknown, R>
  readonly settlePromise: (promise: ProgramPromise) => Effect.Effect<unknown, unknown, never>
  readonly syncIterator: (value: unknown, node: AstNode) => Effect.Effect<IteratorCursor<R> | undefined, unknown, R>
  readonly prototypes: Prototypes
}

export const preserveConsumerError = <A, R>(
  cursor: IteratorCursor<R>,
  effect: Effect.Effect<A, unknown, R>,
): Effect.Effect<A, unknown, R> =>
  Effect.flatMap(Effect.exit(effect), (exit) =>
    Exit.isSuccess(exit)
      ? Effect.succeed(exit.value)
      : Effect.andThen(Effect.exit(cursor.close), Effect.failCause(exit.cause)),
  )

/**
 * ToPrimitive: calls `valueOf`/`toString` in hint order and returns the first primitive result. Dates treat the
 * default hint as "string", like their `Symbol.toPrimitive`.
 */
export const toPrimitive = <R>(
  runner: Runner<R>,
  value: unknown,
  hint: "number" | "string" | "default",
  node: AstNode,
): Effect.Effect<unknown, unknown, R> => {
  if (!(value instanceof ProgramObject)) return Effect.succeed(value)
  const asString = hint === "string" || (hint === "default" && value instanceof ProgramDate)
  const order = asString ? ["toString", "valueOf"] : ["valueOf", "toString"]
  return Effect.gen(function* () {
    for (const method of order) {
      const callable = get(value, method)
      if (!(callable instanceof Callable)) continue
      const result = yield* runner.invokeCallable(callable, value, [], node)
      if (result === null || (typeof result !== "object" && typeof result !== "function")) return result
    }
    throw new InterpreterRuntimeError("Cannot convert object to primitive value.", node)
  })
}

export const toPrimitiveString = <R>(runner: Runner<R>, value: unknown, node: AstNode) =>
  Effect.map(toPrimitive(runner, value, "string", node), coerceToString)

export const toPrimitiveNumber = <R>(runner: Runner<R>, value: unknown, node: AstNode) =>
  Effect.map(toPrimitive(runner, value, "number", node), coerceToNumber)

// The single acceptance list for callbacks: collections, sort, string replacers,
// Array.from mappers, and promise reactions all admit exactly these callables.
// Admission means dispatchable, not necessarily invocable: new-requiring
// constructors pass the gate and throw a TypeError on call, like JS.
export const isSupportedCallback = (value: unknown): value is Callable =>
  value instanceof Callable && !(value instanceof NativeFunction && !value.callback)

export const applyCollectionCallback = <R>(
  runner: Runner<R>,
  callback: unknown,
  name: string,
  node: AstNode,
): ((args: Array<unknown>) => Effect.Effect<unknown, unknown, R>) => {
  if (!isSupportedCallback(callback)) {
    if (typeofValue(callback) === "function") {
      throw new InterpreterRuntimeError(
        `${name} cannot use this callable as a callback; wrap it in an arrow function, e.g. (value) => tools.ns.tool(value).`,
        node,
      )
    }
    throw new InterpreterRuntimeError(`${name} expects a function callback.`, node)
  }
  return (callbackArgs) => runner.invokeCallable(callback, undefined, callbackArgs, node)
}
