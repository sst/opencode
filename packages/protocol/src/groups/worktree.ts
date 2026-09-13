import { Worktree } from "@opencode/schema/worktree"
import { Context, Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { LocationQuery, locationQueryOpenApi } from "./location.js"

const root = "/api/worktree"

export class WorktreeError extends Schema.Error<WorktreeError>("WorktreeError")(
  {
    name: Schema.Literal("WorktreeError"),
    data: Schema.Struct({
      message: Schema.String,
      forceRequired: Schema.optional(Schema.Boolean),
    }),
  },
  { httpApiStatus: 400 },
) {}

export const WorktreeGroup = HttpApiGroup.make("server.worktree")
  .add(
    HttpApiEndpoint.get("worktree.list", root, {
      query: LocationQuery,
      success: Worktree.List,
      error: WorktreeError,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.worktree.list",
          summary: "List worktrees",
          description:
            "Discover worktrees through the requested location's strategies and return its project's inventory.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("worktree.create", root, {
      query: LocationQuery,
      payload: Worktree.CreateInput,
      success: Worktree.Info,
      error: WorktreeError,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.worktree.create",
          summary: "Create worktree",
          description:
            "Create a local worktree using the location's registered strategy and directory defaults, then run the project's setup script.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.delete("worktree.remove", root, {
      query: LocationQuery,
      payload: Worktree.RemoveInput,
      success: HttpApiSchema.NoContent,
      error: WorktreeError,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.worktree.remove",
          summary: "Remove worktree",
          description: "Remove a managed worktree from the requested location's project using its recorded strategy.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("worktree.refresh", `${root}/refresh`, {
      query: LocationQuery,
      success: HttpApiSchema.NoContent,
      error: WorktreeError,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.worktree.refresh",
          summary: "Refresh worktrees",
          description: "Discover worktrees from the requested location and reconcile the shared project inventory.",
        }),
      ),
  )
  .annotateMerge(OpenApi.annotations({ title: "worktree", description: "Location-scoped worktree management routes." }))

export const makeWorktreeGroup = <LocationId extends HttpApiMiddleware.AnyId, LocationService>(
  locationMiddleware: Context.Key<LocationId, LocationService>,
) =>
  WorktreeGroup.middleware(locationMiddleware)
    // Group middleware applies only to endpoints already added. Inventory must never acquire a Location.
    .add(
      HttpApiEndpoint.get("worktree.inventory", `${root}/inventory`, {
        success: Worktree.Inventory,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "v2.worktree.inventory",
          summary: "List stored worktree inventory",
          description:
            "List all known projects with their stored worktrees. This metadata-only read does not check filesystem existence, discover worktrees, or activate locations and plugins. Use the location-scoped worktree routes for live discovery and operations.",
        }),
      ),
    )
