import { Client } from "@planetscale/database"
import { Effect } from "effect"
import { Resource } from "sst/resource"
import type { ModelStatMetric } from "./model"
import { statProvider } from "./model-normalization"
import { isMissingRetentionTable } from "./retention"
import { DATA_SITE_TIERS, normalizeTier } from "./stat"

export type UsageProduct = "All Users" | "Zen" | "Go" | "Enterprise"
export type TokenProduct = "Zen" | "Go" | "Enterprise"
export type UsageRange = "1D" | "1W" | "2W" | "1M" | "2M" | "3M" | "YTD" | "ALL"
export type UsagePoint = { date: string; segments: { model: string; value: number }[] }
export type MarketDay = { date: string; total: number; authors: { author: string; share: number; tokens: number }[] }
export type LeaderboardEntry = {
  model: string
  provider: string
  author: string
  tokens: number
  change: number | null
  rank: number
}
export type TokenCostEntry = { model: string; total: number; input: number; output: number; cached: number }
export type CacheRatioEntry = { model: string; ratio: number; cached: number; uncached: number; total: number }
export type SessionCostEntry = { model: string; cost: number; tokens: number }
export type RetentionEntry = {
  model: string
  provider: string
  author: string
  rate: number
  eligibleUserWeeks: number
  retainedUserWeeks: number
  rank: number | null
}
export type CountryEntry = { country: string; continent: string; tokens: number; share: number; rank: number }
export type ModelUsagePoint = { date: string; tokens: number; users: number; sessions: number; cost: number }
export type ModelMixEntry = { label: string; tokens: number; share: number }
export type ModelPeerEntry = {
  model: string
  provider: string
  author: string
  rank: number
  tokens: number
  share: number
  slug: string
}
export type LabUsageModelEntry = {
  model: string
  provider: string
  author: string
  tokens: number
  share: number
  slug: string
}
export type StatsModelData = {
  updatedAt: string | null
  model: string
  slug: string
  provider: string
  author: string
  rank: number | null
  previousRank: number | null
  totalModels: number
  tokenShare: number
  tokenChange: number
  weeklyRetention: RetentionEntry | null
  totals: {
    sessions: number
    uniqueUsers: number
    tokens: number
    cost: number
    tokensPerSession: number
    costPerSession: number
    costPerMillion: number
    cacheRatio: number
  }
  usage: ModelUsagePoint[]
  tokenMix: ModelMixEntry[]
  country: CountryEntry[]
  peers: ModelPeerEntry[]
}
export type StatsLabData = {
  updatedAt: string | null
  provider: string
  author: string
  tokenShare: number
  tokenChange: number
  totals: {
    sessions: number
    tokens: number
    models: number
  }
  usage: ModelUsagePoint[]
  models: LabUsageModelEntry[]
}
export type StatsModelComparisonEntry = {
  updatedAt: string | null
  model: string
  slug: string
  provider: string
  author: string
  rank: number | null
  previousRank: number | null
  totalModels: number
  tokenShare: number
  tokenChange: number
  weeklyRetention: RetentionEntry | null
  totals: StatsModelData["totals"]
  usage: ModelUsagePoint[]
}
export type StatsModelComparisonInput = {
  provider: string
  model: string
}
export type StatsModelComparisonData = {
  updatedAt: string | null
  models: (StatsModelComparisonEntry | null)[]
}
export type StatsHomeData = {
  updatedAt: string | null
  usage: Record<UsageProduct, Record<UsageRange, UsagePoint[]>>
  users: Record<UsageProduct, Record<UsageRange, UsagePoint[]>>
  leaderboard: Record<UsageProduct, Record<UsageRange, LeaderboardEntry[]>>
  market: Record<UsageRange, MarketDay[]>
  tokenCost: Record<TokenProduct, TokenCostEntry[]>
  cacheRatio: Record<TokenProduct, CacheRatioEntry[]>
  sessionCost: Record<TokenProduct, SessionCostEntry[]>
  retention: RetentionEntry[]
  country: CountryEntry[]
}

export class StatsDataError extends Error {
  override name = "StatsDataError"

  constructor(readonly cause: unknown) {
    super("Failed to load stats data")
  }
}

const DAY_MS = 86_400_000
const TOKEN_SCALE = 1_000_000
const DOLLARS_PER_MICROCENT = 1 / 100_000_000
const METRIC_MODEL_LIMIT = 10
const RETENTION_MODEL_LIMIT = 15
const RETENTION_MIN_ELIGIBLE_USER_WEEKS = 100
const RETENTION_COHORT_WEEKS = 7
const TOP_MODEL_SEGMENT_LIMIT = 9
const QUERY_CACHE_TTL_MS = 5 * 60 * 1000
const QUERY_CACHE_MAX_ENTRIES = 256
// Preserve the response shape while the public site presents Go and Free as one cohort.
const SITE_PRODUCT = "Go"
const SITE_TIER_PLACEHOLDERS = DATA_SITE_TIERS.map(() => "?").join(", ")
const LEADERBOARD_CHANGE_MIN_MULTIPLE = 10
const months = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"] as const

type StatMetricRow = Omit<ModelStatMetric, "updatedAt"> & {
  periodStart: number
  updatedAt: number
}
type CountryTotalRow = {
  country: string
  continent: string
  tokens: number
  updatedAt: number
}
export type RetentionMetricRow = {
  cohortDate: string
  updatedAt: number
  provider: string
  model: string
  eligibleUsers: number
  retainedUsers: number
}

