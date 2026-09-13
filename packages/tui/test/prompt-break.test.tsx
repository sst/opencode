import { expect, test } from "bun:test"
import { InputRenderable } from "@opentui/core"
import { createAppFixture } from "./fixture/app"
import { directory, json } from "./fixture/tui-client"

test("interrupts before steering the prompt", async () => {
  const session = {
    id: "ses_break",
    projectID: "proj_test",
    title: "Break fixture",
    agent: "build",
    model: { providerID: "provider", id: "model" },
    location: { directory },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 0, updated: 0 },
  }
  const interrupted = Promise.withResolvers<Response>()
  const requests: { path: string; body?: unknown }[] = []
  await using setup = await createAppFixture({
    args: { sessionID: session.id },
    config: { animations: false },
    fetch: async (url, request) => {
      if (url.pathname === "/api/session/active") return json({ data: { [session.id]: { type: "running" } } })
      if (url.pathname === `/api/session/${session.id}`) return json({ data: session })
      if (/^\/api\/session\/[^/]+\/(message|inbox|permission)$/.test(url.pathname))
        return json({ data: [], cursor: {} })
      if (url.pathname === "/api/agent")
        return json({
          location: { directory },
          data: [{ id: "build", mode: "primary", hidden: false, permissions: [] }],
        })
      if (url.pathname === "/api/provider")
        return json({ location: { directory }, data: [{ id: "provider", name: "Provider" }] })
      if (url.pathname === "/api/model")
        return json({
          location: { directory },
          data: [{ id: "model", providerID: "provider", name: "Model", variants: [], cost: [], time: { released: 0 } }],
        })
      if (url.pathname === `/api/session/${session.id}/prompt`) {
        requests.push({ path: url.pathname, body: await request.json() })
        return json({ data: { id: "msg_break" } })
      }
      if (url.pathname === `/api/session/${session.id}/interrupt`) {
        requests.push({ path: url.pathname })
        return interrupted.promise
      }
      return undefined
    },
  })

  try {
    await setup.ready
    await setup.waitForFrame((frame) => frame.includes("Build · Model Provider"))
    await setup.mockInput.typeText("change direction")
    setup.mockInput.pressKey("p", { ctrl: true })
    await setup.waitFor(() => setup.renderer.currentFocusedEditor instanceof InputRenderable)
    await setup.mockInput.typeText("interrupt with prompt")
    await setup.waitForFrame((frame) => frame.includes("Interrupt with prompt"))
    setup.mockInput.pressEnter()
    await setup.waitFor(() => requests.length === 1)
    expect(requests[0]).toEqual({ path: `/api/session/${session.id}/interrupt` })

    interrupted.resolve(json({ data: true }))
    await setup.waitFor(() => requests.length === 2)
    expect(requests[1]).toMatchObject({
      path: `/api/session/${session.id}/prompt`,
      body: { text: "change direction", delivery: "steer" },
    })
  } finally {
    interrupted.resolve(json({ data: true }))
  }
})
