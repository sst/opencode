/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { once } from "node:events"
import { CliRenderEvents, TextAttributes } from "@opentui/core"
import path from "path"
import { testRender } from "@opentui/solid"
import { createSignal, onMount } from "solid-js"
import type { SessionInfo } from "@opencode/client"
import { DialogOpen, DialogOpenKey } from "../../../src/component/dialog-open"
import { ConfigProvider } from "../../../src/config"
import { ClientProvider } from "../../../src/context/client"
import { DataProvider, useData } from "../../../src/context/data"
import { Keymap } from "../../../src/context/keymap"
import { LocationProvider, useLocation } from "../../../src/context/location"
import { RouteProvider, useRoute } from "../../../src/context/route"
import { TuiAppProvider } from "../../../src/context/runtime"
import { SessionTabsProvider } from "../../../src/context/session-tabs"
import { StorageProvider, useStorage } from "../../../src/context/storage"
import { ThemeProvider } from "../../../src/context/theme"
import { DialogProvider, useDialog } from "../../../src/ui/dialog"
import { ToastProvider } from "../../../src/ui/toast"
import { createApi, createEventStream, createFetch, json, type FetchHandler } from "../../fixture/tui-client"
import { emptyThemeSource } from "../../fixture/fixture"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { tmpdir } from "../../fixture/fixture"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"

test("selecting an unhydrated session preserves its location", async () => {
  const remote = { directory: "/tmp/opencode/remote", workspaceID: "ws_remote" }
  const fixture = await renderOpen((url) => {
    if (url.pathname !== "/api/session") return undefined
    return json({
      data: [
        {
          id: "ses_remote",
          projectID: "proj_remote",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 1, updated: 2 },
          title: "Remote session",
          location: remote,
        },
      ],
      cursor: {},
    })
  })

  try {
    await fixture.app.waitForFrame((frame) => frame.includes("Remote session"))
    expect(fixture.data.session.get("ses_remote")).toBeUndefined()

    fixture.app.mockInput.pressEnter()
    await fixture.app.waitFor(() => fixture.route.data.type === "session")

    expect(fixture.route.data).toEqual({ type: "session", sessionID: "ses_remote" })
    expect(fixture.location.ref).toEqual(remote)
  } finally {
    await fixture.dispose()
  }
})

test("finds and opens an exact session ID outside the recent list", async () => {
  const sessionID = "ses_04a7a3d82ffeIphUJgd3SnEqiv"
  const remote = { directory: "/tmp/opencode/archive", workspaceID: "ws_archive" }
  const fixture = await renderOpen((url) => {
    if (url.pathname === "/api/session") return json({ data: [], cursor: {} })
    if (url.pathname !== `/api/session/${sessionID}`) return undefined
    return json({
      data: {
        id: sessionID,
        projectID: "proj_archive",
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: 1, updated: 2 },
        title: "TUI plugin slot API v2",
        location: remote,
      },
    })
  })

  try {
    await fixture.app.waitForFrame((frame) => frame.includes("Search sessions and projects"))
    await fixture.app.mockInput.typeText(sessionID)
    await fixture.app.waitForFrame((frame) => frame.includes("TUI plugin slot API v2"))

    fixture.app.mockInput.pressEnter()
    await fixture.app.waitFor(() => fixture.route.data.type === "session")

    expect(fixture.route.data).toEqual({ type: "session", sessionID })
    expect(fixture.location.ref).toEqual(remote)
  } finally {
    await fixture.dispose()
  }
})

test("shows the current project and opens its root", async () => {
  const root = "/tmp/opencode/project"
  const subfolder = `${root}/packages/tui`
  const fixture = await renderOpen(
    (url) => {
      if (url.pathname === "/api/project")
        return json([
          {
            id: "proj_current",
            canonical: root,
            name: "OpenCode",
            time: { created: 1, updated: 2 },
            sandboxes: [],
          },
        ])
      if (url.pathname === "/api/location")
        return json({
          directory: subfolder,
          project: { id: "proj_current", directory: root, canonical: root },
        })
      return undefined
    },
    async ({ data, location }) => {
      await data.location.sync({ directory: subfolder })
      location.set({ directory: subfolder })
    },
  )

  try {
    const frame = await fixture.app.waitForFrame((value) => value.includes("OpenCode") && value.includes("●"))
    expect(frame).toContain(root)

    fixture.app.mockInput.pressEnter()
    await fixture.app.waitFor(() => fixture.route.data.type === "home")

    expect(fixture.route.data).toEqual({ type: "home", location: { directory: root } })
    expect(fixture.location.ref).toEqual({ directory: root })
  } finally {
    await fixture.dispose()
  }
})

