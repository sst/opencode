import type { ProviderPackage } from "../provider-package.js"
import { AnthropicMessages } from "../protocols/anthropic-messages.js"
import { Auth } from "../route/auth.js"
import type { ProviderAuthOption } from "../route/auth-options.js"
import type { RouteDefaultsInput } from "../route/client.js"
import { ProviderConfigurationError, ProviderID, type ModelID } from "../schema/index.js"

export type AnthropicOptionsInput = AnthropicMessages.OptionsInput
export type AnthropicProviderOptionsInput = AnthropicMessages.ProviderOptionsInput
export type AnthropicThinkingInput = AnthropicMessages.ThinkingInput

export const id = ProviderID.make("anthropic-compatible")

export type Config = RouteDefaultsInput &
  ProviderAuthOption<"optional"> & {
    readonly provider?: string
    readonly baseURL: string
    readonly providerOptions?: AnthropicMessages.ProviderOptionsInput
  }

export type Settings = ProviderPackage.Settings &
  AnthropicMessages.ProviderOptionsInput &
  (
    | { readonly apiKey?: string; readonly authToken?: never }
    | { readonly apiKey?: never; readonly authToken?: string }
  ) & {
    readonly baseURL: string
    readonly provider?: string
  }

export const routes = [AnthropicMessages.route]

const auth = (input: ProviderAuthOption<"optional">) => {
  if ("auth" in input && input.auth) return input.auth
  return Auth.optional("apiKey" in input ? input.apiKey : undefined, "apiKey").pipe(Auth.header("x-api-key"))
}

export const configure = (input: Config) => {
  const provider = input.provider ?? "anthropic-compatible"
  if (!input.baseURL)
    throw new ProviderConfigurationError({
      provider: ProviderID.make(provider),
      message: "Anthropic-compatible providers require a baseURL",
    })
  const { provider: _, baseURL, apiKey: _apiKey, auth: _auth, ...rest } = input
  const route = AnthropicMessages.route.with({
    ...rest,
    provider,
    endpoint: { baseURL },
    auth: auth(input),
  })
  return {
    id: ProviderID.make(provider),
    model: (modelID: string | ModelID) => route.model<AnthropicMessages.ProviderOptionsInput>({ id: modelID }),
    configure,
  }
}

export const provider = {
  id,
  configure,
}

export const model: ProviderPackage.Definition<Settings, AnthropicMessages.ProviderOptionsInput>["model"] = (
  modelID,
  { apiKey, authToken, baseURL, body, headers, provider, ...providerOptions },
) => {
  if (apiKey !== undefined && authToken !== undefined)
    throw new ProviderConfigurationError({
      provider: ProviderID.make(provider ?? id),
      message: "Anthropic-compatible apiKey cannot be combined with authToken",
    })
  return configure({
    ...(authToken === undefined ? { apiKey: apiKey } : { auth: Auth.bearer(authToken) }),
    baseURL,
    headers: headers === undefined ? undefined : { ...headers },
    http: body === undefined ? undefined : { body: { ...body } },
    provider,
    providerOptions,
  }).model(modelID)
}

export * as AnthropicCompatible from "./anthropic-compatible.js"
