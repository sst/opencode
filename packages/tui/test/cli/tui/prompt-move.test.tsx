/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { InputRenderable } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { usePromptMove } from "../../../src/component/prompt/move"
import { ConfigProvider } from "../../../src/config"
import { ClientProvider } from "../../../src/context/client"
import { DataProvider, useData } from "../../../src/context/data"
import { Keymap } from "../../../src/context/keymap"
import { LocationProvider, useLocation } from "../../../src/context/location"
import { RouteProvider, useRoute } from "../../../src/context/route"
import { ThemeProvider } from "../../../src/context/theme"
import { DialogProvider } from "../../../src/ui/dialog"
import { ToastProvider, useToast } from "../../../src/ui/toast"
import { emptyThemeSource } from "../../fixture/fixture"
import { createApi, createEventStream, createFetch, json } from "../../fixture/tui-client"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"

const main = "/tmp/opencode/main"
const clone = "/tmp/opencode/other-clone"
const linked = "/tmp/opencode/linked"
const created = "/tmp/opencode/proj_t/fresh"

test.each([
  { name: "a cached session in another clone", directory: clone, warm: true },
  { name: "an uncached session in a clone subdirectory", directory: `${clone}/packages/tui` },
  { name: "an uncached session in a linked worktree", directory: linked, worktree: linked },
  { name: "a session in a linked worktree subdirectory", directory: `${linked}/packages/tui`, worktree: linked },
  { name: "the home/default location", directory: `${clone}/packages/tui`, home: true },
])("passes the current location and uses server worktree defaults for $name", async (input) => {
  const fixture = await renderMove(input)
  try {
    await fixture.data.project.sync()
    expect(fixture.data.project.get("proj_test")?.canonical).toBe(main)
    if (input.warm) {
      await fixture.data.session.sync("ses_clone")
      await fixture.data.location.syncInfo({ directory: input.directory })
    }
    if (!input.home && !input.warm) {
      expect(fixture.data.session.get("ses_clone")).toBeUndefined()
      expect(fixture.data.location.info({ directory: input.directory })).toBeUndefined()
    }
    if (!input.home) fixture.location.set({ directory: main })

    await fixture.create()

    expect(fixture.requests).toEqual([{ payload: { name: "fresh" }, directory: input.directory, workspace: null }])
    expect(fixture.data.location.info({ directory: created })?.project.canonical).toBe(clone)
    expect(fixture.reads.locations.filter((directory) => directory === input.directory)).toHaveLength(1)
    expect(fixture.reads.session).toBe(input.home ? 0 : 1)
    expect(fixture.moves).toEqual([])
    if (!input.home) expect(fixture.route.data).toEqual({ type: "home", location: { directory: created } })
  } finally {
    fixture.app.renderer.destroy()
  }
})

test.each([
  { name: "another clone", launch: main },
  { name: "another project", launch: "/tmp/opencode/elsewhere", launchProjectID: "proj_launch" },
  { name: "another workspace", launch: main, workspaceID: "wrk_clone" },
])("uses Home's selected location instead of launch in $name", async (input) => {
  const fixture = await renderMove({ ...input, directory: `${clone}/packages/tui`, home: true })
  try {
    await fixture.data.location.syncInfo()
    const selected = { directory: `${clone}/packages/tui`, workspaceID: input.workspaceID }
    fixture.location.set(selected)
    expect(fixture.data.location.default().directory).toBe(input.launch)
    expect(fixture.data.location.info(selected)).toBeUndefined()

    const frame = await fixture.create()

    expect(fixture.reads.worktrees).toEqual([selected.directory])
    expect(frame).toContain(clone)
    expect(frame.indexOf(clone)).toBeLessThan(frame.indexOf(main))
    expect(fixture.requests).toEqual([
      { payload: { name: "fresh" }, directory: `${clone}/packages/tui`, workspace: input.workspaceID ?? null },
    ])
    expect(fixture.data.location.info(selected)?.project.canonical).toBe(clone)
    expect(fixture.moves).toEqual([])
  } finally {
    fixture.app.renderer.destroy()
  }
})

