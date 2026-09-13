import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { CodeMode } from "../src/index.js"
import { Data } from "../src/data.js"

// Runs a CodeMode program with no host tools and returns the CodeMode.Result. These tests pin the
// JS-parity behaviors for the "99% of ordinary defensive JavaScript just works" goal: cases where
// a strict interpreter would throw but idiomatic JS yields undefined / succeeds.
//
// Note on the result boundary: this package normalizes a bare `undefined` result to `null` when
// it crosses out of CodeMode (results are JSON data), so tests asserting an in-CodeMode
// `undefined` read check `=== undefined` inside the program and `null` at the boundary.
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

describe("H2: string property access reads as undefined (not a throw)", () => {
  test("unknown property on a string is undefined", async () => {
    expect(await value(`const s = "hi"; return s.login === undefined`)).toBe(true)
    expect(await value(`const s = "hi"; return s.login`)).toBeNull()
  })

  test("optional chaining + fallback on a string does not throw", async () => {
    expect(await value(`const s = "hi"; return s?.login ?? "fallback"`)).toBe("fallback")
  })

  test("the real MCP pattern: result is a JSON string, defensive read falls through", async () => {
    // me.result is a string; me.result?.login is undefined, so we fall back to the raw string.
    expect(await value(`const me = { result: '{"login":"x"}' }; return me.result?.login ?? me.result`)).toBe(
      '{"login":"x"}',
    )
  })

  test("unknown property on a number is undefined", async () => {
    expect(await value(`return (5).foo ?? "n"`)).toBe("n")
  })

  test("only canonical string index keys access characters", async () => {
    expect(
      await value(`
        const text = "abc"
        return [text[1], text["1"], text["01"], text["1.0"], text[-0], text["-0"]]
      `),
    ).toEqual(["b", "b", null, null, "a", null])
  })
})

describe("H3: array property access reads as undefined (not a throw)", () => {
  test("unknown property on an array is undefined", async () => {
    expect(await value(`return [1,2,3].foo === undefined`)).toBe(true)
    expect(await value(`return [1,2,3].foo`)).toBeNull()
  })

  test("optional chaining on an array does not throw", async () => {
    expect(await value(`return [1,2,3]?.foo ?? "fb"`)).toBe("fb")
  })

  test("unknown property reads stay undefined for methods CodeMode does not implement", async () => {
    expect(await value(`return [1,2,3].unknownMethod === undefined`)).toBe(true)
  })

  test("array indexing still works", async () => {
    expect(await value(`return [1,2,3][9] === undefined`)).toBe(true)
    expect(await value(`return [1,2,3][9]`)).toBeNull()
  })

  test("only canonical array index keys access elements", async () => {
    expect(
      await value(`
        const values = ["a", "b"]
        return [values[1], values["1"], values["01"], values["1.0"], values[-0], values["-0"]]
      `),
    ).toEqual(["b", "b", null, null, "a", null])
  })

  test("noncanonical keys are ordinary properties that never alias an element", async () => {
    expect(
      await value(`
        const values = ["a", "b"]
        values["01"] = "c"
        const before = [values["01"], values[1], values.length]
        const removed = delete values["01"]
        return [before, removed, values["01"], values]
      `),
    ).toEqual([["c", "b", 2], true, null, ["a", "b"]])
  })

  test("the maximum array length is a property, not an index", async () => {
    expect(
      await value(`
        const values = []
        values["4294967295"] = 1
        return [values["4294967295"], values.length]
      `),
    ).toEqual([1, 0])
  })
})

describe("H6: object spread of null/undefined is a no-op", () => {
  test("spreading null is a no-op", async () => {
    expect(await value(`const o = null; return { ...o, a: 1 }`)).toEqual({ a: 1 })
  })

  test("spreading an absent argument merges cleanly", async () => {
    expect(await value(`function f(opts){ return { ...opts, a: 1 } } return f(undefined)`)).toEqual({ a: 1 })
  })

  test("spreading a real object still works", async () => {
    expect(await value(`const o = { a: 1 }; return { ...o, b: 2 }`)).toEqual({ a: 1, b: 2 })
  })

  test("spreading an array or string into an object copies index keys, like JS", async () => {
    expect(await value(`return { ...[1,2], a: 1 }`)).toEqual({ 0: 1, 1: 2, a: 1 })
    expect(await value(`return { ..."ab", ...5, ...true, ...(() => 1), ...new Map([[1, 2]]) }`)).toEqual({
      0: "a",
      1: "b",
    })
  })
})

describe("H4: typeof on an undeclared identifier is 'undefined'", () => {
  test("feature-detection guard does not throw", async () => {
    expect(await value(`return typeof foo === "undefined" ? "safe" : "no"`)).toBe("safe")
  })

  test("typeof of a declared binding is unaffected", async () => {
    expect(await value(`const x = 5; return typeof x`)).toBe("number")
    expect(await value(`const s = "a"; return typeof s`)).toBe("string")
  })

  test("referencing an undeclared identifier outside typeof still throws", async () => {
    const err = await error(`return foo + 1`)
    expect(err.message).toContain("foo")
  })
})

