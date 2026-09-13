import { beforeEach, describe, expect } from "bun:test"
import path from "path"
import { Effect, Exit, Layer, Result } from "effect"
import { Config } from "@opencode/core/config"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { FileSystem } from "@opencode/core/filesystem"
import { FSUtil } from "@opencode/util/fs-util"
import { Location } from "@opencode/core/location"
import { Image } from "@opencode/core/image"
import { Permission } from "@opencode/core/permission"
import { Session } from "@opencode/core/session"
import { AbsolutePath, RelativePath } from "@opencode/core/schema"
import { Global } from "@opencode/util/global"
import { FileAccess } from "@opencode/core/file-access"
import { location } from "./fixture/location"
import { Tool } from "@opencode/core/tool"
import { ReadTool } from "@opencode/core/tool/plugin/read"
import { ReadToolFileSystem } from "@opencode/core/tool/read-filesystem"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { SessionInstructions } from "@opencode/core/session/instructions"
import { Environment } from "@opencode/core/environment/index"
import { testEffect } from "./lib/effect"
import { permissionLayer } from "./lib/permission"
import { toolIdentity, executeTool, registerToolPlugin, toolDefinitions } from "./lib/tool"

const readToolNode = makeLocationNode({
  name: "test/read-tool-plugin",
  layer: Layer.effectDiscard(registerToolPlugin(ReadTool.Plugin)),
  deps: [
    Tool.node,
    ReadToolFileSystem.node,
    FileAccess.node,
    Image.node,
    Permission.node,
    SessionInstructions.node,
    FSUtil.node,
    Location.node,
  ],
})

const assertions: Permission.AssertInput[] = []
const missingPath = "__missing_read_target__.txt"
const missingAbsolutePath = path.join(process.cwd(), missingPath)
const readCalls: {
  input: AbsolutePath
  page: ReadToolFileSystem.PageInput
}[] = []
const listCalls: AbsolutePath[] = []
let readDefect: unknown
let directoryEntries: string[] = []
let directoryEntryDetails: Environment.DirEntry[] = []
let readResult: ReadToolFileSystem.FileContent | ReadToolFileSystem.TextPage | ReadToolFileSystem.ListPage = {
  type: "file",
  uri: "file:///README.md",
  name: "README.md",
  content: "hello",
  encoding: "utf8",
  mime: "text/plain",
}
let readFailure: ReadToolFileSystem.ReadError | undefined
let readOverride: ReadToolFileSystem.Interface["read"] | undefined
const reader = Layer.succeed(
  ReadToolFileSystem.Service,
  ReadToolFileSystem.Service.of({
    list: (input) => {
      listCalls.push(input)
      return Effect.succeed(directoryEntryDetails)
    },
    read: (input, resource, page = {}) => {
      readCalls.push({ input, page })
      if (readDefect !== undefined) return Effect.die(readDefect)
      if (readOverride) return readOverride(input, resource, page)
      if (readFailure !== undefined) return Effect.fail(readFailure)
      return Effect.succeed(readResult)
    },
  }),
)
let allow = true
let deniedResource: string | undefined
const permission = permissionLayer({
  assert: (input) =>
    Effect.sync(() => {
      assertions.push(input)
    }).pipe(
      Effect.andThen(
        allow && !input.resources.some((resource) => resource === deniedResource)
          ? Effect.void
          : Effect.fail(
              new Permission.BlockedError({
                rules: [],
                permission: input.action,
                resources: input.resources,
              }),
            ),
      ),
    ),
})
const config = Config.testLayer()
const imageLayer = AppNodeBuilder.build(Image.node)
const testFileSystem = Layer.effect(
  FSUtil.Service,
  FSUtil.Service.use((fs) =>
    Effect.succeed(
      FSUtil.Service.of({
        ...fs,
        readDirectory: () => Effect.succeed(directoryEntries),
      }),
    ),
  ),
).pipe(Layer.provide(LayerNode.compile(FSUtil.node)))
const locationLayer = Layer.succeed(
  Location.Service,
  Location.Service.of(location({ directory: AbsolutePath.make(process.cwd()) })),
)
const unavailableImage = Layer.mock(Image.Service, {
  normalize: () => Effect.fail(new Image.ResizerUnavailableError()),
})
const readLayer = (imageLayer: Layer.Layer<Image.Service>) =>
  Layer.mergeAll(
    AppNodeBuilder.build(LayerNode.group([Tool.node, readToolNode]), [
      ReadToolFileSystem.node.replace(reader),
      Permission.node.replace(permission),
      Config.node.replace(config),
      Image.node.replace(imageLayer),
      FSUtil.node.replace(testFileSystem),
      Location.node.replace(locationLayer),
      Global.node.replace(Global.layerWith({ data: Global.Path.data })),
    ]),
    // Merge by reference so Config.Test and Image.Service resolve to the memoized instances.
    config,
    imageLayer,
  )
