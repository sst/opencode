/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { BoxRenderable, MouseEvent, type Renderable } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { createMemo, createSignal, onMount } from "solid-js"
import { tmpdir } from "../../fixture/fixture"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createEventSource, createFetch, directory, json } from "../../fixture/tui-sdk"
import { mount, wait } from "../../fixture/tui-sync"
import { ArgsProvider } from "../../../src/context/args"
import { ExitProvider } from "../../../src/context/exit"
import { KVProvider, useKV } from "../../../src/context/kv"
import { PermissionProvider } from "../../../src/context/permission"
import { ProjectProvider } from "../../../src/context/project"
import { SDKProvider } from "../../../src/context/sdk"
import { SyncProvider, useSync } from "../../../src/context/sync"
import { ThemeProvider } from "../../../src/context/theme"
import { TuiConfigProvider } from "../../../src/config"
import { createPluginRuntime, PluginRuntimeProvider } from "../../../src/plugin/runtime"
import { SidebarDragRegion, SidebarRegion, sidebarVisibilityCommands } from "../../../src/routes/session"
import { SidebarRail } from "../../../src/routes/session/sidebar-rail"
import { clampSidebarWidth } from "../../../src/util/sidebar-width"
import { nextSidebarState, resolveSidebarWidth, sidebarLayout, type SidebarDrag } from "../../../src/util/sidebar-rail"

const sessionID = "ses_sidebar_rail"
const session = {
  id: sessionID,
  title: "Sidebar rail session",
  time: { created: 0, updated: 0 },
  version: "1.14.42",
  directory,
  project_id: "proj_test",
}

