import { Root } from "@kobalte/core/button"
import { type ComponentProps, splitProps } from "solid-js"
import { JSX } from "solid-js"
import "./icon-button.css"

export interface IconButtonProps
  extends ComponentProps<typeof Root>,
    Pick<ComponentProps<"button">, "class" | "classList"> {
  icon?: JSX.Element
  size?: "small" | "normal" | "large"
  variant?: "neutral" | "contrast" | "submit" | "ghost" | "ghost-muted"
  state?: "rest" | "hover" | "pressed"
}

export function IconButton(props: ComponentProps<"button"> & IconButtonProps) {
  const [local, rest] = splitProps(props, ["variant", "size", "icon", "class", "classList", "state"])
  return (
    <Root
      {...rest}
      data-component="icon-button-v2"
      data-size={local.size || "normal"}
      data-variant={local.variant || "neutral"}
      data-state={local.state}
      classList={{
        ...local.classList,
        [local.class ?? ""]: !!local.class,
      }}
    >
      {local.icon}
    </Root>
  )
}
