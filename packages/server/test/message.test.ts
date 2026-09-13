import { expect } from "bun:test"
import { OpenCode, type SessionMessageInfo } from "@opencode/client"
import { Session } from "@opencode/schema/session"
import { Effect } from "effect"
import { it } from "../../core/test/lib/effect"
import { ServerFetch } from "../src/fetch"

const messages: SessionMessageInfo[] = [
  { id: "msg_z", type: "user", text: "First request", time: { created: 300 } },
  {
    id: "msg_assistant",
    type: "assistant",
    agent: "build",
    model: { providerID: "test", id: "test" },
    content: [{ type: "text", text: "First answer" }],
    finish: "stop",
    time: { created: 400, completed: 500 },
  },
  { id: "msg_b", type: "user", text: "Second request", time: { created: 100 } },
  { id: "msg_synthetic", type: "synthetic", text: "Background completion", time: { created: 200 } },
  {
    id: "msg_compaction",
    type: "compaction",
    status: "completed",
    reason: "manual",
    summary: "Conversation summary",
    recent: "",
    time: { created: 700 },
  },
  { id: "msg_x", type: "user", text: "Third request", time: { created: 600 } },
  { id: "msg_system", type: "system", text: "Updated instructions", time: { created: 800 } },
  { id: "msg_a", type: "user", text: "Fourth request", time: { created: 500 } },
]

const setup = Effect.gen(function* () {
  const handler = yield* ServerFetch.make({
    app: { version: "test" },
    database: { path: ":memory:" },
    config: { project: false },
    models: { fetch: false },
    fs: { filewatcher: false },
  })
  const api = OpenCode.make({
    baseUrl: "http://opencode.local",
    fetch: Object.assign((input: string | URL | Request, init?: RequestInit) => handler(new Request(input, init)), {
      preconnect: fetch.preconnect,
    }),
  })
  const session = yield* Effect.promise(async () => {
    const template = await api.session.create({ title: "Message filtering" })
    return api.session.import({ info: { ...template, id: Session.ID.create() }, messages })
  })
  return { api, handler, sessionID: session.id }
})

it.live("filters message types before paginating in either direction through the generated client", () =>
  Effect.gen(function* () {
    const fixture = yield* setup
    yield* Effect.promise(async () => {
      const input = { sessionID: fixture.sessionID, type: "user", limit: 2 } as const
      // Omission retains the full transcript, in durable sequence rather than timestamp or ID order.
      expect(
        (await fixture.api.message.list({ sessionID: fixture.sessionID })).data.map((message) => message.id),
      ).toEqual(messages.toReversed().map((message) => message.id))
      for (const order of ["asc", "desc"] as const) {
        const ids = order === "asc" ? ["msg_z", "msg_b", "msg_x", "msg_a"] : ["msg_a", "msg_x", "msg_b", "msg_z"]
        const first = await fixture.api.message.list({ ...input, order })
        expect(first.data.map((message) => message.id)).toEqual(ids.slice(0, 2))
        if (!first.cursor.next) throw new Error("Expected a next cursor")
        const second = await fixture.api.message.list({ ...input, cursor: first.cursor.next })
        expect(second.data.map((message) => message.id)).toEqual(ids.slice(2))
        if (!second.cursor.previous || !second.cursor.next) throw new Error("Expected previous and next cursors")
        const previous = await fixture.api.message.list({ ...input, cursor: second.cursor.previous })
        expect(previous.data).toEqual(first.data)
        const end = await fixture.api.message.list({ ...input, cursor: second.cursor.next })
        expect(end).toEqual({ data: [], cursor: { previous: null, next: null } })
      }
      expect((await fixture.api.message.list({ sessionID: fixture.sessionID, type: "compaction" })).data).toEqual([
        messages[4],
      ])
      expect(
        (await fixture.api.message.list({ sessionID: fixture.sessionID, type: "assistant", limit: 1 })).data,
      ).toEqual([messages[1]])
      expect((await fixture.api.message.list({ sessionID: fixture.sessionID, type: "shell" })).data).toEqual([])
    })
  }),
)

it.live("rejects unknown message type filters at the HTTP boundary", () =>
  Effect.gen(function* () {
    const fixture = yield* setup
    yield* Effect.promise(async () => {
      for (const type of ["unknown", "tool", "User", ""]) {
        const response = await fixture.handler(
          new Request(`http://opencode.local/api/session/${fixture.sessionID}/message?type=${type}`),
        )
        expect(response.status).toBe(400)
        expect(await response.json()).toMatchObject({ _tag: "InvalidRequestError" })
      }
    })
  }),
)
