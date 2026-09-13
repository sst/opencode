import { describe, expect, test } from "bun:test"
import type { AgentSideConnection } from "@agentclientprotocol/sdk"
import type { SessionMessageInfo } from "@opencode/client/promise"
import { resolve } from "node:path"
import { replayMessages, streamTurn, type ChildSessionUpdate, type TurnControl } from "../../src/acp/event"
import { createSseFixture, durableEvent, ephemeralEvent, withTimeout } from "./sse-fixture"

type SessionUpdateParams = Parameters<AgentSideConnection["sessionUpdate"]>[0]
type Connection = Pick<AgentSideConnection, "sessionUpdate" | "requestPermission">
type Fixture = ReturnType<typeof createSseFixture>

describe("acp event behavior", () => {
  test("subscribes before admission and isolates sessions and input IDs", async () => {
    const updates: SessionUpdateParams[] = []
    const fixture = createSseFixture({
      onPrompt({ id, send }) {
        send(
          ephemeralEvent("session.text.delta", {
            sessionID: "ses_a",
            assistantMessageID: "msg_before",
            ordinal: 0,
            delta: "before admission",
          }),
        )
        send(durableEvent("session.inbox.delivered", { sessionID: "ses_b", inboxID: id }))
        send(durableEvent("session.inbox.delivered", { sessionID: "ses_a", inboxID: "input_other" }))
        send(
          ephemeralEvent("session.text.delta", {
            sessionID: "ses_a",
            assistantMessageID: "msg_wrong_input",
            ordinal: 0,
            delta: "wrong input",
          }),
        )
        send(durableEvent("session.inbox.delivered", { sessionID: "ses_a", inboxID: id }))
        send(
          ephemeralEvent("session.text.delta", {
            sessionID: "ses_b",
            assistantMessageID: "msg_b",
            ordinal: 0,
            delta: "other session",
          }),
        )
        send(
          ephemeralEvent("session.text.delta", {
            sessionID: "ses_a",
            assistantMessageID: "msg_a",
            ordinal: 0,
            delta: "accepted",
          }),
        )
        send(
          durableEvent("session.step.ended", {
            sessionID: "ses_a",
            assistantMessageID: "msg_a",
            finish: "stop",
            cost: 0,
            tokens: tokens(),
          }),
        )
        send(durableEvent("session.execution.succeeded", { sessionID: "ses_b" }))
        send(durableEvent("session.execution.succeeded", { sessionID: "ses_a" }))
      },
    })

    try {
      const response = await turn({
        fixture,
        connection: recordingConnection(updates),
        sessionID: "ses_a",
        inboxID: "input_a",
      })

      expect(fixture.requests.slice(0, 2).map((request) => request.path)).toEqual([
        "/api/event",
        "/api/session/ses_a/prompt",
      ])
      expect(updates).toEqual([
        {
          sessionId: "ses_a",
          update: {
            sessionUpdate: "agent_message_chunk",
            messageId: "msg_a",
            content: { type: "text", text: "accepted" },
          },
        },
      ])
      expect(response.stopReason).toBe("end_turn")
    } finally {
      await fixture.stop()
    }
  })

  test("preserves reasoning boundaries and update order during streaming and replay", async () => {
    const firstUpdate = Promise.withResolvers<void>()
    const releaseUpdate = Promise.withResolvers<void>()
    const allUpdates = Promise.withResolvers<void>()
    const releaseSubmit = Promise.withResolvers<void>()
    const updates: SessionUpdateParams[] = []
    const fixture = createSseFixture({
      async onPrompt({ id, send }) {
        send(durableEvent("session.inbox.delivered", { sessionID: "ses_order", inboxID: id }))
        send(
          ephemeralEvent("session.reasoning.delta", {
            sessionID: "ses_order",
            assistantMessageID: "msg_order",
            ordinal: 0,
            delta: "think-1",
          }),
        )
        send(
          ephemeralEvent("session.reasoning.delta", {
            sessionID: "ses_order",
            assistantMessageID: "msg_order",
            ordinal: 0,
            delta: " continued",
          }),
        )
        send(
          ephemeralEvent("session.text.delta", {
            sessionID: "ses_order",
            assistantMessageID: "msg_order",
            ordinal: 1,
            delta: "answer",
          }),
        )
        send(
          ephemeralEvent("session.reasoning.delta", {
            sessionID: "ses_order",
            assistantMessageID: "msg_order",
            ordinal: 1,
            delta: "think-2",
          }),
        )
        send(
          durableEvent("session.step.ended", {
            sessionID: "ses_order",
            assistantMessageID: "msg_order",
            finish: "stop",
            cost: 0,
            tokens: tokens(),
          }),
        )
        send(durableEvent("session.execution.succeeded", { sessionID: "ses_order" }))
        await releaseSubmit.promise
      },
    })
    const connection = {
      sessionUpdate: async (update) => {
        updates.push(update)
        if (updates.length === 1) {
          firstUpdate.resolve()
          await releaseUpdate.promise
        }
        if (updates.length === 4) allUpdates.resolve()
      },
      requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
    } satisfies Connection
    const result = turn({ fixture, connection, sessionID: "ses_order", inboxID: "input_order" })

    try {
      await withTimeout(firstUpdate.promise, "first ordered update was not delivered")
      expect(updates).toHaveLength(1)
      expect(fixture.requests.some((request) => request.path.includes("/message/"))).toBe(false)

      releaseUpdate.resolve()
      await withTimeout(allUpdates.promise, "ordered updates did not finish")
      expect(await Promise.race([result.then(() => "resolved"), Promise.resolve("pending")])).toBe("pending")
      expect(fixture.requests.some((request) => request.path.includes("/message/"))).toBe(false)

      releaseSubmit.resolve()
      const response = await withTimeout(result, "turn did not resolve after admission returned")

      expect(
        updates.map((item) => {
          if (
            item.update.sessionUpdate === "agent_message_chunk" ||
            item.update.sessionUpdate === "agent_thought_chunk"
          ) {
            return [
              item.update.sessionUpdate,
              item.update.messageId,
              item.update.content.type === "text" ? item.update.content.text : undefined,
            ]
          }
          return [item.update.sessionUpdate, undefined]
        }),
      ).toEqual([
        ["agent_thought_chunk", "msg_order:reasoning:0", "think-1"],
        ["agent_thought_chunk", "msg_order:reasoning:0", " continued"],
        ["agent_message_chunk", "msg_order", "answer"],
        ["agent_thought_chunk", "msg_order:reasoning:1", "think-2"],
      ])
      expect(fixture.requests.at(-1)?.path).toBe("/api/session/ses_order/message/msg_order")
      expect(response).toMatchObject({ stopReason: "end_turn", usage: { totalTokens: 2 } })

      const replayed: SessionUpdateParams[] = []
      await replayMessages(recordingConnection(replayed), "ses_order", "/workspace", [
        {
          id: "msg_order",
          type: "assistant",
          agent: "build",
          model: { providerID: "test", id: "test-model" },
          time: { created: 1 },
          content: [
            { type: "reasoning", text: "think-1 continued" },
            { type: "text", text: "answer" },
            { type: "reasoning", text: "think-2" },
          ],
        },
      ])
      expect(replayed).toEqual([
        {
          sessionId: "ses_order",
          update: {
            sessionUpdate: "agent_thought_chunk",
            messageId: "msg_order:reasoning:0",
            content: { type: "text", text: "think-1 continued" },
          },
        },
        updates[2],
        updates[3],
      ])
    } finally {
      releaseUpdate.resolve()
      releaseSubmit.resolve()
      await result.catch(() => undefined)
      await fixture.stop()
    }
  })

  test("projects foreground child session updates onto the parent turn", async () => {
    const updates: SessionUpdateParams[] = []
    const fixture = createSseFixture({
      onPrompt({ id, send }) {
        send(durableEvent("session.inbox.delivered", { sessionID: "ses_parent", inboxID: id }))
        send(
          durableEvent("session.created", {
            sessionID: "ses_child",
            ...childSession("ses_child", "ses_parent", "Explore code"),
          }),
        )
        send(durableEvent("session.execution.started", { sessionID: "ses_child" }))
        send(
          durableEvent("session.tool.input.started", {
            sessionID: "ses_child",
            assistantMessageID: "msg_child",
            id: "call_read",
            name: "read",
          }),
        )
        send(
          durableEvent("session.tool.called", {
            sessionID: "ses_child",
            assistantMessageID: "msg_child",
            id: "call_read",
            input: { path: "/workspace/src/index.ts" },
            executed: false,
          }),
        )
        send(
          durableEvent("session.tool.success", {
            sessionID: "ses_child",
            assistantMessageID: "msg_child",
            id: "call_read",
            metadata: {},
            content: [{ type: "text", text: "source" }],
            executed: true,
          }),
        )
        send(durableEvent("session.execution.succeeded", { sessionID: "ses_child" }))
        send(durableEvent("session.execution.succeeded", { sessionID: "ses_parent" }))
      },
    })

    try {
      const response = await turn({
        fixture,
        connection: recordingConnection(updates),
        sessionID: "ses_parent",
        inboxID: "input_parent",
      })

      expect(updates.map((item) => [item.sessionId, item.update.sessionUpdate])).toEqual([
        ["ses_parent", "tool_call"],
        ["ses_parent", "tool_call_update"],
        ["ses_parent", "tool_call_update"],
      ])
      expect(updates.map((item) => ("toolCallId" in item.update ? item.update.toolCallId : undefined))).toEqual([
        "ses_child:call_read",
        "ses_child:call_read",
        "ses_child:call_read",
      ])
      expect(updates[0]?.update).toMatchObject({
        title: "Explore code: read",
        _meta: {
          "opencode/child-session": {
            id: "ses_child",
            parentID: "ses_parent",
            depth: 1,
            title: "Explore code",
          },
        },
      })
      expect(response.stopReason).toBe("end_turn")
    } finally {
      await fixture.stop()
    }
  })

  test("continues child extension updates after the parent turn ends", async () => {
    const updates: SessionUpdateParams[] = []
    const childUpdates: ChildSessionUpdate[] = []
    const completed = Promise.withResolvers<void>()
    const fixture = createSseFixture({
      onPrompt({ id, send }) {
        send(durableEvent("session.inbox.delivered", { sessionID: "ses_parent", inboxID: id }))
        send(
          durableEvent("session.created", {
            sessionID: "ses_background",
            ...childSession("ses_background", "ses_parent", "Background research"),
          }),
        )
        send(durableEvent("session.execution.succeeded", { sessionID: "ses_parent" }))
      },
    })

    try {
      const response = await turn({
        fixture,
        connection: recordingConnection(updates),
        sessionID: "ses_parent",
        inboxID: "input_parent",
        childSessionUpdate: async (update) => {
          childUpdates.push(update)
          if (update.type === "status" && update.status === "completed") completed.resolve()
        },
      })
      expect(response.stopReason).toBe("end_turn")

      fixture.send(
        durableEvent("session.created", {
          sessionID: "ses_future",
          ...childSession("ses_future", "ses_parent", "Later turn child"),
        }),
      )
      fixture.send(durableEvent("session.execution.started", { sessionID: "ses_future" }))
      fixture.send(durableEvent("session.execution.started", { sessionID: "ses_background" }))
      fixture.send(
        durableEvent("session.tool.input.started", {
          sessionID: "ses_background",
          assistantMessageID: "msg_background",
          id: "call_shell",
          name: "shell",
        }),
      )
      fixture.send(
        durableEvent("session.tool.called", {
          sessionID: "ses_background",
          assistantMessageID: "msg_background",
          id: "call_shell",
          input: { command: "pwd" },
          executed: false,
        }),
      )
      fixture.send(
        durableEvent("session.tool.success", {
          sessionID: "ses_background",
          assistantMessageID: "msg_background",
          id: "call_shell",
          metadata: { exit: 0 },
          content: [{ type: "text", text: "/workspace" }],
          executed: true,
        }),
      )
      fixture.send(durableEvent("session.execution.succeeded", { sessionID: "ses_background" }))
      await withTimeout(completed.promise, "background child completion was not delivered")

      expect(updates).toEqual([])
      expect(
        childUpdates.map((update) =>
          update.type === "status" ? [update.type, update.status] : [update.type, update.update.sessionUpdate],
        ),
      ).toEqual([
        ["status", "created"],
        ["status", "running"],
        ["update", "tool_call"],
        ["update", "tool_call_update"],
        ["update", "tool_call_update"],
        ["status", "completed"],
      ])
      expect(childUpdates[2]).toMatchObject({
        rootSessionId: "ses_parent",
        childSessionId: "ses_background",
        parentSessionId: "ses_parent",
        depth: 1,
        title: "Background research",
        type: "update",
        update: { toolCallId: "ses_background:call_shell" },
      })
      expect(childUpdates.some((update) => update.childSessionId === "ses_future")).toBe(false)
    } finally {
      await fixture.stop()
    }
  })

  test("streams tool pending, progress, success, and failure updates", async () => {
    const updates: SessionUpdateParams[] = []
    const fixture = createSseFixture({
      onPrompt({ id, send }) {
        send(durableEvent("session.inbox.delivered", { sessionID: "ses_tools", inboxID: id }))
        send(
          durableEvent("session.tool.input.started", {
            sessionID: "ses_tools",
            assistantMessageID: "msg_tools",
            id: "call_ok",
            name: "shell",
          }),
        )
        send(
          durableEvent("session.tool.called", {
            sessionID: "ses_tools",
            assistantMessageID: "msg_tools",
            id: "call_ok",
            input: { command: "printf done", workdir: "sub" },
            executed: false,
          }),
        )
        send(
          ephemeralEvent("session.tool.progress", {
            sessionID: "ses_tools",
            assistantMessageID: "msg_tools",
            id: "call_ok",
            metadata: { phase: 1 },
          }),
        )
        send(
          durableEvent("session.tool.success", {
            sessionID: "ses_tools",
            assistantMessageID: "msg_tools",
            id: "call_ok",
            metadata: { exit: 0 },
            content: [{ type: "text", text: "done" }],
            executed: true,
          }),
        )
        send(
          durableEvent("session.tool.input.started", {
            sessionID: "ses_tools",
            assistantMessageID: "msg_tools",
            id: "call_fail",
            name: "read",
          }),
        )
        send(
          durableEvent("session.tool.called", {
            sessionID: "ses_tools",
            assistantMessageID: "msg_tools",
            id: "call_fail",
            input: { path: "/workspace/missing.ts" },
            executed: false,
          }),
        )
        send(
          ephemeralEvent("session.tool.progress", {
            sessionID: "ses_tools",
            assistantMessageID: "msg_tools",
            id: "call_fail",
            metadata: { bytes: 0 },
          }),
        )
        send(
          durableEvent("session.tool.failed", {
            sessionID: "ses_tools",
            assistantMessageID: "msg_tools",
            id: "call_fail",
            error: { type: "tool.error", message: "not found" },
            metadata: { bytes: 0 },
            content: [{ type: "text", text: "opening" }],
            executed: true,
          }),
        )
        send(
          durableEvent("session.step.ended", {
            sessionID: "ses_tools",
            assistantMessageID: "msg_tools",
            finish: "stop",
            cost: 0,
            tokens: tokens(),
          }),
        )
        send(durableEvent("session.execution.succeeded", { sessionID: "ses_tools" }))
      },
    })

    try {
      const response = await turn({
        fixture,
        connection: recordingConnection(updates),
        sessionID: "ses_tools",
        inboxID: "input_tools",
      })

      expect(
        updates.map((item) => [
          item.update.sessionUpdate,
          "status" in item.update ? item.update.status : undefined,
          "toolCallId" in item.update ? item.update.toolCallId : undefined,
        ]),
      ).toEqual([
        ["tool_call", "pending", "call_ok"],
        ["tool_call_update", "in_progress", "call_ok"],
        ["tool_call_update", "in_progress", "call_ok"],
        ["tool_call_update", "completed", "call_ok"],
        ["tool_call", "pending", "call_fail"],
        ["tool_call_update", "in_progress", "call_fail"],
        ["tool_call_update", "in_progress", "call_fail"],
        ["tool_call_update", "failed", "call_fail"],
      ])
      expect(updates[1]?.update).toMatchObject({
        title: "printf done",
        kind: "execute",
        locations: [{ path: resolve("/workspace", "sub") }],
        rawInput: { command: "printf done", workdir: "sub" },
      })
      expect(updates[2]?.update).not.toHaveProperty("content")
      expect(updates[3]?.update).toMatchObject({
        content: [{ type: "content", content: { type: "text", text: "done" } }],
        rawOutput: { metadata: { exit: 0 } },
      })
      expect(updates[7]?.update).toMatchObject({
        kind: "read",
        locations: [{ path: "/workspace/missing.ts" }],
        content: [
          { type: "content", content: { type: "text", text: "opening" } },
          { type: "content", content: { type: "text", text: "not found" } },
        ],
        rawOutput: { metadata: { bytes: 0 }, error: "not found" },
      })
      expect(response.stopReason).toBe("end_turn")
    } finally {
      await fixture.stop()
    }
  })

  test("replays user, text, reasoning, and tool messages in order", async () => {
    const updates: SessionUpdateParams[] = []
    const messages = replayFixtureMessages()
    const connection = {
      sessionUpdate: async (update) => {
        updates.push(update)
      },
    } satisfies Pick<AgentSideConnection, "sessionUpdate">

    await replayMessages(connection, "ses_replay", "/workspace", messages)

    expect(updates.every((update) => update.sessionId === "ses_replay")).toBe(true)
    expect(updates.map((item) => item.update.sessionUpdate)).toEqual([
      "user_message_chunk",
      "user_message_chunk",
      "user_message_chunk",
      "agent_message_chunk",
      "agent_thought_chunk",
      "tool_call",
      "tool_call_update",
      "tool_call",
      "tool_call_update",
      "tool_call",
      "tool_call_update",
      "tool_call",
    ])
    expect(updates[1]?.update).toMatchObject({
      content: {
        type: "resource_link",
        uri: "file:///workspace/note.md",
        name: "note.md",
        mimeType: "text/markdown",
      },
    })
    expect(updates[2]?.update).toMatchObject({
      content: { type: "resource", resource: { mimeType: "text/plain", text: "hello" } },
    })
    expect(updates[6]?.update).toMatchObject({
      toolCallId: "call_done",
      status: "completed",
      content: [
        { type: "content", content: { type: "text", text: "done" } },
        { type: "content", content: { type: "image", mimeType: "image/png", data: "AAAA" } },
      ],
      rawOutput: { metadata: { exit: 0 } },
    })
    expect(updates[8]?.update).toMatchObject({
      toolCallId: "call_running",
      status: "in_progress",
      title: "pwd",
      locations: [{ path: "/workspace" }],
    })
    expect(updates[10]?.update).toMatchObject({
      toolCallId: "call_failed",
      status: "failed",
      content: [
        { type: "content", content: { type: "text", text: "partial" } },
        { type: "content", content: { type: "text", text: "failed hard" } },
      ],
    })
  })

  test("continues replay after a session update callback rejects", async () => {
    const attempts: Array<[string, string]> = []
    const connection = {
      sessionUpdate: async (params) => {
        if (params.update.sessionUpdate !== "tool_call" && params.update.sessionUpdate !== "tool_call_update") return
        attempts.push([params.update.toolCallId, params.update.sessionUpdate])
        if (params.update.toolCallId === "call_first" && params.update.sessionUpdate === "tool_call_update") {
          throw new Error("replay send failed")
        }
      },
    } satisfies Pick<AgentSideConnection, "sessionUpdate">

    await replayMessages(connection, "ses_replay_failure", "/workspace", [
      replayToolMessage("call_first"),
      replayToolMessage("call_after"),
    ])

    expect(attempts).toEqual([
      ["call_first", "tool_call"],
      ["call_first", "tool_call_update"],
      ["call_after", "tool_call"],
      ["call_after", "tool_call_update"],
    ])
  })

  test("returns cancelled after an admitted turn is interrupted", async () => {
    const submitted = Promise.withResolvers<void>()
    const control: TurnControl = { cancelled: false, admission: new AbortController() }
    const fixture = createSseFixture({
      onPrompt({ id, send }) {
        send(durableEvent("session.inbox.delivered", { sessionID: "ses_cancel", inboxID: id }))
      },
      onInterrupt({ sessionID, send }) {
        send(durableEvent("session.execution.interrupted", { sessionID, reason: "user" }))
        return true
      },
    })
    const result = streamTurn({
      client: fixture.client,
      connection: recordingConnection([]),
      sessionID: "ses_cancel",
      cwd: "/workspace",
      start: { type: "input", id: "input_cancel" },
      writeTextFile: false,
      control,
      submit: async (signal) => {
        await fixture.client.session.prompt(
          { sessionID: "ses_cancel", id: "input_cancel", text: "cancel me" },
          { signal },
        )
        submitted.resolve()
      },
    })

    try {
      await withTimeout(submitted.promise, "cancel test prompt was not admitted")
      control.cancelled = true
      control.admission.abort()
      expect(await fixture.client.session.interrupt({ sessionID: "ses_cancel" })).toEqual({ interrupted: true })

      const response = await withTimeout(result, "cancelled turn did not terminate")
      expect(response).toMatchObject({ stopReason: "cancelled" })
      expect(fixture.requests.filter((request) => request.path.endsWith("/interrupt"))).toHaveLength(1)
    } finally {
      await fixture.stop()
    }
  })

  test("returns cancelled when admission is aborted before promotion", async () => {
    const submitted = Promise.withResolvers<void>()
    const control: TurnControl = { cancelled: false, admission: new AbortController() }
    const fixture = createSseFixture({
      onPrompt({ signal }) {
        submitted.resolve()
        return new Promise<void>((resolve) => {
          if (signal.aborted) return resolve()
          signal.addEventListener("abort", () => resolve(), { once: true })
        })
      },
    })
    const result = streamTurn({
      client: fixture.client,
      connection: recordingConnection([]),
      sessionID: "ses_cancel_admission",
      cwd: "/workspace",
      start: { type: "input", id: "input_cancel_admission" },
      writeTextFile: false,
      control,
      submit: (signal) =>
        fixture.client.session.prompt(
          { sessionID: "ses_cancel_admission", id: "input_cancel_admission", text: "cancel me" },
          { signal },
        ),
    })

    try {
      await withTimeout(submitted.promise, "cancel test prompt was not submitted")
      control.cancelled = true
      control.admission.abort()

      const response = await withTimeout(result, "pre-admission cancellation did not terminate")
      expect(response).toMatchObject({ stopReason: "cancelled" })
      expect(fixture.requests.filter((request) => request.path.endsWith("/interrupt"))).toHaveLength(1)
    } finally {
      control.cancelled = true
      control.admission.abort()
      await result.catch(() => undefined)
      await fixture.stop()
    }
  })

  test("cancels unsupported session forms so execution can continue", async () => {
    const fixture = createSseFixture({
      onPrompt({ id, send }) {
        send(durableEvent("session.inbox.delivered", { sessionID: "ses_form", inboxID: id }))
        send(
          ephemeralEvent("form.created", {
            form: {
              id: "frm_question",
              sessionID: "ses_form",
              title: "Questions",
              metadata: { kind: "question" },
              fields: [{ key: "q0", title: "Choice", type: "string" }],
            },
          }),
        )
      },
      onFormCancel({ sessionID, formID, send }) {
        send(ephemeralEvent("form.cancelled", { sessionID, id: formID }))
        send(durableEvent("session.execution.succeeded", { sessionID }))
      },
    })

    try {
      const response = await turn({
        fixture,
        connection: recordingConnection([]),
        sessionID: "ses_form",
        inboxID: "input_form",
      })

      expect(response.stopReason).toBe("end_turn")
      expect(
        fixture.requests.some((request) => request.path === "/api/session/ses_form/form/frm_question/cancel"),
      ).toBe(true)
    } finally {
      await fixture.stop()
    }
  })
})

