import { expect, spyOn, test } from "bun:test"
import { RGBA, TextAttributes } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { RunFooter } from "../../src/mini/footer"
import { resolveMiniSettings } from "../../src/mini/runtime.boot"
import { RUN_THEME_FALLBACK, RUN_THEME_MONO } from "../../src/mini/theme"
import type { RunPrompt } from "../../src/mini/types"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"

const sizes = [
  [112, 30],
  [24, 8],
  [40, 12],
  [112, 30],
] as const

async function setup(mono = false) {
  const app = await createTestRenderer({
    width: 112,
    height: 30,
    screenMode: "split-footer",
    footerHeight: 4,
    externalOutputMode: "capture-stdout",
  })
  const theme = mono ? RUN_THEME_MONO : RUN_THEME_FALLBACK
  const prompts: RunPrompt[] = []
  const footer = new RunFooter(app.renderer, {
    directory: () => "/project",
    findFiles: async () => ["packages/tui/src/mini/footer.view.tsx", "packages/tui/src/mini/", "src/\u6587\u4ef6.ts"],
    agents: [{ id: "build", name: "Build", mode: "primary", hidden: false }],
    references: [],
    agent: "build",
    modelLabel: "GPT-5",
    model: undefined,
    variant: undefined,
    first: false,
    theme,
    tuiConfig: createTuiResolvedConfig(),
    miniSettings: {
      current: { ...resolveMiniSettings(), mono },
    },
    onPermissionReply: () => {},
    onFormReply: () => {},
    onFormCancel: () => {},
    onEditorOpen: async () => undefined,
    subscribeThemeSignal: () => () => {},
  })
  footer.onPrompt((prompt) => prompts.push(prompt))
  footer.event({ type: "catalog", agents: [], references: [], commands: [] })
  return {
    ...app,
    footer,
    prompts,
    selected() {
      return app
        .captureSpans()
        .lines.flatMap((line) => line.spans)
        .filter((span) =>
          mono
            ? (span.attributes & TextAttributes.INVERSE) !== 0
            : span.bg.toInts().join() === (theme.footer.actionFocusedBg as RGBA).toInts().join(),
        )
        .map((span) => span.text)
        .join("")
        .trim()
    },
    async settle() {
      await app.renderOnce()
      await app.renderOnce()
    },
    cleanup() {
      footer.destroy()
      app.renderer.destroy()
    },
  }
}

test.each([56, 160])("production footer confirms exit with a visible menu hint at %i columns", async (width) => {
  const app = await setup()
  try {
    app.resize(width, 30)
    app.footer.event({ type: "stream.patch", patch: { phase: "running", usage: { tokens: 14100, percent: 1 } } })
    await app.settle()
    expect(app.captureCharFrame()).toContain("ctrl+p menu")
    app.footer.requestExit()
    await app.settle()
    expect(app.captureCharFrame()).toContain("Press ctrl+c again to exit")
    expect(app.captureCharFrame()).not.toContain("menu")
    expect(app.footer.isClosed).toBe(false)
    app.footer.requestExit()
    expect(app.footer.isClosed).toBe(true)
  } finally {
    app.cleanup()
  }
})

