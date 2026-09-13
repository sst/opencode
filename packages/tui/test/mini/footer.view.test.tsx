/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { BoxRenderable, ImageRenderable, RGBA, type CliRenderer, type RootRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { testRender } from "@opentui/solid"
import { createSignal } from "solid-js"
import type { FormInfo } from "@opencode/client/promise"
import { Keymap } from "../../src/context/keymap"
import type { ClipboardContent, ClipboardService } from "../../src/context/clipboard"
import {
  RUN_COMMAND_PANEL_ROWS,
  RUN_SUBAGENT_PANEL_ROWS,
  RunAgentSelectBody,
  RunCommandMenuBody,
  RunModelSelectBody,
  RunSettingsBody,
  RunSkillSelectBody,
  RunSubagentSelectBody,
  RunVariantSelectBody,
} from "../../src/mini/footer.command"
import { RunFooterView } from "../../src/mini/footer.view"
import { RunFooter } from "../../src/mini/footer"
import { RunEntryContent } from "../../src/mini/scrollback.writer"
import { RUN_THEME_FALLBACK, RUN_THEME_FALLBACK_LIGHT, resolveRunTheme, type RunTheme } from "../../src/mini/theme"
import { BLOCK_SOFT_SLIDE, SEED_MONO, WORK_SPINNERS } from "../../src/ui/one-cell-motion"
import { resolveMiniSettings } from "../../src/mini/runtime.boot"
import { applyMiniSettingChange } from "../../src/mini/verbosity"
import type {
  FooterQueuedPrompt,
  FooterState,
  FooterSubagentState,
  FooterSubagentTab,
  FooterView,
  MiniSettingChange,
  MiniSettings,
  QueuedPromptAction,
  RunAgent,
  RunCommand,
  RunInput,
  RunPrompt,
  RunProvider,
  RunTuiConfig,
  StreamCommit,
} from "../../src/mini/types"
import { selectedCommand } from "../../src/mini/footer.prompt"
import { RejectField } from "../../src/mini/footer.permission"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"
import { tmpdir } from "../fixture/fixture"
import { diffImageFixture } from "../fixture/diff-image"

const tuiConfig = createTuiResolvedConfig()

async function nativeLightTheme() {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/themes/mini-native-light.json`, JSON.stringify({ version: 2, light: {} }))
  const previous = process.env.OPENCODE_CONFIG_DIR
  process.env.OPENCODE_CONFIG_DIR = tmp.path
  try {
    return await resolveRunTheme(
      {
        themeMode: "light",
        getPalette: async (): ReturnType<CliRenderer["getPalette"]> => {
          throw new Error("Palette unavailable")
        },
      } as CliRenderer,
      { name: "mini-native-light" },
    )
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_CONFIG_DIR
    else process.env.OPENCODE_CONFIG_DIR = previous
  }
}

function command(input: { name: string; description: string; source?: "command" | "mcp" | "skill" }) {
  return {
    name: input.name,
    description: input.description,
    source: input.source,
  } satisfies RunCommand
}

function model(input: {
  id: string
  name: string
  status?: "active" | "deprecated"
  cost?: number
  variants?: Record<string, Record<string, never>>
}) {
  return {
    name: input.name,
    cost: {
      input: input.cost ?? 1,
    },
    status: input.status ?? "active",
    variants: input.variants,
  } satisfies RunProvider["models"][string]
}

function provider() {
  return {
    id: "opencode",
    name: "opencode",
    models: {
      "gpt-5": model({ id: "gpt-5", name: "GPT-5", variants: { high: {}, minimal: {} } }),
      "gpt-free": model({ id: "gpt-free", name: "GPT Free", cost: 0 }),
      old: model({ id: "old", name: "Old Model", status: "deprecated" }),
    },
  } satisfies RunProvider
}

function subagent(input: {
  sessionID: string
  label: string
  description: string
  status?: FooterSubagentTab["status"]
}) {
  return {
    sessionID: input.sessionID,
    label: input.label,
    description: input.description,
    status: input.status ?? "running",
  } satisfies FooterSubagentTab
}

function footerState(input: Partial<FooterState> = {}) {
  return createSignal<FooterState>({
    phase: "idle",
    status: "",
    notice: "",
    model: "gpt-5",
    usage: undefined,
    first: false,
    interrupt: 0,
    exit: 0,
    ...input,
  })
}

async function renderFooter(
  input: {
    tuiConfig?: RunTuiConfig
    commands?: RunCommand[]
    theme?: () => RunTheme
    providers?: RunProvider[]
    agents?: RunAgent[]
    currentAgent?: string
    currentModel?: RunInput["model"]
    currentVariant?: string
    subagents?: FooterSubagentState
    width?: number
    height?: number
    state?: Partial<FooterState>
    onCycle?: () => void
    onSubmit?: (prompt: RunPrompt) => boolean | Promise<boolean>
    clipboard?: Pick<ClipboardService, "read">
    history?: RunPrompt[]
    view?: FooterView
    onFormReply?: (input: unknown) => void
    miniSettings?: MiniSettings
    mono?: boolean
    onStatus?: (status: string) => void
    onMiniSettingChange?: (change: MiniSettingChange) => void
    queuedPrompts?: FooterQueuedPrompt[]
    onQueuedPromptAction?: (action: QueuedPromptAction, inboxID: string) => Promise<void>
  } = {},
) {
  const [view, setView] = createSignal<FooterView>(input.view ?? { type: "prompt" })
  const [subagents] = createSignal<FooterSubagentState>(
    input.subagents ?? { tabs: [], details: {}, permissions: [], forms: [] },
  )
  const [state, setState] = footerState(input.state)
  const [queuedPrompts, setQueuedPrompts] = createSignal(input.queuedPrompts ?? [])
  const config = { ...(input.tuiConfig ?? tuiConfig), animations: input.tuiConfig?.animations ?? false }
  const [miniSettings, setMiniSettings] = createSignal<MiniSettings>(input.miniSettings ?? resolveMiniSettings())
  function Harness() {
    return (
      <Keymap.Provider config={config}>
        <RunFooterView
          directory={() => "/tmp"}
          findFiles={async () => []}
          agents={() => input.agents ?? []}
          references={() => []}
          commands={() => input.commands ?? []}
          providers={() => input.providers}
          currentAgent={() => input.currentAgent ?? "Build"}
          currentAgentID={() => input.currentAgent?.toLowerCase() ?? "build"}
          currentModel={() => input.currentModel}
          variants={() => []}
          currentVariant={() => input.currentVariant}
          state={state}
          view={view}
          subagent={subagents}
          queuedPrompts={queuedPrompts}
          theme={input.theme ?? (() => RUN_THEME_FALLBACK)}
          tuiConfig={config}
          mono={input.mono ?? false}
          miniSettings={miniSettings}
          onSubmit={input.onSubmit ?? (() => true)}
          clipboard={input.clipboard}
          history={() => input.history ?? []}
          onPermissionReply={() => {}}
          onFormReply={(value) => input.onFormReply?.(value)}
          onFormCancel={() => {}}
          onCycle={input.onCycle ?? (() => {})}
          onInterrupt={() => false}
          onQueuedPromptAction={input.onQueuedPromptAction}
          onEditorOpen={async () => undefined}
          onInputClear={() => {}}
          onExit={() => {}}
          onAgentSelect={() => {}}
          onModelSelect={() => {}}
          onVariantSelect={() => {}}
          onRows={() => {}}
          onLayout={() => {}}
          onStatus={(status) => input.onStatus?.(status)}
          onMiniSettingChange={(change) => input.onMiniSettingChange?.(change)}
        />
      </Keymap.Provider>
    )
  }

  const app = await testRender(
    () => (
      <box width={input.width ?? 100} height={input.height ?? 8}>
        <Harness />
      </box>
    ),
    { width: input.width ?? 100, height: input.height ?? 8, kittyKeyboard: true },
  )

  return {
    ...app,
    setView,
    setState,
    setMiniSettings,
    setQueuedPrompts,
    cleanup() {
      app.renderer.currentFocusedRenderable?.blur()
      app.renderer.currentFocusedEditor?.blur()
      app.renderer.destroy()
    },
  }
}

// OpenTUI image teardown crashes Bun 1.3.14's Windows test runner after the assertions pass.
// Keep the native preview coverage on Linux while the attachment behavior remains covered on both platforms below.
test.skipIf(process.platform === "win32").each([
  { width: 80, height: 24, mono: false, preview: true },
  { width: 24, height: 8, mono: false, preview: true },
  { width: 80, height: 24, mono: true, preview: true },
  { width: 80, height: 24, mono: false, preview: false },
])(
  "mini pastes, previews, submits, and recalls an image ($width x $height, mono=$mono, preview=$preview)",
  async (options) => {
    const submitted: RunPrompt[] = []
    const data = Buffer.from(diffImageFixture).toString("base64")
    const app = await renderFooter({
      ...options,
      tuiConfig: createTuiResolvedConfig({ prompt: { image_preview: options.preview } }),
      clipboard: { read: async () => ({ data, mime: "image/png" }) },
      onSubmit: (prompt) => {
        submitted.push(prompt)
        return true
      },
    })
    try {
      await app.renderOnce()
      app.mockInput.pressKey("v", { ctrl: true })
      await app.waitForFrame((frame) => frame.includes("[Image 1]"))
      const image = app.renderer.root.findDescendantById("mini-prompt-image-0")
      if (!options.mono && options.preview) {
        expect(image).toBeInstanceOf(ImageRenderable)
        if (!(image instanceof ImageRenderable)) throw new Error("Image preview missing")
        await image.loadPromise
        expect(image.image?.width).toBe(96)
        expect(image.fit).toBe("fit")
        expect(image.width).toBeGreaterThan(0)
        expect(image.height).toBeGreaterThan(0)
        expect(image.height).toBeLessThanOrEqual(4)
        expect(image.x + image.width).toBeLessThanOrEqual(options.width)
        await app.mockInput.typeText("x")
        app.mockInput.pressKey("BACKSPACE")
        await app.renderOnce()
        expect(app.renderer.root.findDescendantById("mini-prompt-image-0")).toBe(image)
      }
      if (options.mono || !options.preview) expect(image).toBeUndefined()
      app.mockInput.pressEnter()
      await app.waitFor(() => submitted.length === 1)
      expect(submitted[0]).toMatchObject({
        text: "[Image 1] ",
        parts: [
          {
            type: "file",
            url: `data:image/png;base64,${data}`,
            filename: "clipboard",
            mime: "image/png",
            source: { text: { start: 0, end: 9, value: "[Image 1]" } },
          },
        ],
      })
      await app.waitFor(() => app.renderer.currentFocusedEditor?.plainText === "")
      app.mockInput.pressKey("ARROW_UP")
      await app.waitForFrame((frame) => frame.includes("[Image 1]"))
      app.mockInput.pressEnter()
      await app.waitFor(() => submitted.length === 2)
      expect(submitted[1].parts).toEqual(submitted[0].parts)
    } finally {
      app.cleanup()
    }
  },
)

test("mini waits for image paste before submitting and drops a paste after editing the draft", async () => {
  const pending = Promise.withResolvers<ClipboardContent | undefined>()
  const submitted: RunPrompt[] = []
  let reads = 0
  const app = await renderFooter({
    clipboard: {
      read: () => {
        reads += 1
        return pending.promise
      },
    },
    onSubmit: (prompt) => {
      submitted.push(prompt)
      return true
    },
  })
  try {
    await app.renderOnce()
    await app.mockInput.typeText("inspect ")
    app.mockInput.pressKey("v", { ctrl: true })
    await app.waitFor(() => reads === 1)
    app.mockInput.pressEnter()
    expect(submitted).toHaveLength(0)
    pending.resolve({ mime: "image/png", data: Buffer.from(diffImageFixture).toString("base64") })
    await app.waitFor(() => submitted.length === 1)
    expect(submitted[0].text).toBe("inspect [Image 1] ")
    expect(submitted[0].parts).toHaveLength(1)
  } finally {
    app.cleanup()
  }

  const changed = Promise.withResolvers<ClipboardContent | undefined>()
  const cancelled: RunPrompt[] = []
  const next = await renderFooter({
    clipboard: { read: () => changed.promise },
    onSubmit: (prompt) => {
      cancelled.push(prompt)
      return true
    },
  })
  try {
    await next.renderOnce()
    await next.mockInput.typeText("old draft")
    next.mockInput.pressKey("v", { ctrl: true })
    await next.renderOnce()
    next.mockInput.pressEnter()
    next.mockInput.pressKey("c", { ctrl: true })
    await next.mockInput.typeText("changed draft")
    changed.resolve({ mime: "image/png", data: Buffer.from(diffImageFixture).toString("base64") })
    await next.flush()
    expect(cancelled).toEqual([])
    expect(next.renderer.currentFocusedEditor?.plainText).toBe("changed draft")
  } finally {
    next.cleanup()
  }
})

test("mini replaces selected text with a tracked image attachment", async () => {
  const sent = Promise.withResolvers<RunPrompt>()
  const app = await renderFooter({
    clipboard: { read: async () => ({ mime: "image/png", data: Buffer.from(diffImageFixture).toString("base64") }) },
    onSubmit: (prompt) => {
      sent.resolve(prompt)
      return true
    },
  })
  try {
    await app.renderOnce()
    await app.mockInput.typeText("replace me")
    app.renderer.currentFocusedEditor?.setSelection(0, 10)
    app.mockInput.pressKey("v", { ctrl: true })
    app.mockInput.pressEnter()
    const prompt = await sent.promise
    expect(prompt.text).toBe("[Image 1] ")
    expect(prompt.parts).toMatchObject([{ type: "file", source: { text: { start: 0, end: 9, value: "[Image 1]" } } }])
  } finally {
    app.cleanup()
  }
})

test("mini retains ordinary paste ANSI stripping and newline normalization", async () => {
  const sent = Promise.withResolvers<RunPrompt>()
  const app = await renderFooter({
    onSubmit: (prompt) => {
      sent.resolve(prompt)
      return true
    },
  })
  try {
    await app.renderOnce()
    await app.mockInput.pasteBracketedText("\x1b[31mred\x1b[0m\r\nplain")
    app.mockInput.pressEnter()
    expect((await sent.promise).text).toBe("red\nplain")
  } finally {
    app.cleanup()
  }
})

test("a failed clipboard read cancels a waiting submit without losing the draft", async () => {
  const pending = Promise.withResolvers<ClipboardContent | undefined>()
  const submitted: RunPrompt[] = []
  const statuses: string[] = []
  const app = await renderFooter({
    clipboard: { read: () => pending.promise },
    onStatus: (status) => statuses.push(status),
    onSubmit: (prompt) => {
      submitted.push(prompt)
      return true
    },
  })
  try {
    await app.renderOnce()
    await app.mockInput.typeText("inspect this")
    app.mockInput.pressKey("v", { ctrl: true })
    await app.renderOnce()
    app.mockInput.pressEnter()
    pending.reject(new Error("Clipboard unavailable"))
    await app.waitFor(() => statuses.length > 0)
    await app.flush()
    expect(submitted).toEqual([])
    expect(app.renderer.currentFocusedEditor?.plainText).toBe("inspect this")
    app.mockInput.pressEnter()
    await app.waitFor(() => submitted.length === 1)
  } finally {
    app.cleanup()
  }
})

test("mini attaches dropped image paths and removes attachments with their labels", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/one image.png`, diffImageFixture)
  await Bun.write(`${tmp.path}/two.png`, diffImageFixture)
  const submitted: RunPrompt[] = []
  const sent = Promise.withResolvers<void>()
  const app = await renderFooter({
    onSubmit: (prompt) => {
      submitted.push(prompt)
      sent.resolve()
      return true
    },
  })
  try {
    await app.renderOnce()
    await app.mockInput.typeText("\u4e2d\u6587 ")
    await app.mockInput.pasteBracketedText(`'${tmp.path}/one image.png' '${tmp.path}/two.png'`)
    app.mockInput.pressEnter()
    await sent.promise
    expect(submitted[0].text).toBe("\u4e2d\u6587 [Image 1] [Image 2] ")
    expect(submitted[0].parts).toMatchObject([
      { type: "file", filename: "one image.png", source: { text: { start: 5, end: 14, value: "[Image 1]" } } },
      { type: "file", filename: "two.png", source: { text: { start: 15, end: 24, value: "[Image 2]" } } },
    ])
    await app.waitFor(() => app.renderer.currentFocusedEditor?.plainText === "")
    app.mockInput.pressKey("ARROW_UP")
    await app.waitForFrame((frame) => frame.includes("[Image 2]"))
    app.renderer.currentFocusedEditor?.setText("no attachments")
    app.mockInput.pressEnter()
    await app.waitFor(() => submitted.length === 2)
    expect(submitted[1].parts).toEqual([])
  } finally {
    app.cleanup()
  }
})

