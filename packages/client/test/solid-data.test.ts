import { expect, test } from "bun:test"
import { getEventListeners } from "node:events"
import { createRoot } from "solid-js"
import { createData, type CreateDataInput } from "../src/solid"
import { OpenCode, type OpenCodeEvent, type Project, type SessionInfo } from "../src/promise"

const session = (viewed: number): SessionInfo => ({
  id: "ses_refresh",
  projectID: "project",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  outcome: "succeeded",
  time: { created: 0, updated: 0, idle: 2, viewed },
  location: { directory: "/project" },
})

test("uses the configured initial window and retains normal cursor page sizes", async () => {
  const requests: { limit: string | null; cursor: string | null }[] = []
  const api = OpenCode.make({
    baseUrl: "http://opencode.local",
    fetch: async (input, init) => {
      const url = new URL((input instanceof Request ? input : new Request(input, init)).url)
      const cursor = url.searchParams.get("cursor")
      requests.push({ limit: url.searchParams.get("limit"), cursor })
      return Response.json({
        data: [{ id: cursor ? "msg_1" : "msg_2", type: "user", text: "History", time: { created: cursor ? 1 : 2 } }],
        cursor: cursor ? {} : { next: "older" },
      })
    },
  })
  const setup = createRoot((dispose) => ({
    data: createData({
      api: () => api,
      directory: "/project",
      initialMessageLimit: () => 40,
      event: { on: () => () => {}, listen: () => () => {} },
    }),
    dispose,
  }))
  try {
    await setup.data.session.message.sync("ses_refresh")
    await setup.data.session.message.sync("ses_refresh")
    expect(requests).toEqual([{ limit: "40", cursor: null }])
    await setup.data.session.message.loadMore("ses_refresh")
    expect(requests).toEqual([
      { limit: "40", cursor: null },
      { limit: "20", cursor: "older" },
    ])
    expect(setup.data.session.message.list("ses_refresh").map((message) => message.id)).toEqual(["msg_1", "msg_2"])
  } finally {
    setup.dispose()
  }
})

test("revalidates after an event overtakes an active session read", async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => (release = resolve))
  const listeners = new Set<Parameters<CreateDataInput["event"]["listen"]>[0]>()
  let requests = 0
  const api = OpenCode.make({
    baseUrl: "http://opencode.local",
    fetch: async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init)
      if (!request.url.endsWith("/api/session/ses_refresh")) throw new Error(`Unexpected request: ${request.url}`)
      requests++
      if (requests === 1) {
        await gate
        return Response.json({ data: session(1) })
      }
      return Response.json({ data: session(2) })
    },
  })
  const event: CreateDataInput["event"] = {
    on:
      <Type extends OpenCodeEvent["type"]>(
        _type: Type,
        _handler: (event: Extract<OpenCodeEvent, { type: Type }>) => void,
      ) =>
      () => {},
    listen(handler) {
      listeners.add(handler)
      return () => listeners.delete(handler)
    },
  }
  const setup = createRoot((dispose) => ({
    data: createData({ api: () => api, directory: "/project", event, connection: { status: () => "connected" } }),
    dispose,
  }))

  try {
    setup.data.session.remember(session(1))
    setup.data.session.invalidate("ses_refresh")
    const initial = setup.data.session.sync("ses_refresh")
    await wait(() => requests === 1)

    const viewed: OpenCodeEvent = {
      id: "evt_viewed",
      created: 2,
      type: "session.viewed",
      durable: { aggregateID: "ses_refresh", seq: 1, version: 1 },
      data: { sessionID: "ses_refresh", idle: 2 },
    }
    listeners.forEach((listener) => listener({ name: viewed.type, details: viewed }))
    await Bun.sleep(20)
    release()
    await initial

    await wait(() => requests === 2 && setup.data.session.get("ses_refresh")?.time.viewed === 2)
  } finally {
    setup.dispose()
  }
})