describe("CodeMode lexical scope integration", () => {
  test("keeps self, cross, and destructuring defaults in the TDZ", async () => {
    expect(
      await value(`
        const outer = 1
        const errors = []
        try { const first = second, second = 2 } catch (error) { errors.push(error.name) }
        try { const [first = second, second = 2] = [] } catch (error) { errors.push(error.name) }
        return errors
      `),
    ).toEqual(["ReferenceError", "ReferenceError"])
  })

  test("keeps typeof and constant assignment inside the TDZ", async () => {
    expect(
      await value(`
        const errors = []
        try { { errors.push(typeof item); let item } } catch (error) { errors.push(error.name) }
        try { { constant = 1; const constant = 2 } } catch (error) { errors.push(error.name) }
        return errors
      `),
    ).toEqual(["ReferenceError", "ReferenceError"])
  })

  test("shadows builtins from the start of the program scope", async () => {
    expect(
      await value(`
        let observed
        try { observed = typeof Promise } catch (error) { observed = error.name }
        const Promise = 1
        return observed
      `),
    ).toBe("ReferenceError")
  })

  test("keeps classic for initializers inside the header TDZ", async () => {
    expect(
      await value(`
        let index = 1
        try { for (let index = index; index < 2; index++) {} } catch (error) { return error.name }
      `),
    ).toBe("ReferenceError")
  })

  test("removes loop scopes when per-iteration initialization fails", async () => {
    expect(
      await value(`
        const value = "outer"
        try { for (let [value] of [1]) {} } catch {}
        return value
      `),
    ).toBe("outer")
  })
})

describe("unary void", () => {
  test("evaluates its operand and returns undefined", async () => {
    expect(
      await value(`let count = 0; const result = void (count += 1); return [count, result === undefined]`),
    ).toEqual([1, true])
  })

  test("discards opaque values", async () => {
    expect(await value(`return void tools === undefined`)).toBe(true)
  })
})

describe("property deletion", () => {
  test("deletes plain object fields and reports missing fields as successful", async () => {
    expect(
      await value(`
        const object = { keep: 1, remove: 2 }
        return [delete object.remove, delete object.missing, object]
      `),
    ).toEqual([true, true, { keep: 1 }])
  })

  test("evaluates computed object and key expressions once", async () => {
    expect(
      await value(`
        const object = { remove: true }
        let objectReads = 0
        let keyReads = 0
        function getObject() { objectReads++; return object }
        function getKey() { keyReads++; return "remove" }
        const removed = delete getObject()[getKey()]
        return [removed, objectReads, keyReads, Object.hasOwn(object, "remove")]
      `),
    ).toEqual([true, 1, 1, false])
  })

  test("deleting an array index creates a hole without changing its length", async () => {
    expect(
      await value(
        `const values = [1, 2, 3]; const removed = delete values[1]; return [removed, values.length, 1 in values, values]`,
      ),
    ).toEqual([true, 3, false, [1, null, 3]])
  })

  test("array length is not configurable", async () => {
    expect((await error(`const values = [1, 2]; delete values.length`)).message).toContain(
      "Cannot delete property 'length'",
    )
  })

  test("arrays accept named properties like JS, and they stay out of the JSON form", async () => {
    expect(
      await value(`
        const values = [1]
        values.field = 2
        return [values.field, Object.keys(values), values]
      `),
    ).toEqual([2, ["0", "field"], [1]])
  })

  test("optional deletion short-circuits without evaluating the key", async () => {
    expect(
      await value(`let keyReads = 0; const object = null; return [delete object?.[keyReads++], keyReads]`),
    ).toEqual([true, 0])
  })

  test("rejects deletion from opaque runtime references", async () => {
    expect((await error(`return delete tools.example`)).kind).toBe("InvalidDataValue")
  })

  test("prototype-named keys delete like any own data key", async () => {
    expect(
      await value(`const object = { __proto__: 1, a: 2 }; delete object.__proto__; return Object.keys(object)`),
    ).toEqual(["a"])
    expect(await value(`const values = [1]; delete values["constructor"]; return values`)).toEqual([1])
  })
})

