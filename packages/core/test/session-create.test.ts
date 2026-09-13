import { describe, expect } from "bun:test"
import { $ } from "bun"
import fs from "fs/promises"
import path from "path"
import { DateTime, Effect, Layer, Stream } from "effect"
import { TestClock } from "effect/testing"
import { Money } from "@opencode/schema/money"
import { Shell } from "@opencode/schema/shell"
import { Skill } from "@opencode/schema/skill"
import { Agent } from "@opencode/core/agent"
import { asc, eq } from "drizzle-orm"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Hash } from "@opencode/util/hash"
import { Bus } from "@opencode/core/bus"
import { EventTable } from "@opencode/core/event/sql"
import { Instructions } from "@opencode/core/instructions/index"
import { Location } from "@opencode/core/location"
import { Model } from "@opencode/core/model"
import { Project } from "@opencode/core/project"
import { ProjectTable } from "@opencode/core/project/sql"
import { Provider } from "@opencode/core/provider"
import { AbsolutePath, RelativePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionMessage } from "@opencode/core/session/message"
import { SessionProjector } from "@opencode/core/session/projector"
import { SessionExecution } from "@opencode/core/session/execution"
import { SessionInbox } from "@opencode/core/session/inbox"
import { InstructionEntry } from "@opencode/core/session/instruction-entry"
import { SessionEvent } from "@opencode/core/session/event"
import { SessionTable } from "@opencode/core/session/sql"
import { SessionStore } from "@opencode/core/session/store"
import { SessionTransfer } from "@opencode/core/session/transfer"
import { Workspace } from "@opencode/core/workspace"
import { Expected } from "./lib/session-message"
import { testEffect } from "./lib/effect"
import { LocationServiceMap } from "@opencode/core/location-service-map"
import { offlineModels } from "./fixture/models"
import { promptLocationNode } from "./fixture/prompt-location"
import { globalProjectNode } from "./lib/project"
import { tmpdirScoped } from "./fixture/tmpdir"
import { Plugin } from "@opencode/plugin"
import { PluginPromise } from "@opencode/core/plugin/promise"
import { host } from "./plugin/host"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      Bus.node,
      SessionProjector.node,
      SessionStore.node,
      Session.node,
      SessionTransfer.node,
      InstructionEntry.node,
    ]),
    [
      Bus.node.replace(Bus.configured({ persist: true })),
      Project.node.replace(globalProjectNode),
      LocationServiceMap.node.replace(promptLocationNode),
      SessionExecution.node.replace(SessionExecution.noopLayer),
    ],
  ),
)
const liveIt = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, Bus.node, Project.node, SessionProjector.node, SessionStore.node, Session.node]),
    [
      Bus.node.replace(Bus.configured({ persist: true })),
      SessionExecution.node.replace(SessionExecution.noopLayer),
      offlineModels,
    ],
  ),
)
const projectIt = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, Bus.node, Project.node, SessionProjector.node, SessionStore.node, Session.node]),
    [
      Bus.node.replace(Bus.configured({ persist: true })),
      // Project adoption needs plain-prompt admission, not live plugin/provider startup.
      LocationServiceMap.node.replace(promptLocationNode),
      SessionExecution.node.replace(SessionExecution.noopLayer),
    ],
  ),
)
const location = Location.Ref.make({ directory: AbsolutePath.make("/project") })
const id = Session.ID.create()

/** Public session events from a `log` read, without synced markers. */
const logEvents = (session: Session.Interface, sessionID: Session.ID, follow?: boolean) =>
  session
    .log({ sessionID, follow })
    .pipe(Stream.filter((item): item is SessionEvent.DurableEvent => !Bus.isSynced(item)))

const assertCreateInputTypes = (session: Session.Interface) => {
  // @ts-expect-error location or parentID is required.
  session.create({})
  // @ts-expect-error child sessions inherit their parent's location.
  session.create({ parentID: Session.ID.create(), location })
}
void assertCreateInputTypes

function withTmp<A, E, R>(f: (directory: string) => Effect.Effect<A, E, R>) {
  return tmpdirScoped().pipe(Effect.flatMap((tmp) => f(tmp.path)))
}

