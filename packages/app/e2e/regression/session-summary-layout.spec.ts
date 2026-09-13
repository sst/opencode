import { expect, test } from "@playwright/test"
import { fixture } from "../performance/timeline/session-timeline-stress.fixture"
import { mockStressTimeline, stressSessionHref } from "../performance/timeline/timeline-test-helpers"
import { openWithDirection } from "../utils/direction"

for (const direction of ["ltr", "rtl"] as const) {
  test(`summary slides the conversation into spare space and back in ${direction}`, async ({ page }, testInfo) => {
    await page.clock.install({ time: new Date("2026-09-10T12:00:00Z") })
    await page.setViewportSize({ width: 1440, height: 900 })
    await mockStressTimeline(page)
    await openWithDirection(page, stressSessionHref(fixture.targetID), direction)
    const trigger = page.getByRole("button", { name: "Session details", exact: true })
    await expect(trigger).toBeEnabled()
    await expect(page.locator("html")).toHaveAttribute("dir", direction)
    await expect(page.locator("html")).toHaveAttribute("lang", "en")
    const row = page.locator(
      `[data-timeline-row="UserMessage"][data-message-id="${fixture.expected.targetMessageIDs.at(-1)}"]`,
    )
    const content = page.locator("[data-timeline-virtual-content]")
    const composer = page.locator('[data-component="session-composer-dock"] > div')
    const panel = page.locator('[data-slot="session-chat-panel"]')
    const summary = page.getByRole("dialog", { name: "Session details", exact: true })
    await expect(row).toBeInViewport()
    await expect(row).toHaveCSS("width", "1000px")
    const before = await row.boundingBox()
    const dock = await composer.boundingBox()
    expect(before).not.toBeNull()
    expect(dock).not.toBeNull()
    await content.evaluate((element) => {
      element.setAttribute("data-summary-motion", "")
      for (const type of ["transitionrun", "transitionend"]) {
        element.addEventListener(type, (event) => {
          if (event.target !== element || (event as TransitionEvent).propertyName !== "translate") return
          element.setAttribute("data-summary-motion", `${element.getAttribute("data-summary-motion")}${type},`)
        })
      }
    })
    await testInfo.attach(`summary-${direction}-centered`, { body: await page.screenshot(), contentType: "image/png" })
    await trigger.click()
    await expect(content).toHaveAttribute("data-summary-motion", "transitionrun,transitionend,")
    await expect
      .poll(async () => {
        const message = await row.boundingBox()
        const details = await summary.boundingBox()
        const chat = await panel.boundingBox()
        if (!message || !details || !chat) return false
        return (
          message.x >= chat.x &&
          message.x + message.width <= chat.x + chat.width &&
          (direction === "ltr" ? message.x + message.width < details.x : message.x > details.x + details.width)
        )
      })
      .toBe(true)
    await expect(row).toHaveCSS("width", "1000px")
    await expect
      .poll(async () => {
        const message = await row.boundingBox()
        const input = await composer.boundingBox()
        if (!message || !input || !before || !dock) return Infinity
        return Math.abs(message.x - before.x - (input.x - dock.x))
      })
      .toBeLessThan(1)
    await expect
      .poll(() =>
        content.evaluate((element) => element.parentElement!.scrollWidth - element.parentElement!.clientWidth),
      )
      .toBe(0)
    await testInfo.attach(`summary-${direction}-shifted`, { body: await page.screenshot(), contentType: "image/png" })

    await page.clock.pauseAt(new Date("2026-09-10T12:01:00Z"))
    const shifted = await content.evaluate((element) => getComputedStyle(element).translate)
    await content.evaluate((element) => element.setAttribute("data-summary-motion", ""))
    // Keep issuing resize events before the idle timer expires, including crossing the width cutoff.
    for (const width of [1520, 1280, 1600]) {
      await page.setViewportSize({ width, height: 900 })
      await expect(panel).toHaveAttribute("data-summary-resizing", "true")
      await page.clock.runFor(100)
      await expect(content).toHaveCSS("translate", shifted)
      await expect(composer).toHaveCSS("translate", shifted)
      await expect(content).toHaveAttribute("data-summary-motion", "")
    }
    await page.clock.resume()
    await expect(panel).toHaveAttribute("data-summary-resizing", "false")
    await expect(content).toHaveAttribute("data-summary-motion", "transitionrun,transitionend,")
    await expect(content).not.toHaveCSS("translate", shifted)
    await page.setViewportSize({ width: 1440, height: 900 })
    await expect(content).toHaveCSS("translate", shifted)

    await content.evaluate((element) => element.setAttribute("data-summary-motion", ""))
    await page.keyboard.press("Escape")
    await expect(summary).toBeHidden()
    await expect(content).toHaveAttribute("data-summary-motion", "transitionrun,transitionend,")
    await expect.poll(async () => Math.abs((await row.boundingBox())!.x - before!.x)).toBeLessThan(1)
    await expect(trigger).toBeFocused()

    await trigger.click()
    await expect(summary.getByRole("button", { name: "Extensions", exact: true })).toBeVisible()
    // Cross the actual chat-panel breakpoint, including any surrounding shell width.
    const shell = 1440 - (await panel.boundingBox())!.width
    await page.setViewportSize({ width: 1320 + shell, height: 900 })
    await expect.poll(async () => (await panel.boundingBox())!.width).toBe(1320)
    await expect
      .poll(async () => {
        const message = (await row.boundingBox())!
        const details = (await summary.boundingBox())!
        return direction === "ltr" ? details.x - message.x - message.width : message.x - details.x - details.width
      })
      .toBeGreaterThan(0)
    await page.setViewportSize({ width: 1319 + shell, height: 900 })
    await expect(content).toHaveCSS("translate", "none")
    await expect(row).toHaveCSS("width", "1000px")
    await expect(summary).toBeVisible()

    await page.setViewportSize({ width: 1800, height: 900 })
    await expect(content).toHaveCSS("translate", "0px")
    await expect(summary).toBeVisible()

    await page.emulateMedia({ reducedMotion: "reduce" })
    await page.setViewportSize({ width: 1440, height: 900 })
    await expect(content).toHaveCSS("transition-duration", "0s")
    await page.keyboard.press("Escape")
    await expect(content).toHaveCSS("translate", "none")
    await expect.poll(async () => Math.abs((await row.boundingBox())!.x - before!.x)).toBeLessThan(1)
  })
}

