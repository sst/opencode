import type { IntegrationMethod, IntegrationOauthConnectOutput } from "@opencode-ai/client/promise"
import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { List, type ListRef } from "@opencode-ai/ui/list"
import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import { Spinner } from "@opencode-ai/ui/spinner"
import { Tag } from "@opencode-ai/ui/tag"
import { TextField } from "@opencode-ai/ui/text-field"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { DialogBody, DialogHeader, DialogTitle, DialogV2 } from "@opencode-ai/ui/v2/dialog-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { showToast } from "@/utils/toast"
import {
  type Accessor,
  type Component,
  createEffect,
  createMemo,
  createResource,
  createUniqueId,
  For,
  Match,
  onCleanup,
  onMount,
  Show,
  Switch,
} from "solid-js"
import { createStore, produce } from "solid-js/store"
import { useParams } from "@solidjs/router"
import { ExternalLink } from "@/components/external-link"
import { useServerSDK } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useSettings } from "@/context/settings"
import { popularProviders, useProviders } from "@/hooks/use-providers"
import { CustomProviderForm } from "./dialog-custom-provider"
import { decode64 } from "@/utils/base64"

const CUSTOM_ID = "_custom"
type ConnectMethod = Extract<IntegrationMethod, { type: "key" | "oauth" }>

export function useProviderConnectController(options: { onBack?: () => void } = {}) {
  const [store, setStore] = createStore({ selected: undefined as string | undefined })
  const reset = () => setStore("selected", undefined)

  return {
    selected: () => store.selected,
    select: (provider?: string) => setStore("selected", provider),
    back: options.onBack ?? reset,
  }
}

export const DialogConnectProvider: Component<{
  directory?: Accessor<string | undefined>
  controller?: ReturnType<typeof useProviderConnectController>
}> = (props) => {
  const fallback = useProviderConnectController()
  const controller = props.controller ?? fallback
  const language = useLanguage()
  const settings = useSettings()
  const newLayout = settings.general.newLayoutDesigns
  const reset = controller.back
  const back = { current: reset }
  let focusHost: HTMLDivElement | undefined
  const holdFocus = () => focusHost?.focus({ preventScroll: true })
  const select = (provider?: string) => {
    back.current = reset
    controller.select(provider)
  }

  function Content() {
    return (
      <Switch>
        <Match when={controller.selected() === CUSTOM_ID}>
          <CustomProviderForm autofocus={!newLayout()} />
        </Match>
        <Match when={controller.selected() && controller.selected() !== CUSTOM_ID ? controller.selected() : undefined}>
          {(provider) => (
            <ProviderConnection
              provider={provider()}
              directory={props.directory}
              onBack={reset}
              setBack={(handler) => (back.current = handler)}
            />
          )}
        </Match>
        <Match when={true}>
          <ProviderPicker
            directory={props.directory}
            onSelect={select}
            onPrepare={newLayout() ? holdFocus : undefined}
          />
        </Match>
      </Switch>
    )
  }

  return (
    <Show
      when={newLayout()}
      fallback={
        <Dialog
          class="h-full"
          transition
          title={
            <Show when={controller.selected()} fallback={language.t("command.provider.connect")}>
              <IconButton
                tabIndex={-1}
                icon="arrow-left"
                variant="ghost"
                onClick={() => back.current()}
                aria-label={language.t("common.goBack")}
              />
            </Show>
          }
        >
          <Content />
        </Dialog>
      }
    >
      <DialogV2
        containerClass="!h-[min(calc(100vh_-_16px),512px)] !w-[min(calc(100vw_-_16px),640px)]"
        class="[font-family:var(--v2-font-family-sans)] [&_[data-slot=dialog-header]]:!px-5 [&_[data-slot=dialog-header-title]]:!text-[15px] [&_[data-slot=dialog-header-title]]:!tracking-[-0.13px]"
      >
        <DialogHeader closeLabel={language.t("common.close")}>
          <Show
            when={controller.selected()}
            fallback={<DialogTitle>{language.t("command.provider.connect")}</DialogTitle>}
          >
            <button
              type="button"
              class="flex size-5 items-center justify-center rounded-sm text-v2-icon-icon-muted hover:bg-v2-overlay-simple-overlay-hover focus-visible:bg-v2-overlay-simple-overlay-hover focus-visible:outline-none"
              onClick={() => back.current()}
              aria-label={language.t("common.goBack")}
            >
              <Icon name="arrow-left" size="small" />
            </button>
          </Show>
        </DialogHeader>
        <DialogBody class="min-h-0 flex-1 overflow-hidden px-2 pb-2">
          <div ref={focusHost} tabIndex={-1} class="flex min-h-0 flex-1 flex-col outline-none">
            <Content />
          </div>
        </DialogBody>
      </DialogV2>
    </Show>
  )
}

