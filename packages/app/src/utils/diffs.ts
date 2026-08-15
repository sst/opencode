import type { SnapshotFileDiff, VcsFileDiff } from "@opencode-ai/sdk/v2"
import type { FileDiffInfo } from "@opencode-ai/client/promise"
import type { Message } from "@opencode-ai/sdk/v2/client"

type Diff = FileDiffInfo | SnapshotFileDiff | VcsFileDiff

function diff(value: unknown): value is Diff {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  if (!("file" in value) || typeof value.file !== "string") return false
  if (!("patch" in value) || typeof value.patch !== "string") return false
  if (!("additions" in value) || typeof value.additions !== "number") return false
  if (!("deletions" in value) || typeof value.deletions !== "number") return false
  if (!("status" in value) || value.status === undefined) return true
  return value.status === "added" || value.status === "deleted" || value.status === "modified"
}

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

export function diffs(value: unknown): Diff[] {
  if (Array.isArray(value) && value.every(diff)) return value
  if (Array.isArray(value)) return value.filter(diff)
  if (diff(value)) return [value]
  if (!object(value)) return []
  return Object.values(value).filter(diff)
}

export function message(value: Message): Message {
  if (value.role !== "user") return value

  const raw = value.summary as unknown
  if (raw === undefined) return value
  if (!object(raw)) return { ...value, summary: undefined }

  const title = typeof raw.title === "string" ? raw.title : undefined
  const body = typeof raw.body === "string" ? raw.body : undefined
  const additions = typeof raw.additions === "number" ? raw.additions : undefined
  const deletions = typeof raw.deletions === "number" ? raw.deletions : undefined
  const files = typeof raw.files === "number" ? raw.files : undefined
  const next = diffs(raw.diffs)

  if (
    title === raw.title &&
    body === raw.body &&
    additions === raw.additions &&
    deletions === raw.deletions &&
    files === raw.files &&
    next === raw.diffs
  )
    return value

  return {
    ...value,
    summary: {
      ...(title === undefined ? {} : { title }),
      ...(body === undefined ? {} : { body }),
      ...(additions === undefined ? {} : { additions }),
      ...(deletions === undefined ? {} : { deletions }),
      ...(files === undefined ? {} : { files }),
      diffs: next,
    },
  }
}
