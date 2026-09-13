import { SessionMessage } from "@opencode/schema/session-message"
import type { SessionMessageUser, SkillInfo } from "@opencode/client/promise"
import { Skill } from "@opencode/schema/skill"
import { Event } from "@opencode/schema/event"
import type { Accessor } from "solid-js"
import type { PromptHistoryComment } from "./history/entry"
import type { ImageAttachmentPart, Prompt } from "./state"
import { clonePrompt, promptLength } from "./prompt-parts"
import type { ComposerAdapter, ComposerDelivery, ComposerSelection, ComposerSession } from "./adapter"
import { createComposerSubmission } from "./submission-state"
import { buildPromptRequest } from "./request"
import { setCursorPosition } from "./editor/dom"
import { blobDataUrl } from "@/runtime/persistence/drafts"
import type { ModelSelection } from "@/providers/models/selection"

const submitting = new WeakSet<object>()

type ComposerSubmission = {
  id: SessionMessage.ID
  mode: "normal" | "shell"
  prompt: Prompt
  context: ReturnType<ComposerAdapter["state"]["context"]["items"]>
  text: string
  images: ImageAttachmentPart[]
  selection: ComposerSelection
  delivery: ComposerDelivery
}

type ComposerSubmitInput = {
  adapter: ComposerAdapter
  mode: Accessor<"normal" | "shell">
  commands: Accessor<readonly { name: string }[] | undefined>
  skills: Accessor<readonly Pick<SkillInfo, "id" | "name" | "slash">[] | undefined>
  editor: () => HTMLDivElement | undefined
  queueScroll: () => void
  addToHistory: (prompt: Prompt, mode: "normal" | "shell") => void
  resetHistory: () => void
  setMode: (mode: "normal" | "shell") => void
  closePopover: () => void
  delivery?: (alternate: boolean) => ComposerDelivery
  notify: {
    missingSelection: () => void
    failed: (kind: "shell" | "command" | "prompt", error: unknown) => void
  }
  comments: {
    capture: () => PromptHistoryComment[]
    clear: () => void
    restore: (comments: PromptHistoryComment[]) => void
  }
}

export function createComposerSubmit(input: ComposerSubmitInput) {
  const submit = async (event: globalThis.Event, options?: { alternate?: boolean }) => {
    event.preventDefault()

    const submission = createComposerSubmission({
      target: input.adapter.state,
      prompt: clonePrompt(input.adapter.state.current()),
      context: input.adapter.state.context.items().map((item) => ({
        ...item,
        selection: item.selection ? { ...item.selection } : undefined,
      })),
    })
    const value = readSubmission(input, submission.prompt, submission.context, options?.alternate ?? false)
    if (!value) {
      if (input.adapter.working() && input.adapter.kind === "active-session") void input.adapter.interrupt()
      return
    }
    if (submitting.has(input.adapter.state)) return
    submitting.add(input.adapter.state)
    const comments = input.comments.capture()
    // Capture command intent before starting a session in a worktree whose catalog has not loaded.
    const command = value.mode === "normal" ? findCommand(input.commands(), value.text) : undefined
    if (value.mode === "normal" && !command) value.prompt = withSlashSkill(value.prompt, input.skills())

    try {
      const started =
        input.adapter.kind === "active-session"
          ? { session: input.adapter.session(), cleanupReady: Promise.resolve() }
          : await input.adapter.start(value.selection, submission, handoffMessage(value))
      if (!started) return
      const session = started.session

      input.addToHistory(value.prompt, value.mode)
      input.resetHistory()
      const restore = () => restoreSubmission(input, submission, value, comments)

      if (value.mode === "normal" && !command) {
        session.handoff?.set(handoffMessage(value))
        const optimisticBusy = !input.adapter.working()
        if (optimisticBusy && input.adapter.kind === "new-session")
          session.data.session.setStatus(session.id, "running")
        const sending = sendPrompt(session, value, input.adapter.controls().model.selection.trackSessionCommit, () => {
          if (optimisticBusy && input.adapter.kind === "active-session")
            session.data.session.setStatus(session.id, "running")
        }).then(
          () => ({ ok: true as const }),
          (error) => ({ ok: false as const, error }),
        )
        await started.cleanupReady
        await started.complete?.()
        input.adapter.submitted()
        submission.context
          .filter((item) => !!item.comment?.trim())
          .forEach((item) => submission.target().context.remove(item.key))
        input.comments.clear()
        clearSubmission(input, submission)
        void sending.then((result) => {
          if (!result.ok)
            failSubmission(input, session, "prompt", result.error, restore, value.id, () => {
              if (optimisticBusy) session.data.session.setStatus(session.id, "idle")
            })
        })
        return
      }

      await started.cleanupReady
      await started.complete?.()
      input.adapter.submitted()

      if (value.mode === "shell") {
        clearSubmission(input, submission)
        void sendShell(session, value).catch((error) => failSubmission(input, session, "shell", error, restore))
        return
      }

      if (command) {
        clearSubmission(input, submission)
        void sendCommand(session, value, command, input.adapter.controls().model.selection.trackSessionCommit).catch(
          (error) => failSubmission(input, session, "command", error, restore, value.id),
        )
        return
      }
    } finally {
      submitting.delete(input.adapter.state)
    }
  }

  return {
    submit,
    stop: () => (input.adapter.kind === "active-session" ? input.adapter.interrupt() : Promise.resolve()),
  }
}

