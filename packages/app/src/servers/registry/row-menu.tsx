import { Icon } from "@opencode/ui/icon"
import { IconButton } from "@opencode/ui/icon-button"
import { Menu } from "@opencode/ui/menu"
import { type Component, Show } from "solid-js"
import type { ServerActionsController } from "@/servers/registry/controller"
import { useLanguage } from "@/runtime/i18n/language"
import { ServerConnection } from "@/runtime/server/registry"
import { SshMenu } from "../ssh/menu"

export const ServerRowMenu: Component<{
  server: ServerConnection.Any
  domain: ServerActionsController
  onEdit: (server: ServerConnection.Http) => void
  open?: boolean
  onOpenChange?: (open: boolean) => void
}> = (props) => {
  const language = useLanguage()
  const key = ServerConnection.key(props.server)
  if (props.server.type === "ssh" && props.server.id) return <SshMenu id={props.server.id} domain={props.domain} />
  return (
    <ServerRowMenuView
      server={props.server}
      labels={serverMenuLabels(language)}
      canDefault={props.domain.defaults.available()}
      isDefault={props.domain.defaults.key() === key}
      canRemove={props.domain.connection.canRemove(key)}
      canHide={props.domain.connection.canHide(key)}
      hidden={props.domain.connection.isHidden(key)}
      onEdit={props.onEdit}
      onSetDefault={() => props.domain.defaults.set(key)}
      onRemoveDefault={() => props.domain.defaults.set(null)}
      onRemove={() => props.domain.connection.remove(key)}
      onHide={() => props.domain.connection.setHidden(key, true)}
      onShow={() => props.domain.connection.setHidden(key, false)}
      open={props.open}
      onOpenChange={props.onOpenChange}
    />
  )
}

export function serverMenuLabels(language: ReturnType<typeof useLanguage>) {
  return {
    more: language.t("common.moreOptions"),
    server: language.t("settings.section.server"),
    edit: language.t("dialog.server.menu.edit"),
    default: language.t("dialog.server.menu.default"),
    defaultRemove: language.t("dialog.server.menu.defaultRemove"),
    remove: language.t("dialog.server.menu.remove"),
    hide: language.t("dialog.server.menu.hide"),
    show: language.t("dialog.server.menu.show"),
  }
}

export const ServerRowMenuView: Component<{
  server: ServerConnection.Any
  labels: ReturnType<typeof serverMenuLabels>
  canDefault: boolean
  isDefault: boolean
  canRemove: boolean
  canHide?: boolean
  hidden?: boolean
  onEdit: (server: ServerConnection.Http) => void
  onSetDefault: () => void
  onRemoveDefault: () => void
  onRemove: () => void
  onHide?: () => void
  onShow?: () => void
  open?: boolean
  onOpenChange?: (open: boolean) => void
}> = (props) => {
  const builtin = () => ServerConnection.builtin(props.server)
  const httpServer = () => (props.server.type === "http" ? props.server : undefined)
  return (
    <Menu gutter={6} modal={false} placement="bottom-end" open={props.open} onOpenChange={props.onOpenChange}>
      <Menu.Trigger
        as={IconButton}
        variant="ghost-muted"
        size="small"
        icon={<Icon name="outline-dots" />}
        aria-label={props.labels.more}
      />
      <Menu.Portal>
        <Menu.Content>
          <Menu.Group>
            <Menu.GroupLabel>{props.labels.server}</Menu.GroupLabel>
            <Menu.Item
              disabled={builtin() || !httpServer()}
              onSelect={() => {
                const server = httpServer()
                if (server) props.onEdit(server)
              }}
            >
              {props.labels.edit}
            </Menu.Item>
            <Show when={props.canDefault && !props.isDefault}>
              <Menu.Item onSelect={props.onSetDefault}>{props.labels.default}</Menu.Item>
            </Show>
            <Show when={props.canDefault && props.isDefault}>
              <Menu.Item onSelect={props.onRemoveDefault}>{props.labels.defaultRemove}</Menu.Item>
            </Show>
            <Show when={props.hidden}>
              <Menu.Item onSelect={props.onShow}>{props.labels.show}</Menu.Item>
            </Show>
            <Show when={!props.hidden && props.canHide}>
              <Menu.Item onSelect={props.onHide}>{props.labels.hide}</Menu.Item>
            </Show>
            <Show when={props.canRemove}>
              <Menu.Separator />
              <Menu.Item onSelect={props.onRemove}>{props.labels.remove}</Menu.Item>
            </Show>
          </Menu.Group>
        </Menu.Content>
      </Menu.Portal>
    </Menu>
  )
}
