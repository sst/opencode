/* @refresh skip */
import { BoxRenderable, TextAttributes } from "@opentui/core"
import { Portal, useRenderer, useTerminalDimensions } from "@opentui/solid"
import { onCleanup, onMount } from "solid-js"
import { useTheme } from "../../tui/src/context/theme"
import { Dialog } from "../../tui/src/ui/dialog"
import { Keymap } from "../../tui/src/context/keymap"

export function ErrorOverlay(props: { component: string; error: unknown; onClose: () => void }) {
  const renderer = useRenderer()
  const dimensions = useTerminalDimensions()
  const theme = useTheme("elevated")
  const focus = renderer.currentFocusedRenderable
  onCleanup(Keymap.use().mode.push("modal"))
  Keymap.createLayer(() => ({
    mode: "modal",
    priority: 1000,
    commands: [{ bind: "escape", title: "Close hot reload error", group: "Development", run: props.onClose }],
  }))
  onMount(() => focus?.blur())
  onCleanup(() => {
    if (focus && !focus.isDestroyed) focus.focus()
  })

  return (
    <Portal
      ref={(container) => {
        if (!(container instanceof BoxRenderable)) return
        // Anchor Portal's wrapper above the app rather than after it in root layout.
        container.position = "absolute"
        container.left = 0
        container.top = 0
        container.zIndex = 5000
      }}
    >
      <Dialog centered onClose={props.onClose}>
        <box maxHeight={Math.max(1, dimensions().height - 3)} paddingX={2} paddingBottom={1} gap={1}>
          <box flexDirection="row" justifyContent="space-between" flexShrink={0}>
            <text fg={theme.text.feedback.error.default} attributes={TextAttributes.BOLD}>
              Error while hot reloading
            </text>
            <text fg={theme.text.subdued} onMouseUp={props.onClose}>
              esc
            </text>
          </box>
          <text maxHeight={Math.max(1, dimensions().height - 9)} fg={theme.text.default}>
            {props.error instanceof Error ? props.error.message : String(props.error)}
          </text>
          <text flexShrink={0} fg={theme.text.subdued}>
            {props.component} · Fix the component and save to retry.
          </text>
        </box>
      </Dialog>
    </Portal>
  )
}
