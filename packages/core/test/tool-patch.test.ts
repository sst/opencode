import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { Effect, Exit, Layer, Schema } from "effect"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Environment } from "@opencode/core/environment/index"
import { Formatter } from "@opencode/core/formatter"
import { FileMutation } from "@opencode/core/file-mutation"
import { Location } from "@opencode/core/location"
import { FileAccess } from "@opencode/core/file-access"
import { Model } from "@opencode/core/model"
import { Permission } from "@opencode/core/permission"
import { Provider } from "@opencode/core/provider"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { Tool } from "@opencode/core/tool"
import { PatchTool } from "@opencode/core/tool/plugin/patch"
import type { SessionHooks } from "@opencode/plugin/effect/session"
import { transformEnvironmentFiles } from "./fixture/environment"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { testEffect } from "./lib/effect"
import { permissionLayer } from "./lib/permission"
import { toolIdentity, executeTool, registerToolPlugin, toolDefinitions } from "./lib/tool"

const sessionHooks = new Map<string, (event: SessionHooks["context"]) => Effect.Effect<void>>()
const patchToolNode = makeLocationNode({
  name: "test/patch-tool-plugin",
  layer: Layer.effectDiscard(
    registerToolPlugin(PatchTool.Plugin, {
      session: {
        hook: (name, callback) =>
          Effect.sync(() => {
            sessionHooks.set(name, callback as (event: SessionHooks["context"]) => Effect.Effect<void>)
            return { dispose: Effect.void }
          }),
      },
    }),
  ),
  deps: [
    Tool.node,
    FileAccess.node,
    FileMutation.node,
    Environment.node,
    Formatter.node,
    Location.node,
    Permission.node,
  ],
})

const sessionID = Session.ID.make("ses_patch_tool_test")
const assertions: Permission.AssertInput[] = []
let denyAction: string | undefined
let failRemoveTarget: string | undefined
let failRemoveErrorTarget: string | undefined
let failWriteTarget: string | undefined
let readsBeforeEditApproval = 0
let editApproved = false
let afterEditApproval = (): Effect.Effect<void> => Effect.void
let formatFile = (_target: string): Effect.Effect<boolean> => Effect.succeed(false)

const permission = permissionLayer({
  assert: (input) =>
    Effect.sync(() => {
      assertions.push(input)
      if (input.action === "edit") editApproved = true
    }).pipe(
      Effect.andThen(input.action === "edit" ? Effect.suspend(afterEditApproval) : Effect.void),
      Effect.andThen(
        input.action === denyAction
          ? Effect.fail(
              new Permission.BlockedError({
                rules: [],
                permission: input.action,
                resources: input.resources,
              }),
            )
          : Effect.void,
      ),
    ),
})

const formatter = Layer.mock(Formatter.Service, {
  file: (target) => formatFile(target),
})

const reset = () => {
  assertions.length = 0
  denyAction = undefined
  failRemoveTarget = undefined
  failRemoveErrorTarget = undefined
  failWriteTarget = undefined
  readsBeforeEditApproval = 0
  editApproved = false
  afterEditApproval = () => Effect.void
  formatFile = () => Effect.succeed(false)
}

const withTool = <A, E, R>(
  directory: string,
  body: (registry: Tool.Interface) => Effect.Effect<A, E, R>,
  projectDirectory = directory,
) => {
  const activeLocation = Layer.succeed(
    Location.Service,
    Location.Service.of(
      location({ directory: AbsolutePath.make(directory) }, { projectDirectory: AbsolutePath.make(projectDirectory) }),
    ),
  )
  return Effect.gen(function* () {
    return yield* body(yield* Tool.Service)
  }).pipe(
    Effect.provide(
      AppNodeBuilder.build(LayerNode.group([Tool.node, FileAccess.node, FileMutation.node, patchToolNode]), [
        Environment.node.replace(
          transformEnvironmentFiles((files) => ({
            read: (target, range) =>
              Effect.sync(() => {
                if (!editApproved) readsBeforeEditApproval++
              }).pipe(Effect.andThen(files.read(target, range))),
            remove: (target) => {
              if (failRemoveTarget && path.basename(target) === failRemoveTarget)
                return Effect.die("forced remove failure")
              if (failRemoveErrorTarget && path.basename(target) === failRemoveErrorTarget)
                return Effect.fail(new Environment.Failed({ path: target, cause: new Error("forced remove failure") }))
              return files.remove(target)
            },
            write: (target, content) => {
              if (failWriteTarget && path.basename(target) === failWriteTarget)
                return Effect.fail(new Environment.Failed({ path: target, cause: new Error("forced write failure") }))
              return files.write(target, content)
            },
          })),
        ),
        Location.node.replace(activeLocation),
        Formatter.node.replace(formatter),
        Permission.node.replace(permission),
      ]),
    ),
  )
}

const call = (patchText: string, id = "call-patch") => ({
  sessionID,
  ...toolIdentity,
  call: { type: "tool-call" as const, id, name: "patch", input: { patchText } },
})

const exists = (target: string) =>
  Effect.promise(() =>
    fs.stat(target).then(
      () => true,
      () => false,
    ),
  )
