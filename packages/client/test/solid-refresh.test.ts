import { expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createData, settleMs, type CreateDataInput } from "../src/solid"
import { OpenCode, type OpenCodeEvent, type SessionInfo } from "../src/promise"

test("config reads and update refreshes are opt-in", async () => {
  const listeners = new Set<Parameters<CreateDataInput["event"]["listen"]>[0]>()
  const requests: string[] = []
  const location = { directory: "/project" }
  let model = "provider/first"
  const api = OpenCode.make({
    baseUrl: "http://opencode.local",
    fetch: async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init)
      const url = new URL(request.url)
      requests.push(url.pathname)
      if (url.pathname === "/api/location") return Response.json(location)
      if (url.pathname === "/api/config") return Response.json([{ type: "document", info: { model } }])
      if (url.pathname === "/api/mcp/resource")
        return Response.json({ location, data: { resources: [], templates: [] } })
      return Response.json({ location, data: [] })
    },
  })
  const setup = createRoot((dispose) => ({
    data: createData({
      api: () => api,
      directory: location.directory,
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
  const event: OpenCodeEvent = { id: "evt_config", created: 1, type: "config.updated", location, data: {} }
  try {
    await setup.data.location.sync()
    listeners.forEach((listener) => listener({ name: event.type, details: event }))
    expect(requests).not.toContain("/api/config")

    await setup.data.location.config.sync()
    expect(requests.filter((path) => path === "/api/config")).toHaveLength(1)
    model = "provider/second"
    listeners.forEach((listener) => listener({ name: event.type, details: event }))
    await setup.data.location.config.sync()
    expect(requests.filter((path) => path === "/api/config")).toHaveLength(2)
    expect(setup.data.location.config.list()).toEqual([{ type: "document", info: { model } }])
  } finally {
    setup.dispose()
  }
})

test("event refreshes report failures, remain retryable, and preserve explicit read errors", async () => {
  const listeners = new Set<Parameters<CreateDataInput["event"]["listen"]>[0]>()
  const reported = Promise.withResolvers<unknown>()
  const errors: unknown[] = []
  const state = { offline: true, requests: 0 }
  const session: SessionInfo = {
    id: "ses_refresh_failure",
    projectID: "project",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 0, updated: 0, idle: 2 },
    location: { directory: "/project" },
  }
  const api = OpenCode.make({
    baseUrl: "http://opencode.local",
    fetch: async () => {
      state.requests++
      if (state.offline) throw new TypeError("Failed to fetch")
      return Response.json({ data: { ...session, title: "Recovered" } })
    },
  })
  const setup = createRoot((dispose) => ({
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
      onError(error) {
        errors.push(error)
        reported.resolve(error)
      },
    }),
    dispose,
  }))
  const event: OpenCodeEvent = {
    id: "evt_refresh_failure",
    created: 2,
    type: "session.viewed",
    durable: { aggregateID: session.id, seq: 1, version: 1 },
    data: { sessionID: session.id, idle: 2 },
  }
  try {
    setup.data.session.remember(session)
    setup.data.session.invalidate(session.id)
    await expect(setup.data.session.sync(session.id)).rejects.toThrow("Transport")
    expect(errors).toEqual([])
    listeners.forEach((listener) => listener({ name: event.type, details: event }))
    expect(String(await reported.promise)).toContain("Transport")
    expect(errors).toHaveLength(1)
    expect(setup.data.session.get(session.id)?.title).toBeUndefined()
    state.offline = false
    listeners.forEach((listener) => listener({ name: event.type, details: event }))
    await setup.data.session.sync(session.id)
    expect(setup.data.session.get(session.id)?.title).toBe("Recovered")
    expect(state.requests).toBe(3)
  } finally {
    setup.dispose()
  }
})

test.each(["reconnecting", "disposed"] as const)("background reads respect %s owners", async (mode) => {
  const listeners = new Set<Parameters<CreateDataInput["event"]["listen"]>[0]>()
  const pending = Promise.withResolvers<Response>()
  const errors: unknown[] = []
  const state = { requests: 0 }
  const api = OpenCode.make({
    baseUrl: "http://opencode.local",
    fetch: () => {
      state.requests++
      return pending.promise
    },
  })
  const setup = createRoot((dispose) => ({
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
      connection: { status: () => (mode === "reconnecting" ? "reconnecting" : "connected") },
      onError: (error) => errors.push(error),
    }),
    dispose,
  }))
  const event: OpenCodeEvent = {
    id: "evt_refresh_owner",
    type: "command.updated",
    location: { directory: "/project" },
    data: {},
  }
  listeners.forEach((listener) => listener({ name: event.type, details: event }))
  expect(state.requests).toBe(0)
  await new Promise((resolve) => setTimeout(resolve, settleMs * 2))
  if (mode === "reconnecting") {
    expect(state.requests).toBe(0)
    setup.dispose()
    return
  }
  expect(state.requests).toBe(1)
  const joined = setup.data.location.command.sync()
  setup.dispose()
  pending.reject(new TypeError("Failed to fetch"))
  await expect(joined).rejects.toThrow("Transport")
  expect(state.requests).toBe(1)
  expect(errors).toEqual([])
})

