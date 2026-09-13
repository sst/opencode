import { describe, expect, setDefaultTimeout } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Deferred, Duration, Effect, Fiber, Layer, LayerMap, Schedule } from "effect"
import { TestClock } from "effect/testing"
import { define } from "@opencode/plugin/effect/plugin"
import { Event } from "@opencode/schema/config"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Global } from "@opencode/util/global"
import { Npm } from "@opencode/util/npm"
import { Bus } from "@opencode/core/bus"
import { Config } from "@opencode/core/config"
import { Command } from "@opencode/core/command"
import { Database } from "@opencode/core/database/database"
import { Watcher } from "@opencode/core/filesystem/watcher"
import { Instance } from "@opencode/core/instance"
import { LocationServiceMap } from "@opencode/core/location-services"
import { Location } from "@opencode/core/location"
import { Plugin } from "@opencode/core/plugin"
import { Rpc } from "@opencode/core/rpc"
import { SdkPlugins } from "@opencode/core/plugin/sdk"
import { AbsolutePath } from "@opencode/core/schema"
import { tempGlobalLayer } from "../fixture/global"
import { offlineModels } from "../fixture/models"
import { tmpdirScoped } from "../fixture/tmpdir"
import { advance } from "../lib/clock"
import { testEffect } from "../lib/effect"

// Real Location boot with plugin-directory discovery, so local plugin files are loaded and reloaded.
setDefaultTimeout(15_000)

// Package resolution can be held open so overlapping activations become observable.
const npm = {
  directory: "",
  gate: undefined as Deferred.Deferred<void> | undefined,
  inflight: 0,
  peak: 0,
}

const npmLayer = Layer.succeed(
  Npm.Service,
  Npm.Service.of({
    add: (name) => Effect.succeed({ directory: npm.directory, name }),
    resolve: (name) =>
      Effect.gen(function* () {
        npm.inflight++
        npm.peak = Math.max(npm.peak, npm.inflight)
        if (npm.gate) yield* Deferred.await(npm.gate)
        npm.inflight--
        return { directory: npm.directory, name }
      }),
    check: () => Effect.succeed(false),
    update: (name) => Effect.succeed({ directory: npm.directory, name }),
    which: () => Effect.undefined,
  }),
)

const instances = Layer.effect(
  LocationServiceMap.Service,
  Effect.gen(function* () {
    const watcher = yield* Watcher.Test
    const map = yield* LayerMap.make((ref: Location.Ref) => Instance.layer(ref, { replacements: bindings }), {
      idleTimeToLive: Duration.infinity,
    })
    const bindings: LayerNode.Replacements = [
      Global.node.replace(tempGlobalLayer),
      offlineModels,
      Npm.node.replace(npmLayer),
      Watcher.node.replace(Layer.succeed(Watcher.Service, watcher)),
      LocationServiceMap.node.replace(Layer.succeed(LocationServiceMap.Service, map)),
      Instance.node.replace(
        Layer.succeed(Instance.Service, {
          provide: (session) => Effect.provide(map.get(session.location)),
        }),
      ),
    ]
    return map
  }),
).pipe(Layer.provide(Watcher.testLayer))

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Database.node, Bus.node, SdkPlugins.node, LocationServiceMap.node]), [
    Global.node.replace(tempGlobalLayer),
    offlineModels,
    LocationServiceMap.node.replace(instances),
  ]).pipe(Layer.provideMerge(Watcher.testLayer)),
)

const greeter = (command: string) => `export default {
  id: "greeter",
  async setup(ctx) {
    await ctx.command.transform((editor) => editor.add({ name: "${command}", execute: async () => {} }))
  },
}`

// Real-time polling: reloads do filesystem work that the TestClock cannot advance.
const settle = (predicate: () => boolean, attempts = 200): Effect.Effect<void, string> =>
  Effect.suspend(() => {
    if (predicate()) return Effect.void
    if (attempts === 0) return Effect.fail("not settled")
    return Effect.promise(() => Bun.sleep(10)).pipe(Effect.andThen(settle(predicate, attempts - 1)))
  })

