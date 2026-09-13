import { expect, test } from "@playwright/test"
import { fixture, pageMessages } from "../smoke/session-timeline.fixture"
import { mockOpenCodeServer } from "../utils/mock-server"

test("loads home and the directory picker without newer browser APIs", async ({ page }) => {
  await mockOpenCodeServer(page, {
    sessions: fixture.sessions,
    provider: fixture.provider,
    directory: fixture.directory,
    project: fixture.project,
    pageMessages,
    fileList: () => [],
  })
  await page.addInitScript((directory) => {
    // Safari 16.6 has neither API. Remove them before the web entry runs.
    Reflect.deleteProperty(Map, "groupBy")
    Reflect.deleteProperty(Promise, "withResolvers")
    localStorage.setItem(
      "opencode.global.dat:server",
      JSON.stringify({
        projects: { local: [{ worktree: directory, expanded: true }] },
        lastProject: { local: directory },
      }),
    )
  }, fixture.directory)

  await page.goto("/")
  const row = page.locator('[data-component="home-session-row"]').filter({ hasText: fixture.expected.targetTitle })
  await expect(row).toBeVisible()

  await page.getByRole("button", { name: "Add project", exact: true }).click()
  const dialog = page.getByRole("dialog")
  await expect(dialog.getByRole("button", { name: "Select folder", exact: true })).toBeEnabled()
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click()
  await expect(dialog).toBeHidden()
  await expect(row).toBeVisible()
})
