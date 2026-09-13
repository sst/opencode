import { expect, test, type Page } from "@playwright/test"
import type { OpenCodeEvent } from "@opencode/client/promise"
import { base64Encode } from "@opencode/util/encode"
import { currentSession, mockOpenCodeServer } from "../utils/mock-server"
import { expectAppVisible } from "../utils/waits"

const directory = "C:/OpenCode/WorkspacePending"
const workspace = "C:/OpenCode/pending-workspace"
const projectID = "proj_workspace_pending"
const draftID = "draft_workspace_pending"
const otherID = "ses_workspace_pending_other"
const text = "Create the workspace, then explain the pending session."
const followUp = "Then explain the setup scripts.\nInclude the install command."
const server = `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`
const sessionPath = `/server/${base64Encode(server)}/session/`
const draftPath = `/new-session?draftId=${draftID}`
const headers = { "access-control-allow-origin": "*" }

test.use({
  serviceWorkers: "block",
  viewport: { width: 1280, height: 900 },
  permissions: ["clipboard-read", "clipboard-write"],
})

for (const viewport of [
  { name: "desktop", width: 1280, height: 900 },
  { name: "mobile", width: 390, height: 844 },
]) {
  test(`keeps Session in the tab until the generated title arrives on ${viewport.name}`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport)
    const mock = await openDraft(page, { untitled: true })
    const label = page.locator(
      viewport.name === "mobile"
        ? '[data-slot="mobile-tab-title"]'
        : '[data-titlebar-tab-slot][data-active="true"] [data-titlebar-tab-title]',
    )
    await expect(label).toHaveText("Session")
    const pending = await submitPending(page, mock)
    const spinner = page.locator(
      viewport.name === "mobile"
        ? '[data-slot="mobile-tabs-trigger"] [data-component="session-progress-indicator-v2"]'
        : `[data-titlebar-tab-link][href="${sessionPath}${pending.sessionID}"] [data-component="session-progress-indicator-v2"]`,
    )
    await expect(spinner).toBeVisible()
    await testInfo.attach("pending-tab-title", {
      body: await page.screenshot(),
      contentType: "image/png",
    })
    await expect(label).toHaveText("Session")

    mock.worktree.resolve({ status: 200, json: { directory: workspace } })
    await expect(pending.shimmer).toHaveCount(0)
    await expect(page.locator('[data-action="composer-submit"]')).toBeEnabled()
    await expect(label).toHaveText("Session")

    if (viewport.name === "mobile") {
      await label.click()
      const drawer = page.locator('[data-slot="mobile-tabs-drawer"]')
      const tab = drawer.locator(`[data-titlebar-tab-link][href="${sessionPath}${pending.sessionID}"]`)
      await expect(tab.locator("[data-titlebar-tab-title]")).toHaveText("Session")
      await tab.click()
      await expect(drawer).toBeHidden()
    }

    mock.events.push({
      id: "evt_generated_title",
      type: "session.renamed",
      created: Date.now(),
      location: { directory: workspace },
      durable: { aggregateID: pending.sessionID, seq: 1, version: 1 },
      data: { sessionID: pending.sessionID, title: "Generated session title" },
    })
    await expect(label).toHaveText("Generated session title")
  })

  test(`shows a pending workspace session immediately on ${viewport.name}`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport)
    const mock = await openDraft(page)
    const pending = await submitPending(page, mock)
    const editor = page.locator('[data-component="composer-editor"]')
    await draftFollowUp(page)
    await expect(page.locator('[data-action="composer-submit"]')).toBeDisabled()
    await editor.press("Enter")
    await editor.press("ControlOrMeta+Enter")
    await page.locator('[data-component="composer"]').dispatchEvent("submit")
    await expect(editor).toHaveText(followUp)
    await expect(editor).toBeInViewport()

    expect(mock.worktreeRequests).toEqual([expect.objectContaining({ from: directory })])
    await expect(pending.message).toBeInViewport()
    await expect(pending.shimmer).toBeInViewport()
    await expect(pending.title).toBeInViewport()
    const spinner = page.locator(
      viewport.name === "mobile"
        ? '[data-slot="mobile-tabs-trigger"] [data-component="session-progress-indicator-v2"]'
        : `[data-titlebar-tab-link][href="${sessionPath}${pending.sessionID}"] [data-component="session-progress-indicator-v2"]`,
    )
    await expect(spinner).toBeVisible()
    await testInfo.attach("creating-worktree", {
      body: await page.screenshot({ path: testInfo.outputPath(`pending-${viewport.name}.png`) }),
      contentType: "image/png",
    })

    if (viewport.name === "mobile") {
      await page.locator('[data-slot="mobile-tabs-trigger"]').click()
      const drawer = page.locator('[data-slot="mobile-tabs-drawer"]')
      const tab = drawer.locator(`[data-titlebar-tab-link][href="${sessionPath}${pending.sessionID}"]`)
      await expect(tab.locator('[data-component="session-progress-indicator-v2"]')).toBeVisible()
      await tab.click()
      await expect(drawer).toBeHidden()
      await page.locator("html").evaluate((element) => {
        element.setAttribute("dir", "rtl")
      })
      await expect(page.locator("html")).toHaveAttribute("dir", "rtl")
      await expect(pending.message).toBeInViewport()
      await expect(pending.shimmer).toBeInViewport()
      await expect(pending.title).toBeInViewport()
      await expect(page.locator('[data-component="session-preparing"]')).toHaveCSS("direction", "rtl")
      expect(
        await page
          .locator('[data-component="session-preparing"]')
          .evaluate((element) => element.scrollWidth <= element.clientWidth),
      ).toBe(true)
    }

    if (viewport.name === "desktop") {
      await page.locator(`[data-titlebar-tab-link][href="${sessionPath}${otherID}"]`).click()
      await expect(page).toHaveURL(`${sessionPath}${otherID}`)
      await expect(page.locator('[data-component="composer-editor"]')).toBeEditable()
      await expect(pending.shimmer).toBeHidden()
      await expect(spinner).toBeVisible()

      await page.locator(`[data-titlebar-tab-link][href="${sessionPath}${pending.sessionID}"]`).click()
      await expect(page).toHaveURL(pending.url)
      await expect(pending.message).toHaveAttribute("data-timeline-part-id", `${pending.messageID}:text:0`)
      await expect(pending.shimmer).toHaveAttribute("data-active", "true")
      await expect(pending.title).toHaveText("Session")
      await expect(editor).toHaveText(followUp)
      expect(mock.calls).toEqual(["worktree"])

      await page.locator(`[data-titlebar-tab-link][href="${sessionPath}${otherID}"]`).click()
      await expect(page).toHaveURL(`${sessionPath}${otherID}`)
      await page.locator('[data-component="composer-editor"]').fill("Keep focus in this other session")
      await expect(page.locator('[data-component="composer-editor"]')).toBeFocused()
    }

    expect(mock.calls).toEqual(["worktree"])
    mock.worktree.resolve({ status: 200, json: { directory: workspace } })
    await expect
      .poll(() => mock.prompts)
      .toEqual([{ sessionID: pending.sessionID, body: expect.objectContaining({ id: pending.messageID, text }) }])
    expect(mock.creates).toEqual([
      expect.objectContaining({ id: pending.sessionID, location: { directory: workspace } }),
    ])
    expect(mock.calls).toEqual(["worktree", "session", "prompt"])

    if (viewport.name === "desktop") {
      await expect(page.locator(`[data-titlebar-tab-link][href="${sessionPath}${pending.sessionID}"]`)).toContainText(
        "Created workspace session",
      )
      await expect(page).toHaveURL(`${sessionPath}${otherID}`)
      await expect(page.locator('[data-component="composer-editor"]')).toHaveText("Keep focus in this other session")
      await expect(page.locator('[data-component="composer-editor"]')).toBeFocused()
      await page.locator(`[data-titlebar-tab-link][href="${sessionPath}${pending.sessionID}"]`).click()
    }

    await expect(page).toHaveURL(pending.url)
    await expect(pending.shimmer).toHaveCount(0)
    await expect(spinner).toHaveCount(1)
    await expect(pending.message).toHaveCount(1)
    await expect(pending.message.locator('[data-slot="user-message-text"]')).toHaveText(text)
    await expect(pending.message).toHaveAttribute("data-timeline-part-id", `${pending.messageID}:text:0`)
    await expect(editor).toHaveText(followUp)
    await expect(page.locator('[data-action="composer-submit"]')).toBeEnabled()
    expect(mock.prompts).toHaveLength(1)
    await page.locator('[data-action="composer-submit"]').click()
    await expect
      .poll(() => mock.prompts)
      .toEqual([
        { sessionID: pending.sessionID, body: expect.objectContaining({ id: pending.messageID, text }) },
        { sessionID: pending.sessionID, body: expect.objectContaining({ text: followUp }) },
      ])
  })
}

