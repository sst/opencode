import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Schema } from "effect"
import { CodeMode, Tool, toolError } from "../src/index.js"

// Wave 5 acceptance suite: first-class promise values. Un-awaited tool calls start eagerly on
// supervised fibers, `await` settles them, Promise.all/allSettled/race/resolve/reject are
// ordinary functions over arbitrary arrays mixing promises and plain values, and
// .then/.catch/.finally chain reactions onto any promise.

type Trace = {
  starts: Array<number>
  active: number
  maxActive: number
  completed: number
  interrupted: number
}

const makeTrace = (): Trace => ({ starts: [], active: 0, maxActive: 0, completed: 0, interrupted: 0 })

/**
 * Deterministic tool set: ordering and interruption are structural, never temporal.
 *
 * - `echo` settles immediately with its id.
 * - `gated` blocks until `open` releases the same id. Tool fibers start eagerly at the
 *   call site, so several gated calls are provably live at once before any `open` runs.
 * - `pending` never settles; tests assert its interruption instead of racing a timer.
 *
 * Real clocks remain only in the wall-clock timeout tests (`timeoutMs`, `stubborn`
 * cleanup), where elapsed time is the behavior under test.
 */
const echoTool = (trace: Trace) =>
  Tool.make({
    description: "Echo an id immediately",
    input: Schema.Struct({ id: Schema.Number }),
    output: Schema.Number,
    execute: ({ id }) =>
      Effect.sync(() => {
        trace.starts.push(id)
        trace.completed += 1
        return id
      }),
  })

const gatedTool = (trace: Trace, gate: (id: number) => Deferred.Deferred<void>) =>
  Tool.make({
    description: "Echo an id once its gate opens",
    input: Schema.Struct({ id: Schema.Number }),
    output: Schema.Number,
    execute: ({ id }) =>
      Effect.gen(function* () {
        trace.starts.push(id)
        trace.active += 1
        trace.maxActive = Math.max(trace.maxActive, trace.active)
        yield* Deferred.await(gate(id))
        trace.active -= 1
        trace.completed += 1
        return id
      }).pipe(
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            trace.active -= 1
            trace.interrupted += 1
          }),
        ),
      ),
  })

const openTool = (gate: (id: number) => Deferred.Deferred<void>) =>
  Tool.make({
    description: "Open the gate for an id",
    input: Schema.Struct({ id: Schema.Number }),
    output: Schema.Boolean,
    execute: ({ id }) => Deferred.succeed(gate(id), undefined),
  })

const pendingTool = (trace: Trace) =>
  Tool.make({
    description: "Never settle",
    input: Schema.Struct({ id: Schema.Number }),
    output: Schema.Number,
    execute: ({ id }) =>
      Effect.gen(function* () {
        trace.starts.push(id)
        trace.active += 1
        trace.maxActive = Math.max(trace.maxActive, trace.active)
        return yield* Effect.never
      }).pipe(
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            trace.active -= 1
            trace.interrupted += 1
          }),
        ),
      ),
  })

const failingTool = Tool.make({
  description: "Always refuse",
  input: Schema.Struct({}),
  output: Schema.String,
  execute: () => Effect.fail(toolError("Lookup refused")),
})

const interruptedTool = Tool.make({
  description: "Interrupt this call",
  input: Schema.Struct({}),
  output: Schema.String,
  execute: () => Effect.interrupt,
})

const completedTool = (trace: Trace) =>
  Tool.make({
    description: "Return the number of completed calls",
    input: Schema.Struct({}),
    output: Schema.Number,
    execute: () => Effect.succeed(trace.completed),
  })

/** Never settles, and holds interruption cleanup for `cleanupMs` so completion cleanup can outlast a timeout. */
const stubbornTool = (trace: Trace) =>
  Tool.make({
    description: "Never settle; clean up slowly when interrupted",
    input: Schema.Struct({ cleanupMs: Schema.Number }),
    output: Schema.Number,
    execute: ({ cleanupMs }) =>
      Effect.never.pipe(
        Effect.onInterrupt(() =>
          Effect.andThen(
            Effect.sleep(cleanupMs),
            Effect.sync(() => {
              trace.interrupted += 1
            }),
          ),
        ),
      ),
  })

const run = (
  code: string,
  options: { trace?: Trace; limits?: CodeMode.ExecutionLimits } = {},
): Promise<CodeMode.Result> => {
  const trace = options.trace ?? makeTrace()
  const gates = new Map<number, Deferred.Deferred<void>>()
  const gate = (id: number): Deferred.Deferred<void> => {
    const existing = gates.get(id)
    if (existing) return existing
    const created = Deferred.makeUnsafe<void>()
    gates.set(id, created)
    return created
  }
  return Effect.runPromise(
    CodeMode.execute({
      tools: {
        host: {
          echo: echoTool(trace),
          gated: gatedTool(trace, gate),
          open: openTool(gate),
          pending: pendingTool(trace),
          fail: failingTool,
          interrupt: interruptedTool,
          completed: completedTool(trace),
          stubborn: stubbornTool(trace),
        },
      },
      code,
      ...(options.limits ? { limits: options.limits } : {}),
    }),
  )
}

