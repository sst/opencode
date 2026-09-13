import { Popover } from "@kobalte/core/popover"
import { Component, ComponentProps, createEffect, createMemo, For, JSX, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLocal, type ModelSelection } from "@/providers/models/selection"
import { useDialog } from "@opencode/ui/context/dialog"
import { popularProviders } from "@/providers/catalog/providers"
import { Button } from "@opencode/ui/button"
import { Badge } from "@opencode/ui/badge"
import { Dialog, DialogBody, DialogHeader, DialogTitle } from "@opencode/ui/dialog"
import { Icon } from "@opencode/ui/icon"
import { IconButton } from "@opencode/ui/icon-button"
import { ScrollView } from "@opencode/ui/scroll-view"
import { Tooltip } from "@opencode/ui/tooltip"
import { Menu } from "@opencode/ui/menu"
import { TextInput } from "@opencode/ui/text-input"
import { ProviderIcon } from "@opencode/ui/provider-icon"
import { ModelTooltip } from "./tooltip"
import { useLanguage } from "@/runtime/i18n/language"
import { decode64 } from "@/runtime/persistence/base64"
import { handleDocumentSearchKeydown } from "@/shell/commands/search-keydown"
import { createMenuDismissController } from "@/shell/commands/menu-dismiss"
import { createEventListener } from "@solid-primitives/event-listener"
import { matchesModelSearch } from "./search"
import { SettingsList } from "@/settings/list"
import "@/settings/settings.css"

const isFree = (provider: string, cost: { input: number } | undefined) =>
  provider === "opencode" && (!cost || cost.input === 0)

type ModelState = ModelSelection
type ModelItem = ReturnType<ModelState["list"]>[number]

const modelKey = (model: ModelItem) => `${model.provider.id}:${model.id}`
const manageKey = "action:manage"

const sortModelGroups = (a: { category: string; items: ModelItem[] }, b: { category: string; items: ModelItem[] }) => {
  const aIndex = popularProviders.indexOf(a.category)
  const bIndex = popularProviders.indexOf(b.category)
  const aPopular = aIndex >= 0
  const bPopular = bIndex >= 0

  if (aPopular && !bPopular) return -1
  if (!aPopular && bPopular) return 1
  if (aPopular && bPopular) return aIndex - bIndex
  return a.items[0].provider.name.localeCompare(b.items[0].provider.name)
}

