import {
  AssistantMessage,
  type SnapshotFileDiff,
  Message as MessageType,
  Part as PartType,
} from "@opencode-ai/sdk/v2/client"
import type { FileDiffInfo } from "@opencode-ai/client/promise"
import type { SessionStatus } from "@opencode-ai/sdk/v2"
import { useData } from "../context"
import { useFileComponent } from "@opencode-ai/ui/context/file"

import { Binary } from "@opencode-ai/core/util/binary"
import { getDirectory, getFilename } from "@opencode-ai/core/util/path"
import { createEffect, createMemo, createSignal, For, on, ParentProps, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { Dynamic } from "solid-js/web"
import { AssistantParts, Message, MessageDivider, PART_MAPPING, type UserActions } from "./message-part"
import { Card } from "@opencode-ai/ui/card"
import { Button } from "@opencode-ai/ui/button"
import { Accordion } from "@opencode-ai/ui/accordion"
import { StickyAccordionHeader } from "@opencode-ai/ui/sticky-accordion-header"
import { DiffChanges } from "@opencode-ai/ui/diff-changes"
import { Icon } from "@opencode-ai/ui/icon"
import { TextShimmer } from "@opencode-ai/ui/text-shimmer"
import { SessionRetry } from "./session-retry"
import { TextReveal } from "@opencode-ai/ui/text-reveal"
import { Spinner } from "@opencode-ai/ui/spinner"
import { createAutoScroll } from "@opencode-ai/ui/hooks"
import { useI18n } from "@opencode-ai/ui/context/i18n"
import { expandMessageDiff, normalize, resolveMessageDiff } from "./session-diff"

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function unwrap(message: string) {
  const text = message.replace(/^Error:\s*/, "").trim()

  const parse = (value: string) => {
    try {
      return JSON.parse(value) as unknown
    } catch {
      return undefined
    }
  }

  const read = (value: string) => {
    const first = parse(value)
    if (typeof first !== "string") return first
    return parse(first.trim())
  }

  let json = read(text)

  if (json === undefined) {
    const start = text.indexOf("{")
    const end = text.lastIndexOf("}")
    if (start !== -1 && end > start) {
      json = read(text.slice(start, end + 1))
    }
  }

  if (!record(json)) return message

  const err = record(json.error) ? json.error : undefined
  if (err) {
    const type = typeof err.type === "string" ? err.type : undefined
    const msg = typeof err.message === "string" ? err.message : undefined
    if (type && msg) return `${type}: ${msg}`
    if (msg) return msg
    if (type) return type
    const code = typeof err.code === "string" ? err.code : undefined
    if (code) return code
  }

  const msg = typeof json.message === "string" ? json.message : undefined
  if (msg) return msg

  const reason = typeof json.error === "string" ? json.error : undefined
  if (reason) return reason

  return message
}

function same<T>(a: readonly T[], b: readonly T[]) {
  if (a === b) return true
  if (a.length !== b.length) return false
  return a.every((x, i) => x === b[i])
}

function list<T>(value: T[] | undefined | null, fallback: T[]) {
  if (Array.isArray(value)) return value
  return fallback
}

type SummaryDiff = (SnapshotFileDiff & { file: string }) | FileDiffInfo

function summaryDiff(value: SnapshotFileDiff): value is SummaryDiff {
  return typeof value.file === "string"
}

const hidden = new Set(["todowrite"])

function partState(part: PartType, showReasoningSummaries: boolean) {
  if (part.type === "tool") {
    if (hidden.has(part.tool)) return
    if (part.tool === "question" && (part.state.status === "pending" || part.state.status === "running")) return
    return "visible" as const
  }
  if (part.type === "text") return part.text?.trim() ? ("visible" as const) : undefined
  if (part.type === "reasoning") {
    if (showReasoningSummaries && part.text?.trim()) return "visible" as const
    return
  }
  if (PART_MAPPING[part.type]) return "visible" as const
  return
}

function clean(value: string) {
  return value
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*_~]+/g, "")
    .trim()
}

