/*
 * Portions adapted from Test262 at revision 250f204f23a9249ff204be2baec29600faae7b75:
 * - test/built-ins/Date/value-to-primitive-result-non-string-prim.js
 * - test/built-ins/Date/value-to-primitive-result-string.js
 * - test/built-ins/Date/prototype/toUTCString/format.js
 * - test/built-ins/Date/prototype/toUTCString/invalid-date.js
 * - test/built-ins/RegExp/prototype/exec/S15.10.6.2_A4_T8.js
 *
 * CodeMode does not support Symbol.toPrimitive, so the Date-constructor cases exercise the same primitive-result
 * handling through supported own valueOf and toString functions.
 *
 * Copyright (C) 2016 the V8 project authors. All rights reserved.
 * Copyright (C) 2017 the V8 project authors. All rights reserved.
 * Copyright 2009 the Sputnik authors. All rights reserved.
 * Test262 portions are governed by the BSD license in LICENSE.test262.
 */
import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { CodeMode, Tool } from "../src/index.js"

// Standard-library value types: Date, RegExp, Map, Set. Programs use them as ordinary JS;
// intra-CodeMode checkpoints (Object.* helpers, spread, coercion inputs) preserve the live
// values, while at the host boundary (final result, tool arguments, JSON.stringify) they
// serialize exactly as JSON.stringify would: Date -> ISO string (invalid -> null),
// URL -> href, and RegExp/Map/Set/URLSearchParams -> {}.
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

describe("Number and Math", () => {
  test("Math.random returns a number in [0, 1)", async () => {
    expect(await value(`const n = Math.random(); return typeof n === "number" && n >= 0 && n < 1`)).toBe(true)
  })

  test("Number exposes native non-finite constants", async () => {
    expect(
      await value(
        `return [Number.isNaN(Number.NaN), Number.POSITIVE_INFINITY === Infinity, Number.NEGATIVE_INFINITY === -Infinity]`,
      ),
    ).toEqual([true, true, true])
  })

  test("Number valueOf returns its primitive receiver", async () => {
    expect(await value(`return (42).valueOf()`)).toBe(42)
  })

  test("Number valueOf does not enable boxed numbers", async () => {
    const failure = await error(`return new Number(42)`)
    expect(failure.kind).toBe("ExecutionFailure")
    expect(failure.message).toContain("new Number(...) is not supported; call Number(...) without new instead.")
  })
})

describe("Date", () => {
  test("Date.now() returns a number", async () => {
    expect(await value(`return typeof Date.now()`)).toBe("number")
  })

  test("epoch construction and ISO rendering", async () => {
    expect(await value(`return new Date(0).toISOString()`)).toBe("1970-01-01T00:00:00.000Z")
  })

  test("string parsing round-trips", async () => {
    expect(await value(`return new Date("2024-01-02T03:04:05.000Z").getTime()`)).toBe(1704164645000)
    expect(await value(`return Date.parse("2024-01-02T03:04:05.000Z")`)).toBe(1704164645000)
  })

  test("one-argument construction coerces supported values like JavaScript", async () => {
    expect(
      await value(`return [new Date(true).getTime(), new Date(false).getTime(), new Date(null).getTime()]`),
    ).toEqual([1, 0, 0])
    expect(await value(`return Number.isNaN(new Date(undefined).getTime())`)).toBe(true)
    expect(await value(`return Number.isNaN(new Date([]).getTime())`)).toBe(true)
    expect(await value(`return new Date(["1970-01-01T00:00:00.000Z"]).getTime()`)).toBe(0)
    expect(await value(`return Number.isNaN(new Date({}).getTime())`)).toBe(true)
  })

  test("one-argument construction uses valueOf then toString for objects", async () => {
    expect(
      await value(`
        const calls = []
        const number = { valueOf: () => 8 }
        const text = {
          valueOf: () => { calls.push("valueOf"); return {} },
          toString: () => { calls.push("toString"); return "2016-06-05T18:40:00.000Z" },
        }
        return [new Date(number).getTime(), new Date(text).getTime(), calls]
      `),
    ).toEqual([8, 1465152000000, ["valueOf", "toString"]])

    expect(
      await value(`
        const values = [
          { valueOf: () => undefined },
          { valueOf: () => true },
          { valueOf: () => false },
          { valueOf: () => null },
        ]
        return values.map((item) => new Date(item).getTime())
      `),
    ).toEqual([null, 1, 0, 0])

    expect(
      await value(`
        try {
          new Date({ valueOf: () => ({}), toString: () => ({}) })
        } catch (error) {
          return error.name
        }
      `),
    ).toBe("TypeError")
  })

  test("date arithmetic and comparison use the time value", async () => {
    expect(await value(`const a = new Date(1000); const b = new Date(3000); return b - a`)).toBe(2000)
    expect(await value(`const a = new Date(1000); const b = new Date(3000); return a < b`)).toBe(true)
    expect(await value(`return +new Date(42)`)).toBe(42)
  })

  test("UTC getters read calendar components", async () => {
    expect(
      await value(
        `const d = new Date("2024-03-05T06:07:08.009Z"); return [d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds()]`,
      ),
    ).toEqual([2024, 2, 5, 6, 7, 8, 9])
  })

  test("invalid dates yield NaN times, guardable in-CodeMode", async () => {
    expect(await value(`return Number.isNaN(new Date("garbage").getTime())`)).toBe(true)
    expect(await value(`return new Date("garbage").toJSON()`)).toBeNull()
  })

  test("toISOString on an invalid date throws RangeError", async () => {
    expect(await value(`try { new Date("garbage").toISOString() } catch (error) { return error.name }`)).toBe(
      "RangeError",
    )
  })

  test("template interpolation renders the ISO form", async () => {
    expect(await value("return `at ${new Date(0)}`")).toBe("at 1970-01-01T00:00:00.000Z")
  })

  test("dates serialize to ISO strings at the boundary, direct and nested", async () => {
    expect(await value(`return new Date(0)`)).toBe("1970-01-01T00:00:00.000Z")
    expect(await value(`return { when: new Date(0), tags: [new Date(1000)] }`)).toEqual({
      when: "1970-01-01T00:00:00.000Z",
      tags: ["1970-01-01T00:00:01.000Z"],
    })
    expect(await value(`return JSON.stringify({ d: new Date(0) })`)).toBe('{"d":"1970-01-01T00:00:00.000Z"}')
  })

  test("coercions: Number is the time, String is ISO, Boolean is true", async () => {
    expect(await value(`return Number(new Date(5))`)).toBe(5)
    expect(await value(`return String(new Date(0))`)).toBe("1970-01-01T00:00:00.000Z")
    expect(await value(`return Boolean(new Date(0))`)).toBe(true)
  })

  test("sorting dates with a numeric comparator", async () => {
    expect(
      await value(`
      const dates = [new Date(3000), new Date(1000), new Date(2000)]
      return dates.sort((a, b) => a - b).map((d) => d.getTime())
    `),
    ).toEqual([1000, 2000, 3000])
  })

  test("new Date(year, month, day) accepts component form", async () => {
    expect(await value(`const d = new Date(2024, 0, 2); return [d.getFullYear(), d.getMonth(), d.getDate()]`)).toEqual([
      2024, 0, 2,
    ])
  })

  test("typeof and unknown properties are forgiving", async () => {
    expect(await value(`return typeof new Date(0)`)).toBe("object")
    expect(await value(`return new Date(0).nope === undefined`)).toBe(true)
  })

  test("toUTCString and toGMTString use the native UTC format", async () => {
    expect(
      await value(`
        const date = new Date(0)
        return [
          date.toUTCString(),
          date.toGMTString(),
          new Date(NaN).toUTCString(),
          new Date("0020-01-01T00:00:00Z").toUTCString(),
        ]
      `),
    ).toEqual([
      "Thu, 01 Jan 1970 00:00:00 GMT",
      "Thu, 01 Jan 1970 00:00:00 GMT",
      "Invalid Date",
      "Wed, 01 Jan 0020 00:00:00 GMT",
    ])
  })
})

