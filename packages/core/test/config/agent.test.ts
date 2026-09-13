import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect, Fiber, Schema, Stream } from "effect"
import { Agent } from "@opencode/core/agent"
import { Bus } from "@opencode/core/bus"
import { Config } from "@opencode/core/config"
import { Directory, Document, Event, Info } from "@opencode/schema/config"
import { Model } from "@opencode/schema/model"
import { ConfigAgentPlugin } from "@opencode/core/config/plugin/agent"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { FSUtil } from "@opencode/util/fs-util"
import { Global } from "@opencode/util/global"
import { Permission } from "@opencode/core/permission"
import { AgentPlugin } from "@opencode/core/plugin/agent"
import { AbsolutePath } from "@opencode/core/schema"
import { ConfigMigrateV1 } from "@opencode/core/v1/config/migrate"
import { ConfigAgentV1 } from "@opencode/core/v1/config/agent"
import { advance, drain } from "../lib/clock"
import { tmpdir, tmpdirScoped } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"
import { agentHost, host } from "../plugin/host"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Agent.node, Bus.node, FSUtil.node, Global.node])))
const decode = Schema.decodeUnknownSync(Info)
const defaultPermissions = (global: Global.Interface): Permission.Ruleset => [
  ...Agent.Info.default(Agent.ID.make("test")).permissions,
  { action: "external_directory", resource: path.join(global.data, "shell", "*", "*"), effect: "allow" },
  { action: "external_directory", resource: path.join(global.data, "tool-output", "*"), effect: "allow" },
  { action: "external_directory", resource: path.join(global.tmp, "*"), effect: "allow" },
  { action: "external_directory", resource: path.join(global.config, "*"), effect: "allow" },
]

test("rejects named agent color tokens", () => {
  expect(() => decode({ agents: { reviewer: { color: "warning" } } })).toThrow()
})

test("keeps schema fields and name out of legacy agent options", () => {
  const agent = Schema.decodeUnknownSync(ConfigAgentV1.Info)({
    name: "reviewer",
    model: "test/model",
    variant: "high",
    temperature: 0.5,
    top_p: 0.9,
    prompt: "Review carefully.",
    tools: { edit: false },
    disable: false,
    description: "Reviews changes",
    mode: "subagent",
    hidden: true,
    options: { existing: true },
    color: "#112233",
    steps: 10,
    maxSteps: 20,
    permission: { read: "allow" },
    custom: "preserved",
  })

  expect(agent.options).toEqual({ existing: true, custom: "preserved" })
})

