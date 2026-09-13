import { createEffect } from "solid-js"
import type { SshStart, SshState } from "./types"

export function createSshRestore(input: {
  state: () => SshState | undefined
  start: (input: SshStart) => Promise<void> | undefined
}) {
  const restored = new Set<string>()
  createEffect(() => {
    for (const item of input.state()?.servers ?? []) {
      if (!item.saved || restored.has(item.config.id)) continue
      // Mark active connections too, so a later manual disconnect is respected.
      restored.add(item.config.id)
      if (item.stage === "disconnected") void input.start({ ...item.config, background: true })
    }
  })
}
