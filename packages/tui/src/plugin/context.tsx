import type { PluginInfo } from "@opencode/client"
import type { Plugin } from "@opencode/plugin/tui"
import type { MarkdownCodeBlockRenderer, MarkdownOptions } from "@opentui/core"
import {
  batch,
  createContext,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  onMount,
  useContext,
  type ParentProps,
} from "solid-js"
import path from "path"
import { stat } from "fs/promises"
import { fileURLToPath } from "url"
import type { Page } from "@opencode/plugin/tui/context"
import { Host } from "@opencode/plugin/host"
import { resolveSlots, type Claim } from "./structure"
import { createStore, produce, reconcile as reconcileStore, unwrap } from "solid-js/store"
import { isDeepEqual } from "remeda"
import "#runtime-plugin-support"
import { useConfig } from "../config"
import { useTuiLifecycle } from "../context/runtime"
import { useClient } from "../context/client"
import { useData } from "../context/data"
import { errorMessage } from "../util/error"
import { builtins } from "./builtins"
import { createPluginContext, usePluginHost, type Dispose, type RegisteredSlot, type SlotRender } from "./api"
import { createSourceWatcher } from "./watch"
import { discoverPluginTargets, localSource } from "./discovery"
import { createPluginSources } from "./source"
import { isMissingPath } from "../util/config-directories"
import { createMarkdownRenderer } from "./markdown"
import { useLog, type LogTags } from "../context/log"

export interface PackageSource {
  readonly prepare: (spec: string, install?: boolean) => Promise<Host.Target>
}

type State =
  | { readonly target: string; readonly id: string; readonly status: "active" | "inactive" }
  | { readonly target: string; readonly status: "unsupported" }
  | { readonly target: string; readonly id?: string; readonly status: "failed"; readonly error: string }

type RegisteredPlugin = {
  readonly id: string
  readonly source: "builtin" | "external"
  readonly active: boolean
}

type Value = {
  readonly ready: () => boolean
  readonly list: () => ReadonlyArray<State>
  readonly server: () => readonly PluginInfo[]
  readonly registered: () => ReadonlyArray<RegisteredPlugin>
  readonly route: (id: string, name: string) => Page["render"] | undefined
  readonly slots: {
    // A mounted <Slot> instance registers its path; the disposer unregisters.
    readonly register: (path: string) => () => void
    readonly resolved: () => ReturnType<typeof resolveSlots<SlotRender>>
  }
  readonly markdown: () => MarkdownOptions["renderNode"]
  readonly activate: (id: string) => Promise<boolean>
  readonly deactivate: (id: string) => Promise<boolean>
}

type Registration = {
  plugin: Plugin.Definition
  source: RegisteredPlugin["source"]
  target?: string
  version: string
  options?: Readonly<Record<string, any>>
  active: boolean
  routes: Record<string, Page>
  slots: Record<string, RegisteredSlot>
  markdown: Record<string, MarkdownCodeBlockRenderer>
  cleanups: Dispose[]
}

// One entry of the desired plugin generation produced by the resolve phase.
type Desired = Pick<Registration, "plugin" | "source" | "target" | "version" | "options"> & { enabled: boolean }
type Trace = <T>(stage: string, tags: LogTags, task: () => Promise<T>) => Promise<T>

const PluginContext = createContext<Value>()