describe("sidebar rail rendering", () => {
  test("renders the inline rail and sidebar at the configured width", async () => {
    const rendered = await renderRegion({ wide: true, inline: "expanded", visible: true, width: 42 })
    try {
      expect(findRail(rendered.app.renderer.root)).toBeInstanceOf(BoxRenderable)
      expect(findBox(rendered.app.renderer.root, (box) => box.width === 42)).toBeInstanceOf(BoxRenderable)
    } finally {
      rendered.app.renderer.destroy()
      await rendered.dispose()
    }
  })

  test("keeps the inline rail and sidebar within the terminal beside oversized content", async () => {
    const expanded = await renderRegion({
      wide: true,
      inline: "expanded",
      visible: true,
      drag: true,
      oversizedContent: false,
      terminalWidth: 160,
    })
    const expandedTitleRow = sidebarTitleRow(expanded.app.renderer.root)
    try {
      const rail = findRail(expanded.app.renderer.root)
      const sidebar = findSidebarBox(expanded.app.renderer.root)
      expect(rail.x).toBe(116)
      expect(rail.width).toBe(2)
      expect(rail.getChildren()[0]?.x).toBe(117)
      const expandedFrame = expanded.app.captureCharFrame()
      expect(rail.getChildren()[0]?.y).toBe(expandedTitleRow)
      expect(expandedFrame.split("\n")[expandedTitleRow].indexOf("◂")).toBe(117)
      expect(sidebar?.x).toBe(118)
      expect(sidebar?.width).toBe(42)
    } finally {
      expanded.app.renderer.destroy()
      await expanded.dispose()
    }

    const collapsed = await renderRegion({
      wide: true,
      inline: "collapsed",
      visible: false,
      drag: true,
      oversizedContent: true,
      kv: { sidebar: "collapsed" },
      terminalWidth: 160,
    })
    try {
      const rail = findRail(collapsed.app.renderer.root)
      expect(rail.x).toBe(158)
      expect(rail.width).toBe(2)
      expect(rail.getChildren()[0]?.y).toBe(expandedTitleRow)
    } finally {
      collapsed.app.renderer.destroy()
      await collapsed.dispose()
    }
  })

  test("renders the collapse glyph in the second rail column", async () => {
    const rendered = await renderRegion({
      wide: true,
      inline: "collapsed",
      visible: false,
      drag: true,
      kv: { sidebar: "collapsed" },
      terminalWidth: 160,
    })
    try {
      const rail = findRail(rendered.app.renderer.root)
      const glyph = rail.getChildren()[0]
      if (!glyph) throw new Error("collapsed rail glyph was not rendered")
      const row = rendered.app.captureCharFrame().split("\n")[0]
      const glyphRow = rendered.app.captureCharFrame().split("\n")[glyph.y]
      const borderColumn = row.lastIndexOf("│")
      const glyphColumn = glyphRow.indexOf("▸")

      expect(glyph.x).toBe(159)
      expect(borderColumn).toBe(158)
      expect(glyphColumn).toBe(159)
      expect(glyphColumn).toBe(borderColumn + 1)
    } finally {
      rendered.app.renderer.destroy()
      await rendered.dispose()
    }

    const expanded = await renderRegion({
      wide: true,
      inline: "expanded",
      visible: true,
      drag: true,
      oversizedContent: false,
      kv: { sidebar: "auto" },
      terminalWidth: 160,
    })
    try {
      const rail = findRail(expanded.app.renderer.root)
      expect(rail.width).toBe(2)
      expect(rail.getChildren()[0]?.x).toBe(117)
      const expandedFrame = expanded.app.captureCharFrame()
      expect(rail.getChildren()[0]?.y).toBe(sidebarTitleRow(expanded.app.renderer.root))
      expect(expandedFrame.split("\n")[rail.getChildren()[0]?.y ?? 0].indexOf("◂")).toBe(117)
    } finally {
      expanded.app.renderer.destroy()
      await expanded.dispose()
    }
  })

  test("renders neither rail nor sidebar when inline layout is absent", async () => {
    const rendered = await renderRegion({ wide: true, inline: undefined, visible: false })
    try {
      expect(findBox(rendered.app.renderer.root, (box) => box.id === "sidebar-rail")).toBeUndefined()
      expect(findBox(rendered.app.renderer.root, (box) => box.width === 42)).toBeUndefined()
    } finally {
      rendered.app.renderer.destroy()
      await rendered.dispose()
    }
  })

  test("renders the narrow sidebar overlay without a rail", async () => {
    const rendered = await renderRegion({ wide: false, inline: undefined, visible: true, width: 42 })
    try {
      expect(findBox(rendered.app.renderer.root, (box) => box.id === "sidebar-rail")).toBeUndefined()
      expect(findBox(rendered.app.renderer.root, (box) => box.width === 42)).toBeInstanceOf(BoxRenderable)
    } finally {
      rendered.app.renderer.destroy()
      await rendered.dispose()
    }
  })
})

