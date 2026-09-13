import { createEffect, createMemo, onCleanup, type Accessor } from "solid-js"
import { createStore } from "solid-js/store"
import { useMutation } from "@tanstack/solid-query"
import type { SessionInboxInfo } from "@opencode/client/promise"
import { SessionMessage } from "@opencode/schema/session-message"
import type { ComposerDelivery } from "@/composer/adapter"
import type { ComposerStateTarget } from "@/composer/submission-state"
import type { ImageAttachmentPart, Prompt } from "@/composer/state"
import { clonePrompt, promptLength } from "@/composer/prompt-parts"
import { buildPromptRequest } from "@/composer/request"
import { blobDataUrl } from "@/runtime/persistence/drafts"
import { useData } from "@/runtime/server/current"
import { useServerSDK } from "@/runtime/server/client"
import { useWorkspaceLocation } from "@/workspaces/location"
import { useLanguage } from "@/runtime/i18n/language"
import { showToast } from "@/shell/notifications/toast"

export type QueuedPrompt = Extract<SessionInboxInfo, { type: "user" }>

type EditStash = {
  prompt: Prompt
  cursor: number
  mode: "normal" | "shell"
  retry: ReturnType<ComposerStateTarget["retry"]["current"]>
}

export function createSessionQueue(input: {
  sessionID: string
  draft: ComposerStateTarget
  working: Accessor<boolean>
  behavior: Accessor<ComposerDelivery>
  restoreFocus: (cursor: number) => void
}) {
  const data = useData()
  const server = useServerSDK()
  const location = useWorkspaceLocation()
  const language = useLanguage()
  const [state, setState] = createStore<{ editing?: { id: string; stash: EditStash } }>({})
  const notify = () => showToast({ title: language.t("common.requestFailed") })
  const mutation = useMutation(() => ({
    mutationFn: async (
      change:
        | { type: "reorder"; inboxIDs: string[] }
        | {
            type: "edit"
            inboxIDs: string[]
            original: string
            replacement: string
            item: QueuedPrompt | undefined
            prompt: Prompt
            text: string
            delivery: ComposerDelivery
          },
    ) => {
      if (change.type === "reorder") return rewrite(change.inboxIDs)
      const replacement = await editedPromptInput(
        input.sessionID,
        location().directory,
        change.item,
        change.prompt,
        change.text,
      )
      // Admit before cancelling so a failed replacement never discards the original.
      const admitted = await data.session.prompt({
        ...replacement,
        id: change.replacement,
        delivery: change.delivery,
        ...(change.delivery === "queue" ? { resume: false } : {}),
      })
      await server.api.session.inbox.cancel({ sessionID: input.sessionID, inboxID: change.original })
      cancelEdit()
      if (change.delivery === "queue")
        await rewrite(change.inboxIDs.map((id) => (id === change.original ? admitted.id : id)))
    },
    onError: notify,
    onSettled: () => data.session.pending.sync(input.sessionID).catch(() => undefined),
  }))

  const queued = createMemo(() =>
    data.session.pending
      .list(input.sessionID)
      .filter((item): item is QueuedPrompt => item.type === "user" && item.delivery === "queue"),
  )
  const rows = createMemo(() => {
    const replacement = mutation.isPending ? mutation.variables : undefined
    return queuedPromptRows(
      queued(),
      replacement?.type === "edit" && replacement.delivery === "queue" ? replacement : undefined,
    )
  })

  createEffect(() => {
    const editing = state.editing
    if (!editing || mutation.isPending || queued().some((item) => item.id === editing.id)) return
    setState("editing", undefined)
  })
  onCleanup(() => cancelEdit())

  const rewrite = async (inboxIDs: string[]) => {
    const pending = await server.api.session.inbox.list({ sessionID: input.sessionID })
    if (pending.some((item) => item.delivery === "queue" && item.type !== "user"))
      throw new Error("Queued control items block reordering")
    const current = pending.filter((item): item is QueuedPrompt => item.type === "user" && item.delivery === "queue")
    const ordered = inboxIDs.flatMap((id) => current.filter((item) => item.id === id))
    if (ordered.length !== current.length) throw new Error("Queued prompts changed before reordering")
    const changed = ordered.findIndex((item, index) => item.id !== current[index]?.id)
    if (changed < 0) return

    // Existing inbox APIs cannot reorder rows, so replace only the changed suffix.
    for (const item of ordered.slice(changed)) {
      await data.session.prompt({
        sessionID: input.sessionID,
        text: item.payload.text,
        files: item.payload.files?.map((file) => ({
          uri: `data:${file.mime};base64,${file.data}`,
          name: file.name,
          description: file.description,
          mention: file.mention,
        })),
        agents: item.payload.agents,
        skills: item.payload.skills,
        metadata: item.payload.metadata,
        delivery: "queue",
        resume: false,
      })
    }
    for (const item of current.slice(changed)) {
      await server.api.session.inbox.cancel({ sessionID: input.sessionID, inboxID: item.id })
    }
  }
  const steer = (id: string) => {
    if (state.editing?.id === id) cancelEdit()
    return server.api.session.inbox.steer({ sessionID: input.sessionID, inboxID: id }).catch(() => notify())
  }
  const remove = (id: string) => {
    if (state.editing?.id === id) cancelEdit()
    return server.api.session.inbox.cancel({ sessionID: input.sessionID, inboxID: id }).catch(() => notify())
  }
  const reorder = (inboxIDs: string[]) => {
    if (mutation.isPending) return Promise.resolve()
    return mutation.mutateAsync({ type: "reorder", inboxIDs }).catch(() => undefined)
  }

  const edit = (id: string) => {
    if (mutation.isPending) return false
    if (state.editing?.id === id) return true
    const item = queued().find((entry) => entry.id === id)
    if (!item) return false
    if (state.editing) cancelEdit()
    const draft = input.draft.current()
    setState("editing", {
      id,
      stash: {
        prompt: clonePrompt(draft),
        cursor: input.draft.cursor() ?? promptLength(draft),
        mode: input.draft.mode.current(),
        retry: input.draft.retry.current(),
      },
    })
    const text = queuedPromptText(item)
    input.draft.mode.set("normal")
    input.draft.set([{ type: "text", content: text, start: 0, end: text.length }], text.length)
    input.restoreFocus(text.length)
    return true
  }
  const cancelEdit = () => {
    const editing = state.editing
    if (!editing) return
    setState("editing", undefined)
    // Mode first, then prompt, then retry: mode and prompt writes both clear
    // the retry marker.
    input.draft.mode.set(editing.stash.mode)
    input.draft.set(editing.stash.prompt, editing.stash.cursor)
    if (editing.stash.retry) input.draft.retry.set(editing.stash.retry)
    input.restoreFocus(editing.stash.cursor)
  }
  const confirmEdit = (delivery: ComposerDelivery) => {
    const editing = state.editing
    if (!editing || mutation.isPending) return
    const prompt = clonePrompt(input.draft.current())
    const text = prompt.map((part) => ("content" in part ? part.content : "")).join("")
    if (!text.trim() && !prompt.some((part) => part.type === "image")) return cancelEdit()
    const item = queued().find((entry) => entry.id === editing.id)
    const pristine = item && text.trim() === queuedPromptText(item) && !prompt.some((part) => part.type === "image")
    if (pristine && delivery === "queue") return cancelEdit()
    mutation.mutate({
      type: "edit",
      inboxIDs: queued().map((entry) => entry.id),
      original: editing.id,
      replacement: SessionMessage.ID.create(),
      item,
      prompt,
      text,
      delivery,
    })
  }
  const editFirst = () => {
    const first = queued()[0]
    if (!first) return false
    return edit(first.id)
  }

  return {
    count: () => queued().length,
    delivery: () => (input.working() ? input.behavior() : "steer"),
    alternate: () => {
      if (state.editing) return "steer"
      if (!input.working()) return undefined
      return input.behavior() === "queue" ? "steer" : "queue"
    },
    editing: () => state.editing?.id,
    confirmEdit,
    cancelEdit,
    editFirst,
    rows,
    busy: () => mutation.isPending,
    working: input.working,
    steer,
    remove,
    edit,
    reorder,
  }
}

