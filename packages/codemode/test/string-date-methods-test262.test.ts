/**
 * Portions adapted from Test262 at revision 250f204f23a9249ff204be2baec29600faae7b75:
 * - test/annexB/built-ins/String/prototype/substr/length-falsey.js
 * - test/annexB/built-ins/String/prototype/substr/length-negative.js
 * - test/annexB/built-ins/String/prototype/substr/length-positive.js
 * - test/annexB/built-ins/String/prototype/substr/length-undef.js
 * - test/annexB/built-ins/String/prototype/substr/start-negative.js
 * - test/annexB/built-ins/String/prototype/substr/surrogate-pairs.js
 * - test/built-ins/String/prototype/isWellFormed/returns-boolean.js
 * - test/built-ins/String/prototype/toWellFormed/returns-well-formed-string.js
 * - test/built-ins/Date/prototype/toDateString/format.js
 * - test/built-ins/Date/prototype/toDateString/invalid-date.js
 * - test/built-ins/Date/prototype/toDateString/negative-year.js
 * - test/built-ins/Date/prototype/toTimeString/format.js
 * - test/built-ins/Date/prototype/toTimeString/invalid-date.js
 *
 * Copyright (C) 2016, 2017 the V8 project authors. All rights reserved.
 * Copyright (C) 2018 Richard Gibson. All rights reserved.
 * Copyright (C) 2022 Jordan Harband. All rights reserved.
 * Test262 portions are governed by the BSD license in LICENSE.test262.
 *
 * The `typeof String.prototype.method` checks are replaced with `typeof "".method` because
 * CodeMode has no prototype objects.
 */
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { CodeMode } from "../src/index.js"

const value = async (code: string) => {
  const result = await Effect.runPromise(CodeMode.execute({ code, tools: {} }))
  if (!result.ok) throw new Error(`expected success, got ${result.error.kind}: ${result.error.message}`)
  return result.value
}

describe("String.prototype.substr Test262 parity", () => {
  test("test/annexB/built-ins/String/prototype/substr/length-falsey.js", async () => {
    expect(
      await value(`
        return [false, NaN, "", null].flatMap((length) => [0, 1, 2, 3].map((start) => "abc".substr(start, length)))
      `),
    ).toEqual(Array(16).fill(""))
  })

  test("test/annexB/built-ins/String/prototype/substr/length-negative.js", async () => {
    expect(
      await value(`
        return [0, 1, 2, 3].flatMap((start) => [-1, -2, -3, -4].map((length) => "abc".substr(start, length)))
      `),
    ).toEqual(Array(16).fill(""))
  })

  test("test/annexB/built-ins/String/prototype/substr/length-positive.js", async () => {
    expect(
      await value(`
        return [0, 1, 2, 3].map((start) => [1, 2, 3, 4].map((length) => "abc".substr(start, length)))
      `),
    ).toEqual([
      ["a", "ab", "abc", "abc"],
      ["b", "bc", "bc", "bc"],
      ["c", "c", "c", "c"],
      ["", "", "", ""],
    ])
  })

  test("test/annexB/built-ins/String/prototype/substr/length-undef.js", async () => {
    expect(
      await value(`
        return [
          "abc".substr(0), "abc".substr(1), "abc".substr(2), "abc".substr(3),
          "abc".substr(0, undefined), "abc".substr(1, undefined), "abc".substr(2, undefined), "abc".substr(3, undefined),
        ]
      `),
    ).toEqual(["abc", "bc", "c", "", "abc", "bc", "c", ""])
  })

  test("test/annexB/built-ins/String/prototype/substr/start-negative.js", async () => {
    expect(
      await value(`
        return ["abc".substr(-1), "abc".substr(-2), "abc".substr(-3), "abc".substr(-4), "abc".substr(-1.1)]
      `),
    ).toEqual(["c", "bc", "abc", "abc", "c"])
  })

  test("test/annexB/built-ins/String/prototype/substr/surrogate-pairs.js", async () => {
    expect(
      await value(`
        const pair = "\\ud834\\udf06"
        return [pair.substr(0), pair.substr(1), pair.substr(2), pair.substr(0, 0), pair.substr(0, 1), pair.substr(0, 2)]
      `),
    ).toEqual(["\ud834\udf06", "\udf06", "", "", "\ud834", "\ud834\udf06"])
  })
})

