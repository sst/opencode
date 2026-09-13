import type {
  EventSubscribeOutput,
  FormInfo,
  LocationRef,
  OpenCodeClient,
  PermissionRequest,
  SessionMessageAssistantTool,
  SessionMessageInfo,
  SessionMessageUser,
  SessionInboxInfo,
} from "@opencode/client/promise"
import { Event } from "@opencode/schema/event"
import { SessionMessage } from "@opencode/schema/session-message"
import { blockerStatus, pickBlockerView } from "./session-data"
import { writeSessionOutput } from "./stream"
import { createFragmentReconciler, fragmentRef, type FragmentReconciler } from "./stream-v2.fragment"
import { toolImageCommits, userImageCommits, type ImageCommit } from "./stream-v2.image"
import { messagePrompt } from "./session.shared"
import { createSubagentTracker, toolCommit, toolFinalPhase } from "./stream-v2.subagent"
import { normalizeTool, toolOutputText } from "./tool"
import { toolDisplayContent } from "../util/tool-display"
import type {
  FooterApi,
  FooterPatch,
  FooterView,
  LocalReplayRow,
  MiniPermissionRequest,
  MiniFormRequest,
  FooterQueuedPrompt,
  RunFilePart,
  RunInput,
  RunDelivery,
  RunPrompt,
  RunPromptPart,
  StreamCommit,
} from "./types"

type Trace = {
  write(type: string, data?: unknown): void
}

type StreamInput = {
  sdk: OpenCodeClient
  reconnect?: (signal: AbortSignal) => Promise<OpenCodeClient>
  onClient?: (sdk: OpenCodeClient) => void
  readTextFile?: (url: string) => Promise<string>
  location?: LocationRef
  sessionID: string
  thinking: boolean
  tools?: boolean
  replay?: boolean
  replayLimit?: number
  footer: FooterApi
  onCommit?: (commit: StreamCommit) => void
  onSessionTitle?: (title: string) => void
  trace?: Trace
  signal?: AbortSignal
  onCatalogRefresh?: (signal?: AbortSignal) => unknown | Promise<unknown>
  contextLimit?: (model: NonNullable<RunInput["model"]>) => number | undefined
}

export type SessionTurnInput = {
  agent: string | undefined
  model: RunInput["model"]
  variant: string | undefined
  prompt: RunPrompt
  files: RunFilePart[]
  includeFiles: boolean
  signal?: AbortSignal
}

export type SessionResizeReplayInput = {
  localRows: () => LocalReplayRow[]
  reset: () => Promise<void>
}

export type SessionTransport = {
  runPromptTurn(input: SessionTurnInput, admitted?: () => void): Promise<void>
  admitPromptTurn(input: SessionTurnInput, delivery: RunDelivery): Promise<void>
  waitForIdle(): Promise<void>
  interruptActiveTurn(): Promise<void>
  selectSubagent(sessionID: string | undefined): void
  replayOnResize(input: SessionResizeReplayInput): Promise<boolean>
  close(): Promise<void>
  settleForm?(sessionID: string, formID: string): void
}

type Wait = {
  messageID: string
  failureMessageID: string
  promoted: boolean
  promotionObserved: boolean
  interrupted: boolean
  failureRendered: boolean
  terminalError?: Error
}

// One active session.shell call. The HTTP response is the completion signal;
// id correlates the live shell events once shell.started is observed, and
// abort cancels the blocking request when the user interrupts the turn.
type ShellWait = {
  eventID: string
  messageID: string
  id?: string
  resolve: () => void
  abort: () => void
}

type RunV2Event = EventSubscribeOutput
type PromptFilePart = Extract<RunPromptPart, { type: "file" }>

type Attempt = {
  client: OpenCodeClient
  signal: AbortSignal
  generation: number
}

type ReplayBuffer = {
  attempt: Attempt
  events: RunV2Event[]
}

type ToolState = {
  part: SessionMessageAssistantTool
  output: string
  version: number
  started: boolean
}

type PendingPrompt = FooterQueuedPrompt & { files: SessionMessageUser["files"] }

type State = {
  permissions: MiniPermissionRequest[]
  forms: MiniFormRequest[]
  globalForms: MiniFormRequest[]
  view: FooterView
  messageIDs: Set<string>
  // Delivery can arrive before the admission response supplies the user content.
  promotedMessages: Set<string>
  imageIDs: Set<string>
  fragments: FragmentReconciler
  tools: Map<string, ToolState>
  toolSources: Map<string, SessionMessageAssistantTool>
  finishedTools: Set<string>
  toolMessages: Set<string>
  quietText: Map<string, Array<{ partID: string; text: string }>>
  skillMessages: Set<string>
  shellCommands: Map<string, string>
  shellStarted: Set<string>
  shellEnded: Set<string>
  shellWait?: ShellWait
  wait?: Wait
  connected: boolean
  closed: boolean
  initial: boolean
  rootActive: boolean
  /** Bumped on every root execution lifecycle event; guards paints against stale acks. */
  executionEpoch: number
  buffered?: ReplayBuffer
  errors: Set<string>
  pending: Map<string, PendingPrompt>
  admitted: Set<string>
  stepModel: RunInput["model"]
  activeCompaction?: string
}

export function formatUnknownError(error: unknown): string {
  if (typeof error === "string") return error
  if (error instanceof Error) return error.message || error.name
  if (error && typeof error === "object") {
    const message = Reflect.get(error, "message")
    if (typeof message === "string" && message.trim()) return message
    const tag = Reflect.get(error, "_tag")
    if (typeof tag === "string" && tag.trim()) return tag
  }
  return "unknown error"
}

function sessionID(event: RunV2Event) {
  if (event.type === "form.created") return event.data.form.sessionID
  return "sessionID" in event.data && typeof event.data.sessionID === "string" ? event.data.sessionID : undefined
}

function sameLocation(left: LocationRef | undefined, right: LocationRef | undefined) {
  return !!left && !!right && left.directory === right.directory && left.workspaceID === right.workspaceID
}

function globalForm(form: FormInfo, location: LocationRef): MiniFormRequest {
  return { ...form, location: { directory: location.directory, workspaceID: location.workspaceID } }
}

function errorMessage(error: { message?: string; _tag?: string }) {
  return error.message || error._tag || "Session execution failed"
}

function pendingPrompt(item: SessionInboxInfo): PendingPrompt | undefined {
  if (item.type !== "user") return undefined
  return {
    messageID: item.id,
    prompt: { messageID: item.id, ...messagePrompt(item.payload) },
    files: item.payload.files,
    delivery: item.delivery,
    ...(item.payload.skills?.length
      ? { skills: item.payload.skills.map((skill) => ({ id: skill.id, name: skill.name })) }
      : {}),
  }
}

function wait(delay: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(done, delay)
    signal.addEventListener("abort", done, { once: true })
    function done() {
      clearTimeout(timer)
      signal.removeEventListener("abort", done)
      resolve()
    }
  })
}

function nextEvent(stream: AsyncIterator<RunV2Event>, signal: AbortSignal) {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("Event stream aborted"))
  return new Promise<IteratorResult<RunV2Event>>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort)
      reject(signal.reason ?? new Error("Event stream aborted"))
    }
    signal.addEventListener("abort", abort, { once: true })
    void stream.next().then(
      (next) => {
        signal.removeEventListener("abort", abort)
        resolve(next)
      },
      (error) => {
        signal.removeEventListener("abort", abort)
        reject(error)
      },
    )
  })
}

async function prepareInitialFile(file: RunFilePart, readTextFile?: StreamInput["readTextFile"]) {
  if (file.mime !== "text/plain") return { type: "file" as const, file: { uri: file.url, name: file.filename } }
  const content = file.url.startsWith("data:")
    ? Buffer.from(file.url.slice(file.url.indexOf(",") + 1), "base64").toString("utf8")
    : await (readTextFile?.(file.url) ?? Promise.reject(new Error("Local text file acquisition is unavailable")))
  return { type: "text" as const, text: `<file name="${file.filename}">\n${content}\n</file>` }
}

