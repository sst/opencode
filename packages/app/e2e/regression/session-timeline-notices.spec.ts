import { expect, test } from "@playwright/test"
import type { SessionMessageAssistant, SessionMessageInfo } from "@opencode/client/promise"
import { timelinePresets } from "@opencode/session-ui/timeline/detail"
import {
  compactionDelta,
  compactionEnded,
  compactionFailed,
  compactionStarted,
  directory,
  session,
  sessionID,
  setupTimeline,
} from "../performance/timeline-stability/fixture"

const user = { id: "msg_user", type: "user", text: "Run it", time: { created: 1 } } satisfies SessionMessageInfo

const assistant = (
  completed: boolean,
  tool = false,
  childID?: string,
  background = false,
): SessionMessageAssistant => ({
  id: "msg_assistant",
  type: "assistant",
  agent: "build",
  model: { id: "model", providerID: "provider" },
  content: tool
    ? [
        {
          type: "tool",
          id: "call_subagent",
          name: "subagent",
          state: {
            status: "running",
            input: { description: "Inspect code", ...(background ? { background: true } : {}) },
            metadata: { status: "running", ...(childID ? { sessionID: childID } : {}) },
          },
          time: { created: 2 },
        },
      ]
    : [{ type: "text", text: "Working" }],
  time: { created: 2, ...(completed ? { completed: 3 } : {}) },
})

test("renders current protocol notices in CLI order", async ({ page }) => {
  const ownerWarnings: string[] = []
  page.on("console", (message) => {
    if (message.text().includes("computations created outside a `createRoot` or `render`"))
      ownerWarnings.push(message.text())
  })
  await setupTimeline(page, {
    settings: {
      timelineDetail: { ...timelinePresets[2].value, notices: { placement: "separate" } },
    },
    sessionMessages: [
      user,
      { id: "msg_agent", type: "agent-switched", agent: "explore", time: { created: 2 } },
      assistant(true),
      {
        id: "msg_subagent",
        type: "synthetic",
        text: "done",
        description: "Search code",
        metadata: { source: "subagent", agent: "explore", state: "completed" },
        time: { created: 4 },
      },
      {
        id: "msg_restart",
        type: "synthetic",
        text: "continue",
        description: "Continuing after restart",
        time: { created: 5 },
      },
      { id: "msg_skill", type: "skill", skill: "review", name: "Review", text: "instructions", time: { created: 6 } },
    ],
  })

  const notices = page.locator('[data-slot="session-timeline-notice"]')
  await expect(notices).toHaveCount(4)
  await expect(notices.nth(0)).toHaveText(/^Agent changed\s*Explore$/)
  await expect(notices.nth(1)).toContainText("explore finished · Search code")
  await expect(notices.nth(2)).toContainText("Continuing after restart")
  await expect(notices.nth(3)).toContainText("Skill · Review")
  await expect(notices).toHaveClass([/text-text-weak/, /text-text-weak/, /text-text-weak/, /text-text-weak/])
  await expect(notices.locator(".text-text-strong")).toHaveCount(0)
  expect(ownerWarnings).toEqual([])
})

test("renders compaction progress, summary, and outcome in order", async ({ page }) => {
  const timeline = await setupTimeline(page, {
    settings: {
      timelineDetail: { ...timelinePresets[2].value, notices: { placement: "separate" } },
    },
    sessionMessages: [user, assistant(true)],
    sessionStatus: { [sessionID]: { type: "busy" } },
  })

  await timeline.send(
    compactionStarted({
      sessionID,
      reason: "manual",
      recent: "",
    }),
  )

  const compaction = page.locator('[data-component="session-compaction-message"]')
  await expect(compaction.getByText("Session compaction started", { exact: true })).toBeVisible()
  await expect(compaction.getByRole("status").getByLabel("Compacting", { exact: true })).toBeVisible()
  await expect(compaction.locator('[data-component="text-shimmer"]')).toHaveAttribute("data-active", "true")
  await expect(compaction.getByText("Session compacted", { exact: true })).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible()
  await expect(page.locator('[data-component="session-working"]')).toHaveCount(0)

  await page.setViewportSize({ width: 480, height: 900 })
  await expect(compaction.getByText("Session compaction started", { exact: true })).toBeInViewport()

  await timeline.send(
    compactionDelta({
      sessionID,
      text: "## Checkpoint\n\nStreamed implementation details.",
    }),
  )
  await expect(compaction.getByRole("heading", { name: "Checkpoint" })).toBeVisible()
  await expect(compaction).toContainText("Streamed implementation details.")
  const running = compaction.getByRole("status").getByLabel("Compacting", { exact: true })
  await expect(running).toBeVisible()
  await expect
    .poll(async () => {
      const summary = await compaction.locator('[data-component="text-part"]').boundingBox()
      const status = await running.boundingBox()
      return !!summary && !!status && status.y >= summary.y + summary.height
    })
    .toBe(true)
  await expect(compaction.getByText("Session compacted", { exact: true })).toHaveCount(0)

  await timeline.send(
    compactionEnded({
      sessionID,
      reason: "manual",
      text: "## Checkpoint\n\nFinal implementation details.",
      recent: "",
    }),
  )
  await expect(compaction).toContainText("Final implementation details.")
  await expect(compaction).not.toContainText("Streamed implementation details.")
  await expect(compaction.getByText("Session compaction started", { exact: true })).toBeVisible()
  await expect(compaction.getByText("Session compacted", { exact: true })).toBeVisible()
  await expect
    .poll(async () => {
      const summary = await compaction.locator('[data-component="text-part"]').boundingBox()
      const completed = await compaction.getByText("Session compacted", { exact: true }).boundingBox()
      return !!summary && !!completed && completed.y >= summary.y + summary.height
    })
    .toBe(true)
  await expect(compaction.getByRole("status")).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible()
  await expect(page.locator('[data-component="session-working"]')).toBeVisible()
})

