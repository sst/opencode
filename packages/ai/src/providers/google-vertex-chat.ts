import type { ProviderPackage } from "../provider-package.js"
import { OpenAIChat } from "../protocols/openai-chat.js"
import { Route, type RouteDefaultsInput } from "../route/client.js"
import { Endpoint } from "../route/endpoint.js"
import { ProviderConfigurationError, ProviderID, type ModelID } from "../schema/index.js"
import { GoogleVertexShared } from "./google-vertex-shared.js"
import type { OpenAIProviderOptionsInput } from "./openai-options.js"

export const id = ProviderID.make("google-vertex")

export type Config = RouteDefaultsInput &
  GoogleVertexShared.OAuthOptions & {
    readonly baseURL?: string
    readonly location?: string
    readonly project?: string
    readonly providerOptions?: OpenAIProviderOptionsInput
  }

export type Settings = ProviderPackage.Settings &
  OpenAIProviderOptionsInput & {
    readonly accessToken?: string
    readonly apiKey?: never
    readonly baseURL?: string
    readonly location?: string
    readonly project?: string
  }

const route = Route.make({
  id: "google-vertex-chat",
  provider: id,
  providerMetadataKey: "vertex",
  protocol: OpenAIChat.protocol,
  endpoint: Endpoint.path("/chat/completions"),
  framing: OpenAIChat.framing,
})

export const routes = [route]

const configuredRoute = (input: Config) => {
  if ("apiKey" in input && input.apiKey !== undefined)
    throw new ProviderConfigurationError({ provider: id, message: "Google Vertex Chat does not support API keys" })
  const {
    accessToken: _accessToken,
    auth: _auth,
    baseURL,
    location: inputLocation,
    project: inputProject,
    ...rest
  } = input
  const location = GoogleVertexShared.location(inputLocation, "global")
  const project = GoogleVertexShared.project(inputProject)
  return route.with({
    ...rest,
    endpoint: {
      baseURL:
        baseURL ??
        `https://aiplatform.googleapis.com/v1/projects/${GoogleVertexShared.requireProject(project)}/locations/${location}/endpoints/openapi`,
    },
    auth: GoogleVertexShared.oauth(input, project),
  })
}

export const configure = (input: Config = {}) => {
  const route = configuredRoute(input)
  return {
    id,
    model: (modelID: string | ModelID) => route.model<OpenAIProviderOptionsInput>({ id: modelID }),
    configure,
  }
}

export const provider = {
  id,
  configure,
}

export const model: ProviderPackage.Definition<Settings, OpenAIProviderOptionsInput>["model"] = (
  modelID,
  { accessToken, apiKey, baseURL, body, headers, location, project, ...providerOptions },
) => {
  if (apiKey !== undefined)
    throw new ProviderConfigurationError({ provider: id, message: "Google Vertex Chat does not support API keys" })
  return configure({
    accessToken,
    baseURL,
    headers: headers === undefined ? undefined : { ...headers },
    http: body === undefined ? undefined : { body: { ...body } },
    location,
    project,
    providerOptions,
  }).model(modelID)
}
