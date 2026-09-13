import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Failed, NotFound, WrongKind, type Files } from "@opencode/core/environment/index"

export interface EnvironmentHarness {
  readonly files: Files
  readonly root: string
  readonly symlink?: (target: string, path: string) => Effect.Effect<void, Failed>
  readonly dispose?: Effect.Effect<void>
}

export const environmentConformance = <E>(
  name: string,
  makeHarness: () => Effect.Effect<EnvironmentHarness, E>,
  skip = false,
) => {
  const check = <A, E2>(title: string, body: (harness: EnvironmentHarness) => Effect.Effect<A, E2>) =>
    test(title, () =>
      Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const harness = yield* Effect.acquireRelease(makeHarness(), (harness) =>
              Effect.gen(function* () {
                yield* Effect.ignore(harness.files.remove(harness.root))
                if (harness.dispose) yield* harness.dispose
              }),
            )
            yield* harness.files.mkdir(harness.root)
            return yield* body(harness)
          }),
        ),
      ),
    )

  const bytes = (value: string) => new TextEncoder().encode(value)
  const text = (value: Uint8Array) => new TextDecoder().decode(value)
  const suite = skip ? describe.skip : describe

  suite(name, () => {
    check("writes, stats, and reads a file with its info", (harness) =>
      Effect.gen(function* () {
        const target = `${harness.root}/hello.txt`
        yield* harness.files.write(target, bytes("hello"))
        const result = yield* harness.files.read(target)
        expect(text(result.bytes)).toBe("hello")
        expect(result.info.type).toBe("file")
        expect(result.info.size).toBe(5)
        expect(yield* harness.files.stat(target)).toEqual(result.info)
      }),
    )

    check("observes filesystem state when an operation executes", (harness) =>
      Effect.gen(function* () {
        const target = `${harness.root}/deferred.txt`
        const source = `${harness.root}/source.txt`
        const destination = `${harness.root}/destination.txt`
        const read = harness.files.read(target)
        const stat = harness.files.stat(target)
        const list = harness.files.list(harness.root)
        const move = harness.files.move(source, destination)

        yield* harness.files.write(target, bytes("first"))
        yield* harness.files.write(source, bytes("moved"))
        expect(text((yield* read).bytes)).toBe("first")
        expect((yield* stat).size).toBe(5)
        expect(yield* list).toContainEqual({ name: "deferred.txt", type: "file" })
        yield* move
        expect(text((yield* harness.files.read(destination)).bytes)).toBe("moved")

        yield* harness.files.write(target, bytes("second"))
        expect(text((yield* read).bytes)).toBe("second")
      }),
    )

    check("reports missing paths", (harness) =>
      Effect.gen(function* () {
        const target = `${harness.root}/missing`
        expect(yield* Effect.flip(harness.files.read(target))).toBeInstanceOf(NotFound)
        expect(yield* Effect.flip(harness.files.realpath(target))).toBeInstanceOf(NotFound)
        expect(yield* Effect.flip(harness.files.stat(target))).toBeInstanceOf(NotFound)
        expect(yield* Effect.flip(harness.files.list(target))).toBeInstanceOf(NotFound)
        expect(yield* Effect.flip(harness.files.move(target, `${harness.root}/other`))).toBeInstanceOf(NotFound)
      }),
    )

    check("reports the actual kind", (harness) =>
      Effect.gen(function* () {
        const directory = `${harness.root}/directory`
        const file = `${harness.root}/file`
        yield* harness.files.mkdir(directory)
        yield* harness.files.write(file, bytes("data"))
        const readError = yield* Effect.flip(harness.files.read(directory))
        const listError = yield* Effect.flip(harness.files.list(file))
        expect(readError).toBeInstanceOf(WrongKind)
        expect((readError as WrongKind).actual).toBe("directory")
        expect(listError).toBeInstanceOf(WrongKind)
        expect((listError as WrongKind).actual).toBe("file")
      }),
    )

    check("write creates parent directories", (harness) =>
      Effect.gen(function* () {
        const target = `${harness.root}/one/two/file`
        yield* harness.files.write(target, bytes("nested"))
        yield* harness.files.write(`${harness.root}/empty`, new Uint8Array())
        expect((yield* harness.files.stat(`${harness.root}/one/two`)).type).toBe("directory")
        expect(yield* harness.files.stat(`${harness.root}/empty`)).toMatchObject({ type: "file", size: 0 })
        expect(text((yield* harness.files.read(target)).bytes)).toBe("nested")
      }),
    )

    check("reads byte ranges", (harness) =>
      Effect.gen(function* () {
        const target = `${harness.root}/range`
        yield* harness.files.write(target, bytes("0123456789"))
        expect(text((yield* harness.files.read(target, { offset: 2, length: 4 })).bytes)).toBe("2345")
        expect(text((yield* harness.files.read(target, { offset: 8, length: 8 })).bytes)).toBe("89")
        expect(text((yield* harness.files.read(target, { offset: 20, length: 4 })).bytes)).toBe("")
      }),
    )

    check("lists immediate entries with their kinds", (harness) =>
      Effect.gen(function* () {
        yield* harness.files.write(`${harness.root}/file name`, bytes("data"))
        yield* harness.files.mkdir(`${harness.root}/directory`)
        yield* harness.files.write(`${harness.root}/directory/nested`, bytes("nested"))
        const entries = yield* harness.files.list(harness.root)
        expect(entries.toSorted((a, b) => a.name.localeCompare(b.name))).toEqual([
          { name: "directory", type: "directory" },
          { name: "file name", type: "file" },
        ])
      }),
    )

    check("preserves symlink metadata while following symlinks for content", (harness) =>
      Effect.gen(function* () {
        if (!harness.symlink) return
        yield* harness.files.write(`${harness.root}/target`, bytes("target"))
        yield* harness.files.write(`${harness.root}/target-dir/file`, bytes("through link"))
        yield* harness.symlink("../target", `${harness.root}/target-dir/entry-link`)
        yield* harness.symlink("target", `${harness.root}/link`)
        yield* harness.symlink("target-dir", `${harness.root}/link-dir`)
        yield* harness.symlink("missing", `${harness.root}/dangling-link`)
        expect(yield* harness.files.realpath(`${harness.root}/link`)).toBe(`${harness.root}/target`)
        expect(yield* harness.files.realpath(`${harness.root}/link-dir/file`)).toBe(`${harness.root}/target-dir/file`)
        expect(yield* Effect.flip(harness.files.realpath(`${harness.root}/dangling-link`))).toBeInstanceOf(NotFound)
        expect((yield* harness.files.stat(`${harness.root}/link`)).type).toBe("symlink")
        expect(yield* harness.files.list(harness.root)).toContainEqual({ name: "link", type: "symlink" })
        expect(text((yield* harness.files.read(`${harness.root}/link-dir/file`)).bytes)).toBe("through link")
        expect(
          (yield* harness.files.list(`${harness.root}/link-dir`)).toSorted((a, b) => a.name.localeCompare(b.name)),
        ).toEqual([
          { name: "entry-link", type: "symlink" },
          { name: "file", type: "file" },
        ])

        const fileError = yield* Effect.flip(harness.files.list(`${harness.root}/link`))
        expect(fileError).toBeInstanceOf(WrongKind)
        expect((fileError as WrongKind).actual).toBe("file")
        expect(yield* Effect.flip(harness.files.list(`${harness.root}/dangling-link`))).toBeInstanceOf(NotFound)
      }),
    )

    check("follows symlinks when reading", (harness) =>
      Effect.gen(function* () {
        if (!harness.symlink) return
        yield* harness.files.write(`${harness.root}/target`, bytes("target content"))
        yield* harness.files.mkdir(`${harness.root}/directory`)
        yield* harness.symlink("target", `${harness.root}/file-link`)
        yield* harness.symlink("directory", `${harness.root}/directory-link`)
        yield* harness.symlink("missing", `${harness.root}/dangling-link`)

        const result = yield* harness.files.read(`${harness.root}/file-link`)
        expect(text(result.bytes)).toBe("target content")
        expect(result.info.type).toBe("file")
        expect(result.info.size).toBe(bytes("target content").length)

        const directoryError = yield* Effect.flip(harness.files.read(`${harness.root}/directory-link`))
        expect(directoryError).toBeInstanceOf(WrongKind)
        expect((directoryError as WrongKind).actual).toBe("directory")
        expect(yield* Effect.flip(harness.files.read(`${harness.root}/dangling-link`))).toBeInstanceOf(NotFound)
      }),
    )

    check("moves files and removes trees idempotently", (harness) =>
      Effect.gen(function* () {
        const source = `${harness.root}/source/file`
        const destination = `${harness.root}/destination`
        yield* harness.files.write(source, bytes("moved"))
        yield* harness.files.move(source, destination)
        expect(text((yield* harness.files.read(destination)).bytes)).toBe("moved")
        expect(yield* Effect.flip(harness.files.stat(source))).toBeInstanceOf(NotFound)
        yield* harness.files.remove(`${harness.root}/source`)
        yield* harness.files.remove(`${harness.root}/source`)
        expect(yield* Effect.flip(harness.files.stat(`${harness.root}/source`))).toBeInstanceOf(NotFound)
      }),
    )
  })
}
