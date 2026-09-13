import { describe, expect } from "bun:test"
import { $ } from "bun"
import fs from "fs/promises"
import path from "path"
import { and, eq, isNull } from "drizzle-orm"
import { Context, Effect, Exit, Fiber, Layer, Queue, Scope, Stream } from "effect"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { AbsolutePath } from "@opencode/core/schema"
import { Git } from "@opencode/core/git"
import { Database } from "@opencode/core/database/database"
import { Bus } from "@opencode/core/bus"
import { Project } from "@opencode/core/project"
import { ProjectTable } from "@opencode/core/project/sql"
import { Worktree } from "@opencode/core/worktree"
import { WorktreeDirectory } from "@opencode/core/worktree/directory"
import { WorktreeTable } from "@opencode/core/worktree/sql"
import { WorktreeGit } from "@opencode/core/worktree/git"
import { Location } from "@opencode/core/location"
import { Global } from "@opencode/util/global"
import { FSUtil } from "@opencode/util/fs-util"
import { Config } from "@opencode/core/config"
import { ConfigWorktreePlugin } from "@opencode/core/config/plugin/worktree"
import { ConfigNormalize } from "@opencode/core/config/normalize"
import { Document, Event, Info } from "@opencode/schema/config"
import { EventManifest } from "@opencode/schema/event-manifest"
import { Workspace } from "@opencode/schema/workspace"
import { host } from "./plugin/host"
import { initRepo } from "./fixture/git"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

class Fixture extends Context.Service<Fixture, Effect.Success<ReturnType<typeof makeFixture>>>()("WorktreeFixture") {}

const infrastructure = AppNodeBuilder.build(LayerNode.group([Project.node, Database.node, Bus.node]))
const it = testEffect(
  Layer.unwrap(
    Effect.gen(function* () {
      const input = yield* makeFixture()
      const database = yield* Database.Service
      const bus = yield* Bus.Service
      return Layer.mergeAll(
        Layer.succeed(Fixture, input),
        Config.testLayer(),
        worktreeLayer(input.sourceDirectory, input.projectID, database, bus, input.root.path),
      )
    }),
  ).pipe(Layer.provideMerge(infrastructure)),
)
const projectIt = it

function worktreeLayer(
  directory: AbsolutePath,
  projectID: Project.ID,
  database: Database.Interface,
  bus: Bus.Interface,
  data: string,
  workspaceID?: Workspace.ID,
) {
  return AppNodeBuilder.build(LayerNode.group([Worktree.node, Git.node, FSUtil.node, Location.node, Global.node]), [
    Database.node.replace(Layer.succeed(Database.Service, database)),
    Bus.node.replace(Layer.succeed(Bus.Service, bus)),
    Global.node.replace(Global.layerWith({ data })),
    Location.node.replace(
      Layer.succeed(
        Location.Service,
        Location.Service.of({
          directory,
          workspaceID,
          project: { id: projectID, directory, canonical: directory },
        }),
      ),
    ),
  ]).pipe(Layer.fresh)
}

function abs(input: string) {
  return AbsolutePath.make(input)
}

const gitWorktree = Worktree.StrategyID.make("git")

const setup = Effect.fnUntraced(function* () {
  return yield* Fixture
})

function makeFixture() {
  return Effect.gen(function* () {
    const root = yield* Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    )
    yield* Effect.promise(() => initRepo(root.path))
    const sourceDirectory = abs(yield* Effect.promise(() => fs.realpath(root.path)))
    const projectID = Project.ID.make("worktree-project")
    const { db } = yield* Database.Service
    yield* db
      .insert(ProjectTable)
      .values({ id: projectID, worktree: sourceDirectory, sandboxes: [], time_created: 1, time_updated: 1 })
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(WorktreeTable)
      .values({ project_id: projectID, directory: sourceDirectory })
      .run()
      .pipe(Effect.orDie)
    return { root, sourceDirectory, projectID, db }
  })
}

function stored(projectID: Project.ID) {
  return Database.Service.use(({ db }) =>
    db
      .select({ directory: WorktreeTable.directory, strategy: WorktreeTable.strategy })
      .from(WorktreeTable)
      .where(eq(WorktreeTable.project_id, projectID))
      .all()
      .pipe(
        Effect.orDie,
        Effect.map((rows) => rows.toSorted((a, b) => a.directory.localeCompare(b.directory))),
      ),
  )
}

