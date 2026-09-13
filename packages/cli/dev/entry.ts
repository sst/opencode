/// <reference types="vite/client" />
import { host } from "@opencode/cli/vite-host"
import { configureErrorOverlay } from "./refresh"

if (import.meta.hot) {
  import.meta.hot.on("vite:afterUpdate", () => queueMicrotask(() => host.settle?.()))
  import.meta.hot.on("vite:beforeFullReload", async () => {
    await host.stop?.()
    host.reset?.()
  })
}

const { run } = await import("../../tui/src/index")
// Theme/dialog modules use refresh themselves; initialize their overlay after the app graph loads.
const { ErrorOverlay } = await import("./error-overlay")
configureErrorOverlay(ErrorOverlay)
await host.mount?.(run)
