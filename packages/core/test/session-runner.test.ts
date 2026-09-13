import { describe, expect, test } from "bun:test"
import {
  AIError,
  CompactionPart,
  CompactionCheckpointResponse,
  HttpContext,
  LLMEvent,
  LLMRequest,
  Message,
  SystemPart,
  LanguageModel,
  ToolFailure,
  TransportError,
  InvalidProviderOutputError,
  InvalidRequestError,
  RateLimitError,
  UnknownProviderError,
} from "@opencode/ai"
import { OpenAIChat } from "@opencode/ai/protocols/openai-chat"
import { AnthropicMessages, OpenAIResponses } from "@opencode/ai/protocols"
import { compileRequest } from "@opencode/ai/route/client"
import { TestLLM } from "@opencode/ai/testing"
import type { SessionHooks } from "@opencode/plugin/effect/session"
import { Catalog } from "@opencode/core/catalog"
import { Database } from "@opencode/core/database/database"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNodePlatform } from "@opencode/core/effect/app-node-platform"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Bus } from "@opencode/core/bus"
import { Event } from "@opencode/schema/event"
import { App } from "@opencode/core/app"
import { Permission } from "@opencode/core/permission"
import { EventTable } from "@opencode/core/event/sql"
import { Project } from "@opencode/core/project"
import { ProjectTable } from "@opencode/core/project/sql"
import { Form } from "@opencode/core/form"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { Snapshot } from "@opencode/core/snapshot"
import { SessionEvent } from "@opencode/core/session/event"
import { SessionCompaction } from "@opencode/core/session/compaction"
import { SessionInbox } from "@opencode/core/session/inbox"
import { SessionMessage } from "@opencode/core/session/message"
import { SessionModelTransport } from "@opencode/core/session/model-transport"
import { SessionProviderContext } from "@opencode/core/session/provider-context"
import { Money } from "@opencode/schema/money"
import { SessionProjector } from "@opencode/core/session/projector"
import { SessionExecution } from "@opencode/core/session/execution"
import { SessionRunCoordinator } from "@opencode/core/session/run-coordinator"
import { SessionRunner } from "@opencode/core/session/runner/index"
import { SessionRunnerLLM } from "@opencode/core/session/runner/llm"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { SessionUsage } from "@opencode/core/session/usage"
import { PluginSupervisor } from "@opencode/core/plugin/supervisor"
import { Plugin } from "@opencode/core/plugin"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { OptimizePlugin } from "@opencode/core/plugin/optimize"
import { QuestionTool } from "@opencode/core/tool/plugin/question"
import { Agent } from "@opencode/core/agent"
import { Config } from "@opencode/core/config"
import { Document, Info } from "@opencode/schema/config"
import { ConfigCompaction } from "@opencode/schema/config/compaction"
import { Tool } from "@opencode/core/tool"
import type { Info as ToolInfo } from "@opencode/schema/tool"
import {
  InstructionStateTable,
  SessionInboxTable,
  SessionMessageTable,
  SessionTable,
} from "@opencode/core/session/sql"
import { InstructionEntry } from "@opencode/core/session/instruction-entry"
import { SessionStore } from "@opencode/core/session/store"
import { Instructions } from "@opencode/core/instructions/index"
import { InstructionBuiltIns } from "@opencode/core/instructions/builtins"
import { InstructionDiscovery } from "@opencode/core/instruction-discovery"
import { SkillInstructions } from "@opencode/core/skill/instructions"
import { ReferenceInstructions } from "@opencode/core/reference/instructions"
import { McpInstructions } from "@opencode/core/mcp/instructions"
import { SessionSystemPrompt } from "@opencode/core/session/system-prompt"
import { ID, Model } from "@opencode/core/model"
import { Location } from "@opencode/core/location"
import { Provider } from "@opencode/core/provider"
import { Cause, Context, Deferred, Effect, Exit, Fiber, Layer, Queue, Schema, Scope, Stream } from "effect"
import { TestClock } from "effect/testing"
import { asc, desc, eq, sql } from "drizzle-orm"
import { testEffect } from "./lib/effect"
import { promptLocationNode } from "./fixture/prompt-location"
import { LocationServiceMap } from "@opencode/core/location-service-map"
import { Expected } from "./lib/session-message"
import { permissionLayer } from "./lib/permission"
import { agentHost, catalogHost, host } from "./plugin/host"
import { CodeModeInstructions } from "@opencode/core/codemode/instructions"

const emptyCodeMode = `\n\n${CodeModeInstructions.render({ total: 0, shown: 0, namespaces: [] })}`
type ToolBarrier = {
  readonly count: number
  readonly started: Deferred.Deferred<void>
  readonly release: Deferred.Deferred<void>
  active: number
  maxActive: number
}
const testLLM = TestLLM.layer({
  fallback: [],
  transformRequest: (request) =>
    LLMRequest.update(request, {
      system: request.system.map((part) => ({
        ...part,
        text: part.text.replace(emptyCodeMode, ""),
      })),
      tools: request.tools.filter((tool) => tool.name !== "execute"),
    }),
})
type ModelLimit = { readonly context: number; readonly input?: number; readonly output: number }
const defaultModelLimit = { context: 200_000, output: 32_000 }
const modelLimits = new Map<string, ModelLimit>()
const testModel = (id: string, limit: ModelLimit = defaultModelLimit) => {
  modelLimits.set(id, limit)
  return LanguageModel.make({ id, provider: "fake", route: OpenAIChat.route })
}
const model = testModel("fake-model")
const defaultSystem = SessionSystemPrompt.make([])
const replacementModel = testModel("replacement")
const compactModel = testModel("compact", { context: 4_000, output: 50 })
const fullOutputModel = testModel("full-output", { context: 262_144, output: 262_144 })
const unknownContextModel = testModel("unknown-context", { context: 0, output: 32_000 })
const undersizedContextModel = testModel("undersized-context", { context: 1, output: 1_000 })
const recoveryModel = testModel("recovery", { context: 200_000, output: 1_000 })

test("calculates step cost using the matching context tier", () => {
  expect(
    SessionUsage.calculateCost(
      [
        {
          input: Money.USDPerMillionTokens.make(1),
          output: Money.USDPerMillionTokens.make(2),
          cache: {
            read: Money.USDPerMillionTokens.make(0.1),
            write: Money.USDPerMillionTokens.make(0.5),
          },
        },
        {
          tier: { type: "context", size: 100 },
          input: Money.USDPerMillionTokens.make(3),
          output: Money.USDPerMillionTokens.make(4),
          cache: {
            read: Money.USDPerMillionTokens.make(0.2),
            write: Money.USDPerMillionTokens.make(0.6),
          },
        },
      ],
      { input: 80, output: 10, reasoning: 2, cache: { read: 20, write: 1 } },
    ),
  ).toBeCloseTo(0.0002926)
})

test("ignores malformed model cost fields", () => {
  const costs = [
    {
      input: Money.USDPerMillionTokens.make(3),
      output: Money.USDPerMillionTokens.make(15),
      cache: {
        read: Money.USDPerMillionTokens.make(0.3),
        write: Money.USDPerMillionTokens.make(3.75),
      },
    },
  ]
  Object.assign(costs[0], { input: {} })

  expect(
    SessionUsage.calculateCost(costs, {
      input: 1_000_000,
      output: 100_000,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    }),
  ).toBe(Money.USD.make(1.5))
})

test("does not apply an ineligible tier without base pricing", () => {
  expect(
    SessionUsage.calculateCost(
      [
        {
          tier: { type: "context", size: 100 },
          input: Money.USDPerMillionTokens.make(3),
          output: Money.USDPerMillionTokens.make(4),
          cache: {
            read: Money.USDPerMillionTokens.make(0.2),
            write: Money.USDPerMillionTokens.make(0.6),
          },
        },
      ],
      { input: 80, output: 10, reasoning: 2, cache: { read: 20, write: 0 } },
    ),
  ).toBe(Money.USD.zero)
})

const makeRunnerState = (compaction?: SessionRunnerModel.Resolved["compaction"]) => {
  let toolBarrier: ToolBarrier | undefined
  const releaseTools = (barrier: ToolBarrier) =>
    Effect.sync(() => {
      if (toolBarrier === barrier) toolBarrier = undefined
    }).pipe(Effect.andThen(Deferred.succeed(barrier.release, undefined)), Effect.asVoid)
  return {
    currentModel: model,
    compaction,
    modelResolveHook: Effect.void,
    systemBaseline: "Initial context",
    systemRemoved: false,
    systemUnavailable: false,
    systemLoadHook: Effect.void,
    skillBaselines: new Map<Agent.ID, string>(),
    authorizations: new Array<Tool.Context>(),
    executions: new Array<string>(),
    closedTransports: new Array<Session.ID>(),
    blockTools: (count = 1) =>
      Effect.acquireRelease(
        Effect.all({ started: Deferred.make<void>(), release: Deferred.make<void>() }).pipe(
          Effect.map((deferreds) => {
            const barrier = { count, ...deferreds, active: 0, maxActive: 0 }
            toolBarrier = barrier
            return barrier
          }),
        ),
        releaseTools,
      ).pipe(
        Effect.map((barrier) => ({
          started: Deferred.await(barrier.started),
          release: releaseTools(barrier),
          maxActive: Effect.sync(() => barrier.maxActive),
        })),
      ),
    awaitToolBarrier: Effect.suspend(() => {
      const barrier = toolBarrier
      if (!barrier) return Effect.void
      barrier.active++
      barrier.maxActive = Math.max(barrier.maxActive, barrier.active)
      return (barrier.active === barrier.count ? Deferred.succeed(barrier.started, undefined) : Effect.void).pipe(
        Effect.andThen(Deferred.await(barrier.release)),
        Effect.ensuring(Effect.sync(() => barrier.active--)),
      )
    }),
  }
}

class RunnerState extends Context.Service<RunnerState, ReturnType<typeof makeRunnerState>>()("test/SessionRunner") {}

const permissionFail = {
  name: "permission_fail",
  description: "Reject a permission",
  input: Schema.Struct({}),
  output: Schema.Struct({}),
  execute: () =>
    new ToolFailure({
      message: "Permission denied: edit",
      error: new Permission.BlockedError({
        rules: [],
        permission: "edit",
        resources: ["src/index.ts"],
      }),
    }),
}
const permission = permissionLayer()
const transformTools = (registry: Tool.Interface, tools: Readonly<Record<string, ToolInfo>>, options?: Tool.Options) =>
  registry.transform((editor) =>
    Object.entries(tools).forEach(([name, tool]) => editor.add({ ...tool, name, options: options ?? tool.options })),
  )
const layer = Layer.unwrap(
  Effect.map(RunnerState, (state) => {
    const modelTransport = Layer.succeed(
      SessionModelTransport.Service,
      SessionModelTransport.Service.of({
        bind: () => ({ execute: () => Effect.die("Unexpected WebSocket execution") }),
        close: (sessionID) => Effect.sync(() => state.closedTransports.push(sessionID)),
        closeAll: Effect.void,
      }),
    )
    const echo = Layer.effectDiscard(
      Tool.Service.use((registry) =>
        transformTools(
          registry,
          {
            echo: {
              name: "echo",
              description: "Echo text",
              input: Schema.Struct({ text: Schema.String }),
              output: Schema.Struct({ text: Schema.String }),
              execute: ({ text }, context) =>
                Effect.gen(function* () {
                  state.authorizations.push(context)
                  state.executions.push(text)
                  yield* state.awaitToolBarrier
                  return { output: { text }, content: text }
                }),
            },
            defect: {
              name: "defect",
              description: "Fail unexpectedly",
              input: Schema.Struct({}),
              output: Schema.Struct({}),
              execute: () => state.awaitToolBarrier.pipe(Effect.andThen(Effect.die("unexpected tool defect"))),
            },
            storefail: {
              name: "storefail",
              description: "Produce output that cannot be persisted",
              input: Schema.Struct({}),
              output: Schema.Struct({}),
              execute: () => Effect.succeed({ output: {} }),
            },
          },
          { codemode: false },
        ),
      ),
    )
    const echoNode = makeLocationNode({ name: "test/session-runner-tools", layer: echo, deps: [Tool.node] })
    const models = Layer.mock(SessionRunnerModel.Service)({
      resolve: (session) =>
        state.modelResolveHook.pipe(
          Effect.map(() => {
            const selected = session.model?.id === "replacement" ? replacementModel : state.currentModel
            return SessionRunnerModel.resolved(selected, {
              capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
              cost: [],
              limit: modelLimits.get(String(selected.id)) ?? defaultModelLimit,
              variant: session.model?.variant,
              compaction: state.compaction,
            })
          }),
        ),
    })
    const systemContextKey = Instructions.Key.make("test/context")
    const systemContext = Layer.mock(InstructionBuiltIns.Service, {
      load: () =>
        Effect.sync(() =>
          Instructions.make({
            key: systemContextKey,
            codec: Schema.toCodecJson(Schema.String),
            read: state.systemLoadHook.pipe(
              Effect.andThen(
                Effect.sync(() =>
                  state.systemUnavailable
                    ? Instructions.unavailable
                    : state.systemRemoved
                      ? Instructions.removed
                      : state.systemBaseline,
                ),
              ),
            ),
            render: {
              initial: String,
              changed: (_previous, current) => current,
              removed: () => "System context source removed: test/context",
            },
          }),
        ),
    })
    const instructionContext = Layer.mock(InstructionDiscovery.Service, {
      project: true,
      global: true,
      load: () => Effect.succeed(Instructions.empty),
    })
    const skillInstructions = Layer.mock(SkillInstructions.Service, {
      load: (agent) =>
        Effect.succeed(
          state.skillBaselines.has(agent.id)
            ? Instructions.make({
                key: Instructions.Key.make("test/skill-guidance"),
                codec: Schema.toCodecJson(Schema.String),
                read: Effect.succeed(state.skillBaselines.get(agent.id)!),
                render: {
                  initial: String,
                  changed: (_previous, current) => current,
                  removed: () => "Skill guidance removed",
                },
              })
            : Instructions.empty,
        ),
    })
    const referenceInstructions = Layer.mock(ReferenceInstructions.Service, {
      load: () => Effect.succeed(Instructions.empty),
    })
    const mcpInstructions = Layer.mock(McpInstructions.Service, { load: () => Effect.succeed(Instructions.empty) })
    const config = Config.testLayer([
      new Document({
        type: "document",
        info: new Info({
          compaction: new ConfigCompaction.Info({
            buffer: 3_000,
            keep: new ConfigCompaction.Keep({ tokens: 1_000 }),
          }),
        }),
      }),
    ])
    const promptCatalog = Layer.mock(Catalog.Service, {
      provider: {
        get: () => Effect.undefined,
        all: () => Effect.succeed([]),
        available: () => Effect.succeed([]),
      },
      model: {
        get: () => Effect.undefined,
        all: () => Effect.succeed([]),
        available: () => Effect.succeed([]),
        default: () => Effect.undefined,
        small: () => Effect.undefined,
      },
    })
    const replacements: LayerNode.Replacements = [
      Snapshot.node.replace(Snapshot.noopLayer),
      LayerNodePlatform.llmClient.replace(TestLLM.clientLayer.pipe(Layer.provide(testLLM))),
      SessionRunnerModel.node.replace(models),
      InstructionBuiltIns.node.replace(systemContext),
      InstructionDiscovery.node.replace(instructionContext),
      Location.node.replace(Location.boundNode({ directory: AbsolutePath.make("/project") })),
      SkillInstructions.node.replace(skillInstructions),
      ReferenceInstructions.node.replace(referenceInstructions),
      Permission.node.replace(permission),
      Config.node.replace(config),
      PluginSupervisor.node.replace(Layer.empty),
      Plugin.node.replace(Layer.mock(Plugin.Service, { awaitActivation: Effect.void })),
      SessionModelTransport.node.replace(modelTransport),
    ]
    const runnerLayer = AppNodeBuilder.build(SessionRunnerLLM.node, [
      ...replacements,
      McpInstructions.node.replace(mcpInstructions),
    ])
    const execution = Layer.effect(
      SessionExecution.Service,
      Effect.gen(function* () {
        const sessionRunner = yield* SessionRunner.Service
        function drain(
          sessionID: Session.ID,
          force: boolean,
          continuation?: SessionRunner.Continuation,
        ): Effect.Effect<void, SessionRunner.RunError> {
          return sessionRunner
            .drain({ sessionID, force, continuation })
            .pipe(
              Effect.flatMap((result) =>
                result._tag === "Complete" ? Effect.void : drain(sessionID, false, result.continuation),
              ),
            )
        }
        const coordinator = yield* SessionRunCoordinator.make<Session.ID, SessionRunner.RunError>({
          drain: (sessionID, force) => drain(sessionID, force),
        })
        return SessionExecution.Service.of({
          active: coordinator.active,
          isActive: coordinator.isActive,
          resume: coordinator.run,
          wake: coordinator.wake,
          interrupt: (sessionID) => coordinator.interrupt(sessionID),
          awaitIdle: coordinator.awaitIdle,
        })
      }),
    ).pipe(Layer.provide(runnerLayer), Layer.orDie)
    return AppNodeBuilder.build(
      LayerNode.group([
        Database.node,
        Bus.node,
        Form.node,
        SessionProjector.node,
        SessionStore.node,
        SessionInbox.node,
        Agent.node,
        Catalog.node,
        Tool.node,
        PluginHooks.node,
        echoNode,
        SessionRunnerModel.node,
        InstructionBuiltIns.node,
        InstructionDiscovery.node,
        InstructionEntry.node,
        SkillInstructions.node,
        ReferenceInstructions.node,
        Config.node,
        Snapshot.node,
        SessionCompaction.node,
        SessionRunnerLLM.node,
        SessionExecution.node,
        Session.node,
      ]),
      [
        ...replacements,
        Bus.node.replace(Bus.configured({ persist: true })),
        LocationServiceMap.node.replace(promptLocationNode),
        Catalog.node.replace(promptCatalog),
        SessionExecution.node.replace(execution),
      ],
    )
  }),
).pipe(Layer.provideMerge(Layer.sync(RunnerState, makeRunnerState)), Layer.provideMerge(testLLM))
const it = testEffect(layer)
const sessionID = Session.ID.make("ses_runner_test")
const otherSessionID = Session.ID.make("ses_runner_other")

const insertSession = (id: Session.ID) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(SessionTable)
      .values({
        id,
        project_id: Project.ID.global,
        slug: id,
        directory: "/project",
        title: "test",
        version: "test",
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
  })

const setup = Effect.gen(function* () {
  const { db } = yield* Database.Service
  const bus = yield* Bus.Service
  const sessionInbox = yield* SessionInbox.Service
  const agents = yield* Agent.Service
  const catalog = yield* Catalog.Service
  const hooks = yield* PluginHooks.Service
  const pluginHost = host({
    agent: agentHost(agents),
    catalog: catalogHost(catalog),
    session: { hook: (name, callback) => hooks.register("session", name, callback) },
  })
  yield* Effect.forEach(OptimizePlugin.Plugins, (plugin) => plugin.effect(pluginHost), {
    discard: true,
  })
  yield* agents.transform((editor) =>
    editor.update(Agent.ID.make("build"), (agent) => {
      agent.mode = "primary"
    }),
  )
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* insertSession(sessionID)
  const state = yield* RunnerState
  const session = yield* Session.Service
  const llm = yield* TestLLM.Service
  const admit = (text: string) => session.prompt({ sessionID, text, resume: false })
  const resume = session.resume(sessionID)
  return Object.assign(state, {
    db,
    bus,
    sessionInbox,
    session,
    llm,
    requests: llm.requests,
    admit,
    resume,
    context: session.context(sessionID),
    messages: session.messages({ sessionID }),
    inbox: session.inbox(sessionID),
    runPrompt: Effect.fnUntraced(function* (text: string) {
      const message = yield* admit(text)
      yield* resume
      return message
    }),
    // Pause coordinated Session.resume at its first model request, not a direct runner drain.
    resumePaused: Effect.gen(function* () {
      const gate = yield* llm.gate
      const run = yield* resume.pipe(Effect.forkChild)
      yield* gate.started
      return { finish: gate.release.pipe(Effect.andThen(Fiber.join(run))) }
    }),
  })
})

type Scenario = Effect.Success<typeof setup>
const scenario = (
  name: string,
  body: (s: Scenario) => Effect.gen.Return<void, unknown, Layer.Success<typeof layer> | Scope.Scope>,
) =>
  it.effect(
    name,
    Effect.gen(function* () {
      const s = yield* setup
      return yield* body(s)
    }),
  )

// Subscribe before resuming; model requests can arrive before retry backoff is scheduled.
const subscribeRetries = (s: Scenario) =>
  Effect.gen(function* () {
    const scheduled = yield* Queue.unbounded<SessionMessage.ID>()
    yield* s.bus.subscribe(SessionEvent.RetryScheduled).pipe(
      Stream.filter((event) => event.data.sessionID === sessionID),
      Stream.runForEach((event) => Queue.offer(scheduled, event.data.assistantMessageID)),
      Effect.forkScoped({ startImmediately: true }),
    )
    return scheduled
  })

const providerUnavailable = () =>
  new AIError({
    reason: new TransportError({
      message: "Provider unavailable",
      transport: "http",
      operation: "request",
    }),
  })

const streamDisconnected = () =>
  new AIError({
    reason: new TransportError({
      message: "The socket connection was closed unexpectedly",
      transport: "http",
      operation: "read",
    }),
  })

const continuationRejected = (recovery: "retry-full" | "rotate-and-retry-full") =>
  new AIError({
    reason: new TransportError({
      message: "Continuation rejected",
      transport: "websocket",
      operation: "read",
      phase: "receive",
      delivery: "rejected",
      recovery,
    }),
  })

const incompleteStream = () =>
  new AIError({
    reason: new InvalidProviderOutputError({
      classification: "incomplete-stream",
      message: "The provider response ended unexpectedly.",
    }),
  })

const INCOMPLETE_STREAM_CONTINUATION =
  "The previous response was interrupted. Continue from where you left off without repeating completed content."

const invalidRequest = () =>
  new AIError({
    reason: new InvalidRequestError({ message: "Invalid request" }),
  })

const rateLimited = (retryAfterMs?: number) =>
  new AIError({
    reason: new RateLimitError({ message: "Rate limited", retryAfterMs }),
  })

const setupOverflowRecovery = Effect.fnUntraced(function* (s: Scenario) {
  yield* s.llm.push(TestLLM.text("Earlier answer", "text-earlier"))
  yield* s.runPrompt("Earlier question ".repeat(700))
  s.currentModel = recoveryModel
  s.requests.length = 0
})

const messageTexts = (request: LLMRequest, role: "user" | "system") =>
  request.messages.flatMap((message) =>
    message.role === role ? message.content.flatMap((content) => (content.type === "text" ? [content.text] : [])) : [],
  )
const userTexts = (request: LLMRequest) => messageTexts(request, "user")
const systemTexts = (request: LLMRequest) => messageTexts(request, "system")
const messageRoles = (request: LLMRequest | undefined) => request?.messages.map((message) => message.role)

const recordedEventTypes = (id: Session.ID) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    return yield* db
      .select({ type: EventTable.type })
      .from(EventTable)
      .where(eq(EventTable.aggregate_id, id))
      .orderBy(asc(EventTable.seq))
      .all()
      .pipe(
        Effect.orDie,
        Effect.map((rows) => rows.map((row) => row.type)),
      )
  })

const recordedStepSettlementEvents = (id: Session.ID, assistantMessageID: SessionMessage.ID) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const settlementTypes = new Set([
      "session.step.started.1",
      "session.tool.called.1",
      "session.tool.success.2",
      "session.tool.failed.2",
      "session.step.ended.1",
      "session.step.failed.1",
    ])
    return (yield* db
      .select({ type: EventTable.type, data: EventTable.data })
      .from(EventTable)
      .where(eq(EventTable.aggregate_id, id))
      .orderBy(asc(EventTable.seq))
      .all()
      .pipe(Effect.orDie)).filter(
      (event) => settlementTypes.has(event.type) && event.data.assistantMessageID === assistantMessageID,
    )
  })

const recordedStepSettlementTypes = (id: Session.ID, assistantMessageID: SessionMessage.ID) =>
  recordedStepSettlementEvents(id, assistantMessageID).pipe(Effect.map((events) => events.map((event) => event.type)))

const hostedCall = (id: string, query: string) =>
  LLMEvent.toolCall({ id, name: "web_search", input: { query }, providerExecuted: true })

const requireAssistant = (messages: readonly SessionMessage.Info[]) => {
  const assistant = messages.find((message) => message.type === "assistant")
  if (!assistant) throw new Error("Assistant message missing")
  return assistant
}

const replaySessionProjection = (id: Session.ID) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const bus = yield* Bus.Service
    const recorded = yield* db
      .select()
      .from(EventTable)
      .where(eq(EventTable.aggregate_id, id))
      .orderBy(asc(EventTable.seq))
      .all()
      .pipe(Effect.orDie)

    yield* bus.remove(id)
    yield* db.delete(InstructionStateTable).where(eq(InstructionStateTable.session_id, id)).run().pipe(Effect.orDie)
    yield* db.delete(SessionInboxTable).where(eq(SessionInboxTable.session_id, id)).run().pipe(Effect.orDie)
    yield* db.delete(SessionMessageTable).where(eq(SessionMessageTable.session_id, id)).run().pipe(Effect.orDie)
    yield* Effect.forEach(
      recorded.map((event) => ({
        id: event.id,
        created: event.created,
        aggregateID: event.aggregate_id,
        seq: event.seq,
        type: event.type,
        data: event.data,
      })),
      (event) => bus.replay(event),
      { discard: true },
    )
  })

type FragmentKind = "text" | "reasoning" | "tool input"

type FragmentFixture = {
  readonly delta?: Event.Definition
  readonly completeEvents: LLMEvent[]
  readonly partialEvents: LLMEvent[]
  readonly expectedAssistant: unknown
  readonly expectedContent: unknown
}

const fragmentKinds: readonly FragmentKind[] = ["text", "reasoning", "tool input"]

const fragmentID = (kind: FragmentKind, suffix: string) => `${kind === "tool input" ? "call" : kind}-${suffix}`

const fragmentFixture = (kind: FragmentKind, id: string, chunks: readonly string[]): FragmentFixture => {
  const text = chunks.join("")
  switch (kind) {
    case "text": {
      const partialEvents = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.textStart({ id }),
        ...chunks.map((text) => LLMEvent.textDelta({ id, text })),
      ]
      const expectedContent = { type: "text", text }
      return {
        delta: SessionEvent.Text.Delta,
        partialEvents,
        completeEvents: [
          ...partialEvents,
          LLMEvent.textEnd({ id }),
          LLMEvent.stepFinish({ index: 0, reason: { normalized: "stop" } }),
          LLMEvent.finish({ reason: { normalized: "stop" } }),
        ],
        expectedAssistant: { type: "assistant", finish: "stop", content: [expectedContent] },
        expectedContent,
      }
    }
    case "reasoning": {
      const partialEvents = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.reasoningStart({ id }),
        ...chunks.map((text) => LLMEvent.reasoningDelta({ id, text })),
      ]
      const expectedContent = { type: "reasoning", text }
      return {
        delta: SessionEvent.Reasoning.Delta,
        partialEvents,
        completeEvents: [
          ...partialEvents,
          LLMEvent.reasoningEnd({ id }),
          LLMEvent.stepFinish({ index: 0, reason: { normalized: "stop" } }),
          LLMEvent.finish({ reason: { normalized: "stop" } }),
        ],
        expectedAssistant: { type: "assistant", finish: "stop", content: [expectedContent] },
        expectedContent,
      }
    }
    case "tool input": {
      const partialEvents = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolInputStart({ id, name: "echo" }),
        ...chunks.map((text) => LLMEvent.toolInputDelta({ id, name: "echo", text })),
      ]
      const expectedContent = { type: "tool", id, state: { status: "streaming", input: text } }
      return {
        partialEvents,
        completeEvents: [...partialEvents, LLMEvent.toolInputEnd({ id, name: "echo" })],
        expectedAssistant: { type: "assistant", content: [expectedContent] },
        expectedContent,
      }
    }
  }
}

function* verifyEphemeralDeltas(s: Scenario, kind: FragmentKind) {
  const prompt = `Stream ${kind}`
  const chunks = Array.from({ length: 32 }, (_, index) => `${index},`)
  const fixture = fragmentFixture(kind, fragmentID(kind, "many"), chunks)
  const expectedContext = [{ type: "user", text: prompt }, fixture.expectedAssistant]
  yield* s.admit(prompt)
  const live = fixture.delta
    ? yield* s.bus.subscribe(fixture.delta).pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
    : undefined
  yield* Effect.yieldNow
  yield* s.llm.push(fixture.completeEvents)

  yield* s.resume

  const deltas = fixture.delta
    ? yield* s.db
        .select({ type: EventTable.type })
        .from(EventTable)
        .where(eq(EventTable.type, Bus.versionedType(fixture.delta.type, 1)))
        .all()
        .pipe(Effect.orDie)
    : []
  if (live) {
    const streamed = Array.from(yield* Fiber.join(live))
    expect(streamed).toHaveLength(1)
    expect(
      streamed
        .map((event) => {
          if (!event.data || typeof event.data !== "object" || !("delta" in event.data))
            throw new Error("Expected delta event")
          if (typeof event.data.delta !== "string") throw new Error("Expected string delta")
          return event.data.delta
        })
        .join(""),
    ).toBe(chunks.join(""))
  }
  expect(deltas).toHaveLength(0)
  expect(yield* s.context).toMatchObject(expectedContext)

  yield* replaySessionProjection(sessionID)

  expect(yield* s.context).toMatchObject(expectedContext)
}

