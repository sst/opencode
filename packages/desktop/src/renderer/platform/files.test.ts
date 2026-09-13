import { describe, expect, test } from "bun:test"
import { createDesktopFiles } from "./files"

function fileApi(events: string[]) {
  return {
    openDirectoryPicker: async () => null,
    openFilePicker: async () => ({
      token: "selection",
      files: [
        { path: "C:\\first.txt", name: "first.txt", size: 5 },
        { path: "C:\\second.txt", name: "second.txt", size: 6 },
      ],
    }),
    readPickedFile: async (_token: string, path: string) => {
      events.push(`read:${path}`)
      return new TextEncoder().encode(path).buffer
    },
    releasePickedFiles: async (token: string) => {
      events.push(`release:${token}`)
    },
    getPathForFile: () => "fallback",
    saveFile: async () => false,
    openExternal: () => {},
    openBrowser: async () => true,
    openLocalFile: () => {},
    resolveAppPath: async () => null,
    openPath: async () => undefined,
    revealPath: async () => false,
    readClipboardImage: async () => null,
    writeClipboardText: async (text: string) => {
      events.push(`clipboard:${text}`)
    },
  }
}

describe("desktop attachment files", () => {
  test("reports native browser launch failure to the renderer", async () => {
    const files = createDesktopFiles({ ...fileApi([]), openBrowser: async () => false }, "macos", [])
    expect(await files.openBrowser("https://opencode.ai/console")).toBe(false)
  })
  test("reads selected files sequentially and releases the token", async () => {
    const events: string[] = []
    const files = createDesktopFiles(fileApi(events), "windows", ["txt"])

    await files.openAttachmentPickerDialog({}, async (file) => {
      events.push(`file:${file.name}`)
    })

    expect(events).toEqual([
      "read:C:\\first.txt",
      "file:first.txt",
      "read:C:\\second.txt",
      "file:second.txt",
      "release:selection",
    ])
  })

  test("releases the token when a selected file callback fails", async () => {
    const events: string[] = []
    const files = createDesktopFiles(fileApi(events), "windows", ["txt"])

    await expect(
      files.openAttachmentPickerDialog({}, async () => {
        throw new Error("attachment rejected")
      }),
    ).rejects.toThrow("attachment rejected")
    expect(events.at(-1)).toBe("release:selection")
  })

  test("writes clipboard text through the native desktop API", async () => {
    const events: string[] = []
    const files = createDesktopFiles(fileApi(events), "windows", ["txt"])

    await files.writeClipboardText("ses_123")

    expect(events).toEqual(["clipboard:ses_123"])
  })
})