describe("Worktree", () => {
  projectIt.live("tracks canonical and linked worktrees when a project resolves", () =>
    Effect.gen(function* () {
      const root = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
      )
      yield* Effect.promise(() => initRepo(root.path))
      const linked = `${root.path}-linked`
      yield* Effect.addFinalizer(() => Effect.promise(() => fs.rm(linked, { recursive: true, force: true })))
      yield* Effect.promise(() => $`git worktree add ${linked} -b linked-${Date.now()}`.cwd(root.path).quiet())
      const project = yield* Project.Service

      const resolved = yield* project.resolve(abs(linked))

      expect(yield* stored(resolved.id)).toEqual(
        [
          { directory: abs(yield* Effect.promise(() => fs.realpath(root.path))), strategy: null },
          { directory: abs(yield* Effect.promise(() => fs.realpath(linked))), strategy: "git" },
        ].toSorted((a, b) => a.directory.localeCompare(b.directory)),
      )
    }),
  )

  it.effect("accepts arbitrary non-empty strategy ids", () =>
    Effect.sync(() => {
      expect(String(Worktree.StrategyID.make("acme/snapshot"))).toBe("acme/snapshot")
      expect(() => Worktree.StrategyID.make("  acme/snapshot  ")).toThrow()
      expect(() => Worktree.StrategyID.make("   ")).toThrow()
    }),
  )

  it.effect("reports unavailable strategy ids", () =>
    Effect.gen(function* () {
      const input = yield* setup()
      const worktree = yield* Worktree.Service
      const unavailable = Worktree.StrategyID.make("acme/missing")
      const error = yield* worktree
        .create({
          strategy: unavailable,
          from: input.sourceDirectory,
          directory: abs(`${input.root.path}-missing-strategy`),
          name: "worktree",
        })
        .pipe(Effect.flip)
      expect(error).toBeInstanceOf(Worktree.StrategyUnavailableError)
      if (error instanceof Worktree.StrategyUnavailableError) expect(error.strategy).toBe(unavailable)
    }),
  )

  it.live("requires a tracked project worktree", () =>
    Effect.gen(function* () {
      const input = yield* setup()
      yield* input.db
        .delete(WorktreeTable)
        .where(eq(WorktreeTable.project_id, input.projectID))
        .run()
        .pipe(Effect.orDie)
      const worktree = yield* Worktree.Service

      const error = yield* worktree
        .create({
          strategy: gitWorktree,
          from: input.sourceDirectory,
          directory: abs(`${input.root.path}-missing-source`),
          name: "worktree",
        })
        .pipe(Effect.flip)

      expect(error).toBeInstanceOf(Worktree.SourceDirectoryNotFoundError)
      if (error instanceof Worktree.SourceDirectoryNotFoundError) expect(error.directory).toBe(input.sourceDirectory)
    }),
  )

  it.live("creates and removes a git worktree directory", () =>
    Effect.gen(function* () {
      const input = yield* setup()
      const worktree = yield* Worktree.Service
      const bus = yield* Bus.Service
      const temp = yield* Effect.promise(() => fs.realpath(path.dirname(input.root.path)))
      const parent = abs(path.join(temp, path.basename(input.root.path) + "-worktree-created"))
      const target = abs(path.join(parent, "worktree"))
      yield* Effect.addFinalizer(() => Effect.promise(() => fs.rm(parent, { recursive: true, force: true })))
      const fiber = yield* bus
        .subscribe(Worktree.Event.Updated)
        .pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
      yield* Effect.yieldNow

      const created = yield* worktree.create({
        strategy: gitWorktree,
        directory: parent,
        name: "worktree",
      })
      expect(created.directory).toBe(target)
      expect(yield* stored(input.projectID)).toEqual(
        [
          { directory: input.sourceDirectory, strategy: null },
          { directory: created.directory, strategy: "git" },
        ].toSorted((a, b) => a.directory.localeCompare(b.directory)),
      )
      expect((yield* Fiber.join(fiber))[0]?.data).toEqual({ projectID: input.projectID })

      yield* worktree.remove({ directory: created.directory, force: false })

      expect(yield* stored(input.projectID)).toEqual([{ directory: input.sourceDirectory, strategy: null }])
      expect(yield* Effect.promise(() => Bun.file(target).exists())).toBe(false)
    }),
  )

  it.live("defaults to the TUI worktree directory and suffixes duplicate names", () =>
    Effect.gen(function* () {
      const input = yield* setup()
      const worktree = yield* Worktree.Service
      const global = yield* Global.Service
      const parent = path.join(global.data, "worktree", "worktr")

      const created = yield* worktree.create({
        strategy: gitWorktree,
        from: input.sourceDirectory,
        name: "task",
      })
      const duplicate = yield* worktree.create({
        strategy: gitWorktree,
        from: input.sourceDirectory,
        name: "task",
      })

      expect(created.directory).toBe(abs(path.join(parent, "task")))
      expect(duplicate.directory).toBe(abs(path.join(parent, "task-2")))
      expect(yield* Effect.promise(() => Bun.file(path.join(created.directory, ".git")).exists())).toBe(true)
      yield* worktree.remove({ directory: created.directory, force: false })
      yield* worktree.remove({ directory: duplicate.directory, force: false })
    }),
  )

  it.live("runs the project setup script with worktree paths", () =>
    Effect.gen(function* () {
      const input = yield* setup()
      const worktree = yield* Worktree.Service
      const temp = yield* Effect.promise(() => fs.realpath(path.dirname(input.root.path)))
      const parent = abs(path.join(temp, path.basename(input.root.path) + "-worktree-setup"))
      yield* Effect.addFinalizer(() => Effect.promise(() => fs.rm(parent, { recursive: true, force: true })))
      yield* input.db
        .update(ProjectTable)
        .set({
          commands: {
            start:
              "bun -e \"await Bun.write('setup.json', JSON.stringify([process.env.OPENCODE_WORKTREE_BASE, process.env.OPENCODE_WORKTREE_PATH, process.cwd()]))\"",
          },
        })
        .where(eq(ProjectTable.id, input.projectID))
        .run()
        .pipe(Effect.orDie)
      const created = yield* worktree.create({
        strategy: gitWorktree,
        directory: parent,
        name: "worktree",
      })

      expect(yield* Effect.promise(() => Bun.file(path.join(created.directory, "setup.json")).json())).toEqual([
        input.sourceDirectory,
        created.directory,
        created.directory,
      ])
      yield* worktree.remove({ directory: created.directory, force: true })
    }),
  )

  projectIt.live("creates worktrees and runs setup from the selected clone", () =>
    Effect.gen(function* () {
      const root = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
      )
      const main = abs(path.join(root.path, "repo"))
      const clone = abs(path.join(root.path, "other-clone"))
      yield* Effect.promise(async () => {
        await fs.mkdir(main)
        await initRepo(main)
        await $`git remote add origin git@github.com:owner/repo.git`.cwd(main).quiet()
        await $`git clone --no-hardlinks ${main} ${clone}`.quiet()
        await $`git remote set-url origin https://github.com/owner/repo.git`.cwd(clone).quiet()
        await $`git -c user.name=Test -c user.email=test@opencode.test -c commit.gpgsign=false commit --allow-empty -m clone`
          .cwd(clone)
          .quiet()
      })
      const projects = yield* Project.Service
      const initial = yield* projects.resolve(main)
      const selected = yield* projects.resolve(clone)
      const database = yield* Database.Service
      const bus = yield* Bus.Service
      const context = yield* Layer.build(worktreeLayer(selected.directory, selected.id, database, bus, root.path))
      const worktrees = Context.get(context, Worktree.Service)
      const config = yield* Config.Test
      yield* config.setEntries([
        new Document({
          type: "document",
          path: abs(path.join(root.path, "global/opencode.json")),
          info: new Info({ worktree: { directory: ".lane/trees" } }),
        }),
      ])
      yield* ConfigWorktreePlugin.Plugin.effect(host()).pipe(Effect.provide(context))
      yield* projects.update({
        projectID: initial.id,
        commands: {
          start:
            "bun -e \"await Bun.write('setup.json', JSON.stringify([process.env.OPENCODE_WORKTREE_BASE, process.env.OPENCODE_WORKTREE_PATH, process.cwd()]))\"",
        },
      })

      const created = yield* worktrees.create({
        strategy: gitWorktree,
        from: selected.canonical,
        name: "selected-clone",
      })

      expect(selected.id).toBe(initial.id)
      expect(created.directory).toBe(abs(path.join(clone, ".lane/trees/selected-clone")))
      expect((yield* projects.list()).find((project) => project.id === initial.id)?.canonical).toBe(main)
      expect(yield* Effect.promise(() => $`git rev-parse HEAD`.cwd(created.directory).text())).toBe(
        yield* Effect.promise(() => $`git rev-parse HEAD`.cwd(clone).text()),
      )
      expect(yield* Effect.promise(() => Bun.file(path.join(created.directory, "setup.json")).json())).toEqual([
        clone,
        created.directory,
        created.directory,
      ])
    }),
  )

  it.live("creates a git worktree from a selected branch", () =>
    Effect.gen(function* () {
      const input = yield* setup()
      const worktree = yield* Worktree.Service
      const parent = abs(`${input.root.path}-branch-worktree`)
      yield* Effect.addFinalizer(() => Effect.promise(() => fs.rm(parent, { recursive: true, force: true })))
      yield* Effect.promise(async () => {
        await $`git branch feature-base`.cwd(input.sourceDirectory).quiet()
      })

      const created = yield* worktree.create({
        strategy: gitWorktree,
        branch: "feature-base",
        directory: parent,
        name: "worktree",
      })

      const head = (yield* Effect.promise(() => $`git rev-parse HEAD`.cwd(created.directory).quiet().text())).trim()
      const branch = (yield* Effect.promise(() =>
        $`git rev-parse feature-base`.cwd(input.sourceDirectory).quiet().text(),
      )).trim()
      expect(head).toBe(branch)
    }),
  )

  it.live("does not interpret a branch as a git option", () =>
    Effect.gen(function* () {
      const input = yield* setup()
      const worktree = yield* Worktree.Service
      const parent = abs(`${input.root.path}-option-worktree`)
      yield* Effect.addFinalizer(() => Effect.promise(() => fs.rm(parent, { recursive: true, force: true })))

      const error = yield* worktree
        .create({
          strategy: gitWorktree,
          branch: "--no-checkout",
          directory: parent,
          name: "worktree",
        })
        .pipe(Effect.flip)

      expect(error).toBeInstanceOf(Git.WorktreeError)
      expect(yield* Effect.promise(() => Bun.file(path.join(parent, "worktree")).exists())).toBe(false)
    }),
  )

  it.live("rejects a missing source directory", () =>
    Effect.gen(function* () {
      const input = yield* setup()
      const worktree = yield* Worktree.Service
      const temp = yield* Effect.promise(() => fs.realpath(path.dirname(input.root.path)))

      const error = yield* worktree
        .create({
          strategy: gitWorktree,
          from: abs(path.join(temp, "does-not-exist")),
          directory: abs(`${input.root.path}-missing-directory`),
          name: "worktree",
        })
        .pipe(Effect.flip)

      expect(error).toBeInstanceOf(WorktreeDirectory.DirectoryUnavailableError)
    }),
  )

  it.live("creates from another managed worktree", () =>
    Effect.gen(function* () {
      const input = yield* setup()
      const worktree = yield* Worktree.Service
      const temp = yield* Effect.promise(() => fs.realpath(path.dirname(input.root.path)))
      const sourceParent = abs(path.join(temp, path.basename(input.root.path) + "-managed-source"))
      const targetParent = abs(path.join(temp, path.basename(input.root.path) + "-managed-target"))
      yield* Effect.addFinalizer(() =>
        Effect.all([
          Effect.promise(() => fs.rm(sourceParent, { recursive: true, force: true })),
          Effect.promise(() => fs.rm(targetParent, { recursive: true, force: true })),
        ]).pipe(Effect.asVoid),
      )
      const source = yield* worktree.create({
        strategy: gitWorktree,
        from: input.sourceDirectory,
        directory: sourceParent,
        name: "source",
      })
      yield* input.db
        .delete(WorktreeTable)
        .where(and(eq(WorktreeTable.project_id, input.projectID), isNull(WorktreeTable.strategy)))
        .run()
        .pipe(Effect.orDie)

      const created = yield* worktree.create({
        strategy: gitWorktree,
        from: source.directory,
        directory: targetParent,
        name: "target",
      })

      expect(created.directory).toBe(abs(path.join(targetParent, "target")))
      yield* worktree.remove({ directory: created.directory, force: false })
      yield* worktree.remove({ directory: source.directory, force: false })
    }),
  )

  it.live("requires force to remove a dirty git worktree", () =>
    Effect.gen(function* () {
      const input = yield* setup()
      const worktree = yield* Worktree.Service
      const temp = yield* Effect.promise(() => fs.realpath(path.dirname(input.root.path)))
      const parent = abs(path.join(temp, path.basename(input.root.path) + "-worktree-dirty"))
      yield* Effect.addFinalizer(() => Effect.promise(() => fs.rm(parent, { recursive: true, force: true })))
      const created = yield* worktree.create({
        strategy: gitWorktree,
        from: input.sourceDirectory,
        directory: parent,
        name: "worktree",
      })
      yield* Effect.promise(() => Bun.write(path.join(created.directory, "dirty.txt"), "dirty"))

      const error = yield* worktree.remove({ directory: created.directory, force: false }).pipe(Effect.flip)

      expect(error).toBeInstanceOf(Git.WorktreeError)
      if (error instanceof Git.WorktreeError) {
        expect(error.operation).toBe("remove")
        expect(error.forceRequired).toBe(true)
      }
      expect(yield* stored(input.projectID)).toContainEqual({ directory: created.directory, strategy: "git" })
      expect(yield* Effect.promise(() => Bun.file(path.join(created.directory, "dirty.txt")).exists())).toBe(true)

      yield* worktree.remove({ directory: created.directory, force: true })
      expect(yield* Effect.promise(() => Bun.file(created.directory).exists())).toBe(false)
    }),
  )

  it.live("preserves worktrees whose stored strategy is unavailable", () =>
    Effect.gen(function* () {
      const input = yield* setup()
      const worktree = yield* Worktree.Service
      const unavailable = abs(`${input.root.path}-worktree-unavailable`)
      yield* Effect.promise(() => fs.mkdir(unavailable))
      yield* Effect.addFinalizer(() => Effect.promise(() => fs.rm(unavailable, { recursive: true, force: true })))
      yield* input.db
        .insert(WorktreeTable)
        .values({ project_id: input.projectID, directory: unavailable, strategy: "acme/missing" })
        .run()
        .pipe(Effect.orDie)

      const error = yield* worktree.remove({ directory: unavailable, force: false }).pipe(Effect.flip)

      expect(error).toBeInstanceOf(Worktree.StrategyUnavailableError)
      expect(yield* stored(input.projectID)).toContainEqual({ directory: unavailable, strategy: "acme/missing" })
    }),
  )

  it.live("adds a numeric suffix when a worktree directory already exists", () =>
    Effect.gen(function* () {
      const input = yield* setup()
      const worktree = yield* Worktree.Service
      const temp = yield* Effect.promise(() => fs.realpath(path.dirname(input.root.path)))
      const parent = abs(path.join(temp, path.basename(input.root.path) + "-worktree-suffix"))
      const target = abs(path.join(parent, "worktree-3"))
      yield* Effect.addFinalizer(() => Effect.promise(() => fs.rm(parent, { recursive: true, force: true })))
      yield* Effect.promise(() => fs.mkdir(path.join(parent, "worktree"), { recursive: true }))
      yield* Effect.promise(() => fs.mkdir(path.join(parent, "worktree-2")))

      const created = yield* worktree.create({
        strategy: gitWorktree,
        from: input.sourceDirectory,
        directory: parent,
        name: "worktree",
      })

      expect(created.directory).toBe(target)
      expect(
        yield* Effect.promise(() => fs.stat(path.join(parent, "worktree")).then((item) => item.isDirectory())),
      ).toBe(true)
      expect(
        yield* Effect.promise(() => fs.stat(path.join(parent, "worktree-2")).then((item) => item.isDirectory())),
      ).toBe(true)

      yield* worktree.remove({ directory: created.directory, force: false })
    }),
  )

  it.live("fails after ten worktree directory conflicts", () =>
    Effect.gen(function* () {
      const input = yield* setup()
      const worktree = yield* Worktree.Service
      const temp = yield* Effect.promise(() => fs.realpath(path.dirname(input.root.path)))
      const parent = abs(path.join(temp, path.basename(input.root.path) + "-worktree-conflicts"))
      yield* Effect.addFinalizer(() => Effect.promise(() => fs.rm(parent, { recursive: true, force: true })))
      yield* Effect.promise(() =>
        Promise.all(
          Array.from({ length: 10 }, (_, index) =>
            fs.mkdir(path.join(parent, index === 0 ? "worktree" : `worktree-${index + 1}`), { recursive: true }),
          ),
        ),
      )

      const error = yield* worktree
        .create({
          strategy: gitWorktree,
          from: input.sourceDirectory,
          directory: parent,
          name: "worktree",
        })
        .pipe(Effect.flip)

      expect(error).toBeInstanceOf(Worktree.DestinationExistsError)
      if (error instanceof Worktree.DestinationExistsError)
        expect(error.directory).toBe(abs(path.join(parent, "worktree-10")))
    }),
  )

  it.live("does not publish an event when refresh finds no directory changes", () =>
    Effect.gen(function* () {
      const worktree = yield* Worktree.Service
      const bus = yield* Bus.Service
      const event = yield* bus.subscribe(Worktree.Event.Updated).pipe(
        Stream.take(1),
        Stream.runCollect,
        Effect.forkScoped,
        Effect.flatMap((fiber) =>
          Effect.gen(function* () {
            yield* Effect.yieldNow
            yield* worktree.refresh()
            return yield* Fiber.join(fiber).pipe(Effect.timeoutOption("50 millis"))
          }),
        ),
      )

      expect(event._tag).toBe("None")
    }),
  )

  it.live("refresh discovers and prunes an externally managed git worktree", () =>
    Effect.gen(function* () {
      const input = yield* setup()
      const worktree = yield* Worktree.Service
      const bus = yield* Bus.Service
      const target = abs(`${input.root.path}-worktree-external`)
      const unchanged = abs(`${input.root.path}-worktree-existing`)
      yield* Effect.addFinalizer(() =>
        Effect.promise(() =>
          Promise.all([target, unchanged].map((item) => fs.rm(item, { recursive: true, force: true }))),
        ).pipe(Effect.asVoid),
      )
      yield* Effect.promise(() => $`git worktree add --detach ${target} HEAD`.cwd(input.root.path).quiet())
      yield* Effect.promise(() => $`git worktree add --detach ${unchanged} HEAD`.cwd(input.root.path).quiet())
      yield* input.db
        .insert(WorktreeTable)
        .values([
          { project_id: input.projectID, directory: target },
          { project_id: input.projectID, directory: unchanged, strategy: "git" },
        ])
        .run()
        .pipe(Effect.orDie)
      const fiber = yield* bus
        .subscribe(Worktree.Event.Updated)
        .pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
      yield* Effect.yieldNow

      const discovered = abs(yield* Effect.promise(() => fs.realpath(target)))
      const existing = abs(yield* Effect.promise(() => fs.realpath(unchanged)))
      expect(yield* worktree.refresh()).toEqual({ updated: [discovered], removed: [] })

      expect(yield* stored(input.projectID)).toEqual(
        [
          { directory: input.sourceDirectory, strategy: null },
          { directory: discovered, strategy: "git" },
          { directory: existing, strategy: "git" },
        ].toSorted((a, b) => a.directory.localeCompare(b.directory)),
      )
      expect((yield* Fiber.join(fiber))[0]?.data).toEqual({ projectID: input.projectID })

      yield* Effect.promise(() => $`git worktree remove --force ${target}`.cwd(input.root.path).quiet())
      yield* Effect.promise(() => $`git worktree remove --force ${unchanged}`.cwd(input.root.path).quiet())
      expect(yield* worktree.refresh()).toEqual({
        updated: [],
        removed: [discovered, existing].toSorted(),
      })
      expect(yield* stored(input.projectID)).toEqual([{ directory: input.sourceDirectory, strategy: null }])
    }),
  )

  it.live(
    "refresh ignores stale git worktree registrations",
    () =>
      Effect.gen(function* () {
        const input = yield* setup()
        const worktree = yield* Worktree.Service
        const stale = abs(`${input.root.path}-worktree-stale`)
        const target = abs(`${input.root.path}-worktree-after-stale`)
        yield* Effect.addFinalizer(() => Effect.promise(() => fs.rm(target, { recursive: true, force: true })))
        yield* Effect.promise(() => $`git worktree add --detach ${stale} HEAD`.cwd(input.root.path).quiet())
        yield* Effect.promise(() => fs.rm(stale, { recursive: true, force: true }))
        yield* Effect.promise(() => $`git worktree add --detach ${target} HEAD`.cwd(input.root.path).quiet())

        yield* worktree.refresh()

        const discovered = abs(yield* Effect.promise(() => fs.realpath(target)))
        expect(yield* stored(input.projectID)).toEqual(
          [
            { directory: input.sourceDirectory, strategy: null },
            { directory: discovered, strategy: "git" },
          ].toSorted((a, b) => a.directory.localeCompare(b.directory)),
        )
      }),
    15_000,
  )

  it.live("refresh ignores existing directories that are no longer git checkouts", () =>
    Effect.gen(function* () {
      const input = yield* setup()
      yield* Effect.promise(() => fs.rm(path.join(input.sourceDirectory, ".git"), { recursive: true }))
      const worktree = yield* Worktree.Service

      yield* worktree.refresh()

      expect(yield* stored(input.projectID)).toEqual([{ directory: input.sourceDirectory, strategy: null }])
    }),
  )

  it.live("refresh with no roots is a no-op", () =>
    Effect.gen(function* () {
      const input = yield* setup()
      yield* input.db
        .delete(WorktreeTable)
        .where(eq(WorktreeTable.project_id, input.projectID))
        .run()
        .pipe(Effect.orDie)
      const worktree = yield* Worktree.Service

      expect(yield* worktree.refresh()).toEqual({
        updated: [],
        removed: [],
      })
    }),
  )

  it.live("refresh removes missing ordinary checkouts", () =>
    Effect.gen(function* () {
      const input = yield* setup()
      const missing = abs(`${input.root.path}-missing-checkout`)
      yield* input.db
        .insert(WorktreeTable)
        .values({ project_id: input.projectID, directory: missing })
        .run()
        .pipe(Effect.orDie)
      const worktree = yield* Worktree.Service

      expect(yield* worktree.refresh()).toEqual({ updated: [], removed: [missing] })

      expect(yield* stored(input.projectID)).not.toContainEqual({ directory: missing, strategy: null })
    }),
  )

  it.live("defaults to Git and configured directory without depending on Config", () =>
    Effect.gen(function* () {
      const input = yield* setup()
      const worktrees = yield* Worktree.Service
      const parent = abs(path.join(input.root.path, "configured"))
      const registration = yield* worktrees.transform((editor) => editor.configure({ directory: parent }))
      const created = yield* worktrees.create({ name: "configured" })
      expect(created.directory).toBe(abs(path.join(parent, "configured")))
      expect(yield* worktrees.list()).toContainEqual({
        directory: created.directory,
        strategy: "git",
      })
      yield* registration.dispose
      const fallback = yield* worktrees.create({ name: "default" })
      expect(fallback.directory).toBe(
        abs(path.join(input.root.path, "worktree", input.projectID.slice(0, 6), "default")),
      )
    }),
  )

  it.live("selects the last active registration and restores earlier strategies on disposal", () =>
    Effect.gen(function* () {
      const input = yield* setup()
      const worktrees = yield* Worktree.Service
      const git = yield* WorktreeGit.make
      const parent = abs(path.join(input.root.path, "strategies"))
      const first = yield* worktrees.transform((editor) =>
        editor.add({ ...git, id: Worktree.StrategyID.make("first") }),
      )
      const scope = yield* Effect.acquireRelease(Scope.make(), (scope) => Scope.close(scope, Exit.void))
      const second = yield* worktrees
        .transform((editor) => editor.add({ ...git, id: Worktree.StrategyID.make("second") }))
        .pipe(Effect.provideService(Scope.Scope, scope))
      yield* worktrees.transform((editor) => editor.configure({ directory: parent }))
      const created = yield* worktrees.create({ name: "second" })
      expect(yield* stored(input.projectID)).toContainEqual({ directory: created.directory, strategy: "second" })
      yield* Scope.close(scope, Exit.void)
      yield* second.dispose
      const earlier = yield* worktrees.create({ name: "first" })
      expect(yield* stored(input.projectID)).toContainEqual({ directory: earlier.directory, strategy: "first" })
      yield* first.dispose
      const fallback = yield* worktrees.create({ name: "git" })
      expect(yield* stored(input.projectID)).toContainEqual({ directory: fallback.directory, strategy: "git" })
      const error = yield* worktrees.remove({ directory: created.directory, force: false }).pipe(Effect.flip)
      expect(error).toBeInstanceOf(Worktree.StrategyUnavailableError)
      yield* worktrees.refresh()
      expect(yield* stored(input.projectID)).toContainEqual({ directory: created.directory, strategy: "second" })
    }),
  )

  it.live("does not fall back to Git when a registered strategy fails", () =>
    Effect.gen(function* () {
      const input = yield* setup()
      const worktrees = yield* Worktree.Service
      const git = yield* WorktreeGit.make
      yield* worktrees.transform((editor) =>
        editor.add({
          ...git,
          id: Worktree.StrategyID.make("broken"),
          create: () => Effect.fail(new Error("backend failed")),
        }),
      )
      const parent = abs(path.join(input.root.path, "failures"))
      const error = yield* worktrees.create({ directory: parent, name: "failure" }).pipe(Effect.flip)
      expect(error).toBeInstanceOf(Worktree.OperationError)
      expect(yield* stored(input.projectID)).toEqual([{ directory: input.sourceDirectory, strategy: null }])
      const explicit = yield* worktrees.create({
        directory: parent,
        name: "explicit",
        strategy: gitWorktree,
      })
      expect(yield* stored(input.projectID)).toContainEqual({ directory: explicit.directory, strategy: "git" })
    }),
  )

  it.live("rejects a source override belonging to another project", () =>
    Effect.gen(function* () {
      const input = yield* setup()
      const worktrees = yield* Worktree.Service
      const projects = yield* Project.Service
      const other = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir()))
      yield* Effect.promise(() => initRepo(other.path))
      const resolved = yield* projects.resolve(abs(other.path))
      expect(resolved.id).not.toBe(input.projectID)
      const error = yield* worktrees.create({ from: abs(other.path), name: "nope" }).pipe(Effect.flip)
      expect(error).toBeInstanceOf(Worktree.SourceDirectoryNotFoundError)
      if (error instanceof Worktree.SourceDirectoryNotFoundError) expect(error.projectID).toBe(input.projectID)
    }),
  )

  it.live("cannot remove a worktree from another project through the current location", () =>
    Effect.gen(function* () {
      const worktrees = yield* Worktree.Service
      const projects = yield* Project.Service
      const other = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir()))
      yield* Effect.promise(() => initRepo(other.path))
      const linked = abs(path.join(other.path, "linked"))
      yield* Effect.promise(() => $`git worktree add --detach ${linked} HEAD`.cwd(other.path).quiet())
      const resolved = yield* projects.resolve(linked)
      const error = yield* worktrees.remove({ directory: linked, force: true }).pipe(Effect.flip)
      expect(error).toBeInstanceOf(Worktree.InvalidDirectoryError)
      expect(yield* stored(resolved.id)).toContainEqual({ directory: linked, strategy: "git" })
      expect(yield* Effect.promise(() => fs.stat(linked).then((item) => item.isDirectory()))).toBe(true)
    }),
  )

  it.live("rejects workspace-qualified locations before running worktree operations", () =>
    Effect.gen(function* () {
      const input = yield* setup()
      const database = yield* Database.Service
      const bus = yield* Bus.Service
      const fs = yield* FSUtil.Service
      const context = yield* Layer.build(
        worktreeLayer(
          input.sourceDirectory,
          input.projectID,
          database,
          bus,
          input.root.path,
          Workspace.ID.make("wrk_remote"),
        ),
      )
      const worktrees = Context.get(context, Worktree.Service)
      const directory = abs(path.join(input.root.path, "not-created"))
      const errors = yield* Effect.all([
        worktrees.list().pipe(Effect.flip),
        worktrees.create({ directory, name: "task" }).pipe(Effect.flip),
        worktrees.remove({ directory: input.sourceDirectory, force: true }).pipe(Effect.flip),
        worktrees.refresh().pipe(Effect.flip),
      ])
      for (const error of errors) expect(error).toBeInstanceOf(Worktree.UnsupportedLocationError)
      expect(yield* fs.existsSafe(directory)).toBe(false)
      expect(yield* fs.isDir(input.sourceDirectory)).toBe(true)
    }),
  )

  it.live("list invokes the location's strategies before returning inventory", () =>
    Effect.gen(function* () {
      const input = yield* setup()
      const worktrees = yield* Worktree.Service
      const git = yield* WorktreeGit.make
      const directory = abs(path.join(input.root.path, "discovered"))
      yield* Effect.promise(() => fs.mkdir(directory))
      const sources: AbsolutePath[] = []
      yield* worktrees.transform((editor) =>
        editor.add({
          ...git,
          id: Worktree.StrategyID.make("discovered-copy"),
          list: (sourceDirectory) =>
            Effect.sync(() => {
              sources.push(sourceDirectory)
              return [{ directory, type: "worktree" as const }]
            }),
        }),
      )
      expect(yield* worktrees.list()).toContainEqual({ directory, strategy: "discovered-copy" })
      expect(sources).toEqual([input.sourceDirectory])
      expect(yield* stored(input.projectID)).toContainEqual({ directory, strategy: "discovered-copy" })
      yield* Effect.promise(() => fs.rmdir(directory))
      expect(yield* worktrees.list()).not.toContainEqual({ directory, strategy: "discovered-copy" })
      expect(sources).toEqual([input.sourceDirectory, input.sourceDirectory])
    }),
  )

  it.live("list surfaces strategy discovery failures", () =>
    Effect.gen(function* () {
      const worktrees = yield* Worktree.Service
      const git = yield* WorktreeGit.make
      yield* worktrees.transform((editor) =>
        editor.add({
          ...git,
          id: Worktree.StrategyID.make("broken-discovery"),
          list: () => Effect.fail(new Error("Cannot enumerate worktrees")),
        }),
      )
      const error = yield* worktrees.list().pipe(Effect.flip)
      expect(error).toBeInstanceOf(Worktree.OperationError)
      if (error instanceof Worktree.OperationError) expect(error.message).toContain("Cannot enumerate worktrees")
    }),
  )

  it.live("applies directory config through the adapter and restores defaults after config removal", () =>
    Effect.gen(function* () {
      const input = yield* setup()
      const config = yield* Config.Test
      const worktrees = yield* Worktree.Service
      const bus = yield* Bus.Service
      const reloaded = yield* Queue.unbounded<void>()
      const documents = [
        new Document({
          type: "document",
          path: abs(path.join(input.root.path, "opencode.json")),
          info: new Info({ worktree: { directory: "outer" } }),
        }),
        new Document({
          type: "document",
          path: abs(path.join(input.root.path, "nested/opencode.json")),
          info: new Info({ worktree: { directory: "copies" } }),
        }),
      ]
      yield* config.setEntries(documents)
      const git = yield* WorktreeGit.make
      yield* worktrees.transform((editor) => editor.add({ ...git, id: Worktree.StrategyID.make("custom") }))
      yield* ConfigWorktreePlugin.Plugin.effect(
        host({ event: { subscribe: () => bus.subscribe().pipe(Stream.filter(EventManifest.isServer)) } }),
      ).pipe(
        Effect.provideService(Worktree.Service, {
          ...worktrees,
          reload: () => worktrees.reload().pipe(Effect.tap(() => Queue.offer(reloaded, undefined))),
        }),
      )
      const first = yield* worktrees.create({ name: "one" })
      expect(first.directory).toBe(abs(path.join(input.root.path, "copies/one")))
      expect(yield* stored(input.projectID)).toContainEqual({ directory: first.directory, strategy: "custom" })
      yield* config.setEntries(documents.slice(0, 1))
      yield* bus.publish(Event.Updated, {})
      yield* Queue.take(reloaded)
      const second = yield* worktrees.create({ name: "two" })
      expect(second.directory).toBe(abs(path.join(input.root.path, "outer/two")))
      yield* config.setEntries([])
      yield* bus.publish(Event.Updated, {})
      yield* Queue.take(reloaded)
      const third = yield* worktrees.create({ name: "three" })
      expect(third.directory).toBe(abs(path.join(input.root.path, "worktree", input.projectID.slice(0, 6), "three")))
    }),
  )
  ;["relative", "absolute", "home"].forEach((mode) => {
    it.live(`resolves ${mode} global directory config from a linked checkout's subdirectory`, () =>
      Effect.gen(function* () {
        const input = yield* setup()
        const config = yield* Config.Test
        const projects = yield* Project.Service
        const global = yield* Global.Service
        const worktrees = yield* Worktree.Service
        const linked = abs(path.join(input.root.path, "linked"))
        const nested = abs(path.join(linked, "src"))
        const home = abs(path.join(input.root.path, "home"))
        yield* Effect.promise(async () => {
          await $`git worktree add ${linked} -b linked`.cwd(input.sourceDirectory).quiet()
          await fs.mkdir(nested)
        })
        const project = yield* projects.resolve(nested)
        const directory =
          mode === "relative" ? ".lane/trees" : mode === "home" ? "~/copies" : path.join(home, "absolute")
        yield* config.setEntries([
          new Document({
            type: "document",
            path: abs(path.join(home, ".config/opencode/opencode.json")),
            info: new Info({ worktree: { directory } }),
          }),
        ])
        yield* ConfigWorktreePlugin.Plugin.effect(host()).pipe(
          Effect.provideService(Location.Service, { directory: nested, project }),
          Effect.provideService(Global.Service, { ...global, home }),
        )

        const created = yield* worktrees.create({ name: "task" })

        expect(project.directory).toBe(linked)
        expect(project.canonical).toBe(input.sourceDirectory)
        expect(created.directory).toBe(
          abs(
            mode === "relative"
              ? path.join(input.sourceDirectory, ".lane/trees/task")
              : path.join(home, mode === "home" ? "copies/task" : "absolute/task"),
          ),
        )
      }),
    )
  })

  it.effect("normalization retains worktree directory and rejects invalid configuration", () =>
    Effect.sync(() => {
      expect(ConfigNormalize.normalize({ worktree: { directory: "./copies" } })).toMatchObject({
        type: "normalized",
        encoded: { worktree: { directory: "./copies" } },
        diagnostics: [],
      })
      for (const worktree of [{ directory: " " }, { directory: 12 }, {}]) {
        const result = ConfigNormalize.normalize({ worktree })
        expect(result.diagnostics.length).toBeGreaterThan(0)
        if (result.type === "normalized") expect(result.encoded).not.toHaveProperty("worktree")
      }
    }),
  )
})
