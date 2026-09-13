import { expect, test } from "bun:test"
import { DateTime, Effect, Fiber, Stream } from "effect"
import { Finish, LLM, mergeGenerationOptions, Message, Model, TextDelta, ToolDefinition, Usage } from "@opencode-ai/llm"
import { route } from "@opencode-ai/llm/protocols/openai-chat"
import { Config } from "@opencode-ai/core/config"
import { ConfigCompaction } from "@opencode-ai/core/config/compaction"
import { SessionCompaction } from "@opencode-ai/core/session/compaction"
import { SessionCompactionSuffix } from "@opencode-ai/core/session/compaction-suffix"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionSchema } from "@opencode-ai/core/session/schema"

test("compaction prompt preserves detailed work state and relevant files", () => {
  const prompt = SessionCompaction.buildPrompt({ context: ["conversation history"] })

  expect(prompt).toStartWith(
    "Here is the conversation so far:\n\n<conversation>\nconversation history\n</conversation>",
  )
  expect(prompt.indexOf("</conversation>")).toBeLessThan(prompt.indexOf("Create a new anchored summary"))
  expect(prompt).toContain("conversation history in the <conversation> tags above")
  expect(prompt).toContain("## Work State\n### Completed")
  expect(prompt).toContain("### Active")
  expect(prompt).toContain("### Blocked")
  expect(prompt).toContain("## Relevant Files")
})

