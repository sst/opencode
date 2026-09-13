import type { SessionInfo } from "@opencode/client/promise"
import { Icon } from "@opencode/ui/icon"
import { IconButton } from "@opencode/ui/icon-button"
import { Menu } from "@opencode/ui/menu"
import { ProjectAvatar } from "@opencode/ui/project-avatar"
import { Tooltip } from "@opencode/ui/tooltip"
import { createResizeObserver } from "@solid-primitives/resize-observer"
import { useNavigate } from "@solidjs/router"
import { createMemo, Show, type ParentProps } from "solid-js"
import { createStore } from "solid-js/store"
import { useServer } from "@/runtime/server/current"
import { ServerConnection } from "@/runtime/server/registry"
import { useLanguage } from "@/runtime/i18n/language"
import { usePlatform } from "@/runtime/platform/platform"
import { displayName, errorMessage, getProjectAvatarSource, projectForSession } from "@/shell/layout/helpers"
import { getProjectAvatarVariant, useLayout, type LocalProject } from "@/shell/state/layout"
import { tabKey, useTabs } from "@/shell/tabs/tabs"
import { useSettings } from "@/settings/model"
import { useSettingsSurface } from "@/settings/surface"
import { pathKey } from "@/workspaces/path-key"
import { isProjectDirectory, isWorkspaceDirectory } from "@/workspaces/paths"
import { sessionHref } from "@/shell/routes/session"
import { showToast } from "@/shell/notifications/toast"
import { sessionTitle } from "./title"
import "./session-identity-header.css"

export function SessionTitleHeader(props: ParentProps) {
  return (
    <div
      data-session-title
      class="sticky top-0 z-30 w-full bg-[linear-gradient(to_bottom,var(--v2-background-bg-base)_48px,transparent)] pb-4 pe-3 ps-2.5"
    >
      {props.children}
    </div>
  )
}

