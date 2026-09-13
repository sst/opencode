import type { SettingsView } from "./surface"

/** Reveal one explicit search activation, including targets mounted by an asynchronous scoped page. */
export function revealSettingsSearch(root: HTMLElement, view: SettingsView) {
  const state = { disposed: false, row: undefined as HTMLElement | undefined, tabIndex: null as string | null }
  const restore = () => {
    const row = state.row
    if (!row) return
    row.removeAttribute("data-search-target")
    if (state.tabIndex === null) row.removeAttribute("tabindex")
    if (state.tabIndex !== null) row.setAttribute("tabindex", state.tabIndex)
    state.row = undefined
  }
  const finish = (event: AnimationEvent) => {
    if (event.target === state.row && event.animationName === "settings-search-reveal") restore()
  }
  const reveal = () => {
    if (state.disposed) return true
    const panel = root.querySelector<HTMLElement>(".settings-panel:not([hidden])")
    const control = panel?.querySelector<HTMLElement>(
      view.target ? `[data-action="${CSS.escape(view.target)}"]` : ".settings-tab-header-row, .settings-about-intro",
    )
    if (!panel || !control || !control.getClientRects().length) return false
    const row =
      control.closest<HTMLElement>('[data-component="settings-row"], [data-component="settings-list"] > *') ?? control
    if (!view.target) panel.scrollTop = 0
    if (view.target) row.scrollIntoView({ block: "center", inline: "nearest" })
    state.row = row
    state.tabIndex = row.getAttribute("tabindex")
    row.setAttribute("data-search-target", view.target ? "row" : "header")
    // Selecting another result can reuse the same header before the browser paints the removal.
    row.getAnimations({ subtree: true }).forEach((animation) => {
      if (!(animation instanceof CSSAnimation) || animation.animationName !== "settings-search-reveal") return
      animation.currentTime = 0
      animation.play()
    })
    if (view.type !== "root") {
      const focus = view.target ? row : (panel.querySelector<HTMLInputElement>(".settings-tab-search input") ?? row)
      if (focus === row) row.tabIndex = -1
      focus.focus({ preventScroll: true })
    }
    return true
  }
  const observer = new MutationObserver(() => {
    if (reveal()) observer.disconnect()
  })
  root.addEventListener("animationend", finish)
  queueMicrotask(() => {
    if (!reveal())
      observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["hidden", "class"] })
  })
  return () => {
    state.disposed = true
    observer.disconnect()
    root.removeEventListener("animationend", finish)
    restore()
  }
}
