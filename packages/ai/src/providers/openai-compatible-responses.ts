import type { ProviderPackage } from "../provider-package.js"
import { OpenAICompatibleResponses } from "../protocols/openai-compatible-responses.js"
import { AuthOptions, type ProviderAuthOption } from "../route/auth-options.js"
import type { RouteDefaultsInput } from "../route/client.js"
import { ProviderID, type ModelID } from "../schema/index.js"
import type { OpenResponsesProviderOptionsInput } from "./open-responses-options.js"

export type { OpenResponsesOptionsInput, OpenResponsesProviderOptionsInput } from "./open-responses-options.js"

export const id = ProviderID.make("openai-compatible")

export type Config = RouteDefaultsInput &
  ProviderAuthOption<"optional"> & {
    readonly provider?: string
    readonly baseURL: string
    readonly providerOptions?: OpenResponsesProviderOptionsInput
  }

export type Settings = ProviderPackage.Settings &
  OpenResponsesProviderOptionsInput & {
    readonly apiKey?: string
    readonly baseURL: string
    readonly provider?: string
  }

export const routes = [OpenAICompatibleResponses.route]

export const configure = (input: Config) => {
  const provider = input.provider ?? "openai-compatible"
  const { provider: _, baseURL, apiKey: _apiKey, auth: _auth, ...rest } = input
  const route = OpenAICompatibleResponses.route.with({
    ...rest,
    provider,
    endpoint: { baseURL },
    auth: AuthOptions.bearer(input, []),
  })
  return {
    id: ProviderID.make(provider),
    model: (modelID: string | ModelID) => route.model<OpenResponsesProviderOptionsInput>({ id: modelID }),
    configure,
  }
}

export const provider = {
  id,
  configure,
}

export const model: ProviderPackage.Definition<Settings, OpenResponsesProviderOptionsInput>["model"] = (
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
