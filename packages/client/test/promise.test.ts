import { expect, test } from "bun:test"
import { isSessionNotFoundError, isUnauthorizedError, OpenCode } from "../src/promise/index"

test("exposes every standard HTTP API group", () => {
  const client = OpenCode.make({ baseUrl: "http://localhost:3000" })

  expect(Object.keys(client)).toEqual([
    "health",
    "server",
    "location",
    "agent",
    "plugin",
    "session",
    "message",
    "model",
    "generate",
    "provider",
    "integration",
    "mcp",
    "credential",
    "project",
    "form",
    "permission",
    "file",
    "command",
    "skill",
    "rpc",
    "event",
    "pty",
    "experimental",
    "shell",
    "reference",
    "worktree",
    "workspace",
    "vcs",
    "debug",
    "migration",
    "websearch",
    "config",
  ])
  expect(Object.keys(client.debug)).toEqual(["location"])
  expect(Object.keys(client.debug.location)).toEqual(["list", "evict"])
  expect(Object.keys(client.message)).toEqual(["list"])
  expect(Object.keys(client.integration)).toEqual(["list", "get", "wellknown", "connect", "oauth", "command"])
  expect(Object.keys(client.integration.wellknown)).toEqual(["add"])
  expect(Object.keys(client.integration.connect)).toEqual(["key"])
  expect(Object.keys(client.integration.oauth)).toEqual(["connect", "status", "complete", "cancel"])
  expect(Object.keys(client.integration.command)).toEqual(["connect", "status", "cancel"])
  expect(Object.keys(client.websearch)).toEqual(["providers", "query"])
  expect(Object.keys(client.file)).toEqual(["read", "list", "find"])
  expect(Object.keys(client.vcs)).toEqual(["get", "base", "status", "branches", "diff"])
  expect(Object.keys(client.pty)).toEqual(["list", "create", "get", "update", "remove", "connect"])
  expect(Object.keys(client.pty.connect)).toEqual(["token"])
  expect(Object.keys(client.experimental)).toEqual(["persistentPty"])
  expect(client.experimental.persistentPty.read).toBeFunction()
  expect(Object.keys(client.shell)).toEqual(["list", "create", "get", "timeout", "output", "remove"])
  expect(Object.keys(client.project)).toEqual(["list", "update", "current"])
  expect(Object.keys(client.worktree)).toEqual(["list", "create", "remove", "refresh", "inventory"])
})

test("config.get returns ordered config entries for a location", async () => {
  let request: Request | undefined
  const entries = [
    {
      type: "document" as const,
      path: "/tmp/project/opencode.json",
      info: {
        permissions: [
          { action: "shell", resource: "*", effect: "ask" as const },
          { action: "shell", resource: "git status", effect: "allow" as const },
        ],
      },
    },
  ]
  const client = OpenCode.make({
    baseUrl: "http://localhost:3000",
    fetch: async (input) => {
      request = input instanceof Request ? input : new Request(input)
      return Response.json(entries)
    },
  })

  expect(await client.config.get({ location: { directory: "/tmp/project" } })).toEqual(entries)
  expect(request?.method).toBe("GET")
  expect(request?.url).toBe("http://localhost:3000/api/config?location%5Bdirectory%5D=%2Ftmp%2Fproject")
})

test("vcs.base and committed diffs preserve location and explicit base on the wire", async () => {
  const requests: Request[] = []
  const location = { directory: "/repo", project: { id: "global", directory: "/repo", canonical: "/repo" } }
  const base = { name: "release", ref: "refs/remotes/origin/release", source: "reflog" }
  const client = OpenCode.make({
    baseUrl: "http://localhost:3000",
    fetch: async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init)
      requests.push(request)
      return Response.json({ location, data: new URL(request.url).pathname.endsWith("/base") ? base : [] })
    },
  })
  expect(await client.vcs.base({ location: { directory: "/repo" } })).toEqual({ location, data: base })
  expect(
    await client.vcs.diff({ location: { directory: "/repo" }, mode: "committed", base: base.ref, context: 1 }),
  ).toEqual({ location, data: [] })
  expect(new URL(requests[0].url).pathname).toBe("/api/vcs/base")
  const query = new URL(requests[1].url).searchParams
  expect(query.get("location[directory]")).toBe("/repo")
  expect(query.get("mode")).toBe("committed")
  expect(query.get("base")).toBe(base.ref)
  expect(query.get("context")).toBe("1")
})

test("vcs.diff exposes unavailable comparisons as errors, not empty diffs", async () => {
  const client = OpenCode.make({
    baseUrl: "http://localhost:3000",
    fetch: async () =>
      Response.json(
        { _tag: "ServiceUnavailableError", service: "vcs", message: "No review base available" },
        { status: 503 },
      ),
  })
  await expect(client.vcs.diff({ mode: "committed" })).rejects.toMatchObject({
    _tag: "ServiceUnavailableError",
    service: "vcs",
    message: "No review base available",
  })
})

