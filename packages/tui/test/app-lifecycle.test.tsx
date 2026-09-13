import { expect, test } from "bun:test"
import { EmbeddedTerminalRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { Effect, FileSystem } from "effect"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Global } from "@opencode/util/global"
import path from "node:path"
import { createEventStream, createFetch, directory, json } from "./fixture/tui-client"
import { tmpdir } from "./fixture/fixture"
import { createAppFixture } from "./fixture/app"
import type { PluginInfo } from "@opencode/client"

test.each([100, 44])("Ctrl-O is immediate, dismissible, and prunes cached deletions at width %s", async (width) => {
  await using state = await tmpdir()
  const requested = Promise.withResolvers<void>()
  const response = Promise.withResolvers<Response>()
  const projects = Promise.withResolvers<Response>()
  const refresh = Promise.withResolvers<Response>()
  const cachedSession = {
    id: "ses_cached",
    title: "Cached session",
    projectID: "proj_fixture",
    location: { directory: "/fixture" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 2 },
  }
  let requests = 0
  await using setup = await createAppFixture({
    width,
    state: state.path,
    fetch: (url) => {
      if (url.pathname === "/api/session") {
        requests++
        requested.resolve()
        if (requests === 1) return response.promise
        if (requests === 2 || requests === 4) return refresh.promise.then((response) => response.clone())
        if (requests > 4) return new Response("Unavailable", { status: 503 })
        return json({ data: [cachedSession], cursor: {} })
      }
      if (url.pathname === "/api/project") return projects.promise
      return undefined
    },
  })
  try {
    await setup.ready
    await setup.waitForFrame((frame) => frame.includes("commands"))
    setup.mockInput.pressKey("o", { ctrl: true })
    await requested.promise
    await setup.renderOnce()
    expect(setup.captureCharFrame()).toContain("Search sessions")
    expect(setup.captureCharFrame()).toContain("Refreshing")
    projects.resolve(
      json([
        {
          id: "proj_fixture",
          canonical: "/fixture",
          name: "Fixture project",
          time: { created: 1, updated: 2 },
          sandboxes: [],
        },
      ]),
    )
    await setup.waitForFrame((frame) => frame.includes("Fixture project"))
    setup.mockInput.pressKey("o", { ctrl: true })
    expect(requests).toBe(1)
    setup.mockInput.pressEscape()
    await setup.waitForFrame((frame) => !frame.includes("Fixture project"))
    response.resolve(json({ data: [{ ...cachedSession, id: "ses_disposed", title: "Disposed response" }], cursor: {} }))
    await setup.renderOnce()
    expect(setup.captureCharFrame()).not.toContain("Fixture project")
    setup.mockInput.pressKey("o", { ctrl: true })
    await setup.waitForFrame((frame) => frame.includes("Refreshing"))
    expect(setup.captureCharFrame()).not.toContain("Disposed")
    setup.mockInput.pressEscape()
    await setup.waitForFrame((frame) => !frame.includes("Fixture project"))
    setup.mockInput.pressKey("o", { ctrl: true })
    await setup.waitForFrame((frame) => frame.includes("Cached"))
    setup.mockInput.pressEscape()
    await setup.waitForFrame((frame) => !frame.includes("Fixture project"))
    setup.mockInput.pressKey("o", { ctrl: true })
    await setup.waitForFrame((frame) => frame.includes("Cached") && frame.includes("Refreshing"))
    setup.events.emit({
      id: "evt_deleted",
      created: 1,
      type: "session.deleted",
      durable: { aggregateID: "ses_cached", seq: 1, version: 2 },
      data: { sessionID: "ses_cached" },
    })
    await setup.waitForFrame((frame) => !frame.includes("Cached"))
    refresh.resolve(json({ data: [cachedSession], cursor: {} }))
    await setup.waitForFrame((frame) => frame.includes("Fixture project") && !frame.includes("Refreshing"))
    expect(setup.captureCharFrame()).not.toContain("Cached")
    setup.mockInput.pressEscape()
    await setup.waitForFrame((frame) => !frame.includes("Fixture project"))
    setup.mockInput.pressKey("o", { ctrl: true })
    await setup.waitForFrame((frame) => frame.includes("Could not refresh sessions"))
    expect(setup.captureCharFrame()).not.toContain("Cached")
  } finally {
    response.resolve(json({ data: [], cursor: {} }))
    projects.resolve(json([]))
    refresh.resolve(json({ data: [], cursor: {} }))
  }
})

test.each(["dismissed", "refreshing"])(
  "Ctrl-O retains committed movement of a cached-only session while %s",
  async (phase) => {
    await using state = await tmpdir()
    const refresh = Promise.withResolvers<Response>()
    const metadata = Promise.withResolvers<Response>()
    const destinationRequested = Promise.withResolvers<void>()
    const cached = {
      id: "ses_cached_move",
      title: "Cached movement",
      projectID: "proj_old",
      location: { directory: "/fixture/old" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 1, updated: 2 },
    }
    let requests = 0
    const locations: string[] = []
    await using setup = await createAppFixture({
      state: state.path,
      config: { animations: false, tabs: { enabled: false } },
      fetch: (url) => {
        if (url.pathname === "/api/session") {
          if (url.searchParams.has("parentID")) {
            const parent = url.searchParams.get("parentID")
            if (parent && parent !== "null") return json({ data: [], cursor: {} })
          }
          return requests++ === 0
            ? json({ data: [cached], cursor: {} })
            : refresh.promise.then((response) => response.clone())
        }
        if (url.pathname === `/api/session/${cached.id}`) return metadata.promise
        if (url.pathname === `/api/session/${cached.id}/message`) return json({ data: [], cursor: {} })
        if (
          url.pathname === `/api/session/${cached.id}/inbox` ||
          url.pathname === `/api/session/${cached.id}/permission`
        )
          return json({ data: [] })
        if (url.pathname === "/api/project")
          return json(
            ["old", "new"].map((name) => ({
              id: `proj_${name}`,
              canonical: `/fixture/${name}`,
              name: name === "old" ? "Old" : "New",
              time: { created: 1, updated: 2 },
              sandboxes: [],
            })),
          )
        if (url.pathname === "/api/location") {
          const query = url.searchParams.get("location[directory]") ?? ""
          locations.push(query)
          if (query.includes("/fixture/new")) {
            destinationRequested.resolve()
            return json({
              directory: "/fixture/new",
              project: { id: "proj_new", directory: "/fixture/new", canonical: "/fixture/new" },
            })
          }
        }
        return undefined
      },
    })
    try {
      await setup.ready
      await setup.waitForFrame((frame) => frame.includes("commands"))
      setup.mockInput.pressKey("o", { ctrl: true })
      await setup.waitForFrame((frame) => frame.includes(cached.title) && !frame.includes("Refreshing"))
      setup.mockInput.pressEscape()
      await setup.waitForFrame((frame) => !frame.includes("Search sessions"))
      if (phase === "refreshing") {
        setup.mockInput.pressKey("o", { ctrl: true })
        await setup.waitForFrame((frame) => frame.includes(cached.title) && frame.includes("Refreshing"))
      }
      setup.events.emit({
        id: "evt_cached_moved",
        created: 3,
        type: "session.moved",
        durable: { aggregateID: cached.id, seq: 1, version: 1 },
        data: { sessionID: cached.id, location: { directory: "/fixture/new" }, projectID: "proj_new" },
      })
      if (phase === "dismissed") {
        setup.mockInput.pressKey("o", { ctrl: true })
        refresh.resolve(new Response("Unavailable", { status: 503 }))
        await setup.waitForFrame((frame) => frame.includes("Could not refresh sessions"))
      }
      if (phase === "refreshing") {
        await setup.waitForFrame((frame) =>
          frame.split("\n").some((line) => line.includes(cached.title) && line.includes("New")),
        )
        refresh.resolve(json({ data: [cached], cursor: {} }))
        await setup.waitForFrame((frame) => frame.includes(cached.title) && !frame.includes("Refreshing"))
      }
      await setup.waitForFrame((frame) =>
        frame.split("\n").some((line) => line.includes(cached.title) && line.includes("New")),
      )
      expect(
        setup
          .captureCharFrame()
          .split("\n")
          .find((line) => line.includes(cached.title)),
      ).toContain("New")
      locations.length = 0
      setup.mockInput.pressEnter()
      await destinationRequested.promise
      expect(locations.some((query) => query.includes("/fixture/old"))).toBe(false)
    } finally {
      refresh.resolve(json({ data: [], cursor: {} }))
      metadata.resolve(json({ data: { ...cached, projectID: "proj_new", location: { directory: "/fixture/new" } } }))
    }
  },
)

