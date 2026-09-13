import { Cause, Deferred, Effect, Exit, Fiber, Scope } from "effect"
import type { Diagnostic } from "../codemode.js"
import { ProgramThrow, typeError } from "./model.js"
import {
  Callable,
  define,
  get,
  hidden,
  ProgramArray,
  ProgramFunction,
  ProgramObject,
  ProgramPromise,
  record,
} from "./objects.js"
import { constructor, fn, methods, native, receiver, requiresNew } from "./native.js"
import { createAggregateErrorValue, materialize, normalizeError } from "./errors.js"
import { typeofValue } from "./references.js"
import { applyCollectionCallback, isSupportedCallback, type Runner } from "./runner.js"

// A `resolve`/`reject` handed to an executor or thenable: calling it settles the capability.
const capability = <R>(runner: Runner<R>, name: string, settle: (value: unknown) => void) =>
  fn(runner.prototypes, name, 1, (_, args) => {
    settle(args[0])
    return undefined
  })

// Observation only controls rejection reporting; program completion interrupts all promise work.
export class PromiseRuntime<R> {
  private readonly active = new Set<ProgramPromise>()
  private readonly ids = new WeakMap<ProgramPromise, number>()
  private readonly observed = new WeakSet<ProgramPromise>()
  private readonly failures = new Map<number, Diagnostic>()
  private nextID = 0

  constructor(
    private readonly scope: Scope.Scope,
    private readonly proto: ProgramObject,
  ) {}

  // Resolution bodies need the promise's own identity to reject `resolve(promise)` self-resolution.
  createWithSelf(
    body: (self: { promise?: ProgramPromise }) => Effect.Effect<unknown, unknown, R>,
  ): Effect.Effect<ProgramPromise, never, R> {
    const self: { promise?: ProgramPromise } = {}
    return Effect.map(this.create(body(self)), (promise) => {
      self.promise = promise
      return promise
    })
  }

  create(effect: Effect.Effect<unknown, unknown, R>): Effect.Effect<ProgramPromise, never, R> {
    return Effect.suspend(() => {
      // Allocate before forking so reruns get distinct IDs and diagnostics retain creation order.
      const id = this.nextID++
      return Effect.map(Effect.forkIn(effect, this.scope, { startImmediately: true }), (fiber) => {
        const promise = new ProgramPromise(this.proto, fiber)
        this.active.add(promise)
        this.ids.set(promise, id)
        fiber.addObserver((exit) => {
          this.active.delete(promise)
          if (Exit.isSuccess(exit) || Cause.hasInterruptsOnly(exit.cause) || this.observed.has(promise)) {
            this.ids.delete(promise)
            return
          }
          const failure = normalizeError(Cause.squash(exit.cause))
          this.failures.set(id, {
            ...failure,
            message: `Unhandled rejection from an un-awaited promise: ${failure.message}`,
          })
        })
        return promise
      })
    })
  }

  // Observation must be recorded when responsibility transfers, before the consumer fiber runs.
  markObserved(promise: ProgramPromise): void {
    this.observed.add(promise)
    const id = this.ids.get(promise)
    this.ids.delete(promise)
    if (id !== undefined) this.failures.delete(id)
  }

  await(promise: ProgramPromise): Effect.Effect<Exit.Exit<unknown, unknown>> {
    return Fiber.await(promise.fiber)
  }

  fork(effect: Effect.Effect<unknown, unknown, R>): Effect.Effect<void, never, R> {
    return Effect.asVoid(Effect.forkIn(effect, this.scope, { startImmediately: true }))
  }

  diagnostics(): Array<Diagnostic> {
    return [...this.failures].sort(([left], [right]) => left - right).map(([, failure]) => failure)
  }

  // Re-check because a straggler can create promises before its interruption lands.
  interrupt(): Effect.Effect<Array<Diagnostic>> {
    const self = this
    return Effect.gen(function* () {
      while (self.active.size > 0) {
        yield* Fiber.interruptAll([...self.active].map((promise) => promise.fiber))
      }
      return self.diagnostics()
    })
  }
}

export const resolvePromiseValue = <R>(
  runner: Runner<R>,
  value: unknown,
  own?: { promise?: ProgramPromise },
): Effect.Effect<unknown, unknown, R> => {
  if (own?.promise !== undefined && value === own.promise) {
    return Effect.die(typeError("Chaining cycle detected: a promise cannot resolve with itself."))
  }
  if (value instanceof ProgramPromise) return runner.settlePromise(value)
  if (!(value instanceof ProgramObject)) return Effect.succeed(value)
  const then = get(value, "then")
  if (typeofValue(then) !== "function") return Effect.succeed(value)

  return Effect.gen(function* () {
    // Promise resolution invokes a thenable's method in a later job.
    yield* Effect.yieldNow
    const deferred = Deferred.makeUnsafe<unknown, unknown>()
    const resolve = capability(runner, "resolve", (result) => Deferred.doneUnsafe(deferred, Exit.succeed(result)))
    const reject = capability(runner, "reject", (reason) =>
      Deferred.doneUnsafe(deferred, Exit.fail(new ProgramThrow(reason))),
    )
    const executed = yield* Effect.exit(runner.invokeCallable(then, value, [resolve, reject]))
    if (!Exit.isSuccess(executed)) {
      if (Cause.hasInterruptsOnly(executed.cause)) return yield* Effect.failCause(executed.cause)
      Deferred.doneUnsafe(deferred, Exit.fail(Cause.squash(executed.cause)))
    }
    return yield* resolvePromiseValue(runner, yield* Deferred.await(deferred), own)
  })
}