test("mini preserves mentionless images through draft edits and a rejected submission", async () => {
  const part = {
    type: "file" as const,
    url: `data:image/png;base64,${Buffer.from(diffImageFixture).toString("base64")}`,
  }
  const submitted: RunPrompt[] = []
  const app = await renderFooter({
    history: [{ text: "", parts: [part] }],
    onSubmit: (prompt) => {
      submitted.push(prompt)
      return submitted.length > 1
    },
  })
  try {
    await app.renderOnce()
    app.mockInput.pressKey("ARROW_UP")
    await app.renderOnce()
    await app.mockInput.typeText("look")
    app.mockInput.pressEnter()
    await app.waitFor(() => submitted.length === 1)
    await app.waitFor(() => app.renderer.currentFocusedEditor?.plainText === "look")
    expect(submitted[0].parts).toEqual([part])
    app.mockInput.pressEnter()
    await app.waitFor(() => submitted.length === 2)
    expect(submitted[1].parts).toEqual([part])
  } finally {
    app.cleanup()
  }
})

test("direct footer leads with the active agent and default model", async () => {
  const app = await renderFooter({ state: { model: "Default model" } })
  try {
    await app.renderOnce()
    const frame = app.captureCharFrame()
    expect(
      frame
        .split("\n")
        .find((line) => line.includes("Default model"))
        ?.trimEnd(),
    ).toBe("Build · Default model · ctrl+p menu")
    expect(frame).not.toContain("BUILD")
  } finally {
    app.cleanup()
  }
})

test("direct footer describes commands and context and shows the model provider", async () => {
  const app = await renderFooter({
    providers: [provider()],
    currentModel: { providerID: "opencode", modelID: "gpt-5" },
    state: { first: true },
  })
  try {
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("┃ Ask anything, / for commands, @ for context…")
    expect(app.captureCharFrame()).toContain("Build · GPT-5 · opencode · ctrl+p menu")
  } finally {
    app.cleanup()
  }
})

test.each([56, 160])("exit confirmation replaces routine footer details at %i columns", async (width) => {
  const app = await renderFooter({
    width,
    currentAgent: "Build",
    providers: [provider()],
    currentModel: { providerID: "opencode", modelID: "gpt-5" },
    currentVariant: "high",
    state: { usage: { tokens: 12000, percent: 10 } },
    queuedPrompts: [{ messageID: "queued", prompt: { text: "later", parts: [] }, delivery: "queue" }],
  })
  try {
    await app.renderOnce()
    const initial = app.captureCharFrame()
    expect(initial).toContain("Build · GPT-5 [high] · 12.0K (10%)")
    expect(initial.includes("ctrl+p menu")).toBe(width === 160)
    app.setState((state) => ({ ...state, exit: 1 }))
    await app.renderOnce()
    const frame = app.captureCharFrame()
    expect(frame).toContain("Press ctrl+c again to exit")
    for (const text of ["Build", "GPT-5", "opencode", "high", "12.0K", "queued", "menu"])
      expect(frame).not.toContain(text)
    app.setState((state) => ({ ...state, exit: 0 }))
    await app.renderOnce()
    expect(app.captureCharFrame()).toBe(initial)
  } finally {
    app.cleanup()
  }
})

test("direct footer preserves a partial multi-field form draft across permission preemption", async () => {
  const request: FormInfo = {
    id: "frm_preempted",
    sessionID: "ses_child",
    title: "Deployment",
    fields: [
      { key: "service", type: "string", title: "Service", required: true },
      { key: "notes", type: "string", title: "Notes", required: true },
    ],
  }
  const app = await renderFooter({
    height: 16,
    view: { type: "form", request },
  })

  try {
    await app.renderOnce()
    "api".split("").forEach((key) => app.mockInput.pressKey(key))
    app.mockInput.pressEnter()
    await app.renderOnce()
    "keep this draft".split("").forEach((key) => app.mockInput.pressKey(key))
    expect(app.renderer.currentFocusedEditor?.plainText).toBe("keep this draft")

    app.setView({
      type: "permission",
      request: {
        id: "per_preempting",
        sessionID: "ses_child",
        action: "read",
        resources: ["src/index.ts"],
      },
    })
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("Permission required")

    app.setView({ type: "form", request })
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("2/2")
    expect(app.renderer.currentFocusedEditor?.plainText).toBe("keep this draft")

    app.setView({ type: "prompt" })
    await app.renderOnce()
    app.setView({ type: "form", request })
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("1/2")
    expect(app.renderer.currentFocusedEditor?.plainText).toBe("")
  } finally {
    app.cleanup()
  }
})

function expectPaletteList(list: BoxRenderable, selectedIndex: number) {
  expect(list.backgroundColor.toInts()).toEqual((RUN_THEME_FALLBACK.footer.shade as RGBA).toInts())
  expect((list.getChildren()[selectedIndex] as BoxRenderable).backgroundColor.toInts()).toEqual(
    (RUN_THEME_FALLBACK.footer.actionFocusedBg as RGBA).toInts(),
  )
}

function child(root: BoxRenderable | RootRenderable, index: number) {
  return root.getChildren()[index] as BoxRenderable
}

function boxPath(root: BoxRenderable | RootRenderable, name: string): BoxRenderable[] | undefined {
  for (const item of root.getChildren()) {
    if (item.constructor.name === name) return root instanceof BoxRenderable ? [root] : []
    if (!(item instanceof BoxRenderable)) continue
    const path = boxPath(item, name)
    if (path) return root instanceof BoxRenderable ? [root, ...path] : path
  }
}

function footerComposerFrame(root: BoxRenderable | RootRenderable) {
  return boxPath(root, "TextareaRenderable")!.at(-5)!
}

