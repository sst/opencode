import { type MouseEvent } from "@opentui/core"
import { Show } from "solid-js"
import { useTheme } from "../../context/theme"

export function SidebarRail(props: {
  collapsed: boolean
  width: number
  mouseEnabled: boolean
  onMouseDown?: (evt: MouseEvent) => void
  onMouseUp?: () => void
}) {
  const { theme } = useTheme()
  const handlers = () => {
    if (!props.mouseEnabled) return {}
    return {
      // Drag and drag-end bind on the ancestor row: a rail drag captures an adjacent column,
      // and captured events bubble to the ancestor. The up binds in both modes — a click
      // forms no capture, so without it an expanded click would leave the gesture armed.
      onMouseDown: props.onMouseDown,
      onMouseUp: props.onMouseUp,
    }
  }

  return (
    <box
      id="sidebar-rail"
      width={props.width}
      flexShrink={0}
      border={["left"]}
      borderColor={theme.border}
      {...handlers()}
    >
      <Show when={props.collapsed}>
        <text fg={theme.textMuted}>▸</text>
      </Show>
    </box>
  )
}