describe("Session.create", () => {
  liveIt.live("preserves the project canonical directory when creating a session in another clone", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        const main = AbsolutePath.make(path.join(directory, "repo"))
        const clone = AbsolutePath.make(path.join(directory, "other-clone"))
        yield* Effect.promise(async () => {
          await $`git init -q ${main}`.cwd(directory)
          await $`git -c user.name=Test -c user.email=test@opencode.test -c commit.gpgsign=false commit --allow-empty -qm root`
            .cwd(main)
            .quiet()
          await $`git remote add origin git@github.com:owner/repo.git`.cwd(main)
          await $`git clone --no-hardlinks ${main} ${clone}`.quiet()
          await $`git remote set-url origin https://github.com/owner/repo.git`.cwd(clone)
        })
        const sessions = yield* Session.Service
        const projects = yield* Project.Service
        const first = yield* sessions.create({ location: Location.Ref.make({ directory: main }) })
        const second = yield* sessions.create({ location: Location.Ref.make({ directory: clone }) })

        expect(second.projectID).toBe(first.projectID)
        expect((yield* projects.list()).find((project) => project.id === first.projectID)?.canonical).toBe(main)
        expect((yield* sessions.get(first.id)).location.directory).toBe(main)
        expect((yield* sessions.get(second.id)).location.directory).toBe(clone)
      }),
    ),
  )

  projectIt.live("follows the directory's project identity established after creation", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        const session = yield* Session.Service
        const projects = yield* Project.Service
        const { db } = yield* Database.Service
        const ref = Location.Ref.make({ directory: AbsolutePath.make(directory) })
        const nested = Location.Ref.make({ directory: AbsolutePath.make(path.join(directory, "packages", "app")) })
        const aliased = Location.Ref.make({
          directory: AbsolutePath.make([path.join(directory, "alias"), "..", "packages", "app"].join(path.sep)),
        })
        const created = yield* session.create({ location: ref, title: "Before git" })
        const child = yield* session.create({ location: nested, title: "Nested before git" })
        const alias = yield* session.create({ location: aliased, title: "Aliased before git" })
        const bus = yield* Bus.Service
        const store = yield* SessionStore.Service
        yield* session.prompt({ sessionID: created.id, text: "Preserved history", resume: false })
        yield* SessionInbox.promote(db, bus, created.id, "steer")
        const pending = yield* session.prompt({ sessionID: created.id, text: "Preserved inbox", resume: false })
        yield* store.claim(created.id)
        const before = yield* db
          .select()
          .from(SessionTable)
          .where(eq(SessionTable.id, created.id))
          .get()
          .pipe(Effect.orDie)
        if (!before) return yield* Effect.die(new Error("created session not found"))

        yield* Effect.promise(async () => {
          await $`git init -q`.cwd(directory)
          await $`git config user.email test@example.com`.cwd(directory)
          await $`git config user.name Test`.cwd(directory)
        })
        const unborn = yield* projects.resolve(ref.directory)
        const unbornRoot = yield* session.get(created.id)
        const unbornNested = yield* session.get(child.id)
        const unbornAlias = yield* session.get(alias.id)

        yield* Effect.promise(async () => {
          await fs.writeFile(path.join(directory, "README.md"), "test\n")
          await $`git add README.md`.cwd(directory)
          await $`git commit -qm initial`.cwd(directory)
          await $`git remote add origin git@github.com:owner/adopted.git`.cwd(directory)
        })

        const project = yield* projects.resolve(ref.directory)
        const repeat = yield* projects.resolve(ref.directory)
        const adopted = yield* session.get(created.id)
        const nestedAdopted = yield* session.get(child.id)
        const aliasAdopted = yield* session.get(alias.id)
        const page = yield* session.list({ project: project.id })
        const log = Array.from(yield* Stream.runCollect(logEvents(session, created.id)))

        expect(created.projectID).not.toBe(Project.ID.global)
        expect(child.projectID).not.toBe(created.projectID)
        expect(alias.projectID).toBe(child.projectID)
        expect(unborn.id).toBe(Project.ID.global)
        expect(unbornRoot).toMatchObject({ projectID: Project.ID.global, subpath: undefined })
        expect(unbornNested).toMatchObject({ projectID: Project.ID.global, subpath: "packages/app" })
        expect(unbornAlias).toMatchObject({ projectID: Project.ID.global, subpath: "packages/app" })
        expect(
          yield* db
            .select({ data: EventTable.data })
            .from(EventTable)
            .where(eq(EventTable.aggregate_id, Project.ID.global))
            .get()
            .pipe(Effect.orDie),
        ).toMatchObject({ data: { adopted: expect.arrayContaining([created.projectID, child.projectID]) } })
        expect(project.id).toBe(Project.ID.make(Hash.fast("git-remote:github.com/owner/adopted")))
        expect(repeat.id).toBe(project.id)
        expect(page.data.map((item) => item.id)).toEqual(expect.arrayContaining([created.id, child.id]))
        expect(adopted).toMatchObject({
          projectID: project.id,
          location: ref,
          subpath: undefined,
          time: { updated: DateTime.makeUnsafe(before.time_updated) },
        })
        expect(nestedAdopted).toMatchObject({
          projectID: project.id,
          location: nested,
          subpath: RelativePath.make("packages/app"),
        })
        expect(aliasAdopted).toMatchObject({
          projectID: project.id,
          location: aliased,
          subpath: RelativePath.make("packages/app"),
        })
        // Adoption is a project-domain fact; the session log records nothing new.
        expect(log.map((event) => event.type)).toEqual([
          "session.created",
          "session.inbox.enqueued",
          "session.inbox.delivered",
          "session.inbox.enqueued",
        ])
        expect(yield* session.messages({ sessionID: created.id })).toMatchObject([
          { id: expect.any(String), ...Expected.user("Preserved history") },
        ])
        expect(yield* SessionInbox.find(db, pending.id)).toMatchObject({ payload: { text: "Preserved inbox" } })
        expect(
          yield* db.select().from(SessionTable).where(eq(SessionTable.id, created.id)).get().pipe(Effect.orDie),
        ).toMatchObject({
          time_created: before.time_created,
          time_updated: before.time_updated,
          time_suspended: before.time_suspended,
          resume_attempts: before.resume_attempts,
        })
        // Repeated resolution announces the directory's identity exactly once.
        const announced = yield* db
          .select({ type: EventTable.type })
          .from(EventTable)
          .where(eq(EventTable.aggregate_id, project.id))
          .all()
          .pipe(Effect.orDie)
        expect(announced.map((event) => event.type)).toEqual(["worktree.resolved.1"])
      }),
    ),
  )

  liveIt.live("does not adopt nested repositories or sessions in another workspace", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        const session = yield* Session.Service
        const projects = yield* Project.Service
        const outer = path.join(directory, "outer")
        const nested = path.join(outer, "nested")
        const child = AbsolutePath.make(path.join(nested, "app"))
        yield* Effect.promise(() => fs.mkdir(child, { recursive: true }))

        const local = yield* session.create({ location: Location.Ref.make({ directory: AbsolutePath.make(outer) }) })
        const inside = yield* session.create({ location: Location.Ref.make({ directory: child }) })
        const remote = yield* session.create({
          location: Location.Ref.make({
            directory: AbsolutePath.make(outer),
            workspaceID: Workspace.ID.make("wrk_remote"),
          }),
        })

        yield* Effect.promise(async () => {
          for (const root of [nested, outer]) {
            await $`git init -q`.cwd(root)
            await $`git config user.email test@example.com`.cwd(root)
            await $`git config user.name Test`.cwd(root)
            await $`git commit --allow-empty -qm initial`.cwd(root)
          }
        })

        const parent = yield* projects.resolve(AbsolutePath.make(outer))
        expect((yield* session.get(local.id)).projectID).toBe(parent.id)
        expect((yield* session.get(inside.id)).projectID).toBe(inside.projectID)
        expect((yield* session.get(remote.id)).projectID).toBe(remote.projectID)

        const repository = yield* projects.resolve(AbsolutePath.make(nested))
        expect((yield* session.get(inside.id)).projectID).toBe(repository.id)
        expect((yield* session.get(remote.id)).projectID).toBe(remote.projectID)
      }),
    ),
  )

  it.effect("persists a missing title until one is generated or supplied", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const { db } = yield* Database.Service

      const created = yield* session.create({ location })
      const row = yield* db.select().from(SessionTable).where(eq(SessionTable.id, created.id)).get().pipe(Effect.orDie)
      const event = yield* db
        .select({ data: EventTable.data })
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, created.id))
        .get()
        .pipe(Effect.orDie)

      expect(created.title).toBeUndefined()
      expect(row?.title).toBeNull()
      expect(event?.data).not.toHaveProperty("title")
      expect((yield* session.create({ location, title: "Explicit title" })).title).toBe("Explicit title")
    }),
  )

  it.effect("creates a fresh projected session when the ID is omitted", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service

      const first = yield* session.create({ location })
      const second = yield* session.create({ location })

      expect(second.id).not.toBe(first.id)
      expect((yield* session.list()).data).toHaveLength(2)
    }),
  )

  it.effect("returns the original session when the ID is retried", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const input = { id, location }

      const first = yield* session.create(input)
      const retried = yield* session.create(input)

      expect(retried).toEqual(first)
      expect((yield* session.list()).data).toEqual([first])
    }),
  )

  it.effect("stores supplied immutable create attributes", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const workspaceID = Workspace.ID.make("wrk_test")
      const model = Model.Ref.make({
        id: Model.ID.make("sonnet"),
        providerID: Provider.ID.anthropic,
        variant: Model.VariantID.make("fast"),
      })

      expect(
        yield* session.create({
          location: Location.Ref.make({ directory: location.directory, workspaceID }),
          agent: Agent.ID.make("build"),
          model,
        }),
      ).toMatchObject({ location: { directory: location.directory, workspaceID }, agent: "build", model })
    }),
  )

  it.effect("stores creation metadata and inherits it through children and forks", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const bus = yield* Bus.Service
      const { db } = yield* Database.Service
      const metadata = { thread: "C123/1699999999.123", labels: ["support", 2] }

      const created = yield* session.create({ location, metadata })
      expect(created.metadata).toEqual(metadata)
      // The annotations are a durable creation fact, not just projected state.
      expect(
        yield* db
          .select({ data: EventTable.data })
          .from(EventTable)
          .where(eq(EventTable.aggregate_id, created.id))
          .get()
          .pipe(Effect.orDie),
      ).toMatchObject({ data: { metadata } })

      const inherited = yield* session.create({ parentID: created.id })
      expect(inherited.metadata).toEqual(metadata)
      const overridden = yield* session.create({ parentID: created.id, metadata: { thread: "other" } })
      expect(overridden.metadata).toEqual({ thread: "other" })

      yield* session.prompt({ sessionID: created.id, text: "Fork context", resume: false })
      yield* SessionInbox.promote(db, bus, created.id, "steer")
      const forked = yield* session.fork({ sessionID: created.id, boundary: { type: "through" } })
      expect(forked.metadata).toEqual(metadata)

      // Absent stays absent: no empty-object normalization.
      expect((yield* session.create({ location })).metadata).toBeUndefined()
    }),
  )

  it.effect("stores permission rules, inherits them through children and forks, and replaces them", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const bus = yield* Bus.Service
      const { db } = yield* Database.Service
      const permissions = [{ action: "edit", resource: "/original/**", effect: "deny" as const }]

      const created = yield* session.create({ location, permissions })
      expect(created.permissions).toEqual(permissions)
      expect((yield* session.create({ parentID: created.id })).permissions).toEqual(permissions)
      expect((yield* session.create({ parentID: created.id, permissions: [] })).permissions).toEqual([])

      yield* session.prompt({ sessionID: created.id, text: "Fork context", resume: false })
      yield* SessionInbox.promote(db, bus, created.id, "steer")
      const forked = yield* session.fork({ sessionID: created.id, boundary: { type: "through" } })
      expect(forked.permissions).toEqual(permissions)

      const replaced = [{ action: "shell", resource: "*", effect: "ask" as const }]
      yield* session.setPermissions({ sessionID: created.id, permissions: replaced })
      expect((yield* session.get(created.id)).permissions).toEqual(replaced)
      expect(
        yield* session.setPermissions({ sessionID: Session.ID.create(), permissions: replaced }).pipe(Effect.flip),
      ).toBeInstanceOf(Session.NotFoundError)
    }),
  )

  it.effect("inherits location from an existing parent when omitted", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const parent = yield* session.create({ location })
      const child = yield* session.create({ parentID: parent.id, title: "child" })

      expect(child).toMatchObject({ parentID: parent.id, location })
    }),
  )

  it.effect("rejects child creation when the parent does not exist", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const missing = Session.ID.create()

      expect(yield* Effect.flip(session.create({ parentID: missing, title: "child" }))).toEqual(
        new Session.NotFoundError({ sessionID: missing }),
      )
    }),
  )

  it.effect("filters root sessions before applying the page limit", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const { db } = yield* Database.Service
      const staleRoot = yield* session.create({ location, title: "stale root" })
      const root = yield* session.create({ location, title: "root" })
      const children = yield* Effect.forEach(Array.from({ length: 60 }), (_, index) =>
        session.create({ parentID: root.id, title: `child ${index}` }),
      )

      yield* Effect.forEach(children, (item, index) =>
        db
          .update(SessionTable)
          .set({ time_created: index + 100, time_updated: index + 20_000 })
          .where(eq(SessionTable.id, item.id))
          .run(),
      )
      yield* db
        .update(SessionTable)
        .set({ time_created: 2, time_updated: 5_000 })
        .where(eq(SessionTable.id, staleRoot.id))
        .run()
      yield* db
        .update(SessionTable)
        .set({ time_created: 1, time_updated: 10_000 })
        .where(eq(SessionTable.id, root.id))
        .run()

      const page = yield* session.list({ directory: location.directory, parentID: null, limit: 1, order: "desc" })

      expect(page.data.map((item) => item.id)).toEqual([root.id])
    }),
  )

  it.effect("orders sessions by their latest prompt", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const { db } = yield* Database.Service
      const active = yield* session.create({ location, title: "active" })
      const newer = yield* session.create({ location, title: "newer" })

      yield* db
        .update(SessionTable)
        .set({ time_created: -2, time_updated: -2 })
        .where(eq(SessionTable.id, active.id))
        .run()
      yield* db
        .update(SessionTable)
        .set({ time_created: -1, time_updated: -1 })
        .where(eq(SessionTable.id, newer.id))
        .run()

      yield* session.prompt({ sessionID: active.id, text: "continue", resume: false })

      expect((yield* session.list()).data.map((item) => item.id)).toEqual([active.id, newer.id])
    }),
  )

  it.effect("filters direct child sessions by parent ID", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const parent = yield* session.create({ location, title: "parent" })
      const child = yield* session.create({ parentID: parent.id, title: "child" })
      yield* session.create({ location, title: "other root" })

      const page = yield* session.list({ parentID: parent.id })

      expect(page.data.map((item) => item.id)).toEqual([child.id])
    }),
  )

  it.effect("filters project sessions by subpath", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const { db } = yield* Database.Service
      const root = yield* session.create({ location, title: "root" })
      const nested = yield* session.create({ location, title: "nested" })

      yield* db.update(SessionTable).set({ path: "packages/tui" }).where(eq(SessionTable.id, nested.id)).run()

      const page = yield* session.list({
        project: Project.ID.global,
        subpath: RelativePath.make("packages/tui"),
        parentID: null,
      })

      expect(page.data.map((item) => item.id)).toEqual([nested.id])
      expect(page.data.map((item) => item.id)).not.toContain(root.id)
    }),
  )

  it.effect("forks a session by replaying a durable fork event into copied projected rows", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const bus = yield* Bus.Service
      const { db } = yield* Database.Service
      const parent = yield* session.create({ location, title: "Parent" })
      const admitted = yield* session.prompt({
        sessionID: parent.id,
        text: "First",
        resume: false,
      })
      yield* SessionInbox.promote(db, bus, parent.id, "steer")
      yield* session.synthetic({ sessionID: parent.id, text: "parent note", resume: false })
      yield* SessionInbox.promote(db, bus, parent.id, "steer")

      const forked = yield* session.fork({ sessionID: parent.id, boundary: { type: "through" } })
      const parentContext = yield* session.context(parent.id)
      const forkContext = yield* session.context(forked.id)
      const history = Array.from(yield* Stream.runCollect(logEvents(session, forked.id)))

      expect(forked).toMatchObject({ title: "Parent (fork #1)", fork: { sessionID: parent.id } })
      expect(forked.parentID).toBeUndefined()
      expect(forkContext).toMatchObject([Expected.user("First"), { type: "synthetic", text: "parent note" }])
      expect(forkContext.map((message) => message.id)).not.toEqual(parentContext.map((message) => message.id))
      expect(history).toHaveLength(1)
      expect(history[0]).toMatchObject({
        type: "session.forked",
        durable: { seq: 0 },
        data: { sessionID: forked.id, parentID: parent.id },
      })
      expect(yield* SessionInbox.find(db, forkContext[0].id)).toBeUndefined()
      expect(yield* SessionInbox.find(db, forkContext[1].id)).toBeUndefined()
      expect(
        yield* session.prompt({ id: forkContext[0].id, sessionID: forked.id, text: "First", resume: false }),
      ).toMatchObject({ id: forkContext[0].id, type: "user", payload: { text: "First" } })

      yield* session.prompt({
        sessionID: parent.id,
        text: "Parent changed",
        resume: false,
      })
      yield* SessionInbox.promote(db, bus, parent.id, "steer")
      yield* session.prompt({
        sessionID: forked.id,
        text: "Child continues",
        resume: false,
      })
      yield* SessionInbox.promote(db, bus, forked.id, "steer")

      expect((yield* session.context(parent.id)).map((message) => message.type)).toEqual(["user", "synthetic", "user"])
      expect((yield* session.context(forked.id)).map((message) => message.type)).toEqual(["user", "synthetic", "user"])
      expect((yield* session.context(forked.id)).at(-1)).toMatchObject({ text: "Child continues" })
      expect(
        Array.from(yield* Stream.runCollect(logEvents(session, forked.id))).map(
          (event): number | undefined => event.durable?.seq,
        ),
      ).toEqual([0, 5, 6])
      expect(yield* SessionInbox.find(db, admitted.id)).toBeUndefined()
    }),
  )

  it.effect("freezes filtered fork history and replays it without invoking the callback", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const bus = yield* Bus.Service
      const { db } = yield* Database.Service
      const parent = yield* session.create({ location })
      yield* session.prompt({ sessionID: parent.id, text: "First", resume: false })
      yield* SessionInbox.promote(db, bus, parent.id, "steer")
      yield* session.synthetic({ sessionID: parent.id, text: "Original note", resume: false })
      yield* SessionInbox.promote(db, bus, parent.id, "steer")
      const last = yield* session.prompt({ sessionID: parent.id, text: "Excluded by boundary", resume: false })
      yield* SessionInbox.promote(db, bus, parent.id, "steer")
      const calls: number[] = []
      const forked = yield* session.fork({
        sessionID: parent.id,
        boundary: { type: "before", messageID: last.id },
        filter: (messages) => {
          calls.push(messages.length)
          return messages.flatMap((message) =>
            message.type === "synthetic" ? [{ ...message, text: "Filtered note" }] : [],
          )
        },
      })
      const original = yield* session.context(forked.id)
      expect(calls).toEqual([2])
      expect(original).toMatchObject([{ type: "synthetic", text: "Filtered note" }])
      const event = Array.from(yield* Stream.runCollect(logEvents(session, forked.id)))[0]
      if (event.type !== "session.forked") return yield* Effect.die(new Error("Fork event not found"))
      expect(typeof event.data.messages?.[0].time.created).toBe("number")
      expect((yield* session.context(parent.id))[1]).toMatchObject({ text: "Original note" })
      const recorded = yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, forked.id)).get()
      if (!recorded) return yield* Effect.die(new Error("Fork event not found"))
      yield* bus.remove(forked.id)
      yield* db.delete(SessionTable).where(eq(SessionTable.id, forked.id)).run()
      yield* bus.replay({
        id: recorded.id,
        created: recorded.created,
        aggregateID: recorded.aggregate_id,
        seq: recorded.seq,
        type: recorded.type,
        data: recorded.data,
      })
      expect(yield* session.context(forked.id)).toEqual(original)
      expect(calls).toEqual([2])
      yield* session.prompt({ sessionID: forked.id, text: "Continue", resume: false })
      yield* SessionInbox.promote(db, bus, forked.id, "steer")
      expect(yield* session.context(forked.id)).toMatchObject([
        { type: "synthetic", text: "Filtered note" },
        { type: "user", text: "Continue" },
      ])
      const empty = yield* session.fork({
        sessionID: parent.id,
        boundary: { type: "through" },
        filter: () => [],
      })
      expect(yield* session.context(empty.id)).toEqual([])
    }),
  )

  it.effect("exposes filtered forks to Promise plugins with decoded callback messages", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const bus = yield* Bus.Service
      const { db } = yield* Database.Service
      const parent = yield* session.create({ location })
      yield* session.prompt({ sessionID: parent.id, text: "Keep", resume: false })
      yield* SessionInbox.promote(db, bus, parent.id, "steer")
      yield* session.synthetic({ sessionID: parent.id, text: "Drop", resume: false })
      yield* SessionInbox.promote(db, bus, parent.id, "steer")
      const plugin = PluginPromise.fromPromise(
        Plugin.define({
          id: "filtered-fork",
          async setup(ctx) {
            const fork = await ctx.session.fork({
              sessionID: parent.id,
              boundary: { type: "through" },
              filter: (messages) => {
                expect(DateTime.isDateTime(messages[0].time.created)).toBe(true)
                return messages.filter((message) => message.type === "user")
              },
            })
            expect(typeof fork.time.created).toBe("number")
            expect(await ctx.session.context({ sessionID: fork.id })).toMatchObject([{ type: "user", text: "Keep" }])
          },
        }),
      )
      yield* plugin.effect(
        host({ session: { fork: session.fork, context: (input) => session.context(input.sessionID) } }),
      )
    }),
  )

  it.effect("keeps a fork untitled when its parent is untitled", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const bus = yield* Bus.Service
      const { db } = yield* Database.Service
      const parent = yield* session.create({ location })
      yield* session.prompt({ sessionID: parent.id, text: "First", resume: false })
      yield* SessionInbox.promote(db, bus, parent.id, "steer")

      const forked = yield* session.fork({ sessionID: parent.id, boundary: { type: "through" } })
      const row = yield* db.select().from(SessionTable).where(eq(SessionTable.id, forked.id)).get().pipe(Effect.orDie)

      expect(forked.title).toBeUndefined()
      expect(row?.title).toBeNull()
    }),
  )

  it.effect("replays a fork with stable projected identities", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const bus = yield* Bus.Service
      const { db } = yield* Database.Service
      const parent = yield* session.create({ location, title: "Parent" })
      yield* session.prompt({ sessionID: parent.id, text: "First", resume: false })
      yield* SessionInbox.promote(db, bus, parent.id, "steer")
      yield* session.synthetic({ sessionID: parent.id, text: "Second", resume: false })
      yield* SessionInbox.promote(db, bus, parent.id, "steer")
      const forked = yield* session.fork({ sessionID: parent.id, boundary: { type: "through" } })
      const original = (yield* session.context(forked.id)).map((message) => message.id)
      const recorded = yield* db
        .select()
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, forked.id))
        .get()
        .pipe(Effect.orDie)
      if (!recorded) return yield* Effect.die(new Error("Fork event not found"))

      yield* bus.remove(forked.id)
      yield* db.delete(SessionTable).where(eq(SessionTable.id, forked.id)).run().pipe(Effect.orDie)
      yield* bus.replay({
        id: recorded.id,
        created: recorded.created,
        aggregateID: recorded.aggregate_id,
        seq: recorded.seq,
        type: recorded.type,
        data: recorded.data,
      })

      expect((yield* session.context(forked.id)).map((message) => message.id)).toEqual(original)
    }),
  )

  it.effect("inherits instruction entries when forking", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const entries = yield* InstructionEntry.Service
      const bus = yield* Bus.Service
      const { db } = yield* Database.Service
      const parent = yield* session.create({ location })
      yield* session.prompt({ sessionID: parent.id, text: "Fork context", resume: false })
      yield* SessionInbox.promote(db, bus, parent.id, "steer")
      yield* entries.put({ sessionID: parent.id, key: "deploy-target", value: "production" })
      yield* entries.put({ sessionID: parent.id, key: "retired", value: true })
      yield* entries.remove({ sessionID: parent.id, key: "retired" })
      yield* Effect.forEach(
        Array.from({ length: 20 }, (_, index) => index),
        (index) => entries.put({ sessionID: parent.id, key: `entry-${String(index).padStart(2, "0")}`, value: index }),
        { discard: true },
      )

      const forked = yield* session.fork({ sessionID: parent.id, boundary: { type: "through" } })
      const inheritedList = yield* entries.list(forked.id)
      const inheritedValues = yield* entries.load(forked.id).pipe(Effect.flatMap(Instructions.read))

      expect(inheritedList).toHaveLength(21)
      expect(inheritedList).toContainEqual({ key: "deploy-target", value: "production" })
      expect(inheritedValues).toContainEqual({
        key: Instructions.Key.make("api/retired"),
        value: Instructions.removed,
      })

      const recorded = yield* db
        .select()
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, forked.id))
        .get()
        .pipe(Effect.orDie)
      if (!recorded) return yield* Effect.die(new Error("Fork event not found"))
      yield* entries.put({ sessionID: parent.id, key: "deploy-target", value: "staging" })
      yield* entries.put({ sessionID: parent.id, key: "new-parent-entry", value: true })
      yield* bus.remove(forked.id)
      yield* db.delete(SessionTable).where(eq(SessionTable.id, forked.id)).run().pipe(Effect.orDie)
      yield* bus.replay({
        id: recorded.id,
        created: recorded.created,
        aggregateID: recorded.aggregate_id,
        seq: recorded.seq,
        type: recorded.type,
        data: recorded.data,
      })

      expect(yield* entries.list(forked.id)).toEqual(inheritedList)
      expect(yield* entries.load(forked.id).pipe(Effect.flatMap(Instructions.read))).toEqual(inheritedValues)
    }),
  )

  it.effect("does not copy a running assistant into a fork", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const bus = yield* Bus.Service
      const { db } = yield* Database.Service
      const parent = yield* session.create({ location })
      yield* session.prompt({ sessionID: parent.id, text: "Run both tools", resume: false })
      yield* SessionInbox.promote(db, bus, parent.id, "steer")
      const assistantMessageID = SessionMessage.ID.create()
      const model = Model.Ref.make({ id: Model.ID.make("model"), providerID: Provider.ID.make("provider") })

      yield* bus.publish(SessionEvent.Step.Started, {
        sessionID: parent.id,
        assistantMessageID,
        agent: Agent.ID.make("build"),
        model,
      })
      yield* bus.publish(SessionEvent.Tool.Input.Started, {
        sessionID: parent.id,
        assistantMessageID,
        id: "call_running",
        name: "shell",
      })
      yield* bus.publish(SessionEvent.Tool.Input.Ended, {
        sessionID: parent.id,
        assistantMessageID,
        id: "call_running",
        text: '{"command":"sleep 10"}',
      })
      yield* bus.publish(SessionEvent.Tool.Called, {
        sessionID: parent.id,
        assistantMessageID,
        id: "call_running",
        input: { command: "sleep 10" },
        executed: true,
      })

      const forked = yield* session.fork({ sessionID: parent.id, boundary: { type: "through" } })

      expect(yield* session.context(parent.id)).toMatchObject([
        Expected.user("Run both tools"),
        Expected.assistant({}, [{ type: "tool", id: "call_running", state: { status: "running" } }]),
      ])
      expect(yield* session.context(forked.id)).toMatchObject([Expected.user("Run both tools")])
    }),
  )

  it.effect("copies only settled shell messages into forks", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const bus = yield* Bus.Service
      const { db } = yield* Database.Service
      const parent = yield* session.create({ location })
      yield* session.prompt({ sessionID: parent.id, text: "Run a shell", resume: false })
      yield* SessionInbox.promote(db, bus, parent.id, "steer")
      const shell = Shell.Info.make({
        id: Shell.ID.make("sh_fork_running"),
        status: "running",
        command: "sleep 10",
        cwd: location.directory,
        shell: "/bin/sh",
        file: "/tmp/sh_fork_running.out",
        metadata: {},
        time: { started: 0 },
      })
      yield* bus.publish(SessionEvent.Shell.Started, { sessionID: parent.id, shell })

      const running = yield* session.fork({ sessionID: parent.id, boundary: { type: "through" } })

      expect(yield* session.context(parent.id)).toMatchObject([
        Expected.user("Run a shell"),
        { type: "shell", command: "sleep 10", status: "running" },
      ])
      expect(yield* session.context(running.id)).toMatchObject([Expected.user("Run a shell")])

      yield* bus.publish(SessionEvent.Shell.Ended, {
        sessionID: parent.id,
        shell: { ...shell, status: "exited", exit: 0, time: { started: 0, completed: 1 } },
        output: { output: "complete", cursor: 8, size: 8, truncated: false },
      })
      const completed = yield* session.fork({ sessionID: parent.id, boundary: { type: "through" } })

      expect(yield* session.context(running.id)).toMatchObject([Expected.user("Run a shell")])
      expect(yield* session.context(completed.id)).toMatchObject([
        Expected.user("Run a shell"),
        { type: "shell", command: "sleep 10", status: "exited", output: { output: "complete" } },
      ])
    }),
  )

  it.effect("rejects forking an empty session", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const parent = yield* session.create({ location })

      expect(
        yield* session.fork({ sessionID: parent.id, boundary: { type: "through" } }).pipe(Effect.flip),
      ).toMatchObject({ _tag: "Session.ForkEmptyError", sessionID: parent.id })
    }),
  )

  it.effect("forks before the selected boundary message", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const bus = yield* Bus.Service
      const { db } = yield* Database.Service
      const parent = yield* session.create({ location })
      const first = yield* session.prompt({
        sessionID: parent.id,
        text: "First",
        resume: false,
      })
      yield* SessionInbox.promote(db, bus, parent.id, "steer")
      const second = yield* session.prompt({
        sessionID: parent.id,
        text: "Second",
        resume: false,
      })
      yield* SessionInbox.promote(db, bus, parent.id, "steer")
      const assistantMessageID = SessionMessage.ID.create()
      const model = Model.Ref.make({ id: Model.ID.make("model"), providerID: Provider.ID.make("provider") })
      yield* bus.publish(SessionEvent.Step.Started, {
        sessionID: parent.id,
        assistantMessageID,
        agent: Agent.ID.make("build"),
        model,
      })
      yield* bus.publish(SessionEvent.Step.Ended, {
        sessionID: parent.id,
        assistantMessageID,
        finish: "stop",
        cost: Money.USD.make(0.75),
        tokens: { input: 6, output: 3, reasoning: 1, cache: { read: 2, write: 1 } },
      })

      const forked = yield* session.fork({
        sessionID: parent.id,
        boundary: { type: "before", messageID: second.id },
      })
      const beforeFirst = yield* session.fork({
        sessionID: parent.id,
        boundary: { type: "before", messageID: first.id },
      })
      const complete = yield* session.fork({ sessionID: parent.id, boundary: { type: "through" } })

      const context = yield* session.context(forked.id)
      const history = Array.from(yield* Stream.runCollect(logEvents(session, forked.id)))
      expect(forked.fork).toEqual({
        sessionID: parent.id,
        boundary: { type: "before", messageID: second.id },
      })
      expect(context).toMatchObject([{ text: "First" }])
      expect(context[0]?.id).not.toBe(first.id)
      expect(history[0]).toMatchObject({
        data: { boundary: { type: "before", messageID: second.id } },
      })
      expect(forked).toMatchObject({ cost: 0, tokens: { input: 0, output: 0, reasoning: 0 } })
      expect(yield* session.context(beforeFirst.id)).toEqual([])
      expect(beforeFirst).toMatchObject({ cost: 0, tokens: { input: 0, output: 0, reasoning: 0 } })
      expect(yield* session.context(complete.id)).toMatchObject([
        Expected.user("First"),
        Expected.user("Second"),
        { type: "assistant", finish: "stop" },
      ])
      expect(complete).toMatchObject({
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      })
    }),
  )

  it.effect("returns the existing Session when one ID is reused with different create arguments", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const created = yield* session.create({ id, location })
      const changed = [
        { id, location: Location.Ref.make({ directory: AbsolutePath.make("/other") }) },
        { id, location, agent: Agent.ID.make("build") },
        {
          id,
          location,
          model: Model.Ref.make({ id: Model.ID.make("sonnet"), providerID: Provider.ID.anthropic }),
        },
      ]

      for (const input of changed) {
        expect(yield* session.create(input)).toEqual(created)
      }
      expect((yield* session.list()).data).toHaveLength(1)
    }),
  )

  it.effect("returns one recorded session to concurrent exact retries", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const input = { id, location }

      const created = yield* Effect.all([session.create(input), session.create(input)], { concurrency: "unbounded" })

      expect(created[1]).toEqual(created[0])
      expect((yield* session.list()).data).toEqual([created[0]])
    }),
  )

  it.effect("returns the current Session projection after updates", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const { db } = yield* Database.Service
      const input = { id, location }
      const created = yield* session.create(input)

      yield* db.update(SessionTable).set({ agent: "build" }).where(eq(SessionTable.id, id)).run().pipe(Effect.orDie)

      expect(yield* session.create(input)).toMatchObject({ id: created.id, agent: "build" })
    }),
  )

  it.effect("persists creation through the current created event", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const { db } = yield* Database.Service
      const created = yield* session.create({ location })

      expect(
        yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, created.id)).all().pipe(Effect.orDie),
      ).toMatchObject([{ type: Bus.versionedType(SessionEvent.Created.type, 1) }])
    }),
  )

  it.effect("persists caller-ID creation through the existing created event", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const { db } = yield* Database.Service
      const created = yield* session.create({ id, location })

      expect(
        yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, created.id)).get().pipe(Effect.orDie),
      ).toMatchObject({
        data: { sessionID: id },
      })
    }),
  )

  it.effect("includes current creation rows in the Session event stream", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const bus = yield* Bus.Service
      const { db } = yield* Database.Service
      const created = yield* session.create({ location })
      yield* session.prompt({
        sessionID: created.id,
        text: "Hello",
        resume: false,
      })
      yield* SessionInbox.promote(db, bus, created.id, "steer")

      expect(
        Array.from(yield* logEvents(session, created.id, true).pipe(Stream.take(3), Stream.runCollect)),
      ).toMatchObject([
        { durable: { seq: 0 }, type: "session.created" },
        {
          durable: { seq: 1 },
          type: "session.inbox.enqueued",
          data: {
            inboxID: expect.any(String),
            item: { type: "user", payload: { text: "Hello" }, delivery: "steer" },
          },
        },
        { durable: { seq: 2 }, type: "session.inbox.delivered" },
      ])
    }),
  )

  it.effect("replays one prompt lifecycle into a fresh target database", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const sourceEvents = yield* Bus.Service
      const sourceDb = (yield* Database.Service).db
      const created = yield* session.create({ id: Session.ID.make("ses_fresh_target_replay"), location })
      const admitted = yield* session.prompt({
        sessionID: created.id,
        text: "Replay lifecycle",
        resume: false,
      })
      yield* SessionInbox.promote(sourceDb, sourceEvents, created.id, "steer")
      const serialized = (yield* sourceDb
        .select()
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, created.id))
        .orderBy(asc(EventTable.seq))
        .all()
        .pipe(Effect.orDie)).map((event) => ({
        id: event.id,
        created: event.created,
        aggregateID: event.aggregate_id,
        seq: event.seq,
        type: event.type,
        data: event.data,
      }))

      const tmp = yield* tmpdirScoped()
      const targetLayer = AppNodeBuilder.build(
        LayerNode.group([Database.node, Bus.node, SessionProjector.node, SessionStore.node]),
        [
          Database.node.replace(Database.configured({ path: path.join(tmp.path, "target.sqlite") })),
          Bus.node.replace(Bus.configured({ persist: true })),
        ],
      )

      yield* Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const bus = yield* Bus.Service
        const store = yield* SessionStore.Service
        yield* db
          .insert(ProjectTable)
          .values({ id: Project.ID.global, worktree: location.directory, sandboxes: [] })
          .run()
          .pipe(Effect.orDie)

        expect(yield* store.get(created.id)).toBeUndefined()
        yield* Effect.forEach(serialized.slice(0, 2), (event) => bus.replay(event), { discard: true })
        expect(yield* SessionInbox.find(db, admitted.id)).toMatchObject({
          id: admitted.id,
          sessionID: created.id,
          type: "user",
          payload: { text: "Replay lifecycle" },
          delivery: "steer",
        })
        expect(yield* store.context(created.id)).toEqual([])

        yield* Effect.forEach(serialized.slice(2), (event) => bus.replay(event), { discard: true })
        expect(yield* SessionInbox.find(db, admitted.id)).toBeUndefined()
        expect(yield* store.context(created.id)).toMatchObject([
          { id: admitted.id, ...Expected.user("Replay lifecycle") },
        ])
        expect(
          (yield* db
            .select()
            .from(EventTable)
            .where(eq(EventTable.aggregate_id, created.id))
            .orderBy(asc(EventTable.seq))
            .all()
            .pipe(Effect.orDie)).map((event) => [event.seq, event.type]),
        ).toEqual([
          [0, Bus.versionedType(SessionEvent.Created.type, 1)],
          [1, Bus.versionedType(SessionEvent.InboxEnqueued.type, 1)],
          [2, Bus.versionedType(SessionEvent.InboxDelivered.type, 1)],
        ])
      }).pipe(Effect.provide(Layer.fresh(targetLayer)))
    }),
  )

  it.effect("does not mask unrelated created projector defects", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const event = yield* Bus.Service
      const defect = new Error("unrelated projector defect")
      yield* event.project(SessionEvent.Created, () => Effect.die(defect))

      expect(yield* session.create({ id, location }).pipe(Effect.catchDefect(Effect.succeed))).toBe(defect)
    }),
  )

  liveIt.live("runs a shell command and projects the started/ended shell message", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        const session = yield* Session.Service
        const created = yield* session.create({
          location: Location.Ref.make({ directory: AbsolutePath.make(directory) }),
        })
        yield* session.environment({ sessionID: created.id, variables: { OPENCODE_SESSION_ENV_TEST: "attached" } })

        const command =
          process.platform === "win32"
            ? "[Console]::Out.Write($env:OPENCODE_SESSION_ENV_TEST)"
            : 'printf %s "$OPENCODE_SESSION_ENV_TEST"'
        yield* session.shell({ sessionID: created.id, command })

        const messages = yield* session.messages({ sessionID: created.id, order: "asc" })
        const shell = messages.find((message): message is SessionMessage.Shell => message.type === "shell")
        expect(shell).toMatchObject({ type: "shell", command, status: "exited", exit: 0 })
        expect(shell?.output?.output).toContain("attached")
        expect(shell?.output?.truncated).toBe(false)
        expect(shell?.time.completed).toBeDefined()
      }),
    ),
  )

  liveIt.live("still emits shell ended for a failing command", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        const session = yield* Session.Service
        const created = yield* session.create({
          location: Location.Ref.make({ directory: AbsolutePath.make(directory) }),
        })

        yield* session.shell({ sessionID: created.id, command: "false" })

        const messages = yield* session.messages({ sessionID: created.id, order: "asc" })
        const shell = messages.find((message): message is SessionMessage.Shell => message.type === "shell")
        expect(shell).toMatchObject({ type: "shell", command: "false", status: "exited" })
        expect(shell?.exit).not.toBe(0)
        expect(shell?.time.completed).toBeDefined()
      }),
    ),
  )

  it.effect("switches the selected agent through the durable Session event", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const created = yield* session.create({ location, agent: Agent.ID.make("build") })

      yield* session.switchAgent({ sessionID: created.id, agent: Agent.ID.make("plan") })

      expect(yield* session.get(created.id)).toMatchObject({ agent: "plan" })
      expect(
        Array.from(yield* logEvents(session, created.id, true).pipe(Stream.drop(1), Stream.take(1), Stream.runCollect)),
      ).toMatchObject([{ type: "session.agent.selected", data: { agent: "plan", previous: "build" } }])
      expect(yield* session.messages({ sessionID: created.id, order: "asc" })).toMatchObject([
        { type: "agent-switched", agent: "plan", previous: "build" },
      ])
    }),
  )

  it.effect("rejects an agent switch for a missing Session", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const missing = Session.ID.make("ses_missing_agent_switch")

      expect(
        yield* session.switchAgent({ sessionID: missing, agent: Agent.ID.make("plan") }).pipe(
          Effect.flip,
          Effect.map((error) => error._tag),
        ),
      ).toBe("Session.NotFoundError")
    }),
  )

  it.effect("switches the selected model through the durable Session event", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const previous = Model.Ref.make({
        id: Model.ID.make("haiku"),
        providerID: Provider.ID.anthropic,
        variant: Model.VariantID.make("default"),
      })
      const created = yield* session.create({ location, model: previous })
      const model = Model.Ref.make({
        id: Model.ID.make("sonnet"),
        providerID: Provider.ID.anthropic,
        variant: Model.VariantID.make("high"),
      })

      yield* session.switchModel({ sessionID: created.id, model })

      expect(yield* session.get(created.id)).toMatchObject({ model })
      const bus = Array.from(
        yield* logEvents(session, created.id, true).pipe(Stream.drop(1), Stream.take(1), Stream.runCollect),
      )
      expect(bus).toMatchObject([{ type: "session.model.selected" }])
      expect(bus[0]?.data).toEqual({ sessionID: created.id, model, previous })
      expect(yield* session.messages({ sessionID: created.id, order: "asc" })).toMatchObject([
        { type: "model-switched", model, previous },
      ])
    }),
  )

  it.effect("ignores a model switch when the selected model is unchanged", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const created = yield* session.create({ location })
      const model = Model.Ref.make({ id: Model.ID.make("sonnet"), providerID: Provider.ID.anthropic })

      yield* session.switchModel({ sessionID: created.id, model })
      yield* session.switchModel({ sessionID: created.id, model })

      const { db } = yield* Database.Service
      expect(
        yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, created.id)).all().pipe(Effect.orDie),
      ).toHaveLength(2)
      expect(yield* session.get(created.id)).toMatchObject({ model })
    }),
  )

  it.effect("treats an omitted variant as the default variant", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const model = Model.Ref.make({ id: Model.ID.make("sonnet"), providerID: Provider.ID.anthropic })
      const created = yield* session.create({ location, model })

      yield* session.switchModel({
        sessionID: created.id,
        model: Model.Ref.make({ ...model, variant: Model.VariantID.make("default") }),
      })

      const { db } = yield* Database.Service
      expect(
        yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, created.id)).all().pipe(Effect.orDie),
      ).toHaveLength(1)
    }),
  )

  it.effect("rejects a model switch for a missing Session", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const missing = Session.ID.make("ses_missing_model_switch")

      expect(
        yield* session
          .switchModel({
            sessionID: missing,
            model: Model.Ref.make({ id: Model.ID.make("sonnet"), providerID: Provider.ID.anthropic }),
          })
          .pipe(
            Effect.flip,
            Effect.map((error) => error._tag),
          ),
      ).toBe("Session.NotFoundError")
    }),
  )
})

