import { base64Encode } from "@opencode/util/encode"
import { expect, test } from "@playwright/test"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectSessionTitle } from "../utils/waits"

const directory = "C:\\OpenCode\\main"
const workspace = "C:\\OpenCode\\worktree"
const projectID = "proj_mcp_workspace"
const sessionID = "ses_mcp_workspace"
const title = "Workspace MCP routing"
const server = `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`

for (const shared of [true, false]) {
  test(`toggles the workspace MCP when the default location ${shared ? "has" : "does not have"} the server`, async ({
    page,
  }, testInfo) => {
    const connected = new Set<string>()
    const requests: { path: string; directory: string }[] = []
    await mockOpenCodeServer(page, {
      directory,
      project: {
        id: projectID,
        worktree: directory,
        vcs: "git",
        name: "mcp-workspace",
        time: { created: 1700000000000, updated: 1700000000000 },
        sandboxes: [workspace],
      },
      provider: { all: [], connected: [], default: {} },
      sessions: [{ id: sessionID, projectID, directory: workspace, title }],
      pageMessages: () => ({ items: [] }),
    })
    await page.route("**/api/mcp**", async (route) => {
      if (route.request().method() === "OPTIONS") return route.fallback()
      const url = new URL(route.request().url())
      const target = url.searchParams.get("location[directory]") ?? directory
      requests.push({ path: url.pathname, directory: target })
      if (url.pathname === "/api/mcp/figma-desktop/connect") {
        connected.add(target)
        return route.fulfill({ status: 204 })
      }
      if (url.pathname === "/api/mcp/figma-desktop/disconnect") {
        connected.delete(target)
        return route.fulfill({ status: 204 })
      }
      return route.fulfill({
        json: {
          location: { directory: target },
          data:
            url.pathname === "/api/mcp/resource"
              ? { resources: [], templates: [] }
              : !shared && target !== workspace
                ? []
                : [{ name: "figma-desktop", status: { status: connected.has(target) ? "connected" : "disabled" } }],
        },
      })
    })

    await page.goto(`/server/${base64Encode(server)}/session/${sessionID}`)
    await expectSessionTitle(page, title)
    await expect(page.getByRole("textbox", { name: "Prompt", exact: true })).toBeEditable()
    await page.getByRole("button", { name: "Session details", exact: true }).click()
    await page.getByRole("button", { name: "MCP", exact: true }).click()
    const dialog = page.getByRole("dialog", { name: "MCP", exact: true })
    await expect(dialog.getByText("figma-desktop", { exact: true })).toBeVisible()
    const toggle = dialog.getByRole("switch")
    await expect(toggle).not.toBeChecked()
    await expect(toggle).toBeEnabled()
    requests.length = 0

    await dialog.locator('[data-slot="switch-control"]').click()
    await expect(toggle).toBeChecked()
    await expect(toggle).toBeEnabled()
    expect(connected).toEqual(new Set([workspace]))
    expect(requests).toContainEqual({ path: "/api/mcp/figma-desktop/connect", directory: workspace })
    expect(requests).toContainEqual({ path: "/api/mcp/resource", directory: workspace })
    expect(requests.every((request) => request.directory === workspace)).toBe(true)
    await testInfo.attach("workspace-connected", { body: await page.screenshot(), contentType: "image/png" })

    requests.length = 0
    await dialog.getByText("figma-desktop", { exact: true }).click()
    await expect(toggle).not.toBeChecked()
    await expect(toggle).toBeEnabled()
    expect(connected.size).toBe(0)
    expect(requests).toContainEqual({ path: "/api/mcp/figma-desktop/disconnect", directory: workspace })
    expect(requests.every((request) => request.directory === workspace)).toBe(true)
  })
}