test("SIGHUP clears title and disposes scoped resources once", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24, useThread: false })
  const titles: string[] = []
  let started!: () => void
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })
  const setTitle = setup.renderer.setTerminalTitle.bind(setup.renderer)
  setup.renderer.setTerminalTitle = (title) => {
    titles.push(title)
    if (title === "OpenCode") started()
    setTitle(title)
  }
  const listeners = new Set(process.listeners("SIGHUP"))
  const events = createEventStream()
  const calls = createFetch(undefined, events)
  const server = Bun.serve({ port: 0, fetch: (request) => calls.fetch(request) })
  try {
    const { run } = await import("../src/app")
    const task = Effect.runPromise(
      run({
        app: { name: "test", version: "test", channel: "test" },
        server: { endpoint: { url: server.url.toString() } },
        config: { get: async () => ({}), update: async () => ({}) },
        packages: { prepare: async () => ({ directory: "" }) },
        terminalHandoff: async () => ({ renderer: setup.renderer, mode: "dark", complete: () => {} }),
        args: {},
        log: () => {},
      }).pipe(Effect.provide(AppNodeBuilder.build(Global.node)), Effect.provide(FileSystem.layerNoop({}))),
    )
    await ready
    process.emit("SIGHUP")
    await task

    expect(setup.renderer.isDestroyed).toBe(true)
    expect(titles.at(-1)).toBe("")
    expect(process.listeners("SIGHUP").every((listener) => listeners.has(listener))).toBe(true)
  } finally {
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    await server.stop()
  }
})

test("session lifecycle updates the terminal title and prints the epilogue after cleanup", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24, useThread: false })
  let initialTitle!: () => void
  const initialTitleSet = new Promise<void>((resolve) => {
    initialTitle = resolve
  })
  let renamedTitle!: () => void
  const renamedTitleSet = new Promise<void>((resolve) => {
    renamedTitle = resolve
  })
  const setTitle = setup.renderer.setTerminalTitle.bind(setup.renderer)
  setup.renderer.setTerminalTitle = (title) => {
    if (title === "OC | Demo session") initialTitle()
    if (title === "OC | Renamed session") renamedTitle()
    setTitle(title)
  }
  const events = createEventStream()
  let promptRequests = 0
  const calls = createFetch((url) => {
    const session = {
      id: "dummy",
      title: "Demo session",
      projectID: "project",
      location: { directory },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 0, updated: 0 },
    }
    if (url.pathname === "/api/session")
      return json({
        data: [session],
        cursor: {},
      })
    if (url.pathname === "/api/session/dummy") return json({ data: session })
    if (url.pathname === "/api/session/dummy/message") return json({ data: [], cursor: {} })
    if (url.pathname === "/api/session/dummy/inbox") return json({ data: [] })
    if (url.pathname === "/api/session/dummy/permission") return json({ data: [] })
    if (url.pathname === "/api/session/dummy/prompt") {
      promptRequests++
      return json({ data: {} })
    }
  }, events)
  const server = Bun.serve({ port: 0, fetch: (request) => calls.fetch(request) })
  const originalWrite = process.stdout.write.bind(process.stdout)
  let stdout = ""
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += String(chunk)
    return true
  }) as typeof process.stdout.write

  try {
    const { run } = await import("../src/app")
    const task = Effect.runPromise(
      run({
        app: { name: "test", version: "test", channel: "test" },
        server: { endpoint: { url: server.url.toString() } },
        config: { get: async () => ({}), update: async () => ({}) },
        packages: { prepare: async () => ({ directory: "" }) },
        terminalHandoff: async () => ({ renderer: setup.renderer, mode: "dark", complete: () => {} }),
        args: { sessionID: "dummy" },
        log: () => {},
      }).pipe(Effect.provide(AppNodeBuilder.build(Global.node)), Effect.provide(FileSystem.layerNoop({}))),
    )

    await initialTitleSet
    events.emit({
      id: "evt_renamed",
      created: 1,
      type: "session.renamed",
      durable: { aggregateID: "dummy", seq: 1, version: 1 },
      data: { sessionID: "dummy", title: "Renamed session" },
    })
    await renamedTitleSet
    setup.renderer.destroy()
    await task

    expect(stdout).toContain("Renamed session")
    expect(stdout).toContain("opencode -s dummy")
    expect(promptRequests).toBe(0)
  } finally {
    process.stdout.write = originalWrite
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    await server.stop()
  }
})

test("session title generated while an untitled session is loading remains visible", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24, useThread: false })
  const titles: string[] = []
  const setTitle = setup.renderer.setTerminalTitle.bind(setup.renderer)
  const generatedTitle = Promise.withResolvers<void>()
  setup.renderer.setTerminalTitle = (title) => {
    titles.push(title)
    if (title === "OC | Generated title") generatedTitle.resolve()
    setTitle(title)
  }
  const sessionRequested = Promise.withResolvers<void>()
  const renameSyncRequested = Promise.withResolvers<void>()
  const releaseSession = Promise.withResolvers<void>()
  let sessionRequests = 0
  const session = {
    id: "dummy",
    projectID: "project",
    location: { directory },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 0, updated: 0 },
  }
  const events = createEventStream()
  const calls = createFetch(async (url) => {
    if (url.pathname === "/api/session") return json({ data: [], cursor: {} })
    if (url.pathname === "/api/session/dummy") {
      sessionRequests++
      sessionRequested.resolve()
      if (sessionRequests === 2) renameSyncRequested.resolve()
      await releaseSession.promise
      return json({ data: session })
    }
    if (url.pathname === "/api/session/dummy/message") return json({ data: [], cursor: {} })
    if (url.pathname === "/api/session/dummy/inbox") return json({ data: [] })
    if (url.pathname === "/api/session/dummy/permission") return json({ data: [] })
  }, events)
  const server = Bun.serve({ port: 0, fetch: (request) => calls.fetch(request) })

  try {
    const { run } = await import("../src/app")
    const task = Effect.runPromise(
      run({
        app: { name: "test", version: "test", channel: "test" },
        server: { endpoint: { url: server.url.toString() } },
        config: { get: async () => ({}), update: async () => ({}) },
        packages: { prepare: async () => ({ directory: "" }) },
        terminalHandoff: async () => ({ renderer: setup.renderer, mode: "dark", complete: () => {} }),
        args: { sessionID: "dummy" },
        log: () => {},
      }).pipe(Effect.provide(AppNodeBuilder.build(Global.node)), Effect.provide(FileSystem.layerNoop({}))),
    )

    await sessionRequested.promise
    events.emit({
      id: "evt_renamed",
      created: 1,
      type: "session.renamed",
      durable: { aggregateID: "dummy", seq: 1, version: 1 },
      data: { sessionID: "dummy", title: "Generated title" },
    })
    await Promise.race([
      renameSyncRequested.promise,
      Bun.sleep(2_000).then(() => {
        throw new Error("rename sync did not start")
      }),
    ])
    releaseSession.resolve()
    await Promise.race([
      generatedTitle.promise,
      Bun.sleep(2_000).then(() => {
        throw new Error("generated title was not shown")
      }),
    ])
    await Bun.sleep(20)

    const generated = titles.lastIndexOf("OC | Generated title")
    expect(generated).toBeGreaterThan(-1)
    expect(titles.slice(generated + 1)).not.toContain("OpenCode")
    setup.renderer.destroy()
    await task
  } finally {
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    await server.stop()
  }
})

