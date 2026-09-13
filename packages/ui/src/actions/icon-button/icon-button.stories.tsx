import { For } from "solid-js"
import { IconButton } from "./icon-button"
import { Icon } from "@opencode/ui/icon"

const docs = `### Overview
Square icon-only button with visual variants and three sizes.

### API
- \`icon\`: Icon content.
- \`variant\`: "neutral" | "contrast" | "submit" | "ghost".
- \`submit\` shares the contrast styling with regular Composer submit buttons.
- \`size\`: "small" | "normal" | "large".
- Inherits Kobalte Button props and native button attributes.

### States
- default, hover, pressed, focus, disabled.
- State selectors are available via pseudo-classes and \`[data-state]\`.
`

export default {
  title: "UI/IconButton",
  id: "ui-icon-button",
  component: IconButton,
  tags: ["autodocs"],
  parameters: {
    frameHeight: "300px",
    frameBackground: "#fff",
    docs: {
      description: {
        component: docs,
      },
    },
  },
  args: {
    icon: <Icon name="plus" />,
    variant: "neutral",
    size: "normal",
  },
  argTypes: {
    icon: {
      control: false,
    },
    variant: {
      control: "select",
      options: ["neutral", "contrast", "submit", "ghost"],
    },
    size: {
      control: "select",
      options: ["small", "normal", "large"],
    },
  },
}

export const Playground = {}

export const Variants = {
  render: () => (
    <div style={{ display: "flex", gap: "12px", "align-items": "center", "flex-wrap": "wrap" }}>
      <IconButton icon={<Icon name="plus" />} variant="neutral" />
      <IconButton icon={<Icon name="plus" />} variant="contrast" />
      <IconButton icon={<Icon name="arrow-up" />} variant="submit" />
      <IconButton icon={<Icon name="plus" />} variant="ghost" />
    </div>
  ),
}

export const Sizes = {
  render: () => (
    <div style={{ display: "flex", gap: "12px", "align-items": "center", "flex-wrap": "wrap" }}>
      <IconButton icon={<Icon name="plus" />} size="small" variant="neutral" />
      <IconButton icon={<Icon name="plus" />} size="normal" variant="neutral" />
      <IconButton icon={<Icon name="plus" />} size="large" variant="neutral" />
    </div>
  ),
}

export const AllStates = {
  render: () => {
    const variants = ["neutral", "contrast", "submit", "ghost"] as const
    const states = ["default", "hover", "pressed", "focus", "disabled"] as const

    return (
      <div style={{ display: "grid", gap: "12px" }}>
        <For each={variants}>
          {(variant) => (
            <div style={{ display: "grid", gap: "8px" }}>
              <div style={{ "font-size": "12px", color: "var(--text-weak)", "text-transform": "capitalize" }}>
                {variant}
              </div>
              <div style={{ display: "flex", gap: "8px", "flex-wrap": "wrap" }}>
                <For each={states}>
                  {(state) => (
                    <IconButton
                      icon={<Icon name="plus" />}
                      variant={variant}
                      data-state={state === "default" ? undefined : state}
                      disabled={state === "disabled"}
                    />
                  )}
                </For>
              </div>
            </div>
          )}
        </For>
      </div>
    )
  },
}
