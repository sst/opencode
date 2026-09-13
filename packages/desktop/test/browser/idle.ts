import assert from "node:assert/strict"
import { createServer } from "node:http"
import { once } from "node:events"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { app, BrowserWindow, webContents } from "electron"
import { Effect, Fiber, Stream } from "effect"
import { OpenCode } from "@opencode/client"
import { createBrowserPane } from "../../src/main/browser-pane"
import { waitFor } from "../../src/main/browser/cdp"
import { bindIpcEvents, ipcEventStream } from "../../src/main/ipc-events"
import { createBrowserConnection, type BrowserConnectionState } from "../../../app/src/session/browser/connection"
import type { BrowserPaneEvent } from "../../../app/src/runtime/platform/browser-pane"
import { Smoke } from "./contract"
import { openDatabase } from "../../src/main/storage/database"
import { createStateStore } from "../../src/main/storage/state"

async function main() {
  app.setPath("userData", path.join(process.env.SMOKE_ROOT!, "electron-data"))
  app.on("window-all-closed", () => {})
  await app.whenReady()
  const loads = new Map<string, number>()
  const web = createServer((request, response) => {
    const url = request.url ?? "/"
    loads.set(url, (loads.get(url) ?? 0) + 1)
    response.setHeader("content-type", "text/html")
    response.setHeader("cache-control", "no-store")
    response.end(
      `<!doctype html><title>Idle recovery ${url}</title><body style="font:24px system-ui;padding:48px;background:#fff;color:#222"><h1>Browser connection restored</h1><p>Page ${url}</p><input aria-label="Draft" value="Initial value"></body>`,
    )
  })
  await once(web.listen(0, "127.0.0.1"), "listening")
  const address = web.address()
  assert(address && typeof address !== "string")
  const url = `http://127.0.0.1:${address.port}`
  const endpoint = { url: process.env.SMOKE_URL!, password: process.env.SMOKE_PASSWORD }
  const headers = { authorization: `Basic ${Buffer.from(`opencode:${endpoint.password}`).toString("base64")}` }
  const client = OpenCode.make({ baseUrl: endpoint.url, headers })
  const location = { directory: process.env.SMOKE_SERVER_FILES! }
  const session = await client.session.create({ title: "Idle browser", location })
  const database = openDatabase(":memory:")
  const storage = createStateStore(database.db)
  const pane = createBrowserPane(storage)
  const win = new BrowserWindow({ show: false, width: 1100, height: 800, webPreferences: { sandbox: true } })
  await win.loadURL("about:blank")
  win.showInactive()
  const listeners = new Map<string, (event: BrowserPaneEvent) => void>()
  const unbind = await Effect.runPromise(bindIpcEvents(win.webContents.id))
  const events = Effect.runFork(
    ipcEventStream(win.webContents.id).pipe(
      Stream.runForEach((event) =>
        Effect.sync(() => {
          if (event._tag === "BrowserPaneEvent") listeners.get(event.bindingID)?.(event.event)
        }),
      ),
    ),
  )
  const states: BrowserConnectionState[] = []
  const connection = createBrowserConnection({
    target: () => ({ serverKey: "browser-idle", sessionID: session.id, endpoint }),
    change: (state) => states.push(state),
    focus: () => {},
    pane: {
      register(target, listener) {
        const bindingID = crypto.randomUUID()
        listeners.set(bindingID, listener)
        const ready = pane.register(win, bindingID, target)
        void ready.catch(() => {})
        return {
          setLayout: (layout) => {
            void ready.then(() => pane.layout(win, bindingID, layout))
          },
          command: (command) => ready.then(() => pane.command(win, bindingID, command)),
          close: () => {
            listeners.delete(bindingID)
            void ready.then(() => pane.close(win, bindingID)).catch(() => {})
          },
        }
      },
    },
  })
  const signal = new AbortController().signal
  try {
    await connection.command({ type: "tabs.open", url: `${url}/first` })
    await connection.command({ type: "tabs.open", url: `${url}/second`, focus: false })
    await waitFor(() => states.at(-1)?.browser?.tabs.length === 2, signal)
    const saved = states.at(-1)?.browser
    assert(saved)
    assert.equal(loads.get("/first"), 1)
    assert.equal(loads.get("/second"), 1)
    const evicted = await fetch(new URL("/__test/evict", endpoint.url), { method: "POST", headers })
    assert.equal(evicted.status, 204)
    await waitFor(() => states.at(-1)?.suspended === true && win.contentView.children.length === 0, signal)
    assert.deepEqual(
      states.at(-1)?.browser?.tabs.map((tab) => tab.id),
      saved.tabs.map((tab) => tab.id),
    )
    assert.equal(listeners.size, 0)

    connection.wake()
    await connection.command({ type: "tabs.list" })
    assert.equal(win.contentView.children.length, 0, "reconnecting must not load background pages")
    const tabID = saved.tabs[0].id
    states.at(-1)?.registration?.setLayout({ tabID, visible: true, bounds: { x: 0, y: 0, width: 1000, height: 700 } })
    await waitFor(async () => {
      const page = webContents.getAllWebContents().find((page) => page.getURL() === `${url}/first`)
      return (
        !!page &&
        !page.isLoading() &&
        (await page.executeJavaScript("document.body.textContent")).includes("Browser connection restored")
      )
    }, signal)
    assert.equal(loads.get("/first"), 2)
    assert.equal(loads.get("/second"), 1, "an inactive tab must stay unloaded")
    await waitFor(() => states.at(-1)?.browser?.tabs.find((tab) => tab.id === tabID)?.loading === false, signal)
    const result = await client
      .rpc(Smoke)
      .execute(
        { sessionID: session.id, code: `return await tools.browser.snapshot({tabID: ${JSON.stringify(tabID)}})` },
        { location },
      )
    assert(!result.error, result.output)
    assert(result.output.includes("Browser connection restored"))
    const background = await client.rpc(Smoke).execute(
      {
        sessionID: session.id,
        code: `return await tools.browser.snapshot({tabID: ${JSON.stringify(saved.tabs[1].id)}})`,
      },
      { location },
    )
    assert(!background.error, background.output)
    assert.equal(loads.get("/second"), 2, "an agent can load an inactive restored tab without user focus")
    if (process.env.SMOKE_EVIDENCE) {
      await mkdir(process.env.SMOKE_EVIDENCE, { recursive: true })
      const page = webContents.getAllWebContents().find((page) => page.getURL() === `${url}/first`)
      assert(page)
      await writeFile(path.join(process.env.SMOKE_EVIDENCE, "after.png"), (await page.capturePage()).toPNG())
    }
    assert((states.at(-1)?.browser?.tabs[0].generation ?? 0) > saved.tabs[0].generation)
    console.log("PASS idle eviction releases native views, preserves tab IDs, and restores only the requested page")
  } finally {
    connection.dispose()
    await pane.dispose()
    storage.close()
    database.close()
    await Effect.runPromise(Fiber.interrupt(events))
    await Effect.runPromise(unbind)
    win.destroy()
    web.closeAllConnections()
    await new Promise<void>((resolve) => web.close(() => resolve()))
    app.quit()
  }
}

main().catch((error) => {
  console.error(error)
  app.exit(1)
})
