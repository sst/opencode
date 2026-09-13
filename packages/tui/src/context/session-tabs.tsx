import { createEffect, createMemo, createSignal, on, onCleanup } from "solid-js"
import { useKeyboard, useRenderer } from "@opentui/solid"
import { isDeepEqual } from "remeda"
import { createSimpleContext } from "./helper"
import { useClient } from "./client"
import { locationKey, useData } from "./data"
import { withTimestampedFallback } from "@opencode/util/session-title-fallback"
import { useEvent } from "./event"
import { useRoute } from "./route"
import { useConfig } from "../config"
import { useLocation } from "./location"
import { useStorage } from "./storage"
import { useTuiPaths } from "./runtime"
import { newSessionLocation } from "../config/new-session-location"
import { createSessionRetention } from "./session-retention"
import {
  closeSessionTab,
  cycleSessionTab,
  moveSessionTab,
  moveSessionTabHistory,
  NEW_SESSION_TAB_TITLE,
  openSessionTab,
  recordClosedSessionTab,
  recordSessionTabHistory,
  reopenSessionTab,
  type ClosedSessionTab,
  type SessionTab,
  type SessionTabHistory,
} from "./session-tabs-model"

type TabsState = {
  tabs: SessionTab[]
  // Kept empty for rollback compatibility with clients that still read this field.
  unread: Record<string, unknown>
}

type PersistedState = {
  global: TabsState
  cwd: Record<string, TabsState>
}

type ScrollAnchor = {
  messageID: string
  screenY: number
}

const empty = (): TabsState => ({ tabs: [], unread: {} })

// Deliberately after connect settles: the visible session's mount syncs win the first slots.
const TAB_PREFETCH_DELAY = 300
const VIEW_RETRY_DELAY = 250
const VIEW_RETRY_MAX_DELAY = 5_000

