import { base64Encode } from "@opencode-ai/core/util/encode"
import { expect, test, type Page } from "@playwright/test"
import { currentSession, mockOpenCodeServer } from "../utils/mock-server"
import { expectSessionTitle } from "../utils/waits"

const directory = "C:/OpenCode/SubagentNavigation"
const projectID = "proj_subagent_navigation"
const parentID = "ses_subagent_parent"
const childID = "ses_subagent_child"
const parentTitle = "Parent session"
const childTitle = "Subagent child session"
// Child session pages derive their heading from the task part that spawned them.
const taskDescription = "Inspect child navigation"

type EventPayload = { directory: string; payload: Record<string, unknown> }

test.use({ viewport: { width: 1440, height: 900 } })

test("navigates to a subagent child session missing from the session list", async ({ page }) => {
  await setup(page)
  await openChildFromParent(page)

  await expectSessionTitle(page, taskDescription)
  await expect(page.getByRole("heading", { name: parentTitle })).toHaveCount(0)

  const titlebarRight = page.locator("#opencode-titlebar-right")
  await expect(titlebarRight.getByRole("button", { name: "Toggle review" })).toHaveCount(1)
})

test("shows the not found fallback when the viewed session is deleted", async ({ page }) => {
  const events: EventPayload[] = []
  await setup(page, () => events.splice(0, 1))
  await openChildFromParent(page)
  await expectSessionTitle(page, taskDescription)

  events.push({
    directory,
    payload: { type: "session.deleted", properties: { info: childSession() } },
  })

  await expect(page.getByText("This session cannot be found")).toBeVisible()
  await expect(page.getByRole("button", { name: "Close Tab", exact: true })).toBeVisible()
  await expect(page.getByRole("heading", { name: taskDescription })).toHaveCount(0)
})

async function setup(page: Page, events?: () => EventPayload[]) {
  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "subagent-navigation",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider: {
      all: [
        {
          id: "opencode",
          name: "OpenCode",
          models: {
            "claude-opus-4-6": { id: "claude-opus-4-6", name: "Claude Opus 4.6", limit: { context: 200_000 } },
          },
        },
      ],
      connected: ["opencode"],
      default: { providerID: "opencode", modelID: "claude-opus-4-6" },
    },
    sessions: [session(parentID, parentTitle, 1700000000000), childSession()],
    pageMessages: (sessionID) => ({ items: sessionID === parentID ? parentMessages() : [] }),
    events,
    eventRetry: events ? 16 : undefined,
  })
  // The child session resolves by ID but is absent from the session list,
  // matching a subagent session that has not been loaded into the list cache yet.
  await page.route(
    (url) => url.pathname === "/api/session" && url.port === (process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"),
    (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "access-control-allow-origin": "*" },
        body: JSON.stringify({
          data: [currentSession(session(parentID, parentTitle, 1700000000000))],
          cursor: {},
        }),
      }),
  )
  await configurePage(page)
}

async function openChildFromParent(page: Page) {
  await page.goto(sessionHref(parentID))
  await expectSessionTitle(page, parentTitle)

  const card = page.locator(`a[href="${sessionHref(childID)}"]`)
  await expect(card).toBeVisible()
  await card.click()

  await expect(page).toHaveURL(new RegExp(`/server/.+/session/${childID}$`), { timeout: 15_000 })
}

function session(id: string, title: string, created: number, extra?: Record<string, unknown>) {
  return {
    id,
    slug: id,
    projectID,
    directory,
    title,
    version: "dev",
    time: { created, updated: created },
    ...extra,
  }
}

function childSession() {
  return session(childID, childTitle, 1700000001000, { parentID })
}

function parentMessages() {
  const userID = "msg_user_0001"
  const assistantID = "msg_assistant_0001"
  return [
    {
      info: {
        id: userID,
        sessionID: parentID,
        role: "user",
        time: { created: 1700000000000 },
        agent: "build",
        model: { providerID: "opencode", modelID: "claude-opus-4-6" },
      },
      parts: [
        {
          id: "prt_user_text_0001",
          sessionID: parentID,
          messageID: userID,
          type: "text",
          text: "Delegate work to a subagent",
        },
      ],
    },
    {
      info: {
        id: assistantID,
        sessionID: parentID,
        role: "assistant",
        time: { created: 1700000001000, completed: 1700000002000 },
        parentID: userID,
        modelID: "claude-opus-4-6",
        providerID: "opencode",
        mode: "build",
        agent: "build",
        path: { cwd: directory, root: directory },
        cost: 0.01,
        tokens: { input: 100, output: 200, reasoning: 0, cache: { read: 0, write: 0 } },
        finish: "stop",
      },
      parts: [
        {
          id: "prt_tool_task_0001",
          sessionID: parentID,
          messageID: assistantID,
          type: "tool",
          callID: "call_task_0001",
          tool: "task",
          state: {
            status: "completed",
            input: { description: taskDescription, subagent_type: "explore" },
            output: "Subagent finished",
            title: taskDescription,
            metadata: { sessionId: childID },
            time: { start: 1700000001000, end: 1700000002000 },
          },
        },
      ],
    },
  ]
}

async function configurePage(page: Page) {
  const server = `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`
  await page.addInitScript(
    ({ directory, server, sessionId }) => {
      localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({
          projects: { local: [{ worktree: directory, expanded: true }] },
          lastProject: { local: directory },
        }),
      )
      localStorage.setItem("opencode.window.browser.dat:tabs", JSON.stringify([{ type: "session", server, sessionId }]))
    },
    { directory, server, sessionId: parentID },
  )
}

function sessionHref(sessionID: string) {
  const server = `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`
  return `/server/${base64Encode(server)}/session/${sessionID}`
}
