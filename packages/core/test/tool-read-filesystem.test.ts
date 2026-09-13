import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Environment } from "@opencode/core/environment/index"
import { AbsolutePath } from "@opencode/core/schema"
import { ReadTool } from "@opencode/core/tool/plugin/read"
import { ReadToolFileSystem } from "@opencode/core/tool/read-filesystem"
import { CrossSpawnSpawner } from "@opencode/util/cross-spawn-spawner"
import { LayerNodePlatform } from "@opencode/util/effect/app-node-platform"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Effect, FileSystem } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process"
import { testEffect } from "./lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([CrossSpawnSpawner.node, LayerNodePlatform.filesystem])))
const fixture = Effect.gen(function* () {
  const files = yield* FileSystem.FileSystem
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const directory = yield* files.makeTempDirectoryScoped()
  return { environment: Environment.makeFiles(Environment.makeLocalDriver(spawner)), files, directory }
})
const absolute = (value: string) => AbsolutePath.make(value)

describe("ReadTool text serialization", () => {
  const cases = [
    {
      name: "preserves a selected trailing blank line before continuation",
      content: "alpha\n\nomega\n",
      page: { offset: 1, limit: 2 },
      output: { type: "text-page", content: "alpha\n", offset: 1, truncated: true, next: 3 },
      model: "Read file lines.txt, lines 1-2\n1: alpha\n2: \n[Output truncated. Continue reading with offset: 3]",
    },
    {
      name: "preserves multiple selected trailing blank lines at a noninitial offset",
      content: "before\nalpha\n\n\nomega\n",
      page: { offset: 2, limit: 3 },
      output: { type: "text-page", content: "alpha\n\n", offset: 2, truncated: true, next: 5 },
      model: "Read file lines.txt, lines 2-4\n2: alpha\n3: \n4: \n[Output truncated. Continue reading with offset: 5]",
    },
    {
      name: "preserves a selected trailing blank line at EOF",
      content: "alpha\n\n",
      page: { limit: 2 },
      output: { type: "text-page", content: "alpha\n", offset: 1, truncated: false },
      model: "Read file lines.txt, lines 1-2\n1: alpha\n2: ",
    },
    {
      name: "preserves internal blank lines in a page",
      content: "alpha\n\nomega\n",
      page: { limit: 3 },
      output: { type: "text-page", content: "alpha\n\nomega", offset: 1, truncated: false },
      model: "Read file lines.txt, lines 1-3\n1: alpha\n2: \n3: omega",
    },
    {
      name: "preserves continuation for a nonblank page",
      content: "alpha\n\nomega\n",
      page: { limit: 1 },
      output: { type: "text-page", content: "alpha", offset: 1, truncated: true, next: 2 },
      model: "Read file lines.txt, lines 1-1\n1: alpha\n[Output truncated. Continue reading with offset: 2]",
    },
    {
      name: "strips only the terminal file newline in a whole-file read",
      content: "alpha\n\n",
      page: {},
      output: { type: "file", content: "alpha\n\n", encoding: "utf8" },
      model: "Read file lines.txt, lines 1-2\n1: alpha\n2: ",
    },
    {
      name: "does not add a line for a whole-file terminal newline",
      content: "alpha\n",
      page: {},
      output: { type: "file", content: "alpha\n", encoding: "utf8" },
      model: "Read file lines.txt, lines 1-1\n1: alpha",
    },
    {
      name: "preserves a whole-file read without a terminal newline",
      content: "alpha",
      page: {},
      output: { type: "file", content: "alpha", encoding: "utf8" },
      model: "Read file lines.txt, lines 1-1\n1: alpha",
    },
    {
      name: "preserves empty whole-file output",
      content: "",
      page: {},
      output: { type: "file", content: "", encoding: "utf8" },
      model: "Read file lines.txt, 0 lines",
    },
    {
      name: "preserves empty-file page output",
      content: "",
      page: { limit: 2 },
      output: { type: "text-page", content: "", offset: 1, truncated: false },
      model: "Read file lines.txt, 0 lines",
    },
  ]

  cases.forEach((input) => {
    it.live(input.name, () =>
      Effect.gen(function* () {
        const current = yield* fixture
        const file = absolute(path.join(current.directory, "lines.txt"))
        yield* current.files.writeFileString(file, input.content)

        const result = yield* ReadToolFileSystem.read(current.environment, file, "lines.txt", input.page)

        expect(result).toMatchObject(input.output)
        expect(ReadTool.toModelContent("lines.txt", undefined, result)).toBe(input.model)
      }),
    )
  })
})

