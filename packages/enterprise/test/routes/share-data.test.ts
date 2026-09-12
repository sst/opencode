import { expect, test } from "bun:test"
import { expandMessageDiff, resolveMessageDiff } from "@opencode-ai/session-ui/session-diff"
import type { Message, Session } from "@opencode-ai/sdk/v2"
import type { Share } from "../../src/core/share"
import { hydrateShareData } from "../../src/routes/share/data"

type UserMessage = Extract<Message, { role: "user" }>
type SummaryDiff = {
  file: string
  patch?: string
  additions: number
  deletions: number
  status: "added" | "deleted" | "modified"
}

function hasMessageDiff(value: unknown): value is {
  message_diff: Record<string, Array<{ file: string; patch: string }> | undefined>
  message_diff_status?: Record<string, "absent" | "failed" | "pending" | undefined>
} {
  return typeof value === "object" && value !== null && "message_diff" in value
}

test("hydrates shared inline message patches for the session-turn diff consumer", async () => {
  const sessionID = "ses_share_diff"
  const summary: SummaryDiff = {
    file: "changed.ts",
    additions: 1,
    deletions: 1,
    status: "modified" as const,
  }
  const message: UserMessage = {
    id: "msg_share_diff",
    sessionID,
    role: "user",
    time: { created: 1 },
    agent: "build",
    model: { providerID: "provider", modelID: "model" },
    summary: {
      additions: 1,
      deletions: 1,
      files: 1,
      diffs: [{ ...summary, patch: "@@ -1 +1 @@\n-before\n+after\n" }],
    },
  }
  const session: Session = {
    id: sessionID,
    slug: sessionID,
    projectID: "project",
    directory: "/repo",
    title: "Shared diff",
    version: "1",
    time: { created: 1, updated: 1 },
  }
  const data = hydrateShareData({ sessionID, shareID: "shr_share_diff" }, [
    { type: "session", data: session },
    { type: "message", data: message },
  ])
  expect(hasMessageDiff(data)).toBe(true)
  if (!hasMessageDiff(data)) return

  const resolved = resolveMessageDiff(summary, data.message_diff[message.id])

  expect(resolved.patch).toBe("@@ -1 +1 @@\n-before\n+after\n")
})

test("marks shared stripped message patches unavailable without a live fetch", () => {
  const sessionID = "ses_share_unavailable"
  const summary: SummaryDiff = {
    file: "stripped.ts",
    additions: 1,
    deletions: 1,
    status: "modified" as const,
  }
  const message: UserMessage = {
    id: "msg_share_unavailable",
    sessionID,
    role: "user",
    time: { created: 1 },
    agent: "build",
    model: { providerID: "provider", modelID: "model" },
    summary: { additions: 1, deletions: 1, files: 1, diffs: [summary] },
  }
  const session: Session = {
    id: sessionID,
    slug: sessionID,
    projectID: "project",
    directory: "/repo",
    title: "Shared unavailable diff",
    version: "1",
    time: { created: 1, updated: 1 },
  }
  const data = hydrateShareData({ sessionID, shareID: "shr_share_unavailable" }, [
    { type: "session", data: session },
    { type: "message", data: message },
  ])
  expect(hasMessageDiff(data)).toBe(true)
  if (!hasMessageDiff(data)) return

  const resolved = expandMessageDiff({
    diff: summary,
    cache: data.message_diff[message.id],
    sessionID,
    messageID: message.id,
  })

  expect(resolved.patch).toBeUndefined()
  expect(data.message_diff_status?.[message.id]).toBe("absent")
})
