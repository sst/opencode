import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect } from "effect"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Location } from "@opencode/core/location"
import { Ripgrep } from "@opencode/core/ripgrep"
import { RelativePath } from "@opencode/core/schema"
import { tmpdir, tmpdirScoped } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { tempLocationLayer } from "./fixture/location"

const it = testEffect(AppNodeBuilder.build(Ripgrep.node, [Location.node.replace(tempLocationLayer)]))

describe("Ripgrep", () => {
  for (const hidden of [undefined, false, true]) {
    for (const limit of hidden ? [10] : [1, 10]) {
      it.live(`glob honors hidden=${hidden} before limit=${limit}`, () =>
        Effect.gen(function* () {
          const tmp = yield* tmpdirScoped()
          yield* Effect.promise(() =>
            Promise.all(
              ["src/visible.ts", ".hidden.ts", "src/.hidden.ts", ".hidden/nested.ts", ".git/config.ts"].map((file) =>
                Bun.write(path.join(tmp.path, file), "needle\n"),
              ),
            ),
          )
          const ripgrep = yield* Ripgrep.Service
          const files = yield* ripgrep.glob({
            cwd: tmp.path,
            pattern: "**/*.ts",
            limit,
            ...(hidden === undefined ? {} : { hidden }),
          })

          expect(files.map((item) => item.path).sort()).toEqual(
            (hidden ? [".hidden.ts", ".hidden/nested.ts", "src/.hidden.ts", "src/visible.ts"] : ["src/visible.ts"]).map(
              (file) => RelativePath.make(file),
            ),
          )
        }),
      )
    }
  }

  it.live("globs files as an array", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => fs.mkdir(path.join(tmp.path, "src")))
          yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "src", "match.ts"), "needle\n"))

          const ripgrep = yield* Ripgrep.Service
          const result = yield* ripgrep.glob({ cwd: tmp.path, pattern: "**/*.ts", limit: 10 })
          expect(result.map((item) => item.path)).toEqual([RelativePath.make("src/match.ts")])
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("greps files with include filtering", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => fs.mkdir(path.join(tmp.path, "src")))
          yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "src", "match.ts"), "needle\n"))
          yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "src", "skip.txt"), "needle\n"))

          const ripgrep = yield* Ripgrep.Service
          const result = yield* ripgrep.grep({
            cwd: tmp.path,
            pattern: "needle",
            include: "*.ts",
            limit: 10,
          })
          expect(result).toHaveLength(1)
          expect(result[0]?.entry.path).toBe(RelativePath.make("src/match.ts"))
          expect(result[0]?.submatches[0]?.text).toBe("needle")
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("keeps ignored files out of catch-all find results", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => fs.mkdir(path.join(tmp.path, "node_modules", "pkg"), { recursive: true }))
          yield* Effect.promise(() => fs.mkdir(path.join(tmp.path, "src")))
          yield* Effect.promise(() => Bun.$`git init -q ${tmp.path}`)
          yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, ".gitignore"), "node_modules/\n"))
          yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "node_modules", "pkg", "index.js"), "ignored\n"))
          yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "src", "index.js"), "included\n"))

          const ripgrep = yield* Ripgrep.Service
          const files = yield* ripgrep.find({ cwd: tmp.path, pattern: "*", limit: 10 })
          expect(files.map((item) => item.path)).toContain(RelativePath.make("src/index.js"))
          expect(files.map((item) => item.path)).not.toContain(RelativePath.make("node_modules/pkg/index.js"))
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("never includes git metadata", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => fs.mkdir(path.join(tmp.path, ".opencode")))
          yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, ".opencode", "config"), "needle\n"))
          yield* Effect.promise(() => fs.mkdir(path.join(tmp.path, ".git")))
          yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, ".git", "config"), "needle\n"))
          const ripgrep = yield* Ripgrep.Service

          const files = yield* ripgrep.find({ cwd: tmp.path, pattern: "**/*", limit: 10 })
          expect(files.map((item) => item.path)).toContain(RelativePath.make(".opencode/config"))
          expect(files.map((item) => item.path)).not.toContain(RelativePath.make(".git/config"))

          const observed: string[] = []
          const limited = yield* ripgrep.find({
            cwd: tmp.path,
            pattern: "**/*",
            limit: 1,
            onEntry: (entry) => Effect.sync(() => observed.push(entry.path)),
          })
          expect(observed).toEqual(limited.map((item) => item.path))

          const matches = yield* ripgrep.grep({ cwd: tmp.path, pattern: "needle", include: "config", limit: 10 })
          expect(matches.map((item) => item.entry.path)).toContain(RelativePath.make(".opencode/config"))
          expect(matches.map((item) => item.entry.path)).not.toContain(RelativePath.make(".git/config"))
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("excludes protected directory trees from catch-all find results", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => fs.mkdir(path.join(tmp.path, "Pictures")))
          yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "Pictures", "private.jpg"), "private\n"))
          yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "visible.txt"), "visible\n"))

          const ripgrep = yield* Ripgrep.Service
          const files = yield* ripgrep.find({
            cwd: tmp.path,
            pattern: "*",
            limit: 10,
            exclude: ["Pictures/**"],
          })

          expect(files.map((item) => item.path)).toContain(RelativePath.make("visible.txt"))
          expect(files.map((item) => item.path)).not.toContain(RelativePath.make("Pictures/private.jpg"))
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("returns a bounded preview for matches on oversized lines", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            fs.writeFile(path.join(tmp.path, "generated.ts"), `Cloudflare${"x".repeat(70 * 1024)}\n`),
          )

          const ripgrep = yield* Ripgrep.Service
          const matches = yield* ripgrep.grep({
            cwd: tmp.path,
            pattern: "Cloudflare",
            limit: 10,
          })

          expect(matches).toHaveLength(1)
          expect(matches[0]?.entry.path).toBe(RelativePath.make("generated.ts"))
          expect(matches[0]?.text).toHaveLength(2_003)
          expect(matches[0]?.text.endsWith("...")).toBe(true)
          expect(matches[0]?.submatches).toEqual([{ text: "Cloudflare", start: 0, end: 10 }])
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )
})
