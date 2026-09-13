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
  { match: "muse-spark", author: "meta" },
  { match: "nemotron", author: "nvidia" },
  { match: "qwen", author: "qwen" },
] as const
export const EXCLUDED_MODELS = new Set(["alpha-gpt-next"])
export const STEALTH_MODELS = new Set(["omen-alpha"])
export const FREE_MODELS = new Set(["gpt-5-nano", "grok-code", "big-pickle"])
export const MODEL_NAME_ALIASES: Record<string, string> = {
  "deepseek-flash": "deepseek-v4.1-flash",
  "deepseek-v4-flash-0731": "deepseek-v4-flash",
  "deepseek-v4-flash-dsv4-flash-final-rnaovd": "deepseek-v4-flash",
  "ox-alpha": "glm-5.3-flash",
  "x-preview-f": "glm-5.3-flash",
  "xiaomi/mimo-v2.5": "mimo-v2.5",
}
export const RETIRED_STAT_MODELS = ["big-pickle", ...Object.keys(MODEL_NAME_ALIASES)]
export const RETIRED_STAT_PROVIDERS = ["opencode"]

export function normalizeInferenceModel(value: string | undefined) {
  return (value || "unknown").toLowerCase().replace(/(-free|:free|:global)+$/, "") || "unknown"
}

export function modelAuthor(value: string | undefined) {
  const model = normalizeInferenceModel(value).toLowerCase()
  if (EXCLUDED_MODELS.has(model)) return undefined

  return MODEL_AUTHOR_RULES.find((item) => model.includes(item.match))?.author ?? "unknown"
}

export function statModel(model: string | undefined, providerModel: string | undefined) {
  const normalized = normalizeInferenceModel(model)
  const resolved = normalized === "big-pickle" ? normalizeInferenceModel(providerModel?.split("/").at(-1)) : normalized
  return MODEL_NAME_ALIASES[resolved.toLowerCase()] ?? resolved
}

export function statProvider(
  model: string | undefined,
  providerModel: string | undefined,
  provider: string | undefined,
) {
  const normalized = statModel(model, providerModel)
  if (STEALTH_MODELS.has(normalized)) return "unknown"

  const modelAuthorValue = modelAuthor(normalized)
  if (!modelAuthorValue) return undefined

  const providerModelAuthor = modelAuthor(providerModel)
  if (providerModelAuthor && providerModelAuthor !== "unknown") return providerModelAuthor
  if (modelAuthorValue !== "unknown") return modelAuthorValue
  if (provider && !RETIRED_STAT_PROVIDERS.includes(provider.toLowerCase())) return provider
  return modelAuthorValue
}