type DateWindow = { start: number; end: number; previousStart: number; previousEnd: number }
type Bucket = { start: number; end: number; label: string }
type ModelAggregate = {
  model: string
  provider: string
  sessions: number
  uniqueUsers: number
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  cacheReadTokens: number
  totalTokens: number
  inputCostMicrocents: number
  outputCostMicrocents: number
  totalCostMicrocents: number
}

type RawRow = Record<string, unknown>
type CachedQuery = { expiresAt: number; value: Promise<RawRow[]> }

const queryCache = new Map<string, CachedQuery>()

export function getStatsHomeData(): Effect.Effect<StatsHomeData, StatsDataError> {
  return Effect.tryPromise({
    try: async () => {
      const [modelRows, retentionRows] = await Promise.all([listModelDaily(), listRetentionWeekly()])
      const window = modelRowsWindow(modelRows, "2M")
      const geoRows = window ? await listCountryTotals(window) : []
      return buildStatsHomeData(modelRows, geoRows, retentionRows)
    },
    catch: (cause) => new StatsDataError(cause),
  })
}

export function getStatsModelData(
  model: string,
  provider?: string,
): Effect.Effect<StatsModelData | null, StatsDataError> {
  return Effect.tryPromise({
    try: async () => {
      const [modelRows, retentionRows] = await Promise.all([listModelDaily(), listRetentionWeekly()])
      const normalized = modelRows.flatMap(normalizeStatRow)
      const resolvedModel = resolveModelName(model, normalized, provider)
      if (!resolvedModel) return null
      const window = modelRowsWindow(modelRows, "2M")
      const resolvedProvider = resolveModelProvider(resolvedModel, normalized, provider)
      return buildStatsModelData(
        resolvedModel,
        modelRows,
        window ? await listCountryTotals(window, { model: resolvedModel, provider: resolvedProvider }) : [],
        provider,
        retentionRows,
      )
    },
    catch: (cause) => new StatsDataError(cause),
  })
}

export function getStatsLabData(provider: string): Effect.Effect<StatsLabData | null, StatsDataError> {
  return Effect.tryPromise({
    try: async () => buildStatsLabData(provider, await listModelDaily()),
    catch: (cause) => new StatsDataError(cause),
  })
}

async function listModelDaily(): Promise<ModelStatMetric[]> {
  return (
    await queryRows(
      `select period_key, updated_at, tier, provider, model, sessions, unique_users, input_tokens,
    output_tokens, reasoning_tokens, cache_read_tokens, total_tokens, input_cost_microcents, output_cost_microcents,
    total_cost_microcents from model_stat where grain = 'day' and dataset = 'zen' and client = 'all'
    and source = 'all' and tier in (${SITE_TIER_PLACEHOLDERS}) order by period_key`,
      DATA_SITE_TIERS,
    )
  ).map((row) => ({
    periodKey: stringValue(row.period_key),
    updatedAt: dateValue(row.updated_at),
    tier: stringValue(row.tier),
    provider: stringValue(row.provider),
    model: stringValue(row.model),
    sessions: numberValue(row.sessions),
    uniqueUsers: numberValue(row.unique_users),
    inputTokens: numberValue(row.input_tokens),
    outputTokens: numberValue(row.output_tokens),
    reasoningTokens: numberValue(row.reasoning_tokens),
    cacheReadTokens: numberValue(row.cache_read_tokens),
    totalTokens: numberValue(row.total_tokens),
    inputCostMicrocents: numberValue(row.input_cost_microcents),
    outputCostMicrocents: numberValue(row.output_cost_microcents),
    totalCostMicrocents: numberValue(row.total_cost_microcents),
  }))
}

async function listCountryTotals(
  window: DateWindow,
  opts?: { provider?: string; model?: string },
): Promise<CountryTotalRow[]> {
  const scope =
    opts?.model && opts.provider
      ? "and provider = ? and model = ?"
      : opts?.model
        ? "and model = ?"
        : "and provider = 'all' and model = 'all'"
  const params = opts?.model && opts.provider ? [opts.provider, opts.model] : opts?.model ? [opts.model] : []
  return (
    await queryRows(
      `select country, max(continent) as continent, sum(total_tokens) as total_tokens, max(updated_at) as updated_at
    from geo_stat where grain = 'day' and dataset = 'zen' and client = 'all' and source = 'all'
    and tier in (${SITE_TIER_PLACEHOLDERS}) ${scope} and period_key >= ? and period_key < ? group by country`,
      [...DATA_SITE_TIERS, ...params, periodKey(window.start), periodKey(window.end)],
    )
  ).map((row) => ({
    updatedAt: dateValue(row.updated_at).getTime(),
    country: stringValue(row.country) || "ZZ",
    continent: stringValue(row.continent),
    tokens: numberValue(row.total_tokens),
  }))
}

async function listRetentionWeekly(): Promise<RetentionMetricRow[]> {
  try {
    return (
      await queryRows(
        `select cohort_date, updated_at, provider, model, eligible_users, retained_users
      from model_retention where dataset = 'zen' and tier = 'Go' order by cohort_date`,
      )
    ).map((row) => ({
      cohortDate: stringValue(row.cohort_date),
      updatedAt: dateValue(row.updated_at).getTime(),
      provider: stringValue(row.provider),
      model: stringValue(row.model),
      eligibleUsers: numberValue(row.eligible_users),
      retainedUsers: numberValue(row.retained_users),
    }))
  } catch (cause) {
    if (isMissingRetentionTable(cause)) return []
    throw cause
  }
}

