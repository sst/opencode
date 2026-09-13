import { Tabs } from "@opencode/ui/tabs"
import { useDialog } from "@opencode/ui/context/dialog"
import { createEffect, createMemo, on, onCleanup, onMount, Show, Switch, Match, type Accessor } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/runtime/i18n/language"
import { useLayout } from "@/shell/state/layout"
import { useTabs } from "@/shell/tabs/tabs"
import { displayName } from "@/shell/layout/helpers"
import { useGlobal, useServerCtx } from "@/runtime/server/runtime"
import { ServerConnection } from "@/runtime/server/registry"
import type { LocalProject } from "@/shell/state/layout"
import { useServerCollectionController } from "@/servers/registry/controller"
import { AddServerMenu } from "@/servers/wsl/settings"
import { DialogServer } from "@/servers/connect/dialog"
import { LocationProvider } from "@/workspaces/location"
import { SettingsGeneral } from "./general/general"
import { SettingsAppearance } from "./appearance/appearance"
import { SettingsExperimental } from "./experimental/experimental"
import { SettingsKeybinds } from "./keybinds/keybinds"
import { SettingsNotifications } from "./notifications/notifications"
import { SettingsProviders } from "./providers/providers"
import { SettingsModels } from "./models/models"
import { SettingsServerGeneral } from "./servers/servers"
import { useSettingsServers, type SettingsServer } from "./servers/inventory"
import { SettingsWorkspaces } from "./workspaces/workspaces"
import { useWorkspacesPrefetch } from "./workspaces/queries"
import { SettingsProjects } from "./workspaces/projects"
import { SettingsExtensions } from "./providers/extensions"
import { SettingsAbout } from "./about/about"
import { SettingsServerDataScope } from "./server-scope"
import { SettingsNavigation, type SettingsNavGroup } from "./navigation"
import { SettingsProjectGeneral } from "./workspaces/project"
import { ProjectSettingsExtensions } from "./workspaces/project-extensions"
import { useSettingsSurface } from "./surface"
import { pageIcons } from "./pages"
import { revealSettingsSearch } from "./search-reveal"
import "@/settings/settings.css"

const rootClientTabs = [
  { value: "general", icon: pageIcons.general, label: "settings.tab.preferences" },
  { value: "appearance", icon: pageIcons.appearance, label: "settings.general.section.appearance" },
  { value: "notifications", icon: pageIcons.notifications, label: "settings.tab.notifications" },
  { value: "shortcuts", icon: pageIcons.shortcuts, label: "settings.tab.shortcuts" },
] as const

const serverTabs = [
  { value: "projects", icon: pageIcons.projects, label: "settings.tab.projects" },
  { value: "workspaces", icon: pageIcons.workspaces, label: "settings.tab.workspaces" },
  { value: "providers", icon: pageIcons.providers, label: "settings.providers.title" },
  { value: "models", icon: pageIcons.models, label: "settings.models.title" },
  { value: "extensions", icon: pageIcons.extensions, label: "settings.tab.extensions" },
] as const

const trailingTabs = [
  [{ value: "experimental", icon: pageIcons.experimental, label: "settings.tab.experimental" }],
  [{ value: "about", icon: pageIcons.about, label: "settings.tab.about" }],
] as const

const nestedServerTabs = [
  { value: "general", icon: pageIcons.servers, label: "settings.general.section.general" },
  ...serverTabs,
] as const

const nestedProjectTabs = [
  { value: "general", icon: pageIcons.projects, label: "settings.general.section.general" },
  { value: "workspaces", icon: pageIcons.workspaces, label: "settings.tab.workspaces" },
  { value: "extensions", icon: pageIcons.extensions, label: "settings.tab.extensions" },
] as const