test("vertical session tabs collapse to a compact rail with the terminal", async () => {
  await using state = await tmpdir()
  await Bun.write(path.join(state.path, "test", "tui", "layout.json"), JSON.stringify({ verticalTabsWidth: 42 }))
  const session = {
    id: "ses_resize",
    title: "Resize fixture",
    projectID: "project",
    location: { directory },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 2 },
  }
  await using setup = await createAppFixture({
    width: 100,
    state: state.path,
    config: {
      animations: false,
      tabs: { enabled: true, layout: "vertical", indicators: "status" },
      session: { sidebar: "hide" },
    },
    args: { sessionID: session.id },
    fetch: (url) => {
      if (url.pathname === `/api/session/${session.id}`) return json({ data: session })
      if (/^\/api\/session\/ses_resize\/(message|inbox|permission)$/.test(url.pathname))
        return json({ data: [], cursor: {} })
      return undefined
    },
  })
  await setup.ready
  await setup.waitForFrame((frame) => frame.split("\n")[1].slice(0, 42).includes(session.title))

  setup.resize(54, 30)
  await setup.waitForFrame((frame) => frame.split("\n")[1].slice(0, 10).trim() === "⌕")
  setup.resize(48, 30)
  await setup.waitForFrame((frame) => frame.split("\n")[0].includes(session.title))
  expect(setup.captureCharFrame()).not.toContain("⌕")
  setup.resize(100, 30)
  await setup.waitForFrame((frame) => frame.split("\n")[1].slice(0, 42).includes(session.title))
})

test("automatic rename refreshes the displayed title before settling, even without a renamed event", async () => {
  await using state = await tmpdir()
  const response = Promise.withResolvers<Response>()
  const bodies: unknown[] = []
  const location = { directory, project: { id: "project", directory, canonical: directory } }
  const session = {
    id: "ses_rename",
    title: "Compiler cleanup",
    projectID: "project",
    location: { directory },
    agent: "build",
    model: { providerID: "provider", id: "model" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 0, updated: 0 },
  }
  await using setup = await createAppFixture({
    width: 90,
    height: 20,
    state: state.path,
    config: { tabs: { enabled: true, layout: "vertical" }, session: { sidebar: "hide" } },
    args: { sessionID: session.id },
    fetch: async (url, request) => {
      if (url.pathname === "/api/location") return json(location)
      if (url.pathname === "/api/agent")
        return json({ location, data: [{ id: "build", mode: "primary", hidden: false, permissions: [] }] })
      if (url.pathname === "/api/model")
        return json({ location, data: [{ id: "model", providerID: "provider", name: "Model", variants: [] }] })
      if (url.pathname === "/api/provider") return json({ location, data: [{ id: "provider", name: "Provider" }] })
      if (url.pathname === "/api/session") return json({ data: [], cursor: {} })
      if (url.pathname === "/api/session/ses_rename") return json({ data: session })
      if (/^\/api\/session\/ses_rename\/(message|inbox|permission)$/.test(url.pathname))
        return json({ data: [], cursor: {} })
      if (url.pathname === "/api/session/ses_rename/rename") {
        bodies.push(await request.json())
        return response.promise
      }
      return undefined
    },
  })

  try {
    await setup.waitForFrame((frame) => frame.includes(session.title) && frame.includes("Build · Model Provider"))
    await setup.mockInput.typeText("/rename")
    setup.mockInput.pressEscape()
    setup.mockInput.pressEnter()
    await setup.waitFor(() => bodies.length === 1)
    await setup.renderOnce()
    expect(bodies[0]).toEqual({ title: "" })
    expect(setup.captureCharFrame()).toContain("Compiler cleanup")

    session.title = "Simplify compiler parsing"
    response.resolve(new Response(null, { status: 204 }))
    await setup.waitForFrame((frame) => frame.includes(session.title), { maxPasses: 60 })
    expect(setup.captureCharFrame()).not.toContain("Compiler cleanup")
  } finally {
    response.resolve(new Response(null, { status: 204 }))
  }
})

test.each([80, 120])("completes custom Markdown and ordinary fences in a session at width %s", async (width) => {
  await using state = await tmpdir()
  const session = {
    id: "ses_markdown",
    title: "Markdown fixture",
    projectID: "project",
    location: { directory },
    agent: "build",
    model: { providerID: "fixture", id: "model" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 2 },
  }
  const initial =
    "```mermaid\ngraph LR\n  A[DiagramStart] --> B[DiagramEnd]\n```\n\n```latex\nx^2\n```\n\n```text\ninitial"
  await using setup = await createAppFixture({
    width,
    height: 55,
    state: state.path,
    config: { animations: false, tabs: { enabled: false }, session: { sidebar: "hide" } },
    args: { sessionID: session.id },
    fetch: (url) => {
      if (url.pathname === `/api/session/${session.id}`) return json({ data: session })
      if (url.pathname === `/api/session/${session.id}/message`)
        return json({
          data: [
            {
              id: "msg_markdown",
              type: "assistant",
              agent: session.agent,
              model: session.model,
              time: { created: 2 },
              content: [{ type: "text", text: initial }],
            },
            {
              id: "msg_compaction",
              type: "compaction",
              time: { created: 1 },
              status: "completed",
              reason: "manual",
              summary: "```latex\ny^2\n```",
              recent: "msg_markdown",
            },
          ],
          cursor: {},
        })
      if (
        url.pathname === `/api/session/${session.id}/inbox` ||
        url.pathname === `/api/session/${session.id}/permission`
      )
        return json({ data: [] })
      return undefined
    },
  })
  const streaming = await setup.waitForFrame(
    (frame) =>
      frame.includes("initial") &&
      frame.includes("DiagramStart") &&
      frame.includes("DiagramEnd") &&
      frame.includes("x\u00b2") &&
      frame.includes("y\u00b2"),
  )
  expect(streaming).toContain("Compaction")
  expect(streaming).not.toContain("initial final")
  expect(streaming).not.toContain("MARKDOWN_END")

  // Queue final text and completion together to exercise TextPart's reactive property order.
  setup.events.emit({
    id: "evt_markdown_text_ended",
    created: 3,
    type: "session.text.ended",
    durable: { aggregateID: session.id, seq: 1, version: 1 },
    data: {
      sessionID: session.id,
      assistantMessageID: "msg_markdown",
      ordinal: 0,
      text: `${initial} final\n\`\`\`\n\nMARKDOWN_END`,
    },
  })
  setup.events.emit({
    id: "evt_markdown_step_ended",
    created: 4,
    type: "session.step.ended",
    durable: { aggregateID: session.id, seq: 2, version: 1 },
    data: {
      sessionID: session.id,
      assistantMessageID: "msg_markdown",
      finish: "stop",
      cost: 0,
      tokens: session.tokens,
    },
  })
  const frame = await setup.waitForFrame(
    (frame) => frame.includes("MARKDOWN_END") && frame.includes("initial final") && frame.includes("2ms"),
  )
  expect(frame).toContain("DiagramStart")
  expect(frame).toContain("DiagramEnd")
  expect(frame).toContain("x\u00b2")
  expect(frame).toContain("y\u00b2")
  expect(frame).toContain("initial final")
  expect(frame).not.toContain("graph LR")
  expect(frame).not.toContain("x^2")
  expect(frame).not.toContain("y^2")
  expect(frame).not.toContain("```")
})

