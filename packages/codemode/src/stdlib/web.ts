import { fn, methods } from "../interpreter/native.js"
import { InterpreterRuntimeError } from "../interpreter/model.js"
import { ProgramObject } from "../interpreter/objects.js"
import type { Runner } from "../interpreter/runner.js"
import { coerceToString } from "./value.js"

// WebIDL DOMString conversion: a missing argument is a TypeError, anything else stringifies. Invalid input is a
// TypeError as well; browsers throw a DOMException named InvalidCharacterError, which CodeMode does not have.
export const base64Global = <R>(runner: Runner<R>, name: "atob" | "btoa") =>
  fn<R>(runner.prototypes, name, 1, (_, args, node) => {
    if (args.length === 0) throw new InterpreterRuntimeError(`${name} requires 1 argument (a string)`, node)
    const input = coerceToString(args[0])
    try {
      return name === "atob" ? atob(input) : btoa(input)
    } catch {
      throw new InterpreterRuntimeError("The string contains invalid characters.", node)
    }
  })

export const cryptoGlobal = <R>(runner: Runner<R>) => {
  const object = new ProgramObject(runner.prototypes.Object)
  methods(runner.prototypes, object, [["randomUUID", 0, () => crypto.randomUUID()]])
  return object
}
