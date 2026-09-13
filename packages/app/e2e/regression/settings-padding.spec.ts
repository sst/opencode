import { expect, test } from "@playwright/test"
import { mockOpenCodeServer } from "../utils/mock-server"

const directory = "/tmp/settings-padding"

test.beforeEach(async ({ page }) => {
  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: "proj_settings_padding",
      canonical: directory,
      name: "Settings padding",
      vcs: "git",
      time: { created: 1700000000000, updated: 1700000000000 },
    },
    provider: { all: [], connected: [], default: {} },
    sessions: [],
    pageMessages: () => ({ items: [] }),
  })
  await page.route("https://api.github.com/repos/anomalyco/opencode/contributors?*", (route) =>
    route.fulfill({ json: [] }),
  )
  await page.goto("/")
  await page.getByRole("button", { name: "Settings", exact: true }).click()
  await expect(page.getByTestId("settings-screen")).toBeFocused()
})

for (const viewport of [
  { width: 1280, height: 720, bottom: false },
  { width: 900, height: 600, bottom: false },
  { width: 780, height: 600, bottom: false },
  { width: 390, height: 844, bottom: false },
  { width: 390, height: 844, bottom: true },
]) {
  test.describe(`${viewport.width}px, ${viewport.bottom ? "bottom" : "top"} navigation`, () => {
    test.use({ viewport: { width: 1280, height: 720 }, contextOptions: { reducedMotion: "reduce" } })

    test("every settings page leaves room below its final content", async ({ page }) => {
      await page.setViewportSize(viewport)
      const settings = page.getByTestId("settings-screen")
      const panel = settings.locator(".settings-content > .settings-panel:visible")
      if (viewport.bottom) {
        const toggle = settings.locator('[data-action="settings-mobile-titlebar-bottom"]')
        await toggle.locator('[data-slot="switch-control"]').click()
        await expect(toggle.getByRole("switch")).toBeChecked()
      }
      let current = "Preferences"
      for (const name of [
        "Preferences",
        "Appearance",
        "Notifications",
        "Shortcuts",
        "Projects",
        "Worktrees",
        "Providers",
        "Models",
        "Extensions",
        "Server",
        "Experimental",
        "About",
      ]) {
        if (viewport.width >= 816) await settings.getByRole("tab", { name, exact: true }).click()
        if (viewport.width < 816) {
          await settings.getByRole("button", { name: current, exact: true }).click()
          await page.getByRole("menuitemradio", { name, exact: true }).click()
        }
        current = name
        if (name === "About") await expect(panel.getByText("Released under the MIT License")).toBeVisible()
        if (name !== "About") {
          await expect(
            panel.getByRole("heading", { name: name === "Shortcuts" ? "Keyboard shortcuts" : name, exact: true }),
          ).toBeVisible()
        }
        await panel.hover()
        await page.mouse.wheel(0, 10000)
        await expect
          .poll(() => panel.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop))
          .toBeLessThanOrEqual(1)
        await expect
          .poll(
            () =>
              panel.evaluate((el) => {
                const body = el.querySelector(".settings-tab-body, .settings-about-content")!
                return el.getBoundingClientRect().bottom - body.lastElementChild!.getBoundingClientRect().bottom
              }),
            { message: `${name} bottom clearance` },
          )
          .toBeGreaterThanOrEqual(viewport.bottom ? 119.5 : 79.5)
        await expect
          .poll(() => page.getByRole("main").evaluate((el) => el.scrollWidth - el.clientWidth))
          .toBeLessThanOrEqual(1)
      }
    })
  })
}
