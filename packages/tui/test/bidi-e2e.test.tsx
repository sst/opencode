import { expect, mock, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { Effect } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Global } from "@opencode-ai/core/global"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { Event, GlobalEvent } from "@opencode-ai/sdk/v2"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"
import { createEventSource, createFetch, directory, json } from "./fixture/tui-sdk"

const W = 80
const H = 24

function global(payload: Event): GlobalEvent {
  return { directory, project: "proj_test", payload }
}

type BootedApp = {
  waitForFrame: (predicate: (frame: string) => boolean, label?: string) => Promise<string>
  captureCharFrame: () => string
  typeText: (text: string) => Promise<void>
  emit: (payload: Event) => void
  exit: () => Promise<void>
}

async function bootApp(args: Record<string, unknown> = {}): Promise<BootedApp> {
  const setup = await createTestRenderer({ width: W, height: H, useThread: false })
  const core = await import("@opentui/core")
  mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => setup.renderer }))
  const events = createEventSource()
  const calls = createFetch((url) => {
    // One connected provider keeps the "Connect a provider" dialog closed.
    if (url.pathname === "/config/providers")
      return json({
        providers: [
          {
            id: "test-provider",
            name: "Test",
            source: "config",
            env: [],
            options: {},
            models: {
              "test-model": {
                id: "test-model",
                name: "Test Model",
                capabilities: {},
              },
            },
          },
        ],
        default: {},
      })
    if (url.pathname === "/session/ses_test/message") return json([])
    if (url.pathname === "/session/ses_test/todo") return json([])
    if (url.pathname === "/session/ses_test/diff") return json([])
    // Legacy (v1) session fetch used by the session route.
    if (url.pathname === "/session/ses_test")
      return json({
        id: "ses_test",
        slug: "ses-test",
        projectID: "proj_test",
        directory,
        version: "0.0.0-test",
        time: { created: 0, updated: 0 },
        title: "Test session",
      })
    if (url.pathname === "/api/session/ses_test")
      return json({
        data: {
          id: "ses_test",
          projectID: "proj_test",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 0, updated: 0 },
          title: "Test session",
          location: { directory },
        },
      })
    if (url.pathname === "/session")
      return json([
        {
          id: "ses_test",
          title: "Test session",
          slug: "ses-test",
          projectID: "proj_test",
          directory,
          version: "0.0.0-test",
          time: { created: 0, updated: 0 },
        },
      ])
    return undefined
  }, events)

  let api: TuiPluginApi | undefined
  let started!: () => void
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })

  const { run } = await import("../src/app")
  const task = Effect.runPromise(
    run({
      url: "http://test",
      directory,
      config: createTuiResolvedConfig({ plugin_enabled: {} }),
      fetch: calls.fetch,
      events: events.source,
      args,
      pluginHost: {
        async start(input) {
          api = input.api
          // Mirror the real plugin host (packages/opencode/src/plugin/tui/runtime.ts):
          // slots render null until they are set up.
          input.runtime.setupSlots(input.api)
          started()
        },
        async dispose() {},
      },
    }).pipe(Effect.provide(AppNodeBuilder.build(Global.node))),
  )
  await ready
  // Poll for content with sleeps: hydration resolves outside the render
  // scheduler's awareness, so scheduler-gated helpers (waitForFrame/flush)
  // can give up while async fetches are still in flight.
  const pollFrame = async (predicate: (frame: string) => boolean, label = "frame") => {
    let frame = ""
    for (let i = 0; i < 150; i++) {
      await Bun.sleep(100)
      await setup.renderOnce()
      frame = setup.captureCharFrame()
      if (predicate(frame)) return frame
    }
    throw new Error(`timed out waiting for ${label}; last frame:\n${frame}`)
  }
  // Wait for the session view to settle (the session footer is a stable
  // marker; the session prompt itself shows no placeholder text).
  await pollFrame((frame) => frame.includes("ctrl+p commands"), "session footer")

  return {
    waitForFrame: pollFrame,
    captureCharFrame: setup.captureCharFrame,
    typeText: setup.mockInput.typeText,
    emit: (payload: Event) => events.emit(global(payload)),
    exit: async () => {
      try {
        api?.keymap.dispatchCommand("app.exit")
        await task
      } finally {
        mock.restore()
        if (!setup.renderer.isDestroyed) setup.renderer.destroy()
      }
    },
  }
}

