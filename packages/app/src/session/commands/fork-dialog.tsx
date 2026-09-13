import { Component, onCleanup } from "solid-js"
import type { SessionMessageUser } from "@opencode/client/promise"
import { useNavigate, useParams } from "@solidjs/router"
import { useData } from "@/runtime/server/current"
import { useComposerState } from "@/composer/persistence"
import { useDialog } from "@opencode/ui/context/dialog"
import { Dialog, DialogBody, DialogHeader, DialogTitle } from "@opencode/ui/dialog"
import { List } from "@opencode/ui/list"
import { showToast } from "@/shell/notifications/toast"
import { useLanguage } from "@/runtime/i18n/language"
import { useServerSDK } from "@/runtime/server/client"
import { base64Encode } from "@opencode/util/encode"
import { extractPromptComments, extractPromptFromMessage } from "@/composer/prompt"
import { useWorkspaceLocation } from "@/workspaces/location"
import { useServer } from "@/runtime/server/current"
import { sessionHref } from "@/shell/routes/session"

interface ForkableMessage {
  id: string
  text: string
  time: string
  message: SessionMessageUser
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString(undefined, { timeStyle: "short" })
}

export const DialogFork: Component = () => {
  const params = useParams()
  const navigate = useNavigate()
  const data = useData()
  const serverSDK = useServerSDK()
  const location = useWorkspaceLocation()
  const prompt = useComposerState()
  const dialog = useDialog()
  const language = useLanguage()
  const server = useServer()

  const sessionID = params.id
  const request = new AbortController()
  onCleanup(() => request.abort())
  const messages = sessionID
    ? data.session.message
        .users(sessionID, { signal: request.signal })
        .then((messages): ForkableMessage[] =>
          messages
            .filter((message) => !!message.text)
            .toReversed()
            .map((message) => ({
              id: message.id,
              text: message.text.replace(/\n/g, " ").slice(0, 200),
              time: formatTime(new Date(message.time.created)),
              message,
            })),
        )
        .catch((error) => {
          if (!request.signal.aborted)
            showToast({
              title: language.t("common.requestFailed"),
              description: error instanceof Error ? error.message : String(error),
            })
          return []
        })
    : Promise.resolve([])

  const handleSelect = (item: ForkableMessage | undefined) => {
    if (!item) return

    if (!sessionID) return
    const message = item.message
    const restored = extractPromptFromMessage(message, {
      directory: location().directory,
      attachmentName: language.t("common.attachment"),
    })
    const dir = base64Encode(location().directory)

    serverSDK.api.session
      .fork({ sessionID, boundary: { type: "before", messageID: item.id } })
      .then((forked) => {
        data.session.remember(forked)
        dialog.close()
        const target = prompt.capture({ dir, id: forked.id })
        target.set(restored)
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
        navigate(sessionHref(server.key, forked.id))
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        showToast({ title: language.t("common.requestFailed"), description: message })
      })
  }

  return (
    <Dialog>
      <DialogHeader>
        <DialogTitle>{language.t("command.session.fork")}</DialogTitle>
      </DialogHeader>
      <DialogBody>
        <List
          class="flex-1 px-3 min-h-0 [&_[data-slot=list-scroll]]:flex-1 [&_[data-slot=list-scroll]]:min-h-0"
          search={{ placeholder: language.t("common.search.placeholder"), autofocus: true }}
          emptyMessage={language.t("dialog.fork.empty")}
          key={(x) => x.id}
          items={() => messages}
          filterKeys={["text"]}
          onSelect={handleSelect}
        >
          {(item) => (
            <div class="w-full flex items-center gap-2">
              <span class="truncate flex-1 min-w-0 text-left font-normal">{item.text}</span>
              <span class="text-text-weak shrink-0 font-normal">{item.time}</span>
            </div>
          )}
        </List>
      </DialogBody>
    </Dialog>
  )
}