test.each([false, true])(
  "production statusline restores identity and trailing menu after resizes (mono=%s)",
  async (mono) => {
    const app = await setup(mono)
    const theme = mono ? RUN_THEME_MONO : RUN_THEME_FALLBACK
    try {
      app.footer.event({
        type: "models",
        providers: [
          { id: "opencode", name: "Anomaly / OpenCode", models: { "gpt-5.6-sol": { name: "GPT-5.6 Sol (50% Off)" } } },
        ],
      })
      app.footer.event({
        type: "model",
        model: "GPT-5.6 Sol (50% Off)",
        selection: { providerID: "opencode", modelID: "gpt-5.6-sol" },
      })
      app.footer.event({ type: "variants", variants: ["max"], current: "max" })
      app.footer.event({ type: "stream.patch", patch: { usage: { tokens: 14100, percent: 1, cost: 0.04 } } })
      await app.settle()
      const initial = app.captureCharFrame()
      for (const [width, height] of sizes) {
        app.resize(width, height)
        await app.settle()
        const statusline = app.renderer.root.findDescendantById("mini-statusline")!
        const frame = app.captureCharFrame()
        const row = frame.split("\n")[statusline.y].trimEnd()
        const model = width === 112 ? "GPT-5.6 Sol (50% Off) [max]" : mono ? "GPT-5.6... [max]" : "GPT-5.6\u2026 [max]"
        expect(row).toBe(
          (width === 112
            ? ["Build", model, "14.1K (1%)", "Anomaly / OpenCode", "$0.04", "ctrl+p menu"]
            : width === 40
              ? ["Build", model, "1% ctx"]
              : ["Build", model]
          ).join(mono ? " - " : " \u00b7 "),
        )
        expect(statusline.height).toBe(1)
        expect(app.renderer.footerHeight).toBe(height === 30 ? 4 : 2)
        const identity = app.captureSpans().lines[statusline.y].spans.find((span) => span.text.includes("[max]"))!
        expect(identity.text).toContain(model)
        expect(identity.fg.toInts()).toEqual((theme.footer.text as RGBA).toInts())
        if (width === 112) expect(frame).toBe(initial)
        if (mono) expect(frame).not.toMatch(/[^\x00-\x7f]/)
      }
    } finally {
      app.cleanup()
    }
  },
)

test("ctrl+l clears the split-footer screen without wiping scrollback", async () => {
  const app = await setup()
  try {
    const clear = spyOn(app.renderer, "resetSplitFooterForReplay").mockImplementation(() => {})
    await app.settle()
    app.mockInput.pressKey("l", { ctrl: true })
    expect(clear).toHaveBeenCalledWith({ clearSavedLines: false })
  } finally {
    app.cleanup()
  }
})

test("command palette can clear the screen", async () => {
  const app = await setup()
  try {
    const clear = spyOn(app.renderer, "resetSplitFooterForReplay").mockImplementation(() => {})
    await app.settle()
    app.mockInput.pressKey("p", { ctrl: true })
    await app.settle()
    await app.mockInput.typeText("clear screen")
    await app.settle()
    expect(app.selected()).toContain("Clear screen")
    app.mockInput.pressEnter()
    expect(clear).toHaveBeenCalledWith({ clearSavedLines: false })
  } finally {
    app.cleanup()
  }
})

test.each([false, true])("production command menu keeps navigation visible across resizes (mono=%s)", async (mono) => {
  const app = await setup(mono)
  try {
    await app.settle()
    app.mockInput.pressKey("p", { ctrl: true })
    await app.settle()
    app.mockInput.pressKey("END")
    await app.settle()
    for (const [width, height] of sizes) {
      app.resize(width, height)
      await app.settle()
      expect(app.renderer.footerHeight).toBeLessThanOrEqual(height)
      expect(app.captureCharFrame()).toContain("esc")
      expect(app.selected()).toContain("Exit")
      expect(app.footer.isClosed).toBe(false)
    }
    for (const [key, title] of [
      ["ARROW_UP", "Settings"],
      ["ARROW_DOWN", "Exit"],
      ["HOME", "Open editor"],
      ["ARROW_DOWN", "Show status"],
      ["END", "Exit"],
    ]) {
      app.mockInput.pressKey(key)
      await app.settle()
      expect(app.selected()).toContain(title)
    }
    app.mockInput.pressEnter()
    expect(app.footer.isClosed).toBe(true)
  } finally {
    app.cleanup()
  }
})

