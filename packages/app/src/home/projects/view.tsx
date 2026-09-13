import { createMemo, For, type JSX, onCleanup, Show, splitProps } from "solid-js"
import { createStore } from "solid-js/store"
import { Popover } from "@kobalte/core/popover"
import { DragDropProvider, PointerSensor } from "@dnd-kit/solid"
import { isSortable, useSortable } from "@dnd-kit/solid/sortable"
import { AutoScroller, Feedback, PointerActivationConstraints } from "@dnd-kit/dom"
import { RestrictToVerticalAxis } from "@dnd-kit/abstract/modifiers"
import { RestrictToElement } from "@dnd-kit/dom/modifiers"
import { ScrollView } from "@opencode/ui/scroll-view"
import { ProjectAvatar } from "@opencode/ui/project-avatar"
import { Icon } from "@opencode/ui/icon"
import { IconButton } from "@opencode/ui/icon-button"
import { Button } from "@opencode/ui/button"
import { Spinner } from "@opencode/ui/spinner"
import { Menu } from "@opencode/ui/menu"
import { Tooltip } from "@opencode/ui/tooltip"
import { getProjectAvatarVariant, type HomeProjectSelection, type LocalProject } from "@/shell/state/layout"
import { ServerConnection } from "@/runtime/server/registry"
import { useLanguage } from "@/runtime/i18n/language"
import { usePlatform } from "@/runtime/platform/platform"
import { displayName, getProjectAvatarSource } from "@/shell/layout/helpers"
import { ServerRowMenuView, serverMenuLabels } from "@/servers/registry/row-menu"
import { ServerHealthIndicator } from "@/servers/registry/row"
import { type ServerHealth } from "@/runtime/server/health"
import { fileManagerApp } from "@/home/projects/file-manager"
import "./view.css"

const HOME_PROJECT_NAV_LABEL = "min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap"

const serverContextMenuID = (server: ServerConnection.Any) => `server:${ServerConnection.key(server)}`
const projectContextMenuID = (server: ServerConnection.Any, directory: string) =>
  `project:${ServerConnection.key(server)}:${directory}`

export type HomeProjectsViewProps = {
  dropdown?: boolean
  language: ReturnType<typeof useLanguage>
  servers: ServerConnection.Any[]
  projects: LocalProject[]
  recentlyClosed: LocalProject[]
  selection: HomeProjectSelection
  homedir: string
  serverHealth: (server: ServerConnection.Any) => ServerHealth | undefined
  projectsForServer: (server: ServerConnection.Any) => LocalProject[]
  collapsed: (server: ServerConnection.Any) => boolean
  canDefaultServer: boolean
  defaultServerKey: ServerConnection.Key | null | undefined
  canRevealProject: (server: ServerConnection.Any) => boolean
  unseenCount: (server: ServerConnection.Any, project: LocalProject) => number
  onWheel: (event: WheelEvent) => void
  onChooseProject: (server: ServerConnection.Any) => void
  onFocusServer: (server: ServerConnection.Any) => void
  onAuthenticateServer?: (server: ServerConnection.Any) => void
  onToggleCollapsed: (server: ServerConnection.Any) => void
  onEditServer: (server: ServerConnection.Http) => void
  onSetDefaultServer: (server: ServerConnection.Any | undefined) => void
  canRemoveServer: (server: ServerConnection.Any) => boolean
  onRemoveServer: (server: ServerConnection.Any) => void
  canHideServer: (server: ServerConnection.Any) => boolean
  onHideServer: (server: ServerConnection.Any) => void
  onMoveProject: (server: ServerConnection.Any, worktree: string, index: number) => void
  onSelectProject: (server: ServerConnection.Any, directory: string) => void
  onAddProjects: (server: ServerConnection.Any, directories: string[]) => void
  onOpenProjectNewSession: (server: ServerConnection.Any, directory: string) => void
  canImportSession: boolean
  onImportSession: (server: ServerConnection.Any, project: LocalProject) => void
  onEditProject: (server: ServerConnection.Any, project: LocalProject) => void
  onRevealProject: (server: ServerConnection.Any, project: LocalProject) => void
  onClearNotifications: (server: ServerConnection.Any, project: LocalProject) => void
  onCloseProject: (server: ServerConnection.Any, directory: string) => void
  onOpenSettings: () => void
  onOpenHelp: () => void
}

