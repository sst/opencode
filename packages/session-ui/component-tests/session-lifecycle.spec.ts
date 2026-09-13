import { expect, story } from "../../storybook/playwright/story"

for (const tool of ["shell", "execute", "subagent"]) {
  for (const open of [false, true]) {
    story(`keeps ${tool} inside an existing ${open ? "open" : "closed"} group through execution`, async ({ mount }) => {
      const timeline = await mount("current-session-terminal-work--terminal-commands", {
        args: { existingGroup: true, tool },
      })
      const group = timeline.locator('[data-component="collapsed-tool-group"]')
      const trigger = group.locator(':scope > [data-component="collapsible"] > [data-slot="collapsible-trigger"]')
      await expect(group).toHaveAttribute("data-timeline-part-ids", "tool_context_lifecycle")
      if (open) await trigger.click()
      await expect(trigger).toHaveAttribute("aria-expanded", String(open))
      await timeline.getByRole("button", { name: "Start tool", exact: true }).click()
      await expect(group).toHaveAttribute("data-timeline-part-ids", "tool_context_lifecycle,tool_shell_lifecycle")
      const original = await group.elementHandle()
      for (const action of [undefined, "Complete input", "Run command", "Complete command"]) {
        if (action) await timeline.getByRole("button", { name: action, exact: true }).click()
        await expect(group).toHaveAttribute("data-timeline-part-ids", "tool_context_lifecycle,tool_shell_lifecycle")
        const usage = group.locator(
          '[data-component="context-tool-group-trigger"] [data-slot="context-tool-group-usage"]',
        )
        await expect(usage.locator('[data-slot="context-tool-group-prefix"]')).toHaveText("Used")
        await expect(usage.locator('[data-slot="context-tool-group-count"]')).toHaveText("2")
        await expect(timeline.locator('[data-timeline-row="AssistantPart"]')).toHaveCount(1)
        await expect(trigger).toHaveAttribute("aria-expanded", String(open))
        expect(await original!.evaluate((node) => node.isConnected)).toBe(true)
        if (open) await expect(group.locator('[data-timeline-part-id="tool_shell_lifecycle"]')).toBeVisible()
      }
    })
  }
}

for (const expanded of [false, true]) {
  // Moved from packages/app/e2e/regression/session-timeline-lifecycle-state.spec.ts
  story(`preserves shell user intent from a ${expanded ? "expanded" : "collapsed"} default`, async ({ mount }) => {
    const timeline = await mount("current-session-terminal-work--terminal-commands", { args: { expanded } })
    const trigger = expanded
      ? timeline.locator('[data-timeline-part-id="tool_shell_lifecycle"] [data-slot="collapsible-trigger"]')
      : timeline.getByRole("button", { name: "Used 1 Shell", exact: true })
    await expect(trigger).toHaveAttribute("aria-expanded", String(expanded))
    await trigger.click()
    await expect(trigger).toHaveAttribute("aria-expanded", String(!expanded))
    await timeline.getByRole("button", { name: "Update output" }).click()
    await expect(trigger).toHaveAttribute("aria-expanded", String(!expanded))
    await timeline.getByRole("button", { name: "Append sibling" }).click()
    await expect(timeline.getByText("Sibling content", { exact: true })).toBeVisible()
    await expect(trigger).toHaveAttribute("aria-expanded", String(!expanded))
    await timeline.getByRole("button", { name: "Mark session busy" }).click()
    await timeline.getByRole("button", { name: "Mark session idle" }).click()
    await expect(trigger).toHaveAttribute("aria-expanded", String(!expanded))
  })
}

