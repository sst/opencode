import type { Component } from "solid-js"
import { For, Show, createEffect, createMemo, createSignal } from "solid-js"
import { createStore } from "solid-js/store"
import { createResizeObserver } from "@solid-primitives/resize-observer"
import { Key } from "@solid-primitives/keyed"
import type { SessionInfo } from "@opencode/client/promise"
import { useQuery, useQueryClient } from "@tanstack/solid-query"
import { Button } from "@opencode/ui/button"
import { Dialog, DialogFooter, DialogHeader, DialogTitleGroup } from "@opencode/ui/dialog"
import { Icon } from "@opencode/ui/icon"
import { IconButton } from "@opencode/ui/icon-button"
import { Menu } from "@opencode/ui/menu"
import { Tooltip } from "@opencode/ui/tooltip"
import { useDialog } from "@opencode/ui/context/dialog"
import { getFilename } from "@opencode/util/path"
import { useLanguage } from "@/runtime/i18n/language"
import { useServer } from "@/runtime/server/current"
import { showToast } from "@/shell/notifications/toast"
import { getRelativeTime } from "@/shell/time"
import { sessionLabel } from "@/session/title"
import { pathKey } from "@/workspaces/path-key"
import { worktreeInventoryKey } from "@/workspaces/inventory"
import { SettingsList } from "@/settings/list"
import { useTabs } from "@/shell/tabs/tabs"
import { usePlatform } from "@/runtime/platform/platform"
import { clearWorkspaceTerminals } from "@/session/terminal/context"
import { ServerConnection } from "@/runtime/server/registry"
import type { Project } from "@/runtime/server/types"
import {
  containsDirectory,
  filterWorkspaceInventory,
  inspectWorkspaceDeletion,
  managedWorkspaceDirectories,
  mergeWorkspaceSessionInventory,
  removeWorkspacesSequentially,
  sessionsForWorkspace,
  type WorkspaceDeleteInspection,
  workspaceInventory,
} from "@/workspaces/paths"
import { listAllSessions } from "@/session/list"
import type { ServerScope } from "@/runtime/server/scope"
import { workspaceInventoryQuery } from "./queries"
import "@/settings/settings.css"

type Workspace = {
  directory: string
  project: Project
}