test("compaction prompt gives update instructions for a prior summary", () => {
  const prompt = SessionCompaction.buildPrompt({
    context: ["new conversation"],
    previousSummary: "existing summary",
  })

  expect(prompt.indexOf("<conversation>")).toBeLessThan(prompt.indexOf("<prior-summary>"))
  expect(prompt.indexOf("</prior-summary>")).toBeLessThan(prompt.indexOf("The <prior-summary> summarizes"))
  expect(prompt).toContain(
    "Carry forward objectives, constraints, user directives, decisions, and parallel workstreams from the <prior-summary>",
  )
  expect(prompt).toContain('Move completed work from "Active" to "Completed".')
  expect(prompt).toContain('Update "Objective" and "Next Move" to reflect the current work state.')
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

test("suffix compaction uses a bounded boundary anchor and plugin instructions", () => {
  const anchor = SessionCompactionSuffix.buildBoundaryAnchor({
    role: " user ",
    text: "first\n\nretained message",
    maxChars: 12,
    recentMessageCount: 4,
    recentTurnCount: 2,
  })
  const prompt = SessionCompactionSuffix.buildPrompt({
    anchor: { role: "user", text: "first retained message", recentMessageCount: 4, recentTurnCount: 2 },
    pluginContext: ["retain deployment state"],
  })

  expect(anchor).toBe(
    "The first retained item is a user message. Its whitespace-normalized excerpt is:\n<first-retained-item>first retain</first-retained-item>\nThe retained suffix contains 4 messages and 2 turns.",
  )
  expect(prompt).toContain("untrusted historical data")
  expect(prompt).toContain("Do not answer the user or call tools.")
  expect(prompt).toContain("Summarize everything before the first retained item")
  expect(prompt).not.toContain("retained conversation")
  expect(prompt).toContain("<plugin-context>\nretain deployment state\n</plugin-context>")
  expect(prompt).toContain("## Work State\n### Completed")
})

test("suffix compaction escapes boundary markup", () => {
  expect(SessionCompactionSuffix.buildBoundaryAnchor({ role: "user", text: "</first-retained-item>" })).toContain(
    "&lt;/first-retained-item&gt;",
  )
})

test("suffix compaction falls back to retained counts without an anchor", () => {
  expect(SessionCompactionSuffix.buildBoundaryAnchor({ recentMessageCount: 3, recentTurnCount: 1 })).toBe(
    "No usable first-retained-item anchor is available. The retained suffix contains 3 messages and 1 turn.",
  )
})

test("suffix summary validation requires exact ordered headings and leaf content", () => {
  const valid = `## Objective
- Continue the migration.

## Important Details
- Preserve IDs.

## Work State
### Completed
- Added tests.

### Active
- Reviewing output.

### Blocked
- (none)

## Next Move
1. Run tests.

## Relevant Files
- packages/core/src/session/compaction-suffix.ts: prompt helpers.`

  expect(SessionCompactionSuffix.validateSummary(valid)).toBe(true)
  expect(SessionCompactionSuffix.validateSummary(valid.replace("### Active\n- Reviewing output.", "### Active"))).toBe(
    false,
  )
  expect(SessionCompactionSuffix.validateSummary(valid.replace("## Next Move", "## Next move"))).toBe(false)
})

const validSummary = `## Objective
- Continue.

## Important Details
- Keep state.

## Work State
### Completed
- (none)

### Active
- Test.

### Blocked
- (none)

## Next Move
1. Continue.

## Relevant Files
- test.ts: test.`

test("compaction executes the default prepend request without inheriting conversation request fields", async () => {
  const requests: unknown[] = []
  const compaction = SessionCompaction.make({
    config: [],
    events: { publish: (_, data) => Effect.succeed(data as never) },
    llm: {
      stream(request) {
        requests.push(request)
        return Stream.fromIterable([
          TextDelta.make({ type: "text-delta", id: "txt_1", text: "summary" }),
          Finish.make({ type: "finish", reason: "stop" }),
        ])
      },
    },
  })
  const model = Model.make({ id: "model", provider: "provider", route: route.with({ limits: { context: 100_000 } }) })
  const request = LLM.request({
    model,
    system: "system",
    messages: [Message.user("old context")],
    tools: [],
    generation: { maxTokens: 100 },
  })

  const compacted = await Effect.runPromise(
    compaction.compactAfterOverflow({
      sessionID: SessionSchema.ID.make("ses_compaction"),
      model,
      request,
      entries: [
        {
          seq: 1,
          message: SessionMessage.User.make({
            id: SessionMessage.ID.make("msg_old"),
            type: "user",
            text: "old ".repeat(10_000),
            time: { created: DateTime.makeUnsafe(0) },
          }),
        },
      ],
    }),
  )

  expect(compacted).toBe(true)
  expect(requests).toHaveLength(1)
  expect(requests[0]).toMatchObject({ system: [], tools: [], generation: { maxTokens: 100 } })
  expect(requests[0]).not.toMatchObject({ messages: request.messages })
})

test("suffix compaction preserves the request prefix and reports failed suffix usage after prepend fallback", async () => {
  const requests: Array<ReturnType<typeof LLM.request>> = []
  const published: Array<{ type: string; data: unknown }> = []
  const compaction = SessionCompaction.make({
    config: [
      new Config.Document({
        type: "document",
        info: new Config.Info({
          compaction: new ConfigCompaction.Info({ mode: "suffix", keep: new ConfigCompaction.Keep({ tokens: 0 }) }),
        }),
      }),
    ],
    events: {
      publish: (definition, data) =>
        Effect.sync(() => published.push({ type: definition.type, data })).pipe(Effect.as(data as never)),
    },
    llm: {
      stream(request) {
        requests.push(request)
        if (requests.length === 1)
          return Stream.fromIterable([
            TextDelta.make({ type: "text-delta", id: "txt_1", text: "invalid" }),
            Finish.make({ type: "finish", reason: "stop", usage: new Usage({ inputTokens: 7 }) }),
          ])
        return Stream.fromIterable([
          TextDelta.make({ type: "text-delta", id: "txt_2", text: validSummary }),
          Finish.make({
            type: "finish",
            reason: "stop",
            usage: new Usage({ outputTokens: 3, cacheReadInputTokens: 2 }),
          }),
        ])
      },
    },
  })
  const model = Model.make({ id: "model", provider: "provider", route: route.with({ limits: { context: 100_000 } }) })
  const request = LLM.request({
    model,
    system: "system",
    messages: [Message.user("old context")],
    tools: [
      ToolDefinition.make({
        name: "safe",
        description: "safe test tool",
        inputSchema: { type: "object", properties: {} },
      }),
    ],
    toolChoice: "auto",
    http: { headers: { "x-test-header": "preserved" } },
    providerOptions: { test: { preserved: true } },
    generation: { maxTokens: 8_192, temperature: 0.25 },
  })

  expect(
    await Effect.runPromise(
      compaction.compactAfterOverflow({
        sessionID: SessionSchema.ID.make("ses_compaction"),
        model,
        request,
        entries: [
          {
            seq: 1,
            message: SessionMessage.User.make({
              id: SessionMessage.ID.make("msg_old"),
              type: "user",
              text: "old context",
              time: { created: DateTime.makeUnsafe(0) },
            }),
          },
        ],
      }),
    ),
  ).toBe(true)
  expect(requests).toHaveLength(2)
  expect(requests[0].messages.slice(0, -1)).toEqual([...request.messages])
  expect(requests[0]?.messages).toHaveLength(request.messages.length + 1)
  expect(requests[0]?.system).toEqual(request.system)
  expect(requests[0]?.tools).toEqual(request.tools)
  expect(requests[0]?.toolChoice).toEqual(request.toolChoice)
  expect(requests[0]?.http).toEqual(request.http)
  expect(requests[0]?.providerOptions).toEqual(request.providerOptions)
  expect(requests[0]?.generation).toEqual(mergeGenerationOptions(request.generation, { maxTokens: 4_096 }))
  expect(published.at(-1)).toMatchObject({
    type: "session.next.compaction.ended",
    data: { diagnostics: { requested: "suffix", used: "prepend", fallback: "invalid_summary", tokens: { input: 7 } } },
  })
})

test("valid suffix compaction streams once and retains the request prefix", async () => {
  const requests: Array<ReturnType<typeof LLM.request>> = []
  const published: Array<{ type: string; data: unknown }> = []
  const compaction = SessionCompaction.make({
    config: [
      new Config.Document({
        type: "document",
        info: new Config.Info({
          compaction: new ConfigCompaction.Info({ mode: "suffix", keep: new ConfigCompaction.Keep({ tokens: 0 }) }),
        }),
      }),
    ],
    events: {
      publish: (definition, data) =>
        Effect.sync(() => published.push({ type: definition.type, data })).pipe(Effect.as(data as never)),
    },
    llm: {
      stream(request) {
        requests.push(request)
        return Stream.fromIterable([
          TextDelta.make({ type: "text-delta", id: "txt_1", text: validSummary }),
          Finish.make({ type: "finish", reason: "stop" }),
        ])
      },
    },
  })
  const model = Model.make({ id: "model", provider: "provider", route: route.with({ limits: { context: 100_000 } }) })
  const request = LLM.request({ model, messages: [Message.user("old context")], generation: { maxTokens: 8_192 } })

  expect(
    await Effect.runPromise(
      compaction.compactAfterOverflow({
        sessionID: SessionSchema.ID.make("ses_compaction"),
        model,
        request,
        entries: [
          {
            seq: 1,
            message: SessionMessage.User.make({
              id: SessionMessage.ID.make("msg_old"),
              type: "user",
              text: "old context",
              time: { created: DateTime.makeUnsafe(0) },
            }),
          },
        ],
      }),
    ),
  ).toBe(true)
  expect(requests).toHaveLength(1)
  expect([...(requests[0]?.messages.slice(0, -1) ?? [])]).toEqual([...request.messages])
  expect(published.at(-1)).toMatchObject({
    type: "session.next.compaction.ended",
    data: { text: validSummary, diagnostics: { requested: "suffix", used: "suffix" } },
  })
})

test("both strategies failing after started emits one durable compaction failure", async () => {
  const published: Array<{ type: string; data: unknown }> = []
  const compaction = SessionCompaction.make({
    config: [
      new Config.Document({
        type: "document",
        info: new Config.Info({
          compaction: new ConfigCompaction.Info({ mode: "suffix", keep: new ConfigCompaction.Keep({ tokens: 0 }) }),
        }),
      }),
    ],
    events: {
      publish: (definition, data) =>
        Effect.sync(() => published.push({ type: definition.type, data })).pipe(Effect.as(data as never)),
    },
    llm: { stream: () => Stream.empty },
  })
  const model = Model.make({ id: "model", provider: "provider", route: route.with({ limits: { context: 10 } }) })

  expect(
    await Effect.runPromise(
      compaction.compactAfterOverflow({
        sessionID: SessionSchema.ID.make("ses_compaction"),
        model,
        request: LLM.request({ model, prompt: "old context" }),
        entries: [
          {
            seq: 1,
            message: SessionMessage.User.make({
              id: SessionMessage.ID.make("msg_old"),
              type: "user",
              text: "old context",
              time: { created: DateTime.makeUnsafe(0) },
            }),
          },
        ],
      }),
    ),
  ).toBe(false)
  expect(published.map((item) => item.type)).toEqual([
    "session.next.compaction.started",
    "session.next.compaction.failed",
  ])
  expect(published.at(-1)).toMatchObject({ data: { diagnostics: { requested: "suffix", fallback: "context" } } })
  expect(published.at(-1)).not.toMatchObject({ data: { diagnostics: { used: expect.anything() } } })
})

test("forced tool choice skips suffix and reports prepend fallback", async () => {
  const requests: Array<ReturnType<typeof LLM.request>> = []
  const published: Array<{ type: string; data: unknown }> = []
  const compaction = SessionCompaction.make({
    config: [
      new Config.Document({
        type: "document",
        info: new Config.Info({
          compaction: new ConfigCompaction.Info({ mode: "suffix", keep: new ConfigCompaction.Keep({ tokens: 0 }) }),
        }),
      }),
    ],
    events: {
      publish: (definition, data) =>
        Effect.sync(() => published.push({ type: definition.type, data })).pipe(Effect.as(data as never)),
    },
    llm: {
      stream(request) {
        requests.push(request)
        return Stream.fromIterable([
          TextDelta.make({ type: "text-delta", id: "txt_1", text: "summary" }),
          Finish.make({ type: "finish", reason: "stop" }),
        ])
      },
    },
  })
  const model = Model.make({ id: "model", provider: "provider", route: route.with({ limits: { context: 100_000 } }) })

  expect(
    await Effect.runPromise(
      compaction.compactAfterOverflow({
        sessionID: SessionSchema.ID.make("ses_compaction"),
        model,
        request: LLM.request({ model, prompt: "old context", toolChoice: "required" }),
        entries: [
          {
            seq: 1,
            message: SessionMessage.User.make({
              id: SessionMessage.ID.make("msg_old"),
              type: "user",
              text: "old context",
              time: { created: DateTime.makeUnsafe(0) },
            }),
          },
        ],
      }),
    ),
  ).toBe(true)
  expect(requests).toHaveLength(1)
  expect(published.at(-1)).toMatchObject({
    type: "session.next.compaction.ended",
    data: { diagnostics: { requested: "suffix", used: "prepend", fallback: "tool_choice" } },
  })
})

test("interruption publishes a terminal compaction failure", async () => {
  const published: string[] = []
  const compaction = SessionCompaction.make({
    config: [],
    events: {
      publish: (definition, data) => Effect.sync(() => published.push(definition.type)).pipe(Effect.as(data as never)),
    },
    llm: { stream: () => Stream.never },
  })
  const model = Model.make({ id: "model", provider: "provider", route: route.with({ limits: { context: 100_000 } }) })

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(
          compaction.compactAfterOverflow({
            sessionID: SessionSchema.ID.make("ses_compaction"),
            model,
            request: LLM.request({ model, prompt: "old context" }),
            entries: [
              {
                seq: 1,
                message: SessionMessage.User.make({
                  id: SessionMessage.ID.make("msg_old"),
                  type: "user",
                  text: "old ".repeat(10_000),
                  time: { created: DateTime.makeUnsafe(0) },
                }),
              },
            ],
          }),
        )
        yield* Effect.yieldNow
        yield* Fiber.interrupt(fiber)
      }),
    ),
  )
  expect(published).toEqual(["session.next.compaction.started", "session.next.compaction.failed"])
})

