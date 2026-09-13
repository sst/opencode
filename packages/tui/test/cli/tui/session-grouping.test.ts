import { expect, test } from "bun:test"
import { append, groupRefs, partitionPending, type SessionRow } from "../../../src/routes/session/grouping/session"

test("a pending tool does not hide a later tool reusing its call ID in another message", () => {
  const rows: SessionRow[] = []
  const blocked = { messageID: "assistant-a", partID: "call-reused" }
  const later = { messageID: "assistant-b", partID: "call-reused" }
  append(rows, blocked, { type: "tool", name: "read" })
  partitionPending(rows, new Set([blocked.partID]))
  append(rows, later, { type: "tool", name: "read" })

  const group = rows[0]
  if (group.type !== "group" || group.kind !== "exploration") throw new Error("Expected exploration group")
  expect(groupRefs(group)).toEqual([later])
  expect(group.pending).toEqual([blocked])
  expect(groupRefs(group, true)).toEqual([later, blocked])

  partitionPending(rows, new Set())
  expect(groupRefs(group)).toEqual([later, blocked])
  expect(group.pending).toEqual([])
})
