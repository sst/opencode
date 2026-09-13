export * as WorktreeInventory from "./inventory.js"

import { Context, Effect, Layer } from "effect"
import { asc, desc } from "drizzle-orm"
import { Worktree } from "@opencode/schema/worktree"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { Database } from "../database/database.js"
import { Project } from "../project.js"
import { WorktreeTable } from "./sql.js"

export interface Interface {
  readonly list: () => Effect.Effect<Worktree.Inventory>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/WorktreeInventory") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const database = yield* Database.Service
    const projects = yield* Project.Service

    return Service.of({
      // Inventory reads must not resolve paths, discover strategies, or acquire a Location.
      list: Effect.fn("WorktreeInventory.list")(function* () {
        const rows = yield* database.db
          .select()
          .from(WorktreeTable)
          .orderBy(desc(WorktreeTable.time_created), asc(WorktreeTable.directory))
          .all()
          .pipe(Effect.orDie)
        const grouped = Map.groupBy(rows, (row) => row.project_id)
        return (yield* projects.list()).map((project) => ({
          project,
          worktrees: (grouped.get(project.id) ?? []).map((row) => ({
            directory: row.directory,
            strategy: row.strategy ?? undefined,
          })),
        }))
      }),
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node, Project.node] })
