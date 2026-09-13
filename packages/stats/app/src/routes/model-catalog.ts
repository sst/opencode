import { statModel } from "@opencode-ai/stats-core/domain/model-normalization"
import { query } from "@solidjs/router"

export const modelCatalogSourceUrl = "https://models.opencode.ai/catalog.json"
export const modelCatalogPricingUrl = "https://models.opencode.ai/api.json"
export const modelCatalogLabSourceUrl = "https://models.opencode.ai/labs"

export type ModelCatalogCost = {
  input: number
  output: number
  cacheRead?: number
  cacheWrite?: number
}

export type ModelCatalogEntry = {
  id: string
  lab: string
  slug: string
  name: string
  description?: string
  family?: string
  knowledge?: string
  releaseDate?: string
  lastUpdated?: string
  limit?: { context?: number; output?: number }
  modalities: { input: string[]; output: string[] }
  openWeights: boolean
  reasoning: boolean
  toolCall: boolean
  attachment: boolean
  temperature: boolean
  cost?: ModelCatalogCost
  weights: { label: string; url: string }[]
  benchmarks: ModelCatalogBenchmark[]
}

export type ModelCatalogBenchmark = {
  name: string
  score: number
  metric?: string
  harness?: string
  variant?: string
  dataset?: string
  version?: string
  source?: string
}

export type ModelCatalogLab = {
  id: string
  name: string
  description?: string
  models: ModelCatalogEntry[]
}

export type ModelCatalog = {
  models: ModelCatalogEntry[]
  labs: ModelCatalogLab[]
}

export async function loadModelCatalog() {
  const [models, pricing, labs] = await Promise.all([
    fetchCatalogPayload(modelCatalogSourceUrl),
    fetchCatalogPayload(modelCatalogPricingUrl),
    fetchLabCatalogPayload(modelCatalogLabSourceUrl),
  ])
  return buildModelCatalog(models, pricing, labs)
}

export const getModelCatalog = query(async () => {
  "use server"
  return loadModelCatalog()
}, "getModelCatalog")

export function findModelCatalogEntry(catalog: ModelCatalog, model: string, lab?: string) {
  const canonicalModel = statModel(model, undefined)
  const normalizedId = lab
    ? `${catalogLabSlug(lab)}/${catalogSlug(canonicalModel)}`
    : canonicalModel.trim().toLowerCase()
  const leaf = catalogSlug(canonicalModel)
  return (
    catalog.models.find((entry) => entry.id.toLowerCase() === normalizedId) ??
    catalog.models.find((entry) => (lab ? entry.lab === catalogLabSlug(lab) : true) && entry.slug === leaf) ??
    catalog.models.find((entry) => entry.slug === leaf)
  )
}

export function findModelCatalogLab(catalog: ModelCatalog, lab: string) {
  const id = catalogLabSlug(lab)
  return catalog.labs.find((entry) => entry.id === id)
}

export function formatCatalogLabName(lab: string) {
  const known: Record<string, string> = {
    alibaba: "Alibaba",
    anthropic: "Anthropic",
    cohere: "Cohere",
    deepseek: "DeepSeek",
    google: "Google",
    meta: "Meta",
    minimax: "MiniMax",
    mistral: "Mistral",
    moonshotai: "Moonshot",
    openai: "OpenAI",
    perplexity: "Perplexity",
    stepfun: "StepFun",
    tencent: "Tencent",
    xai: "xAI",
    xiaomi: "Xiaomi",
    zai: "Z.ai",
    qwen: "Qwen",
    zhipu: "Zhipu",
    zhipuai: "Zhipu",
  }
  return known[catalogSlug(lab)] ?? lab.replace(/[-_]/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase())
}

export function isProviderlessLab(lab: string | undefined) {
  return !lab || catalogSlug(lab) === "unknown"
}

