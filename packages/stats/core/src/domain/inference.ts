import { Resource } from "sst/resource"
import type { R2SqlData } from "../r2-sql"
import type { GeoStatAggregate } from "./geo"
import type { ModelStatAggregate } from "./model"
import {
  EXCLUDED_MODELS,
  FREE_MODELS,
  MODEL_AUTHOR_RULES,
  MODEL_NAME_ALIASES,
  RETIRED_STAT_PROVIDERS,
  STEALTH_MODELS,
  statModel,
  statProvider,
} from "./model-normalization"
import type { ProviderStatAggregate } from "./provider"
import type { RetentionStatAggregate } from "./retention"
import {
  normalizeCountry,
  normalizeTier,
  periodKeyFor,
  startOfIsoWeek,
  startOfUtcDay,
  type StatBaseAggregate,
} from "./stat"

export type StatDimension = "model" | "provider" | "geo" | "geo_model"
export type StatsQuerySource = { namespace: string; table: string; dataset: string }
export type RetentionQuery = { cohortDates: string[]; query: string }
type StatsQueryFamily = "usage" | "geo"

const DAY_MS = 86_400_000
const WEEK_MS = 7 * DAY_MS
// The typed production stream began before the legacy backfill's original end
// boundary. Use one exclusive handoff so the overlapping rows are never counted
// from both sources.
const LIVE_SOURCE_START = "2026-08-11T10:57:48.186Z"

// R2 SQL limits result sets to 10,000 rows and does not support OFFSET. Two
// queries per day/week keep each result bounded and avoid combining the costly
// distinct user/session aggregates with the high-cardinality geo dimensions.
export function buildStatsQueries(periodStart: Date, periodEnd: Date, input?: StatsQuerySource) {
  const source = input ?? {
    namespace: Resource.R2Sql.namespace,
    table: Resource.R2Sql.table,
    dataset: Resource.StatsSyncConfig.dataset,
  }
  return [...statPeriods("week", periodStart, periodEnd), ...statPeriods("day", periodStart, periodEnd)].flatMap(
    (period) => [buildStatsQuery(period, source, "usage"), buildStatsQuery(period, source, "geo")],
  )
}

export function buildRetentionQueries(periodStart: Date, periodEnd: Date, input?: StatsQuerySource): RetentionQuery[] {
  const source = input ?? {
    namespace: Resource.R2Sql.namespace,
    table: Resource.R2Sql.table,
    dataset: Resource.StatsSyncConfig.dataset,
  }
  const periods = retentionPeriods(periodStart, periodEnd)
  // Bound the user-level joins to one activity week and its return week.
  // Combining the entire display window makes full syncs much more expensive.
  return periods.map((period) => ({
    cohortDates: [period.start.toISOString().slice(0, 10)],
    query: buildRetentionQuery([period], source),
  }))
}

