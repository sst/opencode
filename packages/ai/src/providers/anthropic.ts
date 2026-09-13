import type { RouteDefaultsInput } from "../route/client.js"
import { Auth } from "../route/auth.js"
import type { ProviderAuthOption } from "../route/auth-options.js"
import type { ProviderPackage } from "../provider-package.js"
import { ProviderConfigurationError, ProviderID, type ModelID } from "../schema/index.js"
import { AnthropicMessages } from "../protocols/anthropic-messages.js"
import { AnthropicCompatible } from "./anthropic-compatible.js"

export type AnthropicOptionsInput = AnthropicMessages.OptionsInput
export type AnthropicProviderOptionsInput = AnthropicMessages.ProviderOptionsInput
export type AnthropicThinkingInput = AnthropicMessages.ThinkingInput

export const id = ProviderID.make("anthropic")

export const routes = [AnthropicMessages.route]

export type Config = RouteDefaultsInput &
  ProviderAuthOption<"optional"> & {
    readonly baseURL?: string
    readonly providerOptions?: AnthropicMessages.ProviderOptionsInput
  }

export type Settings = ProviderPackage.Settings &
  AnthropicMessages.ProviderOptionsInput &
  (
    | { readonly apiKey?: string; readonly authToken?: never }
    | { readonly apiKey?: never; readonly authToken?: string }
  ) & {
    readonly baseURL?: string
  }

const auth = (options: ProviderAuthOption<"optional">) => {
  if ("auth" in options && options.auth) return options.auth
  return Auth.optional("apiKey" in options ? options.apiKey : undefined, "apiKey")
    .orElse(Auth.config("ANTHROPIC_API_KEY"))
    .pipe(Auth.header("x-api-key"))
}

export const configure = (input: Config = {}) => {
  const { apiKey: _, auth: _auth, baseURL, ...rest } = input
  const compatible = AnthropicCompatible.configure({
    ...rest,
    auth: auth(input),
    baseURL: baseURL ?? AnthropicMessages.DEFAULT_BASE_URL,
    provider: id,
  })
  return {
    id,
    model: (modelID: string | ModelID) => compatible.model(modelID),
    configure,
  }
}

export const provider = configure()
export const model: ProviderPackage.Definition<Settings, AnthropicMessages.ProviderOptionsInput>["model"] = (
  modelID,
  { apiKey, authToken, baseURL, body, headers, ...providerOptions },
) => {
  if (apiKey !== undefined && authToken !== undefined)
    throw new ProviderConfigurationError({
      provider: id,
      message: "Anthropic apiKey cannot be combined with authToken",
    })
  return configure({
    ...(authToken === undefined ? { apiKey: apiKey } : { auth: Auth.bearer(authToken) }),
    baseURL,
    headers: headers === undefined ? undefined : { ...headers },
    http: body === undefined ? undefined : { body: { ...body } },
    providerOptions,
  }).model(modelID)
}