export const SettingsWorkspaces: Component<{
  activeDirectory?: string
  resetProjectFilter?: () => number
  projectID?: string
}> = (props) => {
  const dialog = useDialog()
  const language = useLanguage()
  const server = useServer()
  const serverSDK = server.ctx.sdk
  const queryClient = useQueryClient()
  const data = server.ctx.data
  const tabs = useTabs()
  const platform = usePlatform()
  const [store, setStore] = createStore({
    project: "all",
    transaction: undefined as "confirm" | "running" | undefined,
    deleting: [] as string[],
    removing: [] as string[],
  })
  createEffect(() => {
    if (props.projectID) {
      setStore("project", props.projectID)
      return
    }
    props.resetProjectFilter?.()
    setStore("project", "all")
  })

  const projectQuery = useQuery(() => ({
    ...workspaceInventoryQuery(server.ctx, queryClient, props.projectID),
    enabled: serverSDK.connection.status() === "connected",
    refetchOnMount: true,
  }))
  const inventory = createMemo(() => (projectQuery.isPending ? [] : (projectQuery.data ?? [])))
  const workspaces = createMemo(() => workspaceInventory(inventory()))
  const projects = createMemo(() => inventory().filter((project) => managedWorkspaceDirectories(project).length > 0))
  const projectName = (project: Project) => project.name || getFilename(project.worktree)
  const projectOptions = createMemo(() => [
    { id: "all", label: language.t("settings.workspaces.filter.all") },
    ...projects().map((project) => ({ id: project.id, label: projectName(project) })),
  ])
  const selectedProject = createMemo(() =>
    props.projectID
      ? props.projectID
      : store.project === "all" || projects().some((project) => project.id === store.project)
        ? store.project
        : "all",
  )
  const filtered = createMemo(() => filterWorkspaceInventory(workspaces(), selectedProject()))
  const captureDeleteContext = () => {
    const sdk = serverSDK
    return {
      sdk,
      data,
      server: ServerConnection.key(sdk.server),
      activeDirectory: props.activeDirectory,
    }
  }
  // Fetch sessions per workspace directory instead of paging through every session on the server.
  const loadSessions = async (directories: readonly string[], context = captureDeleteContext()) => {
    const fetched = await Promise.all(
      directories.map((directory) => listAllSessions(context.sdk.api.session, { order: "desc", directory })),
    )
    const sessions = fetched.flat()
    return mergeWorkspaceSessionInventory(sessions, context.data.session.list())
  }
  const workspaceDirectories = createMemo(() => workspaces().map((workspace) => workspace.directory))
  const sessionQuery = useQuery(() => ({
    queryKey: [
      serverSDK.scope,
      null,
      "settings-workspace-sessions",
      workspaceDirectories().map((directory) => String(pathKey(directory))),
    ] as const,
    queryFn: () => loadSessions(workspaceDirectories()),
    enabled: serverSDK.connection.status() === "connected" && workspaceDirectories().length > 0,
    placeholderData: (previous) => previous,
    refetchOnMount: "always",
  }))
  const sessionsByWorkspace = createMemo(() => {
    const sessions = mergeWorkspaceSessionInventory(
      sessionQuery.isPending ? [] : (sessionQuery.data ?? []),
      data.session.list(),
    )
    return new Map(
      workspaces().map((workspace) => [
        pathKey(workspace.directory),
        sessionsForWorkspace(sessions, workspace.directory),
      ]),
    )
  })
  const workspaceSessions = (workspace: Workspace) => sessionsByWorkspace().get(pathKey(workspace.directory)) ?? []
  const workspacesWithoutSessions = createMemo(() => {
    if (sessionQuery.isPending || sessionQuery.isError || sessionQuery.isPlaceholderData) return []
    return filtered().filter((workspace) => workspaceSessions(workspace).length === 0)
  })
  const sessionCount = (workspace: Workspace) => {
    const count = workspaceSessions(workspace).length
    if (!count && sessionQuery.isPending) return language.t("session.messages.loading")
    if (!count && sessionQuery.isError) return language.t("common.requestFailed")
    if (selectedProject() !== "all") return language.plural("settings.workspaces.sessions.filtered", count, { count })
    const project = projectName(workspace.project)
    const label = language.plural("settings.workspaces.sessions", count, {
      count,
      project,
    })
    const start = label.lastIndexOf(project)
    if (start < 0) return label
    return (
      <>
        {label.slice(0, start)}
        <span class="settings-workspaces-meta-project">{project}</span>
        {label.slice(start + project.length)}
      </>
    )
  }
  const lastActive = (workspace: Workspace) => {
    const updated = workspaceSessions(workspace)[0]?.time.updated
    if (!updated) return undefined
    return getRelativeTime(new Date(updated).toISOString(), language.t)
  }
  const sessionTime = (session: SessionInfo) => {
    if (!session.time.updated) return undefined
    return getRelativeTime(new Date(session.time.updated).toISOString(), language.t)
  }

  const inspect = async (workspace: Workspace, context = captureDeleteContext()) => {
    const [working, branch, sessions] = await Promise.all([
      context.sdk.api.vcs.status({ location: { directory: workspace.directory } }),
      context.sdk.api.vcs.diff({ location: { directory: workspace.directory }, mode: "branch" }),
      loadSessions([workspace.directory], context),
    ])
    const result = inspectWorkspaceDeletion({
      workspace: workspace.directory,
      activeDirectory: context.activeDirectory,
      sessions,
      status: working.data.length > 0 || branch.data.length > 0 ? "dirty" : "clean",
    })
    return { result, sessions }
  }
  const inspectionMessages = (result: WorkspaceDeleteInspection) => {
    const messages = [
      result.linked ? language.t("settings.workspaces.delete.blocked.linked") : undefined,
      result.dirty ? language.t("workspace.status.dirty") : undefined,
    ].filter((message): message is string => message !== undefined)
    return messages
  }
  const blocked = (result: WorkspaceDeleteInspection) => {
    showToast({
      variant: "error",
      title: language.t("workspace.delete.failed.title"),
      description: result.active
        ? language.t("settings.workspaces.delete.blocked.active")
        : inspectionMessages(result)[0],
    })
  }

  const remove = async (workspace: Workspace, force = false, context = captureDeleteContext()) => {
    const key = String(pathKey(workspace.directory))
    setStore("deleting", (items) => [...items, key])
    try {
      const preflight = await inspect(workspace, context)
      if (!force && (preflight.result.active || preflight.result.linked || preflight.result.dirty)) {
        blocked(preflight.result)
        return
      }
      const removed = await context.sdk.api.worktree
        .remove({
          location: { directory: workspace.project.worktree },
          directory: workspace.directory,
          force,
        })
        .then(() => true)
        .catch((error) => {
          showToast({
            variant: "error",
            title: language.t("workspace.delete.failed.title"),
            description: error instanceof Error ? error.message : language.t("common.requestFailed"),
          })
          return false
        })
      if (!removed) return
      setStore("removing", (items) => [...items, key])
      await new Promise((resolve) => setTimeout(resolve, 150))
      tabs.store.forEach((tab) => {
        if (tab.type !== "draft" || tab.server !== context.server) return
        const directoryMatches = containsDirectory(workspace.directory, tab.directory)
        const worktreeMatches = tab.worktree && containsDirectory(workspace.directory, tab.worktree)
        if (!directoryMatches && !worktreeMatches) return
        tabs.updateDraft(tab.draftID, {
          directory: directoryMatches ? workspace.project.worktree : tab.directory,
          worktree: undefined,
        })
      })
      clearWorkspaceTerminals(workspace.directory, platform, context.sdk.scope)
      await queryClient.invalidateQueries({
        queryKey: worktreeInventoryKey(context.sdk.scope, workspace.project.worktree),
      })
      await queryClient.invalidateQueries({ queryKey: [context.sdk.scope, "settings-workspace-inventory"] })
    } finally {
      setStore("deleting", (items) => items.filter((item) => item !== key))
      setStore("removing", (items) => items.filter((item) => item !== key))
    }
  }

  let inspectionID = 0
  const releaseConfirmation = () => {
    if (store.transaction === "confirm") setStore("transaction", undefined)
  }
  const transact = async (task: () => Promise<void>) => {
    if (store.transaction !== "confirm") return
    setStore("transaction", "running")
    try {
      await task()
    } catch (error) {
      showToast({
        variant: "error",
        title: language.t("workspace.delete.failed.title"),
        description: error instanceof Error ? error.message : language.t("common.requestFailed"),
      })
    } finally {
      setStore("transaction", undefined)
    }
  }
  const confirmDelete = (workspace: Workspace) => {
    if (store.transaction) return
    const context = captureDeleteContext()
    const current = ++inspectionID
    setStore("transaction", "confirm")
    void dialog.push(
      () => (
        <DialogDeleteWorkspace
          workspace={workspace}
          scope={context.sdk.scope}
          inspectionID={current}
          inspect={() => inspect(workspace, context)}
          inspectionMessages={inspectionMessages}
          onDelete={() => transact(() => remove(workspace, true, context))}
        />
      ),
      releaseConfirmation,
    )
  }
  const removeAll = async (inventory: Workspace[], context: ReturnType<typeof captureDeleteContext>) => {
    await removeWorkspacesSequentially(inventory, (workspace) => remove(workspace, false, context))
  }
  const confirmDeleteAll = () => {
    if (store.transaction) return
    const context = captureDeleteContext()
    const inventory = [...filtered()]
    setStore("transaction", "confirm")
    void dialog.push(
      () => (
        <DialogDeleteWorkspaces
          title={language.t("settings.workspaces.deleteAll")}
          confirmation={language.plural("settings.workspaces.deleteAll.confirm", inventory.length)}
          warning={language.t("settings.workspaces.deleteAll.warning")}
          onDelete={() => transact(() => removeAll(inventory, context))}
        />
      ),
      releaseConfirmation,
    )
  }
  const confirmDeleteWithoutSessions = () => {
    if (store.transaction || workspacesWithoutSessions().length === 0) return
    const context = captureDeleteContext()
    const inventory = [...workspacesWithoutSessions()]
    setStore("transaction", "confirm")
    void dialog.push(
      () => (
        <DialogDeleteWorkspaces
          title={language.t("settings.workspaces.deleteWithoutSessions")}
          confirmation={language.plural("settings.workspaces.deleteWithoutSessions.confirm", inventory.length)}
          warning={language.t("settings.workspaces.deleteWithoutSessions.warning")}
          onDelete={() => transact(() => removeAll(inventory, context))}
        />
      ),
      releaseConfirmation,
    )
  }

  return (
    <>
      <div class="settings-tab-header settings-workspaces-header">
        <div class="settings-tab-header-row">
          <div class="flex flex-col gap-1">
            <h2 class="settings-tab-title">{language.t("settings.tab.workspaces")}</h2>
            <span class="text-11-regular text-v2-text-text-muted">{language.t("settings.workspaces.description")}</span>
          </div>
        </div>
      </div>

      <div class="settings-tab-body settings-workspaces">
        <Show when={filtered().length > 0}>
          <div class="settings-workspaces-toolbar">
            <span class="settings-section-title">
              {language.plural("settings.workspaces.count", filtered().length)}
            </span>
            <div class="settings-workspaces-toolbar-actions">
              <Show when={!props.projectID && projects().length > 1}>
                <Menu placement="bottom-end" gutter={6}>
                  <Menu.Trigger as={Button} size="small" variant="ghost-muted" class="max-w-48">
                    <span class="min-w-0 truncate">
                      {projectOptions().find((option) => option.id === selectedProject())?.label}
                    </span>
                    <Icon name="chevron-down" size="small" class="shrink-0 text-v2-icon-icon-muted" />
                  </Menu.Trigger>
                  <Menu.Portal>
                    <Menu.Content>
                      <For each={projectOptions()}>
                        {(option) => (
                          <Menu.Item onSelect={() => setStore("project", option.id)}>
                            <span class="min-w-0 flex-1 truncate">{option.label}</span>
                            <Show when={selectedProject() === option.id}>
                              <Icon name="check" size="small" class="shrink-0" />
                            </Show>
                          </Menu.Item>
                        )}
                      </For>
                    </Menu.Content>
                  </Menu.Portal>
                </Menu>
              </Show>
              <Menu placement="bottom-end" gutter={4}>
                <Menu.Trigger
                  as={IconButton}
                  type="button"
                  variant="ghost-muted"
                  size="small"
                  aria-label={language.t("common.moreOptions")}
                  disabled={!!store.transaction}
                  icon={<Icon name="outline-dots" size="small" />}
                />
                <Menu.Portal>
                  <Menu.Content>
                    <Show when={workspacesWithoutSessions().length > 0}>
                      <Menu.Item onSelect={confirmDeleteWithoutSessions}>
                        {language.t("settings.workspaces.deleteWithoutSessions")}
                      </Menu.Item>
                      <Menu.Separator />
                    </Show>
                    <Menu.Item onSelect={confirmDeleteAll}>
                      <span class="settings-workspaces-delete-all">{language.t("settings.workspaces.deleteAll")}</span>
                    </Menu.Item>
                  </Menu.Content>
                </Menu.Portal>
              </Menu>
            </div>
          </div>
        </Show>

        <div class="settings-workspaces-inventory" data-empty={filtered().length === 0}>
          <SettingsList>
            <div class="settings-workspaces-empty-motion" data-visible={filtered().length === 0}>
              <div class="settings-workspaces-empty">
                <Show
                  when={!projectQuery.isPending && !projectQuery.isError}
                  fallback={language.t(projectQuery.isPending ? "common.loading" : "common.requestFailed")}
                >
                  <span class="settings-workspaces-empty-title">{language.t("settings.workspaces.empty")}</span>
                  <span>{language.t("settings.workspaces.empty.description")}</span>
                </Show>
              </div>
            </div>
            <Key each={filtered()} by={(workspace) => `${workspace.project.id}:${pathKey(workspace.directory)}`}>
              {(workspace) => {
                const linked = () => workspaceSessions(workspace())
                const key = () => String(pathKey(workspace().directory))
                const deleting = () => store.deleting.includes(key())
                return (
                  <div class="settings-workspaces-row-motion" data-removing={store.removing.includes(key())}>
                    <div class="settings-workspaces-row">
                      <div class="settings-workspaces-row-header">
                        <div class="settings-workspaces-copy">
                          <div class="settings-workspaces-main">
                            <WorkspacePath directory={workspace().directory} />
                          </div>
                          <span class="settings-workspaces-meta">{sessionCount(workspace())}</span>
                        </div>
                        <div class="settings-workspaces-row-actions">
                          <Show
                            when={deleting()}
                            fallback={
                              <>
                                <Show when={lastActive(workspace())}>
                                  {(value) => (
                                    <Tooltip
                                      value={language.t("settings.workspaces.lastActiveSession")}
                                      placement="top-end"
                                    >
                                      <span tabIndex={0} class="settings-workspaces-active">
                                        {value()}
                                      </span>
                                    </Tooltip>
                                  )}
                                </Show>
                                <IconButton
                                  type="button"
                                  variant="ghost-muted"
                                  size="small"
                                  aria-label={language.t("workspace.delete.confirm", {
                                    name: getFilename(workspace().directory),
                                  })}
                                  disabled={!!store.transaction}
                                  icon={<Icon name="outline-trash" size="small" />}
                                  onClick={() => confirmDelete(workspace())}
                                />
                              </>
                            }
                          >
                            <span class="settings-workspaces-active">{language.t("workspace.lifecycle.deleting")}</span>
                          </Show>
                        </div>
                      </div>
                      <Show when={linked().length > 0}>
                        <div class="settings-workspaces-sessions">
                          <For each={linked()}>
                            {(session) => (
                              <div class="settings-workspaces-session">
                                <span>{sessionLabel(session)}</span>
                                <Show when={linked().length > 1 ? sessionTime(session) : undefined}>
                                  {(time) => <span class="settings-workspaces-session-time">{time()}</span>}
                                </Show>
                              </div>
                            )}
                          </For>
                        </div>
                      </Show>
                    </div>
                  </div>
                )
              }}
            </Key>
          </SettingsList>
        </div>
      </div>
    </>
  )
}

