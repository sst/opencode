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
const ARABIC_TITLE = "محادثة تجريبية"

function global(payload: Event): GlobalEvent {
  return { directory, project: "proj_test", payload }
}

function reverseArabic(text: string) {
  return text
    .split(" ")
    .reverse()
    .map((word) => word.split("").reverse().join(""))
    .join(" ")
}

async function bootApp(args: Record<string, unknown> = {}) {
  const setup = await createTestRenderer({ width: W, height: H, useThread: false })
  const core = await import("@opentui/core")
  mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => setup.renderer }))
  const events = createEventSource()
  const calls = createFetch((url) => {
    if (url.pathname === "/config/providers")
      return json({
        providers: [
          {
            id: "test-provider",
            name: "Test",
            source: "config",
            env: [],
            options: {},
            models: { "test-model": { id: "test-model", name: "Test Model", capabilities: {} } },
          },
        ],
        default: {},
      })
    if (url.pathname === "/session")
      return json([
        {
          id: "ses_test",
          title: ARABIC_TITLE,
          slug: "ses-test",
          projectID: "proj_test",
          directory,
          version: "0.0.0-test",
          time: { created: 0, updated: 0 },
        },
      ])
    if (url.pathname === "/session/ses_test/message") return json([])
    if (url.pathname === "/session/ses_test/todo") return json([])
    if (url.pathname === "/session/ses_test/diff") return json([])
    if (url.pathname === "/session/ses_test")
      return json({
        id: "ses_test",
        slug: "ses-test",
        projectID: "proj_test",
        directory,
        version: "0.0.0-test",
        time: { created: 0, updated: 0 },
        title: ARABIC_TITLE,
      })
    if (url.pathname === "/api/session/ses_test")
      return json({
        data: {
          id: "ses_test",
          projectID: "proj_test",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 0, updated: 0 },
          title: ARABIC_TITLE,
          location: { directory },
        },
      })
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
          input.runtime.setupSlots(input.api)
          started()
        },
        async dispose() {},
      },
    }).pipe(Effect.provide(AppNodeBuilder.build(Global.node))),
  )
  await ready
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
  await pollFrame((frame) => frame.includes("ctrl+p commands"), "session footer")

  return {
    waitForFrame: pollFrame,
    dispatch: (name: string) => api?.keymap.dispatchCommand(name),
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

test("e2e: Arabic renders RTL inside a DialogSelect list", async () => {
  const app = await bootApp({ sessionID: "ses_test" })
  try {
    app.dispatch("session.list")
    const frame = await app.waitForFrame(
      (f) => f.includes("Sessions") && f.includes(reverseArabic(ARABIC_TITLE)),
      "arabic session title",
    )
    const row = frame.split("\n").find((line) => line.includes(reverseArabic(ARABIC_TITLE)))!
    // RTL title is right-aligned within the dialog row, not at the left padding.
    expect(row.indexOf(reverseArabic(ARABIC_TITLE))).toBeGreaterThan(20)
  } finally {
    await app.exit()
  }
}, 60000)
