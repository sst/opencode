import fs from "fs/promises"
import { realpathSync, watch } from "node:fs"
import os from "os"
import path from "path"
import { describe, expect } from "bun:test"
import { Cause, Deferred, Duration, Effect, Exit, Fiber, Layer, Queue, Scope, Stream } from "effect"
import { Money } from "@opencode/schema/money"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { makeGlobalNode, makeLocationNode } from "@opencode/util/effect/app-node"
import { filesystem } from "@opencode/util/effect/app-node-platform"
import { Database } from "@opencode/core/database/database"
import { Bus } from "@opencode/core/bus"
import { Config } from "@opencode/core/config"
import { Environment } from "@opencode/core/environment/index"
import { FSUtil } from "@opencode/util/fs-util"
import { Global } from "@opencode/util/global"
import { Location } from "@opencode/core/location"
import { FileAccess } from "@opencode/core/file-access"
import { LocationServiceMap } from "@opencode/core/location-service-map"
import { Model } from "@opencode/core/model"
import { Provider } from "@opencode/core/provider"
import { AbsolutePath } from "@opencode/core/schema"
import { Agent } from "@opencode/core/agent"
import { Job } from "@opencode/core/job"
import { Session } from "@opencode/core/session"
import { SessionEvent } from "@opencode/core/session/event"
import { SessionExecution } from "@opencode/core/session/execution"
import { SessionMessage } from "@opencode/core/session/message"
import { SessionStore } from "@opencode/core/session/store"
import { Permission } from "@opencode/core/permission"
import { PermissionSaved } from "@opencode/core/permission/saved"
import { Plugin } from "@opencode/core/plugin"
import { PluginSupervisor } from "@opencode/core/plugin/supervisor"
import { Shell } from "@opencode/core/shell"
import { ShellSelect } from "@opencode/core/shell/select"
import { ID } from "@opencode/schema/shell"
import { ShellTool } from "@opencode/core/tool/plugin/shell"
import { ToolOutput } from "@opencode/core/tool-output"
import { Tool } from "@opencode/core/tool"
import { tmpdir, tmpdirScoped } from "./fixture/tmpdir"
import { tempGlobalLayer } from "./fixture/global"
import { offlineModels } from "./fixture/models"
import { testEffect } from "./lib/effect"
import { permissionLayer } from "./lib/permission"
import { Expected } from "./lib/session-message"
import { toolIdentity, executeTool, registerToolPlugin, toolDefinitions } from "./lib/tool"

const sessionID = Session.ID.make("ses_shell_tool_test")
const sessionModel = Model.Ref.make({ id: Model.ID.make("test"), providerID: Provider.ID.make("test") })
const assertions: Permission.AssertInput[] = []
let denyAction: string | undefined
let afterPermission = (_input: Permission.AssertInput): Effect.Effect<void> => Effect.void

const permission = permissionLayer({
  assert: (input) =>
    Effect.sync(() => assertions.push(input)).pipe(
      Effect.andThen(Effect.suspend(() => afterPermission(input))),
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

const reset = () => {
  assertions.length = 0
  denyAction = undefined
  afterPermission = () => Effect.void
}

const executionNode = makeGlobalNode({
  service: SessionExecution.Service,
  layer: Layer.effect(
    SessionExecution.Service,
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      const store = yield* SessionStore.Service
      const complete = Effect.fn("ShellTest.complete")(function* (id: Session.ID) {
        const session = yield* store.get(id)
        if (!session) return
        const assistantMessageID = SessionMessage.ID.create()
        yield* bus.publish(SessionEvent.Step.Started, {
          sessionID: id,
          assistantMessageID,
          agent: session.agent ?? Agent.ID.make("code"),
          model: sessionModel,
        })
        yield* bus.publish(SessionEvent.Text.Started, {
          sessionID: id,
          assistantMessageID,
          ordinal: 0,
        })
        yield* bus.publish(SessionEvent.Text.Ended, {
          sessionID: id,
          assistantMessageID,
          ordinal: 0,
          text: "ok",
        })
        yield* bus.publish(SessionEvent.Step.Ended, {
          sessionID: id,
          assistantMessageID,
          finish: "stop",
          cost: Money.USD.zero,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        })
      })
      return SessionExecution.Service.of({
        active: Effect.succeed(new Set()),
        isActive: () => Effect.succeed(false),
        resume: complete,
        wake: () => Effect.void,
        interrupt: () => Effect.succeed(false),
        awaitIdle: (id) => complete(id).pipe(Effect.exit, Effect.asVoid),
      })
    }),
  ),
  deps: [Bus.node, SessionStore.node],
})

const shellPluginSupervisor = makeLocationNode({
  name: "test/shell-plugins",
  layer: Layer.effectDiscard(registerToolPlugin(ShellTool.Plugin)),
  deps: [
    Config.node,
    Environment.node,
    FileAccess.node,
    Permission.node,
    Session.node,
    Job.node,
    Shell.node,
    ShellSelect.node,
    Tool.node,
  ],
})

const nodes = LayerNode.group([
  Database.node,
  Bus.node,
  Job.node,
  Session.node,
  SessionExecution.node,
  LocationServiceMap.node,
  filesystem,
  FSUtil.node,
  Global.node,
])
const replacements = [
  SessionExecution.node.replace(executionNode),
  Permission.node.replace(permission),
  Global.node.replace(tempGlobalLayer),
  offlineModels,
] satisfies LayerNode.Replacements
const productionIt = testEffect(AppNodeBuilder.build(nodes, replacements))
const it = testEffect(
  AppNodeBuilder.build(nodes, [...replacements, PluginSupervisor.node.replace(shellPluginSupervisor)]),
)
const permissionIt = testEffect(
  AppNodeBuilder.build(LayerNode.group([nodes, PermissionSaved.node]), [
    SessionExecution.node.replace(executionNode),
    Global.node.replace(tempGlobalLayer),
    PluginSupervisor.node.replace(shellPluginSupervisor),
    offlineModels,
  ]),
)

const call = (input: typeof ShellTool.Input.Type, id = "call-shell") => ({
  sessionID,
  ...toolIdentity,
  call: { type: "tool-call" as const, id, name: "shell", input },
})

const isWindows = process.platform === "win32"
const cwdCommand = isWindows ? "(Get-Location).Path; Start-Sleep -Milliseconds 100" : "pwd"
const helloCommand = isWindows ? "[Console]::Out.Write('hello'); Start-Sleep -Milliseconds 100" : "printf hello"
const stderrCommand = isWindows
  ? "[Console]::Error.Write('stderr only'); Start-Sleep -Milliseconds 100"
  : "printf 'stderr only' >&2"
const mixedOutputCommand = isWindows
  ? "[Console]::Out.Write('stdout'); Start-Sleep -Milliseconds 50; [Console]::Error.Write('stderr'); Start-Sleep -Milliseconds 100"
  : "printf stdout; sleep 0.05; printf stderr >&2"
const idleCommand = isWindows ? "Start-Sleep -Seconds 60" : "sleep 60"
const bodyExitCommand = isWindows
  ? "[Console]::Out.Write('body'); Start-Sleep -Milliseconds 100; exit 7"
  : "printf body && exit 7"
const overflowCommand = (bytes: number) =>
  isWindows
    ? `[Console]::Out.Write('output-start' + ('x' * ${bytes}) + 'output-end'); Start-Sleep -Milliseconds 100`
    : `printf output-start; head -c ${bytes} /dev/zero | tr '\\0' 'x'; printf output-end`
const lineOverflowCommand = isWindows
  ? "[Console]::Out.Write('one' + [Environment]::NewLine + 'two' + [Environment]::NewLine + 'three')"
  : "printf 'one\\ntwo\\nthree'"
const progressOverflowCommand = (bytes: number, release: string) =>
  isWindows
    ? `[Console]::Out.Write(('x' * ${bytes})); while (!(Test-Path -LiteralPath '${release}')) { Start-Sleep -Milliseconds 50 }`
    : `head -c ${bytes} /dev/zero | tr '\\0' 'x'; while [ ! -e '${release}' ]; do sleep 0.05; done`

const withSession = <A, E, R>(directory: string, body: (registry: Tool.Interface) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const location = Location.Ref.make({ directory: AbsolutePath.make(directory) })
    yield* sessions.create({
      id: sessionID,
      title: "shell test",
      location,
      model: sessionModel,
    })
    const locations = yield* LocationServiceMap.Service
    const locationLayer = locations.get(location)
    return yield* Effect.gen(function* () {
      const plugins = yield* Plugin.Service
      yield* plugins.awaitActivation
      const registry = yield* Tool.Service
      return yield* body(registry)
    }).pipe(Effect.provide(locationLayer), Effect.ensuring(locations.invalidate(location)))
  })

