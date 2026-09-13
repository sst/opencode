import { TextareaRenderable, type OptimizedBuffer } from "@opentui/core"
import {
  boundaryToLogicalCursor,
  boundaryToVisual,
  hasRtl,
  layoutBidiText,
  logicalCursorToBoundary,
  paintBidiCell,
  visualStep,
  visualToBoundary,
  widthOffsetToBoundary,
  type BidiLayout,
} from "../util/bidi"

// RTL-aware prompt input. The edit buffer always stores logical Unicode text
// (typing, paste, undo and value reads are untouched); only painting, caret
// placement and left/right/up/down motion are bidi-aware. When the text has
// no strong RTL characters every code path defers to the stock OpenTUI
// textarea, so English-only behavior is bit-for-bit unchanged.
export class BidiTextareaRenderable extends TextareaRenderable {
  private bidiState: { source: string; width: number; layout: BidiLayout; scroll: number } | undefined
  private bidiDesiredCol: number | undefined

  private bidiLayout() {
    const source = this.plainText
    if (!hasRtl(source)) {
      this.bidiState = undefined
      return undefined
    }
    const width = this.width
    if (width <= 0) return undefined
    if (this.bidiState && this.bidiState.source === source && this.bidiState.width === width) return this.bidiState
    this.bidiState = { source, width, layout: layoutBidiText(source, width), scroll: this.bidiState?.scroll ?? 0 }
    return this.bidiState
  }

  private bidiViewportHeight() {
    return Math.max(1, Math.floor(this.height))
  }

  private clampBidiScroll(state: NonNullable<BidiTextareaRenderable["bidiState"]>) {
    const height = this.bidiViewportHeight()
    state.scroll = Math.max(0, Math.min(state.scroll, Math.max(0, state.layout.lines.length - height)))
  }

  private currentBoundary(state: NonNullable<BidiTextareaRenderable["bidiState"]>) {
    const cursor = this.editBuffer.getCursorPosition()
    return logicalCursorToBoundary(state.layout, cursor.row, cursor.col)
  }

  private moveToBoundary(layout: BidiLayout, boundary: number) {
    const position = boundaryToLogicalCursor(layout, boundary)
    this.editBuffer.setCursor(position.row, position.col)
    this.bidiDesiredCol = undefined
  }

  protected override renderSelf(buffer: OptimizedBuffer): void {
    const state = this.bidiLayout()
    if (!state) {
      super.renderSelf(buffer)
      return
    }
    this.clampBidiScroll(state)
    const selection = this.getSelection()
    const selStart = selection ? widthOffsetToBoundary(state.layout, selection.start) : -1
    const selEnd = selection ? widthOffsetToBoundary(state.layout, selection.end) : -1
    const selectionFg = this._selectionFg ?? this._textColor
    const selectionBg = this._selectionBg ?? this._backgroundColor
    const height = this.bidiViewportHeight()
    for (let i = state.scroll; i < state.layout.lines.length && i < state.scroll + height; i++) {
      const line = state.layout.lines[i]
      const y = this._screenY + (i - state.scroll)
      if (y < 0 || y >= buffer.height) continue
      const x0 = line.rtl ? this._screenX + state.width - line.width : this._screenX
      for (const cell of line.cells) {
        const x = x0 + cell.col
        if (x < 0 || x >= buffer.width) continue
        const selected = selStart >= 0 && cell.glyph >= selStart && cell.glyph < selEnd
        paintBidiCell(
          buffer,
          x,
          y,
          cell.char,
          selected ? selectionFg : this._textColor,
          selected ? selectionBg : this._backgroundColor,
          this._defaultAttributes,
        )
      }
    }
  }