test("preserves a live session rename across concurrent session and family reads", async () => {
  const family = Promise.withResolvers<void>()
  const renamed = Promise.withResolvers<void>()
  const listeners = new Set<Parameters<CreateDataInput["event"]["listen"]>[0]>()
  let requests = 0
  const stale = { ...session(0), title: undefined }
  const api = OpenCode.make({
    baseUrl: "http://opencode.local",
    fetch: async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init)
      if (!request.url.endsWith(`/api/session/${stale.id}`)) return Response.json({ data: [], cursor: {} })
      requests++
      await (requests === 1 ? family.promise : renamed.promise)
      return Response.json({ data: stale })
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
    }),
    dispose,
  }))

  try {
    const initial = setup.data.session.sync(stale.id, { children: true })
    await wait(() => requests === 1)
    const event: OpenCodeEvent = {
      id: "evt_renamed",
      created: 1,
      type: "session.renamed",
      durable: { aggregateID: stale.id, seq: 1, version: 1 },
      data: { sessionID: stale.id, title: "Generated title" },
    }
    listeners.forEach((listener) => listener({ name: event.type, details: event }))
    await wait(() => requests === 2)
    renamed.resolve()
    await wait(() => setup.data.session.get(stale.id) !== undefined)
    family.resolve()
    await initial
    await Bun.sleep(0)

    expect(setup.data.session.get(stale.id)?.title).toBe("Generated title")
  } finally {
    family.resolve()
    renamed.resolve()
    setup.dispose()
  }
})

test("updates authoritative cached project metadata from live events", async () => {
  const listeners = new Set<Parameters<CreateDataInput["event"]["listen"]>[0]>()
  const original: Project = {
    id: "project_renamed",
    canonical: "/projects/original",
    name: "Original custom name",
    time: { created: 1, updated: 1 },
    sandboxes: [],
  }
  const unrelated: Project = {
    id: "project_unrelated",
    canonical: "/projects/unrelated",
    name: "Unrelated project",
    time: { created: 1, updated: 1 },
    sandboxes: [],
  }
  let requests = 0
  const api = OpenCode.make({
    baseUrl: "http://opencode.local",
    fetch: async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init)
      if (!request.url.endsWith("/api/project")) throw new Error(`Unexpected request: ${request.url}`)
      requests++
      return Response.json([original, unrelated])
    },
  })
  const event: CreateDataInput["event"] = {
    on: () => () => {},
    listen(handler) {
      listeners.add(handler)
      return () => listeners.delete(handler)
    },
  }
  const setup = createRoot((dispose) => ({
    data: createData({ api: () => api, directory: "/projects/original", event }),
    dispose,
  }))

  try {
    await setup.data.project.sync()
    expect(setup.data.project.get(original.id)).toEqual(original)

    const updated: OpenCodeEvent = {
      id: "evt_project_renamed",
      created: 2,
      type: "project.updated",
      data: {
        ...original,
        canonical: "/projects/renamed",
        name: "Updated custom name",
        time: { ...original.time, updated: 2 },
      },
    }
    listeners.forEach((listener) => listener({ name: updated.type, details: updated }))

    expect(setup.data.project.get(original.id)?.canonical).toBe("/projects/renamed")
    expect(setup.data.project.get(original.id)?.name).toBe("Updated custom name")
    expect(setup.data.project.get(unrelated.id)).toEqual(unrelated)
    expect(requests).toBe(1)

    const reset: OpenCodeEvent = {
      id: "evt_project_name_reset",
      created: 3,
      type: "project.updated",
      data: {
        id: original.id,
        canonical: "/projects/renamed-again",
        time: { ...original.time, updated: 3 },
        sandboxes: [],
      },
    }
    listeners.forEach((listener) => listener({ name: reset.type, details: reset }))

    expect(setup.data.project.get(original.id)?.canonical).toBe("/projects/renamed-again")
    expect(setup.data.project.get(original.id)?.name).toBeUndefined()
    expect(setup.data.project.get(unrelated.id)).toEqual(unrelated)
    expect(requests).toBe(1)
  } finally {
    setup.dispose()
  }
})

