/*
 * Portions adapted from Test262 at revision 250f204f23a9249ff204be2baec29600faae7b75:
 * - test/built-ins/RegExp/escape/initial-char-escape.js
 * - test/built-ins/RegExp/escape/escaped-syntax-characters-simple.js
 * - test/built-ins/RegExp/escape/escaped-otherpunctuators.js
 * - test/built-ins/RegExp/escape/escaped-control-characters.js
 * - test/built-ins/RegExp/escape/escaped-whitespace.js
 * - test/built-ins/RegExp/escape/escaped-lineterminator.js
 * - test/built-ins/RegExp/escape/escaped-surrogates.js
 * - test/built-ins/RegExp/escape/escaped-solidus-character-simple.js
 * - test/built-ins/RegExp/escape/escaped-utf16encodecodepoint.js
 * - test/built-ins/RegExp/escape/not-escaped.js
 * - test/built-ins/RegExp/escape/not-escaped-underscore.js
 * - test/built-ins/RegExp/escape/non-string-inputs.js
 * - test/built-ins/RegExp/prototype/hasIndices/this-val-regexp.js
 * - test/built-ins/RegExp/prototype/unicodeSets/uv-flags-constructor.js
 * - test/built-ins/RegExp/match-indices/indices-array.js
 * - test/built-ins/RegExp/match-indices/indices-array-matched.js
 * - test/built-ins/RegExp/match-indices/indices-array-non-unicode-match.js
 * - test/built-ins/RegExp/match-indices/indices-array-unmatched.js
 * - test/built-ins/RegExp/match-indices/indices-array-unicode-match.js
 * - test/built-ins/RegExp/match-indices/indices-groups-object-undefined.js
 * - test/built-ins/RegExp/match-indices/indices-groups-object-unmatched.js
 * - test/built-ins/RegExp/match-indices/no-indices-array.js
 * - test/built-ins/Math/sumPrecise/takes-iterable.js
 * - test/built-ins/Math/sumPrecise/sum.js
 * - test/built-ins/Math/sumPrecise/sum-is-infinite.js
 * - test/built-ins/Math/sumPrecise/sum-is-minus-zero.js
 * - test/built-ins/Math/sumPrecise/sum-is-NaN.js
 * - test/built-ins/Math/sumPrecise/throws-on-non-number.js
 *
 * Copyright (C) 2019 Ron Buckton. All rights reserved.
 * Copyright (C) 2021 Ron Buckton and the V8 project authors. All rights reserved.
 * Copyright (C) 2024 Kevin Gibbons. All rights reserved.
 * Copyright (C) 2024 Leo Balter. All rights reserved.
 * Copyright (C) 2024 Leo Balter, Jordan Harband. All rights reserved.
 * Copyright 2022 Mathias Bynens. All rights reserved.
 * Test262 portions are governed by the BSD license in LICENSE.test262.
 * Generator and custom-iterator cases are omitted because CodeMode exposes only its supported collection iterables;
 * the Math.sumPrecise iterable case additionally covers Set.
 */
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { CodeMode } from "../src/index.js"

const value = async (code: string) => {
  const result = await Effect.runPromise(CodeMode.execute({ code, tools: {} }))
  if (!result.ok) throw new Error(`expected success, got ${result.error.kind}: ${result.error.message}`)
  return result.value
}

