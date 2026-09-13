import type { ProviderPackage } from "../provider-package.js"
import { MistralChat } from "../protocols/mistral-chat.js"
import { AuthOptions, type ProviderAuthOption } from "../route/auth-options.js"
import type { RouteDefaultsInput } from "../route/client.js"
import { ProviderID, type ModelID } from "../schema/index.js"

export const id = ProviderID.make("mistral")

export type ProviderOptions = MistralChat.ProviderOptionsInput

export type LanguageModelOptions = Omit<RouteDefaultsInput, "providerOptions"> &
  ProviderAuthOption<"optional"> & {
    readonly baseURL?: string
    readonly providerOptions?: ProviderOptions
  }

export type Settings = ProviderPackage.Settings &
  ProviderOptions & {
    readonly apiKey?: string
    readonly baseURL?: string
  }

export const route = MistralChat.route
export const routes = [route]

export const configure = (input: LanguageModelOptions = {}) => {
  const { apiKey: _apiKey, auth: _auth, baseURL, ...defaults } = input
  const configured = route.with({
    ...defaults,
    endpoint: { baseURL: baseURL ?? MistralChat.DEFAULT_BASE_URL },
    auth: AuthOptions.bearer(input, "MISTRAL_API_KEY"),
  })
  return {
    id,
    model: (modelID: string | ModelID) => configured.model<ProviderOptions>({ id: modelID }),
    configure,
  }
}

export const provider = configure()

export const model: ProviderPackage.Definition<Settings, ProviderOptions>["model"] = (
  modelID,
  { apiKey, baseURL, body, headers, ...providerOptions },
) =>
  configure({
    apiKey,
    baseURL,
    headers: headers === undefined ? undefined : { ...headers },
    http: body === undefined ? undefined : { body: { ...body } },
    providerOptions,
  }).model(modelID)

export * as Mistral from "./mistral.js"
