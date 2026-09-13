import { autocomplete } from "@clack/prompts"
import { Effect } from "effect"
import type { IntegrationInfo } from "@opencode/client"
import { prompt } from "../../../ui/prompt"
import { resolveIntegration } from "./shared"

export const chooseIntegration = Effect.fn("cli.auth.account.integration")(function* (
  integrations: IntegrationInfo[],
  target?: string,
) {
  if (target) return yield* resolveIntegration(integrations, target)
  const configured = integrations.filter((integration) =>
    integration.connections.some((connection) => connection.type === "credential"),
  )
  if (configured.length === 0) return yield* Effect.fail(new Error("No stored credentials found"))
  const id = yield* prompt<string>(() =>
    autocomplete({
      message: "Select integration",
      maxItems: 8,
      options: configured.map((integration) => ({
        value: integration.id,
        label: integration.name,
        hint: integration.connections
          .filter((connection) => connection.type === "credential")
          .map((connection) => connection.label)
          .join(", "),
      })),
    }),
  )
  return yield* resolveIntegration(configured, id)
})

export const chooseCredential = Effect.fn("cli.auth.account.credential")(function* (
  integration: IntegrationInfo,
  action: "log out" | "switch to",
  target?: string,
) {
  const credentials = integration.connections.filter((connection) => connection.type === "credential")
  if (credentials.length === 0) {
    const environment = integration.connections
      .filter((connection) => connection.type === "env")
      .map((connection) => connection.name)
    if (environment.length && action === "log out") {
      yield* Effect.fail(
        new Error(
          `${integration.name} is authenticated through ${environment.join(", ")}; unset the environment variable to disconnect`,
        ),
      )
    }
    yield* Effect.fail(new Error(`No stored credentials for ${integration.name}`))
  }
  if (target) {
    const byID = credentials.find((credential) => credential.id === target)
    if (byID) return byID.id
    const matches = credentials.filter((credential) => credential.label.toLowerCase() === target.toLowerCase())
    if (matches.length === 1) return matches[0].id
    if (matches.length > 1)
      return yield* Effect.fail(
        new Error(`Credential label "${target}" is ambiguous. Use an ID: ${matches.map((item) => item.id).join(", ")}`),
      )
    return yield* Effect.fail(new Error(`Credential not found for ${integration.name}: ${target}`))
  }
  return yield* prompt<string>(() =>
    autocomplete({
      message: `Select ${integration.name} account to ${action}`,
      maxItems: 8,
      options: credentials.map((credential, index) => ({
        value: credential.id,
        label: index === 0 ? `${credential.label} (active)` : credential.label,
        hint: credential.id,
      })),
    }),
  )
})
