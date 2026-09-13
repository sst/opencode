import { Button } from "@opencode/ui/button"
import { Icon } from "@opencode/ui/icon"
import { Spinner } from "@opencode/ui/spinner"
import { Show } from "solid-js"
import { useLanguage } from "@/runtime/i18n/language"
import { sshName } from "./name"
import { isSshConnecting } from "./status"
import type { SshItem } from "./types"

export function SshConnectionPanel(props: { item: SshItem; pending?: boolean; onReconnect: () => void }) {
  const language = useLanguage()
  const connecting = () => props.pending || isSshConnecting(props.item.stage)
  return (
    <section
      data-component="ssh-connection-panel"
      class="flex h-full min-h-0 flex-col items-center justify-center gap-4 overflow-y-auto bg-v2-background-bg-base px-6 py-8 text-center"
    >
      <Icon name="lock" size="large" class="text-v2-icon-icon-muted" />
      <div class="flex max-w-sm flex-col items-center gap-2" role="status" aria-live="polite">
        <h2 class="text-16-medium text-v2-text-text-base">{language.t("ssh.session.disconnected")}</h2>
        <bdi dir="auto" class="max-w-full break-all text-13-regular text-v2-text-text-muted">
          {sshName(props.item.config)}
        </bdi>
        <p class="text-13-regular text-v2-text-text-muted">{language.t("ssh.session.reconnectDescription")}</p>
      </div>
      <Show when={props.item.error}>
        {(error) => (
          <p role="alert" class="max-w-sm text-13-regular text-v2-text-text-muted">
            {language.t(`ssh.error.${error()}`)}
          </p>
        )}
      </Show>
      <Button variant="neutral" disabled={connecting()} aria-busy={connecting()} onClick={props.onReconnect}>
        <Show when={connecting()}>
          <Spinner class="size-3.5" />
        </Show>
        {language.t(
          connecting()
            ? "ssh.session.connecting"
            : props.item.stage === "authentication"
              ? "ssh.action.authenticate"
              : "ssh.session.reconnect",
        )}
      </Button>
    </section>
  )
}
