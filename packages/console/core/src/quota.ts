import { z } from "zod"
import { and, Database, eq, isNull } from "./drizzle"
import { LiteTable, SubscriptionTable } from "./schema/billing.sql"
import { Identifier } from "./identifier"
import { fn } from "./util/fn"

export namespace Quota {
  // Zero all usage counters of one plan for a workspace, using the same
  // workspace-scoped addressing as unsubscribeLite/unsubscribeBlack and
  // Billing.subtractLiteUsage. Timestamps are left untouched on purpose: a
  // zeroed counter with a current-window stamp reads as empty and the next
  // write accumulates on top of zero, so the active windows stay undisturbed.
  export const reset = fn(
    z.object({
      workspaceID: Identifier.schema("workspace"),
      plan: z.enum(["lite", "subscription"]),
    }),
    async (input) => {
      if (input.plan === "lite") {
        return Database.transaction(async (db) => {
          const where = and(eq(LiteTable.workspaceID, input.workspaceID), isNull(LiteTable.timeDeleted))
          const rows = await db
            .select({
              rollingUsage: LiteTable.rollingUsage,
              weeklyUsage: LiteTable.weeklyUsage,
              monthlyUsage: LiteTable.monthlyUsage,
            })
            .from(LiteTable)
            .where(where)
          if (rows.length === 0) throw new Error("No lite usage counters found for workspace")

          await db.update(LiteTable).set({ rollingUsage: 0, weeklyUsage: 0, monthlyUsage: 0 }).where(where)
          return {
            plan: "lite" as const,
            before: {
              rollingUsage: rows.reduce((sum, row) => sum + (row.rollingUsage ?? 0), 0),
              weeklyUsage: rows.reduce((sum, row) => sum + (row.weeklyUsage ?? 0), 0),
              monthlyUsage: rows.reduce((sum, row) => sum + (row.monthlyUsage ?? 0), 0),
            },
          }
        })
      }
      if (input.plan === "subscription") {
        return Database.transaction(async (db) => {
          const where = and(eq(SubscriptionTable.workspaceID, input.workspaceID), isNull(SubscriptionTable.timeDeleted))
          const rows = await db
            .select({ rollingUsage: SubscriptionTable.rollingUsage, fixedUsage: SubscriptionTable.fixedUsage })
            .from(SubscriptionTable)
            .where(where)
          if (rows.length === 0) throw new Error("No subscription usage counters found for workspace")

          await db.update(SubscriptionTable).set({ rollingUsage: 0, fixedUsage: 0 }).where(where)
          return {
            plan: "subscription" as const,
            before: {
              rollingUsage: rows.reduce((sum, row) => sum + (row.rollingUsage ?? 0), 0),
              fixedUsage: rows.reduce((sum, row) => sum + (row.fixedUsage ?? 0), 0),
            },
          }
        })
      }
      throw new Error(`Unknown plan: ${input.plan}`)
    },
  )
}
