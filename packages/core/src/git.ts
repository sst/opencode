export * as Git from "./git"

import path from "path"
import { randomUUID } from "crypto"
import { Context, Effect, Layer, Schema, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { AbsolutePath, RelativePath } from "./schema"
import { FSUtil } from "./fs-util"
import { AppProcess } from "./process"
import { makeGlobalNode } from "./effect/app-node"
import { File } from "./file"
import { KeyedMutex } from "./effect/keyed-mutex"

export class Repository extends Schema.Class<Repository>("Git.Repository")({
  worktree: AbsolutePath,
  gitDirectory: AbsolutePath,
  commonDirectory: AbsolutePath,
}) {}

export const ChangeSet = Schema.String.pipe(Schema.brand("Git.ChangeSet"))
export type ChangeSet = typeof ChangeSet.Type

export const TreeID = Schema.String.pipe(Schema.brand("Git.TreeID"))
export type TreeID = typeof TreeID.Type

export class OperationError extends Schema.TaggedErrorClass<OperationError>()("Git.OperationError", {
  operation: Schema.Literals([
    "clone",
    "fetch",
    "checkout",
    "reset",
    "create",
    "refresh",
    "write_tree",
    "list_files",
    "diff",
    "restore",
  ]),
  message: Schema.String,
  directory: Schema.optional(AbsolutePath),
  cause: Schema.optional(Schema.Defect()),
}) {}

export class Worktree extends Schema.Class<Worktree>("Git.Worktree")({
  directory: AbsolutePath,
  kind: Schema.Literals(["main", "linked"]),
}) {}

export class WorktreeError extends Schema.TaggedErrorClass<WorktreeError>()("Git.WorktreeError", {
  operation: Schema.Literals(["create", "remove", "list"]),
  message: Schema.String,
  directory: Schema.optional(AbsolutePath),
  forceRequired: Schema.optional(Schema.Boolean),
  cause: Schema.optional(Schema.Defect()),
}) {}

export class PatchError extends Schema.TaggedErrorClass<PatchError>()("Git.PatchError", {
  operation: Schema.Literals(["capture", "apply", "reset"]),
  directory: AbsolutePath,
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export interface Interface {
  readonly repo: {
    readonly discover: (input: AbsolutePath) => Effect.Effect<Repository | undefined>
    readonly clone: (input: {
      remote: string
      directory: AbsolutePath
      branch?: string
      depth?: number
    }) => Effect.Effect<Repository, OperationError>
    readonly create: (input: {
      worktree: AbsolutePath
      gitDirectory: AbsolutePath
      seed?: Repository
    }) => Effect.Effect<Repository, OperationError>
  }
  readonly remote: {
    readonly get: (repository: Repository, name?: string) => Effect.Effect<string | undefined>
  }
  readonly history: {
    readonly head: (repository: Repository) => Effect.Effect<string | undefined>
    readonly branch: (repository: Repository) => Effect.Effect<string | undefined>
    readonly defaultRemoteBranch: (repository: Repository, remote?: string) => Effect.Effect<string | undefined>
    readonly rootCommits: (repository: Repository) => Effect.Effect<readonly string[]>
  }
  readonly sync: {
    readonly fetchRemotes: (repository: Repository, input?: { prune?: boolean }) => Effect.Effect<void, OperationError>
    readonly fetchBranch: (
      repository: Repository,
      input: { remote?: string; branch: string; force?: boolean },
    ) => Effect.Effect<void, OperationError>
    readonly checkoutRemoteBranch: (
      repository: Repository,
      input: { remote?: string; branch: string; reset?: boolean },
    ) => Effect.Effect<void, OperationError>
    readonly resetHard: (repository: Repository, revision: string) => Effect.Effect<void, OperationError>
  }
  readonly change: {
    readonly capture: (input: { repository: Repository; path: AbsolutePath }) => Effect.Effect<ChangeSet, PatchError>
    readonly apply: (input: {
      repository: Repository
      path: AbsolutePath
      changes: ChangeSet
    }) => Effect.Effect<void, PatchError>
    readonly discard: (input: {
      repository: Repository
      path: AbsolutePath
      index: "preserve" | "reset"
      untracked: "preserve" | "remove"
    }) => Effect.Effect<void, PatchError>
  }
  readonly worktree: {
    readonly create: (input: {
      repository: Repository
      directory: AbsolutePath
    }) => Effect.Effect<Repository, WorktreeError>
    readonly remove: (input: {
      repository: Repository
      directory: AbsolutePath
      force: boolean
    }) => Effect.Effect<void, WorktreeError>
    readonly list: (repository: Repository) => Effect.Effect<readonly Worktree[], WorktreeError>
  }
  readonly index: {
    /** Refresh only the requested project-relative scope, preserving all other entries. */
    readonly refresh: (input: {
      repository: Repository
      scope: RelativePath
      ignores?: Repository
      maximumUntrackedFileBytes?: number
    }) => Effect.Effect<{ readonly skipped: readonly RelativePath[] }, OperationError>
    readonly ignored: (input: {
      repository: Repository
      paths: readonly RelativePath[]
    }) => Effect.Effect<ReadonlySet<RelativePath>, OperationError>
  }
  readonly tree: {
    readonly capture: (input: {
      repository: Repository
      scopes: readonly RelativePath[]
      ignores?: Repository
      maximumUntrackedFileBytes?: number
    }) => Effect.Effect<TreeID, OperationError>
    readonly write: (repository: Repository) => Effect.Effect<TreeID, OperationError>
    readonly files: (input: {
      repository: Repository
      from: TreeID
      to: TreeID
    }) => Effect.Effect<readonly RelativePath[], OperationError>
    readonly diff: (input: {
      repository: Repository
      from: TreeID
      to: TreeID
      context?: number
      paths?: readonly RelativePath[]
    }) => Effect.Effect<readonly File.Diff[], OperationError>
    readonly preview: (input: {
      repository: Repository
      current: TreeID
      files: ReadonlyMap<RelativePath, TreeID>
      context?: number
    }) => Effect.Effect<readonly File.Diff[], OperationError>
    readonly restore: (input: {
      repository: Repository
      files: ReadonlyMap<RelativePath, TreeID>
    }) => Effect.Effect<void, OperationError>
    readonly checkout: (input: { repository: Repository; tree: TreeID }) => Effect.Effect<void, OperationError>
  }
}

export class Service extends Context.Service<Service, Interface>()("@opencode/GitV2") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const proc = yield* AppProcess.Service
    const locks = KeyedMutex.makeUnsafe<string>()
    const locked = <A, E, R>(repository: Repository, effect: Effect.Effect<A, E, R>) =>
      locks.withLock(repository.gitDirectory)(effect)

    // PERF: repo discovery spawns 3 git processes per call and runs 2-3x per
    // instance boot (project resolution + watcher init). Repository topology is
    // stable, so memoize positive results (negative results stay uncached so a
    // later `git init` is picked up).
    const discovered = new Map<string, { at: number; value: Repository }>()
    const DISCOVER_TTL_MS = 600_000

    // A cached Repository can go stale before the TTL when its .git dir is
    // deleted, a worktree is removed, or GIT_DIR relocates. Runs that fail
    // against a dead repository (spawn failure -> empty stderr, or git's own
    // "not a git repository") evict the memo instead of waiting out the TTL.
    const forget = (repository: Repository) => {
      for (const [key, entry] of discovered) {
        if (entry.value.gitDirectory === repository.gitDirectory || entry.value.worktree === repository.worktree) {
          discovered.delete(key)
        }
      }
    }
    const repoRun = (repository: Repository, args: string[]) =>
      run(repository.worktree, proc)(args).pipe(
        Effect.tap((result) => {
          if (
            result.exitCode !== 0 &&
            (result.stderr === "" || result.stderr.includes("not a git repository"))
          ) {
            forget(repository)
          }
          return Effect.void
        }),
      )

    const discover = Effect.fn("Git.repo.discover")(function* (input: AbsolutePath) {
      const hit = discovered.get(input)
      if (hit && Date.now() - hit.at < DISCOVER_TTL_MS) return hit.value

      const dotgit = yield* fs.up({ targets: [".git"], start: input }).pipe(
        Effect.map((matches) => matches[0]),
        Effect.catch(() => Effect.succeed(undefined)),
      )
      if (!dotgit) return undefined

      const cwd = path.dirname(dotgit)
      const git = run(cwd, proc)
      const topLevel = yield* git(["rev-parse", "--show-toplevel"])
      const gitDir = yield* git(["rev-parse", "--git-dir"])
      const commonDir = yield* git(["rev-parse", "--git-common-dir"])
      if (gitDir.exitCode !== 0 || commonDir.exitCode !== 0) return undefined

      const value = new Repository({
        worktree: AbsolutePath.make(topLevel.exitCode === 0 ? resolvePath(cwd, topLevel.text) : cwd),
        gitDirectory: AbsolutePath.make(resolvePath(cwd, gitDir.text)),
        commonDirectory: AbsolutePath.make(resolvePath(cwd, commonDir.text)),
      })
      if (discovered.size > 1024) discovered.clear()
      discovered.set(input, { at: Date.now(), value })
      return value
    })

    const remote = Effect.fn("Git.remote.get")(function* (repository: Repository, name = "origin") {
      const result = yield* repoRun(repository, ["remote", "get-url", name])
      if (result.exitCode !== 0) return undefined
      return result.text.trim() || undefined
    })

    const roots = Effect.fn("Git.history.rootCommits")(function* (repository: Repository) {
      const result = yield* repoRun(repository, ["rev-list", "--max-parents=0", "HEAD"])
      if (result.exitCode !== 0) return []
      return result.text
        .split("\n")
        .map((item) => item.trim())
        .filter(Boolean)
        .toSorted()
    })

    const head = Effect.fn("Git.history.head")(function* (repository: Repository) {
      const result = yield* repoRun(repository, ["rev-parse", "HEAD"])
      if (result.exitCode !== 0) return undefined
      return result.text.trim() || undefined
    })

    const branch = Effect.fn("Git.history.branch")(function* (repository: Repository) {
      const result = yield* repoRun(repository, ["symbolic-ref", "--quiet", "--short", "HEAD"])
      if (result.exitCode !== 0) return undefined
      return result.text.trim() || undefined
    })

    const remoteHead = Effect.fn("Git.history.defaultRemoteBranch")(function* (
      repository: Repository,
      remoteName = "origin",
    ) {
      const result = yield* repoRun(repository, ["symbolic-ref", `refs/remotes/${remoteName}/HEAD`])
      if (result.exitCode !== 0) return undefined
      return result.text.trim().replace(new RegExp(`^refs/remotes/${remoteName}/`), "") || undefined
    })

    const operation = Effect.fnUntraced(function* (
      operation: OperationError["operation"],
      directory: AbsolutePath,
      args: string[],
    ) {
      const result = yield* execute(
        directory,
        proc,
      )(args).pipe(
        Effect.mapError((cause) => new OperationError({ operation, directory, message: cause.message, cause })),
      )
      if (result.exitCode === 0) return
      return yield* new OperationError({
        operation,
        directory,
        message: result.stderr.trim() || result.text.trim() || `Git ${operation} failed`,
      })
    })

    const clone = Effect.fn("Git.repo.clone")(function* (input: {
      remote: string
      directory: AbsolutePath
      branch?: string
      depth?: number
    }) {
      yield* operation("clone", AbsolutePath.make(path.dirname(input.directory)), [
        "clone",
        "--depth",
        String(input.depth ?? 100),
        ...(input.branch ? ["--branch", input.branch] : []),
        "--",
        input.remote,
        input.directory,
      ])
      const repository = yield* discover(input.directory)
      if (repository) return repository
      return yield* new OperationError({
        operation: "clone",
        directory: input.directory,
        message: "Cloned repository could not be opened",
      })
    })

    const fetch = Effect.fn("Git.sync.fetchRemotes")(function* (
      repository: Repository,
      input: { prune?: boolean } = {},
    ) {
      yield* operation("fetch", repository.worktree, ["fetch", "--all", ...(input.prune === false ? [] : ["--prune"])])
    })

    const fetchBranch = Effect.fn("Git.sync.fetchBranch")(function* (
      repository: Repository,
      input: { remote?: string; branch: string; force?: boolean },
    ) {
      const remoteName = input.remote ?? "origin"
      const spec = `refs/heads/${input.branch}:refs/remotes/${remoteName}/${input.branch}`
      yield* operation("fetch", repository.worktree, ["fetch", remoteName, input.force === false ? spec : `+${spec}`])
    })

    const checkout = Effect.fn("Git.sync.checkoutRemoteBranch")(function* (
      repository: Repository,
      input: { remote?: string; branch: string; reset?: boolean },
    ) {
      const remoteName = input.remote ?? "origin"
      yield* operation("checkout", repository.worktree, [
        "checkout",
        ...(input.reset === false ? [input.branch] : ["-B", input.branch, `${remoteName}/${input.branch}`]),
      ])
    })

    const reset = Effect.fn("Git.sync.resetHard")(function* (repository: Repository, revision: string) {
      yield* operation("reset", repository.worktree, ["reset", "--hard", revision])
    })

    const repositoryArgs = (repository: Repository, args: string[]) => [
      "--git-dir",
      repository.gitDirectory,
      "--work-tree",
      repository.worktree,
      ...args,
    ]

    const repositoryOperation = Effect.fnUntraced(function* (
      operationName: OperationError["operation"],
      repository: Repository,
      args: string[],
      options?: { stdin?: string; env?: Record<string, string> },
    ) {
      const result = yield* proc
        .run(
          ChildProcess.make("git", repositoryArgs(repository, args), {
            cwd: repository.worktree,
            env: options?.env,
            extendEnv: true,
          }),
          { stdin: options?.stdin },
        )
        .pipe(
          Effect.mapError(
            (cause) =>
              new OperationError({
                operation: operationName,
                directory: repository.worktree,
                message: cause.message,
                cause,
              }),
          ),
        )
      const text = result.stdout.toString("utf8")
      if (result.exitCode === 0) return { text, stderr: result.stderr.toString("utf8") }
      return yield* new OperationError({
        operation: operationName,
        directory: repository.worktree,
        message: result.stderr.toString("utf8").trim() || text.trim() || `Git ${operationName} failed`,
      })
    })

    const create = Effect.fn("Git.repo.create")(function* (input: {
      worktree: AbsolutePath
      gitDirectory: AbsolutePath
      seed?: Repository
    }) {
      yield* fs.ensureDir(input.gitDirectory).pipe(
        Effect.mapError(
          (cause) =>
            new OperationError({
              operation: "create",
              directory: input.gitDirectory,
              message: "Failed to create Git storage",
              cause,
            }),
        ),
      )
      const repository = new Repository({
        worktree: input.worktree,
        gitDirectory: input.gitDirectory,
        commonDirectory: input.gitDirectory,
      })
      yield* repositoryOperation("create", repository, ["init"])
      yield* Effect.forEach(
        [
          ["core.autocrlf", "false"],
          ["core.longpaths", "true"],
          ["core.symlinks", "true"],
          ["core.fsmonitor", "false"],
          ["feature.manyFiles", "true"],
          ["index.version", "4"],
          ["index.threads", "true"],
          ["core.untrackedCache", "true"],
        ],
        ([key, value]) => repositoryOperation("create", repository, ["config", key, value]),
        { discard: true },
      )
      if (!input.seed) return repository
      yield* fs.ensureDir(path.join(input.gitDirectory, "objects", "info")).pipe(
        Effect.mapError(
          (cause) =>
            new OperationError({
              operation: "create",
              directory: input.gitDirectory,
              message: "Failed to configure shared Git objects",
              cause,
            }),
        ),
      )
      yield* fs
        .writeFileString(
          path.join(input.gitDirectory, "objects", "info", "alternates"),
          path.join(input.seed.commonDirectory, "objects") + "\n",
        )
        .pipe(
          Effect.mapError(
            (cause) =>
              new OperationError({
                operation: "create",
                directory: input.gitDirectory,
                message: "Failed to configure shared Git objects",
                cause,
              }),
          ),
        )
      yield* fs
        .copyFile(path.join(input.seed.gitDirectory, "index"), path.join(input.gitDirectory, "index"))
        .pipe(Effect.catch(() => Effect.void))
      return repository
    })

    const refresh = Effect.fn("Git.index.refresh")(function* (input: {
      repository: Repository
      scope: RelativePath
      ignores?: Repository
      maximumUntrackedFileBytes?: number
    }) {
      const list = (args: string[]) =>
        repositoryOperation("refresh", input.repository, args).pipe(
          Effect.map((result) => result.text.split("\0").filter(Boolean)),
        )
      const [tracked, untracked] = yield* Effect.all(
        [
          list(["diff-files", "--name-only", "-z", "--", input.scope]),
          list(["ls-files", "--others", "--exclude-standard", "-z", "--", input.scope]),
        ],
        { concurrency: 2 },
      )
      const candidates = Array.from(new Set([...tracked, ...untracked]))
      if (!candidates.length) return { skipped: [] }
      const ignored = input.ignores
        ? new Set(
            (yield* repositoryOperation("refresh", input.ignores, ["check-ignore", "--no-index", "--stdin", "-z"], {
              stdin: candidates.join("\0") + "\0",
            }).pipe(Effect.catch(() => Effect.succeed({ text: "", stderr: "" })))).text
              .split("\0")
              .filter(Boolean),
          )
        : new Set<string>()
      const allowed = candidates.filter((item) => !ignored.has(item))
      const maximum = input.maximumUntrackedFileBytes
      const skipped = maximum
        ? (yield* Effect.forEach(
            untracked.filter((item) => allowed.includes(item)),
            (item) =>
              fs.stat(path.join(input.repository.worktree, item)).pipe(
                Effect.map((info) =>
                  info.type === "File" && Number(info.size) > maximum ? RelativePath.make(item) : undefined,
                ),
                Effect.catch(() => Effect.succeed(undefined)),
              ),
            { concurrency: 8 },
          )).filter((item): item is RelativePath => item !== undefined)
        : []
      const stage = allowed.filter((item) => !skipped.includes(RelativePath.make(item)))
      const remove = [...ignored, ...skipped]
      if (remove.length)
        yield* repositoryOperation(
          "refresh",
          input.repository,
          ["rm", "--cached", "-f", "--ignore-unmatch", "--pathspec-from-file=-", "--pathspec-file-nul"],
          { stdin: remove.join("\0") + "\0" },
        )
      if (stage.length)
        yield* repositoryOperation(
          "refresh",
          input.repository,
          ["add", "--all", "--sparse", "--pathspec-from-file=-", "--pathspec-file-nul"],
          { stdin: stage.join("\0") + "\0" },
        )
      return { skipped }
    })

    const ignored = Effect.fn("Git.index.ignored")(function* (input: {
      repository: Repository
      paths: readonly RelativePath[]
    }) {
      if (!input.paths.length) return new Set<RelativePath>()
      const result = yield* proc
        .run(
          ChildProcess.make("git", repositoryArgs(input.repository, ["check-ignore", "--no-index", "--stdin", "-z"]), {
            cwd: input.repository.worktree,
            extendEnv: true,
          }),
          { stdin: input.paths.join("\0") + "\0" },
        )
        .pipe(
          Effect.mapError(
            (cause) =>
              new OperationError({
                operation: "list_files",
                directory: input.repository.worktree,
                message: cause.message,
                cause,
              }),
          ),
        )
      if (result.exitCode !== 0 && result.exitCode !== 1)
        return yield* new OperationError({
          operation: "list_files",
          directory: input.repository.worktree,
          message: result.stderr.toString("utf8").trim() || "Failed to check ignored paths",
        })
      return new Set(
        result.stdout
          .toString("utf8")
          .split("\0")
          .filter(Boolean)
          .map((file) => RelativePath.make(file)),
      )
    })

    const writeTree = Effect.fn("Git.tree.write")(function* (repository: Repository) {
      return TreeID.make((yield* repositoryOperation("write_tree", repository, ["write-tree"])).text.trim())
    })

    const captureTree = Effect.fn("Git.tree.capture")(
      (input: {
        repository: Repository
        scopes: readonly RelativePath[]
        ignores?: Repository
        maximumUntrackedFileBytes?: number
      }) =>
        locked(
          input.repository,
          Effect.gen(function* () {
            yield* Effect.forEach(input.scopes, (scope) => refresh({ ...input, scope }), { discard: true })
            return yield* writeTree(input.repository)
          }),
        ),
    )

    const treeFiles = Effect.fn("Git.tree.files")(function* (input: {
      repository: Repository
      from: TreeID
      to: TreeID
    }) {
      return (yield* repositoryOperation("list_files", input.repository, [
        "diff",
        "--name-only",
        "-z",
        input.from,
        input.to,
      ])).text
        .split("\0")
        .filter(Boolean)
        .map((file) => RelativePath.make(file))
    })

    const treeDiff = Effect.fn("Git.tree.diff")(function* (input: {
      repository: Repository
      from: TreeID
      to: TreeID
      context?: number
      paths?: readonly RelativePath[]
    }) {
      const paths = input.paths ?? (yield* treeFiles(input))
      return yield* Effect.forEach(paths, (file) =>
        Effect.gen(function* () {
          const statusText = (yield* repositoryOperation("diff", input.repository, [
            "diff",
            "--name-status",
            "--no-renames",
            input.from,
            input.to,
            "--",
            file,
          ])).text.trim()
          const status = statusText.startsWith("A") ? "added" : statusText.startsWith("D") ? "deleted" : "modified"
          const stats = (yield* repositoryOperation("diff", input.repository, [
            "diff",
            "--numstat",
            "--no-renames",
            input.from,
            input.to,
            "--",
            file,
          ])).text.split("\t")
          const binary = stats[0] === "-" || stats[1] === "-"
          const patch = binary
            ? ""
            : (yield* repositoryOperation("diff", input.repository, [
                "diff",
                `--unified=${input.context ?? 3}`,
                "--no-renames",
                input.from,
                input.to,
                "--",
                file,
              ])).text
          return {
            path: file,
            status,
            additions: binary ? 0 : Number(stats[0] ?? 0),
            deletions: binary ? 0 : Number(stats[1] ?? 0),
            patch,
          } satisfies File.Diff
        }),
      )
    })

    const entry = Effect.fnUntraced(function* (repository: Repository, tree: TreeID, file: RelativePath) {
      const text = (yield* repositoryOperation("restore", repository, [
        "ls-tree",
        "-z",
        tree,
        "--",
        file,
      ])).text.replace(/\0$/, "")
      if (!text) return
      const match = text.match(/^(\d+)\s+\w+\s+([0-9a-f]+)\t/)
      if (!match)
        return yield* new OperationError({
          operation: "restore",
          directory: repository.worktree,
          message: `Invalid tree entry for ${file}`,
        })
      return { mode: match[1], object: match[2] }
    })

    const preview = Effect.fn("Git.tree.preview")(
      (input: {
        repository: Repository
        current: TreeID
        files: ReadonlyMap<RelativePath, TreeID>
        context?: number
      }) =>
        locked(
          input.repository,
          Effect.gen(function* () {
            const index = path.join(input.repository.gitDirectory, `preview-${randomUUID()}.index`)
            const env = { GIT_INDEX_FILE: index }
            return yield* Effect.gen(function* () {
              yield* repositoryOperation("diff", input.repository, ["read-tree", input.current], { env })
              yield* Effect.forEach(
                input.files,
                ([file, tree]) =>
                  Effect.gen(function* () {
                    const source = yield* entry(input.repository, tree, file)
                    if (!source) {
                      yield* repositoryOperation(
                        "diff",
                        input.repository,
                        ["update-index", "--force-remove", "--", file],
                        { env },
                      )
                      return
                    }
                    yield* repositoryOperation(
                      "diff",
                      input.repository,
                      ["update-index", "--add", "--cacheinfo", source.mode, source.object, file],
                      { env },
                    )
                  }),
                { discard: true },
              )
              const target = TreeID.make(
                (yield* repositoryOperation("diff", input.repository, ["write-tree"], { env })).text.trim(),
              )
              return yield* treeDiff({
                repository: input.repository,
                from: input.current,
                to: target,
                context: input.context,
                paths: Array.from(input.files.keys()),
              })
            }).pipe(Effect.ensuring(fs.remove(index).pipe(Effect.catch(() => Effect.void))))
          }),
        ),
    )

    const restore = Effect.fn("Git.tree.restore")(
      (input: { repository: Repository; files: ReadonlyMap<RelativePath, TreeID> }) =>
        locked(
          input.repository,
          Effect.forEach(
            input.files,
            ([file, tree]) =>
              Effect.gen(function* () {
                if (yield* entry(input.repository, tree, file)) {
                  yield* repositoryOperation("restore", input.repository, ["checkout", tree, "--", file])
                  return
                }
                yield* fs.remove(path.join(input.repository.worktree, file), { recursive: true, force: true }).pipe(
                  Effect.mapError(
                    (cause) =>
                      new OperationError({
                        operation: "restore",
                        directory: input.repository.worktree,
                        message: `Failed to remove ${file}`,
                        cause,
                      }),
                  ),
                )
              }),
            { discard: true },
          ),
        ),
    )

    const checkoutTree = Effect.fn("Git.tree.checkout")((input: { repository: Repository; tree: TreeID }) =>
      locked(
        input.repository,
        Effect.gen(function* () {
          yield* repositoryOperation("restore", input.repository, ["read-tree", input.tree])
          yield* repositoryOperation("restore", input.repository, ["checkout-index", "--all", "--force"])
        }),
      ),
    )

    const capture = Effect.fn("Git.change.capture")(function* (input: { repository: Repository; path: AbsolutePath }) {
      const scope = path.relative(input.repository.worktree, input.path).replaceAll("\\", "/") || "."
      const tracked = yield* execute(
        input.repository.worktree,
        proc,
      )(["diff", "--binary", "HEAD", "--", scope]).pipe(
        Effect.mapError(
          (cause) => new PatchError({ operation: "capture", directory: input.path, message: cause.message, cause }),
        ),
      )
      if (tracked.exitCode !== 0) {
        return yield* new PatchError({
          operation: "capture",
          directory: input.path,
          message: tracked.stderr.trim() || tracked.text.trim() || "Failed to capture tracked changes",
        })
      }

      const untracked = yield* execute(
        input.repository.worktree,
        proc,
      )(["ls-files", "--others", "--exclude-standard", "-z", "--", scope]).pipe(
        Effect.mapError(
          (cause) => new PatchError({ operation: "capture", directory: input.path, message: cause.message, cause }),
        ),
      )
      if (untracked.exitCode !== 0) {
        return yield* new PatchError({
          operation: "capture",
          directory: input.path,
          message: untracked.stderr.trim() || untracked.text.trim() || "Failed to list untracked changes",
        })
      }

      const created = yield* Effect.forEach(untracked.text.split("\0").filter(Boolean), (file) =>
        execute(
          input.repository.worktree,
          proc,
        )(["diff", "--binary", "--no-index", "--", "/dev/null", file]).pipe(
          Effect.mapError(
            (cause) => new PatchError({ operation: "capture", directory: input.path, message: cause.message, cause }),
          ),
          Effect.flatMap((result) =>
            // git diff --no-index returns 1 when differences were found.
            result.exitCode === 0 || result.exitCode === 1
              ? Effect.succeed(result.text)
              : Effect.fail(
                  new PatchError({
                    operation: "capture",
                    directory: input.path,
                    message:
                      result.stderr.trim() || result.text.trim() || `Failed to capture untracked change: ${file}`,
                  }),
                ),
          ),
        ),
      )
      return ChangeSet.make([tracked.text, ...created].filter(Boolean).join("\n"))
    })

    const apply = Effect.fn("Git.change.apply")(function* (input: {
      repository: Repository
      path: AbsolutePath
      changes: ChangeSet
    }) {
      const result = yield* proc
        .run(
          ChildProcess.make("git", ["apply", "-"], {
            cwd: input.path,
            extendEnv: true,
            stdin: Stream.make(new TextEncoder().encode(input.changes)),
          }),
        )
        .pipe(
          Effect.mapError(
            (cause) => new PatchError({ operation: "apply", directory: input.path, message: cause.message, cause }),
          ),
        )
      if (result.exitCode === 0) return
      return yield* new PatchError({
        operation: "apply",
        directory: input.path,
        message:
          result.stderr.toString("utf8").trim() || result.stdout.toString("utf8").trim() || "Failed to apply changes",
      })
    })

    const discard = Effect.fn("Git.change.discard")(function* (input: {
      repository: Repository
      path: AbsolutePath
      index: "preserve" | "reset"
      untracked: "preserve" | "remove"
    }) {
      const scope = path.relative(input.repository.worktree, input.path).replaceAll("\\", "/") || "."
      const restore = yield* execute(
        input.repository.worktree,
        proc,
      )(input.index === "reset" ? ["checkout", "HEAD", "--", scope] : ["checkout", "--", scope]).pipe(
        Effect.mapError(
          (cause) => new PatchError({ operation: "reset", directory: input.path, message: cause.message, cause }),
        ),
      )
      if (restore.exitCode !== 0) {
        return yield* new PatchError({
          operation: "reset",
          directory: input.path,
          message: restore.stderr.trim() || restore.text.trim() || "Failed to restore tracked changes",
        })
      }
      if (input.untracked === "preserve") return
      const clean = yield* execute(
        input.repository.worktree,
        proc,
      )(["clean", "-fd", "--", scope]).pipe(
        Effect.mapError(
          (cause) => new PatchError({ operation: "reset", directory: input.path, message: cause.message, cause }),
        ),
      )
      if (clean.exitCode === 0) return
      return yield* new PatchError({
        operation: "reset",
        directory: input.path,
        message: clean.stderr.trim() || clean.text.trim() || "Failed to clean untracked changes",
      })
    })

    const worktreeRun = Effect.fnUntraced(function* (
      operation: "create" | "remove" | "list",
      repository: Repository,
      args: string[],
      worktreeDirectory?: AbsolutePath,
      cwd = repository.worktree,
    ) {
      const result = yield* proc
        .run(ChildProcess.make("git", args, { cwd, extendEnv: true, stdin: "ignore" }))
        .pipe(
          Effect.mapError(
            (cause) => new WorktreeError({ operation, directory: worktreeDirectory, message: cause.message, cause }),
          ),
        )
      if (result.exitCode === 0) return result.stdout.toString("utf8")
      const message = result.stderr.toString("utf8").trim() || result.stdout.toString("utf8").trim() || "Git failed"
      return yield* new WorktreeError({
        operation,
        directory: worktreeDirectory,
        message,
        forceRequired: operation === "remove" && /contains modified or untracked files|is dirty/i.test(message),
      })
    })

    const worktreeCreate = Effect.fn("Git.worktree.create")(function* (input: {
      repository: Repository
      directory: AbsolutePath
    }) {
      yield* worktreeRun(
        "create",
        input.repository,
        ["worktree", "add", "--detach", input.directory, "HEAD"],
        input.directory,
      )
      const repository = yield* discover(input.directory)
      if (repository) return repository
      return yield* new WorktreeError({
        operation: "create",
        directory: input.directory,
        message: "Created worktree could not be opened",
      })
    })

    const worktreeRemove = Effect.fn("Git.worktree.remove")(function* (input: {
      repository: Repository
      directory: AbsolutePath
      force: boolean
    }) {
      yield* worktreeRun(
        "remove",
        input.repository,
        ["worktree", "remove", ...(input.force ? ["--force"] : []), input.directory],
        input.directory,
        input.repository.commonDirectory,
      )
    })

    const worktreeList = Effect.fn("Git.worktree.list")(function* (repository: Repository) {
      return (yield* worktreeRun("list", repository, ["worktree", "list", "--porcelain"]))
        .split("\n")
        .filter((line) => line.startsWith("worktree "))
        .map(
          (line, index) =>
            new Worktree({
              directory: AbsolutePath.make(resolvePath(repository.worktree, line.slice("worktree ".length).trim())),
              kind: index === 0 ? "main" : "linked",
            }),
        )
    })

    return Service.of({
      repo: { discover, clone, create },
      remote: { get: remote },
      history: { head, branch, defaultRemoteBranch: remoteHead, rootCommits: roots },
      sync: { fetchRemotes: fetch, fetchBranch, checkoutRemoteBranch: checkout, resetHard: reset },
      change: { capture, apply, discard },
      worktree: { create: worktreeCreate, remove: worktreeRemove, list: worktreeList },
      index: { refresh, ignored },
      tree: {
        capture: captureTree,
        write: writeTree,
        files: treeFiles,
        diff: treeDiff,
        preview,
        restore,
        checkout: checkoutTree,
      },
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer: layer, deps: [FSUtil.node, AppProcess.node] })

interface Result {
  readonly exitCode: number
  readonly text: string
  readonly stderr: string
}

function run(cwd: string, proc: AppProcess.Interface) {
  return (args: string[]) =>
    execute(cwd, proc)(args).pipe(Effect.catch(() => Effect.succeed({ exitCode: 1, text: "", stderr: "" })))
}

function execute(cwd: string, proc: AppProcess.Interface) {
  return (args: string[]) =>
    proc
      .run(
        ChildProcess.make("git", args, {
          cwd,
          extendEnv: true,
          stdin: "ignore",
        }),
      )
      .pipe(
        Effect.map(
          (result) =>
            ({
              exitCode: result.exitCode,
              text: result.stdout.toString("utf8"),
              stderr: result.stderr.toString("utf8"),
            }) satisfies Result,
        ),
      )
}

function resolvePath(cwd: string, value: string) {
  const trimmed = value.replace(/[\r\n]+$/, "")
  if (!trimmed) return cwd
  const normalized = FSUtil.windowsPath(trimmed)
  if (path.isAbsolute(normalized)) return path.normalize(normalized)
  return path.resolve(cwd, normalized)
}