const it = testEffect(Layer.empty)
const withTempTool = <A, E, R>(body: (directory: string, registry: Tool.Interface) => Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.promise(() => tmpdir()),
    (tmp) => {
      reset()
      return withTool(tmp.path, (registry) => body(tmp.path, registry))
    },
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  )

describe("PatchTool", () => {
  it.live("selects the same edit tools for compaction and generate requests as the agent loop", () =>
    withTempTool(() =>
      Effect.gen(function* () {
        const event = (id: string): SessionHooks["context"] => ({
          sessionID,
          agent: toolIdentity.agent,
          model: Model.Ref.make({ providerID: Provider.ID.make("test"), id: Model.ID.make(id) }),
          system: [],
          messages: [],
          tools: Object.fromEntries(
            ["patch", "edit", "write", "read"].map((name) => [name, { description: name, input: { type: "object" } }]),
          ),
          options: {},
        })
        for (const name of ["context", "compaction", "generate"]) {
          const hook = sessionHooks.get(name)
          expect(hook).toBeDefined()
          const claude = event("claude-sonnet-4")
          yield* hook!(claude)
          expect(Object.keys(claude.tools)).toEqual(["edit", "write", "read"])
          const gpt = event("gpt-5")
          yield* hook!(gpt)
          expect(Object.keys(gpt.tools)).toEqual(["patch", "read"])
        }
      }),
    ),
  )

  it.live("registers and sequentially applies add, update, and delete hunks", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        const update = path.join(tmp.path, "update.txt")
        const remove = path.join(tmp.path, "remove.txt")
        return Effect.promise(() =>
          Promise.all([fs.writeFile(update, "before\n"), fs.writeFile(remove, "remove\n")]),
        ).pipe(
          Effect.andThen(
            withTool(tmp.path, (registry) =>
              Effect.gen(function* () {
                expect((yield* toolDefinitions(registry)).map((tool) => tool.name)).toEqual(["patch", "execute"])
                const settled = yield* executeTool(
                  registry,
                  call(
                    "*** Begin Patch\n*** Add File: nested/new.txt\n+created\n*** Update File: update.txt\n@@\n-before\n+after\n*** Delete File: remove.txt\n*** End Patch",
                  ),
                )
                expect(settled.status).toBe("completed")
                if (settled.status !== "completed") return
                expect(settled.content).toEqual([
                  {
                    type: "text",
                    text: "Success. Updated the following files:\nA nested/new.txt\nM update.txt\nD remove.txt",
                  },
                ])
                const modelText = settled.content?.[0]?.type === "text" ? settled.content[0].text : ""
                if (process.platform === "win32") expect(modelText).not.toContain("\\")
                expect(settled.output).toMatchObject({
                  applied: [
                    { type: "add", resource: "nested/new.txt" },
                    { type: "update", resource: "update.txt" },
                    { type: "delete", resource: "remove.txt" },
                  ],
                  files: [
                    {
                      file: "nested/new.txt",
                      status: "added",
                      additions: 1,
                      deletions: 0,
                      patch: expect.stringContaining("+created"),
                    },
                    {
                      file: "update.txt",
                      status: "modified",
                      additions: 1,
                      deletions: 1,
                      patch: expect.stringContaining("-before\n+after"),
                    },
                    {
                      file: "remove.txt",
                      status: "deleted",
                      additions: 0,
                      deletions: 1,
                      patch: expect.stringContaining("-remove"),
                    },
                  ],
                })
                expect(assertions).toMatchObject([
                  {
                    sessionID,
                    action: "edit",
                    resources: ["nested/new.txt", "update.txt", "remove.txt"],
                    save: ["*"],
                    metadata: {
                      filepath: "nested/new.txt, update.txt, remove.txt",
                      diff: expect.stringContaining("Index:"),
                      files: expect.any(Array),
                    },
                  },
                ])
                expect(readsBeforeEditApproval).toBe(2)
                expect(yield* Effect.promise(() => fs.readFile(path.join(tmp.path, "nested/new.txt"), "utf8"))).toBe(
                  "created\n",
                )
                expect(yield* Effect.promise(() => fs.readFile(update, "utf8"))).toBe("after\n")
                expect(yield* exists(remove)).toBe(false)
              }),
            ),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("replaces a file with a directory containing an added file", () =>
    withTempTool((directory, registry) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => fs.writeFile(path.join(directory, "parent"), "before\n"))
        const settled = yield* executeTool(
          registry,
          call("*** Begin Patch\n*** Delete File: parent\n*** Add File: parent/child.txt\n+after\n*** End Patch"),
        )
        expect(settled.status).toBe("completed")
        expect(yield* Effect.promise(() => fs.readFile(path.join(directory, "parent/child.txt"), "utf8"))).toBe(
          "after\n",
        )
      }),
    ),
  )

  it.live("counts deleted lines with and without a trailing newline", () =>
    withTempTool((directory, registry) =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          Promise.all([
            fs.writeFile(path.join(directory, "trailing.txt"), "remove\n"),
            fs.writeFile(path.join(directory, "unterminated.txt"), "remove"),
          ]),
        )
        const settled = yield* executeTool(
          registry,
          call("*** Begin Patch\n*** Delete File: trailing.txt\n*** Delete File: unterminated.txt\n*** End Patch"),
        )
        expect(settled.status).toBe("completed")
        if (settled.status !== "completed") return
        expect(settled.output.files).toMatchObject([
          { file: "trailing.txt", additions: 0, deletions: 1 },
          { file: "unterminated.txt", additions: 0, deletions: 1 },
        ])
      }),
    ),
  )

  it.live("serializes concurrent patch transactions", () =>
    withTempTool((directory, registry) => {
      const target = path.join(directory, "concurrent.txt")
      afterEditApproval = () =>
        assertions.filter((input) => input.action === "edit").length === 1 ? Effect.sleep("50 millis") : Effect.void
      return Effect.promise(() => fs.writeFile(target, "one\ntwo\n")).pipe(
        Effect.andThen(
          Effect.all(
            [
              executeTool(
                registry,
                call(
                  "*** Begin Patch\n*** Update File: concurrent.txt\n@@\n-one\n+ONE\n*** End Patch",
                  "call-patch-one",
                ),
              ),
              executeTool(
                registry,
                call(
                  "*** Begin Patch\n*** Update File: concurrent.txt\n@@\n-two\n+TWO\n*** End Patch",
                  "call-patch-two",
                ),
              ),
            ],
            { concurrency: "unbounded" },
          ),
        ),
        Effect.andThen((results) =>
          Effect.gen(function* () {
            expect(results.map((result) => result.status)).toEqual(["completed", "completed"])
            expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("ONE\nTWO\n")
          }),
        ),
      )
    }),
  )

  it.live("returns file diffs for final formatted content", () =>
    withTempTool((directory, registry) => {
      const target = path.join(directory, "formatted.txt")
      formatFile = (file) =>
        Effect.promise(async () => {
          await fs.writeFile(file, (await fs.readFile(file, "utf8")).replace("created", "FORMATTED"))
          return true
        })
      return Effect.gen(function* () {
        const settled = yield* executeTool(
          registry,
          call("*** Begin Patch\n*** Add File: formatted.txt\n+created\n*** End Patch"),
        )
        expect(settled.status).toBe("completed")
        if (settled.status !== "completed") return
        expect(settled.output.files[0]?.patch).toContain("+FORMATTED")
        expect(settled.metadata?.files?.[0]?.patch).toContain("+FORMATTED")
        expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("FORMATTED\n")
      })
    }),
  )

  it.live("moves and updates a file", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        const source = path.join(tmp.path, "old.txt")
        return Effect.promise(() => fs.writeFile(source, "before\n")).pipe(
          Effect.andThen(
            withTool(tmp.path, (registry) =>
              Effect.gen(function* () {
                expect(
                  yield* executeTool(
                    registry,
                    call(
                      "*** Begin Patch\n*** Add File: created.txt\n+created\n*** Update File: old.txt\n*** Move to: moved.txt\n@@\n-before\n+after\n*** End Patch",
                    ),
                  ),
                ).toMatchObject({
                  status: "completed",
                  content: [
                    { type: "text", text: "Success. Updated the following files:\nA created.txt\nM moved.txt" },
                  ],
                })
                expect(yield* exists(source)).toBe(false)
                expect(yield* Effect.promise(() => fs.readFile(path.join(tmp.path, "moved.txt"), "utf8"))).toBe(
                  "after\n",
                )
                expect(yield* Effect.promise(() => fs.readFile(path.join(tmp.path, "created.txt"), "utf8"))).toBe(
                  "created\n",
                )
              }),
            ),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("moves a file over an existing destination", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        const source = path.join(tmp.path, "old.txt")
        const destination = path.join(tmp.path, "nested", "moved.txt")
        return Effect.promise(() =>
          Promise.all([
            fs.writeFile(source, "before\n"),
            fs
              .mkdir(path.dirname(destination), { recursive: true })
              .then(() => fs.writeFile(destination, "existing\n")),
          ]),
        ).pipe(
          Effect.andThen(
            withTool(tmp.path, (registry) =>
              Effect.gen(function* () {
                expect(
                  yield* executeTool(
                    registry,
                    call(
                      "*** Begin Patch\n*** Update File: old.txt\n*** Move to: nested/moved.txt\n@@\n-before\n+after\n*** End Patch",
                    ),
                  ),
                ).toMatchObject({ status: "completed" })
                expect(yield* exists(source)).toBe(false)
                expect(yield* Effect.promise(() => fs.readFile(destination, "utf8"))).toBe("after\n")
              }),
            ),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("moves a file without changing its contents", () =>
    withTempTool((directory, registry) =>
      Effect.gen(function* () {
        const source = path.join(directory, "old.txt")
        const destination = path.join(directory, "moved.txt")
        yield* Effect.promise(() => fs.writeFile(source, "same\n"))
        expect(
          yield* executeTool(
            registry,
            call("*** Begin Patch\n*** Update File: old.txt\n*** Move to: moved.txt\n@@\n same\n*** End Patch"),
          ),
        ).toMatchObject({
          status: "completed",
          content: [{ type: "text", text: "Success. Updated the following files:\nM moved.txt" }],
        })
        expect(yield* exists(source)).toBe(false)
        expect(yield* Effect.promise(() => fs.readFile(destination, "utf8"))).toBe("same\n")
      }),
    ),
  )

  it.live("moves a symlink without deleting its target", () =>
    withTempTool((directory, registry) =>
      Effect.gen(function* () {
        if (process.platform === "win32") return
        const target = path.join(directory, "target.txt")
        const source = path.join(directory, "link.txt")
        const moved = path.join(directory, "moved.txt")
        yield* Effect.promise(() => fs.writeFile(target, "before\n"))
        yield* Effect.promise(() => fs.symlink(target, source))
        yield* executeTool(
          registry,
          call(
            "*** Begin Patch\n*** Update File: link.txt\n*** Move to: moved.txt\n@@\n-before\n+after\n*** End Patch",
          ),
        )
        expect(yield* exists(source)).toBe(false)
        expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("before\n")
        expect(yield* Effect.promise(() => fs.readFile(moved, "utf8"))).toBe("after\n")
      }),
    ),
  )

  it.live("includes move file info in output and metadata", () =>
    withTempTool((directory, registry) =>
      Effect.gen(function* () {
        const source = path.join(directory, "old", "name.txt")
        yield* Effect.promise(() => fs.mkdir(path.dirname(source), { recursive: true }))
        yield* Effect.promise(() => fs.writeFile(source, "old content\n"))
        const settled = yield* executeTool(
          registry,
          call(
            "*** Begin Patch\n*** Update File: old/name.txt\n*** Move to: renamed/dir/name.txt\n@@\n-old content\n+new content\n*** End Patch",
          ),
        )
        expect(settled.status).toBe("completed")
        if (settled.status !== "completed") return
        expect(settled.output).toMatchObject({
          applied: [{ type: "update", resource: "renamed/dir/name.txt" }],
          files: [
            {
              file: "renamed/dir/name.txt",
              status: "modified",
              patch: expect.stringContaining(`Index: ${source}`),
            },
          ],
        })
      }),
    ),
  )

  it.live("includes the move destination in edit permission resources", () =>
    withTempTool((directory, registry) =>
      Effect.gen(function* () {
        const source = path.join(directory, "old", "name.txt")
        yield* Effect.promise(() => fs.mkdir(path.dirname(source), { recursive: true }))
        yield* Effect.promise(() => fs.writeFile(source, "old content\n"))
        yield* executeTool(
          registry,
          call(
            "*** Begin Patch\n*** Update File: old/name.txt\n*** Move to: renamed/dir/name.txt\n@@\n-old content\n+new content\n*** End Patch",
          ),
        )
        expect(assertions).toMatchObject([
          {
            action: "edit",
            resources: ["old/name.txt", "renamed/dir/name.txt"],
          },
        ])
      }),
    ),
  )

  it.live("uses Location-relative resources for move targets in a nested Location", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        const active = path.join(tmp.path, "nested", "location")
        const source = path.join(active, "old.txt")
        return Effect.promise(() =>
          fs.mkdir(active, { recursive: true }).then(() => fs.writeFile(source, "before\n")),
        ).pipe(
          Effect.andThen(
            withTool(
              active,
              (registry) =>
                Effect.gen(function* () {
                  const settled = yield* executeTool(
                    registry,
                    call(
                      "*** Begin Patch\n*** Update File: old.txt\n*** Move to: moved.txt\n@@\n-before\n+after\n*** End Patch",
                    ),
                  )
                  expect(settled).toMatchObject({
                    status: "completed",
                    output: { applied: [{ resource: "moved.txt" }] },
                  })
                  expect(assertions).toMatchObject([{ action: "edit", resources: ["old.txt", "moved.txt"] }])
                }),
              tmp.path,
            ),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("inserts lines with an insert-only hunk", () =>
    withTempTool((directory, registry) =>
      Effect.gen(function* () {
        const target = path.join(directory, "insert-only.txt")
        yield* Effect.promise(() => fs.writeFile(target, "alpha\nomega\n"))
        yield* executeTool(
          registry,
          call("*** Begin Patch\n*** Update File: insert-only.txt\n@@\n alpha\n+beta\n omega\n*** End Patch"),
        )
        expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("alpha\nbeta\nomega\n")
      }),
    ),
  )

  it.live("rejects deleting a directory", () =>
    withTempTool((directory, registry) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => fs.mkdir(path.join(directory, "dir")))
        expect(
          yield* executeTool(registry, call("*** Begin Patch\n*** Delete File: dir\n*** End Patch")),
        ).toMatchObject({ status: "error" })
        expect(yield* exists(path.join(directory, "dir"))).toBe(true)
      }),
    ),
  )

  it.live("rejects a missing second chunk context", () =>
    withTempTool((directory, registry) =>
      Effect.gen(function* () {
        const target = path.join(directory, "two-chunks.txt")
        yield* Effect.promise(() => fs.writeFile(target, "a\nb\nc\nd\n"))
        expect(
          yield* executeTool(
            registry,
            call("*** Begin Patch\n*** Update File: two-chunks.txt\n@@\n-b\n+B\n\n-d\n+D\n*** End Patch"),
          ),
        ).toMatchObject({ status: "error" })
        expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("a\nb\nc\nd\n")
      }),
    ),
  )

  it.live("requires patchText", () =>
    withTempTool((_directory, registry) =>
      Effect.gen(function* () {
        expect(yield* executeTool(registry, call(""))).toEqual({
          status: "error",
          error: { type: "tool.execution", message: "patchText is required" },
        })
      }),
    ),
  )

  it.live("rejects invalid patch format", () =>
    withTempTool((_directory, registry) =>
      Effect.gen(function* () {
        expect(yield* executeTool(registry, call("invalid patch"))).toEqual({
          status: "error",
          error: {
            type: "tool.execution",
            message: "patch verification failed: The first line of the patch must be '*** Begin Patch'",
          },
        })
        expect(yield* executeTool(registry, call("*** Begin Patch\n*** Add File: foo\n+hello"))).toEqual({
          status: "error",
          error: {
            type: "tool.execution",
            message: "patch verification failed: The last line of the patch must be '*** End Patch'",
          },
        })
      }),
    ),
  )

  it.live("rejects an empty patch", () =>
    withTempTool((_directory, registry) =>
      Effect.gen(function* () {
        for (const patchText of [
          "*** Begin Patch\n*** End Patch",
          " *** Begin Patch \n *** End Patch ",
          "<<EOF\n*** Begin Patch\n*** End Patch\nEOF",
          "*** Begin Patch\n*** Environment ID: remote\n*** End Patch",
        ]) {
          expect(yield* executeTool(registry, call(patchText))).toEqual({
            status: "error",
            error: { type: "tool.execution", message: "patch rejected: empty patch" },
          })
        }
      }),
    ),
  )

  it.live("rejects an invalid hunk header", () =>
    withTempTool((_directory, registry) =>
      Effect.gen(function* () {
        expect(yield* executeTool(registry, call("*** Begin Patch\n*** Frobnicate File: foo\n*** End Patch"))).toEqual({
          status: "error",
          error: {
            type: "tool.execution",
            message:
              "patch verification failed: Invalid hunk at line 2: '*** Frobnicate File: foo' is not a valid hunk header. Valid hunk headers: '*** Add File: {path}', '*** Delete File: {path}', '*** Update File: {path}'",
          },
        })
      }),
    ),
  )

  it.live("applies successive update operations to one file", () =>
    withTempTool((directory, registry) =>
      Effect.gen(function* () {
        const target = path.join(directory, "successive.txt")
        yield* Effect.promise(() => fs.writeFile(target, "a\nb\n"))
        yield* executeTool(
          registry,
          call(
            "*** Begin Patch\n*** Update File: successive.txt\n@@\n-a\n+A\n*** Update File: successive.txt\n@@\n-b\n+B\n*** End Patch",
          ),
        )
        expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("A\nB\n")
      }),
    ),
  )

  it.live("does not invent a first-line diff for BOM files", () =>
    withTempTool((directory, registry) =>
      Effect.gen(function* () {
        const bom = "\uFEFF"
        const target = path.join(directory, "example.cs")
        yield* Effect.promise(() => fs.writeFile(target, `${bom}using System;\n\nclass Test {}\n`))
        formatFile = (file) =>
          Effect.promise(async () => {
            await fs.writeFile(file, (await fs.readFile(file, "utf8")).replace(/^\uFEFF/, ""))
            return true
          })
        const settled = yield* executeTool(
          registry,
          call("*** Begin Patch\n*** Update File: example.cs\n@@\n class Test {}\n+class Next {}\n*** End Patch"),
        )
        expect(settled.status).toBe("completed")
        if (settled.status !== "completed") return
        const output = Schema.decodeUnknownSync(PatchTool.Output)(settled.output)
        expect(output.files[0]?.patch).not.toContain(bom)
        expect(output.files[0]?.patch).not.toContain("-using System;")
        expect(output.files[0]?.patch).not.toContain("+using System;")
        expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe(
          `${bom}using System;\n\nclass Test {}\nclass Next {}\n`,
        )
      }),
    ),
  )

  it.live("rejects an update with missing context", () =>
    withTempTool((directory, registry) =>
      Effect.gen(function* () {
        const target = path.join(directory, "unchanged.txt")
        yield* Effect.promise(() => fs.writeFile(target, "line1\nline2\n"))
        expect(
          yield* executeTool(
            registry,
            call("*** Begin Patch\n*** Update File: unchanged.txt\n@@\n-missing\n+changed\n*** End Patch"),
          ),
        ).toMatchObject({
          status: "error",
          error: {
            type: "tool.execution",
            message: "patch verification failed: Failed to find expected lines in unchanged.txt:\nmissing",
          },
        })
        expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("line1\nline2\n")
      }),
    ),
  )

  it.live("rejects an update when the target file is missing", () =>
    withTempTool((directory, registry) =>
      Effect.gen(function* () {
        expect(
          yield* executeTool(
            registry,
            call("*** Begin Patch\n*** Update File: missing.txt\n@@\n-old\n+new\n*** End Patch"),
          ),
        ).toMatchObject({
          status: "error",
          error: {
            message: expect.stringContaining(
              `patch verification failed: Failed to read file to update ${path.join(directory, "missing.txt")}: `,
            ),
          },
        })
      }),
    ),
  )

  it.live("identifies a directory used as an update target", () =>
    withTempTool((directory, registry) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => fs.mkdir(path.join(directory, "nested")))
        expect(
          yield* executeTool(registry, call("*** Begin Patch\n*** Update File: nested\n@@\n-old\n+new\n*** End Patch")),
        ).toEqual({
          status: "error",
          error: {
            type: "tool.execution",
            message: `patch verification failed: Failed to read file to update ${path.join(directory, "nested")}: path is a directory`,
          },
        })
      }),
    ),
  )

  it.live("identifies a missing delete target", () =>
    withTempTool((_directory, registry) =>
      Effect.gen(function* () {
        expect(
          yield* executeTool(registry, call("*** Begin Patch\n*** Delete File: missing.txt\n*** End Patch")),
        ).toEqual({
          status: "error",
          error: {
            type: "tool.execution",
            message: "patch verification failed: Failed to delete missing.txt: file does not exist",
          },
        })
      }),
    ),
  )

  it.live("reports the failing destination and filesystem error", () =>
    withTempTool((directory, registry) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => fs.writeFile(path.join(directory, "old.txt"), "before\n"))
        failWriteTarget = "new.txt"
        expect(
          yield* executeTool(
            registry,
            call("*** Begin Patch\n*** Update File: old.txt\n*** Move to: new.txt\n@@\n-before\n+after\n*** End Patch"),
          ),
        ).toEqual({
          status: "error",
          error: { type: "tool.execution", message: "Failed to write new.txt: forced write failure" },
        })
        expect(yield* Effect.promise(() => fs.readFile(path.join(directory, "old.txt"), "utf8"))).toBe("before\n")
        expect(yield* exists(path.join(directory, "new.txt"))).toBe(false)
      }),
    ),
  )

  it.live("reports the successful prefix and filesystem error", () =>
    withTempTool((directory, registry) =>
      Effect.gen(function* () {
        failWriteTarget = "second.txt"
        expect(
          yield* executeTool(
            registry,
            call("*** Begin Patch\n*** Add File: first.txt\n+first\n*** Add File: second.txt\n+second\n*** End Patch"),
          ),
        ).toEqual({
          status: "error",
          error: {
            type: "tool.execution",
            message: "Failed to write second.txt: forced write failure. Completed before failure: first.txt",
          },
        })
        expect(yield* Effect.promise(() => fs.readFile(path.join(directory, "first.txt"), "utf8"))).toBe("first\n")
        expect(yield* exists(path.join(directory, "second.txt"))).toBe(false)
      }),
    ),
  )

  it.live("reports a destination written before move removal fails", () =>
    withTempTool((directory, registry) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => fs.writeFile(path.join(directory, "old.txt"), "before\n"))
        failRemoveErrorTarget = "old.txt"
        expect(
          yield* executeTool(
            registry,
            call("*** Begin Patch\n*** Update File: old.txt\n*** Move to: new.txt\n@@\n-before\n+after\n*** End Patch"),
          ),
        ).toEqual({
          status: "error",
          error: {
            type: "tool.execution",
            message: "Wrote new.txt but failed to remove old.txt: forced remove failure",
          },
        })
        expect(yield* Effect.promise(() => fs.readFile(path.join(directory, "old.txt"), "utf8"))).toBe("before\n")
        expect(yield* Effect.promise(() => fs.readFile(path.join(directory, "new.txt"), "utf8"))).toBe("after\n")
      }),
    ),
  )

  it.live("approves an external directory before reading and requests edit permission afterward", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => Promise.all([tmpdir(), tmpdir()])),
      ([active, outside]) => {
        reset()
        const repository = path.join(outside.path, "repository")
        const directory = path.join(repository, "nested")
        const target = path.join(directory, "external.txt")
        return Effect.promise(() =>
          Promise.all([
            fs.mkdir(path.join(repository, ".git"), { recursive: true }),
            fs.mkdir(directory, { recursive: true }).then(() => fs.writeFile(target, "before\n")),
          ]),
        ).pipe(
          Effect.andThen(
            withTool(active.path, (registry) =>
              Effect.gen(function* () {
                expect(
                  yield* executeTool(
                    registry,
                    call(`*** Begin Patch\n*** Update File: ${target}\n@@\n-before\n+after\n*** End Patch`),
                  ),
                ).toMatchObject({ status: "completed" })
                expect(assertions.map((input) => input.action)).toEqual(["external_directory", "edit"])
                expect(assertions[0]).toMatchObject({
                  resources: [path.join(directory, "*").replaceAll("\\", "/")],
                  save: [path.join(repository, "*").replaceAll("\\", "/")],
                  metadata: {
                    filepath: target,
                    parentDir: directory,
                  },
                })
                expect(assertions[1]?.resources).toEqual([target.replaceAll("\\", "/")])
                expect(readsBeforeEditApproval).toBe(1)
                expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("after\n")
              }),
            ),
          ),
        )
      },
      ([active, outside]) =>
        Effect.promise(() =>
          Promise.all([active[Symbol.asyncDispose](), outside[Symbol.asyncDispose]()]).then(() => undefined),
        ),
    ),
  )

  it.live("does not inspect an external file when external permission is denied", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => Promise.all([tmpdir(), tmpdir()])),
      ([active, outside]) => {
        reset()
        denyAction = "external_directory"
        const target = path.join(outside.path, "external.txt")
        return Effect.promise(() => fs.writeFile(target, "before\n")).pipe(
          Effect.andThen(
            withTool(
              active.path,
              (registry) =>
                Effect.gen(function* () {
                  expect(
                    yield* executeTool(
                      registry,
                      call(`*** Begin Patch\n*** Update File: ${target}\n@@\n-before\n+after\n*** End Patch`),
                    ),
                  ).toMatchObject({ status: "error", error: { type: "permission.rejected" } })
                  expect(assertions.map((input) => input.action)).toEqual(["external_directory"])
                  expect(readsBeforeEditApproval).toBe(0)
                  expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("before\n")
                }),
              path.parse(active.path).root,
            ),
          ),
        )
      },
      ([active, outside]) =>
        Effect.promise(() =>
          Promise.all([active[Symbol.asyncDispose](), outside[Symbol.asyncDispose]()]).then(() => undefined),
        ),
    ),
  )

  it.live("preserves edit permission rejection", () =>
    withTempTool((directory, registry) =>
      Effect.gen(function* () {
        const target = path.join(directory, "target.txt")
        yield* Effect.promise(() => fs.writeFile(target, "before\n"))
        denyAction = "edit"
        expect(
          yield* executeTool(
            registry,
            call("*** Begin Patch\n*** Update File: target.txt\n@@\n-before\n+after\n*** End Patch"),
          ),
        ).toMatchObject({ status: "error", error: { type: "permission.rejected" } })
        expect(assertions.map((input) => input.action)).toEqual(["edit"])
        expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("before\n")
      }),
    ),
  )

  it.live("treats a sibling path inside the project worktree as internal", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        const active = path.join(tmp.path, "active")
        const target = path.join(tmp.path, "sibling.txt")
        return Effect.promise(() => Promise.all([fs.mkdir(active), fs.writeFile(target, "before\n")])).pipe(
          Effect.andThen(
            withTool(
              active,
              (registry) =>
                Effect.gen(function* () {
                  expect(
                    yield* executeTool(
                      registry,
                      call("*** Begin Patch\n*** Update File: ../sibling.txt\n@@\n-before\n+after\n*** End Patch"),
                    ),
                  ).toMatchObject({ status: "completed" })
                  expect(assertions.map((input) => input.action)).toEqual(["edit"])
                  expect(assertions[0]?.resources).toEqual(["../sibling.txt"])
                  expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("after\n")
                }),
              tmp.path,
            ),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("follows an internal symlink to an external file without external permission", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => Promise.all([tmpdir(), tmpdir()])),
      ([active, outside]) => {
        reset()
        if (process.platform === "win32") return Effect.void
        const target = path.join(outside.path, "external.txt")
        const link = path.join(active.path, "link.txt")
        return Effect.promise(() => fs.writeFile(target, "before\n")).pipe(
          Effect.andThen(Effect.promise(() => fs.symlink(target, link))),
          Effect.andThen(
            withTool(active.path, (registry) =>
              Effect.gen(function* () {
                expect(
                  yield* executeTool(
                    registry,
                    call("*** Begin Patch\n*** Update File: link.txt\n@@\n-before\n+after\n*** End Patch"),
                  ),
                ).toMatchObject({ status: "completed" })
                expect(assertions.map((input) => input.action)).toEqual(["edit"])
                expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("after\n")
              }),
            ),
          ),
        )
      },
      ([active, outside]) =>
        Effect.promise(() =>
          Promise.all([active[Symbol.asyncDispose](), outside[Symbol.asyncDispose]()]).then(() => undefined),
        ),
    ),
  )

  it.live("approves a relative external target before reading and requests edit permission afterward", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => Promise.all([tmpdir(), tmpdir()])),
      ([active, outside]) => {
        reset()
        const target = path.join(outside.path, "external.txt")
        const relative = path.relative(active.path, target)
        return Effect.promise(() => fs.writeFile(target, "before\n")).pipe(
          Effect.andThen(
            withTool(active.path, (registry) =>
              Effect.gen(function* () {
                expect(
                  yield* executeTool(
                    registry,
                    call(`*** Begin Patch\n*** Update File: ${relative}\n@@\n-before\n+after\n*** End Patch`),
                  ),
                ).toMatchObject({ status: "completed" })
                expect(assertions.map((input) => input.action)).toEqual(["external_directory", "edit"])
                expect(readsBeforeEditApproval).toBe(1)
                expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("after\n")
              }),
            ),
          ),
        )
      },
      ([active, outside]) =>
        Effect.promise(() =>
          Promise.all([active[Symbol.asyncDispose](), outside[Symbol.asyncDispose]()]).then(() => undefined),
        ),
    ),
  )

  it.live("uses canonical external permissions and resources for a move destination", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => Promise.all([tmpdir(), tmpdir()])),
      ([active, outside]) => {
        reset()
        const source = path.join(active.path, "source.txt")
        const destination = path.join(outside.path, "moved.txt")
        return Effect.promise(() => fs.writeFile(source, "before\n")).pipe(
          Effect.andThen(
            withTool(active.path, (registry) =>
              Effect.gen(function* () {
                const settled = yield* executeTool(
                  registry,
                  call(
                    `*** Begin Patch\n*** Update File: source.txt\n*** Move to: ${destination}\n@@\n-before\n+after\n*** End Patch`,
                  ),
                )
                expect(settled).toMatchObject({
                  status: "completed",
                  output: { applied: [{ resource: destination.replaceAll("\\", "/") }] },
                })
                expect(assertions).toMatchObject([
                  {
                    action: "external_directory",
                    resources: [path.join(outside.path, "*").replaceAll("\\", "/")],
                    save: [path.join(outside.path, "*").replaceAll("\\", "/")],
                    metadata: { filepath: destination, parentDir: outside.path },
                  },
                  {
                    action: "edit",
                    resources: ["source.txt", destination.replaceAll("\\", "/")],
                  },
                ])
                expect(yield* exists(source)).toBe(false)
                expect(yield* Effect.promise(() => fs.readFile(destination, "utf8"))).toBe("after\n")
              }),
            ),
          ),
        )
      },
      ([active, outside]) =>
        Effect.promise(() =>
          Promise.all([active[Symbol.asyncDispose](), outside[Symbol.asyncDispose]()]).then(() => undefined),
        ),
    ),
  )

  it.live("approves each external file under the same parent", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => Promise.all([tmpdir(), tmpdir()])),
      ([active, outside]) => {
        reset()
        const first = path.join(outside.path, "first.txt")
        const second = path.join(outside.path, "second.txt")
        return Effect.promise(() =>
          Promise.all([fs.writeFile(first, "before\n"), fs.writeFile(second, "before\n")]),
        ).pipe(
          Effect.andThen(
            withTool(active.path, (registry) =>
              Effect.gen(function* () {
                expect(
                  yield* executeTool(
                    registry,
                    call(
                      `*** Begin Patch\n*** Update File: ${first}\n@@\n-before\n+after\n*** Update File: ${second}\n@@\n-before\n+after\n*** End Patch`,
                    ),
                  ),
                ).toMatchObject({ status: "completed" })
                expect(assertions.map((input) => input.action)).toEqual([
                  "external_directory",
                  "external_directory",
                  "edit",
                ])
                expect(assertions[0]?.resources).toEqual([
                  path.join(yield* Effect.promise(() => fs.realpath(outside.path)), "*").replaceAll("\\", "/"),
                ])
                expect(assertions[1]?.resources).toEqual(assertions[0]?.resources)
              }),
            ),
          ),
        )
      },
      ([active, outside]) =>
        Effect.promise(() =>
          Promise.all([active[Symbol.asyncDispose](), outside[Symbol.asyncDispose]()]).then(() => undefined),
        ),
    ),
  )

  it.live("rejects invalid later update before applying an earlier add", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        return withTool(tmp.path, (registry) =>
          Effect.gen(function* () {
            expect(
              yield* executeTool(
                registry,
                call(
                  "*** Begin Patch\n*** Add File: created.txt\n+created\n*** Update File: missing.txt\n@@\n-before\n+after\n*** End Patch",
                ),
              ),
            ).toMatchObject({
              status: "error",
              error: {
                message: expect.stringContaining("patch verification failed: Failed to read file to update"),
              },
            })
            expect(yield* exists(path.join(tmp.path, "created.txt"))).toBe(false)
          }),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("adds files by overwriting existing targets", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        const target = path.join(tmp.path, "existing.txt")
        return Effect.promise(() => fs.writeFile(target, "sentinel\n")).pipe(
          Effect.andThen(
            withTool(tmp.path, (registry) =>
              Effect.gen(function* () {
                expect(
                  yield* executeTool(
                    registry,
                    call("*** Begin Patch\n*** Add File: existing.txt\n+replacement\n*** End Patch"),
                  ),
                ).toMatchObject({ status: "completed" })
                expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("replacement\n")
              }),
            ),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("overwrites an add target that appears during permission approval", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        const target = path.join(tmp.path, "appeared.txt")
        afterEditApproval = () => Effect.promise(() => fs.writeFile(target, "winner\n")).pipe(Effect.orDie)
        return withTool(tmp.path, (registry) =>
          Effect.gen(function* () {
            expect(
              yield* executeTool(
                registry,
                call("*** Begin Patch\n*** Add File: appeared.txt\n+replacement\n*** End Patch"),
              ),
            ).toMatchObject({ status: "completed" })
            expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("replacement\n")
          }),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("preserves a later commit defect after earlier sequential applications", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        const first = path.join(tmp.path, "first.txt")
        const second = path.join(tmp.path, "second.txt")
        failRemoveTarget = path.basename(second)
        return Effect.promise(() => Promise.all([fs.writeFile(first, "first"), fs.writeFile(second, "second")])).pipe(
          Effect.andThen(
            withTool(tmp.path, (registry) =>
              Effect.gen(function* () {
                expect(
                  Exit.isFailure(
                    yield* executeTool(
                      registry,
                      call("*** Begin Patch\n*** Delete File: first.txt\n*** Delete File: second.txt\n*** End Patch"),
                    ).pipe(Effect.exit),
                  ),
                ).toBe(true)
                expect(yield* exists(first)).toBe(false)
                expect(yield* exists(second)).toBe(true)
              }),
            ),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )
})
