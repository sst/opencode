import { Effect, Schema } from "effect"

export const FileType = Schema.Literals(["file", "directory", "symlink", "other"])
export type FileType = typeof FileType.Type

export interface FileInfo {
  readonly type: FileType
  readonly size: number
  readonly mtimeMs: number
}

export interface DirEntry {
  readonly name: string
  readonly type: FileType
}

export class NotFound extends Schema.TaggedError<NotFound>()("Environment.NotFound", {
  path: Schema.String,
}) {}

export class WrongKind extends Schema.TaggedError<WrongKind>()("Environment.WrongKind", {
  path: Schema.String,
  actual: FileType,
}) {}

export class Failed extends Schema.TaggedError<Failed>()("Environment.Failed", {
  path: Schema.String,
  cause: Schema.Defect(),
}) {}

export interface FilesImpl {
  /**
   * Content operations (`read`, `list`) follow final symlinks; metadata operations (`stat` and entry
   * tags returned by `list`) do not. `info` describes the target file whose bytes are returned.
   * The process-backed default caps collected output at 64 MiB; larger whole-file reads fail with
   * `Failed`, so callers must use ranges for larger files.
   */
  readonly read: (
    path: string,
    range?: { readonly offset: number; readonly length: number },
  ) => Effect.Effect<{ readonly info: FileInfo; readonly bytes: Uint8Array }, NotFound | WrongKind | Failed>
  /** Resolves every symlink and requires the resulting path to exist. */
  readonly realpath: (path: string) => Effect.Effect<string, NotFound | Failed>
  readonly write: (path: string, bytes: Uint8Array) => Effect.Effect<void, Failed>
  /** Describes the path entry itself, so a final symlink is reported as `symlink` rather than followed. */
  readonly stat: (path: string) => Effect.Effect<FileInfo, NotFound | Failed>
  /** Follows a final symlink to the listed directory while preserving each returned entry's own type. */
  readonly list: (path: string) => Effect.Effect<ReadonlyArray<DirEntry>, NotFound | WrongKind | Failed>
  readonly remove: (path: string) => Effect.Effect<void, Failed>
  readonly move: (from: string, to: string) => Effect.Effect<void, NotFound | Failed>
  readonly mkdir: (path: string) => Effect.Effect<void, Failed>
}

export interface Files extends FilesImpl {}

/**
 * Derives a follow-stat kind from the lstat-like Files contract. A dangling
 * symlink fails with `NotFound`.
 */
export const typeFollowing = (files: Files, path: string) =>
  files.stat(path).pipe(
    Effect.flatMap((info) =>
      info.type === "symlink"
        ? files.read(path, { offset: 0, length: 0 }).pipe(
            Effect.map((result) => result.info.type),
            Effect.catchTag("Environment.WrongKind", (error) => Effect.succeed(error.actual)),
          )
        : Effect.succeed(info.type),
    ),
  )

export * as EnvironmentFiles from "./files.js"