for (const direction of ["ltr", "rtl"]) {
  test(`keeps the title and message stable through worktree creation in ${direction}`, async ({ page }) => {
    const mock = await openDraft(page)
    await page.locator("html").evaluate((element, direction) => element.setAttribute("dir", direction), direction)
    const pending = await submitPending(page, mock)
    await draftFollowUp(page)
    await page.locator('[data-component="composer-editor"]').press("ControlOrMeta+Home")
    const title = page.locator("[data-session-title]").getByRole("heading", { level: 1 })
    const before = await title.boundingBox()
    const messageBefore = await pending.message.boundingBox()
    // Observe painted frames during the handoff, without using frame counts to wait for readiness.
    const observation = await page.evaluateHandle(() => {
      const frames: { title: string | null; message: boolean; spinner: boolean; draft: string | null }[] = []
      let frame = 0
      const sample = () => {
        const title = document.querySelector<HTMLElement>("[data-session-title] h1")
        const message = document.querySelector<HTMLElement>('[data-component="user-message"]')
        const spinner = document.querySelector(
          '[data-titlebar-tab-slot][data-active="true"] [data-component="session-progress-indicator-v2"]',
        )
        const editor = document.querySelector('[data-component="composer-editor"]')
        frames.push({
          title: title?.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true }) ? title.textContent : null,
          message: !!message?.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true }),
          spinner: !!spinner?.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true }),
          draft: editor?.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true }) ? editor.textContent : null,
        })
        frame = requestAnimationFrame(sample)
      }
      sample()
      return {
        stop: () => {
          cancelAnimationFrame(frame)
          return frames
        },
      }
    })

    mock.worktree.resolve({ status: 200, json: { directory: workspace } })

    await expect(title).toHaveText("Created workspace session")
    await expect(pending.shimmer).toHaveCount(0)
    await expect(pending.message.locator('[data-slot="user-message-text"]')).toHaveText(text)
    await expect(page.locator('[data-component="composer-editor"]')).toBeEditable()
    await expect(page.locator('[data-component="composer-editor"]')).toHaveText(followUp)
    await expect(page.locator('[data-component="composer-editor"]')).toBeFocused()
    const frames = await observation.evaluate((observation) => observation.stop())
    await observation.dispose()
    expect(frames.length).toBeGreaterThan(0)
    expect(
      frames.filter(
        (frame) =>
          !frame.message ||
          !frame.spinner ||
          frame.draft !== followUp ||
          !["Session", "Created workspace session"].includes(frame.title ?? ""),
      ),
    ).toEqual([])
    const after = await title.boundingBox()
    const messageAfter = await pending.message.boundingBox()
    expect(after?.y).toBe(before?.y)
    expect(after?.height).toBe(before?.height)
    expect(messageAfter).toEqual(messageBefore)
    await page.locator('[data-component="composer-editor"]').pressSequentially("Also: ")
    await expect(page.locator('[data-component="composer-editor"]')).toHaveText(`Also: ${followUp}`)
    await expect.poll(() => mock.calls).toEqual(["worktree", "session", "prompt"])
  })
}