const value = async (code: string, options: { trace?: Trace; limits?: CodeMode.ExecutionLimits } = {}) => {
  const result = await run(code, options)
  if (!result.ok) throw new Error(`expected success, got ${result.error.kind}: ${result.error.message}`)
  return result.value
}

const error = async (code: string, options: { trace?: Trace; limits?: CodeMode.ExecutionLimits } = {}) => {
  const result = await run(code, options)
  if (result.ok) throw new Error(`expected failure, got value ${JSON.stringify(result.value)}`)
  return result.error
}

describe("first-class promise values", () => {
  test("async functions return promises with isolated concurrent invocations", async () => {
    expect(
      await value(`
        const load = async (id) => {
          const result = await tools.host.echo({ id })
          return [id, result]
        }
        const first = load(1)
        const second = load(2)
        return [first instanceof Promise, second instanceof Promise, await Promise.all([first, second])]
      `),
    ).toEqual([
      true,
      true,
      [
        [1, 1],
        [2, 2],
      ],
    ])
  })

  test("async function errors reject instead of throwing at the call site", async () => {
    expect(
      await value(`
        const fail = async () => { throw new Error("boom") }
        const promise = fail()
        try {
          await promise
          return "no"
        } catch (error) {
          return error.message
        }
      `),
    ).toBe("boom")
  })

  test("an un-awaited tool call starts eagerly, in call order, before any await", async () => {
    const trace = makeTrace()
    const result = await value(
      `
        const a = tools.host.gated({ id: 1 })
        const b = tools.host.gated({ id: 2 })
        await tools.host.open({ id: 1 })
        await tools.host.open({ id: 2 })
        const rb = await b
        const ra = await a
        return [ra, rb]
      `,
      { trace },
    )
    expect(result).toEqual([1, 2])
    expect(trace.starts).toEqual([1, 2])
    // Both calls overlapped even though they were awaited sequentially.
    expect(trace.maxActive).toBeGreaterThan(1)
  })

  test("awaiting the same promise twice settles once and never re-runs the call", async () => {
    const result = await run(`
      const p = tools.host.echo({ id: 7 })
      const x = await p
      const y = await p
      return [x, y]
    `)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toEqual([7, 7])
    expect(result.toolCalls).toStrictEqual([{ name: "host.echo" }])
  })

  test("await of a non-promise value passes it through unchanged", async () => {
    expect(await value(`return await 42`)).toBe(42)
    expect(await value(`const x = await "s"; return x`)).toBe("s")
    expect(await value(`return await null`)).toBeNull()
    expect(await value(`return (await [1, 2]).length`)).toBe(2)
  })

  test("returning an un-awaited tool call resolves it (async-function return semantics)", async () => {
    expect(await value(`return tools.host.echo({ id: 9 })`)).toBe(9)
  })

  test("typeof a promise is 'object', and console.log renders it sensibly", async () => {
    const result = await run(`
      const p = Promise.resolve(1)
      console.log(p)
      return typeof p
    `)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toBe("object")
    expect(result.logs).toStrictEqual(["[Promise (await it to get its value)]"])
  })

  test("an awaited failure is catchable exactly like a synchronous throw", async () => {
    const result = await run(`
      const p = tools.host.fail({})
      try {
        await p
        return "no"
      } catch (e) {
        return e.message
      }
    `)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toBe("Lookup refused")
    expect(result.warnings).toBeUndefined()
  })

  test("a fire-and-forget call is interrupted when the program returns", async () => {
    const trace = makeTrace()
    const result = await run(
      `
        tools.host.pending({ id: 1 })
        return "done"
      `,
      { trace },
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toBe("done")
    expect(result.warnings).toBeUndefined()
    expect(trace.completed).toBe(0)
    expect(trace.interrupted).toBe(1)
  })

  test("a never-awaited failing call preserves the result and reports the rejection", async () => {
    const result = await run(`
      tools.host.fail({})
      return "done"
    `)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toBe("done")
    expect(result.warnings).toStrictEqual([
      { kind: "ToolFailure", message: "Unhandled rejection from an un-awaited promise: Lookup refused" },
    ])
    expect(Schema.decodeUnknownSync(CodeMode.Result)(JSON.parse(JSON.stringify(result)))).toStrictEqual(result)
  })

  test("a never-awaited failing async function is reported with a successful result", async () => {
    const result = await run(`
      const fail = async () => { throw new Error("boom") }
      fail()
      return "done"
    `)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toBe("done")
    expect(result.warnings).toStrictEqual([
      { kind: "ExecutionFailure", message: "Unhandled rejection from an un-awaited promise: Uncaught: boom" },
    ])
  })

  test("output truncation bounds warning diagnostics with an in-band marker", async () => {
    const result = await run(
      `
        for (let i = 0; i < 100; i += 1) Promise.reject(new Error("x".repeat(1_000)))
        return "done"
      `,
      { limits: { maxOutputBytes: 64 } },
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.truncated).toBe(true)
    expect(result.warnings).toStrictEqual([
      { kind: "Truncated", message: "100 additional warnings omitted by the output limit." },
    ])
  })

  test("a budget-consuming value does not starve warnings", async () => {
    const result = await run(
      `
        Promise.reject(new Error("boom"))
        return "x".repeat(500)
      `,
      { limits: { maxOutputBytes: 128 } },
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.truncated).toBe(true)
    expect(typeof result.value).toBe("string")
    expect(result.warnings).toStrictEqual([
      { kind: "ExecutionFailure", message: "Unhandled rejection from an un-awaited promise: Uncaught: boom" },
    ])
  })

  test("an un-awaited async function's pending chain is interrupted at the return", async () => {
    const trace = makeTrace()
    const result = await run(
      `
        const run = async () => {
          await tools.host.pending({ id: 1 })
          tools.host.fail({})
        }
        run()
        return "done"
      `,
      { trace },
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toBe("done")
    expect(result.warnings).toBeUndefined()
    expect(trace.starts).toEqual([1])
    expect(trace.completed).toBe(0)
    expect(trace.interrupted).toBe(1)
  })

  test("reports every unhandled rejection in promise creation order", async () => {
    const result = await run(`
      Promise.reject(new Error("first"))
      tools.host.fail({})
      Promise.reject(new Error("third"))
      return "done"
    `)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.warnings).toStrictEqual([
      { kind: "ExecutionFailure", message: "Unhandled rejection from an un-awaited promise: Uncaught: first" },
      { kind: "ToolFailure", message: "Unhandled rejection from an un-awaited promise: Lookup refused" },
      { kind: "ExecutionFailure", message: "Unhandled rejection from an un-awaited promise: Uncaught: third" },
    ])
  })

  test("orders an async function rejection before promises created inside its body", async () => {
    const result = await run(`
      const outer = async () => {
        Promise.reject(new Error("inner"))
        throw new Error("outer")
      }
      outer()
      return "done"
    `)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.warnings).toStrictEqual([
      { kind: "ExecutionFailure", message: "Unhandled rejection from an un-awaited promise: Uncaught: outer" },
      { kind: "ExecutionFailure", message: "Unhandled rejection from an un-awaited promise: Uncaught: inner" },
    ])
  })

  test("un-awaited interruptions settle without becoming rejections", async () => {
    const result = await run(`
      tools.host.interrupt({})
      Promise.all([tools.host.interrupt({})])
      return "done"
    `)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toBe("done")
    expect(result.warnings).toBeUndefined()
  })

  test("a fatal program error cancels outstanding work without reporting unhandled rejections", async () => {
    const trace = makeTrace()
    const result = await run(
      `
        tools.host.pending({ id: 1 })
        throw new Error("boom")
      `,
      { trace },
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.message).toBe("Uncaught: boom")
    expect("warnings" in result).toBe(false)
    expect(trace.completed).toBe(0)
    expect(trace.interrupted).toBe(1)
  })

  test("async-function promises remain owned by the execution after the function returns", async () => {
    const trace = makeTrace()
    expect(
      await value(
        `
          const launch = async () => {
            tools.host.pending({ id: 1 })
            Promise.all([tools.host.pending({ id: 2 })])
            return "returned"
          }
          return await launch()
        `,
        { trace },
      ),
    ).toBe("returned")
    // Both calls outlive launch() itself - they belong to the execution, not the function -
    // and are interrupted only when the whole program returns.
    expect(trace.starts).toEqual([1, 2])
    expect(trace.completed).toBe(0)
    expect(trace.interrupted).toBe(2)
  })
})

