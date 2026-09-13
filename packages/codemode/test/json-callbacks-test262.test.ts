/*
 * Portions adapted from Test262 at revision 250f204f23a9249ff204be2baec29600faae7b75:
 * - test/built-ins/JSON/parse/reviver-call-order.js
 * - test/built-ins/JSON/parse/reviver-call-err.js
 * - test/built-ins/JSON/stringify/replacer-array-duplicates.js
 * - test/built-ins/JSON/stringify/replacer-array-empty.js
 * - test/built-ins/JSON/stringify/replacer-array-number.js
 * - test/built-ins/JSON/stringify/replacer-array-order.js
 * - test/built-ins/JSON/stringify/replacer-array-undefined.js
 * - test/built-ins/JSON/stringify/replacer-array-wrong-type.js
 * - test/built-ins/JSON/stringify/replacer-function-abrupt.js
 * - test/built-ins/JSON/stringify/replacer-function-arguments.js
 * - test/built-ins/JSON/stringify/replacer-function-array-circular.js
 * - test/built-ins/JSON/stringify/replacer-function-object-deleted-property.js
 * - test/built-ins/JSON/stringify/replacer-function-object-circular.js
 * - test/built-ins/JSON/stringify/replacer-function-result-undefined.js
 * - test/built-ins/JSON/stringify/replacer-function-result.js
 *
 * Function-context assertions are omitted because CodeMode functions intentionally
 * have no `this`. Number/String wrapper cases are omitted because CodeMode does not
 * support primitive wrapper objects. Proxy and Symbol cases are outside CodeMode.
 *
 * Copyright (C) 2012 Ecma International. All rights reserved.
 * Copyright (C) 2016 the V8 project authors. All rights reserved.
 * Copyright (C) 2019 Aleksey Shvayka. All rights reserved.
 * Copyright 2019 Kevin Gibbons. All rights reserved.
 * Test262 portions are governed by the BSD license in LICENSE.test262.
 */
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { CodeMode } from "../src/index.js"

const value = async (code: string) => {
  const result = await Effect.runPromise(CodeMode.execute({ code, tools: {} }))
  if (!result.ok) throw new Error(`expected success, got ${result.error.kind}: ${result.error.message}`)
  return result.value
}

describe("Test262 JSON.parse reviver adaptations", () => {
  test("test/built-ins/JSON/parse/reviver-call-order.js", async () => {
    expect(
      await value(`
        const calls = []
        JSON.parse('{"p1":0,"p2":0,"p1":0,"2":0,"1":0}', (key, item) => {
          calls.push(key)
          return item
        })
        return calls
      `),
    ).toEqual(["1", "2", "p1", "p2", ""])
  })

  test("deletes properties and array elements when the reviver returns undefined", async () => {
    expect(
      await value(`
        const result = JSON.parse('{"keep":1,"drop":2,"items":[1,2,3]}', (key, item) => {
          if (key === "drop" || key === "1") return undefined
          return item
        })
        return [result, Object.hasOwn(result, "drop"), Object.hasOwn(result.items, 1), result.items.length]
      `),
    ).toEqual([{ keep: 1, items: [1, null, 3] }, false, false, 3])
  })

  test("replaces the root and may delete it", async () => {
    expect(await value(`return JSON.parse('{"a":1}', (key, item) => key === "" ? item.a : item)`)).toBe(1)
    expect(
      await value(`return JSON.parse('{"a":1}', (key, item) => key === "" ? undefined : item) === undefined`),
    ).toBe(true)
  })

  test("test/built-ins/JSON/parse/reviver-call-err.js", async () => {
    expect(
      await value(`try { JSON.parse("0", () => { throw "stop" }) } catch (error) { return error } return "missed"`),
    ).toBe("stop")
  })
})

