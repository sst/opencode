import type { AnyAuthClient } from "google-auth-library"
import { Effect, Redacted } from "effect"
import { Auth, MissingCredentialError } from "../route/auth.js"
import { ProviderConfigurationError, ProviderID } from "../schema/index.js"

const SCOPE = "https://www.googleapis.com/auth/cloud-platform"
const id = ProviderID.make("google-vertex")

export type OAuthOptions =
  | { readonly accessToken?: string; readonly auth?: never }
  | { readonly accessToken?: never; readonly auth?: Auth.Definition }

export type ApiKeyOptions =
  | (OAuthOptions & { readonly apiKey?: never })
  | { readonly accessToken?: never; readonly apiKey?: string; readonly auth?: never }

export const project = (value?: string) =>
  value ??
  process.env.GOOGLE_VERTEX_PROJECT ??
  process.env.GOOGLE_CLOUD_PROJECT ??
  process.env.GCP_PROJECT ??
  process.env.GCLOUD_PROJECT

export const location = (value: string | undefined, fallback: string) =>
  value ??
  process.env.GOOGLE_VERTEX_LOCATION ??
  process.env.GOOGLE_CLOUD_LOCATION ??
  process.env.VERTEX_LOCATION ??
  fallback

export const host = (location: string) => {
  if (location === "global") return "aiplatform.googleapis.com"
  // Jurisdictional multi-regions use Regional Endpoint Platform domains.
  if (location === "eu" || location === "us") return `aiplatform.${location}.rep.googleapis.com`
  return `${location}-aiplatform.googleapis.com`
}

export const requireProject = (value: string | undefined) => {
  if (value) return value
  throw new ProviderConfigurationError({
    provider: id,
    message: "Google Vertex requires a project when baseURL is not configured",
  })
}

export const apiKey = (input: ApiKeyOptions) => {
  if (input.apiKey !== undefined && (input.accessToken !== undefined || input.auth !== undefined))
    throw new ProviderConfigurationError({
      provider: id,
      message: "Google Vertex apiKey cannot be combined with accessToken or auth",
    })
  if (input.accessToken !== undefined || input.auth !== undefined) return undefined
  return input.apiKey ?? process.env.GOOGLE_VERTEX_API_KEY
}

const adc = (project?: string) => {
  let client: Promise<AnyAuthClient> | undefined
  const loadClient = () => {
    if (client) return client
    client = import("google-auth-library").then(({ GoogleAuth }) =>
      new GoogleAuth({ projectId: project, scopes: [SCOPE] }).getClient(),
    )
    return client
  }
  return Auth.effect(
    Effect.tryPromise({
      try: async () => {
        const token = await (await loadClient()).getAccessToken()
        if (!token.token) throw new Error("Google ADC returned an empty access token")
        return Redacted.make(token.token)
      },
      catch: () => new MissingCredentialError("Google Application Default Credentials"),
    }),
  ).bearer()
}

export const oauth = (input: OAuthOptions, project?: string) => {
  if (input.accessToken !== undefined && input.auth !== undefined)
    throw new ProviderConfigurationError({
      provider: id,
      message: "Google Vertex accessToken cannot be combined with auth",
    })
  if (input.auth) return input.auth
  if (input.accessToken !== undefined) return Auth.bearer(input.accessToken)
  return adc(project)
}

export * as GoogleVertexShared from "./google-vertex-shared.js"