test("project.update uses the global project contract", async () => {
  let request: Request | undefined
  const project = {
    id: "proj_test",
    canonical: "/tmp/project",
    commands: { start: "bun install" },
    time: { created: 1, updated: 2 },
    sandboxes: [],
  }
  const client = OpenCode.make({
    baseUrl: "http://localhost:3000",
    fetch: async (input, init) => {
      request = input instanceof Request ? input : new Request(input, init)
      return Response.json(project)
    },
  })

  expect(await client.project.update({ projectID: "proj_test", commands: { start: "bun install" } })).toEqual(project)
  expect(request?.method).toBe("PATCH")
  expect(request?.url).toBe("http://localhost:3000/api/project/proj_test")
  expect(await request?.json()).toEqual({ commands: { start: "bun install" } })
})

test("generate.text uses the locationless public contract", async () => {
  let request: Request | undefined
  const client = OpenCode.make({
    baseUrl: "http://localhost:3000",
    fetch: async (input, init) => {
      request = input instanceof Request ? input : new Request(input, init)
      return Response.json({ data: { text: "pong" } })
    },
  })

  expect(await client.generate.text({ prompt: "ping" })).toEqual({ text: "pong" })
  expect(request?.url).toBe("http://localhost:3000/api/generate")
  expect(await request?.json()).toEqual({ prompt: "ping" })
})

test("websearch.query uses the public HTTP contract", async () => {
  let request: Request | undefined
  const client = OpenCode.make({
    baseUrl: "http://localhost:3000",
    fetch: async (input, init) => {
      request = input instanceof Request ? input : new Request(input, init)
      return Response.json({
        location: { directory: "/tmp/project", project: { id: "proj_test", directory: "/tmp/project" } },
        data: {
          providerID: "exa",
          results: [{ url: "https://example.com", title: "Result", content: "result", time: {} }],
        },
      })
    },
  })

  const result = await client.websearch.query({
    query: "opencode",
    providerID: "exa",
    location: { directory: "/tmp/project" },
  })

  expect(result.data).toEqual({
    providerID: "exa",
    results: [{ url: "https://example.com", title: "Result", content: "result", time: {} }],
  })
  expect(request?.method).toBe("POST")
  expect(request?.url).toBe("http://localhost:3000/api/websearch?location%5Bdirectory%5D=%2Ftmp%2Fproject")
  expect(await request?.json()).toEqual({ query: "opencode", providerID: "exa" })
})

test("server.get uses the public HTTP contract", async () => {
  let request: Request | undefined
  const client = OpenCode.make({
    baseUrl: "http://localhost:3000",
    fetch: async (input) => {
      request = input instanceof Request ? input : new Request(input)
      return Response.json({ urls: ["http://192.168.1.10:4096"] })
    },
  })

  expect(await client.server.get()).toEqual({ urls: ["http://192.168.1.10:4096"] })
  expect(request?.method).toBe("GET")
  expect(request?.url).toBe("http://localhost:3000/api/server")
})

test("experimental wellknown integration add uses the public HTTP contract", async () => {
  let request: Request | undefined
  const client = OpenCode.make({
    baseUrl: "http://localhost:3000",
    fetch: async (input, init) => {
      request = input instanceof Request ? input : new Request(input, init)
      return new Response(null, { status: 204 })
    },
  })

  await client.integration.wellknown.add({
    url: "https://example.com",
    location: { directory: "/tmp/project" },
  })

  expect(request?.method).toBe("POST")
  expect(request?.url).toBe(
    "http://localhost:3000/api/experimental/integration/wellknown?location%5Bdirectory%5D=%2Ftmp%2Fproject",
  )
  expect(await request?.json()).toEqual({ url: "https://example.com" })
})

test("credential.activate uses the public HTTP contract", async () => {
  let request: Request | undefined
  const client = OpenCode.make({
    baseUrl: "http://localhost:3000",
    fetch: async (input, init) => {
      request = input instanceof Request ? input : new Request(input, init)
      return new Response(null, { status: 204 })
    },
  })

  await client.credential.activate({ credentialID: "cred_work", location: { directory: "/tmp/project" } })

  expect(request?.method).toBe("POST")
  expect(request?.url).toBe(
    "http://localhost:3000/api/credential/cred_work/activate?location%5Bdirectory%5D=%2Ftmp%2Fproject",
  )
})

