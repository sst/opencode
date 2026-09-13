import { Show } from "solid-js"
import type { JSX } from "solid-js"
import { FileIcon } from "@opencode/ui/file-icon"
import { getFilename } from "@opencode/util/path"

export function FileVisual(props: {
  path: string
  active?: boolean
  temporary?: boolean
  notFound?: boolean
}): JSX.Element {
  return (
    <div class="flex items-center gap-x-1.5 min-w-0">
      <Show
        when={!props.active}
        fallback={<FileIcon node={{ path: props.path, type: "file" }} class="size-4 shrink-0" />}
      >
        <span class="relative inline-flex size-4 shrink-0">
          <FileIcon node={{ path: props.path, type: "file" }} class="absolute inset-0 size-4 tab-fileicon-color" />
          <FileIcon node={{ path: props.path, type: "file" }} mono class="absolute inset-0 size-4 tab-fileicon-mono" />
        </span>
      </Show>
      <span
        class="text-14-medium truncate"
        classList={{ italic: props.temporary, "line-through": props.notFound }}
        data-file-not-found={props.notFound ? "" : undefined}
      >
        {getFilename(props.path)}
      </span>
    </div>
  )
}
