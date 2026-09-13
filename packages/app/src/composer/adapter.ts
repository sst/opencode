import type { Data } from "@opencode/client/solid"
import type { SessionMessageUser } from "@opencode/client/promise"
import type { Accessor } from "solid-js"
import type { ModelSelection } from "@/providers/models/selection"
import type { ServerSDK } from "@/runtime/server/client"
import type { ComposerStateTarget } from "./submission-state"
import type { createComposerSubmission } from "./submission-state"

export type ComposerControls = {
  agents: {
    available: { name: string; hidden?: boolean; mode: string }[]
    options: string[]
    current: string
    visible: boolean
    select: (name: string | undefined) => void
  }
  model: {
    selection: ModelSelection
    paid: boolean
    loading: boolean
  }
  session: {
    tabs: {
      active: () => string | undefined
      all: () => string[]
      open: (tab: string) => void | Promise<void>
      setActive: (tab: string) => void
    }
    reviewPanel: {
      opened: () => boolean
      open: () => void
    }
  }
}

export type ComposerSelection = {
  agent: string
  model: { providerID: string; modelID: string }
  variant?: string
}

export type ComposerDelivery = "steer" | "queue"

// Contract between the composer and the session prompt queue. The session
// owns the queue (pending inbox items); the composer only asks which delivery
// a submit should use and delegates edit confirmation while a queued prompt
// is loaded in the editor.
export type ComposerQueue = {
  count: Accessor<number>
  // Delivery a plain submit uses right now.
  delivery: Accessor<ComposerDelivery>
  // Delivery offered on Mod+Enter and the toolbar hint button; undefined hides the hint.
  alternate: Accessor<ComposerDelivery | undefined>
  // Inbox ID of the queued prompt currently loaded in the composer for editing.
  editing: Accessor<string | undefined>
  confirmEdit: (delivery: ComposerDelivery) => void
  cancelEdit: () => void
  // Loads the first queued prompt into the composer. Returns false when the queue is empty.
  editFirst: () => boolean
}

export type ComposerSession = {
  id: string
  directory: string
  handoff?: {
    set: (message: SessionMessageUser) => void
    clear: (messageID: string) => void
  }
  api: {
    command: (input: Parameters<ServerSDK["api"]["session"]["command"]>[0]) => Promise<unknown>
    shell: (input: Parameters<ServerSDK["api"]["session"]["shell"]>[0]) => Promise<unknown>
    switchAgent: (input: Parameters<ServerSDK["api"]["session"]["switchAgent"]>[0]) => Promise<unknown>
    switchModel: (input: Parameters<ServerSDK["api"]["session"]["switchModel"]>[0]) => Promise<unknown>
  }
  data: {
    location: { command: Pick<Data["location"]["command"], "list"> }
    session: {
      prompt: (input: Parameters<Data["session"]["prompt"]>[0]) => Promise<unknown>
      setStatus: Data["session"]["setStatus"]
    }
  }
  current: Accessor<{ agent?: string; model?: { id: string; providerID: string; variant?: string } } | undefined>
  admitted: (messageID: string) => boolean
}

type ComposerAdapterBase = {
  state: ComposerStateTarget
  ready: Accessor<boolean>
  controls: Accessor<ComposerControls>
  working: Accessor<boolean>
  submitted: () => void
}

export type ActiveComposerAdapter = ComposerAdapterBase & {
  kind: "active-session"
  session: () => ComposerSession
  interrupt: (options?: { continue?: boolean }) => Promise<void>
  setEditor: (element: HTMLDivElement) => void
}

export type NewSessionComposerAdapter = ComposerAdapterBase & {
  kind: "new-session"
  start: (
    selection: ComposerSelection,
    submission: ReturnType<typeof createComposerSubmission>,
    message: SessionMessageUser,
  ) => Promise<{ session: ComposerSession; cleanupReady: Promise<void>; complete?: () => Promise<void> } | undefined>
}

export type ComposerAdapter = ActiveComposerAdapter | NewSessionComposerAdapter