describe("RegExp Test262 parity", () => {
  test("RegExp.escape encodes syntax, punctuators, whitespace, and surrogates", async () => {
    expect(
      await value(`
        return [
          RegExp.escape("1+1"),
          RegExp.escape("foo.bar"),
          RegExp.escape(".*+?^$|()[]{}"),
          RegExp.escape(",-=#&!%:;@~'"),
          RegExp.escape("\\t\\n\\v\\f\\r"),
          RegExp.escape("\\uFEFF \\u00A0\\u202F"),
          RegExp.escape("\\u2028\\u2029"),
          RegExp.escape("\\uD800"),
          RegExp.escape("\\uDFFF"),
        ]
      `),
    ).toEqual([
      "\\x31\\+1",
      "\\x66oo\\.bar",
      "\\.\\*\\+\\?\\^\\$\\|\\(\\)\\[\\]\\{\\}",
      "\\x2c\\x2d\\x3d\\x23\\x26\\x21\\x25\\x3a\\x3b\\x40\\x7e\\x27",
      "\\t\\n\\v\\f\\r",
      "\\ufeff\\x20\\xa0\\u202f",
      "\\u2028\\u2029",
      "\\ud800",
      "\\udfff",
    ])
  })

  test("RegExp.escape rejects non-string inputs", async () => {
    expect(
      await value(`
        const rejects = (input) => {
          try {
            RegExp.escape(input)
            return false
          } catch (error) {
            return error.name === "TypeError"
          }
        }
        return [rejects(123), rejects({}), rejects([]), rejects(null), rejects(undefined)]
      `),
    ).toEqual([true, true, true, true, true])
  })

  test("RegExp.escape preserves ordinary ASCII and Unicode code points", async () => {
    expect(
      await value(`
        return [
          RegExp.escape(""),
          RegExp.escape(".a1b2c3D4E5F6"),
          RegExp.escape("_a_1_2"),
          RegExp.escape("hello_world"),
          RegExp.escape("//"),
          RegExp.escape("\\u4F60\\u597D"),
          RegExp.escape("\\u0393\\u03B5\\u03B9\\u03AC \\u03C3\\u03BF\\u03C5"),
          RegExp.escape("\\uD835\\uDC01"),
        ]
      `),
    ).toEqual([
      "",
      "\\.a1b2c3D4E5F6",
      "_a_1_2",
      "\\x68ello_world",
      "\\/\\/",
      "\u4f60\u597d",
      "\u0393\u03b5\u03b9\u03ac\\x20\u03c3\u03bf\u03c5",
      "\uD835\uDC01",
    ])
  })

  test("d flag exposes match indices through exec, match, and matchAll", async () => {
    expect(
      await value(`
        const match = /(?<a>a)(b)?/d.exec("a")
        const stringMatch = "a".match(/a/d)
        const all = "a a".matchAll(/a/dg)
        const named = /(?<constructor>a)(?<safe>b)/d.exec("ab")
        return [
          /./.hasIndices,
          /./d.hasIndices,
          new RegExp(".", "d").hasIndices,
          match.indices[0],
          match.indices[1],
          match.indices[2],
          match.indices.groups.a,
          stringMatch.indices[0],
          all[0].indices[0],
          all[1].indices[0],
          Object.keys(named.indices.groups),
        ]
      `),
    ).toEqual([false, true, true, [0, 1], [0, 1], null, [0, 1], [0, 1], [0, 1], [2, 3], ["constructor", "safe"]])
  })

  test("match indices preserve captures, Unicode offsets, and groups properties", async () => {
    expect(
      await value(`
        const plain = /a/.exec("a")
        const captured = "abcd".match(/b(c)/d)
        const unmatched = "bab".match(/(\\w\\w)(\\W)?/d)
        const nonUnicode = "\\uD835\\uDC01".match(/./d)
        const unicode = "\\uD835\\uDC01".match(/./du)
        const noGroups = /./d.exec("a").indices
        return [
          Object.hasOwn(plain, "indices"),
          captured.indices,
          unmatched.indices,
          nonUnicode.indices[0],
          unicode.indices[0],
          Object.hasOwn(noGroups, "groups"),
          noGroups.groups,
        ]
      `),
    ).toEqual([
      false,
      [
        [1, 3],
        [2, 3],
      ],
      [[0, 2], [0, 2], null],
      [0, 1],
      [0, 2],
      true,
      null,
    ])
  })

  test("match and matchAll preserve named, unmatched, and prototype-named index groups", async () => {
    expect(
      await value(`
        const matched = "a".match(/(?<a>a)|(?<x>x)/d).indices.groups
        const all = "a x".matchAll(/(?<a>a)|(?<x>x)/dg)
        const namedMatch = "ab".match(/(?<constructor>a)(?<safe>b)/d).indices.groups
        const namedAll = "ab".matchAll(/(?<constructor>a)(?<safe>b)/dg)[0].indices.groups
        return [
          matched.a,
          matched.x,
          all[0].indices.groups.a,
          all[0].indices.groups.x,
          all[1].indices.groups.a,
          all[1].indices.groups.x,
          Object.keys(namedMatch),
          Object.keys(namedAll),
        ]
      `),
    ).toEqual([[0, 1], null, [0, 1], null, null, [2, 3], ["constructor", "safe"], ["constructor", "safe"]])
  })

  test("v flag exposes unicodeSets and remains exclusive with u", async () => {
    expect(
      await value(`
        const pattern = new RegExp("[a&&a]", "v")
        let rejectsUV = false
        try {
          new RegExp(".", "uv")
        } catch (error) {
          rejectsUV = error.name === "SyntaxError"
        }
        return [pattern.unicodeSets, pattern.unicode, pattern.flags, pattern.test("a"), pattern.test("b"), rejectsUV]
      `),
    ).toEqual([true, false, "v", true, false, true])
  })

  test("d and v flags compose", async () => {
    expect(
      await value(`
        const pattern = new RegExp("(?<a>[a&&a])", "dv")
        const match = pattern.exec("a")
        return [pattern.hasIndices, pattern.unicodeSets, pattern.flags, match.indices[0], match.indices.groups.a]
      `),
    ).toEqual([true, true, "dv", [0, 1], [0, 1]])
  })
})