function* verifyPartialFlushOnFailure(s: Scenario, kind: FragmentKind) {
  const prompt = `Fail after ${kind}`
  const fixture = fragmentFixture(kind, fragmentID(kind, "partial"), ["Partial"])
  // A non-retryable failure keeps the step terminal so the flushed fragments settle durably.
  const failure = invalidRequest()
  yield* s.admit(prompt)
  yield* s.llm.push(TestLLM.failAfter(failure, ...fixture.partialEvents))

  expect(yield* s.resume.pipe(Effect.flip)).toBe(failure)
  expect(yield* s.context).toMatchObject([
    Expected.user(prompt),
    Expected.assistant({ finish: "error", error: { type: "provider.invalid-request", message: "Invalid request" } }, [
      kind === "tool input"
        ? Expected.failedTool(
            { id: fragmentID(kind, "partial") },
            { error: { type: "provider.invalid-request", message: "Invalid request" } },
          )
        : fixture.expectedContent,
    ]),
  ])
  expect(s.requests).toHaveLength(1)
}

function* verifyPartialFlushOnInterruption(s: Scenario, kind: FragmentKind) {
  const prompt = `Interrupt after ${kind}`
  const fixture = fragmentFixture(kind, fragmentID(kind, "interrupted"), ["Partial"])
  const streamed = yield* Deferred.make<void>()
  yield* s.admit(prompt)
  yield* s.llm.push(
    Stream.concat(
      Stream.fromIterable(fixture.partialEvents),
      Stream.fromEffect(Deferred.succeed(streamed, undefined)).pipe(Stream.flatMap(() => Stream.never)),
    ),
  )

  const runner = yield* SessionRunner.Service
  const fiber = yield* runner.drain({ sessionID, force: true }).pipe(Effect.forkChild)
  yield* Deferred.await(streamed)
  yield* Fiber.interrupt(fiber)
  expect(yield* s.context).toMatchObject([
    Expected.user(prompt),
    Expected.assistant({ finish: "error", error: { type: "aborted", message: "Step interrupted" } }, [
      kind === "tool input"
        ? Expected.failedTool({ id: fragmentID(kind, "interrupted") }, {})
        : fixture.expectedContent,
    ]),
  ])
}

const prepareTitleGeneration = Effect.gen(function* () {
  const agents = yield* Agent.Service
  const { db } = yield* Database.Service
  yield* db.update(SessionTable).set({ title: null }).where(eq(SessionTable.id, sessionID)).run().pipe(Effect.orDie)
  yield* agents.transform((editor) =>
    editor.update(Agent.ID.make("title"), (agent) => {
      agent.mode = "primary"
      agent.hidden = true
      agent.system = "Generate a title."
    }),
  )
})

const watchRename = Effect.fnUntraced(function* (sessionID: Session.ID) {
  const bus = yield* Bus.Service
  return yield* bus.subscribe(SessionEvent.Renamed).pipe(
    Stream.filter((event) => event.data.sessionID === sessionID),
    Stream.take(1),
    Stream.runDrain,
    Effect.forkScoped({ startImmediately: true }),
  )
})

