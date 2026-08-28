import { describe, expect, test } from "bun:test"
import type { Part } from "@opencode-ai/sdk/v2"
import { activeSubagents, deriveSubagents } from "../../src/feature-plugins/sidebar/subagents"

const messages = [{ id: "message-1" }]
const noStatus = () => undefined
const busyStatus = () => ({ type: "busy" as const })

describe("sidebar subagents", () => {
  test("returns no entries when the session has no task parts", () => {
    expect(activeSubagents(messages, () => [], noStatus)).toEqual([])
  })

  test("derives running and completed subagents", () => {
    expect(
      activeSubagents(messages, () => [
        {
          type: "tool",
          tool: "task",
          state: {
            status: "running",
            input: { description: "Research APIs" },
            metadata: { sessionId: "child-running" },
          },
        },
        {
          type: "tool",
          tool: "task",
          state: {
            status: "completed",
            input: { description: "Review changes" },
            title: "Review changes",
            metadata: { sessionId: "child-completed" },
          },
        },
      ] as unknown as Part[], (sessionID) => (sessionID === "child-running" ? busyStatus() : undefined)),
    ).toEqual([{ description: "Research APIs", status: "active", session_id: "child-running" }])
  })

  test("marks errored subagents as failed", () => {
    expect(
      activeSubagents(messages, () => [
        {
          type: "tool",
          tool: "task",
          state: {
            status: "error",
            input: { description: "Run checks" },
            error: "failed",
            metadata: { sessionId: "child-error" },
          },
        },
      ] as unknown as Part[], noStatus),
    ).toEqual([])
  })

  test("keeps pending subagents without a session id non-navigable", () => {
    expect(
      activeSubagents(messages, () => [
        {
          type: "tool",
          tool: "task",
          state: {
            status: "pending",
            input: { description: "Start worker" },
            raw: "{}",
          },
        },
      ] as unknown as Part[], noStatus),
    ).toEqual([{ description: "Start worker", status: "pending", session_id: undefined }])
  })

  test("deduplicates one child session across messages", () => {
    expect(
      activeSubagents(
        [{ id: "message-1" }, { id: "message-2" }],
        () =>
          [
            {
              type: "tool",
              tool: "task",
              state: {
                status: "running",
                input: { description: "Research APIs" },
                metadata: { sessionId: "child-1" },
              },
            },
          ] as unknown as Part[],
          busyStatus,
      ),
    ).toEqual([{ description: "Research APIs", status: "active", session_id: "child-1" }])
  })

  test("keeps the latest status when a child session is resumed", () => {
    const parts = [
      {
        type: "tool",
        tool: "task",
        state: {
          status: "running",
          input: { description: "Research APIs" },
          metadata: { sessionId: "child-1" },
        },
      },
      {
        type: "tool",
        tool: "task",
        state: {
          status: "completed",
          input: { description: "Research APIs" },
          title: "Research APIs",
          metadata: { sessionId: "child-1" },
        },
      },
    ] as unknown as Part[]

    expect(
      deriveSubagents(
        [{ id: "message-1" }, { id: "message-2" }],
        (messageID) => [parts[messageID === "message-1" ? 0 : 1]!],
      ),
    ).toEqual([{ description: "Research APIs", status: "done", session_id: "child-1" }])
    expect(
      activeSubagents(
        [{ id: "message-1" }, { id: "message-2" }],
        (messageID) => [parts[messageID === "message-1" ? 0 : 1]!],
        noStatus,
      ),
    ).toEqual([])
  })

  test("keeps multiple pending entries without session ids", () => {
    expect(
      activeSubagents(messages, () => [
        {
          type: "tool",
          tool: "task",
          state: { status: "pending", input: { description: "Start worker one" }, raw: "{}" },
        },
        {
          type: "tool",
          tool: "task",
          state: { status: "pending", input: { description: "Start worker two" }, raw: "{}" },
        },
      ] as unknown as Part[], noStatus),
    ).toEqual([
      { description: "Start worker one", status: "pending", session_id: undefined },
      { description: "Start worker two", status: "pending", session_id: undefined },
    ])
  })

  test("renders only in-flight entries from a mixed session", () => {
    expect(
      activeSubagents(messages, () => [
        {
          type: "tool",
          tool: "task",
          state: {
            status: "completed",
            input: { description: "Finished one" },
            title: "Finished one",
            metadata: { sessionId: "child-done-1" },
          },
        },
        {
          type: "tool",
          tool: "task",
          state: {
            status: "completed",
            input: { description: "Finished two" },
            title: "Finished two",
            metadata: { sessionId: "child-done-2" },
          },
        },
        {
          type: "tool",
          tool: "task",
          state: { status: "running", input: { description: "Working" }, metadata: { sessionId: "child-running" } },
        },
        {
          type: "tool",
          tool: "task",
          state: { status: "pending", input: { description: "Waiting" }, raw: "{}" },
        },
      ] as unknown as Part[], (sessionID) => (sessionID === "child-running" ? { type: "busy" as const } : undefined)),
    ).toEqual([
      { description: "Working", status: "active", session_id: "child-running" },
      { description: "Waiting", status: "pending", session_id: undefined },
    ])
  })

  test("includes a completed background task while its child session is busy", () => {
    expect(
      activeSubagents(messages, () => [
        {
          type: "tool",
          tool: "task",
          state: {
            status: "completed",
            input: { description: "Background research" },
            title: "Background research",
            metadata: { sessionId: "child-busy" },
          },
        },
      ] as unknown as Part[], busyStatus),
    ).toEqual([{ description: "Background research", status: "active", session_id: "child-busy" }])
  })
})
