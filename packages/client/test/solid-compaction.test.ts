import { expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createData, type CreateDataInput } from "../src/solid"
import { OpenCode, type OpenCodeEvent, type SessionInboxCompaction, type SessionInboxInfo } from "../src/promise"

test("admits compaction before model setup and serializes the following prompt", async () => {
  using fixture = setup()
  const compact = fixture.data.session.compact({ sessionID, model: { providerID: "demo", id: "model" } })
  const proposed = fixture.data.session.pending.list(sessionID)[0]
  expect(proposed).toMatchObject({ type: "compaction", sessionID })
  expect(fixture.calls).toEqual([])
  expect(fixture.data.session.message.list(sessionID)).toEqual([])
  expect(fixture.data.session.status(sessionID)).toBe("idle")

  const prompt = fixture.data.session.prompt({ sessionID, text: "Follow up" })
  expect(fixture.data.session.message.list(sessionID)).toMatchObject([{ type: "user", text: "Follow up" }])
  await wait(() => fixture.calls.length === 1)
  expect(fixture.calls).toEqual(["model"])
  fixture.model.resolve()
  await wait(() => fixture.calls.length === 2)
  expect(fixture.calls).toEqual(["model", "compact"])
  fixture.response.resolve(Response.json({ data: item(proposed.id) }))
  await Promise.all([compact, prompt])
  expect(fixture.calls).toEqual(["model", "compact", "prompt"])
  expect(fixture.proposals).toEqual([proposed.id])
})

test("coalesces duplicate gestures until the admission request settles", async () => {
  using fixture = setup()
  const first = fixture.data.session.compact({ sessionID })
  expect(fixture.data.session.compact({ sessionID })).toBe(first)
  expect(fixture.data.session.pending.list(sessionID)).toHaveLength(1)
  await wait(() => fixture.calls.length === 1)
  fixture.response.resolve(Response.json({ data: item("msg_canonical") }))
  await first
  expect(fixture.calls).toEqual(["compact"])
  const next = fixture.data.session.compact({ sessionID })
  expect(next).not.toBe(first)
  await next
  expect(fixture.calls).toEqual(["compact", "compact"])
  expect(new Set(fixture.proposals).size).toBe(2)
  expect(fixture.proposals).not.toContain("msg_canonical")
})

test("substitutes the canonical response ID and reconciles its later echo", async () => {
  using fixture = setup()
  const request = fixture.data.session.compact({ sessionID })
  const proposed = fixture.data.session.pending.list(sessionID)[0].id
  await fixture.data.session.pending.sync(sessionID)
  expect(fixture.data.session.pending.list(sessionID).map((row) => row.id)).toEqual([proposed])
  fixture.response.resolve(Response.json({ data: item("msg_canonical") }))
  await request
  expect(fixture.data.session.pending.list(sessionID)).toEqual([item("msg_canonical")])
  fixture.enqueue("msg_canonical", 20)
  expect(fixture.data.session.pending.list(sessionID)).toEqual([item("msg_canonical", 20)])
  expect(fixture.data.session.input.list(sessionID)).toEqual([])
})

test.each(["proposed", "canonical"])("adopts the %s echo before the response without duplicating it", async (kind) => {
  using fixture = setup()
  const request = fixture.data.session.compact({ sessionID })
  const id = kind === "proposed" ? fixture.data.session.pending.list(sessionID)[0].id : "msg_canonical"
  fixture.enqueue(id, 20)
  expect(fixture.data.session.pending.list(sessionID)).toEqual([item(id, 20)])
  fixture.response.resolve(Response.json({ data: item(id) }))
  await request
  expect(fixture.data.session.pending.list(sessionID)).toEqual([item(id, 20)])
})

