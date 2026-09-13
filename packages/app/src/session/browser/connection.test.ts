import { expect, test } from "bun:test"
import { Browser } from "@opencode/plugin-browser/rpc"
import type { BrowserPaneEvent, BrowserPaneTarget } from "@/runtime/platform/browser-pane"
import { createBrowserConnection, type BrowserConnectionState } from "./connection"

const tabID = Browser.TabID.make(`tab_${crypto.randomUUID()}`)
const browser: Browser.State = {
  tabs: [
    {
      id: tabID,
      url: "http://localhost:4173/",
      title: "Preview",
      loading: false,
      canGoBack: true,
      canGoForward: false,
      generation: 3,
    },
  ],
  focusedTabID: tabID,
}

function fixture() {
  const states: BrowserConnectionState[] = []
  const calls: {
    target: BrowserPaneTarget
    emit: (event: BrowserPaneEvent) => void
    closed: boolean
    commands: Browser.Action[]
  }[] = []
  const endpoint = { url: "http://localhost:4096" }
  const connection = createBrowserConnection({
    target: () => ({ serverKey: "browser-test", sessionID: "ses_browser", endpoint: { ...endpoint } }),
    change: (state) => states.push(state),
    focus: () => {},
    pane: {
      register(target, emit) {
        const call = { target, emit, closed: false, commands: [] as Browser.Action[] }
        calls.push(call)
        return {
          setLayout() {},
          async command(command) {
            call.commands.push(command)
          },
          close() {
            call.closed = true
          },
        }
      },
    },
  })
  connection.wake()
  calls[0].emit({ type: "state", state: browser })
  return { connection, calls, states, endpoint }
}

test("suspension retains tabs and reconnects once on demand using the current endpoint", async () => {
  const app = fixture()
  try {
    app.calls[0].emit({ type: "state", state: browser, error: "browser.pane.suspended" })
    expect(app.calls[0].closed).toBe(true)
    expect(app.states.at(-1)).toMatchObject({ registration: undefined, browser, suspended: true })
    // A suspended attachment must not schedule the one-second transport retry.
    await Bun.sleep(1_100)
    expect(app.calls).toHaveLength(1)
    app.endpoint.url = "http://localhost:4999"
    app.connection.wake()
    app.connection.wake()
    expect(app.calls).toHaveLength(2)
    expect(app.calls[1].target).toEqual({
      serverKey: "browser-test",
      sessionID: "ses_browser",
      endpoint: app.endpoint,
      restore: browser,
    })
    expect(app.states.at(-1)?.suspended).toBe(false)
    app.calls[0].emit({ type: "state", state: null, error: "browser.pane.registration.closed" })
    expect(app.states.at(-1)?.registration).toBeDefined()
  } finally {
    app.connection.dispose()
  }
})

test("a command wakes its attachment once and is not replayed", async () => {
  const app = fixture()
  try {
    app.calls[0].emit({ type: "state", state: browser, error: "browser.pane.suspended" })
    await app.connection.command({ type: "reload", tabID })
    expect(app.calls).toHaveLength(2)
    expect(app.calls[1].commands).toEqual([{ type: "reload", tabID }])
    app.connection.dispose()
    app.connection.wake()
    expect(app.calls[1].closed).toBe(true)
    expect(app.calls).toHaveLength(2)
  } finally {
    app.connection.dispose()
  }
})

for (const error of ["browser.pane.replaced", "browser.pane.unsupported"]) {
  test(`${error} blocks automatic ownership recovery`, () => {
    const app = fixture()
    try {
      app.calls[0].emit({ type: "state", state: null, error })
      app.connection.wake()
      expect(app.calls).toHaveLength(1)
      expect(app.states.at(-1)?.error).toBe(error)
    } finally {
      app.connection.dispose()
    }
  })
}
