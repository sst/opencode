import { createEffect, createMemo, createResource, Match, Show, Switch, untrack } from "solid-js"
import { createStore, unwrap } from "solid-js/store"
import { Dynamic, Portal } from "solid-js/web"
import { useLocation, useNavigate } from "@solidjs/router"
import { IconButton } from "@opencode/ui/icon-button"
import { Icon } from "@opencode/ui/icon"
import { Keybind } from "@opencode/ui/keybind"
import { Tooltip } from "@opencode/ui/tooltip"

import { LayoutRoute, useLayout } from "@/shell/state/layout"
import { usePlatform } from "@/runtime/platform/platform"
import { useCommand } from "@/shell/commands/command"
import { useLanguage } from "@/runtime/i18n/language"
import { useSettings } from "@/settings/model"
import { WindowsAppMenu } from "./windows-menu"
import { applyPath, backPath, forwardPath, type HistoryLocation } from "./history"
import { TitlebarTabStrip } from "@/shell/titlebar/tab-strip"
import { makeEventListener } from "@solid-primitives/event-listener"
import { createMediaQuery } from "@solid-primitives/media"
import { readSessionTabsRemovedDetail, SESSION_TABS_REMOVED_EVENT } from "@/shell/titlebar/session-events"
import { useGlobal } from "@/runtime/server/runtime"
import { ServerConnection } from "@/runtime/server/registry"
import { tabKey, useTabs } from "@/shell/tabs/tabs"
import type { ComposerState } from "@/composer/persistence"
import "./titlebar.css"
import { newTabTooltipKeybind } from "@/shell/commands/tooltip-keybind"
import { TitlebarRightMount } from "@/shell/titlebar/right-slot"
import { MobileDrawer, MobileDrawerContent, MobileDrawerLabel, MobileDrawerTrigger } from "@/shell/mobile-drawer"
import { sessionTabTitle } from "./tab-title"
import { SessionTabAvatar } from "@/shell/layout/session-tab-avatar"
import { SessionProgressIndicatorV2 } from "@opencode/session-ui/v2/session-progress-indicator-v2"
import { projectForSession } from "@/shell/layout/helpers"
import { useSettingsDialog } from "@/settings/command"
import devIcon from "../../../../desktop/icons/dev/64x64.png"
import betaIcon from "../../../../desktop/icons/beta/64x64.png"

const titlebarHeight = 36
const windowsTitlebarHeight = 44 // Includes the content inset; matches the native Windows overlay.
const minTitlebarZoom = 0.25
const windowsControlsBaseWidth = 138 // 3 native Windows caption buttons at 46px each.
// Native controls: 14px left inset, two 20px button pitches, and a 14px button.
const macTrafficLightsBaseWidth = 68
const macTrafficLightsTopClearance = 28

export type TitlebarUpdate = {
  version: string | undefined
  installing: boolean
  install: () => void
}