test("adopts cached directory-project sessions when their repository is resolved", async () => {
  const listeners = new Set<Parameters<CreateDataInput["event"]["listen"]>[0]>()
  const refreshed: SessionInfo = {
    ...session(0),
    id: "ses_uncached",
    projectID: "repository",
    location: { directory: "/unknown-alias" },
    subpath: "app",
  }
  const api = OpenCode.make({
    baseUrl: "http://opencode.local",
    fetch: async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init)
      if (!request.url.endsWith("/api/session/ses_uncached")) throw new Error(`Unexpected request: ${request.url}`)
      return Response.json({ data: refreshed })
    },
  })
  const setup = createRoot((dispose) => ({
    data: createData({
      api: () => api,
      directory: "/repo",
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
    const sessions: SessionInfo[] = [
      { ...session(0), id: "ses_root", projectID: "directory-root", location: { directory: "/repo" } },
      { ...session(0), id: "ses_nested", projectID: "directory-nested", location: { directory: "/repo/app" } },
      {
        ...session(0),
        id: "ses_alias",
        projectID: "directory-nested",
        location: { directory: "/repo/alias/../app" },
      },
      { ...session(0), id: "ses_symlink", projectID: "directory-nested", location: { directory: "/shortcut" } },
      { ...refreshed, projectID: "directory-uncached" },
      { ...session(0), id: "ses_global", projectID: "global", location: { directory: "/repo/legacy" } },
      { ...session(0), id: "ses_escaped", projectID: "global", location: { directory: "/repo/../other" } },
      { ...session(0), id: "ses_other", projectID: "other-repository", location: { directory: "/repo/vendor" } },
      { ...session(0), id: "ses_sibling", projectID: "global", location: { directory: "/repo-other" } },
      {
        ...session(0),
        id: "ses_remote",
        projectID: "directory-root",
        location: { directory: "/repo", workspaceID: "workspace-remote" },
      },
    ]
    sessions.forEach((item) => setup.data.session.remember(item))
    for (const project of [
      { id: "directory-root", canonical: "/repo" },
      { id: "directory-nested", canonical: "/repo/app" },
    ]) {
      const updated: OpenCodeEvent = {
        id: `evt_${project.id}`,
        created: 0,
        type: "project.updated",
        data: { ...project, time: { created: 0, updated: 0 }, sandboxes: [] },
      }
      listeners.forEach((listener) => listener({ name: updated.type, details: updated }))
    }

    const resolved: OpenCodeEvent = {
      id: "evt_repository_resolved",
      created: 1,
      type: "worktree.resolved",
      durable: { aggregateID: "repository", seq: 0, version: 1 },
      data: {
        projectID: "repository",
        directory: "/repo",
        previous: "global",
        adopted: ["directory-root", "directory-nested", "directory-uncached"],
      },
    }
    listeners.forEach((listener) => listener({ name: resolved.type, details: resolved }))

    expect(setup.data.session.get("ses_root")?.projectID).toBe("repository")
    expect(setup.data.session.get("ses_root")?.subpath).toBeUndefined()
    expect(setup.data.session.get("ses_nested")).toMatchObject({ projectID: "repository", subpath: "app" })
    expect(setup.data.session.get("ses_alias")).toMatchObject({ projectID: "repository", subpath: "app" })
    expect(setup.data.session.get("ses_symlink")).toMatchObject({ projectID: "repository", subpath: "app" })
    expect(setup.data.session.get("ses_global")).toMatchObject({ projectID: "repository", subpath: "legacy" })
    expect(setup.data.session.get("ses_escaped")?.projectID).toBe("global")
    expect(setup.data.session.get("ses_other")?.projectID).toBe("other-repository")
    expect(setup.data.session.get("ses_sibling")?.projectID).toBe("global")
    expect(setup.data.session.get("ses_remote")?.projectID).toBe("directory-root")
    await wait(() => setup.data.session.get("ses_uncached")?.projectID === "repository")
    expect(setup.data.session.get("ses_uncached")?.subpath).toBe("app")
  } finally {
    setup.dispose()
  }
})

test("refreshes global credential events across every loaded location and workspace", async () => {
  const listeners = new Set<Parameters<CreateDataInput["event"]["listen"]>[0]>()
  const requests: URL[] = []
  const api = OpenCode.make({
    baseUrl: "http://opencode.local",
    fetch: async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init)
      const url = new URL(request.url)
      requests.push(url)
      const directory = url.searchParams.get("location[directory]") ?? "/project"
      return Response.json({
        location: {
          directory,
          workspaceID: url.searchParams.get("location[workspace]") ?? undefined,
          project: { id: "project", directory, canonical: directory },
        },
        data: [],
      })
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
      connection: { status: () => "connected" },
    }),
    dispose,
  }))
  const locations = [{ directory: "/project" }, { directory: "/other", workspaceID: "workspace-other" }]

  try {
    await Promise.all(
      locations.flatMap((location) => [
        setup.data.location.integration.sync(location),
        setup.data.location.model.sync(location),
        setup.data.location.provider.sync(location),
        setup.data.location.reference.sync(location),
      ]),
    )
    const references = locations.map((location) => setup.data.location.reference.list(location))
    requests.length = 0

    const updated: OpenCodeEvent = {
      id: "evt_credential.updated",
      created: 1,
      type: "credential.updated",
      data: {},
    }
    listeners.forEach((listener) => listener({ name: updated.type, details: updated }))
    await wait(() => requests.length === 2)
    expect(
      requests.map((url) => [
        url.pathname,
        url.searchParams.get("location[directory]"),
        url.searchParams.get("location[workspace]"),
      ]),
    ).toEqual([
      ["/api/integration", "/project", null],
      ["/api/integration", "/other", "workspace-other"],
    ])
    requests.length = 0

    for (const credentialID of ["credential", null]) {
      const switched: OpenCodeEvent = {
        id: `evt_credential.switched.${credentialID}`,
        created: 2,
        type: "credential.switched",
        data: { credentialID, integrationID: "integration" },
      }
      listeners.forEach((listener) => listener({ name: switched.type, details: switched }))
      await wait(() => requests.length === 4)
      expect(
        requests.map((url) => [
          url.pathname,
          url.searchParams.get("location[directory]"),
          url.searchParams.get("location[workspace]"),
        ]),
      ).toEqual(
        expect.arrayContaining([
          ["/api/model", "/project", null],
          ["/api/provider", "/project", null],
          ["/api/model", "/other", "workspace-other"],
          ["/api/provider", "/other", "workspace-other"],
        ]),
      )
      locations.forEach((location, index) =>
        expect(setup.data.location.reference.list(location)).toBe(references[index]),
      )
      requests.length = 0
    }
  } finally {
    setup.dispose()
  }
})

