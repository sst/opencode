import { createEffect, createMemo, createSignal, on, onCleanup, Show } from "solid-js"
import type { SessionStatus } from "@opencode/client/promise"
import { useI18n } from "@opencode/ui/context/i18n"
import { Card } from "@opencode/ui/card"
import { Icon } from "@opencode/ui/icon"
import { TextShimmer } from "@opencode/ui/text-shimmer"
import { Tooltip } from "@opencode/ui/tooltip"
import { SessionErrorMessage } from "./session-error"

export function SessionRetry(props: { status: SessionStatus; show?: boolean }) {
  const i18n = useI18n()
  const retry = createMemo(() => {
    if (props.status.type !== "retry") return
    return props.status
  })
  const [seconds, setSeconds] = createSignal(0)
  createEffect(
    on(retry, (current) => {
      if (!current) return
      const update = () => {
        const next = retry()?.next
        if (!next) return
        setSeconds(Math.round((next - Date.now()) / 1000))
      }
      update()
      const timer = setInterval(update, 1000)
      onCleanup(() => clearInterval(timer))
    }),
  )
  const message = createMemo(() => {
    const current = retry()
    if (!current) return ""
    if (current.message.includes("exceeded your current quota") && current.message.includes("gemini")) {
      return i18n.t("ui.sessionTurn.retry.geminiHot")
    }
    if (current.message.length > 80) return current.message.slice(0, 80) + "…"
    return current.message
  })
  const info = createMemo(() => {
    const current = retry()
    if (!current) return ""
    const count = Math.max(0, seconds())
    const delay = count > 0 ? i18n.t("ui.sessionTurn.retry.inSeconds", { seconds: count }) : ""
    const retrying = i18n.t("ui.sessionTurn.retry.retrying")
    const line = [retrying, delay].filter(Boolean).join(" ")
    if (!line) return i18n.t("ui.sessionTurn.retry.attemptLabel", { attempt: current.attempt })
    return i18n.t("ui.sessionTurn.retry.attemptRetrying", { line, attempt: current.attempt })
  })

  return (
    <Show when={retry() && (props.show ?? true)}>
      <div data-slot="session-turn-retry" class="w-full min-w-0">
        <Card variant="error" class="error-card" data-kind="session-retry-card">
          <div class="flex w-full items-start gap-2">
            <Icon name="outline-hexagonal-warning" class="shrink-0 text-v2-state-fg-danger" />
            <div class="min-w-0 flex-1">
              <Tooltip appearance="standard" value={retry()?.message ?? ""} placement="top">
                <div data-slot="session-turn-retry-message" class="cursor-help truncate">
                  <SessionErrorMessage message={message()} />
                </div>
              </Tooltip>
              <Show when={info()}>
                {(line) => (
                  <div data-slot="session-turn-retry-info">
                    <TextShimmer text={line()} active />
                  </div>
                )}
              </Show>
            </div>
          </div>
        </Card>
      </div>
    </Show>
  )
}
