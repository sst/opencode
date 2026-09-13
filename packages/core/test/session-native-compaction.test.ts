import { expect, test } from "bun:test"
import { LLMClient, LanguageModel, Message, ToolDefinition } from "@opencode/ai"
import { OpenAI } from "@opencode/ai/providers"
import { Agent } from "@opencode/core/agent"
import { Bus } from "@opencode/core/bus"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { llmClient } from "@opencode/core/effect/app-node-platform"
import { Instructions } from "@opencode/core/instructions/index"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { Project } from "@opencode/core/project"
import { ProjectTable } from "@opencode/core/project/sql"
import { AbsolutePath } from "@opencode/core/schema"
import { SessionCompaction } from "@opencode/core/session/compaction"
import { SessionEvent } from "@opencode/core/session/event"
import { SessionHistory } from "@opencode/core/session/history"
import { SessionInbox } from "@opencode/core/session/inbox"
import { InstructionState } from "@opencode/core/session/instruction-state"
import { SessionMessage } from "@opencode/core/session/message"
import { SessionModelRequest } from "@opencode/core/session/model-request"
import { SessionProjector } from "@opencode/core/session/projector"
import { SessionProviderContext } from "@opencode/core/session/provider-context"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { SessionSchema } from "@opencode/core/session/schema"
import { SessionStore } from "@opencode/core/session/store"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { DateTime, Deferred, Effect, Fiber, Schema } from "effect"
import { testEffect } from "./lib/effect"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      Bus.node,
      SessionProjector.node,
      SessionInbox.node,
      SessionStore.node,
      SessionCompaction.node,
      SessionModelRequest.node,
      PluginHooks.node,
      llmClient,
    ]),
    [Bus.node.replace(Bus.configured({ persist: true }))],
  ),
)