test.each([false, true])(
  "production model menu keeps labels and current state before metadata (mono=%s)",
  async (mono) => {
    const app = await setup(mono)
    const title = "\u6a21\u578b\u6d4b\u8bd5 Alpha"
    try {
      app.footer.event({
        type: "models",
        providers: [
          {
            id: "provider-with-long-id",
            name: "Provider with a very long name",
            models: Object.fromEntries(
              Array.from({ length: 22 }, (_, index) => [
                "very-long-internal-model-id-" + index,
                { name: index === 0 ? title : `Model ${String(index).padStart(2, "0")}` },
              ]),
            ),
          },
        ],
      })
      await app.settle()
      app.mockInput.pressKey("p", { ctrl: true })
      await app.settle()
      await app.mockInput.typeText("switch model")
      app.mockInput.pressEnter()
      await app.settle()
      for (const [key, text] of [
        ["HOME", "Model 01"],
        ["ARROW_DOWN", "Model 02"],
        ["ARROW_UP", "Model 01"],
        ["END", title],
      ]) {
        app.mockInput.pressKey(key)
        await app.settle()
        expect(app.selected()).toContain(text)
      }
      for (const [width, height] of sizes) {
        app.resize(width, height)
        await app.settle()
        expect(app.selected()).toContain(title)
        expect(app.captureCharFrame()).toContain("esc")
      }
      app.resize(24, 8)
      await app.settle()
      expect(app.selected()).toBe(title)
      expect(app.captureCharFrame()).not.toContain("very-long")
      app.mockInput.pressEnter()
      await app.settle()
      app.mockInput.pressKey("p", { ctrl: true })
      await app.settle()
      await app.mockInput.typeText("switch model")
      app.mockInput.pressEnter()
      await app.settle()
      expect(app.selected()).toContain("current")
      expect(app.selected()).toContain("\u6a21\u578b\u6d4b\u8bd5")
      expect(app.selected()).not.toContain("very-long")
      for (const width of [16, 20, 32, 40]) {
        app.resize(width, 8)
        await app.settle()
        expect(app.captureCharFrame()).toContain("esc")
        expect(app.selected()).toContain(title)
        expect(app.selected().includes("current")).toBe(width >= 24)
      }
    } finally {
      app.cleanup()
    }
  },
)

test("subagent menu recalculates its twelve-row window after shrink, filter, and growth", async () => {
  const app = await setup()
  try {
    app.footer.event({
      type: "stream.subagent",
      state: {
        tabs: Array.from({ length: 24 }, (_, index) => ({
          sessionID: `child-${index}`,
          label: "Worker",
          description: `Task ${String(index).padStart(2, "0")}`,
          status: "running",
        })),
        details: {},
        permissions: [],
        forms: [],
      },
    })
    await app.settle()
    app.mockInput.pressKey("ARROW_DOWN")
    await app.settle()
    for (const [key, title] of [
      ["END", "Task 23"],
      ["ARROW_UP", "Task 22"],
      ["HOME", "Task 00"],
      ["ARROW_DOWN", "Task 01"],
      ["END", "Task 23"],
    ]) {
      app.mockInput.pressKey(key)
      await app.settle()
      expect(app.selected()).toContain(title)
    }
    for (const [width, height] of sizes) {
      app.resize(width, height)
      await app.settle()
      expect(app.renderer.footerHeight).toBeLessThanOrEqual(height)
      expect(app.selected()).toContain("Task 23")
      expect(app.selected()).toContain("running")
    }
    await app.mockInput.typeText("Task 23")
    await app.settle()
    expect(app.selected()).toContain("Task 23")
    app.mockInput.pressKey("u", { ctrl: true })
    await app.settle()
    app.mockInput.pressKey("HOME")
    for (const [height, title] of [
      [8, "Task 04"],
      [12, "Task 08"],
      [30, "Task 11"],
    ] as const) {
      app.resize(24, height)
      await app.settle()
      app.mockInput.pressKey("\x1b[6~")
      await app.settle()
      expect(app.selected()).toContain(title)
      app.mockInput.pressKey("\x1b[5~")
      await app.settle()
      expect(app.selected()).toContain("Task 00")
    }
  } finally {
    app.cleanup()
  }
})

