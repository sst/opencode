import { expect, test } from "bun:test"
import type { SessionMessageAssistant, SessionMessageInfo } from "@opencode/client"
import { createMemo, createRoot } from "solid-js"
import { createStore } from "solid-js/store"
import {
  cacheReuseDrop,
  messageBoundaryIDs,
  reduceSessionRows,
  sessionRowID,
  turnDuration,
  turnTokensPerSecond,
} from "../../../src/routes/session/rows"

test("measures turn duration from the user prompt across assistant steps", () => {
  const first = assistant("assistant-1", [])
  first.time = { created: 8_000, completed: 11_000 }
  const final = assistant("assistant-2", [])
  final.time = { created: 27_000, completed: 30_000 }
  const messages: SessionMessageInfo[] = [
    { type: "user", id: "user-1", text: "Question", time: { created: 1_000 } },
    first,
    final,
  ]

  expect(turnDuration(final, messages)).toBe(29_000)
})

test("measures request throughput including reasoning across model changes without tool time", () => {
  const first = assistant("assistant-1", [])
  first.time = { created: 8_000, streamed: 10_000, completed: 20_000, requestDurationMs: 4_000 }
  first.tokens = { input: 10, output: 20, reasoning: 5, cache: { read: 0, write: 0 } }
  const final = assistant("assistant-2", [])
  final.model = { id: "other-model", providerID: "other-provider", variant: "other-variant" }
  final.time = { created: 27_000, streamed: 30_000, completed: 31_000, requestDurationMs: 6_000 }
  final.tokens = { input: 20, output: 30, reasoning: 10, cache: { read: 0, write: 0 } }
  const messages: SessionMessageInfo[] = [
    { type: "user", id: "user-1", text: "Question", time: { created: 1_000 } },
    first,
    final,
  ]

  expect(turnTokensPerSecond(final, messages)).toBe(6.5)
  first.time.requestDurationMs = undefined
  expect(turnTokensPerSecond(final, messages)).toBeUndefined()
})

test("does not infer request timing for historical messages", () => {
  const final = assistant("assistant-1", [])
  final.tokens = { input: 10, output: 20, reasoning: 0, cache: { read: 0, write: 0 } }
  final.time = { created: 1_000, streamed: 2_000, completed: 3_000 }
  expect(turnTokensPerSecond(final, [final])).toBeUndefined()
})

test.each([false, true])(
  "measures historical footers without later inputs or incomplete steps (indexed: %s)",
  (indexed) => {
    const step = (id: string, created: number, streamed: number, completed: number, output: number) => ({
      ...assistant(id, []),
      time: { created, streamed, completed, requestDurationMs: streamed - created },
      tokens: { input: 1, output, reasoning: 2, cache: { read: 0, write: 0 } },
    })
    const messages: SessionMessageInfo[] = [
      step("before-input", 0, 1_000, 2_000, 5),
      { type: "user", id: "input", text: "Question", time: { created: 3_000 } },
      step("first-step", 4_000, 5_000, 6_000, 10),
      { type: "system", id: "system", text: "Instructions", time: { created: 6_500 } },
      step("second-step", 7_000, 8_000, 9_000, 20),
      { type: "synthetic", id: "synthetic", text: "Update", time: { created: 10_000 } },
      step("after-synthetic", 11_000, 13_000, 14_000, 12),
      { type: "user", id: "later-input", text: "Next question", time: { created: 15_000 } },
      assistant("incomplete", []),
    ]

    expect(
      messages.flatMap((message, index) =>
        message.type === "assistant"
          ? [
              [
                turnDuration(message, messages, indexed ? index : undefined),
                turnTokensPerSecond(message, messages, indexed ? index : undefined),
              ],
            ]
          : [],
      ),
    ).toEqual([
      [2_000, 7],
      [3_000, 12],
      [6_000, 17],
      [4_000, 7],
      [0, undefined],
    ])
  },
)

