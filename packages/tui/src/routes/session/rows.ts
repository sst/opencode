import type { SessionInboxEnqueued, SessionMessageAssistant, SessionMessageInfo } from "@opencode/client"
import { createEffect, on, onCleanup, type Accessor } from "solid-js"
import { createStore, produce, reconcile } from "solid-js/store"
import { useConfig } from "../../config"
import { useData } from "../../context/data"
import { useClient } from "../../context/client"
import {
  append,
  completePrevious,
  groupRefs,
  hasPart,
  partitionPending,
  projectEntries,
  type AppendPart,
  type CacheUsage,
  type PartRef,
  type ProjectionEntry,
  type SessionRow,
} from "./grouping/session"
export type { CacheUsage, PartRef, SessionRow } from "./grouping/session"

export function createSessionRows(sessionID: Accessor<string>, onSynced?: (sessionID: string) => void) {
  const data = useData()
  const client = useClient()
  const config = useConfig()
  const [rows, setRows] = createStore<SessionRow[]>([])
  const revertBoundary = () => data.session.get(sessionID())?.revert?.messageID
  const turnTokens = () => Boolean(config.data.debug?.turn_tokens)

  function reduce() {
    const messages = data.session.message.list(sessionID())
    const inputs = new Set(data.session.input.list(sessionID()))
    const pending = data.session.pending.list(sessionID())
    const queued = new Set(
      pending.flatMap((item) => (item.type === "user" && item.delivery === "queue" ? [item.id] : [])),
    )
    const visible = queued.size === 0 ? messages : messages.filter((message) => !queued.has(message.id))
    const boundary = revertBoundary()
    const rows = reduceSessionRows(
      boundary ? visible.filter((message) => message.id < boundary) : visible,
      inputs,
      turnTokens(),
    )
    partitionPending(rows, pendingPermissions())
    const position = rows.findIndex((row) => row.type === "message" && inputs.has(row.messageID))
    rows.splice(
      position === -1 ? rows.length : position,
      0,
      ...pending
        .filter((item) => item.type === "compaction")
        .map((item): SessionRow => ({ type: "compaction-queued", inboxID: item.id })),
    )
    return rows
  }

  function pendingPermissions() {
    return new Set(
      (data.session.permission.list(sessionID()) ?? []).flatMap((request) =>
        request.source?.type === "tool" ? [request.source.id] : [],
      ),
    )
  }

  createEffect(() => {
    const pending = pendingPermissions()
    setRows(
      produce((draft) => {
        partitionPending(draft, pending)
      }),
    )
  })

  createEffect(
    on([sessionID, () => client.connection.status()], ([id, status]) => {
      if (status !== "connected") return
      setRows(reconcile(reduce()))
      void data.session.pending.sync(id).catch(() => undefined)
      void data.session.message.sync(id).then(
        () => {
          if (sessionID() !== id) return
          setRows(reconcile(reduce()))
          onSynced?.(id)
        },
        () => undefined,
      )
    }),
  )

  // Re-reduce when the revert boundary changes (stage/clear/commit). These reactions defer
  // their first run: the mount effect above has already reduced the same state.
  createEffect(
    on(
      revertBoundary,
      () => {
        setRows(reconcile(reduce()))
      },
      { defer: true },
    ),
  )

  createEffect(
    on(
      () =>
        data.session.pending.list(sessionID()).flatMap((item) => {
          if (item.type === "compaction") return [`${item.id}:compaction`]
          if (item.type === "user" && item.delivery === "queue") return [`${item.id}:queue`]
          return []
        }),
      () => setRows(reconcile(reduce())),
      { defer: true },
    ),
  )

  createEffect(
    on(
      () =>
        data.session.message.list(sessionID()).flatMap((message) =>
          message.type === "user" || message.type === "synthetic"
            ? [
                {
                  id: message.id,
                  created: message.time.created,
                  input: data.session.input.has(sessionID(), message.id),
                },
              ]
            : message.type === "compaction"
              ? [
                  {
                    id: message.id,
                    created: message.time.created,
                  },
                ]
              : [],
        ),
      () => setRows(reconcile(reduce())),
      { defer: true },
    ),
  )

  createEffect(on(turnTokens, () => setRows(reconcile(reduce())), { defer: true }))

  const appendMessage = (messageID: string) =>
    setRows(
      produce((draft) => {
        if (draft.some((row) => row.type === "message" && row.messageID === messageID)) return
        const pending = isPending(messageID)
        const message = data.session.message.get(sessionID(), messageID)
        const index =
          message?.type === "compaction" && pending ? queuedStart(draft) : pending ? draft.length : queuedStart(draft)
        if (!pending) completePrevious(draft, index)
        draft.splice(index, 0, { type: "message", messageID })
      }),
    )

  const appendPart = (ref: PartRef, part: AppendPart) =>
    setRows(
      produce((draft) => {
        if (!hasPart(draft, ref)) {
          append(draft, ref, part, queuedStart(draft))
          return
        }
        if (part.type !== "reasoning" || part.time?.completed === undefined) return
        const row = draft.find(
          (row) =>
            row.type === "group" &&
            row.kind === "reasoning" &&
            groupRefs(row).some((item) => item.messageID === ref.messageID && item.partID === ref.partID),
        )
        if (row?.type === "group" && row.kind === "reasoning") row.completed = true
      }),
    )

  const appendFooter = (messageID: string) =>
    setRows(
      produce((draft) => {
        if (draft.some((row) => row.type === "assistant-footer" && row.messageID === messageID)) return
        const index = queuedStart(draft)
        completePrevious(draft, index)
        draft.splice(index, 0, { type: "assistant-footer", messageID })
      }),
    )

  const removeFooter = (messageID: string) =>
    setRows(
      produce((draft) => {
        const index = draft.findIndex((row) => row.type === "assistant-footer" && row.messageID === messageID)
        if (index !== -1) draft.splice(index, 1)
      }),
    )

  const isPending = (messageID: string) => {
    const message = data.session.message.get(sessionID(), messageID)
    if (message?.type === "user" || message?.type === "synthetic") return data.session.input.has(sessionID(), messageID)
    return message?.type === "compaction" && message.status === "running"
  }

  const queuedStart = (rows: SessionRow[]) => {
    const index = rows.findIndex(
      (row) => row.type === "compaction-queued" || (row.type === "message" && isPending(row.messageID)),
    )
    return index === -1 ? rows.length : index
  }

  const message = (event: { id: string; data: { sessionID: string } }) => {
    if (event.data.sessionID === sessionID()) appendMessage(event.id.replace(/^evt_/, "msg_"))
  }
  const input = (event: SessionInboxEnqueued) => {
    if (
      event.data.sessionID === sessionID() &&
      (event.data.item.type === "user" ||
        (event.data.item.type === "synthetic" && event.data.item.payload.description?.trim()))
    )
      appendMessage(event.data.inboxID)
  }
  const subscriptions = [
    data.on("session.inbox.enqueued", input),
    data.on("session.compaction.started", (event) => {
      if (event.data.sessionID === sessionID()) appendMessage(event.data.inputID ?? event.id.replace(/^evt_/, "msg_"))
    }),
    data.on("session.instructions.updated", message),
    data.on("session.synthetic", (event) => {
      if (event.data.sessionID === sessionID() && event.data.description?.trim())
        appendMessage(event.id.replace(/^evt_/, "msg_"))
    }),
    data.on("session.shell.started", message),
    data.on("session.agent.selected", message),
    data.on("session.model.selected", message),
    data.on("session.text.delta", (event) => {
      if (event.data.sessionID === sessionID() && event.data.delta.trim())
        appendPart({ messageID: event.data.assistantMessageID, partID: `text:${event.data.ordinal}` }, { type: "text" })
    }),
    data.on("session.text.ended", (event) => {
      if (event.data.sessionID === sessionID() && event.data.text.trim())
        appendPart({ messageID: event.data.assistantMessageID, partID: `text:${event.data.ordinal}` }, { type: "text" })
    }),
    data.on("session.reasoning.delta", (event) => {
      if (event.data.sessionID === sessionID() && event.data.delta.trim())
        appendPart(
          { messageID: event.data.assistantMessageID, partID: `reasoning:${event.data.ordinal}` },
          { type: "reasoning" },
        )
    }),
    data.on("session.reasoning.ended", (event) => {
      if (event.data.sessionID === sessionID() && event.data.text.trim())
        appendPart(
          { messageID: event.data.assistantMessageID, partID: `reasoning:${event.data.ordinal}` },
          { type: "reasoning", time: { completed: event.created } },
        )
    }),
    data.on("session.tool.input.started", (event) => {
      if (event.data.sessionID === sessionID())
        appendPart(
          { messageID: event.data.assistantMessageID, partID: event.data.id },
          { type: "tool", name: event.data.name },
        )
    }),
    data.on("session.retry.scheduled", (event) => {
      if (event.data.sessionID === sessionID()) appendFooter(event.data.assistantMessageID)
    }),
    data.on("session.step.started", (event) => {
      if (event.data.sessionID === sessionID()) removeFooter(event.data.assistantMessageID)
    }),
    data.on("session.step.ended", (event) => {
      if (event.data.sessionID !== sessionID() || ["tool-calls", "unknown"].includes(event.data.finish)) return
      appendFooter(event.data.assistantMessageID)
      if (turnTokens()) setRows(reconcile(reduce()))
    }),
    data.on("session.step.failed", (event) => {
      if (event.data.sessionID !== sessionID()) return
      appendFooter(event.data.assistantMessageID)
      if (turnTokens()) setRows(reconcile(reduce()))
    }),
  ]
  onCleanup(() => subscriptions.forEach((unsubscribe) => unsubscribe()))

  return rows
}

