import { AuthOptions, type ProviderAuthOption } from "../route/auth-options.js"
import type { Route, RouteDefaultsInput, CompactionOperations } from "../route/client.js"
import type { ProviderPackage } from "../provider-package.js"
import { HttpOptions, ProviderID, ToolDefinition, mergeHttpOptions, type ModelID } from "../schema/index.js"
import * as OpenAIChat from "../protocols/openai-chat.js"
import * as OpenAIResponses from "../protocols/openai-responses.js"
import { withOpenAIOptions, type OpenAIProviderOptionsInput } from "./openai-options.js"
import { OpenAIImages, type OpenAIImageString } from "../protocols/openai-images.js"

export type { OpenAIOptionsInput, OpenAIResponseIncludable } from "./openai-options.js"
export type { OpenAIImageOptions } from "../protocols/openai-images.js"

export const id = ProviderID.make("openai")

export const routes = [OpenAIResponses.route, OpenAIChat.route]

// This provider facade wraps the lower-level Responses and Chat model factories
// with OpenAI-specific conveniences: typed options, API-key sugar, env fallback,
// and default option normalization.
export type Config = RouteDefaultsInput &
  ProviderAuthOption<"optional"> & {
    readonly baseURL?: string
    readonly queryParams?: Record<string, string>
    readonly providerOptions?: OpenAIProviderOptionsInput
  }

export interface ImageGenerationOptions {
  readonly action?: OpenAIImageString<"auto" | "generate" | "edit">
  readonly background?: OpenAIImageString<"auto" | "opaque" | "transparent">
  readonly inputFidelity?: OpenAIImageString<"low" | "high">
  readonly outputCompression?: number
  readonly outputFormat?: OpenAIImageString<"png" | "jpeg" | "webp">
  readonly partialImages?: number
  readonly quality?: OpenAIImageString<"auto" | "low" | "medium" | "high" | "standard" | "hd">
  readonly size?: OpenAIImageString<
    "auto" | "256x256" | "512x512" | "1024x1024" | "1536x1024" | "1024x1536" | "1792x1024" | "1024x1792"
  >
}

export const imageGeneration = (options: ImageGenerationOptions = {}) =>
  ToolDefinition.make({
    name: "image_generation",
    description: "Generate or edit an image using OpenAI's hosted image generation tool.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    native: {
      openai: {
        type: "image_generation",
        action: options.action,
        background: options.background,
        input_fidelity: options.inputFidelity,
        output_compression: options.outputCompression,
        output_format: options.outputFormat,
        partial_images: options.partialImages,
        quality: options.quality,
        size: options.size,
      },
    },
  })

export type Settings = ProviderPackage.Settings &
  OpenAIProviderOptionsInput & {
    readonly apiKey?: string
    readonly baseURL?: string
    readonly organization?: string
    readonly project?: string
    readonly queryParams?: Readonly<Record<string, string>>
  }

const auth = (options: ProviderAuthOption<"optional">) => AuthOptions.bearer(options, "OPENAI_API_KEY")

const defaults = (input: Config) => {
  const { apiKey: _, auth: _auth, baseURL: _baseURL, queryParams: _queryParams, ...rest } = input
  return rest
}

const configuredRoute = <Body, Prepared, Compact extends CompactionOperations | undefined>(
  route: Route<Body, Prepared, Compact>,
  input: Config,
) =>
  route.with({
    auth: auth(input),
    endpoint: { baseURL: input.baseURL, query: input.queryParams },
  })

export const configure = (input: Config = {}) => {
  const responsesRoute = configuredRoute(OpenAIResponses.route, input)
  const chatRoute = configuredRoute(OpenAIChat.route, input)
  const modelDefaults = defaults(input)
  const responses = (id: string | ModelID) =>
    responsesRoute
      .with(withOpenAIOptions(id, modelDefaults, { textVerbosity: true }))
      .model<OpenAIProviderOptionsInput>({ id })
  const chat = (id: string | ModelID) =>
    chatRoute.with(withOpenAIOptions(id, modelDefaults)).model<OpenAIProviderOptionsInput>({ id })
  const image = (modelID: string | ModelID) =>
    OpenAIImages.model({
      id: modelID,
      auth: auth(input),
      baseURL: input.baseURL,
      headers: input.headers,
      http: mergeHttpOptions(
        input.http === undefined ? undefined : HttpOptions.make(input.http),
        input.queryParams === undefined ? undefined : new HttpOptions({ query: input.queryParams }),
      ),
    })

  return {
    id,
    model: responses,
    responses,
    chat,
    image,
    configure,
  }
}

export const provider = configure()

const config = ({
  apiKey,
  baseURL,
  body,
  headers: given,
  organization,
  project,
  queryParams,
  ...providerOptions
}: Settings): Config => {
  const headers = {
    ...(organization === undefined ? {} : { "OpenAI-Organization": organization }),
    ...(project === undefined ? {} : { "OpenAI-Project": project }),
    ...given,
  }
  return {
    apiKey,
    baseURL,
    headers: Object.keys(headers).length === 0 ? undefined : headers,
    http: body === undefined ? undefined : { body: { ...body } },
    providerOptions,
    queryParams: queryParams === undefined ? undefined : { ...queryParams },
  }
}

export const model: ProviderPackage.Definition<
  Settings,
  OpenAIProviderOptionsInput,
  typeof OpenAIResponses.route.compact
>["model"] = (modelID, settings) => {
  return configure(config(settings)).responses(modelID)
}

export const chatModel: ProviderPackage.Definition<Settings, OpenAIProviderOptionsInput>["model"] = (
  modelID,
  settings,
) => configure(config(settings)).chat(modelID)
export const responses = provider.responses
export const chat = provider.chat
export const image = provider.image