test("integration connections optionally submit a form answer", async () => {
  const requests: Request[] = []
  const client = OpenCode.make({
    baseUrl: "http://localhost:3000",
    fetch: async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init)
      requests.push(request)
      if (request.url.endsWith("/connect/key")) return new Response(null, { status: 204 })
      return Response.json({
        location: { directory: "/tmp/project", project: { id: "proj_test", directory: "/tmp/project" } },
        data: {
          attemptID: "con_test",
          url: "https://example.com/authorize",
          instructions: "Authorize",
          mode: "auto",
          time: { created: 1, expires: 2 },
        },
      })
    },
  })

  await client.integration.connect.key({
    integrationID: "cloudflare-workers-ai",
    key: "secret",
    answer: { accountId: "account" },
  })
  await client.integration.oauth.connect({
    integrationID: "github-copilot",
    methodID: "device",
    answer: { deploymentType: "enterprise", enabled: true, scopes: ["read:user"] },
  })
  await client.integration.connect.key({ integrationID: "openai", key: "secret" })
  await client.integration.oauth.connect({ integrationID: "openai", methodID: "device" })

  expect(await requests[0].json()).toEqual({ key: "secret", answer: { accountId: "account" } })
  expect(await requests[1].json()).toEqual({
    methodID: "device",
    answer: { deploymentType: "enterprise", enabled: true, scopes: ["read:user"] },
  })
  expect(await requests[2].json()).toEqual({ key: "secret" })
  expect(await requests[3].json()).toEqual({ methodID: "device" })
})

test("MCP resource catalog uses the public HTTP contract", async () => {
  let request: Request | undefined
  const client = OpenCode.make({
    baseUrl: "http://localhost:3000",
    fetch: async (input) => {
      request = input instanceof Request ? input : new Request(input)
      return Response.json({
        location: { directory: "/tmp/project", project: { id: "proj_test", directory: "/tmp/project" } },
        data: {
          resources: [{ server: "docs", name: "Readme", uri: "docs://readme" }],
          templates: [{ server: "docs", name: "File", uriTemplate: "docs://{path}" }],
        },
      })
    },
  })

  const result = await client.mcp.resource.catalog({ location: { directory: "/tmp/project" } })

  expect(result.data.resources[0]?.uri).toBe("docs://readme")
  expect(request?.method).toBe("GET")
  expect(request?.url).toBe("http://localhost:3000/api/mcp/resource?location%5Bdirectory%5D=%2Ftmp%2Fproject")
})

test("file.read returns binary content from the public HTTP contract", async () => {
  let request: Request | undefined
  const client = OpenCode.make({
    baseUrl: "http://localhost:3000",
    fetch: async (input) => {
      request = input instanceof Request ? input : new Request(input)
      return new Response(new Uint8Array([104, 105]))
    },
  })

  const content = await client.file.read({
    path: "src/a b#c.ts",
    location: { directory: "/tmp/project" },
  })

  expect(Array.from(content)).toEqual([104, 105])
  expect(request?.url).toBe(
    "http://localhost:3000/api/fs/read/src/a%20b%23c.ts?location%5Bdirectory%5D=%2Ftmp%2Fproject",
  )
})

test("worktree discovery and mutations use location-based routes without a project parameter", async () => {
  const requests: Request[] = []
  const client = OpenCode.make({
    baseUrl: "http://localhost:3000",
    fetch: async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init)
      requests.push(request)
      if (request.method === "GET") return Response.json([{ directory: "/tmp/project" }])
      if (request.method === "POST" && !request.url.endsWith("/refresh"))
        return Response.json({ directory: "/tmp/worktrees/api" })
      return new Response(null, { status: 204 })
    },
  })

  expect(await client.worktree.list()).toEqual([{ directory: "/tmp/project" }])
  expect(
    await client.worktree.create({
      strategy: "git",
      directory: "/tmp/worktrees",
      name: "api",
    }),
  ).toEqual({ directory: "/tmp/worktrees/api" })
  await client.worktree.remove({
    directory: "/tmp/worktrees/api",
    force: false,
  })
  await client.worktree.refresh()

  expect(requests.map((request) => [request.method, request.url])).toEqual([
    ["GET", "http://localhost:3000/api/worktree"],
    ["POST", "http://localhost:3000/api/worktree"],
    ["DELETE", "http://localhost:3000/api/worktree"],
    ["POST", "http://localhost:3000/api/worktree/refresh"],
  ])
  expect(await requests[1]?.json()).toEqual({
    strategy: "git",
    directory: "/tmp/worktrees",
    name: "api",
  })
  expect(await requests[2]?.json()).toEqual({ directory: "/tmp/worktrees/api", force: false })
})

