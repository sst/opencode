import {
  ACCEPTED_FILE_EXTENSIONS,
  ServerConnection,
  type Platform,
  type UpdaterPlatform,
} from "@opencode/app/desktop"
import type { ElectronAPI } from "../api-types"
import { setPinchZoomEnabled, webviewZoom } from "../window/zoom"
import { windowFullscreen } from "../window/fullscreen"
import { DragCancelEvent } from "../../shared/ipc-transport"
import { createDesktopFiles } from "./files"
import { createDesktopMenuAction } from "./menu"
import { createDesktopNotify } from "./notifications"
import { createDesktopStorage } from "./storage"

export type DesktopWindowState = {
  id: string
  version: string
}

export function createDesktopPlatform(
  api: ElectronAPI,
  windowState: DesktopWindowState,
  updater: UpdaterPlatform,
): Platform {
  const os = desktopOS()
  return {
    platform: "desktop",
    os,
    version: windowState.version,
    windowID: windowState.id,
    ...createDesktopFiles(api, os, ACCEPTED_FILE_EXTENSIONS),
    ...createDesktopStorage(api),
    browserPane: {
      register(target, onEvent) {
        const bindingID = crypto.randomUUID()
        let closed = false
        const dispose = api.browserPane.onEvent((value) => {
          if (!closed && value.bindingID === bindingID) onEvent(value.event)
        })
        const ready = api.browserPane.request({ type: "register", bindingID, target })
        // Failures reach the owner through the closed-state event; keep the bare promise handled.
        void ready.catch(() => undefined)
        return {
          setLayout(layout) {
            if (!closed)
              void ready
                .then(() =>
                  api.browserPane.send({ type: "layout", bindingID, ...(layout === undefined ? {} : { layout }) }),
                )
                .catch(() => undefined)
          },
          command: (command) => ready.then(() => api.browserPane.request({ type: "command", bindingID, command })),
          close() {
            if (closed) return
            closed = true
            dispose()
            void ready.then(() => api.browserPane.request({ type: "close", bindingID })).catch(() => undefined)
          },
        }
      },
    },
    updater,
    exportDebugLogs: () => api.exportDebugLogs(),
    setForceFocus: (enabled) => api.setForceFocus(enabled),
    recordFatalRendererError: (error) => api.recordFatalRendererError(error),
    restart: async () => api.relaunch(),
    notify: createDesktopNotify(api),
    fetch: (input, init) => {
      if (input instanceof Request) return fetch(input)
      return fetch(input, init)
    },
    getDefaultServer: async () => {
      const url = await api.getDefaultServerUrl().catch(() => null)
      if (!url) return null
      return ServerConnection.Key.make(url)
    },
    setDefaultServer: async (url) => {
      await api.setDefaultServerUrl(url)
    },
    wslServers: os === "windows" ? api.wslServers : undefined,
    sshServers: api.sshServers,
    webviewZoom,
    windowFullscreen,
    getPinchZoomEnabled: () => api.getPinchZoomEnabled(),
    setPinchZoomEnabled,
    onDragCancel: (callback) => {
      window.addEventListener(DragCancelEvent, callback)
      return () => window.removeEventListener(DragCancelEvent, callback)
    },
    runDesktopMenuAction: createDesktopMenuAction(api),
    checkAppExists: async (appName) => {
      return api.checkAppExists(appName)
    },
  }
}

function desktopOS() {
  if (navigator.userAgent.includes("Mac")) return "macos"
  if (navigator.userAgent.includes("Windows")) return "windows"
  if (navigator.userAgent.includes("Linux")) return "linux"
  return undefined
}