describe("sidebar drag gesture", () => {
  test("tracks the cursor during a drag and persists the width once on release", async () => {
    const rendered = await renderRegion({
      wide: true,
      inline: "expanded",
      visible: true,
      width: 42,
      drag: true,
      terminalWidth: 200,
    })
    const { app, file, kv } = rendered
    try {
      const rail = findRail(app.renderer.root)
      const row = findDragRow(app.renderer.root)
      fireMouse(rail, "down", 100)
      await settle(app)
      expect(findBox(app.renderer.root, (box) => box.width === 42)).toBeInstanceOf(BoxRenderable)
      expect(await Bun.file(file).text()).not.toContain("sidebar_width")
      expect(kv.writes).toBe(0)

      fireMouse(row, "drag", 92)
      await settle(app)
      expect(findBox(app.renderer.root, (box) => box.width === 50)).toBeInstanceOf(BoxRenderable)
      expect(await Bun.file(file).text()).not.toContain("sidebar_width")
      expect(kv.writes).toBe(0)

      fireMouse(row, "drag", 84)
      await settle(app)
      expect(findBox(app.renderer.root, (box) => box.width === 58)).toBeInstanceOf(BoxRenderable)
      expect(await Bun.file(file).text()).not.toContain("sidebar_width")
      expect(kv.writes).toBe(0)

      fireMouse(row, "drag-end", 84)
      await wait(async () => (await Bun.file(file).text()).includes("sidebar_width"))
      expect(await Bun.file(file).json()).toMatchObject({ sidebar_width: 58 })
      expect(kv.writes).toBe(1)

      fireMouse(row, "drag", 80)
      await settle(app)
      expect(findBox(app.renderer.root, (box) => box.width === 58)).toBeInstanceOf(BoxRenderable)
      expect(await Bun.file(file).json()).toMatchObject({ sidebar_width: 58 })
      expect(kv.writes).toBe(1)
    } finally {
      app.renderer.destroy()
      await rendered.dispose()
    }
  })

  test("expands a collapsed rail on first movement and drags from the floor width", async () => {
    const rendered = await renderRegion({
      wide: true,
      inline: "collapsed",
      visible: false,
      drag: true,
      kv: { sidebar: "collapsed" },
      terminalWidth: 200,
    })
    const { app, file, kv } = rendered
    try {
      await wait(() => findSidebarBox(app.renderer.root) === undefined)
      const rail = findRail(app.renderer.root)
      const row = findDragRow(app.renderer.root)
      fireMouse(rail, "down", 79)
      await settle(app)
      expect(findSidebarBox(app.renderer.root)).toBeUndefined()
      expect(kv.writes).toBe(0)

      fireMouse(row, "drag", 69)
      await settle(app)
      expect(findSidebarBox(app.renderer.root)?.width).toBe(30)
      const persisted = await Bun.file(file).json()
      expect(persisted).toMatchObject({ sidebar: "auto" })
      expect(persisted).not.toHaveProperty("sidebar_width")
      expect(kv.writes).toBe(1)

      fireMouse(row, "drag", 59)
      await settle(app)
      expect(findSidebarBox(app.renderer.root)?.width).toBe(40)
      expect(await Bun.file(file).json()).not.toHaveProperty("sidebar_width")
      expect(kv.writes).toBe(1)

      fireMouse(row, "drag-end", 59)
      await wait(async () => (await Bun.file(file).text()).includes("sidebar_width"))
      expect(await Bun.file(file).json()).toMatchObject({ sidebar: "auto", sidebar_width: 40 })
      expect(kv.writes).toBe(2)
    } finally {
      app.renderer.destroy()
      await rendered.dispose()
    }
  })

  test("expands a collapsed rail on a click without writing a width", async () => {
    const rendered = await renderRegion({
      wide: true,
      inline: "collapsed",
      visible: false,
      drag: true,
      kv: { sidebar: "collapsed" },
      terminalWidth: 200,
    })
    const { app, file, kv } = rendered
    try {
      await wait(() => findSidebarBox(app.renderer.root) === undefined)
      const rail = findRail(app.renderer.root)
      fireMouse(rail, "down", 79)
      await settle(app)
      fireMouse(rail, "up", 79)
      await settle(app)
      const persisted = await Bun.file(file).json()
      expect(persisted).toMatchObject({ sidebar: "auto" })
      expect(persisted).not.toHaveProperty("sidebar_width")
      expect(kv.writes).toBe(1)

      fireMouse(findDragRow(app.renderer.root), "drag-end", 79)
      await settle(app)
      expect(await Bun.file(file).json()).not.toHaveProperty("sidebar_width")
      expect(kv.writes).toBe(1)
    } finally {
      app.renderer.destroy()
      await rendered.dispose()
    }
  })

  test("release does not double-expand after a captured drag", async () => {
    const rendered = await renderRegion({
      wide: true,
      inline: "collapsed",
      visible: false,
      drag: true,
      kv: { sidebar: "collapsed" },
      terminalWidth: 200,
    })
    const { app, file, kv } = rendered
    try {
      await wait(() => findSidebarBox(app.renderer.root) === undefined)
      const rail = findRail(app.renderer.root)
      const row = findDragRow(app.renderer.root)
      fireMouse(rail, "down", 79)
      await settle(app)
      fireMouse(row, "drag", 69)
      await settle(app)
      expect(kv.writes).toBe(1)

      // Release dispatches drag-end and up in one burst, and the up can re-target the rail.
      fireMouse(row, "drag-end", 69)
      fireMouse(rail, "up", 79)
      await settle(app)
      expect(kv.writes).toBe(2)
      expect(await Bun.file(file).json()).toMatchObject({ sidebar: "auto", sidebar_width: 30 })
    } finally {
      app.renderer.destroy()
      await rendered.dispose()
    }
  })

  test("release does not double-expand a no-movement gesture", async () => {
    const rendered = await renderRegion({
      wide: true,
      inline: "collapsed",
      visible: false,
      drag: true,
      kv: { sidebar: "collapsed" },
      terminalWidth: 200,
    })
    const { app, file, kv } = rendered
    try {
      await wait(() => findSidebarBox(app.renderer.root) === undefined)
      const rail = findRail(app.renderer.root)
      const row = findDragRow(app.renderer.root)
      fireMouse(rail, "down", 79)
      await settle(app)
      fireMouse(row, "drag", 79)
      await settle(app)
      expect(kv.writes).toBe(0)

      // drag-end expands and the up re-targets the rail within the same dispatch burst.
      fireMouse(row, "drag-end", 79)
      fireMouse(rail, "up", 79)
      await settle(app)
      expect(kv.writes).toBe(1)
      const persisted = await Bun.file(file).json()
      expect(persisted).toMatchObject({ sidebar: "auto" })
      expect(persisted).not.toHaveProperty("sidebar_width")
    } finally {
      app.renderer.destroy()
      await rendered.dispose()
    }
  })

  test("expands through drag-end when a no-movement drag was captured", async () => {
    const rendered = await renderRegion({
      wide: true,
      inline: "collapsed",
      visible: false,
      drag: true,
      kv: { sidebar: "collapsed" },
      terminalWidth: 200,
    })
    const { app, file } = rendered
    try {
      await wait(() => findSidebarBox(app.renderer.root) === undefined)
      const rail = findRail(app.renderer.root)
      const row = findDragRow(app.renderer.root)
      fireMouse(rail, "down", 79)
      await settle(app)
      fireMouse(row, "drag", 79)
      await settle(app)
      expect(findSidebarBox(app.renderer.root)).toBeUndefined()

      fireMouse(row, "drag-end", 79)
      await settle(app)
      const persisted = await Bun.file(file).json()
      expect(persisted).toMatchObject({ sidebar: "auto" })
      expect(persisted).not.toHaveProperty("sidebar_width")
    } finally {
      app.renderer.destroy()
      await rendered.dispose()
    }
  })

  test("an expanded rail click collapses without arming a later content drag", async () => {
    const rendered = await renderRegion({
      wide: true,
      inline: "expanded",
      visible: true,
      width: 42,
      drag: true,
      terminalWidth: 200,
    })
    const { app, file, kv } = rendered
    try {
      const rail = findRail(app.renderer.root)
      const row = findDragRow(app.renderer.root)
      fireMouse(rail, "down", 98)
      await settle(app)
      fireMouse(rail, "up", 98)
      await settle(app)
      expect(kv.writes).toBe(1)
      expect(await Bun.file(file).json()).toMatchObject({ sidebar: "collapsed" })

      fireMouse(row, "drag", 88)
      await settle(app)
      fireMouse(row, "drag-end", 88)
      await settle(app)
      expect(findSidebarBox(app.renderer.root)).toBeUndefined()
      expect(await Bun.file(file).json()).toMatchObject({ sidebar: "collapsed" })
      expect(kv.writes).toBe(1)
      expect(await Bun.file(file).text()).not.toContain("sidebar_width")
    } finally {
      app.renderer.destroy()
      await rendered.dispose()
    }
  })

  test("an expanded rail click collapses without writing a width", async () => {
    const rendered = await renderRegion({
      wide: true,
      inline: "expanded",
      visible: true,
      width: 42,
      drag: true,
      terminalWidth: 200,
    })
    const { app, file, kv } = rendered
    try {
      const rail = findRail(app.renderer.root)
      fireMouse(rail, "down", 98)
      await settle(app)
      fireMouse(rail, "up", 98)
      await settle(app)
      expect(findSidebarBox(app.renderer.root)).toBeUndefined()
      expect(await Bun.file(file).json()).toMatchObject({ sidebar: "collapsed" })
      expect(await Bun.file(file).text()).not.toContain("sidebar_width")
      expect(kv.writes).toBe(1)
    } finally {
      app.renderer.destroy()
      await rendered.dispose()
    }
  })

  test("a press off the rail cancels an armed gesture", async () => {
    const rendered = await renderRegion({
      wide: true,
      inline: "expanded",
      visible: true,
      width: 42,
      drag: true,
      terminalWidth: 200,
    })
    const { app, kv } = rendered
    try {
      const rail = findRail(app.renderer.root)
      const row = findDragRow(app.renderer.root)
      fireMouse(rail, "down", 98)
      await settle(app)
      // Focus lost after the rail down: no up arrives, the next press begins elsewhere.
      fireMouse(row, "down", 50, row)
      await settle(app)
      fireMouse(row, "drag", 88)
      await settle(app)
      fireMouse(row, "drag-end", 88)
      await settle(app)
      expect(findSidebarBox(app.renderer.root)?.width).toBe(42)
      expect(kv.writes).toBe(0)
    } finally {
      app.renderer.destroy()
      await rendered.dispose()
    }
  })

  test("attaches no drag handlers when mouse support is disabled", async () => {
    const rendered = await renderRegion({
      wide: true,
      inline: "expanded",
      visible: true,
      width: 42,
      mouseEnabled: false,
      drag: true,
    })
    try {
      const rail = findRail(rendered.app.renderer.root)
      expect(mouseHandlers(rail).down).toBeUndefined()
      expect(mouseHandlers(rail).up).toBeUndefined()
      const row = findDragRow(rendered.app.renderer.root)
      expect(mouseHandlers(row).drag).toBeUndefined()
      expect(mouseHandlers(row)["drag-end"]).toBeUndefined()
    } finally {
      rendered.app.renderer.destroy()
      await rendered.dispose()
    }
  })
})

