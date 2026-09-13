import { expect, test, type Page } from "@playwright/test"
import { mockOpenCodeServer, currentSession } from "../utils/mock-server"
import { openWithDirection } from "../utils/direction"

const directory = "/workspace/summary-project"
const workspace = "/workspace/existing-worktree"
const createdWorkspace = "/workspace/created-worktree"
const draftID = "draft_summary"
const secondDraftID = "draft_summary_other"
const server = `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`
const draftPath = `/new-session?draftId=${draftID}`

for (const rtl of [false, true]) {
  test(`new session summary shows project extensions and follows workspace selection in ${rtl ? "rtl" : "ltr"}`, async ({
    page,
  }, testInfo) => {
    const mock = await openDraft(page, "main", { direction: rtl ? "rtl" : "ltr" })
    await expect(page.locator("html")).toHaveAttribute("dir", rtl ? "rtl" : "ltr")
    await expect(page.locator("html")).toHaveAttribute("lang", "en")
    const trigger = page.getByRole("button", { name: "Session details", exact: true })
    await expect
      .poll(async () => {
        const button = await trigger.boundingBox()
        const view = await page.locator('[data-component="new-session"]').boundingBox()
        if (!button || !view) return false
        const gap = rtl ? button.x - view.x : view.x + view.width - button.x - button.width
        return Math.abs(gap - 12) <= 1 && Math.abs(button.y + button.height / 2 - view.y - 24) <= 1
      })
      .toBe(true)
    await trigger.click()
    const summary = page.getByRole("dialog", { name: "Session details", exact: true })
    await expect(summary.getByRole("button", { name: "summary-project", exact: true })).toHaveAttribute(
      "aria-expanded",
      "true",
    )
    await expect(summary.getByRole("button", { name: "Extensions", exact: true })).toHaveAttribute(
      "aria-expanded",
      "true",
    )
    await expect
      .poll(async () => {
        const button = await trigger.boundingBox()
        const project = await summary.locator('[data-section="project"]').boundingBox()
        const server = await summary.locator('[data-section="server"]').boundingBox()
        if (!button || !project || !server) return
        return {
          top: project.y - button.y - button.height,
          cards: server.y - project.y - project.height,
        }
      })
      .toEqual({ top: 12, cards: 8 })
    await testInfo.attach(`new-session-summary-${rtl ? "rtl" : "ltr"}`, {
      body: await page.screenshot(),
      contentType: "image/png",
    })
    for (const [name, item] of [
      ["MCP", "summary-mcp"],
      ["Plugins", "project-plugin"],
      ["Skills", "summary-skill"],
      ["LSP", "typescript"],
    ]) {
      await summary.getByRole("button", { name, exact: true }).click()
      await expect(page.getByRole("dialog", { name, exact: true }).getByText(item, { exact: true })).toBeVisible()
    }
    await page.keyboard.press("Escape")
    await summary.getByRole("button", { name: "Local repository", exact: true }).click()
    const worktreeMenu = page.getByRole("menu", { name: "Local repository", exact: true })
    await expect
      .poll(async () => {
        const menu = await worktreeMenu.boundingBox()
        const panel = await summary.locator('[data-component="session-summary-panel"]').boundingBox()
        if (!menu || !panel) return false
        return rtl ? menu.x >= panel.x + panel.width : menu.x + menu.width <= panel.x
      })
      .toBe(true)
    await expect(page.getByRole("menuitem", { name: "existing-worktree", exact: true })).toBeHidden()
    await worktreeMenu.getByRole("menuitem", { name: "Worktree", exact: true }).press(rtl ? "ArrowLeft" : "ArrowRight")
    await expect(page.getByRole("menu", { name: "Worktree", exact: true })).toBeVisible()
    await page.keyboard.press("Enter")
    await expect(summary.getByRole("button", { name: "existing-worktree", exact: true })).toBeVisible()
    await summary.getByRole("button", { name: "MCP", exact: true }).click()
    const mcp = page.getByRole("dialog", { name: "MCP", exact: true })
    const toggle = mcp.getByRole("switch", { name: "summary-mcp", exact: true })
    await expect(toggle).not.toBeChecked()
    await expect(toggle).toBeEnabled()
    await mcp.getByText("summary-mcp", { exact: true }).click()
    await expect(toggle).toBeChecked()
    await expect(toggle).toBeEnabled()
    expect(mock.calls).toEqual([{ type: "mcp", directory: workspace, enabled: true }])
    expect(mock.status.get(directory)).toBe("connected")
    await summary.getByRole("button", { name: "Plugins", exact: true }).click()
    await expect(
      page.getByRole("dialog", { name: "Plugins", exact: true }).getByText("workspace-plugin", { exact: true }),
    ).toBeVisible()
  })
}

