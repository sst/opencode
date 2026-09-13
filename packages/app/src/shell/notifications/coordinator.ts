import { onCleanup } from "solid-js"

const FOCUS_LOCK = "opencode:notification-focus"
const MAX_CLAIMED = 500

export function createNotificationCoordinator() {
  const locks = typeof navigator === "undefined" ? undefined : navigator.locks
  const claimed = new Set<string>()
  const focus = { pending: false, release: undefined as (() => void) | undefined }

  const updateFocus = () => {
    if (typeof document === "undefined" || !document.hasFocus()) {
      focus.release?.()
      return
    }
    if (!locks || focus.pending || focus.release) return

    focus.pending = true
    void locks
      .request(FOCUS_LOCK, { mode: "shared" }, async () => {
        focus.pending = false
        if (!document.hasFocus()) return
        await new Promise<void>((resolve) => {
          focus.release = resolve
        })
        focus.release = undefined
      })
      .catch(() => {
        focus.pending = false
      })
  }

  if (typeof window !== "undefined") {
    window.addEventListener("focus", updateFocus)
    window.addEventListener("blur", updateFocus)
    document.addEventListener("visibilitychange", updateFocus)
    updateFocus()
    onCleanup(() => {
      window.removeEventListener("focus", updateFocus)
      window.removeEventListener("blur", updateFocus)
      document.removeEventListener("visibilitychange", updateFocus)
      focus.release?.()
    })
  }

  const once = async (kind: "sound" | "system", eventID: string, run: () => Promise<unknown> | void) => {
    const key = `${kind}:${eventID}`
    const execute = async () => {
      if (!claim(kind, key, claimed)) return
      await run()
    }
    if (!locks) return execute()
    await locks.request(`opencode:notification:${key}`, execute)
  }

  return {
    sound(eventID: string, run: () => Promise<unknown> | void) {
      return once("sound", eventID, run)
    },
    system(eventID: string, run: () => Promise<unknown> | void) {
      return once("system", eventID, async () => {
        if (typeof document !== "undefined" && document.hasFocus()) return
        if (!locks) return run()
        await locks.request(FOCUS_LOCK, { mode: "exclusive", ifAvailable: true }, async (lock) => {
          if (!lock) return
          await run()
        })
      })
    },
  }
}

function claim(kind: "sound" | "system", eventID: string, claimed: Set<string>) {
  if (claimed.has(eventID)) return false

  if (typeof localStorage !== "undefined") {
    try {
      const storageKey = `opencode:notification-${kind}`
      const value: unknown = JSON.parse(localStorage.getItem(storageKey) ?? "[]")
      const events = Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
      if (events.includes(eventID)) {
        claimed.add(eventID)
        return false
      }
      localStorage.setItem(storageKey, JSON.stringify([...events, eventID].slice(-MAX_CLAIMED)))
    } catch {
      // The in-memory claim still prevents duplicates in this renderer when storage is unavailable.
    }
  }

  claimed.add(eventID)
  return true
}