describe("H1: NaN/Infinity flow as intermediates and normalize to null at the boundary", () => {
  test("guards run instead of the program crashing on a transient NaN", async () => {
    expect(await value(`return parseInt("abc") || 0`)).toBe(0)
    expect(await value(`const x = Number("abc"); return Number.isNaN(x) ? 0 : x`)).toBe(0)
    expect(await value(`const o = {}; o.count = (o.count || 0) + 1; return o.count`)).toBe(1)
    // average of an empty list, guarded - the classic divide-by-zero that used to throw pre-guard
    expect(await value(`const a = []; return a.length ? a.reduce((s,x)=>s+x,0)/a.length : 0`)).toBe(0)
  })

  test("a non-finite value becomes null when it leaves CodeMode", async () => {
    expect(await value(`return 5/0`)).toBeNull()
    expect(await value(`return 0/0`)).toBeNull()
    expect(await value(`return Math.max()`)).toBeNull()
    // nested, too - normalization walks the returned structure
    expect(await value(`return { a: Number("x"), b: 2, c: [1/0] }`)).toEqual({ a: null, b: 2, c: [null] })
  })

  test("NaN and Infinity are usable identifiers and inspectable in-CodeMode", async () => {
    expect(await value(`return Number.isNaN(NaN)`)).toBe(true)
    expect(await value(`return Infinity > 1e9`)).toBe(true)
    expect(await value(`return Number.isFinite(1/0)`)).toBe(false)
    expect(await value(`return [3,1,2].reduce((a,b)=>Math.max(a,b), -Infinity)`)).toBe(3)
    // JSON.stringify inside CodeMode matches JS: non-finite serializes to null
    expect(await value(`return JSON.stringify({ x: Number("z") })`)).toBe('{"x":null}')
  })

  test("copyOut normalizes non-finite numbers to null (the shared return + tool-arg boundary)", () => {
    // Tool-call arguments funnel through copyOut too, so this one function pins both boundaries.
    expect(Data.toData(NaN, "value")).toBeNull()
    expect(Data.toData(Infinity, "value")).toBeNull()
    expect(Data.toData(-Infinity, "value", "result")).toBeNull()
    expect(Data.toData(42, "value")).toBe(42)
    expect(Data.toData({ a: NaN, b: [Infinity, 1] }, "value")).toEqual({ a: null, b: [null, 1] })
  })
})

describe("copyOut undefined handling per boundary mode", () => {
  test("json mode mirrors JSON.stringify for undefined", () => {
    expect(Data.toData({ q: undefined, keep: 1 }, "value")).toStrictEqual({ keep: 1 })
    expect(Data.toData([1, undefined, 2], "value")).toStrictEqual([1, null, 2])
    expect(Data.toData({ nested: { a: undefined, b: [undefined] } }, "value")).toStrictEqual({
      nested: { b: [null] },
    })
    expect(Data.toData(undefined, "value")).toBeUndefined()
    expect(Data.toData({ a: undefined }, "value", "result")).toStrictEqual({ a: null })
  })
})

