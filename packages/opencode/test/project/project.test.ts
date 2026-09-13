import { describe, expect } from "bun:test"
import { Project } from "@/project/project"
import { $ } from "bun"
import path from "path"
import { tmpdirScoped } from "../fixture/fixture"
import { GlobalBus } from "../../src/bus/global"
import { Database } from "@opencode-ai/core/database/database"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { WorkspaceTable } from "@opencode-ai/core/control-plane/workspace.sql"
import { eq } from "drizzle-orm"
import { Hash } from "@opencode-ai/core/util/hash"
import { SessionID } from "@/session/schema"
import { WorkspaceV2 } from "@opencode-ai/core/workspace"
import { Cause, Effect, Exit, Layer, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { ProjectV2 } from "@opencode-ai/core/project"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { testEffect } from "../lib/effect"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"

const encoder = new TextEncoder()

const projectTestNode = LayerNode.group([Project.node, Database.node, CrossSpawnSpawner.node])
const it = testEffect(AppNodeBuilder.build(projectTestNode))

function remoteProjectID(remote: string) {
  return ProjectV2.ID.make(Hash.fast(`git-remote:${remote}`))
}

/**
 * Creates a mock ChildProcessSpawner layer that intercepts git subcommands
 * matching `failArg` and returns exit code 128, while delegating everything
 * else to the real CrossSpawnSpawner.
 */
function mockGitFailure(failArg: string) {
  return Layer.effect(
    ChildProcessSpawner.ChildProcessSpawner,
    Effect.gen(function* () {
      const real = yield* ChildProcessSpawner.ChildProcessSpawner
      return ChildProcessSpawner.make(
        Effect.fnUntraced(function* (command) {
          const std = ChildProcess.isStandardCommand(command) ? command : undefined
          if (std?.command === "git" && std.args.some((a) => a === failArg)) {
            return ChildProcessSpawner.makeHandle({
              pid: ChildProcessSpawner.ProcessId(0),
              exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(128)),
              isRunning: Effect.succeed(false),
              kill: () => Effect.void,
              stdin: { [Symbol.for("effect/Sink/TypeId")]: Symbol.for("effect/Sink/TypeId") } as any,
              stdout: Stream.empty,
              stderr: Stream.make(encoder.encode("fatal: simulated failure\n")),
              all: Stream.empty,
              getInputFd: () => ({ [Symbol.for("effect/Sink/TypeId")]: Symbol.for("effect/Sink/TypeId") }) as any,
              getOutputFd: () => Stream.empty,
              unref: Effect.succeed(Effect.void),
            })
          }
          return yield* real.spawn(command)
        }),
      )
    }),
  ).pipe(Layer.provide(AppNodeBuilder.build(CrossSpawnSpawner.node)))
}

function projectLayerWithFailure(failArg: string) {
  return AppNodeBuilder.build(Project.node, [
    [ProjectV2.node, projectV2FailureLayer()],
    [CrossSpawnSpawner.node, mockGitFailure(failArg)],
  ])
}

function projectV2FailureLayer() {
  return Layer.succeed(
    ProjectV2.Service,
    ProjectV2.Service.of({
      directories: () => Effect.succeed([]),
      resolve: (input) =>
        Effect.succeed({
          id: ProjectV2.ID.global,
          directory: input,
          vcs: { type: "git" as const, store: input },
        }),
      commit: () => Effect.void,
    }),
  )
}

const failureIt = (failArg: string) =>
  testEffect(AppNodeBuilder.build(projectTestNode, [[Project.node, projectLayerWithFailure(failArg)]]))

const iconDiscoveryIt = testEffect(
  AppNodeBuilder.build(projectTestNode, [[RuntimeFlags.node, RuntimeFlags.layer({ experimentalIconDiscovery: true })]]),
)