for (const failure of ["worktree", "session"]) {
  test(`preserves both inputs when ${failure} creation fails`, async ({ page }) => {
    const mock = await openDraft(page, { failSessionCreate: failure === "session" })
    const pending = await submitPending(page, mock)
    await draftFollowUp(page)

    mock.worktree.resolve(
      failure === "worktree"
        ? { status: 500, json: { message: "Worktree creation failed" } }
        : { status: 200, json: { directory: workspace } },
    )

    await expect(page).toHaveURL(draftPath)
    await expect(page.locator('[data-component="composer-editor"]')).toHaveText(`${text}\n\n${followUp}`)
    await expect(page.locator('[data-action="composer-submit"]')).toBeEnabled()
    await expect(pending.shimmer).toHaveCount(0)
    expect(mock.prompts).toEqual([])
  })
}

test("preserves both inputs when the initial prompt cannot be sent", async ({ page }) => {
  const mock = await openDraft(page)
  const pending = await submitPending(page, mock)
  await draftFollowUp(page)
  await page.route(`**/api/session/${pending.sessionID}/prompt`, (route) =>
    route.fulfill({
      status: 500,
      json: { message: "Prompt admission failed" },
      headers,
    }),
  )

  mock.worktree.resolve({ status: 200, json: { directory: workspace } })

  await expect(pending.shimmer).toHaveCount(0)
  await expect(page.locator('[data-component="composer-editor"]')).toHaveText(`${text}\n\n${followUp}`)
  await expect(page.locator('[data-action="composer-submit"]')).toBeEnabled()
  await expect.poll(() => mock.calls).toEqual(["worktree", "session", "prompt", "prompt"])
  expect(mock.prompts).toEqual([])
})

