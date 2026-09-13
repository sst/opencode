import { createMemo, For, Show, createEffect, onMount, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { TextAttributes, ScrollBoxRenderable } from "@opentui/core"
import { useData } from "../../../context/data"
import { useClient } from "../../../context/client"
import { useTheme } from "../../../context/theme"
import { Keymap } from "../../../context/keymap"
import { useComposerTab } from "./index"
import { useDialog } from "../../../ui/dialog"
import { DialogShellOutput } from "../../../component/dialog-shell-output"

export function ShellTab(props: { sessionID: string }) {
  const data = useData()
  const client = useClient()
  const theme = useTheme()
  const composer = useComposerTab()
  const shortcuts = Keymap.useShortcuts()
  const dialog = useDialog()

  const entries = createMemo(() =>
    data.shell.listBySession(props.sessionID).filter((shell) => shell.status === "running"),
  )

  const [store, setStore] = createStore({ selected: 0 })
  let scroll: ScrollBoxRenderable | undefined

  const selectedEntry = createMemo(() => entries()[store.selected])

  const open = () => {
    const entry = selectedEntry()
    if (entry) dialog.replace(() => <DialogShellOutput shell={entry} location={entry.location} />)
  }

  createEffect(() => {
    if (store.selected >= entries().length) setStore("selected", Math.max(0, entries().length - 1))
  })

  createEffect(() => {
    if (!scroll) return
    const target = scroll.getChildren()[store.selected]
    if (!target) return
    const y = target.y - scroll.y
    if (y >= scroll.height || y < 0) {
      const center = Math.floor(scroll.height / 2)
      scroll.scrollBy(y - center)
    }
  })

  onMount(() => {
    const cleanup = composer.register({
      id: "shell",
      label: "Shell",
      hints: () =>
        selectedEntry()
          ? [
              { label: "output", shortcut: shortcuts.get("composer.shell.select") ?? "" },
              { label: "kill", shortcut: shortcuts.get("composer.shell.kill") ?? "" },
            ]
          : [],
    })
    onCleanup(cleanup)
  })

  Keymap.createLayer(() => ({
    mode: "composer",
    enabled: () => composer.active("shell"),
    priority: 1,
    commands: [
      {
        id: "composer.shell.up",
        title: "Previous shell",
        group: "Composer",
        run() {
          if (store.selected === 0) {
            composer.close()
            return
          }
          setStore("selected", (prev) => prev - 1)
        },
      },
      {
        id: "composer.shell.down",
        title: "Next shell",
        group: "Composer",
        run() {
          const list = entries()
          if (list.length === 0) return
          setStore("selected", (prev) => (prev + 1) % list.length)
        },
      },
      {
        id: "composer.shell.select",
        title: "View shell output",
        group: "Composer",
        run: open,
      },
      {
        id: "composer.shell.kill",
        title: "Kill shell command",
        group: "Composer",
        run() {
          const entry = selectedEntry()
          if (!entry) return
          void client.api.shell.remove({
            id: entry.id,
            location: { directory: entry.location.directory, workspace: entry.location.workspaceID },
          })
        },
      },
    ],
  }))

  return (
    <Show when={composer.active("shell")}>
      <scrollbox scrollbarOptions={{ visible: false }} maxHeight={5} ref={(r: ScrollBoxRenderable) => (scroll = r)}>
        <Show when={entries().length > 0} fallback={<text fg={theme.text.subdued}> No shell commands</text>}>
          <For each={entries()}>
            {(shell, index) => {
              const active = createMemo(() => index() === store.selected)
              return (
                <box
                  flexDirection="row"
                  paddingLeft={1}
                  paddingRight={1}
                  backgroundColor={
                    active() ? theme.background.action.primary.focused : theme.background.action.primary.default
                  }
                  onMouseMove={() => setStore("selected", index())}
                  onMouseUp={() => {
                    setStore("selected", index())
                    open()
                  }}
                >
                  <text
                    fg={active() ? theme.text.action.primary.focused : theme.text.action.primary.default}
                    attributes={active() ? TextAttributes.BOLD : undefined}
                    wrapMode="none"
                  >
                    {shell.command.split("\n", 1)[0]}
                  </text>
                </box>
              )
            }}
          </For>
        </Show>
      </scrollbox>
    </Show>
  )
}
