import type { FileContent } from "@/runtime/server/types"
import { Schema } from "effect"
import { Persistence } from "@/runtime/persistence/schema"

export const FileSelection = Persistence.struct({
  startLine: Schema.Number,
  startChar: Schema.Number,
  endLine: Schema.Number,
  endChar: Schema.Number,
})
export type FileSelection = typeof FileSelection.Type

export const SelectedLineRange = Persistence.struct({
  start: Schema.Number,
  end: Schema.Number,
  side: Persistence.optional(Schema.Literals(["additions", "deletions"])),
  endSide: Persistence.optional(Schema.Literals(["additions", "deletions"])),
})
export type SelectedLineRange = typeof SelectedLineRange.Type

export type FileViewState = {
  scrollTop?: number
  scrollLeft?: number
  selectedLines?: SelectedLineRange | null
}

export type FileState = {
  path: string
  name: string
  loaded?: boolean
  loading?: boolean
  notFound?: boolean
  error?: string
  content?: FileContent
}

export function selectionFromLines(range: SelectedLineRange): FileSelection {
  const startLine = Math.min(range.start, range.end)
  const endLine = Math.max(range.start, range.end)
  return {
    startLine,
    endLine,
    startChar: 0,
    endChar: 0,
  }
}
