import { createMemo, createUniqueId, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { createQuery, keepPreviousData } from "@tanstack/solid-query"
import { Icon } from "@opencode/ui/icon"
import { SessionFilePanelV2, SessionFilePanelV2Empty } from "@opencode/session-ui/v2/session-file-panel-v2"
import { SessionReviewV2Sidebar } from "@opencode/session-ui/v2/session-review-v2"
import FileTreeV2, { type Kind } from "@/session/files/file-tree-v2"
import { useFile } from "@/workspaces/files/model"
import { useLanguage } from "@/runtime/i18n/language"
import { useWorkspaceLocation } from "@/workspaces/location"
import { useServerSDK } from "@/runtime/server/client"
import { displayName } from "@/shell/layout/helpers"
import { useSessionLayout } from "@/session/session-layout"
import { SessionFileView } from "@/session/files/file-tabs"
import { applyFileListKeyDown, SessionFileList } from "@/session/files/list"
import { pathKey } from "@/workspaces/path-key"
import { useServer } from "@/runtime/server/current"

const emptyFiles: string[] = []

export type SessionFileBrowserState = {
  sidebarOpened: () => boolean
  sidebarWidth: () => number
  sidebarTransition: () => boolean
  resizeSidebar: (width: number) => void
  toggleSidebar: () => void
}

export function SessionFileBrowserTab(props: {
  tab: string
  placeholder: boolean
  active?: string
  kinds: ReadonlyMap<string, Kind>
  state: SessionFileBrowserState
  onSelect: (path: string) => void
  onSelectPermanent: (path: string) => void
  filterRef?: (element: HTMLInputElement) => void
  mobile?: boolean
}) {
  const file = useFile()
  const language = useLanguage()
  const sdk = useWorkspaceLocation()
  const server = useServer()
  const serverSDK = useServerSDK()
  const { workspaceKey } = useSessionLayout()
  const resultsID = `session-file-browser-results-${createUniqueId()}`
  const [store, setStore] = createStore({ filter: "", explicitHighlight: undefined as string | undefined })
  const filter = () => store.filter
  const setFilter = (value: string) => setStore("filter", value)
  const setExplicitHighlight = (value: string) => setStore("explicitHighlight", value)
  const sidebarOpened = () => props.placeholder || props.state.sidebarOpened()
  const query = createMemo(() => filter().trim())
  const search = createQuery(() => {
    const value = query()
    return {
      queryKey: [serverSDK.scope, "session-open-file", workspaceKey(), value] as const,
      enabled: serverSDK.connection.status() === "connected" && value.length > 0,
      queryFn: ({ signal }) => file.searchFiles(value, { limit: 200, signal }),
      placeholderData: keepPreviousData,
    }
  })
  const files = createMemo(() => {
    if (!query() || search.isPending) return emptyFiles
    return [...new Set(search.data ?? emptyFiles)]
  })
  const highlighted = createMemo(() => {
    const values = files()
    if (values.length === 0) return undefined
    const explicit = store.explicitHighlight
    if (explicit && values.includes(explicit)) return explicit
    return values[0]
  })

  const loading = createMemo(() => query().length > 0 && search.isPending)
  const project = createMemo(() => {
    const directory = pathKey(sdk().directory)
    return server.ctx.projects
      .list()
      .find(
        (item) =>
          pathKey(item.worktree) === directory || item.sandboxes?.some((sandbox) => pathKey(sandbox) === directory),
      )
  })
  const title = createMemo(() => displayName(project() ?? { worktree: sdk().directory }))
  const optionID = (path: string) => `${resultsID}-option-${files().indexOf(path)}`

  const onFilterKeyDown = (event: KeyboardEvent & { currentTarget: HTMLInputElement }) => {
    if (event.key === "Escape" && query()) {
      event.preventDefault()
      setFilter("")
      return
    }
    if (!query()) return
    applyFileListKeyDown(event, files(), highlighted(), {
      onHighlight: setExplicitHighlight,
      onSelect: props.onSelectPermanent,
    })
  }

  // Keep the sidebar outside Kobalte Tabs.Content: a morphing content value
  // unmounts the whole panel on every file-tab switch and resets sidebar scroll.
  return (
    <SessionFilePanelV2
      toolbar={false}
      sidebar={
        <SessionReviewV2Sidebar
          open={sidebarOpened()}
          transition={props.state.sidebarTransition()}
          title={<span class="truncate">{title()}</span>}
          filter={filter()}
          onFilterChange={setFilter}
          onFilterKeyDown={onFilterKeyDown}
          filterAutofocus={props.placeholder && !props.mobile}
          filterRef={(element) => props.filterRef?.(element)}
          filterControls={resultsID}
          filterActiveDescendant={highlighted() ? optionID(highlighted()!) : undefined}
          filterExpanded={query().length > 0 && files().length > 0}
          width={props.state.sidebarWidth()}
          onWidthChange={props.mobile ? undefined : props.state.resizeSidebar}
        >
          <Show
            when={query()}
            fallback={
              <FileTreeV2
                active={props.active}
                kinds={props.kinds}
                draggable={!props.mobile}
                onFileClick={(node) => props.onSelect(node.path)}
                onFileDoubleClick={(node) => props.onSelectPermanent(node.path)}
              />
            }
          >
            <Show
              when={!loading()}
              fallback={
                <div role="status" class="px-2 py-2 text-12-regular text-text-weak">
                  {language.t("common.loading")}
                  {language.t("common.loading.ellipsis")}
                </div>
              }
            >
              <Show
                when={files().length > 0}
                fallback={
                  <div role="status" class="px-2 py-2 text-12-regular text-text-weak">
                    {language.t("palette.empty")}
                  </div>
                }
              >
                <SessionFileList
                  id={resultsID}
                  role="listbox"
                  optionID={optionID}
                  files={files()}
                  kinds={props.kinds}
                  active={props.active}
                  highlighted={highlighted()}
                  onFileClick={(path) => {
                    setExplicitHighlight(path)
                    props.onSelect(path)
                  }}
                  onFileDoubleClick={props.onSelectPermanent}
                />
              </Show>
            </Show>
          </Show>
        </SessionReviewV2Sidebar>
      }
    >
      <Show
        when={!props.placeholder}
        fallback={
          <SessionFilePanelV2Empty>
            <div class="flex flex-col items-center gap-2 text-center text-text-weak">
              <Icon name="file-tree" size="large" class="mb-2" />
              <div class="text-[13px] font-medium leading-[13px] text-text-strong">{language.t("command.file.open")}</div>
              <div class="h-5 text-13-regular leading-5">{language.t("session.files.selectToOpen")}</div>
            </div>
          </SessionFilePanelV2Empty>
        }
      >
        <div class="min-h-0 flex-1">
          <Show when={props.tab} keyed>
            {(tab) => <SessionFileView tab={tab} />}
          </Show>
        </div>
      </Show>
    </SessionFilePanelV2>
  )
}