test("includes unique sandbox and recent session directories, including global projects", async () => {
  const fixture = await renderOpen((url) => {
    if (url.pathname === "/api/project")
      return json([
        {
          id: "proj_current",
          canonical: "/tmp/opencode/project",
          name: "OpenCode",
          time: { created: 1, updated: 2 },
          sandboxes: ["/tmp/opencode/feature-branch"],
        },
        {
          id: "global",
          canonical: "/",
          time: { created: 1, updated: 2 },
          sandboxes: [],
        },
      ])
    if (url.pathname !== "/api/session") return undefined
    return json({
      data: [
        {
          id: "ses_global",
          projectID: "global",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 1, updated: 3 },
          title: "Standalone session",
          location: { directory: "/tmp/standalone-notes" },
        },
        {
          id: "ses_worktree",
          projectID: "proj_current",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 1, updated: 2 },
          title: "Worktree session",
          location: { directory: "/tmp/opencode/feature-branch" },
        },
      ],
      cursor: {},
    })
  })

  try {
    const frame = await fixture.app.waitForFrame(
      (value) => value.includes("Standalone session") && value.includes("feature-branch") && value.includes("Projects"),
    )
    expect(frame).toContain("standalone-notes")
    expect(frame).toContain("OpenCode · feature-branch")
    expect(frame.match(/\/tmp\/opencode\/feature-branch/g)).toHaveLength(1)

    await fixture.app.mockInput.typeText("standalone-notes")
    await fixture.app.waitForFrame((value) => value.includes("standalone-notes"))
    fixture.app.mockInput.pressEnter()
    await fixture.app.waitFor(() => fixture.route.data.type === "home")
    expect(fixture.route.data).toEqual({ type: "home", location: { directory: "/tmp/standalone-notes" } })
  } finally {
    await fixture.dispose()
  }
})

test("shows nested Git session directories as projects and in their session footer", async () => {
  const fixture = await renderOpen((url) => {
    if (url.pathname === "/api/project")
      return json([
        {
          id: "proj_current",
          canonical: "/tmp/opencode/project",
          name: "OpenCode",
          time: { created: 1, updated: 2 },
          sandboxes: [],
        },
      ])
    if (url.pathname !== "/api/session") return undefined
    return json({
      data: [
        {
          id: "ses_dashboard",
          projectID: "proj_current",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 1, updated: 2 },
          title: "Improve dashboard",
          location: { directory: "/tmp/opencode/project/packages/dashboard" },
        },
      ],
      cursor: {},
    })
  })

  try {
    const frame = await fixture.app.waitForFrame(
      (value) => value.includes("Improve dashboard") && value.includes("Projects"),
    )
    expect(frame).toContain("OpenCode · dashboard")
    expect(frame).not.toContain("browse directories")
    expect(frame).toContain("/tmp/opencode/project/packages/dashboard")
  } finally {
    await fixture.dispose()
  }
})

