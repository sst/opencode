import { Button } from "@opencode/ui/button"
import { Badge } from "@opencode/ui/badge"
import { useDialog } from "@opencode/ui/context/dialog"
import { Icon } from "@opencode/ui/icon"
import { ProviderIcon } from "@opencode/ui/provider-icon"
import { OpenCodeLogo } from "@/providers/opencode-logo"
import { showToast } from "@/shell/notifications/toast"
import { popularProviders, useProviders } from "@/providers/catalog/providers"
import { useIntegrations } from "@/providers/catalog/integrations"
import { createEffect, createMemo, type Component, For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/runtime/i18n/language"
import { useServerSDK } from "@/runtime/server/client"
import { DialogConnectProvider, useProviderConnectController } from "@/providers/connect/dialog"
import { SettingsList } from "@/settings/list"
import "@/settings/settings.css"

type ProviderSource = "env" | "api" | "config" | "custom"
type ProviderItem = ReturnType<ReturnType<typeof useProviders>["connected"]>[number]

const PROVIDER_NOTES = [
  { match: (id: string) => id === "opencode", key: "dialog.provider.opencode.note" },
  { match: (id: string) => id === "opencode-go", key: "dialog.provider.opencodeGo.tagline" },
  { match: (id: string) => id === "anthropic", key: "dialog.provider.anthropic.note" },
  { match: (id: string) => id.startsWith("github-copilot"), key: "dialog.provider.copilot.note" },
  { match: (id: string) => id === "openai", key: "dialog.provider.openai.note" },
  { match: (id: string) => id === "google", key: "dialog.provider.google.note" },
  { match: (id: string) => id === "openrouter", key: "dialog.provider.openrouter.note" },
  { match: (id: string) => id === "vercel", key: "dialog.provider.vercel.note" },
] as const

const PROVIDER_ICON_SIZE = 16

export const SettingsProviders: Component<{
  directory: string | undefined
  onBack?: () => void
  onSelectProvider?: (providerID: string) => void
}> = (props) => {
  const dialog = useDialog()
  const language = useLanguage()
  const serverSdk = useServerSDK()
  const providers = useProviders(() => props.directory)
  const integrations = useIntegrations(() => props.directory)
  const providerConnect = useProviderConnectController({ onBack: props.onBack })
  const [state, setState] = createStore({
    disconnecting: {} as Record<string, "removing" | "removed" | undefined>,
    consoleExpanded: false,
  })
  const updateDisconnecting = (ids: string[], status: "removing" | "removed" | undefined) =>
    setState("disconnecting", (current) => ({
      ...current,
      ...Object.fromEntries(ids.map((id) => [id, status])),
    }))
  const integration = (providerID: string) => integrations.list().find((item) => item.id === providerID)

  const connect = (provider?: string) => {
    providerConnect.select(provider)
    void dialog.show(() => (
      <DialogConnectProvider
        directory={props.directory}
        controller={providerConnect}
        onConnected={(providerID) =>
          setState("disconnecting", (current) =>
            providerID === "opencode" ? {} : { ...current, [providerID]: undefined },
          )
        }
      />
    ))
  }

  const available = createMemo(() => {
    return providers
      .connected()
      .filter(
        (provider) =>
          provider.id !== "opencode" || Object.values(provider.models).some((model) => model.cost.input > 0),
      )
      .toSorted((a, b) => Number(b.id === "opencode-go") - Number(a.id === "opencode-go"))
  })

  createEffect(() => {
    const ids = new Set(available().map((item) => item.id))
    Object.entries(state.disconnecting).forEach(([id, status]) => {
      if (status === "removing" && !ids.has(id)) setState("disconnecting", id, "removed")
    })
  })

  const connected = createMemo(() => available().filter((item) => !state.disconnecting[item.id]))

  const consoleGroup = createMemo(() => {
    const root = available().find((item) => item.id === "opencode")
    const suffix = " / OpenCode"
    if (!root?.name.endsWith(suffix)) return
    const workspace = root.name.slice(0, -suffix.length).trim()
    if (!workspace) return
    const prefix = `${workspace} / `
    return {
      root,
      workspace,
      providers: available().filter((item) => item.name.startsWith(prefix)),
      prefix,
    }
  })

  const displayed = createMemo(() => {
    const group = consoleGroup()
    if (!group) return connected()
    const grouped = new Set(group.providers.filter((item) => item.id !== group.root.id).map((item) => item.id))
    return connected().filter((item) => !grouped.has(item.id))
  })

  const popular = createMemo(() => {
    const connectedIDs = new Set(connected().map((p) => p.id))
    const items = providers
      .popular()
      .filter((p) => !connectedIDs.has(p.id))
      .slice()
    items.sort((a, b) => popularProviders.indexOf(a.id) - popularProviders.indexOf(b.id))
    return items
  })

  // Connection state comes from the integration list like the TUI: credential
  // connections mean an API key or OAuth grant, env connections mean detected
  // environment variables, and a connectionless integration is config-provided.
  const source = (item: ProviderItem): ProviderSource | undefined => {
    const current = integration(item.id)
    if (current?.connections.some((connection) => connection.type === "credential")) return "api"
    if (current?.connections.some((connection) => connection.type === "env")) return "env"
    if (current) return "config"
    if (!("source" in item)) return
    const value = item.source
    if (value === "env" || value === "api" || value === "config" || value === "custom") return value
    return
  }

  const type = (item: ProviderItem) => {
    const current = source(item)
    if (current === "env") return language.t("settings.providers.tag.environment")
    if (current === "api") return language.t("provider.connect.method.apiKey")
    if (current === "config") return language.t("settings.providers.tag.config")
    if (current === "custom") return language.t("settings.providers.tag.custom")
    return language.t("settings.providers.tag.other")
  }

  const canDisconnect = (item: ProviderItem) => {
    const current = integration(item.id)
    if (current) return current.connections.some((connection) => connection.type === "credential")
    const currentSource = source(item)
    return currentSource !== "env" && currentSource !== "config"
  }

  const note = (id: string) => PROVIDER_NOTES.find((item) => item.match(id))?.key

  const disconnect = async (providerID: string, name: string) => {
    if (state.disconnecting[providerID]) return
    const group = consoleGroup()
    const ids = group?.root.id === providerID ? group.providers.map((provider) => provider.id) : [providerID]
    updateDisconnecting(ids, "removing")
    const location = props.directory ? { directory: props.directory } : undefined
    await serverSdk.api.integration
      .get({ integrationID: providerID, location })
      .then(async (integration) => {
        const credentials = integration.data?.connections.filter((item) => item.type === "credential") ?? []
        if (credentials.length === 0) throw new Error(`No removable credentials found for ${name}`)
        await Promise.all(
          credentials.map((credential) => serverSdk.api.credential.remove({ credentialID: credential.id, location })),
        )
        updateDisconnecting(ids, "removed")
        showToast({
          variant: "success",
          icon: "circle-check",
          title: language.t("provider.disconnect.toast.disconnected.title", { provider: name }),
          description: language.t("provider.disconnect.toast.disconnected.description", { provider: name }),
        })
      })
      .catch((err: unknown) => {
        updateDisconnecting(ids, undefined)
        const message = err instanceof Error ? err.message : String(err)
        showToast({ title: language.t("common.requestFailed"), description: message })
      })
  }

  return (
    <>
      <div class="settings-tab-header">
        <div class="settings-tab-header-row">
          <div class="flex flex-col gap-1">
            <h2 class="settings-tab-title">{language.t("settings.providers.title")}</h2>
            <span class="text-11-regular text-v2-text-text-muted">{language.t("settings.providers.description")}</span>
          </div>
        </div>
      </div>

      <div class="settings-tab-body settings-tab-body--sectioned settings-providers">
        <div class="settings-section" data-component="connected-providers-section">
          <h3 class="settings-section-title">{language.t("settings.providers.section.connected")}</h3>
          <SettingsList variant="catalog">
            <Show
              when={displayed().length > 0}
              fallback={<div class="settings-provider-empty">{language.t("settings.providers.connected.empty")}</div>}
            >
              <For each={displayed()}>
                {(item) => {
                  const console = () => (consoleGroup()?.root.id === item.id ? consoleGroup() : undefined)
                  return (
                    <Show
                      when={console()}
                      fallback={
                        <div class="settings-provider-row group">
                          <div class="settings-provider-lead">
                            <Show
                              when={item.id === "opencode"}
                              fallback={
                                <ProviderIcon
                                  id={item.id}
                                  width={PROVIDER_ICON_SIZE}
                                  height={PROVIDER_ICON_SIZE}
                                  class="settings-provider-icon shrink-0"
                                />
                              }
                            >
                              <OpenCodeLogo class="settings-provider-icon size-4 shrink-0" />
                            </Show>
                            <div class="settings-provider-main">
                              <span class="settings-provider-name truncate">{item.name}</span>
                              <Badge>{type(item)}</Badge>
                            </div>
                          </div>
                          <Show
                            when={canDisconnect(item)}
                            fallback={
                              <span class="settings-provider-env-hint">
                                {language.t("settings.providers.connected.environmentDescription")}
                              </span>
                            }
                          >
                            <Button
                              size="normal"
                              variant="ghost-muted"
                              onClick={() => void disconnect(item.id, item.name)}
                            >
                              {language.t("common.disconnect")}
                            </Button>
                          </Show>
                        </div>
                      }
                    >
                      {(group) => (
                        <div class="settings-provider-console group">
                          <div class="settings-provider-console-header">
                            <div class="settings-provider-lead">
                              <OpenCodeLogo class="settings-provider-icon size-4 shrink-0" />
                              <div class="settings-provider-console-summary">
                                <div class="settings-provider-main">
                                  <span class="settings-provider-name truncate">
                                    {language.t("provider.connect.console.name")}
                                  </span>
                                  <Badge>{group().workspace}</Badge>
                                </div>
                                <Show when={group().providers.length > 1}>
                                  <button
                                    type="button"
                                    class="settings-provider-console-toggle"
                                    aria-expanded={state.consoleExpanded}
                                    onClick={() => setState("consoleExpanded", (value) => !value)}
                                  >
                                    <span>
                                      {language.plural(
                                        "settings.providers.console.available",
                                        group().providers.length,
                                        { count: group().providers.length },
                                      )}
                                    </span>
                                    <Icon
                                      name="chevron-right"
                                      size="small"
                                      classList={{
                                        "settings-provider-console-chevron": true,
                                        open: state.consoleExpanded,
                                      }}
                                    />
                                  </button>
                                </Show>
                              </div>
                            </div>
                            <Button
                              size="normal"
                              variant="ghost-muted"
                              onClick={() => void disconnect(item.id, language.t("provider.connect.console.name"))}
                            >
                              {language.t("common.disconnect")}
                            </Button>
                          </div>
                          <Show when={state.consoleExpanded}>
                            <div class="settings-provider-console-list">
                              <div class="settings-provider-console-separator" aria-hidden="true" />
                              <For each={group().providers}>
                                {(provider) => (
                                  <button
                                    type="button"
                                    class="settings-provider-console-item"
                                    onClick={() => props.onSelectProvider?.(provider.id)}
                                  >
                                    <span>{provider.name.slice(group().prefix.length)}</span>
                                    <Icon
                                      name="chevron-right"
                                      size="small"
                                      class="settings-provider-console-item-chevron"
                                    />
                                  </button>
                                )}
                              </For>
                            </div>
                          </Show>
                        </div>
                      )}
                    </Show>
                  )
                }}
              </For>
            </Show>
          </SettingsList>
        </div>

        <div class="settings-section">
          <h3 class="settings-section-title">{language.t("settings.providers.section.popular")}</h3>
          <SettingsList variant="catalog">
            <For each={popular()}>
              {(item) => (
                <div class="settings-provider-row">
                  <div class="settings-provider-lead">
                    <Show
                      when={item.id === "opencode"}
                      fallback={
                        <ProviderIcon
                          id={item.id}
                          width={PROVIDER_ICON_SIZE}
                          height={PROVIDER_ICON_SIZE}
                          class="settings-provider-icon shrink-0"
                        />
                      }
                    >
                      <OpenCodeLogo class="settings-provider-icon size-4 shrink-0" />
                    </Show>
                    <div class="settings-provider-copy">
                      <div class="settings-provider-main">
                        <span class="settings-provider-name">{item.name}</span>
                        <Show when={item.id === "opencode" || item.id === "opencode-go"}>
                          <Badge>{language.t("dialog.provider.tag.recommended")}</Badge>
                        </Show>
                      </div>
                      <Show when={note(item.id)}>
                        {(key) => <p class="settings-provider-description">{language.t(key())}</p>}
                      </Show>
                    </div>
                  </div>
                  <Button size="normal" variant="neutral" icon="plus" onClick={() => connect(item.id)}>
                    {language.t("common.connect")}
                  </Button>
                </div>
              )}
            </For>
          </SettingsList>

          <button type="button" class="settings-providers-view-all" onClick={() => connect()}>
            {language.t("dialog.provider.viewAll")}
          </button>
        </div>
      </div>
    </>
  )
}
