import { Popover } from "@kobalte/core/popover"
import { Icon } from "@opencode/ui/icon"
import { Switch } from "@opencode/ui/switch"
import { Tooltip } from "@opencode/ui/tooltip"
import { getDirectory } from "@opencode/util/path"
import {
  createEffect,
  createMemo,
  createResource,
  createUniqueId,
  For,
  Index,
  on,
  onCleanup,
  Show,
  type JSX,
} from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/runtime/i18n/language"
import { usePlatform } from "@/runtime/platform/platform"
import { useData, useServer } from "@/runtime/server/current"
import { useServerSDK } from "@/runtime/server/client"
import { ServerConnection, serverName } from "@/runtime/server/registry"
import { useGlobal } from "@/runtime/server/runtime"
import { useSettings } from "@/settings/model"
import { showToast } from "@/shell/notifications/toast"
import { pluginLabel } from "@/providers/catalog/plugin"
import { useMcpToggle, type McpControls } from "@/providers/connect/mcp"
import { configuredLsps } from "./configured-lsp"

const services = [
  { type: "mcp", icon: "mcp", label: "session.summary.mcp" },
  { type: "plugins", icon: "cube", label: "session.summary.plugins" },
  { type: "skills", icon: "graduation-cap", label: "session.summary.skills" },
  { type: "lsp", icon: "code-slash", label: "session.summary.lsp" },
] as const

type Service = (typeof services)[number]["type"]

type ServiceMenuProps = {
  service: (typeof services)[number]
  directory: string
  shown: boolean
  open: boolean
  mobile?: boolean
  mcp?: McpControls
  onOpenChange: (open: boolean) => void
}

export function SessionServerPanel(props: { directory: string; shown: boolean; mobile?: boolean; mcp?: McpControls }) {
  const language = useLanguage()
  const server = useServer()
  const global = useGlobal()
  const settings = useSettings()
  const contentID = createUniqueId()
  const expanded = settings.sessionSummary.serverExpanded
  const name = createMemo(() => {
    const servers = global.servers.list()
    if (servers.length < 2) return language.t("session.summary.server")
    return serverName(servers.find((connection) => ServerConnection.key(connection) === server.key) ?? server.conn)
  })
  const [store, setStore] = createStore<{ submenu?: Service }>({})
  createEffect(on([() => props.directory, () => props.shown, expanded], () => setStore("submenu", undefined)))

  return (
    <section class="session-summary-card" data-section="server">
      <button
        type="button"
        class="session-summary-row session-summary-heading"
        aria-expanded={expanded()}
        aria-controls={contentID}
        onClick={() => settings.sessionSummary.setServerExpanded(!expanded())}
      >
        <Icon name="server" class="shrink-0 text-v2-icon-icon-muted" />
        <span dir="auto" class="session-summary-label">
          {name()}
        </span>
        <Icon name="chevron-down" size="small" class="session-summary-disclosure" />
      </button>
      <Show when={expanded() ? props.directory : undefined} keyed>
        {(directory) => (
          <div id={contentID} class="session-summary-rows">
            <For each={services}>
              {(service) => (
                <ServiceMenu
                  service={service}
                  directory={directory}
                  shown={props.shown}
                  open={store.submenu === service.type}
                  mobile={props.mobile}
                  mcp={props.mcp}
                  onOpenChange={(open) => setStore("submenu", open ? service.type : undefined)}
                />
              )}
            </For>
          </div>
        )}
      </Show>
    </section>
  )
}

function ServiceMenu(props: ServiceMenuProps) {
  if (props.service.type === "mcp") return <McpMenu {...props} />
  if (props.service.type === "lsp") return <LspMenu {...props} />
  return <ServiceCatalog {...props} />
}

