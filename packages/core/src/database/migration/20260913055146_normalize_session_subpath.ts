import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260913055146_normalize_session_subpath",
  up(tx) {
    return Effect.gen(function* () {
      // Non-git projects resolve to "/" as their directory. On Windows "/" follows the
      // current process drive, so path.relative() returned the directory unchanged when
      // the session lived on another drive. Those sessions stored an absolute `path`,
      // which the session list filter never matches. Rewrite them relative to the drive
      // root, the same base the writer now uses. UNC paths ("//host/share") have the same
      // shape with a different root and are left alone.
      yield* tx.run(`DROP TABLE IF EXISTS session_path_fix;`)
      yield* tx.run(`
        CREATE TEMP TABLE session_path_fix AS
        SELECT id AS session_id, path AS absolute, substr(path, 4) AS relative
        FROM session
        WHERE path GLOB '[A-Za-z]:/*';
      `)
      yield* tx.run(`UPDATE session SET path = substr(path, 4) WHERE path GLOB '[A-Za-z]:/*';`)
      // The same value is embedded in each session's events, so a projection rebuild
      // would otherwise write the absolute path back. Cover both serializer spacings.
      yield* tx.run(`
        UPDATE event
        SET data = replace(
          data,
          '"path":"' || (SELECT absolute FROM session_path_fix WHERE session_id = event.aggregate_id) || '"',
          '"path":"' || (SELECT relative FROM session_path_fix WHERE session_id = event.aggregate_id) || '"'
        )
        WHERE type IN ('session.created.1', 'session.updated.1')
          AND instr(data, '"path":"' || (SELECT absolute FROM session_path_fix WHERE session_id = event.aggregate_id) || '"') > 0;
      `)
      yield* tx.run(`
        UPDATE event
        SET data = replace(
          data,
          '"path": "' || (SELECT absolute FROM session_path_fix WHERE session_id = event.aggregate_id) || '"',
          '"path": "' || (SELECT relative FROM session_path_fix WHERE session_id = event.aggregate_id) || '"'
        )
        WHERE type IN ('session.created.1', 'session.updated.1')
          AND instr(data, '"path": "' || (SELECT absolute FROM session_path_fix WHERE session_id = event.aggregate_id) || '"') > 0;
      `)
      yield* tx.run(`DROP TABLE session_path_fix;`)
    })
  },
} satisfies DatabaseMigration.Migration
