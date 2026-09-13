import { expect, test } from "bun:test"
import { InputRenderable, type Renderable, ScrollBoxRenderable } from "@opentui/core"
import type { SessionMessageAssistantTool, SessionMessageInfo } from "@opencode/client"
import type { Config } from "../src/config"
import { createAppFixture } from "./fixture/app"
import { tmpdir } from "./fixture/fixture"
import { directory, json } from "./fixture/tui-client"

const session = {
  id: "ses_tool_modes",
  title: "Tool presentation",
  projectID: "project",
  location: { directory },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 0, updated: 0 },
}

test.each(["generic", "execute", "dismissed"] as const)(
  "minimal %s exposes details with one disclosure",
  async (kind) => {
    await using state = await tmpdir()
    const part: SessionMessageAssistantTool = {
      type: "tool",
      id: "tool",
      name: kind === "generic" || kind === "dismissed" ? "custom.lookup" : kind,
      state:
        kind === "dismissed"
          ? {
              status: "error",
              input: { query: "fixture" },
              error: { type: "provider.transport", message: "user dismissed: ERROR_DETAILS" },
            }
          : {
              status: "completed",
              input: { query: "fixture", command: "echo result" },
              content: [{ type: "text", text: "OUTPUT_DETAILS" }],
              metadata: kind === "execute" ? { error: true } : {},
            },
      time: { created: 1, completed: 2 },
    }
    await using app = await createAppFixture({
      state: state.path,
      config: { animations: false, tabs: { enabled: false }, session: { sidebar: "hide", tool_calls: "minimal" } },
      args: { sessionID: session.id },
      fetch: fetchMessages([assistant("msg_tool", part)]),
    })
    const initial = await app.waitForFrame((frame) => frame.includes(kind === "dismissed" ? "— dismissed" : part.name))
    expect(initial).not.toContain("OUTPUT_DETAILS")
    expect(initial).not.toContain("ERROR_DETAILS")
    if (kind === "execute") expect(initial).toContain("✗ execute echo result — failed")
    if (kind === "dismissed") expect(initial).not.toContain("— failed")
    await app.waitForVisualIdle()
    const row = app.renderer.root.findDescendantById(`minimal-tool:${part.name}:tool`)
    if (!row) throw new Error("Minimal summary not found")
    expect(row.height).toBe(1)
    await app.mockMouse.click(row.x + 1, row.y)
    const expanded = await app.waitForFrame((frame) =>
      frame.includes(kind === "dismissed" ? "ERROR_DETAILS" : "OUTPUT_DETAILS"),
    )
    if (kind === "generic") {
      expect(expanded.match(/custom\.lookup/g)).toHaveLength(1)
      expect(expanded).toContain("query:")
    }
    await app.mockMouse.click(row.x + 1, row.y)
    await app.waitForFrame((frame) => !frame.includes("OUTPUT_DETAILS") && !frame.includes("ERROR_DETAILS"))
  },
)

test.each(["show", "minimal"] as const)("%s shell disclosure loads finished output from storage", async (mode) => {
  await using state = await tmpdir()
  const output = `STORED_OUTPUT_START\n${"output line\n".repeat(12)}STORED_OUTPUT_END`
  const reads: number[] = []
  const messages = fetchMessages([
    assistant("msg_stored_shell", {
      type: "tool",
      id: "stored",
      name: "shell",
      time: { created: 1, completed: 2 },
      state: {
        status: "completed",
        input: { command: "echo stored" },
        content: [{ type: "text", text: "MODEL_OUTPUT_PREVIEW" }],
        metadata: { shellID: "sh_stored" },
      },
    }),
  ])
  await using app = await createAppFixture({
    state: state.path,
    config: { animations: false, tabs: { enabled: false }, session: { sidebar: "hide", tool_calls: mode } },
    args: { sessionID: session.id },
    fetch: (url) => {
      if (url.pathname !== "/api/shell/sh_stored/output") return messages(url)
      const cursor = Number(url.searchParams.get("cursor") ?? 0)
      reads.push(cursor)
      const end = cursor === 0 ? output.indexOf("\n") + 1 : output.length
      return json({
        location: { directory },
        data: { output: output.slice(cursor, end), cursor: end, size: output.length, truncated: false },
      })
    },
  })
  await app.waitForFrame((frame) => frame.includes("echo stored"))
  await app.waitForVisualIdle()
  expect(reads).toHaveLength(0)
  for (const expanded of [true, false, true]) {
    const row = app
      .captureCharFrame()
      .split("\n")
      .findIndex((line) => line.includes("echo stored"))
    expect(row).toBeGreaterThanOrEqual(0)
    await app.mockMouse.click(4, row)
    const frame = await app.waitForFrame((frame) => frame.includes("STORED_OUTPUT_END") === expanded)
    expect(frame).not.toContain("MODEL_OUTPUT_PREVIEW")
    if (expanded) expect(frame).toContain("STORED_OUTPUT_START")
  }
  expect(reads.slice(0, 2)).toEqual([0, output.indexOf("\n") + 1])
})