function WorkspacePath(props: { directory: string }) {
  const [truncated, setTruncated] = createSignal(false)
  const name = () => getFilename(props.directory)

  return (
    <Tooltip
      value={props.directory}
      placement="top-start"
      disabled={!truncated()}
      contentClass="max-w-[calc(100vw-32px)] break-all"
    >
      <span
        ref={(element) => createResizeObserver(element, () => setTruncated(element.scrollWidth > element.clientWidth))}
        tabIndex={truncated() ? 0 : undefined}
        dir="ltr"
        aria-label={props.directory}
        class="settings-workspaces-path"
      >
        <span>{props.directory.slice(0, -name().length)}</span>
        <span class="settings-workspaces-path-name">{name()}</span>
      </span>
    </Tooltip>
  )
}

function DialogDeleteWorkspaces(props: {
  title: string
  confirmation: string
  warning: string
  onDelete: () => Promise<void>
}) {
  const dialog = useDialog()
  const language = useLanguage()
  const remove = () => {
    const deleting = props.onDelete()
    dialog.close()
    void deleting
  }

  return (
    <Dialog fit>
      <DialogHeader>
        <DialogTitleGroup
          title={props.title}
          description={
            <div class="flex flex-col gap-2">
              <div>{props.confirmation}</div>
              <div>{props.warning}</div>
            </div>
          }
        />
      </DialogHeader>
      <DialogFooter>
        <Button type="button" variant="neutral" onClick={() => dialog.close()}>
          {language.t("common.cancel")}
        </Button>
        <Button type="button" variant="danger" onClick={remove}>
          {language.t("settings.workspaces.delete.button")}
        </Button>
      </DialogFooter>
    </Dialog>
  )
}

