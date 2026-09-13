import { NodeSocketServer } from "@effect/platform-node"
import { Deferred, Effect, Fiber, Schema, Semaphore } from "effect"
import { randomUUID } from "node:crypto"
import { SshFailure } from "./command"

const Request = Schema.fromJsonString(
  Schema.Struct({ token: Schema.String, text: Schema.String, confirm: Schema.Boolean }),
)

export const createAskpass = Effect.fn("Ssh.askpass")(function* (input: {
  binary: string
  prompt: (prompt: { id: string; text: string; confirm: boolean }) => Effect.Effect<void>
  clear: (id: string) => Effect.Effect<void>
}) {
  const token = randomUUID()
  const pending = new Map<string, Deferred.Deferred<string>>()
  const prompts = yield* Semaphore.make(1)
  const server = yield* NodeSocketServer.make({ host: "127.0.0.1", port: 0 }).pipe(Effect.mapError(SshFailure.from))
  if (server.address._tag !== "TcpAddress") return yield* Effect.fail(new SshFailure("connection"))

  const serving = yield* server
    .run((socket) =>
      Effect.gen(function* () {
        const request = yield* Deferred.make<string, SshFailure>()
        const state = { buffer: "", received: false }
        const reader = yield* socket
          .runString((chunk) => {
            if (state.received) return Effect.fail(new SshFailure("connection"))
            state.buffer += chunk
            if (state.buffer.length > 16_384) return Effect.fail(new SshFailure("connection"))
            if (!state.buffer.includes("\n")) return Effect.void
            state.received = true
            return Deferred.succeed(request, state.buffer.trim())
          })
          .pipe(Effect.ensuring(Deferred.fail(request, new SshFailure("connection"))), Effect.forkScoped)
        const message = yield* Deferred.await(request).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Request)))
        if (message.token !== token) return

        // One scoped waiter per helper invocation. Disconnecting a helper or closing
        // the connection interrupts that waiter and advances the prompt semaphore.
        yield* prompts
          .withPermit(
            Effect.gen(function* () {
              const id = randomUUID()
              const response = yield* Deferred.make<string>()
              yield* Effect.acquireRelease(
                Effect.sync(() => pending.set(id, response)),
                () => Effect.sync(() => pending.delete(id)).pipe(Effect.andThen(input.clear(id))),
              )
              yield* input.prompt({ id, text: message.text, confirm: message.confirm })
              const value = yield* Deferred.await(response)
              const write = yield* socket.writer
              yield* write(JSON.stringify({ value }))
            }).pipe(Effect.scoped),
          )
          .pipe(Effect.raceFirst(Fiber.join(reader).pipe(Effect.andThen(Effect.fail(new SshFailure("connection"))))))
      }).pipe(
        Effect.scoped,
        Effect.timeout("5 minutes"),
        // Helper cancellation, invalid credentials, and socket closure are local to
        // this request. Never log authentication payloads as error causes.
        Effect.ignore,
      ),
    )
    .pipe(Effect.mapError(SshFailure.from), Effect.forkScoped({ startImmediately: true }))

  return {
    env: {
      SSH_ASKPASS: input.binary,
      SSH_ASKPASS_REQUIRE: "force",
      DISPLAY: process.env.DISPLAY || "opencode",
      OPENCODE_SSH_ASKPASS_PORT: String(server.address.port),
      OPENCODE_SSH_ASKPASS_TOKEN: token,
    },
    closed: Fiber.join(serving),
    respond: Effect.fn("Ssh.askpass.respond")(function* (id: string, value: string) {
      const response = pending.get(id)
      if (response) yield* Deferred.succeed(response, value)
    }),
  }
})
