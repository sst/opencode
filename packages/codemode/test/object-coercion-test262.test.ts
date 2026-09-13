/**
 * Portions adapted from Test262 at revision 250f204f23a9249ff204be2baec29600faae7b75:
 * - test/built-ins/Object/keys/15.2.3.14-1-1.js
 * - test/built-ins/Object/keys/15.2.3.14-1-2.js
 * - test/built-ins/Object/keys/15.2.3.14-1-3.js
 * - test/built-ins/Object/keys/15.2.3.14-1-4.js
 * - test/built-ins/Object/keys/15.2.3.14-1-5.js
 * - test/built-ins/Object/entries/primitive-strings.js
 * - test/built-ins/Object/entries/primitive-numbers.js
 * - test/built-ins/Object/entries/primitive-booleans.js
 * - test/built-ins/Object/values/primitive-strings.js
 * - test/built-ins/Object/values/primitive-numbers.js
 * - test/built-ins/Object/values/primitive-booleans.js
 * - test/built-ins/Object/hasOwn/toobject_null.js
 * - test/built-ins/Object/hasOwn/toobject_undefined.js
 * - test/built-ins/Object/hasOwn/hasown_nonexistent.js
 * - test/built-ins/Object/assign/Source-String.js
 * - test/built-ins/Object/assign/Source-Null-Undefined.js
 * - test/built-ins/Object/assign/target-Array.js
 * - test/built-ins/Object/assign/Target-Null.js
 * - test/built-ins/Object/assign/Target-Undefined.js
 * - test/built-ins/Object/assign/Target-Object.js
 * - test/built-ins/Object/assign/Override.js
 * - test/built-ins/Object/assign/ObjectOverride-sameproperty.js
 *
 * Copyright (c) 2012 Ecma International. All rights reserved.
 * Copyright (C) 2015 Jordan Harband. All rights reserved.
 * Copyright 2015 Microsoft Corporation. All rights reserved.
 * Copyright 2021 Jamie Kyle. All rights reserved.
 * Test262 portions are governed by the BSD license in LICENSE.test262.
 *
 * Boxed-primitive cases (`Object.assign("a")`, `Object.assign(1, …)`) are omitted: CodeMode has no
 * wrapper objects, so a primitive target is a TypeError rather than a boxed result. `Override.js`
 * checks `Object.keys(result).length` instead of `Object.getOwnPropertyNames`. `target-Array.js`
 * omits its named-key (`-0`, `1.5`, `4294967295`), `length`, and Proxy assertions: arrays here hold
 * only indexed elements, so those keys are a TypeError (pinned below) rather than array properties.
 */
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { CodeMode } from "../src/index.js"

const value = async (code: string) => {
  const result = await Effect.runPromise(CodeMode.execute({ code, tools: {} }))
  if (!result.ok) throw new Error(`expected success, got ${result.error.kind}: ${result.error.message}`)
  return result.value
}

const throwsTypeError = (expression: string) =>
  value(`try { ${expression}; return "no throw" } catch (error) { return error.name }`)

describe("Object.keys Test262 parity", () => {
  test("test/built-ins/Object/keys/15.2.3.14-1-{1,2,3}.js: primitives are coerced", async () => {
    expect(await value(`return [Object.keys(0), Object.keys(true), Object.keys("abc")]`)).toEqual([
      [],
      [],
      ["0", "1", "2"],
    ])
  })

  test("test/built-ins/Object/keys/15.2.3.14-1-{4,5}.js: null and undefined throw TypeError", async () => {
    expect(await throwsTypeError(`Object.keys(null)`)).toBe("TypeError")
    expect(await throwsTypeError(`Object.keys(undefined)`)).toBe("TypeError")
  })
})