const ModelList: Component<{
  provider?: string
  onSelect: () => void
  model?: ModelState
}> = (props) => {
  const language = useLanguage()
  const controller = createModelSelectorController({
    model: props.model,
    provider: () => props.provider,
    onSelect: props.onSelect,
  })
  const [store, setStore] = createStore({
    search: "",
    active: "",
    collapsed: {} as Record<string, boolean>,
  })
  const models = createMemo(() => controller.models(store.search))
  const groups = createMemo(() => controller.groups(models()))
  const expanded = (provider: string) => store.search.length > 0 || !store.collapsed[provider]
  const visibleModels = () => models().filter((item) => expanded(item.provider.id))
  let scrollRef: HTMLDivElement | undefined

  const setSearch = (value: string) => {
    const first = controller.models(value).find((item) => value.length > 0 || !store.collapsed[item.provider.id])
    setStore({ search: value, active: first ? modelKey(first) : "" })
  }
  const moveActive = (delta: number) => {
    const keys = visibleModels().map(modelKey)
    if (keys.length === 0) return
    const index = keys.indexOf(store.active)
    const start = index === -1 ? (delta > 0 ? -1 : 0) : index
    setStore("active", keys[(start + delta + keys.length) % keys.length])
    queueMicrotask(() => {
      scrollRef
        ?.querySelector<HTMLElement>(`[data-option-key="${CSS.escape(store.active)}"]`)
        ?.scrollIntoView({ block: "nearest" })
    })
  }
  const selectActive = () => {
    const item = visibleModels().find((item) => modelKey(item) === store.active)
    if (item) controller.select(item)
  }

  return (
    <div class="flex min-h-0 flex-1 flex-col">
      <div class="shrink-0 px-4 pt-px pb-3">
        <div class="relative">
          <TextInput
            type="search"
            appearance="base"
            class="!w-full self-stretch"
            placeholder={language.t("dialog.model.search.placeholder")}
            value={store.search}
            autofocus
            spellcheck={false}
            autocorrect="off"
            autocomplete="off"
            autocapitalize="off"
            onInput={(event) => setSearch(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.altKey || event.metaKey) return
              if (event.key === "ArrowDown") {
                event.preventDefault()
                moveActive(1)
                return
              }
              if (event.key === "ArrowUp") {
                event.preventDefault()
                moveActive(-1)
                return
              }
              if (event.key === "Enter" && !event.isComposing) {
                event.preventDefault()
                selectActive()
              }
            }}
            aria-label={language.t("dialog.model.search.placeholder")}
          />
          <Show when={store.search}>
            <IconButton
              type="button"
              variant="ghost-muted"
              size="small"
              class="settings-tab-search-clear"
              icon={<Icon name="close" size="large" class="text-v2-icon-icon-muted" />}
              onClick={() => setSearch("")}
              aria-label={language.t("common.clear")}
            />
          </Show>
        </div>
      </div>
      <div class="relative min-h-0 flex-1">
        <div ref={(element) => (scrollRef = element)} class="settings-panel settings-models h-full px-4 pt-4 pb-4">
          <Show
            when={models().length > 0}
            fallback={<div class="settings-models-status">{language.t("dialog.model.empty")}</div>}
          >
            <For each={groups()}>
              {(group) => {
                const searching = () => store.search.length > 0
                const open = () => expanded(group.category)

                return (
                  <section class="settings-section" data-expanded={open() ? "" : undefined}>
                    <h3 class="settings-models-group-header">
                      <button
                        type="button"
                        class="settings-models-group-trigger"
                        aria-expanded={open()}
                        disabled={searching()}
                        onClick={() => setStore("collapsed", group.category, open())}
                      >
                        <span class="settings-models-group-chevron">
                          <Icon name="chevron-down" size="small" classList={{ "-rotate-90 rtl:rotate-90": !open() }} />
                        </span>
                        <span class="settings-models-group-label">
                          <ProviderIcon id={group.category} width={16} height={16} class="shrink-0" />
                          <span class="settings-models-group-title">{group.items[0].provider.name}</span>
                        </span>
                      </button>
                    </h3>
                    <Show when={open()}>
                      <SettingsList variant="catalog">
                        <For each={group.items}>
                          {(item) => (
                            <button
                              type="button"
                              data-component="settings-row"
                              data-option-key={modelKey(item)}
                              class="-mx-4 w-[calc(100%+32px)] px-4 text-start first:rounded-t-lg last:rounded-b-lg hover:bg-v2-overlay-simple-overlay-hover focus-visible:bg-v2-overlay-simple-overlay-hover focus-visible:outline-none"
                              classList={{ "bg-v2-overlay-simple-overlay-hover": store.active === modelKey(item) }}
                              onMouseEnter={() => setStore("active", modelKey(item))}
                              onMouseLeave={() => setStore("active", "")}
                              onClick={() => controller.select(item)}
                            >
                              <div data-slot="settings-row-copy">
                                <div data-slot="settings-row-title" class="flex items-center gap-2">
                                  <Tooltip
                                    placement="right-start"
                                    gutter={12}
                                    openDelay={0}
                                    value={
                                      <ModelTooltip
                                        model={item}
                                        latest={item.latest}
                                        free={isFree(item.provider.id, item.cost)}
                                        v2
                                      />
                                    }
                                  >
                                    <span class="min-w-0 truncate">{item.name}</span>
                                  </Tooltip>
                                  <Show when={isFree(item.provider.id, item.cost)}>
                                    <Badge class="shrink-0">{language.t("model.tag.free")}</Badge>
                                  </Show>
                                  <Show when={item.latest}>
                                    <Badge class="shrink-0">{language.t("model.tag.latest")}</Badge>
                                  </Show>
                                </div>
                              </div>
                              <div data-slot="settings-row-control" class="size-4">
                                <Show when={controller.current() === modelKey(item)}>
                                  <Icon name="check" size="small" class="shrink-0 text-v2-icon-icon-base" />
                                </Show>
                              </div>
                            </button>
                          )}
                        </For>
                      </SettingsList>
                    </Show>
                  </section>
                )
              }}
            </For>
          </Show>
        </div>
      </div>
    </div>
  )
}

