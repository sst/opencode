import { expect, test } from "bun:test"
import { LLMClient, LLMEvent, LanguageModel, ToolDefinition, type LLMRequest } from "@opencode/ai"
import { OpenAIChat } from "@opencode/ai/protocols"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { llmClient } from "@opencode/core/effect/app-node-platform"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Bus } from "@opencode/core/bus"
import { EventTable } from "@opencode/core/event/sql"
import { SessionCompaction } from "@opencode/core/session/compaction"
import { SessionEvent } from "@opencode/core/session/event"
import { SessionMessage } from "@opencode/core/session/message"
import { SessionModelRequest } from "@opencode/core/session/model-request"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { SessionProjector } from "@opencode/core/session/projector"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { SessionTable } from "@opencode/core/session/sql"
import { SessionStore } from "@opencode/core/session/store"
import { Session } from "@opencode/core/session"
import { Project } from "@opencode/core/project"
import { ProjectTable } from "@opencode/core/project/sql"
import { App } from "@opencode/core/app"
import { Agent } from "@opencode/core/agent"
import { Model } from "@opencode/core/model"
import { Provider } from "@opencode/core/provider"
import { Location } from "@opencode/core/location"
import { AbsolutePath } from "@opencode/core/schema"
import { Money } from "@opencode/schema/money"
import { Skill } from "@opencode/schema/skill"
import { Shell } from "@opencode/schema/shell"
import { DateTime, Effect, Fiber, Layer, Schema, Stream } from "effect"
import { asc, eq } from "drizzle-orm"
import { testEffect } from "./lib/effect"

let requests: LLMRequest[] = []
const model = LanguageModel.make({
  id: "summary-model",
  provider: "test",
  route: OpenAIChat.route,
})
const cost = [
  {
    input: Money.USDPerMillionTokens.make(1),
    output: Money.USDPerMillionTokens.make(2),
    cache: {
      read: Money.USDPerMillionTokens.make(0.1),
      write: Money.USDPerMillionTokens.make(0.5),
    },
  },
]
const client = Layer.mock(LLMClient.Service)({
  stream: (request: LLMRequest) => {
    requests.push(request)
    return Stream.make(
      LLMEvent.textDelta({ id: "summary", text: "## Objective\n- manual summary" }),
      LLMEvent.stepFinish({
        index: 0,
        reason: { normalized: "stop" },
        usage: {
          inputTokens: 15,
          outputTokens: 6,
          nonCachedInputTokens: 10,
          cacheReadInputTokens: 3,
          cacheWriteInputTokens: 2,
          reasoningTokens: 2,
        },
      }),
      LLMEvent.finish({
        reason: { normalized: "stop" },
      }),
    )
  },
  generate: () => Effect.die("unused"),
})
const resolved = SessionRunnerModel.resolved(model, {
  capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
  cost,
  limit: { context: 200_000, output: 32_000 },
})
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      Bus.node,
      SessionProjector.node,
      SessionStore.node,
      SessionCompaction.node,
      SessionModelRequest.node,
      PluginHooks.node,
    ]),
    [Bus.node.replace(Bus.configured({ persist: true })), llmClient.replace(client)],
  ),
)

test("compaction prompt preserves detailed work state and relevant files", () => {
  const prompt = SessionCompaction.buildPrompt(false)

  expect(prompt).toContain("## Work State")
  expect(prompt).toContain("### Completed")
  expect(prompt).toContain("### Active")
  expect(prompt).toContain("### Blocked")
  expect(prompt).toContain("## Relevant Files")
})

test("compaction describes tool media without embedding base64", () => {
  const base64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB"
  const serialized = SessionCompaction.serializeToolContent([
    { type: "text", text: "Image read successfully" },
    {
      type: "file",
      uri: `data:image/png;base64,${base64}`,
      mime: "image/png",
      name: "pixel.png",
    },
  ])

  expect(serialized).toBe("Image read successfully\n[Attached image/png: pixel.png]")
  expect(serialized).not.toContain(base64)
})

test("compaction truncation does not split surrogate pairs", () => {
  const prefix = "a".repeat(1_999)

  expect(SessionCompaction.truncateToolOutput(`${prefix}😀suffix`)).toBe(`${prefix}😀\n[truncated]`)
  expect(SessionCompaction.truncateToolOutput("😀".repeat(2_000))).toBe("😀".repeat(2_000))
})