export function SessionProjectMenu(props: {
  project?: Omit<LocalProject, "expanded">
  directory?: string
  workspace: boolean
  showProjectIcon: boolean
}) {
  const server = useServer()
  const language = useLanguage()
  const platform = usePlatform()
  const layout = useLayout()
  const settingsSurface = useSettingsSurface()
  const navigate = useNavigate()
  const [state, setState] = createStore({
    open: false,
    projectTruncated: false,
    pathTruncated: false,
    pathFocused: false,
  })
  const projectName = createMemo(() => displayName(props.project ?? { worktree: props.directory ?? "" }))
  const canOpenPath = () =>
    platform.platform === "desktop" && !!platform.openPath && server.isLocal && !!props.directory
  const openPath = () => {
    if (!canOpenPath() || !platform.openPath || !props.directory) return
    void platform.openPath(props.directory).catch((cause: unknown) =>
      showToast({
        title: language.t("common.requestFailed"),
        description: errorMessage(cause, language.t("common.requestFailed")),
      }),
    )
  }
  const openProjectSettings = () => {
    const current = props.project
    if (!current) return
    settingsSurface.openProject({
      server: ServerConnection.key(server.conn),
      project: current.worktree,
    })
  }

  return (
    <Menu
      placement="bottom-start"
      gutter={4}
      shift={-10}
      modal={false}
      open={state.open}
      onOpenChange={(open) => setState({ open, pathFocused: false })}
    >
      <Tooltip placement="bottom" value={<bdi>{projectName()}</bdi>} class="flex shrink-0">
        <Menu.Trigger
          as={IconButton}
          variant="ghost-muted"
          aria-label={projectName()}
          data-slot="session-project-trigger"
          icon={
            <Show
              when={props.showProjectIcon}
              fallback={
                <span class={props.workspace ? "text-v2-icon-icon-accent" : "text-v2-icon-icon-muted"}>
                  <Icon name={props.workspace ? "outline-worktree" : "monitor"} />
                </span>
              }
            >
              <ProjectAvatar
                fallback={projectName()}
                src={getProjectAvatarSource(props.project?.id, props.project?.icon)}
                variant={getProjectAvatarVariant(props.project?.icon?.color)}
              />
            </Show>
          }
        />
      </Tooltip>
      <Menu.Portal>
        <Menu.Content class="w-max max-w-[min(320px,calc(100vw-16px))]" aria-label={projectName()}>
          <Tooltip
            placement="top"
            gutter={2}
            disabled={!state.projectTruncated}
            class="min-w-0 cursor-default"
            contentClass="session-project-info-tooltip max-w-[min(480px,calc(100vw-16px))] whitespace-normal break-all"
            value={<bdi>{projectName()}</bdi>}
          >
            <Menu.Item
              class="min-w-0 w-full"
              disabled={!props.project}
              onSelect={() => {
                const project = props.project
                if (!project) return
                server.ctx.projects.open(project.worktree)
                layout.home.setSelection({ server: server.key, directory: project.worktree })
                navigate("/")
              }}
            >
              <span class="session-project-link-content">
                <ProjectAvatar
                  class="shrink-0"
                  aria-hidden="true"
                  fallback={projectName()}
                  src={getProjectAvatarSource(props.project?.id, props.project?.icon)}
                  variant={getProjectAvatarVariant(props.project?.icon?.color)}
                />
                <bdi
                  ref={(element) =>
                    createResizeObserver(element, () =>
                      setState("projectTruncated", element.scrollWidth > element.clientWidth),
                    )
                  }
                  class="min-w-0 truncate text-13-medium"
                >
                  {projectName()}
                </bdi>
              </span>
            </Menu.Item>
          </Tooltip>
          <Tooltip
            placement="top"
            gutter={2}
            disabled={!state.pathTruncated}
            forceOpen={state.pathFocused && state.pathTruncated ? true : undefined}
            class="min-w-0 cursor-default"
            contentClass="session-project-info-tooltip max-w-[min(480px,calc(100vw-16px))] whitespace-normal break-all"
            value={<bdi dir="ltr">{props.directory}</bdi>}
          >
            {/* Read-only paths stay in keyboard navigation so their full tooltip remains accessible. */}
            <Menu.Item
              class="session-project-link min-w-0 w-full cursor-default"
              disabled={!props.directory}
              aria-disabled={!canOpenPath()}
              closeOnSelect={canOpenPath()}
              onSelect={openPath}
              onFocus={() => setState("pathFocused", true)}
              onBlur={() => setState("pathFocused", false)}
              onKeyDown={(event) => {
                if (event.key !== "Escape") return
                event.preventDefault()
                event.stopPropagation()
                setState({ open: false, pathFocused: false })
              }}
            >
              <span class="session-project-link-content">
                <Icon name="folder" class="shrink-0 text-v2-icon-icon-muted" />
                <bdi
                  ref={(element) =>
                    createResizeObserver(element, () =>
                      setState("pathTruncated", element.scrollWidth > element.clientWidth),
                    )
                  }
                  dir="ltr"
                  class="min-w-0 truncate text-v2-text-text-muted"
                >
                  {props.directory}
                </bdi>
              </span>
              <span data-slot="session-project-open-icon" class="session-project-link-open" aria-hidden="true">
                <Icon name="arrow-up-right" />
              </span>
            </Menu.Item>
          </Tooltip>
          <Menu.Separator />
          <Menu.Item disabled={!props.project} onSelect={openProjectSettings}>
            <Icon name="settings-gear" class="text-v2-icon-icon-muted" />
            {language.t("project.settings.title")}
          </Menu.Item>
        </Menu.Content>
      </Menu.Portal>
    </Menu>
  )
}

