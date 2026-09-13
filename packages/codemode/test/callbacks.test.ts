import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { CodeMode, Tool } from "../src/index.js"

// Callback acceptance is one gate shared by array methods, sort, string replacers,
// Array.from mappers, Map/Set/URLSearchParams forEach, and promise reactions:
// interpreter functions, coercion/URI builtins, resolver capabilities, and built-in
// method references are callable; tools and other opaque callables get a wrap hint.
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
const logsOf = async (code: string) => {
  const result = await run(code)
  if (!result.ok) throw new Error(`expected success, got ${result.error.kind}: ${result.error.message}`)
  return result.logs ?? []
}

const echo = Tool.make({
  description: "Echo the input",
  input: Schema.Struct({ id: Schema.Number }),
  output: Schema.Number,
  execute: (input: { id: number }) => Effect.succeed(input.id),
})
const withTool = (code: string) => Effect.runPromise(CodeMode.make({ tools: { host: { echo } } }).execute(code))
const toolError = async (code: string) => {
  const result = await withTool(code)
  if (result.ok) throw new Error(`expected failure, got value ${JSON.stringify(result.value)}`)
  return result.error
}

describe("built-in method references as callbacks", () => {
  test("map accepts Math methods", async () => {
    expect(await value(`return [-1, 2, -3].map(Math.abs)`)).toEqual([1, 2, 3])
    expect(await value(`return [1.5, 2.7].map(Math.floor)`)).toEqual([1, 2])
  })

  test("map(JSON.stringify) matches JS: the index replacer and array space are ignored", async () => {
    expect(await value(`return [{ a: 1 }, [2]].map(JSON.stringify)`)).toEqual(['{"a":1}', "[2]"])
  })

  test("map(Number.parseInt) reproduces the JS radix footgun", async () => {
    // parseInt("2", 1) is NaN in real JS; NaN serializes to null at the result boundary.
    expect(await value(`return ["1", "2"].map(Number.parseInt)`)).toEqual([1, null])
  })

  test("filter and find accept built-in predicates", async () => {
    expect(await value(`return [0, 1, NaN, 2].filter(Number.isInteger)`)).toEqual([0, 1, 2])
    expect(await value(`return [1.5, 3, 2.5].find(Number.isInteger)`)).toBe(3)
  })

  test("forEach(console.log) captures one log line per element", async () => {
    const logs = await logsOf(`["a", "b"].forEach(console.log); return null`)
    expect(logs).toHaveLength(2)
    expect(logs[0]).toContain("a")
    expect(logs[1]).toContain("b")
  })

  test("detached method references lose their receiver, like JS", async () => {
    expect((await error(`return ["a", "z"].filter("abc".includes)`)).message).toContain(
      "String.prototype.includes called on null or undefined",
    )
  })

  test("promise reactions accept built-in references", async () => {
    expect(await value(`return await Promise.resolve(-5).then(Math.abs)`)).toBe(5)
    const logs = await logsOf(`await Promise.resolve("done").then(console.log); return null`)
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain("done")
  })
})

