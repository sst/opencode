import { expect, test } from "@playwright/test"
import { createTwoFilesPatch } from "diff"
import {
  assistantMessage,
  completedAssistantInfo,
  messageUpdated,
  partUpdated,
  renderedPartID,
  setupTimeline,
  shell,
  toolPart,
  status,
  textPart,
  userMessage,
} from "../performance/timeline-stability/fixture"

test("reducer-hardening: converges when idle arrives before final part and message completion", async ({ page }) => {
  const textID = "prt_event_order_text"
  const assistant = assistantMessage([textPart(textID, "Partial")], { completed: false })
  const timeline = await setupTimeline(page, { messages: [userMessage(), assistant] })
  await timeline.send(status("busy"))
  await timeline.send(status("idle"))
  await timeline.send(partUpdated(textPart(textID, "Final after early idle")))
  await timeline.send(messageUpdated(completedAssistantInfo(assistant)))

  await expect(page.locator('[data-timeline-row="Thinking"]')).toHaveCount(0)
  await expect(page.locator(`[data-timeline-part-id="${renderedPartID(textID)}"]`)).toContainText(
    "Final after early idle",
  )
})

test("expands a mixed collapsed tool stack without expanding its individual calls", async ({ page }) => {
  const parts = [
    shell("prt_stack_shell_1", "completed", "first"),
    toolPart("prt_stack_explore", "subagent", "completed", {
      agent: "explore",
      description: "Inspect the project",
      prompt: "Explore the project",
    }),
    toolPart("prt_stack_patch", "patch", "completed", { patchText: "Update src/value.ts" }),
    shell("prt_stack_shell_2", "completed", "second"),
  ]
  await setupTimeline(page, { messages: [userMessage(), assistantMessage(parts)] })

  const group = page.locator(
    '[data-timeline-part-ids="prt_stack_shell_1,prt_stack_explore,prt_stack_patch,prt_stack_shell_2"]',
  )
  const summary = group.getByRole("button", { name: "Used 4 Shell, Agent, Patch", exact: true })
  await expect(summary).toHaveAttribute("aria-expanded", "false")
  await expect(summary).toHaveCSS("height", "28px")
  await expect(summary.locator('[data-slot="basic-tool-tool-title"]')).toHaveText("Shell, Agent, Patch")
  await expect(summary.locator('[data-component="tag"]')).toHaveCount(0)
  await summary.click()
  await expect(summary).toHaveAttribute("aria-expanded", "true")
  await expect(group.locator('[data-slot="context-tool-group-item"]')).toHaveCount(4)
  await expect(group.locator('[data-timeline-part-id="prt_stack_shell_1"]')).toBeVisible()
  await expect(group.locator('[data-timeline-part-id="prt_stack_patch"]')).toBeVisible()
  await expect(group.locator('[data-component="context-tool-group-list"]')).toHaveCSS("row-gap", "8px")
  const content = group.locator(':scope > [data-component="collapsible"] > [data-slot="collapsible-content"]')
  await expect(content).toHaveCSS("margin-left", "0px")
  await expect(content).toHaveCSS("padding-left", "12px")
  await expect.poll(() => content.evaluate((element) => getComputedStyle(element, "::before").content)).toBe("none")
})

test("leaves tools expanded by settings outside the collapsed stack", async ({ page }) => {
  const parts = [
    shell("prt_expanded_shell", "completed", "expanded"),
    toolPart("prt_collapsed_patch", "patch", "completed", { patchText: "Update src/value.ts" }),
    toolPart("prt_collapsed_read", "read", "completed", { path: "src/value.ts" }),
  ]
  await setupTimeline(page, {
    messages: [userMessage(), assistantMessage(parts)],
    settings: { shellToolPartsExpanded: true },
  })

  await expect(page.locator('[data-timeline-part-id="prt_expanded_shell"]')).toBeVisible()
  const group = page.locator('[data-timeline-part-ids="prt_collapsed_patch,prt_collapsed_read"]')
  await expect(group.getByRole("button", { name: "Used 2 Patch, Read", exact: true })).toBeVisible()
  await expect(group.locator('[data-slot="basic-tool-tool-title"]')).toHaveText("Patch, Read")
  await expect(page.locator('[data-timeline-spacing="tool"]')).toHaveCSS("padding-top", "8px")
})