function waitForProjectIcon(id: ProjectV2.ID, attempts = 50): Effect.Effect<Project.Info, never, Project.Service> {
  return Effect.gen(function* () {
    const project = yield* Project.Service
    const info = yield* project.get(id)
    if (info?.icon?.url) return info
    if (attempts <= 0) throw new Error(`Project icon was not discovered: ${id}`)
    yield* Effect.sleep("10 millis")
    return yield* waitForProjectIcon(id, attempts - 1)
  })
}

describe("Project.fromDirectory", () => {
  it.live("should handle git repository with no commits", () =>
    Effect.gen(function* () {
      const project = yield* Project.Service
      const tmp = yield* tmpdirScoped()
      yield* Effect.promise(() => $`git init`.cwd(tmp).quiet())

      const result = yield* project.fromDirectory(tmp)

      expect(result.project).toBeDefined()
      expect(result.project.id).toBe(ProjectV2.ID.global)
      expect(result.project.vcs).toBe("git")
      expect(result.project.worktree).toBe(tmp)

      const opencodeFile = path.join(tmp, ".git", "opencode")
      expect(yield* Effect.promise(() => Bun.file(opencodeFile).exists())).toBe(false)
    }),
  )

  it.live("should handle git repository with commits", () =>
    Effect.gen(function* () {
      const project = yield* Project.Service
      const tmp = yield* tmpdirScoped({ git: true })

      const result = yield* project.fromDirectory(tmp)

      expect(result.project).toBeDefined()
      expect(result.project.id).not.toBe(ProjectV2.ID.global)
      expect(result.project.vcs).toBe("git")
      expect(result.project.worktree).toBe(tmp)
    }),
  )

  it.live("returns global for non-git directory", () =>
    Effect.gen(function* () {
      const project = yield* Project.Service
      const tmp = yield* tmpdirScoped()
      const result = yield* project.fromDirectory(tmp)
      expect(result.project.id).toBe(ProjectV2.ID.global)
    }),
  )

  it.live("derives stable project ID from root commit", () =>
    Effect.gen(function* () {
      const project = yield* Project.Service
      const tmp = yield* tmpdirScoped({ git: true })
      const result = yield* project.fromDirectory(tmp)
      const next = yield* project.fromDirectory(tmp)
      expect(next.project.id).toBe(result.project.id)
    }),
  )

  it.live("replaces missing stored worktree with the opened directory", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const project = yield* Project.Service
      const tmp = yield* tmpdirScoped({ git: true })
      const result = yield* project.fromDirectory(tmp)

      yield* db
        .update(ProjectTable)
        .set({ worktree: AbsolutePath.make(path.join(tmp, "moved-away")) })
        .where(eq(ProjectTable.id, result.project.id))
        .run()
        .pipe(Effect.orDie)

      const next = yield* project.fromDirectory(tmp)

      expect(next.project.worktree).toBe(tmp)
      expect(
        (yield* db.select().from(ProjectTable).where(eq(ProjectTable.id, result.project.id)).get().pipe(Effect.orDie))
          ?.worktree,
      ).toBe(AbsolutePath.make(tmp))
    }),
  )

  it.live("keeps stored worktree when another clone exists on disk", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const project = yield* Project.Service
      const first = yield* tmpdirScoped({ git: true })
      yield* project.fromDirectory(first)
      const second = yield* tmpdirScoped()
      yield* Effect.promise(() => $`git clone ${first} ${second}`.quiet())

      const result = yield* project.fromDirectory(second)

      expect(result.project.worktree).toBe(first)
      expect(result.project.sandboxes).toContain(second)
      expect(
        (yield* db.select().from(ProjectTable).where(eq(ProjectTable.id, result.project.id)).get().pipe(Effect.orDie))
          ?.worktree,
      ).toBe(AbsolutePath.make(first))
    }),
  )

  it.live("prefers normalized origin remote over root commit", () =>
    Effect.gen(function* () {
      const project = yield* Project.Service
      const tmp = yield* tmpdirScoped({ git: true })
      yield* Effect.promise(() => $`git remote add origin git@github.com:Test-Org/Test-Repo.git`.cwd(tmp).quiet())

      const result = yield* project.fromDirectory(tmp)

      expect(result.project.id).toBe(remoteProjectID("github.com/Test-Org/Test-Repo"))
    }),
  )

  it.live("normalizes equivalent origin URL forms to the same project ID", () =>
    Effect.gen(function* () {
      const project = yield* Project.Service
      const ssh = yield* tmpdirScoped({ git: true })
      const https = yield* tmpdirScoped({ git: true })
      yield* Effect.promise(() => $`git remote add origin git@github.com:owner/repo.git`.cwd(ssh).quiet())
      yield* Effect.promise(() => $`git remote add origin https://github.com/owner/repo.git`.cwd(https).quiet())

      const result = yield* project.fromDirectory(ssh)
      const next = yield* project.fromDirectory(https)

      expect(result.project.id).toBe(remoteProjectID("github.com/owner/repo"))
      expect(next.project.id).toBe(result.project.id)
    }),
  )

  it.live("migrates cached root project data when origin becomes available", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const tmp = yield* tmpdirScoped({ git: true })
      const projects = yield* Project.Service
      const rootResult = yield* projects.fromDirectory(tmp)
      const rootProject = rootResult.project
      const remoteID = remoteProjectID("github.com/acme/app")
      const sessionID = crypto.randomUUID() as SessionID
      const workspaceID = WorkspaceV2.ID.ascending()

      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: rootProject.id,
          slug: sessionID,
          directory: tmp,
          title: "test",
          version: "0.0.0-test",
          time_created: Date.now(),
          time_updated: Date.now(),
        })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(WorkspaceTable)
        .values({ id: workspaceID, type: "local", name: "test", project_id: rootProject.id })
        .run()
        .pipe(Effect.orDie)
      yield* Effect.promise(() => $`git remote add origin git@github.com:acme/app.git`.cwd(tmp).quiet())

      const result = yield* projects.fromDirectory(tmp)

      expect(result.project.id).toBe(remoteID)
      expect(
        yield* db.select().from(ProjectTable).where(eq(ProjectTable.id, rootProject.id)).get().pipe(Effect.orDie),
      ).toBeUndefined()
      expect(
        (yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get().pipe(Effect.orDie))
          ?.project_id,
      ).toBe(remoteID)
      expect(
        (yield* db.select().from(WorkspaceTable).where(eq(WorkspaceTable.id, workspaceID)).get().pipe(Effect.orDie))
          ?.project_id,
      ).toBe(remoteID)
    }),
  )
})

