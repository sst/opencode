import { describe, test, expect, beforeAll, afterEach, spyOn } from "bun:test"
import { Terminal, Ghostty } from "ghostty-web"
import { SerializeAddon } from "./serialize"

let ghostty: Ghostty
beforeAll(async () => {
  ghostty = await Ghostty.load()
})

const terminals: Terminal[] = []

afterEach(() => {
  for (const term of terminals) {
    term.dispose()
  }
  terminals.length = 0
  document.body.innerHTML = ""
})

function createTerminal(cols = 80, rows = 24): { term: Terminal; addon: SerializeAddon; container: HTMLElement } {
  const container = document.createElement("div")
  document.body.appendChild(container)

  const term = new Terminal({ cols, rows, ghostty })
  const addon = new SerializeAddon()
  term.loadAddon(addon)
  term.open(container)
  terminals.push(term)

  return { term, addon, container }
}

function writeAndWait(term: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => {
    term.write(data, resolve)
  })
}

describe("SerializeAddon", () => {
  test("reuses cells across style changes without rereading their rows", async () => {
    const { term, addon } = createTerminal(20, 5)
    await writeAndWait(term, "\x1b[31mred\x1b[32mgreen\x1b[0m\r\n\x1b[1;44mbold\x1b[0m")
    const reads = spyOn(term.buffer.normal, "getLine")
    const serialized = addon.serialize({ range: { start: 0, end: 1 } })
    expect(reads.mock.calls.map((args) => args[0])).toEqual([0, 1, 1])
    reads.mockRestore()

    const restored = createTerminal(20, 5)
    await writeAndWait(restored.term, serialized)
    for (let row = 0; row < 2; row++) {
      const original = term.buffer.normal.getLine(row)!
      const replayed = restored.term.buffer.normal.getLine(row)!
      expect(replayed.translateToString()).toBe(original.translateToString())
      for (let col = 0; col < 20; col++) {
        const before = original.getCell(col)!
        const after = replayed.getCell(col)!
        expect([after.getFgColor(), after.getBgColor(), after.isBold()]).toEqual([
          before.getFgColor(),
          before.getBgColor(),
          before.isBold(),
        ])
      }
    }
  })

  describe("scrollback option", () => {
    test("reads only the requested tail and restores the cursor on its screen row", async () => {
      const { term, addon } = createTerminal(20, 5)
      await writeAndWait(term, Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\r\n"))
      await writeAndWait(term, "\x1b[2A\x1b[3G")
      expect(term.buffer.normal.length).toBe(30)
      expect([term.buffer.normal.cursorX, term.buffer.normal.cursorY]).toEqual([2, 2])

      const reads = spyOn(term.buffer.normal, "getLine")
      const serialized = addon.serialize({ scrollback: 3 })
      expect(new Set(reads.mock.calls.map((args) => args[0]))).toEqual(new Set([22, 23, 24, 25, 26, 27, 28, 29]))
      reads.mockRestore()

      const restored = createTerminal(20, 5)
      await writeAndWait(restored.term, serialized)
      expect(restored.term.getScrollbackLength()).toBe(3)
      for (let row = 0; row < 8; row++) {
        expect(restored.term.buffer.normal.getLine(row)?.translateToString(true)).toBe(`line ${22 + row}`)
      }
      expect([restored.term.buffer.normal.cursorX, restored.term.buffer.normal.cursorY]).toEqual([2, 2])
    })

    test("serializes the whole buffer when it has fewer rows than requested", async () => {
      const { term, addon } = createTerminal(20, 5)
      await writeAndWait(term, Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\r\n"))

      expect(addon.serialize({ scrollback: 100 })).toBe(addon.serialize())
    })
  })

  test("preserves color scheme reporting mode", async () => {
    const { term, addon } = createTerminal()
    await writeAndWait(term, "\x1b[?2031h")

    expect(addon.serialize().startsWith("\x1b[?2031h")).toBe(true)
    expect(addon.serialize({ excludeModes: true }).startsWith("\x1b[?2031h")).toBe(false)
  })

  describe("ANSI color preservation", () => {
    test("should preserve text attributes (bold, italic, underline)", async () => {
      const { term, addon } = createTerminal()

      const input = "\x1b[1mBOLD\x1b[0m \x1b[3mITALIC\x1b[0m \x1b[4mUNDER\x1b[0m"
      await writeAndWait(term, input)

      const origLine = term.buffer.active.getLine(0)
      expect(origLine!.getCell(0)!.isBold()).toBe(1)
      expect(origLine!.getCell(5)!.isItalic()).toBe(1)
      expect(origLine!.getCell(12)!.isUnderline()).toBe(1)

      const serialized = addon.serialize({ range: { start: 0, end: 0 } })

      const { term: term2 } = createTerminal()
      terminals.push(term2)
      await writeAndWait(term2, serialized)

      const line = term2.buffer.active.getLine(0)

      const boldCell = line!.getCell(0)
      expect(boldCell!.getChars()).toBe("B")
      expect(boldCell!.isBold()).toBe(1)

      const italicCell = line!.getCell(5)
      expect(italicCell!.getChars()).toBe("I")
      expect(italicCell!.isItalic()).toBe(1)

      const underCell = line!.getCell(12)
      expect(underCell!.getChars()).toBe("U")
      expect(underCell!.isUnderline()).toBe(1)
    })

    test("should preserve basic 16-color foreground colors", async () => {
      const { term, addon } = createTerminal()

      const input = "\x1b[31mRED\x1b[32mGREEN\x1b[34mBLUE\x1b[0mNORMAL"
      await writeAndWait(term, input)

      const origLine = term.buffer.active.getLine(0)
      const origRedFg = origLine!.getCell(0)!.getFgColor()
      const origGreenFg = origLine!.getCell(3)!.getFgColor()
      const origBlueFg = origLine!.getCell(8)!.getFgColor()

      const serialized = addon.serialize({ range: { start: 0, end: 0 } })

      const { term: term2 } = createTerminal()
      terminals.push(term2)
      await writeAndWait(term2, serialized)

      const line = term2.buffer.active.getLine(0)
      expect(line).toBeDefined()

      const redCell = line!.getCell(0)
      expect(redCell!.getChars()).toBe("R")
      expect(redCell!.getFgColor()).toBe(origRedFg)

      const greenCell = line!.getCell(3)
      expect(greenCell!.getChars()).toBe("G")
      expect(greenCell!.getFgColor()).toBe(origGreenFg)

      const blueCell = line!.getCell(8)
      expect(blueCell!.getChars()).toBe("B")
      expect(blueCell!.getFgColor()).toBe(origBlueFg)
    })

    test("should preserve 256-color palette colors", async () => {
      const { term, addon } = createTerminal()

      const input = "\x1b[38;5;196mRED256\x1b[0mNORMAL"
      await writeAndWait(term, input)

      const origLine = term.buffer.active.getLine(0)
      const origRedFg = origLine!.getCell(0)!.getFgColor()

      const serialized = addon.serialize({ range: { start: 0, end: 0 } })

      const { term: term2 } = createTerminal()
      terminals.push(term2)
      await writeAndWait(term2, serialized)

      const line = term2.buffer.active.getLine(0)
      const redCell = line!.getCell(0)
      expect(redCell!.getChars()).toBe("R")
      expect(redCell!.getFgColor()).toBe(origRedFg)
    })

    test("should preserve RGB/truecolor colors", async () => {
      const { term, addon } = createTerminal()

      const input = "\x1b[38;2;255;128;64mRGB_TEXT\x1b[0mNORMAL"
      await writeAndWait(term, input)

      const origLine = term.buffer.active.getLine(0)
      const origRgbFg = origLine!.getCell(0)!.getFgColor()

      const serialized = addon.serialize({ range: { start: 0, end: 0 } })

      const { term: term2 } = createTerminal()
      terminals.push(term2)
      await writeAndWait(term2, serialized)

      const line = term2.buffer.active.getLine(0)
      const rgbCell = line!.getCell(0)
      expect(rgbCell!.getChars()).toBe("R")
      expect(rgbCell!.getFgColor()).toBe(origRgbFg)
    })

    test("should preserve background colors", async () => {
      const { term, addon } = createTerminal()

      const input = "\x1b[48;2;255;0;0mRED_BG\x1b[48;2;0;255;0mGREEN_BG\x1b[0mNORMAL"
      await writeAndWait(term, input)

      const origLine = term.buffer.active.getLine(0)
      const origRedBg = origLine!.getCell(0)!.getBgColor()
      const origGreenBg = origLine!.getCell(6)!.getBgColor()

      const serialized = addon.serialize({ range: { start: 0, end: 0 } })

      const { term: term2 } = createTerminal()
      terminals.push(term2)
      await writeAndWait(term2, serialized)

      const line = term2.buffer.active.getLine(0)

      const redBgCell = line!.getCell(0)
      expect(redBgCell!.getChars()).toBe("R")
      expect(redBgCell!.getBgColor()).toBe(origRedBg)

      const greenBgCell = line!.getCell(6)
      expect(greenBgCell!.getChars()).toBe("G")
      expect(greenBgCell!.getBgColor()).toBe(origGreenBg)
    })

    test("should handle combined colors and attributes", async () => {
      const { term, addon } = createTerminal()

      const input =
        "\x1b[1;38;2;255;0;0;48;2;255;255;0mCOMBO\x1b[0mNORMAL                                                                    "
      await writeAndWait(term, input)

      const origLine = term.buffer.active.getLine(0)
      const _origFg = origLine!.getCell(0)!.getFgColor()
      const _origBg = origLine!.getCell(0)!.getBgColor()
      expect(origLine!.getCell(0)!.isBold()).toBe(1)

      const serialized = addon.serialize({ range: { start: 0, end: 0 } })
      const cleanSerialized = serialized.replace(/\x1b\[\d+X/g, "")

      expect(cleanSerialized.startsWith("\x1b[1;")).toBe(true)

      const { term: term2 } = createTerminal()
      terminals.push(term2)
      await writeAndWait(term2, cleanSerialized)

      const line = term2.buffer.active.getLine(0)
      const comboCell = line!.getCell(0)

      expect(comboCell!.getChars()).toBe("C")
      expect(cleanSerialized).toContain("\x1b[1;38;2;255;0;0;48;2;255;255;0m")
    })
  })

  describe("round-trip serialization", () => {
    test("should not produce ECH sequences", async () => {
      const { term, addon } = createTerminal()

      await writeAndWait(term, "\x1b[31mHello\x1b[0m World")

      const serialized = addon.serialize()

      const hasECH = /\x1b\[\d+X/.test(serialized)
      expect(hasECH).toBe(false)
    })

    test("multi-line content should not have garbage characters", async () => {
      const { term, addon } = createTerminal()

      const content = [
        "\x1b[1;32m❯\x1b[0m \x1b[34mcd\x1b[0m /some/path",
        "\x1b[1;32m❯\x1b[0m \x1b[34mls\x1b[0m -la",
        "total 42",
      ].join("\r\n")

      await writeAndWait(term, content)

      const serialized = addon.serialize()

      expect(/\x1b\[\d+X/.test(serialized)).toBe(false)

      const { term: term2 } = createTerminal()
      terminals.push(term2)
      await writeAndWait(term2, serialized)

      for (let row = 0; row < 3; row++) {
        const line = term2.buffer.active.getLine(row)?.translateToString(true)
        expect(line?.includes("𑼝")).toBe(false)
      }

      expect(term2.buffer.active.getLine(0)?.translateToString(true)).toContain("cd /some/path")
      expect(term2.buffer.active.getLine(1)?.translateToString(true)).toContain("ls -la")
      expect(term2.buffer.active.getLine(2)?.translateToString(true)).toBe("total 42")
    })

    test("serialized output should restore after Terminal.reset()", async () => {
      const { term, addon } = createTerminal()

      const content = [
        "\x1b[1;32m❯\x1b[0m \x1b[34mcd\x1b[0m /some/path",
        "\x1b[1;32m❯\x1b[0m \x1b[34mls\x1b[0m -la",
        "total 42",
      ].join("\r\n")

      await writeAndWait(term, content)

      const serialized = addon.serialize()

      const { term: term2 } = createTerminal()
      terminals.push(term2)
      term2.reset()
      await writeAndWait(term2, serialized)

      expect(term2.buffer.active.getLine(0)?.translateToString(true)).toContain("cd /some/path")
      expect(term2.buffer.active.getLine(1)?.translateToString(true)).toContain("ls -la")
      expect(term2.buffer.active.getLine(2)?.translateToString(true)).toBe("total 42")
    })

    test("alternate buffer should round-trip without garbage", async () => {
      const { term, addon } = createTerminal(20, 5)

      await writeAndWait(term, "normal\r\n")
      await writeAndWait(term, "\x1b[?1049h\x1b[HALT")

      expect(term.buffer.active.type).toBe("alternate")

      const serialized = addon.serialize()

      const { term: term2 } = createTerminal(20, 5)
      terminals.push(term2)
      await writeAndWait(term2, serialized)

      expect(term2.buffer.active.type).toBe("alternate")

      const line = term2.buffer.active.getLine(0)
      expect(line?.translateToString(true)).toBe("ALT")

      // Ensure a cell beyond content isn't garbage
      const cellCode = line?.getCell(10)?.getCode()
      expect(cellCode === 0 || cellCode === 32).toBe(true)
    })

    test("serialized output written to new terminal should match original colors", async () => {
      const { term, addon } = createTerminal(40, 5)

      const input = "\x1b[38;2;255;0;0mHello\x1b[0m \x1b[38;2;0;255;0mWorld\x1b[0m!                            "
      await writeAndWait(term, input)

      const origLine = term.buffer.active.getLine(0)
      const origHelloFg = origLine!.getCell(0)!.getFgColor()
      const origWorldFg = origLine!.getCell(6)!.getFgColor()

      const serialized = addon.serialize({ range: { start: 0, end: 0 } })

      const { term: term2 } = createTerminal(40, 5)
      terminals.push(term2)
      await writeAndWait(term2, serialized)

      const newLine = term2.buffer.active.getLine(0)

      expect(newLine!.getCell(0)!.getChars()).toBe("H")
      expect(newLine!.getCell(0)!.getFgColor()).toBe(origHelloFg)

      expect(newLine!.getCell(6)!.getChars()).toBe("W")
      expect(newLine!.getCell(6)!.getFgColor()).toBe(origWorldFg)

      expect(newLine!.getCell(11)!.getChars()).toBe("!")
    })
  })
})
