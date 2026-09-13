import type { SessionMessageUser } from "@opencode/client/promise"
import { useComposerState } from "@/composer/persistence"
import { useData } from "@/runtime/server/current"
import { useServerSDK } from "@/runtime/server/client"
import { useWorkspaceLocation } from "@/workspaces/location"
import { useLanguage } from "@/runtime/i18n/language"
import { extractPromptComments, extractPromptFromMessage } from "@/composer/prompt"
import { showToast } from "@/shell/notifications/toast"
import type { SessionModel } from "./model"

export function createSessionRevert(input: {
  session: SessionModel
  setActiveMessage: (message: SessionMessageUser | undefined) => void
}) {
  const prompt = useComposerState()
  const server = useServerSDK()
  const data = useData()
  const location = useWorkspaceLocation()
  const language = useLanguage()

  const request = async (action: () => Promise<unknown>) =>
    action()
      .then(() => true)
      .catch((error) => {
        showToast({
          title: language.t("common.requestFailed"),
          description: error instanceof Error ? error.message : String(error),
        })
        return false
      })
  const restore = (target: ReturnType<typeof prompt.capture>, message: SessionMessageUser) => {
    target.set(
      extractPromptFromMessage(message, {
        directory: location().directory,
      }),
    )
    target.context.replaceComments(
      extractPromptComments(message).map((comment) => ({
        type: "file",
        path: comment.path,
        selection: comment.selection,
        comment: comment.comment,
        preview: comment.preview,
        commentOrigin: comment.origin,
      })),
    )
  }

  const stage = async (message: SessionMessageUser, previous: SessionMessageUser | undefined) => {
    const sessionID = input.session.identity.params.id
    if (!sessionID) return
    const owner = input.session.ownership.capture()
    const target = prompt.capture()
    if (data.session.status(sessionID) === "running") {
      await server.api.session.interrupt({ sessionID }).catch(() => undefined)
    }
    if (!(await request(() => data.session.message.loadMore(sessionID, { until: previous?.id ?? message.id })))) return
    if (!(await request(() => server.api.session.revert.stage({ sessionID, messageID: message.id })))) return
    // Reverting to a previous prompt discards the pending queue (and pending
    // steers): they were written against the history being rewound. Cancel
    // the authoritative inbox merged with the local snapshot, fire-and-forget
    // so a slow request cannot delay restoring the composer. The cutoff keeps
    // the asynchronous sweep away from prompts admitted after the revert; an
    // old admission still in flight when the list is fetched can survive it,
    // and fully closing that race needs a server-side revert-discards-inbox
    // rule.
    const cutoff = Date.now()
    const local = data.session.pending
      .list(sessionID)
      .filter((item) => item.type === "user")
      .map((item) => item.id)
    void server.api.session.inbox
      .list({ sessionID })
      .then((rows) => rows.filter((row) => row.type === "user" && row.timeCreated <= cutoff).map((row) => row.id))
      .catch(() => [])
      .then((authoritative) => {
        new Set([...local, ...authoritative]).forEach(
          (inboxID) => void server.api.session.inbox.cancel({ sessionID, inboxID }).catch(() => undefined),
        )
      })
    restore(target, message)
    owner.run(() => input.setActiveMessage(previous))
  }

  const to = async (messageID: string) => {
    const sessionID = input.session.identity.params.id
    if (!sessionID) return
    const owner = input.session.ownership.capture()
    await request(async () => {
      const message =
        data.session.message.get(sessionID, messageID) ?? (await server.api.session.message({ sessionID, messageID }))
      if (message.type !== "user") return
      const previous = await data.session.message.users(sessionID, {
        boundary: { messageID, direction: "before" },
        limit: 1,
      })
      if (!owner.current()) return
      await stage(message, previous[0])
    })
  }

  const undo = async () => {
    const sessionID = input.session.identity.params.id
    if (!sessionID) return
    const owner = input.session.ownership.capture()
    const reverted = input.session.data.revertMessageID()
    await request(async () => {
      const messages = await data.session.message.users(sessionID, {
        boundary: reverted ? { messageID: reverted, direction: "before" } : undefined,
        limit: 2,
      })
      const message = messages.at(-1)
      if (!message || !owner.current()) return
      await stage(message, messages.at(-2))
    })
  }

  const redo = async () => {
    const sessionID = input.session.identity.params.id
    const reverted = input.session.data.revertMessageID()
    if (!sessionID || !reverted) return
    const owner = input.session.ownership.capture()
    const target = prompt.capture()
    await request(async () => {
      const messages = await data.session.message.users(sessionID, {
        boundary: { messageID: reverted, direction: "after" },
        limit: 1,
      })
      const message =
        data.session.message.get(sessionID, reverted) ??
        (await server.api.session.message({ sessionID, messageID: reverted }))
      if (message.type !== "user" || !owner.current()) return
      const next = messages[0]
      if (next) {
        await stage(next, message)
        return
      }
      await server.api.session.revert.clear({ sessionID })
      target.reset()
      target.context.replaceComments([])
      owner.run(() => input.setActiveMessage(message))
    })
  }

  return { to, undo, redo }
}

export type SessionRevert = ReturnType<typeof createSessionRevert>