test("a burst of mcp.status.changed events refetches the server list once it settles", async () => {
  const listeners = new Set<Parameters<CreateDataInput["event"]["listen"]>[0]>()
  const requests: string[] = []
  const location = { directory: "/project" }
  const api = OpenCode.make({
    baseUrl: "http://opencode.local",
    fetch: async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init)
      requests.push(new URL(request.url).pathname)
      return Response.json({ location, data: [] })
    },
  })
  const setup = createRoot((dispose) => ({
    data: createData({
      api: () => api,
      directory: location.directory,
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
  try {
    await setup.data.location.mcp.server.sync()
    expect(requests.filter((path) => path === "/api/mcp")).toHaveLength(1)
    for (const server of ["a", "b", "c", "d", "e"]) {
      const event: OpenCodeEvent = { id: `evt_${server}`, created: 1, type: "mcp.status.changed", location, data: { server } }
      listeners.forEach((listener) => listener({ name: event.type, details: event }))
    }
    expect(requests.filter((path) => path === "/api/mcp")).toHaveLength(1)
    await new Promise((resolve) => setTimeout(resolve, settleMs * 2))
    expect(requests.filter((path) => path === "/api/mcp")).toHaveLength(2)
  } finally {
    setup.dispose()
  }
})

test("a burst of catalog, integration, and credential events refetches each catalog once per location", async () => {
  const listeners = new Set<Parameters<CreateDataInput["event"]["listen"]>[0]>()
  const requests: string[] = []
  const location = { directory: "/project" }
  const other = { directory: "/other", workspaceID: "workspace-other" }
  const api = OpenCode.make({
    baseUrl: "http://opencode.local",
    fetch: async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init)
      const url = new URL(request.url)
      requests.push(`${url.pathname} ${url.searchParams.get("location[directory]")}`)
      return Response.json({
        location: {
          directory: url.searchParams.get("location[directory]"),
          workspaceID: url.searchParams.get("location[workspace]") ?? undefined,
        },
        data: [],
      })
    },
  })
  const setup = createRoot((dispose) => ({
    data: createData({
      api: () => api,
      directory: location.directory,
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
  try {
    await Promise.all(
      [location, other].flatMap((ref) => [
        setup.data.location.integration.sync(ref),
        setup.data.location.model.sync(ref),
        setup.data.location.provider.sync(ref),
      ]),
    )
    requests.length = 0
    emit({ id: "evt_catalog", created: 1, type: "catalog.updated", location, data: {} })
    emit({ id: "evt_integration", created: 2, type: "integration.updated", location, data: {} })
    emit({ id: "evt_credential", created: 3, type: "credential.updated", data: {} })
    emit({ id: "evt_catalog_again", created: 4, type: "catalog.updated", location, data: {} })
    expect(requests).toEqual([])
    await new Promise((resolve) => setTimeout(resolve, settleMs * 2))
    expect(requests.toSorted()).toEqual([
      "/api/integration /other",
      "/api/integration /project",
      "/api/model /project",
      "/api/provider /project",
    ])
  } finally {
    setup.dispose()
  }
})

test("invalidations that land before a queued reload starts are absorbed by it", async () => {
  const pending: Array<PromiseWithResolvers<Response>> = []
  const location = { directory: "/project" }
  const api = OpenCode.make({
    baseUrl: "http://opencode.local",
    fetch: () => {
      const deferred = Promise.withResolvers<Response>()
      pending.push(deferred)
      return deferred.promise
    },
  })
  const setup = createRoot((dispose) => ({
    data: createData({
      api: () => api,
      directory: location.directory,
      event: { on: () => () => {}, listen: () => () => {} },
    }),
    dispose,
  }))
  try {
    const first = setup.data.location.agent.sync()
    expect(pending).toHaveLength(1)
    setup.data.location.agent.invalidate()
    const second = setup.data.location.agent.sync()
    setup.data.location.agent.invalidate()
    const third = setup.data.location.agent.sync()
    setup.data.location.agent.invalidate()
    expect(pending).toHaveLength(1)
    pending[0].resolve(Response.json({ location, data: [] }))
    await first
    await Promise.resolve()
    expect(pending).toHaveLength(2)
    pending[1].resolve(Response.json({ location, data: [{ name: "reviewer" }] }))
    await Promise.all([second, third])
    expect(pending).toHaveLength(2)
    await setup.data.location.agent.sync()
    expect(pending).toHaveLength(2)
  } finally {
    setup.dispose()
  }
})
