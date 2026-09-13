import { PluginContextProvider } from "@opencode/plugin/tui"
import type { JSX } from "solid-js"
import type { Context, Dialog, Page, SlotClaim, SlotMap, SlotPath, Toast } from "@opencode/plugin/tui/context"
import type { Placement, PlacementKind } from "./structure"
import { infoStringToFiletype, type MarkdownCodeBlockRenderer } from "@opentui/core"
import { useRenderer } from "@opentui/solid"
import { useClient } from "../context/client"
import { useData } from "../context/data"
import { Keymap } from "../context/keymap"
import { useRoute } from "../context/route"
import { useTuiApp, useTuiPaths } from "../context/runtime"
import { useLocation } from "../context/location"
import { useThemes } from "../context/theme"
import { DialogAlert } from "../ui/dialog-alert"
import { DialogConfirm } from "../ui/dialog-confirm"
import { DialogPrompt } from "../ui/dialog-prompt"
import { DialogSelect } from "../ui/dialog-select"
import { useDialog } from "../ui/dialog"
import { useToast } from "../ui/toast"
import { useAttention } from "../context/attention"
import { useStorage } from "../context/storage"
import { useSessionTabs } from "../context/session-tabs"
import { useOptionalPanel } from "../context/panel"
import { abbreviateHome } from "../util/path-format"

export type Dispose = () => Promise<void>

// Slot inputs erased to their union: the registry stores one render shape
// regardless of which path a claim targets.
export type SlotRender = (input: SlotMap[SlotPath]) => JSX.Element

// A registered claim as stored by the plugin provider's registry.
export type RegisteredSlot = {
  readonly placement: Placement
  readonly render: SlotRender
}

const placements = ["prepend", "append", "before", "after", "replace"] as const satisfies readonly PlacementKind[]

// The provider's registration store, narrowed to what a plugin context needs:
// route/slot registration lands there, but ordering and lifecycle stay owned
// by the provider.
export type Registry = {
  has(kind: "routes" | "slots" | "markdown", name: string): boolean
  set(kind: "routes", name: string, page: Page): void
  set(kind: "slots", name: string, claim: RegisteredSlot): void
  set(kind: "markdown", name: string, render: MarkdownCodeBlockRenderer): void
  remove(kind: "routes" | "slots" | "markdown", name: string): void
  active(): boolean
}

// The host services a plugin context adapts. Collected once by the provider
// (hooks must run during component setup) and shared by every activation.
export function usePluginHost() {
  return {
    renderer: useRenderer(),
    client: useClient(),
    data: useData(),
    route: useRoute(),
    keymap: Keymap.use(),
    shortcuts: Keymap.useShortcuts(),
    keymapState: Keymap.useState(),
    app: useTuiApp(),
    paths: useTuiPaths(),
    location: useLocation(),
    themes: useThemes(),
    dialog: useDialog(),
    toast: useToast(),
    attention: useAttention(),
    storage: useStorage(),
    sessionTabs: useSessionTabs(),
    panel: useOptionalPanel(),
  }
}

