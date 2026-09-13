import type { PluginInfo } from "@opencode/client"
import { Plugin } from "@opencode/plugin/tui"
import path from "path"
import { createEffect, createMemo, createResource, createSignal, onCleanup, onMount, Show } from "solid-js"
import { DialogErrorDetails } from "../../component/dialog-error-details"
import { Spinner } from "../../component/spinner"
import { usePlugin } from "../../plugin/context"
import { DialogSelect, type DialogSelectOption } from "../../ui/dialog-select"
import { useDialog } from "../../ui/dialog"

const id = "opencode.plugins"

type Entry =
  | { readonly key: string; readonly runtime: "server"; readonly internal: boolean; readonly plugin: PluginInfo }
  | {
      readonly key: string
      readonly runtime: "tui"
      readonly internal: boolean
      readonly id?: string
      readonly target: string
      readonly status: "active" | "inactive" | "failed"
      readonly error?: string
    }

export function PluginsDialog(props: {
  context: Plugin.Context
  plugins: ReturnType<typeof usePlugin>
  server?: () => readonly PluginInfo[]
}) {
  const dialog = useDialog()
  const [locked, setLocked] = createSignal(false)
  const [checking, setChecking] = createSignal(false)
  const [focused, setFocused] = createSignal<string>()
  const [detail, setDetail] = createSignal<Entry>()
  const [showInternal, setShowInternal] = createSignal(false)
  const [pending, setPending] = createSignal<readonly string[]>([])
  const [server, { refetch, mutate }] = createResource(
    () => (props.server ? undefined : (props.context.location ?? props.context.data.location.default())),
    (location) => props.context.client.plugin.list({ location }).then((result) => result.data),
  )
  onMount(() => dialog.setSize("large"))
  onCleanup(props.context.data.on("plugin.updated", () => void refetch()))
  const updating = (entry: Entry) =>
    pending().includes(entry.key) ||
    (entry.runtime === "server" && entry.plugin.source.type === "package" && entry.plugin.source.updating === true)
  const updatable = (entry: Entry | undefined) => entry !== undefined && outdated(entry) && !updating(entry)
  const entries = createMemo<Entry[]>(() => {
    const builtins: Entry[] = props.plugins
      .registered()
      .filter((plugin) => plugin.id !== id && plugin.source === "builtin")
      .map((plugin) => ({
        key: `tui:${plugin.id}`,
        runtime: "tui" as const,
        internal: true,
        id: plugin.id,
        target: plugin.id,
        status: plugin.active ? ("active" as const) : ("inactive" as const),
      }))
    const external: Entry[] = props.plugins
      .list()
      .filter((plugin) => plugin.status !== "unsupported")
      .map((plugin) => ({
        key: `tui:${plugin.id ?? plugin.target}`,
        runtime: "tui" as const,
        internal: false,
        id: plugin.id,
        target: plugin.target,
        status: plugin.status,
        error: plugin.status === "failed" ? plugin.error : undefined,
      }))
    const serverEntries: Entry[] = (props.server?.() ?? server() ?? []).map((plugin) => ({
      key: `server:${plugin.id ?? source(plugin, props.context)}`,
      runtime: "server" as const,
      internal: plugin.source.type === "builtin",
      plugin,
    }))
    return [
      ...[...builtins, ...external].sort((a, b) => label(a, props.context).localeCompare(label(b, props.context))),
      ...serverEntries.sort((a, b) => label(a, props.context).localeCompare(label(b, props.context))),
    ]
  })
  const visibleEntries = createMemo(() =>
    entries().filter((entry) => showInternal() || !entry.internal || status(entry) === "failed"),
  )
  createEffect(() => {
    if (visibleEntries().some((entry) => entry.key === focused())) return
    const first = visibleEntries().find((entry) => entry.runtime === "tui") ?? visibleEntries()[0]
    setFocused(first?.key)
  })

  const options = createMemo(() =>
    visibleEntries().map(
      (entry): DialogSelectOption<string> => ({
        title: label(entry, props.context),
        value: entry.key,
        category: entry.runtime === "tui" ? "TUI" : "Server",
        searchText: entry.runtime === "tui" ? entry.target : source(entry.plugin, props.context),
        footer: updating(entry) ? "updating" : footer(entry),
        footerColor:
          status(entry) === "failed"
            ? props.context.theme.text.feedback.error.default
            : outdated(entry)
              ? props.context.theme.text.feedback.info.default
              : props.context.theme.text.subdued,
        gutter: updating(entry)
          ? (color) => <Spinner color={color} />
          : status(entry) === "failed"
            ? () => <text fg={props.context.theme.text.feedback.error.default}>x</text>
            : undefined,
      }),
    ),
  )
  const focusedEntry = createMemo(() => entries().find((entry) => entry.key === focused()))
  const focusedTui = createMemo(() => {
    const entry = focusedEntry()
    if (entry?.runtime !== "tui" || !entry.id) return
    return entry
  })
  const toggleTitle = createMemo(() => {
    const entry = focusedTui()
    if (!entry) return "toggle"
    return props.plugins.registered().find((plugin) => plugin.id === entry.id)?.active ? "disable" : "enable"
  })
  const toggle = (entry: Entry | undefined) => {
    if (locked() || entry?.runtime !== "tui" || !entry.id) return
    const current = props.plugins.registered().find((plugin) => plugin.id === entry.id)
    if (!current) return
    setLocked(true)
    void (current.active ? props.plugins.deactivate(current.id) : props.plugins.activate(current.id))
      .then((ok) => {
        if (ok) return
        props.context.ui.toast.show({ variant: "error", message: `Failed to update plugin ${current.id}` })
      })
      .catch((cause) => {
        props.context.ui.toast.show({
          variant: "error",
          message: cause instanceof Error ? cause.message : String(cause),
        })
      })
      .finally(() => setLocked(false))
  }
  const update = (entry: Entry | undefined) => {
    if (entry?.runtime !== "server" || entry.plugin.source.type !== "package" || !updatable(entry)) return
    const location = props.context.location ?? props.context.data.location.default()
    setPending((keys) => [...keys, entry.key])
    props.context.client.plugin
      .update({
        location,
        targets: [entry.plugin.source.target],
      })
      .then(() => props.context.client.plugin.awaitActivation({ location }))
      .then(() => refetch())
      .catch((cause) => {
        props.context.ui.toast.show({
          variant: "error",
          message: cause instanceof Error ? cause.message : String(cause),
        })
      })
      .finally(() => setPending((keys) => keys.filter((key) => key !== entry.key)))
  }
  // The server only re-checks package sources on startup and then caches the
  // result for a day, so a merge pushed after launch stays invisible until the
  // user asks. The check response carries fresh `outdated` flags for the whole
  // inventory; apply it directly instead of waiting for a `plugin.updated`
  // event, which only fires when a flag actually changes.
  const check = () => {
    if (checking()) return
    setChecking(true)
    props.context.client.plugin
      .check({ location: props.context.location ?? props.context.data.location.default() })
      .then((result) => {
        mutate(result.data)
      })
      .catch((cause) => {
        props.context.ui.toast.show({
          variant: "error",
          message: cause instanceof Error ? cause.message : String(cause),
        })
      })
      .finally(() => setChecking(false))
  }

  return (
    <box>
      <Show
        when={detail()}
        fallback={
          <DialogSelect
            title="Plugins"
            options={options()}
            locked={locked()}
            preserveSelection={true}
            bindings={[
              {
                bind: "ctrl+a",
                title: "Toggle internal plugins",
                group: "Plugins",
                run: () => {
                  setShowInternal((value) => !value)
                },
              },
            ]}
            footerHints={[{ title: "ctrl+a", label: `${showInternal() ? "hide" : "show"} internal` }]}
            onMove={(option) => setFocused(option.value)}
            onSelect={(option) => {
              const entry = entries().find((entry) => entry.key === option.value)
              if (
                entry?.runtime === "tui" &&
                entry.id &&
                props.plugins.registered().some((plugin) => plugin.id === entry.id)
              )
                return toggle(entry)
              if (pluginError(entry)) setDetail(entry)
            }}
            actions={[
              {
                title: checking() ? "checking for updates" : "check for updates",
                command: "dialog.plugins.check",
                selection: "none",
                hidden: !entries().some(
                  (entry) => entry.runtime === "server" && entry.plugin.source.type === "package",
                ),
                disabled: checking(),
                onTrigger: check,
              },
              {
                title: "view error",
                command: "dialog.plugins.error",
                hidden: !pluginError(focusedTui()),
                onTrigger: (option) => {
                  const entry = entries().find((entry) => entry.key === option.value)
                  if (pluginError(entry)) setDetail(entry)
                },
              },
              {
                title: toggleTitle(),
                command: "plugins.toggle",
                side: "right",
                hidden: !focusedTui(),
                onTrigger: (option) => toggle(entries().find((entry) => entry.key === option.value)),
              },
              {
                title: "update",
                command: "dialog.plugins.update",
                side: "right",
                hidden: !updatable(focusedEntry()),
                onTrigger: (option) => update(entries().find((entry) => entry.key === option.value)),
              },
            ]}
            footer={
              <Show when={pluginError(focusedEntry()) && !focusedTui()}>
                <text>
                  <span style={{ fg: props.context.theme.text.default }}>
                    <b>enter</b>
                  </span>
                  <span style={{ fg: props.context.theme.text.subdued }}> view error</span>
                </text>
              </Show>
            }
          />
        }
      >
        {(entry) => (
          <DialogErrorDetails
            title={`${entry().runtime === "tui" ? "TUI" : "Server"} plugin error`}
            source={pluginSource(entry(), props.context)}
            error={pluginError(entry()) ?? "Unknown plugin error"}
            diagnosticRef={pluginErrorRef(entry())}
            context={`Plugin: ${label(entry(), props.context)}\nStatus: failed\nRuntime: ${entry().runtime}\nSource: ${pluginSource(entry(), props.context)}`}
            onBack={() => {
              setDetail()
              dialog.setSize("large")
            }}
          />
        )}
      </Show>
    </box>
  )
}