export function Titlebar(props: {
  update?: TitlebarUpdate
  debugTools?: { visible: boolean; toggle: () => void }
  verticalTabs?: { mount?: HTMLElement }
}) {
  const platform = usePlatform()
  const command = useCommand()
  const language = useLanguage()
  const settings = useSettings()
  const openSettings = useSettingsDialog()
  const navigate = useNavigate()
  const location = useLocation()
  const mobile = createMediaQuery("(max-width: 767px)")
  const bottom = createMemo(() => mobile() && settings.general.mobileTitlebarPosition() === "bottom")

  const mac = createMemo(() => platform.platform === "desktop" && platform.os === "macos")
  const windows = createMemo(() => platform.platform === "desktop" && platform.os === "windows")
  const linux = createMemo(() => platform.platform === "desktop" && platform.os === "linux")
  const macTrafficLights = createMemo(() => mac() && !platform.windowFullscreen?.())
  const macVerticalTabs = createMemo(() => mac() && !!props.verticalTabs)
  const zoom = () => platform.webviewZoom?.() ?? 1
  const titlebarZoom = () => (windows() ? Math.max(zoom(), minTitlebarZoom) : zoom())
  const minHeight = () => {
    if (mac()) return `${titlebarHeight / zoom()}px`
    if (windows()) return `env(titlebar-area-height, ${windowsTitlebarHeight / Math.min(titlebarZoom(), 1)}px)`
    return undefined
  }
  const windowsControlsWidth = () => `${windowsControlsBaseWidth / Math.max(titlebarZoom(), 1)}px`

  const [history, setHistory] = createStore({
    stack: [] as HistoryLocation[],
    index: 0,
    action: undefined as "back" | "forward" | undefined,
  })

  const path = () => `${location.pathname}${location.search}${location.hash}`

  createEffect(() => {
    const current = { url: path(), state: location.state }

    untrack(() => {
      const next = applyPath(history, current)
      if (next === history) return
      setHistory(next)
    })
  })

  const updateState = createMemo<TitlebarUpdatePillState>(() => {
    const installing = props.update?.installing ?? false
    const version = props.update?.version
    return {
      visible: version !== undefined || installing,
      installing,
      label: language.t("titlebar.update"),
      ariaLabel: language.t("toast.update.action.installRestart"),
      title: version ? language.t("titlebar.updateVersion", { version }) : undefined,
      onInstall: () => props.update?.install(),
    }
  })
  const rightState = createMemo<TitlebarRightState>(() => ({
    update: updateState(),
  }))
  const hideVerticalTitlebar = createMemo(() => !!props.verticalTabs && !windows())

  const back = () => {
    const next = backPath(history)
    if (!next) return
    setHistory(next.state)
    navigate(next.to.url, { state: unwrap(next.to.state) })
  }

  const forward = () => {
    const next = forwardPath(history)
    if (!next) return
    setHistory(next.state)
    navigate(next.to.url, { state: unwrap(next.to.state) })
  }

  command.register(() => [
    {
      id: "common.goBack",
      title: language.t("common.goBack"),
      category: language.t("command.category.view"),
      keybind: "mod+[",
      onSelect: back,
    },
    {
      id: "common.goForward",
      title: language.t("common.goForward"),
      category: language.t("command.category.view"),
      keybind: "mod+]",
      onSelect: forward,
    },
  ])

  return (
    <header
      data-slot="titlebar-v2"
      hidden={hideVerticalTitlebar()}
      classList={{
        "shrink-0 relative flex flex-row h-9 bg-v2-background-bg-deep overflow-visible": true,
        "order-last": bottom(),
      }}
      style={{
        height:
          platform.platform === "web"
            ? bottom()
              ? "calc(28px + max(8px, var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px))))"
              : "calc(28px + max(8px, env(safe-area-inset-top, 0px)))"
            : undefined,
        "padding-top": bottom() ? "0px" : "env(safe-area-inset-top, 0px)",
        "padding-bottom": bottom() ? "var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px))" : "0px",
        "min-height": minHeight(),
        // Keep native macOS traffic lights clear even when the desktop window is narrow.
        "padding-left": macTrafficLights() ? `${macTrafficLightsBaseWidth / zoom()}px` : 0,
        width: windows() ? `env(titlebar-area-width, calc(100vw - ${windowsControlsWidth()}))` : undefined,
        "max-width": windows() ? `env(titlebar-area-width, calc(100vw - ${windowsControlsWidth()}))` : undefined,
        // Native Windows caption controls remain on the physical right in both writing directions.
        "margin-right": windows() ? "auto" : undefined,
      }}
      data-tauri-drag-region
    >
      <Switch>
        <Match when>
          {(_) => {
            const layout = useLayout()
            const global = useGlobal()

            const tabs = useTabs()
            const tabsStore = tabs.store
            const tabsStoreActions = tabs
            const preparing = createMemo(() => {
              const route = layout.route()
              return route.type === "session" && !!tabs.pendingSession(route.server, route.sessionId)
            })
            const [loadedSession] = createResource(
              () => {
                const route = layout.route()
                if (route.type !== "session") return undefined
                if (preparing()) return undefined
                const conn = global.servers.list().find((item) => ServerConnection.key(item) === route.server)
                return conn ? { route, ctx: global.ensureServerCtx(conn) } : undefined
              },
              ({ route, ctx }) => ctx.sdk.api.session.get({ sessionID: route.sessionId }).catch(() => {}),
            )
            const session = createMemo(() => {
              const route = layout.route()
              if (route.type !== "session") return
              if (preparing()) return
              const conn = global.servers.list().find((item) => ServerConnection.key(item) === route.server)
              const cached = conn ? global.ensureServerCtx(conn).data.session.get(route.sessionId) : undefined
              if (cached) return cached
              const loaded = loadedSession()
              return loaded?.id === route.sessionId ? loaded : undefined
            })

            const matchRoute = (route: LayoutRoute) => {
              if (route.type === "home") return
              if (route.type === "draft") {
                return tabsStore.find((item) => item.type === "draft" && item.draftID === route.draftID)
              }
              if (route.type === "session") {
                const main = tabsStore.find(
                  (item) =>
                    item.type === "session" &&
                    item.server === route.server &&
                    (item.sessionId === route.sessionId || item.routeSessionId === route.sessionId),
                )
                if (main) return main
                const s = session()
                if (s?.parentID) {
                  const parentID = s.parentID
                  const parent = tabsStore.find(
                    (item) => item.type === "session" && item.server === route.server && item.sessionId === parentID,
                  )
                  if (parent) return parent
                }
              }
            }

            const currentTab = () => matchRoute(layout.route())

            createEffect(() => {
              const route = layout.route()
              if (!tabs.ready()) return
              const tab = currentTab()
              if (tab) {
                const current = session()
                if (
                  route.type === "session" &&
                  tab.type === "session" &&
                  (route.sessionId === tab.sessionId || current?.id === route.sessionId)
                ) {
                  tabs.rememberSessionRoute(tab, route.sessionId, current?.parentID)
                }
                tabs.remember(tab)
                return
              }

              if (route.type === "session") {
                if (tabs.pendingSession(route.server, route.sessionId)) {
                  tabsStoreActions.addSessionTab({ server: route.server, sessionId: route.sessionId })
                  return
                }
                const s = session()
                if (!s) return
                const sessionId = s.parentID ?? s.id
                const next = { server: route.server, sessionId }
                tabsStoreActions.addSessionTab(next)
              }
            })

            makeEventListener(window, SESSION_TABS_REMOVED_EVENT, (event) => {
              const detail = readSessionTabsRemovedDetail(event)
              if (!detail) return
              tabsStoreActions.removeSessions(detail)
            })

            const openNewTab = () => {
              const route = layout.route()
              switch (route.type) {
                case "session": {
                  const pending = tabs.pendingSession(route.server, route.sessionId)
                  if (pending) {
                    const model = tabs.stateValue<ComposerState>(pending.draft, "prompt")?.model.current()
                    void tabs.newDraft({ server: route.server, directory: pending.draft.directory }, "", model)
                    return
                  }
                  const activeSession = session()
                  if (!activeSession) return

                  const sessionTab = {
                    type: "session" as const,
                    server: route.server,
                    sessionId: activeSession.id,
                  }
                  const model = tabs.stateValue<ComposerState>(sessionTab, "prompt")?.model.current()
                  void tabs.newDraft(
                    { server: sessionTab.server, directory: activeSession.location.directory },
                    "",
                    model,
                  )
                  return
                }
                case "draft": {
                  const activeTab = currentTab()
                  if (activeTab?.type !== "draft") return

                  const model = tabs.stateValue<ComposerState>(activeTab, "prompt")?.model.current()
                  void tabs.newDraft({ server: activeTab.server, directory: activeTab.directory }, "", model)
                  return
                }
                case "settings":
                case "home": {
                  const selection = layout.home.selection()
                  const conn =
                    global.servers.list().find((item) => ServerConnection.key(item) === selection.server) ??
                    global.servers.list()[0]
                  const projects = conn ? global.ensureServerCtx(conn).projects : undefined
                  const project =
                    projects?.list().find((item) => item.worktree === selection.directory) ??
                    projects?.list().find((item) => item.worktree === projects.last()) ??
                    projects?.list()[0]
                  if (conn && project) {
                    void tabs.newDraft({ server: ServerConnection.key(conn), directory: project.worktree }, "")
                    return
                  }
                }
              }
            }
            const toggleHome = () => tabs.toggleHome({ home: layout.route().type === "home", current: currentTab() })
            const homeButton = (vertical = false) => (
              <Show
                when={vertical}
                fallback={
                  <Tooltip
                    placement="bottom"
                    value={
                      <>
                        {language.t("home.title")}
                        <Keybind keys={command.keybindParts("home.toggle")} variant="neutral" />
                      </>
                    }
                    class="shrink-0"
                  >
                    <IconButton
                      type="button"
                      variant="ghost-muted"
                      size="large"
                      class="!w-9 shrink-0"
                      icon={<Icon name="grid-plus" />}
                      state={layout.route().type === "home" ? "pressed" : undefined}
                      onClick={toggleHome}
                      aria-label={language.t("home.title")}
                      aria-pressed={layout.route().type === "home"}
                    />
                  </Tooltip>
                }
              >
                <button
                  type="button"
                  data-action="vertical-tabs-home"
                  data-state={layout.route().type === "home" ? "pressed" : undefined}
                  class="group mb-1 flex h-7 w-full shrink-0 items-center gap-1.5 rounded-[6px] ps-1.5 pe-2 text-[13px] leading-4 text-v2-text-text-faint hover:bg-v2-background-bg-layer-02 hover:text-v2-text-text-base data-[state=pressed]:bg-v2-background-bg-layer-02 data-[state=pressed]:text-v2-text-text-base"
                  onClick={toggleHome}
                  aria-label={language.t("home.title")}
                  aria-pressed={layout.route().type === "home"}
                >
                  <Icon name="grid-plus" class="shrink-0" />
                  <span class="min-w-0 truncate">{language.t("home.title")}</span>
                  <span
                    class="ms-auto hidden min-w-0 truncate text-v2-text-text-faint group-hover:block group-focus-visible:block"
                    aria-hidden="true"
                  >
                    <bdi dir="ltr">{command.keybind("home.toggle")}</bdi>
                  </span>
                </button>
              </Show>
            )

            command.register("titlebar-home", () => [
              {
                id: "home.toggle",
                title: language.t("home.title"),
                category: language.t("command.category.view"),
                keybind: windows() ? "alt+home" : "mod+b",
                hidden: true,
                onSelect: toggleHome,
              },
            ])

            command.register("tabs", () => {
              const current = currentTab()

              return [
                {
                  id: "tab.new",
                  category: "tab",
                  title: language.t("command.session.new"),
                  keybind: "mod+t,mod+n",
                  hidden: true,
                  onSelect: openNewTab,
                },
                current && {
                  id: "tab.close",
                  category: "tab",
                  title: language.t("command.tab.close"),
                  keybind: "mod+w",
                  hidden: true,
                  onSelect: () => {
                    tabsStoreActions.closeTab(tabsStore.findIndex((tab) => current === tab))
                  },
                },
                {
                  id: "tab.reopenClosed",
                  category: language.t("command.category.file"),
                  title: language.t("command.tab.reopenClosed"),
                  keybind: "mod+shift+t",
                  onSelect: () => tabsStoreActions.reopenClosedTab(),
                },
              ].filter((v) => v !== undefined)
            })

            const [mobileTabs, setMobileTabs] = createStore({ open: false, settings: false })
            const currentProject = createMemo(() => {
              const tab = currentTab()
              const value = session()
              if (!tab || !value) return
              const conn = global.servers.list().find((item) => ServerConnection.key(item) === tab.server)
              return projectForSession(value, conn ? global.ensureServerCtx(conn).projects.list() : [])
            })
            const currentTitle = () => {
              const tab = currentTab()
              if (!tab) return language.t("home.title")
              if (tab.type === "draft") return language.t("session.tab.session")
              const value = session()
              return sessionTabTitle(
                value ? value.title : tabs.info[tabKey(tab)]?.title,
                language.t("session.tab.session"),
              )
            }
            createEffect(() => {
              path()
              mobile()
              setMobileTabs("open", false)
            })

            return (
              <div
                class="h-full flex-1 overflow-hidden flex flex-row items-center gap-1.5 px-2 md:pe-3"
                classList={{
                  "pt-[max(0px,calc(8px-env(safe-area-inset-top,0px)))]": !bottom() && !windows(),
                  "pb-[max(0px,calc(8px-var(--safe-area-inset-bottom,env(safe-area-inset-bottom,0px))))]": bottom(),
                  "pl-4": macTrafficLights(),
                  // Center the 20px app icon over the sidebar's 16px icon column.
                  "ps-3.5": windows(),
                }}
              >
                <Show when={!mobile() && (!props.verticalTabs || windows())}>
                  <ChannelIndicator horizontal debugTools={props.debugTools} />
                </Show>
                <Show when={windows() || linux()}>
                  <WindowsAppMenu command={command} platform={platform} />
                </Show>
                <Show when={!mobile() && !props.verticalTabs}>{homeButton()}</Show>

                <Show
                  when={!mobile()}
                  fallback={
                    <MobileDrawer
                      open={mobileTabs.open}
                      onOpenChange={(open) => setMobileTabs("open", open)}
                      onContentPresentChange={(present) => {
                        if (present || !mobileTabs.settings) return
                        setMobileTabs("settings", false)
                        openSettings()
                      }}
                    >
                      <MobileDrawerTrigger
                        data-slot="mobile-tabs-trigger"
                        class="flex h-7 min-w-0 flex-1 items-center gap-2 rounded-[6px] px-2 text-[13px] leading-4 text-v2-text-text-base focus-visible:outline-none [app-region:no-drag]"
                        aria-label={language.t("titlebar.tabs")}
                      >
                        <Show when={currentTab()} fallback={<Icon name="grid-plus" class="shrink-0" />}>
                          {(tab) => (
                            <span
                              data-slot="project-avatar-slot"
                              class="flex size-4 shrink-0 items-center justify-center"
                            >
                              <Show
                                when={session()}
                                fallback={
                                  tab().type === "draft" ? (
                                    <Icon name="edit" />
                                  ) : (
                                    <Show
                                      when={preparing()}
                                      fallback={
                                        <span
                                          class="block size-4 rounded-[3px] border border-v2-border-border-muted"
                                          aria-hidden="true"
                                        />
                                      }
                                    >
                                      <SessionProgressIndicatorV2 />
                                    </Show>
                                  )
                                }
                              >
                                {(value) => (
                                  <SessionTabAvatar
                                    project={currentProject()}
                                    directory={value().location.directory}
                                    sessionId={value().id}
                                    server={tab().server}
                                  />
                                )}
                              </Show>
                            </span>
                          )}
                        </Show>
                        <span data-slot="mobile-tab-title" dir="auto" class="min-w-0 flex-1 truncate text-start">
                          {currentTitle()}
                        </span>
                        <span class="shrink-0 text-v2-text-text-muted">{tabsStore.length}</span>
                      </MobileDrawerTrigger>
                      <MobileDrawerContent>
                        <MobileDrawerLabel class="sr-only">{language.t("titlebar.tabs")}</MobileDrawerLabel>
                        <div data-slot="mobile-tabs-drawer" data-corvu-no-drag>
                          <div data-slot="mobile-tabs-drawer-list">
                            <TitlebarTabStrip
                              orientation="vertical"
                              tabs={tabsStore}
                              currentTab={currentTab()}
                              onNavigate={(tab) => {
                                tabs.select(tab)
                                setMobileTabs("open", false)
                              }}
                              onClose={(tab) => {
                                const index = tabsStore.findIndex((item) => tabKey(item) === tabKey(tab))
                                if (index !== -1) tabsStoreActions.closeTab(index)
                              }}
                              onReorder={(keys) => tabsStoreActions.reorder(keys)}
                            />
                          </div>
                          <button
                            type="button"
                            data-action="mobile-tabs-new-session"
                            class="flex h-7 w-full shrink-0 items-center gap-2 rounded-[6px] px-2 text-[13px] leading-4 text-v2-text-text-base hover:bg-v2-background-bg-layer-02 focus-visible:outline-none focus-visible:bg-v2-background-bg-layer-02"
                            onClick={() => {
                              openNewTab()
                              setMobileTabs("open", false)
                            }}
                          >
                            <Icon name="plus" />
                            {language.t("command.session.new")}
                          </button>
                          <div class="flex shrink-0 flex-col gap-1 border-t border-v2-border-border-muted pt-2">
                            <button
                              type="button"
                              data-action="mobile-tabs-home"
                              data-state={layout.route().type === "home" ? "pressed" : undefined}
                              aria-current={layout.route().type === "home" ? "page" : undefined}
                              class="flex h-7 w-full items-center gap-2 rounded-[6px] px-2 text-[13px] leading-4 text-v2-text-text-faint data-[state=pressed]:text-v2-text-text-base focus-visible:outline-none"
                              onClick={() => {
                                if (layout.route().type !== "home") toggleHome()
                                setMobileTabs("open", false)
                              }}
                            >
                              <Icon name="grid-plus" />
                              {language.t("home.title")}
                            </button>
                            <div class="flex items-center gap-1">
                              <button
                                type="button"
                                data-action="mobile-tabs-settings"
                                class="flex h-7 min-w-0 flex-1 items-center gap-2 rounded-[6px] px-2 text-[13px] leading-4 text-v2-text-text-faint hover:bg-v2-background-bg-layer-02 focus-visible:outline-none focus-visible:bg-v2-background-bg-layer-02"
                                onClick={() => setMobileTabs({ open: false, settings: true })}
                              >
                                <Icon name="settings-gear" size="small" />
                                {language.t("sidebar.settings")}
                              </button>
                              <button
                                type="button"
                                data-action="mobile-tabs-help"
                                class="flex h-7 shrink-0 items-center gap-2 rounded-[6px] px-2 text-[13px] leading-4 text-v2-text-text-faint hover:bg-v2-background-bg-layer-02 focus-visible:outline-none focus-visible:bg-v2-background-bg-layer-02"
                                onClick={() => {
                                  setMobileTabs("open", false)
                                  platform.openExternal("https://opencode.ai/desktop-feedback")
                                }}
                              >
                                <Icon name="help" size="small" />
                                {language.t("sidebar.help")}
                              </button>
                            </div>
                          </div>
                        </div>
                      </MobileDrawerContent>
                    </MobileDrawer>
                  }
                >
                  <Show
                    when={props.verticalTabs}
                    fallback={
                      <>
                        <TitlebarTabStrip
                          tabs={tabsStore}
                          currentTab={currentTab()}
                          onNavigate={(tab, el) => {
                            tabs.select(tab)
                            el?.scrollIntoView({ behavior: "instant" })
                          }}
                          onClose={(tab) => {
                            const index = tabsStore.findIndex((item) => tabKey(item) === tabKey(tab))
                            if (index !== -1) tabsStoreActions.closeTab(index)
                          }}
                          onReorder={(keys) => tabsStoreActions.reorder(keys)}
                        />
                        <Tooltip
                          placement="bottom"
                          value={
                            <>
                              {language.t("command.session.new")}
                              <Keybind keys={newTabTooltipKeybind(command)} variant="neutral" />
                            </>
                          }
                        >
                          <IconButton
                            type="button"
                            variant="ghost-muted"
                            size="large"
                            class="shrink-0"
                            icon={<Icon name="plus" />}
                            onClick={openNewTab}
                            aria-label={language.t("command.session.new")}
                          />
                        </Tooltip>
                      </>
                    }
                  >
                    {(vertical) => (
                      <Show when={vertical().mount} keyed>
                        {(mount) => (
                          <Portal
                            mount={mount}
                            ref={(element) => (element.className = "flex size-full min-h-0 flex-col")}
                          >
                            <Show when={macVerticalTabs()}>
                              <div
                                class="mb-4 min-h-7 w-full shrink-0"
                                style={{ height: `${macTrafficLightsTopClearance / zoom()}px` }}
                                data-tauri-drag-region
                              />
                            </Show>
                            <Show when={!windows()}>
                              <ChannelIndicator sidebar debugTools={props.debugTools} />
                            </Show>
                            {homeButton(true)}
                            <button
                              type="button"
                              data-action="vertical-tabs-new-session"
                              class="group flex h-7 w-full shrink-0 items-center gap-1.5 rounded-[6px] ps-1.5 pe-2 text-[13px] leading-4 text-v2-text-text-faint hover:bg-v2-background-bg-layer-02 hover:text-v2-text-text-base"
                              onClick={openNewTab}
                              aria-label={language.t("command.session.new")}
                            >
                              <Icon name="edit" class="shrink-0" />
                              <span class="min-w-0 truncate">{language.t("command.session.new")}</span>
                              <span
                                class="ms-auto hidden min-w-0 truncate text-v2-text-text-faint group-hover:block group-focus-visible:block"
                                aria-hidden="true"
                              >
                                <bdi dir="ltr">{command.keybind("tab.new")}</bdi>
                              </span>
                            </button>
                            <div class="h-4 w-full shrink-0" aria-hidden="true" />
                            <div class="flex min-h-0 flex-1 flex-col gap-1">
                              <TitlebarTabStrip
                                orientation="vertical"
                                tabs={tabsStore}
                                currentTab={currentTab()}
                                onNavigate={(tab, el) => {
                                  tabs.select(tab)
                                  el?.scrollIntoView({ behavior: "instant", block: "nearest" })
                                }}
                                onClose={(tab) => {
                                  const index = tabsStore.findIndex((item) => tabKey(item) === tabKey(tab))
                                  if (index !== -1) tabsStoreActions.closeTab(index)
                                }}
                                onReorder={(keys) => tabsStoreActions.reorder(keys)}
                              />
                            </div>
                            <Show when={updateState().visible}>
                              <div data-slot="vertical-tabs-footer" class="mt-2 flex w-full shrink-0 flex-col">
                                <TitlebarUpdateIconButton state={updateState()} vertical />
                              </div>
                            </Show>
                          </Portal>
                        )}
                      </Show>
                    )}
                  </Show>
                </Show>
                <Show when={!mobile()}>
                  <div class="flex-1" />
                </Show>
                <Show when={!props.verticalTabs}>
                  <TitlebarRight state={rightState()} />
                </Show>
              </div>
            )
          }}
        </Match>
      </Switch>
    </header>
  )
}

