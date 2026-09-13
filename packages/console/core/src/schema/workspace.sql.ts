import { boolean, json, primaryKey, mysqlTable, uniqueIndex, varchar } from "drizzle-orm/mysql-core"
import { timestamps, ulid, utc } from "../drizzle/types"

export const WorkspaceTable = mysqlTable(
  "workspace",
  {
    id: ulid("id").notNull().primaryKey(),
    slug: varchar("slug", { length: 255 }),
    name: varchar("name", { length: 255 }).notNull(),
    region: json("region").$type<("us" | "eu" | "sg" | "cn")[]>(),
    allow_training: boolean(),
    is_blocked: boolean(),
    is_flagged_by_anthropic: boolean(),
    is_flagged_by_openai: boolean(),
    migrated_at: utc("migrated_at"),
    ...timestamps,
  },
  (table) => [uniqueIndex("slug").on(table.slug)],
)

export function workspaceIndexes(table: any) {
  return [
    primaryKey({
      columns: [table.workspaceID, table.id],
    }),
  ]
}