describe("Project.fromDirectory git failure paths", () => {
  it.live("keeps vcs when rev-list exits non-zero (no commits)", () =>
    Effect.gen(function* () {
      const project = yield* Project.Service
      const tmp = yield* tmpdirScoped()
      yield* Effect.promise(() => $`git init`.cwd(tmp).quiet())

      // rev-list fails because HEAD doesn't exist yet: this is the natural scenario.
      const result = yield* project.fromDirectory(tmp)
      expect(result.project.vcs).toBe("git")
      expect(result.project.id).toBe(ProjectV2.ID.global)
      expect(result.project.worktree).toBe(tmp)
    }),
  )

  failureIt("--show-toplevel").live("handles show-toplevel failure gracefully", () =>
    Effect.gen(function* () {
      const project = yield* Project.Service
      const tmp = yield* tmpdirScoped({ git: true })

      const result = yield* project.fromDirectory(tmp)
      expect(result.project.worktree).toBe(tmp)
      expect(result.sandbox).toBe(tmp)
    }),
  )

  failureIt("--git-common-dir").live("handles git-common-dir failure gracefully", () =>
    Effect.gen(function* () {
      const project = yield* Project.Service
      const tmp = yield* tmpdirScoped({ git: true })

      const result = yield* project.fromDirectory(tmp)
      expect(result.project.worktree).toBe(tmp)
      expect(result.sandbox).toBe(tmp)
    }),
  )
})