for (const direction of ["ltr", "rtl"] as const) {
  test(`summary truncates long copy before the indicator column in ${direction}`, async ({ page }) => {
    const branch = `feature/${"long-branch-name-".repeat(12)}`
    await mockStressTimeline(page)
    await page.route(
      (url) => url.pathname === "/api/vcs",
      (route) => {
        if (route.request().method() === "OPTIONS") return route.fallback()
        return route.fulfill({
          json: { location: { directory: fixture.directory }, data: { branch: { current: branch, default: "main" } } },
        })
      },
    )
    await openWithDirection(page, stressSessionHref(fixture.targetID), direction)
    await expect(page.locator("html")).toHaveAttribute("dir", direction)
    await expect(page.locator("html")).toHaveAttribute("lang", "en")
    await page.getByRole("button", { name: "Session details", exact: true }).click()
    const summary = page.getByRole("dialog", { name: "Session details", exact: true })
    const text = summary.getByText(branch, { exact: true })
    await expect(text).toBeVisible()
    await expect(text).toHaveCSS("text-overflow", "ellipsis")
    await expect.poll(() => text.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true)
    const arrow = summary
      .getByRole("button", { name: "Local repository", exact: true })
      .locator(".session-summary-menu-indicator")
    await expect
      .poll(async () => {
        const label = await text.boundingBox()
        const icon = await arrow.boundingBox()
        if (!label || !icon) return 0
        return direction === "ltr" ? icon.x - label.x - label.width : label.x - icon.x - icon.width
      })
      .toBeGreaterThanOrEqual(12)
    for (const name of ["Local repository", "MCP", "Plugins", "Skills", "LSP"]) {
      const row = summary.getByRole("button", { name, exact: true })
      await expect
        .poll(async () => {
          const label = await row.locator(".session-summary-label").boundingBox()
          const icon = await row.locator(".session-summary-menu-indicator").boundingBox()
          if (!label || !icon) return 0
          return direction === "ltr" ? icon.x - label.x - label.width : label.x - icon.x - icon.width
        })
        .toBeGreaterThanOrEqual(12)
    }
  })
}

for (const theme of ["light", "dark"] as const) {
  test(`summary bounds long service lists in ${theme}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 800, height: 600 })
    await mockStressTimeline(page)
    await page.addInitScript((theme) => {
      localStorage.setItem("opencode-theme-id", "oc-2")
      localStorage.setItem("opencode-color-scheme", theme)
      localStorage.setItem("opencode.global.dat:language", JSON.stringify({ locale: theme === "dark" ? "he" : "en" }))
    }, theme)
    await page.route("**/api/mcp**", (route) => {
      if (route.request().method() === "OPTIONS") return route.fallback()
      return route.fulfill({
        json: {
          location: { directory: fixture.directory },
          data:
            new URL(route.request().url()).pathname === "/api/mcp/resource"
              ? { resources: [], templates: [] }
              : Array.from({ length: 30 }, (_, index) => ({
                  name: `server-${String(index).padStart(2, "0")}-בדיקה-${"long-name-".repeat(6)}`,
                  status: { status: "connected" },
                })),
        },
      })
    })
    await page.goto(stressSessionHref(fixture.targetID))
    await expect(page.locator("html")).toHaveAttribute("data-color-scheme", theme)
    await page.getByRole("button", { name: theme === "dark" ? "פרטי ההפעלה" : "Session details", exact: true }).click()
    const summary = page.locator('[data-component="session-summary-panel"]')
    await summary.getByRole("button", { name: "MCP", exact: true }).click()
    const menu = page.getByRole("dialog", { name: "MCP", exact: true })
    await expect(menu.getByRole("switch")).toHaveCount(30)
    await expect.poll(() => menu.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true)
    await expect
      .poll(async () => {
        const bounds = await menu.boundingBox()
        return (
          !!bounds &&
          bounds.x >= 15 &&
          bounds.y >= 15 &&
          bounds.x + bounds.width <= 785 &&
          bounds.y + bounds.height <= 585
        )
      })
      .toBe(true)
    await testInfo.attach(`summary-${theme}-long-list`, { body: await page.screenshot(), contentType: "image/png" })
    await menu.getByRole("switch", { name: /^server-29-/ }).focus()
    await expect(menu.getByRole("switch", { name: /^server-29-/ })).toBeFocused()
    await page.keyboard.press("Escape")
    await expect(menu).toBeHidden()
    await expect(summary.getByRole("button", { name: "MCP", exact: true })).toBeFocused()
  })
}