test("refreshes references for the location an update names", async () => {
  const listeners = new Set<Parameters<CreateDataInput["event"]["listen"]>[0]>()
  const requests: URL[] = []
  const api = OpenCode.make({
    baseUrl: "http://opencode.local",
    fetch: async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init)
      const url = new URL(request.url)
      requests.push(url)
      const directory = url.searchParams.get("location[directory]") ?? "/project"
      return Response.json({
        location: {
          directory,
          workspaceID: url.searchParams.get("location[workspace]") ?? undefined,
          project: { id: "project", directory, canonical: directory },
        },
        data: [],
      })
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
      connection: { status: () => "connected" },
    }),
    dispose,
  }))
  const other = { directory: "/other", workspaceID: "workspace-other" }

  try {
    await Promise.all([setup.data.location.reference.sync(), setup.data.location.reference.sync(other)])
    requests.length = 0

    const updated: OpenCodeEvent = {
      id: "evt_reference.updated",
      created: 1,
      type: "reference.updated",
      location: other,
      data: {},
    }
    listeners.forEach((listener) => listener({ name: updated.type, details: updated }))
    await wait(() => requests.length === 1)
    expect([
      requests[0]!.pathname,
      requests[0]!.searchParams.get("location[directory]"),
      requests[0]!.searchParams.get("location[workspace]"),
    ]).toEqual(["/api/reference", "/other", "workspace-other"])
  } finally {
    setup.dispose()
  }
})