test("compaction prompt requires the checkpoint headings in order", () => {
  const prompt = SessionCompaction.buildPrompt(false)
  expect(prompt.match(/^#{2,3} .+$/gm)).toEqual([
    "## Objective",
    "## Requirements",
    "## Decisions",
    "## Work State",
    "### Completed",
    "### Active",
    "### Blocked",
    "## Next Move",
    "## Relevant Files",
    "## Important Context",
  ])
})

test("compaction update prompt rewrites legacy checkpoints only when asked", () => {
  const rewrite = "The existing checkpoint was written with an earlier format"
  expect(SessionCompaction.buildPrompt(true, true)).toContain(rewrite)
  expect(SessionCompaction.buildPrompt(true)).not.toContain(rewrite)
  expect(SessionCompaction.buildPrompt(false, true)).not.toContain(rewrite)
})

test("compaction prompts prohibit task execution", () => {
  for (const update of [false, true])
    expect(SessionCompaction.buildPrompt(update)).toContain("Do not continue the task or call tools")
})

it.effect("auto compaction estimates current content against the buffered prompt ceiling", () =>
  Effect.gen(function* () {
    const compaction = yield* SessionCompaction.Service
    const session = Session.Info.make({
      id: Session.ID.make("ses_input_limit"),
      projectID: Project.ID.global,
      cost: Money.USD.zero,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
      location: Location.Ref.make({ directory: AbsolutePath.make("/tmp") }),
    })
    const input = (tokens: number, limit: { context: number; input?: number; output: number }) => {
      const resolved = SessionRunnerModel.resolved(model, {
        capabilities: { tools: true, input: ["text", "image", "pdf"], output: ["text"] },
        cost: [],
        limit,
      })
      const messages = [
        Schema.decodeUnknownSync(SessionMessage.Assistant)({
          id: SessionMessage.ID.make("msg_assistant"),
          type: "assistant",
          agent: Agent.defaultID,
          model: { id: "test-model", providerID: "test-provider" },
          content: [{ type: "text", text: "Done" }],
          tokens: { input: tokens, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 0, completed: 0 },
        }),
      ]
      return {
        session,
        resolved,
        messages,
        context: {
          session,
          model: resolved,
          messages,
          agent: {
            id: Agent.defaultID,
            info: { ...Agent.Info.default(Agent.defaultID), system: "You are a helpful assistant." },
          },
          initial: "Project instructions.",
          tools: {
            definitions: [
              ToolDefinition.make({ name: "read", description: "Read files", inputSchema: { type: "object" } }),
            ],
            execute: () => Effect.die("unused"),
          },
        },
      }
    }

    const inputLimited = { context: 400_000, input: 272_000, output: 128_000 }
    expect(compaction.required(input(251_999, inputLimited))).toBe(false)
    expect(compaction.required(input(252_000, inputLimited))).toBe(true)
    const native = (
      tokens: number,
      limit: { context: number; input?: number; output: number } = inputLimited,
      threshold?: number,
    ) => {
      const selected = input(tokens, limit)
      return { ...selected, resolved: { ...selected.resolved, compaction: { mode: "provider" as const, threshold } } }
    }
    expect(compaction.required(native(251_999))).toBe(false)
    expect(compaction.required(native(252_000))).toBe(true)
    expect(compaction.required(native(99_999, inputLimited, 100_000))).toBe(false)
    expect(compaction.required(native(100_000, inputLimited, 100_000))).toBe(true)
    expect(compaction.required(native(252_000, inputLimited, 500_000))).toBe(true)
    expect(compaction.required(native(1_000_000, { context: 0, input: undefined, output: 0 }, 100_000))).toBe(false)

    const contextLimited = { context: 100_000, output: 10_000 }
    expect(compaction.required(input(79_999, contextLimited))).toBe(false)
    expect(compaction.required(input(80_000, contextLimited))).toBe(true)

    const outputLimited = { context: 100_000, output: 30_000 }
    expect(compaction.required(input(69_999, outputLimited))).toBe(false)
    expect(compaction.required(input(70_000, outputLimited))).toBe(true)

    const assistant = input(79_000, contextLimited).messages[0]
    const tool = SessionMessage.AssistantTool.make({
      type: "tool",
      id: "call_read",
      name: "read",
      state: { status: "completed", input: {}, content: [{ type: "text", text: "x".repeat(4_000) }] },
      time: { created: DateTime.makeUnsafe(0) },
    })
    const grown = { ...input(79_000, contextLimited), messages: [{ ...assistant, content: [tool] }] }
    expect(SessionCompaction.estimateTokens(grown)).toBe(80_000)
    expect(compaction.required(grown)).toBe(true)

    const interrupted = { ...assistant, id: SessionMessage.ID.create(), tokens: undefined }
    expect(SessionCompaction.estimateTokens({ ...grown, messages: [...grown.messages, interrupted] })).toBe(80_001)
    // Without provider usage, include 20 tokens for the system prompt, instructions, and tool definition.
    expect(SessionCompaction.estimateTokens({ ...grown, messages: [interrupted] })).toBe(21)
    expect(
      SessionCompaction.estimateTokens({
        ...grown,
        messages: [{ ...interrupted, tokens: input(0, contextLimited).messages[0].tokens }],
      }),
    ).toBe(21)

    const media = [
      { type: "file", mime: "image/png", uri: `data:image/png;base64,${"a".repeat(100_000)}` },
      { type: "file", mime: "application/pdf", uri: `data:application/pdf;base64,${"a".repeat(100_000)}` },
    ] as const
    const messages = [
      { ...assistant, content: [{ ...tool, state: { status: "completed" as const, input: {}, content: media } }] },
    ]
    expect(SessionCompaction.estimateTokens({ ...grown, messages })).toBe(82_500)
    const user = Schema.decodeUnknownSync(SessionMessage.User)({
      id: SessionMessage.ID.create(),
      type: "user",
      text: "",
      files: media.map((file) => ({ mime: file.mime, data: "a".repeat(100_000), source: { type: "inline" } })),
      time: { created: 0 },
    })
    expect(SessionCompaction.estimateTokens({ ...grown, messages: [...messages, user] })).toBe(86_000)
    for (const [modalities, tokens, fallback] of [
      [["text", "image"], 82_040, 1_520],
      [["text", "pdf"], 83_042, 2_021],
      [["text"], 79_082, 41],
    ] as const) {
      const selected = {
        ...grown,
        resolved: { ...grown.resolved, capabilities: { ...grown.resolved.capabilities, input: modalities } },
      }
      expect(SessionCompaction.estimateTokens({ ...selected, messages: [...messages, user] })).toBe(tokens)
      expect(SessionCompaction.estimateTokens({ ...selected, messages: [user] })).toBe(fallback + 20)
    }

    const checkpoint = Schema.decodeUnknownSync(SessionMessage.CompactionCompleted)({
      id: SessionMessage.ID.create(),
      type: "compaction",
      status: "completed",
      reason: "auto",
      summary: "x".repeat(400_000),
      recent: "",
      time: { created: 0, completed: 0 },
    })
    expect(compaction.required({ ...grown, messages: [checkpoint] })).toBe(false)
  }),
)