describe("Project.fromDirectory with worktrees", () => {
  it.live("should set worktree to root when called from root", () =>
    Effect.gen(function* () {
      const project = yield* Project.Service
      const tmp = yield* tmpdirScoped({ git: true })

      const result = yield* project.fromDirectory(tmp)

      expect(result.project.worktree).toBe(tmp)
      expect(result.sandbox).toBe(tmp)
      expect(result.project.sandboxes).not.toContain(tmp)
    }),
  )

  it.live("tracks a linked worktree as the opened project directory", () =>
    Effect.gen(function* () {
      const project = yield* Project.Service
      const tmp = yield* tmpdirScoped({ git: true })

      const worktreePath = path.join(tmp, "..", path.basename(tmp) + "-worktree")
      yield* Effect.addFinalizer(() =>
        Effect.promise(() =>
          $`git worktree remove ${worktreePath}`
            .cwd(tmp)
            .quiet()
            .catch(() => {}),
        ),
      )
      yield* Effect.promise(() => $`git worktree add ${worktreePath} -b test-branch-${Date.now()}`.cwd(tmp).quiet())

      const result = yield* project.fromDirectory(worktreePath)

      expect(result.project.worktree).toBe(worktreePath)
      expect(result.sandbox).toBe(worktreePath)
      expect(result.project.sandboxes).not.toContain(worktreePath)
      expect(result.project.sandboxes).not.toContain(tmp)
    }),
  )

  it.live("worktree should share project ID with main repo", () =>
    Effect.gen(function* () {
      const project = yield* Project.Service
      const tmp = yield* tmpdirScoped({ git: true })

      const result = yield* project.fromDirectory(tmp)

      const worktreePath = path.join(tmp, "..", path.basename(tmp) + "-wt-shared")
      yield* Effect.addFinalizer(() =>
        Effect.promise(() =>
          $`git worktree remove ${worktreePath}`
            .cwd(tmp)
            .quiet()
            .catch(() => {}),
        ),
      )
      yield* Effect.promise(() => $`git worktree add ${worktreePath} -b shared-${Date.now()}`.cwd(tmp).quiet())

      const next = yield* project.fromDirectory(worktreePath)

      expect(next.project.id).toBe(result.project.id)

      const cache = path.join(tmp, ".git", "opencode")
      const exists = yield* Effect.promise(() => Bun.file(cache).exists())
      expect(exists).toBe(true)
    }),
  )

  it.live("separate clones of the same repo should share project ID", () =>
    Effect.gen(function* () {
      const project = yield* Project.Service
      const tmp = yield* tmpdirScoped({ git: true })

      // Create a bare remote, push, then clone into a second directory
      const bare = tmp + "-bare"
      const clone = tmp + "-clone"
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => $`rm -rf ${bare} ${clone}`.quiet().nothrow()).pipe(Effect.ignore),
      )
      yield* Effect.promise(() => $`git clone --bare ${tmp} ${bare}`.quiet())
      yield* Effect.promise(() => $`git clone ${bare} ${clone}`.quiet())

      const result = yield* project.fromDirectory(tmp)
      const next = yield* project.fromDirectory(clone)

      expect(next.project.id).toBe(result.project.id)
    }),
  )

  it.live("should accumulate multiple worktrees in sandboxes", () =>
    Effect.gen(function* () {
      const project = yield* Project.Service
      const tmp = yield* tmpdirScoped({ git: true })

      const worktree1 = path.join(tmp, "..", path.basename(tmp) + "-wt1")
      const worktree2 = path.join(tmp, "..", path.basename(tmp) + "-wt2")
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            $`git worktree remove ${worktree1}`
              .cwd(tmp)
              .quiet()
              .catch(() => {}),
          )
          yield* Effect.promise(() =>
            $`git worktree remove ${worktree2}`
              .cwd(tmp)
              .quiet()
              .catch(() => {}),
          )
        }),
      )
      yield* Effect.promise(() => $`git worktree add ${worktree1} -b branch-${Date.now()}`.cwd(tmp).quiet())
      yield* Effect.promise(() => $`git worktree add ${worktree2} -b branch-${Date.now() + 1}`.cwd(tmp).quiet())

      yield* project.fromDirectory(worktree1)
      const result = yield* project.fromDirectory(worktree2)

      expect(result.project.worktree).toBe(worktree1)
      expect(result.project.sandboxes).toContain(worktree2)
      expect(result.project.sandboxes).not.toContain(tmp)
    }),
  )
})