function footerStatusline(root: BoxRenderable | RootRenderable) {
  return root.findDescendantById("mini-statusline") as BoxRenderable
}

function panelMenu(root: BoxRenderable | RootRenderable) {
  const content = boxPath(root, "InputRenderable")!.at(-2)!
  return child(content.getChildren().at(-1) as BoxRenderable, 0)
}

test("direct footer composer area does not adopt footer surface", async () => {
  const surface = RGBA.fromHex("#123456")
  const [theme, setTheme] = createSignal(RUN_THEME_FALLBACK)
  const app = await renderFooter({ theme })

  try {
    await app.renderOnce()
    const area = child(footerComposerFrame(app.renderer.root), 0)

    expect(area.backgroundColor.toInts()).not.toEqual(surface.toInts())
    setTheme({
      ...RUN_THEME_FALLBACK,
      footer: {
        ...RUN_THEME_FALLBACK.footer,
        surface,
      },
    })
    await app.renderOnce()

    expect(area.backgroundColor.toInts()).not.toEqual(surface.toInts())
  } finally {
    app.cleanup()
  }
})

test("run entry content updates when live commit text changes", async () => {
  const [commit, setCommit] = createSignal<StreamCommit>({
    kind: "tool",
    text: "I",
    phase: "progress",
    source: "tool",
    messageID: "msg-1",
    partID: "part-1",
    tool: "shell",
  })

  const app = await testRender(
    () => (
      <box width={80} height={4}>
        <RunEntryContent commit={commit()} theme={RUN_THEME_FALLBACK} />
      </box>
    ),
    {
      width: 80,
      height: 4,
    },
  )

  try {
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("I")

    setCommit({
      kind: "tool",
      text: "I need to inspect the codebase",
      phase: "progress",
      source: "tool",
      messageID: "msg-1",
      partID: "part-1",
      tool: "shell",
    })
    await app.renderOnce()

    expect(app.captureCharFrame()).toContain("I need to inspect the codebase")
  } finally {
    app.renderer.destroy()
  }
})

test("run entry content preserves monochrome markdown grammar", async () => {
  const [commit, setCommit] = createSignal<StreamCommit>({
    kind: "assistant",
    text: "• literal\n\n———\n\narrow →",
    phase: "progress",
    source: "assistant",
    messageID: "msg-1",
    partID: "part-1",
  })
  const app = await testRender(
    () => (
      <box width={60} height={8}>
        <RunEntryContent commit={commit()} theme={RUN_THEME_FALLBACK} opts={{ mono: true }} />
      </box>
    ),
    { width: 60, height: 8 },
  )

  try {
    await app.renderOnce()
    const rows = app
      .captureCharFrame()
      .split("\n")
      .map((row) => row.trimEnd())
    expect(rows).toContain("* literal")
    expect(rows).toContain("------")
    expect(rows).toContain("arrow ->")
    expect(rows.join("\n")).not.toMatch(/[^\x00-\x7f]/)

    setCommit({ ...commit(), text: "- Café\n- arrow →\n- third …" })
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("- arrow ->")
    expect(app.captureCharFrame()).toContain("- third ...")

    setCommit({ ...commit(), text: "| A | B |\n| - | - |\n| Café | → |" })
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("Caf?")
    expect(app.captureCharFrame()).toContain("->")
    setCommit({ ...commit(), text: "| A | B |\n| - | - |\n| Café | … |" })
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("...")

    setCommit({ ...commit(), text: "```\nCafé → …\n```" })
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("Caf? -> ...")
    expect(app.captureCharFrame()).not.toMatch(/[^\x00-\x7f]/)
  } finally {
    app.renderer.destroy()
  }
})

test("run entry content toggles unchanged live markdown between color and monochrome", async () => {
  const [mono, setMono] = createSignal(false)
  const commit: StreamCommit = {
    kind: "assistant",
    text: "Active Café → …",
    phase: "progress",
    source: "assistant",
    messageID: "msg-1",
    partID: "part-1",
  }
  const app = await testRender(
    () => (
      <box width={60} height={4}>
        <RunEntryContent commit={commit} theme={RUN_THEME_FALLBACK} opts={{ mono: mono() }} />
      </box>
    ),
    { width: 60, height: 4 },
  )

  try {
    await app.renderOnce()
    const color = app.captureCharFrame()
    expect(color).toContain("Active Café → …")

    setMono(true)
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("Active Caf? -> ...")
    expect(app.captureCharFrame()).not.toMatch(/[^\x00-\x7f]/)

    setMono(false)
    await app.renderOnce()
    expect(app.captureCharFrame()).toBe(color)
  } finally {
    app.renderer.destroy()
  }
})

test("run entry content eagerly renders final monochrome markdown", async () => {
  const app = await testRender(
    () => (
      <box width={60} height={6}>
        <RunEntryContent
          commit={{ kind: "tool", text: "", phase: "final", source: "tool", tool: "subagent" }}
          body={{ type: "markdown", content: "# Café →\n\n```markdown\nCafé →\n```" }}
          theme={RUN_THEME_FALLBACK}
          opts={{ mono: true }}
        />
      </box>
    ),
    { width: 60, height: 6 },
  )

  try {
    await app.renderOnce()
    const frame = app.captureCharFrame()
    expect(frame).toContain("# Caf? ->")
    expect(frame).toContain("Caf? ->")
    expect(frame).not.toMatch(/[^\x00-\x7f]/)
  } finally {
    app.renderer.destroy()
  }
})

test("direct command panel renders grouped actions without catalog commands", async () => {
  const [commands] = createSignal<RunCommand[] | undefined>([
    command({ name: "review", description: "Review code" }),
    command({ name: "deploy", description: "Deploy prompt", source: "mcp" }),
    command({ name: "internal", description: "Skill command", source: "skill" }),
  ])
  const [subagents] = createSignal([])
  const [variants] = createSignal(["high", "minimal"])
  let status = 0

  const app = await testRender(
    () => (
      <box width={100} height={RUN_COMMAND_PANEL_ROWS}>
        <RunCommandMenuBody
          theme={() => RUN_THEME_FALLBACK.footer}
          commands={commands}
          subagents={subagents}
          queued={() => []}
          variants={variants}
          variantCycle="ctrl+t"
          onClose={() => {}}
          onAgent={() => {}}
          onModel={() => {}}
          onEditor={() => {}}
          onSkill={() => {}}
          onSubagent={() => {}}
          onQueued={() => {}}
          onVariant={() => {}}
          onVariantCycle={() => {}}
          onStatus={() => status++}
          onSettings={() => {}}
          onCommand={() => {}}
          onNew={() => {}}
          onExit={() => {}}
        />
      </box>
    ),
    {
      width: 100,
      height: RUN_COMMAND_PANEL_ROWS + 1,
    },
  )

  try {
    await app.renderOnce()
    const frame = app.captureCharFrame()

    expect(frame).toContain("Commands")
    expect(frame).toMatch(/^ {2}Commands/m)
    expect(frame).toContain("Search")
    expect(frame).toContain("Session")
    expect(frame).toContain("Agent")
    expect(frame).toContain("Prompt")
    expect(frame).toContain("Open editor")
    expect(frame).toContain("/editor")
    expect(frame).toContain("Show status")
    expect(frame).toContain("Compact session")
    expect(frame).toContain("/compact")
    expect(frame).toContain("Skills")
    expect(frame).toContain("/skills")
    expect(frame.match(/\bAgent\b/g)?.length).toBe(1)
    expect(frame).not.toContain("┌")
    expect(frame).not.toContain("┃")
    expect(frame).not.toContain("/internal")
    expect(frame).not.toContain("Choose model for future turns")
    expect(frame).not.toContain("Cycle reasoning effort for future turns")
    expect(frame).not.toContain("Review code")
    expect(frame).not.toContain("Commands 8")

    await app.mockInput.typeText("agent")
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("Switch agent")

    app.mockInput.pressKey("u", { ctrl: true })
    await app.mockInput.typeText("review")
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("No results found")

    app.mockInput.pressKey("u", { ctrl: true })
    await app.mockInput.typeText("deploy")
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("No results found")

    app.mockInput.pressKey("u", { ctrl: true })
    await app.mockInput.typeText("status")
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("Show status")
    app.mockInput.pressEnter()
    expect(status).toBe(1)
  } finally {
    app.renderer.destroy()
  }
})

test.each([false, true])("settings change preferences and preview the work spinner (mono=%s)", async (mono) => {
  const [settings, setSettings] = createSignal(resolveMiniSettings())
  const [animations, setAnimations] = createSignal(true)
  const app = await testRender(
    () => (
      <box width="100%" height="100%">
        <RunSettingsBody
          theme={() => RUN_THEME_FALLBACK.footer}
          settings={settings}
          onClose={() => {}}
          onChange={(change) => {
            setSettings((current) => applyMiniSettingChange(current, change))
          }}
          mono={mono}
          animations={animations()}
        />
      </box>
    ),
    { width: 100, height: RUN_COMMAND_PANEL_ROWS },
  )

  try {
    await app.renderOnce()
    const frame = app.captureCharFrame()
    expect(frame).toContain("Settings")
    expect(frame).toMatch(/^ +Settings/m)
    expect(frame).toContain("Verbosity")
    expect(frame).toContain("Thinking")
    expect(frame).toContain("Tools")
    expect(frame).toContain("Shell")
    expect(frame).toContain("Turn summary")
    expect(frame).toContain("Footer details")
    expect(frame).toContain("Splash")
    expect(frame).toContain("Monochrome UI")
    expect(frame).toContain("left/right change")
    if (mono) expect(frame).not.toMatch(/[^\x00-\x7F]/)

    app.mockInput.pressKey("ARROW_RIGHT")
    await app.renderOnce()
    expect(settings()).toEqual(applyMiniSettingChange(resolveMiniSettings(), { key: "verbosity", value: "everything" }))

    app.mockInput.pressKey("ARROW_LEFT")
    await app.renderOnce()
    expect(settings()).toEqual(resolveMiniSettings())

    app.mockInput.pressKey("ARROW_LEFT")
    await app.renderOnce()
    expect(settings()).toEqual(applyMiniSettingChange(resolveMiniSettings(), { key: "verbosity", value: "quiet" }))

    app.mockInput.pressKey("ARROW_LEFT")
    await app.renderOnce()
    expect(settings()).toEqual(applyMiniSettingChange(resolveMiniSettings(), { key: "verbosity", value: "quiet" }))

    app.mockInput.pressKey("ARROW_RIGHT")
    await app.renderOnce()
    expect(settings()).toEqual(resolveMiniSettings())

    app.mockInput.pressKey("ARROW_DOWN")
    app.mockInput.pressKey("ARROW_RIGHT")
    await app.renderOnce()

    expect(settings()).toEqual({
      ...resolveMiniSettings(),
      thinking: "hide",
    })
    expect(app.captureCharFrame()).toContain("Custom")

    app.mockInput.pressKey("ARROW_DOWN")
    app.mockInput.pressKey("ARROW_DOWN")
    app.mockInput.pressKey("ARROW_DOWN")
    app.mockInput.pressKey("ARROW_RIGHT")
    await app.renderOnce()

    expect(settings()).toEqual({
      ...resolveMiniSettings(),
      thinking: "hide",
      turn_summary: "hide",
    })

    app.mockInput.pressKey("ARROW_DOWN")
    app.mockInput.pressKey("ARROW_DOWN")
    app.mockInput.pressKey("ARROW_RIGHT")
    await app.renderOnce()
    expect(settings().splash).toBe("hide")

    app.mockInput.pressKey("ARROW_DOWN")
    app.mockInput.pressKey("ARROW_RIGHT")
    await app.renderOnce()
    expect(settings().mono).toBe(true)
    await app.mockInput.typeText("spinner")
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("soft slide")
    for (const [key, value] of [
      ["ARROW_RIGHT", "block-soft-sweep"],
      ["ARROW_LEFT", "block-soft-slide"],
      ["ARROW_LEFT", "seed"],
      ["ARROW_RIGHT", "block-soft-slide"],
      ["ARROW_RIGHT", "block-soft-sweep"],
      ["ARROW_RIGHT", "block-low-comet"],
      ["ARROW_RIGHT", "block-low-duet"],
    ] as const) {
      app.mockInput.pressKey(key)
      await app.renderOnce()
      expect(settings().work_spinner).toBe(value)
      const row = app
        .captureCharFrame()
        .split("\n")
        .find((line) => line.includes("Work"))!
      expect((mono ? SEED_MONO : WORK_SPINNERS[value]).frames).toContain(Array.from(row.trimStart())[0]!)
    }
    setSettings((current) => ({ ...current, work_spinner: "quadrant-orbit" }))
    app.resize(24, 8)
    await app.renderOnce()
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("quadrant orbit")
    setAnimations(false)
    await app.renderOnce()
    const row = app
      .captureCharFrame()
      .split("\n")
      .find((line) => line.includes("quadrant orbit"))!
    expect(row.trimStart()).toStartWith(mono ? "* " : "\u25aa ")
    await app.renderer.idle()
  } finally {
    app.renderer.destroy()
  }
})

