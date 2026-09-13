import path from "path"
import fs from "fs/promises"
import { describe, expect, test } from "bun:test"
import { Effect, Fiber, Layer, Logger, Schema, Stream } from "effect"
import { FastCheck } from "effect/testing"
import { Config } from "@opencode/core/config"
import { AgentsDirectory, Directory, Document, Event, Info } from "@opencode/schema/config"
import { ConfigModel } from "@opencode/schema/config/model"
import { ConfigProvider } from "@opencode/schema/config/provider"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Credential } from "@opencode/core/credential"
import { ConfigMigrateV1 } from "@opencode/core/v1/config/migrate"
import { ConfigV1 } from "@opencode/core/v1/config/config"
import { ConfigNormalize } from "@opencode/core/config/normalize"
import { Watcher } from "@opencode/core/filesystem/watcher"
import { Bus } from "@opencode/core/bus"
import { Global } from "@opencode/util/global"
import { Location } from "@opencode/core/location"
import { Project } from "@opencode/core/project"
import { Provider } from "@opencode/core/provider"
import { AbsolutePath } from "@opencode/core/schema"
import { WellKnown } from "@opencode/core/wellknown"
import { Integration } from "@opencode/schema/integration"
import { emptyCredentialNode, emptyWellknownNode } from "../fixture/config-nodes"
import { location } from "../fixture/location"
import { tmpdir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.empty)
const selection = Schema.decodeUnknownSync(ConfigModel.Selection)

