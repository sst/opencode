import { createStore, reconcile } from "solid-js/store"
import { Schema } from "effect"
import { SessionError } from "@opencode/schema/session-error"
import { type Accessor, batch, createEffect, createMemo, createRoot, getOwner, onCleanup } from "solid-js"
import { createSimpleContext } from "@opencode/ui/context"
import type { ServerSDK } from "@/runtime/server/client"
import type { Data } from "@opencode/client/solid"
import { usePlatform } from "@/runtime/platform/platform"
import { useLanguage } from "@/runtime/i18n/language"
import { useSettings } from "@/settings/model"
import { decode64 } from "@/runtime/persistence/base64"
import { Persist, persisted } from "@/runtime/persistence/storage"
import { Persistence } from "@/runtime/persistence/schema"
import { playSoundById } from "@/shell/notifications/sound"
import type { createNotificationCoordinator } from "@/shell/notifications/coordinator"
import { useGlobal } from "@/runtime/server/runtime"
import { ServerConnection, useServers } from "@/runtime/server/registry"
import { sessionIDHasOpenTab, useTabs } from "@/shell/tabs/tabs"
import { requireServerKey, sessionHref } from "@/shell/routes/session"
import type { ServerScope } from "@/runtime/server/scope"
import { useServer } from "@/runtime/server/current"

const NotificationBase = {
  directory: Schema.optional(Schema.String),
  session: Schema.optional(Schema.String),
  metadata: Schema.optional(Schema.Unknown),
  time: Schema.Finite,
  viewed: Schema.Boolean,
}
export const Notification = Schema.Union([
  Persistence.struct({ ...NotificationBase, type: Schema.Literal("turn-complete") }),
  Persistence.struct({ ...NotificationBase, type: Schema.Literal("error"), error: SessionError.Error }),
])
export type Notification = typeof Notification.Type
export const NotificationStore = Persistence.struct({ list: Persistence.array(Notification) })

type NotificationIndex = {
  session: {
    all: Record<string, Notification[]>
    unseen: Record<string, Notification[]>
    unseenCount: Record<string, number>
    unseenHasError: Record<string, boolean>
  }
  project: {
    all: Record<string, Notification[]>
    unseen: Record<string, Notification[]>
    unseenCount: Record<string, number>
    unseenHasError: Record<string, boolean>
  }
}

type NotificationTabs = Pick<ReturnType<typeof useTabs>, "addSessionTab" | "rememberSessionRoute" | "select">

export function openNotificationSession(tabs: NotificationTabs, server: ServerConnection.Key, sessionID: string) {
  const tab = tabs.addSessionTab({ server, sessionId: sessionID })
  if (tab.type !== "session") return
  tabs.rememberSessionRoute(tab, sessionID)
  tabs.select(tab)
}

const MAX_NOTIFICATIONS = 500
const NOTIFICATION_TTL_MS = 1000 * 60 * 60 * 24 * 30

function pruneNotifications(list: Notification[]) {
  const cutoff = Date.now() - NOTIFICATION_TTL_MS
  const pruned = list.filter((n) => n.time >= cutoff)
  if (pruned.length <= MAX_NOTIFICATIONS) return pruned
  return pruned.slice(pruned.length - MAX_NOTIFICATIONS)
}

function createNotificationIndex(): NotificationIndex {
  return {
    session: {
      all: {},
      unseen: {},
      unseenCount: {},
      unseenHasError: {},
    },
    project: {
      all: {},
      unseen: {},
      unseenCount: {},
      unseenHasError: {},
    },
  }
}

function buildNotificationIndex(list: Notification[]) {
  const index = createNotificationIndex()

  list.forEach((notification) => {
    if (notification.session) {
      const all = index.session.all[notification.session] ?? []
      index.session.all[notification.session] = [...all, notification]
      if (!notification.viewed) {
        const unseen = index.session.unseen[notification.session] ?? []
        index.session.unseen[notification.session] = [...unseen, notification]
        index.session.unseenCount[notification.session] = unseen.length + 1
        if (notification.type === "error") index.session.unseenHasError[notification.session] = true
      }
    }

    if (notification.directory) {
      const all = index.project.all[notification.directory] ?? []
      index.project.all[notification.directory] = [...all, notification]
      if (!notification.viewed) {
        const unseen = index.project.unseen[notification.directory] ?? []
        index.project.unseen[notification.directory] = [...unseen, notification]
        index.project.unseenCount[notification.directory] = unseen.length + 1
        if (notification.type === "error") index.project.unseenHasError[notification.directory] = true
      }
    }
  })

  return index
}