  protected override renderCursor(buffer: OptimizedBuffer): void {
    const state = this.bidiLayout()
    if (!state) {
      super.renderCursor(buffer)
      return
    }
    if (!this._showCursor || !this._focused) return
    const boundary = this.currentBoundary(state)
    const position = boundaryToVisual(state.layout, boundary)
    const height = this.bidiViewportHeight()
    if (position.line < state.scroll) state.scroll = position.line
    if (position.line >= state.scroll + height) state.scroll = position.line - height + 1
    this.clampBidiScroll(state)
    const line = state.layout.lines[position.line]
    const x = (line.rtl ? this._screenX + state.width - line.width : this._screenX) + position.col
    this._ctx.setCursorPosition(x + 1, this._screenY + (position.line - state.scroll) + 1, true)
    this._ctx.setCursorStyle({ ...this._cursorStyle, color: this._cursorColor })
    void buffer
  }

  override moveCursorLeft(options?: { select?: boolean }): boolean {
    const state = this.bidiLayout()
    if (!state) return super.moveCursorLeft(options)
    const select = options?.select ?? false
    if (!select && this.hasSelection()) return super.moveCursorLeft(options)
    this.updateSelectionForMovement(select, true)
    this.moveToBoundary(state.layout, visualStep(state.layout, this.currentBoundary(state), -1))
    this.updateSelectionForMovement(select, false)
    this.requestRender()
    return true
  }

  override moveCursorRight(options?: { select?: boolean }): boolean {
    const state = this.bidiLayout()
    if (!state) return super.moveCursorRight(options)
    const select = options?.select ?? false
    if (!select && this.hasSelection()) return super.moveCursorRight(options)
    this.updateSelectionForMovement(select, true)
    this.moveToBoundary(state.layout, visualStep(state.layout, this.currentBoundary(state), 1))
    this.updateSelectionForMovement(select, false)
    this.requestRender()
    return true
  }

  override moveCursorUp(options?: { select?: boolean }): boolean {
    const state = this.bidiLayout()
    if (!state) return super.moveCursorUp(options)
    const select = options?.select ?? false
    this.updateSelectionForMovement(select, true)
    const boundary = this.currentBoundary(state)
    const position = boundaryToVisual(state.layout, boundary)
    if (position.line === 0) {
      this.editBuffer.setCursor(0, 0)
    } else {
      const desired = this.bidiDesiredCol ?? position.col
      this.moveToBoundary(state.layout, visualToBoundary(state.layout, position.line - 1, desired))
      this.bidiDesiredCol = desired
    }
    this.updateSelectionForMovement(select, false)
    this.requestRender()
    return true
  }

  override moveCursorDown(options?: { select?: boolean }): boolean {
    const state = this.bidiLayout()
    if (!state) return super.moveCursorDown(options)
    const select = options?.select ?? false
    this.updateSelectionForMovement(select, true)
    const boundary = this.currentBoundary(state)
    const position = boundaryToVisual(state.layout, boundary)
    if (position.line >= state.layout.lines.length - 1) {
      const last = state.layout.paragraphs[state.layout.paragraphs.length - 1]
      this.editBuffer.setCursor(state.layout.paragraphs.length - 1, state.layout.boundaryWidths[last.end] - last.startWidth)
    } else {
      const desired = this.bidiDesiredCol ?? position.col
      this.moveToBoundary(state.layout, visualToBoundary(state.layout, position.line + 1, desired))
      this.bidiDesiredCol = desired
    }
    this.updateSelectionForMovement(select, false)
    this.requestRender()
    return true
  }

  protected override handleScroll(event: { type: string; scroll?: { direction: string; delta: number } }): void {
    super.handleScroll(event)
    const state = this.bidiLayout()
    if (!state || !event.scroll) return
    const delta = event.scroll.delta
    if (event.scroll.direction === "up") state.scroll = Math.max(0, state.scroll - delta)
    if (event.scroll.direction === "down") {
      state.scroll = Math.min(state.scroll + delta, Math.max(0, state.layout.lines.length - this.bidiViewportHeight()))
    }
    this.requestRender()
  }
}