export type SessionQueue = ReturnType<typeof createSessionQueue>

// The slice of the queue the panel renders and drives.
export type SessionQueueView = Pick<
  SessionQueue,
  "rows" | "editing" | "working" | "busy" | "steer" | "remove" | "edit" | "reorder"
>

export function queuedPromptRows(items: QueuedPrompt[], replacement?: { original: string; replacement: string }) {
  const replaced = replacement && items.some((item) => item.id === replacement.replacement)
  return items
    .filter((item) => !replaced || item.id !== replacement.original)
    .map((item) => ({
      id: item.id,
      text: queuedPromptText(item),
      attachments: item.payload.files?.length ?? 0,
    }))
}

export function queuedPromptText(item: QueuedPrompt) {
  const display = item.payload.metadata?.["displayText"]
  return typeof display === "string" && display.length > 0 ? display : item.payload.text
}

// Confirming an edit submits the current composer content as the replacement:
// mentions and images added during the edit are parsed like a normal
// submission, the original's stored attachments are preserved, and the
// review-comment notes appended to the original's model-visible text survive.
// Ambient composer context (open review comments) stays out: it belongs to
// the next fresh prompt, not to a queued edit.
async function editedPromptInput(
  sessionID: string,
  directory: string,
  item: QueuedPrompt | undefined,
  prompt: Prompt,
  text: string,
) {
  const images = await Promise.all(
    prompt
      .filter((part): part is ImageAttachmentPart => part.type === "image")
      .map(async (part) => ({ ...part, dataUrl: await blobDataUrl(part.blob, part.mime) })),
  )
  const request = buildPromptRequest({ prompt, context: [], images, text, sessionDirectory: directory })
  const payload = item?.payload
  const display = item ? queuedPromptText(item) : ""
  const notes = payload && display && payload.text.startsWith(display) ? payload.text.slice(display.length) : ""
  const mention = (value: { start: number; end: number; text: string } | undefined) => {
    if (!value) return undefined
    const start = text.indexOf(value.text)
    if (start < 0) return undefined
    return { text: value.text, start, end: start + value.text.length }
  }
  // Structured mentions degrade to plain text in the editor, so an original
  // agent or skill reference survives the edit as long as its mention text
  // still appears; newly typed structured mentions come from the request.
  const agents = [
    ...(payload?.agents?.filter(
      (agent) =>
        agent.mention &&
        text.includes(agent.mention.text) &&
        !request.agents.some((entry) => entry.name === agent.name),
    ) ?? []),
    ...request.agents,
  ]
  const skills = [
    ...(payload?.skills?.filter(
      (skill) =>
        skill.mention && text.includes(skill.mention.text) && !request.skills.some((entry) => entry.id === skill.id),
    ) ?? []),
    ...request.skills,
  ]
  return {
    sessionID,
    text: request.text + notes,
    files: [
      ...(payload?.files?.map((file) => ({
        uri: `data:${file.mime};base64,${file.data}`,
        name: file.name,
        description: file.description,
        mention: mention(file.mention),
      })) ?? []),
      ...request.files.map((file) => ({ uri: file.uri, name: file.name, mention: file.mention })),
    ],
    agents: agents.map((agent) => ({ name: agent.name, mention: mention(agent.mention) })),
    skills: skills.map((skill) => ({ id: skill.id, mention: mention(skill.mention) })),
    metadata: { ...payload?.metadata, displayText: request.displayText },
  }
}
