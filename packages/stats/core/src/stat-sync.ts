import { DateTime, Effect } from "effect"
import { Resource } from "sst/resource"
import { DatabaseError } from "./database"
import { GeoStatRepo, rowsFromAggregates as geoRowsFromAggregates } from "./domain/geo"
import {
  buildRetentionQueries,
  buildStatsQueries,
  toGeoAggregate,
  toModelAggregate,
  toProviderAggregate,
  toRetentionAggregate,
} from "./domain/inference"
import { ModelStatRepo, rowsFromAggregates as modelRowsFromAggregates } from "./domain/model"
import { ProviderStatRepo, rowsFromAggregates as providerRowsFromAggregates } from "./domain/provider"
import { RetentionStatRepo, rowsFromAggregates as retentionRowsFromAggregates } from "./domain/retention"
import { startOfIsoWeek, startOfUtcDay } from "./domain/stat"
import { R2Sql, R2SqlQueryError } from "./r2-sql"

const DATALAKE_INGESTION_LAG_MS = 5 * 60_000
const STATS_DATA_START_MS = new Date("2026-05-28T00:00:00.000Z").getTime()
const WEEK_MS = 7 * 86_400_000
const DISPLAY_WINDOW_MS = 56 * 86_400_000
// A retention result needs one complete activity week plus its complete return
// week. Keep another partial week of slack around the ISO-week boundary.
const RETENTION_INCREMENTAL_LOOKBACK_MS = 16 * 86_400_000
// Anchor incremental passes to the ISO week containing this lookback, so the pass
// after a week boundary still recomputes the previous week's final aggregates even
// if the boundary pass itself failed.
const INCREMENTAL_LOOKBACK_MS = 2 * 3_600_000

export type SyncStatsResult = { ok: true; rows: number; startedAt: string; periodStart: string; periodEnd: string }
export type SyncStatsError = R2SqlQueryError | DatabaseError
type SyncStatsServices = R2Sql | ModelStatRepo | ProviderStatRepo | GeoStatRepo | RetentionStatRepo