const withScanner = <A, E, R>(
  portable: boolean,
  body: (registry: Tool.Interface, fixture: { active: string; outside: string }) => Effect.Effect<A, E, R>,
  shell = "sh",
) =>
  Effect.acquireUseRelease(
    Effect.promise(() => tmpdir()),
    (tmp) =>
      Effect.gen(function* () {
        const fixture = { active: path.join(tmp.path, "active"), outside: path.join(tmp.path, "outside") }
        yield* Effect.promise(() => Promise.all([fs.mkdir(fixture.active), fs.mkdir(fixture.outside)]))
        yield* Effect.promise(() =>
          Bun.write(
            path.join(fixture.active, "opencode.json"),
            JSON.stringify({ experimental: { portable_shell_scanner: portable } }),
          ),
        )
        return yield* withSession(fixture.active, (registry) =>
          Effect.gen(function* () {
            const selection = yield* ShellSelect.Service
            yield* selection.transform((editor) => editor.configure(shell))
            const agents = yield* Agent.Service
            yield* agents.transform((editor) =>
              editor.update(toolIdentity.agent, (agent) => {
                agent.permissions = []
              }),
            )
            return yield* body(registry, fixture)
          }),
        )
      }),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
  )

const runPermissionCommand = (
  registry: Tool.Interface,
  command: string,
  marker: string,
  replies: ReadonlyArray<Permission.Reply>,
) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    const bus = yield* Bus.Service
    const queue = yield* Queue.unbounded<Permission.Request>()
    yield* bus.subscribe(Permission.Event.Asked).pipe(
      Stream.runForEach((event) => Queue.offer(queue, event.data)),
      Effect.forkScoped({ startImmediately: true }),
    )
    const execution = yield* executeTool(registry, call({ command }, `call-${Permission.ID.create()}`)).pipe(
      Effect.forkScoped,
    )
    const requests = yield* Effect.forEach(replies, (reply) =>
      Effect.gen(function* () {
        const request = yield* Queue.take(queue)
        expect(yield* permission.forSession(sessionID)).toEqual([request])
        expect(yield* Effect.promise(() => Bun.file(marker).exists())).toBe(false)
        yield* permission.reply({ requestID: request.id, reply })
        return request
      }),
    )
    const exit = yield* Fiber.await(execution)
    expect(yield* permission.list()).toEqual([])
    expect(yield* Queue.size(queue)).toBe(0)
    return { exit, requests }
  }).pipe(Effect.scoped, Effect.timeout(Duration.seconds(5)))