test("keeps assistant footer metrics current after prepend, same-length refresh, and revert", async () => {
  await using state = await tmpdir()
  const session = {
    id: "ses_footer",
    title: "Footer fixture",
    projectID: "project",
    location: { directory },
    agent: "build",
    model: { providerID: "fixture", id: "model" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 100, updated: 5000 },
  }
  let refresh = false
  await using setup = await createAppFixture({
    width: 100,
    height: 40,
    state: state.path,
    config: { animations: false, tabs: { enabled: false }, session: { sidebar: "hide", tps: true } },
    args: { sessionID: session.id },
    fetch: (url) => {
      if (url.pathname === `/api/session/${session.id}`) return json({ data: session })
      if (url.pathname === `/api/session/${session.id}/message`) {
        if (url.searchParams.get("cursor") === "older")
          return json({
            data: [
              {
                id: "msg_0001",
                type: "system",
                text: "Earlier instructions",
                description: "Prepended instructions",
                time: { created: 200 },
              },
              { id: "msg_0000", type: "user", text: "Prepended input", time: { created: 100 } },
            ],
            cursor: {},
          })
        return json({
          data: [
            ...(refresh
              ? [
                  {
                    id: "msg_0005",
                    type: "assistant",
                    agent: session.agent,
                    model: session.model,
                    time: { created: 7000, streamed: 8000, completed: 9000, requestDurationMs: 1000 },
                    finish: "stop",
                    cost: 0,
                    tokens: { ...session.tokens, output: 50 },
                    content: [{ type: "text", text: "Later answer" }],
                  },
                  { id: "msg_0004", type: "user", text: "Later input", time: { created: 6000 } },
                ]
              : []),
            {
              id: "msg_0003",
              type: "assistant",
              agent: session.agent,
              model: session.model,
              time: { created: 2000, streamed: 3000, completed: 5000, requestDurationMs: 1000 },
              finish: "stop",
              cost: 0,
              tokens: { ...session.tokens, output: 20 },
              content: [{ type: "text", text: "Original answer" }],
            },
            { id: "msg_0002", type: "user", text: "Current input", time: { created: 1000 } },
          ],
          cursor: { next: "older" },
        })
      }
      if (
        url.pathname === `/api/session/${session.id}/inbox` ||
        url.pathname === `/api/session/${session.id}/permission`
      )
        return json({ data: [] })
      return undefined
    },
  })

  const initial = await setup.waitForFrame((frame) => frame.includes("Original answer") && frame.includes("20.0 tok/s"))
  expect(initial).toContain("Current input")
  expect(initial).toContain("4.0s \u00b7 20.0 tok/s")
  expect(initial).not.toContain("Prepended input")

  setup.mockInput.pressKey("g", { ctrl: true })
  const prepended = await setup.waitForFrame(
    (frame) =>
      frame.includes("Prepended input") &&
      frame.includes("Prepended instructions") &&
      frame.includes("Original answer") &&
      frame.includes("20.0 tok/s") &&
      !frame.includes("Loading session history…"),
  )
  expect(prepended).toContain("Current input")
  expect(prepended).toContain("Original answer")
  expect(prepended).toContain("4.0s \u00b7 20.0 tok/s")

  // Refresh the latest page: length stays four, but the retained assistant moves from index three to one.
  refresh = true
  setup.events.disconnect()
  const refreshed = await setup.waitForFrame(
    (frame) =>
      frame.includes("Later input") &&
      frame.includes("Later answer") &&
      !frame.includes("Prepended input") &&
      !frame.includes("Prepended instructions"),
    { maxPasses: 120 },
  )
  expect(refreshed).toContain("Current input")
  expect(refreshed).toContain("Original answer")
  expect(refreshed).toContain("4.0s \u00b7 20.0 tok/s")
  expect(refreshed).toContain("3.0s \u00b7 50.0 tok/s")

  setup.events.emit({
    id: "evt_footer_reverted",
    created: 10000,
    type: "session.revert.committed",
    durable: { aggregateID: session.id, seq: 1, version: 1 },
    data: { sessionID: session.id, to: "msg_0004" },
  })
  const reverted = await setup.waitForFrame(
    (frame) => frame.includes("Original answer") && !frame.includes("Later input") && !frame.includes("Later answer"),
  )
  expect(reverted).toContain("Current input")
  expect(reverted).toContain("4.0s \u00b7 20.0 tok/s")
  expect(reverted).not.toContain("50.0 tok/s")
})

test("session startup prompt is submitted exactly once", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24, useThread: false })
  const events = createEventStream()
  const cwd = process.cwd()
  const location = { directory: cwd, project: { id: "project", directory: cwd } }
  const session = {
    id: "dummy",
    title: "Demo session",
    projectID: "project",
    location: { directory: cwd },
    agent: "build",
    model: { providerID: "provider", id: "model" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 0, updated: 0 },
  }
  const bodies: unknown[] = []
  const promptSubmitted = Promise.withResolvers<void>()
  const calls = createFetch(async (url, request) => {
    if (url.pathname === "/api/location") return json(location)
    if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
    if (url.pathname === "/api/session/dummy") return json({ data: session })
    if (url.pathname === "/api/session/dummy/message") return json({ data: [], cursor: {} })
    if (url.pathname === "/api/session/dummy/inbox") return json({ data: [] })
    if (url.pathname === "/api/session/dummy/permission") return json({ data: [] })
    if (url.pathname === "/api/agent")
      return json({
        location,
        data: [{ id: "build", mode: "primary", hidden: false, permissions: [] }],
      })
    if (url.pathname === "/api/model")
      return json({
        location,
        data: [{ id: "model", providerID: "provider", name: "Model", variants: [] }],
      })
    if (url.pathname === "/api/session/dummy/prompt") {
      bodies.push(await request.json())
      promptSubmitted.resolve()
      return json({ data: {} })
    }
  }, events)
  const server = Bun.serve({ port: 0, fetch: (request) => calls.fetch(request) })

  try {
    const { run } = await import("../src/app")
    const task = Effect.runPromise(
      run({
        app: { name: "test", version: "test", channel: "test" },
        server: { endpoint: { url: server.url.toString() } },
        config: { get: async () => ({}), update: async () => ({}) },
        packages: { prepare: async () => ({ directory: "" }) },
        terminalHandoff: async () => ({ renderer: setup.renderer, mode: "dark", complete: () => {} }),
        args: { sessionID: "dummy", prompt: "RESUME_READY" },
        log: () => {},
      }).pipe(Effect.provide(AppNodeBuilder.build(Global.node)), Effect.provide(FileSystem.layerNoop({}))),
    )

    await Promise.race([
      promptSubmitted.promise,
      Bun.sleep(2000).then(() => {
        throw new Error("startup prompt was not submitted")
      }),
    ])
    await Bun.sleep(20)
    setup.renderer.destroy()
    await task

    expect(bodies).toHaveLength(1)
    expect(bodies[0]).toMatchObject({ text: "RESUME_READY" })
  } finally {
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    await server.stop()
  }
})

