import type { Model } from "@opencode-ai/sdk/v2"
import { Option, Schema } from "effect"

const item = Schema.Struct({
  model_picker_enabled: Schema.Boolean,
  id: Schema.String,
  name: Schema.String,
  // every version looks like: `{model.id}-YYYY-MM-DD`
  version: Schema.String,
  supported_endpoints: Schema.optional(Schema.Array(Schema.String)),
  policy: Schema.optional(
    Schema.Struct({
      state: Schema.optional(Schema.String),
    }),
  ),
  billing: Schema.optional(
    Schema.Struct({
      token_prices: Schema.optional(
        Schema.Struct({
          batch_size: Schema.Number,
          default: Schema.Struct({
            cache_price: Schema.Number,
            input_price: Schema.Number,
            output_price: Schema.Number,
          }),
        }),
      ),
    }),
  ),
  capabilities: Schema.Struct({
    family: Schema.String,
    limits: Schema.optional(
      Schema.Struct({
        max_context_window_tokens: Schema.optional(Schema.Number),
        max_output_tokens: Schema.optional(Schema.Number),
        max_prompt_tokens: Schema.optional(Schema.Number),
        vision: Schema.optional(
          Schema.Struct({
            max_prompt_image_size: Schema.Number,
            max_prompt_images: Schema.Number,
            supported_media_types: Schema.Array(Schema.String),
          }),
        ),
      }),
    ),
    supports: Schema.Struct({
      adaptive_thinking: Schema.optional(Schema.Boolean),
      max_thinking_budget: Schema.optional(Schema.Number),
      min_thinking_budget: Schema.optional(Schema.Number),
      reasoning_effort: Schema.optional(Schema.Array(Schema.String)),
      streaming: Schema.optional(Schema.Boolean),
      structured_outputs: Schema.optional(Schema.Boolean),
      tool_calls: Schema.optional(Schema.Boolean),
      vision: Schema.optional(Schema.Boolean),
    }),
  }),
})

export const schema = Schema.Struct({
  data: Schema.Array(Schema.Unknown),
})

type Item = Schema.Schema.Type<typeof item>
type SelectableItem = Item & {
  capabilities: Item["capabilities"] & {
    limits: NonNullable<Item["capabilities"]["limits"]> & {
      max_output_tokens: number
      max_prompt_tokens: number
    }
    supports: Item["capabilities"]["supports"] & {
      tool_calls: boolean
    }
  }
}
type CopilotEndpoint = "chat" | "responses" | "messages"
type CopilotModel = Omit<Model, "api"> & {
  api: Model["api"] & { endpoint?: CopilotEndpoint }
}
const decodeModels = Schema.decodeUnknownSync(schema)
const decodeItem = Schema.decodeUnknownOption(item)