describe("sidebar visibility commands", () => {
  test("are inert in child sessions", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, JSON.stringify({ sidebar: "collapsed" }))
    const { app, kv } = await mount(undefined, tmp.path)
    const file = `${tmp.path}/kv.json`
    try {
      await wait(() => kv.get("sidebar") === "collapsed")
      const [sidebar, setSidebar] = kv.signal<"auto" | "collapsed" | "hide">("sidebar", "auto")
      const commands = sidebarVisibilityCommands({
        parentID: () => "ses_parent",
        wide: () => true,
        sidebar,
        sidebarVisible: () => true,
        setSidebar,
        setSidebarOpen: () => {},
        clearDialog: () => {},
      })
      expect(commands.every((command) => command.enabled === false)).toBe(true)

      commands.find((command) => command.value === "session.sidebar.toggle")!.run()
      commands.find((command) => command.value === "session.sidebar.hide")!.run()
      expect(kv.writes).toBe(0)
      expect(kv.get("sidebar")).toBe("collapsed")
      expect(await Bun.file(file).json()).toMatchObject({ sidebar: "collapsed" })
    } finally {
      app.renderer.destroy()
    }
  })

  test("toggle from a root session still persists", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, kv } = await mount(undefined, tmp.path)
    try {
      const [sidebar, setSidebar] = kv.signal<"auto" | "collapsed" | "hide">("sidebar", "auto")
      const commands = sidebarVisibilityCommands({
        parentID: () => undefined,
        wide: () => true,
        sidebar,
        sidebarVisible: () => true,
        setSidebar,
        setSidebarOpen: () => {},
        clearDialog: () => {},
      })
      expect(commands.every((command) => command.enabled === true)).toBe(true)

      commands.find((command) => command.value === "session.sidebar.toggle")!.run()
      expect(kv.writes).toBe(1)
      expect(kv.get("sidebar")).toBe("collapsed")
    } finally {
      app.renderer.destroy()
    }
  })
})

