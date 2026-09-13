import type { Platform } from "@opencode/app/desktop"
import type { ElectronAPI } from "../api-types"

type DesktopOS = Extract<Platform, { platform: "desktop" }>["os"]
type DesktopFileAPI = Pick<
  ElectronAPI,
  | "openDirectoryPicker"
  | "openFilePicker"
  | "readPickedFile"
  | "releasePickedFiles"
  | "getPathForFile"
  | "saveFile"
  | "openExternal"
  | "openBrowser"
  | "openLocalFile"
  | "resolveAppPath"
  | "openPath"
  | "revealPath"
  | "readClipboardImage"
  | "writeClipboardText"
>

export function createDesktopFiles(api: DesktopFileAPI, os: DesktopOS, acceptedExtensions: string[]) {
  const attachmentPaths = new WeakMap<File, string>()
  const openDirectoryPickerDialog: Extract<Platform, { platform: "desktop" }>["openDirectoryPickerDialog"] = async (
    options,
  ) => {
    return api.openDirectoryPicker({
      multiple: options?.multiple ?? false,
      title: options?.title,
    })
  }
  const openAttachmentPickerDialog: NonNullable<Platform["openAttachmentPickerDialog"]> = async (options, onFile) => {
    const result = await api.openFilePicker({
      multiple: options?.multiple ?? false,
      title: options?.title,
      defaultPath: options?.defaultPath,
      extensions: options?.extensions ?? acceptedExtensions,
    })
    if (!result) return
    try {
      for (const file of result.files) {
        const selected = new File([await api.readPickedFile(result.token, file.path)], file.name)
        attachmentPaths.set(selected, file.path)
        await onFile(selected)
      }
    } finally {
      await api.releasePickedFiles(result.token)
    }
  }

  return {
    openDirectoryPickerDialog,
    openAttachmentPickerDialog,
    getPathForFile: (file: File) => attachmentPaths.get(file) ?? api.getPathForFile(file),
    saveFile: (options: { title?: string; defaultPath?: string }, content: string) =>
      api.saveFile({ title: options.title, defaultPath: options.defaultPath }, content),
    openExternal: (url: string) => api.openExternal(url),
    openBrowser: (url: string) => api.openBrowser(url),
    openLocalFile: (url: string) => api.openLocalFile(url),
    async openPath(path: string, app?: string) {
      if (os !== "windows") {
        await api.openPath(path, app)
        return
      }
      const resolvedApp = app ? await api.resolveAppPath(app).catch(() => null) : null
      await api.openPath(path, resolvedApp ?? undefined)
    },
    async revealPath(path: string) {
      return api.revealPath(path)
    },
    async readClipboardImage() {
      const image = await api.readClipboardImage().catch(() => null)
      if (!image) return null
      return new File([new Blob([image.buffer], { type: "image/png" })], `pasted-image-${Date.now()}.png`, {
        type: "image/png",
      })
    },
    writeClipboardText(text: string) {
      return api.writeClipboardText(text)
    },
  }
}
