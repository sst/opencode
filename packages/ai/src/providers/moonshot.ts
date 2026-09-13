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

export const id = ProviderID.make("moonshotai")

export type ReasoningEffort = "low" | "high" | "max" | (string & {})

export type ChatOptionsInput = {
  /** K3 always reasons; omitted effort uses the model's default. */
  readonly reasoningEffort?: ReasoningEffort
  /** K2.6 supports disabling thinking; K2.7 Code always thinks and preserves reasoning. */
  readonly thinking?: {
    readonly type: "enabled" | "disabled" | (string & {})
    readonly keep?: "all" | (string & {}) | null
  }
}

export type MessagesOptionsInput = {
  readonly effort?: ReasoningEffort
  readonly metadata?: AnthropicMessages.OptionsInput["metadata"]
}

export type ResponsesOptionsInput = {
  readonly reasoningEffort?: ReasoningEffort
  readonly safetyIdentifier?: string
}

export type Config = Omit<RouteDefaultsInput, "providerOptions"> &
  ProviderAuthOption<"optional"> & {
    /** Overrides the selected API's base URL, including its version prefix. */
    readonly baseURL?: string
    readonly providerOptions?: ChatOptionsInput | MessagesOptionsInput | ResponsesOptionsInput
  }

export type Settings<Options = ChatOptionsInput> = ProviderPackage.Settings &
  Options & {
    readonly apiKey?: string
    readonly baseURL?: string
  }

const ChatOptions = Schema.Struct({
  reasoningEffort: Schema.optional(Schema.String),
  thinking: Schema.optional(
    Schema.Struct({ type: Schema.String, keep: Schema.optional(Schema.NullOr(Schema.String)) }),
  ),
})

const chatProtocol = Protocol.make({
  id: "moonshot-chat",
  body: {
    schema: Schema.Struct({ ...OpenAIChat.bodyFields, thinking: ChatOptions.fields.thinking }),
    from: Effect.fn("Moonshot.chatFromRequest")(function* (request: LLMRequest) {
      const options = yield* ProviderShared.validateWith(Schema.decodeUnknownEffect(ChatOptions))(
        request.providerOptions ?? {},
      )
      return { ...(yield* OpenAIChat.protocol.body.from(request)), thinking: options.thinking }
    }),
  },
  stream: OpenAIChat.protocol.stream,
})

const chatRoute = Route.make({
  id: "moonshot-chat",
  provider: id,
  providerMetadataKey: "moonshot",
  protocol: chatProtocol,
  endpoint: Endpoint.path("/chat/completions", { baseURL: "https://api.moonshot.ai/v1" }),
  framing: OpenAIChat.framing,
})

const messagesRoute = Route.make({
  id: "moonshot-messages",
  provider: id,
  providerMetadataKey: "moonshot",
  protocol: AnthropicMessages.protocol,
  endpoint: Endpoint.path("/messages", { baseURL: "https://api.moonshot.ai/anthropic/v1" }),
  framing: AnthropicMessages.framing,
})

const responsesRoute = Route.make({
  id: "moonshot-responses",
  provider: id,
  providerMetadataKey: "moonshot",
  protocol: OpenResponses.protocol,
  endpoint: Endpoint.path("/responses", { baseURL: "https://api.moonshot.ai/v1" }),
  framing: Framing.sse,
})

export const routes = [chatRoute, messagesRoute, responsesRoute]

export const configure = (input: Config = {}) => {
  const { apiKey: _apiKey, auth: _auth, baseURL, ...rest } = input
  const defaults = {
    ...rest,
    endpoint: baseURL === undefined ? undefined : { baseURL },
    auth: AuthOptions.bearer(input, ["MOONSHOT_API_KEY", "MOONSHOTAI_API_KEY"]),
  }
  const chat = (modelID: string | ModelID) =>
    chatRoute.with(defaults).model<ChatOptionsInput>({
      id: modelID,
      compatibility: {
        maxTokensField: "max_tokens",
        supportsStore: false,
        supportsStrictMode: false,
        toolSchema: "moonshot",
        reasoningField: "reasoning_content",
      },
    })
  const messages = (modelID: string | ModelID) =>
    messagesRoute.with(defaults).model<MessagesOptionsInput>({
      id: modelID,
      compatibility: { requireSignature: false, toolSchema: "moonshot" },
    })
  const responses = (modelID: string | ModelID) =>
    responsesRoute
      .with(defaults)
      .model<ResponsesOptionsInput>({ id: modelID, compatibility: { toolSchema: "moonshot" } })
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

export * as Moonshot from "./moonshot.js"