test.each([false, true])("uses the resolved launch directory for new prompts (fallback: %s)", async (fallback) => {
  await using state = await tmpdir()
  const target = fallback ? directory : process.cwd()
  const location = { directory: target, project: { id: "project", directory: target, canonical: target } }
  const requests: URL[] = []
  const created = Promise.withResolvers<unknown>()
  const submitted = Promise.withResolvers<unknown>()
  let session: unknown
  await using setup = await createAppFixture({
    state: state.path,
    config: { animations: false, tabs: { enabled: false }, keybinds: { "session.new": "f6" } },
    fetch: async (url, request) => {
      requests.push(url)
      if (url.searchParams.has("location[directory]") && url.searchParams.get("location[directory]") !== target)
        return json({ message: "Directory does not exist on the server" }, { status: 500 })
      if (url.pathname === "/api/fs/list") return json({ location, data: [] })
      if (url.pathname === "/api/location") return json(location)
      if (url.pathname === "/api/agent")
        return json({ location, data: [{ id: "build", mode: "primary", hidden: false, permissions: [] }] })
      if (url.pathname === "/api/model")
        return json({ location, data: [{ id: "model", providerID: "provider", name: "Remote Model", variants: [] }] })
      if (url.pathname === "/api/provider") return json({ location, data: [{ id: "provider", name: "Provider" }] })
      if (url.pathname === "/api/session" && request.method === "POST") {
        const input: unknown = await request.json()
        if (typeof input !== "object" || input === null) throw new Error("Expected a session input")
        created.resolve(input)
        session = {
          ...input,
          projectID: "project",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 0, updated: 0 },
        }
        return json({ data: session })
      }
      if (/^\/api\/session\/[^/]+\/prompt$/.test(url.pathname)) {
        submitted.resolve(await request.json())
        return json({ data: {} })
      }
      if (/^\/api\/session\/[^/]+\/(message|inbox|permission)$/.test(url.pathname))
        return json({ data: [], cursor: {} })
      if (session && /^\/api\/session\/[^/]+$/.test(url.pathname)) return json({ data: session })
      return undefined
    },
  })

  await setup.ready
  await setup.waitForFrame((frame) => frame.includes("Build · Remote Model Provider"))
  setup.mockInput.pressKey("F6")
  await setup.renderOnce()
  await setup.mockInput.typeText("REMOTE_READY")
  await setup.waitForFrame((frame) => frame.includes("REMOTE_READY"))
  setup.mockInput.pressEnter()
  expect(
    await Promise.race([
      submitted.promise,
      Bun.sleep(2_000).then(() => {
        throw new Error("prompt was not submitted in the resolved server directory")
      }),
    ]),
  ).toMatchObject({ text: "REMOTE_READY" })
  expect(await created.promise).toMatchObject({ location: { directory: target } })
  expect(requests[0]?.pathname).toBe("/api/fs/list")
  expect(requests[0]?.searchParams.get("location[directory]")).toBe(process.cwd())
  expect(
    requests.filter((url) => url.pathname === "/api/location" && !url.searchParams.has("location[directory]")),
  ).toHaveLength(fallback ? 1 : 0)
  expect(
    requests
      .slice(1)
      .filter((url) => url.searchParams.has("location[directory]"))
      .every((url) => url.searchParams.get("location[directory]") === target),
  ).toBe(true)
})

test("error investigations repeatedly seed editable home drafts without creating sessions", async () => {
  const cwd = process.cwd()
  const location = { directory: cwd, project: { id: "project", directory: cwd } }
  let created = 0
  await using setup = await createAppFixture({
    config: { animations: false, keybinds: { "mcp.list": "f6" } },
    fetch: (url, request) => {
      if (url.pathname === "/api/location") return json(location)
      if (url.pathname === "/api/mcp")
        return json({
          location,
          data: [
            { name: "alpha", status: { status: "failed", error: "Alpha connection refused" } },
            { name: "beta", status: { status: "failed", error: "Beta initialization failed" } },
          ],
        })
      if (url.pathname === "/api/session" && request.method === "POST") created++
      return undefined
    },
  })
  await setup.waitForFrame((frame) => frame.includes("commands"))

  setup.mockInput.pressKey("F6")
  await setup.waitForFrame((frame) => frame.includes("MCP servers") && frame.includes("alpha"))
  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => frame.includes("Alpha connection refused") && frame.includes("i investigate"))
  setup.mockInput.pressKey("i")
  await setup.waitForFrame((frame) => frame.includes("Alpha connection refused") && !frame.includes("i investigate"))

  setup.mockInput.pressKey("F6")
  await setup.waitForFrame((frame) => frame.includes("MCP servers"))
  setup.mockInput.pressArrow("down")
  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => frame.includes("Beta initialization failed") && frame.includes("i investigate"))
  setup.mockInput.pressKey("i")
  const draft = await setup.waitForFrame(
    (frame) => frame.includes("Beta initialization failed") && !frame.includes("i investigate"),
  )

  expect(draft).not.toContain("Alpha connection refused")
  expect(created).toBe(0)

  setup.mockInput.pressKey("c", { ctrl: true })
  await setup.waitForFrame((frame) => !frame.includes("Beta initialization failed"))
})

test("completed user shell output replaces a partial live read when the final read fails", async () => {
  await using state = await tmpdir()
  const session = {
    id: "ses_shell_output",
    title: "Shell output fixture",
    projectID: "proj_test",
    location: { directory },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 0, updated: 0 },
  }
  const shell = {
    id: "sh_output",
    command: "echo shell-output-fixture",
    status: "running" as const,
    cwd: directory,
    shell: "/bin/sh",
    file: `${directory}/shell.out`,
    metadata: { sessionID: session.id, background: true },
    time: { started: 1 },
  }
  const partial = "first live output\n"
  const completed = `${partial}last persisted output\n`
  let finished = false
  let failedReads = 0
  await using setup = await createAppFixture({
    state: state.path,
    config: { animations: false, tabs: { enabled: false }, session: { sidebar: "hide" } },
    args: { sessionID: session.id },
    fetch: (url) => {
      if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
      if (url.pathname === `/api/session/${session.id}`) return json({ data: session })
      if (url.pathname === `/api/session/${session.id}/message`)
        return json({
          data: [
            {
              id: "msg_shell_output",
              type: "shell",
              shellID: shell.id,
              command: shell.command,
              status: "running",
              metadata: { background: true },
              time: { created: 1 },
            },
          ],
          cursor: {},
        })
      if (
        url.pathname === `/api/session/${session.id}/inbox` ||
        url.pathname === `/api/session/${session.id}/permission`
      )
        return json({ data: [] })
      if (url.pathname === "/api/shell") return json({ location: { directory }, data: finished ? [] : [shell] })
      if (url.pathname === `/api/shell/${shell.id}/output`) {
        if (finished) {
          failedReads++
          return json({ message: "Shell output unavailable" }, { status: 404 })
        }
        return json({
          location: { directory },
          data: {
            output: partial.slice(Number(url.searchParams.get("cursor") ?? 0)),
            cursor: partial.length,
            size: partial.length,
            truncated: false,
          },
        })
      }
      return undefined
    },
  })

  const running = await setup.waitForFrame((frame) => frame.includes(partial.trim()))
  expect(running).toContain(shell.command)
  expect(running).not.toContain("Background")

  finished = true
  setup.events.emit({
    id: "evt_shell_exited",
    created: 2,
    type: "shell.exited",
    location: { directory },
    data: { id: shell.id, status: "exited", exit: 0 },
  })
  await setup.waitFor(() => failedReads > 0)
  setup.events.emit({
    id: "evt_shell_ended",
    created: 3,
    type: "session.shell.ended",
    durable: { aggregateID: session.id, seq: 1, version: 1 },
    data: {
      sessionID: session.id,
      shell: { ...shell, status: "exited", exit: 0, time: { started: 1, completed: 2 } },
      output: { output: completed, cursor: completed.length, size: completed.length, truncated: false },
    },
  })
  const terminal = await setup.waitForFrame((frame) => frame.includes("last persisted output"))
  expect(terminal).toContain(partial.trim())
  expect(terminal).toContain(`$ ${shell.command}`)
  expect(terminal).not.toContain("Background")
})

