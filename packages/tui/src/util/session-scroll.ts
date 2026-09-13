import type { ScrollBoxRenderable } from "@opentui/core"
import { scrollToMessageID } from "./scroll"

type Target = { sessionID: string; scroll: ScrollBoxRenderable }

let target: Target | undefined

export const sessionScroll = {
  attach(sessionID: string, scroll: ScrollBoxRenderable) {
    target = { sessionID, scroll }
    return () => {
      if (target?.sessionID === sessionID) target = undefined
    }
  },
  scrollToMessage(messageID: string): boolean {
    const current = target
    if (!current) return false
    return scrollToMessageID(current.scroll, messageID)
  },
  scrollToBottom(): boolean {
    const current = target
    if (!current || current.scroll.isDestroyed) return false
    current.scroll.scrollTo(current.scroll.scrollHeight)
    return true
  },
}
