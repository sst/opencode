import { expect, test } from "@playwright/test"
import type { OpenCodeEvent, SessionMessageInfo } from "@opencode/client/promise"
import { timelinePresets } from "@opencode/session-ui/timeline/detail"
import { mockOpenCodeServer } from "../utils/mock-server"
import { fixture } from "../performance/timeline/session-timeline-stress.fixture"
import { installStressSessionTabs, stressSessionHref } from "../performance/timeline/timeline-test-helpers"
import { waitForStableTimeline } from "../performance/timeline/session-tab-switch-probe"

test.use({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" })

test("recovers from a failed cold history load when another session is selected", async ({ page }) => {
  await mockOpenCodeServer(page, {
    ...fixture,
    pageMessages: (id) => ({
      items: [{ id: `msg_${id}`, type: "user", text: `History for ${id}`, time: { created: 1 } }],
    }),
  })
  await page.route(`**/api/session/${fixture.targetID}/message?*`, (route) =>
    route.fulfill({ status: 500, json: { message: "History unavailable" } }),
  )
  await installStressSessionTabs(page)
  await page.goto(stressSessionHref(fixture.sourceID))
  await expect(page.getByText(`History for ${fixture.sourceID}`, { exact: true })).toBeVisible()
  await page.locator(`[data-titlebar-tab-link][href="${stressSessionHref(fixture.targetID)}"]`).click()
  await expect(page.getByRole("heading", { name: "Something went wrong", exact: true })).toBeVisible()
  await page.locator(`[data-titlebar-tab-link][href="${stressSessionHref(fixture.sourceID)}"]`).click()
  await expect(page.getByText(`History for ${fixture.sourceID}`, { exact: true })).toBeVisible()
  await expect(page.getByRole("heading", { name: "Something went wrong", exact: true })).toHaveCount(0)
})

test("focuses Find in the selected cached timeline", async ({ page }) => {
  await mockOpenCodeServer(page, {
    ...fixture,
    pageMessages: (id) => ({
      items: [{ id: `msg_${id}`, type: "user", text: `History for ${id}`, time: { created: 1 } }],
    }),
  })
  await installStressSessionTabs(page)
  await page.goto(stressSessionHref(fixture.sourceID))
  await expect(page.getByText(`History for ${fixture.sourceID}`, { exact: true })).toBeVisible()
  await page.locator(`[data-titlebar-tab-link][href="${stressSessionHref(fixture.targetID)}"]`).click()
  await expect(page.getByText(`History for ${fixture.targetID}`, { exact: true })).toBeVisible()
  await page.locator(`[data-titlebar-tab-link][href="${stressSessionHref(fixture.sourceID)}"]`).click()
  await expect(page.getByText(`History for ${fixture.sourceID}`, { exact: true })).toBeVisible()
  await page.keyboard.press("ControlOrMeta+f")
  const search = page.locator('[data-component="timeline-search-bar"] input')
  await expect(search).toBeFocused()
  await page.keyboard.type("History")
  await expect(search).toHaveValue("History")
  await page.locator(`[data-titlebar-tab-link][href="${stressSessionHref(fixture.targetID)}"]`).click()
  await expect(page.getByText(`History for ${fixture.targetID}`, { exact: true })).toBeVisible()
  await page.keyboard.press("ControlOrMeta+f")
  await expect(search).toBeFocused()
  await search.press("Escape")
  await expect(search).toHaveCount(0)
})

test("disposes the old workspace's shell while destination history is loading", async ({ page }) => {
  const destination = "C:/OpenCode/OtherProject"
  const requested = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const reads: string[] = []
  const output = { text: "Initial shell output\n" }
  await mockOpenCodeServer(page, {
    ...fixture,
    sessions: fixture.sessions.map((session) =>
      session.id === fixture.targetID ? { ...session, directory: destination } : session,
    ),
    pageMessages: (id) => ({
      items:
        id === fixture.sourceID
          ? ([
              { id: "msg_workspace_source", type: "user", text: "Follow the shell", time: { created: 1 } },
              {
                id: "msg_workspace_shell",
                type: "assistant",
                agent: "build",
                model: { id: "claude-opus-4-6", providerID: "opencode" },
                time: { created: 2 },
                content: [
                  {
                    type: "tool",
                    id: "call_workspace_shell",
                    name: "shell",
                    time: { created: 2 },
                    state: {
                      status: "running",
                      input: { command: "run checks" },
                      metadata: { shellID: "sh_workspace_source" },
                    },
                  },
                ],
              },
            ] satisfies SessionMessageInfo[])
          : [],
    }),
    beforeMessagesResponse: async ({ sessionID }) => {
      if (sessionID !== fixture.targetID) return
      requested.resolve()
      await release.promise
    },
  })
  await page.route("**/api/shell/sh_workspace_source/output?*", (route) => {
    const url = new URL(route.request().url())
    const directory = url.searchParams.get("location[directory]")!
    reads.push(directory)
    if (directory !== fixture.directory)
      return route.fulfill({ status: 404, json: { _tag: "ShellNotFoundError", id: "sh_workspace_source" } })
    return route.fulfill({
      json: {
        location: { directory },
        data: {
          output: output.text.slice(Number(url.searchParams.get("cursor") ?? 0)),
          cursor: output.text.length,
          size: output.text.length,
          truncated: false,
        },
      },
    })
  })
  await installStressSessionTabs(page)
  await page.addInitScript(
    (detail) =>
      localStorage.setItem(
        "settings.v3",
        JSON.stringify({
          general: {
            timelineDetail: { ...detail, shell: { placement: "separate", details: "expanded" } },
          },
        }),
      ),
    timelinePresets[2].value,
  )
  await page.goto(stressSessionHref(fixture.sourceID))
  const shell = page.locator('[data-timeline-part-id="call_workspace_shell"]')
  await expect(shell.locator('[data-slot="bash-result"]')).toContainText("Initial shell output")
  const original = await page.locator("[data-timeline-virtual-content]").elementHandle()
  try {
    await page.locator(`[data-titlebar-tab-link][href="${stressSessionHref(fixture.targetID)}"]`).click()
    await requested.promise
    await expect(page.locator("[data-session-title]")).toHaveText(fixture.expected.targetTitle)
    output.text += "Output after returning\n"
    await page.locator(`[data-titlebar-tab-link][href="${stressSessionHref(fixture.sourceID)}"]`).click()
    await expect(shell.locator('[data-slot="bash-result"]')).toContainText("Output after returning")
    expect(await original!.evaluate((element) => element.isConnected)).toBe(false)
    expect(reads.length).toBeGreaterThan(1)
    expect(reads.every((directory) => directory === fixture.directory)).toBe(true)
  } finally {
    release.resolve()
  }
})

test("loads the transcript code font before opening rich history", async ({ page }) => {
  const font = page.waitForResponse((response) => /IBMPlexMono-Text[^/]*\.woff2/.test(response.url()))
  await mockOpenCodeServer(page, {
    directory: fixture.directory,
    project: fixture.project,
    provider: fixture.provider,
    sessions: fixture.sessions,
    pageMessages: () => ({
      items: [{ id: "msg_font_source", type: "user", text: "A transcript with no code", time: { created: 1 } }],
    }),
  })
  await installStressSessionTabs(page)
  await page.goto(stressSessionHref(fixture.sourceID))
  await expect(page.getByText("A transcript with no code", { exact: true })).toBeVisible()
  expect((await font).ok()).toBe(true)
  await expect.poll(() => page.evaluate(() => document.fonts.check('440 13px "IBM Plex Mono"'))).toBe(true)
})

test("waits for the requested session's history before constructing its cold timeline", async ({ page }) => {
  const requested = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  await mockOpenCodeServer(page, {
    directory: fixture.directory,
    project: fixture.project,
    provider: fixture.provider,
    sessions: fixture.sessions,
    pageMessages: (id) => ({ items: fixture.messages[id] ?? [] }),
    beforeMessagesResponse: async ({ sessionID }) => {
      if (sessionID !== fixture.targetID) return
      requested.resolve()
      await release.promise
    },
  })
  await installStressSessionTabs(page)
  await page.goto(stressSessionHref(fixture.sourceID))
  await waitForStableTimeline(page, fixture.expected.sourceMessageIDs.at(-1)!)
  try {
    await page.locator(`[data-titlebar-tab-link][href="${stressSessionHref(fixture.targetID)}"]`).click()
    await requested.promise
    await expect(page.locator("[data-timeline-virtual-content]")).toHaveCount(0)
    release.resolve()
    await waitForStableTimeline(page, fixture.expected.targetMessageIDs.at(-1)!)
    await expect(page.locator("[data-timeline-virtual-content]")).toHaveCount(1)
  } finally {
    release.resolve()
  }
})

for (const grouped of [true, false]) {
  test(`restores a ${grouped ? "grouped" : "separate"} timeline after inactive updates and a resize`, async ({
    page,
  }) => {
    const events: OpenCodeEvent[] = []
    const messages: Record<string, SessionMessageInfo[]> = Object.fromEntries(
      [fixture.sourceID, fixture.targetID].map((id) => [
        id,
        [
          { id: `msg_user_${id}`, type: "user", text: `Prompt for ${id}`, time: { created: 1 } },
          {
            id: `msg_assistant_${id}`,
            type: "assistant",
            agent: "build",
            model: { id: "claude-opus-4-6", providerID: "opencode" },
            time: { created: 2, completed: 3 },
            content: [
              {
                type: "tool",
                id: `tool_${id}`,
                name: "shell",
                time: { created: 2, completed: 3 },
                state: {
                  status: "completed",
                  input: { command: `echo ${id}` },
                  metadata: {},
                  content: [{ type: "text", text: `Output for ${id}` }],
                },
              },
              { type: "text", text: `Answer for ${id}` },
            ],
          },
        ] satisfies SessionMessageInfo[],
      ]),
    )
    await mockOpenCodeServer(page, {
      directory: fixture.directory,
      project: fixture.project,
      provider: fixture.provider,
      sessions: fixture.sessions,
      pageMessages: (id) => ({ items: messages[id] ?? [] }),
      events: () => events.splice(0),
    })
    await installStressSessionTabs(page)
    await page.addInitScript(
      ({ grouped, detail }) => {
        localStorage.setItem(
          "settings.v3",
          JSON.stringify({
            general: {
              timelineDetail: {
                ...detail,
                shell: { placement: grouped ? "grouped" : "separate", details: "collapsed" },
              },
            },
          }),
        )
      },
      { grouped, detail: timelinePresets[2].value },
    )
    await page.goto(stressSessionHref(fixture.sourceID))
    await expect(page.getByText(`Answer for ${fixture.sourceID}`, { exact: true })).toBeVisible()
    if (grouped)
      await page
        .locator(
          '[data-component="collapsed-tool-group"] > [data-component="collapsible"] > [data-slot="collapsible-trigger"]',
        )
        .click()
    const shell = page.locator(`[data-timeline-part-id="tool_${fixture.sourceID}"]`)
    const trigger = shell.locator('[data-slot="collapsible-trigger"]')
    await trigger.click()
    await expect(shell.locator('[data-slot="bash-result"]')).toHaveText(`Output for ${fixture.sourceID}`)
    const original = await page.locator("[data-timeline-virtual-content]").elementHandle()

    await page.locator(`[data-titlebar-tab-link][href="${stressSessionHref(fixture.targetID)}"]`).click()
    await expect(page.getByText(`Answer for ${fixture.targetID}`, { exact: true })).toBeVisible()
    await expect(shell).toHaveCount(0)
    expect(await original!.evaluate((element) => element.isConnected)).toBe(false)
    await expect(page.locator("[data-timeline-virtual-content]")).toHaveCount(1)
    events.push({
      id: "evt_cached_text",
      created: 4,
      type: "session.text.ended",
      location: { directory: fixture.directory },
      durable: { aggregateID: fixture.sourceID, seq: 0, version: 1 },
      data: {
        sessionID: fixture.sourceID,
        assistantMessageID: `msg_assistant_${fixture.sourceID}`,
        ordinal: 0,
        text: "Updated while inactive",
      },
    })
    await page.setViewportSize({ width: 900, height: 650 })
    await page.locator(`[data-titlebar-tab-link][href="${stressSessionHref(fixture.sourceID)}"]`).click()
    await expect(page.getByText("Updated while inactive", { exact: true })).toBeVisible()
    await expect(trigger).toHaveAttribute("aria-expanded", "true")
    await expect(shell.locator('[data-slot="bash-result"]')).toHaveText(`Output for ${fixture.sourceID}`)
    expect(await original!.evaluate((element) => element.isConnected)).toBe(true)
    await expect(page.locator("[data-timeline-virtual-content]")).toHaveCount(1)
    await expect
      .poll(() =>
        page
          .locator("[data-timeline-key]")
          .evaluateAll((rows) =>
            rows.every(
              (row) =>
                (row.firstElementChild?.getBoundingClientRect().height ?? 0) <= row.getBoundingClientRect().height + 1,
            ),
          ),
      )
      .toBe(true)
    await trigger.click()
    await expect(trigger).toHaveAttribute("aria-expanded", "false")
  })
}
