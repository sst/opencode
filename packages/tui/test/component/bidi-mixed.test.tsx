import { describe, expect, test } from "bun:test"
import { MarkdownRenderable, SyntaxStyle, type TreeSitterClient } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import "../../src/component/bidi-elements"

// Regression coverage for mixed-direction paragraphs: Arabic prose carrying
// LTR runs (code spans, commands, dotted identifiers, Windows paths with
// spaces, URLs, versions, key:line references) plus Markdown punctuation.
// Every LTR run must survive as one contiguous visual LTR segment while the
// Arabic around it stays RTL and right-aligned. Logical text is never
// rewritten: the assertions below look for the exact logical LTR substrings
// in the painted frame.
const WIDTH = 80
const HEIGHT = 24

// Zero-highlight client keeps the tests offline and deterministic.
const offlineClient: TreeSitterClient = {
  highlightOnce: async () => ({ highlights: [] }),
} as unknown as TreeSitterClient

async function frameFor(content: string, width = WIDTH) {
  const setup = await createTestRenderer({ width, height: HEIGHT })
  try {
    const el = new MarkdownRenderable(setup.renderer, {
      content,
      syntaxStyle: SyntaxStyle.create(),
      treeSitterClient: offlineClient,
      streaming: true,
      conceal: true,
    })
    setup.renderer.root.add(el)
    await setup.renderOnce()
    await setup.renderOnce()
    await setup.renderOnce()
    return setup.captureCharFrame().split("\n")
  } finally {
    setup.renderer.destroy()
  }
}

function reverseArabic(text: string) {
  return text
    .split(" ")
    .reverse()
    .map((word) => word.split("").reverse().join(""))
    .join(" ")
}