describe("RegExp", () => {
  test("literal test", async () => {
    expect(await value(`return /ab+c/.test("xabbbc")`)).toBe(true)
    expect(await value(`return /ab+c/.test("nope")`)).toBe(false)
  })

  test("exec exposes captures and index", async () => {
    expect(await value(`const m = /a(b+)/.exec("xxabbc"); return { full: m[0], group: m[1], index: m.index }`)).toEqual(
      {
        full: "abb",
        group: "bb",
        index: 2,
      },
    )
    expect(await value(`return /a/.exec("zzz")`)).toBeNull()
  })

  test("named groups read through", async () => {
    expect(
      await value(`const m = /(?<word>[a-z]+)-(?<num>\\d+)/.exec("id ab-42"); return m.groups.word + m.groups.num`),
    ).toBe("ab42")
  })

  test("global exec advances lastIndex across calls", async () => {
    expect(
      await value(`
      const r = /\\d+/g
      const first = r.exec("a1b22c")
      const second = r.exec("a1b22c")
      return [first[0], second[0]]
    `),
    ).toEqual(["1", "22"])
  })

  test("lastIndex is writable and exec coerces its stored value", async () => {
    expect(
      await value(`
        const pattern = /(?:ab|cd)\\d?/g
        pattern.lastIndex = "12"
        const stored = [pattern.lastIndex, typeof pattern.lastIndex]
        const match = pattern.exec("aacd2233ab12nm444ab42")
        pattern.lastIndex = 0
        return [stored, match[0], match.index, pattern.lastIndex]
      `),
    ).toEqual([["12", "string"], "ab4", 17, 0])
    expect((await error(`delete /a/.lastIndex`)).message).toContain("Cannot delete property 'lastIndex'")
  })

  test("exec coerces CodeMode data objects assigned to lastIndex", async () => {
    expect(
      await value(`
        const pattern = /a/g
        pattern.lastIndex = {}
        const stored = pattern.lastIndex
        const match = pattern.exec("ba")
        pattern.lastIndex = 10
        const missed = pattern.exec("a")
        return [stored, match.index, pattern.lastIndex, missed]
      `),
    ).toEqual([{}, 1, 0, null])
  })

  test("non-global exec and test coerce and preserve lastIndex", async () => {
    expect(
      await value(`
        const execPattern = /a/
        const execIndex = {}
        execPattern.lastIndex = execIndex
        const match = execPattern.exec("ba")

        const testPattern = /a/
        const testIndex = {}
        testPattern.lastIndex = testIndex
        const matched = testPattern.test("ba")

        return [match.index, execPattern.lastIndex === execIndex, matched, testPattern.lastIndex === testIndex]
      `),
    ).toEqual([1, true, true, true])
  })

  test("an unmatched string pattern returns null", async () => {
    expect(await value(`return "abc".match(/\\d/)`)).toBeNull()
  })

  test("matchAll materializes match arrays with captures", async () => {
    expect(await value(`return "a1b22".matchAll(/(\\d+)/g).map((m) => m[1])`)).toEqual(["1", "22"])
  })

  test("function replacers receive captures, offsets, input, and named groups", async () => {
    expect(
      await value(`
        const seen = []
        const output = "a1b22".replace(/(\\d)(\\d)?/g, (match, first, second, offset, input) => {
          seen.push([match, first, second === undefined, offset, input])
          return Number(match) * 2
        })
        return { output, seen }
      `),
    ).toEqual({
      output: "a2b44",
      seen: [
        ["1", "1", true, 1, "a1b22"],
        ["22", "2", false, 3, "a1b22"],
      ],
    })
    expect(
      await value(`
        return "red-blue".replace(
          /(?<left>[a-z]+)-(?<right>[a-z]+)/,
          (match, left, right, offset, input, groups) => groups.right + ":" + groups.left,
        )
      `),
    ).toBe("blue:red")
  })

  test("function replacers support string searches, zero-length matches, and result coercion", async () => {
    expect(await value(`return "banana".replace("na", (match, offset, input) => "[" + offset + "]")`)).toBe("ba[2]na")
    expect(await value(`return "ab".replaceAll("", (match, offset) => offset)`)).toBe("0a1b2")
    expect(await value(`return "😀".replaceAll(/(?:)/gu, (match, offset) => "[" + offset + "]")`)).toBe("[0]😀[2]")
    expect(
      await value(`return "123".replace(/\\d/g, (match) => match === "1" ? 7 : match === "2" ? null : { n: 3 })`),
    ).toBe("7null[object Object]")
  })

  test("promise-returning string replacers are coerced synchronously", async () => {
    const decorate = Tool.make({
      description: "Decorate a string",
      input: Schema.String,
      output: Schema.String,
      execute: (input) => Effect.succeed(`[${input}]`),
    })
    const result = await Effect.runPromise(
      CodeMode.execute({
        tools: { host: { decorate } },
        code: `return "a1b22".replace(/\\d+/g, async (match) => await tools.host.decorate(match))`,
      }),
    )
    expect(result.ok && result.value).toBe("a[object Promise]b[object Promise]")

    const missingAwait = await Effect.runPromise(
      CodeMode.execute({
        tools: { host: { decorate } },
        code: `return "a1".replace(/\\d/, (match) => tools.host.decorate(match))`,
      }),
    )
    expect(missingAwait.ok && missingAwait.value).toBe("a[object Promise]")
  })

  test("replaceAll without the g flag is a catchable error", async () => {
    expect(await value(`try { "a".replaceAll(/a/, "b"); return "no" } catch { return "caught" }`)).toBe("caught")
  })

  test("new RegExp constructs from strings; invalid patterns are catchable", async () => {
    expect(await value(`return new RegExp("a+", "i").test("AAA")`)).toBe(true)
    expect(await value(`try { new RegExp("("); return "no" } catch { return "caught" }`)).toBe("caught")
    expect(await value(`return [/a/ instanceof RegExp, /a/.source]`)).toEqual([true, "a"])
  })

  test("invalid patterns fail with actionable messages", async () => {
    const fromString = await error(`return "abc".match("(")`)
    expect(fromString.message).toContain('String.match received the string "("')
    expect(fromString.message).toContain("escape them with a backslash")

    const fromConstructor = await error(`return new RegExp("(")`)
    expect(fromConstructor.message).toContain('new RegExp(...) received "("')
    expect(fromConstructor.message).toContain("escape them with a backslash")

    const fromFlags = await error(`return new RegExp("a", "xz")`)
    expect(fromFlags.message).toContain('invalid flags "xz"')
    expect(fromFlags.message).toContain("Valid flags are")
  })

  test("missing g-flag errors say how to fix the call", async () => {
    expect((await error(`return "aa".replaceAll(/a/, "b")`)).message).toContain("write /a/g, or use String.replace")
    expect((await error(`return "aa".matchAll(/a/)`)).message).toContain("write /a/g, or use String.match")
  })

  test("a non-pattern argument names the expected shapes", async () => {
    const err = await error(`return "abc".match(42)`)
    expect(err.message).toContain("expects a regular expression")
    expect(err.message).toContain("not number")
  })

  test("source and flags properties read through", async () => {
    expect(await value(`const r = /ab/gi; return { source: r.source, flags: r.flags, global: r.global }`)).toEqual({
      source: "ab",
      flags: "gi",
      global: true,
    })
  })

  test("regexes serialize to {} at the boundary, like JSON", async () => {
    expect(await value(`return /a/`)).toEqual({})
    expect(await value(`return JSON.stringify({ r: /a/g })`)).toBe('{"r":{}}')
  })

  test("template interpolation renders the literal form", async () => {
    expect(await value("return `${/ab/g}`")).toBe("/ab/g")
  })
})

