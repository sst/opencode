import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { Effect } from "effect"
import { Auth } from "../../src/auth"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(Auth.node))

describe("Auth", () => {
  it.instance("set normalizes trailing slashes in keys", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      yield* auth.set("https://example.com/", {
        type: "wellknown",
        key: "TOKEN",
        token: "abc",
      })
      const data = yield* auth.all()
      expect(data["https://example.com"]).toBeDefined()
      expect(data["https://example.com/"]).toBeUndefined()
    }),
  )

  it.instance("set reads the file instead of persisting the auth env snapshot", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      const file = path.join(Global.Path.data, "auth.json")
      const previous = process.env.OPENCODE_AUTH_CONTENT
      const omitted = "omitted-provider"

      try {
        yield* Effect.promise(() => fs.writeFile(file, JSON.stringify({ [omitted]: { type: "api", key: "sk-omitted" } })))
        process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({ "snapshot-provider": { type: "api", key: "sk-snapshot" } })

        yield* auth.set("written-provider", { type: "api", key: "sk-written" })

        const onDisk = JSON.parse(yield* Effect.promise(() => fs.readFile(file, "utf8"))) as Record<string, unknown>
        expect(onDisk[omitted]).toEqual({ type: "api", key: "sk-omitted" })
        expect(onDisk["written-provider"]).toEqual({ type: "api", key: "sk-written" })
      } finally {
        if (previous === undefined) delete process.env.OPENCODE_AUTH_CONTENT
        else process.env.OPENCODE_AUTH_CONTENT = previous
      }
    }),
  )

  it.instance("preserves both providers from concurrent writes", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      const file = path.join(Global.Path.data, "auth.json")

      yield* Effect.promise(() => fs.writeFile(file, JSON.stringify({ existing: { type: "api", key: "sk-existing" } })))
      yield* Effect.all(
        [
          auth.set("concurrent-a", { type: "api", key: "sk-a" }),
          auth.set("concurrent-b", { type: "api", key: "sk-b" }),
        ],
        { concurrency: "unbounded" },
      )

      const onDisk = JSON.parse(yield* Effect.promise(() => fs.readFile(file, "utf8"))) as Record<string, unknown>
      expect(onDisk.existing).toEqual({ type: "api", key: "sk-existing" })
      expect(onDisk["concurrent-a"]).toEqual({ type: "api", key: "sk-a" })
      expect(onDisk["concurrent-b"]).toEqual({ type: "api", key: "sk-b" })
    }),
  )

  it.instance("writes auth.json atomically with mode 0600 and no temporary file", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      const file = path.join(Global.Path.data, "auth.json")
      const before = yield* Effect.promise(() => fs.readdir(Global.Path.data))

      yield* auth.set("atomic-provider", { type: "api", key: "sk-atomic" })

      const stats = yield* Effect.promise(() => fs.stat(file))
      const after = yield* Effect.promise(() => fs.readdir(Global.Path.data))
      expect(stats.mode & 0o777).toBe(0o600)
      expect(after.filter((entry) => /^auth\.json\.\d+\..+\.tmp$/.test(entry))).toEqual(
        before.filter((entry) => /^auth\.json\.\d+\..+\.tmp$/.test(entry)),
      )
    }),
  )

  it.instance("set cleans up pre-existing trailing-slash entry", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      yield* auth.set("https://example.com/", {
        type: "wellknown",
        key: "TOKEN",
        token: "old",
      })
      yield* auth.set("https://example.com", {
        type: "wellknown",
        key: "TOKEN",
        token: "new",
      })
      const data = yield* auth.all()
      const keys = Object.keys(data).filter((key) => key.includes("example.com"))
      expect(keys).toEqual(["https://example.com"])
      const entry = data["https://example.com"]!
      expect(entry.type).toBe("wellknown")
      if (entry.type === "wellknown") expect(entry.token).toBe("new")
    }),
  )

  it.instance("remove deletes both trailing-slash and normalized keys", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      yield* auth.set("https://example.com", {
        type: "wellknown",
        key: "TOKEN",
        token: "abc",
      })
      yield* auth.remove("https://example.com/")
      const data = yield* auth.all()
      expect(data["https://example.com"]).toBeUndefined()
      expect(data["https://example.com/"]).toBeUndefined()
    }),
  )

  it.instance("set and remove are no-ops on keys without trailing slashes", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      yield* auth.set("anthropic", {
        type: "api",
        key: "sk-test",
      })
      const data = yield* auth.all()
      expect(data["anthropic"]).toBeDefined()
      yield* auth.remove("anthropic")
      const after = yield* auth.all()
      expect(after["anthropic"]).toBeUndefined()
    }),
  )
})
