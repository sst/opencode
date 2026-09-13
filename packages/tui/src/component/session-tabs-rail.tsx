import { createMemo, createSignal } from "solid-js"
import type { RGBA } from "@opentui/core"
import { Keymap } from "../context/keymap"
import { useTheme } from "../context/theme"
import { tint } from "../theme/color"
import type { SessionTabsController } from "./session-tabs"

export function SessionTabsRailControls(props: {
  width: number
  tabs: SessionTabsController
  belowHighlighted: boolean
}) {
  const theme = useTheme("elevated")
  const keymap = Keymap.use()
  const [hovered, setHovered] = createSignal(false)
  const hoverColor = createMemo(() =>
    tint(theme.background.default, theme.background.action.primary.hovered, theme.background.action.primary.hovered.a),
  )
  let pressed = false
  const search = () => (props.tabs.search ? props.tabs.search() : keymap.dispatch("session.list"))
  return (
    <box height={1} position="relative" flexShrink={0} backgroundColor={theme.background.default}>
      <SessionTabHalfRow
        top={-1}
        edge="top"
        width={props.width}
        color={hovered() ? hoverColor() : theme.background.default}
        background={theme.background.default}
      />
      <box
        height={1}
        position="relative"
        flexDirection="row"
        justifyContent="center"
        backgroundColor={hovered() ? theme.background.action.primary.hovered : undefined}
        onMouseOver={() => setHovered(true)}
        onMouseOut={() => setHovered(false)}
        onMouseDown={(event) => {
          pressed = event.button === 0
          event.stopPropagation()
        }}
        onMouseUp={(event) => {
          event.stopPropagation()
          if (event.button !== 0 || !pressed) return
          pressed = false
          search()
        }}
        onMouseDragEnd={() => (pressed = false)}
      >
        <text width={1} height={1} fg={theme.text.action.secondary.default} selectable={false} wrapMode="none">
          ⌕
        </text>
      </box>
      <text
        position="absolute"
        top={1}
        left={0}
        width={props.width}
        height={1}
        zIndex={2}
        fg={hoverColor()}
        bg={hovered() && props.belowHighlighted ? hoverColor() : theme.background.default}
        selectable={false}
      >
        {(hovered() ? "▀" : props.belowHighlighted ? "▄" : " ").repeat(props.width)}
      </text>
    </box>
  )
}

export function SessionTabHalfRow(props: {
  top: number
  edge: "top" | "bottom"
  width: number
  color: RGBA
  background: RGBA
}) {
  return (
    <text
      position="absolute"
      top={props.top}
      left={0}
      width={props.width}
      height={1}
      zIndex={1}
      fg={props.color}
      bg={props.background}
      selectable={false}
      wrapMode="none"
    >
      {(props.edge === "top" ? "▄" : "▀").repeat(props.width)}
    </text>
  )
}