function handoffMessage(value: ComposerSubmission): SessionMessageUser {
  return {
    id: value.id,
    type: "user",
    text: value.text,
    files: value.images.map((image) => ({
      data: "",
      mime: image.mime,
      source: { type: "uri", uri: image.blob.url },
      name: image.sourcePath ?? image.filename,
    })),
    metadata: {
      displayText: value.text,
      comments: value.context.flatMap((item) =>
        item.comment?.trim()
          ? [
              {
                path: item.path,
                comment: item.comment.trim(),
                ...(item.selection ? { selection: { ...item.selection } } : {}),
                ...(item.preview !== undefined ? { preview: item.preview } : {}),
                ...(item.commentOrigin ? { origin: item.commentOrigin } : {}),
              },
            ]
          : [],
      ),
      agent: value.selection.agent,
      model: {
        ...value.selection.model,
        ...(value.selection.variant ? { variant: value.selection.variant } : {}),
      },
    },
    time: { created: Date.now() },
  }
}

function readSubmission(
  input: ComposerSubmitInput,
  prompt: Prompt,
  context: ComposerSubmission["context"],
  alternate: boolean,
): ComposerSubmission | undefined {
  const text = prompt.map((part) => ("content" in part ? part.content : "")).join("")
  const mode = input.mode()
  if (mode === "shell" && !text.trim()) return
  const images = prompt.filter((part): part is ImageAttachmentPart => part.type === "image")
  const comments = context.filter((item) => !!item.comment?.trim()).length
  if (!text.trim() && images.length === 0 && comments === 0) return

  const controls = input.adapter.controls()
  const model = controls.model.selection.current()
  const agent = controls.agents.current
  if (!model || !agent) {
    input.notify.missingSelection()
    return
  }
  const variant = controls.model.selection.variant.current()
  const retry = input.adapter.state.retry.current()
  const retryID =
    retry &&
    retry.agent === agent &&
    retry.providerID === model.provider.id &&
    retry.modelID === model.id &&
    (retry.variant ?? "default") === (variant ?? "default")
      ? retry.id
      : undefined

  return {
    id: retryID ?? SessionMessage.ID.create(),
    mode,
    prompt,
    context,
    text,
    images,
    selection: {
      agent,
      model: { modelID: model.id, providerID: model.provider.id },
      variant,
    },
    delivery: input.delivery?.(alternate) ?? "steer",
  }
}

function clearSubmission(input: ComposerSubmitInput, submission: ReturnType<typeof createComposerSubmission>) {
  submission.clear()
  submission.target().mode.set("normal")
  input.setMode("normal")
  input.closePopover()
}

function restoreSubmission(
  input: ComposerSubmitInput,
  submission: ReturnType<typeof createComposerSubmission>,
  value: ComposerSubmission,
  comments: PromptHistoryComment[],
) {
  const restored = submission.restore()
  if (!restored) return false
  restored.target.set(restored.prompt, promptLength(restored.prompt))
  restored.target.mode.set(value.mode)
  restored.target.context.replaceComments(
    restored.context
      .filter((item) => !!item.comment?.trim())
      .map((item) => ({
        type: "file",
        path: item.path,
        selection: item.selection,
        comment: item.comment,
        commentID: item.commentID,
        commentOrigin: item.commentOrigin,
        preview: item.preview,
      })),
  )
  // A recovered follow-up changes the payload, so it must use a new admission ID.
  if (value.mode === "normal" && restored.prompt === submission.prompt) {
    restored.target.retry.set({
      id: value.id,
      agent: value.selection.agent,
      providerID: value.selection.model.providerID,
      modelID: value.selection.model.modelID,
      variant: value.selection.variant,
    })
  }
  if (!submission.current(input.adapter.state)) return true

  input.comments.restore(comments)
  input.setMode(value.mode)
  input.closePopover()
  requestAnimationFrame(() => {
    const editor = input.editor()
    if (!editor) return
    editor.focus()
    setCursorPosition(editor, promptLength(value.prompt))
    input.queueScroll()
  })
  return true
}

