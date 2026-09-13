import {
  createClipboard,
  createHostClipboard,
  createRendererClipboardAdapter,
  decodePasteBytes,
  type ClipboardService as CoreClipboardService,
  type RendererClipboardBoundary,
} from "@opentui/core"
import type { ClipboardContent, ClipboardService } from "./context/clipboard"

export type OwnedClipboardService = Required<ClipboardService> & Readonly<{ dispose(): Promise<void> }>

export function createTuiClipboard(renderer: RendererClipboardBoundary): OwnedClipboardService {
  return createClipboardAdapter(
    createClipboard({
      host: createHostClipboard(),
      terminal: createRendererClipboardAdapter(renderer),
    }),
  )
}

export function createClipboardAdapter(clipboard: CoreClipboardService): OwnedClipboardService {
  return {
    async read(): Promise<ClipboardContent | undefined> {
      const result = await clipboard.read({
        preferredTypes: ["image/png", "text/plain"],
        selection: "clipboard",
      })
      if (result.status !== "read") {
        if (result.status === "failed") throw result.error
        if (result.status === "timed-out") throw new Error("Clipboard read timed out")
        if (result.status === "limit-exceeded") {
          throw new RangeError("Clipboard content exceeded configured read or image conversion limits")
        }
        return undefined
      }

      if (result.representation.mimeType === "image/png") {
        return {
          data: Buffer.from(result.representation.bytes).toString("base64"),
          mime: result.representation.mimeType,
        }
      }
      if (result.representation.mimeType === "text/plain") {
        if (result.representation.bytes.length === 0) return undefined
        return {
          data: decodePasteBytes(result.representation.bytes),
          mime: result.representation.mimeType,
        }
      }
      throw new Error(`Unexpected clipboard MIME type: ${result.representation.mimeType}`)
    },
    async write(text) {
      // OpenTUI rejects NUL before any destination; host clipboard text cannot contain it.
      const result = await clipboard.writeText(text.replaceAll("\0", ""), {
        destination: "all-available",
        selection: "clipboard",
      })
      if (result.host.status === "written" || result.terminal.status === "attempted") return
      if (result.host.status === "failed") throw result.host.error
      throw new Error(`Clipboard write failed (host: ${result.host.status}, terminal: ${result.terminal.status})`)
    },
    dispose() {
      return clipboard.dispose()
    },
  }
}