describe("Project.discover", () => {
  iconDiscoveryIt.live("discovers favicon from fromDirectory when enabled", () =>
    Effect.gen(function* () {
      const project = yield* Project.Service
      const tmp = yield* tmpdirScoped({ git: true })
      const pngData = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      yield* Effect.promise(() => Bun.write(path.join(tmp, "favicon.png"), pngData))

      const result = yield* project.fromDirectory(tmp)
      const updated = yield* waitForProjectIcon(result.project.id)

      expect(updated.icon?.url).toStartWith("data:")
      expect(updated.icon?.url).toContain("base64")
    }),
  )

  it.live("should discover favicon.png in root", () =>
    Effect.gen(function* () {
      const project = yield* Project.Service
      const tmp = yield* tmpdirScoped({ git: true })
      const result = yield* project.fromDirectory(tmp)

      const pngData = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      yield* Effect.promise(() => Bun.write(path.join(tmp, "favicon.png"), pngData))

      yield* project.discover(result.project)

      const updated = yield* project.get(result.project.id)
      expect(updated).toBeDefined()
      expect(updated!.icon).toBeDefined()
      expect(updated!.icon?.url).toStartWith("data:")
      expect(updated!.icon?.url).toContain("base64")
      expect(updated!.icon?.color).toBeUndefined()
    }),
  )

  it.live("should not discover non-image files", () =>
    Effect.gen(function* () {
      const project = yield* Project.Service
      const tmp = yield* tmpdirScoped({ git: true })
      const result = yield* project.fromDirectory(tmp)

      yield* Effect.promise(() => Bun.write(path.join(tmp, "favicon.txt"), "not an image"))

      yield* project.discover(result.project)

      const updated = yield* project.get(result.project.id)
      expect(updated).toBeDefined()
      expect(updated!.icon).toBeUndefined()
    }),
  )

  it.live("should not discover favicon when override is set", () =>
    Effect.gen(function* () {
      const project = yield* Project.Service
      const tmp = yield* tmpdirScoped({ git: true })
      const result = yield* project.fromDirectory(tmp)

      yield* project.update({
        projectID: result.project.id,
        icon: { override: "data:image/png;base64,override" },
      })

      const updatedProject = yield* project.get(result.project.id)
      if (!updatedProject) throw new Error("Project not found")

      const pngData = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      yield* Effect.promise(() => Bun.write(path.join(tmp, "favicon.png"), pngData))

      yield* project.discover(updatedProject)

      const updated = yield* project.get(result.project.id)
      expect(updated).toBeDefined()
      expect(updated!.icon?.override).toBe("data:image/png;base64,override")
      expect(updated!.icon?.url).toBeUndefined()
    }),
  )
})

