import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { CodeMode, Namespace, Tool } from "../src/index.js"

const echo = (description: string, result: string) =>
  Tool.make({
    description,
    input: Schema.Struct({}),
    output: Schema.String,
    execute: () => Effect.succeed(result),
  })

const value = async (runtime: CodeMode.Runtime, code: string) => {
  const result = await Effect.runPromise(runtime.execute(code))
  if (!result.ok) throw new Error(`expected success, got ${result.error.kind}: ${result.error.message}`)
  return result.value
}

const failure = async (runtime: CodeMode.Runtime, code: string) => {
  const result = await Effect.runPromise(runtime.execute(code))
  if (result.ok) throw new Error(`expected failure, got value ${JSON.stringify(result.value)}`)
  return result.error
}

describe("dotted tool names", () => {
  const runtime = CodeMode.make({ tools: { api: { "issues.list": echo("List issues", "listed") } } })

  test("a dotted name becomes nested namespaces in the catalog", () => {
    const catalog = runtime.catalog
    expect(catalog).toHaveLength(1)
    expect(catalog[0]?.path).toBe("api.issues.list")
    expect(catalog[0]?.signature).toStartWith("tools.api.issues.list(")
  })

  test("the advertised dotted path is executable", async () => {
    expect(await value(runtime, `return await tools.api.issues.list({})`)).toBe("listed")
  })

  test("bracket access with a dotted segment spells the same canonical path", async () => {
    expect(await value(runtime, `return await tools.api["issues.list"]({})`)).toBe("listed")
    expect(await value(runtime, `return await tools["api.issues"].list({})`)).toBe("listed")
  })

  test("intermediate segments enumerate like ordinary namespaces", async () => {
    expect(await value(runtime, `return [Object.keys(tools.api), Object.keys(tools.api.issues)]`)).toEqual([
      ["issues"],
      ["list"],
    ])
    expect(await value(runtime, `return Object.keys(tools["api.issues"])`)).toEqual(["list"])
  })

  test("a top-level dotted name nests from the root", async () => {
    const flat = CodeMode.make({ tools: { "issues.list": echo("List issues", "flat") } })
    expect(flat.catalog[0]?.path).toBe("issues.list")
    expect(await value(flat, `return await tools.issues.list({})`)).toBe("flat")
  })

  test("search scopes to a nested namespace subtree", async () => {
    const nested = CodeMode.make({
      tools: {
        slack: {
          admin: echo("Admin", "admin"),
          "admin.invite": echo("Invite", "invite"),
          "admin.users.list": echo("List users", "users"),
          "administrator.list": echo("List administrators", "administrators"),
          read: echo("Read Slack", "read"),
        },
      },
    })

    const result = await value(nested, `return search({ query: "", namespace: "slack.admin" })`)
    expect((result as { items: Array<{ path: string }> }).items.map((item) => item.path)).toEqual([
      "tools.slack.admin",
      "tools.slack.admin.invite",
      "tools.slack.admin.users.list",
    ])
  })
})

describe("callable namespaces", () => {
  const runtime = CodeMode.make({
    tools: { issues: echo("All issues", "all"), "issues.list": echo("List issues", "list") },
  })

  test("a path can hold a tool and child tools at once", async () => {
    expect(await value(runtime, `return await tools.issues({})`)).toBe("all")
    expect(await value(runtime, `return await tools.issues.list({})`)).toBe("list")
    expect(runtime.catalog.map((tool) => tool.path)).toEqual(["issues", "issues.list"])
  })

  test("a callable namespace enumerates its children", async () => {
    expect(await value(runtime, `return Object.keys(tools.issues)`)).toEqual(["list"])
  })

  test("search returns executable paths for both", async () => {
    const result = await value(runtime, `return search({ query: "", namespace: "issues" })`)
    expect((result as { items: Array<{ path: string }> }).items.map((item) => item.path)).toEqual([
      "tools.issues",
      "tools.issues.list",
    ])
    const exact = await value(runtime, `return search({ query: "tools.issues.list" })`)
    expect((exact as { items: Array<{ path: string }> }).items.map((item) => item.path)).toEqual(["tools.issues.list"])
  })

  test("an unknown child under a callable tool is an UnknownTool error", async () => {
    const diagnostic = await failure(runtime, `return await tools.issues.missing({})`)
    expect(diagnostic.kind).toBe("UnknownTool")
    expect(diagnostic.message).toContain("Unknown tool 'issues.missing'")
    expect(diagnostic.suggestions).toEqual([
      "The tool may have been removed or renamed. Use search to find available tools.",
    ])
  })

  test("a namespace without its own tool stays non-callable", async () => {
    const nested = CodeMode.make({ tools: { "issues.list": echo("List issues", "list") } })
    const diagnostic = await failure(nested, `return await tools.issues({})`)
    expect(diagnostic.kind).toBe("UnknownTool")
    expect(diagnostic.message).toContain("Tool 'issues' is not callable")
  })
})

