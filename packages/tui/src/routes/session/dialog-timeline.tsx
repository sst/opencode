import { createMemo, createResource, onCleanup, onMount } from "solid-js"
import { useData } from "../../context/data"
import { DialogSelect, type DialogSelectOption } from "../../ui/dialog-select"
import { Locale } from "../../util/locale"
import { DialogMessage } from "./dialog-message"
import { useDialog } from "../../ui/dialog"
import type { PromptInfo } from "../../prompt/history"
import { Spinner } from "../../component/spinner"
import { useToast } from "../../ui/toast"

export function DialogTimeline(props: {
  sessionID: string
  onMove: (messageID: string) => void
  setPrompt?: (prompt: PromptInfo) => void
}) {
  const data = useData()
  const dialog = useDialog()
  const toast = useToast()
  const request = new AbortController()
  onCleanup(() => request.abort())
  const [messages] = createResource(() =>
    data.session.message.users(props.sessionID, { signal: request.signal }).catch((error) => {
      if (!request.signal.aborted) toast.error(error)
      return []
    }),
  )

  onMount(() => {
    dialog.setSize("large")
  })

  const options = createMemo((): DialogSelectOption<string>[] => {
    const result = [] as DialogSelectOption<string>[]
    for (const message of messages() ?? []) {
      result.push({
        title: message.text.replace(/\n/g, " "),
        value: message.id,
        footer: Locale.time(message.time.created),
        onSelect: (dialog) => {
          dialog.replace(() => (
            <DialogMessage
              messageID={message.id}
              message={message}
              sessionID={props.sessionID}
              setPrompt={props.setPrompt}
              onMove={props.onMove}
            />
          ))
        },
      })
    }
    result.reverse()
    return result
  })

  return (
    <DialogSelect
      onMove={(option) => {
        if (data.session.message.get(props.sessionID, option.value)) props.onMove(option.value)
      }}
      title="Timeline"
      options={options()}
      emptyView={
        messages.loading ? (
          <box paddingLeft={4} paddingRight={4}>
            <Spinner>Loading session history…</Spinner>
          </box>
        ) : undefined
      }
    />
  )
}