test("updates running compactions to failed and cancelled boundaries", async ({ page }) => {
  const timeline = await setupTimeline(page, { sessionMessages: [user, assistant(true)] })

  await timeline.send(compactionStarted({ sessionID, reason: "auto", recent: "" }))
  await timeline.send(compactionDelta({ sessionID, text: "Partial summary that should be discarded." }))
  await expect(page.getByText("Partial summary that should be discarded.", { exact: true })).toBeVisible()
  await timeline.send(
    compactionFailed({
      sessionID,
      reason: "auto",
      error: {
        type: "compaction.failed",
        message: 'Error: {"error":{"type":"ProviderError","message":"The provider rejected the summary."}}',
      },
    }),
  )

  const compactions = page.locator('[data-component="session-compaction-message"]')
  const failed = compactions.filter({ hasText: "The provider rejected the summary." })
  await expect(failed.getByText("Session compaction started", { exact: true })).toBeVisible()
  await expect(failed.getByText("Session compaction failed", { exact: true })).toBeVisible()
  await expect(failed.getByText("Session compacted", { exact: true })).toHaveCount(0)
  await expect(failed.getByRole("status")).toHaveCount(0)
  await expect(failed.getByText("ProviderError: The provider rejected the summary.", { exact: true })).toBeVisible()
  await expect(failed).not.toContainText("Partial summary that should be discarded.")

  await timeline.send(compactionStarted({ sessionID, reason: "manual", recent: "" }))
  await expect(compactions).toHaveCount(2)
  await timeline.send(compactionDelta({ sessionID, text: "Summary before cancellation." }))
  await expect(page.getByText("Summary before cancellation.", { exact: true })).toBeVisible()
  await timeline.send(
    compactionFailed({
      sessionID,
      reason: "manual",
      error: { type: "aborted", message: "Cancellation detail should stay hidden." },
    }),
  )

  await expect(compactions).toHaveCount(2)
  const cancelled = compactions.filter({ hasNotText: "The provider rejected the summary." })
  await expect(cancelled.getByText("Session compaction started", { exact: true })).toBeVisible()
  await expect(cancelled.getByText("Session compaction cancelled", { exact: true })).toBeVisible()
  await expect(cancelled.getByText("Session compacted", { exact: true })).toHaveCount(0)
  await expect(cancelled.getByRole("status")).toHaveCount(0)
  await expect(cancelled).not.toContainText("Cancellation detail should stay hidden.")
  await expect(cancelled).not.toContainText("Summary before cancellation.")
})

test("shows an interrupted outcome when stopping automatic compaction", async ({ page }) => {
  const timeline = await setupTimeline(page, {
    sessionMessages: [user, assistant(true)],
    sessionStatus: { [sessionID]: { type: "busy" } },
  })
  await timeline.send(compactionStarted({ sessionID, reason: "auto", recent: "" }))
  await timeline.send(compactionDelta({ sessionID, text: "Partial automatic summary." }))
  const compaction = page.locator('[data-component="session-compaction-message"]')
  await expect(compaction.getByRole("status").getByLabel("Compacting", { exact: true })).toBeVisible()
  await expect(compaction).toContainText("Partial automatic summary.")

  const request = page.waitForRequest(
    (request) =>
      request.method() === "POST" && new URL(request.url()).pathname === `/api/session/${sessionID}/interrupt`,
  )
  await page.getByRole("button", { name: "Stop", exact: true }).click()
  await request
  await timeline.send(
    compactionFailed({
      sessionID,
      reason: "auto",
      error: { type: "compaction.interrupted", message: "Compaction was interrupted" },
    }),
  )

  await expect(compaction.getByText("Session compaction started", { exact: true })).toBeVisible()
  await expect(compaction.getByText("Session compaction interrupted", { exact: true })).toBeVisible()
  await expect(compaction.getByText("Session compaction failed", { exact: true })).toHaveCount(0)
  await expect(compaction.getByText("Session compacted", { exact: true })).toHaveCount(0)
  await expect(compaction.getByRole("status")).toHaveCount(0)
  await expect(compaction).not.toContainText("Partial automatic summary.")
  await expect(compaction).not.toContainText("Compaction was interrupted")
})