describe("tool input diagnostics", () => {
  const runtime = CodeMode.make({
    tools: {
      "notes.echo": Tool.make({
        description: "Echo text",
        input: Schema.Struct({ text: Schema.String }),
        output: Schema.String,
        execute: ({ text }) => Effect.succeed(text),
      }),
    },
  })

  test("a schema mismatch suggests searching for the current signature", async () => {
    const diagnostic = await failure(runtime, `return await tools.notes.echo({ message: "hello" })`)
    expect(diagnostic.kind).toBe("InvalidToolInput")
    expect(diagnostic.suggestions).toEqual(["The signature may have changed. Use search to get the current signature."])
  })

  test("a wrong argument count keeps the existing error without a stale-signature hint", async () => {
    const diagnostic = await failure(runtime, `return await tools.notes.echo({}, {})`)
    expect(diagnostic.kind).toBe("InvalidToolInput")
    expect(diagnostic.suggestions).toBeUndefined()
  })

  test("an empty-input tool advertises () and runs with zero arguments", async () => {
    const empty = CodeMode.make({ tools: { ping: echo("Ping", "pong") } })
    expect(empty.catalog[0]?.signature).toBe("tools.ping(): Promise<string>")
    expect(await value(empty, `return await tools.ping()`)).toBe("pong")
  })
})

describe("blocked member names on tool paths", () => {
  const runtime = CodeMode.make({
    tools: {
      prototype: echo("Prototype tool", "proto"),
      "issues.constructor": echo("Constructor tool", "ctor"),
      nested: { ["__proto__"]: echo("Proto tool", "dunder") },
    },
  })

  test("tools may use blocked member names because path segments never touch real properties", async () => {
    expect(runtime.catalog.map((tool) => tool.path)).toEqual(["issues.constructor", "nested.__proto__", "prototype"])
    expect(await value(runtime, `return await tools.prototype({})`)).toBe("proto")
    expect(await value(runtime, `return await tools.issues.constructor({})`)).toBe("ctor")
    expect(await value(runtime, `return await tools["issues.constructor"]({})`)).toBe("ctor")
    expect(await value(runtime, `return await tools.nested.__proto__({})`)).toBe("dunder")
    expect(await value(runtime, `return Object.keys(tools.issues)`)).toEqual(["constructor"])
  })

  test("a literal __proto__ key cannot poison a namespace into a fake tool", async () => {
    const poisoned = CodeMode.make({
      tools: { ns: { __proto__: echo("Hidden", "hidden"), real: echo("Real tool", "real") } },
    })
    expect(poisoned.catalog.map((tool) => tool.path)).toEqual(["ns.real"])
    expect(await value(poisoned, `return await tools.ns.real({})`)).toBe("real")
  })

  test("prototypes are program objects; __proto__ is an ordinary key and the host is unreachable", async () => {
    expect(
      await value(
        runtime,
        `
        const object = {}
        const array = []
        object.__proto__ = { polluted: true }
        return [
          object.constructor === Object, array.constructor === Array, "".constructor === String,
          Math.constructor === Object, object.__proto__.polluted, ({}).polluted, array.__proto__,
          Object().__proto__, new Object().constructor === Object, ({}).constructor.constructor === Function,
          [].constructor.__proto__, typeof [].__proto__, (() => 1).constructor === Function,
        ]
      `,
      ),
    ).toEqual([true, true, true, true, true, null, null, null, true, true, null, "undefined", true])
    const escape = await failure(runtime, `return ({}).constructor.constructor("return 1")()`)
    expect(escape.message).toContain("The Function constructor is not supported")
    const poisoned = await failure(runtime, `const o = {}; o.__proto__.constructor("return 1")`)
    expect(poisoned.message).toContain("Cannot read properties of undefined")
    // Prototype mutation is confined to one run: the next program starts from fresh intrinsics.
    expect(await value(runtime, `Object.prototype.polluted = 1; Array.prototype.push = 2; return ({}).polluted`)).toBe(1)
    expect(await value(runtime, `return [({}).polluted, typeof [].push]`)).toEqual([null, "function"])
    expect(Object.keys(Object.prototype)).toEqual([])
    expect(Object.keys(Array.prototype)).toEqual([])
  })
})