describe("Error values and instanceof", () => {
  test("new Error carries name/message and is instanceof Error", async () => {
    expect(await value(`const e = new Error("boom"); return [e instanceof Error, e.name, e.message]`)).toEqual([
      true,
      "Error",
      "boom",
    ])
  })

  test("Error without new behaves like new Error", async () => {
    expect(await value(`const e = Error("plain"); return [e instanceof Error, e.name, e.message]`)).toEqual([
      true,
      "Error",
      "plain",
    ])
    expect(await value(`const e = new Error(); return [e.name, e.message, e instanceof Error]`)).toEqual([
      "Error",
      "",
      true,
    ])
  })

  test("specific error types are instanceof themselves and Error, not each other", async () => {
    expect(
      await value(
        `const e = new TypeError("t"); return [e instanceof TypeError, e instanceof Error, e instanceof RangeError]`,
      ),
    ).toEqual([true, true, false])
    expect(await value(`return new Error("e") instanceof TypeError`)).toBe(false)
  })

  test("thrown errors keep instanceof through try/catch", async () => {
    expect(await value(`try { throw new Error("x") } catch (e) { return [e instanceof Error, e.message] }`)).toEqual([
      true,
      "x",
    ])
  })

  test("interpreter runtime failures are caught as Error values", async () => {
    expect(await value(`try { JSON.parse("nope") } catch (e) { return e instanceof Error }`)).toBe(true)
    expect(await value(`try { undeclared() } catch (e) { return e instanceof Error }`)).toBe(true)
  })

  test("caught failures carry the constructor name the real-JS failure would have", async () => {
    // JSON.parse throws SyntaxError: name and specific-instanceof both carry through, and the
    // message keeps the engine's position detail.
    expect(
      await value(`
      try { JSON.parse("{oops") } catch (e) {
        return [e.name, e instanceof SyntaxError, e instanceof Error, e instanceof TypeError, e.message.includes("JSON")]
      }
    `),
    ).toEqual(["SyntaxError", true, true, false, true])
    expect(await value(`try { undeclared() } catch (e) { return [e.name, e instanceof ReferenceError] }`)).toEqual([
      "ReferenceError",
      true,
    ])
    expect(await value(`try { const c = 1; c = 2 } catch (e) { return [e.name, e instanceof TypeError] }`)).toEqual([
      "TypeError",
      true,
    ])
    expect(await value(`try { "a".match("(") } catch (e) { return [e.name, e instanceof SyntaxError] }`)).toEqual([
      "SyntaxError",
      true,
    ])
    expect(await value(`try { new RegExp("(") } catch (e) { return [e.name, e instanceof SyntaxError] }`)).toEqual([
      "SyntaxError",
      true,
    ])
  })

  test("interpreter failures are TypeErrors; unsupported syntax is a SyntaxError", async () => {
    expect(await value(`try { null.x } catch (e) { return [e.name, e instanceof TypeError] }`)).toEqual([
      "TypeError",
      true,
    ])
    expect(await value(`try { tools + 1 } catch (e) { return e.name }`)).toBe("TypeError")
    expect(await value(`try { class A {} } catch (e) { return [e.name, e instanceof SyntaxError] }`)).toEqual([
      "SyntaxError",
      true,
    ])
  })

  test("errors inherit constructor and instanceof through a real prototype chain", async () => {
    expect(
      await value(`
        const { constructor } = new RangeError("r")
        let caught
        try { const { a } = null } catch (e) { caught = e }
        return [
          constructor === RangeError,
          new RangeError("r") instanceof Error,
          new RangeError("r") instanceof TypeError,
          caught.constructor === TypeError,
          ({ ...caught }).constructor === Object,
          "constructor" in caught,
          Object.keys(new RangeError("r")),
        ]
      `),
    ).toEqual([true, true, false, true, true, true, []])
  })

  test("Promise.allSettled rejection reasons are Error values", async () => {
    expect(
      await value(`
      const settled = await Promise.allSettled([Promise.reject(new Error("b"))])
      return [settled[0].reason instanceof Error, settled[0].reason.message]
    `),
    ).toEqual([true, "b"])
  })

  test("non-error thrown values are not instanceof Error", async () => {
    expect(await value(`try { throw "raw" } catch (e) { return e instanceof Error }`)).toBe(false)
    expect(await value(`try { throw { message: "shaped" } } catch (e) { return e instanceof Error }`)).toBe(false)
  })

  test("plain data is never instanceof Error", async () => {
    expect(await value(`return [({}) instanceof Error, "s" instanceof Error, null instanceof Error]`)).toEqual([
      false,
      false,
      false,
    ])
  })

  test("errors serialize as { name, message } by brand; neither is enumerable", async () => {
    expect(await value(`return new Error("m")`)).toEqual({ name: "Error", message: "m" })
    expect(await value(`return JSON.stringify(new Error("m"))`)).toBe('{"name":"Error","message":"m"}')
    expect(
      await value(`try { throw new Error("m") } catch (e) { return [Object.keys(e), e.name, e.hasOwnProperty("message")] }`),
    ).toEqual([[], "Error", true])
    expect(await value(`return new Error().hasOwnProperty("message")`)).toBe(false)
  })

  test("spreading an error loses the brand, like losing the prototype in JS", async () => {
    expect(await value(`const e = new Error("m"); return ({ ...e }) instanceof Error`)).toBe(false)
    expect(await value(`const e = new Error("m"); return { ...e }`)).toEqual({})
  })

  test("typeof Error is function; an unknown instanceof right-hand side is a catchable error", async () => {
    expect(await value(`return typeof Error`)).toBe("function")
    expect(await value(`try { return 1 instanceof 5 } catch (e) { return "caught" }`)).toBe("caught")
    const err = await error(`return 1 instanceof 5`)
    expect(err.message).toContain("right-hand side of 'instanceof'")
  })
})

describe("CodeMode-specific array behavior", () => {
  test("sort with a comparator mutates and returns the receiver", async () => {
    expect(
      await value(`
        const input = [3, 1, 2]
        const result = input.sort((a, b) => a - b)
        return { input, same: input === result }
      `),
    ).toEqual({ input: [1, 2, 3], same: true })
  })

  test("splice can replace and insert elements", async () => {
    expect(await value(`const a = ["a","d"]; a.splice(1, 0, "b", "c"); return a`)).toEqual(["a", "b", "c", "d"])
    expect(await value(`const a = [1,2,3]; const removed = a.splice(1, 1, "x"); return { removed, a }`)).toEqual({
      removed: [2],
      a: [1, "x", 3],
    })
  })

  test("splice rejects inserting a container into itself", async () => {
    const err = await error(`const a = [1]; a.splice(0, 0, [a]); return a`)
    expect(err.kind).toBe("InvalidDataValue")
    expect(err.message).toContain("circular")
  })

  test("keys/values/entries return arrays usable with for...of and spread", async () => {
    expect(await value(`return [...["x","y","z"].keys()]`)).toEqual([0, 1, 2])
    expect(await value(`return ["x","y"].values()`)).toEqual(["x", "y"])
    expect(
      await value(`
      const out = []
      for (const [index, item] of ["a","b"].entries()) out.push(index + ":" + item)
      return out
    `),
    ).toEqual(["0:a", "1:b"])
    expect(await value(`return [...[7].entries()]`)).toEqual([[0, 7]])
  })
})

describe("CodeMode-specific string behavior", () => {
  test("localeCompare orders strings for sorting", async () => {
    expect(await value(`return ["b","a","c"].sort((x, y) => x.localeCompare(y))`)).toEqual(["a", "b", "c"])
  })

  test("an invalid normalize form is a clear catchable error", async () => {
    expect(await value(`try { "x".normalize("nope"); return "no" } catch (e) { return e.message }`)).toContain('"NFC"')
  })

  test("exposes the Annex B string aliases every engine ships", async () => {
    expect(await value(`return [" x ".trimLeft(), " x ".trimRight(), "abc".substr(1, 1)]`)).toEqual(["x ", " x", "b"])
  })
})