describe("Project.update", () => {
  it.live("should update name", () =>
    Effect.gen(function* () {
      const project = yield* Project.Service
      const tmp = yield* tmpdirScoped({ git: true })
      const result = yield* project.fromDirectory(tmp)

      const updated = yield* project.update({
        projectID: result.project.id,
        name: "New Project Name",
      })

      expect(updated.name).toBe("New Project Name")

      const fromDb = yield* project.get(result.project.id)
      expect(fromDb?.name).toBe("New Project Name")
    }),
  )

  it.live("should update icon url", () =>
    Effect.gen(function* () {
      const project = yield* Project.Service
      const tmp = yield* tmpdirScoped({ git: true })
      const result = yield* project.fromDirectory(tmp)

      const updated = yield* project.update({
        projectID: result.project.id,
        icon: { url: "https://example.com/icon.png" },
      })

      expect(updated.icon?.url).toBe("https://example.com/icon.png")

      const fromDb = yield* project.get(result.project.id)
      expect(fromDb?.icon?.url).toBe("https://example.com/icon.png")
    }),
  )

  it.live("should update icon color", () =>
    Effect.gen(function* () {
      const project = yield* Project.Service
      const tmp = yield* tmpdirScoped({ git: true })
      const result = yield* project.fromDirectory(tmp)

      const updated = yield* project.update({
        projectID: result.project.id,
        icon: { color: "#ff0000" },
      })

      expect(updated.icon?.color).toBe("#ff0000")

      const fromDb = yield* project.get(result.project.id)
      expect(fromDb?.icon?.color).toBe("#ff0000")
    }),
  )

  it.live("should update icon override", () =>
    Effect.gen(function* () {
      const project = yield* Project.Service
      const tmp = yield* tmpdirScoped({ git: true })
      const result = yield* project.fromDirectory(tmp)

      const updated = yield* project.update({
        projectID: result.project.id,
        icon: { override: "data:image/png;base64,abc123" },
      })

      expect(updated.icon?.override).toBe("data:image/png;base64,abc123")

      const fromDb = yield* project.get(result.project.id)
      expect(fromDb?.icon?.override).toBe("data:image/png;base64,abc123")
    }),
  )

  it.live("should update commands", () =>
    Effect.gen(function* () {
      const project = yield* Project.Service
      const tmp = yield* tmpdirScoped({ git: true })
      const result = yield* project.fromDirectory(tmp)

      const updated = yield* project.update({
        projectID: result.project.id,
        commands: { start: "npm run dev" },
      })

      expect(updated.commands?.start).toBe("npm run dev")

      const fromDb = yield* project.get(result.project.id)
      expect(fromDb?.commands?.start).toBe("npm run dev")
    }),
  )

  it.live("should fail when project not found", () =>
    Effect.gen(function* () {
      const project = yield* Project.Service
      const exit = yield* project
        .update({ projectID: ProjectV2.ID.make("nonexistent-project-id"), name: "Should Fail" })
        .pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const error = Cause.squash(exit.cause)
        expect(error).toMatchObject({ _tag: "Project.NotFoundError", projectID: "nonexistent-project-id" })
      }
    }),
  )

  it.live("should emit GlobalBus event on update", () =>
    Effect.gen(function* () {
      const project = yield* Project.Service
      const tmp = yield* tmpdirScoped({ git: true })
      const result = yield* project.fromDirectory(tmp)

      let eventPayload: any = null
      const on = (data: any) => {
        eventPayload = data
      }
      GlobalBus.on("event", on)
      yield* Effect.addFinalizer(() => Effect.sync(() => GlobalBus.off("event", on)))

      yield* project.update({ projectID: result.project.id, name: "Updated Name" })

      expect(eventPayload).not.toBeNull()
      expect(eventPayload.payload.type).toBe("project.updated")
      expect(eventPayload.payload.properties.name).toBe("Updated Name")
    }),
  )

  it.live("should update multiple fields at once", () =>
    Effect.gen(function* () {
      const project = yield* Project.Service
      const tmp = yield* tmpdirScoped({ git: true })
      const result = yield* project.fromDirectory(tmp)

      const updated = yield* project.update({
        projectID: result.project.id,
        name: "Multi Update",
        icon: { url: "https://example.com/favicon.ico", override: "data:image/png;base64,abc123", color: "#00ff00" },
        commands: { start: "make start" },
      })

      expect(updated.name).toBe("Multi Update")
      expect(updated.icon?.url).toBe("https://example.com/favicon.ico")
      expect(updated.icon?.override).toBe("data:image/png;base64,abc123")
      expect(updated.icon?.color).toBe("#00ff00")
      expect(updated.commands?.start).toBe("make start")
    }),
  )
})