test.each(["started", "cancelled", "failed"])(
  "does not resurrect a canonical item already %s before the response",
  async (kind) => {
    using fixture = setup()
    const request = fixture.data.session.compact({ sessionID })
    fixture.enqueue("msg_canonical")
    if (kind === "started")
      fixture.emit({
        ...event,
        type: "session.compaction.started",
        data: { sessionID, inputID: "msg_canonical", reason: "manual" },
      })
    if (kind === "cancelled")
      fixture.emit({ ...event, type: "session.inbox.cancelled", data: { sessionID, inboxID: "msg_canonical" } })
    if (kind === "failed")
      fixture.emit({
        ...event,
        type: "session.compaction.failed",
        data: {
          sessionID,
          inputID: "msg_canonical",
          reason: "manual",
          error: { type: "aborted", message: "Cancelled" },
        },
      })
    expect(fixture.data.session.pending.list(sessionID)).toEqual([])
    fixture.response.resolve(Response.json({ data: item("msg_canonical") }))
    await request
    expect(fixture.data.session.pending.list(sessionID)).toEqual([])
    if (kind === "started") {
      expect(fixture.data.session.message.list(sessionID)).toMatchObject([{ type: "compaction", status: "running" }])
      const model = { providerID: "demo", id: "model" }
      const providerState = { responseId: "summary-response" }
      const tokens = { input: 10, output: 4, reasoning: 0, cache: { read: 3, write: 0 } }
      const providerContext = {
        version: 1 as const,
        provenance: {
          providerID: "demo",
          provider: "demo",
          modelID: "model",
          route: "demo-responses",
          protocol: "demo",
          endpoint: "digest",
        },
        messages: [],
      }
      fixture.emit({
        ...event,
        type: "session.compaction.ended",
        data: {
          sessionID,
          reason: "manual",
          model,
          providerState,
          providerContext,
          text: "Summary",
          recent: "Recent",
          cost: 0.01,
          tokens,
        },
      })
      // The live fold carries the provider window and request usage so the label matches a reloaded session.
      expect(fixture.data.session.message.list(sessionID)).toMatchObject([
        {
          type: "compaction",
          status: "completed",
          summary: "Summary",
          model,
          providerState,
          providerContext,
          cost: 0.01,
          tokens,
        },
      ])
    }
  },
)

test.each(["model", "compact"])("rolls back a rejected %s RPC and releases the following prompt", async (rpc) => {
  using fixture = setup()
  const request = fixture.data.session.compact({ sessionID, model: { providerID: "demo", id: "model" } })
  const failed = request.catch((error: unknown) => error)
  const prompt = fixture.data.session.prompt({ sessionID, text: "Follow up" })
  if (rpc === "model") fixture.model.reject(new Error("Model setup failed"))
  if (rpc === "compact") {
    fixture.model.resolve()
    fixture.response.resolve(new Response("Admission failed", { status: 500 }))
  }
  expect(await failed).toBeInstanceOf(Error)
  await prompt
  expect(fixture.data.session.pending.list(sessionID).map((row) => row.type)).toEqual(["user"])
  expect(fixture.data.session.message.list(sessionID)).toMatchObject([{ type: "user", text: "Follow up" }])
})

test.each(["proposed", "canonical", "existing"])(
  "preserves acknowledged %s compaction after an HTTP error",
  async (kind) => {
    using fixture = setup()
    if (kind === "existing") fixture.enqueue("msg_canonical")
    const request = fixture.data.session.compact({ sessionID })
    const failed = request.catch((error: unknown) => error)
    const id = kind === "proposed" ? fixture.data.session.pending.list(sessionID)[0].id : "msg_canonical"
    if (kind !== "existing") fixture.enqueue(id)
    expect(fixture.data.session.pending.list(sessionID)).toEqual([item(id)])
    fixture.response.resolve(new Response("Lost response", { status: 500 }))
    expect(await failed).toBeInstanceOf(Error)
    expect(fixture.data.session.pending.list(sessionID)).toEqual([item(id)])
    expect(fixture.listeners.size).toBe(1)
  },
)

test("uses a fresh control ID when the known pending compaction starts during model setup", async () => {
  const proposed = Promise.withResolvers<string>()
  using fixture = setup(async (request) => {
    if (!request.url.endsWith("/compact")) return undefined
    const body = await request.json()
    proposed.resolve(body.id)
    if (body.id === "msg_existing") return Response.json({ message: "Control ID already consumed" }, { status: 409 })
    return Response.json({ data: item(body.id) })
  })
  fixture.enqueue("msg_existing")
  const request = fixture.data.session.compact({ sessionID, model: { providerID: "demo", id: "model" } })
  const result = request.catch((error: unknown) => error)
  expect(fixture.data.session.pending.list(sessionID)).toEqual([item("msg_existing")])
  await wait(() => fixture.calls.includes("model"))
  fixture.emit({
    ...event,
    type: "session.compaction.started",
    data: { sessionID, inputID: "msg_existing", reason: "manual" },
  })
  fixture.model.resolve()
  expect(await proposed.promise).not.toBe("msg_existing")
  expect(await result).toEqual(item(await proposed.promise))
  expect(fixture.data.session.pending.list(sessionID)).toEqual([item(await proposed.promise)])
  expect(fixture.data.session.message.list(sessionID)).toMatchObject([
    { id: "msg_existing", type: "compaction", status: "running" },
  ])
})