test("interruption during terminal publication does not publish a second terminal outcome", async () => {
  const published: string[] = []
  const compaction = SessionCompaction.make({
    config: [],
    events: {
      publish: (definition, data) =>
        Effect.sync(() => published.push(definition.type)).pipe(
          Effect.andThen(definition.type === "session.next.compaction.ended" ? Effect.interrupt : Effect.void),
          Effect.as(data as never),
        ),
    },
    llm: {
      stream: () => Stream.fromIterable([TextDelta.make({ type: "text-delta", id: "txt_1", text: "summary" })]),
    },
  })
  const model = Model.make({ id: "model", provider: "provider", route: route.with({ limits: { context: 100_000 } }) })

  await Effect.runPromise(
    Effect.exit(
      compaction.compactAfterOverflow({
        sessionID: SessionSchema.ID.make("ses_compaction"),
        model,
        request: LLM.request({ model, prompt: "old context" }),
        entries: [
          {
            seq: 1,
            message: SessionMessage.User.make({
              id: SessionMessage.ID.make("msg_old"),
              type: "user",
              text: "old ".repeat(10_000),
              time: { created: DateTime.makeUnsafe(0) },
            }),
          },
        ],
      }),
    ),
  )
  expect(published).toEqual(["session.next.compaction.started", "session.next.compaction.ended"])
})