function ProviderPicker(props: {
  directory?: Accessor<string | undefined>
  onSelect: (provider: string) => void
  onPrepare?: () => void
}) {
  const settings = useSettings()
  if (settings.general.newLayoutDesigns())
    return <ProviderPickerV2 directory={props.directory} onSelect={props.onSelect} onPrepare={props.onPrepare} />
  const providers = useProviders(() => props.directory?.())
  const language = useLanguage()
  const popularGroup = () => language.t("dialog.provider.group.popular")
  const otherGroup = () => language.t("dialog.provider.group.other")
  const customLabel = () => language.t("settings.providers.tag.custom")
  const note = (id: string) => {
    if (id === "anthropic") return language.t("dialog.provider.anthropic.note")
    if (id === "openai") return language.t("dialog.provider.openai.note")
    if (id.startsWith("github-copilot")) return language.t("dialog.provider.copilot.note")
    if (id === "opencode-go") return language.t("dialog.provider.opencodeGo.tagline")
    return undefined
  }

  return (
    <List
      class="px-3"
      search={{ placeholder: language.t("dialog.provider.search.placeholder"), autofocus: true }}
      emptyMessage={language.t("dialog.provider.empty")}
      activeIcon="plus-small"
      key={(x) => x?.id}
      items={() => {
        language.locale()
        return [{ id: CUSTOM_ID, name: customLabel() }, ...providers.all().values()]
      }}
      filterKeys={["id", "name"]}
      groupBy={(x) => (popularProviders.includes(x.id) ? popularGroup() : otherGroup())}
      sortBy={(a, b) => {
        if (a.id === CUSTOM_ID) return -1
        if (b.id === CUSTOM_ID) return 1
        if (popularProviders.includes(a.id) && popularProviders.includes(b.id))
          return popularProviders.indexOf(a.id) - popularProviders.indexOf(b.id)
        return a.name.localeCompare(b.name)
      }}
      sortGroupsBy={(a, b) => {
        const popular = popularGroup()
        if (a.category === popular && b.category !== popular) return -1
        if (b.category === popular && a.category !== popular) return 1
        return 0
      }}
      onSelect={(x) => {
        if (!x) return
        props.onSelect(x.id)
      }}
    >
      {(i) => (
        <div class="px-1.25 w-full flex items-center gap-x-3">
          <ProviderIcon data-slot="list-item-extra-icon" id={i.id} />
          <span>{i.name}</span>
          <Show when={i.id === "opencode"}>
            <div class="text-14-regular text-text-weak">{language.t("dialog.provider.opencode.tagline")}</div>
          </Show>
          <Show when={i.id === CUSTOM_ID}>
            <Tag>{language.t("settings.providers.tag.custom")}</Tag>
          </Show>
          <Show when={i.id === "opencode"}>
            <Tag>{language.t("dialog.provider.tag.recommended")}</Tag>
          </Show>
          <Show when={note(i.id)}>{(value) => <div class="text-14-regular text-text-weak">{value()}</div>}</Show>
          <Show when={i.id === "opencode-go"}>
            <Tag>{language.t("dialog.provider.tag.recommended")}</Tag>
          </Show>
        </div>
      )}
    </List>
  )
}