function buildRetentionQuery(
  periods: { start: Date; end: Date; returnStart: Date; returnEnd: Date }[],
  source: StatsQuerySource,
) {
  const first = periods[0]
  const last = periods.at(-1)!
  const scanStartValue = sqlString(first.start.toISOString())
  const scanEndValue = sqlString(last.returnEnd.toISOString())
  const ingestEndValue = sqlString(new Date(last.returnEnd.getTime() + DAY_MS).toISOString())
  const sourceTable = [source.namespace, source.table].map(sqlIdentifier).join(".")
  const activityWeeks = [
    ...new Map(
      periods.flatMap((period) => [period.start, period.returnStart]).map((date) => [date.toISOString(), date]),
    ).values(),
  ].toSorted((a, b) => a.getTime() - b.getTime())
  const activityWeekSql = `CASE
${activityWeeks
  .map(
    (date) =>
      `      WHEN started_at >= ${sqlString(date.toISOString())} AND started_at < ${sqlString(new Date(date.getTime() + WEEK_MS).toISOString())} THEN ${sqlString(date.toISOString().slice(0, 10))}`,
  )
  .join("\n")}
      ELSE null
    END`
  const cohortDates = periods.map((period) => sqlString(period.start.toISOString().slice(0, 10))).join(", ")
  const returnDates = periods.map((period) => sqlString(period.returnStart.toISOString().slice(0, 10))).join(", ")
  const returnCohortSql = `CASE activity_week
${periods
  .map(
    (period) =>
      `      WHEN ${sqlString(period.returnStart.toISOString().slice(0, 10))} THEN ${sqlString(period.start.toISOString().slice(0, 10))}`,
  )
  .join("\n")}
    END`

  return `
WITH normalized AS (
  SELECT
    ${activityWeekSql} AS activity_week,
    ${statModelSql("model_requested", "route_model")} AS model,
    COALESCE(NULLIF(route_model, ''), '') AS provider_model,
    COALESCE(NULLIF(provider_id, ''), '') AS raw_provider,
    COALESCE(NULLIF(user_id, ''), NULLIF(workspace_id, ''), NULLIF(service_api_key_id, '')) AS user_key
  FROM ${sourceTable}
  WHERE event_type = 'generation.completed'
    AND source IN ('inference', 'inference-legacy')
    AND (
      (source = 'inference-legacy' AND started_at < ${sqlString(LIVE_SOURCE_START)})
      OR (source = 'inference' AND started_at >= ${sqlString(LIVE_SOURCE_START)})
    )
    AND product = 'go'
    AND model_requested IS NOT NULL
    AND model_requested <> ''
    AND __ingest_ts >= ${scanStartValue}
    AND __ingest_ts < ${ingestEndValue}
    AND started_at >= ${scanStartValue}
    AND started_at < ${scanEndValue}
), filtered AS (
  SELECT
    activity_week,
    ${statProviderSql("model", "provider_model", "raw_provider")} AS provider,
    model,
    user_key
  FROM normalized
  WHERE activity_week IS NOT NULL
    AND user_key <> ''
    AND lower(model) NOT IN (${[...EXCLUDED_MODELS].map(sqlString).join(", ")})
), model_usage AS (
  SELECT
    activity_week AS cohort_date,
    user_key,
    provider,
    model,
    COUNT(*) AS model_requests
  FROM filtered
  WHERE activity_week IN (${cohortDates})
  GROUP BY activity_week, user_key, provider, model
), user_totals AS (
  SELECT
    cohort_date,
    user_key,
    SUM(model_requests) AS total_requests,
    MAX(model_requests) AS max_model_requests
  FROM model_usage
  GROUP BY cohort_date, user_key
), primary_models AS (
  SELECT model_usage.cohort_date, model_usage.user_key, model_usage.provider, model_usage.model
  FROM model_usage
  INNER JOIN user_totals ON model_usage.cohort_date = user_totals.cohort_date
    AND model_usage.user_key = user_totals.user_key
    AND model_usage.model_requests = user_totals.max_model_requests
  WHERE user_totals.total_requests >= 10
    AND CAST(model_usage.model_requests AS double) / NULLIF(user_totals.total_requests, 0) >= 0.8
), returned AS (
  SELECT
    ${returnCohortSql} AS cohort_date,
    user_key
  FROM filtered
  WHERE activity_week IN (${returnDates})
  GROUP BY ${returnCohortSql}, user_key
)
SELECT
  primary_models.cohort_date,
  ${sqlString(source.dataset)} AS dataset,
  'Go' AS tier,
  primary_models.provider,
  primary_models.model,
  COUNT(*) AS eligible_users,
  SUM(CASE WHEN returned.user_key IS NULL THEN 0 ELSE 1 END) AS retained_users
FROM primary_models
LEFT JOIN returned ON primary_models.user_key = returned.user_key
  AND primary_models.cohort_date = returned.cohort_date
GROUP BY primary_models.cohort_date, primary_models.provider, primary_models.model
LIMIT 10000
`
}