test("preserves sibling catalogs through location preload, branch, shell, and websearch updates", async () => {
  const listeners = new Set<Parameters<CreateDataInput["event"]["listen"]>[0]>()
  const location = { directory: "/project", project: { id: "project", directory: "/project", canonical: "/project" } }
  const requests: string[] = []
  const api = OpenCode.make({
    baseUrl: "http://opencode.local",
    fetch: async (input, init) => {
      const pathname = new URL((input instanceof Request ? input : new Request(input, init)).url).pathname
      requests.push(pathname)
      if (pathname === "/api/session/active") return Response.json({})
      if (pathname === "/api/project") return Response.json([])
      if (pathname === "/api/location") return Response.json(location)
      if (pathname === "/api/vcs")
        return Response.json({ location, data: { branch: { current: "main", default: "main" } } })
      if (pathname === "/api/reference")
        return Response.json({
          location,
          data: [{ name: "docs", path: "/docs", source: { type: "local", path: "/docs" } }],
        })
      if (pathname === "/api/websearch/provider")
        return Response.json({ location, data: [{ id: "search", name: "Search" }] })
      throw new Error(`Unexpected request: ${pathname}`)
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
  const shell = {
    id: "sh_first",
    status: "running" as const,
    command: "echo hello",
    cwd: location.directory,
    shell: "/bin/sh",
    file: "/shell-output",
    metadata: {},
    time: { started: 1 },
  }

  try {
    // A live event may arrive before any location reads have populated this key.
    emit({ type: "shell.created", location, data: { info: shell } })
    expect(setup.data.shell.get(shell.id)).toMatchObject(shell)
    const first = setup.data.shell.get(shell.id)
    await Promise.all([setup.data.location.reference.sync(), setup.data.location.vcs.sync()])
    const references = setup.data.location.reference.list()
    expect(references?.map((reference) => [reference.name, reference.path])).toEqual([["docs", "/docs"]])
    expect(setup.data.shell.get(shell.id)).toBe(first)

    emit({ type: "vcs.branch.updated", location, data: { branch: "feature" } })
    expect(setup.data.location.vcs.info()?.branch).toEqual({ current: "feature", default: "main" })
    expect(setup.data.location.reference.list()).toBe(references)
    emit({ type: "shell.created", location, data: { info: { ...shell, id: "sh_second" } } })
    expect(setup.data.shell.list().map((shell) => shell.id)).toEqual(["sh_first", "sh_second"])
    expect(setup.data.location.reference.list()).toBe(references)
    emit({ type: "shell.deleted", location, data: { id: "sh_second" } })
    expect(setup.data.shell.list().map((shell) => shell.id)).toEqual(["sh_first"])
    expect(setup.data.shell.get(shell.id)).toBe(first)
    expect(setup.data.location.reference.list()).toBe(references)

    await setup.data.location.websearch.refresh()
    expect(setup.data.location.websearch.list()).toEqual([{ id: "search", name: "Search" }])
    expect(setup.data.location.reference.list()).toBe(references)
    emit({ type: "server.connected", data: {} })
    await wait(() => setup.data.location.info() !== undefined)
    expect(setup.data.location.info()).toMatchObject(location)
    expect(setup.data.location.reference.list()).toBe(references)
    expect(setup.data.shell.get(shell.id)).toBe(first)
    expect(setup.data.location.vcs.info()?.branch).toEqual({ current: "feature", default: "main" })
    expect(requests.toSorted()).toEqual([
      "/api/location",
      "/api/project",
      "/api/reference",
      "/api/session/active",
      "/api/vcs",
      "/api/websearch/provider",
    ])
  } finally {
    setup.dispose()
  }
})

test("reports optimistic sessions as creating until the request settles", async () => {
  const release = Promise.withResolvers<void>()
  const api = OpenCode.make({
    baseUrl: "http://opencode.local",
    fetch: async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init)
      if (!request.url.endsWith("/api/session")) throw new Error(`Unexpected request: ${request.url}`)
      await release.promise
      return Response.json({ data: session(0) })
    },
  })
  const event: CreateDataInput["event"] = {
    on: () => () => {},
    listen: () => () => {},
  }
  const setup = createRoot((dispose) => ({
    data: createData({ api: () => api, directory: "/project", event, connection: { status: () => "connected" } }),
    dispose,
  }))

  try {
    const created = setup.data.session.create({ id: "ses_refresh", location: { directory: "/project" } })
    expect(setup.data.session.creating(created.id)).toBe(true)
    release.resolve()
    await created.request
    expect(setup.data.session.creating(created.id)).toBe(false)
  } finally {
    setup.dispose()
  }
})

test("loads bounded message pages", async () => {
  const requests: URL[] = []
  const api = OpenCode.make({
    baseUrl: "http://opencode.local",
    fetch: async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init)
      const url = new URL(request.url)
      requests.push(url)
      return Response.json({ data: [], cursor: requests.length === 1 ? { next: "next" } : {} })
    },
  })
  const setup = createRoot((dispose) => ({
    data: createData({
      api: () => api,
      directory: "/project",
      event: { on: () => () => {}, listen: () => () => {} },
    }),
    dispose,
  }))

  try {
    await setup.data.session.message.sync("ses_refresh")
    await setup.data.session.message.loadMore("ses_refresh")

    expect(requests).toHaveLength(2)
    expect(Object.fromEntries(requests[0].searchParams)).toEqual({ limit: "20", order: "desc" })
    expect(Object.fromEntries(requests[1].searchParams)).toEqual({ cursor: "next", limit: "20" })
  } finally {
    setup.dispose()
  }
})

