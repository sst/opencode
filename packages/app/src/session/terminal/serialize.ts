/**
 * SerializeAddon - Serialize terminal buffer contents
 *
 * Port of xterm.js addon-serialize for ghostty-web.
 * Enables serialization of terminal contents to a string that can
 * be written back to restore terminal state.
 *
 * Usage:
 * ```typescript
 * const serializeAddon = new SerializeAddon();
 * term.loadAddon(serializeAddon);
 * const content = serializeAddon.serialize();
 * ```
 */

import type { ITerminalAddon, ITerminalCore, IBufferRange } from "ghostty-web"

// ============================================================================
// Buffer Types (matching ghostty-web internal interfaces)
// ============================================================================

interface IBuffer {
  readonly type: "normal" | "alternate"
  readonly cursorX: number
  readonly cursorY: number
  readonly viewportY: number
  readonly baseY: number
  readonly length: number
  getLine(y: number): IBufferLine | undefined
  getNullCell(): IBufferCell
}

interface IBufferLine {
  readonly length: number
  readonly isWrapped: boolean
  getCell(x: number): IBufferCell | undefined
  translateToString(trimRight?: boolean, startColumn?: number, endColumn?: number): string
}

interface IBufferCell {
  getChars(): string
  getCode(): number
  getWidth(): number
  getFgColorMode(): number
  getBgColorMode(): number
  getFgColor(): number
  getBgColor(): number
  isBold(): number
  isItalic(): number
  isUnderline(): number
  isStrikethrough(): number
  isBlink(): number
  isInverse(): number
  isInvisible(): number
  isFaint(): number
  isDim(): boolean
}

type TerminalBuffers = {
  active?: IBuffer
  normal?: IBuffer
  alternate?: IBuffer
}

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null
}

const isBuffer = (value: unknown): value is IBuffer => {
  if (!isRecord(value)) return false
  if (typeof value.length !== "number") return false
  if (typeof value.cursorX !== "number") return false
  if (typeof value.cursorY !== "number") return false
  if (typeof value.baseY !== "number") return false
  if (typeof value.viewportY !== "number") return false
  if (typeof value.getLine !== "function") return false
  if (typeof value.getNullCell !== "function") return false
  return true
}

const getTerminalBuffers = (value: ITerminalCore): TerminalBuffers | undefined => {
  if (!isRecord(value)) return
  const raw = value.buffer
  if (!isRecord(raw)) return
  const active = isBuffer(raw.active) ? raw.active : undefined
  const normal = isBuffer(raw.normal) ? raw.normal : undefined
  const alternate = isBuffer(raw.alternate) ? raw.alternate : undefined
  if (!active && !normal) return
  return { active, normal, alternate }
}

const getTerminalMode = (value: ITerminalCore, mode: number) => {
  if (!isRecord(value)) return false
  const terminal = value.wasmTerm
  if (!isRecord(terminal) || typeof terminal.getMode !== "function") return false
  return terminal.getMode(mode) === true
}

// ============================================================================
// Types
// ============================================================================

export interface ISerializeOptions {
  /**
   * The row range to serialize. When an explicit range is specified, the cursor
   * will get its final repositioning.
   */
  range?: ISerializeRange
  /**
   * The number of rows in the scrollback buffer to serialize, starting from
   * the bottom of the scrollback buffer. When not specified, all available
   * rows in the scrollback buffer will be serialized.
   */
  scrollback?: number
  /**
   * Whether to exclude the terminal modes from the serialization.
   * Default: false
   */
  excludeModes?: boolean
  /**
   * Whether to exclude the alt buffer from the serialization.
   * Default: false
   */
  excludeAltBuffer?: boolean
}

export interface ISerializeRange {
  /**
   * The line to start serializing (inclusive).
   */
  start: number
  /**
   * The line to end serializing (inclusive).
   */
  end: number
}