function recordingConnection(updates: SessionUpdateParams[]) {
  return {
    sessionUpdate: async (update) => {
      updates.push(update)
    },
    requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
  } satisfies Connection
}

function turn(input: {
  readonly fixture: Fixture
  readonly connection: Connection
  readonly sessionID: string
  readonly inboxID: string
  readonly childSessionUpdate?: (update: ChildSessionUpdate) => Promise<void>
}) {
  return streamTurn({
    client: input.fixture.client,
    connection: input.connection,
    sessionID: input.sessionID,
    cwd: "/workspace",
    start: { type: "input", id: input.inboxID },
    writeTextFile: false,
    control: { cancelled: false, admission: new AbortController() },
    childSessionUpdate: input.childSessionUpdate,
    submit: (signal) =>
      input.fixture.client.session.prompt({ sessionID: input.sessionID, id: input.inboxID, text: "hello" }, { signal }),
  })
}

function childSession(id: string, parentID: string, title: string) {
  return {
    slug: id,
    projectID: "project",
    location: { directory: "/workspace" },
    parentID,
    title,
    version: "test",
  }
}

function tokens() {
  return { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }
}

function replayFixtureMessages(): SessionMessageInfo[] {
  return [
    {
      id: "msg_user",
      type: "user",
      text: "hello",
      time: { created: 1 },
      files: [
        {
          data: "",
          mime: "text/markdown",
          name: "note.md",
          source: { type: "uri", uri: "file:///workspace/note.md" },
        },
        {
          data: "aGVsbG8=",
          mime: "text/plain",
          name: "inline.txt",
          source: { type: "inline" },
        },
      ],
    },
    {
      id: "msg_assistant",
      type: "assistant",
      agent: "build",
      model: { providerID: "test", id: "test-model" },
      time: { created: 2, completed: 3 },
      content: [
        { type: "text", text: "answer" },
        { type: "reasoning", text: "thinking" },
        {
          type: "tool",
          id: "call_done",
          name: "shell",
          time: { created: 2, completed: 3 },
          state: {
            status: "completed",
            input: { command: "printf done" },
            metadata: { exit: 0 },
            content: [
              { type: "text", text: "done" },
              { type: "file", uri: "data:image/png;base64,AAAA", mime: "image/png", name: "image.png" },
            ],
          },
        },
        {
          type: "tool",
          id: "call_running",
          name: "shell",
          time: { created: 2, ran: 2 },
          state: {
            status: "running",
            input: { command: "pwd" },
            metadata: {},
          },
        },
        {
          type: "tool",
          id: "call_failed",
          name: "read",
          time: { created: 2, completed: 3 },
          state: {
            status: "error",
            input: { path: "/workspace/missing.ts" },
            metadata: { bytes: 0 },
            content: [{ type: "text", text: "partial" }],
            error: { type: "tool.error", message: "failed hard" },
          },
        },
        {
          type: "tool",
          id: "call_streaming",
          name: "shell",
          time: { created: 2 },
          state: { status: "streaming", input: '{"command":' },
        },
      ],
    },
  ]
}

function replayToolMessage(id: string) {
  return {
    id: `msg_${id}`,
    type: "assistant",
    agent: "build",
    model: { providerID: "test", id: "test-model" },
    time: { created: 1, completed: 2 },
    content: [
      {
        type: "tool",
        id,
        name: "shell",
        time: { created: 1, completed: 2 },
        state: {
          status: "completed",
          input: { command: "printf done" },
          metadata: { exit: 0 },
          content: [{ type: "text", text: "done" }],
        },
      },
    ],
  } satisfies SessionMessageInfo
}