test("non-Git folders show their status without offering worktree actions", async ({ page }) => {
  await openDraft(page, "main", { git: false })
  await page.getByRole("button", { name: "Session details", exact: true }).click()
  const summary = page.getByRole("dialog", { name: "Session details", exact: true })
  await expect(summary.getByText("No Git", { exact: true })).toBeVisible()
  await expect(summary.getByRole("button", { name: "Local repository", exact: true })).toHaveCount(0)
  await expect(summary.getByRole("button", { name: "New worktree", exact: true })).toHaveCount(0)
  await summary.getByRole("button", { name: "MCP", exact: true }).click()
  await expect(
    page.getByRole("dialog", { name: "MCP", exact: true }).getByRole("switch", { name: "summary-mcp", exact: true }),
  ).toBeEnabled()
})

test("new worktree MCP choices persist per draft and apply before the first prompt", async ({ page }, testInfo) => {
  const mock = await openDraft(page, "create")
  await page.locator('[data-component="composer-editor"]').fill("Use my selected MCPs")
  await page.getByRole("button", { name: "Session details", exact: true }).click()
  await page.getByRole("button", { name: "MCP", exact: true }).click()
  const menu = page.getByRole("dialog", { name: "MCP", exact: true })
  await expect(menu.locator('[data-slot="mcp-preview-hint"]')).toHaveText("Applies when the worktree is created")
  await expect(menu).toHaveCSS("opacity", "1")
  await testInfo.attach("new-worktree-mcp-preview", { body: await page.screenshot(), contentType: "image/png" })
  const toggle = menu.getByRole("switch", { name: "summary-mcp", exact: true })
  await expect(toggle).toBeChecked()
  await menu.getByText("summary-mcp", { exact: true }).click()
  await expect(toggle).not.toBeChecked()
  expect(mock.calls).toEqual([])
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          JSON.parse(localStorage.getItem("opencode.window.browser.dat:tabs") ?? "[]").find(
            (tab: { draftID?: string }) => tab.draftID === "draft_summary",
          )?.mcp?.states,
      ),
    )
    .toEqual({ "summary-mcp": false })

  await page.goto(`/new-session?draftId=${secondDraftID}`)
  await page.getByRole("button", { name: "Session details", exact: true }).click()
  await page.getByRole("button", { name: "MCP", exact: true }).click()
  await expect(toggle).toBeChecked()
  await page.goto(draftPath)
  await page.getByRole("button", { name: "Session details", exact: true }).click()
  await page.getByRole("button", { name: "MCP", exact: true }).click()
  await expect(toggle).not.toBeChecked()
  expect(mock.calls).toEqual([])
  await page.keyboard.press("Escape")
  await page.keyboard.press("Escape")
  await expect(page.locator('[data-component="composer-editor"]')).toHaveText("Use my selected MCPs")
  await page.locator('[data-action="composer-submit"]').click()
  await expect.poll(() => mock.prompts.length).toBe(1)
  expect(mock.calls).toEqual([
    { type: "worktree", directory },
    { type: "mcp", directory: createdWorkspace, enabled: false },
    { type: "session", directory: createdWorkspace },
    { type: "prompt", directory: createdWorkspace },
  ])
  expect(mock.prompts[0].body.text).toBe("Use my selected MCPs")
  expect(mock.status.get(directory)).toBe("connected")
})

