import { type ComponentProps, type JSX, Show, splitProps } from "solid-js"
import { Icon } from "@opencode/ui/icon"
import { useI18n } from "../../context/i18n"
import "./text-input.css"

export interface TextInputProps extends Omit<ComponentProps<"input">, "type"> {
  /** Icon or adornment shown before the field value. */
  leadingIcon?: JSX.Element
  /** Show the trailing copy action. */
  showCopyButton?: boolean
  /** Show the trailing clear action. */
  showClearButton?: boolean
  /** Icon used by the trailing clear action. */
  clearIcon?: ComponentProps<typeof Icon>["name"]
  /** Accessible label for the copy button. */
  copyLabel?: string
  /** Accessible label for the clear button. */
  clearLabel?: string
  onCopyClick?: (event: MouseEvent) => void
  onClearClick?: (event: MouseEvent) => void
  /** Apply tabular numerals to the field value. */
  numeric?: boolean
  /** Error styling for the field and value text. */
  invalid?: boolean
  /** `base` is 28px tall; `large` is 32px tall. */
  appearance?: "base" | "large"
  type?: ComponentProps<"input">["type"]
}

export function TextInput(props: TextInputProps) {
  const i18n = useI18n()
  const [local, inputProps] = splitProps(props, [
    "class",
    "classList",
    "leadingIcon",
    "showCopyButton",
    "showClearButton",
    "clearIcon",
    "copyLabel",
    "clearLabel",
    "onCopyClick",
    "onClearClick",
    "numeric",
    "invalid",
    "appearance",
    "disabled",
  ])

  return (
    <div
      data-component="text-input-v2"
      data-disabled={local.disabled ? "" : undefined}
      data-invalid={local.invalid ? "" : undefined}
      data-numeric={local.numeric ? "" : undefined}
      data-appearance={local.appearance ?? "base"}
      data-leading-icon={local.leadingIcon ? "" : undefined}
      classList={{
        ...local.classList,
        [local.class ?? ""]: !!local.class,
      }}
    >
      <div data-slot="text-input-v2-value">
        <Show when={local.leadingIcon}>
          <span data-slot="text-input-v2-leading-icon">{local.leadingIcon}</span>
        </Show>
        <input
          {...inputProps}
          type={inputProps.type ?? "text"}
          disabled={local.disabled}
          aria-invalid={local.invalid ? true : undefined}
          data-slot="text-input-v2-input"
        />
      </div>
      <Show when={local.showClearButton || local.showCopyButton}>
        <button
          type="button"
          data-slot="text-input-v2-icon-button"
          data-variant={local.showClearButton ? "clear" : "copy"}
          aria-label={
            local.showClearButton
              ? (local.clearLabel ?? i18n.t("ui.common.clear"))
              : (local.copyLabel ?? i18n.t("ui.message.copy"))
          }
          disabled={local.disabled}
          onMouseDown={(event) => {
            if (!local.showClearButton) return
            event.preventDefault()
          }}
          onClick={(event) => {
            if (local.showClearButton) {
              local.onClearClick?.(event)
              return
            }
            local.onCopyClick?.(event)
          }}
        >
          <Icon name={local.showClearButton ? (local.clearIcon ?? "xmark-small") : "copy"} />
        </button>
      </Show>
    </div>
  )
}
