import { expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { CliRenderEvents, RGBA, TextRenderable } from "@opentui/core"
import path from "node:path"
import { Writable } from "node:stream"
import { coalesceProgressCommit, resolveRunAgent, RunFooter } from "../../src/mini/footer"
import { createRunDemo } from "../../src/mini/demo"
import { resolveMiniSettings } from "../../src/mini/runtime.boot"
import { RUN_THEME_FALLBACK, RUN_THEME_FALLBACK_LIGHT, RUN_THEME_MONO } from "../../src/mini/theme"
import type { MiniSettingChange, MiniSettings, RunAgent, RunTuiConfig, StreamCommit } from "../../src/mini/types"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"
import { tmpdir } from "../fixture/fixture"
import { createFooterApiFixture } from "./fixture/footer-api"

function progress(input: Partial<StreamCommit> = {}): StreamCommit {
  return {
    kind: "tool",
    source: "tool",
    phase: "progress",
    text: "one",
    messageID: "msg_1",
    partID: "part_1",
    tool: "shell",
    toolState: "running",
    ...input,
  }
}

test("coalesces progress only within the same message and tool state", () => {
  expect(coalesceProgressCommit(progress(), progress({ messageID: "msg_2" }))).toBeUndefined()
  expect(coalesceProgressCommit(progress(), progress({ toolState: "completed" }))).toBeUndefined()
  expect(coalesceProgressCommit(progress(), progress({ text: "two", directory: "/latest" }))).toEqual(
    progress({ text: "onetwo", directory: "/latest" }),
  )
})

test.each(["show", "hide"] as const)("tools setting %s controls tool and skill transcript", async (tools) => {
  const app = await setup({ tools })
  try {
    app.footer.append({ kind: "user", text: "do the thing", phase: "start", source: "system" })
    app.footer.append({
      kind: "tool",
      text: "running read",
      phase: "start",
      source: "tool",
      tool: "read",
      messageID: "msg_1",
      partID: "prt_1",
    })
    app.footer.append({
      kind: "system",
      text: `→ Skill "demo"`,
      phase: "start",
      source: "system",
      messageID: "msg_skill",
      partID: "skill:demo",
    })
    app.footer.append({
      kind: "assistant",
      text: "all done",
      phase: "progress",
      source: "assistant",
      messageID: "msg_2",
      partID: "prt_text",
    })
    await app.footer.idle()
    const text = app.externalOutput.takeText()
    expect(text).toContain("do the thing")
    expect(text).toContain("all done")
    if (tools === "hide") {
      expect(text).not.toContain("Read")
      expect(text).not.toContain("Skill")
      return
    }
    expect(text).toContain("-> Read")
    expect(text).toContain("Skill")
  } finally {
    app.footer.destroy()
    app.renderer.destroy()
  }
})

test("falls back only when no agent is selected", () => {
  const agents: RunAgent[] = [
    { id: "task", name: "Task", mode: "subagent", hidden: false },
    { id: "secret", name: "Secret", mode: "primary", hidden: true },
    { id: "build", name: "Build", mode: "primary", hidden: false },
    { id: "plan", name: "Plan", mode: "primary", hidden: false },
  ]

  expect(resolveRunAgent(agents, undefined)?.id).toBe("build")
  expect(resolveRunAgent(agents, "plan")?.id).toBe("plan")
  expect(resolveRunAgent(agents, "missing")).toBeUndefined()
})

async function setup(
  input: {
    mono?: boolean
    tools?: MiniSettings["tools"]
    theme?: RunTuiConfig["theme"]
    startup?: { version: string; detail: string }
    cursorRow?: number
    update?: (change: MiniSettingChange) => Promise<MiniSettings>
  } = {},
) {
  const mono = input.mono ?? true
  const output: string[] = []
  const app = await createTestRenderer({
    width: 112,
    height: 24,
    screenMode: "split-footer",
    footerHeight: 4,
    externalOutputMode: "capture-stdout",
    bufferedOutput: input.cursorRow ? "stdout" : "memory",
    stdout: input.cursorRow
      ? (new Writable({
          write(chunk, _encoding, callback) {
            output.push(chunk.toString())
            callback()
          },
        }) as NodeJS.WriteStream)
      : undefined,
  })
  if (input.cursorRow) {
    await app.renderer.setupTerminal()
    await app.mockInput.pressKeys([`\x1b[${input.cursorRow};1R`])
  }
  const footer = new RunFooter(app.renderer, {
    directory: () => "/project",
    findFiles: async () => [],
    agents: [{ id: "build", name: "Build", mode: "primary", hidden: false }],
    references: [],
    agent: "build",
    modelLabel: "GPT-5",
    model: undefined,
    variant: undefined,
    first: true,
    startup: input.startup,
    wrote: !!input.startup,
    theme: mono ? RUN_THEME_MONO : RUN_THEME_FALLBACK,
    tuiConfig: createTuiResolvedConfig({ theme: input.theme }),
    miniSettings: {
      current: { ...resolveMiniSettings(), mono, ...(input.tools ? { tools: input.tools } : {}) },
      update: input.update,
    },
    onPermissionReply: () => {},
    onFormReply: () => {},
    onFormCancel: () => {},
    onEditorOpen: async () => undefined,
    subscribeThemeSignal: () => () => {},
  })
  return { ...app, footer, output }
}

test.each([1, 5, 24])("startup preserves the terminal prompt row from cursor row %s", async (cursorRow) => {
  const app = await setup({ mono: false, startup: { version: "test", detail: "/project" }, cursorRow })
  try {
    await app.renderOnce()
    app.footer.finishStartup()
    await app.renderOnce()
    // Inspect terminal cursor coordinates, not the footer-local render buffer.
    const rows = Array.from(app.output.join("").matchAll(/\x1b\[(\d+);3H\x1b\[\?25h/g), (match) => Number(match[1]))
    expect(rows.length).toBeGreaterThanOrEqual(2)
    expect(new Set(rows).size).toBe(1)
  } finally {
    app.footer.destroy()
    app.renderer.destroy()
  }
})

test.each(["timer", "output", "close", "panel"] as const)(
  "startup stays editable and settles exactly once before %s",
  async (finish) => {
    const app = await setup({ mono: false, startup: { version: "test", detail: "/project" } })
    try {
      await app.renderOnce()
      expect(app.renderer.root.findDescendantById("mini-startup")).toBeDefined()
      const editor = app.renderer.currentFocusedEditor
      await app.mockInput.typeText("draft")
      expect(editor?.plainText).toBe("draft")
      expect(app.externalOutput.take()).toEqual([])

      if (finish === "timer") await Bun.sleep(850)
      if (finish === "output")
        app.footer.append({ kind: "system", text: "first output", phase: "start", source: "system" })
      if (finish === "close") app.footer.close()
      if (finish === "panel") app.mockInput.pressKey("p", { ctrl: true })
      await app.footer.idle()
      await app.renderOnce()
      expect(app.renderer.root.findDescendantById("mini-startup")).toBeUndefined()
      const rows = app.externalOutput.take().flatMap((event) => event.rows)
      expect(rows.filter((row) => row.includes("oc mini"))).toEqual(["\u25aa oc mini vtest \u00b7 /project"])
      if (finish === "output")
        expect(rows.findIndex((row) => row.includes("first output"))).toBeGreaterThan(
          rows.findIndex((row) => row.includes("oc mini")),
        )
      if (finish !== "panel") expect(app.renderer.currentFocusedEditor).toBe(editor)
      app.footer.finishStartup()
      await app.renderOnce()
      expect(app.externalOutput.take()).toEqual([])
    } finally {
      app.footer.destroy()
      app.renderer.destroy()
    }
  },
)

test("footer usage survives unrelated patches and clears when explicitly undefined", async () => {
  const app = await setup()
  try {
    await app.renderOnce()
    expect(app.captureCharFrame()).not.toContain("7.5K")
    app.footer.event({ type: "stream.patch", patch: { first: false, usage: { tokens: 7_508, percent: 5 } } })
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("7.5K")
    app.footer.event({ type: "stream.patch", patch: { model: "GPT-5.1" } })
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("7.5K")
    app.footer.event({ type: "stream.patch", patch: { usage: undefined } })
    await app.renderOnce()
    expect(app.captureCharFrame()).not.toContain("7.5K")
  } finally {
    app.footer.destroy()
    app.renderer.destroy()
  }
})

test("motion demo waits for work and can be interrupted without a model call", async () => {
  const footer = createFooterApiFixture()
  const controller = new AbortController()
  const demo = createRunDemo({ sessionID: "seed-demo", thinking: false, footer: footer.api })
  let finished = false
  try {
    expect(demo.interrupt()).toBe(false)
    const run = demo.prompt({ text: "/fmt motion", parts: [] }, controller.signal).then((handled) => {
      finished = true
      return handled
    })
    await footer.api.idle()
    expect(finished).toBe(false)
    expect(demo.interrupt()).toBe(true)
    expect(await run).toBe(true)
    expect(demo.interrupt()).toBe(false)
  } finally {
    controller.abort()
  }
})

test.each([false, true])("command menu uses its full height on first open (mono=%s)", async (mono) => {
  const app = await setup({ mono })
  try {
    await app.renderOnce()
    app.mockInput.pressKey("p", { ctrl: true })
    await app.renderOnce()
    await app.renderOnce()
    const frame = app.captureCharFrame()
    expect(frame).toContain("Open editor")
    expect(frame).toContain("Show status")
    expect(frame).toContain("Compact session")
    expect(frame).toContain("New session")
    expect(frame).toContain("Skills")
  } finally {
    app.footer.destroy()
    app.renderer.destroy()
  }
})

test.each([false, true])("monochrome toggles live without replacing the footer (initial=%s)", async (mono) => {
  const changes: MiniSettingChange[] = []
  const app = await setup({
    mono,
    theme: { name: "system" },
    update: async (change) => {
      changes.push(change)
      return { ...resolveMiniSettings(), [change.key]: change.value }
    },
  })
  app.renderer.getPalette = async () => {
    throw new Error("no OSC response")
  }
  const output: string[] = []
  app.renderer.on(CliRenderEvents.EXTERNAL_OUTPUT, (event) => {
    output.push(new TextDecoder().decode(event.snapshot.getRealCharBytes(true)))
  })
  try {
    await app.mockInput.pressKeys(["\x1b]10;rgb:ffff/ffff/ffff\x07", "\x1b]11;rgb:0000/0000/0000\x07"])
    expect(app.renderer.themeMode).toBe("dark")
    await app.renderOnce()
    await app.mockInput.typeText("draft")
    app.mockInput.pressKey("p", { ctrl: true })
    await app.renderOnce()
    await app.mockInput.typeText("settings")
    await app.renderOnce()
    app.mockInput.pressEnter()
    await app.renderOnce()
    await app.mockInput.typeText("monochrome")
    await app.renderOnce()
    const search = app.renderer.currentFocusedRenderable
    for (const next of [!mono, mono]) {
      app.mockInput.pressKey("ARROW_RIGHT")
      await app.flush()
      await app.footer.idle()
      await app.renderOnce()
      expect(app.footer.currentMiniSettings().mono).toBe(next)
      expect(app.footer.currentTheme()).toBe(next ? RUN_THEME_MONO : RUN_THEME_FALLBACK)
      expect(app.renderer.currentFocusedRenderable).toBe(search)
      expect(app.captureCharFrame()).toContain("monochrome")
      expect(app.captureCharFrame()).not.toContain("restart")
      app.footer.append({ kind: "user", text: "new output", phase: "start", source: "system" })
      await app.footer.idle()
      expect(output.at(-1)).toContain(next ? "> new output" : "\u203a new output")
      app.renderer.writeToScrollback((ctx) => ({
        root: new TextRenderable(ctx.renderContext, { content: "external \u2192", width: ctx.width, height: 1 }),
        height: 1,
      }))
      expect(output.at(-1)).toContain(next ? "external ?" : "external \u2192")
    }
    expect(changes).toEqual([
      { key: "mono", value: !mono },
      { key: "mono", value: mono },
    ])
    expect(output.filter((text) => text.includes("new output"))).toHaveLength(2)
    app.mockInput.pressKey("c", { ctrl: true })
    await app.renderOnce()
    expect(app.renderer.currentFocusedEditor?.plainText).toBe("draft")
    expect(app.captureCharFrame()).toContain(mono ? "| draft" : "\u2503 draft")
  } finally {
    app.footer.destroy()
    app.renderer.destroy()
  }
})

test.each([false, true])("production footer preserves wrapped input and status on resize (mono=%s)", async (mono) => {
  const app = await setup({ mono })
  try {
    await app.renderOnce()
    const draft =
      "Explain how this project is organized, then outline a small change and the checks needed to verify it. Do not modify files."
    await app.mockInput.typeText(draft)
    for (const width of [56, 112, 40]) {
      app.resize(width, 24)
      await app.renderOnce()
      await app.renderOnce()
      expect(app.renderer.currentFocusedEditor!.plainText).toBe(draft)
      const frame = app.captureCharFrame()
      expect(frame.split("\n").filter((line) => line.startsWith(mono ? "| " : "┃ "))).toHaveLength(
        app.renderer.currentFocusedEditor!.virtualLineCount,
      )
      expect(app.renderer.currentFocusedEditor!.virtualLineCount).toBeGreaterThan(1)
      expect(frame).toContain("Build")
      expect(frame).toContain("GPT-5")
    }
  } finally {
    app.footer.destroy()
    app.renderer.destroy()
  }
})

test("explicit theme refresh reloads custom colors without a palette event", async () => {
  await using tmp = await tmpdir()
  const previous = process.env.OPENCODE_CONFIG_DIR
  process.env.OPENCODE_CONFIG_DIR = tmp.path
  const app = await setup({ mono: false, theme: { name: "mini-refresh", mode: "dark" } })
  app.renderer.getPalette = async () => {
    throw new Error("no OSC response")
  }
  try {
    await app.renderOnce()
    await app.mockInput.typeText("draft")
    for (const color of ["#123456", "#abcdef"]) {
      await Bun.write(
        path.join(tmp.path, "themes", "mini-refresh.json"),
        JSON.stringify({ version: 2, dark: { text: { default: color } } }),
      )
      await app.footer.refreshTheme()
      await app.renderOnce()
      expect(
        app
          .captureSpans()
          .lines.flatMap((line) => line.spans)
          .find((span) => span.text.includes("draft"))
          ?.fg.toInts(),
      ).toEqual(RGBA.fromHex(color).toInts())
    }
  } finally {
    app.footer.destroy()
    app.renderer.destroy()
    if (previous === undefined) delete process.env.OPENCODE_CONFIG_DIR
    else process.env.OPENCODE_CONFIG_DIR = previous
  }
})

test("system fallback follows physical mode changes when palette queries remain unavailable", async () => {
  const app = await setup({ mono: false, theme: { name: "system" } })
  app.renderer.getPalette = async () => {
    throw new Error("no OSC palette response")
  }
  try {
    await app.renderOnce()
    await app.mockInput.typeText("draft")
    expect(app.footer.currentTheme()).toBe(RUN_THEME_FALLBACK)
    await app.mockInput.pressKeys(["\x1b]10;rgb:0000/0000/0000\x07", "\x1b]11;rgb:ffff/ffff/ffff\x07"])
    expect(app.renderer.themeMode).toBe("light")
    await app.waitFor(() => app.footer.currentTheme() === RUN_THEME_FALLBACK_LIGHT)
    await app.flush()
    expect(app.footer.currentTheme()).toBe(RUN_THEME_FALLBACK_LIGHT)
    expect(
      app
        .captureSpans()
        .lines.flatMap((line) => line.spans)
        .find((span) => span.text.includes("draft"))
        ?.fg.toInts(),
    ).toEqual((RUN_THEME_FALLBACK_LIGHT.footer.text as RGBA).toInts())
  } finally {
    app.footer.destroy()
    app.renderer.destroy()
  }
})
