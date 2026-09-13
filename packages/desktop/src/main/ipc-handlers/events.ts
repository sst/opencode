import { BrowserWindow } from "electron"
import { Effect } from "effect"
import { EventRpcs } from "../../shared/ipc-rpc"
import { createBrowserPane } from "../browser-pane"
import { ipcEventStream } from "../ipc-events"
import { IpcPortHandoff } from "../ipc-transport"
import { Shutdown } from "../lifecycle/shutdown"
import { isRendererUrl } from "../windows/protocol"
import { DesktopStorage } from "../storage"
import { sender } from "./context"

export const eventHandlers = EventRpcs.toLayer(
  Effect.gen(function* () {
    const handoff = yield* IpcPortHandoff
    const shutdown = yield* Shutdown.Service
    const storage = yield* DesktopStorage.Service
    const browser = createBrowserPane(storage.state)
    const stop = Effect.promise(() => browser.dispose())
    const remove = yield* shutdown.add(stop)
    yield* Effect.addFinalizer(() => Effect.sync(remove).pipe(Effect.andThen(stop)))
    return EventRpcs.of({
      DesktopEvents: (_request, context) => ipcEventStream(sender(handoff, context).id),
      BrowserPane: ({ request }, context) =>
        Effect.tryPromise(async () => {
          const contents = sender(handoff, context)
          const win = BrowserWindow.fromWebContents(contents)
          if (!win || win.isDestroyed() || win.webContents !== contents || !isRendererUrl(contents.getURL())) {
            throw new Error("browser.pane.owner.invalid")
          }
          if (request.type === "register") return browser.register(win, request.bindingID, request.target)
          if (request.type === "layout") return browser.layout(win, request.bindingID, request.layout)
          if (request.type === "command") return browser.command(win, request.bindingID, request.command)
          return browser.close(win, request.bindingID)
        }).pipe(Effect.orDie),
    })
  }),
)