describe("Math.sumPrecise Test262 parity", () => {
  test("performs maximally precise summation over supported iterables", async () => {
    expect(
      await value(`
        return [
          Math.sumPrecise([1, 2, 3]),
          Math.sumPrecise([1e30, 0.1, -1e30]),
          Math.sumPrecise([1e308, 1e308, 0.1, 0.1, 1e30, 0.1, -1e30, -1e308, -1e308]),
          Math.sumPrecise([8.98846567431158e307, 8.988465674311579e307, -1.7976931348623157e308]),
          Math.sumPrecise(new Set([1, 2])),
          [[1, 2], [3, 4]].map(Math.sumPrecise),
          Object.is(Math.sumPrecise([]), -0),
          Object.is(Math.sumPrecise([-0, -0]), -0),
          Object.is(Math.sumPrecise([-0, 0]), 0),
        ]
      `),
    ).toEqual([6, 0.1, 0.30000000000000004, 9.9792015476736e291, 3, [3, 7], true, true, true])
  })

  test("handles infinities and NaN", async () => {
    expect(
      await value(`
        return [
          Math.sumPrecise([Infinity, Infinity]) === Infinity,
          Math.sumPrecise([-Infinity, -Infinity]) === -Infinity,
          Number.isNaN(Math.sumPrecise([NaN])),
          Number.isNaN(Math.sumPrecise([Infinity, -Infinity])),
        ]
      `),
    ).toEqual([true, true, true, true])
  })

  test("rejects missing, non-iterable, sparse, and non-number inputs", async () => {
    expect(
      await value(`
        const rejects = (input, missing = false) => {
          try {
            if (missing) Math.sumPrecise()
            else Math.sumPrecise(input)
            return false
          } catch (error) {
            return error.name === "TypeError"
          }
        }
        return [
          rejects(undefined, true),
          rejects({}),
          rejects(["1"]),
          rejects(Array(1)),
          rejects("12"),
          rejects(new Map([[1, 2]])),
          rejects(new URLSearchParams("a=1")),
        ]
      `),
    ).toEqual([true, true, true, true, true, true, true])
  })
})
