import { describe, expect, test } from "bun:test"
import { expandMessageDiff, resolveMessageDiff } from "@opencode-ai/session-ui/session-diff"
import type { DataProvider } from "@opencode-ai/session-ui/context"
import type { Message, Session } from "@opencode-ai/sdk/v2"
import { Share } from "../../src/core/share"
import { hydrateShareData } from "../../src/routes/share/data"

type Data = Parameters<typeof DataProvider>[0]["data"]
type UserMessage = Extract<Message, { role: "user" }>
type FileDiff = NonNullable<Data["message_diff"][string]>[number]
type SummaryDiff = Omit<FileDiff, "patch"> & { patch?: string }

function session(sessionID: string): Session {
  return {
    id: sessionID,
    slug: sessionID,
    projectID: "project",
    directory: "/repo",
    title: "Shared diff",
    version: "1",
    time: { created: 1, updated: 1 },
  }
}

function userMessage(id: string, sessionID: string, summary?: UserMessage["summary"]): UserMessage {
  return {
    id,
    sessionID,
    role: "user",
    time: { created: 1 },
    agent: "build",
    model: { providerID: "provider", modelID: "model" },
    ...(summary ? { summary } : {}),
  }
}

function shareData(value: unknown): Share.Data {
  return Share.Data.parse(value)
}

function hydrate(message: unknown, sessionID: string) {
  return hydrateShareData({ sessionID, shareID: `shr_${sessionID}` }, [
    shareData({ type: "session", data: session(sessionID) }),
    shareData({ type: "message", data: message }),
  ])
}

function roundTrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

describe.concurrent("routes.share-data", () => {
  test("keeps inline patches from legacy shared snapshots available to the diff consumer", () => {
    const sessionID = "ses_legacy"
    const summary: SummaryDiff = {
      file: "legacy.ts",
      additions: 1,
      deletions: 1,
      status: "modified",
    }
    const patch = "@@ -1 +1 @@\n-before\n+after\n"
    const message = userMessage("msg_legacy", sessionID, {
      additions: 1,
      deletions: 1,
      files: 1,
      diffs: [{ ...summary, patch }],
    })

    const data = hydrate(message, sessionID)

    expect(resolveMessageDiff(summary, data.message_diff[message.id]).patch).toBe(patch)
  })

  test("marks current metadata-only shared diffs unavailable without a live fetch", () => {
    const sessionID = "ses_stripped"
    const summary: SummaryDiff = {
      file: "stripped.ts",
      additions: 1,
      deletions: 1,
      status: "modified",
    }
    const message = userMessage("msg_stripped", sessionID, {
      additions: 1,
      deletions: 1,
      files: 1,
      diffs: [summary],
    })

    const data = hydrate(message, sessionID)
    const resolved = expandMessageDiff({
      diff: summary,
      cache: data.message_diff[message.id],
      sessionID,
      messageID: message.id,
    })

    expect(resolved.patch).toBeUndefined()
    expect(data.message_diff_status[message.id]).toBe("absent")
  })

  test("keeps complete entries and marks metadata-only entries unavailable in mixed legacy snapshots", () => {
    const sessionID = "ses_mixed"
    const legacy: SummaryDiff = {
      file: "legacy.ts",
      additions: 1,
      deletions: 1,
      status: "modified",
    }
    const metadataOnly: SummaryDiff = {
      file: "current.ts",
      additions: 1,
      deletions: 1,
      status: "modified",
    }
    const patch = "@@ -1 +1 @@\n-before\n+after\n"
    const message = userMessage("msg_mixed", sessionID, {
      additions: 2,
      deletions: 2,
      files: 2,
      diffs: [{ ...legacy, patch }, metadataOnly],
    })

    const data = hydrate(message, sessionID)
    const cache = data.message_diff[message.id]
    const unresolved = expandMessageDiff({
      diff: metadataOnly,
      cache,
      sessionID,
      messageID: message.id,
    })

    expect(resolveMessageDiff(legacy, cache).patch).toBe(patch)
    expect(unresolved.patch).toBeUndefined()
    expect(data.message_diff_status[message.id] ?? "absent").toBe("absent")
  })

  const emptySummary: UserMessage["summary"] = { additions: 0, deletions: 0, files: 0, diffs: [] }
  const emptyCases: Array<[string, UserMessage["summary"] | undefined, Data["message_diff"][string]]> = [
    ["no summary", undefined, undefined],
    ["an empty summary", emptySummary, []],
  ]
  for (const [name, summary, cache] of emptyCases) {
    test(`leaves ${name} out of shared diff rendering`, () => {
      const sessionID = `ses_${name.replaceAll(" ", "_")}`
      const message = userMessage("msg_empty", sessionID, summary)
      const data = hydrate(message, sessionID)

      expect(data.message_diff[message.id]).toEqual(cache)
      expect(data.message_diff_status[message.id]).toBeUndefined()
    })
  }

  test("removes a truthy non-array summary diff payload before it reaches the consumer", () => {
    const sessionID = "ses_non_array"
    const message = {
      ...userMessage("msg_non_array", sessionID),
      summary: { additions: 1, deletions: 1, files: 1, diffs: "not-an-array" },
    }
    let data: ReturnType<typeof hydrateShareData> | undefined

    expect(() => {
      data = hydrate(message, sessionID)
    }).not.toThrow()
    if (!data) return

    const stored = data.message[sessionID]?.[0]?.summary
    expect(stored && typeof stored === "object" ? stored.diffs : undefined).toBeUndefined()
    expect(data.message_diff[message.id]).toBeUndefined()
  })

  test("removes non-object summary diff entries before they reach the consumer", () => {
    const sessionID = "ses_non_object"
    const summary: SummaryDiff = {
      file: "legacy.ts",
      additions: 1,
      deletions: 1,
      status: "modified",
    }
    const patch = "@@ -1 +1 @@\n-before\n+after\n"
    const message = {
      ...userMessage("msg_non_object", sessionID),
      summary: { additions: 1, deletions: 1, files: 1, diffs: [null, { ...summary, patch }] },
    }
    let data: ReturnType<typeof hydrateShareData> | undefined

    expect(() => {
      data = hydrate(message, sessionID)
    }).not.toThrow()
    if (!data) return

    const stored = data.message[sessionID]?.[0]?.summary
    expect(stored && typeof stored === "object" ? stored.diffs : undefined).toEqual([{ ...summary, patch }])
    expect(resolveMessageDiff(summary, data.message_diff[message.id]).patch).toBe(patch)
  })

  test("preserves prototype-named diff cache entries through serialization for the consumer", () => {
    const sessionID = "ses_proto"
    const summary: SummaryDiff = {
      file: "stripped.ts",
      additions: 1,
      deletions: 1,
      status: "modified",
    }
    const message = userMessage("__proto__", sessionID, {
      additions: 1,
      deletions: 1,
      files: 1,
      diffs: [summary],
    })
    const data = roundTrip(hydrate(message, sessionID))
    const resolved = expandMessageDiff({
      diff: summary,
      cache: data.message_diff[message.id],
      sessionID,
      messageID: message.id,
    })

    expect(Object.hasOwn(data.message_diff, message.id)).toBe(true)
    expect(Object.hasOwn(data.message_diff_status, message.id)).toBe(true)
    expect(Array.isArray(data.message_diff[message.id])).toBe(true)
    expect(resolved.patch).toBeUndefined()
    expect(data.message_diff_status[message.id]).toBe("absent")
  })
})