function DialogDeleteWorkspace(props: {
  workspace: Workspace
  scope: ServerScope
  inspectionID: number
  inspect: () => Promise<{ result: WorkspaceDeleteInspection; sessions: SessionInfo[] }>
  inspectionMessages: (result: WorkspaceDeleteInspection) => string[]
  onDelete: () => Promise<void>
}) {
  const dialog = useDialog()
  const language = useLanguage()
  const status = useQuery(() => ({
    queryKey: [props.scope, pathKey(props.workspace.directory), "workspace-delete-status", props.inspectionID] as const,
    queryFn: props.inspect,
    staleTime: 0,
  }))
  const descriptions = () => {
    if (status.isPending) return []
    if (status.isError) return [language.t("workspace.status.error")]
    if (!status.data) return []
    return props.inspectionMessages(status.data.result)
  }
  const remove = () => {
    const deleting = props.onDelete()
    dialog.close()
    void deleting
  }

  return (
    <Dialog fit>
      <DialogHeader>
        <DialogTitleGroup
          title={language.t("workspace.delete.confirm", { name: getFilename(props.workspace.directory) })}
          description={
            <div class="flex flex-col gap-2">
              <div class="flex flex-col gap-1">
                <span class="text-11-regular text-v2-text-text-faint">
                  {language.t(status.isPending ? "workspace.status.checking" : "workspace.delete.location")}
                </span>
                <code class="block w-fit max-w-full rounded-[4px] bg-[color-mix(in_oklch,var(--v2-text-text-base)_8%,transparent)] px-1 py-0.5 font-mono text-xs font-medium leading-4 text-v2-text-text-base break-all">
                  {props.workspace.directory}
                </code>
              </div>
              <div>{language.t("settings.workspaces.delete.warning")}</div>
              <For each={descriptions()}>{(description) => <div>{description}</div>}</For>
            </div>
          }
        />
      </DialogHeader>
      <DialogFooter>
        <Button type="button" variant="neutral" onClick={() => dialog.close()}>
          {language.t("common.cancel")}
        </Button>
        <Button type="button" variant="danger" disabled={status.isPending || status.isError} onClick={remove}>
          {language.t("workspace.delete.button")}
        </Button>
      </DialogFooter>
    </Dialog>
  )
}
