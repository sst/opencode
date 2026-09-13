import { For, Show } from "solid-js"
import { Button } from "@opencode/ui/button"
import { TextShimmer } from "@opencode/ui/text-shimmer"
import { useLanguage } from "@/runtime/i18n/language"

export function ConsoleAuthorization(props: {
  code: string
  browserFailed: boolean
  copied: boolean
  copyFailed: boolean
  onOpen: () => void
  onCopy: () => void
}) {
  const language = useLanguage()
  return (
    <div
      data-component="console-authorization"
      class="flex flex-col gap-5 text-[13px] leading-5 text-v2-text-text-muted"
    >
      <p>
        {language.t(
          props.browserFailed ? "provider.connect.console.browserFailed" : "provider.connect.console.instructions",
        )}
      </p>
      <div class="flex flex-col gap-2">
        <div class="font-medium text-v2-text-text-base">{language.t("provider.connect.console.deviceCode")}</div>
        <div
          dir="ltr"
          role="group"
          aria-label={`${language.t("provider.connect.console.deviceCode")}: ${props.code}`}
          class="flex max-w-full gap-1 self-start font-mono text-xl font-[530] text-v2-text-text-base tabular-nums"
        >
          <For each={props.code.split("")}>
            {(character) => (
              <span
                aria-hidden="true"
                class={
                  character === "-"
                    ? "mx-1 flex h-12 items-center text-v2-text-text-muted"
                    : "flex h-12 w-8 items-center justify-center rounded-md border border-v2-border-border-base bg-v2-background-bg-layer-02"
                }
              >
                {character}
              </span>
            )}
          </For>
        </div>
        <p role="status">
          <TextShimmer text={language.t("provider.connect.console.waiting")} active />
        </p>
      </div>
      <div data-component="console-browser-fallback" class="flex min-h-7 flex-wrap items-center gap-x-3 gap-y-1">
        <span class="text-v2-text-text-faint">{language.t("provider.connect.console.browserHint")}</span>
        <Button variant="ghost-muted" onClick={props.onCopy}>
          {language.t(props.copied ? "provider.connect.console.linkCopied" : "provider.connect.console.copyLink")}
        </Button>
        <Show when={props.browserFailed || props.copyFailed}>
          <Button variant="ghost" onClick={props.onOpen}>
            {language.t("provider.connect.console.openAgain")}
          </Button>
        </Show>
      </div>
      <Show when={props.copyFailed}>
        <p role="alert">{language.t("provider.connect.console.copyFailed")}</p>
      </Show>
    </div>
  )
}