test("preserves missing-anchor footer fallbacks without including the absent assistant's tokens", () => {
  const absent = assistant("absent", [])
  absent.time = { created: 8_000, streamed: 9_000, completed: 10_000 }
  absent.tokens = { input: 1, output: 900, reasoning: 0, cache: { read: 0, write: 0 } }
  const stored = assistant("stored", [])
  stored.time = { created: 6_000, streamed: 8_000, completed: 9_000, requestDurationMs: 2_000 }
  stored.tokens = { input: 1, output: 20, reasoning: 0, cache: { read: 0, write: 0 } }
  const input: SessionMessageInfo = { type: "user", id: "input", text: "Question", time: { created: 5_000 } }

  expect(turnDuration(absent, [input, stored])).toBe(5_000)
  expect(turnTokensPerSecond(absent, [input, stored])).toBe(10)
  expect(turnDuration(absent, [stored])).toBe(2_000)
  expect(turnTokensPerSecond(absent, [stored])).toBe(10)
  expect(turnDuration(absent, [])).toBe(2_000)
  expect(turnTokensPerSecond(absent, [])).toBeUndefined()
})

test("indexed tail footer calculations do not subscribe to an unrelated history prefix", () => {
  createRoot((dispose) => {
    try {
      const final = assistant("final", [])
      final.time = { created: 2_000, streamed: 3_000, completed: 5_000, requestDurationMs: 1_000 }
      final.tokens = { input: 1, output: 20, reasoning: 0, cache: { read: 0, write: 0 } }
      const [messages, setMessages] = createStore<SessionMessageInfo[]>([
        { type: "user", id: "old-input", text: "Old question", time: { created: 0 } },
        assistant("old-step", []),
        { type: "user", id: "input", text: "Current question", time: { created: 1_000 } },
        final,
      ])
      let runs = 0
      const footer = createMemo(() => {
        runs++
        const current = messages[3]
        if (current.type !== "assistant") throw new Error("Expected an assistant")
        return [turnDuration(current, messages, 3), turnTokensPerSecond(current, messages, 3)]
      })
      expect(footer()).toEqual([4_000, 20])
      setMessages(0, { type: "user", id: "replaced-prefix", text: "Older question", time: { created: 50 } })
      expect(footer()).toEqual([4_000, 20])
      expect(runs).toBe(1)

      setMessages(2, "time", "created", 1_500)
      expect(footer()).toEqual([3_500, 20])
      setMessages(3, {
        ...final,
        time: { ...final.time, requestDurationMs: 2_000 },
        tokens: { ...final.tokens, output: 60 },
      })
      expect(footer()).toEqual([3_500, 30])
      expect(runs).toBe(3)
    } finally {
      dispose()
    }
  })
})

test("filters OpenAI cache quantization from cache reuse drops", () => {
  const openai = { id: "gpt", providerID: "openai" }
  expect(cacheReuseDrop(undefined, { read: 10_000, model: openai })).toBeUndefined()
  expect(cacheReuseDrop({ read: 10_000, model: openai }, { read: 11_000, model: openai })).toBeUndefined()
  expect(cacheReuseDrop({ read: 10_000, model: openai }, { read: 8_977, model: openai })).toBe(1_023)
  expect(cacheReuseDrop({ read: 10_000, model: openai }, { read: 8_976, model: openai })).toBeUndefined()
  expect(cacheReuseDrop({ read: 10_000, model: openai }, { read: 8_500, model: openai })).toBeUndefined()
  expect(cacheReuseDrop({ read: 10_000, model: openai }, { read: 7_952, model: openai })).toBeUndefined()
  expect(cacheReuseDrop({ read: 10_000, model: openai }, { read: 7_951, model: openai })).toBe(2_049)
})

test("compares cache reuse only for the same model", () => {
  const previous = { read: 10_000, model: { id: "claude", providerID: "anthropic" } }
  expect(cacheReuseDrop(previous, { read: 8_976, model: { id: "gpt", providerID: "openai" } })).toBeUndefined()
  expect(cacheReuseDrop(previous, { read: 8_976, model: { id: "claude", providerID: "anthropic" } })).toBe(1_024)
  expect(
    cacheReuseDrop(
      { read: 10_000, model: { id: "gpt", providerID: "openai", variant: "low" } },
      { read: 8_976, model: { id: "gpt", providerID: "openai", variant: "high" } },
    ),
  ).toBeUndefined()
})

