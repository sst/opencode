import { base64Encode } from "@opencode/util/encode"
import { expect, test, type Page, type Route } from "@playwright/test"
import { installSseTransport } from "../utils/sse-transport"
import { currentSession } from "../utils/mock-server"

const serverA = `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`
const serverB = "http://127.0.0.1:4097"
const directoryA = "C:/server-a"
const directoryB = "/home/server-b"
const sessionA = session("ses_server_a", directoryA, "Server A session")
const childSessionA = { ...session("ses_server_a_child", directoryA, "Server A child session"), parentID: sessionA.id }
const sessionB = session("ses_server_b", directoryB, "Server B session")

test("session settings use the remote server context", async ({ page }) => {
  const permissionRequests: string[] = []
  const permissionResponses: PermissionResponse[] = []
  await installSseTransport(page, { server: serverA })
  await installSseTransport(page, { server: serverB })
  // Server A has no tab and is never visited: a pending request there proves
  // one toggle sweeps every connected server, not just the focused one.
  await mockServers(page, permissionRequests, permissionResponses, {
    pending: { [serverA]: [pendingPermission("permission-pending-a", sessionA.id)] },
    preferencesUnavailable: true,
  })
  await configureServers(page)

  await page.goto(`/server/${base64Encode(serverB)}/session/${sessionB.id}`)
  const sessionHeading = page.getByRole("heading", { name: sessionB.title, exact: true, includeHidden: true })
  await expect(sessionHeading).toBeVisible()
  await page.keyboard.press("Control+,")

  const settings = page.getByTestId("settings-screen")
  await expect(settings).toBeVisible()
  await expect(page).toHaveURL("/settings")
  await expect(page.locator('[data-titlebar-tab][data-active="true"]')).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Home", exact: true })).toHaveAttribute("aria-pressed", "false")
  await expect(page.getByRole("dialog")).toHaveCount(0)
  await expect(settings.getByRole("complementary")).toHaveCSS("width", "328px")
  await expect(sessionHeading).toBeHidden()
  await expect(settings.getByText("Servers", { exact: true })).toBeVisible()
  await expect(settings.getByRole("tab", { name: "Models", exact: true })).toHaveCount(0)
  const autoAccept = settings.locator('[data-action="settings-auto-accept-permissions"]')
  const input = autoAccept.getByRole("switch")
  await expect(autoAccept).toBeVisible()
  await expect(input).toBeEnabled()
  permissionRequests.length = 0
  await autoAccept.locator('[data-slot="switch-control"]').click()
  await expect(input).toBeChecked()
  await expect
    .poll(() =>
      permissionRequests.some((request) => {
        const url = new URL(request)
        return url.origin === serverB && url.searchParams.get("location[directory]") === directoryB
      }),
    )
    .toBe(true)
  await expect
    .poll(() => permissionResponses)
    .toEqual([
      {
        origin: serverA,
        directory: undefined,
        sessionID: sessionA.id,
        permissionID: "permission-pending-a",
        body: { reply: "once" },
      },
    ])

  await settings.getByRole("tab", { name: "127.0.0.1:4097", exact: true }).click()
  await expect(settings.getByRole("button", { name: "Back to settings", exact: true })).toBeVisible()
  await expect(settings.getByRole("heading", { name: "Connection", exact: true })).toBeVisible()
  await expect(settings.getByRole("tab")).toHaveText([
    "127.0.0.1:4097",
    "Projects",
    "Worktrees",
    "Providers",
    "Models",
    "Extensions",
  ])
  await settings.getByRole("tab", { name: "Models" }).click()
  await expect(settings.getByRole("switch", { name: "Server B Model" })).toBeEnabled()
  await expect(settings.getByRole("switch", { name: "Server A Model" })).toHaveCount(0)
  await settings.getByRole("button", { name: "Back to settings" }).click()
  await settings.getByRole("button", { name: "Back to app" }).click()
  await expect(settings).toBeHidden()
  await expect(page).toHaveURL(`/server/${base64Encode(serverB)}/session/${sessionB.id}`)
  await expect(sessionHeading).toBeVisible()
  await expect(page.locator('[data-titlebar-tab][data-active="true"]')).toContainText(sessionB.title)
  await page.keyboard.press("Control+]")
  await expect(page).toHaveURL("/settings")
  await expect(settings.getByRole("tab", { name: "Preferences", exact: true })).toHaveAttribute("aria-selected", "true")
  await expect(page.locator('[data-titlebar-tab][data-active="true"]')).toHaveCount(0)
  await page.keyboard.press("Escape")
  await expect(page).toHaveURL(`/server/${base64Encode(serverB)}/session/${sessionB.id}`)
  await expect(sessionHeading).toBeVisible()
})