test("worktree operations send the configuration location separately from their payload", async () => {
  const requests: Request[] = []
  const client = OpenCode.make({
    baseUrl: "http://localhost:3000",
    fetch: async (input, init) => {
      const request = new Request(input, init)
      requests.push(request)
      if (request.method === "GET") return Response.json([{ directory: "/configured/task", strategy: "git" }])
      if (request.method === "DELETE" || new URL(request.url).pathname.endsWith("/refresh"))
        return new Response(null, { status: 204 })
      return Response.json({ directory: "/configured/task" })
    },
  })
  expect(await client.worktree.create({ location: { directory: "/repo/nested" }, name: "task" })).toEqual({
    directory: "/configured/task",
  })
  expect(requests[0]?.url).toBe("http://localhost:3000/api/worktree?location%5Bdirectory%5D=%2Frepo%2Fnested")
  expect(await requests[0]?.json()).toEqual({ name: "task" })
  await client.worktree.remove({
    location: { directory: "/repo/nested" },
    directory: "/configured/task",
    force: true,
  })
  await client.worktree.refresh({ location: { directory: "/repo/nested" } })
  expect(requests[1]?.url).toBe("http://localhost:3000/api/worktree?location%5Bdirectory%5D=%2Frepo%2Fnested")
  expect(await requests[1]?.json()).toEqual({ directory: "/configured/task", force: true })
  expect(requests[2]?.url).toBe("http://localhost:3000/api/worktree/refresh?location%5Bdirectory%5D=%2Frepo%2Fnested")
  expect(await client.worktree.list({ location: { directory: "/repo/nested" } })).toEqual([
    { directory: "/configured/task", strategy: "git" },
  ])
  expect(requests[3]?.url).toBe("http://localhost:3000/api/worktree?location%5Bdirectory%5D=%2Frepo%2Fnested")
})

test("workspace.destroy returns the transition result", async () => {
  let request: Request | undefined
  const client = OpenCode.make({
    baseUrl: "http://localhost:3000",
    fetch: async (input, init) => {
      request = input instanceof Request ? input : new Request(input, init)
      return Response.json({ destroyed: false })
    },
  })

  expect(await client.workspace.destroy({ workspaceID: "wrk_missing" })).toEqual({ destroyed: false })
  expect(request?.method).toBe("DELETE")
  expect(request?.url).toBe("http://localhost:3000/api/workspace/wrk_missing")
})

test("shell list and remove use the public HTTP contract", async () => {
  const requests: Array<{ method: string; url: string }> = []
  const shell = {
    id: "sh_test",
    status: "running",
    command: "pwd",
    cwd: "/tmp/project",
    shell: "/bin/zsh",
    file: "/tmp/opencode-shell",
    metadata: { sessionID: "ses_test" },
    time: { started: 1_717_171_717_000 },
  }
  const client = OpenCode.make({
    baseUrl: "http://localhost:3000",
    fetch: async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init)
      requests.push({ method: request.method, url: request.url })
      if (request.method === "DELETE") return new Response(null, { status: 204 })
      return Response.json({
        location: { directory: "/tmp/project", project: { id: "proj_test", directory: "/tmp/project" } },
        data: [shell],
      })
    },
  })

  const result = await client.shell.list({ location: { directory: "/tmp/project" } })
  await client.shell.remove({ id: shell.id })

  expect(result.data).toEqual([shell])
  expect(requests).toEqual([
    { method: "GET", url: "http://localhost:3000/api/shell?location%5Bdirectory%5D=%2Ftmp%2Fproject" },
    { method: "DELETE", url: "http://localhost:3000/api/shell/sh_test" },
  ])
})

test("session.get returns the wire projection", async () => {
  const client = OpenCode.make({
    baseUrl: "http://localhost:3000",
    fetch: async (input) => {
      expect(typeof input === "string" ? input : input instanceof URL ? input.href : input.url).toBe(
        "http://localhost:3000/api/session/ses_test",
      )
      return Response.json(session)
    },
  })

  const result = await client.session.get({ sessionID: "ses_test" })

  expect(result.time.created).toBe(1_717_171_717_000)
})

test("session instructions methods use the public HTTP contract", async () => {
  const requests: Array<{ method: string; url: string; body?: unknown }> = []
  const instructions = [{ key: "review-notes", value: { text: "Check the diff", priority: 1 } }]
  const client = OpenCode.make({
    baseUrl: "http://localhost:3000",
    fetch: async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init)
      requests.push({
        method: request.method,
        url: request.url,
        body: request.method === "PUT" ? await request.json() : undefined,
      })
      if (request.method === "GET") return Response.json({ data: instructions })
      return new Response(null, { status: 204 })
    },
  })

  const result = await client.session.instructions.entry.list({ sessionID: "ses_test" })
  await client.session.instructions.entry.put({
    sessionID: "ses_test",
    key: "review-notes",
    value: instructions[0].value,
  })
  await client.session.instructions.entry.remove({ sessionID: "ses_test", key: "review-notes" })

  expect(result).toEqual(instructions)
  expect(requests).toEqual([
    {
      method: "GET",
      url: "http://localhost:3000/api/session/ses_test/instructions/entries",
      body: undefined,
    },
    {
      method: "PUT",
      url: "http://localhost:3000/api/session/ses_test/instructions/entries/review-notes",
      body: { value: { text: "Check the diff", priority: 1 } },
    },
    {
      method: "DELETE",
      url: "http://localhost:3000/api/session/ses_test/instructions/entries/review-notes",
      body: undefined,
    },
  ])
})

