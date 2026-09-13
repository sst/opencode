# Vite TUI entrypoint

From the repository root:

```sh
bun run dev:vite:live /path/to/project
```

This uses the normal CLI and its real TUI through Vite + `solid-refresh`. For an explicit server or private backend, use `dev:vite` with `--server URL` or `--standalone` respectively. Plain `dev:vite` uses normal CLI service discovery; `dev:vite:live` explicitly connects to the installed server without replacing it.

- Component edits hot-update through the existing Solid refresh runtime.
- Full reloads await TUI cleanup and restore the current route: the selected session, Home workspace, or plugin page. They do not preserve composer drafts or other component-local state, and do not replay launch prompts, route prompts, `--continue`, or `--fork`.
- Correcting syntax errors retries a failed reload. The backend stays alive.
- Refreshable components get local error boundaries. A render failure during a hot update triggers one full UI reload. If the fresh render also fails, the error appears in the shared themed Dialog rather than causing a reload loop. Only the latest error is shown. Escape dismisses it; saving retries failed components. State within remounted components can still reset, especially when several components share an edited file.
- Launcher/config/dependency changes require restarting the development client.

`vite.ts` registers a Bun runtime module that supplies the Vite runner for the CLI's existing static `@opencode/tui` import. This registration runs only in the dev launcher; production handlers and their import graph are unchanged. `tui.ts` owns Vite and the TUI lifecycle. `entry.ts` loads the real application source through Vite. `host.js` keeps lifecycle ownership outside Vite's reloadable module cache. No production CLI handler, TUI component, or route changes are needed.

`refresh.ts` delegates component replacement to stock `solid-refresh`, wrapping each returned component proxy in Solid's standard ErrorBoundary. It preserves registered context identities during module evaluation: Vite's native runner can re-evaluate cyclic dependencies without invoking their HMR accept callbacks, which is too late for stock context patching. `refresh-runtime.d.ts` supplies types for the package's existing deep runtime export.

Vite redirects imports of the TUI route context through `route.tsx`, a dev-only wrapper around the real provider. It saves plain route snapshots in the external `host.js`, including nested Home location and plugin page data. Production route code is unchanged. Recovery is armed only for a hot update, consumed before requesting a full reload, and disarmed when the update settles or the full reload starts.

The entry initializes the error overlay after loading the app graph because the shared dialog and theme modules themselves use the refresh runtime.

Tested on Linux/Bun with full-app rendering, message/palette HMR, draft preservation, and native-terminal full reload/error recovery. External native-loaded plugins remain experimental across full reloads because their process-lifetime runtime mappings can retain an older Solid generation.
