import { Effect } from "effect"
import type { Diagnostic } from "../codemode.js"
import { ToolError } from "../tool-error.js"
import { toData, ToolRuntimeError } from "../data.js"
import { type AstNode, formatLocation, InterpreterRuntimeError, ProgramThrow, sourceLocation } from "./model.js"
import { containsRuntimeReference } from "./references.js"
import { createErrorValue, type ErrorType, isErrorType } from "./intrinsics.js"
import { constructor, methods, prototypeFrom, receiver } from "./native.js"
import {
  type Callable,
  define,
  get,
  hidden,
  type NativeFunction,
  ProgramArray,
  ProgramError,
  ProgramObject,
} from "./objects.js"
import { type Runner } from "./runner.js"
import { coerceToString } from "../stdlib/value.js"

export const normalizeError = (error: unknown): Diagnostic => {
  if (error instanceof InterpreterRuntimeError) {
    return {
      kind: error.kind,
      message: `${error.message}${formatLocation(error.node)}`,
      ...(error.node?.loc ? { location: sourceLocation(error.node) } : {}),
      ...(error.suggestions ? { suggestions: error.suggestions } : {}),
    }
  }

  if (error instanceof ToolRuntimeError) {
    return {
      kind: error.kind,
      message: error.message,
      ...(error.suggestions.length > 0 ? { suggestions: error.suggestions } : {}),
    }
  }

  if (error instanceof ToolError) {
    return { kind: "ToolFailure", message: error.message }
  }

  if (error instanceof ProgramThrow) {
    const value = error.value
    let message: string
    if (containsRuntimeReference(value)) {
      // Never expose runtime reference internals through thrown values.
      message = "a non-data value"
    } else if (typeof value === "string") {
      message = value
    } else if (value instanceof ProgramObject && typeof get(value, "message") === "string") {
      message = get(value, "message") as string
    } else {
      try {
        message = JSON.stringify(toData(value, "Thrown value")) ?? String(value)
      } catch {
        message = String(value)
      }
    }
    return { kind: "ExecutionFailure", message: `Uncaught: ${message}` }
  }

  if (error instanceof RangeError && /call stack|recursion/i.test(error.message)) {
    return {
      kind: "ExecutionFailure",
      message: "Execution exceeded the maximum nesting depth.",
    }
  }

  if (error instanceof Error) {
    return {
      kind: error.name === "SyntaxError" ? "ParseError" : "ExecutionFailure",
      message: error.message,
    }
  }

  return {
    kind: "ExecutionFailure",
    message: String(error),
  }
}

export const caughtErrorValue = <R>(runner: Runner<R>, thrown: unknown): unknown => {
  if (thrown instanceof ProgramThrow) return thrown.value
  const prototypes = runner.prototypes
  if (thrown instanceof InterpreterRuntimeError) return createErrorValue(prototypes[thrown.type], thrown.message)
  const type = thrown instanceof Error && isErrorType(thrown.name) ? thrown.name : "Error"
  return createErrorValue(prototypes[type], normalizeError(thrown).message)
}

export const createAggregateErrorValue = <R>(
  runner: Runner<R>,
  errors: Array<unknown>,
  message: string,
  proto: ProgramObject = runner.prototypes.AggregateError,
) => {
  const value = createErrorValue(proto, message)
  define(value, "errors", new ProgramArray(runner.prototypes.Array, errors), { ...hidden })
  return value
}

const constructAggregateErrorValue = <R>(
  runner: Runner<R>,
  args: Array<unknown>,
  proto: ProgramObject,
  node: AstNode,
): Effect.Effect<ProgramError, unknown, R> =>
  Effect.gen(function* () {
    const cursor = yield* runner.syncIterator(args[0], node)
    if (cursor === undefined) {
      throw new InterpreterRuntimeError("new AggregateError(...) expects a synchronous iterable of errors.", node)
    }
    const errors: Array<unknown> = []
    while (true) {
      const step = yield* cursor.next
      if (step.done) {
        return createAggregateErrorValue(runner, errors, args[1] === undefined ? "" : coerceToString(args[1]), proto)
      }
      errors.push(step.value)
    }
  })

/** An error constructor such as `Error` or `TypeError`; callable with or without `new`, like JS. */
export const errorGlobal = <R>(type: ErrorType, runner: Runner<R>) => {
  const protos = runner.prototypes
  const prototype = protos[type]
  const construct = (args: Array<unknown>, newTarget: Callable, node: AstNode) => {
    const proto = prototypeFrom(newTarget, prototype)
    return type === "AggregateError"
      ? constructAggregateErrorValue(runner, args, proto, node)
      : Effect.sync(() => createErrorValue(proto, args[0] === undefined ? undefined : coerceToString(args[0])))
  }
  const ctor: NativeFunction<R> = constructor<R>(protos, prototype, {
    name: type,
    length: type === "AggregateError" ? 2 : 1,
    call: (_, args, node) => construct(args, ctor, node),
    construct,
  })
  if (type === "Error") {
    methods(protos, prototype, [
      [
        "toString",
        0,
        (thisValue, _, node) => {
          const self = receiver(ProgramObject, thisValue, "Error.prototype.toString", node)
          const name = get(self, "name")
          const message = get(self, "message")
          const shownName = name === undefined ? "Error" : coerceToString(name)
          const shownMessage = message === undefined ? "" : coerceToString(message)
          if (shownMessage === "") return shownName
          if (shownName === "") return shownMessage
          return `${shownName}: ${shownMessage}`
        },
      ],
    ])
  }
  return ctor
}
