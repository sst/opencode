# TUI plugins

Technical reference for the current TUI plugin system.

## Overview

- TUI plugin config lives in `tui.json`.
- Author package entrypoint is `@opencode-ai/plugin/tui`.
- Internal plugins load inside the CLI app the same way external TUI plugins do.
- Package plugins can be installed from CLI or TUI.
- v1 plugin modules are target-exclusive: a module can export `server` or `tui`, never both.
- Server runtime keeps v0 legacy fallback (function exports / enumerated exports) after v1 parsing.
- npm packages can be TUI theme-only via `package.json["oc-themes"]` without a `./tui` entrypoint.

## TUI config

Example:

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "theme": "smoke-theme",
  "leader_timeout": 2000,
  "keybinds": {
    "leader": "ctrl+x",
    "command_list": "ctrl+p",
    "session_new": "<leader>n"
  },
  "plugin": ["@acme/opencode-plugin@1.2.3", ["./plugins/demo.tsx", { "label": "demo" }]],
  "plugin_enabled": {
    "acme.demo": false
  },
  "attention": {
    "enabled": true,
    "notifications": true,
    "sound": true,
    "volume": 0.4,
    "sound_pack": "opencode.default",
    "sounds": {
      "error": "/Users/me/sounds/error.mp3"
    }
  }
}
```

- `plugin` entries can be either a string spec or `[spec, options]`.
- Plugin specs can be npm specs, `file://` URLs, relative paths, or absolute paths.
- Relative path specs are resolved relative to the config file that declared them.
- A file module listed in `tui.json` must be a TUI module (`default export { id?, tui }`) and must not export `server`.
- Duplicate npm plugins are deduped by package name; higher-precedence config wins.
- Duplicate file plugins are deduped by exact resolved file spec. This happens while merging config, before plugin modules are loaded.
- `plugin_enabled` is keyed by plugin id, not by plugin spec.
- For file plugins, that id must come from the plugin module's exported `id`. For npm plugins, it is the exported `id` or the package name if `id` is omitted.
- Plugins are enabled by default. `plugin_enabled` is only for explicit overrides, usually to disable a plugin with `false`.
- Internal plugins can declare `enabled: false` to be registered but inactive by default; `plugin_enabled` and runtime KV can still enable them by id.
- `plugin_enabled` is merged across config layers.
- Runtime enable/disable state is also stored in KV under `plugin_enabled`; that KV state overrides config on startup.
- `attention.enabled` defaults to `false`; when `false`, it disables all `api.attention.notify(...)` delivery.
- `attention.notifications` and `attention.sound` independently control terminal-mediated desktop notifications and built-in sounds.
- `attention.volume` sets the default built-in sound volume from `0` to `1`.
- `attention.sound_pack` selects the initial semantic sound pack. Persisted runtime selection in KV can override it.
- `attention.sounds` overrides individual semantic sound slots such as `error`, `done`, or `subagent_done`.
- `leader_timeout` is a top-level TUI setting.
- `keybinds` is a flat object keyed by command id; values are key binding values (`false`, `"none"`, a key string/object, a binding object, or an array of key strings/objects/binding objects).
- `keybinds.leader` sets the key used by `<leader>` shortcuts.

## Author package shape

Package entrypoint:

- Import types from `@opencode-ai/plugin/tui`.
- `@opencode-ai/plugin` exports `./tui` and declares optional peer deps on `@opentui/core` and `@opentui/solid`.

Minimal module shape:

```tsx
/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui"

const tui: TuiPlugin = async (api, options, meta) => {
  api.keymap.registerLayer({
    commands: [
      {
        name: "demo.open",
        title: "Demo",
        category: "Plugin",
        namespace: "palette",
        slashName: "demo",
        run() {
          api.route.navigate("demo")
        },
      },
    ],
    bindings: [{ key: "ctrl+shift+m", cmd: "demo.open", desc: "Open demo" }],
  })

  api.route.register([
    {
      name: "demo",
      render: () => (
        <box>
          <text>demo</text>
        </box>
      ),
    },
  ])
}

const plugin: TuiPluginModule & { id: string } = {
  id: "acme.demo",
  tui,
}

export default plugin
```