describe("Project.list and Project.get", () => {
  it.live("list returns all projects", () =>
    Effect.gen(function* () {
      const project = yield* Project.Service
      const tmp = yield* tmpdirScoped({ git: true })
      const result = yield* project.fromDirectory(tmp)

      const all = yield* project.list()
      expect(all.length).toBeGreaterThan(0)
      expect(all.find((p) => p.id === result.project.id)).toBeDefined()
    }),
  )

  it.live("get returns project by id", () =>
    Effect.gen(function* () {
      const project = yield* Project.Service
      const tmp = yield* tmpdirScoped({ git: true })
      const result = yield* project.fromDirectory(tmp)

      const found = yield* project.get(result.project.id)
      expect(found).toBeDefined()
      expect(found!.id).toBe(result.project.id)
    }),
  )

  it.live("get returns undefined for unknown id", () =>
    Effect.gen(function* () {
      const project = yield* Project.Service
      const found = yield* project.get(ProjectV2.ID.make("nonexistent"))
      expect(found).toBeUndefined()
    }),
  )
})

describe("Project.setInitialized", () => {
  it.live("sets time_initialized on project", () =>
    Effect.gen(function* () {
      const project = yield* Project.Service
      const tmp = yield* tmpdirScoped({ git: true })
      const result = yield* project.fromDirectory(tmp)

      expect(result.project.time.initialized).toBeUndefined()

      yield* project.setInitialized(result.project.id)

      const updated = yield* project.get(result.project.id)
      expect(updated?.time.initialized).toBeDefined()
    }),
  )
})

describe("Project.addSandbox and Project.removeSandbox", () => {
  it.live("addSandbox adds directory and removeSandbox removes it", () =>
    Effect.gen(function* () {
      const project = yield* Project.Service
      const tmp = yield* tmpdirScoped({ git: true })
      const result = yield* project.fromDirectory(tmp)
      const sandboxDir = path.join(tmp, "sandbox-test")

      yield* project.addSandbox(result.project.id, sandboxDir)

      let found = yield* project.get(result.project.id)
      expect(found?.sandboxes).toContain(sandboxDir)

      yield* project.removeSandbox(result.project.id, sandboxDir)

      found = yield* project.get(result.project.id)
      expect(found?.sandboxes).not.toContain(sandboxDir)
    }),
  )

  it.live("addSandbox emits GlobalBus event", () =>
    Effect.gen(function* () {
      const project = yield* Project.Service
      const tmp = yield* tmpdirScoped({ git: true })
      const result = yield* project.fromDirectory(tmp)
      const sandboxDir = path.join(tmp, "sandbox-event")

      const events: any[] = []
      const on = (evt: any) => events.push(evt)
      GlobalBus.on("event", on)
      yield* Effect.addFinalizer(() => Effect.sync(() => GlobalBus.off("event", on)))

      yield* project.addSandbox(result.project.id, sandboxDir)

      expect(events.some((e) => e.payload.type === Project.Event.Updated.type)).toBe(true)
    }),
  )
})

