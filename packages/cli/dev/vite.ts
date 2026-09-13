import { plugin } from "bun"
import { ensureSolidTransformPlugin } from "@opentui/solid/bun-plugin"

ensureSolidTransformPlugin()
if (process.argv[2] !== "serve") {
  // Vite must initialize before the CLI installs its process/error handling on Bun.
  const { run } = await import("./tui")
  plugin({
    name: "vite-tui-entry",
    setup(build) {
      build.module("@opencode/tui", () => ({ loader: "object", exports: { run } }))
    },
  })
}
await import("../src/index")
