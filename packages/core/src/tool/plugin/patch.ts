export * as PatchTool from "./patch.js"

import type { Context } from "@opencode/plugin/effect/plugin"
import type { SessionHooks } from "@opencode/plugin/effect/session"
import { ToolFailure } from "@opencode/ai"
import { FileDiff } from "@opencode/schema/file-diff"
import { Effect, Result, Schema } from "effect"
import { Bom } from "@opencode/util/bom"
import { Environment } from "../../environment/index.js"
import { Formatter } from "../../formatter.js"
import { FileMutation } from "../../file-mutation.js"
import { Location } from "../../location.js"
import { FileAccess } from "../../file-access.js"
import { Patch } from "@opencode/util/patch"
import { Permission } from "../../permission.js"
import DESCRIPTION from "../patch.txt"
import { fileDiff } from "./file-diff.js"

export const name = "patch"

export const Input = Schema.Struct({
  patchText: Schema.String.annotate({
    description: "The full patch text describing add, update, and delete operations",
  }),
})

export const Applied = Schema.Struct({
  type: Schema.Literals(["add", "update", "delete"]),
  resource: Schema.String,
  target: Schema.String,
})

export const Output = Schema.Struct({
  applied: Schema.Array(Applied),
  files: Schema.Array(FileDiff.Info),
})
export type Output = typeof Output.Type

export const toModelContent = (output: Output) =>
  [
    "Success. Updated the following files:",
    ...output.applied.map(
      (item) => `${item.type === "add" ? "A" : item.type === "delete" ? "D" : "M"} ${item.resource}`,
    ),
  ].join("\n")

type Prepared =
  | (Extract<Patch.Hunk, { readonly type: "add" }> & {
      readonly target: FileAccess.Target
      readonly content: string
      readonly before: string
      readonly after: string
    })
  | (Extract<Patch.Hunk, { readonly type: "delete" }> & {
      readonly target: FileAccess.Target
      readonly before: string
      readonly after: string
    })
  | (Extract<Patch.Hunk, { readonly type: "update" }> & {
      readonly target: FileAccess.Target
      readonly content: string
      readonly before: string
      readonly after: string
      readonly moveTarget?: FileAccess.Target
    })