export const resolvePromise = <R>(
  runner: Runner<R>,
  promises: PromiseRuntime<R>,
  value: unknown,
): Effect.Effect<ProgramPromise, never, R> => {
  if (value instanceof ProgramPromise) return Effect.succeed(value)
  return promises.createWithSelf((self) => resolvePromiseValue(runner, value, self))
}

const promiseStatics = ["all", "allSettled", "race", "any", "resolve", "reject"] as const

const invokePromiseMethod = <R>(
  runner: Runner<R>,
  promises: PromiseRuntime<R>,
  name: (typeof promiseStatics)[number],
  args: Array<unknown>,
): Effect.Effect<unknown, unknown, R> => {
  if (name === "resolve") {
    return resolvePromise(runner, promises, args[0])
  }
  if (name === "reject") {
    return promises.create(Effect.fail(new ProgramThrow(args[0])))
  }

  return promises.create(
    Effect.gen(function* () {
      const cursor = yield* runner.syncIterator(args[0])
      if (cursor === undefined) throw typeError(`Promise.${name} expects an array or other synchronous iterable.`)
      const items: Array<ProgramPromise> = []
      while (true) {
        const step = yield* cursor.next
        if (step.done) break
        const item = yield* resolvePromise(runner, promises, step.value)
        promises.markObserved(item)
        items.push(item)
      }

      if (name === "all") {
        return new ProgramArray(
          runner.prototypes.Array,
          yield* settleAfterTurn(
            Effect.all(
              items.map((item) => Effect.flatten(promises.await(item))),
              { concurrency: "unbounded" },
            ),
          ),
        )
      }
      if (name === "allSettled") {
        const outcomes: Array<unknown> = []
        for (const item of items) {
          const exit = yield* promises.await(item)
          if (Exit.isSuccess(exit)) {
            outcomes.push(record(runner.prototypes.Object, { status: "fulfilled", value: exit.value }))
            continue
          }
          if (Cause.hasInterruptsOnly(exit.cause)) return yield* Effect.failCause(exit.cause)
          outcomes.push(
            record(runner.prototypes.Object, {
              status: "rejected",
              reason: materialize(runner, Cause.squash(exit.cause)),
            }),
          )
        }
        yield* Effect.yieldNow
        return new ProgramArray(runner.prototypes.Array, outcomes)
      }
      if (name === "race") {
        if (items.length === 0) {
          throw typeError("Promise.race([]) would never settle; provide at least one promise or value.")
        }
        return yield* settleAfterTurn(Effect.flatten(Effect.raceAll(items.map((item) => promises.await(item)))))
      }
      const flipped = items.map((item) =>
        Effect.flatMap(promises.await(item), (exit) => {
          if (Exit.isSuccess(exit)) return Effect.fail(new PromiseAnyFulfilled(exit.value))
          if (Cause.hasInterruptsOnly(exit.cause)) return Effect.failCause(exit.cause)
          return Effect.succeed(materialize(runner, Cause.squash(exit.cause)))
        }),
      )
      return yield* settleAfterTurn(
        Effect.all(flipped, { concurrency: "unbounded" }).pipe(
          Effect.flatMap((reasons) =>
            Effect.fail(new ProgramThrow(createAggregateErrorValue(runner, reasons, "All promises were rejected"))),
          ),
          Effect.catch((error) =>
            error instanceof PromiseAnyFulfilled ? Effect.succeed(error.value) : Effect.fail(error),
          ),
        ),
      )
    }),
  )
}

const instanceMethod = <R>(
  runner: Runner<R>,
  promises: PromiseRuntime<R>,
  name: "then" | "catch" | "finally",
  thisValue: unknown,
  args: Array<unknown>,
): Effect.Effect<ProgramPromise, unknown, R> => {
  const method = `Promise.prototype.${name}`
  const promise = receiver(ProgramPromise, thisValue, method)
  promises.markObserved(promise)
  if (name === "finally") {
    return chainFinally(runner, promises, promise, reactionHandler(args[0], method), method)
  }
  const onFulfilled = name === "then" ? reactionHandler(args[0], method) : undefined
  const onRejected = reactionHandler(name === "then" ? args[1] : args[0], method)
  return chainReaction(runner, promises, promise, onFulfilled, onRejected, method)
}

