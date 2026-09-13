import { Effect } from "effect"
import type { Prototypes } from "./intrinsics.js"
import { type AstNode, InterpreterRuntimeError } from "./model.js"
import { type Callable, define, frozen, hidden, NativeFunction, type NativeOptions, ProgramObject } from "./objects.js"
import { describeValue } from "./references.js"

/** A native function body: a plain value, a thrown `InterpreterRuntimeError`, or an Effect. */
export type Impl = (thisValue: unknown, args: Array<unknown>, node: AstNode) => unknown

const lift =
  <R>(impl: Impl) =>
  (thisValue: unknown, args: Array<unknown>, node: AstNode): Effect.Effect<unknown, unknown, R> =>
    Effect.suspend(() => {
      const result = impl(thisValue, args, node)
      return Effect.isEffect(result) ? (result as Effect.Effect<unknown, unknown, R>) : Effect.succeed(result)
    })

export const native = <R>(protos: Prototypes, options: NativeOptions<R>): NativeFunction<R> =>
  new NativeFunction<R>(protos.Function, options)

export const fn = <R>(protos: Prototypes, name: string, length: number, impl: Impl): NativeFunction<R> =>
  native<R>(protos, { name, length, call: lift(impl) })

export type Method = readonly [name: string, length: number, impl: Impl]

export const methods = (protos: Prototypes, target: ProgramObject, table: ReadonlyArray<Method>): void => {
  for (const [name, length, impl] of table) define(target, name, fn(protos, name, length, impl), hidden)
}

export const constants = (target: ProgramObject, table: Record<string, unknown>): void => {
  for (const [name, value] of Object.entries(table)) define(target, name, value, frozen)
}

/** A constructor wired to its prototype: `C.prototype === proto` and `proto.constructor === C`. */
export const constructor = <R>(
  protos: Prototypes,
  proto: ProgramObject,
  options: NativeOptions<R>,
): NativeFunction<R> => {
  const ctor = native<R>(protos, options)
  define(ctor, "prototype", proto, frozen)
  define(proto, "constructor", ctor, hidden)
  return ctor
}

/** The `call` of a constructor that JS requires to be invoked with `new`. */
export const requiresNew =
  (name: string) =>
  (_: unknown, __: Array<unknown>, node: AstNode): Effect.Effect<never, unknown, never> =>
    Effect.sync(() => {
      throw new InterpreterRuntimeError(`Constructor ${name} requires 'new'.`, node)
    })

/** The instance prototype for `new` via `newTarget.prototype`, falling back to the built-in's own. */
export const prototypeFrom = (newTarget: Callable, fallback: ProgramObject): ProgramObject => {
  const proto = newTarget.props.get("prototype")
  return proto !== undefined && "value" in proto && proto.value instanceof ProgramObject ? proto.value : fallback
}

/** Narrows a method receiver to the built-in it belongs to, or throws the TypeError JS would. */
export const receiver = <T extends ProgramObject>(
  cls: abstract new (...args: never) => T,
  thisValue: unknown,
  method: string,
  node?: AstNode,
): T => {
  if (thisValue instanceof cls) return thisValue
  throw new InterpreterRuntimeError(`${method} called on incompatible receiver ${describeValue(thisValue)}.`, node)
}