test("auto-accept responds for an unfocused server session", async ({ page }) => {
  const permissionRequests: string[] = []
  const permissionResponses: PermissionResponse[] = []
  await installSseTransport(page, { server: serverB })
  const transport = await installSseTransport(page, {
    server: serverA,
    retry: 20,
  })
  await mockServers(page, permissionRequests, permissionResponses)
  await configureServers(page, [
    { type: "session", server: serverA, sessionId: sessionA.id },
    { type: "session", server: serverB, sessionId: sessionB.id },
  ])

  const hrefB = `/server/${base64Encode(serverB)}/session/${sessionB.id}`
  await page.goto(`/server/${base64Encode(serverA)}/session/${sessionA.id}`)
  await expect(page.getByRole("heading", { name: sessionA.title, exact: true })).toBeVisible()
  await page.keyboard.press("Control+,")
  const autoAccept = page.getByTestId("settings-screen").locator('[data-action="settings-auto-accept-permissions"]')
  await autoAccept.locator('[data-slot="switch-control"]').click()
  await expect(autoAccept.getByRole("switch")).toBeChecked()
  await expect
    .poll(() =>
      permissionRequests.some((request) => {
        const url = new URL(request)
        return url.origin === serverA && url.searchParams.get("location[directory]") === directoryA
      }),
    )
    .toBe(true)
  await page.keyboard.press("Escape")

  await page.locator(`[data-titlebar-tab-slot]:has(a[href="${hrefB}"])`).click()
  await expect(page).toHaveURL(new RegExp(`${hrefB.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`))
  await expect(page.getByRole("heading", { name: sessionB.title, exact: true })).toBeVisible()
  await transport.waitForConnection()

  await transport.send({
    id: "evt_permission_background_a",
    created: 1700000001000,
    type: "permission.asked",
    location: { directory: directoryA },
    data: {
      id: "permission-background-a",
      sessionID: sessionA.id,
      action: "shell",
      resources: ["git status"],
      metadata: {},
      save: [],
    },
  })

  await expect
    .poll(() => permissionResponses)
    .toEqual([
      {
        origin: serverA,
        directory: undefined,
        sessionID: sessionA.id,
        permissionID: "permission-background-a",
        body: { reply: "once" },
      },
    ])

  await transport.send({
    id: "evt_permission_background_a_child",
    created: 1700000002000,
    type: "permission.asked",
    location: { directory: directoryA },
    data: {
      id: "permission-background-a-child",
      sessionID: childSessionA.id,
      action: "shell",
      resources: ["git diff"],
      metadata: {},
      save: [],
    },
  })

  await expect
    .poll(() => permissionResponses)
    .toEqual([
      {
        origin: serverA,
        directory: undefined,
        sessionID: sessionA.id,
        permissionID: "permission-background-a",
        body: { reply: "once" },
      },
      {
        origin: serverA,
        directory: undefined,
        sessionID: childSessionA.id,
        permissionID: "permission-background-a-child",
        body: { reply: "once" },
      },
    ])
})

test("auto-accept sweeps again after a reconnect", async ({ page }) => {
  const permissionRequests: string[] = []
  const permissionResponses: PermissionResponse[] = []
  const pendingA: MockPermission[] = []
  const listFailures: Record<string, number> = {}
  const sessionGets: string[] = []
  await installSseTransport(page, { server: serverB })
  const transport = await installSseTransport(page, { server: serverA, retry: 20 })
  await mockServers(page, permissionRequests, permissionResponses, {
    pending: { [serverA]: pendingA },
    listFailures,
    sessionGets,
  })
  await configureServers(page, [{ type: "session", server: serverA, sessionId: sessionA.id }])

  await page.goto(`/server/${base64Encode(serverA)}/session/${sessionA.id}`)
  await expect(page.getByRole("heading", { name: sessionA.title, exact: true })).toBeVisible()
  const first = await transport.waitForConnection()

  await page.keyboard.press("Control+,")
  const autoAccept = page.getByTestId("settings-screen").locator('[data-action="settings-auto-accept-permissions"]')
  await autoAccept.locator('[data-slot="switch-control"]').click()
  await expect(autoAccept.getByRole("switch")).toBeChecked()
  await expect
    .poll(() =>
      permissionRequests.some((request) => {
        const url = new URL(request)
        return url.origin === serverA && url.searchParams.get("location[directory]") === directoryA
      }),
    )
    .toBe(true)
  await page.keyboard.press("Escape")

  // This request is asked while the client is disconnected, so it is never
  // delivered as an event and only a reconnect sweep can find it. The first
  // listing after the reconnect fails, so only the bounded sweep retry can
  // deliver the reply.
  pendingA.push(pendingPermission("permission-offline-a", sessionA.id))
  listFailures[serverA] = 1
  const syncsBeforeReconnect = sessionGets.length
  await transport.disconnect()
  await transport.waitForConnection({ after: first.id })

  await expect
    .poll(() => permissionResponses)
    .toEqual([
      {
        origin: serverA,
        directory: undefined,
        sessionID: sessionA.id,
        permissionID: "permission-offline-a",
        body: { reply: "once" },
      },
    ])
  // The reconnect sweep must resync active sessions instead of trusting
  // cached locations, since another client may have moved them meanwhile.
  expect(sessionGets.slice(syncsBeforeReconnect)).toContain(sessionA.id)
})

