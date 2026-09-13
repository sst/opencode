import { Effect } from "effect"
import { effectCmd, CliError } from "../effect-cmd"
import { withNetworkOptions, resolveNetworkOptions } from "../network"
import { Flag } from "@opencode-ai/core/flag/flag"
import { errorMessage } from "@/util/error"

export const ServeCommand = effectCmd({
  command: "serve",
  builder: (yargs) => withNetworkOptions(yargs),
  describe: "starts a headless opencode server",
  // Server loads instances per-request via x-opencode-directory header — no
  // need for an ambient project InstanceContext at startup.
  instance: false,
  handler: Effect.fn("Cli.serve")(function* (args) {
    const { Server } = yield* Effect.promise(() => import("../../server/server"))
    if (!Flag.OPENCODE_SERVER_PASSWORD) {
      console.log("Warning: OPENCODE_SERVER_PASSWORD is not set; server is unsecured.")
    }
    const opts = yield* resolveNetworkOptions(args)
    const server = yield* Effect.tryPromise({
      try: () => Server.listen(opts),
      catch: (error) => new CliError({ message: `Failed to start server: ${extractServerCause(error)}` }),
    })
    console.log(`opencode server listening on http://${server.hostname}:${server.port}`)

    yield* Effect.never
  }),
})

export function extractServerCause(error: unknown): string {
  // Effect.runPromise wraps failures in FiberFailure. The inner cause chain
  // is typically: FiberFailure → Cause.Fail → ServeError { cause: <node error> }.
  // Walk the chain to find the deepest actionable message.
  let current: unknown = error
  for (let depth = 0; depth < 10 && current != null; depth++) {
    if (current instanceof Error && current.cause != null) {
      current = current.cause
      continue
    }
    if (typeof current === "object") {
      const rec = current as Record<string, unknown>
      // Effect Cause objects: check .error (Fail) or .defect (Die)
      if ("error" in rec && rec.error != null) {
        current = rec.error
        continue
      }
      if ("defect" in rec && rec.defect != null) {
        current = rec.defect
        continue
      }
      // ServeError and similar: { _tag, cause }
      if ("cause" in rec && rec.cause != null && rec.cause !== current) {
        current = rec.cause
        continue
      }
    }
    break
  }
  return errorMessage(current ?? error)
}