test("minimal shell reflects background activity after its tool result completes", async () => {
  await using state = await tmpdir()
  const shell = {
    id: "sh_background",
    command: "sleep 10",
    status: "running",
    cwd: directory,
    shell: "/bin/sh",
    file: `${directory}/output`,
    metadata: { sessionID: session.id },
    time: { started: 1 },
  }
  const messages = fetchMessages([
    assistant("msg_background", {
      type: "tool",
      id: "background",
      name: "shell",
      time: { created: 1, completed: 2 },
      state: {
        status: "completed",
        input: { command: "sleep 10" },
        content: [{ type: "text", text: "Started" }],
        metadata: { shellID: shell.id },
      },
    }),
  ])
  await using app = await createAppFixture({
    state: state.path,
    config: { animations: false, tabs: { enabled: false }, session: { sidebar: "hide", tool_calls: "minimal" } },
    args: { sessionID: session.id },
    fetch: (url) => (url.pathname === "/api/shell" ? json({ location: { directory }, data: [shell] }) : messages(url)),
  })
  await app.waitForFrame((frame) => frame.includes("⋯ shell sleep 10 — background"))
  app.events.emit({
    id: "evt_background_done",
    created: 3,
    type: "shell.exited",
    location: { directory },
    data: { id: shell.id, status: "exited", exit: 0 },
  })
  await app.waitForFrame((frame) => frame.includes("▸ shell sleep 10") && !frame.includes("— background"))
})

test("minimal subagents follow the child session after their tool result completes", async () => {
  await using state = await tmpdir()
  await using app = await createAppFixture({
    state: state.path,
    config: { animations: false, tabs: { enabled: false }, session: { sidebar: "hide", tool_calls: "minimal" } },
    args: { sessionID: session.id },
    fetch: fetchMessages([
      assistant("msg_subagent", {
        type: "tool",
        id: "subagent",
        name: "subagent",
        time: { created: 1, completed: 2 },
        state: {
          status: "completed",
          input: { description: "Inspect fixtures" },
          content: [{ type: "text", text: "Started" }],
          metadata: { sessionID: "ses_child" },
        },
      }),
    ]),
  })
  await app.waitForFrame((frame) => frame.includes("▸ subagent Inspect fixtures"))
  app.events.emit({
    id: "evt_child_started",
    created: 3,
    type: "session.execution.started",
    durable: { aggregateID: "ses_child", seq: 1, version: 1 },
    data: { sessionID: "ses_child" },
  })
  await app.waitForFrame((frame) => frame.includes("⋯ subagent Inspect fixtures — background"))
  app.events.emit({
    id: "evt_child_done",
    created: 4,
    type: "session.execution.succeeded",
    durable: { aggregateID: "ses_child", seq: 2, version: 1 },
    data: { sessionID: "ses_child" },
  })
  await app.waitForFrame((frame) => frame.includes("▸ subagent Inspect fixtures") && !frame.includes("— background"))
})

