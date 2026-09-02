import { type MouseEvent } from "@opentui/core"
import { Show } from "solid-js"
import { useTheme } from "../../context/theme"

export function SidebarRail(props: {
  collapsed: boolean
  mouseEnabled: boolean
  onMouseDown?: (evt: MouseEvent) => void
  onMouseDrag?: (evt: MouseEvent) => void
  onMouseDragEnd?: (evt: MouseEvent) => void
  onExpand?: () => void
}) {
  const { theme } = useTheme()
  const handlers = () => {
    if (!props.mouseEnabled) return {}
    return {
      onMouseDown: props.onMouseDown,
      onMouseUp: props.collapsed ? props.onExpand : undefined,
    }
  }

  return (
    <box id="sidebar-rail" width={1} flexShrink={0} border={["left"]} borderColor={theme.border} {...handlers()}>
      <Show when={props.collapsed}>
        <text fg={theme.textMuted}>▸</text>
      </Show>
    </box>
  )
}