test("moves blocking work to the background with Ctrl+B", async ({ page }) => {
  await setupTimeline(page, {
    settings: {
      timelineDetail: { ...timelinePresets[2].value, subagents: { placement: "separate" } },
    },
    sessionMessages: [user, assistant(false, true)],
  })
  const card = page.locator('[data-component="task-tool-card"]')
  await expect(card).toBeVisible()
  await expect(card).toContainText("Inspect code")
  await expect(card).not.toContainText("(background)")
  await expect(page.getByText("Called `subagent`", { exact: false })).toHaveCount(0)
  await expect(page.locator('[data-component="background-tool-control"]')).toHaveCount(0)
  const hint = page.getByRole("button", { name: /move running work to the background/i })
  await expect(hint).toBeVisible()
  await expect(page.locator('[data-timeline-row="Thinking"]')).toHaveCount(0)
  await expect
    .poll(async () => {
      const [cardBox, hintBox] = await Promise.all([card.boundingBox(), hint.boundingBox()])
      if (!cardBox || !hintBox) return undefined
      return {
        aligned: Math.abs(cardBox.x - hintBox.x) < 2,
        ordered: cardBox.y < hintBox.y,
      }
    })
    .toEqual({ aligned: true, ordered: true })

  const request = page.waitForRequest(
    (request) =>
      request.method() === "POST" && new URL(request.url()).pathname === `/api/session/${sessionID}/background`,
  )
  await page.keyboard.press("Control+b")
  await request
})

test("navigates from a running subagent card and hides background controls in the child", async ({ page }) => {
  const childID = "ses_running_child"
  await setupTimeline(page, {
    settings: {
      timelineDetail: { ...timelinePresets[2].value, subagents: { placement: "separate" } },
    },
    sessionMessages: [user, assistant(false, true, childID)],
    sessions: [session(), session({ id: childID, parentID: sessionID, title: "Sleep for 5 minutes" })],
    sessionStatus: { [sessionID]: { type: "busy" }, [childID]: { type: "busy" } },
  })

  await expect(page.getByRole("button", { name: /move running work to the background/i })).toBeVisible()
  await page.locator('[data-component="task-tool-card"]').click()
  await expect(page).toHaveURL(new RegExp(`/session/${childID}$`))
  await expect(page.getByRole("button", { name: /move running work to the background/i })).toHaveCount(0)
})

for (const name of ["shell", "subagent"] as const) {
  test(`keeps the background shortcut available for a grouped running ${name}`, async ({ page }) => {
    const message = assistant(false, true)
    await setupTimeline(page, {
      settings: { timelineDetail: timelinePresets[2].value },
      sessionMessages: [
        user,
        {
          ...message,
          content: [
            {
              type: "tool",
              id: "call_read",
              name: "read",
              state: {
                status: "completed",
                input: { path: "src/example.ts" },
                content: [{ type: "text", text: "export const example = true" }],
                metadata: {},
              },
              time: { created: 1, completed: 2 },
            },
            {
              type: "tool",
              id: "call_running",
              name,
              state: {
                status: "running",
                input:
                  name === "shell" ? { command: "echo checking" } : { agent: "general", description: "Inspect code" },
                metadata: {},
              },
              time: { created: 3 },
            },
          ],
        },
      ],
    })
    const group = page.locator('[data-timeline-part-ids="call_read,call_running"]')
    await expect(group).toBeVisible()
    await expect(group.locator('[data-slot="collapsible-trigger"]')).toHaveAttribute("aria-expanded", "false")
    await expect(page.getByRole("button", { name: /move running work to the background/i })).toBeVisible()
    const request = page.waitForRequest(
      (request) =>
        request.method() === "POST" && new URL(request.url()).pathname === `/api/session/${sessionID}/background`,
    )
    await page.keyboard.press("Control+b")
    await request
  })
}

