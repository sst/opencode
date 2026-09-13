import { expect, test } from "@playwright/test"
import { fixture, pageMessages } from "../performance/timeline/session-timeline-stress.fixture"
import { installStressSessionTabs, stressSessionHref } from "../performance/timeline/timeline-test-helpers"
import { mockOpenCodeServer } from "../utils/mock-server"

for (const position of ["top", "bottom"] as const) {
  test(`mobile session tabs switch views and keep the terminal cached with ${position} navigation`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await mockOpenCodeServer(page, {
      directory: fixture.directory,
      project: fixture.project,
      sessions: fixture.sessions,
      provider: fixture.provider,
      pageMessages,
      fileList: () => [],
    })
    await installStressSessionTabs(page)
    await page.addInitScript(
      (position) =>
        localStorage.setItem("settings.v3", JSON.stringify({ general: { mobileTitlebarPosition: position } })),
      position,
    )
    await page.route("**/api/pty*", (route) =>
      route.fulfill({
        json: {
          location: { directory: fixture.directory, project: { id: fixture.project.id, directory: fixture.directory } },
          data: {
            id: "pty_mobile_views",
            title: "Terminal 1",
            command: "sh",
            args: [],
            cwd: fixture.directory,
            status: "running",
            pid: 1,
          },
        },
      }),
    )
    await page.routeWebSocket("**/api/pty/pty_mobile_views/connect", () => undefined)
    await page.route("**/api/pty/pty_mobile_views/connect-token*", (route) =>
      route.fulfill({
        json: {
          location: { directory: fixture.directory, project: { id: fixture.project.id, directory: fixture.directory } },
          data: { ticket: "e2e-ticket", expires_in: 60 },
        },
      }),
    )
    await page.goto(stressSessionHref(fixture.targetID))

    const tabs = page.getByRole("tablist", { name: "Session view", exact: true })
    const navigation = page.locator('[data-slot="session-mobile-view-navigation"]')
    const more = navigation.getByRole("button", { name: "More options", exact: true })
    const picker = tabs.getByRole("tab", { selected: true })
    const message = page.locator(
      `[data-timeline-row="UserMessage"][data-message-id="${fixture.expected.targetMessageIDs.at(-1)}"]`,
    )
    const composer = page.getByRole("textbox", { name: "Prompt", exact: true })
    await expect(picker).toHaveText("Session")
    await expect(message).toBeVisible()
    await expect(composer).toBeVisible()
    await expect(tabs.getByRole("tab")).toHaveText(["Session", "Changes", "Files", "Terminal"])
    await expect(tabs).toHaveCSS("padding-left", "0px")
    await expect(tabs).toHaveCSS("padding-right", "0px")
    await expect
      .poll(async () => {
        const bounds = await navigation.boundingBox()
        return !!bounds && bounds.x >= 8 && bounds.x <= 9 && bounds.width >= 372 && bounds.width <= 374
      })
      .toBe(true)
    await expect
      .poll(async () => {
        const bar = await tabs.boundingBox()
        const input = await composer.boundingBox()
        const panel = await page.locator('[data-slot="session-chat-panel"]').boundingBox()
        return !!bar && !!input && !!panel && Math.abs(bar.y - panel.y) <= 1 && bar.y + bar.height <= input.y
      })
      .toBe(true)
    await expect(page.locator("[data-session-title]")).toHaveCount(0)
    await expect(page.locator('[data-slot="mobile-tabs-trigger"]')).toContainText(fixture.expected.targetTitle)
    await page.getByRole("button", { name: "Tabs", exact: true }).click()
    const drawer = page.getByRole("dialog", { name: "Tabs", exact: true })
    await expect(drawer).toHaveAttribute("data-open", "")
    await expect(drawer).not.toHaveAttribute("data-transitioning")
    await expect(drawer.getByRole("button", { name: "Settings", exact: true })).toBeInViewport()
    await drawer.getByRole("button", { name: "Settings", exact: true }).click()
    await expect(page.getByTestId("settings-screen")).toBeVisible()
    await page.getByRole("button", { name: "Back to app", exact: true }).click()
    await page.getByRole("button", { name: "Tabs", exact: true }).click()
    await expect(drawer).not.toHaveAttribute("data-transitioning")
    await expect(drawer.getByRole("button", { name: "Settings", exact: true })).toBeInViewport()
    await page.keyboard.press("Escape")
    await expect(drawer).toBeHidden()

    await more.click()
    await page.getByRole("menuitem", { name: "Usage", exact: true }).click()
    await expect(picker).toHaveCount(0)
    await expect(page.getByText("Total Cost", { exact: true })).toBeVisible()
    const usage = page.locator('[data-slot="session-usage-content"]')
    await expect(usage).toHaveCSS("padding-top", "16px")
    await expect(usage).toHaveCSS("padding-inline-start", "16px")
    await expect(usage).toHaveCSS("padding-inline-end", "16px")
    await expect(composer).toBeHidden()

    await more.click()
    await expect(page.getByRole("menuitem", { name: "Status", exact: true })).toHaveCount(0)
    await page.getByRole("menuitem", { name: "Session details", exact: true }).click()
    const details = page.getByRole("dialog", { name: "Session details", exact: true })
    await expect(details.getByText(fixture.project.name, { exact: true })).toBeVisible()
    await expect(details.getByRole("button", { name: "No changes", exact: true })).toBeVisible()
    await expect(details.getByRole("button", { name: "MCP", exact: true })).toBeVisible()
    await details.getByRole("button", { name: "Close", exact: true }).click()
    await expect(details).toBeHidden()
    await expect(more).toBeFocused()
    await more.click()
    await page.getByRole("menuitem", { name: "Session details", exact: true }).click()
    await expect(details.getByRole("button", { name: "No changes", exact: true })).toBeVisible()
    await expect(details).not.toHaveAttribute("data-transitioning")
    await page.keyboard.press("Escape")
    await expect(details).toBeHidden()
    await expect(more).toBeFocused()
    await more.click()
    await page.getByRole("menuitem", { name: "Session details", exact: true }).click()
    await details.getByRole("button", { name: "No changes", exact: true }).click()
    await expect(details).toBeHidden()
    await expect(picker).toHaveText("Changes")
    await expect(page.getByText("No uncommitted changes yet", { exact: true })).toBeVisible()
    await expect(page.locator('[data-slot="session-review-header"]')).toHaveCSS("height", "40px")
    await expect(page.locator('[data-slot="session-review-header"]')).toHaveCSS("padding-left", "8px")
    await expect(composer).toBeHidden()

    await tabs.getByRole("tab", { name: "Files", exact: true }).click()
    await expect(picker).toHaveText("Files")
    await expect(page.getByRole("combobox", { name: "Filter files", exact: true })).toBeVisible()
    await expect(composer).toBeHidden()

    await tabs.getByRole("tab", { name: "Terminal", exact: true }).click()
    const panel = page.locator("#terminal-panel")
    await expect(panel).toHaveAttribute("data-opened", "true")
    await expect(panel.getByRole("tab", { name: /Terminal 1/ })).toBeVisible()
    await expect(panel.locator('[data-component="terminal"]')).toBeVisible()
    await expect(panel.locator("textarea")).toBeEditable()
    await expect(panel).toHaveCount(1)
    await panel.evaluate((element) => element.setAttribute("data-cache-probe", "original"))
    await expect(composer).toBeHidden()

    await tabs.getByRole("tab", { name: "Session", exact: true }).click()
    await expect(message).toBeVisible()
    await expect(panel).toBeHidden()
    await expect(panel).toHaveAttribute("inert", "")
    await expect(panel).toHaveAttribute("data-cache-probe", "original")

    await page.keyboard.press("Control+Backquote")
    await expect(picker).toHaveText("Terminal")
    await expect(panel).toBeVisible()
    await expect(panel).toHaveAttribute("data-cache-probe", "original")
    await page.keyboard.press("Control+Backquote")
    await expect(picker).toHaveText("Session")

    await page.keyboard.press("Control+Backquote")
    await expect(picker).toHaveText("Terminal")
    await panel.getByRole("button", { name: "Close terminal", exact: true }).click()
    await expect(picker).toHaveText("Session")
    await expect(panel).toBeHidden()

    await more.click()
    await page.getByRole("menuitem", { name: "Usage", exact: true }).click()
    await expect(page.getByText("Total Cost", { exact: true })).toBeVisible()
    await page.goto(stressSessionHref(fixture.sourceID))
    await expect(picker).toHaveText("Session")
    await expect(page.locator('[data-slot="mobile-tabs-trigger"]')).toContainText(fixture.expected.sourceTitle)

    await page.setViewportSize({ width: 1280, height: 900 })
    await expect(picker).toBeHidden()
    await expect(page.locator("[data-session-title]")).toBeVisible()
  })
}