async function queryRows(query: string, params: string[] = []) {
  const key = JSON.stringify([query, params])
  const now = Date.now()
  const cached = queryCache.get(key)
  if (cached && cached.expiresAt > now) return cached.value
  if (cached) queryCache.delete(key)

  const value = new Client({ url: databaseUrl() }).execute(query, params).then((result) => result.rows as RawRow[])
  const entry = { expiresAt: now + QUERY_CACHE_TTL_MS, value }
  queryCache.set(key, entry)
  if (queryCache.size > QUERY_CACHE_MAX_ENTRIES) queryCache.delete(queryCache.keys().next().value!)

  return value.catch((cause) => {
    if (queryCache.get(key) === entry) queryCache.delete(key)
    throw cause
  })
}

function databaseUrl() {
  return process.env.DATABASE_URL ?? Resource.StatsDatabase.url
}

function stringValue(value: unknown) {
  return value == null ? "" : String(value)
}

function numberValue(value: unknown) {
  return Number(value ?? 0)
}

function dateValue(value: unknown) {
  return value instanceof Date ? value : new Date(stringValue(value))
}

export function getStatsModelsComparisonData(
  models: readonly StatsModelComparisonInput[],
): Effect.Effect<StatsModelComparisonData, StatsDataError> {
  return Effect.tryPromise({
    try: async () => {
      const [rows, retentionRows] = await Promise.all([listModelDaily(), listRetentionWeekly()])
      const entries = models.map((model) =>
        toComparisonEntry(buildStatsModelData(model.model, rows, [], model.provider, retentionRows)),
      )
      const latest = entries
        .map((model) => model?.updatedAt)
        .flatMap((value) => (value ? [dateTime(value)] : []))
        .toSorted((a, b) => b - a)[0]
      return {
        updatedAt: latest === undefined ? null : new Date(latest).toISOString(),
        models: entries,
      }
    },
    catch: (cause) => new StatsDataError(cause),
  })
}

export const getStatsModelComparisonData = (
  firstProvider: string,
  firstModel: string,
  secondProvider: string,
  secondModel: string,
) =>
  getStatsModelsComparisonData([
    { provider: firstProvider, model: firstModel },
    { provider: secondProvider, model: secondModel },
  ])

function buildStatsHomeData(
  modelRows: ModelStatMetric[],
  countryRows: CountryTotalRow[],
  retentionRows: RetentionMetricRow[],
): StatsHomeData {
  const normalized = modelRows.flatMap(normalizeStatRow)
  if (normalized.length === 0) return emptyStatsHomeData()

  const earliest = Math.min(...normalized.map((row) => row.periodStart))
  const latest = Math.max(...normalized.map((row) => row.periodStart))
  const latestUpdate = Math.max(...normalized.map((row) => row.updatedAt), ...countryRows.map((row) => row.updatedAt))

  return {
    updatedAt: new Date(latestUpdate).toISOString(),
    usage: createUsageProductRecord((product) =>
      createRangeRecord((range) =>
        buildUsagePoints(
          normalized,
          product,
          range,
          getWindow(range, earliest, latest),
          getWindow("1W", earliest, latest),
        ),
      ),
    ),
    users: createUsageProductRecord((product) =>
      createRangeRecord((range) =>
        buildUsagePoints(
          normalized,
          product,
          range,
          getWindow(range, earliest, latest),
          getWindow("1W", earliest, latest),
          "users",
        ),
      ),
    ),
    leaderboard: createUsageProductRecord((product) =>
      createRangeRecord((_range) => buildLeaderboard(normalized, product, getWindow("1W", earliest, latest))),
    ),
    market: createRangeRecord((range) => buildMarketShare(normalized, "Go", range, getWindow(range, earliest, latest))),
    tokenCost: createTokenProductRecord((product) =>
      buildTokenCost(normalized, product, getWindow("1W", earliest, latest)),
    ),
    cacheRatio: createTokenProductRecord((product) =>
      buildCacheRatio(normalized, product, getWindow("1W", earliest, latest)),
    ),
    sessionCost: createTokenProductRecord((product) =>
      buildSessionCost(normalized, product, getWindow("1W", earliest, latest)),
    ),
    retention: buildRetentionEntries(retentionRows)
      .filter((item) => item.rank !== null)
      .slice(0, RETENTION_MODEL_LIMIT),
    country: buildCountryStats(countryRows),
  }
}

