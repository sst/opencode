import { createMemo } from "solid-js"
import { useData } from "../../context/data"
import { DialogSelect } from "../../ui/dialog-select"
import { useClipboard } from "../../context/clipboard"
import { useToast } from "../../ui/toast"
import { useClient } from "../../context/client"
import { errorMessage } from "../../util/error"
import { DialogFork } from "./dialog-fork"
import type { PromptInfo } from "../../prompt/history"
import { projectedPromptInput } from "../../prompt/codec"
import type { SessionMessageInfo } from "@opencode/client"

export function DialogMessage(props: {
  messageID: string
  message?: SessionMessageInfo
  sessionID: string
  setPrompt?: (prompt: PromptInfo) => void
  onMove?: (messageID: string) => void
}) {
  const data = useData()
  const clipboard = useClipboard()
  const toast = useToast()
  const client = useClient()
  const message = createMemo(() => props.message ?? data.session.message.get(props.sessionID, props.messageID))

  return (
    <DialogSelect
      title="Message Actions"
      options={[
        {
          title: "Jump to",
          value: "message.jump",
          description: "view message in session",
          onSelect: (dialog) => {
            props.onMove?.(props.messageID)
            dialog.clear()
          },
        },
        {
          title: "Revert",
          value: "session.revert",
          description: "undo messages and file changes",
          onSelect: (dialog) => {
            const value = message()
            if (value?.type === "user") {
              props.setPrompt?.({
                ...projectedPromptInput(value),
                pasted: [],
              })
            }
            void data.session.message
              .loadMore(props.sessionID, { until: props.messageID })
              .then(() => client.api.session.revert.stage({ sessionID: props.sessionID, messageID: props.messageID }))
              .catch((error) => toast.show({ message: errorMessage(error), variant: "error", duration: 5000 }))
            dialog.clear()
          },
        },
        {
          title: "Copy",
          value: "message.copy",
          description: "message text to clipboard",
          onSelect: async (dialog) => {
            const value = message()
            if (!value) return
            const text =
              value.type === "user"
                ? value.text
                : value.type === "assistant"
                  ? value.content
                      .filter((content) => content.type === "text")
                      .map((content) => content.text)
                      .join("\n")
                  : "text" in value
                    ? value.text
                    : ""
            try {
              await clipboard.write(text)
              dialog.clear()
            } catch (error) {
              toast.error(error)
            }
          },
        },
        {
          title: "Fork",
          value: "session.fork",
          description: "create a new session",
          onSelect: (dialog) => {
            const value = message()
            if (!value || value.type !== "user") return
            dialog.replace(() => <DialogFork sessionID={props.sessionID} message={value} />)
          },
        },
      ]}
    />
  )
}