test("direct skill panel renders searchable skill list", async () => {
  const [commands] = createSignal<RunCommand[] | undefined>([
    command({ name: "review", description: "Review code" }),
    command({ name: "internal", description: "Skill command", source: "skill" }),
    command({ name: "formatter", description: "Apply formatter fixes", source: "skill" }),
  ])
  const selected: string[] = []

  const app = await testRender(
    () => (
      <box width={100} height={RUN_COMMAND_PANEL_ROWS}>
        <RunSkillSelectBody
          theme={() => RUN_THEME_FALLBACK.footer}
          commands={commands}
          onClose={() => {}}
          onSelect={(name) => {
            selected.push(name)
          }}
        />
      </box>
    ),
    {
      width: 100,
      height: RUN_COMMAND_PANEL_ROWS,
    },
  )

  try {
    await app.renderOnce()
    const frame = app.captureCharFrame()

    expect(frame).toContain("Skills")
    expect(frame).toContain("Search")
    expect(frame).toContain("internal")
    expect(frame).not.toContain("/internal")
    expect(frame).toContain("formatter")
    expect(frame).toContain("Apply formatter fixes")
    expect(frame).not.toContain("review")
    await app.mockInput.typeText("format")
    await app.renderOnce()
    expect(app.captureCharFrame()).not.toContain("internal")
    app.mockInput.pressEnter()
    expect(selected).toEqual(["formatter"])
  } finally {
    app.renderer.destroy()
  }
})

test("direct skill panel truncates long descriptions from the end", async () => {
  const [commands] = createSignal<RunCommand[] | undefined>([
    command({
      name: "terminal-control",
      description:
        "Control and test terminal applications, REPLs, interactive CLIs, shell processes, OpenTUI applications, or other terminal-backed workflows.",
      source: "skill",
    }),
  ])

  const app = await testRender(
    () => (
      <box width={100} height={RUN_COMMAND_PANEL_ROWS}>
        <RunSkillSelectBody
          theme={() => RUN_THEME_FALLBACK.footer}
          commands={commands}
          onClose={() => {}}
          onSelect={() => {}}
        />
      </box>
    ),
    {
      width: 100,
      height: RUN_COMMAND_PANEL_ROWS,
    },
  )

  try {
    await app.renderOnce()
    const frame = app.captureCharFrame()

    expect(frame).toContain("terminal-control")
    expect(frame).toContain("Control and test terminal applications")
    expect(frame).not.toMatch(/application(?:…|\.\.\.)ocess/)
  } finally {
    app.renderer.destroy()
  }
})

test("direct command panel shows subagent entry when available", async () => {
  const [commands] = createSignal<RunCommand[] | undefined>([])
  const [subagents] = createSignal([subagent({ sessionID: "s-1", label: "Explore", description: "Inspect auth flow" })])
  const [variants] = createSignal<string[]>([])

  const app = await testRender(
    () => (
      <box width={100} height={RUN_COMMAND_PANEL_ROWS}>
        <RunCommandMenuBody
          theme={() => RUN_THEME_FALLBACK.footer}
          commands={commands}
          subagents={subagents}
          queued={() => []}
          variants={variants}
          variantCycle="ctrl+t"
          onClose={() => {}}
          onAgent={() => {}}
          onModel={() => {}}
          onEditor={() => {}}
          onSkill={() => {}}
          onSubagent={() => {}}
          onQueued={() => {}}
          onVariant={() => {}}
          onVariantCycle={() => {}}
          onStatus={() => {}}
          onSettings={() => {}}
          onCommand={() => {}}
          onNew={() => {}}
          onExit={() => {}}
        />
      </box>
    ),
    {
      width: 100,
      height: RUN_COMMAND_PANEL_ROWS,
    },
  )

  try {
    await app.renderOnce()
    const frame = app.captureCharFrame()

    expect(frame).toContain("View subagents")
    expect(frame).toContain("1 active")
  } finally {
    app.renderer.destroy()
  }
})

test("direct command panel keeps completed subagents available", async () => {
  const [commands] = createSignal<RunCommand[] | undefined>([])
  const [subagents] = createSignal([
    subagent({ sessionID: "s-1", label: "Explore", description: "Inspect auth flow", status: "completed" }),
  ])
  const [variants] = createSignal<string[]>([])

  const app = await testRender(
    () => (
      <box width={100} height={RUN_COMMAND_PANEL_ROWS}>
        <RunCommandMenuBody
          theme={() => RUN_THEME_FALLBACK.footer}
          commands={commands}
          subagents={subagents}
          queued={() => []}
          variants={variants}
          variantCycle="ctrl+t"
          onClose={() => {}}
          onAgent={() => {}}
          onModel={() => {}}
          onEditor={() => {}}
          onSkill={() => {}}
          onSubagent={() => {}}
          onQueued={() => {}}
          onVariant={() => {}}
          onVariantCycle={() => {}}
          onStatus={() => {}}
          onSettings={() => {}}
          onCommand={() => {}}
          onNew={() => {}}
          onExit={() => {}}
        />
      </box>
    ),
    {
      width: 100,
      height: RUN_COMMAND_PANEL_ROWS,
    },
  )

  try {
    await app.renderOnce()
    const frame = app.captureCharFrame()

    expect(frame).toContain("View subagents")
    expect(frame).toContain("1 recent")
  } finally {
    app.renderer.destroy()
  }
})

test("direct subagent panel toggles between active and inactive subagents", async () => {
  const [tabs] = createSignal([
    subagent({ sessionID: "s-1", label: "Explore", description: "Inspect auth flow" }),
    subagent({ sessionID: "s-2", label: "General", description: "Write migration plan", status: "completed" }),
  ])
  const [current] = createSignal<string | undefined>("s-1")
  let rows = 0

  const app = await testRender(
    () => (
      <box width={100} height={RUN_SUBAGENT_PANEL_ROWS}>
        <RunSubagentSelectBody
          theme={() => RUN_THEME_FALLBACK.footer}
          tabs={tabs}
          current={current}
          onClose={() => {}}
          onSelect={() => {}}
          onRows={(value) => {
            rows = value
          }}
        />
      </box>
    ),
    {
      width: 100,
      height: RUN_SUBAGENT_PANEL_ROWS + 1,
    },
  )

  try {
    await app.renderOnce()
    const frame = app.captureCharFrame()
    const list = panelMenu(app.renderer.root)

    expect(frame).toContain("Select subagent")
    expect(frame).toContain("Inspect auth flow")
    expect(frame).not.toContain("Write migration plan")
    expect(frame).not.toContain("done")
    expect(frame).toContain("tab show inactive")
    expect(frame).not.toContain("┌")
    expect(frame).not.toContain("┃")
    expectPaletteList(list, 0)
    expect(rows).toBe(7)

    app.mockInput.pressKey("TAB")
    await app.renderOnce()
    const inactive = app.captureCharFrame()

    expect(inactive).not.toContain("Inspect auth flow")
    expect(inactive).toContain("Write migration plan")
    expect(inactive).toContain("done")
    expect(inactive).toContain("tab show active")
  } finally {
    app.renderer.destroy()
  }
})

test("direct subagent panel closes when moving up from the first item", async () => {
  const [tabs] = createSignal([
    subagent({ sessionID: "s-1", label: "Explore", description: "Inspect auth flow" }),
    subagent({ sessionID: "s-2", label: "General", description: "Write migration plan" }),
  ])
  const [current] = createSignal<string | undefined>()
  let closed = 0

  const app = await testRender(
    () => (
      <box width={100} height={RUN_SUBAGENT_PANEL_ROWS}>
        <RunSubagentSelectBody
          theme={() => RUN_THEME_FALLBACK.footer}
          tabs={tabs}
          current={current}
          onClose={() => closed++}
          onSelect={() => {}}
        />
      </box>
    ),
    { width: 100, height: RUN_SUBAGENT_PANEL_ROWS },
  )

  try {
    await app.renderOnce()
    app.mockInput.pressKey("ARROW_DOWN")
    app.mockInput.pressKey("ARROW_UP")
    expect(closed).toBe(0)

    app.mockInput.pressKey("ARROW_UP")
    expect(closed).toBe(1)
  } finally {
    app.renderer.destroy()
  }
})

test.each(["queue", "steer"] as const)("direct footer toggles and deletes pending %s prompts", async (delivery) => {
  const actions: string[] = []
  const app = await renderFooter({
    height: RUN_SUBAGENT_PANEL_ROWS,
    state: { phase: "running" },
    queuedPrompts: [{ messageID: "m-1", prompt: { text: "follow up", parts: [] }, delivery }],
    onQueuedPromptAction: async (action, inboxID) => {
      actions.push(`${action}:${inboxID}`)
      app.setQueuedPrompts((prompts) =>
        action === "cancel" ? [] : prompts.map((prompt) => ({ ...prompt, delivery: action })),
      )
    },
  })

  try {
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("ctrl+x q 1 pending")
    app.mockInput.pressKey("ARROW_DOWN")
    await app.renderOnce()
    expect(app.captureCharFrame()).not.toContain("Pending prompts")

    app.mockInput.pressKey("x", { ctrl: true })
    app.mockInput.pressKey("q")
    await app.renderOnce()
    const frame = app.captureCharFrame()
    const list = panelMenu(app.renderer.root)
    expect(frame).toContain("Pending prompts")
    expect(frame).toContain("follow up")
    expect(frame).toContain(delivery === "queue" ? "queued" : "steering")
    expect(frame).toContain(`enter ${delivery === "queue" ? "steer" : "queue"} · ctrl+d delete`)
    expect(frame).not.toContain("┌")
    expect(frame).not.toContain("┃")
    expectPaletteList(list, 0)
    app.mockInput.pressEnter()
    await Bun.sleep(0)
    await app.renderOnce()
    expect(actions).toEqual([`${delivery === "queue" ? "steer" : "queue"}:m-1`])
    expect(app.captureCharFrame()).toContain("1 pending")

    app.mockInput.pressKey("x", { ctrl: true })
    app.mockInput.pressKey("q")
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain(delivery === "queue" ? "steering" : "queued")
    expect(app.captureCharFrame()).toContain(delivery === "queue" ? "enter queue" : "enter steer")
    app.mockInput.pressKey("d", { ctrl: true })
    await Bun.sleep(0)
    await app.renderOnce()
    expect(actions.at(-1)).toBe("cancel:m-1")
    expect(app.captureCharFrame()).not.toContain("Pending prompts")
    expect(app.captureCharFrame()).not.toContain("1 pending")
  } finally {
    app.cleanup()
  }
})