export function isKnownCatalogLab(lab: string | undefined, catalogLabs: readonly string[]) {
  if (!lab || isProviderlessLab(lab)) return false
  const key = catalogSlug(formatCatalogLabName(lab))
  return catalogLabs.some((candidate) => catalogSlug(formatCatalogLabName(candidate)) === key)
}

export function catalogSlug(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
}

function buildModelCatalog(payload: unknown, pricingPayload?: unknown, labPayload?: unknown): ModelCatalog {
  const costs = readCatalogCosts(pricingPayload)
  const labDescriptions = readCatalogLabDescriptions(payload, pricingPayload, labPayload)
  const models = readCatalogModels(payload)
    .flatMap(readModelCatalogEntry)
    .map((model) => ({
      ...model,
      cost:
        costs.get(catalogIdKey(model.id)) ??
        costs.get(`${model.lab}/${model.slug}`) ??
        costs.get(model.slug) ??
        model.cost,
    }))
    .toSorted((a, b) => a.lab.localeCompare(b.lab) || displayDateTime(b.releaseDate) - displayDateTime(a.releaseDate))
  return {
    models,
    labs: Object.values(
      models.reduce<Record<string, ModelCatalogLab>>((result, model) => {
        result[model.lab] = {
          id: model.lab,
          name: formatCatalogLabName(model.lab),
          description: result[model.lab]?.description ?? labDescriptions.get(model.lab),
          models: [...(result[model.lab]?.models ?? []), model],
        }
        return result
      }, {}),
    ).toSorted((a, b) => a.name.localeCompare(b.name)),
  }
}

function readModelCatalogEntry(value: unknown): ModelCatalogEntry[] {
  if (!isRecord(value)) return []
  const id = stringValue(value.id)
  const name = stringValue(value.name)
  const lab = id?.split("/")[0]
  const slug = id?.split("/").slice(1).join("/")
  if (!id || !name || !lab || !slug) return []
  return [
    {
      id,
      lab: catalogSlug(lab),
      slug: catalogSlug(slug),
      name,
      description: stringValue(value.description),
      family: stringValue(value.family),
      knowledge: stringValue(value.knowledge),
      releaseDate: stringValue(value.release_date),
      lastUpdated: stringValue(value.last_updated),
      limit: readCatalogLimit(value.limit),
      modalities: readCatalogModalities(value.modalities),
      openWeights: booleanValue(value.open_weights),
      reasoning: booleanValue(value.reasoning),
      toolCall: booleanValue(value.tool_call),
      attachment: booleanValue(value.attachment),
      temperature: booleanValue(value.temperature),
      cost: readCatalogCost(value.cost),
      weights: readCatalogWeights(value.weights),
      benchmarks: readCatalogBenchmarks(value.benchmarks),
    },
  ]
}

function readCatalogModels(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload
  if (!isRecord(payload)) return []
  if (Array.isArray(payload.models)) return payload.models
  if (isRecord(payload.models)) return Object.values(payload.models)
  return Object.values(payload)
}

function readCatalogLabDescriptions(...payloads: unknown[]) {
  const descriptions = new Map<string, string>()
  const add = (value: unknown, fallbackId?: string) => {
    if (!isRecord(value)) return
    const description = stringValue(value.description)
    if (!description) return
    const id = stringValue(value.id) ?? fallbackId
    const name = stringValue(value.name)
    const title = stringValue(value.title)
    const keys = [id, name, title]
    keys.forEach((key) => {
      if (!key) return
      descriptions.set(catalogLabSlug(key), description)
    })
  }
  const addCollection = (value: unknown) => {
    if (Array.isArray(value)) {
      value.forEach((item) => add(item))
      return
    }
    if (!isRecord(value)) return
    Object.entries(value).forEach(([key, item]) => add(item, key))
  }

  payloads.forEach((payload) => {
    if (Array.isArray(payload)) {
      payload.forEach((item) => add(item))
      return
    }
    if (!isRecord(payload)) return
    addCollection(payload.labs)
    addCollection(payload.providers)
    Object.entries(payload).forEach(([key, value]) => add(value, key))
  })

  return descriptions
}

