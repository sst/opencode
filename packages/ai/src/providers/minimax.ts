import { Effect, Schema } from "effect"
import type { ProviderPackage } from "../provider-package.js"
import { AnthropicMessages } from "../protocols/anthropic-messages.js"
import { OpenAIChat } from "../protocols/openai-chat.js"
import { OpenResponses } from "../protocols/open-responses.js"
import { ProviderShared } from "../protocols/shared.js"
import { AuthOptions, type ProviderAuthOption } from "../route/auth-options.js"
import { Route, type RouteDefaultsInput } from "../route/client.js"
import { Endpoint } from "../route/endpoint.js"
import { Framing } from "../route/framing.js"
import { Protocol } from "../route/protocol.js"
import { ProviderID, type LLMRequest, type ModelID } from "../schema/index.js"

export const id = ProviderID.make("minimax")

export type MessagesOptionsInput = {
  /** M3 defaults to disabled; M2.x always thinks. */
  readonly thinking?: { readonly type: "adaptive" | "disabled" }
  readonly metadata?: AnthropicMessages.OptionsInput["metadata"]
}

export type ChatOptionsInput = {
  /** M3 defaults to adaptive; M2.x always thinks. */
  readonly thinking?: { readonly type: "adaptive" | "disabled" | (string & {}) }
  /** Separates reasoning from text. Defaults to true. */
  readonly reasoningSplit?: boolean
}

export type ResponsesOptionsInput = {
  /** M3 defaults to none. Other supported values enable thinking without changing its depth. */
  readonly reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | (string & {})
}

export type ProviderOptionsInput = MessagesOptionsInput | ChatOptionsInput | ResponsesOptionsInput

export type Config = Omit<RouteDefaultsInput, "providerOptions"> &
  ProviderAuthOption<"optional"> & {
    /** Overrides the selected API's base URL, including its version prefix. */
    readonly baseURL?: string
    readonly providerOptions?: ProviderOptionsInput
  }

export type Settings<Options = MessagesOptionsInput> = ProviderPackage.Settings &
  Options & {
    readonly apiKey?: string
    readonly baseURL?: string
  }

const ChatOptions = Schema.Struct({
  thinking: Schema.optional(Schema.Struct({ type: Schema.String })),
  reasoningSplit: Schema.optional(Schema.Boolean),
})

const chatProtocol = Protocol.make({
  id: "minimax-chat",
  body: {
    schema: Schema.Struct({
      ...OpenAIChat.bodyFields,
      thinking: ChatOptions.fields.thinking,
      reasoning_split: Schema.Boolean,
    }),
    from: Effect.fn("MiniMax.chatFromRequest")(function* (request: LLMRequest) {
      const options = yield* ProviderShared.validateWith(Schema.decodeUnknownEffect(ChatOptions))(
        request.providerOptions ?? {},
      )
      return {
        ...(yield* OpenAIChat.protocol.body.from(request)),
        thinking: options.thinking,
        // MiniMax otherwise embeds <think> tags in ordinary assistant text.
        reasoning_split: options.reasoningSplit ?? true,
      }
    }),
  },
  stream: OpenAIChat.protocol.stream,
})

const messagesRoute = Route.make({
  id: "minimax-messages",
  provider: id,
  providerMetadataKey: "minimax",
  protocol: AnthropicMessages.protocol,
  endpoint: Endpoint.path("/messages", { baseURL: "https://api.minimax.io/anthropic/v1" }),
  framing: AnthropicMessages.framing,
  headers: () => ({ "anthropic-version": "2023-06-01" }),
})

const chatRoute = Route.make({
  id: "minimax-chat",
  provider: id,
  providerMetadataKey: "minimax",
  protocol: chatProtocol,
  endpoint: Endpoint.path("/chat/completions", { baseURL: "https://api.minimax.io/v1" }),
  framing: OpenAIChat.framing,
})

const responsesRoute = Route.make({
  id: "minimax-responses",
  provider: id,
  providerMetadataKey: "minimax",
  protocol: OpenResponses.protocol,
  endpoint: Endpoint.path("/responses", { baseURL: "https://api.minimax.io/v1" }),
  framing: Framing.sse,
})

export const routes = [messagesRoute, chatRoute, responsesRoute]

export const configure = (input: Config = {}) => {
  const { apiKey: _apiKey, auth: _auth, baseURL, ...rest } = input
  const defaults = {
    ...rest,
    endpoint: baseURL === undefined ? undefined : { baseURL },
    auth: AuthOptions.bearer(input, "MINIMAX_API_KEY"),
  }
  const messages = (modelID: string | ModelID) =>
    messagesRoute.with(defaults).model<MessagesOptionsInput>({ id: modelID })
  const chat = (modelID: string | ModelID) =>
    chatRoute.with(defaults).model<ChatOptionsInput>({
      id: modelID,
      compatibility: { supportsStore: false, supportsStrictMode: false },
    })
  const responses = (modelID: string | ModelID) =>
    responsesRoute.with(defaults).model<ResponsesOptionsInput>({ id: modelID })
  return { id, model: messages, messages, chat, responses, configure }
}

export const provider = configure()

export const model: ProviderPackage.Definition<Settings<MessagesOptionsInput>, MessagesOptionsInput>["model"] = (
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

export const messages = provider.messages
export const chat = provider.chat
export const responses = provider.responses

export * as MiniMax from "./minimax.js"