export function HomeProjectsView(props: HomeProjectsViewProps) {
  const [state, setState] = createStore({ open: false })
  const selected = createMemo(() => props.projects.find((project) => project.worktree === props.selection.directory))
  const server = createMemo(() =>
    props.servers.find((server) => ServerConnection.key(server) === props.selection.server),
  )
  return (
    <Show when={props.dropdown} fallback={<HomeProjectsPanel {...props} />}>
      <Popover
        open={state.open}
        onOpenChange={(open) => setState("open", open)}
        placement="bottom-start"
        sameWidth
        gutter={6}
      >
        <Popover.Trigger
          data-component="home-projects-dropdown"
          aria-label={props.language.t("home.projects")}
          class="flex h-10 w-full min-w-0 items-center gap-2 rounded-[6px] bg-v2-background-bg-base px-1.5 text-start text-v2-text-text-base outline-none hover:bg-v2-background-bg-layer-01"
        >
          <Show when={selected()} fallback={<Icon name="folder" size="small" />}>
            {(project) => <HomeProjectAvatar project={project()} />}
          </Show>
          <span class="flex min-w-0 flex-1 flex-col leading-[var(--line-height-compact)]">
            <bdi class="truncate">
              <Show when={selected()} fallback={props.language.t("home.projects.all")}>
                {(project) => displayName(project())}
              </Show>
            </bdi>
            <Show when={props.servers.length > 1 && server()}>
              {(server) => (
                <bdi class="truncate text-v2-text-text-muted opacity-70">
                  {server().displayName ?? new URL(server().http.url).host}
                </bdi>
              )}
            </Show>
          </span>
          <Icon name="chevron-down" size="small" class="shrink-0 text-v2-icon-icon-muted" />
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            aria-label={props.language.t("home.projects")}
            dir={props.language.direction()}
            class="z-50 max-h-[min(70dvh,var(--kb-popper-content-available-height))] overflow-hidden rounded-[10px] bg-v2-background-bg-base p-1.5 shadow-[var(--v2-elevation-floating)] outline-none data-[expanded]:animate-in data-[expanded]:fade-in data-[expanded]:slide-in-from-top-2 duration-150 ease-out motion-reduce:animate-none"
          >
            <HomeProjectsPanel
              {...props}
              onSelectProject={(server, directory) => {
                props.onSelectProject(server, directory)
                setState("open", false)
              }}
              onFocusServer={(server) => {
                props.onFocusServer(server)
                setState("open", false)
              }}
              onAuthenticateServer={(server) => {
                setState("open", false)
                props.onAuthenticateServer?.(server)
              }}
              onChooseProject={(server) => {
                setState("open", false)
                props.onChooseProject(server)
              }}
              onAddProjects={(server, directories) => {
                setState("open", false)
                props.onAddProjects(server, directories)
              }}
              onOpenProjectNewSession={(server, directory) => {
                setState("open", false)
                props.onOpenProjectNewSession(server, directory)
              }}
            />
          </Popover.Content>
        </Popover.Portal>
      </Popover>
    </Show>
  )
}