export interface IHTMLSerializeOptions {
  /**
   * The number of rows in the scrollback buffer to serialize, starting from
   * the bottom of the scrollback buffer.
   */
  scrollback?: number
  /**
   * Whether to only serialize the selection.
   * Default: false
   */
  onlySelection?: boolean
  /**
   * Whether to include the global background of the terminal.
   * Default: false
   */
  includeGlobalBackground?: boolean
  /**
   * The range to serialize. This is prioritized over onlySelection.
   */
  range?: {
    startLine: number
    endLine: number
    startCol: number
  }
}

// ============================================================================
// Helper Functions
// ============================================================================

function constrain(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(value, high))
}

function equalFg(cell1: IBufferCell, cell2: IBufferCell): boolean {
  return cell1.getFgColorMode() === cell2.getFgColorMode() && cell1.getFgColor() === cell2.getFgColor()
}

function equalBg(cell1: IBufferCell, cell2: IBufferCell): boolean {
  return cell1.getBgColorMode() === cell2.getBgColorMode() && cell1.getBgColor() === cell2.getBgColor()
}

function equalFlags(cell1: IBufferCell, cell2: IBufferCell): boolean {
  return (
    !!cell1.isInverse() === !!cell2.isInverse() &&
    !!cell1.isBold() === !!cell2.isBold() &&
    !!cell1.isUnderline() === !!cell2.isUnderline() &&
    !!cell1.isBlink() === !!cell2.isBlink() &&
    !!cell1.isInvisible() === !!cell2.isInvisible() &&
    !!cell1.isItalic() === !!cell2.isItalic() &&
    !!cell1.isDim() === !!cell2.isDim() &&
    !!cell1.isStrikethrough() === !!cell2.isStrikethrough()
  )
}

// ============================================================================
// Base Serialize Handler
// ============================================================================

abstract class BaseSerializeHandler {
  constructor(protected readonly _buffer: IBuffer) {}

  public serialize(range: IBufferRange, excludeFinalCursorPosition?: boolean): string {
    let oldCell = this._buffer.getNullCell()

    const startRow = range.start.y
    const endRow = range.end.y
    const startColumn = range.start.x
    const endColumn = range.end.x

    this._beforeSerialize(endRow - startRow + 1, startRow, endRow)

    for (let row = startRow; row <= endRow; row++) {
      const line = this._buffer.getLine(row)
      if (line) {
        const startLineColumn = row === range.start.y ? startColumn : 0
        const endLineColumn = Math.min(endColumn, line.length)

        for (let col = startLineColumn; col < endLineColumn; col++) {
          const c = line.getCell(col)
          if (!c) {
            continue
          }
          this._nextCell(c, oldCell, row, col)
          oldCell = c
        }
      }
      this._rowEnd(row, row === endRow)
    }

    this._afterSerialize()

    return this._serializeString(excludeFinalCursorPosition)
  }

  protected _nextCell(_cell: IBufferCell, _oldCell: IBufferCell, _row: number, _col: number): void {}
  protected _rowEnd(_row: number, _isLastRow: boolean): void {}
  protected _beforeSerialize(_rows: number, _startRow: number, _endRow: number): void {}
  protected _afterSerialize(): void {}
  protected _serializeString(_excludeFinalCursorPosition?: boolean): string {
    return ""
  }
}

// ============================================================================
// String Serialize Handler
// ============================================================================

class StringSerializeHandler extends BaseSerializeHandler {
  private _rowIndex: number = 0
  private _allRows: string[] = []
  private _allRowSeparators: string[] = []
  private _currentRow: string = ""
  private _nullCellCount: number = 0
  private _cursorStyle: IBufferCell
  private _firstRow: number = 0
  private _lastCursorRow: number = 0
  private _lastCursorCol: number = 0
  private _lastContentCursorRow: number = 0
  private _lastContentCursorCol: number = 0

  constructor(
    buffer: IBuffer,
    private readonly _terminal: ITerminalCore,
  ) {
    super(buffer)
    this._cursorStyle = this._buffer.getNullCell()
  }

  protected _beforeSerialize(rows: number, start: number, _end: number): void {
    this._allRows = Array.from<string>({ length: rows })
    this._allRowSeparators = Array.from<string>({ length: rows })
    this._rowIndex = 0

    this._currentRow = ""
    this._nullCellCount = 0
    this._cursorStyle = this._buffer.getNullCell()

    this._lastContentCursorRow = start
    this._lastCursorRow = start
    this._firstRow = start
  }

