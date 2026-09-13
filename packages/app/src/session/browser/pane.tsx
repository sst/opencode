import { Icon } from "@opencode/ui/icon"
import { IconButton } from "@opencode/ui/icon-button"
import { Loader } from "@opencode/ui/loader"
import { Keybind } from "@opencode/ui/keybind"
import { Tooltip } from "@opencode/ui/tooltip"
import { useDialog } from "@opencode/ui/context/dialog"
import { createEventListener } from "@solid-primitives/event-listener"
import { createResizeObserver } from "@solid-primitives/resize-observer"
import { createEffect, For, on, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/runtime/i18n/language"
import { usePlatform } from "@/runtime/platform/platform"
import { useCommand } from "@/shell/commands/command"
import type { createSessionBrowser } from "./model"

export function SessionBrowserPane(props: { browser: ReturnType<typeof createSessionBrowser>; visible: boolean }) {
  const platform = usePlatform()
  const language = useLanguage()
  const dialog = useDialog()
  const command = useCommand()
  const state = props.browser.active
  const address = () => (state()?.url === "about:blank" ? "" : (state()?.url ?? ""))
  const registration = props.browser.registration
  const button = { variant: "ghost", size: "large" } as const
  const [store, setStore] = createStore({
    address: "",
    editing: false,
    visible: typeof document === "undefined" || document.visibilityState === "visible",
  })
  let surface: HTMLDivElement | undefined
  let addressDisplay: HTMLDivElement | undefined
  let frame: number | undefined
  let layout: string | undefined
  let until = 0
  const canvas = document.createElement("canvas")
  canvas.width = canvas.height = 1
  const paint = canvas.getContext("2d", { willReadFrequently: true })
  const scheme = () => store.address.match(/^https?:\/\//i)?.[0] ?? ""

  command.register("browser.navigation", () => [
    {
      id: "browser.reload",
      title: language.t("command.browser.reload"),
      category: language.t("command.category.view"),
      keybind: "f5",
      disabled: !props.visible || !state(),
      onSelect: () => {
        const tab = state()
        if (tab) props.browser.command({ type: "reload", tabID: tab.id })
      },
    },
  ])

  // The native page always paints above the DOM, so hide it while a floating
  // menu, select, or popover overlaps it. Tooltips are excluded.
  const covered = (rect: DOMRect) =>
    Array.from(document.querySelectorAll('[data-popper-positioner]:not(:has([role="tooltip"]))')).some((el) => {
      const r = el.getBoundingClientRect()
      return r.width > 0 && r.left < rect.right && r.right > rect.left && r.top < rect.bottom && r.bottom > rect.top
    })
  const measure = () => {
    if (!surface) return
    const tab = state()
    if (!tab) {
      registration()?.setLayout()
      return
    }
    const rect = surface.getBoundingClientRect()
    const zoom = platform.webviewZoom?.() ?? 1
    const left = Math.round(rect.left * zoom)
    const top = Math.round(rect.top * zoom)
    const right = Math.round(rect.right * zoom)
    const bottom = Math.round(rect.bottom * zoom)
    const visible = props.visible && store.visible && !dialog.active && !covered(rect)
    // The cutout exposes the app backdrop outside the rounded Review card,
    // not the browser surface inside it.
    const color = getComputedStyle(
      surface.closest(".bg-v2-background-bg-deep") ?? document.documentElement,
    ).backgroundColor
    const next = `${tab.id}:${visible}:${left}:${top}:${right}:${bottom}:${color}:${window.devicePixelRatio}`
    if (next !== layout) {
      layout = next
      // Let the browser resolve the semantic backdrop color, including custom
      // themes using color formats that Electron's color parser cannot read.
      if (paint) {
        paint.clearRect(0, 0, 1, 1)
        paint.fillStyle = color
        paint.fillRect(0, 0, 1, 1)
      }
      const rgba = paint?.getImageData(0, 0, 1, 1).data
      registration()?.setLayout({
        tabID: tab.id,
        visible,
        bounds: { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) },
        background: rgba ? [rgba[0], rgba[1], rgba[2], rgba[3]] : undefined,
        radius: Math.round(10 * zoom),
      })
    }
  }
  const tick = () => {
    frame = undefined
    measure()
    if (performance.now() < until) frame = requestAnimationFrame(tick)
  }
  const schedule = (duration = 0) => {
    until = Math.max(until, performance.now() + duration)
    if (frame === undefined) frame = requestAnimationFrame(tick)
  }

  createEffect(() => !store.editing && setStore("address", address()))
  createEffect(
    on(registration, (current) => {
      // Session routes can change before this pane unmounts. Hide the registration
      // that owned the native view, rather than reading the destination's handle.
      onCleanup(() => current?.setLayout())
    }),
  )
  createEffect(
    on(
      [
        () => platform.webviewZoom?.(),
        () => dialog.active,
        () => store.visible,
        () => props.visible,
        () => state()?.id,
        registration,
      ],
      () => {
        layout = undefined
        schedule(300)
      },
    ),
  )
  // ResizeObserver runs after layout in the same frame; measuring here instead of on the next
  // animation frame keeps the native view in step with a pane drag.
  createResizeObserver(() => surface, measure)
  createEventListener(window, "resize", () => schedule(300))
  // Floating content portals directly into <body>; keep measuring briefly so
  // the positioner has settled before the overlap check runs.
  const portals = new MutationObserver(() => schedule(300))
  portals.observe(document.body, { childList: true })
  onCleanup(() => portals.disconnect())
  const appearance = new MutationObserver(() => schedule(300))
  appearance.observe(document.documentElement, { attributes: true, attributeFilter: ["style", "data-theme"] })
  onCleanup(() => appearance.disconnect())
  createEventListener(window.matchMedia("(prefers-color-scheme: dark)"), "change", () => schedule(300))
  createEventListener(document, "visibilitychange", () => setStore("visible", document.visibilityState === "visible"))
  onCleanup(() => {
    if (frame !== undefined) cancelAnimationFrame(frame)
  })

  return (
    <aside id="browser-panel" class="relative size-full min-w-0 overflow-hidden bg-v2-background-bg-base flex flex-col">
      <div class="h-10 shrink-0 flex items-center gap-1 px-2 border-b border-v2-border-border-muted">
        <For each={["back", "forward"] as const}>
          {(direction) => (
            <Tooltip placement="top" value={language.t(direction === "back" ? "common.goBack" : "common.goForward")}>
              <IconButton
                {...button}
                disabled={!state()?.[direction === "back" ? "canGoBack" : "canGoForward"]}
                aria-label={language.t(direction === "back" ? "common.goBack" : "common.goForward")}
                onClick={() => {
                  const tab = state()
                  if (tab) props.browser.command({ type: direction, tabID: tab.id })
                }}
                icon={
                  <Icon
                    name={direction === "back" ? "chevron-left" : "chevron-right"}
                    size="small"
                    class="rtl:rotate-180"
                  />
                }
              />
            </Tooltip>
          )}
        </For>
        <Tooltip
          placement="top"
          value={
            <div class="flex items-center gap-2">
              <span>{language.t(state()?.loading ? "prompt.action.stop" : "error.page.action.reload")}</span>
              <Show when={!state()?.loading}>
                <Keybind keys={command.keybindParts("browser.reload")} variant="neutral" />
              </Show>
            </div>
          }
        >
          <IconButton
            {...button}
            disabled={!state()}
            aria-label={language.t(state()?.loading ? "prompt.action.stop" : "error.page.action.reload")}
            onClick={() => {
              const tab = state()
              if (tab) props.browser.command({ type: tab.loading ? "stop" : "reload", tabID: tab.id })
            }}
            icon={
              <Show when={state()?.loading} fallback={<Icon name="refresh" size="small" />}>
                <Loader />
              </Show>
            }
          />
        </Tooltip>
        <form
          dir="ltr"
          class="relative min-w-0 flex-1 h-7 rounded-md hover:bg-v2-overlay-simple-overlay-hover focus-within:bg-v2-overlay-simple-overlay-hover text-12-regular"
          onSubmit={(event) => {
            event.preventDefault()
            const tab = state()
            if (tab && store.address.trim())
              props.browser.command({ type: "navigate", tabID: tab.id, url: store.address })
          }}
        >
          <input
            class="w-full h-full px-2 rounded-md border border-transparent bg-transparent text-transparent caret-v2-text-text-base placeholder:text-v2-text-text-faint outline-none focus:border-v2-border-border-focus"
            spellcheck={false}
            autocomplete="off"
            value={store.address}
            disabled={!state()}
            placeholder={language.t("session.browser.address.placeholder")}
            aria-label={language.t("session.browser.address")}
            onFocus={() => setStore("editing", true)}
            onBlur={() => setStore({ editing: false, address: address() })}
            onInput={(event) => setStore("address", event.currentTarget.value)}
            onScroll={(event) => {
              if (addressDisplay) addressDisplay.scrollLeft = event.currentTarget.scrollLeft
            }}
          />
          {/* Keep native input editing and selection while coloring the scheme, including during editing. */}
          <div
            aria-hidden="true"
            class="absolute inset-0 flex items-center px-2 border border-transparent pointer-events-none"
          >
            <div ref={addressDisplay} class="w-full overflow-hidden whitespace-pre text-v2-text-text-base">
              <span class="text-v2-text-text-muted">{scheme()}</span>
              {store.address.slice(scheme().length)}
            </div>
          </div>
        </form>
      </div>
      <Show when={props.browser.error()}>
        <div class="shrink-0 px-3 py-1.5 text-12-regular text-text-danger-base border-b border-v2-border-border-muted">
          {props.browser.error()}
        </div>
      </Show>
      <div ref={surface} class="min-h-0 flex-1 bg-v2-background-bg-base flex items-center justify-center">
        <Show when={props.browser.suspended()}>
          <p class="px-6 text-center text-13-regular text-v2-text-text-subtle" role="status">
            {language.t("session.browser.suspended")}
          </p>
        </Show>
      </div>
    </aside>
  )
}