// Moved from packages/app/e2e/regression/session-timeline-lifecycle-state.spec.ts
story("transitions a streaming shell from writing through command execution", async ({ mount }) => {
  const timeline = await mount("current-session-terminal-work--terminal-commands", { args: { streaming: true } })
  const tool = timeline.locator('[data-timeline-part-id="tool_shell_lifecycle"]')
  const title = tool.locator('[data-slot="basic-tool-tool-title"]')
  const shimmer = title.locator('[data-component="text-shimmer"]')
  const subtitle = tool.locator('[data-slot="basic-tool-tool-subtitle"]')
  await expect(shimmer).toHaveAttribute("aria-label", "Shell")
  await expect(shimmer).toHaveAttribute("data-active", "true")
  await expect(subtitle).toHaveText("Writing command…")
  await expect(subtitle.locator('[data-component="text-shimmer"]')).toHaveCount(0)
  await expect(tool.locator('[data-component="shell-submessage"]')).toHaveCount(0)
  await expect(tool.locator('[data-slot="collapsible-trigger"]')).toHaveCSS("height", "28px")
  await expect(tool.locator('[data-component="tool-trigger"]')).toHaveCSS("gap", "6px")
  await expect(title).toHaveCSS("font-size", "13px")
  await expect(title).toHaveCSS("font-family", /^Inter,/)
  await expect(title).toHaveCSS("font-weight", "530")
  await expect(title).toHaveCSS("line-height", "16px")
  await expect(title).toHaveCSS("color", "rgb(22, 22, 22)")
  await expect(subtitle).toHaveCSS("font-size", "13px")
  await expect(subtitle).toHaveCSS("font-family", /^Inter,/)
  await expect(subtitle).toHaveCSS("font-weight", "440")
  await expect(subtitle).toHaveCSS("line-height", "16px")
  await expect(subtitle).toHaveCSS("color", "rgb(92, 92, 92)")
  await timeline.getByRole("button", { name: "Complete input" }).click()
  await expect(shimmer).toHaveAttribute("data-active", "true")
  await expect(subtitle).toHaveText("printf ready")
  await expect(tool).not.toContainText("Writing command…")
  await timeline.getByRole("button", { name: "Run command" }).click()
  await expect(shimmer).toHaveAttribute("data-active", "true")
  await expect(subtitle).toHaveText("printf ready")
  await expect(tool).not.toContainText("Writing command…")
  await timeline.getByRole("button", { name: "Complete command" }).click()
  const summary = timeline.getByRole("button", { name: "Used 1 Shell", exact: true })
  await expect(summary).toHaveAttribute("aria-expanded", "false")
  await summary.click()
  await expect(subtitle).toHaveText("printf ready")
})

// Moved from packages/app/e2e/regression/session-timeline-lifecycle-state.spec.ts
story("shimmers and expands a running shell command", async ({ mount }) => {
  const timeline = await mount("current-session-terminal-work--terminal-commands", { args: { streaming: true } })
  await timeline.getByRole("button", { name: "Run command" }).click()
  const tool = timeline.locator('[data-timeline-part-id="tool_shell_lifecycle"]')
  const trigger = tool.locator('[data-slot="collapsible-trigger"]')
  await expect(tool.locator('[data-component="text-shimmer"]')).toHaveAttribute("data-active", "true")
  await expect(tool).not.toContainText("Writing command…")
  await expect(tool.locator('[data-component="shell-submessage"]')).toHaveText("printf ready")
  await expect(tool.locator('[data-component="shell-submessage"] [data-component="text-shimmer"]')).toHaveCount(0)
  await expect(trigger).toHaveCSS("height", "28px")
  await expect(trigger).toHaveAttribute("aria-expanded", "false")
  await trigger.click()
  await expect(trigger).toHaveAttribute("aria-expanded", "true")
  await expect(tool.locator('[data-slot="bash-pre"]')).toContainText("still running")
})

