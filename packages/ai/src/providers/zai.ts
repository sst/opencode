import type { ProviderPackage } from "../provider-package.js"
import { ZAIChat } from "../protocols/zai-chat.js"
import { ZAIImages } from "../protocols/zai-images.js"
import { OpenAIChat } from "../protocols/openai-chat.js"
import { AuthOptions, type ProviderAuthOption } from "../route/auth-options.js"
import { Route, type RouteDefaultsInput } from "../route/client.js"
import { Endpoint } from "../route/endpoint.js"
import { HttpOptions, ProviderID, type ModelID } from "../schema/index.js"

export const id = ProviderID.make("zai")

export type ChatOptionsInput = ZAIChat.OptionsInput

export type Config = Omit<RouteDefaultsInput, "providerOptions"> &
  ProviderAuthOption<"optional"> & {
    readonly baseURL?: string
    readonly providerOptions?: ChatOptionsInput
  }

export type Settings = ProviderPackage.Settings &
  ChatOptionsInput & {
    readonly apiKey?: string
    readonly baseURL?: string
  }

export type { ZAIImageOptions } from "../protocols/zai-images.js"

const auth = (options: ProviderAuthOption<"optional">) => AuthOptions.bearer(options, "ZAI_API_KEY")

const chatRoute = Route.make({
  id: "zai-chat",
  provider: id,
  providerMetadataKey: "zai",
  protocol: ZAIChat.protocol,
  endpoint: Endpoint.path("/chat/completions", { baseURL: "https://api.z.ai/api/paas/v4" }),
  framing: OpenAIChat.framing,
})

export const routes = [chatRoute]

export const configure = (input: Config = {}) => {
  const { apiKey: _apiKey, auth: _auth, baseURL, ...rest } = input
  const chat = (modelID: string | ModelID) =>
    chatRoute
      .with({
        ...rest,
        endpoint: baseURL === undefined ? undefined : { baseURL },
        auth: auth(input),
      })
      .model<ChatOptionsInput>({ id: modelID, compatibility: ZAIChat.compatibility })
  const image = (modelID: string | ModelID) =>
    ZAIImages.model({
      id: modelID,
      auth: auth(input),
      baseURL: input.baseURL,
      headers: input.headers,
      http: input.http === undefined ? undefined : HttpOptions.make(input.http),
    })

  return {
    id,
    model: chat,
    chat,
    image,
    configure,
  }
}

export const provider = configure()
export const image = provider.image
export const chat = provider.chat

export const model: ProviderPackage.Definition<Settings, ChatOptionsInput>["model"] = (
  modelID,
  { apiKey, baseURL, body, headers, ...providerOptions },
) =>
  configure({
    apiKey,
    baseURL,
    headers,
    http: body === undefined ? undefined : { body: { ...body } },
    providerOptions,
  }).model(modelID)

export * as ZAI from "./zai.js"
