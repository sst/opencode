import { text, sqliteTable } from "drizzle-orm/sqlite-core"
import { FileDiff } from "@opencode-ai/schema/file-diff"
import type { MessageID } from "../v1/session"
import { MessageTable } from "../session/sql"

export const MessageDiffTable = sqliteTable("message_diff", {
  message_id: text()
    .$type<MessageID>()
    .primaryKey()
    .references(() => MessageTable.id, { onDelete: "cascade" }),
  data: text({ mode: "json" }).notNull().$type<ReadonlyArray<FileDiff.Info>>(),
})
