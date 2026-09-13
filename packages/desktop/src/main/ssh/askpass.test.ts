import { expect } from "bun:test"
import { NodeSocket } from "@effect/platform-node"
import { Deferred, Effect, Fiber, Layer, Queue, Scope, Exit } from "effect"
import { testEffect } from "../../../../core/test/lib/effect"
import { createAskpass } from "./askpass"

const it = testEffect(Layer.empty)

const request = Effect.fn("test.askpass.request")(function* (
  env: Record<string, string>,
  text: string,
  confirm = false,
) {
  const socket = yield* NodeSocket.makeNet({ host: "127.0.0.1", port: Number(env.OPENCODE_SSH_ASKPASS_PORT) })
  const write = yield* socket.writer
  const result = { text: "" }
  yield* Effect.all(
    [
      socket
        .runString((text) => {
          result.text += text
        })
        .pipe(Effect.ignore),
      write(JSON.stringify({ token: env.OPENCODE_SSH_ASKPASS_TOKEN, text, confirm }) + "\n").pipe(Effect.ignore),
    ],
    { concurrency: "unbounded" },
  )
  return result.text
}, Effect.scoped)

it.live(
  "per-prompt replies are isolated, including confirmation and OTP",
  Effect.gen(function* () {
    const prompts = yield* Queue.unbounded<{ id: string; text: string; confirm: boolean }>()
    const bridge = yield* createAskpass({
      binary: "unused",
      prompt: (prompt) => Queue.offer(prompts, prompt).pipe(Effect.asVoid),
      clear: () => Effect.void,
    })
    const password = yield* request(bridge.env, "Password:").pipe(Effect.forkScoped)
    const first = yield* Queue.take(prompts)
    expect(first.text).toBe("Password:")
    const otp = yield* request(bridge.env, "Verification code:").pipe(Effect.forkScoped)
    yield* bridge.respond(first.id, "private response")
    expect(yield* Fiber.join(password)).toBe('{"value":"private response"}')
    const second = yield* Queue.take(prompts)
    expect(second.text).toBe("Verification code:")
    yield* bridge.respond(second.id, "123456")
    expect(yield* Fiber.join(otp)).toBe('{"value":"123456"}')
  }),
)

it.live(
  "closing the scope closes waiting helpers; invalid bridge credentials cannot prompt",
  Effect.gen(function* () {
    const parent = yield* Scope.Scope
    const scope = yield* Scope.fork(parent)
    const prompted = yield* Deferred.make<void>()
    const bridge = yield* createAskpass({
      binary: "unused",
      prompt: () => Deferred.succeed(prompted, undefined).pipe(Effect.asVoid),
      clear: () => Effect.void,
    }).pipe(Scope.provide(scope))
    expect(yield* request({ ...bridge.env, OPENCODE_SSH_ASKPASS_TOKEN: "incorrect" }, "Password:")).toBe("")
    const reply = yield* request(bridge.env, "Trust fingerprint?", true).pipe(Effect.forkScoped)
    yield* Deferred.await(prompted)
    yield* Scope.close(scope, Exit.void)
    expect(yield* Fiber.join(reply)).toBe("")
  }),
)

it.live(
  "disconnecting the active helper advances the queued prompt",
  Effect.gen(function* () {
    const prompts = yield* Queue.unbounded<{ id: string; text: string; confirm: boolean }>()
    const bridge = yield* createAskpass({
      binary: "unused",
      prompt: (prompt) => Queue.offer(prompts, prompt).pipe(Effect.asVoid),
      clear: () => Effect.void,
    })
    const first = yield* request(bridge.env, "Password:").pipe(Effect.forkScoped)
    yield* Queue.take(prompts)
    const next = yield* request(bridge.env, "Passphrase:").pipe(Effect.forkScoped)
    yield* Fiber.interrupt(first)
    const prompt = yield* Queue.take(prompts)
    expect(prompt.text).toBe("Passphrase:")
    yield* bridge.respond(prompt.id, "another response")
    expect(yield* Fiber.join(next)).toBe('{"value":"another response"}')
  }),
)