async function renderRegion(input: {
  wide: boolean
  inline: "expanded" | "collapsed" | undefined
  visible: boolean
  width?: number
  mouseEnabled?: boolean
  kv?: Record<string, unknown>
  drag?: boolean
  oversizedContent?: boolean
  terminalWidth?: number
}) {
  const state = await tmpdir()
  await Bun.write(`${state.path}/kv.json`, JSON.stringify(input.kv ?? {}))
  let sync!: ReturnType<typeof useSync>
  let kv!: ReturnType<typeof useKV>
  let ready!: () => void
  const mounted = new Promise<void>((resolve) => {
    ready = resolve
  })
  const events = createEventSource()
  const calls = createFetch((url) => {
    if (url.pathname === "/session") return json([session])
    return undefined
  }, events)
  const app = await testRender(
    () => (
      <TestTuiContexts paths={{ state: state.path }}>
        <ArgsProvider>
          <KVProvider>
            <TuiConfigProvider config={createTuiResolvedConfig()}>
              <ThemeProvider mode="dark">
                <PluginRuntimeProvider value={createPluginRuntime()}>
                  <SDKProvider url="http://test" directory={directory} fetch={calls.fetch} events={events.source}>
                    <PermissionProvider>
                      <ProjectProvider>
                        <ExitProvider exit={() => {}}>
                          <SyncProvider>
                            {input.drag ? (
                              <DragRegionProbe
                                input={input}
                                onMount={(value, kvContext) => {
                                  sync = value
                                  kv = kvContext
                                  ready()
                                }}
                              />
                            ) : (
                              <RegionProbe
                                input={input}
                                onMount={(value) => {
                                  sync = value
                                  ready()
                                }}
                              />
                            )}
                          </SyncProvider>
                        </ExitProvider>
                      </ProjectProvider>
                    </PermissionProvider>
                  </SDKProvider>
                </PluginRuntimeProvider>
              </ThemeProvider>
            </TuiConfigProvider>
          </KVProvider>
        </ArgsProvider>
      </TestTuiContexts>
    ),
    { width: input.terminalWidth ?? 80, height: 10 },
  )
  await mounted
  await wait(() => sync.status === "complete")
  await settle(app)
  return { app, file: `${state.path}/kv.json`, kv, dispose: () => state[Symbol.asyncDispose]() }
}

