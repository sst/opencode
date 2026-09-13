import { Effect } from "effect"
import { shell } from "electron"
import { resolveExternalURL } from "../files/external-url"
import { FileRpcs } from "../../shared/ipc-rpc"
import { DesktopFiles, openExternalURL, openLocalFileURL } from "../files"
import { IpcPortHandoff } from "../ipc-transport"
import { sender } from "./context"

export const fileHandlers = FileRpcs.toLayer(
  Effect.gen(function* () {
    const files = yield* DesktopFiles.Service
    const handoff = yield* IpcPortHandoff
    return FileRpcs.of({
      FilesOpenDirectoryPicker: ({ options }) => files.openDirectoryPicker(options),
      FilesOpenFilePicker: ({ options }, context) =>
        files
          .openFilePicker(
            sender(handoff, context).id,
            options ? { ...options, extensions: options.extensions && [...options.extensions] } : undefined,
          )
          .pipe(Effect.orDie),
      FilesReadPickedFile: ({ token, path }, context) =>
        files.readPickedFile(sender(handoff, context).id, token, path).pipe(
          Effect.map((buffer) => new Uint8Array(buffer)),
          Effect.orDie,
        ),
      FilesReleasePickedFiles: ({ token }, context) =>
        Effect.sync(() => files.releasePickedFiles(sender(handoff, context).id, token)),
      FilesSaveFile: ({ options, content }) => files.saveFile(options, content).pipe(Effect.orDie),
      FilesOpenExternal: ({ url }) => openExternalURL(url),
      FilesOpenBrowser: ({ url }) => {
        const target = resolveExternalURL(url)
        if (!target || !/^https?:/.test(target)) return Effect.succeed(false)
        return Effect.tryPromise(() => shell.openExternal(target)).pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        )
      },
      FilesOpenLocalFile: ({ url }) => openLocalFileURL(url),
      FilesOpenPath: ({ path, application }) =>
        files.openPath(path, application).pipe(
          Effect.map((result) => result ?? null),
          Effect.orDie,
        ),
      FilesRevealPath: ({ path }) => files.revealPath(path),
      FilesReadClipboardImage: () =>
        Effect.sync(() => {
          const image = files.readClipboardImage()
          return image ? { ...image, buffer: new Uint8Array(image.buffer) } : null
        }),
      FilesWriteClipboardText: ({ text }) => Effect.sync(() => files.writeClipboardText(text)),
    })
  }),
)