test.each([false, true])("selecting a workspace opens Home without moving a session (home=%s)", async (home) => {
  const fixture = await renderMove({ directory: clone, home })
  try {
    await fixture.move.open()
    await fixture.app.waitForFrame((frame) => frame.includes("Worktrees") && frame.includes(linked))
    await fixture.app.mockInput.typeText("linked")
    await fixture.app.waitForFrame((frame) => frame.includes(linked) && !frame.includes(clone))
    fixture.app.mockInput.pressEnter()
    await fixture.app.waitFor(() => fixture.route.data.type === "home" && fixture.route.data.location?.directory === linked)
    expect(fixture.route.data).toEqual({ type: "home", location: { directory: linked } })
    expect(fixture.moves).toEqual([])
    expect(fixture.requests).toEqual([])
    expect(fixture.move.pending()).toBe(false)
    if (!home) expect(fixture.data.session.get("ses_clone")?.location.directory).toBe(clone)
  } finally {
    fixture.app.renderer.destroy()
  }
})

test("removal uses the current configuration location, not the destination directory", async () => {
  const fixture = await renderMove({ directory: clone, home: true })
  try {
    await fixture.move.open()
    await fixture.app.waitForFrame((frame) => frame.includes("Worktrees") && frame.includes(linked))
    await fixture.app.mockInput.typeText("linked")
    await fixture.app.waitForFrame((frame) => frame.includes(linked) && !frame.includes(clone))
    fixture.app.mockInput.pressKey("d", { ctrl: true })
    await fixture.app.waitForFrame((frame) => frame.includes("again to confirm"))
    fixture.app.mockInput.pressKey("d", { ctrl: true })
    await fixture.app.waitFor(() => fixture.removals.length === 1)
    expect(fixture.removals).toEqual([{ payload: { directory: linked, force: false }, directory: clone }])
  } finally {
    fixture.app.renderer.destroy()
  }
})

test.each([false, true])("Ctrl+M moves only an existing session (home=%s)", async (home) => {
  const fixture = await renderMove({ directory: clone, home })
  try {
    await fixture.move.open()
    const frame = await fixture.app.waitForFrame((frame) => frame.includes("Worktrees") && frame.includes(linked))
    expect(frame).toContain("new ctrl+a")
    expect(frame.includes("move ctrl+m")).toBe(!home)
    await fixture.app.mockInput.typeText("linked")
    await fixture.app.waitForFrame((frame) => frame.includes(linked) && !frame.includes(clone))
    fixture.app.mockInput.pressKey("m", { ctrl: true })
    if (home) {
      await fixture.app.renderOnce()
      expect(fixture.moves).toEqual([])
      expect(fixture.route.data).toEqual({ type: "home" })
      expect(fixture.requests).toEqual([])
      return
    }
    await fixture.app.waitFor(() => fixture.moves.length === 1)
    expect(fixture.moves).toEqual([{ directory: linked }])
    expect(fixture.route.data).toEqual({ type: "session", sessionID: "ses_clone" })
    expect(fixture.requests).toEqual([])
  } finally {
    fixture.app.renderer.destroy()
  }
})

test.each([
  { name: "session", unavailable: "session" as const },
  { name: "location", unavailable: "location" as const },
  { name: "selected Home location", unavailable: "location" as const, home: true, launch: main },
])("does not create from another clone when $name lookup fails", async (input) => {
  const fixture = await renderMove({ ...input, directory: `${linked}/packages/tui`, worktree: linked })
  try {
    if (input.home) fixture.location.set({ directory: `${linked}/packages/tui` })
    await fixture.create()

    expect(fixture.requests).toEqual([])
    expect(fixture.moves).toEqual([])
    expect(fixture.toast.currentToast).toMatchObject({ title: "Creating workspace failed", variant: "error" })
    expect(fixture.move.creating()).toBe(false)
  } finally {
    fixture.app.renderer.destroy()
  }
})

