/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { BoxRenderable, type Renderable } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { createMemo, onMount } from "solid-js"
import { tmpdir } from "../../fixture/fixture"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createEventSource, createFetch, directory, json, mount, wait } from "../../cli/cmd/tui/sync-fixture"
import { ArgsProvider } from "../../../src/context/args"
import { ExitProvider } from "../../../src/context/exit"
import { KVProvider } from "../../../src/context/kv"
import { PermissionProvider } from "../../../src/context/permission"
import { ProjectProvider } from "../../../src/context/project"
import { SDKProvider } from "../../../src/context/sdk"
import { SyncProvider, useSync } from "../../../src/context/sync"
import { ThemeProvider } from "../../../src/context/theme"
import { TuiConfigProvider } from "../../../src/config"
import { createPluginRuntime, PluginRuntimeProvider } from "../../../src/plugin/runtime"
import { SidebarRegion } from "../../../src/routes/session"
import { SidebarRail } from "../../../src/routes/session/sidebar-rail"
import {
  SIDEBAR_WIDTH_STEP,
  nextSidebarState,
  resolveSidebarWidth,
  sidebarLayout,
  sidebarWidthStep,
} from "../../../src/util/sidebar-rail"

const sessionID = "ses_sidebar_rail"
const session = {
  id: sessionID,
  title: "Sidebar rail session",
  time: { created: 0, updated: 0 },
  version: "1.14.42",
  directory,
  project_id: "proj_test",
}

describe("util.sidebar-rail state", () => {
  test("cycles auto to collapsed and back", () => {
    expect(nextSidebarState("auto")).toBe("collapsed")
    expect(nextSidebarState("collapsed")).toBe("auto")
    expect(nextSidebarState("hide")).toBe("auto")
  })

  test("never returns hide", () => {
    for (const state of ["auto", "collapsed", "hide"] as const) {
      expect(nextSidebarState(state)).not.toBe("hide")
    }
  })

  test("prefers a finite positive integer width override", () => {
    expect(resolveSidebarWidth(56, 42)).toBe(56)
  })

  test("falls back to the configured width for invalid overrides", () => {
    for (const override of [undefined, "50", 0, -3, NaN, Infinity, 2.5]) {
      expect(resolveSidebarWidth(override, 42)).toBe(42)
    }
  })

  test("steps the width by SIDEBAR_WIDTH_STEP", () => {
    expect(sidebarWidthStep(42, SIDEBAR_WIDTH_STEP, 200)).toBe(46)
    expect(sidebarWidthStep(22, -SIDEBAR_WIDTH_STEP, 200)).toBe(20)
  })
})

describe("sidebar layout", () => {
  test("child sessions render no sidebar or rail", () => {
    expect(sidebarLayout({ parentID: "s1", wide: true, sidebarOpen: true, state: "auto" })).toStrictEqual({
      inline: undefined,
      visible: false,
      rail: 0,
    })
  })

  test("narrow terminals show the sidebar only as an overlay", () => {
    expect(sidebarLayout({ wide: false, sidebarOpen: true, state: "auto" })).toStrictEqual({
      inline: undefined,
      visible: true,
      rail: 0,
    })
  })

  test("wide terminals expand the sidebar beside a rail", () => {
    expect(sidebarLayout({ wide: true, sidebarOpen: false, state: "auto" })).toStrictEqual({
      inline: "expanded",
      visible: true,
      rail: 1,
    })
  })

  test("wide terminals collapse the sidebar to a rail", () => {
    expect(sidebarLayout({ wide: true, sidebarOpen: false, state: "collapsed" })).toStrictEqual({
      inline: "collapsed",
      visible: false,
      rail: 1,
    })
  })

  test("hidden state renders nothing", () => {
    expect(sidebarLayout({ wide: true, sidebarOpen: false, state: "hide" })).toStrictEqual({
      inline: undefined,
      visible: false,
      rail: 0,
    })
  })
})

describe("kv.delete", () => {
  test("removes the key from the store and the persisted snapshot", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, kv } = await mount(undefined, tmp.path)
    const file = `${tmp.path}/kv.json`

    try {
      kv.set("sidebar_width", 56)
      expect(kv.get("sidebar_width")).toBe(56)
      await wait(() => readFileSync(file, "utf8").includes("sidebar_width"))

      kv.delete("sidebar_width")
      expect(kv.get("sidebar_width", 42)).toBe(42)
      await wait(() => !readFileSync(file, "utf8").includes("sidebar_width"))
      expect(JSON.parse(readFileSync(file, "utf8"))).not.toHaveProperty("sidebar_width")
    } finally {
      app.renderer.destroy()
    }
  })
})

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

  test("renders the collapse glyph without sidebar content", async () => {
    const rendered = await renderRegion({ wide: true, inline: "collapsed", visible: false })
    try {
      expect(findRail(rendered.app.renderer.root)).toBeInstanceOf(BoxRenderable)
      expect(rendered.app.captureCharFrame()).toContain("▸")
      expect(findBox(rendered.app.renderer.root, (box) => box.width === 42)).toBeUndefined()
    } finally {
      rendered.app.renderer.destroy()
      await rendered.dispose()
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

  test("omits rail mouse handlers when mouse support is disabled", async () => {
    const rendered = await renderRail({ collapsed: true, mouseEnabled: false, onExpand: () => {} })
    try {
      const handlers = mouseHandlers(findRail(rendered.app.renderer.root))
      expect(handlers.down).toBeUndefined()
      expect(handlers.up).toBeUndefined()
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

async function renderRegion(input: {
  wide: boolean
  inline: "expanded" | "collapsed" | undefined
  visible: boolean
  width?: number
  mouseEnabled?: boolean
}) {
  const state = await tmpdir()
  await Bun.write(`${state.path}/kv.json`, "{}")
  let sync!: ReturnType<typeof useSync>
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
                            <RegionProbe input={input} onMount={(value) => {
                              sync = value
                              ready()
                            }} />
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
    { width: 80, height: 10 },
  )
  await mounted
  await wait(() => sync.status === "complete")
  await settle(app)
  return { app, dispose: () => state[Symbol.asyncDispose]() }
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
  const mouseEnabled = createMemo(() => props.input.mouseEnabled ?? true)
  return (
    <SidebarRegion
      sessionID={sessionID}
      wide={wide}
      sidebarInline={inline}
      sidebarVisible={visible}
      sidebarWidth={width}
      mouseEnabled={mouseEnabled}
    />
  )
}

async function renderRail(props: { collapsed: boolean; mouseEnabled: boolean; onExpand?: () => void }) {
  const state = await tmpdir()
  await Bun.write(`${state.path}/kv.json`, "{}")
  const app = await testRender(
    () => (
      <TestTuiContexts paths={{ state: state.path }}>
        <TuiConfigProvider config={createTuiResolvedConfig()}>
          <KVProvider>
            <ThemeProvider mode="dark">
              <SidebarRail {...props} />
            </ThemeProvider>
          </KVProvider>
        </TuiConfigProvider>
      </TestTuiContexts>
    ),
    { width: 10, height: 4 },
  )
  await settle(app)
  return { app, dispose: () => state[Symbol.asyncDispose]() }
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

function findBox(root: Renderable, match: (box: BoxRenderable) => boolean): BoxRenderable | undefined {
  if (root instanceof BoxRenderable && match(root)) return root
  return root.getChildren().map((child) => findBox(child, match)).find(Boolean)
}

function mouseHandlers(rail: BoxRenderable) {
  return (rail as unknown as { _mouseListeners: Record<string, unknown> })._mouseListeners
}