describe("constructors callable without new, like JS", () => {
  test("Error constructors work as callbacks and direct calls", async () => {
    expect(await value(`return ["boom"].map(Error)[0].message`)).toBe("boom")
    expect(await value(`return TypeError("bad").name`)).toBe("TypeError")
  })

  test("error values stringify like JS Error.prototype.toString", async () => {
    expect(await value(`return String(TypeError("bad"))`)).toBe("TypeError: bad")
    expect(await value(`return String(Error(""))`)).toBe("Error")
    expect(await value(`return "x" + RangeError("oops")`)).toBe("xRangeError: oops")
    expect(await value(`return "a1b2".replace(/\\d/, Error)`)).toBe("aError: 1b2")
  })

  test("literal elisions are real holes, like JS", async () => {
    expect(await value(`return (0 in [, 1])`)).toBe(false)
    expect(await value(`return Object.keys([, 1, ,])`)).toEqual(["1"])
    expect(await value(`return [, 1, ,].filter(() => true).length`)).toBe(1)
    expect(await value(`return [, ,].every((x) => false)`)).toBe(true)
  })

  test("Array constructs from arguments or a length", async () => {
    expect(await value(`return Array(1, 2, 3)`)).toEqual([1, 2, 3])
    expect(await value(`return Array("3")`)).toEqual(["3"])
    expect(await value(`return Array(3).length`)).toBe(3)
    expect(await value(`return new Array(2).length`)).toBe(2)
    // Holes stay holes, like JS: map skips them (length preserved, normalized to
    // null at the host boundary), spread materializes undefined.
    expect(await value(`return Array(3).map((x) => 1)`)).toEqual([null, null, null])
    expect(await value(`return Array(3).map((x) => 1).length`)).toBe(3)
    expect(await value(`return [...Array(3)].map((_, i) => i)`)).toEqual([0, 1, 2])
    expect((await error(`return Array(-1)`)).message).toContain("Invalid array length")
    expect((await error(`return Array(1.5)`)).message).toContain("Invalid array length")
  })

  test("Object returns objects unchanged and rejects primitive wrappers", async () => {
    expect(await value(`return Object()`)).toEqual({})
    expect(await value(`const o = { a: 1 }; return Object(o) === o`)).toBe(true)
    expect((await error(`return Object(1)`)).message).toContain("wrapper objects are not supported")
  })

  test("Date() without new returns a deterministic ISO string and ignores arguments", async () => {
    expect(await value(`return /^\\d{4}-\\d{2}-\\d{2}T.*Z$/.test(Date(1000))`)).toBe(true)
    expect(await value(`return "abc".replace(RegExp("b"), "x")`)).toBe("axc")
  })

  test("map(Array) matches the JS 3-argument call", async () => {
    expect(await value(`return [7].map(Array)`)).toEqual([[7, 0, [7]]])
  })

  test("array length boundaries match JS", async () => {
    expect(await value(`return Array(4294967295).length`)).toBe(4294967295)
    const diagnostic = await error(`return Array(4294967296)`)
    expect(diagnostic.message).toContain("Invalid array length")
    expect((await error(`try { Array(-1) } catch (e) { throw Error(e.name) }`)).message).toContain("RangeError")
  })

  test("returned sparse arrays normalize holes to null at the host boundary", async () => {
    expect(await value(`return Array(3)`)).toEqual([null, null, null])
  })

  test("RegExp with non-string flags throws a SyntaxError, like JS", async () => {
    expect((await error(`try { RegExp("a", 0) } catch (e) { throw Error(e.name) }`)).message).toContain("SyntaxError")
  })

  test("new-requiring constructors throw a TypeError when called", async () => {
    expect((await error(`return Map()`)).message).toContain("Constructor Map requires 'new'")
    expect((await error(`return [1].map(Set)`)).message).toContain("Constructor Set requires 'new'")
    expect((await error(`return Promise(() => 1)`)).message).toContain("Constructor Promise requires 'new'")
    // As a reaction handler the TypeError rejects the derived promise catchably, like JS.
    expect(await value(`return await Promise.resolve(1).then(Map).catch((e) => e.name)`)).toBe("TypeError")
  })
})

describe("sort accepts the unified callback set", () => {
  test("sort preserves trailing holes while toSorted densifies them", async () => {
    expect(
      await value(`
        const defaultSorted = [2, , 1]
        const compared = [2, , 1]
        const copied = defaultSorted.toSorted()
        defaultSorted.sort()
        compared.sort((a, b) => a - b)
        return [
          Object.hasOwn(defaultSorted, 2),
          Object.hasOwn(compared, 2),
          Object.hasOwn(copied, 2),
        ]
      `),
    ).toEqual([false, false, true])

    expect(await value(`const values = [2, undefined, 1]; values.sort(); return Object.hasOwn(values, 2)`)).toBe(true)
  })

  test("sort writes its snapshot without discarding comparator length mutations", async () => {
    expect(
      await value(`
        const values = [3, 2, 1]
        let first = true
        values.sort((a, b) => {
          if (first) {
            first = false
            values.push("kept")
          }
          return a - b
        })
        return values
      `),
    ).toEqual([1, 2, 3, "kept"])

    expect(
      await value(`
        const values = [3, , 1, , 2]
        let first = true
        values.sort((a, b) => {
          if (first) {
            first = false
            values.splice(0)
          }
          return a - b
        })
        return { values, owns: values.map((_, index) => Object.hasOwn(values, index)) }
      `),
    ).toEqual({ values: [1, 2, 3], owns: [true, true, true] })
  })

  test("sort and toSorted take built-in comparators", async () => {
    expect(await value(`return [0, 1, 0].sort(Boolean)`)).toEqual([0, 0, 1])
    expect(await value(`return [0, 1, 0].toSorted(Boolean)`)).toEqual([0, 0, 1])
  })

  test("a non-callable comparator is rejected", async () => {
    expect((await error(`return [2, 1].sort(42)`)).message).toContain("Array.sort expects a function callback")
    expect((await error(`return [2, 1].toSorted(42)`)).message).toContain("Array.toSorted expects a function callback")
  })
})

