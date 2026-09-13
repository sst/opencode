import { expect, test } from "bun:test"
import { loadConfigFromFile, MainConfigFactory } from "electron-vite"
import { build } from "vite"
import pkg from "./package.json"

test.each(["build", "serve"] as const)("configures minification for %s", async (command) => {
  const result = await loadConfigFromFile(
    { command, mode: command === "build" ? "production" : "development" },
    `${import.meta.dirname}/electron.vite.config.ts`,
  )

  expect(result?.config.main?.build?.minify).toBe(command === "build")
  expect(result?.config.preload?.build?.minify).toBe(command === "build")
  expect(result?.config.renderer?.build?.minify).toBe(command === "build")
  expect(result?.config.renderer?.build?.sourcemap).toBe(true)
})

test("does not package external copies of bundled dependencies", () => {
  for (const name of ["effect", "@effect/platform-node", "@effect/platform-node-shared", "drizzle-orm"]) {
    expect(Object.keys(pkg.dependencies)).not.toContain(name)
    expect(Object.keys(pkg.optionalDependencies)).not.toContain(name)
  }
  expect(pkg.devDependencies.effect).toBe("catalog:")
  expect(pkg.devDependencies["@effect/platform-node"]).toBe("catalog:")
  expect(pkg.devDependencies["drizzle-orm"]).toBe("catalog:")
  expect(pkg.optionalDependencies["msgpackr-extract"]).toBe("3.0.4")
})

test("keeps PTY binaries without stale native packaging", () => {
  expect(Object.keys(pkg.scripts)).not.toContain("native:build")
  expect(
    Object.keys({ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.optionalDependencies }).filter((name) =>
      name.startsWith("@parcel/watcher"),
    ),
  ).toEqual([])
  expect(Object.keys(pkg.optionalDependencies).filter((name) => name.startsWith("@lydell/node-pty-"))).toEqual([
    "@lydell/node-pty-darwin-arm64",
    "@lydell/node-pty-darwin-x64",
    "@lydell/node-pty-linux-arm64",
    "@lydell/node-pty-linux-x64",
    "@lydell/node-pty-win32-arm64",
    "@lydell/node-pty-win32-x64",
  ])
})

test("bundles one Effect runtime and Drizzle while keeping native dependencies external", async () => {
  const result = await loadConfigFromFile(
    { command: "build", mode: "production" },
    `${import.meta.dirname}/electron.vite.config.ts`,
  )
  if (!result.config.main) throw new Error("Missing main-process build configuration")
  const config = await new MainConfigFactory(
    result.config.main,
    { configFile: false, mode: "production" },
    { root: import.meta.dirname },
  ).build()
  config.build = { ...config.build, write: false }
  config.logLevel = "silent"
  const output = await build(config)
  const chunks = (Array.isArray(output) ? output : [output]).flatMap((result) =>
    "output" in result ? result.output.filter((item) => item.type === "chunk") : [],
  )
  expect(chunks.length).toBeGreaterThan(0)
  // Resource resolution must not depend on which lazy entry owns DesktopPaths.
  expect(chunks.every((chunk) => !chunk.fileName.includes("/"))).toBe(true)
  const imports = chunks.flatMap((chunk) => [...chunk.imports, ...chunk.dynamicImports])
  const modules = chunks.flatMap((chunk) => Object.keys(chunk.modules))
  for (const name of ["effect", "@effect/platform-node", "@effect/platform-node-shared", "drizzle-orm"]) {
    expect(imports.filter((id) => id === name || id.startsWith(`${name}/`))).toEqual([])
    expect(modules.some((id) => id.includes(`/node_modules/${name}/`))).toBe(true)
  }
  const effect = modules.filter((id) => id.includes("/node_modules/effect/"))
  expect(new Set(effect.map((id) => id.split("/node_modules/effect/")[0])).size).toBe(1)
  expect(new Set(effect).size).toBe(effect.length)
  expect(imports).toContain("electron")
  expect(imports).toContain("node:sqlite")
  expect(chunks.some((chunk) => chunk.dynamicImports.includes("@zip.js/zip.js"))).toBe(true)
  expect(imports).toContain(`@lydell/node-pty-${process.platform}-${process.arch}`)
  expect(modules.some((id) => id.includes("/node_modules/msgpackr-extract/"))).toBe(false)
  expect(chunks.some((chunk) => chunk.code.includes("msgpackr-extract"))).toBe(true)
}, 30_000)
