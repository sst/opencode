import { expect } from "bun:test"
import path from "path"
import { Clock, Deferred, Effect } from "effect"
import { TestClock } from "effect/testing"
import { Command } from "@opencode/core/command"
import { Bus } from "@opencode/core/bus"
import { Credential } from "@opencode/core/credential"
import { Integration } from "@opencode/core/integration"
import { Plugin } from "@opencode/core/plugin"
import { PluginModule } from "@opencode/core/plugin/module"
import { Watcher } from "@opencode/core/filesystem/watcher"
import { fromPromise } from "@opencode/plugin/promise/adapter"
import { Session } from "@opencode/schema/session"
import { testEffect } from "./lib/effect"
import { PluginTestLayer } from "./plugin/fixture"

const it = testEffect(PluginTestLayer)

for (const scenario of [
  {
    name: "starts only the appended plugin",
    before: ["a", "b"],
    after: ["a", "b", "c"],
    expected: ["start:c:1"],
  },
  {
    name: "restarts the suffix after an insertion",
    before: ["a", "b", "c"],
    after: ["a", "x", "b", "c"],
    expected: ["stop:c:1", "stop:b:1", "start:x:1", "start:b:1", "start:c:1"],
  },
  {
    name: "restarts the suffix after a revision changes",
    before: ["a", "b", "c"],
    after: ["a", "b", "c"],
    updated: "b",
    expected: ["stop:c:1", "stop:b:1", "start:b:2", "start:c:1"],
  },
  {
    name: "stops only the removed trailing plugin",
    before: ["a", "b", "c"],
    after: ["a", "b"],
    expected: ["stop:c:1"],
  },
]) {
  it.effect(scenario.name, () =>
    Effect.gen(function* () {
      const plugins = yield* Plugin.Service
      const events: string[] = []
      const plugin = (id: string, revision = "1"): Plugin.Generation => ({
        id,
        revision,
        effect: () =>
          Effect.gen(function* () {
            events.push(`start:${id}:${revision}`)
            yield* Effect.addFinalizer(() => Effect.sync(() => events.push(`stop:${id}:${revision}`)))
          }),
      })

      yield* plugins.activate(scenario.before.map((id) => plugin(id)))
      events.length = 0
      yield* plugins.activate(scenario.after.map((id) => plugin(id, id === scenario.updated ? "2" : "1")))

      expect(events).toEqual(scenario.expected)
      expect((yield* plugins.list()).map((plugin) => plugin.id)).toEqual(scenario.after.map((id) => Plugin.ID.make(id)))
    }),
  )
}

it.effect("updates inventory metadata without restarting an unchanged generation", () =>
  Effect.gen(function* () {
    const plugins = yield* Plugin.Service
    let loads = 0
    const plugin = {
      id: "metadata",
      revision: "1",
      source: { type: "package" as const, target: "fixture" },
      effect: () => Effect.sync(() => loads++),
    }

    yield* plugins.activate([plugin])
    yield* plugins.activate([{ ...plugin, source: { ...plugin.source, outdated: true } }])

    expect(loads).toBe(1)
    expect((yield* plugins.list())[0]?.source).toEqual({ type: "package", target: "fixture", outdated: true })
  }),
)

it.live("loads a local plugin with its configured options", () =>
  Effect.gen(function* () {
    const plugins = yield* Plugin.Service
    const commands = yield* Command.Service
    yield* plugins.awaitActivation
    const modules = yield* PluginModule.make().pipe(Effect.provide(Watcher.testLayer))
    const definition = yield* modules.load({
      type: "add",
      target: path.join(import.meta.dir, "plugin/fixtures/greeting.ts"),
      options: { description: "Configured greeting" },
    })
    if ("pending" in definition) return yield* Effect.die("Local plugin was not loaded")
    yield* plugins.activate([definition])

    expect(yield* commands.get("greet")).toMatchObject({ description: "Configured greeting" })
  }),
)