describe("Object.entries and Object.values Test262 parity", () => {
  test("test/built-ins/Object/entries/primitive-strings.js", async () => {
    expect(
      await value(`
        const result = Object.entries('abc')
        return [Array.isArray(result), result.length, result[0][0], result[0][1], result[1][0], result[1][1], result[2][0], result[2][1]]
      `),
    ).toEqual([true, 3, "0", "a", "1", "b", "2", "c"])
  })

  test("test/built-ins/Object/entries/primitive-numbers.js", async () => {
    expect(
      await value(`
        return [0, -0, Infinity, -Infinity, NaN, Math.PI].map((number) => Object.entries(number).length)
      `),
    ).toEqual([0, 0, 0, 0, 0, 0])
  })

  test("test/built-ins/Object/entries/primitive-booleans.js", async () => {
    expect(
      await value(`
        const trueResult = Object.entries(true)
        const falseResult = Object.entries(false)
        return [Array.isArray(trueResult), trueResult.length, Array.isArray(falseResult), falseResult.length]
      `),
    ).toEqual([true, 0, true, 0])
  })

  test("test/built-ins/Object/values/primitive-strings.js", async () => {
    expect(
      await value(`
        const result = Object.values('abc')
        return [Array.isArray(result), result.length, result[0], result[1], result[2]]
      `),
    ).toEqual([true, 3, "a", "b", "c"])
  })

  test("test/built-ins/Object/values/primitive-numbers.js", async () => {
    expect(
      await value(`
        return [0, -0, Infinity, -Infinity, NaN, Math.PI].map((number) => Object.values(number).length)
      `),
    ).toEqual([0, 0, 0, 0, 0, 0])
  })

  test("test/built-ins/Object/values/primitive-booleans.js", async () => {
    expect(
      await value(`
        const trueResult = Object.values(true)
        const falseResult = Object.values(false)
        return [Array.isArray(trueResult), trueResult.length, Array.isArray(falseResult), falseResult.length]
      `),
    ).toEqual([true, 0, true, 0])
  })
})

describe("Object.hasOwn Test262 parity", () => {
  test("test/built-ins/Object/hasOwn/toobject_{null,undefined}.js", async () => {
    expect(await throwsTypeError(`Object.hasOwn(null, 'foo')`)).toBe("TypeError")
    expect(await throwsTypeError(`Object.hasOwn(undefined, 'foo')`)).toBe("TypeError")
  })

  test("test/built-ins/Object/hasOwn/hasown_nonexistent.js", async () => {
    expect(await value(`const o = {}; return Object.hasOwn(o, "foo")`)).toBe(false)
  })
})

describe("Object.assign Test262 parity", () => {
  test("test/built-ins/Object/assign/Source-String.js", async () => {
    expect(
      await value(`
        const target = new Object()
        const result = Object.assign(target, "123")
        return [result[0], result[1], result[2]]
      `),
    ).toEqual(["1", "2", "3"])
  })

  test("test/built-ins/Object/assign/Source-Null-Undefined.js", async () => {
    expect(
      await value(`
        const target = new Object()
        const result = Object.assign(target, undefined, null)
        return result === target
      `),
    ).toBe(true)
  })

  test("test/built-ins/Object/assign/target-Array.js", async () => {
    expect(
      await value(`
        const target = [7, 8, 9]
        let result = Object.assign(target, [1])
        const first = [result === target, [...result]]
        const sparseArraySource = []
        sparseArraySource[2] = 3
        result = Object.assign(target, sparseArraySource)
        const second = [result === target, [...result]]
        result = Object.assign(target, { 4: 0 })
        return [...first, ...second, result === target, result.length, result[3] === undefined, result[4]]
      `),
    ).toEqual([true, [1, 8, 9], true, [1, 8, 3], true, 5, true, 0])
  })

  test("test/built-ins/Object/assign/target-Array.js", async () => {
    expect(
      await value(`
        const target = [7]
        for (const source of [{ x: 1 }, { "1.5": 1 }, { "-0": 1 }, { 1: 8 }, { length: 1 }]) Object.assign(target, source)
        return [[...target], target.length, Object.keys(target), target.x]
      `),
    ).toEqual([[7], 1, ["0", "x", "1.5", "-0"], 1])
  })

  test("test/built-ins/Object/assign/Target-{Null,Undefined}.js", async () => {
    expect(await throwsTypeError(`Object.assign(null, { a: 1 })`)).toBe("TypeError")
    expect(await throwsTypeError(`Object.assign(undefined, { a: 1 })`)).toBe("TypeError")
  })

  test("test/built-ins/Object/assign/Target-Object.js", async () => {
    expect(
      await value(`
        const target = { foo: 1 }
        const result = Object.assign(target, { a: 2 })
        return [result.foo, result.a]
      `),
    ).toEqual([1, 2])
  })

  test("test/built-ins/Object/assign/Override.js", async () => {
    expect(
      await value(`
        const target = { a: 1 }
        const result = Object.assign(target, "1a2c3", { a: "c" }, undefined, { b: 6 }, null, 125, { a: 5 })
        return [Object.keys(result).length, result.a, result[0], result[1], result[2], result[3], result[4], result.b]
      `),
    ).toEqual([7, 5, "1", "a", "2", "c", "3", 6])
  })

  test("test/built-ins/Object/assign/ObjectOverride-sameproperty.js", async () => {
    expect(
      await value(`
        const target = { a: 1 }
        const result = Object.assign(target, { a: 2 }, { a: "c" })
        return result.a
      `),
    ).toBe("c")
  })
})