test("carries model identity with the cross-turn cache baseline", () => {
  const first = assistant("assistant-1", [])
  first.model = { id: "claude", providerID: "anthropic" }
  first.finish = "stop"
  first.tokens = { input: 1, output: 0, reasoning: 0, cache: { read: 10_000, write: 0 } }
  const second = assistant("assistant-2", [])
  second.model = { id: "gpt", providerID: "openai" }
  second.finish = "stop"
  second.tokens = { input: 1, output: 0, reasoning: 0, cache: { read: 8_976, write: 0 } }

  const rows = reduceSessionRows(
    [
      { type: "user", id: "user-1", text: "First", time: { created: 0 } },
      first,
      { type: "user", id: "user-2", text: "Second", time: { created: 2 } },
      second,
    ],
    new Set(),
    true,
  ).filter((row) => row.type === "turn-usage")

  expect(rows).toEqual([
    { type: "turn-usage", messageIDs: ["assistant-1"] },
    {
      type: "turn-usage",
      messageIDs: ["assistant-2"],
      previousCache: { read: 10_000, model: { id: "claude", providerID: "anthropic" } },
    },
  ])
})

test("resets the cross-turn cache baseline after compaction", () => {
  const first = assistant("assistant-1", [])
  first.finish = "stop"
  first.tokens = { input: 1, output: 0, reasoning: 0, cache: { read: 370_176, write: 0 } }
  const second = assistant("assistant-2", [])
  second.finish = "stop"
  second.tokens = { input: 1, output: 0, reasoning: 0, cache: { read: 13_824, write: 0 } }

  const rows = reduceSessionRows(
    [
      first,
      {
        type: "compaction",
        id: "compaction-1",
        status: "completed",
        reason: "auto",
        summary: "Compacted context",
        recent: "",
        time: { created: 2 },
      },
      second,
    ],
    new Set(),
    true,
  ).filter((row) => row.type === "turn-usage")

  expect(rows).toEqual([
    { type: "turn-usage", messageIDs: ["assistant-1"] },
    { type: "turn-usage", messageIDs: ["assistant-2"] },
  ])
})

test("assigns assistant boundaries to the first rendered row instead of the first text row", () => {
  const messages: SessionMessageInfo[] = [
    { type: "user", id: "user-1", text: "Question", time: { created: 0 } },
    assistant("assistant-1", [
      { type: "reasoning", text: "Thinking" },
      { type: "text", text: "First" },
      { type: "text", text: "Second" },
    ]),
  ]
  const rows = reduceSessionRows(messages)

  expect(messageBoundaryIDs(rows, messages)).toEqual(["user-1", "assistant-1", undefined, undefined])
})

test("assigns stable IDs to tool rows for direct navigation", () => {
  const messages: SessionMessageInfo[] = [
    assistant("assistant-1", [
      { type: "text", text: "Starting a shell" },
      { type: "tool", id: "shell-1", name: "shell", state: pending(), time: { created: 2 } },
    ]),
    assistant("assistant-2", [{ type: "tool", id: "shell-2", name: "shell", state: pending(), time: { created: 3 } }]),
  ]
  const rows = reduceSessionRows(messages)
  const boundaries = messageBoundaryIDs(rows, messages)

  expect(rows.map((row, index) => sessionRowID(row, boundaries[index]))).toEqual([
    "assistant-1",
    "session-part:assistant-1:shell-1",
    "assistant-2",
  ])
})

test("groups exploration parts across assistant messages until a delimiter", () => {
  const messages: SessionMessageInfo[] = [
    { type: "user", id: "user-1", text: "Explore", time: { created: 0 } },
    assistant("assistant-1", [
      { type: "text", text: "Looking" },
      { type: "tool", id: "read-1", name: "read", state: pending(), time: { created: 2 } },
      { type: "tool", id: "glob-1", name: "glob", state: pending(), time: { created: 3 } },
    ]),
    assistant("assistant-2", [
      { type: "tool", id: "grep-1", name: "grep", state: pending(), time: { created: 5 } },
      { type: "text", text: "Done" },
    ]),
  ]

  expect(reduceSessionRows(messages)).toEqual([
    { type: "message", messageID: "user-1" },
    { type: "part", ref: { messageID: "assistant-1", partID: "text:0" } },
    {
      type: "group",
      kind: "exploration",
      pending: [],
      completed: true,
      size: 3,
      children: [
        partChild("assistant-1", "read-1"),
        partChild("assistant-1", "glob-1"),
        partChild("assistant-2", "grep-1"),
      ],
    },
    { type: "part", ref: { messageID: "assistant-2", partID: "text:0" } },
  ])
})

