import fs from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import type { Driver } from "./driver.js"
import { Failed, NotFound, WrongKind, type FileInfo, type FilesImpl, type FileType } from "./files.js"

/**
 * The host filesystem binding. Deliberately raw node:fs rather than effect's
 * FileSystem service or FSUtil: the contract needs lstat semantics (stat
 * reports "symlink") and typed directory entries, and effect's node
 * FileSystem provides neither — its stat always follows symlinks and
 * readDirectory returns names only. FSUtil hits the same gap and its
 * readDirectoryEntries already bypasses to raw node readdir internally.
 * Nothing above the environment seam touches node:fs.
 */
export const makeLocalDriver = (spawner: ChildProcessSpawner["Service"]): Driver => {
  const overrides: FilesImpl = {
    realpath: (value) => attempt(value, () => fs.realpath(value), true),
    read: (value, range) =>
      Effect.gen(function* () {
        const info = yield* stat(value, true)
        if (info.type !== "file") return yield* new WrongKind({ path: value, actual: info.type })
        if (range === undefined) {
          const bytes = yield* attempt(value, () => fs.readFile(value), true)
          return { info, bytes }
        }
        const bytes = yield* attempt(
          value,
          async () => {
            const handle = await fs.open(value, "r")
            try {
              const buffer = new Uint8Array(range.length)
              const result = await handle.read(buffer, 0, range.length, range.offset)
              return buffer.subarray(0, result.bytesRead)
            } finally {
              await handle.close()
            }
          },
          true,
        )
        return { info, bytes }
      }),
    stat: (value) => stat(value, false),
    list: (value) =>
      Effect.gen(function* () {
        const info = yield* stat(value, true)
        if (info.type !== "directory") return yield* new WrongKind({ path: value, actual: info.type })
        const entries = yield* attempt(value, () => fs.readdir(value, { withFileTypes: true }), true)
        return entries.map((entry) => ({ name: entry.name, type: fileType(entry) }))
      }),
    write: (value, bytes) =>
      attempt(value, async () => {
        await fs.mkdir(path.dirname(value), { recursive: true })
        await fs.writeFile(value, bytes)
      }),
    remove: (value) => attempt(value, () => fs.rm(value, { recursive: true, force: true })),
    move: (from, to) =>
      Effect.gen(function* () {
        yield* stat(from, false)
        const destination = yield* stat(to, false).pipe(
          Effect.map((info) => (info.type === "directory" ? path.join(to, path.basename(from)) : to)),
          Effect.catchIf(
            (error) => error instanceof NotFound,
            () => Effect.succeed(to),
          ),
        )
        yield* attempt(from, () => fs.rename(from, destination))
      }),
    mkdir: (value) => attempt(value, () => fs.mkdir(value, { recursive: true }).then(() => undefined)),
  }

  return { spawner, overrides }
}

const stat = (value: string, follow: boolean) =>
  attempt(value, () => (follow ? fs.stat(value) : fs.lstat(value)), true).pipe(
    Effect.map((stats): FileInfo => ({ type: fileType(stats), size: stats.size, mtimeMs: stats.mtimeMs })),
  )

const fileType = (entry: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }): FileType => {
  if (entry.isFile()) return "file"
  if (entry.isDirectory()) return "directory"
  if (entry.isSymbolicLink()) return "symlink"
  return "other"
}

function attempt<A>(value: string, run: () => Promise<A>): Effect.Effect<A, Failed>
function attempt<A>(value: string, run: () => Promise<A>, missing: true): Effect.Effect<A, NotFound | Failed>
function attempt<A>(value: string, run: () => Promise<A>, missing = false) {
  return Effect.tryPromise({
    try: run,
    catch: (cause) =>
      missing && isMissing(cause) ? new NotFound({ path: value }) : new Failed({ path: value, cause }),
  })
}

const isMissing = (cause: unknown) =>
  cause !== null &&
  typeof cause === "object" &&
  "code" in cause &&
  (cause.code === "ENOENT" || cause.code === "ENOTDIR")

export * as EnvironmentLocal from "./local.js"
