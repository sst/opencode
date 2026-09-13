import { expect, test, type Page } from "@playwright/test"
import { base64Encode } from "@opencode/util/encode"
import { fixture, pageMessages } from "../performance/timeline/session-timeline-stress.fixture"
import { mockOpenCodeServer } from "../utils/mock-server"

const server = "http://summary-remote.test:4096"
const path = "/home/remote/.config/opencode/opencode.jsonc"

test.use({ serviceWorkers: "block", permissions: ["clipboard-read", "clipboard-write"] })

for (const service of [
  { name: "MCP", config: { mcp: { servers: {} } } },
  { name: "Plugins", config: { plugins: [] } },
  { name: "Skills", config: { skills: [] } },
  { name: "LSP", config: { lsp: false } },
]) {
  test(`remote ${service.name} copies its configuration path with timeline copy feedback`, async ({ page }) => {
    await setup(page)
    await page.route("**/api/config**", (route) => {
      if (route.request().method() === "OPTIONS") return route.fallback()
      return route.fulfill({
        json: [
          { type: "document", path, info: service.config },
          { type: "document", path: `${fixture.directory}/opencode.json`, info: {} },
          { type: "document", path: `${fixture.directory}/.opencode/agents/review.md`, info: {} },
        ],
      })
    })
    await page.goto(`/server/${base64Encode(server)}/session/${fixture.targetID}`)
    await page.getByRole("button", { name: "Session details", exact: true }).click()
    await page
      .getByRole("dialog", { name: "Session details", exact: true })
      .getByRole("button", { name: service.name, exact: true })
      .click()
    const menu = page.getByRole("dialog", { name: service.name, exact: true })
    const copy = menu.getByRole("button", { name: "Copy configuration file path", exact: true })
    const tooltipOffset = async () => {
      const icon = await copy.locator("svg").boundingBox()
      const tooltip = await page.getByRole("tooltip").boundingBox()
      if (!icon || !tooltip) return Infinity
      return Math.abs(tooltip.x + tooltip.width / 2 - icon.x - icon.width / 2)
    }
    await expect(copy).toBeEnabled()
    await expect(copy.locator("svg use")).toHaveAttribute("href", "#opencode-v2-icon-outline-copy")
    await expect(copy.locator(".session-service-config-arrow")).toHaveCount(0)
    await copy.hover()
    await expect(page.getByRole("tooltip")).toHaveText("Copy")
    await expect.poll(tooltipOffset).toBeLessThanOrEqual(1)
    await copy.click()
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(path)
    await expect(page.getByRole("tooltip")).toHaveText("Copied")
    await expect.poll(tooltipOffset).toBeLessThanOrEqual(1)
    await expect(copy.locator("svg use")).toHaveAttribute("href", "#opencode-v2-icon-check")
    await expect(menu).toBeVisible()
    await expect(copy.locator("svg use")).toHaveAttribute("href", "#opencode-v2-icon-outline-copy")
  })
}

test("remote configuration without a file path reports the problem instead of copying a directory", async ({
  page,
}) => {
  await setup(page)
  await page.goto(`/server/${base64Encode(server)}/session/${fixture.targetID}`)
  await page.evaluate(() => navigator.clipboard.writeText("original clipboard"))
  await page.getByRole("button", { name: "Session details", exact: true }).click()
  await page
    .getByRole("dialog", { name: "Session details", exact: true })
    .getByRole("button", { name: "Skills", exact: true })
    .click()
  const copy = page
    .getByRole("dialog", { name: "Skills", exact: true })
    .getByRole("button", { name: "Copy configuration file path", exact: true })
  await copy.click()
  await expect(page.getByText("No configuration file found", { exact: true })).toBeVisible()
  await expect(copy).toBeEnabled()
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("original clipboard")
  await expect(copy.locator("svg use")).toHaveAttribute("href", "#opencode-v2-icon-outline-copy")
})

async function setup(page: Page) {
  await mockOpenCodeServer(page, {
    server,
    sessions: fixture.sessions,
    provider: fixture.provider,
    directory: fixture.directory,
    project: fixture.project,
    pageMessages,
  })
  await page.addInitScript((server) => {
    localStorage.setItem(
      "opencode.global.dat:server",
      JSON.stringify({
        list: [{ type: "http", http: { url: server }, displayName: "Remote server" }],
        projects: {},
        lastProject: {},
      }),
    )
  }, server)
}
