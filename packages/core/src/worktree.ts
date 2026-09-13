export * as Worktree from "./worktree.js"

import { Context, Effect, Layer, Schema } from "effect"
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm"
import path from "path"
import { AbsolutePath } from "./schema.js"
import { FSUtil } from "@opencode/util/fs-util"
import { Git } from "./git.js"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { Global } from "@opencode/util/global"
import { ProjectSchema } from "./project/schema.js"
import { Slug } from "./util/slug.js"
import { Bus } from "./bus.js"
import { Database } from "./database/database.js"
import { Location } from "./location.js"
import { Worktree } from "@opencode/schema/worktree"
import { WorktreeTable } from "./worktree/sql.js"
import { canonical, DirectoryUnavailableError } from "./worktree/directory.js"
import { WorktreeGit } from "./worktree/git.js"
import type { EffectDrizzleSqlite } from "./database/drizzle.js"
import { ProjectTable } from "./project/sql.js"
import { AppProcess } from "@opencode/util/process"
import { ChildProcess } from "effect/unstable/process"
import { State } from "./state.js"

export { DirectoryUnavailableError } from "./worktree/directory.js"
export { OperationError } from "@opencode/schema/worktree"

export const StrategyID = Worktree.StrategyID
export type StrategyID = typeof StrategyID.Type

export const CreateInput = Worktree.CreateInput
export type CreateInput = typeof CreateInput.Type

export const RemoveInput = Worktree.RemoveInput
export type RemoveInput = typeof RemoveInput.Type

export const RefreshResult = Schema.Struct({
  updated: Schema.Array(AbsolutePath),
  removed: Schema.Array(AbsolutePath),
}).annotate({ identifier: "Worktree.RefreshResult" })
export type RefreshResult = typeof RefreshResult.Type

export const Info = Worktree.Info
export type Info = typeof Info.Type

export const List = Worktree.List
export type List = typeof List.Type

export const ListEntry = Worktree.ListEntry
export type ListEntry = typeof ListEntry.Type

export class SourceDirectoryNotFoundError extends Schema.TaggedError<SourceDirectoryNotFoundError>()(
  "Worktree.SourceDirectoryNotFoundError",
  { projectID: ProjectSchema.ID, directory: Schema.optional(AbsolutePath) },
) {}

export class DestinationExistsError extends Schema.TaggedError<DestinationExistsError>()(
  "Worktree.DestinationExistsError",
  { directory: AbsolutePath },
) {}

export class InvalidDirectoryError extends Schema.TaggedError<InvalidDirectoryError>()(
  "Worktree.InvalidDirectoryError",
  { directory: AbsolutePath },
) {}

export class StrategyUnavailableError extends Schema.TaggedError<StrategyUnavailableError>()(
  "Worktree.StrategyUnavailableError",
  { strategy: StrategyID },
) {}

export class UnsupportedLocationError extends Schema.TaggedError<UnsupportedLocationError>()(
  "Worktree.UnsupportedLocationError",
  { directory: AbsolutePath },
) {}

export type Error =
  | SourceDirectoryNotFoundError
  | DestinationExistsError
  | DirectoryUnavailableError
  | InvalidDirectoryError
  | StrategyUnavailableError
  | UnsupportedLocationError
  | Worktree.OperationError
  | AppProcess.AppProcessError
  | Git.WorktreeError

export interface Strategy {
  readonly id: StrategyID
  readonly create: (input: {
    sourceDirectory: AbsolutePath
    directory: AbsolutePath
    branch?: string
  }) => Effect.Effect<Info, unknown>
  readonly remove: (input: { directory: AbsolutePath; force: boolean }) => Effect.Effect<void, unknown>
  readonly list: (directory: AbsolutePath) => Effect.Effect<readonly ListEntry[], unknown>
}

export const Event = Worktree.Event

interface StoredInput {
  readonly directory: AbsolutePath
  readonly strategy?: string
  readonly replace?: boolean
}

type DatabaseClient = EffectDrizzleSqlite.EffectSQLiteDatabase
type Transaction = Parameters<Parameters<DatabaseClient["transaction"]>[0]>[0]

export interface Editor {
  readonly add: (strategy: Strategy) => void
  readonly configure: (settings: { readonly directory: AbsolutePath }) => void
}

export interface Interface extends State.Transformable<Editor> {
  readonly list: () => Effect.Effect<List, Error>
  readonly create: (input?: CreateInput) => Effect.Effect<Info, Error>
  readonly remove: (input: RemoveInput) => Effect.Effect<void, Error>
  readonly refresh: () => Effect.Effect<RefreshResult, Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/Worktree") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const database = yield* Database.Service
    const db = database.db
    const bus = yield* Bus.Service
    const processService = yield* AppProcess.Service
    const location = yield* Location.Service
    const global = yield* Global.Service
    const projectID = location.project.id