- Loader only reads the module default export object. Named exports are ignored.
- TUI shape is `default export { id?, tui }`; including `server` is rejected.
- A single module cannot export both `server` and `tui`.
- `tui` signature is `(api, options, meta) => Promise<void>`.
- If package `exports` contains `./tui`, the loader resolves that entrypoint.
- If package `exports` exists, loader only resolves `./tui` or `./server`; it never falls back to `exports["."]`.
- For npm package specs, TUI does not use `package.json` `main` as a fallback entry.
- `package.json` `main` is only used for server plugin entrypoint resolution.
- If a configured TUI package has no `./tui` entrypoint and no valid `oc-themes`, it is skipped with a warning (not a load failure).
- If a configured TUI package has no `./tui` entrypoint but has valid `oc-themes`, runtime creates a no-op module record and still loads it for theme sync and plugin state.
- If a package supports both server and TUI, use separate files and package `exports` (`./server` and `./tui`) so each target resolves to a target-only module.
- File/path plugins must export a non-empty `id`.
- npm plugins may omit `id`; package `name` is used.
- Runtime identity is the resolved plugin id. Later plugins with the same id are rejected, including collisions with internal plugin ids.
- If a path spec points at a directory, server loading can use `package.json` `main`.
- TUI path loading never uses `package.json` `main`.
- Legacy compatibility: path specs like `./plugin` can resolve to `./plugin/index.ts` (or `index.js`) when `package.json` is missing.
- The `./plugin -> ./plugin/index.*` fallback applies to both server and TUI v1 loading.
- There is no directory auto-discovery for TUI plugins; they must be listed in `tui.json`.

## Package manifest and install

Install target detection is inferred from `package.json` entrypoints and theme metadata:

- `server` target when `exports["./server"]` exists or `main` is set.
- `tui` target when `exports["./tui"]` exists.
- `tui` target when `oc-themes` exists and resolves to a non-empty set of valid package-relative theme paths.

`oc-themes` rules:

- `oc-themes` is an array of relative paths.
- Absolute paths and `file://` paths are rejected.
- Resolved theme paths must stay inside the package directory.
- Invalid `oc-themes` causes manifest read failure for install.

Example:

```json
{
  "name": "@acme/opencode-plugin",
  "type": "module",
  "main": "./dist/server.js",
  "exports": {
    "./server": {
      "import": "./dist/server.js",
      "config": { "custom": true }
    },
    "./tui": {
      "import": "./dist/tui.js",
      "config": { "compact": true }
    }
  },
  "engines": {
    "opencode": "^1.0.0"
  }
}
```

### Version compatibility

npm plugins can declare a version compatibility range in `package.json` using the standard `engines` field:

```json
{
  "engines": {
    "opencode": "^1.0.0"
  }
}
```

- The value is a semver range checked against the running OpenCode version.
- If the range is not satisfied, the plugin is skipped with a warning and a session error.
- If `engines.opencode` is absent, no check is performed (backward compatible).
- File plugins are never checked; only npm package plugins are validated.

- Install flow is shared by CLI and TUI in `src/plugin/install.ts`.
- Shared helpers are `installPlugin`, `readPluginManifest`, and `patchPluginConfig`.
- `opencode plugin <module>` and TUI install both run install → manifest read → config patch.
- Alias: `opencode plug <module>`.
- `-g` / `--global` writes into the global config dir.
- Local installs resolve target dir inside `patchPluginConfig`.
- For local scope, path is `<worktree>/.opencode` only when VCS is git and `worktree !== "/"`; otherwise `<directory>/.opencode`.
- Root-worktree fallback (`worktree === "/"` uses `<directory>/.opencode`) is covered by regression tests.
- `patchPluginConfig` applies all detected targets (`server` and/or `tui`) in one call.
- `patchPluginConfig` returns structured result unions (`ok`, `code`, fields by error kind) instead of custom thrown errors.
- `patchPluginConfig` serializes per-target config writes with `Flock.acquire(...)`.
- `patchPluginConfig` uses targeted `jsonc-parser` edits, so existing JSONC comments are preserved when plugin entries are added or replaced.
- npm plugin package installs are executed with `--ignore-scripts`, so package `install` / `postinstall` lifecycle scripts are not run.
- `exports["./server"].config` and `exports["./tui"].config` can provide default plugin options written on first install.
- Without `--force`, an already-configured npm package name is a no-op.
- With `--force`, replacement matches by package name. If the existing row is `[spec, options]`, those tuple options are kept.
- Explicit npm specs with a version suffix (for example `pkg@1.2.3`) are pinned. Runtime install requests that exact version and does not run stale/latest checks for newer registry versions.
- Bare npm specs (`pkg`) are treated as `latest` and can refresh when the cached version is stale.
- Tuple targets in `oc-plugin` provide default options written into config.
- A package can target `server`, `tui`, or both.
- If a package targets both, each target must still resolve to a separate target-only module. Do not export `{ server, tui }` from one module.
- There is no uninstall, list, or update CLI command for external plugins.
- Local file plugins are configured directly in `tui.json`.

