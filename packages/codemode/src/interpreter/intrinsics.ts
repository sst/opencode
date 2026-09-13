import { Effect } from "effect"
import { define, hidden, NativeFunction, ProgramArray, ProgramError, ProgramObject } from "./objects.js"

export const errorTypes = [
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "ReferenceError",
  "EvalError",
  "URIError",
  "AggregateError",
] as const

export type ErrorType = (typeof errorTypes)[number]

export const isErrorType = (name: string): name is ErrorType => (errorTypes as ReadonlyArray<string>).includes(name)

const builtins = [
  "Object",
  "Function",
  "Array",
  "String",
  "Number",
  "Boolean",
  "Date",
  "RegExp",
  "Map",
  "Set",
  "URL",
  "URLSearchParams",
  "Promise",
  "Iterator",
  "AsyncIterator",
  "Generator",
  "AsyncGenerator",
] as const

/**
 * The built-in prototype objects of one runtime, allocated empty in dependency order. The globals populate them
 * and attach their constructors when the runtime is built.
 */
export type Prototypes = Readonly<Record<(typeof builtins)[number] | ErrorType, ProgramObject>>

export const createErrorValue = (prototype: ProgramObject, message: string | undefined): ProgramError => {
  const value = new ProgramError(prototype)
  if (message !== undefined) define(value, "message", message, hidden)
  return value
}

export const createPrototypes = (): Prototypes => {
  const object = new ProgramObject(null)
  // Function.prototype is itself callable and returns undefined.
  const fn = new NativeFunction(object, { name: "", call: () => Effect.undefined })
  const plain = () => new ProgramObject(object)
  const error = plain()
  define(error, "name", "Error", hidden)
  define(error, "message", "", hidden)
  const derived = (type: ErrorType) => {
    const proto = new ProgramObject(error)
    define(proto, "name", type, hidden)
    define(proto, "message", "", hidden)
    return proto
  }
  const iterator = plain()
  const asyncIterator = plain()
  return {
    Object: object,
    Function: fn,
    Array: new ProgramArray(object),
    String: plain(),
    Number: plain(),
    Boolean: plain(),
    Date: plain(),
    RegExp: plain(),
    Map: plain(),
    Set: plain(),
    URL: plain(),
    URLSearchParams: plain(),
    Promise: plain(),
    Iterator: iterator,
    AsyncIterator: asyncIterator,
    Generator: new ProgramObject(iterator),
    AsyncGenerator: new ProgramObject(asyncIterator),
    Error: error,
    TypeError: derived("TypeError"),
    RangeError: derived("RangeError"),
    SyntaxError: derived("SyntaxError"),
    ReferenceError: derived("ReferenceError"),
    EvalError: derived("EvalError"),
    URIError: derived("URIError"),
    AggregateError: derived("AggregateError"),
  }
}
