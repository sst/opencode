/**
 * Portions adapted from Test262 at revision 250f204f23a9249ff204be2baec29600faae7b75:
 * - test/language/statements/variable/S12.2_A1.js
 * - test/language/statements/variable/S12.2_A3.js
 * - test/language/statements/variable/S12.2_A6_T1.js
 * - test/language/statements/variable/S12.2_A7.js
 * - test/language/statements/variable/S12.2_A10.js
 * - test/language/statements/variable/S12.2_A12.js
 * - test/language/block-scope/shadowing/hoisting-var-declarations-out-of-blocks.js
 * - test/language/block-scope/shadowing/catch-parameter-shadowing-var-variable.js
 * - test/language/statements/for/head-var-bound-names-in-stmt.js
 * - test/language/statements/function/scope-paramsbody-var-open.js
 * - test/language/statements/function/scope-paramsbody-var-close.js
 *
 * Copyright 2009 the Sputnik authors. All rights reserved.
 * Copyright (C) 2011, 2016 the V8 project authors. All rights reserved.
 * Test262 portions are governed by the BSD license in LICENSE.test262.
 *
 * Files that observe `var` through `eval`, `this`, `delete`, or the global object (S12.2_A2, A5, A9,
 * A11, `scope-*-none.js`, `scope-param-elem-*.js`) have no analogue here and are not ported.
 */
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { CodeMode } from "../src/index.js"

const value = async (code: string) => {
  const result = await Effect.runPromise(CodeMode.execute({ code, tools: {} }))
  if (!result.ok) throw new Error(`expected success, got ${result.error.kind}: ${result.error.message}`)
  return result.value
}

describe("var hoisting Test262 parity", () => {
  test("test/language/statements/variable/S12.2_A1.js: use before declaration reads undefined", async () => {
    expect(
      await value(`
        __x = __x
        __y = __x ? "good fellow" : "liar"
        __z = __z === __x ? 1 : 0
        let unknown
        try { __something__undefined = __something__undefined } catch (error) { unknown = error.name }
        const before = [__y, __z, unknown]
        var __x, __y = true, __z = __y ? "smeagol" : "golum"
        return [...before, __y, __z]
      `),
    ).toEqual(["liar", 1, "ReferenceError", true, "smeagol"])
  })

  test("test/language/statements/variable/S12.2_A3.js: nested functions redeclare or assign", async () => {
    expect(
      await value(`
        var __var = "OUT"
        const inner = (function () {
          var __var = "IN"
          ;(function () { __var = "INNER_SPACE" })()
          ;(function () { var __var = "INNER_SUN" })()
          return __var
        })()
        const after = __var
        const assigned = (function () {
          __var = "IN"
          ;(function () { __var = "INNERED" })()
          ;(function () { var __var = "INNAGER" })()
          return __var
        })()
        return [inner, after, assigned, __var]
      `),
    ).toEqual(["INNER_SPACE", "OUT", "INNERED", "INNERED"])
  })

  test("test/language/statements/variable/S12.2_A6_T1.js: var inside try and catch is hoisted", async () => {
    expect(
      await value(`
        intry__var = intry__var
        incatch__var = incatch__var
        try { var intry__var } catch (e) { var incatch__var }
        return [typeof intry__var, typeof incatch__var]
      `),
    ).toEqual(["undefined", "undefined"])
  })

  test("test/language/statements/variable/S12.2_A7.js: var after break inside for is hoisted", async () => {
    expect(
      await value(`
        infor_var = infor_var
        for (;;) { break; var infor_var }
        return typeof infor_var
      `),
    ).toBe("undefined")
  })

  test("test/language/statements/variable/S12.2_A10.js: var in for head is hoisted", async () => {
    expect(
      await value(`
        __ind = __ind
        for (var __ind; ; ) { break }
        return typeof __ind
      `),
    ).toBe("undefined")
  })

  test("test/language/statements/variable/S12.2_A12.js: var in do-while body is hoisted", async () => {
    expect(
      await value(`
        x = x
        do var x; while (false)
        return typeof x
      `),
    ).toBe("undefined")
  })

  test("test/language/block-scope/shadowing/hoisting-var-declarations-out-of-blocks.js", async () => {
    expect(
      await value(`
        function fn() {
          { var x = 1; var y }
          return [x, typeof y]
        }
        return fn()
      `),
    ).toEqual([1, "undefined"])
  })

  test("test/language/block-scope/shadowing/catch-parameter-shadowing-var-variable.js", async () => {
    expect(
      await value(`
        function fn() {
          var a = 1
          let caught
          try { throw "stuff3" } catch (a) { caught = a }
          return [caught, a]
        }
        return fn()
      `),
    ).toEqual(["stuff3", 1])
  })

  test("test/language/statements/for/head-var-bound-names-in-stmt.js: redeclaring the head var in the body", async () => {
    expect(
      await value(`
        var iterCount = 0
        var first = true
        for (var x; first; first = false) {
          var x
          iterCount += 1
        }
        return iterCount
      `),
    ).toBe(1)
  })

  test("test/language/statements/function/scope-paramsbody-var-open.js: parameter defaults see the outer var", async () => {
    expect(
      await value(`
        var x = "outside"
        var probeParams, probeBody
        function f(_ = probeParams = function () { return x }) {
          var x = "inside"
          probeBody = function () { return x }
        }
        f()
        return [probeParams(), probeBody()]
      `),
    ).toEqual(["outside", "inside"])
  })

  test("test/language/statements/function/scope-paramsbody-var-close.js: body var does not leak out", async () => {
    expect(
      await value(`
        var probe
        function f(_ = null) {
          var x = "inside"
          probe = function () { return x }
        }
        f()
        var x = "outside"
        return [probe(), x]
      `),
    ).toEqual(["inside", "outside"])
  })
})

