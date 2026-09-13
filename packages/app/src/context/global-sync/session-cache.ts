import type { Message, Part, PermissionRequest, QuestionRequest, SessionStatus, Todo } from "@opencode-ai/sdk/v2/client"
import type { FileDiffInfo } from "@opencode-ai/client/promise"
import type { SessionMessageInfo } from "@opencode-ai/client/promise"

export const SESSION_CACHE_LIMIT = 40

type SessionCache = {
  session_status: Record<string, SessionStatus | undefined>
  session_diff: Record<string, FileDiffInfo[] | undefined>
  message_diff: Record<string, FileDiffInfo[] | undefined>
  message_diff_status: Record<string, "pending" | "failed" | "absent" | undefined>
  todo: Record<string, Todo[] | undefined>
  message: Record<string, Message[] | undefined>
  session_message: Record<string, SessionMessageInfo[] | undefined>
  part: Record<string, Part[] | undefined>
  permission: Record<string, PermissionRequest[] | undefined>
  question: Record<string, QuestionRequest[] | undefined>
  part_text_accum_delta: Record<string, string | undefined>
}

export function dropSessionCaches(store: SessionCache, sessionIDs: Iterable<string>) {
  const stale = new Set(Array.from(sessionIDs).filter(Boolean))
  if (stale.size === 0) return

  for (const key of Object.keys(store.part)) {
    const parts = store.part[key]
    if (!parts?.some((part) => stale.has(part?.sessionID ?? ""))) continue
    for (const part of parts) {
      delete store.part_text_accum_delta[part.id]
    }
    delete store.part[key]
  }

  for (const sessionID of stale) {
    for (const message of store.message[sessionID] ?? []) {
      delete store.message_diff[message.id]
      delete store.message_diff_status[message.id]
    }
    delete store.message[sessionID]
    delete store.todo[sessionID]
    delete store.session_message[sessionID]
    delete store.session_diff[sessionID]
    delete store.session_status[sessionID]
    delete store.permission[sessionID]
    delete store.question[sessionID]
  }
}

export function pickSessionCacheEvictions(input: {
  seen: Set<string>
  keep: string
  limit: number
  preserve?: Iterable<string>
}) {
  const stale: string[] = []
  const keep = new Set([input.keep, ...Array.from(input.preserve ?? [])])
  if (input.seen.has(input.keep)) input.seen.delete(input.keep)
  input.seen.add(input.keep)
  for (const id of input.seen) {
    if (input.seen.size - stale.length <= input.limit) break
    if (keep.has(id)) continue
    stale.push(id)
  }
  for (const id of stale) {
    input.seen.delete(id)
  }
  return stale
}
