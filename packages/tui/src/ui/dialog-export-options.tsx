import { TextAttributes } from "@opentui/core"
import { Keymap } from "../context/keymap"
import { useTheme } from "../context/theme"
import { useDialog, type DialogContext } from "./dialog"
import { createStore } from "solid-js/store"
import { For, Show } from "solid-js"

export type ExportFormat = "markdown" | "json"

export type DialogExportOptionsProps = {
  defaultThinking: boolean
  onConfirm?: (options: {
    action: "copy" | "export"
    format: ExportFormat
    thinking: boolean
    tools: boolean
    sanitize: boolean
  }) => void
  onCancel?: () => void
}

type Active = ExportFormat | "thinking" | "tools" | "sanitize" | "copy" | "export"

export function DialogExportOptions(props: DialogExportOptionsProps) {
  const dialog = useDialog()
  const theme = useTheme("elevated")
  const overlayTheme = useTheme("overlay")
  const [store, setStore] = createStore({
    format: "markdown" as ExportFormat,
    thinking: props.defaultThinking,
    tools: true,
    sanitize: false,
    active: "markdown" as Active,
  })

  const confirm = (action: "copy" | "export") =>
    props.onConfirm?.({
      action,
      format: store.format,
      thinking: store.thinking,
      tools: store.tools,
      sanitize: store.sanitize,
    })

  const activate = () => {
    if (store.active === "markdown" || store.active === "json") {
      setStore("format", store.active)
      return
    }
    if (store.active === "thinking") setStore("thinking", !store.thinking)
    if (store.active === "tools") setStore("tools", !store.tools)
    if (store.active === "sanitize") setStore("sanitize", !store.sanitize)
    if (store.active === "copy" || store.active === "export") confirm(store.active)
  }

  Keymap.createLayer(() => ({
    mode: "modal",
    commands: [
      {
        bind: "tab",
        title: "Next export option",
        group: "Dialog",
        run: () => {
          const order: Active[] =
            store.format === "markdown"
              ? ["markdown", "json", "thinking", "tools", "copy", "export"]
              : ["markdown", "json", "sanitize", "copy", "export"]
          setStore("active", order[(order.indexOf(store.active) + 1) % order.length])
        },
      },
      {
        bind: "return",
        title: "Select export option",
        group: "Dialog",
        run: activate,
      },
    ],
  }))

  const selectFormat = (format: ExportFormat) => {
    setStore("format", format)
    setStore("active", format)
  }

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text.default}>
          Export session
        </text>
        <text fg={theme.text.subdued} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>
      <box flexDirection="row" gap={1}>
        <text fg={theme.text.default}>Export as:</text>
        <box flexDirection="row" gap={1}>
          <For each={["markdown", "json"] as const}>
            {(format) => (
              <box
                paddingLeft={1}
                paddingRight={1}
                backgroundColor={
                  store.active === format
                    ? theme.background.formfield.focused
                    : store.format === format
                      ? theme.background.formfield.selected
                      : theme.background.formfield.default
                }
                onMouseUp={() => selectFormat(format)}
              >
                <text
                  fg={
                    store.active === format
                      ? theme.text.formfield.focused
                      : store.format === format
                        ? theme.text.formfield.selected
                        : theme.text.formfield.default
                  }
                >
                  {store.format === format ? "◉" : "○"} {format === "markdown" ? "Markdown" : "JSON"}
                </text>
              </box>
            )}
          </For>
        </box>
      </box>
      <Show when={store.format === "markdown"}>
        <box
          flexDirection="row"
          gap={1}
          backgroundColor={
            store.active === "thinking"
              ? theme.background.formfield.focused
              : store.thinking
                ? theme.background.formfield.selected
                : theme.background.formfield.default
          }
          onMouseUp={() => {
            setStore("active", "thinking")
            setStore("thinking", !store.thinking)
          }}
        >
          <text
            fg={
              store.active === "thinking"
                ? theme.text.formfield.focused
                : store.thinking
                  ? theme.text.formfield.selected
                  : theme.text.formfield.default
            }
          >
            {store.thinking ? "[x]" : "[ ]"}
          </text>
          <text
            fg={
              store.active === "thinking"
                ? theme.text.formfield.focused
                : store.thinking
                  ? theme.text.formfield.selected
                  : theme.text.formfield.default
            }
          >
            Include thinking
          </text>
        </box>
        <box
          flexDirection="row"
          gap={1}
          backgroundColor={
            store.active === "tools"
              ? theme.background.formfield.focused
              : store.tools
                ? theme.background.formfield.selected
                : theme.background.formfield.default
          }
          onMouseUp={() => {
            setStore("active", "tools")
            setStore("tools", !store.tools)
          }}
        >
          <text
            fg={
              store.active === "tools"
                ? theme.text.formfield.focused
                : store.tools
                  ? theme.text.formfield.selected
                  : theme.text.formfield.default
            }
          >
            {store.tools ? "[x]" : "[ ]"}
          </text>
          <text
            fg={
              store.active === "tools"
                ? theme.text.formfield.focused
                : store.tools
                  ? theme.text.formfield.selected
                  : theme.text.formfield.default
            }
          >
            Include tools
          </text>
        </box>
      </Show>
      <Show when={store.format === "json"}>
        <box
          flexDirection="row"
          gap={1}
          backgroundColor={
            store.active === "sanitize"
              ? theme.background.formfield.focused
              : store.sanitize
                ? theme.background.formfield.selected
                : theme.background.formfield.default
          }
          onMouseUp={() => {
            setStore("active", "sanitize")
            setStore("sanitize", !store.sanitize)
          }}
        >
          <text
            fg={
              store.active === "sanitize"
                ? theme.text.formfield.focused
                : store.sanitize
                  ? theme.text.formfield.selected
                  : theme.text.formfield.default
            }
          >
            {store.sanitize ? "[x]" : "[ ]"}
          </text>
          <text
            fg={
              store.active === "sanitize"
                ? theme.text.formfield.focused
                : store.sanitize
                  ? theme.text.formfield.selected
                  : theme.text.formfield.default
            }
          >
            Sanitize sensitive data
          </text>
        </box>
      </Show>
      <box flexDirection="row" justifyContent="flex-end" gap={1} paddingBottom={1}>
        <box
          paddingLeft={4}
          paddingRight={4}
          backgroundColor={overlayTheme.background.default}
          onMouseUp={() => confirm("copy")}
        >
          <text fg={overlayTheme.text.default}>Copy</text>
        </box>
        <box
          paddingLeft={4}
          paddingRight={4}
          backgroundColor={
            store.active === "export"
              ? theme.background.action.primary.focused
              : theme.background.action.primary.default
          }
          onMouseUp={() => confirm("export")}
        >
          <text fg={store.active === "export" ? theme.text.action.primary.focused : theme.text.action.primary.default}>
            Export
          </text>
        </box>
      </box>
    </box>
  )
}

DialogExportOptions.show = (dialog: DialogContext, defaultThinking: boolean) => {
  return new Promise<{
    action: "copy" | "export"
    format: ExportFormat
    thinking: boolean
    tools: boolean
    sanitize: boolean
  } | null>((resolve) => {
    dialog.replace(
      () => (
        <DialogExportOptions
          defaultThinking={defaultThinking}
          onConfirm={(options) => resolve(options)}
          onCancel={() => resolve(null)}
        />
      ),
      () => resolve(null),
    )
  })
}