When `plugin` entries exist in a writable `.opencode` dir or `OPENCODE_CONFIG_DIR`, OpenCode installs `@opencode-ai/plugin` into that dir and writes:

- `package.json`
- `bun.lock`
- `node_modules/`
- `.gitignore`

That is what makes local config-scoped plugins able to import `@opencode-ai/plugin/tui`.

## TUI plugin API

Top-level API groups exposed to `tui(api, options, meta)`:

- `api.app.version`
- `api.attention.notify(input)`
- `api.keys.formatSequence(parts)`, `formatBindings(bindings)`
- `api.keymap`
- `api.mode.current()`, `api.mode.push(mode)`
- `api.route.register(routes)` / `api.route.navigate(name, params?)` / `api.route.current`
- `api.ui.Dialog`, `DialogAlert`, `DialogConfirm`, `DialogPrompt`, `DialogSelect`, `Slot`, `Prompt`, `ui.toast`, `ui.dialog`
- `api.tuiConfig`
- `api.kv.get`, `set`, `ready`
- `api.state`
- `api.theme.current`, `selected`, `has`, `set`, `install`, `mode`, `ready`
- `api.client`
- `api.event.on(type, handler)`
- `api.renderer`
- `api.slots.register(plugin)`
- `api.plugins.list()`, `activate(id)`, `deactivate(id)`, `add(spec)`, `install(spec, options?)`
- `api.lifecycle.signal`, `api.lifecycle.onDispose(fn)`

### Keymap

- `api.keymap` exposes the raw `Keymap<Renderable, KeyEvent>` instance from the host.
- The host already installs the default OpenTUI bundle (`default keys`, metadata fields, and enabled fields) plus OpenCode's comma bindings, leader token, base layout fallback, pending-sequence helpers, and managed textarea layer.
- Register commands with `api.keymap.registerLayer({ commands: [...] })`.
- Register key bindings with `bindings: [{ key, cmd, desc }]` in the same layer or a separate layer.
- Use `api.keymap.acquireResource(...)` for shared plugin addon setup that should ref-count against the host keymap.
- To surface a command in the host command palette, set `namespace: "palette"` and provide metadata such as `title`, `category`, `desc`, `suggested`, `hidden`, `enabled`, `slashName`, and `slashAliases` on the command.
- Use `api.keymap.dispatchCommand(name)` for user-style execution semantics and `api.keymap.runCommand(name)` only for forced programmatic execution.
- Disposers returned by `api.keymap` registrations and `acquireResource(...)` are automatically cleaned up when the plugin deactivates. You do not need to add those disposers to `api.lifecycle.onDispose(...)` yourself.
- Built-in which-key shortcuts are resolved from flat `keybinds` command ids such as `which_key_toggle`, not plugin options.

#### Mode-aware layers

OpenCode registers a `mode` layer field on the host keymap. Plugins can use it to keep bindings active only in the relevant UI state.

Built-in modes:

- `base`: normal app, route, and prompt interaction.
- `modal`: host dialog stack is open, including dialogs rendered through `api.ui.dialog` and `api.ui.Dialog*` components.
- `autocomplete`: host prompt autocomplete is open.
- `api.mode.current()` returns the active top mode, or `base` when no pushed mode is active.

Example: register a command and shortcut that are active only in normal app mode:

```tsx
api.keymap.registerLayer({
  mode: "base",
  commands: [
    {
      name: "demo.open",
      title: "Demo",
      category: "Plugin",
      namespace: "palette",
      run() {
        api.route.navigate("demo")
      },
    },
  ],
  bindings: [{ key: "ctrl+shift+m", cmd: "demo.open", desc: "Open demo" }],
})
```

Layers without `mode` are not mode-gated and can remain active while dialogs or autocomplete are open. Use that only for intentionally global commands or low-level keymap extensions.

Plugins that own a full-screen route or modal-like UI can temporarily push a plugin-specific mode with `api.mode.push(...)`. Use a plugin-scoped mode name. The returned disposer pops that specific stack entry and is idempotent, so popping an older mode while a newer mode is on top leaves the newer mode active.