    const local = location.workspaceID
      ? Effect.fail(new UnsupportedLocationError({ directory: location.directory }))
      : Effect.void

    const gitStrategy = yield* WorktreeGit.make
    const state = State.create({
      name: "worktree",
      initial: () => ({
        directory: AbsolutePath.make(path.join(global.data, "worktree", projectID.slice(0, 6))),
        strategies: new Map<StrategyID, Strategy>([[gitStrategy.id, gitStrategy]]),
        selected: gitStrategy.id,
      }),
      editor: (value): Editor => ({
        configure: (settings) => {
          value.directory = settings.directory
        },
        add: (strategy) => {
          value.strategies.delete(strategy.id)
          value.strategies.set(strategy.id, strategy)
          value.selected = strategy.id
        },
      }),
    })

    const changed = Effect.fnUntraced(function* (update: boolean) {
      if (update) yield* bus.publish(Event.Updated, { projectID })
    })

    const ops = {
      list: Effect.fnUntraced(function* () {
        const rows = yield* db
          .select({ directory: WorktreeTable.directory, strategy: WorktreeTable.strategy })
          .from(WorktreeTable)
          .where(eq(WorktreeTable.project_id, projectID))
          .orderBy(desc(WorktreeTable.time_created), asc(WorktreeTable.directory))
          .all()
          .pipe(Effect.orDie)
        return rows.map((row) => ({ directory: row.directory, strategy: row.strategy ?? undefined }))
      }),
      find: Effect.fnUntraced(function* (directory: AbsolutePath) {
        const row = yield* db
          .select({ directory: WorktreeTable.directory, strategy: WorktreeTable.strategy })
          .from(WorktreeTable)
          .where(and(eq(WorktreeTable.project_id, projectID), eq(WorktreeTable.directory, directory)))
          .get()
          .pipe(Effect.orDie)
        return row ? { directory: row.directory, strategy: row.strategy ?? undefined } : undefined
      }),
      create: (input: StoredInput, tx?: Transaction) =>
        (tx ?? db)
          .insert(WorktreeTable)
          .values({
            project_id: projectID,
            directory: input.directory,
            strategy: input.strategy,
          })
          .onConflictDoUpdate({
            target: [WorktreeTable.project_id, WorktreeTable.directory],
            set: {
              strategy: input.strategy ?? null,
            },
            // Discovery may claim an unowned row, but never replace another strategy's ownership.
            setWhere: input.replace ? undefined : input.strategy ? isNull(WorktreeTable.strategy) : sql`false`,
          })
          .returning({ directory: WorktreeTable.directory })
          .get()
          .pipe(
            Effect.orDie,
            Effect.map((row) => row !== undefined),
          ),
      remove: (directory: AbsolutePath, tx?: Transaction) =>
        (tx ?? db)
          .delete(WorktreeTable)
          .where(and(eq(WorktreeTable.project_id, projectID), eq(WorktreeTable.directory, directory)))
          .returning({ directory: WorktreeTable.directory })
          .get()
          .pipe(
            Effect.orDie,
            Effect.map((row) => row !== undefined),
          ),
    }

    const source = Effect.fnUntraced(function* (input: AbsolutePath | undefined) {
      const sourceDirectory = input ?? location.project.directory
      const resolved = yield* canonical(fs, sourceDirectory)
      if ((yield* ops.find(resolved)) === undefined)
        return yield* new SourceDirectoryNotFoundError({ projectID, directory: resolved })
      return resolved
    })

    const getStrategy = Effect.fnUntraced(function* (id: StrategyID, strategies: ReadonlyMap<StrategyID, Strategy>) {
      const found = strategies.get(id)
      if (!found) return yield* new StrategyUnavailableError({ strategy: id })
      return found
    })