// Directory cases still document inherited limitations; fixed scanner cases require matching behavior.
describe("ShellTool scanner permissions", () => {
  const test = isWindows || !Bun.which("sh") ? permissionIt.live.skip : permissionIt.live
  for (const portable of [false, true]) {
    const scanner = portable ? "native" : "legacy"

    test(`${scanner}: declarations reuse approvals while substitutions retain reject/once/always behavior`, () =>
      withScanner(portable, (registry, fixture) =>
        Effect.gen(function* () {
          const saved = yield* PermissionSaved.Service
          const location = yield* Location.Service
          yield* saved.add({ projectID: location.project.id, action: "shell", resources: ["printf *"] })
          const marker = path.join(fixture.active, "marker")
          const approved = yield* runPermissionCommand(
            registry,
            "export SCAN_TEST=hello; unset SCAN_TEST; printf hello > marker",
            marker,
            [],
          )
          expect(approved.requests).toEqual([])
          expect(approved.exit).toMatchObject({
            _tag: "Success",
            value: { status: "completed", metadata: { exit: 0 } },
          })
          expect(yield* Effect.promise(() => Bun.file(marker).text())).toBe("hello")
          expect((yield* saved.list()).map((item) => item.resource)).toEqual(["printf *"])

          yield* Effect.forEach(yield* saved.list(), (item) => saved.remove(item.id))
          const command = 'export SCAN_TEST=$(printf hello); printf %s "$SCAN_TEST" > marker'
          const prompts: Permission.Request[] = []
          for (const reply of ["reject", "once", "always", undefined] as const) {
            yield* Effect.promise(() => fs.rm(marker, { force: true }))
            const result = yield* runPermissionCommand(registry, command, marker, reply ? [reply] : [])
            prompts.push(...result.requests)
            if (reply === "reject") {
              expect(Exit.isFailure(result.exit)).toBe(true)
              if (Exit.isFailure(result.exit))
                expect(
                  result.exit.cause.reasons.some(
                    (reason) => Cause.isDieReason(reason) && reason.defect instanceof Permission.DeclinedError,
                  ),
                ).toBe(true)
              expect(yield* Effect.promise(() => Bun.file(marker).exists())).toBe(false)
              continue
            }
            expect(result.exit).toMatchObject({
              _tag: "Success",
              value: { status: "completed", metadata: { exit: 0 } },
            })
            expect(yield* Effect.promise(() => Bun.file(marker).text())).toBe("hello")
            if (reply === "once") expect(yield* saved.list()).toEqual([])
          }
          expect(prompts).toHaveLength(3)
          for (const request of prompts) {
            expect(request).toMatchObject({
              action: "shell",
              resources: ["printf hello", 'printf %s "$SCAN_TEST" > marker'],
              save: ["printf *", "printf *"],
            })
          }
          expect((yield* saved.list()).map((item) => item.resource)).toEqual(["printf *"])

          const agents = yield* Agent.Service
          yield* agents.transform((editor) =>
            editor.update(toolIdentity.agent, (agent) => {
              agent.permissions = [{ action: "shell", resource: "printf hello", effect: "deny" }]
            }),
          )
          yield* Effect.promise(() => fs.rm(marker))
          const denied = yield* runPermissionCommand(registry, command, marker, [])
          expect(denied.exit).toMatchObject({
            _tag: "Success",
            value: { status: "error", error: { message: expect.stringContaining("Permission denied: shell") } },
          })
          expect(yield* Effect.promise(() => Bun.file(marker).exists())).toBe(false)
        }),
      ))

    test(`${scanner}: pipeline redirect preserves exact approval and denial despite broad saved approval`, () =>
      withScanner(portable, (registry, fixture) =>
        Effect.gen(function* () {
          const saved = yield* PermissionSaved.Service
          const location = yield* Location.Service
          yield* saved.add({ projectID: location.project.id, action: "shell", resources: ["printf hello", "cat"] })
          const marker = path.join(fixture.active, "marker")
          const command = "printf hello | cat > marker"
          const exact = yield* runPermissionCommand(registry, command, marker, [])
          expect(exact.requests).toEqual([])
          expect(exact.exit).toMatchObject({ _tag: "Success", value: { status: "completed", metadata: { exit: 0 } } })
          expect(yield* Effect.promise(() => Bun.file(marker).text())).toBe("hello")

          yield* saved.add({ projectID: location.project.id, action: "shell", resources: ["printf *", "cat *"] })
          yield* Effect.promise(() => fs.rm(marker))
          const broad = yield* runPermissionCommand(registry, command, marker, [])
          expect(broad.requests).toEqual([])
          expect(broad.exit).toMatchObject({ _tag: "Success", value: { status: "completed", metadata: { exit: 0 } } })
          expect(yield* Effect.promise(() => Bun.file(marker).text())).toBe("hello")

          const agents = yield* Agent.Service
          yield* agents.transform((editor) =>
            editor.update(toolIdentity.agent, (agent) => {
              agent.permissions = [{ action: "shell", resource: "cat", effect: "deny" }]
            }),
          )
          yield* Effect.promise(() => fs.rm(marker))
          const denied = yield* runPermissionCommand(registry, command, marker, [])
          expect(denied.requests).toEqual([])
          expect(denied.exit).toMatchObject({
            _tag: "Success",
            value: { status: "error", error: { message: expect.stringContaining("Permission denied: shell") } },
          })
          expect(yield* Effect.promise(() => Bun.file(marker).exists())).toBe(false)
        }),
      ))

    test(`${scanner}: external-directory rejection stops execution before a workspace marker is written`, () =>
      withScanner(portable, (registry, fixture) =>
        Effect.gen(function* () {
          const agents = yield* Agent.Service
          yield* agents.transform((editor) =>
            editor.update(toolIdentity.agent, (agent) => {
              agent.permissions = [{ action: "shell", resource: "*", effect: "allow" }]
            }),
          )
          const marker = path.join(fixture.active, "marker")
          const command = `cd '${fixture.outside}' && pwd -P && printf reached > '${marker}'`
          for (const reply of ["reject", "once"] as const) {
            const result = yield* runPermissionCommand(registry, command, marker, [reply])
            expect(result.requests).toMatchObject([
              { action: "external_directory", resources: [path.join(fixture.outside, "*")] },
            ])
            if (reply === "reject") {
              expect(Exit.isFailure(result.exit)).toBe(true)
              if (Exit.isFailure(result.exit))
                expect(
                  result.exit.cause.reasons.some(
                    (reason) => Cause.isDieReason(reason) && reason.defect instanceof Permission.DeclinedError,
                  ),
                ).toBe(true)
              expect(yield* Effect.promise(() => Bun.file(marker).exists())).toBe(false)
              continue
            }
            expect(result.exit).toMatchObject({
              _tag: "Success",
              value: {
                status: "completed",
                metadata: { exit: 0 },
                content: [{ type: "text", text: `${fixture.outside}\n` }, { type: "text" }],
              },
            })
            expect(yield* Effect.promise(() => Bun.file(marker).text())).toBe("reached")
          }
        }),
      ))

    test(`${scanner}: a numeric symlink operand still reaches outside without an external-directory prompt`, () =>
      withScanner(portable, (registry, fixture) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => fs.symlink(fixture.outside, path.join(fixture.active, "123")))
          const agents = yield* Agent.Service
          yield* agents.transform((editor) =>
            editor.update(toolIdentity.agent, (agent) => {
              agent.permissions = [
                { action: "shell", resource: "*", effect: "allow" },
                { action: "external_directory", resource: "*", effect: "deny" },
              ]
            }),
          )
          const marker = path.join(fixture.active, "marker")
          const result = yield* runPermissionCommand(
            registry,
            `cd 123 && pwd -P && printf reached > '${marker}'`,
            marker,
            [],
          )
          expect(result.requests).toEqual([])
          expect(result.exit).toMatchObject({
            _tag: "Success",
            value: {
              status: "completed",
              metadata: { exit: 0 },
              content: [{ type: "text", text: `${fixture.outside}\n` }, { type: "text" }],
            },
          })
          expect(yield* Effect.promise(() => Bun.file(marker).text())).toBe("reached")
        }),
      ))

    test(`${scanner}: a continued directory operand asks for the wrong path and misses the destination deny`, () =>
      withScanner(portable, (registry, fixture) =>
        Effect.gen(function* () {
          const agents = yield* Agent.Service
          yield* agents.transform((editor) =>
            editor.update(toolIdentity.agent, (agent) => {
              agent.permissions = [
                { action: "shell", resource: "*", effect: "allow" },
                { action: "external_directory", resource: path.join(fixture.outside, "*"), effect: "deny" },
              ]
            }),
          )
          const marker = path.join(fixture.active, "marker")
          const command = `cd ../out\\\nside && pwd -P && printf reached > '${marker}'`
          for (const reply of ["reject", "once"] as const) {
            const result = yield* runPermissionCommand(registry, command, marker, [reply])
            expect(result.requests).toMatchObject([
              {
                action: "external_directory",
                resources: [
                  path.join(fixture.active, "..", portable ? "out\\\nside" : "out", "*").replaceAll("\\", "/"),
                ],
              },
            ])
            if (reply === "reject") {
              expect(Exit.isFailure(result.exit)).toBe(true)
              if (Exit.isFailure(result.exit))
                expect(
                  result.exit.cause.reasons.some(
                    (reason) => Cause.isDieReason(reason) && reason.defect instanceof Permission.DeclinedError,
                  ),
                ).toBe(true)
              expect(yield* Effect.promise(() => Bun.file(marker).exists())).toBe(false)
              continue
            }
            expect(result.exit).toMatchObject({
              _tag: "Success",
              value: {
                status: "completed",
                metadata: { exit: 0 },
                content: [{ type: "text", text: `${fixture.outside}\n` }, { type: "text" }],
              },
            })
            expect(yield* Effect.promise(() => Bun.file(marker).text())).toBe("reached")
          }
        }),
      ))
  }
})

describe("ShellTool conditional process substitution", () => {
  const test = isWindows || !Bun.which("bash") ? permissionIt.live.skip : permissionIt.live
  for (const portable of [false, true]) {
    test(`${portable ? "native" : "legacy"}: a nested deny prevents the substitution from running`, () =>
      withScanner(
        portable,
        (registry, directory) =>
          Effect.gen(function* () {
            const agents = yield* Agent.Service
            yield* agents.transform((editor) =>
              editor.update(toolIdentity.agent, (agent) => {
                agent.permissions = [
                  { action: "shell", resource: "*", effect: "allow" },
                  { action: "shell", resource: "printf *", effect: "deny" },
                ]
              }),
            )
            const marker = path.join(directory.active, "marker")
            const result = yield* runPermissionCommand(
              registry,
              '[[ -n <(printf reached > marker) ]]; wait "$!"',
              marker,
              [],
            )
            expect(result.exit).toMatchObject({
              _tag: "Success",
              value: { status: "error", error: { message: expect.stringContaining("Permission denied: shell") } },
            })
            expect(yield* Effect.promise(() => Bun.file(marker).exists())).toBe(false)
          }),
        "bash",
      ))

    for (const reply of ["reject", "once", "always"] as const) {
      test(`${portable ? "native" : "legacy"}: conditional substitutions respect ${reply}`, () =>
        withScanner(
          portable,
          (registry, directory) =>
            Effect.gen(function* () {
              const saved = yield* PermissionSaved.Service
              const location = yield* Location.Service
              yield* saved.add({ projectID: location.project.id, action: "shell", resources: ["wait *"] })
              const marker = path.join(directory.active, "marker")
              const command = '[[ -n <(printf reached > marker) ]]; wait "$!"'
              const result = yield* runPermissionCommand(registry, command, marker, [reply])
              expect(result.requests).toMatchObject([
                { action: "shell", resources: ["printf reached > marker", 'wait "$!"'], save: ["printf *", "wait *"] },
              ])
              if (reply === "reject") {
                expect(Exit.isFailure(result.exit)).toBe(true)
                expect(yield* Effect.promise(() => Bun.file(marker).exists())).toBe(false)
                return
              }
              expect(result.exit).toMatchObject({
                _tag: "Success",
                value: { status: "completed", metadata: { exit: 0 } },
              })
              expect(yield* Effect.promise(() => Bun.file(marker).text())).toBe("reached")
              yield* Effect.promise(() => fs.unlink(marker))
              const repeat = yield* runPermissionCommand(
                registry,
                command,
                marker,
                reply === "always" ? [] : ["reject"],
              )
              expect(repeat.requests).toHaveLength(reply === "always" ? 0 : 1)
              expect(yield* Effect.promise(() => Bun.file(marker).exists())).toBe(reply === "always")
            }),
          "bash",
        ))
    }
  }
})

