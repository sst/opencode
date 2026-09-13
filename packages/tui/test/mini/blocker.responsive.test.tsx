/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { BoxRenderable, RGBA, ScrollBoxRenderable, TextRenderable, type Renderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { testRender } from "@opentui/solid"
import { Keymap } from "../../src/context/keymap"
import { RunFooter } from "../../src/mini/footer"
import { RunFormBody } from "../../src/mini/footer.form"
import { RunPermissionBody } from "../../src/mini/footer.permission"
import { RunFooterSubagentBody } from "../../src/mini/footer.subagent"
import { createFormBodyState } from "../../src/mini/form.shared"
import { RUN_THEME_FALLBACK, RUN_THEME_MONO } from "../../src/mini/theme"
import type { FormReply, MiniFormRequest, MiniPermissionRequest, PermissionReply } from "../../src/mini/types"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"

const permission: MiniPermissionRequest = {
  id: "per_responsive",
  sessionID: "ses_responsive",
  action: "shell",
  resources: ["rm -rf /project/build/cache"],
  save: ["/project/build/*", "/project/private/GRANT_SENTINEL"],
}
const form: MiniFormRequest = {
  id: "frm_responsive",
  sessionID: "ses_responsive",
  title: "Deployment",
  fields: [
    {
      key: "target",
      type: "string",
      title: "Target",
      required: true,
      options: Array.from({ length: 12 }, (_, index) => ({
        value: `target-${index + 1}`,
        label: `Target ${index + 1}`,
        description: `Environment ${index + 1}`,
      })),
    },
  ],
}

function descendants(root: Renderable): Renderable[] {
  return root.getChildren().flatMap((child) => [child, ...descendants(child)])
}

async function settle(app: Pick<Awaited<ReturnType<typeof testRender>>, "renderOnce">) {
  await app.renderOnce()
  await Bun.sleep(0)
  await app.renderOnce()
  await app.renderOnce()
}

async function renderForm(request: MiniFormRequest, width = 80, height = 20) {
  const replies: FormReply[] = []
  const app = await testRender(
    () => (
      <RunFormBody
        request={request}
        theme={RUN_THEME_FALLBACK.footer}
        onReply={(reply) => {
          replies.push(reply)
        }}
        onCancel={() => {}}
      />
    ),
    { width, height, kittyKeyboard: true },
  )
  return { ...app, replies }
}

test("roomy question forms retain the established spacing and inline descriptions", async () => {
  const app = await renderForm({
    ...form,
    title: "Questions",
    fields: [
      {
        key: "layout",
        type: "string",
        title: "Layout",
        description: "Which footer view?",
        options: [
          { value: "form", label: "Form", description: "Inspect canonical form" },
          { value: "prompt", label: "Prompt", description: "Return to composer" },
        ],
      },
      { key: "extra", type: "boolean", title: "Extra checks" },
    ],
  })
  try {
    await settle(app)
    for (const [text, x, y] of [
      ["Questions", 4, 1],
      ["1/2", 14, 1],
      ["Which footer view?", 2, 3],
      ["Form", 5, 5],
      ["Inspect canonical form", 10, 5],
    ] as const) {
      const node = descendants(app.renderer.root).find(
        (node) => node instanceof TextRenderable && node.plainText === text,
      )!
      expect({ text, x: node.x, y: node.y }).toEqual({ text, x, y })
    }
    expect(app.captureCharFrame().split("\n")[18]).toContain("↑↓ select   enter choose   tab next   esc dismiss")
  } finally {
    app.renderer.destroy()
  }
})

test.each([16, 24, 40])(
  "complete questions and distinct option details remain readable at %i columns",
  async (width) => {
    const content = (app: Awaited<ReturnType<typeof renderForm>>) =>
      app
        .captureCharFrame()
        .split("\n")
        .map((row) => row.slice(0, width - 1))
        .join(" ")
        .replace(/\s+/g, " ")
    const title = "Delete production database permanently?"
    const app = await renderForm({ ...form, fields: [{ key: "yes", type: "boolean", title }] }, width, 8)
    try {
      await settle(app)
      app.mockInput.pressKey("\x1b[5~")
      await settle(app)
      expect(content(app)).toContain(title)
      expect(app.replies).toEqual([])
    } finally {
      app.renderer.destroy()
    }
    const options = await renderForm(
      {
        ...form,
        fields: [
          {
            key: "target",
            type: "string",
            title: "Target",
            options: [
              { value: "stage", label: "Deploy api service to staging", description: "STAGING database" },
              { value: "prod", label: "Deploy api service to production", description: "PRODUCTION database" },
            ],
          },
        ],
      },
      width,
      12,
    )
    try {
      await settle(options)
      expect(content(options)).toContain("Deploy api service to staging")
      expect(content(options)).toContain("STAGING database")
      options.mockInput.pressArrow("down")
      await settle(options)
      expect(content(options)).toContain("Deploy api service to production")
      expect(content(options)).toContain("PRODUCTION database")
      options.mockInput.pressEnter()
      await settle(options)
      expect(options.replies[0]?.answer).toEqual({ target: "prod" })
    } finally {
      options.renderer.destroy()
    }
  },
)

test("advancing fields reveals the new choice without a second Enter", async () => {
  const app = await renderForm(
    {
      ...form,
      fields: [
        { key: "confirm", type: "boolean", title: "Continue?" },
        {
          key: "target",
          type: "string",
          title: "Target",
          description: "Select your preferred destination for this deployment and double-check it carefully.",
          options: [
            { value: "b0", label: "B0" },
            { value: "b1", label: "B1" },
          ],
        },
      ],
    },
    16,
    8,
  )
  try {
    await settle(app)
    app.mockInput.pressEnter()
    await settle(app)
    expect(app.captureCharFrame()).toContain("B0")
    expect(app.replies).toEqual([])
    app.mockInput.pressEnter()
    await settle(app)
    expect(app.captureCharFrame()).toContain("Review")
  } finally {
    app.renderer.destroy()
  }
})

test("roomy permission prompts retain their header and padded action bar", async () => {
  const app = await testRender(
    () => (
      <RunPermissionBody
        request={permission}
        theme={RUN_THEME_FALLBACK.footer}
        block={RUN_THEME_FALLBACK.block}
        onReply={() => {}}
      />
    ),
    { width: 112, height: 20 },
  )
  try {
    await settle(app)
    const nodes = descendants(app.renderer.root).filter(
      (node): node is TextRenderable => node instanceof TextRenderable,
    )
    const title = nodes.find((node) => node.plainText.includes("Permission required"))!
    const action = nodes.find((node) => node.plainText === "Allow once")!
    expect({ x: title.x, y: title.y }).toEqual({ x: 2, y: 1 })
    expect({ x: action.x, y: action.y }).toEqual({ x: 3, y: 18 })
    expect(app.captureCharFrame().split("\n")[18]).toContain("⇆ select  enter confirm  esc reject")
    const scroll = descendants(app.renderer.root).find((node) => node instanceof ScrollBoxRenderable)!
    expect(scroll.x + scroll.width).toBe(109)
    app.mockInput.pressEnter()
    await settle(app)
    expect(app.captureCharFrame()).toContain("Waiting for permission event…")
  } finally {
    app.renderer.destroy()
  }
})

test("roomy rejection keeps the editor and confirmation hints inline", async () => {
  const app = await testRender(
    () => (
      <Keymap.Provider config={createTuiResolvedConfig()}>
        <RunPermissionBody
          request={permission}
          theme={RUN_THEME_FALLBACK.footer}
          block={RUN_THEME_FALLBACK.block}
          onReply={() => {}}
        />
      </Keymap.Provider>
    ),
    { width: 112, height: 20, kittyKeyboard: true },
  )
  try {
    await settle(app)
    app.mockInput.pressArrow("right")
    app.mockInput.pressArrow("right")
    app.mockInput.pressEnter()
    await settle(app)
    const editor = app.renderer.currentFocusedEditor!
    const confirm = descendants(app.renderer.root).find(
      (node) => node instanceof TextRenderable && node.plainText === "enter confirm",
    )!
    expect(editor.y).toBe(18)
    expect(confirm.y).toBe(editor.y)
    expect(confirm.x).toBeGreaterThanOrEqual(editor.x + editor.width)
    expect(app.captureCharFrame()).toContain("esc cancel")
    expect(app.captureCharFrame()).toContain("Tell OpenCode what to do differently")
  } finally {
    app.renderer.destroy()
  }
})

test.each([false, true])("picked options budget their full ordinal and selection marker (mono=%s)", async (mono) => {
  for (const width of [16, 112]) {
    const description = width === 16 ? "prod" : "d".repeat(85) + "_END_LAST"
    const app = await testRender(
      () => (
        <RunFormBody
          request={{
            ...form,
            fields: [
              {
                key: "target",
                type: "string",
                title: "Target",
                default: "target-12",
                options: Array.from({ length: 12 }, (_, index) => ({
                  value: `target-${index + 1}`,
                  label: "Deploy",
                  description,
                })),
              },
            ],
          }}
          theme={RUN_THEME_FALLBACK.footer}
          mono={mono}
          onReply={() => {}}
          onCancel={() => {}}
        />
      ),
      { width, height: 20, kittyKeyboard: true },
    )
    try {
      await settle(app)
      const label = descendants(app.renderer.root).find(
        (node) => node instanceof TextRenderable && node.plainText === "Deploy *",
      )!
      const detail = label
        .parent!.getChildren()
        .find((node) => node instanceof TextRenderable && node.plainText === description)!
      const scroll = descendants(app.renderer.root).find((node) => node instanceof ScrollBoxRenderable)!
      expect(detail.y).toBeGreaterThan(label.y)
      expect(detail.x + detail.width).toBeLessThanOrEqual(scroll.viewport.x + scroll.viewport.width - (mono ? 0 : 1))
      expect(app.captureCharFrame()).toContain(description)
    } finally {
      app.renderer.destroy()
    }
  }
})

test.each([
  { width: 16, height: 8 },
  { width: 24, height: 8 },
  { width: 32, height: 8 },
  { width: 40, height: 8 },
  { width: 56, height: 8 },
  { width: 56, height: 12 },
  { width: 80, height: 12 },
  { width: 112, height: 20 },
])("permission controls fit the allocated $width x $height viewport", async (size) => {
  const replies: PermissionReply[] = []
  const app = await testRender(
    () => (
      <RunPermissionBody
        request={permission}
        theme={RUN_THEME_FALLBACK.footer}
        block={RUN_THEME_FALLBACK.block}
        onReply={(reply) => {
          replies.push(reply)
        }}
      />
    ),
    { ...size, kittyKeyboard: true },
  )
  try {
    await settle(app)
    for (const label of ["Allow once", "Always allow", "Reject"]) {
      expect(app.captureCharFrame()).toContain(label)
      const node = descendants(app.renderer.root).find(
        (node) => node instanceof TextRenderable && node.plainText === label,
      )!
      expect(node.x + node.width).toBeLessThanOrEqual(size.width)
      expect(node.y + node.height).toBeLessThanOrEqual(size.height)
    }
    const scroll = descendants(app.renderer.root).find((node) => node instanceof ScrollBoxRenderable)!
    expect(scroll.height).toBeGreaterThan(0)
    expect(replies).toEqual([])
  } finally {
    app.renderer.destroy()
  }
})

test.each(["once", "always", "reject"] as const)(
  "24 x 8 production permission confirms the visible %s choice",
  async (choice) => {
    const app = await createTestRenderer({
      width: 24,
      height: 8,
      screenMode: "split-footer",
      footerHeight: 4,
      kittyKeyboard: true,
    })
    const replies: PermissionReply[] = []
    const footer = new RunFooter(app.renderer, {
      directory: () => "/project",
      findFiles: async () => [],
      agents: [],
      references: [],
      agent: undefined,
      modelLabel: "GPT-5",
      model: undefined,
      variant: undefined,
      first: false,
      theme: RUN_THEME_FALLBACK,
      tuiConfig: createTuiResolvedConfig(),
      miniSettings: {
        current: {
          thinking: "hide",
          tools: "show",
          shell_output: "hide",
          turn_summary: "hide",
          footer: "show",
          splash: "hide",
          work_spinner: "block-soft-slide",
          mono: false,
        },
      },
      onPermissionReply: (reply) => {
        replies.push(reply)
      },
      onFormReply: () => {},
      onFormCancel: () => {},
      onEditorOpen: async () => undefined,
      subscribeThemeSignal: () => () => {},
    })
    try {
      await settle(app)
      footer.event({ type: "stream.view", view: { type: "permission", request: permission } })
      await settle(app)
      for (const label of ["Allow once", "Always allow", "Reject"]) expect(app.captureCharFrame()).toContain(label)
      for (let index = 0; index < ["once", "always", "reject"].indexOf(choice); index++) app.mockInput.pressTab()
      await settle(app)
      const label = choice === "once" ? "Allow once" : choice === "always" ? "Always allow" : "Reject"
      const node = descendants(app.renderer.root).find(
        (node) => node instanceof TextRenderable && node.plainText === label,
      )!
      expect((node.parent as BoxRenderable).backgroundColor.toInts()).toEqual(
        (RUN_THEME_FALLBACK.footer.actionFocusedBg as RGBA).toInts(),
      )
      expect(replies).toEqual([])
      app.mockInput.pressEnter()
      await settle(app)
      if (choice !== "once") {
        expect(replies).toEqual([])
        expect(app.captureCharFrame()).toContain(choice === "always" ? "Confirm" : "enter reject")
        app.mockInput.pressEnter()
        await settle(app)
      }
      expect(replies).toEqual([{ sessionID: permission.sessionID, requestID: permission.id, reply: choice }])
    } finally {
      footer.destroy()
      app.renderer.destroy()
    }
  },
)

test.each([
  { width: 16, height: 8 },
  { width: 24, height: 8 },
  { width: 32, height: 12 },
  { width: 56, height: 8 },
  { width: 56, height: 12 },
  { width: 80, height: 20 },
])("form choices reveal selection at $width x $height", async (size) => {
  const app = await renderForm(form, size.width, size.height)
  try {
    await settle(app)
    for (let index = 0; index < 12; index++) {
      if (index > 0) app.mockInput.pressKey("ARROW_DOWN")
      await settle(app)
      expect(app.captureCharFrame()).toContain(`Target ${index + 1}`)
      const selected = descendants(app.renderer.root).find(
        (node) => node instanceof TextRenderable && node.plainText === `Target ${index + 1}`,
      )!
      const scroll = descendants(app.renderer.root).find(
        (node): node is ScrollBoxRenderable => node instanceof ScrollBoxRenderable,
      )!
      expect(selected.y).toBeGreaterThanOrEqual(scroll.viewport.y)
      expect(selected.y + selected.height).toBeLessThanOrEqual(scroll.viewport.y + scroll.viewport.height)
    }
    app.mockInput.pressEnter()
    await settle(app)
    expect(app.replies[0]?.answer).toEqual({ target: "target-12" })
  } finally {
    app.renderer.destroy()
  }
})

test("form review scrolls from the first answer to the last", async () => {
  const request: MiniFormRequest = {
    ...form,
    fields: [
      { key: "field-1", type: "boolean", title: "Field 1", default: true },
      ...Array.from({ length: 11 }, (_, index) => ({
        key: `field-${index + 2}`,
        type: "boolean" as const,
        title: `Field ${index + 2}`,
        default: index % 2 !== 0,
      })),
    ],
  }
  const app = await testRender(
    () => (
      <RunFormBody
        request={request}
        theme={RUN_THEME_FALLBACK.footer}
        state={{ ...createFormBodyState(request), field: 12 }}
        onReply={() => {}}
        onCancel={() => {}}
      />
    ),
    { width: 24, height: 8, kittyKeyboard: true },
  )
  try {
    await settle(app)
    expect(app.captureCharFrame()).toContain("Field 1: Yes")
    expect(app.captureCharFrame()).not.toContain("Field 12: No")
    app.mockInput.pressKey("\x1b[6~")
    await settle(app)
    expect(app.captureCharFrame()).toContain("Field 12: No")
    expect(app.captureCharFrame()).toContain("enter submit")
  } finally {
    app.renderer.destroy()
  }
})

test("long permission paths, diffs and persistent scopes remain keyboard accessible", async () => {
  const app = await testRender(
    () => (
      <RunPermissionBody
        request={{
          ...permission,
          action: "edit",
          save: [...Array.from({ length: 8 }, (_, index) => `/project/resource-${index}/*`), ...permission.save!],
          resources: ["/project/long/path/to/sensitive/configuration/auth.ts"],
          metadata: {
            diff: "--- a/auth.ts\n+++ b/auth.ts\n@@ -10000,2 +10000,2 @@\n-const allow = false\n+DIFF_SENTINEL\n return allow\n",
          },
        }}
        theme={RUN_THEME_FALLBACK.footer}
        block={RUN_THEME_FALLBACK.block}
        onReply={() => {}}
      />
    ),
    { width: 24, height: 8 },
  )
  try {
    await settle(app)
    const frames = [app.captureCharFrame()]
    for (let index = 0; index < 12; index++) {
      app.mockInput.pressKey("\x1b[6~")
      await settle(app)
      frames.push(app.captureCharFrame())
    }
    expect(frames.join("\n")).toContain("+DIFF_SENTINEL")
    const scroll = descendants(app.renderer.root).find(
      (node): node is ScrollBoxRenderable => node instanceof ScrollBoxRenderable,
    )!
    const top = scroll.scrollTop
    expect(top).toBeGreaterThan(0)
    app.mockInput.pressKey("ARROW_RIGHT")
    await settle(app)
    expect(scroll.scrollTop).toBe(top)
    app.mockInput.pressEnter()
    await settle(app)
    const scopes = [app.captureCharFrame()]
    for (let index = 0; index < 12; index++) {
      app.mockInput.pressKey("\x1b[6~")
      await settle(app)
      scopes.push(app.captureCharFrame())
    }
    expect(scopes.join("\n")).toContain("GRANT_SENTINEL")
    expect(app.captureCharFrame()).toContain("Confirm")
    expect(app.captureCharFrame()).toContain("Cancel")
    const end = scroll.scrollTop
    app.mockInput.pressKey("\x1b[5~")
    await settle(app)
    expect(scroll.scrollTop).toBeLessThan(end)
  } finally {
    app.renderer.destroy()
  }
})

test("scrolling a choice offscreen reveals it before submission and survives resize", async () => {
  const app = await renderForm(form, 24, 8)
  try {
    await settle(app)
    app.mockInput.pressKey("\x1b[6~")
    await settle(app)
    expect(app.captureCharFrame()).not.toMatch(/^1\. Target 1(?: |$)/m)
    app.mockInput.pressEnter()
    await settle(app)
    expect(app.replies).toEqual([])
    expect(app.captureCharFrame()).toMatch(/^1\. Target 1(?: |$)/m)
    for (let index = 0; index < 11; index++) app.mockInput.pressKey("ARROW_DOWN")
    await settle(app)
    for (const size of [
      { width: 80, height: 20 },
      { width: 16, height: 8 },
      { width: 24, height: 8 },
    ]) {
      app.resize(size.width, size.height)
      await settle(app)
      expect(app.captureCharFrame()).toContain("Target 12")
    }
    app.mockInput.pressEnter()
    await settle(app)
    expect(app.replies[0]?.answer).toEqual({ target: "target-12" })
  } finally {
    app.renderer.destroy()
  }
})

test.each([16, 24, 80])("text form keeps its editor, error and controls at %s x 8", async (width) => {
  const app = await testRender(
    () => (
      <Keymap.Provider config={createTuiResolvedConfig()}>
        <RunFormBody
          request={{
            ...form,
            fields: [
              {
                key: "service",
                type: "string",
                title: "Service",
                required: true,
                description:
                  "Choose the service name for deployment. This name will be used to create production resources and route incoming requests to the correct application.",
              },
            ],
          }}
          theme={RUN_THEME_FALLBACK.footer}
          onReply={() => {}}
          onCancel={() => {}}
        />
      </Keymap.Provider>
    ),
    { width, height: 8, kittyKeyboard: true },
  )
  try {
    await settle(app)
    app.mockInput.pressEnter()
    await settle(app)
    expect(app.captureCharFrame()).toContain("Answer required")
    expect(app.captureCharFrame()).toContain("enter save")
    expect(app.captureCharFrame()).toContain("esc dismiss")
    const editor = app.renderer.currentFocusedEditor!
    expect(editor.y).toBeGreaterThan(1)
    expect(editor.y + editor.height).toBeLessThan(8)
    await app.mockInput.typeText("api")
    await settle(app)
    expect(app.captureCharFrame()).toContain("api")
  } finally {
    app.renderer.destroy()
  }
})

test("external form exposes its complete URL and state-specific actions", async () => {
  const opened: string[] = []
  const url = "https://identity.example.test/oauth/authorize?client_id=opencode&redirect_uri=URL_SENTINEL"
  const app = await testRender(
    () => (
      <RunFormBody
        request={{ ...form, fields: [{ key: "auth", type: "external", title: "Sign in", url }] }}
        theme={RUN_THEME_FALLBACK.footer}
        openExternal={async (value) => {
          opened.push(value)
        }}
        onReply={() => {}}
        onCancel={() => {}}
      />
    ),
    { width: 24, height: 8, kittyKeyboard: true },
  )
  try {
    await settle(app)
    expect(app.captureCharFrame()).toContain("enter open URL")
    expect(app.captureCharFrame()).not.toContain("choose")
    for (let index = 0; index < 10; index++) app.mockInput.pressKey("\x1b[6~")
    await settle(app)
    expect(app.captureCharFrame()).toContain("URL_SENTINEL")
    app.mockInput.pressEnter()
    await settle(app)
    expect(opened).toEqual([url])
    expect(app.captureCharFrame()).toContain("enter acknowledge")
  } finally {
    app.renderer.destroy()
  }
})

test.each([false, true])("wrapped permission characters stay outside the scrollbar (mono=%s)", async (mono) => {
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
  const theme = mono ? RUN_THEME_MONO : RUN_THEME_FALLBACK
  const app = await testRender(
    () => (
      <RunPermissionBody
        request={{ ...permission, resources: [alphabet] }}
        theme={theme.footer}
        block={theme.block}
        mono={mono}
        onReply={() => {}}
      />
    ),
    { width: 24, height: 20 },
  )
  try {
    await settle(app)
    const scroll = descendants(app.renderer.root).find(
      (node): node is ScrollBoxRenderable => node instanceof ScrollBoxRenderable,
    )!
    const rows = app
      .captureCharFrame()
      .split("\n")
      .slice(scroll.viewport.y, scroll.viewport.y + scroll.viewport.height)
    expect(rows.map((row) => row.slice(0, mono ? 24 : 23).trim()).join("")).toContain(alphabet)
  } finally {
    app.renderer.destroy()
  }
})

test.each([
  { width: 16, height: 8 },
  { width: 56, height: 8 },
  { width: 56, height: 12 },
  { width: 112, height: 20 },
])("inspector keeps task identity and controls at $width x $height", async (size) => {
  let closed = 0
  const app = await testRender(
    () => (
      <RunFooterSubagentBody
        active={() => true}
        theme={() => RUN_THEME_FALLBACK}
        tab={() => ({ sessionID: "child", label: "Explore", description: "Inspect authentication", status: "running" })}
        index={() => 12}
        total={() => 12}
        detail={() => ({ commits: [{ kind: "system", source: "system", phase: "final", text: "Activity" }] })}
        interrupt={() => "ctrl+d"}
        onCycle={() => {}}
        onClose={() => {
          closed++
        }}
      />
    ),
    { ...size, kittyKeyboard: true },
  )
  try {
    await settle(app)
    expect(app.captureCharFrame()).toContain("Inspect")
    if (size.width < 56 || size.height < 12) expect(app.captureCharFrame()).toContain("esc back")
    else expect(app.captureCharFrame()).toContain("12 of 12")
    expect(app.captureCharFrame()).toContain("ctrl+d interrupt")
    expect(app.captureCharFrame()).toContain("Activity")
    app.mockInput.pressEscape()
    await settle(app)
    expect(closed).toBe(1)
  } finally {
    app.renderer.destroy()
  }
})
