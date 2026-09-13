import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/unstable/rpc"

const OptionalString = Schema.optional(Schema.String)
const PickerOptions = Schema.Struct({
  multiple: Schema.optional(Schema.Boolean),
  title: OptionalString,
  defaultPath: OptionalString,
})
const FilePickerOptions = Schema.Struct({
  multiple: Schema.optional(Schema.Boolean),
  title: OptionalString,
  defaultPath: OptionalString,
  extensions: Schema.optional(Schema.Array(Schema.String)),
})
const SavePickerOptions = Schema.Struct({ title: OptionalString, defaultPath: OptionalString })
const PickedFiles = Schema.Struct({
  token: Schema.String,
  files: Schema.Array(Schema.Struct({ path: Schema.String, name: Schema.String, size: Schema.Number })),
})
const ClipboardImage = Schema.Struct({ buffer: Schema.Uint8Array, width: Schema.Number, height: Schema.Number })

export const FilesOpenDirectoryPicker = Rpc.make("FilesOpenDirectoryPicker", {
  payload: { options: Schema.optional(PickerOptions) },
  success: Schema.NullOr(Schema.Union([Schema.String, Schema.Array(Schema.String)])),
})
export const FilesOpenFilePicker = Rpc.make("FilesOpenFilePicker", {
  payload: { options: Schema.optional(FilePickerOptions) },
  success: Schema.NullOr(PickedFiles),
})
export const FilesReadPickedFile = Rpc.make("FilesReadPickedFile", {
  payload: { token: Schema.String, path: Schema.String },
  success: Schema.Uint8Array,
})
export const FilesReleasePickedFiles = Rpc.make("FilesReleasePickedFiles", {
  payload: { token: Schema.String },
})
export const FilesSaveFile = Rpc.make("FilesSaveFile", {
  payload: { options: SavePickerOptions, content: Schema.String },
  success: Schema.Boolean,
})
export const FilesOpenExternal = Rpc.make("FilesOpenExternal", {
  payload: { url: Schema.String },
})
export const FilesOpenBrowser = Rpc.make("FilesOpenBrowser", {
  payload: { url: Schema.String },
  success: Schema.Boolean,
})
export const FilesOpenLocalFile = Rpc.make("FilesOpenLocalFile", {
  payload: { url: Schema.String },
})
export const FilesOpenPath = Rpc.make("FilesOpenPath", {
  payload: { path: Schema.String, application: Schema.optional(Schema.String) },
  success: Schema.NullOr(Schema.String),
})
export const FilesRevealPath = Rpc.make("FilesRevealPath", {
  payload: { path: Schema.String },
  success: Schema.Boolean,
})
export const FilesReadClipboardImage = Rpc.make("FilesReadClipboardImage", {
  success: Schema.NullOr(ClipboardImage),
})
export const FilesWriteClipboardText = Rpc.make("FilesWriteClipboardText", {
  payload: { text: Schema.String },
})

export const FileRpcs = RpcGroup.make(
  FilesOpenDirectoryPicker,
  FilesOpenFilePicker,
  FilesReadPickedFile,
  FilesReleasePickedFiles,
  FilesSaveFile,
  FilesOpenExternal,
  FilesOpenBrowser,
  FilesOpenLocalFile,
  FilesOpenPath,
  FilesRevealPath,
  FilesReadClipboardImage,
  FilesWriteClipboardText,
)