const setup = Effect.fnUntraced(function* (endpoint = false) {
  const db = (yield* Database.Service).db
  const bus = yield* Bus.Service
  const inbox = yield* SessionInbox.Service
  const store = yield* SessionStore.Service
  const compaction = yield* SessionCompaction.Service
  const requests = yield* SessionModelRequest.Service
  const hooks = yield* PluginHooks.Service
  const blocked = Deferred.makeUnsafe<void>()
  const hanging = Promise.withResolvers<Response>()
  const state = { failure: false, flaky: false, hang: false, overflow: false, localFailure: false, calls: 0 }
  const bodies: Record<string, unknown>[] = []
  const headers: Headers[] = []
  const server = yield* Effect.acquireRelease(
    Effect.sync(() =>
      Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          state.calls++
          headers.push(request.headers)
          bodies.push(
            Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)))(
              await request.text(),
            ),
          )
          if (state.hang) {
            Deferred.doneUnsafe(blocked, Effect.void)
            return hanging.promise
          }
          // Persistent failures opt out of retries so the schedule's backoff stays out of these tests.
          if (state.failure || state.flaky) {
            const retry = state.flaky
            state.flaky = false
            return Response.json(
              { error: { message: "fixture rate limit", type: "rate_limit_error" } },
              { status: 429, headers: retry ? {} : { "x-should-retry": "false" } },
            )
          }
          const trigger = JSON.stringify(bodies.at(-1)).includes("compaction_trigger")
          if (state.overflow && (trigger || state.localFailure))
            return Response.json(
              {
                error: {
                  message: "Your input exceeds the context window",
                  code: "context_length_exceeded",
                  type: "invalid_request_error",
                },
              },
              { status: 400 },
            )
          const checkpoint = {
            type: "compaction",
            id: `cmp_${state.calls}`,
            encrypted_content: `encrypted_${state.calls}`,
          }
          if (new URL(request.url).pathname.endsWith("/compact"))
            return Response.json({
              id: "compact_endpoint",
              object: "response.compaction",
              output: [
                { type: "message", role: "user", content: [{ type: "input_text", text: "endpoint retained" }] },
                checkpoint,
              ],
              usage: { input_tokens: 20, output_tokens: 4, total_tokens: 24 },
            })
          const output = trigger ? [checkpoint] : []
          const summary = state.overflow
            ? [
                {
                  type: "response.output_item.added",
                  output_index: 0,
                  item: { type: "message", id: "summary", role: "assistant", content: [] },
                },
                {
                  type: "response.output_text.delta",
                  item_id: "summary",
                  output_index: 0,
                  content_index: 0,
                  delta: "## Objective\n- Recovered locally",
                },
              ]
                .map((event) => `data: ${JSON.stringify(event)}\n\n`)
                .join("")
            : ""
          return new Response(
            `${summary}data: ${JSON.stringify({
              type: "response.completed",
              response: {
                id: `resp_${state.calls}`,
                status: "completed",
                output,
                usage: { input_tokens: 20, output_tokens: 4, total_tokens: 24 },
              },
            })}\n\n`,
            { headers: { "content-type": "text/event-stream" } },
          )
        },
      }),
    ),
    (server) =>
      Effect.sync(() => {
        hanging.resolve(new Response("cancelled"))
        void server.stop(true)
      }),
  )
  const native = OpenAI.configure({ apiKey: "fixture", baseURL: server.url.toString() }).responses("gpt-5.4-mini")
  const model = SessionRunnerModel.resolved(
    endpoint
      ? LanguageModel.update(native, {
          route: native.route.with({ compact: { endpoint: native.route.compact.endpoint } }),
        })
      : native,
    {
      capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
      cost: [],
      limit: { context: 200_000, output: 32_000 },
      compaction: { mode: "provider" },
    },
  )
  const sessionID = SessionSchema.ID.create()
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .run()
  yield* bus.publish(SessionEvent.Created, {
    sessionID,
    projectID: Project.ID.global,
    location: { directory: AbsolutePath.make("/project") },
    slug: "native-compaction",
    version: "test",
  })
  const session = yield* store.get(sessionID)
  if (!session) return yield* Effect.die("Missing fixture session")
  const instructions = Instructions.make({
    key: Instructions.Key.make("test/native"),
    codec: Schema.toCodecJson(Schema.String),
    read: Effect.succeed("Current instructions"),
    render: { initial: String, changed: (_previous, value) => value, removed: () => "removed" },
  })
  yield* InstructionState.prepare(db, bus, instructions, sessionID)
  yield* hooks.register("session", "model.request", (event) =>
    Effect.sync(() => {
      event.headers["x-test-hook"] = event.kind
    }),
  )
  yield* hooks.register("session", "http.request", (event) =>
    Effect.sync(() => event.request.headers.set("x-http-hook", event.kind)),
  )
  const prompt = Effect.fnUntraced(function* (text: string, synthetic = false) {
    const id = SessionMessage.ID.create()
    yield* inbox.admit({
      id,
      sessionID,
      item: { type: synthetic ? "synthetic" : "user", payload: { text }, delivery: "steer" },
    })
    yield* bus.publish(SessionEvent.InboxDelivered, { sessionID, inboxID: id })
  })
  const load = Effect.gen(function* () {
    const history = yield* SessionHistory.preview(
      db,
      sessionID,
      instructions,
      SessionProviderContext.provenance(model) ?? "local",
    )
    return {
      session,
      model,
      initial: history.initial,
      messages: history.messages,
      instructionUpdate: history.instructionUpdate,
      agent: { id: Agent.defaultID, info: Agent.Info.default(Agent.defaultID) },
      tools: {
        definitions: [
          ToolDefinition.make({ name: "read", description: "Read a file", inputSchema: { type: "object" } }),
        ],
        execute: () => Effect.die("Compaction must never dispatch tools"),
      },
    }
  })
  const compact = Effect.gen(function* () {
    return yield* compaction.compactManual({
      session,
      messages: yield* store.context(sessionID),
      inputID: SessionMessage.ID.create(),
      resolveContext: () => load,
      prepare: requests.compaction,
    })
  })
  const checkpoint = Effect.gen(function* () {
    const messages = (yield* load).messages
    const last = messages.findLast((message) => message.type === "compaction" && message.status === "completed")
    if (last?.type !== "compaction" || last.status !== "completed" || !last.providerContext)
      return yield* Effect.die("Missing native checkpoint")
    expect(last.summary).toBe("")
    expect(last.recent).toBe("")
    // Provider compaction has no summary, so the request usage is the only visible cost of the operation.
    expect(last.tokens).toMatchObject({ input: 20, output: 4 })
    return last.providerContext
  })
  return {
    compact,
    automatic: Effect.gen(function* () {
      return yield* compaction.compact({ context: yield* load, prepare: requests.compaction })
    }),
    checkpoint,
    prompt,
    load,
    requests,
    bodies,
    headers,
    state,
    blocked,
    sessionID,
    store,
    hooks,
    model,
  }
})

