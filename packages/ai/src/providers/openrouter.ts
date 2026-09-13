import { Effect, Schema } from "effect"
import { Route, type RouteDefaultsInput } from "../route/client.js"
import { Endpoint } from "../route/endpoint.js"
import { Protocol } from "../route/protocol.js"
import { AuthOptions, type ProviderAuthOption } from "../route/auth-options.js"
import { ProviderID, type CacheHint, type ModelID } from "../schema/index.js"
import type { ProviderPackage } from "../provider-package.js"
import { OpenAIChat } from "../protocols/openai-chat.js"
import { newBreakpoints, ttlBucket } from "../protocols/utils/cache.js"
import { isRecord } from "../protocols/shared.js"

export const id = ProviderID.make("openrouter")
const baseURL = "https://openrouter.ai/api/v1"
const ADAPTER = "openrouter"

type OpenRouterString<Known extends string> = Known | (string & {})

export interface OpenRouterProviderRouting {
  readonly [key: string]: unknown
  readonly order?: ReadonlyArray<string>
  readonly allow_fallbacks?: boolean
  readonly require_parameters?: boolean
  readonly data_collection?: OpenRouterString<"allow" | "deny">
  readonly only?: ReadonlyArray<string>
  readonly ignore?: ReadonlyArray<string>
  readonly quantizations?: ReadonlyArray<string>
  readonly sort?: OpenRouterString<"price" | "throughput" | "latency">
  readonly max_price?: Readonly<{
    prompt?: number | string
    completion?: number | string
    image?: number | string
    audio?: number | string
    request?: number | string
  }>
  readonly zdr?: boolean
}

export type OpenRouterPlugin =
  | Readonly<{
      id: "web"
      max_results?: number
      search_prompt?: string
      engine?: OpenRouterString<"native" | "exa">
    }>
  | Readonly<{ id: "file-parser"; max_files?: number; pdf?: { engine?: string } }>
  | Readonly<{ id: "moderation" }>
  | Readonly<{ id: "response-healing" }>
  | Readonly<{ id: "auto-router"; allowed_models?: ReadonlyArray<string> }>
  | Readonly<{ id: string & {}; [key: string]: unknown }>

export interface OpenRouterOptions {
  readonly [key: string]: unknown
  readonly debug?: Readonly<{ echo_upstream_body?: boolean }>
  readonly models?: ReadonlyArray<string>
  readonly plugins?: ReadonlyArray<OpenRouterPlugin>
  readonly provider?: OpenRouterProviderRouting
  readonly reasoning?: Readonly<{
    enabled?: boolean
    exclude?: boolean
    effort?: OpenRouterString<"none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max">
    max_tokens?: number
  }>
  readonly usage?: boolean | Readonly<{ include: boolean }>
  readonly user?: string
  readonly web_search_options?: Readonly<{
    max_results?: number
    search_prompt?: string
    engine?: OpenRouterString<"native" | "exa">
  }>
}

export type OpenRouterProviderOptionsInput = OpenRouterOptions

export type LanguageModelOptions = Omit<RouteDefaultsInput, "providerOptions"> &
  ProviderAuthOption<"optional"> & {
    readonly baseURL?: string
    readonly providerOptions?: OpenRouterProviderOptionsInput
  }

export type Settings = ProviderPackage.Settings &
  OpenRouterProviderOptionsInput & {
    readonly apiKey?: string
    readonly baseURL?: string
  }

const OpenRouterBody = Schema.StructWithRest(Schema.Struct(OpenAIChat.bodyFields), [
  Schema.Record(Schema.String, Schema.Any),
])
export type OpenRouterBody = Schema.Schema.Type<typeof OpenRouterBody>

export const protocol = Protocol.make({
  id: "openrouter-chat",
  body: {
    schema: OpenRouterBody,
    from: (request) =>
      OpenAIChat.fromRequest(request, { cacheControl: cacheControl() }).pipe(
        Effect.map((body) => {
          const sourceAssistants = request.messages.filter((message) => message.role === "assistant")
          let assistantIndex = 0
          const messages = body.messages.map((message) => {
            if (message.role !== "assistant") return message
            const source = sourceAssistants[assistantIndex++]
            const reasoning = source?.content
              .filter((part) => part.type === "reasoning")
              .map((part) => part.text)
              .join("")
            const reasoningDetails = Array.isArray(message.reasoning_details) ? message.reasoning_details : undefined
            return {
              ...message,
              reasoning_content: undefined,
              reasoning_text: undefined,
              reasoning: reasoning && reasoningDetails && reasoningDetails.length > 0 ? reasoning : undefined,
              reasoning_details: reasoningDetails,
            }
          })
          return {
            ...body,
            messages,
            ...bodyOptions(request.providerOptions),
          } as OpenRouterBody
        }),
      ),
  },
  stream: OpenAIChat.protocol.stream,
})

const cacheControl = () => {
  const breakpoints = newBreakpoints(4)
  return (cache: CacheHint | undefined) => {
    if (cache === undefined || breakpoints.remaining === 0) return undefined
    breakpoints.remaining -= 1
    return {
      type: "ephemeral" as const,
      ...(ttlBucket(cache.ttlSeconds) === "1h" ? { ttl: "1h" } : {}),
    }
  }
}

const bodyOptions = (input: unknown) => {
  const openrouter = isRecord(input) ? input : {}
  const { usage, models, provider, plugins, web_search_options, debug, user, reasoning, promptCacheKey, ...options } =
    openrouter
  return {
    ...options,
    ...(usage === undefined || usage === true
      ? { usage: { include: true } }
      : usage === false
        ? { usage: { include: false } }
        : isRecord(usage)
          ? { usage }
          : {}),
    ...(Array.isArray(models) ? { models } : {}),
    ...(isRecord(provider) ? { provider } : {}),
    ...(Array.isArray(plugins) ? { plugins } : {}),
    ...(isRecord(web_search_options) ? { web_search_options } : {}),
    ...(isRecord(debug) ? { debug } : {}),
    ...(typeof user === "string" ? { user } : {}),
    ...(isRecord(reasoning) ? { reasoning } : {}),
  }
}

export const route = Route.make({
  id: ADAPTER,
  provider: id,
  providerMetadataKey: "openrouter",
  protocol,
  endpoint: Endpoint.path("/chat/completions", { baseURL }),
  framing: OpenAIChat.framing,
})

export const routes = [route]

const configuredRoute = (input: LanguageModelOptions) => {
  const { apiKey: _, auth: _auth, baseURL: endpoint, ...rest } = input
  return route.with({
    ...rest,
    endpoint: { baseURL: endpoint ?? baseURL },
    auth: AuthOptions.bearer(input, "OPENROUTER_API_KEY"),
  })
}

export const configure = (input: LanguageModelOptions = {}) => {
  const route = configuredRoute(input)
  return {
    id,
    model: (modelID: string | ModelID) => route.model<OpenRouterProviderOptionsInput>({ id: modelID }),
    configure,
  }
}

export const provider = configure()
export const model: ProviderPackage.Definition<Settings, OpenRouterProviderOptionsInput>["model"] = (
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