export const { use: useSessionTabs, provider: SessionTabsProvider } = createSimpleContext({
  name: "SessionTabs",
  init: () => {
    const route = useRoute()
    const client = useClient()
    const data = useData()
    const event = useEvent()
    const config = useConfig().data
    const location = useLocation()
    const paths = useTuiPaths()
    const renderer = useRenderer()
    const storage = useStorage()
    const enabled = () => config.tabs.enabled
    const [focused, setFocused] = createSignal<boolean>()
    // Keyed reconcile keeps tab object identity across reorders, so strip rows move instead of
    // mutating in place, which per-row animations and drag state depend on.
    const [store, updateStore] = storage.store<PersistedState>("tabs", {
      initial: {
        global: empty(),
        cwd: {},
      },
      key: "sessionID",
    })
    const fallback = empty()
    const [promptPulses, setPromptPulses] = createSignal<Record<string, number>>({})
    let history: SessionTabHistory = { entries: [], index: -1 }
    // User-closed tabs eligible for reopening; in-memory like history, deleted sessions pruned.
    let closedTabs: ClosedSessionTab[] = []
    // Storage mutations apply against the on-disk draft under a file lock, so
    // a registration queued by the route effect can land AFTER a removal that
    // ran while the write was still in flight — resurrecting a tab that was
    // just closed. Removing a tab marks it cancelled so any late-applying
    // registration becomes a no-op; navigating to the session again clears
    // the mark.
    const cancelledTabs = new Set<string>()
    const scrollAnchors = new Map<string, ScrollAnchor>()

    const onFocus = () => setFocused(true)
    const onBlur = () => setFocused(false)
    useKeyboard(onFocus)
    renderer.on("focus", onFocus)
    renderer.on("blur", onBlur)
    onCleanup(() => {
      renderer.off("focus", onFocus)
      renderer.off("blur", onBlur)
    })

    function state() {
      if (config.tabs.scope === "cwd") return store.cwd[paths.cwd] ?? fallback
      return store.global
    }

    function update(mutation: (draft: TabsState) => void) {
      const scope = config.tabs.scope
      void updateStore((draft) => mutation(scope === "cwd" ? (draft.cwd[paths.cwd] ??= empty()) : draft.global)).catch(
        // Failed writes lose only tab layout, but silence would hide tabs resetting every launch.
        (error) => console.error("Failed to persist session tabs", error),
      )
    }

    const root = (sessionID: string) => data.session.root(sessionID)
    const title = (sessionID: string, persisted?: string, fallback?: string) => {
      const session = data.session.get(sessionID)
      return session?.title ?? persisted ?? fallback ?? (session ? withTimestampedFallback(session) : undefined)
    }
    const isUnread = (sessionID: string) => {
      const info = data.session.get(sessionID)
      return info?.time.idle !== undefined && (info.time.viewed === undefined || info.time.idle > info.time.viewed)
    }
    const family = (sessionID: string) => {
      const session = root(sessionID)
      const members = data.session.family(session)
      return members.length > 0 ? members : [session]
    }
    const normalize = (value: TabsState) => ({
      tabs: value.tabs.reduce<SessionTab[]>((tabs, tab) => {
        const sessionID = root(tab.sessionID)
        return openSessionTab(tabs, { sessionID, title: title(sessionID, tab.title) })
      }, []),
      unread: {},
    })
    const current = () => (route.data.type === "session" ? root(route.data.sessionID) : undefined)
    createSessionRetention({
      session: data.session,
      current: () =>
        route.data.type === "session" && route.data.sessionID !== "dummy" ? route.data.sessionID : undefined,
      keep: () => (enabled() ? state().tabs.map((tab) => tab.sessionID) : []),
      limit: 3,
    })
    const newTab = createMemo((open = false) => {
      if (route.data.type === "home") return true
      if (!open) return false
      const sessionID = current()
      return sessionID !== undefined && !state().tabs.some((tab) => tab.sessionID === sessionID)
    }, false)
    const status = (sessionID: string) => {
      const session = root(sessionID)
      const members = family(session)
      return {
        // Unread reads the root session only: background subagent completions wake the parent,
        // whose own idle transition then carries the signal.
        unread: !isUnread(session)
          ? undefined
          : data.session.get(session)?.outcome === "failed"
            ? ("error" as const)
            : ("activity" as const),
        promptPulse: promptPulses()[session] ?? 0,
        attention: members.some((id) => (data.session.permission.list(id)?.length ?? 0) > 0)
          ? ("permission" as const)
          : members.some((id) => (data.session.form.list(id)?.length ?? 0) > 0)
            ? ("question" as const)
            : (false as const),
        // Parked synthetic context (user shells, plan reminders) stays pending without execution; only work counts as busy.
        busy: members.some(
          (id) =>
            data.session.status(id) === "running" ||
            data.session.pending.list(id).some((item) => item.type !== "synthetic"),
        ),
        renaming: data.session.title.pending(session),
      }
    }

    // Shared storage updates must not re-admit a tab unless this client changes route or scope.
    createEffect(
      on(
        [
          () => (enabled() && route.data.type === "session" ? route.data.sessionID : undefined),
          () => config.tabs.scope,
        ],
        ([routed]) => {
          if (!routed || routed === "dummy") return
          const sessionID = root(routed)
          cancelledTabs.delete(sessionID)
          history = recordSessionTabHistory(history, sessionID)
          if (state().tabs.some((tab) => tab.sessionID === sessionID)) return
          const fallback = newTab() ? NEW_SESSION_TAB_TITLE : undefined
          update((draft) => {
            if (cancelledTabs.has(sessionID)) return
            const tab = {
              sessionID,
              title: title(sessionID, draft.tabs.find((tab) => tab.sessionID === sessionID)?.title, fallback),
            }
            draft.tabs = openSessionTab(draft.tabs, tab)
          })
        },
      ),
    )

    // Viewed state is server-global, so acknowledgement runs even with tabs disabled: other
    // clients rely on this client reporting what its user has seen.
    const acknowledged = new Map<string, number>()
    const [viewRetry, setViewRetry] = createSignal(0)
    let viewRetryTimer: ReturnType<typeof setTimeout> | undefined
    let viewRetryAttempt = 0
    onCleanup(() => clearTimeout(viewRetryTimer))
    createEffect(() => {
      viewRetry()
      if (focused() !== true) return
      if (route.data.type !== "session" || route.data.sessionID === "dummy") return
      const sessionID = root(route.data.sessionID)
      const idle = data.session.get(sessionID)?.time.idle
      if (idle === undefined || !isUnread(sessionID) || acknowledged.get(sessionID) === idle) return
      // Record before the request so event-driven re-runs don't re-post the same watermark.
      acknowledged.set(sessionID, idle)
      void client.api.session.view({ sessionID, idle }).then(
        () => {
          clearTimeout(viewRetryTimer)
          viewRetryTimer = undefined
          viewRetryAttempt = 0
        },
        () => {
          if (acknowledged.get(sessionID) !== idle) return
          acknowledged.delete(sessionID)
          if (viewRetryTimer) return
          const delay = Math.min(VIEW_RETRY_DELAY * 2 ** viewRetryAttempt, VIEW_RETRY_MAX_DELAY)
          viewRetryAttempt++
          viewRetryTimer = setTimeout(() => {
            viewRetryTimer = undefined
            setViewRetry((value) => value + 1)
          }, delay)
        },
      )
    })

    createEffect(() => {
      if (!enabled()) return
      const next = normalize(state())
      if (isDeepEqual(next, state())) return
      update((draft) => {
        const next = normalize(draft)
        draft.tabs = next.tabs
        draft.unread = next.unread
      })
    })

    // Load lightweight session and location metadata concurrently so persisted tabs can resolve
    // their project and branch labels. Delay the heavier per-tab data so the visible session keeps
    // the first connection slots and switches still render from a warm cache.
    const openTabSessions = createMemo(() =>
      state()
        .tabs.map((tab) => tab.sessionID)
        .sort()
        .join("\n"),
    )
    createEffect(() => {
      if (!enabled()) return
      if (client.connection.status() !== "connected") return
      const signature = openTabSessions()
      if (signature === "") return
      const sessionIDs = signature.split("\n")
      let stale = false
      void (async () => {
        await Promise.allSettled(sessionIDs.map((sessionID) => data.session.sync(sessionID, { children: true })))
        if (stale) return
        const locations = new Map(
          sessionIDs
            .map((sessionID) => data.session.get(sessionID)?.location)
            .filter((location) => location !== undefined)
            .map((location) => [locationKey(location), location]),
        )
        await Promise.allSettled(
          Array.from(locations.values(), (location) =>
            Promise.all([data.location.syncInfo(location), data.location.vcs.sync(location)]),
          ),
        )
      })()
      const timer = setTimeout(async () => {
        const sessions = state()
          .tabs.map((tab) => tab.sessionID)
          .filter((sessionID) => sessionID !== current())
        for (const sessionID of sessions) {
          if (stale) return
          await Promise.allSettled([
            data.session.message.sync(sessionID),
            data.session.pending.sync(sessionID),
            data.session.permission.sync(sessionID),
            data.session.form.sync(sessionID),
          ])
        }
      }, TAB_PREFETCH_DELAY)
      onCleanup(() => {
        stale = true
        clearTimeout(timer)
      })
    })

    onCleanup(
      event.on("session.moved", (evt) => {
        if (!enabled() || !state().tabs.some((tab) => tab.sessionID === root(evt.data.sessionID))) return
        void Promise.allSettled([data.location.syncInfo(evt.data.location), data.location.vcs.sync(evt.data.location)])
      }),
    )
    onCleanup(
      event.on("session.inbox.enqueued", (evt) => {
        if (!enabled() || evt.data.item.type !== "user") return
        const sessionID = root(evt.data.sessionID)
        if (current() === sessionID || !state().tabs.some((tab) => tab.sessionID === sessionID)) return
        setPromptPulses((pulses) => ({ ...pulses, [sessionID]: (pulses[sessionID] ?? 0) + 1 }))
      }),
    )
    onCleanup(
      event.on("session.deleted", (evt) => {
        const target = root(evt.data.sessionID)
        closedTabs = closedTabs.filter((entry) => entry.tab.sessionID !== target)
        remove(evt.data.sessionID, enabled())
      }),
    )

    function remove(sessionID: string, navigate: boolean) {
      const target = root(sessionID)
      cancelledTabs.add(target)
      family(target).forEach((id) => scrollAnchors.delete(id))
      const closed = closeSessionTab(state().tabs, target)
      const selected = navigate && current() === target
      if (closed.tabs === state().tabs && !selected) return
      const previous = selected
        ? moveSessionTabHistory(recordSessionTabHistory(history, target), closed.tabs, target, -1)
        : { history, sessionID: undefined }
      const next = previous.sessionID ?? closed.next
      history = previous.history
      update((draft) => {
        draft.tabs = closeSessionTab(draft.tabs, target).tabs
      })
      setPromptPulses((pulses) => {
        if (pulses[target] === undefined) return pulses
        const next = { ...pulses }
        delete next[target]
        return next
      })
      if (selected) route.navigate(next ? { type: "session", sessionID: next } : { type: "home" })
    }

    return {
      enabled,
      tabs() {
        return state().tabs
      },
      newTab() {
        return newTab()
      },
      current,
      status,
      scrollAnchor(sessionID: string) {
        const target = root(sessionID)
        if (!state().tabs.some((tab) => tab.sessionID === target)) return
        return scrollAnchors.get(sessionID)
      },
      setScrollAnchor(sessionID: string, anchor: ScrollAnchor | undefined) {
        const target = root(sessionID)
        if (anchor === undefined || !state().tabs.some((tab) => tab.sessionID === target)) {
          scrollAnchors.delete(sessionID)
          return
        }
        const current = scrollAnchors.get(sessionID)
        if (current?.messageID === anchor.messageID && current.screenY === anchor.screenY) return
        scrollAnchors.set(sessionID, anchor)
      },
      select(sessionID: string) {
        if (!enabled()) return
        route.navigate({ type: "session", sessionID: root(sessionID) })
      },
      open(sessionID: string) {
        if (!enabled()) return
        const session = root(sessionID)
        if (state().tabs.some((tab) => tab.sessionID === session)) return
        cancelledTabs.delete(session)
        update((draft) => {
          draft.tabs = openSessionTab(draft.tabs, { sessionID: session, title: title(session) })
        })
      },
      add() {
        if (!enabled()) return
        const sessionID = current()
        const currentLocation = (sessionID ? data.session.get(sessionID)?.location : undefined) ?? location.ref
        route.navigate({
          type: "home",
          location: newSessionLocation(
            config.session.new_location,
            data.location.default().directory,
            currentLocation,
            location.error?.location,
          ),
        })
      },
      close(sessionID?: string) {
        if (!enabled()) return
        const target = sessionID ? root(sessionID) : current()
        if (!target) {
          const previous = moveSessionTabHistory(history, state().tabs, undefined, -1)
          history = previous.history
          const session = previous.sessionID ?? state().tabs.at(-1)?.sessionID
          if (route.data.type === "home" && session) route.navigate({ type: "session", sessionID: session })
          return
        }
        const index = state().tabs.findIndex((tab) => tab.sessionID === target)
        const tab = state().tabs[index]
        if (tab) closedTabs = recordClosedSessionTab(closedTabs, tab, index)
        remove(target, true)
      },
      reopen() {
        if (!enabled()) return
        const result = reopenSessionTab(closedTabs, state().tabs)
        closedTabs = result.stack
        const tabs = result.tabs
        if (!tabs || !result.sessionID) return
        cancelledTabs.delete(result.sessionID)
        update((draft) => {
          draft.tabs = tabs
        })
        route.navigate({ type: "session", sessionID: result.sessionID })
      },
      move(sessionID: string, index: number) {
        if (!enabled()) return
        const session = root(sessionID)
        if (moveSessionTab(state().tabs, session, index) === state().tabs) return
        update((draft) => {
          draft.tabs = moveSessionTab(draft.tabs, session, index)
        })
      },
      cycle(direction: 1 | -1) {
        if (!enabled()) return
        const tab = cycleSessionTab(state().tabs, current(), direction)
        if (tab) route.navigate({ type: "session", sessionID: tab.sessionID })
      },
      cycleUnread(direction: 1 | -1) {
        if (!enabled()) return
        const tab = cycleSessionTab(state().tabs, current(), direction, (tab) =>
          Boolean(status(tab.sessionID).unread || status(tab.sessionID).attention),
        )
        if (tab) route.navigate({ type: "session", sessionID: tab.sessionID })
      },
      selectIndex(index: number) {
        if (!enabled()) return
        const tab = state().tabs[index]
        if (tab) route.navigate({ type: "session", sessionID: tab.sessionID })
      },
    }
  },
})
