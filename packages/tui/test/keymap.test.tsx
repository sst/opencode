/** @jsxImportSource @opentui/solid */
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { createBindingLookup } from "@opentui/keymap/extras"
import { testRender, useRenderer } from "@opentui/solid"
import { expect, test } from "bun:test"
import { onCleanup } from "solid-js"
import { TuiKeybind } from "../src/config/keybind"
import { getOpencodeModeStack, OPENCODE_BASE_MODE, OpencodeKeymapProvider, registerOpencodeKeymap } from "../src/keymap"

function createResolvedKeymapConfig(input: TuiKeybind.KeybindOverrides = {}) {
  const keybinds = TuiKeybind.parse(input)
  return {
    keybinds: createBindingLookup(TuiKeybind.toBindingConfig(keybinds), {
      commandMap: TuiKeybind.CommandMap,
      bindingDefaults: TuiKeybind.bindingDefaults(),
    }),
    leader_timeout: 2000,
  }
}

test("legacy page key aliases compile as page keys", async () => {
  const sequences: Record<string, string[][]> = {}

  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const config = createResolvedKeymapConfig({
      messages_page_up: "pgup",
      messages_page_down: "pgdown",
    })
    const offKeymap = registerOpencodeKeymap(keymap, renderer, config)
    const offLayer = keymap.registerLayer({
      bindings: config.keybinds.gather("session", ["session.page.up", "session.page.down"]),
    })
    const bindings = keymap.getCommandBindings({
      visibility: "registered",
      commands: ["session.page.up", "session.page.down"],
    })
    sequences.up =
      bindings.get("session.page.up")?.map((binding) => binding.sequence.map((part) => part.stroke.name)) ?? []
    sequences.down =
      bindings.get("session.page.down")?.map((binding) => binding.sequence.map((part) => part.stroke.name)) ?? []
    onCleanup(() => {
      offLayer()
      offKeymap()
    })

    return (
      <OpencodeKeymapProvider keymap={keymap}>
        <box />
      </OpencodeKeymapProvider>
    )
  }

  const app = await testRender(() => <Harness />)
  try {
    expect(sequences).toEqual({
      up: [["pageup"]],
      down: [["pagedown"]],
    })
  } finally {
    app.renderer.destroy()
  }
})

test("mode-less bindings stay active when opencode mode changes", async () => {
  const counts: Record<string, Record<string, number>> = {}

  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const config = createResolvedKeymapConfig()
    const offKeymap = registerOpencodeKeymap(keymap, renderer, config)
    const offGlobal = keymap.registerLayer({
      commands: [
        { name: "session.list", run() {} },
        { name: "session.new", run() {} },
        { name: "session.page.up", run() {} },
        { name: "session.first", run() {} },
      ],
      bindings: config.keybinds.gather("test.global", [
        "session.list",
        "session.new",
        "session.page.up",
        "session.first",
      ]),
    })
    const offBase = keymap.registerLayer({
      mode: OPENCODE_BASE_MODE,
      commands: [{ name: "model.list", run() {} }],
      bindings: config.keybinds.gather("test.base", ["model.list"]),
    })
    const activeCounts = () =>
      Object.fromEntries(
        Array.from(
          keymap.getCommandBindings({
            visibility: "active",
            commands: ["session.list", "session.new", "session.page.up", "session.first", "model.list"],
          }),
          ([command, bindings]) => [command, bindings.length],
        ),
      )

    counts.base = activeCounts()
    const popQuestion = getOpencodeModeStack(keymap).push("question")
    counts.question = activeCounts()
    popQuestion()
    const popAutocomplete = getOpencodeModeStack(keymap).push("autocomplete")
    counts.autocomplete = activeCounts()
    popAutocomplete()

    onCleanup(() => {
      offBase()
      offGlobal()
      offKeymap()
    })

    return (
      <OpencodeKeymapProvider keymap={keymap}>
        <box />
      </OpencodeKeymapProvider>
    )
  }

  const app = await testRender(() => <Harness />)
  try {
    expect(counts).toEqual({
      base: { "session.list": 1, "session.new": 1, "session.page.up": 2, "session.first": 2, "model.list": 1 },
      question: { "session.list": 1, "session.new": 1, "session.page.up": 2, "session.first": 2, "model.list": 0 },
      autocomplete: {
        "session.list": 1,
        "session.new": 1,
        "session.page.up": 2,
        "session.first": 2,
        "model.list": 0,
      },
    })
  } finally {
    app.renderer.destroy()
  }
})

test("subagent-interrupt gather is not shadowed by the shared 'session' bucket", () => {
  // Root cause: createBindingLookup.gather(name, commands) is cached BY NAME — a
  // second call reusing an existing name returns the cached bindings and
  // ignores its `commands` argument. The session route previously gathered
  // "session" (which already exists for nav keys) and then "session" again
  // for "session.interrupt"; the second call's commands were dropped. The fix
  // is to gather under a unique name. This test pins both behaviors.

  const config = createResolvedKeymapConfig()

  // 1. Two different gather names with different command lists produce
  //    DIFFERENT buckets — the cache key is the name, not the commands.
  const navOnly = config.keybinds.gather("test.nav", ["session.page.up", "session.first"])
  const subagentOnly = config.keybinds.gather("test.subagent", ["session.subagent.interrupt"])
  const navCommands = new Set(navOnly.map((b) => b.cmd))
  const subagentCommands = new Set(subagentOnly.map((b) => b.cmd))
  expect(navCommands.size).toBeGreaterThan(0)
  expect(subagentCommands.size).toBeGreaterThan(0)
  expect(navCommands).not.toEqual(subagentCommands)

  // 2. Reusing a name on a second call returns the FIRST call's bindings and
  //    drops the second call's commands. This is the gotcha the route hit.
  const first = config.keybinds.gather("test.reused", ["session.page.up"])
  const second = config.keybinds.gather("test.reused", ["session.subagent.interrupt"])
  expect(second).toBe(first)
  expect(new Set(second.map((b) => b.cmd))).toEqual(new Set(["session.page.up"]))

  // 3. Under the unique name, session.subagent.interrupt resolves to escape.
  const subagentInterrupt = config.keybinds.get("session.subagent.interrupt")
  expect(subagentInterrupt.length).toBeGreaterThan(0)
  const keys = subagentInterrupt.map((b) => b.key)
  expect(keys).toContain("escape")
})