function build(key: string, remote: SelectableItem, url: string, prev?: Model): Model {
  const reasoning =
    !!remote.capabilities.supports.adaptive_thinking ||
    !!remote.capabilities.supports.reasoning_effort?.length ||
    remote.capabilities.supports.max_thinking_budget !== undefined ||
    remote.capabilities.supports.min_thinking_budget !== undefined
  const image =
    (remote.capabilities.supports.vision ?? false) ||
    (remote.capabilities.limits.vision?.supported_media_types ?? []).some((item) => item.startsWith("image/"))
  const pdf =
    (remote.capabilities.supports.vision ?? false) &&
    (remote.capabilities.limits.vision?.supported_media_types?.includes("application/pdf") ?? false)

  const isMsgApi = remote.supported_endpoints?.includes("/v1/messages")
  const endpoint: CopilotEndpoint | undefined = isMsgApi
    ? "messages"
    : remote.supported_endpoints?.includes("/responses")
      ? "responses"
      : remote.supported_endpoints?.includes("/chat/completions")
        ? "chat"
        : undefined
  const prices = remote.billing?.token_prices
  // Copilot prices are AIC per billing batch; OpenCode stores USD per million tokens.
  const usdPerMillion = prices && prices.batch_size > 0 ? 10_000 / prices.batch_size : 0

  const model: CopilotModel = {
    id: key,
    providerID: "github-copilot",
    api: {
      id: remote.id,
      url: isMsgApi ? `${url}/v1` : url,
      npm: isMsgApi ? "@ai-sdk/anthropic" : "@ai-sdk/github-copilot",
      ...(endpoint ? { endpoint } : {}),
    },
    // API response wins
    status: "active",
    limit: {
      context: remote.capabilities.limits.max_context_window_tokens ?? remote.capabilities.limits.max_prompt_tokens,
      input: remote.capabilities.limits.max_prompt_tokens,
      output: remote.capabilities.limits.max_output_tokens,
    },
    capabilities: {
      temperature: prev?.capabilities.temperature ?? true,
      reasoning: prev?.capabilities.reasoning ?? reasoning,
      attachment: prev?.capabilities.attachment ?? true,
      toolcall: remote.capabilities.supports.tool_calls,
      input: {
        text: true,
        audio: false,
        image,
        video: false,
        pdf,
      },
      output: {
        text: true,
        audio: false,
        image: false,
        video: false,
        pdf: false,
      },
      interleaved: false,
    },
    // existing wins
    family: prev?.family ?? remote.capabilities.family,
    name: prev?.name ?? remote.name,
    cost: {
      input: (prices?.default.input_price ?? 0) * usdPerMillion,
      output: (prices?.default.output_price ?? 0) * usdPerMillion,
      cache: {
        read: (prices?.default.cache_price ?? 0) * usdPerMillion,
        // `/models` exposes cached-input reads only; per-request billing accounts for cache writes.
        write: 0,
      },
    },
    options: prev?.options ?? {},
    headers: prev?.headers ?? {},
    release_date:
      prev?.release_date ??
      (remote.version.startsWith(`${remote.id}-`) ? remote.version.slice(remote.id.length + 1) : remote.version),
  }

  const efforts = remote.capabilities.supports.reasoning_effort
  const variants: NonNullable<Model["variants"]> = {}
  if (!isMsgApi && efforts?.length) {
    efforts.forEach((effort) => {
      variants[effort] = {
        reasoningEffort: effort,
        reasoningSummary: "auto",
        include: ["reasoning.encrypted_content"],
      }
    })
  } else {
    if (efforts?.length && remote.capabilities.supports.adaptive_thinking) {
      efforts.forEach((effort) => {
        variants[effort] = {
          thinking: {
            type: "adaptive",
            display: "summarized",
          },
          effort,
        }
      })
    } else if (remote.capabilities.supports.max_thinking_budget) {
      const max = remote.capabilities.supports.max_thinking_budget
      variants["max"] = {
        thinking: {
          type: "enabled",
          budgetTokens: max - 1,
        },
      }
      variants["high"] = {
        thinking: {
          type: "enabled",
          budgetTokens: Math.floor(max / 2),
        },
      }
    }
  }
  if (Object.keys(variants).length > 0) {
    model.variants = variants
  }

  return model
}

function usable(item: Item): item is SelectableItem {
  return (
    item.policy?.state !== "disabled" &&
    item.capabilities.limits?.max_output_tokens !== undefined &&
    item.capabilities.limits.max_prompt_tokens !== undefined &&
    item.capabilities.supports.tool_calls !== undefined
  )
}

export async function get(
  baseURL: string,
  headers: HeadersInit = {},
  existing: Record<string, Model> = {},
): Promise<{ models: Record<string, Model>; pickerEnabled: Set<string> }> {
  const data = await fetch(`${baseURL}/models`, {
    headers,
    signal: AbortSignal.timeout(5_000),
  }).then(async (res) => {
    if (!res.ok) {
      throw new Error(`Failed to fetch models: ${res.status}`)
    }
    return decodeModels(await res.json())
  })

  const result = { ...existing }
  const remote = new Map(
    data.data.flatMap((raw) => {
      const item = Option.getOrUndefined(decodeItem(raw))
      return item && usable(item) ? ([[item.id, item]] as const) : []
    }),
  )

  // prune existing models whose api.id isn't in the endpoint response
  for (const [key, model] of Object.entries(result)) {
    const m = remote.get(model.api.id)
    if (!m) {
      delete result[key]
      continue
    }
    result[key] = build(key, m, baseURL, model)
  }

  // add new endpoint models not already keyed in result
  for (const [id, m] of remote) {
    if (id in result) continue
    result[id] = build(id, m, baseURL)
  }

  return {
    models: result,
    pickerEnabled: new Set([...remote].filter(([, item]) => item.model_picker_enabled).map(([id]) => id)),
  }
}

export * as CopilotModels from "./models"