function HomeProjectsPanel(props: HomeProjectsViewProps) {
  const [contextMenu, setContextMenu] = createStore({ open: undefined as string | undefined })
  const contextMenuProps = {
    contextMenuOpen: (id: string) => contextMenu.open === id,
    onSetContextMenuOpen: (id: string, open: boolean) => setContextMenu("open", open ? id : undefined),
  }
  return (
    <aside
      class={
        props.dropdown
          ? "flex max-h-[min(60dvh,calc(var(--kb-popper-content-available-height)-12px))] min-h-0 min-w-0 flex-col overflow-hidden"
          : `
        mt-6 flex min-h-0 min-w-0 flex-col gap-4 overflow-hidden
        lg:sticky lg:top-14 lg:mt-14 lg:h-[calc(100cqh-56px)] lg:self-start lg:pt-[52px]
      `
      }
      aria-label={props.language.t("home.projects")}
      onWheel={(event) => {
        if (event.target === event.currentTarget) return
        props.onWheel(event)
      }}
    >
      <Show when={!props.dropdown}>
        <div class="flex h-7 min-w-0 shrink-0 items-center justify-between pl-1.5 pr-3">
          <div class="text-v2-text-text-muted [font-weight:530]">{props.language.t("home.projects")}</div>
          <Show when={props.servers.length === 1 && !(props.projects.length === 0 && props.recentlyClosed.length > 0)}>
            <Tooltip placement="bottom" value={props.language.t("home.project.add")}>
              <IconButton
                data-action="home-add-project"
                variant="ghost-muted"
                size="large"
                class="titlebar-icon [&_[data-slot=icon-svg]]:text-v2-icon-icon-muted"
                icon={<Icon name="folder-add-left" />}
                disabled={props.serverHealth(props.servers[0])?.healthy === false}
                onClick={() => props.onChooseProject(props.servers[0])}
                aria-label={props.language.t("home.project.add")}
              />
            </Tooltip>
          </Show>
        </div>
      </Show>
      <ScrollView data-slot="home-projects-scroll" class="min-h-0 min-w-0 shrink">
        <Show when={props.dropdown && props.servers.length === 1}>
          <HomeProjectNavButton
            type="button"
            class="mb-1"
            data-selected={!props.selection.directory ? "" : undefined}
            onClick={() => props.onFocusServer(props.servers[0])}
          >
            <Icon name="folder" size="small" />
            <span class={HOME_PROJECT_NAV_LABEL}>{props.language.t("home.projects.all")}</span>
          </HomeProjectNavButton>
        </Show>
        <Show
          when={
            props.servers.length > 1 ||
            props.servers.some(
              (server) => server.type === "ssh" && (server.authenticationRequired || server.connecting),
            )
          }
          fallback={
            <Show when={props.servers[0]}>
              {(server) => (
                <div class={props.dropdown ? "" : "pr-3"}>
                  <Show
                    when={props.projects.length > 0}
                    fallback={<HomeProjectEmpty {...props} server={server()} items={props.recentlyClosed} />}
                  >
                    <HomeProjectList {...props} {...contextMenuProps} server={server()} items={props.projects} />
                    <Show when={props.dropdown}>
                      <HomeProjectNavButton
                        type="button"
                        data-action="home-add-project-row"
                        class="mt-1 disabled:opacity-60"
                        disabled={props.serverHealth(server())?.healthy === false}
                        onClick={() => props.onChooseProject(server())}
                      >
                        <Icon name="folder-add-left" size="small" />
                        <span class={HOME_PROJECT_NAV_LABEL}>{props.language.t("home.project.add")}</span>
                      </HomeProjectNavButton>
                    </Show>
                  </Show>
                </div>
              )}
            </Show>
          }
        >
          <div class={`flex min-w-0 flex-col ${props.dropdown ? "gap-1" : "gap-4 pr-3"}`}>
            <For each={props.servers}>
              {(item) => {
                const projects = () => props.projectsForServer(item)
                const healthy = () => !!props.serverHealth(item)?.healthy
                const hasProjects = () => projects().length > 0
                const collapsed = () => props.collapsed(item)
                const authentication = () => item.type === "ssh" && item.authenticationRequired
                const connecting = () => item.type === "ssh" && item.connecting
                return (
                  <div class="flex min-w-0 flex-col gap-1">
                    <HomeServerRow
                      server={item}
                      {...props}
                      {...contextMenuProps}
                      selected={props.selection.server === ServerConnection.key(item) && !props.selection.directory}
                      collapsed={collapsed()}
                      health={props.serverHealth(item)}
                    />
                    <Show when={authentication() || connecting()}>
                      <div class="mx-3 h-px bg-v2-border-border-base" />
                      <div class="px-1.5 py-1">
                        <Button
                          data-action="home-server-authenticate"
                          class="w-full"
                          size="small"
                          variant="neutral"
                          disabled={connecting()}
                          aria-busy={!!connecting()}
                          onClick={() => props.onAuthenticateServer?.(item)}
                        >
                          <Show when={connecting()}>
                            <Spinner class="size-3.5" />
                          </Show>
                          {props.language.t(connecting() ? "ssh.stage.connecting" : "ssh.action.authenticate")}
                        </Button>
                      </div>
                    </Show>
                    <Show when={healthy() && !authentication() && !connecting() && hasProjects() && !collapsed()}>
                      <div class="mx-3 h-px bg-v2-border-border-base" />
                      <HomeProjectList {...props} {...contextMenuProps} server={item} items={projects()} />
                    </Show>
                  </div>
                )
              }}
            </For>
          </div>
        </Show>
      </ScrollView>
      <HomeUtilityNav
        class="mb-8 mt-4 hidden shrink-0 lg:flex"
        onOpenSettings={props.onOpenSettings}
        onOpenHelp={props.onOpenHelp}
        language={props.language}
      />
    </aside>
  )
}

