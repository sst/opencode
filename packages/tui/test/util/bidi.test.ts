import { describe, expect, test } from "bun:test"
import {
  boundaryToLogicalCursor,
  boundaryToVisual,
  hasRtl,
  layoutBidiText,
  logicalCursorToBoundary,
  visualStep,
  visualToBoundary,
  wrappedLogicalText,
  type BidiLayout,
} from "../../src/util/bidi"

function visualText(layout: BidiLayout, line = 0) {
  return layout.lines[line].cells.map((cell) => cell.char).join("")
}

// The terminal paints cells left to right, so a correct RTL rendering shows
// the word order reversed and each RTL word's characters reversed, while LTR
// islands stay intact.
function rtlVisual(text: string) {
  return text
    .split(" ")
    .reverse()
    .map((word) => (hasRtl(word) ? word.split("").reverse().join("") : word))
    .join(" ")
}

describe("bidi direction detection", () => {
  test("English-only text is not RTL and needs no bidi work", () => {
    expect(hasRtl("hello world")).toBe(false)
    expect(hasRtl("use npm install src/components/Button.tsx https://example.com 25 files")).toBe(false)
  })

  test("Arabic, Persian and Hebrew are detected", () => {
    expect(hasRtl("مرحبا بالعالم")).toBe(true)
    expect(hasRtl("سلام دنیا")).toBe(true)
    expect(hasRtl("שלום עולם")).toBe(true)
    expect(hasRtl("اردو")).toBe(true)
  })

  test("paragraph direction follows the first strong character", () => {
    // A paragraph is not RTL merely because it contains an English
    // identifier; the Arabic first strong character wins.
    const arabic = layoutBidiText("استخدم npm install لتثبيت الحزمة", 80)
    expect(arabic.lines[0].rtl).toBe(true)

    // An English-led paragraph stays LTR; the embedded Arabic word itself
    // renders as a reversed RTL run.
    const english = layoutBidiText("hello مرحبا world", 80)
    expect(english.lines[0].rtl).toBe(false)
    expect(english.lines[0].cells.map((c) => c.char).join("")).toBe("hello ابحرم world")
  })
})

describe("bidi visual ordering", () => {
  test("Arabic only reads right to left", () => {
    const layout = layoutBidiText("مرحبا بالعالم", 80)
    expect(layout.lines).toHaveLength(1)
    expect(layout.lines[0].rtl).toBe(true)
    expect(visualText(layout)).toBe(rtlVisual("مرحبا بالعالم"))
  })

  test("Arabic + English keeps embedded English words in natural bidi flow", () => {
    const layout = layoutBidiText("استخدم npm install لتثبيت الحزمة", 80)
    const visual = visualText(layout)
    expect(visual).toContain("npm install")
    // The sentence reads RTL: the trailing Arabic segment sits on the visual
    // left, the leading Arabic on the visual right.
    expect(visual.startsWith("ةمزحلا")).toBe(true)
    expect(visual.endsWith("مدختسا")).toBe(true)
  })

  test("Arabic + filename treats the path as an LTR isolate", () => {
    const layout = layoutBidiText("عدّل src/components/Button.tsx ثم عدّل الزر", 80)
    expect(visualText(layout)).toContain("src/components/Button.tsx")
  })

  test("Arabic + URL treats the URL as an LTR isolate", () => {
    const layout = layoutBidiText("افتح https://example.com", 80)
    const visual = visualText(layout)
    expect(visual).toContain("https://example.com")
    expect(visual.endsWith("حتفا")).toBe(true)
  })

  test("Arabic + numbers keeps digits grouped", () => {
    const layout = layoutBidiText("تم تحميل 25 ملف", 80)
    expect(visualText(layout)).toContain("25")
  })

  test("backtick code spans stay LTR inside Arabic", () => {
    const layout = layoutBidiText("استخدم `npm install` هنا", 80)
    const visual = visualText(layout)
    expect(visual).toContain("npm install")
  })

  test("brackets mirror in RTL runs", () => {
    const layout = layoutBidiText("(مرحبا)", 80)
    const visual = visualText(layout)
    // Reading RTL: the opening paren sits at the visual right rendered as a
    // mirrored ")" glyph and vice versa, hugging the reversed word.
    expect(visual).toBe("(ابحرم)")
  })

  test("isolate controls never leak into rendered cells or wrapped text", () => {
    const layout = layoutBidiText("افتح https://example.com من هنا", 80)
    for (const line of layout.lines) {
      for (const cell of line.cells) {
        expect(cell.char).not.toBe("\u2066")
        expect(cell.char).not.toBe("\u2069")
      }
    }
    expect(wrappedLogicalText(layout)).not.toContain("\u2066")
    expect(wrappedLogicalText(layout)).not.toContain("\u2069")
  })
})

