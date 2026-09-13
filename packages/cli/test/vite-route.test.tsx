/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { RouteProvider, useRoute, type Route } from "../dev/route"
import { host } from "../dev/host.js"
import { TuiStartupProvider } from "../../tui/src/context/runtime"

test("the dev route wrapper restores the current route without replaying its prompt", async () => {
  const saved = () => host.route
  let route!: ReturnType<typeof useRoute>
  function Probe() {
    route = useRoute()
    return null
  }
  async function render() {
    return testRender(
      () => (
        <TuiStartupProvider value={{ skipInitialLoading: true }}>
          <RouteProvider initialRoute={{ type: "session", sessionID: "ses_launch" }}>
            <Probe />
          </RouteProvider>
        </TuiStartupProvider>
      ),
      { width: 80, height: 24 },
    )
  }
  const routes: Route[] = [
    { type: "home", location: { directory: "/selected/worktree", workspaceID: "wrk_test" } },
    { type: "home", location: { directory: "/another/worktree", workspaceID: "wrk_other" } },
    { type: "session", sessionID: "ses_selected" },
    { type: "plugin", id: "test", name: "page", data: { nested: { selected: 1 } } },
    { type: "plugin", id: "test", name: "page", data: { nested: { selected: 2 } } },
  ]
  host.route = undefined
  const app = await render()
  try {
    await app.waitFor(() => host.route !== undefined)
    for (const value of routes) {
      route.navigate(
        value.type === "plugin"
          ? value
          : {
              ...value,
              prompt: { text: "one-shot handoff", files: [], agents: [], pasted: [] },
            },
      )
      await app.waitFor(() => JSON.stringify(host.route) === JSON.stringify(value))
      expect(saved()).toEqual(value)
      // Saved routes contain plain data, not a proxy tied to the old Solid tree.
      expect(structuredClone(saved())).toEqual(value)
    }
  } finally {
    app.renderer.destroy()
  }
  for (const value of routes) {
    host.route = value
    const restored = await render()
    try {
      expect(route.data).toEqual(value)
    } finally {
      restored.renderer.destroy()
    }
  }
  host.route = undefined
})
