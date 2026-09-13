import type { APIEvent } from "@solidjs/start/server"
import { and, Database, eq, isNull } from "@opencode-ai/console-core/drizzle/index.js"
import { BillingTable, LiteTable } from "@opencode-ai/console-core/schema/billing.sql.js"
import { KeyTable } from "@opencode-ai/console-core/schema/key.sql.js"
import { UserTable } from "@opencode-ai/console-core/schema/user.sql.js"
import { WorkspaceTable } from "@opencode-ai/console-core/schema/workspace.sql.js"
import { LiteData } from "@opencode-ai/console-core/lite.js"
import { Subscription } from "@opencode-ai/console-core/subscription.js"
import { inferenceUnavailable, proxyInference } from "~/lib/inference-proxy"

export async function GET(input: APIEvent) {
  const response = await proxyInference(input.request).catch(inferenceUnavailable)
  if (response) return response
  const apiKey = input.request.headers.get("authorization")?.match(/^Bearer (\S+)$/)?.[1]

  if (!apiKey) {
    return new Response(
      JSON.stringify({
        type: "error",
        error: {
          type: "AuthError",
          message: "Missing API key.",
        },
      }),
      {
        status: 401,
        headers: {
          "Content-Type": "application/json",
        },
      },
    )
  }

  const auth = await Database.use((tx) =>
    tx
      .select({
        userID: KeyTable.userID,
        workspaceID: KeyTable.workspaceID,
      })
      .from(KeyTable)
      .innerJoin(
        UserTable,
        and(
          eq(UserTable.workspaceID, KeyTable.workspaceID),
          eq(UserTable.id, KeyTable.userID),
          isNull(UserTable.timeDeleted),
        ),
      )
      .innerJoin(WorkspaceTable, and(eq(WorkspaceTable.id, KeyTable.workspaceID), isNull(WorkspaceTable.timeDeleted)))
      .innerJoin(
        BillingTable,
        and(eq(BillingTable.workspaceID, KeyTable.workspaceID), isNull(BillingTable.timeDeleted)),
      )
      .where(and(eq(KeyTable.key, apiKey), isNull(KeyTable.timeDeleted)))
      .then((rows) => rows[0]),
  )

  if (!auth) {
    return new Response(
      JSON.stringify({
        type: "error",
        error: {
          type: "AuthError",
          message: "Unauthorized",
        },
      }),
      {
        status: 401,
        headers: {
          "Content-Type": "application/json",
        },
      },
    )
  }

  const row = await Database.use((tx) =>
    tx
      .select({
        timeCreated: LiteTable.timeCreated,
        rollingUsage: LiteTable.rollingUsage,
        weeklyUsage: LiteTable.weeklyUsage,
        monthlyUsage: LiteTable.monthlyUsage,
        timeRollingUpdated: LiteTable.timeRollingUpdated,
        timeWeeklyUpdated: LiteTable.timeWeeklyUpdated,
        timeMonthlyUpdated: LiteTable.timeMonthlyUpdated,
      })
      .from(LiteTable)
      .where(
        and(
          eq(LiteTable.workspaceID, auth.workspaceID),
          eq(LiteTable.userID, auth.userID),
          isNull(LiteTable.timeDeleted),
        ),
      )
      .then((rows) => rows[0]),
  )

  if (!row) {
    return new Response(
      JSON.stringify({
        type: "error",
        error: {
          type: "EntitlementError",
          message: "OpenCode Go subscription required.",
        },
      }),
      {
        status: 403,
        headers: {
          "Content-Type": "application/json",
        },
      },
    )
  }

  const limits = LiteData.getLimits()

  return new Response(
    JSON.stringify({
      usage: {
        rolling: formatUsage(
          Subscription.analyzeRollingUsage({
            limit: limits.rollingLimit,
            window: limits.rollingWindow,
            usage: row.rollingUsage ?? 0,
            timeUpdated: row.timeRollingUpdated ?? new Date(),
          }),
        ),
        weekly: formatUsage(
          Subscription.analyzeWeeklyUsage({
            limit: limits.weeklyLimit,
            usage: row.weeklyUsage ?? 0,
            timeUpdated: row.timeWeeklyUpdated ?? new Date(),
          }),
        ),
        monthly: formatUsage(
          Subscription.analyzeMonthlyUsage({
            limit: limits.monthlyLimit,
            usage: row.monthlyUsage ?? 0,
            timeUpdated: row.timeMonthlyUpdated ?? new Date(),
            timeSubscribed: row.timeCreated,
          }),
        ),
      },
    }),
    {
      status: 200,
      headers: {
        "Content-Type": "application/json",
      },
    },
  )
}

function formatUsage(usage: { status: "ok" | "rate-limited"; resetInSec: number; usagePercent: number }) {
  return {
    status: usage.status,
    percent: usage.usagePercent,
    resetsAt: new Date(Date.now() + usage.resetInSec * 1000).toISOString(),
  }
}