it.live(
  "manual trigger persists and continues, retains earlier users repeatedly, and preserves context on failure/cancellation",
  () =>
    Effect.gen(function* () {
      const fixture = yield* setup()
      yield* fixture.prompt("First real user request")
      yield* fixture.prompt("Synthetic context, not a user request", true)
      expect(yield* fixture.compact).toEqual({ status: "completed" })
      const first = yield* fixture.checkpoint
      expect(SessionProviderContext.decode(first).map((message) => message.role)).toEqual(["user", "assistant"])
      expect(JSON.stringify(first.messages)).not.toContain("Synthetic context")
      expect(fixture.bodies[0]).toMatchObject({
        input: expect.arrayContaining([{ type: "compaction_trigger" }]),
        tools: [expect.objectContaining({ name: "read" })],
      })
      expect(fixture.bodies[0]).not.toHaveProperty("context_management")
      expect(fixture.headers[0]?.get("x-test-hook")).toBe("compaction")
      expect(fixture.headers[0]?.get("x-http-hook")).toBe("compaction")
      yield* fixture.prompt("Second real user request")
      const context = yield* fixture.load
      const prepared = yield* fixture.requests.primary({
        session: context.session,
        agent: context.agent.id,
        model: context.model,
        tools: context.tools,
        ...SessionModelRequest.baseTranscript({ ...context, agent: context.agent.info }),
      })
      const client = yield* LLMClient.Service
      yield* client.generate(prepared.request, prepared.options)
      expect(JSON.stringify(fixture.bodies[1])).toContain("encrypted_1")
      expect(JSON.stringify(fixture.bodies[1])).toContain("Current instructions")
      expect(JSON.stringify(fixture.bodies[1])).toContain("Second real user request")
      expect(yield* fixture.compact).toEqual({ status: "completed" })
      const second = yield* fixture.checkpoint
      expect(
        SessionProviderContext.decode(second)
          .filter((message) => message.role === "user")
          .map((message) => message.content),
      ).toEqual([[Message.text("First real user request")], [Message.text("Second real user request")]])
      expect(JSON.stringify(second.messages)).not.toContain("encrypted_1")
      expect(yield* fixture.store.get(fixture.sessionID)).toMatchObject({ tokens: { input: 40, output: 8 } })
      // Nothing new since the checkpoint is not compactable, exactly like a fresh local summary.
      expect(yield* fixture.compact).toMatchObject({ status: "failed", error: { type: "compaction.unavailable" } })
      yield* fixture.prompt("Third real user request")
      fixture.state.failure = true
      expect(yield* fixture.compact).toMatchObject({ status: "failed", error: { type: "provider.rate-limit" } })
      expect(fixture.state.calls).toBe(4)
      expect(yield* fixture.checkpoint).toEqual(second)
      fixture.state.failure = false
      fixture.state.hang = true
      const pending = yield* fixture.compact.pipe(Effect.forkScoped)
      yield* Deferred.await(fixture.blocked)
      yield* Fiber.interrupt(pending)
      expect(fixture.state.calls).toBe(5)
      expect(yield* fixture.checkpoint).toEqual(second)
      // A transient provider failure retries under the shared session policy and its plugin hook.
      fixture.state.hang = false
      const retries: PluginHooks.Domains["session"]["retry"][] = []
      yield* fixture.hooks.register("session", "retry", (event) =>
        Effect.sync(() => {
          retries.push(event)
          event.decision = { retry: true, delay: 0 }
        }),
      )
      fixture.state.flaky = true
      expect(yield* fixture.compact).toEqual({ status: "completed" })
      expect(fixture.state.calls).toBe(7)
      expect(retries).toMatchObject([
        {
          agent: "build",
          attempt: 2,
          error: { type: "provider.rate-limit" },
          decision: { retry: true, delay: 0 },
        },
      ])
      expect(
        SessionProviderContext.decode(yield* fixture.checkpoint).filter((message) => message.role === "user"),
      ).toHaveLength(3)
    }),
  15000,
)

it.live("manual and automatic endpoint compaction keep the provider replacement unchanged", () =>
  Effect.gen(function* () {
    const fixture = yield* setup(true)
    yield* fixture.prompt("Original user")
    expect(yield* fixture.compact).toEqual({ status: "completed" })
    expect(yield* fixture.automatic).toEqual({ status: "completed" })
    const replacement = SessionProviderContext.decode(yield* fixture.checkpoint)
    expect(replacement[0]?.content).toEqual([Message.text("endpoint retained")])
    expect(JSON.stringify(replacement)).not.toContain("Original user")
    expect(fixture.state.calls).toBe(2)
    expect(fixture.headers[0]?.get("x-http-hook")).toBe("compaction")
    expect(fixture.bodies[0]).not.toHaveProperty("context_management")
  }),
)