describe("compound assignment matches its binary operator", () => {
  // `x op= y` must behave exactly like `x = x op y`, sharing the binary operator's coercion
  // semantics (Dates string-coerce for `+` and use their time value for arithmetic; data
  // objects/arrays coerce to their JS string form).
  const pair = async (compound: string, expanded: string) => {
    const [a, b] = await Promise.all([value(compound), value(expanded)])
    expect(a).toEqual(b)
    return a
  }

  test("CodeMode Date += concatenates its string form, like d = d + 1", async () => {
    const result = await pair(`let d = new Date(1000); d += 1; return d`, `let d = new Date(1000); d = d + 1; return d`)
    expect(result).toBe("1970-01-01T00:00:01.000Z1")
  })

  test("CodeMode Date numeric compound ops use its time value", async () => {
    expect(
      await pair(`let d = new Date(1000); d -= 400; return d`, `let d = new Date(1000); d = d - 400; return d`),
    ).toBe(600)
    expect(await pair(`let d = new Date(1000); d /= 4; return d`, `let d = new Date(1000); d = d / 4; return d`)).toBe(
      250,
    )
  })

  test("string += object/array matches x = x + obj", async () => {
    expect(await pair(`let x = "a"; x += { b: 1 }; return x`, `let x = "a"; x = x + { b: 1 }; return x`)).toBe(
      "a[object Object]",
    )
    expect(await pair(`let x = "a"; x += [1, 2]; return x`, `let x = "a"; x = x + [1, 2]; return x`)).toBe("a1,2")
  })

  test("compound assignment through a member target coerces the same way", async () => {
    expect(
      await pair(
        `const o = { s: "t" }; o.s += new Date(0); return o.s`,
        `const o = { s: "t" }; o.s = o.s + new Date(0); return o.s`,
      ),
    ).toBe("t1970-01-01T00:00:00.000Z")
  })

  test("numeric and string compound operators sweep identically to their expansions", async () => {
    const cases: Array<[string, number | string]> = [
      [`let x = 7; x += 3; return x`, 7 + 3],
      [`let x = 7; x -= 3; return x`, 7 - 3],
      [`let x = 7; x *= 3; return x`, 7 * 3],
      [`let x = 7; x /= 2; return x`, 7 / 2],
      [`let x = 7; x %= 3; return x`, 7 % 3],
      [`let x = 7; x **= 2; return x`, 7 ** 2],
      [`let x = 7; x &= 3; return x`, 7 & 3],
      [`let x = 7; x |= 8; return x`, 7 | 8],
      [`let x = 7; x ^= 2; return x`, 7 ^ 2],
      [`let x = 7; x <<= 2; return x`, 7 << 2],
      [`let x = -7; x >>= 1; return x`, -7 >> 1],
      [`let x = -7; x >>>= 1; return x`, -7 >>> 1],
      [`let x = "a"; x += "b"; return x`, "ab"],
    ]
    for (const [compound, expected] of cases) {
      expect(await value(compound)).toBe(expected)
      expect(await value(compound.replace(/x (\S+)= /, (_, op) => `x = x ${op} `))).toBe(expected)
    }
  })
})

describe("H5: builtin coercion functions work as array callbacks", () => {
  test("filter(Boolean) drops falsy values", async () => {
    expect(await value(`return [0, 1, "", 2, null, 3].filter(Boolean)`)).toEqual([1, 2, 3])
  })

  test("map(String) coerces each element", async () => {
    expect(await value(`return [1, 2, 3].map(String)`)).toEqual(["1", "2", "3"])
  })

  test("a non-callable callback is still rejected", async () => {
    const err = await error(`return [1,2,3].map(42)`)
    expect(err.message).toContain("callback")
  })
})

describe("for...of assignment destructuring", () => {
  test("assigns entry pairs into predeclared variables", async () => {
    expect(
      await value(`
      let key
      let item
      const out = []
      for ([key, item] of Object.entries({ a: 1, b: 2 })) out.push(key + item)
      return { key, item, out }
    `),
    ).toEqual({ key: "b", item: 2, out: ["a1", "b2"] })
  })

  test("assigns object patterns and defaults", async () => {
    expect(
      await value(`
      let id
      let label
      const labels = []
      for ({ id, label = "unknown" } of [{ id: 1 }, { id: 2, label: "two" }]) labels.push(label)
      return { id, label, labels }
    `),
    ).toEqual({ id: 2, label: "two", labels: ["unknown", "two"] })
  })
})

describe("sequence expressions", () => {
  test("evaluate left to right and return the final value", async () => {
    expect(await value(`let x = 0; const result = (x += 1, x *= 3, x + 2); return { x, result }`)).toEqual({
      x: 3,
      result: 5,
    })
  })

  test("support comma-separated for-loop updates", async () => {
    expect(
      await value(`
      const pairs = []
      for (let left = 0, right = 3; left < right; left++, right--) pairs.push([left, right])
      return pairs
    `),
    ).toEqual([
      [0, 3],
      [1, 2],
    ])
  })
})