export function reduceSessionRows(messages: SessionMessageInfo[], inputs = new Set<string>(), turnTokens = false) {
  const isInput = (message: SessionMessageInfo) => inputs.has(message.id)
  const pendingCompactions = messages.filter((message) => message.type === "compaction" && message.status === "running")
  const pending = new Set([...pendingCompactions.map((message) => message.id), ...inputs])
  const usage = turnTokens
    ? { steps: [] as SessionMessageAssistant[], previousTurnCache: undefined as CacheUsage | undefined }
    : undefined
  const entries = [
    ...messages.filter((message) => !pending.has(message.id)),
    ...pendingCompactions,
    ...messages.filter(isInput),
  ].reduce<ProjectionEntry[]>((rows, message) => {
    if (message.type !== "assistant") {
      if (message.type === "idle") return rows
      if (message.type === "synthetic" && !message.description?.trim()) return rows
      if (message.type === "compaction" && message.status === "completed" && usage) usage.previousTurnCache = undefined
      rows.push({ entry: { type: "message", messageID: message.id }, closesPrevious: !pending.has(message.id) })
      return rows
    }
    usage?.steps.push(message)
    const ordinals = { text: 0, reasoning: 0 }
    message.content.forEach((part) => {
      const partID = part.type === "tool" ? part.id : `${part.type}:${ordinals[part.type]++}`
      if ((part.type === "text" || part.type === "reasoning") && !part.text.trim()) return
      rows.push({ entry: { type: "part", ref: { messageID: message.id, partID } }, part })
    })
    const terminal = (message.finish && !["tool-calls", "unknown"].includes(message.finish)) || message.error
    if (terminal || message.retry) {
      rows.push({ entry: { type: "assistant-footer", messageID: message.id } })
    }
    if (terminal && usage) {
      const stepsWithUsage = usage.steps.filter(hasTokenUsage)
      const last = stepsWithUsage.at(-1)
      if (last) {
        rows.push({
          entry: {
            type: "turn-usage",
            messageIDs: stepsWithUsage.map((step) => step.id),
            ...(usage.previousTurnCache === undefined ? {} : { previousCache: usage.previousTurnCache }),
          },
        })
        usage.previousTurnCache = { read: last.tokens.cache.read, model: last.model }
      }
      usage.steps.length = 0
    }
    return rows
  }, [])
  return projectEntries(entries)
}