test("new session inherits the active session model", async () => {
  const cwd = process.cwd()
  const location = { directory: cwd, project: { id: "project", directory: cwd } }
  const session = {
    id: "dummy",
    title: "Demo session",
    projectID: "project",
    location: { directory: cwd },
    agent: "build",
    model: { providerID: "provider", id: "session-model" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 0, updated: 0 },
  }
  await using setup = await createAppFixture({
    width: 80,
    height: 24,
    args: { sessionID: "dummy" },
    fetch: (url) => {
      if (url.pathname === "/api/fs/list") return json({ location, data: [] })
      if (url.pathname === "/api/location") return json(location)
      if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
      if (url.pathname === "/api/session/dummy") return json({ data: session })
      if (url.pathname === "/api/session/dummy/message") return json({ data: [], cursor: {} })
      if (url.pathname === "/api/session/dummy/inbox") return json({ data: [] })
      if (url.pathname === "/api/session/dummy/permission") return json({ data: [] })
      if (url.pathname === "/api/agent")
        return json({ location, data: [{ id: "build", mode: "primary", hidden: false, permissions: [] }] })
      if (url.pathname === "/api/provider") return json({ location, data: [{ id: "provider", name: "Provider" }] })
      if (url.pathname === "/api/model")
        return json({
          location,
          data: [
            { id: "home-model", providerID: "provider", name: "Home Model", variants: [] },
            { id: "session-model", providerID: "provider", name: "Session Model", variants: [] },
          ],
        })
    },
  })

  await setup.waitForFrame((frame) => frame.includes("Session Model"))
  await setup.mockInput.typeText("/new")
  setup.mockInput.pressEnter()
  await Bun.sleep(50)
  await setup.renderOnce()
  const frame = setup.captureCharFrame()
  expect(frame).toContain("Session Model")
})

test("keeps the prompt display stable while a new location catalog loads", async () => {
  const source = process.cwd()
  const target = path.join(path.parse(source).root, "opencode-target")
  const locationCatalog = Promise.withResolvers<void>()
  const catalog = Promise.withResolvers<void>()
  const providerCatalog = Promise.withResolvers<void>()
  const locationRequested = Promise.withResolvers<void>()
  const modelRequested = Promise.withResolvers<void>()
  await using setup = await createAppFixture({
    fetch: async (url) => {
      const requestedDirectory = url.searchParams.get("location[directory]") ?? source
      const location = {
        directory: requestedDirectory,
        project: {
          id: requestedDirectory === target ? "target" : "source",
          directory: requestedDirectory,
          canonical: requestedDirectory,
        },
      }
      if (url.pathname === "/api/location") {
        if (requestedDirectory === target) {
          locationRequested.resolve()
          await locationCatalog.promise
        }
        return json(location)
      }
      if (url.pathname === "/api/agent") {
        if (requestedDirectory === target) await catalog.promise
        return json({
          location,
          data: [{ id: "build", mode: "primary", hidden: false, permissions: [] }],
        })
      }
      if (url.pathname === "/api/provider") {
        if (requestedDirectory === target) await providerCatalog.promise
        return json({ location, data: [{ id: "provider", name: "Provider" }] })
      }
      if (url.pathname === "/api/model") {
        if (requestedDirectory === target) {
          modelRequested.resolve()
          await catalog.promise
        }
        return json({
          location,
          data: [
            {
              id: requestedDirectory === target ? "target-model" : "source-model",
              providerID: "provider",
              name: requestedDirectory === target ? "Target Model" : "Source Model",
              variants: [],
            },
          ],
        })
      }
      return undefined
    },
  })

  try {
    await setup.ready
    await setup.waitForFrame((frame) => frame.includes("Build · Source Model Provider"))
    const agentSpan = () =>
      setup
        .captureSpans()
        .lines.flatMap((line) => line.spans)
        .find((span) => span.text.trim() === "Build")
    const sourceAgentColor = agentSpan()?.fg.toInts()
    expect(sourceAgentColor).toBeDefined()
    await setup.mockInput.typeText(`/cd ${target}`)
    await setup.renderOnce()
    expect(setup.captureCharFrame()).toContain(`/cd ${target}`)
    setup.mockInput.pressEscape()
    setup.mockInput.pressEnter()
    await Promise.race([
      locationRequested.promise,
      Bun.sleep(2_000).then(() => {
        throw new Error("target location was not requested")
      }),
    ])
    await setup.renderOnce()
    expect(setup.captureCharFrame()).toContain(target)

    locationCatalog.resolve()
    await Promise.race([
      modelRequested.promise,
      Bun.sleep(2_000).then(() => {
        throw new Error("target model catalog was not requested")
      }),
    ])
    await setup.renderOnce()

    expect(setup.captureCharFrame()).toContain("Build · Source Model Provider")
    expect(agentSpan()?.fg.toInts()).toEqual(sourceAgentColor)

    catalog.resolve()
    const resolved = await setup.waitForFrame((frame) => frame.includes("Build · Target Model provider"))
    expect(resolved).not.toContain("Source Model")

    providerCatalog.resolve()
    await setup.waitForFrame((frame) => frame.includes("Build · Target Model Provider"))
  } finally {
    locationCatalog.resolve()
    catalog.resolve()
    providerCatalog.resolve()
  }
})

test("configured app binding opens settings", async () => {
  await using setup = await createAppFixture({
    config: { animations: false, keybinds: { "opencode.settings": "f6" } },
  })
  await setup.ready
  await setup.waitForFrame((frame) => frame.includes("commands"))

  setup.mockInput.pressKey("F6")
  const settings = await setup.waitForFrame((frame) => frame.includes("Settings"))
  expect(settings).toContain("Color mode")
  expect(settings).toContain("Animations")
})

test("ctrl+c dismisses autocomplete and shell mode before exiting", async () => {
  await using setup = await createAppFixture()
  await setup.ready
  await setup.waitForFrame((frame) => frame.includes("commands"))
  await setup.mockInput.typeText("/theme")
  await setup.waitForFrame((frame) => frame.includes("Switch theme"))

  setup.mockInput.pressKey("c", { ctrl: true })
  await setup.waitForFrame((frame) => !frame.includes("Switch theme"))
  expect(setup.renderer.isDestroyed).toBe(false)

  await setup.mockInput.typeText("!")
  await setup.waitForFrame((frame) => frame.includes("Shell"))
  setup.mockInput.pressKey("c", { ctrl: true })
  await setup.waitForFrame((frame) => !frame.includes("Shell"))
  expect(setup.renderer.isDestroyed).toBe(false)
})

