import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Agent } from "../src/agent"
import { FileSystem } from "../src/filesystem"
import { Model } from "../src/model"
import { Project } from "../src/project"
import { Pty } from "../src/pty"
import { Question } from "../src/question"
import { Session } from "../src/session"
import { SessionCompaction } from "../src/session-compaction"
import { SessionEvent } from "../src/session-event"
import { SessionTodo } from "../src/session-todo"
import { optional } from "../src/schema"

describe("contract hygiene", () => {
  test("optional properties preserve transformations and omit undefined while encoding", () => {
    const Value = Schema.Struct({ value: optional(Schema.FiniteFromString) })
    expect(Schema.decodeUnknownSync(Value)({ value: "1" })).toEqual({ value: 1 })
    expect(Schema.encodeSync(Value)({ value: 1 })).toEqual({ value: "1" })
    expect(Schema.encodeSync(Value)({ value: undefined })).toEqual({})
  })

  test("compaction diagnostics use closed modes and omit unavailable diagnostics", () => {
    expect(
      Schema.encodeSync(SessionCompaction.Diagnostics)({
        requested: "suffix",
        used: "prepend",
        fallback: undefined,
        durationMs: 1,
        tokens: undefined,
      }),
    ).toEqual({ requested: "suffix", used: "prepend", durationMs: 1 })
    expect(() =>
      Schema.decodeUnknownSync(SessionCompaction.Diagnostics)({ requested: "other", used: "prepend", durationMs: 1 }),
    ).toThrow()
  })

  test("compaction token diagnostics omit unknown usage and reject invalid counts", () => {
    expect(Schema.encodeSync(SessionCompaction.Tokens)({ input: 0, cached: undefined, output: undefined })).toEqual({
      input: 0,
    })
    expect(Schema.decodeUnknownSync(SessionCompaction.Tokens)({})).toEqual({})
    expect(() => Schema.decodeUnknownSync(SessionCompaction.Tokens)({ input: -1 })).toThrow()
    expect(() => Schema.decodeUnknownSync(SessionCompaction.Tokens)({ output: Number.NaN })).toThrow()
  })

  test("todo status and priority preserve arbitrary strings", () => {
    const decode = Schema.decodeUnknownSync(SessionTodo.Info)
    expect(decode({ content: "ship", status: "waiting", priority: "urgent" })).toEqual({
      content: "ship",
      status: "waiting",
      priority: "urgent",
    })
  })

  test("current ID constructors expose create", () => {
    expect(Question.ID.create()).toStartWith("que_")
    expect(Pty.ID.create()).toStartWith("pty_")
  })

  test("reusable public identifiers are stable and unique", () => {
    const identifiers = [
      Agent.Color,
      FileSystem.Submatch,
      Model.Ref,
      Model.Capabilities,
      Model.Cost,
      Model.Api,
      Project.Icon,
      Project.Commands,
      Project.Time,
      Project.Info,
      Pty.Info,
      Session.ListAnchor,
    ].map((schema) => schema.ast.annotations?.identifier)

    expect(identifiers.every((identifier) => typeof identifier === "string")).toBe(true)
    expect(new Set(identifiers).size).toBe(identifiers.length)
  })

  test("current source avoids Any and mutable contract wrappers", async () => {
    const files = [...new Bun.Glob("*.ts").scanSync(new URL("../src", import.meta.url).pathname)].filter(
      (file) => !file.endsWith("-v1.ts"),
    )
    const source = await Promise.all(
      files.map((file) => Bun.file(new URL(`../src/${file}`, import.meta.url)).text()),
    ).then((values) => values.join("\n"))

    expect(source).not.toContain("Schema.Any")
    expect(source).not.toContain("Schema.mutable")
  })
})
