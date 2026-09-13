import type { BrowserPaneCommand, BrowserPaneLayout, BrowserPaneTarget } from "@opencode/app/desktop"
import { NodeHttpClient } from "@effect/platform-node"
import { Browser } from "@opencode/plugin-browser/rpc"
import { OpenCode } from "@opencode/client/effect"
import { SessionID } from "@opencode/schema/session-id"
import type { BrowserWindow } from "electron"
import { Deferred, Effect, ManagedRuntime, Queue, Schedule, Schema, Stream } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { BrowserPaneEvent } from "../shared/ipc-rpc/events"
import { createBrowserPage, type BrowserPage } from "./browser-chromium"
import { browserFailure } from "./browser/errors"
import { createBrowserNetwork, type BrowserNetwork } from "./browser/network"
import { destinationOrigin } from "./browser/policy"
import { emitIpcEvent } from "./ipc-events"
import { SidecarCredentials } from "./service/sidecar-credentials"
import { createBrowserRestoreStore } from "./browser/restore"
import type { StateStore } from "./storage/state"

type Entry = {
  bindingID: string
  win: BrowserWindow
  abort: AbortController
  registered: PromiseWithResolvers<void>
  requests: Map<string, { abort: AbortController; tabID?: Browser.TabID }>
  report?: (event: BrowserPaneEvent["event"]) => void
  cleanup?: () => void
  pages: Map<Browser.TabID, BrowserPage>
  tabs: Map<Browser.TabID, Browser.Tab>
  focusedTabID: Browser.TabID | null
  partition: string
  lastState?: string
  network?: BrowserNetwork
  storageKey: string
}

