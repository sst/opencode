import { describe, expect } from "bun:test"
import { Cause, Deferred, Effect, Fiber, Layer } from "effect"
import { Agent } from "@opencode/core/agent"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Bus } from "@opencode/core/bus"
import { Location } from "@opencode/core/location"
import { Permission } from "@opencode/core/permission"
import { PermissionTable } from "@opencode/core/permission/sql"
import { PermissionSaved } from "@opencode/core/permission/saved"
import { Project } from "@opencode/core/project"
import { ProjectTable } from "@opencode/core/project/sql"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionTable } from "@opencode/core/session/sql"
import { SessionStore } from "@opencode/core/session/store"
import { ShellParse } from "@opencode/core/shell/parse"
import { eq } from "drizzle-orm"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"

const current = Layer.succeed(
  Location.Service,
  Location.Service.of(location({ directory: AbsolutePath.make("/project") })),
)
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, Bus.node, SessionStore.node, PermissionSaved.node, Agent.node, Permission.node]),
    [Location.node.replace(current)],
  ),
)

function setup(rules: Permission.Ruleset = [], sessionID = Session.ID.make("ses_test")) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id: sessionID,
        project_id: Project.ID.global,
        slug: "test",
        directory: "/project",
        title: "test",
        version: "test",
        agent: "test",
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* setRules(rules)
  })
}

function setRules(rules: Permission.Ruleset) {
  return Effect.gen(function* () {
    const agents = yield* Agent.Service
    yield* agents.transform((editor) =>
      editor.update(Agent.ID.make("test"), (agent) => {
        agent.permissions = [...rules]
      }),
    )
  })
}

function assertion(input: Partial<Permission.AssertInput> = {}) {
  return {
    id: Permission.ID.create("per_test"),
    sessionID: Session.ID.make("ses_test"),
    action: "read",
    resources: ["src/index.ts"],
    ...input,
  } satisfies Permission.AssertInput
}

function waitForRequest(input: Partial<Permission.AssertInput> = {}) {
  return Effect.gen(function* () {
    const value = assertion(input)
    const service = yield* Permission.Service
    const bus = yield* Bus.Service
    const asked = yield* Deferred.make<Permission.Request>()
    const unsubscribe = yield* bus.listen((event) => {
      if (event.type !== Permission.Event.Asked.type) return Effect.void
      const request = event.data as Permission.Request
      return request.id === value.id ? Deferred.succeed(asked, request).pipe(Effect.asVoid) : Effect.void
    })
    yield* Effect.addFinalizer(() => unsubscribe)
    const fiber = yield* service.assert(value).pipe(Effect.forkScoped)
    const request = yield* Deferred.await(asked)
    return { service, fiber, request }
  })
}

