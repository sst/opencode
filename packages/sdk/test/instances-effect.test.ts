import { expect } from "bun:test"
import path from "path"
import { LanguageModel, LLMClient } from "@opencode/ai"
import { OpenAIChat } from "@opencode/ai/protocols"
import { TestLLM } from "@opencode/ai/testing"
import { llmClient } from "@opencode/core/effect/app-node-platform"
import { makeMemoryDriver } from "@opencode/core/environment/index"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { WorkspaceDriver } from "@opencode/core/workspace/driver"
import { Plugin } from "@opencode/plugin/effect"
import { Context, Deferred, Effect, Exit, Layer, Schema, Scope } from "effect"
import { tmpdirScoped } from "../../core/test/fixture/tmpdir"
import { testEffect } from "../../core/test/lib/effect"
import { AbsolutePath, Agent, Location, OpenCode } from "../src/effect"

const it = testEffect(Layer.empty)
const metadata = Schema.decodeUnknownSync(Schema.Struct({ threadID: Schema.String }))
const model = SessionRunnerModel.resolved(
  LanguageModel.make({ id: "instance-model", provider: "test", route: OpenAIChat.route }),
  {
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    cost: [],
    limit: { context: 200_000, output: 8_192 },
  },
)

it.live(
  "reconstructs configured instances before automatic recovery executes tools",
  () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped()
      const scope = yield* Effect.scope
      const firstScope = yield* Scope.fork(scope)
      const secondScope = yield* Scope.fork(scope)
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const llm = yield* TestLLM.Test.pipe(Effect.provide(TestLLM.testLayer()))
      const configured: string[] = []
      const closed: number[] = []
      const executed: number[] = []
      const options: OpenCode.CreateOptions = {
        database: { path: path.join(directory.path, "sessions.db") },
        app: { name: "instance-test", version: "1.2.3" },
        events: { persist: true },
        config: { directory: directory.path, project: false, content: "{}" },
        models: { fetch: false },
        fs: { filewatcher: false },
        instances: {
          key: (session) => metadata(session.metadata).threadID,
          configure: (key) =>
            Effect.gen(function* () {
              const generation = configured.push(key)
              yield* Effect.addFinalizer(() => Effect.sync(() => closed.push(generation)))
              if (generation === 2) {
                yield* Deferred.succeed(started, undefined)
                yield* Deferred.await(release)
              }
              return {
                plugins: [
                  Plugin.define({
                    id: "thread-tools",
                    effect: (ctx) =>
                      Effect.gen(function* () {
                        expect(ctx.app).toMatchObject({ name: "instance-test", version: "1.2.3" })
                        yield* ctx.agent.transform((editor) =>
                          editor.update(Agent.ID.make("build"), (agent) => {
                            agent.permissions = [{ action: "*", resource: "*", effect: "allow" }]
                          }),
                        )
                        yield* ctx.session.hook("context", (event) =>
                          Effect.sync(() => {
                            event.options.temperature = 0.25
                          }),
                        )
                        yield* ctx.tool.transform((editor) =>
                          editor.add({
                            name: "thread_echo",
                            description: "Report the configured thread",
                            input: Schema.Struct({}),
                            output: Schema.String,
                            options: { codemode: false },
                            execute: (_, tool) =>
                              Effect.gen(function* () {
                                executed.push(generation)
                                yield* ctx.session
                                  .rename({ sessionID: tool.sessionID, title: `${key}:${generation}` })
                                  .pipe(Effect.orDie)
                                return { output: key, content: key }
                              }),
                          }),
                        )
                      }),
                  }),
                ],
              }
            }),
        },
      }
      const embed = {
        overrides: [
          llmClient.replace(Layer.succeed(LLMClient.Service, llm)),
          SessionRunnerModel.node.replace(
            Layer.succeed(SessionRunnerModel.Service, { resolve: () => Effect.succeed(model) }),
          ),
        ],
      }
      yield* llm.push(TestLLM.hangAfter())
      const first = yield* OpenCode.create(options, embed).pipe(Scope.provide(firstScope))
      const session = yield* first.sessions.create({
        title: "Recovery fixture",
        location: Location.Ref.make({ directory: AbsolutePath.make(directory.path) }),
        model: model.ref,
        metadata: { threadID: "thread-recovery" },
      })
      expect(configured).toEqual([])
      yield* first.sessions.prompt({ sessionID: session.id, text: "Use the thread tool" })
      yield* llm.wait(1).pipe(Effect.timeout("5 seconds"))
      expect(configured).toEqual(["thread-recovery"])

      // Closing the host interrupts active execution while preserving its durable recovery claim.
      yield* Scope.close(firstScope, Exit.void)
      expect(closed).toEqual([1])
      yield* llm.push(TestLLM.tool("recovered-tool", "thread_echo", {}), TestLLM.text("Recovered", "answer"))
      const second = yield* OpenCode.create(options, embed).pipe(Scope.provide(secondScope))
      yield* Deferred.await(started).pipe(Effect.timeout("5 seconds"))
      expect((yield* llm.requests()).length).toBe(1)
      yield* Deferred.succeed(release, undefined)
      yield* llm.wait(3).pipe(Effect.timeout("5 seconds"))
      yield* second.sessions.wait({ sessionID: session.id })

      expect(configured).toEqual(["thread-recovery", "thread-recovery"])
      expect(executed).toEqual([2])
      expect((yield* second.sessions.get({ sessionID: session.id })).title).toBe("thread-recovery:2")
      expect(
        (yield* llm.requests()).map((request) => ({
          temperature: request.generation?.temperature,
          tools: request.tools?.filter((tool) => tool.name.startsWith("thread_")).map((tool) => tool.name),
        })),
      ).toEqual(Array.from({ length: 3 }, () => ({ temperature: 0.25, tools: ["thread_echo"] })))
      yield* Scope.close(secondScope, Exit.void)
      expect(closed).toEqual([1, 2])
    }),
  15_000,
)