describe("Project.fromDirectory with bare repos", () => {
  it.live("worktree from bare repo should cache in bare repo, not parent", () =>
    Effect.gen(function* () {
      const project = yield* Project.Service
      const tmp = yield* tmpdirScoped({ git: true })

      const parentDir = path.dirname(tmp)
      const barePath = path.join(parentDir, `bare-${Date.now()}.git`)
      const worktreePath = path.join(parentDir, `worktree-${Date.now()}`)
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => $`rm -rf ${barePath} ${worktreePath}`.quiet().nothrow()).pipe(Effect.ignore),
      )

      yield* Effect.promise(() => $`git clone --bare ${tmp} ${barePath}`.quiet())
      yield* Effect.promise(() => $`git worktree add ${worktreePath} HEAD`.cwd(barePath).quiet())

      const result = yield* project.fromDirectory(worktreePath)

      expect(result.project.id).not.toBe(ProjectV2.ID.global)
      expect(result.project.worktree).toBe(worktreePath)

      const correctCache = path.join(barePath, "opencode")
      const wrongCache = path.join(parentDir, ".git", "opencode")

      expect(yield* Effect.promise(() => Bun.file(correctCache).exists())).toBe(true)
      expect(yield* Effect.promise(() => Bun.file(wrongCache).exists())).toBe(false)
    }),
  )

  it.live("different bare repos under same parent should not share project ID", () =>
    Effect.gen(function* () {
      const project = yield* Project.Service
      const tmp1 = yield* tmpdirScoped({ git: true })
      const tmp2 = yield* tmpdirScoped({ git: true })

      const parentDir = path.dirname(tmp1)
      const bareA = path.join(parentDir, `bare-a-${Date.now()}.git`)
      const bareB = path.join(parentDir, `bare-b-${Date.now()}.git`)
      const worktreeA = path.join(parentDir, `wt-a-${Date.now()}`)
      const worktreeB = path.join(parentDir, `wt-b-${Date.now()}`)
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => $`rm -rf ${bareA} ${bareB} ${worktreeA} ${worktreeB}`.quiet().nothrow()).pipe(
          Effect.ignore,
        ),
      )

      yield* Effect.promise(() => $`git clone --bare ${tmp1} ${bareA}`.quiet())
      yield* Effect.promise(() => $`git clone --bare ${tmp2} ${bareB}`.quiet())
      yield* Effect.promise(() => $`git worktree add ${worktreeA} HEAD`.cwd(bareA).quiet())
      yield* Effect.promise(() => $`git worktree add ${worktreeB} HEAD`.cwd(bareB).quiet())

      const result = yield* project.fromDirectory(worktreeA)
      const next = yield* project.fromDirectory(worktreeB)

      expect(result.project.id).not.toBe(next.project.id)

      const cacheA = path.join(bareA, "opencode")
      const cacheB = path.join(bareB, "opencode")
      const wrongCache = path.join(parentDir, ".git", "opencode")

      expect(yield* Effect.promise(() => Bun.file(cacheA).exists())).toBe(true)
      expect(yield* Effect.promise(() => Bun.file(cacheB).exists())).toBe(true)
      expect(yield* Effect.promise(() => Bun.file(wrongCache).exists())).toBe(false)
    }),
  )

  it.live("bare repo without .git suffix is still detected via core.bare", () =>
    Effect.gen(function* () {
      const project = yield* Project.Service
      const tmp = yield* tmpdirScoped({ git: true })

      const parentDir = path.dirname(tmp)
      const barePath = path.join(parentDir, `bare-no-suffix-${Date.now()}`)
      const worktreePath = path.join(parentDir, `worktree-${Date.now()}`)
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => $`rm -rf ${barePath} ${worktreePath}`.quiet().nothrow()).pipe(Effect.ignore),
      )

      yield* Effect.promise(() => $`git clone --bare ${tmp} ${barePath}`.quiet())
      yield* Effect.promise(() => $`git worktree add ${worktreePath} HEAD`.cwd(barePath).quiet())

      const result = yield* project.fromDirectory(worktreePath)

      expect(result.project.id).not.toBe(ProjectV2.ID.global)
      expect(result.project.worktree).toBe(worktreePath)

      const correctCache = path.join(barePath, "opencode")
      expect(yield* Effect.promise(() => Bun.file(correctCache).exists())).toBe(true)
    }),
  )
})
