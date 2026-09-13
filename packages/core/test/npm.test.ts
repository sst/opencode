import fs from "fs/promises"
import path from "path"
import { pathToFileURL } from "url"
import { describe, expect, test } from "bun:test"
import { Effect, Option } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Global } from "@opencode-ai/core/global"
import { Npm } from "@opencode-ai/core/npm"
import { tmpdir } from "./fixture/tmpdir"

const win = process.platform === "win32"

const writePackage = (dir: string, pkg: Record<string, unknown>) =>
  Bun.write(
    path.join(dir, "package.json"),
    JSON.stringify({
      version: "1.0.0",
      ...pkg,
    }),
  )

const npmLayer = (cache: string) =>
  AppNodeBuilder.build(Npm.node, [[Global.node, Global.layerWith({ cache, state: path.join(cache, "state") })]])

describe("Npm.sanitize", () => {
  test("keeps normal scoped package specs unchanged", () => {
    expect(Npm.sanitize("@opencode/acme")).toBe("@opencode/acme")
    expect(Npm.sanitize("@opencode/acme@1.0.0")).toBe("@opencode/acme@1.0.0")
    expect(Npm.sanitize("prettier")).toBe("prettier")
  })

  test("handles git https specs", () => {
    const spec = "acme@git+https://github.com/opencode/acme.git"
    const expected = win ? "acme@git+https_//github.com/opencode/acme.git" : spec
    expect(Npm.sanitize(spec)).toBe(expected)
  })
})

describe("Npm.add", () => {
  test("reifies when package cache directory exists without the package installed", async () => {
    await using tmp = await tmpdir()
    await fs.mkdir(path.join(tmp.path, "fixture-provider"))
    await writePackage(path.join(tmp.path, "fixture-provider"), {
      name: "fixture-provider",
      main: "index.js",
    })
    await Bun.write(path.join(tmp.path, "fixture-provider", "index.js"), "export const fixture = true\n")

    const spec = `fixture-provider@file:${path.join(tmp.path, "fixture-provider")}`
    await fs.mkdir(path.join(tmp.path, "cache", "packages", Npm.sanitize(spec)), { recursive: true })

    const entry = await Effect.gen(function* () {
      const npm = yield* Npm.Service
      return yield* npm.add(spec)
    }).pipe(Effect.scoped, Effect.provide(npmLayer(path.join(tmp.path, "cache"))), Effect.runPromise)

    expect(entry.entrypoint).toBeDefined()
  })
})

describe("Npm.install", () => {
  test("respects omit from project .npmrc", async () => {
    await using tmp = await tmpdir()

    await writePackage(tmp.path, {
      name: "fixture",
      dependencies: {
        "prod-pkg": "file:./prod-pkg",
      },
      devDependencies: {
        "dev-pkg": "file:./dev-pkg",
      },
    })
    await Bun.write(path.join(tmp.path, ".npmrc"), "omit=dev\n")
    await fs.mkdir(path.join(tmp.path, "prod-pkg"))
    await fs.mkdir(path.join(tmp.path, "dev-pkg"))
    await writePackage(path.join(tmp.path, "prod-pkg"), { name: "prod-pkg" })
    await writePackage(path.join(tmp.path, "dev-pkg"), { name: "dev-pkg" })

    await Npm.install(tmp.path)

    await expect(fs.stat(path.join(tmp.path, "node_modules", "prod-pkg"))).resolves.toBeDefined()
    await expect(fs.stat(path.join(tmp.path, "node_modules", "dev-pkg"))).rejects.toThrow()
  })
})

