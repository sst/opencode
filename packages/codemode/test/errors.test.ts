import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { CodeMode } from "../src/index.js"

// One failure is one program error object, and rethrowing it keeps the diagnostic it started with.
const run = (code: string) => Effect.runPromise(CodeMode.execute({ code, tools: {} }))
const value = async (code: string) => {
  const result = await run(code)
  if (!result.ok) throw new Error(`expected success, got ${result.error.kind}: ${result.error.message}`)
  return result.value
}
const error = async (code: string) => {
  const result = await run(code)
  if (result.ok) throw new Error(`expected failure, got value ${JSON.stringify(result.value)}`)
  return result.error
}

describe("error identity", () => {
  test("awaiting the same rejected promise twice yields the same error object", async () => {
    expect(
      await value(`
        const fail = async () => { null.foo }
        const p = fail()
        const a = await p.catch((e) => e)
        try { await p } catch (b) { return a === b }
      `),
    ).toBe(true)
  })

  test("allSettled reasons for the same failure are identical", async () => {
    expect(
      await value(`
        const fail = async () => { null.foo }
        const p = fail()
        const [a, b] = await Promise.allSettled([p, p])
        return [a.reason === b.reason, a.reason.name, a.reason.message]
      `),
    ).toEqual([true, "TypeError", "Cannot read properties of null (reading 'foo')."])
  })

  test("Promise.any collects the same object a direct catch would", async () => {
    expect(
      await value(`
        const fail = async () => { null.foo }
        const p = fail()
        const direct = await p.catch((e) => e)
        try { await Promise.any([p]) } catch (aggregate) { return aggregate.errors[0] === direct }
      `),
    ).toBe(true)
  })
})

describe("rethrown interpreter failures", () => {
  test("keep their diagnostic kind and source location", async () => {
    const failure = await error(`try { switch (Symbol) {} } catch (e) { throw e }`)
    expect(failure.kind).toBe("InvalidDataValue")
    expect(failure.message).toStartWith("Switch discriminants must be data values. (line ")
    expect(failure.location).toBeDefined()
  })

  test("keep their location through a rejection handler", async () => {
    const direct = await error(`
      const fail = async () => { null.foo }
      await fail()
    `)
    const rethrown = await error(`
      const fail = async () => { null.foo }
      await fail().catch((e) => { throw e })
    `)
    expect(direct.location).toBeDefined()
    expect(rethrown).toEqual(direct)
  })
})

describe("uncaught program throws", () => {
  test("an Error reports as name: message", async () => {
    const failure = await error(`throw new TypeError("bad input")`)
    expect(failure).toEqual({ kind: "ExecutionFailure", message: "TypeError: bad input" })
  })

  test("a custom name is honored", async () => {
    const failure = await error(`const e = new Error("x"); e.name = "ValidationError"; throw e`)
    expect(failure.message).toBe("ValidationError: x")
  })

  test("non-Error values keep the Uncaught prefix", async () => {
    expect((await error(`throw "boom"`)).message).toBe("Uncaught: boom")
    expect((await error(`throw { code: 7 }`)).message).toBe('Uncaught: {"code":7}')
  })
})

describe("host errors escaping built-ins", () => {
  test("become the same-named program error", async () => {
    expect(
      await value(`
        try { (1).toFixed(200) } catch (e) { return [e.name, e instanceof RangeError, e.message] }
      `),
    ).toEqual(["RangeError", true, "toFixed() argument must be between 0 and 100"])
  })

  test("report the location of the call that raised them", async () => {
    const failure = await error(`return [1].map((n) => n.toFixed(200))`)
    expect(failure.kind).toBe("ExecutionFailure")
    expect(failure.message).toBe("toFixed() argument must be between 0 and 100 (line 1, col 23)")
  })

  test("a failure inside a built-in called by another built-in is located at the outer call", async () => {
    const failure = await error(`return Array.from({ [Symbol.iterator]: () => ({ next: 1 }) })`)
    expect(failure.message).toBe("Iterator next must be a function. (line 1, col 8)")
  })
})
