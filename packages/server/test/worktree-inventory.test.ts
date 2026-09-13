import path from "node:path"
import { expect } from "bun:test"
import { Context, Effect, Layer, RcMap } from "effect"
import { HttpEffect, HttpRouter, HttpServer } from "effect/unstable/http"
import { Database } from "@opencode/core/database/database"
import { LocationServiceMap } from "@opencode/core/location-service-map"
import { ProjectTable } from "@opencode/core/project/sql"
import { WorktreeTable } from "@opencode/core/worktree/sql"
import { Project } from "@opencode/schema/project"
import { AbsolutePath } from "@opencode/schema/schema"
import { Global } from "@opencode/util/global"
import { OpenCode } from "@opencode/client"
import { tempGlobalLayer } from "../../core/test/fixture/global"
import { tmpdirScoped } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { createRoutes } from "../src/routes"

it.live("lists historical inventory without booting Locations or pruning missing directories", () =>
  Effect.gen(function* () {
    const tmp = yield* tmpdirScoped()
    const context = yield* Layer.build(
      createRoutes({ password: "secret", database: { path: ":memory:" }, models: { fetch: false } }, () => [], [
        Global.node.replace(tempGlobalLayer),
      ]).pipe(Layer.provide(HttpServer.layerServices)),
    )
    const db = Context.get(context, Database.Service).db
    const locations = Context.get(context, LocationServiceMap.Service)
    const handler = Context.get(context, HttpRouter.HttpRouter)
      .asHttpEffect()
      .pipe(HttpEffect.toWebHandlerWith(context))
    const api = OpenCode.make({
      baseUrl: "http://opencode.local",
      headers: {
        authorization: `Basic ${btoa("opencode:secret")}`,
        // A metadata endpoint must ignore placement even when a caller supplies it.
        "x-opencode-directory": encodeURIComponent(path.join(tmp.path, "missing-default")),
      },
      fetch: Object.assign((input: RequestInfo | URL, init?: RequestInit) => handler(new Request(input, init)), {
        preconnect: () => {},
      }),
    })
    expect(yield* Effect.promise(() => api.worktree.inventory())).toEqual([])
    const projects = Array.from({ length: 336 }, (_, index) => ({
      id: Project.ID.make(`inventory-${index.toString().padStart(3, "0")}`),
      worktree: AbsolutePath.make(path.join(tmp.path, "missing", String(index))),
      sandboxes: [],
      time_created: 1,
      time_updated: 1,
    }))
    yield* db.insert(ProjectTable).values(projects).run().pipe(Effect.orDie)
    const worktrees = projects.slice(1).flatMap((project) => [
      { project_id: project.id, directory: project.worktree, strategy: null, time_created: 1 },
      {
        project_id: project.id,
        directory: AbsolutePath.make(path.join(project.worktree, "feature")),
        strategy: "custom-strategy",
        time_created: 2,
      },
    ])
    yield* db.insert(WorktreeTable).values(worktrees).run().pipe(Effect.orDie)
    const expected = projects.map((project, index) => ({
      project: {
        id: project.id,
        canonical: project.worktree,
        sandboxes: [],
        time: { created: 1, updated: 1 },
      },
      worktrees:
        index === 0
          ? []
          : [
              { directory: path.join(project.worktree, "feature"), strategy: "custom-strategy" },
              { directory: project.worktree },
            ],
    }))
    expect(yield* Effect.promise(() => api.worktree.inventory())).toEqual(expected)
    expect(yield* Effect.promise(() => api.worktree.inventory())).toEqual(expected)
    expect(Array.from(yield* RcMap.keys(locations.rcMap))).toEqual([])
    expect(yield* db.select().from(WorktreeTable).all().pipe(Effect.orDie)).toHaveLength(worktrees.length)
    const unauthorized = yield* Effect.promise(() =>
      handler(new Request("http://opencode.local/api/worktree/inventory")),
    )
    expect(unauthorized.status).toBe(401)
  }),
)