test.each(["compaction", "canonical compaction", "user"])(
  "preserves a fetched durable %s when SSE is delayed and HTTP fails",
  async (type) => {
    using fixture = setup(async (request) => {
      if (request.url.endsWith("/prompt")) return fixture.response.promise
      return undefined
    })
    const request =
      type === "user"
        ? fixture.data.session.prompt({ sessionID, text: "Follow up" })
        : fixture.data.session.compact({ sessionID })
    const result = request.catch((error: unknown) => error)
    const id = type === "canonical compaction" ? "msg_canonical" : fixture.data.session.pending.list(sessionID)[0].id
    const durable: SessionInboxInfo =
      type === "user" ? { ...item(id, 20), type: "user", payload: { text: "Follow up" } } : item(id, 20)
    fixture.pending.push(durable)
    await fixture.data.session.pending.sync(sessionID)
    expect(fixture.data.session.pending.list(sessionID)).toEqual([durable])
    fixture.response.resolve(new Response("Lost response", { status: 500 }))
    expect(await result).toBeInstanceOf(Error)
    expect(fixture.data.session.pending.list(sessionID)).toEqual([durable])
    if (type === "user")
      expect(fixture.data.session.message.list(sessionID)).toMatchObject([{ id, type: "user", text: "Follow up" }])
  },
)

test("keeps one event listener and removes it when the data owner is disposed during a gate", async () => {
  using fixture = setup()
  const gate = Promise.withResolvers<void>()
  const first = fixture.data.session.prompt({ sessionID, text: "First", gate: gate.promise })
  const compact = fixture.data.session.compact({ sessionID })
  expect(fixture.listeners.size).toBe(1)
  fixture.dispose()
  expect(fixture.listeners.size).toBe(0)
  gate.resolve()
  fixture.response.resolve(Response.json({ data: item("msg_canonical") }))
  await Promise.all([first, compact])
  expect(fixture.listeners.size).toBe(0)
})

test("routes concurrent compaction observations by session through one listener", async () => {
  const firstResponse = Promise.withResolvers<Response>()
  const secondResponse = Promise.withResolvers<Response>()
  using fixture = setup(async (request) => {
    if (!request.url.endsWith("/compact")) return undefined
    return request.url.includes(`/session/${sessionID}/`) ? firstResponse.promise : secondResponse.promise
  })
  const first = fixture.data.session.compact({ sessionID })
  const second = fixture.data.session.compact({ sessionID: "ses_other" })
  const firstID = fixture.data.session.pending.list(sessionID)[0].id
  const secondID = fixture.data.session.pending.list("ses_other")[0].id
  expect(fixture.listeners.size).toBe(1)
  fixture.emit({ ...event, type: "session.inbox.cancelled", data: { sessionID, inboxID: firstID } })
  expect(fixture.data.session.pending.list(sessionID)).toEqual([])
  expect(fixture.data.session.pending.list("ses_other").map((row) => row.id)).toEqual([secondID])

  firstResponse.resolve(Response.json({ data: item(firstID) }))
  secondResponse.resolve(Response.json({ data: { ...item(secondID), sessionID: "ses_other" } }))
  await Promise.all([first, second])
  expect(fixture.data.session.pending.list(sessionID)).toEqual([])
  expect(fixture.data.session.pending.list("ses_other")).toEqual([{ ...item(secondID), sessionID: "ses_other" }])
  expect(fixture.listeners.size).toBe(1)
})

test.each(["gate", "prepare"])(
  "a preceding prompt's failed %s does not block compaction or following model preparation",
  async (kind) => {
    using fixture = setup()
    const gate = Promise.withResolvers<void>()
    const prepared: string[] = []
    const first = fixture.data.session
      .prompt({
        sessionID,
        id: "msg_first",
        text: "First",
        gate: kind === "gate" ? gate.promise : undefined,
        prepare: () => {
          prepared.push("first")
          return gate.promise
        },
      })
      .catch((error: unknown) => error)
    const compact = fixture.data.session.compact({ sessionID, model: { providerID: "demo", id: "first" } })
    const following = fixture.data.session.prompt({
      sessionID,
      text: "Follow up",
      prepare: () => {
        prepared.push("following")
        return fixture.api.session.switchModel({ sessionID, model: { providerID: "demo", id: "second" } })
      },
    })
    if (kind === "prepare") await wait(() => prepared.includes("first"))
    gate.reject(new Error("Preparation failed"))
    expect(await first).toBeInstanceOf(Error)
    await wait(() => fixture.calls.includes("model"))
    expect(prepared).toEqual(kind === "prepare" ? ["first"] : [])
    fixture.model.resolve()
    fixture.response.resolve(Response.json({ data: item("msg_canonical") }))
    await Promise.all([compact, following])
    expect(fixture.calls).toEqual(["model", "compact", "model", "prompt"])
    expect(prepared.at(-1)).toBe("following")
    expect(fixture.data.session.message.list(sessionID)).toMatchObject([{ type: "user", text: "Follow up" }])
  },
)