export function createBrowserPane(storage: StateStore) {
  const entries = new Map<string, Entry>()
  const restore = createBrowserRestoreStore(storage)
  // Keep long-lived RPC requests off Chromium's shared HTTP connection pool.
  const runtime = ManagedRuntime.make(NodeHttpClient.layerNodeHttp)
  let disposed = false
  return {
    async register(win: BrowserWindow, bindingID: string, target: BrowserPaneTarget) {
      if (disposed || !destinationOrigin(target.endpoint.url)) throw new Error("browser.pane.registration.invalid")
      if (target.endpoint.username && !target.endpoint.password) throw new Error("browser.pane.endpoint.invalid")
      if (entries.has(bindingID)) throw new Error("browser.pane.owner.invalid")
      if (win.isDestroyed() || win.webContents.isDestroyed()) throw new Error("browser.pane.owner.unavailable")
      const sessionID = SessionID.make(target.sessionID)
      const storageKey = `${target.serverKey}\n${sessionID}`
      const saved = restore.load(storageKey)
      const previous = target.restore ?? {
        tabs: saved.tabs.map((tab) => ({
          ...tab,
          title: "",
          generation: 0,
        })),
        focusedTabID: saved.focusedTabID,
      }
      const entry: Entry = {
        bindingID,
        win,
        abort: new AbortController(),
        registered: Promise.withResolvers(),
        requests: new Map(),
        pages: new Map(),
        tabs: new Map(
          previous.tabs.map((tab) => [
            tab.id,
            {
              ...tab,
              loading: false,
              canGoBack: false,
              canGoForward: false,
              generation: tab.generation + 1,
            },
          ]),
        ),
        focusedTabID: previous.focusedTabID,
        partition: `opencode-browser-${crypto.randomUUID()}`,
        storageKey,
      }
      // "unsupported" means the server has no browser plugin; the renderer stops retrying.
      let reason: "browser.pane.unsupported" | "browser.pane.replaced" | "browser.pane.suspended" | undefined
      let attached = false
      const stop = () => close(entry, reason)
      const navigate = (event: Electron.Event<{ isMainFrame: boolean; isSameDocument: boolean }>) => {
        if (event.isMainFrame && !event.isSameDocument) stop()
      }
      win.webContents.once("destroyed", stop)
      win.webContents.on("did-start-navigation", navigate)
      entry.cleanup = () => {
        if (win.isDestroyed()) return
        win.webContents.off("destroyed", stop)
        win.webContents.off("did-start-navigation", navigate)
      }
      entries.set(bindingID, entry)
      void runtime
        .runPromise(
          Effect.gen(function* () {
            const http = yield* HttpClient.HttpClient
            // The renderer never holds the managed sidecar's password; Node requests bypass
            // the webRequest header injection, so resolve the credential here in main.
            const authorization = target.endpoint.password
              ? `Basic ${Buffer.from(`${target.endpoint.username ?? "opencode"}:${target.endpoint.password}`).toString("base64")}`
              : SidecarCredentials.authorization(SidecarCredentials.get(), target.endpoint.url)
            const client = yield* OpenCode.make({ baseUrl: target.endpoint.url }).pipe(
              Effect.provideService(
                HttpClient.HttpClient,
                authorization
                  ? HttpClient.mapRequest(http, HttpClientRequest.setHeader("authorization", authorization))
                  : http,
              ),
            )
            const session = yield* client.session.get({ sessionID })
            const options = {
              location: { directory: session.location.directory, workspace: session.location.workspaceID },
            }
            const attachment = { sessionID, connectionID: crypto.randomUUID() }
            const rpc = client.rpc(Browser.Definition)
            entry.network = yield* createBrowserNetwork({
              rpc,
              attachment,
              location: options.location,
              partition: entry.partition,
            })
            const connected = yield* Deferred.make<void>()
            const outbound = yield* Queue.unbounded<Effect.Effect<void>>()
            // A send that fails because the server already replaced or closed this attachment must
            // not decide the close reason; only the attach call's outcome does.
            const send = (effect: Effect.Effect<unknown, unknown>) =>
              Queue.offerUnsafe(
                outbound,
                effect.pipe(Effect.catchCause((cause) => Effect.logWarning("Browser send failed", cause))),
              )
            const reply = (requestID: string, outcome: Browser.Outcome) =>
              send(
                rpc.result({ ...attachment, requestID, outcome: Schema.encodeSync(Browser.Outcome)(outcome) }, options),
              )
            // Report state before publishing it locally or completing a command. The server's copy of
            // the inventory resolves every tab ID, so a state is retried until it arrives or the
            // attachment ends; the results queued behind it then never name a tab the server lacks.
            // "unavailable" means the server already dropped this attachment, which attach reports.
            entry.report = (event) => {
              const local = Effect.sync(() => publish(entry, event))
              if (event.type !== "state") return send(local)
              send(
                rpc.state({ ...attachment, state: event.state ?? { tabs: [], focusedTabID: null } }, options).pipe(
                  Effect.retry({
                    while: (error) => !("type" in error && error.type === "unavailable"),
                    schedule: Schedule.min([Schedule.exponential("250 millis"), Schedule.spaced("10 seconds")]),
                  }),
                  Effect.ensuring(local),
                ),
              )
            }
            const receive = client.event.subscribe().pipe(
              Stream.runForEach((event) =>
                Effect.gen(function* () {
                  if (event.type === "server.connected") {
                    yield* Deferred.succeed(connected, undefined)
                    return
                  }
                  if (
                    event.type !== "rpc.experimental.browser.control" ||
                    event.data.connectionID !== attachment.connectionID
                  )
                    return
                  const message = yield* Schema.decodeUnknownEffect(Browser.Control)(event.data).pipe(
                    Effect.tapError(() =>
                      Effect.sync(() => {
                        reason = "browser.pane.unsupported"
                      }),
                    ),
                  )
                  if (message.type === "attached") {
                    attached = true
                    return entry.registered.resolve()
                  }
                  if (message.type === "cancel") return entry.requests.get(message.requestID)?.abort.abort()
                  const abort = new AbortController()
                  entry.requests.set(message.requestID, { abort })
                  yield* rpc.command({ ...attachment, requestID: message.requestID }, options).pipe(
                    Effect.flatMap((command) =>
                      Effect.promise(async () => {
                        entry.requests.set(message.requestID, {
                          abort,
                          ...("tabID" in command.action ? { tabID: command.action.tabID } : {}),
                        })
                        reply(
                          message.requestID,
                          await execute(entry, command, abort.signal).then(
                            (result) => ({ type: "success" as const, result }),
                            (error: unknown) => browserFailure(command.action, error),
                          ),
                        )
                      }),
                    ),
                    Effect.ensuring(Effect.sync(() => entry.requests.delete(message.requestID))),
                    // An operation this desktop cannot decode comes from a newer plugin; answer it so
                    // the agent does not wait out the server's timeout.
                    Effect.tapError((error) =>
                      Effect.sync(() => {
                        if (!Schema.isSchemaError(error)) return
                        reply(message.requestID, {
                          type: "failure",
                          code: "unsupported",
                          message:
                            "This desktop app does not support the requested browser operation. Ask the user to update the desktop app, or use another operation.",
                        })
                      }),
                    ),
                    // A request that vanished (cancelled before retrieval) fails only that request.
                    // Transport loss surfaces through the event stream and attach call instead.
                    Effect.catchCause((cause) =>
                      abort.signal.aborted ? Effect.void : Effect.logWarning("Browser command failed", cause),
                    ),
                    Effect.forkScoped,
                  )
                }),
              ),
            )
            yield* Effect.raceAllFirst([
              receive,
              Stream.fromQueue(outbound).pipe(Stream.runForEach((send) => send)),
              Deferred.await(connected).pipe(
                Effect.andThen(rpc.attach({ ...attachment, version: 4 }, options)),
                Effect.tap((result) =>
                  Effect.sync(() => {
                    if (result === "replaced") reason = "browser.pane.replaced"
                  }),
                ),
              ),
            ])
          }).pipe(
            Effect.scoped,
            Effect.tapError((error) =>
              Effect.sync(() => {
                const type = error instanceof Object && "type" in error ? error.type : undefined
                if (type === "rpc.unavailable" && attached) {
                  reason = "browser.pane.suspended"
                  return
                }
                if (type === "rpc.unavailable" || type === "rpc.method_not_found" || type === "rpc.invalid_input")
                  reason = "browser.pane.unsupported"
              }),
            ),
            Effect.ensuring(Effect.sync(stop)),
          ),
          { signal: entry.abort.signal },
        )
        .catch(stop)
      const timeout = setTimeout(stop, 15_000)
      await entry.registered.promise.finally(() => clearTimeout(timeout))
      if (entries.get(bindingID) !== entry) throw new Error("browser.pane.registration.closed")
      publishState(entry)
    },
    layout(win: BrowserWindow, bindingID: string, value?: BrowserPaneLayout) {
      const entry = owned(win, bindingID)
      if (!value) return entry.pages.forEach((page) => page.setVisible(false))
      const bounds = value.bounds
      if (!value.visible || !bounds || bounds.width <= 0 || bounds.height <= 0) {
        entry.pages.get(value.tabID)?.setVisible(false)
        return
      }
      const page = load(entry, value.tabID)
      if (!page) return
      entry.pages.forEach((other) => {
        if (other !== page) other.setVisible(false)
      })
      page.layout(bounds, value.background, value.radius)
      page.setVisible(true)
    },
    async command(win: BrowserWindow, bindingID: string, command: BrowserPaneCommand) {
      const entry = owned(win, bindingID)
      await execute(entry, { action: command, files: [] }, new AbortController().signal)
    },
    async close(win: BrowserWindow, bindingID: string) {
      const entry = owned(win, bindingID)
      restore.remove(entry.storageKey)
      close(entry)
    },
    async dispose() {
      disposed = true
      entries.forEach((entry) => close(entry))
      await runtime.dispose()
    },
  }

  function owned(win: BrowserWindow, bindingID: string) {
    const entry = entries.get(bindingID)
    if (!entry || entry.win !== win) throw new Error("browser.pane.unavailable")
    return entry
  }

  function publish(entry: Entry, event: BrowserPaneEvent["event"]) {
    if (!entries.has(entry.bindingID) || entry.win.isDestroyed() || entry.win.webContents.isDestroyed()) return
    emitIpcEvent(entry.win.webContents, new BrowserPaneEvent({ bindingID: entry.bindingID, event }))
  }

  function close(entry: Entry, reason = "browser.pane.registration.closed") {
    if (entries.get(entry.bindingID) !== entry) return
    entry.report = undefined
    entry.requests.forEach((request) => request.abort.abort())
    entry.requests.clear()
    const suspended = reason === "browser.pane.suspended"
    if (suspended) publishState(entry, reason)
    entry.pages.forEach((page) => {
      void page.dispose().catch(() => undefined)
    })
    entry.pages.clear()
    entry.tabs.clear()
    entry.focusedTabID = null
    if (!suspended) publishState(entry, reason)
    entries.delete(entry.bindingID)
    entry.registered.reject(new Error("browser.pane.registration.closed"))
    entry.cleanup?.()
    entry.abort.abort()
  }

  async function closePage(entry: Entry, tabID: Browser.TabID, error?: string) {
    const page = entry.pages.get(tabID)
    if (!entry.tabs.has(tabID))
      throw new Error(
        "This tab is no longer available. Call browser.tabs.list({}) and use an existing tabID from this session.",
      )
    const focused = entry.focusedTabID === tabID
    entry.requests.forEach((request) => {
      if (request.tabID === tabID) request.abort.abort()
    })
    entry.pages.delete(tabID)
    entry.tabs.delete(tabID)
    if (focused) entry.focusedTabID = entry.tabs.keys().next().value ?? null
    await page?.dispose()
    publishState(entry, error)
  }

  function publishState(entry: Entry, error?: string) {
    const event = {
      type: "state" as const,
      state: inventory(entry),
      ...(error === undefined ? {} : { error }),
    }
    // Teardown publishes an empty inventory to the renderer, but the saved URLs survive app exit.
    if (entry.report)
      restore.save(entry.storageKey, {
        tabs: event.state.tabs.map((tab) => ({
          id: tab.id,
          // A restored page can publish before Chromium assigns its URL.
          url: tab.url || entry.tabs.get(tab.id)?.url || "about:blank",
        })),
        focusedTabID: entry.focusedTabID,
      })
    const next = JSON.stringify(event)
    if (entry.lastState === next) return
    entry.lastState = next
    report(entry, event)
  }

  function report(entry: Entry, event: BrowserPaneEvent["event"]) {
    if (entry.report) return entry.report(event)
    publish(entry, event)
  }

  function inventory(entry: Entry): Browser.State {
    return {
      tabs: Array.from(entry.tabs, ([id, tab]) => entry.pages.get(id)?.state() ?? tab),
      focusedTabID: entry.focusedTabID,
    }
  }

  function load(entry: Entry, tabID: Browser.TabID) {
    const page = entry.pages.get(tabID)
    if (page) return page
    const tab = entry.tabs.get(tabID)
    return tab ? create(entry, true, undefined, tab) : undefined
  }

  function create(
    entry: Entry,
    initialize = true,
    popupOptions?: Electron.BrowserWindowConstructorOptions,
    restore?: Browser.Tab,
  ) {
    if (!entry.network) throw new Error("Browser network is not ready; no tab was opened.")
    const id = restore?.id ?? Browser.TabID.make(`tab_${crypto.randomUUID()}`)
    const fail = () => {
      if (entry.pages.has(id)) void closePage(entry, id, "page_crashed").catch(() => undefined)
    }
    const page = createBrowserPage(entry.win, {
      id,
      partition: entry.partition,
      network: entry.network,
      initialize,
      restore,
      popupOptions,
      fail,
      publish: (error) => {
        if (entry.pages.has(id)) publishState(entry, error)
      },
      popup: (popupOptions) => {
        const popup = create(entry, false, popupOptions)
        focus(entry, popup.state().id)
        return popup.contents
      },
    })
    entry.pages.set(id, page)
    entry.tabs.set(id, restore ?? page.state())
    void page.ready
      .then(() => {
        if (entry.pages.get(id) === page) publishState(entry)
      })
      .catch(fail)
    return page
  }

  async function execute(entry: Entry, command: Browser.Command, signal: AbortSignal) {
    const action = command.action
    if (signal.aborted)
      throw new Error(
        "Browser request was cancelled. Do not repeat a mutating action until you have inspected its outcome.",
      )
    if (action.type === "tabs.list") return { value: inventory(entry), files: [] }
    if (action.type === "tabs.open") {
      const page = create(entry)
      if (action.focus !== false) focus(entry, page.state().id)
      await page.ready
      await page.execute(
        { action: { type: "navigate", tabID: page.state().id, url: action.url ?? "about:blank" }, files: [] },
        signal,
      )
      publishState(entry)
      return { value: page.state(), files: [] }
    }
    const tab = inventory(entry).tabs.find((tab) => tab.id === action.tabID)
    if (!tab)
      throw new Error(
        "Browser tab is unavailable. Call browser.tabs.list({}) and use an existing tabID from this session; a closed tab is not replaced automatically.",
      )
    if (action.type === "tabs.focus") {
      focus(entry, action.tabID)
      return { value: tab, files: [] }
    }
    if (action.type === "tabs.close") {
      await closePage(entry, action.tabID)
      return { value: inventory(entry), files: [] }
    }
    const page = entry.pages.get(action.tabID) ?? create(entry, true, undefined, tab)
    await page.ready
    const result = await page.execute(command, signal)
    publishState(entry)
    return result
  }

  function focus(entry: Entry, tabID: Browser.TabID) {
    entry.focusedTabID = tabID
    publishState(entry)
    report(entry, { type: "focus", tabID })
  }
}