describe("URL and URI helpers", () => {
  test("encodes and decodes complete URIs and URI components", async () => {
    expect(
      await value(`
        return [
          encodeURI("https://example.test/a b?q=a/b"),
          encodeURIComponent("a b/c?"),
          decodeURI("https://example.test/a%20b?q=a/b"),
          decodeURIComponent("a%20b%2Fc%3F"),
          ["a b", "c/d"].map(encodeURIComponent),
        ]
      `),
    ).toEqual([
      "https://example.test/a%20b?q=a/b",
      "a%20b%2Fc%3F",
      "https://example.test/a b?q=a/b",
      "a b/c?",
      ["a%20b", "c%2Fd"],
    ])
    expect(
      await value(`try { decodeURIComponent("%zz"); return false } catch (error) { return error instanceof URIError }`),
    ).toBe(true)
  })

  test("resolves and mutates URLs with linked search parameters", async () => {
    expect(
      await value(`
        const url = new URL("../users?id=old#top", "https://user:pass@example.com:8443/api/v1/")
        url.pathname = "/items/a b"
        url.searchParams.set("id", "a b")
        url.searchParams.append("tag", "x/y")
        url.hash = "part 1"
        return {
          href: url.href,
          origin: url.origin,
          host: url.host,
          pathname: url.pathname,
          search: url.search,
          id: url.searchParams.get("id"),
          string: String(url),
          json: url.toJSON(),
          instances: [
            url instanceof URL,
            url.searchParams instanceof URLSearchParams,
            url.searchParams === url.searchParams,
          ],
        }
      `),
    ).toEqual({
      href: "https://user:pass@example.com:8443/items/a%20b?id=a+b&tag=x%2Fy#part%201",
      origin: "https://example.com:8443",
      host: "example.com:8443",
      pathname: "/items/a%20b",
      search: "?id=a+b&tag=x%2Fy",
      id: "a b",
      string: "https://user:pass@example.com:8443/items/a%20b?id=a+b&tag=x%2Fy#part%201",
      json: "https://user:pass@example.com:8443/items/a%20b?id=a+b&tag=x%2Fy#part%201",
      instances: [true, true, true],
    })
  })

  test("URLSearchParams supports records, pairs, mutation, callbacks, and materialization", async () => {
    expect(
      await value(`
        const params = new URLSearchParams([["tag", "b"], ["tag", "a"], ["q", "a b"]])
        const seen = []
        params.forEach((value, key) => seen.push(key + "=" + value))
        params.delete("tag", "b")
        params.append("tag", "c")
        params.sort()
        return {
          text: params.toString(),
          size: params.size,
          tags: params.getAll("tag"),
          has: params.has("tag", "c"),
          entries: Array.from(params),
          object: Object.fromEntries(params),
          record: new URLSearchParams({ page: 2, filter: "open" }).toString(),
          seen,
        }
      `),
    ).toEqual({
      text: "q=a+b&tag=a&tag=c",
      size: 3,
      tags: ["a", "c"],
      has: true,
      entries: [
        ["q", "a b"],
        ["tag", "a"],
        ["tag", "c"],
      ],
      object: { q: "a b", tag: "c" },
      record: "page=2&filter=open",
      seen: ["tag=b", "tag=a", "q=a b"],
    })
  })

  test("URL parsing failures are catchable and values use native JSON forms", async () => {
    expect(
      await value(`
        const parsed = URL.parse("/users", "https://example.test/api/")
        let invalidIsTypeError = false
        try { new URL("not relative without a base") } catch (error) { invalidIsTypeError = error instanceof TypeError }
        return {
          canParse: URL.canParse("/users", "https://example.test/api/"),
          cannotParse: URL.canParse("not relative without a base"),
          parsed: parsed.href,
          invalidIsTypeError,
          boundary: [new URL("https://example.test/a"), new URLSearchParams("q=one")],
          json: JSON.stringify({ url: new URL("https://example.test/a"), params: new URLSearchParams("q=one") }),
        }
      `),
    ).toEqual({
      canParse: true,
      cannotParse: false,
      parsed: "https://example.test/users",
      invalidIsTypeError: true,
      boundary: ["https://example.test/a", {}],
      json: '{"url":"https://example.test/a","params":{}}',
    })
  })

  test("distinguishes omitted URL arguments from explicit undefined", async () => {
    expect(
      await value(`
        function throwsTypeError(run) {
          try { run(); return false } catch (error) { return error instanceof TypeError }
        }
        const params = new URLSearchParams()
        const required = [
          () => params.append(),
          () => params.delete(),
          () => params.get(),
          () => params.getAll(),
          () => params.has(),
          () => params.set(),
          () => params.forEach(),
        ].map(throwsTypeError)
        params.append(undefined, undefined)
        return {
          construct: throwsTypeError(() => new URL()),
          canParse: throwsTypeError(() => URL.canParse()),
          parse: throwsTypeError(() => URL.parse()),
          explicitUndefined: new URL(undefined, "https://example.test/base/").href,
          params: params.toString(),
          required,
        }
      `),
    ).toEqual({
      construct: true,
      canParse: true,
      parse: true,
      explicitUndefined: "https://example.test/base/undefined",
      params: "undefined=undefined",
      required: [true, true, true, true, true, true, true],
    })
  })
})

