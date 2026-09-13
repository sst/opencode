import { parse, type Program } from "acorn"
import { Cause, Effect, Scope } from "effect"
// #transpile: conditional import — full typescript on node/bun, an identity
// pass-through on workerd (the compiler is ~11 MiB and can't init there).
import { transpile } from "#transpile"
import type { DataValue, Diagnostic, ResolvedExecutionLimits, Result } from "../codemode.js"
import { toData } from "../data.js"
import { ToolRuntime } from "../tool-runtime.js"
import { normalizeError } from "./errors.js"
import { createPrototypes } from "./intrinsics.js"
import type { Host } from "./globals.js"
import { InterpreterRuntimeError } from "./model.js"
import { PromiseRuntime } from "./promises.js"
import { Runtime } from "./runtime.js"

export const executeProgram = <R>(
  code: string,
  prepared: ToolRuntime.Prepared<R>,
  limits: ResolvedExecutionLimits,
  hooks: ToolRuntime.ToolCallHooks<R>,
  extraGlobals?: (host: Host<R>) => ReadonlyArray<readonly [string, unknown]>,
): Effect.Effect<Result, never, R> => {
  if (code.trim().length === 0) {
    return Effect.succeed({
      ok: false,
      error: { kind: "ParseError", message: "Code cannot be empty." },
      toolCalls: [],
    })
  }

  // Allocate execution state inside suspension so reused Effects never share it.
  return Effect.suspend(() => {
    const prototypes = createPrototypes()
    const tools = ToolRuntime.make(prepared, prototypes, limits.maxToolCalls, hooks)
    const logs: Array<string> = []
    const logged = () => (logs.length > 0 ? { logs: [...logs] } : {})
    // Set only after copy-out so timeouts cannot report invalid values as completed.
    let returned: { value: DataValue; promises: PromiseRuntime<R> } | undefined

    const base = Effect.acquireUseRelease(
      Scope.make("parallel"),
      (scope) =>
        Effect.gen(function* () {
          const program = parseProgram(code)
          const promises = new PromiseRuntime<R>(scope, prototypes.Promise)
          const value = yield* new Runtime<R>(
            tools.execute,
            tools.search,
            tools.keys,
            promises,
            prototypes,
            logs,
            extraGlobals,
          ).run(program)
          const result = toData(value, "Execution result", "result") as DataValue
          returned = { value: result, promises }
          const warnings = yield* promises.interrupt()
          return {
            ok: true,
            value: result,
            ...(warnings.length > 0 ? { warnings } : {}),
            ...logged(),
            toolCalls: tools.calls,
          } satisfies Result
        }),
      (scope, exit) => Scope.close(scope, exit),
    )
    const timeoutMs = limits.timeoutMs
    const operation =
      timeoutMs === undefined
        ? base
        : base.pipe(
            Effect.timeoutOrElse({
              duration: timeoutMs,
              orElse: () =>
                Effect.sync(() => {
                  if (returned === undefined) {
                    return {
                      ok: false,
                      error: { kind: "TimeoutExceeded", message: `Execution timed out after ${timeoutMs}ms.` },
                      ...logged(),
                      toolCalls: tools.calls,
                    } satisfies Result
                  }
                  // Keep the timeout warning first so truncation preserves it.
                  return {
                    ok: true,
                    value: returned.value,
                    warnings: [
                      {
                        kind: "TimeoutExceeded",
                        message: `The program returned, but background work was still running at the ${timeoutMs}ms timeout and was interrupted. Await all started promises.`,
                      },
                      ...returned.promises.diagnostics(),
                    ],
                    ...logged(),
                    toolCalls: tools.calls,
                  } satisfies Result
                }),
            }),
          )

    return operation.pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.succeed({
              ok: false,
              error: normalizeError(Cause.squash(cause)),
              ...logged(),
              toolCalls: tools.calls,
            } satisfies Result),
      ),
      Effect.map((result) =>
        limits.maxOutputBytes === undefined ? result : boundOutput(result, limits.maxOutputBytes),
      ),
    )
  })
}

const parseProgram = (code: string): Program => {
  const transpiled = transpile(`async function __codemode__() {\n${code}\n}`)

  if (transpiled.error !== undefined) {
    throw new InterpreterRuntimeError(`Failed to parse TypeScript: ${transpiled.error}`, undefined, "ParseError")
  }

  const bodyStart = transpiled.outputText.indexOf("{") + 1
  const bodyEnd = transpiled.outputText.lastIndexOf("}")
  const executableCode = transpiled.outputText.slice(bodyStart, bodyEnd)
  return parse(executableCode, {
    ecmaVersion: "latest",
    sourceType: "script",
    allowReturnOutsideFunction: true,
    allowAwaitOutsideFunction: true,
    locations: true,
  })
}

const utf8ByteLength = (value: string): number => new TextEncoder().encode(value).byteLength

// Drop a replacement character produced by truncating inside a UTF-8 sequence.
const utf8Truncate = (value: string, maxBytes: number): string => {
  const bytes = new TextEncoder().encode(value)
  if (bytes.byteLength <= maxBytes) return value
  const text = new TextDecoder("utf-8").decode(bytes.slice(0, Math.max(0, maxBytes)))
  return text.endsWith("\uFFFD") ? text.slice(0, -1) : text
}

// Warnings have a separate budget so result data cannot starve diagnostics.
const boundOutput = (result: Result, maxOutputBytes: number): Result => {
  let truncated = false

  let value: DataValue = null
  let valueBytes = 0
  if (result.ok) {
    const serialized = JSON.stringify(result.value) ?? "null"
    const bytes = utf8ByteLength(serialized)
    if (bytes > maxOutputBytes) {
      truncated = true
      value = `${utf8Truncate(serialized, maxOutputBytes)} [result truncated: ${bytes} bytes exceeds the ${maxOutputBytes}-byte output limit; return a smaller value]`
      valueBytes = maxOutputBytes
    } else {
      value = result.value
      valueBytes = bytes
    }
  }

  const warnings = result.ok ? (result.warnings ?? []) : []
  const keptWarnings: Array<Diagnostic> = []
  let warningBytes = 0
  for (const warning of warnings) {
    const bytes = utf8ByteLength(JSON.stringify(warning)) + 1
    if (warningBytes + bytes > maxOutputBytes) break
    warningBytes += bytes
    keptWarnings.push(warning)
  }
  if (keptWarnings.length < warnings.length) {
    truncated = true
    keptWarnings.push({
      kind: "Truncated",
      message: `${warnings.length - keptWarnings.length} additional warnings omitted by the output limit.`,
    })
  }

  const logs = result.logs ?? []
  const kept: Array<string> = []
  const logBudget = Math.max(0, maxOutputBytes - valueBytes)
  let logBytes = 0
  for (const line of logs) {
    const lineBytes = utf8ByteLength(line) + 1
    if (logBytes + lineBytes > logBudget) break
    logBytes += lineBytes
    kept.push(line)
  }
  if (kept.length < logs.length) {
    truncated = true
    kept.push(`[logs truncated: showing ${kept.length} of ${logs.length} lines]`)
  }

  if (!truncated) return result
  const warningsPart = keptWarnings.length > 0 ? { warnings: keptWarnings } : {}
  const logsPart = kept.length > 0 ? { logs: kept } : {}
  return result.ok
    ? {
        ok: true,
        value,
        ...warningsPart,
        ...logsPart,
        truncated: true,
        toolCalls: result.toolCalls,
      }
    : { ok: false, error: result.error, ...logsPart, truncated: true, toolCalls: result.toolCalls }
}