for (const surface of ["popover", "dialog"] as const) {
  test(`shows connection failures from the MCP ${surface} and allows reconnecting`, async ({ page }, testInfo) => {
    const error = "Streamable HTTP error: Error POSTing to endpoint: 404 Not Found"
    const state = { fail: true, status: surface === "popover" ? "failed" : "disabled" }
    const requests: { path: string; directory: string }[] = []
    await page.addInitScript(() => {
      localStorage.setItem("settings.v3", JSON.stringify({ keybinds: { "mcp.toggle": "ctrl+;" } }))
    })
    await mockOpenCodeServer(page, {
      directory,
      project: {
        id: projectID,
        worktree: directory,
        vcs: "git",
        name: "mcp-workspace",
        time: { created: 1700000000000, updated: 1700000000000 },
        sandboxes: [workspace],
      },
      provider: { all: [], connected: [], default: {} },
      sessions: [{ id: sessionID, projectID, directory: workspace, title }],
      pageMessages: () => ({ items: [] }),
    })
    await page.route("**/api/mcp**", async (route) => {
      if (route.request().method() === "OPTIONS") return route.fallback()
      const url = new URL(route.request().url())
      const target = url.searchParams.get("location[directory]") ?? directory
      requests.push({ path: url.pathname, directory: target })
      if (url.pathname === "/api/mcp/figma-desktop/disconnect") {
        state.status = "disabled"
        return route.fulfill({ status: 204 })
      }
      if (url.pathname === "/api/mcp/figma-desktop/connect") {
        state.status = state.fail ? "failed" : "connected"
        // Connection failures are reported by the refreshed status, not the HTTP response.
        return route.fulfill({ status: 204 })
      }
      return route.fulfill({
        json: {
          location: { directory: target },
          data:
            url.pathname === "/api/mcp/resource"
              ? { resources: [], templates: [] }
              : [
                  {
                    name: "figma-desktop",
                    status: { status: target === workspace ? state.status : "connected", error },
                  },
                ],
        },
      })
    })

    await page.goto(`/server/${base64Encode(server)}/session/${sessionID}`)
    await expectSessionTitle(page, title)
    await expect(page.getByRole("textbox", { name: "Prompt", exact: true })).toBeEditable()
    if (surface === "popover") {
      await page.getByRole("button", { name: "Session details", exact: true }).click()
      await page.getByRole("button", { name: "MCP", exact: true }).click()
    }
    if (surface === "dialog") await page.keyboard.press("Control+;")
    const panel = page.getByRole("dialog", { name: surface === "popover" ? "MCP" : "MCPs", exact: true })
    const toggle = panel.getByRole("switch")
    await expect(panel.getByText("figma-desktop", { exact: true })).toBeVisible()
    await expect(toggle).toBeEnabled()
    if (surface === "popover") {
      await expect(toggle).toBeChecked()
      await panel.getByText("figma-desktop", { exact: true }).click()
    }
    await expect(toggle).not.toBeChecked()
    await expect(toggle).toBeEnabled()
    requests.length = 0

    await panel.locator('[data-slot="switch-control"]').click()
    const toast = page
      .getByRole("listitem", { includeHidden: true })
      .filter({ has: page.getByText("Request failed", { exact: true }) })
    await expect(toast.getByText(`figma-desktop: ${error}`, { exact: true })).toBeVisible()
    await expect(toggle).toBeChecked({ checked: surface === "popover" })
    await expect(toggle).toBeEnabled()
    expect(requests.filter((request) => request.path.endsWith("/connect"))).toEqual([
      { path: "/api/mcp/figma-desktop/connect", directory: workspace },
    ])
    expect(requests.every((request) => request.directory === workspace)).toBe(true)
    await expect(toast).toHaveCSS("opacity", "1")
    await testInfo.attach("mcp-connection-error", { body: await page.screenshot(), contentType: "image/png" })

    if (surface === "popover") await page.keyboard.press("Escape")
    if (surface === "dialog") await panel.getByRole("button", { name: "Close", exact: true }).click()
    await expect(panel).toBeHidden()
    await toast.getByRole("button", { name: "Dismiss", exact: true }).click()
    await expect(toast).toBeHidden()
    state.fail = false
    if (surface === "popover") {
      await expect(page.getByRole("dialog", { name: "Session details", exact: true })).toBeHidden()
      await page.getByRole("button", { name: "Session details", exact: true }).click()
      await page.getByRole("button", { name: "MCP", exact: true }).click()
    }
    if (surface === "dialog") await page.keyboard.press("Control+;")
    await expect(toggle).toBeEnabled()
    if (surface === "popover") {
      await panel.getByText("figma-desktop", { exact: true }).click()
      await expect(toggle).not.toBeChecked()
      await expect(toggle).toBeEnabled()
    }
    await panel.locator('[data-slot="switch-control"]').click()
    await expect(toggle).toBeChecked()
    await expect(toggle).toBeEnabled()
    await expect(toast).toBeHidden()
  })
}