describe("ReadToolFileSystem", () => {
  it.effect("preserves the environment not-found error", () =>
    Effect.gen(function* () {
      const { environment, directory } = yield* fixture
      const file = path.join(directory, "missing.txt")

      const error = yield* ReadToolFileSystem.read(environment, absolute(file), "missing.txt").pipe(Effect.flip)

      expect(error).toBeInstanceOf(Environment.NotFound)
    }),
  )

  it.effect("returns a listing when read reports a directory", () =>
    Effect.gen(function* () {
      const { environment, files, directory } = yield* fixture
      yield* files.makeDirectory(path.join(directory, "folder"))
      yield* files.writeFileString(path.join(directory, "file.txt"), "hello")

      const result = yield* ReadToolFileSystem.read(environment, absolute(directory), "folder")

      expect(result).toMatchObject({
        type: "list-page",
        entries: [
          { path: `folder${path.sep}`, type: "directory" },
          { path: "file.txt", type: "file" },
        ],
      })
    }),
  )

  it.effect("reads malformed UTF-8 lossily and still rejects null-byte binary content", () =>
    Effect.gen(function* () {
      const { environment, files, directory } = yield* fixture
      const binary = path.join(directory, "archive.dat")
      const malformed = path.join(directory, "malformed.txt")
      yield* files.writeFile(binary, Uint8Array.of(0, 1, 2, 3))
      yield* files.writeFile(malformed, Uint8Array.of(0x68, 0x69, 0x80))

      const binaryError = yield* ReadToolFileSystem.read(environment, absolute(binary), "archive.dat").pipe(Effect.flip)
      const malformedResult = yield* ReadToolFileSystem.read(environment, absolute(malformed), "malformed.txt")

      expect(binaryError).toBeInstanceOf(ReadToolFileSystem.BinaryFileError)
      expect(binaryError.message).toBe("Cannot read binary file: archive.dat")
      expect(malformedResult).toMatchObject({ type: "file", content: "hi\uFFFD", encoding: "utf8" })
    }),
  )

  it.effect("reads text despite a binary-associated extension", () =>
    Effect.gen(function* () {
      const { environment, files, directory } = yield* fixture
      const file = path.join(directory, "notes.docx")
      yield* files.writeFileString(file, "plain text")

      const result = yield* ReadToolFileSystem.read(environment, absolute(file), "notes.docx")

      expect(result).toMatchObject({ type: "file", content: "plain text", encoding: "utf8" })
    }),
  )

  it.effect("lists unresolved symlinks, including broken and escaping links", () =>
    Effect.gen(function* () {
      if (process.platform === "win32") return
      const { environment, files, directory } = yield* fixture
      const outside = yield* files.makeTempDirectoryScoped()
      yield* files.makeDirectory(path.join(directory, "folder"))
      yield* files.writeFileString(path.join(directory, "file.txt"), "hello")
      yield* Effect.promise(() => fs.symlink(path.join(outside, "target.txt"), path.join(directory, "escape")))
      yield* Effect.promise(() => fs.symlink(path.join(directory, "missing.txt"), path.join(directory, "broken")))

      const result = yield* ReadToolFileSystem.read(environment, absolute(directory), "folder")

      expect(result.type).toBe("list-page")
      if (result.type !== "list-page") return
      expect(result.entries.map((entry) => ({ ...entry, path: String(entry.path) }))).toEqual([
        { path: `folder${path.sep}`, type: "directory" },
        { path: "broken", type: "symlink" },
        { path: "escape", type: "symlink" },
        { path: "file.txt", type: "file" },
      ])
    }),
  )

  it.effect("reads a symlinked directory as a listing", () =>
    Effect.gen(function* () {
      if (process.platform === "win32") return
      const { environment, files, directory } = yield* fixture
      const target = path.join(directory, "target")
      const link = path.join(directory, "link")
      yield* files.makeDirectory(target)
      yield* files.writeFileString(path.join(target, "file.txt"), "hello")
      yield* Effect.promise(() => fs.symlink(target, link))

      const result = yield* ReadToolFileSystem.read(environment, absolute(link), "link")

      expect(result).toMatchObject({
        type: "list-page",
        entries: [{ path: "file.txt", type: "file" }],
      })
    }),
  )

  it.effect("reports out-of-range pagination as a typed error", () =>
    Effect.gen(function* () {
      const { environment, files, directory } = yield* fixture
      const file = path.join(directory, "short.txt")
      yield* files.writeFileString(file, "one\n")

      const error = yield* ReadToolFileSystem.read(environment, absolute(file), "short.txt", { offset: 2 }).pipe(
        Effect.flip,
      )

      expect(error).toBeInstanceOf(ReadToolFileSystem.OffsetOutOfRangeError)
      expect(error.message).toBe("Offset 2 is out of range")
    }),
  )

  it.effect("pages text with one-based offsets", () =>
    Effect.gen(function* () {
      const { environment, files, directory } = yield* fixture
      const file = path.join(directory, "lines.txt")
      yield* files.writeFileString(file, "one\r\ntwo\nthree")

      const result = yield* ReadToolFileSystem.read(environment, absolute(file), "lines.txt", {
        offset: 2,
        limit: 1,
      })

      expect(result).toMatchObject({ type: "text-page", content: "two", offset: 2, truncated: true, next: 3 })
    }),
  )

  it.effect("truncates long lines", () =>
    Effect.gen(function* () {
      const { environment, files, directory } = yield* fixture
      const file = path.join(directory, "long.txt")
      yield* files.writeFileString(file, "a".repeat(2_001))

      const result = yield* ReadToolFileSystem.read(environment, absolute(file), "long.txt", { limit: 1 })

      expect(result).toMatchObject({
        type: "text-page",
        content: `${"a".repeat(2_000)}... (line truncated to 2000 chars)`,
        truncated: false,
      })
    }),
  )

  it.effect("enforces line and byte budgets with continuation offsets", () =>
    Effect.gen(function* () {
      const { environment, files, directory } = yield* fixture
      const linesFile = path.join(directory, "many-lines.txt")
      const bytesFile = path.join(directory, "many-bytes.txt")
      yield* files.writeFileString(linesFile, Array.from({ length: 2_001 }, (_, index) => String(index)).join("\n"))
      yield* files.writeFileString(bytesFile, Array.from({ length: 200 }, () => "a".repeat(2_000)).join("\n"))
      const ranges: Array<{ readonly offset: number; readonly length: number } | undefined> = []
      const tracked = {
        ...environment,
        read: (path: string, range?: { readonly offset: number; readonly length: number }) =>
          Effect.sync(() => ranges.push(range)).pipe(Effect.andThen(environment.read(path, range))),
      }

      const lines = yield* ReadToolFileSystem.read(environment, absolute(linesFile), "many-lines.txt", { limit: 2_000 })
      const bytes = yield* ReadToolFileSystem.read(tracked, absolute(bytesFile), "many-bytes.txt", {})

      expect(lines).toMatchObject({ type: "text-page", truncated: true, next: 2_001 })
      expect(lines.type === "text-page" ? lines.content.split("\n") : []).toHaveLength(2_000)
      expect(bytes).toMatchObject({ type: "text-page", truncated: true, next: 26 })
      expect(bytes.type === "text-page" ? Buffer.byteLength(bytes.content) : Infinity).toBeLessThanOrEqual(
        ReadToolFileSystem.MAX_READ_BYTES,
      )
      expect(ranges).toEqual([{ offset: 0, length: 256 * 1024 }])
    }),
  )

  it.effect("sorts and pages directory entries", () =>
    Effect.gen(function* () {
      const { environment, files, directory } = yield* fixture
      yield* files.makeDirectory(path.join(directory, "z"))
      yield* files.makeDirectory(path.join(directory, "a"))
      yield* files.writeFileString(path.join(directory, "b.txt"), "")

      const result = yield* ReadToolFileSystem.read(environment, absolute(directory), "folder", {
        offset: 2,
        limit: 1,
      })

      expect(result).toMatchObject({
        type: "list-page",
        entries: [{ path: `z${path.sep}`, type: "directory" }],
        truncated: true,
        next: 3,
      })
    }),
  )

  it.effect("stops checking for null bytes after the requested page", () =>
    Effect.gen(function* () {
      const { environment, files, directory } = yield* fixture
      const file = path.join(directory, "nul.txt")
      yield* files.writeFile(file, Uint8Array.from([...new TextEncoder().encode("one\n"), 0]))

      const result = yield* ReadToolFileSystem.read(environment, absolute(file), "nul.txt", { limit: 1 })

      expect(result).toMatchObject({ type: "text-page", content: "one", truncated: true, next: 2 })
    }),
  )

  it.effect("checks skipped lines for null bytes", () =>
    Effect.gen(function* () {
      const { environment, files, directory } = yield* fixture
      const file = path.join(directory, "nul-prefix.txt")
      yield* files.writeFile(file, Uint8Array.from([...new TextEncoder().encode("one"), 0, 10, 116, 119, 111, 10]))

      const error = yield* ReadToolFileSystem.read(environment, absolute(file), "nul-prefix.txt", {
        offset: 2,
        limit: 1,
      }).pipe(Effect.flip)

      expect(error).toBeInstanceOf(ReadToolFileSystem.BinaryFileError)
    }),
  )

  it.effect("reads page two after fetching more than the first 256KB range", () =>
    Effect.gen(function* () {
      const { environment, files, directory } = yield* fixture
      const file = path.join(directory, "large.txt")
      yield* files.writeFileString(file, `${"a".repeat(300 * 1024)}\nsecond\n`)

      const result = yield* ReadToolFileSystem.read(environment, absolute(file), "large.txt", {
        offset: 2,
        limit: 1,
      })

      expect(result).toMatchObject({ type: "text-page", content: "second", offset: 2, truncated: false })
    }),
  )

  it.effect("reads after a newline at the first chunk boundary", () =>
    Effect.gen(function* () {
      const { environment, files, directory } = yield* fixture
      const file = path.join(directory, "boundary.txt")
      yield* files.writeFileString(file, `${"a".repeat(256 * 1024 - 1)}\nsecond\n`)

      const result = yield* ReadToolFileSystem.read(environment, absolute(file), "boundary.txt", {
        offset: 2,
        limit: 1,
      })

      expect(result).toMatchObject({ type: "text-page", content: "second", offset: 2, truncated: false })
    }),
  )

  it.effect("preserves the media ingestion limit message", () =>
    Effect.gen(function* () {
      const { environment, files, directory } = yield* fixture
      const file = path.join(directory, "oversized.png")
      yield* files.writeFile(file, Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))
      yield* files.truncate(file, ReadToolFileSystem.MAX_MEDIA_INGEST_BYTES + 1)

      const error = yield* ReadToolFileSystem.read(environment, absolute(file), "oversized.png").pipe(Effect.flip)

      expect(error).toBeInstanceOf(ReadToolFileSystem.MediaIngestLimitError)
      expect(error.message).toBe(
        `Media exceeds ${ReadToolFileSystem.MAX_MEDIA_INGEST_BYTES} byte ingestion limit: oversized.png`,
      )
    }),
  )

  it.effect("reads PDFs as bounded media", () =>
    Effect.gen(function* () {
      const { environment, files, directory } = yield* fixture
      const file = path.join(directory, "document.pdf")
      yield* files.writeFileString(file, "%PDF-1.7\ncontent")

      const result = yield* ReadToolFileSystem.read(environment, absolute(file), "document.pdf")

      expect(result).toMatchObject({
        type: "file",
        content: Buffer.from("%PDF-1.7\ncontent").toString("base64"),
        encoding: "base64",
        mime: "application/pdf",
      })
    }),
  )
})
