import { Root } from "@kobalte/core/button"
import { type ComponentProps, Show, splitProps } from "solid-js"
import { Icon, type IconProps } from "@opencode/ui/icon"
import "./button.css"

export interface ButtonProps
  extends ComponentProps<typeof Root>,
    Pick<ComponentProps<"button">, "class" | "classList" | "children"> {
  size?: "small" | "normal" | "large"
  variant?:
    | "neutral"
    | "danger"
    | "warning"
    | "outline"
    | "contrast"
    | "submit"
    | "ghost"
    | "ghost-muted"
    | "ghost-faint"
    | "loading"
  icon?: IconProps["name"]
}

export function Button(props: ButtonProps) {
  const [split, rest] = splitProps(props, ["variant", "size", "icon", "class", "classList"])
  return (
    <Root
      {...rest}
      data-component="button-v2"
      data-size={split.size || "normal"}
      data-variant={split.variant || "neutral"}
      data-icon={split.icon}
      classList={{
        ...split.classList,
        [split.class ?? ""]: !!split.class,
      }}
    >
      <Show when={split.icon}>{(icon) => <Icon name={icon()} />}</Show>
      {props.children}
    </Root>
  )
}
