import { expect, test } from "@playwright/test"
import { sessionID, setupTimeline, userMessage } from "../performance/timeline-stability/fixture"

test("keeps a submitted prompt in place while its optimistic rows are measured", async ({ page }) => {
  await setupTimeline(page, { messages: [userMessage()], seedHistory: true })
  const release = Promise.withResolvers<void>()
  await page.route(`**/api/session/${sessionID}/prompt`, async (route) => {
    if (route.request().method() !== "POST") return route.fallback()
    await release.promise
    return route.fallback()
  })

  const editor = page.locator('[data-component="composer"]').getByRole("textbox")
  await expect(editor).toBeEditable()
  await editor.fill("Observe optimistic prompt spacing.")
  await expect
    .poll(() =>
      page.locator("[data-timeline-virtual-content]").evaluate((element) => {
        const root = element.parentElement!
        return root.scrollHeight - root.clientHeight - root.scrollTop
      }),
    )
    .toBe(0)

  const observation = await page.evaluateHandle(() => {
    const frames: { prompt?: number; working: boolean }[] = []
    let frame = 0
    const sample = () => {
      const prompt = [...document.querySelectorAll<HTMLElement>('[data-timeline-row="UserMessage"]')].find((row) =>
        row.textContent?.includes("Observe optimistic prompt spacing."),
      )
      frames.push({
        ...(prompt ? { prompt: prompt.getBoundingClientRect().y } : {}),
        working: !!document.querySelector('[data-component="session-working"]'),
      })
      frame = requestAnimationFrame(sample)
    }
    frame = requestAnimationFrame(sample)
    return {
      stop: () => {
        cancelAnimationFrame(frame)
        return frames
      },
    }
  })
  const requested = page.waitForRequest(
    (request) => request.method() === "POST" && new URL(request.url()).pathname === `/api/session/${sessionID}/prompt`,
  )
  try {
    await editor.press("Enter")
    await requested
    const prompt = page
      .locator('[data-timeline-row="UserMessage"]')
      .filter({ hasText: "Observe optimistic prompt spacing." })
    await expect(prompt).toBeInViewport()
    await expect(page.locator('[data-component="session-working"]')).toBeVisible()
    await expect
      .poll(() =>
        page.locator("[data-timeline-virtual-content]").evaluate((element) => {
          const root = element.parentElement!
          return root.scrollHeight - root.clientHeight - root.scrollTop
        }),
      )
      .toBe(0)
    const frames = await observation.evaluate((value) => value.stop())
    expect(frames.some((frame) => frame.working && frame.prompt === undefined)).toBe(false)
    const positions = frames.flatMap((frame) => (frame.prompt === undefined ? [] : [frame.prompt]))
    expect(positions.length).toBeGreaterThan(0)
    expect(new Set(positions).size).toBe(1)
  } finally {
    release.resolve()
    await observation.dispose()
  }
})
