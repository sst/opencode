export * as ApplicationLifecycle from "./index"

import { app, BrowserWindow } from "electron"
import type { Event } from "electron"
import { Context, Effect, Layer } from "effect"
import { DeepLinksOpened } from "../../shared/ipc-rpc/events"
import { emitIpcEvent } from "../ipc-events"
import { DesktopLogging, scoped } from "../native/logging"
import { DesktopStorage } from "../storage"
import { safeWebContentsURL } from "../windows/state"
import { getLastFocusedWindow, getWindowByID, makeMainWindows, setAppQuitting, setRelaunchHandler } from "../windows"
import { acquireApplicationLock, configureApplication } from "./environment"
import { initializeFirstLaunchOnboarding } from "./onboarding"
import { Shutdown } from "./shutdown"
import { consoleReturnWindow } from "./deep-link"

export interface Interface {
  readonly relaunch: () => void
  readonly prepareToRestart: Effect.Effect<void>
  readonly consumeInitialDeepLinks: () => string[]
  readonly createWindow: () => BrowserWindow
  readonly restoreWindows: () => BrowserWindow[]
}

export class Service extends Context.Service<Service, Interface>()("opencode/desktop/ApplicationLifecycle") {}

const runtime = Layer.effect(
  Service,
  Effect.gen(function* () {
    const shutdown = yield* Shutdown.Service
    const runFork = Effect.runForkWith(yield* Effect.context())
    const windows = yield* makeMainWindows()
    const createWindow = windows.create
    const restoreWindows = windows.restore
    const pendingDeepLinks: string[] = []
    let shutdownReady = false
    const prepareToRestart = shutdown.run.pipe(Effect.ensuring(Effect.sync(() => (shutdownReady = true))))
    const focusWindow = (win: BrowserWindow | null) => {
      if (!win) return
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    }
    const emitDeepLinks = (urls: string[]) => {
      if (!urls.length) return
      pendingDeepLinks.push(...urls)
      const target = urls.flatMap((url) => {
        const id = consoleReturnWindow(url)
        const win = id ? getWindowByID(id) : null
        return win ? [win] : []
      })[0]
      const win = target ?? getLastFocusedWindow()
      if (win) emitIpcEvent(win.webContents, new DeepLinksOpened({ urls }))
      return win
    }
    const relaunch = () => {
      setAppQuitting()
      runFork(
        prepareToRestart.pipe(
          Effect.ensuring(
            Effect.sync(() => {
              app.relaunch()
              app.quit()
            }),
          ),
        ),
      )
    }
    const secondInstance = (_event: Event, argv: string[]) => {
      const urls = argv.filter((arg) => arg.startsWith("opencode://"))
      if (urls.length) {
        runFork(Effect.logInfo("deep link received via second-instance", { urls }))
        focusWindow(emitDeepLinks(urls) ?? null)
      }
      if (!urls.length) focusWindow(getLastFocusedWindow())
    }
    const openUrl = (event: Event, url: string) => {
      event.preventDefault()
      runFork(Effect.logInfo("deep link received via open-url", { url }))
      focusWindow(emitDeepLinks([url]) ?? null)
    }
    const beforeQuit = (event: Event) => {
      setAppQuitting()
      if (shutdownReady) return
      event.preventDefault()
      runFork(prepareToRestart.pipe(Effect.ensuring(Effect.sync(() => app.quit()))))
    }
    const willQuit = () => {
      setAppQuitting()
      runFork(shutdown.run)
    }
    const childProcessGone = (_event: Event, details: Electron.Details) => {
      runFork(scoped("utility", Effect.logError("child process gone", { details })))
    }
    const renderProcessGone = (
      _event: Event,
      webContents: Electron.WebContents,
      details: Electron.RenderProcessGoneDetails,
    ) => {
      runFork(
        scoped("window", Effect.logError("app render process gone", { url: safeWebContentsURL(webContents), details })),
      )
    }
    const signal = () => {
      setAppQuitting()
      runFork(prepareToRestart.pipe(Effect.ensuring(Effect.sync(() => app.quit()))))
    }
    const windowAllClosed = () => {
      if (process.platform !== "darwin") app.quit()
    }
    const activate = () => {
      if (BrowserWindow.getAllWindows().length === 0) restoreWindows()
    }
    const resetRelaunchHandler = setRelaunchHandler(relaunch)
    let windowsWired = false

    app.on("second-instance", secondInstance)
    app.on("open-url", openUrl)
    app.on("before-quit", beforeQuit)
    app.on("will-quit", willQuit)
    app.on("child-process-gone", childProcessGone)
    app.on("render-process-gone", renderProcessGone)
    process.on("SIGINT", signal)
    process.on("SIGTERM", signal)
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        app.off("second-instance", secondInstance)
        app.off("open-url", openUrl)
        app.off("before-quit", beforeQuit)
        app.off("will-quit", willQuit)
        app.off("child-process-gone", childProcessGone)
        app.off("render-process-gone", renderProcessGone)
        app.off("window-all-closed", windowAllClosed)
        app.off("activate", activate)
        process.off("SIGINT", signal)
        process.off("SIGTERM", signal)
        resetRelaunchHandler()
      }),
    )

    return Service.of({
      relaunch,
      prepareToRestart,
      consumeInitialDeepLinks: () => pendingDeepLinks.splice(0),
      createWindow,
      restoreWindows: () => {
        if (!windowsWired) {
          windowsWired = true
          app.on("window-all-closed", windowAllClosed)
          app.on("activate", activate)
        }
        return restoreWindows()
      },
    })
  }),
)

// Storage opens after configureApplication has set userData and before windows exist, so window
// teardown can clear a window's persisted state and every renderer request finds it ready.
const platform = Layer.mergeAll(
  DesktopLogging.layer,
  Shutdown.layer,
  DesktopStorage.layer.pipe(Layer.provide(DesktopLogging.layer)),
)

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    // Electron scopes the single-instance lock to userData.
    yield* configureApplication()
    if (!acquireApplicationLock()) return yield* Effect.interrupt
    // Decide first-launch state before the storage layer creates drafts.sqlite, which would
    // otherwise read as evidence of an earlier launch on a fresh install.
    yield* initializeFirstLaunchOnboarding(app.getPath("userData"))
    return runtime.pipe(Layer.provideMerge(platform))
  }),
)