test("restores the original draft when worktree creation fails", async ({ page }) => {
  const mock = await openDraft(page)
  const pending = await submitPending(page, mock)

  mock.worktree.resolve({ status: 500, json: { message: "Worktree creation failed in the fixture" } })

  await expect(page).toHaveURL(draftPath)
  await expect(page.getByText("Failed to create worktree", { exact: true })).toBeVisible()
  await expect(page.locator('[data-component="composer-editor"]')).toHaveText(text)
  await expect(page.locator('[data-action="composer-submit"]')).toBeEnabled()
  await expect(page.getByRole("button", { name: "New worktree", exact: true })).toBeVisible()
  await expect(pending.shimmer).toHaveCount(0)
  await expect(pending.message).toHaveCount(0)
  await expect(page.locator(`[data-titlebar-tab-link][href="${sessionPath}${pending.sessionID}"]`)).toHaveCount(0)
  expect(mock.calls).toEqual(["worktree"])
  expect(mock.creates).toEqual([])
  expect(mock.prompts).toEqual([])
})

test("retains the draft and reuses the created workspace after session creation fails", async ({ page }) => {
  const mock = await openDraft(page, { failSessionCreate: true })
  const pending = await submitPending(page, mock)

  mock.worktree.resolve({ status: 200, json: { directory: workspace } })

  await expect(page).toHaveURL(draftPath)
  await expect(page.getByText("Failed to create session", { exact: true })).toBeVisible()
  await expect(page.locator('[data-component="composer-editor"]')).toHaveText(text)
  await expect(page.locator('[data-action="composer-submit"]')).toBeEnabled()
  await expect(page.getByRole("button", { name: "pending-workspace", exact: true })).toBeVisible()
  await expect(pending.shimmer).toHaveCount(0)
  await expect(pending.message).toHaveCount(0)
  expect(mock.creates).toEqual([expect.objectContaining({ id: pending.sessionID, location: { directory: workspace } })])
  expect(mock.calls).toEqual(["worktree", "session"])
  expect(mock.prompts).toEqual([])

  await page.locator('[data-action="composer-submit"]').click()

  await expect.poll(() => mock.prompts.length).toBe(1)
  expect(mock.creates).toHaveLength(2)
  expect(mock.creates[1]).toMatchObject({ location: { directory: workspace } })
  expect(mock.prompts[0]).toMatchObject({ sessionID: mock.creates[1].id, body: { text } })
  expect(mock.calls).toEqual(["worktree", "session", "session", "prompt"])
  await expect(page).toHaveURL(`${sessionPath}${mock.creates[1].id}`)
  await expect(page.locator('[data-component="user-message"] [data-slot="user-message-text"]')).toHaveText(text)
})