describe("destructuring assignment", () => {
  test("assigns object and array patterns to existing bindings", async () => {
    expect(
      await value(`
        let a = 0
        let b = 0
        ;({ a } = { a: 2 })
        ;[a, b] = [3, 4]
        return [a, b]
      `),
    ).toEqual([3, 4])
  })

  test("supports defaults, nesting, rest, and member targets", async () => {
    expect(
      await value(`
        let first = 0
        let fallback = 0
        let rest = {}
        const target = {}
        ;[first, fallback = 2, ...target.tail] = [1]
        ;({ nested: { value: target.value }, kept: target.kept = 3, ...rest } = {
          nested: { value: 4 },
          extra: 5,
        })
        return { first, fallback, target, rest }
      `),
    ).toEqual({ first: 1, fallback: 2, target: { tail: [], value: 4, kept: 3 }, rest: { extra: 5 } })
  })

  test("returns the assigned value", async () => {
    expect(await value(`let a = 0; const result = ([a] = [7]); return [a, result]`)).toEqual([7, [7]])
  })

  test("supports computed object keys and evaluates them once", async () => {
    expect(
      await value(`
        let calls = 0
        const field = () => { calls++; return "name" }
        const { [field()]: name, ...rest } = { name: "Ada", role: "engineer" }
        return { calls, name, rest }
      `),
    ).toEqual({ calls: 1, name: "Ada", rest: { role: "engineer" } })
  })

  test("supports object patterns over arrays; detached methods lose their receiver like JS", async () => {
    expect(
      await value(`
        const { 0: first, length, slice, ...rest } = ["a", "b", "c"]
        return { first, length, sliced: slice === Array.prototype.slice, rest }
      `),
    ).toEqual({ first: "a", length: 3, sliced: true, rest: { 1: "b", 2: "c" } })
    expect((await error(`const { slice } = [1]; slice(0)`)).message).toContain("Array.prototype.slice called on")
  })

  test("preserves exact computed property names on arrays", async () => {
    expect(
      await value(`
        const { ["01"]: item, ...rest } = [10, 20]
        return { missing: item === undefined, rest }
      `),
    ).toEqual({ missing: true, rest: { 0: 10, 1: 20 } })
  })

  test("supports array patterns over strings, Maps, Sets, and URLSearchParams", async () => {
    expect(
      await value(`
        const [letter, ...letters] = "A😀B"
        const [[mapKey, mapValue]] = new Map([["key", 1]])
        const [setFirst, setSecond] = new Set([2, 3])
        const [[queryKey, queryValue]] = new URLSearchParams("q=test&page=2")
        return { letter, letters, mapKey, mapValue, setFirst, setSecond, queryKey, queryValue }
      `),
    ).toEqual({
      letter: "A",
      letters: ["😀", "B"],
      mapKey: "key",
      mapValue: 1,
      setFirst: 2,
      setSecond: 3,
      queryKey: "q",
      queryValue: "test",
    })
  })

  test("supports iterable patterns in assignment and parameters", async () => {
    expect(
      await value(`
        let first
        let rest
        ;[first, ...rest] = new Set([1, 2, 3])
        const read = ([[key, value]]) => key + value
        return { first, rest, entry: read(new Map([["a", 4]])) }
      `),
    ).toEqual({ first: 1, rest: [2, 3], entry: "a4" })
  })

  test("excludes computed numeric keys from object rest", async () => {
    expect(
      await value(`
        const { [0]: declared, ...declarationRest } = { 0: "a", 1: "b" }
        let assigned
        let assignmentRest
        ;({ [0]: assigned, ...assignmentRest } = { 0: "c", 1: "d" })
        return { declared, declarationRest, assigned, assignmentRest }
      `),
    ).toEqual({ declared: "a", declarationRest: { 1: "b" }, assigned: "c", assignmentRest: { 1: "d" } })
  })

  test("rejects computed keys that are not confined property keys", async () => {
    const err = await error(`const key = {}; const { [key]: value } = {}`)
    expect(err.message).toContain("Property key must be a string or number")
  })
})

describe("coercion parity: zero-argument coercion functions", () => {
  test("Number() is 0 and String() is empty, unlike their undefined-argument forms", async () => {
    expect(await value(`return Number()`)).toBe(0)
    expect(await value(`return String()`)).toBe("")
    expect(await value(`return Boolean()`)).toBe(false)
    expect(await value(`return Number.isNaN(Number(undefined))`)).toBe(true)
    expect(await value(`return String(undefined)`)).toBe("undefined")
  })

  test("parseInt() and parseFloat() stay NaN with no argument", async () => {
    expect(await value(`return Number.isNaN(parseInt())`)).toBe(true)
    expect(await value(`return Number.isNaN(parseFloat())`)).toBe(true)
  })
})

