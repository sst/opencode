import { Effect } from "effect"
import { arrayGlobal } from "../stdlib/array.js"
import { mapGlobal, setGlobal } from "../stdlib/collections.js"
import { consoleGlobal } from "../stdlib/console.js"
import { dateGlobal } from "../stdlib/date.js"
import { jsonGlobal } from "../stdlib/json.js"
import { mathGlobal } from "../stdlib/math.js"
import { booleanGlobal, numberGlobal } from "../stdlib/number.js"
import { objectGlobal } from "../stdlib/object.js"
import { regexpGlobal } from "../stdlib/regexp.js"
import { stringGlobal } from "../stdlib/string.js"
import { uriGlobal, urlGlobal, urlSearchParamsGlobal } from "../stdlib/url.js"
import { coercion } from "../stdlib/value.js"
import { base64Global, cryptoGlobal } from "../stdlib/web.js"
import { ToolReference } from "../tool-runtime.js"
import { errorGlobal } from "./errors.js"
import { errorTypes } from "./intrinsics.js"
import { constants, constructor, native } from "./native.js"
import { type AstNode, AsyncIteratorSymbol, InterpreterRuntimeError, IteratorSymbol } from "./model.js"
import { generatorGlobals } from "./generators.js"
import { promiseGlobal, type PromiseRuntime } from "./promises.js"
import type { Runner } from "./runner.js"

/** What the built-in globals need from the interpreter that owns them. */
export type Host<R> = {
  readonly runner: Runner<R>
  readonly promises: PromiseRuntime<R>
  readonly search: (args: Array<unknown>) => Effect.Effect<unknown, unknown, R>
  readonly toolKeys: (path: ReadonlyArray<string>) => ReadonlyArray<string>
  readonly logs: Array<string>
}

// Function.prototype.constructor exists so `fn.constructor === Function` holds; dynamic code is unsupported.
const functionGlobal = <R>(runner: Runner<R>) => {
  const reject = (_: unknown, __: Array<unknown>, node: AstNode) =>
    Effect.sync(() => {
      throw new InterpreterRuntimeError("The Function constructor is not supported; write the function inline.", node)
    })
  return constructor<R>(runner.prototypes, runner.prototypes.Function, {
    name: "Function",
    length: 1,
    call: reject,
    construct: (args, _, node) => reject(undefined, args, node),
  })
}

const symbolGlobal = <R>(runner: Runner<R>) => {
  const symbol = native<R>(runner.prototypes, {
    name: "Symbol",
    call: (_, __, node) =>
      Effect.sync(() => {
        throw new InterpreterRuntimeError(
          "Symbol is not callable; only Symbol.asyncIterator and Symbol.iterator are available.",
          node,
        )
      }),
    callback: false,
  })
  constants(symbol, { asyncIterator: AsyncIteratorSymbol, iterator: IteratorSymbol })
  return symbol
}

/** The immutable global bindings of every program, in declaration order. */
export const globals = <R>(host: Host<R>): ReadonlyArray<readonly [string, unknown]> => {
  const runner = host.runner
  generatorGlobals(runner, host.promises)
  return [
    ["tools", new ToolReference([])],
    ["search", native<R>(runner.prototypes, { name: "search", call: (_, args) => host.search(args), callback: false })],
    ["undefined", undefined],
    ["NaN", NaN],
    ["Infinity", Infinity],
    ["Object", objectGlobal(runner, host.toolKeys)],
    ["Function", functionGlobal(runner)],
    ["Array", arrayGlobal(runner)],
    ["Math", mathGlobal(runner)],
    ["JSON", jsonGlobal(runner)],
    ["console", consoleGlobal(runner, host.logs)],
    ["Promise", promiseGlobal(runner, host.promises)],
    ["Symbol", symbolGlobal(runner)],
    ["Number", numberGlobal(runner)],
    ["String", stringGlobal(runner)],
    ["Boolean", booleanGlobal(runner)],
    ["parseInt", coercion(runner, "parseInt", 2)],
    ["parseFloat", coercion(runner, "parseFloat")],
    ["isFinite", coercion(runner, "isFinite")],
    ["isNaN", coercion(runner, "isNaN")],
    ["Date", dateGlobal(runner)],
    ["RegExp", regexpGlobal(runner)],
    ["Map", mapGlobal(runner)],
    ["Set", setGlobal(runner)],
    ["URL", urlGlobal(runner)],
    ["URLSearchParams", urlSearchParamsGlobal(runner)],
    ["encodeURI", uriGlobal(runner, "encodeURI")],
    ["encodeURIComponent", uriGlobal(runner, "encodeURIComponent")],
    ["decodeURI", uriGlobal(runner, "decodeURI")],
    ["decodeURIComponent", uriGlobal(runner, "decodeURIComponent")],
    ["atob", base64Global(runner, "atob")],
    ["btoa", base64Global(runner, "btoa")],
    ["crypto", cryptoGlobal(runner)],
    ...errorTypes.map((type) => [type, errorGlobal(type, runner)] as const),
  ]
}