export const Plugin = {
  id: "opencode.tool.patch",
  effect: Effect.fn("PatchTool.Plugin")(function* (ctx: Context) {
    const environment = yield* Environment.Service
    const access = yield* FileAccess.Service
    const fileMutation = yield* FileMutation.Service
    const formatter = yield* Formatter.Service
    const location = yield* Location.Service
    const permission = yield* Permission.Service

    yield* ctx.tool
      .transform((editor) =>
        editor.add({
          name,
          options: { codemode: false, permission: "edit" },
          description: DESCRIPTION,
          input: Input,
          output: Output,
          execute: (input, context) => {
            const applied: Array<typeof Applied.Type> = []
            const parsed = Patch.parse(input.patchText)
            const lockTargets = Result.isSuccess(parsed)
              ? parsed.success.flatMap((hunk) => [
                  FileAccess.resolvePath(location.directory, hunk.path),
                  ...(hunk.type === "update" && hunk.movePath
                    ? [FileAccess.resolvePath(location.directory, hunk.movePath)]
                    : []),
                ])
              : []
            const fail = (operation: string, error: unknown) => {
              const completed = applied.map((item) => item.resource).join(", ")
              return new ToolFailure({
                message: `${operation}: ${errorMessage(error)}${completed ? `. Completed before failure: ${completed}` : ""}`,
              })
            }
            return Effect.gen(function* () {
              const source = {
                type: "tool" as const,
                messageID: context.messageID,
                id: context.id,
              }
              if (!input.patchText) return yield* new ToolFailure({ message: "patchText is required" })
              const hunks = yield* Effect.fromResult(parsed).pipe(
                Effect.mapError((error) => new ToolFailure({ message: `patch verification failed: ${error.message}` })),
              )
              if (hunks.length === 0) {
                return yield* new ToolFailure({ message: "patch rejected: empty patch" })
              }
              const prepared: Prepared[] = []
              const updates = new Map<string, string>()
              const resolveTarget = Effect.fnUntraced(function* (value: string) {
                const target = yield* access.resolve({ path: value, kind: "file" })
                if (!target.externalDirectory) return target
                yield* access.authorizeExternal([target], context, {
                  filepath: target.absolute,
                  parentDir: target.externalDirectory.directory,
                })
                return target
              })
              for (const hunk of hunks) {
                yield* Effect.gen(function* () {
                  const target = yield* resolveTarget(hunk.path)
                  if (hunk.type === "add") {
                    const content =
                      hunk.contents.endsWith("\n") || hunk.contents === "" ? hunk.contents : `${hunk.contents}\n`
                    prepared.push({
                      ...hunk,
                      target,
                      content,
                      before: "",
                      after: Bom.split(content).text,
                    })
                    return
                  }
                  if (hunk.type === "delete") {
                    const content = yield* FileMutation.readText(environment.files, target.absolute).pipe(
                      Effect.mapError(
                        (error) =>
                          new ToolFailure({
                            message: `patch verification failed: Failed to delete ${target.resource}: ${errorMessage(error)}`,
                          }),
                      ),
                    )
                    prepared.push({ ...hunk, target, before: content.text, after: "" })
                    return
                  }
                  const previous = updates.get(target.absolute)
                  const original =
                    previous ??
                    (yield* Effect.gen(function* () {
                      const content = yield* FileMutation.readText(environment.files, target.absolute).pipe(
                        Effect.mapError(
                          (error) =>
                            new ToolFailure({
                              message: `patch verification failed: Failed to read file to update ${target.absolute}: ${errorMessage(error)}`,
                            }),
                        ),
                      )
                      return Bom.join(content.text, content.bom)
                    }))
                  const before = Bom.split(original).text
                  const update = yield* Effect.try({
                    try: () => Patch.derive(hunk.path, hunk.chunks, original),
                    catch: (error) => new ToolFailure({ message: `patch verification failed: ${errorMessage(error)}` }),
                  })
                  const moveTarget = hunk.movePath ? yield* resolveTarget(hunk.movePath) : undefined
                  prepared.push({
                    ...hunk,
                    target,
                    content: Patch.joinBom(update.content, update.bom),
                    before,
                    after: update.content,
                    moveTarget,
                  })
                  if (!moveTarget) updates.set(target.absolute, Patch.joinBom(update.content, update.bom))
                }).pipe(
                  Effect.mapError((error) =>
                    error instanceof ToolFailure
                      ? error
                      : new ToolFailure({ message: `Unable to prepare patch at ${hunk.path}`, error }),
                  ),
                )
              }

              const patchFiles = prepared.map((change) => patchFile(change))
              const targets = prepared.flatMap((change) => [
                change.target,
                ...(change.type === "update" && change.moveTarget ? [change.moveTarget] : []),
              ])
              yield* permission.assert({
                action: "edit",
                resources: [...new Set(targets.map((target) => target.resource))],
                save: ["*"],
                metadata: {
                  filepath: targets.map((target) => target.resource).join(", "),
                  diff: patchFiles.map((file) => `${file.patch}\n`).join(""),
                  files: patchFiles,
                },
                sessionID: context.sessionID,
                agent: context.agent,
                source,
              })

              yield* Effect.forEach(
                prepared,
                (change) =>
                  Effect.gen(function* () {
                    if (change.type === "delete") {
                      yield* environment.files
                        .remove(change.target.absolute)
                        .pipe(Effect.mapError((error) => fail(`Failed to delete ${change.target.resource}`, error)))
                      applied.push({
                        type: change.type,
                        resource: change.target.resource,
                        target: change.target.absolute,
                      })
                      return
                    }
                    if (change.type === "update" && change.moveTarget) {
                      const moveTarget = change.moveTarget
                      yield* environment.files
                        .write(moveTarget.absolute, new TextEncoder().encode(change.content))
                        .pipe(Effect.mapError((error) => fail(`Failed to write ${moveTarget.resource}`, error)))
                      yield* environment.files
                        .remove(change.target.absolute)
                        .pipe(
                          Effect.mapError((error) =>
                            fail(`Wrote ${moveTarget.resource} but failed to remove ${change.target.resource}`, error),
                          ),
                        )
                      applied.push({
                        type: change.type,
                        resource: change.moveTarget.resource,
                        target: change.moveTarget.absolute,
                      })
                      return
                    }
                    yield* environment.files
                      .write(change.target.absolute, new TextEncoder().encode(change.content))
                      .pipe(Effect.mapError((error) => fail(`Failed to write ${change.target.resource}`, error)))
                    applied.push({
                      type: change.type,
                      resource: change.target.resource,
                      target: change.target.absolute,
                    })
                  }),
                { discard: true },
              )
              const formatted = new Map<string, string>()
              yield* Effect.forEach(
                [...new Set(applied.filter((item) => item.type !== "delete").map((item) => item.target))],
                (target) =>
                  Effect.gen(function* () {
                    const current = yield* FileMutation.readText(environment.files, target).pipe(
                      Effect.mapError((error) => fail(`Failed to read ${target}`, error)),
                    )
                    formatted.set(
                      target,
                      (yield* formatter.file(target))
                        ? yield* FileMutation.syncTextBom(environment.files, target, current.bom).pipe(
                            Effect.mapError((error) => fail(`Failed to sync ${target}`, error)),
                          )
                        : current.text,
                    )
                  }),
                { discard: true },
              )
              const files = prepared.map((change) => {
                if (change.type === "delete") return patchFile(change)
                const target = change.type === "update" && change.moveTarget ? change.moveTarget : change.target
                return patchFile(change, formatted.get(target.absolute))
              })
              return { applied, files }
            }).pipe(
              fileMutation.withLock(lockTargets),
              Effect.map((output) => ({
                output,
                content: toModelContent(output),
                metadata: { files: output.files },
              })),
              Effect.mapError((error) =>
                error instanceof ToolFailure ? error : new ToolFailure({ message: "Unable to apply patch", error }),
              ),
            )
          },
        }),
      )
      .pipe(Effect.orDie)

    const hook = (event: SessionHooks["context"]) =>
      Effect.sync(() => {
        const usePatch =
          event.model.id.includes("gpt-") && !event.model.id.includes("oss") && !event.model.id.includes("gpt-4")
        if (usePatch) {
          delete event.tools.edit
          delete event.tools.write
          return
        }
        delete event.tools.patch
      })
    yield* ctx.session.hook("context", hook)
    yield* ctx.session.hook("compaction", hook)
    yield* ctx.session.hook("generate", hook)
  }),
}