type TitlebarUpdatePillState = {
  visible: boolean
  installing: boolean
  label: string
  ariaLabel: string
  title?: string
  onInstall: () => void
}

type TitlebarRightState = {
  update: TitlebarUpdatePillState
}

function TitlebarRight(props: { state: TitlebarRightState }) {
  return (
    <div class="relative z-20 flex shrink-0 items-center justify-end gap-0 overflow-visible">
      <Show when={props.state.update.visible}>
        <TitlebarUpdateIconButton state={props.state.update} />
      </Show>
      <TitlebarRightMount />
    </div>
  )
}

function TitlebarUpdateIconButton(props: { state: TitlebarUpdatePillState; vertical?: boolean }) {
  const label = () => (
    <span
      class="shrink-0 text-[11px] leading-4 text-v2-text-text-accent [font-weight:530] opacity-0 motion-safe:transition-all duration-150 ease-out group-hover:opacity-100 group-hover:translate-x-0 group-focus-within:opacity-100 group-focus-within:translate-x-0 motion-reduce:translate-x-0"
      classList={{
        "ms-px me-4 -translate-x-2 rtl:translate-x-2": props.vertical,
        "ms-2 me-px translate-x-2 rtl:-translate-x-2": !props.vertical,
      }}
    >
      {props.state.label}
    </span>
  )
  return (
    <div
      data-slot="titlebar-update"
      class="group relative shrink-0 rounded-full bg-v2-background-bg-deep transition-[width] duration-150 ease-out hover:z-30 focus-within:z-30 motion-reduce:transition-none"
      classList={{
        "h-7 w-7 self-start hover:w-[84px] focus-within:w-[84px]": props.vertical,
        "me-3 h-5 w-5 hover:w-[68px] focus-within:w-[68px]": !props.vertical,
      }}
    >
      <button
        type="button"
        class="absolute top-0 z-10 flex h-full w-full items-center overflow-hidden rounded-full bg-v2-icon-icon-accent/20 text-v2-icon-icon-accent transition-[background-color] duration-150 ease-out group-hover:bg-[color-mix(in_srgb,var(--v2-icon-icon-accent)_20%,var(--v2-background-bg-deep))] group-focus-within:bg-[color-mix(in_srgb,var(--v2-icon-icon-accent)_20%,var(--v2-background-bg-deep))] focus-visible:outline-none disabled:opacity-60 motion-reduce:transition-none [app-region:no-drag]"
        classList={{ "start-0 justify-start": props.vertical, "end-0 justify-end": !props.vertical }}
        onClick={props.state.onInstall}
        disabled={props.state.installing}
        aria-busy={props.state.installing}
        aria-label={props.state.ariaLabel}
      >
        <Show when={!props.vertical}>{label()}</Show>
        <span
          class="flex shrink-0 items-center justify-center"
          classList={{ "size-7": props.vertical, "size-5": !props.vertical }}
        >
          <Show
            when={!props.state.installing}
            fallback={<span data-slot="titlebar-update-loader" aria-hidden="true" />}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
              <path d="M7 11V3M3.5 7.63128L7 11L10.5 7.63128" stroke="currentColor" />
            </svg>
          </Show>
        </span>
        <Show when={props.vertical}>{label()}</Show>
      </button>
    </div>
  )
}

