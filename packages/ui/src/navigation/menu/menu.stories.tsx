// @ts-nocheck
import { createSignal } from "solid-js"
import { Menu } from "./menu"
import { Button } from "@opencode/ui/button"
import { Avatar } from "@opencode/ui/avatar"
import { Icon } from "@opencode/ui/icon"

const docs = `### Overview
Composable menu primitive built on Kobalte's \`DropdownMenu\` and \`ContextMenu\`. The same item components (\`Item\`, \`CheckboxItem\`, \`RadioItem\`, \`SubTrigger\`) work inside either container.

### API
- \`Menu\` / \`Menu.Trigger\` / \`Menu.Portal\` / \`Menu.Content\` — dropdown root + popper plumbing.
- \`Menu.Context\` namespace mirrors the same shape for right-click menus.
- \`appearance\`: \`compact\` (default) or \`standard\`.
- \`Menu.Item\` — supports a freeform \`children\` slot (avatar, icon, text — whatever) plus \`shortcut\` and \`badge\` props.
- \`Menu.CheckboxItem\` / \`Menu.RadioItem\` — same item shape; auto-render a check indicator when selected.
- \`Menu.Sub\` / \`Menu.SubTrigger\` / \`Menu.SubContent\` — nested submenus; \`SubTrigger\` auto-renders the trailing chevron.

### Behavior
- Items expose Kobalte's data attributes — \`data-highlighted\`, \`data-checked\`, \`data-disabled\`.
- Selected state is reserved for \`CheckboxItem\` / \`RadioItem\` (the rest just highlight on hover).
- Chevron is only rendered on \`SubTrigger\`.
`

export default {
  title: "UI/Menu",
  id: "ui-menu",
  component: Menu,
  tags: ["autodocs"],
  parameters: {
    frameHeight: "360px",
    frameBackground: "#fff",
    docs: {
      description: {
        component: docs,
      },
    },
  },
}

export const Basic = {
  render: () => (
    <Menu gutter={6}>
      <Menu.Trigger as={Button}>Open menu</Menu.Trigger>
      <Menu.Portal>
        <Menu.Content>
          <Menu.Item>New file</Menu.Item>
          <Menu.Item>Open file</Menu.Item>
          <Menu.Item>Save</Menu.Item>
          <Menu.Separator />
          <Menu.Item disabled>Print</Menu.Item>
        </Menu.Content>
      </Menu.Portal>
    </Menu>
  ),
}

export const Appearances = {
  render: () => (
    <div style={{ display: "flex", gap: "16px" }}>
      <Menu appearance="standard" gutter={6} defaultOpen>
        <Menu.Trigger as={Button}>Standard</Menu.Trigger>
        <Menu.Portal>
          <Menu.Content>
            <Menu.Item>New file</Menu.Item>
            <Menu.Item>Open file</Menu.Item>
          </Menu.Content>
        </Menu.Portal>
      </Menu>
      <Menu appearance="compact" gutter={6} defaultOpen>
        <Menu.Trigger as={Button}>Compact</Menu.Trigger>
        <Menu.Portal>
          <Menu.Content>
            <Menu.Item>New file</Menu.Item>
            <Menu.Item>Open file</Menu.Item>
          </Menu.Content>
        </Menu.Portal>
      </Menu>
    </div>
  ),
}

export const Rich = {
  render: () => (
    <Menu gutter={6}>
      <Menu.Trigger as={Button}>Open rich menu</Menu.Trigger>
      <Menu.Portal>
        <Menu.Content style={{ "min-width": "240px" }}>
          <Menu.Item shortcut="⇧ D" badge="Label">
            <Avatar size="small" kind="org" fallback="A" />
            <Icon name="settings" size="small" />
            Text
          </Menu.Item>
          <Menu.Item shortcut="⌘ N">
            <Icon name="plus" size="small" />
            New window
          </Menu.Item>
          <Menu.Item shortcut="⌘ S" badge="Beta">
            <Icon name="save" size="small" />
            Save as…
          </Menu.Item>
          <Menu.Separator />
          <Menu.Item disabled shortcut="⌘ P">
            <Icon name="print" size="small" />
            Print
          </Menu.Item>
        </Menu.Content>
      </Menu.Portal>
    </Menu>
  ),
}

