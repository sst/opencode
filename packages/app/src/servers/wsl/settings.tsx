import { useDialog } from "@opencode/ui/context/dialog"
import { Badge } from "@opencode/ui/badge"
import { Button } from "@opencode/ui/button"
import { Icon } from "@opencode/ui/icon"
import { IconButton } from "@opencode/ui/icon-button"
import { Menu } from "@opencode/ui/menu"
import { useMutation } from "@tanstack/solid-query"
import fuzzysort from "fuzzysort"
import { type Accessor, For, Show, createMemo } from "solid-js"
import type { ServerCollectionController } from "@/servers/registry/controller"
import { ServerHealthIndicator } from "@/servers/registry/row"
import { useLanguage } from "@/runtime/i18n/language"
import { usePlatform } from "@/runtime/platform/platform"
import { ServerConnection } from "@/runtime/server/registry"
import { showToast } from "@/shell/notifications/toast"
import { DialogAddWslServer } from "./dialog"
import { useWslServers } from "./context"
import { wslOpencodeAction, wslRuntimeRetryable } from "./model"
import type { WslServerItem } from "./types"
import { DialogSsh } from "../ssh/dialog"

export function isWslServer(server: ServerConnection.Any) {
  return server.type === "sidecar" && server.variant === "wsl"
}

export function AddServerMenu(props: { onAddServer: () => void; compact?: boolean }) {
  const platform = usePlatform()
  const dialog = useDialog()
  const language = useLanguage()
  const openAddWsl = () => {
    void dialog.push(() => <DialogAddWslServer />)
  }
  return (
    <Show
      when={platform.wslServers || platform.sshServers}
      fallback={
        <Show
          when={props.compact}
          fallback={
            <Button variant="ghost-muted" icon="plus" onClick={props.onAddServer}>
              {language.t("dialog.server.add.button")}
            </Button>
          }
        >
          <IconButton
            variant="ghost-muted"
            size="small"
            icon={<Icon name="plus" />}
            aria-label={language.t("dialog.server.add.button")}
            onClick={props.onAddServer}
          />
        </Show>
      }
    >
      <Menu gutter={4} modal={false} placement="bottom-end">
        <Show
          when={props.compact}
          fallback={
            <Menu.Trigger as={Button} variant="ghost-muted" icon="plus">
              {language.t("dialog.server.add.button")}
            </Menu.Trigger>
          }
        >
          <Menu.Trigger
            as={IconButton}
            variant="ghost-muted"
            size="small"
            icon={<Icon name="plus" />}
            aria-label={language.t("dialog.server.add.button")}
          />
        </Show>
        <Menu.Portal>
          <Menu.Content>
            <Menu.Item onSelect={props.onAddServer}>{language.t("dialog.server.add.button")}</Menu.Item>
            <Show when={platform.sshServers}>
              <Menu.Item onSelect={() => void dialog.push(() => <DialogSsh />)}>{language.t("ssh.add")}</Menu.Item>
            </Show>
            <Show when={platform.wslServers}>
              <Menu.Item onSelect={openAddWsl}>{language.t("wsl.server.add")}</Menu.Item>
            </Show>
          </Menu.Content>
        </Menu.Portal>
      </Menu>
    </Show>
  )
}

export function useFilteredWslServers(filter: Accessor<string>) {
  const wsl = useWslServers()
  return createMemo(() => {
    const servers = wsl.data?.servers ?? []
    const query = filter().trim()
    if (!query) return servers
    return fuzzysort
      .go(query, servers, { keys: [(item) => item.config.distro, (item) => item.config.id] })
      .map((x) => x.obj)
  })
}

export function WslServerSettings(props: {
  domain: Pick<ServerCollectionController, "collection" | "defaults" | "connection">
  servers: Accessor<readonly WslServerItem[]>
}) {
  const platform = usePlatform()
  const language = useLanguage()
  const wsl = useWslServers()
  const api = platform.wslServers

  const request = useMutation(() => ({
    mutationFn: (action: () => Promise<unknown>) => action(),
    onError: (error) =>
      showToast({
        variant: "error",
        title: language.t("common.requestFailed"),
        description: error instanceof Error ? error.message : String(error),
      }),
  }))

  const remove = (key: ServerConnection.Key) => {
    request.mutate(() => props.domain.connection.remove(key))
  }

  return (
    <Show when={api}>
      <For each={props.servers()}>
        {(item) => {
          const key = ServerConnection.Key.make(item.config.id)
          const check = () => wsl.data?.opencodeChecks[item.config.distro]
          const opencodeAction = () => wslOpencodeAction(check())
          const busy = () => wsl.data?.job?.kind === "install-opencode" && wsl.data.job.distro === item.config.distro
          return (
            <div class="settings-servers-row">
              <div class="settings-servers-lead">
                <ServerHealthIndicator health={props.domain.collection.health()[key]} />
                <div class="settings-servers-copy">
                  <span class="flex min-w-0 items-center gap-1">
                    <span class="settings-servers-name">{item.config.distro}</span>
                    <span class="shrink-0 rounded-[3px] border border-v2-border-border-base px-1 py-0.5 text-[9px] leading-none text-v2-text-text-muted">
                      {language.t("wsl.server.label")}
                    </span>
                  </span>
                  <span class="settings-servers-meta">
                    <Show when={check()?.version}>{(version) => `v${version()}`}</Show>
                  </span>
                </div>
              </div>
              <div class="settings-servers-actions">
                <Show when={props.domain.defaults.available() && props.domain.defaults.key() === key}>
                  <Badge>{language.t("dialog.server.status.default")}</Badge>
                </Show>
                <Show when={opencodeAction()}>
                  {(label) => (
                    <Button
                      size="small"
                      disabled={busy() || request.isPending}
                      onClick={() => api && request.mutate(() => api.installOpencode(item.config.distro))}
                    >
                      {busy() ? language.t("wsl.server.updating") : language.t(label())}
                    </Button>
                  )}
                </Show>
                <Menu gutter={4} modal={false} placement="bottom-end">
                  <Menu.Trigger
                    as={IconButton}
                    variant="ghost-muted"
                    size="small"
                    icon={<Icon name="outline-dots" />}
                    aria-label={language.t("common.moreOptions")}
                  />
                  <Menu.Portal>
                    <Menu.Content>
                      <Menu.Group>
                        <Menu.GroupLabel>{language.t("wsl.server.menu.label")}</Menu.GroupLabel>
                        <Show when={wslRuntimeRetryable(item.runtime)}>
                          <Menu.Item onSelect={() => api && request.mutate(() => api.startServer(key))}>
                            {language.t("wsl.server.retryStart")}
                          </Menu.Item>
                        </Show>
                        <Show when={props.domain.defaults.available() && props.domain.defaults.key() !== key}>
                          <Menu.Item onSelect={() => props.domain.defaults.set(key)}>
                            {language.t("dialog.server.menu.default")}
                          </Menu.Item>
                        </Show>
                        <Show when={props.domain.defaults.available() && props.domain.defaults.key() === key}>
                          <Menu.Item onSelect={() => props.domain.defaults.set(null)}>
                            {language.t("dialog.server.menu.defaultRemove")}
                          </Menu.Item>
                        </Show>
                        <Menu.Separator />
                        <Menu.Item disabled={request.isPending} onSelect={() => remove(key)}>
                          {language.t("dialog.server.menu.remove")}
                        </Menu.Item>
                      </Menu.Group>
                    </Menu.Content>
                  </Menu.Portal>
                </Menu>
              </div>
            </div>
          )
        }}
      </For>
    </Show>
  )
}
