import { For, Show } from "solid-js"
import type { PermissionRequest } from "@opencode/client/promise"
import { Button } from "@opencode/ui/button"
import { DockPrompt } from "@opencode/session-ui/dock-prompt"
import { Icon } from "@opencode/ui/icon"
import { useLanguage } from "@/runtime/i18n/language"

export function SessionPermissionDock(props: {
  request: PermissionRequest
  responding: boolean
  onDecide: (response: "once" | "always" | "reject") => void
}) {
  const language = useLanguage()

  const toolDescription = () => {
    const key = `settings.permissions.tool.${props.request.action}.description`
    const value = language.t(key as Parameters<typeof language.t>[0])
    if (value === key) return ""
    return value
  }

  return (
    <DockPrompt
      kind="permission"
      header={
        <div data-slot="permission-row" data-variant="header">
          <span data-slot="permission-icon">
            <Icon name="warning" size="normal" />
          </span>
          <div data-slot="permission-header-title">{language.t("notification.permission.title")}</div>
        </div>
      }
      footer={
        <>
          <div />
          <div data-slot="permission-footer-actions">
            <Button variant="ghost" size="normal" onClick={() => props.onDecide("reject")} disabled={props.responding}>
              {language.t("ui.permission.deny")}
            </Button>
            <Button
              variant="neutral"
              size="normal"
              onClick={() => props.onDecide("always")}
              disabled={props.responding}
            >
              {language.t("ui.permission.allowAlways")}
            </Button>
            <Button variant="submit" size="normal" onClick={() => props.onDecide("once")} disabled={props.responding}>
              {language.t("ui.permission.allowOnce")}
            </Button>
          </div>
        </>
      }
    >
      <Show when={toolDescription()}>
        <div data-slot="permission-row">
          <span data-slot="permission-spacer" aria-hidden="true" />
          <div data-slot="permission-hint">{toolDescription()}</div>
        </div>
      </Show>

      <Show when={props.request.resources.length > 0}>
        <div data-slot="permission-row">
          <span data-slot="permission-spacer" aria-hidden="true" />
          <div data-slot="permission-patterns">
            <For each={props.request.resources}>
              {(pattern) => <code class="text-12-regular text-text-base break-all">{pattern}</code>}
            </For>
          </div>
        </div>
      </Show>
    </DockPrompt>
  )
}