function errorMessage(error: unknown) {
  if (error instanceof Environment.NotFound) return "file does not exist"
  if (error instanceof Environment.WrongKind)
    return error.actual === "directory" ? "path is a directory" : `path is ${error.actual}`
  if (error instanceof Environment.Failed) return errorMessage(error.cause)
  return error instanceof Error ? error.message : String(error)
}

function patchFile(change: Prepared, after = change.after): typeof FileDiff.Info.Type {
  const target = (change.type === "update" ? change.moveTarget : undefined)?.resource ?? change.target.resource
  const diff = fileDiff(
    change.target.absolute,
    change.before,
    after,
    change.type === "add" ? "added" : change.type === "delete" ? "deleted" : "modified",
  )
  return {
    ...diff,
    file: target,
    patch: trimDiff(diff.patch),
  }
}

function trimDiff(diff: string) {
  const lines = diff.split("\n")
  const content = lines.filter(
    (line) =>
      (line.startsWith("+") || line.startsWith("-") || line.startsWith(" ")) &&
      !line.startsWith("---") &&
      !line.startsWith("+++"),
  )
  if (content.length === 0) return diff
  const indent = content.reduce((result, line) => {
    const value = line.slice(1)
    if (value.trim().length === 0) return result
    return Math.min(result, value.match(/^(\s*)/)?.[1].length ?? result)
  }, Infinity)
  if (indent === Infinity || indent === 0) return diff
  return lines
    .map((line) => {
      if (
        (line.startsWith("+") || line.startsWith("-") || line.startsWith(" ")) &&
        !line.startsWith("---") &&
        !line.startsWith("+++")
      ) {
        return line[0] + line.slice(1 + indent)
      }
      return line
    })
    .join("\n")
}