function ProviderPickerV2(props: {
  directory?: Accessor<string | undefined>
  onSelect: (provider: string) => void
  onPrepare?: () => void
}) {
  const providers = useProviders(() => props.directory?.())
  const language = useLanguage()
  const [store, setStore] = createStore({
    filter: "",
    active: undefined as string | undefined,
    connecting: undefined as string | undefined,
  })
  const featured = ["opencode", "opencode-go", "anthropic", "openai", "google", "openrouter", "vercel"]
  const custom = () => ({ id: CUSTOM_ID, name: language.t("dialog.provider.custom.label") })
  const all = createMemo(() => {
    language.locale()
    const query = store.filter.trim().toLowerCase()
    const values = [custom(), ...providers.all().values()]
    if (!query) return values
    return values.filter((provider) => `${provider.id} ${provider.name}`.toLowerCase().includes(query))
  })
  const popular = createMemo(() =>
    all()
      .filter((provider) => featured.includes(provider.id))
      .sort((a, b) => featured.indexOf(a.id) - featured.indexOf(b.id)),
  )
  const other = createMemo(() =>
    all()
      .filter((provider) => !featured.includes(provider.id))
      .sort((a, b) => {
        if (a.id === CUSTOM_ID) return -1
        if (b.id === CUSTOM_ID) return 1
        return a.name.localeCompare(b.name)
      }),
  )
  const rows = createMemo(() => [...popular(), ...other()])
  let picker: HTMLDivElement | undefined
  let search: HTMLInputElement | undefined

  onMount(() => search?.focus({ preventScroll: true }))

  const connect = (provider: string) => {
    props.onPrepare?.()
    props.onSelect(provider)
  }

  const move = (event: KeyboardEvent, direction: number) => {
    const items = rows()
    if (items.length === 0) return
    const index = items.findIndex((provider) => provider.id === store.active)
    const next = index < 0 ? (direction > 0 ? 0 : items.length - 1) : (index + direction + items.length) % items.length
    setStore("active", items[next].id)
    picker
      ?.querySelector<HTMLElement>(`[data-provider-id="${CSS.escape(items[next].id)}"]`)
      ?.focus({ preventScroll: true })
    event.preventDefault()
  }

  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.key === "ArrowDown") return move(event, 1)
    if (event.key === "ArrowUp") return move(event, -1)
    if (event.key !== "Enter" || !store.active) return
    connect(store.active)
    event.preventDefault()
  }

  return (
    <div ref={picker} class="flex min-h-0 flex-1 flex-col gap-4" onKeyDown={handleKeyDown}>
      <div class="shrink-0 px-1 pt-px">
        <TextInputV2
          ref={search}
          type="search"
          class="!w-full [font-family:var(--v2-font-family-sans)]"
          leadingIcon={<Icon name="magnifying-glass" size="small" />}
          placeholder={language.t("dialog.provider.search.placeholder")}
          value={store.filter}
          onInput={(event) => {
            setStore({ filter: event.currentTarget.value, active: undefined })
          }}
        />
      </div>
      <div class="relative min-h-0 flex-1">
        <div class="flex size-full min-h-0 flex-col gap-4 overflow-y-auto pb-8 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <For
            each={[
              { title: language.t("dialog.provider.group.popular"), items: popular },
              { title: language.t("dialog.provider.group.other"), items: other },
            ]}
          >
            {(group) => (
              <Show when={group.items().length > 0}>
                <section class="flex flex-col">
                  <div class="px-3 pb-2 text-[13px] font-[440] leading-none tracking-[-0.04px] text-v2-text-text-muted">
                    {group.title}
                  </div>
                  <For each={group.items()}>
                    {(provider) => (
                      <button
                        type="button"
                        data-provider-id={provider.id}
                        class="flex min-h-9 w-full items-center gap-2 rounded-md px-3 py-2.5 text-left text-[13px] leading-none tracking-[-0.04px] hover:bg-v2-overlay-simple-overlay-hover focus:bg-v2-overlay-simple-overlay-hover focus:outline-none"
                        classList={{ "bg-v2-overlay-simple-overlay-hover": store.active === provider.id }}
                        onMouseEnter={() => setStore("active", provider.id)}
                        disabled={store.connecting !== undefined}
                        aria-busy={store.connecting === provider.id}
                        onClick={() => connect(provider.id)}
                      >
                        <ProviderIcon id={provider.id} class="size-4 shrink-0 text-v2-icon-icon-base" />
                        <span class="min-w-0 truncate font-[530] text-v2-text-text-base">{provider.name}</span>
                        <Show when={provider.id === "opencode" || provider.id === "opencode-go"}>
                          <span class="min-w-0 truncate font-[440] text-v2-text-text-muted">
                            {language.t(
                              provider.id === "opencode"
                                ? "dialog.provider.opencode.tagline"
                                : "dialog.provider.opencodeGo.tagline",
                            )}
                          </span>
                          <span class="flex h-4 shrink-0 items-center rounded-xs border-[0.5px] border-v2-border-border-base bg-v2-background-bg-layer-03 px-1 text-[11px] font-[530] leading-none tracking-[0.05px] text-v2-text-text-muted">
                            {language.t("dialog.provider.tag.recommended")}
                          </span>
                        </Show>
                        <Show when={provider.id === CUSTOM_ID}>
                          <span class="flex h-4 shrink-0 items-center rounded-xs border-[0.5px] border-v2-border-border-base bg-v2-background-bg-layer-03 px-1 text-[11px] font-[530] leading-none tracking-[0.05px] text-v2-text-text-muted">
                            {language.t("settings.providers.tag.custom")}
                          </span>
                        </Show>
                        <Show when={store.connecting === provider.id}>
                          <Spinner class="ml-auto size-4 shrink-0 text-v2-icon-icon-muted" />
                        </Show>
                      </button>
                    )}
                  </For>
                </section>
              </Show>
            )}
          </For>
          <Show when={rows().length === 0}>
            <div class="flex h-24 items-center justify-center text-[13px] font-[440] text-v2-text-text-muted">
              {language.t("dialog.provider.empty")}
            </div>
          </Show>
        </div>
        <div
          class="pointer-events-none absolute inset-x-0 bottom-0 h-10"
          style={{ background: "linear-gradient(to bottom, transparent, var(--v2-background-bg-layer-01))" }}
        />
      </div>
    </div>
  )
}

