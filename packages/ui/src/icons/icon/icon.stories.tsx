import { For } from "solid-js"
import { Icon, type IconProps } from "./icon"

const names = [
  "archive",
  "arrow-left",
  "arrow-right",
  "arrow-up-right",
  "branch",
  "check",
  "chevron-down",
  "close",
  "code-slash",
  "edit",
  "folder",
  "graduation-cap",
  "help",
  "magnifying-glass",
  "menu",
  "monitor",
  "outline-arrow-to-corner-top-right",
  "outline-copy",
  "outline-dots",
  "outline-eye",
  "outline-eye-slash",
  "outline-hexagonal-warning",
  "plus",
  "review",
  "settings-gear",
  "trash",
  "workspace",
] satisfies IconProps["name"][]

export default {
  title: "UI/Icon",
  id: "ui-icon",
  component: Icon,
  tags: ["autodocs"],
  args: {
    name: "check",
    size: "normal",
  },
  argTypes: {
    name: { control: "select", options: names },
    size: { control: "select", options: ["small", "normal", "large"] },
  },
}

export const Playground = {}

export const Sizes = {
  render: () => (
    <div style={{ display: "flex", gap: "12px", "align-items": "center" }}>
      <Icon name="check" size="small" />
      <Icon name="check" size="normal" />
      <Icon name="check" size="large" />
    </div>
  ),
}

export const Directional = {
  render: () => (
    <div style={{ display: "grid", gap: "12px" }}>
      <div dir="ltr" style={{ display: "flex", gap: "8px" }}>
        <Icon name="arrow-left" />
        <Icon name="arrow-right" />
      </div>
      <div dir="rtl" style={{ display: "flex", gap: "8px" }}>
        <Icon name="arrow-left" />
        <Icon name="arrow-right" />
      </div>
    </div>
  ),
}

export const Gallery = {
  render: () => (
    <div style={{ display: "grid", gap: "12px", "grid-template-columns": "repeat(5, minmax(88px, 1fr))" }}>
      <For each={names}>
        {(name) => (
          <div style={{ display: "grid", gap: "6px", "justify-items": "center" }}>
            <Icon name={name} />
            <span style={{ "font-size": "10px", color: "var(--text-weak)", "text-align": "center" }}>{name}</span>
          </div>
        )}
      </For>
    </div>
  ),
}