test.each([false, true])("wrapped notices reserve space beside a six-line draft (mono=%s)", async (mono) => {
  const app = await setup(mono)
  const draft = "first\nsecond\nthird\nfourth\nfifth\nsixth"
  try {
    await app.settle()
    app.mockInput.pasteBracketedText(draft)
    app.footer.event({ type: "stream.patch", patch: { notice: "failed to save settings" } })
    for (const width of [16, 24, 40]) {
      app.resize(width, 8)
      await app.flush()
      expect(app.renderer.footerHeight).toBeLessThanOrEqual(7)
      expect(app.renderer.currentFocusedEditor?.plainText).toBe(draft)
      expect(app.captureCharFrame().replace(/\s+/g, " ")).toContain("failed to save settings")
      expect(app.captureCharFrame()).toContain("sixth")
    }
    app.footer.event({ type: "stream.patch", patch: { notice: "" } })
    await app.flush()
    expect(app.captureCharFrame()).toContain("Build")
    expect(app.renderer.currentFocusedEditor?.plainText).toBe(draft)
  } finally {
    app.cleanup()
  }
})

test.each([false, true])("composer and autocomplete share the physical height budget (mono=%s)", async (mono) => {
  const app = await setup(mono)
  const draft = "first\nsecond\nthird\nfourth\nfifth\nsixth"
  try {
    await app.settle()
    app.mockInput.pasteBracketedText(draft)
    await app.flush()
    await app.mockInput.typeText(" @f")
    await app.settle()
    for (const [width, height] of sizes) {
      app.resize(width, height)
      await app.settle()
      expect(app.renderer.footerHeight).toBeLessThanOrEqual(height - 1)
      expect(app.captureCharFrame()).toContain("sixth @f")
      expect(app.selected()).toContain(width === 24 ? "@mini/footer.view.tsx" : "footer.view.tsx")
      app.mockInput.pressKey("ARROW_DOWN")
      await app.settle()
      expect(app.selected()).toContain("mini/")
      app.mockInput.pressKey("ARROW_UP")
      await app.settle()
      expect(app.selected()).toContain("footer.view.tsx")
    }
    app.resize(24, 8)
    await app.settle()
    app.mockInput.pressEnter()
    await app.settle()
    const text = draft + " @packages/tui/src/mini/footer.view.tsx "
    expect(app.renderer.currentFocusedEditor?.plainText).toBe(text)
    app.mockInput.pressEnter()
    await app.settle()
    expect(app.prompts).toHaveLength(1)
    expect(app.prompts[0].text).toBe(text)
    expect(app.prompts[0].parts[0]).toMatchObject({
      type: "file",
      filename: "packages/tui/src/mini/footer.view.tsx",
      source: {
        type: "file",
        path: "packages/tui/src/mini/footer.view.tsx",
        text: {
          start: draft.length + 1,
          end: text.length - 1,
          value: "@packages/tui/src/mini/footer.view.tsx",
        },
      },
    })
    app.footer.event({
      type: "catalog",
      agents: [],
      references: [],
      commands: Array.from({ length: 24 }, (_, index) => ({
        name: `cmd-${String(index).padStart(2, "0")}`,
        description: "Optional command description",
      })),
    })
    await app.mockInput.typeText("/")
    for (const [width, height] of sizes) {
      app.resize(width, height)
      await app.settle()
      expect(app.renderer.footerHeight).toBeLessThanOrEqual(height - 1)
      for (let index = 1; index <= 12; index++) {
        app.mockInput.pressKey("ARROW_DOWN")
        await app.settle()
        expect(app.selected()).toContain(`/cmd-${String(index).padStart(2, "0")}`)
      }
      for (let index = 0; index < 12; index++) app.mockInput.pressKey("ARROW_UP")
      await app.settle()
      expect(app.selected()).toContain("/cmd-00")
    }
  } finally {
    app.cleanup()
  }
})
