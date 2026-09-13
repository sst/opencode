import { Effect } from "effect"
import type { ProviderPackage } from "../provider-package.js"
import { Gemini } from "../protocols/gemini.js"
import { ProviderShared } from "../protocols/shared.js"
import { Auth } from "../route/auth.js"
import { Route, type RouteDefaultsInput } from "../route/client.js"
import { Endpoint } from "../route/endpoint.js"
import { Framing } from "../route/framing.js"
import { ProviderConfigurationError, ProviderID, type LLMRequest, type ModelID } from "../schema/index.js"
import { GoogleVertexShared } from "./google-vertex-shared.js"

export interface GeminiOptionsInput extends Gemini.OptionsInput {
  readonly labels?: Readonly<Record<string, string>>
}

export type GeminiProviderOptionsInput = GeminiOptionsInput

export const id = ProviderID.make("google-vertex")

export type Config = RouteDefaultsInput &
  GoogleVertexShared.ApiKeyOptions & {
    readonly baseURL?: string
    readonly location?: string
    readonly project?: string
    readonly providerOptions?: GeminiProviderOptionsInput
  }

export type Settings = ProviderPackage.Settings &
  GeminiProviderOptionsInput &
  (
    | { readonly accessToken?: string; readonly apiKey?: never }
    | { readonly accessToken?: never; readonly apiKey?: string }
  ) & {
    readonly baseURL?: string
    readonly location?: string
    readonly project?: string
  }

const fromRequest = Effect.fn("GoogleVertex.fromRequest")(function* (request: LLMRequest) {
  const body = yield* Gemini.protocol.body.from(request)
  // Vertex's native REST schema rejects `id` on FunctionCall/FunctionResponse parts with HTTP 400,
  // unlike AI Studio, so history minted there cannot be lowered verbatim.
  const contents = body.contents.map((content) => ({
    ...content,
    parts: (content.parts ?? []).map((part) => {
      if ("functionCall" in part) return { ...part, functionCall: { ...part.functionCall, id: undefined } }
      if ("functionResponse" in part) return { ...part, functionResponse: { ...part.functionResponse, id: undefined } }
      return part
    }),
  }))
  const value = request.providerOptions?.labels
  const labels = ProviderShared.isRecord(value)
    ? Object.fromEntries(
        Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
      )
    : undefined
  return { ...body, contents, labels }
})

const protocol = {
  ...Gemini.protocol,
  body: {
    ...Gemini.protocol.body,
    from: fromRequest,
  },
}

const route = Route.make({
  id: "google-vertex-gemini",
  provider: id,
  providerMetadataKey: "vertex",
  protocol,
  endpoint: Endpoint.path(({ request }) => {
    const model = String(request.model.id)
    return `/${model.startsWith("endpoints/") ? model : `models/${model}`}:streamGenerateContent?alt=sse`
  }),
  auth: Auth.none,
  framing: Framing.sse,
})

export const routes = [route]

const configuredRoute = (input: Config, modelID: string | ModelID) => {
  const {
    accessToken: _accessToken,
    apiKey: _apiKey,
    auth: _auth,
    baseURL,
    location: inputLocation,
    project: inputProject,
    ...rest
  } = input
  const apiKey = GoogleVertexShared.apiKey(input)
  const endpointModel = String(modelID).startsWith("endpoints/")
  if (apiKey !== undefined && endpointModel)
    throw new ProviderConfigurationError({
      provider: id,
      message: "Google Vertex tuned models do not support Express Mode API keys",
    })
  const location = GoogleVertexShared.location(inputLocation, "us-central1")
  const project = GoogleVertexShared.project(inputProject)
  const endpoint =
    baseURL ??
    (apiKey
      ? "https://aiplatform.googleapis.com/v1/publishers/google"
      : `https://${GoogleVertexShared.host(location)}/v1beta1/projects/${GoogleVertexShared.requireProject(project)}/locations/${location}${endpointModel ? "" : "/publishers/google"}`)
  return route.with({
    ...rest,
    endpoint: { baseURL: endpoint },
    auth: apiKey === undefined ? GoogleVertexShared.oauth(input, project) : Auth.header("x-goog-api-key", apiKey),
  })
}

export const configure = (input: Config = {}) => {
  return {
    id,
    model: (modelID: string | ModelID) =>
      configuredRoute(input, modelID).model<GeminiProviderOptionsInput>({ id: modelID }),
    configure,
  }
}

export const provider = {
  id,
  configure,
}
export const model: ProviderPackage.Definition<Settings, GeminiProviderOptionsInput>["model"] = (
  modelID,
  { accessToken, apiKey, baseURL, body, headers, location, project, ...providerOptions },
) => {
  if (apiKey !== undefined && accessToken !== undefined)
    throw new ProviderConfigurationError({
      provider: id,
      message: "Google Vertex apiKey cannot be combined with accessToken or auth",
    })
  return configure({
    ...(apiKey === undefined ? { accessToken: accessToken } : { apiKey: apiKey }),
    baseURL,
    headers: headers === undefined ? undefined : { ...headers },
    http: body === undefined ? undefined : { body: { ...body } },
    location,
    project,
    providerOptions,
  }).model(modelID)
}
