import { expect, test } from "@playwright/test"
import { fixture } from "../performance/timeline/session-timeline-stress.fixture"
import { mockStressTimeline, stressSessionHref } from "../performance/timeline/timeline-test-helpers"

const services = [
  { name: "MCP", path: "/api/mcp", empty: "No MCP servers configured", item: "summary-mcp" },
  { name: "Plugins", path: "/api/plugin", empty: "No plugins configured", item: "summary-plugin" },
  { name: "Skills", path: "/api/skill", empty: "No skills configured", item: "summary-skill" },
  { name: "LSP", path: "/api/config", empty: "No LSP servers configured", item: "summary-lsp" },
] as const

for (const service of services) {
  for (const empty of [false, true]) {
    test(`${service.name} keeps ${empty ? "its empty state" : "cached items"} visible while reopening and refreshing`, async ({
      page,
    }, testInfo) => {
      await mockStressTimeline(page)
      const warnings: string[] = []
      page.on("console", (event) => {
        if (event.text().includes("computations created outside")) warnings.push(event.text())
      })
      const state = { hold: false }
      const response = Promise.withResolvers<void>()
      await page.route(
        (url) => url.pathname === service.path,
        async (route) => {
          if (route.request().method() === "OPTIONS") return route.fallback()
          if (state.hold) await response.promise
          if (service.name === "LSP")
            return route.fulfill({
              json: empty ? [] : [{ type: "document", info: { lsp: { "summary-lsp": { command: ["summary-lsp"] } } } }],
            })
          const items =
            service.name === "MCP"
              ? [{ name: service.item, status: { status: "connected" } }]
              : service.name === "Plugins"
                ? [
                    {
                      id: service.item,
                      source: { type: "package", target: service.item },
                      features: {},
                      state: { status: "active" },
                    },
                  ]
                : [{ id: service.item, name: service.item, location: "/skills/summary/SKILL.md", content: "Summary" }]
          return route.fulfill({ json: { location: { directory: fixture.directory }, data: empty ? [] : items } })
        },
      )

      await page.goto(stressSessionHref(fixture.targetID))
      await page.getByRole("button", { name: "Session details", exact: true }).click()
      const summary = page.getByRole("dialog", { name: "Session details", exact: true })
      const trigger = summary.getByRole("button", { name: service.name, exact: true })
      await trigger.click()
      const menu = page.getByRole("dialog", { name: service.name, exact: true })
      const content = menu.getByText(empty ? service.empty : service.item, { exact: true })
      await expect(content).toBeVisible()
      await expect(menu).toHaveAttribute("aria-busy", "false")
      await expect(menu).toHaveCSS("width", empty ? "232px" : "280px")
      if (empty) {
        const message = menu.locator(".session-service-empty")
        await expect(message).toHaveCSS("padding", "0px")
        await expect(message).toHaveCSS("gap", "0px")
        await expect(message.locator("strong")).toHaveCSS("padding", "8px 12px")
        await expect(message).toHaveCSS("font-size", "13px")
        await expect(message).toHaveCSS("line-height", "16px")
        await expect(message.locator("strong")).toHaveCSS("font-weight", "530")
        await expect(message.locator(".session-service-footer")).toHaveCSS("font-weight", "440")
        await testInfo.attach(`${service.name}-empty`, { body: await menu.screenshot(), contentType: "image/png" })
      }
      await page.keyboard.press("Escape")
      await expect(menu).toBeHidden()
      state.hold = true
      const refresh = page.waitForRequest(
        (request) => request.method() === "GET" && new URL(request.url()).pathname === service.path,
      )
      try {
        await trigger.click()
        await refresh
        await expect(menu).toHaveAttribute("aria-busy", "true")
        await expect(content).toBeVisible()
        await expect(menu.getByRole("status")).toHaveCount(0)
        await expect(menu).toHaveCSS("width", empty ? "232px" : "280px")
        await expect(summary).toBeVisible()
      } finally {
        response.resolve()
      }
      await expect(menu).toHaveAttribute("aria-busy", "false")
      await expect(content).toBeVisible()
      expect(warnings).toEqual([])
    })
  }
}

test("prefetching plugins does not suspend the summary or report an empty catalog", async ({ page }) => {
  await mockStressTimeline(page)
  const response = Promise.withResolvers<void>()
  const state = { requested: false }
  await page.route(
    (url) => url.pathname === "/api/plugin",
    async (route) => {
      if (route.request().method() === "OPTIONS") return route.fallback()
      state.requested = true
      await response.promise
      return route.fulfill({ json: { location: { directory: fixture.directory }, data: [] } })
    },
  )
  await page.goto(stressSessionHref(fixture.targetID))
  await page.getByRole("button", { name: "Session details", exact: true }).click()
  const summary = page.getByRole("dialog", { name: "Session details", exact: true })
  try {
    await expect.poll(() => state.requested).toBe(true)
    await expect(summary.getByRole("button", { name: fixture.project.name, exact: true })).toBeVisible()
    await expect(summary.getByRole("button", { name: "Extensions", exact: true })).toBeVisible()
    await summary.getByRole("button", { name: "Plugins", exact: true }).click()
    const menu = page.getByRole("dialog", { name: "Plugins", exact: true })
    await expect(menu.getByRole("status")).toContainText("Loading")
    await expect(menu.getByText("No plugins configured", { exact: true })).toHaveCount(0)
    await expect(summary).toBeVisible()
  } finally {
    response.resolve()
  }
  await expect(
    page.getByRole("dialog", { name: "Plugins", exact: true }).getByText("No plugins configured", { exact: true }),
  ).toBeVisible()
})