test("shows a badge for active background work", async ({ page }) => {
  const childID = "ses_background_child"
  await setupTimeline(page, {
    sessionMessages: [user, assistant(true)],
    sessions: [session(), session({ id: childID, parentID: sessionID })],
    sessionStatus: { [childID]: { type: "busy" } },
  })

  await page.getByRole("button", { name: "Session details" }).click()
  const summary = page.getByRole("button", { name: "1 background task running", exact: true })
  await expect(summary).toContainText("1")
  await expect(summary).toContainText("1 background task running")
  await summary.click()
  await expect(
    page.locator('[data-component="session-background-list"]').getByText("Agent", { exact: true }),
  ).toBeVisible()
})

test("separates blocking and already-backgrounded work into two rows", async ({ page }) => {
  const backgroundID = "ses_background_existing"
  const blockingID = "ses_background_blocking"
  const timeline = await setupTimeline(page, {
    settings: { timelineDetail: timelinePresets[2].value },
    sessionMessages: [
      user,
      {
        id: "msg_backgrounded",
        type: "assistant",
        agent: "build",
        model: { id: "model", providerID: "provider" },
        content: [
          {
            type: "tool",
            id: "call_backgrounded",
            name: "subagent",
            state: {
              status: "completed",
              input: { description: "Background task" },
              content: [{ type: "text", text: "working" }],
              metadata: { sessionID: backgroundID, status: "running" },
            },
            time: { created: 2, completed: 3 },
          },
          {
            type: "tool",
            id: "call_shell_backgrounded",
            name: "shell",
            state: {
              status: "completed",
              input: { command: "sleep 120" },
              content: [{ type: "text", text: "working" }],
              metadata: { shellID: "shell_backgrounded", status: "running" },
            },
            time: { created: 2, completed: 3 },
          },
        ],
        time: { created: 2, completed: 3 },
      },
      {
        id: "msg_blocking",
        type: "assistant",
        agent: "build",
        model: { id: "model", providerID: "provider" },
        content: [
          {
            type: "tool",
            id: "call_blocking",
            name: "subagent",
            state: {
              status: "running",
              input: { description: "Foreground task" },
              metadata: { sessionID: blockingID },
            },
            time: { created: 4 },
          },
        ],
        time: { created: 4 },
      },
    ],
    sessions: [
      session(),
      session({ id: backgroundID, parentID: sessionID, title: "Background task" }),
      session({ id: blockingID, parentID: sessionID, title: "Foreground task" }),
    ],
    sessionStatus: {
      [sessionID]: { type: "busy" },
      [backgroundID]: { type: "busy" },
      [blockingID]: { type: "busy" },
    },
  })

  await timeline.transport.send({
    id: "evt_background_shell_created",
    created: 3,
    type: "shell.created",
    location: { directory },
    data: {
      info: {
        id: "shell_backgrounded",
        status: "running",
        command: "sleep 120",
        cwd: directory,
        shell: "bash",
        file: "/tmp/background.out",
        metadata: { sessionID },
        time: { started: 2 },
      },
    },
  })
  const backgroundCard = page.locator('[data-timeline-part-id="call_backgrounded"]')
  await expect(page.getByRole("button", { name: /move running work to the background/i })).toBeVisible()
  const used = page
    .locator('[data-timeline-part-ids="call_backgrounded,call_shell_backgrounded,call_blocking"]')
    .locator(':scope > [data-component="collapsible"] > [data-slot="collapsible-trigger"]')
  await expect(used).toHaveText(/^Used\s*3\s*Agent, Shell$/)
  await expect(used).toHaveAttribute("aria-expanded", "false")
  await used.click()
  await expect(used).toHaveAttribute("aria-expanded", "true")
  await page.getByRole("button", { name: "Session details" }).click()
  const summary = page.getByRole("button", { name: "2 background tasks running", exact: true })
  await expect(summary).toContainText("2")
  await summary.click()
  const list = page.locator('[data-component="session-background-list"]')
  await expect(list).toContainText("Background task")
  await expect(list).toContainText("sleep 120")
  await expect(list).not.toContainText("Foreground task")
  await expect(backgroundCard).toContainText("Background task (background)")
  await expect(backgroundCard.locator('[data-component="session-progress-indicator-v2"]')).toBeVisible()
  await expect(
    page.locator('[data-timeline-part-id="call_shell_backgrounded"] [data-component="text-shimmer"]'),
  ).toHaveAttribute("data-active", "true")

  await timeline.transport.send({
    id: "evt_background_succeeded",
    created: Date.now(),
    type: "session.execution.succeeded",
    data: { sessionID: backgroundID },
  } as never)
  await expect(backgroundCard.locator('[data-component="session-progress-indicator-v2"]')).toHaveCount(0)
  await expect(backgroundCard).toContainText("Background task (background)")
})