function buildStatsQuery(
  period: { grain: "day" | "week"; key: string; start: Date; end: Date },
  source: StatsQuerySource,
  family: StatsQueryFamily,
) {
  const periodStartValue = sqlString(period.start.toISOString())
  const periodEndValue = sqlString(period.end.toISOString())
  const ingestEndValue = sqlString(new Date(period.end.getTime() + DAY_MS).toISOString())
  const sourceTable = [source.namespace, source.table].map(sqlIdentifier).join(".")
  const sourceFreeTier = freeTierSql("model_tier", "model_requested")
  const dimensions =
    family === "usage"
      ? `CASE WHEN grouping(model) = 0 THEN 'model' ELSE 'provider' END AS dimension,
  tier,
  provider,
  CASE WHEN grouping(model) = 0 THEN model END AS model,
  CASE WHEN grouping(model) = 0 THEN COALESCE(MAX(NULLIF(provider_model, '')), '') END AS provider_model,
  null AS country,
  null AS continent`
      : `CASE WHEN grouping(model) = 0 THEN 'geo_model' ELSE 'geo' END AS dimension,
  tier,
  CASE WHEN grouping(model) = 0 THEN provider ELSE 'all' END AS provider,
  CASE WHEN grouping(model) = 0 THEN model ELSE 'all' END AS model,
  null AS provider_model,
  country,
  COALESCE(MAX(NULLIF(continent, '')), '') AS continent`
  const distinctColumns =
    family === "usage"
      ? `approx_distinct(session) AS sessions,
    approx_distinct(user_key) AS unique_users`
      : `0 AS sessions,
    0 AS unique_users`
  const groupingSets =
    family === "usage"
      ? `(tier, provider, model),
  (tier, provider)`
      : `(tier, country),
  (tier, provider, model, country)`
  const aggregateColumns = `
    ${distinctColumns},
    COUNT(*) AS requests,
    COALESCE(SUM(tokens_input), 0) AS input_tokens,
    COALESCE(SUM(tokens_output), 0) AS output_tokens,
    COALESCE(SUM(tokens_reasoning), 0) AS reasoning_tokens,
    COALESCE(SUM(tokens_cache_read), 0) AS cache_read_tokens,
    COALESCE(SUM(tokens_total), 0) AS total_tokens,
    COALESCE(SUM(cost_input_microcents), 0) AS input_cost_microcents,
    COALESCE(SUM(cost_output_microcents), 0) AS output_cost_microcents,
    COALESCE(SUM(cost_total_microcents), 0) AS total_cost_microcents,
    AVG(duration_ms) AS avg_duration_ms,
    null AS p50_duration_ms,
    null AS p95_duration_ms,
    AVG(ttfb_ms) AS avg_ttfb_ms,
    null AS p50_ttfb_ms,
    null AS p95_ttfb_ms,
    AVG(output_tps) AS avg_output_tps,
    SUM(CASE WHEN outcome = 'succeeded' THEN 1 ELSE 0 END) AS success_count,
    SUM(CASE WHEN outcome = 'failed' THEN 1 ELSE 0 END) AS error_count,
    COUNT(*) AS sample_count`

  return `
WITH normalized AS (
  SELECT
    model_requested AS raw_model,
    COALESCE(NULLIF(lower(model_tier), ''), '') AS raw_tier,
    ${statModelSql("model_requested", "route_model")} AS model,
    COALESCE(NULLIF(route_model, ''), '') AS provider_model,
    COALESCE(NULLIF(provider_id, ''), '') AS raw_provider,
    UPPER(COALESCE(NULLIF(country, ''), 'ZZ')) AS country,
    COALESCE(NULLIF(continent, ''), '') AS continent,
    session_id AS session,
    COALESCE(NULLIF(workspace_id, ''), '') AS workspace,
    COALESCE(NULLIF(service_api_key_id, ''), '') AS api_key,
    COALESCE(NULLIF(user_id, ''), '') AS user_id,
    outcome,
    duration_ms,
    time_to_first_token_ms AS ttfb_ms,
    CASE
      WHEN first_token_at IS NULL OR last_token_at IS NULL THEN null
      ELSE date_part('epoch', last_token_at) - date_part('epoch', first_token_at)
    END AS output_seconds,
    tokens_input,
    tokens_output,
    tokens_reasoning,
    tokens_cache_read,
    tokens_cache_write,
    cost_input AS cost_input_microcents,
    cost_output AS cost_output_microcents,
    cost_total AS cost_total_microcents
  FROM ${sourceTable}
  WHERE event_type = 'generation.completed'
    AND source IN ('inference', 'inference-legacy')
    AND (
      (source = 'inference-legacy' AND started_at < ${sqlString(LIVE_SOURCE_START)})
      OR (source = 'inference' AND started_at >= ${sqlString(LIVE_SOURCE_START)})
    )
    AND (product = 'go' OR (${sourceFreeTier}))
    AND model_requested IS NOT NULL
    AND model_requested <> ''
    AND __ingest_ts >= ${periodStartValue}
    AND __ingest_ts < ${ingestEndValue}
    AND started_at >= ${periodStartValue}
    AND started_at < ${periodEndValue}
), filtered AS (
  SELECT
    CASE
      WHEN ${freeTierSql("raw_tier", "raw_model")}
      THEN 'Free'
      ELSE 'Go'
    END AS tier,
    ${statProviderSql("model", "provider_model", "raw_provider")} AS provider,
    provider_model,
    model,
    country,
    continent,
    session,
    COALESCE(NULLIF(user_id, ''), NULLIF(workspace, ''), NULLIF(api_key, '')) AS user_key,
    outcome,
    duration_ms,
    ttfb_ms,
    CASE
      WHEN output_seconds < 0.1 THEN null
      ELSE CAST(tokens_output AS double) / output_seconds
    END AS output_tps,
    tokens_input,
    tokens_output,
    tokens_reasoning,
    tokens_cache_read,
    COALESCE(tokens_cache_read, 0) + COALESCE(tokens_cache_write, 0) + COALESCE(tokens_input, 0) + COALESCE(tokens_output, 0) AS tokens_total,
    cost_input_microcents,
    cost_output_microcents,
    cost_total_microcents
  FROM normalized
  WHERE lower(model) NOT IN (${[...EXCLUDED_MODELS].map(sqlString).join(", ")})
)
SELECT
  ${sqlString(period.grain)} AS grain,
  ${sqlString(period.key)} AS period_key,
  ${sqlString(source.dataset)} AS dataset,
  ${dimensions},
  ${aggregateColumns}
FROM filtered
GROUP BY GROUPING SETS (
  ${groupingSets}
)
LIMIT 10000
`
}