it.effect("unloading a plugin removes its commands and runs cleanup", () =>
  Effect.gen(function* () {
    const plugins = yield* Plugin.Service
    const commands = yield* Command.Service
    let cleaned = false
    yield* plugins.activate([
      {
        id: "greeting",
        revision: "1",
        effect: (ctx) =>
          Effect.gen(function* () {
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                cleaned = true
              }),
            )
            yield* ctx.command.transform((editor) => editor.add({ name: "greet", execute: () => Effect.void }))
          }),
      },
    ])
    expect(yield* commands.get("greet")).toBeDefined()
    expect(cleaned).toBe(false)

    yield* plugins.activate([])

    expect(yield* commands.get("greet")).toBeUndefined()
    expect(cleaned).toBe(true)
  }),
)

it.effect("reports a failed plugin without blocking a healthy plugin", () =>
  Effect.gen(function* () {
    const plugins = yield* Plugin.Service
    const commands = yield* Command.Service
    yield* plugins.activate([
      { id: "broken", revision: "1", effect: () => Effect.die(new Error("Setup failed")) },
      {
        id: "greeting",
        revision: "1",
        effect: (ctx) =>
          ctx.command
            .transform((editor) => editor.add({ name: "greet", execute: () => Effect.void }))
            .pipe(Effect.asVoid),
      },
    ])

    expect((yield* plugins.list()).find((plugin) => plugin.id === "broken")?.state).toMatchObject({
      status: "failed",
      error: expect.stringContaining("Setup failed"),
    })
    expect(yield* commands.get("greet")).toBeDefined()
  }),
)

it.effect("disables a plugin whose transform fails after setup without publishing its partial edits", () =>
  Effect.gen(function* () {
    const plugins = yield* Plugin.Service
    const commands = yield* Command.Service
    const integrations = yield* Integration.Service
    let cleaned = false
    yield* plugins.activate([
      {
        id: "before",
        revision: "1",
        effect: (ctx) =>
          ctx.command
            .transform((editor) => editor.add({ name: "shared", description: "original", execute: () => Effect.void }))
            .pipe(Effect.asVoid),
      },
      {
        id: "broken",
        revision: "1",
        effect: (ctx) =>
          Effect.gen(function* () {
            yield* Effect.addFinalizer(() => Effect.sync(() => void (cleaned = true)))
            yield* ctx.integration.transform((editor) => editor.update("broken", (entry) => (entry.name = "Broken")))
            yield* ctx.command.transform((editor) => {
              editor.add({ name: "shared", description: "partial", execute: () => Effect.void })
              throw new Error("replay failed")
            })
          }),
      },
      {
        id: "after",
        revision: "1",
        effect: (ctx) =>
          ctx.command
            .transform((editor) => editor.add({ name: "healthy", execute: () => Effect.void }))
            .pipe(Effect.asVoid),
      },
    ])

    yield* plugins.awaitActivation
    expect(cleaned).toBe(true)
    expect((yield* plugins.list()).find((plugin) => plugin.id === "broken")?.state).toMatchObject({
      status: "failed",
      error: expect.stringContaining("command.transform failed"),
      ref: expect.stringMatching(/^err_/),
    })
    expect(yield* commands.get("shared")).toMatchObject({ description: "original" })
    expect(yield* commands.get("healthy")).toBeDefined()
    expect(yield* integrations.get(Integration.ID.make("broken"))).toBeUndefined()
  }),
)