export function SettingsScreen() {
  const surface = useSettingsSurface()
  const dialog = useDialog()
  const servers = useSettingsServers()
  const global = useGlobal()
  let root: HTMLDivElement | undefined
  let viewType = surface.view().type
  let activation = 0

  onMount(() => root?.focus({ preventScroll: true }))
  createEffect(() => {
    const next = surface.view().type
    if (next === viewType) return
    viewType = next
    queueMicrotask(() => {
      const target =
        surface.search.state.query.trim() && surface.search.state.expanded
          ? root?.querySelector<HTMLInputElement>(".settings-search input")
          : root
      target?.focus({ preventScroll: true })
    })
  })

  createEffect(
    on(
      () => [surface.view(), surface.search.state.selected] as const,
      ([view, selected]) => {
        if (
          !root ||
          !selected ||
          !view.searchActivation ||
          view.searchActivation !== surface.search.state.activation ||
          view.searchActivation === activation
        )
          return
        activation = view.searchActivation
        onCleanup(revealSettingsSearch(root, view))
      },
    ),
  )

  const connection = (key: string) => servers().find((item) => item.key === key)
  const project = (server: ServerConnection.Any, directory: string) => {
    const context = global.ensureServerCtx(server)
    const value =
      context.projects.list().find((item) => item.worktree === directory) ??
      context.sync.data.project.find((item) => item.worktree === directory)
    return value ? { expanded: false, ...value } : undefined
  }
  const targetServer = createMemo(() => {
    const view = surface.view()
    if (view.type === "root") return undefined
    return connection(view.server)
  })
  const targetProject = createMemo(() => {
    const view = surface.view()
    const server = targetServer()
    if (view.type !== "project" || !server) return undefined
    return server.connection && project(server.connection, view.project)
  })
  createEffect(() => {
    const view = surface.view()
    if (view.type === "root") return
    const target = targetServer()
    if (!target) {
      surface.back()
      return
    }
    if (view.type === "project" && !target.connection) surface.replaceServer(target.key)
  })
  createEffect(() => {
    const view = surface.view()
    if (view.type !== "server" || servers().length !== 1) return
    surface.open(view.tab === "general" ? "servers" : view.tab)
  })

  return (
    <div
      ref={root}
      data-testid="settings-screen"
      class="settings-screen"
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || event.defaultPrevented || dialog.active) return
        event.preventDefault()
        if (surface.view().type !== "root" && surface.search.back()) return
        if (surface.search.state.query.trim()) {
          surface.search.clear()
          return
        }
        surface.back()
      }}
    >
      <Switch>
        <Match when={surface.view().type === "root"}>
          <RootSettings />
        </Match>
        <Match when={surface.view().type === "server"}>
          <Show when={targetServer()}>{(server) => <ServerSettings entry={server()} />}</Show>
        </Match>
        <Match when={surface.view().type === "project"}>
          <Show when={targetServer()?.connection} keyed>
            {(server) => (
              <Show when={targetProject()}>{(project) => <ProjectSettings server={server} project={project()} />}</Show>
            )}
          </Show>
        </Match>
      </Switch>
    </div>
  )
}