test("the first prompt waits for a live MCP toggle", async ({ page }) => {
  const mock = await openDraft(page)
  const release = Promise.withResolvers<void>()
  mock.state.hold = release.promise
  await page.locator('[data-component="composer-editor"]').fill("Wait for the MCP update")
  await page.getByRole("button", { name: "Session details", exact: true }).click()
  await page.getByRole("button", { name: "MCP", exact: true }).click()
  const menu = page.getByRole("dialog", { name: "MCP", exact: true })
  await expect(menu.getByRole("switch", { name: "summary-mcp", exact: true })).toBeEnabled()
  try {
    await menu.getByText("summary-mcp", { exact: true }).click()
    await expect.poll(() => mock.calls.length).toBe(1)
    await page.keyboard.press("Escape")
    await page.keyboard.press("Escape")
    await page.locator('[data-action="composer-submit"]').click()
    await expect(page).toHaveURL(draftPath)
    expect(mock.calls).toEqual([{ type: "mcp", directory, enabled: false }])
    expect(mock.prompts).toEqual([])
  } finally {
    release.resolve()
  }
  await expect.poll(() => mock.prompts.length).toBe(1)
  expect(mock.calls).toEqual([
    { type: "mcp", directory, enabled: false },
    { type: "session", directory },
    { type: "prompt", directory },
  ])
})

test("changing worktrees does not wait for another directory's pending MCP update", async ({ page }) => {
  const mock = await openDraft(page)
  const release = Promise.withResolvers<void>()
  mock.state.hold = release.promise
  mock.state.holdDirectory = directory
  await page.locator('[data-component="composer-editor"]').fill("Run in the selected worktree")
  await page.getByRole("button", { name: "Session details", exact: true }).click()
  const summary = page.getByRole("dialog", { name: "Session details", exact: true })
  await summary.getByRole("button", { name: "MCP", exact: true }).click()
  const menu = page.getByRole("dialog", { name: "MCP", exact: true })
  try {
    await expect(menu.getByRole("switch", { name: "summary-mcp", exact: true })).toBeEnabled()
    await menu.getByText("summary-mcp", { exact: true }).click()
    await expect.poll(() => mock.calls.length).toBe(1)
    await page.keyboard.press("Escape")
    await summary.getByRole("button", { name: "Local repository", exact: true }).click()
    await page.getByRole("menuitem", { name: "Worktree", exact: true }).click()
    await page.getByRole("menuitem", { name: "existing-worktree", exact: true }).click()
    await summary.getByRole("button", { name: "MCP", exact: true }).click()
    const toggle = menu.getByRole("switch", { name: "summary-mcp", exact: true })
    await expect(toggle).toBeEnabled()
    await expect(toggle).not.toBeChecked()
    await menu.getByText("summary-mcp", { exact: true }).click()
    await expect(toggle).toBeChecked()
    await expect(toggle).toBeEnabled()
    await page.keyboard.press("Escape")
    await page.keyboard.press("Escape")
    await page.locator('[data-action="composer-submit"]').click()
    await expect.poll(() => mock.prompts.length).toBe(1)
    expect(mock.calls.find((call) => call.type === "session")?.directory).toBe(workspace)
    expect(mock.status.get(directory)).toBe("connected")
  } finally {
    release.resolve()
  }
})

test("failed MCP preparation restores the draft and reuses the created worktree", async ({ page }) => {
  const mock = await openDraft(page, "create")
  mock.state.fail = true
  await page.locator('[data-component="composer-editor"]').fill("Keep this prompt on failure")
  await page.getByRole("button", { name: "Session details", exact: true }).click()
  await page.getByRole("button", { name: "MCP", exact: true }).click()
  await page.getByRole("dialog", { name: "MCP", exact: true }).getByText("summary-mcp", { exact: true }).click()
  await page.keyboard.press("Escape")
  await page.keyboard.press("Escape")
  await page.locator('[data-action="composer-submit"]').click()
  await expect(page.getByText("Request failed", { exact: true })).toBeVisible()
  await expect(page).toHaveURL(draftPath)
  await expect(page.locator('[data-component="composer-editor"]')).toHaveText("Keep this prompt on failure")
  await expect(page.getByRole("button", { name: "created-worktree", exact: true })).toBeVisible()
  expect(mock.prompts).toEqual([])
  expect(mock.calls.map((call) => call.type)).toEqual(["worktree", "mcp"])
  mock.state.fail = false
  await expect(page.locator('[data-action="composer-submit"]')).toBeEnabled()
  await page.locator('[data-action="composer-submit"]').click()
  await expect.poll(() => mock.prompts.length).toBe(1)
  expect(mock.calls.filter((call) => call.type === "worktree")).toHaveLength(1)
  expect(mock.status.get(createdWorkspace)).toBe("disabled")
  expect(mock.prompts[0].body.text).toBe("Keep this prompt on failure")
})