describe("ConfigAgentPlugin.Plugin", () => {
  for (const item of [
    { name: "separate legacy variant", frontmatter: "model: example/chat\nvariant: high", model: "example/chat#high" },
    { name: "unqualified model", frontmatter: "model: example/chat", model: "example/chat" },
    { name: "embedded native variant", frontmatter: "model: example/chat#high", model: "example/chat#high" },
    {
      name: "structured native variant",
      frontmatter: "model:\n  providerID: example\n  model: chat\n  variant: high",
      model: "example/chat#high",
    },
    {
      name: "structured unqualified model",
      frontmatter: "model:\n  providerID: example\n  model: chat",
      model: "example/chat",
    },
    { name: "standalone variant", frontmatter: "variant: high", model: undefined },
    {
      name: "embedded native variant with an ignored separate variant",
      frontmatter: "model: example/chat#high\nvariant: low",
      model: "example/chat#high",
    },
    {
      name: "structured native variant with an ignored separate variant",
      frontmatter: "model:\n  providerID: example\n  model: chat\n  variant: high\nvariant: low",
      model: "example/chat#high",
    },
  ]) {
    for (const native of [false, true]) {
      it.live(`loads Markdown ${item.name}${native ? " with native request and permissions" : ""}`, () =>
        Effect.gen(function* () {
          const agent = yield* loadMarkdownAgent(
            native
              ? `${item.frontmatter}
request:
  headers:
    x-agent: native
  body:
    effort: high
permissions:
  - action: edit
    resource: "*"
    effect: deny`
              : item.frontmatter,
          )
          expect(agent.model).toEqual(item.model === undefined ? undefined : Model.Ref.parse(item.model))
          expect(agent.request).toEqual({
            settings: {},
            headers: native ? { "x-agent": "native" } : {},
            body: native ? { effort: "high" } : {},
          })
          if (native) {
            expect(agent.permissions).toContainEqual({ action: "edit", resource: "*", effect: "deny" })
            expect(Permission.evaluate("edit", "example.txt", agent.permissions).effect).toBe("deny")
          }
        }),
      )
    }
  }

  for (const variant of [undefined, "high"]) {
    it.live(`loads Markdown legacy temperature ${variant ? "with" : "without"} a separate variant`, () =>
      Effect.gen(function* () {
        const agent = yield* loadMarkdownAgent(
          `model: example/chat\ntemperature: 0.5${variant ? `\nvariant: ${variant}` : ""}`,
        )
        expect(agent.model).toEqual(Model.Ref.parse(variant ? "example/chat#high" : "example/chat"))
        expect(agent.request).toEqual({ settings: {}, headers: {}, body: { temperature: 0.5 } })
      }),
    )
  }

  it.effect("matches POSIX paths against home-relative permissions", () =>
    Effect.gen(function* () {
      const permissions = yield* loadHomePermissions("/home/test")
      expect(Permission.evaluate("external_directory", "/home/test/p/opencode/src/*", permissions).effect).toBe("allow")
      expect(Permission.evaluate("external_directory", "/home/test/cache/files/*", permissions).effect).toBe("deny")
      expect(Permission.evaluate("external_directory", "/some/~/path", permissions).effect).toBe("deny")
      expect(Permission.evaluate("external_directory", "$HOMELESS/private/*", permissions).effect).toBe("deny")
      expect(permissions).toContainEqual({ action: "shell", resource: "$HOME/private/**", effect: "deny" })
      expect(permissions).not.toContainEqual({ action: "shell", resource: "/home/test/private/**", effect: "deny" })
      expect(Permission.evaluate("shell", "$HOME/private/key", permissions).effect).toBe("deny")
    }),
  )

  it.effect("matches Windows paths against home-relative permissions", () =>
    Effect.gen(function* () {
      const permissions = yield* loadHomePermissions("C:\\Users\\test")
      expect(permissions).toContainEqual({
        action: "external_directory",
        resource: "C:\\Users\\test\\p\\**",
        effect: "allow",
      })
      expect(
        Permission.evaluate("external_directory", "C:\\Users\\test\\p\\opencode\\src\\*", permissions).effect,
      ).toBe("allow")
      expect(Permission.evaluate("external_directory", "C:\\Users\\test\\cache\\files\\*", permissions).effect).toBe(
        "deny",
      )
    }),
  )

  it.effect("applies remote permission defaults before explicit global and build rules", () =>
    Effect.gen(function* () {
      const agents = yield* Agent.Service
      const global = yield* Global.Service
      yield* AgentPlugin.Plugin.effect(host({ agent: agentHost(agents) }))

      const entries = [
        new Document({
          type: "document",
          info: decode(
            ConfigMigrateV1.migrate({
              permission: {
                bash: "ask",
                edit: "ask",
                webfetch: "ask",
                read: {
                  "*": "allow",
                  "*.env": "deny",
                  "*.env.*": "deny",
                  "*.env.example": "allow",
                  "*.dev.vars": "deny",
                  "~/.local/share/opencode/mcp-auth.json": "deny",
                  "$HOME/.local/share/opencode/mcp-auth.json": "deny",
                },
                external_directory: {
                  "*": "ask",
                  "~/.local/share/opencode/*": "deny",
                },
              },
            }),
          ),
        }),
        new Document({
          type: "document",
          info: decode({
            permissions: [{ action: "*", resource: "*", effect: "allow" }],
            agents: {
              build: {
                permissions: [
                  { action: "external_directory", resource: "*", effect: "allow" },
                  {
                    action: "external_directory",
                    resource: "~/.local/share/opencode/*",
                    effect: "deny",
                  },
                  { action: "read", resource: "*.env", effect: "deny" },
                ],
              },
            },
          }),
        }),
      ]

      yield* ConfigAgentPlugin.Plugin.effect(host({ agent: agentHost(agents) })).pipe(
        Effect.provide(Config.testLayer(entries)),
      )

      const build = yield* agents.get(Agent.defaultID)
      if (!build) throw new Error("expected configured build agent")
      const opencodeData = path.join(global.home, ".local", "share", "opencode", "*")
      const mcpAuth = path.join(global.home, ".local", "share", "opencode", "mcp-auth.json")
      expect(build.permissions).toEqual([
        ...defaultPermissions(global),
        { action: "question", resource: "*", effect: "allow" },
        { action: "shell", resource: "*", effect: "ask" },
        { action: "edit", resource: "*", effect: "ask" },
        { action: "webfetch", resource: "*", effect: "ask" },
        { action: "read", resource: "*", effect: "allow" },
        { action: "read", resource: "*.env", effect: "deny" },
        { action: "read", resource: "*.env.*", effect: "deny" },
        { action: "read", resource: "*.env.example", effect: "allow" },
        { action: "read", resource: "*.dev.vars", effect: "deny" },
        { action: "read", resource: mcpAuth, effect: "deny" },
        { action: "read", resource: mcpAuth, effect: "deny" },
        { action: "external_directory", resource: "*", effect: "ask" },
        { action: "external_directory", resource: opencodeData, effect: "deny" },
        { action: "*", resource: "*", effect: "allow" },
        { action: "external_directory", resource: "*", effect: "allow" },
        { action: "external_directory", resource: opencodeData, effect: "deny" },
        { action: "read", resource: "*.env", effect: "deny" },
      ])
      expect(Permission.evaluate("shell", "bun test", build.permissions).effect).toBe("allow")
      expect(Permission.evaluate("edit", "src/index.ts", build.permissions).effect).toBe("allow")
      expect(Permission.evaluate("webfetch", "https://example.com", build.permissions).effect).toBe("allow")
      expect(Permission.evaluate("read", ".env", build.permissions).effect).toBe("deny")
      expect(Permission.evaluate("external_directory", opencodeData, build.permissions).effect).toBe("deny")
      expect(Permission.evaluate("external_directory", "/outside/*", build.permissions).effect).toBe("allow")
    }),
  )

  it.effect("applies all global permissions before agent-specific permissions", () =>
    Effect.gen(function* () {
      const agents = yield* Agent.Service
      const global = yield* Global.Service
      const build = Agent.ID.make("build")
      yield* agents.transform((editor) =>
        editor.update(build, (agent) => {
          agent.mode = "primary"
          agent.permissions.push({ action: "bash", resource: "*", effect: "allow" })
        }),
      )

      const entries = [
        new Document({
          type: "document",
          info: decode({
            permissions: [{ action: "bash", resource: "*", effect: "ask" }],
            agents: {
              build: {
                permissions: [{ action: "bash", resource: "git *", effect: "allow" }],
              },
              reviewer: {
                model: "openrouter/openai/gpt-5",
                description: "Review changes",
                mode: "subagent",
                permissions: [
                  { action: "edit", resource: "*", effect: "deny" },
                  { action: "read", resource: "*", effect: "deny" },
                ],
              },
              removed: { description: "Removed later" },
            },
          }),
        }),
        new Document({
          type: "document",
          info: decode({
            permissions: [{ action: "read", resource: "*", effect: "allow" }],
            agents: {
              reviewer: { model: "openrouter/openai/gpt-5#high", hidden: true },
              removed: { disabled: true },
              late: {
                permissions: [{ action: "edit", resource: "*", effect: "allow" }],
              },
            },
          }),
        }),
      ]

      yield* ConfigAgentPlugin.Plugin.effect(host({ agent: agentHost(agents) })).pipe(
        Effect.provide(Config.testLayer(entries)),
      )

      const buildAgent = yield* agents.get(build)
      if (!buildAgent) throw new Error("expected configured build agent")
      expect(buildAgent.permissions).toEqual([
        ...defaultPermissions(global),
        { action: "bash", resource: "*", effect: "allow" },
        { action: "bash", resource: "*", effect: "ask" },
        { action: "read", resource: "*", effect: "allow" },
        { action: "bash", resource: "git *", effect: "allow" },
      ])
      expect(Permission.evaluate("bash", "git status", buildAgent.permissions).effect).toBe("allow")
      expect(Permission.evaluate("bash", "bun test", buildAgent.permissions).effect).toBe("ask")

      const reviewer = yield* agents.get(Agent.ID.make("reviewer"))
      if (!reviewer) throw new Error("expected configured reviewer agent")
      expect(reviewer).toMatchObject({
        description: "Review changes",
        mode: "subagent",
        hidden: true,
        model: { providerID: "openrouter", id: "openai/gpt-5", variant: "high" },
      })
      expect(reviewer.permissions).toEqual([
        ...defaultPermissions(global),
        { action: "bash", resource: "*", effect: "ask" },
        { action: "read", resource: "*", effect: "allow" },
        { action: "edit", resource: "*", effect: "deny" },
        { action: "read", resource: "*", effect: "deny" },
      ])
      expect(Permission.evaluate("read", "README.md", reviewer.permissions).effect).toBe("deny")
      expect((yield* agents.get(Agent.ID.make("late")))?.permissions).toEqual([
        ...defaultPermissions(global),
        { action: "bash", resource: "*", effect: "ask" },
        { action: "read", resource: "*", effect: "allow" },
        { action: "edit", resource: "*", effect: "allow" },
      ])
      expect(yield* agents.get(Agent.ID.make("removed"))).toBeUndefined()
    }),
  )

  it.effect("maps configured agent fields and preserves an unspecified model variant", () =>
    Effect.gen(function* () {
      const agents = yield* Agent.Service
      const entries = [
        new Document({
          type: "document",
          info: decode({
            agents: {
              reviewer: {
                model: "anthropic/claude-sonnet",
                system: "Review carefully.",
                description: "Reviews changes",
                mode: "subagent",
                hidden: true,
                color: "#ff6b6b",
                steps: 12,
                request: {
                  headers: { first: "one", shared: "first" },
                  body: { enabled: true, profile: "review", effort: "medium" },
                },
              },
            },
          }),
        }),
        new Document({
          type: "document",
          info: decode({
            agents: {
              reviewer: {
                request: {
                  headers: { shared: "last", second: "two" },
                  body: { retries: 2, effort: "high" },
                },
              },
            },
          }),
        }),
      ]

      yield* ConfigAgentPlugin.Plugin.effect(host({ agent: agentHost(agents) })).pipe(
        Effect.provide(Config.testLayer(entries)),
      )

      const reviewer = yield* agents.get(Agent.ID.make("reviewer"))
      if (!reviewer) throw new Error("expected configured reviewer agent")
      expect(reviewer).toMatchObject({
        system: "Review carefully.",
        description: "Reviews changes",
        mode: "subagent",
        hidden: true,
        color: "#ff6b6b",
        steps: 12,
        model: { providerID: "anthropic", id: "claude-sonnet" },
      })
      expect(reviewer.request).toEqual({
        settings: {},
        headers: { first: "one", shared: "last", second: "two" },
        body: { enabled: true, profile: "review", retries: 2, effort: "high" },
      })
    }),
  )

  it.effect("removes a built-in agent disabled by configuration", () =>
    Effect.gen(function* () {
      const agents = yield* Agent.Service
      const build = Agent.ID.make("build")
      yield* agents.transform((editor) => editor.update(build, () => {}))

      const entries = [
        new Document({
          type: "document",
          info: decode({ agents: { build: { disabled: true } } }),
        }),
      ]

      yield* ConfigAgentPlugin.Plugin.effect(host({ agent: agentHost(agents) })).pipe(
        Effect.provide(Config.testLayer(entries)),
      )

      expect(yield* agents.get(build)).toBeUndefined()
    }),
  )

  it.live("loads legacy file-based agents from config directories", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(async () => {
            await fs.mkdir(path.join(tmp.path, "agents", "team"), { recursive: true })
            await fs.mkdir(path.join(tmp.path, "modes"), { recursive: true })
            await fs.writeFile(
              path.join(tmp.path, "agents", "reviewer.md"),
              `---
model: openrouter/openai/gpt-5
description: Markdown description
temperature: 0.5
tools:
  write: false
---
Review carefully.`,
            )
            await fs.writeFile(path.join(tmp.path, "agents", "team", "helper.md"), "Help the team.")
            await fs.writeFile(
              path.join(tmp.path, "agents", "native.md"),
              `---
variant: high
request:
  headers:
    x-agent: native
  body:
    effort: high
permissions:
  - action: edit
    resource: "*"
    effect: deny
---
Use native v2 fields.`,
            )
            await fs.writeFile(path.join(tmp.path, "agents", "disabled.md"), "---\ndisabled: true\n---\nDisabled")
            await fs.writeFile(path.join(tmp.path, "agents", "empty.md"), "")
            await fs.writeFile(path.join(tmp.path, "modes", "plan.md"), "Make a plan.")
          })
          const agents = yield* Agent.Service
          const global = yield* Global.Service
          const entries = [
            new Document({
              type: "document",
              info: decode({ agents: { reviewer: { description: "JSON description" } } }),
            }),
            directoryEntry(tmp.path),
          ]

          yield* ConfigAgentPlugin.Plugin.effect(host({ agent: agentHost(agents) })).pipe(
            Effect.provide(Config.testLayer(entries)),
          )

          expect(yield* agents.get(Agent.ID.make("reviewer"))).toMatchObject({
            model: { providerID: "openrouter", id: "openai/gpt-5" },
            system: "Review carefully.",
            description: "Markdown description",
            request: { body: { temperature: 0.5 } },
            permissions: [...defaultPermissions(global), { action: "edit", resource: "*", effect: "deny" }],
          })
          expect(yield* agents.get(Agent.ID.make("team/helper"))).toMatchObject({ system: "Help the team." })
          expect(yield* agents.get(Agent.ID.make("native"))).toMatchObject({
            system: "Use native v2 fields.",
            request: { headers: { "x-agent": "native" }, body: { effort: "high" } },
            permissions: [...defaultPermissions(global), { action: "edit", resource: "*", effect: "deny" }],
          })
          expect(yield* agents.get(Agent.ID.make("disabled"))).toBeUndefined()
          expect(yield* agents.get(Agent.ID.make("empty"))).toBeUndefined()
          expect(yield* agents.get(Agent.ID.make("plan"))).toMatchObject({ system: "Make a plan.", mode: "primary" })
        }),
      ),
    ),
  )

  for (const testCase of sourceCases()) {
    it.effect(`rebuilds agents when a source file is ${testCase.name}`, () =>
      Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
        Effect.flatMap((tmp) =>
          Effect.gen(function* () {
            const directory = path.join(tmp.path, testCase.source)
            yield* Effect.promise(() => fs.mkdir(directory, { recursive: true }))
            yield* testCase.prepare(directory)

            const agents = yield* Agent.Service
            const bus = yield* Bus.Service
            const configTest = yield* Config.Test
            yield* ConfigAgentPlugin.Plugin.effect(host({ agent: agentHost(agents) }))

            // Verify inside the subscription so the update event is a read barrier:
            // committed state must be visible at event delivery time.
            let received = 0
            const changed = yield* bus.subscribe(Agent.Event.Updated).pipe(
              Stream.take(1),
              Stream.tap(() => Effect.sync(() => received++)),
              Stream.mapEffect(() => testCase.verify(agents)),
              Stream.runDrain,
              Effect.forkScoped({ startImmediately: true }),
            )
            yield* Effect.yieldNow

            const updates = yield* testCase.mutate(directory)
            yield* Effect.forEach(updates, (update) => configTest.emitChange(update), { discard: true })
            yield* advance(() => received === 1)
            yield* Fiber.join(changed)
          }).pipe(Effect.provide(Config.testLayer([directoryEntry(tmp.path)]))),
        ),
      ),
    )
  }

  it.effect("coalesces updates inside the debounce window into one rebuild", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const directory = path.join(tmp.path, "agents")
          yield* Effect.promise(() => fs.mkdir(directory, { recursive: true }))

          const agents = yield* Agent.Service
          const configTest = yield* Config.Test
          let reloads = 0
          yield* ConfigAgentPlugin.Plugin.effect(
            host({
              agent: {
                ...agentHost(agents),
                reload: () => agents.reload().pipe(Effect.tap(() => Effect.sync(() => reloads++))),
              },
            }),
          )
          yield* Effect.yieldNow

          yield* Effect.promise(() => fs.writeFile(path.join(directory, "reviewer.md"), "Review once"))
          yield* configTest.emitChange({ type: "create", path: path.join(directory, "reviewer.md") })
          yield* configTest.emitChange({ type: "update", path: path.join(directory, "reviewer.md") })
          yield* configTest.emitChange({ type: "update", path: path.join(directory, "reviewer.md") })
          yield* advance(() => reloads >= 1)
          expect(reloads).toBe(1)

          yield* Effect.promise(() => fs.writeFile(path.join(directory, "reviewer.md"), "Review twice"))
          yield* configTest.emitChange({ type: "update", path: path.join(directory, "reviewer.md") })
          yield* advance(() => reloads >= 2)
          expect(reloads).toBe(2)
          expect(yield* agents.get(Agent.ID.make("reviewer"))).toMatchObject({ system: "Review twice" })
        }).pipe(Effect.provide(Config.testLayer([directoryEntry(tmp.path)]))),
      ),
    ),
  )

  it.effect("rebuilds on a config update published immediately after startup", () =>
    Effect.gen(function* () {
      const agents = yield* Agent.Service
      const bus = yield* Bus.Service
      let reloads = 0
      // No directory entries, so startup has no filesystem hop that could hide a late subscription.
      yield* ConfigAgentPlugin.Plugin.effect(
        host({
          agent: {
            ...agentHost(agents),
            reload: () => agents.reload().pipe(Effect.tap(() => Effect.sync(() => reloads++))),
          },
          event: { subscribe: () => bus.subscribe(Event.Updated) },
        }),
      )

      // Published in the same fiber step as startup: the subscription must
      // already be open when the plugin effect returns.
      yield* bus.publish(Event.Updated, {})
      yield* advance(() => reloads >= 1)
      expect(reloads).toBe(1)
    }).pipe(Effect.provide(Config.testLayer([]))),
  )

  it.effect("ignores updates outside agent source directories", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const directory = path.join(tmp.path, "agents")
          yield* Effect.promise(() => fs.mkdir(directory, { recursive: true }))

          const agents = yield* Agent.Service
          const configTest = yield* Config.Test
          let reloads = 0
          yield* ConfigAgentPlugin.Plugin.effect(
            host({
              agent: {
                ...agentHost(agents),
                reload: () => agents.reload().pipe(Effect.tap(() => Effect.sync(() => reloads++))),
              },
            }),
          )

          yield* configTest.emitChange({ type: "create", path: path.join(tmp.path, "commands", "review.md") })
          yield* configTest.emitChange({ type: "update", path: path.join(tmp.path, "opencode.json") })
          yield* drain
          expect(reloads).toBe(0)

          // The feed stays live after unrelated updates.
          yield* Effect.promise(() => fs.writeFile(path.join(directory, "reviewer.md"), "Review related"))
          yield* configTest.emitChange({ type: "create", path: path.join(directory, "reviewer.md") })
          yield* advance(() => reloads >= 1)
          expect(yield* agents.get(Agent.ID.make("reviewer"))).toMatchObject({ system: "Review related" })
        }).pipe(Effect.provide(Config.testLayer([directoryEntry(tmp.path)]))),
      ),
    ),
  )
})