test("auto-accept approves a request discovered by opening a session", async ({ page }) => {
  const permissionRequests: string[] = []
  const permissionResponses: PermissionResponse[] = []
  await installSseTransport(page, { server: serverA })
  await installSseTransport(page, { server: serverB })
  // The request is only served from the per-session permission list, so it
  // reaches the client through the store sync when the session view opens,
  // never through a location sweep or an event.
  await mockServers(page, permissionRequests, permissionResponses, {
    sessionPending: { [sessionA.id]: [pendingPermission("permission-synced-a", sessionA.id)] },
  })
  await configureServers(page, [{ type: "session", server: serverA, sessionId: sessionA.id }])

  await page.goto(`/server/${base64Encode(serverA)}/session/${sessionA.id}`)
  await expect(page.getByRole("heading", { name: sessionA.title, exact: true })).toBeVisible()

  await page.keyboard.press("Control+,")
  const autoAccept = page.getByTestId("settings-screen").locator('[data-action="settings-auto-accept-permissions"]')
  await autoAccept.locator('[data-slot="switch-control"]').click()
  await expect(autoAccept.getByRole("switch")).toBeChecked()

  await expect
    .poll(() => permissionResponses)
    .toEqual([
      {
        origin: serverA,
        directory: undefined,
        sessionID: sessionA.id,
        permissionID: "permission-synced-a",
        body: { reply: "once" },
      },
    ])
})

type PermissionResponse = {
  origin: string
  directory?: string
  sessionID: string
  permissionID: string
  body: unknown
}

type MockPermission = {
  id: string
  sessionID: string
  action: string
  resources: string[]
  metadata: Record<string, unknown>
  save: unknown[]
}

function pendingPermission(id: string, sessionID: string): MockPermission {
  return { id, sessionID, action: "shell", resources: ["git status"], metadata: {}, save: [] }
}

async function configureServers(page: Page, tabs: { type: "session"; server: string; sessionId: string }[] = []) {
  await page.addInitScript(
    ({ serverB, tabs }) => {
      localStorage.setItem("opencode.global.dat:server", JSON.stringify({ list: [serverB] }))
      localStorage.setItem("opencode.window.browser.dat:tabs", JSON.stringify(tabs))
    },
    { serverB, tabs },
  )
}

type MockServerOptions = {
  // Pending requests served from /api/permission/request, keyed by origin.
  pending?: Record<string, MockPermission[]>
  // Pending requests served from /api/session/:id/permission, keyed by session ID.
  sessionPending?: Record<string, MockPermission[]>
  // Counts of /api/permission/request calls to fail with a 500, keyed by origin.
  listFailures?: Record<string, number>
  // Records /api/session/:id GETs so tests can assert session resyncs.
  sessionGets?: string[]
  preferencesUnavailable?: boolean
}