  protected _rowEnd(row: number, isLastRow: boolean): void {
    let rowSeparator = ""

    const nextLine = isLastRow ? undefined : this._buffer.getLine(row + 1)
    const wrapped = !!nextLine?.isWrapped

    if (this._nullCellCount > 0 && wrapped) {
      this._currentRow += " ".repeat(this._nullCellCount)
    }

    this._nullCellCount = 0

    if (!isLastRow && !wrapped) {
      rowSeparator = "\r\n"
      this._lastCursorRow = row + 1
      this._lastCursorCol = 0
    }

    this._allRows[this._rowIndex] = this._currentRow
    this._allRowSeparators[this._rowIndex++] = rowSeparator
    this._currentRow = ""
    this._nullCellCount = 0
  }

  private _diffStyle(cell: IBufferCell, oldCell: IBufferCell): number[] {
    const sgrSeq: number[] = []
    const fgChanged = !equalFg(cell, oldCell)
    const bgChanged = !equalBg(cell, oldCell)
    const flagsChanged = !equalFlags(cell, oldCell)

    if (fgChanged || bgChanged || flagsChanged) {
      if (this._isAttributeDefault(cell)) {
        if (!this._isAttributeDefault(oldCell)) {
          sgrSeq.push(0)
        }
      } else {
        if (flagsChanged) {
          if (!!cell.isInverse() !== !!oldCell.isInverse()) {
            sgrSeq.push(cell.isInverse() ? 7 : 27)
          }
          if (!!cell.isBold() !== !!oldCell.isBold()) {
            sgrSeq.push(cell.isBold() ? 1 : 22)
          }
          if (!!cell.isUnderline() !== !!oldCell.isUnderline()) {
            sgrSeq.push(cell.isUnderline() ? 4 : 24)
          }
          if (!!cell.isBlink() !== !!oldCell.isBlink()) {
            sgrSeq.push(cell.isBlink() ? 5 : 25)
          }
          if (!!cell.isInvisible() !== !!oldCell.isInvisible()) {
            sgrSeq.push(cell.isInvisible() ? 8 : 28)
          }
          if (!!cell.isItalic() !== !!oldCell.isItalic()) {
            sgrSeq.push(cell.isItalic() ? 3 : 23)
          }
          if (!!cell.isDim() !== !!oldCell.isDim()) {
            sgrSeq.push(cell.isDim() ? 2 : 22)
          }
          if (!!cell.isStrikethrough() !== !!oldCell.isStrikethrough()) {
            sgrSeq.push(cell.isStrikethrough() ? 9 : 29)
          }
        }
        if (fgChanged) {
          const color = cell.getFgColor()
          const mode = cell.getFgColorMode()
          if (mode === 2 || mode === 3 || mode === -1) {
            sgrSeq.push(38, 2, (color >>> 16) & 0xff, (color >>> 8) & 0xff, color & 0xff)
          } else if (mode === 1) {
            // Palette
            if (color >= 16) {
              sgrSeq.push(38, 5, color)
            } else {
              sgrSeq.push(color & 8 ? 90 + (color & 7) : 30 + (color & 7))
            }
          } else {
            sgrSeq.push(39)
          }
        }
        if (bgChanged) {
          const color = cell.getBgColor()
          const mode = cell.getBgColorMode()
          if (mode === 2 || mode === 3 || mode === -1) {
            sgrSeq.push(48, 2, (color >>> 16) & 0xff, (color >>> 8) & 0xff, color & 0xff)
          } else if (mode === 1) {
            // Palette
            if (color >= 16) {
              sgrSeq.push(48, 5, color)
            } else {
              sgrSeq.push(color & 8 ? 100 + (color & 7) : 40 + (color & 7))
            }
          } else {
            sgrSeq.push(49)
          }
        }
      }
    }

    return sgrSeq
  }