function RegionProbe(props: {
  input: {
    wide: boolean
    inline: "expanded" | "collapsed" | undefined
    visible: boolean
    width?: number
    mouseEnabled?: boolean
  }
  onMount: (sync: ReturnType<typeof useSync>) => void
}) {
  const sync = useSync()
  onMount(() => props.onMount(sync))
  const wide = createMemo(() => props.input.wide)
  const inline = createMemo(() => props.input.inline)
  const visible = createMemo(() => props.input.visible)
  const width = createMemo(() => props.input.width ?? 42)
  const railWidth = createMemo(
    () =>
      sidebarLayout({
        wide: props.input.wide,
        sidebarOpen: props.input.visible,
        state: props.input.inline === "collapsed" ? "collapsed" : props.input.inline === "expanded" ? "auto" : "hide",
      }).rail,
  )
  const mouseEnabled = createMemo(() => props.input.mouseEnabled ?? true)
  return (
    <SidebarRegion
      sessionID={sessionID}
      wide={wide}
      sidebarInline={inline}
      sidebarVisible={visible}
      sidebarWidth={width}
      railWidth={railWidth}
      mouseEnabled={mouseEnabled}
    />
  )
}

function DragRegionProbe(props: {
  input: {
    wide: boolean
    inline: "expanded" | "collapsed" | undefined
    width?: number
    terminalWidth?: number
    mouseEnabled?: boolean
    oversizedContent?: boolean
  }
  onMount: (sync: ReturnType<typeof useSync>, kv: ReturnType<typeof useKV>) => void
}) {
  const sync = useSync()
  const kv = useKV()
  onMount(() => props.onMount(sync, kv))
  const [sidebar, setSidebar] = kv.signal<"auto" | "collapsed" | "hide">("sidebar", "auto")
  const [drag, setDrag] = createSignal<SidebarDrag>()
  const layout = createMemo(() => sidebarLayout({ wide: props.input.wide, sidebarOpen: false, state: sidebar() }))
  const width = createMemo(
    () =>
      drag()?.width ??
      clampSidebarWidth(
        resolveSidebarWidth(kv.get("sidebar_width"), props.input.width ?? 42),
        props.input.terminalWidth ?? 80,
      ),
  )
  return (
    <SidebarDragRegion
      sessionID={sessionID}
      wide={() => props.input.wide}
      sidebarInline={() => layout().inline}
      sidebarVisible={() => layout().visible}
      sidebarWidth={width}
      railWidth={() => layout().rail}
      mouseEnabled={() => props.input.mouseEnabled ?? true}
      drag={drag}
      setDrag={setDrag}
      onToggle={() => setSidebar(() => nextSidebarState(sidebar()))}
    >
      <box flexGrow={1} minHeight={0}>
        {(props.input.oversizedContent ?? true) && <box width={300} height={1} />}
      </box>
    </SidebarDragRegion>
  )
}