export function PluginProvider(props: ParentProps<{ packages: PackageSource; directories: string[] }>) {
  const host = usePluginHost()
  const log = useLog({ component: "plugin" })
  const config = useConfig()
  const lifecycle = useTuiLifecycle()
  const client = useClient()
  const data = useData()
  const [serverPlugins, setServerPlugins] = createSignal<readonly PluginInfo[]>([])
  const serverTuiPlugins = createMemo(() =>
    serverPlugins().filter(
      (plugin): plugin is PluginInfo & { readonly source: { readonly type: "package" } | { readonly type: "local" } } =>
        plugin.state.status === "active" &&
        plugin.features.tui === true &&
        (plugin.source.type === "package" || plugin.source.type === "local"),
    ),
  )
  const directory = config.path ? path.dirname(config.path) : process.cwd()
  const [store, setStore] = createStore({
    ready: false,
    states: [] as ReadonlyArray<State>,
    registrations: {} as Record<string, Registration>,
  })
  // One save can emit several watch events. Remember setup failures so those
  // events do not repeatedly tear down and restore the last good generation.
  const setupFailures = new Map<string, { version: string; options: Registration["options"]; error: string }>()
  let operationID = 0
  const trace: Trace = (stage, tags, task) => {
    const id = ++operationID
    const started = Date.now()
    log.debug("plugin operation started", { id, stage, ...tags })
    const stalled = setTimeout(
      () => log.warn("plugin operation stalled", { id, stage, elapsedMs: Date.now() - started, ...tags }),
      5_000,
    )
    return task()
      .then(
        (value) => {
          log.debug("plugin operation completed", { id, stage, durationMs: Date.now() - started, ...tags })
          return value
        },
        (error) => {
          log.warn("plugin operation failed", {
            id,
            stage,
            durationMs: Date.now() - started,
            error: errorMessage(error),
            ...tags,
          })
          throw error
        },
      )
      .finally(() => clearTimeout(stalled))
  }
  const markdown = createMarkdownRenderer(() =>
    Object.values(store.registrations).flatMap((registration) => (registration.active ? [registration.markdown] : [])),
  )
  const clearContributions = (id: string) => {
    setStore("registrations", id, "routes", reconcileStore({}))
    setStore("registrations", id, "slots", reconcileStore({}))
    setStore("registrations", id, "markdown", reconcileStore({}))
  }

  const activate = async (id: string) => {
    const item = store.registrations[id]
    if (!item) return false
    await deactivate(id)
    batch(() => {
      clearContributions(id)
      setStore("registrations", id, "cleanups", [])
    })
    const owned: Dispose[] = []
    const context = createPluginContext({
      host,
      id,
      options: item.options,
      owned,
      registry: {
        has: (kind, name) => Boolean(store.registrations[id]?.[kind][name]),
        set: (
          kind: "routes" | "slots" | "markdown",
          name: string,
          value: Page | RegisteredSlot | MarkdownCodeBlockRenderer,
        ) => setStore("registrations", id, kind, name, () => value),
        remove: (kind, name) =>
          setStore(
            "registrations",
            produce((registrations) => {
              if (!registrations[id]) return
              delete registrations[id][kind][name]
            }),
          ),
        active: () => Boolean(store.registrations[id]?.active),
      },
    })
    const cleanup = await trace("setup", { plugin: id, target: item.target }, () =>
      setup(item.plugin, context, owned),
    ).catch((error) => {
      clearContributions(id)
      if (item.target)
        setupFailures.set(item.target, {
          version: item.version,
          options: snapshotOptions(item.options),
          error: errorMessage(error),
        })
      throw error
    })
    if (cleanup) owned.push(async () => cleanup())
    if (item.target && sameGeneration(setupFailures.get(item.target), item)) setupFailures.delete(item.target)
    batch(() => {
      setStore("registrations", id, "cleanups", owned)
      setStore("registrations", id, "active", true)
      setStore("states", (items) =>
        items.map((state) =>
          "id" in state && state.id === id ? { target: state.target, id, status: "active" } : state,
        ),
      )
    })
    return true
  }

  const deactivate = async (id: string) => {
    const item = store.registrations[id]
    if (!item?.active) return false
    const cleanups = [...item.cleanups]
    batch(() => {
      setStore("registrations", id, "active", false)
      setStore("registrations", id, "cleanups", [])
    })
    await trace("cleanup", { plugin: id, target: item.target, cleanups: cleanups.length }, () =>
      disposeAll(cleanups),
    ).finally(() =>
      batch(() => {
        if (store.registrations[id]) {
          clearContributions(id)
        }
        setStore("states", (items) =>
          items.map((state) =>
            "id" in state && state.id === id ? { target: state.target, id, status: "inactive" } : state,
          ),
        )
      }),
    )
    return true
  }

  // Cleanup failures must not stop a swap or teardown, but they should not
  // vanish either: the old generation may still own listeners or intervals.
  const deactivateNoisily = (id: string) =>
    deactivate(id).catch((error) =>
      host.toast.show({ variant: "error", title: "Plugin", message: `${id}: cleanup failed: ${errorMessage(error)}` }),
    )

  // Every lifecycle mutation — reconciles, manual dialog toggles, shutdown —
  // is serialized through one chain so generations can never interleave.
  let loading = Promise.resolve()
  const enqueue = <T,>(task: () => Promise<T>) => {
    const result = loading.catch(() => undefined).then(task)
    loading = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  // Hot-reload local plugin sources: watch the discovery directory and any
  // local entrypoints (see watch.ts for the mechanics), debounced into a
  // serialized reconcile so bursts of events rebuild the generation once.
  let pending: ReturnType<typeof setTimeout> | undefined
  const watcher = createSourceWatcher(() => {
    clearTimeout(pending)
    pending = setTimeout(() => {
      // Observe failures immediately: a plugin cleanup that throws would
      // otherwise surface as an unhandled rejection until the next trigger.
      void enqueue(reconcile).catch(() => undefined)
    }, 100)
  })
  const stopWatching = () => {
    clearTimeout(pending)
    watcher.dispose()
  }
  const sources = createPluginSources(watcher.wait)
  onCleanup(stopWatching)

  // Rebuild the plugin generation as resolve → compare → swap, mirroring the
  // core plugin registry: fold the ordered entries into a desired end state
  // (importing only new or changed sources, before anything running is
  // touched), no-op when the generation is unchanged, and restart only the
  // plugins that differ. Membership or order changes rebuild the whole
  // generation to preserve slot-order semantics.
  // Package resolution failures would otherwise retry a full npm install on
  // every watch event; remember them until the configuration changes.
  const npmFailures = new Map<string, string>()
  let reconciliationID = 0
  const reconcile = async () => {
    const id = ++reconciliationID
    const started = Date.now()
    log.info("plugin reconciliation started", { id })
    await trace("watch", { reconciliation: id, directories: props.directories }, () =>
      Promise.all(props.directories.map(watcher.wait)).then(() => undefined),
    )
    const entries = [
      ...(
        await trace("discover", { reconciliation: id, directories: props.directories }, () =>
          discoverPluginTargets(props.directories),
        )
      ).map((entry) => ({
        entry,
        install: true,
        optional: true,
      })),
      ...serverTuiPlugins().map((plugin) => ({
        entry: plugin.source.type === "package" ? plugin.source.target : path.dirname(plugin.source.path),
        install: false,
        optional: true,
      })),
      ...(config.data.plugins ?? []).map((entry) => ({ entry, install: true, optional: false })),
    ]

    // Resolve: fold entries into one desired generation. A source that fails
    // to import keeps its running previous version and only reports failure.
    const desired = new Map<string, Desired>()
    for (const plugin of builtins)
      desired.set(plugin.id, { plugin, source: "builtin", version: "builtin", enabled: true })
    const failures: State[] = []
    for (const source of entries) {
      const entry = source.entry
      const target = typeof entry === "string" ? entry : entry.package
      if (target.startsWith("-")) {
        for (const item of desired.values()) if (matches(target.slice(1), item.plugin.id)) item.enabled = false
        continue
      }

      const selected = [...desired.values()].filter((item) => matches(target, item.plugin.id))
      if (selected.length || target === "*" || target.endsWith(".*") || target.startsWith("opencode.")) {
        for (const item of selected) item.enabled = true
        continue
      }

      const options = typeof entry === "string" ? undefined : entry.options
      const local = localSource(target, directory)
      if (
        local &&
        (await stat(local).then(
          (info) => info.isFile(),
          (error) => (isMissingPath(error) ? false : Promise.reject(error)),
        ))
      )
        continue
      // Watch even when the resolve below fails so fixing a broken plugin reloads it.
      if (local) await watcher.add(fileURLToPath(local))
      const previous = Object.values(store.registrations).find((registration) => registration.target === target)
      const memo = local ? undefined : npmFailures.get(target)
      const resolved = memo
        ? { status: "failed" as const, error: memo }
        : await resolvePlugin(
            target,
            local,
            options,
            previous,
            props.packages,
            source.install,
            sources.read,
            trace,
            id,
          ).catch((error) => ({
            status: "failed" as const,
            error: errorMessage(error),
          }))
      if (resolved.status === "unsupported") {
        if (source.optional) continue
        failures.push({ target, status: "unsupported" })
        continue
      }
      if (resolved.status === "failed") {
        if (!local && !previous) npmFailures.set(target, resolved.error)
        failures.push({
          target,
          id: previous?.plugin.id,
          status: "failed",
          error: previous?.active ? `${resolved.error} (previous version still active)` : resolved.error,
        })
        if (previous) desired.set(previous.plugin.id, toDesired(previous))
        continue
      }
      const setupFailure = setupFailures.get(target)
      if (setupFailure && sameGeneration(setupFailure, { version: resolved.version, options }) && previous) {
        failures.push({
          target,
          id: previous.plugin.id,
          status: "failed",
          error: previous.active ? `${setupFailure.error} (previous version still active)` : setupFailure.error,
        })
        desired.set(previous.plugin.id, toDesired(previous))
        continue
      }
      setupFailures.delete(target)
      desired.set(resolved.plugin.id, {
        plugin: resolved.plugin,
        source: "external",
        target,
        version: resolved.version,
        options,
        enabled: true,
      })
    }

    // Compare: unchanged plugins are never touched, and a fully unchanged
    // generation is a no-op, so spurious watch events cost nothing.
    const currentIds = Object.keys(store.registrations)
    const desiredIds = [...desired.keys()]
    const structural =
      currentIds.length !== desiredIds.length || currentIds.some((id, index) => desiredIds[index] !== id)
    if (structural) {
      await Promise.all(
        Object.entries(store.registrations)
          .filter(([, registration]) => registration.active)
          .map(([id]) => deactivateNoisily(id)),
      )
      setStore("registrations", reconcileStore({}))
    }
    const changed = structural
      ? desiredIds
      : desiredIds.filter((id) => {
          const registration = store.registrations[id]!
          const item = desired.get(id)!
          // enabled derives from config directives alone, so config wins over
          // manual dialog toggles on every reconcile — the same semantics
          // config saves had before hot reload existed, just more frequent.
          return !sameGeneration(registration, item) || registration.active !== item.enabled
        })

    // Swap: cleanup failures surface as a toast, never propagate, so one
    // broken plugin cannot take the rest of the generation down.
    const errors = new Map<string, string>()
    for (const id of changed) {
      const item = desired.get(id)!
      const registration = store.registrations[id]
      const replaced = !registration || !sameGeneration(registration, item)
      // Snapshot the running version before it is overwritten: an import
      // failure keeps last-good in the resolve phase, and a setup failure
      // must not cost the previous version either.
      const fallback = replaced && registration ? toDesired(registration) : undefined
      if (replaced) {
        if (registration) await deactivateNoisily(id)
        // In-place replacement keeps the registration's key position, which
        // slot ordering (mode "replace" takes the last one) depends on.
        setStore("registrations", id, toRegistration(item))
      }
      if (!item.enabled) {
        await deactivateNoisily(id)
        continue
      }
      const error = await activate(id).then(() => undefined, errorMessage)
      if (!error) continue
      errors.set(id, error)
      if (!fallback) continue
      setStore("registrations", id, toRegistration(fallback))
      if (!fallback.enabled) continue
      const restored = await activate(id).then(
        () => true,
        () => false,
      )
      if (restored) errors.set(id, `${error} (previous version still active)`)
    }

    const failedTargets = new Set(failures.map((failure) => failure.target))
    const states: State[] = [
      ...[...desired.values()].flatMap((item): State[] => {
        if (item.target === undefined) return []
        // A failed reload keeps this item running; the failure entry covers it.
        if (failedTargets.has(item.target)) return []
        const error = errors.get(item.plugin.id)
        if (error) return [{ target: item.target, id: item.plugin.id, status: "failed", error }]
        const status = store.registrations[item.plugin.id]?.active ? "active" : "inactive"
        return [{ target: item.target, id: item.plugin.id, status }]
      }),
      ...failures,
    ]
    // Surface newly failing plugins; repeated reconciles stay silent.
    for (const state of states)
      if (
        state.status === "failed" &&
        !store.states.some(
          (prev) => prev.status === "failed" && prev.target === state.target && prev.error === state.error,
        )
      )
        host.toast.show({
          variant: "error",
          title: `Plugin failed: ${state.target}`,
          message: "Run /plugins to view details.",
          action: { label: "Open plugins", run: () => host.keymap.dispatch("plugins.list") },
        })
    setStore("states", reconcileStore(states))
    log.info("plugin reconciliation completed", { id, durationMs: Date.now() - started, plugins: desired.size })
  }
  const slotItems = new WeakMap<SlotRender, Claim<SlotRender>>()
  // The mounted slot tree: path -> live <Slot> instance count. Reference
  // counted because the same path can be mounted several times (one composer
  // footer per session tab); a path exists while any instance is mounted.
  const [mounted, setMounted] = createStore<Record<string, number>>({})
  const registerSlot = (slotPath: string) => {
    setMounted(slotPath, (count) => (count ?? 0) + 1)
    return () =>
      setMounted(
        produce((counts) => {
          const count = counts[slotPath]
          if (count && count > 1) counts[slotPath] = count - 1
          else delete counts[slotPath]
        }),
      )
  }
  // Claims come back in enable order: registration-store key order across
  // plugins (generations preserve key positions in place), then registration
  // order within one plugin. The resolver's last-wins rules depend on it.
  const claims = createMemo(() =>
    Object.entries(store.registrations).flatMap(([id, registration]) =>
      Object.entries(registration.active ? registration.slots : {}).map(([key, slot]) => {
        // Rows downstream diff by reference; a stable claim per render
        // function keeps untouched plugins' slot rows (and their state)
        // alive across other plugins' reloads.
        const cached = slotItems.get(slot.render)
        if (cached) return cached
        // Placements are immutable once registered; unwrap the store proxy
        // so resolver reads don't subscribe tracked scopes.
        const item = { key: `${id}/${key}`, plugin: id, placement: unwrap(slot.placement), render: slot.render }
        slotItems.set(slot.render, item)
        return item
      }),
    ),
  )
  // Object.keys tracks the store's keys node only: refcount changes on an
  // already-mounted path (a second tab's composer) skip re-resolution.
  const resolved = createMemo(() => resolveSlots({ paths: new Set(Object.keys(mounted)), claims: claims() }))
  createEffect(
    on(
      () => JSON.stringify([serverTuiPlugins(), config.data.plugins ?? []]),
      () => {
        npmFailures.clear()
        void enqueue(reconcile).then(
          () => setStore("ready", true),
          () => setStore("ready", true),
        )
      },
    ),
  )
  const syncServerPlugins = () =>
    client.api.plugin
      .list({ location: data.location.default() })
      .then((response) => {
        const failed = response.data.filter(
          (plugin) =>
            plugin.state.status === "failed" &&
            !serverPlugins().some(
              (previous) =>
                serverPluginName(previous) === serverPluginName(plugin) && isDeepEqual(previous.state, plugin.state),
            ),
        )
        setServerPlugins(response.data)
        const first = failed[0]
        if (!first) return
        host.toast.show({
          variant: "error",
          title: failed.length === 1 ? `Plugin failed: ${serverPluginName(first)}` : `${failed.length} plugins failed`,
          message:
            (failed.length > 1 ? `${failed.map(serverPluginName).join(", ")}\n` : "") + "Run /plugins to view details.",
          action: { label: "Open plugins", run: () => host.keymap.dispatch("plugins.list") },
        })
      })
      .catch(() => undefined)
  createEffect(
    on(
      () => JSON.stringify(data.location.default()),
      () => void syncServerPlugins(),
    ),
  )
  onCleanup(client.event.on("plugin.updated", syncServerPlugins))
  onCleanup(client.event.on("server.connected", syncServerPlugins))
  onMount(() => {
    let disposing: Promise<void> | undefined
    const dispose = () => {
      if (disposing) return disposing
      stopWatching()
      disposing = loading
        .catch(() => undefined)
        .then(() =>
          Promise.all(
            Object.entries(store.registrations)
              .filter(([, registration]) => registration.active)
              .map(([id]) => deactivate(id).catch(() => undefined)),
          ),
        )
        .then(() => setStore("registrations", reconcileStore({})))
        .finally(sources.dispose)
      return disposing
    }
    const unregister = lifecycle.add(dispose)
    onCleanup(() => {
      unregister()
      void dispose()
    })
  })

  return (
    <PluginContext.Provider
      value={{
        ready: () => store.ready,
        list: () => store.states,
        server: serverPlugins,
        registered: () =>
          Object.entries(store.registrations).map(([id, plugin]) => ({
            id,
            source: plugin.source,
            active: plugin.active,
          })),
        route: (id, name) => store.registrations[id]?.routes[name]?.render,
        slots: { register: registerSlot, resolved },
        markdown,
        // Manual dialog toggles join the same chain as reconciles so a
        // toggle mid-reload cannot mix registrations across generations.
        activate: (id) => enqueue(() => activate(id)),
        deactivate: (id) => enqueue(() => deactivate(id)),
      }}
    >
      {props.children}
    </PluginContext.Provider>
  )
}

function serverPluginName(plugin: PluginInfo) {
  return (
    plugin.id ??
    (plugin.source.type === "package"
      ? plugin.source.target
      : plugin.source.type === "local"
        ? plugin.source.path
        : plugin.source.type)
  )
}

async function disposeAll(cleanups: Dispose[]) {
  const failures: unknown[] = []
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch((error) => failures.push(error))
  if (failures.length) throw failures[0]
}

async function setup(plugin: Plugin.Definition, context: Plugin.Context, owned: Dispose[]) {
  try {
    return await plugin.setup(context)
  } catch (error) {
    await disposeAll(owned).catch(() => undefined)
    throw error
  }
}

function matches(selector: string, id: string) {
  return selector === "*" || selector === id || (selector.endsWith(".*") && id.startsWith(selector.slice(0, -1)))
}

async function resolvePlugin(
  spec: string,
  local: URL | undefined,
  options: Readonly<Record<string, any>> | undefined,
  previous: Registration | undefined,
  packages: PackageSource,
  install: boolean,
  readSource: ReturnType<typeof createPluginSources>["read"],
  trace: Trace,
  reconciliation: number,
) {
  // Package entrypoints never change within a session, so a loaded previous
  // version needs no re-resolution (which could otherwise hit npm).
  if (!local && previous && sameOptions(previous.options, options))
    return { status: "unchanged" as const, plugin: previous.plugin, version: previous.version }
  const target = local
    ? { directory: fileURLToPath(local) }
    : await trace("prepare", { reconciliation, target: spec, install }, () => packages.prepare(spec, install))
  const entrypoint = Host.resolve(target).tui
  if (!entrypoint) return { status: "unsupported" as const }
  // Content remains stable across the several mtimes one save may expose to
  // filesystem watchers, while the generation keeps reverted modules fresh.
  let source = local
    ? await trace("read", { reconciliation, target: spec, entrypoint }, () => readSource(entrypoint))
    : {
        version: entrypoint,
        module: await trace("load", { reconciliation, target: spec, entrypoint }, () => Host.load(entrypoint)),
      }
  while (true) {
    const version = source.version
    if (previous && previous.version === version && sameOptions(previous.options, options))
      return { status: "unchanged" as const, plugin: previous.plugin, version }
    const mod = source.module
    if (local) {
      const observed = await readSource(entrypoint)
      // In-place saves can change the file between hashing and import. Retry
      // so setup always runs under the generation of the imported bytes.
      if (version !== observed.version) {
        source = observed
        continue
      }
    }
    if (typeof mod !== "object" || mod === null || !("default" in mod) || !isPlugin(mod.default))
      throw new Error(`Invalid V2 TUI plugin module: ${spec}`)
    return { status: "loaded" as const, plugin: mod.default, version }
  }
}

function toRegistration(item: Desired): Registration {
  return {
    plugin: item.plugin,
    source: item.source,
    target: item.target,
    version: item.version,
    options: snapshotOptions(item.options),
    active: false,
    routes: {},
    slots: {},
    markdown: {},
    cleanups: [],
  }
}

function toDesired(item: Registration): Desired {
  return {
    plugin: item.plugin,
    source: item.source,
    target: item.target,
    version: item.version,
    options: item.options,
    enabled: item.active,
  }
}

function sameOptions(a: Registration["options"], b: Registration["options"]) {
  return isDeepEqual(a ?? null, b ?? null)
}

function sameGeneration(
  a: Pick<Registration, "version" | "options"> | undefined,
  b: Pick<Registration, "version" | "options">,
) {
  return a?.version === b.version && sameOptions(a.options, b.options)
}

function snapshotOptions(options: Registration["options"]) {
  return options ? structuredClone(unwrap(options)) : undefined
}

function isPlugin(value: unknown): value is Plugin.Definition {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    typeof value.id === "string" &&
    value.id.length > 0 &&
    "setup" in value &&
    typeof value.setup === "function"
  )
}

export function usePlugin() {
  const value = useContext(PluginContext)
  if (!value) throw new Error("PluginProvider is missing")
  return value
}
