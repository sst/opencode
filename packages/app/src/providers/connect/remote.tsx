import { Show } from "solid-js"
import { useLanguage } from "@/runtime/i18n/language"
import { ServerConnection, serverName } from "@/runtime/server/registry"

export function authServerName(server: ServerConnection.Any) {
  if (ServerConnection.builtin(server)) return undefined
  if (server.type === "http" && ["localhost", "127.0.0.1", "[::1]"].includes(new URL(server.http.url).hostname))
    return undefined
  if (server.type === "sidecar" && server.variant === "wsl") return server.displayName ?? server.distro
  return serverName(server)
}

export function RemoteAuthNotice(props: { server: ServerConnection.Any }) {
  const language = useLanguage()
  return (
    <Show when={authServerName(props.server)}>
      {(name) => (
        <div
          class="rounded-md border border-v2-border-border-base bg-v2-background-bg-layer-02 p-3 text-[13px] leading-5"
          role="note"
        >
          <p class="font-medium text-v2-text-text-base">
            {language.t("provider.connect.remote.title", { server: name() })}
          </p>
          <p class="text-v2-text-text-muted">{language.t("provider.connect.remote.description")}</p>
        </div>
      )}
    </Show>
  )
}