test.each(["success", "failure", "cancel", "cancel-retry", "cancel-page", "join-cancel", "join-failure"])(
  "bulk history (%s)",
  async (mode) => {
    const messages = [1, 2, 3].map((index) => ({
      id: `msg_${index}`,
      type: "user",
      text: `Message ${index}`,
      time: { created: index },
    }))
    const release = Promise.withResolvers<void>()
    const controller = new AbortController()
    const requests: URL[] = []
    const publications: string[][] = []
    const api = OpenCode.make({
      baseUrl: "http://opencode.local",
      fetch: async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input))
        requests.push(url)
        const cursor = url.searchParams.get("cursor")
        if (!cursor) return Response.json({ data: [messages[2]], cursor: { next: "recent" } })
        if (cursor === "recent") {
          if (mode.startsWith("join")) await release.promise
          if (mode === "join-failure") return Response.json({ message: "offline" }, { status: 503 })
          return Response.json({ data: [messages[2], messages[1]], cursor: { next: "oldest" } })
        }
        if (cursor === "oldest") return Response.json({ data: [messages[0]], cursor: { next: "empty" } })
        expect(init?.signal).toBe(requests.length === 4 ? controller.signal : undefined)
        await release.promise
        if (mode === "failure") return Response.json({ message: "offline" }, { status: 503 })
        return Response.json({ data: [], cursor: {} })
      },
    })
    const setup = createRoot((dispose) => {
      const data = createData({
        api: () => api,
        directory: "/project",
        event: { on: () => () => {}, listen: () => () => {} },
      })
      return { data, dispose }
    })

    try {
      await setup.data.session.message.sync("ses_refresh")
      const newest = setup.data.session.message.get("ses_refresh", "msg_3")
      const load = setup.data.session.message.loadMore(
        "ses_refresh",
        mode.startsWith("join")
          ? undefined
          : {
              all: true,
              signal: controller.signal,
              beforePublish: () => {
                publications.push(setup.data.session.message.list("ses_refresh").map((message) => message.id))
                expect(setup.data.session.message.get("ses_refresh", "msg_3")).toBe(newest)
              },
            },
      )
      const joined = setup.data.session.message.loadMore("ses_refresh", { all: true, signal: controller.signal })
      const settled = Promise.allSettled([load, joined])
      if (mode.startsWith("join")) {
        await wait(() => requests.length === 2)
        expect(getEventListeners(controller.signal, "abort")).toHaveLength(1)
        controller.abort()
        let cancelled = false
        void joined.then(() => {
          cancelled = true
        })
        await wait(() => cancelled)
        expect(setup.data.session.message.loading("ses_refresh")).toBe(true)
        expect(getEventListeners(controller.signal, "abort")).toHaveLength(0)
        release.resolve()
        expect((await settled).map((result) => result.status)).toEqual(
          mode === "join-failure" ? ["rejected", "fulfilled"] : ["fulfilled", "fulfilled"],
        )
        expect(requests.at(-1)?.searchParams.get("limit")).toBe("20")
        expect(requests).toHaveLength(2)
        expect(setup.data.session.message.more("ses_refresh")).toBe(true)
        expect(setup.data.session.message.list("ses_refresh").map((message) => message.id)).toEqual(
          mode === "join-failure" ? ["msg_3"] : ["msg_2", "msg_3"],
        )
        return
      }
      await wait(() => requests.length === 4)
      expect(setup.data.session.message.loading("ses_refresh")).toBe(true)
      expect(setup.data.session.message.list("ses_refresh").map((message) => message.id)).toEqual(["msg_3"])
      expect(requests.slice(1).map((url) => url.searchParams.get("limit"))).toEqual(["200", "200", "200"])
      if (mode.startsWith("cancel")) controller.abort()
      const retry =
        mode === "cancel-retry" || mode === "cancel-page"
          ? setup.data.session.message.loadMore("ses_refresh", mode === "cancel-retry" ? { all: true } : undefined)
          : undefined
      release.resolve()
      expect((await settled).map((result) => result.status)).toEqual(
        mode === "failure" ? ["rejected", "rejected"] : ["fulfilled", "fulfilled"],
      )
      await retry
      const success = mode === "success" || mode === "cancel-retry"
      expect(setup.data.session.message.loading("ses_refresh")).toBe(false)
      expect(setup.data.session.message.more("ses_refresh")).toBe(!success)
      expect(setup.data.session.message.list("ses_refresh").map((message) => message.id)).toEqual(
        success ? ["msg_1", "msg_2", "msg_3"] : mode === "cancel-page" ? ["msg_2", "msg_3"] : ["msg_3"],
      )
      expect(setup.data.session.message.get("ses_refresh", "msg_3")).toBe(newest)
      expect(requests).toHaveLength(mode === "cancel-retry" ? 7 : mode === "cancel-page" ? 5 : 4)
      if (mode === "cancel-page") expect(requests.at(-1)?.searchParams.get("limit")).toBe("20")
      expect(publications).toEqual(mode === "success" ? [["msg_3"]] : [])
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0)
    } finally {
      release.resolve()
      setup.dispose()
    }
  },
)

