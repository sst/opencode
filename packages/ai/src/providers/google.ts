import type { RouteDefaultsInput } from "../route/client.js"
import { Auth } from "../route/auth.js"
import type { ProviderAuthOption } from "../route/auth-options.js"
import type { ProviderPackage } from "../provider-package.js"
import { HttpOptions, ProviderID, mergeHttpOptions, type ModelID } from "../schema/index.js"
import { Gemini } from "../protocols/gemini.js"
import { GoogleImages } from "../protocols/google-images.js"

export type { GoogleImageOptions } from "../protocols/google-images.js"
export type GeminiOptionsInput = Gemini.OptionsInput
export type GeminiProviderOptionsInput = Gemini.ProviderOptionsInput

export const id = ProviderID.make("google")

export const routes = [Gemini.route]

export type Config = RouteDefaultsInput &
  ProviderAuthOption<"optional"> & {
    readonly baseURL?: string
    readonly providerOptions?: Gemini.ProviderOptionsInput
  }

export type Settings = ProviderPackage.Settings &
  Gemini.ProviderOptionsInput & {
    readonly apiKey?: string
    readonly baseURL?: string
  }

const auth = (options: ProviderAuthOption<"optional">) => {
  if ("auth" in options && options.auth) return options.auth
  return Auth.optional("apiKey" in options ? options.apiKey : undefined, "apiKey")
    .orElse(Auth.config("GOOGLE_GENERATIVE_AI_API_KEY"))
    .pipe(Auth.header("x-goog-api-key"))
}

const configuredRoute = (input: Config) => {
  const { apiKey: _, auth: _auth, baseURL, ...rest } = input
  return Gemini.route.with({ ...rest, endpoint: { baseURL }, auth: auth(input) })
}

export const configure = (input: Config = {}) => {
  const route = configuredRoute(input)
  const image = (modelID: string | ModelID) =>
    GoogleImages.model({
      id: modelID,
      auth: auth(input),
      baseURL: input.baseURL,
      headers: input.headers,
      http: mergeHttpOptions(input.http === undefined ? undefined : HttpOptions.make(input.http)),
    })
  return {
    id,
    model: (modelID: string | ModelID) => route.model<Gemini.ProviderOptionsInput>({ id: modelID }),
    image,
    configure,
  }
}

export const provider = configure()
export const model: ProviderPackage.Definition<Settings, Gemini.ProviderOptionsInput>["model"] = (
  modelID,
  { apiKey, baseURL, body, headers, ...providerOptions },
) =>
  configure({
    apiKey,
    baseURL,
    headers: headers === undefined ? undefined : { ...headers },
    http: body === undefined ? undefined : { body: { ...body } },
    providerOptions,
  }).model(modelID)

export const image = provider.image
