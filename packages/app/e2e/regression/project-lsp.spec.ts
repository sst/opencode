import { expect, test } from "@playwright/test"
import type { ConfigEntry } from "@opencode/client/promise"
import { mockOpenCodeServer } from "../utils/mock-server"

const directory = "/repo/configured-lsp"
const entries: ConfigEntry[] = [
  {
    type: "document",
    path: "/config/opencode.json",
    info: {
      lsp: {
        typescript: { command: ["typescript-language-server", "--stdio"], extensions: [".ts", ".tsx"] },
      },
    },
  },
  {
    type: "document",
    path: `${directory}/opencode.jsonc`,
    info: {
      lsp: {
        typescript: { disabled: true },
        rust: { command: ["rust-analyzer"], extensions: [".rs"] },
      },
    },
  },
]

test.use({ viewport: { width: 1280, height: 900 } })

test.beforeEach(async ({ page }) => {
  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: "proj_configured_lsp",
      canonical: directory,
      name: "Configured LSP project",
      sandboxes: [],
      time: { created: 1, updated: 1 },
    },
    provider: { all: [], connected: [], default: {} },
    sessions: [],
    pageMessages: () => ({ items: [] }),
  })
  await page.addInitScript((directory) => {
    localStorage.setItem(
      "opencode.global.dat:server",
      JSON.stringify({ projects: { local: [{ worktree: directory, expanded: true }] } }),
    )
  }, directory)
  await page.goto("/")
  await page.getByRole("button", { name: "Settings", exact: true }).click()
  const settings = page.getByTestId("settings-screen")
  await settings.getByRole("tab", { name: "Projects", exact: true }).click()
  await settings.getByRole("button", { name: "Configured LSP project", exact: true }).click()
  await settings.getByRole("tab", { name: "Extensions", exact: true }).click()
})

test("shows inherited and project-configured LSP entries with config-only status", async ({ page }) => {
  const ready = Promise.withResolvers<void>()
  await page.route(
    (url) => url.pathname === "/api/config",
    async (route) => {
      await ready.promise
      await route.fulfill({ json: entries })
    },
  )
  const requested = page.waitForRequest((request) => new URL(request.url()).pathname === "/api/config")
  const settings = page.getByTestId("settings-screen")
  await settings.getByRole("tab", { name: "LSPs", exact: true }).click()
  expect(new URL((await requested).url()).searchParams.get("location[directory]")).toBe(directory)
  const panel = settings.getByRole("tabpanel", { name: "LSPs", exact: true })
  await expect(panel.getByText("Loading", { exact: true })).toBeVisible()
  ready.resolve()
  await expect(panel.getByText("typescript", { exact: true })).toBeVisible()
  await expect(panel.getByText("rust", { exact: true })).toBeVisible()
  const typescript = panel.locator(".project-settings-extension-row").filter({ hasText: "typescript" })
  await expect(typescript).toContainText("Disabled in config")
  await expect(typescript).toContainText(".ts, .tsx")
  await expect(panel.locator(".project-settings-extension-row").filter({ hasText: "rust" })).toContainText(
    "Enabled in config",
  )
  await expect(panel.getByRole("switch")).toHaveCount(0)
  await expect(panel.getByText("Setup required", { exact: true })).toHaveCount(0)
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(panel.getByText("rust", { exact: true })).toBeInViewport()
  await expect
    .poll(() => settings.evaluate((element) => element.scrollWidth - element.clientWidth))
    .toBeLessThanOrEqual(1)
})

for (const lsp of [true, false]) {
  test(`handles boolean lsp=${lsp} without inventing detected servers`, async ({ page }) => {
    await page.route(
      (url) => url.pathname === "/api/config",
      (route) =>
        route.fulfill({
          json: [{ type: "document", info: { lsp } }],
        }),
    )
    const settings = page.getByTestId("settings-screen")
    await settings.getByRole("tab", { name: "LSPs", exact: true }).click()
    const panel = settings.getByRole("tabpanel", { name: "LSPs", exact: true })
    await expect(
      panel.getByText(lsp ? "No language servers configured" : "Language servers disabled", { exact: true }),
    ).toBeVisible()
    await expect(panel.locator(".project-settings-extension-row")).toHaveCount(0)
  })
}

test("keeps configuration load failures inside the tab and allows retry", async ({ page }) => {
  const state = { fail: true }
  await page.route(
    (url) => url.pathname === "/api/config",
    (route) =>
      route.fulfill({
        status: state.fail ? 404 : 200,
        json: state.fail ? {} : entries,
      }),
  )
  const settings = page.getByTestId("settings-screen")
  await settings.getByRole("tab", { name: "LSPs", exact: true }).click()
  const panel = settings.getByRole("tabpanel", { name: "LSPs", exact: true })
  await expect(panel.getByText("Could not load language server configuration", { exact: true })).toBeVisible()
  state.fail = false
  await panel.getByRole("button", { name: "Retry", exact: true }).click()
  await expect(panel.getByText("typescript", { exact: true })).toBeVisible()
  await settings.getByRole("tab", { name: "Skills", exact: true }).click()
  await expect(settings.getByRole("tabpanel", { name: "Skills", exact: true })).toBeVisible()
})