describe("String well-formedness Test262 parity", () => {
  test("test/built-ins/String/prototype/isWellFormed/returns-boolean.js", async () => {
    expect(
      await value(`
        const leadingPoo = "\\uD83D"
        const trailingPoo = "\\uDCA9"
        const wholePoo = leadingPoo + trailingPoo
        return [
          typeof "".isWellFormed,
          ("a" + leadingPoo + "c" + leadingPoo + "e").isWellFormed(),
          ("a" + trailingPoo + "c" + trailingPoo + "e").isWellFormed(),
          ("a" + trailingPoo + leadingPoo + "d").isWellFormed(),
          "a💩c".isWellFormed(),
          "a\\uD83D\\uDCA9c".isWellFormed(),
          ("a" + leadingPoo + trailingPoo + "d").isWellFormed(),
          wholePoo.slice(0, 1).isWellFormed(),
          wholePoo.slice(1).isWellFormed(),
          "abc".isWellFormed(),
          "a\\u25A8c".isWellFormed(),
        ]
      `),
    ).toEqual(["function", false, false, false, true, true, true, false, false, true, true])
  })

  test("test/built-ins/String/prototype/toWellFormed/returns-well-formed-string.js", async () => {
    expect(
      await value(`
        const replacementChar = "\\uFFFD"
        const leadingPoo = "\\uD83D"
        const trailingPoo = "\\uDCA9"
        const wholePoo = leadingPoo + trailingPoo
        return [
          typeof "".toWellFormed,
          ("a" + leadingPoo + "c" + leadingPoo + "e").toWellFormed() === "a" + replacementChar + "c" + replacementChar + "e",
          ("a" + trailingPoo + "c" + trailingPoo + "e").toWellFormed() === "a" + replacementChar + "c" + replacementChar + "e",
          ("a" + trailingPoo + leadingPoo + "d").toWellFormed() === "a" + replacementChar + replacementChar + "d",
          "a💩c".toWellFormed() === "a💩c",
          "a\\uD83D\\uDCA9c".toWellFormed() === "a\\uD83D\\uDCA9c",
          ("a" + leadingPoo + trailingPoo + "d").toWellFormed() === "a" + wholePoo + "d",
          wholePoo.slice(0, 1).toWellFormed() === replacementChar,
          wholePoo.slice(1).toWellFormed() === replacementChar,
          "abc".toWellFormed() === "abc",
          "a\\u25A8c".toWellFormed() === "a\\u25A8c",
        ]
      `),
    ).toEqual(["function", true, true, true, true, true, true, true, true, true, true])
  })
})

describe("Date string formatting Test262 parity", () => {
  test("test/built-ins/Date/prototype/toDateString/format.js", async () => {
    expect(
      await value(`
        const dateRegExp = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) [0-9]{2} [0-9]{4}$/
        return [dateRegExp.test(new Date(0).toDateString()), dateRegExp.test(new Date("0020-01-01T00:00:00Z").toDateString())]
      `),
    ).toEqual([true, true])
  })

  test("test/built-ins/Date/prototype/toDateString/invalid-date.js", async () => {
    expect(await value(`return new Date(NaN).toDateString()`)).toBe("Invalid Date")
  })

  test("test/built-ins/Date/prototype/toDateString/negative-year.js", async () => {
    expect(
      await value(`
        return ["-000001", "-000012", "-000123", "-001234", "-012345", "-123456"].map(
          (year) => new Date(year + "-07-01T00:00Z").toDateString().split(" ")[3],
        )
      `),
    ).toEqual(["-0001", "-0012", "-0123", "-1234", "-12345", "-123456"])
  })

  test("test/built-ins/Date/prototype/toTimeString/format.js", async () => {
    expect(
      await value(`
        const timeRegExp = /^[0-9]{2}:[0-9]{2}:[0-9]{2} GMT[+-][0-9]{4}( \\(.+\\))?$/
        return timeRegExp.test(new Date(0).toTimeString())
      `),
    ).toBe(true)
  })

  test("test/built-ins/Date/prototype/toTimeString/invalid-date.js", async () => {
    expect(await value(`return new Date(NaN).toTimeString()`)).toBe("Invalid Date")
  })
})