describe("var semantics beyond Test262", () => {
  test("redeclaration and block-level var assign the one function-scoped binding", async () => {
    expect(await value(`var a = 1; var a = 2; { var a = 3 } return a`)).toBe(3)
    expect(await value(`var q = 1; { let q = 2 } return q`)).toBe(1)
  })

  test("var loop counters are shared by closures, let counters are not", async () => {
    expect(
      await value(`
        const byVar = []
        for (var i = 0; i < 3; i++) byVar.push(() => i)
        const byLet = []
        for (let j = 0; j < 3; j++) byLet.push(() => j)
        return [byVar.map((f) => f()), byLet.map((f) => f())]
      `),
    ).toEqual([
      [3, 3, 3],
      [0, 1, 2],
    ])
  })

  test("for...in and for...of var heads survive the loop", async () => {
    expect(await value(`for (var k in { a: 1 }) {} for (var [p, q] of [[1, 2]]) {} return [k, p, q]`)).toEqual([
      "a",
      1,
      2,
    ])
  })

  test("var and function declarations of the same name share a binding", async () => {
    expect(await value(`var fn = 1; function fn() {} return typeof fn`)).toBe("number")
    expect(await value(`function fn() {} var fn; return typeof fn`)).toBe("function")
    expect(await value(`function h() { var fn = 1; function fn() {} return typeof fn } return h()`)).toBe("number")
  })

  test("a var named after a parameter keeps the argument until assigned", async () => {
    expect(await value(`function f(a) { var a; return a } return f(7)`)).toBe(7)
    expect(await value(`function f(a) { var a = 2; return a } return f(7)`)).toBe(2)
  })

  test("var does not hoist across function boundaries", async () => {
    expect(await value(`return [typeof b, (() => { var b = 1; return b })()]; var b`)).toEqual(["undefined", 1])
    expect(
      await value(
        `function outer() { var o = 1; function inner() { var o = 2; return o } return [inner(), o] } return outer()`,
      ),
    ).toEqual([2, 1])
  })

  test("switch cases, labels, and generators hoist var", async () => {
    expect(await value(`switch (1) { case 1: var s = 9 } label: { var lb = 1 } return [s, lb]`)).toEqual([9, 1])
    expect(await value(`function* gen() { var t = 1; yield t; var t = 2; yield t } return [...gen()]`)).toEqual([1, 2])
  })
})

describe("switch case function hoisting", () => {
  test("function declarations are visible across all cases before their statement runs", async () => {
    expect(await value(`switch (1) { case 1: return foo(); function foo() { return "hoisted" } }`)).toBe("hoisted")
    expect(await value(`switch (2) { case 1: function foo() { return "a" } break; case 2: return foo() }`)).toBe("a")
  })
})
