import { expect, story } from "../../storybook/playwright/story"

for (const width of [1280, 390]) {
  for (const streaming of [false, true]) {
    story(
      `renders Mermaid in the ${streaming ? "streaming" : "completed"} timeline at ${width}px`,
      async ({ mount, page }) => {
        await page.setViewportSize({ width, height: 900 })
        const root = await mount("current-session-mermaid--diagrams", { args: { streaming } })
        const timeline = root.locator('[data-component="session-timeline"]')
        const diagrams = timeline.locator('[data-component="markdown-mermaid"] > svg')
        await expect(diagrams).toHaveCount(2)
        await expect(diagrams.nth(0)).toBeVisible()
        await expect(diagrams.nth(0)).toContainText("Client")
        await expect(diagrams.nth(1)).toBeVisible()
        await expect(diagrams.nth(1)).toContainText("Send prompt")
        await expect(timeline.locator('[data-mermaid-ready="true"]')).toHaveCount(2)
        await expect(timeline.locator('[data-mermaid-ready="true"] > pre:visible')).toHaveCount(0)
        if (streaming) {
          await root.getByRole("button", { name: "Complete response" }).click()
          await expect(timeline.locator('[data-markdown-complete="true"]')).toHaveCount(2)
          await expect(diagrams).toHaveCount(2)
          await expect(diagrams.nth(0)).toBeVisible()
          await expect(diagrams.nth(1)).toBeVisible()
        }
      },
    )
  }
}

story("renders streamed reasoning without starting the app", async ({ mount }) => {
  const timeline = await mount("current-session-timeline-rows--streaming-reasoning-and-text")
  await expect(timeline.locator('[data-component="session-timeline"]')).toBeVisible()
  await timeline.locator('[data-component="reasoning-part"] [data-slot="collapsible-trigger"]').click()
  await expect(timeline.getByText("Checking the current contract", { exact: true })).toBeVisible()
})

story("aligns the retry icon with the error label", async ({ mount }) => {
  const timeline = await mount("current-session-timeline-rows--provider-retry")
  const card = timeline.locator('[data-kind="session-retry-card"]')
  const icon = card.locator('[data-slot="icon-svg"]')
  const label = card.locator('[data-slot="session-turn-retry-message"]')
  await expect(icon).toBeVisible()
  await expect(label).toBeVisible()
  const [iconY, labelY] = await Promise.all([
    icon.evaluate((element) => element.getBoundingClientRect().y),
    label.evaluate((element) => element.getBoundingClientRect().y),
  ])

  expect(iconY).toBe(labelY)
})

// Moved from packages/app/e2e/regression/session-timeline-context-state.spec.ts
story("preserves a collapsed context group through count and status updates", async ({ mount }) => {
  const timeline = await mount("current-session-research-agents--agent-research", { args: { scenario: "exploration" } })
  const group = timeline.locator('[data-timeline-part-ids="tool_context_read,tool_context_glob"]')
  const trigger = group.locator('[data-slot="collapsible-trigger"]')
  await expect(trigger).toHaveAttribute("aria-expanded", "false")
  await timeline.getByRole("button", { name: "Complete read" }).click()
  await expect(trigger).toHaveAttribute("aria-expanded", "false")
  await timeline.getByRole("button", { name: "Complete glob" }).click()
  await expect(trigger).toHaveAttribute("aria-expanded", "false")
})

// Moved from packages/app/e2e/regression/session-timeline-accessibility.spec.ts
story("space activates a focused timeline button instead of scrolling", async ({ mount, page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" })
  await page.setViewportSize({ width: 800, height: 240 })
  const timeline = await mount("current-session-terminal-work--terminal-commands", { args: { scenario: "collapsed" } })
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollHeight - innerHeight)).toBeGreaterThan(0)
  const trigger = timeline.getByRole("button", { name: "Used 1 Shell", exact: true })
  await expect(trigger).toHaveAttribute("aria-expanded", "false")
  await trigger.focus()
  const before = await page.evaluate(() => window.scrollY)
  await trigger.press("Space")
  await expect(trigger).toHaveAttribute("aria-expanded", "true")
  expect(await page.evaluate(() => window.scrollY)).toBe(before)
})

// Moved from packages/app/e2e/regression/session-timeline-file-projection.spec.ts
story("renders a completed write through the production file component", async ({ mount }) => {
  const timeline = await mount("current-session-file-changes--changing-files", { args: { scenario: "write" } })
  await expect(
    timeline.locator('[data-timeline-part-id="prt_file_projection_write"] [data-component="write-content"]'),
  ).toBeVisible()
})

// Moved from packages/app/e2e/regression/session-timeline-file-state.spec.ts
story("keeps patch file disclosures independent", async ({ mount }) => {
  const timeline = await mount("current-session-file-changes--changing-files", { args: { scenario: "patch" } })
  const wrapper = timeline.locator('[data-timeline-part-id="prt_nested_patch"]')
  const modified = wrapper.locator('[data-scope="apply-patch"] [data-type="update"] button')
  const added = wrapper.locator('[data-scope="apply-patch"] [data-type="add"] button')
  const deleted = wrapper.locator('[data-scope="apply-patch"] [data-type="delete"] button')
  await expect(wrapper.locator('[data-scope="apply-patch"] [aria-expanded="false"]')).toHaveCount(3)
  await deleted.click()
  await expect(deleted).toHaveAttribute("aria-expanded", "true")
  await expect(modified).toHaveAttribute("aria-expanded", "false")
  await modified.click()
  await expect(modified).toHaveAttribute("aria-expanded", "true")
  await deleted.click()
  await expect(deleted).toHaveAttribute("aria-expanded", "false")
  await expect(modified).toHaveAttribute("aria-expanded", "true")
  await expect(added).toHaveAttribute("aria-expanded", "false")
  await added.click()
  await expect(added).toHaveAttribute("aria-expanded", "true")
  await expect(modified).toHaveAttribute("aria-expanded", "true")
  await expect(deleted).toHaveAttribute("aria-expanded", "false")
})