function buildStatsModelData(
  modelParam: string,
  modelRows: ModelStatMetric[],
  countryRows: CountryTotalRow[],
  providerParam?: string,
  retentionRows: RetentionMetricRow[] = [],
): StatsModelData | null {
  const normalized = modelRows.flatMap(normalizeStatRow)
  if (normalized.length === 0) return null

  const model = resolveModelName(modelParam, normalized, providerParam)
  if (!model) return null

  const modelScopedRows = normalized.filter((row) => row.model === model)
  const earliest = Math.min(...normalized.map((row) => row.periodStart))
  const latest = Math.max(...normalized.map((row) => row.periodStart))
  const latestUpdate = Math.max(...modelScopedRows.map((row) => row.updatedAt))
  const window = getWindow("2M", earliest, latest)
  const rankWindow = getWindow("1W", earliest, latest)
  const currentRows = rowsForProduct(modelScopedRows, SITE_PRODUCT, window.start, window.end)
  const previousRows = rowsForProduct(modelScopedRows, SITE_PRODUCT, window.previousStart, window.previousEnd)
  const current = combineRowsForModel(model, currentRows)
  const previous = combineRowsForModel(model, previousRows)
  const rankPeers = aggregateByModelName(rowsForProduct(normalized, SITE_PRODUCT, rankWindow.start, rankWindow.end))
    .filter((item) => item.totalTokens > 0)
    .toSorted((a, b) => b.totalTokens - a.totalTokens || a.model.localeCompare(b.model))
  const previousRankPeers = aggregateByModelName(
    rowsForProduct(normalized, SITE_PRODUCT, rankWindow.previousStart, rankWindow.previousEnd),
  )
    .filter((item) => item.totalTokens > 0)
    .toSorted((a, b) => b.totalTokens - a.totalTokens || a.model.localeCompare(b.model))
  const windowPeers = aggregateByModelName(rowsForProduct(normalized, SITE_PRODUCT, window.start, window.end))
    .filter((item) => item.totalTokens > 0)
    .toSorted((a, b) => b.totalTokens - a.totalTokens || a.model.localeCompare(b.model))
  const rankIndex = rankPeers.findIndex((item) => item.model === model)
  const rank = rankIndex >= 0 ? rankIndex + 1 : null
  const previousRankIndex = previousRankPeers.findIndex((item) => item.model === model)
  const peerRank = rankIndex >= 0 ? rankIndex + 1 : 1
  const totalTokens = windowPeers.reduce((sum, item) => sum + item.totalTokens, 0)
  const peerTokens = rankPeers.reduce((sum, item) => sum + item.totalTokens, 0)
  const weeklyRetention = buildRetentionEntries(retentionRows).find((item) => item.model === model) ?? null

  return {
    updatedAt: Number.isFinite(latestUpdate) ? new Date(latestUpdate).toISOString() : null,
    model,
    slug: modelSlug(model),
    provider: current.provider,
    author: formatProvider(current.provider),
    rank,
    previousRank: previousRankIndex >= 0 ? previousRankIndex + 1 : null,
    totalModels: windowPeers.length,
    tokenShare: totalTokens > 0 ? round((current.totalTokens / totalTokens) * 100, 2) : 0,
    tokenChange: percentChange(current.totalTokens, previous.totalTokens),
    weeklyRetention,
    totals: {
      sessions: current.sessions,
      uniqueUsers: current.uniqueUsers,
      tokens: current.totalTokens,
      cost: round(microcentsToDollars(current.totalCostMicrocents), 2),
      tokensPerSession: current.sessions > 0 ? Math.round(current.totalTokens / current.sessions) : 0,
      costPerSession:
        current.sessions > 0 ? round(microcentsToDollars(current.totalCostMicrocents) / current.sessions, 4) : 0,
      costPerMillion: costPerMillion(current.totalCostMicrocents, current.totalTokens),
      cacheRatio:
        current.inputTokens + current.cacheReadTokens > 0
          ? round((current.cacheReadTokens / (current.inputTokens + current.cacheReadTokens)) * 100, 1)
          : 0,
    },
    usage: buildModelUsage(currentRows, window, "2M"),
    tokenMix: buildModelTokenMix(current),
    country: buildCountryStats(countryRows),
    peers: buildModelPeers(rankPeers, peerRank, peerTokens),
  }
}

function buildStatsLabData(providerParam: string, modelRows: ModelStatMetric[]): StatsLabData | null {
  const normalized = modelRows.flatMap(normalizeStatRow)
  if (normalized.length === 0) return null

  const provider = resolveProviderName(providerParam, normalized)
  if (!provider) return null

  const providerRows = normalized.filter((row) => providerMatches(row.provider, provider))
  if (providerRows.length === 0) return null

  const earliest = Math.min(...normalized.map((row) => row.periodStart))
  const latest = Math.max(...normalized.map((row) => row.periodStart))
  const latestUpdate = Math.max(...providerRows.map((row) => row.updatedAt))
  const window = getWindow("2M", earliest, latest)
  const currentRows = rowsForProduct(providerRows, SITE_PRODUCT, window.start, window.end)
  const previousRows = rowsForProduct(providerRows, SITE_PRODUCT, window.previousStart, window.previousEnd)
  const current = combineRowsForModel("", currentRows)
  const previous = combineRowsForModel("", previousRows)
  const allCurrent = aggregateByModel(rowsForProduct(normalized, SITE_PRODUCT, window.start, window.end))
  const totalTokens = allCurrent.reduce((sum, item) => sum + item.totalTokens, 0)
  const models = aggregateByModel(currentRows)
    .filter((item) => item.totalTokens > 0)
    .toSorted((a, b) => b.totalTokens - a.totalTokens || a.model.localeCompare(b.model))

  return {
    updatedAt: Number.isFinite(latestUpdate) ? new Date(latestUpdate).toISOString() : null,
    provider,
    author: formatProvider(provider),
    tokenShare: totalTokens > 0 ? round((current.totalTokens / totalTokens) * 100, 2) : 0,
    tokenChange: percentChange(current.totalTokens, previous.totalTokens),
    totals: {
      sessions: current.sessions,
      tokens: current.totalTokens,
      models: models.length,
    },
    usage: buildModelUsage(currentRows, window, "2M"),
    models: models.map((item) => ({
      model: item.model,
      provider: item.provider,
      author: formatProvider(item.provider),
      tokens: item.totalTokens,
      share: current.totalTokens > 0 ? round((item.totalTokens / current.totalTokens) * 100, 2) : 0,
      slug: modelSlug(item.model),
    })),
  }
}

