import type { Config, Redacted } from "effect"
import type { ProviderPackage } from "../provider-package.js"
import { OpenAIChat } from "../protocols/openai-chat.js"
import { Auth } from "../route/auth.js"
import type { AtLeastOne, ProviderAuthOption } from "../route/auth-options.js"
import { Route, type RouteDefaultsInput } from "../route/client.js"
import { Endpoint } from "../route/endpoint.js"
import { ProviderConfigurationError, ProviderID, type ModelID } from "../schema/index.js"
import type { OpenAIProviderOptionsInput } from "./openai-options.js"

export const id = ProviderID.make("cloudflare-ai-gateway")
export const authEnvVars = ["CLOUDFLARE_API_TOKEN", "CF_AIG_TOKEN"] as const

type GatewayURL = AtLeastOne<{
  readonly accountId: string
  readonly baseURL: string
}> & {
  readonly gatewayId?: string
}

export type LanguageModelOptions = GatewayURL &
  Omit<RouteDefaultsInput, "providerOptions"> &
  ProviderAuthOption<"optional"> & {
    /** Cloudflare AI Gateway authentication token. Sent as `cf-aig-authorization`. */
    readonly gatewayApiKey?: string | Redacted.Redacted | Config.Config<string | Redacted.Redacted>
    readonly providerOptions?: OpenAIProviderOptionsInput
  }

export type Settings = ProviderPackage.Settings &
  OpenAIProviderOptionsInput &
  GatewayURL & {
    readonly apiKey?: string
    readonly gatewayApiKey?: string
  }

export const baseURL = (input: GatewayURL) => {
  if (input.baseURL) return input.baseURL
  if (!input.accountId)
    throw new ProviderConfigurationError({
      provider: id,
      message: "CloudflareAIGateway.configure requires accountId unless baseURL is supplied",
    })
  return `https://gateway.ai.cloudflare.com/v1/${encodeURIComponent(input.accountId)}/${encodeURIComponent(input.gatewayId?.trim() || "default")}/compat`
}

const auth = (input: LanguageModelOptions) => {
  if ("auth" in input && input.auth) return input.auth
  const gateway = Auth.optional(input.gatewayApiKey, "gatewayApiKey")
    .orElse(Auth.config(authEnvVars[0]))
    .orElse(Auth.config(authEnvVars[1]))
    .pipe(Auth.bearerHeader("cf-aig-authorization"))
  if (!("apiKey" in input) || input.apiKey === undefined) return gateway
  if (input.gatewayApiKey === undefined) return Auth.bearer(input.apiKey)
  return Auth.bearerHeader("cf-aig-authorization", input.gatewayApiKey).andThen(Auth.bearer(input.apiKey))
}

export const route = Route.make({
  id: "cloudflare-ai-gateway",
  provider: id,
  providerMetadataKey: "cloudflare-ai-gateway",
  protocol: OpenAIChat.protocol,
  endpoint: Endpoint.path("/chat/completions"),
  framing: OpenAIChat.framing,
})

export const routes = [route]

export const configure = (input: LanguageModelOptions) => {
  const {
    accountId: _accountId,
    gatewayId: _gatewayId,
    apiKey: _apiKey,
    gatewayApiKey: _gatewayApiKey,
    baseURL: _baseURL,
    auth: _auth,
    ...defaults
  } = input
  const configured = route.with({
    ...defaults,
    endpoint: { baseURL: baseURL(input) },
    auth: auth(input),
  })
  return {
    id,
    model: (modelID: string | ModelID) => configured.model<OpenAIProviderOptionsInput>({ id: modelID }),
    configure,
  }
}

export const provider = { id, configure }

export const model: ProviderPackage.Definition<Settings, OpenAIProviderOptionsInput>["model"] = (modelID, settings) => {
  const {
    accountId: _,
    apiKey,
    baseURL: _url,
    body,
    gatewayApiKey,
    gatewayId: _id,
    headers,
    ...providerOptions
  } = settings
  return configure({
    apiKey,
    gatewayApiKey,
    baseURL: baseURL(settings),
    headers: headers === undefined ? undefined : { ...headers },
    http: body === undefined ? undefined : { body: { ...body } },
    providerOptions,
  }).model(modelID)
}

export * as CloudflareAIGateway from "./cloudflare-ai-gateway.js"