describe("Test262 JSON.stringify replacer adaptations", () => {
  test("array replacers filter keys in their own order and apply recursively", async () => {
    expect(await value(`return JSON.stringify({ b: 1, a: 2, c: 3 }, ["c", "b", "a"])`)).toBe('{"c":3,"b":1,"a":2}')
    expect(await value(`return JSON.stringify({ a: { b: 2, c: 3 } }, ["c", "b", "a"])`)).toBe('{"a":{"c":3,"b":2}}')
    expect(await value(`return JSON.stringify({ a: 1 }, [])`)).toBe("{}")
  })

  test("array replacers deduplicate and coerce number primitives", async () => {
    expect(await value(`return JSON.stringify({ a: 1, b: 2 }, ["a", "a", "b"])`)).toBe('{"a":1,"b":2}')
    expect(
      await value(
        `return JSON.stringify({ "0": 0, "1": 1, "-4": 2, "0.3": 3, "-Infinity": 4, "NaN": 5 }, [-0, 1, -4, 0.3, -Infinity, NaN])`,
      ),
    ).toBe('{"0":0,"1":1,"-4":2,"0.3":3,"-Infinity":4,"NaN":5}')
  })

  test("array replacers ignore unsupported entry types", async () => {
    expect(
      await value(`return JSON.stringify({ true: 1, false: 2, null: 3, kept: 4 }, [true, false, null, {}, "kept"])`),
    ).toBe('{"kept":4}')
    expect(await value(`return JSON.stringify({ a: 1 }, undefined)`)).toBe('{"a":1}')
  })

  test("function replacers receive keys and values in preorder including the root", async () => {
    expect(
      await value(`
        const calls = []
        const output = JSON.stringify({ a: [1, 2], b: true }, (key, item) => {
          calls.push([key, Array.isArray(item) ? "array" : typeof item])
          return item
        })
        return [output, calls]
      `),
    ).toEqual([
      '{"a":[1,2],"b":true}',
      [
        ["", "object"],
        ["a", "array"],
        ["0", "number"],
        ["1", "number"],
        ["b", "boolean"],
      ],
    ])
  })

  test("test/built-ins/JSON/stringify/replacer-function-object-deleted-property.js", async () => {
    expect(
      await value(`
        const input = { a: 1, b: 2 }
        return JSON.stringify(input, (key, item) => {
          if (key === "a") delete input.b
          if (key === "b" && item === undefined) return "<replaced>"
          return item
        })
      `),
    ).toBe('{"a":1,"b":"<replaced>"}')
  })

  test("test/built-ins/JSON/stringify/replacer-function-object-circular.js", async () => {
    expect(
      await value(`
        const direct = { prop: {} }
        const indirect = { p1: { p2: {} } }
        const errors = []
        try { JSON.stringify(direct, () => direct) } catch (error) { errors.push(error.name) }
        try {
          JSON.stringify(indirect, (key, item) => key === "p2" ? indirect : item)
        } catch (error) { errors.push(error.name) }
        return errors
      `),
    ).toEqual(["TypeError", "TypeError"])
  })

  test("test/built-ins/JSON/stringify/replacer-function-array-circular.js", async () => {
    expect(
      await value(`
        const circular = [{}]
        try { JSON.stringify(circular, () => circular) } catch (error) { return error.name }
        return "missed"
      `),
    ).toBe("TypeError")
  })

  test("repeated objects outside the active ancestor chain are not circular", async () => {
    expect(
      await value(`
        const shared = { value: 1 }
        return JSON.stringify({ left: shared, right: shared }, (key, item) => item)
      `),
    ).toBe('{"left":{"value":1},"right":{"value":1}}')
  })

  test("function replacers replace values and map undefined to omission or null", async () => {
    expect(
      await value(`return JSON.stringify({ a: 1, nested: { b: [1] } }, (key, item) => item === 1 ? undefined : item)`),
    ).toBe('{"nested":{"b":[null]}}')
    expect(await value(`return JSON.stringify(null, (key) => key === "" ? { value: 1 } : 2)`)).toBe('{"value":2}')
    expect(await value(`return JSON.stringify(1, () => undefined) === undefined`)).toBe(true)
  })

  test("callable replacer results follow JSON omission semantics", async () => {
    expect(
      await value(`
        const fn = () => 1
        return [
          JSON.stringify({ user: 1, builtin: 2 }, (key, item) => key === "user" ? fn : key === "builtin" ? Math.abs : item),
          JSON.stringify([1, 2], (key, item) => key === "0" ? fn : key === "1" ? Number : item),
          JSON.stringify(null, () => "abc".includes) === undefined,
        ]
      `),
    ).toEqual(["{}", "[null,null]", true])
  })

  test("built-in toJSON conversion runs before the function replacer", async () => {
    expect(
      await value(`
        const seen = []
        const output = JSON.stringify({ date: new Date(0), url: new URL("https://example.test/a") }, (key, item) => {
          if (key === "date" || key === "url") seen.push(typeof item)
          return item
        })
        return [output, seen]
      `),
    ).toEqual(['{"date":"1970-01-01T00:00:00.000Z","url":"https://example.test/a"}', ["string", "string"]])
  })

  test("test/built-ins/JSON/stringify/replacer-function-abrupt.js", async () => {
    expect(
      await value(`try { JSON.stringify({}, () => { throw "stop" }) } catch (error) { return error } return "missed"`),
    ).toBe("stop")
  })
})

describe("CodeMode JSON callback boundaries", () => {
  test("this remains unsupported rather than exposing callback holders", async () => {
    const result = await Effect.runPromise(
      CodeMode.execute({ code: `return JSON.parse("1", function (key, item) { return this })`, tools: {} }),
    )
    expect(result).toMatchObject({ ok: false, error: { kind: "UnsupportedSyntax" } })
  })

  test("prototype-named keys parse as own data and reach the reviver", async () => {
    expect(
      await value(`
        const seen = []
        const parsed = JSON.parse('{"__proto__":{"polluted":1},"constructor":2}', (key, item) => { seen.push(key); return item })
        return [seen, parsed.__proto__.polluted, parsed.constructor, ({}).polluted, Object.keys(parsed)]
      `),
    ).toEqual([["polluted", "__proto__", "constructor", ""], 1, 2, null, ["__proto__", "constructor"]])
  })

  test("JSON.stringify serializes prototype-named own keys", async () => {
    expect(await value(`return JSON.stringify({ constructor: 1, __proto__: 2 })`)).toBe(
      '{"constructor":1,"__proto__":2}',
    )
  })
})