/** Seeds the global project plus one session row, returning the projected session. */
const insertSession = (id: Session.ID, overrides?: Partial<typeof SessionTable.$inferInsert>) =>
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id,
        project_id: Project.ID.global,
        slug: id,
        directory: "/project",
        title: id,
        version: "test",
        ...overrides,
      })
      .run()
      .pipe(Effect.orDie)
    const store = yield* SessionStore.Service
    return yield* store
      .get(id)
      .pipe(Effect.flatMap((session) => (session ? Effect.succeed(session) : Effect.die(`session missing: ${id}`))))
  })

const loaded = (session: Session.Info, messages: readonly SessionMessage.Info[]) => ({
  session,
  messages,
  model: resolved,
  agent: { id: Agent.defaultID, info: Agent.Info.default(Agent.defaultID) },
  initial: "Session instructions",
  instructionUpdate: "",
  tools: { definitions: [], execute: () => Effect.die("Compaction must not execute tools") },
})

it.effect("manual compaction summarizes short context instead of no-op", () =>
  Effect.gen(function* () {
    requests = []
    const db = (yield* Database.Service).db
    const compaction = yield* SessionCompaction.Service
    const bus = yield* Bus.Service
    const store = yield* SessionStore.Service
    const sessionID = Session.ID.make("ses_manual_compaction")
    const parentID = Session.ID.make("ses_manual_compaction_parent")
    const userMessage = {
      id: SessionMessage.ID.create(),
      type: "user" as const,
      text: "Manual compaction should include this short conversation.",
      skills: [
        {
          id: Skill.ID.make("effect"),
          name: Skill.Name.make("Effect"),
          text: "Use Effect services and generators.",
        },
      ],
      time: { created: DateTime.makeUnsafe(0) },
    }
    const session = yield* insertSession(sessionID, { parent_id: parentID })
    const modelRequests = yield* SessionModelRequest.Service
    const hooks = yield* PluginHooks.Service
    let hooked = 0
    yield* hooks.register("session", "compaction", (event) =>
      Effect.sync(() => {
        hooked = event.messages.length
        expect(JSON.stringify(event.messages)).not.toContain("Summarize only what")
      }),
    )
    const messages = [
      userMessage,
      SessionMessage.Shell.make({
        id: SessionMessage.ID.create(),
        type: "shell",
        shellID: Shell.ID.make("sh_background"),
        status: "exited",
        command: "pwd",
        metadata: { background: true },
        output: { output: "display-only-output", cursor: 19, size: 19, truncated: false },
        time: { created: DateTime.makeUnsafe(0), completed: DateTime.makeUnsafe(1) },
      }),
      SessionMessage.Synthetic.make({
        id: SessionMessage.ID.create(),
        type: "synthetic",
        text: "User shell pwd completed: /project",
        time: { created: DateTime.makeUnsafe(2) },
      }),
    ]

    const delta = yield* bus
      .subscribe(SessionEvent.Compaction.Delta)
      .pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
    yield* Effect.yieldNow
    expect(
      yield* compaction.compactManual({
        session,
        resolveContext: () => Effect.succeed(loaded(session, messages)),
        prepare: modelRequests.compaction,
        messages,
        inputID: SessionMessage.ID.make("msg_manual_compaction"),
      }),
    ).toEqual({ status: "completed" })
    expect(Array.from(yield* Fiber.join(delta)).map((event) => event.data.text)).toEqual([
      "## Objective\n- manual summary",
    ])

    expect(requests).toHaveLength(1)
    expect(requests[0]?.promptCacheKey).toBe(sessionID)
    expect(requests[0]?.http?.headers).toEqual({
      "x-session-affinity": sessionID,
      "X-Session-Id": sessionID,
      "x-parent-session-id": parentID,
      "User-Agent": App.useragent(App.make()),
      "x-opencode-project": Project.ID.global,
      "x-opencode-session": sessionID,
      "x-opencode-client": "opencode",
    })
    expect(requests[0]?.generation).toBeUndefined()
    expect(JSON.stringify(requests[0]?.messages)).toContain("Manual compaction should include this short conversation.")
    expect(JSON.stringify(requests[0]?.messages)).toContain("Use Effect services and generators.")
    expect(JSON.stringify(requests[0]?.messages)).toContain("User shell pwd completed: /project")
    expect(requests[0]?.messages).toHaveLength(hooked + 1)
    expect(JSON.stringify(requests[0]?.messages.at(-1))).toContain("Summarize only what")
    expect(JSON.stringify(requests[0]?.messages)).not.toContain("display-only-output")
    // The compaction message carries its own request usage so clients can show what compacting cost.
    expect(yield* store.context(sessionID)).toMatchObject([
      {
        type: "compaction",
        reason: "manual",
        summary: "## Objective\n- manual summary",
        recent: "",
        cost: 0.0000233,
        tokens: { input: 10, output: 4, reasoning: 2, cache: { read: 3, write: 2 } },
      },
    ])
    expect(yield* store.get(sessionID)).toMatchObject({
      cost: 0.0000233,
      tokens: { input: 10, output: 4, reasoning: 2, cache: { read: 3, write: 2 } },
    })
    expect(
      yield* db
        .select({ type: EventTable.type })
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, sessionID))
        .orderBy(asc(EventTable.seq))
        .all()
        .pipe(Effect.orDie),
    ).toEqual([
      { type: Bus.versionedType(SessionEvent.Compaction.Started.type, 1) },
      { type: Bus.versionedType(SessionEvent.UsageRecorded.type, 1) },
      { type: Bus.versionedType(SessionEvent.Compaction.Ended.type, 1) },
    ])
  }),
)