describe("Map", () => {
  test("get/set/has/size with chaining", async () => {
    expect(
      await value(`
      const m = new Map()
      m.set("a", 1).set("b", 2)
      return { a: m.get("a"), b: m.get("b"), has: m.has("a"), miss: m.get("zz") === undefined, size: m.size }
    `),
    ).toEqual({ a: 1, b: 2, has: true, miss: true, size: 5 - 3 })
  })

  test("object keys use identity", async () => {
    expect(
      await value(`
      const key = { id: 1 }
      const m = new Map()
      m.set(key, "hit")
      return [m.get(key), m.get({ id: 1 }) === undefined]
    `),
    ).toEqual(["hit", true])
  })

  test("construction from entry pairs and another Map", async () => {
    expect(await value(`const m = new Map([["a", 1], ["b", 2]]); return m.get("b")`)).toBe(2)
    expect(
      await value(
        `const m = new Map([["a", 1]]); const n = new Map(m); n.set("b", 2); return [n.get("a"), n.get("b"), m.has("b")]`,
      ),
    ).toEqual([1, 2, false])
    expect((await error(`return new Map("nope")`)).message).toMatch(/\[key, value\] pairs/)
    expect((await error(`return new Map(["flat"])`)).message).toMatch(/\[key, value\] pairs/)
  })

  test("keys/values/entries return arrays", async () => {
    expect(
      await value(`
      const m = new Map([["a", 1], ["b", 2]])
      return { keys: m.keys(), values: m.values(), entries: m.entries() }
    `),
    ).toEqual({
      keys: ["a", "b"],
      values: [1, 2],
      entries: [
        ["a", 1],
        ["b", 2],
      ],
    })
  })

  test("Object.fromEntries(map) and Array.from(map)", async () => {
    expect(await value(`return Object.fromEntries(new Map([["a", 1], ["b", 2]]))`)).toEqual({ a: 1, b: 2 })
    expect(await value(`return Array.from(new Map([["a", 1]]))`)).toEqual([["a", 1]])
  })

  test("for...of iterates [key, value] pairs with destructuring", async () => {
    expect(
      await value(`
      const m = new Map([["a", 1], ["b", 2]])
      let total = 0
      let names = ""
      for (const [key, count] of m) { names += key; total += count }
      return names + total
    `),
    ).toBe("ab3")
  })

  test("spread produces entry pairs", async () => {
    expect(await value(`return [...new Map([["a", 1]])]`)).toEqual([["a", 1]])
  })

  test("forEach passes (value, key)", async () => {
    expect(
      await value(`
      const m = new Map([["a", 1], ["b", 2]])
      const seen = []
      m.forEach((count, key) => seen.push(key + count))
      return seen
    `),
    ).toEqual(["a1", "b2"])
  })

  test("delete and clear", async () => {
    expect(
      await value(`
      const m = new Map([["a", 1], ["b", 2]])
      const removed = m.delete("a")
      const missed = m.delete("zz")
      const sizeAfterDelete = m.size
      m.clear()
      return [removed, missed, sizeAfterDelete, m.size]
    `),
    ).toEqual([true, false, 1, 0])
  })

  test("counting idiom: grouped tallies", async () => {
    expect(
      await value(`
      const words = ["a", "b", "a", "c", "a"]
      const counts = new Map()
      for (const word of words) counts.set(word, (counts.get(word) ?? 0) + 1)
      return Object.fromEntries(counts)
    `),
    ).toEqual({ a: 3, b: 1, c: 1 })
  })

  test("maps serialize to {} at the boundary, like JSON", async () => {
    expect(await value(`return new Map([["a", 1]])`)).toEqual({})
    expect(await value(`return JSON.stringify(new Map([["a", 1]]))`)).toBe("{}")
  })

  test("console.log renders map contents for debugging", async () => {
    const result = await run(`console.log(new Map([["a", 1]])); return null`)
    expect(result.ok).toBe(true)
    expect(result.logs?.[0]).toBe(`Map(1) [["a",1]]`)
  })
})

