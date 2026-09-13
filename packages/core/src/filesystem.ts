export * as FileSystem from "./filesystem.js"

import { makeLocationNode } from "@opencode/util/effect/app-node"
import path from "path"
import { Context, Effect, Layer, Schema } from "effect"
import { FSUtil } from "@opencode/util/fs-util"
import { Environment } from "./environment/index.js"
import { Location } from "./location.js"
import { PositiveInt, RelativePath } from "./schema.js"
import { FileSystemSearch } from "./filesystem/search.js"
import { Entry, FileSystem, FindInput } from "@opencode/schema/filesystem"
export { Entry, Match, Submatch } from "@opencode/schema/filesystem"

export const ReadInput = Schema.Struct({
  path: RelativePath,
})
export type ReadInput = typeof ReadInput.Type

export class NotFoundError extends Schema.TaggedError<NotFoundError>()("FileSystem.NotFoundError", {
  path: RelativePath,
}) {}

export const Content = Schema.Struct({
  uri: Schema.String,
  name: Schema.String.pipe(Schema.optional),
  content: Schema.String,
  encoding: Schema.Literals(["utf8", "base64"]),
  mime: Schema.String,
}).annotate({ identifier: "FileSystem.Content" })
export type Content = typeof Content.Type

export const ListInput = Schema.Struct({
  path: Schema.String.pipe(Schema.optional),
})
export type ListInput = typeof ListInput.Type

export { FindInput }

export const DEFAULT_SEARCH_LIMIT = 100
export const DEFAULT_SEARCH_TIMEOUT_MS = 30_000

export class GlobInput extends Schema.Class<GlobInput>("FileSystem.GlobInput")({
  pattern: Schema.String,
  path: Schema.optionalKey(RelativePath),
  hidden: Schema.optionalKey(Schema.Boolean),
  limit: Schema.optionalKey(PositiveInt),
}) {}

export class GrepInput extends Schema.Class<GrepInput>("FileSystem.GrepInput")({
  pattern: Schema.String,
  path: Schema.optionalKey(RelativePath),
  include: Schema.optionalKey(Schema.String),
  literal: Schema.optionalKey(Schema.Boolean),
  caseSensitive: Schema.optionalKey(Schema.Boolean),
  limit: Schema.optionalKey(PositiveInt),
}) {}

export const Event = FileSystem.Event

export interface Interface {
  readonly read: (
    input: ReadInput,
  ) => Effect.Effect<{ readonly content: Uint8Array; readonly mime: string }, NotFoundError>
  readonly list: (input?: ListInput) => Effect.Effect<Entry[]>
  readonly find: (input: FindInput) => Effect.Effect<Entry[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/FileSystem") {}

const baseLayer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const environment = yield* Environment.Service
    const location = yield* Location.Service
    const search = yield* FileSystemSearch.Service
    // Workspace-placed directories exist only inside the workspace, so a host
    // realpath probe at boot consults the wrong filesystem and would block
    // construction on servers without a matching local directory. Treat the
    // configured directory as canonical; local placements keep symlink
    // canonicalization. Execution-plane operations below resolve through the
    // Location environment and may provision a workspace on first use.
    const root = location.workspaceID ? undefined : yield* fs.realPath(location.directory).pipe(Effect.orDie)
    const resolve = Effect.fnUntraced(function* (input?: RelativePath) {
      const absolute = path.resolve(location.directory, input ?? ".")
      if (!FSUtil.contains(location.directory, absolute))
        return yield* Effect.die(new Error("Path escapes the location"))
      const canonicalRoot = root ?? (yield* environment.files.realpath(location.directory))
      const real = yield* environment.files.realpath(absolute)
      if (!FSUtil.contains(canonicalRoot, real)) return yield* Effect.die(new Error("Path escapes the location"))
      return { absolute, real, directory: location.directory }
    })
    return Service.of({
      find: search.find,
      read: Effect.fn("FileSystem.read")(function* (input) {
        return yield* Effect.gen(function* () {
          const target = yield* resolve(input.path)
          const result = yield* environment.files.read(target.real)
          return {
            content: result.bytes,
            mime: FSUtil.mimeType(target.real),
          }
        }).pipe(
          Effect.catchTags({
            "Environment.NotFound": () => Effect.fail(new NotFoundError({ path: input.path })),
            "Environment.WrongKind": (error) => Effect.die(error),
            "Environment.Failed": (error) => Effect.die(error),
          }),
        )
      }),
      list: Effect.fn("FileSystem.list")(function* (input = {}) {
        // Navigation can leave the cwd without activating another Location.
        const directory = path.resolve(location.directory, input.path ?? ".")
        return yield* environment.files.list(directory).pipe(
          Effect.orDie,
          Effect.map((items) =>
            items
              .flatMap((item) => {
                if (item.type !== "file" && item.type !== "directory") return []
                const absolute = path.join(directory, item.name)
                const relative = path.relative(location.directory, absolute) || "."
                return [
                  Entry.make({
                    path: RelativePath.make(relative + (item.type === "directory" ? path.sep : "")),
                    type: item.type,
                  }),
                ]
              })
              .sort((a, b) => (a.type === b.type ? a.path.localeCompare(b.path) : a.type === "directory" ? -1 : 1)),
          ),
        )
      }),
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer: baseLayer,
  deps: [FSUtil.node, Environment.node, Location.node, FileSystemSearch.node],
})