test("creation failure rejects gated prompt, compaction, and following preparation without sending their RPCs", async () => {
  const creation = Promise.withResolvers<Response>()
  const requested = Promise.withResolvers<void>()
  using fixture = setup(async (request) => {
    if (!request.url.endsWith("/api/session")) return undefined
    requested.resolve()
    return creation.promise
  })
  const gate = Promise.withResolvers<void>()
  const prepared: string[] = []
  const created = fixture.data.session.create({ id: sessionID })
  const first = fixture.data.session.prompt({ sessionID, text: "First", gate: gate.promise })
  const compact = fixture.data.session.compact({ sessionID, model: { providerID: "demo", id: "model" } })
  const following = fixture.data.session.prompt({
    sessionID,
    text: "Follow up",
    prepare: async () => {
      prepared.push("following")
    },
  })
  const results = Promise.allSettled([created.request, first, compact, following])
  await requested.promise
  creation.resolve(new Response("Creation failed", { status: 500 }))
  expect((await results).map((result) => result.status)).toEqual(["rejected", "rejected", "rejected", "rejected"])
  expect(fixture.calls).toEqual([])
  expect(prepared).toEqual([])
  expect(fixture.data.session.get(sessionID)).toBeUndefined()
  expect(fixture.data.session.pending.list(sessionID)).toEqual([])
  expect(fixture.listeners.size).toBe(1)
  gate.resolve()
})

const sessionID = "ses_compact"
const event = { id: "evt_compact", created: 10, durable: { aggregateID: sessionID, seq: 1, version: 1 } }
const item = (id: string, timeCreated = 10): SessionInboxCompaction => ({
  id,
  sessionID,
  timeCreated,
  type: "compaction",
  delivery: "steer",
  payload: {},
})

function setup(override?: (request: Request) => Promise<Response | undefined>) {
  const model = Promise.withResolvers<void>()
  const response = Promise.withResolvers<Response>()
  const calls: string[] = []
  const proposals: string[] = []
  const pending: SessionInboxInfo[] = []
  const listeners = new Set<Parameters<CreateDataInput["event"]["listen"]>[0]>()
  const api = OpenCode.make({
    baseUrl: "http://opencode.local",
    fetch: async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init)
      const overridden = await override?.(request)
      if (overridden) return overridden
      const rpc = new URL(request.url).pathname.split("/").at(-1)
      if (rpc === "inbox") return Response.json({ data: pending })
      if (rpc === "model") {
        calls.push(rpc)
        await model.promise
        return new Response(null, { status: 204 })
      }
      if (rpc === "compact") {
        calls.push(rpc)
        proposals.push((await request.json()).id)
        return (await response.promise).clone()
      }
      if (rpc === "prompt") {
        calls.push(rpc)
        return Response.json({
          data: { ...item((await request.json()).id), type: "user", payload: { text: "Follow up" } },
        })
      }
      throw new Error(`Unexpected request: ${request.url}`)
    },
  })
  const root = createRoot((dispose) => ({
    data: createData({
      api: () => api,
      directory: "/project",
      event: {
        on: () => () => {},
        listen(handler) {
          listeners.add(handler)
          return () => listeners.delete(handler)
        },
      },
    }),
    dispose,
  }))
  const emit = (details: OpenCodeEvent) => listeners.forEach((listener) => listener({ name: details.type, details }))
  return {
    data: root.data,
    api,
    dispose: root.dispose,
    [Symbol.dispose]: root.dispose,
    model,
    response,
    calls,
    proposals,
    pending,
    listeners,
    emit,
    enqueue(id: string, created = 10) {
      emit({
        ...event,
        created,
        type: "session.inbox.enqueued",
        data: { sessionID, inboxID: id, item: { type: "compaction", delivery: "steer", payload: {} } },
      })
    },
  }
}

async function wait(predicate: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return
    await Bun.sleep(5)
  }
  throw new Error("Timed out waiting for request")
}
