import { expect, test } from "@playwright/test"
import { fixture, pageMessages } from "../performance/timeline/session-timeline-stress.fixture"
import { installStressSessionTabs, stressSessionHref } from "../performance/timeline/timeline-test-helpers"
import { mockOpenCodeServer } from "../utils/mock-server"

for (const direction of ["ltr", "rtl"] as const) {
  test(`session header groups controls and exposes session details in ${direction}`, async ({ page }) => {
    await mockOpenCodeServer(page, {
      directory: fixture.directory,
      project: fixture.project,
      sessions: fixture.sessions,
      provider: fixture.provider,
      pageMessages,
    })
    await installStressSessionTabs(page)
    await page.addInitScript(() => {
      const settings = JSON.parse(localStorage.getItem("settings.v3") ?? "{}")
      localStorage.setItem(
        "settings.v3",
        JSON.stringify({ ...settings, general: { ...settings.general, showStatus: true } }),
      )
    })
    await page.goto(stressSessionHref(fixture.targetID))
    const header = page.locator("[data-session-title]")
    const more = header.getByRole("button", { name: "More options", exact: true })
    const project = header.getByRole("button", { name: fixture.project.name, exact: true })
    const review = page.getByRole("button", { name: "Toggle review", exact: true })
    const details = header.getByRole("button", { name: "Session details", exact: true })
    await expect(header.getByRole("heading")).toHaveText(fixture.expected.targetTitle)
    await page.evaluate((direction) => document.documentElement.setAttribute("dir", direction), direction)
    await expect(review).toBeVisible()
    await expect(details).toBeVisible()
    const status = page.locator('[data-slot="titlebar-v2"]').getByRole("button", { name: "Status" })
    await expect(status).toHaveCount(0)
    const titleBounds = await header.getByRole("heading").boundingBox()
    expect(titleBounds).not.toBeNull()
    for (const editing of [false, true]) {
      if (editing) {
        await header.getByRole("heading").click()
        await expect(header.getByRole("textbox")).toHaveValue(fixture.expected.targetTitle)
        await expect(header.getByRole("textbox")).toBeFocused()
      }
      await expect(header.locator('[data-slot="session-title-child"]')).toHaveCSS("padding-left", "4px")
      await expect(header.locator('[data-slot="session-title-child"]')).toHaveCSS("padding-right", "4px")
      await expect
        .poll(async () => {
          const boxes = await Promise.all(
            [project, header.locator('[data-slot="session-title-child"]'), more, review, details].map((control) =>
              control.boundingBox(),
            ),
          )
          const [icon, title, menu, sidebar, summary] = boxes
          if (!icon || !title || !menu || !sidebar || !summary || !titleBounds) return false
          if (Math.abs(title.y - titleBounds.y) > 0.5 || Math.abs(title.height - titleBounds.height) > 0.5) return false
          return direction === "ltr"
            ? Math.abs(title.x - icon.x - icon.width - 2) <= 0.5 &&
                Math.abs(menu.x - title.x - title.width - 2) <= 0.5 &&
                menu.x + menu.width <= summary.x &&
                summary.x + summary.width <= sidebar.x
            : Math.abs(icon.x - title.x - title.width - 2) <= 0.5 &&
                Math.abs(title.x - menu.x - menu.width - 2) <= 0.5 &&
                sidebar.x + sidebar.width <= summary.x &&
                summary.x + summary.width <= menu.x
        })
        .toBe(true)
    }
    await header.getByRole("textbox").press("Escape")
    await expect(header.getByRole("heading")).toHaveText(fixture.expected.targetTitle)

    await review.click()
    await expect(review).toHaveAttribute("aria-expanded", "true")
    await expect(page.locator("#review-panel")).toBeVisible()
    await review.click()
    await expect(review).toHaveAttribute("aria-expanded", "false")

    await more.click()
    const options = page.getByRole("menu")
    await expect(options.getByRole("menuitem")).toHaveText(["Rename", "Export…", "Delete…"])
    if (direction === "ltr") {
      await expect
        .poll(async () => {
          const [button, menu] = await Promise.all([
            header.getByRole("button", { name: "More options", exact: true, includeHidden: true }).boundingBox(),
            options.boundingBox(),
          ])
          return button && menu ? Math.abs(button.x - menu.x) : Infinity
        })
        .toBeLessThanOrEqual(1)
    }
    await expect
      .poll(() =>
        options.evaluate((element) => {
          const menu = element.getBoundingClientRect()
          const rtl = getComputedStyle(element).direction === "rtl"
          return Math.min(
            ...Array.from(element.querySelectorAll('[data-slot="menu-v2-item-content"]'), (label) => {
              const range = document.createRange()
              range.selectNodeContents(label)
              const text = range.getBoundingClientRect()
              return rtl ? text.left - menu.left : menu.right - text.right
            }),
          )
        }),
      )
      .toBeCloseTo(32, 0)
    await expect
      .poll(() =>
        options.evaluate((element) => {
          const menu = element.getBoundingClientRect()
          const divider = element.querySelector('[data-slot="menu-v2-separator"]')?.getBoundingClientRect()
          const rows = Array.from(element.querySelectorAll('[role="menuitem"]'), (row) => row.getBoundingClientRect())
          return (
            !!divider &&
            Math.abs(divider.left - menu.left) <= 0.5 &&
            Math.abs(divider.right - menu.right) <= 0.5 &&
            rows.every(
              (row) => Math.abs(row.left - menu.left - 2) <= 0.5 && Math.abs(menu.right - row.right - 2) <= 0.5,
            )
          )
        }),
      )
      .toBe(true)
    await expect(page.getByRole("menuitem", { name: "Server status", exact: true })).toHaveCount(0)
    await page.keyboard.press("Escape")
    await details.click()
    const summary = page.getByRole("dialog", { name: "Session details", exact: true })
    const mcp = summary.getByRole("button", { name: "MCP", exact: true })
    await expect(mcp).toBeVisible()
    await expect(summary.getByRole("button", { name: "Plugins", exact: true })).toBeVisible()
    await page.keyboard.press("Escape")
    await expect(mcp).toBeHidden()
  })
}
