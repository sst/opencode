import { describe, expect, test } from "bun:test"
import {
  MarkdownRenderable,
  SyntaxStyle,
  TextRenderable,
  TextareaRenderable,
  type TreeSitterClient,
} from "@opentui/core"
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing"
import { BidiTextRenderable } from "../../src/component/bidi-text"
import { BidiTextareaRenderable } from "../../src/component/bidi-textarea"
import "../../src/component/bidi-elements"

const WIDTH = 40
const HEIGHT = 12

// Zero-highlight client keeps the markdown tests offline and deterministic:
// chunks still flow through onChunks (our capture hook).
const offlineClient: TreeSitterClient = {
  highlightOnce: async () => ({ highlights: [] }),
} as unknown as TreeSitterClient

function row(frame: string, index: number) {
  // Frames join rows with newlines and cells can hold multi-unit graphemes,
  // so slice by row instead of by fixed character offsets.
  return frame.split("\n")[index] ?? ""
}

function reverseArabic(text: string) {
  return text
    .split(" ")
    .reverse()
    .map((word) => (word === "npm install" ? word : word.split("").reverse().join("")))
    .join(" ")
}

async function withRenderer(run: (setup: TestRendererSetup) => Promise<void>) {
  const setup = await createTestRenderer({ width: WIDTH, height: HEIGHT })
  try {
    await run(setup)
  } finally {
    setup.renderer.destroy()
  }
}

describe("bidi text rendering", () => {
  test("Arabic renders right-aligned in visual RTL order", async () => {
    await withRenderer(async (setup) => {
      const el = new BidiTextRenderable(setup.renderer, { content: "مرحبا بالعالم", width: WIDTH })
      setup.renderer.root.add(el)
      await setup.renderOnce()
      const line = row(setup.captureCharFrame(), 0)
      // Right-aligned: leading padding, content flush with the right edge.
      expect(line.startsWith(" ")).toBe(true)
      expect(line.trimEnd().length).toBe(WIDTH)
      expect(line.trim()).toBe(reverseArabic("مرحبا بالعالم"))
    })
  })

  test("mixed Arabic and English keeps the English run LTR", async () => {
    await withRenderer(async (setup) => {
      const el = new BidiTextRenderable(setup.renderer, { content: "استخدم npm install هنا", width: WIDTH })
      setup.renderer.root.add(el)
      await setup.renderOnce()
      const line = row(setup.captureCharFrame(), 0)
      expect(line).toContain("npm install")
      expect(line.trimEnd().endsWith("مدختسا")).toBe(true)
    })
  })

  test("English-only output is identical to the stock text renderer", async () => {
    const english = "the quick brown fox jumps over the lazy dog again"
    const stockFrame = await withRendererFrame(async (setup) => {
      const el = new TextRenderable(setup.renderer, { content: english, width: WIDTH })
      setup.renderer.root.add(el)
      await setup.renderOnce()
      return setup.captureCharFrame()
    })
    const bidiFrame = await withRendererFrame(async (setup) => {
      const el = new BidiTextRenderable(setup.renderer, { content: english, width: WIDTH })
      setup.renderer.root.add(el)
      await setup.renderOnce()
      return setup.captureCharFrame()
    })
    expect(bidiFrame).toBe(stockFrame)
  })

  test("logical text is preserved for copy/paste and wrapping sync", async () => {
    await withRenderer(async (setup) => {
      const el = new BidiTextRenderable(setup.renderer, { content: "مرحبا بالعالم", width: WIDTH })
      setup.renderer.root.add(el)
      await setup.renderOnce()
      // The native buffer holds the wrapped logical text, never reordered
      // or control-polluted characters.
      expect(el.plainText).toBe("مرحبا بالعالم")
      expect(el.plainText).not.toContain("\u2066")
    })
  })
})

async function withRendererFrame(run: (setup: TestRendererSetup) => Promise<string>) {
  const setup = await createTestRenderer({ width: WIDTH, height: HEIGHT })
  try {
    return await run(setup)
  } finally {
    setup.renderer.destroy()
  }
}

describe("bidi markdown rendering", () => {
  test("Arabic paragraph renders RTL and right-aligned", async () => {
    await withRenderer(async (setup) => {
      const el = new MarkdownRenderable(setup.renderer, {
        content: "مرحبا بالعالم",
        syntaxStyle: SyntaxStyle.create(),
        treeSitterClient: offlineClient,
      })
      setup.renderer.root.add(el)
      await setup.renderOnce()
      await setup.renderOnce()
      const line = row(setup.captureCharFrame(), 0)
      expect(line.replace(/\s+$/, "").length).toBe(WIDTH)
      expect(line).toContain(reverseArabic("مرحبا بالعالم"))
    })
  })

  test("fenced code blocks stay LTR and left-aligned", async () => {
    await withRenderer(async (setup) => {
      const el = new MarkdownRenderable(setup.renderer, {
        content: "```ts\nconst value = 42\n```",
        syntaxStyle: SyntaxStyle.create(),
        treeSitterClient: offlineClient,
      })
      setup.renderer.root.add(el)
      await setup.renderOnce()
      await setup.renderOnce()
      const line = row(setup.captureCharFrame(), 0)
      expect(line.startsWith("const value = 42")).toBe(true)
    })
  })

  test("Arabic paragraph with inline code keeps the code LTR", async () => {
    await withRenderer(async (setup) => {
      const el = new MarkdownRenderable(setup.renderer, {
        content: "استخدم `npm install` لتثبيت الحزمة",
        syntaxStyle: SyntaxStyle.create(),
        treeSitterClient: offlineClient,
      })
      setup.renderer.root.add(el)
      await setup.renderOnce()
      await setup.renderOnce()
      const line = row(setup.captureCharFrame(), 0)
      expect(line).toContain("npm install")
      expect(line.trimEnd().endsWith("مدختسا")).toBe(true)
    })
  })

  test("style-only re-highlight keeps painting RTL without crashing", async () => {
    await withRenderer(async (setup) => {
      const el = new MarkdownRenderable(setup.renderer, {
        content: "مرحبا بالعالم",
        syntaxStyle: SyntaxStyle.create(),
        treeSitterClient: offlineClient,
      })
      setup.renderer.root.add(el)
      await setup.renderOnce()
      await setup.renderOnce()
      // A theme change re-runs tree-sitter with identical text; the patched
      // block must rebuild from the new chunks instead of painting stale
      // (or missing) layout state.
      el.syntaxStyle = SyntaxStyle.create()
      await setup.renderOnce()
      await setup.renderOnce()
      const line = row(setup.captureCharFrame(), 0)
      expect(line).toContain(reverseArabic("مرحبا بالعالم"))
    })
  })
})

