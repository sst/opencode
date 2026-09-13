import type {
  BrowserPanePlatform,
  BrowserPaneRegistration,
  BrowserPaneState,
  BrowserPaneTarget,
} from "@/runtime/platform/browser-pane"
import type { Browser } from "@opencode/plugin-browser/rpc"

export type BrowserConnectionState = {
  registration?: BrowserPaneRegistration
  browser: BrowserPaneState
  suspended: boolean
  error?: string
}

// Own native registration, retry, and suspended tab metadata independently of the mounted session route.
export function createBrowserConnection(input: {
  pane: BrowserPanePlatform
  target: () => BrowserPaneTarget
  change: (state: BrowserConnectionState) => void
  focus: (tabID: Browser.TabID) => void
}) {
  const state: BrowserConnectionState = { browser: null, suspended: false }
  let disposed = false
  let blocked = false
  let attempts = 0
  let retry: ReturnType<typeof setTimeout> | undefined
  const register = () => {
    if (disposed || blocked || state.registration) return
    clearTimeout(retry)
    const registration = input.pane.register(
      { ...input.target(), ...(state.browser ? { restore: state.browser } : {}) },
      (event) => {
        if (disposed || state.registration !== registration) return
        if (event.type === "focus") return input.focus(event.tabID)
        if (event.error === "browser.pane.unsupported" || event.error === "browser.pane.replaced") {
          blocked = true
          registration.close()
          state.registration = undefined
          state.browser = null
          state.error = event.error
          input.change({ ...state })
          return
        }
        if (event.error === "browser.pane.suspended" || event.error === "browser.pane.registration.closed") {
          registration.close()
          state.registration = undefined
          state.suspended = event.error === "browser.pane.suspended"
          if (state.suspended && event.state) state.browser = event.state
          state.error = undefined
          input.change({ ...state })
          // Idle eviction has no retry timer. A user or Session execution wakes it on demand.
          if (!state.suspended) retry = setTimeout(register, Math.min(30_000, 1_000 * 2 ** attempts++))
          return
        }
        if (event.state) attempts = 0
        state.browser = event.state
        state.error = event.error
        input.change({ ...state })
      },
    )
    state.registration = registration
    state.suspended = false
    state.error = undefined
    input.change({ ...state })
  }
  return {
    wake: register,
    command(command: Browser.Action) {
      register()
      return state.registration?.command(command) ?? Promise.reject(new Error("browser.pane.unavailable"))
    },
    dispose() {
      disposed = true
      clearTimeout(retry)
      state.registration?.close()
      state.registration = undefined
    },
  }
}