describe("Set", () => {
  test("add/has/delete/size with chaining", async () => {
    expect(
      await value(`
      const s = new Set()
      s.add(1).add(2).add(1)
      const removed = s.delete(2)
      return [s.size, s.has(1), s.has(2), removed]
    `),
    ).toEqual([1, true, false, true])
  })

  test("dedupe idiom: [...new Set(items)]", async () => {
    expect(await value(`return [...new Set([1, 2, 2, 3, 1])]`)).toEqual([1, 2, 3])
  })

  test("construction from strings and other Sets", async () => {
    expect(await value(`return [...new Set("aba")]`)).toEqual(["a", "b"])
    expect(await value(`return Array.from(new Set(new Set([1, 2])))`)).toEqual([1, 2])
  })

  test("SameValueZero: NaN is findable", async () => {
    expect(await value(`const s = new Set([NaN]); return s.has(NaN)`)).toBe(true)
  })

  test("for...of iterates values", async () => {
    expect(
      await value(`
      let total = 0
      for (const n of new Set([1, 2, 3])) total += n
      return total
    `),
    ).toBe(6)
  })

  test("sets serialize to {} at the boundary, like JSON", async () => {
    expect(await value(`return { s: new Set([1]) }`)).toEqual({ s: {} })
  })
})

describe("stdlib integration", () => {
  test("constructor follows own keys, shadowing, writes, and new", async () => {
    expect(
      await value(`return [JSON.parse('{"constructor":"Foo"}').constructor, ({ constructor: 1 }).constructor]`),
    ).toEqual(["Foo", 1])
    expect(await value(`const Array = 5; return [].constructor.isArray([])`)).toBe(true)
    expect(await value(`const o = {}; o.constructor = 7; return o.constructor`)).toBe(7)
    expect(await value(`return new ([].constructor)(3).length`)).toBe(3)
    expect(await value(`return typeof ({}).constructor`)).toBe("function")
    expect(await value(`return ({}).constructor.constructor === Function`)).toBe(true)
  })

  test("new dispatches on the constructor value, not its name", async () => {
    expect(await value(`const D = Date; return new D(0) instanceof Date`)).toBe(true)
    expect(await value(`const make = (C) => new C([["a", 1]]); return make(Map).get("a")`)).toBe(1)
    expect(await value(`const t = { M: Map }; return new t.M() instanceof Map`)).toBe(true)
    const shadowed = await error(`const Date = 5; return new Date()`)
    expect(shadowed.message).toStartWith("Date is not a constructor.")
    const fn = await error(`const f = () => 1; return new f()`)
    expect(fn.message).toStartWith("f cannot be constructed")
  })

  test("Object.is uses SameValue semantics", async () => {
    expect(
      await value(`
        const object = {}
        return [
          Object.is(NaN, NaN),
          Object.is(0, -0),
          Object.is(object, object),
          Object.is({}, {}),
        ]
      `),
    ).toEqual([true, false, true, false])
  })

  test("Object.is rejects opaque runtime references", async () => {
    expect((await error(`return Object.is(Math.max, Math.max)`)).kind).toBe("InvalidDataValue")
  })

  test("Object values and entries accept arrays", async () => {
    expect(await value(`return [Object.values(["a", "b"]), Object.entries(["a", "b"])]`)).toEqual([
      ["a", "b"],
      [
        ["0", "a"],
        ["1", "b"],
      ],
    ])
    expect(await value(`const match = /a/.exec("ba"); return [Object.values(match), Object.entries(match)]`)).toEqual([
      ["a", 1, "ba"],
      [
        ["0", "a"],
        ["index", 1],
        ["input", "ba"],
      ],
    ])
    expect(await value(`return Object.keys(Object.values({ match: /a/.exec("ba") })[0])`)).toEqual([
      "0",
      "index",
      "input",
    ])
  })

  test("Object.fromEntries accepts every supported entry collection", async () => {
    expect(
      await value(`
        return [
          Object.fromEntries([["a", 1]]),
          Object.fromEntries(new Map([["b", 2]])),
          Object.fromEntries(new Set([["c", 3]])),
          Object.fromEntries(new URLSearchParams("d=4")),
          Object.fromEntries([{ 0: "e", 1: 5 }]),
          Object.fromEntries(new Set([[{}, 6], [new Date(0), 7], [null, 8], [undefined, 9]])),
        ]
      `),
    ).toEqual([
      { a: 1 },
      { b: 2 },
      { c: 3 },
      { d: "4" },
      { e: 5 },
      { "[object Object]": 6, "1970-01-01T00:00:00.000Z": 7, null: 8, undefined: 9 },
    ])
    expect(await value(`try { Object.fromEntries(new Set([Math.max])); return false } catch { return true }`)).toBe(
      true,
    )
    expect(
      await value(`try { Object.fromEntries(new Map([["fn", Math.max]])); return false } catch { return true }`),
    ).toBe(true)
  })

  test("deterministic Math methods match the host runtime", async () => {
    const result = await value(`
      return [
        Math.acos(0.5), Math.acosh(2), Math.asin(0.5), Math.asinh(2), Math.atan(1), Math.atan2(1, 2), Math.atanh(0.5),
        Math.cos(0.5), Math.cosh(0.5), Math.sin(0.5), Math.sinh(0.5), Math.tan(0.5), Math.tanh(0.5),
        Math.log1p(0.5), Math.expm1(0.5), Math.f16round(1.337), Math.fround(1.337), Math.clz32(1), Math.imul(2, 3),
      ]
    `)
    expect(result).toEqual([
      Math.acos(0.5),
      Math.acosh(2),
      Math.asin(0.5),
      Math.asinh(2),
      Math.atan(1),
      Math.atan2(1, 2),
      Math.atanh(0.5),
      Math.cos(0.5),
      Math.cosh(0.5),
      Math.sin(0.5),
      Math.sinh(0.5),
      Math.tan(0.5),
      Math.tanh(0.5),
      Math.log1p(0.5),
      Math.expm1(0.5),
      Math.f16round(1.337),
      Math.fround(1.337),
      Math.clz32(1),
      Math.imul(2, 3),
    ])
  })

  test("Object.assign mutates and returns its target", async () => {
    expect(
      await value(`
        const target = { a: 1 }
        const result = Object.assign(target, { b: 2 })
        return { target, result, same: target === result }
      `),
    ).toEqual({ target: { a: 1, b: 2 }, result: { a: 1, b: 2 }, same: true })
    expect(await value(`try { Object.assign(null, { a: 1 }); return false } catch { return true }`)).toBe(true)
  })

  test("Object.assign rejects direct and nested cycles", async () => {
    expect(
      await value(`
        const target = { kept: true }
        try { Object.assign(target, { self: target }) } catch { return target }
        return null
      `),
    ).toEqual({ kept: true })
    expect(
      await value(`
        const target = { kept: true }
        const nested = { target }
        try { Object.assign(target, { nested }) } catch { return target }
        return null
      `),
    ).toEqual({ kept: true })
    expect(
      await value(`
        const target = {}
        const source = {}
        source[Symbol.iterator] = target
        try { Object.assign(target, source) } catch { return Object.hasOwn(target, Symbol.iterator) }
        return true
      `),
    ).toBe(false)
    expect(
      await value(`
        const target = {}
        const nested = {}
        nested[Symbol.iterator] = target
        try { Object.assign(target, { nested }) } catch { return Object.hasOwn(target, "nested") }
        return true
      `),
    ).toBe(false)
  })

  test("Object.assign preserves mutations before a circular field", async () => {
    expect(
      await value(`
        const target = {}
        try { Object.assign(target, { before: 1, cycle: { target }, after: 2 }) } catch { return target }
        return null
      `),
    ).toEqual({ before: 1 })
    expect(
      await value(`
        const target = {}
        const marker = {}
        const source = {}
        source[Symbol.iterator] = marker
        source[Symbol.asyncIterator] = target
        try { Object.assign(target, source) } catch {
          return [target[Symbol.iterator] === marker, Object.hasOwn(target, Symbol.asyncIterator)]
        }
        return null
      `),
    ).toEqual([true, false])
  })

  test("Object.assign preserves target identity and acyclic shared aliases", async () => {
    expect(
      await value(`
        const shared = { count: 1 }
        const target = {}
        const result = Object.assign(target, { left: shared, right: shared })
        result.left.count = 2
        return [result === target, result.left === shared, result.left === result.right, shared.count]
      `),
    ).toEqual([true, true, true, 2])
  })

  test("assignment resolves and reads its left side before evaluating the right side", async () => {
    expect(await value(`let x = 1; x += (x = 5); return x`)).toBe(6)
    expect(await value(`let i = 0; const values = [9]; values[i++] = i; return [values, i]`)).toEqual([[1], 1])
    expect(await value(`let i = 0; const values = [10, 20]; values[i++] += i; return [values, i]`)).toEqual([
      [11, 20],
      1,
    ])
  })

  test("typeof reports constructors as functions and never throws", async () => {
    expect(await value(`return typeof Map`)).toBe("function")
    expect(await value(`return typeof ((x) => x)`)).toBe("function")
    expect(await value(`return typeof Math`)).toBe("object")
    expect(await value(`return typeof tools`)).toBe("object")
  })

  test("negation works on any value", async () => {
    expect(await value(`return !new Map()`)).toBe(false)
    expect(await value(`const fn = () => 1; return !fn`)).toBe(false)
  })

  test("object spread of CodeMode values is a no-op, like JS", async () => {
    expect(await value(`return { ...new Map([["a", 1]]), kept: true }`)).toEqual({ kept: true })
  })

  test("dates inside Map values survive in-CodeMode reads", async () => {
    expect(
      await value(`
      const m = new Map([["start", new Date(1000)]])
      return m.get("start").getTime()
    `),
    ).toBe(1000)
  })

  test("instanceof recognizes the stdlib value types", async () => {
    expect(
      await value(
        `return [new Date(0) instanceof Date, /a/ instanceof RegExp, new Map() instanceof Map, new Set() instanceof Set]`,
      ),
    ).toEqual([true, true, true, true])
    expect(
      await value(`return [[1] instanceof Array, [1] instanceof Object, ({}) instanceof Object, 5 instanceof Object]`),
    ).toEqual([true, true, true, false])
    expect(await value(`return [new Map() instanceof Set, "s" instanceof Date]`)).toEqual([false, false])
    expect(
      await value(`const p = Promise.resolve(1); const isPromise = p instanceof Promise; await p; return isPromise`),
    ).toBe(true)
  })

  test("realistic pipeline: parse, extract with regex, dedupe, count by day", async () => {
    expect(
      await value(`
      const raw = '[{"at":"2024-01-01T05:00:00Z","tag":"a b"},{"at":"2024-01-01T09:00:00Z","tag":"b c"},{"at":"2024-01-02T01:00:00Z","tag":"a"}]'
      const rows = JSON.parse(raw)
      const tags = new Set()
      const byDay = new Map()
      for (const row of rows) {
        for (const m of row.tag.matchAll(/[a-z]+/g)) tags.add(m[0])
        const day = new Date(row.at).toISOString().slice(0, 10)
        byDay.set(day, (byDay.get(day) ?? 0) + 1)
      }
      return { tags: [...tags].sort((a, b) => (a < b ? -1 : 1)), byDay: Object.fromEntries(byDay) }
    `),
    ).toEqual({ tags: ["a", "b", "c"], byDay: { "2024-01-01": 2, "2024-01-02": 1 } })
  })
})