export function cacheReuseDrop(previous: CacheUsage | undefined, current: CacheUsage) {
  if (previous === undefined) return
  if (
    previous.model.providerID !== current.model.providerID ||
    previous.model.id !== current.model.id ||
    previous.model.variant !== current.model.variant
  )
    return
  const drop = previous.read - current.read
  // OpenAI cache reads can move between one and two 1,024-token buckets without a material loss of reuse.
  if (current.model.providerID === "openai" && drop >= 1_024 && drop <= 2_048) return
  return drop > 0 ? drop : undefined
}

export function turnDuration(message: SessionMessageAssistant, messages: SessionMessageInfo[], position?: number) {
  if (message.time.completed === undefined) return 0
  const index = position ?? messages.findIndex((item) => item.id === message.id)
  const input = messages[inputIndex(messages, index === -1 ? messages.length : index)]
  return Math.max(0, message.time.completed - (input?.time.created ?? message.time.created))
}

export function turnTokensPerSecond(
  message: SessionMessageAssistant,
  messages: SessionMessageInfo[],
  position?: number,
) {
  const index = position ?? messages.findIndex((item) => item.id === message.id)
  const end = index === -1 ? messages.length : index + 1
  const start = inputIndex(messages, end)
  const steps = messages
    .slice(start + 1, end)
    .filter((item): item is SessionMessageAssistant => item.type === "assistant")
  const durations = steps.flatMap((step) =>
    step.time.requestDurationMs === undefined ? [] : [step.time.requestDurationMs],
  )
  if (steps.length === 0 || durations.length !== steps.length) return
  const output = steps.reduce((total, step) => total + (step.tokens?.output ?? 0) + (step.tokens?.reasoning ?? 0), 0)
  const duration = durations.reduce((total, value) => total + value, 0)
  if (output <= 0 || duration <= 0) return
  return output / (duration / 1_000)
}