```tsx
import { onCleanup } from "solid-js"

api.route.register([
  {
    name: "demo",
    render: () => {
      const popMode = api.mode.push("acme.demo")
      onCleanup(popMode)

      return (
        <box>
          <text>demo</text>
        </box>
      )
    },
  },
])

api.keymap.registerLayer({
  mode: "acme.demo",
  bindings: [{ key: "escape", cmd: () => api.route.navigate("home"), desc: "Close demo" }],
})
```

Mode pushes are automatically tracked by the plugin runtime. If a plugin is disabled, fails during activation, or the TUI shuts down before the plugin calls the disposer, OpenCode pops the plugin's pushed modes during plugin cleanup. Calling the disposer yourself is still recommended for component lifetimes; cleanup remains idempotent.

### Keys

- `api.keys` exposes host-formatted shortcut display helpers for plugin UI.
- `formatSequence(parts)` formats parsed key sequence parts using the host's display policy.
- `formatBindings(bindings)` formats binding lists and returns `undefined` when there is nothing to show.
- For generic config-to-bindings helpers, import `createBindingLookup` from `@opencode-ai/plugin/tui`.

### Attention

- `api.attention.notify({ title?, message, notification?, sound? })` requests user attention while keeping terminal focus, notifications, and audio owned by the host.
- `message` is required; `title` defaults to `"opencode"`; `notification` defaults to enabled with `when: "blurred"`; `sound` defaults to enabled with `when: "always"`.
- `when: "always"` requests delivery regardless of terminal focus state.
- `when: "focused"` only requests delivery after the terminal is known focused; `when: "blurred"` only requests delivery after the terminal is known blurred.
- Example: `notification: { when: "blurred" }, sound: { name: "question", when: "always" }` plays sound while focused but only triggers system notifications when blurred.
- Semantic sound names are `"default"`, `"question"`, `"permission"`, `"error"`, `"done"`, and `"subagent_done"`.
- `sound: true` plays the `"default"` sound; `sound: { name: "question" }` plays a named semantic sound.
- `sound: { volume }` overrides volume for that call; `sound: false` disables sound for that call; `notification: false` disables system notification for that call.
- `api.attention.soundboard.registerPack({ id, name?, sounds })` registers a sound pack and returns a disposer. Relative paths resolve from the plugin root and are cleaned up on plugin deactivation.
- `api.attention.soundboard.activate(id, { persist })` selects the active pack. `persist: true` writes the selected pack id to TUI KV state, not `tui.json`.
- `api.attention.soundboard.current()` and `list()` expose the active/registered packs for plugin UX.
- Config `attention.sounds` overrides active-pack sounds by slot. Failed loads fall back to the active pack and then `opencode.default`.
- The host strips ANSI/control characters and collapses newlines before sending text to the terminal notification API.
- Terminal and OS settings decide whether a requested notification is visibly displayed.
- Prefer privacy-safe messages such as `"A question needs your input"`; avoid full commands, paths, prompts, errors, secrets, or file contents unless the plugin intentionally exposes them.

### Routes

- Reserved route names: `home` and `session`.
- Any other name is treated as a plugin route.
- `api.route.current` returns one of:
  - `{ name: "home" }`
  - `{ name: "session", params: { sessionID, initialPrompt? } }`
  - `{ name: string, params?: Record<string, unknown> }`
- `api.route.navigate("session", params)` only uses `params.sessionID`. It cannot set `initialPrompt`.
- If multiple plugins register the same route name, the last registered route wins.
- Unknown plugin routes render a fallback screen with a `go home` action.

### Dialogs and toast

- `ui.Dialog` is the base dialog wrapper.
- `ui.DialogAlert`, `ui.DialogConfirm`, `ui.DialogPrompt`, `ui.DialogSelect` are built-in dialog components.
- `ui.Slot` renders host or plugin-defined slots by name from plugin JSX.
- `ui.Prompt` renders the same prompt component used by the host app and accepts `sessionID`, `workspaceID`, `ref`, and `right` for the prompt meta row's right side.
- `ui.toast(...)` shows a toast.
- `ui.dialog` exposes the host dialog stack:
  - `replace(render, onClose?)`
  - `clear()`
  - `setSize("medium" | "large" | "xlarge")`
  - readonly `size`, `depth`, `open`

### KV, state, client, events