test("e2e: Arabic prompt input and assistant output in a real session view", async () => {
  const app = await bootApp({ sessionID: "ses_test" })
  try {
    // A) Real keypresses through the real session Prompt into the real bidi
    // textarea. "ازيك يا صاحبي" must paint as "يبحاص اي كيزا".
    await app.typeText("ازيك يا صاحبي")
    const typed = await app.waitForFrame((f) => f.includes("يبحاص اي كيزا"))
    expect(typed.includes("يبحاص اي كيزا")).toBe(true)

    // Mixed Arabic + English through the same path keeps npm intact.
    await app.typeText(" + npm هنا")
    const mixed = await app.waitForFrame((f) => f.includes("npm"))
    expect(mixed.includes("npm")).toBe(true)

    // B) Assistant text through the sync event vocabulary the session view
    // reads (message.updated + message.part.updated/delta).
    const assistant = {
      id: "msg_ar_1",
      sessionID: "ses_test",
      role: "assistant",
      time: { created: 1 },
      parentID: "msg_ar_1",
      modelID: "test-model",
      providerID: "test-provider",
      mode: "build",
      agent: "build",
      path: { cwd: directory, root: directory },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    } as const
    app.emit({ id: "evt_msg_1", type: "message.updated", properties: { sessionID: "ses_test", info: assistant } })
    app.emit({
      id: "evt_part_1",
      type: "message.part.updated",
      properties: {
        sessionID: "ses_test",
        time: 2,
        part: {
          id: "txt_1",
          sessionID: "ses_test",
          messageID: "msg_ar_1",
          type: "text",
          text: "مرحبا بالعالم",
        },
      },
    })
    // "مرحبا بالعالم" paints as the RTL visual "ملاعلاب ابحرم".
    const frame = await app.waitForFrame((f) => f.includes("ملاعلاب ابحرم"), "arabic assistant text")
    expect(frame.includes("ملاعلاب ابحرم")).toBe(true)

    // RTL paragraphs are right-aligned within the message width, not left.
    const arabicRow = frame.split("\n").find((line) => line.includes("ملاعلاب ابحرم"))!
    const column = arabicRow.indexOf("ملاعلاب ابحرم")
    expect(column).toBeGreaterThan(20)
    expect(arabicRow.trimEnd().endsWith("ملاعلاب ابحرم")).toBe(true)

    app.emit({
      id: "evt_delta_2",
      type: "message.part.delta",
      properties: {
        sessionID: "ses_test",
        messageID: "msg_ar_1",
        partID: "txt_1",
        field: "text",
        delta: "\n\nعدّل src/components/Button.tsx الآن",
      },
    })
    // The path stays a contiguous LTR island inside the RTL paragraph.
    const island = await app.waitForFrame((f) => f.includes("src/components/Button.tsx"), "path island")
    expect(island.includes("src/components/Button.tsx")).toBe(true)

    app.emit({
      id: "evt_delta_3",
      type: "message.part.delta",
      properties: {
        sessionID: "ses_test",
        messageID: "msg_ar_1",
        partID: "txt_1",
        field: "text",
        delta: "\n\n**السبب:** النسخة `0.1.9` بتستخدم `npm install opencode-rtl`",
      },
    })
    // Styled mixed markdown (bold markers, version and command code spans)
    // keeps every LTR token intact through real highlighting and conceal.
    // Conceal hides the markers, so the painted tokens are the bare forms.
    const styled = await app.waitForFrame((f) => f.includes("npm install opencode-rtl"), "styled mixed markdown")
    expect(styled.includes("npm install opencode-rtl")).toBe(true)
    expect(styled.includes("0.1.9")).toBe(true)
  } finally {
    await app.exit()
  }
}, 60000)
