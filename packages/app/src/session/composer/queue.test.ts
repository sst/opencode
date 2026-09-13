import { describe, expect, test } from "bun:test"
import type { SessionInboxInfo } from "@opencode/client/promise"
import { queuedPromptRows } from "./queue"

const queued = [
  {
    id: "msg_original",
    sessionID: "ses_1",
    timeCreated: 1,
    type: "user",
    delivery: "queue",
    payload: { text: "original" },
  },
  {
    id: "msg_replacement",
    sessionID: "ses_1",
    timeCreated: 2,
    type: "user",
    delivery: "queue",
    payload: { text: "edited" },
  },
] satisfies SessionInboxInfo[]

describe("queuedPromptRows", () => {
  test("keeps the edited prompt to one row while its replacement is admitted", () => {
    expect(queuedPromptRows(queued, { original: "msg_original", replacement: "msg_replacement" })).toEqual([
      { id: "msg_replacement", text: "edited", attachments: 0 },
    ])
  })

  test("keeps the original visible until its replacement appears", () => {
    expect(queuedPromptRows([queued[0]], { original: "msg_original", replacement: "msg_replacement" })).toEqual([
      { id: "msg_original", text: "original", attachments: 0 },
    ])
  })

  test("retains unrelated queue entries", () => {
    expect(queuedPromptRows(queued)).toEqual([
      { id: "msg_original", text: "original", attachments: 0 },
      { id: "msg_replacement", text: "edited", attachments: 0 },
    ])
  })

  test("keeps other prompts visible while a mutation replaces the edited prompt", () => {
    const other = { ...queued[0], id: "msg_other", payload: { text: "other" } }

    expect(
      queuedPromptRows([queued[0], other, queued[1]], { original: "msg_original", replacement: "msg_replacement" }),
    ).toEqual([
      { id: "msg_other", text: "other", attachments: 0 },
      { id: "msg_replacement", text: "edited", attachments: 0 },
    ])
  })
})