export const WithCheckbox = {
  render: () => {
    const [wrap, setWrap] = createSignal(true)
    const [minimap, setMinimap] = createSignal(false)
    const [ruler, setRuler] = createSignal(false)
    return (
      <Menu gutter={6}>
        <Menu.Trigger as={Button}>View</Menu.Trigger>
        <Menu.Portal>
          <Menu.Content style={{ "min-width": "200px" }}>
            <Menu.CheckboxItem checked={wrap()} onChange={setWrap} shortcut="⌥ Z">
              Word wrap
            </Menu.CheckboxItem>
            <Menu.CheckboxItem checked={minimap()} onChange={setMinimap}>
              Minimap
            </Menu.CheckboxItem>
            <Menu.CheckboxItem checked={ruler()} onChange={setRuler} disabled>
              Ruler
            </Menu.CheckboxItem>
          </Menu.Content>
        </Menu.Portal>
      </Menu>
    )
  },
}

export const WithRadio = {
  render: () => {
    const [theme, setTheme] = createSignal("system")
    return (
      <Menu gutter={6}>
        <Menu.Trigger as={Button}>Theme</Menu.Trigger>
        <Menu.Portal>
          <Menu.Content style={{ "min-width": "200px" }}>
            <Menu.Group>
              <Menu.GroupLabel>Appearance</Menu.GroupLabel>
              <Menu.RadioGroup value={theme()} onChange={setTheme}>
                <Menu.RadioItem value="light">Light</Menu.RadioItem>
                <Menu.RadioItem value="dark">Dark</Menu.RadioItem>
                <Menu.RadioItem value="system" badge="Auto">
                  System
                </Menu.RadioItem>
              </Menu.RadioGroup>
            </Menu.Group>
          </Menu.Content>
        </Menu.Portal>
      </Menu>
    )
  },
}

export const WithSubmenu = {
  render: () => (
    <Menu gutter={6}>
      <Menu.Trigger as={Button}>File</Menu.Trigger>
      <Menu.Portal>
        <Menu.Content style={{ "min-width": "200px" }}>
          <Menu.Item shortcut="⌘ N">New file</Menu.Item>
          <Menu.Item shortcut="⌘ O">Open file</Menu.Item>
          <Menu.Sub gutter={0}>
            <Menu.SubTrigger>Open recent</Menu.SubTrigger>
            <Menu.Portal>
              <Menu.SubContent>
                <Menu.Item>project-alpha.tsx</Menu.Item>
                <Menu.Item>project-beta.tsx</Menu.Item>
                <Menu.Item>project-gamma.tsx</Menu.Item>
                <Menu.Separator />
                <Menu.Item>Clear recent</Menu.Item>
              </Menu.SubContent>
            </Menu.Portal>
          </Menu.Sub>
          <Menu.Separator />
          <Menu.Item shortcut="⌘ S">Save</Menu.Item>
          <Menu.Item shortcut="⇧⌘ S">Save as…</Menu.Item>
        </Menu.Content>
      </Menu.Portal>
    </Menu>
  ),
}

export const Context = {
  render: () => (
    <Menu.Context gutter={6}>
      <Menu.Context.Trigger>
        <div
          style={{
            display: "flex",
            "align-items": "center",
            "justify-content": "center",
            width: "320px",
            height: "180px",
            "border-radius": "8px",
            border: "1px dashed rgba(0, 0, 0, 0.2)",
            color: "#5c5c5c",
            "font-size": "13px",
            "font-family": "var(--v2-font-family-sans)",
            "user-select": "none",
          }}
        >
          Right-click this area
        </div>
      </Menu.Context.Trigger>
      <Menu.Context.Portal>
        <Menu.Context.Content style={{ "min-width": "200px" }}>
          <Menu.Item shortcut="⌘ C">
            <Avatar size="small" kind="org" fallback="C" />
            Copy
          </Menu.Item>
          <Menu.Item shortcut="⌘ X">
            <Icon name="cut" size="small" />
            Cut
          </Menu.Item>
          <Menu.Item shortcut="⌘ V">
            <Icon name="paste" size="small" />
            Paste
          </Menu.Item>
          <Menu.Separator />
          <Menu.Item badge="New">
            <Icon name="inspect" size="small" />
            Inspect element
          </Menu.Item>
          <Menu.Item disabled>
            <Icon name="trash" size="small" />
            Delete
          </Menu.Item>
        </Menu.Context.Content>
      </Menu.Context.Portal>
    </Menu.Context>
  ),
}
