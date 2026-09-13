import path from "node:path"
import { Effect, PlatformError } from "effect"
import { make } from "effect/unstable/process/ChildProcessSpawner"
import type { Driver } from "./driver.js"
import { Failed, NotFound, WrongKind, type FileInfo, type FilesImpl, type FileType } from "./files.js"

type Node =
  | { readonly type: "file"; readonly bytes: Uint8Array; readonly mtimeMs: number }
  | { readonly type: "directory"; readonly mtimeMs: number }
  | { readonly type: "symlink"; readonly target: string; readonly mtimeMs: number }

export interface MemoryDriver extends Driver {
  readonly symlink: (target: string, path: string) => Effect.Effect<void, Failed>
}

export const makeMemoryDriver = (): MemoryDriver => {
  const nodes = new Map<string, Node>([["/", { type: "directory", mtimeMs: Date.now() }]])
  const key = (value: string) => path.posix.resolve("/", value)
  const info = (node: Node): FileInfo => ({
    type: node.type,
    size:
      node.type === "file"
        ? node.bytes.length
        : node.type === "symlink"
          ? new TextEncoder().encode(node.target).length
          : 0,
    mtimeMs: node.mtimeMs,
  })
  const resolveKey = (value: string, followFinal: boolean, seen = new Set<string>()): string | undefined => {
    const normalized = key(value)
    const parts = normalized.split("/").filter(Boolean)
    const base = "/"
    const walk = (current: string, index: number): string | undefined => {
      if (index === parts.length) return current
      const part = parts[index]
      const candidate = path.posix.join(current, part)
      const node = nodes.get(candidate)
      if (node?.type !== "symlink" || (!followFinal && index === parts.length - 1)) return walk(candidate, index + 1)
      if (seen.has(candidate)) return undefined
      seen.add(candidate)
      const target = path.posix.resolve(path.posix.dirname(candidate), node.target)
      return resolveKey(path.posix.join(target, ...parts.slice(index + 1)), followFinal, seen)
    }
    return walk(base, 0)
  }
  const lookup = (value: string) => nodes.get(resolveKey(value, false) ?? key(value))
  const requireParent = (value: string) => {
    const parentPath = path.posix.dirname(key(value))
    const parent = nodes.get(resolveKey(parentPath, true) ?? parentPath)
    if (!parent) throw new Error(`Parent directory does not exist: ${path.posix.dirname(value)}`)
    if (parent.type !== "directory") throw new Error(`Parent is not a directory: ${path.posix.dirname(value)}`)
  }
  const mkdirSync = (value: string) => {
    const target = resolveKey(value, false) ?? key(value)
    const existing = nodes.get(target)
    if (existing?.type === "directory") return
    if (existing) throw new Error(`Path is not a directory: ${value}`)
    const parent = path.posix.dirname(target)
    if (parent !== target) mkdirSync(parent)
    nodes.set(target, { type: "directory", mtimeMs: Date.now() })
  }
  const failed = (value: string, cause: unknown) => new Failed({ path: value, cause })
  const overrides: FilesImpl = {
    realpath: (value) =>
      Effect.suspend(() => {
        const resolved = resolveKey(value, true)
        return resolved && nodes.has(resolved) ? Effect.succeed(resolved) : Effect.fail(new NotFound({ path: value }))
      }),
    stat: (value) =>
      Effect.suspend(() => {
        const node = lookup(value)
        return node ? Effect.succeed(info(node)) : Effect.fail(new NotFound({ path: value }))
      }),
    read: (value, range) =>
      Effect.gen(function* () {
        const original = lookup(value)
        if (!original) return yield* new NotFound({ path: value })
        if (original.type === "directory") return yield* new WrongKind({ path: value, actual: "directory" })
        const resolved = resolveKey(value, true)
        const node = resolved === undefined ? undefined : nodes.get(resolved)
        if (!node) return yield* new NotFound({ path: value })
        if (node.type !== "file") return yield* new WrongKind({ path: value, actual: node.type })
        const bytes = range === undefined ? node.bytes : node.bytes.subarray(range.offset, range.offset + range.length)
        return { info: info(node), bytes: bytes.slice() }
      }),
    write: (value, bytes) =>
      Effect.try({
        try: () => {
          mkdirSync(path.posix.dirname(key(value)))
          const existing = lookup(value)
          if (existing?.type === "directory") throw new Error(`Path is a directory: ${value}`)
          const target = existing?.type === "symlink" ? resolveKey(value, true) : resolveKey(value, false)
          if (!target) throw new Error(`Cannot resolve symlink: ${value}`)
          requireParent(target)
          nodes.set(target, { type: "file", bytes: bytes.slice(), mtimeMs: Date.now() })
        },
        catch: (cause) => failed(value, cause),
      }),
    list: (value) =>
      Effect.gen(function* () {
        const target = resolveKey(value, true) ?? key(value)
        const node = nodes.get(target)
        if (!node) return yield* new NotFound({ path: value })
        if (node.type !== "directory") return yield* new WrongKind({ path: value, actual: node.type })
        return [...nodes.entries()]
          .filter(([entry]) => entry !== target && path.posix.dirname(entry) === target)
          .map(([entry, child]) => ({ name: path.posix.basename(entry), type: child.type satisfies FileType }))
          .sort((a, b) => a.name.localeCompare(b.name))
      }),
    remove: (value) =>
      Effect.sync(() => {
        const target = resolveKey(value, false) ?? key(value)
        for (const entry of nodes.keys()) {
          if (entry === target || entry.startsWith(`${target}/`)) nodes.delete(entry)
        }
      }),
    move: (from, to) =>
      Effect.gen(function* () {
        const source = resolveKey(from, false) ?? key(from)
        const node = nodes.get(source)
        if (!node) return yield* new NotFound({ path: from })
        yield* Effect.try({
          try: () => {
            const requested = resolveKey(to, false) ?? key(to)
            const destination =
              nodes.get(requested)?.type === "directory"
                ? path.posix.join(requested, path.posix.basename(source))
                : requested
            if (node.type === "directory" && destination.startsWith(`${source}/`)) {
              throw new Error(`Cannot move a directory into itself: ${from}`)
            }
            const existing = nodes.get(destination)
            if (node.type === "directory" && existing && existing.type !== "directory") {
              throw new Error(`Cannot overwrite a non-directory with a directory: ${to}`)
            }
            requireParent(destination)
            const moved = [...nodes.entries()].filter(([entry]) => entry === source || entry.startsWith(`${source}/`))
            for (const [entry] of moved) nodes.delete(entry)
            for (const [entry, child] of moved) nodes.set(`${destination}${entry.slice(source.length)}`, child)
          },
          catch: (cause) => failed(from, cause),
        })
      }),
    mkdir: (value) => Effect.try({ try: () => mkdirSync(value), catch: (cause) => failed(value, cause) }),
  }

  const spawner = make((command) =>
    Effect.suspend(() => {
      const description = command._tag === "StandardCommand" ? command.command : "pipeline"
      return Effect.fail(
        PlatformError.systemError({
          _tag: "Unknown",
          module: "EnvironmentMemory",
          method: "spawn",
          pathOrDescriptor: description,
          cause: failed(description, new Error("The memory driver cannot spawn processes")),
        }),
      )
    }),
  )

  return {
    spawner,
    overrides,
    symlink: (target, value) =>
      Effect.try({
        try: () => {
          requireParent(value)
          nodes.set(resolveKey(value, false) ?? key(value), { type: "symlink", target, mtimeMs: Date.now() })
        },
        catch: (cause) => failed(value, cause),
      }),
  }
}

export * as EnvironmentMemory from "./memory.js"