- `api.kv` is the shared app KV store backed by `state/kv.json`. It is not plugin-namespaced.
- `api.kv` exposes `ready`.
- `api.tuiConfig` and `api.state` are live host objects/getters, not frozen snapshots.
- `api.state` exposes synced TUI state:
  - `ready`
  - `config`
  - `provider`
  - `path.{state,config,worktree,directory}`
  - `vcs?.branch`
  - `session.count()`
  - `session.diff(sessionID)`
  - `session.todo(sessionID)`
  - `session.messages(sessionID)`
  - `session.status(sessionID)`
  - `session.permission(sessionID)`
  - `session.question(sessionID)`
  - `part(messageID)`
  - `lsp()`
  - `mcp()`
  - `scrollToMessage(messageID)` — scrolls the current session viewport to the given message id, returning `false` when no target session is attached
  - `scrollToBottom()` — scrolls the current session viewport to the bottom, returning `false` when no target session is attached
- `api.client` always reflects the current runtime client.
- `api.event.on(type, handler)` subscribes to the TUI event stream and returns an unsubscribe function.
- `api.renderer` exposes the raw `CliRenderer`.

### Theme

- `api.theme.current` exposes the resolved current theme tokens.
- `api.theme.selected` is the selected theme name.
- `api.theme.has(name)` checks for an installed theme.
- `api.theme.set(name)` switches theme and returns `boolean`.
- `api.theme.mode()` returns `"dark" | "light"`.
- `api.theme.install(jsonPath)` installs a theme JSON file.
- `api.theme.ready` reports theme readiness.

Theme install behavior:

- Relative theme paths are resolved from the plugin root.
- Theme name is the JSON basename.
- `api.theme.install(...)` and `oc-themes` auto-sync share the same installer path.
- Theme copy/write runs under cross-process lock key `tui-theme:<dest>`.
- First install writes only when the destination file is missing.
- If the theme name already exists, install is skipped unless plugin metadata state is `updated`.
- On `updated`, host skips rewrite when tracked `mtime`/`size` is unchanged.
- When a theme already exists and state is not `updated`, host can still persist theme metadata when destination already exists.
- Local plugins persist installed themes under the local `.opencode/themes` area near the plugin config source.
- Global plugins persist installed themes under the global `themes` dir.
- Invalid or unreadable theme files are ignored.

### Slots

Current host slot names:

- `app`
- `app_bottom`
- `home_logo`
- `home_prompt` with props `{ workspace_id?, ref? }`
- `home_prompt_right` with props `{ workspace_id? }`
- `session_prompt` with props `{ session_id, visible?, disabled?, on_submit?, ref? }`
- `session_prompt_right` with props `{ session_id }`
- `home_bottom`
- `home_footer`
- `sidebar_title` with props `{ session_id, title, share_url? }`
- `sidebar_content` with props `{ session_id }`
- `sidebar_footer` with props `{ session_id }`

Slot notes:

- Slot context currently exposes only `theme`.
- `api.slots.register(plugin)` returns the host-assigned slot plugin id.
- `api.slots.register(plugin)` does not return an unregister function.
- Returned ids are `pluginId`, `pluginId:1`, `pluginId:2`, and so on.
- Plugin-provided `id` is not allowed.
- The current host renders `home_logo`, `home_prompt`, and `session_prompt` with `replace`, `home_footer`, `sidebar_title`, and `sidebar_footer` with `single_winner`, and `app`, `app_bottom`, `home_prompt_right`, `session_prompt_right`, `home_bottom`, and `sidebar_content` with the slot library default mode.
- `app_bottom` is rendered in normal layout flow below the active route, while `app` is rendered afterward for global app-level UI.
- Plugins can define custom slot names in `api.slots.register(...)` and render them from plugin UI with `ui.Slot`.

### Plugin control and lifecycle

- `api.plugins.list()` returns `{ id, source, spec, target, enabled, active }[]`.
- `enabled` is the persisted desired state. `active` means the plugin is currently initialized.
- `api.plugins.activate(id)` sets `enabled=true`, persists it into KV, and initializes the plugin.
- `api.plugins.deactivate(id)` sets `enabled=false`, persists it into KV, and disposes the plugin scope.
- `api.plugins.add(spec)` trims the input and returns `false` for an empty string.
- `api.plugins.add(spec)` treats the input as the runtime plugin spec and loads it without re-reading `tui.json`.
- `api.plugins.add(spec)` no-ops when that resolved spec (or resolved plugin id) is already loaded.
- `api.plugins.add(spec)` assumes enabled and always attempts initialization (it does not consult config/KV enable state).
- `api.plugins.add(spec)` can load theme-only packages (`oc-themes` with no `./tui`) as runtime entries.
- `api.plugins.install(spec, { global? })` runs install -> manifest read -> config patch using the same helper flow as CLI install.
- `api.plugins.install(...)` returns either `{ ok: false, message, missing? }` or `{ ok: true, dir, tui }`.
- `api.plugins.install(...)` does not load plugins into the current session. Call `api.plugins.add(spec)` to load after install.
- If activation fails, the plugin can remain `enabled=true` and `active=false`.
- `api.lifecycle.signal` is aborted before cleanup runs.
- `api.lifecycle.onDispose(fn)` registers cleanup and returns an unregister function.