// Moved from packages/app/e2e/regression/session-timeline-lifecycle-state.spec.ts
for (const open of [false, true]) {
  story(
    `keeps ${open ? "expanded" : "collapsed"} reasoning intent from Thinking through standalone shell into Used`,
    async ({ mount }) => {
      const timeline = await mount("current-session-timeline-rows--conversation", { args: { scenario: "hidden" } })
      const reasoning = timeline.locator('[data-timeline-part-id="msg_hidden_reasoning_lifecycle:reasoning:0"]')
      await expect(timeline.locator('[data-timeline-row="Thinking"]')).toBeVisible()
      await expect(timeline.getByText("Inspecting stability", { exact: true })).toBeVisible()
      const thought = reasoning.locator('[data-slot="collapsible-trigger"]')
      await expect(thought).toHaveAttribute("aria-expanded", "false")
      await thought.click()
      await expect(thought).toHaveAttribute("aria-expanded", "true")
      if (!open) await thought.click()
      await expect(thought).toHaveAttribute("aria-expanded", String(open))
      await timeline.getByRole("button", { name: "Start shell" }).click()
      const group = timeline.locator('[data-component="collapsed-tool-group"]')
      await expect(timeline.locator('[data-timeline-part-id="tool_hidden_reasoning_shell"]')).toBeVisible()
      await expect(group).toHaveCount(0)
      await expect(timeline.locator('[data-timeline-row="Thinking"]')).toHaveCount(0)
      await expect(thought).toContainText("Thought")
      await expect(thought).not.toContainText("Inspecting stability")
      await expect(thought).toHaveAttribute("aria-expanded", String(open))
      await timeline.getByRole("button", { name: "Finish session" }).click()
      const used = group.getByRole("button", { name: "Used 1 Shell", exact: true })
      await expect(used).toHaveAttribute("aria-expanded", "false")
      await used.click()
      await expect(used).toHaveAttribute("aria-expanded", "true")
      await expect(group.locator('[data-timeline-part-id="tool_hidden_reasoning_shell"]')).toBeVisible()
      await expect(group.getByRole("button", { name: "Thought", exact: true })).toHaveAttribute(
        "aria-expanded",
        String(open),
      )
      await expect(
        group.locator('[data-component="context-tool-group-trigger"] [data-slot="basic-tool-tool-title"]'),
      ).toHaveText("Shell")
      await expect(timeline.locator('[data-timeline-row="Thinking"]')).toHaveCount(0)
      await expect(used).toHaveAttribute("aria-expanded", "true")
      if (!open) await thought.click()
      await expect(reasoning.getByRole("heading", { name: "Inspecting stability", exact: true })).toBeVisible()
      await used.click()
      await expect(used).toHaveAttribute("aria-expanded", "false")
      await used.click()
      await expect(reasoning.getByRole("button", { name: "Thought", exact: true })).toHaveAttribute(
        "aria-expanded",
        "true",
      )
      await expect(reasoning.getByRole("heading", { name: "Inspecting stability", exact: true })).toBeVisible()
    },
  )
}

// Moved from packages/app/e2e/regression/session-timeline-lifecycle-state.spec.ts
story("does not infer Thinking from busy, retry, or recovery without reasoning", async ({ mount }) => {
  const timeline = await mount("current-session-timeline-rows--conversation", { args: { scenario: "retry" } })
  await expect(timeline.locator('[data-timeline-row="UserMessage"]')).toBeVisible()
  await expect(timeline.locator('[data-timeline-row="Thinking"]')).toHaveCount(0)
  await expect(timeline.locator('[data-timeline-row="DiffSummary"]')).toHaveCount(0)
  await timeline.getByRole("button", { name: "Retry request" }).click()
  await expect(timeline.locator('[data-timeline-row="Retry"]')).toBeVisible()
  await expect(timeline.locator('[data-timeline-row="Thinking"]')).toHaveCount(0)
  await timeline.getByRole("button", { name: "Recover request" }).click()
  await expect(timeline.locator('[data-timeline-row="Retry"]')).toHaveCount(0)
  await expect(timeline.locator('[data-timeline-row="Thinking"]')).toHaveCount(0)
  await timeline.getByRole("button", { name: "Finish response" }).click()
  await expect(timeline.locator('[data-timeline-row="Thinking"]')).toHaveCount(0)
  await expect(timeline.locator('[data-timeline-part-id="msg_retry_recovery_lifecycle:text:0"]')).toContainText(
    "Recovered response",
  )
})

for (const locale of ["de", "ar"] as const) {
  // Moved from packages/app/e2e/regression/session-timeline-locale-projection.spec.ts
  story(`projects localized tool names with an English fallback in ${locale}`, async ({ mount, page }) => {
    const timeline = await mount("current-session-research-agents--agent-research", {
      args: { scenario: "exploration" },
      globals: { locale },
    })
    await timeline.getByRole("button", { name: "Complete read" }).click()
    await timeline.getByRole("button", { name: "Complete glob" }).click()
    const group = timeline.locator('[data-timeline-part-ids="tool_context_read,tool_context_glob"]')
    await expect(group.getByRole("button")).toHaveAccessibleName(/^Used 2 /)
    await expect(
      group.locator('[data-component="context-tool-group-trigger"] [data-slot="basic-tool-tool-title"]'),
    ).toHaveText(locale === "de" ? "Lesen, Glob" : "\u0642\u0631\u0627\u0621\u0629, Glob")
    await expect(page.locator("html")).toHaveAttribute("lang", locale)
  })
}
