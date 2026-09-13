import { z } from "zod"
import { fn } from "./util/fn"
import { Actor } from "./actor"
import { Database } from "./drizzle"
import { Identifier } from "./identifier"
import { UserTable } from "./schema/user.sql"
import { BillingTable } from "./schema/billing.sql"
import { WorkspaceTable } from "./schema/workspace.sql"
import { AccountTable } from "./schema/account.sql"
import { Key } from "./key"
import { and, eq, inArray, isNull, sql } from "drizzle-orm"

export namespace Workspace {
  export const Region = z.enum(["us", "eu", "sg", "cn"])
  export type Region = z.infer<typeof Region>

  export const create = fn(
    z.object({
      name: z.string().min(1),
    }),
    async ({ name }) => {
      const account = Actor.assert("account")
      const workspaceID = Identifier.create("workspace")
      const userID = Identifier.create("user")
      await Database.transaction(async (tx) => {
        const active = await tx
          .select({ id: AccountTable.id })
          .from(AccountTable)
          .where(and(eq(AccountTable.id, account.properties.accountID), isNull(AccountTable.timeDeleted)))
          .then((rows) => rows[0])
        if (!active) throw new Error("Account is not active")

        await tx.insert(WorkspaceTable).values({
          id: workspaceID,
          name,
        })
        await tx.insert(UserTable).values({
          workspaceID,
          id: userID,
          accountID: account.properties.accountID,
          name: "",
          role: "admin",
        })
        await tx.insert(BillingTable).values({
          workspaceID,
          id: Identifier.create("billing"),
          balance: 0,
        })
      })
      await Actor.provide(
        "system",
        {
          workspaceID,
        },
        () => Key.create({ userID, name: "Default API Key" }),
      )
      return workspaceID
    },
  )

  export const update = fn(
    z.object({
      name: z.string().min(1).max(255).optional(),
      region: z.array(Region).min(1).optional(),
      allow_training: z.boolean().optional(),
    }),
    async (input) => {
      Actor.assertAdmin()
      const workspaceID = Actor.workspace()
      return await Database.use((tx) =>
        tx
          .update(WorkspaceTable)
          .set({
            ...("name" in input ? { name: input.name } : {}),
            ...("region" in input ? { region: input.region } : {}),
            ...("allow_training" in input ? { allow_training: input.allow_training } : {}),
          })
          .where(eq(WorkspaceTable.id, workspaceID)),
      )
    },
  )

  export const setDefaultRegion = fn(
    z.object({
      country: z.string().optional(),
    }),
    async (input) => {
      const region: Workspace.Region[] =
        input.country?.toUpperCase() === "CN" ? ["us", "eu", "sg", "cn"] : ["us", "eu", "sg"]
      await Database.use((tx) =>
        tx
          .update(WorkspaceTable)
          .set({ region })
          .where(and(eq(WorkspaceTable.id, Actor.workspace()), isNull(WorkspaceTable.region))),
      )
      return region
    },
  )

  export const unblock = fn(
    z.object({
      workspaceID: Identifier.schema("workspace"),
    }),
    async (input) => {
      const result = await Database.use((tx) =>
        tx.update(WorkspaceTable).set({ is_blocked: false }).where(eq(WorkspaceTable.id, input.workspaceID)),
      )
      if (result.rowsAffected === 0) throw new Error("Workspace not found")
    },
  )

  export const blockBatch = fn(
    z.object({
      workspaceIDs: z.array(Identifier.schema("workspace")).min(1),
    }),
    async (input) => {
      const { applied, notFound } = await setBlockedBatch(input, true)
      return { blocked: applied, notFound }
    },
  )

  export const unblockBatch = fn(
    z.object({
      workspaceIDs: z.array(Identifier.schema("workspace")).min(1),
    }),
    async (input) => {
      const { applied, notFound } = await setBlockedBatch(input, false)
      return { unblocked: applied, notFound }
    },
  )

  export const remove = fn(z.void(), async () => {
    await Database.use((tx) =>
      tx
        .update(WorkspaceTable)
        .set({ timeDeleted: sql`now()` })
        .where(eq(WorkspaceTable.id, Actor.workspace())),
    )
  })
}

// No size cap by design; large IN lists degrade on Vitess, so chunks stay fixed-size and
// sequential to share one connection inside ambient transactions. Existence comes from the
// follow-up select rather than rowsAffected, so no-op rows (already in the target state)
// still report as applied instead of "not found".
const setBlockedBatch = async (input: { workspaceIDs: string[] }, isBlocked: boolean) => {
  const ids = [...new Set(input.workspaceIDs)]
  return await Database.use(async (tx) => {
    const applied = new Set<string>()
    for (let index = 0; index < ids.length; index += 500) {
      const chunk = ids.slice(index, index + 500)
      await tx.update(WorkspaceTable).set({ is_blocked: isBlocked }).where(inArray(WorkspaceTable.id, chunk))
      const rows = await tx
        .select({ id: WorkspaceTable.id })
        .from(WorkspaceTable)
        .where(inArray(WorkspaceTable.id, chunk))
      for (const row of rows) applied.add(row.id)
    }
    return {
      applied: ids.filter((id) => applied.has(id)),
      notFound: ids.filter((id) => !applied.has(id)),
    }
  })
}