const constructPromise = <R>(
  runner: Runner<R>,
  promises: PromiseRuntime<R>,
  executor: unknown,
): Effect.Effect<ProgramPromise, unknown, R> => {
  if (!(executor instanceof ProgramFunction)) {
    throw typeError("new Promise(...) expects an executor function (e.g. new Promise((resolve, reject) => { ... })).")
  }
  return Effect.gen(function* () {
    const deferred = Deferred.makeUnsafe<unknown, unknown>()
    const promise = yield* promises.createWithSelf((self) =>
      Effect.flatMap(Deferred.await(deferred), (value) => resolvePromiseValue(runner, value, self)),
    )
    const resolve = capability(runner, "resolve", (value) => Deferred.doneUnsafe(deferred, Exit.succeed(value)))
    const reject = capability(runner, "reject", (value) =>
      Deferred.doneUnsafe(deferred, Exit.fail(new ProgramThrow(value))),
    )
    const executed = yield* Effect.exit(runner.invokeCallable(executor, undefined, [resolve, reject]))
    if (!Exit.isSuccess(executed)) {
      if (Cause.hasInterruptsOnly(executed.cause)) return yield* Effect.failCause(executed.cause)
      Deferred.doneUnsafe(deferred, Exit.fail(Cause.squash(executed.cause)))
    }
    return promise
  })
}

// Settle one reaction turn after the deciding member, after its existing reactions.
const settleAfterTurn = <A, E, R>(body: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.flatMap(Effect.exit(body), (exit) => Effect.andThen(Effect.yieldNow, exit))

class PromiseAnyFulfilled {
  constructor(readonly value: unknown) {}
}

const reactionHandler = (value: unknown, method: string): Callable | undefined => {
  if (isSupportedCallback(value)) return value
  if (typeofValue(value) === "function") {
    throw typeError(
      `${method} cannot use this callable as a handler; wrap it in an arrow function, e.g. (value) => tools.ns.tool(value).`,
    )
  }
  return undefined
}

// Teardown bypasses handlers; settled reactions yield once so handlers never run inline.
const reactionExit = <R>(
  promises: PromiseRuntime<R>,
  source: ProgramPromise,
): Effect.Effect<Exit.Exit<unknown, unknown>, unknown, R> =>
  Effect.gen(function* () {
    const exit = yield* promises.await(source)
    if (!Exit.isSuccess(exit) && Cause.hasInterruptsOnly(exit.cause)) return yield* Effect.failCause(exit.cause)
    yield* Effect.yieldNow
    return exit
  })

const chainReaction = <R>(
  runner: Runner<R>,
  promises: PromiseRuntime<R>,
  source: ProgramPromise,
  onFulfilled: Callable | undefined,
  onRejected: Callable | undefined,
  method: string,
): Effect.Effect<ProgramPromise, never, R> => {
  return promises.createWithSelf((self) =>
    Effect.gen(function* () {
      const exit = yield* reactionExit(promises, source)
      const handler = Exit.isSuccess(exit) ? onFulfilled : onRejected
      if (handler === undefined) return yield* exit
      const input = Exit.isSuccess(exit) ? exit.value : materialize(runner, Cause.squash(exit.cause))
      const result = yield* applyCollectionCallback(runner, handler, method)([input])
      return yield* resolvePromiseValue(runner, result, self)
    }),
  )
}

const chainFinally = <R>(
  runner: Runner<R>,
  promises: PromiseRuntime<R>,
  source: ProgramPromise,
  cleanup: Callable | undefined,
  method: string,
): Effect.Effect<ProgramPromise, never, R> =>
  promises.create(
    Effect.gen(function* () {
      const exit = yield* reactionExit(promises, source)
      if (cleanup !== undefined) {
        const result = yield* applyCollectionCallback(runner, cleanup, method)([])
        const intermediate = yield* promises.create(
          Effect.gen(function* () {
            yield* runner.settlePromise(yield* resolvePromise(runner, promises, result))
            return yield* exit
          }),
        )
        return yield* runner.settlePromise(intermediate)
      }
      return yield* exit
    }),
  )

export const promiseGlobal = <R>(runner: Runner<R>, promises: PromiseRuntime<R>) => {
  const protos = runner.prototypes
  const proto = protos.Promise
  const promise = constructor<R>(protos, proto, {
    name: "Promise",
    length: 1,
    call: requiresNew("Promise"),
    construct: (args) => constructPromise(runner, promises, args[0]),
  })
  // Combinators are not callbacks: `[p].map(Promise.resolve)` must ask for an arrow function.
  for (const name of promiseStatics) {
    define(
      promise,
      name,
      native<R>(protos, {
        name,
        length: 1,
        call: (_, args) => invokePromiseMethod(runner, promises, name, args),
        callback: false,
      }),
      hidden,
    )
  }
  methods(protos, proto, [
    ["then", 2, (thisValue, args) => instanceMethod(runner, promises, "then", thisValue, args)],
    ["catch", 1, (thisValue, args) => instanceMethod(runner, promises, "catch", thisValue, args)],
    ["finally", 1, (thisValue, args) => instanceMethod(runner, promises, "finally", thisValue, args)],
  ])
  return promise
}
