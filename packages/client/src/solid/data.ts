// Client data layer: apply server events and cache API reads into a Solid store.
// Prefer straightforward projection. Invalidated reads revalidate serially so an older
// response cannot commit after its replacement. Reconnect invalidates cached reads;
// active UI owners decide what to sync again.

import type {
  AgentInfo,
  CommandInfo,
  ConfigEntry,
  FormCancelInput,
  FormInfo,
  FormReplyInput,
  IntegrationInfo,
  LocationRef,
  LocationGetOutput,
  McpResource,
  McpServer,
  ModelInfo,
  ModelRef,
  PermissionSavedInfo,
  PermissionRequest,
  PermissionReplyInput,
  Project,
  ProviderInfo,
  ReferenceInfo,
  SessionMessageInfo,
  SessionMessageUser,
  SessionMessageAssistant,
  SessionMessageAssistantReasoning,
  SessionMessageAssistantText,
  SessionMessageAssistantTool,
  SessionInfo,
  SessionInboxInfo,
  SessionInboxCompaction,
  ShellInfo,
  SkillInfo,
  VcsInfo,
  OpenCodeEvent,
  OpenCodeClient,
  WebSearchProvider,
} from "../promise"
import { Worktree } from "@opencode/schema/worktree"
import { SessionID } from "@opencode/schema/session-id"
import { SessionMessage } from "@opencode/schema/session-message"
import {
  isFormAlreadySettledError,
  isFormNotFoundError,
  isPermissionNotFoundError,
  type SessionPromptInput,
} from "../promise"
import { createStore, produce, reconcile } from "solid-js/store"
import type { SessionInbox } from "@opencode/schema/session-inbox"
import { batch, createEffect, createMemo, createSignal, onCleanup } from "solid-js"

export type DataSessionStatus = "idle" | "running"
type OpenCodeEventMap = { [Type in OpenCodeEvent["type"]]: Extract<OpenCodeEvent, { type: Type }> }

export type CreateDataInput = {
  readonly api: () => OpenCodeClient
  readonly directory: string
  /** Raw-message window used for an initial transcript read. Older pages retain their normal size. */
  readonly initialMessageLimit?: () => number
  readonly event: {
    readonly on: <Type extends OpenCodeEvent["type"]>(
      type: Type,
      handler: (event: OpenCodeEventMap[Type]) => void,
    ) => () => void
    readonly listen: (handler: (event: { name: OpenCodeEvent["type"]; details: OpenCodeEvent }) => void) => () => void
  }
  readonly connection?: {
    readonly status: () => "connected" | "connecting" | "reconnecting"
  }
  /** Receives failed event-driven reads. Explicit reads still reject to their caller. */
  readonly onError?: (error: unknown) => void
}

const messageIDFromEvent = (eventID: string) => eventID.replace(/^evt_/, "msg_")
const messagePageLimit = 20
// Trailing window for event bursts that each ask for the same refetch.
export const settleMs = 150

// Global MCP elicitations temporarily use "global" instead of a real session ID, so the
// server cannot recover their Location when settling them. Preserve the event Location
// until MCP elicitations carry session ownership.
export type FormWithLocation = FormInfo & { readonly location?: LocationRef }
type ShellWithLocation = ShellInfo & { readonly location: LocationRef }

type LocationData = {
  info?: LocationGetOutput
  vcs?: VcsInfo
  agent?: AgentInfo[]
  command?: CommandInfo[]
  config?: ConfigEntry[]
  integration?: IntegrationInfo[]
  mcpServer?: McpServer[]
  mcpResource?: McpResource[]
  model?: ModelInfo[]
  provider?: ProviderInfo[]
  reference?: ReferenceInfo[]
  websearch?: WebSearchProvider[]
  // Currently running shell commands for this location, keyed by shell id. Entries are removed
  // once the command exits or is deleted, so this only ever holds in-flight shells.
  shell?: Record<string, ShellWithLocation>
  skill?: SkillInfo[]
}

type Store = {
  session: {
    info: Record<string, SessionInfo>
    // Family index keyed by a family's root (or furthest-known-ancestor when the
    // true root is not yet loaded). The value is a flat deduplicated list of every
    // session ID in that family, including the key itself once its info arrives.
    family: Record<string, string[]>
    active: Record<string, DataSessionStatus>
    message: Record<string, SessionMessageInfo[]>
    messageCursor: Record<string, string | undefined>
    messageLoading: Record<string, boolean>
    pending: Record<string, SessionInboxInfo[]>
    permission: Record<string, PermissionRequest[]>
    // Pending forms keyed by owner: a session ID or the temporary "global" elicitation sentinel.
    form: Record<string, FormWithLocation[]>
  }
  project: {
    info: Record<string, Project>
    permission: Record<string, PermissionSavedInfo[]>
  }
  location: Record<string, LocationData>
}

export function locationKey(location: LocationRef) {
  return JSON.stringify([location.directory, location.workspaceID])
}

function locationQuery(ref: LocationRef) {
  return { directory: ref.directory, workspace: ref.workspaceID }
}

function formRequestOptions(sessionID: string, ref?: LocationRef) {
  if (sessionID !== "global" || !ref) return undefined
  return {
    headers: {
      "x-opencode-directory": encodeURIComponent(ref.directory),
      ...(ref.workspaceID ? { "x-opencode-workspace": ref.workspaceID } : {}),
    },
  }
}

function createSync() {
  // `started` is false while a reload waits for the load it replaces. Invalidations that land in
  // that window are already covered, since the reload has not read anything yet.
  type Pending = { promise: Promise<void>; invalidated: boolean; started: boolean }
  const state = new Map<string, true | Pending>()
  const start = (key: string, load: () => Promise<void>, wait?: Promise<void>) => {
    const entry: Pending = { promise: Promise.resolve(), invalidated: false, started: !wait }
    state.set(key, entry)
    const run = () => {
      entry.started = true
      return load()
    }
    entry.promise = (wait ? wait.catch(() => undefined).then(run) : run())
      .then(() => {
        if (state.get(key) === entry && !entry.invalidated) state.set(key, true)
      })
      .finally(() => {
        if (state.get(key) === entry) state.delete(key)
      })
    return entry.promise
  }
  return {
    run(key: string, load: () => Promise<void>) {
      const active = state.get(key)
      if (active === true) return Promise.resolve()
      if (!active) return start(key, load)
      if (!active.invalidated) return active.promise
      return start(key, load, active.promise)
    },
    complete(key: string) {
      if (state.has(key)) return
      state.set(key, true)
    },
    has(key: string) {
      return state.has(key)
    },
    pending(key: string) {
      const active = state.get(key)
      return active !== undefined && active !== true
    },
    invalidate(key?: string) {
      if (key) {
        const active = state.get(key)
        if (active === true) state.delete(key)
        if (active !== undefined && active !== true && active.started) active.invalidated = true
        return
      }
      state.forEach((active, current) => {
        if (active === true) state.delete(current)
        if (active !== true && active.started) active.invalidated = true
      })
    },
  }
}