it.live(
  "qualifies application keys by workspace and reselects a moved Session",
  () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped()
      const llm = yield* TestLLM.Test.pipe(
        Effect.provide(TestLLM.testLayer({ fallback: TestLLM.text("Ready", "answer") })),
      )
      const configured: string[] = []
      const placements: Location.Ref[] = []
      const driver = WorkspaceDriver.make({
        create: ({ workspaceID }) => Effect.succeed({ binding: { workspaceID } }),
        connect: () => Effect.succeed(makeMemoryDriver()),
        suspendForIdle: () => Effect.void,
        destroy: () => Effect.void,
      })
      const opencode = yield* OpenCode.create(
        {
          config: { directory: directory.path, project: false, content: "{}" },
          models: { fetch: false },
          fs: { filewatcher: false },
          workspaceProviders: { memory: driver },
          instances: {
            key: (session) => metadata(session.metadata).threadID,
            configure: (key) =>
              Effect.sync(() => {
                configured.push(key)
                return {
                  plugins: [
                    Plugin.define({
                      id: "placement-hook",
                      effect: (ctx) =>
                        Effect.gen(function* () {
                          placements.push(Location.Ref.make(ctx.location))
                          yield* ctx.session.hook("prompt", (event) =>
                            Effect.sync(() => {
                              event.prompt.text += `:${ctx.location.workspaceID}`
                            }),
                          )
                        }),
                    }),
                  ],
                }
              }),
          },
        },
        {
          overrides: [
            llmClient.replace(Layer.succeed(LLMClient.Service, llm)),
            SessionRunnerModel.node.replace(
              Layer.succeed(SessionRunnerModel.Service, { resolve: () => Effect.succeed(model) }),
            ),
          ],
        },
      )
      const firstWorkspace = yield* opencode.workspace.create({ provider: "memory" })
      const secondWorkspace = yield* opencode.workspace.create({ provider: "memory" })
      const first = yield* opencode.sessions.create({
        title: "First placement",
        location: Location.Ref.make({ directory: AbsolutePath.make(directory.path), workspaceID: firstWorkspace }),
        model: model.ref,
        metadata: { threadID: "same-thread" },
      })
      const second = yield* opencode.sessions.create({
        title: "Second placement",
        location: Location.Ref.make({ directory: AbsolutePath.make(directory.path), workspaceID: secondWorkspace }),
        model: model.ref,
        metadata: { threadID: "same-thread" },
      })
      for (const session of [first, second]) {
        const admitted = yield* opencode.sessions.prompt({ sessionID: session.id, text: "Hello" })
        expect(admitted.payload.text).toBe(`Hello:${session.location.workspaceID}`)
        yield* opencode.sessions.wait({ sessionID: session.id })
      }
      expect(configured).toEqual(["same-thread", "same-thread"])
      expect(placements.map((location) => location.workspaceID)).toEqual([firstWorkspace, secondWorkspace])

      yield* opencode.sessions.move({
        sessionID: first.id,
        directory: AbsolutePath.make(directory.path),
        workspaceID: secondWorkspace,
      })
      yield* opencode.sessions.wait({ sessionID: first.id })
      const moved = yield* opencode.sessions.get({ sessionID: first.id })
      expect(moved.location.workspaceID).toBe(secondWorkspace)
      const admitted = yield* opencode.sessions.prompt({ sessionID: first.id, text: "Moved", resume: false })
      expect(admitted.payload.text).toBe(`Moved:${secondWorkspace}`)
      expect(configured).toEqual(["same-thread", "same-thread"])
    }),
  15_000,
)