test("restores the draft after closing and revisiting a pending session that fails", async ({ page }) => {
  const mock = await openDraft(page)
  const pending = await submitPending(page, mock)
  await draftFollowUp(page)
  const tab = page.locator(`[data-titlebar-tab-link][href="${sessionPath}${pending.sessionID}"]`)

  await page.locator("[data-titlebar-tab-slot]").filter({ has: tab }).locator('[data-slot="tab-close"] button').click()

  await expect(page).toHaveURL(`${sessionPath}${otherID}`)
  await expect(page.locator('[data-component="composer-editor"]')).toBeEditable()
  await expect(tab).toHaveCount(0)
  await expect(pending.shimmer).toHaveCount(0)

  await page.goBack()

  await expect(page).toHaveURL(pending.url)
  await expect(tab).toHaveCount(1)
  await expect(tab).toBeVisible()
  await expect(pending.message).toHaveCount(1)
  await expect(pending.message.locator('[data-slot="user-message-text"]')).toHaveText(text)
  await expect(pending.message).toHaveAttribute("data-timeline-part-id", `${pending.messageID}:text:0`)
  await expect(pending.shimmer).toBeVisible()
  await expect(pending.shimmer).toContainText("Creating worktree")
  await expect(pending.shimmer).toHaveAttribute("data-active", "true")
  await expect(page.locator('[data-component="composer-editor"]')).toHaveText(followUp)
  expect(mock.calls).toEqual(["worktree"])

  mock.worktree.resolve({ status: 500, json: { message: "Worktree creation failed after revisiting the session" } })

  await expect(page).toHaveURL(draftPath)
  await expect(page.getByText("Failed to create worktree", { exact: true })).toBeVisible()
  await expect(page.locator('[data-component="composer-editor"]')).toHaveText(`${text}\n\n${followUp}`)
  await expect(page.locator('[data-action="composer-submit"]')).toBeEnabled()
  await expect(page.getByRole("button", { name: "New worktree", exact: true })).toBeVisible()
  await expect(page.locator(`[data-titlebar-tab-link][href="${draftPath}"]`)).toHaveCount(1)
  await expect(tab).toHaveCount(0)
  await expect(pending.shimmer).toHaveCount(0)
  await expect(pending.message).toHaveCount(0)
  expect(mock.calls).toEqual(["worktree"])
  expect(mock.creates).toEqual([])
  expect(mock.prompts).toEqual([])
})

test("executes a selected slash command after creating its worktree", async ({ page }, testInfo) => {
  const events: OpenCodeEvent[] = []
  const mock = await openDraft(page, { command: true, events: () => events.splice(0) })
  const commands: { sessionID: string; body: Record<string, unknown> }[] = []
  const expanded =
    "Review the latest commit for correctness and regressions. Check the relevant tests and report actionable findings."
  await page.route("**/api/session/*/command", async (route) => {
    if (route.request().method() !== "POST") return route.fallback()
    const sessionID = new URL(route.request().url()).pathname.split("/")[3]
    commands.push({ sessionID, body: route.request().postDataJSON() })
    // The server owns command expansion; the client receives the expanded inbox item.
    events.push({
      id: "evt_workspace_review",
      type: "session.inbox.enqueued",
      created: Date.now(),
      durable: { aggregateID: sessionID, seq: 1, version: 1 },
      data: {
        sessionID,
        inboxID: "msg_workspace_review",
        item: { type: "user", payload: { text: expanded }, delivery: "steer" },
      },
    })
    await route.fulfill({ status: 204, headers })
  })
  const editor = page.locator('[data-component="composer-editor"]')
  await editor.fill("/review")
  const suggestion = page.getByRole("button", { name: "/review Review changes", exact: true })
  await expect(suggestion).toBeVisible()
  await suggestion.click()
  await expect(editor).toHaveText("/review")
  const pending = await submitPending(page, mock, "/review latest commit")
  await draftFollowUp(page)

  mock.worktree.resolve({ status: 200, json: { directory: workspace } })

  await expect
    .poll(() => commands)
    .toEqual([
      {
        sessionID: pending.sessionID,
        body: { command: "review", text: "latest commit", files: [], agents: [], skills: [], delivery: "steer" },
      },
    ])
  await expect(pending.shimmer).toHaveCount(0)
  await expect(page.locator('[data-slot="user-message-text"]')).toHaveText(expanded)
  await expect(editor).toHaveText(followUp)
  await expect(page.locator('[data-action="composer-submit"]')).toBeEnabled()
  expect(mock.creates).toEqual([expect.objectContaining({ id: pending.sessionID, location: { directory: workspace } })])
  expect(mock.prompts).toEqual([])
  await testInfo.attach("expanded-worktree-command", {
    body: await page.screenshot({ path: testInfo.outputPath("expanded-worktree-command.png") }),
    contentType: "image/png",
  })
})

