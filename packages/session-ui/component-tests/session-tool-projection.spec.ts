import { expect, story } from "../../storybook/playwright/story"

// Moved from packages/app/e2e/regression/session-timeline-projection.spec.ts
story("renders every admitted tool family and hides timeline-only exclusions", async ({ mount }) => {
  const timeline = await mount("current-session-research-agents--agent-research", { args: { scenario: "workflow" } })
  const first = timeline.locator(
    '[data-timeline-part-ids="tool_family_read,tool_family_glob,tool_family_grep,tool_family_list,tool_family_webfetch,tool_family_websearch,tool_family_subagent,tool_family_shell,tool_family_edit,tool_family_write,tool_family_patch"]',
  )
  const second = timeline.locator('[data-timeline-part-ids="tool_family_skill,tool_family_custom"]')
  await expect(first).toBeVisible()
  await expect(second).toBeVisible()
  await first.getByRole("button").click()
  await second.getByRole("button").click()
  for (const id of [
    "webfetch",
    "websearch",
    "subagent",
    "shell",
    "edit",
    "write",
    "patch",
    "question",
    "skill",
    "custom",
  ]) {
    await expect(timeline.locator(`[data-timeline-part-id="tool_family_${id}"]`), id).toBeVisible()
  }
  for (const name of ["edit", "write", "patch"]) {
    const tool = timeline.locator(`[data-timeline-part-id="tool_family_${name}"]`)
    await expect(tool.getByText("1 file", { exact: true })).toBeVisible()
    await expect(tool.getByRole("button")).toHaveCount(1)
    await expect(tool.locator('[data-scope="apply-patch"] button')).toHaveAttribute("aria-expanded", "false")
    await expect(tool.locator('[data-slot="collapsible-trigger"]')).toHaveAttribute("data-locked", "")
    await expect(tool.locator('[data-slot="message-part-title-filename"]')).toHaveCount(0)
    await expect(tool.locator('[data-slot="message-part-actions"]')).toHaveCount(0)
    await expect(tool.locator('[data-slot="basic-tool-tool-title"]')).toHaveCSS("font-size", "13px")
    await expect(tool.locator('[data-slot="basic-tool-tool-title"]')).toHaveCSS("line-height", "16px")
  }
  await expect(timeline.locator('[data-timeline-part-id="tool_family_todo"]')).toHaveCount(0)
})

// Moved from packages/app/e2e/regression/session-timeline-tool-projection.spec.ts
story("renders every tool error outcome without leaking hidden tools", async ({ mount }) => {
  const timeline = await mount("current-session-research-agents--agent-research", { args: { scenario: "failures" } })
  const names = ["shell", "edit", "write", "patch", "webfetch", "websearch", "subagent", "skill", "mcp_probe"]
  const group = timeline.locator(`[data-timeline-part-ids="${names.map((name) => `tool_error_${name}`).join(",")}"]`)
  const usage = group.locator('[data-component="context-tool-group-trigger"] [data-slot="context-tool-group-usage"]')
  await expect(usage.locator('[data-slot="context-tool-group-prefix"]')).toHaveText("Used")
  await expect(usage.locator('[data-slot="context-tool-group-count"]')).toHaveText(String(names.length))
  await group.getByRole("button").click()
  await expect(timeline.locator('[data-kind="tool-error-card"]')).toHaveCount(names.length + 1)
  const dismissed = timeline.locator('[data-timeline-part-id="tool_error_question_dismissed"]')
  await expect(dismissed.getByText(/dismissed/i)).toBeVisible()
  await expect(dismissed).toContainText(/dismissed/i)
  await expect(timeline.locator('[data-timeline-part-id="tool_error_todo"]')).toHaveCount(0)
  for (const name of names) await expect(timeline.locator(`[data-timeline-part-id="tool_error_${name}"]`)).toBeVisible()
})

// Moved from packages/app/e2e/regression/session-timeline-tool-projection.spec.ts
story("transitions shell and question through running error outcomes", async ({ mount }) => {
  const timeline = await mount("current-session-research-agents--agent-research", { args: { scenario: "transition" } })
  const shell = timeline.locator('[data-timeline-part-id="tool_transition_shell"]')
  const question = timeline.locator('[data-timeline-part-id="tool_transition_question"]')
  await expect(shell).toBeVisible()
  await expect(question).toHaveCount(0)
  await timeline.getByRole("button", { name: "Fail running tools" }).click()
  await expect(shell.locator('[data-kind="tool-error-card"]')).toBeVisible()
  await expect(shell).toContainText("Command exited 1")
  await expect(question).toContainText(/dismissed/i)
})

// Moved from packages/app/e2e/regression/session-timeline-tool-projection.spec.ts
story("labels all web search provider variants", async ({ mount }) => {
  const timeline = await mount("current-session-research-agents--agent-research", { args: { scenario: "providers" } })
  await timeline.getByRole("button", { name: "Used 3 Parallel Web Search, Exa Web Search, Web Search" }).click()
  const tools = timeline.locator('[data-component="context-tool-group-list"]')
  await expect(tools.getByRole("button", { name: /Parallel Web Search/ })).toBeVisible()
  await expect(tools.getByRole("button", { name: /Exa Web Search/ })).toBeVisible()
  await expect(tools.getByRole("button", { name: /^Web Search/ })).toBeVisible()
})