class Personas extends Context.Service<Personas, { readonly of: (threadID: string) => Effect.Effect<string> }>()(
  "Personas",
) {}

it.live(
  "configures instances from services provided to the SDK layer",
  () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped()
      const hostScope = yield* Scope.fork(yield* Effect.scope)
      const attempts: string[] = []
      const released: string[] = []
      const layer = OpenCode.layer({
        config: { directory: directory.path, project: false, content: "{}" },
        models: { fetch: false },
        fs: { filewatcher: false },
        instances: {
          key: (session) => metadata(session.metadata).threadID,
          configure: (key) =>
            Effect.gen(function* () {
              const personas = yield* Personas
              const persona = yield* personas.of(key)
              const attempt = attempts.push(key)
              yield* Effect.addFinalizer(() => Effect.sync(() => released.push(`${key}:${attempt}`)))
              if (attempt === 1) return yield* Effect.fail(new Error("Persona store cold"))
              return {
                plugins: [
                  Plugin.define({
                    id: "persona",
                    effect: (ctx) =>
                      ctx.session.hook("prompt", (event) =>
                        Effect.sync(() => {
                          event.prompt.text += `:${persona}`
                        }),
                      ),
                  }),
                ],
              }
            }),
        },
      }).pipe(Layer.provide(Layer.succeed(Personas, { of: (threadID) => Effect.succeed(`persona-for-${threadID}`) })))
      const opencode = Context.get(yield* Layer.build(layer).pipe(Scope.provide(hostScope)), OpenCode.Service)
      const session = yield* opencode.sessions.create({
        title: "Service-configured fixture",
        location: Location.Ref.make({ directory: AbsolutePath.make(directory.path) }),
        metadata: { threadID: "thread-7" },
      })

      // A failed construction is discarded with what `configure` acquired, while the host lives on. Resources
      // bound to the Scope captured alongside the services would instead linger until the host closes.
      const failed = yield* opencode.sessions
        .prompt({ sessionID: session.id, text: "Hello", resume: false })
        .pipe(Effect.exit)
      expect(Exit.isFailure(failed)).toBe(true)
      expect(released).toEqual(["thread-7:1"])

      const admitted = yield* opencode.sessions.prompt({ sessionID: session.id, text: "Hello", resume: false })
      expect(admitted.payload.text).toBe("Hello:persona-for-thread-7")
      expect(attempts).toEqual(["thread-7", "thread-7"])
      expect(released).toEqual(["thread-7:1"])
      yield* Scope.close(hostScope, Exit.void)
      expect(released).toEqual(["thread-7:1", "thread-7:2"])
    }),
  15_000,
)
