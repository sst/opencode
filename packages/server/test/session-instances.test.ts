import { expect } from "bun:test"
import { App } from "@opencode/core/app"
import { Bus } from "@opencode/core/bus"
import { Database } from "@opencode/core/database/database"
import { llmClient } from "@opencode/core/effect/app-node-platform"
import { Watcher } from "@opencode/core/filesystem/watcher"
import { Form } from "@opencode/core/form"
import { Instance } from "@opencode/core/instance"
import { LocationServiceMap } from "@opencode/core/location-service-map"
import { ModelsDev } from "@opencode/core/models-dev"
import { Permission } from "@opencode/core/permission"
import { Plugin } from "@opencode/core/plugin"
import { Session } from "@opencode/core/session"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { define } from "@opencode/plugin/effect/plugin"
import type { SessionHooks } from "@opencode/plugin/effect/session"
import { Agent } from "@opencode/schema/agent"
import { Location } from "@opencode/schema/location"
import { AbsolutePath } from "@opencode/schema/schema"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { Global } from "@opencode/util/global"
import { Context, Duration, Effect, Layer, LayerMap, RcMap, Schema } from "effect"
import { HttpEffect, HttpRouter, HttpServer } from "effect/unstable/http"
import { LanguageModel, LLMClient } from "../../ai/src"
import { OpenAIChat } from "../../ai/src/protocols/openai-chat"
import { TestLLM } from "../../ai/src/testing"
import { tempGlobalLayer } from "../../core/test/fixture/global"
import { tmpdirScoped } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { createEmbeddedRoutes } from "../src/routes"

