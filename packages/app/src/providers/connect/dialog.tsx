import { Button } from "@opencode/ui/button"
import { useDialog } from "@opencode/ui/context/dialog"
import { Icon } from "@opencode/ui/icon"
import { List } from "@opencode/ui/list"
import { ProviderIcon } from "@opencode/ui/provider-icon"
import { Spinner } from "@opencode/ui/spinner"
import { Loader } from "@opencode/ui/loader"
import { TextField } from "@opencode/ui/text-field"
import { DialogBody, DialogHeader, DialogTitle, Dialog } from "@opencode/ui/dialog"
import { TextInput } from "@opencode/ui/text-input"
import { showToast } from "@/shell/notifications/toast"
import {
  type Component,
  createEffect,
  createMemo,
  createResource,
  createUniqueId,
  For,
  Match,
  onMount,
  Show,
  Switch,
} from "solid-js"
import { createStore } from "solid-js/store"
import { useParams } from "@solidjs/router"
import { ExternalLink } from "@/runtime/platform/external-link"
import { useLanguage } from "@/runtime/i18n/language"
import { useProviders } from "@/providers/catalog/providers"
import { useIntegrations } from "@/providers/catalog/integrations"
import { CustomProviderForm } from "@/providers/credentials/dialog"
import { decode64 } from "@/runtime/persistence/base64"
import { createProviderConnectionController, type ProviderConnectMethod } from "./controller"
import { ConsoleAuthorization } from "./console"
import { OpenCodeLogo } from "@/providers/opencode-logo"
import { usePlatform } from "@/runtime/platform/platform"
import { useServerSDK } from "@/runtime/server/client"
import { useData } from "@/runtime/server/current"
import { authServerName, RemoteAuthNotice } from "./remote"
import type { ModelSelection } from "@/providers/models/selection"
import { ServerConnection } from "@/runtime/server/registry"
import { useTabs } from "@/shell/tabs/tabs"
import { useSettingsSurface } from "@/settings/surface"
import { SettingsList } from "@/settings/list"
import "./models.css"

const CUSTOM_ID = "_custom"
type IntegrationForm = NonNullable<ProviderConnectMethod["form"]>[number]
type StringForm = Extract<IntegrationForm, { type: "string" }>

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
  directory?: string
  controller?: ReturnType<typeof useProviderConnectController>
  provider?: string
  initialMethod?: string
  selection?: ModelSelection
  onDone?: () => void
  onConnected?: (provider: string) => void
}> = (props) => {
  const fallback = useProviderConnectController()
  if (props.provider) fallback.select(props.provider)
  const controller = props.controller ?? fallback
  const platform = usePlatform()
  const [state, setState] = createStore({
    completed: false,
    modelProvider: undefined as { id: string; name: string } | undefined,
    authorization: false,
  })
  const language = useLanguage()
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
          <CustomProviderForm autofocus={false} />
        </Match>
        <Match
          keyed
          when={controller.selected() && controller.selected() !== CUSTOM_ID ? controller.selected() : undefined}
        >
          {(provider) => (
            <ProviderConnection
              provider={provider}
              directory={props.directory}
              onBack={reset}
              setBack={(handler) => (back.current = handler)}
              initialMethod={props.initialMethod}
              selection={props.selection}
              onDone={props.onDone ? () => setState("completed", true) : undefined}
              onConnected={() => props.onConnected?.(provider)}
              onFirstConnection={(provider) => setState("modelProvider", provider)}
              onAuthorization={(authorization) => setState("authorization", authorization)}
            />
          )}
        </Match>
        <Match when={true}>
          <ProviderPicker directory={props.directory} onSelect={select} onPrepare={holdFocus} />
        </Match>
      </Switch>
    )
  }

  return (
    <Dialog
      containerClass={
        state.modelProvider
          ? "!h-[min(calc(100vh_-_16px),560px)] !w-[min(calc(100vw_-_16px),640px)]"
          : platform.platform === "desktop" && controller.selected() === "opencode" && state.authorization
            ? "!h-auto !max-h-[min(calc(100vh_-_16px),560px)] !w-[min(calc(100vw_-_16px),640px)]"
            : "!h-[min(calc(100vh_-_16px),512px)] !w-[min(calc(100vw_-_16px),640px)]"
      }
      onCloseAutoFocus={(event) => {
        if (!state.completed || !props.onDone) return
        event.preventDefault()
        props.onDone()
      }}
      class="[font-family:var(--v2-font-family-sans)] [&_[data-slot=dialog-header]]:!px-5 [&_[data-slot=dialog-header-title]]:!text-[15px] [&_[data-slot=dialog-header-title]]:!tracking-[-0.13px]"
      classList={{
        "[&_[data-slot=dialog-header]]:!pt-4 [&_[data-slot=dialog-header]]:!pb-3":
          platform.platform === "desktop" && controller.selected() === "opencode" && !state.modelProvider,
        "[&_[data-slot=dialog-header]]:!pt-5": !!state.modelProvider,
      }}
    >
      <DialogHeader closeLabel={language.t("common.close")}>
        <Switch>
          <Match when={state.modelProvider}>
            {(provider) => (
              <div class="flex items-center gap-2">
                <Show
                  when={provider().id === "opencode"}
                  fallback={<ProviderIcon id={provider().id} class="size-4 shrink-0" />}
                >
                  <OpenCodeLogo class="size-4 shrink-0" />
                </Show>
                <DialogTitle>{language.t("provider.connect.models.title", { provider: provider().name })}</DialogTitle>
              </div>
            )}
          </Match>
          <Match when={controller.selected()}>
            <button
              type="button"
              class="flex size-5 items-center justify-center rounded-sm text-v2-icon-icon-muted hover:bg-v2-overlay-simple-overlay-hover focus-visible:bg-v2-overlay-simple-overlay-hover focus-visible:outline-none"
              onClick={() => back.current()}
              aria-label={language.t("common.goBack")}
            >
              <Icon name="arrow-left" size="small" />
            </button>
          </Match>
          <Match when={true}>
            <DialogTitle>{language.t("command.provider.connect")}</DialogTitle>
          </Match>
        </Switch>
      </DialogHeader>
      <DialogBody
        class={`min-h-0 flex-1 overflow-hidden px-2 ${state.modelProvider || (platform.platform === "desktop" && controller.selected() === "opencode") ? "pb-0" : "pb-2"}`}
      >
        <div ref={focusHost} tabIndex={-1} class="flex min-h-0 flex-1 flex-col outline-none">
          <Content />
        </div>
      </DialogBody>
    </Dialog>
  )
}

