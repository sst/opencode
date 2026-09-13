import { Button } from "@opencode/ui/button"
import { useDialog } from "@opencode/ui/context/dialog"
import { useLanguage } from "@/runtime/i18n/language"
import { useServerSDK } from "@/runtime/server/client"
import type { ModelSelection } from "@/providers/models/selection"
import { RemoteAuthNotice } from "./remote"
import { Show } from "solid-js"

export function ProviderSetup(props: {
  visible: boolean
  directory: string
  selection: ModelSelection
  onDone: () => void
}) {
  const language = useLanguage()
  const dialog = useDialog()
  const sdk = useServerSDK()
  const open = async (console: boolean) => {
    const { DialogConnectProvider } = await import("./dialog")
    void dialog.show(() => (
      <DialogConnectProvider
        directory={props.directory}
        provider={console ? "opencode" : undefined}
        initialMethod={console ? "device" : undefined}
        selection={props.selection}
        onDone={props.onDone}
      />
    ))
  }
  return (
    <Show when={props.visible}>
      <section
        data-component="provider-setup"
        class="flex flex-col gap-4 rounded-lg border border-v2-border-border-base bg-v2-background-bg-layer-01 p-5 text-[13px] leading-5"
      >
        <div class="flex flex-col gap-1">
          <h2 class="text-[15px] font-medium text-v2-text-text-base">{language.t("provider.setup.title")}</h2>
          <p class="text-v2-text-text-muted">{language.t("provider.connect.console.intro")}</p>
        </div>
        <RemoteAuthNotice server={sdk.server} />
        <div class="flex flex-wrap gap-2">
          <Button variant="contrast" onClick={() => void open(true)}>
            {language.t("provider.connect.console.continue")}
          </Button>
          <Button onClick={() => void open(false)}>{language.t("provider.setup.other")}</Button>
        </div>
        <p class="text-v2-text-text-muted">{language.t("provider.setup.settings")}</p>
      </section>
    </Show>
  )
}