test.each([false, true])("mode changes preserve pinned history anchors (tabs: %s)", async (tabs) => {
  await using state = await tmpdir()
  const config: Config.Info = {
    animations: false,
    tabs: { enabled: tabs },
    session: { sidebar: "hide", tool_calls: "show" },
  }
  const messages = Array.from({ length: 120 }, (_, index): SessionMessageInfo[] => [
    { type: "user", id: `msg_user_${index}`, text: `History message ${index}`, time: { created: index * 2 } },
    assistant(`msg_tool_${index}`, {
      type: "tool",
      id: `tool_${index}`,
      name: "custom.lookup",
      state: { status: "completed", input: { query: `lookup ${index}` }, content: [{ type: "text", text: "Result" }] },
      time: { created: index * 2 + 1, completed: index * 2 + 2 },
    }),
  ]).flat()
  await using app = await createAppFixture({
    state: state.path,
    configService: {
      get: async () => structuredClone(config),
      update: async (update) => {
        update(config)
        return structuredClone(config)
      },
    },
    args: { sessionID: session.id },
    fetch: fetchMessages(messages),
  })
  await app.waitForFrame((frame) => frame.includes("History message 119"))
  await app.waitForVisualIdle()
  const findScroll = (root: Renderable): ScrollBoxRenderable | undefined =>
    root instanceof ScrollBoxRenderable && root.getRenderable("msg_user_119")
      ? root
      : root.getChildren().map(findScroll).find(Boolean)
  const scroll = findScroll(app.renderer.root)
  if (!scroll) throw new Error("Transcript not found")
  scroll.stickyScroll = false
  scroll.scrollTo(Math.max(0, scroll.scrollHeight - scroll.viewport.height - 30))
  await app.waitForVisualIdle()
  const anchor = scroll
    .getChildren()
    .find(
      (row) =>
        row.id.startsWith("msg_user_") &&
        row.y >= scroll.viewport.y &&
        row.y < scroll.viewport.y + scroll.viewport.height,
    )
  if (!anchor) throw new Error("Visible user message not found")
  scroll.scrollTo(scroll.scrollTop + anchor.y - scroll.viewport.y)
  await app.waitForVisualIdle()
  const before = anchor.y - scroll.viewport.y
  for (const mode of ["hide", "minimal", "show"]) {
    app.mockInput.pressKey("p", { ctrl: true })
    await app.waitFor(() => app.renderer.currentFocusedEditor instanceof InputRenderable)
    await app.mockInput.typeText("Open settings")
    await app.waitForVisualIdle()
    app.mockInput.pressEnter()
    await app.waitForFrame((frame) => frame.includes("Settings"))
    await app.mockInput.typeText("Tool calls")
    await app.waitForVisualIdle()
    await app.waitForFrame((frame) => frame.includes("Tool calls") && !frame.includes("Tool grouping"))
    app.mockInput.pressEnter()
    await app.waitFor(() => config.session?.tool_calls === mode)
    app.mockInput.pressKey("ESCAPE")
    await app.waitForFrame(
      (frame) =>
        !frame.includes("Settings") &&
        (mode === "hide"
          ? !frame.includes("custom.lookup")
          : frame.includes(mode === "minimal" ? "▸ custom.lookup" : "✓ custom.lookup")),
    )
    await app.renderOnce()
    await app.waitFor(() => scroll.getRenderable(anchor.id)?.y === scroll.viewport.y + before)
    await app.waitForVisualIdle()
    const restored = scroll.getRenderable(anchor.id)
    if (!restored) throw new Error(`Anchor missing after switching to ${mode}`)
    expect(restored.y - scroll.viewport.y).toBe(before)
  }
})

function assistant(id: string, part: SessionMessageAssistantTool): SessionMessageInfo {
  return {
    id,
    type: "assistant",
    agent: "build",
    model: { providerID: "demo", id: "demo-model" },
    content: [part],
    finish: "tool-calls",
    time: { created: part.time.created, completed: part.time.completed },
  }
}

function fetchMessages(messages: SessionMessageInfo[]) {
  return (url: URL) => {
    if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
    if (url.pathname === `/api/session/${session.id}`) return json({ data: session })
    if (url.pathname === `/api/session/${session.id}/message`) return json({ data: messages.toReversed(), cursor: {} })
    if (url.pathname === `/api/session/${session.id}/inbox` || url.pathname === `/api/session/${session.id}/permission`)
      return json({ data: [] })
    return undefined
  }
}