test("loads Git worktrees only when drilling into a project or its associated directory", async () => {
  const root = path.resolve("/tmp/opencode/project")
  const current = path.resolve("/tmp/opencode/current-branch")
  const other = path.resolve("/tmp/opencode/other-branch")
  const workspaceID = "ws_worktree"
  let requests = 0
  const fixture = await renderOpen(
    (url) => {
      if (url.pathname === "/api/project")
        return json([
          {
            id: "proj_git",
            canonical: root,
            name: "OpenCode",
            vcs: "git",
            time: { created: 1, updated: 2 },
            sandboxes: [current],
          },
        ])
      if (url.pathname === "/api/location")
        return json({
          directory: current,
          workspaceID,
          project: { id: "proj_git", directory: current, canonical: root },
        })
      if (url.pathname !== "/api/worktree") return undefined
      expect(url.searchParams.get("location[directory]")).toBe(root)
      expect(url.searchParams.get("location[workspace]")).toBe(workspaceID)
      requests++
      return json([{ directory: other, strategy: "git" }, { directory: root }, { directory: current, strategy: "git" }])
    },
    async ({ data, location }) => {
      await data.location.sync({ directory: current, workspaceID })
      location.set({ directory: current, workspaceID })
    },
  )

  try {
    const projects = await fixture.app.waitForFrame(
      (frame) => frame.includes("OpenCode") && frame.includes("current-branch") && frame.includes("→"),
    )
    expect(projects).not.toContain("Browse directories")
    expect(requests).toBe(0)

    fixture.app.mockInput.pressArrow("right")
    const worktrees = await fixture.app.waitForFrame(
      (frame) => frame.includes("other-branch") && frame.includes("ctrl+n"),
    )
    expect(requests).toBe(1)
    expect(worktrees).toContain("Worktrees")
    expect(worktrees).toContain("●")
    expect(worktrees.indexOf("OpenCode")).toBeLessThan(worktrees.indexOf("current-branch"))
    expect(worktrees.indexOf("current-branch")).toBeLessThan(worktrees.indexOf("other-branch"))

    fixture.app.mockInput.pressArrow("left")
    await fixture.app.waitForFrame((frame) => frame.includes("Search sessions and projects"))
    await fixture.app.mockInput.typeText("current-branch")
    await fixture.app.waitForFrame((frame) => frame.includes("current-branch") && !frame.includes("OpenCode"))
    fixture.app.mockInput.pressArrow("right")
    await fixture.app.waitForFrame((frame) => frame.includes("other-branch") && frame.includes("ctrl+n"))
    expect(requests).toBe(2)
    fixture.app.mockInput.pressEscape()
    const restored = await fixture.app.waitForFrame(
      (frame) => frame.includes("current-branch") && !frame.includes("Worktrees"),
    )
    expect(restored).toContain("current-branch")
    expect(restored).not.toContain("OpenCode")
    fixture.app.mockInput.pressArrow("right")
    await fixture.app.waitForFrame((frame) => frame.includes("other-branch") && frame.includes("ctrl+n"))

    await fixture.app.mockInput.typeText("other-branch")
    fixture.app.mockInput.pressEnter()
    await fixture.app.waitFor(() => fixture.route.data.type === "home")
    expect(fixture.route.data).toEqual({ type: "home", location: { directory: other, workspaceID } })
  } finally {
    await fixture.dispose()
  }
})

test("does not show or trigger worktree navigation for non-Git and global directories", async () => {
  const root = path.resolve("/tmp/plain-project")
  const standalone = path.resolve("/tmp/standalone-notes")
  let requests = 0
  const fixture = await renderOpen((url) => {
    if (url.pathname === "/api/project")
      return json([
        { id: "proj_plain", canonical: root, name: "Plain project", time: { created: 1, updated: 2 }, sandboxes: [] },
        { id: "global", canonical: "/", time: { created: 1, updated: 1 }, sandboxes: [] },
      ])
    if (url.pathname === "/api/session")
      return json({
        data: [
          {
            id: "ses_global",
            projectID: "global",
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            time: { created: 1, updated: 2 },
            title: "Standalone session",
            location: { directory: standalone },
          },
        ],
        cursor: {},
      })
    if (url.pathname !== "/api/worktree") return undefined
    requests++
    return json([])
  })

  try {
    const frame = await fixture.app.waitForFrame(
      (value) => value.includes("Plain project") && value.includes("standalone-notes"),
    )
    expect(frame).not.toContain("→")
    fixture.app.mockInput.pressArrow("down")
    fixture.app.mockInput.pressArrow("right")
    fixture.app.mockInput.pressArrow("down")
    fixture.app.mockInput.pressArrow("right")
    await fixture.app.renderOnce()
    expect(fixture.app.captureCharFrame()).toContain("Search sessions and projects")
    expect(requests).toBe(0)
  } finally {
    await fixture.dispose()
  }
})

test("keeps session directory targets distinct across workspaces", async () => {
  const directory = "/tmp/opencode/archive"
  const fixture = await renderOpen((url) => {
    if (url.pathname === "/api/project") return json([])
    if (url.pathname !== "/api/session") return undefined
    return json({
      data: ["ws_first", "ws_second"].map((workspaceID, index) => ({
        id: `ses_${workspaceID}`,
        projectID: "proj_archive",
        title: `Archived session ${index}`,
        location: { directory, workspaceID },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: 1, updated: 2 - index },
      })),
      cursor: {},
    })
  })
  try {
    await fixture.app.waitForFrame((frame) => frame.includes("Archived session"))
    await fixture.app.mockInput.typeText("archive")
    const frame = await fixture.app.waitForFrame((frame) => frame.includes(directory))
    expect(frame.split("\n").filter((line) => line.includes(directory))).toHaveLength(2)
    fixture.app.mockInput.pressArrow("down")
    fixture.app.mockInput.pressEnter()
    await fixture.app.waitFor(() => fixture.route.data.type === "home")
    expect(fixture.route.data).toEqual({ type: "home", location: { directory, workspaceID: "ws_second" } })
    expect(fixture.location.ref).toEqual({ directory, workspaceID: "ws_second" })
  } finally {
    await fixture.dispose()
  }
})