function heading(text: string) {
  const markdown = text.replace(/\r\n?/g, "\n")

  const html = markdown.match(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/i)
  if (html?.[1]) {
    const value = clean(html[1].replace(/<[^>]+>/g, " "))
    if (value) return value
  }

  const atx = markdown.match(/^\s{0,3}#{1,6}[ \t]+(.+?)(?:[ \t]+#+[ \t]*)?$/m)
  if (atx?.[1]) {
    const value = clean(atx[1])
    if (value) return value
  }

  const setext = markdown.match(/^([^\n]+)\n(?:=+|-+)\s*$/m)
  if (setext?.[1]) {
    const value = clean(setext[1])
    if (value) return value
  }

  const strong = markdown.match(/^\s*(?:\*\*|__)(.+?)(?:\*\*|__)\s*$/m)
  if (strong?.[1]) {
    const value = clean(strong[1])
    if (value) return value
  }
}

export function SessionTurn(
  props: ParentProps<{
    sessionID: string
    messageID: string
    messages?: MessageType[]
    actions?: UserActions
    showReasoningSummaries?: boolean
    shellToolDefaultOpen?: boolean
    editToolDefaultOpen?: boolean
    active?: boolean
    status?: SessionStatus
    onUserInteracted?: () => void
    classes?: {
      root?: string
      content?: string
      container?: string
    }
  }>,
) {
  const data = useData()
  const i18n = useI18n()
  const fileComponent = useFileComponent()

  const emptyMessages: MessageType[] = []
  const emptyParts: PartType[] = []
  const emptyAssistant: AssistantMessage[] = []
  const emptyDiffs: SummaryDiff[] = []
  const idle = { type: "idle" as const }

  const allMessages = createMemo(() => props.messages ?? list(data.store.message?.[props.sessionID], emptyMessages))

  const messageIndex = createMemo(() => {
    const messages = allMessages() ?? emptyMessages
    const result = Binary.search(messages, props.messageID, (m) => m.id)

    const index = result.found ? result.index : messages.findIndex((m) => m.id === props.messageID)
    if (index < 0) return -1

    const msg = messages[index]
    if (!msg || msg.role !== "user") return -1

    return index
  })

  const message = createMemo(() => {
    const index = messageIndex()
    if (index < 0) return undefined

    const messages = allMessages() ?? emptyMessages
    const msg = messages[index]
    if (!msg || msg.role !== "user") return undefined

    return msg
  })

  const pending = createMemo(() => {
    if (typeof props.active === "boolean") return
    const messages = allMessages() ?? emptyMessages
    return messages.findLast(
      (item): item is AssistantMessage => item.role === "assistant" && typeof item.time.completed !== "number",
    )
  })

  const pendingUser = createMemo(() => {
    const item = pending()
    if (!item?.parentID) return
    const messages = allMessages() ?? emptyMessages
    const result = Binary.search(messages, item.parentID, (m) => m.id)
    const msg = result.found ? messages[result.index] : messages.find((m) => m.id === item.parentID)
    if (!msg || msg.role !== "user") return
    return msg
  })

  const active = createMemo(() => {
    if (typeof props.active === "boolean") return props.active
    const msg = message()
    const parent = pendingUser()
    if (!msg || !parent) return false
    return parent.id === msg.id
  })

  const parts = createMemo(() => {
    const msg = message()
    if (!msg) return emptyParts
    return list(data.store.part?.[msg.id], emptyParts)
  })

  const compaction = createMemo(() => parts().find((part) => part.type === "compaction"))

  const diffs = createMemo(() => {
    const files = message()?.summary?.diffs
    if (!files?.length) return emptyDiffs

    const seen = new Set<string>()
    return files
      .reduceRight<SummaryDiff[]>((result, diff) => {
        if (!summaryDiff(diff)) return result
        if (seen.has(diff.file)) return result
        seen.add(diff.file)
        result.push(diff)
        return result
      }, [])
      .reverse()
  })
  const MAX_FILES = 10
  const edited = createMemo(() => diffs().length)
  const [state, setState] = createStore({
    showAll: false,
    expanded: [] as string[],
  })
  const showAll = () => state.showAll
  const expanded = () => state.expanded
  const overflow = createMemo(() => Math.max(0, edited() - MAX_FILES))
  const visible = createMemo(() => (showAll() ? diffs() : diffs().slice(0, MAX_FILES)))
  const toggleAll = () => {
    autoScroll.pause()
    setState("showAll", !showAll())
  }

  const assistantMessages = createMemo(
    () => {
      const msg = message()
      if (!msg) return emptyAssistant

      const messages = allMessages() ?? emptyMessages
      if (messageIndex() < 0) return emptyAssistant

      const result: AssistantMessage[] = []
      for (let i = 0; i < messages.length; i++) {
        const item = messages[i]
        if (!item) continue
        if (item.role === "assistant" && item.parentID === msg.id) result.push(item as AssistantMessage)
      }
      return result
    },
    emptyAssistant,
    { equals: same },
  )

  const interrupted = createMemo(() => assistantMessages().some((m) => m.error?.name === "MessageAbortedError"))
  const divider = createMemo(() => {
    if (compaction()) return i18n.t("ui.messagePart.compaction")
    if (interrupted()) return i18n.t("ui.message.interrupted")
    return ""
  })
  const error = createMemo(
    () => assistantMessages().find((m) => m.error && m.error.name !== "MessageAbortedError")?.error,
  )
  const showAssistantCopyPartID = createMemo(() => {
    const messages = assistantMessages()

    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i]
      if (!message) continue

      const parts = list(data.store.part?.[message.id], emptyParts)
      for (let j = parts.length - 1; j >= 0; j--) {
        const part = parts[j]
        if (!part || part.type !== "text" || !part.text?.trim()) continue
        return part.id
      }
    }

    return undefined
  })
  const errorText = createMemo(() => {
    const msg = error()?.data?.message
    if (typeof msg === "string") return unwrap(msg)
    if (msg === undefined || msg === null) return ""
    // oxlint-disable-next-line no-base-to-string -- msg is unknown from error data, coercion is intentional
    return unwrap(String(msg))
  })

  const status = createMemo(() => {
    if (props.status !== undefined) return props.status
    if (typeof props.active === "boolean" && !props.active) return idle
    return data.store.session_status[props.sessionID] ?? idle
  })
  const working = createMemo(() => status().type !== "idle" && active())
  const showReasoningSummaries = createMemo(() => props.showReasoningSummaries ?? true)

  const assistantCopyPartID = createMemo(() => {
    if (working()) return null
    return showAssistantCopyPartID() ?? null
  })
  const turnDurationMs = createMemo(() => {
    const start = message()?.time.created
    if (typeof start !== "number") return undefined

    const end = assistantMessages().reduce<number | undefined>((max, item) => {
      const completed = item.time.completed
      if (typeof completed !== "number") return max
      if (max === undefined) return completed
      return Math.max(max, completed)
    }, undefined)

    if (typeof end !== "number") return undefined
    if (end < start) return undefined
    return end - start
  })
  const assistantDerived = createMemo(() => {
    let visible = 0
    let reason: string | undefined
    const show = showReasoningSummaries()
    for (const message of assistantMessages()) {
      for (const part of list(data.store.part?.[message.id], emptyParts)) {
        if (partState(part, show) === "visible") {
          visible++
        }
        if (part.type === "reasoning" && part.text) {
          const h = heading(part.text)
          if (h) reason = h
        }
      }
    }
    return { visible, reason }
  })
  const assistantVisible = createMemo(() => assistantDerived().visible)
  const reasoningHeading = createMemo(() => assistantDerived().reason)
  const showThinking = createMemo(() => {
    if (!working() || !!error()) return false
    if (status().type === "retry") return false
    if (showReasoningSummaries()) return assistantVisible() === 0
    return true
  })

  const autoScroll = createAutoScroll({
    working,
    onUserInteracted: props.onUserInteracted,
    overflowAnchor: "dynamic",
  })

  return (
    <div data-component="session-turn" class={props.classes?.root}>
      <div
        ref={autoScroll.scrollRef}
        onScroll={autoScroll.handleScroll}
        data-slot="session-turn-content"
        class={props.classes?.content}
      >
        <div onClick={autoScroll.handleInteraction}>
          <Show when={message()}>
            <div
              ref={autoScroll.contentRef}
              data-message={message()!.id}
              data-slot="session-turn-message-container"
              class={props.classes?.container}
            >
              <div data-slot="session-turn-message-content" aria-live="off">
                <Message message={message()!} parts={parts()} actions={props.actions} />
              </div>
              <Show when={divider()}>
                <div data-slot="session-turn-compaction">
                  <MessageDivider label={divider()} />
                </div>
              </Show>
              <Show when={assistantMessages().length > 0}>
                <div data-slot="session-turn-assistant-content" aria-hidden={working()}>
                  <AssistantParts
                    messages={assistantMessages()}
                    showAssistantCopyPartID={assistantCopyPartID()}
                    turnDurationMs={turnDurationMs()}
                    working={working()}
                    showReasoningSummaries={showReasoningSummaries()}
                    shellToolDefaultOpen={props.shellToolDefaultOpen}
                    editToolDefaultOpen={props.editToolDefaultOpen}
                  />
                </div>
              </Show>
              <Show when={showThinking()}>
                <div data-slot="session-turn-thinking">
                  <TextShimmer text={i18n.t("ui.sessionTurn.status.thinking")} />
                  <Show when={!showReasoningSummaries()}>
                    <TextReveal
                      text={reasoningHeading()}
                      class="session-turn-thinking-heading"
                      travel={25}
                      duration={700}
                    />
                  </Show>
                </div>
              </Show>
              <SessionRetry status={status()} show={active()} />
              <Show when={edited() > 0 && !working()}>
                <div
                  data-slot="session-turn-diffs"
                  data-component="session-turn-diffs-group"
                  data-show-all={showAll() || undefined}
                >
                  <div data-slot="session-turn-diffs-header">
                    <span data-slot="session-turn-diffs-label">
                      {i18n.plural("ui.sessionTurn.diffs.changed", edited())}
                    </span>
                    <DiffChanges changes={diffs()} />
                    <Show when={overflow() > 0}>
                      <span data-slot="session-turn-diffs-toggle" onClick={toggleAll}>
                        {showAll() ? i18n.t("ui.sessionTurn.diffs.showLess") : i18n.t("ui.sessionTurn.diffs.showAll")}
                      </span>
                    </Show>
                  </div>
                  <div data-component="session-turn-diffs-content">
                    <Accordion
                      multiple
                      style={{ "--sticky-accordion-offset": "44px" }}
                      value={expanded()}
                      onChange={(value) => {
                        const next = Array.isArray(value) ? value : value ? [value] : []
                        setState("expanded", next)
                        for (const diff of visible()) {
                          if (!next.includes(diff.file)) continue
                          void expandMessageDiff({
                            diff,
                            cache: data.store.message_diff[props.messageID],
                            sessionID: props.sessionID,
                            messageID: props.messageID,
                            fetch: data.fetchMessageDiff,
                          })
                        }
                      }}
                    >
                      <For each={visible()}>
                        {(diff) => {
                          const source = createMemo(() =>
                            resolveMessageDiff(diff, data.store.message_diff[props.messageID]),
                          )
                          const view = createMemo(() => normalize(source()))
                          const loaded = createMemo(() => typeof source().patch === "string")
                          const diffState = createMemo(
                            () => data.store.message_diff_status?.[props.messageID] ?? "absent",
                          )
                          const active = createMemo(() => expanded().includes(diff.file))
                          const [shown, setShown] = createSignal(false)

                          createEffect(
                            on(
                              active,
                              (value) => {
                                if (!value) {
                                  setShown(false)
                                  return
                                }

                                requestAnimationFrame(() => {
                                  if (!active()) return
                                  setShown(true)
                                })
                              },
                              { defer: true },
                            ),
                          )

                          return (
                            <Accordion.Item value={diff.file}>
                              <StickyAccordionHeader>
                                <Accordion.Trigger>
                                  <div data-slot="session-turn-diff-trigger">
                                    <span data-slot="session-turn-diff-path">
                                      <Show when={diff.file.includes("/")}>
                                        <span data-slot="session-turn-diff-directory">
                                          {`\u202A${getDirectory(diff.file)}\u202C`}
                                        </span>
                                      </Show>
                                      <span data-slot="session-turn-diff-filename">{getFilename(diff.file)}</span>
                                    </span>
                                    <div data-slot="session-turn-diff-meta">
                                      <span data-slot="session-turn-diff-changes">
                                        <DiffChanges changes={diff} />
                                      </span>
                                      <span data-slot="session-turn-diff-chevron">
                                        <Icon name="chevron-down" size="small" />
                                      </span>
                                    </div>
                                  </div>
                                </Accordion.Trigger>
                              </StickyAccordionHeader>
                              <Accordion.Content>
                                <Show when={shown() && loaded()}>
                                  <div data-slot="session-turn-diff-view" data-scrollable>
                                    <Dynamic component={fileComponent} mode="diff" fileDiff={view().fileDiff} />
                                  </div>
                                </Show>
                                <Show when={shown() && !loaded() && diffState() === "pending"}>
                                  <div data-slot="session-turn-diff-loading" class="flex items-center gap-2">
                                    <Spinner class="size-4" />
                                    <span>
                                      {i18n.t("ui.fileMedia.state.loading", {
                                        kind: i18n.t("ui.fileMedia.kind.diff"),
                                      })}
                                    </span>
                                  </div>
                                </Show>
                                <Show when={shown() && !loaded() && diffState() === "failed"}>
                                  <Card variant="error" class="error-card" data-slot="session-turn-diff-error">
                                    <div class="flex items-center gap-2">
                                      <span>
                                        {i18n.t("ui.fileMedia.state.error", {
                                          kind: i18n.t("ui.fileMedia.kind.diff"),
                                        })}
                                      </span>
                                      <Button
                                        size="small"
                                        onClick={() => void data.fetchMessageDiff?.(props.sessionID, props.messageID)}
                                      >
                                        {i18n.t("ui.common.retry")}
                                      </Button>
                                    </div>
                                  </Card>
                                </Show>
                                <Show when={shown() && !loaded() && diffState() === "absent"}>
                                  <div data-slot="session-turn-diff-unavailable">
                                    {i18n.t("ui.fileMedia.state.unavailable", {
                                      kind: i18n.t("ui.fileMedia.kind.diff"),
                                    })}
                                  </div>
                                </Show>
                              </Accordion.Content>
                            </Accordion.Item>
                          )
                        }}
                      </For>
                    </Accordion>
                    <Show when={!showAll() && overflow() > 0}>
                      <div data-slot="session-turn-diffs-more" onClick={toggleAll}>
                        {i18n.t("ui.sessionTurn.diffs.more", { count: String(overflow()) })}
                      </div>
                    </Show>
                  </div>
                </div>
              </Show>
              <Show when={error()}>
                <Card variant="error" class="error-card">
                  {errorText()}
                </Card>
              </Show>
            </div>
          </Show>
          {props.children}
        </div>
      </div>
    </div>
  )
}