it.live("only known automatic native overflow falls back locally and failed recovery retains the checkpoint", () =>
  Effect.gen(function* () {
    const fixture = yield* setup()
    yield* fixture.prompt("Original durable request")
    expect(yield* fixture.compact).toEqual({ status: "completed" })
    const installed = yield* fixture.checkpoint
    yield* fixture.prompt("Recent request")
    fixture.state.failure = true
    expect(yield* fixture.automatic).toMatchObject({ status: "failed", error: { type: "provider.rate-limit" } })
    expect(fixture.state.calls).toBe(2)
    expect(yield* fixture.checkpoint).toEqual(installed)
    fixture.state.failure = false
    fixture.state.hang = true
    const pending = yield* fixture.automatic.pipe(Effect.forkScoped)
    yield* Deferred.await(fixture.blocked)
    yield* Fiber.interrupt(pending)
    expect((yield* fixture.load).messages.at(-1)).toMatchObject({
      type: "compaction",
      status: "failed",
      error: { type: "compaction.interrupted" },
    })
    expect(yield* fixture.checkpoint).toEqual(installed)
    fixture.state.hang = false
    fixture.state.overflow = true
    fixture.state.localFailure = true
    expect(yield* fixture.automatic).toMatchObject({ status: "failed" })
    expect(fixture.state.calls).toBe(5)
    expect(yield* fixture.checkpoint).toEqual(installed)
    expect(JSON.stringify(fixture.bodies[4])).toContain("Original durable request")
    expect(JSON.stringify(fixture.bodies[4])).not.toContain("encrypted_1")
    fixture.state.localFailure = false
    expect(yield* fixture.automatic).toEqual({ status: "completed", recoveredOverflow: true })
    expect(fixture.state.calls).toBe(7)
    expect((yield* fixture.load).messages).toContainEqual(
      expect.objectContaining({ type: "compaction", summary: "## Objective\n- Recovered locally" }),
    )
  }),
)

it.live("compaction hooks supply the summary instead of provider compaction", () =>
  Effect.gen(function* () {
    const fixture = yield* setup()
    yield* fixture.prompt("Original user")
    yield* fixture.hooks.register("session", "compaction", (event) =>
      Effect.sync(() => {
        event.result = {
          summary: "## Objective\n- hooked summary",
          providerState: { responseId: "plugin" },
          metadata: { plugin: "custom" },
          tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
        }
      }),
    )
    expect(yield* fixture.compact).toEqual({ status: "completed" })
    expect(fixture.state.calls).toBe(0)
    expect((yield* fixture.load).messages.at(-1)).toMatchObject({
      type: "compaction",
      status: "completed",
      summary: "## Objective\n- hooked summary",
      recent: "",
      providerState: { responseId: "plugin" },
      metadata: { plugin: "custom" },
      tokens: { input: 10, output: 5 },
    })
  }),
)

it.live("rejects request-hook route rewrites before provider compaction", () =>
  Effect.gen(function* () {
    const fixture = yield* setup()
    yield* fixture.prompt("Original user")
    yield* fixture.hooks.register("session", "model.request", (event) =>
      Effect.sync(() => {
        event.baseURL = "https://another.example/v1"
      }),
    )
    expect(yield* fixture.compact).toMatchObject({
      status: "failed",
      error: { type: "provider.unsupported-operation" },
    })
    expect(fixture.state.calls).toBe(0)
  }),
)

test("retained user budget counts attachments and drops whole oldest messages", () => {
  const model = SessionRunnerModel.resolved(OpenAI.responses("gpt-5.4-mini"), {
    capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
    cost: [],
    limit: { context: 200_000, output: 32_000 },
  })
  const user = (text: string) =>
    SessionMessage.User.make({
      id: SessionMessage.ID.create(),
      type: "user",
      text,
      time: { created: DateTime.makeUnsafe(0) },
    })
  const newest = {
    ...user("x".repeat(63_000 * 4)),
    files: [{ mime: "image/png", data: "aGVsbG8=", source: { type: "inline" as const } }],
  }
  expect(SessionCompaction.retainUsers([user("old"), newest], model, 64_000)).toEqual([])
  expect(
    SessionCompaction.retainUsers([user("x".repeat(63_000 * 4)), { ...newest, text: "new" }], model, 64_000),
  ).toHaveLength(1)
})