describe("SessionTransfer", () => {
  it.effect("exports only settled projected messages", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const transfer = yield* SessionTransfer.Service
      const bus = yield* Bus.Service
      const { db } = yield* Database.Service
      const source = yield* session.create({ location })
      yield* session.prompt({ sessionID: source.id, text: "Settled", resume: false })
      yield* SessionInbox.promote(db, bus, source.id, "steer")
      yield* bus.publish(SessionEvent.Step.Started, {
        sessionID: source.id,
        assistantMessageID: SessionMessage.ID.create(),
        agent: Agent.ID.make("build"),
        model: Model.Ref.make({ id: Model.ID.make("model"), providerID: Provider.ID.make("provider") }),
      })
      yield* bus.publish(SessionEvent.Shell.Started, {
        sessionID: source.id,
        shell: Shell.Info.make({
          id: Shell.ID.make("sh_transfer_export"),
          status: "running",
          command: "sleep 10",
          cwd: location.directory,
          shell: "/bin/sh",
          file: "/tmp/sh_transfer_export.out",
          metadata: {},
          time: { started: 0 },
        }),
      })
      yield* bus.publish(SessionEvent.Compaction.Started, {
        sessionID: source.id,
        reason: "manual",
        recent: "pending",
      })

      expect((yield* transfer.export({ sessionID: source.id })).messages).toMatchObject([Expected.user("Settled")])
    }),
  )

  it.effect("imports only settled projected messages", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const transfer = yield* SessionTransfer.Service
      const { db } = yield* Database.Service
      const template = yield* session.create({ location, title: "Transfer source" })
      const sessionID = Session.ID.create()
      const userID = SessionMessage.ID.create()
      const runningAssistantID = SessionMessage.ID.create()
      const completedAssistantID = SessionMessage.ID.create()
      const runningShellID = SessionMessage.ID.create()
      const completedShellID = SessionMessage.ID.create()
      const runningCompactionID = SessionMessage.ID.create()
      const completedCompactionID = SessionMessage.ID.create()
      const model = Model.Ref.make({ id: Model.ID.make("model"), providerID: Provider.ID.make("provider") })
      const providerState = { responseId: "summary-response" }

      yield* transfer.import({
        data: {
          info: { ...template, id: sessionID },
          messages: [
            { id: userID, type: "user", text: "Settled", time: { created: DateTime.makeUnsafe(1) } },
            {
              id: runningAssistantID,
              type: "assistant",
              agent: Agent.ID.make("build"),
              model,
              content: [],
              time: { created: DateTime.makeUnsafe(2) },
            },
            {
              id: completedAssistantID,
              type: "assistant",
              agent: Agent.ID.make("build"),
              model,
              content: [],
              time: { created: DateTime.makeUnsafe(3), completed: DateTime.makeUnsafe(4) },
            },
            {
              id: runningShellID,
              type: "shell",
              shellID: Shell.ID.make("sh_transfer_running"),
              command: "sleep 10",
              status: "running",
              time: { created: DateTime.makeUnsafe(5) },
            },
            {
              id: completedShellID,
              type: "shell",
              shellID: Shell.ID.make("sh_transfer_completed"),
              command: "pwd",
              status: "exited",
              exit: 0,
              output: { output: "/project", cursor: 8, size: 8, truncated: false },
              time: { created: DateTime.makeUnsafe(6), completed: DateTime.makeUnsafe(7) },
            },
            {
              id: runningCompactionID,
              type: "compaction",
              status: "running",
              reason: "manual",
              summary: "pending",
              recent: "pending",
              time: { created: DateTime.makeUnsafe(8) },
            },
            {
              id: completedCompactionID,
              type: "compaction",
              status: "completed",
              reason: "manual",
              model,
              providerState,
              summary: "summary",
              recent: "recent",
              time: { created: DateTime.makeUnsafe(9) },
            },
          ],
        },
        location,
      })

      expect((yield* session.messages({ sessionID, order: "asc" })).map((message) => message.id)).toEqual([
        userID,
        completedAssistantID,
        completedShellID,
        completedCompactionID,
      ])
      expect(yield* Bus.latestSequence(db, sessionID)).toBe(4)
      expect((yield* transfer.export({ sessionID })).messages.at(-1)).toMatchObject({ model, providerState })
      expect((yield* transfer.export({ sessionID, sanitize: true })).messages.at(-1)).toMatchObject({
        model,
        providerState: { redacted: `compaction-provider-state:${completedCompactionID}` },
      })
    }),
  )

  it.effect("imports projected messages and reserves their aggregate sequence", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const transfer = yield* SessionTransfer.Service
      const bus = yield* Bus.Service
      const { db } = yield* Database.Service
      const template = yield* session.create({
        location,
        title: "Exported",
        metadata: { channel: "C123" },
        permissions: [{ action: "edit", resource: "*", effect: "deny" }],
      })
      const sessionID = Session.ID.create()
      const sourceMessageID = SessionMessage.ID.create()
      const errorMessageID = SessionMessage.ID.create()
      yield* TestClock.setTime(1_000)

      const imported = yield* transfer.import({
        data: {
          info: {
            ...template,
            id: sessionID,
            time: {
              ...template.time,
              updated: DateTime.makeUnsafe(100),
              idle: DateTime.makeUnsafe(200),
              viewed: DateTime.makeUnsafe(150),
            },
          },
          messages: [
            {
              id: sourceMessageID,
              type: "user",
              text: "Imported message",
              skills: [
                {
                  id: Skill.ID.make("effect"),
                  name: Skill.Name.make("Effect"),
                  text: "Private skill instructions from /private/project",
                },
              ],
              time: { created: DateTime.makeUnsafe(100) },
            },
            {
              id: errorMessageID,
              type: "compaction",
              status: "failed",
              reason: "manual",
              error: { type: "test_error", message: "Original error" },
              time: { created: DateTime.makeUnsafe(101) },
            },
          ],
        },
        location,
      })
      const messages = yield* session.messages({ sessionID, order: "asc" })

      expect(imported).toMatchObject({
        id: sessionID,
        title: "Exported",
        location,
        metadata: { channel: "C123" },
        permissions: [{ action: "edit", resource: "*", effect: "deny" }],
      })
      expect(imported.time).toMatchObject({
        updated: DateTime.makeUnsafe(1_000),
        idle: DateTime.makeUnsafe(200),
        viewed: DateTime.makeUnsafe(150),
      })
      expect(messages).toMatchObject([
        { id: sourceMessageID, ...Expected.user("Imported message") },
        { id: errorMessageID, type: "compaction", error: { type: "test_error", message: "Original error" } },
      ])
      expect(yield* Bus.latestSequence(db, sessionID)).toBe(2)
      const exported = yield* transfer.export({ sessionID })
      expect(exported.info.time).toMatchObject({ idle: DateTime.makeUnsafe(200), viewed: DateTime.makeUnsafe(150) })
      expect(exported.messages).toEqual(messages)
      const sanitized = yield* transfer.export({ sessionID, sanitize: true })
      expect(sanitized.info.time).toMatchObject({ idle: DateTime.makeUnsafe(200), viewed: DateTime.makeUnsafe(150) })
      expect(sanitized.info.metadata).toEqual({ redacted: `session-metadata:${sessionID}` })
      expect(sanitized.messages).toMatchObject([
        {
          id: sourceMessageID,
          text: `[redacted:text:${sourceMessageID}]`,
          skills: [{ id: "effect", name: "[redacted:skill-name:0]", text: "[redacted:skill:0]" }],
        },
        { id: errorMessageID, error: { type: "test_error", message: "Original error" } },
      ])

      yield* session.prompt({ sessionID, text: "Continue", resume: false })
      yield* SessionInbox.promote(db, bus, sessionID, "steer")

      expect((yield* session.messages({ sessionID, order: "asc" })).map((message) => message.type)).toEqual([
        "user",
        "compaction",
        "user",
      ])
      expect(yield* Bus.latestSequence(db, sessionID)).toBe(4)
    }),
  )

  it.effect("rejects an existing session ID without changing its transcript", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const transfer = yield* SessionTransfer.Service
      const existing = yield* session.create({ location, title: "Existing" })
      const exit = yield* Effect.exit(transfer.import({ data: { info: existing, messages: [] }, location }))

      expect(exit._tag).toBe("Failure")
      expect((yield* session.get(existing.id)).title).toBe("Existing")
      expect(yield* session.messages({ sessionID: existing.id })).toEqual([])
    }),
  )

  it.effect("clamps an imported viewed watermark to its idle transition", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const transfer = yield* SessionTransfer.Service
      const template = yield* session.create({ location })
      const imported = yield* transfer.import({
        data: {
          info: {
            ...template,
            id: Session.ID.create(),
            outcome: "succeeded",
            time: {
              ...template.time,
              idle: DateTime.makeUnsafe(200),
              viewed: DateTime.makeUnsafe(250),
            },
          },
          messages: [],
        },
        location,
      })

      expect(imported.time).toMatchObject({ idle: DateTime.makeUnsafe(200), viewed: DateTime.makeUnsafe(200) })
      expect(imported.outcome).toBe("succeeded")
    }),
  )
})
