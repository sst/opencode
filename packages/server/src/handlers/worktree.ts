import { Git } from "@opencode/core/git"
import { Worktree } from "@opencode/core/worktree"
import { WorktreeInventory } from "@opencode/core/worktree/inventory"
import { Plugin } from "@opencode/core/plugin"
import { WorktreeError } from "@opencode/protocol/groups/worktree"
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiSchema } from "effect/unstable/httpapi"
import { Api } from "../api"

export const WorktreeHandler = HttpApiBuilder.group(Api, "server.worktree", (handlers) =>
  Effect.gen(function* () {
    const inventory = yield* WorktreeInventory.Service
    return handlers
      .handle("worktree.inventory", () => inventory.list())
      .handle("worktree.list", () => run((worktrees) => worktrees.list()))
      .handle("worktree.create", (ctx) => run((worktrees) => worktrees.create(ctx.payload)))
      .handle("worktree.remove", (ctx) =>
        run((worktrees) => worktrees.remove(ctx.payload)).pipe(Effect.as(HttpApiSchema.NoContent.make())),
      )
      .handle("worktree.refresh", () =>
        run((worktrees) => worktrees.refresh()).pipe(Effect.as(HttpApiSchema.NoContent.make())),
      )
  }),
)

function run<A>(action: (service: Worktree.Interface) => Effect.Effect<A, Worktree.Error>) {
  return Effect.gen(function* () {
    const plugins = yield* Plugin.Service
    const worktrees = yield* Worktree.Service
    yield* plugins.awaitActivation
    return yield* action(worktrees)
  }).pipe(badRequest)
}

function badRequest<A, R>(effect: Effect.Effect<A, Worktree.Error, R>) {
  return effect.pipe(
    Effect.mapError(
      (error) =>
        new WorktreeError({
          name: "WorktreeError",
          data: {
            message: message(error),
            forceRequired:
              error instanceof Git.WorktreeError || error instanceof Worktree.OperationError
                ? error.forceRequired
                : undefined,
          },
        }),
    ),
  )
}

function message(error: Worktree.Error) {
  if (error instanceof Worktree.SourceDirectoryNotFoundError)
    return error.directory
      ? `Worktree source not found: ${error.directory}`
      : `Worktree source not found for project: ${error.projectID}`
  if (error instanceof Worktree.DestinationExistsError) return `Worktree destination already exists: ${error.directory}`
  if (error instanceof Worktree.DirectoryUnavailableError) return `Worktree directory unavailable: ${error.directory}`
  if (error instanceof Worktree.InvalidDirectoryError) return `Invalid worktree directory: ${error.directory}`
  if (error instanceof Worktree.StrategyUnavailableError) return `Worktree strategy unavailable: ${error.strategy}`
  if (error instanceof Worktree.UnsupportedLocationError) return "Worktree operations only support local locations"
  return error.message
}
