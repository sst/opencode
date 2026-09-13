import { expect, test } from "@playwright/test"
import { mockOpenCodeServer } from "../utils/mock-server"

test.use({ viewport: { width: 1280, height: 900 } })

for (const mode of ["failed", "stopped", "ready"] as const) {
  test(`manages a ${mode} configured WSL server from nested settings`, async ({ page }) => {
    await mockOpenCodeServer(page, {
      directory: "/repo",
      project: {
        id: "proj_wsl_settings",
        canonical: "/repo",
        name: "WSL project",
        sandboxes: [],
        time: { created: 1, updated: 1 },
      },
      provider: { all: [], connected: [], default: {} },
      sessions: [],
      pageMessages: () => ({ items: [] }),
    })
    const server = `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`
    await page.goto(`/e2e/utils/settings-wsl.html?${new URLSearchParams({ server, mode })}`)
    const settings = page.getByTestId("settings-screen")
    await expect(settings.getByRole("tab", { name: "Local Server", exact: true })).toBeEnabled()
    const ubuntu = settings.getByRole("tab", { name: "Ubuntu", exact: true })
    await expect(ubuntu).toHaveCount(1)
    await ubuntu.click()
    await expect(settings.getByRole("heading", { name: "Ubuntu", exact: true })).toBeVisible()
    const connection = settings.locator('[data-component="settings-server-connection"]')

    if (mode !== "ready") {
      await expect(settings.getByRole("tab", { name: "Projects", exact: true })).toBeDisabled()
      await connection.getByRole("button", { name: "More options", exact: true }).click()
      await page.getByRole("menuitem", { name: "Retry start", exact: true }).click()
      await expect(page.getByLabel("WSL actions")).toHaveText("start:wsl:Ubuntu")
    }
    await expect(settings.getByRole("tab", { name: "Projects", exact: true })).toBeEnabled()
    await connection.getByRole("button", { name: "Update OpenCode", exact: true }).click()
    await expect(page.getByLabel("WSL actions")).toContainText("update:Ubuntu")
    await expect(connection.getByRole("button", { name: "Update OpenCode", exact: true })).toHaveCount(0)

    await connection.getByRole("button", { name: "More options", exact: true }).click()
    await page.getByRole("menuitem", { name: "Remove", exact: true }).click()
    await expect(page.getByLabel("WSL actions")).toContainText("remove:wsl:Ubuntu")
    await expect(settings.getByRole("tab", { name: "Ubuntu", exact: true })).toHaveCount(0)
    await expect(settings.getByRole("tab", { name: "Server", exact: true })).toBeEnabled()
  })
}