describe("Permission", () => {
  it.effect("returns the evaluated effect and only queues prompts", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "read", resource: "*", effect: "allow" }])
      const service = yield* Permission.Service
      expect(yield* service.ask(assertion())).toEqual({ id: Permission.ID.create("per_test"), effect: "allow" })
      expect(yield* service.list()).toEqual([])
      yield* setRules([{ action: "read", resource: "*", effect: "deny" }])
      expect(yield* service.ask(assertion())).toEqual({ id: Permission.ID.create("per_test"), effect: "deny" })
      expect(yield* service.list()).toEqual([])
      yield* setRules([])
      expect(yield* service.ask(assertion())).toEqual({ id: Permission.ID.create("per_test"), effect: "ask" })
      expect(yield* service.get(Permission.ID.create("per_test"))).toBeDefined()
    }),
  )

  it.effect("evaluates against an explicit agent", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "read", resource: "*", effect: "allow" }])
      const agents = yield* Agent.Service
      yield* agents.transform((editor) =>
        editor.update(Agent.ID.make("reviewer"), (agent) => {
          agent.permissions.push({ action: "read", resource: "*", effect: "deny" })
        }),
      )
      const service = yield* Permission.Service

      expect(yield* service.ask(assertion())).toMatchObject({ effect: "allow" })
      expect(yield* service.ask(assertion({ agent: Agent.ID.make("reviewer") }))).toMatchObject({ effect: "deny" })
      yield* agents.transform((editor) =>
        editor.update(Agent.ID.make("reviewer"), (agent) => {
          agent.permissions = []
        }),
      )
      expect(yield* service.ask(assertion({ agent: Agent.ID.make("reviewer") }))).toMatchObject({ effect: "ask" })
      expect(yield* service.get(Permission.ID.create("per_test"))).not.toHaveProperty("agent")
    }),
  )

  it.effect("allows and denies from explicit rules without asking", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "read", resource: "*", effect: "allow" }])
      const service = yield* Permission.Service
      yield* service.assert(assertion())
      yield* setRules([{ action: "read", resource: "*", effect: "deny" }])
      const blocked = yield* service.assert(assertion()).pipe(Effect.flip)
      expect(blocked).toBeInstanceOf(Permission.BlockedError)
      expect(yield* service.list()).toEqual([])
    }),
  )

  it.effect("allows managed output reads without granting external directory access", () =>
    Effect.gen(function* () {
      yield* setup([
        { action: "*", resource: "*", effect: "deny" },
        { action: "read", resource: "*", effect: "allow" },
      ])
      const service = yield* Permission.Service

      expect(yield* service.ask(assertion({ resources: ["tool_123"] }))).toMatchObject({ effect: "allow" })
      expect(
        yield* service.ask(assertion({ action: "external_directory", resources: ["/tmp/tool-output/*"] })),
      ).toMatchObject({ effect: "deny" })
    }),
  )

  it.effect("uses build permissions when the Session agent is omitted", () =>
    Effect.gen(function* () {
      yield* setup()
      const { db } = yield* Database.Service
      yield* db
        .update(SessionTable)
        .set({ agent: null })
        .where(eq(SessionTable.id, Session.ID.make("ses_test")))
        .run()
        .pipe(Effect.orDie)
      const agents = yield* Agent.Service
      yield* agents.transform((editor) =>
        editor.update(Agent.ID.make("build"), (agent) => {
          agent.permissions = [{ action: "custom", resource: "*", effect: "allow" }]
        }),
      )

      const service = yield* Permission.Service
      expect(yield* service.ask(assertion({ action: "custom", resources: ["*"] }))).toEqual({
        id: Permission.ID.create("per_test"),
        effect: "allow",
      })
      expect(yield* service.list()).toEqual([])
    }),
  )

  it.effect("denies omitted-agent permissions when no primary default agent exists", () =>
    Effect.gen(function* () {
      yield* setup()
      const { db } = yield* Database.Service
      yield* db
        .update(SessionTable)
        .set({ agent: null })
        .where(eq(SessionTable.id, Session.ID.make("ses_test")))
        .run()
        .pipe(Effect.orDie)
      const agents = yield* Agent.Service
      yield* agents.transform((editor) => {
        editor.remove(Agent.ID.make("test"))
        editor.remove(Agent.ID.make("build"))
      })

      const service = yield* Permission.Service
      expect(yield* service.ask(assertion())).toEqual({ id: Permission.ID.create("per_test"), effect: "deny" })
      expect(yield* service.list()).toEqual([])
    }),
  )

  it.effect("evaluates bash with the normal configured-rule semantics", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "*", resource: "*", effect: "allow" }])
      const service = yield* Permission.Service
      const bash = assertion({ action: "bash", resources: ["pwd"] })
      expect(yield* service.ask(bash)).toEqual({ id: Permission.ID.create("per_test"), effect: "allow" })

      yield* setRules([])
      expect(yield* service.ask(bash)).toEqual({ id: Permission.ID.create("per_test"), effect: "ask" })
      expect(yield* service.get(Permission.ID.create("per_test"))).toBeDefined()
    }),
  )

  it.effect("merges session rules after agent rules and before saved approvals", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "*", resource: "*", effect: "allow" }])
      const { db } = yield* Database.Service
      const service = yield* Permission.Service
      const setSession = (permission: Permission.Ruleset) =>
        db
          .update(SessionTable)
          .set({ permission })
          .where(eq(SessionTable.id, Session.ID.make("ses_test")))
          .run()
          .pipe(Effect.orDie)

      yield* setSession([{ action: "edit", resource: "/original/**", effect: "deny" }])
      expect(yield* service.ask(assertion({ action: "edit", resources: ["/original/src/index.ts"] }))).toMatchObject({
        effect: "deny",
      })

      yield* setRules([])
      const saved = yield* PermissionSaved.Service
      yield* saved.add({ projectID: Project.ID.global, action: "bash", resources: ["pwd"] })
      yield* setSession([{ action: "bash", resource: "*", effect: "deny" }])
      expect(yield* service.ask(assertion({ action: "bash", resources: ["pwd"] }))).toMatchObject({ effect: "deny" })
      yield* setSession([{ action: "bash", resource: "*", effect: "ask" }])
      expect(yield* service.ask(assertion({ action: "bash", resources: ["pwd"] }))).toMatchObject({ effect: "allow" })
    }),
  )

  it.effect("uses saved bash approvals while preserving configured deny precedence", () =>
    Effect.gen(function* () {
      yield* setup()
      const saved = yield* PermissionSaved.Service
      yield* saved.add({ projectID: Project.ID.global, action: "bash", resources: ["pwd"] })

      const service = yield* Permission.Service
      expect(yield* service.ask(assertion({ action: "bash", resources: ["pwd"] }))).toEqual({
        id: Permission.ID.create("per_test"),
        effect: "allow",
      })
      expect(yield* service.list()).toEqual([])

      yield* setRules([{ action: "bash", resource: "*", effect: "deny" }])
      expect(yield* service.ask(assertion({ action: "bash", resources: ["pwd"] }))).toEqual({
        id: Permission.ID.create("per_test"),
        effect: "deny",
      })
    }),
  )

  it.effect("resolves an asked permission once", () =>
    Effect.gen(function* () {
      yield* setup()
      const { service, fiber, request } = yield* waitForRequest()
      expect(yield* service.list()).toEqual([request])
      expect(yield* service.forSession(request.sessionID)).toEqual([request])
      expect(yield* service.forSession(Session.ID.make("ses_other"))).toEqual([])
      expect(yield* service.get(request.id)).toEqual(request)
      yield* service.reply({ requestID: request.id, reply: "once" })
      yield* Fiber.join(fiber)
      expect(yield* service.list()).toEqual([])
      expect(yield* service.get(request.id)).toBeUndefined()
    }),
  )

  it.effect("defects when an asked permission is declined", () =>
    Effect.gen(function* () {
      yield* setup()
      const { service, fiber, request } = yield* waitForRequest()
      yield* service.reply({ requestID: request.id, reply: "reject" })
      const exit = yield* Fiber.await(fiber)

      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure")
        expect(
          exit.cause.reasons.some(
            (reason) => Cause.isDieReason(reason) && reason.defect instanceof Permission.DeclinedError,
          ),
        ).toBe(true)
      expect(yield* service.list()).toEqual([])
    }),
  )

  it.effect("stores and removes saved resources for a project", () =>
    Effect.gen(function* () {
      yield* setup()
      const service = yield* Permission.Service
      const asked = yield* Deferred.make<Permission.Request>()
      const bus = yield* Bus.Service
      const unsubscribe = yield* bus.listen((event) =>
        event.type === Permission.Event.Asked.type
          ? Deferred.succeed(asked, event.data as Permission.Request).pipe(Effect.asVoid)
          : Effect.void,
      )
      yield* Effect.addFinalizer(() => unsubscribe)
      const fiber = yield* service.assert(assertion({ save: ["src/*"] })).pipe(Effect.forkScoped)
      const request = yield* Deferred.await(asked)
      yield* service.reply({ requestID: request.id, reply: "always" })
      yield* Fiber.join(fiber)

      const { db } = yield* Database.Service
      expect(
        yield* db.select().from(PermissionTable).where(eq(PermissionTable.project_id, Project.ID.global)).all(),
      ).toMatchObject([{ action: "read", resource: "src/*" }])
      const saved = yield* PermissionSaved.Service
      const id = (yield* saved.list())[0]!.id
      expect(yield* saved.list()).toEqual([{ id, projectID: Project.ID.global, action: "read", resource: "src/*" }])
      yield* service.assert(assertion({ id: Permission.ID.create("per_next"), resources: ["src/next.ts"] }))
      yield* saved.remove(id)
      expect(yield* saved.list()).toEqual([])
    }),
  )

  for (const guard of ["configured deny", "missing Session"] as const) {
    it.effect(`skips pending auto-approval after always for ${guard}`, () =>
      Effect.gen(function* () {
        yield* setup()
        yield* setup([], Session.ID.make("ses_other"))
        const agents = yield* Agent.Service
        yield* agents.transform((editor) =>
          editor.update(Agent.ID.make("reviewer"), (agent) => {
            agent.permissions = []
          }),
        )
        const selected = yield* waitForRequest({ save: ["src/*"] })
        const other = yield* waitForRequest({
          id: Permission.ID.create("per_other"),
          sessionID: Session.ID.make("ses_other"),
          agent: Agent.ID.make("reviewer"),
        })
        if (guard === "configured deny") {
          yield* agents.transform((editor) =>
            editor.update(Agent.ID.make("reviewer"), (agent) => {
              agent.permissions = [{ action: "read", resource: "*", effect: "deny" }]
            }),
          )
        }
        if (guard === "missing Session") {
          const { db } = yield* Database.Service
          yield* db.delete(SessionTable).where(eq(SessionTable.id, other.request.sessionID)).run().pipe(Effect.orDie)
        }
        yield* selected.service.reply({ requestID: selected.request.id, reply: "always" })
        yield* Fiber.join(selected.fiber)
        expect(yield* selected.service.list()).toEqual([other.request])
        expect(other.fiber.pollUnsafe()).toBeUndefined()
        yield* Fiber.interrupt(other.fiber)
        expect(yield* selected.service.list()).toEqual([])
      }),
    )
  }
})

