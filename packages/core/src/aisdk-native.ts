export * as AISDKNative from "./aisdk-native.js"

import { Effect, Option, Schema, Struct } from "effect"
import { Provider } from "./provider.js"

export interface Mapping {
  readonly package: string
  readonly settings: Provider.Settings
  readonly headers?: Readonly<Record<string, string>>
  readonly body?: Readonly<Record<string, unknown>>
}

export interface MapInput {
  readonly packageName: string | undefined
  readonly settings: Provider.Settings
  readonly modelID: string
  readonly providerID: string
}

// A wrongly typed legacy value is dropped rather than failing the whole decode.
const lenient = <S extends Schema.Top>(schema: S) =>
  Schema.optional(Schema.UndefinedOr(schema).pipe(Schema.catchDecoding(() => Effect.succeed(Option.some(undefined)))))

const Credentials = Schema.Struct({
  accessKeyId: Schema.String,
  secretAccessKey: Schema.String,
  sessionToken: lenient(Schema.String),
  region: lenient(Schema.String),
})

/** AI SDK settings whose spelling differs from the native package. Everything else passes through. */
const Legacy = Schema.StructWithRest(
  Schema.Struct({
    apiKey: lenient(Schema.String),
    baseURL: lenient(Schema.String),
    headers: lenient(Schema.Record(Schema.String, Schema.String)),
    extraBody: lenient(Schema.Record(Schema.String, Schema.Unknown)),
    useCompletionUrls: lenient(Schema.Boolean),
    // Bedrock
    auth: lenient(Schema.Literals(["bearer", "sigv4"])),
    bearerToken: lenient(Schema.String),
    endpoint: lenient(Schema.String),
    region: lenient(Schema.String),
    credentials: lenient(Credentials),
    accessKeyId: lenient(Schema.String),
    secretAccessKey: lenient(Schema.String),
    sessionToken: lenient(Schema.String),
    anthropicBeta: lenient(Schema.Array(Schema.String)),
    serviceTier: lenient(Schema.String),
    reasoningConfig: lenient(
      Schema.Struct({
        type: lenient(Schema.String),
        display: lenient(Schema.String),
        maxReasoningEffort: lenient(Schema.String),
        budgetTokens: lenient(Schema.Number),
      }),
    ),
    additionalModelRequestFields: lenient(
      Schema.StructWithRest(
        Schema.Struct({
          anthropic_beta: lenient(Schema.Array(Schema.String)),
          output_config: lenient(Schema.Record(Schema.String, Schema.Unknown)),
          reasoning: lenient(Schema.Record(Schema.String, Schema.Unknown)),
        }),
        [Schema.Record(Schema.String, Schema.Unknown)],
      ),
    ),
    // OpenRouter
    appName: lenient(Schema.String),
    appUrl: lenient(Schema.String),
    api_keys: lenient(Schema.Record(Schema.String, Schema.String)),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
)
type Legacy = typeof Legacy.Type
const decode = Schema.decodeUnknownSync(Legacy)

/** Maps a legacy AI SDK package onto the native package that replaces it. */
export function map(input: MapInput): Mapping | undefined {
  const settings = decode(input.settings)
  const native = mapPackage(input.packageName, input.modelID, settings)
  if (!native) return
  const converse = native === "@opencode/ai/providers/amazon-bedrock"
  const mapped = {
    ...Struct.omit(settings, ["headers", "extraBody", "useCompletionUrls", ...OPENROUTER_KEYS]),
    ...(native === "@opencode/ai/providers/openai-compatible" ? { provider: input.providerID } : {}),
  }
  return {
    package: native,
    settings: native.startsWith("@opencode/ai/providers/amazon-bedrock") ? bedrockSettings(mapped, converse) : mapped,
    ...(settings.headers === undefined ? {} : { headers: settings.headers }),
    ...(settings.extraBody === undefined ? {} : { body: settings.extraBody }),
    ...(converse ? bedrockRequest(input.modelID, settings) : {}),
    ...(native === "@opencode/ai/providers/openrouter" ? openRouterRequest(settings) : {}),
  }
}

function mapPackage(packageName: string | undefined, modelID: string, settings: Legacy) {
  switch (packageName) {
    case "@ai-sdk/anthropic":
    case "@ai-sdk/cerebras":
    case "@ai-sdk/deepinfra":
    case "@ai-sdk/google":
    case "@ai-sdk/google-vertex":
    case "@ai-sdk/groq":
    case "@ai-sdk/mistral":
    case "@ai-sdk/openai":
    case "@ai-sdk/togetherai":
    case "@ai-sdk/xai":
    case "@ai-sdk/amazon-bedrock":
      return `@opencode/ai/providers/${packageName.slice("@ai-sdk/".length)}`
    case "@ai-sdk/amazon-bedrock/mantle":
      return `@opencode/ai/providers/amazon-bedrock/mantle/${modelID.includes("gpt-oss") ? "chat" : "responses"}`
    case "@ai-sdk/azure":
      return `@opencode/ai/providers/azure/${settings.useCompletionUrls === true ? "chat" : "responses"}`
    case "@ai-sdk/google-vertex/anthropic":
      return "@opencode/ai/providers/google-vertex/messages"
    case "@ai-sdk/openai-compatible":
      return settings.baseURL === undefined ? undefined : "@opencode/ai/providers/openai-compatible"
    case "@openrouter/ai-sdk-provider":
      return "@opencode/ai/providers/openrouter"
  }
}

// AI SDK spellings the native Bedrock packages do not read.
const BEDROCK_KEYS = [
  "bearerToken",
  "endpoint",
  "credentials",
  "credentialProvider",
  "accessKeyId",
  "secretAccessKey",
  "sessionToken",
]
// Request settings Converse takes in the body; translated by `bedrockRequest`.
const CONVERSE_KEYS = ["additionalModelRequestFields", "reasoningConfig", "anthropicBeta", "serviceTier"]

function bedrockSettings(settings: Legacy, converse: boolean) {
  const region = settings.region ?? settings.credentials?.region
  const credentials = settings.credentials ?? settings
  const baseURL = settings.baseURL ?? settings.endpoint
  return {
    ...Struct.omit(settings, converse ? [...BEDROCK_KEYS, ...CONVERSE_KEYS] : BEDROCK_KEYS),
    ...(baseURL === undefined
      ? {}
      : { baseURL: region === undefined ? baseURL : baseURL.replaceAll("${AWS_REGION}", region) }),
    ...(settings.apiKey === undefined && settings.bearerToken !== undefined ? { apiKey: settings.bearerToken } : {}),
    ...(region === undefined || credentials.accessKeyId === undefined || credentials.secretAccessKey === undefined
      ? {}
      : {
          credentials: {
            region,
            accessKeyId: credentials.accessKeyId,
            secretAccessKey: credentials.secretAccessKey,
            ...(credentials.sessionToken === undefined ? {} : { sessionToken: credentials.sessionToken }),
          },
        }),
  }
}

function bedrockRequest(modelID: string, settings: Legacy): Pick<Mapping, "body"> {
  const additional = settings.additionalModelRequestFields ?? {}
  const reasoning = settings.reasoningConfig
  const anthropic = modelID.includes("anthropic")
  const openai = modelID.includes("openai.")
  // gpt-oss (Harmony) takes the flat chat-completions `reasoning_effort`; GPT-5.6+ take Responses-style `reasoning.effort`.
  const harmony = modelID.includes("openai.gpt-oss")
  const effort = reasoning?.maxReasoningEffort
  const type = reasoning?.type
  const budget = reasoning?.budgetTokens
  const display = reasoning?.display
  const betas = settings.anthropicBeta ?? []
  const fields = Provider.mergeOverlay(additional, {
    ...(betas.length > 0 ? { anthropic_beta: [...(additional.anthropic_beta ?? []), ...betas] } : {}),
    ...(anthropic && type === "enabled" && budget !== undefined
      ? { thinking: { type: "enabled", budget_tokens: budget } }
      : {}),
    ...(anthropic && type === "adaptive"
      ? { thinking: { type: "adaptive", ...(display === undefined ? {} : { display }) } }
      : {}),
    ...(anthropic && effort !== undefined ? { output_config: { ...additional.output_config, effort } } : {}),
    ...(!anthropic && openai && harmony && effort !== undefined ? { reasoning_effort: effort } : {}),
    ...(!anthropic && openai && !harmony && effort !== undefined
      ? { reasoning: { ...additional.reasoning, effort } }
      : {}),
    ...(!anthropic && !openai && effort !== undefined
      ? {
          reasoningConfig: {
            ...(type === undefined || type === "adaptive" ? {} : { type }),
            ...(budget === undefined ? {} : { budgetTokens: budget }),
            maxReasoningEffort: effort,
          },
        }
      : {}),
  })
  const body = {
    ...(fields && Object.keys(fields).length > 0 ? { additionalModelRequestFields: fields } : {}),
    ...(settings.serviceTier === undefined ? {} : { serviceTier: { type: settings.serviceTier } }),
  }
  return Object.keys(body).length === 0 ? {} : { body }
}

// Constructor options the native OpenRouter package takes as headers, plus `compatibility`, which the
// native package would otherwise forward to the request body.
const OPENROUTER_KEYS = ["appName", "appUrl", "api_keys", "compatibility"] as const

function openRouterRequest(settings: Legacy): Pick<Mapping, "headers"> {
  const headers =
    Provider.mergeHeaders(
      {
        ...(settings.appName === undefined ? {} : { "X-OpenRouter-Title": settings.appName }),
        ...(settings.appUrl === undefined ? {} : { "HTTP-Referer": settings.appUrl }),
        ...(settings.api_keys === undefined || Object.keys(settings.api_keys).length === 0
          ? {}
          : { "X-Provider-API-Keys": JSON.stringify(settings.api_keys) }),
      },
      settings.headers,
    ) ?? {}
  return Object.keys(headers).length === 0 ? {} : { headers }
}
