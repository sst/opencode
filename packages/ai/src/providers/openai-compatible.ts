import { ProviderID, type ModelID } from "../schema/index.js"
import { OpenAICompatibleChat } from "../protocols/openai-compatible-chat.js"
import type { RouteDefaultsInput } from "../route/client.js"
import { AuthOptions, type ProviderAuthOption } from "../route/auth-options.js"
import type { ProviderPackage } from "../provider-package.js"
import type { OpenAIProviderOptionsInput } from "./openai-options.js"

export const id = ProviderID.make("openai-compatible")

type GenericModelOptions = Omit<RouteDefaultsInput, "providerOptions"> &
  ProviderAuthOption<"optional"> & {
    readonly provider?: string
    readonly baseURL: string
    readonly providerOptions?: OpenAIProviderOptionsInput
  }

export type Settings = ProviderPackage.Settings &
  OpenAIProviderOptionsInput & {
    readonly apiKey?: string
    readonly baseURL: string
    readonly provider?: string
  }

export const routes = [OpenAICompatibleChat.route]

export const configure = (input: GenericModelOptions) => {
  const provider = input.provider ?? "openai-compatible"
  const { provider: _, baseURL, apiKey: _apiKey, auth: _auth, ...rest } = input
  const route = OpenAICompatibleChat.route.with({
    ...rest,
    provider,
    endpoint: { baseURL },
    auth: AuthOptions.bearer(input, []),
  })
  return {
    id: ProviderID.make(provider),
    model: (modelID: string | ModelID) =>
      route.model<OpenAIProviderOptionsInput>({ id: modelID, provider: ProviderID.make(provider) }),
    configure,
  }
}

export const provider = {
  id,
  configure,
}

export const model: ProviderPackage.Definition<Settings, OpenAIProviderOptionsInput>["model"] = (
  modelID,
  { apiKey, baseURL, body, headers, provider, ...providerOptions },
) =>
  configure({
    apiKey,
    baseURL,
    headers: headers === undefined ? undefined : { ...headers },
    http: body === undefined ? undefined : { body: { ...body } },
    provider,
    providerOptions,
  }).model(modelID)

export * as OpenAICompatible from "./openai-compatible.js"