function RootSettings() {
  const language = useLanguage()
  const dialog = useDialog()
  const surface = useSettingsSurface()
  const layout = useLayout()
  const tabs = useTabs()
  const servers = useServerCollectionController()
  const inventory = useSettingsServers()
  const [state, setState] = createStore({ worktreeFilterReset: 0 })
  const list = servers.collection.items
  const singleEntry = createMemo(() => (inventory().length === 1 ? inventory()[0] : undefined))
  const single = createMemo(() => singleEntry()?.connection)
  const prefetchWorkspaces = useWorkspacesPrefetch(single)
  const multiple = createMemo(() => inventory().length > 1)
  const ordered = createMemo(() => {
    const order = new Map(list().map((server, index) => [ServerConnection.key(server), index]))
    return inventory().toSorted((a, b) => {
      const preferred = Number(b.key === servers.defaults.key()) - Number(a.key === servers.defaults.key())
      if (preferred) return preferred
      return (order.get(a.key) ?? list().length) - (order.get(b.key) ?? list().length)
    })
  })
  const sourceServer = createMemo(() => {
    const route = surface.route()
    if (route.type === "session") return connectionFor(list(), route.server)
    if (route.type === "draft") {
      const draft = tabs.store.find((item) => item.type === "draft" && item.draftID === route.draftID)
      return connectionFor(list(), draft?.server)
    }
    return connectionFor(list(), layout.home.selection().server)
  })
  const sourceDirectory = useSettingsDirectory(sourceServer)
  const addServer = () =>
    void dialog.push(() => (
      <DialogServer mode="add" onSave={(server) => surface.openServer(ServerConnection.key(server))} />
    ))
  const groups = createMemo<SettingsNavGroup[]>(() => [
    { items: rootClientTabs.map((item) => ({ ...item, label: language.t(item.label) })) },
    ...(multiple()
      ? [
          {
            label: language.t("status.popover.tab.servers"),
            action: <AddServerMenu compact onAddServer={addServer} />,
            items: ordered().map((server) => ({
              value: `server:${server.key}`,
              icon: "server" as const,
              label: server.name,
            })),
          },
        ]
      : [
          {
            items: [
              ...serverTabs.map((item) => ({
                ...item,
                label: language.t(item.label),
                disabled: !single(),
                onPrefetch: item.value === "workspaces" ? prefetchWorkspaces : undefined,
              })),
              { value: "servers", icon: "server" as const, label: language.t("settings.section.server") },
            ],
          },
        ]),
    ...trailingTabs.map((items) => ({ items: items.map((item) => ({ ...item, label: language.t(item.label) })) })),
  ])

  createEffect(() => {
    const view = surface.view()
    if (view.type !== "root" || !multiple()) return
    if (["projects", "workspaces", "providers", "models", "extensions", "servers"].includes(view.tab))
      surface.open("general")
  })

  const change = (value: string) => {
    if (value.startsWith("server:")) {
      surface.openServer(value.slice("server:".length))
      return
    }
    if (value === "workspaces") setState("worktreeFilterReset", (current) => current + 1)
    surface.select(value)
  }

  return (
    <SettingsNavigation
      value={surface.view().tab}
      groups={groups()}
      backLabel={language.t("settings.backToApp")}
      onBack={() => surface.close()}
      onChange={change}
      mobileAction={multiple() ? <AddServerMenu compact onAddServer={addServer} /> : undefined}
    >
      <Tabs.Content value="general" class="settings-panel">
        <SettingsGeneral />
      </Tabs.Content>
      <Tabs.Content value="appearance" class="settings-panel">
        <SettingsAppearance />
      </Tabs.Content>
      <Tabs.Content value="notifications" class="settings-panel">
        <SettingsNotifications />
      </Tabs.Content>
      <Tabs.Content value="shortcuts" class="settings-panel">
        <SettingsKeybinds active={surface.view().tab === "shortcuts"} autofocus={!surface.search.state.selected} />
      </Tabs.Content>
      <Tabs.Content value="experimental" class="settings-panel">
        <SettingsExperimental />
      </Tabs.Content>
      <Tabs.Content value="about" class="settings-panel settings-about">
        <SettingsAbout active={surface.view().tab === "about"} />
      </Tabs.Content>
      <Show when={single()} keyed>
        {(server) => (
          <SettingsServerDataScope server={server}>
            <Tabs.Content value="projects" class="settings-panel">
              <SettingsProjects
                server={server}
                active={surface.view().tab === "projects"}
                autofocus={!surface.search.state.selected}
                onOpenProject={(project) =>
                  surface.openProject({
                    server: ServerConnection.key(server),
                    project: project.worktree,
                  })
                }
              />
            </Tabs.Content>
            <Tabs.Content value="workspaces" class="settings-panel">
              <SettingsWorkspaces
                activeDirectory={sourceServer() === server ? sourceDirectory() : undefined}
                resetProjectFilter={() => state.worktreeFilterReset}
              />
            </Tabs.Content>
            <Tabs.Content value="providers" class="settings-panel">
              <SettingsProviders directory={undefined} onBack={() => surface.select("providers")} />
            </Tabs.Content>
            <Tabs.Content value="models" class="settings-panel">
              <SettingsModels active={surface.view().tab === "models"} autofocus={!surface.search.state.selected} />
            </Tabs.Content>
            <Tabs.Content value="extensions" class="settings-panel">
              <SettingsExtensions subtab={surface.view().subtab} onSubtab={(value) => surface.subtab(value)} />
            </Tabs.Content>
          </SettingsServerDataScope>
        )}
      </Show>
      <Show when={singleEntry()}>
        {(entry) => (
          <Tabs.Content value="servers" class="settings-panel">
            <SettingsServerGeneral entry={entry()} onAddServer={addServer} />
          </Tabs.Content>
        )}
      </Show>
    </SettingsNavigation>
  )
}

