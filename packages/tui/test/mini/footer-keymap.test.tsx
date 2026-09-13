/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { Keymap } from "../../src/context/keymap"
import { resolve } from "../../src/config"
import { expect, test } from "bun:test"
import { createSignal } from "solid-js"
import { RunFooterView } from "../../src/mini/footer.view"
import { RUN_THEME_FALLBACK } from "../../src/mini/theme"
import type { FooterState, FooterSubagentState, FooterView } from "../../src/mini/types"

async function renderSubagent(interrupt: "ctrl+i" | "none") {
  const [state] = createSignal<FooterState>({
    phase: "idle",
    status: "",
    notice: "",
    model: "gpt-5",
    usage: undefined,
    first: false,
    interrupt: 0,
    exit: 0,
  })
  const [view] = createSignal<FooterView>({ type: "prompt" })
  const [subagents] = createSignal<FooterSubagentState>({
    tabs: [
      {
        sessionID: "subagent-1",
        label: "Explore",
        description: "Inspect the keymap",
        status: "running",
      },
    ],
    details: {},
    permissions: [],
    forms: [],
  })
  const config = resolve(
    {
      keybinds: {
        "prompt.editor": "none",
        "session.queued_prompts": "none",
        "composer.subagent.interrupt": interrupt,
      },
    },
    { terminalSuspend: true },
  )
  const interrupted: string[] = []

  function Harness() {
    return (
      <Keymap.Provider config={config}>
        <RunFooterView
          directory={() => "/tmp"}
          findFiles={async () => []}
          agents={() => []}
          references={() => []}
          commands={() => []}
          providers={() => undefined}
          currentAgent={() => "Build"}
          currentAgentID={() => "build"}
          currentModel={() => undefined}
          variants={() => []}
          currentVariant={() => undefined}
          state={state}
          view={view}
          subagent={subagents}
          theme={() => RUN_THEME_FALLBACK}
          tuiConfig={config}
          miniSettings={() => ({
            thinking: "hide",
            tools: "show",
            shell_output: "hide",
            turn_summary: "show",
            footer: "show",
            splash: "show",
            work_spinner: "block-soft-slide",
            mono: false,
          })}
          mono={false}
          onSubmit={() => true}
          onPermissionReply={() => {}}
          onFormReply={() => {}}
          onFormCancel={() => {}}
          onCycle={() => {}}
          onInterrupt={() => false}
          onEditorOpen={async () => undefined}
          onInputClear={() => {}}
          onExit={() => {}}
          onAgentSelect={() => {}}
          onModelSelect={() => {}}
          onVariantSelect={() => {}}
          onRows={() => {}}
          onLayout={() => {}}
          onStatus={() => {}}
          onMiniSettingChange={() => {}}
          onSubagentInterrupt={(sessionID) => interrupted.push(sessionID)}
        />
      </Keymap.Provider>
    )
  }

  const app = await testRender(() => <Harness />, { width: 100, height: 8, kittyKeyboard: true })
  return { app, interrupted }
}

async function openSubagent(app: Awaited<ReturnType<typeof testRender>>) {
  await app.renderOnce()
  expect(app.renderer.currentFocusedEditor?.plainText).toBe("")
  app.mockInput.pressArrow("down")
  await app.renderOnce()
  expect(app.captureCharFrame()).toContain("Select subagent")
  app.mockInput.pressEnter()
  await app.renderOnce()
}

test("configured subagent key updates its hint and action", async () => {
  const { app, interrupted } = await renderSubagent("ctrl+i")
  try {
    await openSubagent(app)
    expect(app.captureCharFrame()).toContain("ctrl+i")
    app.mockInput.pressKey("i", { ctrl: true })
    expect(interrupted).toEqual(["subagent-1"])
  } finally {
    app.renderer.currentFocusedRenderable?.blur()
    app.renderer.currentFocusedEditor?.blur()
    app.renderer.destroy()
  }
})

test("disabled subagent interrupt has no component fallback", async () => {
  const { app, interrupted } = await renderSubagent("none")
  try {
    await openSubagent(app)
    expect(app.captureCharFrame()).not.toContain("ctrl+d")
    app.mockInput.pressKey("d", { ctrl: true })
    expect(interrupted).toEqual([])
  } finally {
    app.renderer.currentFocusedRenderable?.blur()
    app.renderer.currentFocusedEditor?.blur()
    app.renderer.destroy()
  }
})