function ChannelIndicator(props: {
  horizontal?: boolean
  sidebar?: boolean
  debugTools?: { visible: boolean; toggle: () => void }
}) {
  const language = useLanguage()
  const platform = usePlatform()
  const channel = import.meta.env.VITE_OPENCODE_CHANNEL
  if (!channel || channel === "prod") return null

  const label = () => language.t(`titlebar.channel.${channel}`)
  const debug = () => (channel === "dev" ? props.debugTools : undefined)
  return (
    <Tooltip
      placement={props.sidebar ? "right" : "bottom"}
      value={label()}
      class={`shrink-0 [app-region:no-drag] ${props.sidebar ? "mb-4 ms-0.5 self-start" : ""} ${props.horizontal ? "me-1.5" : ""} ${props.horizontal && platform.platform === "web" ? "ps-2.5" : ""}`}
    >
      <Dynamic
        component={debug() ? "button" : "div"}
        type={debug() ? "button" : undefined}
        data-slot="channel-indicator"
        class="flex h-7 shrink-0 items-center rounded-[6px] [app-region:no-drag]"
        classList={{
          "w-6": props.sidebar,
          "w-5": !props.sidebar,
          "cursor-pointer hover:bg-v2-background-bg-layer-02 focus-visible:outline-none focus-visible:bg-v2-background-bg-layer-02":
            !!debug(),
        }}
        onClick={() => debug()?.toggle()}
        aria-label={debug() ? language.t("titlebar.toggleDebugTools") : undefined}
        aria-pressed={debug()?.visible}
      >
        <img
          src={channel === "beta" ? betaIcon : devIcon}
          alt={debug() ? "" : label()}
          class="shrink-0 rounded-[4px] shadow-[var(--v2-elevation-raised)]"
          classList={{ "size-6": props.sidebar, "size-5": !props.sidebar }}
          draggable={false}
        />
      </Dynamic>
    </Tooltip>
  )
}