test("new worktree sign-in completes before the draft can send", async ({ page, context }) => {
  const mock = await openDraft(page, "create")
  mock.status.set(createdWorkspace, "needs_auth")
  const attempts: string[] = []
  await context.route("https://auth.example.test/**", (route) => route.fulfill({ body: "Sign in" }))
  await page.route("**/api/integration/**", (route) => {
    if (route.request().method() === "OPTIONS") return route.fallback()
    if (route.request().method() === "POST") {
      attempts.push(new URL(route.request().url()).searchParams.get("location[directory]") ?? "")
      return route.fulfill({
        json: { location: { directory: createdWorkspace }, data: { url: "https://auth.example.test/authorize" } },
      })
    }
    return route.fulfill({
      json: {
        location: { directory: createdWorkspace },
        data: {
          id: "summary-oauth",
          methods: [{ id: "oauth", type: "oauth" }],
        },
      },
    })
  })
  await page.locator('[data-component="composer-editor"]').fill("Wait for my sign-in")
  await page.getByRole("button", { name: "Session details", exact: true }).click()
  await page.getByRole("button", { name: "MCP", exact: true }).click()
  const menu = page.getByRole("dialog", { name: "MCP", exact: true })
  const toggle = menu.getByRole("switch", { name: "summary-mcp", exact: true })
  await expect(toggle).toBeChecked()
  await menu.getByText("summary-mcp", { exact: true }).click()
  await expect(toggle).not.toBeChecked()
  await menu.getByText("summary-mcp", { exact: true }).click()
  await expect(toggle).toBeChecked()
  await page.keyboard.press("Escape")
  await page.keyboard.press("Escape")
  const popup = page.waitForEvent("popup")
  await page.locator('[data-action="composer-submit"]').click()
  await expect(await popup).toHaveURL("https://auth.example.test/authorize")
  await expect(page).toHaveURL(draftPath)
  await expect(page.locator('[data-component="composer-editor"]')).toHaveText("Wait for my sign-in")
  expect(attempts).toEqual([createdWorkspace])
  expect(mock.prompts).toEqual([])
  mock.status.set(createdWorkspace, "connected")
  await page.locator('[data-action="composer-submit"]').click()
  await expect.poll(() => mock.prompts.length).toBe(1)
  expect(mock.calls.filter((call) => call.type === "worktree")).toHaveLength(1)
  expect(attempts).toHaveLength(1)
})