test.each([
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "session.execution.started",
  "session.deleted",
] as const)("preserves %s activity when an older snapshot arrives", async (type) => {
  const release = Promise.withResolvers<void>()
  const requested = Promise.withResolvers<void>()
  const setup = activityFixture(async () => {
    requested.resolve()
    await release.promise
    return Response.json({
      data: {
        ...(type === "session.execution.started" ? {} : { ses_refresh: { type: "running" } }),
        ses_hydrated: { type: "running" },
      },
    })
  })

  try {
    if (type !== "session.execution.started") setup.data.session.setStatus("ses_refresh", "running")
    setup.emit({ type: "server.connected", data: {} })
    await requested.promise
    setup.emit({
      id: "evt_activity",
      created: 2,
      type,
      durable: { aggregateID: "ses_refresh", seq: 2, version: 1 },
      data: { sessionID: "ses_refresh", reason: "user" },
    })
    expect(setup.data.session.status("ses_refresh")).toBe(type === "session.execution.started" ? "running" : "idle")
    release.resolve()
    await wait(() => setup.data.session.status("ses_hydrated") === "running")
    expect(setup.data.session.status("ses_refresh")).toBe(type === "session.execution.started" ? "running" : "idle")
  } finally {
    release.resolve()
    setup.dispose()
  }
})

