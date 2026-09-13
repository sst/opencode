import { expect, test } from "@playwright/test"
import { mockOpenCodeServer } from "../utils/mock-server"

for (const colorScheme of ["light", "dark"] as const) {
  test.describe(colorScheme, () => {
    test.use({ colorScheme, contextOptions: { reducedMotion: "reduce" } })

    test("project card edges stay inside the settings scrollport", async ({ page }, info) => {
      const projects = ["rebase", "dinocms", "opencode", "Playground"].map((name, index) => ({
        id: `project-${index}`,
        name,
        canonical: `/projects/${name}`,
        vcs: "git",
        time: { created: 1, updated: 1 },
        sandboxes: [],
      }))
      await mockOpenCodeServer(page, {
        directory: "/projects/rebase",
        project: projects[0],
        sessions: [],
        pageMessages: () => ({ items: [] }),
        provider: { all: [], connected: [], default: {} },
      })
      await page.route("**/api/project", (route) =>
        route.fulfill({ json: projects, headers: { "access-control-allow-origin": "*" } }),
      )
      await page.addInitScript((projects) => {
        localStorage.setItem(
          "opencode.global.dat:server",
          JSON.stringify({
            projects: { local: projects.map((project) => ({ worktree: project.canonical, expanded: true })) },
          }),
        )
      }, projects)
      await page.goto("/")
      await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeEnabled()
      await page.getByRole("button", { name: "Settings", exact: true }).click()
      const settings = page.getByTestId("settings-screen")
      await settings.getByRole("tab", { name: "Projects", exact: true }).click()
      const panel = settings.getByRole("tabpanel")
      await expect(panel.getByText("rebase", { exact: true })).toBeVisible()
      await expect(panel.getByText("Playground", { exact: true })).toBeVisible()
      await page.evaluate(() => document.fonts.ready)

      for (const width of [1280, 1050, 960, 720, 600]) {
        await page.setViewportSize({ width, height: 720 })
        await page.mouse.move(0, 0)
        await page.screenshot({ path: info.outputPath(`projects-${width}.png`), animations: "disabled" })
        // Raised cards paint a half-pixel border outside their box. The scrollport
        // must leave room for that border and the soft shadow on both sides.
        await expect
          .poll(() =>
            panel.getByText("rebase", { exact: true }).evaluate((label) => {
              const row = label.parentElement!.parentElement!
              const bounds = row.getBoundingClientRect()
              const clips = []
              for (let parent = row.parentElement; parent; parent = parent.parentElement) {
                if (getComputedStyle(parent).overflowX === "visible") continue
                const clip = parent.getBoundingClientRect()
                clips.push(bounds.left - clip.left, clip.right - bounds.right)
              }
              return Math.min(...clips)
            }),
          )
          .toBeGreaterThanOrEqual(4)
        await expect(panel).toHaveJSProperty("scrollWidth", await panel.evaluate((el) => el.clientWidth))
      }

      await page.setViewportSize({ width: 1280, height: 720 })
      await panel.getByText("rebase", { exact: true }).hover()
      await panel.getByText("rebase", { exact: true }).click()
      await expect(settings.getByRole("textbox", { name: "Project name", exact: true })).toHaveValue("rebase")
      await settings.getByRole("button", { name: "Back to projects", exact: true }).click()
      await expect(panel.getByText("rebase", { exact: true })).toBeVisible()

      await page.setViewportSize({ width: 1280, height: 260 })
      await panel.getByText("rebase", { exact: true }).hover()
      await page.mouse.wheel(0, 400)
      await expect(panel.getByText("Playground", { exact: true })).toBeInViewport({ ratio: 1 })
      await expect(panel.getByRole("heading", { name: "Projects", exact: true })).toBeInViewport({ ratio: 1 })
    })
  })
}