test("direct footer steers the oldest queued prompt from an empty composer", async () => {
  const steered: string[] = []
  const app = await renderFooter({
    queuedPrompts: [
      { messageID: "m-steering", prompt: { text: "already steering", parts: [] }, delivery: "steer" },
      { messageID: "m-1", prompt: { text: "first", parts: [] }, delivery: "queue" },
      { messageID: "m-2", prompt: { text: "second", parts: [] }, delivery: "queue" },
    ],
    onQueuedPromptAction: async (action, inboxID) => {
      if (action === "steer") steered.push(inboxID)
    },
  })

  try {
    await app.renderOnce()
    app.mockInput.pressKey("x", { ctrl: true })
    app.mockInput.pressEnter()
    await Bun.sleep(0)
    expect(steered).toEqual([])
    app.mockInput.pressEnter()
    await Bun.sleep(0)
    expect(steered).toEqual(["m-1"])
    app.setQueuedPrompts((prompts) => prompts.filter((prompt) => prompt.delivery === "steer"))
    app.mockInput.pressEnter()
    await Bun.sleep(0)
    expect(steered).toEqual(["m-1"])
  } finally {
    app.cleanup()
  }
})

test("direct footer preserves steer and queue submission shortcuts while busy", async () => {
  const submitted: RunPrompt[] = []
  const app = await renderFooter({
    state: { phase: "running" },
    onSubmit: (prompt) => {
      submitted.push(prompt)
      return true
    },
  })

  try {
    await app.renderOnce()
    await app.mockInput.typeText("steer now")
    app.mockInput.pressEnter()
    await Bun.sleep(0)
    await app.mockInput.typeText("queue later")
    app.mockInput.pressKey("x", { ctrl: true })
    app.mockInput.pressEnter()
    await Bun.sleep(0)
    expect(submitted).toEqual([
      { text: "steer now", parts: [], delivery: "steer" },
      { text: "queue later", parts: [], delivery: "queue" },
    ])
  } finally {
    app.cleanup()
  }
})

test("direct footer does not steer queued work on a double submit", async () => {
  const submitted: RunPrompt[] = []
  const steered: string[] = []
  const app = await renderFooter({
    queuedPrompts: [{ messageID: "m-1", prompt: { text: "queued", parts: [] }, delivery: "queue" }],
    onSubmit: async (prompt) => {
      submitted.push(prompt)
      await Bun.sleep(10)
      return true
    },
    onQueuedPromptAction: async (action, inboxID) => {
      if (action === "steer") steered.push(inboxID)
    },
  })

  try {
    await app.renderOnce()
    await app.mockInput.typeText("send once")
    app.mockInput.pressEnter()
    app.mockInput.pressEnter()
    await Bun.sleep(20)
    expect(submitted).toHaveLength(1)
    expect(steered).toEqual([])
  } finally {
    app.cleanup()
  }
})

test("direct footer rejects local commands submitted with the queue shortcut", async () => {
  const submitted: RunPrompt[] = []
  const statuses: string[] = []
  const app = await renderFooter({
    onSubmit: (prompt) => {
      submitted.push(prompt)
      return true
    },
    onStatus: (status) => statuses.push(status),
  })

  try {
    await app.renderOnce()
    await app.mockInput.typeText("/settings ")
    app.mockInput.pressKey("x", { ctrl: true })
    app.mockInput.pressEnter()
    await Bun.sleep(0)
    expect(submitted).toEqual([])
    expect(statuses).toContain("this prompt cannot be queued")
  } finally {
    app.cleanup()
  }
})

// OpenTUI currently crashes Bun in the full `test/cli/run` directory run here.
// Re-enable after the upstream OpenTUI fix lands in this repo.
test.skip("direct footer recreates the frame across command panel transitions", async () => {
  const app = await renderFooter()

  try {
    await app.renderOnce()

    for (let index = 0; index < 3; index++) {
      const composerFrame = footerComposerFrame(app.renderer.root)
      app.mockInput.pressKey("p", { ctrl: true })
      await app.renderOnce()

      expect(app.captureCharFrame()).toContain("Commands")
      expect(footerComposerFrame(app.renderer.root)).not.toBe(composerFrame)
      app.mockInput.pressKey("c", { ctrl: true })
      await app.renderOnce()
      expect(app.captureCharFrame()).not.toContain("Commands")
      expect(app.captureCharFrame()).not.toContain("┃")
      expect(app.captureCharFrame()).not.toContain("█")
    }
  } finally {
    app.cleanup()
  }
})

test.skip("direct footer dispatches leader variant binding only when leader is registered", async () => {
  const calls: string[] = []
  const app = await renderFooter({
    tuiConfig: createTuiResolvedConfig({ keybinds: { leader: "ctrl+x", "variant.cycle": "<leader>t" } }),
    onCycle: () => calls.push("cycle"),
  })

  try {
    await app.renderOnce()
    app.mockInput.pressKey("t")
    expect(calls).toEqual([])

    app.mockInput.pressKey("x", { ctrl: true })
    app.mockInput.pressKey("t")
    expect(calls).toEqual(["cycle"])
  } finally {
    app.cleanup()
  }
})

test("direct footer keeps leader variant binding inactive when leader is disabled", async () => {
  const calls: string[] = []
  const app = await renderFooter({
    tuiConfig: createTuiResolvedConfig({ keybinds: { leader: "none", "variant.cycle": "<leader>t" } }),
    onCycle: () => calls.push("cycle"),
  })

  try {
    await app.renderOnce()
    app.mockInput.pressKey("t")
    app.mockInput.pressKey("x", { ctrl: true })
    app.mockInput.pressKey("t")

    expect(calls).toEqual([])
  } finally {
    app.cleanup()
  }
})

test("direct footer submits slash autocomplete selections without dispatching shell completions", async () => {
  const submits: RunPrompt[] = []
  const app = await renderFooter({
    commands: [command({ name: "review", description: "Review code" })],
    onSubmit(prompt) {
      submits.push(prompt)
      return true
    },
  })

  try {
    await app.renderOnce()
    "/rev".split("").forEach((key) => app.mockInput.pressKey(key))
    await app.renderOnce()
    app.mockInput.pressEnter()
    await app.renderOnce()

    "/rev".split("").forEach((key) => app.mockInput.pressKey(key))
    await app.renderOnce()
    app.mockInput.pressKey("TAB")
    await app.renderOnce()

    "/re branch".split("").forEach((key) => app.mockInput.pressKey(key))
    Array.from({ length: 7 }).forEach(() => app.mockInput.pressKey("ARROW_LEFT"))
    app.mockInput.pressKey("v")
    await app.renderOnce()
    app.mockInput.pressEnter()
    await app.renderOnce()

    "/nx".split("").forEach((key) => app.mockInput.pressKey(key))
    app.mockInput.pressKey("ARROW_LEFT")
    app.mockInput.pressKey("e")
    await app.renderOnce()
    app.mockInput.pressEnter()
    await app.renderOnce()

    "/n scratch".split("").forEach((key) => app.mockInput.pressKey(key))
    Array.from({ length: 8 }).forEach(() => app.mockInput.pressKey("ARROW_LEFT"))
    app.mockInput.pressKey("e")
    await app.renderOnce()
    app.mockInput.pressEnter()
    await app.renderOnce()

    app.mockInput.pressKey("!")
    "/settings".split("").forEach((key) => app.mockInput.pressKey(key))
    await app.renderOnce()
    app.mockInput.pressEnter()
    await app.renderOnce()

    expect(submits).toEqual([
      { text: "/review ", parts: [], command: { name: "review", arguments: "" }, delivery: "steer" },
      { text: "/review ", parts: [], command: { name: "review", arguments: "" }, delivery: "steer" },
      { text: "/review branch", parts: [], command: { name: "review", arguments: "branch" }, delivery: "steer" },
      { text: "/new ", parts: [], delivery: "steer" },
      { text: "/new ", parts: [], delivery: "steer" },
    ])
    expect(app.renderer.currentFocusedEditor?.plainText).toBe("/settings ")
  } finally {
    app.cleanup()
  }
})

test("direct footer slash autocomplete keeps a real skills command", async () => {
  const submits: RunPrompt[] = []
  const app = await renderFooter({
    commands: [
      command({ name: "skills", description: "Run the real skills command" }),
      command({ name: "formatter", description: "Apply formatter fixes", source: "skill" }),
    ],
    onSubmit(prompt) {
      submits.push(prompt)
      return true
    },
  })

  try {
    await app.renderOnce()
    "/skills".split("").forEach((key) => app.mockInput.pressKey(key))
    await app.renderOnce()
    app.mockInput.pressEnter()
    await app.renderOnce()

    expect(submits).toEqual([
      { text: "/skills ", parts: [], command: { name: "skills", arguments: "" }, delivery: "steer" },
    ])
    expect(app.captureCharFrame()).not.toContain("Apply formatter fixes")
  } finally {
    app.cleanup()
  }
})

test("direct footer closes settings with ctrl-c instead of arming exit", async () => {
  const app = await renderFooter({ height: 20 })

  try {
    await app.renderOnce()
    "/settings".split("").forEach((key) => app.mockInput.pressKey(key))
    await app.renderOnce()
    app.mockInput.pressEnter()
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("Shell")

    app.mockInput.pressKey("c", { ctrl: true })
    await app.renderOnce()
    expect(app.captureCharFrame()).not.toContain("Shell")
    expect(app.renderer.currentFocusedEditor?.plainText).toBe("")
  } finally {
    app.cleanup()
  }
})

test("selectedCommand validates the bound command and refreshes its arguments", () => {
  expect(selectedCommand("/opencode-ts", { name: "opencode-ts", arguments: "", source: "skill" })).toEqual({
    name: "opencode-ts",
    arguments: "",
    source: "skill",
  })
  expect(selectedCommand("/deploy prod", { name: "deploy", arguments: "" })).toEqual({
    name: "deploy",
    arguments: "prod",
  })
  expect(selectedCommand("/other", { name: "deploy", arguments: "" })).toBeUndefined()
})