function promptFileMention(part: PromptFilePart) {
  if (!part.source?.text) return
  return {
    start: part.source.text.start,
    end: part.source.text.end,
    text: part.source.text.value,
  }
}

function promptFiles(next: SessionTurnInput) {
  return next.prompt.parts.flatMap((part) =>
    part.type === "file"
      ? [
          {
            uri: part.url,
            name: part.filename,
            ...(part.description === undefined ? {} : { description: part.description }),
            mention: promptFileMention(part),
          },
        ]
      : [],
  )
}

async function prepareAttachments(
  next: SessionTurnInput,
  mode: "command" | "prompt",
  readTextFile?: StreamInput["readTextFile"],
) {
  const initial = next.includeFiles ? next.files : []
  if (mode === "command") {
    return {
      text: [],
      files: [...initial.map((file) => ({ uri: file.url, name: file.filename })), ...promptFiles(next)],
    }
  }
  const prepared = await Promise.all(initial.map((file) => prepareInitialFile(file, readTextFile)))
  return {
    text: prepared.flatMap((file) => (file.type === "text" ? [file.text] : [])),
    files: [...prepared.flatMap((file) => (file.type === "file" ? [file.file] : [])), ...promptFiles(next)],
  }
}

function promptAgents(next: SessionTurnInput) {
  return next.prompt.parts.flatMap((part) =>
    part.type === "agent"
      ? [
          {
            name: part.name,
            mention: part.source
              ? { start: part.source.start, end: part.source.end, text: part.source.value }
              : undefined,
          },
        ]
      : [],
  )
}

function promptSkills(next: SessionTurnInput) {
  return next.prompt.parts.flatMap((part) =>
    part.type === "skill"
      ? [
          {
            id: part.id,
            mention: part.source
              ? { start: part.source.start, end: part.source.end, text: part.source.value }
              : undefined,
          },
        ]
      : [],
  )
}

function streamPartKey(messageID: string, partID: string) {
  return `${messageID}\u0000${partID}`
}

function permissionSourceKey(messageID: string, id: string) {
  return streamPartKey(messageID, id)
}

function permissionTool(request: PermissionRequest, tools: Map<string, SessionMessageAssistantTool>) {
  if (request.source?.type !== "tool") return request
  const tool = tools.get(permissionSourceKey(request.source.messageID, request.source.id))
  return tool ? { ...request, tool } : request
}

// Direct shell calls use one "start" commit rendering `$ command` and one "progress"
// commit rendering the merged output (see toolEntryBody in tool.ts).
function shellCommit(
  id: string,
  command: string,
  next: Pick<StreamCommit, "text" | "phase" | "toolState" | "toolError">,
): StreamCommit {
  return {
    kind: "tool",
    source: "tool",
    partID: `shell:${id}`,
    tool: "shell",
    shell: { command },
    ...next,
  }
}

function shellTerminal(
  id: string,
  command: string,
  shell: { status: string; exit?: number | string },
  output: { output: string; cursor: number; size: number; truncated: boolean },
) {
  const incomplete = output.truncated || output.cursor < output.size
  const text = `${output.output}${incomplete ? `${output.output.endsWith("\n") || !output.output ? "" : "\n"}[output truncated]` : ""}`
  const error =
    shell.status === "exited" && shell.exit === 0
      ? undefined
      : shell.status === "exited"
        ? `Shell exited with code ${shell.exit ?? "unknown"}`
        : `Shell ${shell.status}`
  if (!error) return [shellCommit(id, command, { text, phase: "progress", toolState: "completed" })]
  return [
    ...(text ? [shellCommit(id, command, { text, phase: "progress", toolState: "running" })] : []),
    shellCommit(id, command, { text: error, phase: "final", toolState: "error", toolError: error }),
  ]
}

function messageIDFromEvent(id: string) {
  return SessionMessage.ID.fromEvent(Event.ID.make(id))
}

const catalogEvents = new Set([
  "catalog.updated",
  "integration.updated",
  "credential.switched",
  "agent.updated",
  "command.updated",
  "skill.updated",
  "reference.updated",
])

// session.shell resolves after the command settled server-side; the matching
// live shell.ended event usually lands within the same tick, but hold the turn
// briefly so the output commit renders inside it.
const SHELL_OUTPUT_GRACE_MS = 1500

function skillCommit(messageID: string, name: string, skillID = messageID): StreamCommit {
  return {
    kind: "system",
    source: "system",
    messageID,
    partID: `skill:${skillID}`,
    text: `→ Skill "${name}"`,
    phase: "start",
  }
}

function skillCommits(messageID: string, skills: FooterQueuedPrompt["skills"] = []) {
  return Array.from(new Map(skills.map((skill) => [skill.id, skill])).values(), (skill) =>
    skillCommit(messageID, skill.name, skill.id),
  )
}

function compactionCommit(messageID: string): StreamCommit {
  return {
    kind: "system",
    source: "system",
    messageID,
    partID: "compaction:header",
    text: "Compaction",
    phase: "start",
    compaction: true,
  }
}

function compactionSummary(messageID: string, text: string, phase: "progress" | "final"): StreamCommit {
  return {
    kind: "assistant",
    source: "assistant",
    messageID,
    partID: "compaction:summary",
    text,
    phase,
  }
}

function compactionError(messageID: string, text: string): StreamCommit {
  return {
    kind: "error",
    source: "system",
    messageID,
    partID: "compaction:error",
    text,
    phase: "start",
  }
}

async function resolveSelectedModel(
  input: StreamInput,
  sdk: OpenCodeClient,
  next: Pick<SessionTurnInput, "model" | "variant" | "signal">,
) {
  if (next.model) return { providerID: next.model.providerID, id: next.model.modelID, variant: next.variant }
  if (!next.variant) return

  const session = await sdk.session
    .get({ sessionID: input.sessionID }, { signal: next.signal })
    .then((response) => response.model)
  if (session) return { ...session, variant: next.variant }

  const fallback = await sdk.model
    .default(
      input.location
        ? {
            location: {
              directory: input.location.directory,
              workspace: input.location.workspaceID,
            },
          }
        : undefined,
      { signal: next.signal },
    )
    .then((response) => response.data)
  if (!fallback) return
  return { providerID: fallback.providerID, id: fallback.id, variant: next.variant }
}

