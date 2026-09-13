import { createMemo, createResource, createSignal, onCleanup, onMount, Show } from "solid-js"
import type { SessionMessageUser } from "@opencode/client"
import { useData } from "../../context/data"
import { useRoute } from "../../context/route"
import { useClient } from "../../context/client"
import { Spinner } from "../../component/spinner"
import { DialogSelect, type DialogSelectOption } from "../../ui/dialog-select"
import { useDialog } from "../../ui/dialog"
import { useToast } from "../../ui/toast"
import { errorMessage } from "../../util/error"
import { Locale } from "../../util/locale"
import { projectedPromptInput } from "../../prompt/codec"

export function DialogFork(props: {
  sessionID: string
  message?: SessionMessageUser
  onMove?: (messageID?: string) => void
}) {
  const data = useData()
  const dialog = useDialog()
  const client = useClient()
  const route = useRoute()
  const toast = useToast()
  const [pending, setPending] = createSignal(!!props.message)
  const request = new AbortController()
  onCleanup(() => request.abort())
  const [messages] = createResource(
    () => !props.message,
    () =>
      data.session.message.users(props.sessionID, { signal: request.signal }).catch((error) => {
        if (!request.signal.aborted) toast.error(error)
        return []
      }),
  )

  const fork = async (message?: SessionMessageUser) => {
    setPending(true)
    const result = await client.api.session
      .fork({
        sessionID: props.sessionID,
        boundary: message ? { type: "before", messageID: message.id } : { type: "through" },
      })
      .catch((error) => {
        toast.show({ message: errorMessage(error), variant: "error", duration: 5000 })
        return undefined
      })
    if (!result) return dialog.clear()
    const prompt = message ? projectedPromptInput(message) : undefined
    route.navigate({
      sessionID: result.id,
      type: "session",
      prompt: prompt
        ? {
            ...prompt,
            agents: prompt.agents ?? [],
            pasted: [],
          }
        : undefined,
    })
    dialog.clear()
    toast.show({ message: "Forked session", variant: "success", duration: 4000 })
  }

  onMount(() => {
    dialog.setSize("large")
    if (props.message) void fork(props.message)
  })

  const options = createMemo((): DialogSelectOption<string | undefined>[] => [
    {
      title: "Full session",
      value: undefined,
      onSelect: () => fork(),
    },
    ...(messages() ?? []).toReversed().map((message) => ({
      title: message.text.replace(/\n/g, " "),
      value: message.id,
      footer: Locale.time(message.time.created),
      onSelect: () => fork(message),
    })),
  ])

  return (
    <Show
      when={!pending()}
      fallback={
        <box paddingLeft={2} paddingRight={2} paddingBottom={1}>
          <Spinner>Forking session…</Spinner>
        </box>
      }
    >
      <DialogSelect
        onMove={(option) => {
          if (!option.value || data.session.message.get(props.sessionID, option.value)) props.onMove?.(option.value)
        }}
        title="Fork session"
        options={options()}
        footer={
          <Show when={messages.loading}>
            <Spinner>Loading session history…</Spinner>
          </Show>
        }
      />
    </Show>
  )
}
