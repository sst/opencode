/// <reference path="./env.d.ts" />

// Load the complete preload contract before App's optional browser bridge declaration.
import {
  AppBaseProviders,
  AppInterface,
  currentRoute,
  PlatformProvider,
  preloadRoute,
  ServerConnection,
  useCommand,
  useCurrentRoute,
  useLanguage,
  useTabs,
  useWslServers,
  useSsh,
  type LayoutRoute,
  type UpdaterPlatform,
} from "@opencode/app/desktop"
import { useTheme } from "@opencode/ui/theme/context"
import type { BaseRouterProps } from "@solidjs/router"
import { createEffect, createMemo, createResource, lazy, Show, Suspense } from "solid-js"
import { createStore } from "solid-js/store"
import type { ElectronAPI } from "./api-types"
import { DesktopFirstLaunchOnboarding } from "./onboarding"
import { createDesktopPlatform, type DesktopWindowState } from "./platform"
import { bindDesktopMenu } from "./platform/menu"
import { createSidecarResolver, initializationData, sidecarHttp } from "./startup/initialization"
import { preloadStoredLocale } from "./startup/locale"
import { LoadingSplash } from "./startup/splash"
import { getLastActiveUrl } from "./window/route-storage"
import { DesktopMemoryRouter } from "./window/router"
import { availableStartupServer, readyWslConnections } from "./wsl/connections"
import { createSshConnections } from "./ssh/connections"

const MigrationStatus = lazy(() => import("./migration-status").then((module) => ({ default: module.MigrationStatus })))

export function DesktopApp(props: { api: ElectronAPI; updater: UpdaterPlatform; version: string }) {
  const windowState = { id: props.api.getWindowID(), version: props.version }
  const url = new URL(getLastActiveUrl(windowState.id), "http://localhost")
  const route = currentRoute(url.pathname, url.search)
  const [startup, setStartup] = createStore<{ ready: boolean; visible: boolean; route: LayoutRoute }>({
    ready: false,
    visible: true,
    route,
  })
  return (
    <>
      <DesktopWindow
        api={props.api}
        updater={props.updater}
        windowState={windowState}
        onReady={() => setStartup("ready", true)}
        onRoute={(route) => setStartup("route", route)}
      />
      <Show when={startup.visible}>
        <div
          class="fixed inset-0 z-[100] transition-opacity duration-300 ease-out"
          classList={{ "pointer-events-none opacity-0": startup.ready }}
          onTransitionEnd={(event) => {
            if (event.target !== event.currentTarget || !startup.ready) return
            setStartup("visible", false)
          }}
        >
          <LoadingSplash deep={startup.route.type === "draft"} />
        </div>
      </Show>
    </>
  )
}

function DesktopWindow(props: {
  api: ElectronAPI
  updater: UpdaterPlatform
  windowState: DesktopWindowState
  onReady: () => void
  onRoute: (route: LayoutRoute) => void
}) {
  const platform = createDesktopPlatform(props.api, props.windowState, props.updater)
  const [sidecar, { mutate: setSidecar }] = createResource(() => props.api.awaitInitialization())
  const [defaultServer] = createResource(() => platform.getDefaultServer?.())
  const [locale] = createResource(() => preloadStoredLocale(platform))
  const [initialRoute] = createResource(() => preloadRoute(getLastActiveUrl(props.windowState.id)))
  const router = (routerProps: BaseRouterProps) => (
    <DesktopMemoryRouter {...routerProps} windowID={props.windowState.id} />
  )

  function ReadyApp() {
    const wslServers = useWslServers()
    const ssh = useSsh()
    const sshConnections = createSshConnections(props.api.sshServers)
    const language = useLanguage()
    const ready = createMemo(
      () => !defaultServer.loading && !sidecar.loading && !locale.loading && !wslServers.isLoading && !ssh.loading,
    )
    const servers = createMemo(() => {
      const data = initializationData(sidecar)
      const list: ServerConnection.Any[] = []
      if (data) {
        list.push({
          displayName: language.t("desktop.server.local"),
          type: "sidecar",
          variant: "base",
          http: sidecarHttp(data),
          reconnect: createSidecarResolver({ api: props.api, current: sidecar, update: setSidecar }),
        })
      }
      list.push(...readyWslConnections(wslServers.data, language.t("wsl.server.label")))
      list.push(...sshConnections({ servers: ssh.servers }, language.t("ssh.label")))
      return list
    })
    const effectiveDefaultServer = createMemo(() =>
      ServerConnection.Key.make(availableStartupServer(defaultServer.latest, wslServers.data)),
    )

    return (
      <Show when={ready()}>
        <Show when={effectiveDefaultServer()} keyed>
          {(key) => (
            <AppInterface defaultServer={key} servers={servers()} router={router}>
              <DesktopStartupReady
                routeReady={() => !initialRoute.loading}
                onReady={props.onReady}
                onRoute={props.onRoute}
              />
              <DesktopFirstLaunchOnboarding
                api={props.api}
                initialUrl={getLastActiveUrl(props.windowState.id)}
                serverKey={key}
              />
              <DesktopEffects api={props.api} />
              <Suspense fallback={null}>
                <Show when={initializationData(sidecar)} keyed>
                  {(server) => <MigrationStatus server={server} />}
                </Show>
              </Suspense>
            </AppInterface>
          )}
        </Show>
      </Show>
    )
  }

  return (
    <PlatformProvider value={platform}>
      <AppBaseProviders
        locale={locale.latest}
        onNativeTranslations={(bundle) => void props.api.setNativeTranslations(bundle).catch(() => undefined)}
        onThemeApplied={(mode, scheme) => {
          void props.api.setTitlebar({ mode, scheme })
          void props.api.themeReady()
        }}
      >
        <Show when={true}>{(_) => <ReadyApp />}</Show>
      </AppBaseProviders>
    </PlatformProvider>
  )
}

function DesktopStartupReady(props: {
  routeReady: () => boolean
  onReady: () => void
  onRoute: (route: LayoutRoute) => void
}) {
  const tabs = useTabs()
  const route = useCurrentRoute()
  createEffect(() => props.onRoute(route()))
  createEffect(() => {
    if (!props.routeReady() || !tabs.ready() || !tabs.infoReady()) return
    props.onReady()
  })
  return null
}

function DesktopEffects(props: { api: ElectronAPI }) {
  const command = useCommand()
  bindDesktopMenu((id) => command.trigger(id))
  const theme = useTheme()

  createEffect(() => {
    theme.themeId()
    theme.mode()
    const background = getComputedStyle(document.documentElement).getPropertyValue("--background-base").trim()
    if (background) void props.api.setBackgroundColor(background)
  })

  return null
}