export function HomeUtilityNav(props: {
  class?: string
  onOpenSettings: () => void
  onOpenHelp: () => void
  language: ReturnType<typeof useLanguage>
}) {
  return (
    <div
      class={`${props.class ?? ""} min-w-0 flex-row justify-between gap-1 lg:flex-col lg:justify-start lg:pr-3 [&>button]:w-auto lg:[&>button]:w-full`}
    >
      <HomeProjectNavButton
        type="button"
        class="text-v2-text-text-faint [&>[data-slot=icon-svg]]:text-v2-icon-icon-muted"
        onClick={props.onOpenSettings}
      >
        <Icon name="settings-gear" size="small" />
        <span class={HOME_PROJECT_NAV_LABEL}>{props.language.t("sidebar.settings")}</span>
      </HomeProjectNavButton>
      <HomeProjectNavButton
        type="button"
        class="text-v2-text-text-faint [&>[data-slot=icon-svg]]:text-v2-icon-icon-muted"
        onClick={props.onOpenHelp}
      >
        <Icon name="help" size="small" />
        <span class={HOME_PROJECT_NAV_LABEL}>{props.language.t("sidebar.help")}</span>
      </HomeProjectNavButton>
    </div>
  )
}

function HomeServerRow(props: {
  language: HomeProjectsViewProps["language"]
  projectsForServer: HomeProjectsViewProps["projectsForServer"]
  contextMenuOpen: HomeProjectsContextMenuProps["contextMenuOpen"]
  canDefaultServer: HomeProjectsViewProps["canDefaultServer"]
  defaultServerKey: HomeProjectsViewProps["defaultServerKey"]
  onFocusServer: HomeProjectsViewProps["onFocusServer"]
  onToggleCollapsed: HomeProjectsViewProps["onToggleCollapsed"]
  onEditServer: HomeProjectsViewProps["onEditServer"]
  onSetDefaultServer: HomeProjectsViewProps["onSetDefaultServer"]
  canRemoveServer: HomeProjectsViewProps["canRemoveServer"]
  onRemoveServer: HomeProjectsViewProps["onRemoveServer"]
  canHideServer: HomeProjectsViewProps["canHideServer"]
  onHideServer: HomeProjectsViewProps["onHideServer"]
  onSetContextMenuOpen: HomeProjectsContextMenuProps["onSetContextMenuOpen"]
  onChooseProject: HomeProjectsViewProps["onChooseProject"]
  server: ServerConnection.Any
  selected: boolean
  collapsed: boolean
  health: ServerHealth | undefined
}) {
  const healthy = () => !!props.health?.healthy
  const authentication = () => props.server.type === "ssh" && props.server.authenticationRequired
  const incompatible = () => !!props.health?.incompatible
  const canToggle = () => healthy() && props.projectsForServer(props.server).length > 0
  const contextMenuID = () => serverContextMenuID(props.server)
  onCleanup(() => {
    const id = contextMenuID()
    if (props.contextMenuOpen(id)) props.onSetContextMenuOpen(id, false)
  })
  return (
    <Tooltip
      appearance="standard"
      placement="top"
      class="flex h-7 w-full min-w-0"
      inactive={!incompatible() && !authentication()}
      value={
        authentication()
          ? props.language.t("ssh.stage.authentication")
          : props.language.t("server.row.incompatible", { version: props.health?.version ?? "1" })
      }
    >
      <div
        class="group/server relative flex h-7 w-full min-w-0 items-center rounded-[6px]"
        data-home-row
        data-dimmed={!healthy() && !incompatible()}
        data-selected={props.selected ? "" : undefined}
      >
        <HomeProjectNavButton
          type="button"
          data-selected={props.selected ? "" : undefined}
          disabled={!healthy() && !authentication()}
          onClick={() => props.onFocusServer(props.server)}
        >
          <span
            data-action="home-server-collapse"
            class={`
            -ml-0.5 -mr-1.5 inline-flex size-5 shrink-0 items-center justify-center
            rounded-[4px] text-v2-icon-icon-muted
          `}
            classList={{
              "hover:bg-v2-overlay-simple-overlay-hover": canToggle(),
              "cursor-default opacity-40": !canToggle(),
            }}
            aria-label={
              props.collapsed ? props.language.t("home.server.expand") : props.language.t("home.server.collapse")
            }
            aria-disabled={!canToggle()}
            aria-expanded={canToggle() ? !props.collapsed : undefined}
            onClick={(event) => {
              event.preventDefault()
              event.stopPropagation()
              if (!canToggle()) return
              props.onToggleCollapsed(props.server)
            }}
            onPointerDown={(event) => event.preventDefault()}
          >
            <Icon
              name="chevron-down"
              size="small"
              class="transition-transform duration-150 ease-in-out"
              style={{ transform: `rotate(${props.collapsed || !canToggle() ? -90 : 0}deg)` }}
            />
          </span>
          <div class="flex size-4 shrink-0 items-center justify-center -mr-0.5">
            <ServerHealthIndicator
              health={props.health}
              connecting={props.server.type === "ssh" && props.server.connecting}
              authenticationRequired={authentication()}
            />
          </div>
          <span
            data-slot="home-row-label"
            class="flex min-w-0 flex-1 items-center gap-1"
            classList={{ "opacity-60": !healthy() && !incompatible() }}
          >
            <span class="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
              {props.server.displayName ?? new URL(props.server.http.url).host}
            </span>
            <Show when={props.server.label}>
              {(label) => (
                <span
                  class={`
                  shrink-0 rounded-[3px] border border-v2-border-border-base px-1 py-0.5
                  text-[9px] leading-none text-v2-text-text-muted
                `}
                >
                  {label()}
                </span>
              )}
            </Show>
          </span>
        </HomeProjectNavButton>
        <div
          data-slot="home-row-actions"
          class={`
          hover-reveal absolute bottom-0 right-1 top-0 flex items-center gap-1 rounded-r-[6px] pl-2
          group-hover/server:opacity-100 focus-within:opacity-100 data-[menu=true]:opacity-100
        `}
          data-menu={props.contextMenuOpen(contextMenuID())}
        >
          <ServerRowMenuView
            server={props.server}
            labels={serverMenuLabels(props.language)}
            canDefault={props.canDefaultServer}
            isDefault={props.defaultServerKey === ServerConnection.key(props.server)}
            canRemove={props.canRemoveServer(props.server)}
            canHide={props.canHideServer(props.server)}
            onEdit={props.onEditServer}
            onSetDefault={() => props.onSetDefaultServer(props.server)}
            onRemoveDefault={() => props.onSetDefaultServer(undefined)}
            onRemove={() => props.onRemoveServer(props.server)}
            onHide={() => props.onHideServer(props.server)}
            open={props.contextMenuOpen(contextMenuID())}
            onOpenChange={(open) => props.onSetContextMenuOpen(contextMenuID(), open)}
          />
          <Tooltip class="flex shrink-0 items-center" placement="bottom" value={props.language.t("home.project.add")}>
            <IconButton
              data-action="home-add-project"
              variant="ghost-muted"
              size="small"
              icon={<Icon name="folder-add-left" />}
              aria-label={props.language.t("home.project.add")}
              disabled={props.health?.healthy === false && !authentication()}
              onClick={() => props.onChooseProject(props.server)}
            />
          </Tooltip>
        </div>
      </div>
    </Tooltip>
  )
}