// Moved from packages/app/e2e/regression/session-timeline-tool-projection.spec.ts
story("labels completed searches with result counts", async ({ mount }) => {
  const timeline = await mount("current-session-research-agents--agent-research", { args: { scenario: "results" } })
  const group = timeline.locator('[data-timeline-part-ids="tool_label_glob,tool_label_grep,tool_label_read"]')
  await group.locator('[data-slot="collapsible-trigger"]').click()
  const rows = group.locator('[data-component="context-tool-group-list"] [data-component="tool-trigger"]')
  await expect(rows.filter({ hasText: "Glob" })).toContainText("(1 match)")
  await expect(rows.filter({ hasText: "Grep" })).toContainText("(12 matches)")
})

// Moved from packages/app/e2e/regression/session-timeline-tool-projection.spec.ts
story("labels read tools from their path input", async ({ mount }) => {
  const timeline = await mount("current-session-research-agents--agent-research", { args: { scenario: "read" } })
  const group = timeline.locator('[data-timeline-part-ids="prt_read_path"]')
  await group.locator('[data-slot="collapsible-trigger"]').click()
  await expect(
    group
      .locator('[data-component="context-tool-group-list"] [data-component="tool-trigger"]')
      .filter({ hasText: "Read" }),
  ).toContainText("a.ts")
})

// Moved from packages/app/e2e/regression/session-timeline-tool-projection.spec.ts
story("labels skill tools from IDs and result metadata", async ({ mount }) => {
  const timeline = await mount("current-session-research-agents--agent-research", { args: { scenario: "skills" } })
  const group = timeline.locator('[data-timeline-part-ids="tool_skill_id,tool_skill_name"]')
  await expect(group.getByRole("button")).toHaveAccessibleName("Used 2 Skill")
  await expect(
    group.locator('[data-component="context-tool-group-trigger"] [data-slot="basic-tool-tool-title"]'),
  ).toHaveText("Skill")
  await group.getByRole("button").click()
  const loaded = group.locator('[data-component="tool-loaded-item"]')
  await expect(loaded).toHaveCount(1)
  await expect(loaded).toHaveAttribute("aria-label", "Loaded frontend-design, OpenCode skills")
  await expect(loaded).toHaveCSS("line-height", "16px")
  await expect(loaded.locator('[data-slot="tool-loaded-label"]')).toHaveText("Loaded")
  await expect(loaded.locator('[data-slot="tool-loaded-kind"]')).toHaveText("skills")
  const names = loaded.locator('[data-component="text-shimmer"]')
  await expect(names).toHaveCount(2)
  await expect(names.nth(0)).toHaveAttribute("aria-label", "frontend-design")
  await expect(names.nth(1)).toHaveAttribute("aria-label", "OpenCode")
})

// Moved from packages/app/e2e/regression/session-timeline-reducer-projection.spec.ts
story("groups every collapsed tool until visible text separates the stack", async ({ mount }) => {
  const timeline = await mount("current-session-research-agents--agent-research", { args: { scenario: "steps" } })
  await expect(timeline.locator('[data-timeline-part-ids="tool_boundary_read"]')).toBeVisible()
  const group = timeline.locator(
    '[data-timeline-part-ids="tool_boundary_glob,tool_boundary_grep,tool_boundary_shell,tool_boundary_list"]',
  )
  await expect(group).toBeVisible()
  await expect(group.getByRole("button")).toHaveAccessibleName("Used 4 Glob, Grep, Shell, List")
  await expect(
    group.locator('[data-component="context-tool-group-trigger"] [data-slot="basic-tool-tool-title"]'),
  ).toHaveText("Glob, Grep, Shell, List")
  await expect(timeline.locator('[data-timeline-row="AssistantPart"]')).toHaveCount(3)
  await expect(timeline.locator('[data-timeline-spacing="content"]')).toHaveCount(2)
  await expect(timeline.locator('[data-timeline-spacing="content"]').nth(0)).toHaveCSS("padding-top", "16px")
})

// Moved from packages/app/e2e/regression/session-timeline-projection.spec.ts
story("combines adjacent edit calls and repeated files into one group", async ({ mount }) => {
  const timeline = await mount("current-session-file-changes--changing-files", { args: { scenario: "repeated" } })
  const group = timeline.locator('[data-timeline-part-ids="tool_grouped_edit_first,tool_grouped_edit_second"]')
  await expect(group.locator('[data-slot="basic-tool-tool-title"]')).toContainText("Edit")
  await expect(group.getByText("1 file", { exact: true })).toBeVisible()
  await expect(group.locator('[data-slot="apply-patch-filename"]')).toHaveText(["first.ts"])
  await expect(group.locator('[data-scope="apply-patch"] button')).toHaveAttribute("aria-expanded", "true")
})