  private _isAttributeDefault(cell: IBufferCell): boolean {
    const mode = cell.getFgColorMode()
    const bgMode = cell.getBgColorMode()

    if (mode === 0 && bgMode === 0) {
      return (
        !cell.isBold() &&
        !cell.isItalic() &&
        !cell.isUnderline() &&
        !cell.isBlink() &&
        !cell.isInverse() &&
        !cell.isInvisible() &&
        !cell.isDim() &&
        !cell.isStrikethrough()
      )
    }

    const fgColor = cell.getFgColor()
    const bgColor = cell.getBgColor()
    const nullCell = this._buffer.getNullCell()
    const nullFg = nullCell.getFgColor()
    const nullBg = nullCell.getBgColor()

    return (
      fgColor === nullFg &&
      bgColor === nullBg &&
      !cell.isBold() &&
      !cell.isItalic() &&
      !cell.isUnderline() &&
      !cell.isBlink() &&
      !cell.isInverse() &&
      !cell.isInvisible() &&
      !cell.isDim() &&
      !cell.isStrikethrough()
    )
  }

  protected _nextCell(cell: IBufferCell, _oldCell: IBufferCell, row: number, col: number): void {
    const isPlaceHolderCell = cell.getWidth() === 0

    if (isPlaceHolderCell) {
      return
    }

    const codepoint = cell.getCode()
    const isInvalidCodepoint = codepoint > 0x10ffff || (codepoint >= 0xd800 && codepoint <= 0xdfff)
    const isGarbage = isInvalidCodepoint || (codepoint >= 0xf000 && cell.getWidth() === 1)
    const isEmptyCell = codepoint === 0 || cell.getChars() === "" || isGarbage

    const sgrSeq = this._diffStyle(cell, this._cursorStyle)

    const styleChanged = sgrSeq.length > 0

    if (styleChanged) {
      if (this._nullCellCount > 0) {
        this._currentRow += " ".repeat(this._nullCellCount)
        this._nullCellCount = 0
      }

      this._lastContentCursorRow = this._lastCursorRow = row
      this._lastContentCursorCol = this._lastCursorCol = col

      this._currentRow += `\u001b[${sgrSeq.join(";")}m`

      // Ghostty cells are snapshots; rereading this cell copies the whole row again.
      this._cursorStyle = cell
    }

    if (isEmptyCell) {
      this._nullCellCount += cell.getWidth()
    } else {
      if (this._nullCellCount > 0) {
        this._currentRow += " ".repeat(this._nullCellCount)
        this._nullCellCount = 0
      }

      this._currentRow += cell.getChars()

      this._lastContentCursorRow = this._lastCursorRow = row
      this._lastContentCursorCol = this._lastCursorCol = col + cell.getWidth()
    }
  }

  protected _serializeString(excludeFinalCursorPosition?: boolean): string {
    let rowEnd = this._allRows.length

    if (this._buffer.length - this._firstRow <= this._terminal.rows) {
      rowEnd = this._lastContentCursorRow + 1 - this._firstRow
      this._lastCursorCol = this._lastContentCursorCol
      this._lastCursorRow = this._lastContentCursorRow
    }

    let content = ""

    for (let i = 0; i < rowEnd; i++) {
      content += this._allRows[i]
      if (i + 1 < rowEnd) {
        content += this._allRowSeparators[i]
      }
    }

    if (excludeFinalCursorPosition) return content

    // CUP addresses the screen and ghostty-web reports cursorY relative to the screen, so the
    // serialized range start must not shift the row. The cursor line sits in the screen region
    // at the bottom of the buffer, after any scrollback rows.
    content += `\u001b[${this._buffer.cursorY + 1};${this._buffer.cursorX + 1}H`

    const line = this._buffer.getLine(this._buffer.length - this._terminal.rows + this._buffer.cursorY)
    const cell = line?.getCell(this._buffer.cursorX)
    const style = (() => {
      if (!cell) return this._buffer.getNullCell()
      if (cell.getWidth() !== 0) return cell
      if (this._buffer.cursorX > 0) return line?.getCell(this._buffer.cursorX - 1) ?? cell
      return cell
    })()

    const sgrSeq = this._diffStyle(style, this._cursorStyle)
    if (sgrSeq.length) content += `\u001b[${sgrSeq.join(";")}m`

    return content
  }
}