test("direct footer tags skill slash submissions with their catalog source", async () => {
  const submits: RunPrompt[] = []
  const app = await renderFooter({
    commands: [command({ name: "formatter", description: "Apply formatter fixes", source: "skill" })],
    onSubmit(prompt) {
      submits.push(prompt)
      return true
    },
  })

  try {
    await app.renderOnce()
    "/formatter src".split("").forEach((key) => app.mockInput.pressKey(key))
    await app.renderOnce()
    app.mockInput.pressEnter()
    await app.renderOnce()

    expect(submits).toEqual([
      {
        text: "/formatter src",
        parts: [],
        command: { name: "formatter", arguments: "src", source: "skill" },
        delivery: "steer",
      },
    ])
  } finally {
    app.cleanup()
  }
})

test("direct footer submits a selected leading skill as a prompt attachment", async () => {
  const submits: RunPrompt[] = []
  const app = await renderFooter({
    commands: [command({ name: "formatter", description: "Apply formatter fixes", source: "skill" })],
    onSubmit(prompt) {
      submits.push(prompt)
      return true
    },
  })

  try {
    await app.renderOnce()
    "/forma".split("").forEach((key) => app.mockInput.pressKey(key))
    await app.renderOnce()
    app.mockInput.pressEnter()
    await app.renderOnce()
    "src".split("").forEach((key) => app.mockInput.pressKey(key))
    app.mockInput.pressEnter()
    await app.renderOnce()

    expect(submits).toEqual([
      {
        text: "/formatter src",
        parts: [
          {
            type: "skill",
            id: "formatter",
            source: { start: 0, end: 10, value: "/formatter" },
          },
        ],
        delivery: "steer",
      },
    ])
  } finally {
    app.cleanup()
  }
})

test("direct footer preserves a selected skill after wide text", async () => {
  const submits: RunPrompt[] = []
  const app = await renderFooter({
    commands: [command({ name: "formatter", description: "Apply formatter fixes", source: "skill" })],
    onSubmit(prompt) {
      submits.push(prompt)
      return true
    },
  })

  try {
    await app.renderOnce()
    "中 /forma".split("").forEach((key) => app.mockInput.pressKey(key))
    await app.renderOnce()
    app.mockInput.pressEnter()
    await app.renderOnce()
    app.mockInput.pressEnter()
    await app.renderOnce()

    expect(submits[0]?.parts).toEqual([
      {
        type: "skill",
        id: "formatter",
        source: { start: 3, end: 13, value: "/formatter" },
      },
    ])
  } finally {
    app.cleanup()
  }
})

// OpenTUI currently segfaults Bun while tearing down this composer-to-skill-panel transition.
// Re-enable after the upstream renderer teardown fix lands.
test.skip("direct footer skill picker inserts an editable bound skill command", async () => {
  const submits: RunPrompt[] = []
  const app = await renderFooter({
    commands: [command({ name: "new", description: "Skill named new", source: "skill" })],
    onSubmit(prompt) {
      submits.push(prompt)
      return true
    },
  })

  try {
    await app.renderOnce()
    "/skills".split("").forEach((key) => app.mockInput.pressKey(key))
    await app.renderOnce()
    app.mockInput.pressEnter()
    await app.renderOnce()

    expect(app.captureCharFrame()).toContain("Skill named new")

    app.mockInput.pressEnter()
    await app.renderOnce()

    expect(submits).toEqual([])
    expect(app.captureCharFrame()).toContain("/new")

    "task".split("").forEach((key) => app.mockInput.pressKey(key))
    await app.renderOnce()
    app.mockInput.pressEnter()
    await app.renderOnce()

    expect(submits).toEqual([
      { text: "/new task", parts: [], command: { name: "new", arguments: "task", source: "skill" } },
    ])
  } finally {
    app.cleanup()
  }
})

// OpenTUI currently segfaults Bun while tearing down this skill-panel close transition.
// Re-enable after the upstream renderer teardown fix lands.
test.skip("direct footer clears the synthetic skills draft when the panel closes", async () => {
  const submits: RunPrompt[] = []
  const app = await renderFooter({
    commands: [command({ name: "formatter", description: "Apply formatter fixes", source: "skill" })],
    onSubmit(prompt) {
      submits.push(prompt)
      return true
    },
  })

  try {
    await app.renderOnce()
    "/skills".split("").forEach((key) => app.mockInput.pressKey(key))
    await app.renderOnce()
    app.mockInput.pressEnter()
    await app.renderOnce()

    expect(app.captureCharFrame()).toContain("Apply formatter fixes")

    app.mockInput.pressKey("c", { ctrl: true })
    await app.renderOnce()
    app.mockInput.pressEnter()
    await app.renderOnce()

    expect(submits).toEqual([])
    expect(app.captureCharFrame()).not.toContain("/skills")
  } finally {
    app.cleanup()
  }
})

test("direct footer counts queued and steering work while running", async () => {
  const app = await renderFooter({
    width: 160,
    state: { phase: "running" },
    currentModel: { providerID: "opencode", modelID: "a-model-name-long-enough-to-force-responsive-truncation" },
    subagents: {
      tabs: [subagent({ sessionID: "s-1", label: "Explore", description: "Inspect auth flow" })],
      details: {},
      permissions: [],
      forms: [],
    },
    queuedPrompts: [
      { messageID: "m-queued", prompt: { text: "follow up", parts: [] }, delivery: "queue" },
      { messageID: "m-steering", prompt: { text: "steer now", parts: [] }, delivery: "steer" },
    ],
  })

  try {
    await app.renderOnce()
    const frame = app.captureCharFrame()
    const transparent = RGBA.fromValues(0, 0, 0, 0).toInts()
    const statusline = footerStatusline(app.renderer.root)
    expect(frame).toContain("esc stop · ctrl+x q 2 pending · ↓ 1 subagent · ctrl+b background · Build")
    expect(frame).toMatch(/opencode · ctrl\+p menu *$/m)
    expect(frame).not.toContain("1 agent")
    expect(statusline.backgroundColor.toInts()).toEqual(transparent)
  } finally {
    app.cleanup()
  }
})

test("direct footer admits the model and variant together before the agent and trailing menu", async () => {
  for (const expected of [
    { width: 12, text: "" },
    { width: 13, text: "GPT-5 [xhigh]" },
    { width: 19, text: "GPT-5 [xhigh]" },
    { width: 20, text: "Plan · GPT-5 [xhigh]" },
    { width: 33, text: "Plan · GPT-5 [xhigh]" },
    { width: 34, text: "Plan · GPT-5 [xhigh] · ctrl+p menu" },
  ]) {
    const app = await renderFooter({
      currentAgent: "Plan",
      currentVariant: "xhigh",
      state: { model: "GPT-5" },
      width: expected.width,
    })

    try {
      await app.renderOnce()
      const statusline = footerStatusline(app.renderer.root)
      expect(app.captureCharFrame().split("\n")[statusline.y].trimEnd()).toBe(expected.text)
      expect(statusline.height).toBe(1)
    } finally {
      app.cleanup()
    }
  }
})

test.each([16, 20, 24, 32])("status takeovers retain complete instructions at %i columns", async (width) => {
  for (const mono of [false, true]) {
    const app = await renderFooter({
      width,
      mono,
      currentVariant: "high",
      providers: [provider()],
      currentModel: { providerID: "opencode", modelID: "gpt-5" },
      state: { exit: 1, usage: { tokens: 12000, percent: 10 } },
      queuedPrompts: [{ messageID: "queued", prompt: { text: "later", parts: [] }, delivery: "queue" }],
    })
    try {
      for (const state of [
        { phase: "idle" as const, exit: 1, interrupt: 0, notice: "", key: "ctrl+c", action: "exit" },
        { phase: "running" as const, exit: 0, interrupt: 1, notice: "", key: "esc", action: "" },
        { phase: "running" as const, exit: 0, interrupt: 0, notice: "failed to save settings", key: "", action: "" },
      ]) {
        app.setState((previous) => ({ ...previous, ...state }))
        await app.renderOnce()
        await app.renderOnce()
        const statusline = footerStatusline(app.renderer.root)
        const text = app
          .captureCharFrame()
          .split("\n")
          .slice(statusline.y, statusline.y + statusline.height)
          .map((line) => line.trim())
          .join(" ")
        if (state.notice) expect(text.replace(/^[\u25aa*\-\\|/] /, "")).toBe(state.notice)
        if (state.key) {
          expect(text).toContain(state.key)
          expect(text).toMatch(state.action ? /exit/ : /stop|interrupt/)
          expect(statusline.height).toBe(1)
        }
        for (const value of ["Build", "GPT-5", "opencode", "high", "12.0K", "queued", "menu", "..."])
          expect(text).not.toContain(value)
        expect(!!statusline.findDescendantById("mini-work-spinner")).toBe(state.phase === "running")
      }
    } finally {
      app.cleanup()
    }
  }
})

test.each([
  { field: "agent", text: "esc stop · GPT-5 [high]" },
  {
    field: "model",
    text: "esc stop · Build · long-model-long-model-lo… [high] · opencode · ctrl+p menu",
  },
  { field: "provider", text: "esc stop · Build · GPT-5 [high]" },
])("running footer abbreviates only the model and stops at an oversized $field", async ({ field, text }) => {
  const long = `long-${field}-`.repeat(20)
  const app = await renderFooter({
    width: 80,
    currentAgent: field === "agent" ? long : "Build",
    currentVariant: "high",
    currentModel: { providerID: "opencode", modelID: "gpt-5" },
    providers: [
      {
        ...provider(),
        name: field === "provider" ? long : "opencode",
        models: { "gpt-5": model({ id: "gpt-5", name: field === "model" ? long : "GPT-5" }) },
      },
    ],
    state: { phase: "running" },
  })
  try {
    await app.renderOnce()
    const statusline = footerStatusline(app.renderer.root)
    expect(app.captureCharFrame().split("\n")[statusline.y].trimEnd()).toBe("\u25aa " + text)
    expect(statusline.height).toBe(1)
    expect(statusline.findDescendantById("mini-work-spinner")?.width).toBe(1)
  } finally {
    app.cleanup()
  }
})

test.each([8, 12])("production footer grows for wrapped instructions in %i rows", async (height) => {
  const app = await createTestRenderer({ width: 16, height, screenMode: "split-footer", footerHeight: 4 })
  const footer = new RunFooter(app.renderer, {
    directory: () => "/project",
    findFiles: async () => [],
    agents: [{ id: "build", name: "Build", mode: "primary", hidden: false }],
    references: [],
    agent: "build",
    modelLabel: "GPT-5",
    model: undefined,
    variant: undefined,
    first: false,
    theme: RUN_THEME_FALLBACK,
    tuiConfig: createTuiResolvedConfig({ keybinds: { "prompt.clear": "ctrl+shift+alt+x" } }),
    miniSettings: {
      current: {
        thinking: "hide",
        tools: "show",
        shell_output: "hide",
        turn_summary: "show",
        footer: "show",
        splash: "show",
        work_spinner: "block-soft-slide",
        mono: false,
      },
    },
    onPermissionReply: () => {},
    onFormReply: () => {},
    onFormCancel: () => {},
    onEditorOpen: async () => undefined,
    subscribeThemeSignal: () => () => {},
  })
  try {
    await app.renderOnce()
    const initial = app.renderer.footerHeight
    footer.requestExit()
    await app.renderOnce()
    await app.renderOnce()
    expect(app.renderer.footerHeight).toBe(initial + 1)
    expect(app.captureCharFrame()).toContain("ctrl+shift+alt+x")
    expect(app.captureCharFrame()).toContain("exit")
    expect(app.captureCharFrame()).not.toContain("GPT-5")
    footer.event({ type: "stream.patch", patch: { exit: 0, notice: "failed to save settings" } })
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("settings")
    footer.event({ type: "stream.patch", patch: { notice: "" } })
    await app.renderOnce()
    expect(app.renderer.footerHeight).toBe(initial)
  } finally {
    footer.destroy()
    app.renderer.destroy()
  }
})

