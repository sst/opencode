export * as CopilotModels from "./models.js"

import { Money } from "@opencode/schema/money"
import { Option, Schema } from "effect"
import { Model } from "../model.js"
import { Provider } from "../provider.js"

const RemoteModel = Schema.Struct({
  model_picker_enabled: Schema.Boolean,
  id: Schema.String,
  name: Schema.String,
  version: Schema.String,
  supported_endpoints: Schema.optional(Schema.Array(Schema.String)),
  policy: Schema.optional(Schema.Struct({ state: Schema.optional(Schema.String) })),
  billing: Schema.optional(
    Schema.Struct({
      token_prices: Schema.optional(
        Schema.Struct({
          batch_size: Schema.Number,
          default: Schema.Struct({
            // API version 2026-08-01 renamed cache_price to cache_read_price.
            cache_price: Schema.optional(Schema.Number),
            cache_read_price: Schema.optional(Schema.Number),
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

const Response = Schema.Struct({ data: Schema.Array(Schema.Unknown) })
const decodeResponse = Schema.decodeUnknownSync(Response)
const decodeModel = Schema.decodeUnknownOption(RemoteModel)

type RemoteModel = typeof RemoteModel.Type
type UsableModel = RemoteModel & {
  capabilities: RemoteModel["capabilities"] & {
    limits: NonNullable<RemoteModel["capabilities"]["limits"]> & {
      max_output_tokens: number
      max_prompt_tokens: number
    }
    supports: RemoteModel["capabilities"]["supports"] & { tool_calls: boolean }
  }
}

export async function get(baseURL: string, headers: RequestInit["headers"], existing: readonly Model.Info[]) {
  const response = await fetch(`${baseURL}/models`, {
    headers,
    signal: AbortSignal.timeout(5_000),
  })
  if (!response.ok) throw new Error(`Failed to fetch Copilot models: ${response.status}`)

  const remote = new Map(
    decodeResponse(await response.json()).data.flatMap((raw) => {
      const model = Option.getOrUndefined(decodeModel(raw))
      return model && usable(model) ? ([[model.id, model]] as const) : []
    }),
  )
  const result = new Map(existing.map((model) => [model.id, model]))

  // Keep aliases and local metadata, but only when their advertised API model
  // still exists. A partial or malformed item cannot create a broken model.
  for (const [id, model] of result) {
    const current = remote.get(model.modelID)
    if (!current) {
      result.delete(id)
      continue
    }
    result.set(id, build(id, current, baseURL, model))
  }

  for (const [id, model] of remote) {
    const key = Model.ID.make(id)
    if (result.has(key)) continue
    result.set(key, build(key, model, baseURL))
  }

  return result
}

function usable(model: RemoteModel): model is UsableModel {
  return (
    model.policy?.state !== "disabled" &&
    model.capabilities.limits?.max_output_tokens !== undefined &&
    model.capabilities.limits.max_prompt_tokens !== undefined &&
    model.capabilities.supports.tool_calls !== undefined
  )
}

function build(id: Model.ID, remote: UsableModel, baseURL: string, previous?: Model.Info) {
  const messages = remote.supported_endpoints?.includes("/v1/messages") ?? false
  const endpoint = messages
    ? "messages"
    : remote.supported_endpoints?.includes("/responses")
      ? "responses"
      : remote.supported_endpoints?.includes("/chat/completions")
        ? "chat"
        : undefined
  const image =
    (remote.capabilities.supports.vision ?? false) ||
    (remote.capabilities.limits.vision?.supported_media_types ?? []).some((item) => item.startsWith("image/"))
  const pdf =
    (remote.capabilities.supports.vision ?? false) &&
    (remote.capabilities.limits.vision?.supported_media_types.includes("application/pdf") ?? false)
  const input = ["text"]
  if (image) input.push("image")
  if (pdf) input.push("pdf")
  const prices = remote.billing?.token_prices
  // Copilot reports AIC per billing batch; OpenCode stores USD per million tokens.
  const usdPerMillion = prices && prices.batch_size > 0 ? 10_000 / prices.batch_size : 0
  const version = remote.version.startsWith(`${remote.id}-`)
    ? remote.version.slice(remote.id.length + 1)
    : remote.version
  const released = previous?.time.released || Date.parse(version)

  return Model.Info.make({
    ...Model.Info.default(Provider.ID.githubCopilot, id),
    id,
    modelID: Model.ID.make(remote.id),
    providerID: Provider.ID.githubCopilot,
    family: previous?.family ?? Model.Family.make(remote.capabilities.family),
    name: previous?.name ?? remote.name,
    package: Provider.aisdk(messages ? "@ai-sdk/anthropic" : "@ai-sdk/github-copilot"),
    settings: Provider.mergeOverlay(previous?.settings, {
      baseURL: messages ? `${baseURL}/v1` : baseURL,
      ...(endpoint ? { endpoint } : {}),
    }),
    headers: previous?.headers,
    body: previous?.body,
    capabilities: {
      tools: remote.capabilities.supports.tool_calls,
      input,
      output: ["text"],
    },
    variants: variants(remote, messages),
    time: { released: Number.isFinite(released) ? released : 0 },
    cost: [
      {
        input: Money.USDPerMillionTokens.make((prices?.default.input_price ?? 0) * usdPerMillion),
        output: Money.USDPerMillionTokens.make((prices?.default.output_price ?? 0) * usdPerMillion),
        cache: {
          read: Money.USDPerMillionTokens.make(
            (prices?.default.cache_read_price ?? prices?.default.cache_price ?? 0) * usdPerMillion,
          ),
          write: Money.USDPerMillionTokens.zero,
        },
      },
    ],
    status: "active",
    enabled: remote.model_picker_enabled,
    limit: {
      context: remote.capabilities.limits.max_context_window_tokens ?? remote.capabilities.limits.max_prompt_tokens,
      input: remote.capabilities.limits.max_prompt_tokens,
      output: remote.capabilities.limits.max_output_tokens,
    },
  })
}

function variants(remote: UsableModel, messages: boolean): Model.Info["variants"] {
  const efforts = remote.capabilities.supports.reasoning_effort ?? []
  if (!messages && efforts.length) {
    return efforts.map((effort) => ({
      id: Model.VariantID.make(effort),
      settings: {
        reasoningEffort: effort,
        reasoningSummary: "auto",
        include: ["reasoning.encrypted_content"],
      },
    }))
  }
  if (efforts.length && remote.capabilities.supports.adaptive_thinking) {
    return efforts.map((effort) => ({
      id: Model.VariantID.make(effort),
      settings: {
        thinking: {
          type: "adaptive",
          display: "summarized",
        },
        effort,
      },
    }))
  }
  const max = remote.capabilities.supports.max_thinking_budget
  if (max === undefined) return []
  return [
    {
      id: Model.VariantID.make("max"),
      settings: { thinking: { type: "enabled", budgetTokens: max - 1 } },
    },
    {
      id: Model.VariantID.make("high"),
      settings: { thinking: { type: "enabled", budgetTokens: Math.floor(max / 2) } },
    },
  ]
}
