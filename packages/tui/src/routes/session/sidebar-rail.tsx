import { type MouseEvent } from "@opentui/core"
import { Show } from "solid-js"
import { useTheme } from "../../context/theme"

export function SidebarRail(props: {
  collapsed: boolean
  width: number
  mouseEnabled: boolean
  onMouseDown?: (evt: MouseEvent) => void
  onExpand?: () => void
}) {
  const { theme } = useTheme()
  const handlers = () => {
    if (!props.mouseEnabled) return {}
    return {
      // Drag and drag-end bind on the ancestor row: a 1-column rail is never the captured renderable.
      onMouseDown: props.onMouseDown,
      onMouseUp: props.collapsed ? props.onExpand : undefined,
    }
  }

  return (
    <box id="sidebar-rail" width={props.width} flexShrink={0} border={["left"]} borderColor={theme.border} {...handlers()}>
      <Show when={props.collapsed}>
        <text fg={theme.textMuted}>▸</text>
      </Show>
    </box>
  )
}