describe("ShellTool compound syntax approval compatibility", () => {
  for (const fixture of [
    {
      shell: "zsh",
      command: 'for value (a b) printf %s "$value"',
      equivalent: 'for value in a b; do printf %s "$value"; done',
      output: "ab",
      saved: ["printf *"],
    },
    {
      shell: "zsh",
      command: 'for value (a b) { printf %s "$value"; }',
      equivalent: 'for value in a b; do printf %s "$value"; done',
      output: "ab",
      saved: ["printf *"],
    },
    {
      shell: "zsh",
      command: 'for value ($(printf a)) do printf %s "$value"; done',
      equivalent: 'for value in $(printf a); do printf %s "$value"; done',
      output: "a",
      saved: ["printf *"],
    },
    {
      shell: "bash",
      command: 'probe() for value in a b; do printf %s "$value"; done; probe',
      equivalent: 'probe() { for value in a b; do printf %s "$value"; done; }; probe',
      output: "ab",
      saved: ["printf *", "probe *"],
    },
    {
      shell: "bash",
      command: 'printf %s "$(probe() case value in value) printf hello;; esac; probe)"',
      equivalent: 'printf %s "$(probe() { case value in value) printf hello;; esac; }; probe)"',
      output: "hello",
      saved: ["printf *", "probe *"],
    },
  ]) {
    const test = isWindows || !Bun.which(fixture.shell) ? permissionIt.live.skip : permissionIt.live
    for (const portable of [false, true]) {
      test(`${fixture.shell} ${portable ? "native" : "legacy equivalent"}: ${fixture.command}`, () =>
        withScanner(
          portable,
          (registry, directory) =>
            Effect.gen(function* () {
              const saved = yield* PermissionSaved.Service
              const location = yield* Location.Service
              yield* saved.add({ projectID: location.project.id, action: "shell", resources: fixture.saved })
              const result = yield* runPermissionCommand(
                registry,
                portable ? fixture.command : fixture.equivalent,
                path.join(directory.active, "marker"),
                [],
              )
              expect(result.requests).toEqual([])
              expect(result.exit).toMatchObject({
                _tag: "Success",
                value: {
                  status: "completed",
                  metadata: { exit: 0 },
                  content: [{ type: "text", text: fixture.output }, { type: "text" }],
                },
              })
            }),
          fixture.shell,
        ))
    }
  }
})

describe("ShellTool ordinary shell syntax", () => {
  for (const shell of ["bash", "zsh"]) {
    const test = isWindows || !Bun.which(shell) ? permissionIt.live.skip : permissionIt.live
    for (const portable of [false, true]) {
      for (const fixture of [
        { name: "quoted heredoc", command: "cat <<'EOF'\nhello\nEOF", output: "hello\n", saved: ["cat *"] },
        {
          name: "heredoc substitution",
          command: "cat <<EOF\n$(printf hello)\nEOF",
          output: "hello\n",
          saved: ["cat *", "printf *"],
        },
        {
          name: "loop with a conditional",
          command: 'for value in a b; do if test -n "$value"; then printf %s "$value"; fi; done',
          output: "ab",
          saved: ["test *", "printf *"],
        },
        {
          name: "function and case",
          command: 'greet() { case "$1" in a) printf hello;; *) printf other;; esac; }; greet a',
          output: "hello",
          saved: ["greet *", "printf *"],
        },
        {
          name: "parameter fallback",
          command: 'value=; printf %s "${value:-fallback}"',
          output: "fallback",
          saved: ["printf *"],
        },
        {
          name: "arithmetic statement",
          command: 'count=1; ((count += 1)); printf %s "$count"',
          output: "2",
          saved: ["((count += 1)) *", "printf *"],
        },
        { name: "ANSI-C quoting", command: "printf %s $'a\\nb'", output: "a\nb", saved: ["printf *"] },
      ]) {
        test(`${shell} ${portable ? "native" : "legacy"}: ${fixture.name} reuses existing approvals`, () =>
          withScanner(
            portable,
            (registry, directory) =>
              Effect.gen(function* () {
                const saved = yield* PermissionSaved.Service
                const location = yield* Location.Service
                yield* saved.add({ projectID: location.project.id, action: "shell", resources: fixture.saved })
                const result = yield* runPermissionCommand(
                  registry,
                  fixture.command,
                  path.join(directory.active, "marker"),
                  [],
                )
                expect(result.requests).toEqual([])
                expect(result.exit).toMatchObject({
                  _tag: "Success",
                  value: {
                    status: "completed",
                    metadata: { exit: 0 },
                    content: [{ type: "text", text: fixture.output }, { type: "text" }],
                  },
                })
              }),
            shell,
          ))
      }

      test(`${shell} ${portable ? "native" : "legacy"}: a loop body deny prevents execution`, () =>
        withScanner(
          portable,
          (registry, directory) =>
            Effect.gen(function* () {
              const agents = yield* Agent.Service
              yield* agents.transform((editor) =>
                editor.update(toolIdentity.agent, (agent) => {
                  agent.permissions = [
                    { action: "shell", resource: "*", effect: "allow" },
                    { action: "shell", resource: "printf *", effect: "deny" },
                  ]
                }),
              )
              const marker = path.join(directory.active, "marker")
              const result = yield* runPermissionCommand(
                registry,
                "for value in a; do printf body > marker; done",
                marker,
                [],
              )
              expect(result.exit).toMatchObject({
                _tag: "Success",
                value: { status: "error", error: { message: expect.stringContaining("Permission denied: shell") } },
              })
              expect(yield* Effect.promise(() => Bun.file(marker).exists())).toBe(false)
            }),
          shell,
        ))
    }
  }

  const pwsh = process.env.SHELL_SCAN_PWSH ?? Bun.which("pwsh") ?? Bun.which("powershell")
  const test = pwsh ? permissionIt.live : permissionIt.live.skip
  for (const portable of [false, true]) {
    for (const command of [
      'Write-Output "$(Write-Output hello)"',
      '$value = "hello"; Write-Output $value',
      "if ($true) { Write-Output hello } else { Write-Output other }",
      "foreach ($value in @('hello')) { Write-Output $value }",
      "ForEach-Object { Write-Output hello }",
      "function Show-Value { Write-Output hello }; Show-Value",
      "Write-Output `\n  hello",
      "Write-Output @'\nhello\n'@",
    ]) {
      test(`PowerShell ${portable ? "native" : "legacy"}: ordinary syntax reuses approvals: ${command}`, () =>
        withScanner(
          portable,
          (registry, directory) =>
            Effect.gen(function* () {
              const saved = yield* PermissionSaved.Service
              const location = yield* Location.Service
              yield* saved.add({
                projectID: location.project.id,
                action: "shell",
                resources: ["Write-Output *", "Show-Value *"],
              })
              const result = yield* runPermissionCommand(registry, command, path.join(directory.active, "marker"), [])
              expect(result.requests).toEqual([])
              expect(result.exit).toMatchObject({
                _tag: "Success",
                value: { status: "completed", metadata: { exit: 0 } },
              })
              if (Exit.isSuccess(result.exit))
                expect(result.exit.value.content?.[0]).toEqual(Expected.text(isWindows ? "hello\r\n" : "hello\n"))
            }),
          pwsh ?? "pwsh",
        ))
    }
  }

  for (const [command, pattern] of [
    ["Write-Output\thello", "Write-Output\t*"],
    ["& 'Write-Output' hello", "& 'Write-Output' *"],
    ["Write-Output `\n  hello", "Write-Output *"],
  ]) {
    test(`PowerShell native: always allow covers repeat execution and preserves exact deny: ${command}`, () =>
      withScanner(
        true,
        (registry, directory) =>
          Effect.gen(function* () {
            const marker = path.join(directory.active, "marker")
            const first = yield* runPermissionCommand(registry, command, marker, ["always"])
            expect(first.requests).toMatchObject([{ action: "shell", resources: [command], save: [pattern] }])
            expect(first.exit).toMatchObject({ _tag: "Success", value: { status: "completed", metadata: { exit: 0 } } })
            const repeat = yield* runPermissionCommand(registry, command, marker, [])
            expect(repeat.requests).toEqual([])
            expect(repeat.exit).toMatchObject({
              _tag: "Success",
              value: { status: "completed", metadata: { exit: 0 } },
            })

            const agents = yield* Agent.Service
            yield* agents.transform((editor) =>
              editor.update(toolIdentity.agent, (agent) => {
                agent.permissions = [{ action: "shell", resource: command, effect: "deny" }]
              }),
            )
            const denied = yield* runPermissionCommand(registry, command, marker, [])
            expect(denied.exit).toMatchObject({
              _tag: "Success",
              value: { status: "error", error: { message: expect.stringContaining("Permission denied: shell") } },
            })
          }),
        pwsh ?? "pwsh",
      ))
  }
})