describe("bidi textarea rendering", () => {
  test("Arabic prompt renders RTL while the value stays logical", async () => {
    await withRenderer(async (setup) => {
      const el = new BidiTextareaRenderable(setup.renderer, { width: WIDTH })
      setup.renderer.root.add(el)
      el.focus()
      el.insertText("ازيك يا صاحبي")
      await setup.renderOnce()
      const line = row(setup.captureCharFrame(), 0)
      // Visual order is the RTL sequence aligned to the right edge.
      expect(line.replace(/\s+$/, "").length).toBe(WIDTH)
      expect(line).toContain(
        "ازيك يا صاحبي".split(" ").reverse().map((w) => w.split("").reverse().join("")).join(" "),
      )
      // The underlying value is untouched logical Unicode.
      expect(el.plainText).toBe("ازيك يا صاحبي")
    })
  })

  test("tashkeel travels with its base letter in the prompt", async () => {
    await withRenderer(async (setup) => {
      const el = new BidiTextareaRenderable(setup.renderer, { width: WIDTH })
      setup.renderer.root.add(el)
      el.focus()
      el.insertText("نفّذ")
      await setup.renderOnce()
      const line = row(setup.captureCharFrame(), 0)
      expect(line).toContain("ذفّن")
      expect(el.plainText).toBe("نفّذ")
    })
  })

  test("English prompt renders exactly like the stock textarea", async () => {
    const stock = await withRendererFrame(async (setup) => {
      const el = new TextareaRenderable(setup.renderer, { width: WIDTH })
      setup.renderer.root.add(el)
      el.focus()
      el.insertText("hello world")
      await setup.renderOnce()
      return setup.captureCharFrame()
    })
    const bidi = await withRendererFrame(async (setup) => {
      const el = new BidiTextareaRenderable(setup.renderer, { width: WIDTH })
      setup.renderer.root.add(el)
      el.focus()
      el.insertText("hello world")
      await setup.renderOnce()
      return setup.captureCharFrame()
    })
    expect(bidi).toBe(stock)
  })

  test("caret sits at the text's visual left edge for the logical end of RTL", async () => {
    await withRenderer(async (setup) => {
      const el = new BidiTextareaRenderable(setup.renderer, { width: WIDTH })
      setup.renderer.root.add(el)
      el.focus()
      el.insertText("ازيك يا صاحبي")
      await setup.renderOnce()
      // Logical end of an RTL line is the visually leftmost point of the
      // right-aligned text: width - lineWidth + 1 in 1-based columns.
      const lineWidth = Bun.stringWidth("ازيك يا صاحبي")
      const cursor = setup.captureSpans().cursor
      expect(cursor[0]).toBe(WIDTH - lineWidth + 1)
    })
  })

  test("arrow keys move the caret visually", async () => {
    await withRenderer(async (setup) => {
      const el = new BidiTextareaRenderable(setup.renderer, { width: WIDTH })
      setup.renderer.root.add(el)
      el.focus()
      el.insertText("استخدم npm install هنا")
      await setup.renderOnce()
      // After typing, the caret is at the logical end, which is the visually
      // leftmost point of the right-aligned RTL text.
      const start = setup.captureSpans().cursor[0]
      // Arrow-right steps visually right into the text (logically backward).
      el.moveCursorRight()
      await setup.renderOnce()
      const afterRight = setup.captureSpans().cursor[0]
      expect(afterRight).toBeGreaterThan(start)
      // Arrow-left returns visually left toward the logical end.
      el.moveCursorLeft()
      await setup.renderOnce()
      const afterLeft = setup.captureSpans().cursor[0]
      expect(afterLeft).toBe(start)
    })
  })

  test("selection copy returns logical text", async () => {
    await withRenderer(async (setup) => {
      const el = new BidiTextareaRenderable(setup.renderer, { width: WIDTH })
      setup.renderer.root.add(el)
      el.focus()
      el.insertText("استخدم npm install هنا")
      el.setSelection(0, 6)
      await setup.renderOnce()
      // Selection copy is logical Unicode, never visual order.
      expect(el.getSelectedText()).toBe("استخدم")
    })
  })
})
