import type { ProviderPackage } from "../provider-package.js"
import { AnthropicMessages } from "../protocols/anthropic-messages.js"
import { OpenAIChat } from "../protocols/openai-chat.js"
import { OpenResponses } from "../protocols/open-responses.js"
import { ZAIChat } from "../protocols/zai-chat.js"
import { ZAIMessages } from "../protocols/zai-messages.js"
import { AuthOptions, type ProviderAuthOption } from "../route/auth-options.js"
import { Route, type RouteDefaultsInput } from "../route/client.js"
import { Endpoint } from "../route/endpoint.js"
import { Framing } from "../route/framing.js"
import { ProviderID, type ModelID } from "../schema/index.js"

export const id = ProviderID.make("zai-coding-plan")

export type ChatOptionsInput = ZAIChat.OptionsInput
export type MessagesOptionsInput = ZAIMessages.OptionsInput
export type ResponsesOptionsInput = { readonly reasoningEffort?: ZAIChat.ReasoningEffort }

export type Config = Omit<RouteDefaultsInput, "providerOptions"> &
  ProviderAuthOption<"optional"> & {
    /** Overrides the selected API's complete base URL. */
    readonly baseURL?: string
    readonly providerOptions?: ChatOptionsInput | MessagesOptionsInput | ResponsesOptionsInput
  }

export type Settings<Options = ChatOptionsInput> = ProviderPackage.Settings &
  Options & {
    readonly apiKey?: string
    readonly baseURL?: string
  }

const chatRoute = Route.make({
  id: "zai-coding-chat",
  provider: id,
  providerMetadataKey: "zai",
  protocol: ZAIChat.protocol,
  endpoint: Endpoint.path("/chat/completions", { baseURL: "https://api.z.ai/api/coding/paas/v4" }),
  framing: OpenAIChat.framing,
})
const messagesRoute = Route.make({
  id: "zai-coding-messages",
  provider: id,
  providerMetadataKey: "zai",
  protocol: ZAIMessages.protocol,
  endpoint: Endpoint.path("/messages", { baseURL: "https://api.z.ai/api/anthropic/v1" }),
  framing: AnthropicMessages.framing,
  headers: () => ({ "anthropic-version": "2023-06-01" }),
})
const responsesRoute = Route.make({
  id: "zai-coding-responses",
  provider: id,
  providerMetadataKey: "zai",
  protocol: OpenResponses.protocol,
  endpoint: Endpoint.path("/responses", { baseURL: "https://api.z.ai/api/v1" }),
  framing: Framing.sse,
})

export const routes = [chatRoute, messagesRoute, responsesRoute]

export const configure = (input: Config = {}) => {
  const { apiKey: _apiKey, auth: _auth, baseURL, ...rest } = input
  const defaults = {
    ...rest,
    endpoint: baseURL === undefined ? undefined : { baseURL },
    auth: AuthOptions.bearer(input, "ZAI_API_KEY"),
  }
  const chat = (modelID: string | ModelID) =>
    chatRoute.with(defaults).model<ChatOptionsInput>({ id: modelID, compatibility: ZAIChat.compatibility })
  const messages = (modelID: string | ModelID) =>
    messagesRoute
      .with(defaults)
      .model<MessagesOptionsInput>({ id: modelID, compatibility: { requireSignature: false } })
  const responses = (modelID: string | ModelID) =>
    responsesRoute.with(defaults).model<ResponsesOptionsInput>({ id: modelID })
  return { id, model: chat, chat, messages, responses, configure }
}

export const provider = configure()
export const chat = provider.chat
export const messages = provider.messages
export const responses = provider.responses

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

export * as ZAICodingPlan from "./zai-coding-plan.js"
