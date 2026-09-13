import { createMediaQuery } from "@solid-primitives/media"
import { Show } from "solid-js"

export function SessionHeaderSpacer(props: { visible: boolean }) {
  const isDesktop = createMediaQuery("(min-width: 768px)")

  return (
    <Show when={isDesktop() && props.visible}>
      <div class="size-7 shrink-0" aria-hidden />
    </Show>
  )
}