type ModelSelectorTriggerProps = Omit<ComponentProps<typeof Popover.Trigger>, "as" | "ref">
type ModelSelectorTrigger = (props: ModelSelectorTriggerProps) => JSX.Element
export function ModelSelectorPopover(props: {
  provider?: string
  model?: ModelState
  trigger: ModelSelectorTrigger
  onClose?: () => void
}) {
  const dialog = useDialog()
  const controller = createModelSelectorController({
    model: props.model,
    provider: () => props.provider,
    onSelect: () => props.onClose?.(),
  })

  return (
    <ModelSelectorPopoverView
      trigger={props.trigger}
      models={controller.models}
      groups={controller.groups}
      current={controller.current()}
      select={controller.select}
      onManage={async () => {
        const { DialogManageModels } = await import("./manage")
        void dialog.show(() => <DialogManageModels model={props.model} onDone={props.onClose} />)
      }}
      onClose={() => props.onClose?.()}
    />
  )
}

function createModelSelectorController(input: {
  provider: () => string | undefined
  model?: ModelState
  onSelect: () => void
}) {
  const model = input.model ?? useLocal().model
  const allModels = createMemo(() =>
    model
      .list()
      .filter((item) => model.visible({ modelID: item.id, providerID: item.provider.id }))
      .filter((item) => (input.provider() ? item.provider.id === input.provider() : true)),
  )

  return {
    models: (search: string) => {
      const query = search.trim()
      const filtered = query
        ? allModels().filter((item) => matchesModelSearch(query, [item.name, item.id, item.provider.name]))
        : allModels()
      return [...filtered].sort((a, b) => a.name.localeCompare(b.name))
    },
    groups: (models: ModelItem[]) => {
      const byProvider = new Map<string, ModelItem[]>()
      for (const item of models) {
        byProvider.set(item.provider.id, [...(byProvider.get(item.provider.id) ?? []), item])
      }
      return Array.from(byProvider, ([category, items]) => ({ category, items })).sort(sortModelGroups)
    },
    current: () => {
      const value = model.current()
      return value ? modelKey(value) : undefined
    },
    select: (item: ModelItem) => {
      model.set({ modelID: item.id, providerID: item.provider.id }, { recent: true })
      input.onSelect()
    },
  }
}

