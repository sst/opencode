import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260815091902_message_diff",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`message_diff\` (
          \`message_id\` text PRIMARY KEY,
          \`data\` text NOT NULL,
          CONSTRAINT \`fk_message_diff_message_id_message_id_fk\` FOREIGN KEY (\`message_id\`) REFERENCES \`message\`(\`id\`) ON DELETE CASCADE
        );
      `)
    })
  },
} satisfies DatabaseMigration.Migration