export const syncStats: (options?: {
  full?: boolean
}) => Effect.Effect<SyncStatsResult, SyncStatsError, SyncStatsServices> = Effect.fn("StatSync.sync")(
  function* (options?: { full?: boolean }) {
    const startedAt = yield* DateTime.nowAsDate
    const periodEnd = new Date(Math.floor((startedAt.getTime() - DATALAKE_INGESTION_LAG_MS) / 60_000) * 60_000)
    const periodStart = options?.full ? fullPeriodStart(periodEnd) : incrementalPeriodStart(periodEnd)
    const r2Sql = yield* R2Sql
    const modelStats = yield* ModelStatRepo
    const providerStats = yield* ProviderStatRepo
    const geoStats = yield* GeoStatRepo
    const retentionStats = yield* RetentionStatRepo

    yield* logRuntimeCheck()

    const queries = buildStatsQueries(periodStart, periodEnd)
    yield* Effect.logInfo(
      `stats sync started ${JSON.stringify({ full: options?.full ?? false, periodStart, periodEnd, queries: queries.length })}`,
    )
    const rows = yield* Effect.forEach(
      queries,
      (query, index) =>
        r2Sql.query(query).pipe(
          Effect.tap((rows) =>
            Effect.logInfo(
              `stats query complete ${JSON.stringify({ index, total: queries.length, rows: rows.length })}`,
            ),
          ),
          Effect.tapError((error) =>
            Effect.logError(
              `stats query failed ${JSON.stringify({ index, total: queries.length, error: error.message })}`,
            ),
          ),
        ),
      {
        concurrency: 4,
      },
    ).pipe(Effect.map((batches) => batches.flat()))
    const modelRows = modelRowsFromAggregates(rows.filter((row) => row.dimension === "model").flatMap(toModelAggregate))
    const providerRows = providerRowsFromAggregates(
      rows.filter((row) => row.dimension === "provider").flatMap(toProviderAggregate),
    )
    const geoRows = geoRowsFromAggregates(
      rows.filter((row) => row.dimension === "geo" || row.dimension === "geo_model").flatMap(toGeoAggregate),
    )
    const retentionAvailable = yield* retentionStats.available()
    const retentionQueries = retentionAvailable
      ? buildRetentionQueries(
          options?.full
            ? periodStart
            : new Date(
                Math.max(startOfUtcDay(periodEnd).getTime() - RETENTION_INCREMENTAL_LOOKBACK_MS, STATS_DATA_START_MS),
              ),
          startOfUtcDay(periodEnd),
        )
      : []
    yield* Effect.logInfo(`stats sync querying retention ${JSON.stringify({ queries: retentionQueries.length })}`)
    const retentionRows = retentionRowsFromAggregates(
      yield* Effect.forEach(
        retentionQueries,
        (item) =>
          r2Sql.query(item.query).pipe(
            Effect.tap((rows) =>
              Effect.logInfo(
                `retention query complete ${JSON.stringify({ cohortDates: item.cohortDates, rows: rows.length })}`,
              ),
            ),
            Effect.tapError((error) =>
              Effect.logError(
                `retention query failed ${JSON.stringify({ cohortDates: item.cohortDates, error: error.message })}`,
              ),
            ),
          ),
        { concurrency: 4 },
      ).pipe(Effect.map((batches) => batches.flatMap((batch) => batch.flatMap(toRetentionAggregate)))),
    )

    yield* Effect.logInfo(
      `stats sync writing aggregates ${JSON.stringify({ modelRows: modelRows.length, providerRows: providerRows.length, geoRows: geoRows.length, retentionRows: retentionRows.length })}`,
    )
    yield* Effect.all(
      [
        modelStats.upsert(modelRows),
        providerStats.upsert(providerRows),
        geoStats.upsert(geoRows),
        retentionStats.replace(retentionRows, {
          cohortDates: retentionQueries.flatMap((item) => item.cohortDates),
          dataset: Resource.StatsSyncConfig.dataset,
          tier: "Go",
        }),
      ],
      {
        concurrency: "unbounded",
        discard: true,
      },
    )
    yield* Effect.all(
      [
        modelStats.deleteRetiredDimensions(modelRows),
        providerStats.deleteRetiredDimensions(providerRows),
        geoStats.deleteRetiredDimensions(geoRows),
      ],
      { concurrency: "unbounded", discard: true },
    )

    yield* Effect.logInfo(
      `stats sync complete ${JSON.stringify({
        startedAt: startedAt.toISOString(),
        periodStart: periodStart.toISOString(),
        periodEnd: periodEnd.toISOString(),
        rows: modelRows.length,
        providerRows: providerRows.length,
        geoRows: geoRows.length,
        retentionRows: retentionRows.length,
        retentionAvailable,
        stage: Resource.App.stage,
      })}`,
    )

    return {
      ok: true,
      rows: modelRows.length,
      startedAt: startedAt.toISOString(),
      periodStart: periodStart.toISOString(),
      periodEnd: periodEnd.toISOString(),
    }
  },
)

// May 27 was partial, so keep stats anchored at the first complete day.
function fullPeriodStart(periodEnd: Date) {
  return new Date(
    Math.max(
      Math.min(startOfIsoWeek(periodEnd).getTime() - WEEK_MS, periodEnd.getTime() - DISPLAY_WINDOW_MS),
      STATS_DATA_START_MS,
    ),
  )
}

// Events are append-only, so completed periods never change once synced; hourly
// passes only recompute the periods the current ISO week can still touch. The daily
// full pass refreshes the whole display window (normalization changes, retired
// dimension cleanup).
function incrementalPeriodStart(periodEnd: Date) {
  return new Date(
    Math.max(startOfIsoWeek(new Date(periodEnd.getTime() - INCREMENTAL_LOOKBACK_MS)).getTime(), STATS_DATA_START_MS),
  )
}

function logRuntimeCheck() {
  return Effect.logInfo(
    `r2 sql stats runtime check ${JSON.stringify({
      accountId: Resource.R2Sql.accountId,
      bucket: Resource.R2Sql.bucket,
      dataset: Resource.StatsSyncConfig.dataset,
      namespace: Resource.R2Sql.namespace,
      table: Resource.R2Sql.table,
      stage: Resource.App.stage,
    })}`,
  )
}