type HomeProjectsContextMenuProps = {
  contextMenuOpen: (id: string) => boolean
  onSetContextMenuOpen: (id: string, open: boolean) => void
}

type HomeProjectListProps = HomeProjectsViewProps &
  HomeProjectsContextMenuProps & {
    server: ServerConnection.Any
    items: LocalProject[]
  }

function HomeProjectList(props: HomeProjectListProps) {
  let listRef!: HTMLDivElement

  return (
    <DragDropProvider
      sensors={(defaults) => [
        ...defaults.filter((sensor) => sensor !== PointerSensor),
        PointerSensor.configure({
          activationConstraints: (event) =>
            event.pointerType === "touch"
              ? [new PointerActivationConstraints.Delay({ value: 250, tolerance: 5 })]
              : [new PointerActivationConstraints.Distance({ value: 4 })],
          preventActivation: (event) => event.target instanceof Element && !!event.target.closest("[data-action]"),
        }),
      ]}
      modifiers={[RestrictToVerticalAxis, RestrictToElement.configure({ element: () => listRef })]}
      plugins={(defaults) => [
        ...defaults.filter((plugin) => plugin !== AutoScroller && plugin !== Feedback),
        AutoScroller.configure({ acceleration: 8, threshold: { x: 0, y: 0.05 } }),
        Feedback.configure({ dropAnimation: null }),
      ]}
      onDragEnd={(event) => {
        const source = event.operation.source
        if (event.canceled || !isSortable(source)) return
        if (source.initialIndex !== source.index) props.onMoveProject(props.server, source.id.toString(), source.index)
        if (props.selection.server !== ServerConnection.key(props.server))
          props.onSelectProject(props.server, source.id.toString())
      }}
    >
      <div class="flex min-w-0 flex-col gap-1" ref={listRef}>
        {/* Keyed on worktree strings: the enriched project objects are
            recreated on every store or sync update, so iterating them directly
            remounts all rows — killing any in-flight drag activation (the
            row's sortable unregisters on unmount) and discarding animations.
            String keys keep row elements alive and move them on reorder. */}
        <For each={props.items.map((project) => project.worktree)}>
          {(worktree, index) => <HomeProjectSlot {...props} worktree={worktree} index={index()} />}
        </For>
      </div>
    </DragDropProvider>
  )
}

