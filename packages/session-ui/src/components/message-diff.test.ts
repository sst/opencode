import { describe, expect, test } from "bun:test"
import { normalize, text } from "./session-diff"
import * as SessionDiff from "./session-diff"

type Diff = {
  file: string
  patch?: string
  additions: number
  deletions: number
  status: "added" | "deleted" | "modified"
}

type ExpandMessageDiff = (input: {
  diff: Diff
  cache?: Diff[]
  sessionID: string
  messageID: string
  fetch: (sessionID: string, messageID: string) => Promise<void>
}) => Diff

const summary: Diff = {
  file: "changed.ts",
  additions: 1,
  deletions: 1,
  status: "modified",
}

const sideTable: Diff = {
  ...summary,
  patch: "@@ -1 +1 @@\n-before\n+from side table\n",
}

const legacy: Diff = {
  ...summary,
  patch: "@@ -1 +1 @@\n-before\n+from legacy payload\n",
}

const expand = () => (SessionDiff as typeof SessionDiff & { expandMessageDiff?: ExpandMessageDiff }).expandMessageDiff

describe("message diff expansion", () => {
  test("uses the side-table patch before an inline summary without one", () => {
    let requests = 0
    const diff = expand()?.({
      diff: summary,
      cache: [sideTable],
      sessionID: "session-1",
      messageID: "message-1",
      fetch: async () => {
        requests++
      },
    }) ?? summary

    expect(text(normalize(diff), "additions")).toBe("from side table\n")
    expect(requests).toBe(0)
  })

  test("keeps a legacy inline patch when the side table has no patch", () => {
    let requests = 0
    const diff = expand()?.({
      diff: legacy,
      cache: [],
      sessionID: "session-1",
      messageID: "message-1",
      fetch: async () => {
        requests++
      },
    }) ?? legacy

    expect(text(normalize(diff), "additions")).toBe("from legacy payload\n")
    expect(requests).toBe(0)
  })

  test("fetches an uncached patch once and reads it from the cache on the next expansion", async () => {
    let cache: Diff[] = []
    let requests = 0
    const fetch = async () => {
      requests++
      cache = [sideTable]
    }

    const first = expand()?.({
      diff: summary,
      cache,
      sessionID: "session-1",
      messageID: "message-1",
      fetch,
    }) ?? summary
    await Promise.resolve()
    const second = expand()?.({
      diff: summary,
      cache,
      sessionID: "session-1",
      messageID: "message-1",
      fetch,
    }) ?? summary

    expect(first.patch).toBeUndefined()
    expect(requests).toBe(1)
    expect(text(normalize(second), "additions")).toBe("from side table\n")
  })
})