function toComparisonEntry(data: StatsModelData | null): StatsModelComparisonEntry | null {
  if (!data) return null
  return {
    updatedAt: data.updatedAt,
    model: data.model,
    slug: data.slug,
    provider: data.provider,
    author: data.author,
    rank: data.rank,
    previousRank: data.previousRank,
    totalModels: data.totalModels,
    tokenShare: data.tokenShare,
    tokenChange: data.tokenChange,
    weeklyRetention: data.weeklyRetention,
    totals: data.totals,
    usage: data.usage,
  }
}

function emptyStatsHomeData(): StatsHomeData {
  return {
    updatedAt: null,
    usage: createUsageProductRecord(() => createRangeRecord(() => [])),
    users: createUsageProductRecord(() => createRangeRecord(() => [])),
    leaderboard: createUsageProductRecord(() => createRangeRecord(() => [])),
    market: createRangeRecord(() => []),
    tokenCost: createTokenProductRecord(() => []),
    cacheRatio: createTokenProductRecord(() => []),
    sessionCost: createTokenProductRecord(() => []),
    retention: [],
    country: [],
  }
}

export function buildRetentionEntries(rows: RetentionMetricRow[]): RetentionEntry[] {
  const cohortDates = [...new Set(rows.map((row) => row.cohortDate))].toSorted().slice(-RETENTION_COHORT_WEEKS)
  const aggregate = rows
    .filter((row) => cohortDates.includes(row.cohortDate))
    .reduce<Map<string, Omit<RetentionEntry, "author" | "rate" | "rank">>>((result, row) => {
      const current = result.get(row.model)
      result.set(row.model, {
        model: row.model,
        provider: current?.provider ?? row.provider,
        eligibleUserWeeks: (current?.eligibleUserWeeks ?? 0) + row.eligibleUsers,
        retainedUserWeeks: (current?.retainedUserWeeks ?? 0) + row.retainedUsers,
      })
      return result
    }, new Map())
  const entries = [...aggregate.values()].map((item) => ({
    ...item,
    author: formatProvider(item.provider),
    rate: item.eligibleUserWeeks > 0 ? round((item.retainedUserWeeks / item.eligibleUserWeeks) * 100, 1) : 0,
  }))
  const ranks = new Map(
    entries
      .filter((item) => item.eligibleUserWeeks >= RETENTION_MIN_ELIGIBLE_USER_WEEKS)
      .toSorted(
        (a, b) => b.rate - a.rate || b.eligibleUserWeeks - a.eligibleUserWeeks || a.model.localeCompare(b.model),
      )
      .map((item, index) => [item.model, index + 1]),
  )
  return entries
    .map((item) => ({ ...item, rank: ranks.get(item.model) ?? null }))
    .toSorted((a, b) => (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER))
}

function buildUsagePoints(
  rows: StatMetricRow[],
  product: UsageProduct,
  range: UsageRange,
  window: DateWindow,
  rankWindow: DateWindow,
  metric: "tokens" | "users" = "tokens",
) {
  const modelOrder = aggregateByModelName(rowsForProduct(rows, product, rankWindow.start, rankWindow.end))
    .toSorted((a, b) => modelUsageValue(b, metric) - modelUsageValue(a, metric))
    .slice(0, TOP_MODEL_SEGMENT_LIMIT)
    .map((item) => item.model)

  return createBuckets(window, range).map((bucket) => {
    const bucketRows = aggregateByModelName(rowsForProduct(rows, product, bucket.start, bucket.end))
    const byModel = new Map(bucketRows.map((item) => [item.model, modelUsageValue(item, metric)]))
    const segments = modelOrder.map((model) => ({ model, value: byModel.get(model) ?? 0 }))
    const knownValue = segments.reduce((sum, item) => sum + item.value, 0)
    const totalValue = bucketRows.reduce((sum, item) => sum + modelUsageValue(item, metric), 0)
    return {
      date: bucket.label,
      segments: [
        ...segments.map((item) => ({ model: item.model, value: usagePointValue(item.value, metric) })),
        { model: "Other", value: usagePointValue(Math.max(totalValue - knownValue, 0), metric) },
      ],
    }
  })
}

function modelUsageValue(item: ModelAggregate, metric: "tokens" | "users") {
  if (metric === "users") return item.uniqueUsers
  return item.totalTokens
}

function usagePointValue(value: number, metric: "tokens" | "users") {
  if (metric === "users") return value
  return round(value / 1_000_000_000_000, 4)
}

function buildLeaderboard(rows: StatMetricRow[], product: UsageProduct, rankWindow: DateWindow) {
  const previous = new Map(
    aggregateByModelName(rowsForProduct(rows, product, rankWindow.previousStart, rankWindow.previousEnd)).map(
      (item) => [item.model, item.totalTokens],
    ),
  )

  return aggregateByModelName(rowsForProduct(rows, product, rankWindow.start, rankWindow.end))
    .toSorted((a, b) => b.totalTokens - a.totalTokens || a.model.localeCompare(b.model))
    .slice(0, 18)
    .map((item, index) => ({
      model: item.model,
      provider: item.provider,
      author: formatProvider(item.provider),
      tokens: Math.round(item.totalTokens / 1_000_000_000),
      change: leaderboardChange(item.totalTokens, previous.get(item.model) ?? 0),
      rank: index + 1,
    }))
}

