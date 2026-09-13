import { expect, test } from "@playwright/test"
import { setupTimeline } from "../performance/timeline-stability/fixture"

for (const reducedMotion of [false, true]) {
  test(`suppresses the scrollbar from toggle press until timeline interaction (reduced motion: ${reducedMotion})`, async ({
    page,
  }) => {
    await setupTimeline(page, { seedHistory: true, reducedMotion })
    const chat = page.locator('[data-slot="session-chat-panel"]')
    const scroll = page.locator('[data-slot="session-timeline-scroll"]')
    const viewport = scroll.locator(".scroll-view__viewport")
    const thumb = scroll.locator('.scroll-view__thumb[data-orientation="vertical"]')
    const toggle = page.getByRole("button", { name: "Toggle review", exact: true })
    await expect(thumb).toHaveCount(1)
    await scroll.hover()
    await expect(thumb).toHaveAttribute("data-visible", "true")
    await expect(thumb).toHaveCSS("visibility", "visible")

    for (const opened of [true, false]) {
      await toggle.hover()
      await page.mouse.down()
      await expect(thumb).toHaveCSS("visibility", "hidden")
      await page.mouse.up()
      await expect(toggle).toHaveAttribute("aria-expanded", String(opened))
      await chat.evaluate(async (element) => {
        await Promise.all(element.getAnimations().map((animation) => animation.finished))
      })
      await expect(chat).toHaveAttribute("data-width-animating", "false")
      await expect(thumb).toHaveCSS("visibility", "hidden")
      // Late scroll anchoring must not bring the thumb back after the panel has settled.
      await viewport.evaluate(
        (element) =>
          new Promise<void>((resolve) => {
            element.addEventListener("scroll", () => resolve(), { once: true })
            element.scrollTop += element.scrollTop > 0 ? -1 : 1
          }),
      )
      await expect(thumb).toHaveCSS("visibility", "hidden")
      await scroll.hover()
      await expect(thumb).toHaveAttribute("data-visible", "true")
      await expect(thumb).toHaveCSS("visibility", "visible")
    }
  })
}
