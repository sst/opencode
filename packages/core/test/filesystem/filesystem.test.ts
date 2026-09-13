import { describe, test, expect } from "bun:test"
import { Effect, FileSystem } from "effect"
import { LayerNodePlatform } from "@opencode-ai/core/effect/app-node-platform"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { testEffect } from "../lib/effect"
import nodeFs from "fs/promises"
import path from "path"

const live = LayerNode.compile(LayerNode.group([FSUtil.node, LayerNodePlatform.filesystem]))
const { effect: it } = testEffect(live)

describe("FSUtil", () => {
  describe("isDir", () => {
    it(
      "returns true for directories",
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const filesys = yield* FileSystem.FileSystem
        const tmp = yield* filesys.makeTempDirectoryScoped()
        expect(yield* fs.isDir(tmp)).toBe(true)
      }),
    )

    it(
      "returns false for files",
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const filesys = yield* FileSystem.FileSystem
        const tmp = yield* filesys.makeTempDirectoryScoped()
        const file = path.join(tmp, "test.txt")
        yield* filesys.writeFileString(file, "hello")
        expect(yield* fs.isDir(file)).toBe(false)
      }),
    )

    it(
      "returns false for non-existent paths",
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        expect(yield* fs.isDir("/tmp/nonexistent-" + Math.random())).toBe(false)
      }),
    )
  })

  describe("isFile", () => {
    it(
      "returns true for files",
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const filesys = yield* FileSystem.FileSystem
        const tmp = yield* filesys.makeTempDirectoryScoped()
        const file = path.join(tmp, "test.txt")
        yield* filesys.writeFileString(file, "hello")
        expect(yield* fs.isFile(file)).toBe(true)
      }),
    )

    it(
      "returns false for directories",
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const filesys = yield* FileSystem.FileSystem
        const tmp = yield* filesys.makeTempDirectoryScoped()
        expect(yield* fs.isFile(tmp)).toBe(false)
      }),
    )
  })

  describe("readFileStringSafe", () => {
    it(
      "returns file contents when file exists",
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const filesys = yield* FileSystem.FileSystem
        const tmp = yield* filesys.makeTempDirectoryScoped()
        const file = path.join(tmp, "exists.txt")
        yield* filesys.writeFileString(file, "hello")

        const result = yield* fs.readFileStringSafe(file)
        expect(result).toBe("hello")
      }),
    )

    it(
      "returns undefined for missing file (NotFound)",
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const filesys = yield* FileSystem.FileSystem
        const tmp = yield* filesys.makeTempDirectoryScoped()

        const result = yield* fs.readFileStringSafe(path.join(tmp, "does-not-exist.txt"))
        expect(result).toBeUndefined()
      }),
    )
  })

  describe("readJson / writeJson", () => {
    it(
      "writes JSON atomically with the requested mode and cleans up its temporary file",
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const filesys = yield* FileSystem.FileSystem
        const tmp = yield* filesys.makeTempDirectoryScoped()
        const file = path.join(tmp, "data.json")

        yield* fs.writeJsonAtomic(file, { atomic: true }, 0o600)

        const info = yield* Effect.promise(() => nodeFs.stat(file))
        const entries = yield* Effect.promise(() => nodeFs.readdir(tmp))
        expect(info.mode & 0o777).toBe(0o600)
        expect(entries.filter((entry) => /^data\.json\.\d+\..+\.tmp$/.test(entry))).toEqual([])
      }),
    )

    it(
      "round-trips JSON data",
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const filesys = yield* FileSystem.FileSystem
        const tmp = yield* filesys.makeTempDirectoryScoped()
        const file = path.join(tmp, "data.json")
        const data = { name: "test", count: 42, nested: { ok: true } }

        yield* fs.writeJson(file, data)
        const result = yield* fs.readJson(file)

        expect(result).toEqual(data)
      }),
    )

    it(
      "fails invalid JSON through the error channel",
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const filesys = yield* FileSystem.FileSystem
        const tmp = yield* filesys.makeTempDirectoryScoped()
        const file = path.join(tmp, "broken.json")
        yield* filesys.writeFileString(file, "{")

        const result = yield* fs.readJson(file).pipe(Effect.catch((error) => Effect.succeed(error)))

        expect(result).toHaveProperty("_tag", "FileSystemError")
      }),
    )
  })

  describe("ensureDir", () => {
    it(
      "creates nested directories",
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const filesys = yield* FileSystem.FileSystem
        const tmp = yield* filesys.makeTempDirectoryScoped()
        const nested = path.join(tmp, "a", "b", "c")

        yield* fs.ensureDir(nested)

        const info = yield* filesys.stat(nested)
        expect(info.type).toBe("Directory")
      }),
    )

    it(
      "is idempotent",
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const filesys = yield* FileSystem.FileSystem
        const tmp = yield* filesys.makeTempDirectoryScoped()
        const dir = path.join(tmp, "existing")
        yield* filesys.makeDirectory(dir)

        yield* fs.ensureDir(dir)

        const info = yield* filesys.stat(dir)
        expect(info.type).toBe("Directory")
      }),
    )
  })

  describe("writeWithDirs", () => {
    it(
      "creates parent directories if missing",
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const filesys = yield* FileSystem.FileSystem
        const tmp = yield* filesys.makeTempDirectoryScoped()
        const file = path.join(tmp, "deep", "nested", "file.txt")

        yield* fs.writeWithDirs(file, "hello")

        expect(yield* filesys.readFileString(file)).toBe("hello")
      }),
    )

    it(
      "writes directly when parent exists",
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const filesys = yield* FileSystem.FileSystem
        const tmp = yield* filesys.makeTempDirectoryScoped()
        const file = path.join(tmp, "direct.txt")

        yield* fs.writeWithDirs(file, "world")

        expect(yield* filesys.readFileString(file)).toBe("world")
      }),
    )

    it(
      "writes Uint8Array content",
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const filesys = yield* FileSystem.FileSystem
        const tmp = yield* filesys.makeTempDirectoryScoped()
        const file = path.join(tmp, "binary.bin")
        const content = new Uint8Array([0x00, 0x01, 0x02, 0x03])

        yield* fs.writeWithDirs(file, content)

        const result = yield* filesys.readFile(file)
        expect(new Uint8Array(result)).toEqual(content)
      }),
    )
  })

  describe("findUp", () => {
    it(
      "finds target in start directory",
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const filesys = yield* FileSystem.FileSystem
        const tmp = yield* filesys.makeTempDirectoryScoped()
        yield* filesys.writeFileString(path.join(tmp, "target.txt"), "found")

        const result = yield* fs.findUp("target.txt", tmp)
        expect(result).toEqual([path.join(tmp, "target.txt")])
      }),
    )

    it(
      "finds target in parent directories",
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const filesys = yield* FileSystem.FileSystem
        const tmp = yield* filesys.makeTempDirectoryScoped()
        yield* filesys.writeFileString(path.join(tmp, "marker"), "root")
        const child = path.join(tmp, "a", "b")
        yield* filesys.makeDirectory(child, { recursive: true })

        const result = yield* fs.findUp("marker", child, tmp)
        expect(result).toEqual([path.join(tmp, "marker")])
      }),
    )

    it(
      "returns empty array when not found",
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const filesys = yield* FileSystem.FileSystem
        const tmp = yield* filesys.makeTempDirectoryScoped()
        const result = yield* fs.findUp("nonexistent", tmp, tmp)
        expect(result).toEqual([])
      }),
    )
  })

  describe("up", () => {
    it(
      "finds multiple targets walking up",
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const filesys = yield* FileSystem.FileSystem
        const tmp = yield* filesys.makeTempDirectoryScoped()
        yield* filesys.writeFileString(path.join(tmp, "a.txt"), "a")
        yield* filesys.writeFileString(path.join(tmp, "b.txt"), "b")
        const child = path.join(tmp, "sub")
        yield* filesys.makeDirectory(child)
        yield* filesys.writeFileString(path.join(child, "a.txt"), "a-child")

        const result = yield* fs.up({ targets: ["a.txt", "b.txt"], start: child, stop: tmp })

        expect(result).toContain(path.join(child, "a.txt"))
        expect(result).toContain(path.join(tmp, "a.txt"))
        expect(result).toContain(path.join(tmp, "b.txt"))
      }),
    )
  })

  describe("glob", () => {
    it(
      "finds files matching pattern",
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const filesys = yield* FileSystem.FileSystem
        const tmp = yield* filesys.makeTempDirectoryScoped()
        yield* filesys.writeFileString(path.join(tmp, "a.ts"), "a")
        yield* filesys.writeFileString(path.join(tmp, "b.ts"), "b")
        yield* filesys.writeFileString(path.join(tmp, "c.json"), "c")

        const result = yield* fs.glob("*.ts", { cwd: tmp })
        expect(result.sort()).toEqual(["a.ts", "b.ts"])
      }),
    )

    it(
      "supports absolute paths",
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const filesys = yield* FileSystem.FileSystem
        const tmp = yield* filesys.makeTempDirectoryScoped()
        yield* filesys.writeFileString(path.join(tmp, "file.txt"), "hello")

        const result = yield* fs.glob("*.txt", { cwd: tmp, absolute: true })
        expect(result).toEqual([path.join(tmp, "file.txt")])
      }),
    )
  })

  describe("globMatch", () => {
    it(
      "matches patterns",
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        expect(fs.globMatch("*.ts", "foo.ts")).toBe(true)
        expect(fs.globMatch("*.ts", "foo.json")).toBe(false)
        expect(fs.globMatch("src/**", "src/a/b.ts")).toBe(true)
      }),
    )
  })

  describe("globUp", () => {
    it(
      "finds files walking up directories",
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const filesys = yield* FileSystem.FileSystem
        const tmp = yield* filesys.makeTempDirectoryScoped()
        yield* filesys.writeFileString(path.join(tmp, "root.md"), "root")
        const child = path.join(tmp, "a", "b")
        yield* filesys.makeDirectory(child, { recursive: true })
        yield* filesys.writeFileString(path.join(child, "leaf.md"), "leaf")

        const result = yield* fs.globUp("*.md", child, tmp)
        expect(result).toContain(path.join(child, "leaf.md"))
        expect(result).toContain(path.join(tmp, "root.md"))
      }),
    )
  })

  describe("built-in passthrough", () => {
    it(
      "exists works",
      Effect.gen(function* () {
        yield* FSUtil.Service
        const filesys = yield* FileSystem.FileSystem
        const tmp = yield* filesys.makeTempDirectoryScoped()
        const file = path.join(tmp, "exists.txt")
        yield* filesys.writeFileString(file, "yes")

        expect(yield* filesys.exists(file)).toBe(true)
        expect(yield* filesys.exists(file + ".nope")).toBe(false)
      }),
    )

    it(
      "remove works",
      Effect.gen(function* () {
        yield* FSUtil.Service
        const filesys = yield* FileSystem.FileSystem
        const tmp = yield* filesys.makeTempDirectoryScoped()
        const file = path.join(tmp, "delete-me.txt")
        yield* filesys.writeFileString(file, "bye")

        yield* filesys.remove(file)

        expect(yield* filesys.exists(file)).toBe(false)
      }),
    )
  })

  describe("pure helpers", () => {
    test("mimeType returns correct types", () => {
      expect(FSUtil.mimeType("file.json")).toBe("application/json")
      expect(FSUtil.mimeType("image.png")).toBe("image/png")
      expect(FSUtil.mimeType("unknown.qzx")).toBe("application/octet-stream")
    })

    test("contains checks path containment", () => {
      expect(FSUtil.contains("/a/b", "/a/b/c")).toBe(true)
      expect(FSUtil.contains("/a/b", "/a/b")).toBe(true)
      expect(FSUtil.contains("/a/b", "/a/c")).toBe(false)
      expect(FSUtil.contains("/a/b", "/a/bad")).toBe(false)
      if (process.platform === "win32") expect(FSUtil.contains("C:\\a", "D:\\b")).toBe(false)
    })

    test("overlaps detects overlapping paths", () => {
      expect(FSUtil.overlaps("/a/b", "/a/b/c")).toBe(true)
      expect(FSUtil.overlaps("/a/b/c", "/a/b")).toBe(true)
      expect(FSUtil.overlaps("/a", "/b")).toBe(false)
      expect(FSUtil.overlaps("/a/b", "/a/bad")).toBe(false)
      if (process.platform === "win32") expect(FSUtil.overlaps("C:\\a", "D:\\b")).toBe(false)
    })
  })
})
