import { expect, story } from "../../storybook/playwright/story"

for (const mode of ["hidden", "compact", "full"] as const) {
  for (const reasoning of ["none", "blank", "heading"] as const) {
    story(`projects ${mode} mode with ${reasoning} active reasoning`, async ({ mount }) => {
      const timeline = await mount("current-session-timeline-rows--conversation", {
        args: { scenario: "reasoning", mode, reasoning },
      })
      await expect(timeline.locator('[data-timeline-row="UserMessage"]')).toContainText(
        "Find why the Session header shifts after the first streamed response.",
      )
      const active = mode !== "hidden" && reasoning !== "none"
      const part = timeline.locator('[data-timeline-part-id="msg_projection_assistant:reasoning:0"]')
      await expect(timeline.locator('[data-timeline-row="Thinking"]')).toHaveCount(active ? 1 : 0)
      await expect(part).toHaveCount(active ? 1 : 0)
      if (!active || reasoning !== "heading") {
        await expect(timeline.getByText("Inspecting stability", { exact: true })).toHaveCount(0)
        return
      }
      const trigger = part.getByRole("button")
      const body = part.getByText("I will inspect the timeline before changing its state.", { exact: true })
      await expect(trigger).toHaveAttribute("aria-expanded", String(mode === "full"))
      await expect(part.locator('[data-component="text-shimmer"]')).toHaveAttribute("data-active", "true")
      if (mode === "compact") {
        await expect(trigger).toContainText("Inspecting stability")
        await expect(body).toBeHidden()
        await trigger.click()
        await expect(trigger).toHaveAttribute("aria-expanded", "true")
      }
      await expect(body).toBeVisible()
      await trigger.click()
      await expect(trigger).toHaveAttribute("aria-expanded", "false")
      await expect(body).toBeHidden()
      await expect(trigger).toContainText("Inspecting stability")
    })
  }

  for (const following of ["tool", "text"] as const) {
    story(`stops Thinking before ${following} in ${mode} mode`, async ({ mount }) => {
      const timeline = await mount("current-session-timeline-rows--conversation", {
        args: {
          scenario: "reasoning",
          mode,
          reasoning: "heading",
          tool: following === "tool",
          text: following === "text" ? "The timeline is stable" : "",
        },
      })
      const part = timeline.locator('[data-timeline-part-id="msg_projection_assistant:reasoning:0"]')
      if (following === "tool") {
        const group = timeline.locator('[data-component="collapsed-tool-group"]')
        const trigger = group.locator(':scope > [data-component="collapsible"] > [data-slot="collapsible-trigger"]')
        await expect(trigger).toHaveText(/^Used\s*1\s*Skill$/)
        await expect(trigger).toHaveAttribute("aria-expanded", "false")
        await expect(
          group.locator('[data-component="context-tool-group-trigger"] [data-slot="basic-tool-tool-title"]'),
        ).toHaveText("Skill")
        await expect(timeline.getByText("Inspecting stability", { exact: true })).toBeHidden()
        await trigger.click()
        await expect(trigger).toHaveAttribute("aria-expanded", "true")
        await expect(group.locator('[data-timeline-part-id="tool_reasoning_projection_skill"]')).toBeVisible()
        await expect(group.locator('[data-component="reasoning-part"]')).toHaveCount(mode === "hidden" ? 0 : 1)
      }
      if (following === "text")
        await expect(timeline.getByText("The timeline is stable", { exact: true })).toBeVisible()
      await expect(timeline.locator('[data-timeline-row="Thinking"]')).toHaveCount(0)
      await expect(part).toHaveCount(mode === "hidden" ? 0 : 1)
      if (mode === "hidden") return
      const thought = part.locator('[data-slot="collapsible-trigger"]')
      const thoughtTitle = thought.locator('[data-slot="basic-tool-tool-title"]')
      await expect(thoughtTitle).toContainText("Thought")
      await expect(thoughtTitle).toHaveCSS("font-size", "13px")
      await expect(thoughtTitle).toHaveCSS("line-height", "16px")
      await expect(thought.locator('[data-slot="basic-tool-tool-subtitle"]')).toHaveText("7s")
      await expect(thought).toHaveAttribute("aria-expanded", String(mode === "full"))
      await expect(thought).not.toContainText("Inspecting stability")
      await expect(part.locator('[data-component="text-shimmer"]')).toHaveAttribute("data-active", "false")
      if (mode === "compact") await thought.click()
      await expect(
        part.getByText("I will inspect the timeline before changing its state.", { exact: true }),
      ).toBeVisible()
    })
  }
}

// Moved from packages/app/e2e/regression/session-timeline-reasoning-projection.spec.ts
story("does not infer reasoning visibility from provider identity", async ({ mount }) => {
  const timeline = await mount("current-session-timeline-rows--conversation", {
    args: { scenario: "reasoning", reasoning: "none", text: "No reasoning payload" },
  })
  await expect(timeline.locator('[data-timeline-row="Thinking"]')).toHaveCount(0)
  await expect(timeline.locator('[data-timeline-part-id*="reasoning"]')).toHaveCount(0)
  await expect(timeline.getByText("No reasoning payload", { exact: true })).toBeVisible()
})