export function SessionIdentityHeader(props: { sessionID: string; session?: SessionInfo }) {
  const server = useServer()
  const tabs = useTabs()
  const language = useLanguage()
  const pending = createMemo(() => tabs.pendingSession(server.key, props.sessionID))
  const settings = useSettings()
  const navigate = useNavigate()
  const tab = createMemo(() =>
    tabs.store.find(
      (item) =>
        item.type === "session" &&
        item.server === server.key &&
        (item.sessionId === props.sessionID || item.routeSessionId === props.sessionID),
    ),
  )
  const info = createMemo(() => {
    const current = tab()
    return current ? tabs.info[tabKey(current)] : undefined
  })
  const parentID = createMemo(() => {
    if (props.session?.parentID) return props.session.parentID
    const current = tab()
    if (current?.type !== "session" || current.routeSessionId !== props.sessionID) return
    return current.routeParentId ?? current.sessionId
  })
  const parent = createMemo(() => {
    const id = parentID()
    return id ? server.ctx.data.session.get(id) : undefined
  })
  const parentTitle = createMemo(() => {
    const id = parentID()
    const current = tab()
    return sessionTitle(
      parent()?.title ?? (current?.type === "session" && current.sessionId === id ? info()?.title : undefined),
    )
  })
  const directory = createMemo(
    () => props.session?.location.directory ?? pending()?.draft.directory ?? info()?.directory,
  )
  const title = createMemo(() =>
    pending()
      ? language.t("session.tab.session")
      : sessionTitle(props.session?.title ?? (parentID() ? undefined : info()?.title)),
  )
  const project = createMemo(() => {
    const projects = server.ctx.projects.list()
    if (props.session)
      return (
        projectForSession(props.session, projects) ?? projectForSession(props.session, server.ctx.sync.data.project)
      )
    const value = directory()
    if (!value) return undefined
    const key = pathKey(value)
    return (
      projects.find(
        (item) => pathKey(item.worktree) === key || item.sandboxes?.some((sandbox) => pathKey(sandbox) === key),
      ) ?? server.ctx.sync.data.project.find((item) => isProjectDirectory(item, value))
    )
  })
  const showProjectIcon = () =>
    import.meta.env.VITE_OPENCODE_CHANNEL !== "prod" && settings.general.showProjectIcon() && !!directory()
  const workspaceSession = createMemo(() => !!pending() || isWorkspaceDirectory(project(), directory() ?? ""))
  const navigateParent = () => {
    const id = parentID()
    const current = tab()
    if (!id || current?.type !== "session") return
    tabs.rememberSessionRoute(current, id, parent()?.parentID)
    navigate(sessionHref(server.key, id))
  }

  return (
    <Show when={title() || parentTitle() || showProjectIcon()}>
      <SessionTitleHeader>
        <div class="flex h-12 w-full items-center justify-between gap-2">
          <div class="flex min-w-0 flex-1 items-center gap-1">
            <div class="flex min-w-0 w-full flex-1 items-center gap-0.5">
              <SessionProjectMenu
                project={project()}
                directory={directory()}
                workspace={workspaceSession()}
                showProjectIcon={showProjectIcon()}
              />
              <Show when={parentTitle()}>
                {(value) => (
                  <button
                    type="button"
                    data-slot="session-title-parent"
                    dir="auto"
                    class="min-w-0 max-w-[40%] truncate pl-2 text-[13px] font-[530] leading-4 tracking-[-0.04px] text-v2-text-text-faint transition-colors hover:text-v2-text-text-muted"
                    onClick={navigateParent}
                  >
                    {value()}
                  </button>
                )}
              </Show>
              <Show when={parentTitle() && title()}>
                <span
                  data-slot="session-title-separator"
                  class="-translate-y-[0.5px] pl-2 pr-1 text-[11px] font-medium text-v2-text-text-faint"
                  aria-hidden="true"
                >
                  /
                </span>
              </Show>
              <Show when={title()}>
                {(value) => (
                  <h1
                    data-slot={parentID() ? "session-title-child" : undefined}
                    dir="auto"
                    class="w-fit truncate rounded-[6px] px-1 py-1 text-[13px] font-[530] leading-4 tracking-[-0.04px] text-v2-text-text-base"
                  >
                    {value()}
                  </h1>
                )}
              </Show>
            </div>
          </div>
        </div>
      </SessionTitleHeader>
    </Show>
  )
}