test("does not show the previous project's worktrees while loading another project", async () => {
  const pending = Promise.withResolvers<Response>()
  const fixture = await renderOpen((url) => {
    if (url.pathname === "/api/project")
      return json(
        ["Alpha", "Beta"].map((name) => ({
          id: `proj_${name}`,
          canonical: `/tmp/opencode/${name}`,
          name,
          vcs: "git",
          sandboxes: [],
          time: { created: 1, updated: 2 },
        })),
      )
    if (url.pathname !== "/api/worktree") return undefined
    if (url.searchParams.get("location[directory]") === "/tmp/opencode/Alpha")
      return json([{ directory: "/tmp/opencode/alpha-checkout", strategy: "git" }])
    return pending.promise
  })
  try {
    await fixture.app.waitForFrame((frame) => frame.includes("Alpha") && frame.includes("Beta"))
    await fixture.app.mockInput.typeText("Alpha")
    fixture.app.mockInput.pressArrow("right")
    await fixture.app.waitForFrame((frame) => frame.includes("alpha-checkout"))
    fixture.app.mockInput.pressEscape()
    fixture.app.mockInput.pressKey("c", { ctrl: true })
    await fixture.app.mockInput.typeText("Beta")
    fixture.app.mockInput.pressArrow("right")
    const loading = await fixture.app.waitForFrame(
      (frame) => frame.includes("Beta / Worktrees") && frame.includes("Loading worktrees"),
    )
    expect(loading).not.toContain("alpha-checkout")
    pending.resolve(json([{ directory: "/tmp/opencode/beta-checkout", strategy: "git" }]))
    const loaded = await fixture.app.waitForFrame((frame) => frame.includes("beta-checkout"))
    expect(loaded).not.toContain("alpha-checkout")
    fixture.app.mockInput.pressArrow("down")
    fixture.app.mockInput.pressEnter()
    await fixture.app.waitFor(() => fixture.route.data.type === "home")
    expect(fixture.location.ref?.directory).toBe("/tmp/opencode/beta-checkout")
  } finally {
    pending.resolve(json([]))
    await fixture.dispose()
  }
})

test.each(["", "search-ui"])("creates a worktree named '%s' and opens it in the current workspace", async (name) => {
  const projectID = "proj_git_create"
  const root = path.resolve("/tmp/opencode/project")
  const created = path.resolve("/tmp/opencode/created-branch")
  const workspaceID = "ws_create"
  let payload: unknown
  const fixture = await renderOpen(
    async (url, request) => {
      if (url.pathname === "/api/project")
        return json([
          {
            id: projectID,
            canonical: root,
            name: "OpenCode",
            vcs: "git",
            time: { created: 1, updated: 2 },
            sandboxes: [],
          },
        ])
      if (url.pathname === "/api/location")
        return json({ directory: root, workspaceID, project: { id: projectID, directory: root, canonical: root } })
      if (url.pathname !== "/api/worktree") return undefined
      expect(url.searchParams.get("location[directory]")).toBe(root)
      expect(url.searchParams.get("location[workspace]")).toBe(workspaceID)
      if (request.method === "GET") return json([{ directory: root }])
      payload = await request.json()
      return json({ directory: created })
    },
    async ({ data, location }) => {
      await data.location.sync({ directory: root, workspaceID })
      location.set({ directory: root, workspaceID })
    },
  )

  try {
    await fixture.app.waitForFrame((frame) => frame.includes("OpenCode") && frame.includes("→"))
    fixture.app.mockInput.pressArrow("right")
    const worktrees = await fixture.app.waitForFrame((frame) => frame.includes("ctrl+n"))
    expect(worktrees).not.toContain("Actions")
    expect(worktrees).not.toContain("+ New worktree")
    await fixture.app.mockInput.typeText("unmatched-search")
    const filtered = await fixture.app.waitForFrame((frame) => frame.includes("unmatched-search"))
    expect(filtered).toContain("ctrl+n")
    expect(filtered).toContain("No matching worktrees")
    fixture.app.mockInput.pressKey("n", { ctrl: true })
    await fixture.app.waitForFrame((frame) => frame.includes("Worktree name (optional)"))
    const prompt = fixture.app.captureCharFrame().split("\n")
    const row = prompt.findIndex((line) => line.includes("Leave blank"))
    const column = prompt[row]!.indexOf("Leave") + 1
    await fixture.app.mockMouse.click(column, row)
    await fixture.app.mockMouse.click(column, row)
    await fixture.app.waitFor(() => fixture.app.renderer.getSelection()?.getSelectedText() === "Leave")
    fixture.app.mockInput.pressEscape()
    await fixture.app.waitFor(() => !fixture.app.renderer.getSelection())
    expect(fixture.app.captureCharFrame()).toContain("Worktree name (optional)")
    fixture.app.mockInput.pressEscape()
    const restored = await fixture.app.waitForFrame(
      (frame) => frame.includes("unmatched-search") && frame.includes("ctrl+n"),
    )
    expect(restored).toContain("unmatched-search")
    expect(payload).toBeUndefined()
    fixture.app.mockInput.pressKey("n", { ctrl: true })
    await fixture.app.waitForFrame((frame) => frame.includes("Worktree name (optional)"))
    if (name) await fixture.app.mockInput.typeText(name)
    fixture.app.mockInput.pressEnter()
    await fixture.app.waitFor(() => fixture.route.data.type === "home")

    expect(payload).toEqual(name ? { name } : {})
    expect(fixture.route.data).toEqual({ type: "home", location: { directory: created, workspaceID } })
    expect(fixture.location.ref).toEqual({ directory: created, workspaceID })
  } finally {
    await fixture.dispose()
  }
})

