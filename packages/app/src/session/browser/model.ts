import { batch, createEffect, createMemo, on, onCleanup } from "solid-js"
import type { Browser } from "@opencode/plugin-browser/rpc"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/runtime/i18n/language"
import type { BrowserPaneCommand } from "@/runtime/platform/browser-pane"
import { useServer } from "@/runtime/server/current"
import { useCommand } from "@/shell/commands/command"
import type { SessionModel } from "../model"
import { isSessionBrowserTab, sessionBrowserTab } from "../helpers"
import { useBrowserAttachments } from "./attachments"

export function createSessionBrowser(session: SessionModel) {
  const attachments = useBrowserAttachments()
  const language = useLanguage()
  const server = useServer()
  const commands = useCommand()
  const [local, setLocal] = createStore({ error: undefined as string | undefined })
  const attachment = () => {
    const sessionID = session.identity.sessionID()
    return sessionID ? attachments.state(server, sessionID) : undefined
  }
  const available = createMemo(
    () =>
      attachments.enabled() &&
      attachments.supported(server) &&
      !!session.identity.sessionID() &&
      !server.health?.incompatible &&
      session.isDesktop(),
  )
  const attached = () => !!(attachment()?.registration || attachment()?.browser)
  const browserTabs = createMemo(
    () =>
      attachment()?.browser?.tabs.filter((tab) => session.layout.tabs().all().includes(sessionBrowserTab(tab.id))) ??
      [],
  )
  const focus = (tabID: Browser.TabID) => {
    session.layout.view().reviewPanel.open()
    const tabs = session.layout.tabs()
    const key = sessionBrowserTab(tabID)
    if (!tabs.all().includes(key)) tabs.setAll([...tabs.all(), key])
    tabs.setActive(key)
  }
  const command = (command: BrowserPaneCommand) => {
    const sessionID = session.identity.sessionID()
    if (!sessionID) return
    setLocal("error", undefined)
    const owner = session.ownership.capture()
    void attachments.command(server, sessionID, command).catch(() => {
      if (owner.current()) setLocal("error", language.t("common.requestFailed"))
    })
  }
  const open = () => {
    if (!available()) return
    command({ type: "tabs.open" })
  }
  commands.register("session.browser", () => [
    {
      id: "browser.open",
      title: language.t("command.browser.open"),
      category: language.t("command.category.view"),
      keybind: "mod+shift+b",
      disabled: !available(),
      onSelect: open,
    },
  ])
  createEffect(() => {
    const sessionID = session.identity.sessionID()
    if (!sessionID) return
    if (attachments.enabled()) attachments.attach(server, sessionID)
    onCleanup(attachments.onFocus(server, sessionID, focus))
  })
  createEffect(
    on(
      () => session.layout.tabs().active(),
      (active) => {
        const tab = attachment()?.browser?.tabs.find((tab) => sessionBrowserTab(tab.id) === active)
        if (tab && tab.id !== attachment()?.browser?.focusedTabID) command({ type: "tabs.focus", tabID: tab.id })
      },
    ),
  )
  createEffect(
    on(
      () => session.layout.tabs().all(),
      (current, previous) => {
        previous
          ?.filter((key) => isSessionBrowserTab(key) && !current.includes(key))
          .forEach((key) => {
            const tab = attachment()?.browser?.tabs.find((tab) => sessionBrowserTab(tab.id) === key)
            if (tab) command({ type: "tabs.close", tabID: tab.id })
          })
      },
    ),
  )
  // Mirror the desktop's tab inventory into this session's layout tabs. Only tabs new since the last
  // inventory are added, so a layout tab the user just closed is not reopened before the desktop confirms.
  createEffect(
    on(
      () => attachment()?.browser?.tabs.map((tab) => sessionBrowserTab(tab.id)),
      (ids, previous) => {
        if (!ids) return
        const known = new Set(previous ?? [])
        batch(() => {
          const tabs = session.layout.tabs()
          tabs
            .all()
            .filter((key) => isSessionBrowserTab(key) && !ids.includes(key))
            .forEach(tabs.close)
          const current = tabs.all()
          const added = ids.filter((key) => !known.has(key) && !current.includes(key))
          if (added.length) tabs.setAll([...current, ...added])
        })
      },
    ),
  )
  return {
    available,
    attached,
    opened: () => attached() && browserTabs().length > 0,
    state: () => attachment()?.browser ?? null,
    tabs: browserTabs,
    active: () =>
      browserTabs().find((tab) => sessionBrowserTab(tab.id) === session.layout.tabs().active()) ??
      browserTabs().find((tab) => tab.id === attachment()?.browser?.focusedTabID) ??
      browserTabs()[0],
    error: () => local.error ?? attachment()?.error,
    suspended: () => attachment()?.suspended ?? false,
    registration: () => attachment()?.registration,
    close: (tabID: Browser.TabID) => session.layout.tabs().close(sessionBrowserTab(tabID)),
    open,
    command,
  }
}
