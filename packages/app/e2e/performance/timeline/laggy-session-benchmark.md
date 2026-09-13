# Session-export load benchmark

Replay an exported session against a production app build. The two cases compare the default Compact preset with every category ungrouped and details still collapsed.

From `packages/app` in PowerShell:

```powershell
$env:PLAYWRIGHT_BUILD = '1'
$env:PLAYWRIGHT_BASE_URL = 'http://127.0.0.1:4398' # Existing production preview
$env:LAGGY_SESSION_FILE = 'C:\path\session.json'
$env:LAGGY_SESSION_OUTPUT = 'C:\tmp\opencode\session-load'
$env:LAGGY_SESSION_HISTORY = 'paged' # Or 'full' to supply all exported history
bun x playwright test --config e2e/performance/playwright.config.ts timeline/laggy-session-benchmark.spec.ts --repeat-each=20 --workers=1 --retries=0
bun e2e/performance/timeline/laggy-session-report.ts $env:LAGGY_SESSION_OUTPUT
```

Each test uses a fresh browser context and measures one cold load, switches back to the source session, then measures one warm load. Repetitions therefore interleave `cold → warm` pairs rather than collecting separate cold and warm batches. There are no discarded warm-up switches. The warm member of every pair must issue zero message requests. Each pair is saved in a separate JSON file; compare paired differences as well as the cold and warm distributions when system load varies.

The report writes `summary.json` and prints the median, p95, maximum, and median paired cold-minus-warm difference. It rejects incomplete or cold-only records instead of mixing them into paired results.

`--repeat-each=20` collects 20 pairs per grouping mode. `LAGGY_SESSION_COLD_ONLY=1` remains available for focused cold profiling. Screenshots are taken after a pair finishes, not between its measurements.

The app shell, source session, model control, and fonts are ready before the timed action. These measurements cover session entry, not application startup. `firstCorrectObservedMs` begins at mousedown and ends when the destination is visible at its expected bottom position, including Compact's automatic history fill. `stableObservedMs` includes three-observation confirmation and must not be treated as additional rendering time.

Set `OPENCODE_PERFORMANCE_TRACE_DIR` for Chrome traces. `LAGGY_TRACE_ITERATION=0` traces the cold load; the default (`1`) traces the warm member of the pair. Profile separately from timing runs.

`LAGGY_HTTP=1` disables route interception for an external HTTP replay server containing the same export and source fixture. Keep direct HTTP and Playwright-routed cold series separate: routing adds transport overhead. Raw samples, mode settings, viewport, browser version, and screenshots are retained in the output directory. The export itself is not copied into the repository.