describe("bidi wrapping", () => {
  test("Arabic wraps across multiple lines without scrambling", () => {
    const layout = layoutBidiText("هذا نص عربي طويل يجب أن يلتف على عدة أسطر عند العرض داخل نافذة صغيرة", 20)
    expect(layout.lines.length).toBeGreaterThan(2)
    for (const line of layout.lines) {
      expect(line.rtl).toBe(true)
      expect(line.width).toBeLessThanOrEqual(20)
    }
    // Every glyph appears at most once and every non-whitespace glyph is
    // painted somewhere; whitespace at wrap points is legitimately trimmed.
    const painted = layout.lines.flatMap((line) => line.cells.map((c) => c.glyph))
    expect(new Set(painted).size).toBe(painted.length)
    const expected = layout.glyphs
      .map((_, index) => index)
      .filter((index) => !layout.glyphs[index].newline && layout.glyphs[index].char.trim() !== "")
    for (const index of expected) expect(painted).toContain(index)
  })

  test("wrapped logical text preserves the original characters", () => {
    const source = "استخدم npm install لتثبيت الحزمة"
    const layout = layoutBidiText(source, 12)
    const wrapped = wrappedLogicalText(layout)
    // Joining the wrap lines reproduces the source modulo whitespace that
    // lives at the wrap points.
    expect(wrapped.replace(/\s+/g, " ").trim()).toBe(source.replace(/\s+/g, " ").trim())
  })

  test("English-only wrapping is untouched logical order", () => {
    const layout = layoutBidiText("the quick brown fox jumps over the lazy dog", 12)
    for (const line of layout.lines) {
      expect(line.rtl).toBe(false)
      expect(line.cells.map((c) => c.char).join("")).toBe(
        layout.glyphs.slice(line.start, line.end).map((g) => g.char).join(""),
      )
    }
  })
})

describe("bidi cursor mapping", () => {
  test("logical and visual cursor positions map inversely", () => {
    const layout = layoutBidiText("ازيك يا صاحبي", 80)
    for (let boundary = 0; boundary <= layout.glyphs.length; boundary++) {
      const logical = boundaryToLogicalCursor(layout, boundary)
      const roundTrip = logicalCursorToBoundary(layout, logical.row, logical.col)
      expect(roundTrip).toBe(boundary)
    }
  })

  test("RTL logical start is the visual right edge and vice versa", () => {
    const layout = layoutBidiText("ازيك يا صاحبي", 80)
    const line = layout.lines[0]
    const start = boundaryToVisual(layout, 0)
    const end = boundaryToVisual(layout, layout.glyphs.length)
    expect(start.col).toBe(line.width)
    expect(end.col).toBe(0)
  })

  test("arrow stepping moves through visual columns monotonically", () => {
    const layout = layoutBidiText("استخدم npm install هنا", 80)
    let boundary = logicalCursorToBoundary(layout, 0, Number.MAX_SAFE_INTEGER)
    let col = boundaryToVisual(layout, boundary).col
    const cols: number[] = []
    for (let step = 0; step < layout.glyphs.length + 2; step++) {
      const next = visualStep(layout, boundary, 1)
      const nextCol = boundaryToVisual(layout, next).col
      if (next === boundary) break
      cols.push(nextCol)
      expect(nextCol).toBeGreaterThanOrEqual(col)
      col = nextCol
      boundary = next
    }
    // The caret can walk the entire line; boundaries that share a visual
    // column (zero-width adjacency) may be snapped over.
    expect(cols.length).toBeGreaterThanOrEqual(Math.floor(layout.glyphs.length / 2))
    // Stepping left reverses the walk.
    for (let step = 0; step < cols.length; step++) {
      const back = visualStep(layout, boundary, -1)
      if (back === boundary) break
      boundary = back
    }
    const logical = boundaryToLogicalCursor(layout, boundary)
    expect(logical.row).toBe(0)
  })

  test("visual column maps back to a nearby boundary", () => {
    const layout = layoutBidiText("استخدم npm install هنا", 80)
    const boundary = visualToBoundary(layout, 0, 5)
    const back = boundaryToVisual(layout, boundary)
    expect(Math.abs(back.col - 5)).toBeLessThanOrEqual(1)
  })
})
