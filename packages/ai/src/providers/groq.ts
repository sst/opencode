import { Effect, Schema } from "effect"
import type { ProviderPackage } from "../provider-package.js"
import { OpenAIChat } from "../protocols/openai-chat.js"
import { ProviderShared } from "../protocols/shared.js"
import { AuthOptions, type ProviderAuthOption } from "../route/auth-options.js"
import { Route, type RouteDefaultsInput } from "../route/client.js"
import { Endpoint } from "../route/endpoint.js"
import { Protocol } from "../route/protocol.js"
import { ProviderID, type ModelID, type LLMRequest } from "../schema/index.js"
import type { OpenAIProviderOptionsInput } from "./openai-options.js"

export const id = ProviderID.make("groq")
const baseURL = "https://api.groq.com/openai/v1"

export type ProviderOptions = Pick<OpenAIProviderOptionsInput, "reasoningEffort"> & {
  /** Controls visible reasoning on GPT-OSS; other models always use parsed reasoning. */
  readonly includeReasoning?: boolean
  readonly parallelToolCalls?: boolean
  readonly serviceTier?: "on_demand" | "flex" | "auto" | "performance" | (string & {})
  readonly user?: string
}

export type LanguageModelOptions = Omit<RouteDefaultsInput, "providerOptions"> &
  ProviderAuthOption<"optional"> & {
    readonly baseURL?: string
    readonly providerOptions?: ProviderOptions
  }

export type Settings = ProviderPackage.Settings &
  ProviderOptions & {
    readonly apiKey?: string
    readonly baseURL?: string
  }

const Options = Schema.Struct({
  includeReasoning: Schema.optional(Schema.Boolean),
  parallelToolCalls: Schema.optional(Schema.Boolean),
  serviceTier: Schema.optional(Schema.String),
  user: Schema.optional(Schema.String),
})

export const protocol = Protocol.make({
  id: "groq-chat",
  body: {
    schema: Schema.Struct({
      ...OpenAIChat.bodyFields,
      reasoning_format: Schema.optional(Schema.Literal("parsed")),
      include_reasoning: Schema.optional(Schema.Boolean),
      parallel_tool_calls: Schema.optional(Schema.Boolean),
      service_tier: Schema.optional(Schema.String),
      user: Schema.optional(Schema.String),
    }),
    from: Effect.fn("Groq.fromRequest")(function* (request: LLMRequest) {
      const options = yield* ProviderShared.validateWith(Schema.decodeUnknownEffect(Options))(
        request.providerOptions ?? {},
      )
      const gptOSS = request.model.id.startsWith("openai/gpt-oss-")
      return {
        ...(yield* OpenAIChat.fromRequest(request)),
        reasoning_format: gptOSS ? undefined : ("parsed" as const),
        include_reasoning: gptOSS ? options.includeReasoning : undefined,
        parallel_tool_calls: options.parallelToolCalls,
        service_tier: options.serviceTier,
        user: options.user,
      }
    }),
  },
  stream: OpenAIChat.protocol.stream,
})

export const route = Route.make({
  id: "groq-chat",
  provider: id,
  providerMetadataKey: "openai",
  protocol,
  endpoint: Endpoint.path("/chat/completions", { baseURL }),
  framing: OpenAIChat.framing,
})

export const configure = (input: LanguageModelOptions = {}) => {
  const { apiKey: _apiKey, auth: _auth, baseURL: endpoint, ...defaults } = input
  const configured = route.with({
    ...defaults,
    endpoint: { baseURL: endpoint ?? baseURL },
    auth: AuthOptions.bearer(input, "GROQ_API_KEY"),
  })
  return {
    id,
    model: (modelID: string | ModelID) =>
      configured.model<ProviderOptions>({
        id: modelID,
        compatibility: {
          maxTokensField: "max_completion_tokens",
          reasoningField: "reasoning",
          requireReasoning: false,
          supportsStore: false,
          supportsStrictMode: false,
        },
      }),
    configure,
  }
}

export const provider = configure()

export const model: ProviderPackage.Definition<Settings, ProviderOptions>["model"] = (
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

export * as Groq from "./groq.js"