export function toModelAggregate(data: R2SqlData): ModelStatAggregate[] {
  const model = statModel(data.model, data.provider_model)
  const provider = statProvider(model, data.provider_model, data.provider)
  if (!provider) return []

  return toStatBaseAggregate(data).flatMap((base) => [
    { ...base, provider, model, provider_model: data.provider_model || "" },
  ])
}

export function toProviderAggregate(data: R2SqlData): ProviderStatAggregate[] {
  return toStatBaseAggregate(data).flatMap((base) => [
    { ...base, provider: statProvider(data.model, data.provider_model, data.provider) || "unknown" },
  ])
}

export function toGeoAggregate(data: R2SqlData): GeoStatAggregate[] {
  return toStatBaseAggregate(data).flatMap((base) => [
    {
      ...base,
      provider: statProvider(data.model, data.provider_model, data.provider) || "all",
      model: statModel(data.model || "all", data.provider_model),
      country: normalizeCountry(data.country),
      continent: data.continent || "",
    },
  ])
}

export function toRetentionAggregate(data: R2SqlData): RetentionStatAggregate[] {
  if (!data.cohort_date || !data.model) return []
  return [
    {
      cohortDate: data.cohort_date,
      dataset: data.dataset || Resource.StatsSyncConfig.dataset,
      tier: data.tier || "all",
      provider: statProvider(data.model, "", data.provider) || "unknown",
      model: statModel(data.model, undefined),
      eligibleUsers: integer(data, "eligible_users"),
      retainedUsers: integer(data, "retained_users"),
    },
  ]
}

function toStatBaseAggregate(data: R2SqlData): StatBaseAggregate[] {
  const grain = data.grain === "day" || data.grain === "week" ? data.grain : undefined
  if (!grain || !data.period_key) return []

  return [
    {
      grain,
      period_key: data.period_key,
      dataset: data.dataset || Resource.StatsSyncConfig.dataset,
      tier: normalizeTier(data.tier || "unknown"),
      sessions: integer(data, "sessions"),
      requests: integer(data, "requests"),
      unique_users: integer(data, "unique_users"),
      input_tokens: integer(data, "input_tokens"),
      output_tokens: integer(data, "output_tokens"),
      reasoning_tokens: integer(data, "reasoning_tokens"),
      cache_read_tokens: integer(data, "cache_read_tokens"),
      total_tokens: integer(data, "total_tokens"),
      input_cost_microcents: integer(data, "input_cost_microcents"),
      output_cost_microcents: integer(data, "output_cost_microcents"),
      total_cost_microcents: integer(data, "total_cost_microcents"),
      avg_duration_ms: nullableNumber(data, "avg_duration_ms"),
      p50_duration_ms: nullableInteger(data, "p50_duration_ms"),
      p95_duration_ms: nullableInteger(data, "p95_duration_ms"),
      avg_ttfb_ms: nullableNumber(data, "avg_ttfb_ms"),
      p50_ttfb_ms: nullableInteger(data, "p50_ttfb_ms"),
      p95_ttfb_ms: nullableInteger(data, "p95_ttfb_ms"),
      avg_output_tps: nullableNumber(data, "avg_output_tps"),
      success_count: integer(data, "success_count"),
      error_count: integer(data, "error_count"),
      sample_count: integer(data, "sample_count"),
    },
  ]
}