## Plugin metadata

`meta` passed to `tui(api, options, meta)` contains:

- `state`: `first | updated | same`
- `id`, `source`, `spec`, `target`
- npm-only fields when available: `requested`, `version`
- file-only field when available: `modified`
- `first_time`, `last_time`, `time_changed`, `load_count`, `fingerprint`

Metadata is persisted by plugin id.

- File plugin fingerprint is `target|modified`.
- npm plugin fingerprint is `target|requested|version`.
- Internal plugins get synthetic metadata with `state: "same"`.

## Runtime behavior

- Internal TUI plugins load first.
- External TUI plugins load from `tuiConfig.plugin`.
- `--pure` / `OPENCODE_PURE` skips external TUI plugins only.
- External plugin resolution and import are parallel.
- Packages with no `./tui` entrypoint and valid `oc-themes` are loaded as synthetic no-op TUI plugin modules.
- Theme-only packages loaded this way appear in `api.plugins.list()` and plugin manager rows like other external plugins.
- Packages with no `./tui` entrypoint and no valid `oc-themes` are skipped with warning.
- External plugin activation is sequential to keep command, route, and side-effect order deterministic.
- Theme auto-sync from `oc-themes` runs before plugin `tui(...)` execution and only on metadata state `first` or `updated`.
- File plugins that fail initially are retried once after waiting for config dependency installation.
- Runtime add uses the same external loader path, including the file-plugin retry after dependency wait.
- Runtime add skips duplicates by resolved spec and returns `true` when the spec is already loaded.
- Runtime install and runtime add are separate operations.
- Plugin init failure rolls back that plugin's tracked registrations and loading continues.
- TUI runtime tracks and disposes:
  - command registrations
  - route registrations
  - event subscriptions
  - slot registrations
  - explicit `lifecycle.onDispose(...)` handlers
- Cleanup runs in reverse order.
- Cleanup is awaited.
- Total cleanup budget per plugin is 5 seconds; timeout/error is logged and shutdown continues.

## Built-in plugins

- `internal:home-tips`
- `internal:sidebar-context`
- `internal:sidebar-mcp`
- `internal:sidebar-lsp`
- `internal:sidebar-todo`
- `internal:sidebar-files`
- `internal:sidebar-footer`
- `internal:plugin-manager`

Sidebar content order is currently: context `100`, mcp `200`, lsp `300`, todo `400`, files `500`.

The plugin manager is exposed as a command with title `Plugins` and value `plugins.list`.

- Keybind name is `plugin_manager`.
- Default keybind is `none`.
- It lists both internal and external plugins.
- It toggles based on `active`.
- Its own row is disabled only inside the manager dialog.
- It also exposes command `plugins.install` with title `Install plugin`.
- Inside the Plugins dialog, key `shift+i` opens the install prompt.
- Install prompt asks for npm package name.
- Scope defaults to local, and `tab` toggles local/global.
- Install is blocked until `api.state.path.directory` is available; current guard message is `Paths are still syncing. Try again in a moment.`.
- Manager install uses `api.plugins.install(spec, { global })`.
- If the installed package has no `tui` target (`tui=false`), manager reports that and does not expect a runtime load.
- `tui` target detection includes `exports["./tui"]` and valid `oc-themes`.
- If install reports `tui=true`, manager then calls `api.plugins.add(spec)`.
- If runtime add fails, TUI shows a warning and restart remains the fallback.

## Current in-repo examples

- Local smoke plugin: `.opencode/plugins/tui-smoke.tsx`
- Local vim plugin: `.opencode/plugins/tui-vim.tsx`
- Local smoke config: `.opencode/tui.json`
- Local smoke theme: `.opencode/plugins/smoke-theme.json`