test("session.inbox.list uses the public HTTP contract", async () => {
  const requests: Array<{ method: string; url: string }> = []
  const pending = [
    {
      id: "msg_pending",
      sessionID: "ses_test",
      timeCreated: 1_717_171_717_000,
      type: "user",
      payload: { text: "Fix the failing tests" },
      delivery: "steer",
    },
  ]
  const client = OpenCode.make({
    baseUrl: "http://localhost:3000",
    fetch: async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init)
      requests.push({ method: request.method, url: request.url })
      return Response.json({ data: pending })
    },
  })

  const result = await client.session.inbox.list({ sessionID: "ses_test" })

  expect(result).toEqual(pending)
  expect(requests).toEqual([{ method: "GET", url: "http://localhost:3000/api/session/ses_test/inbox" }])
})

test("session.inbox mutations use the public HTTP contract", async () => {
  const requests: Array<{ method: string; url: string }> = []
  const client = OpenCode.make({
    baseUrl: "http://localhost:3000",
    fetch: async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init)
      requests.push({ method: request.method, url: request.url })
      return new Response(null, { status: 204 })
    },
  })

  await client.session.inbox.cancel({ sessionID: "ses_test", inboxID: "msg_cancel" })
  await client.session.inbox.steer({ sessionID: "ses_test", inboxID: "msg_steer" })
  await client.session.inbox.queue({ sessionID: "ses_test", inboxID: "msg_queue" })

  expect(requests).toEqual([
    { method: "DELETE", url: "http://localhost:3000/api/session/ses_test/inbox/msg_cancel" },
    { method: "POST", url: "http://localhost:3000/api/session/ses_test/inbox/msg_steer/steer" },
    { method: "POST", url: "http://localhost:3000/api/session/ses_test/inbox/msg_queue/queue" },
  ])
})