const failed = (plugins: Plugin.Interface) =>
  plugins.list().pipe(
    Effect.flatMap((inventory) => {
      const failure = inventory.find((plugin) => plugin.state.status === "failed" && plugin.source.type === "local")
      return failure ? Effect.succeed(failure) : Effect.fail("activation pending")
    }),
    Effect.retry({ times: 200, schedule: Schedule.spaced("25 millis") }),
  )

describe("PluginSupervisor reload", () => {
  for (const selector of ["-*", "-opencode.*", "-opencode.provider.opencode"]) {
    it.live(`keeps the managed policy source active despite ${selector}`, () =>
      Effect.gen(function* () {
        const directory = yield* tmpdirScoped()
        yield* Effect.promise(() =>
          Bun.write(path.join(directory.path, ".opencode/opencode.json"), JSON.stringify({ plugins: [selector] })),
        )
        const locations = yield* LocationServiceMap.Service
        yield* Effect.gen(function* () {
          const plugins = yield* Plugin.Service
          yield* plugins.awaitActivation
          const config = yield* Config.Service
          expect(
            (yield* config.entries()).some(
              (entry) => entry.type === "document" && entry.info.plugins?.includes(selector),
            ),
          ).toBe(true)
          const inventory = yield* plugins.list()
          expect(inventory.find((plugin) => plugin.id === "opencode.provider.opencode")?.state.status).toBe("active")
          if (selector !== "-opencode.provider.opencode")
            expect(
              inventory.some((plugin) => plugin.id === "opencode.provider.openai" && plugin.state.status === "active"),
            ).toBe(false)
        }).pipe(
          Effect.scoped,
          Effect.provide(locations.get(Location.Ref.make({ directory: AbsolutePath.make(directory.path) }))),
        )
      }),
    )
  }
  ;(
    [
      { name: "on a helper-only save", helper: "nested/helper.ts", touchEntry: false },
      { name: "when the entrypoint also changes", helper: "nested/helper.ts", touchEntry: true },
      { name: "outside the configured plugin directory", helper: "../shared/helper.ts", touchEntry: false },
    ] as const
  ).forEach((scenario) => {
    it.live(`reloads helper-defined RPC methods ${scenario.name}`, () =>
      Effect.gen(function* () {
        const directory = yield* tmpdirScoped()
        const root = path.join(directory.path, "external/greeter")
        const file = path.join(root, "index.ts")
        const helper = path.join(root, scenario.helper)
        const entry = `export { default } from ${JSON.stringify("./" + scenario.helper)}`
        const source = (version: number) => `import { Schema } from ${JSON.stringify(import.meta.resolve("effect"))}
          export default {
            id: "greeter",
            async setup(ctx) {
              await ctx.rpc.register({ id: "greeter", methods: {
                status: { input: Schema.Unknown, output: Schema.Number },
                ${version > 1 ? "info: { input: Schema.Unknown, output: Schema.Number }," : ""}
              }, events: {} }, {
                status: async () => ${version},
                ${version > 1 ? `info: async () => ${version},` : ""}
              })
              await ctx.command.transform(editor => editor.add({ name: "greet-v${version}", execute: async () => {} }))
            }
          }`
        yield* Effect.promise(async () => {
          await Bun.write(file, entry)
          await Bun.write(helper, source(1))
          await Bun.write(path.join(directory.path, ".opencode/opencode.json"), JSON.stringify({ plugins: [root] }))
        })
        const watcher = yield* Watcher.Test
        const locations = yield* LocationServiceMap.Service
        yield* Effect.gen(function* () {
          const plugins = yield* Plugin.Service
          const rpc = yield* Rpc.Service
          const commands = yield* Command.Service
          yield* plugins.awaitActivation
          expect(yield* rpc.call("greeter", "status", {})).toBe(1)
          expect(yield* rpc.call("greeter", "info", {}).pipe(Effect.flip)).toMatchObject({
            type: "rpc.method_not_found",
          })

          yield* Effect.promise(async () => {
            await Bun.write(helper, source(2))
            if (scenario.touchEntry) {
              await Bun.write(file, entry + "; // updated entry")
              await fs.utimes(file, new Date(), new Date(Date.now() + 1000))
            }
          })
          yield* watcher.emit({ path: scenario.touchEntry ? file : helper, type: "update" })
          yield* rpc
            .call("greeter", "info", {})
            .pipe(Effect.retry({ times: 80, schedule: Schedule.spaced("25 millis") }))
          expect(yield* rpc.call("greeter", "info", {})).toBe(2)
          expect(yield* commands.get("greet-v1")).toBeUndefined()
          expect(yield* commands.get("greet-v2")).toBeDefined()

          // Failed helper evaluations retain the active registration and recover on the next save.
          yield* Effect.promise(() => Bun.write(helper, 'throw new Error("broken helper"); export default {}'))
          yield* watcher.emit({ path: helper, type: "update" })
          yield* failed(plugins)
          expect(yield* rpc.call("greeter", "info", {})).toBe(2)
          yield* Effect.promise(() => Bun.write(helper, source(3)))
          yield* watcher.emit({ path: helper, type: "update" })
          yield* commands.get("greet-v3").pipe(
            Effect.flatMap((command) => (command ? Effect.void : Effect.fail("activation pending"))),
            Effect.retry({ times: 80, schedule: Schedule.spaced("25 millis") }),
          )
          expect(yield* rpc.call("greeter", "info", {})).toBe(3)
          expect(yield* commands.get("greet-v2")).toBeUndefined()
        }).pipe(
          Effect.scoped,
          Effect.provide(locations.get(Location.Ref.make({ directory: AbsolutePath.make(directory.path) }))),
        )
      }),
    )
  })
  ;(["discovered", "configured"] as const).forEach((mode) => {
    it.effect(`retains a ${mode} plugin change during initial activation`, () =>
      Effect.gen(function* () {
        const directory = yield* tmpdirScoped()
        const file = path.join(
          directory.path,
          mode === "discovered" ? ".opencode/plugins/greeter.ts" : "external/greeter/index.ts",
        )
        yield* Effect.promise(async () => {
          await Bun.write(file, greeter("greet-v1"))
          await fs.utimes(file, new Date(0), new Date(0))
          if (mode === "configured") {
            await Bun.write(
              path.join(directory.path, ".opencode/opencode.json"),
              JSON.stringify({ plugins: [path.dirname(file)] }),
            )
          }
        })
        const entered = yield* Deferred.make<void>()
        const gate = yield* Deferred.make<void>()
        const sdk = yield* SdkPlugins.Service
        yield* sdk.register(
          define({
            id: "gated",
            effect: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(gate))),
          }),
        )
        const watcher = yield* Watcher.Test
        const locations = yield* LocationServiceMap.Service
        yield* Effect.gen(function* () {
          const plugins = yield* Plugin.Service
          const commands = yield* Command.Service
          yield* Deferred.await(entered)
          // The real ConfigPluginSource merges config-root changes and configured-path watches.
          // Emit while setup is blocked, without a bus event that could mask a lost source trigger.
          yield* Effect.promise(async () => {
            await Bun.write(file, greeter("greet-v2"))
            await fs.utimes(file, new Date(), new Date())
          })
          yield* watcher.emit({ path: file, type: "update" })
          const ready = yield* plugins.awaitActivation.pipe(Effect.forkScoped({ startImmediately: true }))
          yield* Deferred.succeed(gate, undefined)
          yield* advance(() => ready.pollUnsafe() !== undefined)
          yield* Fiber.join(ready)

          expect(yield* commands.get("greet-v1")).toBeUndefined()
          expect(yield* commands.get("greet-v2")).toBeDefined()
        }).pipe(
          Effect.scoped,
          Effect.provide(locations.get(Location.Ref.make({ directory: AbsolutePath.make(directory.path) }))),
        )
      }),
    )
  })

  it.live("keeps the running generation when an updated local plugin fails to import", () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped()
      const file = path.join(directory.path, ".opencode/plugins/greeter.ts")
      // Local plugin revisions key on mtime, so give each rewrite a distinct timestamp.
      const write = (content: string, mtime: Date) =>
        Effect.promise(async () => {
          await Bun.write(file, content)
          await fs.utimes(file, mtime, mtime)
        })
      yield* write(greeter("greet-v1"), new Date(Date.now() - 60_000))
      const bus = yield* Bus.Service
      const locations = yield* LocationServiceMap.Service
      yield* Effect.gen(function* () {
        const plugins = yield* Plugin.Service
        const commands = yield* Command.Service
        yield* plugins.awaitActivation
        expect(yield* commands.get("greet-v1")).toBeDefined()

        yield* write("export default {", new Date())
        yield* bus.publish(Event.Updated, {})
        const failure = yield* failed(plugins)

        expect(failure).toMatchObject({ source: { type: "local", path: file }, state: { status: "failed" } })
        // The broken revision never produced a generation, so the previous one keeps running.
        expect(yield* commands.get("greet-v1")).toBeDefined()
        expect(yield* plugins.list()).toContainEqual(
          expect.objectContaining({
            id: "greeter",
            source: { type: "local", path: file },
            state: { status: "active" },
          }),
        )
      }).pipe(
        Effect.scoped,
        Effect.provide(locations.get(Location.Ref.make({ directory: AbsolutePath.make(directory.path) }))),
      )
    }),
  )

  it.effect("serializes the periodic refresh behind an in-flight reload", () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped()
      npm.directory = path.join(directory.path, "fixture-pkg")
      npm.gate = undefined
      npm.peak = 0
      yield* Effect.promise(() =>
        Bun.write(
          path.join(npm.directory, "package.json"),
          JSON.stringify({ name: "fixture-pkg", exports: { "./server": "./server.ts" } }),
        ),
      )
      yield* Effect.promise(() => Bun.write(path.join(npm.directory, "server.ts"), greeter("greet-pkg")))
      yield* Effect.promise(() =>
        Bun.write(path.join(directory.path, ".opencode/opencode.json"), JSON.stringify({ plugins: ["fixture-pkg"] })),
      )
      const bus = yield* Bus.Service
      const locations = yield* LocationServiceMap.Service
      yield* Effect.gen(function* () {
        const plugins = yield* Plugin.Service
        const commands = yield* Command.Service
        yield* TestClock.adjust("100 millis")
        yield* plugins.awaitActivation
        expect(yield* commands.get("greet-pkg")).toBeDefined()
        expect(npm.peak).toBe(1)

        // Hold the next resolve open, then let the 24 hour refresh fire while it is blocked.
        const gate = yield* Deferred.make<void>()
        npm.gate = gate
        npm.inflight = 0
        npm.peak = 0
        yield* bus.publish(Event.Updated, {})
        yield* TestClock.adjust("100 millis")
        yield* settle(() => npm.inflight === 1)
        yield* TestClock.adjust("24 hours")
        // Without serialization the refresh resolves concurrently with the held reload and the peak reaches 2.
        yield* settle(() => npm.peak > 1, 50).pipe(Effect.ignore)
        const peak = npm.peak
        yield* Deferred.succeed(gate, undefined)
        npm.gate = undefined
        yield* TestClock.adjust("100 millis")
        yield* plugins.awaitActivation

        expect(peak).toBe(1)
      }).pipe(
        Effect.scoped,
        Effect.provide(locations.get(Location.Ref.make({ directory: AbsolutePath.make(directory.path) }))),
      )
    }),
  )
})
