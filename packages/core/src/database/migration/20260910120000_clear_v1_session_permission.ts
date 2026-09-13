import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: "20260910120000_clear_v1_session_permission",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`UPDATE \`session_v2\` SET \`permission\` = NULL;`)
    })
  },
}

export default migration