test("event.subscribe exposes the Promise event stream wire projection", async () => {
  const client = OpenCode.make({
    baseUrl: "http://localhost:3000",
    fetch: async () =>
      new Response(
        `: heartbeat\n\ndata: ${JSON.stringify({ id: "evt_connected", created: 0, type: "server.connected", data: {} })}\n\n` +
          `data: ${JSON.stringify(modelSwitchedEvent)}\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      ),
  })
  const events = []
  for await (const event of client.event.subscribe()) events.push(event)

  expect(events).toEqual([{ id: "evt_connected", created: 0, type: "server.connected", data: {} }, modelSwitchedEvent])
  expect(events[1]?.type === "session.model.selected" && events[1].created).toBe(1_717_171_717_000)
})

// Moved from packages/app/e2e/regression/session-timeline-transport.spec.ts
test("event.subscribe keeps one request open while delivering multiple events", async () => {
  const requests: Request[] = []
  const events = [
    { id: "evt_first", created: 1, type: "server.connected", data: {} },
    { id: "evt_second", created: 2, type: "server.connected", data: {} },
  ]
  const client = OpenCode.make({
    baseUrl: "http://localhost:3000",
    fetch: async (input, init) => {
      requests.push(input instanceof Request ? input : new Request(input, init))
      return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
        headers: { "content-type": "text/event-stream" },
      })
    },
  })
  const received = []
  for await (const event of client.event.subscribe()) received.push(event)
  expect(received).toEqual(events)
  expect(requests).toHaveLength(1)
})

// Moved from packages/app/e2e/regression/session-timeline-transport.spec.ts
test("event.subscribe delivers every event from one stream chunk", async () => {
  const events = Array.from({ length: 4 }, (_, index) => ({
    id: `evt_burst_${index}`,
    created: index,
    type: "server.connected",
    data: {},
  }))
  const client = OpenCode.make({
    baseUrl: "http://localhost:3000",
    fetch: async () =>
      new Response(new TextEncoder().encode(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")), {
        headers: { "content-type": "text/event-stream" },
      }),
  })
  const received = []
  for await (const event of client.event.subscribe()) received.push(event)
  expect(received).toEqual(events)
  expect(new Set(received.map((event) => event.id)).size).toBe(4)
})

// Moved from packages/app/e2e/regression/session-timeline-transport.spec.ts
test("event.subscribe parses split JSON and a split multibyte code point", async () => {
  const event = {
    id: "evt_split",
    created: 1,
    type: "server.connected",
    data: { text: "split snowman \u2603\u2603\u2603" },
  }
  const encoded = new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`)
  const multibyte = encoded.indexOf(new TextEncoder().encode("\u2603")[0]!)
  const boundaries = [9, multibyte + 1, multibyte + 2, encoded.length]
  const client = OpenCode.make({
    baseUrl: "http://localhost:3000",
    fetch: async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            boundaries.forEach((end, index) =>
              controller.enqueue(encoded.slice(index ? boundaries[index - 1] : 0, end)),
            )
            controller.close()
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
  })
  await expect(client.event.subscribe()[Symbol.asyncIterator]().next()).resolves.toEqual({ done: false, value: event })
})

// Moved from packages/app/e2e/regression/session-timeline-transport.spec.ts
test("event.subscribe ignores server heartbeat comments", async () => {
  const event = { id: "evt_sentinel", created: 1, type: "server.connected", data: {} }
  const client = OpenCode.make({
    baseUrl: "http://localhost:3000",
    fetch: async () =>
      new Response(`: heartbeat\n\ndata: ${JSON.stringify(event)}\n\n: heartbeat\n\n`, {
        headers: { "content-type": "text/event-stream" },
      }),
  })
  const received = []
  for await (const item of client.event.subscribe()) received.push(item)
  expect(received).toEqual([event])
})

test("event.subscribe reports heartbeat comments as stream activity", async () => {
  const event = { id: "evt_sentinel", created: 1, type: "server.connected", data: {} }
  const encoder = new TextEncoder()
  const client = OpenCode.make({
    baseUrl: "http://localhost:3000",
    fetch: async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode(": heartbeat\n\n"))
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
            controller.enqueue(encoder.encode(": heartbeat\n\n"))
            controller.close()
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
  })
  let activity = 0
  const received = []
  for await (const item of client.event.subscribe({ onActivity: () => activity++ })) received.push(item)
  expect(received).toEqual([event])
  expect(activity).toBe(3)
})

// Moved from packages/app/e2e/regression/session-timeline-transport.spec.ts
test("event transport passes through ordinary health requests", async () => {
  const requests: string[] = []
  const event = { id: "evt_connected", created: 1, type: "server.connected", data: {} }
  const client = OpenCode.make({
    baseUrl: "http://localhost:3000",
    fetch: async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init)
      requests.push(new URL(request.url).pathname)
      if (new URL(request.url).pathname === "/api/event") {
        return new Response(`data: ${JSON.stringify(event)}\n\n`, {
          headers: { "content-type": "text/event-stream" },
        })
      }
      return Response.json({ healthy: true, version: "2.0.0", pid: 1 })
    },
  })
  await expect(client.event.subscribe()[Symbol.asyncIterator]().next()).resolves.toEqual({ done: false, value: event })
  await expect(client.health.get()).resolves.toEqual({ healthy: true, version: "2.0.0", pid: 1 })
  expect(requests).toEqual(["/api/event", "/api/health"])
})

test("event.subscribe terminates on malformed Promise SSE data", async () => {
  const client = OpenCode.make({
    baseUrl: "http://localhost:3000",
    fetch: async () => new Response("data: {not-json}\n\n", { headers: { "content-type": "text/event-stream" } }),
  })

  await expect(client.event.subscribe()[Symbol.asyncIterator]().next()).rejects.toMatchObject({
    name: "ClientError",
    reason: "MalformedResponse",
  })
})