async function settle(app: Awaited<ReturnType<typeof testRender>>) {
  await app.renderOnce()
  await Bun.sleep(25)
  await app.renderOnce()
}

function findRail(root: Renderable) {
  const rail = findBox(root, (box) => box.id === "sidebar-rail")
  if (!rail) throw new Error("sidebar rail was not rendered")
  return rail
}

function sidebarTitleRow(root: Renderable) {
  const sidebar = findSidebarBox(root)
  const firstRow = sidebar?.getChildren()[0]
  if (!firstRow) throw new Error("sidebar title row was not rendered")
  return firstRow.y
}

function findBox(root: Renderable, match: (box: BoxRenderable) => boolean): BoxRenderable | undefined {
  if (root instanceof BoxRenderable && match(root)) return root
  return root
    .getChildren()
    .map((child) => findBox(child, match))
    .find(Boolean)
}

function mouseHandlers(rail: BoxRenderable) {
  return (rail as unknown as { _mouseListeners: Record<string, unknown> })._mouseListeners
}

function findDragRow(root: Renderable) {
  const row = findBox(root, (box) => box.id === "sidebar-drag-row")
  if (!row) throw new Error("sidebar drag row was not rendered")
  return row
}

function findSidebarBox(root: Renderable) {
  const row = findRail(root).parent
  if (!(row instanceof BoxRenderable)) throw new Error("sidebar region row was not rendered")
  const child = row.getChildren().find((item) => item instanceof BoxRenderable && item.id !== "sidebar-rail")
  return child instanceof BoxRenderable ? child : undefined
}

function fireMouse(target: BoxRenderable, type: "down" | "up" | "drag" | "drag-end", x: number, source?: Renderable) {
  const handlers = mouseHandlers(target) as Record<string, ((evt: MouseEvent) => void) | undefined>
  handlers[type]?.(
    new MouseEvent(source ?? null, { type, button: 0, x, y: 0, modifiers: { shift: false, alt: false, ctrl: false } }),
  )
}