test("shows projects while sessions refresh and preserves the selected project", async () => {
  let resolveSessions!: (response: Response) => void
  const sessions = new Promise<Response>((resolve) => (resolveSessions = resolve))
  const fixture = await renderOpen((url) => {
    if (url.pathname === "/api/session") return sessions
    if (url.pathname === "/api/project")
      return json([
        {
          id: "proj_first",
          canonical: "/tmp/opencode/first",
          name: "First project",
          time: { created: 1, updated: 2 },
          sandboxes: [],
        },
        {
          id: "proj_second",
          canonical: "/tmp/opencode/second",
          name: "Second project",
          time: { created: 1, updated: 1 },
          sandboxes: [],
        },
      ])
    return undefined
  })

  try {
    await fixture.app.waitForFrame((frame) => frame.includes("Second project") && frame.includes("Refreshing"))
    expect(fixture.app.captureCharFrame()).toContain("Search sessions and projects")
    fixture.app.mockInput.pressArrow("down")

    resolveSessions(
      json({
        data: [
          {
            id: "ses_recent",
            projectID: "proj_first",
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            time: { created: 2, updated: 3 },
            title: "Recent session",
            location: { directory: "/tmp/opencode/first" },
          },
        ],
        cursor: {},
      }),
    )
    await fixture.app.waitForFrame((frame) => frame.includes("Recent session") && frame.includes("Second project"))
    fixture.app.mockInput.pressEnter()
    await fixture.app.waitFor(() => fixture.route.data.type === "home")

    expect(fixture.route.data).toEqual({ type: "home", location: { directory: "/tmp/opencode/second" } })
  } finally {
    await fixture.dispose()
  }
})