describe("shell scanner permission impact", () => {
  // Fixed cases require matching outcomes; remaining differences are investigation snapshots, not contracts.
  // These service-level cases all have command resources; tool tests cover skipped checks and directories.
  // Outcome pairs are [legacy, native].
  for (const fixture of [
    {
      name: "timed command preserves wrapper approvals",
      shell: "bash",
      command: "time -p git status",
      approved: ["time *"],
      exact: ["time -p git status"],
      denied: "time -p git status",
      savedEffect: ["allow", "allow"],
      exactEffect: ["allow", "allow"],
      deniedEffect: ["deny", "deny"],
    },
    {
      name: "coprocess command preserves wrapper approvals",
      shell: "bash",
      command: "coproc git status",
      approved: ["coproc *"],
      exact: ["coproc git status"],
      denied: "coproc git status",
      savedEffect: ["allow", "allow"],
      exactEffect: ["allow", "allow"],
      deniedEffect: ["deny", "deny"],
    },
    {
      name: "declarations and unset",
      shell: "bash",
      command: "export X=value; unset X; git status",
      approved: ["git status *"],
      exact: ["git status"],
      denied: "export *",
      savedEffect: ["allow", "allow"],
      exactEffect: ["allow", "allow"],
      deniedEffect: ["allow", "allow"],
    },
    {
      name: "export with an approved command substitution",
      shell: "bash",
      command: "export VERSION=$(git describe --tags); npm run build",
      approved: ["git describe *", "npm run build *"],
      exact: ["git describe --tags", "npm run build"],
      denied: "export *",
      savedEffect: ["allow", "allow"],
      exactEffect: ["allow", "allow"],
      deniedEffect: ["allow", "allow"],
    },
    {
      name: "export retains checks on the command substitution",
      shell: "bash",
      command: "export VERSION=$(git describe --tags); npm run build",
      approved: ["git describe *", "npm run build *"],
      exact: ["git describe --tags", "npm run build"],
      denied: "git describe *",
      savedEffect: ["allow", "allow"],
      exactEffect: ["allow", "allow"],
      deniedEffect: ["deny", "deny"],
    },
    {
      name: "redirect after a conditional list",
      shell: "bash",
      command: "printf ok && git status > output",
      approved: ["printf *", "git status *"],
      exact: ["printf ok", "git status"],
      denied: "git status",
      savedEffect: ["allow", "allow"],
      exactEffect: ["allow", "allow"],
      deniedEffect: ["deny", "deny"],
    },
    {
      name: "redirect after a pipeline",
      shell: "bash",
      command: "printf ok | cat < input > output",
      approved: ["printf *", "cat *"],
      exact: ["printf ok", "cat"],
      denied: "cat",
      savedEffect: ["allow", "allow"],
      exactEffect: ["allow", "allow"],
      deniedEffect: ["deny", "deny"],
    },
    {
      name: "assignment redirect followed by a command",
      shell: "bash",
      command: "FOO=bar > output; printf done",
      approved: ["printf *"],
      exact: ["printf done"],
      denied: "FOO=bar > output; printf done",
      savedEffect: ["ask", "allow"],
      exactEffect: ["ask", "allow"],
      deniedEffect: ["deny", "allow"],
    },
    {
      name: "assignment redirect with an approved command substitution",
      shell: "bash",
      command: "VERSION=$(git describe --tags) > build/version.txt",
      approved: ["git describe *"],
      exact: ["git describe --tags"],
      denied: "VERSION=$(git describe --tags) > build/version.txt",
      savedEffect: ["ask", "allow"],
      exactEffect: ["ask", "allow"],
      deniedEffect: ["deny", "allow"],
    },
    {
      name: "substitution in a saved prefix",
      shell: "bash",
      command: "git $(printf diff) --stat",
      approved: ["git *", "printf *"],
      exact: ["git $(printf diff) --stat", "printf diff"],
      denied: "git $(printf diff) --stat",
      savedEffect: ["allow", "allow"],
      exactEffect: ["allow", "allow"],
      deniedEffect: ["deny", "deny"],
    },
    {
      name: "standalone PowerShell scriptblock caller",
      shell: "pwsh",
      command: "ForEach-Object { Write-Output value }",
      approved: ["Write-Output *"],
      exact: ["Write-Output value"],
      denied: "ForEach-Object *",
      savedEffect: ["allow", "allow"],
      exactEffect: ["allow", "allow"],
      deniedEffect: ["allow", "allow"],
    },
    {
      name: "tab-separated PowerShell command",
      shell: "pwsh",
      command: "git\tstatus; Write-Output done",
      approved: ["git status *", "Write-Output *"],
      exact: ["git status", "Write-Output done"],
      denied: "git\tstatus",
      savedEffect: ["allow", "ask"],
      exactEffect: ["allow", "ask"],
      deniedEffect: ["allow", "deny"],
    },
    {
      name: "PowerShell equals-joined argument",
      shell: "pwsh",
      command: "git --work-tree=src status",
      approved: ["git --work-tree *"],
      exact: ["git --work-tree"],
      denied: "git --work-tree",
      savedEffect: ["allow", "ask"],
      exactEffect: ["allow", "ask"],
      deniedEffect: ["deny", "allow"],
    },
  ] as const) {
    for (const scenario of [
      { name: "no approval", saved: [], rules: [], expected: ["ask", "ask"] },
      { name: "saved wildcard", saved: ["*"], rules: [], expected: ["allow", "allow"] },
      { name: "saved command approvals", saved: fixture.approved, rules: [], expected: fixture.savedEffect },
      {
        name: "exact configured approvals",
        saved: [],
        rules: fixture.exact.map((resource): Permission.Rule => ({ action: "shell", resource, effect: "allow" })),
        expected: fixture.exactEffect,
      },
      {
        name: "exact saved approvals",
        saved: fixture.exact,
        rules: [],
        expected: fixture.exactEffect,
      },
      {
        name: "configured deny despite saved wildcard",
        saved: ["*"],
        rules: [{ action: "shell", resource: fixture.denied, effect: "deny" }] satisfies Permission.Ruleset,
        expected: fixture.deniedEffect,
      },
    ] as const) {
      it.live(`${fixture.name}: ${scenario.name}`, () =>
        Effect.gen(function* () {
          yield* setup(scenario.rules)
          const saved = yield* PermissionSaved.Service
          yield* saved.add({ projectID: Project.ID.global, action: "shell", resources: scenario.saved })
          const service = yield* Permission.Service

          for (const [index, portable] of [false, true].entries()) {
            const parsed = yield* ShellParse.scan(fixture.command, fixture.shell, "/project", { portable })
            expect(parsed.commands.length).toBeGreaterThan(0)
            expect(parsed.directories).toEqual([])
            const result = yield* service.ask(
              assertion({
                action: "shell",
                resources: parsed.commands.map((command) => command.resource),
                save: parsed.commands.map((command) => command.save),
              }),
            )
            expect(result.effect, portable ? "native" : "legacy").toBe(scenario.expected[index])
            const pending = yield* service.list()
            expect(pending).toHaveLength(result.effect === "ask" ? 1 : 0)
            if (result.effect !== "ask") continue
            expect(pending[0]?.resources).toEqual(parsed.commands.map((command) => command.resource))
            expect(pending[0]?.save).toEqual(parsed.commands.map((command) => command.save))
            yield* service.reply({ requestID: result.id, reply: "once" })
            expect(yield* service.list()).toEqual([])
          }
        }),
      )
    }
  }

  // Grant/repeat rows select the granting parser; repeat columns select the parser used afterwards.
  for (const fixture of [
    {
      name: "numeric npm script prefix",
      shell: "bash",
      command: "npm run 123",
      grants: [["npm run *"], ["npm run 123 *"]],
      repeat: [
        ["allow", "allow"],
        ["allow", "allow"],
      ],
      next: "npm run build",
      nextEffect: ["allow", "ask"],
    },
    {
      name: "numeric AWS option prefix",
      shell: "bash",
      command: "aws --cli-read-timeout 60 s3 ls",
      grants: [["aws --cli-read-timeout s3 *"], ["aws --cli-read-timeout 60 *"]],
      repeat: [
        ["ask", "ask"],
        ["allow", "allow"],
      ],
      next: "aws --cli-read-timeout 60 ec2 describe-instances",
      nextEffect: ["ask", "allow"],
    },
    {
      name: "substitution prefix",
      shell: "bash",
      command: "git $(printf diff) --stat",
      grants: [
        ["git --stat *", "printf *"],
        ["git $(printf diff) *", "printf *"],
      ],
      repeat: [
        ["ask", "ask"],
        ["allow", "allow"],
      ],
      next: "git --stat",
      nextEffect: ["allow", "ask"],
    },
    {
      name: "redirect prefix",
      shell: "bash",
      command: "printf ok && git status > output",
      grants: [
        ["printf *", "git status *"],
        ["printf *", "git status *"],
      ],
      repeat: [
        ["allow", "allow"],
        ["allow", "allow"],
      ],
      next: "git status --short",
      nextEffect: ["allow", "allow"],
    },
    {
      name: "assignment redirect prefix",
      shell: "bash",
      command: "FOO=bar > output; printf done",
      grants: [["printf *"], ["printf *"]],
      // Identical saved rules cover only the native resource, regardless of which parser saved them.
      repeat: [
        ["ask", "allow"],
        ["ask", "allow"],
      ],
      next: "printf next",
      nextEffect: ["allow", "allow"],
    },
    {
      name: "PowerShell tab prefix",
      shell: "pwsh",
      command: "git\tstatus; Write-Output done",
      grants: [["Write-Output *"], ["git\tstatus *", "Write-Output *"]],
      repeat: [
        ["allow", "ask"],
        ["allow", "allow"],
      ],
      next: "git status",
      nextEffect: ["ask", "ask"],
    },
  ] as const) {
    for (const [origin, portable] of [false, true].entries()) {
      it.live(`${fixture.name}: always allow from ${portable ? "native" : "legacy"}, then use either parser`, () =>
        Effect.gen(function* () {
          yield* setup()
          const service = yield* Permission.Service
          const saved = yield* PermissionSaved.Service
          const parsed = yield* ShellParse.scan(fixture.command, fixture.shell, "/project", { portable })
          const first = yield* service.ask(
            assertion({
              action: "shell",
              resources: parsed.commands.map((command) => command.resource),
              save: parsed.commands.map((command) => command.save),
            }),
          )
          expect(first.effect).toBe("ask")
          expect(yield* service.list()).toHaveLength(1)
          yield* service.reply({ requestID: first.id, reply: "always" })
          expect(yield* service.list()).toEqual([])
          expect((yield* saved.list({ projectID: Project.ID.global })).map((rule) => rule.resource).sort()).toEqual(
            [...fixture.grants[portable ? 1 : 0]].sort(),
          )

          for (const [index, target] of [false, true].entries()) {
            for (const command of [fixture.command, fixture.next]) {
              const parsed = yield* ShellParse.scan(command, fixture.shell, "/project", { portable: target })
              const result = yield* service.ask(
                assertion({
                  action: "shell",
                  resources: parsed.commands.map((command) => command.resource),
                  save: parsed.commands.map((command) => command.save),
                }),
              )
              expect(result.effect, `${target ? "native" : "legacy"}: ${command}`).toBe(
                command === fixture.next ? fixture.nextEffect[origin] : fixture.repeat[origin]?.[index],
              )
              if (result.effect === "ask") yield* service.reply({ requestID: result.id, reply: "once" })
              expect(yield* service.list()).toEqual([])
            }
          }
        }),
      )
    }
  }
})