// Build the API surface handed to one plugin activation: host services
// adapted to the plugin contract, with everything registered through it
// unwinding via `owned` when the activation is disposed.
export function createPluginContext(input: {
  host: ReturnType<typeof usePluginHost>
  id: string
  options: Readonly<Record<string, any>> | undefined
  owned: Dispose[]
  registry: Registry
}): Context {
  const host = input.host
  input.owned.push(async () => host.panel?.release(input.id))
  let context: Context
  let claims = 0
  // Every dialog and registered render is wrapped so plugin components can
  // reach their own context through usePlugin().
  const provide = (render: () => JSX.Element) => (
    <PluginContextProvider value={context}>{render()}</PluginContextProvider>
  )
  const dialogApi = createDialogApi(host.dialog, provide)
  const toastApi: Toast = {
    show(options) {
      host.toast.show({ ...options, variant: options.variant ?? "info" })
    },
  }
  // Unregistering after deactivation is a no-op: deactivate already resets
  // the registration's routes and slots wholesale.
  const registration = (kind: "routes" | "slots" | "markdown", name: string) => {
    let registered = true
    const unregister = () => {
      if (!registered) return
      registered = false
      if (!input.registry.active()) return
      input.registry.remove(kind, name)
    }
    input.owned.push(async () => unregister())
    return unregister
  }
  context = {
    options: input.options ?? {},
    get location() {
      return host.location.current
    },
    app: { version: host.app.version, channel: host.app.channel },
    renderer: host.renderer,
    client: host.client.api,
    data: host.data,
    attention: host.attention,
    get theme() {
      return host.themes.currentTokens()
    },
    get themeMode() {
      return host.themes.mode()
    },
    markdown: {
      registerCodeBlockRenderer(language, render) {
        const name = infoStringToFiletype(language)
        if (!name) throw new Error("Markdown code-block language is required")
        if (input.registry.has("markdown", name)) {
          throw new Error(`Markdown code-block renderer already registered: ${name}`)
        }
        input.registry.set("markdown", name, render)
        return registration("markdown", name)
      },
    },
    keymap: {
      layer: Keymap.createLayer,
      dispatch: host.keymap.dispatch,
      shortcuts: host.shortcuts.list,
      commands: host.keymapState.commands,
      pending: host.keymapState.pending,
      active: host.keymapState.active,
      mode: host.keymap.mode,
    },
    storage: {
      store: (key, options) => host.storage.store(`plugin.${input.id}.${key}`, options),
      memory: (key, options) => host.storage.memory(`plugin.${input.id}.${key}`, options),
    },
    ui: {
      dialog: dialogApi,
      toast: toastApi,
      format: {
        path: (value) => abbreviateHome(value, host.paths.home),
      },
      router: {
        register(page) {
          if (input.registry.has("routes", page.name)) throw new Error(`Route already registered: ${page.name}`)
          input.registry.set("routes", page.name, {
            ...page,
            render: (data) => provide(() => page.render(data)),
          })
          return registration("routes", page.name)
        },
        navigate(destination) {
          if (destination.type === "plugin") {
            host.route.navigate({ ...destination, id: "id" in destination ? destination.id : input.id })
            return
          }
          host.route.navigate(destination)
        },
        current() {
          return host.route.data
        },
      },
      panel: {
        open(name, options) {
          if (!host.panel || !input.registry.active()) return false
          const route = host.route.data
          if (route.type !== "session") return false
          host.panel.open({ plugin: input.id, name, sessionID: route.sessionID }, options?.presentation)
          return true
        },
        close: () => host.panel?.release(input.id),
        current() {
          const current = host.panel?.current()
          if (current?.plugin !== input.id) return
          return { name: current.name, sessionID: current.sessionID }
        },
      },
      tabs: {
        enabled: host.sessionTabs.enabled,
        list: () =>
          host.sessionTabs.tabs().map((tab) => {
            const status = host.sessionTabs.status(tab.sessionID)
            return {
              ...tab,
              active: host.sessionTabs.current() === tab.sessionID,
              ...status,
              attention: Boolean(status.attention),
            }
          }),
        open(sessionID) {
          if (!host.sessionTabs.enabled()) return false
          host.sessionTabs.open(sessionID)
          return true
        },
        focus(sessionID) {
          if (!host.sessionTabs.enabled()) return false
          host.sessionTabs.select(sessionID)
          return true
        },
        move(sessionID, index) {
          if (!host.sessionTabs.enabled()) return false
          const target = host.data.session.root(sessionID)
          if (!host.sessionTabs.tabs().some((tab) => tab.sessionID === target)) return false
          host.sessionTabs.move(target, index)
          return true
        },
        close(sessionID) {
          if (!host.sessionTabs.enabled()) return false
          const target = sessionID ?? host.sessionTabs.current()
          if (!target || !host.sessionTabs.tabs().some((tab) => tab.sessionID === target)) return false
          host.sessionTabs.close(target)
          return true
        },
      },
      slot(value: SlotClaim) {
        // Keys are counter-suffixed so one plugin may claim several places;
        // order within the plugin is registration order.
        const key = `slot#${claims++}`
        // Exactly one placement kind, enforced at runtime for untyped plugins.
        const kinds = placements.filter((item) => value[item] !== undefined)
        if (kinds.length !== 1) throw new Error("Slot claim requires exactly one placement key")
        const kind = kinds[0]
        input.registry.set("slots", key, {
          placement: { kind, target: value[kind] as string },
          // The registration map erases the path-specific input type.
          render: (slotInput) => provide(() => (value.render as SlotRender)(slotInput)),
        })
        return registration("slots", key)
      },
    },
  }
  return context
}

// A dialog promise must settle exactly once even when confirm and close
// callbacks both fire.
function settle<T>(resolve: (value: T) => void) {
  let settled = false
  return (value: T) => {
    if (settled) return
    settled = true
    resolve(value)
  }
}

export function createDialogApi(
  dialog: ReturnType<typeof useDialog>,
  provide: (render: () => JSX.Element) => JSX.Element,
) {
  const api: Dialog = {
    show(render, onClose) {
      dialog.replace(() => provide(render), onClose)
    },
    set(options) {
      dialog.setSize(options.size ?? "medium")
      dialog.setCentered(options.centered ?? false)
    },
    clear() {
      dialog.clear()
    },
    alert(options) {
      return new Promise<void>((resolve) => {
        const done = settle(resolve)
        api.show(() => <DialogAlert title={options.title} message={options.message} onConfirm={done} />, done)
      })
    },
    confirm(options) {
      return new Promise<boolean | undefined>((resolve) => {
        const done = settle(resolve)
        api.show(
          () => (
            <DialogConfirm
              title={options.title}
              message={options.message}
              label={options.label}
              onConfirm={() => done(true)}
              onCancel={() => done(false)}
            />
          ),
          () => done(undefined),
        )
      })
    },
    prompt(options) {
      return new Promise<string | undefined>((resolve) => {
        const done = settle(resolve)
        api.show(
          () => (
            <DialogPrompt
              title={options.title}
              description={options.description ? () => <text>{options.description}</text> : undefined}
              placeholder={options.placeholder}
              value={options.value}
              onConfirm={(value) => {
                done(value)
                api.clear()
              }}
            />
          ),
          () => done(undefined),
        )
      })
    },
    select(options) {
      return new Promise((resolve) => {
        const done = settle<(typeof options.options)[number]["value"] | undefined>(resolve)
        api.show(
          () => (
            <DialogSelect
              title={options.title}
              placeholder={options.placeholder}
              options={options.options.map((option) => ({ ...option }))}
              current={options.current}
              onSelect={(option) => {
                done(option.value)
                api.clear()
              }}
            />
          ),
          () => done(undefined),
        )
      })
    },
  }
  return api
}