test("an oversized queue shortcut prevents backfilling shorter work and identity hints", async () => {
  const app = await renderFooter({
    width: 32,
    tuiConfig: createTuiResolvedConfig({ keybinds: { "session.queued_prompts": "ctrl+shift+alt+q" } }),
    queuedPrompts: [{ messageID: "queued", prompt: { text: "later", parts: [] }, delivery: "queue" }],
    subagents: {
      tabs: [subagent({ sessionID: "s-1", label: "Explore", description: "Inspect" })],
      details: {},
      permissions: [],
      forms: [],
    },
    state: { phase: "running" },
  })
  try {
    await app.renderOnce()
    const statusline = footerStatusline(app.renderer.root)
    expect(app.captureCharFrame().split("\n")[statusline.y].trimEnd()).toBe("\u25aa esc stop")
  } finally {
    app.cleanup()
  }
})

test.each(["ctrl+i", "none"])("takeovers preserve configured shortcuts with hidden details (%s)", async (key) => {
  const app = await renderFooter({
    width: 16,
    tuiConfig: createTuiResolvedConfig({
      keybinds: { "session.interrupt": key, "prompt.clear": key, "command.palette.show": "none" },
    }),
    state: { phase: "running", interrupt: 1 },
    miniSettings: {
      thinking: "hide",
      tools: "show",
      shell_output: "hide",
      turn_summary: "show",
      footer: "hide",
      splash: "show",
      work_spinner: "block-soft-slide",
      mono: false,
    },
  })
  try {
    for (const exit of [0, 1]) {
      app.setState((state) => ({ ...state, exit }))
      await app.renderOnce()
      const frame = app.captureCharFrame()
      expect(frame).toContain(
        key === "none" ? (exit ? "Exit pending" : "Stop pending") : `${key} ${exit ? "exit" : "stop"}`,
      )
      for (const hidden of ["ctrl+c", "esc", "menu", "Build", "gpt-5"]) expect(frame).not.toContain(hidden)
    }
  } finally {
    app.cleanup()
  }
})

test.each(["ctrl+g", "none"])("context actions use only configured bindings (%s)", async (queued) => {
  const app = await renderFooter({
    width: 96,
    tuiConfig: createTuiResolvedConfig({
      keybinds: {
        "session.interrupt": "ctrl+i",
        "session.queued_prompts": queued,
        "session.child.first": "ctrl+j",
        "session.background": "none",
        "command.palette.show": "ctrl+y",
      },
    }),
    queuedPrompts: [{ messageID: "queued", prompt: { text: "later", parts: [] }, delivery: "queue" }],
    subagents: {
      tabs: [subagent({ sessionID: "s-1", label: "Explore", description: "Inspect" })],
      details: {},
      permissions: [],
      forms: [],
    },
    state: { phase: "running" },
  })
  try {
    await app.renderOnce()
    const frame = app.captureCharFrame()
    expect(frame).toContain(
      queued === "none"
        ? "ctrl+i interrupt · ctrl+j 1 subagent · Build · gpt-5 · ctrl+y menu"
        : "ctrl+i interrupt · ctrl+g 1 pending · ctrl+j 1 subagent · Build · gpt-5 · ctrl+y menu",
    )
    for (const hidden of ["ctrl+b", "ctrl+x", "ctrl+p", "esc", "↓"]) expect(frame).not.toContain(hidden)
  } finally {
    app.cleanup()
  }
})

test("identity and context precede the provider and a non-fitting provider blocks the menu", async () => {
  const app = await renderFooter({
    width: 56,
    providers: [{ ...provider(), name: "Long provider display name" }],
    currentModel: { providerID: "opencode", modelID: "gpt-5" },
    currentVariant: "high",
    state: { usage: { tokens: 12000, percent: 10 } },
  })
  try {
    await app.renderOnce()
    const statusline = footerStatusline(app.renderer.root)
    expect(app.captureCharFrame().split("\n")[statusline.y].trimEnd()).toBe("Build · GPT-5 [high] · 12.0K (10%)")
  } finally {
    app.cleanup()
  }
})

test("direct footer keeps compact work, model detail, and context ahead of cost and rich labels", async () => {
  const app = await renderFooter({
    currentAgent: "Plan",
    subagents: {
      tabs: [subagent({ sessionID: "s-1", label: "Explore", description: "Inspect auth flow" })],
      details: {},
      permissions: [],
      forms: [],
    },
    state: {
      phase: "running",
      model: "a-model-name-long-enough-to-force-responsive-truncation",
      usage: { tokens: 159600, percent: 16, cost: 4.23 },
    },
    width: 80,
  })

  try {
    await app.renderOnce()
    const statusline = footerStatusline(app.renderer.root)
    expect(app.captureCharFrame().split("\n")[statusline.y].trimEnd()).toBe(
      "\u25aa esc stop · ↓ 1 sub · ctrl+b bg · Plan · a-model-name-long-enough… · 16% ctx",
    )
  } finally {
    app.cleanup()
  }
})

test("direct footer keeps the stop action before the menu at minimum width", async () => {
  const app = await renderFooter({ state: { phase: "running" }, width: 10 })

  try {
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("esc stop")
    expect(app.captureCharFrame()).not.toContain("menu")
  } finally {
    app.cleanup()
  }
})

test.each([false, true])("working marker stays visible with animations=%s and stops at idle", async (animations) => {
  const app = await renderFooter({
    width: 24,
    tuiConfig: createTuiResolvedConfig({ animations }),
    state: { phase: "running" },
  })
  try {
    await app.renderOnce()
    const line = app.captureCharFrame().split("\n")[footerStatusline(app.renderer.root).y]
    expect(line).toContain(" esc stop")
    expect(animations ? BLOCK_SOFT_SLIDE.frames : ["\u25aa"]).toContain(Array.from(line)[0]!)
    expect(app.renderer.root.findDescendantById("mini-work-spinner")?.width).toBe(1)
    app.setMiniSettings((settings) => ({ ...settings, work_spinner: "seed" }))
    await app.renderOnce()
    expect(app.captureCharFrame().split("\n")[footerStatusline(app.renderer.root).y]).toStartWith("\u25aa ")
    await app.renderer.idle()
    app.setState((state) => ({ ...state, phase: "idle" }))
    await app.renderOnce()
    expect(app.renderer.root.findDescendantById("mini-work-spinner")).toBeUndefined()
  } finally {
    app.cleanup()
  }
})

test.each(["Build", "Plan"])("working marker matches the %s label and prompt rail across themes", async (agent) => {
  const [theme, setTheme] = createSignal(RUN_THEME_FALLBACK)
  const app = await renderFooter({
    currentAgent: agent,
    agents: [
      { id: "build", name: "Build", mode: "primary", hidden: false },
      { id: "plan", name: "Plan", mode: "primary", hidden: false },
    ],
    theme,
    tuiConfig: createTuiResolvedConfig({ animations: false }),
    state: { phase: "running" },
  })
  try {
    for (const current of [RUN_THEME_FALLBACK, RUN_THEME_FALLBACK_LIGHT]) {
      setTheme(current)
      await app.renderOnce()
      const spans = app.captureSpans().lines.flatMap((line) => line.spans)
      const expected = (current.footer.categorical[agent === "Build" ? 0 : 1] as RGBA).toInts()
      expect(spans.find((span) => span.text.includes(agent))?.fg.toInts()).toEqual(expected)
      expect(spans.find((span) => span.text.includes("\u2503"))?.fg.toInts()).toEqual(expected)
      expect(spans.find((span) => span.text === "\u25aa")?.fg.toInts()).toEqual(expected)
    }
  } finally {
    app.cleanup()
  }
})

test("spinner repaints keep the prompt instance, cursor state, and footer height stable", async () => {
  const app = await renderFooter({
    tuiConfig: createTuiResolvedConfig({ animations: true }),
    state: { phase: "running" },
  })
  try {
    await app.renderOnce()
    await app.mockInput.typeText("draft")
    await app.renderOnce()
    const editor = app.renderer.currentFocusedEditor
    const cursor = app.renderer.getCursorState()
    const height = app.renderer.footerHeight
    const frames = new Set<string>()
    for (let index = 0; index < 8; index++) {
      await Bun.sleep(40)
      await app.renderOnce()
      expect(app.renderer.currentFocusedEditor).toBe(editor)
      expect(editor?.plainText).toBe("draft")
      expect(app.renderer.getCursorState()).toEqual(cursor)
      expect(app.renderer.footerHeight).toBe(height)
      frames.add(JSON.stringify(app.captureSpans()))
    }
    expect(frames.size).toBeGreaterThan(1)
  } finally {
    app.cleanup()
  }
})

test("direct footer reserves the working indicator beside complete status text", async () => {
  const app = await renderFooter({
    tuiConfig: createTuiResolvedConfig({ keybinds: { "session.interrupt": "none" } }),
    state: { phase: "running" },
    width: 22,
  })

  try {
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("Running")
    expect(app.captureCharFrame()).not.toContain("interrupt")
    expect(footerStatusline(app.renderer.root).findDescendantById("mini-work-spinner")?.width).toBe(1)
  } finally {
    app.cleanup()
  }
})

test("direct footer always offers backgrounding for a foreground subagent", async () => {
  const app = await renderFooter({
    subagents: {
      tabs: [subagent({ sessionID: "s-1", label: "Explore", description: "Inspect auth flow" })],
      details: {},
      permissions: [],
      forms: [],
    },
    width: 160,
  })

  try {
    await app.renderOnce()
    const frame = app.captureCharFrame()

    expect(frame).toContain("↓ 1 subagent · ctrl+b background · Build · gpt-5 · ctrl+p menu")
    expect(frame).not.toContain("queued")
  } finally {
    app.cleanup()
  }
})

test("direct footer hides the subagent hint when only completed subagents remain", async () => {
  const app = await renderFooter({
    subagents: {
      tabs: [subagent({ sessionID: "s-1", label: "Explore", description: "Inspect auth flow", status: "completed" })],
      details: {},
      permissions: [],
      forms: [],
    },
    width: 160,
  })

  try {
    await app.renderOnce()
    const frame = app.captureCharFrame()

    expect(frame).toContain("Build")
    expect(frame).not.toContain("1 sub")
  } finally {
    app.cleanup()
  }
})

test("direct footer omits interrupt key hint when interrupt is unbound", async () => {
  const app = await renderFooter({
    tuiConfig: createTuiResolvedConfig({ keybinds: { "session.interrupt": "none", "prompt.clear": "ctrl+l" } }),
    state: { phase: "running" },
    mono: true,
  })

  try {
    await app.renderOnce()
    const frame = app.captureCharFrame()
    const statusline = frame.split("\n").find((line) => line.includes("Running"))

    expect(frame).toContain("Running")
    expect(frame).not.toContain("interrupt")
    expect(frame).not.toContain("ctrl+l")
    expect(statusline).toMatch(/^\S/)
  } finally {
    app.cleanup()
  }
})