function inputIndex(messages: SessionMessageInfo[], end: number) {
  // Reading a sliced prefix subscribes every footer to unrelated historical messages.
  for (let index = end - 1; index >= 0; index--) {
    const message = messages[index]
    if (message.type === "user" || message.type === "synthetic") return index
  }
  return -1
}

function hasTokenUsage(
  message: SessionMessageAssistant,
): message is SessionMessageAssistant & { tokens: NonNullable<SessionMessageAssistant["tokens"]> } {
  return message.tokens !== undefined && tokenTotal(message.tokens) > 0
}

function tokenTotal(tokens: NonNullable<SessionMessageAssistant["tokens"]>) {
  return tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write
}

export function messageBoundaryIDs(rows: SessionRow[], messages: SessionMessageInfo[]) {
  const byID = new Map(messages.map((message) => [message.id, message]))
  const seen = new Set<string>()
  return rows.map((row) => {
    const id = rowBoundaryMessageID(row, byID)
    if (!id || seen.has(id)) return undefined
    seen.add(id)
    return id
  })
}

export function sessionRowID(row: SessionRow, boundaryID?: string) {
  if (boundaryID) return boundaryID
  if (row.type === "part") return `session-part:${row.ref.messageID}:${row.ref.partID}`
}

function rowBoundaryMessageID(row: SessionRow, messages: Map<string, SessionMessageInfo>) {
  if (row.type === "message") {
    const message = messages.get(row.messageID)
    if (message?.type === "user" && message.text.trim()) return message.id
    return undefined
  }
  const messageID =
    row.type === "part"
      ? row.ref.messageID
      : row.type === "group"
        ? groupRefs(row)[0]?.messageID
        : row.type === "assistant-footer"
          ? row.messageID
          : row.type === "turn-usage"
            ? row.messageIDs[0]
            : undefined
  if (!messageID) return undefined
  const message = messages.get(messageID)
  if (message?.type === "assistant") return message.id
}

export function resolvePart(message: SessionMessageAssistant, partID: string) {
  const tool = message.content.find((part) => part.type === "tool" && part.id === partID)
  if (tool) return tool
  const match = /^(text|reasoning):(\d+)$/.exec(partID)
  if (!match) return
  const ordinal = Number(match[2])
  return message.content.filter((part) => part.type === match[1])[ordinal]
}