export function createData(config: CreateDataInput) {
  const api = config.api
  let disposed = false
  onCleanup(() => (disposed = true))

  function refresh(load: () => Promise<unknown>) {
    if (disposed || (config.connection && config.connection.status() !== "connected")) return
    void load().catch((error) => {
      if (disposed || (config.connection && config.connection.status() !== "connected")) return
      if (config.onError) return config.onError(error)
      console.error("Failed to refresh client data", error)
    })
  }

  // Runs `load` once a burst of same-key events goes quiet, so N events cost one refetch.
  const settling = new Map<string, ReturnType<typeof setTimeout>>()
  onCleanup(() => settling.forEach((timer) => clearTimeout(timer)))
  function settle(key: string, load: () => Promise<unknown>) {
    clearTimeout(settling.get(key))
    settling.set(
      key,
      setTimeout(() => {
        settling.delete(key)
        refresh(load)
      }, settleMs),
    )
  }

  const [store, setStore] = createStore<Store>({
    session: {
      info: {},
      family: {},
      active: {},
      message: {},
      messageCursor: {},
      messageLoading: {},
      pending: {},
      permission: {},
      form: {},
    },
    project: {
      info: {},
      permission: {},
    },
    location: {},
  })

  const [defaultLocation, setDefaultLocation] = createSignal<LocationRef>({ directory: config.directory })
  const sessions = createMemo(() =>
    Object.values(store.session.info).toSorted((a, b) => b.time.updated - a.time.updated),
  )
  const messageIndex = new Map<string, Map<string, number>>()
  const sync = createSync()
  let activeUpdates: Map<string, DataSessionStatus | undefined> | undefined

  function setSessionActive(sessionID: string, status: DataSessionStatus) {
    activeUpdates?.set(sessionID, status)
    setStore("session", "active", sessionID, status)
  }

  function removePending(sessionID: string, inboxID?: string) {
    if (!inboxID) return
    if (store.session.pending[sessionID]?.some((item) => item.id === inboxID))
      setStore(
        "session",
        "pending",
        sessionID,
        (store.session.pending[sessionID] ?? []).filter((item) => item.id !== inboxID),
      )
  }

  function removePermission(sessionID: string, requestID: string) {
    const requests = store.session.permission[sessionID]
    if (!requests?.some((request) => request.id === requestID)) return
    setStore(
      "session",
      "permission",
      sessionID,
      requests.filter((request) => request.id !== requestID),
    )
  }

  function removeForm(sessionID: string, formID: string, ref?: LocationRef) {
    const forms = store.session.form[sessionID]
    if (!forms) return false
    const location = ref && locationKey(ref)
    const next = forms.filter((form) => {
      if (form.id !== formID) return true
      if (sessionID !== "global" || !location) return false
      return !form.location || locationKey(form.location) !== location
    })
    if (next.length === forms.length) return false
    setStore("session", "form", sessionID, next)
    return true
  }

  function settleForm(input: FormCancelInput, ref: LocationRef | undefined, request: Promise<void>) {
    return request
      .catch((error: unknown) => {
        if ((!isFormNotFoundError(error) && !isFormAlreadySettledError(error)) || error.id !== input.formID) throw error
      })
      .then(() => {
        if (!removeForm(input.sessionID, input.formID, ref)) return
        result.session.form.invalidate(input.sessionID, ref)
        void result.session.form.sync(input.sessionID, ref).catch(() => undefined)
      })
  }

  function updatePending(sessionID: string, inboxID: string, delivery: SessionInbox.Delivery) {
    const index = store.session.pending[sessionID]?.findIndex((item) => item.id === inboxID) ?? -1
    const item = store.session.pending[sessionID]?.[index]
    if (index < 0 || !item || item.delivery === delivery) return
    setStore("session", "pending", sessionID, index, { ...item, delivery })
  }

  // Inbox IDs of optimistic admissions awaiting acknowledgement, so rejection
  // only rolls back unacknowledged rows and a pending re-fetch cannot wipe a
  // row the server does not know about yet. Prompts clear on their durable
  // echo, positive pending read, or rollback; compactions also reconcile the
  // POST's canonical ID.
  const outbox = new Set<string>()

  // Session IDs of optimistic create admissions still awaiting acknowledgement
  // (the session.created echo or the create response itself). A failed create
  // only rolls back a session the server never acknowledged. Unlike
  // `creating`, this clears on the echo rather than request settlement.
  const sessionOutbox = new Set<string>()

  // In-flight optimistic creates by session ID. prompt() gates its POST on
  // this so a prompt sent to a still-creating session waits for the session
  // to exist server-side instead of failing with "not found".
  const creating = new Map<string, Promise<unknown>>()

  // Per-session send chain: prompts and compactions must be admitted in
  // submission order. Each waits for the previous POST to settle, so one
  // failure does not block the next.
  const sending = new Map<string, Promise<unknown>>()
  const messageLoads = new Map<string, Promise<unknown>>()
  const compacting = new Map<string, { id: string; observed: Set<string>; request: Promise<SessionInboxCompaction> }>()
  onCleanup(() => compacting.clear())

  // Register `promise` under `key` until it settles. A later registration
  // replaces an earlier one; settlement only clears its own entry.
  function track(map: Map<string, Promise<unknown>>, key: string, promise: Promise<unknown>) {
    map.set(key, promise)
    const settle = () => {
      if (map.get(key) === promise) map.delete(key)
    }
    void promise.then(settle, settle)
  }

  // Capture creation before settlement clears its entry, so dependent RPCs still see a failed create.
  function sendAdmission<Value>(sessionID: string, send: () => Promise<Value>, gate?: Promise<unknown>) {
    const created = creating.get(sessionID)
    const previous = sending.get(sessionID)
    const request = Promise.resolve()
      .then(() => Promise.all([gate, created, previous]))
      .then(send)
    track(
      sending,
      sessionID,
      request.catch(() => undefined),
    )
    return request
  }

  // Upsert an admitted inbox item into pending and (for user and synthetic
  // items) the visible transcript. Used by the inbox.enqueued
  // handler and by optimistic admission; the upsert is what reconciles
  // the durable echo with an optimistic placeholder — the durable payload and
  // times replace the client's guess.
  function admitLocal(item: SessionInboxInfo) {
    batch(() => {
      const pending = store.session.pending[item.sessionID] ?? []
      const at = pending.findIndex((entry) => entry.id === item.id)
      setStore(
        "session",
        "pending",
        item.sessionID,
        at < 0 ? [...pending, item] : pending.map((entry, index) => (index === at ? item : entry)),
      )
      if (item.type === "compaction") return
      materializeInboxMessage(item)
    })
  }

  function materializeInboxMessage(item: SessionInboxInfo) {
    if (item.type !== "user" && item.type !== "synthetic") return
    message.update(item.sessionID, (draft, index) => {
      const row =
        item.type === "user"
          ? { id: item.id, type: "user" as const, ...item.payload, time: { created: item.timeCreated } }
          : { id: item.id, type: "synthetic" as const, ...item.payload, time: { created: item.timeCreated } }
      const position = index.get(item.id)
      if (position === undefined) return message.append(draft, index, row)
      draft[position] = row
    })
  }

  // Remove an inbox item from pending, input, and the visible transcript.
  // Used by the inbox.cancelled handler and by optimistic rollback.
  function retractLocal(sessionID: string, inboxID: string) {
    batch(() => {
      removePending(sessionID, inboxID)
      if (!messageIndex.get(sessionID)?.has(inboxID)) return
      message.update(sessionID, (draft, index) => {
        const position = index.get(inboxID)
        if (position === undefined) return
        draft.splice(position, 1)
        index.delete(inboxID)
        message.reindex(draft, index, position)
      })
    })
  }

  const message = {
    update(sessionID: string, fn: (messages: SessionMessageInfo[], index: Map<string, number>) => void) {
      setStore(
        "session",
        "message",
        produce((draft) => {
          fn((draft[sessionID] ??= []), index(sessionID))
        }),
      )
    },
    append(messages: SessionMessageInfo[], index: Map<string, number>, item: SessionMessageInfo) {
      if (index.has(item.id)) return
      index.set(item.id, messages.length)
      messages.push(item)
    },
    insert(sessionID: string, item: SessionMessageInfo) {
      message.update(sessionID, (draft, index) => message.append(draft, index, item))
    },
    // Streaming events target one assistant message and, within it, the latest part of a kind.
    // A missing target means the row was never loaded or was evicted; the event is dropped.
    editAssistant(sessionID: string, messageID: string, fn: (assistant: SessionMessageAssistant) => void) {
      message.update(sessionID, (draft, index) => {
        const position = index.get(messageID)
        const item = position === undefined ? undefined : draft[position]
        if (item?.type === "assistant") fn(item)
      })
    },
    editTool(sessionID: string, messageID: string, toolID: string, fn: (tool: SessionMessageAssistantTool) => void) {
      message.editAssistant(sessionID, messageID, (assistant) => {
        const tool = assistant.content.findLast(
          (item): item is SessionMessageAssistantTool => item.type === "tool" && item.id === toolID,
        )
        if (tool) fn(tool)
      })
    },
    editText(sessionID: string, messageID: string, fn: (text: SessionMessageAssistantText) => void) {
      message.editAssistant(sessionID, messageID, (assistant) => {
        const text = assistant.content.findLast((item): item is SessionMessageAssistantText => item.type === "text")
        if (text) fn(text)
      })
    },
    editReasoning(sessionID: string, messageID: string, fn: (reasoning: SessionMessageAssistantReasoning) => void) {
      message.editAssistant(sessionID, messageID, (assistant) => {
        const reasoning = assistant.content.findLast(
          (item): item is SessionMessageAssistantReasoning => item.type === "reasoning" && !item.time?.completed,
        )
        if (reasoning) fn(reasoning)
      })
    },
    activeAssistant(messages: SessionMessageInfo[]) {
      const item = messages.findLast((item) => item.type === "assistant" && !item.time.completed)
      return item?.type === "assistant" ? item : undefined
    },
    shell(messages: SessionMessageInfo[], shellID: string) {
      const item = messages.findLast((item) => item.type === "shell" && item.shellID === shellID)
      return item?.type === "shell" ? item : undefined
    },
    compaction(messages: SessionMessageInfo[]) {
      const item = messages.findLast((item) => item.type === "compaction" && item.status === "running")
      return item?.type === "compaction" ? item : undefined
    },
    reindex(messages: SessionMessageInfo[], index: Map<string, number>, start: number) {
      for (let position = start; position < messages.length; position++) {
        const item = messages[position]
        if (item) index.set(item.id, position)
      }
    },
  }

  function index(sessionID: string) {
    const existing = messageIndex.get(sessionID)
    if (existing) return existing
    const created = new Map<string, number>()
    messageIndex.set(sessionID, created)
    return created
  }

  // Walk parentID upward through loaded session info to the family root. When a
  // parent's info is missing, that missing ID is the furthest-known ancestor and
  // is returned so orphan subtrees group under it until the parent arrives. A
  // seen set guards against parent cycles, stopping at the last non-repeating
  // ancestor.
  function resolveRoot(sessionID: string) {
    let current = sessionID
    let parentID = store.session.info[sessionID]?.parentID
    const seen = new Set([sessionID])
    while (parentID) {
      if (seen.has(parentID)) break
      seen.add(parentID)
      current = parentID
      parentID = store.session.info[parentID]?.parentID
    }
    return current
  }

  // Register one session into the family index. Idempotent: syncing an
  // existing session never duplicates its ID. When a tentative family keyed by
  // sessionID exists (descendants arrived while sessionID's own info was
  // absent) but sessionID turns out to have a parent, fold the orphan subtree
  // into the resolved root's family and drop the tentative entry.
  function registerSession(sessionID: string) {
    const info = store.session.info[sessionID]
    if (!info) return
    const rootID = resolveRoot(sessionID)
    setStore(
      "session",
      "family",
      produce((draft) => {
        if (sessionID !== rootID && draft[sessionID]) {
          const members = (draft[rootID] ??= [])
          for (const id of draft[sessionID]) {
            if (!members.includes(id)) members.push(id)
          }
          delete draft[sessionID]
        }
        const family = (draft[rootID] ??= [])
        if (!family.includes(sessionID)) family.push(sessionID)
      }),
    )
  }

  function evictSession(sessionID: string) {
    if (sessionOutbox.has(sessionID)) return
    sync.invalidate(`session.pending:${sessionID}`)
    sync.invalidate(`session.message:${sessionID}`)
    messageLoads.delete(sessionID)
    // Keep unacknowledged submissions until their echo or rollback settles them.
    const pending = store.session.pending[sessionID]?.filter((item) => outbox.has(item.id)) ?? []
    const messages = store.session.message[sessionID]?.filter((item) => outbox.has(item.id)) ?? []
    messageIndex.delete(sessionID)
    if (messages.length) messageIndex.set(sessionID, new Map(messages.map((item, index) => [item.id, index])))
    setStore(
      "session",
      produce((draft) => {
        delete draft.message[sessionID]
        delete draft.messageCursor[sessionID]
        delete draft.messageLoading[sessionID]
        delete draft.pending[sessionID]
        if (messages.length) draft.message[sessionID] = messages
        if (pending.length) draft.pending[sessionID] = pending
      }),
    )
  }

  function removeSession(sessionID: string) {
    activeUpdates?.set(sessionID, undefined)
    store.session.pending[sessionID]?.forEach((item) => outbox.delete(item.id))
    messageIndex.delete(sessionID)
    sync.invalidate(`session:${sessionID}`)
    sync.invalidate(`session.family:${sessionID}`)
    sync.invalidate(`session.pending:${sessionID}`)
    sync.invalidate(`session.message:${sessionID}`)
    sync.invalidate(`session.permission:${sessionID}`)
    sync.invalidate(`session.form:${sessionID}:`)
    setStore(
      "session",
      produce((draft) => {
        delete draft.info[sessionID]
        delete draft.active[sessionID]
        delete draft.message[sessionID]
        delete draft.messageCursor[sessionID]
        delete draft.messageLoading[sessionID]
        delete draft.pending[sessionID]
        delete draft.permission[sessionID]
        delete draft.form[sessionID]
        for (const [rootID, family] of Object.entries(draft.family)) {
          const next = family.filter((id) => id !== sessionID)
          if (next.length === 0) delete draft.family[rootID]
          else draft.family[rootID] = next
        }
      }),
    )
  }

  function handleEvent(event: OpenCodeEvent) {
    switch (event.type) {
      case "server.connected": {
        const updates = new Map<string, DataSessionStatus | undefined>()
        activeUpdates = updates
        refresh(() =>
          api()
            .session.active()
            .then((active) => {
              if (activeUpdates !== updates) return
              // Lifecycle events received during hydration supersede the snapshot.
              const snapshot = new Map<string, DataSessionStatus>(Object.keys(active).map((id) => [id, "running"]))
              updates.forEach((status, id) => {
                if (status === undefined) return snapshot.delete(id)
                snapshot.set(id, status)
              })
              activeUpdates = undefined
              setStore("session", "active", reconcile(Object.fromEntries(snapshot)))
            })
            .catch(() => {
              if (activeUpdates === updates) activeUpdates = undefined
            }),
        )
        refresh(() =>
          api()
            .location.get({ location: locationQuery(defaultLocation()) })
            .then((location) => {
              const key = locationKey(location)
              setStore("location", key, { info: location })
            }),
        )
        refresh(() => result.location.vcs.sync())
        refresh(() => result.project.sync())
        return
      }
      case "project.updated":
        setStore("project", "info", event.data.id, reconcile(event.data))
        return
      case "session.created":
        sessionOutbox.delete(event.data.sessionID)
        result.session.invalidate(event.data.sessionID)
        refresh(() => result.session.sync(event.data.sessionID))
        // Band-aid: a newly created session starts empty, so live events can be its source of truth.
        // Fetching pending inputs and projected messages separately lets promotion move an input between snapshots,
        // causing both requests to miss it and overwrite event-built state. Skip those racy initial reads until
        // hydration can load pending and projected messages atomically.
        sync.complete(`session.pending:${event.data.sessionID}`)
        sync.complete(`session.message:${event.data.sessionID}`)
        return
      case "session.deleted":
        removeSession(event.data.sessionID)
        return
      case "session.usage.updated":
        if (store.session.info[event.data.sessionID])
          setStore("session", "info", event.data.sessionID, {
            cost: event.data.cost,
            tokens: event.data.tokens,
          })
        return
      case "session.agent.selected": {
        const previous = store.session.info[event.data.sessionID]?.agent
        if (store.session.info[event.data.sessionID])
          setStore("session", "info", event.data.sessionID, "agent", event.data.agent)
        message.insert(event.data.sessionID, {
          id: messageIDFromEvent(event.id),
          type: "agent-switched",
          agent: event.data.agent,
          previous,
          time: { created: event.created },
        })
        return
      }
      case "session.model.selected":
        if (store.session.info[event.data.sessionID])
          setStore("session", "info", event.data.sessionID, "model", event.data.model)
        if (!store.session.message[event.data.sessionID]) return
        message.insert(event.data.sessionID, {
          id: messageIDFromEvent(event.id),
          type: "model-switched",
          model: event.data.model,
          time: { created: event.created },
        })
        refresh(() =>
          api()
            .session.message({ sessionID: event.data.sessionID, messageID: messageIDFromEvent(event.id) })
            .then((item) => {
              message.update(event.data.sessionID, (draft, index) => {
                const position = index.get(item.id)
                if (position === undefined) return message.append(draft, index, item)
                draft[position] = item
              })
            }),
        )
        return
      case "session.renamed": {
        // Preserve the live title when it races the session's initial read.
        refresh(() => {
          const family = sync.pending(`session.family:${event.data.sessionID}`)
            ? result.session.sync(event.data.sessionID, { children: true })
            : Promise.resolve()
          return Promise.all([result.session.sync(event.data.sessionID), family]).then(() => {
            if (store.session.info[event.data.sessionID])
              setStore("session", "info", event.data.sessionID, "title", event.data.title)
          })
        })
        return
      }
      case "session.permissions.updated":
        if (store.session.info[event.data.sessionID])
          setStore("session", "info", event.data.sessionID, "permissions", event.data.permissions)
        return
      case "session.moved": {
        const current = store.session.info[event.data.sessionID]
        if (current) {
          const previous = {
            location: { ...current.location },
            projectID: current.projectID,
            subpath: current.subpath,
          }
          setStore("session", "info", event.data.sessionID, "location", event.data.location)
          if (event.data.projectID) setStore("session", "info", event.data.sessionID, "projectID", event.data.projectID)
          setStore("session", "info", event.data.sessionID, "subpath", event.data.subpath)
          message.insert(event.data.sessionID, {
            id: messageIDFromEvent(event.id),
            type: "location-switched",
            location: event.data.location,
            projectID: event.data.projectID,
            subpath: event.data.subpath,
            previous,
            time: { created: event.created },
          })
        }
        return
      }
      case "worktree.resolved": {
        for (const [sessionID, info] of Object.entries(store.session.info)) {
          const explicit = event.data.adopted?.includes(info.projectID)
          const directory = explicit ? store.project.info[info.projectID]?.canonical : info.location.directory
          if (!directory) {
            if (info.location.workspaceID) continue
            result.session.invalidate(sessionID)
            refresh(() => result.session.sync(sessionID))
            continue
          }
          const adopted = Worktree.adopt(
            {
              projectID: info.projectID,
              directory,
              workspaceID: info.location.workspaceID,
            },
            event.data,
          )
          if (!adopted) continue
          setStore("session", "info", sessionID, "projectID", adopted.projectID)
          setStore("session", "info", sessionID, "subpath", adopted.subpath)
        }
        return
      }
      case "session.inbox.delivered": {
        const admitted = result.session.input.has(event.data.sessionID, event.data.inboxID)
        removePending(event.data.sessionID, event.data.inboxID)
        message.update(event.data.sessionID, (draft, index) => {
          const position = index.get(event.data.inboxID)
          if (position === undefined) return
          const existing = draft[position]
          if (!existing || !admitted) return
          existing.time.created = event.created
          draft.splice(position, 1)
          draft.push(existing)
          message.reindex(draft, index, position)
        })
        compacting.get(event.data.sessionID)?.observed.add(event.data.inboxID)
        return
      }
      case "session.inbox.delivery.changed":
        updatePending(event.data.sessionID, event.data.inboxID, event.data.delivery)
        return
      case "session.inbox.cancelled": {
        retractLocal(event.data.sessionID, event.data.inboxID)
        compacting.get(event.data.sessionID)?.observed.add(event.data.inboxID)
        return
      }
      case "session.inbox.enqueued": {
        outbox.delete(event.data.inboxID)
        admitLocal({
          id: event.data.inboxID,
          sessionID: event.data.sessionID,
          timeCreated: event.created,
          ...event.data.item,
        })
        if (event.data.item.type === "compaction") {
          const active = compacting.get(event.data.sessionID)
          active?.observed.add(event.data.inboxID)
          if (active && active.id !== event.data.inboxID && outbox.delete(active.id))
            removePending(event.data.sessionID, active.id)
        }
        return
      }
      case "session.instructions.updated":
        // Mirror the projector: the initial baseline and empty-rendering deltas carry no text
        // and produce no transcript message.
        const updateText = event.data.text
        if (updateText === undefined) return
        message.insert(event.data.sessionID, {
          id: messageIDFromEvent(event.id),
          type: "system",
          text: updateText,
          description: `Instructions updated: ${Object.keys(event.data.delta).join(", ")}`,
          metadata: event.metadata,
          time: { created: event.created },
        })
        return
      case "session.synthetic":
        message.insert(event.data.sessionID, {
          id: messageIDFromEvent(event.id),
          type: "synthetic",
          text: event.data.text,
          description: event.data.description,
          metadata: event.data.metadata,
          time: { created: event.created },
        })
        return
      case "session.shell.started":
        message.insert(event.data.sessionID, {
          id: messageIDFromEvent(event.id),
          type: "shell",
          shellID: event.data.shell.id,
          command: event.data.shell.command,
          status: event.data.shell.status,
          exit: event.data.shell.exit,
          metadata:
            event.data.shell.metadata.background === true ? { ...event.metadata, background: true } : event.metadata,
          time: { created: event.created },
        })
        return
      case "session.shell.ended":
        message.update(event.data.sessionID, (draft) => {
          const match = message.shell(draft, event.data.shell.id)
          if (!match) return
          match.status = event.data.shell.status
          match.exit = event.data.shell.exit
          match.output = event.data.output
          match.time.completed = event.created
        })
        return
      case "session.step.started":
        message.update(event.data.sessionID, (draft, index) => {
          const position = index.get(event.data.assistantMessageID)
          const existing = position === undefined ? undefined : draft[position]
          if (existing?.type === "assistant") {
            existing.agent = event.data.agent
            existing.model = event.data.model
            existing.retry = undefined
            existing.error = undefined
            existing.finish = undefined
            existing.rawFinish = undefined
            existing.providerState = undefined
            existing.time.streamed = undefined
            existing.time.completed = undefined
            if (event.data.snapshot) existing.snapshot = { ...existing.snapshot, start: event.data.snapshot }
            return
          }
          const currentAssistant = message.activeAssistant(draft)
          if (currentAssistant) {
            currentAssistant.retry = undefined
            currentAssistant.time.completed = event.created
          }
          message.append(draft, index, {
            id: event.data.assistantMessageID,
            type: "assistant",
            agent: event.data.agent,
            model: event.data.model,
            metadata: event.metadata,
            content: [],
            snapshot: event.data.snapshot ? { start: event.data.snapshot } : undefined,
            time: { created: event.created },
          })
        })
        return
      case "session.step.streamed":
        message.editAssistant(event.data.sessionID, event.data.assistantMessageID, (assistant) => {
          assistant.time.streamed = event.created
        })
        return
      case "session.step.ended": {
        message.editAssistant(event.data.sessionID, event.data.assistantMessageID, (assistant) => {
          assistant.time.completed = event.created
          assistant.finish = event.data.finish
          assistant.rawFinish = event.data.rawFinish
          assistant.providerState = event.data.providerState
          assistant.cost = event.data.cost
          assistant.tokens = event.data.tokens
          if (event.data.snapshot) assistant.snapshot = { ...assistant.snapshot, end: event.data.snapshot }
        })
        return
      }
      case "session.step.failed":
        message.editAssistant(event.data.sessionID, event.data.assistantMessageID, (assistant) => {
          assistant.time.completed = event.created
          assistant.finish = event.data.finish ?? "error"
          assistant.rawFinish = event.data.rawFinish
          assistant.providerState = event.data.providerState
          assistant.error = event.data.error
          assistant.retry = undefined
          if (event.data.cost !== undefined && event.data.tokens !== undefined) {
            assistant.cost = event.data.cost
            assistant.tokens = event.data.tokens
          }
        })
        return
      case "session.text.started":
        message.editAssistant(event.data.sessionID, event.data.assistantMessageID, (assistant) => {
          assistant.content.push({ type: "text", text: "" })
        })
        return
      case "session.text.delta":
        message.editText(event.data.sessionID, event.data.assistantMessageID, (text) => {
          text.text += event.data.delta
        })
        return
      case "session.text.ended":
        message.editText(event.data.sessionID, event.data.assistantMessageID, (text) => {
          text.text = event.data.text
        })
        return
      case "session.tool.input.started":
        message.editAssistant(event.data.sessionID, event.data.assistantMessageID, (assistant) => {
          assistant.content.push({
            type: "tool",
            id: event.data.id,
            name: event.data.name,
            time: { created: event.created },
            state: { status: "streaming", input: "" },
          })
        })
        return
      case "session.tool.input.delta":
        message.editTool(event.data.sessionID, event.data.assistantMessageID, event.data.id, (tool) => {
          if (tool.state.status === "streaming") tool.state.input += event.data.delta
        })
        return
      case "session.tool.input.ended":
        message.editTool(event.data.sessionID, event.data.assistantMessageID, event.data.id, (tool) => {
          if (tool.state.status === "streaming") tool.state.input = event.data.text
        })
        return
      case "session.tool.called":
        message.editTool(event.data.sessionID, event.data.assistantMessageID, event.data.id, (tool) => {
          tool.time.ran = event.created
          tool.executed = event.data.executed
          tool.providerState = event.data.state
          tool.state = { status: "running", input: event.data.input, metadata: {} }
        })
        return
      case "session.tool.progress":
        message.editTool(event.data.sessionID, event.data.assistantMessageID, event.data.id, (tool) => {
          if (tool.state.status === "running") tool.state.metadata = event.data.metadata
        })
        return
      case "session.tool.success":
        message.editTool(event.data.sessionID, event.data.assistantMessageID, event.data.id, (tool) => {
          if (tool.state.status !== "running") return
          tool.state = {
            status: "completed",
            input: tool.state.input,
            metadata: event.data.metadata,
            content: [...event.data.content],
          }
          tool.executed = event.data.executed || tool.executed === true
          tool.providerResultState = event.data.resultState
          tool.time.completed = event.created
        })
        return
      case "session.tool.failed":
        message.editTool(event.data.sessionID, event.data.assistantMessageID, event.data.id, (tool) => {
          if (tool.state.status !== "streaming" && tool.state.status !== "running") return
          tool.state = {
            status: "error",
            error: event.data.error,
            input: typeof tool.state.input === "string" ? {} : tool.state.input,
            metadata: event.data.metadata,
            content: event.data.content,
          }
          tool.executed = event.data.executed || tool.executed === true
          tool.providerResultState = event.data.resultState
          tool.time.completed = event.created
        })
        return
      case "session.reasoning.started":
        message.editAssistant(event.data.sessionID, event.data.assistantMessageID, (assistant) => {
          assistant.content.push({
            type: "reasoning",
            text: "",
            state: event.data.state,
            time: { created: event.created },
          })
        })
        return
      case "session.reasoning.delta":
        message.editReasoning(event.data.sessionID, event.data.assistantMessageID, (reasoning) => {
          reasoning.text += event.data.delta
        })
        return
      case "session.reasoning.ended":
        message.editReasoning(event.data.sessionID, event.data.assistantMessageID, (reasoning) => {
          reasoning.text = event.data.text
          reasoning.time = { created: reasoning.time?.created ?? event.created, completed: event.created }
          if (event.data.state !== undefined) reasoning.state = event.data.state
        })
        return
      case "session.retry.scheduled":
        message.editAssistant(event.data.sessionID, event.data.assistantMessageID, (assistant) => {
          assistant.retry = { attempt: event.data.attempt, at: event.data.at, error: event.data.error }
        })
        return
      case "session.execution.started":
        setSessionActive(event.data.sessionID, "running")
        return
      case "session.compaction.started":
        if (event.data.inputID) removePending(event.data.sessionID, event.data.inputID)
        message.insert(event.data.sessionID, {
          id: event.data.inputID ?? messageIDFromEvent(event.id),
          type: "compaction",
          status: "running",
          reason: event.data.reason,
          summary: "",
          recent: event.data.recent ?? "",
          time: { created: event.created },
        })
        if (event.data.inputID) compacting.get(event.data.sessionID)?.observed.add(event.data.inputID)
        return
      case "session.execution.succeeded":
      case "session.execution.failed":
      case "session.execution.interrupted":
        setSessionActive(event.data.sessionID, "idle")
        message.update(event.data.sessionID, (draft) => {
          const currentAssistant = message.activeAssistant(draft)
          if (currentAssistant) currentAssistant.retry = undefined
        })
        if (event.type === "session.execution.interrupted" && event.data.reason === "shutdown") return
        // Mirror the projected idle marker so turn boundaries match before the next message read.
        message.insert(event.data.sessionID, {
          id: messageIDFromEvent(event.id),
          type: "idle",
          outcome:
            event.type === "session.execution.succeeded"
              ? "succeeded"
              : event.type === "session.execution.failed"
                ? "failed"
                : "interrupted",
          time: { created: event.created },
        })
        // An event can overtake the first read; queue a revalidation when that read is still active.
        if (!store.session.info[event.data.sessionID] && !sync.has(`session:${event.data.sessionID}`)) return
        result.session.invalidate(event.data.sessionID)
        refresh(() => result.session.sync(event.data.sessionID))
        return
      case "session.viewed":
        if (!store.session.info[event.data.sessionID] && !sync.has(`session:${event.data.sessionID}`)) return
        result.session.invalidate(event.data.sessionID)
        refresh(() => result.session.sync(event.data.sessionID))
        return
      case "session.revert.staged":
        if (store.session.info[event.data.sessionID])
          setStore("session", "info", event.data.sessionID, "revert", event.data.revert)
        return
      case "session.revert.cleared":
        if (store.session.info[event.data.sessionID])
          setStore("session", "info", event.data.sessionID, "revert", undefined)
        return
      case "session.revert.committed":
        if (store.session.info[event.data.sessionID]) {
          setStore("session", "info", event.data.sessionID, "revert", undefined)
        }
        // The projector also deletes inbox items enqueued at or after the boundary without a cancel event.
        setStore(
          "session",
          "pending",
          event.data.sessionID,
          (store.session.pending[event.data.sessionID] ?? []).filter((item) => item.id < event.data.to),
        )
        message.update(event.data.sessionID, (draft, index) => {
          const position = draft.findIndex((item) => item.id >= event.data.to)
          if (position === -1) return
          for (const item of draft.splice(position)) index.delete(item.id)
        })
        return
      case "session.compaction.delta":
        message.update(event.data.sessionID, (draft) => {
          const current = message.compaction(draft)
          if (current?.status === "running") current.summary += event.data.text
        })
        return
      case "session.compaction.ended":
        message.update(event.data.sessionID, (draft, index) => {
          const position = draft.findLastIndex((item) => item.type === "compaction" && item.status === "running")
          const current = draft[position]
          if (current?.type === "compaction") {
            Object.assign(current, {
              status: "completed",
              reason: event.data.reason,
              model: event.data.model,
              providerState: event.data.providerState,
              providerContext: event.data.providerContext,
              summary: event.data.text,
              recent: event.data.recent,
              cost: event.data.cost,
              tokens: event.data.tokens,
            })
            return
          }
          message.append(draft, index, {
            id: messageIDFromEvent(event.id),
            type: "compaction",
            status: "completed",
            reason: event.data.reason,
            model: event.data.model,
            providerState: event.data.providerState,
            providerContext: event.data.providerContext,
            summary: event.data.text,
            recent: event.data.recent,
            cost: event.data.cost,
            tokens: event.data.tokens,
            time: { created: event.created },
          })
        })
        return
      case "session.compaction.failed":
        if (event.data.inputID) removePending(event.data.sessionID, event.data.inputID)
        message.update(event.data.sessionID, (draft, index) => {
          const position = draft.findLastIndex((item) => item.type === "compaction" && item.status === "running")
          const current = draft[position]
          const failed: Extract<SessionMessageInfo, { type: "compaction"; status: "failed" }> = {
            id: current?.id ?? event.data.inputID ?? messageIDFromEvent(event.id),
            type: "compaction",
            status: "failed",
            reason: event.data.reason ?? "manual",
            error: event.data.error ?? {
              type: "compaction.failed",
              message: "Compaction failed before recording an error",
            },
            metadata: current?.type === "compaction" ? current.metadata : event.metadata,
            cost: event.data.cost,
            tokens: event.data.tokens,
            time: current?.type === "compaction" ? current.time : { created: event.created },
          }
          if (current?.type === "compaction") {
            draft[position] = failed
            return
          }
          message.append(draft, index, failed)
        })
        if (event.data.inputID) compacting.get(event.data.sessionID)?.observed.add(event.data.inputID)
        return
      case "permission.asked":
        if (store.session.permission[event.data.sessionID]?.some((request) => request.id === event.data.id)) return
        setStore("session", "permission", event.data.sessionID, [
          ...(store.session.permission[event.data.sessionID] ?? []),
          event.data,
        ])
        return
      case "permission.replied":
        removePermission(event.data.sessionID, event.data.requestID)
        return
      case "form.replied":
      case "form.cancelled":
        removeForm(event.data.sessionID, event.data.id, event.location)
        return
    }

    if (event.type === "credential.updated" || event.type === "credential.switched") {
      Object.keys(store.location).forEach((key) => {
        const ref = JSON.parse(key) as [string, string | null]
        const location = { directory: ref[0], workspaceID: ref[1] ?? undefined }
        if (event.type === "credential.updated") {
          result.location.integration.invalidate(location)
          refresh(() => result.location.integration.sync(location))
          return
        }
        setStore("location", key, (data) => ({
          integration: data?.integration?.map((integration) => {
            if (integration.id !== event.data.integrationID) return integration
            const active = integration.connections.find(
              (connection) => connection.type === "credential" && connection.id === event.data.credentialID,
            )
            if (!active) return integration
            return {
              ...integration,
              connections: [active, ...integration.connections.filter((connection) => connection !== active)],
            }
          }),
        }))
        result.location.model.invalidate(location)
        result.location.provider.invalidate(location)
        refresh(() => Promise.all([result.location.model.sync(location), result.location.provider.sync(location)]))
      })
      return
    }

    if (!event.location) return
    const location = event.location
    switch (event.type) {
      case "catalog.updated":
        result.location.model.invalidate(location)
        result.location.provider.invalidate(location)
        refresh(() => Promise.all([result.location.model.sync(location), result.location.provider.sync(location)]))
        break
      case "agent.updated":
        result.location.agent.invalidate(location)
        refresh(() => result.location.agent.sync(location))
        break
      case "command.updated":
        result.location.command.invalidate(location)
        refresh(() => result.location.command.sync(location))
        break
      case "skill.updated":
        result.location.skill.invalidate(location)
        refresh(() => result.location.skill.sync(location))
        break
      case "vcs.branch.updated":
        setStore("location", locationKey(location), (data) => ({
          vcs: {
            branch: {
              ...data?.vcs?.branch,
              current: event.data.branch,
            },
          },
        }))
        break
      case "form.created":
        if (store.session.form[event.data.form.sessionID]?.some((form) => form.id === event.data.form.id)) break
        setStore("session", "form", event.data.form.sessionID, [
          ...(store.session.form[event.data.form.sessionID] ?? []),
          event.data.form.sessionID === "global" ? { ...event.data.form, location } : event.data.form,
        ])
        break
      case "shell.created":
        setStore("location", locationKey(location), (data) => ({
          shell: {
            ...data?.shell,
            [event.data.info.id]: { ...event.data.info, location },
          },
        }))
        break
      case "shell.exited":
      case "shell.deleted":
        setStore("location", locationKey(location), (data) => ({
          shell: Object.fromEntries(Object.entries(data?.shell ?? {}).filter(([id]) => id !== event.data.id)),
        }))
        break
      case "reference.updated":
        result.location.reference.invalidate(location)
        refresh(() => result.location.reference.sync(location))
        break
      case "integration.updated":
        result.location.integration.invalidate(location)
        result.location.model.invalidate(location)
        result.location.provider.invalidate(location)
        refresh(() =>
          Promise.all([
            result.location.integration.sync(location),
            result.location.model.sync(location),
            result.location.provider.sync(location),
          ]),
        )
        break
      case "config.updated":
        result.location.config.invalidate(location)
        if (result.location.config.list(location) !== undefined || sync.has(`location.config:${locationKey(location)}`))
          refresh(() => result.location.config.sync(location))
        refresh(() => result.location.websearch.refresh(location))
        break
      case "websearch.updated":
        refresh(() => result.location.websearch.refresh(location))
        break
      // Authenticating an MCP integration reconnects its server, which emits mcp.status.changed,
      // so the mcp list syncs here rather than off integration.updated. The server emits one event
      // per MCP server as each settles, so a location booting nine servers emitted nine refetches.
      case "mcp.status.changed":
        result.location.mcp.server.invalidate(location)
        settle(`mcp.status:${locationKey(location)}`, () => result.location.mcp.server.sync(location))
        break
      case "mcp.resources.changed":
        result.location.mcp.resource.invalidate(location)
        refresh(() => result.location.mcp.resource.sync(location))
        break
    }
  }

  // A cached per-location catalog. `sync` loads once per invalidation, keyed by the
  // effective location, and publishes under the server's canonical location; `alias`
  // also publishes under the requested key when the two differ.
  function locationResource<Field extends keyof LocationData>(
    field: Field,
    load: (location: ReturnType<typeof locationQuery>) => Promise<{ location: LocationRef; data: LocationData[Field] }>,
    options?: { alias?: boolean },
  ) {
    const publish = (key: string, value: LocationData[Field]) => setStore("location", key, { [field]: value })
    return {
      list: (ref?: LocationRef) => store.location[locationKey(ref ?? defaultLocation())]?.[field],
      sync: (ref?: LocationRef) => {
        const location = ref ?? defaultLocation()
        const id = locationKey(location)
        return sync.run(`location.${field}:${id}`, async () => {
          const response = await load(locationQuery(location))
          const key = locationKey(response.location)
          publish(key, response.data)
          if (options?.alias && key !== id) publish(id, response.data)
        })
      },
      invalidate: (ref?: LocationRef) => sync.invalidate(`location.${field}:${locationKey(ref ?? defaultLocation())}`),
    }
  }

  const vcs = locationResource("vcs", (location) => api().vcs.get({ location }))
  const shells = locationResource("shell", async (location) => {
    const response = await api().shell.list({ location })
    const ref = { directory: response.location.directory, workspaceID: response.location.workspaceID }
    return {
      location: response.location,
      data: Object.fromEntries(response.data.map((info) => [info.id, { ...info, location: ref }])),
    }
  })

  const result = {
    on: config.event.on,
    listen: config.event.listen,
    session: {
      list() {
        return sessions()
      },
      get(sessionID: string) {
        return store.session.info[sessionID]
      },
      creating(sessionID: string) {
        return creating.has(sessionID)
      },
      remember(info: SessionInfo) {
        batch(() => {
          setStore("session", "info", info.id, reconcile(info))
          sync.complete(`session:${info.id}`)
          registerSession(info.id)
        })
      },
      setStatus(sessionID: string, status: DataSessionStatus) {
        setSessionActive(sessionID, status)
      },
      root(sessionID: string) {
        return resolveRoot(sessionID)
      },
      family(sessionID: string) {
        return store.session.family[resolveRoot(sessionID)] ?? []
      },
      /** Clear heavy cached data for the root and all known descendants. */
      evict(sessionID: string) {
        const root = resolveRoot(sessionID)
        batch(() => {
          for (const id of new Set([root, sessionID, ...(store.session.family[root] ?? [])])) evictSession(id)
        })
      },
      cost(sessionID: string) {
        const session = store.session.info[sessionID]
        if (!session) return 0
        if (session.parentID) return session.cost
        return (store.session.family[sessionID] ?? [sessionID]).reduce(
          (total, id) => total + (store.session.info[id]?.cost ?? 0),
          0,
        )
      },
      status(sessionID: string) {
        return store.session.active[sessionID] ?? "idle"
      },
      // Inputs are the pending user and synthetic items; compactions are control items.
      input: {
        list(sessionID: string) {
          return (store.session.pending[sessionID] ?? []).flatMap((item) =>
            item.type === "compaction" ? [] : [item.id],
          )
        },
        has(sessionID: string, inboxID: string) {
          return (
            store.session.pending[sessionID]?.some((item) => item.id === inboxID && item.type !== "compaction") ?? false
          )
        },
      },
      pending: {
        list(sessionID: string) {
          return store.session.pending[sessionID] ?? []
        },
        sync(sessionID: string) {
          return sync.run(`session.pending:${sessionID}`, async () => {
            const pending = await api().session.inbox.list({ sessionID })
            // A positive read acknowledges admission even when its SSE echo is delayed.
            pending.forEach((item) => outbox.delete(item.id))
            // Compactions also coalesce by Session, not just by the proposed ID.
            if (pending.some((item) => item.type === "compaction"))
              store.session.pending[sessionID]
                ?.filter((item) => item.type === "compaction")
                .forEach((item) => outbox.delete(item.id))
            // Keep optimistic rows still awaiting their echo: this fetch may
            // have raced ahead of an in-flight admission the server does not
            // know about yet.
            const inflight = (store.session.pending[sessionID] ?? []).filter((item) => outbox.has(item.id))
            const merged = inflight.length === 0 ? pending : [...pending, ...inflight]
            batch(() => {
              setStore("session", "pending", sessionID, reconcile(merged))
              merged.forEach(materializeInboxMessage)
            })
          })
        },
        invalidate(sessionID: string) {
          sync.invalidate(`session.pending:${sessionID}`)
        },
      },
      // Optimistic session creation: admit a local record under a
      // client-minted ID so a session view can mount immediately, then create
      // the session on the server. The session.created echo re-syncs the
      // record by ID, so the durable payload replaces the client's guess.
      // Returns the ID synchronously along with the in-flight request:
      // callers gate session-dependent sends on the request (prompt() gates
      // itself on any in-flight create of its session automatically).
      create(input: {
        id?: string
        title?: string
        agent?: string
        model?: ModelRef
        location?: LocationRef
        projectID?: string
      }) {
        const { projectID, ...payload } = input
        const id = payload.id ?? SessionID.create()
        const location = payload.location ?? defaultLocation()
        const fresh = !store.session.info[id]
        if (fresh) {
          const now = Date.now()
          sessionOutbox.add(id)
          result.session.remember({
            id,
            projectID: projectID ?? store.location[locationKey(location)]?.info?.project.id ?? "",
            agent: payload.agent,
            model: payload.model,
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            time: { created: now, updated: now },
            title: payload.title,
            location,
          })
          // A mounted optimistic session must not fetch its empty collections
          // before creation settles. The session.created echo re-syncs info.
          sync.complete(`session.family:${id}`)
          sync.complete(`session.pending:${id}`)
          sync.complete(`session.message:${id}`)
        }
        // Wrapped so even a synchronous client failure reaches the rollback.
        const request = Promise.resolve()
          .then(() => api().session.create({ ...payload, id, location }))
          .then((info) => {
            sessionOutbox.delete(id)
            result.session.remember(info)
            return info
          })
          .catch((error) => {
            // Roll back only a record this call admitted and neither the echo
            // nor the response has acknowledged: anything else is server state.
            if (fresh && sessionOutbox.delete(id)) removeSession(id)
            throw error
          })
        if (fresh) track(creating, id, request)
        return { id, request }
      },
      compact(input: { sessionID: string; model?: ModelRef }) {
        const active = compacting.get(input.sessionID)
        if (active) return active.request
        // A known pending control ID may be consumed while setup waits. Propose
        // a fresh ID and let the server coalesce, without duplicating its row.
        const id = SessionMessage.ID.create()
        if (!store.session.pending[input.sessionID]?.some((item) => item.type === "compaction")) {
          outbox.add(id)
          admitLocal({
            id,
            sessionID: input.sessionID,
            timeCreated: Date.now(),
            type: "compaction",
            delivery: "steer",
            payload: {},
          })
        }
        // Compaction admission can coalesce onto a different ID. Retire the
        // speculative row on an echo, and remember consumed IDs until the POST
        // settles so its older response cannot resurrect a queued row.
        const observed = new Set<string>()
        const request = sendAdmission(input.sessionID, async () => {
          if (input.model) await api().session.switchModel({ sessionID: input.sessionID, model: input.model })
          return api().session.compact({ sessionID: input.sessionID, id })
        })
          .then((item) => {
            batch(() => {
              outbox.delete(id)
              if (item.id !== id) removePending(input.sessionID, id)
              if (!observed.has(item.id) && !messageIndex.get(input.sessionID)?.has(item.id)) admitLocal(item)
            })
            return item
          })
          .catch((error) => {
            if (outbox.delete(id)) removePending(input.sessionID, id)
            throw error
          })
          .finally(() => {
            if (compacting.get(input.sessionID)?.request === request) compacting.delete(input.sessionID)
          })
        compacting.set(input.sessionID, { id, observed, request })
        return request
      },
      // Optimistic prompt admission: render the prompt immediately under a
      // client-minted ID, send it, and let the durable inbox.enqueued echo
      // upsert that same ID with the server's payload. Server admission is
      // idempotent per ID, so retrying with the identical payload cannot
      // double-admit.
      prompt(input: SessionPromptInput & { gate?: Promise<unknown>; prepare?: () => Promise<unknown> }) {
        const { gate, prepare, ...request } = input
        const id = request.id ?? SessionMessage.ID.create()
        // A retry may reuse an ID that is already rendered — and possibly
        // already durable. Admit optimistically only for new IDs so a failed
        // retry cannot roll back acknowledged state.
        const fresh =
          !messageIndex.get(request.sessionID)?.has(id) &&
          !store.session.pending[request.sessionID]?.some((item) => item.id === id)
        if (fresh) {
          outbox.add(id)
          admitLocal({
            id,
            sessionID: request.sessionID,
            timeCreated: Date.now(),
            type: "user",
            delivery: request.delivery ?? "steer",
            // Files and skills stay off the optimistic row: their durable
            // forms are server-loaded (content, mime, resolution), so they
            // fill in when the echo upserts the row.
            payload: {
              text: request.text,
              agents: request.agents?.map((agent) => ({ ...agent })),
              metadata: request.metadata,
            },
          })
        }
        return sendAdmission(
          request.sessionID,
          async () => {
            await prepare?.()
            return api().session.prompt({ ...request, id })
          },
          gate,
        ).catch((error) => {
          // Roll back only rows this call admitted and the server has not
          // acknowledged: anything else is server state.
          if (fresh && outbox.delete(id)) retractLocal(request.sessionID, id)
          throw error
        })
      },
      sync(sessionID: string, options?: { children?: boolean }) {
        return sync.run(options?.children ? `session.family:${sessionID}` : `session:${sessionID}`, async () => {
          const [info, children] = await Promise.all([
            api().session.get({ sessionID }),
            options?.children
              ? api()
                  .session.list({ parentID: sessionID, order: "desc" })
                  .then((response) => response.data)
              : [],
          ])
          const sessions = [info, ...children]
          batch(() => {
            setStore(
              "session",
              "info",
              produce((draft) => {
                for (const session of sessions) draft[session.id] = session
              }),
            )
            for (const session of sessions) {
              sync.complete(`session:${session.id}`)
              registerSession(session.id)
            }
          })
        })
      },
      invalidate(sessionID: string) {
        sync.invalidate(`session:${sessionID}`)
      },
      message: {
        list(sessionID: string) {
          return store.session.message[sessionID] ?? []
        },
        // Filtered reads are sparse history and must not replace or prepend the contiguous transcript window.
        async users(
          sessionID: string,
          options?: {
            boundary?: { messageID: string; direction: "before" | "after" }
            limit?: number
            signal?: AbortSignal
          },
        ) {
          const client = api()
          const order = options?.boundary?.direction === "after" ? "asc" : "desc"
          const messages: SessionMessageUser[] = []
          let boundary = options?.boundary?.messageID
          let cursor: string | undefined
          do {
            options?.signal?.throwIfAborted()
            const page = await client.message.list(
              {
                sessionID,
                type: "user",
                limit: boundary ? 200 : Math.min(options?.limit ?? 200, 200),
                ...(cursor ? { cursor } : { order }),
              },
              { signal: options?.signal },
            )
            options?.signal?.throwIfAborted()
            const users = page.data.filter((message): message is SessionMessageUser => message.type === "user")
            const index = boundary ? users.findIndex((message) => message.id === boundary) : -1
            if (!boundary || index !== -1) {
              messages.push(...(boundary ? users.slice(index + 1) : users))
              boundary = undefined
            }
            cursor = page.cursor.next ?? undefined
          } while (cursor && (options?.limit === undefined || messages.length < options.limit))
          const selected = messages.slice(0, options?.limit)
          return order === "desc" ? selected.reverse() : selected
        },
        get(sessionID: string, messageID: string) {
          const messages = store.session.message[sessionID]
          const position = messageIndex.get(sessionID)?.get(messageID)
          return position === undefined ? undefined : messages?.[position]
        },
        sync(sessionID: string) {
          return sync.run(`session.message:${sessionID}`, async () => {
            const response = await api().message.list({
              sessionID,
              limit: config.initialMessageLimit?.() ?? messagePageLimit,
              order: "desc",
            })
            const fetched = response.data.toReversed()
            // Same protection as the pending sync: a re-fetch racing an
            // admission must not wipe its local transcript row.
            const ids = new Set(fetched.map((item) => item.id))
            const admitted = new Set(
              (store.session.pending[sessionID] ?? []).flatMap((item) =>
                item.type === "user" || item.type === "synthetic" ? [item.id] : [],
              ),
            )
            const local = (store.session.message[sessionID] ?? []).filter(
              (item) => !ids.has(item.id) && (outbox.has(item.id) || admitted.has(item.id)),
            )
            const messages = local.length === 0 ? fetched : [...fetched, ...local]
            batch(() => {
              messageIndex.set(sessionID, new Map(messages.map((message, index) => [message.id, index])))
              setStore("session", "message", sessionID, reconcile(messages))
              setStore("session", "messageCursor", sessionID, response.cursor.next ?? undefined)
            })
          })
        },
        more(sessionID: string) {
          return store.session.messageCursor[sessionID] !== undefined
        },
        loading(sessionID: string) {
          return store.session.messageLoading[sessionID] ?? false
        },
        async loadMore(
          sessionID: string,
          options?: {
            all?: boolean
            /** Load a contiguous history window through this message, publishing once. */
            until?: string
            signal?: AbortSignal
            /** Runs synchronously inside the store-publication batch. */
            beforePublish?: () => void
          },
        ) {
          const signal = options?.signal
          if (signal?.aborted) return
          if (options?.until && messageIndex.get(sessionID)?.has(options.until)) return
          while (messageLoads.has(sessionID)) {
            const published = await (() => {
              const pending = messageLoads.get(sessionID)
              if (!signal) return pending
              const aborted = Promise.withResolvers<void>()
              const cancel = () => aborted.resolve()
              signal.addEventListener("abort", cancel, { once: true })
              return Promise.race([pending, aborted.promise])
                .catch((error) => {
                  if (!signal.aborted) throw error
                })
                .finally(() => signal.removeEventListener("abort", cancel))
            })()
            if ((!options?.all && !options?.until && published) || signal?.aborted) return
            if (options?.until && messageIndex.get(sessionID)?.has(options.until)) return
          }
          const cursor = store.session.messageCursor[sessionID]
          if (!cursor || signal?.aborted) return
          setStore("session", "messageLoading", sessionID, true)
          const request = (async () => {
            const fetched: SessionMessageInfo[] = []
            let next: string | undefined = cursor
            do {
              const response = await api().message.list(
                {
                  sessionID,
                  limit: options?.all || options?.until ? 200 : messagePageLimit,
                  cursor: next,
                },
                { signal },
              )
              if (signal?.aborted) return
              fetched.push(...response.data)
              next = response.cursor.next ?? undefined
              if (options?.until && response.data.some((message) => message.id === options.until)) break
              if (!options?.all && !options?.until) break
            } while (next)
            // A jump through history publishes once, not once per page of offscreen messages.
            const existing = store.session.message[sessionID] ?? []
            const ids = new Set(existing.map((item) => item.id))
            const messages = [...fetched.reverse().filter((item) => !ids.has(item.id)), ...existing]
            batch(() => {
              options?.beforePublish?.()
              messageIndex.set(sessionID, new Map(messages.map((item, position) => [item.id, position])))
              setStore("session", "message", sessionID, reconcile(messages))
              setStore("session", "messageCursor", sessionID, next)
            })
            return true
          })()
            .catch((error) => {
              if (!signal?.aborted) throw error
            })
            .finally(() => setStore("session", "messageLoading", sessionID, false))
          track(messageLoads, sessionID, request)
          await request
        },
        invalidate(sessionID: string) {
          sync.invalidate(`session.message:${sessionID}`)
        },
      },
      permission: {
        list(sessionID: string) {
          return store.session.permission[sessionID]
        },
        sync(sessionID: string) {
          return sync.run(`session.permission:${sessionID}`, async () => {
            setStore("session", "permission", sessionID, await api().permission.list({ sessionID }))
          })
        },
        invalidate(sessionID: string) {
          sync.invalidate(`session.permission:${sessionID}`)
        },
        async reply(input: PermissionReplyInput) {
          await api()
            .permission.reply(input)
            .catch((error: unknown) => {
              if (!isPermissionNotFoundError(error)) throw error
            })
          removePermission(input.sessionID, input.requestID)
        },
      },
      form: {
        list(sessionID: string, ref?: LocationRef) {
          const forms = store.session.form[sessionID]
          if (sessionID !== "global") return forms
          if (!ref) return
          const key = locationKey(ref)
          return forms?.filter((form) => form.location && locationKey(form.location) === key)
        },
        sync(sessionID: string, ref?: LocationRef) {
          const key = `session.form:${sessionID}:${sessionID === "global" ? locationKey(ref ?? defaultLocation()) : ""}`
          return sync.run(key, async () => {
            if (sessionID === "global") {
              const response = await api().form.request.list({
                location: locationQuery(ref ?? defaultLocation()),
              })
              const location = {
                directory: response.location.directory,
                workspaceID: response.location.workspaceID,
              }
              const locationID = locationKey(location)
              setStore("session", "form", sessionID, [
                ...(store.session.form[sessionID] ?? []).filter(
                  (form) => form.location && locationKey(form.location) !== locationID,
                ),
                ...response.data.filter((form) => form.sessionID === "global").map((form) => ({ ...form, location })),
              ])
              return
            }
            setStore("session", "form", sessionID, await api().form.list({ sessionID }))
          })
        },
        invalidate(sessionID: string, ref?: LocationRef) {
          sync.invalidate(
            `session.form:${sessionID}:${sessionID === "global" ? locationKey(ref ?? defaultLocation()) : ""}`,
          )
        },
        reply(input: FormReplyInput, ref?: LocationRef) {
          return settleForm(input, ref, api().form.reply(input, formRequestOptions(input.sessionID, ref)))
        },
        cancel(input: FormCancelInput, ref?: LocationRef) {
          return settleForm(input, ref, api().form.cancel(input, formRequestOptions(input.sessionID, ref)))
        },
      },
    },
    project: {
      list() {
        return Object.values(store.project.info).toSorted((a, b) => b.time.updated - a.time.updated)
      },
      get(projectID: string) {
        return store.project.info[projectID]
      },
      sync() {
        return sync.run("project", async () => {
          const projects = await api().project.list()
          setStore("project", "info", reconcile(Object.fromEntries(projects.map((project) => [project.id, project]))))
        })
      },
      invalidate() {
        sync.invalidate("project")
      },
      permission: {
        list(projectID: string) {
          return store.project.permission[projectID]
        },
        sync(projectID: string) {
          return sync.run(`project.permission:${projectID}`, async () => {
            setStore("project", "permission", projectID, await api().permission.saved.list({ projectID }))
          })
        },
        invalidate(projectID: string) {
          sync.invalidate(`project.permission:${projectID}`)
        },
      },
    },
    shell: {
      list(location?: LocationRef) {
        return Object.values(shells.list(location) ?? {})
      },
      listBySession(sessionID: string) {
        return Object.values(store.location)
          .flatMap((data) => Object.values(data.shell ?? {}))
          .filter((shell) => shell.metadata.sessionID === sessionID)
      },
      get(id: string) {
        return Object.values(store.location)
          .map((data) => data.shell?.[id])
          .find((shell) => shell !== undefined)
      },
      sync: shells.sync,
      invalidate: shells.invalidate,
    },
    location: {
      info(ref?: LocationRef) {
        return store.location[locationKey(ref ?? defaultLocation())]?.info
      },
      default() {
        return defaultLocation()
      },
      syncInfo(ref?: LocationRef) {
        const current = ref ?? defaultLocation()
        return sync.run(`location:${locationKey(current)}`, async () => {
          const location = await api().location.get({ location: locationQuery(current) })
          const key = locationKey(location)
          if (!store.location[key]) setStore("location", key, {})
          setStore("location", key, "info", location)
          if (!ref) {
            setDefaultLocation({ directory: location.directory, workspaceID: location.workspaceID })
          }
        })
      },
      async sync(ref?: LocationRef) {
        await result.location.syncInfo(ref)
        const location = ref ?? defaultLocation()
        await Promise.all([
          result.location.vcs.sync(location),
          result.location.agent.sync(location),
          result.location.command.sync(location),
          result.location.integration.sync(location),
          result.location.mcp.server.sync(location),
          result.location.mcp.resource.sync(location),
          result.location.model.sync(location),
          result.location.provider.sync(location),
          result.location.reference.sync(location),
          result.location.skill.sync(location),
          result.shell.sync(location),
          result.session.form.sync("global", location),
        ])
      },
      invalidate(ref?: LocationRef) {
        const location = ref ?? defaultLocation()
        sync.invalidate(`location:${locationKey(location)}`)
        result.location.vcs.invalidate(location)
        result.location.agent.invalidate(location)
        result.location.command.invalidate(location)
        result.location.config.invalidate(location)
        result.location.integration.invalidate(location)
        result.location.mcp.server.invalidate(location)
        result.location.mcp.resource.invalidate(location)
        result.location.model.invalidate(location)
        result.location.provider.invalidate(location)
        result.location.reference.invalidate(location)
        result.location.skill.invalidate(location)
        result.shell.invalidate(location)
        result.session.form.invalidate("global", location)
      },
      vcs: { info: vcs.list, sync: vcs.sync, invalidate: vcs.invalidate },
      agent: locationResource("agent", (location) => api().agent.list({ location })),
      command: locationResource("command", (location) => api().command.list({ location })),
      config: locationResource("config", async (location) => ({
        location: { directory: location.directory, workspaceID: location.workspace },
        data: await api().config.get({ location }),
      })),
      integration: locationResource("integration", (location) => api().integration.list({ location })),
      mcp: {
        server: locationResource("mcpServer", (location) => api().mcp.list({ location })),
        resource: locationResource("mcpResource", async (location) => {
          const response = await api().mcp.resource.catalog({ location })
          return { location: response.location, data: response.data.resources }
        }),
      },
      model: locationResource("model", (location) => api().model.list({ location }), { alias: true }),
      provider: locationResource("provider", (location) => api().provider.list({ location }), { alias: true }),
      reference: locationResource("reference", (location) => api().reference.list({ location })),
      websearch: {
        list(location?: LocationRef) {
          return store.location[locationKey(location ?? defaultLocation())]?.websearch
        },
        async refresh(ref?: LocationRef) {
          const input = { location: locationQuery(ref ?? defaultLocation()) }
          const providers = await api().websearch.providers(input)
          const key = locationKey(providers.location)
          setStore("location", key, { websearch: providers.data })
        },
      },
      skill: locationResource("skill", (location) => api().skill.list({ location })),
    },
  }

  createEffect(() => {
    if (config.connection?.status() === "connected") return
    sync.invalidate()
  })

  onCleanup(
    config.event.listen(({ details }) => {
      handleEvent(details)
    }),
  )

  return result
}

export type Data = ReturnType<typeof createData>
