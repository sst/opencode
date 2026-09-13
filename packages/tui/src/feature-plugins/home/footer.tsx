import { Plugin } from "@opencode/plugin/tui"
import { createMemo, Match, Show, Switch } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import { usePlugin } from "../../plugin/context"
import { Slot } from "../../plugin/render"

export function homeFooterVisibility(width: number) {
  return {
    mcpCommand: width >= 64,
    pluginCommand: width >= 80,
    version: width >= 64,
  }
}

function Mcp(props: { context: Plugin.Context }) {
  const dimensions = useTerminalDimensions()
  const visibility = createMemo(() => homeFooterVisibility(dimensions().width))
  const list = createMemo(() => props.context.data.location.mcp.server.list(props.context.location) ?? [])
  const failed = createMemo(() => list().filter((item) => item.status.status === "failed").length)
  const count = createMemo(() => list().filter((item) => item.status.status === "connected").length)

  return (
    <Show when={list().length}>
      <box gap={1} flexDirection="row" flexShrink={0} onMouseUp={() => props.context.keymap.dispatch("mcp.list")}>
        <text fg={props.context.theme.text.default}>
          <Switch>
            <Match when={failed()}>
              <span style={{ fg: props.context.theme.text.feedback.error.default }}>⊙ </span>
              {failed()} MCP failed
            </Match>
            <Match when={true}>
              <span
                style={{
                  fg:
                    count() > 0 ? props.context.theme.text.feedback.success.default : props.context.theme.text.subdued,
                }}
              >
                ⊙{" "}
              </span>
              {count()} MCP
            </Match>
          </Switch>
        </text>
        <Show when={visibility().mcpCommand}>
          <text fg={props.context.theme.text.subdued}>/mcps</text>
        </Show>
      </box>
    </Show>
  )
}

function Plugins(props: { context: Plugin.Context }) {
  const dimensions = useTerminalDimensions()
  const visibility = createMemo(() => homeFooterVisibility(dimensions().width))
  const plugins = usePlugin()
  const failed = createMemo(
    () =>
      plugins.list().filter((item) => item.status === "failed").length +
      plugins.server().filter((item) => item.state.status === "failed").length,
  )

  return (
    <Show when={failed()}>
      <box gap={1} flexDirection="row" flexShrink={0} onMouseUp={() => props.context.keymap.dispatch("plugins.list")}>
        <text fg={props.context.theme.text.default}>
          <span style={{ fg: props.context.theme.text.feedback.error.default }}>⊙ </span>
          {failed()} plugin{failed() === 1 ? "" : "s"} failed
        </text>
        <Show when={visibility().pluginCommand}>
          <text fg={props.context.theme.text.subdued}>/plugins</text>
        </Show>
      </box>
    </Show>
  )
}

function View(props: { context: Plugin.Context }) {
  const dimensions = useTerminalDimensions()
  const visibility = createMemo(() => homeFooterVisibility(dimensions().width))

  return (
    <Show when={dimensions().height >= 12 && dimensions().width >= 44}>
      <box
        width="100%"
        paddingTop={dimensions().height < 16 ? 0 : 1}
        paddingBottom={dimensions().height < 16 ? 0 : 1}
        paddingLeft={2}
        paddingRight={2}
        flexDirection="row"
        flexShrink={0}
        gap={2}
      >
        <Mcp context={props.context} />
        <Plugins context={props.context} />
        <Slot path="home.footer.status" />
        <box flexGrow={1} />
        <Show when={visibility().version}>
          <box flexShrink={0}>
            <text fg={props.context.theme.text.subdued}>{props.context.app.version}</text>
          </box>
        </Show>
      </box>
    </Show>
  )
}

export default Plugin.define({
  id: "opencode.home.footer",
  setup(context) {
    // Root takeover: an external plugin replacing home.footer wins (last-
    // enabled) and this builtin shows as suppressed, not silently gone.
    // Append keeps the path open to additive plugin claims; an external
    // replace still takes the boundary over.
    context.ui.slot({ append: "home.footer", render: () => <View context={context} /> })
  },
})