it.effect("keeps the suffix after a failed plugin alive across identical activations", () =>
  Effect.gen(function* () {
    const plugins = yield* Plugin.Service
    const setups = { good1: 0, broken: 0, good2: 0 }
    const good = (id: "good1" | "good2"): Plugin.Generation => ({
      id,
      revision: "1",
      effect: () => Effect.sync(() => void setups[id]++),
    })
    const broken = (revision: string): Plugin.Generation => ({
      id: "broken",
      revision,
      effect: () =>
        Effect.suspend(() => {
          setups.broken++
          return Effect.die(new Error("Setup failed"))
        }),
    })
    const failed = () =>
      plugins.list().pipe(Effect.map((inventory) => inventory.find((plugin) => plugin.id === "broken")?.state))

    yield* plugins.activate([good("good1"), broken("1"), good("good2")])
    expect(setups).toEqual({ good1: 1, broken: 1, good2: 1 })
    expect(yield* failed()).toMatchObject({ status: "failed", error: expect.stringContaining("Setup failed") })

    // Identical definitions: nothing restarts and the failed revision is not retried.
    yield* plugins.activate([good("good1"), broken("1"), good("good2")])
    expect(setups).toEqual({ good1: 1, broken: 1, good2: 1 })
    expect(yield* failed()).toMatchObject({ status: "failed", error: expect.stringContaining("Setup failed") })
    expect((yield* plugins.list()).map((plugin) => `${plugin.id}:${plugin.state.status}`)).toEqual([
      "good1:active",
      "broken:failed",
      "good2:active",
    ])

    // A new revision of the failed plugin is retried once, restarting only the suffix behind it.
    yield* plugins.activate([good("good1"), broken("2"), good("good2")])
    expect(setups).toEqual({ good1: 1, broken: 2, good2: 2 })
    expect(yield* failed()).toMatchObject({ status: "failed" })
  }),
)

it.effect("attributes replay failure to the broken plugin rather than a later plugin reading the registry", () =>
  Effect.gen(function* () {
    const plugins = yield* Plugin.Service
    const commands = yield* Command.Service
    yield* plugins.activate([
      {
        id: "broken-plugin",
        revision: "1",
        effect: (ctx) =>
          ctx.command
            .transform(() => {
              throw new Error("plugin failed")
            })
            .pipe(Effect.asVoid),
      },
      {
        id: "reader",
        revision: "1",
        effect: (ctx) =>
          Effect.gen(function* () {
            yield* ctx.command.list().pipe(Effect.orDie)
            yield* ctx.command.transform((editor) => editor.add({ name: "reader", execute: () => Effect.void }))
          }),
      },
    ])
    yield* plugins.awaitActivation
    expect((yield* plugins.list()).map((entry) => `${entry.id}:${entry.state.status}`)).toEqual([
      "broken-plugin:failed",
      "reader:active",
    ])
    expect(yield* commands.get("reader")).toBeDefined()
  }),
)

it.effect("disables plugins after runtime reload failures without retrying an unchanged generation", () =>
  Effect.gen(function* () {
    const plugins = yield* Plugin.Service
    const commands = yield* Command.Service
    const bus = yield* Bus.Service
    const reported: string[] = []
    yield* Effect.acquireRelease(
      bus.listen((event) =>
        event.type === Plugin.Event.Updated.type
          ? plugins.list().pipe(
              Effect.tap((items) => Effect.sync(() => void reported.push(items[0]?.state.status ?? "empty"))),
              Effect.asVoid,
            )
          : Effect.void,
      ),
      (unsubscribe) => unsubscribe,
    )
    let fail = false
    let loads = 0
    let reload = () => Effect.void
    const generation = (revision: string): Plugin.Generation => ({
      id: "runtime",
      revision,
      effect: (ctx) =>
        Effect.gen(function* () {
          loads++
          reload = ctx.command.reload
          yield* ctx.command.transform((editor) => {
            editor.add({ name: "runtime", execute: () => Effect.void })
            if (fail) throw new Error("private failure detail")
          })
        }),
    })
    const discovery = {
      source: { type: "local" as const, path: "/missing" },
      state: { status: "failed" as const, error: "Import failed" },
      features: { server: true },
    } satisfies Plugin.Info
    yield* plugins.activate([generation("1")], [discovery])
    expect(yield* commands.get("runtime")).toBeDefined()
    fail = true
    yield* reload()
    yield* plugins.awaitActivation
    const inventory = yield* plugins.list()
    expect(inventory[0]?.state).toMatchObject({ status: "failed", ref: expect.stringMatching(/^err_/) })
    expect(JSON.stringify(inventory[0]?.state)).not.toContain("private failure detail")
    expect(reported.at(-1)).toBe("failed")
    expect(inventory[1]).toEqual(discovery)
    expect(yield* commands.get("runtime")).toBeUndefined()

    fail = false
    yield* plugins.activate([generation("1")], [discovery])
    expect(loads).toBe(1)
    expect(yield* commands.get("runtime")).toBeUndefined()
    yield* plugins.activate([generation("2")], [discovery])
    expect(loads).toBe(2)
    expect((yield* plugins.list())[0]?.state).toEqual({ status: "active" })
    expect(yield* commands.get("runtime")).toBeDefined()
  }),
)

