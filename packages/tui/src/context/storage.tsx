import { batch, createContext, onCleanup, useContext, type ParentProps } from "solid-js"
import { createStore, produce, reconcile, type Store } from "solid-js/store"
import path from "path"
import { mkdirSync, readFileSync, watch } from "fs"
import { Flock } from "@opencode/util/flock"
import { writeJsonAtomic } from "../util/persistence"
import { useTuiApp, useTuiPaths } from "./runtime"

type Options<Value extends object> = {
  readonly initial: Value
  /** Reconcile key for arrays inside the stored value, preserving item identity across updates. Defaults to "id". */
  readonly key?: string
}

type Entry<Value extends object> = readonly [Store<Value>, (mutation: (draft: Value) => void) => Promise<void>]
type MemoryEntry<Value extends object> = readonly [Store<Value>, (mutation: (draft: Value) => void) => void]

export interface Storage {
  store<Value extends object>(
    key: string,
    options: Options<Value>,
  ): readonly [Store<Value>, (mutation: (draft: Value) => void) => Promise<void>]
  /**
   * Ephemeral in-process state. Entries are memoized here, above consumer
   * lifecycles, so the same live store survives plugin hot reloads; it is
   * gone when the TUI exits. Updates are synchronous and values need not be
   * JSON-serializable.
   */
  memory<Value extends object>(key: string, options: { readonly initial: Value }): MemoryEntry<Value>
  flush(): Promise<void>
}

function clone<Value extends object>(value: Value) {
  const json = JSON.stringify(value)
  if (json === undefined) throw new TypeError("Storage values must be JSON-compatible objects")
  const result = JSON.parse(json) as Value
  if (typeof result !== "object" || result === null) throw new TypeError("Storage values must be objects")
  return result as Value
}

function segment(value: string) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value) || value === "." || value === "..")
    throw new TypeError(`Invalid storage segment: ${value}`)
  return value
}

function createStorage(root: string, channel: string) {
  const entries = new Map<string, { readonly value: Entry<object>; readonly reload: () => void }>()
  const memories = new Map<string, MemoryEntry<object>>()
  const pending = new Set<Promise<void>>()
  const directory = path.join(root, segment(channel), "tui")
  const locks = path.join(root, segment(channel), "locks")
  mkdirSync(directory, { recursive: true })

  const storage: Storage = {
    store<Value extends object>(key: string, options: Options<Value>) {
      const file = path.join(directory, segment(key) + ".json")
      const existing = entries.get(file)
      if (existing) return existing.value as Entry<Value>

      const load = () => {
        try {
          return clone(JSON.parse(readFileSync(file, "utf8")) as Value)
        } catch {
          return clone(options.initial)
        }
      }
      const [store, setStore] = createStore(load())
      const merge = (next: Value) => reconcile(next, { key: options.key })
      const reload = () => batch(() => setStore(merge(load())))
      const update = (mutation: (draft: Value) => void) => {
        const operation = Flock.withLock(
          file,
          async () => {
            const draft = load()
            mutation(draft)
            const next = clone(draft)
            await writeJsonAtomic(file, next)
            batch(() => setStore(merge(next)))
          },
          { dir: locks },
        )
        pending.add(operation)
        operation.then(
          () => pending.delete(operation),
          () => pending.delete(operation),
        )
        return operation
      }
      const entry = [store, update] as const
      entries.set(file, { value: entry as Entry<object>, reload })
      return entry
    },
    memory<Value extends object>(key: string, options: { readonly initial: Value }) {
      const existing = memories.get(key)
      if (existing) return existing as MemoryEntry<Value>
      const [store, setStore] = createStore(options.initial)
      const entry = [store, (mutation: (draft: Value) => void) => setStore(produce(mutation))] as const
      memories.set(key, entry as MemoryEntry<object>)
      return entry
    },
    async flush() {
      const failures: unknown[] = []
      while (pending.size > 0) {
        const results = await Promise.allSettled(pending)
        failures.push(...results.filter((result) => result.status === "rejected").map((result) => result.reason))
      }
      if (failures.length === 1) throw failures[0]
      if (failures.length > 1) throw new AggregateError(failures, "Storage writes failed")
    },
  }

  let reload: ReturnType<typeof setTimeout> | undefined
  const watcher = watch(directory, () => {
    clearTimeout(reload)
    // Atomic writes notify for the temporary file before its final rename, and some
    // platforms coalesce the rename event. Reload after the event burst has settled.
    reload = setTimeout(() => entries.forEach((entry) => entry.reload()), 50)
  })
  return {
    storage,
    close: () => {
      clearTimeout(reload)
      watcher.close()
    },
  }
}

const Context = createContext<Storage>()

export function StorageProvider(props: ParentProps) {
  const result = createStorage(useTuiPaths().state, useTuiApp().channel)
  onCleanup(result.close)
  return <Context.Provider value={result.storage}>{props.children}</Context.Provider>
}

export function useStorage() {
  const storage = useContext(Context)
  if (!storage) throw new Error("StorageProvider is missing")
  return storage
}

export function useStorageOptional() {
  return useContext(Context)
}