describe("ShellTool", () => {
  it.live("returns both parallel CodeMode shell results", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        return withSession(tmp.path, (registry) =>
          Effect.gen(function* () {
            yield* registry.transform((editor) =>
              editor.update("shell", (tool) => {
                tool.options = { ...tool.options, codemode: true }
              }),
            )
            const command = isWindows ? helloCommand : `${helloCommand}; sleep 0.1`
            const inputs = ["one", "two"].map((text) => JSON.stringify({ command: command.replace("hello", text) }))
            const result = yield* executeTool(registry, {
              sessionID,
              ...toolIdentity,
              call: {
                type: "tool-call",
                id: "call-parallel-shells",
                name: "execute",
                input: { code: `return await Promise.all([tools.shell(${inputs[0]}), tools.shell(${inputs[1]})])` },
              },
            }).pipe(Effect.timeout("3 seconds"))
            expect(result.status).toBe("completed")
            expect(JSON.parse(result.output.output)).toEqual([
              { output: "one", exit: 0, truncated: false, status: "completed" },
              { output: "two", exit: 0, truncated: false, status: "completed" },
            ])
          }),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
    ),
  )

  productionIt.live(
    "registers and returns real successful output from the active Location",
    () =>
      Effect.acquireUseRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => {
          reset()
          return withSession(tmp.path, (registry) =>
            Effect.gen(function* () {
              const definitions = yield* toolDefinitions(registry)
              const definition = definitions.find((tool) => tool.name === "shell")
              expect(definition?.description).toStartWith("Execute a shell command and return its output.")
              expect(definition?.inputSchema).not.toHaveProperty("properties.timeout.maximum")
              // Code Mode receives the declared output schema, including the command output text.
              expect(definition?.outputSchema).toHaveProperty("properties.output")
              expect(
                (yield* toolDefinitions(registry, [{ action: "shell", resource: "*", effect: "deny" }])).map(
                  (tool) => tool.name,
                ),
              ).not.toContain("shell")

              const settled = yield* executeTool(registry, call({ command: helloCommand }))
              expect(settled.status).toBe("completed")
              expect(settled.metadata).toMatchObject({ exit: 0, truncated: false })
              expect(settled.content?.[0]).toEqual({ type: "text", text: "hello" })
              expect(settled.content?.[1]).toMatchObject(
                Expected.text(expect.stringContaining("Command exited with code 0.")),
              )
              expect(assertions).toMatchObject([
                {
                  sessionID,
                  action: "shell",
                  resources: [isWindows ? "Start-Sleep -Milliseconds 100" : helloCommand],
                  agent: toolIdentity.agent,
                  source: { type: "tool", messageID: toolIdentity.messageID, id: "call-shell" },
                },
              ])
              expect(assertions[0]?.save).toEqual([isWindows ? "Start-Sleep *" : "printf *"])
            }),
          )
        },
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
      ),
    { timeout: 15_000 },
  )

  productionIt.live(
    "uses the session environment instead of the server environment",
    () =>
      Effect.acquireUseRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => {
          reset()
          return withSession(tmp.path, (registry) =>
            Effect.gen(function* () {
              const sessions = yield* Session.Service
              yield* sessions.environment({
                sessionID,
                variables: { OPENCODE_SESSION_ENV_TEST: "from-session" },
              })
              const command = isWindows
                ? "[Console]::Out.Write($env:OPENCODE_SESSION_ENV_TEST)"
                : 'printf %s "$OPENCODE_SESSION_ENV_TEST"'

              const settled = yield* executeTool(registry, call({ command }))

              expect(settled.status).toBe("completed")
              expect(settled.content?.[0]).toEqual({ type: "text", text: "from-session" })
            }),
          )
        },
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
      ),
    { timeout: 15_000 },
  )

  it.live("resolves a relative workdir from the active Location", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        return Effect.promise(() => fs.mkdir(path.join(tmp.path, "src"))).pipe(
          Effect.andThen(
            withSession(tmp.path, (registry) => executeTool(registry, call({ command: cwdCommand, workdir: "src" }))),
          ),
          Effect.andThen((settled) =>
            Effect.sync(() =>
              expect(settled.content?.[0]).toMatchObject(
                Expected.text(expect.stringContaining(realpathSync(path.join(tmp.path, "src")))),
              ),
            ),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
    ),
  )

  it.live("reports a missing workdir", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        return withSession(tmp.path, (registry) =>
          executeTool(registry, call({ command: cwdCommand, workdir: "missing" })),
        ).pipe(
          Effect.andThen((settled) =>
            Effect.sync(() =>
              expect(settled).toEqual({
                status: "error",
                error: {
                  type: "unknown",
                  message: `Working directory does not exist: ${path.join(tmp.path, "missing")}`,
                },
              }),
            ),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
    ),
  )

  it.live(
    "permissions compound commands separately",
    () =>
      Effect.acquireUseRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => {
          reset()
          return withSession(tmp.path, (registry) =>
            executeTool(registry, call({ command: "printf one && printf two" }, "call-compound")),
          ).pipe(
            Effect.andThen(
              Effect.sync(() => {
                expect(assertions).toHaveLength(1)
                expect(assertions[0]).toMatchObject({
                  resources: ["printf one", "printf two"],
                  save: ["printf *", "printf *"],
                })
              }),
            ),
          )
        },
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
      ),
    { timeout: 15_000 },
  )

  it.live(
    "captures stderr-only and mixed stdout/stderr output",
    () =>
      Effect.acquireUseRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => {
          reset()
          return withSession(tmp.path, (registry) =>
            Effect.gen(function* () {
              const stderr = yield* executeTool(registry, call({ command: stderrCommand }, "call-stderr"))
              expect(stderr.metadata).toMatchObject({ exit: 0, truncated: false })
              expect(stderr.content?.[0]).toEqual({ type: "text", text: "stderr only" })

              const mixed = yield* executeTool(registry, call({ command: mixedOutputCommand }, "call-mixed"))
              expect(mixed.metadata).toMatchObject({ exit: 0, truncated: false })
              const output = mixed.content?.[0]?.type === "text" ? mixed.content[0].text : ""
              expect(output).toContain("stdout")
              expect(output).toContain("stderr")
            }),
          )
        },
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
      ),
    { timeout: 15_000 },
  )

  it.live("rejects a workdir that stops being a directory during approval", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        const workdir = path.join(tmp.path, "src")
        afterPermission = (input) =>
          input.action === "shell"
            ? Effect.promise(async () => {
                await fs.rm(workdir, { recursive: true })
                await fs.writeFile(workdir, "not a directory")
              }).pipe(Effect.orDie)
            : Effect.void
        return Effect.promise(() => fs.mkdir(workdir)).pipe(
          Effect.andThen(
            withSession(tmp.path, (registry) => executeTool(registry, call({ command: cwdCommand, workdir: "src" }))),
          ),
          Effect.andThen((settled) =>
            Effect.sync(() => {
              expect(settled).toMatchObject({
                status: "error",
                error: { message: `Working directory is not a directory: ${workdir}` },
              })
              expect(assertions.map((input) => input.action)).toEqual(["shell"])
            }),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
    ),
  )

  it.live(
    "approves an explicit external workdir before shell execution",
    () =>
      Effect.acquireUseRelease(
        Effect.promise(() => Promise.all([tmpdir(), tmpdir()])),
        ([active, outside]) => {
          reset()
          return withSession(active.path, (registry) =>
            executeTool(registry, call({ command: cwdCommand, workdir: outside.path })),
          ).pipe(
            Effect.andThen(
              Effect.sync(() => {
                expect(assertions.map((item) => item.action)).toEqual(["external_directory", "shell"])
                expect(assertions[0]).toMatchObject({
                  resources: [path.join(realpathSync(outside.path), "*").replaceAll("\\", "/")],
                })
              }),
            ),
          )
        },
        ([active, outside]) =>
          Effect.promise(() =>
            Promise.all([active[Symbol.asyncDispose](), outside[Symbol.asyncDispose]()]).then(() => undefined),
          ),
      ),
    { timeout: 15_000 },
  )

  it.live(
    "deduplicates external directory approvals across workdir and directory-change commands",
    () =>
      Effect.acquireUseRelease(
        Effect.promise(() => Promise.all([tmpdir(), tmpdir()])),
        ([active, outside]) => {
          const command = isWindows
            ? `Set-Location -LiteralPath '${outside.path}'; (Get-Location).Path`
            : `cd '${outside.path}' && pwd`
          return withSession(active.path, (registry) =>
            Effect.forEach([{ command }, { command, workdir: outside.path }], (input) =>
              Effect.gen(function* () {
                reset()
                const settled = yield* executeTool(registry, call(input, "call-external-cd"))
                expect(settled).toMatchObject({ status: "completed" })
                expect(assertions.map((item) => item.action)).toEqual(["external_directory", "shell"])
                expect(assertions[0]).toMatchObject({
                  resources: [path.join(realpathSync(outside.path), "*").replaceAll("\\", "/")],
                  sessionID,
                  agent: toolIdentity.agent,
                  source: { type: "tool", messageID: toolIdentity.messageID, id: "call-external-cd" },
                })
              }),
            ),
          )
        },
        ([active, outside]) =>
          Effect.promise(() =>
            Promise.all([active[Symbol.asyncDispose](), outside[Symbol.asyncDispose]()]).then(() => undefined),
          ),
      ),
    { timeout: 15_000 },
  )

  it.live("approves an expanded external home directory", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        const command = isWindows ? "Set-Location $HOME; (Get-Location).Path" : "cd ~ && pwd"
        return withSession(tmp.path, (registry) => executeTool(registry, call({ command }, "call-external-home"))).pipe(
          Effect.andThen(
            Effect.sync(() => {
              expect(assertions.map((item) => item.action)).toEqual(["external_directory", "shell"])
              expect(assertions[0]?.resources[0]).toStartWith(os.homedir().replaceAll("\\", "/"))
            }),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
    ),
  )

  it.live(
    "does not execute after external-directory or shell denial",
    () =>
      Effect.acquireUseRelease(
        Effect.promise(() => Promise.all([tmpdir(), tmpdir()])),
        ([active, outside]) =>
          Effect.gen(function* () {
            reset()
            denyAction = "external_directory"
            yield* withSession(active.path, (registry) =>
              executeTool(registry, call({ command: cwdCommand, workdir: outside.path })),
            )
            expect(assertions.map((item) => item.action)).toEqual(["external_directory"])

            reset()
            denyAction = "shell"
            yield* withSession(active.path, (registry) => executeTool(registry, call({ command: cwdCommand })))
            expect(assertions.map((item) => item.action)).toEqual(["shell"])
          }),
        ([active, outside]) =>
          Effect.promise(() =>
            Promise.all([active[Symbol.asyncDispose](), outside[Symbol.asyncDispose]()]).then(() => undefined),
          ),
      ),
    { timeout: 15_000 },
  )

  it.live("exposes malformed native syntax without fallback or partial execution", () =>
    Effect.gen(function* () {
      if (isWindows) return
      for (const portable of [false, true]) {
        yield* Effect.acquireUseRelease(
          Effect.promise(() => tmpdir()),
          (tmp) =>
            Effect.gen(function* () {
              reset()
              yield* Effect.promise(() =>
                Bun.write(
                  path.join(tmp.path, "opencode.json"),
                  JSON.stringify({ experimental: { portable_shell_scanner: portable } }),
                ),
              )
              const settled = yield* withSession(tmp.path, (registry) =>
                Effect.gen(function* () {
                  const selection = yield* ShellSelect.Service
                  yield* selection.transform((editor) => editor.configure("sh"))
                  return yield* executeTool(
                    registry,
                    call({ command: 'printf hello > marker\necho "' }, "call-portable-malformed"),
                  )
                }),
              )
              if (portable) {
                expect(settled).toMatchObject({
                  status: "error",
                  error: { message: expect.stringContaining("unterminated-quote") },
                })
                expect(assertions).toEqual([])
                expect(yield* Effect.promise(() => Bun.file(path.join(tmp.path, "marker")).exists())).toBe(false)
                return
              }
              expect(settled.status).toBe("completed")
              expect(settled.metadata?.exit).not.toBe(0)
              expect(assertions.map((item) => item.action)).toEqual(["shell"])
              expect(yield* Effect.promise(() => Bun.file(path.join(tmp.path, "marker")).text())).toBe("hello")
            }),
          (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
        )
      }
    }),
  )

  for (const shell of ["sh", "zsh"]) {
    const test = isWindows || !Bun.which(shell) ? it.live.skip : it.live
    test(
      `preserves arithmetic and directory permissions with scanner flag on and off in ${shell}`,
      () =>
        Effect.gen(function* () {
          const results = yield* Effect.forEach([false, true], (portable) =>
            Effect.acquireUseRelease(
              Effect.promise(() => tmpdir()),
              (tmp) =>
                Effect.gen(function* () {
                  reset()
                  yield* Effect.promise(() =>
                    Bun.write(
                      path.join(tmp.path, "opencode.json"),
                      JSON.stringify({ experimental: { portable_shell_scanner: portable } }),
                    ),
                  )
                  yield* Effect.promise(() => fs.mkdir(path.join(tmp.path, "one", "two"), { recursive: true }))
                  yield* withSession(tmp.path, (registry) =>
                    Effect.gen(function* () {
                      const selection = yield* ShellSelect.Service
                      yield* selection.transform((editor) => editor.configure(shell))
                      for (const [command, output] of [
                        ["echo $((1 + 1))", "2\n"],
                        ["cd ~ && pwd", `${realpathSync(os.homedir())}\n`],
                        ["cd one&&cd two&&pwd", `${path.join(tmp.path, "one", "two")}\n`],
                      ]) {
                        const settled = yield* executeTool(registry, call({ command }, `call-parity-${command}`))
                        expect(settled.status).toBe("completed")
                        expect(settled.metadata).toMatchObject({ exit: 0 })
                        expect(settled.content?.[0]).toMatchObject({ type: "text", text: output })
                      }
                    }),
                  )
                  expect(assertions.map((item) => item.action)).toEqual([
                    "shell",
                    "external_directory",
                    "shell",
                    "shell",
                  ])
                  expect(assertions[1]?.resources).toEqual([path.join(realpathSync(os.homedir()), "*")])
                  expect(assertions[0]).toMatchObject({ resources: ["echo $((1 + 1))"], save: ["echo *"] })
                  expect(assertions[2]).toMatchObject({ resources: ["pwd"], save: ["pwd *"] })
                  expect(assertions[3]).toMatchObject({ resources: ["pwd"], save: ["pwd *"] })
                  return assertions.slice()
                }),
              (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
            ),
          )
          expect(results[1]).toEqual(results[0])
        }),
      { timeout: 15_000 },
    )
  }

  it.live("keeps non-zero exits useful", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        return withSession(tmp.path, (registry) =>
          executeTool(registry, call({ command: bodyExitCommand }, "call-nonzero")),
        ).pipe(
          Effect.andThen((settled) =>
            Effect.sync(() => {
              expect(settled.status).toBe("completed")
              expect(settled.metadata).toMatchObject({ exit: 7, truncated: false })
              expect(settled.content?.[0]).toEqual({ type: "text", text: "body" })
              expect(settled.content?.[1]).toMatchObject(
                Expected.text(expect.stringContaining("Command exited with code 7")),
              )
            }),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
    ),
  )

  it.live(
    "truncates the model view and points at the saved output file when output overflows",
    () =>
      Effect.acquireUseRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => {
          reset()
          const bytes = ToolOutput.MAX_BYTES + 1024
          return withSession(tmp.path, (registry) =>
            executeTool(registry, call({ command: overflowCommand(bytes) }, "call-overflow")),
          ).pipe(
            Effect.andThen((settled) =>
              Effect.sync(() => {
                expect(settled.metadata).toMatchObject({ exit: 0, truncated: true })
                const content = settled.content?.[0]
                if (!content || content.type !== "text") throw new Error("Expected text content")
                expect(content.text.includes("output-start")).toBe(false)
                expect(content.text.includes("output-end")).toBe(true)
                expect(content).toMatchObject(
                  Expected.text(expect.stringContaining("output truncated; full output saved to:")),
                )
              }),
            ),
          )
        },
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
      ),
    { timeout: 15_000 },
  )

  it.live("uses configured line limits", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        return Effect.gen(function* () {
          yield* Effect.promise(() =>
            Bun.write(
              path.join(tmp.path, "opencode.json"),
              JSON.stringify({ tool_output: { max_lines: 2, max_bytes: 1_000 } }),
            ),
          )
          const settled = yield* withSession(tmp.path, (registry) =>
            executeTool(registry, call({ command: lineOverflowCommand }, "call-line-overflow")),
          )
          expect(settled.metadata).toMatchObject({ exit: 0, truncated: true })
          const content = settled.content?.[0]
          if (!content || content.type !== "text") throw new Error("Expected text content")
          expect(content.text).not.toContain("one")
          // Windows shells emit CRLF; the assertion targets line limits, not line endings.
          expect(content.text.replaceAll("\r\n", "\n")).toStartWith("two\nthree")
          expect(content.text).toContain("output truncated; full output saved to:")
        })
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
    ),
  )

  it.live(
    "reports the shell ID for a running command",
    () =>
      Effect.acquireUseRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => {
          reset()
          const release = "shell-progress-release"
          const releasePath = path.join(tmp.path, release)
          return withSession(tmp.path, (registry) =>
            Effect.gen(function* () {
              const observed = yield* Deferred.make<string>()
              yield* executeTool(registry, {
                ...call({ command: progressOverflowCommand(ToolOutput.MAX_BYTES + 1024, release) }, "call-progress"),
                progress: (update) =>
                  Effect.gen(function* () {
                    if (typeof update.shellID !== "string") return
                    yield* Deferred.succeed(observed, update.shellID)
                    yield* Effect.promise(() => fs.writeFile(releasePath, ""))
                  }),
              })

              expect(yield* Deferred.await(observed)).toMatch(/^sh_/)
            }).pipe(Effect.ensuring(Effect.promise(() => fs.writeFile(releasePath, "")).pipe(Effect.ignore))),
          )
        },
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
      ),
    { timeout: 15_000 },
  )

  it.live(
    "reports shell ID progress once",
    () =>
      Effect.acquireUseRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => {
          reset()
          return withSession(tmp.path, (registry) =>
            Effect.gen(function* () {
              const updates: Tool.Metadata[] = []
              yield* executeTool(registry, {
                ...call({ command: helloCommand }, "call-shell-id-progress"),
                progress: (update) => Effect.sync(() => updates.push(update)),
              })
              expect(updates).toHaveLength(1)
              expect(updates[0]?.shellID).toMatch(/^sh_/)
            }),
          )
        },
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
      ),
    { timeout: 15_000 },
  )

  it.live("returns the shell id for a background command", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        return withSession(tmp.path, (registry) =>
          Effect.gen(function* () {
            const bus = yield* Bus.Service
            const admitted = yield* bus.subscribe(SessionEvent.InboxEnqueued).pipe(
              Stream.filter((event) => event.data.sessionID === sessionID && event.data.item.type === "synthetic"),
              Stream.runHead,
              Effect.forkScoped({ startImmediately: true }),
            )
            const settled = yield* executeTool(registry, call({ command: idleCommand, timeout: 50, background: true }))
            const shellID = typeof settled.metadata?.shellID === "string" ? settled.metadata.shellID : undefined
            expect(settled.metadata).toMatchObject({ truncated: false })
            expect(shellID).toStartWith("sh_")

            const shell = yield* Shell.Service
            if (!shellID) return
            const id = ID.make(shellID)
            const info = yield* shell.get(id)
            expect(settled.content).toEqual([
              {
                type: "text",
                text: `Command moved to the background (shell ID: ${shellID}).\nOutput is streaming to: ${info.file}`,
              },
              {
                type: "text",
                text: "You will be notified automatically when the command finishes. The notification will include the command's output. Unless the user explicitly asks otherwise, DO NOT poll for completion, even if you need the final result to continue. Repeatedly sleeping and reading or searching the output file is polling, not useful work. You may read the current output if it lets you do useful work now, but do not repeatedly check it while waiting for the command to finish. Keep working on anything that does not depend on the result. If you have nothing else to do, end your response; you will be resumed automatically when the command finishes.",
              },
            ])
            expect((yield* shell.list()).map((info) => info.id)).toContain(id)
            expect((yield* shell.wait(id)).status).toBe("timeout")
            expect((yield* Fiber.join(admitted)).valueOrUndefined?.data.item.payload).toMatchObject({
              text: expect.stringContaining("Command timed out before completion."),
              description: idleCommand,
              metadata: {
                source: "shell",
                shellID,
                state: "completed",
                timeout: true,
                truncated: false,
              },
            })
          }),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
    ),
  )

  it.live("preserves a background command's non-zero exit", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        return withSession(tmp.path, (registry) =>
          Effect.gen(function* () {
            const bus = yield* Bus.Service
            const admitted = yield* bus.subscribe(SessionEvent.InboxEnqueued).pipe(
              Stream.filter((event) => event.data.sessionID === sessionID && event.data.item.type === "synthetic"),
              Stream.runHead,
              Effect.forkScoped({ startImmediately: true }),
            )
            const settled = yield* executeTool(
              registry,
              call({ command: bodyExitCommand, background: true }, "call-background-nonzero"),
            )
            const shellID = settled.metadata?.shellID
            expect(typeof shellID).toBe("string")
            expect((yield* Fiber.join(admitted)).valueOrUndefined?.data.item.payload).toMatchObject({
              text: expect.stringContaining("Command exited with code 7."),
              description: bodyExitCommand,
              metadata: {
                source: "shell",
                jobID: shellID,
                shellID,
                state: "completed",
                exit: 7,
                truncated: false,
              },
            })
          }),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
    ),
  )

  it.live("persists a silent command that finishes before backgrounding", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        return withSession(tmp.path, (registry) =>
          Effect.gen(function* () {
            const bus = yield* Bus.Service
            const jobs = yield* Job.Service
            const shell = yield* Shell.Service
            const persisted = yield* Deferred.make<readonly Job.Background[]>()
            yield* bus.project(SessionEvent.InboxEnqueued, (event) =>
              event.data.sessionID === sessionID && event.data.item.type === "synthetic"
                ? jobs.pendingBackground.pipe(
                    Effect.flatMap((background) => Deferred.succeed(persisted, background)),
                    Effect.asVoid,
                  )
                : Effect.void,
            )
            const settled = yield* executeTool(registry, {
              ...call({ command: "exit 7", background: true }, "call-background-silent-nonzero"),
              // The command can finish while its initial progress update is being published.
              progress: (update) =>
                typeof update.shellID === "string"
                  ? shell.wait(ID.make(update.shellID)).pipe(Effect.orDie, Effect.asVoid)
                  : Effect.void,
            })

            expect(yield* Deferred.await(persisted)).toMatchObject([
              {
                id: settled.metadata?.shellID,
                status: "completed",
                output: "(no output)\n\nCommand exited with code 7.",
              },
            ])
          }),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
    ),
  )

  it.live(
    "updates and clears a running shell timeout",
    () =>
      Effect.acquireUseRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => {
          reset()
          return withSession(tmp.path, (registry) =>
            Effect.gen(function* () {
              const shell = yield* Shell.Service
              const timed = yield* executeTool(
                registry,
                call({ command: idleCommand, background: true }, "call-updated-timeout"),
              )
              const timedID = timed.metadata?.shellID
              expect(typeof timedID).toBe("string")
              if (typeof timedID !== "string") return
              const timedShellID = ID.make(timedID)
              yield* shell.timeout(timedShellID, 50)
              expect((yield* shell.wait(timedShellID)).status).toBe("timeout")

              const cleared = yield* executeTool(
                registry,
                call({ command: idleCommand, timeout: 50, background: true }, "call-cleared-timeout"),
              )
              const clearedID = cleared.metadata?.shellID
              expect(typeof clearedID).toBe("string")
              if (typeof clearedID !== "string") return
              const clearedShellID = ID.make(clearedID)
              yield* shell.timeout(clearedShellID, 0)
              yield* Effect.sleep(Duration.millis(100))
              expect((yield* shell.get(clearedShellID)).status).toBe("running")
              yield* shell.remove(clearedShellID)
            }),
          )
        },
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
      ),
    { timeout: 15_000 },
  )

  const signalTest = isWindows ? it.live.skip : it.live
  signalTest(
    "escalates a shell timeout when the ready process ignores SIGTERM",
    () =>
      Effect.gen(function* () {
        const tmp = yield* tmpdirScoped()
        const ready = yield* Deferred.make<void>()
        yield* Effect.acquireRelease(
          Effect.sync(() =>
            watch(tmp.path, (_event, filename) => {
              if (filename === "ready") Deferred.doneUnsafe(ready, Exit.void)
            }),
          ),
          (watcher) => Effect.sync(() => watcher.close()),
        )
        yield* withSession(tmp.path, () =>
          Effect.gen(function* () {
            const shell = yield* Shell.Service
            yield* Effect.acquireUseRelease(
              // Arm the timeout only after the child announces that SIGTERM is ignored.
              shell.create({
                shell: "/bin/sh",
                command: "trap '' TERM; : > ready; while :; do sleep 60; done",
                timeout: 0,
              }),
              (info) =>
                Effect.gen(function* () {
                  yield* Deferred.await(ready).pipe(Effect.timeout("5 seconds"))
                  yield* shell.timeout(info.id, 1)
                  // Completion must reap the process, not only mark the command as timed out.
                  expect((yield* shell.wait(info.id).pipe(Effect.timeout("10 seconds"))).status).toBe("timeout")
                  const pid = info.pid
                  if (pid === undefined) throw new Error("Expected shell PID")
                  expect(() => process.kill(pid, 0)).toThrow()
                }),
              (info) =>
                Effect.try(() => {
                  if (info.pid !== undefined) process.kill(-info.pid, "SIGKILL")
                }).pipe(
                  Effect.catch(() => Effect.void),
                  Effect.andThen(shell.remove(info.id)),
                ),
            )
          }),
        )
      }),
    { timeout: 30_000 },
  )

  if (!isWindows) {
    it.live("settles a shell terminated by an external signal", () =>
      Effect.acquireUseRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => {
          reset()
          return withSession(tmp.path, (registry) =>
            Effect.gen(function* () {
              const shell = yield* Shell.Service
              const settled = yield* executeTool(
                registry,
                call({ command: idleCommand, background: true }, "call-external-signal"),
              )
              const shellID = settled.metadata?.shellID
              expect(typeof shellID).toBe("string")
              if (typeof shellID !== "string") return
              const id = ID.make(shellID)
              const info = yield* shell.get(id)
              expect(typeof info.pid).toBe("number")
              if (info.pid === undefined) return

              process.kill(-info.pid, "SIGTERM")
              const result = yield* shell.wait(id).pipe(Effect.timeoutOption(Duration.seconds(1)))
              expect(result._tag).toBe("Some")
              if (result._tag === "Some") expect(result.value.status).toBe("exited")
              expect((yield* shell.list()).map((item) => item.id)).not.toContain(id)
            }),
          )
        },
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
      ),
    )
  }

  it.live("backgrounds a foreground command when the session is signaled", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        return withSession(tmp.path, (registry) =>
          Effect.gen(function* () {
            const jobs = yield* Job.Service
            const scope = yield* Scope.Scope
            const waiting = yield* executeTool(
              registry,
              call({ command: idleCommand, timeout: 50 }, "call-background-signal"),
            ).pipe(Effect.forkIn(scope, { startImmediately: true }))

            const backgroundWhenReady = (remaining = 1000): Effect.Effect<Job.Info[], Error> =>
              Effect.gen(function* () {
                const backgrounded = yield* jobs.backgroundAll({ sessionID })
                if (backgrounded.length > 0) return backgrounded
                if (remaining <= 0) return yield* Effect.fail(new Error("Timed out waiting for foreground shell job"))
                yield* Effect.promise(() => Bun.sleep(1))
                return yield* backgroundWhenReady(remaining - 1)
              })
            const backgrounded = yield* backgroundWhenReady()
            const settled = yield* Fiber.join(waiting)
            const shellID = typeof settled.metadata?.shellID === "string" ? settled.metadata.shellID : undefined
            expect(backgrounded).toMatchObject([{ id: shellID, type: "shell" }])
            expect(settled.metadata).toMatchObject({ truncated: false })
            expect(shellID).toStartWith("sh_")

            const shell = yield* Shell.Service
            if (!shellID) return
            const id = ID.make(shellID)
            const info = yield* shell.get(id)
            expect(settled.content?.[0]).toEqual({
              type: "text",
              text: `Command moved to the background (shell ID: ${shellID}).\nOutput is streaming to: ${info.file}`,
            })
            expect(settled.content?.[1]).toEqual({
              type: "text",
              text: "You will be notified automatically when the command finishes. The notification will include the command's output. Unless the user explicitly asks otherwise, DO NOT poll for completion, even if you need the final result to continue. Repeatedly sleeping and reading or searching the output file is polling, not useful work. You may read the current output if it lets you do useful work now, but do not repeatedly check it while waiting for the command to finish. Keep working on anything that does not depend on the result. If you have nothing else to do, end your response; you will be resumed automatically when the command finishes.",
            })
            yield* Effect.sleep(Duration.millis(100))
            expect((yield* shell.get(id)).status).toBe("running")
            expect((yield* shell.list()).map((info) => info.id)).toContain(id)
            yield* shell.remove(id)
          }),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
    ),
  )
})
