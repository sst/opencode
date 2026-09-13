/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { MouseButton } from "@opentui/core"
import { expect, test } from "bun:test"
import { batch, createSignal } from "solid-js"
import { ConfigProvider, useConfig, type Info } from "../../src/config"
import {
  EMPTY_SESSION_TAB_STATUS,
  SessionTabs,
  type SessionTabsController,
  type SessionTabsStatus,
} from "../../src/component/session-tabs"
import { SPINNER_FRAMES } from "../../src/component/spinner-frames"
import { ClientProvider } from "../../src/context/client"
import { DataProvider } from "../../src/context/data"
import { LocationProvider } from "../../src/context/location"
import { Keymap } from "../../src/context/keymap"
import { RouteProvider } from "../../src/context/route"
import { TuiAppProvider } from "../../src/context/runtime"
import { SessionTabsProvider } from "../../src/context/session-tabs"
import { StorageProvider } from "../../src/context/storage"
import { ThemeProvider, useTheme } from "../../src/context/theme"
import { DialogProvider } from "../../src/ui/dialog"
import { ToastProvider } from "../../src/ui/toast"
import { emptyThemeSource, tmpdir } from "../fixture/fixture"
import { createApi, createEventStream, createFetch } from "../fixture/tui-client"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"

for (const orientation of ["horizontal", "vertical"] as const) {
  test(`${orientation} tabs replace ordinals with status without moving titles and keep context menu actions`, async () => {
    await using temporary = await tmpdir()
    const [status, setStatus] = createSignal<SessionTabsStatus>(EMPTY_SESSION_TAB_STATUS)
    const [active, setActive] = createSignal("second")
    const [newTab, setNewTab] = createSignal(false)
    const settings: Info = { tabs: { enabled: true } }
    let config!: ReturnType<typeof useConfig>
    let theme!: ReturnType<typeof useTheme>
    function Colors() {
      config = useConfig()
      theme = orientation === "vertical" ? useTheme("elevated") : useTheme()
      return null
    }
    const controller = {
      tabs: () => [
        { sessionID: "first", title: "First" },
        { sessionID: "second", title: "Second" },
      ],
      current: active,
      newTab,
      select(sessionID: string) {
        batch(() => {
          setActive(sessionID)
          if (sessionID === "first") setStatus((current) => ({ ...current, unread: undefined }))
        })
      },
      close() {},
      move() {},
      detail: () => "project",
      status: (sessionID: string) => (sessionID === "first" ? status() : EMPTY_SESSION_TAB_STATUS),
    } satisfies SessionTabsController
    const app = await testRender(
      () => (
        <TestTuiContexts paths={{ state: temporary.path }}>
          <TuiAppProvider value={{ name: "test", version: "test", channel: "test" }}>
            <StorageProvider>
              <ConfigProvider
                config={createTuiResolvedConfig(settings)}
                service={{
                  get: async () => settings,
                  update: async (update) => {
                    update(settings)
                    return settings
                  },
                }}
              >
                <RouteProvider initialRoute={{ type: "home" }}>
                  <ClientProvider api={createApi(createFetch(undefined, createEventStream()).fetch)}>
                    <DataProvider directory={temporary.path}>
                      <LocationProvider>
                        <SessionTabsProvider>
                          <ThemeProvider mode="dark" source={emptyThemeSource}>
                            <Colors />
                            <Keymap.Provider>
                              <ToastProvider>
                                <DialogProvider>
                                  <box width="100%" height="100%">
                                    <SessionTabs controller={controller} orientation={orientation} animations={false} />
                                  </box>
                                </DialogProvider>
                              </ToastProvider>
                            </Keymap.Provider>
                          </ThemeProvider>
                        </SessionTabsProvider>
                      </LocationProvider>
                    </DataProvider>
                  </ClientProvider>
                </RouteProvider>
              </ConfigProvider>
            </StorageProvider>
          </TuiAppProvider>
        </TestTuiContexts>
      ),
      { width: 60, height: 10 },
    )

    try {
      app.renderer.start()
      await app.waitForFrame((frame) => frame.includes("   First") && frame.includes("   Second"))

      const titleColumn = app
        .captureCharFrame()
        .split("\n")
        .find((line) => line.includes("First"))!
        .indexOf("First")
      const states: { status: Partial<SessionTabsStatus>; label: string }[] = [
        { status: { busy: true }, label: SPINNER_FRAMES[0] },
        { status: { busy: true, attention: "question" }, label: "?" },
        { status: { busy: true, attention: "permission" }, label: "!" },
        { status: { unread: "activity" }, label: "\u2022" },
        { status: { unread: "error" }, label: "\u2022" },
        { status: {}, label: "" },
      ]
      for (const state of states) {
        setStatus({ ...EMPTY_SESSION_TAB_STATUS, ...state.status })
        await app.renderOnce()
        await app.waitForFrame((frame) => frame.includes(`${state.label.padStart(2)} First`))
        const rows = app.captureCharFrame().split("\n")
        expect(rows.find((line) => line.includes("First"))!.indexOf("First")).toBe(titleColumn)
        expect(rows[orientation === "vertical" ? 2 : 1]?.trim()).toBe(orientation === "vertical" ? "project" : "")
      }

      for (const attention of ["question", "permission"] as const) {
        setActive("second")
        setStatus({ ...EMPTY_SESSION_TAB_STATUS, busy: true, attention })
        await app.renderOnce()
        const indicatorColor = () =>
          app
            .captureSpans()
            .lines.flatMap((line) => line.spans)
            .find((span) => span.text.trim() === (attention === "question" ? "?" : "!"))?.fg
        expect(indicatorColor()?.toInts()).toEqual(theme.text.status[attention].toInts())
        const glow = () => {
          const colors = app
            .captureSpans()
            .lines[
              orientation === "vertical" ? 1 : 0
            ]!.spans.flatMap((span) => Array.from({ length: span.width }, () => span.bg))
          return (
            Math.abs(colors[1]!.r - colors[18]!.r) +
            Math.abs(colors[1]!.g - colors[18]!.g) +
            Math.abs(colors[1]!.b - colors[18]!.b)
          )
        }
        const full = glow()
        expect(full).toBeGreaterThan(0)
        setActive("first")
        await app.renderOnce()
        expect(indicatorColor()?.toInts()).toEqual(theme.text.status[attention].toInts())
        const dim = glow()
        expect(dim).toBeGreaterThan(0)
        expect(dim).toBeLessThan(full)
      }

      const glyph = "\u2022"
      for (const unread of ["activity", "error"] as const) {
        setActive("second")
        setStatus({ ...EMPTY_SESSION_TAB_STATUS, unread })
        await app.renderOnce()
        const color = app
          .captureSpans()
          .lines.flatMap((line) => line.spans)
          .find((span) => span.text.trim() === glyph)?.fg
        expect(color?.toInts()).toEqual(
          (unread === "error" ? theme.text.feedback.error.default : theme.text.status.unread).toInts(),
        )
        await app.mockMouse.click(1, orientation === "vertical" ? 1 : 0)
        await app.renderOnce()
        expect(active()).toBe("first")
        expect(status().unread).toBeUndefined()
        expect(app.captureCharFrame()).toContain("   First")
        expect(app.captureCharFrame()).not.toContain(`${glyph} First`)
      }

      setStatus({ ...EMPTY_SESSION_TAB_STATUS, busy: true })

      await config.update((draft) => {
        draft.tabs.indicators = "numbers"
      })
      await app.waitForFrame((frame) => frame.includes("1 First") && frame.includes("2 Second"))
      await config.update((draft) => {
        draft.tabs.indicators = "status"
      })
      await app.waitForFrame((frame) => frame.includes(`${SPINNER_FRAMES[0]} First`))

      setStatus(EMPTY_SESSION_TAB_STATUS)
      setActive("second")
      await app.renderOnce()
      const rows = app.captureCharFrame().split("\n")
      const row = rows.findIndex((line) => line.includes("First"))
      const column = rows[row]!.indexOf("First")
      await app.mockMouse.click(column, row, MouseButton.RIGHT)
      await app.waitForFrame((frame) => frame.includes("Rename"))
      expect(app.captureCharFrame().split("\n")[row + 1]!.indexOf("Rename")).toBe(column + 1)
      expect(app.captureCharFrame()).toContain("Close")
      expect(app.captureCharFrame()).not.toContain("Keep open")
      expect(active()).toBe("second")
      app.mockInput.pressKey("c", { ctrl: true })
      await app.waitForFrame((frame) => !frame.includes("Rename"))

      setNewTab(true)
      await app.waitForFrame((frame) => frame.includes("+ New session"))
    } finally {
      app.renderer.destroy()
    }
  })
}
