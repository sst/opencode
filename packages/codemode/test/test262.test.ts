/*
 * Runs the test262 files vendored under test/test262 (see test/test262/README.md) verbatim.
 * Files listed in test/test262/skipped.txt fail on a known interpreter gap and are skipped;
 * `bun run script/test262-report.ts` shows current gaps and which skipped files pass again.
 * Licensed under test/LICENSE.test262.
 */
import { test } from "bun:test"
import { root, run, skipped } from "./test262/run.js"

for (const file of [...new Bun.Glob("**/*.js").scanSync({ cwd: root })].sort()) {
  const define = skipped.has(file) ? test.skip : test
  define(
    file,
    async () => {
      const outcome = await run(file)
      if (outcome.status === "fail") throw new Error(outcome.reason)
    },
    10_000,
  )
}