function HomeProjectSlot(
  props: HomeProjectListProps & {
    worktree: string
    index: number
  },
) {
  const initial = props.items.find((item) => item.worktree === props.worktree)
  if (!initial) return
  const project = createMemo<LocalProject>(
    (previous) => props.items.find((item) => item.worktree === props.worktree) ?? previous,
    initial,
  )

  return (
    <HomeProjectRow
      {...props}
      project={project()}
      server={props.server}
      index={props.index}
      serverSelected={props.selection.server === ServerConnection.key(props.server)}
      selected={
        props.selection.server === ServerConnection.key(props.server) && props.selection.directory === props.worktree
      }
      unseen={props.unseenCount(props.server, project())}
    />
  )
}

function HomeProjectEmpty(
  props: HomeProjectsViewProps & {
    server: ServerConnection.Any
    items: LocalProject[]
  },
) {
  const unreachable = () => props.serverHealth(props.server)?.healthy === false
  return (
    <div class="flex min-w-0 flex-col gap-1">
      <HomeProjectNavButton
        type="button"
        data-action="home-add-project-row"
        class="disabled:opacity-60 [&>[data-slot=icon-svg]]:text-v2-icon-icon-muted"
        disabled={unreachable()}
        onClick={() => props.onChooseProject(props.server)}
      >
        <Icon name="folder-add-left" size="small" />
        <span class={HOME_PROJECT_NAV_LABEL}>{props.language.t("home.project.add")}</span>
      </HomeProjectNavButton>
      <Show when={props.items.length > 0}>
        <div class="mt-3 flex h-7 min-w-0 shrink-0 items-center pl-1.5 pr-3">
          <div class="text-v2-text-text-faint [font-weight:530]">{props.language.t("home.recentlyClosed")}</div>
        </div>
        <For each={props.items}>
          {(project) => <HomeRecentlyClosedRow {...props} project={project} server={props.server} />}
        </For>
      </Show>
    </div>
  )
}