function buildMarketShare(rows: StatMetricRow[], product: UsageProduct, range: UsageRange, window: DateWindow) {
  const providerOrder = aggregateByProvider(rowsForProduct(rows, product, window.start, window.end))
    .filter((item) => item.provider !== "unknown")
    .toSorted((a, b) => b.tokens - a.tokens || a.provider.localeCompare(b.provider))
    .slice(0, 8)
    .map((item) => item.provider)

  return createBuckets(window, range).flatMap((bucket) => {
    const total = aggregateByProvider(rowsForProduct(rows, product, bucket.start, bucket.end))
    const totalTokens = total.reduce((sum, item) => sum + item.tokens, 0)
    if (totalTokens === 0) return []

    const byProvider = new Map(total.map((item) => [item.provider, item.tokens]))
    const authors = providerOrder.map((provider) => ({ provider, tokens: byProvider.get(provider) ?? 0 }))
    const knownTokens = authors.reduce((sum, item) => sum + item.tokens, 0)
    const withOther = [...authors, { provider: "Other", tokens: Math.max(totalTokens - knownTokens, 0) }].filter(
      (item) => item.tokens > 0,
    )

    return [
      {
        date: bucket.label,
        total: round(totalTokens / 1_000_000_000_000, 6),
        authors: withOther.map((item) => ({
          author: item.provider === "Other" ? "Other" : formatProvider(item.provider),
          share: round((item.tokens / totalTokens) * 100, 1),
          tokens: round(item.tokens / 1_000_000_000_000, 6),
        })),
      },
    ]
  })
}

function buildCountryStats(rows: CountryTotalRow[]) {
  const countries = rows
    .filter((item) => item.tokens > 0 && item.country !== "AQ")
    .toSorted((a, b) => b.tokens - a.tokens)
  const totalTokens = countries.reduce((sum, item) => sum + item.tokens, 0)
  if (totalTokens === 0) return []

  return countries.map((item, index) => ({
    country: item.country,
    continent: item.continent,
    tokens: round(item.tokens / 1_000_000_000_000, 4),
    share: round((item.tokens / totalTokens) * 100, 1),
    rank: index + 1,
  }))
}

function buildTokenCost(rows: StatMetricRow[], product: TokenProduct, window: DateWindow) {
  return topModelsByUsage(rows, product, window)
    .flatMap((item) => {
      const total = costPerMillion(item.totalCostMicrocents, item.totalTokens)
      return [
        {
          model: item.model,
          total,
          input: costPerMillion(item.inputCostMicrocents, item.inputTokens),
          output: costPerMillion(item.outputCostMicrocents, item.outputTokens + item.reasoningTokens),
          cached: costPerMillion(item.inputCostMicrocents, item.inputTokens + item.cacheReadTokens),
        },
      ]
    })
    .toSorted((a, b) => a.total - b.total)
}

function buildCacheRatio(rows: StatMetricRow[], product: TokenProduct, window: DateWindow) {
  return topModelsByUsage(rows, product, window)
    .flatMap((item) => {
      const total = item.inputTokens + item.cacheReadTokens
      if (total === 0) return []
      return [
        {
          model: item.model,
          ratio: round((item.cacheReadTokens / total) * 100, 1),
          cached: round(item.cacheReadTokens / 1_000_000_000, 1),
          uncached: round(item.inputTokens / 1_000_000_000, 1),
          total: round(total / 1_000_000_000, 1),
        },
      ]
    })
    .toSorted((a, b) => b.ratio - a.ratio || b.cached - a.cached)
}

function buildSessionCost(rows: StatMetricRow[], product: TokenProduct, window: DateWindow) {
  return topModelsByUsage(rows, product, window)
    .flatMap((item) => {
      if (item.sessions === 0) return []
      const cost = round(microcentsToDollars(item.totalCostMicrocents) / item.sessions, 4)
      if (cost === 0) return []
      return [{ model: item.model, cost, tokens: Math.round(item.totalTokens / item.sessions) }]
    })
    .toSorted((a, b) => a.cost - b.cost)
}

function topModelsByUsage(rows: StatMetricRow[], product: TokenProduct, window: DateWindow) {
  return aggregateByModel(rowsForProduct(rows, product, window.start, window.end))
    .toSorted((a, b) => b.totalTokens - a.totalTokens)
    .slice(0, METRIC_MODEL_LIMIT)
}

function buildModelUsage(rows: StatMetricRow[], window: DateWindow, range: UsageRange) {
  return createBuckets(window, range).map((bucket) => {
    const aggregate = combineRowsForModel(
      "",
      rows.filter((row) => row.periodStart >= bucket.start && row.periodStart < bucket.end),
    )
    return {
      date: bucket.label,
      tokens: aggregate.totalTokens,
      users: aggregate.uniqueUsers,
      sessions: aggregate.sessions,
      cost: round(microcentsToDollars(aggregate.totalCostMicrocents), 2),
    }
  })
}

function buildModelTokenMix(aggregate: ModelAggregate): ModelMixEntry[] {
  const items = [
    { label: "Input", tokens: aggregate.inputTokens },
    { label: "Output", tokens: aggregate.outputTokens },
    { label: "Reasoning", tokens: aggregate.reasoningTokens },
    { label: "Cached", tokens: aggregate.cacheReadTokens },
  ].filter((item) => item.tokens > 0)
  const total = items.reduce((sum, item) => sum + item.tokens, 0)
  if (total === 0) return []
  return items.map((item) => ({ ...item, share: round((item.tokens / total) * 100, 1) }))
}