function label(entry: Entry, context: Plugin.Context) {
  if (entry.runtime === "tui") return entry.id ?? entry.target
  return entry.plugin.id ?? source(entry.plugin, context)
}

function pluginSource(entry: Entry, context: Plugin.Context) {
  if (entry.runtime === "tui") return entry.target
  return source(entry.plugin, context)
}

function source(plugin: PluginInfo, context: Plugin.Context) {
  if (plugin.source.type === "package") return plugin.source.target
  if (plugin.source.type === "local") return context.ui.format.path(plugin.source.path)
  return plugin.source.type
}

function isLocal(entry: Entry) {
  if (entry.runtime === "server") return entry.plugin.source.type === "local"
  const target = entry.target
  return target.startsWith("file://") || target.startsWith("./") || target.startsWith("../") || path.isAbsolute(target)
}

function status(entry: Entry) {
  if (entry.runtime === "server") return entry.plugin.state.status
  return entry.status
}

function outdated(entry: Entry) {
  return entry.runtime === "server" && entry.plugin.source.type === "package" && entry.plugin.source.outdated === true
}

function footer(entry: Entry) {
  const details = [
    ...(status(entry) === "active" ? [] : [status(entry)]),
    ...(isLocal(entry) ? ["local"] : []),
    ...(entry.runtime === "server" && entry.plugin.source.type === "package" && entry.plugin.source.version
      ? [displayVersion(entry.plugin.source.version)]
      : []),
    ...(outdated(entry) ? ["update available"] : []),
  ]
  return details.length ? details.join(", ") : undefined
}

function displayVersion(version: string) {
  return /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(version) ? version.slice(0, 7) : version
}

function pluginError(entry: Entry | undefined) {
  if (entry?.runtime === "server") return entry.plugin.state.status === "failed" ? entry.plugin.state.error : undefined
  return entry?.error
}

function pluginErrorRef(entry: Entry) {
  if (entry.runtime === "server" && entry.plugin.state.status === "failed") return entry.plugin.state.ref
}

function Commands(props: { context: Plugin.Context }) {
  const plugins = usePlugin()
  props.context.keymap.layer(() => ({
    mode: "global",
    commands: [
      {
        id: "plugins.list",
        title: "Plugins",
        group: "System",
        slash: { name: "plugins" },
        palette: true,
        run() {
          props.context.ui.dialog.show(() => <PluginsDialog context={props.context} plugins={plugins} />)
        },
      },
    ],
  }))
  return null
}

export default Plugin.define({
  id,
  setup(context) {
    context.ui.slot({ append: "app", render: () => <Commands context={context} /> })
  },
})