function HomeRecentlyClosedRow(
  props: HomeProjectsViewProps & {
    project: LocalProject
    server: ServerConnection.Any
  },
) {
  const unreachable = () => props.serverHealth(props.server)?.healthy === false
  const path = () => {
    const home = props.homedir
    const worktree = props.project.worktree
    if (home && (worktree === home || worktree.startsWith(`${home}/`))) return `~${worktree.slice(home.length)}`
    return worktree
  }
  return (
    <Tooltip placement="right" value={path()}>
      <HomeProjectNavButton
        type="button"
        data-component="home-recently-closed-row"
        class="disabled:opacity-60"
        disabled={unreachable()}
        onClick={() => props.onAddProjects(props.server, [props.project.worktree])}
      >
        <HomeProjectAvatar project={props.project} outline />
        <span class={HOME_PROJECT_NAV_LABEL}>{displayName(props.project)}</span>
      </HomeProjectNavButton>
    </Tooltip>
  )
}

function HomeProjectRow(
  props: HomeProjectsViewProps &
    HomeProjectsContextMenuProps & {
      project: LocalProject
      server: ServerConnection.Any
      index: number
      serverSelected: boolean
      selected: boolean
      unseen: number
    },
) {
  const platform = usePlatform()
  const serverUnreachable = () => props.serverHealth(props.server)?.healthy === false
  const sortable = useSortable({
    get id() {
      return props.project.worktree
    },
    get index() {
      return props.index
    },
  })
  let pointerDownSelected: boolean | undefined
  const contextMenuID = () => projectContextMenuID(props.server, props.project.worktree)
  onCleanup(() => {
    const id = contextMenuID()
    if (props.contextMenuOpen(id)) props.onSetContextMenuOpen(id, false)
  })
  return (
    <div
      ref={sortable.ref}
      class="group/project relative flex h-7 min-w-0 items-center rounded-[6px]"
      classList={{ "z-10": sortable.isDragSource() }}
      data-home-row
      data-dimmed={serverUnreachable()}
      data-dragging={sortable.isDragSource()}
      data-selected={props.selected ? "" : undefined}
      onContextMenu={(event) => {
        event.preventDefault()
        props.onSetContextMenuOpen(contextMenuID(), true)
      }}
    >
      <HomeProjectNavButton
        type="button"
        data-component="home-project-row"
        class="disabled:opacity-60"
        classList={{
          "bg-v2-background-bg-layer-01 text-v2-text-text-base": sortable.isDragSource(),
        }}
        data-selected={props.selected ? "" : undefined}
        aria-current={props.selected ? "page" : undefined}
        disabled={serverUnreachable()}
        onPointerDown={(event) => {
          // Same-server mouse selection happens on pointerdown (like tabs),
          // but only ever selects; selectProject toggles, and deselecting here
          // would fire on every drag before the threshold is met. Cross-server
          // selection waits for click so reordering a remote server's projects
          // does not focus that server and load its session index. Touch is
          // excluded so flick-scrolling the list cannot select rows.
          pointerDownSelected = undefined
          if (props.dropdown) return
          if (event.button !== 0 || event.pointerType === "touch") return
          if (!props.serverSelected) return
          pointerDownSelected = props.selected
          if (!props.selected) props.onSelectProject(props.server, props.project.worktree)
        }}
        onClick={(event) => {
          // The drag sensor calls preventDefault on post-drag clicks; never
          // toggle selection as part of a reorder.
          if (event.defaultPrevented) return
          // Keyboard activation and touch taps keep the original toggle.
          if (event.detail === 0 || pointerDownSelected === undefined) {
            props.onSelectProject(props.server, props.project.worktree)
            return
          }
          // Mouse: pointerdown already selected unselected rows; a plain click
          // on an already-selected row toggles it off.
          if (pointerDownSelected) props.onSelectProject(props.server, props.project.worktree)
          pointerDownSelected = undefined
        }}
      >
        <HomeProjectAvatar project={props.project} />
        <span data-slot="home-row-label" class={HOME_PROJECT_NAV_LABEL}>
          {displayName(props.project)}
        </span>
      </HomeProjectNavButton>
      <div
        data-slot="home-row-actions"
        class={`
          hover-reveal absolute bottom-0 right-1 top-0 flex items-center gap-1 rounded-r-[6px] pl-2
          group-hover/project:opacity-100 focus-within:opacity-100 data-[menu=true]:opacity-100
        `}
        data-menu={props.contextMenuOpen(contextMenuID())}
      >
        <Menu
          gutter={6}
          modal={false}
          placement="bottom-end"
          open={props.contextMenuOpen(contextMenuID())}
          onOpenChange={(open) => props.onSetContextMenuOpen(contextMenuID(), open)}
        >
          <Menu.Trigger
            as={IconButton}
            data-action="home-project-menu"
            variant="ghost-muted"
            size="small"
            icon={<Icon name="outline-dots" />}
            aria-label={props.language.t("common.moreOptions")}
          />
          <Menu.Portal>
            <Menu.Content>
              <Menu.Item onSelect={() => props.onOpenProjectNewSession(props.server, props.project.worktree)}>
                {props.language.t("command.session.new")}
              </Menu.Item>
              <Show when={props.canImportSession}>
                <Menu.Item onSelect={() => props.onImportSession(props.server, props.project)}>
                  {props.language.t("command.session.import")}
                </Menu.Item>
              </Show>
              <Menu.Item onSelect={() => props.onEditProject(props.server, props.project)}>
                {props.language.t("dialog.project.edit.title")}
              </Menu.Item>
              <Show when={props.canRevealProject(props.server)}>
                <Menu.Item onSelect={() => props.onRevealProject(props.server, props.project)}>
                  {props.language.t(
                    fileManagerApp(platform.platform === "desktop" ? (platform.os ?? "unknown") : "unknown")
                      .actionLabel,
                  )}
                </Menu.Item>
              </Show>
              <Menu.Item
                disabled={props.unseen === 0}
                onSelect={() => props.onClearNotifications(props.server, props.project)}
              >
                {props.language.t("sidebar.project.clearNotifications")}
              </Menu.Item>
              <Menu.Separator />
              <Menu.Item onSelect={() => props.onCloseProject(props.server, props.project.worktree)}>
                {props.language.t("common.close")}
              </Menu.Item>
            </Menu.Content>
          </Menu.Portal>
        </Menu>
        <IconButton
          data-action="home-project-new-session"
          variant="ghost-muted"
          size="small"
          icon={<Icon name="edit" />}
          aria-label={props.language.t("command.session.new")}
          onClick={() => props.onOpenProjectNewSession(props.server, props.project.worktree)}
        />
      </div>
    </div>
  )
}