// ============================================================================
// SerializeAddon Class
// ============================================================================

export class SerializeAddon implements ITerminalAddon {
  private _terminal?: ITerminalCore

  /**
   * Activate the addon (called by Terminal.loadAddon)
   */
  public activate(terminal: ITerminalCore): void {
    this._terminal = terminal
  }

  /**
   * Dispose the addon and clean up resources
   */
  public dispose(): void {
    this._terminal = undefined
  }

  /**
   * Serializes terminal rows into a string that can be written back to the
   * terminal to restore the state. The cursor will also be positioned to the
   * correct cell.
   *
   * @param options Custom options to allow control over what gets serialized.
   */
  public serialize(options?: ISerializeOptions): string {
    if (!this._terminal) {
      throw new Error("Cannot use addon until it has been loaded")
    }

    const buffer = getTerminalBuffers(this._terminal)

    if (!buffer) {
      return ""
    }

    const normalBuffer = buffer.normal ?? buffer.active
    const altBuffer = buffer.alternate

    if (!normalBuffer) {
      return ""
    }

    let content = !options?.excludeModes && getTerminalMode(this._terminal, 2031) ? "\u001b[?2031h" : ""
    content += options?.range
      ? this._serializeBufferByRange(normalBuffer, options.range, true)
      : this._serializeBufferByScrollback(normalBuffer, options?.scrollback)

    if (!options?.excludeAltBuffer && buffer.active?.type === "alternate" && altBuffer) {
      const alternateContent = this._serializeBufferByScrollback(altBuffer, undefined)
      content += `\u001b[?1049h\u001b[H${alternateContent}`
    }

    return content
  }

  /**
   * Serializes terminal content as plain text (no escape sequences)
   * @param options Custom options to allow control over what gets serialized.
   */
  public serializeAsText(options?: { scrollback?: number; trimWhitespace?: boolean }): string {
    if (!this._terminal) {
      throw new Error("Cannot use addon until it has been loaded")
    }

    const buffer = getTerminalBuffers(this._terminal)

    if (!buffer) {
      return ""
    }

    const activeBuffer = buffer.active ?? buffer.normal
    if (!activeBuffer) {
      return ""
    }

    const maxRows = activeBuffer.length
    const scrollback = options?.scrollback
    const correctRows = scrollback === undefined ? maxRows : constrain(scrollback + this._terminal.rows, 0, maxRows)

    const startRow = maxRows - correctRows
    const endRow = maxRows - 1
    const lines: string[] = []

    for (let row = startRow; row <= endRow; row++) {
      const line = activeBuffer.getLine(row)
      if (line) {
        const text = line.translateToString(options?.trimWhitespace ?? true)
        lines.push(text)
      }
    }

    // Trim trailing empty lines if requested
    if (options?.trimWhitespace) {
      while (lines.length > 0 && lines[lines.length - 1] === "") {
        lines.pop()
      }
    }

    return lines.join("\n")
  }

  private _serializeBufferByScrollback(buffer: IBuffer, scrollback?: number): string {
    const maxRows = buffer.length
    const rows = this._terminal?.rows ?? 24
    const correctRows = scrollback === undefined ? maxRows : constrain(scrollback + rows, 0, maxRows)
    return this._serializeBufferByRange(
      buffer,
      {
        start: maxRows - correctRows,
        end: maxRows - 1,
      },
      false,
    )
  }

  private _serializeBufferByRange(
    buffer: IBuffer,
    range: ISerializeRange,
    excludeFinalCursorPosition: boolean,
  ): string {
    const handler = new StringSerializeHandler(buffer, this._terminal!)
    const cols = this._terminal?.cols ?? 80
    return handler.serialize(
      {
        start: { x: 0, y: range.start },
        end: { x: cols, y: range.end },
      },
      excludeFinalCursorPosition,
    )
  }
}