function ServerSettings(props: { entry: SettingsServer }) {
  const language = useLanguage()
  const surface = useSettingsSurface()
  const activeDirectory = useSettingsDirectory(() => props.entry.connection)
  const prefetchWorkspaces = useWorkspacesPrefetch(() => props.entry.connection)
  const [state, setState] = createStore({ worktreeFilterReset: 0 })
  const groups = createMemo<SettingsNavGroup[]>(() => [
    {
      items: nestedServerTabs.map((item) => ({
        ...item,
        label: item.value === "general" ? props.entry.name : language.t(item.label),
        disabled: item.value !== "general" && !props.entry.connection,
        onPrefetch: item.value === "workspaces" ? prefetchWorkspaces : undefined,
      })),
    },
  ])
  createEffect(() => {
    if (!props.entry.connection && surface.view().tab !== "general") surface.select("general")
  })
  const change = (value: string) => {
    if (value === "workspaces") setState("worktreeFilterReset", (current) => current + 1)
    surface.select(value)
  }

  return (
    <SettingsNavigation
      value={surface.view().tab}
      groups={groups()}
      backLabel={language.t("settings.backToSettings")}
      onBack={() => surface.back()}
      onChange={change}
    >
      <Tabs.Content value="general" class="settings-panel">
        <SettingsServerGeneral
          entry={props.entry}
          nested
          onServerChange={(server) => surface.replaceServer(ServerConnection.key(server))}
        />
      </Tabs.Content>
      <Show when={props.entry.connection} keyed>
        {(server) => (
          <SettingsServerDataScope server={server}>
            <Tabs.Content value="projects" class="settings-panel">
              <SettingsProjects
                server={server}
                active={surface.view().tab === "projects"}
                onOpenProject={(project) =>
                  surface.openProject({
                    server: props.entry.key,
                    project: project.worktree,
                  })
                }
              />
            </Tabs.Content>
            <Tabs.Content value="workspaces" class="settings-panel">
              <SettingsWorkspaces
                activeDirectory={activeDirectory()}
                resetProjectFilter={() => state.worktreeFilterReset}
              />
            </Tabs.Content>
            <Tabs.Content value="providers" class="settings-panel">
              <SettingsProviders directory={undefined} onBack={() => surface.select("providers")} />
            </Tabs.Content>
            <Tabs.Content value="models" class="settings-panel">
              <SettingsModels active={surface.view().tab === "models"} />
            </Tabs.Content>
            <Tabs.Content value="extensions" class="settings-panel">
              <SettingsExtensions subtab={surface.view().subtab} onSubtab={(value) => surface.subtab(value)} />
            </Tabs.Content>
          </SettingsServerDataScope>
        )}
      </Show>
    </SettingsNavigation>
  )
}

function ProjectSettings(props: { server: ServerConnection.Any; project: LocalProject }) {
  const language = useLanguage()
  const surface = useSettingsSurface()
  const activeDirectory = useSettingsDirectory(() => props.server)
  const prefetchWorkspaces = useWorkspacesPrefetch(() => props.server)
  const groups: SettingsNavGroup[] = [
    {
      items: nestedProjectTabs.map((item) => ({
        ...item,
        onPrefetch: item.value === "workspaces" ? prefetchWorkspaces : undefined,
        get label() {
          return item.value === "general" ? displayName(props.project) : language.t(item.label)
        },
      })),
    },
  ]
  return (
    <SettingsServerDataScope server={props.server} directory={props.project.worktree}>
      <LocationProvider directory={props.project.worktree}>
        <SettingsNavigation
          value={surface.view().tab}
          groups={groups}
          backLabel={language.t("settings.backToProjects")}
          onBack={() => surface.back()}
          onChange={(value) => surface.select(value)}
        >
          <Tabs.Content value="general" class="settings-panel">
            <SettingsProjectGeneral
              server={props.server}
              project={props.project}
              onOpenServer={() => surface.replaceServer(ServerConnection.key(props.server))}
            />
          </Tabs.Content>
          <Tabs.Content value="workspaces" class="settings-panel">
            <SettingsWorkspaces projectID={props.project.id} activeDirectory={activeDirectory()} />
          </Tabs.Content>
          <Tabs.Content value="extensions" class="settings-panel">
            <ProjectSettingsExtensions subtab={surface.view().subtab} onSubtab={(value) => surface.subtab(value)} />
          </Tabs.Content>
        </SettingsNavigation>
      </LocationProvider>
    </SettingsServerDataScope>
  )
}

function connectionFor(list: readonly ServerConnection.Any[], key: string | undefined) {
  return list.find((item) => ServerConnection.key(item) === key)
}

function useSettingsDirectory(server: Accessor<ServerConnection.Any | undefined>) {
  const surface = useSettingsSurface()
  const tabs = useTabs()
  const serverCtx = useServerCtx(server)
  return createMemo(() => {
    const current = server()
    if (!current) return undefined
    const key = ServerConnection.key(current)
    const route = surface.route()
    if (route.type === "session" && route.server === key)
      return serverCtx()?.data.session.get(route.sessionId)?.location.directory
    if (route.type !== "draft") return undefined
    const draft = tabs.store.find((item) => item.type === "draft" && item.draftID === route.draftID)
    return draft?.type === "draft" && draft.server === key ? draft.directory : undefined
  })
}