describe("coercion parity: global isFinite and isNaN", () => {
  test("coerce their argument like native JS, unlike the Number statics", async () => {
    expect(await value(`return isFinite("42")`)).toBe(true)
    expect(await value(`return Number.isFinite("42")`)).toBe(false)
    expect(await value(`return isNaN("oops")`)).toBe(true)
    expect(await value(`return isNaN("42")`)).toBe(false)
    expect(await value(`return isFinite(Infinity)`)).toBe(false)
    expect(await value(`return isNaN(null)`)).toBe(false)
  })

  test("zero-argument forms match native", async () => {
    expect(await value(`return isFinite()`)).toBe(false)
    expect(await value(`return isNaN()`)).toBe(true)
  })

  test("read as functions", async () => {
    expect(await value(`return typeof isFinite`)).toBe("function")
    expect(await value(`return typeof isNaN`)).toBe("function")
  })

  test("work as array callbacks", async () => {
    expect(await value(`return [1, "2", "x", Infinity].filter(isFinite)`)).toEqual([1, "2"])
    expect(await value(`return ["1", "x"].map(isNaN)`)).toEqual([false, true])
  })
})

describe("coercion parity: arrays coerce to numbers through their string form", () => {
  test("arrays with objects become NaN instead of crashing on host ToPrimitive", async () => {
    expect(await value(`let x = [{}]; x++; return Number.isNaN(x)`)).toBe(true)
    expect(await value(`return isFinite([{}])`)).toBe(false)
    expect(await value(`return "abc".slice([{}])`)).toBe("abc")
  })

  test("single-element and empty arrays match native Number()", async () => {
    expect(await value(`return Number([5])`)).toBe(5)
    expect(await value(`return Number([])`)).toBe(0)
    expect(await value(`return Number.isNaN(Number([1, 2]))`)).toBe(true)
  })
})

describe("coercion parity: String method arguments coerce like native JS", () => {
  test("includes and indexOf coerce numbers", async () => {
    expect(await value(`return "v1.2".includes(1)`)).toBe(true)
    expect(await value(`return "a2b".indexOf(2)`)).toBe(1)
    expect(await value(`return "abc".includes("d")`)).toBe(false)
  })

  test("slice, repeat, and padStart coerce numeric strings", async () => {
    expect(await value(`return "abc".slice("1")`)).toBe("bc")
    expect(await value(`return "ab".repeat("2")`)).toBe("abab")
    expect(await value(`return "7".padStart("3", 0)`)).toBe("007")
  })

  test("split coerces separators but treats undefined as absent", async () => {
    expect(await value(`return "a1b".split(1)`)).toEqual(["a", "b"])
    expect(await value(`return "a,b".split(undefined)`)).toEqual(["a,b"])
    expect(await value(`return "a,b".split()`)).toEqual(["a,b"])
    expect(await value(`return "a,b".split(undefined, 0)`)).toEqual([])
    expect(await value(`return "a,b".split(undefined, 1)`)).toEqual(["a,b"])
  })

  test("replace coerces search and replacement values", async () => {
    expect(await value(`return "a1b".replace(1, 2)`)).toBe("a2b")
    expect(await value(`return "a1b".replace(1, () => "x")`)).toBe("axb")
  })

  test("repeat rejections carry the native RangeError name", async () => {
    expect(await value(`try { "a".repeat(-1) } catch (e) { return e.name }`)).toBe("RangeError")
  })

  test("includes, startsWith, and endsWith reject regular expressions with a TypeError", async () => {
    expect(await value(`try { "abc".includes(/a/) } catch (e) { return e.name }`)).toBe("TypeError")
    expect(await value(`try { "abc".startsWith(/a/) } catch (e) { return e.name }`)).toBe("TypeError")
    expect(await value(`try { "abc".endsWith(/a/) } catch (e) { return e.name }`)).toBe("TypeError")
  })

  test("opaque runtime references still reject as data errors", async () => {
    const err = await error(`const f = () => 1; return "abc".includes(f)`)
    expect(err.message).toContain("data value")
    const replacerErr = await error(`const f = () => 1; return "a".replace(f, () => "x")`)
    expect(replacerErr.message).toContain("data value")
  })
})

describe("coercion parity: match() and search() with no argument", () => {
  test("behave as an empty pattern like native JS", async () => {
    expect(await value(`return "abc".search()`)).toBe(0)
    expect(await value(`const m = "abc".match(); return { first: m[0], index: m.index }`)).toEqual({
      first: "",
      index: 0,
    })
  })
})

describe("coercion parity: ++ and -- use CodeMode numeric coercion", () => {
  test("numeric strings increment like native JS", async () => {
    expect(await value(`let x = "5"; x++; return x`)).toBe(6)
    expect(await value(`let x = "5"; return ++x`)).toBe(6)
    expect(await value(`const o = { n: "2" }; o.n--; return o.n`)).toBe(1)
  })

  test("dates increment through their epoch time", async () => {
    expect(await value(`let d = new Date(5); d++; return d`)).toBe(6)
  })

  test("plain data objects become NaN instead of crashing", async () => {
    expect(await value(`let x = {}; x++; return Number.isNaN(x)`)).toBe(true)
    expect(await value(`const o = { a: {} }; o.a++; return Number.isNaN(o.a)`)).toBe(true)
  })

  test("opaque runtime references reject with a clear error", async () => {
    const err = await error(`let f = () => 1; f++`)
    expect(err.message).toContain("data value")
  })
})