describe("CodeMode values at intra-CodeMode checkpoints", () => {
  test("Object.values/entries keep Dates usable", async () => {
    expect(await value(`return Object.values({ d: new Date(0) })[0].getTime()`)).toBe(0)
    expect(await value(`const [key, d] = Object.entries({ d: new Date(0) })[0]; return key + ":" + d.getTime()`)).toBe(
      "d:0",
    )
  })

  test("Object.values/entries preserve nested object identity", async () => {
    expect(
      await value(`
      const child = { selected: false }
      const rows = { a: child }
      Object.values(rows)[0].selected = true
      return child.selected
    `),
    ).toBe(true)
    expect(
      await value(`
      const child = { selected: false }
      const rows = { a: child }
      Object.entries(rows)[0][1].selected = true
      return child.selected
    `),
    ).toBe(true)
  })

  test("Object enumeration preserves promises and callable references", async () => {
    expect(
      await value(`
      const pending = Promise.resolve(1)
      const source = { pending }
      return [Object.keys(source), Object.hasOwn(source, "pending"), await Object.values(source)[0], await Object.entries(source)[0][1]]
    `),
    ).toEqual([["pending"], true, 1, 1])
    expect(await value(`return Object.values({ max: Math.max })[0](1, 2)`)).toBe(2)
  })

  test("Object enumeration rejects invalid receivers and gives promises an await hint", async () => {
    const diagnostic = await error(`return Object.keys(Promise.resolve({ a: 1 }))`)
    expect(diagnostic.kind).toBe("InvalidDataValue")
    expect(diagnostic.message).toContain("await")
    expect(await value(`return Object.keys(Math)`)).toEqual([])
  })

  test("Object.assign keeps Maps usable", async () => {
    expect(await value(`const merged = Object.assign({}, { m: new Map([["a", 1]]) }); return merged.m.get("a")`)).toBe(
      1,
    )
  })

  test("object and array spread keep CodeMode values usable", async () => {
    expect(
      await value(`
      const src = { m: new Map([["a", 1]]) }
      const copy = { ...src }
      copy.m.set("b", 2)
      return [copy.m.get("a"), src.m.get("b")]
    `),
    ).toEqual([1, 2])
    expect(await value(`const list = [new Date(1000)]; const copy = [...list]; return copy[0].getTime()`)).toBe(1000)
  })

  test("Array.from over arrays keeps nested CodeMode values usable", async () => {
    expect(await value(`return Array.from([new Date(5)])[0].getTime()`)).toBe(5)
  })

  test("Array.from and Array.of preserve nested object identity", async () => {
    expect(
      await value(`
      const child = { selected: false }
      Array.from([child])[0].selected = true
      return child.selected
    `),
    ).toBe(true)
    expect(
      await value(`
      const child = { selected: false }
      Array.of(child)[0].selected = true
      return child.selected
    `),
    ).toBe(true)
  })

  test("Array.from and Array.of preserve promises and callable references", async () => {
    expect(
      await value(`
      const pending = Promise.resolve(1)
      return [await Array.from([pending])[0], await Array.of(pending)[0]]
    `),
    ).toEqual([1, 1])
    expect(await value(`return [Array.from([Math.max])[0](1, 2), Array.of(Math.max)[0](3, 4)]`)).toEqual([2, 4])
  })

  test("Array.from preserves identity across supported collection shapes", async () => {
    expect(
      await value(`
      const child = { selected: false }
      const fromArrayLike = Array.from({ 0: child, length: 1 })
      const fromMap = Array.from(new Map([["child", child]]))
      const fromSet = Array.from(new Set([child]))
      fromArrayLike[0].selected = true
      return [fromMap[0][1] === child, fromSet[0] === child, child.selected]
    `),
    ).toEqual([true, true, true])
  })

  test("Array.from rejects invalid receivers and gives promises an await hint", async () => {
    const diagnostic = await error(`return Array.from(Promise.resolve([1]))`)
    expect(diagnostic.kind).toBe("InvalidDataValue")
    expect(diagnostic.message).toContain("await")
    expect(await value(`return Array.from((a, b) => 1)`)).toEqual([null, null])
  })

  test("regexes stay callable through Object.values", async () => {
    expect(await value(`return Object.values({ r: /ab+/ })[0].test("abb")`)).toBe(true)
  })

  test("Object.* helpers see CodeMode values as empty objects, never internals", async () => {
    expect(await value(`return Object.keys(new Map([["a", 1]]))`)).toEqual([])
    expect(await value(`return Object.values(new Date(0))`)).toEqual([])
    expect(await value(`return Object.entries(new Set([1]))`)).toEqual([])
    expect(await value(`return Object.assign({}, new Map([["a", 1]]))`)).toEqual({})
    expect(await value(`return Object.hasOwn(new Date(0), "time")`)).toBe(false)
  })

  test("the host boundary still serializes JSON forms: results, JSON.stringify, and tool arguments", async () => {
    expect(await value(`return { d: new Date(0), m: new Map([["a", 1]]) }`)).toEqual({
      d: "1970-01-01T00:00:00.000Z",
      m: {},
    })
    expect(await value(`return JSON.stringify({ d: new Date(0) })`)).toBe('{"d":"1970-01-01T00:00:00.000Z"}')

    const observed: Array<unknown> = []
    const capture = Tool.make({
      description: "Capture the exact input the host receives",
      input: { type: "object" },
      execute: (input) =>
        Effect.sync(() => {
          observed.push(input)
          return "ok"
        }),
    })
    const result = await Effect.runPromise(
      CodeMode.execute({
        tools: { host: { capture } },
        code: `return await tools.host.capture({ when: new Date(0), tags: new Map([["a", 1]]) })`,
      }),
    )
    expect(result.ok).toBe(true)
    expect(observed).toStrictEqual([{ when: "1970-01-01T00:00:00.000Z", tags: {} }])
  })
})
