import { For, Show } from "solid-js"
import { useLanguage } from "@/runtime/i18n/language"
import type { ServerCollectionController } from "@/servers/registry/controller"
import { ServerHealthIndicator } from "@/servers/registry/row"
import { ServerConnection } from "@/runtime/server/registry"
import { useSsh } from "./context"
import { SshMenu } from "./menu"
import { Badge } from "@opencode/ui/badge"
import { Button } from "@opencode/ui/button"
import { Spinner } from "@opencode/ui/spinner"
import { sshName } from "./name"
import { isSshConnecting } from "./status"

export function SshServerSettings(props: { filter: string; id?: string; domain: ServerCollectionController }) {
  const ssh = useSsh()
  const language = useLanguage()
  return (
    <For
      each={ssh.servers.filter(
        (item) =>
          item.saved &&
          (!props.id || item.config.id === props.id) &&
          `${item.config.name} ${item.config.target}`.toLowerCase().includes(props.filter.toLowerCase()),
      )}
    >
      {(item) => {
        const key = ServerConnection.Key.make(`ssh:${item.config.id}`)
        const health = () => props.domain.collection.health()[key]
        const indicator = () => {
          if (item.stage === "ready") return health() ?? { healthy: true }
          if (item.stage === "incompatible") return { healthy: false, incompatible: true }
          if (item.stage === "failed") return { healthy: false }
          return undefined
        }
        return (
          <div class="settings-servers-row">
            <div class="settings-servers-lead">
              <ServerHealthIndicator
                health={indicator()}
                connecting={isSshConnecting(item.stage)}
                authenticationRequired={item.stage === "authentication"}
              />
              <div class="settings-servers-copy">
                <span class="flex min-w-0 items-center gap-1">
                  <bdi class="settings-servers-name truncate" dir={item.config.name ? "auto" : "ltr"}>
                    {sshName(item.config)}
                  </bdi>
                  <span class="shrink-0 rounded-[3px] border border-v2-border-border-base px-1 py-0.5 text-[9px] leading-none text-v2-text-text-muted">
                    {language.t("ssh.label")}
                  </span>
                </span>
                <Show
                  when={item.stage === "authentication"}
                  fallback={
                    <Show when={health()?.version}>
                      {(version) => <span class="settings-servers-meta">v{version()}</span>}
                    </Show>
                  }
                >
                  <span class="settings-servers-meta">{language.t("ssh.stage.authentication")}</span>
                </Show>
              </div>
            </div>
            <div class="settings-servers-actions">
              <Show when={item.stage === "authentication" || ssh.pending(item.config.id)}>
                <Button
                  size="small"
                  variant="ghost-muted"
                  disabled={ssh.pending(item.config.id)}
                  aria-busy={ssh.pending(item.config.id)}
                  onClick={() => ssh.connect(item.config)}
                >
                  <Show when={ssh.pending(item.config.id)}>
                    <Spinner class="size-3.5" />
                  </Show>
                  {language.t(ssh.pending(item.config.id) ? "ssh.session.connecting" : "ssh.action.authenticate")}
                </Button>
              </Show>
              <Show when={props.domain.defaults.available() && props.domain.defaults.key() === key}>
                <Badge>{language.t("dialog.server.status.default")}</Badge>
              </Show>
              <SshMenu id={item.config.id} domain={props.domain} />
            </div>
          </div>
        )
      }}
    </For>
  )
}