async function draftFollowUp(page: Page) {
  const editor = page.locator('[data-component="composer-editor"]')
  await editor.pressSequentially("!")
  await expect(editor).toHaveText("!")
  await expect(editor).toHaveAttribute("dir", "auto")
  await editor.fill("")
  await page.evaluate((text) => navigator.clipboard.writeText(text), followUp)
  await editor.press("ControlOrMeta+V")
  await expect(editor).toHaveText(followUp)
}

async function openDraft(
  page: Page,
  options?: { failSessionCreate?: boolean; untitled?: boolean; command?: boolean; events?: () => OpenCodeEvent[] },
) {
  const worktree = Promise.withResolvers<{ status: number; json: { directory?: string; message?: string } }>()
  const calls: string[] = []
  const worktreeRequests: Record<string, unknown>[] = []
  const creates: Record<string, unknown>[] = []
  const prompts: { sessionID: string; body: Record<string, unknown> }[] = []
  const events: OpenCodeEvent[] = []
  const project = {
    id: projectID,
    worktree: directory,
    vcs: "git",
    name: "workspace-pending",
    time: { created: 1700000000000, updated: 1700000000000 },
    sandboxes: [] as string[],
  }
  const sessions = [currentSession({ id: otherID, projectID, title: "Other session" }, directory)]
  await mockOpenCodeServer(page, {
    directory,
    project,
    provider: {
      all: [
        {
          id: "opencode",
          name: "OpenCode",
          models: { "pending-model": { id: "pending-model", name: "Pending Model", limit: { context: 200_000 } } },
        },
      ],
      connected: ["opencode"],
      default: { providerID: "opencode", modelID: "pending-model" },
    },
    sessions,
    pageMessages: () => ({ items: [] }),
    onPrompt: (input) => prompts.push(input),
    events: options?.events ?? (() => events.splice(0)),
  })
  page.on("request", (request) => {
    if (request.method() !== "POST") return
    const path = new URL(request.url()).pathname
    if (path === "/api/worktree") {
      expect(new URL(request.url()).searchParams.get("location[directory]")).toBe(directory)
      calls.push("worktree")
      worktreeRequests.push(request.postDataJSON())
    }
    if (path === "/api/session") calls.push("session")
    if (/^\/api\/session\/[^/]+\/prompt$/.test(path)) calls.push("prompt")
  })
  await page.route(
    (url) => url.pathname === "/api/worktree",
    async (route) => {
      if (route.request().method() !== "POST") return route.fallback()
      // Keep the real HTTP response pending until the test has checked the preview.
      const response = await worktree.promise
      if (response.status === 200) project.sandboxes.push(workspace)
      await route.fulfill({ ...response, headers })
    },
  )
  await page.route("**/api/session", async (route) => {
    if (route.request().method() !== "POST") return route.fallback()
    const body: Record<string, unknown> = route.request().postDataJSON()
    creates.push(body)
    if (options?.failSessionCreate && creates.length === 1) {
      return route.fulfill({ status: 500, json: { message: "Session creation failed in the fixture" }, headers })
    }
    if (typeof body.id !== "string") throw new Error("Session creation must use the client-reserved ID")
    const session = currentSession(
      { ...body, id: body.id, projectID, title: options?.untitled ? "" : "Created workspace session" },
      workspace,
    )
    sessions.push(session)
    return route.fulfill({ json: { data: session }, headers })
  })
  await page.route("**/api/location?**", (route) => {
    if (route.request().method() !== "GET") return route.fallback()
    return route.fulfill({
      json: {
        directory: new URL(route.request().url()).searchParams.get("location[directory]") ?? directory,
        project: { id: projectID, directory, canonical: directory },
      },
      headers,
    })
  })
  await page.route("**/api/agent?**", (route) =>
    route.fulfill({
      json: {
        location: { directory: new URL(route.request().url()).searchParams.get("location[directory]") ?? directory },
        data: [
          {
            id: "build",
            name: "Build",
            mode: "primary",
            hidden: false,
            request: { settings: {}, headers: {}, body: {} },
            permissions: [],
          },
        ],
      },
      headers,
    }),
  )
  if (options?.command) {
    await page.route("**/api/command?**", (route) =>
      route.fulfill({
        json: {
          location: { directory: new URL(route.request().url()).searchParams.get("location[directory]") ?? directory },
          data: [{ name: "review", description: "Review changes" }],
        },
        headers,
      }),
    )
  }
  await page.addInitScript(
    ({ directory, draftID, otherID, server }) => {
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({
          projects: { local: [{ worktree: directory, expanded: true }] },
          lastProject: { local: directory },
        }),
      )
      localStorage.setItem(
        "opencode.window.browser.dat:tabs",
        JSON.stringify([
          { type: "draft", draftID, server, directory },
          { type: "session", sessionId: otherID, server },
        ]),
      )
    },
    { directory, draftID, otherID, server },
  )
  await page.goto(draftPath)
  await expectAppVisible(page.locator('[data-component="composer-editor"]'))
  await page.getByRole("button", { name: "Local", exact: true }).click()
  await page.getByRole("menuitem", { name: "New worktree", exact: true }).click()
  await expect(page.getByRole("button", { name: "New worktree", exact: true })).toBeVisible()
  await expect(page.locator('[data-component="composer-editor"]')).toBeEditable()
  return { worktree, worktreeRequests, calls, creates, prompts, events }
}