test("direct footer shows full usage metadata when room is available", async () => {
  const app = await renderFooter({
    state: { usage: { tokens: 159600, percent: 16, cost: 4.23 } },
  })

  try {
    await app.renderOnce()
    const frame = app.captureCharFrame()

    expect(frame).toContain("159.6K (16%) · $4.23")
  } finally {
    app.cleanup()
  }
})

test("direct footer keeps model, variant, and usage before the menu and rich stop label", async () => {
  const app = await renderFooter({
    state: { phase: "running", model: "GPT-5.6 SoL", usage: { tokens: 8400, percent: 1, cost: 0.01 } },
    currentVariant: "high",
    mono: true,
    width: 66,
  })

  try {
    await app.renderOnce()
    const statusline = footerStatusline(app.renderer.root)
    expect(app.captureCharFrame().split("\n")[statusline.y].trimEnd()).toBe(
      "* esc stop - Build - GPT-5.6 SoL [high] - 8.4K (1%) - $0.01",
    )
  } finally {
    app.cleanup()
  }
})

test("direct footer hides routine activity and shows explicit notices", async () => {
  let status = ""
  const app = await renderFooter({
    state: { usage: { tokens: 159600, percent: 16, cost: 4.23 } },
    currentAgent: "Plan",
    miniSettings: {
      thinking: "hide",
      tools: "show",
      shell_output: "hide",
      turn_summary: "show",
      footer: "hide",
      splash: "show",
      work_spinner: "block-soft-slide",
      mono: true,
    },
    mono: true,
    onStatus: (value) => (status = value),
    width: 160,
  })

  try {
    await app.renderOnce()
    const initial = app.captureCharFrame()
    expect(initial).toContain("ctrl+p menu")
    expect(initial).not.toContain("Plan")
    expect(initial).not.toContain("gpt-5")
    expect(initial).not.toContain("159.6K")

    app.setState((state) => ({ ...state, phase: "running", status: "assistant responding" }))
    await app.renderOnce()
    const changed = app.captureCharFrame()
    const statusline = footerStatusline(app.renderer.root)

    expect(changed).not.toContain("running")
    expect(changed).not.toContain("assistant responding")
    expect(changed).not.toContain("interrupt")
    expect(changed).not.toContain("gpt-5")
    expect(changed).not.toContain("159.6K")
    expect(boxPath(statusline, "SpinnerRenderable")).toBeUndefined()

    app.mockInput.pressKey("p", { ctrl: true })
    await app.renderOnce()
    await app.mockInput.typeText("status")
    app.mockInput.pressEnter()
    expect(status).toBe("running - agent Plan - gpt-5 - 159.6K (16%) - $4.23")

    app.setState((state) => ({ ...state, notice: "variant high" }))
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("variant high")
  } finally {
    app.cleanup()
  }
})

test("direct permission rejection submits through keymap return binding", async () => {
  let text = ""
  const submits: string[] = []
  function Harness() {
    return (
      <Keymap.Provider config={tuiConfig}>
        <RejectField
          theme={RUN_THEME_FALLBACK.footer}
          text=""
          disabled={false}
          onChange={(input) => {
            text = input
          }}
          onConfirm={() => {
            submits.push(text)
          }}
          onCancel={() => {}}
        />
      </Keymap.Provider>
    )
  }

  const app = await testRender(
    () => (
      <box width={100} height={18}>
        <Harness />
      </box>
    ),
    { width: 100, height: 18, kittyKeyboard: true },
  )

  try {
    await app.renderOnce()
    "retry".split("").forEach((key) => app.mockInput.pressKey(key))
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("retry")
    app.mockInput.pressEnter()
    await app.renderOnce()
    expect(submits).toEqual(["retry"])
  } finally {
    app.renderer.currentFocusedRenderable?.blur()
    app.renderer.currentFocusedEditor?.blur()
    app.renderer.destroy()
  }
})

test("direct model panel keeps native V2 light search and options readable on a transparent background", async () => {
  const theme = await nativeLightTheme()
  const background = RGBA.fromHex("#ffffff")
  const [providers] = createSignal<RunProvider[] | undefined>([
    provider(),
    { id: "openai", name: "OpenAI", models: { "gpt-5": model({ id: "gpt-5", name: "GPT-5" }) } },
  ])
  const [current] = createSignal<RunInput["model"]>({ providerID: "opencode", modelID: "gpt-5" })

  const app = await testRender(
    () => (
      <box width={100} height={RUN_COMMAND_PANEL_ROWS} backgroundColor={background}>
        <RunModelSelectBody
          theme={() => theme.footer}
          providers={providers}
          current={current}
          onClose={() => {}}
          onSelect={() => {}}
        />
      </box>
    ),
    {
      width: 100,
      height: RUN_COMMAND_PANEL_ROWS + 1,
    },
  )

  try {
    await app.renderOnce()
    const frame = app.captureCharFrame()
    const list = panelMenu(app.renderer.root)

    expect(frame).toContain("Select model")
    expect(frame).toContain("Search")
    expect(frame).toContain("opencode")
    expect(frame).toContain("GPT-5")
    expect(frame).toContain("current")
    expect(frame).toContain("GPT Free")
    expect(frame).toContain("Free")
    expect(frame).not.toContain("┌")
    expect(frame).not.toContain("┃")
    expect(frame).not.toContain("Old Model")
    expect(frame).not.toContain("▀")
    expect(
      boxPath(app.renderer.root, "InputRenderable")
        ?.slice(1)
        .every((box) => box.backgroundColor.a === 0),
    ).toBe(true)
    expect(list.backgroundColor.a).toBe(0)
    expect((list.getChildren()[2] as BoxRenderable).backgroundColor.toInts()).toEqual(
      (theme.footer.actionFocusedBg as RGBA).toInts(),
    )

    "gpt-5".split("").forEach((key) => app.mockInput.pressKey(key))
    await app.renderOnce()
    const search = app.captureCharFrame()

    expect(search.match(/GPT-5/g)).toHaveLength(2)
    expect(search).toContain("opencode")
    expect(search).toContain("OpenAI")
    const spans = app.captureSpans().lines.flatMap((line) => line.spans)
    const query = spans.find((span) => span.text.includes("gpt-5"))!
    expect(query.fg.toInts()).toEqual((theme.footer.formfieldText as RGBA).toInts())
    expect(query.bg.toInts()).toEqual(background.toInts())
    expect(app.renderer.getCursorState().color.toInts()).toEqual(query.fg.toInts())
    expect(
      spans.filter((span) => span.text.includes("GPT-5")).map((span) => [span.fg.toInts(), span.bg.toInts()]),
    ).toEqual([
      [(theme.footer.actionFocusedText as RGBA).toInts(), (theme.footer.actionFocusedBg as RGBA).toInts()],
      [(theme.footer.formfieldText as RGBA).toInts(), background.toInts()],
    ])
  } finally {
    app.renderer.destroy()
    theme.block.syntax?.destroy()
  }
})

test("direct permission buttons use secondary text over the native V2 light pane", async () => {
  const theme = await nativeLightTheme()
  const app = await renderFooter({
    theme: () => theme,
    height: 16,
    view: {
      type: "permission",
      request: { id: "per_light", sessionID: "ses_light", action: "read", resources: ["src/index.ts"] },
    },
  })
  try {
    await app.renderOnce()
    const spans = app.captureSpans().lines.flatMap((line) => line.spans)
    const inactive = spans.find((span) => span.text.includes("Reject"))!
    const selected = spans.find((span) => span.text.includes("Allow once"))!
    expect(inactive.fg.toInts()).toEqual((theme.footer.actionSecondaryText as RGBA).toInts())
    expect(inactive.bg.toInts()).toEqual((theme.footer.pane as RGBA).toInts())
    expect(selected.fg.toInts()).toEqual((theme.footer.actionFocusedText as RGBA).toInts())
    expect(selected.bg.toInts()).toEqual((theme.footer.actionFocusedBg as RGBA).toInts())
  } finally {
    app.cleanup()
    theme.block.syntax?.destroy()
  }
})

test("direct agent panel shows eligible agents and marks the current agent", async () => {
  const theme = await nativeLightTheme()
  const [agents] = createSignal<RunAgent[]>([
    { id: "build", name: "Build", description: "Build software", mode: "all", hidden: false },
    { id: "review", name: "Review", description: "Review changes", mode: "primary", hidden: false },
    { id: "explore", name: "Explore", mode: "subagent", hidden: false },
    { id: "secret", name: "Secret", mode: "all", hidden: true },
  ])
  const [current] = createSignal("review")
  let selected: string | undefined

  const app = await testRender(
    () => (
      <box width={100} height={RUN_COMMAND_PANEL_ROWS}>
        <RunAgentSelectBody
          theme={() => theme.footer}
          agents={agents}
          current={current}
          onClose={() => {}}
          onSelect={(agent) => (selected = agent)}
        />
      </box>
    ),
    {
      width: 100,
      height: RUN_COMMAND_PANEL_ROWS,
    },
  )

  try {
    await app.renderOnce()
    const frame = app.captureCharFrame()

    expect(frame).toContain("Select agent")
    expect(frame).toContain("build")
    expect(frame).toContain("review")
    expect(frame).toContain("Review changes")
    expect(frame).toContain("current")
    expect(frame).not.toContain("explore")
    expect(frame).not.toContain("secret")

    app.mockInput.pressEnter()
    expect(selected).toBe("review")
    await app.mockInput.typeText("review")
    await app.renderOnce()
    const query = app
      .captureSpans()
      .lines[app.renderer.currentFocusedRenderable!.y].spans.find((span) => span.text.includes("review"))!
    expect(query.fg.toInts()).toEqual((theme.footer.formfieldFocusedText as RGBA).toInts())
    expect(query.bg.toInts()).toEqual((theme.footer.formfieldFocusedBg as RGBA).toInts())
    expect(app.renderer.getCursorState().color.toInts()).toEqual(query.fg.toInts())
  } finally {
    app.renderer.destroy()
    theme.block.syntax?.destroy()
  }
})

test("direct variant panel renders current variant selector", async () => {
  const [variants] = createSignal(["high", "minimal"])
  const [current] = createSignal<string | undefined>("high")

  const app = await testRender(
    () => (
      <box width={100} height={RUN_COMMAND_PANEL_ROWS}>
        <RunVariantSelectBody
          theme={() => RUN_THEME_FALLBACK.footer}
          variants={variants}
          current={current}
          onClose={() => {}}
          onSelect={() => {}}
        />
      </box>
    ),
    {
      width: 100,
      height: RUN_COMMAND_PANEL_ROWS,
    },
  )

  try {
    await app.renderOnce()
    const frame = app.captureCharFrame()
    const list = panelMenu(app.renderer.root)

    expect(frame).toContain("Select variant")
    expect(frame).toContain("Default")
    expect(frame).toContain("high")
    expect(frame).toContain("minimal")
    expect(frame).toContain("current")
    expect(frame).not.toContain("┌")
    expect(frame).not.toContain("┃")
    expectPaletteList(list, 1)
  } finally {
    app.renderer.destroy()
  }
})
