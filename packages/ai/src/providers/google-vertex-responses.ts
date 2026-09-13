import type { ProviderPackage } from "../provider-package.js"
import { OpenResponses } from "../protocols/open-responses.js"
import { Route, type RouteDefaultsInput } from "../route/client.js"
import { Endpoint } from "../route/endpoint.js"
import { ProviderConfigurationError, ProviderID, type ModelID } from "../schema/index.js"
import { GoogleVertexShared } from "./google-vertex-shared.js"
import type { OpenResponsesProviderOptionsInput } from "./open-responses-options.js"

export const id = ProviderID.make("google-vertex")

export type Config = RouteDefaultsInput &
  GoogleVertexShared.OAuthOptions & {
    readonly baseURL?: string
    readonly location?: string
    readonly project?: string
    readonly providerOptions?: OpenResponsesProviderOptionsInput
  }

export type Settings = ProviderPackage.Settings &
  OpenResponsesProviderOptionsInput & {
    readonly accessToken?: string
    readonly apiKey?: never
    readonly baseURL?: string
    readonly location?: string
    readonly project?: string
  }

const route = Route.make({
  id: "google-vertex-responses",
  provider: id,
  providerMetadataKey: "vertex",
  protocol: OpenResponses.protocol,
  endpoint: Endpoint.path(OpenResponses.PATH),
  transport: OpenResponses.httpTransport,
  defaults: { providerOptions: { store: false, include: ["reasoning.encrypted_content"] } },
})

export const routes = [route]

const configuredRoute = (input: Config) => {
  if ("apiKey" in input && input.apiKey !== undefined)
    throw new ProviderConfigurationError({ provider: id, message: "Google Vertex Responses does not support API keys" })
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
  { accessToken, apiKey, baseURL, body, headers, location, project, ...providerOptions },
) => {
  if (apiKey !== undefined)
    throw new ProviderConfigurationError({ provider: id, message: "Google Vertex Responses does not support API keys" })
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