function ModelSelectorPopoverView(props: {
  trigger: ModelSelectorTrigger
  models: (search: string) => ModelItem[]
  groups: (models: ModelItem[]) => { category: string; items: ModelItem[] }[]
  current: string | undefined
  select: (item: ModelItem) => void
  onManage: () => void
  onClose: () => void
}) {
  const language = useLanguage()
  const [store, setStore] = createStore({ open: false, search: "", active: "" })
  let searchRef: HTMLInputElement | undefined
  let contentRef: HTMLDivElement | undefined
  const dismiss = createMenuDismissController(() => contentRef)

  const models = createMemo(() => props.models(store.search))
  const groups = createMemo(() => props.groups(models()))
  const keys = () => [...groups().flatMap((group) => group.items.map(modelKey)), manageKey]
  const initialActive = () => {
    const selected = props.current
    const options = keys()
    if (selected && options.includes(selected)) return selected
    return options[0] ?? ""
  }
  const activeItem = () =>
    store.active ? contentRef?.querySelector<HTMLElement>(`[data-option-key="${CSS.escape(store.active)}"]`) : undefined
  const setOpen = (open: boolean) => {
    if (open) {
      dismiss.allowTriggerRestore()
      setStore({ open: true, active: initialActive() })
      setTimeout(() =>
        requestAnimationFrame(() => {
          searchRef?.focus()
          activeItem()?.scrollIntoView({ block: "nearest" })
        }),
      )
      return
    }
    setStore({ open: false, search: "", active: "" })
  }
  const selectModel = (item: ModelItem) => {
    dismiss.preventTriggerRestore()
    setOpen(false)
    dismiss.afterClose(() => props.select(item))
  }
  const manage = () => {
    dismiss.preventTriggerRestore()
    setOpen(false)
    dismiss.afterClose(props.onManage)
  }
  const selectActive = () => {
    const item = models().find((item) => modelKey(item) === store.active)
    if (item) {
      selectModel(item)
      return
    }
    if (store.active === manageKey) manage()
  }
  const moveActive = (delta: number) => {
    const options = keys()
    if (options.length === 0) return
    const index = options.indexOf(store.active)
    const start = index === -1 ? 0 : index
    setStore("active", options[(start + delta + options.length) % options.length])
    queueMicrotask(() => activeItem()?.scrollIntoView({ block: "nearest" }))
  }
  const setSearch = (value: string) => {
    const first = props.models(value)[0]
    setStore({ search: value, active: first ? modelKey(first) : manageKey })
  }

  createEffect(() => {
    if (!store.open) return
    createEventListener(
      document,
      "keydown",
      (event: KeyboardEvent) => handleDocumentSearchKeydown(searchRef, event, store.search, setSearch),
      true,
    )
  })

  return (
    <Menu open={store.open} modal={false} placement="top-start" gutter={6} onOpenChange={setOpen}>
      <Menu.Trigger as={props.trigger} />
      <Menu.Portal>
        <Menu.Content
          ref={(element: HTMLDivElement) => (contentRef = element)}
          class="w-[284px] overflow-hidden rounded-md border-0 bg-v2-background-bg-layer-01 !p-0 shadow-[var(--v2-elevation-floating)] focus:outline-none"
          onPointerDownOutside={dismiss.preventTriggerRestore}
          onFocusOutside={dismiss.preventTriggerRestore}
          onCloseAutoFocus={dismiss.onCloseAutoFocus}
        >
          <div class="flex flex-col p-0.5">
            <div class="flex h-7 items-center gap-2 rounded-sm pl-3 pr-2.5 text-v2-icon-icon-muted">
              <Icon name="magnifying-glass" size="small" class="shrink-0" />
              <input
                ref={(el) => (searchRef = el)}
                value={store.search}
                placeholder={language.t("dialog.model.search.placeholder")}
                class="h-7 min-w-0 flex-1 border-0 bg-transparent text-[13px] font-[440] leading-5 tracking-[-0.04px] text-v2-text-text-base outline-none placeholder:text-v2-text-text-faint"
                spellcheck={false}
                autocorrect="off"
                autocomplete="off"
                autocapitalize="off"
                onInput={(event) => setSearch(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === "Tab") return
                  event.stopPropagation()
                  if (event.key === "Escape") {
                    event.preventDefault()
                    dismiss.preventTriggerRestore()
                    setOpen(false)
                    dismiss.afterClose(props.onClose)
                    return
                  }
                  if (event.altKey || event.metaKey) return
                  if (event.key === "ArrowDown") {
                    event.preventDefault()
                    moveActive(1)
                    return
                  }
                  if (event.key === "ArrowUp") {
                    event.preventDefault()
                    moveActive(-1)
                    return
                  }
                  if (event.key === "Enter" && !event.isComposing) {
                    event.preventDefault()
                    selectActive()
                  }
                }}
              />
              <Show when={store.search.trim()}>
                <button
                  type="button"
                  class="flex size-5 items-center justify-center rounded-sm text-v2-icon-icon-muted hover:bg-v2-overlay-simple-overlay-hover"
                  onPointerDown={(event) => event.preventDefault()}
                  onClick={() => setSearch("")}
                  aria-label={language.t("common.clear")}
                >
                  <Icon name="close" size="small" />
                </button>
              </Show>
            </div>
          </div>
          <div class="h-px bg-v2-border-border-muted" />
          <ScrollView data-slot="model-selector-scroll" class="max-h-[220px] min-h-0">
            <div class="flex flex-col p-0.5 pt-0">
              <Show
                when={models().length > 0}
                fallback={
                  <div class="flex h-12 items-center px-3 text-[13px] font-[440] leading-5 tracking-[-0.04px] text-v2-text-text-faint">
                    {language.t("dialog.model.empty")}
                  </div>
                }
              >
                <For each={groups()}>
                  {(group) => (
                    <Menu.Group>
                      <Menu.GroupLabel class="gap-2 px-3">
                        <span class="min-w-0 truncate">{group.items[0].provider.name}</span>
                      </Menu.GroupLabel>
                      <Menu.RadioGroup value={props.current}>
                        <For each={group.items}>
                          {(item) => (
                            <Tooltip
                              class="w-full"
                              placement="right-start"
                              gutter={6}
                              openDelay={0}
                              value={
                                <ModelTooltip
                                  model={item}
                                  latest={item.latest}
                                  free={isFree(item.provider.id, item.cost)}
                                  v2
                                />
                              }
                            >
                              <Menu.RadioItem
                                value={modelKey(item)}
                                data-option-key={modelKey(item)}
                                data-selected-model={props.current === modelKey(item) ? true : undefined}
                                class="scroll-my-6 w-full"
                                classList={{ "!bg-v2-overlay-simple-overlay-hover": store.active === modelKey(item) }}
                                onMouseEnter={() => {
                                  setStore("active", modelKey(item))
                                  setTimeout(() => searchRef?.focus())
                                }}
                                onSelect={() => selectModel(item)}
                              >
                                <span class="min-w-0 truncate leading-5">{item.name}</span>
                                <Show when={isFree(item.provider.id, item.cost)}>
                                  <Badge class="shrink-0">{language.t("model.tag.free")}</Badge>
                                </Show>
                                <Show when={item.latest}>
                                  <Badge class="shrink-0">{language.t("model.tag.latest")}</Badge>
                                </Show>
                              </Menu.RadioItem>
                            </Tooltip>
                          )}
                        </For>
                      </Menu.RadioGroup>
                    </Menu.Group>
                  )}
                </For>
              </Show>
            </div>
          </ScrollView>
          <div class="h-px bg-v2-border-border-muted" />
          <div class="flex flex-col p-0.5">
            <Menu.Item
              data-option-key={manageKey}
              classList={{ "!bg-v2-overlay-simple-overlay-hover": store.active === manageKey }}
              onMouseEnter={() => {
                setStore("active", manageKey)
                setTimeout(() => searchRef?.focus())
              }}
              onSelect={manage}
            >
              <Icon name="outline-sliders" size="small" />
              <span class="min-w-0 flex-1 truncate leading-5">{language.t("dialog.model.manage")}</span>
            </Menu.Item>
          </div>
        </Menu.Content>
      </Menu.Portal>
    </Menu>
  )
}