test("combines follow-up patches into one three-file stack inside Used", async ({ page }) => {
  const file = (path: string, before: number, after: number) => ({
    file: path,
    status: "modified",
    additions: 1,
    deletions: 1,
    patch: createTwoFilesPatch(
      path,
      path,
      `export const value = ${before}\n`,
      `export const value = ${after}\n`,
      "",
      "",
      { context: Infinity },
    ),
  })
  const timeline = await setupTimeline(page, {
    messages: [
      userMessage(),
      assistantMessage([
        shell("patch_shell", "completed"),
        toolPart(
          "patch_first",
          "patch",
          "completed",
          {},
          {
            metadata: { files: [file("src/a.ts", 0, 1), file("src/b.ts", 0, 1)] },
          },
        ),
      ]),
    ],
  })
  const group = page.locator('[data-component="collapsed-tool-group"]')
  await group.getByRole("button", { name: "Used 2 Shell, Patch", exact: true }).click()
  await expect(group.locator('[data-slot="apply-patch-filename"]')).toHaveText(["a.ts", "b.ts"])
  await timeline.send(
    partUpdated(
      toolPart(
        "patch_next",
        "patch",
        "completed",
        {},
        {
          metadata: { files: [file("src/a.ts", 1, 2), file("src/c.ts", 0, 1)] },
        },
      ),
    ),
  )
  await expect(group.getByRole("button", { name: "Used 3 Shell, Patch", exact: true })).toHaveAttribute(
    "aria-expanded",
    "true",
  )
  await expect(group.locator('[data-component="apply-patch-tool"]')).toHaveCount(1)
  await expect(group.locator('[data-slot="apply-patch-filename"]')).toHaveText(["a.ts", "b.ts", "c.ts"])
})

test("keeps failed search calls and their error cards inside the collapsed stack", async ({ page }) => {
  const parts = [
    toolPart(
      "prt_error_glob",
      "glob",
      "error",
      { path: "C:/Users", pattern: "*.ts" },
      {
        error: "Invalid tool input",
      },
    ),
    toolPart(
      "prt_error_grep",
      "grep",
      "error",
      { path: "C:/Users", pattern: "value" },
      {
        error: "Search timed out after 30 seconds",
      },
    ),
  ]
  await setupTimeline(page, { messages: [userMessage(), assistantMessage(parts)] })

  const group = page.locator('[data-component="collapsed-tool-group"]')
  const summary = group.getByRole("button", { name: "Used 2 Glob, Grep", exact: true })
  await expect(summary).toHaveAttribute("aria-expanded", "false")
  await summary.click()
  await expect(group.locator('[data-kind="tool-error-card"]')).toHaveCount(2)
  const glob = group.locator('[data-timeline-part-id="prt_error_glob"]')
  await expect(glob.getByRole("button")).toHaveAttribute("aria-expanded", "false")
  await glob.getByRole("button").click()
  await expect(glob).toContainText("Invalid tool input")
  await expect(glob.locator('[data-component="tool-error-card-icon"]')).toBeVisible()
  await expect(glob.locator('[data-component="tool-error-card-icon"] use')).toHaveAttribute(
    "href",
    "#opencode-v2-icon-outline-hexagonal-warning",
  )
  await expect
    .poll(() =>
      glob
        .locator('[data-kind="tool-error-card"]')
        .evaluate((element) => getComputedStyle(element, "::before").display),
    )
    .toBe("none")
  await group.locator('[data-timeline-part-id="prt_error_grep"]').getByRole("button").click()
  await expect(group.locator('[data-timeline-part-id="prt_error_grep"]')).toContainText(
    "Search timed out after 30 seconds",
  )
})