const it = testEffect(readLayer(imageLayer))
const itWithoutResizer = testEffect(readLayer(unavailableImage))
const sessionID = Session.ID.make("ses_read_tool_test")

describe("ReadTool", () => {
  beforeEach(() => {
    assertions.length = 0
    readCalls.length = 0
    listCalls.length = 0
    allow = true
    deniedResource = undefined
    readDefect = undefined
    directoryEntries = []
    directoryEntryDetails = []
    readResult = {
      type: "file",
      uri: "file:///README.md",
      name: "README.md",
      content: "hello",
      encoding: "utf8",
      mime: "text/plain",
    }
    readFailure = undefined
    readOverride = undefined
  })

  it.effect("registers, authorizes, and reads through the location filesystem", () =>
    Effect.gen(function* () {
      const registry = yield* Tool.Service

      expect((yield* toolDefinitions(registry)).map((tool) => tool.name)).toEqual(["read", "execute"])
      expect(
        (yield* toolDefinitions(registry, [{ action: "read", resource: "*", effect: "deny" }])).map(
          (tool) => tool.name,
        ),
      ).toEqual(["execute"])
      const execution = yield* executeTool(registry, {
        sessionID,
        ...toolIdentity,
        call: { type: "tool-call", id: "call-read", name: "read", input: { path: "README.md" } },
      })
      expect(execution.status).toBe("completed")
      if (execution.status !== "completed") return
      expect(execution.output).toEqual({
        type: "file",
        uri: "file:///README.md",
        name: "README.md",
        content: "hello",
        encoding: "utf8",
        mime: "text/plain",
      })
      expect(execution.content).toEqual([{ type: "text", text: "Read file README.md, lines 1-1\n1: hello" }])
      expect(assertions).toMatchObject([{ sessionID, action: "read", resources: ["README.md"], save: ["*"] }])
      expect(readCalls).toEqual([
        {
          input: AbsolutePath.make(path.join(process.cwd(), "README.md")),
          page: { offset: undefined, limit: undefined },
        },
      ])
    }),
  )

  it.effect("surfaces 1-based guidance when the model hallucinates a negative offset", () =>
    Effect.gen(function* () {
      const registry = yield* Tool.Service
      const execution = yield* executeTool(registry, {
        sessionID,
        ...toolIdentity,
        call: {
          type: "tool-call",
          id: "call-read-negative-offset",
          name: "read",
          input: { path: "README.md", offset: -1 },
        },
      })
      expect(execution.status).toBe("error")
      if (execution.status !== "error") return
      expect(JSON.stringify(execution.error)).toContain("1-based")
    }),
  )

  it.effect("asks for external_directory approval before reading an external absolute path", () =>
    Effect.gen(function* () {
      const registry = yield* Tool.Service
      const external = path.join(path.parse(process.cwd()).root, "external-read", "notes.txt")

      expect(
        yield* executeTool(registry, {
          sessionID,
          ...toolIdentity,
          call: { type: "tool-call", id: "call-external-read", name: "read", input: { path: external } },
        }),
      ).toMatchObject({ status: "completed" })
      expect(assertions).toMatchObject([
        {
          sessionID,
          action: "external_directory",
          resources: [path.join(path.dirname(external), "*").replaceAll("\\", "/")],
        },
        { sessionID, action: "read", resources: [external.replaceAll("\\", "/")], save: ["*"] },
      ])
      expect(readCalls).toEqual([{ input: AbsolutePath.make(external), page: { offset: undefined, limit: undefined } }])
    }),
  )

  it.effect("returns a small PNG as native media instead of durable base64 text", () =>
    Effect.gen(function* () {
      const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
      readResult = {
        type: "file",
        uri: "file:///pixel.png",
        name: "pixel.png",
        content: png,
        encoding: "base64",
        mime: "image/png",
      }
      const registry = yield* Tool.Service

      const execution = yield* executeTool(registry, {
        sessionID,
        ...toolIdentity,
        call: { type: "tool-call", id: "call-image", name: "read", input: { path: "pixel.png" } },
      })
      expect(execution.status).toBe("completed")
      if (execution.status !== "completed") return
      expect(execution.content).toEqual([
        { type: "text", text: "Image read successfully" },
        { type: "file", uri: `data:image/png;base64,${png}`, mime: "image/png", name: "pixel.png" },
      ])
      expect(readCalls).toEqual([
        {
          input: AbsolutePath.make(path.join(process.cwd(), "pixel.png")),
          page: { offset: undefined, limit: undefined },
        },
      ])

      const settled = yield* executeTool(registry, {
        sessionID,
        ...toolIdentity,
        call: { type: "tool-call", id: "call-image-settle", name: "read", input: { path: "pixel.png" } },
      })
      expect(settled.status).toBe("completed")
      if (settled.status !== "completed") return
      expect(settled.metadata).toEqual({ truncated: false })
      expect(settled.content).toMatchObject([
        { type: "text", text: "Image read successfully" },
        { type: "file", mime: "image/png", uri: `data:image/png;base64,${png}` },
      ])
    }),
  )

  it.effect("preserves a PNG above the generic text limit as native media", () =>
    Effect.gen(function* () {
      const photon = yield* Effect.promise(() => import("@silvia-odwyer/photon-node"))
      const pixels = Uint8Array.from({ length: 256 * 256 * 4 }, (_, index) => (index * 73 + (index >> 3)) % 256)
      const source = new photon.PhotonImage(pixels, 256, 256)
      const png = Buffer.from(source.get_bytes()).toString("base64")
      source.free()
      expect(Buffer.byteLength(png)).toBeGreaterThan(50 * 1024)
      readResult = {
        type: "file",
        uri: "file:///large.png",
        name: "large.png",
        content: png,
        encoding: "base64",
        mime: "image/png",
      }
      const registry = yield* Tool.Service

      const settled = yield* executeTool(registry, {
        sessionID,
        ...toolIdentity,
        call: { type: "tool-call", id: "call-large-image", name: "read", input: { path: "large.png" } },
      })

      expect(settled.status).toBe("completed")
      if (settled.status !== "completed") return
      expect(settled.output).toMatchObject({
        uri: "file:///large.png",
        name: "large.png",
        mime: "image/png",
        encoding: "base64",
      })
      expect(settled.content).toEqual([
        { type: "text", text: "Image read successfully" },
        { type: "file", uri: `data:image/png;base64,${png}`, mime: "image/png", name: "large.png" },
      ])
    }),
  )

  itWithoutResizer.effect("returns the original image when the resizer is unavailable", () =>
    Effect.gen(function* () {
      const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
      readResult = {
        type: "file",
        uri: "file:///pixel.png",
        name: "pixel.png",
        content: png,
        encoding: "base64",
        mime: "image/png",
      }
      const registry = yield* Tool.Service

      expect(
        yield* executeTool(registry, {
          sessionID,
          ...toolIdentity,
          call: { type: "tool-call", id: "call-image-fallback", name: "read", input: { path: "pixel.png" } },
        }),
      ).toMatchObject({
        status: "completed",
        content: [{ type: "text" }, { type: "file", uri: `data:image/png;base64,${png}`, mime: "image/png" }],
      })
    }),
  )

  it.effect("drops undecodable image data from the outcome", () =>
    Effect.gen(function* () {
      readResult = {
        type: "file",
        uri: "file:///truncated.png",
        name: "truncated.png",
        content: "iVBORw0KGgo=",
        encoding: "base64",
        mime: "image/png",
      }
      const registry = yield* Tool.Service

      expect(
        yield* executeTool(registry, {
          sessionID,
          ...toolIdentity,
          call: { type: "tool-call", id: "call-truncated-image", name: "read", input: { path: "truncated.png" } },
        }),
      ).toMatchObject({
        status: "completed",
        content: [
          { type: "text", text: "Image read successfully" },
          { type: "text", text: "[1 image omitted: could not be decoded.]" },
        ],
      })
    }),
  )

  it.effect("drops oversized images from the outcome when resizing is disabled", () =>
    Effect.gen(function* () {
      const photon = yield* Effect.promise(() => import("@silvia-odwyer/photon-node"))
      const source = new photon.PhotonImage(new Uint8Array(Array.from({ length: 16 * 4 }, () => 255)), 16, 1)
      const base64 = Buffer.from(source.get_bytes()).toString("base64")
      source.free()
      readResult = {
        type: "file",
        uri: "file:///wide.png",
        name: "wide.png",
        content: base64,
        encoding: "base64",
        mime: "image/png",
      }
      const image = yield* Image.Service
      yield* image.transform((editor) => editor.configure({ autoResize: false, maxWidth: 4 }))
      const registry = yield* Tool.Service

      expect(
        yield* executeTool(registry, {
          sessionID,
          ...toolIdentity,
          call: { type: "tool-call", id: "call-wide-image", name: "read", input: { path: "wide.png" } },
        }),
      ).toMatchObject({
        status: "completed",
        content: [
          { type: "text", text: "Image read successfully" },
          { type: "text", text: "[1 image omitted: could not be resized below the image size limit.]" },
        ],
      })
    }),
  )

  it.effect("resizes images to configured dimensions before returning media", () =>
    Effect.gen(function* () {
      const photon = yield* Effect.promise(() => import("@silvia-odwyer/photon-node"))
      const source = new photon.PhotonImage(new Uint8Array(Array.from({ length: 16 * 4 }, () => 255)), 16, 1)
      const base64 = Buffer.from(source.get_bytes()).toString("base64")
      source.free()
      readResult = {
        type: "file",
        uri: "file:///wide.png",
        name: "wide.png",
        content: base64,
        encoding: "base64",
        mime: "image/png",
      }
      const image = yield* Image.Service
      yield* image.transform((editor) => editor.configure({ maxWidth: 4 }))
      const registry = yield* Tool.Service
      const result = yield* executeTool(registry, {
        sessionID,
        ...toolIdentity,
        call: { type: "tool-call", id: "call-resize-image", name: "read", input: { path: "wide.png" } },
      })

      expect(result.status).toBe("completed")
      if (result.status !== "completed") return
      const media = result.content?.[1]
      expect(media?.type).toBe("file")
      if (media?.type !== "file") return
      const resized = photon.PhotonImage.new_from_byteslice(Buffer.from(media.uri.split(",")[1] ?? "", "base64"))
      expect(resized.get_width()).toBeLessThanOrEqual(4)
      expect(resized.get_height()).toBeLessThanOrEqual(2_000)
      resized.free()
    }),
  )

  it.effect("accepts PNG candidates at the exact base64 limit and skips them one byte below", () =>
    Effect.gen(function* () {
      const photon = yield* Effect.promise(() => import("@silvia-odwyer/photon-node"))
      const source = new photon.PhotonImage(
        Uint8Array.from({ length: 16 * 4 }, () => 255),
        16,
        1,
      )
      const content = {
        uri: "file:///wide.png",
        content: Buffer.from(source.get_bytes()).toString("base64"),
        encoding: "base64" as const,
        mime: "image/png",
      }
      source.free()
      const image = yield* Image.Service

      for (const [maxWidth, padding] of [
        [4, "=="],
        [5, "="],
        [6, ""],
      ] as const) {
        yield* image.transform((editor) => editor.configure({ maxWidth, maxBase64Bytes: 1_024 }))
        const candidate = yield* image.normalize("wide.png", content)
        expect(candidate.mime).toBe("image/png")
        expect(candidate.content.match(/=*$/)?.[0]).toBe(padding)

        yield* image.transform((editor) => editor.configure({ maxBase64Bytes: candidate.content.length }))
        expect(yield* image.normalize("wide.png", content)).toEqual(candidate)

        yield* image.transform((editor) => editor.configure({ maxBase64Bytes: candidate.content.length - 1 }))
        const smaller = yield* image.normalize("wide.png", content)
        expect(smaller.mime).toBe("image/png")
        expect(smaller.content.length).toBeLessThan(candidate.content.length)
      }
    }),
  )

  it.effect("drops images that cannot fit max base64 bytes after resize attempts", () =>
    Effect.gen(function* () {
      const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
      readResult = {
        type: "file",
        uri: "file:///pixel.png",
        name: "pixel.png",
        content: png,
        encoding: "base64",
        mime: "image/png",
      }
      const image = yield* Image.Service
      yield* image.transform((editor) => editor.configure({ maxBase64Bytes: 1 }))
      const registry = yield* Tool.Service

      expect(
        yield* executeTool(registry, {
          sessionID,
          ...toolIdentity,
          call: { type: "tool-call", id: "call-max-bytes", name: "read", input: { path: "pixel.png" } },
        }),
      ).toMatchObject({
        status: "completed",
        content: [
          { type: "text", text: "Image read successfully" },
          { type: "text", text: "[1 image omitted: could not be resized below the image size limit.]" },
        ],
      })
    }),
  )

  it.effect("returns supported image contents despite a misleading binary extension", () =>
    Effect.gen(function* () {
      const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
      readResult = {
        type: "file",
        uri: "file:///pixel.bin",
        name: "pixel.bin",
        content: png,
        encoding: "base64",
        mime: "image/png",
      }
      const registry = yield* Tool.Service

      expect(
        yield* executeTool(registry, {
          sessionID,
          ...toolIdentity,
          call: { type: "tool-call", id: "call-disguised-image", name: "read", input: { path: "pixel.bin" } },
        }),
      ).toMatchObject({
        status: "completed",
        content: [{ type: "text" }, { type: "file", mime: "image/png", name: "pixel.bin" }],
      })
    }),
  )

  it.effect("returns PDFs as native media", () =>
    Effect.gen(function* () {
      const pdf = "JVBERi0xLjcK"
      readResult = {
        type: "file",
        uri: "file:///document.pdf",
        name: "document.pdf",
        content: pdf,
        encoding: "base64",
        mime: "application/pdf",
      }
      const registry = yield* Tool.Service

      expect(
        yield* executeTool(registry, {
          sessionID,
          ...toolIdentity,
          call: { type: "tool-call", id: "call-pdf", name: "read", input: { path: "document.pdf" } },
        }),
      ).toMatchObject({
        status: "completed",
        content: [
          { type: "text", text: "PDF read successfully" },
          { type: "file", uri: `data:application/pdf;base64,${pdf}`, mime: "application/pdf", name: "document.pdf" },
        ],
      })
    }),
  )

  it.effect("returns expected filesystem failures to the model", () =>
    Effect.gen(function* () {
      readFailure = new ReadToolFileSystem.BinaryFileError({ resource: "archive.dat" })
      const registry = yield* Tool.Service

      expect(
        yield* executeTool(registry, {
          sessionID,
          ...toolIdentity,
          call: {
            type: "tool-call",
            id: "call-binary",
            name: "read",
            input: { path: "archive.dat", offset: 2, limit: 1 },
          },
        }),
      ).toEqual({ status: "error", error: { type: "unknown", message: "Cannot read binary file: archive.dat" } })
      expect(readCalls).toEqual([
        { input: AbsolutePath.make(path.join(process.cwd(), "archive.dat")), page: { offset: 2, limit: 1 } },
      ])
    }),
  )

  it.effect("preserves actionable read failure messages", () =>
    Effect.gen(function* () {
      const registry = yield* Tool.Service
      for (const [error, message] of [
        [new ReadToolFileSystem.OffsetOutOfRangeError({ offset: 10 }), "Offset 10 is out of range"],
        [
          new ReadToolFileSystem.PathKindError({ resource: "socket", expected: "a file" }),
          "Path is not a file: socket",
        ],
      ] as const) {
        readFailure = error
        expect(
          yield* executeTool(registry, {
            sessionID,
            ...toolIdentity,
            call: { type: "tool-call", id: `call-${error._tag}`, name: "read", input: { path: "target" } },
          }),
        ).toEqual({ status: "error", error: { type: "unknown", message } })
      }
    }),
  )

  it.effect("preserves unexpected filesystem defects", () =>
    Effect.gen(function* () {
      readDefect = new Error("unexpected")
      const registry = yield* Tool.Service

      const exit = yield* executeTool(registry, {
        sessionID,
        ...toolIdentity,
        call: { type: "tool-call", id: "call-defect", name: "read", input: { path: "README.md" } },
      }).pipe(Effect.exit)
      expect(Result.getOrThrow(Exit.findDefect(exit))).toBe(readDefect)
      expect(readCalls).toEqual([
        {
          input: AbsolutePath.make(path.join(process.cwd(), "README.md")),
          page: { offset: undefined, limit: undefined },
        },
      ])
    }),
  )

  it.effect("does not read when permission is denied", () =>
    Effect.gen(function* () {
      allow = false
      const registry = yield* Tool.Service

      expect(
        yield* executeTool(registry, {
          sessionID,
          ...toolIdentity,
          call: { type: "tool-call", id: "call-read", name: "read", input: { path: "README.md" } },
        }),
      ).toEqual({ status: "error", error: { type: "permission.rejected", message: "Permission denied: read" } })
      expect(readCalls).toEqual([])
    }),
  )

  it.effect("returns missing paths as model-visible tool failures", () =>
    Effect.gen(function* () {
      readFailure = new Environment.NotFound({ path: missingAbsolutePath })
      directoryEntries = [
        "__missing_read_target__.txt.bak",
        "copy___missing_read_target__.txt",
        "old___missing_read_target__.txt",
        "other___missing_read_target__.txt",
        "unrelated.txt",
      ]
      const registry = yield* Tool.Service

      expect(
        yield* executeTool(registry, {
          sessionID,
          ...toolIdentity,
          call: { type: "tool-call", id: "call-missing-path", name: "read", input: { path: missingPath } },
        }),
      ).toEqual({
        status: "error",
        error: {
          type: "tool.execution",
          message: `File not found: ${missingPath}\n\nDid you mean one of these?\n__missing_read_target__.txt.bak\ncopy___missing_read_target__.txt\nold___missing_read_target__.txt`,
        },
      })
      expect(assertions).toMatchObject([{ sessionID, action: "read", resources: [missingPath], save: ["*"] }])
      expect(readCalls).toEqual([
        {
          input: AbsolutePath.make(missingAbsolutePath),
          page: { offset: undefined, limit: undefined },
        },
      ])
    }),
  )

  it.effect("recovers a unique file whose non-breaking spaces differ", () =>
    Effect.gen(function* () {
      const requested = "Screenshot 2026-08-27 3.15 PM.png"
      const recovered = "Screenshot 2026-08-27 3.15\u202fPM.png"
      const requestedAbsolute = path.join(process.cwd(), requested)
      const recoveredAbsolute = path.join(process.cwd(), recovered)
      directoryEntryDetails = [{ name: recovered, type: "file" }]
      readOverride = (input) =>
        input === requestedAbsolute
          ? Effect.fail(new Environment.NotFound({ path: requestedAbsolute }))
          : Effect.succeed(readResult)
      const registry = yield* Tool.Service

      const result = yield* executeTool(registry, {
        sessionID,
        ...toolIdentity,
        call: { type: "tool-call", id: "call-recovered-path", name: "read", input: { path: requested } },
      })

      expect(result).toMatchObject({
        status: "completed",
        content: [{ type: "text", text: `Read file ${recovered}, lines 1-1\n1: hello` }],
      })
      expect(assertions).toMatchObject([
        { action: "read", resources: [requested] },
        { action: "read", resources: [recovered] },
      ])
      expect(readCalls.map((call) => call.input)).toEqual([
        AbsolutePath.make(requestedAbsolute),
        AbsolutePath.make(recoveredAbsolute),
      ])
      expect(listCalls).toEqual([AbsolutePath.make(process.cwd())])
    }),
  )

  it.effect("recovers an external filename without repeating directory approval", () =>
    Effect.gen(function* () {
      const directory = path.join(path.parse(process.cwd()).root, "external-read")
      const requested = path.join(directory, "report final.txt")
      const recovered = path.join(directory, "report\u202ffinal.txt")
      directoryEntryDetails = [{ name: path.basename(recovered), type: "file" }]
      readOverride = (input) =>
        input === requested ? Effect.fail(new Environment.NotFound({ path: requested })) : Effect.succeed(readResult)
      const registry = yield* Tool.Service

      expect(
        yield* executeTool(registry, {
          sessionID,
          ...toolIdentity,
          call: { type: "tool-call", id: "call-external-recovery", name: "read", input: { path: requested } },
        }),
      ).toMatchObject({ status: "completed" })
      expect(assertions).toMatchObject([
        { action: "external_directory", resources: [path.join(directory, "*").replaceAll("\\", "/")] },
        { action: "read", resources: [requested.replaceAll("\\", "/")] },
        { action: "read", resources: [recovered.replaceAll("\\", "/")] },
      ])
      expect(readCalls.map((call) => call.input)).toEqual([AbsolutePath.make(requested), AbsolutePath.make(recovered)])
    }),
  )

  it.effect("does not read a recovered filename denied by its own read rules", () =>
    Effect.gen(function* () {
      const requested = path.join(process.cwd(), "report final.txt")
      const recovered = path.join(process.cwd(), "report\u202ffinal.txt")
      deniedResource = path.basename(recovered)
      directoryEntryDetails = [{ name: path.basename(recovered), type: "file" }]
      readOverride = (input) =>
        input === requested ? Effect.fail(new Environment.NotFound({ path: requested })) : Effect.succeed(readResult)
      const registry = yield* Tool.Service

      expect(
        yield* executeTool(registry, {
          sessionID,
          ...toolIdentity,
          call: { type: "tool-call", id: "call-denied-recovery", name: "read", input: { path: requested } },
        }),
      ).toMatchObject({ status: "error", error: { type: "permission.rejected" } })
      expect(assertions).toMatchObject([
        { action: "read", resources: [path.basename(requested)] },
        { action: "read", resources: [path.basename(recovered)] },
      ])
      expect(readCalls.map((call) => call.input)).toEqual([AbsolutePath.make(requested)])
    }),
  )

  it.effect("does not recover ambiguous files", () =>
    Effect.gen(function* () {
      const requested = "report final.txt"
      const requestedAbsolute = path.join(process.cwd(), requested)
      readFailure = new Environment.NotFound({ path: requestedAbsolute })
      directoryEntryDetails = [
        { name: "report\u00a0final.txt", type: "file" },
        { name: "report\u202ffinal.txt", type: "file" },
      ]
      const registry = yield* Tool.Service

      expect(
        yield* executeTool(registry, {
          sessionID,
          ...toolIdentity,
          call: { type: "tool-call", id: "call-ambiguous-path", name: "read", input: { path: requested } },
        }),
      ).toMatchObject({ status: "error", error: { message: `File not found: ${requested}` } })
      expect(assertions).toHaveLength(1)
      expect(readCalls).toHaveLength(1)
    }),
  )

  it.effect("does not recover a directory", () =>
    Effect.gen(function* () {
      const requested = "report final"
      const recovered = "report\u00a0final"
      const requestedAbsolute = path.join(process.cwd(), requested)
      directoryEntryDetails = [{ name: recovered, type: "directory" }]
      readOverride = (input) =>
        input === requestedAbsolute
          ? Effect.fail(new Environment.NotFound({ path: requestedAbsolute }))
          : Effect.succeed(new ReadToolFileSystem.ListPage({ type: "list-page", entries: [], truncated: false }))
      const registry = yield* Tool.Service

      expect(
        yield* executeTool(registry, {
          sessionID,
          ...toolIdentity,
          call: { type: "tool-call", id: "call-directory-recovery", name: "read", input: { path: requested } },
        }),
      ).toMatchObject({ status: "error", error: { message: `File not found: ${requested}` } })
      expect(assertions).toHaveLength(1)
      expect(readCalls).toHaveLength(1)
    }),
  )

  it.effect("lists a bounded directory page through read", () =>
    Effect.gen(function* () {
      readResult = new ReadToolFileSystem.ListPage({
        type: "list-page",
        entries: [
          FileSystem.Entry.make({ path: RelativePath.make("components/"), type: "directory" }),
          FileSystem.Entry.make({ path: RelativePath.make("index.ts"), type: "file" }),
        ],
        truncated: true,
        next: 4,
      })
      const registry = yield* Tool.Service

      const result = yield* executeTool(registry, {
        sessionID,
        ...toolIdentity,
        call: {
          type: "tool-call",
          id: "call-read-directory",
          name: "read",
          input: { path: "src", offset: 2, limit: 10 },
        },
      })
      expect(result).toMatchObject({
        status: "completed",
        output: { entries: readResult.entries, truncated: true, next: 4 },
      })
      if (result.status !== "completed") return
      expect(result.metadata).toEqual({ truncated: true })
      expect(result.content).toEqual([
        {
          type: "text",
          text: "Read directory src, entries 2-3\ncomponents/\nindex.ts\n[Output truncated. Continue reading with offset: 4]",
        },
      ])
      expect(assertions).toMatchObject([{ sessionID, action: "read", resources: ["src"], save: ["*"] }])
      expect(readCalls).toEqual([
        { input: AbsolutePath.make(path.join(process.cwd(), "src")), page: { offset: 2, limit: 10 } },
      ])
    }),
  )

  it.effect("normalizes a zero directory offset in the model heading", () =>
    Effect.gen(function* () {
      readResult = new ReadToolFileSystem.ListPage({
        type: "list-page",
        entries: [FileSystem.Entry.make({ path: RelativePath.make("index.ts"), type: "file" })],
        truncated: true,
        next: 2,
      })
      const registry = yield* Tool.Service

      const result = yield* executeTool(registry, {
        sessionID,
        ...toolIdentity,
        call: {
          type: "tool-call",
          id: "call-read-directory-zero",
          name: "read",
          input: { path: "src", offset: 0, limit: 1 },
        },
      })
      expect(result.status).toBe("completed")
      if (result.status !== "completed") return
      expect(result.content).toEqual([
        {
          type: "text",
          text: "Read directory src, entries 1-1\nindex.ts\n[Output truncated. Continue reading with offset: 2]",
        },
      ])
      expect(readCalls).toEqual([
        { input: AbsolutePath.make(path.join(process.cwd(), "src")), page: { offset: 0, limit: 1 } },
      ])
    }),
  )

  it.effect("does not list a directory when permission is denied", () =>
    Effect.gen(function* () {
      allow = false
      const registry = yield* Tool.Service

      expect(
        yield* executeTool(registry, {
          sessionID,
          ...toolIdentity,
          call: { type: "tool-call", id: "call-read-directory-denied", name: "read", input: { path: "src" } },
        }),
      ).toEqual({ status: "error", error: { type: "permission.rejected", message: "Permission denied: read" } })
      expect(readCalls).toEqual([])
    }),
  )

  it.effect("forwards pagination and returns bounded text pages with continuation", () =>
    Effect.gen(function* () {
      readResult = new ReadToolFileSystem.TextPage({
        type: "text-page",
        content: "hello",
        mime: "text/plain",
        offset: 2,
        truncated: true,
        next: 3,
      })
      const registry = yield* Tool.Service

      const result = yield* executeTool(registry, {
        sessionID,
        ...toolIdentity,
        call: {
          type: "tool-call",
          id: "call-large",
          name: "read",
          input: { path: "large.txt", offset: 2, limit: 1 },
        },
      })
      expect(result).toMatchObject({
        status: "completed",
        output: { type: "text-page", content: "hello", mime: "text/plain", offset: 2, truncated: true, next: 3 },
      })
      if (result.status !== "completed") return
      expect(result.metadata).toEqual({ truncated: true })
      expect(result.content).toEqual([
        {
          type: "text",
          text: "Read file large.txt, lines 2-2\n2: hello\n[Output truncated. Continue reading with offset: 3]",
        },
      ])
      expect(readCalls).toEqual([
        { input: AbsolutePath.make(path.join(process.cwd(), "large.txt")), page: { offset: 2, limit: 1 } },
      ])
    }),
  )

  it.effect("rejects unsupported binary discovered by a direct read", () =>
    Effect.gen(function* () {
      readResult = {
        type: "file",
        uri: "file:///late-binary",
        name: "late-binary",
        content: "AAECAw==",
        encoding: "base64",
        mime: "application/octet-stream",
      }
      const registry = yield* Tool.Service

      expect(
        yield* executeTool(registry, {
          sessionID,
          ...toolIdentity,
          call: { type: "tool-call", id: "call-direct-binary", name: "read", input: { path: "late-binary" } },
        }),
      ).toEqual({ status: "error", error: { type: "unknown", message: "Cannot read binary file: late-binary" } })
    }),
  )
})
