export * as Ipc from "./ipc"

import { app, BrowserWindow, MessageChannelMain } from "electron"
import { Effect, Layer } from "effect"
import { RpcServer } from "effect/unstable/rpc"
import { DesktopRpcs } from "../shared/ipc-rpc"
import { DragCancelEvent, IpcTransportPort } from "../shared/ipc-transport"
import { DesktopFiles, openExternalURL } from "./files"
import { appHandlers } from "./ipc-handlers/app"
import { eventHandlers } from "./ipc-handlers/events"
import { fileHandlers } from "./ipc-handlers/files"
import { menuHandlers } from "./ipc-handlers/menu"
import { storageHandlers } from "./ipc-handlers/storage"
import { updaterHandlers } from "./ipc-handlers/updater"
import { windowHandlers } from "./ipc-handlers/window"
import { wslHandlers } from "./ipc-handlers/wsl"
import { sshHandlers } from "./ipc-handlers/ssh"
import { Ssh } from "./ssh/service"
import { IpcPortHandoff, IpcServerProtocolLive } from "./ipc-transport"
import { ApplicationLifecycle } from "./lifecycle"
import { showCliInstaller } from "./native/install-cli"
import { createMenu, sendMenuCommand } from "./native/menu"
import { DesktopCli } from "./service/desktop-cli"
import { Updater } from "./updater"
import { getLastFocusedWindow } from "./windows"
import { Wsl } from "./wsl/start"

const services = Layer.mergeAll(DesktopFiles.layer, Wsl.layer, Ssh.layer)
const handlers = Layer.mergeAll(
  appHandlers,
  storageHandlers,
  fileHandlers,
  windowHandlers,
  menuHandlers,
  updaterHandlers,
  wslHandlers,
  sshHandlers,
  eventHandlers,
)
export const layer = RpcServer.layer(DesktopRpcs, { disableFatalDefects: true }).pipe(
  Layer.provide(handlers),
  Layer.provideMerge(IpcServerProtocolLive),
  Layer.provideMerge(services),
)

export const registerIpcHandlers = Effect.gen(function* () {
  const handoff = yield* IpcPortHandoff
  const lifecycle = yield* ApplicationLifecycle.Service
  const desktopCli = yield* DesktopCli.Service
  const updater = yield* Updater.Service
  const runFork = Effect.runForkWith(yield* Effect.context())
  const menu = {
    trigger: (id: string) => {
      const win = getLastFocusedWindow()
      if (win) sendMenuCommand(win, id)
    },
    checkForUpdates: () => runFork(updater.show),
    installCli: () => runFork(showCliInstaller(desktopCli)),
    createWindow: lifecycle.createWindow,
    openExternal: (url: string) => runFork(openExternalURL(url)),
    relaunch: lifecycle.relaunch,
  }
  const wire = (_event: Electron.Event, win: BrowserWindow) => {
    win.webContents.on("before-input-event", (_event, input) => {
      if (input.type !== "keyDown" || input.key !== "Escape") return
      win.webContents.send(DragCancelEvent)
    })
    win.webContents.on("did-finish-load", () => {
      if (win.isDestroyed() || win.webContents.isDestroyed()) return
      const channel = new MessageChannelMain()
      handoff.bind(win.webContents, channel.port1)
      win.webContents.postMessage(IpcTransportPort, null, [channel.port2])
    })
  }
  yield* Effect.sync(() => {
    app.on("browser-window-created", wire)
    BrowserWindow.getAllWindows().forEach((win) => wire({} as Electron.Event, win))
  })
  yield* Effect.addFinalizer(() => Effect.sync(() => app.off("browser-window-created", wire)))
  return {
    installMenu: () => createMenu(menu),
  }
})
