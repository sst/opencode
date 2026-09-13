import { createMemo, createSignal, For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { createResizeObserver } from "@solid-primitives/resize-observer"
import { Menu } from "@opencode/ui/menu"
import { Tooltip } from "@opencode/ui/tooltip"
import { Icon } from "@opencode/ui/icon"
import { getFilename } from "@opencode/util/path"
import { useLanguage } from "@/runtime/i18n/language"
import { sameDirectory } from "@/workspaces/paths"

export function PromptWorkspaceSelector(props: {
  value: string
  projectRoot: string
  workspaces: string[]
  branches: string[]
  branch?: string
  onboarding?: boolean
  variant?: "inline" | "summary"
  onChange: (value: string) => void
  onCreate: (branch: string) => void
  onSearch: (search: string) => void
  onDone?: () => void
  onViewAll: () => void
}) {
  const language = useLanguage()
  const summary = () => props.variant === "summary"
  const placement = createMemo(() =>
    summary() ? (language.direction() === "rtl" ? "right-start" : "left-start") : "bottom",
  )
  const [search, setSearch] = createStore({ workspaces: "", branches: "" })
  let searchInput: HTMLInputElement | undefined
  let branchSearchInput: HTMLInputElement | undefined
  let focusSearch = false
  const branchTruncation = createTruncatedText()
  const focusWorktreeSearch = () =>
    requestAnimationFrame(() => requestAnimationFrame(() => searchInput?.focus({ preventScroll: true })))
  let pending: { type: "select"; value: string } | { type: "create"; branch: string } | { type: "viewAll" } | undefined
  const selected = () => (sameDirectory(props.value, props.projectRoot) ? "main" : props.value)
  const workspaces = createMemo(() => {
    const query = search.workspaces.trim().toLowerCase()
    if (!query) return props.workspaces
    return props.workspaces.filter((workspace) => getFilename(workspace).toLowerCase().includes(query))
  })
  const icon = () => {
    if (selected() === "main") return "monitor"
    if (selected() === "create") return "plus"
    return "outline-worktree"
  }
  const select = (value: string) => {
    pending = { type: "select", value }
  }
  const onOpenChange = (open: boolean) => {
    if (open) {
      setSearch({ workspaces: "", branches: "" })
      props.onSearch("")
      return
    }
    const action = pending
    pending = undefined
    if (action?.type === "select") props.onChange(action.value)
    if (action?.type === "create") props.onCreate(action.branch)
    if (action?.type === "viewAll") {
      props.onViewAll()
      return
    }
    props.onDone?.()
  }
  const label = () => {
    if (selected() === "main")
      return language.t(summary() ? "session.new.workspace.local" : "session.new.workspace.triggerLocal")
    if (props.value === "create") return language.t("workspace.new")
    return getFilename(props.value)
  }

  return (
    <>
      <Show when={!summary()}>
        <span class="hidden select-none opacity-50 sm:inline mx-1">/</span>
      </Show>
      <Tooltip
        appearance={props.onboarding ? "large" : undefined}
        placement="top"
        openDelay={800}
        value={
          props.onboarding ? (
            <div class="flex flex-col gap-1 text-start">
              <div class="flex items-center gap-1.5 font-[530] text-v2-text-text-base">
                <Icon name="outline-worktree" size="small" class="shrink-0 text-v2-text-text-accent" />
                <span>{language.t("workspace.onboarding.title")}</span>
              </div>
              <span class="font-[440] text-v2-text-text-muted">{language.t("workspace.onboarding.description")}</span>
            </div>
          ) : (
            language.t("session.new.workspace.trigger.tooltip")
          )
        }
        contentClass={props.onboarding ? "max-w-[280px]" : undefined}
        class={summary() ? "min-w-0 w-full" : "min-w-0"}
      >
        <Menu
          placement={placement()}
          gutter={4}
          overflowPadding={24}
          modal={summary() ? false : undefined}
          onOpenChange={onOpenChange}
        >
          <Menu.Trigger
            aria-description={language.t("session.new.workspace.trigger.tooltip")}
            class={
              summary()
                ? "session-summary-row"
                : "flex h-6 min-w-0 max-w-[203px] items-center gap-1.5 rounded-sm px-1.5 hover:bg-v2-overlay-simple-overlay-hover focus-visible:bg-v2-overlay-simple-overlay-hover focus-visible:outline-none data-[expanded]:bg-v2-overlay-simple-overlay-pressed data-[expanded]:text-v2-text-text-muted"
            }
          >
            <Icon
              name={icon()}
              class={`shrink-0 ${summary() || selected() === "main" || selected() === "create" ? "text-v2-icon-icon-muted" : "text-v2-icon-icon-accent"}`}
            />
            <span class={summary() ? "session-summary-label" : "min-w-0 truncate"}>{label()}</span>
            <Show when={props.onboarding}>
              <span
                data-slot="workspace-onboarding-dot"
                aria-hidden="true"
                class="size-1.5 shrink-0 rounded-full bg-v2-text-text-accent"
              />
            </Show>
            <Icon
              name={summary() ? "fill-triangle-down" : "chevron-down"}
              size={summary() ? "normal" : "small"}
              class="session-summary-menu-indicator shrink-0 text-v2-icon-icon-muted"
            />
          </Menu.Trigger>
          <Menu.Portal>
            <Menu.Content class="w-[200px]">
              <Menu.Group>
                <Menu.GroupLabel>{language.t("session.new.workspace.runIn")}</Menu.GroupLabel>
                <Menu.Item onSelect={() => select("main")}>
                  <Icon name="monitor" />
                  <Tooltip
                    placement="right"
                    openDelay={800}
                    value={language.t("session.new.workspace.local.tooltip")}
                    contentClass="max-w-[140px]"
                    class="min-w-0 flex-1"
                  >
                    <span class="min-w-0 truncate">{language.t("session.new.workspace.local")}</span>
                  </Tooltip>
                  <Show when={selected() === "main"}>
                    <Icon name="check" size="small" class="shrink-0" />
                  </Show>
                </Menu.Item>
                <Menu.Item onSelect={() => select("create")}>
                  <Icon name="plus" />
                  <Tooltip
                    placement="right"
                    openDelay={800}
                    value={language.t("session.new.workspace.new.tooltip")}
                    contentClass="max-w-[140px]"
                    class="min-w-0 flex-1"
                  >
                    <span class="min-w-0 truncate">{language.t("workspace.new")}</span>
                  </Tooltip>
                  <Show when={selected() === "create"}>
                    <Icon name="check" size="small" class="shrink-0" />
                  </Show>
                </Menu.Item>
              </Menu.Group>
              <Show when={props.workspaces.length > 0}>
                <Menu.Separator class="h-[0.5px]" />
                <Menu.Sub
                  gutter={0}
                  overlap
                  overflowPadding={24}
                  onOpenChange={(open) => {
                    if (!open) {
                      focusSearch = false
                      return
                    }
                    if (!focusSearch || props.workspaces.length < 10) return
                    focusSearch = false
                    focusWorktreeSearch()
                  }}
                >
                  <Menu.SubTrigger
                    onClick={focusWorktreeSearch}
                    onKeyDown={(event) => {
                      if (
                        event.key === "ArrowRight" ||
                        event.key === "ArrowLeft" ||
                        event.key === "Enter" ||
                        event.key === " "
                      )
                        focusSearch = true
                    }}
                  >
                    <Icon name="outline-worktree" />
                    <span class="min-w-0 flex-1 truncate">
                      {language.t("session.new.workspace.existing").replace(/(…|\.{3})$/, "")}
                    </span>
                  </Menu.SubTrigger>
                  <Menu.Portal>
                    <Menu.SubContent class="max-h-[66.667dvh] w-[200px] overflow-y-auto !pb-0 [&>[data-component=menu-v2-item]:last-child]:mb-0.5 [@media(max-height:600px)]:max-h-[calc(100dvh-48px)]">
                      <Show when={props.workspaces.length >= 10}>
                        <div class="flex h-7 items-center gap-2 rounded-sm ps-3 pe-2 text-v2-icon-icon-muted">
                          <Icon name="magnifying-glass" size="small" class="shrink-0" />
                          <input
                            ref={(element) => {
                              searchInput = element
                            }}
                            value={search.workspaces}
                            placeholder={language.t("session.new.workspace.search.placeholder")}
                            aria-label={language.t("session.new.workspace.search.placeholder")}
                            class="h-7 min-w-0 flex-1 border-0 bg-transparent text-[13px] font-[440] leading-5 tracking-[-0.04px] text-v2-text-text-base outline-none placeholder:text-v2-text-text-faint"
                            onInput={(event) => setSearch("workspaces", event.currentTarget.value)}
                            onKeyDown={(event) => {
                              if (
                                event.key === "Escape" ||
                                event.key === "ArrowDown" ||
                                event.key === "ArrowUp" ||
                                event.key === "Enter"
                              )
                                return
                              event.stopPropagation()
                            }}
                          />
                        </div>
                      </Show>
                      <For each={workspaces()}>
                        {(workspace) => (
                          <Menu.Item onSelect={() => select(workspace)}>
                            <Icon name="outline-worktree" />
                            <span class="min-w-0 flex-1 truncate">{getFilename(workspace)}</span>
                            <Show when={selected() === workspace}>
                              <Icon name="check" size="small" class="shrink-0" />
                            </Show>
                          </Menu.Item>
                        )}
                      </For>
                      <Show when={search.workspaces.trim() && workspaces().length === 0}>
                        <div class="px-3 py-4 text-center text-[13px] font-[440] leading-5 text-v2-text-text-muted">
                          {language.t("session.new.workspace.search.empty")}
                        </div>
                      </Show>
                      <Menu.Separator class="h-[0.5px]" />
                      <Menu.Item onSelect={() => (pending = { type: "viewAll" })}>
                        <span class="min-w-0 flex-1 truncate">{language.t("common.viewAll")}</span>
                      </Menu.Item>
                    </Menu.SubContent>
                  </Menu.Portal>
                </Menu.Sub>
              </Show>
            </Menu.Content>
          </Menu.Portal>
        </Menu>
      </Tooltip>
      <Show
        when={selected() === "create" && props.branch}
        fallback={
          summary() ? (
            <Show when={props.branch}>
              <div class="session-summary-row">
                <Icon name="branch" class="shrink-0 text-v2-icon-icon-muted" />
                <span dir="auto" class="session-summary-label">
                  {props.branch}
                </span>
              </div>
            </Show>
          ) : (
            <PromptGitStatus branch={props.branch} from={selected() === "create"} class="ms-1" />
          )
        }
      >
        <Tooltip
          placement="top"
          value={language.t("session.new.workspace.fromBranch", { branch: props.branch! })}
          disabled={!branchTruncation.truncated()}
          class={summary() ? "min-w-0 w-full" : "ms-1 min-w-0 max-w-[220px]"}
          contentClass="max-w-[calc(100vw-32px)] break-all"
        >
          <Menu placement={placement()} gutter={4} modal={summary() ? false : undefined} onOpenChange={onOpenChange}>
            <Menu.Trigger
              class={
                summary()
                  ? "session-summary-row"
                  : "flex h-6 min-w-0 max-w-[220px] items-center gap-1.5 rounded-full bg-v2-background-bg-layer-02 px-2.5 text-[13px] font-[440] leading-5 tracking-[-0.04px] text-v2-text-text-faint transition-colors hover:bg-v2-background-bg-layer-03 hover:text-v2-text-text-muted focus-visible:bg-v2-background-bg-layer-03 focus-visible:text-v2-text-text-muted focus-visible:outline-none data-[expanded]:bg-v2-background-bg-layer-03 data-[expanded]:text-v2-text-text-muted"
              }
            >
              <Icon name="branch-out" size={summary() ? "normal" : "small"} class="shrink-0 text-v2-icon-icon-muted" />
              <span ref={branchTruncation.observe} class={summary() ? "session-summary-label" : "min-w-0 truncate"}>
                {language.t(summary() ? "session.summary.basedOn" : "session.new.workspace.fromBranch", {
                  branch: props.branch!,
                })}
              </span>
              <Icon
                name={summary() ? "fill-triangle-down" : "chevron-down"}
                size={summary() ? "normal" : "small"}
                class="session-summary-menu-indicator shrink-0 text-v2-icon-icon-muted"
              />
            </Menu.Trigger>
            <Menu.Portal>
              <Menu.Content
                class="w-[243px] overflow-hidden rounded-md border-0 bg-v2-background-bg-layer-01 shadow-[var(--v2-elevation-floating)] focus:outline-none"
                onOpenAutoFocus={(event) => {
                  event.preventDefault()
                  // Kobalte defers its list autofocus until after the focus scope opens.
                  setTimeout(() => requestAnimationFrame(() => branchSearchInput?.focus({ preventScroll: true })))
                }}
              >
                <div class="flex h-7 shrink-0 items-center gap-2 rounded-sm pl-3 pr-2.5 text-v2-icon-icon-muted">
                  <Icon name="magnifying-glass" size="small" class="shrink-0" />
                  <input
                    ref={(element) => {
                      branchSearchInput = element
                    }}
                    value={search.branches}
                    placeholder={language.t("session.new.workspace.branch.search.placeholder")}
                    aria-label={language.t("session.new.workspace.branch.search.placeholder")}
                    class="h-7 min-w-0 flex-1 border-0 bg-transparent text-[13px] font-[440] leading-5 tracking-[-0.04px] text-v2-text-text-base outline-none placeholder:text-v2-text-text-faint"
                    onInput={(event) => {
                      setSearch("branches", event.currentTarget.value)
                      props.onSearch(event.currentTarget.value)
                    }}
                    onKeyDown={(event) => {
                      if (
                        event.key === "Escape" ||
                        event.key === "ArrowDown" ||
                        event.key === "ArrowUp" ||
                        event.key === "Enter"
                      )
                        return
                      event.stopPropagation()
                    }}
                  />
                  <Show when={search.branches.trim()}>
                    <button
                      type="button"
                      class="flex size-5 items-center justify-center rounded-sm text-v2-icon-icon-muted hover:bg-v2-overlay-simple-overlay-hover"
                      onPointerDown={(event) => event.preventDefault()}
                      onClick={() => {
                        setSearch("branches", "")
                        props.onSearch("")
                      }}
                      aria-label={language.t("common.clear")}
                    >
                      <Icon name="close-small" size="small" />
                    </button>
                  </Show>
                </div>
                <div class="max-h-[224px] overflow-y-auto">
                  <Menu.RadioGroup value={props.branch}>
                    <For each={props.branches}>
                      {(branch) => (
                        <Menu.RadioItem
                          value={branch}
                          class="h-7 gap-2 rounded-sm px-3 text-[13px] font-[440] leading-5 tracking-[-0.04px] text-v2-text-text-base [font-family:var(--v2-font-family-sans)] data-[highlighted]:!bg-v2-overlay-simple-overlay-hover"
                          closeOnSelect
                          onSelect={() => (pending = { type: "create", branch })}
                        >
                          <span class="min-w-0 truncate leading-5">{branch}</span>
                        </Menu.RadioItem>
                      )}
                    </For>
                  </Menu.RadioGroup>
                </div>
              </Menu.Content>
            </Menu.Portal>
          </Menu>
        </Tooltip>
      </Show>
    </>
  )
}

export function PromptGitStatus(props: { branch?: string; noGit?: boolean; from?: boolean; class?: string }) {
  const language = useLanguage()
  const truncation = createTruncatedText()
  const label = () => {
    if (props.noGit) return language.t("session.new.git.none")
    if (!props.branch) return undefined
    if (props.from) return language.t("session.new.workspace.fromBranch", { branch: props.branch })
    return props.branch
  }

  const icon = () => {
    if (props.noGit) return "monitor"
    if (props.from) return "branch-out"
    return "branch"
  }

  return (
    <Show when={label()}>
      {(value) => (
        <Tooltip
          placement="top"
          value={value()}
          disabled={!truncation.truncated()}
          class={`min-w-0 max-w-[220px] ${props.class ?? ""}`}
          contentClass="max-w-[calc(100vw-32px)] break-all"
        >
          <div class="flex h-6 min-w-0 max-w-[220px] items-center gap-1.5 rounded-full bg-v2-background-bg-layer-02 px-2.5 text-[13px] font-[440] leading-5 tracking-[-0.04px] text-v2-text-text-faint">
            <Icon name={icon()} size="small" class="shrink-0 text-v2-icon-icon-muted" />
            <span ref={truncation.observe} class="min-w-0 truncate">
              {value()}
            </span>
          </div>
        </Tooltip>
      )}
    </Show>
  )
}

function createTruncatedText() {
  const [truncated, setTruncated] = createSignal(false)
  return {
    truncated,
    observe: (element: HTMLSpanElement) =>
      createResizeObserver(element, () => setTruncated(element.scrollWidth > element.clientWidth)),
  }
}