function ProviderPicker(props: { directory?: string; onSelect: (provider: string) => void; onPrepare?: () => void }) {
  const integrations = useIntegrations(() => props.directory)
  const language = useLanguage()
  const [store, setStore] = createStore({
    filter: "",
    active: undefined as string | undefined,
    connecting: undefined as string | undefined,
  })
  const featured = ["opencode-go", "opencode", "anthropic", "openai", "google", "openrouter", "vercel"]
  const custom = () => ({ id: CUSTOM_ID, name: language.t("dialog.provider.custom.label") })
  const all = createMemo(() => {
    language.locale()
    const query = store.filter.trim().toLowerCase()
    const values = [custom(), ...integrations.list()].map((provider) =>
      provider.id === "opencode" ? { ...provider, name: language.t("provider.connect.console.name") } : provider,
    )
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
        <TextInput
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
                  <div class="px-3 pb-2 text-[13px] font-[440] leading-text-compact tracking-[-0.04px] text-v2-text-text-muted">
                    {group.title}
                  </div>
                  <For each={group.items()}>
                    {(provider) => (
                      <button
                        type="button"
                        data-provider-id={provider.id}
                        class="flex min-h-9 w-full items-center gap-2 rounded-md px-3 py-2.5 text-left text-[13px] leading-text-compact tracking-[-0.04px] hover:bg-v2-overlay-simple-overlay-hover focus:bg-v2-overlay-simple-overlay-hover focus:outline-none"
                        classList={{ "bg-v2-overlay-simple-overlay-hover": store.active === provider.id }}
                        onMouseEnter={() => setStore("active", provider.id)}
                        disabled={store.connecting !== undefined}
                        aria-busy={store.connecting === provider.id}
                        onClick={() => connect(provider.id)}
                      >
                        <Show
                          when={provider.id === "opencode"}
                          fallback={<ProviderIcon id={provider.id} class="size-4 shrink-0 text-v2-icon-icon-base" />}
                        >
                          <OpenCodeLogo class="size-4 shrink-0" />
                        </Show>
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
  directory?: string
  onBack: () => void
  setBack: (handler: () => void) => void
  initialMethod?: string
  selection?: ModelSelection
  onDone?: () => void
  onConnected?: () => void
  onFirstConnection: (provider: { id: string; name: string }) => void
  onAuthorization: (authorization: boolean) => void
}) {
  const dialog = useDialog()
  const params = useParams()
  const language = useLanguage()
  const providers = useProviders(() => props.directory)
  const initialDirectory = props.directory ?? decode64(params.dir)
  const directory = () => initialDirectory
  const platform = usePlatform()
  const sdk = useServerSDK()
  const data = useData()
  const tabs = useTabs()
  const surface = useSettingsSurface()
  const integrations = useIntegrations(directory)
  const desktopConsole = platform.platform === "desktop" && props.provider === "opencode"
  const remote = desktopConsole && authServerName(sdk.server) !== undefined
  const initialModel = props.selection?.current()
  const [consoleState, setConsoleState] = createStore({
    copied: false,
    copyFailed: false,
    firstConnection: undefined as boolean | undefined,
    models: false,
    selectedModel: "",
    collapsed: {} as Record<string, boolean>,
  })
  const consoleMethod = () => {
    const method = controller.currentMethod()
    return desktopConsole && method?.type === "oauth" && method.id === "device"
  }
  const done = () => {
    props.onDone?.()
    dialog.close()
  }

  const controller = createProviderConnectionController({
    provider: () => props.provider,
    directory,
    initialMethod: remote ? undefined : props.initialMethod,
    onComplete: () => {
      props.onConnected?.()
      if (consoleState.firstConnection) {
        if (connectionModels().length > 0) {
          const first = connectionGroups()[0]?.models[0]
          setConsoleState({ models: true, selectedModel: first ? modelKey(first) : "" })
          props.onFirstConnection({ id: props.provider, name: connectedProviderName() })
          return
        }
        if (consoleMethod()) return
      }
      dialog.close()
      surface.openServer(ServerConnection.key(sdk.server), "providers")
      showToast({
        variant: "success",
        icon: "circle-check",
        title: language.t("provider.connect.toast.connected.title", { provider: provider().name }),
        description: language.t("provider.connect.toast.connected.description", { provider: provider().name }),
      })
    },
  })
  createEffect(() => {
    const current = controller.integration()
    if (!current || consoleState.firstConnection !== undefined) return
    const existingConnection = integrations.list().some((integration) => integration.connections.length > 0)
    const existingProvider = providers
      .connected()
      .some((provider) => provider.id !== "opencode" && Object.keys(provider.models).length > 0)
    setConsoleState("firstConnection", !existingConnection && !existingProvider)
  })
  const [defaultModel] = createResource(
    () => controller.auth.state() === "ready" && consoleMethod(),
    () =>
      sdk.api.model
        .default({ location: initialDirectory ? { directory: initialDirectory } : undefined })
        .then((response) => response.data)
        .catch(() => undefined),
  )
  const consoleModels = createMemo(() => {
    const location = initialDirectory ? { directory: initialDirectory } : undefined
    const connected = new Set(
      (data.location.provider.list(location) ?? [])
        .filter((provider) => provider.integrationID === "opencode")
        .map((provider) => provider.id),
    )
    return (data.location.model.list(location) ?? [])
      .filter((model) => connected.has(model.providerID) && model.enabled && model.status !== "deprecated")
      .toSorted((a, b) => a.providerID.localeCompare(b.providerID) || a.id.localeCompare(b.id))
  })
  const connectionModels = createMemo(() => {
    const location = initialDirectory ? { directory: initialDirectory } : undefined
    const ids = new Set(
      (data.location.provider.list(location) ?? [])
        .filter((provider) => provider.id === props.provider || provider.integrationID === props.provider)
        .map((provider) => provider.id),
    )
    return (data.location.model.list(location) ?? []).filter(
      (model) => ids.has(model.providerID) && model.enabled && model.status !== "deprecated",
    )
  })
  const connectionGroups = createMemo(() => {
    const location = initialDirectory ? { directory: initialDirectory } : undefined
    const models = connectionModels()
    return (data.location.provider.list(location) ?? [])
      .filter((provider) => provider.id === props.provider || provider.integrationID === props.provider)
      .map((provider) => ({ provider, models: models.filter((model) => model.providerID === provider.id) }))
      .filter((group) => group.models.length > 0)
  })
  const modelKey = (model: { providerID: string; id: string }) => `${model.providerID}:${model.id}`
  const selectedModel = () => connectionModels().find((model) => modelKey(model) === consoleState.selectedModel)
  const connectedProviderName = () => (props.provider === "opencode" ? "OpenCode" : provider().name)
  const recommended = () => {
    const current = props.selection?.current()
    if (initialModel && current?.id === initialModel.id && current.provider.id === initialModel.provider.id)
      return current
    const preferred = defaultModel()
    return (
      consoleModels().find((model) => model.providerID === preferred?.providerID && model.id === preferred.id) ??
      consoleModels()[0]
    )
  }
  const copyLink = async () => {
    const url = controller.authorization()?.url
    if (!url) return
    const copied = await Promise.resolve()
      .then(() => (platform.writeClipboardText ? platform.writeClipboardText(url) : navigator.clipboard.writeText(url)))
      .then(() => true)
      .catch(() => false)
    if (controller.authorization()?.url !== url) return
    setConsoleState({ copied, copyFailed: !copied })
  }
  createEffect(() => {
    controller.authorization()?.attemptID
    setConsoleState({ copied: false, copyFailed: false })
  })
  createEffect(() => props.onAuthorization(controller.authorization() !== undefined))
  const provider = createMemo(() => ({
    id: props.provider,
    name:
      props.provider === "opencode"
        ? language.t("provider.connect.console.name")
        : (providers.all().get(props.provider)?.name ?? controller.integration()?.name ?? props.provider),
  }))
  const methodLabel = (value?: { type?: string; label?: string }) => {
    if (!value) return ""
    if (value.type === "key")
      return language.t(desktopConsole ? "provider.connect.console.serviceKey" : "provider.connect.method.apiKey")
    return value.label ?? ""
  }

  const methodDetails = (value?: { type?: string; label?: string }) => {
    const label = methodLabel(value)
    if (desktopConsole && value?.type === "key") return { label }
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

  function AuthFormView() {
    const [formStore, setFormStore] = createStore({
      value: {} as Record<string, string>,
      index: 0,
    })

    const fields = createMemo<StringForm[]>(() => {
      const value = controller.currentMethod()
      return (value?.form ?? []).flatMap((field) => (field.type === "string" ? [field] : []))
    })
    const matches = (field: StringForm, value: Record<string, string>) => {
      return (field.when ?? []).every((condition) => {
        const actual = value[condition.key]
        if (actual === undefined) return false
        return condition.op === "eq" ? actual === condition.value : actual !== condition.value
      })
    }
    const current = createMemo(() => {
      const all = fields()
      const index = all.findIndex((field, index) => index >= formStore.index && matches(field, formStore.value))
      if (index === -1) return undefined
      return {
        index,
        field: all[index],
      }
    })
    const valid = createMemo(() => {
      const item = current()
      if (!item || item.field.options) return false
      if (!item.field.required) return true
      return (formStore.value[item.field.key] ?? "").trim().length > 0
    })

    async function next(index: number, value: Record<string, string>) {
      const selected = controller.methodIndex()
      if (selected === undefined) return
      const next = fields().findIndex((field, i) => i > index && matches(field, value))
      if (next !== -1) {
        setFormStore("index", next)
        return
      }
      await controller.auth.select(selected, value)
    }

    async function handleSubmit(e: SubmitEvent) {
      e.preventDefault()
      const item = current()
      if (!item || item.field.options) return
      if (!valid()) return
      await next(item.index, formStore.value)
    }

    const item = () => current()
    const text = createMemo(() => {
      const field = item()?.field
      if (!field || field.options) return undefined
      return field
    })
    const select = createMemo(() => {
      const field = item()?.field
      if (!field?.options) return undefined
      return field
    })

    return (
      <form onSubmit={handleSubmit} class="flex flex-col items-start gap-4">
        <Switch>
          <Match when={item()?.field.options === undefined}>
            <TextField
              type="text"
              label={text()?.title ?? ""}
              placeholder={text()?.placeholder}
              value={text() ? (formStore.value[text()!.key] ?? "") : ""}
              onChange={(value) => {
                const field = text()
                if (!field) return
                setFormStore("value", field.key, value)
              }}
            />
            <Button class="w-auto" type="submit" size="large" variant="contrast" disabled={!valid()}>
              {language.t("common.continue")}
            </Button>
          </Match>
          <Match when={item()?.field.options !== undefined}>
            <div class="w-full flex flex-col gap-1.5">
              <div class="text-14-regular text-text-base">{select()?.title}</div>
              <div>
                <List
                  class="px-3"
                  items={select()?.options ?? []}
                  key={(x) => x.value}
                  current={select()?.options?.find((x) => x.value === formStore.value[select()!.key])}
                  onSelect={(value) => {
                    if (!value) return
                    const field = select()
                    if (!field) return
                    const nextValue = {
                      ...formStore.value,
                      [field.key]: value.value,
                    }
                    setFormStore("value", field.key, value.value)
                    void next(item()!.index, nextValue)
                  }}
                >
                  {(option) => (
                    <div class="w-full flex items-center gap-x-2">
                      <div class="w-4 h-2 rounded-[1px] bg-input-base shadow-xs-border-base flex items-center justify-center">
                        <div class="w-2.5 h-0.5 ml-0 bg-icon-strong-base hidden" data-slot="list-item-extra-icon" />
                      </div>
                      <span>{option.label}</span>
                      <span class="text-14-regular text-text-weak">{option.description}</span>
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

  function goBack() {
    if (controller.methods().length > 1 && controller.methodIndex() !== undefined) {
      controller.auth.reset()
      return
    }
    props.onBack()
  }

  props.setBack(goBack)

  function MethodSelection() {
    const primary = () =>
      desktopConsole
        ? controller.methods().findIndex((method) => method.type === "oauth" && method.id === "device")
        : -1
    const serviceAccount = () => controller.methods().findIndex((method) => method.type === "key")
    return (
      <div class="flex flex-col gap-2">
        <Show when={primary() >= 0}>
          <div class="flex flex-col items-start gap-5">
            <p class="text-[13px] leading-5 text-v2-text-text-muted">{language.t("provider.connect.console.intro")}</p>
            <Button
              size="large"
              class="!px-3"
              variant="contrast"
              disabled={controller.selecting(primary())}
              aria-busy={controller.selecting(primary())}
              onClick={() => void controller.auth.select(primary())}
            >
              <Show when={controller.selecting(primary())}>
                <span class="absolute inset-0 flex items-center justify-center gap-1.5">
                  <Loader />
                  <span>{language.t("provider.connect.console.openingBrowser")}</span>
                </span>
              </Show>
              <span
                aria-hidden={controller.selecting(primary()) ? "true" : undefined}
                classList={{ "opacity-0": controller.selecting(primary()) }}
              >
                {language.t("provider.connect.console.continue")}
              </span>
            </Button>
            <Show when={serviceAccount() >= 0}>
              <div data-component="console-service-account" class="flex h-7 items-center gap-1">
                <span class="text-v2-text-text-faint">{language.t("provider.connect.console.serviceAccount")}</span>
                <Button variant="ghost-muted" onClick={() => void controller.auth.select(serviceAccount())}>
                  {language.t("provider.connect.console.useApiKey")}
                </Button>
              </div>
            </Show>
          </div>
        </Show>
        <Show when={primary() < 0}>
          <div class="px-3 text-[13px] font-[440] leading-5 tracking-[-0.04px] text-v2-text-text-muted">
            {language.t("provider.connect.selectMethod", { provider: provider().name })}
          </div>
          <div class="flex flex-col">
            <For each={controller.methods()}>
              {(item, index) => {
                const details = () => methodDetails(item)
                return (
                  <Show when={index() !== primary()}>
                    <button
                      type="button"
                      class="group flex h-9 w-full items-center gap-2 rounded-md px-3 text-left text-[13px] leading-5 tracking-[-0.04px] hover:bg-v2-overlay-simple-overlay-hover focus-visible:bg-v2-overlay-simple-overlay-hover focus-visible:outline-none"
                      onClick={() => void controller.auth.select(index())}
                    >
                      <span class="flex h-2 w-4 shrink-0 items-center justify-center rounded-[1px] bg-v2-background-bg-base shadow-[var(--v2-elevation-button-neutral)]">
                        <span class="hidden h-0.5 w-2.5 bg-v2-icon-icon-base group-hover:block group-focus-visible:block" />
                      </span>
                      <span class="font-[530] text-v2-text-text-base">{details().label}</span>
                      <Show when={details().hint}>
                        {(hint) => <span class="font-[440] text-v2-text-text-muted">{hint()}</span>}
                      </Show>
                    </button>
                  </Show>
                )
              }}
            </For>
          </div>
        </Show>
      </div>
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
      apiKey?.focus({ preventScroll: true })
    })

    async function handleSubmit(e: SubmitEvent) {
      e.preventDefault()

      if (!(e.currentTarget instanceof HTMLFormElement)) return
      const value = new FormData(e.currentTarget).get("apiKey")
      const apiKey = typeof value === "string" ? value : ""

      if (!apiKey?.trim()) {
        setFormStore("error", language.t("provider.connect.apiKey.required"))
        return
      }

      setFormStore("error", undefined)
      await controller.auth.connectKey(apiKey)
    }

    return (
      <div
        class={`flex flex-col gap-5 text-[13px] font-[440] leading-5 tracking-[-0.04px] text-v2-text-text-muted ${desktopConsole ? "pb-1" : "px-3"}`}
      >
        <Show when={desktopConsole}>
          <p>{language.t("provider.connect.console.serviceKeyDescription")}</p>
        </Show>
        <Show when={!desktopConsole}>
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
        </Show>
        <form onSubmit={handleSubmit} class="flex flex-col items-start gap-5 self-stretch">
          <label class="flex w-full flex-col gap-2 font-[530] leading-4 text-v2-text-text-base">
            <span data-component="provider-api-key-label">
              {language.t("provider.connect.apiKey.label", { provider: provider().name })}
            </span>
            <TextInput
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
          <Button
            type="submit"
            class={desktopConsole ? "!px-3" : undefined}
            variant="contrast"
            data-action="provider-connect-submit"
          >
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
      codeInput?.focus({ preventScroll: true })
    })

    async function handleSubmit(e: SubmitEvent) {
      e.preventDefault()

      if (!(e.currentTarget instanceof HTMLFormElement)) return
      const value = new FormData(e.currentTarget).get("code")
      const code = typeof value === "string" ? value : ""

      if (!code?.trim()) {
        setFormStore("error", language.t("provider.connect.oauth.code.required"))
        return
      }

      setFormStore("error", undefined)
      setFormStore("error", await controller.auth.completeCode(code))
    }

    return (
      <div class="flex flex-col gap-5 px-3 text-[13px] font-[440] leading-5 tracking-[-0.04px] text-v2-text-text-muted">
        <div>
          {language.t("provider.connect.oauth.code.visit.prefix")}
          <ExternalLink href={controller.authorization()!.url} class="text-v2-text-text-base">
            {language.t("provider.connect.oauth.code.visit.link")}
          </ExternalLink>
          {language.t("provider.connect.oauth.code.visit.suffix", { provider: provider().name })}
        </div>
        <form onSubmit={handleSubmit} class="flex flex-col items-start gap-5 self-stretch">
          <label class="flex w-full flex-col gap-2 font-[530] leading-4 text-v2-text-text-base">
            {language.t("provider.connect.oauth.code.label", { method: controller.currentMethod()?.label ?? "" })}
            <TextInput
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
          <Button type="submit" variant="contrast">
            {language.t("common.continue")}
          </Button>
        </form>
      </div>
    )
  }

  function OAuthAutoView() {
    const code = createMemo(() => {
      const instructions = controller.authorization()?.instructions
      if (instructions?.includes(":")) {
        return instructions.split(":").pop()?.trim()
      }
      return instructions
    })

    return (
      <Show
        when={consoleMethod()}
        fallback={
          <div class="flex flex-col gap-6">
            <div class="text-14-regular text-text-base">
              {language.t("provider.connect.oauth.auto.visit.prefix")}
              <ExternalLink href={controller.authorization()!.url}>
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
        }
      >
        <ConsoleAuthorization
          code={new URL(controller.authorization()!.url).searchParams.get("user_code") ?? code() ?? ""}
          browserFailed={controller.browserFailed()}
          copied={consoleState.copied}
          copyFailed={consoleState.copyFailed}
          onCopy={() => void copyLink()}
          onOpen={() => void controller.openBrowser()}
        />
      </Show>
    )
  }

  const startWithModel = async () => {
    const model = selectedModel()
    if (!model) return
    const selection = { providerID: model.providerID, modelID: model.id }
    if (props.selection) {
      props.selection.set(selection)
      done()
      return
    }
    dialog.close()
    await tabs.newDraft(
      {
        server: ServerConnection.key(sdk.server),
        directory: initialDirectory ?? data.location.default().directory,
      },
      undefined,
      selection,
    )
  }

  function FirstConnectionModels() {
    return (
      <div data-component="first-provider-models" class="flex min-h-0 flex-1 flex-col px-3">
        <p class="shrink-0 pb-5 text-[13px] leading-5 text-v2-text-text-muted">
          {language.t("provider.connect.models.description")}
        </p>
        <div
          data-component="first-provider-model-scroll"
          class="settings-panel settings-models min-h-0 flex-1 overflow-y-auto pb-4"
        >
          <div
            role="radiogroup"
            aria-label={language.t("provider.connect.models.list", { provider: connectedProviderName() })}
          >
            <For each={connectionGroups()}>
              {(group) => {
                const collapsible = () => connectionGroups().length > 1
                const expanded = () => !collapsible() || !consoleState.collapsed[group.provider.id]
                const label = () => (
                  <span class="settings-models-group-label">
                    <Show
                      when={group.provider.id === "opencode"}
                      fallback={<ProviderIcon id={group.provider.id} class="size-4 shrink-0" />}
                    >
                      <OpenCodeLogo class="size-4 shrink-0" />
                    </Show>
                    <span class="settings-section-title">{group.provider.name}</span>
                  </span>
                )
                return (
                  <section class="settings-section" data-expanded={expanded() ? "" : undefined}>
                    <h3
                      class="settings-models-group-header sticky top-0 z-[1] box-content bg-v2-background-bg-layer-01"
                      classList={{ "pb-2": collapsible() && !expanded() }}
                    >
                      <Show when={collapsible()} fallback={<div class="settings-models-group-trigger">{label()}</div>}>
                        <button
                          type="button"
                          class="settings-models-group-trigger"
                          aria-expanded={expanded()}
                          onClick={() => setConsoleState("collapsed", group.provider.id, expanded())}
                        >
                          <span class="settings-models-group-chevron">
                            <Icon
                              name="chevron-down"
                              size="small"
                              classList={{ "-rotate-90 rtl:rotate-90": !expanded() }}
                            />
                          </span>
                          {label()}
                        </button>
                      </Show>
                    </h3>
                    <Show when={expanded()}>
                      <SettingsList>
                        <For each={group.models}>
                          {(model) => {
                            const selected = () => consoleState.selectedModel === modelKey(model)
                            return (
                              <button
                                type="button"
                                role="radio"
                                data-component="settings-row"
                                data-first-provider-model=""
                                data-selected={selected() ? "" : undefined}
                                aria-checked={selected()}
                                class="-mx-4 w-[calc(100%+32px)] px-4 text-start focus-visible:bg-v2-overlay-simple-overlay-hover focus-visible:outline-none"
                                onClick={() => setConsoleState("selectedModel", modelKey(model))}
                              >
                                <div data-slot="settings-row-copy">
                                  <div data-slot="settings-row-title">
                                    <span class="min-w-0 truncate">{model.name}</span>
                                  </div>
                                </div>
                                <div data-slot="settings-row-control" class="size-4">
                                  <Show when={selected()}>
                                    <Icon name="check" size="small" class="shrink-0 text-v2-icon-icon-base" />
                                  </Show>
                                </div>
                              </button>
                            )
                          }}
                        </For>
                      </SettingsList>
                    </Show>
                  </section>
                )
              }}
            </For>
          </div>
        </div>
        <div
          data-component="first-provider-model-footer"
          class="-mx-5 flex h-15 shrink-0 items-center justify-between border-t border-v2-border-border-muted px-4"
        >
          <Button
            variant="ghost-muted"
            icon="outline-sliders"
            onClick={() => {
              dialog.close()
              surface.openServer(ServerConnection.key(sdk.server), "models")
            }}
          >
            {language.t("dialog.model.manage")}
          </Button>
          <Button variant="contrast" disabled={!selectedModel()} onClick={() => void startWithModel()}>
            {language.t("common.continue")}
          </Button>
        </div>
      </div>
    )
  }

  return (
    <Show when={!consoleState.models} fallback={<FirstConnectionModels />}>
      <div class="flex min-h-0 flex-1 flex-col">
        <div
          class={
            desktopConsole ? "flex shrink-0 items-center gap-2 px-3 pb-6" : "flex h-10 shrink-0 items-start gap-2 px-3"
          }
        >
          <Show
            when={props.provider === "opencode"}
            fallback={<ProviderIcon id={props.provider} class="mt-0.5 size-4 shrink-0 text-v2-icon-icon-base" />}
          >
            <OpenCodeLogo class="size-4 shrink-0" />
          </Show>
          <div class="text-[15px] font-[530] leading-5 tracking-[-0.13px] text-v2-text-text-base">
            <DialogTitle>
              <Switch>
                <Match when={consoleMethod()}>{language.t("provider.connect.console.title")}</Match>
                <Match
                  when={
                    props.provider === "anthropic" && controller.currentMethod()?.label?.toLowerCase().includes("max")
                  }
                >
                  {language.t("provider.connect.title.anthropicProMax")}
                </Match>
                <Match when={true}>{language.t("provider.connect.title", { provider: provider().name })}</Match>
              </Switch>
            </DialogTitle>
          </div>
        </div>
        <div
          class={
            desktopConsole ? "flex min-h-0 flex-1 flex-col overflow-y-auto px-4 pb-4" : "flex min-h-0 flex-1 flex-col"
          }
        >
          <Show when={remote}>
            <div class="mb-5">
              <RemoteAuthNotice server={sdk.server} />
            </div>
          </Show>
          <div>
            <Switch>
              <Match when={controller.auth.state() === "ready" && consoleMethod()}>
                <div class="flex flex-col items-start gap-5 text-[13px] leading-5 text-v2-text-text-muted">
                  <div role="status">
                    <p class="flex items-center gap-2 font-medium text-v2-text-text-base">
                      <Icon name="circle-check" />
                      {language.t("provider.connect.console.connected")}
                    </p>
                    <p>
                      {language.t(
                        consoleModels().length ? "provider.connect.console.ready" : "provider.connect.console.noModels",
                      )}
                    </p>
                  </div>
                  <Show when={recommended()}>
                    {(model) => (
                      <p>
                        {language.t("provider.connect.console.model")}{" "}
                        <span class="font-medium text-v2-text-text-base">{model().name}</span>
                      </p>
                    )}
                  </Show>
                  <Show
                    when={consoleModels().length > 0}
                    fallback={
                      <>
                        <Button onClick={() => platform.openExternal("https://opencode.ai/console")}>
                          {language.t("provider.connect.console.openAgain")}
                        </Button>
                        <Button onClick={() => void controller.auth.refresh()}>
                          {language.t("provider.connect.console.refresh")}
                        </Button>
                      </>
                    }
                  >
                    <Button
                      variant="contrast"
                      disabled={defaultModel.loading}
                      onClick={() => {
                        const model = recommended()
                        if (props.selection && model)
                          props.selection.set({ providerID: model.providerID, modelID: model.id })
                        done()
                      }}
                    >
                      {language.t(props.onDone ? "provider.connect.console.start" : "provider.connect.console.done")}
                    </Button>
                  </Show>
                </div>
              </Match>
              <Match when={desktopConsole && controller.auth.state() === "refreshing"}>
                <p role="status" class="text-[13px] leading-5 text-v2-text-text-muted">
                  {language.t("provider.connect.console.refreshing")}
                </p>
              </Match>
              <Match when={controller.loading()}>
                <div class="text-14-regular text-text-base">
                  <div class="flex items-center gap-x-2">
                    <Spinner />
                    <span>{language.t("provider.connect.status.inProgress")}</span>
                  </div>
                </div>
              </Match>
              <Match when={controller.methodIndex() === undefined}>
                <MethodSelection />
              </Match>
              <Match when={controller.auth.state() === "pending"}>
                <div class="text-14-regular text-text-base">
                  <div class="flex items-center gap-x-2">
                    <Spinner />
                    <span>{language.t("provider.connect.status.inProgress")}</span>
                  </div>
                </div>
              </Match>
              <Match when={controller.auth.state() === "form"}>
                <AuthFormView />
              </Match>
              <Match when={controller.auth.state() === "error"}>
                <div class="text-14-regular text-text-base" role="alert">
                  <div class="flex items-center gap-x-2">
                    <Icon name="circle-ban-sign" class="text-icon-critical-base" />
                    <span>
                      {desktopConsole
                        ? controller.auth.error()
                        : language.t("provider.connect.status.failed", { error: controller.auth.error() ?? "" })}
                    </span>
                  </div>
                  <Show when={desktopConsole}>
                    <Button class="mt-4" onClick={() => void controller.auth.retry()}>
                      {language.t("provider.connect.console.retry")}
                    </Button>
                  </Show>
                </div>
              </Match>
              <Match when={controller.currentMethod()?.type === "key"}>
                <ApiAuthView />
              </Match>
              <Match when={controller.currentMethod()?.type === "oauth"}>
                <Switch>
                  <Match when={controller.authorization()?.mode === "code"}>
                    <OAuthCodeView />
                  </Match>
                  <Match when={controller.authorization()?.mode === "auto"}>
                    <OAuthAutoView />
                  </Match>
                </Switch>
              </Match>
            </Switch>
          </div>
        </div>
      </div>
    </Show>
  )
}
