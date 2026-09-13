import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { CodeMode, Tool } from "../src/index.js"

// Key enumeration: Object.keys and for...in share one surface over plain objects, arrays
// (index strings), and tool references (namespace/tool names from the supplied tools), so a
// model can discover what it may call instead of guessing names from the instructions. The
// motivating transcript: `Object.keys(tools)` failed with the generic plain-objects-only
// message and `for (const key in tools)` was unsupported syntax, forcing blind guesses.

const echo = (description: string) =>
  Tool.make({
    description,
    input: Schema.Struct({ value: Schema.String }),
    output: Schema.String,
    execute: ({ value }) => Effect.succeed(value),
  })

const tools = {
  github: { list_issues: echo("List issues"), get_issue: echo("Get one issue") },
  memory: { search: echo("Search memory") },
  playwright: { navigate: echo("Navigate somewhere") },
}

const run = (code: string) => Effect.runPromise(CodeMode.execute({ tools, code }))
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

describe("Object.keys over tool references", () => {
  test("enumerates top-level namespaces (the transcript program)", async () => {
    expect(
      await value(`
      const namespaces = Object.keys(tools)
      return { namespaces, count: namespaces.length }
    `),
    ).toEqual({ namespaces: ["github", "memory", "playwright"], count: 3 })
  })

  test("enumerates tool names at a nested namespace", async () => {
    expect(await value(`return Object.keys(tools.github)`)).toEqual(["list_issues", "get_issue"])
  })

  test("a callable tool is a leaf and enumerates as []", async () => {
    expect(await value(`return Object.keys(tools.github.list_issues)`)).toEqual([])
  })

  test("search is a global built-in function", async () => {
    expect(await value(`return typeof search`)).toBe("function")
  })

  test("an unknown namespace is an UnknownTool error", async () => {
    const failure = await error(`return Object.keys(tools.nonexistent)`)
    expect(failure.kind).toBe("UnknownTool")
    expect(failure.message).toContain("Unknown tool namespace 'nonexistent'")
  })

  test("Object.values/entries on a tool reference explain the working idioms", async () => {
    for (const method of ["values", "entries"] as const) {
      const failure = await error(`return Object.${method}(tools)`)
      expect(failure.kind).toBe("InvalidDataValue")
      expect(failure.message).toContain(
        `Object.${method}(...) cannot read tool references: they are not plain data. Use Object.keys(tools) for names, or search({ query }) for signatures.`,
      )
    }
    const nested = await error(`return Object.entries(tools.github)`)
    expect(nested.message).toContain("Use Object.keys(tools) for names")
  })
})

describe("Object.keys over arrays", () => {
  test("returns index strings, like JS", async () => {
    expect(await value(`return Object.keys(["a", "b", "c"])`)).toEqual(["0", "1", "2"])
    expect(await value(`return Object.keys([])`)).toEqual([])
  })

  test("objects keep their own enumerable keys", async () => {
    expect(await value(`return Object.keys({ a: 1, b: 2 })`)).toEqual(["a", "b"])
  })

  test("non-object inputs follow ToObject, and nullish inputs name what was received", async () => {
    expect(
      await value(`return [Object.keys("ab"), Object.entries(42), Object.keys(() => 1), Object.keys(true)]`),
    ).toEqual([["0", "1"], [], [], []])
    expect(await value(`try { Object.values(null) } catch (e) { return [e.name, e.message] }`)).toEqual([
      "TypeError",
      "Object.values(...) cannot convert null to an object.",
    ])
    expect((await error(`return Object.keys(tools.github.list_issues({ value: "x" }))`)).message).toContain(
      "received an un-awaited Promise",
    )
    expect(await value(`const { a, size } = new Map(); return [a, size]`)).toEqual([null, 0])
    expect((await error(`return Array.from(7)`)).message).toContain("received a number.")
    expect(await value(`return [(() => 1).x, Object.keys(() => 1)]`)).toEqual([null, []])
  })
})

describe("for...in", () => {
  test("iterates own enumerable keys of a plain object with break/continue", async () => {
    expect(
      await value(`
      const seen = []
      for (const key in { a: 1, b: 2, c: 3, d: 4 }) {
        if (key === "b") continue
        if (key === "d") break
        seen.push(key)
      }
      return seen
    `),
    ).toEqual(["a", "c"])
  })

  test("iterates index strings over arrays", async () => {
    expect(
      await value(`
      const indexes = []
      for (const i in ["x", "y", "z"]) {
        if (i === "2") break
        indexes.push(i)
      }
      return indexes
    `),
    ).toEqual(["0", "1"])
  })

  test("supports let declarations and bare identifiers", async () => {
    expect(
      await value(`
      let last = ""
      for (let key in { a: 1, b: 2 }) last = key
      return last
    `),
    ).toBe("b")
    expect(
      await value(`
      let key = "before"
      for (key in { only: 1 }) {}
      return key
    `),
    ).toBe("only")
  })

  test("enumerates namespaces and tools from the supplied tools", async () => {
    expect(
      await value(`
      const names = []
      for (const ns in tools) {
        for (const name in tools[ns]) names.push(ns + "." + name)
      }
      return names
    `),
    ).toEqual(["github.list_issues", "github.get_issue", "memory.search", "playwright.navigate"])
  })

  test("non-object values enumerate like JS: strings by index, everything else nothing", async () => {
    expect(
      await value(`
        const out = []
        for (const key in "ab") out.push(key)
        for (const key in 42) out.push(key)
        for (const key in null) out.push(key)
        for (const key in undefined) out.push(key)
        for (const key in new Map([[1, 2]])) out.push(key)
        for (const key in Math) out.push(key)
        return out
      `),
    ).toEqual(["0", "1"])
    expect((await error(`for (const key in tools.github.list_issues({ value: "x" })) {}`)).message).toContain(
      "un-awaited Promise",
    )
  })
})
