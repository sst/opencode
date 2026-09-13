import { Popover } from "@kobalte/core/popover"
import { useData } from "@opencode/session-ui/context"
import { Icon } from "@opencode/ui/icon"
import { TextShimmer } from "@opencode/ui/text-shimmer"
import { createEffect, For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { Dynamic } from "solid-js/web"
import { useLanguage } from "@/runtime/i18n/language"

export type BackgroundTask = {
  id: string
  type: "shell" | "subagent"
  label: string
  agent?: string
}

export function BackgroundWorkSummary(props: { tasks: BackgroundTask[]; mobile?: boolean }) {
  const language = useLanguage()
  const data = useData()
  const [store, setStore] = createStore({ open: false })
  createEffect(() => {
    if (props.tasks.length > 0) return
    setStore("open", false)
  })
  const taskType = (task: BackgroundTask) => {
    if (task.type === "shell") return language.t("ui.tool.shell")
    if (!task.agent) return language.t("ui.tool.agent.default")
    return task.agent.slice(0, 1).toUpperCase() + task.agent.slice(1)
  }

  return (
    <Popover
      open={store.open}
      placement={props.mobile ? "top-end" : language.direction() === "rtl" ? "right-end" : "left-end"}
      gutter={4}
      onOpenChange={(open) => setStore("open", open)}
    >
      <Show when={props.tasks.length > 0}>
        <Popover.Trigger
          as="button"
          type="button"
          data-component="session-background-summary"
          class="session-summary-row"
          aria-label={language.plural("session.background.tasksRunning", props.tasks.length)}
        >
          <Icon name="outline-arrow-to-corner-top-right" class="shrink-0 text-v2-icon-icon-muted" />
          <TextShimmer
            as="span"
            text={language.plural("session.background.tasksRunning", props.tasks.length)}
            active
            class="session-summary-label"
          />
        </Popover.Trigger>
      </Show>
      <Popover.Portal>
        <Popover.Content
          data-component="session-background-list"
          class="session-service-menu"
          aria-label={language.plural("session.background.tasksRunning", props.tasks.length)}
        >
          <For each={props.tasks.slice(0, 10)}>
            {(task) => (
              <Dynamic
                component={task.type === "subagent" ? "a" : "div"}
                data-component="session-background-list-item"
                class="session-service-row"
                classList={{
                  "hover:bg-v2-overlay-simple-overlay-hover focus-visible:bg-v2-overlay-simple-overlay-hover focus-visible:outline-none":
                    task.type === "subagent",
                }}
                href={task.type === "subagent" ? data.sessionHref?.(task.id) : undefined}
                onClick={(event: MouseEvent) => {
                  if (task.type !== "subagent" || !data.navigateToSession) return
                  if (event.button !== 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
                  event.preventDefault()
                  setStore("open", false)
                  data.navigateToSession(task.id)
                }}
              >
                <span class="shrink-0">{taskType(task)}</span>
                <span class="session-summary-label text-v2-text-text-faint">{task.label}</span>
              </Dynamic>
            )}
          </For>
        </Popover.Content>
      </Popover.Portal>
    </Popover>
  )
}
