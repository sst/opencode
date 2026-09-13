import { expect, test } from "@playwright/test"
import { fixture } from "../performance/timeline/session-timeline-stress.fixture"
import { mockStressTimeline, stressSessionHref } from "../performance/timeline/timeline-test-helpers"

test("summary drawer dismisses and reopens after button, backdrop, Escape, and drag", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await mockStressTimeline(page)
  await page.goto(stressSessionHref(fixture.targetID))
  const more = page
    .locator('[data-slot="session-mobile-view-navigation"]')
    .getByRole("button", { name: "More options", exact: true })
  const drawer = page.getByRole("dialog", { name: "Session details", exact: true })
  const overlay = page.locator('[data-slot="mobile-drawer-overlay"]')

  for (const dismissal of ["button", "backdrop", "escape", "drag", "button"] as const) {
    await more.click()
    await expect(page.getByRole("menuitem", { name: "Status", exact: true })).toHaveCount(0)
    await page.getByRole("menuitem", { name: "Session details", exact: true }).click()
    await expect(drawer.getByRole("button", { name: "MCP", exact: true })).toBeVisible()
    // Corvu starts opening after paint; the transition flag is also absent
    // before that callback. Wait for the open position before dismissing.
    await expect
      .poll(() => drawer.evaluate((element) => new DOMMatrixReadOnly(getComputedStyle(element).transform).m42))
      .toBe(0)
    await expect(drawer).not.toHaveAttribute("data-transitioning")
    if (dismissal === "button") await drawer.getByRole("button", { name: "Close", exact: true }).click()
    if (dismissal === "backdrop") await overlay.click({ position: { x: 10, y: 10 } })
    if (dismissal === "escape") await page.keyboard.press("Escape")
    if (dismissal === "drag") {
      const handle = drawer.locator('[data-slot="mobile-drawer-handle"]')
      const bounds = await handle.boundingBox()
      expect(bounds).not.toBeNull()
      await page.mouse.move(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height / 2)
      await page.mouse.down()
      await page.mouse.move(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height / 2 + 1)
      await page.mouse.move(bounds!.x + bounds!.width / 2, 843)
      await page.mouse.up()
    }
    await expect(drawer, `dismissal: ${dismissal}`).toBeHidden()
    await expect(overlay).toHaveCount(0)
    await expect(more).toBeFocused()
  }
})
