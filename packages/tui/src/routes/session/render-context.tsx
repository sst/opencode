import { createContext, useContext } from "solid-js"
import type { ModelInfo } from "@opencode/client"
import type { SessionInbox } from "@opencode/schema/session-inbox"
import type { useConfig } from "../../config"
import type { ThinkingMode } from "../../context/thinking"

export type PendingAction = "steer" | "queue" | "cancel"

export const context = createContext<{
  /** Content width: terminal width minus vertical tabs, sidebar, and padding. */
  width: number
  /**
   * Shared reactive terminal size. Transcript-row components must read this
   * instead of calling useTerminalDimensions(), which registers one renderer
   * resize listener per mounted component and grows with transcript length.
   */
  terminal: { width: number; height: number }
  sessionID: string
  thinkingMode: () => ThinkingMode
  markdownMode: () => "source" | "rendered"
  groupExploration: () => boolean
  diffWrapMode: () => "word" | "none"
  models: () => ModelInfo[]
  messageIndex: (messageID: string) => number | undefined
  config: ReturnType<typeof useConfig>["data"]
  mutatePending: (action: PendingAction, inboxID: string) => Promise<boolean>
  pendingDelivery: (inboxID: string) => SessionInbox.Delivery | undefined
}>()

export function use() {
  const ctx = useContext(context)
  if (!ctx) throw new Error("useContext must be used within a Session component")
  return ctx
}
