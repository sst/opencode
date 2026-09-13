import { NodeSocket } from "@effect/platform-node"
import { Effect, Schema, Stdio, Stream } from "effect"

const Response = Schema.fromJsonString(Schema.Struct({ value: Schema.NullOr(Schema.String) }))
const Port = Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(65535))

// OpenSSH invokes the executable directly, including on Windows. Run outside
// normal CLI observability so neither prompts nor responses enter its logs.
export const askpass = Effect.gen(function* () {
  const port = yield* Schema.decodeUnknownEffect(Port)(process.env.OPENCODE_SSH_ASKPASS_PORT)
  const stdio = yield* Stdio.Stdio
  const socket = yield* NodeSocket.makeNet({ host: "127.0.0.1", port })
  const write = yield* socket.writer
  const response = { text: "" }
  yield* Effect.all(
    [
      socket.runString((text) =>
        Effect.sync(() => {
          response.text += text
        }),
      ),
      write(
        JSON.stringify({
          token: process.env.OPENCODE_SSH_ASKPASS_TOKEN,
          text: process.argv.slice(2).join(" "),
          confirm: process.env.SSH_ASKPASS_PROMPT === "confirm",
        }) + "\n",
      ),
    ],
    { concurrency: "unbounded", discard: true },
  )
  const result = yield* Schema.decodeUnknownEffect(Response)(response.text)
  if (result.value === null) return 1
  yield* Stream.make(result.value + "\n").pipe(Stream.run(stdio.stdout({ endOnDone: false })))
  return 0
}).pipe(
  Effect.scoped,
  Effect.timeout("5 minutes"),
  Effect.orElseSucceed(() => 1),
)