async function renderMove(input: {
  directory: string
  worktree?: string
  home?: boolean
  launch?: string
  launchProjectID?: string
  unavailable?: "session" | "location"
}) {
  const launch = input.launch ?? (input.home ? input.directory : main)
  const requests: unknown[] = []
  const removals: unknown[] = []
  const moves: unknown[] = []
  const reads = { session: 0, locations: [] as string[], worktrees: [] as string[] }
  const calls = createFetch(async (url, request) => {
    if (url.pathname === "/api/location" || url.pathname === "/api/project/current") {
      const directory = url.searchParams.get("location[directory]") ?? launch
      const project = {
        id: directory === launch ? (input.launchProjectID ?? "proj_test") : "proj_test",
        directory: directory === input.directory ? (input.worktree ?? clone) : directory,
        canonical:
          directory === input.directory || directory === created
            ? clone
            : input.launchProjectID && directory === launch
              ? launch
              : main,
      }
      if (url.pathname === "/api/project/current") return json(project)
      reads.locations.push(directory)
      if (input.unavailable === "location" && directory === input.directory)
        return json({ message: "Location unavailable" }, { status: 503 })
      return json({
        directory,
        workspaceID: url.searchParams.get("location[workspace]") ?? undefined,
        project,
      })
    }
    if (url.pathname === "/api/project")
      return json([{ id: "proj_test", canonical: main, time: { created: 1, updated: 1 }, sandboxes: [] }])
    if (url.pathname === "/api/session/ses_clone") {
      reads.session++
      if (input.unavailable === "session") return json({ message: "Session unavailable" }, { status: 404 })
      return json({
        data: {
          id: "ses_clone",
          projectID: "proj_test",
          location: { directory: input.directory },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 1, updated: 1 },
        },
      })
    }
    if (url.pathname === "/api/worktree") {
      if (request.method === "GET") {
        const directory = url.searchParams.get("location[directory]") ?? launch
        reads.worktrees.push(directory)
        return json(
          directory === launch && input.launchProjectID
            ? [{ directory: launch }]
            : [{ directory: main }, { directory: clone }, { directory: linked, strategy: "git" }],
        )
      }
      if (request.method === "POST") {
        requests.push({
          payload: await request.json(),
          directory: url.searchParams.get("location[directory]"),
          workspace: url.searchParams.get("location[workspace]"),
        })
        return json({ directory: created })
      }
      if (request.method === "DELETE") {
        removals.push({ payload: await request.json(), directory: url.searchParams.get("location[directory]") })
        return new Response(null, { status: 204 })
      }
    }
    if (url.pathname === "/api/worktree/refresh") return new Response(null, { status: 204 })
    if (url.pathname === "/api/session/ses_clone/move") {
      moves.push(await request.json())
      return new Response(null, { status: 204 })
    }
    return undefined
  }, createEventStream())
  let data!: ReturnType<typeof useData>
  let move!: ReturnType<typeof usePromptMove>
  let toast!: ReturnType<typeof useToast>
  let location!: ReturnType<typeof useLocation>
  let route!: ReturnType<typeof useRoute>

  function Probe() {
    data = useData()
    toast = useToast()
    location = useLocation()
    route = useRoute()
    move = usePromptMove({
      projectID: () => (input.home ? data.location.info()?.project.id : "proj_test"),
      sessionID: () => (input.home ? undefined : "ses_clone"),
    })
    return null
  }

  const app = await testRender(
    () => (
      <TestTuiContexts cwd={launch}>
        <ConfigProvider config={createTuiResolvedConfig()}>
          <Keymap.Provider>
            <ToastProvider>
              <RouteProvider initialRoute={input.home ? { type: "home" } : { type: "session", sessionID: "ses_clone" }}>
                <ClientProvider api={createApi(calls.fetch)}>
                  <DataProvider directory={launch}>
                    <LocationProvider>
                      <ThemeProvider mode="dark" source={emptyThemeSource}>
                        <DialogProvider>
                          <Probe />
                        </DialogProvider>
                      </ThemeProvider>
                    </LocationProvider>
                  </DataProvider>
                </ClientProvider>
              </RouteProvider>
            </ToastProvider>
          </Keymap.Provider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 100, height: 30, kittyKeyboard: true },
  )
  app.renderer.start()
  await app.waitFor(() => move !== undefined)

  return {
    app,
    data,
    move,
    toast,
    location,
    route,
    requests,
    removals,
    moves,
    reads,
    async create() {
      await move.open()
      const frame = await app.waitForFrame(
        (frame) => frame.includes("Worktrees") && (frame.includes(clone) || frame.includes(launch)),
      )
      app.mockInput.pressKey("a", { ctrl: true })
      await app.waitForFrame((frame) => frame.includes("Name worktree"))
      await app.waitFor(() => app.renderer.currentFocusedEditor instanceof InputRenderable)
      await app.mockInput.typeText("fresh")
      app.mockInput.pressEnter()
      if (input.home) {
        await app.waitFor(() => move.pendingNew())
        await move.getDirectory()
        return frame
      }
      await app.waitFor(() => route.data.type === "home" || toast.currentToast !== null)
      return frame
    },
  }
}