describe("Array.from mapper", () => {
  test("maps with (value, index) over arrays, strings, and Sets", async () => {
    expect(await value(`return Array.from([1, 2, 3], (x) => x * 2)`)).toEqual([2, 4, 6])
    expect(await value(`return Array.from("ab", (c, i) => c + i)`)).toEqual(["a0", "b1"])
    expect(await value(`return Array.from(new Set([1, 2]), (x) => x * 10)`)).toEqual([10, 20])
  })

  test("accepts coercion builtins and an explicit undefined mapper", async () => {
    expect(await value(`return Array.from(["5", "7"], Number)`)).toEqual([5, 7])
    expect(await value(`return Array.from([1, 2], undefined)`)).toEqual([1, 2])
  })

  test("rejects a non-callable mapper", async () => {
    expect((await error(`return Array.from([1], 42)`)).message).toContain("Array.from expects a function callback")
  })
})

describe("thisArg is accepted and ignored, like JS arrows", () => {
  // CodeMode functions have no `this`, so a thisArg can never change behavior —
  // exactly like passing one alongside an arrow function in real JS.
  test("iteration methods and Array.from ignore a thisArg", async () => {
    expect(await value(`return [1, 2].map((x) => x * 2, {})`)).toEqual([2, 4])
    expect(await value(`return [1, 2].map((x) => x, undefined)`)).toEqual([1, 2])
    expect(await value(`return Array.from([1], (x) => x + 1, {})`)).toEqual([2])
  })

  test("Map, Set, and URLSearchParams forEach ignore a thisArg", async () => {
    expect(await value(`const o = []; new Map([["a", 1]]).forEach((v, k) => o.push(k), {}); return o`)).toEqual(["a"])
    expect(await value(`const o = []; new Set([1]).forEach((v) => o.push(v), "self"); return o`)).toEqual([1])
    expect(await value(`const o = []; new URLSearchParams("a=1").forEach((v) => o.push(v), 0); return o`)).toEqual([
      "1",
    ])
  })
})

describe("still-rejected callables get the wrap hint", () => {
  test("tool references as callbacks suggest an arrow wrapper", async () => {
    const diagnostic = await toolError(`return [1, 2].map(tools.host.echo)`)
    expect(diagnostic.message).toContain("wrap it in an arrow function")
    expect(await withTool(`return await Promise.all([1, 2].map((id) => tools.host.echo({ id })))`)).toMatchObject({
      ok: true,
      value: [1, 2],
    })
  })

  test("detached Promise statics as callbacks suggest an arrow wrapper", async () => {
    expect((await error(`return [1].map(Promise.resolve)`)).message).toContain("wrap it in an arrow function")
  })

  test("string replacers reject opaque callables with the wrap hint, not a type error", async () => {
    const diagnostic = await toolError(`return "abc".replace(/b/, tools.host.echo)`)
    expect(diagnostic.message).toContain("wrap it in an arrow function")
    expect(diagnostic.message).not.toContain("argument 2")
  })

  test("built-in references work as replacers", async () => {
    // Like real JS: JSON.stringify(match, offset, string) quotes the match.
    expect(await value(`return "abc".replace(/b/, JSON.stringify)`)).toBe('a"b"c')
    // Math methods stay strict about consumed arguments: a match string is not coerced.
    expect((await error(`return "3.7".replace(/\\d\\.\\d/, Math.floor)`)).message).toContain(
      "Math.floor expects number arguments",
    )
  })

  test("non-callables still get the plain callback error", async () => {
    expect((await error(`return [1].map(42)`)).message).toContain("Array.map expects a function callback")
  })

  test("promise handlers reject opaque callables with the wrap hint", async () => {
    const diagnostic = await toolError(`return await Promise.resolve(1).then(tools.host.echo)`)
    expect(diagnostic.message).toContain("Promise.prototype.then cannot use this callable as a handler")
    expect(diagnostic.message).toContain("wrap it in an arrow function")
  })

  test("JSON callbacks use the unified callback gate", async () => {
    expect(
      await value(`return JSON.stringify({ a: -1 }, (key, item) => typeof item === "number" ? Math.abs(item) : item)`),
    ).toBe('{"a":1}')
    expect((await toolError(`return JSON.stringify({ a: 1 }, tools.host.echo)`)).message).toContain(
      "wrap it in an arrow function",
    )
    expect((await toolError(`return JSON.parse('{"a":1}', tools.host.echo)`)).message).toContain(
      "wrap it in an arrow function",
    )
  })

  test("non-callable JSON callback arguments are ignored", async () => {
    expect(await value(`return JSON.parse('{"a":1}', undefined)`)).toEqual({ a: 1 })
    expect(await value(`return JSON.parse('{"a":1}', 42)`)).toEqual({ a: 1 })
    expect(await value(`return JSON.stringify({ a: 1 }, 42)`)).toBe('{"a":1}')
  })
})