export async function createSessionTransport(input: StreamInput): Promise<SessionTransport> {
  const controller = new AbortController()
  let sdk = input.sdk
  let generation = 0
  let activeAttempt: Attempt | undefined
  let settlementClient: OpenCodeClient | undefined
  input.signal?.addEventListener("abort", () => controller.abort(), { once: true })
  const state: State = {
    permissions: [],
    forms: [],
    globalForms: [],
    view: { type: "prompt" },
    messageIDs: new Set(),
    promotedMessages: new Set(),
    imageIDs: new Set(),
    fragments: createFragmentReconciler(),
    tools: new Map(),
    toolSources: new Map(),
    finishedTools: new Set(),
    toolMessages: new Set(),
    quietText: new Map(),
    skillMessages: new Set(),
    shellCommands: new Map(),
    shellStarted: new Set(),
    shellEnded: new Set(),
    connected: false,
    closed: false,
    initial: true,
    rootActive: false,
    executionEpoch: 0,
    errors: new Set(),
    pending: new Map(),
    admitted: new Set(),
    stepModel: undefined,
  }
  let readyResolve!: () => void
  let readyReject!: (error: unknown) => void
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve
    readyReject = reject
  })
  const abortReady = () => readyReject(new Error("Mini closed before the event stream connected"))
  controller.signal.addEventListener("abort", abortReady, { once: true })
  const offFooterClose = input.footer.onClose(() => controller.abort())
  const current = (attempt: Attempt) =>
    !state.closed &&
    !controller.signal.aborted &&
    !attempt.signal.aborted &&
    attempt.generation === generation &&
    attempt.client === sdk

  const subagents = createSubagentTracker({
    sessionID: input.sessionID,
    thinking: input.thinking,
    directory: input.location?.directory,
    signal: controller.signal,
    emit: () => {
      if (state.closed || input.footer.isClosed) return
      const snapshot = subagents.snapshot()
      writeSessionOutput(
        { footer: input.footer, trace: input.trace },
        { commits: [], updates: [{ type: "stream.subagent", state: snapshot }] },
      )
      syncBlockers()
    },
  })
  controller.signal.addEventListener("abort", () => subagents.close(), { once: true })

  // The one "go idle" transition, shared by settlement, terminal events, and the
  // interrupt ack so the flag and the paint cannot drift apart.
  const paintIdle = (status: string) => {
    state.rootActive = false
    write([], { phase: "idle", status })
  }

  const write = (commits: StreamCommit[], patch?: Pick<FooterPatch, "phase" | "status" | "usage">) => {
    if (state.closed || controller.signal.aborted || input.footer.isClosed) return
    if (!state.initial && state.buffered === undefined)
      commits.forEach((commit) => {
        if (!commit.messageID || !commit.partID || (commit.kind !== "assistant" && commit.kind !== "reasoning")) {
          input.onCommit?.(commit)
          return
        }
        const text = state.fragments.value({ messageID: commit.messageID, partID: commit.partID })
        input.onCommit?.({
          ...commit,
          text: commit.kind === "reasoning" && text ? `Thinking: ${text}` : (text ?? commit.text),
        })
      })
    writeSessionOutput(
      { footer: input.footer, trace: input.trace },
      { commits, updates: patch ? [{ type: "stream.patch", patch }] : undefined },
    )
  }

  let syncedPending: string[] | undefined
  const syncPending = () => {
    const prompts = [...state.pending.values()]
    const ids = prompts.map((item) => `${item.messageID}:${item.delivery}`)
    if (syncedPending?.length === ids.length && syncedPending.every((id, index) => id === ids[index])) return
    syncedPending = ids
    input.trace?.write("ui.patch", { pending: prompts.length })
    input.footer.event({ type: "queued.prompts", prompts })
  }

  const freshImages = (commits: ImageCommit[], render = true) =>
    commits.filter((commit) => {
      const key = streamPartKey(commit.messageID, commit.partID)
      if (state.imageIDs.has(key)) return false
      state.imageIDs.add(key)
      return render
    })

  const renderUser = (
    messageID: string,
    text: string,
    files: SessionMessageUser["files"],
    skills: FooterQueuedPrompt["skills"],
    render = true,
  ) => {
    const visible = state.messageIDs.has(messageID)
    state.messageIDs.add(messageID)
    const images = freshImages(userImageCommits(messageID, files), render)
    if (!render) return
    write([
      ...(!visible && showTools() ? skillCommits(messageID, skills) : []),
      ...(!visible && text.trim()
        ? [{ kind: "user", source: "system", text, phase: "start", messageID } as const]
        : []),
      ...images,
    ])
  }

  const mergePending = (item: SessionInboxInfo) => {
    const prompt = pendingPrompt(item)
    if (!prompt) return
    if (state.promotedMessages.has(prompt.messageID)) {
      renderUser(prompt.messageID, prompt.prompt.text, prompt.files, prompt.skills)
      return
    }
    state.admitted.add(prompt.messageID)
    state.pending.set(prompt.messageID, prompt)
    syncPending()
  }

  const promoteWait = (wait: Wait, observed: boolean, messageID = wait.messageID) => {
    const transition = messageID !== wait.failureMessageID || (observed ? !wait.promotionObserved : !wait.promoted)
    wait.promoted = true
    if (observed) wait.promotionObserved = true
    if (!transition) return
    wait.failureMessageID = messageID
    wait.failureRendered = false
    wait.terminalError = undefined
  }

  const syncBlockers = () => {
    if (state.closed || controller.signal.aborted || input.footer.isClosed) return
    const descendant = subagents.snapshot()
    const next = pickBlockerView({
      permission: state.permissions[0] ?? descendant.permissions[0],
      form: state.forms[0] ?? descendant.forms[0] ?? state.globalForms[0],
    })
    if (next.type === "prompt" && state.view.type === "prompt") return
    if (next.type !== "prompt" && state.view.type === next.type && next.request.id === state.view.request.id) return
    state.view = next
    writeSessionOutput(
      { footer: input.footer, trace: input.trace },
      {
        commits: [],
        updates: [
          {
            type: "stream.patch",
            patch:
              next.type === "prompt"
                ? { phase: state.rootActive ? "running" : "idle", status: blockerStatus(next) }
                : { status: blockerStatus(next) },
          },
          { type: "stream.view", view: next },
        ],
      },
    )
  }

  const sourcePending = (key: string) =>
    state.permissions.some(
      (request) =>
        request.source?.type === "tool" && permissionSourceKey(request.source.messageID, request.source.id) === key,
    )

  const pruneToolSources = () => {
    for (const key of state.toolSources.keys()) {
      if (!state.tools.has(key) && !sourcePending(key)) state.toolSources.delete(key)
    }
  }

  const showTools = () => input.tools !== false

  const rememberToolMessage = (messageID: string) => {
    state.toolMessages.add(messageID)
    state.quietText.delete(messageID)
  }

  const bufferQuietText = (messageID: string, partID: string, text: string, replace: boolean) => {
    if (!text || state.toolMessages.has(messageID)) return
    const parts = state.quietText.get(messageID) ?? []
    const current = parts.find((part) => part.partID === partID)
    if (current) {
      current.text = replace ? text : current.text + text
      return
    }
    parts.push({ partID, text })
    state.quietText.set(messageID, parts)
  }

  const flushQuietText = (messageID: string) => {
    const parts = state.quietText.get(messageID)
    state.quietText.delete(messageID)
    if (!parts || state.toolMessages.has(messageID)) return
    write(
      parts
        .filter((part) => part.text)
        .map((part) => ({
          kind: "assistant" as const,
          source: "assistant" as const,
          text: part.text,
          phase: "progress" as const,
          messageID,
          partID: part.partID,
        })),
    )
  }

  const renderTool = (messageID: string, item: SessionMessageAssistantTool, render = true) => {
    if (!showTools()) {
      rememberToolMessage(messageID)
      render = false
    }
    const part = normalizeTool(item)
    const key = permissionSourceKey(messageID, part.id)
    if (state.finishedTools.has(key)) {
      if (sourcePending(key)) state.toolSources.set(key, part)
      else state.toolSources.delete(key)
      return
    }
    state.toolSources.set(key, part)
    if (part.state.status === "streaming") {
      state.tools.set(key, { part, output: "", version: 0, started: false })
      return
    }
    const current = state.tools.get(key)
    const output = toolOutputText(part.name, toolDisplayContent(part.state))
    const prefix = current ? output.startsWith(current.output) : false
    const version = current && !prefix ? current.version + 1 : (current?.version ?? 0)
    const delta = current && prefix ? output.slice(current.output.length) : output
    if (part.state.status === "running") {
      const started = current?.started === true
      const ready = part.name !== "websearch" || typeof part.state.metadata.provider === "string"
      if (render && !started && ready)
        write([toolCommit(part, messageID, "start", undefined, input.location?.directory, version)], {
          phase: "running",
          status: `running ${part.name}`,
        })
      if (render && delta) write([toolCommit(part, messageID, "progress", delta, input.location?.directory, version)])
      state.tools.set(key, { part, output, version, started: started || (render && ready) })
      return
    }
    if (render && !current?.started)
      write([toolCommit(part, messageID, "start", undefined, input.location?.directory, version)])
    state.finishedTools.add(key)
    state.tools.delete(key)
    if (!sourcePending(key)) state.toolSources.delete(key)
    const images = freshImages(toolImageCommits(part, messageID), render)
    if (!render) return
    const phase = toolFinalPhase(part)
    if (part.state.status === "error" && delta)
      write([toolCommit(part, messageID, "progress", delta, input.location?.directory, version)])
    write([
      toolCommit(part, messageID, phase, phase === "progress" ? delta : undefined, input.location?.directory, version),
      ...images,
    ])
  }

  const renderMessage = (message: SessionMessageInfo, render: boolean) => {
    if (message.type === "user") {
      const waiting = state.wait?.messageID === message.id
      const admitted = state.admitted.delete(message.id)
      if (state.wait && (admitted || (waiting && state.wait.failureMessageID === message.id)))
        promoteWait(state.wait, false, message.id)
      if (state.pending.delete(message.id)) syncPending()
      state.promotedMessages.add(message.id)
      renderUser(message.id, message.text, message.files, message.skills, render)
      return
    }
    if (message.type === "skill") {
      if (state.wait?.messageID === message.id) promoteWait(state.wait, false)
      if (!render || !showTools() || state.skillMessages.has(message.id)) {
        state.skillMessages.add(message.id)
        return
      }
      state.skillMessages.add(message.id)
      write([skillCommit(message.id, message.name)])
      return
    }
    if (message.type === "shell") {
      state.shellCommands.set(message.shellID, message.command)
      if (state.shellWait?.messageID === message.id) state.shellWait.id = message.shellID
      const completed = message.time.completed !== undefined
      if (!render) {
        // Suppressed history: mark settled shells rendered so live redelivery
        // stays silent. A still-running shell stays unmarked and renders in
        // full when its live shell.ended event arrives.
        if (completed) {
          state.shellStarted.add(message.shellID)
          state.shellEnded.add(message.shellID)
        }
        return
      }
      if (!state.shellStarted.has(message.shellID)) {
        state.shellStarted.add(message.shellID)
        write([
          shellCommit(message.shellID, message.command, {
            text: "running shell",
            phase: "start",
            toolState: "running",
          }),
        ])
      }
      if (completed && message.output && !state.shellEnded.has(message.shellID)) {
        state.shellEnded.add(message.shellID)
        write(shellTerminal(message.shellID, message.command, message, message.output))
      }
      if (completed && state.shellWait?.id === message.shellID) state.shellWait.resolve()
      return
    }
    if (message.type === "compaction") {
      const visible = state.messageIDs.has(message.id)
      state.messageIDs.add(message.id)
      if (message.status === "running") state.activeCompaction = message.id
      if (message.status !== "running" && state.activeCompaction === message.id) state.activeCompaction = undefined
      if (visible) return
      if (message.status === "failed") {
        if (render && message.error.type !== "aborted")
          write([compactionCommit(message.id), compactionError(message.id, message.error.message)])
        return
      }
      const fragment = { messageID: message.id, partID: "compaction:summary" }
      const show = render || message.status === "running"
      state.fragments.project(fragment, message.summary, show)
      if (!show) return
      write([
        compactionCommit(message.id),
        ...(message.summary ? [compactionSummary(message.id, message.summary, "progress")] : []),
        ...(message.status === "completed" ? [compactionSummary(message.id, "", "final")] : []),
      ])
      return
    }
    if (message.type !== "assistant") return
    state.messageIDs.add(message.id)
    const hasTools = message.content.some((item) => item.type === "tool")
    if (hasTools) rememberToolMessage(message.id)
    let textOrdinal = 0
    let reasoningOrdinal = 0
    for (const item of message.content) {
      if (item.type === "text") {
        const fragment = fragmentRef(message.id, "text", textOrdinal++)
        const visible = render && (showTools() || !hasTools)
        const update = state.fragments.project(fragment, item.text, visible)
        if (visible && item.text.length > update.previous.length)
          write([
            {
              kind: "assistant",
              source: "assistant",
              text: item.text.slice(update.previous.length),
              phase: "progress",
              messageID: message.id,
              partID: fragment.partID,
            },
          ])
        continue
      }
      if (item.type === "reasoning") {
        const fragment = fragmentRef(message.id, "reasoning", reasoningOrdinal++)
        const update = state.fragments.project(fragment, item.text, render)
        if (render && input.thinking && item.text.length > update.previous.length)
          write([
            {
              kind: "reasoning",
              source: "reasoning",
              text: update.previous.length === 0 ? `Thinking: ${item.text}` : item.text.slice(update.previous.length),
              phase: "progress",
              messageID: message.id,
              partID: fragment.partID,
            },
          ])
        continue
      }
      renderTool(message.id, item, render)
    }
    if (message.error && !state.errors.has(message.id)) {
      state.errors.add(message.id)
      if (!render) return
      if (state.wait) state.wait.failureRendered = true
      write([
        {
          kind: "error",
          source: "system",
          text: errorMessage(message.error),
          phase: "start",
          messageID: message.id,
        },
      ])
    }
  }

  const projectedMessages = async (client: OpenCodeClient, signal: AbortSignal) =>
    (
      await client.message.list(
        { sessionID: input.sessionID, limit: input.replayLimit ?? 200, order: "desc" },
        { signal },
      )
    ).data.toReversed()

  const settleSession = async (client: OpenCodeClient) => {
    await client.session.wait({ sessionID: input.sessionID }, { signal: controller.signal })
    for (const message of await projectedMessages(client, controller.signal)) renderMessage(message, true)
    paintIdle(blockerStatus(state.view))
    await input.footer.idle()
  }

  const resolvePermissionSources = async (
    client: OpenCodeClient,
    permissions: PermissionRequest[],
    attempt: Attempt,
  ) => {
    const pending = new Set(
      permissions.flatMap((request) =>
        request.source?.type === "tool" ? [permissionSourceKey(request.source.messageID, request.source.id)] : [],
      ),
    )
    const messageIDs = [
      ...new Set(
        permissions.flatMap((request) => {
          if (request.source?.type !== "tool") return []
          const key = permissionSourceKey(request.source.messageID, request.source.id)
          return state.toolSources.has(key) ? [] : [request.source.messageID]
        }),
      ),
    ]
    const messages = await Promise.allSettled(
      messageIDs.map((messageID) =>
        client.session.message({ sessionID: input.sessionID, messageID }, { signal: attempt.signal }),
      ),
    )
    if (!current(attempt)) return permissions
    for (const result of messages) {
      if (result.status !== "fulfilled" || result.value.type !== "assistant") continue
      for (const item of result.value.content) {
        if (item.type !== "tool") continue
        const key = permissionSourceKey(result.value.id, item.id)
        if (pending.has(key)) state.toolSources.set(key, normalizeTool(item))
      }
    }
    return permissions.map((request) => permissionTool(request, state.toolSources))
  }

  const hydrate = async (attempt: Attempt, next: { render: boolean; reconnect?: boolean }) => {
    const client = attempt.client
    const options = { signal: attempt.signal }
    const [projected, pending, permissions, forms, globals, active] = await Promise.all([
      projectedMessages(client, attempt.signal),
      client.session.inbox.list({ sessionID: input.sessionID }, options),
      client.permission.list({ sessionID: input.sessionID }, options),
      client.form.list({ sessionID: input.sessionID }, options),
      input.location
        ? client.form.request.list(
            {
              location: { directory: input.location.directory, workspace: input.location.workspaceID },
            },
            options,
          )
        : Promise.resolve(undefined),
      client.session.active(options),
    ])
    if (!current(attempt)) return
    state.pending = new Map(
      pending.flatMap((item) => {
        const prompt = pendingPrompt(item)
        return prompt ? [[prompt.messageID, prompt] as const] : []
      }),
    )
    syncPending()
    state.permissions = permissions
    pruneToolSources()
    for (const message of projected) renderMessage(message, next.render)
    state.permissions = await resolvePermissionSources(client, permissions, attempt)
    if (!current(attempt)) return
    pruneToolSources()
    state.forms = forms
    state.globalForms = globals
      ? globals.data.filter((form) => form.sessionID === "global").map((form) => globalForm(form, globals.location))
      : []
    state.rootActive = input.sessionID in active
    syncBlockers()
    await subagents.hydrate({
      sdk: client,
      messages: [...projected],
      active,
      signal: attempt.signal,
      reconnect: next.reconnect,
    })
    if (!current(attempt)) return
    write([], {
      phase: state.rootActive ? "running" : "idle",
      status: state.rootActive ? "assistant responding" : blockerStatus(state.view),
    })
    if (!state.rootActive) await input.footer.idle()
    if (!current(attempt)) return
  }

  const apply = (attempt: Attempt, event: RunV2Event) => {
    if (!current(attempt)) return
    const client = attempt.client
    if (catalogEvents.has(event.type)) {
      if (
        input.location &&
        event.location &&
        (event.location.directory !== input.location.directory ||
          event.location.workspaceID !== input.location.workspaceID)
      )
        return
      void refreshCatalog(attempt)
      return
    }
    const source = sessionID(event)
    if (
      source === "global" &&
      (event.type === "form.created" || event.type === "form.replied" || event.type === "form.cancelled")
    ) {
      if (!sameLocation(event.location, input.location)) return
      if (event.type === "form.created") {
        if (!state.globalForms.some((item) => item.id === event.data.form.id))
          state.globalForms.push(globalForm(event.data.form, event.location!))
      } else {
        state.globalForms = state.globalForms.filter((item) => item.id !== event.data.id)
      }
      syncBlockers()
      return
    }
    if (source !== input.sessionID) {
      if (source) subagents.foreign(client, source, event, attempt.signal)
      return
    }
    input.trace?.write("recv.event", event)
    subagents.main(client, event, attempt.signal)
    if (event.type === "session.renamed") {
      input.onSessionTitle?.(event.data.title)
      return
    }
    if (event.type === "session.inbox.enqueued") {
      if (event.data.item.type !== "user") return
      mergePending({
        id: event.data.inboxID,
        sessionID: event.data.sessionID,
        timeCreated: event.created,
        ...event.data.item,
      })
      return
    }
    if (event.type === "session.inbox.delivered") {
      if (state.wait) promoteWait(state.wait, true, event.data.inboxID)
      state.admitted.delete(event.data.inboxID)
      state.promotedMessages.add(event.data.inboxID)
      const pending = state.pending.get(event.data.inboxID)
      state.pending.delete(event.data.inboxID)
      syncPending()
      if (pending) renderUser(pending.messageID, pending.prompt.text, pending.files, pending.skills)
      write([], { phase: "running", status: "waiting for assistant" })
      return
    }
    if (event.type === "session.inbox.delivery.changed") {
      const pending = state.pending.get(event.data.inboxID)
      if (!pending) return
      state.pending.set(event.data.inboxID, { ...pending, delivery: event.data.delivery })
      syncPending()
      return
    }
    if (event.type === "session.inbox.cancelled") {
      state.admitted.delete(event.data.inboxID)
      if (state.pending.delete(event.data.inboxID)) syncPending()
      return
    }
    if (event.type === "session.step.started") {
      state.stepModel = { providerID: event.data.model.providerID, modelID: event.data.model.id }
      write([], { phase: "running", status: "assistant responding" })
      return
    }
    if (event.type === "session.skill.activated") {
      const messageID = messageIDFromEvent(event.id)
      if (state.wait?.messageID === messageID) promoteWait(state.wait, true)
      if (state.skillMessages.has(messageID)) return
      state.skillMessages.add(messageID)
      if (showTools()) write([skillCommit(messageID, event.data.name)])
      return
    }
    if (event.type === "session.compaction.started") {
      const messageID = event.data.inputID ?? messageIDFromEvent(event.id)
      state.activeCompaction = messageID
      if (state.messageIDs.has(messageID)) return
      state.messageIDs.add(messageID)
      write([compactionCommit(messageID)], { phase: "running", status: "compacting session" })
      return
    }
    if (event.type === "session.compaction.delta") {
      if (!state.activeCompaction) return
      const fragment = { messageID: state.activeCompaction, partID: "compaction:summary" }
      if (!state.fragments.delta(fragment, event.data.text)) return
      write([compactionSummary(state.activeCompaction, event.data.text, "progress")])
      return
    }
    if (event.type === "session.compaction.ended") {
      if (!state.activeCompaction) return
      const messageID = state.activeCompaction
      state.activeCompaction = undefined
      const update = state.fragments.end({ messageID, partID: "compaction:summary" }, event.data.text)
      write([
        ...(event.data.text.length > update.previous.length
          ? [compactionSummary(messageID, event.data.text.slice(update.previous.length), "progress")]
          : []),
        compactionSummary(messageID, "", "final"),
      ])
      return
    }
    if (event.type === "session.compaction.failed") {
      if (!state.activeCompaction) return
      const messageID = state.activeCompaction
      state.activeCompaction = undefined
      if (event.data.error.type === "aborted") {
        write([compactionSummary(messageID, "", "final")])
        return
      }
      write([compactionSummary(messageID, "", "final"), compactionError(messageID, event.data.error.message)])
      return
    }
    if (event.type === "session.shell.started") {
      state.shellCommands.set(event.data.shell.id, event.data.shell.command)
      const wait = state.shellWait
      if (wait?.eventID === event.id) wait.id = event.data.shell.id
      if (state.shellStarted.has(event.data.shell.id)) return
      state.shellStarted.add(event.data.shell.id)
      write(
        [
          shellCommit(event.data.shell.id, event.data.shell.command, {
            text: "running shell",
            phase: "start",
            toolState: "running",
          }),
        ],
        {
          phase: "running",
          status: "running shell",
        },
      )
      return
    }
    if (event.type === "session.shell.ended") {
      const command = state.shellCommands.get(event.data.shell.id) ?? event.data.shell.command
      const commits: StreamCommit[] = []
      if (!state.shellStarted.has(event.data.shell.id)) {
        state.shellStarted.add(event.data.shell.id)
        if (command)
          commits.push(
            shellCommit(event.data.shell.id, command, { text: "running shell", phase: "start", toolState: "running" }),
          )
      }
      if (!state.shellEnded.has(event.data.shell.id)) {
        state.shellEnded.add(event.data.shell.id)
        commits.push(...shellTerminal(event.data.shell.id, command, event.data.shell, event.data.output))
      }
      const wait = state.shellWait
      const owned = wait?.id === event.data.shell.id
      write(commits, owned || state.wait || state.shellWait ? undefined : { phase: "idle", status: "" })
      if (owned) wait.resolve()
      return
    }
    if (event.type === "session.text.started") {
      return
    }
    if (event.type === "session.text.delta") {
      const fragment = fragmentRef(event.data.assistantMessageID, "text", event.data.ordinal)
      if (!state.fragments.delta(fragment, event.data.delta)) return
      if (!showTools()) {
        bufferQuietText(event.data.assistantMessageID, fragment.partID, event.data.delta, false)
        return
      }
      write([
        {
          kind: "assistant",
          source: "assistant",
          text: event.data.delta,
          phase: "progress",
          messageID: event.data.assistantMessageID,
          partID: fragment.partID,
        },
      ])
      return
    }
    if (event.type === "session.text.ended") {
      const update = state.fragments.end(
        fragmentRef(event.data.assistantMessageID, "text", event.data.ordinal),
        event.data.text,
      )
      if (!showTools()) {
        bufferQuietText(event.data.assistantMessageID, update.partID, event.data.text, true)
        return
      }
      if (event.data.text.length > update.previous.length)
        write([
          {
            kind: "assistant",
            source: "assistant",
            text: event.data.text.slice(update.previous.length),
            phase: "progress",
            messageID: event.data.assistantMessageID,
            partID: update.partID,
          },
        ])
      return
    }
    if (event.type === "session.reasoning.started") {
      return
    }
    if (event.type === "session.reasoning.delta") {
      const update = state.fragments.delta(
        fragmentRef(event.data.assistantMessageID, "reasoning", event.data.ordinal),
        event.data.delta,
      )
      if (!update) return
      if (input.thinking)
        write([
          {
            kind: "reasoning",
            source: "reasoning",
            text: update.previous ? event.data.delta : `Thinking: ${event.data.delta}`,
            phase: "progress",
            messageID: event.data.assistantMessageID,
            partID: update.partID,
          },
        ])
      return
    }
    if (event.type === "session.reasoning.ended") {
      const update = state.fragments.end(
        fragmentRef(event.data.assistantMessageID, "reasoning", event.data.ordinal),
        event.data.text,
      )
      if (input.thinking && event.data.text.length > update.previous.length)
        write([
          {
            kind: "reasoning",
            source: "reasoning",
            text: update.previous ? event.data.text.slice(update.previous.length) : `Thinking: ${event.data.text}`,
            phase: "progress",
            messageID: event.data.assistantMessageID,
            partID: update.partID,
          },
        ])
      return
    }
    if (event.type === "session.tool.input.started") {
      renderTool(event.data.assistantMessageID, {
        type: "tool",
        id: event.data.id,
        name: event.data.name,
        state: { status: "streaming", input: "" },
        time: { created: event.created },
      })
      return
    }
    if (event.type === "session.tool.input.delta" || event.type === "session.tool.input.ended") {
      const current = state.tools.get(streamPartKey(event.data.assistantMessageID, event.data.id))
      if (!current || current.part.state.status !== "streaming") return
      renderTool(event.data.assistantMessageID, {
        ...current.part,
        state: {
          status: "streaming",
          input:
            event.type === "session.tool.input.ended" ? event.data.text : current.part.state.input + event.data.delta,
        },
      })
      return
    }
    if (event.type === "session.tool.called") {
      const key = streamPartKey(event.data.assistantMessageID, event.data.id)
      if (state.finishedTools.has(key)) return
      const current = state.tools.get(key)
      const item: SessionMessageAssistantTool = {
        type: "tool",
        id: event.data.id,
        name: current?.part.name ?? "tool",
        executed: event.data.executed,
        providerState: event.data.state,
        state: { status: "running", input: event.data.input, metadata: {} },
        time: { created: current?.part.time.created ?? event.created, ran: event.created },
      }
      renderTool(event.data.assistantMessageID, item)
      return
    }
    if (event.type === "session.tool.progress") {
      const key = streamPartKey(event.data.assistantMessageID, event.data.id)
      if (state.finishedTools.has(key)) return
      const current = state.tools.get(key)
      const part = current?.part
      renderTool(event.data.assistantMessageID, {
        type: "tool",
        id: event.data.id,
        name: part?.name ?? "tool",
        executed: part?.executed,
        providerState: part?.providerState,
        state: {
          status: "running",
          input: part && part.state.status !== "streaming" ? part.state.input : {},
          metadata: event.data.metadata,
        },
        time: { created: part?.time.created ?? event.created, ran: part?.time.ran ?? event.created },
      })
      return
    }
    if (event.type === "session.tool.success" || event.type === "session.tool.failed") {
      const current = state.tools.get(streamPartKey(event.data.assistantMessageID, event.data.id))
      const part = current?.part
      const failed = event.type === "session.tool.failed"
      const item: SessionMessageAssistantTool = {
        type: "tool",
        id: event.data.id,
        name: part?.name ?? "tool",
        executed: event.data.executed,
        providerState: part?.providerState,
        providerResultState: event.data.resultState,
        state: failed
          ? {
              status: "error",
              input: part && part.state.status !== "streaming" ? part.state.input : {},
              metadata: event.data.metadata,
              content: event.data.content,
              error: event.data.error,
            }
          : {
              status: "completed",
              input: part && part.state.status !== "streaming" ? part.state.input : {},
              metadata: event.data.metadata,
              content: event.data.content,
            },
        time: { created: part?.time.created ?? event.created, ran: part?.time.ran, completed: event.created },
      }
      renderTool(event.data.assistantMessageID, item)
      return
    }
    if (event.type === "permission.asked") {
      if (!state.permissions.some((item) => item.id === event.data.id))
        state.permissions.push(permissionTool(event.data, state.toolSources))
      syncBlockers()
      return
    }
    if (event.type === "permission.replied") {
      state.permissions = state.permissions.filter((item) => item.id !== event.data.requestID)
      pruneToolSources()
      syncBlockers()
      return
    }
    if (event.type === "form.created") {
      if (!state.forms.some((item) => item.id === event.data.form.id)) state.forms.push(event.data.form)
      syncBlockers()
      return
    }
    if (event.type === "form.replied" || event.type === "form.cancelled") {
      state.forms = state.forms.filter((item) => item.id !== event.data.id)
      syncBlockers()
      return
    }
    if (event.type === "session.step.ended") {
      const total =
        event.data.tokens.input +
        event.data.tokens.output +
        event.data.tokens.reasoning +
        event.data.tokens.cache.read +
        event.data.tokens.cache.write
      const limit = state.stepModel ? input.contextLimit?.(state.stepModel) : undefined
      state.stepModel = undefined
      if (!showTools()) flushQuietText(event.data.assistantMessageID)
      write([], {
        usage:
          total > 0 || event.data.cost
            ? {
                tokens: total,
                percent: limit ? Math.round((total / limit) * 100) : undefined,
                cost: event.data.cost || undefined,
              }
            : undefined,
      })
      return
    }
    if (event.type === "session.step.failed") {
      state.stepModel = undefined
      if (!showTools()) flushQuietText(event.data.assistantMessageID)
      const rendered = state.errors.has(event.data.assistantMessageID)
      state.errors.add(event.data.assistantMessageID)
      if (state.wait) state.wait.failureRendered = true
      if (rendered) return
      write([
        {
          kind: "error",
          source: "system",
          text: errorMessage(event.data.error),
          phase: "start",
          messageID: event.data.assistantMessageID,
        },
      ])
      return
    }
    if (event.type === "session.execution.started") {
      state.executionEpoch++
      state.rootActive = true
      write([], { phase: "running" })
      return
    }
    if (
      event.type === "session.execution.succeeded" ||
      event.type === "session.execution.failed" ||
      event.type === "session.execution.interrupted"
    ) {
      state.executionEpoch++
      if (!showTools()) for (const messageID of [...state.quietText.keys()]) flushQuietText(messageID)
      paintIdle("")
      const current = state.wait
      if (!current) return
      if (current.interrupted && event.type === "session.execution.interrupted" && event.data.reason === "user") {
        return
      }
      if (event.type === "session.execution.failed") {
        if (!current.failureRendered) current.terminalError = new Error(errorMessage(event.data.error))
        return
      }
      if (event.type === "session.execution.interrupted") {
        current.terminalError = new Error(`Session interrupted: ${event.data.reason}`)
      }
    }
  }

  const receive = (attempt: Attempt, event: RunV2Event) => {
    if (!current(attempt)) return
    if (state.buffered?.attempt === attempt) {
      state.buffered.events.push(event)
      return
    }
    apply(attempt, event)
  }

  const hydration = new Map<number, Promise<void>>()
  const serializeHydration = <A>(attempt: Attempt, run: () => Promise<A>) => {
    const previous = hydration.get(attempt.generation) ?? Promise.resolve()
    const task = previous.then(run, run)
    const tail = task.then(
      () => {},
      () => {},
    )
    hydration.set(attempt.generation, tail)
    void tail.then(() => {
      if (hydration.get(attempt.generation) === tail) hydration.delete(attempt.generation)
    })
    return task
  }
  const settleHydration = async () => {
    while (hydration.size > 0) await Promise.all(hydration.values())
  }

  const catalogRefreshes = new Map<number, Set<Promise<void>>>()
  const refreshCatalog = (attempt: Attempt) => {
    if (!current(attempt)) return Promise.resolve()
    const task = Promise.resolve(input.onCatalogRefresh?.(attempt.signal))
      .then(() => {})
      .catch(() => {})
    const refreshes = catalogRefreshes.get(attempt.generation) ?? new Set()
    refreshes.add(task)
    catalogRefreshes.set(attempt.generation, refreshes)
    void task.finally(() => {
      refreshes.delete(task)
      if (refreshes.size === 0 && catalogRefreshes.get(attempt.generation) === refreshes)
        catalogRefreshes.delete(attempt.generation)
    })
    return task
  }
  const settleCatalog = async (attempt: Attempt) => {
    while (current(attempt)) {
      const refreshes = catalogRefreshes.get(attempt.generation)
      if (!refreshes || refreshes.size === 0) return
      await Promise.all(refreshes)
    }
  }
  const settleCatalogRefreshes = async () => {
    while (catalogRefreshes.size > 0)
      await Promise.all([...catalogRefreshes.values()].flatMap((refreshes) => [...refreshes]))
  }

  const connect = async () => {
    while (!controller.signal.aborted && !input.footer.isClosed) {
      const client = sdk
      const error = await (async () => {
        const connection = new AbortController()
        const abortConnection = () => connection.abort()
        controller.signal.addEventListener("abort", abortConnection, { once: true })
        const attempt = { client, signal: connection.signal, generation: ++generation }
        const stream = client.event.subscribe({ signal: connection.signal })[Symbol.asyncIterator]()
        activeAttempt = attempt
        try {
          const first = await nextEvent(stream, connection.signal)
          if (first.done || first.value.type !== "server.connected") throw new Error("Event stream disconnected")
          const buffered: RunV2Event[] = []
          let booting = true
          const consume = (async () => {
            while (true) {
              const next = await nextEvent(stream, connection.signal)
              if (next.done) throw new Error("Event stream disconnected")
              if (booting) buffered.push(next.value)
              else receive(attempt, next.value)
            }
          })()
          await Promise.race([
            serializeHydration(attempt, () =>
              hydrate(attempt, {
                render: state.initial ? input.replay === true : true,
                reconnect: !state.initial,
              }),
            ),
            consume,
          ])
          await Promise.race([refreshCatalog(attempt), consume])
          if (!current(attempt)) throw new Error("Event stream disconnected")
          state.initial = false
          do {
            for (const event of buffered.splice(0)) apply(attempt, event)
            await Promise.race([subagents.ready(), consume])
            await Promise.race([settleCatalog(attempt), consume])
          } while (buffered.length > 0)
          if (!current(attempt)) throw new Error("Event stream disconnected")
          booting = false
          state.connected = true
          readyResolve()
          await consume
        } finally {
          connection.abort()
          if (activeAttempt === attempt) activeAttempt = undefined
          if (state.buffered?.attempt === attempt) state.buffered = undefined
          if (generation === attempt.generation) generation++
          controller.signal.removeEventListener("abort", abortConnection)
          void stream.return?.(undefined).catch(() => {})
        }
      })().catch((error) => error)
      state.connected = false
      if (controller.signal.aborted || input.footer.isClosed) return
      input.trace?.write("recv.reconnect", { error: formatUnknownError(error) })
      write([], { phase: "running", status: "reconnecting" })
      if (input.reconnect) {
        try {
          const next = await input.reconnect(controller.signal)
          if (controller.signal.aborted || input.footer.isClosed) return
          sdk = next
          input.onClient?.(next)
        } catch (resolveError) {
          if (controller.signal.aborted || input.footer.isClosed) return
          input.trace?.write("recv.reresolve", { error: formatUnknownError(resolveError) })
        }
      }
      await wait(250, controller.signal)
    }
  }
  const connection = connect()
  try {
    await ready
  } catch (error) {
    offFooterClose()
    controller.abort()
    await connection.catch(() => {})
    await settleHydration()
    await settleCatalogRefreshes()
    await subagents.ready()
    throw error
  } finally {
    controller.signal.removeEventListener("abort", abortReady)
  }

  const runShellTurn = async (next: SessionTurnInput) => {
    if (state.wait || state.shellWait) throw new Error("prompt already running")
    if (!state.connected) throw new Error("Event stream is reconnecting")
    const client = sdk
    const abort = new AbortController()
    const onAbort = () => abort.abort()
    next.signal?.addEventListener("abort", onAbort, { once: true })
    let rendered!: () => void
    const output = new Promise<void>((resolve) => {
      rendered = resolve
    })
    const eventID = Event.ID.create()
    const active: ShellWait = {
      eventID,
      messageID: messageIDFromEvent(eventID),
      resolve: rendered,
      abort: () => abort.abort(),
    }
    state.shellWait = active
    input.trace?.write("send.shell", { sessionID: input.sessionID, id: eventID, command: next.prompt.text })
    write([], { phase: "running", status: "running shell" })
    try {
      await client.session.shell(
        { sessionID: input.sessionID, id: eventID, command: next.prompt.text },
        { signal: abort.signal },
      )
      await Promise.race([output, wait(SHELL_OUTPUT_GRACE_MS, abort.signal)])
    } catch (error) {
      if (abort.signal.aborted) return
      throw error
    } finally {
      next.signal?.removeEventListener("abort", onAbort)
      if (state.shellWait === active) state.shellWait = undefined
    }
  }

  // Prompt-shaped turns complete through the process-local idle fence. Live
  // lifecycle events remain presentation and best-effort outcome metadata.
  const runTurnWait = async (
    next: SessionTurnInput,
    messageID: string,
    client: OpenCodeClient,
    send: () => Promise<SessionInboxInfo | void>,
    onAdmitted?: () => void,
  ) => {
    const active: Wait = {
      messageID,
      failureMessageID: messageID,
      promoted: false,
      promotionObserved: false,
      interrupted: false,
      failureRendered: false,
    }
    state.wait = active
    const interrupt = () => {
      active.interrupted = true
      void sdk.session.interrupt({ sessionID: input.sessionID, continue: true }).catch(() => {})
    }
    next.signal?.addEventListener("abort", interrupt, { once: true })
    try {
      const admitted = await send()
      if (admitted) mergePending(admitted)
      onAdmitted?.()
      await settleSession(client)
      if (active.terminalError && !active.failureRendered)
        write([
          {
            kind: "error",
            source: "system",
            text: active.terminalError.message,
            phase: "start",
            messageID: active.failureMessageID,
          },
        ])
    } catch (error) {
      if (next.signal?.aborted) return
      throw error
    } finally {
      next.signal?.removeEventListener("abort", interrupt)
      if (state.wait === active) state.wait = undefined
    }
  }

  const performResizeReplay = async (attempt: Attempt, next: SessionResizeReplayInput) => {
    if (!input.replay || !state.connected || !current(attempt) || state.closed || input.footer.isClosed) return false
    const localRows = next.localRows()
    const buffered: RunV2Event[] = []
    const replayBuffer = { attempt, events: buffered }
    let failure: unknown
    let reset = false
    state.buffered = replayBuffer
    try {
      await input.footer.idle()
      if (!current(attempt)) return false
      await next.reset()
      if (!current(attempt)) return false
      reset = true
      state.messageIDs.clear()
      state.imageIDs.clear()
      state.fragments.clear()
      state.tools.clear()
      state.toolSources.clear()
      state.finishedTools.clear()
      state.toolMessages.clear()
      state.quietText.clear()
      state.skillMessages.clear()
      state.shellCommands.clear()
      state.shellStarted.clear()
      state.activeCompaction = undefined
      state.shellEnded.clear()
      state.errors.clear()
      await hydrate(attempt, { render: true })
    } catch (error) {
      failure = error
    } finally {
      if (state.buffered === replayBuffer) state.buffered = undefined
    }
    if (!current(attempt)) return false
    try {
      if (reset) {
        for (const row of localRows) {
          if (row.commit.image && row.commit.messageID && row.commit.partID) {
            const key = streamPartKey(row.commit.messageID, row.commit.partID)
            if (state.imageIDs.has(key)) continue
            state.imageIDs.add(key)
            input.footer.append(row.commit)
            continue
          }
          if (
            row.commit.messageID &&
            row.commit.partID &&
            (row.commit.kind === "assistant" || row.commit.kind === "reasoning")
          ) {
            const prefix = row.commit.kind === "reasoning" ? "Thinking: " : ""
            const text = row.commit.text.startsWith(prefix) ? row.commit.text.slice(prefix.length) : row.commit.text
            const restored = state.fragments.restore(
              { messageID: row.commit.messageID, partID: row.commit.partID },
              text,
            )
            if (restored.type === "covered") continue
            if (restored.type === "append") {
              if (restored.suffix)
                input.footer.append(restored.suffix === text ? row.commit : { ...row.commit, text: restored.suffix })
              continue
            }
          }
          if (row.commit.kind === "error" && row.commit.messageID) {
            if (state.errors.has(row.commit.messageID)) continue
            state.errors.add(row.commit.messageID)
            input.footer.append(row.commit)
            continue
          }
          if (row.commit.messageID && state.messageIDs.has(row.commit.messageID)) continue
          input.footer.append(row.commit)
        }
      }
    } finally {
      for (const event of buffered) apply(attempt, event)
    }
    if (reset) await input.footer.idle()
    if (failure) throw failure
    return true
  }

  let resizeReplay: Promise<boolean> | undefined
  let queuedResizeReplay: SessionResizeReplayInput | undefined
  let closing: Promise<void> | undefined

  const admitPrompt = async (next: SessionTurnInput, client: OpenCodeClient, delivery: RunDelivery) => {
    const messageID = next.prompt.messageID
    if (!messageID) throw new Error("Prompt message ID is required")
    const command = next.prompt.command
    const attachments = await prepareAttachments(next, command ? "command" : "prompt", input.readTextFile)
    const agents = promptAgents(next)
    const skills = promptSkills(next)
    if (!command) {
      input.trace?.write("send.prompt", { sessionID: input.sessionID, messageID, delivery })
      return client.session.prompt(
        {
          sessionID: input.sessionID,
          id: messageID,
          text: [next.prompt.text, ...attachments.text].join("\n\n"),
          files: attachments.files.length ? attachments.files : undefined,
          agents: agents.length ? agents : undefined,
          skills: skills.length ? skills : undefined,
          delivery,
        },
        { signal: next.signal },
      )
    }

    input.trace?.write("send.command", { sessionID: input.sessionID, messageID, command: command.name, delivery })
    return client.session.command(
      {
        sessionID: input.sessionID,
        command: command.name,
        text: command.arguments,
        files: attachments.files.length ? attachments.files : undefined,
        agents: agents.length ? agents : undefined,
        skills: skills.length ? skills : undefined,
        delivery,
      },
      { signal: next.signal },
    )
  }

  const replayOnResize = (next: SessionResizeReplayInput) => {
    queuedResizeReplay = next
    if (resizeReplay) return resizeReplay
    resizeReplay = (async () => {
      let replayed = false
      let failure: unknown
      while (queuedResizeReplay) {
        const next = queuedResizeReplay
        queuedResizeReplay = undefined
        const attempt = activeAttempt
        if (!attempt || !current(attempt)) continue
        try {
          replayed = (await serializeHydration(attempt, () => performResizeReplay(attempt, next))) || replayed
        } catch (error) {
          failure ??= error
        }
      }
      if (failure) throw failure
      return replayed
    })().finally(() => {
      resizeReplay = undefined
    })
    return resizeReplay
  }

  return {
    async admitPromptTurn(next, delivery) {
      if (next.prompt.mode === "shell" || next.prompt.command?.source === "skill")
        throw new Error("This prompt cannot be queued")
      if (!state.connected) throw new Error("Event stream is reconnecting")
      const client = sdk
      if (!next.prompt.command && next.agent)
        await client.session.switchAgent({ sessionID: input.sessionID, agent: next.agent }, { signal: next.signal })
      if (!next.prompt.command) {
        const selected = await resolveSelectedModel(input, client, next)
        if (next.variant && !selected) throw new Error("Cannot select a variant before selecting a model")
        if (selected)
          await client.session.switchModel({ sessionID: input.sessionID, model: selected }, { signal: next.signal })
      }
      const admitted = await admitPrompt(next, client, delivery)
      if (admitted) mergePending(admitted)
      settlementClient = client
    },
    async waitForIdle() {
      const client = settlementClient ?? sdk
      await settleSession(client)
      if (settlementClient === client) settlementClient = undefined
    },
    async runPromptTurn(next, admitted) {
      if (next.prompt.mode === "shell") {
        await runShellTurn(next)
        return
      }
      if (state.wait || state.shellWait) throw new Error("prompt already running")
      if (!state.connected) throw new Error("Event stream is reconnecting")
      const client = sdk
      const messageID = next.prompt.messageID
      if (!messageID) throw new Error("Prompt message ID is required")

      const command = next.prompt.command
      if (command?.source === "skill") {
        if (next.agent)
          await client.session.switchAgent({ sessionID: input.sessionID, agent: next.agent }, { signal: next.signal })
        input.trace?.write("send.skill", { sessionID: input.sessionID, messageID, skill: command.name })
        await runTurnWait(
          next,
          messageID,
          client,
          () =>
            client.session.skill(
              { sessionID: input.sessionID, id: messageID, skill: command.name },
              { signal: next.signal },
            ),
          admitted,
        )
        return
      }
      if (command) {
        await admitPrompt(next, client, next.prompt.delivery ?? "steer")
        admitted?.()
        return
      }

      if (next.agent) {
        await client.session.switchAgent({ sessionID: input.sessionID, agent: next.agent }, { signal: next.signal })
      }
      const selected = await resolveSelectedModel(input, client, next)
      if (next.variant && !selected) throw new Error("Cannot select a variant before selecting a model")
      if (selected)
        await client.session.switchModel({ sessionID: input.sessionID, model: selected }, { signal: next.signal })

      await runTurnWait(
        next,
        messageID,
        client,
        () => admitPrompt(next, client, next.prompt.delivery ?? "steer"),
        admitted,
      )
    },
    async interruptActiveTurn() {
      // A running shell holds no drain, so session.interrupt cannot reach it;
      // abort the blocking request instead. The server-side command keeps its
      // own lifecycle and simply loses its waiter.
      const shell = state.shellWait
      if (shell) {
        shell.abort()
        return
      }
      if (state.wait) state.wait.interrupted = true
      // Paint idle at the ack, not at settlement: the server accepts interruption immediately
      // while cleanup finishes asynchronously, and the terminal execution event re-confirms.
      // A failed request paints nothing, so the two-press gesture stays available for retry,
      // and a lifecycle event racing the ack wins via the epoch guard.
      const epoch = state.executionEpoch
      await sdk.session.interrupt({ sessionID: input.sessionID, continue: true }).then(
        () => {
          if (state.executionEpoch === epoch) paintIdle(blockerStatus(state.view))
        },
        () => {},
      )
    },
    selectSubagent(sessionID) {
      subagents.select(sdk, sessionID)
    },
    settleForm(sessionID, formID) {
      if (sessionID === input.sessionID) state.forms = state.forms.filter((item) => item.id !== formID)
      else if (sessionID === "global") state.globalForms = state.globalForms.filter((item) => item.id !== formID)
      else subagents.settleForm(sessionID, formID)
      syncBlockers()
    },
    replayOnResize,
    close() {
      if (!closing) {
        state.closed = true
        generation++
        offFooterClose()
        controller.abort()
        closing = (async () => {
          await connection.catch(() => {})
          await settleHydration()
          await resizeReplay?.catch(() => {})
          await settleCatalogRefreshes()
          await subagents.ready()
        })()
      }
      return closing
    },
  }
}
