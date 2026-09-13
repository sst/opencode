import { Effect, Schema, Struct } from "effect"
import type { ProviderPackage } from "../provider-package.js"
import { AnthropicMessages } from "../protocols/anthropic-messages.js"
import { Auth } from "../route/auth.js"
import { Route, type RouteDefaultsInput } from "../route/client.js"
import { Endpoint } from "../route/endpoint.js"
import { Protocol } from "../route/protocol.js"
import { ProviderConfigurationError, ProviderID, type ModelID } from "../schema/index.js"
import { GoogleVertexShared } from "./google-vertex-shared.js"

export type AnthropicOptionsInput = AnthropicMessages.OptionsInput
export type AnthropicProviderOptionsInput = AnthropicMessages.ProviderOptionsInput
export type AnthropicThinkingInput = AnthropicMessages.ThinkingInput

const VERSION = "vertex-2023-10-16" as const
const HEADER_VERSION = "2023-06-01" as const

export const id = ProviderID.make("google-vertex")

export type Config = RouteDefaultsInput &
  GoogleVertexShared.OAuthOptions & {
    readonly baseURL?: string
    readonly location?: string
    readonly project?: string
    readonly providerOptions?: AnthropicMessages.ProviderOptionsInput
  }

export type Settings = ProviderPackage.Settings &
  AnthropicMessages.ProviderOptionsInput & {
    readonly accessToken?: string
    readonly apiKey?: never
    readonly baseURL?: string
    readonly location?: string
    readonly project?: string
  }

const route = Route.make({
  id: "google-vertex-messages",
  provider: id,
  providerMetadataKey: "anthropic",
  protocol: Protocol.make({
    id: AnthropicMessages.protocol.id,
    body: {
      schema: Schema.Struct({
        ...Struct.omit(AnthropicMessages.AnthropicMessagesBody.fields, ["model"]),
        anthropic_version: Schema.Literal(VERSION),
      }),
      from: (request) =>
        AnthropicMessages.protocol.body.from(request).pipe(
          Effect.map((body) => ({
            ...Struct.omit(body, ["model"]),
            anthropic_version: VERSION,
          })),
        ),
    },
    stream: AnthropicMessages.protocol.stream,
  }),
  endpoint: Endpoint.path(({ request }) => `/${request.model.id}:streamRawPredict`),
  auth: Auth.none,
  transport: AnthropicMessages.transport<
    Omit<AnthropicMessages.AnthropicMessagesBody, "model"> & { readonly anthropic_version: typeof VERSION }
  >(),
  headers: () => ({ "anthropic-version": HEADER_VERSION }),
})

export const routes = [route]

const configuredRoute = (input: Config) => {
  if ("apiKey" in input && input.apiKey !== undefined)
    throw new ProviderConfigurationError({ provider: id, message: "Google Vertex Messages does not support API keys" })
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
        `https://${GoogleVertexShared.host(location)}/v1/projects/${GoogleVertexShared.requireProject(project)}/locations/${location}/publishers/anthropic/models`,
    },
    auth: GoogleVertexShared.oauth(input, project),
  })
}

export const configure = (input: Config = {}) => {
  const route = configuredRoute(input)
  return {
    id,
    model: (modelID: string | ModelID) => route.model<AnthropicMessages.ProviderOptionsInput>({ id: modelID }),
    configure,
  }
}

export const provider = {
  id,
  configure,
}

export const model: ProviderPackage.Definition<Settings, AnthropicMessages.ProviderOptionsInput>["model"] = (
  modelID,
  { accessToken, apiKey, baseURL, body, headers, location, project, ...providerOptions },
) => {
  if (apiKey !== undefined)
    throw new ProviderConfigurationError({ provider: id, message: "Google Vertex Messages does not support API keys" })
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
