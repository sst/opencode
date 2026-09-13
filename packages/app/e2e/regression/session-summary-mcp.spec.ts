import { expect, test } from "@playwright/test"
import { fixture } from "../performance/timeline/session-timeline-stress.fixture"
import { mockStressTimeline, stressSessionHref } from "../performance/timeline/timeline-test-helpers"

test("every MCP row hit area toggles exactly once and keeps the submenu open", async ({ page }, testInfo) => {
  await mockStressTimeline(page)
  const state = { enabled: true }
  const writes: string[] = []
  await page.route("**/api/mcp**", (route) => {
    if (route.request().method() === "OPTIONS") return route.fallback()
    const url = new URL(route.request().url())
    const directory = url.searchParams.get("location[directory]")
    if (route.request().method() === "POST") {
      expect(directory).toBe(fixture.directory)
      writes.push(url.pathname)
      state.enabled = url.pathname.endsWith("/connect")
      return route.fulfill({ status: 204 })
    }
    return route.fulfill({
      json: {
        location: { directory: fixture.directory },
        data:
          url.pathname === "/api/mcp/resource"
            ? { resources: [], templates: [] }
            : [
                { name: "figma", status: { status: state.enabled ? "connected" : "disabled" } },
                { name: "linear", status: { status: "needs_auth" }, integrationID: "linear-oauth" },
                { name: "playwright", status: { status: "failed", error: "Connection refused" } },
                { name: "waiting", status: { status: "pending" } },
              ],
      },
    })
  })
  await page.goto(stressSessionHref(fixture.targetID))
  await page.getByRole("button", { name: "Session details", exact: true }).click()
  await page.getByRole("button", { name: "MCP", exact: true }).click()
  const submenu = page.getByRole("dialog", { name: "MCP", exact: true })
  const toggle = submenu.getByRole("switch", { name: "figma", exact: true })
  const row = submenu
    .locator('[data-component="switch"]')
    .filter({ has: page.getByRole("switch", { name: "figma", exact: true }) })
  await expect(toggle).toBeChecked()
  await expect(submenu.getByRole("switch", { name: "playwright", exact: true })).toBeChecked()
  await expect(submenu.getByRole("switch", { name: "playwright", exact: true })).toHaveAccessibleDescription("Failed")
  await expect(submenu.getByRole("switch", { name: "waiting", exact: true })).toBeDisabled()
  await expect(submenu.getByRole("switch", { name: "waiting", exact: true })).toHaveAccessibleDescription("Connecting…")
  await expect(submenu.getByRole("switch", { name: "linear", exact: true })).toHaveAccessibleDescription(
    "Sign in required",
  )
  await testInfo.attach("summary-mcp-states", { body: await page.screenshot(), contentType: "image/png" })

  for (const [index, target] of ["label", "dot", "padding", "control", "keyboard"].entries()) {
    const enabled = index % 2 !== 0
    await expect(toggle).toBeEnabled()
    if (target === "label") await row.getByText("figma", { exact: true }).click()
    if (target === "dot") await row.locator(".session-service-dot").click()
    if (target === "padding") await row.click({ position: { x: 3, y: 3 } })
    if (target === "control") await row.locator('[data-slot="switch-control"]').click()
    if (target === "keyboard") await toggle.press("Space")
    await expect(toggle).toBeChecked({ checked: enabled })
    await expect(toggle).toBeEnabled()
    await expect(submenu).toBeVisible()
    if (target === "keyboard") await expect(toggle).toBeFocused()
    expect(writes).toHaveLength(index + 1)
    expect(writes[index]).toBe(`/api/mcp/figma/${enabled ? "connect" : "disconnect"}`)
  }
})

test("MCP authentication starts before a slow resource catalog finishes", async ({ page, context }) => {
  await mockStressTimeline(page)
  const state = { status: "disabled" }
  const attempts: string[] = []
  const resources = Promise.withResolvers<void>()
  await context.route("https://auth.example.test/**", (route) => route.fulfill({ body: "Sign in" }))
  await page.route("**/api/mcp**", async (route) => {
    if (route.request().method() === "OPTIONS") return route.fallback()
    const url = new URL(route.request().url())
    if (url.pathname.endsWith("/connect")) {
      state.status = "needs_auth"
      return route.fulfill({ status: 204 })
    }
    if (url.pathname === "/api/mcp/resource" && state.status === "needs_auth") await resources.promise
    return route.fulfill({
      json: {
        location: { directory: fixture.directory },
        data:
          url.pathname === "/api/mcp/resource"
            ? { resources: [], templates: [] }
            : [{ name: "linear", integrationID: "linear-oauth", status: { status: state.status } }],
      },
    })
  })
  await page.route("**/api/integration/**", (route) => {
    if (route.request().method() === "OPTIONS") return route.fallback()
    if (route.request().method() === "POST") {
      attempts.push(route.request().url())
      return route.fulfill({
        json: { location: { directory: fixture.directory }, data: { url: "https://auth.example.test/authorize" } },
      })
    }
    return route.fulfill({
      json: {
        location: { directory: fixture.directory },
        data: {
          id: "linear-oauth",
          methods: [{ id: "oauth", type: "oauth" }],
        },
      },
    })
  })
  await page.goto(stressSessionHref(fixture.targetID))
  await page.getByRole("button", { name: "Session details", exact: true }).click()
  await page.getByRole("button", { name: "MCP", exact: true }).click()
  const submenu = page.getByRole("dialog", { name: "MCP", exact: true })
  const toggle = submenu.getByRole("switch", { name: "linear", exact: true })
  await expect(toggle).toBeEnabled()
  const refresh = page.waitForRequest(
    (request) =>
      state.status === "needs_auth" &&
      new URL(request.url()).pathname === "/api/mcp/resource" &&
      request.method() === "GET",
  )
  try {
    const popup = page.waitForEvent("popup")
    await submenu.getByText("linear", { exact: true }).click()
    await expect(await popup).toHaveURL("https://auth.example.test/authorize")
    await refresh
    await expect(toggle).toBeChecked()
    await expect(toggle).toHaveAccessibleDescription("Sign in required")
  } finally {
    resources.resolve()
  }
  await expect(toggle).toBeEnabled()
  expect(attempts).toHaveLength(1)
  expect(new URL(attempts[0]).searchParams.get("location[directory]")).toBe(fixture.directory)
})

test("multiple desktop connections show the session's server name", async ({ page }) => {
  await mockStressTimeline(page)
  await page.route("http://secondary.test/**", (route) => route.fulfill({ json: { healthy: true, version: "2.0.0" } }))
  await page.addInitScript(
    ({ directory, server }) => {
      const current = { type: "http", http: { url: server }, displayName: "Design server" }
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({
          list: [current, { type: "http", http: { url: "http://secondary.test" }, displayName: "Other server" }],
          projects: { local: [{ worktree: directory, expanded: true }] },
          hidden: {},
          lastProject: {},
          recentlyClosed: {},
        }),
      )
    },
    {
      directory: fixture.directory,
      server: `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`,
    },
  )
  await page.goto(stressSessionHref(fixture.targetID))
  await page.getByRole("button", { name: "Session details", exact: true }).click()
  const summary = page.getByRole("dialog", { name: "Session details", exact: true })
  await expect(summary.getByRole("button", { name: "Design server", exact: true })).toHaveAttribute(
    "aria-expanded",
    "true",
  )
  await expect(summary.getByRole("button", { name: "Extensions", exact: true })).toHaveCount(0)
})
