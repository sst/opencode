import { Context, Effect, Layer, Schema } from "effect"
import { Resource } from "sst/resource"

const R2_SQL_MAX_ROWS = 10_000
const R2_SQL_TIMEOUT_MS = 15 * 60_000
const R2SqlValue = Schema.Union([Schema.String, Schema.Number, Schema.Boolean, Schema.Null])
const R2SqlResponse = Schema.Struct({
  success: Schema.Boolean,
  result: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        request_id: Schema.String,
        rows: Schema.Array(Schema.Record(Schema.String, R2SqlValue)),
      }),
    ),
  ),
  errors: Schema.Array(Schema.Unknown),
})
const decodeResponse = Schema.decodeUnknownEffect(Schema.fromJsonString(R2SqlResponse))

export type R2SqlData = Record<string, string>

export class R2SqlQueryError extends Error {
  readonly _tag = "R2SqlQueryError"
  readonly requestId?: string
  readonly status?: number

  constructor(input: { message: string; requestId?: string; status?: number; cause?: unknown }) {
    super(input.cause instanceof Error ? `${input.message}: ${input.cause.toString()}` : input.message, {
      cause: input.cause,
    })
    this.name = "R2SqlQueryError"
    this.requestId = input.requestId
    this.status = input.status
  }
}

export declare namespace R2Sql {
  export interface Service {
    readonly query: (query: string) => Effect.Effect<R2SqlData[], R2SqlQueryError>
  }
}

export class R2Sql extends Context.Service<R2Sql, R2Sql.Service>()("@opencode/stats/R2Sql") {
  static readonly layer: Layer.Layer<R2Sql> = Layer.succeed(
    R2Sql,
    R2Sql.of({
      query: Effect.fn("R2Sql.query")(function* (query: string) {
        const startedAt = Date.now()
        const response = yield* Effect.tryPromise({
          try: (signal) => {
            const options = {
              method: "POST",
              // Analytical queries can exceed Bun's default five-minute idle timer.
              // Bound the whole request and cancel it when the sync is interrupted.
              timeout: false,
              signal: AbortSignal.any([signal, AbortSignal.timeout(R2_SQL_TIMEOUT_MS)]),
              headers: {
                Authorization: `Bearer ${Resource.R2SqlAuthToken.value}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ query }),
            }
            return Bun.fetch(
              `https://api.sql.cloudflarestorage.com/api/v1/accounts/${Resource.R2Sql.accountId}/r2-sql/query/${Resource.R2Sql.bucket}`,
              options,
            )
          },
          catch: (cause) =>
            new R2SqlQueryError({
              message: `Failed to run R2 SQL stats query after ${Date.now() - startedAt}ms`,
              cause,
            }),
        })
        const body = yield* Effect.tryPromise({
          try: () => response.text(),
          catch: (cause) =>
            new R2SqlQueryError({ message: "Failed to read R2 SQL stats response", status: response.status, cause }),
        })
        const decoded = yield* decodeResponse(body).pipe(
          Effect.mapError(
            (cause) =>
              new R2SqlQueryError({
                message: "R2 SQL returned an invalid stats response",
                status: response.status,
                cause,
              }),
          ),
        )
        if (!response.ok || !decoded.success || !decoded.result)
          return yield* Effect.fail(
            new R2SqlQueryError({
              message: `R2 SQL stats query failed: ${JSON.stringify(decoded.errors)}`,
              requestId: decoded.result?.request_id,
              status: response.status,
            }),
          )

        // R2 SQL has no OFFSET support and caps LIMIT at 10,000. Each stats
        // query is scoped to one day or week, and reaching the cap is treated as
        // an error so a newly high-cardinality period can never be truncated.
        if (decoded.result.rows.length >= R2_SQL_MAX_ROWS)
          return yield* Effect.fail(
            new R2SqlQueryError({
              message: `R2 SQL stats query reached the ${R2_SQL_MAX_ROWS} row limit`,
              requestId: decoded.result.request_id,
              status: response.status,
            }),
          )

        return decoded.result.rows.map((row) =>
          Object.fromEntries(
            Object.entries(row).flatMap(([key, value]) => (value === null ? [] : [[key, String(value)]])),
          ),
        )
      }),
    }),
  )
}