async function submitPending(page: Page, mock: Awaited<ReturnType<typeof openDraft>>, prompt = text) {
  await page.locator('[data-component="composer-editor"]').fill(prompt)
  await expect(page.locator('[data-action="composer-submit"]')).toBeEnabled()
  await page.locator('[data-action="composer-submit"]').click()
  await expect(page).toHaveURL((url) => url.pathname.startsWith(sessionPath) && /\/ses_[^/]+$/.test(url.pathname))
  const url = page.url()
  const sessionID = new URL(url).pathname.slice(sessionPath.length)
  const preparing = page.locator('[data-component="session-preparing"]')
  const message = page.locator('[data-component="user-message"]')
  const shimmer = preparing.getByRole("status").locator('[data-component="text-shimmer"]')
  const title = preparing.getByRole("heading", { level: 1 })
  await expect(preparing).toBeVisible()
  await expect(title).toHaveText("Session")
  await expect(page.locator('[data-component="composer-editor"]')).toBeEditable()
  await expect(page.locator('[data-action="composer-submit"]')).toBeDisabled()
  await expect(preparing.locator('[data-component="user-message"]')).toHaveCount(1)
  await expect(message).toHaveCount(1)
  await expect(message.locator('[data-slot="user-message-text"]')).toHaveText(prompt)
  await expect(message).toHaveAttribute("data-timeline-part-id", /^.+:text:0$/)
  const messageID = (await message.getAttribute("data-timeline-part-id"))!.replace(/:text:0$/, "")
  await expect(shimmer).toBeVisible()
  await expect(shimmer).toContainText("Creating worktree")
  await expect(shimmer).toHaveAttribute("data-active", "true")
  await expect.poll(() => mock.calls).toEqual(["worktree"])
  expect(mock.creates).toEqual([])
  expect(mock.prompts).toEqual([])
  return { url, sessionID, messageID, message, shimmer, title }
}