test.each([false, true])("keeps a filtered selection visible after refresh with query reset %s", async (reset) => {
  const sessions = Promise.withResolvers<Response>()
  const fixture = await renderOpen((url) => {
    if (url.pathname === "/api/session") return sessions.promise
    if (url.pathname === "/api/project")
      return json([
        {
          id: "proj_first",
          canonical: "/tmp/opencode/first",
          name: "First shared project",
          time: { created: 1, updated: 2 },
          sandboxes: [],
        },
        {
          id: "proj_second",
          canonical: "/tmp/opencode/second",
          name: "Second shared project",
          time: { created: 1, updated: 1 },
          sandboxes: [],
        },
      ])
    return undefined
  })
  const selectedTitle = () =>
    fixture.app
      .captureSpans()
      .lines.flatMap((line) => line.spans)
      .filter((span) => span.attributes & TextAttributes.BOLD)
      .map((span) => span.text)
      .join("")
  try {
    await fixture.app.waitForFrame((frame) => frame.includes("Second shared project") && frame.includes("Refreshing"))
    await fixture.app.mockInput.typeText("shared")
    await fixture.app.waitForFrame(() => selectedTitle().includes("First shared project"))
    fixture.app.mockInput.pressArrow("down")
    await fixture.app.waitForFrame(() => selectedTitle().includes("Second shared project"))

    sessions.resolve(
      json({
        data: Array.from({ length: 12 }, (_, index) => ({
          ...recentSession,
          id: `ses_shared_${index}`,
          title: "shared",
          time: { created: 1, updated: index + 3 },
        })),
        cursor: {},
      }),
    )
    await fixture.app.waitForFrame((frame) => frame.includes("Open") && !frame.includes("Refreshing"))
    // Selection reveal runs on FRAME; the following paint must show the selected row.
    const frame = once(fixture.app.renderer, CliRenderEvents.FRAME)
    fixture.app.renderer.requestRender()
    await frame
    expect(fixture.app.captureCharFrame()).toContain("Second shared project")
    expect(selectedTitle()).toContain("Second shared project")

    if (reset) {
      await fixture.app.mockInput.typeText(" project")
      await fixture.app.waitForFrame(() => selectedTitle().includes("First shared project"))
      expect(fixture.app.captureCharFrame()).toContain("Second shared project")
      expect(selectedTitle()).not.toContain("Second shared project")
    }
    fixture.app.mockInput.pressEnter()
    await fixture.app.waitFor(() => fixture.route.data.type === "home")
    expect(fixture.route.data).toEqual({
      type: "home",
      location: { directory: `/tmp/opencode/${reset ? "first" : "second"}` },
    })
  } finally {
    sessions.resolve(json({ data: [], cursor: {} }))
    await fixture.dispose()
  }
})

const recentSession = {
  id: "ses_recent",
  projectID: "proj_recent",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 2 },
  title: "Recent session",
  location: { directory: "/fixture" },
}

test("sessions remain selectable while projects are still loading", async () => {
  const projects = Promise.withResolvers<Response>()
  const fixture = await renderOpen((url) => {
    if (url.pathname === "/api/session") return json({ data: [recentSession], cursor: {} })
    if (url.pathname === "/api/project") return projects.promise
    return undefined
  })
  try {
    await fixture.app.waitForFrame((frame) => frame.includes("Recent session") && frame.includes("Refreshing"))
    fixture.app.mockInput.pressEnter()
    await fixture.app.waitFor(() => fixture.route.data.type === "session")
    expect(fixture.route.data).toEqual({ type: "session", sessionID: recentSession.id })
  } finally {
    projects.resolve(json([]))
    await fixture.dispose()
  }
})

test("shows hydrated sessions immediately without waiting for either read", async () => {
  const sessions = Promise.withResolvers<Response>()
  const projects = Promise.withResolvers<Response>()
  const fixture = await renderOpen(
    (url) => {
      if (url.pathname === "/api/session") return sessions.promise
      if (url.pathname === "/api/project") return projects.promise
      return undefined
    },
    ({ data }) => data.session.remember(recentSession),
  )
  try {
    await fixture.app.waitForFrame((frame) => frame.includes("Recent session") && frame.includes("Refreshing"))
    fixture.app.mockInput.pressEnter()
    await fixture.app.waitFor(() => fixture.route.data.type === "session")
    expect(fixture.route.data).toEqual({ type: "session", sessionID: recentSession.id })
  } finally {
    sessions.resolve(json({ data: [], cursor: {} }))
    projects.resolve(json([]))
    await fixture.dispose()
  }
})

test("keeps an uncached moved session in the first successful refresh", async () => {
  const response = Promise.withResolvers<Response>()
  const destination = { directory: "/fixture/destination" }
  const fixture = await renderOpen((url) => (url.pathname === "/api/session" ? response.promise : undefined))
  try {
    await fixture.app.waitForFrame((frame) => frame.includes("Refreshing"))
    fixture.emit({
      id: "evt_uncached_move",
      created: 3,
      type: "session.moved",
      durable: { aggregateID: recentSession.id, seq: 1, version: 1 },
      data: { sessionID: recentSession.id, location: destination, projectID: "proj_destination" },
    })
    // The following event supplies an ordered-stream receipt barrier without hydrating metadata.
    fixture.emit({
      id: "evt_move_received",
      created: 4,
      type: "session.execution.started",
      durable: { aggregateID: recentSession.id, seq: 2, version: 1 },
      data: { sessionID: recentSession.id },
    })
    await fixture.app.waitFor(() => fixture.data.session.status(recentSession.id) === "running")
    expect(fixture.data.session.get(recentSession.id)).toBeUndefined()
    response.resolve(
      json({
        data: [
          { ...recentSession, location: destination, projectID: "proj_destination", time: { created: 1, updated: 3 } },
        ],
        cursor: {},
      }),
    )
    await fixture.app.waitForFrame((frame) => frame.includes(recentSession.title) && !frame.includes("Refreshing"))
    fixture.app.mockInput.pressEnter()
    await fixture.app.waitFor(() => fixture.route.data.type === "session")
    expect(fixture.route.data).toEqual({ type: "session", sessionID: recentSession.id })
    expect(fixture.location.ref).toEqual(destination)
  } finally {
    response.resolve(json({ data: [], cursor: {} }))
    await fixture.dispose()
  }
})