export const DialogSelectModel: Component<{ provider?: string; model?: ModelState; onDone?: () => void }> = (props) => {
  const dialog = useDialog()
  const language = useLanguage()
  const local = useLocal()
  const directory = () => decode64(local.slug())

  const provider = async () => {
    const { DialogConnectProvider } = await import("@/providers/connect/dialog")
    void dialog.show(() => (
      <DialogConnectProvider directory={directory()} selection={props.model ?? local.model} onDone={props.onDone} />
    ))
  }

  const manage = async () => {
    const { DialogManageModels } = await import("./manage")
    void dialog.show(() => <DialogManageModels model={props.model} onDone={props.onDone} />)
  }

  return (
    <Dialog size="large" variant="settings">
      <DialogHeader hideClose closeLabel={language.t("common.close")}>
        <DialogTitle>{language.t("dialog.model.select.title")}</DialogTitle>
        <Button icon="plus" onClick={provider}>
          {language.t("command.provider.connect")}
        </Button>
      </DialogHeader>
      <DialogBody class="flex min-h-0 flex-1 flex-col">
        <ModelList provider={props.provider} model={props.model} onSelect={() => dialog.close()} />
        <div class="shrink-0 border-t border-v2-border-border-muted px-4 py-3">
          <button
            type="button"
            class="flex h-9 w-full items-center gap-2 rounded-md px-3 text-left text-[13px] font-[530] leading-text-compact tracking-[-0.04px] text-v2-text-text-base hover:bg-v2-overlay-simple-overlay-hover focus-visible:bg-v2-overlay-simple-overlay-hover focus-visible:outline-none"
            onClick={manage}
          >
            <Icon name="outline-sliders" size="small" />
            <span class="min-w-0 flex-1 truncate">{language.t("dialog.model.manage")}</span>
          </button>
        </div>
      </DialogBody>
    </Dialog>
  )
}