function LspMenu(props: ServiceMenuProps) {
  const data = useData()
  const sdk = useServerSDK()
  const language = useLanguage()
  const [load, { refetch }] = createResource(
    () => props.shown && props.directory,
    (directory) => {
      data.location.config.invalidate({ directory })
      return data.location.config.sync({ directory })
    },
  )
  const names = createMemo(() => configuredLsps(data.location.config.list({ directory: props.directory }) ?? []))
  createEffect(() => {
    onCleanup(sdk.event.location(props.directory).on("config.updated", () => void refetch()))
  })
  return (
    <ServicePopover
      {...props}
      loading={load.loading}
      ready={data.location.config.list({ directory: props.directory }) !== undefined}
      empty={names().length === 0}
      error={load.error}
      retry={refetch}
    >
      <Show
        when={names().length}
        fallback={
          <ServiceEmpty title={language.t("session.summary.lsp.empty")} directory={props.directory} service="lsp" />
        }
      >
        <h3 class="session-service-title">{language.t("session.summary.lsp.configured")}</h3>
        <For each={names()}>
          {(name) => (
            <div class="session-service-row">
              <span dir="auto" class="session-summary-label">
                {name}
              </span>
            </div>
          )}
        </For>
        <div class="session-service-footer">
          <ServiceConfigLink directory={props.directory} service="lsp" />
        </div>
      </Show>
    </ServicePopover>
  )
}

function McpMenu(props: ServiceMenuProps) {
  const data = useData()
  const language = useLanguage()
  const toggle = useMcpToggle(() => props.directory)
  const [load, { refetch }] = createResource(
    () => props.shown && ([props.directory, props.mcp?.preview] as const),
    async ([directory, preview]) => {
      data.location.mcp.server.invalidate({ directory })
      await Promise.all([
        data.location.mcp.server.sync({ directory }),
        ...(preview ? [data.location.config.sync({ directory })] : []),
      ])
    },
  )
  const servers = createMemo(() =>
    (data.location.mcp.server.list({ directory: props.directory }) ?? []).toSorted((a, b) =>
      a.name.localeCompare(b.name),
    ),
  )
  const defaults = createMemo(() =>
    Object.fromEntries(
      (data.location.config.list({ directory: props.directory }) ?? []).flatMap((entry) =>
        entry.type === "document"
          ? Object.entries(entry.info.mcp?.servers ?? {}).map(([name, config]) => [name, !config.disabled] as const)
          : [],
      ),
    ),
  )

  return (
    <ServicePopover
      {...props}
      loading={load.loading}
      ready={
        data.location.mcp.server.list({ directory: props.directory }) !== undefined &&
        (!props.mcp?.preview || data.location.config.list({ directory: props.directory }) !== undefined)
      }
      empty={servers().length === 0}
      error={load.error}
      retry={refetch}
    >
      <Show
        when={servers().length}
        fallback={
          <ServiceEmpty title={language.t("session.summary.mcp.empty")} directory={props.directory} service="mcp" />
        }
      >
        <h3 class="session-service-title">{language.t("session.summary.mcp.title")}</h3>
        <Show when={props.mcp?.preview}>
          <div class="session-service-message" data-slot="mcp-preview-hint">
            {language.t("session.summary.mcp.onCreation")}
          </div>
        </Show>
        <Index each={servers()}>
          {(server) => {
            const preview = () => props.mcp?.preview === true
            const enabled = () =>
              preview()
                ? (props.mcp?.states[server().name] ?? defaults()[server().name] ?? true)
                : server().status.status !== "disabled"
            const pending = () =>
              (props.mcp?.pending ?? toggle.isPending) || (!preview() && server().status.status === "pending")
            const error = () => {
              const status = server().status
              return status.status === "failed" ? status.error : undefined
            }
            const label = () => {
              if (preview()) return undefined
              const status = server().status.status
              if (status === "failed") return language.t("session.summary.failed")
              if (status === "pending") return language.t("session.summary.connecting")
              if (status === "needs_auth") return language.t("session.summary.needsAuth")
              return undefined
            }
            const change = (value: boolean) => {
              if (pending()) return
              if (props.mcp) return props.mcp.change(server().name, value)
              toggle.mutate({ name: server().name, enabled: value })
            }
            return (
              <Switch
                class="session-mcp-row [&_[data-slot=switch-description]]:sr-only"
                description={preview() ? language.t("session.summary.mcp.onCreation") : label()}
                checked={enabled()}
                readOnly={pending()}
                aria-disabled={pending()}
                aria-busy={props.mcp?.pending ?? toggle.isPending}
                onChange={change}
                onClick={(event: MouseEvent) => {
                  if (event.target === event.currentTarget) change(!enabled())
                }}
                title={preview() ? server().name : (error() ?? server().name)}
              >
                <span
                  class="session-service-dot"
                  data-status={preview() ? undefined : server().status.status}
                  aria-hidden="true"
                />
                <span dir="auto" class="session-summary-label">
                  {server().name}
                </span>
                <Show when={label()}>
                  {(status) => (
                    <span class="session-service-status" aria-hidden="true">
                      {status()}
                    </span>
                  )}
                </Show>
              </Switch>
            )
          }}
        </Index>
        <div class="session-service-footer">
          <ServiceConfigLink directory={props.directory} service="mcp" />
        </div>
      </Show>
    </ServicePopover>
  )
}