async function sendShell(session: ComposerSession, value: ComposerSubmission) {
  await session.api.shell({ sessionID: session.id, id: Event.ID.create(), command: value.text })
}

function findCommand(commands: ReturnType<ComposerSubmitInput["commands"]>, text: string) {
  if (!text.startsWith("/")) return
  const [name, ...arguments_] = text.split(" ")
  const command = name.slice(1)
  if (!commands?.some((item) => item.name === command)) return
  return { command, arguments: arguments_.join(" ") }
}

export function withSlashSkill(prompt: Prompt, skills: ReturnType<ComposerSubmitInput["skills"]>): Prompt {
  const first = prompt[0]
  if (first?.type !== "text") return prompt
  const name = /^\/(\S+)(?:\s|$)/.exec(first.content)?.[1]
  const skill = skills?.find((item) => item.slash === true && item.id === name)
  if (!skill || prompt.some((part) => part.type === "skill" && part.id === skill.id)) return prompt
  const content = `/${skill.id}`
  return [
    {
      type: "skill",
      id: Skill.ID.make(skill.id),
      name: Skill.Name.make(skill.name),
      content,
      start: 0,
      end: content.length,
    },
    { ...first, content: first.content.slice(content.length), start: content.length },
    ...prompt.slice(1),
  ]
}

async function sendCommand(
  session: ComposerSession,
  value: ComposerSubmission,
  command: { command: string; arguments: string },
  track?: ModelSelection["trackSessionCommit"],
) {
  const request = await buildSubmissionRequest(session, value)
  // Like queued prompts, queued commands must not apply the composer's selection to active work.
  if (value.delivery === "steer") await applySelection(session, value.selection, track)
  await session.api.command({
    sessionID: session.id,
    command: command.command,
    text: command.arguments,
    files: request.files.map((file) => ({ uri: file.uri, name: file.name, mention: file.mention })),
    agents: request.agents,
    skills: request.skills,
    delivery: value.delivery,
  })
}

async function applySelection(
  session: ComposerSession,
  selection: ComposerSelection,
  track?: ModelSelection["trackSessionCommit"],
) {
  const cancel = track?.(session.id, selection)
  try {
    const current = session.current()
    if (current?.agent !== selection.agent) {
      await session.api.switchAgent({ sessionID: session.id, agent: selection.agent })
    }
    // The server deduplicates unchanged selections; cached SSE state may still be behind an earlier switch.
    await session.api.switchModel({
      sessionID: session.id,
      model: { id: selection.model.modelID, providerID: selection.model.providerID, variant: selection.variant },
    })
  } catch (error) {
    cancel?.()
    throw error
  }
}

async function sendPrompt(
  session: ComposerSession,
  value: ComposerSubmission,
  track: ModelSelection["trackSessionCommit"] | undefined,
  onAdmit: () => void,
) {
  const request = await buildSubmissionRequest(session, value)
  // Switching agent or model reconfigures the session immediately, and with it
  // the remainder of a running turn. A steer targets that turn, so its
  // selection applies now; a queued follow-up must not reconfigure the turn it
  // waits behind, so it runs with the session selection at delivery time (the
  // intended selection stays recorded in its metadata).
  if (value.delivery === "steer") {
    await applySelection(session, value.selection, track)
  }

  const admission = {
    id: value.id,
    sessionID: session.id,
    delivery: value.delivery,
    text: request.text,
    files: request.files.map((file) => ({ uri: file.uri, name: file.name, mention: file.mention })),
    agents: request.agents,
    skills: request.skills,
    metadata: {
      displayText: request.displayText,
      comments: request.comments,
      agent: value.selection.agent,
      model: {
        ...value.selection.model,
        ...(value.selection.variant ? { variant: value.selection.variant } : {}),
      },
    },
  }
  const sending = session.data.session.prompt(admission).catch(() => session.data.session.prompt(admission))
  onAdmit()
  await sending
}

async function buildSubmissionRequest(session: ComposerSession, value: ComposerSubmission) {
  const images = await Promise.all(
    value.images.map(async (attachment) => ({
      ...attachment,
      dataUrl: await blobDataUrl(attachment.blob, attachment.mime),
    })),
  )
  const request = buildPromptRequest({
    prompt: value.prompt,
    context: value.context,
    images,
    text: value.text,
    sessionDirectory: session.directory,
  })
  return request
}

function failSubmission(
  input: ComposerSubmitInput,
  session: ComposerSession,
  kind: "shell" | "command" | "prompt",
  error: unknown,
  restore: () => boolean,
  messageID?: string,
  rollback?: () => void,
) {
  if (messageID && session.admitted(messageID)) return
  if (messageID) session.handoff?.clear(messageID)
  rollback?.()
  restore()
  input.notify.failed(kind, error)
}