test("native event signals cancel only their listener and close transport after the last listener", async () => {
  const opened = Promise.withResolvers<Request>()
  const client = OpenCode.make({
    baseUrl: "http://localhost:3000",
    headers: { authorization: "Bearer events" },
    fetch: async (input, init) => {
      const request = new Request(input, init)
      opened.resolve(request)
      return new Response(
        new ReadableStream({
          start(controller) {
            request.signal.addEventListener("abort", () => controller.error(request.signal.reason), { once: true })
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      )
    },
  })
  const first = new AbortController()
  const second = new AbortController()
  const one = client.event.subscribe({ signal: first.signal })[Symbol.asyncIterator]().next()
  const two = client.event.subscribe({ signal: second.signal })[Symbol.asyncIterator]().next()
  const request = await opened.promise
  expect(request.headers.get("authorization")).toBe("Bearer events")
  first.abort()
  expect((await one).done).toBe(true)
  expect(request.signal.aborted).toBe(false)
  second.abort()
  expect((await two).done).toBe(true)
  expect(request.signal.aborted).toBe(true)
})

test("native pre-aborted event signals do not open a transport", async () => {
  let requests = 0
  const client = OpenCode.make({
    baseUrl: "http://localhost:3000",
    fetch: async () => {
      requests++
      return new Response(null)
    },
  })
  expect((await client.event.subscribe({ signal: AbortSignal.abort() })[Symbol.asyncIterator]().next()).done).toBe(true)
  expect(requests).toBe(0)
})

test("event.subscribe accepts a fragmented SSE event below the size limit", async () => {
  const event = { id: "evt_large", type: "test.large", data: { output: "x".repeat(12 * 1024 * 1024) } }
  const encoded = new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`)
  const client = OpenCode.make({
    baseUrl: "http://localhost:3000",
    fetch: async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            for (let offset = 0; offset < encoded.length; offset += 64 * 1024) {
              controller.enqueue(encoded.slice(offset, offset + 64 * 1024))
            }
            controller.close()
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
  })

  await expect(client.event.subscribe()[Symbol.asyncIterator]().next()).resolves.toEqual({ done: false, value: event })
})

test("event.subscribe rejects an SSE event above the size limit", async () => {
  const client = OpenCode.make({
    baseUrl: "http://localhost:3000",
    fetch: async () =>
      new Response(`data: ${JSON.stringify({ output: "x".repeat(16 * 1024 * 1024) })}`, {
        headers: { "content-type": "text/event-stream" },
      }),
  })

  await expect(client.event.subscribe()[Symbol.asyncIterator]().next()).rejects.toMatchObject({
    name: "ClientError",
    reason: "SseEventTooLarge",
  })
})

test("session methods use the public HTTP contract", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = []
  const client = OpenCode.make({
    baseUrl: "http://localhost:3000",
    fetch: async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      requests.push({ url, init })
      if (url.includes("/event")) {
        return new Response(`data: ${JSON.stringify(modelSwitchedEvent)}\n\n`, {
          headers: { "content-type": "text/event-stream" },
        })
      }
      if (url.includes("/log")) {
        return new Response(`data: ${JSON.stringify(modelSwitchedEvent)}\n\ndata: ${JSON.stringify(synced)}\n\n`, {
          headers: { "content-type": "text/event-stream" },
        })
      }
      if (url.includes("/prompt")) return Response.json(admission)
      if (url.includes("/generate")) return Response.json({ data: { text: "A transient answer" } })
      if (url.includes("/synthetic")) return Response.json(syntheticAdmission)
      if (url.endsWith("/compact")) return Response.json(compactionAdmission)
      if (url.includes("/context")) return Response.json({ data: [] })
      if (url.includes("/message/")) return Response.json({ data: modelSwitchedMessage })
      if (url.endsWith("/api/session/active")) return Response.json({ data: { ses_test: { type: "running" } } })
      if (init?.method === "POST" && url.endsWith("/api/session")) return Response.json(session)
      if (url.includes("/interrupt")) return Response.json({ interrupted: true })
      if (init?.method === "POST") return new Response(null, { status: 204 })
      return Response.json({ data: [session.data], cursor: { next: "next" } })
    },
  })

  const page = await client.session.list({ limit: 10, order: "desc", parentID: null })
  const active = await client.session.active()
  const created = await client.session.create({ location: { directory: "/tmp/project" } })
  await client.session.view({ sessionID: "ses_test", idle: session.data.time.idle })
  await client.session.switchAgent({ sessionID: "ses_test", agent: "build" })
  await client.session.switchModel({
    sessionID: "ses_test",
    model: { id: "claude", providerID: "anthropic" },
  })
  const admitted = await client.session.prompt({
    sessionID: "ses_test",
    text: "Hello",
    resume: false,
  })
  const generated = await client.session.generate({ sessionID: "ses_test", prompt: "Summarize this session" })
  const synthetic = await client.session.synthetic({
    sessionID: "ses_test",
    text: "Completed",
    delivery: "queue",
    resume: false,
  })
  await client.session.compact({ sessionID: "ses_test" })
  await client.session.wait({ sessionID: "ses_test" })
  const context = await client.session.context({ sessionID: "ses_test" })
  const log = []
  for await (const item of client.session.log({ sessionID: "ses_test", after: 0 })) log.push(item)
  const interrupted = await client.session.interrupt({ sessionID: "ses_test", continue: true })
  const message = await client.session.message({ sessionID: "ses_test", messageID: "msg_model" })

  expect(page.cursor.next).toBe("next")
  expect(page.data[0].time).toMatchObject({ idle: 1_717_171_717_002, viewed: 1_717_171_717_001 })
  expect(active).toEqual({ ses_test: { type: "running" } })
  expect(created.id).toBe("ses_test")
  expect(admitted.id).toBe("msg_test")
  expect(generated.text).toBe("A transient answer")
  expect(interrupted).toEqual({ interrupted: true })
  expect(synthetic).toMatchObject({ type: "synthetic", data: { text: "Completed" }, delivery: "queue" })
  expect(context).toEqual([])
  expect(log).toEqual([modelSwitchedEvent, synced])
  expect(message).toEqual(modelSwitchedMessage)
  expect(requests.map((request) => [request.init?.method, request.url])).toEqual([
    ["GET", "http://localhost:3000/api/session?limit=10&order=desc&parentID=null"],
    ["GET", "http://localhost:3000/api/session/active"],
    ["POST", "http://localhost:3000/api/session"],
    ["POST", "http://localhost:3000/api/session/ses_test/view"],
    ["POST", "http://localhost:3000/api/session/ses_test/agent"],
    ["POST", "http://localhost:3000/api/session/ses_test/model"],
    ["POST", "http://localhost:3000/api/session/ses_test/prompt"],
    ["POST", "http://localhost:3000/api/session/ses_test/generate"],
    ["POST", "http://localhost:3000/api/session/ses_test/synthetic"],
    ["POST", "http://localhost:3000/api/session/ses_test/compact"],
    ["POST", "http://localhost:3000/api/session/ses_test/wait"],
    ["GET", "http://localhost:3000/api/session/ses_test/context"],
    ["GET", "http://localhost:3000/api/experimental/session/ses_test/log?after=0"],
    ["POST", "http://localhost:3000/api/session/ses_test/interrupt?continue=true"],
    ["GET", "http://localhost:3000/api/session/ses_test/message/msg_model"],
  ])
  const viewBody = requests.find((request) => request.url.endsWith("/api/session/ses_test/view"))?.init?.body
  if (typeof viewBody !== "string") throw new Error("Expected JSON view request body")
  expect(JSON.parse(viewBody)).toEqual({ idle: session.data.time.idle })
  const body = requests.find((request) => request.url.endsWith("/api/session/ses_test/prompt"))?.init?.body
  if (typeof body !== "string") throw new Error("Expected JSON request body")
  expect(JSON.parse(body)).toEqual({
    text: "Hello",
    resume: false,
  })
  const syntheticBody = requests.find((request) => request.url.endsWith("/synthetic"))?.init?.body
  if (typeof syntheticBody !== "string") throw new Error("Expected JSON synthetic request body")
  expect(JSON.parse(syntheticBody)).toEqual({
    text: "Completed",
    delivery: "queue",
    resume: false,
  })
})

test("middleware errors remain declared client errors", async () => {
  const client = OpenCode.make({
    baseUrl: "http://localhost:3000",
    fetch: async () =>
      Response.json({ _tag: "UnauthorizedError", message: "Authentication required" }, { status: 401 }),
  })

  try {
    await client.session.create({})
    throw new Error("Expected request to fail")
  } catch (error) {
    expect(isUnauthorizedError(error)).toBe(true)
  }
})

test("session.log decodes SessionNotFoundError", async () => {
  const client = OpenCode.make({
    baseUrl: "http://localhost:3000",
    fetch: async () =>
      Response.json(
        { _tag: "SessionNotFoundError", sessionID: "ses_missing", message: "Session not found" },
        { status: 404 },
      ),
  })

  try {
    await client.session.log({ sessionID: "ses_missing" })[Symbol.asyncIterator]().next()
    throw new Error("Expected request to fail")
  } catch (error) {
    expect(isSessionNotFoundError(error)).toBe(true)
  }
})

const session = {
  data: {
    id: "ses_test",
    projectID: "project",
    cost: 0,
    tokens: {
      input: 1,
      output: 2,
      reasoning: 3,
      cache: { read: 4, write: 5 },
    },
    time: {
      created: 1_717_171_717_000,
      updated: 1_717_171_717_000,
      idle: 1_717_171_717_002,
      viewed: 1_717_171_717_001,
    },
    title: "Test",
    location: { directory: "/tmp/project" },
  },
}

const admission = {
  data: {
    id: "msg_test",
    sessionID: "ses_test",
    type: "user",
    data: { text: "Hello" },
    delivery: "steer",
    timeCreated: 1_717_171_717_000,
  },
}

const syntheticAdmission = {
  data: {
    id: "msg_synthetic",
    sessionID: "ses_test",
    type: "synthetic",
    data: { text: "Completed" },
    delivery: "queue",
    timeCreated: 1_717_171_717_000,
  },
}

const compactionAdmission = {
  data: {
    type: "compaction",
    id: "msg_compaction",
    sessionID: "ses_test",
    timeCreated: 1_717_171_717_000,
  },
}

const modelSwitchedMessage = {
  id: "msg_model",
  type: "model-switched",
  time: { created: 1_717_171_717_000 },
  model: { id: "claude", providerID: "anthropic" },
}

const synced = { type: "log.synced", aggregateID: "ses_test", seq: 1 }

const modelSwitchedEvent = {
  id: "evt_model",
  created: 1_717_171_717_000,
  type: "session.model.selected",
  durable: { aggregateID: "ses_test", seq: 1, version: 1 },
  data: {
    sessionID: "ses_test",
    model: { id: "claude", providerID: "anthropic" },
  },
}
