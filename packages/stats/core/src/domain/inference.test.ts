import { describe, expect, test } from "bun:test"
import {
  buildRetentionQueries,
  buildStatsQueries,
  toGeoAggregate,
  toModelAggregate,
  toProviderAggregate,
  toRetentionAggregate,
} from "./inference"
import {
  modelAuthor,
  normalizeInferenceModel,
  RETIRED_STAT_MODELS,
  statModel,
  statProvider,
} from "./model-normalization"

describe("inference stat normalization", () => {
  test("normalizes model suffixes used by router/provider variants", () => {
    expect(normalizeInferenceModel("GPT-5-Free")).toBe("gpt-5")
    expect(normalizeInferenceModel("deepseek-v4-flash-free")).toBe("deepseek-v4-flash")
    expect(normalizeInferenceModel("deepseek-v4-flash:global")).toBe("deepseek-v4-flash")
    expect(normalizeInferenceModel("mimo-v2.5-free")).toBe("mimo-v2.5")
    expect(normalizeInferenceModel("nemotron-3-super-free")).toBe("nemotron-3-super")
    expect(normalizeInferenceModel("mimo-v2.5-free:global")).toBe("mimo-v2.5")
    expect(normalizeInferenceModel("hy3-preview:free")).toBe("hy3-preview")
  })

  test("maps normalized model ids to public authors", () => {
    expect(modelAuthor("big-pickle")).toBe("unknown")
    expect(modelAuthor("claude-sonnet-4-5")).toBe("anthropic")
    expect(modelAuthor("deepseek-v4-pro")).toBe("deepseek")
    expect(modelAuthor("gemini-3.5-flash")).toBe("google")
    expect(modelAuthor("glm-5.1")).toBe("zhipu")
    expect(modelAuthor("gpt-5.5-pro")).toBe("openai")
    expect(modelAuthor("grok-build-0.1")).toBe("xai")
    expect(modelAuthor("hy3-preview")).toBe("tencent")
    expect(modelAuthor("kimi-k2.6")).toBe("moonshot")
    expect(modelAuthor("mimo-v2-omni")).toBe("xiaomi")
    expect(modelAuthor("minimax-m2.7")).toBe("minimax")
    expect(modelAuthor("muse-spark-1.2-contributor")).toBe("meta")
    expect(modelAuthor("nemotron-3-super-free")).toBe("nvidia")
    expect(modelAuthor("qwen3.7-max")).toBe("qwen")
    expect(modelAuthor("alpha-gpt-next")).toBeUndefined()
    expect(modelAuthor("omen-alpha")).toBe("unknown")
    expect(modelAuthor("OMEN-ALPHA-free:global")).toBe("unknown")
  })

  test("uses provider.model to resolve opencode route providers", () => {
    expect(statModel("big-pickle", "claude-sonnet-4-5")).toBe("claude-sonnet-4-5")
    expect(statModel("big-pickle", "gpt-5-free")).toBe("gpt-5")
    expect(statModel("big-pickle", "xiaomi/mimo-v2.5")).toBe("mimo-v2.5")
    expect(statModel("big-pickle", "")).toBe("unknown")
    expect(statProvider("big-pickle", "claude-sonnet-4-5", "opencode")).toBe("anthropic")
    expect(statProvider("big-pickle", "gpt-5", "opencode")).toBe("openai")
    expect(statProvider("big-pickle", "", "opencode")).toBe("unknown")
    expect(statProvider("unknown", "", "custom-provider")).toBe("custom-provider")
  })

  test("keeps stealth model usage without exposing the route provider", () => {
    expect(statProvider("omen-alpha", "gpt-test-model", "test-provider")).toBe("unknown")
    expect(statProvider("OMEN-ALPHA-free:global", "gpt-test-model", "test-provider")).toBe("unknown")
    expect(statProvider("omen-alpha", "", "test-provider")).toBe("unknown")

    const row = { ...aggregate("omen-alpha", "test-provider"), provider_model: "gpt-test-model" }
    expect(toModelAggregate(row)).toMatchObject([{ model: "omen-alpha", provider: "unknown", requests: 1 }])
    expect(toProviderAggregate(row)).toMatchObject([{ provider: "unknown", requests: 1 }])
    expect(toGeoAggregate({ ...row, country: "US" })).toMatchObject([
      { model: "omen-alpha", provider: "unknown", country: "US", requests: 1 },
    ])
    expect(toRetentionAggregate({ ...row, cohort_date: "2026-08-10", eligible_users: "12" })).toMatchObject([
      { model: "omen-alpha", provider: "unknown", eligibleUsers: 12 },
    ])
  })

  test("merges renamed models under their current name", () => {
    expect(statModel("deepseek-v4-flash-0731", "")).toBe("deepseek-v4-flash")
    expect(statModel("deepseek-v4-flash-0731-free", "")).toBe("deepseek-v4-flash")
    expect(statModel("deepseek-v4-flash-dsv4-flash-final-rnaovd", "")).toBe("deepseek-v4-flash")
    expect(statModel("deepseek-v4-flash-vision-exp", "")).toBe("deepseek-v4-flash-vision-exp")
    expect(statModel("x-preview-f", "")).toBe("glm-5.3-flash")
    expect(statModel("ox-alpha", "")).toBe("glm-5.3-flash")
    expect(statModel("ox-alpha-free", "")).toBe("glm-5.3-flash")
    expect(statModel("big-pickle", "zhipuai/ox-alpha-free")).toBe("glm-5.3-flash")
    expect(statModel("xiaomi/mimo-v2.5", "")).toBe("mimo-v2.5")
    expect(toModelAggregate(aggregate("x-preview-f", "unknown"))).toMatchObject([
      {
        provider: "zhipu",
        model: "glm-5.3-flash",
      },
    ])
    expect(toProviderAggregate(aggregate("ox-alpha", "unknown"))).toMatchObject([{ provider: "zhipu" }])
  })

  test("renames DeepSeek Flash to V4.1 without merging V4 or vision usage", () => {
    ;["deepseek-flash", "DEEPSEEK-FLASH-free:global", "deepseek-v4.1-flash"].forEach((model) => {
      expect(statModel(model, "")).toBe("deepseek-v4.1-flash")
      expect(toModelAggregate(aggregate(model, "deepseek"))).toMatchObject([
        { model: "deepseek-v4.1-flash", provider: "deepseek" },
      ])
      expect(toGeoAggregate({ ...aggregate(model, "deepseek"), country: "US" })).toMatchObject([
        { model: "deepseek-v4.1-flash", provider: "deepseek", country: "US" },
      ])
      expect(toRetentionAggregate({ ...aggregate(model, "deepseek"), cohort_date: "2026-08-10" })).toMatchObject([
        { model: "deepseek-v4.1-flash", provider: "deepseek" },
      ])
    })
    expect(statModel("big-pickle", "deepseek/deepseek-flash")).toBe("deepseek-v4.1-flash")
    expect(statModel("deepseek-v4-flash", "")).toBe("deepseek-v4-flash")
    expect(statModel("deepseek-v4-flash-vision-exp", "")).toBe("deepseek-v4-flash-vision-exp")
    expect(RETIRED_STAT_MODELS).toContain("deepseek-flash")
    expect(RETIRED_STAT_MODELS).not.toContain("deepseek-v4.1-flash")
  })

  test("model aggregates prefer provider.model and use normalized model", () => {
    expect(toModelAggregate(aggregate("alpha-gpt-next", "openai"))).toEqual([])

    expect(toModelAggregate(aggregate("deepseek-v4-flash-free", "not-public-provider"))).toMatchObject([
      {
        period_key: "2026-05-20",
        provider: "deepseek",
        model: "deepseek-v4-flash",
      },
    ])

    expect(
      toModelAggregate({ ...aggregate("big-pickle", "opencode"), provider_model: "claude-sonnet-4-5" }),
    ).toMatchObject([
      {
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        provider_model: "claude-sonnet-4-5",
      },
    ])
  })

  test("provider aggregates never keep opencode as the provider", () => {
    expect(toProviderAggregate({ ...aggregate("big-pickle", "opencode"), provider_model: "gpt-5" })).toMatchObject([
      { provider: "openai" },
    ])
    expect(toProviderAggregate(aggregate("big-pickle", "opencode"))).toMatchObject([{ provider: "unknown" }])
    expect(toProviderAggregate(aggregate("muse-spark-1.2-contributor", "unknown"))).toMatchObject([
      { provider: "meta" },
    ])
  })

  test("geo aggregates never keep opencode or big-pickle dimensions", () => {
    expect(toGeoAggregate({ ...aggregate("big-pickle", "opencode"), country: "US" })).toMatchObject([
      { provider: "unknown", model: "unknown", country: "US" },
    ])
  })

  test("model aggregates use ISO week period keys", () => {
    expect(
      toModelAggregate({
        ...aggregate("gpt-5.5-pro", "openai"),
        grain: "week",
        period_key: "2026-W20",
      }),
    ).toMatchObject([{ period_key: "2026-W20" }])
  })

  test("builds bounded R2 SQL queries for each day and week", () => {
    const queries = buildStatsQueries(new Date("2026-08-10T00:00:00.000Z"), new Date("2026-08-12T12:00:00.000Z"), {
      namespace: "inference",
      table: "generation",
      dataset: "zen",
    })

    expect(queries).toHaveLength(8)
    queries.forEach((query) => {
      expect(query).toContain("WHERE lower(model) NOT IN ('alpha-gpt-next')")
      expect(query).toContain("CASE\n      WHEN lower(model) IN ('omen-alpha') THEN 'unknown'\n")
      expect(query).toContain("= 'deepseek-flash' THEN 'deepseek-v4.1-flash'")
    })
    expect(queries[0]).toContain("'week' AS grain")
    expect(queries[0]).toContain("'2026-W33' AS period_key")
    expect(queries[2]).toContain("'2026-08-10' AS period_key")
    expect(queries[6]).toContain("'2026-08-12' AS period_key")
    expect(queries[0]).toContain('FROM "inference"."generation"')
    expect(queries[0]).toContain("event_type = 'generation.completed'")
    expect(queries[0]).toContain("AND (product = 'go' OR (lower(COALESCE(model_tier, '')) = 'free'")
    expect(queries[0]).toContain("COALESCE(NULLIF(lower(model_tier), ''), '') AS raw_tier")
    expect(queries[0]).toContain("WHEN lower(COALESCE(raw_tier, '')) = 'free'")
    expect(queries[0]).toContain("regexp_replace(NULLIF(route_model, ''), '^.*/', '')")
    expect(queries[0]).toContain("= 'deepseek-v4-flash-0731' THEN 'deepseek-v4-flash'")
    expect(queries[0]).toContain("= 'deepseek-v4-flash-dsv4-flash-final-rnaovd' THEN 'deepseek-v4-flash'")
    expect(queries[0]).not.toContain("= 'deepseek-v4-flash-vision-exp' THEN 'deepseek-v4-flash'")
    expect(queries[0]).toContain("= 'ox-alpha' THEN 'glm-5.3-flash'")
    expect(queries[0]).toContain("= 'x-preview-f' THEN 'glm-5.3-flash'")
    expect(queries[0]).toContain("OR lower(raw_model) IN ('gpt-5-nano', 'grok-code', 'big-pickle')")
    expect(queries[0]).toContain("OR lower(raw_model) LIKE '%-free'")
    expect(queries[0]).toContain("THEN 'Free'")
    expect(queries[0]).toContain("LIMIT 10000")
    expect(queries[0]).toContain("approx_distinct(session) AS sessions")
    expect(queries[1]).toContain("'geo_model' ELSE 'geo'")
    expect(queries[1]).toContain("0 AS sessions")
  })

  test("aligns periods to UTC calendar boundaries", () => {
    const queries = buildStatsQueries(new Date("2026-06-17T15:56:00.000Z"), new Date("2026-06-19T15:56:00.000Z"), {
      namespace: "inference",
      table: "generation",
      dataset: "zen",
    })

    expect(queries).toHaveLength(8)
    expect(queries[0]).toContain("'2026-W25' AS period_key")
    expect(queries[0]).toContain("started_at >= '2026-06-15T00:00:00.000Z'")
    expect(queries[2]).toContain("'2026-06-17' AS period_key")
    expect(queries[2]).toContain("started_at >= '2026-06-17T00:00:00.000Z'")
    expect(queries[2]).toContain("started_at < '2026-06-18T00:00:00.000Z'")
    expect(queries[6]).toContain("'2026-06-19' AS period_key")
    expect(queries[6]).toContain("started_at < '2026-06-19T15:56:00.000Z'")
  })

  test("uses an exclusive live and legacy source handoff", () => {
    const [query] = buildStatsQueries(new Date("2026-08-11T00:00:00.000Z"), new Date("2026-08-12T00:00:00.000Z"), {
      namespace: "inference",
      table: "generation",
      dataset: "zen",
    })

    expect(query).toContain("(source = 'inference-legacy' AND started_at < '2026-08-11T10:57:48.186Z')")
    expect(query).toContain("(source = 'inference' AND started_at >= '2026-08-11T10:57:48.186Z')")
  })

  test("builds complete week-over-week retention queries", () => {
    const queries = buildRetentionQueries(new Date("2026-08-10T00:00:00.000Z"), new Date("2026-08-31T00:00:00.000Z"), {
      namespace: "inference",
      table: "generation",
      dataset: "zen",
    })

    expect(queries).toHaveLength(2)
    queries.forEach(({ query }) => {
      expect(query).toContain("= 'deepseek-flash' THEN 'deepseek-v4.1-flash'")
    })
    expect(queries.map((query) => query.cohortDates)).toEqual([["2026-08-10"], ["2026-08-17"]])
    expect(queries[0]?.query).toContain("AND product = 'go'")
    expect(queries[0]?.query).toContain("AND lower(model) NOT IN ('alpha-gpt-next')")
    expect(queries[0]?.query).toContain("CASE\n      WHEN lower(model) IN ('omen-alpha') THEN 'unknown'\n")
    expect(queries[0]?.query).toContain("COUNT(*) AS model_requests")
    expect(queries[0]?.query).toContain("SUM(model_requests) AS total_requests")
    expect(queries[0]?.query).toContain("MAX(model_requests) AS max_model_requests")
    expect(queries[0]?.query).toContain("GROUP BY cohort_date, user_key")
    expect(queries[0]?.query).toContain("INNER JOIN user_totals")
    expect(queries[0]?.query).toContain("model_usage.model_requests = user_totals.max_model_requests")
    expect(queries[0]?.query).toContain("user_totals.total_requests >= 10")
    expect(queries[0]?.query).toContain(
      "CAST(model_usage.model_requests AS double) / NULLIF(user_totals.total_requests, 0) >= 0.8",
    )
    expect(queries[0]?.query).not.toContain(" OVER (")
    expect(queries[0]?.query).toContain("WHEN '2026-08-17' THEN '2026-08-10'")
    expect(queries[0]?.query).not.toContain("WHEN '2026-08-24' THEN '2026-08-17'")
    expect(queries[1]?.query).toContain("WHEN '2026-08-24' THEN '2026-08-17'")
    expect(queries[0]?.query).toContain("started_at >= '2026-08-10T00:00:00.000Z'")
    expect(queries[0]?.query).toContain("started_at < '2026-08-24T00:00:00.000Z'")
    expect(queries[1]?.query).toContain("started_at >= '2026-08-17T00:00:00.000Z'")
    expect(queries[1]?.query).toContain("started_at < '2026-08-31T00:00:00.000Z'")
    expect(queries[0]?.query).toContain("LEFT JOIN returned ON primary_models.user_key = returned.user_key")
    expect(queries[0]?.query).toContain("primary_models.cohort_date = returned.cohort_date")
    expect(queries[0]?.query).toContain("'Go' AS tier")
    expect(queries[0]?.query).toContain("COUNT(*) AS eligible_users")
    expect(queries[0]?.query).toContain("LIMIT 10000")
  })

  test("splits a full retention window without dropping or duplicating cohorts", () => {
    const source = { namespace: "inference", table: "generation", dataset: "zen" }
    const queries = buildRetentionQueries(new Date("2026-07-16T19:00:00Z"), new Date("2026-09-10T00:00:00Z"), source)

    expect(queries.flatMap((query) => query.cohortDates)).toEqual([
      "2026-07-13",
      "2026-07-20",
      "2026-07-27",
      "2026-08-03",
      "2026-08-10",
      "2026-08-17",
      "2026-08-24",
    ])
    queries.forEach((query) => {
      const start = new Date(`${query.cohortDates[0]}T00:00:00Z`)
      const end = new Date(start.getTime() + 14 * 86_400_000)
      expect(query).toEqual(buildRetentionQueries(start, end, source)[0])
    })
    expect(buildRetentionQueries(new Date("2026-08-31T00:00:00Z"), new Date("2026-09-10T00:00:00Z"), source)).toEqual(
      [],
    )
  })

  test("maps retention query results", () => {
    expect(
      toRetentionAggregate({
        cohort_date: "2026-08-10",
        dataset: "zen",
        tier: "all",
        provider: "deepseek",
        model: "deepseek-v4-flash-free",
        eligible_users: "125",
        retained_users: "74",
      }),
    ).toEqual([
      {
        cohortDate: "2026-08-10",
        dataset: "zen",
        tier: "all",
        provider: "deepseek",
        model: "deepseek-v4-flash",
        eligibleUsers: 125,
        retainedUsers: 74,
      },
    ])
  })
})

function aggregate(model: string, provider: string) {
  return {
    grain: "day",
    period_key: "2026-05-20",
    dataset: "zen",
    tier: "Paid",
    provider,
    model,
    sessions: "1",
    requests: "1",
    sample_count: "1",
  }
}