    const create = Effect.fn("Worktree.create")(function* (input: CreateInput = {}) {
      yield* local
      const current = state.get()
      const selected = yield* getStrategy(input.strategy ?? current.selected, current.strategies)
      const directory = input.directory ?? current.directory
      const sourceDirectory = yield* source(input.from)
      yield* fs.makeDirectory(directory, { recursive: true }).pipe(Effect.orDie)
      const name = input.name ?? Slug.create()
      let suffix = 1
      let worktreeDirectory = AbsolutePath.make(path.join(directory, name))
      while (yield* fs.existsSafe(worktreeDirectory)) {
        suffix++
        if (suffix > 10) return yield* new DestinationExistsError({ directory: worktreeDirectory })
        worktreeDirectory = AbsolutePath.make(path.join(directory, `${name}-${suffix}`))
      }

      const created = yield* selected
        .create({
          directory: worktreeDirectory,
          sourceDirectory,
          branch: input.branch,
        })
        .pipe(Effect.mapError((error) => operationError(selected.id, "create", error)))
      const result = { directory: yield* canonical(fs, created.directory) }
      yield* changed(
        yield* ops.create({
          directory: result.directory,
          strategy: selected.id,
          replace: true,
        }),
      )
      const project = yield* db
        .select({ commands: ProjectTable.commands })
        .from(ProjectTable)
        .where(eq(ProjectTable.id, projectID))
        .get()
        .pipe(Effect.orDie)
      const command = project?.commands?.start?.trim()
      if (command) {
        const windows = process.platform === "win32"
        yield* processService
          .run(
            ChildProcess.make(windows ? command : "bash", windows ? [] : ["-lc", command], {
              cwd: result.directory,
              env: {
                OPENCODE_WORKTREE_BASE: sourceDirectory,
                OPENCODE_WORKTREE_PATH: result.directory,
              },
              extendEnv: true,
              stdin: "ignore",
              shell: windows,
            }),
          )
          .pipe(Effect.flatMap(AppProcess.requireSuccess))
      }
      return result
    })

    const remove = Effect.fn("Worktree.remove")(function* (input: RemoveInput) {
      yield* local
      const worktreeDirectory = yield* canonical(fs, input.directory)
      const stored = yield* ops.find(worktreeDirectory)
      if (!stored?.strategy) return yield* new InvalidDirectoryError({ directory: worktreeDirectory })
      const strategy = yield* getStrategy(StrategyID.make(stored.strategy), state.get().strategies)
      yield* strategy
        .remove({
          directory: worktreeDirectory,
          force: input.force,
        })
        .pipe(Effect.mapError((error) => operationError(strategy.id, "remove", error)))
      yield* changed(yield* ops.remove(worktreeDirectory))
    })

    const refresh = Effect.fn("Worktree.refresh")(function* () {
      yield* local
      const stored = yield* ops.list()
      const checked = yield* Effect.forEach(
        stored,
        (item) => fs.isDir(item.directory).pipe(Effect.map((exists) => ({ ...item, exists }))),
        { concurrency: "unbounded" },
      )
      const strategies = Array.from(state.get().strategies.values()).toReversed()
      const discovered = new Map<AbsolutePath, StoredInput>()
      // A location's plugin instances only discover its own checkout, not sibling clones.
      if (checked.some((item) => item.directory === location.project.directory && item.exists)) {
        for (const strategy of strategies) {
          const entries = yield* strategy.list(location.project.directory).pipe(
            Effect.mapError((error) => operationError(strategy.id, "list", error)),
            Effect.catchTag("Worktree.DirectoryUnavailableError", () => Effect.succeed([])),
          )
          for (const entry of entries) {
            const directory = yield* canonical(fs, entry.directory).pipe(
              Effect.catchTag("Worktree.DirectoryUnavailableError", () => Effect.undefined),
            )
            if (!directory || discovered.has(directory)) continue
            discovered.set(directory, {
              directory,
              strategy: entry.type === "worktree" ? strategy.id : undefined,
            })
          }
        }
      }
      const removed = checked.filter((item) => !item.exists).map((item) => item.directory)
      const changes = yield* db
        .transaction((tx) =>
          Effect.all({
            updated: Effect.filter(Array.from(discovered.values()), (item) => ops.create(item, tx)).pipe(
              Effect.map((items) => items.map((item) => item.directory)),
            ),
            removed: Effect.filter(removed, (directory) => ops.remove(directory, tx)),
          }),
        )
        .pipe(Effect.orDie)
      yield* changed(changes.updated.length > 0 || changes.removed.length > 0)
      return changes
    })

    return Service.of({
      transform: state.transform,
      reload: state.reload,
      list: Effect.fn("Worktree.list")(function* () {
        yield* refresh()
        return yield* ops.list()
      }),
      create,
      remove,
      refresh,
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer: layer,
  deps: [FSUtil.node, Git.node, Bus.node, Database.node, AppProcess.node, Location.node, Global.node],
})

function operationError(strategy: StrategyID, operation: string, error: unknown) {
  if (
    error instanceof Git.WorktreeError ||
    error instanceof DirectoryUnavailableError ||
    error instanceof Worktree.OperationError
  )
    return error
  return new Worktree.OperationError({
    message: `Worktree strategy ${strategy} failed to ${operation}: ${error instanceof globalThis.Error ? error.message : String(error)}`,
  })
}