describe("namespace metadata", () => {
  const tools = {
    api: Namespace.make({
      description: "Manage the workspace",
      tools: {
        users: Namespace.make({
          description: "Directory and account administration",
          tools: { list: echo("List users", "users") },
        }),
        status: echo("Read service status", "ok"),
      },
    }),
    plain: { read: echo("Read plain data", "plain") },
  }
  const runtime = CodeMode.make({ tools })

  test("the wrapper does not add a segment to callable paths", async () => {
    expect(runtime.catalog.map((tool) => tool.path)).toEqual(["api.status", "api.users.list", "plain.read"])
    expect(await value(runtime, `return await tools.api.users.list({})`)).toBe("users")
  })

  test("search matches descriptions from every enclosing namespace", async () => {
    const workspace = await value(runtime, `return search({ query: "workspace" })`)
    expect((workspace as { items: Array<{ path: string }> }).items.map((item) => item.path)).toEqual([
      "tools.api.status",
      "tools.api.users.list",
    ])

    const directory = await value(runtime, `return search({ query: "account administration" })`)
    expect((directory as { items: Array<{ path: string }> }).items.map((item) => item.path)).toEqual([
      "tools.api.users.list",
    ])
  })

  test("a namespace description is optional", async () => {
    const optional = CodeMode.make({
      tools: { api: Namespace.make({ tools: { read: echo("Read data", "read") } }) },
    })
    expect(await value(optional, `return await tools.api.read({})`)).toBe("read")
  })
})

describe("empty segments", () => {
  test("tool names with empty segments are rejected at make", () => {
    for (const name of ["", "a..b", "trail.", ".lead"]) {
      expect(() => CodeMode.make({ tools: { [name]: echo("Bad", "bad") } })).toThrow("empty segment")
    }
  })
})

describe("canonical path collisions", () => {
  test("the last tool supplied for a canonical path wins", async () => {
    const runtime = CodeMode.make({
      tools: { "issues.list": echo("First", "first"), issues: { list: echo("Second", "second") } },
    })
    expect(await value(runtime, `return await tools.issues.list({})`)).toBe("second")
    expect(runtime.catalog).toHaveLength(1)
    expect(runtime.catalog[0]?.description).toBe("Second")
  })

  test("overriding one path keeps sibling tools from both shapes", async () => {
    const runtime = CodeMode.make({
      tools: {
        "issues.list": echo("First list", "first"),
        issues: { list: echo("Second list", "second"), get: echo("Get issue", "got") },
        "issues.close": echo("Close issue", "closed"),
      },
    })
    expect(runtime.catalog.map((tool) => tool.path)).toEqual(["issues.close", "issues.get", "issues.list"])
    expect(await value(runtime, `return await tools.issues.list({})`)).toBe("second")
    expect(await value(runtime, `return await tools.issues.get({})`)).toBe("got")
    expect(await value(runtime, `return await tools.issues.close({})`)).toBe("closed")
  })
})
