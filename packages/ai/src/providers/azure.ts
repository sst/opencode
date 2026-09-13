import { Headers } from "effect/unstable/http"
import { Auth } from "../route/auth.js"
import { type AtLeastOne, type ProviderAuthOption } from "../route/auth-options.js"
import type { Route, RouteDefaultsInput, CompactionOperations } from "../route/client.js"
import type { ProviderPackage } from "../provider-package.js"
import { ProviderConfigurationError, ProviderID, type ModelID } from "../schema/index.js"
import * as OpenAIChat from "../protocols/openai-chat.js"
import * as OpenAIResponses from "../protocols/openai-responses.js"
import { ProviderShared } from "../protocols/shared.js"
import { withOpenAIOptions, type OpenAIProviderOptionsInput } from "./openai-options.js"

export const id = ProviderID.make("azure")
const routeAuth = Auth.remove("authorization")
const RESPONSES_WEBSOCKET_ROTATE_AFTER_MS = 55 * 60 * 1000

// Azure needs the customer's resource URL; supply either `resourceName`
// (helper builds the URL) or `baseURL` directly.
type AzureURL = AtLeastOne<{ readonly resourceName: string; readonly baseURL: string }>

export type LanguageModelOptions = AzureURL &
  RouteDefaultsInput &
  ProviderAuthOption<"optional"> & {
    readonly apiVersion?: string
    readonly queryParams?: Record<string, string>
    readonly useDeploymentBasedUrls?: boolean
    readonly providerOptions?: OpenAIProviderOptionsInput
  }
export type Config = LanguageModelOptions

export type Settings = ProviderPackage.Settings &
  OpenAIProviderOptionsInput &
  AzureURL & {
    readonly apiKey?: string
    readonly apiVersion?: string
    readonly queryParams?: Readonly<Record<string, string>>
    readonly useDeploymentBasedUrls?: boolean
  }

const resourceBaseURL = (resourceName: string) => `https://${resourceName.trim()}.openai.azure.com/openai`

const responsesRoute = OpenAIResponses.route.with({
  compact: { endpoint: OpenAIResponses.route.compact.endpoint },
  id: "azure-openai-responses",
  provider: id,
  auth: routeAuth,
  transport: OpenAIResponses.channelTransport({
    id: "azure-openai-responses",
    name: "Azure OpenAI Responses",
    rotateAfterMs: RESPONSES_WEBSOCKET_ROTATE_AFTER_MS,
    enabled: (value) => {
      const url = new URL(value)
      return (
        url.protocol === "https:" &&
        url.hostname.endsWith(".openai.azure.com") &&
        url.pathname.endsWith("/openai/v1/responses") &&
        url.searchParams.get("api-version") === "v1"
      )
    },
    url: (value) => {
      const url = new URL(value)
      url.searchParams.delete("api-version")
      return url.toString()
    },
    headers: (headers) => {
      const apiKey = headers["api-key"]
      if (!apiKey) return headers
      return Headers.remove(Headers.set(headers, "authorization", `Bearer ${apiKey}`), "api-key")
    },
  }),
})

const chatRoute = OpenAIChat.route.with({
  id: "azure-openai-chat",
  provider: id,
  auth: routeAuth,
})

export const routes = [responsesRoute, chatRoute]

const defaults = (input: Config) => {
  const {
    apiKey: _,
    apiVersion: _apiVersion,
    resourceName: _resourceName,
    useDeploymentBasedUrls: _useDeploymentBasedUrls,
    baseURL: _baseURL,
    queryParams: _queryParams,
    ...rest
  } = input
  if ("auth" in rest) {
    const { auth: _, ...withoutAuth } = rest
    return withoutAuth
  }
  return rest
}

const auth = (input: Config) => {
  if ("auth" in input && input.auth) return input.auth
  return Auth.remove("authorization").andThen(
    Auth.optional("apiKey" in input ? input.apiKey : undefined, "apiKey")
      .orElse(Auth.config("AZURE_OPENAI_API_KEY"))
      .pipe(Auth.header("api-key")),
  )
}

const configuredRoute = <Body, Prepared, Compact extends CompactionOperations | undefined>(
  route: Route<Body, Prepared, Compact>,
  input: Config,
  modelID: string | ModelID,
) =>
  route.with({
    auth: auth(input),
    endpoint: endpoint(input, modelID),
  })

function endpoint(input: Config, modelID: string | ModelID) {
  const baseURL = ProviderShared.trimBaseUrl(input.baseURL ?? resourceBaseURL(input.resourceName!))
  const query = { "api-version": input.apiVersion ?? "v1", ...input.queryParams }

  if (input.useDeploymentBasedUrls) return { baseURL: `${baseURL}/deployments/${modelID}`, query }
  if (input.baseURL !== undefined && !new URL(input.baseURL).hostname.endsWith(".openai.azure.com")) {
    return { baseURL, query: input.queryParams }
  }
  return { baseURL: `${baseURL}/v1`, query }
}

export const configure = (input: Config) => {
  const modelDefaults = defaults(input)

  const responses = (modelID: string | ModelID) =>
    configuredRoute(responsesRoute, input, modelID)
      .with(withOpenAIOptions(modelID, modelDefaults))
      .model<OpenAIProviderOptionsInput>({ id: modelID })

  const chat = (modelID: string | ModelID) =>
    configuredRoute(chatRoute, input, modelID)
      .with(withOpenAIOptions(modelID, modelDefaults))
      .model<OpenAIProviderOptionsInput>({ id: modelID })

  return {
    id,
    model: responses,
    responses,
    chat,
    configure,
  }
}

export const provider = {
  id,
  configure,
}

const config = ({
  apiKey,
  apiVersion,
  baseURL,
  body,
  headers,
  queryParams,
  resourceName,
  useDeploymentBasedUrls,
  ...providerOptions
}: Settings): Config => {
  const common = {
    apiKey,
    apiVersion,
    headers: headers === undefined ? undefined : { ...headers },
    http: body === undefined ? undefined : { body: { ...body } },
    providerOptions,
    queryParams: queryParams === undefined ? undefined : { ...queryParams },
    useDeploymentBasedUrls,
  }
  if (baseURL !== undefined) return { ...common, baseURL }
  if (resourceName !== undefined) return { ...common, resourceName }
  throw new ProviderConfigurationError({ provider: id, message: "Azure requires resourceName or baseURL" })
}

export const responsesModel: ProviderPackage.Definition<
  Settings,
  OpenAIProviderOptionsInput,
  typeof responsesRoute.compact
>["model"] = (modelID, settings) => configure(config(settings)).responses(modelID)
export const chatModel: ProviderPackage.Definition<Settings, OpenAIProviderOptionsInput>["model"] = (
  modelID,
  settings,
) => configure(config(settings)).chat(modelID)
export const model = responsesModel