it.effect("disables plugins after replay failures discovered during setup without restoring the old generation", () =>
  Effect.gen(function* () {
    const plugins = yield* Plugin.Service
    const commands = yield* Command.Service
    const cleaned = yield* Deferred.make<void>()
    const loads: string[] = []
    const generation = (revision: string): Plugin.Generation => ({
      id: "replacement",
      revision,
      effect: (ctx) =>
        Effect.gen(function* () {
          loads.push(revision)
          if (revision === "2")
            yield* Effect.addFinalizer(() =>
              plugins.awaitActivation.pipe(Effect.andThen(Deferred.succeed(cleaned, undefined))),
            )
          yield* ctx.command.transform((editor) => {
            editor.add({ name: "replacement", execute: () => Effect.void })
            if (revision === "2") throw new Error("replay failure")
          })
          if (revision === "2") {
            yield* ctx.command.list().pipe(Effect.orDie)
            yield* Effect.die("subsequent setup failure")
          }
        }),
    })
    yield* plugins.activate([generation("1")])
    yield* plugins.activate([generation("2")])
    yield* plugins.awaitActivation
    yield* Deferred.await(cleaned)
    expect(loads).toEqual(["1", "2"])
    expect((yield* plugins.list())[0]?.state).toMatchObject({
      status: "failed",
      error: expect.stringContaining("command.transform"),
    })
    expect(yield* commands.get("replacement")).toBeUndefined()
  }),
)

it.effect("does not let asynchronous plugin cleanup block recovered registry readiness", () =>
  Effect.gen(function* () {
    const plugins = yield* Plugin.Service
    const commands = yield* Command.Service
    const cleaned = yield* Deferred.make<void>()
    yield* plugins.activate([
      {
        id: "async-cleanup",
        revision: "1",
        effect: (ctx) =>
          Effect.gen(function* () {
            yield* ctx.command.transform(() => {
              throw new Error("failed")
            })
            yield* Effect.addFinalizer(() =>
              plugins.awaitActivation.pipe(Effect.andThen(Deferred.succeed(cleaned, undefined))),
            )
          }),
      },
      {
        id: "healthy",
        revision: "1",
        effect: (ctx) =>
          ctx.command
            .transform((editor) => editor.add({ name: "healthy", execute: () => Effect.void }))
            .pipe(Effect.asVoid),
      },
    ])
    yield* plugins.awaitActivation
    yield* Deferred.await(cleaned)
    expect(yield* commands.get("healthy")).toBeDefined()
    expect((yield* plugins.list())[0]?.state.status).toBe("failed")
  }),
)

it.live("retains Promise plugin groups for later registrations and ignores a disabled group's attempts", () =>
  Effect.gen(function* () {
    const plugins = yield* Plugin.Service
    const commands = yield* Command.Service
    let register = async () => {}
    const definition = fromPromise({
      id: "promise-plugin",
      setup(ctx) {
        register = async () => {
          await ctx.command.transform((editor) => {
            editor.add({ name: "late", execute: async () => {} })
            throw new Error("late Promise failure")
          })
        }
      },
    })
    yield* plugins.activate([{ ...definition, revision: "1" }])
    yield* Effect.promise(register)
    yield* plugins.awaitActivation
    expect((yield* plugins.list())[0]?.state).toMatchObject({
      status: "failed",
      error: expect.stringContaining("command.transform"),
    })
    expect(yield* commands.get("late")).toBeUndefined()
    yield* Effect.promise(register)
    expect(yield* commands.get("late")).toBeUndefined()
  }),
)

