import { Badge } from "@opencode/ui/badge"
import { Select } from "@opencode/ui/select"
import { useDialog } from "@opencode/ui/context/dialog"
import { createMemo, Show, type Component } from "solid-js"
import { ServerRowMenu } from "@/servers/registry/row-menu"
import { ServerHealthIndicator } from "@/servers/registry/row"
import { useLanguage } from "@/runtime/i18n/language"
import { ServerConnection, serverName } from "@/runtime/server/registry"
import { useServerCollectionController } from "@/servers/registry/controller"
import { DialogServer } from "@/servers/connect/dialog"
import { AddServerMenu, WslServerSettings } from "@/servers/wsl/settings"
import { SshServerSettings } from "@/servers/ssh/settings"
import { SettingsList } from "@/settings/list"
import { SettingsRow } from "@/settings/row"
import { ShellSetting } from "@/settings/general/general"
import { createServerPreferencesController } from "@/settings/general/controllers"
import type { SettingsServer } from "./inventory"
import "@/settings/settings.css"

const WebSearchSetting: Component<{
  controller: ReturnType<typeof createServerPreferencesController>["websearch"]
}> = (props) => {
  const language = useLanguage()
  return (
    <SettingsRow
      title={language.t("settings.server.preferences.websearch.title")}
      description={language.t("settings.server.preferences.websearch.description")}
    >
      <Select
        data-action="settings-websearch"
        options={props.controller.options()}
        current={props.controller.current()}
        value={(option) => String(option.value)}
        label={(option) => option.label}
        placement="bottom-end"
        gutter={6}
        onSelect={(option) => option && props.controller.select(option.value)}
      />
    </SettingsRow>
  )
}

export const SettingsServerGeneral: Component<{
  entry: SettingsServer
  nested?: boolean
  onAddServer?: () => void
  onServerChange?: (server: ServerConnection.Any) => void
}> = (props) => {
  const dialog = useDialog()
  const language = useLanguage()
  const controller = useServerCollectionController()
  const health = createMemo(() => controller.collection.health()[props.entry.key])
  const edit = (server: ServerConnection.Http) =>
    void dialog.push(() => <DialogServer mode="edit" server={server} onSave={props.onServerChange} />)

  return (
    <>
      <div class="settings-tab-header">
        <div class="settings-tab-header-row">
          <div class="flex flex-col gap-1">
            <h2 class="settings-tab-title">
              {props.nested ? props.entry.name : language.t("settings.section.server")}
            </h2>
            <span class="text-11-regular text-v2-text-text-muted">
              {language.t(props.nested ? "settings.server.description" : "settings.servers.description")}
            </span>
          </div>
          <Show when={!props.nested && props.onAddServer}>
            <AddServerMenu onAddServer={() => props.onAddServer?.()} />
          </Show>
        </div>
      </div>

      <div class="settings-tab-body settings-tab-body--sectioned">
        <section class="settings-section settings-server-connection" data-component="settings-server-connection">
          <h3 class="settings-section-title">{language.t("settings.server.section.connection")}</h3>
          <SettingsList>
            <Show
              when={props.entry.ssh}
              fallback={
                <Show
                  when={props.entry.wsl}
                  fallback={
                    <Show when={props.entry.connection}>
                      {(server) => (
                        <div class="settings-servers-row">
                          <div class="settings-servers-lead">
                            <ServerHealthIndicator health={health()} />
                            <div class="settings-servers-copy">
                              <bdi class="settings-servers-name" dir="auto">
                                {serverName(server()) || props.entry.key}
                              </bdi>
                              <bdi class="settings-servers-meta" dir="ltr">
                                {server().http.url}
                              </bdi>
                            </div>
                          </div>
                          <div class="settings-servers-actions">
                            <Show
                              when={controller.defaults.available() && controller.defaults.key() === props.entry.key}
                            >
                              <Badge>{language.t("dialog.server.status.default")}</Badge>
                            </Show>
                            <ServerRowMenu server={server()} domain={controller} onEdit={edit} />
                          </div>
                        </div>
                      )}
                    </Show>
                  }
                >
                  {(item) => <WslServerSettings domain={controller} servers={() => [item()]} />}
                </Show>
              }
            >
              {(item) => <SshServerSettings filter="" id={item().config.id} domain={controller} />}
            </Show>
          </SettingsList>
        </section>

        <Show when={props.entry.connection} keyed>
          {(server) => <ServerPreferences server={server} />}
        </Show>
      </div>
    </>
  )
}

function ServerPreferences(props: { server: ServerConnection.Any }) {
  const language = useLanguage()
  const preferences = createServerPreferencesController(() => props.server)
  return (
    <section class="settings-section">
      <h3 class="settings-section-title">{language.t("settings.tab.preferences")}</h3>
      <SettingsList>
        <ShellSetting controller={preferences.shell} />
        <WebSearchSetting controller={preferences.websearch} />
      </SettingsList>
    </section>
  )
}