function ProviderConnection(props: {
  provider: string
  directory?: Accessor<string | undefined>
  onBack: () => void
  setBack: (handler: () => void) => void
}) {
  const dialog = useDialog()
  const serverSync = useServerSync()
  const serverSDK = useServerSDK()
  const params = useParams()
  const language = useLanguage()
  const platform = usePlatform()
  const settings = useSettings()
  const newLayout = settings.general.newLayoutDesigns
  const providers = useProviders(() => props.directory?.())
  const directory = () => props.directory?.() ?? decode64(params.dir)
  const location = () => {
    const value = directory()
    return value ? { directory: value } : undefined
  }

  const alive = { value: true }
  const timer = { current: undefined as ReturnType<typeof setTimeout> | undefined }

  onCleanup(() => {
    alive.value = false
    if (timer.current === undefined) return
    clearTimeout(timer.current)
    timer.current = undefined
  })

  const provider = createMemo(
    () => providers.all().get(props.provider) ?? serverSync().data.provider.all.get(props.provider)!,
  )
  const fallback = createMemo<ConnectMethod[]>(() => [
    {
      type: "key" as const,
      label: language.t("provider.connect.method.apiKey"),
    },
  ])
  const [integration] = createResource(
    () => ({ provider: props.provider, directory: directory() }),
    (input) =>
      serverSDK()
        .api.integration.get({
          integrationID: input.provider,
          location: input.directory ? { directory: input.directory } : undefined,
        })
        .then((result) => result.data),
  )
  const loading = createMemo(() => integration.loading)
  const methods = createMemo<ConnectMethod[]>(() => {
    const values = integration.latest?.methods.filter(
      (method): method is ConnectMethod => method.type === "key" || method.type === "oauth",
    )
    return values?.length ? values : fallback()
  })
  const [store, setStore] = createStore({
    methodIndex: undefined as undefined | number,
    authorization: undefined as undefined | IntegrationOauthConnectOutput["data"],
    promptInputs: undefined as undefined | Record<string, string>,
    state: "pending" as undefined | "pending" | "complete" | "error" | "prompt",
    error: undefined as string | undefined,
  })

  type Action =
    | { type: "method.select"; index: number }
    | { type: "method.reset" }
    | { type: "auth.prompt" }
    | { type: "auth.inputs"; inputs: Record<string, string> }
    | { type: "auth.pending" }
    | { type: "auth.complete"; authorization: IntegrationOauthConnectOutput["data"] }
    | { type: "auth.error"; error: string }

  function dispatch(action: Action) {
    setStore(
      produce((draft) => {
        if (action.type === "method.select") {
          draft.methodIndex = action.index
          draft.authorization = undefined
          draft.promptInputs = undefined
          draft.state = undefined
          draft.error = undefined
          return
        }
        if (action.type === "method.reset") {
          draft.methodIndex = undefined
          draft.authorization = undefined
          draft.promptInputs = undefined
          draft.state = undefined
          draft.error = undefined
          return
        }
        if (action.type === "auth.prompt") {
          draft.state = "prompt"
          draft.error = undefined
          return
        }
        if (action.type === "auth.inputs") {
          draft.promptInputs = action.inputs
          draft.state = undefined
          draft.error = undefined
          return
        }
        if (action.type === "auth.pending") {
          draft.state = "pending"
          draft.error = undefined
          return
        }
        if (action.type === "auth.complete") {
          draft.state = "complete"
          draft.authorization = action.authorization
          draft.error = undefined
          return
        }
        draft.state = "error"
        draft.error = action.error
      }),
    )
  }

  const method = createMemo(() => (store.methodIndex !== undefined ? methods().at(store.methodIndex!) : undefined))

  const methodLabel = (value?: { type?: string; label?: string }) => {
    if (!value) return ""
    if (value.type === "key") return language.t("provider.connect.method.apiKey")
    return value.label ?? ""
  }

  const methodDetails = (value?: { type?: string; label?: string }) => {
    const label = methodLabel(value)
    const suffix = value?.label?.match(/\s+\((browser|headless)\)$/i)
    const hint = suffix?.[1]
    return {
      label: suffix ? label.slice(0, -suffix[0].length) : label,
      hint:
        hint?.toLowerCase() === "headless"
          ? language.t("provider.connect.method.headless")
          : hint?.toLowerCase() === "browser" || (!hint && value?.type === "key")
            ? language.t("provider.connect.method.browser")
            : undefined,
    }
  }

  function formatError(value: unknown, fallback: string): string {
    if (value && typeof value === "object" && "data" in value) {
      const data = (value as { data?: { message?: unknown } }).data
      if (typeof data?.message === "string" && data.message) return data.message
    }
    if (value && typeof value === "object" && "error" in value) {
      const nested = formatError((value as { error?: unknown }).error, "")
      if (nested) return nested
    }
    if (value && typeof value === "object" && "message" in value) {
      const message = (value as { message?: unknown }).message
      if (typeof message === "string" && message) return message
    }
    if (value instanceof Error && value.message) return value.message
    if (typeof value === "string" && value) return value
    return fallback
  }

  async function selectMethod(index: number, inputs?: Record<string, string>) {
    if (timer.current !== undefined) {
      clearTimeout(timer.current)
      timer.current = undefined
    }

    const method = methods()[index]
    dispatch({ type: "method.select", index })

    if (method.type === "oauth") {
      if (method.prompts?.length && !inputs) {
        dispatch({ type: "auth.prompt" })
        return
      }
      dispatch({ type: "auth.pending" })
      await serverSDK()
        .api.integration.oauth.connect({
          integrationID: props.provider,
          methodID: method.id,
          inputs: inputs ?? {},
          location: location(),
        })
        .then((x) => {
          if (!alive.value) return
          if (props.provider === "opencode" && platform.platform === "desktop") {
            const url = new URL(x.data.url)
            url.searchParams.set("client_id", "opencode-desktop")
            x.data.url = url.href
          }
          dispatch({ type: "auth.complete", authorization: x.data })
        })
        .catch((e) => {
          if (!alive.value) return
          dispatch({ type: "auth.error", error: formatError(e, language.t("common.requestFailed")) })
        })
    }
  }

  function AuthPromptsView() {
    const [formStore, setFormStore] = createStore({
      value: {} as Record<string, string>,
      index: 0,
    })

    const prompts = createMemo(() => {
      const value = method()
      return value?.type === "oauth" ? (value.prompts ?? []) : []
    })
    const matches = (prompt: NonNullable<ReturnType<typeof prompts>[number]>, value: Record<string, string>) => {
      if (!prompt.when) return true
      const actual = value[prompt.when.key]
      if (actual === undefined) return false
      return prompt.when.op === "eq" ? actual === prompt.when.value : actual !== prompt.when.value
    }
    const current = createMemo(() => {
      const all = prompts()
      const index = all.findIndex((prompt, index) => index >= formStore.index && matches(prompt, formStore.value))
      if (index === -1) return
      return {
        index,
        prompt: all[index],
      }
    })
    const valid = createMemo(() => {
      const item = current()
      if (!item || item.prompt.type !== "text") return false
      const value = formStore.value[item.prompt.key] ?? ""
      return value.trim().length > 0
    })

    async function next(index: number, value: Record<string, string>) {
      if (store.methodIndex === undefined) return
      const next = prompts().findIndex((prompt, i) => i > index && matches(prompt, value))
      if (next !== -1) {
        setFormStore("index", next)
        return
      }
      await selectMethod(store.methodIndex, value)
    }

    async function handleSubmit(e: SubmitEvent) {
      e.preventDefault()
      const item = current()
      if (!item || item.prompt.type !== "text") return
      if (!valid()) return
      await next(item.index, formStore.value)
    }

    const item = () => current()
    const text = createMemo(() => {
      const prompt = item()?.prompt
      if (!prompt || prompt.type !== "text") return
      return prompt
    })
    const select = createMemo(() => {
      const prompt = item()?.prompt
      if (!prompt || prompt.type !== "select") return
      return prompt
    })

    return (
      <form onSubmit={handleSubmit} class="flex flex-col items-start gap-4">
        <Switch>
          <Match when={item()?.prompt.type === "text"}>
            <TextField
              type="text"
              label={text()?.message ?? ""}
              placeholder={text()?.placeholder}
              value={text() ? (formStore.value[text()!.key] ?? "") : ""}
              onChange={(value) => {
                const prompt = text()
                if (!prompt) return
                setFormStore("value", prompt.key, value)
              }}
            />
            <Button class="w-auto" type="submit" size="large" variant="primary" disabled={!valid()}>
              {language.t("common.continue")}
            </Button>
          </Match>
          <Match when={item()?.prompt.type === "select"}>
            <div class="w-full flex flex-col gap-1.5">
              <div class="text-14-regular text-text-base">{select()?.message}</div>
              <div>
                <List
                  class="px-3"
                  items={select()?.options ?? []}
                  key={(x) => x.value}
                  current={select()?.options.find((x) => x.value === formStore.value[select()!.key])}
                  onSelect={(value) => {
                    if (!value) return
                    const prompt = select()
                    if (!prompt) return
                    const nextValue = {
                      ...formStore.value,
                      [prompt.key]: value.value,
                    }
                    setFormStore("value", prompt.key, value.value)
                    void next(item()!.index, nextValue)
                  }}
                >
                  {(option) => (
                    <div class="w-full flex items-center gap-x-2">
                      <div class="w-4 h-2 rounded-[1px] bg-input-base shadow-xs-border-base flex items-center justify-center">
                        <div class="w-2.5 h-0.5 ml-0 bg-icon-strong-base hidden" data-slot="list-item-extra-icon" />
                      </div>
                      <span>{option.label}</span>
                      <span class="text-14-regular text-text-weak">{option.hint}</span>
                    </div>
                  )}
                </List>
              </div>
            </div>
          </Match>
        </Switch>
      </form>
    )
  }

  let listRef: ListRef | undefined
  function handleKey(e: KeyboardEvent) {
    if (e.key === "Enter" && e.target instanceof HTMLInputElement) {
      return
    }
    if (e.key === "Escape") return
    listRef?.onKeyDown(e)
  }

  let auto = false
  createEffect(() => {
    if (auto) return
    if (loading()) return
    if (methods().length === 1) {
      auto = true
      void selectMethod(0)
    }
  })

  async function complete() {
    await serverSync()
      .refreshProviders()
      .catch(() => undefined)
    dialog.close()
    showToast({
      variant: "success",
      icon: "circle-check",
      title: language.t("provider.connect.toast.connected.title", { provider: provider().name }),
      description: language.t("provider.connect.toast.connected.description", { provider: provider().name }),
    })
  }

  function goBack() {
    if (methods().length > 1 && store.methodIndex !== undefined) {
      dispatch({ type: "method.reset" })
      return
    }
    props.onBack()
  }

  props.setBack(goBack)

  function MethodSelection() {
    if (newLayout())
      return (
        <div class="flex flex-col gap-2">
          <div class="px-3 text-[13px] font-[440] leading-5 tracking-[-0.04px] text-v2-text-text-muted">
            {language.t("provider.connect.selectMethod", { provider: provider().name })}
          </div>
          <div class="flex flex-col">
            <For each={methods()}>
              {(item, index) => {
                const details = () => methodDetails(item)
                return (
                  <button
                    type="button"
                    class="group flex h-9 w-full items-center gap-2 rounded-md px-3 text-left text-[13px] leading-5 tracking-[-0.04px] hover:bg-v2-overlay-simple-overlay-hover focus-visible:bg-v2-overlay-simple-overlay-hover focus-visible:outline-none"
                    onClick={() => void selectMethod(index())}
                  >
                    <span class="flex h-2 w-4 shrink-0 items-center justify-center rounded-[1px] bg-v2-background-bg-base shadow-[var(--v2-elevation-button-neutral)]">
                      <span class="hidden h-0.5 w-2.5 bg-v2-icon-icon-base group-hover:block group-focus-visible:block" />
                    </span>
                    <span class="font-[530] text-v2-text-text-base">{details().label}</span>
                    <Show when={details().hint}>
                      {(hint) => <span class="font-[440] text-v2-text-text-muted">{hint()}</span>}
                    </Show>
                  </button>
                )
              }}
            </For>
          </div>
        </div>
      )

    return (
      <>
        <div class="text-14-regular text-text-base">
          {language.t("provider.connect.selectMethod", { provider: provider().name })}
        </div>
        <div>
          <List
            class="px-3"
            ref={(ref) => {
              listRef = ref
            }}
            items={methods}
            key={(m) => m?.label ?? m?.type}
            onSelect={async (selected, index) => {
              if (!selected) return
              void selectMethod(index)
            }}
          >
            {(i) => (
              <div class="w-full flex items-center gap-x-2">
                <div class="w-4 h-2 rounded-[1px] bg-input-base shadow-xs-border-base flex items-center justify-center">
                  <div class="w-2.5 h-0.5 ml-0 bg-icon-strong-base hidden" data-slot="list-item-extra-icon" />
                </div>
                <span>{methodLabel(i)}</span>
              </div>
            )}
          </List>
        </div>
      </>
    )
  }

  function ApiAuthView() {
    let apiKey: HTMLInputElement | undefined
    const errorID = createUniqueId()
    const [formStore, setFormStore] = createStore({
      value: "",
      error: undefined as string | undefined,
    })

    onMount(() => {
      if (!newLayout()) return
      apiKey?.focus({ preventScroll: true })
    })

    async function handleSubmit(e: SubmitEvent) {
      e.preventDefault()

      const form = e.currentTarget as HTMLFormElement
      const formData = new FormData(form)
      const apiKey = formData.get("apiKey") as string

      if (!apiKey?.trim()) {
        setFormStore("error", language.t("provider.connect.apiKey.required"))
        return
      }

      setFormStore("error", undefined)
      await serverSDK().api.integration.connect.key({
        integrationID: props.provider,
        location: location(),
        key: apiKey,
      })
      await complete()
    }

    if (newLayout())
      return (
        <div class="flex flex-col gap-5 px-3 text-[13px] font-[440] leading-5 tracking-[-0.04px] text-v2-text-text-muted">
          <Show
            when={provider().id === "opencode"}
            fallback={language.t("provider.connect.apiKey.description", { provider: provider().name })}
          >
            <div class="flex flex-col gap-5">
              <div>{language.t("provider.connect.opencodeZen.line1")}</div>
              <div>{language.t("provider.connect.opencodeZen.line2")}</div>
              <div>
                {language.t("provider.connect.opencodeZen.visit.prefix")}
                <ExternalLink
                  href="https://opencode.ai/zen"
                  class="text-v2-text-text-base focus-visible:rounded-xs focus-visible:outline-2 focus-visible:outline-v2-border-border-focus"
                >
                  {language.t("provider.connect.opencodeZen.visit.link")}
                </ExternalLink>
                {language.t("provider.connect.opencodeZen.visit.suffix")}
              </div>
            </div>
          </Show>
          <form onSubmit={handleSubmit} class="flex flex-col items-start gap-5 self-stretch">
            <label class="flex w-full flex-col gap-1 font-[530] leading-4 text-v2-text-text-base">
              {language.t("provider.connect.apiKey.label", { provider: provider().name })}
              <TextInputV2
                ref={apiKey}
                class="!w-full"
                name="apiKey"
                data-input="provider-api-key"
                placeholder={language.t("provider.connect.apiKey.placeholder")}
                value={formStore.value}
                invalid={formStore.error !== undefined}
                aria-describedby={formStore.error ? errorID : undefined}
                autocomplete="off"
                spellcheck={false}
                onInput={(event) => setFormStore("value", event.currentTarget.value)}
              />
            </label>
            <Show when={formStore.error}>
              {(error) => (
                <div id={errorID} role="alert" class="-mt-4 text-xs text-v2-state-fg-danger">
                  {error()}
                </div>
              )}
            </Show>
            <ButtonV2 type="submit" variant="contrast" data-action="provider-connect-submit">
              {language.t("common.continue")}
            </ButtonV2>
          </form>
        </div>
      )

    return (
      <div class="flex flex-col gap-6">
        <Switch>
          <Match when={provider().id === "opencode"}>
            <div class="flex flex-col gap-4">
              <div class="text-14-regular text-text-base">{language.t("provider.connect.opencodeZen.line1")}</div>
              <div class="text-14-regular text-text-base">{language.t("provider.connect.opencodeZen.line2")}</div>
              <div class="text-14-regular text-text-base">
                {language.t("provider.connect.opencodeZen.visit.prefix")}
                <ExternalLink href="https://opencode.ai/zen" tabIndex={-1}>
                  {language.t("provider.connect.opencodeZen.visit.link")}
                </ExternalLink>
                {language.t("provider.connect.opencodeZen.visit.suffix")}
              </div>
            </div>
          </Match>
          <Match when={true}>
            <div class="text-14-regular text-text-base">
              {language.t("provider.connect.apiKey.description", { provider: provider().name })}
            </div>
          </Match>
        </Switch>
        <form onSubmit={handleSubmit} class="flex flex-col items-start gap-4">
          <TextField
            autofocus={!newLayout()}
            ref={apiKey}
            type="text"
            label={language.t("provider.connect.apiKey.label", { provider: provider().name })}
            placeholder={language.t("provider.connect.apiKey.placeholder")}
            name="apiKey"
            value={formStore.value}
            onChange={(v) => setFormStore("value", v)}
            validationState={formStore.error ? "invalid" : undefined}
            error={formStore.error}
          />
          <Button class="w-auto" type="submit" size="large" variant="primary">
            {language.t("common.continue")}
          </Button>
        </form>
      </div>
    )
  }

  function OAuthCodeView() {
    let codeInput: HTMLInputElement | undefined
    const errorID = createUniqueId()
    const [formStore, setFormStore] = createStore({
      value: "",
      error: undefined as string | undefined,
    })

    onMount(() => {
      if (!newLayout()) return
      codeInput?.focus({ preventScroll: true })
    })

    async function handleSubmit(e: SubmitEvent) {
      e.preventDefault()

      const form = e.currentTarget as HTMLFormElement
      const formData = new FormData(form)
      const code = formData.get("code") as string

      if (!code?.trim()) {
        setFormStore("error", language.t("provider.connect.oauth.code.required"))
        return
      }

      setFormStore("error", undefined)
      const result = await serverSDK()
        .api.integration.oauth.complete({
          integrationID: props.provider,
          attemptID: store.authorization!.attemptID,
          location: location(),
          code,
        })
        .then(() => ({ ok: true as const }))
        .catch((error) => ({ ok: false as const, error }))
      if (result.ok) {
        await complete()
        return
      }
      setFormStore("error", formatError(result.error, language.t("provider.connect.oauth.code.invalid")))
    }

    if (newLayout())
      return (
        <div class="flex flex-col gap-5 px-3 text-[13px] font-[440] leading-5 tracking-[-0.04px] text-v2-text-text-muted">
          <div>
            {language.t("provider.connect.oauth.code.visit.prefix")}
            <ExternalLink href={store.authorization!.url} class="text-v2-text-text-base">
              {language.t("provider.connect.oauth.code.visit.link")}
            </ExternalLink>
            {language.t("provider.connect.oauth.code.visit.suffix", { provider: provider().name })}
          </div>
          <form onSubmit={handleSubmit} class="flex flex-col items-start gap-5 self-stretch">
            <label class="flex w-full flex-col gap-1 font-[530] leading-4 text-v2-text-text-base">
              {language.t("provider.connect.oauth.code.label", { method: method()?.label ?? "" })}
              <TextInputV2
                ref={codeInput}
                class="!w-full"
                name="code"
                placeholder={language.t("provider.connect.oauth.code.placeholder")}
                value={formStore.value}
                invalid={formStore.error !== undefined}
                aria-describedby={formStore.error ? errorID : undefined}
                autocomplete="off"
                spellcheck={false}
                onInput={(event) => setFormStore("value", event.currentTarget.value)}
              />
            </label>
            <Show when={formStore.error}>
              {(error) => (
                <div id={errorID} role="alert" class="-mt-4 text-xs text-v2-state-fg-danger">
                  {error()}
                </div>
              )}
            </Show>
            <ButtonV2 type="submit" variant="contrast">
              {language.t("common.continue")}
            </ButtonV2>
          </form>
        </div>
      )

    return (
      <div class="flex flex-col gap-6">
        <div class="text-14-regular text-text-base">
          {language.t("provider.connect.oauth.code.visit.prefix")}
          <ExternalLink href={store.authorization!.url}>
            {language.t("provider.connect.oauth.code.visit.link")}
          </ExternalLink>
          {language.t("provider.connect.oauth.code.visit.suffix", { provider: provider().name })}
        </div>
        <form onSubmit={handleSubmit} class="flex flex-col items-start gap-4">
          <TextField
            autofocus={!newLayout()}
            ref={codeInput}
            type="text"
            label={language.t("provider.connect.oauth.code.label", { method: method()?.label ?? "" })}
            placeholder={language.t("provider.connect.oauth.code.placeholder")}
            name="code"
            value={formStore.value}
            onChange={(v) => setFormStore("value", v)}
            validationState={formStore.error ? "invalid" : undefined}
            error={formStore.error}
          />
          <Button class="w-auto" type="submit" size="large" variant="primary">
            {language.t("common.continue")}
          </Button>
        </form>
      </div>
    )
  }

  function OAuthAutoView() {
    const code = createMemo(() => {
      const instructions = store.authorization?.instructions
      if (instructions?.includes(":")) {
        return instructions.split(":").pop()?.trim()
      }
      return instructions
    })

    onMount(() => {
      const poll = async () => {
        const authorization = store.authorization
        if (!authorization || !alive.value) return
        const result = await serverSDK()
          .api.integration.oauth.status({
            integrationID: props.provider,
            attemptID: authorization.attemptID,
            location: location(),
          })
          .then((value) => ({ ok: true as const, status: value.data }))
          .catch((error) => ({ ok: false as const, error }))
        if (!alive.value) return
        if (!result.ok) {
          dispatch({ type: "auth.error", error: formatError(result.error, language.t("common.requestFailed")) })
          return
        }
        if (result.status.status === "complete") {
          await complete()
          return
        }
        if (result.status.status === "failed") {
          dispatch({ type: "auth.error", error: result.status.message })
          return
        }
        if (result.status.status === "expired") {
          dispatch({ type: "auth.error", error: language.t("common.requestFailed") })
          return
        }
        timer.current = setTimeout(poll, 1_000)
      }
      void poll()
    })

    return (
      <div class="flex flex-col gap-6">
        <div class="text-14-regular text-text-base">
          {language.t("provider.connect.oauth.auto.visit.prefix")}
          <ExternalLink href={store.authorization!.url}>
            {language.t("provider.connect.oauth.auto.visit.link")}
          </ExternalLink>
          {language.t("provider.connect.oauth.auto.visit.suffix", { provider: provider().name })}
        </div>
        <TextField
          label={language.t("provider.connect.oauth.auto.confirmationCode")}
          class="font-mono"
          value={code()}
          readOnly
          copyable
        />
        <div class="text-14-regular text-text-base flex items-center gap-4">
          <Spinner />
          <span>{language.t("provider.connect.status.waiting")}</span>
        </div>
      </div>
    )
  }

  return (
    <div class={newLayout() ? "flex min-h-0 flex-1 flex-col" : "flex flex-col gap-6 px-2.5 pb-3"}>
      <div class={newLayout() ? "flex h-10 shrink-0 items-start gap-2 px-3" : "flex items-center gap-4 px-2.5"}>
        <ProviderIcon
          id={props.provider}
          class={newLayout() ? "mt-0.5 size-4 shrink-0 text-v2-icon-icon-base" : "size-5 shrink-0 icon-strong-base"}
        />
        <div
          class={
            newLayout()
              ? "text-[15px] font-[530] leading-5 tracking-[-0.13px] text-v2-text-text-base"
              : "text-16-medium text-text-strong"
          }
        >
          <Switch>
            <Match when={props.provider === "anthropic" && method()?.label?.toLowerCase().includes("max")}>
              {language.t("provider.connect.title.anthropicProMax")}
            </Match>
            <Match when={true}>{language.t("provider.connect.title", { provider: provider().name })}</Match>
          </Switch>
        </div>
      </div>
      <div class={newLayout() ? "flex min-h-0 flex-1 flex-col" : "flex flex-col gap-6 px-2.5 pb-10"}>
        <div
          onKeyDown={handleKey}
          tabIndex={newLayout() ? undefined : 0}
          autofocus={!newLayout() && store.methodIndex === undefined ? true : undefined}
        >
          <Switch>
            <Match when={loading()}>
              <div class="text-14-regular text-text-base">
                <div class="flex items-center gap-x-2">
                  <Spinner />
                  <span>{language.t("provider.connect.status.inProgress")}</span>
                </div>
              </div>
            </Match>
            <Match when={store.methodIndex === undefined}>
              <MethodSelection />
            </Match>
            <Match when={store.state === "pending"}>
              <div class="text-14-regular text-text-base">
                <div class="flex items-center gap-x-2">
                  <Spinner />
                  <span>{language.t("provider.connect.status.inProgress")}</span>
                </div>
              </div>
            </Match>
            <Match when={store.state === "prompt"}>
              <AuthPromptsView />
            </Match>
            <Match when={store.state === "error"}>
              <div class="text-14-regular text-text-base">
                <div class="flex items-center gap-x-2">
                  <Icon name="circle-ban-sign" class="text-icon-critical-base" />
                  <span>{language.t("provider.connect.status.failed", { error: store.error ?? "" })}</span>
                </div>
              </div>
            </Match>
            <Match when={method()?.type === "key"}>
              <ApiAuthView />
            </Match>
            <Match when={method()?.type === "oauth"}>
              <Switch>
                <Match when={store.authorization?.mode === "code"}>
                  <OAuthCodeView />
                </Match>
                <Match when={store.authorization?.mode === "auto"}>
                  <OAuthAutoView />
                </Match>
              </Switch>
            </Match>
          </Switch>
        </div>
      </div>
    </div>
  )
}