it.effect("compaction hooks can supply the summary instead of the model", () =>
  Effect.gen(function* () {
    requests = []
    const db = (yield* Database.Service).db
    const compaction = yield* SessionCompaction.Service
    const hooks = yield* PluginHooks.Service
    const store = yield* SessionStore.Service
    const sessionID = Session.ID.make("ses_hooked_compaction")
    const session = yield* insertSession(sessionID)
    const modelRequests = yield* SessionModelRequest.Service
    const messages = [
      {
        id: SessionMessage.ID.create(),
        type: "user" as const,
        text: "Hooked compaction should see this conversation.",
        time: { created: DateTime.makeUnsafe(0) },
      },
    ]
    let contexts = 0
    yield* hooks.register("session", "context", () => Effect.sync(() => contexts++))
    yield* hooks.register("session", "compaction", (event) =>
      Effect.sync(() => {
        expect(event.sessionID).toBe(sessionID)
        expect(event.agent).toBe(Agent.defaultID)
        expect(JSON.stringify(event.messages)).toContain("Hooked compaction should see this conversation.")
        event.result = { summary: "## Objective\n- hooked summary" }
      }),
    )

    expect(
      yield* compaction.compactManual({
        session,
        resolveContext: () => Effect.succeed(loaded(session, messages)),
        prepare: modelRequests.compaction,
        messages,
        inputID: SessionMessage.ID.make("msg_hooked_compaction"),
      }),
    ).toEqual({ status: "completed" })

    expect(contexts).toBe(0)
    expect(requests).toEqual([])
    expect(yield* store.context(sessionID)).toMatchObject([
      { type: "compaction", reason: "manual", summary: "## Objective\n- hooked summary", recent: "" },
    ])
    expect(
      yield* db
        .select({ type: EventTable.type })
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, sessionID))
        .orderBy(asc(EventTable.seq))
        .all()
        .pipe(Effect.orDie),
    ).toEqual([
      { type: Bus.versionedType(SessionEvent.Compaction.Started.type, 1) },
      { type: Bus.versionedType(SessionEvent.Compaction.Ended.type, 1) },
    ])
  }),
)