test("keeps non-exploration tools as individual part rows", () => {
  const messages: SessionMessageInfo[] = [
    assistant("assistant-1", [
      { type: "tool", id: "read-1", name: "read", state: pending(), time: { created: 1 } },
      { type: "tool", id: "reasoning:0", name: "bash", state: pending(), time: { created: 2 } },
      { type: "tool", id: "grep-1", name: "grep", state: pending(), time: { created: 3 } },
    ]),
  ]

  expect(reduceSessionRows(messages)).toEqual([
    {
      type: "group",
      kind: "exploration",
      pending: [],
      completed: true,
      size: 1,
      children: [partChild("assistant-1", "read-1")],
    },
    { type: "part", ref: { messageID: "assistant-1", partID: "reasoning:0" } },
    {
      type: "group",
      kind: "exploration",
      pending: [],
      completed: false,
      size: 1,
      children: [partChild("assistant-1", "grep-1")],
    },
  ])
})

test("assigns stable kind ordinals within an assistant message", () => {
  const messages: SessionMessageInfo[] = [
    assistant("assistant-1", [
      { type: "text", text: "First" },
      { type: "reasoning", text: "Think" },
      { type: "text", text: "Second" },
      { type: "reasoning", text: "Check" },
    ]),
  ]

  expect(reduceSessionRows(messages)).toEqual([
    { type: "part", ref: { messageID: "assistant-1", partID: "text:0" } },
    {
      type: "group",
      kind: "reasoning",
      completed: true,
      size: 1,
      children: [partChild("assistant-1", "reasoning:0")],
    },
    { type: "part", ref: { messageID: "assistant-1", partID: "text:1" } },
    {
      type: "group",
      kind: "reasoning",
      completed: false,
      size: 1,
      children: [partChild("assistant-1", "reasoning:1")],
    },
  ])
})

test("groups adjacent reasoning parts until a visible boundary", () => {
  const messages: SessionMessageInfo[] = [
    assistant("assistant-1", [
      { type: "reasoning", text: "First" },
      { type: "reasoning", text: "Second" },
      { type: "text", text: "Visible" },
      { type: "reasoning", text: "Third" },
    ]),
  ]

  expect(reduceSessionRows(messages)).toEqual([
    {
      type: "group",
      kind: "reasoning",
      completed: true,
      size: 2,
      children: [partChild("assistant-1", "reasoning:0"), partChild("assistant-1", "reasoning:1")],
    },
    { type: "part", ref: { messageID: "assistant-1", partID: "text:0" } },
    {
      type: "group",
      kind: "reasoning",
      completed: false,
      size: 1,
      children: [partChild("assistant-1", "reasoning:2")],
    },
  ])
})

test("groups across empty assistant reasoning parts", () => {
  const messages: SessionMessageInfo[] = [
    assistant("assistant-1", [
      { type: "reasoning", text: "Looking" },
      { type: "tool", id: "read-1", name: "read", state: pending(), time: { created: 2 } },
    ]),
    assistant("assistant-2", [
      { type: "reasoning", text: "" },
      { type: "tool", id: "grep-1", name: "grep", state: pending(), time: { created: 3 } },
    ]),
  ]

  expect(reduceSessionRows(messages)).toEqual([
    {
      type: "group",
      kind: "reasoning",
      completed: true,
      size: 1,
      children: [partChild("assistant-1", "reasoning:0")],
    },
    {
      type: "group",
      kind: "exploration",
      pending: [],
      completed: false,
      size: 2,
      children: [partChild("assistant-1", "read-1"), partChild("assistant-2", "grep-1")],
    },
  ])
})

test("completes exploration groups when another row follows", () => {
  const finished = assistant("assistant-2", [
    { type: "tool", id: "grep-1", name: "grep", state: pending(), time: { created: 3 } },
  ])
  finished.finish = "stop"
  const messages: SessionMessageInfo[] = [
    assistant("assistant-1", [{ type: "tool", id: "read-1", name: "read", state: pending(), time: { created: 1 } }]),
    { type: "user", id: "user-1", text: "Continue", time: { created: 2 } },
    finished,
  ]

  expect(reduceSessionRows(messages)).toEqual([
    {
      type: "group",
      kind: "exploration",
      pending: [],
      completed: true,
      size: 1,
      children: [partChild("assistant-1", "read-1")],
    },
    { type: "message", messageID: "user-1" },
    {
      type: "group",
      kind: "exploration",
      pending: [],
      completed: true,
      size: 1,
      children: [partChild("assistant-2", "grep-1")],
    },
    { type: "assistant-footer", messageID: "assistant-2" },
  ])
})

