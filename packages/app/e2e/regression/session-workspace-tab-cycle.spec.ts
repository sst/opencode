import { expect, test } from "@playwright/test"
import type { OpenCodeEvent, SessionMessageInfo } from "@opencode/client/promise"
import { mockOpenCodeServer } from "../utils/mock-server"
import { fixture } from "../performance/timeline/session-timeline-stress.fixture"
import { installStressSessionTabs, stressSessionHref } from "../performance/timeline/timeline-test-helpers"

test.use({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" })

test("keeps five loaded workspace tabs visible and reactive through repeated switches", async ({ page }, info) => {
  const sessions = Array.from({ length: 5 }, (_, index) => ({
    ...fixture.sessions[0]!,
    id: `ses_workspace_cycle_${index}`,
    directory: `${fixture.directory}/worktree-${index}`,
    title: `Workspace session ${index}`,
  }))
  const events: OpenCodeEvent[] = []
  await mockOpenCodeServer(page, {
    ...fixture,
    sessions,
    pageMessages: (id) => ({
      items: [
        { id: `msg_user_${id}`, type: "user", text: `Prompt for ${id}`, time: { created: 1 } },
        {
          id: `msg_assistant_${id}`,
          type: "assistant",
          agent: "build",
          model: { id: "claude-opus-4-6", providerID: "opencode" },
          time: { created: 2, completed: 3 },
          content: [{ type: "text", text: `Answer for ${id}` }],
        },
      ] satisfies SessionMessageInfo[],
    }),
    events: () => events.splice(0),
  })
  await page.route("**/api/location?*", (route) =>
    route.fulfill({
      json: {
        directory: new URL(route.request().url()).searchParams.get("location[directory]"),
        project: { id: fixture.project.id, directory: fixture.directory, canonical: fixture.directory },
      },
    }),
  )
  await installStressSessionTabs(page, { sessionIDs: sessions.map((session) => session.id) })
  await page.goto(stressSessionHref(sessions[0]!.id))
  await expect(page.getByText(`Answer for ${sessions[0]!.id}`, { exact: true })).toBeVisible()

  for (const session of [...sessions.slice(1), ...sessions, ...sessions.toReversed()]) {
    await page.locator(`[data-titlebar-tab-link][href="${stressSessionHref(session.id)}"]`).click()
    await expect(page.locator(`[data-timeline-part-id="msg_assistant_${session.id}:text:0"]`)).toBeVisible()
    await expect(page.locator("[data-timeline-virtual-content]")).toHaveCSS("visibility", "visible")
  }
  const active = sessions[0]!
  events.push({
    id: "evt_workspace_cycle_update",
    created: 4,
    type: "session.text.ended",
    location: { directory: active.directory },
    durable: { aggregateID: active.id, seq: 0, version: 1 },
    data: {
      sessionID: active.id,
      assistantMessageID: `msg_assistant_${active.id}`,
      ordinal: 0,
      text: "Still receiving updates",
    },
  })
  await expect(page.getByText("Still receiving updates", { exact: true })).toBeVisible()
  await page.screenshot({ path: info.outputPath("workspace-tabs.png") })
})