function inFixture(root: string, target: string) {
  const relative = path.relative(root, target)
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

function testLayer(
  directory: string,
  globalDirectory = path.join(directory, "global"),
  projectDirectory = directory,
  vcs?: Project.Vcs,
  watcher: Layer.Layer<Watcher.Service | Watcher.Test> = Watcher.testLayer,
  credentialNode = emptyCredentialNode,
  wellknownNode = emptyWellknownNode,
  options?: Config.Options,
) {
  const locationLayer = Layer.succeed(
    Location.Service,
    Location.Service.of(
      location(
        { directory: AbsolutePath.make(directory) },
        { projectDirectory: AbsolutePath.make(projectDirectory), vcs },
      ),
    ),
  )
  const built = AppNodeBuilder.build(LayerNode.group([Config.node, Bus.node]), [
    Config.node.replace(Config.configured(options)),
    Location.node.replace(locationLayer),
    Global.node.replace(Global.layerWith({ config: globalDirectory, home: path.join(globalDirectory, "home") })),
    Credential.node.replace(credentialNode),
    WellKnown.node.replace(wellknownNode),
    Watcher.node.replace(watcher),
  ])
  // Merge the watcher layer by reference so Watcher.Test resolves to the same
  // memoized instance the built graph uses.
  return Layer.mergeAll(built, watcher)
}

const provider = {
  package: "native",
  settings: {},
  headers: {},
  body: {},
  models: {},
}

describe("Config", () => {
  it.live("excludes home-level claude and agents directories when global is disabled", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) => {
        const global = path.join(tmp.path, "global")
        const home = path.join(global, "home")
        const project = path.join(home, "project")
        const ambient = (entries: readonly { type: string }[]) =>
          entries.filter((entry) => entry.type === "claude" || entry.type === "agents")
        return Effect.promise(() =>
          Promise.all([
            fs.mkdir(project, { recursive: true }),
            fs.mkdir(path.join(home, ".claude"), { recursive: true }),
            fs.mkdir(path.join(home, ".agents"), { recursive: true }),
          ]),
        ).pipe(
          Effect.andThen(
            Effect.gen(function* () {
              // The fixture is real: with global enabled the walk finds both.
              const config = yield* Config.Service
              expect(ambient(yield* config.entries()).length).toBe(2)
            }).pipe(Effect.provide(testLayer(project, global))),
          ),
          Effect.andThen(
            // Home-level directories are global config however the walk
            // reaches them, so global: false excludes them even with the
            // project walk enabled.
            Effect.gen(function* () {
              const config = yield* Config.Service
              expect(ambient(yield* config.entries())).toEqual([])
              const watcher = yield* Watcher.Test
              expect(
                (yield* watcher.subscriptions()).filter((watch) => watch.type === "entries" && watch.path === home),
              ).toEqual([])
            }).pipe(
              Effect.provide(
                testLayer(project, global, project, undefined, undefined, undefined, undefined, { global: false }),
              ),
            ),
          ),
        )
      }),
    ),
  )

  it.live("excludes global config reached through the project walk when global is disabled", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) => {
        // The location sits BENEATH the global config dir, so the upward walk
        // reaches the global opencode.json as a direct file.
        const global = path.join(tmp.path, "global")
        const project = path.join(global, "plugins", "demo")
        return Effect.promise(async () => {
          await fs.mkdir(project, { recursive: true })
          await fs.writeFile(path.join(global, "opencode.json"), JSON.stringify({ shell: "global-sentinel" }))
        }).pipe(
          Effect.andThen(
            // Fixture control: with global enabled the file loads.
            Effect.gen(function* () {
              const config = yield* Config.Service
              expect(Config.latest(yield* config.entries(), "shell")).toBe("global-sentinel")
            }).pipe(Effect.provide(testLayer(project, global))),
          ),
          Effect.andThen(
            Effect.gen(function* () {
              const config = yield* Config.Service
              expect(Config.latest(yield* config.entries(), "shell")).toBeUndefined()
            }).pipe(
              Effect.provide(
                testLayer(project, global, project, undefined, undefined, undefined, undefined, { global: false }),
              ),
            ),
          ),
        )
      }),
    ),
  )

  it.live("discovers the global config directory once when the project walk reaches it", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) => {
        // The global config dir is the project's own .opencode (as isolated
        // hosts pin OPENCODE_CONFIG_DIR), and the location is the project under
        // a symlinked spelling, so the walk reaches the same directory under a
        // different string than the global root.
        const real = path.join(tmp.path, "real")
        const link = path.join(tmp.path, "link")
        const global = AbsolutePath.make(path.join(real, ".opencode"))
        const once = Effect.gen(function* () {
          const config = yield* Config.Service
          const watcher = yield* Watcher.Test
          const entries = yield* config.entries()
          expect(entries.flatMap((entry) => (entry.type === "directory" ? [entry.path] : []))).toEqual([global])
          expect(entries.flatMap((entry) => (entry.type === "document" ? [entry.info.shell] : []))).toEqual(["global"])
          expect(
            (yield* watcher.subscriptions())
              .filter((subscription) => subscription.type === "directory")
              .map((subscription) => subscription.path),
          ).toEqual([global])
          expect(
            (yield* watcher.subscriptions()).filter((subscription) =>
              subscription.path.includes(`${path.sep}.opencode${path.sep}`),
            ),
          ).toEqual([])
        })
        return Effect.promise(async () => {
          await fs.mkdir(global, { recursive: true })
          await fs.writeFile(path.join(global, "opencode.json"), JSON.stringify({ shell: "global" }))
          await fs.symlink(real, link, process.platform === "win32" ? "junction" : undefined)
        }).pipe(
          Effect.andThen(once.pipe(Effect.provide(testLayer(link, global, real)))),
          // Same spelling on both sides: still exactly once.
          Effect.andThen(once.pipe(Effect.provide(testLayer(real, global, real)))),
        )
      }),
    ),
  )

  it.live("loads explicit file and content overrides in priority order", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) => {
        const global = path.join(tmp.path, "global")
        const project = path.join(tmp.path, "project")
        const explicit = path.join(tmp.path, "custom.json")
        return Effect.promise(async () => {
          await fs.mkdir(global, { recursive: true })
          await fs.mkdir(project, { recursive: true })
          await fs.writeFile(path.join(global, "opencode.json"), JSON.stringify({ shell: "global" }))
          await fs.writeFile(explicit, JSON.stringify({ shell: "explicit" }))
          await fs.writeFile(path.join(project, "opencode.json"), JSON.stringify({ shell: "project" }))
        }).pipe(
          Effect.andThen(
            Effect.gen(function* () {
              const config = yield* Config.Service
              const entries = yield* config.entries()
              expect(
                entries.flatMap((entry) => (entry.type === "document" && entry.info.shell ? [entry.info.shell] : [])),
              ).toEqual(["global", "explicit", "project", "content"])
              expect(Config.latest(entries, "shell")).toBe("content")
            }).pipe(
              Effect.provide(
                testLayer(project, global, project, undefined, undefined, emptyCredentialNode, emptyWellknownNode, {
                  file: explicit,
                  content: JSON.stringify({ shell: "content" }),
                }),
              ),
            ),
          ),
        )
      }),
    ),
  )

  it.live("skips project configuration when project discovery is disabled", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) => {
        const global = path.join(tmp.path, "global")
        const project = path.join(tmp.path, "project")
        return Effect.promise(async () => {
          await fs.mkdir(global, { recursive: true })
          await fs.mkdir(project, { recursive: true })
          await fs.writeFile(path.join(global, "opencode.json"), JSON.stringify({ shell: "global" }))
          await fs.writeFile(path.join(project, "opencode.json"), JSON.stringify({ shell: "project" }))
        }).pipe(
          Effect.andThen(
            Effect.gen(function* () {
              const config = yield* Config.Service
              expect(Config.latest(yield* config.entries(), "shell")).toBe("global")
              const watcher = yield* Watcher.Test
              expect((yield* watcher.subscriptions()).map((subscription) => subscription.path)).toEqual([global])
            }).pipe(
              Effect.provide(
                testLayer(project, global, project, undefined, undefined, emptyCredentialNode, emptyWellknownNode, {
                  project: false,
                }),
              ),
            ),
          ),
        )
      }),
    ),
  )

  it.live("reloads file substitutions when their source changes", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const global = path.join(tmp.path, "global")
          const project = path.join(tmp.path, "project")
          const file = path.join(global, "opencode.json")
          const source = path.join(global, "shell.txt")
          yield* Effect.promise(async () => {
            await fs.mkdir(global, { recursive: true })
            await fs.mkdir(project, { recursive: true })
            await fs.writeFile(source, "first")
            await fs.writeFile(file, JSON.stringify({ shell: "{file:shell.txt}" }))
          })
          return yield* Effect.gen(function* () {
            const config = yield* Config.Service
            const bus = yield* Bus.Service
            const watcher = yield* Watcher.Test
            const changed = yield* bus
              .subscribe(Event.Updated)
              .pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
            yield* Effect.sleep("10 millis")

            yield* Effect.promise(() => fs.writeFile(source, "second"))
            yield* watcher.emit({ type: "update", path: source })

            expect(yield* Fiber.join(changed)).toHaveLength(1)
            expect(Config.latest(yield* config.entries(), "shell")).toBe("second")
          }).pipe(Effect.provide(testLayer(project, global, project, undefined, Watcher.testLayer)))
        }),
      ),
    ),
  )

  it.live("excludes missing files under symlinked global roots when global is disabled", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) => {
        const global = path.join(tmp.path, "global")
        const link = path.join(tmp.path, "link")
        const project = path.join(link, "plugins", "demo")
        return Effect.promise(async () => {
          await fs.mkdir(path.join(global, "plugins", "demo"), { recursive: true })
          await fs.symlink(global, link, process.platform === "win32" ? "junction" : undefined)
        }).pipe(
          Effect.andThen(
            Effect.gen(function* () {
              const watcher = yield* Watcher.Test
              const subscriptions = yield* watcher.subscriptions()
              expect(subscriptions.length).toBeGreaterThan(0)
              expect(
                subscriptions.filter((item) => inFixture(global, item.path) || inFixture(link, item.path)),
              ).toEqual([])
            }).pipe(
              Effect.provide(
                testLayer(project, global, project, undefined, undefined, undefined, undefined, { global: false }),
              ),
            ),
          ),
        )
      }),
    ),
  )

  it.live("exposes filesystem updates under config roots through changes", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const global = path.join(tmp.path, "global")
          const project = path.join(tmp.path, "project")
          yield* Effect.promise(async () => {
            await fs.mkdir(path.join(global, "commands"), { recursive: true })
            await fs.mkdir(project, { recursive: true })
          })
          return yield* Effect.gen(function* () {
            const config = yield* Config.Service
            const watcher = yield* Watcher.Test
            const received = yield* config
              .changes()
              .pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped({ startImmediately: true }))
            yield* Effect.sleep("10 millis")

            const file = path.join(global, "commands", "review.md")
            yield* watcher.emit({ type: "update", path: file })

            const collected = yield* Fiber.join(received).pipe(Effect.timeout("1 second"))
            expect(Array.from(collected)).toEqual([{ type: "update", path: file }])
          }).pipe(Effect.provide(testLayer(project, global, project, undefined, Watcher.testLayer)))
        }),
      ),
    ),
  )

  // Real watcher on purpose: the regression this pins (a deleted config file's
  // watch being torn down, making recreation invisible) only reproduces with
  // path-faithful event delivery.
  it.live("keeps watching a deleted config file so recreating it reloads", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const global = path.join(tmp.path, "global")
          const project = path.join(tmp.path, "project")
          const file = path.join(project, "opencode.json")
          yield* Effect.promise(async () => {
            await fs.mkdir(global, { recursive: true })
            await fs.mkdir(project, { recursive: true })
            await fs.writeFile(file, JSON.stringify({ shell: "one" }))
          })
          return yield* Effect.gen(function* () {
            const config = yield* Config.Service
            const bus = yield* Bus.Service
            expect(Config.latest(yield* config.entries(), "shell")).toBe("one")
            yield* Effect.sleep("10 millis")

            const removed = yield* bus
              .subscribe(Event.Updated)
              .pipe(Stream.take(1), Stream.runDrain, Effect.forkScoped({ startImmediately: true }))
            yield* Effect.promise(() => fs.rm(file))
            yield* Fiber.join(removed).pipe(Effect.timeout("5 seconds"))
            expect(Config.latest(yield* config.entries(), "shell")).toBeUndefined()

            const recreated = yield* bus
              .subscribe(Event.Updated)
              .pipe(Stream.take(1), Stream.runDrain, Effect.forkScoped({ startImmediately: true }))
            yield* Effect.promise(() => fs.writeFile(file, JSON.stringify({ shell: "two" })))
            yield* Fiber.join(recreated).pipe(Effect.timeout("5 seconds"))
            expect(Config.latest(yield* config.entries(), "shell")).toBe("two")
          }).pipe(
            Effect.provide(
              AppNodeBuilder.build(LayerNode.group([Config.node, Bus.node]), [
                Location.node.replace(
                  Layer.succeed(
                    Location.Service,
                    Location.Service.of(location({ directory: AbsolutePath.make(project) })),
                  ),
                ),
                Global.node.replace(Global.layerWith({ config: global, home: path.join(global, "home") })),
                Credential.node.replace(emptyCredentialNode),
                WellKnown.node.replace(emptyWellknownNode),
              ]),
            ),
          )
        }),
      ),
    ),
  )

  it.effect("backs Config.Service and Config.Test with one shared test implementation", () =>
    Effect.gen(function* () {
      const config = yield* Config.Service
      const test = yield* Config.Test
      expect(yield* config.entries()).toEqual([])

      const entry = new Document({ type: "document", info: new Info({}) })
      yield* test.setEntries([entry])
      expect(yield* config.entries()).toEqual([entry])

      const received = yield* config
        .changes()
        .pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped({ startImmediately: true }))
      yield* Effect.yieldNow
      yield* test.emitChange({ type: "create", path: "/root/commands/review.md" })
      expect(Array.from(yield* Fiber.join(received))).toEqual([{ type: "create", path: "/root/commands/review.md" }])
    }).pipe(Effect.provide(Config.testLayer())),
  )

  test("returns the latest defined scalar from priority-ordered documents", () => {
    const entries = [
      new Document({
        type: "document",
        info: new Info({ model: selection("openrouter/openai/gpt-5") }),
      }),
      new Directory({ type: "directory", path: AbsolutePath.make("/skills") }),
      new AgentsDirectory({ type: "agents", path: AbsolutePath.make("/agents") }),
      new Document({ type: "document", info: new Info({}) }),
      new Document({
        type: "document",
        info: new Info({ model: selection("openrouter/openai/gpt-5.5") }),
      }),
    ]

    expect(Config.latest(entries, "model")).toEqual(selection("openrouter/openai/gpt-5.5"))
    expect(Config.latest(entries, "default_agent")).toBeUndefined()
  })

  it.live("tolerates unavailable authenticated wellknown config and reloads it later", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const global = path.join(tmp.path, "global")
          const project = path.join(tmp.path, "project")
          yield* Effect.promise(async () => {
            await fs.mkdir(global, { recursive: true })
            await fs.mkdir(project, { recursive: true })
            await fs.writeFile(path.join(global, "opencode.json"), JSON.stringify({ shell: "global" }))
            await fs.writeFile(path.join(project, "opencode.json"), JSON.stringify({ shell: "project" }))
          })

          const integrationID = Integration.ID.make("https://example.com")
          let available = false
          let key = "secret"
          const credentialNode = makeGlobalNode({
            service: Credential.Service,
            layer: Layer.succeed(
              Credential.Service,
              Credential.Service.of({
                all: () => Effect.die("unused Credential.all"),
                list: () =>
                  Effect.succeed([
                    new Credential.Info({
                      id: Credential.ID.create(),
                      integrationID,
                      label: "default",
                      value: Credential.Key.make({ type: "key", key }),
                    }),
                  ]),
                get: () => Effect.die("unused Credential.get"),
                create: () => Effect.die("unused Credential.create"),
                activate: () => Effect.die("unused Credential.activate"),
                update: () => Effect.die("unused Credential.update"),
                remove: () => Effect.die("unused Credential.remove"),
              }),
            ),
            deps: [],
          })
          const entry: WellKnown.Entry = {
            origin: "https://example.com",
            integrationID,
            manifest: { auth: { command: ["login"], env: "TOKEN" } },
          }
          const wellknownNode = makeGlobalNode({
            service: WellKnown.Service,
            layer: Layer.succeed(
              WellKnown.Service,
              WellKnown.Service.of({
                entries: () => Effect.succeed([entry]),
                snapshot: () => [entry],
                refresh: () => Effect.succeed(false),
                add: () => Effect.die("unused Wellknown.add"),
                remove: () => Effect.die("unused Wellknown.remove"),
                resolve: (_entry, variables) =>
                  available
                    ? Effect.succeed([{ shell: variables.TOKEN }])
                    : Effect.fail(new Error("expired credential")),
              }),
            ),
            deps: [],
          })

          return yield* Effect.gen(function* () {
            const config = yield* Config.Service
            const bus = yield* Bus.Service
            const initial = yield* config.entries()
            expect(Config.latest(initial, "shell")).toBe("project")
            expect(
              initial.flatMap((entry) => (entry.type === "document" && entry.info.shell ? [entry.info.shell] : [])),
            ).toEqual(["global", "project"])
            const updated = yield* bus
              .subscribe(Event.Updated)
              .pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
            yield* Effect.yieldNow
            available = true
            key = "next"
            yield* bus.publish(
              Credential.Event.Switched,
              { credentialID: Credential.ID.create(), integrationID },
              { global: true },
            )
            expect(yield* Fiber.join(updated)).toHaveLength(1)
            const refreshed = yield* config.entries()
            expect(Config.latest(refreshed, "shell")).toBe("project")
            expect(
              refreshed.flatMap((entry) => (entry.type === "document" && entry.info.shell ? [entry.info.shell] : [])),
            ).toEqual(["next", "global", "project"])
          }).pipe(
            Effect.provide(testLayer(project, global, project, undefined, undefined, credentialNode, wellknownNode)),
          )
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("logs redacted source-aware diagnostics for every config source", () => {
    const output: Array<Record<string, unknown>> = []
    const logger = Logger.map(Logger.formatStructured, (entry) => {
      if (!Array.isArray(entry.message) || entry.message[0] !== "configuration normalization diagnostic") return
      const details = entry.message[1]
      if (typeof details === "object" && details !== null) output.push(details as Record<string, unknown>)
    })
    return Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const global = path.join(tmp.path, "global")
          const project = path.join(tmp.path, "project")
          const malformed = path.join(tmp.path, "malformed.json")
          yield* Effect.promise(async () => {
            await fs.mkdir(global, { recursive: true })
            await fs.mkdir(project, { recursive: true })
            await fs.writeFile(path.join(global, "opencode.json"), "null")
            await fs.writeFile(path.join(project, "opencode.json"), "")
            await fs.writeFile(malformed, '{ "credential": "file-secret"')
          })
          const integrationID = Integration.ID.make("https://invalid.example.com")
          const entry: WellKnown.Entry = {
            origin: "https://invalid.example.com",
            integrationID,
            manifest: { auth: { command: ["login"], env: "TOKEN" } },
          }
          const credentialNode = makeGlobalNode({
            service: Credential.Service,
            layer: Layer.succeed(
              Credential.Service,
              Credential.Service.of({
                all: () => Effect.die("unused Credential.all"),
                list: () =>
                  Effect.succeed([
                    new Credential.Info({
                      id: Credential.ID.create(),
                      integrationID,
                      label: "default",
                      value: Credential.Key.make({ type: "key", key: "wellknown-secret" }),
                    }),
                  ]),
                get: () => Effect.die("unused Credential.get"),
                create: () => Effect.die("unused Credential.create"),
                activate: () => Effect.die("unused Credential.activate"),
                update: () => Effect.die("unused Credential.update"),
                remove: () => Effect.die("unused Credential.remove"),
              }),
            ),
            deps: [],
          })
          const wellknownNode = makeGlobalNode({
            service: WellKnown.Service,
            layer: Layer.succeed(
              WellKnown.Service,
              WellKnown.Service.of({
                entries: () => Effect.succeed([entry]),
                snapshot: () => [entry],
                refresh: () => Effect.succeed(false),
                add: () => Effect.die("unused Wellknown.add"),
                remove: () => Effect.die("unused Wellknown.remove"),
                // Exercise the loader boundary against a malformed implementation response.
                resolve: () => Effect.succeed([null as unknown as WellKnown.Config]),
              }),
            ),
            deps: [],
          })

          yield* Config.Service.use((config) => config.entries()).pipe(
            Effect.provide(
              testLayer(project, global, project, undefined, undefined, credentialNode, wellknownNode, {
                file: malformed,
                content: "",
              }),
            ),
          )

          expect(output.map((item) => `${item.source}:${item.path}:${item.kind}`).toSorted()).toEqual(
            [
              `${path.join(global, "opencode.json")}:$:invalid`,
              `${path.join(project, "opencode.json")}:$:invalid`,
              `${malformed}:$:invalid`,
              "https://invalid.example.com:$:invalid",
              "OPENCODE_CONFIG_CONTENT:$:invalid",
            ].toSorted(),
          )
          expect(JSON.stringify(output)).not.toContain("secret")
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(Effect.provide(Logger.layer([logger])))
  })

  test("migrates arbitrary v1 configuration into valid v2 configuration", () => {
    FastCheck.assert(
      FastCheck.property(Schema.toArbitrary(ConfigV1.Info)(FastCheck), (info) => {
        const parsed = Schema.decodeUnknownSync(ConfigV1.Info)(
          Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))(
            Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown))(info),
          ),
        )
        Schema.decodeUnknownSync(Info)(ConfigMigrateV1.migrate(parsed), { errors: "all" })
      }),
      { numRuns: 100 },
    )
  }, 30_000)

  test("migrates the v1 experimental subagent depth", () => {
    expect(ConfigMigrateV1.migrate({ experimental: { subagent_depth: 2 } }).experimental?.subagent_depth).toBe(2)
  })

  test("migrates the v1 small model to the title agent", () => {
    expect(
      ConfigMigrateV1.migrate({
        small_model: "anthropic/claude-haiku-4-5",
        agent: { title: { prompt: "Custom title prompt" } },
      }).agents?.title,
    ).toEqual({
      model: { providerID: "anthropic", model: "claude-haiku-4-5" },
      system: "Custom title prompt",
    })
  })

  test("migrates the v1 update policy", () => {
    expect(ConfigMigrateV1.migrate({ autoupdate: false }).update).toBe("disable")
    expect(ConfigMigrateV1.migrate({ autoupdate: "notify" }).update).toBe("notify")
    expect(ConfigMigrateV1.migrate({ autoupdate: true }).update).toBe("auto")
    expect(ConfigMigrateV1.migrate({}).update).toBeUndefined()
  })

  test("normalizes the native auto update policy", () => {
    expect(ConfigNormalize.normalize({ update: "auto" })).toEqual({
      type: "normalized",
      encoded: { update: "auto" },
      diagnostics: [],
    })
  })

  test("migrates v1 provider lists to policies", () => {
    expect(
      ConfigMigrateV1.migrate({
        enabled_providers: ["anthropic", "openai"],
        disabled_providers: ["openai"],
      }).experimental?.policies,
    ).toEqual([
      { action: "provider.use", resource: "*", effect: "deny" },
      { action: "provider.use", resource: "anthropic", effect: "allow" },
      { action: "provider.use", resource: "openai", effect: "allow" },
      { action: "provider.use", resource: "openai", effect: "deny" },
    ])
    expect(ConfigMigrateV1.migrate({ enabled_providers: [] }).experimental?.policies).toEqual([
      { action: "provider.use", resource: "*", effect: "deny" },
    ])
  })

  test("migrates v1 provider setup options into AISDK settings", () => {
    const migrated = ConfigMigrateV1.migrate({
      provider: {
        bedrock: {
          npm: "@ai-sdk/amazon-bedrock",
          models: { claude: { provider: { npm: "@ai-sdk/anthropic" } } },
          options: {
            headers: { "x-test": "1" },
            body: { trace: true },
            region: "us-east-1",
            profile: "dev",
          },
        },
      },
    })

    expect(migrated.providers?.bedrock).toMatchObject({
      package: Provider.aisdk("@ai-sdk/amazon-bedrock"),
      models: { claude: { package: Provider.aisdk("@ai-sdk/anthropic") } },
      settings: { region: "us-east-1", profile: "dev" },
      headers: { "x-test": "1" },
      body: { trace: true },
    })
  })

  test("renames old provider IDs while migrating v1 configuration", () => {
    const migrated = ConfigMigrateV1.migrate({
      model: "azure-cognitive-services/deployment",
      enabled_providers: ["google-vertex-anthropic"],
      disabled_providers: ["azure-cognitive-services"],
      agent: {
        reviewer: { model: "google-vertex-anthropic/claude-sonnet" },
      },
      command: {
        review: { template: "Review", model: "azure-cognitive-services/deployment" },
      },
      provider: {
        "azure-cognitive-services": {
          npm: "@ai-sdk/azure",
          env: ["AZURE_COGNITIVE_SERVICES_RESOURCE_NAME", "AZURE_COGNITIVE_SERVICES_API_KEY"],
          models: { deployment: {} },
        },
        "google-vertex-anthropic": {
          npm: "@ai-sdk/google-vertex/anthropic",
          options: { project: "test-project", location: "us-central1" },
          models: { "claude-sonnet": {} },
        },
      },
    })

    expect(migrated.model).toEqual({ providerID: "azure", model: "deployment" })
    expect(migrated.agents?.reviewer?.model).toEqual({ providerID: "google-vertex", model: "claude-sonnet" })
    expect(migrated.commands?.review?.model).toEqual({ providerID: "azure", model: "deployment" })
    expect(migrated.experimental?.policies).toEqual([
      { action: "provider.use", resource: "*", effect: "deny" },
      { action: "provider.use", resource: "google-vertex", effect: "allow" },
      { action: "provider.use", resource: "azure", effect: "deny" },
    ])
    expect(migrated.providers?.azure).toMatchObject({
      env: ["AZURE_COGNITIVE_SERVICES_API_KEY"],
      package: Provider.aisdk("@ai-sdk/azure"),
      models: { deployment: {} },
    })
    expect(migrated.providers?.["azure-cognitive-services"]).toBeUndefined()
    expect(migrated.providers?.["google-vertex"]).toMatchObject({
      settings: { project: "test-project", location: "us-central1" },
      models: {
        "claude-sonnet": { package: Provider.aisdk("@ai-sdk/google-vertex/anthropic") },
      },
    })
    expect(migrated.providers?.["google-vertex"]).not.toHaveProperty("package")
    expect(migrated.providers?.["google-vertex-anthropic"]).toBeUndefined()
  })

  test("preserves the generated base URL for v1 Azure OpenAI-compatible providers", () => {
    const migrated = ConfigMigrateV1.migrate({
      provider: {
        "azure-cognitive-services": {
          npm: "@ai-sdk/openai-compatible",
          env: ["AZURE_COGNITIVE_SERVICES_RESOURCE_NAME", "AZURE_COGNITIVE_SERVICES_API_KEY"],
        },
      },
    })

    expect(migrated.providers?.azure).toMatchObject({
      env: ["AZURE_COGNITIVE_SERVICES_API_KEY"],
      package: Provider.aisdk("@ai-sdk/openai-compatible"),
      settings: {
        baseURL: "https://${AZURE_COGNITIVE_SERVICES_RESOURCE_NAME}.cognitiveservices.azure.com/openai",
      },
    })
  })

  test("ignores old provider IDs when the current provider ID is configured", () => {
    const migrated = ConfigMigrateV1.migrate({
      provider: {
        azure: { models: { current: {} } },
        "azure-cognitive-services": { models: { legacy: {} } },
        "google-vertex": { models: { gemini: {} } },
        "google-vertex-anthropic": { models: { claude: {} } },
      },
    })

    expect(migrated.providers?.azure?.models).toEqual({ current: expect.anything() })
    expect(migrated.providers?.["google-vertex"]?.models).toEqual({ gemini: expect.anything() })
  })

  test("preserves the built-in package for v1 Vertex Anthropic custom models", () => {
    const migrated = ConfigMigrateV1.migrate({
      provider: {
        "google-vertex-anthropic": {
          models: { claude: {} },
        },
      },
    })

    expect(migrated.providers?.["google-vertex"]?.package).toBeUndefined()
    expect(migrated.providers?.["google-vertex"]?.models?.claude?.package).toBe(
      Provider.aisdk("@ai-sdk/google-vertex/anthropic"),
    )
  })

  test("migrates v1 interleaved fields to compatibility", () => {
    const migrated = ConfigMigrateV1.migrate({
      provider: {
        custom: {
          models: {
            object: { interleaved: { field: "vendor_reasoning" } },
            string: { interleaved: "reasoning_text" },
            boolean: { interleaved: true },
          },
        },
      },
    })

    expect(migrated.providers?.custom?.models?.object?.compatibility).toEqual({
      reasoningField: "vendor_reasoning",
    })
    expect(migrated.providers?.custom?.models?.string?.compatibility).toEqual({ reasoningField: "reasoning_text" })
    expect(migrated.providers?.custom?.models?.boolean?.compatibility).toBeUndefined()
  })

  for (const subtask of [true, false]) {
    test(`migrates v1 command configuration with subtask: ${subtask}`, () => {
      expect(
        ConfigMigrateV1.migrate({
          command: {
            review: {
              template: "Review changes",
              description: "Review code",
              agent: "reviewer",
              model: "anthropic/claude",
              variant: "high",
              subtask,
            },
          },
        }).commands,
      ).toEqual({
        review: {
          template: "Review changes",
          description: "Review code",
          agent: "reviewer",
          model: { providerID: "anthropic", model: "claude", variant: "high" },
          subagent: subtask,
        },
      })
    })
  }

  test("normalizes renamed permission actions when migrating v1 permissions", () => {
    expect(
      ConfigMigrateV1.migrate({
        permission: {
          task: "ask",
          bash: { "git status": "allow", "*": "deny" },
          write: "deny",
          read: "allow",
        },
      }).permissions,
    ).toEqual([
      { action: "subagent", resource: "*", effect: "ask" },
      { action: "shell", resource: "git status", effect: "allow" },
      { action: "shell", resource: "*", effect: "deny" },
      { action: "edit", resource: "*", effect: "deny" },
      { action: "read", resource: "*", effect: "allow" },
    ])
  })

  it.live("returns an empty configuration when directory files do not exist", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const config = yield* Config.Service
          const entries = (yield* config.entries()).filter((entry) => !entry.path || inFixture(tmp.path, entry.path))

          expect(entries).toEqual([
            new Directory({ type: "directory", path: AbsolutePath.make(path.join(tmp.path, "global")) }),
          ])
        }).pipe(Effect.provide(testLayer(tmp.path))),
      ),
    ),
  )

  it.live("deduplicates global ecosystem directories found during upward discovery", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const global = path.join(tmp.path, "global")
          const home = path.join(global, "home")
          const project = path.join(home, "project")
          yield* Effect.promise(() =>
            Promise.all([
              fs.mkdir(path.join(home, ".claude"), { recursive: true }),
              fs.mkdir(path.join(home, ".agents"), { recursive: true }),
              fs.mkdir(project, { recursive: true }),
            ]),
          )
          const entries = yield* Config.Service.use((config) => config.entries()).pipe(
            Effect.provide(testLayer(project, global)),
          )

          expect(entries.filter((entry) => entry.type === "claude").map((entry) => entry.path)).toEqual([
            AbsolutePath.make(path.join(home, ".claude")),
          ])
          expect(entries.filter((entry) => entry.type === "agents").map((entry) => entry.path)).toEqual([
            AbsolutePath.make(path.join(home, ".agents")),
          ])
        }),
      ),
    ),
  )

  it.live("does not recursively watch ecosystem config roots", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            Promise.all([
              fs.mkdir(path.join(tmp.path, ".claude", "skills"), { recursive: true }),
              fs.mkdir(path.join(tmp.path, ".agents"), { recursive: true }),
            ]),
          )
          return yield* Effect.gen(function* () {
            const config = yield* Config.Service
            const watcher = yield* Watcher.Test
            yield* config.entries()

            expect((yield* watcher.subscriptions()).filter((item) => inFixture(tmp.path, item.path))).toEqual([
              {
                type: "directory",
                path: AbsolutePath.make(path.join(tmp.path, "global")),
                ignore: ["**/{node_modules,.git}/**", ".git", "node_modules"],
              },
              {
                type: "entries",
                path: tmp.path,
                names: [".agents", ".claude", ".opencode", "opencode.json", "opencode.jsonc"],
              },
            ])
          }).pipe(Effect.provide(testLayer(tmp.path, undefined, undefined, undefined, Watcher.testLayer)))
        }),
      ),
    ),
  )

  it.live("loads opencode JSON and JSONC files from lowest to highest priority", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            Promise.all([
              fs.writeFile(
                path.join(tmp.path, "opencode.json"),
                JSON.stringify({ $schema: "base", providers: { base: provider } }),
              ),
              fs.writeFile(
                path.join(tmp.path, "opencode.jsonc"),
                `{
                  // Later global files override scalar fields while retaining providers.
                  "$schema": "last",
                  "providers": { "last": ${JSON.stringify(provider)} },
                }`,
              ),
            ]),
          )
          return yield* Effect.gen(function* () {
            const config = yield* Config.Service
            const documents = (yield* config.entries()).filter((entry) => entry.type === "document")

            expect(documents).toHaveLength(2)
            expect(documents.map((document) => document.type)).toEqual(["document", "document"])
            expect(documents.map((document) => document.info.$schema)).toEqual(["base", "last"])
            expect(documents[0]).toBeInstanceOf(Document)
            expect(documents[0]?.path).toBe(AbsolutePath.make(path.join(tmp.path, "opencode.json")))
            expect(documents[1]?.info.providers?.last).toBeInstanceOf(ConfigProvider.Info)

            yield* Effect.promise(() =>
              fs.writeFile(path.join(tmp.path, "opencode.jsonc"), JSON.stringify({ $schema: "changed" })),
            )
            expect(
              (yield* config.entries())
                .filter((entry) => entry.type === "document")
                .map((document) => document.info.$schema),
            ).toEqual(["base", "last"])
          }).pipe(Effect.provide(testLayer(tmp.path)))
        }),
      ),
    ),
  )

  it.live("substitutes environment variables and relative file contents", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const previous = {
          token: process.env.OPENCODE_TEST_MCP_TOKEN,
          missing: process.env.OPENCODE_TEST_MISSING,
        }
        process.env.OPENCODE_TEST_MCP_TOKEN = "secret"
        delete process.env.OPENCODE_TEST_MISSING
        return previous
      }),
      () =>
        Effect.acquireUseRelease(
          Effect.promise(() => tmpdir()),
          (tmp) =>
            Effect.gen(function* () {
              yield* Effect.promise(() =>
                Promise.all([
                  fs.writeFile(path.join(tmp.path, "token.txt"), 'file\n"token"\n'),
                  fs.writeFile(
                    path.join(tmp.path, "opencode.jsonc"),
                    `{
                      // Ignored reference: {file:missing.txt}
                      "username": "user-{env:OPENCODE_TEST_MISSING}",
                      "mcp": {
                        "servers": {
                          "remote": {
                            "type": "remote",
                            "url": "https://example.com/mcp",
                            "headers": {
                              "Authorization": "Bearer {env:OPENCODE_TEST_MCP_TOKEN}",
                              "X-Token": "{file:token.txt}"
                            }
                          }
                        }
                      }
                    }`,
                  ),
                ]),
              )

              return yield* Effect.gen(function* () {
                const config = yield* Config.Service
                const document = (yield* config.entries()).find((entry) => entry.type === "document")
                expect(document?.info.username).toBe("user-")
                const remote = document?.info.mcp?.servers?.remote
                expect(remote?.type).toBe("remote")
                if (remote?.type !== "remote") return
                expect(remote.headers).toEqual({
                  Authorization: "Bearer secret",
                  "X-Token": 'file\n"token"',
                })
              }).pipe(Effect.provide(testLayer(tmp.path)))
            }),
          (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
        ),
      (previous) =>
        Effect.sync(() => {
          if (previous.token === undefined) delete process.env.OPENCODE_TEST_MCP_TOKEN
          else process.env.OPENCODE_TEST_MCP_TOKEN = previous.token
          if (previous.missing === undefined) delete process.env.OPENCODE_TEST_MISSING
          else process.env.OPENCODE_TEST_MISSING = previous.missing
        }),
    ),
  )

  it.live("does not load legacy config.json files", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            fs.writeFile(path.join(tmp.path, "config.json"), JSON.stringify({ $schema: "legacy" })),
          )

          return yield* Effect.gen(function* () {
            const config = yield* Config.Service
            const documents = (yield* config.entries()).filter((entry) => entry.type === "document")

            expect(documents).toHaveLength(0)
          }).pipe(Effect.provide(testLayer(tmp.path)))
        }),
      ),
    ),
  )

  it.live("accepts $schema metadata without writing it into config files", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const file = path.join(tmp.path, "opencode.json")
          const contents = JSON.stringify({
            shell: "/bin/zsh",
            providers: { local: provider },
          })
          yield* Effect.promise(() => fs.writeFile(file, contents))

          return yield* Effect.gen(function* () {
            const config = yield* Config.Service
            const documents = (yield* config.entries()).filter((entry) => entry.type === "document")

            expect(documents[0]?.info.$schema).toBeUndefined()
            expect(documents[0]?.info.shell).toBe("/bin/zsh")
            expect(yield* Effect.promise(() => fs.readFile(file, "utf8"))).toBe(contents)
          }).pipe(Effect.provide(testLayer(tmp.path)))
        }),
      ),
    ),
  )

  it.live("loads supported scalar and resource configuration", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            fs.writeFile(
              path.join(tmp.path, "opencode.json"),
              JSON.stringify({
                shell: "/bin/bash",
                model: "anthropic/claude",
                default_agent: "reviewer",
                update: "notify",
                share: "disabled",
                enterprise: { url: "https://share.example.com" },
                username: "test-user",
                permissions: [
                  { action: "bash", resource: "*", effect: "ask" },
                  { action: "bash", resource: "git status", effect: "allow" },
                ],
                agents: {
                  reviewer: {
                    model: "openrouter/openai/gpt-5#high",
                    request: {
                      headers: { "x-agent": "reviewer" },
                      body: { reasoningEffort: "high" },
                    },
                    description: "Review changes for correctness",
                    system: "Find regressions.",
                    mode: "subagent",
                    hidden: false,
                    color: "#ff6b6b",
                    steps: 12,
                    disabled: false,
                    permissions: [{ action: "edit", resource: "*", effect: "deny" }],
                  },
                },
                snapshots: false,
                watcher: { ignore: ["node_modules/**", "dist/**", ".git"] },
                formatter: {
                  prettier: { disabled: true },
                  custom: { command: ["custom-fmt", "$FILE"], extensions: [".foo"] },
                },
                lsp: { typescript: { disabled: true }, custom: { command: ["custom-lsp"], extensions: [".foo"] } },
                media: {
                  image: { auto_resize: false, max_width: 1200, max_height: 900, max_base64_bytes: 1048576 },
                },
                tool_output: { max_lines: 1000, max_bytes: 32768 },
                mcp: {
                  timeout: { startup: 5000, catalog: 60000, execution: 43200000 },
                  servers: {
                    local: {
                      type: "local",
                      command: ["node", "./mcp/server.js"],
                      environment: { API_KEY: "secret" },
                      disabled: false,
                      codemode: false,
                      timeout: { catalog: 10000 },
                    },
                    remote: {
                      type: "remote",
                      url: "https://mcp.example.com/mcp",
                      headers: { Authorization: "Bearer token" },
                      oauth: { client_id: "client", scope: "read write", callback_port: 19876 },
                      disabled: true,
                      codemode: false,
                      timeout: { startup: 15000 },
                    },
                  },
                },
                compaction: {
                  auto: true,
                  prune: false,
                  keep: { tokens: 2000 },
                  buffer: 10000,
                },
                skills: ["./skills", "~/shared-skills", "https://example.com/.well-known/skills/"],
                instructions: ["CONTRIBUTING.md", ".cursor/rules/*.md", "https://example.com/shared-rules.md"],
                references: {
                  local: { path: "../library" },
                  sdk: { repository: "github.com/example/sdk", branch: "main" },
                  shorthand: "github.com/example/docs",
                },
              }),
            ),
          )

          return yield* Effect.gen(function* () {
            const config = yield* Config.Service
            const documents = (yield* config.entries()).filter((entry) => entry.type === "document")

            expect(documents).toHaveLength(1)
            expect(documents[0]?.info.shell).toBe("/bin/bash")
            expect(documents[0]?.info.model).toEqual(selection("anthropic/claude"))
            expect(documents[0]?.info.default_agent).toBe("reviewer")
            expect(documents[0]?.info.update).toBe("notify")
            expect(documents[0]?.info.share).toBe("disabled")
            expect(documents[0]?.info.enterprise).toEqual({ url: "https://share.example.com" })
            expect(documents[0]?.info.username).toBe("test-user")
            expect(documents[0]?.info.permissions).toEqual([
              { action: "bash", resource: "*", effect: "ask" },
              { action: "bash", resource: "git status", effect: "allow" },
            ])
            const reviewer = documents[0]?.info.agents?.reviewer
            expect(reviewer?.model).toEqual(selection("openrouter/openai/gpt-5#high"))
            expect(reviewer?.request).toEqual({
              headers: { "x-agent": "reviewer" },
              body: { reasoningEffort: "high" },
            })
            expect(reviewer?.description).toBe("Review changes for correctness")
            expect(reviewer?.system).toBe("Find regressions.")
            expect(reviewer?.mode).toBe("subagent")
            expect(reviewer?.hidden).toBe(false)
            expect(reviewer?.color).toBe("#ff6b6b")
            expect(reviewer?.steps).toBe(12)
            expect(reviewer?.disabled).toBe(false)
            expect(reviewer?.permissions).toEqual([{ action: "edit", resource: "*", effect: "deny" }])
            expect(documents[0]?.info.snapshots).toBe(false)
            expect(documents[0]?.info.watcher).toEqual({ ignore: ["node_modules/**", "dist/**", ".git"] })
            expect(documents[0]?.info.formatter).toEqual({
              prettier: { disabled: true },
              custom: { command: ["custom-fmt", "$FILE"], extensions: [".foo"] },
            })
            expect(documents[0]?.info.lsp).toEqual({
              typescript: { disabled: true },
              custom: { command: ["custom-lsp"], extensions: [".foo"] },
            })
            expect(documents[0]?.info.media).toEqual({
              image: { auto_resize: false, max_width: 1200, max_height: 900, max_base64_bytes: 1048576 },
            })
            expect(documents[0]?.info.tool_output).toEqual({ max_lines: 1000, max_bytes: 32768 })
            expect(documents[0]?.info.mcp).toEqual({
              timeout: { startup: 5000, catalog: 60000, execution: 43200000 },
              servers: {
                local: {
                  type: "local",
                  command: ["node", "./mcp/server.js"],
                  environment: { API_KEY: "secret" },
                  disabled: false,
                  codemode: false,
                  timeout: { catalog: 10000 },
                },
                remote: {
                  type: "remote",
                  url: "https://mcp.example.com/mcp",
                  headers: { Authorization: "Bearer token" },
                  oauth: { client_id: "client", scope: "read write", callback_port: 19876 },
                  disabled: true,
                  codemode: false,
                  timeout: { startup: 15000 },
                },
              },
            })
            expect(documents[0]?.info.compaction).toEqual({
              auto: true,
              keep: { tokens: 2000 },
              buffer: 10000,
            })
            expect(documents[0]?.info.skills).toEqual([
              "./skills",
              "~/shared-skills",
              "https://example.com/.well-known/skills/",
            ])
            expect(documents[0]?.info.instructions).toEqual([
              "CONTRIBUTING.md",
              ".cursor/rules/*.md",
              "https://example.com/shared-rules.md",
            ])
            expect(documents[0]?.info.references).toEqual({
              local: { path: "../library" },
              sdk: { repository: "github.com/example/sdk", branch: "main" },
              shorthand: "github.com/example/docs",
            })
          }).pipe(Effect.provide(testLayer(tmp.path)))
        }),
      ),
    ),
  )

  it.live("migrates the deprecated reference key into references", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            fs.writeFile(
              path.join(tmp.path, "opencode.json"),
              JSON.stringify({
                reference: {
                  local: { path: "../library" },
                  sdk: { repository: "github.com/example/sdk", branch: "main" },
                  shorthand: "github.com/example/docs",
                },
              }),
            ),
          )

          return yield* Effect.gen(function* () {
            const config = yield* Config.Service
            const documents = (yield* config.entries()).filter((entry) => entry.type === "document")

            expect(documents).toHaveLength(1)
            expect(documents[0]?.info.references).toEqual({
              local: { path: "../library" },
              sdk: { repository: "github.com/example/sdk", branch: "main" },
              shorthand: "github.com/example/docs",
            })
          }).pipe(Effect.provide(testLayer(tmp.path)))
        }),
      ),
    ),
  )

  it.live("migrates v1 configuration when a v1-only key is present", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            fs.writeFile(
              path.join(tmp.path, "opencode.json"),
              JSON.stringify({
                shell: "/bin/zsh",
                default_agent: "reviewer",
                autoupdate: false,
                snapshot: false,
                autoshare: true,
                permission: {
                  bash: "ask",
                  edit: { "*.md": "allow", "*": "deny" },
                  question: "deny",
                  webfetch: { "*": "ask", "https://en.wikipedia.org/*": "allow" },
                },
                agent: {
                  reviewer: {
                    prompt: "Review changes.",
                    disable: true,
                    temperature: 0.2,
                    permission: { read: "allow" },
                  },
                },
                skills: { paths: ["./skills"], urls: ["https://example.com/.well-known/skills/"] },
                references: {
                  docs: { path: "../docs", description: "Use for product documentation", hidden: true },
                },
                attachment: { image: { auto_resize: false, max_width: 1200 } },
                provider: {
                  custom: {
                    options: { apiKey: "secret" },
                    models: {
                      model: {
                        options: { reasoningEffort: "high" },
                        variants: { fast: { temperature: 0.2 } },
                      },
                    },
                  },
                  openai: {
                    npm: "@ai-sdk/openai",
                    options: { apiKey: "secret", organization: "org" },
                    models: {
                      model: {
                        options: { temperature: 0.3, reasoningEffort: "high", serviceTier: "priority" },
                        variants: { high: { reasoningEffort: "high", reasoningSummary: "auto" } },
                      },
                    },
                  },
                  anthropic: {
                    npm: "@ai-sdk/anthropic",
                    models: {
                      model: {
                        options: {
                          effort: "high",
                          taskBudget: 4096,
                          metadata: { userId: "user-1" },
                        },
                      },
                    },
                  },
                },
                compaction: { auto: true, tail_turns: 3, preserve_recent_tokens: 2000, reserved: 10000 },
                experimental: { mcp_timeout: 5000 },
                mcp: {
                  local: { type: "local", command: ["node", "server.js"], enabled: false, timeout: 10000 },
                  remote: {
                    type: "remote",
                    url: "https://mcp.example.com",
                    oauth: { clientId: "client", callbackPort: 19876 },
                    timeout: 20000,
                  },
                },
              }),
            ),
          )

          return yield* Effect.gen(function* () {
            const config = yield* Config.Service
            const documents = (yield* config.entries()).filter((entry) => entry.type === "document")

            expect(documents).toHaveLength(1)
            expect(documents[0]?.info).toBeInstanceOf(Info)
            expect(documents[0]?.info.shell).toBe("/bin/zsh")
            expect(documents[0]?.info.default_agent).toBe("reviewer")
            expect(documents[0]?.info.update).toBe("disable")
            expect(documents[0]?.info.snapshots).toBe(false)
            expect(documents[0]?.info.share).toBe("auto")
            expect(documents[0]?.info.permissions).toEqual([
              { action: "shell", resource: "*", effect: "ask" },
              { action: "edit", resource: "*.md", effect: "allow" },
              { action: "edit", resource: "*", effect: "deny" },
              { action: "question", resource: "*", effect: "deny" },
              { action: "webfetch", resource: "*", effect: "ask" },
              { action: "webfetch", resource: "https://en.wikipedia.org/*", effect: "allow" },
            ])
            expect(documents[0]?.info.agents?.reviewer).toMatchObject({
              system: "Review changes.",
              disabled: true,
              request: { body: { temperature: 0.2 } },
              permissions: [{ action: "read", resource: "*", effect: "allow" }],
            })
            expect(documents[0]?.info.skills).toEqual(["./skills", "https://example.com/.well-known/skills/"])
            expect(documents[0]?.info.references).toEqual({
              docs: { path: "../docs", description: "Use for product documentation", hidden: true },
            })
            expect(documents[0]?.info.media).toEqual({ image: { auto_resize: false, max_width: 1200 } })
            expect(documents[0]?.info.providers?.custom).toMatchObject({
              settings: { apiKey: "secret" },
              models: {
                model: {
                  settings: { reasoningEffort: "high" },
                  variants: [{ id: "fast", settings: { temperature: 0.2 } }],
                },
              },
            })
            expect(documents[0]?.info.providers?.openai).toMatchObject({
              package: Provider.aisdk("@ai-sdk/openai"),
              settings: { apiKey: "secret", organization: "org" },
              models: {
                model: {
                  settings: { temperature: 0.3, reasoningEffort: "high", serviceTier: "priority" },
                  variants: [{ id: "high", settings: { reasoningEffort: "high", reasoningSummary: "auto" } }],
                },
              },
            })
            expect(documents[0]?.info.providers?.anthropic).toMatchObject({
              package: Provider.aisdk("@ai-sdk/anthropic"),
              models: {
                model: {
                  settings: {
                    effort: "high",
                    taskBudget: 4096,
                    metadata: { userId: "user-1" },
                  },
                },
              },
            })
            expect(documents[0]?.info.compaction).toEqual({
              auto: true,
              keep: { tokens: 2000 },
              buffer: 10000,
            })
            expect(documents[0]?.info.mcp).toMatchObject({
              timeout: { catalog: 5000, execution: 5000 },
              servers: {
                local: {
                  type: "local",
                  command: ["node", "server.js"],
                  disabled: true,
                  timeout: { catalog: 10000, execution: 10000 },
                },
                remote: {
                  type: "remote",
                  url: "https://mcp.example.com",
                  oauth: { client_id: "client", callback_port: 19876 },
                  timeout: { catalog: 20000, execution: 20000 },
                },
              },
            })
          }).pipe(Effect.provide(testLayer(tmp.path)))
        }),
      ),
    ),
  )

  it.live("ignores an invalid file while loading valid config values", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            Promise.all([
              fs.writeFile(path.join(tmp.path, "opencode.json"), JSON.stringify({ $schema: "base" })),
              fs.writeFile(path.join(tmp.path, "opencode.jsonc"), "{ invalid"),
            ]),
          )
          return yield* Effect.gen(function* () {
            const config = yield* Config.Service
            const watcher = yield* Watcher.Test
            const documents = (yield* config.entries()).filter((entry) => entry.type === "document")

            expect(documents.map((document) => document.info.$schema)).toEqual(["base"])
            expect(yield* watcher.subscriptions()).toContainEqual({
              path: tmp.path,
              type: "entries",
              names: [".agents", ".claude", ".opencode", "opencode.json", "opencode.jsonc"],
            })
          }).pipe(Effect.provide(testLayer(tmp.path)))
        }),
      ),
    ),
  )

  it.live("loads global and ancestor configuration across the project boundary", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) => {
        const global = path.join(tmp.path, "global")
        const root = path.join(tmp.path, "repo")
        const parent = path.join(root, "packages")
        const directory = path.join(parent, "app")
        const globalAgents = path.join(global, "home", ".agents")
        const globalClaude = path.join(global, "home", ".claude")
        return Effect.gen(function* () {
          yield* Effect.promise(async () => {
            await fs.mkdir(global, { recursive: true })
            await fs.mkdir(globalAgents, { recursive: true })
            await fs.mkdir(globalClaude, { recursive: true })
            await fs.mkdir(directory, { recursive: true })
            await fs.mkdir(path.join(root, ".agents"), { recursive: true })
            await fs.mkdir(path.join(root, ".claude"), { recursive: true })
            await fs.mkdir(path.join(root, ".opencode"), { recursive: true })
            await fs.mkdir(path.join(directory, ".agents"), { recursive: true })
            await fs.mkdir(path.join(directory, ".claude"), { recursive: true })
            await fs.mkdir(path.join(directory, ".opencode"), { recursive: true })
            await Promise.all([
              fs.writeFile(path.join(tmp.path, "opencode.json"), JSON.stringify({ $schema: "outside" })),
              fs.writeFile(path.join(global, "opencode.json"), JSON.stringify({ $schema: "global" })),
              fs.writeFile(path.join(root, "opencode.json"), JSON.stringify({ $schema: "root" })),
              fs.writeFile(path.join(parent, "opencode.jsonc"), JSON.stringify({ $schema: "parent" })),
              fs.writeFile(path.join(directory, "opencode.json"), JSON.stringify({ $schema: "directory" })),
              fs.writeFile(path.join(root, ".opencode", "opencode.json"), JSON.stringify({ $schema: "root-dot" })),
              fs.writeFile(
                path.join(directory, ".opencode", "opencode.jsonc"),
                JSON.stringify({ $schema: "directory-dot" }),
              ),
            ])
          })

          return yield* Effect.gen(function* () {
            const config = yield* Config.Service
            const entries = (yield* config.entries()).filter((entry) => !entry.path || inFixture(tmp.path, entry.path))
            const documents = entries.filter((entry) => entry.type === "document")

            expect(entries.filter((entry) => entry.type === "directory").map((entry) => entry.path)).toEqual([
              AbsolutePath.make(global),
              AbsolutePath.make(path.join(root, ".opencode")),
              AbsolutePath.make(path.join(directory, ".opencode")),
            ])
            expect(entries.filter((entry) => entry.type === "agents").map((entry) => entry.path)).toEqual([
              AbsolutePath.make(globalAgents),
              AbsolutePath.make(path.join(root, ".agents")),
              AbsolutePath.make(path.join(directory, ".agents")),
            ])
            expect(entries.filter((entry) => entry.type === "claude").map((entry) => entry.path)).toEqual([
              AbsolutePath.make(globalClaude),
              AbsolutePath.make(path.join(root, ".claude")),
              AbsolutePath.make(path.join(directory, ".claude")),
            ])
            expect(documents.map((document) => document.info.$schema)).toEqual([
              "global",
              "outside",
              "root",
              "parent",
              "directory",
              "root-dot",
              "directory-dot",
            ])
            expect(entries.map((entry) => (entry.type === "document" ? entry.info.$schema : entry.path))).toEqual([
              AbsolutePath.make(globalClaude),
              AbsolutePath.make(path.join(root, ".claude")),
              AbsolutePath.make(path.join(directory, ".claude")),
              AbsolutePath.make(globalAgents),
              AbsolutePath.make(path.join(root, ".agents")),
              AbsolutePath.make(path.join(directory, ".agents")),
              "global",
              AbsolutePath.make(global),
              "outside",
              "root",
              "parent",
              "directory",
              "root-dot",
              AbsolutePath.make(path.join(root, ".opencode")),
              "directory-dot",
              AbsolutePath.make(path.join(directory, ".opencode")),
            ])
          }).pipe(
            Effect.provide(
              testLayer(directory, global, root, {
                type: "git",
                store: AbsolutePath.make(path.join(root, ".git")),
              }),
            ),
          )
        })
      }),
    ),
  )

  it.live("excludes claude sources when disableClaudeCode option is set", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) => {
        const global = path.join(tmp.path, "global")
        const directory = path.join(tmp.path, "repo")
        const globalAgents = path.join(global, "home", ".agents")
        const globalClaude = path.join(global, "home", ".claude")
        return Effect.gen(function* () {
          yield* Effect.promise(async () => {
            await fs.mkdir(global, { recursive: true })
            await fs.mkdir(globalAgents, { recursive: true })
            await fs.mkdir(globalClaude, { recursive: true })
            await fs.mkdir(directory, { recursive: true })
            await fs.mkdir(path.join(directory, ".agents"), { recursive: true })
          })

          return yield* Effect.gen(function* () {
            const config = yield* Config.Service
            const entries = (yield* config.entries()).filter(
              (entry) => !entry.path || inFixture(tmp.path, entry.path),
            )
            expect(entries.filter((entry) => entry.type === "claude").map((entry) => entry.path)).toEqual([])
            expect(entries.filter((entry) => entry.type === "agents").map((entry) => entry.path)).toEqual([
              AbsolutePath.make(globalAgents),
              AbsolutePath.make(path.join(directory, ".agents")),
            ])
          }).pipe(
            Effect.provide(
              testLayer(directory, global, directory, undefined, Watcher.testLayer, emptyCredentialNode, emptyWellknownNode, {
                disableClaudeCode: true,
              }),
            ),
          )
        })
      }),
    ),
  )
})
