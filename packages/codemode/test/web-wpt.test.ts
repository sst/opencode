/**
 * Portions adapted from web-platform-tests at revision 863077959ca8c1a7ceecfbe2534b75d2527b9013:
 * - html/webappapis/atob/base64.any.js (btoa reference encoder, input list, and atob WebIDL cases)
 * - fetch/data-urls/resources/base64.json (copied to fixtures/wpt-base64.json)
 * - WebCryptoAPI/randomUUID.https.any.js
 *
 * Copyright © web-platform-tests contributors. Governed by the 3-Clause BSD license in LICENSE.wpt.
 *
 * `assert_throws_dom("InvalidCharacterError", …)` becomes a check for a TypeError: CodeMode has no DOMException.
 */
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { CodeMode } from "../src/index.js"

const base64Cases = (await Bun.file(new URL("./fixtures/wpt-base64.json", import.meta.url)).json()) as Array<
  [string, Array<number> | null]
>

const value = async (code: string) => {
  const result = await Effect.runPromise(CodeMode.execute({ code, tools: {} }))
  if (!result.ok) throw new Error(`expected success, got ${result.error.kind}: ${result.error.message}`)
  return result.value
}

// The reference encoder from base64.any.js, run inside the interpreter so btoa is checked against
// an independent implementation rather than against the host's btoa.
const referenceEncoder = `
  function btoaLookup(idx) {
    if (idx < 26) return String.fromCharCode(idx + "A".charCodeAt(0))
    if (idx < 52) return String.fromCharCode(idx - 26 + "a".charCodeAt(0))
    if (idx < 62) return String.fromCharCode(idx - 52 + "0".charCodeAt(0))
    if (idx == 62) return "+"
    if (idx == 63) return "/"
  }
  function mybtoa(s) {
    s = String(s)
    for (var i = 0; i < s.length; i++) if (s.charCodeAt(i) > 255) return "INVALID_CHARACTER_ERR"
    var out = ""
    for (var i = 0; i < s.length; i += 3) {
      var groupsOfSix = [undefined, undefined, undefined, undefined]
      groupsOfSix[0] = s.charCodeAt(i) >> 2
      groupsOfSix[1] = (s.charCodeAt(i) & 0x03) << 4
      if (s.length > i + 1) {
        groupsOfSix[1] |= s.charCodeAt(i + 1) >> 4
        groupsOfSix[2] = (s.charCodeAt(i + 1) & 0x0f) << 2
      }
      if (s.length > i + 2) {
        groupsOfSix[2] |= s.charCodeAt(i + 2) >> 6
        groupsOfSix[3] = s.charCodeAt(i + 2) & 0x3f
      }
      for (var j = 0; j < groupsOfSix.length; j++) {
        out += typeof groupsOfSix[j] == "undefined" ? "=" : btoaLookup(groupsOfSix[j])
      }
    }
    return out
  }
  function testBtoa(input) {
    var expected = mybtoa(input)
    if (expected === "INVALID_CHARACTER_ERR") {
      try { btoa(input) } catch (error) { return error instanceof TypeError ? "ok" : error.name }
      return "did not throw"
    }
    if (btoa(input) !== expected) return "btoa mismatch"
    if (atob(btoa(input)) !== String(input)) return "roundtrip mismatch"
    return "ok"
  }
`

describe("btoa WPT parity (html/webappapis/atob/base64.any.js)", () => {
  test("every input encodes like the reference encoder and round-trips through atob", async () => {
    expect(
      await value(`
        ${referenceEncoder}
        var tests = ["עברית", "", "ab", "abc", "abcd", "abcde", "\\xff\\xff\\xc0", "\\0a", "a\\0b",
          undefined, null, 7, 12, 1.5, true, false, NaN, +Infinity, -Infinity, 0, -0]
        for (var i = 0; i < 258; i++) tests.push(String.fromCharCode(i))
        tests.push(String.fromCharCode(10000), String.fromCharCode(65534), String.fromCharCode(65535))
        tests.push(String.fromCharCode(0xd800, 0xdc00))
        var everything = ""
        for (var i = 0; i < 256; i++) everything += String.fromCharCode(i)
        tests.push(everything)
        return tests.map(testBtoa).filter((outcome) => outcome !== "ok")
      `),
    ).toEqual([])
  })
})

describe("atob WPT parity (fetch/data-urls/resources/base64.json)", () => {
  const idlCases: Array<[unknown, Array<number> | null]> = [
    [undefined, null],
    [null, [158, 233, 101]],
    [7, null],
    [12, [215]],
    [1.5, null],
    [true, [182, 187]],
    [false, null],
    [NaN, [53, 163]],
    [Infinity, [34, 119, 226, 158, 43, 114]],
    [-Infinity, null],
    [0, null],
    [-0, null],
  ]

  test(`${base64Cases.length} forgiving-base64 inputs decode to the expected bytes or throw a TypeError`, async () => {
    expect(
      await value(`
        const cases = ${JSON.stringify(base64Cases)}
        return cases.flatMap(([input, output]) => {
          try {
            const result = atob(input)
            if (output === null) return [[input, "expected throw"]]
            const bytes = Array.from({ length: result.length }, (_, i) => result.charCodeAt(i))
            return JSON.stringify(bytes) === JSON.stringify(output) ? [] : [[input, bytes]]
          } catch (error) {
            return output === null && error instanceof TypeError ? [] : [[input, error.name]]
          }
        })
      `),
    ).toEqual([])
  })

  test("WebIDL argument conversion stringifies non-string inputs", async () => {
    const literal = (input: unknown) =>
      Object.is(input, -0)
        ? "-0"
        : typeof input === "number" || input === undefined
          ? String(input)
          : JSON.stringify(input)
    expect(
      await value(`
        const cases = [${idlCases.map(([input, output]) => `[${literal(input)}, ${JSON.stringify(output)}]`).join(",")}]
        return cases.flatMap(([input, output]) => {
          try {
            const result = atob(input)
            if (output === null) return [[String(input), "expected throw"]]
            // The source loop checks only the listed prefix of the decoded bytes.
            const bytes = output.map((_, i) => result.charCodeAt(i))
            return JSON.stringify(bytes) === JSON.stringify(output) ? [] : [[String(input), bytes]]
          } catch (error) {
            return output === null && error instanceof TypeError ? [] : [[String(input), error.name]]
          }
        })
      `),
    ).toEqual([])
  })
})

describe("crypto.randomUUID WPT parity (WebCryptoAPI/randomUUID.https.any.js)", () => {
  test("namespace format, version, and variant bits over 256 iterations without collision", async () => {
    expect(
      await value(`
        const uuids = new Set()
        const randomUUID = () => {
          const uuid = crypto.randomUUID()
          if (uuids.has(uuid)) throw new Error("uuid collision " + uuid)
          uuids.add(uuid)
          return uuid
        }
        const UUIDRegex = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
        let format = true, version = true, variant = true
        for (let i = 0; i < 256; i++) format = format && UUIDRegex.test(randomUUID())
        for (let i = 0; i < 256; i++) version = version && (parseInt(randomUUID().split("-")[2].slice(0, 2), 16) & 0b11110000) === 0b01000000
        for (let i = 0; i < 256; i++) variant = variant && (parseInt(randomUUID().split("-")[3].slice(0, 2), 16) & 0b11000000) === 0b10000000
        return [format, version, variant, uuids.size]
      `),
    ).toEqual([true, true, true, 768])
  })
})