describe("SessionRunnerLLM", () => {
  scenario("generates the title while the first model step is still running", function* (s) {
    yield* prepareTitleGeneration

    yield* s.admit("First prompt")
    yield* s.llm.push(TestLLM.text("Generated title", "text-title"), Stream.never)
    const renamed = yield* watchRename(sessionID)
    const runner = yield* SessionRunner.Service
    const fiber = yield* runner.drain({ sessionID, force: true }).pipe(Effect.forkChild)
    yield* Fiber.join(renamed)

    expect((yield* s.session.get(sessionID)).title).toBe("Generated title")
    yield* Fiber.interrupt(fiber)
  })

  scenario("does not automatically replace an existing session title", function* (s) {
    yield* prepareTitleGeneration
    yield* s.session.rename({ sessionID, title: "Manual title" })
    yield* s.admit("Follow-up prompt")
    yield* s.llm.push(TestLLM.text("Assistant response", "text-response"))

    yield* s.resume

    expect(s.requests).toHaveLength(1)
    expect((yield* s.session.get(sessionID)).title).toBe("Manual title")
  })

  scenario("coalesces title generation while a request is active", function* (s) {
    yield* prepareTitleGeneration

    const titleStarted = yield* Deferred.make<void>()
    const releaseTitle = yield* Deferred.make<void>()
    yield* Effect.gen(function* () {
      yield* s.admit("First prompt")
      yield* s.llm.push(
        Stream.unwrap(
          Deferred.succeed(titleStarted, undefined).pipe(
            Effect.andThen(Deferred.await(releaseTitle)),
            Effect.as(Stream.fromIterable(TestLLM.text("Generated title", "text-title"))),
          ),
        ),
        TestLLM.text("First response", "text-first"),
        TestLLM.text("Second response", "text-second"),
      )

      const first = yield* s.resume.pipe(Effect.forkChild)
      yield* Deferred.await(titleStarted).pipe(Effect.timeout("5 seconds"))
      expect(s.requests[0]?.system.map((part) => part.text)).toContain("Generate a title.")
      yield* Fiber.join(first)
      yield* s.admit("Second prompt")
      yield* s.resume

      expect(s.requests).toHaveLength(3)
      const renamed = yield* watchRename(sessionID)
      yield* Deferred.succeed(releaseTitle, undefined)
      yield* Fiber.join(renamed)
      expect((yield* s.session.get(sessionID)).title).toBe("Generated title")
    }).pipe(Effect.ensuring(Deferred.succeed(releaseTitle, undefined)))
  })

  scenario("retries title generation from the first prompt after title and execution failures", function* (s) {
    yield* prepareTitleGeneration

    yield* s.admit("First prompt")
    yield* s.llm.push(Stream.fail(invalidRequest()), Stream.fail(invalidRequest()))
    expect((yield* s.resume.pipe(Effect.exit))._tag).toBe("Failure")

    yield* s.admit("Second prompt")
    const titleFailed = yield* Deferred.make<void>()
    yield* s.llm.push(
      Stream.make(LLMEvent.providerError({ message: "Title provider unavailable" })).pipe(
        Stream.ensuring(Deferred.succeed(titleFailed, undefined)),
      ),
      TestLLM.text("Recovered", "text-recovered"),
    )
    yield* s.resume
    yield* Deferred.await(titleFailed)
    yield* Effect.yieldNow
    expect((yield* s.session.get(sessionID)).title).toBeUndefined()

    const renamed = yield* watchRename(sessionID)
    yield* s.admit("Third prompt")
    yield* s.llm.push(
      TestLLM.text("Generated title", "text-title"),
      TestLLM.text("Recovered again", "text-recovered-again"),
    )
    yield* s.resume
    yield* Fiber.join(renamed)

    expect(s.requests).toHaveLength(6)
    expect(s.requests[2]?.messages).toContainEqual(Message.user("First prompt"))
    expect(s.requests[4]?.messages).toContainEqual(Message.user("First prompt"))
    expect((yield* s.session.get(sessionID)).title).toBe("Generated title")
  })

  scenario("advertises and executes a location registered tool", function* (s) {
    const registry = yield* Tool.Service
    const contexts: Tool.Context[] = []
    yield* transformTools(
      registry,
      {
        location_context: {
          name: "location_context",
          description: "Read application context",
          input: Schema.Struct({ query: Schema.String }),
          output: Schema.Struct({ answer: Schema.String }),
          execute: ({ query }, context) =>
            Effect.gen(function* () {
              contexts.push(context)
              yield* context.progress({ phase: "reading" })
              return { output: { answer: query.toUpperCase() } }
            }),
        },
      },
      { codemode: false },
    )
    yield* s.admit("Use application context")
    yield* s.llm.push(TestLLM.tool("call-location", "location_context", { query: "hello" }), [])

    const progressFiber = yield* s.bus.subscribe(SessionEvent.Tool.Progress).pipe(
      Stream.filter((event) => event.data.sessionID === sessionID && event.data.id === "call-location"),
      Stream.take(1),
      Stream.runCollect,
      Effect.forkScoped({ startImmediately: true }),
    )

    yield* s.resume

    expect(s.requests[0]?.tools.map((tool) => tool.name)).toContain("location_context")
    expect(contexts).toEqual([
      {
        sessionID,
        agent: Agent.ID.make("build"),
        messageID: expect.stringMatching(/^msg_/),
        id: Tool.CallID.make("call-location"),
        progress: expect.any(Function),
      },
    ])
    expect(Array.from(yield* Fiber.join(progressFiber))[0]?.data.metadata).toEqual({ phase: "reading" })
    expect(yield* s.context).toMatchObject([
      Expected.user("Use application context"),
      Expected.assistant({}, [
        Expected.completedTool({ id: "call-location" }, { content: [Expected.text('{"answer":"HELLO"}')] }),
      ]),
    ])
  })

  scenario("executes a tool renamed by a session context hook", function* (s) {
    const hooks = yield* PluginHooks.Service
    yield* hooks.register("session", "context", (event) =>
      Effect.sync(() => {
        event.tools.renamed_echo = event.tools.echo!
        delete event.tools.echo
      }),
    )
    yield* s.admit("Use the renamed tool")
    yield* s.llm.push(TestLLM.tool("call-renamed", "renamed_echo", { text: "renamed" }), [])

    yield* s.resume

    expect(s.requests[0]?.tools.map((tool) => tool.name)).toContain("renamed_echo")
    expect(s.requests[0]?.tools.map((tool) => tool.name)).not.toContain("echo")
    expect(s.executions).toEqual(["renamed"])
  })

  scenario("executes the tool advertised before a registry reload", function* (s) {
    const registry = yield* Tool.Service
    const scope = yield* Scope.make()
    const executions: string[] = []
    yield* transformTools(
      registry,
      {
        reloaded: {
          name: "reloaded",
          description: "Record the advertised tool",
          input: Schema.Struct({}),
          output: Schema.Struct({ value: Schema.String }),
          execute: () =>
            Effect.sync(() => executions.push("advertised")).pipe(Effect.as({ output: { value: "advertised" } })),
        },
      },
      { codemode: false },
    ).pipe(Scope.provide(scope))
    yield* s.admit("Use the reloaded tool")
    yield* s.llm.push(TestLLM.tool("call-reloaded", "reloaded", {}), [])

    const run = yield* s.resumePaused
    yield* Scope.close(scope, Exit.void)
    yield* transformTools(
      registry,
      {
        reloaded: {
          name: "reloaded",
          description: "Record the replacement tool",
          input: Schema.Struct({}),
          output: Schema.Struct({ value: Schema.String }),
          execute: () =>
            Effect.sync(() => executions.push("replacement")).pipe(Effect.as({ output: { value: "replacement" } })),
        },
      },
      { codemode: false },
    )
    yield* run.finish

    expect(executions).toEqual(["advertised"])
    expect(yield* s.context).toMatchObject([
      Expected.user("Use the reloaded tool"),
      Expected.assistant({}, [
        Expected.completedTool({ id: "call-reloaded" }, { content: [Expected.text('{"value":"advertised"}')] }),
      ]),
    ])
  })

  scenario("starts a real runner step after default prompt recording", function* (s) {
    const message = yield* s.session.prompt({
      sessionID,
      text: "Run automatically",
    })
    yield* s.session.wait(sessionID)

    expect(s.requests).toHaveLength(1)
    expect(yield* s.messages).toMatchObject([{ id: message.id, type: "user", text: "Run automatically" }])
  })

  scenario("runs a follow-up when synthetic input arrives during an active continuation", function* (s) {
    const secondStarted = yield* Deferred.make<void>()
    const releaseSecond = yield* Deferred.make<void>()
    yield* s.llm.push(
      Stream.fromIterable(TestLLM.tool("call-echo", "echo", { text: "background started" })),
      Stream.unwrap(
        Deferred.succeed(secondStarted, undefined).pipe(
          Effect.andThen(Deferred.await(releaseSecond)),
          Effect.as(Stream.fromIterable(TestLLM.stop())),
        ),
      ),
      Stream.fromIterable(TestLLM.text("Handled completion", "text-completion")),
    )
    yield* s.admit("Start background work")
    const running = yield* s.resume.pipe(Effect.forkChild({ startImmediately: true }))
    yield* Deferred.await(secondStarted)

    yield* s.session.synthetic({ sessionID, text: "Background work completed" })
    yield* Deferred.succeed(releaseSecond, undefined)
    yield* Fiber.join(running)

    expect(s.requests).toHaveLength(3)
    expect(userTexts(s.requests[2])).toContain("Background work completed")
  })

  scenario("streams one request with registry definitions from chronological user history", function* (s) {
    yield* s.admit("First")
    yield* s.runPrompt("Second")

    expect(s.requests).toHaveLength(1)
    expect(s.requests[0]?.model).toBe(model)
    expect(s.requests[0]?.tools.map((tool) => tool.name)).toEqual(["defect", "echo", "storefail"])
    expect(s.requests[0]?.messages.map((message) => ({ role: message.role, content: message.content }))).toEqual([
      { role: "user", content: [{ type: "text", text: "First" }] },
      { role: "user", content: [{ type: "text", text: "Second" }] },
    ])
    expect(yield* s.messages).toHaveLength(2)
  })

  scenario("marks the initial instruction sync as baseline metadata", function* (s) {
    const instructionEvents: Event.Payload[] = []
    const unsubscribe = yield* s.bus.listen((event) =>
      Effect.sync(() => {
        if (event.type === "session.instructions.updated") instructionEvents.push(event)
      }),
    )
    yield* s.runPrompt("First")
    s.systemBaseline = "Changed context"
    yield* s.runPrompt("Second")
    yield* unsubscribe

    expect(instructionEvents).toHaveLength(2)
    expect(instructionEvents[0]?.metadata).toEqual({ instructions: { initial: true } })
    expect(instructionEvents[1]?.metadata).toBeUndefined()
  })

  scenario("retries the first request after system context becomes available", function* (s) {
    const messageID = SessionMessage.ID.create()
    s.systemUnavailable = true
    yield* s.session.prompt({
      id: messageID,
      sessionID,
      text: "First",
      resume: false,
    })

    const exit = yield* s.resume.pipe(Effect.exit)

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBeInstanceOf(Instructions.InitializationBlocked)
    expect(s.requests).toHaveLength(0)
    expect(yield* SessionInbox.has(s.db, sessionID, "steer")).toBe(true)
    expect(
      yield* s.db.select().from(InstructionStateTable).where(eq(InstructionStateTable.session_id, sessionID)).get(),
    ).toBeUndefined()

    s.systemUnavailable = false
    yield* s.session.prompt({ id: messageID, sessionID, text: "First" })
    yield* s.session.wait(sessionID)

    expect(s.requests).toHaveLength(1)
    expect(messageRoles(s.requests[0])).toEqual(["user"])
  })

  scenario(
    "preserves instruction state and interrupts the source Location runner after a Session moves",
    function* (s) {
      yield* s.runPrompt("First")
      const instructionState = yield* s.db
        .select()
        .from(InstructionStateTable)
        .where(eq(InstructionStateTable.session_id, sessionID))
        .get()

      yield* s.bus.publish(SessionEvent.Moved, {
        sessionID,
        location: Location.Ref.make({ directory: AbsolutePath.make("/moved") }),
        projectID: Project.ID.global,
      })
      expect(
        yield* s.db.select().from(InstructionStateTable).where(eq(InstructionStateTable.session_id, sessionID)).get(),
      ).toEqual(instructionState)

      yield* s.admit("Second")
      const exit = yield* s.resume.pipe(Effect.exit)

      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
      expect(s.requests).toHaveLength(1)
      expect(yield* SessionInbox.has(s.db, sessionID, "steer")).toBe(true)
    },
  )

  scenario("delivers controls without preflighting unavailable initial instructions", function* (s) {
    const runner = yield* SessionRunner.Service
    s.systemUnavailable = true
    let reads = 0
    s.systemLoadHook = Effect.sync(() => {
      reads++
    })
    const compaction = yield* s.sessionInbox.admitCompaction({
      id: SessionMessage.ID.create(),
      sessionID,
      delivery: "queue",
    })
    yield* s.sessionInbox.admit({
      id: SessionMessage.ID.create(),
      sessionID,
      item: {
        type: "move",
        payload: {
          location: Location.Ref.make({ directory: AbsolutePath.make("/moved") }),
          projectID: Project.ID.global,
        },
        delivery: "queue",
      },
    })

    expect(yield* runner.drain({ sessionID, force: false })).toEqual(SessionRunner.DrainResult.Moved({}))

    expect(reads).toBe(0)
    expect(s.requests).toHaveLength(0)
    expect(yield* s.inbox).toEqual([])
    expect((yield* s.session.get(sessionID)).location.directory).toBe(AbsolutePath.make("/moved"))
    expect((yield* s.messages).find((message) => message.id === compaction.id)).toMatchObject({
      type: "compaction",
      status: "failed",
      error: { type: "compaction.unavailable", message: "Nothing to compact yet" },
    })
  })

  scenario("delivers a queued move atomically at the idle boundary", function* (s) {
    const inboxID = SessionMessage.ID.create()
    yield* s.sessionInbox.admit({
      id: inboxID,
      sessionID,
      item: {
        type: "move",
        payload: {
          location: Location.Ref.make({ directory: AbsolutePath.make("/moved") }),
          projectID: Project.ID.global,
        },
        delivery: "queue",
      },
    })

    yield* s.resume

    expect((yield* s.session.get(sessionID)).location.directory).toBe(AbsolutePath.make("/moved"))
    expect(yield* s.inbox).toEqual([])
    expect(s.requests).toEqual([])
    expect(s.closedTransports).toEqual([sessionID])
    expect(
      (yield* s.db
        .select({ type: EventTable.type })
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, sessionID))
        .orderBy(desc(EventTable.seq))
        .limit(2)
        .all()).map((event) => event.type),
    ).toEqual([Bus.versionedType(SessionEvent.Moved.type, 1), Bus.versionedType(SessionEvent.InboxDelivered.type, 1)])
  })

  for (const delivery of ["steer", "queue"] as const) {
    scenario(`preserves a tool continuation and step allowance across chained moves (${delivery})`, function* (s) {
      const agents = yield* Agent.Service
      yield* agents.transform((editor) =>
        editor.update(Agent.ID.make("build"), (agent) => {
          agent.steps = 2
        }),
      )
      yield* s.admit("Echo before moving")
      yield* s.llm.push(TestLLM.tool("call-move", "echo", { text: "moving" }), TestLLM.text("Done", "text-after-move"))
      const tools = yield* s.blockTools()
      const run = yield* s.resume.pipe(Effect.forkChild)
      yield* tools.started
      yield* Effect.forEach(["steer", delivery] as const, (delivery) =>
        s.sessionInbox.admit({
          id: SessionMessage.ID.create(),
          sessionID,
          item: {
            type: "move",
            payload: {
              location: Location.Ref.make({ directory: AbsolutePath.make("/project") }),
              projectID: Project.ID.global,
            },
            delivery,
          },
        }),
      )

      yield* tools.release
      yield* Fiber.join(run)

      expect(s.requests).toHaveLength(2)
      expect(messageRoles(s.requests[1])?.slice(0, 3)).toEqual(["user", "assistant", "tool"])
      expect(s.requests[0]?.toolChoice).toBeUndefined()
      expect(s.requests[1]?.toolChoice).toMatchObject({ type: "none" })
      expect(
        (yield* recordedEventTypes(sessionID)).filter(
          (type) => type === "session.step.started.1" || type === "session.moved.1",
        ),
      ).toEqual(["session.step.started.1", "session.moved.1", "session.moved.1", "session.step.started.1"])
      expect(yield* s.inbox).toEqual([])
    })
  }

  scenario("keeps queued input parked across a mid-turn move", function* (s) {
    yield* s.admit("Echo before moving")
    yield* s.llm.push(
      TestLLM.tool("call-move", "echo", { text: "moving" }),
      TestLLM.text("Done", "text-after-move"),
      TestLLM.text("Handled queue", "text-after-queue"),
    )
    const tools = yield* s.blockTools()
    const run = yield* s.resume.pipe(Effect.forkChild)
    yield* tools.started
    yield* s.session.prompt({ sessionID, text: "Queued for later", delivery: "queue", resume: false })
    yield* s.sessionInbox.admit({
      id: SessionMessage.ID.create(),
      sessionID,
      item: {
        type: "move",
        payload: {
          location: Location.Ref.make({ directory: AbsolutePath.make("/project") }),
          projectID: Project.ID.global,
        },
        delivery: "steer",
      },
    })

    yield* tools.release
    yield* Fiber.join(run)

    // The resumed turn absorbs steers only; queued input waits for the turn to end.
    expect(s.requests).toHaveLength(3)
    expect(userTexts(s.requests[1])).not.toContain("Queued for later")
    expect(userTexts(s.requests[2])).toContain("Queued for later")
  })

  scenario("runs a queued control on Location entry before a carried continuation", function* (s) {
    const runner = yield* SessionRunner.Service
    yield* s.admit("Echo before moving")
    yield* s.llm.push(
      TestLLM.tool("call-entry", "echo", { text: "moving" }),
      TestLLM.text("## Objective\n- Entry summary", "entry-summary"),
      TestLLM.text("Continued", "entry-continuation"),
    )
    const stream = yield* s.llm.gate
    const run = yield* runner.drain({ sessionID, force: false }).pipe(Effect.forkChild)
    yield* stream.started
    const compaction = yield* s.sessionInbox.admitCompaction({
      id: SessionMessage.ID.create(),
      sessionID,
      delivery: "queue",
    })
    yield* s.sessionInbox.admit({
      id: SessionMessage.ID.create(),
      sessionID,
      item: {
        type: "move",
        payload: {
          location: Location.Ref.make({ directory: AbsolutePath.make("/project") }),
          projectID: Project.ID.global,
        },
        delivery: "steer",
      },
    })
    yield* stream.release
    const moved = yield* Fiber.join(run)

    expect(moved).toEqual(SessionRunner.DrainResult.Moved({ continuation: { step: 2 } }))
    expect(s.requests).toHaveLength(1)
    expect(yield* SessionInbox.find(s.db, compaction.id)).toMatchObject({ id: compaction.id })
    if (moved._tag !== "Moved") throw new Error("Expected a Location handoff")

    // Location entry considers queued controls even when model work carries across the move.
    yield* runner.drain({ sessionID, force: false, continuation: moved.continuation })

    expect(s.requests).toHaveLength(3)
    expect(userTexts(s.requests[2])[0]).toContain("<summary>\n## Objective\n- Entry summary\n</summary>")
    expect(yield* s.inbox).toEqual([])
  })

  scenario(
    "restores installed native context with auto disabled and preserves it across fork and revert",
    function* (s) {
      const compaction = yield* SessionCompaction.Service
      yield* compaction.transform((editor) => editor.configure({ auto: false }))
      yield* s.runPrompt("Original request")
      s.systemBaseline = "Checkpoint instructions"
      yield* s.runPrompt("Before checkpoint")
      const target = SessionProviderContext.provenance({
        model: s.currentModel,
        ref: Model.Ref.make({
          id: Model.ID.make(s.currentModel.id),
          providerID: Provider.ID.make(s.currentModel.provider),
        }),
      })
      if (!target) throw new Error("Expected concrete fixture endpoint")
      const replacement = [
        Message.assistant(CompactionPart.make({ provider: s.currentModel.provider, encrypted: "checkpoint" })),
      ]
      const providerContext = SessionProviderContext.encode(target, replacement)
      yield* s.bus.publish(SessionEvent.Compaction.Ended, {
        sessionID,
        reason: "manual",
        text: "",
        recent: "",
        providerContext,
      })
      const checkpoint = (yield* s.messages).find((message) => message.type === "compaction")
      if (!checkpoint) throw new Error("Expected checkpoint")

      s.systemBaseline = "Newest instructions"
      const after = yield* s.runPrompt("After checkpoint")
      const continued = s.requests.at(-1)
      if (!continued) throw new Error("Expected continuation request")
      expect(continued.messages[0]).toEqual(replacement[0])
      expect(continued.system.map((part) => part.text)).toContain("Checkpoint instructions")
      expect(systemTexts(continued)).toEqual(["Newest instructions"])

      const forked = yield* s.session.fork({ sessionID, boundary: { type: "before", messageID: after.id } })
      yield* s.session.prompt({ sessionID: forked.id, text: "Fork prompt", resume: false })
      yield* s.session.resume(forked.id)
      expect(s.requests.at(-1)?.messages[0]).toEqual(replacement[0])
      expect(s.requests.at(-1)?.system.map((part) => part.text)).toContain("Newest instructions")
      expect(s.requests.at(-1)?.messages.filter((message) => message.role === "system")).toEqual([
        Message.system("Newest instructions"),
      ])
      expect(
        (yield* s.session.messages({ sessionID: forked.id })).find((message) => message.type === "compaction"),
      ).toMatchObject({ providerContext })

      const original = s.currentModel
      s.currentModel = LanguageModel.update(original, { id: "different-deployment" })
      yield* s.session.prompt({ sessionID: forked.id, text: "Switched fork", resume: false })
      yield* s.session.resume(forked.id)
      expect(s.requests.at(-1)?.messages[0]?.content).toEqual([Message.text("Original request")])
      expect(s.requests.at(-1)?.messages.filter((message) => message.role === "system")).toEqual([
        Message.system("Newest instructions"),
      ])
      s.currentModel = original

      yield* s.bus.publish(SessionEvent.RevertEvent.Committed, { sessionID, to: checkpoint.id })
      yield* s.runPrompt("After revert")
      expect(
        s.requests
          .at(-1)
          ?.messages.flatMap((message) => message.content)
          .some((part) => part.type === "compaction"),
      ).toBe(false)
      expect(s.requests.at(-1)?.messages[0]?.content).toEqual([Message.text("Original request")])
      expect(
        (yield* s.session.messages({ sessionID: forked.id })).find((message) => message.type === "compaction"),
      ).toMatchObject({ providerContext })

      const hooks = yield* PluginHooks.Service
      yield* hooks.register("session", "model.request", (event) =>
        Effect.sync(() => {
          event.baseURL = "https://another-deployment.example/v1"
        }),
      )
      const before = s.requests.length
      yield* s.session.prompt({ sessionID: forked.id, text: "Changed route", resume: false })
      expect(yield* s.session.resume(forked.id).pipe(Effect.exit)).toMatchObject({ _tag: "Failure" })
      expect(s.requests).toHaveLength(before)
    },
  )

  scenario("seeds a fork with the parent's newest instruction values", function* (s) {
    yield* s.runPrompt("First")
    s.systemBaseline = "Changed context"
    const second = yield* s.runPrompt("Second")
    s.systemBaseline = "Latest context"
    yield* s.runPrompt("Third")

    const forked = yield* s.session.fork({ sessionID, boundary: { type: "before", messageID: second.id } })
    expect(
      yield* s.db.select().from(InstructionStateTable).where(eq(InstructionStateTable.session_id, forked.id)).get(),
    ).toMatchObject({
      initial_values: { "test/context": Instructions.hash("Latest context") },
      current_values: { "test/context": Instructions.hash("Latest context") },
    })
    yield* s.session.prompt({ sessionID: forked.id, text: "Forked", resume: false })
    yield* s.session.resume(forked.id)

    expect(s.requests.at(-1)?.system.map((part) => part.text)).toEqual([defaultSystem, "Latest context"])
    // Copied history keeps the frozen chronological update; no new update is emitted.
    expect(systemTexts(s.requests.at(-1)!)).toContain("Changed context")
    expect(systemTexts(s.requests.at(-1)!)).not.toContain("Latest context")

    const recorded = yield* s.db
      .select()
      .from(EventTable)
      .where(eq(EventTable.aggregate_id, forked.id))
      .orderBy(asc(EventTable.seq))
      .all()
    yield* s.bus.remove(forked.id)
    yield* s.db.delete(SessionTable).where(eq(SessionTable.id, forked.id)).run()
    yield* Effect.forEach(
      recorded.map((event) => ({
        id: event.id,
        created: event.created,
        aggregateID: event.aggregate_id,
        seq: event.seq,
        type: event.type,
        data: event.data,
      })),
      (event) => s.bus.replay(event),
      { discard: true },
    )
    expect(
      yield* s.db.select().from(InstructionStateTable).where(eq(InstructionStateTable.session_id, forked.id)).get(),
    ).toMatchObject({ current_values: { "test/context": Instructions.hash("Latest context") } })
  })

  scenario("keeps nested forks self-contained", function* (s) {
    yield* s.runPrompt("First")
    s.systemBaseline = "Changed context"
    const second = yield* s.runPrompt("Second")

    const child = yield* s.session.fork({ sessionID, boundary: { type: "before", messageID: second.id } })
    const inheritedFirst = (yield* s.session.messages({ sessionID: child.id })).find(
      (message) => message.type === "user" && message.text === "First",
    )
    if (!inheritedFirst) return yield* Effect.die(new Error("Nested fork boundary message not found"))
    const grandchild = yield* s.session.fork({
      sessionID: child.id,
      boundary: { type: "before", messageID: inheritedFirst.id },
    })

    expect(
      yield* s.db.select().from(InstructionStateTable).where(eq(InstructionStateTable.session_id, grandchild.id)).get(),
    ).toMatchObject({
      initial_values: { "test/context": Instructions.hash("Changed context") },
      current_values: { "test/context": Instructions.hash("Changed context") },
    })
    return undefined
  })

  scenario("re-establishes a fresh baseline when instruction state is missing", function* (s) {
    yield* s.runPrompt("First")
    yield* s.db.delete(InstructionStateTable).where(eq(InstructionStateTable.session_id, sessionID)).run()
    yield* s.admit("Second")
    s.requests.length = 0

    yield* s.resume

    expect(s.requests).toHaveLength(1)
    expect(s.requests[0]?.system.map((part) => part.text)).toEqual([defaultSystem, "Initial context"])
    expect(messageRoles(s.requests[0])).toEqual(["user", "user"])
    // The projected row is authoritative: a missing row admits a fresh baseline
    // instead of rebuilding from durable events.
    expect(
      yield* s.db
        .select({ data: EventTable.data })
        .from(EventTable)
        .where(eq(EventTable.type, "session.instructions.updated.2"))
        .all(),
    ).toHaveLength(2)
    expect(yield* s.db.select().from(InstructionStateTable).get()).toMatchObject({
      initial_values: { "test/context": Instructions.hash("Initial context") },
      current_values: { "test/context": Instructions.hash("Initial context") },
    })
  })

  scenario("keeps the initial instructions stable and derives a chronological update from values", function* (s) {
    yield* s.runPrompt("First")
    s.systemBaseline = "Changed context"
    yield* s.runPrompt("Second")

    for (const field of [
      "model",
      "generation",
      "providerOptions",
      "http",
      "toolChoice",
      "cache",
      "tools",
      "system",
    ] as const)
      expect(s.requests[1][field]).toEqual(s.requests[0][field])
    expect(s.requests[0].messages).toHaveLength(1)
    expect(s.requests[1].messages.slice(0, 1)).toEqual([...s.requests[0].messages])
    expect(s.requests.map((request) => request.system.map((part) => part.text))).toEqual([
      [defaultSystem, "Initial context"],
      [defaultSystem, "Initial context"],
    ])
    expect(messageRoles(s.requests[1])).toEqual(["user", "system", "user"])
    expect(s.requests[1]?.messages.at(1)?.content).toEqual([Expected.text("Changed context")])
    // The chronological update is a durable client-visible system message.
    const messages = yield* s.messages
    expect(messages).toHaveLength(3)
    expect(messages[1]).toMatchObject({ type: "system", text: "Changed context" })

    const updates = yield* s.db
      .select({ data: EventTable.data })
      .from(EventTable)
      .where(eq(EventTable.type, "session.instructions.updated.2"))
      .orderBy(asc(EventTable.seq))
      .all()
      .pipe(Effect.orDie)
    expect(updates).toHaveLength(2)
    expect(updates[0]?.data).toMatchObject({
      sessionID,
      delta: { "test/context": Instructions.hash("Initial context") },
    })
    expect(updates[1]?.data).toEqual({
      sessionID,
      delta: { "test/context": Instructions.hash("Changed context") },
      text: "Changed context",
    })
    yield* replaySessionProjection(sessionID)
    expect(yield* s.messages).toHaveLength(3)
  })

  scenario("uses the selected model family prompt when the agent does not override it", function* (s) {
    s.currentModel = LanguageModel.make({ id: "gpt-5", provider: "openai", route: OpenAIChat.route })
    yield* s.admit("First")

    yield* s.llm.push(TestLLM.text("Done", "text-provider-prompt"))
    yield* s.resume

    expect(s.requests.at(-1)?.system.map((part) => part.text)).toEqual([
      expect.stringContaining("# Delegation"),
      "Initial context",
    ])
  })

  scenario("uses the selected model family prompt when the agent system override is empty", function* (s) {
    s.currentModel = LanguageModel.make({ id: "gpt-5", provider: "openai", route: OpenAIChat.route })
    const agent = yield* Agent.Service
    yield* agent.transform((editor) =>
      editor.update(Agent.ID.make("build"), (agent) => {
        agent.system = ""
        agent.mode = "primary"
      }),
    )
    yield* s.admit("First")

    yield* s.llm.push(TestLLM.text("Done", "text-empty-agent-system"))
    yield* s.resume

    expect(s.requests.at(-1)?.system.map((part) => part.text)).toEqual([
      expect.stringContaining("# Delegation"),
      "Initial context",
    ])
  })

  scenario("includes the effective default agent system before durable context", function* (s) {
    const agent = yield* Agent.Service
    yield* agent.transform((editor) =>
      editor.update(Agent.ID.make("build"), (agent) => {
        agent.system = "Build agent instructions"
        agent.mode = "primary"
      }),
    )
    yield* s.admit("First")

    yield* s.llm.push(TestLLM.text("Done", "text-build"))
    yield* s.resume

    expect(s.requests.at(-1)?.system.map((part) => part.text)).toEqual(["Build agent instructions", "Initial context"])
  })

  scenario("uses the configured default agent system for omitted-agent sessions", function* (s) {
    const agent = yield* Agent.Service
    yield* agent.transform((editor) => {
      editor.update(Agent.ID.make("build"), (agent) => {
        agent.system = "Build agent instructions"
        agent.mode = "primary"
      })
      editor.update(Agent.ID.make("reviewer"), (agent) => {
        agent.system = "Reviewer instructions"
        agent.mode = "primary"
      })
      editor.default(Agent.ID.make("reviewer"))
    })
    yield* s.admit("First")

    yield* s.llm.push(TestLLM.text("Done", "text-reviewer"))
    yield* s.resume

    expect(s.requests.at(-1)?.system.map((part) => part.text)).toEqual(["Reviewer instructions", "Initial context"])
    expect((yield* s.messages)[0]).toMatchObject({ type: "assistant", agent: "reviewer" })
  })

  scenario("uses an explicitly selected non-build agent system", function* (s) {
    const agent = yield* Agent.Service
    yield* agent.transform((editor) =>
      editor.update(Agent.ID.make("reviewer"), (agent) => {
        agent.system = "Reviewer instructions"
        agent.mode = "primary"
      }),
    )
    yield* s.db
      .update(SessionTable)
      .set({ agent: "reviewer" })
      .where(eq(SessionTable.id, sessionID))
      .run()
      .pipe(Effect.orDie)
    yield* s.admit("First")

    yield* s.llm.push(TestLLM.text("Done", "text-selected"))
    yield* s.resume

    expect(s.requests.at(-1)?.system.map((part) => part.text)).toEqual(["Reviewer instructions", "Initial context"])
    expect((yield* s.messages)[0]).toMatchObject({ type: "assistant", agent: "reviewer" })
  })

  scenario("fails before the model request when the selected agent is unavailable", function* (s) {
    yield* s.db
      .update(SessionTable)
      .set({ agent: "explore" })
      .where(eq(SessionTable.id, sessionID))
      .run()
      .pipe(Effect.orDie)
    yield* s.session.prompt({ sessionID, text: "Inspect files", resume: false })

    s.requests.length = 0
    yield* s.llm.push([])
    const failure = yield* s.resume.pipe(Effect.flip)

    expect(failure).toMatchObject({
      _tag: "Session.AgentNotFoundError",
      sessionID,
      agent: "explore",
    })
    expect(s.requests).toHaveLength(0)
  })

  scenario("updates selected-agent skill instructions after an agent switch", function* (s) {
    const agents = yield* Agent.Service
    yield* agents.transform((editor) =>
      editor.update(Agent.ID.make("reviewer"), (agent) => {
        agent.mode = "primary"
      }),
    )
    s.skillBaselines.set(Agent.ID.make("build"), "Build skills")
    yield* s.runPrompt("First")
    s.skillBaselines.set(Agent.ID.make("reviewer"), "Reviewer skills")
    yield* s.bus.publish(SessionEvent.AgentSelected, {
      sessionID,
      agent: Agent.ID.make("reviewer"),
    })
    yield* s.runPrompt("Second")

    expect(s.requests.map((request) => request.system.map((part) => part.text))).toEqual([
      [defaultSystem, "Initial context\n\nBuild skills"],
      [defaultSystem, "Initial context\n\nBuild skills"],
    ])
    expect(systemTexts(s.requests[1])).toContainEqual(expect.stringContaining("Reviewer skills"))
  })

  scenario("keeps the sampled agent when selection changes during observation", function* (s) {
    s.skillBaselines.set(Agent.ID.make("build"), "Build skills")
    s.skillBaselines.set(Agent.ID.make("reviewer"), "Reviewer skills")
    let switched = false
    s.systemLoadHook = Effect.suspend(() => {
      if (switched) return Effect.void
      switched = true
      return s.bus
        .publish(SessionEvent.AgentSelected, {
          sessionID,
          agent: Agent.ID.make("reviewer"),
        })
        .pipe(Effect.asVoid)
    })
    yield* s.runPrompt("First")

    expect(s.requests.map((request) => request.system.map((part) => part.text))).toEqual([
      [defaultSystem, "Initial context\n\nBuild skills"],
    ])
  })

  scenario("keeps the sampled model when selection changes during model resolution", function* (s) {
    let switched = false
    s.modelResolveHook = Effect.suspend(() => {
      if (switched) return Effect.void
      switched = true
      return s.bus
        .publish(SessionEvent.ModelSelected, {
          sessionID,
          model: { id: ID.make("replacement"), providerID: Provider.ID.make("fake") },
        })
        .pipe(Effect.asVoid)
    })
    yield* s.runPrompt("First")
    expect(s.requests.map((request) => request.model)).toEqual([model])
    expect(s.requests.map((request) => request.system.map((part) => part.text))).toEqual([
      [defaultSystem, "Initial context"],
    ])
  })

  scenario("admits removed context as a chronological System message", function* (s) {
    yield* s.runPrompt("First")
    s.systemRemoved = true
    yield* s.runPrompt("Second")

    expect(messageRoles(s.requests[1])).toEqual(["user", "system", "user"])
    expect(s.requests[1]?.messages.at(1)?.content).toEqual([
      Expected.text("System context source removed: test/context"),
    ])
    expect(yield* s.messages).toHaveLength(3)
  })

  scenario("renders API context entries through add, change, and removal", function* (s) {
    const contextEntries = yield* InstructionEntry.Service
    yield* contextEntries.put({ sessionID, key: "deploy-target", value: "production" })
    yield* s.runPrompt("First")

    // String values render verbatim inside the initial tagged block.
    expect(s.requests[0]?.system.map((part) => part.text)).toEqual([
      defaultSystem,
      ["Initial context", "", '<context key="deploy-target">', "production", "</context>"].join("\n"),
    ])

    // Non-string JSON pretty-prints; the change narrates as a System update.
    yield* contextEntries.put({ sessionID, key: "deploy-target", value: { region: "us-east-1" } })
    yield* s.runPrompt("Second")

    expect(messageRoles(s.requests[1])).toEqual(["user", "system", "user"])
    expect(s.requests[1]?.messages.at(1)?.content).toEqual([
      Expected.text(
        [
          'The context under "deploy-target" changed and supersedes the previous value:',
          '<context key="deploy-target">',
          "{",
          '  "region": "us-east-1"',
          "}",
          "</context>",
        ].join("\n"),
      ),
    ])
    expect(yield* contextEntries.list(sessionID)).toEqual([{ key: "deploy-target", value: { region: "us-east-1" } }])

    // Deleting the row announces removal through the stored removal text.
    yield* contextEntries.remove({ sessionID, key: "deploy-target" })
    yield* s.runPrompt("Third")

    expect(messageRoles(s.requests[2])).toEqual(["user", "system", "user", "system", "user"])
    expect(s.requests[2]?.messages.at(-2)?.content).toEqual([
      Expected.text('The context under "deploy-target" no longer applies. Disregard it.'),
    ])
    expect(yield* contextEntries.list(sessionID)).toEqual([])
  })

  scenario("retains JSON null API entries as values", function* (s) {
    const entries = yield* InstructionEntry.Service
    yield* entries.put({ sessionID, key: "nullable", value: "present" })
    yield* s.runPrompt("First")

    yield* entries.put({ sessionID, key: "nullable", value: null })
    yield* s.runPrompt("Second")

    expect(s.requests[1]?.messages.at(1)?.content).toEqual([
      Expected.text(
        [
          'The context under "nullable" changed and supersedes the previous value:',
          '<context key="nullable">',
          "null",
          "</context>",
        ].join("\n"),
      ),
    ])
    expect(yield* entries.list(sessionID)).toEqual([{ key: "nullable", value: null }])
  })

  scenario("accepts API instruction entries up to 256 KiB", function* () {
    const entries = yield* InstructionEntry.Service
    const value = "x".repeat(InstructionEntry.MaxValueBytes - 2)

    yield* entries.put({ sessionID, key: "large", value })

    expect(yield* entries.list(sessionID)).toEqual([{ key: "large", value }])
  })

  scenario("rejects API instruction entries larger than 256 KiB", function* () {
    const entries = yield* InstructionEntry.Service

    const exit = yield* entries
      .put({ sessionID, key: "oversized", value: "x".repeat(InstructionEntry.MaxValueBytes) })
      .pipe(Effect.exit)

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBeInstanceOf(InstructionEntry.ValueTooLargeError)
    expect(yield* entries.list(sessionID)).toEqual([])
  })

  scenario("keeps initial instructions and chronological updates after a model switch", function* (s) {
    yield* s.runPrompt("First")
    s.systemBaseline = "Changed context"
    yield* s.runPrompt("Second")
    yield* s.bus.publish(SessionEvent.ModelSelected, {
      sessionID,
      model: { id: ID.make("replacement"), providerID: Provider.ID.make("fake") },
    })
    s.systemBaseline = "Replacement context"
    yield* s.runPrompt("Third")

    expect(s.requests.map((request) => request.system.map((part) => part.text))).toEqual([
      [defaultSystem, "Initial context"],
      [defaultSystem, "Initial context"],
      [defaultSystem, "Initial context"],
    ])
    expect(messageRoles(s.requests[1])).toEqual(["user", "system", "user"])
    expect(s.requests[2]?.messages.filter((message) => message.role === "system")).toHaveLength(2)
    expect((yield* s.context).map((message) => message.type)).toEqual([
      "user",
      "system",
      "user",
      "model-switched",
      "system",
      "user",
    ])
    yield* replaySessionProjection(sessionID)
    expect(yield* s.messages).toHaveLength(6)
    yield* s.runPrompt("Fourth")
  })

  scenario("preserves instruction values while a source is temporarily unavailable", function* (s) {
    yield* s.runPrompt("First")
    yield* s.bus.publish(SessionEvent.ModelSelected, {
      sessionID,
      model: { id: ID.make("replacement"), providerID: Provider.ID.make("fake") },
    })
    s.systemUnavailable = true
    yield* s.runPrompt("Second")
    s.systemUnavailable = false
    s.systemBaseline = "Replacement context"
    yield* s.runPrompt("Third")

    expect(s.requests.map((request) => request.system.map((part) => part.text))).toEqual([
      [defaultSystem, "Initial context"],
      [defaultSystem, "Initial context"],
      [defaultSystem, "Initial context"],
    ])
  })

  scenario("moves the epoch at compaction and narrates later changes", function* (s) {
    yield* s.runPrompt("First")
    s.systemBaseline = "Changed before compaction"
    yield* s.llm.push(TestLLM.text("## Objective\n- summary", "epoch-summary"))
    yield* s.session.compact({ sessionID })
    yield* s.resume
    expect(systemTexts(s.requests[1])).toEqual(["Changed before compaction"])
    expect((yield* s.context).some((message) => message.type === "system")).toBe(false)
    s.systemBaseline = "Replacement context"
    yield* s.runPrompt("Second")

    expect(s.requests.map((request) => request.system.map((part) => part.text))).toEqual([
      [defaultSystem, "Initial context"],
      [defaultSystem, "Initial context"],
      [defaultSystem, "Initial context"],
    ])
    expect(messageRoles(s.requests[2])).toEqual(["user", "system", "user"])
    expect(s.requests[2]?.messages.at(1)?.content).toEqual([Expected.text("Replacement context")])
    yield* replaySessionProjection(sessionID)
    const latest = yield* s.runPrompt("Third")
    expect(systemTexts(s.requests[3])).toEqual(["Replacement context"])
    const fork = yield* s.session.fork({ sessionID, boundary: { type: "before", messageID: latest.id } })
    expect(
      (yield* s.session.context(fork.id)).flatMap((message) => (message.type === "system" ? [message.text] : [])),
    ).toEqual(["Replacement context"])
  })

  for (const order of ["before", "between", "after"] as const) {
    scenario(`prioritizes manual compaction admitted ${order} two steers at the safe boundary`, function* (s) {
      s.currentModel = recoveryModel
      yield* s.llm.push(
        TestLLM.text("Active complete", "active"),
        TestLLM.text("## Objective\n- Active work checkpoint", "summary"),
        TestLLM.text("Steers complete", "steers"),
      )
      yield* s.admit("Active work")
      const active = yield* s.resumePaused
      const compactID = SessionMessage.ID.create()
      if (order === "before") yield* s.session.compact({ sessionID, id: compactID })
      const first = yield* s.admit("STEER_A")
      if (order === "between") yield* s.session.compact({ sessionID, id: compactID })
      const second = yield* s.admit("STEER_B")
      if (order === "after") yield* s.session.compact({ sessionID, id: compactID })
      expect((yield* s.session.compact({ sessionID })).id).toBe(compactID)

      expect(s.requests).toHaveLength(1)
      expect(yield* s.inbox).toHaveLength(3)
      expect((yield* s.messages).some((message) => message.type === "compaction")).toBe(false)
      yield* active.finish

      expect(userTexts(s.requests[1]).at(-1)).toContain("Summarize only what the user and the assistant said and did")
      expect(s.requests).toHaveLength(3)
      expect(userTexts(s.requests[1])).not.toContain("STEER_A")
      expect(userTexts(s.requests[1])).not.toContain("STEER_B")
      expect(userTexts(s.requests[2]).slice(-2)).toEqual(["STEER_A", "STEER_B"])
      expect(yield* s.inbox).toEqual([])
      expect((yield* s.messages).filter((message) => message.id === compactID)).toMatchObject([
        { type: "compaction", status: "completed" },
      ])
      expect((yield* s.context).filter((message) => message.type === "user").map((message) => message.id)).toEqual([
        first.id,
        second.id,
      ])
      // An advisory drain must not redeliver either steer or rerun compaction.
      const runner = yield* SessionRunner.Service
      yield* runner.drain({ sessionID, force: false })
      expect(s.requests).toHaveLength(3)
    })
  }

  scenario("waits for active tools before prioritizing compaction over pending steers", function* (s) {
    yield* s.llm.push(
      TestLLM.tool("call-active", "echo", { text: "active" }),
      TestLLM.text("## Objective\n- Tool work checkpoint", "summary"),
      TestLLM.text("Steers complete", "steers"),
    )
    yield* s.admit("Active work")
    const tools = yield* s.blockTools()
    const run = yield* s.resume.pipe(Effect.forkChild)
    yield* tools.started
    yield* s.admit("STEER_A")
    yield* s.admit("STEER_B")
    const compact = yield* s.session.compact({ sessionID })
    expect(s.requests).toHaveLength(1)
    expect((yield* s.messages).some((message) => message.id === compact.id)).toBe(false)
    yield* tools.release
    yield* Fiber.join(run)

    expect(s.requests).toHaveLength(3)
    expect(userTexts(s.requests[1]).at(-1)).toContain("Summarize only what the user and the assistant said and did")
    expect(s.requests[1].messages.some((message) => message.role === "tool")).toBe(true)
    expect(userTexts(s.requests[2]).slice(-2)).toEqual(["STEER_A", "STEER_B"])
    expect(yield* s.inbox).toEqual([])
  })

  scenario("rechecks compaction admitted during boundary context preparation", function* (s) {
    yield* s.runPrompt("Earlier work")
    yield* s.admit("STEER_A")
    yield* s.admit("STEER_B")
    const preparing = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    s.systemLoadHook = Deferred.succeed(preparing, undefined).pipe(Effect.andThen(Deferred.await(release)))
    yield* s.llm.push(
      TestLLM.text("## Objective\n- Earlier work checkpoint", "summary"),
      TestLLM.text("Steers complete", "steers"),
    )
    const run = yield* s.resume.pipe(Effect.forkChild)
    yield* Deferred.await(preparing)
    yield* s.session.compact({ sessionID })
    yield* Deferred.succeed(release, undefined)
    yield* Fiber.join(run)
    expect(s.requests).toHaveLength(3)
    expect(userTexts(s.requests[1]).at(-1)).toContain("Summarize only what the user and the assistant said and did")
    expect(userTexts(s.requests[2]).slice(-2)).toEqual(["STEER_A", "STEER_B"])
    expect(yield* s.inbox).toEqual([])
  })

  for (const outcome of ["cancelled", "failed"] as const) {
    scenario(`preserves both earlier steers when prioritized compaction is ${outcome}`, function* (s) {
      yield* s.llm.push(TestLLM.text("Active complete", "active"))
      yield* s.admit("Active work")
      const active = yield* s.resumePaused
      const first = yield* s.admit("STEER_A")
      const second = yield* s.admit("STEER_B")
      const compact = yield* s.session.compact({ sessionID })
      if (outcome === "cancelled") yield* s.session.cancelInbox({ sessionID, inboxID: compact.id })
      if (outcome === "failed") yield* s.llm.push([LLMEvent.providerError({ message: "summary unavailable" })])
      yield* s.llm.push(TestLLM.text("Steers complete", "steers"))
      yield* active.finish

      expect(s.requests).toHaveLength(outcome === "cancelled" ? 2 : 3)
      if (outcome === "failed") {
        expect(userTexts(s.requests[1]).at(-1)).toContain("Summarize only what the user and the assistant said and did")
        expect((yield* s.messages).find((message) => message.id === compact.id)).toMatchObject({
          status: "failed",
          error: { type: "provider.error", message: "summary unavailable" },
        })
      }
      if (outcome === "cancelled") expect((yield* s.messages).some((message) => message.id === compact.id)).toBe(false)
      expect(userTexts(s.requests[s.requests.length - 1]).slice(-2)).toEqual(["STEER_A", "STEER_B"])
      expect(
        (yield* s.context)
          .filter((message) => message.id === first.id || message.id === second.id)
          .map((message) => message.id),
      ).toEqual([first.id, second.id])
      expect(yield* s.inbox).toEqual([])
    })
  }

  scenario("keeps steers durable across interrupted priority compaction and replay", function* (s) {
    yield* s.runPrompt("Earlier work")
    const first = yield* s.admit("STEER_A")
    const second = yield* s.admit("STEER_B")
    yield* s.llm.push(TestLLM.text("## Objective\n- Interrupted checkpoint", "summary"))
    const summary = yield* s.llm.gate
    const compact = yield* s.session.compact({ sessionID })
    yield* summary.started
    expect(userTexts(s.requests[1]).at(-1)).toContain("Summarize only what the user and the assistant said and did")
    expect((yield* s.inbox).map((item) => item.id)).toEqual([first.id, second.id])
    yield* s.session.interrupt(sessionID)
    yield* s.session.wait(sessionID)
    yield* summary.release
    expect((yield* s.messages).find((message) => message.id === compact.id)).toMatchObject({ status: "failed" })
    yield* replaySessionProjection(sessionID)
    expect((yield* s.inbox).map((item) => item.id)).toEqual([first.id, second.id])

    yield* s.llm.push(TestLLM.text("Recovered steers", "steers"))
    yield* s.resume
    expect(s.requests).toHaveLength(3)
    expect(userTexts(s.requests[2]).slice(-2)).toEqual(["STEER_A", "STEER_B"])
    expect(yield* s.inbox).toEqual([])
  })

  scenario("does not pull compaction across an earlier move", function* (s) {
    yield* s.admit("STEER_A")
    yield* s.sessionInbox.admit({
      id: SessionMessage.ID.create(),
      sessionID,
      item: {
        type: "move",
        payload: {
          location: Location.Ref.make({ directory: AbsolutePath.make("/project") }),
          projectID: Project.ID.global,
        },
        delivery: "steer",
      },
    })
    yield* s.admit("STEER_B")
    yield* s.sessionInbox.admitCompaction({ id: SessionMessage.ID.create(), sessionID, delivery: "steer" })
    yield* s.llm.push(
      TestLLM.text("First steer complete", "first"),
      TestLLM.text("## Objective\n- Source work checkpoint", "summary"),
      TestLLM.text("Second steer complete", "second"),
    )
    yield* s.resume
    expect(s.requests).toHaveLength(3)
    expect(userTexts(s.requests[0])).toEqual(["STEER_A"])
    expect(userTexts(s.requests[1]).at(-1)).toContain("Summarize only what the user and the assistant said and did")
    expect(userTexts(s.requests[2]).at(-1)).toBe("STEER_B")
    expect(
      (yield* recordedEventTypes(sessionID)).filter(
        (type) => type === "session.moved.1" || type === "session.compaction.started.1",
      ),
    ).toEqual(["session.moved.1", "session.compaction.started.1"])
  })

  scenario("runs steers before queued compaction and later queued input", function* (s) {
    s.currentModel = recoveryModel
    yield* s.llm.push(
      TestLLM.tool("call-active", "echo", { text: "active" }),
      TestLLM.text("Steer complete", "text-steer"),
      [LLMEvent.textDelta({ id: "summary", text: "## Objective\n- durable summary" })],
      TestLLM.text("Queue complete", "text-queue"),
    )
    yield* s.admit("Active work")
    const active = yield* s.resumePaused

    const first = yield* s.session.compact({ sessionID, delivery: "queue" })
    expect(yield* SessionInbox.find(s.db, first.id)).toMatchObject({
      id: first.id,
    })
    expect((yield* s.messages).find((message) => message.id === first.id)).toBeUndefined()

    yield* s.admit("Steer after compaction")
    yield* s.session.synthetic({ sessionID, text: "Completion after compaction", resume: false })
    yield* s.session.prompt({
      sessionID,
      text: "Queue after compaction",
      delivery: "queue",
      resume: false,
    })
    expect(yield* SessionInbox.has(s.db, sessionID, "steer")).toBe(true)

    yield* active.finish

    expect(s.requests).toHaveLength(4)
    expect(userTexts(s.requests[1])).toContain("Steer after compaction")
    expect(userTexts(s.requests[1])).toContain("Completion after compaction")
    expect(userTexts(s.requests[3])).toContain("Queue after compaction")
    expect(yield* SessionInbox.find(s.db, first.id)).toBeUndefined()
    expect((yield* s.messages).find((message) => message.id === first.id)).toMatchObject({
      type: "compaction",
      status: "completed",
      summary: "## Objective\n- durable summary",
    })
  })

  scenario("releases queued prompts when durable compaction fails", function* (s) {
    s.currentModel = recoveryModel
    yield* s.llm.push(
      TestLLM.text("Active complete", "text-active-failure"),
      [],
      [],
      TestLLM.text("Continued", "text-after-failure"),
    )
    yield* s.admit("Active work")
    const active = yield* s.resumePaused

    const compaction = yield* s.session.compact({ sessionID })
    yield* s.session.prompt({
      sessionID,
      text: "Continue after failure",
      delivery: "queue",
      resume: false,
    })
    yield* active.finish

    expect(s.requests).toHaveLength(4)
    expect(userTexts(s.requests[3])).toContain("Continue after failure")
    expect(yield* SessionInbox.find(s.db, compaction.id)).toBeUndefined()
    expect((yield* s.messages).find((message) => message.id === compaction.id)).toMatchObject({
      type: "compaction",
      status: "failed",
    })
    expect(
      (yield* recordedEventTypes(sessionID)).filter(
        (type) => type === Bus.versionedType(SessionEvent.Compaction.Failed.type, 1),
      ),
    ).toHaveLength(1)
  })

  scenario("explains when manual compaction has no history", function* (s) {
    const compaction = yield* s.session.compact({ sessionID })
    s.modelResolveHook = Effect.die("model resolution should not run")

    yield* s.resume

    expect(yield* SessionInbox.find(s.db, compaction.id)).toBeUndefined()
    expect((yield* s.messages).find((message) => message.id === compaction.id)).toMatchObject({
      type: "compaction",
      status: "failed",
      reason: "manual",
      error: { type: "compaction.unavailable", message: "Nothing to compact yet" },
    })
    expect(
      (yield* recordedEventTypes(sessionID)).filter(
        (type) => type === Bus.versionedType(SessionEvent.Compaction.Failed.type, 1),
      ),
    ).toHaveLength(1)
  })

  scenario("delivers steered manual compaction when the model has no context limit", function* (s) {
    s.currentModel = unknownContextModel
    yield* s.llm.push(TestLLM.text("Earlier answer", "text-manual-unknown-history"))
    yield* s.runPrompt("Earlier question")

    s.requests.length = 0
    yield* s.llm.push(TestLLM.text("## Objective\n- Manual summary", "text-manual-unknown-summary"))
    const compaction = yield* s.session.compact({ sessionID, delivery: "steer" })
    yield* s.resume

    expect(s.requests).toHaveLength(1)
    expect(userTexts(s.requests[0])[0]).toContain("Earlier question")
    expect((yield* s.messages).find((message) => message.id === compaction.id)).toMatchObject({
      type: "compaction",
      status: "completed",
      summary: "## Objective\n- Manual summary",
    })
  })

  scenario("runs manual compaction at the next step boundary before queued prompts", function* (s) {
    s.currentModel = recoveryModel
    yield* s.llm.push(
      TestLLM.text("Active complete", "text-active-steer-compact"),
      [LLMEvent.textDelta({ id: "summary", text: "## Objective\n- durable summary" })],
      TestLLM.text("Queue complete", "text-queue-after-compact"),
    )
    yield* s.admit("Active work")
    const active = yield* s.resumePaused

    const compaction = yield* s.session.compact({ sessionID })
    yield* s.session.prompt({ sessionID, text: "Queued prompt", delivery: "queue", resume: false })
    yield* active.finish

    // Steer-delivered compaction runs at the boundary after the active step, ahead of
    // the queued prompt, and consuming it does not trigger an input-free model call.
    expect(s.requests).toHaveLength(3)
    expect(userTexts(s.requests[2])).toContain("Queued prompt")
    expect(yield* SessionInbox.find(s.db, compaction.id)).toBeUndefined()
    expect((yield* s.messages).find((message) => message.id === compaction.id)).toMatchObject({
      type: "compaction",
      status: "completed",
      summary: "## Objective\n- durable summary",
    })
  })

  scenario("runs manual compaction before the continuation of an active tool turn", function* (s) {
    s.currentModel = recoveryModel
    yield* s.llm.push(
      TestLLM.tool("call-active", "echo", { text: "active" }),
      [LLMEvent.textDelta({ id: "summary", text: "## Objective\n- durable summary" })],
      TestLLM.text("Continued", "text-continued-after-compact"),
    )
    yield* s.admit("Active work")
    const active = yield* s.resumePaused

    const compaction = yield* s.session.compact({ sessionID })
    yield* active.finish

    // The compaction summary is requested before the tool turn's continuation step.
    expect(s.requests).toHaveLength(3)
    expect((yield* s.messages).find((message) => message.id === compaction.id)).toMatchObject({
      type: "compaction",
      status: "completed",
      summary: "## Objective\n- durable summary",
    })
  })

  scenario("preserves provider errors from manual compaction", function* (s) {
    yield* s.llm.push(TestLLM.text("Earlier answer", "text-manual-provider-history"))
    yield* s.runPrompt("Earlier question")

    yield* s.llm.push([LLMEvent.providerError({ message: "summary unavailable" })])
    const compaction = yield* s.session.compact({ sessionID })
    yield* s.resume

    expect((yield* s.messages).find((message) => message.id === compaction.id)).toMatchObject({
      type: "compaction",
      status: "failed",
      error: { type: "provider.error", message: "summary unavailable" },
    })
  })

  for (const route of [OpenAIChat.route, OpenAIResponses.route, AnthropicMessages.route]) {
    for (const reason of ["manual", "auto"] as const) {
      scenario(`preserves the session request prefix during ${reason} compaction (${route.id})`, function* (s) {
        const agents = yield* Agent.Service
        const hooks = yield* PluginHooks.Service
        const agentID = Agent.ID.make("reviewer")
        const variant = Model.VariantID.make("test-variant")
        s.currentModel = LanguageModel.make({
          id: route === AnthropicMessages.route ? "claude-sonnet-4-6" : "gpt-5",
          provider: route === AnthropicMessages.route ? "anthropic" : "openai",
          route,
        })
        yield* agents.transform((editor) =>
          editor.update(agentID, (agent) => {
            agent.system = "Review the project carefully."
          }),
        )
        yield* s.bus.publish(SessionEvent.AgentSelected, { sessionID, agent: agentID })
        yield* s.bus.publish(SessionEvent.ModelSelected, {
          sessionID,
          model: { id: ID.make(s.currentModel.id), providerID: Provider.ID.make(s.currentModel.provider), variant },
        })
        const requestAgents: Agent.ID[] = []
        const hook = (event: SessionHooks["context"]) =>
          Effect.sync(() => {
            expect(event.agent).toBe(agentID)
            expect(event.model.variant).toBe(variant)
            event.system.push(SystemPart.make("Hook-provided instructions"))
            event.tools.echo.description = "Hook-provided tool description"
            event.options.maxTokens = 4_000
          })
        yield* hooks.register("session", "context", hook)
        yield* hooks.register("session", "compaction", hook)
        yield* hooks.register("session", "model.request", (event) =>
          Effect.sync(() => {
            requestAgents.push(event.agent)
          }),
        )
        yield* s.llm.push(
          TestLLM.tool("call-prefix", "echo", { text: "x".repeat(4_000) }),
          TestLLM.textWithUsage("Earlier answer", "prefix-answer", 185_000),
          TestLLM.complete(
            {
              reason: { normalized: "stop" },
              providerMetadata: { [s.currentModel.provider]: { responseId: "summary" } },
            },
            LLMEvent.textDelta({ id: "prefix-summary", text: "## Objective\n- Checkpoint summary" }),
          ),
        )
        yield* s.runPrompt("Review these changes")
        if (reason === "manual") {
          yield* s.session.compact({ sessionID })
          yield* s.resume
        }
        if (reason === "auto") {
          yield* s.llm.push(TestLLM.text("Continued", "prefix-continued"))
          yield* s.runPrompt("Retained recent request")
        }

        const normal = s.requests[1]
        const compact = s.requests[2]
        expect(compact.messages.slice(0, normal.messages.length)).toEqual([...normal.messages])
        expect(compact.messages.at(-1)).toMatchObject({
          role: "user",
          content: [{ type: "text", text: SessionCompaction.buildPrompt(false) }],
        })
        expect(userTexts(compact)).not.toContain("Retained recent request")
        for (const field of [
          "model",
          "system",
          "tools",
          "generation",
          "providerOptions",
          "toolChoice",
          "cache",
          "promptCacheKey",
          "http",
        ] as const)
          expect(compact[field]).toEqual(normal[field])
        expect(compact.toolChoice).toBeUndefined()
        expect(compact.system.map((part) => part.text)).toContain("Review the project carefully.")
        expect(requestAgents[2]).toBe(agentID)
        expect(s.executions).toEqual(["x".repeat(4_000)])
        expect((yield* s.messages).find((message) => message.type === "compaction")).toMatchObject({
          model: { id: s.currentModel.id, providerID: s.currentModel.provider, variant },
          providerState: { responseId: "summary" },
        })

        // Compare wire content without the cache breakpoints that move to the new final message.
        const before = yield* compileRequest(LLMRequest.update(normal, { cache: "none" }))
        const after = yield* compileRequest(LLMRequest.update(compact, { cache: "none" }))
        const key = route === OpenAIResponses.route ? "input" : "messages"
        const input = Schema.decodeUnknownSync(Schema.Array(Schema.Unknown))
        const prefix = input(before.body[key])
        expect(input(after.body[key]).slice(0, prefix.length)).toEqual([...prefix])
        expect(after.body).toMatchObject(
          Object.fromEntries(Object.entries(before.body).filter(([name]) => name !== key)),
        )
      })
    }
  }

  for (const response of ["tools", "reasoning", "invalid text"] as const) {
    for (const summary of [true, false]) {
      scenario(
        `compaction ${summary ? "recovers" : "stops"} after one template reminder for ${response}`,
        function* (s) {
          yield* s.llm.push(TestLLM.text("Earlier answer", "summary-history"))
          yield* s.runPrompt("Earlier question")
          s.requests.length = 0
          const invalid =
            response === "tools"
              ? TestLLM.tool("call-summary", "echo", { text: "must not execute" })
              : response === "reasoning"
                ? TestLLM.stop(
                    LLMEvent.reasoningDelta({ id: "summary-reasoning", text: "## Objective\n- Not a summary" }),
                  )
                : TestLLM.text("Let me search the codebase. I will fill in ## Objective later.", "invalid-summary")
          yield* s.llm.push(
            invalid.map((event) =>
              LLMEvent.is.stepFinish(event)
                ? { ...event, providerMetadata: { openai: { responseId: "rejected-summary-state" } } }
                : event,
            ),
            summary
              ? [LLMEvent.textDelta({ id: "summary-recovered", text: "### Active\n- Recovered summary" })]
              : invalid,
          )
          const compact = yield* s.session.compact({ sessionID })
          yield* s.resume

          expect(s.requests).toHaveLength(2)
          expect(s.requests[1].messages.slice(0, -1)).toEqual([...s.requests[0].messages])
          expect(userTexts(s.requests[1]).at(-1)).toContain("did not fill in the required summary template")
          expect(s.requests.every((request) => request.toolChoice === undefined)).toBe(true)
          expect(s.executions).toEqual([])
          expect(JSON.stringify(yield* s.messages)).not.toContain("rejected-summary-state")
          expect((yield* s.messages).find((message) => message.id === compact.id)).toMatchObject(
            summary
              ? { status: "completed", summary: "### Active\n- Recovered summary" }
              : {
                  status: "failed",
                  error: {
                    type: "compaction.failed",
                    message:
                      response === "invalid text"
                        ? "Compaction summary did not match the required template"
                        : "Compaction produced no summary",
                  },
                },
          )
          if (!summary)
            expect(
              (yield* s.context).some((message) => message.type === "user" && message.text === "Earlier question"),
            ).toBe(true)
        },
      )
    }
  }

  scenario("restarts compaction drafts after transient failures and unsuccessful finishes", function* (s) {
    yield* s.llm.push(TestLLM.text("Earlier answer", "text-manual-failure-history"))
    yield* s.runPrompt("Earlier question")
    s.requests.length = 0
    const hooks = yield* PluginHooks.Service
    const retries: PluginHooks.Domains["session"]["retry"][] = []
    yield* hooks.register("session", "retry", (event) =>
      Effect.sync(() => {
        retries.push({ ...event })
        event.decision = { retry: true, delay: 0 }
      }),
    )
    const draft = TestLLM.complete(
      {
        reason: { normalized: "unknown" },
        usage: { nonCachedInputTokens: 10 },
        providerMetadata: { openai: { responseId: "discarded-draft" } },
      },
      LLMEvent.textDelta({ id: "draft", text: "## Objective\n- Partial draft" }),
    )
    yield* s.llm.push(
      TestLLM.failAfter(streamDisconnected(), ...draft.slice(0, -1)),
      draft,
      TestLLM.complete(
        { reason: { normalized: "error" } },
        LLMEvent.textDelta({ id: "failed", text: "## Objective\n- Failed draft" }),
      ),
      Stream.fail(rateLimited(60_000)),
      TestLLM.textWithUsage("## Objective\n- Accepted summary", "accepted", 30),
    )
    const compaction = yield* s.session.compact({ sessionID })
    yield* s.resume

    expect(s.requests).toHaveLength(5)
    for (const request of s.requests) expect(request).toEqual(s.requests[0])
    expect(retries.map((event) => event.attempt)).toEqual([2, 3, 4, 5])
    expect(retries.every((event) => event.sessionID === sessionID && event.agent === "build")).toBe(true)
    expect(retries[3].decision).toEqual({ retry: true, delay: 60_000 })
    expect((yield* s.messages).find((message) => message.id === compaction.id)).toMatchObject({
      status: "completed",
      summary: "## Objective\n- Accepted summary",
    })
    expect(JSON.stringify(yield* s.messages)).not.toContain("discarded-draft")
    expect((yield* s.session.get(sessionID))?.tokens.input).toBe(50)
  })

  scenario("bounds compaction network retries across a template correction", function* (s) {
    yield* s.llm.push(TestLLM.text("Earlier answer", "history"))
    yield* s.runPrompt("Earlier question")
    s.requests.length = 0
    const hooks = yield* PluginHooks.Service
    const attempts: number[] = []
    yield* hooks.register("session", "retry", (event) =>
      Effect.sync(() => {
        attempts.push(event.attempt)
        expect(event.decision).toMatchObject({ retry: true })
        event.decision = { retry: true, delay: 0 }
      }),
    )
    yield* s.llm.push(Stream.fail(providerUnavailable()), TestLLM.text("Not a summary", "invalid"))
    yield* s.llm.always(Stream.fail(providerUnavailable()))
    const compaction = yield* s.session.compact({ sessionID })
    yield* s.resume

    expect(attempts).toEqual([2, 3, 4, 5])
    expect(s.requests).toHaveLength(6)
    expect((yield* s.messages).find((message) => message.id === compaction.id)).toMatchObject({
      status: "failed",
      error: { type: "provider.transport", message: "Provider unavailable" },
    })
    expect((yield* s.context).some((message) => message.type === "user" && message.text === "Earlier question")).toBe(
      true,
    )
  })

  for (const header of [false, true]) {
    scenario(`stops compaction retries through the ${header ? "provider header" : "retry hook"}`, function* (s) {
      yield* s.llm.push(TestLLM.text("Earlier answer", "history"))
      yield* s.runPrompt("Earlier question")
      s.requests.length = 0
      const hooks = yield* PluginHooks.Service
      yield* hooks.register("session", "retry", (event) =>
        Effect.sync(() => {
          expect(event.decision.retry).toBe(!header)
          event.decision = { retry: false }
        }),
      )
      yield* s.llm.push(
        Stream.fail(
          header
            ? new AIError({
                reason: new TransportError({
                  message: "Connection closed",
                  transport: "http",
                  operation: "read",
                  http: new HttpContext({
                    url: "https://example.com",
                    status: 200,
                    headers: { "x-should-retry": "false" },
                  }),
                }),
              })
            : incompleteStream(),
        ),
      )
      const compaction = yield* s.session.compact({ sessionID })
      yield* s.resume

      expect(s.requests).toHaveLength(1)
      expect((yield* s.messages).find((message) => message.id === compaction.id)).toMatchObject({
        status: "failed",
        error: { type: header ? "provider.transport" : "provider.invalid-output" },
      })
    })
  }

  for (const response of ["length", "content-filter", "context overflow"] as const) {
    scenario(`rejects compaction ${response} without retrying or committing its draft`, function* (s) {
      yield* s.llm.push(TestLLM.text("Earlier answer", "history"))
      yield* s.runPrompt("Earlier question")
      s.requests.length = 0
      yield* s.llm.push(
        response === "context overflow"
          ? Stream.fail(
              new AIError({
                reason: new InvalidRequestError({ message: "Too long", classification: "context-overflow" }),
              }),
            )
          : TestLLM.complete(
              { reason: { normalized: response } },
              LLMEvent.textDelta({ id: "truncated", text: "## Objective\n- Incomplete summary" }),
            ),
      )
      const compaction = yield* s.session.compact({ sessionID })
      yield* s.resume

      expect(s.requests).toHaveLength(1)
      expect((yield* s.messages).find((message) => message.id === compaction.id)).toMatchObject({ status: "failed" })
      yield* s.llm.push(TestLLM.text("Continued", "continued"))
      yield* s.runPrompt("Continue")
      expect(userTexts(s.requests[1])).toContain("Earlier question")
      expect(JSON.stringify(s.requests[1])).not.toContain("Incomplete summary")
    })
  }

  scenario("records cancelled manual compaction without surfacing an internal failure", function* (s) {
    yield* s.llm.push(TestLLM.text("Earlier answer", "text-manual-interrupt-history"))
    yield* s.runPrompt("Earlier question")

    const streamed = yield* Deferred.make<void>()
    const partial = fragmentFixture("text", "text-manual-interrupt-summary", ["Partial summary"])
    yield* s.llm.push(
      Stream.concat(
        Stream.fromIterable(partial.partialEvents),
        Stream.fromEffect(Deferred.succeed(streamed, undefined)).pipe(Stream.flatMap(() => Stream.never)),
      ),
    )
    const compaction = yield* s.session.compact({ sessionID })
    const run = yield* s.resume.pipe(Effect.forkChild)
    yield* Deferred.await(streamed)
    yield* s.session.interrupt(sessionID)

    yield* Fiber.await(run)
    expect(yield* SessionInbox.find(s.db, compaction.id)).toBeUndefined()
    expect((yield* s.messages).find((message) => message.id === compaction.id)).toMatchObject({
      type: "compaction",
      status: "failed",
      reason: "manual",
      error: { type: "aborted", message: "Compaction cancelled" },
    })
  })

  scenario("settles an admitted manual compaction when pre-start resolution throws", function* (s) {
    yield* s.llm.push(TestLLM.text("Earlier answer", "text-manual-resolution-history"))
    yield* s.runPrompt("Earlier question")

    const compaction = yield* s.session.compact({ sessionID })
    s.modelResolveHook = Effect.die("model resolution failed")

    expect(yield* Effect.exit(s.resume)).toMatchObject({ _tag: "Failure" })

    expect(yield* SessionInbox.find(s.db, compaction.id)).toBeUndefined()
    expect((yield* s.messages).find((message) => message.id === compaction.id)).toMatchObject({
      type: "compaction",
      status: "failed",
      reason: "manual",
    })
    expect(
      (yield* recordedEventTypes(sessionID)).filter(
        (type) => type === Bus.versionedType(SessionEvent.Compaction.Failed.type, 1),
      ),
    ).toHaveLength(1)
  })

  scenario("automatically compacts into a completed summary and retained recent turn", function* (s) {
    const store = yield* SessionStore.Service
    yield* s.llm.push(TestLLM.textWithUsage("Earlier answer", "text-first", 3_950))
    yield* s.runPrompt("Earlier question ".repeat(180))

    s.currentModel = compactModel
    s.requests.length = 0
    yield* s.llm.push(
      TestLLM.text("## Objective\n- Preserve the task", "text-summary"),
      TestLLM.textWithUsage("Continued", "text-final", 3_950),
    )
    yield* s.runPrompt("Recent exact request ".repeat(180))

    expect(s.requests).toHaveLength(2)
    expect(userTexts(s.requests[0]).at(-1)).toContain("## Objective")
    expect(userTexts(s.requests[1])).toHaveLength(1)
    expect(userTexts(s.requests[1])[0]).toContain("<summary>\n## Objective\n- Preserve the task\n</summary>")
    expect(userTexts(s.requests[1])[0]).toContain(`[User]: ${"Recent exact request ".repeat(180)}`)

    const context = yield* store.context(sessionID)
    expect(context.map((message) => message.type)).toEqual(["compaction", "assistant"])
    expect(context[0]).toMatchObject({
      type: "compaction",
      summary: "## Objective\n- Preserve the task",
      recent: `[User]: ${"Recent exact request ".repeat(180)}`,
    })

    s.requests.length = 0
    s.executions.length = 0
    yield* s.llm.push(
      TestLLM.text("## Objective\n- Preserve the updated task", "text-summary-2"),
      TestLLM.text("Continued again", "text-final-2"),
    )
    yield* s.runPrompt("Newest exact request ".repeat(180))

    expect(s.requests).toHaveLength(2)
    expect(userTexts(s.requests[0])[0]).toContain("<summary>\n## Objective\n- Preserve the task\n</summary>")
    expect(userTexts(s.requests[0])[0]).toContain("Recent exact request")
    expect(userTexts(s.requests[0]).at(-1)).toBe(SessionCompaction.buildPrompt(true))
    expect((yield* store.context(sessionID))[0]).toMatchObject({
      type: "compaction",
      summary: "## Objective\n- Preserve the updated task",
      recent: `[User]: ${"Newest exact request ".repeat(180)}`,
    })
  })

  scenario("automatically persists native windows, retains earlier users, and waits for fresh usage", function* (s) {
    s.currentModel = LanguageModel.make({ id: "native", provider: "openai", route: OpenAIResponses.route })
    s.compaction = { mode: "provider", threshold: 10_000 }
    const agents = yield* Agent.Service
    yield* agents.transform((editor) =>
      editor.update(Agent.defaultID, (agent) => {
        agent.steps = 2
      }),
    )
    yield* s.llm.push(TestLLM.textWithUsage("Earlier answer", "before-native", 10_000))
    yield* s.runPrompt("First real request")
    const checkpoint = (encrypted: string) =>
      CompactionCheckpointResponse.make({
        responseID: `resp_${encrypted}`,
        checkpoint: { type: "compaction", provider: s.currentModel.provider, encrypted },
      })
    yield* s.llm.push(
      checkpoint("first"),
      TestLLM.tool("echo-native", "echo", { text: "continue" }),
      TestLLM.text("No usage yet", "no-usage"),
    )
    yield* s.runPrompt("Second real request")
    expect(s.requests).toHaveLength(4)
    expect(s.requests[2].toolChoice).not.toEqual({ type: "none" })
    expect(s.executions).toEqual(["continue"])
    expect(JSON.stringify(s.requests[2].messages)).toContain("first")
    const installed = (yield* s.messages).filter((message) => message.type === "compaction")
    expect(installed).toMatchObject([{ status: "completed", reason: "auto", providerContext: { version: 1 } }])
    // New input without a post-checkpoint usage anchor must not retrigger compaction.
    yield* s.llm.push(TestLLM.textWithUsage("Measured", "measured", 10_000))
    yield* s.runPrompt("Third real request")
    expect(s.requests).toHaveLength(5)
    yield* s.llm.push(checkpoint("second"), TestLLM.textWithUsage("Continued", "continued", 10_000))
    yield* s.runPrompt("Fourth real request")
    expect(s.requests).toHaveLength(7)
    expect(userTexts(s.requests[6])).toEqual([
      "First real request",
      "Second real request",
      "Third real request",
      "Fourth real request",
    ])
    expect(JSON.stringify(s.requests[6].messages)).not.toContain('"encrypted":"first"')
    const compaction = yield* SessionCompaction.Service
    yield* compaction.transform((editor) => editor.configure({ auto: false }))
    yield* replaySessionProjection(sessionID)
    yield* s.llm.push(TestLLM.text("Disabled auto still replays", "disabled"))
    yield* s.runPrompt("Fifth real request")
    expect(s.requests).toHaveLength(8)
    expect(JSON.stringify(s.requests[7].messages)).toContain('"encrypted":"second"')
  })

  scenario("recovers an overflowing native window locally from original durable history", function* (s) {
    s.currentModel = LanguageModel.make({ id: "native", provider: "openai", route: OpenAIResponses.route })
    s.compaction = { mode: "provider", threshold: 10_000 }
    yield* s.llm.push(TestLLM.textWithUsage("Earlier answer", "before-native", 10_000))
    yield* s.runPrompt("Original durable request")
    yield* s.llm.push(
      CompactionCheckpointResponse.make({
        responseID: "resp_native",
        checkpoint: { type: "compaction", provider: s.currentModel.provider, encrypted: "native-window" },
      }),
      TestLLM.text("After native", "after-native"),
    )
    yield* s.runPrompt("Before native checkpoint")
    s.requests.length = 0
    yield* s.llm.push(
      [LLMEvent.providerError({ message: "prompt too long", classification: "context-overflow" })],
      TestLLM.text("## Objective\n- Recovered original history", "local-recovery"),
      TestLLM.text("Recovered", "recovered"),
    )
    yield* s.runPrompt("Overflow request")
    expect(s.requests).toHaveLength(3)
    expect(JSON.stringify(s.requests[0].messages)).toContain("native-window")
    expect(JSON.stringify(s.requests[1].messages)).not.toContain("native-window")
    expect(userTexts(s.requests[1])).toContain("Original durable request")
    expect(userTexts(s.requests[1]).at(-1)).toBe(SessionCompaction.buildPrompt(false))
    expect(yield* s.context).toMatchObject([
      { type: "compaction", summary: "## Objective\n- Recovered original history" },
      { type: "assistant" },
    ])
  })

  scenario("does not compact immediately when the advertised output limit fills the context", function* (s) {
    s.currentModel = fullOutputModel
    yield* s.llm.push(TestLLM.textWithUsage("Earlier answer", "text-full-output-first", 9_500))
    yield* s.runPrompt("Earlier question")

    s.requests.length = 0
    yield* s.llm.push(TestLLM.text("Continued", "text-full-output-final"))
    yield* s.runPrompt("Continue")

    expect(s.requests).toHaveLength(1)
    expect(userTexts(s.requests[0])).toContain("Continue")
    expect(yield* s.context).not.toContainEqual(expect.objectContaining({ type: "compaction" }))
  })

  scenario("stops after required automatic compaction fails", function* (s) {
    yield* s.llm.push(TestLLM.textWithUsage("Earlier answer", "text-before-failed-compaction", 3_950))
    yield* s.runPrompt("Earlier question ".repeat(180))

    s.currentModel = compactModel
    s.requests.length = 0
    yield* s.llm.push(
      [LLMEvent.providerError({ message: "Unsupported parameter: max_output_tokens" })],
      TestLLM.text("Must not run", "text-after-failed-compaction"),
    )
    yield* s.admit("Recent exact request ".repeat(180))
    expect(yield* Effect.exit(s.resume)).toMatchObject({ _tag: "Failure" })

    expect(s.requests).toHaveLength(1)
    expect(s.requests[0]?.generation).toBeUndefined()
    expect(yield* s.context).toContainEqual(
      expect.objectContaining({
        type: "compaction",
        status: "failed",
        reason: "auto",
        error: expect.objectContaining({ message: "Unsupported parameter: max_output_tokens" }),
      }),
    )
  })

  scenario("forces one compaction and retries after provider context overflow", function* (s) {
    yield* setupOverflowRecovery(s)
    yield* s.llm.push(
      [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.providerError({ message: "prompt too long", classification: "context-overflow" }),
      ],
      TestLLM.text("## Objective\n- Recover overflow", "text-summary"),
      TestLLM.text("Recovered", "text-final"),
    )
    yield* s.runPrompt("Continue")

    expect(s.requests).toHaveLength(3)
    expect(userTexts(s.requests[1]).at(-1)).toContain("## Objective")
    expect(userTexts(s.requests[2])[0]).toContain("<summary>\n## Objective\n- Recover overflow\n</summary>")
    expect(yield* s.context).toMatchObject([
      { type: "compaction", summary: "## Objective\n- Recover overflow" },
      { type: "assistant", finish: "stop" },
    ])
    yield* replaySessionProjection(sessionID)
    expect(yield* s.context).toMatchObject([{ type: "compaction" }, { type: "assistant", finish: "stop" }])
  })

  scenario("refreshes preparation after overflow compaction without promoting new input", function* (s) {
    yield* setupOverflowRecovery(s)

    let reads = 0
    let resolutions = 0
    s.systemLoadHook = Effect.sync(() => {
      reads++
    })
    s.modelResolveHook = Effect.sync(() => {
      resolutions++
    })
    yield* s.admit("Continue")
    yield* s.llm.push(
      [LLMEvent.providerError({ message: "prompt too long", classification: "context-overflow" })],
      TestLLM.text("## Objective\n- Overflow summary", "overflow-summary"),
      TestLLM.text("Recovered", "overflow-recovered"),
      TestLLM.stop(),
      TestLLM.stop(),
    )
    const first = yield* s.llm.gate
    const run = yield* s.resume.pipe(Effect.forkChild)
    yield* first.started
    expect(reads).toBe(1)
    expect(resolutions).toBe(1)
    expect(s.requests[0]?.model).toBe(recoveryModel)

    const summary = yield* s.llm.gate
    yield* first.release
    yield* summary.started
    s.systemBaseline = "Changed during compaction"
    yield* s.bus.publish(SessionEvent.ModelSelected, {
      sessionID,
      model: { id: ID.make("replacement"), providerID: Provider.ID.make("fake") },
    })
    const queued = yield* s.session.prompt({
      sessionID,
      text: "Queued during compaction",
      delivery: "queue",
      resume: false,
    })
    const steered = yield* s.admit("Steered during compaction")
    const retry = yield* s.llm.gate
    yield* summary.release
    yield* retry.started

    expect(reads).toBe(2)
    expect(resolutions).toBe(2)
    expect(s.requests).toHaveLength(3)
    expect(s.requests[2]?.model).toBe(replacementModel)
    expect(s.requests[2]?.system.map((part) => part.text)).toEqual([defaultSystem, "Initial context"])
    expect(systemTexts(s.requests[2])).toContain("Changed during compaction")
    expect(userTexts(s.requests[2])[0]).toContain("<summary>\n## Objective\n- Overflow summary\n</summary>")
    expect(userTexts(s.requests[2]).join("\n")).not.toContain("Queued during compaction")
    expect(userTexts(s.requests[2]).join("\n")).not.toContain("Steered during compaction")
    expect((yield* s.inbox).map((item) => item.id)).toEqual([queued.id, steered.id])

    yield* retry.release
    yield* Fiber.join(run)

    expect(s.requests).toHaveLength(5)
    expect(userTexts(s.requests[3])).toContain("Steered during compaction")
    expect(userTexts(s.requests[3])).not.toContain("Queued during compaction")
    expect(userTexts(s.requests[4])).toContain("Queued during compaction")
    expect(yield* s.inbox).toEqual([])
  })

  scenario("does not recover provider context overflow when automatic compaction is disabled", function* (s) {
    yield* setupOverflowRecovery(s)
    const compaction = yield* SessionCompaction.Service
    yield* compaction.transform((editor) => editor.configure({ auto: false }))
    yield* s.llm.push(
      [LLMEvent.providerError({ message: "prompt too long", classification: "context-overflow" })],
      TestLLM.text("Must not compact", "text-unexpected-summary"),
      TestLLM.text("Must not retry", "text-unexpected-retry"),
    )
    yield* s.admit("Continue")
    expect((yield* s.resume.pipe(Effect.flip)).message).toBe("prompt too long")

    expect(s.requests).toHaveLength(1)
    expect(yield* s.context).toContainEqual(
      expect.objectContaining({
        type: "assistant",
        finish: "error",
        error: expect.objectContaining({ message: "prompt too long" }),
      }),
    )
    expect(yield* s.context).not.toContainEqual(expect.objectContaining({ type: "compaction" }))
    expect(yield* recordedEventTypes(sessionID)).not.toContain(
      Bus.versionedType(SessionEvent.Compaction.Started.type, 1),
    )
  })

  scenario("recovers from provider context overflow without a configured context limit", function* (s) {
    yield* setupOverflowRecovery(s)
    s.currentModel = unknownContextModel
    yield* s.llm.push(
      [LLMEvent.providerError({ message: "prompt too long", classification: "context-overflow" })],
      TestLLM.text("## Objective\n- Recover unknown limit", "text-summary-unknown-limit"),
      TestLLM.text("Recovered", "text-final-unknown-limit"),
    )
    yield* s.runPrompt("Continue")

    expect(s.requests).toHaveLength(3)
    expect(yield* s.context).toMatchObject([
      { type: "compaction", summary: "## Objective\n- Recover unknown limit" },
      { type: "assistant", finish: "stop" },
    ])
  })

  scenario("compacts before requesting an undersized configured context limit", function* (s) {
    yield* setupOverflowRecovery(s)
    s.currentModel = undersizedContextModel
    yield* s.llm.push(
      TestLLM.text("## Objective\n- Recover undersized limit", "text-summary-undersized-limit"),
      TestLLM.text("Recovered", "text-final-undersized-limit"),
    )
    yield* s.runPrompt("Continue")

    expect(s.requests).toHaveLength(2)
    expect(yield* s.context).toMatchObject([
      { type: "compaction", summary: "## Objective\n- Recover undersized limit" },
      { type: "assistant", finish: "stop" },
    ])
  })

  scenario("persists a second context overflow after one recovery", function* (s) {
    yield* setupOverflowRecovery(s)
    const overflow = () => [
      LLMEvent.stepStart({ index: 0 }),
      LLMEvent.providerError({ message: "prompt too long", classification: "context-overflow" }),
    ]
    yield* s.llm.push(overflow(), TestLLM.text("## Objective\n- Recover once", "text-summary"), overflow())
    yield* s.admit("Continue")
    expect((yield* s.resume.pipe(Effect.flip)).message).toBe("prompt too long")

    expect(s.requests).toHaveLength(3)
    expect(yield* s.context).toMatchObject([
      { type: "compaction" },
      { type: "assistant", finish: "error", error: { message: "prompt too long" } },
    ])
  })

  scenario("recovers once from a raw context overflow failure", function* (s) {
    yield* setupOverflowRecovery(s)
    yield* s.llm.push(
      Stream.fail(
        new AIError({
          reason: new InvalidRequestError({
            message: "prompt too long",
            classification: "context-overflow",
          }),
        }),
      ),
    )
    yield* s.llm.push(
      TestLLM.text("## Objective\n- Recover raw overflow", "text-summary"),
      TestLLM.text("Recovered", "text-final"),
    )
    yield* s.runPrompt("Continue")

    expect(s.requests).toHaveLength(3)
    expect(yield* s.context).toMatchObject([
      { type: "compaction", summary: "## Objective\n- Recover raw overflow" },
      { type: "assistant", finish: "stop" },
    ])
  })

  scenario("publishes the original overflow when recovery summarization fails", function* (s) {
    yield* setupOverflowRecovery(s)
    yield* s.llm.push(
      [LLMEvent.providerError({ message: "prompt too long", classification: "context-overflow" })],
      [LLMEvent.providerError({ message: "summary unavailable" })],
    )
    yield* s.admit("Continue")
    expect((yield* s.resume.pipe(Effect.flip)).message).toBe("prompt too long")

    expect(s.requests).toHaveLength(2)
    const context = yield* s.context
    expect(context).toContainEqual(
      expect.objectContaining({
        type: "compaction",
        status: "failed",
        reason: "auto",
        error: { type: "provider.error", message: "summary unavailable" },
      }),
    )
    expect(context.slice(-3)).toMatchObject([
      Expected.user("Continue"),
      { type: "compaction", status: "failed", reason: "auto" },
      { type: "assistant", finish: "error", error: { message: "prompt too long" } },
    ])
  })

  scenario("interrupts overflow recovery while the summary provider is running", function* (s) {
    yield* setupOverflowRecovery(s)
    yield* s.llm.push(
      [LLMEvent.providerError({ message: "prompt too long", classification: "context-overflow" })],
      TestLLM.text("## Objective\n- Interrupted", "text-summary"),
    )
    const first = yield* s.llm.gate
    yield* s.admit("Continue")
    const run = yield* s.resume.pipe(Effect.forkChild)
    yield* first.started

    const summary = yield* s.llm.gate
    yield* first.release
    yield* summary.started

    yield* s.session.interrupt(sessionID)
    const exit = yield* Fiber.await(run)
    expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBeTrue()
    expect(yield* s.context).toContainEqual(
      expect.objectContaining({
        type: "compaction",
        status: "failed",
        reason: "auto",
        error: { type: "compaction.interrupted", message: "Compaction was interrupted" },
      }),
    )
  })

  scenario("uses epoch values after compaction while a source is unavailable", function* (s) {
    yield* s.runPrompt("First")
    s.systemBaseline = "Changed context"
    yield* s.runPrompt("Second")
    yield* s.bus.publish(SessionEvent.Compaction.Started, {
      sessionID,
      reason: "manual",
      recent: "",
    })
    yield* s.bus.publish(SessionEvent.Compaction.Ended, {
      sessionID,
      reason: "manual",
      text: "summary",
      recent: "",
    })
    s.systemUnavailable = true
    yield* s.runPrompt("Third")

    // Compaction already moved current values into the new epoch before the unavailable read.
    expect(s.requests.at(-1)?.system.map((part) => part.text)).toEqual([defaultSystem, "Changed context"])
    expect(systemTexts(s.requests.at(-1)!)).not.toContain("Changed context")
  })

  scenario("projects reasoning and tool events without executing or continuing tools", function* (s) {
    yield* s.admit("Use tools")

    yield* s.llm.push(
      TestLLM.complete(
        {
          reason: { normalized: "tool-calls" },
          usage: {
            inputTokens: 10,
            nonCachedInputTokens: 8,
            outputTokens: 4,
            reasoningTokens: 1,
            cacheReadInputTokens: 2,
          },
        },
        LLMEvent.reasoningStart({ id: "reasoning-1" }),
        LLMEvent.reasoningDelta({ id: "reasoning-1", text: "Think" }),
        LLMEvent.reasoningEnd({ id: "reasoning-1" }),
        LLMEvent.toolInputStart({ id: "call-error", name: "write" }),
        LLMEvent.toolInputDelta({ id: "call-error", name: "write", text: '{"path":"README.md"}' }),
        LLMEvent.toolInputEnd({ id: "call-error", name: "write" }),
        LLMEvent.toolCall({ id: "call-error", name: "write", input: { path: "README.md" }, providerExecuted: true }),
        LLMEvent.toolError({ id: "call-error", name: "write", message: "Denied" }),
        LLMEvent.toolResult({ id: "call-error", name: "write", result: { type: "error", value: "Denied" } }),
        LLMEvent.toolCall({
          id: "call-provider",
          name: "web_search",
          input: { query: "hello" },
          providerExecuted: true,
          providerMetadata: { openai: { source: "provider" } },
        }),
        LLMEvent.toolResult({
          id: "call-provider",
          name: "web_search",
          result: {
            type: "content",
            value: [
              { type: "text", text: "Hello" },
              { type: "file", uri: "data:image/png;base64,aGVsbG8=", mime: "image/png", name: "hello.png" },
            ],
          },
          providerExecuted: true,
          providerMetadata: { openai: { source: "provider" } },
        }),
      ),
    )

    yield* s.resume

    expect(s.requests).toHaveLength(1)
    expect(s.requests[0]?.tools.map((tool) => tool.name)).toEqual(["defect", "echo", "storefail"])
    expect(yield* s.context).toMatchObject([
      Expected.user("Use tools"),
      {
        type: "assistant",
        finish: "tool-calls",
        cost: 0,
        tokens: { input: 8, output: 3, reasoning: 1, cache: { read: 2, write: 0 } },
        content: [
          Expected.reasoning("Think"),
          Expected.failedTool(
            { id: "call-error", name: "write" },
            { input: { path: "README.md" }, error: { type: "tool.execution", message: "Denied" } },
          ),
          Expected.completedTool(
            {
              id: "call-provider",
              name: "web_search",
              executed: true,
              providerState: { source: "provider" },
              providerResultState: { source: "provider" },
            },
            {
              input: { query: "hello" },
              content: [
                Expected.text("Hello"),
                { type: "file", mime: "image/png", uri: "data:image/png;base64,aGVsbG8=", name: "hello.png" },
              ],
            },
          ),
        ],
      },
    ])
  })

  scenario("continues with reloaded history after durably settling one local tool call", function* (s) {
    yield* s.admit("Echo this")

    yield* s.llm.push(TestLLM.tool("call-echo", "echo", { text: "hello" }), TestLLM.text("Done", "text-final"))

    yield* s.resume

    expect(s.requests).toHaveLength(2)
    expect(messageRoles(s.requests[1])).toEqual(["user", "assistant", "tool"])
    expect(s.authorizations).toMatchObject([{ sessionID, id: "call-echo" }])
    expect(s.executions).toEqual(["hello"])
    const context = yield* s.context
    expect(context).toMatchObject([
      Expected.user("Echo this"),
      Expected.assistant({ finish: "tool-calls" }, [
        Expected.completedTool(
          { id: "call-echo", name: "echo" },
          { input: { text: "hello" }, content: [Expected.text("hello")] },
        ),
      ]),
      Expected.assistant({ finish: "stop" }, [Expected.text("Done")]),
    ])
    const assistant = requireAssistant(context)
    expect(yield* recordedStepSettlementTypes(sessionID, assistant.id)).toEqual([
      "session.step.started.1",
      "session.tool.called.1",
      "session.tool.success.2",
      "session.step.ended.1",
    ])
  })

  scenario("reloads a model switch before a tool-driven continuation step", function* (s) {
    yield* s.admit("Echo this")

    yield* s.llm.push(TestLLM.tool("call-echo", "echo", { text: "hello" }), TestLLM.stop())
    const tools = yield* s.blockTools()
    const run = yield* Effect.forkChild(s.resume)
    yield* tools.started
    yield* s.bus.publish(SessionEvent.ModelSelected, {
      sessionID,
      model: { id: ID.make("replacement"), providerID: Provider.ID.make("fake") },
    })
    s.systemBaseline = "Replacement context"
    yield* tools.release
    yield* Fiber.join(run)

    expect(s.requests.map((request) => request.model)).toEqual([model, replacementModel])
    expect(s.requests.map((request) => request.system.map((part) => part.text))).toEqual([
      [defaultSystem, "Initial context"],
      [defaultSystem, "Initial context"],
    ])
    expect(systemTexts(s.requests[1])).toContain("Replacement context")
  })

  scenario("consumes the full provider stream before recording its boundary and settling local tools", function* (s) {
    yield* s.admit("Echo this")
    const tail = yield* Deferred.make<void>()
    const complete = yield* Deferred.make<void>()
    const finished = yield* Deferred.make<void>()
    yield* s.llm.push(
      Stream.fromIterable(TestLLM.tool("call-streamed", "echo", { text: "hello" })).pipe(
        Stream.concat(
          Stream.fromEffect(Deferred.succeed(tail, undefined).pipe(Effect.andThen(Deferred.await(complete)))).pipe(
            Stream.drain,
          ),
        ),
        Stream.onEnd(Deferred.succeed(finished, undefined)),
      ),
      TestLLM.stop(),
    )
    const tools = yield* s.blockTools()
    const streamed = yield* s.bus.subscribe(SessionEvent.Step.Streamed).pipe(
      Stream.filter((event) => event.data.sessionID === sessionID),
      Stream.runHead,
      Effect.forkScoped({ startImmediately: true }),
    )
    const run = yield* Effect.forkChild(s.resume)

    yield* tools.started
    yield* Deferred.await(tail)
    expect(s.requests).toHaveLength(1)
    expect(yield* recordedEventTypes(sessionID)).not.toContain("session.step.streamed.1")
    expect(requireAssistant(yield* s.context).time.completed).toBeUndefined()
    yield* Deferred.succeed(complete, undefined)
    yield* Fiber.join(streamed)
    expect(yield* Deferred.isDone(finished)).toBe(true)
    const assistant = requireAssistant(yield* s.context)
    expect(assistant.time.streamed).toBeDefined()
    expect(assistant.time.completed).toBeUndefined()
    expect(assistant.content).toMatchObject([{ type: "tool", state: { status: "running" } }])

    yield* tools.release
    yield* Fiber.join(run)
    const events = yield* recordedEventTypes(sessionID)
    expect(events.indexOf("session.step.streamed.1")).toBeLessThan(events.indexOf("session.tool.success.2"))
    expect(events.indexOf("session.tool.success.2")).toBeLessThan(events.indexOf("session.step.ended.1"))
    expect(events.filter((type) => type === "session.step.streamed.1")).toHaveLength(2)
  })

  scenario("restores durable reasoning provider metadata in the next request", function* (s) {
    yield* s.admit("Think first")

    yield* s.llm.push(
      TestLLM.stop(
        LLMEvent.reasoningStart({ id: "reasoning-anthropic" }),
        LLMEvent.reasoningDelta({ id: "reasoning-anthropic", text: "Signed thought" }),
        LLMEvent.reasoningEnd({
          id: "reasoning-anthropic",
          providerMetadata: { openai: { signature: "sig_1" }, anthropic: { ignored: true } },
        }),
        LLMEvent.reasoningStart({
          id: "reasoning-openai",
          providerMetadata: {
            openai: { itemId: "rs_1", reasoningEncryptedContent: null },
            anthropic: { ignored: true },
          },
        }),
        LLMEvent.reasoningDelta({ id: "reasoning-openai", text: "Encrypted thought" }),
        LLMEvent.reasoningEnd({
          id: "reasoning-openai",
          providerMetadata: {
            openai: { itemId: "rs_1", reasoningEncryptedContent: "encrypted-state" },
            anthropic: { ignored: true },
          },
        }),
      ),
    )
    yield* s.resume
    yield* replaySessionProjection(sessionID)

    expect(yield* s.context).toMatchObject([
      Expected.user("Think first"),
      Expected.assistant({}, [
        {
          type: "reasoning",
          text: "Signed thought",
          state: { signature: "sig_1" },
        },
        {
          type: "reasoning",
          text: "Encrypted thought",
          state: { itemId: "rs_1", reasoningEncryptedContent: "encrypted-state" },
        },
      ]),
    ])

    yield* s.admit("Continue")
    yield* s.llm.push([])
    yield* s.resume

    expect(s.requests[1]?.messages[1]?.content).toEqual([
      {
        type: "reasoning",
        text: "Signed thought",
        providerMetadata: { openai: { signature: "sig_1" } },
      },
      {
        type: "reasoning",
        text: "Encrypted thought",
        providerMetadata: { openai: { itemId: "rs_1", reasoningEncryptedContent: "encrypted-state" } },
      },
    ])
  })

  scenario("keeps one durable reasoning part when reasoning closes after text", function* (s) {
    yield* s.admit("Think and answer")

    const details = [{ type: "reasoning.text", text: "thinking", signature: "signed", index: 0 }]
    yield* s.llm.push(
      TestLLM.stop(
        LLMEvent.reasoningStart({ id: "reasoning-0" }),
        LLMEvent.reasoningDelta({ id: "reasoning-0", text: "thinking" }),
        LLMEvent.textStart({ id: "text-0" }),
        LLMEvent.textDelta({ id: "text-0", text: "Hello" }),
        LLMEvent.textDelta({ id: "text-0", text: " world" }),
        LLMEvent.reasoningEnd({
          id: "reasoning-0",
          providerMetadata: { openai: { reasoningField: "reasoning", reasoningDetails: details } },
        }),
        LLMEvent.textEnd({ id: "text-0" }),
      ),
    )
    yield* s.resume
    yield* replaySessionProjection(sessionID)

    const assistant = requireAssistant(yield* s.context)
    expect(assistant.content.filter((part) => part.type === "reasoning")).toHaveLength(1)
    expect(yield* s.context).toMatchObject([
      Expected.user("Think and answer"),
      Expected.assistant({}, [
        {
          type: "reasoning",
          text: "thinking",
          state: { reasoningField: "reasoning", reasoningDetails: details },
        },
        { type: "text", text: "Hello world" },
      ]),
    ])

    yield* s.admit("Continue")
    yield* s.llm.push([])
    yield* s.resume

    expect(s.requests[1]?.messages[1]?.content.filter((part) => part.type === "reasoning")).toEqual([
      {
        type: "reasoning",
        text: "thinking",
        providerMetadata: { openai: { reasoningField: "reasoning", reasoningDetails: details } },
      },
    ])
  })

  scenario("restores durable text provider metadata in the next request", function* (s) {
    yield* s.admit("Check first")

    yield* s.llm.push(
      TestLLM.stop(
        LLMEvent.textStart({
          id: "commentary",
          providerMetadata: { openai: { itemId: "msg_commentary", phase: "commentary" } },
        }),
        LLMEvent.textDelta({ id: "commentary", text: "Checking." }),
        LLMEvent.textEnd({
          id: "commentary",
          providerMetadata: {
            openai: { itemId: "msg_commentary", phase: "commentary" },
            anthropic: { ignored: true },
          },
        }),
      ),
    )
    yield* s.resume
    yield* replaySessionProjection(sessionID)

    expect(yield* s.context).toMatchObject([
      Expected.user("Check first"),
      Expected.assistant({}, [
        { type: "text", text: "Checking.", state: { itemId: "msg_commentary", phase: "commentary" } },
      ]),
    ])

    yield* s.admit("Continue")
    yield* s.llm.push([])
    yield* s.resume

    expect(s.requests[1]?.messages[1]?.content).toEqual([
      {
        type: "text",
        text: "Checking.",
        providerMetadata: { openai: { itemId: "msg_commentary", phase: "commentary" } },
      },
    ])
  })

  scenario("replays durable provider-executed tool results inline in the next request", function* (s) {
    yield* s.admit("Search first")

    yield* s.llm.push(
      TestLLM.stop(
        LLMEvent.toolCall({
          id: "hosted-search",
          name: "web_search",
          input: { query: "Effect" },
          providerExecuted: true,
          providerMetadata: { openai: { itemId: "hosted-search" }, fake: { ignored: true } },
        }),
        LLMEvent.toolResult({
          id: "hosted-search",
          name: "web_search",
          result: { type: "json", value: [{ title: "Effect" }] },
          providerExecuted: true,
          providerMetadata: { openai: { blockType: "web_search_tool_result" }, anthropic: { ignored: true } },
        }),
      ),
    )
    yield* s.resume
    yield* replaySessionProjection(sessionID)

    yield* s.admit("Continue")
    yield* s.llm.push([])
    yield* s.resume

    expect(messageRoles(s.requests[1])).toEqual(["user", "assistant", "user"])
    expect(s.requests[1]?.messages[1]?.content).toMatchObject([
      {
        type: "tool-call",
        id: "hosted-search",
        name: "web_search",
        input: { query: "Effect" },
        providerExecuted: true,
        providerMetadata: { openai: { itemId: "hosted-search" } },
      },
      {
        type: "tool-result",
        id: "hosted-search",
        name: "web_search",
        // The generic replay result derives from canonical stored content.
        result: { type: "text", value: '[{"title":"Effect"}]' },
        providerExecuted: true,
        providerMetadata: { openai: { blockType: "web_search_tool_result" } },
      },
    ])
  })

  scenario("starts recorded local tools eagerly and awaits settlement before continuing", function* (s) {
    yield* s.admit("Echo five times")

    const tools = yield* s.blockTools(5)
    const providerGate = yield* Deferred.make<void>()
    const initial = Stream.fromIterable([
      LLMEvent.stepStart({ index: 0 }),
      ...Array.from({ length: 5 }, (_, index) =>
        LLMEvent.toolCall({ id: `call-echo-${index}`, name: "echo", input: { text: `${index}` } }),
      ),
    ])
    const final = Stream.fromIterable([
      LLMEvent.stepFinish({ index: 0, reason: { normalized: "tool-calls" } }),
      LLMEvent.finish({ reason: { normalized: "tool-calls" } }),
    ])
    yield* s.llm.push(
      Stream.concat(initial, Stream.fromEffect(Deferred.await(providerGate)).pipe(Stream.flatMap(() => final))),
    )

    const run = yield* s.resume.pipe(Effect.forkChild)
    yield* tools.started

    expect(s.executions).toHaveLength(5)
    expect(yield* tools.maxActive).toBe(5)
    expect(yield* s.context).toMatchObject([
      Expected.user("Echo five times"),
      {
        type: "assistant",
        content: Array.from({ length: 5 }, (_, index) => ({
          type: "tool",
          id: `call-echo-${index}`,
          state: { status: "running", input: { text: `${index}` } },
        })),
      },
    ])

    yield* Deferred.succeed(providerGate, undefined)
    yield* Effect.yieldNow
    expect(s.requests).toHaveLength(1)

    yield* tools.release
    yield* Fiber.join(run)

    expect(s.executions).toHaveLength(5)
    expect(yield* tools.maxActive).toBe(5)
    expect(s.requests).toHaveLength(2)
  })

  scenario("settles repeated provider-local tool call IDs against their owning assistant messages", function* (s) {
    yield* s.admit("Echo twice")

    yield* s.llm.push(
      TestLLM.tool("tool_0", "echo", { text: "first" }),
      TestLLM.tool("tool_0", "echo", { text: "second" }),
      [],
    )

    yield* s.resume

    const expected = [
      Expected.user("Echo twice"),
      Expected.assistant({}, [Expected.completedTool({ id: "tool_0" }, { content: [Expected.text("first")] })]),
      Expected.assistant({}, [Expected.completedTool({ id: "tool_0" }, { content: [Expected.text("second")] })]),
    ]
    expect(s.executions).toEqual(["first", "second"])
    expect(s.requests).toHaveLength(3)
    expect(yield* s.context).toMatchObject(expected)

    yield* replaySessionProjection(sessionID)

    expect(yield* s.context).toMatchObject(expected)
  })

  scenario("joins concurrent resume calls into one active provider run", function* (s) {
    yield* s.admit("Run once")

    yield* s.llm.push(TestLLM.text("Once", "text-once"))
    const stream = yield* s.llm.gate

    const first = yield* s.resume.pipe(Effect.forkChild)
    yield* stream.started
    const second = yield* s.resume.pipe(Effect.forkChild)
    yield* Effect.yieldNow

    expect(s.requests).toHaveLength(1)
    yield* stream.release
    yield* Fiber.join(first)
    yield* Fiber.join(second)

    expect(s.requests).toHaveLength(1)
    expect(yield* s.context).toMatchObject([
      Expected.user("Run once"),
      Expected.assistant({ finish: "stop" }, [Expected.text("Once")]),
    ])
  })

  scenario("steers an active step with newly recorded prompts", function* (s) {
    yield* s.admit("Start working")

    yield* s.llm.push(TestLLM.stop(), TestLLM.stop())

    const first = yield* s.resumePaused
    yield* s.session.prompt({ sessionID, text: "Change direction" })
    yield* first.finish
    yield* Effect.yieldNow

    expect(s.requests).toHaveLength(2)
    expect(userTexts(s.requests[0])).toEqual(["Start working"])
    expect(userTexts(s.requests[1])).toEqual(["Start working", "Change direction"])
    expect((yield* s.context).map((message) => message.type)).toEqual(["user", "assistant", "user", "assistant"])
  })

  scenario("promotes queued input after continuation ends", function* (s) {
    yield* s.admit("Start working")

    yield* s.llm.push(TestLLM.tool("call-echo", "echo", { text: "hello" }), TestLLM.stop(), TestLLM.stop())

    const first = yield* s.resumePaused
    yield* s.session.prompt({
      sessionID,
      text: "Wait until continuation ends",
      delivery: "queue",
    })
    yield* first.finish

    expect(s.requests).toHaveLength(3)
    expect(userTexts(s.requests[0])).toEqual(["Start working"])
    expect(userTexts(s.requests[1])).toEqual(["Start working"])
    expect(userTexts(s.requests[2])).toEqual(["Start working", "Wait until continuation ends"])
  })

  scenario("keeps queued input parked when a steer is cancelled during preparation", function* (s) {
    const runner = yield* SessionRunner.Service
    yield* s.admit("A")
    yield* s.llm.push(TestLLM.stop(), TestLLM.stop(), TestLLM.stop())
    const stream = yield* s.llm.gate
    const run = yield* runner.drain({ sessionID, force: false }).pipe(Effect.forkChild)
    yield* stream.started

    yield* s.session.prompt({ sessionID, text: "B", delivery: "queue", resume: false })
    const steer = yield* s.admit("S")
    s.systemLoadHook = Effect.gen(function* () {
      s.systemLoadHook = Effect.void
      yield* s.session.cancelInbox({ sessionID, inboxID: steer.id }).pipe(Effect.orDie)
    })
    yield* stream.release
    yield* Fiber.join(run)

    expect(s.requests.map(userTexts)).toEqual([["A"], ["A"], ["A", "B"]])
    expect((yield* s.messages).some((message) => message.id === steer.id)).toBe(false)
    expect(yield* s.inbox).toEqual([])
  })

  scenario("dispatches a queued move when a steer is cancelled during preparation", function* (s) {
    const runner = yield* SessionRunner.Service

    const location = Location.Ref.make({ directory: AbsolutePath.make("/moved") })
    yield* s.admit("A")
    yield* s.llm.push(TestLLM.stop(), TestLLM.stop())
    const stream = yield* s.llm.gate
    const run = yield* runner.drain({ sessionID, force: false }).pipe(Effect.forkChild)
    yield* stream.started

    yield* s.sessionInbox.admit({
      id: SessionMessage.ID.create(),
      sessionID,
      item: {
        type: "move",
        payload: { location, projectID: Project.ID.global },
        delivery: "queue",
      },
    })
    const steer = yield* s.admit("S")
    s.systemLoadHook = Effect.gen(function* () {
      s.systemLoadHook = Effect.void
      yield* s.session.cancelInbox({ sessionID, inboxID: steer.id }).pipe(Effect.orDie)
    })
    yield* stream.release

    expect({ result: yield* Fiber.join(run), location: (yield* s.session.get(sessionID)).location }).toEqual({
      result: SessionRunner.DrainResult.Moved({}),
      location,
    })
    expect(s.requests.map(userTexts)).toEqual([["A"], ["A"]])
    expect(s.closedTransports).toEqual([sessionID])
    expect(yield* recordedEventTypes(sessionID)).toContain(Bus.versionedType(SessionEvent.Moved.type, 1))
    expect(yield* s.inbox).toEqual([])
  })

  scenario("preserves durable queued input for a later wake after interruption", function* (s) {
    yield* s.admit("Interrupt current work")

    yield* s.llm.push([], TestLLM.stop())
    const stream = yield* s.llm.gate

    const run = yield* s.resume.pipe(Effect.forkChild)
    yield* stream.started
    yield* s.session.prompt({
      sessionID,
      text: "Run after interrupt",
      delivery: "queue",
    })
    yield* s.session.interrupt(sessionID)
    expect(yield* Fiber.await(run)).toMatchObject({ _tag: "Failure" })
    expect(s.requests).toHaveLength(1)
    expect(yield* SessionInbox.has(s.db, sessionID, "queue")).toBe(true)
    const resumed = yield* s.resume.pipe(Effect.forkChild)
    yield* stream.started
    yield* stream.release
    yield* Fiber.join(resumed)

    expect(s.requests).toHaveLength(2)
    expect(userTexts(s.requests[0])).toEqual(["Interrupt current work"])
    expect(userTexts(s.requests[1])).toEqual(["Interrupt current work", "Run after interrupt"])
  })

  scenario("preserves durable steering input for a later resume after interruption", function* (s) {
    yield* s.admit("Interrupt current work")

    yield* s.llm.push([], TestLLM.stop())
    const stream = yield* s.llm.gate

    const run = yield* s.resume.pipe(Effect.forkChild)
    yield* stream.started
    yield* s.session.prompt({
      sessionID,
      text: "Steer after interrupt",
    })
    yield* s.session.interrupt(sessionID)
    expect(yield* Fiber.await(run)).toMatchObject({ _tag: "Failure" })
    expect(s.requests).toHaveLength(1)
    expect(yield* SessionInbox.has(s.db, sessionID, "steer")).toBe(true)

    const resumed = yield* s.resume.pipe(Effect.forkChild)
    yield* stream.started
    yield* stream.release
    yield* Fiber.join(resumed)

    expect(s.requests).toHaveLength(2)
    expect(userTexts(s.requests[0])).toEqual(["Interrupt current work"])
    expect(userTexts(s.requests[1])).toEqual(["Interrupt current work", "Steer after interrupt"])
  })

  scenario("promotes queued inputs one at a time in FIFO order", function* (s) {
    yield* s.admit("Start working")

    yield* s.llm.push(TestLLM.stop(), TestLLM.stop(), TestLLM.stop())

    const first = yield* s.resumePaused
    yield* s.session.prompt({ sessionID, text: "Queue first", delivery: "queue" })
    yield* s.session.prompt({ sessionID, text: "Queue second", delivery: "queue" })
    yield* first.finish

    expect(s.requests).toHaveLength(3)
    expect(userTexts(s.requests[0])).toEqual(["Start working"])
    expect(userTexts(s.requests[1])).toEqual(["Start working", "Queue first"])
    expect(userTexts(s.requests[2])).toEqual(["Start working", "Queue first", "Queue second"])
  })

  scenario("stops a steer-scoped drain before queued input", function* (s) {
    yield* s.session.prompt({ sessionID, text: "Queue for later", delivery: "queue", resume: false })
    yield* s.session.prompt({ sessionID, text: "Steer now", resume: false })
    yield* s.llm.push(TestLLM.stop())

    const runner = yield* SessionRunner.Service
    yield* runner.drain({ sessionID, force: false, promotable: "steer" })

    expect(s.requests).toHaveLength(1)
    expect(userTexts(s.requests[0])).toEqual(["Steer now"])
    expect(yield* SessionInbox.has(s.db, sessionID, "steer")).toBe(false)
    expect(yield* SessionInbox.has(s.db, sessionID, "queue")).toBe(true)
  })

  scenario("a steer-scoped drain runs a queued manual compaction next in line", function* (s) {
    // Admit without waking so the steer-scoped drain below is the first consumer.
    const compaction = yield* s.sessionInbox.admitCompaction({
      id: SessionMessage.ID.create(),
      sessionID,
      delivery: "queue",
    })

    const runner = yield* SessionRunner.Service
    yield* runner.drain({ sessionID, force: false, promotable: "steer" })

    // Control work is scope-independent between turns: the barrier is consumed
    // even though the drain never promotes queued input.
    expect(yield* SessionInbox.find(s.db, compaction.id)).toBeUndefined()
    expect((yield* s.messages).find((message) => message.id === compaction.id)).toMatchObject({
      type: "compaction",
      status: "failed",
      error: { type: "compaction.unavailable", message: "Nothing to compact yet" },
    })
  })

  scenario("a steer-scoped drain leaves a compaction parked behind a queued prompt", function* (s) {
    yield* s.session.prompt({ sessionID, text: "Queue for later", delivery: "queue", resume: false })
    const compaction = yield* s.sessionInbox.admitCompaction({
      id: SessionMessage.ID.create(),
      sessionID,
      delivery: "queue",
    })

    const runner = yield* SessionRunner.Service
    yield* runner.drain({ sessionID, force: false, promotable: "steer" })

    // Enqueue order holds: the queued prompt is next in line, so nothing runs.
    expect(s.requests).toHaveLength(0)
    expect(yield* SessionInbox.has(s.db, sessionID, "queue")).toBe(true)
    expect(yield* SessionInbox.find(s.db, compaction.id)).toMatchObject({ id: compaction.id })
  })

  scenario("promotes queued input after steering continuation ends", function* (s) {
    yield* s.admit("Start steering")
    yield* s.session.prompt({
      sessionID,
      text: "Queue for later",
      delivery: "queue",
      resume: false,
    })

    yield* s.llm.push(TestLLM.stop(), TestLLM.stop())

    yield* s.resume

    expect(s.requests).toHaveLength(2)
    expect(userTexts(s.requests[0])).toEqual(["Start steering"])
    expect(userTexts(s.requests[1])).toEqual(["Start steering", "Queue for later"])
  })

  scenario("promotes steers before the next queued input", function* (s) {
    yield* s.admit("Start working")

    yield* s.llm.push(TestLLM.stop(), TestLLM.stop(), TestLLM.stop(), TestLLM.stop())
    const firstStream = yield* s.llm.gate

    const first = yield* s.resume.pipe(Effect.forkChild)
    yield* firstStream.started
    yield* s.session.prompt({ sessionID, text: "Queue first", delivery: "queue" })
    yield* s.session.prompt({ sessionID, text: "Queue second", delivery: "queue" })
    const secondStream = yield* s.llm.gate
    yield* firstStream.release
    yield* secondStream.started
    yield* s.session.prompt({ sessionID, text: "Steer before next queued input" })
    yield* s.session.prompt({
      sessionID,
      text: "Also steer before next queued input",
    })
    yield* s.session.synthetic({ sessionID, text: "Background completion before next queued input" })
    yield* secondStream.release
    yield* Fiber.join(first)

    expect(s.requests).toHaveLength(4)
    expect(userTexts(s.requests[0])).toEqual(["Start working"])
    expect(userTexts(s.requests[1])).toEqual(["Start working", "Queue first"])
    expect(userTexts(s.requests[2])).toEqual([
      "Start working",
      "Queue first",
      "Steer before next queued input",
      "Also steer before next queued input",
      "Background completion before next queued input",
    ])
    expect(userTexts(s.requests[3])).toEqual([
      "Start working",
      "Queue first",
      "Steer before next queued input",
      "Also steer before next queued input",
      "Background completion before next queued input",
      "Queue second",
    ])
  })

  scenario("coalesces multiple active steering prompts into one continuation step", function* (s) {
    const execution = yield* SessionExecution.Service
    yield* s.admit("Start working")

    yield* s.llm.push(TestLLM.stop(), TestLLM.stop())

    const first = yield* s.resumePaused
    yield* s.session.prompt({ sessionID, text: "First steer" })
    yield* s.session.prompt({ sessionID, text: "Second steer" })
    yield* first.finish
    yield* Effect.yieldNow

    expect(s.requests).toHaveLength(2)
    expect(userTexts(s.requests[1])).toEqual(["Start working", "First steer", "Second steer"])
    yield* execution.wake(sessionID)
    yield* Effect.yieldNow
    expect(s.requests).toHaveLength(2)
  })

  scenario("runs steering input accepted while the active step fails", function* (s) {
    yield* s.admit("Start working")

    const failure = invalidRequest()
    yield* s.llm.push(Stream.fail(failure))

    const first = yield* s.resumePaused
    yield* s.session.prompt({ sessionID, text: "Recover with this" })
    expect(yield* first.finish.pipe(Effect.flip)).toBe(failure)

    yield* s.llm.push([])
    yield* s.session.wait(sessionID)

    expect(s.requests).toHaveLength(2)
    expect(userTexts(s.requests[1])).toEqual(["Start working", "Recover with this"])
  })

  scenario("settles abandoned compactions before continuing after a process crash", function* (s) {
    yield* s.runPrompt("History before the crash")
    const first = SessionMessage.ID.create()
    const completed = SessionMessage.ID.create()
    const last = SessionMessage.ID.create()
    yield* s.bus.publish(SessionEvent.Compaction.Started, {
      sessionID,
      reason: "manual",
      inputID: first,
      recent: "",
    })
    yield* s.bus.publish(SessionEvent.Compaction.Started, {
      sessionID,
      reason: "manual",
      inputID: completed,
      recent: "",
    })
    yield* s.bus.publish(SessionEvent.Compaction.Ended, {
      sessionID,
      reason: "manual",
      text: "## Objective\n- Earlier completed checkpoint",
      recent: "",
    })
    yield* s.bus.publish(SessionEvent.Compaction.Started, {
      sessionID,
      reason: "auto",
      inputID: last,
      recent: "",
    })

    // These starts have no terminal events, as after SIGKILL. The older orphan
    // is outside model-visible history; recovery must settle it as well.
    expect(
      (yield* s.messages).filter((message) => message.type === "compaction" && message.status === "running"),
    ).toHaveLength(2)
    yield* s.llm.push(TestLLM.text("Recovered response", "recovered"))
    const run = yield* s.resumePaused
    expect((yield* s.messages).filter((message) => message.type === "compaction").toReversed()).toMatchObject([
      { id: first, status: "failed", reason: "manual", error: { type: "compaction.interrupted" } },
      { id: completed, status: "completed", summary: "## Objective\n- Earlier completed checkpoint" },
      { id: last, status: "failed", reason: "auto", error: { type: "compaction.interrupted" } },
    ])
    yield* run.finish

    yield* s.llm.push(TestLLM.text("## Objective\n- New checkpoint", "new-summary"))
    const next = yield* s.session.compact({ sessionID })
    yield* s.session.wait(sessionID)
    expect((yield* s.messages).find((message) => message.id === next.id)).toMatchObject({
      status: "completed",
      summary: "## Objective\n- New checkpoint",
    })
    expect(
      (yield* s.messages).filter((message) => message.type === "compaction" && message.status === "running"),
    ).toHaveLength(0)
  })

  scenario("settles an abandoned compaction before delivering another manual compaction", function* (s) {
    yield* s.runPrompt("History before the crash")
    const previous = SessionMessage.ID.create()
    yield* s.bus.publish(SessionEvent.Compaction.Started, {
      sessionID,
      reason: "manual",
      inputID: previous,
      recent: "",
    })
    yield* s.llm.push(TestLLM.text("## Objective\n- New checkpoint", "new-summary"))
    const gate = yield* s.llm.gate
    const next = yield* s.session.compact({ sessionID })
    yield* gate.started
    expect((yield* s.messages).filter((message) => message.type === "compaction").toReversed()).toMatchObject([
      { id: previous, status: "failed", error: { type: "compaction.interrupted" } },
      { id: next.id, status: "running" },
    ])
    yield* gate.release
    yield* s.session.wait(sessionID)
  })

  scenario("durably fails local tools left running by a prior process before continuing", function* (s) {
    yield* s.admit("Recover interrupted tool")
    yield* SessionInbox.promote(s.db, s.bus, sessionID, "steer")
    const assistantMessageID = SessionMessage.ID.create()
    yield* s.bus.publish(SessionEvent.Step.Started, {
      sessionID,
      assistantMessageID,
      agent: Agent.ID.make("build"),
      model: { id: ID.make("fake-model"), providerID: Provider.ID.make("fake") },
    })
    yield* s.bus.publish(SessionEvent.Tool.Input.Started, {
      sessionID,
      assistantMessageID,
      id: "call-interrupted",
      name: "echo",
    })
    yield* s.bus.publish(SessionEvent.Tool.Input.Ended, {
      sessionID,
      assistantMessageID,
      id: "call-interrupted",
      text: '{"text":"stale"}',
    })
    yield* s.bus.publish(SessionEvent.Tool.Called, {
      sessionID,
      assistantMessageID,
      id: "call-interrupted",
      input: { text: "stale" },
      executed: false,
    })
    s.requests.length = 0
    yield* s.llm.push([])
    yield* s.resume

    expect(s.requests).toHaveLength(1)
    expect(messageRoles(s.requests[0])).toEqual(["user", "assistant", "tool"])
    expect(yield* s.context).toMatchObject([
      Expected.user("Recover interrupted tool"),
      Expected.assistant({}, [
        Expected.failedTool(
          { id: "call-interrupted" },
          { error: { type: "aborted", message: "Tool execution interrupted: echo" } },
        ),
      ]),
    ])
  })

  scenario("preserves a stale subagent child session in its model-visible failure", function* (s) {
    yield* s.admit("Recover interrupted subagent")
    yield* SessionInbox.promote(s.db, s.bus, sessionID, "steer")
    const assistantMessageID = SessionMessage.ID.create()
    yield* s.bus.publish(SessionEvent.Step.Started, {
      sessionID,
      assistantMessageID,
      agent: Agent.ID.make("build"),
      model: { id: ID.make("fake-model"), providerID: Provider.ID.make("fake") },
    })
    yield* s.bus.publish(SessionEvent.Tool.Input.Started, {
      sessionID,
      assistantMessageID,
      id: "call-interrupted-subagent",
      name: "subagent",
    })
    yield* s.bus.publish(SessionEvent.Tool.Input.Ended, {
      sessionID,
      assistantMessageID,
      id: "call-interrupted-subagent",
      text: '{"agent":"general"}',
    })
    yield* s.bus.publish(SessionEvent.Tool.Called, {
      sessionID,
      assistantMessageID,
      id: "call-interrupted-subagent",
      input: { agent: "general" },
      executed: false,
    })
    yield* s.db
      .update(SessionMessageTable)
      .set({
        data: sql`json_set(
          ${SessionMessageTable.data},
          '$.content[0].state.metadata',
          json('{"sessionID":"ses_existing_child","status":"running","internal":"private"}')
        )`,
      })
      .where(eq(SessionMessageTable.id, assistantMessageID))
      .run()
      .pipe(Effect.orDie)
    s.requests.length = 0
    yield* s.llm.push([])
    yield* s.resume

    expect(yield* s.context).toMatchObject([
      Expected.user("Recover interrupted subagent"),
      Expected.assistant({}, [
        Expected.failedTool(
          { id: "call-interrupted-subagent" },
          {
            error: {
              type: "aborted",
              message: "Tool execution interrupted: subagent (sessionID: ses_existing_child)",
            },
            metadata: { sessionID: "ses_existing_child", status: "running", internal: "private" },
          },
        ),
      ]),
    ])
    const modelResult = JSON.stringify(s.requests[0]?.messages.at(-1))
    expect(modelResult).toContain("ses_existing_child")
    expect(modelResult).not.toContain("private")
  })

  scenario("durably fails hosted tools left running by a prior process before continuing inline", function* (s) {
    yield* s.admit("Recover interrupted hosted tool")
    yield* SessionInbox.promote(s.db, s.bus, sessionID, "steer")
    const assistantMessageID = SessionMessage.ID.create()
    yield* s.bus.publish(SessionEvent.Step.Started, {
      sessionID,
      assistantMessageID,
      agent: Agent.ID.make("build"),
      model: { id: ID.make("fake-model"), providerID: Provider.ID.make("fake") },
    })
    yield* s.bus.publish(SessionEvent.Tool.Input.Started, {
      sessionID,
      assistantMessageID,
      id: "call-hosted-interrupted",
      name: "web_search",
    })
    yield* s.bus.publish(SessionEvent.Tool.Input.Ended, {
      sessionID,
      assistantMessageID,
      id: "call-hosted-interrupted",
      text: '{"query":"stale"}',
    })
    yield* s.bus.publish(SessionEvent.Tool.Called, {
      sessionID,
      assistantMessageID,
      id: "call-hosted-interrupted",
      input: { query: "stale" },
      executed: true,
      state: { itemId: "call-hosted-interrupted" },
    })
    s.requests.length = 0
    yield* s.llm.push([])
    yield* s.resume

    expect(s.requests).toHaveLength(1)
    expect(messageRoles(s.requests[0])).toEqual(["user", "assistant"])
    expect(s.requests[0]?.messages[1]?.content).toMatchObject([
      {
        type: "tool-call",
        id: "call-hosted-interrupted",
        providerExecuted: true,
        providerMetadata: { openai: { itemId: "call-hosted-interrupted" } },
      },
      { type: "tool-result", id: "call-hosted-interrupted", providerExecuted: true, result: { type: "error" } },
    ])
  })

  scenario("durably fails pending tool input left by a prior process before continuing", function* (s) {
    yield* s.admit("Recover interrupted tool input")
    yield* SessionInbox.promote(s.db, s.bus, sessionID, "steer")
    const assistantMessageID = SessionMessage.ID.create()
    yield* s.bus.publish(SessionEvent.Step.Started, {
      sessionID,
      assistantMessageID,
      agent: Agent.ID.make("build"),
      model: { id: ID.make("fake-model"), providerID: Provider.ID.make("fake") },
    })
    yield* s.bus.publish(SessionEvent.Tool.Input.Started, {
      sessionID,
      assistantMessageID,
      id: "call-pending-interrupted",
      name: "echo",
    })
    s.requests.length = 0
    yield* s.llm.push([])
    yield* s.resume

    expect(s.requests).toHaveLength(1)
    expect(messageRoles(s.requests[0])).toEqual(["user", "assistant", "tool"])
    expect(yield* s.context).toMatchObject([
      Expected.user("Recover interrupted tool input"),
      Expected.assistant({}, [Expected.failedTool({ id: "call-pending-interrupted" }, {})]),
    ])
  })

  scenario("promotes the first queued input when woken while idle", function* (s) {
    const execution = yield* SessionExecution.Service
    yield* s.session.prompt({
      sessionID,
      text: "Wait in queue",
      delivery: "queue",
      resume: false,
    })

    const stream = yield* s.llm.gate
    yield* execution.wake(sessionID)
    yield* stream.started
    yield* stream.release

    expect(s.requests).toHaveLength(1)
    expect(userTexts(s.requests[0])).toEqual(["Wait in queue"])
  })

  scenario("retries inbox input after prompt projection rolls back", function* (s) {
    const execution = yield* SessionExecution.Service
    const defect = new Error("fail after prompt promotion")
    let fail = true
    yield* s.bus.project(SessionEvent.InboxDelivered, () => (fail ? Effect.die(defect) : Effect.void))
    yield* s.admit("Recover promoted input")

    expect(yield* s.resume.pipe(Effect.catchDefect(Effect.succeed))).toBe(defect)
    fail = false
    s.requests.length = 0
    yield* s.llm.push(TestLLM.stop())

    const stream = yield* s.llm.gate
    yield* execution.wake(sessionID)
    yield* stream.started
    yield* stream.release

    expect(userTexts(s.requests[0])).toEqual(["Recover promoted input"])
  })

  scenario("does not strand a committed promotion when a post-commit listener defects", function* (s) {
    yield* s.bus.listen((event) =>
      event.type === SessionEvent.InboxDelivered.type ? Effect.die("fail after prompt promotion commits") : Effect.void,
    )
    yield* s.runPrompt("Run committed promotion")

    expect(s.requests).toHaveLength(1)
    expect(userTexts(s.requests[0])).toEqual(["Run committed promotion"])
  })

  scenario("adds session correlation headers to model requests", function* (s) {
    yield* s.runPrompt("Run correlated request")

    expect(s.requests[0]?.http?.headers).toEqual({
      "x-session-affinity": sessionID,
      "X-Session-Id": sessionID,
      "User-Agent": App.useragent(App.make()),
      "x-opencode-project": Project.ID.global,
      "x-opencode-session": sessionID,
      "x-opencode-client": "opencode",
    })
  })

  scenario("adds the parent session header to child model requests", function* (s) {
    const parentID = Session.ID.make("ses_runner_parent")

    yield* s.db
      .update(SessionTable)
      .set({ parent_id: parentID })
      .where(eq(SessionTable.id, sessionID))
      .run()
      .pipe(Effect.orDie)
    yield* s.runPrompt("Run child request")

    expect(s.requests[0]?.http?.headers?.["x-parent-session-id"]).toBe(parentID)
  })

  scenario("runs different sessions concurrently", function* (s) {
    yield* insertSession(otherSessionID)
    yield* s.admit("Run first")
    yield* s.session.prompt({
      sessionID: otherSessionID,
      text: "Run second",
      resume: false,
    })

    const stream = yield* s.llm.gate

    const first = yield* s.resume.pipe(Effect.forkChild)
    yield* stream.started
    const second = yield* s.session.resume(otherSessionID).pipe(Effect.forkChild)
    yield* stream.started

    expect(s.requests).toHaveLength(2)
    expect(s.requests.map((request) => request.promptCacheKey)).toEqual([sessionID, otherSessionID])
    yield* stream.release
    yield* Fiber.join(first)
    yield* Fiber.join(second)
  })

  scenario("bounds 64-character session prompt cache keys", function* (s) {
    const longSessionID = Session.ID.make(`ses_${"a".repeat(64)}`)
    const otherLongSessionID = Session.ID.make(`ses_${"b".repeat(64)}`)
    yield* insertSession(longSessionID)
    yield* insertSession(otherLongSessionID)
    yield* s.session.prompt({
      sessionID: longSessionID,
      text: "Run long session",
      resume: false,
    })
    yield* s.session.prompt({
      sessionID: otherLongSessionID,
      text: "Run other long session",
      resume: false,
    })

    yield* s.session.resume(longSessionID)
    yield* s.session.resume(otherLongSessionID)

    const keys = s.requests.map((request) => request.promptCacheKey)
    expect(keys).toEqual([longSessionID.slice(4), otherLongSessionID.slice(4)])
    expect(keys.every((key) => typeof key === "string" && key.length === 64)).toBe(true)
    expect(keys[0]).not.toBe(keys[1])
  })

  scenario("fans out one failed run and allows a later retry", function* (s) {
    yield* s.admit("Retry after failure")

    yield* s.llm.push(Stream.fail(invalidRequest()))
    const stream = yield* s.llm.gate

    const first = yield* s.resume.pipe(Effect.forkChild)
    yield* stream.started
    const second = yield* s.resume.pipe(Effect.forkChild)
    yield* Effect.yieldNow

    expect(s.requests).toHaveLength(1)
    yield* stream.release
    const [firstExit, secondExit] = yield* Effect.all([Fiber.await(first), Fiber.await(second)])
    expect(secondExit).toEqual(firstExit)

    yield* s.llm.push([])
    yield* s.resume
    expect(s.requests).toHaveLength(2)
  })

  scenario("durably settles local tool failures before continuing", function* (s) {
    yield* s.admit("Call missing")

    yield* s.llm.push(TestLLM.tool("call-missing", "missing", {}), TestLLM.text("Recovered", "text-after-error"))
    yield* s.resume

    expect(s.requests).toHaveLength(2)
    expect(yield* s.context).toMatchObject([
      Expected.user("Call missing"),
      Expected.assistant({}, [
        Expected.failedTool(
          { id: "call-missing" },
          {
            error: {
              type: "tool.execution",
              message:
                'No tool named "missing" is currently available. Please use a tool from the available tool list.',
            },
          },
        ),
      ]),
      Expected.assistant({ finish: "stop" }, [Expected.text("Recovered")]),
    ])
  })

  scenario("returns unexpected local tool defects to the model and continues", function* (s) {
    yield* s.admit("Call defect")

    yield* s.llm.push(TestLLM.tool("call-defect", "defect", {}), TestLLM.text("Recovered", "text-after-defect"))

    yield* s.resume

    expect(s.requests).toHaveLength(2)
    expect(messageRoles(s.requests[1])).toEqual(["user", "assistant", "tool"])
    const context = yield* s.context
    expect(context).toMatchObject([
      Expected.user("Call defect"),
      Expected.assistant({}, [
        Expected.failedTool({ id: "call-defect" }, { error: { type: "unknown", message: "unexpected tool defect" } }),
      ]),
      Expected.assistant({ finish: "stop" }, [Expected.text("Recovered")]),
    ])
    const assistant = requireAssistant(context)
    expect(yield* recordedStepSettlementTypes(sessionID, assistant.id)).toEqual([
      "session.step.started.1",
      "session.tool.called.1",
      "session.tool.failed.2",
      "session.step.ended.1",
    ])
  })

  scenario("returns tool-wrapped policy blocks to the model and continues", function* (s) {
    const registry = yield* Tool.Service
    yield* transformTools(
      registry,
      {
        blocked: {
          name: "blocked",
          description: "Fail because policy blocked execution",
          input: Schema.Struct({}),
          output: Schema.Struct({}),
          execute: () =>
            Effect.fail(new Permission.BlockedError({ rules: [], permission: "blocked", resources: ["*"] })).pipe(
              Effect.mapError(() => new Tool.Error({ message: "Permission blocked" })),
            ),
        },
      },
      { codemode: false },
    )
    yield* s.admit("Call blocked")

    yield* s.llm.push(TestLLM.tool("call-blocked", "blocked", {}), TestLLM.stop())

    yield* s.resume

    expect(s.requests).toHaveLength(2)
    expect(yield* s.context).toMatchObject([
      Expected.user("Call blocked"),
      Expected.assistant({}, [
        Expected.failedTool({ id: "call-blocked" }, { error: { message: "Permission blocked" } }),
      ]),
      { type: "assistant", finish: "stop" },
    ])
  })

  scenario("interrupts runner continuation on a decline after settling an ordinary tool error", function* (s) {
    const registry = yield* Tool.Service
    yield* transformTools(
      registry,
      {
        failed: {
          name: "failed",
          description: "Fail normally before the declined call",
          input: Schema.Struct({}),
          output: Schema.Struct({}),
          execute: () => Effect.fail(new Tool.Error({ message: "Ordinary tool failure" })),
        },
        declined: {
          name: "declined",
          description: "Fail because the user declined approval",
          input: Schema.Struct({}),
          output: Schema.Struct({}),
          execute: () => Effect.die(new Permission.DeclinedError()),
        },
      },
      { codemode: false },
    )
    yield* s.admit("Call declined")

    yield* s.llm.push(
      TestLLM.toolCalls(
        LLMEvent.toolCall({ id: "call-failed", name: "failed", input: {} }),
        LLMEvent.toolCall({ id: "call-declined", name: "declined", input: {} }),
      ),
    )

    const exit = yield* s.resume.pipe(Effect.exit)

    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
    expect(s.requests).toHaveLength(1)
    expect(yield* s.context).toMatchObject([
      Expected.user("Call declined"),
      Expected.assistant({}, [
        Expected.failedTool({ id: "call-failed" }, { error: { message: "Ordinary tool failure" } }),
        Expected.failedTool(
          { id: "call-declined" },
          { error: { type: "aborted", message: "The user declined this tool call" } },
        ),
      ]),
    ])
  })

  scenario("returns permission corrections to the model and continues", function* (s) {
    const registry = yield* Tool.Service
    yield* transformTools(
      registry,
      {
        corrected: {
          name: "corrected",
          description: "Fail with user correction feedback",
          input: Schema.Struct({}),
          output: Schema.Struct({}),
          execute: () =>
            Effect.fail(new Permission.CorrectedError({ feedback: "Use another tool" })).pipe(
              Effect.mapError(() => new Tool.Error({ message: "Use another tool" })),
            ),
        },
      },
      { codemode: false },
    )
    yield* s.admit("Call corrected")

    yield* s.llm.push(TestLLM.tool("call-corrected", "corrected", {}), TestLLM.stop())

    yield* s.resume

    expect(s.requests).toHaveLength(2)
    expect(yield* s.context).toMatchObject([
      Expected.user("Call corrected"),
      Expected.assistant({}, [
        Expected.failedTool({ id: "call-corrected" }, { error: { message: "Use another tool" } }),
      ]),
      { type: "assistant", finish: "stop" },
    ])
  })

  scenario("returns configured permission denials to the model and continues", function* (s) {
    const registry = yield* Tool.Service
    yield* transformTools(registry, { permissionfail: permissionFail }, { codemode: false })
    yield* s.admit("Reject permission")
    yield* s.llm.push(TestLLM.tool("call-permission", "permissionfail", {}), [
      LLMEvent.stepStart({ index: 0 }),
      LLMEvent.stepFinish({ index: 0, reason: { normalized: "stop" } }),
    ])

    yield* s.resume

    expect(s.requests).toHaveLength(2)
    expect(yield* s.context).toMatchObject([
      { type: "user" },
      Expected.assistant({}, [
        Expected.failedTool(
          { id: "call-permission" },
          {
            error: {
              type: "permission.rejected",
              message: "Permission denied: edit",
            },
          },
        ),
      ]),
      { type: "assistant", finish: "stop" },
    ])
    expect(yield* recordedEventTypes(sessionID)).not.toContain("session.step.failed.1")
  })

  scenario("interrupts runner continuation when a question is cancelled", function* (s) {
    const registry = yield* Tool.Service
    yield* transformTools(
      registry,
      {
        question: {
          name: "question",
          description: "Ask the user",
          input: Schema.Struct({}),
          output: Schema.Struct({}),
          execute: () => Effect.die(new QuestionTool.CancelledError()),
        },
      },
      { codemode: false },
    )
    yield* s.admit("Ask then stop")

    yield* s.llm.push(TestLLM.tool("call-question", "question", {}), [])

    const run = yield* s.resume.pipe(Effect.exit, Effect.forkChild)
    const exit = yield* Fiber.join(run)

    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
    expect(s.requests).toHaveLength(1)
    expect(yield* s.context).toMatchObject([
      Expected.user("Ask then stop"),
      Expected.assistant({}, [
        Expected.failedTool(
          { id: "call-question" },
          { error: { type: "aborted", message: "The user dismissed this question" } },
        ),
      ]),
    ])
  })

  scenario("awaits started local tools before surfacing provider stream failure", function* (s) {
    yield* s.admit("Settle before failing")
    // Non-retryable so the step settles terminally instead of continuing after tool output.
    const failure = invalidRequest()
    const tools = yield* s.blockTools()
    yield* s.llm.push(
      TestLLM.failAfter(
        failure,
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolCall({ id: "call-before-failure", name: "echo", input: { text: "settle" } }),
      ),
    )

    const run = yield* s.resume.pipe(Effect.forkChild)
    yield* tools.started
    yield* tools.release
    expect(yield* Fiber.join(run).pipe(Effect.flip)).toBe(failure)

    const context = yield* s.context
    expect(context).toMatchObject([
      Expected.user("Settle before failing"),
      Expected.assistant({}, [
        Expected.completedTool({ id: "call-before-failure" }, { content: [Expected.text("settle")] }),
      ]),
    ])
    const assistant = requireAssistant(context)
    expect(yield* recordedStepSettlementTypes(sessionID, assistant.id)).toEqual([
      "session.step.started.1",
      "session.tool.called.1",
      "session.tool.success.2",
      "session.step.failed.1",
    ])
  })

  scenario("durably fails blocked local tools when a step is interrupted", function* (s) {
    yield* s.admit("Interrupt blocked tool")
    const tools = yield* s.blockTools()
    yield* s.llm.push(
      TestLLM.hangAfter(
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolCall({ id: "call-before-interrupt", name: "echo", input: { text: "blocked" } }),
      ),
    )

    const run = yield* s.resume.pipe(Effect.forkChild)
    yield* tools.started
    yield* s.session.interrupt(sessionID)

    expect(yield* Fiber.await(run)).toMatchObject({ _tag: "Failure" })
    yield* s.session.interrupt(sessionID)
    const context = yield* s.context
    expect(context).toMatchObject([
      Expected.user("Interrupt blocked tool"),
      Expected.assistant({}, [
        Expected.failedTool(
          { id: "call-before-interrupt" },
          { error: { type: "aborted", message: "Tool execution interrupted" } },
        ),
      ]),
    ])
    const assistant = requireAssistant(context)
    expect(yield* recordedStepSettlementTypes(sessionID, assistant.id)).toEqual([
      "session.step.started.1",
      "session.tool.called.1",
      "session.tool.failed.2",
      "session.step.failed.1",
    ])

    yield* replaySessionProjection(sessionID)

    expect(yield* s.context).toMatchObject([
      Expected.user("Interrupt blocked tool"),
      Expected.assistant({}, [Expected.failedTool({ id: "call-before-interrupt" }, {})]),
    ])
    s.requests.length = 0
    yield* s.llm.push([])
    yield* s.resume
    expect(messageRoles(s.requests[0])).toEqual(["user", "assistant", "tool"])
  })

  scenario("interrupts a blocked step without local tool execution", function* (s) {
    yield* s.admit("Interrupt provider")
    const stream = yield* s.llm.gate

    const run = yield* s.resume.pipe(Effect.forkChild)
    yield* stream.started
    yield* s.session.interrupt(sessionID)
    const exit = yield* Fiber.await(run)

    expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBeTrue()
    expect(s.requests).toHaveLength(1)
    expect(yield* s.context).toMatchObject([
      Expected.user("Interrupt provider"),
      { type: "assistant", finish: "error", error: { type: "aborted", message: "Step interrupted" } },
    ])
    expect(yield* recordedEventTypes(sessionID)).toContain("session.step.failed.1")
    yield* s.session.interrupt(sessionID)
  })

  scenario("durably fails blocked local tools when interrupted while awaiting settlement", function* (s) {
    yield* s.admit("Interrupt tool settlement")
    const tools = yield* s.blockTools()
    yield* s.llm.push(TestLLM.tool("call-await-interrupt", "echo", { text: "blocked" }))
    const streamed = yield* s.bus.subscribe(SessionEvent.Step.Streamed).pipe(
      Stream.filter((event) => event.data.sessionID === sessionID),
      Stream.runHead,
      Effect.forkScoped({ startImmediately: true }),
    )

    const runner = yield* SessionRunner.Service
    const run = yield* runner.drain({ sessionID, force: true }).pipe(Effect.forkChild)
    yield* tools.started
    yield* Fiber.join(streamed)
    yield* Fiber.interrupt(run)

    const exit = yield* Fiber.await(run)
    expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
    expect(yield* s.context).toMatchObject([
      Expected.user("Interrupt tool settlement"),
      Expected.assistant({ finish: "error", error: { type: "aborted", message: "Step interrupted" } }, [
        Expected.failedTool(
          { id: "call-await-interrupt" },
          { error: { type: "aborted", message: "Tool execution interrupted" } },
        ),
      ]),
    ])
    const eventTypes = yield* recordedEventTypes(sessionID)
    expect(eventTypes.filter((type) => type === "session.tool.failed.2")).toHaveLength(1)
    expect(eventTypes.filter((type) => type === "session.step.failed.1")).toHaveLength(1)
    expect(eventTypes).not.toContain("session.step.ended.1")
    expect(eventTypes).not.toContain("session.retry.scheduled.1")
    expect(s.requests).toHaveLength(1)
  })

  scenario("forces a text response on an agent's configured final step", function* (s) {
    const agents = yield* Agent.Service
    yield* agents.transform((editor) =>
      editor.update(Agent.ID.make("build"), (agent) => {
        agent.steps = 2
      }),
    )
    yield* s.admit("Finish at the limit")

    yield* s.llm.push(
      TestLLM.tool("call-terminal", "echo", { text: "done" }),
      TestLLM.tool("call-forbidden", "echo", { text: "forbidden" }),
    )

    yield* s.resume

    expect(s.requests).toHaveLength(2)
    expect(s.requests[0]?.toolChoice).toBeUndefined()
    expect(s.requests[1]?.toolChoice).toMatchObject({ type: "none" })
    // Protocols with native "none" keep these definitions for prompt caching.
    expect(s.requests[1]?.tools.map((tool) => tool.name)).toContain("echo")
    expect(s.requests[1]?.messages.at(-1)).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: expect.stringContaining("MAXIMUM STEPS REACHED") }],
    })
    expect(s.executions).toEqual(["done"])
    expect(yield* s.context).toMatchObject([
      Expected.user("Finish at the limit"),
      Expected.assistant({}, [Expected.completedTool({ id: "call-terminal" }, {})]),
      Expected.assistant({}, [Expected.failedTool({ id: "call-forbidden" }, {})]),
    ])
  })

  scenario("resets the configured step allowance when steering input promotes", function* (s) {
    const agents = yield* Agent.Service
    yield* agents.transform((editor) =>
      editor.update(Agent.ID.make("build"), (agent) => {
        agent.steps = 2
      }),
    )
    yield* s.admit("Start work")

    yield* s.llm.push(
      TestLLM.tool("call-before-steer", "echo", { text: "before" }),
      TestLLM.tool("call-after-steer", "echo", { text: "after" }),
      TestLLM.stop(),
    )

    const run = yield* s.resumePaused
    yield* s.session.prompt({ sessionID, text: "Change direction" })
    yield* run.finish

    expect(s.requests).toHaveLength(3)
    expect(s.requests[1]?.toolChoice).toBeUndefined()
    expect(s.requests[1]?.tools).not.toEqual([])
    expect(s.requests[2]?.toolChoice).toMatchObject({ type: "none" })
    expect(s.executions).toEqual(["before", "after"])
  })

  scenario("projects provider errors as terminal assistant step failures", function* (s) {
    yield* s.llm.push([LLMEvent.stepStart({ index: 0 }), LLMEvent.providerError({ message: "Provider unavailable" })])

    expect((yield* s.runPrompt("Fail durably").pipe(Effect.flip)).message).toBe("Provider unavailable")

    expect(s.requests).toHaveLength(1)
    expect(yield* s.context).toMatchObject([
      Expected.user("Fail durably"),
      { type: "assistant", finish: "error", error: { type: "provider.unknown", message: "Provider unavailable" } },
    ])
  })

  scenario("projects provider errors emitted before assistant step start", function* (s) {
    yield* s.llm.push([LLMEvent.providerError({ message: "Provider unavailable" })])

    expect((yield* s.runPrompt("Fail before step").pipe(Effect.flip)).message).toBe("Provider unavailable")

    expect(s.requests).toHaveLength(1)
    expect(yield* s.context).toMatchObject([
      Expected.user("Fail before step"),
      { type: "assistant", finish: "error", error: { type: "provider.unknown", message: "Provider unavailable" } },
    ])
  })

  scenario("persists raw finish reasons and provider state", function* (s) {
    yield* s.llm.push(
      TestLLM.complete(
        {
          reason: { normalized: "stop", raw: "end_turn" },
          providerMetadata: { openai: { responseId: "response-1", serviceTier: "priority" } },
        },
        LLMEvent.textStart({ id: "answer" }),
        LLMEvent.textDelta({ id: "answer", text: "Complete" }),
        LLMEvent.textEnd({ id: "answer" }),
      ),
    )

    yield* s.runPrompt("Keep provider finish details")

    expect(yield* s.context).toMatchObject([
      { type: "user" },
      {
        type: "assistant",
        finish: "stop",
        rawFinish: "end_turn",
        providerState: { responseId: "response-1", serviceTier: "priority" },
        content: [Expected.text("Complete")],
      },
    ])
  })

  scenario("projects content-filter finishes as visible terminal failures", function* (s) {
    yield* s.llm.push(
      TestLLM.complete(
        {
          reason: { normalized: "content-filter", raw: "SAFETY" },
          providerMetadata: {
            openai: {
              responseId: "response-blocked",
              refusal: { category: "safety", explanation: "Prompt blocked" },
            },
          },
          usage: { nonCachedInputTokens: 8, outputTokens: 3, reasoningTokens: 1 },
        },
        LLMEvent.textStart({ id: "partial" }),
        LLMEvent.textDelta({ id: "partial", text: "Partial" }),
      ),
    )

    expect((yield* s.runPrompt("Blocked response").pipe(Effect.flip)).message).toBe("Provider blocked the response")
    expect(yield* s.context).toMatchObject([
      { type: "user" },
      {
        type: "assistant",
        finish: "content-filter",
        rawFinish: "SAFETY",
        providerState: {
          responseId: "response-blocked",
          refusal: { category: "safety", explanation: "Prompt blocked" },
        },
        error: { type: "provider.content-filter" },
        cost: 0,
        tokens: { input: 8, output: 2, reasoning: 1, cache: { read: 0, write: 0 } },
        content: [Expected.text("Partial")],
      },
    ])
    expect(yield* s.session.get(sessionID)).toMatchObject({
      cost: 0,
      tokens: { input: 8, output: 2, reasoning: 1, cache: { read: 0, write: 0 } },
    })
    expect(yield* recordedEventTypes(sessionID)).not.toContain("session.step.ended.1")
  })

  scenario("settles a local tool before one content-filter step failure", function* (s) {
    yield* s.admit("Tool before blocked response")
    const tools = yield* s.blockTools()
    yield* s.llm.push(
      TestLLM.complete(
        { reason: { normalized: "content-filter" } },
        LLMEvent.toolCall({ id: "call-before-content-filter", name: "echo", input: { text: "settled" } }),
      ),
    )

    const run = yield* s.resume.pipe(Effect.forkChild)
    yield* tools.started
    yield* tools.release
    expect((yield* Fiber.join(run).pipe(Effect.flip)).message).toBe("Provider blocked the response")

    const assistant = requireAssistant(yield* s.context)
    const events = yield* recordedStepSettlementEvents(sessionID, assistant.id)
    expect(events.map((event) => event.type)).toEqual([
      "session.step.started.1",
      "session.tool.called.1",
      "session.tool.success.2",
      "session.step.failed.1",
    ])
    expect(
      events.filter((event) => event.type.startsWith("session.step.") && event.type !== "session.step.started.1"),
    ).toHaveLength(1)
  })

  scenario("does not recover context overflow after durable assistant output", function* (s) {
    yield* s.llm.push([
      LLMEvent.stepStart({ index: 0 }),
      LLMEvent.textStart({ id: "text-partial" }),
      LLMEvent.textDelta({ id: "text-partial", text: "Partial" }),
      LLMEvent.textEnd({ id: "text-partial" }),
      LLMEvent.providerError({ message: "prompt too long", classification: "context-overflow" }),
    ])
    expect((yield* s.runPrompt("Fail after output").pipe(Effect.flip)).message).toBe("prompt too long")

    expect(s.requests).toHaveLength(1)
    expect(yield* s.context).toMatchObject([
      Expected.user("Fail after output"),
      Expected.assistant({ finish: "error", error: { message: "prompt too long" } }, [Expected.text("Partial")]),
    ])
  })

  scenario("projects raw provider stream failures as terminal assistant step failures", function* (s) {
    const failure = invalidRequest()
    yield* s.llm.push(Stream.fail(failure))

    expect(yield* s.runPrompt("Fail raw stream durably").pipe(Effect.flip)).toBe(failure)
    yield* replaySessionProjection(sessionID)
    expect(yield* s.context).toMatchObject([
      Expected.user("Fail raw stream durably"),
      { type: "assistant", finish: "error", error: { type: "provider.invalid-request", message: "Invalid request" } },
    ])
  })

  scenario("bounds jittered exponential backoff for eligible pre-output failures", function* (s) {
    yield* s.admit("Retry transport")
    yield* s.llm.push(Stream.fail(providerUnavailable()))
    yield* s.llm.push(TestLLM.text("Recovered", "retry-success"))

    const scheduled = yield* subscribeRetries(s)
    const run = yield* s.resume.pipe(Effect.forkChild)
    yield* Queue.take(scheduled)
    yield* TestClock.adjust("1599 millis")
    expect(s.requests).toHaveLength(1)
    yield* TestClock.adjust("801 millis")
    yield* Fiber.join(run)

    expect(s.requests).toHaveLength(2)
    const eventTypes = yield* recordedEventTypes(sessionID)
    expect(eventTypes).toContain("session.retry.scheduled.1")
    expect(eventTypes.filter((type) => type === "session.step.started.1")).toHaveLength(2)
    expect(yield* s.context).toMatchObject([
      { type: "user" },
      Expected.assistant({ finish: "stop" }, [Expected.text("Recovered")]),
    ])
    yield* replaySessionProjection(sessionID)
    expect((yield* s.context).filter((message) => message.type === "assistant")).toHaveLength(1)
  })

  scenario("does not start another physical attempt after interruption during retry backoff", function* (s) {
    yield* s.admit("Interrupt retry backoff")
    yield* s.llm.push(Stream.fail(providerUnavailable()), TestLLM.text("Must not run", "unused-retry"))
    const scheduled = yield* subscribeRetries(s)
    const run = yield* s.resume.pipe(Effect.forkChild)
    yield* Queue.take(scheduled)
    yield* s.session.interrupt(sessionID)
    const exit = yield* Fiber.await(run)
    expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
    yield* TestClock.adjust("1 minute")
    expect(s.requests).toHaveLength(1)
    const events = yield* recordedEventTypes(sessionID)
    expect(events.filter((type) => type === "session.retry.scheduled.1")).toHaveLength(1)
    expect(events).not.toContain("session.synthetic.1")
  })

  scenario("immediately rebuilds once after explicit continuation rejection", function* (s) {
    yield* s.llm.push(Stream.fail(continuationRejected("retry-full")))
    yield* s.llm.push(TestLLM.text("Recovered", "continuation-recovery"))

    yield* s.runPrompt("Recover continuation")

    expect(s.requests).toHaveLength(2)
    expect(yield* recordedEventTypes(sessionID)).not.toContain("session.retry.scheduled.1")
    expect(yield* s.context).toMatchObject([
      { type: "user" },
      Expected.assistant({ finish: "stop" }, [Expected.text("Recovered")]),
    ])
  })

  scenario("bounds repeated continuation rejection to one immediate recovery", function* (s) {
    const failure = continuationRejected("rotate-and-retry-full")
    yield* s.llm.push(Stream.fail(failure), Stream.fail(failure))

    expect(yield* s.runPrompt("Reject continuation twice").pipe(Effect.flip)).toBe(failure)

    expect(s.requests).toHaveLength(2)
    expect(yield* recordedEventTypes(sessionID)).not.toContain("session.retry.scheduled.1")
  })

  scenario("retries an incomplete stream before output", function* (s) {
    yield* s.admit("Retry incomplete stream")
    yield* s.llm.push(Stream.fail(incompleteStream()))
    yield* s.llm.push(TestLLM.text("Recovered", "incomplete-stream-success"))

    const scheduled = yield* subscribeRetries(s)
    const run = yield* s.resume.pipe(Effect.forkChild)
    yield* Queue.take(scheduled)
    yield* TestClock.adjust("2400 millis")
    yield* Fiber.join(run)

    expect(s.requests).toHaveLength(2)
    expect(yield* s.context).toMatchObject([
      { type: "user" },
      Expected.assistant({ finish: "stop" }, [Expected.text("Recovered")]),
    ])
  })

  scenario("retries an unknown finish before output", function* (s) {
    yield* s.admit("Retry unknown finish")
    yield* s.llm.push([
      LLMEvent.stepStart({ index: 0 }),
      LLMEvent.stepFinish({ index: 0, reason: { normalized: "unknown" } }),
      LLMEvent.finish({ reason: { normalized: "unknown" } }),
    ])
    yield* s.llm.push(TestLLM.text("Recovered", "unknown-finish-success"))

    const scheduled = yield* subscribeRetries(s)
    const run = yield* s.resume.pipe(Effect.forkChild)
    yield* Queue.take(scheduled)
    yield* TestClock.adjust("2400 millis")
    yield* Fiber.join(run)

    expect(s.requests).toHaveLength(2)
    expect(yield* recordedEventTypes(sessionID)).toContain("session.retry.scheduled.1")
    expect(yield* s.context).toMatchObject([
      { type: "user" },
      Expected.assistant({ finish: "stop" }, [Expected.text("Recovered")]),
    ])
  })

  scenario("uses a larger provider retry-after delay", function* (s) {
    yield* s.admit("Retry rate limit")
    yield* s.llm.push(Stream.fail(rateLimited(5_000)))
    yield* s.llm.push(TestLLM.text("Recovered", "retry-after-success"))

    const scheduled = yield* subscribeRetries(s)
    const run = yield* s.resume.pipe(Effect.forkChild)
    yield* Queue.take(scheduled)
    yield* TestClock.adjust("4999 millis")
    expect(s.requests).toHaveLength(1)
    yield* TestClock.adjust("1 millis")
    yield* Fiber.join(run)
    expect(s.requests).toHaveLength(2)
  })

  scenario("caps an excessive provider retry-after delay at fifteen minutes", function* (s) {
    yield* s.admit("Retry capped rate limit")
    yield* s.llm.push(Stream.fail(rateLimited(3_600_000)))
    yield* s.llm.push(TestLLM.text("Recovered", "retry-cap-success"))

    const scheduled = yield* subscribeRetries(s)
    const run = yield* s.resume.pipe(Effect.forkChild)
    yield* Queue.take(scheduled)
    yield* TestClock.adjust("899999 millis")
    expect(s.requests).toHaveLength(1)
    yield* TestClock.adjust("1 millis")
    yield* Fiber.join(run)
    expect(s.requests).toHaveLength(2)
  })

  scenario("continues an incomplete stream after observable text", function* (s) {
    const failure = incompleteStream()
    yield* s.admit("Continue partial output")
    yield* s.llm.push(
      TestLLM.failAfter(
        failure,
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.textStart({ id: "partial-rate-limit" }),
        LLMEvent.textDelta({ id: "partial-rate-limit", text: "Partial" }),
      ),
    )
    yield* s.llm.push(TestLLM.text(" continuation", "continued-text"))

    const scheduled = yield* subscribeRetries(s)
    const run = yield* s.resume.pipe(Effect.forkChild)
    yield* Queue.take(scheduled)
    yield* TestClock.adjust("2400 millis")
    yield* Fiber.join(run)

    expect(s.requests).toHaveLength(2)
    expect(s.requests[1]?.messages.at(-2)).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "Partial" }],
    })
    expect(s.requests[1]?.messages.at(-1)).toMatchObject({
      role: "user",
      content: [
        {
          type: "text",
          text: INCOMPLETE_STREAM_CONTINUATION,
        },
      ],
    })
    const context = yield* s.context
    expect(context).toMatchObject([
      Expected.user("Continue partial output"),
      Expected.assistant({ finish: "error", error: { type: "provider.invalid-output" } }, [Expected.text("Partial")]),
      {
        type: "synthetic",
        text: INCOMPLETE_STREAM_CONTINUATION,
      },
      Expected.assistant({ finish: "stop" }, [Expected.text(" continuation")]),
    ])
    const assistants = context.filter((message) => message.type === "assistant")
    expect(new Set(assistants.map((message) => message.id)).size).toBe(2)
    expect(context.find((message) => message.type === "synthetic")?.description).toBeUndefined()
    expect(yield* recordedEventTypes(sessionID)).toContain("session.retry.scheduled.1")
    yield* replaySessionProjection(sessionID)
    expect(yield* s.context).toMatchObject(context)
  })

  scenario("continues an unknown finish after observable text", function* (s) {
    yield* s.admit("Continue unknown finish")
    yield* s.llm.push([
      LLMEvent.stepStart({ index: 0 }),
      LLMEvent.textStart({ id: "unknown-partial" }),
      LLMEvent.textDelta({ id: "unknown-partial", text: "Partial" }),
      LLMEvent.textEnd({ id: "unknown-partial" }),
      LLMEvent.stepFinish({ index: 0, reason: { normalized: "unknown" } }),
      LLMEvent.finish({ reason: { normalized: "unknown" } }),
    ])
    yield* s.llm.push(TestLLM.text(" continuation", "unknown-continuation"))

    const scheduled = yield* subscribeRetries(s)
    const run = yield* s.resume.pipe(Effect.forkChild)
    yield* Queue.take(scheduled)
    yield* TestClock.adjust("2400 millis")
    yield* Fiber.join(run)

    expect(s.requests).toHaveLength(2)
    expect(s.requests[1]?.messages.at(-1)).toMatchObject({
      role: "user",
      content: [{ type: "text", text: INCOMPLETE_STREAM_CONTINUATION }],
    })
    expect(yield* s.context).toMatchObject([
      { type: "user" },
      Expected.assistant({ finish: "error" }, [Expected.text("Partial")]),
      { type: "synthetic", text: INCOMPLETE_STREAM_CONTINUATION },
      Expected.assistant({ finish: "stop" }, [Expected.text(" continuation")]),
    ])
  })

  scenario("continues after a mid-stream rate limit honoring retry-after", function* (s) {
    yield* s.admit("Continue after rate limit")
    yield* s.llm.push(
      TestLLM.failAfter(
        rateLimited(5_000),
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.textStart({ id: "rate-limited-partial" }),
        LLMEvent.textDelta({ id: "rate-limited-partial", text: "Partial" }),
      ),
    )
    yield* s.llm.push(TestLLM.text(" continuation", "rate-limit-continuation"))

    const scheduled = yield* subscribeRetries(s)
    const run = yield* s.resume.pipe(Effect.forkChild)
    yield* Queue.take(scheduled)
    yield* TestClock.adjust("4999 millis")
    expect(s.requests).toHaveLength(1)
    yield* TestClock.adjust("1 millis")
    yield* Fiber.join(run)

    expect(s.requests).toHaveLength(2)
    expect(s.requests[1]?.messages.at(-2)).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "Partial" }],
    })
    expect(s.requests[1]?.messages.at(-1)).toMatchObject({
      role: "user",
      content: [{ type: "text", text: INCOMPLETE_STREAM_CONTINUATION }],
    })
    expect(yield* recordedEventTypes(sessionID)).toContain("session.retry.scheduled.1")
    expect(yield* s.context).toMatchObject([
      Expected.user("Continue after rate limit"),
      Expected.assistant({ finish: "error", error: { type: "provider.rate-limit" } }, [Expected.text("Partial")]),
      { type: "synthetic", text: INCOMPLETE_STREAM_CONTINUATION },
      Expected.assistant({ finish: "stop" }, [Expected.text(" continuation")]),
    ])
  })

  scenario("continues after an unrecognized mid-stream provider failure", function* (s) {
    const failure = new AIError({ reason: new UnknownProviderError({ message: "Provider returned error" }) })
    yield* s.admit("Continue after unknown failure")
    yield* s.llm.push(
      TestLLM.failAfter(
        failure,
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.textStart({ id: "unknown-failure-partial" }),
        LLMEvent.textDelta({ id: "unknown-failure-partial", text: "Partial" }),
      ),
    )
    yield* s.llm.push(TestLLM.text(" continuation", "unknown-failure-continuation"))

    const scheduled = yield* subscribeRetries(s)
    const run = yield* s.resume.pipe(Effect.forkChild)
    yield* Queue.take(scheduled)
    yield* TestClock.adjust("2400 millis")
    yield* Fiber.join(run)

    expect(s.requests).toHaveLength(2)
    expect(s.requests[1]?.messages.at(-1)).toMatchObject({
      role: "user",
      content: [{ type: "text", text: INCOMPLETE_STREAM_CONTINUATION }],
    })
    expect(yield* s.context).toMatchObject([
      Expected.user("Continue after unknown failure"),
      Expected.assistant({ finish: "error", error: { type: "provider.unknown" } }, [Expected.text("Partial")]),
      { type: "synthetic", text: INCOMPLETE_STREAM_CONTINUATION },
      Expected.assistant({ finish: "stop" }, [Expected.text(" continuation")]),
    ])
  })

  scenario("lowers interrupted reasoning before continuing an incomplete stream", function* (s) {
    yield* s.admit("Continue interrupted reasoning")
    yield* s.llm.push(
      TestLLM.failAfter(
        incompleteStream(),
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.reasoningStart({ id: "partial-reasoning" }),
        LLMEvent.reasoningDelta({ id: "partial-reasoning", text: "Partial thought" }),
      ),
    )
    yield* s.llm.push(TestLLM.text("Recovered", "reasoning-recovery"))

    const scheduled = yield* subscribeRetries(s)
    const run = yield* s.resume.pipe(Effect.forkChild)
    yield* Queue.take(scheduled)
    yield* TestClock.adjust("2400 millis")
    yield* Fiber.join(run)

    expect(s.requests[1]?.messages.at(-2)).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "Partial thought" }],
    })
    expect(s.requests[1]?.messages.at(-1)).toMatchObject({
      role: "user",
      content: [
        {
          type: "text",
          text: INCOMPLETE_STREAM_CONTINUATION,
        },
      ],
    })
    expect(yield* s.context).toMatchObject([
      { type: "user" },
      Expected.assistant({ finish: "error" }, [Expected.reasoning("Partial thought")]),
      { type: "synthetic" },
      Expected.assistant({ finish: "stop" }, [Expected.text("Recovered")]),
    ])
  })

  scenario("continues after a transport read failure with durable reasoning state", function* (s) {
    yield* s.admit("Recover disconnected reasoning")
    yield* s.llm.push(
      TestLLM.failAfter(
        streamDisconnected(),
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.reasoningStart({
          id: "disconnected-reasoning",
          providerMetadata: {
            openai: { itemId: "rs_disconnected", reasoningEncryptedContent: "encrypted-state" },
          },
        }),
      ),
    )
    yield* s.llm.push(TestLLM.text("Recovered", "reasoning-transport-recovery"))

    const scheduled = yield* subscribeRetries(s)
    const run = yield* s.resume.pipe(Effect.forkChild)
    yield* Queue.take(scheduled)
    yield* TestClock.adjust("2400 millis")
    yield* Fiber.join(run)

    expect(s.requests).toHaveLength(2)
    expect(yield* recordedEventTypes(sessionID)).toContain("session.retry.scheduled.1")
    expect(s.requests[1]?.messages.slice(-2)).toMatchObject([
      { role: "user", content: [{ type: "text", text: "Recover disconnected reasoning" }] },
      { role: "user", content: [{ type: "text", text: INCOMPLETE_STREAM_CONTINUATION }] },
    ])
    expect(yield* s.context).toMatchObject([
      { type: "user" },
      Expected.assistant({ finish: "error" }, [
        {
          type: "reasoning",
          text: "",
          state: { itemId: "rs_disconnected", reasoningEncryptedContent: "encrypted-state" },
        },
      ]),
      { type: "synthetic", text: INCOMPLETE_STREAM_CONTINUATION },
      Expected.assistant({ finish: "stop" }, [Expected.text("Recovered")]),
    ])
  })

  scenario("continues an incomplete stream after settling a local tool", function* (s) {
    yield* s.admit("Continue after tool")
    yield* s.llm.push(
      TestLLM.failAfter(
        incompleteStream(),
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolCall({ id: "call-before-close", name: "echo", input: { text: "settled" } }),
      ),
    )
    yield* s.llm.push(TestLLM.text("Recovered", "tool-recovery"))

    const scheduled = yield* subscribeRetries(s)
    const run = yield* s.resume.pipe(Effect.forkChild)
    yield* Queue.take(scheduled)
    yield* TestClock.adjust("2400 millis")
    yield* Fiber.join(run)

    expect(s.executions).toEqual(["settled"])
    expect(s.requests[1]?.messages.slice(-3)).toMatchObject([
      {
        role: "assistant",
        content: [{ type: "tool-call", id: "call-before-close", name: "echo", input: { text: "settled" } }],
      },
      { role: "tool", content: [{ type: "tool-result", id: "call-before-close" }] },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: INCOMPLETE_STREAM_CONTINUATION,
          },
        ],
      },
    ])
  })

  scenario("continues an incomplete stream after settling a local tool defect", function* (s) {
    yield* s.admit("Continue after tool defect")
    yield* s.llm.push(
      TestLLM.failAfter(
        incompleteStream(),
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolCall({ id: "call-defect-before-close", name: "defect", input: {} }),
      ),
    )
    yield* s.llm.push(TestLLM.text("Recovered", "tool-defect-recovery"))

    const scheduled = yield* subscribeRetries(s)
    const run = yield* s.resume.pipe(Effect.forkChild)
    yield* Queue.take(scheduled)
    yield* TestClock.adjust("2400 millis")
    yield* Fiber.join(run)

    expect(messageRoles(s.requests[1])).toEqual(["user", "assistant", "tool", "user"])
    expect(yield* s.context).toMatchObject([
      { type: "user" },
      Expected.assistant({}, [
        Expected.failedTool(
          { id: "call-defect-before-close" },
          { error: { type: "unknown", message: "unexpected tool defect" } },
        ),
      ]),
      { type: "synthetic", text: INCOMPLETE_STREAM_CONTINUATION },
      Expected.assistant({ finish: "stop" }, [Expected.text("Recovered")]),
    ])
  })

  scenario(
    "shares retry accounting and assistant identity across transparent retries and partial continuations",
    function* (s) {
      const scheduled = yield* subscribeRetries(s)
      yield* s.admit("Mix retry paths")
      const failure = incompleteStream()
      const partial = TestLLM.failAfter(
        failure,
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.textStart({ id: "mixed-partial" }),
        LLMEvent.textDelta({ id: "mixed-partial", text: "Partial" }),
      )
      yield* s.llm.push(Stream.fail(failure), partial, Stream.fail(failure), partial, partial)
      const run = yield* s.resume.pipe(Effect.forkChild)
      const identities: SessionMessage.ID[] = []
      for (const delay of [2_400, 4_800, 9_600, 19_200]) {
        identities.push(yield* Queue.take(scheduled))
        yield* TestClock.adjust(delay)
      }
      expect(yield* Fiber.join(run).pipe(Effect.flip)).toBe(failure)
      expect(s.requests).toHaveLength(5)
      expect(identities[0]).toBe(identities[1])
      expect(identities[2]).toBe(identities[3])
      expect(identities[0]).not.toBe(identities[2])
      const messages = yield* s.context
      expect(messages.filter((message) => message.type === "assistant")).toHaveLength(3)
      expect(messages.filter((message) => message.type === "synthetic")).toHaveLength(2)
      const events = yield* recordedEventTypes(sessionID)
      expect(events.filter((type) => type === "session.retry.scheduled.1")).toHaveLength(4)
      expect(events.filter((type) => type === "session.step.failed.1")).toHaveLength(3)
    },
  )

  scenario("stops incomplete stream continuations after five total attempts", function* (s) {
    yield* s.admit("Exhaust partial continuations")
    const failure = incompleteStream()
    yield* s.llm.always(
      TestLLM.failAfter(
        failure,
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.textStart({ id: "partial-exhaustion" }),
        LLMEvent.textDelta({ id: "partial-exhaustion", text: "Partial" }),
      ),
    )

    const scheduled = yield* subscribeRetries(s)
    const run = yield* s.resume.pipe(Effect.forkChild)
    for (const delay of [2_400, 4_800, 9_600, 19_200]) {
      yield* Queue.take(scheduled)
      yield* TestClock.adjust(delay)
    }
    expect(yield* Fiber.join(run).pipe(Effect.flip)).toBe(failure)
    expect(s.requests).toHaveLength(5)
    const context = yield* s.context
    expect(context.filter((message) => message.type === "assistant")).toHaveLength(5)
    expect(context.filter((message) => message.type === "synthetic")).toHaveLength(4)
  })

  scenario("stops after five total retry attempts", function* (s) {
    yield* s.admit("Exhaust retries")
    const failure = providerUnavailable()
    yield* s.llm.always(Stream.fail(failure))

    const scheduled = yield* subscribeRetries(s)
    const run = yield* s.resume.pipe(Effect.forkChild)
    for (const delay of [2_400, 4_800, 9_600, 19_200]) {
      yield* Queue.take(scheduled)
      yield* TestClock.adjust(delay)
    }
    expect(yield* Fiber.join(run).pipe(Effect.flip)).toBe(failure)
    expect(s.requests).toHaveLength(5)

    const retries = yield* s.db
      .select({ data: EventTable.data })
      .from(EventTable)
      .where(eq(EventTable.type, "session.retry.scheduled.1"))
      .orderBy(asc(EventTable.seq))
      .all()
      .pipe(Effect.orDie)
    for (const [index, range] of [
      [1_600, 2_400],
      [4_800, 7_200],
      [11_200, 16_800],
      [24_000, 36_000],
    ].entries()) {
      expect(retries[index]?.data.at).toBeGreaterThanOrEqual(range[0]!)
      expect(retries[index]?.data.at).toBeLessThanOrEqual(range[1]!)
    }
    expect((yield* recordedEventTypes(sessionID)).filter((type) => type === "session.step.started.1")).toHaveLength(5)
    const assistant = requireAssistant(yield* s.context)
    expect(yield* recordedStepSettlementEvents(sessionID, assistant.id)).toMatchObject([
      { type: "session.step.started.1" },
      { type: "session.step.started.1" },
      { type: "session.step.started.1" },
      { type: "session.step.started.1" },
      { type: "session.step.started.1" },
      { type: "session.step.failed.1" },
    ])
  })

  scenario("retries a model call without consuming the logical agent step", function* (s) {
    const agents = yield* Agent.Service
    yield* agents.transform((editor) =>
      editor.update(Agent.ID.make("build"), (agent) => {
        agent.steps = 2
      }),
    )
    yield* s.admit("Retry without consuming a step")
    const failure = providerUnavailable()
    yield* s.llm.push(Stream.fail(failure))
    yield* s.llm.push(TestLLM.tool("call-after-retry", "echo", { text: "recovered" }), TestLLM.stop())

    const scheduled = yield* subscribeRetries(s)
    const run = yield* s.resume.pipe(Effect.forkChild)
    yield* Queue.take(scheduled)
    yield* TestClock.adjust("2400 millis")
    yield* Fiber.join(run)

    expect(s.requests).toHaveLength(3)
    expect(s.requests[0]?.toolChoice).toBeUndefined()
    expect(s.requests[0]?.tools.map((tool) => tool.name)).toContain("echo")
    expect(s.requests[1]?.toolChoice).toBeUndefined()
    expect(s.requests[1]?.tools.map((tool) => tool.name)).toContain("echo")
    expect(s.requests[1]?.messages.at(-1)).not.toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: expect.stringContaining("MAXIMUM STEPS REACHED") }],
    })
    expect(s.requests[2]?.toolChoice).toMatchObject({ type: "none" })
    // The final step keeps tool definitions to preserve provider prompt caching.
    expect(s.requests[2]?.tools.map((tool) => tool.name)).toContain("echo")
    expect(s.requests[2]?.messages.at(-1)).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: expect.stringContaining("MAXIMUM STEPS REACHED") }],
    })
    expect(s.executions).toEqual(["recovered"])
    const eventTypes = yield* recordedEventTypes(sessionID)
    expect(eventTypes.filter((type) => type === "session.step.started.1")).toHaveLength(3)
    expect(eventTypes.filter((type) => type === "session.retry.scheduled.1")).toHaveLength(1)
    expect((yield* s.context).filter((message) => message.type === "assistant")).toHaveLength(2)
  })

  scenario("does not retry non-eligible provider failures", function* (s) {
    const failure = invalidRequest()
    yield* s.llm.push(Stream.fail(failure))

    expect(yield* s.runPrompt("Do not retry").pipe(Effect.flip)).toBe(failure)
    expect(s.requests).toHaveLength(1)
    expect(yield* recordedEventTypes(sessionID)).not.toContain("session.retry.scheduled.1")
  })

  scenario("settles malformed streamed tool input before the provider failure", function* (s) {
    const failure = new AIError({
      reason: new InvalidProviderOutputError({ message: "Invalid JSON input for tool call echo" }),
    })
    yield* s.llm.push(
      TestLLM.failAfter(
        failure,
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolInputStart({ id: "call-malformed", name: "echo" }),
        LLMEvent.toolInputDelta({ id: "call-malformed", name: "echo", text: '{"text":"partial' }),
      ),
    )

    expect(yield* s.runPrompt("Call a malformed tool").pipe(Effect.flip)).toBe(failure)
    const assistant = requireAssistant(yield* s.context)

    yield* s.llm.push(TestLLM.stop())
    yield* s.runPrompt("Continue")

    expect(yield* recordedStepSettlementEvents(sessionID, assistant.id)).toMatchObject([
      { type: "session.step.started.1" },
      {
        type: "session.tool.failed.2",
        data: {
          id: "call-malformed",
          error: { type: "provider.invalid-output", message: "Invalid JSON input for tool call echo" },
        },
      },
      {
        type: "session.step.failed.1",
        data: { error: { type: "provider.invalid-output", message: "Invalid JSON input for tool call echo" } },
      },
    ])
  })

  scenario("continues after malformed local tool input without exposing raw arguments", function* (s) {
    const marker = "raw-malformed-marker"
    const raw = `{"text":"${marker}`
    yield* s.llm.push(
      TestLLM.toolCalls(
        LLMEvent.toolInputStart({ id: "call-malformed", name: "echo" }),
        LLMEvent.toolInputDelta({ id: "call-malformed", name: "echo", text: raw }),
        LLMEvent.toolInputEnd({ id: "call-malformed", name: "echo" }),
        LLMEvent.toolInputError({
          id: "call-malformed",
          name: "echo",
          raw,
        }),
      ),
      TestLLM.stop(),
    )

    yield* s.runPrompt("Recover malformed tool input")

    expect(s.requests).toHaveLength(2)
    expect(s.executions).toEqual([])
    expect(JSON.stringify(s.requests[1])).not.toContain(marker)
    expect(s.requests[1]?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "assistant",
          content: expect.arrayContaining([
            expect.objectContaining({ type: "tool-call", id: "call-malformed", name: "echo", input: {} }),
          ]),
        }),
        expect.objectContaining({
          role: "tool",
          content: expect.arrayContaining([
            expect.objectContaining({
              type: "tool-result",
              id: "call-malformed",
              result: expect.objectContaining({
                type: "error",
                value: expect.objectContaining({
                  error: expect.objectContaining({
                    message: "Tool call arguments were malformed JSON and were not executed. Retry with valid JSON.",
                  }),
                }),
              }),
            }),
          ]),
        }),
      ]),
    )
    const context = yield* s.context
    const failed = context.find(
      (message): message is SessionMessage.Assistant =>
        message.type === "assistant" && message.content.some((item) => item.type === "tool"),
    )
    expect(failed).toMatchObject({
      content: [
        Expected.failedTool(
          { id: "call-malformed", executed: false },
          {
            input: {},
            error: {
              type: "tool.input-json",
              message: "Tool call arguments were malformed JSON and were not executed. Retry with valid JSON.",
            },
          },
        ),
      ],
    })
    if (!failed) throw new Error("Malformed tool assistant missing")
    expect(failed.error).toBeUndefined()
    expect(yield* recordedStepSettlementTypes(sessionID, failed.id)).toEqual([
      "session.step.started.1",
      "session.tool.failed.2",
      "session.step.ended.1",
    ])

    const durable = yield* s.db
      .select({ type: EventTable.type, data: EventTable.data })
      .from(EventTable)
      .where(eq(EventTable.aggregate_id, sessionID))
      .all()
      .pipe(Effect.orDie)
    expect(durable.find((event) => event.type === "session.tool.input.ended.1")?.data).toMatchObject({
      id: "call-malformed",
      text: raw,
    })
  })

  scenario("settles a valid sibling before recovering malformed tool input", function* (s) {
    yield* s.admit("Run parallel tools")
    const tools = yield* s.blockTools()
    yield* s.llm.push(
      TestLLM.toolCalls(
        LLMEvent.toolCall({ id: "call-valid", name: "echo", input: { text: "valid" } }),
        LLMEvent.toolInputError({
          id: "call-malformed",
          name: "echo",
          raw: '{"text":"partial',
        }),
      ),
      TestLLM.stop(),
    )

    const run = yield* s.resume.pipe(Effect.forkChild)
    yield* tools.started
    expect(s.requests).toHaveLength(1)
    yield* tools.release
    yield* Fiber.join(run)

    expect(s.requests).toHaveLength(2)
    expect(s.executions).toEqual(["valid"])
    const request = s.requests[1]
    if (!request) throw new Error("Malformed recovery request missing")
    expect(request.messages.flatMap((message) => (message.role === "tool" ? message.content : []))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "call-valid", type: "tool-result" }),
        expect.objectContaining({ id: "call-malformed", type: "tool-result" }),
      ]),
    )
  })

  scenario("does not recover malformed input after sibling execution is interrupted", function* (s) {
    yield* s.admit("Interrupt malformed recovery")
    const tools = yield* s.blockTools()
    yield* s.llm.push(
      TestLLM.toolCalls(
        LLMEvent.toolCall({ id: "call-valid", name: "echo", input: { text: "blocked" } }),
        LLMEvent.toolInputError({
          id: "call-malformed",
          name: "echo",
          raw: '{"text":"partial',
        }),
      ),
    )

    const run = yield* s.resume.pipe(Effect.forkChild)
    yield* tools.started
    while (
      !(yield* s.context).some(
        (message) =>
          message.type === "assistant" &&
          message.content.some((item) => item.type === "tool" && item.id === "call-malformed"),
      )
    )
      yield* Effect.yieldNow
    yield* s.session.interrupt(sessionID)

    expect(yield* Fiber.await(run)).toMatchObject({ _tag: "Failure" })
    expect(s.requests).toHaveLength(1)
    expect(yield* s.context).toMatchObject([
      Expected.user("Interrupt malformed recovery"),
      Expected.assistant({ error: { type: "aborted", message: "Step interrupted" } }, [
        Expected.failedTool({ id: "call-valid" }, { error: { type: "aborted" } }),
        Expected.failedTool({ id: "call-malformed" }, {}),
      ]),
    ])
  })

  scenario("records malformed provider-executed input as executed", function* (s) {
    const failure = new AIError({
      reason: new InvalidProviderOutputError({ message: "Invalid hosted tool input" }),
    })
    yield* s.llm.push(
      TestLLM.failAfter(
        failure,
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolInputStart({ id: "call-hosted", name: "web_search", providerExecuted: true }),
        LLMEvent.toolInputDelta({ id: "call-hosted", name: "web_search", text: '{"query":"partial' }),
      ),
    )

    expect(yield* s.runPrompt("Fail malformed hosted input").pipe(Effect.flip)).toBe(failure)
    expect(requireAssistant(yield* s.context)).toMatchObject({
      error: { type: "provider.invalid-output", message: "Invalid hosted tool input" },
      content: [
        Expected.failedTool({ id: "call-hosted", executed: true }, { error: { type: "provider.invalid-output" } }),
      ],
    })
  })

  scenario("records a provider failure after malformed input", function* (s) {
    const failure = new AIError({
      reason: new InvalidProviderOutputError({ message: "Provider failed after malformed input" }),
    })
    yield* s.llm.push(
      TestLLM.failAfter(
        failure,
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolInputError({
          id: "call-malformed",
          name: "echo",
          raw: '{"text":"partial',
        }),
      ),
    )

    expect(yield* s.runPrompt("Fail after malformed input").pipe(Effect.flip)).toBe(failure)
    expect(requireAssistant(yield* s.context)).toMatchObject({
      error: { type: "provider.invalid-output", message: "Provider failed after malformed input" },
      content: [Expected.failedTool({ id: "call-malformed", executed: false }, { error: { type: "tool.input-json" } })],
    })
    expect(s.requests).toHaveLength(1)
  })

  scenario("continues after repeated malformed tool input", function* (s) {
    const malformed = (id: string) =>
      TestLLM.toolCalls(
        LLMEvent.toolInputError({
          id,
          name: "echo",
          raw: '{"text":"partial',
        }),
      )
    yield* s.llm.push(
      malformed("call-first"),
      TestLLM.tool("call-valid-between", "echo", { text: "valid" }),
      malformed("call-second"),
      TestLLM.stop(),
    )

    yield* s.runPrompt("Keep producing malformed tools")

    expect(s.requests).toHaveLength(4)
    expect(s.executions).toEqual(["valid"])
    expect((yield* recordedEventTypes(sessionID)).filter((type) => type === "session.step.failed.1")).toHaveLength(0)
  })

  scenario("does not continue malformed tool input past the agent step limit", function* (s) {
    const agents = yield* Agent.Service
    yield* agents.transform((editor) =>
      editor.update(Agent.ID.make("build"), (agent) => {
        agent.steps = 2
      }),
    )
    const malformed = (id: string) =>
      TestLLM.toolCalls(
        LLMEvent.toolInputError({
          id,
          name: "echo",
          raw: '{"text":"partial',
        }),
      )
    yield* s.llm.push(malformed("call-first"), malformed("call-at-limit"))

    yield* s.runPrompt("Stop malformed tools at the step limit")

    expect(s.requests).toHaveLength(2)
    expect(s.requests[0]?.toolChoice).toBeUndefined()
    expect(s.requests[1]?.toolChoice).toMatchObject({ type: "none" })
    expect((yield* recordedEventTypes(sessionID)).filter((type) => type === "session.tool.failed.2")).toHaveLength(2)
  })

  scenario("does not continue automatically after a provider error follows a local tool call", function* (s) {
    yield* s.admit("Do not continue failed provider")
    const tools = yield* s.blockTools()
    yield* s.llm.push([
      LLMEvent.stepStart({ index: 0 }),
      LLMEvent.toolCall({ id: "call-before-provider-error", name: "echo", input: { text: "settled" } }),
      LLMEvent.providerError({ message: "Provider unavailable" }),
    ])

    const run = yield* s.resume.pipe(Effect.forkChild)
    yield* tools.started
    yield* tools.release
    expect((yield* Fiber.join(run).pipe(Effect.flip)).message).toBe("Provider unavailable")

    expect(s.requests).toHaveLength(1)
    expect(s.executions).toEqual(["settled"])
    const context = yield* s.context
    const assistant = requireAssistant(context)
    expect(yield* recordedStepSettlementTypes(sessionID, assistant.id)).toEqual([
      "session.step.started.1",
      "session.tool.called.1",
      "session.tool.success.2",
      "session.step.failed.1",
    ])
  })

  scenario("durably fails a hosted tool when its provider errors before returning a result", function* (s) {
    yield* s.llm.push([
      LLMEvent.stepStart({ index: 0 }),
      hostedCall("call-hosted-provider-error", "effect"),
      LLMEvent.providerError({ message: "Provider unavailable" }),
    ])

    expect((yield* s.runPrompt("Fail hosted tool durably").pipe(Effect.flip)).message).toBe("Provider unavailable")

    expect(s.requests).toHaveLength(1)
    const context = yield* s.context
    expect(context).toMatchObject([
      Expected.user("Fail hosted tool durably"),
      Expected.assistant({}, [Expected.failedTool({ id: "call-hosted-provider-error" }, {})]),
    ])
    const assistant = requireAssistant(context)
    expect(yield* recordedStepSettlementTypes(sessionID, assistant.id)).toEqual([
      "session.step.started.1",
      "session.tool.called.1",
      "session.tool.failed.2",
      "session.step.failed.1",
    ])
  })

  scenario("preserves a tool defect before provider failure settlement", function* (s) {
    yield* s.llm.push([
      LLMEvent.stepStart({ index: 0 }),
      LLMEvent.toolCall({ id: "call-defect-provider-error", name: "defect", input: {} }),
      LLMEvent.providerError({ message: "Provider unavailable" }),
    ])

    expect((yield* s.runPrompt("Defect while provider fails").pipe(Effect.flip)).message).toBe("Provider unavailable")

    const context = yield* s.context
    const assistant = requireAssistant(context)
    const events = yield* recordedStepSettlementEvents(sessionID, assistant.id)
    expect(events.map((event) => event.type)).toEqual([
      "session.step.started.1",
      "session.tool.called.1",
      "session.tool.failed.2",
      "session.step.failed.1",
    ])
    expect(events[2]?.data.error).toMatchObject({ type: "unknown", message: "unexpected tool defect" })
  })

  scenario("preserves the provider failure when tool output persistence also fails", function* (s) {
    let injected = false
    yield* s.bus.project(SessionEvent.Tool.Success, (event) => {
      if (event.data.id !== "call-store-provider-error") return Effect.void
      return Effect.sync(() => {
        injected = true
      }).pipe(Effect.andThen(Effect.die("tool output persistence failed")))
    })
    yield* s.admit("Storage fails while provider fails")
    yield* s.llm.push([
      LLMEvent.stepStart({ index: 0 }),
      LLMEvent.toolCall({ id: "call-store-provider-error", name: "storefail", input: {} }),
      LLMEvent.providerError({ message: "Provider unavailable" }),
    ])

    expect(yield* s.resume.pipe(Effect.exit)).toMatchObject({
      _tag: "Failure",
    })

    expect(injected).toBe(true)
    expect(requireAssistant(yield* s.context)).toMatchObject({
      error: { type: "provider.unknown", message: "Provider unavailable" },
    })
  })

  scenario("durably fails a hosted tool left unresolved at normal provider EOF", function* (s) {
    yield* s.llm.push([LLMEvent.stepStart({ index: 0 }), hostedCall("call-hosted-eof", "effect")])

    expect((yield* s.runPrompt("Fail hosted tool at EOF").pipe(Effect.flip)).message).toBe(
      "Provider did not return a tool result",
    )
    const assistant = requireAssistant(yield* s.context)
    const events = yield* recordedStepSettlementEvents(sessionID, assistant.id)
    expect(events.map((event) => event.type)).toEqual([
      "session.step.started.1",
      "session.tool.called.1",
      "session.tool.failed.2",
      "session.step.failed.1",
    ])
    expect(
      events.filter((event) => event.type.startsWith("session.step.") && event.type !== "session.step.started.1"),
    ).toHaveLength(1)
    yield* replaySessionProjection(sessionID)

    expect(yield* s.context).toMatchObject([
      Expected.user("Fail hosted tool at EOF"),
      Expected.assistant({ finish: "error", error: { type: "tool.result-missing" } }, [
        Expected.failedTool({ id: "call-hosted-eof" }, {}),
      ]),
    ])
  })

  scenario("fails an unresolved hosted tool before one clean step end", function* (s) {
    yield* s.llm.push(TestLLM.stop(hostedCall("call-hosted-clean-end", "effect")))

    yield* s.runPrompt("Settle hosted tool before ending")

    const assistant = requireAssistant(yield* s.context)
    const events = yield* recordedStepSettlementEvents(sessionID, assistant.id)
    expect(events.map((event) => event.type)).toEqual([
      "session.step.started.1",
      "session.tool.called.1",
      "session.tool.failed.2",
      "session.step.ended.1",
    ])
    expect(
      events.filter((event) => event.type.startsWith("session.step.") && event.type !== "session.step.started.1"),
    ).toHaveLength(1)
  })

  scenario("settles unresolved local and hosted tools before one raw provider failure", function* (s) {
    yield* s.admit("Fail unresolved tools")
    const failure = invalidRequest()
    const providerFailed = yield* Deferred.make<void>()
    const tools = yield* s.blockTools()
    yield* s.llm.push(
      Stream.concat(
        Stream.fromIterable([
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-local-raw-failure", name: "defect", input: {} }),
          hostedCall("call-hosted-raw-failure-pair", "effect"),
        ]),
        Stream.fromEffect(Deferred.succeed(providerFailed, undefined)).pipe(Stream.flatMap(() => Stream.fail(failure))),
      ),
    )

    const run = yield* s.resume.pipe(Effect.forkChild)
    yield* Deferred.await(providerFailed)
    yield* tools.release
    expect(yield* Fiber.join(run).pipe(Effect.flip)).toBe(failure)

    const assistant = requireAssistant(yield* s.context)
    const events = yield* recordedStepSettlementEvents(sessionID, assistant.id)
    expect(events.map((event) => ({ type: event.type, id: event.data.id }))).toEqual([
      { type: "session.step.started.1", id: undefined },
      { type: "session.tool.called.1", id: "call-local-raw-failure" },
      { type: "session.tool.called.1", id: "call-hosted-raw-failure-pair" },
      { type: "session.tool.failed.2", id: "call-local-raw-failure" },
      { type: "session.tool.failed.2", id: "call-hosted-raw-failure-pair" },
      { type: "session.step.failed.1", id: undefined },
    ])
    expect(
      events.filter((event) => event.type.startsWith("session.step.") && event.type !== "session.step.started.1"),
    ).toHaveLength(1)
  })

  scenario("durably fails a hosted tool left unresolved by a raw provider stream failure", function* (s) {
    // Non-retryable so the step settles terminally instead of continuing after tool output.
    const failure = invalidRequest()
    yield* s.llm.push(
      Stream.concat(
        Stream.fromIterable([LLMEvent.stepStart({ index: 0 }), hostedCall("call-hosted-raw-failure", "effect")]),
        Stream.fail(failure),
      ),
    )

    expect(yield* s.runPrompt("Fail hosted tool on raw failure").pipe(Effect.flip)).toBe(failure)
    expect(s.requests).toHaveLength(1)
    const assistant = requireAssistant(yield* s.context)
    const events = yield* recordedStepSettlementEvents(sessionID, assistant.id)
    expect(events.map((event) => event.type)).toEqual([
      "session.step.started.1",
      "session.tool.called.1",
      "session.tool.failed.2",
      "session.step.failed.1",
    ])
    expect(
      events.filter((event) => event.type.startsWith("session.step.") && event.type !== "session.step.started.1"),
    ).toHaveLength(1)
    yield* replaySessionProjection(sessionID)
    expect(yield* s.context).toMatchObject([
      Expected.user("Fail hosted tool on raw failure"),
      Expected.assistant({ finish: "error", error: { type: "provider.invalid-request", message: "Invalid request" } }, [
        Expected.failedTool({ id: "call-hosted-raw-failure" }, {}),
      ]),
    ])
  })

  scenario("rejects a second text start before the open fragment ends", function* (s) {
    yield* s.llm.push([
      LLMEvent.stepStart({ index: 0 }),
      LLMEvent.textStart({ id: "text-1" }),
      LLMEvent.textStart({ id: "text-2" }),
    ])

    const defect = yield* s.runPrompt("Two blocks").pipe(Effect.catchDefect(Effect.succeed))
    expect(defect).toBeInstanceOf(Error)
    if (!(defect instanceof Error)) return
    expect(defect.message).toBe("text start before end: text-2")
  })

  scenario("projects sequential text fragments as separate content parts", function* (s) {
    yield* s.llm.push(
      TestLLM.stop(
        LLMEvent.textStart({ id: "text-1" }),
        LLMEvent.textDelta({ id: "text-1", text: "First" }),
        LLMEvent.textEnd({ id: "text-1" }),
        LLMEvent.textStart({ id: "text-2" }),
        LLMEvent.textDelta({ id: "text-2", text: "Second" }),
        LLMEvent.textEnd({ id: "text-2" }),
      ),
    )

    yield* s.runPrompt("Two blocks")

    expect(yield* s.context).toMatchObject([
      Expected.user("Two blocks"),
      Expected.assistant({}, [Expected.text("First"), Expected.text("Second")]),
    ])
  })

  scenario("broadcasts pending text while the provider stream is paused", function* (s) {
    const paused = yield* Deferred.make<void>()
    yield* s.admit("Check before running a command")
    yield* s.llm.push(
      Stream.concat(
        Stream.fromIterable([
          LLMEvent.textStart({ id: "text" }),
          LLMEvent.textDelta({ id: "text", text: "Checking the project." }),
        ]),
        Stream.fromEffect(Deferred.succeed(paused, undefined)).pipe(Stream.flatMap(() => Stream.never)),
      ),
    )
    const deltas = yield* s.bus
      .subscribe(SessionEvent.Text.Delta)
      .pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped({ startImmediately: true }))
    const running = yield* s.resume.pipe(Effect.forkScoped)
    yield* Deferred.await(paused)
    yield* TestClock.adjust("100 millis")
    expect(deltas.pollUnsafe()).toBeDefined()
    expect(Array.from(yield* Fiber.join(deltas)).map((event) => event.data.delta)).toEqual(["Checking the project."])
    yield* Fiber.interrupt(running)
  })

  for (const kind of fragmentKinds) {
    scenario(
      kind === "tool input"
        ? "does not broadcast provider tool input deltas"
        : `batches provider ${kind} deltas without storing projection rewrites`,
      (s) => verifyEphemeralDeltas(s, kind),
    )

    scenario(`durably closes partial ${kind} when the provider stream fails`, (s) =>
      verifyPartialFlushOnFailure(s, kind),
    )

    scenario(`durably closes partial ${kind} when the provider stream is interrupted`, (s) =>
      verifyPartialFlushOnInterruption(s, kind),
    )
  }

  scenario("rejects duplicate streamed text starts", function* (s) {
    yield* s.llm.push([LLMEvent.textStart({ id: "text-1" }), LLMEvent.textStart({ id: "text-1" })])

    const defect = yield* s.resume.pipe(Effect.catchDefect(Effect.succeed))
    expect(defect).toBeInstanceOf(Error)
    if (!(defect instanceof Error)) return
    expect(defect.message).toBe("Duplicate text start: text-1")
  })

  scenario("transitions streamed raw tool input to parsed called input", function* (s) {
    yield* s.llm.push(
      TestLLM.stop(
        LLMEvent.toolInputStart({ id: "call-parsed", name: "web_search" }),
        LLMEvent.toolInputDelta({ id: "call-parsed", name: "web_search", text: '{"query":"hello"}' }),
        LLMEvent.toolInputEnd({ id: "call-parsed", name: "web_search" }),
        hostedCall("call-parsed", "hello"),
      ),
    )

    yield* s.runPrompt("Call provider tool")

    expect(yield* s.context).toMatchObject([
      Expected.user("Call provider tool"),
      Expected.assistant({}, [Expected.failedTool({ id: "call-parsed" }, { input: { query: "hello" } })]),
    ])
  })

  scenario("rejects malformed streamed tool input ordering", function* (s) {
    yield* s.llm.push([LLMEvent.toolInputDelta({ id: "call-1", name: "read", text: "{}" })])

    const defect = yield* s.resume.pipe(Effect.catchDefect(Effect.succeed))
    expect(defect).toBeInstanceOf(Error)
    if (!(defect instanceof Error)) return
    expect(defect.message).toBe("Tool input delta before start: call-1")
  })
})