function integer(data: R2SqlData, key: string) {
  return Math.round(number(data, key))
}

function nullableNumber(data: R2SqlData, key: string) {
  if (data[key] === undefined || data[key] === "") return null
  return Number(number(data, key).toFixed(2))
}

function nullableInteger(data: R2SqlData, key: string) {
  if (data[key] === undefined || data[key] === "") return null
  return Math.round(number(data, key))
}

function number(data: R2SqlData, key: string) {
  const value = Number(data[key])
  return Number.isFinite(value) ? value : 0
}

function sqlIdentifier(value: string) {
  return `"${value.replace(/"/g, '""')}"`
}

function sqlString(value: string) {
  return `'${value.replace(/'/g, "''")}'`
}

function statPeriods(grain: "day" | "week", periodStart: Date, periodEnd: Date) {
  const interval = grain === "day" ? DAY_MS : WEEK_MS
  const first = grain === "day" ? startOfUtcDay(periodStart) : startOfIsoWeek(periodStart)
  const count = Math.max(0, Math.ceil((periodEnd.getTime() - first.getTime()) / interval))
  return Array.from({ length: count }, (_, index) => {
    const start = new Date(first.getTime() + index * interval)
    return {
      grain,
      key: periodKeyFor(grain, start),
      start,
      end: new Date(Math.min(start.getTime() + interval, periodEnd.getTime())),
    }
  })
}

function retentionPeriods(periodStart: Date, periodEnd: Date) {
  const first = startOfIsoWeek(periodStart)
  const completeEnd = startOfIsoWeek(periodEnd)
  const count = Math.max(0, Math.floor((completeEnd.getTime() - first.getTime()) / WEEK_MS) - 1)
  return Array.from({ length: count }, (_, index) => {
    const start = new Date(first.getTime() + index * WEEK_MS)
    const end = new Date(start.getTime() + WEEK_MS)
    return { start, end, returnStart: end, returnEnd: new Date(end.getTime() + WEEK_MS) }
  })
}

function statModelSql(model: string, providerModel: string) {
  const normalized = `regexp_replace(CASE
      WHEN lower(${model}) = 'big-pickle' THEN regexp_replace(NULLIF(${providerModel}, ''), '^.*/', '')
      ELSE ${model}
    END, '(-free|:free|:global)+$', '')`
  return `COALESCE(NULLIF(CASE
${Object.entries(MODEL_NAME_ALIASES)
  .map(([from, to]) => `      WHEN lower(${normalized}) = ${sqlString(from)} THEN ${sqlString(to)}`)
  .join("\n")}
      ELSE ${normalized}
    END, ''), 'unknown')`
}

function freeTierSql(tier: string, model: string) {
  return `lower(COALESCE(${tier}, '')) = 'free'
        OR lower(${model}) IN (${[...FREE_MODELS].map(sqlString).join(", ")})
        OR lower(${model}) LIKE '%-free'
        OR lower(${model}) LIKE '%-free:global'`
}

function statProviderSql(model: string, providerModel: string, provider: string) {
  return `CASE
      WHEN lower(${model}) IN (${[...STEALTH_MODELS].map(sqlString).join(", ")}) THEN 'unknown'
${MODEL_AUTHOR_RULES.map((item) => `      WHEN strpos(lower(${providerModel}), ${sqlString(item.match)}) > 0 THEN ${sqlString(item.author)}`).join("\n")}
${MODEL_AUTHOR_RULES.map((item) => `      WHEN strpos(lower(${model}), ${sqlString(item.match)}) > 0 THEN ${sqlString(item.author)}`).join("\n")}
      WHEN ${provider} <> '' AND lower(${provider}) NOT IN (${RETIRED_STAT_PROVIDERS.map(sqlString).join(", ")}) THEN ${provider}
      ELSE 'unknown'
    END`
}