it.live(
  "isolates same-directory Session tools, hooks, commands, and HTTP requests through one selector",
  () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped()
      const location = Location.Ref.make({ directory: AbsolutePath.make(directory.path) })
      const first = { id: Session.ID.make("ses_instance_first"), tool: "instance_first", temperature: 0.1 }
      const second = { id: Session.ID.make("ses_instance_second"), tool: "instance_second", temperature: 0.2 }
      const configs = [first, second]
      const boots: Session.ID[] = []
      const executed: Session.ID[] = []
      const commands: Session.ID[] = []
      const llm = yield* TestLLM.Test.pipe(Effect.provide(TestLLM.testLayer()))
      const model = SessionRunnerModel.resolved(
        LanguageModel.make({ id: "instance-model", provider: "test", route: OpenAIChat.route }),
        {
          capabilities: { tools: true, input: ["text"], output: ["text"] },
          cost: [],
          limit: { context: 200_000, output: 8_192 },
        },
      )
      // Host and private instances must reuse the same global layer identities.
      const replacements: LayerNode.Replacements = [
        Global.node.replace(tempGlobalLayer),
        Database.node.replace(Database.node),
        Bus.node.replace(Bus.node),
        App.node.replace(App.node),
        ModelsDev.node.replace(ModelsDev.configured({ fetch: false })),
        Watcher.node.replace(Watcher.configured({ enabled: false })),
        llmClient.replace(Layer.succeed(LLMClient.Service, llm)),
        SessionRunnerModel.node.replace(
          Layer.succeed(SessionRunnerModel.Service, { resolve: () => Effect.succeed(model) }),
        ),
        Instance.node.replace(
          makeGlobalNode({
            service: Instance.Service,
            deps: [LocationServiceMap.node],
            layer: Layer.effect(
              Instance.Service,
              Effect.gen(function* () {
                const locations = yield* LocationServiceMap.Service
                const instances = yield* LayerMap.make(
                  (id: Session.ID) => {
                    const config = configs.find((config) => config.id === id)
                    if (!config) throw new Error(`No instance configuration for ${id}`)
                    return Instance.layer(location, {
                      discovery: false,
                      replacements: bindings,
                      plugins: [
                        define({
                          id: "session-instance",
                          effect: Effect.fnUntraced(function* (ctx) {
                            boots.push(config.id)
                            yield* ctx.agent.transform((editor) =>
                              editor.update("build", (agent) => {
                                agent.permissions = [{ action: "*", resource: "*", effect: "allow" }]
                              }),
                            )
                            yield* ctx.session.hook("prompt", (event) =>
                              Effect.sync(() => {
                                event.prompt.text += ` [${config.tool}]`
                              }),
                            )
                            const tune = (event: SessionHooks["context"]) =>
                              Effect.sync(() => {
                                event.options.temperature = config.temperature
                              })
                            yield* ctx.session.hook("context", tune)
                            yield* ctx.session.hook("generate", tune)
                            yield* ctx.permission.hook("evaluate", (event) =>
                              Effect.sync(() => {
                                event.effect = event.action === "instance-test" ? "ask" : "allow"
                                if (event.action === "instance-test") event.message = config.tool
                              }),
                            )
                            yield* ctx.tool.transform((editor) =>
                              editor.add({
                                name: config.tool,
                                description: `Tool for ${config.id}`,
                                input: Schema.Struct({}),
                                output: Schema.String,
                                options: { codemode: false },
                                execute: () =>
                                  Effect.sync(() => {
                                    executed.push(config.id)
                                    return { output: config.id, content: config.id }
                                  }),
                              }),
                            )
                            yield* ctx.command.transform((editor) =>
                              editor.add({
                                name: "instance-check",
                                execute: (input) =>
                                  ctx.session
                                    .prompt({
                                      sessionID: input.sessionID,
                                      text: `command ${config.tool}`,
                                      delivery: input.delivery,
                                      resume: false,
                                    })
                                    .pipe(
                                      Effect.tap(() => Effect.sync(() => commands.push(config.id))),
                                      Effect.asVoid,
                                    ),
                              }),
                            )
                          }),
                        }),
                      ],
                    })
                  },
                  { idleTimeToLive: Duration.infinity },
                )
                const selector = Instance.Service.of({
                  provide: (session) => Effect.provide(instances.get(session.id)),
                })
                const bindings: LayerNode.Replacements = [
                  ...replacements,
                  Instance.node.replace(Layer.succeed(Instance.Service, selector)),
                  LocationServiceMap.node.replace(Layer.succeed(LocationServiceMap.Service, locations)),
                ]
                return selector
              }),
            ),
          }),
        ),
      ]
      const context = yield* Layer.build(
        createEmbeddedRoutes({}, replacements).pipe(Layer.provide(HttpServer.layerServices)),
      )
      const sessions = Context.get(context, Session.Service)
      const instances = Context.get(context, Instance.Service)
      const locations = Context.get(context, LocationServiceMap.Service)
      const handler = Context.get(context, HttpRouter.HttpRouter)
        .asHttpEffect()
        .pipe(HttpEffect.toWebHandlerWith(context))
      const request = (route: string, body?: unknown) =>
        Effect.promise(() =>
          handler(
            new Request(
              `http://opencode.local${route}`,
              body === undefined
                ? undefined
                : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
            ),
          ),
        )

      yield* Effect.forEach(configs, (config) =>
        sessions.create({
          id: config.id,
          title: config.tool,
          agent: Agent.ID.make("build"),
          model: model.ref,
          location,
        }),
      )
      expect((yield* sessions.list()).data.map((session) => session.location)).toEqual([location, location])
      expect(yield* sessions.messages({ sessionID: first.id })).toEqual([])
      yield* sessions.get(second.id)
      for (const config of configs) {
        for (const resource of ["permission", "form"]) {
          const response = yield* request(`/api/session/${config.id}/${resource}`)
          expect(response.status).toBe(200)
          expect(yield* Effect.promise<unknown>(() => response.json())).toEqual({ data: [] })
        }
      }
      // Reading permissions or forms builds the Session's Instance and starts its plugin activation at once; the
      // ordering assertion after the prompts is what proves each Session boots exactly once.

      for (const config of configs) {
        const session = yield* sessions.get(config.id)
        yield* Plugin.Service.use((plugins) => plugins.awaitActivation).pipe(instances.provide(session))
        const admitted = yield* sessions.prompt({ sessionID: config.id, text: "run", resume: false })
        expect(admitted.payload.text).toBe(`run [${config.tool}]`)
      }
      expect(boots).toEqual([first.id, second.id])

      for (const config of configs) {
        yield* llm.push(TestLLM.tool(`call_${config.tool}`, config.tool, {}), TestLLM.text(config.id, config.tool))
        yield* sessions.resume(config.id)
      }
      expect(executed).toEqual([first.id, second.id])

      for (const config of configs) {
        yield* llm.push(TestLLM.text(`generated ${config.id}`, config.tool))
        expect(yield* sessions.generate({ sessionID: config.id, prompt: "summarize" })).toBe(`generated ${config.id}`)
        yield* sessions.command({ sessionID: config.id, command: "instance-check", text: "" })
        expect(yield* sessions.inbox(config.id)).toMatchObject([
          { type: "user", payload: { text: `command ${config.tool} [${config.tool}]` } },
        ])
      }
      expect(commands).toEqual([first.id, second.id])
      expect(
        (yield* llm.requests()).map((request) => ({
          temperature: request.generation?.temperature,
          tools: request.tools?.filter((tool) => tool.name.startsWith("instance_")).map((tool) => tool.name),
        })),
      ).toEqual(
        [first, first, second, second, first, second].map((config) => ({
          temperature: config.temperature,
          tools: [config.tool],
        })),
      )

      // Seed through Core, then use HTTP to reach those exact private instances.
      const pending = yield* Effect.forEach(configs, (config) =>
        Effect.gen(function* () {
          const session = yield* sessions.get(config.id)
          return yield* Effect.gen(function* () {
            const forms = yield* Form.Service
            const permissions = yield* Permission.Service
            const form = yield* forms.create({
              sessionID: config.id,
              title: config.tool,
              fields: [{ key: "answer", type: "string" }],
            })
            const permission = {
              id: Permission.ID.create(),
              sessionID: config.id,
              action: "instance-test",
              resources: [config.tool],
            }
            expect(yield* permissions.ask(permission)).toEqual({ id: permission.id, effect: "ask" })
            const foreignID = config.id === first.id ? second.id : first.id
            const foreignForm = yield* forms.create({
              sessionID: foreignID,
              title: "Foreign form",
              fields: [{ key: "answer", type: "string" }],
            })
            const foreignPermission = yield* permissions.ask({
              ...permission,
              id: Permission.ID.create(),
              sessionID: foreignID,
            })
            return {
              session,
              form,
              permission: { ...permission, message: config.tool },
              foreignForm,
              foreignPermission,
            }
          }).pipe(instances.provide(session))
        }),
      )
      for (const entry of pending) {
        const forms = yield* request(`/api/session/${entry.session.id}/form`)
        expect(forms.status).toBe(200)
        expect(yield* Effect.promise<unknown>(() => forms.json())).toEqual({ data: [entry.form] })
        const permissions = yield* request(`/api/session/${entry.session.id}/permission`)
        expect(permissions.status).toBe(200)
        expect(yield* Effect.promise<unknown>(() => permissions.json())).toEqual({ data: [entry.permission] })

        // These IDs exist in the selected instance, but belong to the other Session.
        expect((yield* request(`/api/session/${entry.session.id}/form/${entry.foreignForm.id}`)).status).toBe(404)
        expect(
          (yield* request(`/api/session/${entry.session.id}/permission/${entry.foreignPermission.id}`)).status,
        ).toBe(404)
        expect(
          (yield* request(`/api/session/${entry.session.id}/form/${entry.foreignForm.id}/reply`, {
            answer: { answer: "wrong" },
          })).status,
        ).toBe(404)
        expect(
          (yield* request(`/api/session/${entry.session.id}/permission/${entry.foreignPermission.id}/reply`, {
            reply: "once",
          })).status,
        ).toBe(404)
        yield* Effect.gen(function* () {
          const forms = yield* Form.Service
          const permissions = yield* Permission.Service
          expect(yield* forms.state(entry.foreignForm.id)).toEqual({ status: "pending" })
          expect(yield* permissions.get(entry.foreignPermission.id)).toMatchObject({
            sessionID: entry.foreignForm.sessionID,
          })
        }).pipe(instances.provide(entry.session))
      }
      for (const entry of pending) {
        expect(
          (yield* request(`/api/session/${entry.session.id}/form/${entry.form.id}/reply`, {
            answer: { answer: entry.session.id },
          })).status,
        ).toBe(204)
        expect(
          (yield* request(`/api/session/${entry.session.id}/permission/${entry.permission.id}/reply`, {
            reply: "once",
          })).status,
        ).toBe(204)
        yield* Effect.gen(function* () {
          const forms = yield* Form.Service
          const permissions = yield* Permission.Service
          expect(yield* forms.state(entry.form.id)).toEqual({
            status: "answered",
            answer: { answer: entry.session.id },
          })
          expect(yield* permissions.get(entry.permission.id)).toBeUndefined()
        }).pipe(instances.provide(entry.session))
      }
      expect(boots).toEqual([first.id, second.id])
      expect(Array.from(yield* RcMap.keys(locations.rcMap))).toEqual([])
    }),
  15_000,
)