describe("Npm.resolveNodeEntryPoint", () => {
  const makeEntry = async (root: string, manifest: Record<string, unknown> | string | undefined, files: string[]) => {
    const dir = path.join(root, "pkg")
    await fs.mkdir(dir, { recursive: true })
    if (manifest !== undefined)
      await Bun.write(
        path.join(dir, "package.json"),
        typeof manifest === "string" ? manifest : JSON.stringify(manifest),
      )
    for (const file of files) await Bun.write(path.join(dir, file), "export {}\n")
    return dir
  }

  const fileURL = (dir: string, file: string) => pathToFileURL(path.join(dir, file)).href

  test("resolves conditional exports to the import target", async () => {
    await using tmp = await tmpdir()
    const dir = await makeEntry(
      tmp.path,
      {
        name: "esm-provider",
        exports: {
          "./package.json": "./package.json",
          ".": {
            types: "./dist/index.d.ts",
            import: "./dist/index.mjs",
            require: "./dist/index.js",
          },
        },
      },
      ["dist/index.mjs", "dist/index.js"],
    )
    expect(Npm.resolveNodeEntryPoint("esm-provider", dir)).toBe(fileURL(dir, "dist/index.mjs"))
  })

  test("resolved entrypoint is a file URL, never the package directory", async () => {
    await using tmp = await tmpdir()
    const dir = await makeEntry(tmp.path, { name: "p", exports: "./dist/index.mjs" }, ["dist/index.mjs"])
    const entrypoint = Npm.resolveNodeEntryPoint("p", dir)!
    expect(entrypoint.startsWith("file://")).toBe(true)
    expect(entrypoint).not.toBe(pathToFileURL(dir).href)
  })

  test("resolves array export targets to the first usable entry", async () => {
    await using tmp = await tmpdir()
    const dir = await makeEntry(
      tmp.path,
      { name: "p", exports: { ".": [{ import: "./dist/a.mjs" }, "./dist/b.js"] } },
      ["dist/a.mjs", "dist/b.js"],
    )
    expect(Npm.resolveNodeEntryPoint("p", dir)).toBe(fileURL(dir, "dist/a.mjs"))
  })

  test("falls back to require condition when no import target exists", async () => {
    await using tmp = await tmpdir()
    const dir = await makeEntry(tmp.path, { name: "p", exports: { ".": { require: "./dist/index.cjs" } } }, [
      "dist/index.cjs",
    ])
    expect(Npm.resolveNodeEntryPoint("p", dir)).toBe(fileURL(dir, "dist/index.cjs"))
  })

  test("falls back to module then main without exports", async () => {
    await using tmp = await tmpdir()
    const withModule = await makeEntry(tmp.path, { name: "p", module: "./dist/index.mjs", main: "./dist/index.js" }, [
      "dist/index.mjs",
      "dist/index.js",
    ])
    expect(Npm.resolveNodeEntryPoint("p", withModule)).toBe(fileURL(withModule, "dist/index.mjs"))
  })

  test("falls back to main and then index.js", async () => {
    await using tmp = await tmpdir()
    const withMain = await makeEntry(tmp.path, { name: "p", main: "./dist/index.js" }, ["dist/index.js"])
    expect(Npm.resolveNodeEntryPoint("p", withMain)).toBe(fileURL(withMain, "dist/index.js"))
  })

  test("falls back to index.js when the manifest names no entry", async () => {
    await using tmp = await tmpdir()
    const dir = await makeEntry(tmp.path, { name: "p" }, ["index.js"])
    expect(Npm.resolveNodeEntryPoint("p", dir)).toBe(fileURL(dir, "index.js"))
  })

  test("skips export targets pointing at missing files", async () => {
    await using tmp = await tmpdir()
    const dir = await makeEntry(
      tmp.path,
      { name: "p", exports: { ".": { import: "./dist/missing.mjs" } }, main: "./dist/real.js" },
      ["dist/real.js"],
    )
    expect(Npm.resolveNodeEntryPoint("p", dir)).toBe(fileURL(dir, "dist/real.js"))
  })

  test("rejects targets that escape the package directory", async () => {
    await using tmp = await tmpdir()
    const dir = await makeEntry(tmp.path, { name: "p", exports: "../outside.js" }, [])
    await Bun.write(path.join(tmp.path, "outside.js"), "export {}\n")
    expect(Npm.resolveNodeEntryPoint("p", dir)).toBeUndefined()
  })

  test("returns undefined for an empty directory", async () => {
    await using tmp = await tmpdir()
    const dir = await makeEntry(tmp.path, undefined, [])
    expect(Npm.resolveNodeEntryPoint("does-not-exist-anywhere", dir)).toBeUndefined()
  })

  test("returns undefined for a malformed manifest with no entry files", async () => {
    await using tmp = await tmpdir()
    const dir = await makeEntry(tmp.path, "{ not json", [])
    expect(Npm.resolveNodeEntryPoint("does-not-exist-anywhere", dir)).toBeUndefined()
  })
})
