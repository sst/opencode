import { children, createMemo, Show } from "solid-js"
import type { JSX } from "solid-js"
import { useSortable } from "@dnd-kit/solid/sortable"
import { Keybind } from "@opencode/ui/keybind"
import { Tooltip } from "@opencode/ui/tooltip"
import { Tabs } from "@opencode/ui/tabs"
import { getFilename } from "@opencode/util/path"
import { useFile } from "@/workspaces/files/model"
import { useLanguage } from "@/runtime/i18n/language"
import { useCommand } from "@/shell/commands/command"
import { FileVisual } from "./session-sortable-tab"

export function SortableTab(props: {
  tab: string
  index: number
  temporary?: boolean
  onTabClose: (tab: string) => void
  onTabDoubleClick?: (tab: string) => void
  /** Replaces the file visual for non-file tabs such as the browser. */
  children?: JSX.Element
  id?: string
  ariaControls?: string
}): JSX.Element {
  const file = useFile()
  const language = useLanguage()
  const command = useCommand()
  const closeTabKeybind = createMemo(() => command.keybindParts("file.close"))
  const sortable = useSortable({
    get id() {
      return props.tab
    },
    get index() {
      return props.index
    },
  })
  const path = createMemo(() => file.pathFromTab(props.tab))
  const notFound = createMemo(() => {
    const value = path()
    return value ? file.notFound(value) : false
  })
  const custom = children(() => props.children)
  const content = createMemo(() => {
    const value = path()
    if (!value) return
    return <FileVisual path={value} temporary={props.temporary} notFound={notFound()} />
  })
  return (
    <div ref={sortable.ref} class="h-full flex items-center">
      <div class="relative">
        <Tabs.Trigger
          value={props.tab}
          id={props.id}
          aria-controls={props.ariaControls}
          aria-label={
            notFound() && path() ? language.t("file.error.notFound", { name: getFilename(path()!) }) : undefined
          }
          onMiddleClick={() => props.onTabClose(props.tab)}
          onDblClick={() => props.onTabDoubleClick?.(props.tab)}
          closeButton={
            <Tooltip
              value={
                <>
                  {language.t("common.closeTab")}
                  <Show when={closeTabKeybind().length > 0}>
                    <Keybind keys={closeTabKeybind()} variant="neutral" />
                  </Show>
                </>
              }
              placement="bottom"
              gutter={10}
            >
              <Tabs.CloseButton
                class="h-5 w-5"
                onClick={() => props.onTabClose(props.tab)}
                aria-label={language.t("common.closeTab")}
              />
            </Tooltip>
          }
          hideCloseButton
        >
          <Show when={custom()} fallback={<Show when={content()}>{(value) => value()}</Show>}>
            {custom()}
          </Show>
        </Tabs.Trigger>
      </div>
    </div>
  )
}
