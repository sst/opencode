import { For } from "solid-js"
import { Button } from "./button"

const docs = `### Overview
Button v2 with visual variants and three sizes.

### API
- \`variant\`: "neutral" | "danger" | "warning" | "contrast" | "submit" | "ghost" | "ghost-muted" | "ghost-faint" | "loading".
- \`submit\` shares the brighter contrast icon-button styling for Composer submission actions.
- \`size\`: "small" | "normal" | "large".
- \`icon\`: Optional icon name.
- Inherits Kobalte Button props and native button attributes.

### States
- default, hover, pressed, focus, disabled.
- State selectors are available via pseudo-classes and \`[data-state]\`.
`

export default {
  title: "UI/Button",
  id: "ui-button",
  component: Button,
  tags: ["autodocs"],
  parameters: {
    frameHeight: "240px",
    frameBackground: "#fff",
    docs: {
      description: {
        component: docs,
      },
    },
  },
  args: {
    children: "Button",
    variant: "neutral",
    size: "normal",
  },
  argTypes: {
    icon: {
      control: "text",
    },
    variant: {
      control: "select",
      options: ["neutral", "danger", "warning", "contrast", "submit", "ghost", "ghost-muted", "ghost-faint", "loading"],
    },
    size: {
      control: "select",
      options: ["normal", "large"],
    },
  },
}

export const Playground = {}

export const Variants = {
  render: () => (
    <div
      style={{
        display: "flex",
        gap: "12px",
        "align-items": "center",
        "flex-wrap": "wrap",
      }}
    >
      <Button variant="neutral">Neutral</Button>
      <Button variant="danger">Danger</Button>
      <Button variant="warning">Warning</Button>
      <Button variant="contrast">Contrast</Button>
      <Button variant="submit">Submit</Button>
      <Button variant="ghost">Ghost</Button>
      <Button variant="ghost-muted" icon="edit">
        Ghost muted
      </Button>
      <Button variant="ghost-faint" icon="edit">
        Ghost faint
      </Button>
      <Button variant="loading">Loading</Button>
    </div>
  ),
}

export const Sizes = {
  render: () => (
    <div
      style={{
        display: "flex",
        gap: "12px",
        "align-items": "center",
        "flex-wrap": "wrap",
      }}
    >
      <Button size="small" variant="neutral">
        Small
      </Button>
      <Button size="normal" variant="neutral">
        Normal
      </Button>
      <Button size="large" variant="neutral">
        Large
      </Button>
    </div>
  ),
}

export const Icon = {
  render: () => (
    <div
      style={{
        display: "flex",
        gap: "12px",
        "align-items": "center",
        "flex-wrap": "wrap",
      }}
    >
      <Button variant="neutral" size="normal" icon="plus">
        Normal
      </Button>
      <Button variant="contrast" size="large" icon="plus">
        Large
      </Button>
    </div>
  ),
}

export const AllStates = {
  render: () => {
    const variants = [
      "neutral",
      "danger",
      "warning",
      "contrast",
      "submit",
      "ghost",
      "ghost-muted",
      "ghost-faint",
      "loading",
    ] as const
    const states = ["default", "hover", "pressed", "focus", "disabled"] as const
    const toTitleCase = (value: string) => value.charAt(0).toUpperCase() + value.slice(1)
    return (
      <div style={{ display: "grid", gap: "12px" }}>
        <For each={variants}>
          {(variant) => (
            <div style={{ display: "grid", gap: "8px" }}>
              <div
                style={{
                  "font-size": "12px",
                  color: "var(--text-weak)",
                  "text-transform": "capitalize",
                }}
              >
                {variant}
              </div>
              <div style={{ display: "flex", gap: "8px", "flex-wrap": "wrap" }}>
                <For each={states}>
                  {(state) => (
                    <Button
                      variant={variant}
                      data-state={state === "default" ? undefined : state}
                      disabled={state === "disabled"}
                    >
                      {toTitleCase(state)}
                    </Button>
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