describe("coercion parity: unknown static members read as undefined", () => {
  test("feature detection on missing statics works like native JS", async () => {
    expect(await value(`return typeof Math.sum`)).toBe("undefined")
    expect(await value(`return RegExp.quote === undefined`)).toBe(true)
    expect(await value(`return Number.range === undefined`)).toBe(true)
    expect(await value(`return String.raw === undefined`)).toBe(true)
    expect(await value(`return isFinite.something === undefined`)).toBe(true)
    expect(await value(`return console.group === undefined`)).toBe(true)
    expect(await value(`return Date.moment === undefined`)).toBe(true)
    expect(await value(`return JSON.rawJSON === undefined`)).toBe(true)
    expect(await value(`return URL.createObjectURL === undefined`)).toBe(true)
    expect(await value(`return Math.sum?.([1]) ?? "fallback"`)).toBe("fallback")
  })

  test("known statics still resolve and run", async () => {
    expect(await value(`return typeof Math.max`)).toBe("function")
    expect(await value(`return typeof console.log`)).toBe("function")
    expect(await value(`return typeof Date.now`)).toBe("function")
    expect(await value(`return typeof Math.sumPrecise`)).toBe("function")
    expect(await value(`return typeof RegExp.escape`)).toBe("function")
    expect(await value(`return typeof Object.groupBy`)).toBe("function")
    expect(await value(`return typeof Map.groupBy`)).toBe("function")
    expect(await value(`return Math.max(1, 2)`)).toBe(2)
    expect(await value(`return Math.sumPrecise([1, 2])`)).toBe(3)
    expect(await value(`return RegExp.escape("a.b")`)).toBe("\\x61\\.b")
    expect(await value(`return URL.canParse("https://example.com")`)).toBe(true)
    expect(await value(`return Number.isInteger(3)`)).toBe(true)
    expect(await value(`return Number.MAX_SAFE_INTEGER`)).toBe(Number.MAX_SAFE_INTEGER)
  })

  test("calling an unknown static reports a native-style TypeError", async () => {
    expect(await value(`try { Math.sum([1]) } catch (e) { return e.name + ": " + e.message }`)).toBe(
      "TypeError: Math.sum is not a function.",
    )
    expect(await value(`try { Math["sum"]([1]) } catch (e) { return e.message }`)).toBe("Math.sum is not a function.")
    expect(await value(`try { JSON.rawJSON("1") } catch (e) { return e.message }`)).toBe(
      "JSON.rawJSON is not a function.",
    )
  })

  test("built-ins are objects on a real prototype chain", async () => {
    expect(
      await value(`
        return [
          Math.constructor === Object,
          Number.constructor === Function,
          Object.prototype.hasOwnProperty === ({}).hasOwnProperty,
          Array.prototype.push.name,
          Array.prototype.push.length,
          Math.max.length,
          Object.keys(Math),
          typeof Array.prototype.map,
          Array.isArray(Array.prototype),
        ]
      `),
    ).toEqual([true, true, true, "push", 1, 2, [], "function", true])
  })
})

describe("functions are objects", () => {
  test("name follows NamedEvaluation and length counts required parameters", async () => {
    expect(
      await value(`
        function decl(a, b = 1, ...rest) {}
        const arrow = () => {}
        const named = function inner() {}
        let assigned
        assigned = (a, b) => {}
        const { fromDefault = () => {} } = {}
        const [fromArray = function () {}] = []
        const obj = { method() {}, key: () => {}, [Symbol.iterator]: () => {} }
        const passthrough = (0, () => {})
        return [
          [decl.name, decl.length],
          [arrow.name, named.name, assigned.name, assigned.length],
          [fromDefault.name, fromArray.name],
          [obj.method.name, obj.key.name, obj[Symbol.iterator].name],
          passthrough.name,
        ]
      `),
    ).toEqual([
      ["decl", 1],
      ["arrow", "inner", "assigned", 2],
      ["fromDefault", "fromArray"],
      ["method", "key", "[Symbol.iterator]"],
      "",
    ])
  })

  test("functions hold own properties; name and length are read-only", async () => {
    expect(
      await value(`
        const fn = () => 1
        fn.count = 2
        fn.count += 1
        let renamed = false
        try { fn.name = "other" } catch (error) { renamed = error instanceof TypeError }
        const { name, count } = fn
        return [fn.count, Object.keys(fn), "count" in fn, "name" in fn, name, count, renamed, delete fn.count, fn.count]
      `),
    ).toEqual([3, ["count"], true, true, "fn", 3, true, true, null])
  })
})