function loadMarkdownAgent(frontmatter: string) {
  return Effect.gen(function* () {
    const tmp = yield* tmpdirScoped()
    const fs = yield* FSUtil.Service
    yield* fs.makeDirectory(path.join(tmp.path, "agents"))
    yield* fs.writeFileString(
      path.join(tmp.path, "agents", "reviewer.md"),
      `---\n${frontmatter}\n---\nReview carefully.`,
    )
    const agents = yield* Agent.Service
    yield* ConfigAgentPlugin.Plugin.effect(host({ agent: agentHost(agents) })).pipe(
      Effect.provide(Config.testLayer([directoryEntry(tmp.path)])),
    )
    const agent = yield* agents.get(Agent.ID.make("reviewer"))
    if (!agent) throw new Error("expected configured Markdown agent")
    expect(agent.system).toBe("Review carefully.")
    return agent
  })
}

function directoryEntry(directory: string) {
  return new Directory({ type: "directory", path: AbsolutePath.make(directory) })
}

function sourceCases() {
  return [
    {
      name: "created",
      source: "agents",
      prepare: () => Effect.void,
      mutate: (directory: string) =>
        Effect.promise(async () => {
          const file = path.join(directory, "reviewer.md")
          await fs.writeFile(file, "Review changes")
          return [{ type: "create" as const, path: file }]
        }),
      verify: (agents: Agent.Interface) =>
        Effect.gen(function* () {
          expect(yield* agents.get(Agent.ID.make("reviewer"))).toMatchObject({ system: "Review changes" })
        }),
    },
    {
      name: "created in a legacy modes directory",
      source: "modes",
      prepare: () => Effect.void,
      mutate: (directory: string) =>
        Effect.promise(async () => {
          const file = path.join(directory, "plan.md")
          await fs.writeFile(file, "Make a plan")
          return [{ type: "create" as const, path: file }]
        }),
      verify: (agents: Agent.Interface) =>
        Effect.gen(function* () {
          expect(yield* agents.get(Agent.ID.make("plan"))).toMatchObject({ system: "Make a plan", mode: "primary" })
        }),
    },
    {
      name: "updated",
      source: "agents",
      prepare: (directory: string) =>
        Effect.promise(() => fs.writeFile(path.join(directory, "reviewer.md"), "Review first")),
      mutate: (directory: string) =>
        Effect.promise(async () => {
          const file = path.join(directory, "reviewer.md")
          await fs.writeFile(file, "Review updated")
          return [{ type: "update" as const, path: file }]
        }),
      verify: (agents: Agent.Interface) =>
        Effect.gen(function* () {
          expect(yield* agents.get(Agent.ID.make("reviewer"))).toMatchObject({ system: "Review updated" })
        }),
    },
    {
      name: "renamed",
      source: "agents",
      prepare: (directory: string) =>
        Effect.promise(() => fs.writeFile(path.join(directory, "reviewer.md"), "Review renamed")),
      mutate: (directory: string) =>
        Effect.promise(async () => {
          const previous = path.join(directory, "reviewer.md")
          const next = path.join(directory, "release.md")
          await fs.rename(previous, next)
          return [
            { type: "delete" as const, path: previous },
            { type: "create" as const, path: next },
          ]
        }),
      verify: (agents: Agent.Interface) =>
        Effect.gen(function* () {
          expect(yield* agents.get(Agent.ID.make("reviewer"))).toBeUndefined()
          expect(yield* agents.get(Agent.ID.make("release"))).toMatchObject({ system: "Review renamed" })
        }),
    },
    {
      name: "deleted",
      source: "agents",
      prepare: (directory: string) =>
        Effect.promise(() => fs.writeFile(path.join(directory, "reviewer.md"), "Review deleted")),
      mutate: (directory: string) =>
        Effect.promise(async () => {
          const file = path.join(directory, "reviewer.md")
          await fs.unlink(file)
          return [{ type: "delete" as const, path: file }]
        }),
      verify: (agents: Agent.Interface) =>
        Effect.gen(function* () {
          expect(yield* agents.get(Agent.ID.make("reviewer"))).toBeUndefined()
        }),
    },
  ] as const
}

function loadHomePermissions(home: string) {
  return Effect.gen(function* () {
    const agents = yield* Agent.Service
    const build = Agent.ID.make("build")
    yield* agents.transform((editor) => editor.update(build, () => {}))
    const entries = [
      new Document({
        type: "document",
        info: decode(
          ConfigMigrateV1.migrate({
            permission: {
              external_directory: {
                "~/p/**": "allow",
                "/some/~/path": "deny",
                "$HOMELESS/**": "deny",
              },
              bash: {
                "$HOME/private/**": "deny",
              },
            },
            agent: {
              build: {
                permission: {
                  external_directory: {
                    "$HOME/cache/**": "deny",
                  },
                },
              },
            },
          }),
        ),
      }),
    ]

    yield* ConfigAgentPlugin.Plugin.effect(host({ agent: agentHost(agents) })).pipe(
      Effect.provide(Config.testLayer(entries)),
      Effect.provideService(Global.Service, Global.Service.of({ ...Global.make(), home })),
    )

    const agent = yield* agents.get(build)
    if (!agent) throw new Error("expected configured build agent")
    return agent.permissions
  })
}