test.each(["manual", "select"] as const)(
  "selection copy and pane management respect %s mode in the prompt and terminal pane",
  async (copy) => {
    const setup = await createTestRenderer({ width: 100, height: 30, useThread: false, kittyKeyboard: true })
    setup.renderer.start()
    const ready = Promise.withResolvers<void>()
    const session = {
      id: "dummy",
      title: "Selection fixture",
      projectID: "project",
      location: { directory },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 0, updated: 0 },
    }
    const pty = {
      id: "pty_fixture",
      sessionID: session.id,
      title: "Terminal",
      command: "/bin/sh",
      args: [],
      cwd: directory,
      status: "running",
      pid: 1,
      foregroundProcess: null,
      size: { cols: 48, rows: 24 },
      output: { head: 0, tail: 0 },
    }
    const input: string[] = []
    const calls = createFetch((url, request) => {
      if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
      if (url.pathname === "/api/session/dummy") return json({ data: session })
      if (url.pathname === "/api/session/dummy/message") return json({ data: [], cursor: {} })
      if (url.pathname === "/api/session/dummy/inbox") return json({ data: [] })
      if (url.pathname === "/api/session/dummy/permission") return json({ data: [] })
      if (url.pathname === "/api/experimental/session/dummy/terminal")
        return json({ data: request.method === "POST" ? pty : [pty] })
      if (url.pathname === "/api/experimental/persistent-pty/pty_fixture/snapshot")
        return json({
          data: {
            info: pty,
            text: "alpha beta gamma",
            checkpoint: Buffer.from("alpha beta gamma").toString("base64"),
            cursor: { x: 16, y: 0 },
          },
        })
      if (url.pathname === "/api/experimental/persistent-pty/pty_fixture/connect-token")
        return json({ data: { ticket: "fixture" } })
      return undefined
    }, createEventStream())
    const server = Bun.serve({
      port: 0,
      fetch(request, server) {
        if (new URL(request.url).pathname.endsWith("/connect") && server.upgrade(request)) return undefined
        return calls.fetch(request)
      },
      websocket: {
        open(socket) {
          socket.send(JSON.stringify({ type: "attached", inputProtocol: 1, role: "controller", info: pty }))
          socket.send(JSON.stringify({ type: "replay_complete" }))
        },
        message(_socket, message) {
          const data = Buffer.from(message)
          if (data[0] === 1) input.push(data.subarray(5).toString())
        },
      },
    })

    try {
      const { run } = await import("../src/app")
      const task = Effect.runPromise(
        run({
          app: { name: "test", version: "test", channel: "test" },
          server: { endpoint: { url: server.url.toString() } },
          config: {
            get: async () => ({
              animations: false,
              terminal: { copy },
              session: { terminal: true },
            }),
            update: async () => ({}),
          },
          packages: { prepare: async () => ({ directory: "" }) },
          args: { sessionID: session.id },
          terminalHandoff: async () => ({ renderer: setup.renderer, mode: "dark", complete: ready.resolve }),
          log: () => {},
        }).pipe(Effect.provide(AppNodeBuilder.build(Global.node)), Effect.provide(FileSystem.layerNoop({}))),
      )

      await ready.promise
      await setup.waitForFrame((frame) => frame.includes("commands"))
      await setup.mockInput.typeText("selection audit draft")
      setup.mockInput.pressKey("a", { ctrl: true, shift: true })
      expect(setup.renderer.getSelection()?.getSelectedText()).toBe("selection audit draft")

      setup.mockInput.pressEscape()
      expect(setup.renderer.hasSelection).toBeFalse()
      expect(setup.renderer.currentFocusedEditor?.plainText).toBe("selection audit draft")

      setup.mockInput.pressKey("c", { ctrl: true })
      await setup.waitForFrame((frame) => !frame.includes("selection audit draft"))
      expect(setup.renderer.currentFocusedEditor?.plainText).toBe("")
      expect(setup.renderer.hasSelection).toBeFalse()
      expect(setup.renderer.isDestroyed).toBeFalse()

      await setup.mockInput.typeText("/terminal")
      await setup.waitForFrame((frame) => frame.includes("New terminal"))
      setup.mockInput.pressEnter()
      await setup.waitForFrame((frame) => frame.includes("alpha beta gamma"))
      setup.mockInput.pressKey("x", { ctrl: true })
      setup.mockInput.pressArrow("right")
      const terminal = setup.renderer.currentFocusedRenderable
      if (!(terminal instanceof EmbeddedTerminalRenderable)) throw new Error("Terminal was not focused")
      setup.renderer.startSelection(terminal, terminal.x + 6, terminal.y)
      setup.renderer.updateSelection(terminal, terminal.x + 9, terminal.y, { finishDragging: true })
      expect(setup.renderer.getSelection()?.getSelectedText()).toBe("beta")

      setup.mockInput.pressEscape()
      expect(setup.renderer.hasSelection).toBeFalse()
      expect(terminal.hasSelection()).toBeFalse()

      await setup.mockMouse.click(terminal.x + 6, terminal.y)
      if (copy === "select") {
        setup.renderer.updateSelection(terminal, terminal.x + 9, terminal.y, { finishDragging: true })
        expect(setup.renderer.getSelection()?.getSelectedText()).toBe("beta")
      }
      setup.mockInput.pressKey("c", { ctrl: true })
      await setup.waitFor(() => input.length > 0)
      expect(input).toEqual(["\x03"])
      expect(setup.renderer.hasSelection).toBeFalse()
      expect(setup.renderer.isDestroyed).toBeFalse()

      setup.mockInput.pressKey("x", { ctrl: true })
      setup.mockInput.pressArrow("up")
      await setup.waitFor(() => terminal.isDestroyed)
      expect(setup.renderer.currentFocusedEditor?.plainText).toBe("")
      setup.mockInput.pressKey("x", { ctrl: true })
      setup.mockInput.pressKey("t")
      await setup.waitForFrame((frame) => frame.includes("alpha beta gamma"))
      expect(setup.renderer.currentFocusedRenderable).toBeInstanceOf(EmbeddedTerminalRenderable)
      setup.mockInput.pressKey("x", { ctrl: true })
      setup.mockInput.pressArrow("down")
      await setup.waitForFrame((frame) => frame.includes("Subagents") && frame.includes("Terminals"))
      expect(setup.renderer.currentFocusedRenderable).not.toBeInstanceOf(EmbeddedTerminalRenderable)

      setup.renderer.destroy()
      await task
    } finally {
      if (!setup.renderer.isDestroyed) setup.renderer.destroy()
      await server.stop()
    }
  },
)

test.each([100, 44])(
  "execution failure keeps the empty session composer and draft usable at width %s",
  async (width) => {
    await using state = await tmpdir()
    const session = {
      id: "ses_failure",
      projectID: "proj_test",
      location: { directory },
      title: "Failure fixture",
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 1, updated: 1 },
    }
    await using setup = await createAppFixture({
      width,
      state: state.path,
      args: { sessionID: session.id },
      config: { animations: false, tabs: { enabled: false } },
      fetch: (url) => {
        if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
        if (url.pathname === `/api/session/${session.id}`) return json({ data: session })
        if (url.pathname === `/api/session/${session.id}/message`) return json({ data: [], cursor: {} })
        if ([`/api/session/${session.id}/inbox`, `/api/session/${session.id}/permission`].includes(url.pathname))
          return json({ data: [] })
        return undefined
      },
    })
    await setup.ready
    await setup.waitForFrame((frame) => frame.includes("commands"))
    setup.mockInput.pressKey("u", { ctrl: true })
    await setup.mockInput.typeText("Keep this draft")
    await setup.waitForFrame((frame) => frame.includes("Keep this draft"))
    setup.events.emit({
      id: "evt_execution_failed",
      created: 2,
      type: "session.execution.failed",
      durable: { aggregateID: session.id, seq: 1, version: 1 },
      data: {
        sessionID: session.id,
        error: { type: "unknown", message: 'Plugin "broken-skills" failed during skill.transform.' },
      },
    })
    await setup.waitForFrame((frame) => frame.includes("Session failed"))
    expect(setup.captureCharFrame()).toContain("broken-skills")
    expect(setup.captureCharFrame()).toContain("skill.transform")
    expect(setup.captureCharFrame()).toContain("Keep this draft")
    expect(setup.captureCharFrame()).not.toContain("Select directory")
    await setup.mockInput.typeText(" intact")
    await setup.waitForFrame((frame) => frame.includes("Keep this draft intact"))
  },
)

