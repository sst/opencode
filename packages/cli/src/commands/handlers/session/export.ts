import { autocomplete, cancel, intro, isCancel, log, outro } from "@clack/prompts"
import { OpenCode } from "@opencode/client"
import { Service } from "@opencode/client/effect/service"
import { Effect, Option } from "effect"
import { EOL } from "node:os"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { ServerConnection } from "../../../services/server-connection"
import { errorMessage } from "../../../util/error"

export default Runtime.handler(
  Commands.commands.session.commands.export,
  Effect.fn("cli.session.export")((input) =>
    Effect.gen(function* () {
      const requested = Option.getOrUndefined(input.session)
      if (!requested && !process.stdin.isTTY) {
        yield* Effect.fail(new Error("Pass a session ID when running without an interactive terminal"))
      }
      const server = yield* ServerConnection.resolve({
        server: Option.getOrUndefined(input.server),
        standalone: input.standalone,
      })
      const client = OpenCode.make({
        baseUrl: server.endpoint.url,
        headers: Service.headers(server.endpoint),
      })
      const sessionID = requested
        ? requested
        : yield* Effect.gen(function* () {
            intro("Export session", { output: process.stderr })
            const location = yield* Effect.tryPromise({
              try: () => client.location.get({ location: { directory: process.cwd() } }),
              catch: (cause) => cause,
            })
            const page = yield* Effect.tryPromise({
              try: () =>
                client.session.list({
                  directory: location.directory,
                  workspace: location.workspaceID,
                  parentID: null,
                  order: "desc",
                  limit: 50,
                }),
              catch: (cause) => cause,
            })
            if (page.data.length === 0) {
              log.error("No sessions found", { output: process.stderr })
              outro("Done", { output: process.stderr })
              return undefined
            }
            const selected = yield* Effect.tryPromise({
              try: () =>
                autocomplete({
                  message: "Select session to export",
                  maxItems: 10,
                  options: page.data.map((session) => ({
                    label: session.title,
                    value: session.id,
                    hint: `${new Date(session.time.updated).toLocaleString()} - ${session.id.slice(-8)}`,
                  })),
                  output: process.stderr,
                }),
              catch: (cause) => cause,
            })
            if (isCancel(selected)) {
              cancel("Cancelled", { output: process.stderr })
              process.exitCode = 130
              return undefined
            }
            outro("Exporting session...", { output: process.stderr })
            return selected
          })
      if (!sessionID) return
      const data = yield* Effect.tryPromise({
        try: () => client.session.export({ sessionID, sanitize: input.sanitize }),
        catch: (cause) => cause,
      })
      process.stdout.write(JSON.stringify(data, null, 2) + EOL)
    }).pipe(
      Effect.catch((error) =>
        Effect.sync(() => {
          process.stderr.write(errorMessage(error) + EOL)
          process.exitCode = 1
        }),
      ),
    ),
  ),
)
