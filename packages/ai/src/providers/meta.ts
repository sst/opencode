import type { ProviderPackage } from "../provider-package.js"
import { OpenAIChat } from "../protocols/openai-chat.js"
import { AnthropicMessages } from "../protocols/anthropic-messages.js"
import { MetaResponses } from "../protocols/meta-responses.js"
import { MetaMessages } from "../protocols/meta-messages.js"
import { MetaImages } from "../protocols/meta-images.js"
import { AuthOptions, type ProviderAuthOption } from "../route/auth-options.js"
import { Route, type RouteDefaultsInput } from "../route/client.js"
import { Endpoint } from "../route/endpoint.js"
import { HttpOptions, ProviderID, ToolDefinition, type ModelID } from "../schema/index.js"
import type { OpenResponsesProviderOptionsInput } from "./open-responses-options.js"

export const id = ProviderID.make("meta")
const baseURL = "https://api.meta.ai/v1"

export type ProviderOptionsInput = OpenResponsesProviderOptionsInput &
  Pick<AnthropicMessages.OptionsInput, "thinking" | "effort">
export type MessagesOptionsInput = Pick<
  AnthropicMessages.OptionsInput,
  "thinking" | "effort" | "outputConfig" | "output_config" | "serviceTier" | "service_tier" | "metadata"
> & { readonly [key: string]: unknown }
export type ImageOptions = MetaImages.ImageOptions

export interface WebSearchOptions {
  readonly searchContextSize?: "low" | "medium" | "high" | (string & {})
  readonly userLocation?: {
    readonly city?: string
    readonly region?: string
    readonly country?: string
    readonly timezone?: string
  }
}

export const webSearch = (options: WebSearchOptions = {}) =>
  ToolDefinition.make({
    name: "web_search",
    description: "Search the web with Meta's hosted search tool.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    native: {
      meta: {
        type: "web_search",
        search_context_size: options.searchContextSize,
        user_location:
          options.userLocation === undefined ? undefined : { type: "approximate", ...options.userLocation },
      },
    },
  })

export interface ImageGenerationOptions {
  readonly size?: string
  readonly outputFormat?: "webp" | "png" | "jpeg" | (string & {})
  readonly reasoningStrength?: "low" | "high" | (string & {})
  readonly enableImageSearch?: boolean
  readonly enableWebSearch?: boolean
  readonly enableShell?: boolean
}

export const imageGeneration = (options: ImageGenerationOptions = {}) =>
  ToolDefinition.make({
    name: "image_generation",
    description: "Generate or edit an image with Muse Image.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    native: {
      meta: {
        type: "image_generation",
        size: options.size,
        output_format: options.outputFormat,
        reasoning_strength: options.reasoningStrength,
        enable_image_search: options.enableImageSearch,
        enable_web_search: options.enableWebSearch,
        enable_shell: options.enableShell,
      },
    },
  })

export type LanguageModelOptions = Omit<RouteDefaultsInput, "providerOptions"> &
  ProviderAuthOption<"optional"> & {
    readonly baseURL?: string
    readonly providerOptions?: ProviderOptionsInput
  }

export type Settings = ProviderPackage.Settings &
  ProviderOptionsInput & {
    readonly apiKey?: string
    readonly baseURL?: string
  }

const responsesRoute = Route.make({
  id: "meta-responses",
  provider: id,
  providerMetadataKey: "meta",
  protocol: MetaResponses.protocol,
  endpoint: Endpoint.path("/responses", { baseURL }),
  // Meta Responses does not support WebSocket upgrades; always use HTTP/SSE.
  transport: MetaResponses.httpTransport,
  defaults: { providerOptions: { store: false, include: ["reasoning.encrypted_content"] } },
})

const chatRoute = Route.make({
  id: "meta-chat",
  provider: id,
  providerMetadataKey: "meta",
  protocol: OpenAIChat.protocol,
  endpoint: Endpoint.path("/chat/completions", { baseURL }),
  framing: OpenAIChat.framing,
})

const messagesRoute = Route.make({
  id: "meta-messages",
  provider: id,
  providerMetadataKey: "meta",
  protocol: MetaMessages.protocol,
  endpoint: Endpoint.path("/messages", { baseURL }),
  framing: AnthropicMessages.framing,
  defaults: { providerOptions: { thinking: { type: "adaptive", display: "omitted" } } },
})

export const routes = [responsesRoute, chatRoute, messagesRoute]

export const configure = (input: LanguageModelOptions = {}) => {
  const { apiKey: _apiKey, auth: _auth, baseURL: endpoint, ...defaults } = input
  const options = {
    ...defaults,
    endpoint: { baseURL: endpoint ?? baseURL },
    auth: AuthOptions.bearer(input, "META_API_KEY"),
  }
  const configuredResponses = responsesRoute.with(options)
  const configuredChat = chatRoute.with(options)
  const configuredMessages = messagesRoute.with(options)
  const responses = (modelID: string | ModelID) =>
    configuredResponses.model<OpenResponsesProviderOptionsInput>({ id: modelID })
  const chat = (modelID: string | ModelID) =>
    configuredChat.model<OpenResponsesProviderOptionsInput>({
      id: modelID,
      compatibility: { maxTokensField: "max_completion_tokens", supportsStore: false },
    })
  const messages = (modelID: string | ModelID) =>
    configuredMessages.model<MessagesOptionsInput>({
      id: modelID,
      compatibility: { requireSignature: false },
    })
  const image = (modelID: string | ModelID) =>
    MetaImages.model({
      id: modelID,
      baseURL: endpoint ?? baseURL,
      auth: options.auth,
      headers: input.headers,
      http: input.http === undefined ? undefined : HttpOptions.make(input.http),
    })
  return { id, model: responses, responses, chat, messages, image, configure }
}

export const provider = configure()
export const responses = provider.responses
export const chat = provider.chat
export const messages = provider.messages
export const image = provider.image

export const model: ProviderPackage.Definition<Settings, OpenResponsesProviderOptionsInput>["model"] = (
  modelID,
  settings,
) => fromSettings(settings).responses(modelID)

export const chatModel: ProviderPackage.Definition<Settings, OpenResponsesProviderOptionsInput>["model"] = (
  modelID,
  settings,
) => fromSettings(settings).chat(modelID)

export const messagesModel: ProviderPackage.Definition<Settings, MessagesOptionsInput>["model"] = (modelID, settings) =>
  fromSettings(settings).messages(modelID)

function fromSettings({ apiKey, baseURL, body, headers, ...providerOptions }: Settings) {
  return configure({
    apiKey,
    baseURL,
    headers,
    http: body === undefined ? undefined : { body: { ...body } },
    providerOptions,
  })
}

export * as Meta from "./meta.js"
