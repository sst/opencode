import { For, Show, createEffect, createMemo, lazy, on, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { makeEventListener } from "@solid-primitives/event-listener"
import { Button } from "@opencode/ui/button"
import { IconButton } from "@opencode/ui/icon-button"
import { TextInput } from "@opencode/ui/text-input"
import { showToast } from "@/shell/notifications/toast"
import fuzzysort from "fuzzysort"
import { DEFAULT_PALETTE_KEYBIND, formatKeybind, parseKeybind, useCommand } from "@/shell/commands/command"
import { useLanguage } from "@/runtime/i18n/language"
import { useSettings } from "@/settings/model"
import { SettingsList } from "@/settings/list"

const Icon = lazy(() => import("@opencode/ui/icon").then((module) => ({ default: module.Icon })))

const IS_MAC = typeof navigator === "object" && /(Mac|iPod|iPhone|iPad)/.test(navigator.platform)
const PALETTE_ID = "command.palette"

type KeybindGroup = "General" | "Session" | "Navigation" | "Model and agent" | "Terminal" | "Prompt"

type KeybindMeta = {
  title: string
  group: KeybindGroup
}

type KeybindMap = Record<string, string | undefined>
type CommandContext = ReturnType<typeof useCommand>
type LanguageContext = ReturnType<typeof useLanguage>
type SettingsContext = ReturnType<typeof useSettings>

const GROUPS: KeybindGroup[] = ["General", "Session", "Navigation", "Model and agent", "Terminal", "Prompt"]

type GroupKey =
  | "settings.shortcuts.group.general"
  | "settings.shortcuts.group.session"
  | "settings.shortcuts.group.navigation"
  | "settings.shortcuts.group.modelAndAgent"
  | "settings.shortcuts.group.terminal"
  | "settings.shortcuts.group.prompt"

const groupKey: Record<KeybindGroup, GroupKey> = {
  General: "settings.shortcuts.group.general",
  Session: "settings.shortcuts.group.session",
  Navigation: "settings.shortcuts.group.navigation",
  "Model and agent": "settings.shortcuts.group.modelAndAgent",
  Terminal: "settings.shortcuts.group.terminal",
  Prompt: "settings.shortcuts.group.prompt",
}

function groupFor(id: string): KeybindGroup {
  if (id === PALETTE_ID) return "General"
  if (id.startsWith("terminal.")) return "Terminal"
  if (id.startsWith("model.") || id.startsWith("agent.") || id.startsWith("mcp.")) return "Model and agent"
  if (id.startsWith("file.") || id.startsWith("fileTree.")) return "Navigation"
  if (id.startsWith("prompt.")) return "Prompt"
  if (
    id.startsWith("session.") ||
    id.startsWith("message.") ||
    id.startsWith("permissions.") ||
    id.startsWith("steps.") ||
    id.startsWith("review.")
  )
    return "Session"

  return "General"
}

function isModifier(key: string) {
  return key === "Shift" || key === "Control" || key === "Alt" || key === "Meta"
}

function normalizeKey(key: string) {
  if (key === ",") return "comma"
  if (key === "+") return "plus"
  if (key === " ") return "space"
  return key.toLowerCase()
}

function recordKeybind(event: KeyboardEvent) {
  if (isModifier(event.key)) return

  const parts: string[] = []

  const mod = IS_MAC ? event.metaKey : event.ctrlKey
  if (mod) parts.push("mod")

  if (IS_MAC && event.ctrlKey) parts.push("ctrl")
  if (!IS_MAC && event.metaKey) parts.push("meta")
  if (event.altKey) parts.push("alt")
  if (event.shiftKey) parts.push("shift")

  const key = normalizeKey(event.key)
  if (!key) return
  parts.push(key)

  return parts.join("+")
}

function signatures(config: string | undefined) {
  if (!config) return []
  const sigs: string[] = []

  for (const kb of parseKeybind(config)) {
    const parts: string[] = []
    if (kb.ctrl) parts.push("ctrl")
    if (kb.alt) parts.push("alt")
    if (kb.shift) parts.push("shift")
    if (kb.meta) parts.push("meta")
    if (kb.key) parts.push(kb.key)
    if (parts.length === 0) continue
    sigs.push(parts.join("+"))
  }

  return sigs
}

function keybinds(value: unknown): KeybindMap {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  return value as KeybindMap
}

function listFor(command: Pick<CommandContext, "catalog" | "options">, map: KeybindMap, palette: string) {
  const out = new Map<string, KeybindMeta>()
  out.set(PALETTE_ID, { title: palette, group: "General" })

  for (const opt of command.catalog) {
    if (opt.id.startsWith("suggested.")) continue
    if (opt.hidden) continue
    out.set(opt.id, { title: opt.title, group: groupFor(opt.id) })
  }

  for (const opt of command.options) {
    if (opt.id.startsWith("suggested.")) continue
    if (opt.hidden) continue
    out.set(opt.id, { title: opt.title, group: groupFor(opt.id) })
  }

  for (const [id, value] of Object.entries(map)) {
    if (typeof value !== "string") continue
    if (out.has(id)) continue
    out.set(id, { title: id, group: groupFor(id) })
  }

  return out
}

function groupedFor(list: Map<string, KeybindMeta>) {
  const out = new Map<KeybindGroup, string[]>()
  for (const group of GROUPS) out.set(group, [])

  for (const [id, item] of list) {
    const ids = out.get(item.group)
    if (!ids) continue
    ids.push(id)
  }

  for (const group of GROUPS) {
    const ids = out.get(group)
    if (!ids) continue
    ids.sort((a, b) => (list.get(a)?.title ?? "").localeCompare(list.get(b)?.title ?? ""))
  }

  return out
}

function filteredFor(
  query: string,
  list: Map<string, KeybindMeta>,
  grouped: Map<KeybindGroup, string[]>,
  keybind: (id: string) => string,
) {
  const value = query.toLowerCase().trim()
  if (!value) return grouped

  const out = new Map<KeybindGroup, string[]>()
  for (const group of GROUPS) out.set(group, [])

  const items = Array.from(list.entries()).map(([id, meta]) => ({
    id,
    title: meta.title,
    group: meta.group,
    keybind: keybind(id),
  }))

  const results = fuzzysort.go(value, items, {
    keys: ["title", "keybind"],
    threshold: -10000,
  })

  for (const result of results) {
    const ids = out.get(result.obj.group)
    if (!ids) continue
    ids.push(result.obj.id)
  }

  return out
}

export function createKeybindSettingsController(
  input: {
    command: Pick<CommandContext, "catalog" | "options" | "keybinds">
    settings: {
      current: { keybinds: unknown }
      keybinds: Pick<SettingsContext["keybinds"], "get" | "set" | "resetAll">
    }
    target?: Document
    notify?: (toast: { title: string; description: string }) => void
  },
  language: Pick<LanguageContext, "locale" | "t"> = useLanguage(),
) {
  const [store, setStore] = createStore({ active: null as string | null })
  const overrides = createMemo(() => keybinds(input.settings.current.keybinds))
  const list = createMemo(() => {
    language.locale()
    return listFor(input.command, overrides(), language.t("command.palette"))
  })
  const grouped = createMemo(() => groupedFor(list()))
  const title = (id: string) => list().get(id)?.title ?? ""
  const effective = (id: string) => {
    if (id === PALETTE_ID) return input.settings.keybinds.get(id) ?? DEFAULT_PALETTE_KEYBIND

    const custom = input.settings.keybinds.get(id)
    if (typeof custom === "string") return custom

    const live = input.command.options.find((item) => item.id === id)
    if (live?.keybind) return live.keybind
    return input.command.catalog.find((item) => item.id === id)?.keybind
  }
  const used = createMemo(() => {
    const value = new Map<string, { id: string; title: string }[]>()

    for (const id of list().keys()) {
      for (const signature of signatures(effective(id))) {
        const items = value.get(signature)
        if (items) {
          items.push({ id, title: title(id) })
          continue
        }
        value.set(signature, [{ id, title: title(id) }])
      }
    }

    return value
  })
  const stop = () => {
    if (!store.active) return
    setStore("active", null)
    input.command.keybinds(true)
  }
  const toggle = (id: string) => {
    if (store.active === id) {
      stop()
      return
    }
    if (store.active) stop()
    setStore("active", id)
    input.command.keybinds(false)
  }
  const notify = input.notify ?? ((toast: { title: string; description: string }) => showToast(toast))

  const handle = (event: KeyboardEvent) => {
    const id = store.active
    if (!id) return

    event.preventDefault()
    event.stopPropagation()
    event.stopImmediatePropagation()

    if (event.key === "Escape") {
      stop()
      return
    }

    const clear =
      (event.key === "Backspace" || event.key === "Delete") &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey &&
      !event.shiftKey
    if (clear) {
      input.settings.keybinds.set(id, "none")
      stop()
      return
    }

    const next = recordKeybind(event)
    if (!next) return

    const conflicts = new Map<string, string>()
    for (const signature of signatures(next)) {
      for (const item of used().get(signature) ?? []) {
        if (item.id === id) continue
        conflicts.set(item.id, item.title)
      }
    }

    if (conflicts.size > 0) {
      notify({
        title: language.t("settings.shortcuts.conflict.title"),
        description: language.t("settings.shortcuts.conflict.description", {
          keybind: formatKeybind(next, language.t),
          titles: [...conflicts.values()].join(", "),
        }),
      })
      return
    }

    input.settings.keybinds.set(id, next)
    stop()
  }

  const target = input.target ?? (typeof document === "object" ? document : undefined)
  if (target) makeEventListener(target, "keydown", handle, { capture: true })

  onCleanup(() => {
    if (store.active) input.command.keybinds(true)
  })

  return {
    catalog: {
      groups: GROUPS,
      filtered: (query: string) =>
        filteredFor(query, list(), grouped(), (id) => formatKeybind(effective(id) ?? "", language.t)),
      title,
      keybind: (id: string) => formatKeybind(effective(id) ?? "", language.t),
    },
    capture: {
      active: () => store.active,
      toggle,
    },
    settings: {
      hasOverrides: () => Object.values(overrides()).some((value) => typeof value === "string"),
      reset: () => {
        stop()
        input.settings.keybinds.resetAll()
        notify({
          title: language.t("settings.shortcuts.reset.toast.title"),
          description: language.t("settings.shortcuts.reset.toast.description"),
        })
      },
    },
  }
}

export function SettingsKeybinds(props: { active?: boolean; autofocus?: boolean }) {
  const command = useCommand()
  const settings = useSettings()
  const controller = createKeybindSettingsController({
    command,
    settings,
  })

  return (
    <SettingsKeybindsView
      visible={props.active}
      autofocus={props.autofocus}
      groups={controller.catalog.groups}
      filtered={controller.catalog.filtered}
      title={controller.catalog.title}
      keybind={controller.catalog.keybind}
      active={controller.capture.active()}
      onCapture={controller.capture.toggle}
      hasOverrides={controller.settings.hasOverrides()}
      onReset={controller.settings.reset}
    />
  )
}

function SettingsKeybindsView(props: {
  visible?: boolean
  autofocus?: boolean
  groups: KeybindGroup[]
  filtered: (query: string) => Map<KeybindGroup, string[]>
  title: (id: string) => string
  keybind: (id: string) => string
  active: string | null
  onCapture: (id: string) => void
  hasOverrides: boolean
  onReset: () => void
}) {
  const language = useLanguage()
  let search: HTMLInputElement | undefined
  createEffect(
    on(
      () => props.visible ?? true,
      (visible) => {
        if (!visible) return
        const frame = requestAnimationFrame(() => {
          if (props.visible !== false && props.autofocus !== false && search?.isConnected)
            search.focus({ preventScroll: true })
        })
        onCleanup(() => cancelAnimationFrame(frame))
      },
    ),
  )
  const [store, setStore] = createStore({ filter: "" })
  const filtered = createMemo(() => props.filtered(store.filter))
  const hasResults = createMemo(() => props.groups.some((group) => (filtered().get(group)?.length ?? 0) > 0))

  return (
    <>
      <div class="settings-tab-header settings-tab-header--stacked">
        <div class="settings-tab-header-row">
          <div class="flex flex-col gap-1">
            <h2 class="settings-tab-title">{language.t("settings.shortcuts.title")}</h2>
            <span class="text-11-regular text-v2-text-text-muted">{language.t("settings.shortcuts.description")}</span>
          </div>
          <Button variant="ghost" onClick={props.onReset} disabled={!props.hasOverrides}>
            {language.t("settings.shortcuts.reset.button")}
          </Button>
        </div>
        <div class="settings-tab-search">
          <TextInput
            ref={search}
            type="search"
            appearance="base"
            value={store.filter}
            onInput={(event) => setStore("filter", event.currentTarget.value)}
            placeholder={language.t("settings.shortcuts.search.placeholder")}
            spellcheck={false}
            autocorrect="off"
            autocomplete="off"
            autocapitalize="off"
            aria-label={language.t("settings.shortcuts.search.placeholder")}
          />
          <Show when={store.filter}>
            <IconButton
              type="button"
              variant="ghost-muted"
              size="small"
              class="settings-tab-search-clear"
              icon={<Icon name="close" size="large" class="text-v2-icon-icon-muted" />}
              onClick={() => setStore("filter", "")}
            />
          </Show>
        </div>
      </div>
      <div class="settings-tab-body">
        <div class="settings-shortcuts settings-section-stack">
          <For each={props.groups}>
            {(group) => (
              <Show when={(filtered().get(group) ?? []).length > 0}>
                <div class="settings-section">
                  <h3 class="settings-section-title">{language.t(groupKey[group])}</h3>
                  <SettingsList>
                    <For each={filtered().get(group) ?? []}>
                      {(id) => (
                        <div class="flex items-center justify-between gap-4 py-3 border-b border-border-weak-base last:border-none">
                          <span>{props.title(id)}</span>
                          <button
                            type="button"
                            data-keybind-id={id}
                            classList={{
                              "settings-keybind-button": true,
                              "settings-keybind-button--active": props.active === id,
                            }}
                            onClick={() => props.onCapture(id)}
                          >
                            <Show
                              when={props.active === id}
                              fallback={props.keybind(id) || language.t("settings.shortcuts.unassigned")}
                            >
                              {language.t("settings.shortcuts.pressKeys")}
                            </Show>
                          </button>
                        </div>
                      )}
                    </For>
                  </SettingsList>
                </div>
              </Show>
            )}
          </For>
          <Show when={store.filter && !hasResults()}>
            <div class="settings-shortcuts-status">
              <span>{language.t("settings.shortcuts.search.empty")}</span>
              <span class="settings-shortcuts-status-filter">&quot;{store.filter}&quot;</span>
            </div>
          </Show>
        </div>
      </div>
    </>
  )
}
