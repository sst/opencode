import { createMemo, Show } from "solid-js"
import { Button } from "@opencode/ui/button"
import { DockShell, DockTray } from "@opencode/ui/dock-surface"
import { Select } from "@opencode/ui/select"
import { useLanguage } from "@/runtime/i18n/language"
import { SettingsRow } from "@/settings/row"
import type { WebSearchRequestModel } from "./websearch"
import "./session-websearch-dock.css"

export function SessionWebSearchDock(props: { model: WebSearchRequestModel; onSubmit: () => void }) {
  const language = useLanguage()
  const options = createMemo(() => [
    ...(props.model.specific() ? [] : [{ value: "random", label: language.t("session.websearch.any") }]),
    ...props.model.options(),
  ])
  const current = createMemo(() => options().find((option) => option.value === props.model.selected()))
  const busy = () => props.model.sending() || !props.model.connected()
  const status = () => {
    if (props.model.loading()) return language.t("common.loading")
    if (props.model.failed()) return language.t("session.websearch.failed")
    if (!props.model.options().length) return language.t("session.websearch.empty")
  }
  const unavailable = () => props.model.loading() || props.model.loadFailed() || !props.model.options().length
  const submit = (selection: string | false) => {
    if (busy()) return
    props.onSubmit()
    void props.model.submit(selection)
  }

  return (
    <section
      data-component="session-websearch-dock"
      aria-label={language.t("session.websearch.title")}
      aria-busy={props.model.sending()}
    >
      <DockShell class="websearch-body">
        <div class="websearch-setting">
          <SettingsRow
            title={language.t("session.websearch.title")}
            description={language.t("session.websearch.description")}
          >
            <Select
              aria-label={language.t("session.websearch.provider")}
              options={options()}
              current={current()}
              value={(option) => option.value}
              label={(option) => option.label}
              onSelect={(option) => option && props.model.select(option.value)}
              disabled={busy() || unavailable()}
              placeholder={language.t("session.websearch.provider")}
              contentClass="websearch-provider-menu"
            />
          </SettingsRow>
        </div>
      </DockShell>
      <DockTray attach="top" class="websearch-footer">
        <div class="websearch-status" aria-live="polite">
          <Show when={props.model.loadFailed()} fallback={status()}>
            <span>{language.t("session.websearch.loadFailed")}</span>
            <Button variant="ghost" size="small" onClick={props.model.retry} disabled={busy()}>
              {language.t("session.websearch.retry")}
            </Button>
          </Show>
        </div>
        <div class="websearch-actions">
          <Show when={!props.model.specific()}>
            <Button variant="ghost" size="small" onClick={() => submit(false)} disabled={busy()}>
              {language.t("session.websearch.disable")}
            </Button>
          </Show>
          <Button
            variant="submit"
            size="small"
            onClick={() => {
              const selected = props.model.selected()
              if (selected) submit(selected)
            }}
            disabled={busy() || unavailable() || !current()}
          >
            {language.t("session.websearch.enable")}
          </Button>
        </div>
      </DockTray>
    </section>
  )
}
