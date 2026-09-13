import { describe, expect, test } from "bun:test"
import type {
  SessionMessageAssistant,
  SessionMessageAssistantTool,
  SessionMessageInfo,
} from "@opencode/client/promise"
import { storyDocument, storyTool } from "../storybook/current-session-scenarios"
import { createTimelineProjection, Timeline, TimelineRow } from "./projection"

describe("current session timeline rows", () => {
  test("derives turns and tagged rows from chronological current messages", () => {
    const source = [
      { id: "msg_1", type: "user", text: "first", time: { created: 1 } },
      {
        id: "msg_2",
        type: "assistant",
        agent: "build",
        model: { id: "model", providerID: "provider" },
        content: [{ type: "text", text: "answer" }],
        time: { created: 2, completed: 3 },
      },
      { id: "msg_3", type: "user", text: "second", time: { created: 4 } },
      {
        id: "msg_4",
        type: "assistant",
        agent: "build",
        model: { id: "model", providerID: "provider" },
        content: [{ type: "reasoning", text: "working" }],
        time: { created: 5 },
      },
    ] satisfies SessionMessageInfo[]
    const result = Timeline.constructSessionMessageRows(source, true, { type: "busy" })

    expect(result.activeMessageID).toBe("msg_3")
    expect(result.rows.map(TimelineRow.key)).toEqual([
      "user-message:msg_1",
      "assistant-part:part:part:msg_2:msg_2:text:0",
      "turn-gap:msg_3",
      "user-message:msg_3",
      "thinking:msg_3",
    ])
  })

  test("renders a current shell message as a standalone turn", () => {
    const source = [
      {
        id: "msg_shell",
        type: "shell",
        shellID: "shell_1",
        command: "pwd",
        status: "exited",
        exit: 0,
        output: { output: "/repo", cursor: 5, size: 5, truncated: false },
        time: { created: 1, completed: 2 },
      },
      {
        id: "msg_shell_completion",
        type: "synthetic",
        text: "User shell pwd completed: /repo",
        metadata: { source: "shell", shellID: "shell_1", state: "completed" },
        time: { created: 3 },
      },
    ] satisfies SessionMessageInfo[]
    const result = Timeline.constructSessionMessageRows(source, true, { type: "idle" })

    expect(result.activeMessageID).toBe("msg_shell")
    expect(result.rows.map(TimelineRow.key)).toEqual(["shell:msg_shell"])
  })

  test("keeps assistant content when no user root is available", () => {
    const source = [
      {
        id: "msg_notice",
        type: "synthetic",
        text: "done",
        description: "Background work completed",
        time: { created: 1 },
      },
      {
        id: "msg_assistant",
        type: "assistant",
        agent: "build",
        model: { id: "model", providerID: "provider" },
        content: [{ type: "text", text: "result" }],
        time: { created: 2, completed: 3 },
      },
    ] satisfies SessionMessageInfo[]

    const result = Timeline.constructSessionMessageRows(source, true, { type: "idle" })

    expect(result.activeMessageID).toBe("msg_assistant")
    expect(result.rows.map(TimelineRow.key)).toEqual([
      "notice:msg_notice",
      "assistant-part:part:part:msg_assistant:msg_assistant:text:0",
    ])
  })

  test("keeps CLI notice messages between the assistant steps they surround", () => {
    const source = [
      { id: "msg_user", type: "user", text: "run", time: { created: 1 } },
      { id: "msg_agent", type: "agent-switched", agent: "explore", time: { created: 2 } },
      {
        id: "msg_assistant_1",
        type: "assistant",
        agent: "explore",
        model: { id: "model", providerID: "provider" },
        content: [{ type: "text", text: "started" }],
        time: { created: 3, completed: 4 },
      },
      {
        id: "msg_background",
        type: "synthetic",
        text: "result",
        description: "Search code",
        metadata: { source: "subagent", agent: "explore", state: "completed" },
        time: { created: 5 },
      },
      {
        id: "msg_model",
        type: "model-switched",
        model: { id: "next", providerID: "provider" },
        time: { created: 6 },
      },
      {
        id: "msg_assistant_2",
        type: "assistant",
        agent: "explore",
        model: { id: "next", providerID: "provider" },
        content: [{ type: "text", text: "finished" }],
        time: { created: 7, completed: 8 },
      },
      {
        id: "msg_restart",
        type: "synthetic",
        text: "continue",
        description: "Continuing after restart",
        time: { created: 9 },
      },
      { id: "msg_skill", type: "skill", skill: "review", name: "Review", text: "instructions", time: { created: 10 } },
      {
        id: "msg_compaction",
        type: "compaction",
        status: "completed",
        reason: "auto",
        summary: "summary",
        recent: "recent",
        time: { created: 11 },
      },
    ] satisfies SessionMessageInfo[]
    const result = Timeline.constructSessionMessageRows(source, true, { type: "idle" })

    expect(result.rows.map(TimelineRow.key)).toEqual([
      "user-message:msg_user",
      "notice:msg_agent",
      "assistant-part:part:part:msg_assistant_1:msg_assistant_1:text:0",
      "notice:msg_background",
      "notice:msg_model",
      "assistant-part:part:part:msg_assistant_2:msg_assistant_2:text:0",
      "notice:msg_restart",
      "notice:msg_skill",
      "notice:msg_compaction",
    ])
  })

  test("does not infer thinking from an optimistic busy turn", () => {
    const source = [
      { id: "msg_z", type: "user", text: "existing", time: { created: 1 } },
      { id: "msg_a", type: "user", text: "pending", time: { created: 2 } },
    ] satisfies SessionMessageInfo[]
    const result = Timeline.constructSessionMessageRows(source, true, { type: "busy" })

    expect(result.activeMessageID).toBe("msg_a")
    expect(result.rows.map(TimelineRow.key)).toEqual(["user-message:msg_z", "turn-gap:msg_a", "user-message:msg_a"])
  })

  test("does not infer thinking above a queued user message", () => {
    const source = [
      { id: "msg_active", type: "user", text: "active", time: { created: 1 } },
      { id: "msg_queued", type: "user", text: "queued", time: { created: 2 } },
    ] satisfies SessionMessageInfo[]
    const result = Timeline.constructSessionMessageRows(source, true, { type: "busy" }, new Set(["msg_queued"]))

    expect(result.activeMessageID).toBe("msg_active")
    expect(result.rows.map(TimelineRow.key)).toEqual([
      "user-message:msg_active",
      "turn-gap:msg_queued",
      "user-message:msg_queued",
    ])
  })

  test("suppresses thinking while a subagent is delegating or running", () => {
    const statuses = ["streaming", "running"] as const
    statuses.forEach((status) => {
      const source = [
        { id: "msg_user", type: "user", text: "delegate", time: { created: 1 } },
        {
          id: "msg_assistant",
          type: "assistant",
          agent: "build",
          model: { id: "model", providerID: "provider" },
          content: [
            {
              type: "tool",
              id: "tool_subagent",
              name: "subagent",
              state:
                status === "streaming"
                  ? { status, input: "" }
                  : { status, input: { description: "Inspect code" }, metadata: {} },
              time: { created: 2 },
            },
          ],
          time: { created: 2 },
        },
      ] satisfies SessionMessageInfo[]

      expect(Timeline.constructSessionMessageRows(source, true, { type: "busy" }).rows.map((row) => row._tag)).toEqual([
        "UserMessage",
        "AssistantPart",
      ])
    })
  })

  test("renders retry state from the current assistant message", () => {
    const source = [
      { id: "msg_user", type: "user", text: "retry", time: { created: 1 } },
      {
        id: "msg_assistant",
        type: "assistant",
        agent: "build",
        model: { id: "model", providerID: "provider" },
        content: [],
        retry: { attempt: 2, at: 10, error: { type: "ProviderError", message: "rate limited" } },
        time: { created: 2 },
      },
    ] satisfies SessionMessageInfo[]

    const result = Timeline.constructSessionMessageRows(source, true, { type: "busy" })

    expect(result.rows.map((row) => row._tag)).toEqual(["UserMessage", "Retry"])
  })

  test.each(["hidden", "compact", "full"] as const)("only shows active reasoning in %s mode", (reasoningMode) => {
    const active = { type: "reasoning", text: "## Current thought", time: { created: 2 } } as const
    const cases: { content: SessionMessageAssistant["content"]; thinking: boolean }[] = [
      { content: [], thinking: false },
      { content: [active], thinking: true },
      { content: [{ ...active, text: "" }], thinking: true },
      { content: [{ ...active, time: { created: 2, completed: 3 } }], thinking: false },
      { content: [active, { type: "text", text: "Answer" }], thinking: false },
      ...(["streaming", "running", "completed", "error"] as const).flatMap((status) =>
        ["shell", "read", "subagent", "question"].map((name) => ({
          content: [active, storyTool("tool", name, status, {})],
          thinking: false,
        })),
      ),
    ]
    cases.forEach((profile) => {
      const document = storyDocument(profile.content, true)
      const result = createTimelineProjection({
        sessionMessages: document.messages,
        status: document.status,
        reasoningMode,
      })
      expect(result.rows.some((row) => row._tag === "Thinking")).toBe(reasoningMode !== "hidden" && profile.thinking)
    })
  })

  test("stops thinking on idle, message completion, errors and retries", () => {
    const document = storyDocument([{ type: "reasoning", text: "Current thought" }], true)
    expect(
      Timeline.constructSessionMessageRows(document.messages, true, { type: "idle" }).rows.map((row) => row._tag),
    ).toEqual(["UserMessage", "AssistantPart"])
    const endings = [
      { time: { created: 1, completed: 2 } },
      { error: { type: "Interrupted", message: "Stopped" } },
      { retry: { attempt: 1, at: 10, error: { type: "ProviderError", message: "Retry" } } },
    ]
    endings.forEach((ending) => {
      const messages = document.messages.map((message) =>
        message.type === "assistant" ? { ...message, ...ending } : message,
      )
      expect(
        Timeline.constructSessionMessageRows(messages, true, { type: "busy" }).rows.some(
          (row) => row._tag === "Thinking",
        ),
      ).toBe(false)
    })
  })

  test("uses the latest reasoning part and groups earlier thoughts with tools", () => {
    const document = storyDocument(
      [
        { type: "reasoning", text: "Old thought", time: { created: 1, completed: 2 } },
        storyTool("read", "read", "completed", {}),
        { type: "reasoning", text: "New thought", time: { created: 3 } },
      ],
      true,
    )
    const result = Timeline.constructSessionMessageRows(document.messages, true, { type: "busy" })
    expect(result.rows.map((row) => row._tag)).toEqual(["UserMessage", "AssistantPart", "Thinking"])
    expect(result.rows[1]).toMatchObject({
      group: { type: "context", refs: [{ partID: "msg_tool_projection_assistant:reasoning:0" }, { partID: "read" }] },
    })
    expect(result.rows[2]).toMatchObject({ ref: { partID: "msg_tool_projection_assistant:reasoning:1" } })
  })

  test("keeps actual thinking with the active prompt above an undelivered prompt", () => {
    const document = storyDocument([{ type: "reasoning", text: "Active thought" }], true)
    const result = Timeline.constructSessionMessageRows(
      [...document.messages, { type: "user", id: "queued", text: "Next task", time: { created: 10 } }],
      true,
      document.status,
      new Set(["queued"]),
    )
    expect(result.rows.map((row) => row._tag)).toEqual(["UserMessage", "Thinking", "TurnGap", "UserMessage"])
    expect(result.rows[1].userMessageID).toBe(document.messages[0].id)
  })

  test.each(["shell", "execute", "subagent"])("does not hide active %s behind a preceding thought", (name) => {
    const document = storyDocument(
      [
        { type: "reasoning", text: "Finished thought", time: { created: 1, completed: 2 } },
        storyTool("active", name, "running", {}),
      ],
      true,
    )
    const result = Timeline.constructSessionMessageRows(document.messages, true, document.status)
    expect(result.rows.flatMap((row) => (row._tag === "AssistantPart" ? [row.group.type] : []))).toEqual([
      "part",
      "part",
    ])
  })

  test("keeps assistant errors and retries before later notices", () => {
    const result = Timeline.constructSessionMessageRows(
      [
        { id: "msg_user", type: "user", text: "continue", time: { created: 1 } },
        {
          id: "msg_blocked",
          type: "assistant",
          agent: "build",
          model: { id: "model", providerID: "provider" },
          content: [{ type: "text", text: "partial" }],
          error: { type: "provider.content-filter", message: "Provider blocked the response" },
          time: { created: 2, completed: 3 },
        },
        {
          id: "msg_model",
          type: "model-switched",
          model: { id: "next", providerID: "provider" },
          time: { created: 4 },
        },
      ],
      true,
      { type: "idle" },
    )

    expect(result.rows.map((row) => row._tag)).toEqual(["UserMessage", "AssistantPart", "Error", "Notice"])

    const retry = Timeline.constructSessionMessageRows(
      [
        { id: "msg_user", type: "user", text: "retry", time: { created: 1 } },
        {
          id: "msg_retry",
          type: "assistant",
          agent: "build",
          model: { id: "model", providerID: "provider" },
          content: [],
          error: { type: "ProviderError", message: "rate limited" },
          retry: { attempt: 2, at: 10, error: { type: "ProviderError", message: "rate limited" } },
          time: { created: 2 },
        },
        {
          id: "msg_model",
          type: "model-switched",
          model: { id: "next", providerID: "provider" },
          time: { created: 3 },
        },
      ],
      true,
      { type: "retry", attempt: 2, next: 10, message: "rate limited" },
    )

    expect(retry.rows.map((row) => row._tag)).toEqual(["UserMessage", "Retry", "Notice"])
  })

  test("suppresses an earlier error when the turn recovers across a notice", () => {
    const source = [
      { id: "msg_user", type: "user", text: "recover", time: { created: 1 } },
      {
        id: "msg_failed",
        type: "assistant",
        agent: "build",
        model: { id: "model", providerID: "provider" },
        content: [],
        error: { type: "ProviderError", message: "temporary failure" },
        time: { created: 2, completed: 3 },
      },
      {
        id: "msg_model",
        type: "model-switched",
        model: { id: "next", providerID: "provider" },
        time: { created: 4 },
      },
      {
        id: "msg_recovery",
        type: "assistant",
        agent: "build",
        model: { id: "next", providerID: "provider" },
        content: [{ type: "text", text: "recovered" }],
        time: { created: 5, completed: 6 },
      },
    ] satisfies SessionMessageInfo[]

    expect(Timeline.constructSessionMessageRows(source, true, { type: "idle" }).rows.map((row) => row._tag)).toEqual([
      "UserMessage",
      "Notice",
      "AssistantPart",
    ])
  })

  test("does not render the retry error twice", () => {
    const source = [
      { id: "msg_user", type: "user", text: "retry", time: { created: 1 } },
      {
        id: "msg_assistant",
        type: "assistant",
        agent: "build",
        model: { id: "model", providerID: "provider" },
        content: [],
        error: { type: "ProviderError", message: "The provider response ended unexpectedly." },
        retry: {
          attempt: 2,
          at: 10,
          error: { type: "ProviderError", message: "The provider response ended unexpectedly." },
        },
        time: { created: 2 },
      },
    ] satisfies SessionMessageInfo[]

    const result = Timeline.constructSessionMessageRows(source, true, {
      type: "retry",
      attempt: 2,
      next: 10,
      message: "The provider response ended unexpectedly.",
    })

    expect(result.rows.map((row) => row._tag)).toEqual(["UserMessage", "Retry"])
  })

  test("removes a failed assistant error when the turn continues streaming", () => {
    const source = [
      { id: "msg_user", type: "user", text: "recover", time: { created: 1 } },
      {
        id: "msg_failed",
        type: "assistant",
        agent: "build",
        model: { id: "model", providerID: "provider" },
        content: [],
        error: { type: "ProviderError", message: "temporary failure" },
        time: { created: 2, completed: 3 },
      },
      {
        id: "msg_recovery",
        type: "assistant",
        agent: "build",
        model: { id: "model", providerID: "provider" },
        content: [{ type: "text", text: "streaming again" }],
        time: { created: 4 },
      },
    ] satisfies SessionMessageInfo[]
    const result = Timeline.constructSessionMessageRows(source, true, { type: "busy" })

    expect(result.rows.map((row) => row._tag)).toEqual(["UserMessage", "AssistantPart"])
  })

  test("keeps content IDs and groups adjacent context tools", () => {
    const source = [
      { id: "msg_user", type: "user", text: "inspect", time: { created: 1 } },
      {
        id: "msg_assistant",
        type: "assistant",
        agent: "build",
        model: { id: "model", providerID: "provider" },
        content: [
          { type: "text", text: " " },
          { type: "reasoning", text: "hidden" },
          {
            type: "tool",
            id: "tool_read",
            name: "read",
            state: { status: "running", input: {}, metadata: {} },
            time: { created: 2 },
          },
          {
            type: "tool",
            id: "tool_grep",
            name: "grep",
            state: { status: "running", input: {}, metadata: {} },
            time: { created: 3 },
          },
          {
            type: "tool",
            id: "tool_todo",
            name: "todowrite",
            state: { status: "running", input: {}, metadata: {} },
            time: { created: 4 },
          },
          {
            type: "tool",
            id: "tool_question",
            name: "question",
            state: { status: "streaming", input: "" },
            time: { created: 5 },
          },
          { type: "text", text: "visible" },
        ],
        time: { created: 2 },
      },
    ] satisfies SessionMessageInfo[]

    const result = Timeline.constructSessionMessageRows(source, false, { type: "idle" })
    const groups = result.rows.flatMap((row) => (row._tag === "AssistantPart" ? [row.group] : []))

    expect(groups).toEqual([
      {
        type: "context",
        key: "context:msg_assistant:tool_read",
        refs: [
          { messageID: "msg_assistant", partID: "tool_read" },
          { messageID: "msg_assistant", partID: "tool_grep" },
        ],
      },
      {
        type: "part",
        key: "part:msg_assistant:msg_assistant:text:1",
        ref: { messageID: "msg_assistant", partID: "msg_assistant:text:1" },
      },
    ])
  })

  test("keeps reads that load files outside context groups", () => {
    const read = {
      type: "tool",
      id: "tool_read",
      name: "read",
      state: {
        status: "completed",
        input: { path: "packages/cli/AGENTS.md" },
        content: [{ type: "text", text: "instructions" }],
        metadata: { loaded: ["packages/cli/AGENTS.md"] },
      },
      time: { created: 2, ran: 3, completed: 4 },
    } satisfies SessionMessageAssistantTool
    const grep = {
      type: "tool",
      id: "tool_grep",
      name: "grep",
      state: { status: "running", input: {}, metadata: {} },
      time: { created: 5 },
    } satisfies SessionMessageAssistantTool
    const source = [
      { id: "msg_user", type: "user", text: "inspect", time: { created: 1 } },
      {
        id: "msg_assistant",
        type: "assistant",
        agent: "build",
        model: { id: "model", providerID: "provider" },
        content: [read, grep],
        time: { created: 2 },
      },
    ] satisfies SessionMessageInfo[]

    const groups = Timeline.constructSessionMessageRows(source, false, { type: "idle" }).rows.flatMap((row) =>
      row._tag === "AssistantPart" ? [row.group] : [],
    )

    expect(groups).toEqual([
      {
        type: "part",
        key: "part:msg_assistant:tool_read",
        ref: { messageID: "msg_assistant", partID: "tool_read" },
      },
      {
        type: "context",
        key: "context:msg_assistant:tool_grep",
        refs: [{ messageID: "msg_assistant", partID: "tool_grep" }],
      },
    ])
  })

  test("keeps context row keys unique when tool IDs repeat across assistant messages", () => {
    const tool = (name: string) => ({
      type: "tool" as const,
      id: "tool_0",
      name,
      state: { status: "running" as const, input: {}, metadata: {} },
      time: { created: 2 },
    })
    const assistant = (id: string, name: string) => ({
      id,
      type: "assistant" as const,
      agent: "build",
      model: { id: "model", providerID: "provider" },
      content: [tool(name)],
      time: { created: 2 },
    })
    const source = [
      { id: "msg_user", type: "user", text: "inspect", time: { created: 1 } },
      assistant("msg_assistant_1", "read"),
      assistant("msg_assistant_2", "execute"),
      assistant("msg_assistant_3", "grep"),
    ] satisfies SessionMessageInfo[]

    const keys = Timeline.constructSessionMessageRows(source, false, { type: "idle" }, undefined, true).rows.map(
      TimelineRow.key,
    )

    expect(keys).toEqual([
      "user-message:msg_user",
      "assistant-part:context:context:msg_assistant_1:tool_0",
      "assistant-part:part:part:msg_assistant_2:tool_0",
      "assistant-part:context:context:msg_assistant_3:tool_0",
    ])
  })

  test("groups adjacent successful patches and leaves failed patches separate", () => {
    const source = [
      { id: "msg_user", type: "user", text: "edit", time: { created: 1 } },
      {
        id: "msg_assistant",
        type: "assistant",
        agent: "build",
        model: { id: "model", providerID: "provider" },
        content: [
          {
            type: "tool",
            id: "tool_patch_1",
            name: "patch",
            state: {
              status: "completed",
              input: {},
              content: [{ type: "text", text: "done" }],
              metadata: { files: [] },
            },
            time: { created: 2, completed: 3 },
          },
          {
            type: "tool",
            id: "tool_patch_2",
            name: "patch",
            state: { status: "running", input: {}, metadata: { files: [] } },
            time: { created: 4 },
          },
          {
            type: "tool",
            id: "tool_patch_failed",
            name: "patch",
            state: {
              status: "error",
              input: {},
              error: { type: "ToolError", message: "failed" },
              metadata: { files: [] },
            },
            time: { created: 5, completed: 6 },
          },
          {
            type: "tool",
            id: "tool_patch_3",
            name: "patch",
            state: {
              status: "completed",
              input: {},
              content: [{ type: "text", text: "done" }],
              metadata: { files: [] },
            },
            time: { created: 7, completed: 8 },
          },
          {
            type: "tool",
            id: "tool_edit_1",
            name: "edit",
            state: { status: "running", input: {}, metadata: { files: [] } },
            time: { created: 9 },
          },
          {
            type: "tool",
            id: "tool_edit_2",
            name: "edit",
            state: { status: "running", input: {}, metadata: { files: [] } },
            time: { created: 10 },
          },
          {
            type: "tool",
            id: "tool_write_1",
            name: "write",
            state: { status: "running", input: {}, metadata: { files: [] } },
            time: { created: 11 },
          },
        ],
        time: { created: 2, completed: 8 },
      },
    ] satisfies SessionMessageInfo[]

    const result = Timeline.constructSessionMessageRows(source, false, { type: "idle" }, undefined, false, true)
    const groups = result.rows.flatMap((row) => (row._tag === "AssistantPart" ? [row.group] : []))

    expect(groups).toEqual([
      {
        type: "file",
        key: "part:msg_assistant:tool_patch_1",
        refs: [
          { messageID: "msg_assistant", partID: "tool_patch_1" },
          { messageID: "msg_assistant", partID: "tool_patch_2" },
        ],
      },
      {
        type: "part",
        key: "part:msg_assistant:tool_patch_failed",
        ref: { messageID: "msg_assistant", partID: "tool_patch_failed" },
      },
      {
        type: "file",
        key: "part:msg_assistant:tool_patch_3",
        refs: [
          { messageID: "msg_assistant", partID: "tool_patch_3" },
          { messageID: "msg_assistant", partID: "tool_edit_1" },
          { messageID: "msg_assistant", partID: "tool_edit_2" },
          { messageID: "msg_assistant", partID: "tool_write_1" },
        ],
      },
    ])
  })

  test("groups every consecutive collapsed tool in chronological order", () => {
    const source = [
      { id: "msg_user", type: "user", text: "work", time: { created: 1 } },
      {
        id: "msg_assistant",
        type: "assistant",
        agent: "build",
        model: { id: "model", providerID: "provider" },
        content: [
          ...["shell", "subagent", "patch", "shell", "edit", "write", "grep"].map(
            (name, index): SessionMessageAssistantTool => ({
              type: "tool" as const,
              id: `tool_${index}`,
              name,
              state: {
                status: "completed" as const,
                input: {},
                content: [{ type: "text" as const, text: "done" }],
                metadata: {},
              },
              time: { created: index + 2, completed: index + 3 },
            }),
          ),
          { type: "text" as const, text: "finished" },
          {
            type: "tool" as const,
            id: "tool_after_text",
            name: "shell",
            state: {
              status: "completed" as const,
              input: {},
              content: [{ type: "text" as const, text: "done" }],
              metadata: {},
            },
            time: { created: 10, completed: 11 },
          },
        ],
        time: { created: 2 },
      },
    ] satisfies SessionMessageInfo[]

    const groups = Timeline.constructSessionMessageRows(source, false, { type: "idle" }).rows.flatMap((row) =>
      row._tag === "AssistantPart" ? [row.group] : [],
    )

    expect(groups.map((group) => group.type)).toEqual(["context", "part", "context"])
    expect(groups[0]?.type === "context" ? groups[0].refs.map((ref) => ref.partID) : []).toEqual([
      "tool_0",
      "tool_1",
      "tool_2",
      "tool_3",
      "tool_4",
      "tool_5",
      "tool_6",
    ])
    expect(groups[2]?.type === "context" ? groups[2].refs.map((ref) => ref.partID) : []).toEqual(["tool_after_text"])
  })

  test.each([
    { shell: false, edit: false, types: ["context"] },
    { shell: true, edit: false, types: ["part", "context"] },
    { shell: false, edit: true, types: ["context", "file", "context"] },
    { shell: true, edit: true, types: ["part", "file", "context"] },
  ])("keeps tools expanded by settings outside collapsed groups ($shell, $edit)", ({ shell, edit, types }) => {
    const source = [
      { id: "msg_user", type: "user", text: "work", time: { created: 1 } },
      {
        id: "msg_assistant",
        type: "assistant",
        agent: "build",
        model: { id: "model", providerID: "provider" },
        content: ["shell", "edit", "write", "patch", "read"].map(
          (name, index): SessionMessageAssistantTool => ({
            type: "tool" as const,
            id: `tool_${name}`,
            name,
            state: {
              status: "completed" as const,
              input: {},
              content: [{ type: "text" as const, text: "done" }],
              metadata: {},
            },
            time: { created: index + 2, completed: index + 3 },
          }),
        ),
        time: { created: 2 },
      },
    ] satisfies SessionMessageInfo[]

    const rows = Timeline.constructSessionMessageRows(source, false, { type: "idle" }, undefined, shell, edit).rows

    expect(rows.flatMap((row) => (row._tag === "AssistantPart" ? [row.group.type] : []))).toEqual([...types])
  })

  test.each(["shell", "execute", "subagent"])("keeps %s in an existing group throughout execution", (name) => {
    const initial = createTimelineProjection({
      sessionMessages: storyDocument([storyTool("earlier", "read", "completed", {})]).messages,
      status: { type: "busy" },
      reasoningMode: "hidden",
    })
    const phases = [
      { status: "streaming" },
      { status: "running" },
      { status: "completed", metadata: { status: "running" } },
      { status: "completed" },
      { status: "error" },
    ] as const
    phases.reduce((previousRows, phase, index) => {
      const result = createTimelineProjection({
        sessionMessages: [
          ...storyDocument([storyTool("earlier", "read", "completed", {})]).messages,
          ...storyDocument([
            storyTool("active", name, phase.status, {}, "metadata" in phase ? { metadata: phase.metadata } : {}),
          ])
            .messages.filter((message) => message.type === "assistant")
            .map((message) => ({ ...message, id: "next-step" })),
        ],
        status: { type: "busy" },
        reasoningMode: "hidden",
        previousRows,
      })
      const groups = result.rows.filter((row) => row._tag === "AssistantPart")
      expect(groups).toHaveLength(1)
      expect(groups[0].group).toMatchObject({
        type: "context",
        refs: [
          { messageID: "msg_tool_projection_assistant", partID: "earlier" },
          { messageID: "next-step", partID: "active" },
        ],
      })
      expect(TimelineRow.key(groups[0])).toBe(TimelineRow.key(initial.rows[1]))
      if (index > 0) expect(groups[0]).toBe(previousRows.find((row) => row._tag === "AssistantPart")!)
      return result.rows
    }, initial.rows)
  })

  test.each([
    { name: "shell", expanded: true, types: ["context", "part"] },
    { name: "execute", expanded: true, types: ["context", "part"] },
    { name: "subagent", expanded: true, types: ["context"] },
    { name: "shell", separator: "text", types: ["context", "part", "part"] },
    { name: "shell", separator: "reasoning", showReasoning: true, types: ["context"] },
    { name: "shell", separator: "reasoning", showReasoning: false, types: ["context"] },
  ] as const)("respects active tool grouping boundaries: %j", (profile) => {
    const content = [
      storyTool("earlier", "read", "completed", {}),
      ...(profile.separator ? [{ type: profile.separator, text: "Visible boundary" }] : []),
      storyTool("active", profile.name, "running", {}),
    ]
    const rows = Timeline.constructSessionMessageRows(
      storyDocument(content).messages,
      profile.showReasoning ?? false,
      { type: "busy" },
      undefined,
      profile.expanded ?? false,
    ).rows
    expect(rows.flatMap((row) => (row._tag === "AssistantPart" ? [row.group.type] : []))).toEqual([...profile.types])
  })

  test("keeps active and background work standalone when no group precedes them", () => {
    const source: SessionMessageInfo[] = [
      { id: "msg_user", type: "user", text: "work", time: { created: 1 } },
      {
        id: "msg_assistant",
        type: "assistant",
        agent: "build",
        model: { id: "model", providerID: "provider" },
        content: [
          {
            type: "tool",
            id: "tool_running_shell",
            name: "shell",
            state: { status: "running", input: {}, metadata: {} },
            time: { created: 2 },
          },
          {
            type: "tool",
            id: "tool_background_agent",
            name: "subagent",
            state: {
              status: "completed",
              input: {},
              content: [{ type: "text", text: "running" }],
              metadata: { status: "running" },
            },
            time: { created: 3, completed: 4 },
          },
          {
            type: "tool",
            id: "tool_completed_shell",
            name: "shell",
            state: {
              status: "completed",
              input: {},
              content: [{ type: "text", text: "done" }],
              metadata: {},
            },
            time: { created: 5, completed: 6 },
          },
        ],
        time: { created: 2 },
      },
    ]

    expect(
      Timeline.constructSessionMessageRows(source, false, { type: "busy" }).rows.flatMap((row) =>
        row._tag === "AssistantPart" ? [row.group.type] : [],
      ),
    ).toEqual(["part", "part", "context"])
  })

  test("keeps failed calls inside a collapsed mixed-tool stack", () => {
    const source: SessionMessageInfo[] = [
      { id: "msg_user", type: "user", text: "search", time: { created: 1 } },
      {
        id: "msg_assistant",
        type: "assistant",
        agent: "build",
        model: { id: "model", providerID: "provider" },
        content: [
          {
            type: "tool",
            id: "tool_glob_failed",
            name: "glob",
            state: {
              status: "error",
              input: { pattern: "*.ts" },
              error: { type: "ToolError", message: "Invalid tool input" },
              metadata: {},
            },
            time: { created: 2, completed: 3 },
          },
          {
            type: "tool",
            id: "tool_grep_failed",
            name: "grep",
            state: {
              status: "error",
              input: { pattern: "value" },
              error: { type: "ToolError", message: "Search timed out" },
              metadata: {},
            },
            time: { created: 4, completed: 5 },
          },
          {
            type: "tool",
            id: "tool_shell_failed",
            name: "shell",
            state: {
              status: "error",
              input: { command: "exit 1" },
              error: { type: "ToolError", message: "Command failed" },
              metadata: {},
            },
            time: { created: 6, completed: 7 },
          },
        ],
        time: { created: 2, completed: 8 },
      },
    ]

    const groups = Timeline.constructSessionMessageRows(source, false, { type: "idle" }).rows.flatMap((row) =>
      row._tag === "AssistantPart" ? [row.group] : [],
    )

    expect(groups).toEqual([
      {
        type: "context",
        key: "context:msg_assistant:tool_glob_failed",
        refs: [
          { messageID: "msg_assistant", partID: "tool_glob_failed" },
          { messageID: "msg_assistant", partID: "tool_grep_failed" },
          { messageID: "msg_assistant", partID: "tool_shell_failed" },
        ],
      },
    ])
    expect(
      Timeline.constructSessionMessageRows(source, false, { type: "idle" }, undefined, true).rows.flatMap((row) =>
        row._tag === "AssistantPart" ? [row.group.type] : [],
      ),
    ).toEqual(["context", "part"])
  })

  test("places a divider after interrupted output unless the turn compacts", () => {
    const messages = [
      { id: "msg_user", type: "user", text: "continue", time: { created: 1 } },
      {
        id: "msg_interrupted",
        type: "assistant",
        agent: "build",
        model: { id: "model", providerID: "provider" },
        content: [{ type: "text", text: "before" }],
        error: { type: "ExecutionInterrupted", message: "stopped" },
        time: { created: 2, completed: 3 },
      },
      {
        id: "msg_continued",
        type: "assistant",
        agent: "build",
        model: { id: "model", providerID: "provider" },
        content: [{ type: "text", text: "after" }],
        time: { created: 4, completed: 5 },
      },
    ] satisfies SessionMessageInfo[]

    expect(Timeline.constructSessionMessageRows(messages, true, { type: "idle" }).rows.map((row) => row._tag)).toEqual([
      "UserMessage",
      "AssistantPart",
      "TurnDivider",
      "AssistantPart",
    ])

    const compacted = [
      messages[0],
      messages[1],
      {
        id: "msg_compaction",
        type: "compaction",
        status: "completed",
        reason: "auto",
        summary: "summary",
        recent: "recent",
        time: { created: 4 },
      },
      messages[2],
    ] satisfies SessionMessageInfo[]

    expect(Timeline.constructSessionMessageRows(compacted, true, { type: "idle" }).rows.map((row) => row._tag)).toEqual(
      ["UserMessage", "AssistantPart", "Notice", "AssistantPart"],
    )
  })
})