test("keeps the previous recent list usable when reopening fails to refresh", async () => {
  let requests = 0
  const fixture = await renderOpen((url) => {
    if (url.pathname === "/api/session")
      return requests++ === 0
        ? json({ data: [recentSession], cursor: {} })
        : new Response("Unavailable", { status: 503 })
    return undefined
  })
  try {
    await fixture.app.waitForFrame((frame) => frame.includes("Recent session") && !frame.includes("Refreshing"))
    fixture.app.mockInput.pressEscape()
    await fixture.app.waitForFrame((frame) => !frame.includes("Recent session"))
    fixture.open()
    await fixture.app.waitForFrame((frame) => frame.includes("Could not refresh sessions"))
    expect(fixture.app.captureCharFrame()).toContain("Recent session")
    fixture.app.mockInput.pressEnter()
    await fixture.app.waitFor(() => fixture.route.data.type === "session")
    expect(fixture.route.data).toEqual({ type: "session", sessionID: recentSession.id })
  } finally {
    await fixture.dispose()
  }
})

test("shows an initial loading shell instead of reporting an empty list", async () => {
  const sessions = Promise.withResolvers<Response>()
  const projects = Promise.withResolvers<Response>()
  const fixture = await renderOpen((url) => {
    if (url.pathname === "/api/session") return sessions.promise
    if (url.pathname === "/api/project") return projects.promise
    return undefined
  })
  try {
    await fixture.app.waitForFrame(
      (frame) => frame.includes("Search sessions and projects") && frame.includes("Refreshing"),
    )
    expect(fixture.app.captureCharFrame()).not.toContain("No items available")
    await fixture.app.mockInput.typeText("missing")
    await fixture.app.waitForFrame((frame) => frame.includes("Searching sessions and projects"))
    expect(fixture.app.captureCharFrame()).not.toContain("No matches")
    sessions.resolve(json({ data: [], cursor: {} }))
    projects.resolve(json([]))
    await fixture.app.waitForFrame((frame) => frame.includes("No matches") && !frame.includes("Refreshing"))
  } finally {
    sessions.resolve(json({ data: [], cursor: {} }))
    projects.resolve(json([]))
    await fixture.dispose()
  }
})

test("reports both refresh failures while keeping hydrated sessions usable", async () => {
  const fixture = await renderOpen(
    (url) => {
      if (url.pathname === "/api/session" || url.pathname === "/api/project")
        return new Response("Unavailable", { status: 503 })
      return undefined
    },
    ({ data }) => data.session.remember(recentSession),
  )
  try {
    await fixture.app.waitForFrame((frame) => frame.includes("Could not refresh sessions and projects"))
    expect(fixture.app.captureCharFrame()).toContain("Recent session")
  } finally {
    await fixture.dispose()
  }
})

test("option arrows jump between sections", async () => {
  const handler: FetchHandler = (url) => {
    if (url.pathname === "/api/session")
      return json({
        data: [
          {
            id: "ses_recent",
            projectID: "proj_recent",
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            time: { created: 1, updated: 2 },
            title: "Recent session",
            location: { directory: "/tmp/opencode/recent" },
          },
        ],
        cursor: {},
      })
    if (url.pathname === "/api/project")
      return json([
        {
          id: "proj_recent",
          canonical: "/tmp/opencode/recent",
          name: "Recent project",
          time: { created: 1, updated: 2 },
          sandboxes: [],
        },
      ])
    return undefined
  }

  const next = await renderOpen(handler)
  try {
    await next.app.waitForFrame((frame) => frame.includes("Recent session") && frame.includes("Recent project"))
    next.app.mockInput.pressArrow("down", { meta: true })
    next.app.mockInput.pressEnter()
    await next.app.waitFor(() => next.route.data.type === "home")
    expect(next.route.data).toEqual({ type: "home", location: { directory: "/tmp/opencode/recent" } })
  } finally {
    await next.dispose()
  }

  const previous = await renderOpen(handler)
  try {
    await previous.app.waitForFrame((frame) => frame.includes("Recent session") && frame.includes("Recent project"))
    previous.app.mockInput.pressArrow("up", { meta: true })
    previous.app.mockInput.pressEnter()
    await previous.app.waitFor(() => previous.route.data.type === "home")
    expect(previous.route.data).toEqual({ type: "home", location: { directory: "/tmp/opencode/recent" } })
  } finally {
    await previous.dispose()
  }
})