describe("promises at data boundaries", () => {
  test("returning an un-awaited promise inside data is a clear await-hinting diagnostic", async () => {
    const diagnostic = await error(`return { result: tools.host.echo({ id: 1 }) }`)
    expect(diagnostic.kind).toBe("InvalidDataValue")
    expect(diagnostic.message).toContain("un-awaited Promise")
    expect(diagnostic.message).toContain("await tools.ns.tool(...)")
  })

  test("collection helpers do not let un-awaited promises cross the result boundary", async () => {
    const diagnostic = await error(`return Array.from([Promise.resolve(1)])`)
    expect(diagnostic.kind).toBe("InvalidDataValue")
    expect(diagnostic.message).toContain("un-awaited Promise")
  })

  test("invalid returned data cancels pending work", async () => {
    const trace = makeTrace()
    const result = await run(
      `
        const pending = tools.host.pending({ id: 1 })
        return { pending }
      `,
      { trace, limits: { timeoutMs: 100 } },
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe("InvalidDataValue")
    expect(trace.completed).toBe(0)
    expect(trace.interrupted).toBe(1)
  })

  test("passing an un-awaited promise as a tool argument is a clear diagnostic", async () => {
    const diagnostic = await error(`return await tools.host.echo({ id: tools.host.echo({ id: 1 }) })`)
    expect(diagnostic.kind).toBe("InvalidDataValue")
    expect(diagnostic.message).toContain("un-awaited Promise")
  })

  test("JSON.stringify of a promise is a diagnostic, not '{}'", async () => {
    const diagnostic = await error(`return JSON.stringify(Promise.resolve(1))`)
    expect(diagnostic.kind).toBe("InvalidDataValue")
    expect(diagnostic.message).toContain("un-awaited Promise")
  })

  test("operators reject promise operands", async () => {
    const diagnostic = await error(`return Promise.resolve(1) + 1`)
    expect(diagnostic.kind).toBe("InvalidDataValue")
  })
})

describe("Promise.all over arbitrary arrays", () => {
  test("combinators return promises that can be assigned and awaited later", async () => {
    expect(
      await value(`
        const all = Promise.all([Promise.resolve(1)])
        const settled = Promise.allSettled([Promise.reject("no")])
        const race = Promise.race([Promise.resolve(2)])
        const promises = [all instanceof Promise, settled instanceof Promise, race instanceof Promise]
        return [promises, await all, await settled, await race]
      `),
    ).toEqual([[true, true, true], [1], [{ status: "rejected", reason: "no" }], 2])
  })

  test("separately-created aggregate batches overlap before either is awaited", async () => {
    const trace = makeTrace()
    expect(
      await value(
        `
          const first = Promise.all([tools.host.gated({ id: 1 })])
          const second = Promise.all([tools.host.gated({ id: 2 })])
          await tools.host.open({ id: 1 })
          await tools.host.open({ id: 2 })
          return [await first, await second]
        `,
        { trace },
      ),
    ).toEqual([[1], [2]])
    expect(trace.starts).toEqual([1, 2])
    expect(trace.maxActive).toBeGreaterThan(1)
  })

  test("an aggregate created before a try block rejects at its later await", async () => {
    expect(
      await value(`
        const aggregate = Promise.all([tools.host.fail({})])
        try {
          await aggregate
          return "no"
        } catch (error) {
          return error.message
        }
      `),
    ).toBe("Lookup refused")
  })

  test("awaiting an aggregate repeatedly does not rerun its members", async () => {
    const result = await run(`
      const aggregate = Promise.all([tools.host.echo({ id: 7 })])
      return [await aggregate, await aggregate]
    `)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toEqual([[7], [7]])
    expect(result.toolCalls).toStrictEqual([{ name: "host.echo" }])
  })

  test("mixes promises and plain values, preserving order", async () => {
    expect(
      await value(`
      return await Promise.all([tools.host.echo({ id: 1 }), "plain", tools.host.echo({ id: 2 }), 42])
    `),
    ).toEqual([1, "plain", 2, 42])
  })

  test("accepts arrays built beforehand, passed as identifiers, and spread elements", async () => {
    expect(
      await value(`
      const calls = []
      calls.push(tools.host.echo({ id: 1 }))
      calls.push(7)
      const more = [tools.host.echo({ id: 2 })]
      const batch = [...calls, ...more, "x"]
      return await Promise.all(batch)
    `),
    ).toEqual([1, 7, 2, "x"])
  })

  test("runs items.map tool calls in parallel", async () => {
    const trace = makeTrace()
    const result = await value(
      `
        const ids = [1, 2, 3, 4]
        const calls = ids.map((id) => tools.host.gated({ id }))
        for (const id of ids) await tools.host.open({ id })
        return await Promise.all(calls)
      `,
      { trace },
    )
    expect(result).toEqual([1, 2, 3, 4])
    // maxActive counts truly-overlapping live executions, so > 1 proves real
    // parallelism deterministically - no wall-clock assertion needed.
    expect(trace.maxActive).toBeGreaterThan(1)
  })

  test("runs async map callbacks concurrently", async () => {
    const trace = makeTrace()
    const result = await value(
      `
        const ids = [1, 2, 3, 4]
        const calls = ids.map(async (id) => await tools.host.gated({ id }))
        for (const id of ids) await tools.host.open({ id })
        return await Promise.all(calls)
      `,
      { trace },
    )
    expect(result).toEqual([1, 2, 3, 4])
    expect(trace.maxActive).toBeGreaterThan(1)
  })

  test("does not cap live tool-call concurrency", async () => {
    const trace = makeTrace()
    const result = await value(
      `
        const ids = []
        for (let i = 0; i < 20; i += 1) ids.push(i)
        const calls = ids.map((id) => tools.host.gated({ id }))
        for (const id of ids) await tools.host.open({ id })
        const results = await Promise.all(calls)
        return results.length
      `,
      { trace },
    )
    expect(result).toBe(20)
    expect(trace.maxActive).toBe(20)
  })

  test("resolves the empty array", async () => {
    expect(await value(`return await Promise.all([])`)).toEqual([])
  })

  test("rejects with the first failure, catchable in-program", async () => {
    const result = await run(`
      try {
        await Promise.all([tools.host.echo({ id: 1 }), tools.host.fail({})])
        return "no"
      } catch (e) {
        return e.message
      }
    `)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toBe("Lookup refused")
    expect(result.warnings).toBeUndefined()
  })

  test("rejects before an earlier slow promise fulfills", async () => {
    const trace = makeTrace()
    expect(
      await value(
        `
          try {
            await Promise.all([
              tools.host.pending({ id: 1 }),
              tools.host.fail({}),
            ])
            return -1
          } catch {
            return await tools.host.completed({})
          }
        `,
        { trace },
      ),
    ).toBe(0)
    // The surviving member is observed (Promise.all handled it), so completion interrupts
    // it instead of waiting for it.
    expect(trace.completed).toBe(0)
    expect(trace.interrupted).toBe(1)
  })

  test("fail-fast does not cancel a sibling the program still holds and awaits", async () => {
    const trace = makeTrace()
    expect(
      await value(
        `
          const slow = tools.host.gated({ id: 1 })
          try {
            await Promise.all([slow, tools.host.fail({})])
            return "no"
          } catch {}
          await tools.host.open({ id: 1 })
          return await slow
        `,
        { trace },
      ),
    ).toBe(1)
    expect(trace.completed).toBe(1)
    expect(trace.interrupted).toBe(0)
  })

  test("a slower observed sibling is interrupted at completion after failing fast", async () => {
    const trace = makeTrace()
    expect(
      await value(
        `
          const failLater = async () => {
            await tools.host.pending({ id: 1 })
            throw new Error("later")
          }
          const aggregate = Promise.all([Promise.reject(new Error("first")), failLater()])
          try {
            await aggregate
            return "no"
          } catch (error) {
            return error.message
          }
        `,
        { trace },
      ),
    ).toBe("first")
    expect(trace.completed).toBe(0)
    expect(trace.interrupted).toBe(1)
  })

  test("a non-collection argument is a clear error", async () => {
    const diagnostic = await error(`return await Promise.all(42)`)
    expect(diagnostic.message).toContain("Promise.all expects an array")
  })

  test("exceeding maxToolCalls inside Promise.all is a ToolCallLimitExceeded diagnostic", async () => {
    const diagnostic = await error(
      `return await Promise.all([tools.host.echo({ id: 1 }), tools.host.echo({ id: 2 }), tools.host.echo({ id: 3 })])`,
      { limits: { maxToolCalls: 2 } },
    )
    expect(diagnostic.kind).toBe("ToolCallLimitExceeded")
  })
})

describe("Promise.allSettled", () => {
  test("reports fulfilled and rejected outcomes with catch-normalized reasons", async () => {
    expect(
      await value(`
      return await Promise.allSettled([
        tools.host.echo({ id: 5 }),
        tools.host.fail({}),
        "plain",
        Promise.reject(new Error("boom")),
      ])
    `),
    ).toEqual([
      { status: "fulfilled", value: 5 },
      { status: "rejected", reason: { name: "Error", message: "Lookup refused" } },
      { status: "fulfilled", value: "plain" },
      { status: "rejected", reason: { name: "Error", message: "boom" } },
    ])
  })

  test("never rejects for program-level failures", async () => {
    const result = await run(`
      const settled = await Promise.allSettled([tools.host.fail({}), tools.host.fail({})])
      return settled.filter((s) => s.status === "rejected").length
    `)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toBe(2)
    expect(result.warnings).toBeUndefined()
  })
})

describe("Promise.race", () => {
  test("first settlement wins and a direct loser is interrupted at completion", async () => {
    const trace = makeTrace()
    const result = await value(
      `
        const fast = tools.host.echo({ id: 1 })
        const slow = tools.host.pending({ id: 2 })
        return await Promise.race([fast, slow])
      `,
      { trace },
    )
    expect(result).toBe(1)
    // The loser is observed (the race handled it), so the execution does not wait for it.
    expect(trace.completed).toBe(1)
    expect(trace.interrupted).toBe(1)
  })

  test("a direct loser remains awaitable after the race settles", async () => {
    expect(
      await value(`
      const fast = tools.host.echo({ id: 1 })
      const slow = tools.host.gated({ id: 2 })
      const winner = await Promise.race([fast, slow])
      await tools.host.open({ id: 2 })
      return { winner, loser: await slow }
    `),
    ).toEqual({ winner: 1, loser: 2 })
  })

  test("a nested aggregate loser and its members are interrupted at completion", async () => {
    const trace = makeTrace()
    expect(
      await value(
        `
          const nested = Promise.all([
            tools.host.pending({ id: 1 }),
            tools.host.pending({ id: 2 }),
          ])
          return await Promise.race(["immediate", nested])
        `,
        { trace },
      ),
    ).toBe("immediate")
    // The nested aggregate and its members are all observed, so nothing waits for them.
    expect(trace.completed).toBe(0)
    expect(trace.interrupted).toBe(2)
  })

  test("a rejection can win the race", async () => {
    expect(
      await value(`
      try {
        await Promise.race([tools.host.fail({}), tools.host.pending({ id: 1 })])
        return "no"
      } catch (e) {
        return e.message
      }
    `),
    ).toBe("Lookup refused")
  })

  test("a plain value wins over pending promises", async () => {
    const trace = makeTrace()
    expect(await value(`return await Promise.race([tools.host.pending({ id: 1 }), "immediate"])`, { trace })).toBe(
      "immediate",
    )
    expect(trace.completed).toBe(0)
    expect(trace.interrupted).toBe(1)
  })

  test("a rejected race loser is observed by the aggregate", async () => {
    const result = await run(`return await Promise.race(["winner", tools.host.fail({})])`)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toBe("winner")
    expect(result.warnings).toBeUndefined()
  })

  test("an empty race is a clear error instead of hanging", async () => {
    const diagnostic = await error(`return await Promise.race([])`)
    expect(diagnostic.message).toContain("never settle")
  })
})

describe("Promise.resolve / Promise.reject", () => {
  test("resolve wraps plain values and passes promises through", async () => {
    expect(await value(`return await Promise.resolve(42)`)).toBe(42)
    expect(await value(`return await Promise.resolve(Promise.resolve("nested"))`)).toBe("nested")
    expect(await value(`return await Promise.resolve(tools.host.echo({ id: 3 }))`)).toBe(3)
    expect(await value(`const promise = Promise.resolve(1); return [promise].includes(Promise.resolve(promise))`)).toBe(
      true,
    )
  })

  test("reject produces a promise whose await throws the reason", async () => {
    expect(
      await value(`
      try {
        await Promise.reject("nope")
        return "no"
      } catch (e) {
        return e
      }
    `),
    ).toBe("nope")
  })

  test("a rejection observed after settlement is handled", async () => {
    expect(
      await value(`
        const rejected = Promise.reject(new Error("handled"))
        await tools.host.echo({ id: 1 })
        try {
          await rejected
          return "no"
        } catch (error) {
          return error.message
        }
      `),
    ).toBe("handled")
  })

  test("an abandoned rejected promise is reported as unhandled", async () => {
    const result = await run(`
      Promise.reject(new Error("abandoned"))
      return "done"
    `)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toBe("done")
    expect(result.warnings).toStrictEqual([
      { kind: "ExecutionFailure", message: "Unhandled rejection from an un-awaited promise: Uncaught: abandoned" },
    ])
  })
})

describe("timeout interruption of forked calls", () => {
  test("the execution timeout interrupts in-flight forked fibers", async () => {
    const trace = makeTrace()
    const result = await run(
      `
        const a = tools.host.pending({ id: 1 })
        const b = tools.host.pending({ id: 2 })
        return await a
      `,
      { trace, limits: { timeoutMs: 100 } },
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe("TimeoutExceeded")
    // Both calls started; neither escaped the timeout - the awaited one AND the abandoned one.
    expect(trace.starts).toEqual([1, 2])
    expect(trace.interrupted).toBe(2)
    expect(trace.completed).toBe(0)
  })

  test("the timeout also interrupts calls inside Promise.all", async () => {
    const trace = makeTrace()
    const result = await run(
      `return await Promise.all([tools.host.pending({ id: 1 }), tools.host.pending({ id: 2 })])`,
      { trace, limits: { timeoutMs: 100 } },
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe("TimeoutExceeded")
    expect(trace.interrupted).toBe(2)
  })

  test("a non-settling race loser cannot hold the execution to the timeout", async () => {
    const trace = makeTrace()
    const result = await run(`return await Promise.race(["winner", tools.host.pending({ id: 1 })])`, {
      trace,
      limits: { timeoutMs: 100 },
    })
    // Completion interrupts the observed loser immediately; the race result survives.
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toBe("winner")
    expect(result.warnings).toBeUndefined()
    expect(trace.starts).toEqual([1])
    expect(trace.completed).toBe(0)
    expect(trace.interrupted).toBe(1)
  })

  test("a timeout during completion cleanup keeps the computed value and warns", async () => {
    const trace = makeTrace()
    const result = await run(
      `
        tools.host.stubborn({ cleanupMs: 400 })
        return "done"
      `,
      { trace, limits: { timeoutMs: 100 } },
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toBe("done")
    expect(result.warnings).toStrictEqual([
      {
        kind: "TimeoutExceeded",
        message:
          "The program returned, but background work was still running at the 100ms timeout and was interrupted. Await all started promises.",
      },
    ])
    expect(trace.interrupted).toBe(1)
    expect(trace.completed).toBe(0)
  })

  test("a timeout during completion cleanup reports the timeout warning before settled rejections", async () => {
    const result = await run(
      `
        tools.host.fail({})
        tools.host.stubborn({ cleanupMs: 400 })
        return "done"
      `,
      { limits: { timeoutMs: 100 } },
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toBe("done")
    expect(result.warnings).toStrictEqual([
      {
        kind: "TimeoutExceeded",
        message:
          "The program returned, but background work was still running at the 100ms timeout and was interrupted. Await all started promises.",
      },
      { kind: "ToolFailure", message: "Unhandled rejection from an un-awaited promise: Lookup refused" },
    ])
  })
})

describe("promise chaining", () => {
  test("then transforms tool results and adopts returned promises across a chain", async () => {
    expect(
      await value(`
        return await tools.host
          .echo({ id: 2 })
          .then((id) => tools.host.echo({ id: id + 1 }))
          .then((id) => id * 10)
      `),
    ).toBe(30)
  })

  test("handlers are deferred and run in attach order", async () => {
    expect(
      await value(`
        const order = []
        const promise = Promise.resolve(1)
        promise.then(() => order.push("h1"))
        promise.then(() => order.push("h2"))
        order.push("sync")
        await promise
        return order
      `),
    ).toEqual(["sync", "h1", "h2"])
  })

  test("catch recovers a tool failure and preserves fulfillment", async () => {
    expect(
      await value(`
        return [
          await tools.host.fail({}).catch((error) => error.message),
          await tools.host.echo({ id: 4 }).catch(() => "unused"),
        ]
      `),
    ).toEqual(["Lookup refused", 4])
  })

  test("finally observes settlement without changing the value", async () => {
    expect(
      await value(`
        const events = []
        const result = await tools.host.echo({ id: 5 }).finally(() => events.push("cleanup"))
        return [result, events]
      `),
    ).toEqual([5, ["cleanup"]])
  })

  test("a settled, un-awaited rejected chain tail warns exactly once", async () => {
    const result = await run(`
      Promise.reject(new Error("boom")).then((value) => value)
      await Promise.resolve()
      return "done"
    `)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toBe("done")
    // The source rejection belongs to the chain (no warning); only the derived tail warns.
    expect(result.warnings).toStrictEqual([
      { kind: "ExecutionFailure", message: "Unhandled rejection from an un-awaited promise: Uncaught: boom" },
    ])
  })

  test("a catch handler silences the chain's rejection warning", async () => {
    const result = await run(`
      Promise.reject(new Error("boom")).catch(() => "handled")
      await Promise.resolve()
      return "done"
    `)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.warnings).toBeUndefined()
  })

  test("unsupported callable handlers fail loudly with a wrap hint", async () => {
    const diagnostic = await error(`return await tools.host.echo({ id: 1 }).then(tools.host.completed)`)
    expect(diagnostic.message).toContain("Promise.prototype.then cannot use this callable as a handler")
    expect(diagnostic.message).toContain("wrap it in an arrow function")
  })

  test("chaining methods are opaque references until called", async () => {
    expect(await value(`return typeof tools.host.echo({ id: 1 }).then`)).toBe("function")
  })
})

describe("combinator settlement timing", () => {
  test("a combinator settling one reaction turn after the program returns is interrupted silently", async () => {
    // The aggregate's one-turn settlement delay (V8 parity) means an immediately-returning
    // program abandons it while still pending: interrupted like any pending work, so no
    // rejection warning survives - the member itself was observed by the combinator.
    const result = await run(`
      Promise.all([Promise.reject(new Error("boom"))])
      return "done"
    `)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toBe("done")
    expect(result.warnings).toBeUndefined()
  })

  test("a combinator settles one reaction turn after its members, as in V8", async () => {
    // Regression for the race winner flip: Promise.all's settlement burns a reaction turn,
    // so a plain resolved value entered in the same race wins, and a fail-fast aggregate
    // cannot beat it into rejection.
    expect(
      await value(`
        const pending = tools.host.pending({ id: 9 })
        const winner = await Promise.race([Promise.all([Promise.resolve(1)]), Promise.resolve(2)])
        try {
          const raced = await Promise.race([Promise.all([Promise.reject("x"), pending]), Promise.resolve("ok")])
          return [winner, "fulfilled", raced]
        } catch (reason) {
          return [winner, "rejected", reason]
        }
      `),
    ).toEqual([2, "fulfilled", "ok"])
  })
})

describe("unsupported promise surface", () => {
  test("other property reads on a promise hint at the missing await", async () => {
    const diagnostic = await error(`return tools.host.echo({ id: 1 }).value`)
    expect(diagnostic.kind).toBe("InvalidDataValue")
    expect(diagnostic.message).toContain("un-awaited Promise")
    expect(diagnostic.message).toContain("await it first")
  })

  test("unknown Promise statics are not functions", async () => {
    const diagnostic = await error(`return await Promise.withResolvers()`)
    expect(diagnostic.message).toContain("Promise.withResolvers is not a function")
  })
})

describe("Promise.any", () => {
  test("first tool success wins; failing and losing calls are handled silently", async () => {
    const trace = makeTrace()
    const result = await run(
      `
        const winner = await Promise.any([
          tools.host.fail({}),
          tools.host.echo({ id: 1 }),
          tools.host.pending({ id: 2 }),
        ])
        return winner
      `,
      { trace },
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toBe(1)
    // The slow loser stays execution-owned and is interrupted at completion; the tool
    // failure was observed by the aggregate, so no rejection warning survives.
    expect(result.warnings).toBeUndefined()
    expect(trace.interrupted).toBe(1)
  })

  test("all members failing rejects with catch-normalized reasons in input order", async () => {
    expect(
      await value(`
        try {
          await Promise.any([tools.host.fail({}), Promise.reject("plain")])
          return "fulfilled"
        } catch (error) {
          return [error.name, error.errors.map((reason) => reason.message ?? reason)]
        }
      `),
    ).toEqual(["AggregateError", ["Lookup refused", "plain"]])
  })

  test("settles one reaction turn after its deciding member, as in V8", async () => {
    expect(await value(`return await Promise.race([Promise.any([Promise.resolve(1)]), Promise.resolve(2)])`)).toBe(2)
  })

  test("a tie is decided by settlement order, not input order", async () => {
    // Handlers run in attach order, so `first` settles before `second` and wins
    // despite its later input position - as in real JS.
    expect(
      await value(`
        const first = Promise.resolve().then(() => "one")
        const second = Promise.resolve().then(() => "two")
        return await Promise.any([second, first])
      `),
    ).toBe("one")
  })

  test("an abandoned rejecting aggregate is interrupted silently at the return", async () => {
    const result = await run(`
      Promise.any([Promise.reject(new Error("boom"))])
      return "done"
    `)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toBe("done")
    expect(result.warnings).toBeUndefined()
  })
})

describe("promise construction", () => {
  test("a deferred gate coordinates tool results across async functions", async () => {
    expect(
      await value(`
        let openGate
        const gate = new Promise((resolve) => { openGate = resolve })
        const worker = (async () => {
          const id = await gate
          return id * 2
        })()
        openGate(await tools.host.echo({ id: 21 }))
        return await worker
      `),
    ).toBe(42)
  })

  test("the .then(resolve) bridge settles a constructed promise", async () => {
    expect(
      await value(`
        const bridged = new Promise((resolve, reject) => {
          tools.host.echo({ id: 7 }).then(resolve, reject)
        })
        return await bridged
      `),
    ).toBe(7)
  })

  test("constructed promises participate in combinators", async () => {
    expect(
      await value(`
        let settle
        const manual = new Promise((resolve) => { settle = resolve })
        const race = Promise.race([manual, tools.host.pending({ id: 3 })])
        const all = Promise.all([manual, "plain"])
        const any = Promise.any([manual, new Promise(() => {})])
        settle("manual")
        return [await race, await all, await any]
      `),
    ).toEqual(["manual", ["manual", "plain"], "manual"])
  })

  test("resolving with a pending promise adopts its later settlement", async () => {
    expect(
      await value(`
        let innerResolve, innerReject
        const adopted = new Promise((resolve) => resolve(new Promise((resolve) => { innerResolve = resolve })))
        const adoptedRejection = new Promise((resolve) => resolve(new Promise((_, reject) => { innerReject = reject })))
        innerResolve("later")
        innerReject("bad")
        try {
          return [await adopted, await adoptedRejection]
        } catch (reason) {
          return [await adopted, reason]
        }
      `),
    ).toEqual(["later", "bad"])
  })

  test("an async executor's post-await resolve settles the promise", async () => {
    expect(
      await value(`
        const result = new Promise(async (resolve) => {
          const id = await tools.host.echo({ id: 5 })
          resolve(id * 2)
        })
        return await result
      `),
    ).toBe(10)
  })

  test("a never-settled promise is abandoned silently at the return", async () => {
    const result = await run(`
      const forever = new Promise(() => {})
      forever.then(() => {})
      return "done"
    `)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toBe("done")
    expect(result.warnings).toBeUndefined()
  })

  test("an un-awaited constructed rejection is reported like any unhandled rejection", async () => {
    const result = await run(`
      new Promise((_, reject) => reject(new Error("dropped")))
      await Promise.resolve()
      await Promise.resolve()
      return "done"
    `)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toBe("done")
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings?.[0].message).toContain("Unhandled rejection")
    expect(result.warnings?.[0].message).toContain("dropped")
  })

  test("resolver functions cannot cross the data boundary", async () => {
    const diagnostic = await error(`
      let escaped
      new Promise((resolve) => { escaped = resolve })
      return { escaped }
    `)
    expect(diagnostic.kind).toBe("InvalidDataValue")
  })
})