function HomeProjectNavButton(props: JSX.ButtonHTMLAttributes<HTMLButtonElement>) {
  const [local, rest] = splitProps(props, ["class", "classList", "children"])
  return (
    <button
      {...rest}
      class={`
        flex h-7 min-w-0 w-full shrink-0 cursor-default items-center gap-2 rounded-[6px] bg-transparent px-1.5 text-left
        text-v2-text-text-muted [font-weight:440] transition-[background-color,color,box-shadow] duration-[120ms] ease-in-out
        hover:bg-v2-background-bg-layer-01 hover:text-v2-text-text-base
        data-[selected]:bg-v2-background-bg-layer-03 data-[selected]:text-v2-text-text-base
        data-[selected]:hover:bg-v2-background-bg-layer-03
        focus-visible:bg-v2-background-bg-layer-01 focus-visible:text-v2-text-text-base focus-visible:outline-none
        focus-visible:[box-shadow:inset_0_0_0_0.5px_var(--v2-border-border-muted)]
        ${local.class ?? ""}
      `}
      classList={local.classList}
    >
      {local.children}
    </button>
  )
}

function HomeProjectAvatar(props: { project: LocalProject; outline?: boolean }) {
  const name = createMemo(() => displayName(props.project))
  return (
    <ProjectAvatar
      fallback={name()}
      src={props.outline ? undefined : getProjectAvatarSource(props.project.id, props.project.icon)}
      variant={props.outline ? "outline" : getProjectAvatarVariant(props.project.icon?.color)}
    />
  )
}