test("hides synthetic messages without descriptions", () => {
  const messages: SessionMessageInfo[] = [
    {
      id: "shell-message",
      type: "shell",
      shellID: "sh_user",
      command: "pwd",
      status: "exited",
      time: { created: 0 },
    },
    assistant("assistant-1", [{ type: "tool", id: "read-1", name: "read", state: pending(), time: { created: 1 } }]),
    {
      type: "synthetic",
      id: "synthetic-1",
      text: "internal context",
      metadata: { source: "shell", shellID: "sh_user", state: "completed" },
      time: { created: 2 },
    },
    assistant("assistant-2", [{ type: "tool", id: "grep-1", name: "grep", state: pending(), time: { created: 3 } }]),
  ]

  const rows = reduceSessionRows(messages)
  expect(rows).toEqual([
    { type: "message", messageID: "shell-message" },
    {
      type: "group",
      kind: "exploration",
      pending: [],
      completed: false,
      size: 2,
      children: [partChild("assistant-1", "read-1"), partChild("assistant-2", "grep-1")],
    },
  ])
  expect(reduceSessionRows(messages, new Set(["synthetic-1"]))).toEqual(rows)
})

test("renders synthetic messages with descriptions", () => {
  const messages: SessionMessageInfo[] = [
    assistant("assistant-1", [{ type: "tool", id: "read-1", name: "read", state: pending(), time: { created: 1 } }]),
    {
      type: "synthetic",
      id: "synthetic-1",
      text: "internal context",
      description: "Explicit notice",
      time: { created: 2 },
    },
    assistant("assistant-2", [{ type: "tool", id: "grep-1", name: "grep", state: pending(), time: { created: 3 } }]),
  ]

  expect(reduceSessionRows(messages)).toEqual([
    {
      type: "group",
      kind: "exploration",
      pending: [],
      completed: true,
      size: 1,
      children: [partChild("assistant-1", "read-1")],
    },
    { type: "message", messageID: "synthetic-1" },
    {
      type: "group",
      kind: "exploration",
      pending: [],
      completed: false,
      size: 1,
      children: [partChild("assistant-2", "grep-1")],
    },
  ])
})

function partChild(messageID: string, partID: string) {
  return { type: "entry" as const, entry: { type: "part" as const, ref: { messageID, partID } }, size: 1 as const }
}

test("renders a footer for a pre-output retry assistant after replay", () => {
  const message = assistant("assistant-retry", [])
  message.retry = {
    attempt: 2,
    at: 2_000,
    error: { type: "provider.transport", message: "Disconnected" },
  }

  expect(reduceSessionRows([message])).toEqual([{ type: "assistant-footer", messageID: "assistant-retry" }])
})

test("places a running compaction barrier before every queued user message", () => {
  const queued = (id: string, text: string, created: number): SessionMessageInfo => ({
    type: "user",
    id,
    text,
    time: { created },
  })
  const messages: SessionMessageInfo[] = [
    queued("user-before", "Before", 1),
    {
      type: "compaction",
      id: "compaction",
      status: "running",
      reason: "manual",
      summary: "",
      recent: "",
      time: { created: 2 },
    },
    queued("user-after", "After", 3),
  ]

  expect(reduceSessionRows(messages, new Set(["user-before", "user-after"]))).toEqual([
    { type: "message", messageID: "compaction" },
    { type: "message", messageID: "user-before" },
    { type: "message", messageID: "user-after" },
  ])
})

function assistant(id: string, content: SessionMessageAssistant["content"]): SessionMessageAssistant {
  return {
    type: "assistant",
    id,
    agent: "build",
    model: { id: "model", providerID: "provider" },
    content,
    time: { created: 1 },
  }
}

function pending() {
  return { status: "streaming" as const, input: "" }
}
