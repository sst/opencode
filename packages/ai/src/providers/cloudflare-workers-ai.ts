import type { ProviderPackage } from "../provider-package.js"
import { OpenAIChat } from "../protocols/openai-chat.js"
import { AuthOptions, type AtLeastOne, type ProviderAuthOption } from "../route/auth-options.js"
import { Route, type RouteDefaultsInput } from "../route/client.js"
import { Endpoint } from "../route/endpoint.js"
import { ProviderConfigurationError, ProviderID, type ModelID } from "../schema/index.js"
import type { OpenAIProviderOptionsInput } from "./openai-options.js"

export const id = ProviderID.make("cloudflare-workers-ai")
export const authEnvVars = ["CLOUDFLARE_API_KEY", "CLOUDFLARE_WORKERS_AI_TOKEN"] as const

type WorkersAIURL = AtLeastOne<{
  readonly accountId: string
  readonly baseURL: string
}>

export type LanguageModelOptions = WorkersAIURL &
  Omit<RouteDefaultsInput, "providerOptions"> &
  ProviderAuthOption<"optional"> & {
    readonly providerOptions?: OpenAIProviderOptionsInput
  }

export type Settings = ProviderPackage.Settings &
  OpenAIProviderOptionsInput &
  WorkersAIURL & {
    readonly apiKey?: string
  }

export const baseURL = (input: WorkersAIURL) => {
  if (input.baseURL) return input.baseURL
  if (!input.accountId)
    throw new ProviderConfigurationError({
      provider: id,
      message: "CloudflareWorkersAI.configure requires accountId unless baseURL is supplied",
    })
  return `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(input.accountId)}/ai/v1`
}

export const route = Route.make({
  id: "cloudflare-workers-ai",
  provider: id,
  providerMetadataKey: "cloudflare-workers-ai",
  protocol: OpenAIChat.protocol,
  endpoint: Endpoint.path("/chat/completions"),
  framing: OpenAIChat.framing,
})

export const routes = [route]

export const configure = (input: LanguageModelOptions) => {
  const { accountId: _accountId, apiKey: _apiKey, auth: _auth, baseURL: _baseURL, ...defaults } = input
  const configured = route.with({
    ...defaults,
    endpoint: { baseURL: baseURL(input) },
    auth: AuthOptions.bearer(input, authEnvVars),
  })
  return {
    id,
    model: (modelID: string | ModelID) => configured.model<OpenAIProviderOptionsInput>({ id: modelID }),
    configure,
  }
}

export const provider = { id, configure }

export const model: ProviderPackage.Definition<Settings, OpenAIProviderOptionsInput>["model"] = (modelID, settings) => {
  const { accountId: _, apiKey, baseURL: _url, body, headers, ...providerOptions } = settings
  return configure({
    apiKey,
    baseURL: baseURL(settings),
    headers: headers === undefined ? undefined : { ...headers },
    http: body === undefined ? undefined : { body: { ...body } },
    providerOptions,
  }).model(modelID)
}

export * as CloudflareWorkersAI from "./cloudflare-workers-ai.js"
