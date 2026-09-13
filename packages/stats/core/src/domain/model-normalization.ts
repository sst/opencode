export const MODEL_AUTHOR_RULES = [
  { match: "claude", author: "anthropic" },
  { match: "gemini", author: "google" },
  { match: "deepseek", author: "deepseek" },
  { match: "glm", author: "zhipu" },
  { match: "gpt", author: "openai" },
  { match: "grok", author: "xai" },
  { match: "hy3", author: "tencent" },
  { match: "kimi", author: "moonshot" },
  { match: "mimo", author: "xiaomi" },
  { match: "minimax", author: "minimax" },
  { match: "nemotron", author: "nvidia" },
  { match: "qwen", author: "qwen" },
] as const
export const EXCLUDED_MODELS = new Set(["alpha-gpt-next"])
export const MODEL_NAME_ALIASES: Record<string, string> = {
  "deepseek-flash": "deepseek-v4.1-flash",
  "x-preview-f": "ox-alpha",
  "xiaomi/mimo-v2.5": "mimo-v2.5",
}
export const RETIRED_STAT_MODELS = ["big-pickle", ...Object.keys(MODEL_NAME_ALIASES)]
export const RETIRED_STAT_PROVIDERS = ["opencode"]

export function normalizeInferenceModel(value: string | undefined) {
  return (value || "unknown").replace(/(-free|:global)+$/, "") || "unknown"
}

export function modelAuthor(value: string | undefined) {
  const model = normalizeInferenceModel(value).toLowerCase()
  if (EXCLUDED_MODELS.has(model)) return undefined

  return MODEL_AUTHOR_RULES.find((item) => model.includes(item.match))?.author ?? "unknown"
}

export function statModel(model: string | undefined, providerModel: string | undefined) {
  const normalized = normalizeInferenceModel(model)
  const alias = MODEL_NAME_ALIASES[normalized.toLowerCase()]
  if (alias) return alias
  if (RETIRED_STAT_MODELS.includes(normalized.toLowerCase())) return normalizeInferenceModel(providerModel)
  return normalized
}

export function statProvider(
  model: string | undefined,
  providerModel: string | undefined,
  provider: string | undefined,
) {
  const modelAuthorValue = modelAuthor(statModel(model, providerModel))
  if (!modelAuthorValue) return undefined

  const providerModelAuthor = modelAuthor(providerModel)
  if (providerModelAuthor && providerModelAuthor !== "unknown") return providerModelAuthor
  if (modelAuthorValue !== "unknown") return modelAuthorValue
  if (provider && !RETIRED_STAT_PROVIDERS.includes(provider.toLowerCase())) return provider
  return modelAuthorValue
}