describe("mixed-direction markdown paragraphs", () => {
  test("code spans keep logical word order inside backticks", async () => {
    const rows = await frameFor("شغّل `npm install opencode-rtl` ثم افتح `package.json`")
    const row = rows.find((line) => line.includes("npm"))!
    expect(row).toContain("`npm install opencode-rtl`")
    expect(row).toContain("`package.json`")
  })

  test("bold markers and version code spans stay attached", async () => {
    const rows = await frameFor("**السبب:** النسخة `0.1.9` بتصدر")
    const row = rows.find((line) => line.includes("0.1.9"))!
    expect(row).toContain("`0.1.9`")
    expect(row).toContain("**:ببسلا**")
    expect(row.match(/\*\*/g)?.length).toBe(2)
  })

  test("code span with braces, slash and comma stays one LTR unit", async () => {
    const rows = await frameFor("بيطلب `default { id, effect/setup }` الآن")
    const row = rows.find((line) => line.includes("default"))!
    expect(row).toContain("`default { id, effect/setup }`")
  })

  test("windows path with a space stays one visual run when it fits", async () => {
    const rows = await frameFor("افتح `C:\\Users\\Muhamed beshir\\.config\\opencode\\opencode.json` الآن")
    const row = rows.find((line) => line.includes("C:\\Users"))!
    expect(row).toContain("C:\\Users\\Muhamed beshir\\.config\\opencode\\opencode.json")
  })

  test("windows path wrapping continues in logical order", async () => {
    const rows = await frameFor("افتح `C:\\Users\\Muhamed beshir\\.config\\opencode\\opencode.json` الآن", 40)
    const first = rows.findIndex((line) => line.includes("C:\\Users\\Muhamed"))
    const second = rows.findIndex((line) => line.includes("beshir\\.config"))
    expect(first).toBeGreaterThanOrEqual(0)
    expect(second).toBeGreaterThan(first)
    expect(rows[first]).toContain("C:\\Users\\Muhamed")
    expect(rows[second]).toContain("beshir\\.config\\opencode\\opencode.json")
  })

  test("key:line references stay attached", async () => {
    const rows = await frameFor("شوف `opencode.json:3` هناك")
    const row = rows.find((line) => line.includes("opencode.json"))!
    expect(row).toContain("opencode.json:3")
  })

  test("urls stay one LTR run", async () => {
    const rows = await frameFor("حمّل https://example.com/docs/x ثم تابع")
    const row = rows.find((line) => line.includes("https://"))!
    expect(row).toContain("https://example.com/docs/x")
  })

  test("code spans containing Arabic are not pinned left-to-right", async () => {
    const rows = await frameFor("نفّذ `الأمر` الآن")
    // Grapheme-correct visual of نفّذ is ذفّن: the shadda travels with its
    // base letter instead of being dropped or detached.
    const row = rows.find((line) => line.includes("ذفّن"))!
    expect(row).toContain(reverseArabic("الأمر"))
    expect(row).not.toContain("الأمر")
  })

  test("tashkeel travels with its base letter", async () => {
    const rows = await frameFor("قال حمّل الملف")
    const row = rows.find((line) => line.includes("لمّح"))!
    expect(row).toContain("لمّح")
  })

  test("long mixed paragraph keeps every token intact and stays right-aligned", async () => {
    const rows = await frameFor(
      "**السبب:** النسخة `0.1.9` بتصدر `default { id, server }` لكن `opencode` بيطلب `default { id, effect/setup }` عشان `err_4462d8c`",
      60,
    )
    const text = rows.join("\n")
    for (const token of [
      "`0.1.9`",
      "`default { id, server }`",
      "`opencode`",
      "`default { id, effect/setup }`",
      "`err_4462d8c`",
    ]) {
      expect(text).toContain(token)
    }
    const first = rows[0]
    expect(first.replace(/\s+$/, "").length).toBe(60)
  })

  test("audit: bare english words at the end of a sentence", async () => {
    const rows = await frameFor("احفظ التغييرات ثم شغّل npm install")
    const row = rows.find((line) => line.includes("npm install"))!
    expect(row).toContain("npm install")
    // An RTL paragraph ending in English puts that run at the visual left,
    // after the right-alignment padding.
    expect(row.trimStart().startsWith("npm install")).toBe(true)
  })

  test("audit: dotted path mid-sentence", async () => {
    const rows = await frameFor("افتح الملف src/components/Button.tsx ثم عدّل الزر")
    const row = rows.find((line) => line.includes("src/components/Button.tsx"))!
    expect(row).toContain("src/components/Button.tsx")
  })

  test("audit: curly-quoted english phrase", async () => {
    const rows = await frameFor("اضغط على \u201CSave framing\u201D ثم أكمل")
    const row = rows.find((line) => line.includes("Save framing"))!
    expect(row).toContain("Save framing")
  })

  test("audit: numbers and windows path without spaces", async () => {
    const rows = await frameFor("تم حفظ 25 ملف في C:\\Users\\Muhamed\\project")
    const text = rows.join("\n")
    expect(text).toContain("25")
    expect(text).toContain("C:\\Users\\Muhamed\\project")
  })

  test("audit: numbers amid arabic words", async () => {
    const rows = await frameFor("تم العثور على 131 مشكلة و15 اختبار")
    const text = rows.join("\n")
    expect(text).toContain("131")
    expect(text).toContain("15")
    expect(text).toContain("ةلكشم")
    expect(text).toContain("رابتخا")
  })

  test("audit: bold heading plus command code span", async () => {
    const rows = await frameFor("**تم الحفظ بنجاح** ثم شغّل `npm test`")
    const text = rows.join("\n")
    expect(text).toContain("`npm test`")
    expect(text.match(/\*\*/g)?.length).toBe(2)
  })

  test("audit: list item with code span", async () => {
    const rows = await frameFor("- عنصر عربي مع `code` ثم كلام")
    const row = rows.find((line) => line.includes("code"))!
    expect(row).toContain("`code`")
  })

  test("audit: list item with link keeps the url intact", async () => {
    const rows = await frameFor("- [رابط عربي](https://example.com) هنا")
    const row = rows.find((line) => line.includes("https://example.com"))!
    expect(row).toContain("https://example.com")
  })

  test("audit: parens, percent, arrow and numbers", async () => {
    const rows = await frameFor("دعم (CORS) الكامل 100% → تم")
    const text = rows.join("\n")
    expect(text).toContain("CORS")
    expect(text).toContain("100%")
    expect(text).toContain("→")
  })

  test("audit: kitchen sink wrapped across lines", async () => {
    const rows = await frameFor("دعم (CORS) الكامل `src/app.js:10` بنسبة 100% → تم `npm test` الآن", 40)
    const text = rows.join("\n")
    for (const token of ["CORS", "src/app.js:10", "100%", "→", "npm test"]) {
      expect(text).toContain(token)
    }
    expect(rows[0].replace(/\s+$/, "").length).toBe(40)
  })

  test("audit: tool output prose keeps mixed runs ordered", async () => {
    const setup = await createTestRenderer({ width: 80, height: 8 })
    try {
      const { BidiTextRenderable } = await import("../../src/component/bidi-text")
      const el = new BidiTextRenderable(setup.renderer, {
        content: "فشل errorHandler في `config.json:3`",
        width: 80,
      })
      setup.renderer.root.add(el)
      await setup.renderOnce()
      const row = setup.captureCharFrame().split("\n")[0]
      expect(row).toContain("errorHandler")
      expect(row).toContain("config.json:3")
    } finally {
      setup.renderer.destroy()
    }
  })

  test("audit: diff lines keep code structure with arabic comments readable", async () => {
    const setup = await createTestRenderer({ width: 80, height: 8 })
    try {
      const { DiffRenderable } = await import("@opentui/core")
      const el = new DiffRenderable(setup.renderer, {
        diff: "--- a/f.js\n+++ b/f.js\n@@ -1 +1 @@\n-// hello\n+// مرحبا بالعالم\n",
        syntaxStyle: SyntaxStyle.create(),
      })
      setup.renderer.root.add(el)
      await setup.renderOnce()
      await setup.renderOnce()
      const text = setup.captureCharFrame()
      expect(text).toContain("// hello")
      expect(text).toContain("ملاعلاب ابحرم")
    } finally {
      setup.renderer.destroy()
    }
  })
})