function buildModelPeers(peers: ModelAggregate[], rank: number, totalTokens: number): ModelPeerEntry[] {
  const start = Math.max(0, Math.min(rank - 5, Math.max(peers.length - 10, 0)))
  return peers.slice(start, start + 10).map((item, index) => ({
    model: item.model,
    provider: item.provider,
    author: formatProvider(item.provider),
    rank: start + index + 1,
    tokens: item.totalTokens,
    share: totalTokens > 0 ? round((item.totalTokens / totalTokens) * 100, 2) : 0,
    slug: modelSlug(item.model),
  }))
}

function rowsForProduct<T extends { periodStart: number; tier: string }>(
  rows: T[],
  product: UsageProduct,
  start: number,
  end: number,
) {
  const windowRows = rows.filter((row) => row.periodStart >= start && row.periodStart < end)
  if (product === SITE_PRODUCT) return windowRows.filter((row) => row.tier === "Go" || row.tier === "Free")
  if (product !== "All Users") return windowRows.filter((row) => row.tier === product)

  const allRows = windowRows.filter((row) => row.tier === "all")
  if (allRows.length > 0) return allRows
  return windowRows.filter((row) => row.tier !== "all")
}

function aggregateByModel(rows: StatMetricRow[]) {
  return Object.values(
    rows.reduce<Record<string, ModelAggregate>>((result, row) => {
      const key = modelKey(row.provider, row.model)
      result[key] = combineModelAggregate(result[key], row)
      return result
    }, {}),
  )
}

function aggregateByModelName(rows: StatMetricRow[]) {
  return Object.values(
    rows.reduce<Record<string, ModelAggregate>>((result, row) => {
      result[row.model] = combineModelAggregate(result[row.model], row)
      return result
    }, {}),
  )
}

function aggregateByProvider(rows: { provider: string; totalTokens: number }[]) {
  return Object.values(
    rows.reduce<Record<string, { provider: string; tokens: number }>>((result, row) => {
      result[row.provider] = {
        provider: row.provider,
        tokens: (result[row.provider]?.tokens ?? 0) + row.totalTokens,
      }
      return result
    }, {}),
  )
}

function combineRowsForModel(model: string, rows: StatMetricRow[]): ModelAggregate {
  const aggregate = rows.reduce<ModelAggregate | undefined>(
    (result, row) => combineModelAggregate(result, row),
    undefined,
  )
  if (aggregate) return { ...aggregate, model: model || aggregate.model }
  return {
    model,
    provider: "unknown",
    sessions: 0,
    uniqueUsers: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    totalTokens: 0,
    inputCostMicrocents: 0,
    outputCostMicrocents: 0,
    totalCostMicrocents: 0,
  }
}

function combineModelAggregate(current: ModelAggregate | undefined, row: StatMetricRow): ModelAggregate {
  return {
    model: row.model,
    provider: row.provider,
    sessions: (current?.sessions ?? 0) + row.sessions,
    uniqueUsers: (current?.uniqueUsers ?? 0) + row.uniqueUsers,
    inputTokens: (current?.inputTokens ?? 0) + row.inputTokens,
    outputTokens: (current?.outputTokens ?? 0) + row.outputTokens,
    reasoningTokens: (current?.reasoningTokens ?? 0) + row.reasoningTokens,
    cacheReadTokens: (current?.cacheReadTokens ?? 0) + row.cacheReadTokens,
    totalTokens: (current?.totalTokens ?? 0) + row.totalTokens,
    inputCostMicrocents: (current?.inputCostMicrocents ?? 0) + row.inputCostMicrocents,
    outputCostMicrocents: (current?.outputCostMicrocents ?? 0) + row.outputCostMicrocents,
    totalCostMicrocents: (current?.totalCostMicrocents ?? 0) + row.totalCostMicrocents,
  }
}

function getWindow(range: UsageRange, earliest: number, latest: number): DateWindow {
  const end = latest + DAY_MS
  const start = Math.max(
    earliest,
    range === "1D"
      ? latest
      : range === "1W"
        ? latest - 6 * DAY_MS
        : range === "2W"
          ? latest - 13 * DAY_MS
          : range === "1M"
            ? latest - 27 * DAY_MS
            : range === "2M"
              ? latest - 55 * DAY_MS
              : range === "3M"
                ? latest - 89 * DAY_MS
                : range === "YTD"
                  ? Date.UTC(new Date(latest).getUTCFullYear(), 0, 1)
                  : earliest,
  )
  const duration = end - start
  return { start, end, previousStart: start - duration, previousEnd: start }
}

function createBuckets(window: DateWindow, range: UsageRange): Bucket[] {
  const span = Math.max(window.end - window.start, DAY_MS)
  const count =
    range === "1D"
      ? 1
      : range === "1W" || range === "2W" || range === "1M" || range === "2M" || range === "3M"
        ? Math.ceil(span / DAY_MS)
        : Math.max(1, Math.min(7, Math.ceil(span / DAY_MS)))
  const size = span / count
  return Array.from({ length: count }, (_, index) => {
    const start = window.start + index * size
    const end = index === count - 1 ? window.end : window.start + (index + 1) * size
    return { start, end, label: formatBucketLabel(start, end, range) }
  })
}

function createUsageProductRecord<T>(value: (product: UsageProduct) => T): Record<UsageProduct, T> {
  return {
    "All Users": value("All Users"),
    Zen: value("Zen"),
    Go: value("Go"),
    Enterprise: value("Enterprise"),
  }
}

function createTokenProductRecord<T>(value: (product: TokenProduct) => T): Record<TokenProduct, T> {
  return {
    Zen: value("Zen"),
    Go: value("Go"),
    Enterprise: value("Enterprise"),
  }
}

