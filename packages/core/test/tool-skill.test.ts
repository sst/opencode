import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Permission } from "@opencode/core/permission"
import { Agent } from "@opencode/core/agent"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { Skill } from "@opencode/core/skill"
import { SkillTool } from "@opencode/core/tool/plugin/skill"
import { Tool } from "@opencode/core/tool"
import { tmpdir } from "./fixture/tmpdir"
import { Image } from "@opencode/core/image"
import { it } from "./lib/effect"
import { imagePassthrough } from "./lib/image"
import { permissionLayer } from "./lib/permission"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { FSUtil } from "@opencode/util/fs-util"
import { toolIdentity, executeTool, registerToolPlugin, toolDefinitions } from "./lib/tool"

const skillToolNode = makeLocationNode({
  name: "test/skill-tool-plugin",
  layer: Layer.effectDiscard(registerToolPlugin(SkillTool.Plugin)),
  deps: [Tool.node, FSUtil.node, Skill.node, Permission.node, Agent.node],
})

const agentInfo = Agent.Info.make({
  id: Agent.ID.make("my-agent"),
  name: Agent.Name.make("My Agent"),
  request: { settings: {}, headers: {}, body: {} },
  mode: "subagent",
  hidden: false,
  permissions: [],
})

const agentsMock = Layer.mock(Agent.Service, {
  resolve: (id: string | undefined) => Effect.succeed(id === "my-agent" ? agentInfo : undefined),
  list: () => Effect.succeed([agentInfo]),
})

const sessionID = Session.ID.make("ses_skill_tool_test")

describe("SkillTool", () => {
  it.live("lists available skills, authorizes the selected ID, and loads model-facing content", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const directory = path.join(tmp.path, "effect")
          const location = path.join(directory, "SKILL.md")
          const reference = path.join(directory, "reference.md")
          yield* Effect.promise(() => fs.mkdir(directory, { recursive: true }))
          yield* Effect.promise(() =>
            Promise.all([fs.writeFile(location, "unused"), fs.writeFile(reference, "reference")]),
          )

          const info: Skill.Info = {
            id: Skill.ID.make("effect"),
            name: Skill.Name.make("Effect"),
            description: "Use Effect",
            location: AbsolutePath.make(location),
            content: "# Effect\n\nGuidance",
          }
          let current = [info]
          const assertions: Permission.AssertInput[] = []
          let deny = false
          const permission = permissionLayer({
            assert: (input) =>
              Effect.sync(() => assertions.push(input)).pipe(
                Effect.andThen(
                  deny
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
          const skills = Layer.mock(Skill.Service, {
            get: (id) => Effect.succeed(current.find((skill) => skill.id === id)),
            list: () => Effect.succeed(current),
          })
          const skillToolLayer = AppNodeBuilder.build(LayerNode.group([Tool.node, skillToolNode]), [
            Permission.node.replace(permission),
            Skill.node.replace(skills),
            Agent.node.replace(agentsMock),
            Image.node.replace(imagePassthrough),
          ])

          return yield* Effect.gen(function* () {
            const registry = yield* Tool.Service
            expect((yield* toolDefinitions(registry))[0]).toMatchObject({
              name: "skill",
              description: SkillTool.description,
            })
            expect(
              yield* executeTool(registry, {
                sessionID,
                ...toolIdentity,
                call: { type: "tool-call", id: "call-skill", name: "skill", input: { id: "effect" } },
              }),
            ).toMatchObject({
              status: "completed",
              content: [{ type: "text", text: Skill.toModelOutput(info, [reference]) }],
            })
            expect(Skill.toModelOutput(info, [reference])).toContain(`Base directory for this skill: ${directory}`)
            expect(
              yield* executeTool(registry, {
                sessionID,
                ...toolIdentity,
                call: { type: "tool-call", id: "call-skill-overflow", name: "skill", input: { id: "effect" } },
              }),
            ).toEqual({
              status: "completed",
              output: { name: "Effect", directory, output: Skill.toModelOutput(info, [reference]) },
              content: [{ type: "text", text: Skill.toModelOutput(info, [reference]) }],
              metadata: { name: "Effect", directory },
            })
            expect(assertions).toMatchObject([
              { sessionID, action: "skill", resources: ["effect"], save: ["effect"] },
              { sessionID, action: "skill", resources: ["effect"], save: ["effect"] },
            ])
            expect(
              yield* executeTool(registry, {
                sessionID,
                ...toolIdentity,
                call: { type: "tool-call", id: "call-missing-skill", name: "skill", input: { id: "missing" } },
              }),
            ).toEqual({
              status: "error",
              error: { type: "tool.execution", message: "Unable to load skill missing" },
            })
            expect(
              yield* executeTool(registry, {
                sessionID,
                ...toolIdentity,
                call: { type: "tool-call", id: "call-agent-as-skill", name: "skill", input: { id: "my-agent" } },
              }),
            ).toEqual({
              status: "error",
              error: {
                type: "tool.execution",
                message: "`my-agent` is an agent, not a skill. Prompt the agent as a subagent instead of loading it as a skill.",
              },
            })
            deny = true
            expect(
              yield* executeTool(registry, {
                sessionID,
                ...toolIdentity,
                call: { type: "tool-call", id: "call-denied-skill", name: "skill", input: { id: "effect" } },
              }),
            ).toEqual({
              status: "error",
              error: { type: "permission.rejected", message: "Permission denied: skill" },
            })
            deny = false
            const flat = Skill.Info.make({
              id: Skill.ID.make("public"),
              name: Skill.Name.make("Public"),
              description: "Public guidance",
              location: AbsolutePath.make(path.join(tmp.path, "public.md")),
              content: "Public",
            })
            yield* Effect.promise(() =>
              Promise.all([
                fs.writeFile(flat.location, "public"),
                fs.writeFile(path.join(tmp.path, "secret.md"), "secret"),
              ]),
            )
            current = [flat]
            expect(
              yield* executeTool(registry, {
                sessionID,
                ...toolIdentity,
                call: { type: "tool-call", id: "call-flat-skill", name: "skill", input: { id: "public" } },
              }),
            ).toMatchObject({
              status: "completed",
              content: [{ type: "text", text: Skill.toModelOutput(flat, []) }],
            })
          }).pipe(Effect.provide(skillToolLayer))
        }),
      ),
    ),
  )
})