test.each([
  [100, true],
  [44, true],
  [100, false],
  [44, false],
] as const)("server plugin failures are visible at width %s (already failed: %s)", async (width, initial) => {
  await using state = await tmpdir()
  const failure: PluginInfo["state"] = {
    status: "failed",
    error: "Plugin disabled after command.transform failed. Check server logs for details.",
    ref: "err_fixture",
  }
  let inventory: PluginInfo[] = [
    {
      id: "broken",
      source: { type: "builtin" },
      features: { server: true },
      state: initial ? failure : { status: "active" },
    },
    { id: "healthy", source: { type: "builtin" }, features: { server: true }, state: { status: "active" } },
  ]
  let requests = 0
  await using setup = await createAppFixture({
    width,
    state: state.path,
    fetch: (url) => {
      if (url.pathname !== "/api/plugin") return undefined
      requests++
      return json({
        location: { directory, project: { id: "proj_test", directory, canonical: directory } },
        data: inventory,
      })
    },
  })
  await setup.ready
  await setup.waitForFrame((frame) => frame.includes("commands"))
  if (!initial) {
    expect(setup.captureCharFrame()).not.toContain("Plugin failed")
    inventory = inventory.map((plugin) => (plugin.id === "broken" ? { ...plugin, state: failure } : plugin))
    setup.events.emit({ id: "evt_failure", created: 1, type: "plugin.updated", data: {} })
  }
  await setup.waitForFrame((frame) => frame.includes("Plugin failed:") && frame.includes("broken"))
  expect(setup.captureCharFrame()).toContain("/plugins")
  expect(setup.captureCharFrame()).toContain("1 plugin failed")

  const lines = setup.captureCharFrame().split("\n")
  const row = lines.findIndex((line) => line.includes("Open plugins"))
  expect(row).toBeGreaterThanOrEqual(0)
  const line = lines[row]
  if (!line) throw new Error("Open plugins action is missing")
  await setup.mockMouse.click(line.indexOf("Open plugins"), row)
  await setup.waitForFrame((frame) => frame.includes("ctrl+a") && frame.includes("broken"))
  expect(setup.captureCharFrame()).toContain("broken")
  expect(setup.captureCharFrame()).not.toContain("healthy")
  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => frame.includes("Server plugin error") && frame.includes("transform failed"))
  expect(setup.captureCharFrame()).toContain("Plugin disabled")
  expect(setup.captureCharFrame()).toContain("transform failed")
  expect(setup.captureCharFrame()).toContain("err_fixture")
  setup.mockInput.pressEscape()
  await setup.waitForFrame((frame) => frame.includes("ctrl+a"))
  setup.mockInput.pressEscape()
  await setup.waitForFrame((frame) => !frame.includes("ctrl+a"))
  expect(setup.captureCharFrame()).toContain("1 plugin failed")

  const seen = requests
  setup.events.emit({ id: "evt_repeat", created: 2, type: "plugin.updated", data: {} })
  setup.events.emit({ id: "evt_reconnect", type: "server.connected", data: {} })
  await setup.waitFor(() => requests >= seen + 2)
  await setup.flush()
  expect(setup.captureCharFrame()).not.toContain("Plugin failed:")

  inventory = inventory.map((plugin) => ({ ...plugin, state: { status: "active" } }))
  setup.events.emit({ id: "evt_recovered", created: 3, type: "plugin.updated", data: {} })
  await setup.waitForFrame((frame) => !frame.includes("1 plugin failed"))
  inventory = inventory.map((plugin) => (plugin.id === "broken" ? { ...plugin, state: failure } : plugin))
  setup.events.emit({ id: "evt_failed_again", created: 4, type: "plugin.updated", data: {} })
  await setup.waitForFrame((frame) => frame.includes("Plugin failed:") && frame.includes("broken"))
})

test("server plugin failures share one notice and use source names before an ID is known", async () => {
  await using state = await tmpdir()
  await using setup = await createAppFixture({
    state: state.path,
    fetch: (url) =>
      url.pathname === "/api/plugin"
        ? json({
            location: { directory, project: { id: "proj_test", directory, canonical: directory } },
            data: [
              {
                source: { type: "package", target: "missing-package" },
                features: {},
                state: { status: "failed", error: "Package missing" },
              },
              {
                source: { type: "local", path: "/fixture/broken.ts" },
                features: {},
                state: { status: "failed", error: "Invalid plugin" },
              },
            ],
          })
        : undefined,
  })
  await setup.ready
  await setup.waitForFrame((frame) => frame.includes("2 plugins failed"))
  expect(setup.captureCharFrame()).toContain("missing-package")
  expect(setup.captureCharFrame()).toContain("/fixture/broken.ts")
  expect(setup.captureCharFrame()).toContain("Open plugins")
})

test.each([44, 100])(
  "retry countdown updates and clears with the retry lifecycle at width %s",
  async (width) => {
    await using state = await tmpdir()
    const session = {
      id: "ses_countdown",
      projectID: "proj_test",
      location: { directory },
      title: "Retry countdown",
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 1, updated: 1 },
    }
    const model = { id: "model", providerID: "provider" }
    const error = { type: "provider.transport" as const, message: "Provider unavailable" }
    await using setup = await createAppFixture({
      width,
      state: state.path,
      args: { sessionID: session.id },
      config: { animations: false, tabs: { enabled: false } },
      fetch: (url) => {
        if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
        if (url.pathname === `/api/session/${session.id}`) return json({ data: session })
        if (url.pathname === `/api/session/${session.id}/message`)
          return json({
            data: [
              {
                id: "msg_countdown",
                type: "assistant",
                agent: "build",
                model,
                content: [],
                error,
                retry: { attempt: 2, at: Date.now() + 2_500, error },
                time: { created: 1 },
              },
            ],
            cursor: {},
          })
        if ([`/api/session/${session.id}/inbox`, `/api/session/${session.id}/permission`].includes(url.pathname))
          return json({ data: [] })
        return undefined
      },
    })
    await setup.ready
    await setup.waitForFrame((frame) => frame.includes("Retrying in 3s"))
    expect(setup.captureCharFrame()).toContain("attempt 2")
    expect(setup.captureCharFrame()).toContain("Provider unavailable")
    expect(setup.captureCharFrame()).not.toContain("Error:")
    await setup.waitForFrame((frame) => frame.includes("Retrying in 2s"), { maxPasses: 200 })
    await setup.waitForFrame((frame) => frame.includes("Retrying in 1s"), { maxPasses: 200 })
    await setup.waitForFrame((frame) => frame.includes("Retry due"), { maxPasses: 200 })
    expect(setup.captureCharFrame()).not.toContain("in 0s")

    setup.events.emit({
      id: "evt_countdown_rescheduled",
      created: 2,
      type: "session.retry.scheduled",
      durable: { aggregateID: session.id, seq: 1, version: 1 },
      data: { sessionID: session.id, assistantMessageID: "msg_countdown", attempt: 3, at: Date.now() + 10_500, error },
    })
    await setup.waitForFrame((frame) => frame.includes("Retrying in 11s") && frame.includes("attempt 3"))
    setup.events.emit({
      id: "evt_countdown_started",
      created: 3,
      type: "session.step.started",
      durable: { aggregateID: session.id, seq: 2, version: 1 },
      data: { sessionID: session.id, assistantMessageID: "msg_countdown", agent: "build", model },
    })
    await setup.waitForFrame((frame) => !frame.includes("Retrying") && !frame.includes("Retry due"))

    setup.events.emit({
      id: "evt_countdown_expired",
      created: 4,
      type: "session.retry.scheduled",
      durable: { aggregateID: session.id, seq: 3, version: 1 },
      data: { sessionID: session.id, assistantMessageID: "msg_countdown", attempt: 4, at: Date.now() - 1_000, error },
    })
    await setup.waitForFrame((frame) => frame.includes("Retry due") && frame.includes("attempt 4"))
    expect(setup.captureCharFrame()).not.toContain("in -")
    setup.events.emit({
      id: "evt_countdown_interrupted",
      created: 5,
      type: "session.execution.interrupted",
      durable: { aggregateID: session.id, seq: 4, version: 1 },
      data: { sessionID: session.id, reason: "shutdown" },
    })
    await setup.waitForFrame((frame) => !frame.includes("Retrying") && !frame.includes("Retry due"))
  },
  15_000,
)
