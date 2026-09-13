import { createMemo, createResource, type Accessor } from "solid-js"
import type { SessionMessageInfo } from "@opencode/client/promise"
import { useData } from "@/runtime/server/current"
import type { SessionModel } from "../model"

const leadingTurnPageDelay = 200
const leadingTurnPageLimit = 3

export {
  selectSessionUserMessages as selectUserMessages,
  selectVisibleSessionUserMessages as selectVisibleUserMessages,
} from "../session-domain"

export function createTimelineModel(input: { session: Pick<SessionModel, "identity" | "history" | "ownership"> }) {
  const data = useData()

  const [resource] = createResource(
    () => input.session.identity.sessionID(),
    async (id) => {
      if (!id) return
      const owner = input.session.ownership.capture()
      await Promise.all([data.session.message.sync(id), data.session.pending.sync(id)])
      await enrichLeadingTurn({
        current: owner.current,
        messages: () => data.session.message.list(id),
        more: () => data.session.message.more(id),
        loading: () => data.session.message.loading(id),
        loadMore: () => data.session.message.loadMore(id),
        pause: () => new Promise((resolve) => setTimeout(resolve, leadingTurnPageDelay)),
        maxPages: leadingTurnPageLimit,
      }).catch(() => undefined)
      return id
    },
  )
  const ready = createMemo(() => {
    const id = input.session.identity.sessionID()
    // Enrich the partial leading group without withholding the already loaded tail.
    return !id || data.session.message.list(id).length > 0 || (!resource.loading && resource.latest === id)
  })
  const more = () => {
    const id = input.session.identity.sessionID()
    return id ? data.session.message.more(id) : false
  }
  const loading = () => {
    const id = input.session.identity.sessionID()
    return id ? data.session.message.loading(id) : false
  }
  const loadOlder = async (options?: { before?: () => void; after?: (done: boolean) => void }) => {
    return loadOlderTimeline({
      sessionID: input.session.identity.sessionID,
      more,
      loading,
      loadMore: (id) => data.session.message.loadMore(id),
      before: options?.before,
      after: options?.after,
    })
  }

  return {
    history: { loadOlder, loading, more },
    lastUserMessage: input.session.history.lastUserMessage,
    messages: input.session.history.messages,
    ready,
    resource,
    visibleUserMessages: input.session.history.visibleUserMessages,
  }
}

export async function enrichLeadingTurn(input: {
  current: Accessor<boolean>
  messages: Accessor<SessionMessageInfo[]>
  more: Accessor<boolean>
  loading: Accessor<boolean>
  loadMore: () => Promise<void>
  pause: () => Promise<void>
  maxPages: number
}) {
  const load = async (pages: number): Promise<void> => {
    if (!input.current() || pages >= input.maxPages || !leadingTurnNeedsParent(input.messages()) || !input.more())
      return
    await input.pause()
    if (!input.current() || !leadingTurnNeedsParent(input.messages()) || !input.more()) return
    if (input.loading()) return load(pages)
    await input.loadMore()
    return load(pages + 1)
  }
  return load(0)
}

export function leadingTurnNeedsParent(messages: SessionMessageInfo[]) {
  const assistant = messages.findIndex((message) => message.type === "assistant")
  if (assistant === -1) return false
  const boundary = messages.findIndex((message) => message.type === "user" || message.type === "shell")
  return boundary === -1 || assistant < boundary
}

export async function loadOlderTimeline(input: {
  sessionID: Accessor<string | undefined>
  more: Accessor<boolean>
  loading: Accessor<boolean>
  loadMore: (sessionID: string) => Promise<void>
  before?: () => void
  after?: (done: boolean) => void
}) {
  const id = input.sessionID()
  if (!id || !input.more() || input.loading()) return

  input.before?.()
  await input.loadMore(id).catch((error) => {
    if (input.sessionID() === id) input.after?.(true)
    throw error
  })
  if (input.sessionID() !== id) return
  input.after?.(true)
}
