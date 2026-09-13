import { bigint, char, datetime, decimal, index, int, mysqlTable, uniqueIndex, varchar } from "drizzle-orm/mysql-core"

export const modelStat = mysqlTable(
  "model_stat",
  {
    ...periodColumns(),
    provider: varchar({ length: 128 }).notNull(),
    model: varchar({ length: 256 }).notNull(),
    provider_model: varchar({ length: 256 }).notNull().default(""),
    ...metricColumns(),
    rank_by_tokens: int(),
    rank_by_requests: int(),
    rank_by_cost: int(),
    ...timestampColumns(),
  },
  (table) => [
    uniqueIndex("uniq_model_period").on(
      table.grain,
      table.period_key,
      table.dataset,
      table.tier,
      table.client,
      table.source,
      table.provider,
      table.model,
    ),
    index("idx_leaderboard_tokens").on(table.grain, table.period_key, table.dataset, table.tier, table.total_tokens),
    index("idx_model").on(table.model, table.grain, table.period_key),
  ],
)

export const providerStat = mysqlTable(
  "provider_stat",
  {
    ...periodColumns(),
    provider: varchar({ length: 128 }).notNull(),
    ...metricColumns(),
    ...marketShareColumns(),
    rank_by_tokens: int(),
    rank_by_requests: int(),
    rank_by_sessions: int(),
    rank_by_cost: int(),
    ...timestampColumns(),
  },
  (table) => [
    uniqueIndex("uniq_provider_period").on(
      table.grain,
      table.period_key,
      table.dataset,
      table.tier,
      table.client,
      table.source,
      table.provider,
    ),
    index("idx_provider_leaderboard_tokens").on(
      table.grain,
      table.period_key,
      table.dataset,
      table.tier,
      table.total_tokens,
    ),
    index("idx_provider_market_share").on(
      table.grain,
      table.period_key,
      table.dataset,
      table.tier,
      table.market_share_tokens,
    ),
    index("idx_provider_rank").on(table.grain, table.period_key, table.dataset, table.tier, table.rank_by_tokens),
    index("idx_provider").on(table.provider, table.grain, table.period_key),
  ],
)

export const geoStat = mysqlTable(
  "geo_stat",
  {
    ...periodColumns(),
    provider: varchar({ length: 128 }).notNull().default("all"),
    model: varchar({ length: 256 }).notNull().default("all"),
    country: char({ length: 2 }).notNull(),
    continent: varchar({ length: 8 }).notNull().default(""),
    ...metricColumns(),
    ...marketShareColumns(),
    rank_by_tokens: int(),
    rank_by_requests: int(),
    rank_by_sessions: int(),
    rank_by_cost: int(),
    ...timestampColumns(),
  },
  (table) => [
    uniqueIndex("uniq_country_period").on(
      table.grain,
      table.period_key,
      table.dataset,
      table.tier,
      table.client,
      table.source,
      table.provider,
      table.model,
      table.country,
    ),
    index("idx_country_map_tokens").on(table.grain, table.period_key, table.dataset, table.tier, table.total_tokens),
    index("idx_country_rank").on(table.grain, table.period_key, table.dataset, table.tier, table.rank_by_tokens),
    index("idx_country").on(table.country, table.grain, table.period_key),
    index("idx_continent").on(table.continent, table.grain, table.period_key),
    index("idx_country_model").on(table.model, table.country, table.grain, table.period_key),
    index("idx_country_model_range").on(
      table.model,
      table.provider,
      table.grain,
      table.dataset,
      table.client,
      table.source,
      table.tier,
      table.period_key,
    ),
  ],
)

export const modelRetention = mysqlTable(
  "model_retention",
  {
    id: bigint({ mode: "number" }).autoincrement().primaryKey(),
    cohort_date: char({ length: 10 }).notNull(),
    dataset: varchar({ length: 64 }).notNull().default("all"),
    tier: varchar({ length: 64 }).notNull().default("all"),
    provider: varchar({ length: 128 }).notNull(),
    model: varchar({ length: 256 }).notNull(),
    eligible_users: bigint({ mode: "number" }).notNull().default(0),
    retained_users: bigint({ mode: "number" }).notNull().default(0),
    ...timestampColumns(),
  },
  (table) => [
    uniqueIndex("uniq_model_retention_cohort").on(
      table.cohort_date,
      table.dataset,
      table.tier,
      table.provider,
      table.model,
    ),
    index("idx_model_retention_recent").on(table.dataset, table.tier, table.cohort_date),
    index("idx_model_retention_model").on(table.model, table.cohort_date),
  ],
)

function periodColumns() {
  return {
    id: bigint({ mode: "number" }).autoincrement().primaryKey(),
    grain: varchar({ length: 16 }).notNull(),
    period_key: varchar({ length: 32 }).notNull(),
    dataset: varchar({ length: 64 }).notNull().default("all"),
    tier: varchar({ length: 64 }).notNull().default("all"),
    client: varchar({ length: 64 }).notNull().default("all"),
    source: varchar({ length: 64 }).notNull().default("all"),
  }
}

function metricColumns() {
  return {
    sessions: bigint({ mode: "number" }).notNull().default(0),
    requests: bigint({ mode: "number" }).notNull().default(0),
    unique_users: bigint({ mode: "number" }).notNull().default(0),
    input_tokens: bigint({ mode: "number" }).notNull().default(0),
    output_tokens: bigint({ mode: "number" }).notNull().default(0),
    reasoning_tokens: bigint({ mode: "number" }).notNull().default(0),
    cache_read_tokens: bigint({ mode: "number" }).notNull().default(0),
    total_tokens: bigint({ mode: "number" }).notNull().default(0),
    input_cost_microcents: bigint({ mode: "number" }).notNull().default(0),
    output_cost_microcents: bigint({ mode: "number" }).notNull().default(0),
    total_cost_microcents: bigint({ mode: "number" }).notNull().default(0),
    avg_duration_ms: decimal({ precision: 12, scale: 2, mode: "number" }),
    p50_duration_ms: int(),
    p95_duration_ms: int(),
    avg_ttfb_ms: decimal({ precision: 12, scale: 2, mode: "number" }),
    p50_ttfb_ms: int(),
    p95_ttfb_ms: int(),
    avg_output_tps: decimal({ precision: 12, scale: 4, mode: "number" }),
    success_count: bigint({ mode: "number" }).notNull().default(0),
    error_count: bigint({ mode: "number" }).notNull().default(0),
    sample_count: bigint({ mode: "number" }).notNull().default(0),
  }
}

function marketShareColumns() {
  return {
    market_share_tokens: decimal({ precision: 10, scale: 6, mode: "number" }),
    market_share_requests: decimal({ precision: 10, scale: 6, mode: "number" }),
    market_share_sessions: decimal({ precision: 10, scale: 6, mode: "number" }),
  }
}

function timestampColumns() {
  return {
    created_at: datetime({ mode: "date" }).notNull().defaultNow(),
    updated_at: datetime({ mode: "date" }).notNull().defaultNow().onUpdateNow(),
  }
}