it.effect("manual compaction records model resolution failures without calling the model", () =>
  Effect.gen(function* () {
    requests = []
    const compaction = yield* SessionCompaction.Service
    const store = yield* SessionStore.Service
    const sessionID = Session.ID.make("ses_manual_resolution_failure")
    const session = yield* insertSession(sessionID)
    const modelRequests = yield* SessionModelRequest.Service
    const inputID = SessionMessage.ID.make("msg_manual_resolution_failure")

    expect(
      yield* compaction.compactManual({
        session,
        resolveContext: () =>
          Effect.fail(
            new SessionRunnerModel.ModelUnavailableError({
              providerID: Provider.ID.make("test"),
              modelID: Model.ID.make("missing"),
            }),
          ),
        prepare: modelRequests.compaction,
        messages: [
          {
            id: SessionMessage.ID.create(),
            type: "user",
            text: "Summarize this conversation.",
            time: { created: DateTime.makeUnsafe(0) },
          },
        ],
        inputID,
      }),
    ).toEqual({
      status: "failed",
      error: { type: "provider.no-route", message: "Model unavailable: test/missing" },
    })
    expect(requests).toHaveLength(0)
    expect(yield* store.context(sessionID)).toMatchObject([
      {
        id: inputID,
        type: "compaction",
        status: "failed",
        reason: "manual",
        error: { type: "provider.no-route", message: "Model unavailable: test/missing" },
      },
    ])
  }),
)

it.effect("forked session compaction reuses the fork root prompt cache key", () =>
  Effect.gen(function* () {
    requests = []
    const compaction = yield* SessionCompaction.Service
    const sessionID = Session.ID.make("ses_fork_compaction")
    const rootID = Session.ID.make("ses_fork_compaction_root")
    const session = yield* insertSession(sessionID, {
      fork_session_id: rootID,
      fork_boundary: { type: "before", messageID: SessionMessage.ID.create() },
    })
    const modelRequests = yield* SessionModelRequest.Service
    const messages = [
      SessionMessage.User.make({
        id: SessionMessage.ID.create(),
        type: "user",
        text: "Summarize the forked conversation.",
        time: { created: DateTime.makeUnsafe(0) },
      }),
    ]
    expect(
      yield* compaction.compactManual({
        session,
        resolveContext: () => Effect.succeed(loaded(session, messages)),
        prepare: modelRequests.compaction,
        messages,
        inputID: SessionMessage.ID.make("msg_fork_compaction"),
      }),
    ).toEqual({ status: "completed" })

    expect(requests).toHaveLength(1)
    expect(requests[0]?.promptCacheKey).toBe(rootID)
  }),
)
