import { intro, outro, spinner } from "@clack/prompts"
import { Effect, Option } from "effect"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { handlePromptErrors, requireInteractive } from "../../../ui/prompt"
import { createClient, loadIntegrations, location, request } from "./shared"
import { chooseCredential, chooseIntegration } from "./account"

export default Runtime.handler(
  Commands.commands.auth.commands.logout,
  Effect.fn("cli.auth.logout")((input) =>
    logout({
      target: Option.getOrUndefined(input.target),
      credential: Option.getOrUndefined(input.credential),
      server: Option.getOrUndefined(input.server),
      standalone: input.standalone,
    }).pipe(handlePromptErrors),
  ),
)

const logout = Effect.fn("cli.auth.logout.run")(function* (input: {
  target?: string
  credential?: string
  server?: string
  standalone: boolean
}) {
  if (!input.target)
    yield* requireInteractive("Pass an integration ID or name when running without an interactive terminal")
  if (!input.credential)
    yield* requireInteractive("Pass a credential ID or label when running without an interactive terminal")
  intro("Log out of an account")
  const client = yield* createClient({ server: input.server, standalone: input.standalone })
  const integrations = yield* loadIntegrations(client)
  const integration = yield* chooseIntegration(integrations, input.target)
  const credentialID = yield* chooseCredential(integration, "log out", input.credential)
  const progress = spinner()
  progress.start("Removing credential...")
  yield* request((signal) => client.credential.remove({ credentialID, location }, { signal })).pipe(
    Effect.tap(() => Effect.sync(() => progress.stop(`Removed account from ${integration.name}`))),
    Effect.tapCause(() => Effect.sync(() => progress.stop("Failed to remove credential", 1))),
  )
  outro("Done")
})