function ServiceCatalog(props: ServiceMenuProps) {
  const data = useData()
  const sdk = useServerSDK()
  const language = useLanguage()
  const [items, { refetch }] = createResource(
    () => props.shown && props.directory,
    async (directory) => {
      if (props.service.type === "plugins") {
        const result = await sdk.api.plugin.list({ location: { directory } })
        return result.data
          .filter((plugin) => plugin.source.type !== "builtin")
          .map((plugin) => ({
            name: pluginLabel(plugin),
            status: plugin.state.status,
            error: plugin.state.status === "failed" ? plugin.state.error : undefined,
          }))
      }
      data.location.skill.invalidate({ directory })
      await data.location.skill.sync({ directory })
      return undefined
    },
  )
  const loaded = () => items.state === "ready" || items.state === "refreshing"
  const list = createMemo(() => {
    const entries =
      props.service.type === "plugins"
        ? loaded()
          ? (items.latest ?? [])
          : []
        : (data.location.skill.list({ directory: props.directory }) ?? []).map((skill) => ({
            name: skill.name,
            status: "active",
            error: undefined,
          }))
    return entries.toSorted((a, b) => a.name.localeCompare(b.name))
  })
  createEffect(() => {
    onCleanup(
      sdk.event
        .location(props.directory)
        .on(props.service.type === "plugins" ? "plugin.updated" : "skill.updated", () => void refetch()),
    )
  })
  return (
    <ServicePopover
      {...props}
      loading={items.loading}
      ready={
        props.service.type === "plugins"
          ? loaded()
          : data.location.skill.list({ directory: props.directory }) !== undefined
      }
      empty={list().length === 0}
      error={items.error}
      retry={refetch}
    >
      <Show
        when={list().length}
        fallback={
          <ServiceEmpty
            title={language.t(
              props.service.type === "plugins" ? "session.summary.plugins.empty" : "session.summary.skills.empty",
            )}
            directory={props.directory}
            service={props.service.type}
          />
        }
      >
        <h3 class="session-service-title">
          {language.t(
            props.service.type === "plugins"
              ? "session.summary.plugins.configured"
              : "session.summary.skills.configured",
          )}
        </h3>
        <For each={list()}>
          {(item) => (
            <div class="session-service-row" title={item.error ?? item.name}>
              <span class="session-service-dot" data-status={item.status} aria-hidden="true" />
              <span dir="auto" class="session-summary-label">
                {item.name}
              </span>
              <Show when={item.status === "failed"}>
                <span class="session-service-status">{language.t("session.summary.failed")}</span>
              </Show>
            </div>
          )}
        </For>
        <div class="session-service-footer">
          <ServiceConfigLink directory={props.directory} service={props.service.type} />
        </div>
      </Show>
    </ServicePopover>
  )
}

