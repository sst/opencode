/** @jsxImportSource @opentui/solid */
import { TextAttributes } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { createSignal } from "solid-js"
import { ConfigProvider } from "../../src/config"
import { EMPTY_SESSION_TAB_STATUS, SessionTabs, type SessionTabsController } from "../../src/component/session-tabs"
import { moveSessionTab, type SessionTab } from "../../src/context/session-tabs-model"
import { Keymap } from "../../src/context/keymap"
import { ThemeProvider } from "../../src/context/theme"
import { SPINNER_FRAMES } from "../../src/component/spinner-frames"
import { SESSION_TABS_COMPACT_WIDTH } from "../../src/ui/layout"
import { emptyThemeSource } from "../fixture/fixture"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"

test("compact rail renders and controls session tabs", async () => {
  const [active, setActive] = createSignal("first")
  const [items, setItems] = createSignal<SessionTab[]>([
    { sessionID: "first", title: "First session" },
    { sessionID: "second", title: "Second session" },
    { sessionID: "third", title: "Third session" },
  ])
  const [status, setStatus] = createSignal(EMPTY_SESSION_TAB_STATUS)
  const [indicators, setIndicators] = createSignal<"status" | "numbers">("status")
  const [searches, setSearches] = createSignal(0)
  const controller = {
    tabs: items,
    current: active,
    add() {},
    search: () => setSearches((value) => value + 1),
    select: setActive,
    close() {},
    move(sessionID: string, index: number) {
      setItems((items) => moveSessionTab(items, sessionID, index))
    },
    detail: () => "project-alpha",
    status: (sessionID: string) => (sessionID === "second" ? status() : EMPTY_SESSION_TAB_STATUS),
  } satisfies SessionTabsController
  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={createTuiResolvedConfig({ tabs: { indicators: "status" } })}>
          <Keymap.Provider>
            <ThemeProvider mode="dark" source={emptyThemeSource}>
              <box width="100%" height="100%" flexDirection="row">
                <SessionTabs
                  controller={controller}
                  orientation="vertical"
                  animations={false}
                  indicators={indicators()}
                  width={SESSION_TABS_COMPACT_WIDTH}
                />
                <text>transcript</text>
              </box>
            </ThemeProvider>
          </Keymap.Provider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 80, height: 24 },
  )

  try {
    app.renderer.start()
    await app.waitForFrame((frame) => frame.includes("  F  ") && frame.includes("  S  "))
    expect(
      app
        .captureCharFrame()
        .split("\n")
        .slice(0, 11)
        .map((line) => line.slice(0, 5)),
    ).toEqual([
      "▄▄▄▄▄",
      "  ⌕  ",
      "▄▄▄▄▄",
      "  F  ",
      "▀▀▀▀▀",
      "  S  ",
      "     ",
      "  T  ",
      "     ",
      "  +  ",
      "     ",
    ])
    expect(app.captureCharFrame().split("\n")[0].indexOf("transcript")).toBe(5)
    expect(app.captureCharFrame()).not.toContain("First session")
    expect(
      app.captureSpans().lines[3].spans.find((span) => span.text.trim() === "F")!.attributes & TextAttributes.BOLD,
    ).toBe(TextAttributes.BOLD)

    setStatus({ ...EMPTY_SESSION_TAB_STATUS, busy: true })
    await app.waitForFrame((frame) => frame.split("\n")[5].slice(0, 5).trim() === SPINNER_FRAMES[0])
    setStatus({ ...EMPTY_SESSION_TAB_STATUS, busy: true, attention: "question" })
    await app.waitForFrame((frame) => frame.split("\n")[5].slice(0, 5).trim() === "?")

    setIndicators("numbers")
    await app.waitForFrame((frame) => frame.split("\n")[5].slice(0, 5).trim() === "2")
    expect([3, 5, 7].map((row) => app.captureCharFrame().split("\n")[row].slice(0, 5).trim())).toEqual([
      "1",
      "2",
      "3",
    ])
    setIndicators("status")
    setStatus(EMPTY_SESSION_TAB_STATUS)

    await app.mockMouse.moveTo(2, 5)
    await app.waitForFrame((frame) => frame.includes("Second session") && frame.includes("project-alpha"))
    expect(active()).toBe("first")
    await app.mockMouse.moveTo(10, 0)
    await app.waitForFrame((frame) => !frame.includes("Second session"))

    await app.mockMouse.click(2, 1)
    expect(searches()).toBe(1)
    await app.mockMouse.drag(2, 3, 2, 7)
    expect(items().map((tab) => tab.sessionID)).toEqual(["second", "third", "first"])

    setItems(Array.from({ length: 40 }, (_, index) => ({ sessionID: `tab-${index + 1}`, title: `Session ${index + 1}` })))
    setActive("tab-40")
    setIndicators("numbers")
    await app.waitForFrame((frame) => frame.split("\n").some((line) => line.slice(0, 5).trim() === "40"))
  } finally {
    app.renderer.destroy()
  }
})