async function fetchCatalogPayload(url: string) {
  return fetch(url)
    .then((response): Promise<unknown> => (response.ok ? (response.json() as Promise<unknown>) : Promise.resolve()))
    .catch(() => undefined)
}

async function fetchLabCatalogPayload(url: string) {
  return fetch(url)
    .then((response) => (response.ok ? response.text() : Promise.resolve("")))
    .then(readLabSearchIndex)
    .catch(() => undefined)
}

function readLabSearchIndex(html: string) {
  const match = /<script[^>]*id=["']search-index["'][^>]*>([\s\S]*?)<\/script>/.exec(html)
  if (!match) return undefined
  const parsed = JSON.parse(match[1]) as unknown
  if (!Array.isArray(parsed)) return undefined
  return parsed.filter((item) => isRecord(item) && item.type === "lab")
}

function readCatalogCosts(payload: unknown) {
  const costs = new Map<string, ModelCatalogCost>()
  const add = (model: unknown, provider?: string) => {
    if (!isRecord(model)) return
    const id = stringValue(model.id)
    const cost = readCatalogCost(model.cost)
    if (!id || !cost) return
    costs.set(catalogIdKey(id), cost)
    costs.set(catalogSlug(id), cost)
    if (provider && !id.includes("/")) costs.set(`${catalogSlug(provider)}/${catalogSlug(id)}`, cost)
  }

  if (Array.isArray(payload)) {
    payload.forEach((model) => add(model))
    return costs
  }
  if (!isRecord(payload)) return costs

  Object.entries(payload).forEach(([key, value]) => {
    if (!isRecord(value)) return
    if (isRecord(value.models)) {
      Object.values(value.models).forEach((model) => add(model, stringValue(value.id) ?? key))
      return
    }
    add(value)
  })
  return costs
}

function readCatalogCost(value: unknown): ModelCatalogCost | undefined {
  if (!isRecord(value)) return undefined
  const input = numberValue(value.input)
  const output = numberValue(value.output)
  if (input === undefined || output === undefined) return undefined
  return {
    input,
    output,
    cacheRead: numberValue(value.cache_read),
    cacheWrite: numberValue(value.cache_write),
  }
}

function readCatalogLimit(value: unknown) {
  if (!isRecord(value)) return undefined
  return {
    context: numberValue(value.context),
    output: numberValue(value.output),
  }
}

function readCatalogModalities(value: unknown) {
  if (!isRecord(value)) return { input: [], output: [] }
  return {
    input: stringArrayValue(value.input),
    output: stringArrayValue(value.output),
  }
}

function readCatalogWeights(value: unknown) {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (!isRecord(item)) return []
    const label = stringValue(item.label)
    const url = stringValue(item.url)
    return label && url ? [{ label, url }] : []
  })
}

function readCatalogBenchmarks(value: unknown) {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (!isRecord(item)) return []
    const name = stringValue(item.name)
    const score = numberValue(item.score)
    return name && score !== undefined
      ? [
          {
            name,
            score,
            metric: stringValue(item.metric),
            harness: stringValue(item.harness),
            variant: stringValue(item.variant),
            dataset: stringValue(item.dataset),
            version: stringValue(item.version),
            source: stringValue(item.source),
          },
        ]
      : []
  })
}

function displayDateTime(value: string | undefined) {
  return value ? new Date(value).getTime() || 0 : 0
}

function catalogIdKey(value: string) {
  return value.split("/").map(catalogSlug).join("/")
}

function catalogLabSlug(value: string) {
  const slug = catalogSlug(value)
  const aliases: Record<string, string> = {
    moonshot: "moonshotai",
    qwen: "alibaba",
    zhipu: "zhipuai",
    zai: "zhipuai",
  }
  return aliases[slug] ?? slug
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value : undefined
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function booleanValue(value: unknown) {
  return value === true
}

function stringArrayValue(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim() !== "")
    : []
}