test("option arrows stay in the only visible section", async () => {
  const fixture = await renderOpen((url) => {
    if (url.pathname === "/api/session") return json({ data: [], cursor: {} })
    if (url.pathname !== "/api/project") return undefined
    return json([
      {
        id: "proj_effect",
        canonical: "/tmp/effect",
        name: "Effect",
        time: { created: 1, updated: 2 },
        sandboxes: [],
      },
      {
        id: "proj_opencode",
        canonical: "/tmp/opencode",
        name: "OpenCode",
        time: { created: 1, updated: 1 },
        sandboxes: [],
      },
    ])
  })

  try {
    await fixture.app.waitForFrame((frame) => frame.includes("Effect") && frame.includes("OpenCode"))
    await fixture.app.mockInput.typeText("Effect")
    await fixture.app.waitForFrame((frame) => frame.includes("Effect") && !frame.includes("OpenCode"))
    fixture.app.mockInput.pressArrow("down", { meta: true })
    fixture.app.mockInput.pressEnter()
    await fixture.app.waitFor(() => fixture.route.data.type === "home")
    expect(fixture.route.data).toEqual({ type: "home", location: { directory: "/tmp/effect" } })
  } finally {
    await fixture.dispose()
  }
})

async function renderOpen(
  handler: FetchHandler,
  beforeOpen?: (contexts: {
    data: ReturnType<typeof useData>
    location: ReturnType<typeof useLocation>
  }) => void | Promise<void>,
) {
  const temporary = await tmpdir()
  const state = temporary.path
  const events = createEventStream()
  const calls = createFetch(handler, events)
  let route!: ReturnType<typeof useRoute>
  let location!: ReturnType<typeof useLocation>
  let data!: ReturnType<typeof useData>
  let storage!: ReturnType<typeof useStorage>
  let open!: () => void

  function Probe() {
    const dialog = useDialog()
    const [sessions, setSessions] = createSignal<SessionInfo[]>([])
    route = useRoute()
    location = useLocation()
    data = useData()
    storage = useStorage()
    open = () =>
      dialog.replace(() => <DialogOpen sessions={sessions()} onLoad={setSessions} />, undefined, {
        key: DialogOpenKey,
        size: "large",
      })
    onMount(() => void Promise.resolve(beforeOpen?.({ data, location })).then(open))
    return null
  }

  const app = await testRender(
    () => (
      <TestTuiContexts paths={{ state }}>
        <TuiAppProvider value={{ name: "test", version: "test", channel: "test" }}>
          <StorageProvider>
            <ConfigProvider config={createTuiResolvedConfig()}>
              <Keymap.Provider>
                <ToastProvider>
                  <RouteProvider>
                    <ClientProvider api={createApi(calls.fetch)}>
                      <DataProvider directory={process.cwd()}>
                        <LocationProvider>
                          <SessionTabsProvider>
                            <ThemeProvider mode="dark" source={emptyThemeSource}>
                              <DialogProvider>
                                <Probe />
                              </DialogProvider>
                            </ThemeProvider>
                          </SessionTabsProvider>
                        </LocationProvider>
                      </DataProvider>
                    </ClientProvider>
                  </RouteProvider>
                </ToastProvider>
              </Keymap.Provider>
            </ConfigProvider>
          </StorageProvider>
        </TuiAppProvider>
      </TestTuiContexts>
    ),
    { width: 100, height: 30, kittyKeyboard: true },
  )
  app.renderer.start()

  return {
    app,
    emit: events.emit,
    open: () => open(),
    get route() {
      return route
    },
    get location() {
      return location
    },
    get data() {
      return data
    },
    async dispose() {
      app.renderer.destroy()
      await storage.flush()
      await temporary[Symbol.asyncDispose]()
    },
  }
}