async function mockServers(
  page: Page,
  permissionRequests: string[],
  permissionResponses: PermissionResponse[] = [],
  options: MockServerOptions = {},
) {
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url())
    if (url.origin !== serverA && url.origin !== serverB) return route.fallback()
    const remote = url.origin === serverB
    const directory = remote ? directoryB : directoryA
    const sessions = remote ? [sessionB] : [sessionA, childSessionA]
    const requestDirectory = url.searchParams.get("location[directory]")
    const response = url.pathname.match(/^\/api\/session\/([^/]+)\/permission\/([^/]+)\/reply$/)
    if (route.request().method() === "POST" && response) {
      permissionResponses.push({
        origin: url.origin,
        directory: requestDirectory ?? undefined,
        sessionID: response[1]!,
        permissionID: response[2]!,
        body: route.request().postDataJSON(),
      })
      // The generated client requires exactly 204 for a successful reply.
      return route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*" } })
    }
    const sessionPermission = url.pathname.match(/^\/api\/session\/([^/]+)\/permission$/)
    if (route.request().method() === "GET" && sessionPermission)
      return json(route, { data: options.sessionPending?.[sessionPermission[1]!] ?? [] })
    if (requestDirectory && requestDirectory !== directory) return json(route, { name: "InvalidDirectory" }, 500)
    if (url.pathname === "/api/config") return json(route, [])
    if (url.pathname === "/api/provider")
      return json(route, {
        location: { directory },
        data: [
          {
            id: remote ? "server-b" : "server-a",
            name: remote ? "Server B Provider" : "Server A Provider",
            package: "test",
          },
        ],
      })
    if (url.pathname === "/api/model") return json(route, { location: { directory }, data: [model(remote)] })
    if (url.pathname === "/api/model/default") return json(route, { location: { directory }, data: model(remote) })
    if (url.pathname === "/api/agent") return json(route, { location: { directory }, data: [] })
    if (url.pathname === "/api/permission/request") {
      permissionRequests.push(url.toString())
      const failures = options.listFailures?.[url.origin] ?? 0
      if (failures > 0) {
        options.listFailures![url.origin] = failures - 1
        return json(route, { name: "Internal" }, 500)
      }
      return json(route, { location: { directory }, data: options.pending?.[url.origin] ?? [] })
    }
    if (["/api/command", "/api/reference", "/api/question/request"].includes(url.pathname))
      return json(route, { location: { directory }, data: [] })
    if (url.pathname === "/api/mcp") return json(route, { location: { directory }, data: [] })
    if (url.pathname === "/api/mcp/resource")
      return json(route, { location: { directory }, data: { resources: [], templates: [] } })
    if (url.pathname === "/api/project") {
      return json(route, [
        {
          id: remote ? sessionB.projectID : "project-server-a",
          canonical: directory,
          vcs: "git",
          time: { created: 1, updated: 1 },
          sandboxes: [],
        },
      ])
    }
    if (url.pathname === "/api/project/current")
      return json(route, { id: remote ? sessionB.projectID : "project-server-a", directory, canonical: directory })
    if (url.pathname === "/api/session")
      return json(route, { data: sessions.map((session) => currentSession(session)), cursor: {} })
    if (url.pathname === "/api/session/active")
      return json(route, { data: Object.fromEntries(sessions.map((session) => [session.id, { type: "running" }])) })
    const currentSessionInfo = sessions.find((session) => url.pathname === `/api/session/${session.id}`)
    if (currentSessionInfo) {
      options.sessionGets?.push(currentSessionInfo.id)
      return json(route, { data: currentSession(currentSessionInfo) })
    }
    if (sessions.some((session) => url.pathname === `/api/session/${session.id}/message`))
      return json(route, { data: [], cursor: {} })
    if (sessions.some((session) => url.pathname === `/api/session/${session.id}/inbox`))
      return json(route, { data: [] })
    if (url.pathname === "/api/location")
      return json(route, {
        directory,
        project: { id: remote ? sessionB.projectID : "project-server-a", directory, canonical: directory },
      })
    if (url.pathname === "/api/config/preferences") return json(route, {}, options.preferencesUnavailable ? 404 : 200)
    if (url.pathname === "/api/config/shell")
      return json(route, options.preferencesUnavailable ? {} : [], options.preferencesUnavailable ? 404 : 200)
    if (url.pathname === "/api/websearch/provider")
      return json(route, { location: { directory }, data: [] }, options.preferencesUnavailable ? 404 : 200)
    if (url.pathname === "/api/worktree") return json(route, [{ directory }])
    if (url.pathname === "/api/vcs")
      return json(route, { location: { directory }, data: { branch: "main", defaultBranch: "main" } })
    if (url.pathname === "/api/pty/shells") return json(route, { location: { directory }, data: [] })
    return json(route, {})
  })
}

function session(id: string, directory: string, title: string) {
  return {
    id,
    slug: id,
    projectID: `project-${id}`,
    location: { directory },
    title,
    version: "dev",
    time: { created: 1, updated: 1 },
  }
}

function provider(id: string) {
  const name = id === "server-b" ? "Server B" : "Server A"
  return {
    all: [
      {
        id,
        name: `${name} Provider`,
        models: {
          [id]: {
            id,
            name: `${name} Model`,
            family: id,
            release_date: "2026-01-01",
            limit: { context: 200_000 },
          },
        },
      },
    ],
    connected: [id],
    default: { providerID: id, modelID: id },
  }
}

function model(remote: boolean) {
  const id = remote ? "server-b" : "server-a"
  const name = remote ? "Server B" : "Server A"
  return {
    id,
    modelID: id,
    providerID: id,
    name: `${name} Model`,
    family: id,
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    variants: [],
    time: { released: Date.now() },
    cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
    status: "active",
    enabled: true,
    limit: { context: 200_000, output: 32_000 },
  }
}

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    headers: { "access-control-allow-origin": "*" },
    body: JSON.stringify(body),
  })
}