test("ignores activity snapshots from an older connection", async () => {
  const reads: ReturnType<typeof Promise.withResolvers<Response>>[] = []
  const setup = activityFixture(() => {
    const read = Promise.withResolvers<Response>()
    reads.push(read)
    return read.promise
  })

  try {
    setup.emit({ type: "server.connected", data: {} })
    await wait(() => reads.length === 1)
    setup.emit({ type: "server.connected", data: {} })
    await wait(() => reads.length === 2)
    reads[1]?.resolve(Response.json({ data: { ses_new: { type: "running" } } }))
    await wait(() => setup.data.session.status("ses_new") === "running")
    reads[0]?.resolve(Response.json({ data: { ses_old: { type: "running" } } }))
    await Bun.sleep(20)
    expect(setup.data.session.status("ses_new")).toBe("running")
    expect(setup.data.session.status("ses_old")).toBe("idle")
  } finally {
    reads.forEach((read) => read.resolve(Response.json({ data: {} })))
    setup.dispose()
  }
})

test("projects background user shell metadata from durable shell data", () => {
  const setup = activityFixture(() => Response.json({ data: {} }))
  try {
    setup.emit({
      id: "evt_user_shell",
      created: 1,
      type: "session.shell.started",
      durable: { aggregateID: "ses_refresh", seq: 1, version: 1 },
      data: {
        sessionID: "ses_refresh",
        shell: {
          id: "sh_user",
          status: "running",
          command: "pwd",
          cwd: "/project",
          shell: "/bin/sh",
          file: "/project/shell.out",
          metadata: { sessionID: "ses_refresh", background: true },
          time: { started: 1 },
        },
      },
    })
    expect(setup.data.session.message.list("ses_refresh")).toMatchObject([
      { type: "shell", shellID: "sh_user", status: "running", metadata: { background: true } },
    ])
  } finally {
    setup.dispose()
  }
})

function activityFixture(read: () => Response | Promise<Response>) {
  const listeners = new Set<Parameters<CreateDataInput["event"]["listen"]>[0]>()
  const api = OpenCode.make({
    baseUrl: "http://opencode.local",
    fetch: async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init)
      const path = new URL(request.url).pathname
      if (path === "/api/session/active") return read()
      if (path === "/api/project") return Response.json([])
      if (path === "/api/location") return Response.json({ directory: "/project" })
      return Response.json({ location: { directory: "/project" }, data: { branch: "main" } })
    },
  })
  return createRoot((dispose) => ({
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
    emit: (details: OpenCodeEvent) => listeners.forEach((listener) => listener({ name: details.type, details })),
    dispose,
  }))
}

async function wait(check: () => boolean) {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > 2_000) throw new Error("Timed out waiting for condition")
    await Bun.sleep(10)
  }
}