function createRangeRecord<T>(value: (range: UsageRange) => T): Record<UsageRange, T> {
  return {
    "1D": value("1D"),
    "1W": value("1W"),
    "2W": value("2W"),
    "1M": value("1M"),
    "2M": value("2M"),
    "3M": value("3M"),
    YTD: value("YTD"),
    ALL: value("ALL"),
  }
}

function normalizeStatRow(row: ModelStatMetric): StatMetricRow[] {
  const periodStart = periodKeyTime(row.periodKey)
  const updatedAt = dateTime(row.updatedAt)
  if (!Number.isFinite(periodStart) || !Number.isFinite(updatedAt)) return []
  return [
    {
      ...row,
      periodStart,
      updatedAt,
      tier: normalizeTier(row.tier),
      provider: statProvider(row.model, undefined, row.provider) || "unknown",
      model: row.model || "unknown",
    },
  ]
}

function modelRowsWindow(rows: ModelStatMetric[], range: UsageRange): DateWindow | undefined {
  const periods = rows.map((row) => periodKeyTime(row.periodKey)).filter(Number.isFinite)
  if (periods.length === 0) return undefined
  return getWindow(range, Math.min(...periods), Math.max(...periods))
}

function dateTime(value: Date | string) {
  return (value instanceof Date ? value : new Date(value)).getTime()
}

function periodKey(value: number) {
  return new Date(value).toISOString().slice(0, 10)
}

function periodKeyTime(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return Number.NaN
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
}

function formatBucketLabel(start: number, _end: number, range: UsageRange) {
  const date = new Date(start)
  if (range === "YTD") return months[date.getUTCMonth()]
  if (range === "ALL")
    return date.getUTCFullYear() === new Date().getUTCFullYear()
      ? months[date.getUTCMonth()]
      : String(date.getUTCFullYear())
  return formatDay(start)
}

function formatDay(value: number) {
  const date = new Date(value)
  return `${months[date.getUTCMonth()]} ${date.getUTCDate()}`
}

function formatProvider(provider: string) {
  const known: Record<string, string> = {
    anthropic: "Anthropic",
    deepseek: "DeepSeek",
    google: "Google",
    minimax: "MiniMax",
    meta: "Meta",
    moonshot: "Moonshot",
    moonshotai: "Moonshot",
    nvidia: "NVIDIA",
    opencode: "opencode",
    openai: "OpenAI",
    qwen: "Qwen",
    tencent: "Tencent",
    xai: "xAI",
    xiaomi: "Xiaomi",
    zhipu: "Zhipu",
    zhipuai: "Zhipu",
  }
  const normalized = provider.toLowerCase().replace(/[^a-z0-9]/g, "")
  return known[normalized] ?? provider.replace(/[-_]/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase())
}

function resolveModelName(modelParam: string, rows: StatMetricRow[], providerParam?: string) {
  const input = modelParam.trim()
  if (!input) return undefined
  const normalizedInput = input.toLowerCase()
  const inputSlug = modelSlug(input)
  const candidates = providerParam
    ? aggregateByModel(rows).filter((item) => providerMatches(item.provider, providerParam))
    : aggregateByModelName(rows)
  return candidates
    .filter((item) => item.model.toLowerCase() === normalizedInput || modelSlug(item.model) === inputSlug)
    .toSorted((a, b) => b.totalTokens - a.totalTokens || a.model.localeCompare(b.model))[0]?.model
}

function resolveModelProvider(model: string, rows: StatMetricRow[], providerParam?: string) {
  return aggregateByModel(rows)
    .filter((item) => item.model === model && (!providerParam || providerMatches(item.provider, providerParam)))
    .toSorted((a, b) => b.totalTokens - a.totalTokens || a.provider.localeCompare(b.provider))[0]?.provider
}

function providerMatches(provider: string, providerParam: string) {
  return providerSlug(provider) === providerSlug(providerParam)
}

function resolveProviderName(providerParam: string, rows: StatMetricRow[]) {
  const input = providerParam.trim()
  if (!input) return undefined
  return aggregateByModel(rows)
    .filter((item) => providerMatches(item.provider, input))
    .toSorted((a, b) => b.totalTokens - a.totalTokens || a.provider.localeCompare(b.provider))[0]?.provider
}

export function modelSlug(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
}

function modelKey(provider: string, model: string) {
  return `${provider}\u0000${model}`
}

function providerSlug(value: string) {
  const slug = modelSlug(value)
  const aliases: Record<string, string> = {
    alibaba: "qwen",
    moonshotai: "moonshot",
    qwen: "qwen",
    zhipuai: "zhipu",
  }
  return aliases[slug] ?? slug
}

function costPerMillion(costMicrocents: number, tokens: number) {
  if (tokens <= 0 || costMicrocents <= 0) return 0
  return round((microcentsToDollars(costMicrocents) / tokens) * TOKEN_SCALE, 2)
}

function microcentsToDollars(value: number) {
  return value * DOLLARS_PER_MICROCENT
}

function percentChange(current: number, previous: number) {
  if (previous <= 0) return current > 0 ? 100 : 0
  return Math.round(((current - previous) / previous) * 100)
}

function leaderboardChange(current: number, previous: number) {
  if (current <= 0) return 0
  if (previous <= 0 || current >= previous * LEADERBOARD_CHANGE_MIN_MULTIPLE) return null
  return percentChange(current, previous)
}

function round(value: number, digits: number) {
  return Number(value.toFixed(digits))
}
