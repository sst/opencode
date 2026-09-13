/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { Schema } from "effect"
import {
  AttentionSoundName,
  Info,
  LeaderTimeoutDefault,
  PluginSpec,
  SidebarWidthDefault,
  resolve,
  TuiConfigProvider,
  type Info as TuiConfigInfo,
  useTuiConfig,
} from "../src/config"

const decodeInfo = Schema.decodeUnknownSync(Info)
const decodePlugin = Schema.decodeUnknownSync(PluginSpec)

test("defines package-owned plugin specs and attention sound names", () => {
  expect(decodePlugin("example-plugin")).toBe("example-plugin")
  expect(decodePlugin(["example-plugin", { enabled: true }])).toEqual(["example-plugin", { enabled: true }])
  expect(() => decodePlugin(["example-plugin"])).toThrow()
  expect(AttentionSoundName.literals).toEqual(["default", "question", "permission", "error", "done", "subagent_done"])
})

test("validates config constraints", () => {
  expect(
    decodeInfo({
      leader_timeout: 250,
      attention: { volume: 1, sounds: { done: "done.wav" } },
      prompt: { max_height: 10, max_width: "auto" },
      scroll_speed: 0.001,
      diff_style: "stacked",
      cursor: { blinking: false },
      plugin: ["example-plugin"],
    }),
  ).toMatchObject({
    leader_timeout: 250,
    attention: { volume: 1 },
    diff_style: "stacked",
    cursor: { blinking: false },
  })
  expect(() => decodeInfo({ leader_timeout: 0 })).toThrow()
  expect(() => decodeInfo({ attention: { volume: 1.1 } })).toThrow()
  expect(() => decodeInfo({ prompt: { max_width: 0 } })).toThrow()
  expect(() => decodeInfo({ scroll_speed: 0 })).toThrow()
  expect(() => decodeInfo({ cursor: { style: "beam" } })).toThrow()
  expect(() => decodeInfo({ sidebar_width: 42.7 })).toThrow()
  expect(decodeInfo({ attention: { sounds: { unknown: "sound.wav" } } })).toEqual({ attention: { sounds: {} } })
})

test("resolves host-neutral defaults", () => {
  const config = resolve({}, { terminalSuspend: true })

  expect(config.attention).toEqual({
    enabled: false,
    notifications: true,
    sound: true,
    volume: 0.4,
    sound_pack: "opencode.default",
    sounds: {},
  })
  expect(config.leader_timeout).toBe(LeaderTimeoutDefault)
  expect(config.mouse).toBe(true)
  expect(config.sidebar_width).toBe(SidebarWidthDefault)
  expect(config.keybinds.has("terminal.suspend")).toBe(true)
  expect(config.keybinds.has("session.list")).toBe(true)
  expect(config.cursor).toBeUndefined()
})

test("resolves overrides without mutating input", () => {
  const input: TuiConfigInfo = {
    theme: "custom",
    mouse: false,
    sidebar_width: 56,
    leader_timeout: 750,
    attention: {
      enabled: true,
      notifications: false,
      sound: false,
      volume: 0.8,
      sound_pack: "custom.pack",
      sounds: { question: "/sounds/question.wav" },
    },
    keybinds: { session_list: "ctrl+l" },
    cursor: { blinking: false },
  }
  const config = resolve(input, { terminalSuspend: true })

  expect(config).toMatchObject({
    theme: "custom",
    mouse: false,
    sidebar_width: 56,
    leader_timeout: 750,
    attention: input.attention,
    cursor: { style: "block", blinking: false },
  })
  expect(config.keybinds.get("session.list")).toHaveLength(1)
  expect(input.keybinds).toEqual({ session_list: "ctrl+l" })
})

test("resolves a session move keybind", () => {
  const config = resolve({ keybinds: { session_move: "ctrl+o" } }, { terminalSuspend: true })

  expect(config.keybinds.get("session.move")).toMatchObject([{ key: "ctrl+o" }])
})

test("disables suspend and assigns ctrl+z to undo when unsupported", () => {
  const config = resolve({}, { terminalSuspend: false })

  expect(config.keybinds.has("terminal.suspend")).toBe(false)
  expect(config.keybinds.get("input.undo")).toMatchObject([{ key: "ctrl+z,ctrl+-,super+z" }])
})

test("preserves an explicit undo binding when suspend is unsupported", () => {
  const config = resolve({ keybinds: { input_undo: "ctrl+u", terminal_suspend: "ctrl+s" } }, { terminalSuspend: false })

  expect(config.keybinds.has("terminal.suspend")).toBe(false)
  expect(config.keybinds.get("input.undo")).toHaveLength(1)
  expect(config.keybinds.get("input.undo")).toMatchObject([{ key: "ctrl+u" }])
})

test("provides resolved config through Solid context", async () => {
  const config = resolve({ theme: "custom" }, { terminalSuspend: true })

  function Consumer() {
    const value = useTuiConfig()
    return <text>{`${value.theme} ${value.mouse} ${value.leader_timeout}`}</text>
  }

  const app = await testRender(() => (
    <TuiConfigProvider config={config}>
      <Consumer />
    </TuiConfigProvider>
  ))
  try {
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain(`custom true ${LeaderTimeoutDefault}`)
  } finally {
    app.renderer.destroy()
  }
})

test("requires the config provider", () => {
  expect(() => useTuiConfig()).toThrow("TuiConfigProvider is missing")
})
