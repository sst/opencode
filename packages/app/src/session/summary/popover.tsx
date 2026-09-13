import { Popover } from "@kobalte/core/popover"
import { Icon } from "@opencode/ui/icon"
import { IconButton } from "@opencode/ui/icon-button"
import { Keybind } from "@opencode/ui/keybind"
import { Tooltip } from "@opencode/ui/tooltip"
import { Show, type ParentProps } from "solid-js"
import { useLanguage } from "@/runtime/i18n/language"
import { useCommand } from "@/shell/commands/command"
import "./summary.css"

export function SummaryPopover(
  props: ParentProps<{ active?: boolean; open: boolean; onOpenChange: (open: boolean) => void }>,
) {
  const language = useLanguage()
  const command = useCommand()
  // Cached timelines remain mounted; only the visible summary owns the command.
  command.register(() =>
    props.active === false
      ? []
      : [
          {
            id: "session.summary.toggle",
            title: language.t("command.session.summary.toggle"),
            category: language.t("command.category.view"),
            keybind: "mod+shift+y",
            onSelect: () => props.onOpenChange(!props.open),
          },
        ],
  )
  const keybind = () => command.keybindParts("session.summary.toggle")
  return (
    <Popover open={props.open} placement="bottom-end" gutter={8} overflowPadding={16} onOpenChange={props.onOpenChange}>
      {/* Match the button's vertical bounds; the 8px gutter plus 4px content padding gives a 12px card gap. */}
      <Popover.Anchor class="pointer-events-none absolute end-3 top-2.5 h-7 w-0" aria-hidden="true" />
      <Tooltip
        placement="bottom"
        value={
          <>
            {language.t("session.summary.tooltip")}
            <Show when={keybind().length > 0}>
              <Keybind keys={keybind()} variant="neutral" />
            </Show>
          </>
        }
      >
        <Popover.Trigger
          as={IconButton}
          icon={<Icon name="window-analytics" />}
          variant="ghost-muted"
          size="large"
          state={props.open ? "pressed" : undefined}
          aria-label={language.t("session.summary.title")}
          aria-expanded={props.open}
        />
      </Tooltip>
      <Popover.Portal>
        <Popover.Content
          class="session-summary-popover z-50 max-h-[calc(100dvh-96px)] overflow-y-auto border-0 bg-transparent p-1 outline-none"
          aria-label={language.t("session.summary.title")}
        >
          {props.children}
        </Popover.Content>
      </Popover.Portal>
    </Popover>
  )
}
