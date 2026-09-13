/*
 * Portable portions adapted from Test262 at revision
 * 250f204f23a9249ff204be2baec29600faae7b75. Exact source paths are cited
 * beside the corresponding tests below.
 *
 * Copyright (C) 2013-2017 the V8 project authors. All rights reserved.
 * Copyright (C) 2018 Valerie Young. All rights reserved.
 * Copyright (C) 2020 Alexey Shvayka. All rights reserved.
 * Copyright (C) 2022 Kevin Gibbons. All rights reserved.
 * Copyright Ecma International. All rights reserved.
 * Test262 portions are governed by the BSD license in LICENSE.test262.
 */
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { CodeMode } from "../src/index.js"

const execute = (code: string) => Effect.runPromise(CodeMode.execute({ code, tools: {} }))

const value = async (code: string) => {
  const result = await execute(code)
  if (!result.ok) throw new Error(`expected success, got ${result.error.kind}: ${result.error.message}`)
  return result.value
}

describe("confined generators", () => {
  // test/built-ins/GeneratorPrototype/next/return-yield-expr.js
  test("is lazy and preserves next(value), nested suspension, return, and exhaustion", async () => {
    expect(
      await value(`
        const events = []
        function* generate() {
          events.push("start")
          const received = yield 1 + (yield 2)
          return received
        }
        const iterator = generate()
        const before = events.slice()
        const first = iterator.next(99)
        const second = iterator.next(3)
        const third = iterator.next(7)
        const fourth = iterator.next(8)
        return [before, events, first, second, third, fourth]
      `),
    ).toEqual([
      [],
      ["start"],
      { value: 2, done: false },
      { value: 4, done: false },
      { value: 7, done: true },
      { value: null, done: true },
    ])
  })

  test("routes throw and return through catch and finally", async () => {
    expect(
      await value(`
        function* generate() {
          try {
            try { yield "try" } catch (error) { yield "caught " + error }
          } finally {
            yield "finally"
          }
        }
        const iterator = generate()
        return [iterator.next(), iterator.throw("boom"), iterator.return("done"), iterator.next()]
      `),
    ).toEqual([
      { value: "try", done: false },
      { value: "caught boom", done: false },
      { value: "finally", done: false },
      { value: "done", done: true },
    ])
  })

  test("throws into a suspended generator and after exhaustion", async () => {
    expect(
      await value(`
        function* generate() { yield 1 }
        const iterator = generate()
        iterator.next()
        let suspended
        let exhausted
        try { iterator.throw("first") } catch (error) { suspended = error }
        try { iterator.throw("second") } catch (error) { exhausted = error }
        return [suspended, exhausted, iterator.next()]
      `),
    ).toEqual(["first", "second", { value: null, done: true }])
  })

  test("rejects synchronous generator reentry", async () => {
    expect(
      await value(`
        let iterator
        function* generate() {
          try { iterator.next() } catch (error) { return error.name }
        }
        iterator = generate()
        return iterator.next()
      `),
    ).toEqual({ value: "TypeError", done: true })
  })

  test("delegates yield*, forwards next values, and receives the delegate return value", async () => {
    expect(
      await value(`
        function* inner() {
          const input = yield 1
          return input * 2
        }
        function* outer() {
          const result = yield* inner()
          return result + 1
        }
        const iterator = outer()
        return [iterator.next(), iterator.next(4)]
      `),
    ).toEqual([
      { value: 1, done: false },
      { value: 9, done: true },
    ])
  })

  test("delegates throw and return to custom iterators", async () => {
    expect(
      await value(`
        const calls = []
        let step = 0
        const delegate = {
          [Symbol.iterator]: () => delegate,
          next(...args) {
            calls.push(["next", args.length, args[0]])
            step += 1
            return step === 1 ? { value: "one", done: false } : { value: "end", done: true }
          },
          throw(value) {
            calls.push(["throw", value])
            return { value: "recovered", done: false }
          },
          return(value) {
            calls.push(["return", value])
            return { value: value + "!", done: true }
          },
        }
        function* generate() { return yield* delegate }
        const iterator = generate()
        const first = iterator.next()
        const second = iterator.throw("x")
        const third = iterator.return("stop")
        return [first, second, third, calls]
      `),
    ).toEqual([
      { value: "one", done: false },
      { value: "recovered", done: false },
      { value: "stop!", done: true },
      [
        ["next", 1, null],
        ["throw", "x"],
        ["return", "stop"],
      ],
    ])
  })

  test("uses the missing-throw delegation path for built-in iterables", async () => {
    expect(
      await value(`
        function* generate() { yield* [1, 2] }
        const iterator = generate()
        iterator.next()
        try { iterator.throw("boom") } catch (error) { return error.name }
      `),
    ).toBe("TypeError")
  })

  test("exposes only the appropriate iterator symbol and works in for...of", async () => {
    expect(
      await value(`
        function* generate() { yield 1; yield 2 }
        const iterator = generate()
        const symbols = [iterator[Symbol.iterator]() === iterator, iterator[Symbol.asyncIterator]]
        const values = []
        for (const item of iterator) values.push(item)
        return [symbols, values]
      `),
    ).toEqual([
      [true, null],
      [1, 2],
    ])
  })

  test("accepts generator methods as iterator acquisition results", async () => {
    expect(
      await value(`
        const sync = {
          *[Symbol.iterator]() { yield 1; yield 2 },
        }
        const asynchronous = {
          async *[Symbol.asyncIterator]() { yield 3; yield 4 },
        }
        const values = []
        for (const item of sync) values.push(item)
        for await (const item of asynchronous) values.push(item)
        return values
      `),
    ).toEqual([1, 2, 3, 4])
  })

  test("closes a generator when for...of exits abruptly", async () => {
    expect(
      await value(`
        const events = []
        function* generate() {
          try { yield 1; yield 2 } finally { events.push("closed") }
        }
        for (const item of generate()) break
        return events
      `),
    ).toEqual(["closed"])
  })

  test("async generator requests are promises and execute in request order", async () => {
    expect(
      await value(`
        const events = []
        async function* generate() {
          events.push("start")
          const input = yield Promise.resolve(1)
          events.push("received " + input)
          return Promise.resolve(3)
        }
        const iterator = generate()
        const first = iterator.next()
        const second = iterator.next(2)
        const third = iterator.next(4)
        const promiseFlags = [first instanceof Promise, second instanceof Promise, third instanceof Promise]
        return [promiseFlags, await Promise.all([first, second, third]), events]
      `),
    ).toEqual([
      [true, true, true],
      [
        { value: 1, done: false },
        { value: 3, done: true },
        { value: null, done: true },
      ],
      ["start", "received 2"],
    ])
  })

  test("keeps requests queued while a completed generator adopts return values", async () => {
    expect(
      await value(`
        const events = []
        let resolve
        const pending = new Promise((done) => { resolve = done })
        async function* generate() { return 1 }
        const iterator = generate()
        const first = iterator.next()
        const returned = iterator.return(pending)
        const later = first.then(() => iterator.next()).then(() => events.push("later"))
        returned.then(() => events.push("returned"))
        await first
        await Promise.resolve()
        const before = events.slice()
        resolve(9)
        await Promise.all([returned, later])
        return [before, events]
      `),
    ).toEqual([[], ["returned", "later"]])
  })

  test("serializes requests made after async generator exhaustion", async () => {
    expect(
      await value(`
        const events = []
        let resolve
        const pending = new Promise((done) => { resolve = done })
        async function* generate() { return 1 }
        const iterator = generate()
        await iterator.next()
        const returned = iterator.return(pending).then(() => events.push("returned"))
        const later = iterator.next().then(() => events.push("later"))
        await Promise.resolve()
        const before = events.slice()
        resolve(9)
        await Promise.all([returned, later])
        return [before, events]
      `),
    ).toEqual([[], ["returned", "later"]])
  })

  test("async generators adopt yielded, returned, and return-request promises", async () => {
    expect(
      await value(`
        async function* yielded() { yield Promise.resolve(1) }
        async function* returned() { return Promise.resolve(2) }
        async function* pending() { yield 0 }
        const first = yielded()
        const second = returned()
        const third = pending()
        const exhausted = returned()
        await third.next()
        await exhausted.next()
        return await Promise.all([
          first.next(),
          second.next(),
          third.return(Promise.resolve(3)),
          exhausted.return(Promise.resolve(4)),
        ])
      `),
    ).toEqual([
      { value: 1, done: false },
      { value: 2, done: true },
      { value: 3, done: true },
      { value: 4, done: true },
    ])
  })

  test("awaits return-request promises before injecting completion", async () => {
    expect(
      await value(`
        const events = []
        async function* generate() {
          try {
            yield 1
          } catch (error) {
            events.push("caught " + error)
            yield "recovered"
          } finally {
            events.push("finally")
          }
        }
        const iterator = generate()
        const first = await iterator.next()
        const returned = await iterator.return(Promise.reject("bad"))
        const beforeNext = events.slice()
        const last = await iterator.next()
        return [first, returned, beforeNext, last, events]
      `),
    ).toEqual([
      { value: 1, done: false },
      { value: "recovered", done: false },
      ["caught bad"],
      { value: null, done: true },
      ["caught bad", "finally"],
    ])
  })

  test("loop consumers call iterator next with no arguments", async () => {
    expect(
      await value(`
        const calls = []
        let syncStep = 0
        const sync = {
          [Symbol.iterator]: () => sync,
          next(...args) {
            calls.push(["sync", args.length])
            syncStep += 1
            return { value: syncStep, done: syncStep > 1 }
          },
        }
        let asyncStep = 0
        const asynchronous = {
          [Symbol.asyncIterator]: () => asynchronous,
          async next(...args) {
            calls.push(["async", args.length])
            asyncStep += 1
            return { value: asyncStep, done: asyncStep > 1 }
          },
        }
        for (const item of sync) {}
        for await (const item of asynchronous) {}
        return calls
      `),
    ).toEqual([
      ["sync", 0],
      ["sync", 0],
      ["async", 0],
      ["async", 0],
    ])
  })

  test("supports async generators in for await...of and keeps them out of for...of", async () => {
    expect(
      await value(`
        async function* generate() { yield 1; yield await Promise.resolve(2) }
        const values = []
        for await (const item of generate()) values.push(item)
        let name
        try { for (const item of generate()) {} } catch (error) { name = error.name }
        return [values, name]
      `),
    ).toEqual([[1, 2], "TypeError"])
  })

  test("keeps generator references opaque at the data boundary", async () => {
    const result = await execute(`function* generate() { yield 1 } return generate()`)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe("InvalidDataValue")
  })

  // test/built-ins/GeneratorPrototype/return/from-state-suspended-start.js
  // test/built-ins/GeneratorPrototype/throw/from-state-suspended-start.js
  // test/built-ins/GeneratorPrototype/return/from-state-completed.js
  // test/built-ins/GeneratorPrototype/throw/from-state-completed.js
  test("honors sync return and throw in suspended-start and completed states", async () => {
    expect(
      await value(`
        const events = []
        function* generate() { events.push("body"); yield 1 }

        const returned = generate()
        const startReturn = returned.return(7)
        const afterReturn = returned.next()

        const thrown = generate()
        let startThrow
        try { thrown.throw("start") } catch (error) { startThrow = error }
        const afterThrow = thrown.next()
        let completedThrow
        try { thrown.throw("completed") } catch (error) { completedThrow = error }

        return [startReturn, afterReturn, startThrow, afterThrow, completedThrow, events]
      `),
    ).toEqual([
      { value: 7, done: true },
      { value: null, done: true },
      "start",
      { value: null, done: true },
      "completed",
      [],
    ])
  })

  // test/built-ins/AsyncGeneratorPrototype/return/return-suspendedStart-promise.js
  // test/built-ins/AsyncGeneratorPrototype/throw/throw-suspendedStart.js
  // test/built-ins/AsyncGeneratorPrototype/return/return-state-completed.js
  // test/built-ins/AsyncGeneratorPrototype/throw/throw-state-completed.js
  test("honors async return and throw in suspended-start and completed states", async () => {
    expect(
      await value(`
        const events = []
        async function* generate() { events.push("body"); yield 1 }

        const returned = generate()
        const startReturn = await returned.return(Promise.resolve(7))
        const afterReturn = await returned.next()

        const thrown = generate()
        let startThrow
        try { await thrown.throw("start") } catch (error) { startThrow = error }
        const afterThrow = await thrown.next()
        let completedThrow
        try { await thrown.throw("completed") } catch (error) { completedThrow = error }

        return [startReturn, afterReturn, startThrow, afterThrow, completedThrow, events]
      `),
    ).toEqual([
      { value: 7, done: true },
      { value: null, done: true },
      "start",
      { value: null, done: true },
      "completed",
      [],
    ])
  })

  // test/built-ins/AsyncGeneratorPrototype/return/return-suspendedYield-try-finally.js
  // test/built-ins/AsyncGeneratorPrototype/return/return-suspendedYield-try-finally-return.js
  // test/built-ins/AsyncGeneratorPrototype/throw/throw-suspendedYield-try-finally-throw.js
  test("runs finally yields and lets finally completions override requests", async () => {
    expect(
      await value(`
        async function* yielding() {
          try { yield 1 } finally { yield 2 }
        }
        async function* returning() {
          try { yield 1 } finally { return "override" }
        }
        async function* throwing() {
          try { yield 1 } finally { throw "override" }
        }

        const first = yielding()
        await first.next()
        const finallyYield = await first.return("sent")
        const preservedReturn = await first.next()

        const second = returning()
        await second.next()
        const overriddenReturn = await second.return("sent")

        const third = throwing()
        await third.next()
        let overriddenThrow
        try { await third.throw("sent") } catch (error) { overriddenThrow = error }
        return [finallyYield, preservedReturn, overriddenReturn, overriddenThrow]
      `),
    ).toEqual([{ value: 2, done: false }, { value: "sent", done: true }, { value: "override", done: true }, "override"])
  })

  // test/language/statements/async-generator/yield-promise-reject-next-catch.js
  // test/language/statements/async-generator/yield-promise-reject-next-yield-star-sync-iterator.js
  test("rejects yielded promises and closes direct and sync-delegating async generators", async () => {
    expect(
      await value(`
        async function* direct() { yield Promise.reject("direct") }
        async function* delegated() { yield* [Promise.reject("delegated"), "unreachable"] }
        const results = []
        for (const iterator of [direct(), delegated()]) {
          try { await iterator.next() } catch (error) { results.push(error) }
          results.push(await iterator.next())
        }
        return results
      `),
    ).toEqual(["direct", { value: null, done: true }, "delegated", { value: null, done: true }])
  })

  // test/built-ins/AsyncFromSyncIteratorPrototype/next/for-await-iterator-next-rejected-promise-close.js
  // test/built-ins/AsyncFromSyncIteratorPrototype/next/yield-iterator-next-rejected-promise-close.js
  // test/built-ins/AsyncFromSyncIteratorPrototype/throw/iterator-result-rejected-promise-close.js
  test("closes sync iterators when async-from-sync values reject", async () => {
    expect(
      await value(`
        const events = []
        function* loopSource() {
          try { yield Promise.reject("loop") } finally { events.push("loop close") }
        }
        let loopError
        try { for await (const item of loopSource()) {} } catch (error) { loopError = error }

        function* yieldSource() {
          try { yield Promise.reject("yield") } finally { events.push("yield close") }
        }
        async function* delegate() { yield* yieldSource() }
        let yieldError
        try { await delegate().next() } catch (error) { yieldError = error }

        const throwing = {
          [Symbol.iterator]: () => throwing,
          next: () => ({ value: 1, done: false }),
          throw: () => ({ value: Promise.reject("throw"), done: false }),
          return: () => { events.push("throw close"); return {} },
        }
        async function* throwDelegate() { yield* throwing }
        const iterator = throwDelegate()
        await iterator.next()
        let throwError
        try { await iterator.throw("sent") } catch (error) { throwError = error }
        return [loopError, yieldError, throwError, events]
      `),
    ).toEqual(["loop", "yield", "throw", ["loop close", "yield close", "throw close"]])
  })

  test("does not close rejected terminal or delegated return values", async () => {
    expect(
      await value(`
        const events = []
        const terminal = {
          [Symbol.iterator]: () => terminal,
          next: () => ({ value: Promise.reject("terminal"), done: true }),
          return: () => { events.push("terminal close"); return {} },
        }
        let terminalError
        try { for await (const item of terminal) {} } catch (error) { terminalError = error }

        let returnCount = 0
        const returned = {
          [Symbol.iterator]: () => returned,
          next: () => ({ value: 1, done: false }),
          return: () => {
            returnCount += 1
            return { value: Promise.reject("return"), done: false }
          },
        }
        async function* delegate() { yield* returned }
        const iterator = delegate()
        await iterator.next()
        let returnError
        try { await iterator.return("sent") } catch (error) { returnError = error }
        return [terminalError, returnError, returnCount, events]
      `),
    ).toEqual(["terminal", "return", 1, []])
  })

  test("serializes a mixed async next, throw, return, and next request queue", async () => {
    expect(
      await value(`
        async function* generate() {
          try {
            try { yield 1; yield 2 } catch (error) { yield "caught " + error }
          } finally {
            yield "finally"
          }
        }
        const iterator = generate()
        const first = iterator.next()
        const thrown = iterator.throw("x")
        const returned = iterator.return("done")
        const last = iterator.next()
        return await Promise.all([first, thrown, returned, last])
      `),
    ).toEqual([
      { value: 1, done: false },
      { value: "caught x", done: false },
      { value: "finally", done: false },
      { value: "done", done: true },
    ])
  })

  // test/built-ins/AsyncGeneratorPrototype/next/request-queue-order.js
  // test/built-ins/AsyncGeneratorPrototype/throw/request-queue-order-state-executing.js
  // test/built-ins/AsyncGeneratorPrototype/return/request-queue-order-state-executing.js
  test("orders async requests enqueued while generators are executing", async () => {
    expect(
      await value(`
        const events = []
        let returned, returnRequest
        async function* returnWhileExecuting() {
          returnRequest = returned.return(42).then((result) => events.push(["return", result]))
          yield 1
        }
        returned = returnWhileExecuting()
        const firstReturn = returned.next().then((result) => events.push(["first return", result]))
        await Promise.all([firstReturn, returnRequest])

        let thrown, throwRequest
        async function* throwWhileExecuting() {
          throwRequest = thrown.throw("boom").catch((error) => events.push(["throw", error]))
          yield 2
        }
        thrown = throwWhileExecuting()
        const firstThrow = thrown.next().then((result) => events.push(["first throw", result]))
        await Promise.all([firstThrow, throwRequest])

        async function* queued() { yield "first"; yield "second" }
        const iterator = queued()
        const first = iterator.next()
        const second = iterator.next()
        const third = iterator.next()
        await Promise.all([
          third.then(() => events.push("third")),
          second.then(() => events.push("second")),
          first.then(() => events.push("first")),
        ])
        return events
      `),
    ).toEqual([
      ["first return", { value: 1, done: false }],
      ["return", { value: 42, done: true }],
      ["first throw", { value: 2, done: false }],
      ["throw", "boom"],
      "first",
      "second",
      "third",
    ])
  })

  // test/language/statements/async-generator/yield-star-promise-not-unwrapped.js
  // test/language/statements/async-generator/yield-star-sync-next.js
  test("preserves async iterator promise values but unwraps async-from-sync values", async () => {
    expect(
      await value(`
        const asyncValue = Promise.resolve("async")
        const asynchronous = {
          [Symbol.asyncIterator]: () => asynchronous,
          next: () => ({ value: asyncValue, done: false }),
        }
        const syncValue = Promise.resolve("sync")
        const synchronous = {
          [Symbol.iterator]: () => synchronous,
          next: () => ({ value: syncValue, done: false }),
        }
        async function* delegate(value) { yield* value }
        const asyncResult = await delegate(asynchronous).next()
        const syncResult = await delegate(synchronous).next()
        return [asyncResult.value === asyncValue, await asyncResult.value, syncResult]
      `),
    ).toEqual([true, "async", { value: "sync", done: false }])
  })

  test("captures delegated result done before awaiting async-from-sync values", async () => {
    expect(
      await value(`
        const result = { value: Promise.resolve(1), done: false }
        result.value.then(() => { result.done = true })
        const source = {
          [Symbol.iterator]: () => source,
          next: () => result,
        }
        async function* delegate() { yield* source }
        return await delegate().next()
      `),
    ).toEqual({ value: 1, done: false })
  })

  // test/language/statements/async-generator/yield-star-async-next.js
  // test/language/statements/async-generator/yield-star-sync-return.js
  // test/language/statements/async-generator/yield-star-async-throw.js
  test("forwards next, return, and throw through sync and async yield delegates", async () => {
    expect(
      await value(`
        const calls = []
        const make = (symbol, label) => {
          let step = 0
          const iterator = {
            [symbol]: () => iterator,
            next(...args) {
              calls.push([label, "next", args.length, args[0]])
              step += 1
              return { value: step, done: false }
            },
            return(value) {
              calls.push([label, "return", value])
              return { value: value + "!", done: true }
            },
            throw(value) {
              calls.push([label, "throw", value])
              return { value: "caught " + value, done: false }
            },
          }
          return iterator
        }
        async function* delegate(iterator) { return yield* iterator }
        const sync = delegate(make(Symbol.iterator, "sync"))
        const asynchronous = delegate(make(Symbol.asyncIterator, "async"))
        const results = [await sync.next(9), await sync.next(2), await sync.throw("x"), await sync.return("stop")]
        results.push(await asynchronous.next(9), await asynchronous.next(3), await asynchronous.throw("y"))
        return [results, calls]
      `),
    ).toEqual([
      [
        { value: 1, done: false },
        { value: 2, done: false },
        { value: "caught x", done: false },
        { value: "stop!", done: true },
        { value: 1, done: false },
        { value: 2, done: false },
        { value: "caught y", done: false },
      ],
      [
        ["sync", "next", 1, null],
        ["sync", "next", 1, 2],
        ["sync", "throw", "x"],
        ["sync", "return", "stop"],
        ["async", "next", 1, null],
        ["async", "next", 1, 3],
        ["async", "throw", "y"],
      ],
    ])
  })

  // test/language/statements/async-generator/yield-star-sync-return.js
  // test/language/statements/async-generator/yield-star-async-throw.js
  test("continues delegation when return and throw report done false", async () => {
    expect(
      await value(`
        let returns = 0
        const synchronous = {
          [Symbol.iterator]: () => synchronous,
          next: () => ({ value: "next", done: false }),
          return(value) {
            returns += 1
            return { value: returns === 1 ? "return pending" : value, done: returns > 1 }
          },
        }
        let throws = 0
        const asynchronous = {
          [Symbol.asyncIterator]: () => asynchronous,
          next: () => ({ value: "next", done: false }),
          throw(value) {
            throws += 1
            return { value: throws === 1 ? "throw pending" : value, done: throws > 1 }
          },
        }
        async function* delegate(iterator) { return yield* iterator }
        const returned = delegate(synchronous)
        const thrown = delegate(asynchronous)
        return [
          await returned.next(),
          await returned.return("first"),
          await returned.return("second"),
          await thrown.next(),
          await thrown.throw("first"),
          await thrown.throw("second"),
        ]
      `),
    ).toEqual([
      { value: "next", done: false },
      { value: "return pending", done: false },
      { value: "second", done: true },
      { value: "next", done: false },
      { value: "throw pending", done: false },
      { value: "second", done: true },
    ])
  })

  // test/language/expressions/yield/star-rhs-iter-nrml-next-call-non-obj.js
  // test/language/expressions/yield/star-rhs-iter-thrw-thrw-call-non-obj.js
  // test/language/expressions/yield/star-rhs-iter-rtrn-rtrn-call-non-obj.js
  // test/language/statements/async-generator/yield-star-next-not-callable-number-throw.js
  test("rejects malformed yield delegate methods and iterator results", async () => {
    expect(
      await value(`
        const run = (iterator, operation) => {
          function* generate() {
            try { yield* iterator } catch (error) { return error.name }
          }
          const value = generate()
          const first = value.next()
          return operation === "next" ? first : value[operation]()
        }
        const iterable = (fields) => ({ [Symbol.iterator]: () => fields })
        const nextResult = run(iterable({ next: () => 1 }), "next")
        const throwResult = run(iterable({ next: () => ({ done: false }), throw: () => 1 }), "throw")
        const returnResult = run(iterable({ next: () => ({ done: false }), return: () => 1 }), "return")

        const badAsync = {
          [Symbol.asyncIterator]: () => ({ next: 1 }),
        }
        async function* asynchronous() {
          try { yield* badAsync } catch (error) { return error.name }
        }
        return [nextResult, throwResult, returnResult, await asynchronous().next()]
      `),
    ).toEqual([
      { value: "TypeError", done: true },
      { value: "TypeError", done: true },
      { value: "TypeError", done: true },
      { value: "TypeError", done: true },
    ])
  })

  // test/language/expressions/yield/captured-free-vars.js
  // test/language/statements/generators/dflt-params-ref-prior.js
  // test/language/expressions/generators/dflt-params-ref-prior.js
  // test/language/expressions/object/method-definition/generator-no-yield.js
  test("supports declaration, expression, and method forms with closures and parameters", async () => {
    expect(
      await value(`
        const captured = 4
        function* declaration(x, y = x, ...rest) { yield captured + y + rest[0] }
        const expression = function* (x, y = x) { yield captured + y }
        const object = { *method({ value }, extra = 1) { return captured + value + extra } }
        return [declaration(2, undefined, 3).next(), expression(5).next(), object.method({ value: 6 }).next()]
      `),
    ).toEqual([
      { value: 9, done: false },
      { value: 9, done: false },
      { value: 11, done: true },
    ])
  })

  // test/language/expressions/assignment/dstr/array-elem-iter-nrml-close.js
  test("steps holes and rest and closes array binding and assignment patterns early", async () => {
    expect(
      await value(`
        const events = []
        function* binding() {
          try { events.push("b1"); yield 1; events.push("b2"); yield 2; events.push("b3"); yield 3; yield 4 }
          finally { events.push("binding close") }
        }
        const [first, , third] = binding()
        function* assignment() {
          try { yield 5; yield 6; yield 7 }
          finally { events.push("assignment close") }
        }
        let head, rest
        ;[head, ...rest] = assignment()
        return [first, third, head, rest, events]
      `),
    ).toEqual([1, 3, 5, [6, 7], ["b1", "b2", "b3", "binding close", "assignment close"]])
  })

  // test/language/statements/variable/dstr/ary-ptrn-elem-id-init-throws.js
  // test/language/expressions/assignment/dstr/array-elem-iter-thrw-close-err.js
  test("closes on destructuring defaults and preserves the binding error over return failure", async () => {
    expect(
      await value(`
        const events = []
        const iterator = {
          [Symbol.iterator]: () => iterator,
          next: () => ({ value: undefined, done: false }),
          return: () => { events.push("close"); throw "close error" },
        }
        let caught
        try {
          const [value = (() => { throw "binding error" })()] = iterator
        } catch (error) { caught = error }
        return [caught, events]
      `),
    ).toEqual(["binding error", ["close"]])
  })

  test("does not close an exhausted iterator when a destructuring default fails", async () => {
    expect(
      await value(`
        const events = []
        const iterator = {
          [Symbol.iterator]: () => iterator,
          next: () => ({ done: true }),
          return: () => { events.push("close"); return {} },
        }
        try { const [item = (() => { throw "default" })()] = iterator } catch {}
        return events
      `),
    ).toEqual([])
  })

  test("consumes generators in array and argument spread without awaiting yielded promises", async () => {
    expect(
      await value(`
        function* values() { yield 1; yield Promise.resolve(2); yield 3 }
        const array = [...values()]
        const args = ((...items) => items)(...values())
        return [array[0], array[1] instanceof Promise, await array[1], args[2]]
      `),
    ).toEqual([1, true, 2, 3])
  })

  test("constructs Map, Set, and URLSearchParams from generators lazily", async () => {
    expect(
      await value(`
        const events = []
        function* pairs() { events.push(1); yield ["a", 1]; events.push(2); yield ["b", 2] }
        function* values() { yield 1; yield 1; yield 2 }
        const map = new Map(pairs())
        const set = new Set(values())
        const params = new URLSearchParams(pairs())
        return [map.get("b"), [...set], params.toString(), events]
      `),
    ).toEqual([2, [1, 2], "a=1&b=2", [1, 2, 1, 2]])
  })

  test("keeps built-in collection iteration live during callbacks", async () => {
    expect(
      await value(`
        const map = new Map([[1, 1], [2, 2]])
        const mapped = Array.from(map, (entry, index) => {
          if (index === 0) map.set(3, 3)
          return entry[0]
        })
        const set = new Set([1, 2])
        const grouped = Map.groupBy(set, (item, index) => {
          if (index === 0) set.add(3)
          return "items"
        })
        return [mapped, grouped.get("items")]
      `),
    ).toEqual([
      [1, 2, 3],
      [1, 2, 3],
    ])
  })

  test("keeps built-in collection iteration live in loops and yield delegation", async () => {
    expect(
      await value(`
        const map = new Map([[1, 1], [2, 2]])
        const mapValues = []
        for (const [key] of map) {
          mapValues.push(key)
          if (key === 1) map.set(3, 3)
        }
        const set = new Set([1, 2])
        const setValues = []
        for await (const item of set) {
          setValues.push(item)
          if (item === 1) set.add(3)
        }
        const params = new URLSearchParams("a=1&b=2")
        function* delegate() { yield* params }
        const iterator = delegate()
        const first = iterator.next()
        params.append("c", "3")
        return [mapValues, setValues, first, iterator.next(), iterator.next()]
      `),
    ).toEqual([
      [1, 2, 3],
      [1, 2, 3],
      { value: ["a", "1"], done: false },
      { value: ["b", "2"], done: false },
      { value: ["c", "3"], done: false },
    ])
  })

  test("preserves async-from-sync turns for built-in loop completion and close", async () => {
    expect(
      await value(`
        const completed = []
        Promise.resolve().then(() => completed.push("reaction"))
        for await (const item of []) {}
        completed.push("after")

        const closed = []
        for await (const item of [1]) {
          Promise.resolve().then(() => closed.push("reaction"))
          break
        }
        closed.push("after")
        return [completed, closed]
      `),
    ).toEqual([
      ["reaction", "after"],
      ["reaction", "after"],
    ])
  })

  test("reads iterator return only when closing", async () => {
    expect(
      await value(`
        const events = []
        const iterator = {
          [Symbol.iterator]: () => iterator,
          next() {
            iterator.return = () => { events.push("new"); return {} }
            return { value: 1, done: false }
          },
          return: () => { events.push("old"); return {} },
        }
        const [item] = iterator
        return [item, events]
      `),
    ).toEqual([1, ["new"]])
  })

  test("accepts iterable URLSearchParams entry pairs", async () => {
    expect(
      await value(`
        function* pair() { yield "a"; yield 1 }
        function* entries() { yield pair() }
        return new URLSearchParams(entries()).toString()
      `),
    ).toBe("a=1")
  })

  test("converts URLSearchParams pair elements before requesting the next", async () => {
    expect(
      await value(`
        const events = []
        function* pair() {
          try {
            events.push("first")
            yield Promise.resolve(1)
            events.push("second")
            yield 2
          } finally { events.push("pair close") }
        }
        function* entries() {
          try { yield pair() } finally { events.push("outer close") }
        }
        let name
        try { new URLSearchParams(entries()) } catch (error) { name = error.name }
        return [events, name]
      `),
    ).toEqual([["first", "pair close", "outer close"], "Error"])
  })

  test("validates URLSearchParams pair lengths after converting the outer sequence", async () => {
    expect(
      await value(`
        const events = []
        function* entries() {
          try {
            events.push("one")
            yield ["a"]
            events.push("two")
            yield ["b", 2]
          } finally { events.push("outer close") }
        }
        let name
        try { new URLSearchParams(entries()) } catch (error) { name = error.name }
        return [events, name]
      `),
    ).toEqual([["one", "two", "outer close"], "TypeError"])
  })

  test("closes entry constructors when a generator yields a malformed entry", async () => {
    expect(
      await value(`
        const events = []
        function* mapEntries() { try { yield ["a", 1]; yield null } finally { events.push("map close") } }
        function* parameterEntries() { try { yield ["a"]; yield ["b", 2] } finally { events.push("params close") } }
        const names = []
        try { new Map(mapEntries()) } catch (error) { names.push(error.name) }
        try { new URLSearchParams(parameterEntries()) } catch (error) { names.push(error.name) }
        return [names, events]
      `),
    ).toEqual([
      ["TypeError", "TypeError"],
      ["map close", "params close"],
    ])
  })

  // test/built-ins/Array/from/iter-map-fn-args.js
  // test/built-ins/Array/from/iter-map-fn-err.js
  test("interleaves Array.from mapping and closes when its mapper fails", async () => {
    expect(
      await value(`
        const events = []
        function* source() {
          try { events.push("next 1"); yield 1; events.push("next 2"); yield 2 }
          finally { events.push("close") }
        }
        const mapped = Array.from(source(), (item) => { events.push("map " + item); return item * 2 })
        let caught
        try { Array.from(source(), (item) => { throw "mapper " + item }) } catch (error) { caught = error }
        return [mapped, caught, events]
      `),
    ).toEqual([[2, 4], "mapper 1", ["next 1", "map 1", "next 2", "map 2", "close", "next 1", "close"]])
  })

  test("reads array-like Array.from values immediately before mapping", async () => {
    expect(
      await value(`
        const source = { 0: 1, 1: 2, length: 2 }
        return Array.from(source, (item, index) => {
          if (index === 0) source[1] = 9
          return item
        })
      `),
    ).toEqual([1, 9])
  })

  test("interleaves Object.groupBy and Map.groupBy callbacks and closes on callback failure", async () => {
    expect(
      await value(`
        const events = []
        function* source() { try { events.push("next"); yield 1; events.push("next"); yield 2 } finally { events.push("close") } }
        const object = Object.groupBy(source(), (item) => { events.push("object " + item); return item % 2 })
        const map = Map.groupBy(source(), (item) => { events.push("map " + item); return item % 2 })
        let caught
        try { Object.groupBy(source(), () => { throw "callback" }) } catch (error) { caught = error }
        return [object, Object.fromEntries(map), caught, events]
      `),
    ).toEqual([
      { 0: [2], 1: [1] },
      { 0: [2], 1: [1] },
      "callback",
      ["next", "object 1", "next", "object 2", "close", "next", "map 1", "next", "map 2", "close", "next", "close"],
    ])
  })

  test("consumes Promise combinator generators in order and observes rejections", async () => {
    expect(
      await value(`
        function* items() { yield Promise.resolve(1); yield Promise.reject("bad"); yield 3 }
        const settled = await Promise.allSettled(items())
        let all, any
        try { await Promise.all(items()) } catch (error) { all = error }
        try { await Promise.any((function* () { yield Promise.reject("a"); yield Promise.reject("b") })()) }
        catch (error) { any = error.errors }
        const race = await Promise.race((function* () { yield 4; yield Promise.resolve(5) })())
        return [settled, all, any, race]
      `),
    ).toEqual([
      [
        { status: "fulfilled", value: 1 },
        { status: "rejected", reason: "bad" },
        { status: "fulfilled", value: 3 },
      ],
      "bad",
      ["a", "b"],
      4,
    ])
  })

  test("finishes Promise combinator iterator consumption before returning the promise", async () => {
    expect(
      await value(`
        const events = []
        function* items() { events.push("first"); yield 1; events.push("second"); yield 2 }
        const promise = Promise.all(items())
        events.push("after call")
        await promise
        return events
      `),
    ).toEqual(["first", "second", "after call"])
  })

  // test/built-ins/Object/fromEntries/iterator-closed-for-null-entry.js
  test("closes Object.fromEntries on malformed entries and consumes valid generators", async () => {
    expect(
      await value(`
        const events = []
        function* valid() { yield ["a", 1]; yield ["b", 2] }
        function* invalid() { try { yield ["a", 1]; yield null; yield ["c", 3] } finally { events.push("close") } }
        let name
        try { Object.fromEntries(invalid()) } catch (error) { name = error.name }
        return [Object.fromEntries(valid()), name, events]
      `),
    ).toEqual([{ a: 1, b: 2 }, "TypeError", ["close"]])
  })

  test("consumes AggregateError and Math.sumPrecise generators and closes on invalid numbers", async () => {
    expect(
      await value(`
        const events = []
        function* errors() { yield "a"; yield "b" }
        function* numbers() { yield 1e30; yield 0.1; yield -1e30 }
        function* invalid() { try { yield 1; yield "bad"; yield 2 } finally { events.push("close") } }
        const aggregate = new AggregateError(errors(), "message")
        let name
        try { Math.sumPrecise(invalid()) } catch (error) { name = error.name }
        return [aggregate.errors, aggregate.message, Math.sumPrecise(numbers()), name, events]
      `),
    ).toEqual([["a", "b"], "message", 0.1, "TypeError", ["close"]])
  })

  test("rejects async generators in every synchronous iterable consumer", async () => {
    expect(
      await value(`
        async function* source() { yield ["a", 1] }
        const checks = [
          () => [...source()],
          () => ((...items) => items)(...source()),
          () => { const [item] = source(); return item },
          () => Array.from(source()),
          () => new Map(source()),
          () => new Set(source()),
          () => new URLSearchParams(source()),
          () => Object.fromEntries(source()),
          () => Object.groupBy(source(), (item) => item),
          () => Math.sumPrecise(source()),
          () => new AggregateError(source()),
        ]
        const names = []
        for (const check of checks) {
          try { check() } catch (error) { names.push(error.name) }
        }
        try { await Promise.all(source()) } catch (error) { names.push(error.name) }
        return names
      `),
    ).toEqual(Array(12).fill("TypeError"))
  })

  // test/built-ins/Array/from/iter-get-iter-err.js
  // test/built-ins/Array/from/iter-adv-err.js
  test("does not close when iterator acquisition or next-result validation fails", async () => {
    expect(
      await value(`
        const events = []
        const acquisition = { [Symbol.iterator]: () => { events.push("acquire"); throw "acquisition" } }
        const malformed = {
          [Symbol.iterator]: () => malformed,
          next: () => { events.push("next"); return 1 },
          return: () => { events.push("close"); return {} },
        }
        for (const source of [acquisition, malformed]) {
          try { Array.from(source) } catch {}
        }
        return events
      `),
    ).toEqual(["acquire", "next"])
  })

  test("reports synchronous iterator failures before queued promise reactions", async () => {
    expect(
      await value(`
        const events = []
        Promise.resolve().then(() => events.push("reaction"))
        const iterator = {
          [Symbol.iterator]: () => iterator,
          next: () => { throw "next" },
        }
        try { Array.from(iterator) } catch { events.push("catch") }
        await Promise.resolve()
        return events
      `),
    ).toEqual(["catch", "reaction"])
  })
})
