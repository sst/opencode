import type { ProviderPackage } from "../provider-package.js"
import { OpenAIChat } from "../protocols/openai-chat.js"
import { AuthOptions, type ProviderAuthOption } from "../route/auth-options.js"
import { Route, type RouteDefaultsInput } from "../route/client.js"
import { Endpoint } from "../route/endpoint.js"
import { ProviderID, type ModelID } from "../schema/index.js"
import type { OpenAIProviderOptionsInput } from "./openai-options.js"

export const id = ProviderID.make("baseten")
const baseURL = "https://inference.baseten.co/v1"

export type LanguageModelOptions = Omit<RouteDefaultsInput, "providerOptions"> &
  ProviderAuthOption<"optional"> & {
    readonly baseURL?: string
    readonly providerOptions?: OpenAIProviderOptionsInput
  }

export type Settings = ProviderPackage.Settings &
  OpenAIProviderOptionsInput & {
    readonly apiKey?: string
    readonly baseURL?: string
  }

export const route = Route.make({
  id: "baseten-chat",
  provider: id,
  providerMetadataKey: "baseten",
  protocol: OpenAIChat.protocol,
  endpoint: Endpoint.path("/chat/completions", { baseURL }),
  framing: OpenAIChat.framing,
})

export const routes = [route]

export const configure = (input: LanguageModelOptions = {}) => {
  const { apiKey: _apiKey, auth: _auth, baseURL: endpoint, ...defaults } = input
  const configured = route.with({
    ...defaults,
    endpoint: { baseURL: endpoint ?? baseURL },
    auth: AuthOptions.bearer(input, "BASETEN_API_KEY"),
  })
  return {
    id,
    model: (modelID: string | ModelID) => configured.model<OpenAIProviderOptionsInput>({ id: modelID }),
    configure,
  }
}

export const provider = configure()

export const model: ProviderPackage.Definition<Settings, OpenAIProviderOptionsInput>["model"] = (
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

export * as Baseten from "./baseten.js"