it.effect("normalizes Promise plugin API inputs through JSON", () =>
  Effect.gen(function* () {
    const plugins = yield* Plugin.Service
    const created: boolean[] = []
    yield* plugins.activate([
      {
        ...fromPromise({
          id: "promise-input",
          async setup(ctx) {
            await ctx.session.create({ title: "Promise session", agent: undefined })
            created.push(true)
          },
        }),
        revision: "1",
      },
    ])
    yield* plugins.awaitActivation

    expect(created).toEqual([true])
  }),
)

it.effect("reloading a plugin replaces its command implementation", () =>
  Effect.gen(function* () {
    const plugins = yield* Plugin.Service
    const commands = yield* Command.Service
    const output: string[] = []
    const load = (revision: string, text: string) =>
      plugins.activate([
        {
          id: "greeting",
          revision,
          effect: (ctx) =>
            ctx.command
              .transform((editor) =>
                editor.add({
                  name: "greet",
                  execute: () =>
                    Effect.sync(() => {
                      output.push(text)
                    }),
                }),
              )
              .pipe(Effect.asVoid),
        },
      ])
    const request = {
      name: "greet",
      invocation: { sessionID: Session.ID.make("ses_plugin"), prompt: { text: "" }, delivery: "steer" as const },
    }

    yield* load("1", "before")
    yield* commands.execute(request)
    expect(output).toEqual(["before"])

    yield* load("2", "after")
    yield* commands.execute(request)
    expect(output).toEqual(["before", "after"])
  }),
)

it.effect("refreshes expired OAuth credentials through the context during activation", () =>
  Effect.gen(function* () {
    const plugins = yield* Plugin.Service
    const credentials = yield* Credential.Service
    const integrations = yield* Integration.Service
    const clock = yield* Clock.Clock
    const integrationID = Integration.ID.make("refresh-fixture")
    const methodID = Integration.MethodID.make("oauth")
    const expired = Credential.OAuth.make({
      type: "oauth",
      methodID,
      access: "expired-access",
      refresh: "fixture-refresh",
      expires: (yield* Clock.currentTimeMillis) + 60_000,
    })
    const stored = yield* credentials.create({ integrationID, label: "Fixture", value: expired })
    yield* TestClock.adjust("2 minutes")
    const refreshed = Credential.OAuth.make({
      ...expired,
      access: "fresh-access",
      refresh: "rotated-refresh",
      expires: (yield* Clock.currentTimeMillis) + 3_600_000,
    })
    const refreshes: Credential.OAuth[] = []
    const resolved: Array<Credential.Value | undefined> = []

    yield* plugins.activate([
      {
        id: "oauth-refresh",
        revision: "1",
        effect: (ctx) =>
          Effect.gen(function* () {
            yield* ctx.integration.transform((editor) =>
              editor.method.update({
                integrationID,
                method: { id: methodID, type: "oauth", label: "Fixture" },
                authorize: () => Effect.die("unexpected authorization"),
                refresh: (value) =>
                  Effect.sync(() => {
                    refreshes.push(value)
                    return refreshed
                  }),
              }),
            )
            // The method registered above must be readable before the activation batch ends.
            const connection = yield* ctx.integration.connection.active(integrationID)
            if (!connection) return yield* Effect.die("fixture connection not found")
            resolved.push(yield* ctx.integration.connection.resolve(connection).pipe(Effect.orDie))
          }).pipe(
            // Plugin activation isolates ambient services, including the test clock.
            Effect.provideService(Clock.Clock, clock),
          ),
      },
    ])

    expect(yield* plugins.list()).toMatchObject([{ id: "oauth-refresh", state: { status: "active" } }])
    expect(resolved).toEqual([refreshed])
    expect((yield* credentials.get(stored.id))?.value).toEqual(refreshed)
    expect(yield* integrations.connection.resolve({ type: "credential", id: stored.id, label: stored.label })).toEqual(
      refreshed,
    )
    expect(refreshes).toEqual([expired])
  }),
)