async function openDraft(page: Page, worktree = "main", options: { git?: boolean; direction?: "ltr" | "rtl" } = {}) {
  const project = {
    id: "proj_new_summary",
    worktree: directory,
    name: "summary-project",
    vcs: options.git === false ? undefined : "git",
    time: { created: 1, updated: 1 },
    sandboxes: [workspace],
  }
  const sessions: ReturnType<typeof currentSession>[] = []
  const status = new Map<string, string>([
    [directory, "connected"],
    [workspace, "disabled"],
    [createdWorkspace, "connected"],
  ])
  const calls: { type: string; directory: string; enabled?: boolean }[] = []
  const prompts: { sessionID: string; body: Record<string, unknown> }[] = []
  const state: { fail: boolean; hold?: Promise<void>; holdDirectory?: string } = { fail: false }
  await mockOpenCodeServer(page, {
    directory,
    project,
    sessions,
    provider: {
      all: [
        {
          id: "opencode",
          name: "OpenCode",
          models: { "summary-model": { id: "summary-model", name: "Summary Model", limit: { context: 200_000 } } },
        },
      ],
      connected: ["opencode"],
      default: { providerID: "opencode", modelID: "summary-model" },
    },
    pageMessages: () => ({ items: [] }),
    onPrompt(input) {
      const session = sessions.find((session) => session.id === input.sessionID)
      if (!session?.location.directory) throw new Error("Prompt arrived before session creation")
      calls.push({ type: "prompt", directory: session.location.directory })
      prompts.push(input)
    },
  })
  if (options.git === false) {
    await page.route(
      (url) => url.pathname === "/api/vcs",
      (route) => route.fulfill({ json: { location: { directory }, data: { branch: {} } } }),
    )
  }
  await page.route("**/api/mcp**", async (route) => {
    if (route.request().method() === "OPTIONS") return route.fallback()
    const url = new URL(route.request().url())
    const target = url.searchParams.get("location[directory]") ?? directory
    if (route.request().method() === "POST") {
      const enabled = url.pathname.endsWith("/connect")
      calls.push({ type: "mcp", directory: target, enabled })
      if (!state.holdDirectory || state.holdDirectory === target) await state.hold
      if (state.fail) return route.fulfill({ status: 500, json: { message: "MCP fixture failed" } })
      status.set(target, enabled ? "connected" : "disabled")
      return route.fulfill({ status: 204 })
    }
    return route.fulfill({
      json: {
        location: { directory: target },
        data:
          url.pathname === "/api/mcp/resource"
            ? { resources: [], templates: [] }
            : [
                {
                  name: "summary-mcp",
                  integrationID: "summary-oauth",
                  status: { status: status.get(target) ?? "connected" },
                },
              ],
      },
    })
  })
  await page.route(
    (url) => url.pathname === "/api/location",
    (route) =>
      route.fulfill({
        json: {
          directory: new URL(route.request().url()).searchParams.get("location[directory]") ?? directory,
          project: { id: project.id, directory, canonical: directory },
        },
      }),
  )
  await page.route(
    (url) => url.pathname === "/api/plugin",
    (route) => {
      const target = new URL(route.request().url()).searchParams.get("location[directory]") ?? directory
      const id = target === directory ? "project-plugin" : "workspace-plugin"
      return route.fulfill({
        json: {
          location: { directory: target },
          data: [{ id, source: { type: "package", target: id }, features: {}, state: { status: "active" } }],
        },
      })
    },
  )
  await page.route(
    (url) => url.pathname === "/api/skill",
    (route) =>
      route.fulfill({
        json: {
          location: { directory: new URL(route.request().url()).searchParams.get("location[directory]") ?? directory },
          data: [
            {
              id: "summary-skill",
              name: "summary-skill",
              location: "/skills/summary/SKILL.md",
              content: "Summary skill",
            },
          ],
        },
      }),
  )
  await page.route(
    (url) => url.pathname === "/api/config",
    (route) =>
      route.fulfill({
        json: [{ type: "document", info: { lsp: { typescript: { command: ["typescript-language-server"] } } } }],
      }),
  )
  await page.route(
    (url) => url.pathname === "/api/worktree",
    (route) => {
      if (route.request().method() !== "POST") return route.fallback()
      calls.push({ type: "worktree", directory })
      project.sandboxes.push(createdWorkspace)
      return route.fulfill({ json: { directory: createdWorkspace } })
    },
  )
  await page.route(
    (url) => url.pathname === "/api/session",
    (route) => {
      if (route.request().method() !== "POST") return route.fallback()
      const body: { id: string; location: { directory: string } } = route.request().postDataJSON()
      calls.push({ type: "session", directory: body.location.directory })
      const session = currentSession(
        { ...body, projectID: project.id, title: "Created summary session" },
        body.location.directory,
      )
      sessions.push(session)
      return route.fulfill({ json: { data: session } })
    },
  )
  await page.addInitScript(
    ({ directory, server, draftID, secondDraftID, worktree }) => {
      if (!localStorage.getItem("opencode.global.dat:server"))
        localStorage.setItem(
          "opencode.global.dat:server",
          JSON.stringify({
            projects: { local: [{ worktree: directory, expanded: true }] },
            lastProject: { local: directory },
          }),
        )
      if (!localStorage.getItem("opencode.window.browser.dat:tabs"))
        localStorage.setItem(
          "opencode.window.browser.dat:tabs",
          JSON.stringify([
            { type: "draft", draftID, server, directory, worktree },
            { type: "draft", draftID: secondDraftID, server, directory, worktree },
          ]),
        )
    },
    { directory, server, draftID, secondDraftID, worktree },
  )
  if (options.direction) await openWithDirection(page, draftPath, options.direction)
  if (!options.direction) await page.goto(draftPath)
  await expect(page.locator('[data-component="composer-editor"]')).toBeEditable()
  await expect(page.locator('[data-action="composer-model"]')).toContainText("Summary Model")
  if (options.git === false) await expect(page.getByText("No Git", { exact: true })).toBeVisible()
  if (options.git !== false) {
    await expect(
      page.getByRole("button", { name: worktree === "create" ? "New worktree" : "Local", exact: true }),
    ).toBeVisible()
  }
  return { calls, prompts, status, state }
}