export function createServerNotificationState(input: {
  sdk: ServerSDK
  data: Data
  key: ServerConnection.Key
  coordinator: ReturnType<typeof createNotificationCoordinator>
}) {
  const platform = usePlatform()
  const settings = useSettings()
  const language = useLanguage()
  const tabs = useTabs()
  const empty: Notification[] = []

  const [store, setStore, _, ready] = persisted(
    Persist.serverGlobal(input.sdk.scope, "notification"),
    NotificationStore,
    { list: [] },
  )
  const [index, setIndex] = createStore<NotificationIndex>(buildNotificationIndex(store.list))

  const meta = { pruned: false, disposed: false }

  const updateUnseen = (scope: "session" | "project", key: string, unseen: Notification[]) => {
    setIndex(scope, "unseen", key, unseen)
    setIndex(scope, "unseenCount", key, unseen.length)
    setIndex(
      scope,
      "unseenHasError",
      key,
      unseen.some((notification) => notification.type === "error"),
    )
  }

  const appendToIndex = (notification: Notification) => {
    if (notification.session) {
      setIndex("session", "all", notification.session, (all = []) => [...all, notification])
      if (!notification.viewed) {
        setIndex("session", "unseen", notification.session, (unseen = []) => [...unseen, notification])
        setIndex("session", "unseenCount", notification.session, (count = 0) => count + 1)
        if (notification.type === "error") setIndex("session", "unseenHasError", notification.session, true)
      }
    }

    if (notification.directory) {
      setIndex("project", "all", notification.directory, (all = []) => [...all, notification])
      if (!notification.viewed) {
        setIndex("project", "unseen", notification.directory, (unseen = []) => [...unseen, notification])
        setIndex("project", "unseenCount", notification.directory, (count = 0) => count + 1)
        if (notification.type === "error") setIndex("project", "unseenHasError", notification.directory, true)
      }
    }
  }

  const removeFromIndex = (notification: Notification) => {
    if (notification.session) {
      setIndex("session", "all", notification.session, (all = []) => all.filter((n) => n !== notification))
      if (!notification.viewed) {
        const unseen = (index.session.unseen[notification.session] ?? empty).filter((n) => n !== notification)
        updateUnseen("session", notification.session, unseen)
      }
    }

    if (notification.directory) {
      setIndex("project", "all", notification.directory, (all = []) => all.filter((n) => n !== notification))
      if (!notification.viewed) {
        const unseen = (index.project.unseen[notification.directory] ?? empty).filter((n) => n !== notification)
        updateUnseen("project", notification.directory, unseen)
      }
    }
  }

  createEffect(() => {
    if (!ready()) return
    if (meta.pruned) return
    meta.pruned = true
    const list = pruneNotifications(store.list)
    batch(() => {
      setStore("list", list)
      setIndex(reconcile(buildNotificationIndex(list), { merge: false }))
    })
  })

  const append = (notification: Notification) => {
    const list = pruneNotifications([...store.list, notification])
    const keep = new Set(list)
    const removed = store.list.filter((n) => !keep.has(n))

    batch(() => {
      if (keep.has(notification)) appendToIndex(notification)
      removed.forEach((n) => removeFromIndex(n))
      setStore("list", list)
    })
  }

  const lookup = async (sessionID?: string) => {
    if (!sessionID) return undefined
    const session = input.data.session.get(sessionID)
    if (session) return session
    return input.data.session
      .sync(sessionID)
      .then(() => input.data.session.get(sessionID))
      .catch(() => undefined)
  }

  const viewedInCurrentSession = (sessionID: string) => {
    return typeof location !== "undefined" && location.pathname === sessionHref(input.key, sessionID)
  }

  const handleSessionIdle = (sessionID: string, eventID: string, time: number) => {
    void lookup(sessionID).then((session) => {
      if (meta.disposed) return
      if (!session) return
      if (session.parentID) return

      if (sessionIDHasOpenTab(tabs.store, input.key, sessionID) && settings.sounds.agentEnabled()) {
        void input.coordinator.sound(`${input.key}\0${eventID}`, () => playSoundById(settings.sounds.agent()))
      }

      append({
        directory: session.location.directory,
        time,
        viewed: viewedInCurrentSession(sessionID),
        type: "turn-complete",
        session: sessionID,
      })

      if (settings.notifications.agent()) {
        void input.coordinator.system(`${input.key}\0${eventID}`, () =>
          platform.notify(language.t("notification.session.responseReady.title"), session.title ?? sessionID, () =>
            openNotificationSession(tabs, input.key, sessionID),
          ),
        )
      }
    })
  }

  const handleSessionError = (sessionID: string, error: SessionError.Error, eventID: string, time: number) => {
    void lookup(sessionID).then((session) => {
      if (meta.disposed) return
      if (session?.parentID) return

      if (sessionIDHasOpenTab(tabs.store, input.key, sessionID) && settings.sounds.errorsEnabled()) {
        void input.coordinator.sound(`${input.key}\0${eventID}`, () => playSoundById(settings.sounds.errors()))
      }

      append({
        directory: session?.location.directory,
        time,
        viewed: viewedInCurrentSession(sessionID),
        type: "error",
        session: sessionID,
        error,
      })
      const description =
        session?.title ??
        (typeof error === "string" ? error : language.t("notification.session.error.fallbackDescription"))
      if (settings.notifications.errors()) {
        void input.coordinator.system(`${input.key}\0${eventID}`, () =>
          platform.notify(language.t("notification.session.error.title"), description, () =>
            openNotificationSession(tabs, input.key, sessionID),
          ),
        )
      }
    })
  }

  const unsub = input.sdk.event.listen((event) => {
    if (event.type !== "session.execution.succeeded" && event.type !== "session.execution.failed") return

    const time = Date.now()
    if (event.type === "session.execution.failed") {
      handleSessionError(event.data.sessionID, event.data.error, event.id, time)
      return
    }
    handleSessionIdle(event.data.sessionID, event.id, time)
  })
  onCleanup(() => {
    meta.disposed = true
    unsub()
  })

  return {
    ready,
    session: {
      all(session: string) {
        return index.session.all[session] ?? empty
      },
      unseen(session: string) {
        return index.session.unseen[session] ?? empty
      },
      unseenCount(session: string) {
        return index.session.unseenCount[session] ?? 0
      },
      unseenHasError(session: string) {
        return index.session.unseenHasError[session] ?? false
      },
      markViewed(session: string) {
        const unseen = index.session.unseen[session] ?? empty
        if (!unseen.length) return

        const projects = [
          ...new Set(unseen.flatMap((notification) => (notification.directory ? [notification.directory] : []))),
        ]
        batch(() => {
          setStore("list", (n) => n.session === session && !n.viewed, "viewed", true)
          updateUnseen("session", session, [])
          projects.forEach((directory) => {
            const next = (index.project.unseen[directory] ?? empty).filter(
              (notification) => notification.session !== session,
            )
            updateUnseen("project", directory, next)
          })
        })
      },
    },
    project: {
      all(directory: string) {
        return index.project.all[directory] ?? empty
      },
      unseen(directory: string) {
        return index.project.unseen[directory] ?? empty
      },
      unseenCount(directory: string) {
        return index.project.unseenCount[directory] ?? 0
      },
      unseenHasError(directory: string) {
        return index.project.unseenHasError[directory] ?? false
      },
      markViewed(directory: string) {
        const unseen = index.project.unseen[directory] ?? empty
        if (!unseen.length) return

        const sessions = [
          ...new Set(unseen.flatMap((notification) => (notification.session ? [notification.session] : []))),
        ]
        batch(() => {
          setStore("list", (n) => n.directory === directory && !n.viewed, "viewed", true)
          updateUnseen("project", directory, [])
          sessions.forEach((session) => {
            const next = (index.session.unseen[session] ?? empty).filter(
              (notification) => notification.directory !== directory,
            )
            updateUnseen("session", session, next)
          })
        })
      },
    },
  }
}

export const useNotification = () => {
  const server = useServer()
  return server.ctx.notification
}
