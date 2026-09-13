export * as PluginSupervisor from "./supervisor.js"

import { Event } from "@opencode/schema/config"
import { Cause, Effect, Layer, Queue, Stream } from "effect"
import path from "path"
import { ConfigPluginSource } from "../config/plugin/source.js"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { Bus } from "../bus.js"
import { Npm } from "@opencode/util/npm"
import { Plugin } from "../plugin.js"
import { InstancePlugins } from "./instance.js"
import { PluginInternal } from "./internal.js"
import { PluginModule } from "./module.js"
import { SdkPlugins } from "./sdk.js"
import { PluginUpdate } from "./update.js"
import { Watcher } from "../filesystem/watcher.js"

const resolve = Effect.fn("PluginSupervisor.resolve")(function* (
  modules: Effect.Success<ReturnType<typeof PluginModule.make>>,
  pre: readonly Plugin.Generation[],
  post: readonly Plugin.Generation[],
  operations: readonly ConfigPluginSource.Operation[],
  install: boolean,
  running: ReadonlyMap<string, Plugin.Generation>,
) {
  const matches = (selector: string, target: string) =>
    selector === "*" || (selector.endsWith(".*") ? target.startsWith(selector.slice(0, -1)) : selector === target)
  const definitions = [...pre, ...post]
  const enabled = new Set(definitions.map((plugin) => plugin.id))
  const packages = new Map<string, Plugin.Generation>()
  const pending = new Set<string>()
  const failures = new Map<
    string,
    Plugin.Info & { readonly state: Extract<Plugin.State, { readonly status: "failed" }> }
  >()
  const plugins = () => [...definitions, ...packages.values()]

  for (const operation of operations) {
    if (operation.type === "remove") {
      if (operation.target === "*") failures.clear()
      plugins()
        .filter((plugin) => matches(operation.target, plugin.id))
        .forEach((plugin) => enabled.delete(plugin.id))
      continue
    }

    const matched = plugins().filter((plugin) => matches(operation.target, plugin.id))
    const selectsPlugins =
      matched.length > 0 ||
      operation.target === "*" ||
      operation.target.endsWith(".*") ||
      operation.target.startsWith("opencode.")
    if (selectsPlugins) {
      matched.forEach((plugin) => enabled.add(plugin.id))
      continue
    }

    const plugin = yield* modules.load(operation, { install }).pipe(
      Effect.catchCause((cause) => {
        const ref = `err_${crypto.randomUUID().slice(0, 8)}`
        const error = Cause.squash(cause)
        return Effect.logWarning("failed to load plugin", { target: operation.target, ref, cause }).pipe(
          Effect.as({ error: error instanceof PluginModule.LoadError ? error.message : "Plugin failed to load", ref }),
        )
      }),
    )
    if ("pending" in plugin) {
      pending.add(operation.target)
      continue
    }
    if ("error" in plugin) {
      failures.set(operation.target, {
        source: pluginSource(operation.target),
        state: { status: "failed", error: plugin.error, ref: plugin.ref },
        features: { server: true },
      })
      // The new revision never became a generation, so the one already running keeps its place.
      const retained = packages.get(operation.target) ?? running.get(operation.target)
      if (!retained) continue
      packages.set(operation.target, retained)
      enabled.add(retained.id)
      continue
    }
    failures.delete(operation.target)
    const previous = packages.get(operation.target)
    if (previous) enabled.delete(previous.id)
    packages.set(operation.target, plugin)
    enabled.add(plugin.id)
  }

  // Console's connected-workspace policy source cannot be removed by authored
  // plugin directives. Its final enforcement lives outside the plugin registry.
  if (pre.some((plugin) => plugin.id === "opencode.provider.opencode")) enabled.add("opencode.provider.opencode")
  const ordered = [
    ...pre.filter((plugin) => enabled.has(plugin.id)),
    ...[...packages.values()].filter((plugin) => enabled.has(plugin.id)),
    ...post.filter((plugin) => enabled.has(plugin.id)),
  ]
  // Registry activation dies on a duplicate ID, which would drop the whole generation including builtins.
  // Keep the first occurrence in boot order and report later ones like any other plugin setup failure.
  const duplicate = (plugin: Plugin.Generation, index: number) =>
    ordered.findIndex((other) => other.id === plugin.id) !== index
  return {
    plugins: ordered.filter((plugin, index) => !duplicate(plugin, index)),
    packages: new Map([...packages].filter(([, plugin]) => enabled.has(plugin.id))),
    failures: [
      ...failures.values(),
      ...ordered.filter(duplicate).map((plugin) => ({
        id: Plugin.ID.make(plugin.id),
        source: plugin.source ?? { type: "builtin" as const },
        state: { status: "failed" as const, error: `Duplicate plugin ID: ${plugin.id}` },
        features: { server: true as const, ...plugin.features },
      })),
    ],
    pending: [...pending],
  }
})

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const registry = yield* Plugin.Service
    const sdk = yield* SdkPlugins.Service
    const instance = yield* InstancePlugins.Service
    const sources = yield* ConfigPluginSource.Service
    const modules = yield* PluginModule.make()
    const bus = yield* Bus.Service
    const updates = yield* PluginUpdate.Service
    const internal = yield* PluginInternal.list()
    let release: Effect.Effect<void> | undefined = yield* registry.hold()
    yield* Effect.addFinalizer(() => release ?? Effect.void)
    // Built-ins capture services from this layer; unload them before those services close.
    yield* Effect.addFinalizer(registry.close)
    let packages = new Set<string>()
    // Last generation handed to the registry per target; a failed reload keeps it in place.
    let running = new Map<string, Plugin.Generation>()
    let outdated = new Set<string>()
    const updating = new Set<string>()
    let generation = 0
    let observed = 0

    const activate = Effect.fn("PluginSupervisor.activate")(function* () {
      const current = ++generation
      // Combine internal plugins with host-contributed plugins in boot order.
      // Instance-bound plugins come last: later activation can override earlier
      // container writes, so the instance's explicit choices win over globals.
      const pre = [
        ...internal.pre.map((plugin) => ({ ...plugin, revision: "internal", source: { type: "builtin" as const } })),
        ...sdk.all(),
        ...instance.all(),
      ]
      const post = internal.post.map((plugin) => ({
        ...plugin,
        revision: "internal",
        source: { type: "builtin" as const },
      }))
      const operations = yield* sources.operations()
      // Activate everything available locally before waiting on missing package installs.
      const immediate = yield* resolve(modules, pre, post, operations, false, running)
      const source = (source: Plugin.Source) =>
        source.type === "package"
          ? {
              ...source,
              ...(outdated.has(source.target) ? { outdated: true as const } : {}),
              ...(updating.has(source.target) ? { updating: true as const } : {}),
            }
          : source
      const apply = (resolved: typeof immediate) =>
        registry.activate(
          resolved.plugins.map((plugin) => (plugin.source ? { ...plugin, source: source(plugin.source) } : plugin)),
          resolved.failures.map((failure) => ({ ...failure, source: source(failure.source) })),
        )
      yield* apply(immediate)
      const resolved = immediate.pending.length
        ? yield* resolve(modules, pre, post, operations, true, running)
        : immediate
      if (resolved !== immediate) yield* apply(resolved)
      running = resolved.packages
      const targets = new Set(
        [...resolved.plugins, ...resolved.failures].flatMap((plugin) =>
          plugin.source?.type === "package" ? [plugin.source.target] : [],
        ),
      )
      packages = targets
      yield* Effect.forEach(
        targets,
        (target) => updates.check(target).pipe(Effect.map((available) => [target, available] as const)),
        { concurrency: "unbounded" },
      ).pipe(
        Effect.flatMap((checked) => {
          if (current !== generation) return Effect.void
          const next = new Set(checked.flatMap(([target, available]) => (available ? [target] : [])))
          if (next.size === outdated.size && [...next].every((target) => outdated.has(target))) return Effect.void
          outdated = next
          return apply(resolved)
        }),
        Effect.forkScoped({ startImmediately: true }),
      )
    })
    // Start source consumers before activation, without an extra merge/debounce boundary delaying them.
    // Each source owns its upstream subscriptions; the queue retains the latest observed request.
    const triggers = yield* Queue.sliding<number>(1)
    // Make accepted work visible to awaitActivation before coalescing the burst.
    const notify = Effect.gen(function* () {
      observed++
      if (!release) release = yield* registry.hold()
      yield* Queue.offer(triggers, observed)
    })
    const watch = <A>(stream: Stream.Stream<A>) =>
      stream.pipe(
        Stream.runForEach(() => notify),
        Effect.forkScoped({ startImmediately: true }),
      )
    yield* watch(sources.changes())
    yield* watch(modules.changes())
    yield* watch(Stream.fromEffectRepeat(Effect.sleep("24 hours")))
    yield* watch(bus.subscribe([Event.Updated, SdkPlugins.Updated]))
    yield* watch(
      updates.changes().pipe(
        Stream.filter((update) => packages.has(update.target)),
        Stream.tap((update) =>
          Effect.sync(() => {
            update.outdated ? outdated.add(update.target) : outdated.delete(update.target)
            update.updating ? updating.add(update.target) : updating.delete(update.target)
          }),
        ),
      ),
    )
    // Run initial activation immediately; debounce only later requests. One consumer serializes both.
    yield* Stream.concat(Stream.succeed(0), Stream.fromQueue(triggers).pipe(Stream.debounce("100 millis"))).pipe(
      Stream.runForEach((target) =>
        Effect.gen(function* () {
          yield* activate().pipe(Effect.catchCause((cause) => Effect.logError("failed to reload plugins", { cause })))
          if (observed !== target) return
          const settled = release
          release = undefined
          if (settled) yield* settled
        }),
      ),
      Effect.forkScoped({ startImmediately: true }),
    )
  }),
)

const nodeDeps = [
  Plugin.node,
  SdkPlugins.node,
  InstancePlugins.node,
  ConfigPluginSource.node,
  PluginUpdate.node,
  Bus.node,
  Npm.node,
  Watcher.node,
  PluginInternal.requirements,
] as const

function pluginSource(target: string): Plugin.Source {
  if (path.isAbsolute(target)) return { type: "local", path: target }
  return { type: "package", target }
}

export const node = makeLocationNode({ name: "plugin-supervisor", layer, deps: nodeDeps })