function ServicePopover(
  props: ServiceMenuProps & {
    loading: boolean
    ready: boolean
    empty: boolean
    error: unknown
    retry: () => unknown
    children: JSX.Element
  },
) {
  const language = useLanguage()
  const placement = createMemo(() =>
    props.mobile ? "top-end" : language.direction() === "rtl" ? "right-start" : "left-start",
  )
  return (
    <Popover
      open={props.open}
      onOpenChange={(open) => {
        props.onOpenChange(open)
        if (open && !props.loading) void props.retry()
      }}
      placement={placement()}
      gutter={4}
      overflowPadding={16}
      modal={false}
    >
      <Popover.Trigger as="button" type="button" class="session-summary-row">
        <Icon name={props.service.icon} class="shrink-0 text-v2-icon-icon-muted" />
        <span class="session-summary-label">{language.t(props.service.label)}</span>
        <Icon name="fill-triangle-down" class="session-summary-menu-indicator shrink-0 text-v2-icon-icon-muted" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          class="session-service-menu"
          data-service={props.service.type}
          data-empty={(props.ready && !props.error && props.empty) || undefined}
          aria-busy={props.loading}
          aria-label={language.t(props.service.label)}
        >
          <Show
            when={props.ready || !props.loading}
            fallback={
              <div class="session-service-message" role="status">
                {language.t("common.loading")}
              </div>
            }
          >
            <Show
              when={!props.error}
              fallback={
                <div class="session-service-message" role="alert">
                  <p>{language.t("common.requestFailed")}</p>
                  <button type="button" class="session-summary-row" onClick={() => props.retry()}>
                    {language.t("session.summary.retry")}
                  </button>
                </div>
              }
            >
              {props.children}
            </Show>
          </Show>
        </Popover.Content>
      </Popover.Portal>
    </Popover>
  )
}

function ServiceConfigLink(props: { directory: string; service: Service }) {
  const language = useLanguage()
  const platform = usePlatform()
  const server = useServer()
  const sdk = useServerSDK()
  const [store, setStore] = createStore({ opening: false, copied: false })
  const label = () => language.t(server.isLocal ? "session.summary.configure" : "session.summary.copyConfigPath")
  createEffect(() => {
    if (!store.copied) return
    const timeout = setTimeout(() => setStore("copied", false), 2000)
    onCleanup(() => clearTimeout(timeout))
  })
  const activate = async () => {
    const revealPath = platform.revealPath
    if (store.opening || (server.isLocal && !revealPath)) return
    setStore({ opening: true, copied: false })
    const directory = props.directory
    await sdk.api.config
      .get({ location: { directory } })
      .then(async (entries) => {
        const documents = entries
          .filter((entry) => entry.type === "document")
          .filter((entry) => entry.path !== undefined && /\.jsonc?$/.test(entry.path))
        const path =
          documents.findLast((entry) => entry.info[props.service] !== undefined)?.path ?? documents.at(-1)?.path
        if (!server.isLocal) {
          if (!path) throw new Error(language.t("session.summary.configFileMissing"))
          await (platform.writeClipboardText?.(path) ?? navigator.clipboard.writeText(path))
          setStore("copied", true)
          return
        }
        if (path && (await revealPath?.(path))) return
        await platform.openPath?.(path ? getDirectory(path) : directory)
      })
      .catch((error: unknown) =>
        showToast({
          variant: "error",
          title: language.t("common.requestFailed"),
          description: error instanceof Error ? error.message : String(error),
        }),
      )
      .finally(() => setStore("opening", false))
  }
  return (
    <>
      <span class="session-service-config-separator" role="separator" />
      <Show
        when={!server.isLocal || platform.revealPath}
        fallback={
          <span class="session-service-row">
            <Icon name="settings-gear" class="shrink-0 text-v2-icon-icon-muted" />
            {label()}
          </span>
        }
      >
        <Tooltip
          inactive={server.isLocal}
          value={language.t(store.copied ? "ui.message.copied" : "ui.message.copy")}
          placement="top"
          getAnchorRect={(anchor) => anchor?.querySelector("svg")?.getBoundingClientRect()}
          forceOpen={store.copied ? true : undefined}
          class="w-full"
        >
          <button
            type="button"
            class="session-service-config"
            disabled={store.opening}
            onMouseDown={(event) => {
              if (!server.isLocal) event.preventDefault()
            }}
            onClick={() => void activate()}
          >
            <Icon
              name={server.isLocal ? "settings-gear" : store.copied ? "check" : "outline-copy"}
              class="shrink-0 text-v2-icon-icon-muted"
            />
            <span class="session-summary-label">{label()}</span>
            <Show when={server.isLocal}>
              <Icon name="arrow-up-right" class="session-service-config-arrow shrink-0" />
            </Show>
          </button>
        </Tooltip>
      </Show>
    </>
  )
}

function ServiceEmpty(props: { title: string; directory: string; service: Service }) {
  return (
    <div class="session-service-empty">
      <strong>{props.title}</strong>
      <div class="session-service-footer">
        <ServiceConfigLink directory={props.directory} service={props.service} />
      </div>
    </div>
  )
}
