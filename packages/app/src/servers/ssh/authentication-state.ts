import { createEffect } from "solid-js"
import type { SshItem } from "./types"

// Offer authentication once per selected tab. Cancelling must not immediately
// reopen the prompt; background hosts never open a dialog here.
export function createSshAuthentication(input: {
  selection: () => string | undefined
  item: () => SshItem | undefined
  busy: () => boolean
  open: (item: SshItem) => void
}) {
  const state = { selection: undefined as string | undefined, offered: false }
  createEffect(() => {
    const selection = input.selection()
    if (state.selection !== selection) {
      state.selection = selection
      state.offered = false
    }
    const item = input.item()
    if (!selection || state.offered || item?.stage !== "authentication" || item.authenticatingElsewhere || input.busy())
      return
    state.offered = true
    input.open(item)
  })
}
