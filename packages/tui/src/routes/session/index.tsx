import {
  batch,
  createEffect,
  createMemo,
  createSignal,
  For,
  Index,
  Match,
  on,
  onCleanup,
  onMount,
  Show,
  Switch,
  type Accessor,
} from "solid-js"
import path from "node:path"
import { EOL, tmpdir } from "node:os"
import { mkdir, writeFile } from "node:fs/promises"
import { useRoute, useRouteData } from "../../context/route"
import { createStore } from "solid-js/store"
import { useData } from "../../context/data"
import { SplitBorder } from "../../ui/border"
import { useTuiPaths, useTuiTerminalEnvironment } from "../../context/runtime"
import { Spinner, SPINNER_FRAMES } from "../../component/spinner"
import { PatchDiff } from "../../component/patch-diff"
import { createSyntaxStyleMemo, ThemeContextProvider, useTheme, useThemes } from "../../context/theme"
import { BoxRenderable, ScrollBoxRenderable, addDefaultParsers, TextAttributes, RGBA, MouseEvent } from "@opentui/core"
import { Prompt, type PromptRef } from "../../component/prompt"
import type {
  SessionMessageInfo,
  SessionMessageAssistant,
  SessionMessageAssistantReasoning,
  SessionMessageAssistantText,
  SessionMessageAssistantTool,
  SessionMessageUser,
  SessionInfo,
} from "@opencode/client"
import { useLocal } from "../../context/local"
import { Locale } from "../../util/locale"
import { FilePath } from "../../ui/file-path"
import {
  canonicalToolName,
  finiteNumber,
  primitiveInputSummary,
  toolDisplayContent,
  toolDisplayMetadata,
} from "../../util/tool-display"
import { RetryProvider } from "../../component/retry-provider"
import { useRenderer, useTerminalDimensions, type JSX } from "@opentui/solid"
import { useClient } from "../../context/client"
import { useEditorContext } from "../../context/editor"
import { openEditor } from "../../editor"
import { useDialog } from "../../ui/dialog"
import { DialogSelect } from "../../ui/dialog-select"
import { DialogSessionRename } from "../../component/dialog-session-rename"
import { DialogImagePreview } from "../../component/dialog-image-preview"
import { DialogMessage } from "./dialog-message"
import { DialogFork } from "./dialog-fork"
import { DialogTimeline } from "./dialog-timeline"
import { Composer } from "./composer"
import { filetype } from "../../util/filetype"
import parsers from "../../parsers-config"
import { errorMessage } from "../../util/error"
import { useToast } from "../../ui/toast"
import stripAnsi from "strip-ansi"
import { usePromptRef } from "../../context/prompt"
import { projectedPromptInput } from "../../prompt/codec"
import { deduplicateVisibleImages } from "../../prompt/attachment"
import { useEpilogue } from "../../context/epilogue"
import { normalizePath } from "../../util/path"
import { PermissionPrompt } from "./permission"
import { FormPrompt } from "./form"
import { DialogExportOptions } from "../../ui/dialog-export-options"
import { DialogExportResult } from "../../ui/dialog-export-result"
import { sessionEpilogue } from "../../util/presentation"
import { useConfig } from "../../config"
import { useClipboard } from "../../context/clipboard"
import { nextThinkingMode, reasoningSummary, type ThinkingMode } from "../../context/thinking"
import { getScrollAcceleration } from "../../util/scroll"
import { collapseToolOutput } from "../../util/collapse-tool-output"
import { Keymap, type KeymapCommand } from "../../context/keymap"
import { usePathFormatter } from "../../context/path-format"
import { useLocation } from "../../context/location"
import { Slot } from "../../plugin/render"
import { usePlugin } from "../../plugin/context"
import {
  cacheReuseDrop,
  createSessionRows,
  messageBoundaryIDs,
  resolvePart,
  sessionRowID,
  turnDuration,
  turnTokensPerSecond,
  type CacheUsage,
  type PartRef,
  type SessionRow,
} from "./rows"
import { switchLabel } from "../../util/model"
import { findMessageBoundary, messageNavigationSlack } from "./message-navigation"
import { stringWidth } from "../../util/string-width"
import { useArgs } from "../../context/args"
import { withTimestampedFallback } from "@opencode/util/session-title-fallback"
import { useSessionTabs } from "../../context/session-tabs"
import { createSingleFlight } from "../../util/single-flight"
import type { SessionInbox } from "@opencode/schema/session-inbox"
import { generateThinkingSyntax } from "./thinking-syntax"
import { createDelayedPresence } from "../../util/delayed-presence"
import { SessionLocationMissing } from "./location-missing"
import { isRecord } from "../../util/record"
import { createHistoryPrepend } from "./history"
import { context, use, type PendingAction } from "./render-context"
import { INLINE_TOOL_ICON_WIDTH, InlineToolRow, ReasoningPart, reasoningContent, TextPart } from "./message-parts"
import { groupRefs } from "./grouping/session"
export { InlineToolRow } from "./message-parts"

addDefaultParsers(parsers.parsers)

// Exclude temporary bottom space when measuring the real transcript height.
const NAVIGATION_SLACK_ID = "session-navigation-slack"
const BACKGROUND_TOOL_HINT_DELAY = 3_000

// The tail comfortably overfills a tall viewport; older rows mount as the reader approaches them.
const TRANSCRIPT_TAIL_ROWS = 40
const TRANSCRIPT_BACKFILL_CHUNK = 60

export function Session(props: {
  scrollRef?: (scroll: ScrollBoxRenderable | undefined) => void
  verticalTabsWidth: number
  promptMuted?: boolean
  sidebarVisible: boolean
  onToggleSidebar: () => void
  visibleTerminalID?: string
  onTerminalPicker?: (show: (() => void) | undefined) => void
  width?: number
}) {
  const setEpilogue = useEpilogue()
  const clipboard = useClipboard()
  const writeExport = async (file: string, content: string) => {
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, content)
  }
  const route = useRouteData("session")
  const sessionID = route.sessionID
  const { navigate } = useRoute()
  const data = useData()
  const local = useLocal()
  const args = useArgs()
  const paths = useTuiPaths()
  const configState = useConfig()
  const config = configState.data
  const theme = useTheme()
  const promptRef = usePromptRef()
  const session = createMemo(() => data.session.get(route.sessionID))
  const messages = () => data.session.message.list(route.sessionID)
  const messageIndexes = createMemo(() => new Map(messages().map((message, index) => [message.id, index])))
  const messagesBeforeRevert = () => {
    const messageID = session()?.revert?.messageID
    if (!messageID) return messages()
    const index = messages().findIndex((message) => message.id === messageID)
    return index === -1 ? messages() : messages().slice(0, index)
  }
  const messagesFromRevert = () => {
    const messageID = session()?.revert?.messageID
    if (!messageID) return []
    const index = messages().findIndex((message) => message.id === messageID)
    return index === -1 ? [] : messages().slice(index)
  }
  const currentLocation = useLocation()
  const location = createMemo(() => session()?.location ?? currentLocation.ref)

  createEffect(() => currentLocation.set(location()))

  createEffect(() => {
    const title = Locale.truncate(session()?.title ?? "", 50)
    setEpilogue(sessionEpilogue({ title, sessionID: session()?.id }))
  })
  onCleanup(() => setEpilogue())
  const descendantSessionIDs = createMemo(() => {
    if (session()?.parentID) return []
    return data.session.family(route.sessionID).filter((id) => id !== route.sessionID)
  })
  const permissions = createMemo(() => {
    if (session()?.parentID) return []
    return [route.sessionID, ...descendantSessionIDs()].flatMap(
      (sessionID) => data.session.permission.list(sessionID) ?? [],
    )
  })
  const promptedPermissions = createMemo(() => (local.permission.mode === "autoaccept" ? [] : permissions()))
  const forms = createMemo(() => {
    const global = data.session.form.list("global", location()) ?? []
    if (session()?.parentID) return global
    return [route.sessionID, ...descendantSessionIDs()]
      .flatMap((sessionID) => data.session.form.list(sessionID) ?? [])
      .concat(global)
  })
  const pendingUsers = createMemo(() =>
    data.session.pending.list(route.sessionID).flatMap((item) => (item.type === "user" ? [item] : [])),
  )
  const pendingDeliveries = createMemo(() => new Map(pendingUsers().map((item) => [item.id, item.delivery])))
  const queuedPrompts = createMemo(() =>
    pendingUsers().flatMap((item) => (item.delivery === "queue" ? [{ id: item.id, text: item.payload.text }] : [])),
  )
  const [composer, setComposer] = createStore({
    open: false,
    tab: undefined as string | undefined,
  })
  props.onTerminalPicker?.(() => setComposer({ open: true, tab: "terminals" }))
  onCleanup(() => props.onTerminalPicker?.(undefined))
  createEffect(() => {
    if (props.promptMuted && composer.open) setComposer("open", false)
  })
  const disabled = createMemo(() => promptedPermissions().length > 0 || forms().length > 0)

  const lastAssistant = createMemo(() => {
    return messages().findLast((x) => x.type === "assistant")
  })

  const dimensions = useTerminalDimensions()
  const thinkingMode = createMemo<ThinkingMode>(() => config.session?.thinking ?? "hide")
  const showScrollbar = createMemo(() => config.session?.scrollbar ?? false)
  const markdownMode = createMemo(() => config.session?.markdown ?? "rendered")
  const diffWrapMode = createMemo(() => config.diffs?.wrap ?? "word")
  const groupExploration = createMemo(() => config.session?.grouping !== "none")

  Keymap.createLayer(() => ({
    priority: 10,
    enabled: () => props.sidebarVisible && dimensions().width - props.verticalTabsWidth <= 120 && !disabled(),
    commands: [{ bind: "escape,ctrl+c", title: "Close sidebar", group: "Session", run: props.onToggleSidebar }],
  }))
  const contentWidth = createMemo(() => (props.width ?? dimensions().width - props.verticalTabsWidth) - 4)
  const models = createMemo(() => data.location.model.list(location()) ?? [])

  const scrollAcceleration = createMemo(() => getScrollAcceleration(config))
  const toast = useToast()
  const client = useClient()
  const autoApproved = new Set<string>()
  createEffect(() => {
    if (local.permission.mode !== "autoaccept") return
    permissions().forEach((request) => {
      if (autoApproved.has(request.id)) return
      autoApproved.add(request.id)
      void data.session.permission
        .reply({
          sessionID: request.sessionID,
          reply: "once",
          requestID: request.id,
        })
        .catch((error) => {
          autoApproved.delete(request.id)
          toast.error(error)
        })
    })
  })
  const editor = useEditorContext()
  const [rowsSynced, setRowsSynced] = createSignal(false)
  const rows = createSessionRows(
    () => route.sessionID,
    (id) => {
      if (id === sessionID) setRowsSynced(true)
    },
  )
  const boundaries = createMemo(() => messageBoundaryIDs(rows, messages()))
  const boundaryIDs = createMemo(() => new Set(boundaries().filter((id) => id !== undefined)))
  const [navigationMessage, setNavigationMessage] = createSignal<string>()
  const [navigationSlack, setNavigationSlack] = createSignal(0)
  const [firstJump, setFirstJump] = createSignal<() => void>()
  const [synced, setSynced] = createSignal(false)
  const sessionTabs = useSessionTabs()
  const [awayFromBottom, setAwayFromBottom] = createSignal(false)
  const [latestHovered, setLatestHovered] = createSignal(false)
  let ensureAllRowsPending: (() => void)[] | undefined
  createEffect(() => {
    if (!awayFromBottom()) setLatestHovered(false)
  })

  const clearMessageNavigation = () => {
    ensureAllRowsPending?.splice(0)
    prependHistory.cancel()
    firstJump()?.()
    setFirstJump(undefined)
    setNavigationSlack(0)
    setNavigationMessage(undefined)
  }

  createEffect(
    on(
      () => [dimensions().width, dimensions().height, props.verticalTabsWidth] as const,
      (_, previous) => {
        if (!previous) return
        clearMessageNavigation()
        if (scroll && !scroll.isDestroyed) updateAwayFromBottom()
      },
    ),
  )

  createEffect(
    on([descendantSessionIDs, () => client.connection.status()], ([sessionIDs, status]) => {
      if (status !== "connected") return
      void Promise.allSettled(
        sessionIDs.flatMap((sessionID) => [data.session.permission.sync(sessionID), data.session.form.sync(sessionID)]),
      )
    }),
  )

  createEffect(() => {
    if (client.connection.status() !== "connected") return
    setSynced(false)
    const sessionID = route.sessionID
    void (async () => {
      await Promise.all([
        data.session.sync(sessionID, { children: true }),
        data.session.permission.sync(sessionID).catch(() => undefined),
        data.session.form.sync(sessionID).catch(() => undefined),
      ])
      const info = data.session.get(sessionID)
      if (!info) {
        toast.show({
          message: `Session not found: ${sessionID}`,
          variant: "error",
          duration: 5000,
        })
        sessionTabs.enabled() ? sessionTabs.close(sessionID) : navigate({ type: "home" })
        return
      }
      editor.reconnect(info.location.directory)
      setSynced(true)
    })().catch((error) => {
      if (route.sessionID !== sessionID) return
      toast.show({
        message: errorMessage(error),
        variant: "error",
        duration: 5000,
      })
      sessionTabs.enabled() ? sessionTabs.close(sessionID) : navigate({ type: "home" })
    })
  })

  let seeded = false
  let sent = false
  let restored = false
  let scroll: ScrollBoxRenderable
  createEffect(() => {
    if (restored || !synced() || !rowsSynced() || !scroll || scroll.isDestroyed) return
    restored = true
    // Initial synchronization can finish after the reader has already navigated.
    if (!isAwayFromBottom()) restoreScrollPosition()
  })
  let awayTimer: ReturnType<typeof setTimeout> | undefined
  onCleanup(() => {
    if (awayTimer) clearTimeout(awayTimer)
    props.scrollRef?.(undefined)
    prependHistory.cancel()
    firstJump()?.()
    if (!scroll || scroll.isDestroyed) return
    scroll.verticalScrollBar.off("change", updateAwayFromBottom)
    saveScrollAnchor()
  })
  const [prompt, setPrompt] = createSignal<PromptRef>()
  const bind = (r: PromptRef | undefined) => {
    setPrompt(r)
    promptRef.set(r)
    if (seeded || !route.prompt || !r) return
    seeded = true
    r.set(route.prompt)
  }

  /** Runs after layout has settled (two frames), unless the transcript was torn down. */
  const afterLayout = (continuation: () => void) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (!scroll || scroll.isDestroyed) return
        continuation()
      })
    })
  }

  // Tail-first transcript mounting: only the newest rows mount when the session opens. Older rows
  // mount on demand near the top, keeping inactive tabs cheap to tear down. While the reader stays
  // at the bottom the hidden span follows appends; leaving the bottom pins it to preserve the viewport.
  const [hiddenRows, setHiddenRows] = createSignal<number>()
  const [visibleRowsEnd, setVisibleRowsEnd] = createSignal<number>()
  const hidden = createMemo(() => Math.max(0, Math.min(hiddenRows() ?? Infinity, rows.length - TRANSCRIPT_TAIL_ROWS)))
  const visibleEnd = createMemo(() => Math.max(hidden(), Math.min(visibleRowsEnd() ?? rows.length, rows.length)))
  const visibleRows = createMemo(() => rows.slice(hidden(), visibleEnd()))
  const prependHistory = createHistoryPrepend({
    sessionID: () => route.sessionID,
    more: (id) => data.session.message.more(id),
    loadMore: (id) => data.session.message.loadMore(id),
    height: () => scroll.scrollHeight,
    afterLayout,
    active: (id) => route.sessionID === id && Boolean(scroll && !scroll.isDestroyed),
    scrollBy: (amount) => {
      scroll.scrollBy(amount)
      updateAwayFromBottom()
    },
  })
  let revealingOlderRows = false
  const revealOlderRows = (scrollBy = 0) => {
    const current = hidden()
    if (revealingOlderRows || !scroll || scroll.isDestroyed || scroll.scrollTop > scroll.viewport.height) return false
    if (current === 0) return prependHistory(scrollBy)
    revealingOlderRows = true
    const before = scroll.scrollHeight
    scroll.stickyScroll = false
    setHiddenRows(Math.max(0, current - TRANSCRIPT_BACKFILL_CHUNK))
    afterLayout(() => {
      scroll.scrollBy(scroll.scrollHeight - before + scrollBy)
      scroll.stickyScroll = !navigationMessage()
      revealingOlderRows = false
    })
    return true
  }
  let revealingNewerRows = false
  const revealNewerRows = (scrollBy = 0) => {
    const current = visibleEnd()
    if (
      revealingNewerRows ||
      current === rows.length ||
      !scroll ||
      scroll.isDestroyed ||
      scroll.scrollTop + scroll.viewport.height < scroll.scrollHeight - scroll.viewport.height
    )
      return false
    revealingNewerRows = true
    const next = Math.min(rows.length, current + TRANSCRIPT_BACKFILL_CHUNK)
    setVisibleRowsEnd(next === rows.length ? undefined : next)
    afterLayout(() => {
      revealingNewerRows = false
      scroll.scrollBy(scrollBy)
      updateAwayFromBottom()
    })
    return true
  }
  /** Message navigation needs the full transcript mounted before walking or jumping. */
  const ensureAllRows = (continuation: () => void) => {
    if (firstJump()) clearMessageNavigation()
    if (!ensureAllRowsPending && hidden() === 0 && visibleEnd() === rows.length) return continuation()
    if (ensureAllRowsPending) {
      ensureAllRowsPending.push(continuation)
      return
    }
    const pending = [continuation]
    ensureAllRowsPending = pending
    setHiddenRows(0)
    setVisibleRowsEnd(undefined)
    afterLayout(() => {
      if (ensureAllRowsPending === pending) ensureAllRowsPending = undefined
      pending.forEach((continuation) => continuation())
      updateAwayFromBottom()
    })
  }

  function isAwayFromBottom() {
    if (revealingOlderRows || revealingNewerRows || ensureAllRowsPending || navigationMessage() || firstJump())
      return true
    if (visibleEnd() < rows.length) return true
    return scroll.scrollTop < Math.max(0, scroll.scrollHeight - scroll.viewport.height)
  }
  function updateAwayFromBottom() {
    const preserveWindow = revealingOlderRows || revealingNewerRows || !!ensureAllRowsPending || !!firstJump()
    if (isAwayFromBottom()) setHiddenRows((current) => current ?? hidden())
    if (awayTimer) clearTimeout(awayTimer)
    awayTimer = setTimeout(() => {
      awayTimer = undefined
      if (!scroll || scroll.isDestroyed) return
      const away = preserveWindow || isAwayFromBottom()
      setAwayFromBottom(away)
      if (!away) {
        if (!renderer.getSelection()) setHiddenRows(undefined)
        scroll.stickyScroll = true
      }
      saveScrollAnchor()
    })
  }
  function saveScrollAnchor() {
    // Initial layout must not overwrite the saved position before synchronization restores it.
    if (!restored) return
    if (!isAwayFromBottom()) {
      sessionTabs.setScrollAnchor(sessionID, undefined)
      return
    }
    let first: { messageID: string; screenY: number } | undefined
    let anchor: { messageID: string; screenY: number } | undefined
    for (const child of scroll.getChildren()) {
      if (!child.id || !boundaryIDs().has(child.id)) continue
      const item = { messageID: child.id, screenY: child.y - scroll.viewport.y }
      first ??= item
      if (item.screenY <= 0) anchor = item
    }
    anchor ??= first
    if (anchor) sessionTabs.setScrollAnchor(sessionID, anchor)
    else sessionTabs.setScrollAnchor(sessionID, undefined)
  }
  function restoreScrollPosition() {
    const anchor = sessionTabs.scrollAnchor(sessionID)
    const index = anchor ? boundaries().indexOf(anchor.messageID) : -1
    if (!anchor || index === -1) {
      scroll.scrollTo(scroll.scrollHeight)
      setAwayFromBottom(false)
      return
    }
    setHiddenRows(Math.max(0, index - TRANSCRIPT_BACKFILL_CHUNK))
    const end = Math.min(rows.length, index + TRANSCRIPT_BACKFILL_CHUNK)
    setVisibleRowsEnd(end === rows.length ? undefined : end)
    scroll.stickyScroll = false
    const restore = () =>
      afterLayout(() => {
        const boundary = scroll.getRenderable(anchor.messageID)
        if (!boundary) {
          sessionTabs.setScrollAnchor(sessionID, undefined)
          scroll.stickyScroll = true
          scroll.scrollTo(scroll.scrollHeight)
          setAwayFromBottom(false)
          return
        }
        const contentY = scroll.scrollTop + boundary.y - scroll.viewport.y
        const target = contentY - anchor.screenY
        const maximum = Math.max(0, scroll.scrollHeight - scroll.viewport.height)
        if (target > maximum && visibleEnd() < rows.length) {
          const next = Math.min(rows.length, visibleEnd() + TRANSCRIPT_BACKFILL_CHUNK)
          setVisibleRowsEnd(next === rows.length ? undefined : next)
          restore()
          return
        }
        scroll.scrollTo(target)
        updateAwayFromBottom()
      })
    restore()
  }

  createEffect(() => {
    const current = prompt()
    if (sent || !current || !synced() || !local.model.ready || !local.model.catalogReady) return
    if (!local.agent.current() || !local.model.current()) return
    if (!args.prompt || route.prompt?.text !== args.prompt || current.current.text !== args.prompt) return
    sent = true
    current.submit()
  })
  const dialog = useDialog()
  const renderer = useRenderer()
  const runPendingAction = createSingleFlight<string>()
  const mutatePending = async (action: PendingAction, inboxID: string) => {
    const result = await runPendingAction(inboxID, async () => {
      const request =
        action === "steer"
          ? client.api.session.inbox.steer({ sessionID: route.sessionID, inboxID })
          : action === "queue"
            ? client.api.session.inbox.queue({ sessionID: route.sessionID, inboxID })
            : client.api.session.inbox.cancel({ sessionID: route.sessionID, inboxID })
      const error = await request.then(
        () => undefined,
        (error) => error,
      )
      if (!error) return true
      const label = action === "cancel" ? "delete" : action
      toast.show({ title: `Failed to ${label} pending prompt`, message: errorMessage(error), variant: "error" })
      return false
    })
    return result ?? false
  }
  const openQueuedPrompts = () =>
    dialog.replace(() => (
      <DialogSelect
        title="Queued prompts"
        options={queuedPrompts().map((prompt, index) => ({
          title: prompt.text,
          value: prompt.id,
          footer: `${index + 1} of ${queuedPrompts().length}`,
        }))}
        onSelect={(option) => {
          void mutatePending("steer", option.value).then((steered) => {
            if (steered) dialog.clear()
          })
        }}
        actions={[
          {
            command: "queued_prompt.delete",
            title: "delete",
            onTrigger: (option) => {
              const last = queuedPrompts().length === 1
              void mutatePending("cancel", option.value).then((cancelled) => {
                if (cancelled && last) dialog.clear()
              })
            },
          },
        ]}
        footerHints={[{ title: "steer", label: "enter" }]}
      />
    ))
  const unavailable = (feature: string) => {
    toast.show({ message: `${feature} is not implemented for V2 sessions yet`, variant: "error", duration: 5000 })
    dialog.clear()
  }

  const alignMessage = (messageID: string, top: number) => {
    scroll.stickyScroll = false
    setNavigationMessage(messageID)
    updateAwayFromBottom()
    setNavigationSlack(
      messageNavigationSlack({
        top,
        viewportHeight: scroll.viewport.height,
        scrollHeight: scroll.scrollHeight,
        currentSlack: scroll.getRenderable(NAVIGATION_SLACK_ID)?.height ?? 0,
      }),
    )
    afterLayout(() => {
      if (navigationMessage() !== messageID) return
      scroll.scrollTo(top)
    })
  }

  const scrollToMessage = (direction: "next" | "prev", dialog: ReturnType<typeof useDialog>, userOnly = false) =>
    ensureAllRows(() => {
      const target = findMessageBoundary({
        direction,
        children: scroll.getChildren(),
        messages: messages(),
        scrollTop: scroll.scrollTop,
        viewportY: scroll.viewport.y,
        currentID: navigationMessage(),
        userOnly,
      })

      if (target) {
        alignMessage(target.id, target.top)
        dialog.clear()
        return
      }
      if (direction === "prev" && data.session.message.more(route.sessionID)) {
        prependHistory(0, () => scrollToMessage(direction, dialog, userOnly))
        return
      }
      dialog.clear()
    })

  const jumpToMessage = (messageID: string) =>
    ensureAllRows(() => {
      const child = scroll.getRenderable(messageID)
      if (!child) return
      const y = scroll.scrollTop + child.y - scroll.viewport.y
      const message = data.session.message.get(route.sessionID, messageID)
      alignMessage(messageID, Math.max(0, y - (message?.type === "assistant" ? 1 : 0)))
    })

  function toBottom() {
    clearMessageNavigation()
    ensureAllRowsPending = undefined
    if (awayTimer) clearTimeout(awayTimer)
    awayTimer = undefined
    setAwayFromBottom(false)
    sessionTabs.setScrollAnchor(route.sessionID, undefined)
    setHiddenRows(undefined)
    setVisibleRowsEnd(undefined)
    setTimeout(() => {
      if (!scroll || scroll.isDestroyed) return
      scroll.stickyScroll = true
      scroll.scrollTo(scroll.scrollHeight)
    }, 50)
  }

  function moveTranscript(delta: number) {
    clearMessageNavigation()
    if (delta < 0 && revealOlderRows(delta)) {
      dialog.clear()
      return
    }
    if (delta > 0 && revealNewerRows(delta)) {
      dialog.clear()
      return
    }
    scroll.scrollBy(delta)
    updateAwayFromBottom()
    dialog.clear()
  }

  const globalCommands = [
    {
      id: "session.page.up",
      title: "Page up",
      group: "Session",
      palette: undefined,
      run: () => moveTranscript(-scroll.height / 2),
    },
    {
      id: "session.page.down",
      title: "Page down",
      group: "Session",
      palette: undefined,
      run: () => moveTranscript(scroll.height / 2),
    },
    {
      id: "session.line.up",
      title: "Line up",
      group: "Session",
      palette: undefined,
      run: () => moveTranscript(-1),
    },
    {
      id: "session.line.down",
      title: "Line down",
      group: "Session",
      palette: undefined,
      run: () => moveTranscript(1),
    },
    {
      id: "session.half.page.up",
      title: "Half page up",
      group: "Session",
      palette: undefined,
      run: () => moveTranscript(-scroll.height / 4),
    },
    {
      id: "session.half.page.down",
      title: "Half page down",
      group: "Session",
      palette: undefined,
      run: () => moveTranscript(scroll.height / 4),
    },
  ]

  const baseAndUnfocusedCommands = [
    {
      id: "session.first",
      title: "First message",
      group: "Session",
      palette: undefined,
      run: () => {
        if (firstJump()) return
        clearMessageNavigation()
        const request = new AbortController()
        const cancel = () => request.abort()
        setFirstJump(() => cancel)
        const start = () => {
          if (firstJump() !== cancel || scroll.isDestroyed) return
          if (revealingOlderRows || revealingNewerRows || ensureAllRowsPending) return afterLayout(start)
          const previous = { start: hiddenRows(), end: visibleRowsEnd() }
          const restore = () => {
            cancel()
            batch(() => {
              setHiddenRows(previous.start)
              setVisibleRowsEnd(previous.end)
            })
          }
          const commit = () => {
            if (firstJump() !== restore || scroll.isDestroyed) return
            scroll.stickyScroll = false
            batch(() => {
              setHiddenRows(0)
              setVisibleRowsEnd(TRANSCRIPT_BACKFILL_CHUNK)
              setFirstJump(() => cancel)
            })
          }
          // Pin both ends until the head budget commits in the same batch as history.
          batch(() => {
            setFirstJump(() => restore)
            setHiddenRows(hidden())
            setVisibleRowsEnd(visibleEnd())
          })
          void data.session.message
            .loadMore(route.sessionID, {
              all: true,
              signal: request.signal,
              beforePublish: commit,
            })
            .then(
              () => {
                commit()
                if (firstJump() !== cancel || scroll.isDestroyed) return
                if (rows.length <= TRANSCRIPT_BACKFILL_CHUNK) setVisibleRowsEnd(undefined)
                scroll.scrollTo(0)
                afterLayout(() => {
                  if (firstJump() !== cancel) return
                  scroll.scrollTo(0)
                  setFirstJump(undefined)
                  updateAwayFromBottom()
                })
              },
              (error) => {
                if (firstJump() !== restore || scroll.isDestroyed) return
                clearMessageNavigation()
                toast.error(error)
                updateAwayFromBottom()
              },
            )
        }
        prependHistory.after(start)
        dialog.clear()
      },
    },
    {
      id: "session.last",
      title: "Last message",
      group: "Session",
      palette: undefined,
      run: () => {
        toBottom()
        dialog.clear()
      },
    },
  ]

  const baseCommands = createMemo(() => [
    {
      title: "Share session",
      id: "session.share",
      suggested: route.type === "session",
      group: "Session",
      slash: { name: "share" },
      run: () => unavailable("Sharing"),
    },
    {
      title: "Rename session",
      id: "session.rename",
      group: "Session",
      slash: { name: "rename", arguments: true as const },
      run: (input?: string) => {
        if (input === undefined) return DialogSessionRename.show(dialog, route.sessionID, session()?.title)
        const title = input.trim()
        void (
          title
            ? client.api.session.rename({ sessionID: route.sessionID, title })
            : data.session.title.generate(route.sessionID)
        ).catch((error) => toast.error(error))
      },
    },
    {
      title: "Jump to message",
      id: "session.timeline",
      group: "Session",
      slash: { name: "timeline" },
      run: () => {
        dialog.replace(() => (
          <DialogTimeline
            sessionID={route.sessionID}
            onMove={jumpToMessage}
            setPrompt={(value) => promptRef.current?.set(value)}
          />
        ))
      },
    },
    {
      title: "Fork session",
      id: "session.fork",
      group: "Session",
      slash: { name: "fork" },
      run: () => {
        dialog.replace(() => (
          <DialogFork
            sessionID={route.sessionID}
            onMove={(messageID) => {
              if (!messageID) return
              jumpToMessage(messageID)
            }}
          />
        ))
      },
    },
    {
      title: "Compact session",
      id: "session.compact",
      group: "Session",
      slash: {
        name: "compact",
      },
      run: () => {
        const selection = local.model.current()
        void data.session
          .compact({
            sessionID: route.sessionID,
            model: selection
              ? {
                  providerID: selection.providerID,
                  id: selection.modelID,
                  variant: local.model.variant.current(),
                }
              : undefined,
          })
          .catch((error) => toast.show({ message: errorMessage(error), variant: "error" }))
        dialog.clear()
      },
    },
    {
      title: "Unshare session",
      id: "session.unshare",
      group: "Session",
      enabled: false,
      slash: { name: "unshare" },
      run: () => unavailable("Unsharing"),
    },
    {
      title: "Undo previous message",
      id: "session.undo",
      group: "Session",
      slash: { name: "undo" },
      run: () => {
        const message = messagesBeforeRevert().findLast(
          (message): message is SessionMessageUser => message.type === "user" && !!message.text.trim(),
        )
        if (!message) {
          toast.show({ message: "Nothing to undo", variant: "error", duration: 3000 })
          dialog.clear()
          return
        }
        const sessionID = route.sessionID
        const target = prompt()
        void (async () => {
          if (pendingDeliveries().has(message.id)) {
            if (!(await mutatePending("cancel", message.id))) return
          } else {
            await client.api.session.interrupt({ sessionID })
            await client.api.session.wait({ sessionID })
            await client.api.session.revert.stage({ sessionID, messageID: message.id })
          }
          target?.set({
            ...projectedPromptInput(message),
            pasted: [],
          })
        })().catch((error) => toast.show({ message: errorMessage(error), variant: "error", duration: 5000 }))
        dialog.clear()
      },
    },
    {
      title: "Redo",
      id: "session.redo",
      group: "Session",
      enabled: !!session()?.revert?.messageID,
      slash: { name: "redo" },
      run: () => {
        void (async () => {
          const error = await client.api.session.revert.clear({ sessionID: route.sessionID }).then(
            () => undefined,
            (error) => error,
          )
          if (error) toast.show({ message: errorMessage(error), variant: "error", duration: 5000 })
          dialog.clear()
        })()
      },
    },
    {
      title: (() => {
        const next = nextThinkingMode(thinkingMode())
        if (next === "hide") return "Collapse thinking"
        return "Expand thinking"
      })(),
      id: "session.toggle.thinking",
      group: "Session",
      palette: undefined,
      run: () => {
        void configState
          .update((draft) => {
            draft.session = { ...draft.session, thinking: nextThinkingMode(thinkingMode()) }
          })
          .catch(toast.error)
        dialog.clear()
      },
    },
    {
      title: "Toggle session scrollbar",
      id: "session.toggle.scrollbar",
      group: "Session",
      palette: undefined,
      run: () => {
        void configState
          .update((draft) => {
            draft.session = { ...draft.session, scrollbar: !showScrollbar() }
          })
          .catch(toast.error)
        dialog.clear()
      },
    },
    {
      title: groupExploration() ? "Show tool calls individually" : "Group related tool calls",
      id: "session.toggle.exploration_grouping",
      group: "Session",
      palette: undefined,
      run: () => {
        void configState
          .update((draft) => {
            draft.session = { ...draft.session, grouping: groupExploration() ? "none" : "auto" }
          })
          .catch(toast.error)
        dialog.clear()
      },
    },
    {
      title: "Jump to last user message",
      id: "session.messages_last_user",
      group: "Session",
      palette: undefined,
      run: () => {
        const messages = data.session.message.list(route.sessionID)
        if (!messages || !messages.length) return

        // Find the most recent user message with non-ignored, non-synthetic text parts
        for (let i = messages.length - 1; i >= 0; i--) {
          const message = messages[i]
          if (!message || message.type !== "user" || !message.text.trim()) continue
          {
            jumpToMessage(message.id)
            break
          }
        }
      },
    },
    {
      title: "Next message",
      id: "session.message.next",
      group: "Session",
      palette: undefined,
      run: () => scrollToMessage("next", dialog),
    },
    {
      title: "Previous message",
      id: "session.message.previous",
      group: "Session",
      palette: undefined,
      run: () => scrollToMessage("prev", dialog),
    },
    {
      title: "Next user message",
      id: "session.message.user.next",
      group: "Session",
      palette: undefined,
      run: () => scrollToMessage("next", dialog, true),
    },
    {
      title: "Previous user message",
      id: "session.message.user.previous",
      group: "Session",
      palette: undefined,
      run: () => scrollToMessage("prev", dialog, true),
    },
    {
      title: "Copy last assistant message",
      id: "messages.copy",
      group: "Session",
      run: () => {
        const lastAssistantMessage = messagesBeforeRevert().findLast(
          (msg): msg is SessionMessageAssistant => msg.type === "assistant",
        )
        if (!lastAssistantMessage) {
          toast.show({ message: "No assistant messages found", variant: "error" })
          dialog.clear()
          return
        }

        const textParts = lastAssistantMessage.content.filter((part) => part.type === "text")
        if (textParts.length === 0) {
          toast.show({ message: "No text parts found in last assistant message", variant: "error" })
          dialog.clear()
          return
        }

        const text = textParts
          .map((part) => part.text)
          .join("\n")
          .trim()
        if (!text) {
          toast.show({
            message: "No text content found in last assistant message",
            variant: "error",
          })
          dialog.clear()
          return
        }

        clipboard
          .write(text)
          .then(() => toast.show({ message: "Message copied to clipboard!", variant: "success" }))
          .catch(() => toast.show({ message: "Failed to copy to clipboard", variant: "error" }))
        dialog.clear()
      },
    },
    {
      title: "Copy session ID",
      id: "session.copy.id",
      group: "Session",
      run: () => {
        clipboard
          .write(route.sessionID)
          .then(() => toast.show({ message: "Session ID copied to clipboard!", variant: "success" }))
          .catch(() => toast.show({ message: "Failed to copy session ID", variant: "error" }))
        dialog.clear()
      },
    },
    {
      title: "Copy session transcript",
      id: "session.copy",
      group: "Session",
      slash: {
        name: "copy",
      },
      run: async () => {
        try {
          const sessionData = session()
          if (!sessionData) return
          const transcript = formatSessionTranscript(sessionData, messages(), true)
          await clipboard.write(transcript)
          toast.show({ message: "Session transcript copied to clipboard!", variant: "success" })
        } catch {
          toast.show({ message: "Failed to copy session transcript", variant: "error" })
        }
        dialog.clear()
      },
    },
    {
      title: "Export session transcript",
      id: "session.export",
      group: "Session",
      slash: {
        name: "export",
      },
      run: async () => {
        try {
          const sessionData = session()
          if (!sessionData) return

          const options = await DialogExportOptions.show(dialog, true)

          if (options === null) return

          const content =
            options.format === "markdown"
              ? formatSessionTranscript(sessionData, messages(), options.thinking, options.tools)
              : JSON.stringify(
                  await client.api.session.export({ sessionID: sessionData.id, sanitize: options.sanitize }),
                  null,
                  2,
                ) + EOL

          if (options.action === "copy") {
            await clipboard.write(content)
            dialog.clear()
            toast.show({ message: "Copied to clipboard", variant: "success" })
            return
          }

          const filepath = path.join(
            tmpdir(),
            `session-${crypto.randomUUID()}.${options.format === "markdown" ? "md" : "json"}`,
          )
          await writeExport(filepath, content)
          await DialogExportResult.show(dialog, filepath)
        } catch {
          toast.show({ message: "Failed to export session", variant: "error" })
        }
        dialog.clear()
      },
    },
    {
      title: "Background blocking tools",
      id: "session.background",
      group: "Session",
      palette: undefined,
      run: () => {
        void client.api.session.background({ sessionID: route.sessionID })
        dialog.clear()
      },
    },
    {
      title: "Toggle subagent picker",
      id: "session.child.first",
      group: "Session",
      run: () => {
        if (composer.open || session()?.parentID) setComposer("open", false)
        else setComposer({ open: true, tab: "subagents" })
        dialog.clear()
      },
    },
    {
      title: "View queued prompts",
      id: "session.queued_prompts",
      group: "Prompt",
      enabled: queuedPrompts().length > 0,
      run: openQueuedPrompts,
    },
    {
      title: "Go to parent session",
      id: "session.parent",
      group: "Session",
      palette: undefined,
      enabled: !!session()?.parentID,
      run: () => {
        const parentID = session()?.parentID
        if (parentID) {
          navigate({
            type: "session",
            sessionID: parentID,
          })
        }
        dialog.clear()
      },
    },
  ])

  const commands = createMemo(() =>
    [...globalCommands, ...baseAndUnfocusedCommands, ...baseCommands()].map(
      (command) =>
        ({
          bind: false,
          palette: true as const,
          ...command,
        }) satisfies KeymapCommand,
    ),
  )

  Keymap.createLayer(() => ({
    mode: "global",
    commands: commands(),
    bindings: globalCommands.map((command) => command.id),
  }))

  Keymap.createLayer(() => ({
    enabled: () => renderer.currentFocusedEditor === null,
    bindings: baseAndUnfocusedCommands.map((command) => command.id),
  }))

  Keymap.createLayer(() => ({
    bindings: [...baseAndUnfocusedCommands, ...baseCommands()].map((command) => command.id),
  }))

  createEffect(
    on(
      () => route.sessionID,
      () => {
        setComposer("open", false)
        clearMessageNavigation()
      },
    ),
  )

  // Memoized per axis so width readers do not re-run on height-only resizes
  // (dimensions() is one object signal with identity equality) and vice versa.
  const terminalWidth = createMemo(() => dimensions().width)
  const terminalHeight = createMemo(() => dimensions().height)

  return (
    <context.Provider
      value={{
        get width() {
          return contentWidth()
        },
        terminal: {
          get width() {
            return terminalWidth()
          },
          get height() {
            return terminalHeight()
          },
        },
        sessionID: route.sessionID,
        thinkingMode,
        markdownMode,
        groupExploration,
        diffWrapMode,
        models,
        messageIndex: (messageID) => messageIndexes().get(messageID),
        config,
        mutatePending,
        pendingDelivery: (inboxID) => pendingDeliveries().get(inboxID),
      }}
    >
      <box flexDirection="row" flexGrow={1} minHeight={0}>
        <box
          flexGrow={1}
          minHeight={0}
          paddingBottom={1}
          paddingLeft={dimensions().width < 44 ? 1 : 2}
          paddingRight={dimensions().width < 44 ? 1 : 2}
        >
          <Show when={session()}>
            <box flexGrow={1} minHeight={0} position="relative">
              <scrollbox
                ref={(r) => {
                  scroll = r
                  props.scrollRef?.(r)
                  scroll.verticalScrollBar.on("change", updateAwayFromBottom)
                }}
                viewportOptions={{
                  paddingRight: showScrollbar() ? 1 : 0,
                }}
                verticalScrollbarOptions={{
                  paddingLeft: 1,
                  visible: showScrollbar(),
                  trackOptions: {
                    backgroundColor: theme.raise(theme.background.surface.offset),
                    foregroundColor: theme.border.default,
                  },
                }}
                stickyScroll={!navigationMessage()}
                stickyStart="bottom"
                flexGrow={1}
                scrollAcceleration={scrollAcceleration()}
                onMouseScroll={(event) => {
                  if (firstJump()) clearMessageNavigation()
                  if (event.scroll?.direction === "up" && revealOlderRows()) return
                  if (event.scroll?.direction === "down" && revealNewerRows()) return
                  updateAwayFromBottom()
                }}
              >
                <For each={visibleRows()}>
                  {(row, index) => (
                    <SessionRowView
                      row={row}
                      message={(messageID) => data.session.message.get(route.sessionID, messageID)}
                      boundaryID={boundaries()[index() + hidden()]}
                    />
                  )}
                </For>
                <BackgroundToolHint messages={messages()} />
                <Show when={session()?.revert?.messageID}>
                  <RevertMessage
                    count={messagesFromRevert().filter((message) => message.type === "user").length}
                    files={session()!.revert!.files ?? []}
                  />
                </Show>
                <Show when={navigationSlack()}>
                  {(height) => <box id={NAVIGATION_SLACK_ID} height={height()} flexShrink={0} />}
                </Show>
              </scrollbox>
            </box>
            <box height={1} flexShrink={0} flexDirection="row" justifyContent="flex-end">
              <Show when={firstJump()}>
                <text fg={theme.text.feedback.info.default}>Loading session history…</text>
              </Show>
              <Show when={!firstJump() && awayFromBottom()}>
                <box
                  id="session-jump-to-latest"
                  paddingLeft={1}
                  onMouseOver={() => setLatestHovered(true)}
                  onMouseOut={() => setLatestHovered(false)}
                  onMouseUp={toBottom}
                >
                  <text
                    fg={latestHovered() ? theme.text.action.secondary.hovered : theme.text.action.secondary.default}
                  >
                    Jump to latest ↓
                  </text>
                </box>
              </Show>
            </box>
            <box flexShrink={0}>
              <Show when={!composer.open && !disabled() && queuedPrompts().length > 0}>
                <QueuedPromptDock prompts={queuedPrompts()} onOpen={openQueuedPrompts} />
              </Show>
              <Slot path="session.composer.top" input={{ sessionID: route.sessionID }} />
              <Composer
                sessionID={route.sessionID}
                open={composer.open || (!!session()?.parentID && forms().length === 0)}
                defaultTab={composer.tab ?? (session()?.parentID ? "subagents" : undefined)}
                onClose={() => {
                  const parent = session()?.parentID
                  if (parent) {
                    navigate({ type: "session", sessionID: parent })
                    return
                  }
                  setComposer("open", false)
                }}
                visibleTerminalID={props.visibleTerminalID}
              />
              <Switch>
                <Match when={composer.open || (!!session()?.parentID && forms().length === 0)}>{null}</Match>
                <Match when={promptedPermissions().length > 0}>
                  <Show when={promptedPermissions()[0]?.id} keyed>
                    {(_) => {
                      const request = promptedPermissions()[0]
                      return request ? (
                        <PermissionPrompt request={request} directory={session()?.location.directory} />
                      ) : null
                    }}
                  </Show>
                </Match>
                <Match when={forms().length > 0}>
                  <Show when={forms()[0]?.id} keyed>
                    {(_) => {
                      const form = forms()[0]
                      return form ? <FormPrompt form={form} /> : null
                    }}
                  </Show>
                </Match>
                <Match
                  when={
                    session() &&
                    currentLocation.error?.location.directory === session()!.location.directory &&
                    currentLocation.error?.location.workspaceID === session()!.location.workspaceID
                  }
                >
                  <SessionLocationMissing
                    directory={session()!.location.directory}
                    projectID={session()!.projectID}
                    sessionID={route.sessionID}
                  />
                </Match>
                <Match when={!disabled()}>
                  <Prompt
                    visible={true}
                    ref={bind}
                    muted={props.promptMuted}
                    onSubmit={() => {
                      toBottom()
                    }}
                    onEmptySubmit={async () => {
                      const next = queuedPrompts()[0]
                      if (!next) return false
                      return mutatePending("steer", next.id)
                    }}
                    sessionID={route.sessionID}
                  />
                </Match>
              </Switch>
            </box>
          </Show>
        </box>
      </box>
    </context.Provider>
  )
}

type SessionRowViewProps = {
  row: SessionRow
  message: (messageID: string) => SessionMessageInfo | undefined
  boundaryID?: string
}

function SessionRowView(props: SessionRowViewProps) {
  return (
    <box id={sessionRowID(props.row, props.boundaryID)} marginTop={1} flexShrink={0}>
      <Switch>
        <Match when={props.row.type === "message" ? props.row : undefined}>
          {(row) => (
            <Show when={props.message(row().messageID)}>{(message) => <SessionMessageView message={message()} />}</Show>
          )}
        </Match>
        <Match when={props.row.type === "compaction-queued"}>
          <CompactionQueued />
        </Match>
        <Match when={props.row.type === "part" ? props.row : undefined}>
          {(row) => <SessionPartView partRef={row().ref} message={props.message} />}
        </Match>
        <Match when={props.row.type === "group" && props.row.kind === "reasoning" ? props.row : undefined}>
          {(row) => (
            <SessionReasoningGroupView refs={groupRefs(row())} completed={row().completed} message={props.message} />
          )}
        </Match>
        <Match when={props.row.type === "group" && props.row.kind === "exploration" ? props.row : undefined}>
          {(row) => (
            <SessionGroupView
              refs={groupRefs(row())}
              pending={row().pending}
              completed={row().completed}
              message={props.message}
            />
          )}
        </Match>
        <Match when={props.row.type === "assistant-footer" ? props.row : undefined}>
          {(row) => (
            <Show when={props.message(row().messageID)}>
              {(message) => (
                <Show when={message().type === "assistant"}>
                  <AssistantFooter message={message() as SessionMessageAssistant} />
                </Show>
              )}
            </Show>
          )}
        </Match>
        <Match when={props.row.type === "turn-usage" ? props.row : undefined}>
          {(row) => (
            <TurnTokenUsage messageIDs={row().messageIDs} previousCache={row().previousCache} message={props.message} />
          )}
        </Match>
      </Switch>
    </box>
  )
}

function TurnTokenUsage(props: {
  messageIDs: string[]
  previousCache?: CacheUsage
  message: (messageID: string) => SessionMessageInfo | undefined
}) {
  const config = useConfig()
  const theme = useTheme()
  const renderer = useRenderer()
  // Collapsed by default: one summary line for the whole turn. Click to
  // open the full per-step table, click again to close.
  const [expanded, setExpanded] = createSignal(false)
  const [hover, setHover] = createSignal(false)
  const verbose = () => config.data.debug?.turn_tokens === "verbose"
  const steps = createMemo(() => {
    let previousCache = props.previousCache
    return props.messageIDs.flatMap((messageID) => {
      const message = props.message(messageID)
      if (message?.type !== "assistant" || !message.tokens) return []
      const total =
        message.tokens.input +
        message.tokens.output +
        message.tokens.reasoning +
        message.tokens.cache.read +
        message.tokens.cache.write
      if (total === 0) return []
      const newTokens = total - message.tokens.cache.read
      const currentCache = { read: message.tokens.cache.read, model: message.model }
      const reuseDrop = cacheReuseDrop(previousCache, currentCache)
      previousCache = currentCache
      return [
        {
          finish: message.finish === "tool-calls" ? "tool-call" : (message.finish ?? "unknown"),
          tools: verbose() ? message.content.filter((part) => part.type === "tool") : [],
          newTokens,
          cached: message.tokens.cache.read,
          total,
          reuseDrop,
        },
      ]
    })
  })
  const columns = createMemo(() => ({
    step: Math.max("Step".length, ...steps().map((item) => item.finish.length)),
    newTokens: Math.max("New".length, ...steps().map((item) => item.newTokens.toLocaleString().length)),
    cached: Math.max("Cached".length, ...steps().map((item) => item.cached.toLocaleString().length)),
    total: Math.max("Total".length, ...steps().map((item) => item.total.toLocaleString().length)),
  }))
  const summary = createMemo(() => {
    const items = steps()
    return {
      count: items.length,
      newTokens: items.reduce((sum, item) => sum + item.newTokens, 0),
      cached: items.reduce((sum, item) => sum + item.cached, 0),
      total: items.reduce((sum, item) => sum + item.total, 0),
      reuseDrops: items.filter((item) => item.reuseDrop !== undefined).length,
    }
  })
  return (
    <Show when={Boolean(config.data.debug?.turn_tokens) && steps().length > 0}>
      <box paddingLeft={3} flexDirection="column">
        <box
          flexDirection="row"
          onMouseOver={() => setHover(true)}
          onMouseOut={() => setHover(false)}
          onMouseUp={() => {
            if (renderer.getSelection()?.getSelectedText()) return
            setExpanded((value) => !value)
          }}
        >
          <text fg={hover() ? theme.text.default : theme.text.subdued} wrapMode="none">
            <span>{expanded() ? "- " : "+ "}</span>
            <span style={{ attributes: TextAttributes.BOLD }}>Tokens</span>
            <span>
              : {summary().count} {summary().count === 1 ? "step" : "steps"} · {summary().newTokens.toLocaleString()}{" "}
              new · {summary().cached.toLocaleString()} cached · {summary().total.toLocaleString()} total
            </span>
            <Show when={summary().reuseDrops > 0}>
              <span style={{ fg: theme.text.feedback.warning.default }}>
                {" "}
                · ! {summary().reuseDrops} likely cache {summary().reuseDrops === 1 ? "bust" : "busts"}
              </span>
            </Show>
          </text>
        </box>
        <Show when={expanded()}>
          <box paddingLeft={INLINE_TOOL_ICON_WIDTH}>
            <text fg={theme.text.subdued} attributes={TextAttributes.ITALIC}>
              {"Step".padEnd(columns().step + 2)}
              {"New".padStart(columns().newTokens)}
              {"  "}
              {"Cached".padStart(columns().cached)}
              {"  "}
              {"Total".padStart(columns().total)}
            </text>
          </box>
          <For each={steps()}>
            {(item) => (
              <box paddingLeft={INLINE_TOOL_ICON_WIDTH} flexDirection="column">
                <text fg={verbose() && item.finish === "tool-call" ? undefined : theme.text.subdued}>
                  {item.finish.padEnd(columns().step + 2)}
                  <span style={{ attributes: TextAttributes.BOLD }}>
                    {item.newTokens.toLocaleString().padStart(columns().newTokens)}
                  </span>
                  {"  "}
                  {item.cached.toLocaleString().padStart(columns().cached)}
                  {"  "}
                  {item.total.toLocaleString().padStart(columns().total)}
                </text>
                <TurnTokenToolCalls tools={item.tools} />
                <Show when={item.reuseDrop !== undefined}>
                  <text fg={theme.text.feedback.warning.default}>
                    ! Likely cache bust: {item.reuseDrop?.toLocaleString()} fewer cached tokens than the previous step
                  </text>
                </Show>
              </box>
            )}
          </For>
        </Show>
      </box>
    </Show>
  )
}

function TurnTokenToolCalls(props: { tools: SessionMessageAssistantTool[] }) {
  const theme = useTheme()
  const nameWidth = () => Math.max(0, ...props.tools.map((tool) => tool.name.length)) + 2
  return (
    <Show when={props.tools.length > 0}>
      <box paddingLeft={2} flexDirection="column">
        <For each={props.tools}>
          {(tool) => (
            <box flexDirection="row">
              <text width={nameWidth()} flexShrink={0} fg={theme.text.subdued} attributes={TextAttributes.BOLD}>
                {tool.name}
              </text>
              <text fg={theme.text.subdued} attributes={TextAttributes.DIM} wrapMode="word" flexGrow={1} minWidth={0}>
                {turnTokenToolSummary(tool)}
              </text>
            </box>
          )}
        </For>
      </box>
    </Show>
  )
}

function turnTokenToolSummary(tool: SessionMessageAssistantTool) {
  const data = tool.state.input
  if (typeof data === "string") return data
  const primaryKey = ["command", "id", "pattern", "url", "query", "path", "description", "code"].find(
    (key) => key in data,
  )
  const input = Object.entries(data).filter(([, value]) => ["string", "number", "boolean"].includes(typeof value))
  const primary = input.find(([key]) => key === primaryKey)?.[1]
  const details = input.filter(([key]) => key !== primaryKey).map(([key, value]) => `${key}: ${String(value)}`)
  return [primary === undefined ? "" : String(primary), ...details].filter(Boolean).join("  ")
}

function BackgroundToolHint(props: { messages: SessionMessageInfo[] }) {
  const theme = useTheme()
  const shortcut = Keymap.useShortcut("session.background")
  const running = createMemo(() => {
    if (!shortcut()) return
    const current = props.messages.findLast(
      (message): message is SessionMessageAssistant => message.type === "assistant" && !message.time.completed,
    )
    const part = current?.content.find((part): part is SessionMessageAssistantTool => {
      if (part.type !== "tool" || part.state.status !== "running") return false
      const name = canonicalToolName(part.name)
      return name === "shell" || name === "subagent"
    })
    if (!current || !part) return
    return { key: `${current.id}:${part.id}`, started: part.time.ran ?? part.time.created }
  })
  const visible = createDelayedPresence(
    running,
    (tool) => Math.max(0, BACKGROUND_TOOL_HINT_DELAY - (Date.now() - tool.started)),
    (previous, next) => previous.key === next.key && previous.started === next.started,
  )
  return (
    <Show when={visible() && shortcut()}>
      {(value) => (
        <box marginTop={1} paddingLeft={3} flexShrink={0}>
          <text fg={theme.text.subdued}>
            Press <span style={{ fg: theme.text.default }}>{value()}</span> to move running work to the background
          </text>
        </box>
      )}
    </Show>
  )
}

function SessionMessageView(props: { message: SessionMessageInfo }) {
  return (
    <Switch>
      <Match when={props.message.type === "user"}>
        <UserMessage message={props.message as SessionMessageUser} />
      </Match>
      <Match when={props.message.type === "shell"}>
        <ShellMessage message={props.message as Extract<SessionMessageInfo, { type: "shell" }>} />
      </Match>
      <Match
        when={
          props.message.type === "agent-switched" ||
          props.message.type === "model-switched" ||
          props.message.type === "location-switched"
        }
      >
        <SessionSwitchMessageV2 message={props.message} />
      </Match>
      <Match
        when={props.message.type === "system" || props.message.type === "synthetic" || props.message.type === "skill"}
      >
        <Show when={props.message.type === "skill"} fallback={<SessionNoticeMessageV2 message={props.message} />}>
          <SessionSkillMessage message={props.message as Extract<SessionMessageInfo, { type: "skill" }>} />
        </Show>
      </Match>
      <Match when={props.message.type === "compaction"}>
        <CompactionMessage message={props.message as Extract<SessionMessageInfo, { type: "compaction" }>} />
      </Match>
    </Switch>
  )
}

function SessionPartView(props: { partRef: PartRef; message: (messageID: string) => SessionMessageInfo | undefined }) {
  const message = createMemo(() => props.message(props.partRef.messageID))
  const part = createMemo(() => {
    const item = message()
    if (item?.type !== "assistant") return
    return resolvePart(item, props.partRef.partID)
  })
  return (
    <Show when={part()}>
      {(item) => (
        <Switch>
          <Match when={item().type === "text"}>
            <TextPart
              part={item() as SessionMessageAssistantText}
              message={message() as SessionMessageAssistant}
              last={false}
            />
          </Match>
          <Match when={item().type === "reasoning"}>
            <ReasoningPart
              part={item() as SessionMessageAssistantReasoning}
              message={message() as SessionMessageAssistant}
              last={false}
            />
          </Match>
          <Match when={item().type === "tool"}>
            <ToolPart part={item() as SessionMessageAssistantTool} />
          </Match>
        </Switch>
      )}
    </Show>
  )
}

function SessionReasoningGroupView(props: {
  refs: PartRef[]
  completed: boolean
  message: (messageID: string) => SessionMessageInfo | undefined
}) {
  const ctx = use()
  const theme = useTheme()
  const { currentSyntax: syntax } = useThemes()
  const thinkingSyntax = createSyntaxStyleMemo(() => generateThinkingSyntax(syntax(), theme.text.subdued))
  const renderer = useRenderer()
  const [expanded, setExpanded] = createSignal(false)
  const [hover, setHover] = createSignal(false)
  const parts = createMemo(() =>
    props.refs.flatMap((ref) => {
      const message = props.message(ref.messageID)
      if (message?.type !== "assistant") return []
      const part = resolvePart(message, ref.partID)
      if (part?.type !== "reasoning" || !reasoningContent(part)) return []
      return [{ message, part }]
    }),
  )
  const latest = createMemo((previous: string | null) => {
    const item = parts().at(-1)
    if (!item) return previous
    const title = reasoningSummary(reasoningContent(item.part)).title
    if (title) return title
    if (item.part.time?.completed !== undefined || item.message.time.completed !== undefined) return null
    return previous
  }, null)
  const duration = createMemo(() =>
    parts().reduce((total, item) => {
      const start = item.part.time?.created
      const end = item.part.time?.completed
      return total + (start === undefined || end === undefined ? 0 : Math.max(0, end - start))
    }, 0),
  )

  return (
    <Show when={parts().length > 0}>
      <Show
        when={ctx.thinkingMode() === "hide"}
        fallback={<For each={props.refs}>{(ref) => <SessionPartView partRef={ref} message={props.message} />}</For>}
      >
        <box flexDirection="column" flexShrink={0}>
          <InlineToolRow
            icon={expanded() ? "-" : "+"}
            color={
              !props.completed
                ? theme.text.default
                : hover() || expanded()
                  ? theme.text.feedback.warning.default
                  : RGBA.fromValues(
                      theme.text.feedback.warning.default.r,
                      theme.text.feedback.warning.default.g,
                      theme.text.feedback.warning.default.b,
                      0.6,
                    )
            }
            complete={props.completed}
            pending={latest() ? `Thinking: ${latest()}` : "Thinking"}
            spinner={!props.completed}
            onMouseOver={() => setHover(true)}
            onMouseOut={() => setHover(false)}
            onMouseUp={() => {
              if (renderer.getSelection()?.getSelectedText()) return
              setExpanded((value) => !value)
            }}
          >
            {props.completed ? "Thought" : latest() ? `Thinking: ${latest()}` : "Thinking"}
            <Show when={props.completed && !expanded() && latest()}>: {latest()}</Show>
            <Show when={props.completed && parts().length > 1}> · {parts().length} steps</Show>
            <Show when={props.completed && duration()}> · {Locale.duration(duration())}</Show>
          </InlineToolRow>
          <Show when={expanded()}>
            <box paddingLeft={3}>
              <For each={props.refs}>
                {(ref) => {
                  const message = createMemo(() => {
                    const item = props.message(ref.messageID)
                    return item?.type === "assistant" ? item : undefined
                  })
                  const part = createMemo(() => {
                    const item = message()
                    if (!item) return undefined
                    const part = resolvePart(item, ref.partID)
                    return part?.type === "reasoning" ? part : undefined
                  })
                  const content = createMemo(() => {
                    const item = part()
                    return item ? reasoningContent(item) : ""
                  })
                  return (
                    <Show when={content()}>
                      <box marginTop={1}>
                        <box
                          border={["left"]}
                          customBorderChars={SplitBorder.customBorderChars}
                          borderColor={theme.raise(theme.background.surface.offset)}
                          paddingLeft={1}
                        >
                          <code
                            filetype="markdown"
                            drawUnstyledText={false}
                            streaming={part()?.time?.completed === undefined && message()?.time.completed === undefined}
                            syntaxStyle={thinkingSyntax()}
                            content={content()}
                            conceal={ctx.markdownMode() === "rendered"}
                            fg={theme.text.subdued}
                          />
                        </box>
                      </box>
                    </Show>
                  )
                }}
              </For>
            </box>
          </Show>
        </box>
      </Show>
    </Show>
  )
}

function SessionGroupView(props: {
  refs: PartRef[]
  pending: PartRef[]
  completed: boolean
  message: (messageID: string) => SessionMessageInfo | undefined
}) {
  const theme = useTheme()
  const ctx = use()
  const renderer = useRenderer()
  const [expanded, setExpanded] = createSignal(false)
  const [hover, setHover] = createSignal(false)
  const parts = (refs: PartRef[]) =>
    refs.flatMap((ref) => {
      const message = props.message(ref.messageID)
      if (message?.type !== "assistant") return []
      const part = resolvePart(message, ref.partID)
      if (part?.type !== "tool") return []
      return [part]
    })
  const grouped = createMemo(() => parts(props.refs))
  const pending = createMemo(() => parts(props.pending))
  const completed = createMemo(
    () => props.completed || (grouped().length > 0 && grouped().every((part) => part.time.completed !== undefined)),
  )
  const label = createMemo(() => {
    const counts = grouped().reduce<Record<string, number>>((result, part) => {
      const tool = toolDisplay(part.name)
      const name = tool === "grep" || tool === "glob" ? "search" : tool
      result[name] = (result[name] ?? 0) + 1
      return result
    }, {})
    const tools = Object.entries(counts).map(
      ([name, count]) => `${count} ${count === 1 ? name : name === "search" ? "searches" : `${name}s`}`,
    )
    return `${completed() ? "Explored" : "Exploring"} — ${tools.join(", ")}`
  })
  return (
    <Show when={grouped().length > 0 || pending().length > 0}>
      <Show
        when={ctx.groupExploration()}
        fallback={<For each={[...grouped(), ...pending()]}>{(part) => <ToolPart part={part} />}</For>}
      >
        <Show when={grouped().length > 0}>
          <InlineToolRow
            icon={completed() ? "→" : "✱"}
            color={hover() ? theme.text.default : theme.text.subdued}
            complete={completed()}
            pending={label()}
            spinner={!completed()}
            onMouseOver={() => setHover(true)}
            onMouseOut={() => setHover(false)}
            onMouseUp={() => {
              if (renderer.getSelection()?.getSelectedText()) return
              setExpanded((value) => !value)
            }}
          >
            {label()}
          </InlineToolRow>
        </Show>
        <Show when={expanded() && grouped().length > 0}>
          <For each={grouped()}>{(part) => <ToolPart part={part} images={false} />}</For>
        </Show>
        <ToolImages parts={grouped()} />
        <For each={pending()}>{(part) => <ToolPart part={part} />}</For>
      </Show>
    </Show>
  )
}

function AssistantFooter(props: { message: SessionMessageAssistant }) {
  const ctx = use()
  const config = useConfig()
  const data = useData()
  const local = useLocal()
  const theme = useTheme("elevated")
  const model = createMemo(
    () =>
      ctx
        .models()
        .find((model) => model.providerID === props.message.model.providerID && model.id === props.message.model.id)
        ?.name ?? `${props.message.model.providerID}/${props.message.model.id}`,
  )
  const messages = createMemo(() => data.session.message.list(ctx.sessionID))
  const duration = createMemo(() => turnDuration(props.message, messages(), ctx.messageIndex(props.message.id)))
  const tokensPerSecond = createMemo(() =>
    turnTokensPerSecond(props.message, messages(), ctx.messageIndex(props.message.id)),
  )
  const interrupted = createMemo(() => props.message.error?.message === "Step interrupted")
  return (
    <>
      <Show when={props.message.error && !interrupted() && !props.message.retry}>
        <box paddingLeft={3}>
          <text fg={theme.text.feedback.error.default}>Error: {errorMessage(props.message.error)}</text>
        </box>
      </Show>
      <AssistantRetry retry={props.message.retry} />
      <box paddingLeft={3} marginTop={props.message.retry || (props.message.error && !interrupted()) ? 1 : 0}>
        <text>
          <span style={{ fg: props.message.error ? theme.text.subdued : local.agent.color(props.message.agent) }}>
            {Locale.titlecase(props.message.agent)}
          </span>
          <Show when={ctx.terminal.width >= 28}>
            <span style={{ fg: theme.text.subdued }}> · {model()}</span>
          </Show>
          <Show when={duration() && (ctx.terminal.width < 28 || ctx.terminal.width >= 36)}>
            <span style={{ fg: theme.text.subdued }}> · {Locale.duration(duration())}</span>
          </Show>
          <Show when={config.data.session.tps && tokensPerSecond()}>
            {(value) => <span style={{ fg: theme.text.subdued }}> · {value().toFixed(1)} tok/s</span>}
          </Show>
          <Show when={interrupted()}>
            <span style={{ fg: theme.text.subdued }}> · interrupted</span>
          </Show>
        </text>
      </box>
    </>
  )
}

function SessionSwitchMessageV2(props: { message: SessionMessageInfo }) {
  const ctx = use()
  const theme = useTheme()
  if (props.message.type === "location-switched")
    return (
      <box paddingLeft={3}>
        <text>
          <span style={{ fg: theme.text.subdued }}>↳ Moved to </span>
          <span style={{ fg: theme.text.feedback.info.default }}>{props.message.location.directory}</span>
        </text>
      </box>
    )
  const text = () => {
    if (props.message.type === "agent-switched") {
      const agent = Locale.titlecase(props.message.agent)
      if (props.message.previous && props.message.previous !== props.message.agent)
        return `Switched agent from ${Locale.titlecase(props.message.previous)} to ${agent}`
      return `Switched agent to ${agent}`
    }
    if (props.message.type === "model-switched")
      return switchLabel(props.message.model, ctx.models(), props.message.previous)
    return ""
  }
  return (
    <box paddingLeft={3}>
      <text fg={theme.text.subdued}>{text()}</text>
    </box>
  )
}

function SessionNoticeMessageV2(props: { message: SessionMessageInfo }) {
  const ctx = use()
  const theme = useTheme()
  const metadata = () => (props.message.type === "synthetic" ? props.message.metadata : undefined)
  const source = () => stringValue(metadata()?.source)
  const completion = () => source() === "subagent" || source() === "shell"
  const state = () => stringValue(metadata()?.state)
  const actor = () => (source() === "shell" ? "Shell" : Locale.titlecase(stringValue(metadata()?.agent) ?? "Subagent"))
  const text = () => {
    if (props.message.type === "system") return props.message.description ?? "Instructions updated"
    if (props.message.type === "synthetic") return props.message.description ?? ""
    return ""
  }
  const description = () => (source() === "shell" ? text().replace(/\s+/g, " ").trim() : text())
  const status = () => {
    if (state() === "completed") return "finished"
    if (state() === "error") return "failed"
    return state() ?? "finished"
  }
  const heading = () => `${state() === "completed" ? "↳" : "!"} ${actor()} ${status()}`
  const suffix = () => Locale.truncateWidth(` · ${description()}`, Math.max(0, ctx.width - 3 - stringWidth(heading())))
  const color = () => {
    if (state() === "error") return theme.text.feedback.error.default
    if (state() === "cancelled") return theme.text.feedback.warning.default
    return theme.text.feedback.info.default
  }
  return (
    <Show
      when={completion()}
      fallback={
        <InlineToolRow icon="◈" color={theme.text.subdued} pending="Notice" complete={true}>
          {text()}
        </InlineToolRow>
      }
    >
      <box marginLeft={3}>
        <text wrapMode="none">
          <span style={{ fg: color() }}>{heading()}</span>
          <span style={{ fg: theme.text.subdued }}>{suffix()}</span>
        </text>
      </box>
    </Show>
  )
}

function SessionSkillMessage(props: { message: Extract<SessionMessageInfo, { type: "skill" }> }) {
  const theme = useTheme()
  return (
    <InlineToolRow icon="→" color={theme.text.subdued} pending="Skill" complete={true}>
      Skill {props.message.name}
    </InlineToolRow>
  )
}

function CompactionMessage(props: { message: Extract<SessionMessageInfo, { type: "compaction" }> }) {
  const ctx = use()
  const theme = useTheme()
  const { currentSyntax: syntax } = useThemes()
  const plugins = usePlugin()
  const status = () => props.message.status
  const cancelled = () => props.message.status === "failed" && props.message.error.type === "aborted"
  const text = () =>
    props.message.status === "failed" ? (cancelled() ? "" : props.message.error.message) : props.message.summary
  const content = createMemo(() => text().trim())
  const color = () => (status() === "failed" && !cancelled() ? theme.text.feedback.error.default : theme.text.subdued)
  // Usage of the compaction request itself; the resulting context size only shows on the next assistant step.
  const usage = () => {
    if (props.message.status === "running" || !props.message.tokens) return
    const tokens = props.message.tokens
    const input = tokens.input + tokens.cache.read + tokens.cache.write
    const output = tokens.output + tokens.reasoning
    if (input + output <= 0) return
    return `${Locale.number(input)} in · ${Locale.number(output)} out`
  }
  return (
    <box>
      <box flexDirection="row" alignItems="center">
        <box border={["top"]} borderColor={color()} flexGrow={1} />
        <box flexDirection="row" gap={1} paddingLeft={1} paddingRight={1}>
          <Switch>
            <Match when={status() === "running"}>
              <Show when={ctx.config.animations ?? true} fallback={<text fg={color()}>⋯</text>}>
                <spinner frames={SPINNER_FRAMES} interval={80} color={color()} />
              </Show>
            </Match>
            <Match when={status() === "failed" && !cancelled()}>
              <text fg={color()}>✗</text>
            </Match>
          </Switch>
          <text fg={color()}>
            {props.message.status === "completed" && props.message.providerContext
              ? "Provider compaction"
              : "Compaction"}
          </text>
          <Show when={cancelled()}>
            <text fg={color()}>· cancelled</text>
          </Show>
          <Show when={usage()}>
            <text fg={color()}>· {usage()}</text>
          </Show>
        </box>
        <box border={["top"]} borderColor={color()} flexGrow={1} />
      </box>
      <Show when={content()}>
        <box paddingTop={1} paddingLeft={3}>
          <markdown
            syntaxStyle={syntax()}
            renderNode={plugins.markdown()}
            streaming={true}
            internalBlockMode="top-level"
            content={content()}
            tableOptions={{ style: "grid", cellPaddingX: 1 }}
            conceal={ctx.markdownMode() === "rendered"}
            fg={theme.markdown.text}
            bg={theme.background.default}
          />
        </box>
      </Show>
    </box>
  )
}

function CompactionQueued() {
  const theme = useTheme()
  return (
    <box flexDirection="row" alignItems="center">
      <box border={["top"]} borderColor={theme.border.default} flexGrow={1} />
      <box flexDirection="row" gap={1} paddingLeft={1} paddingRight={1}>
        <text fg={theme.text.subdued}>◇</text>
        <text fg={theme.text.subdued}>Compaction queued</text>
      </box>
      <box border={["top"]} borderColor={theme.border.default} flexGrow={1} />
    </box>
  )
}

function statusLabel(status: "added" | "modified" | "deleted") {
  if (status === "added") return "A"
  if (status === "deleted") return "D"
  return "M"
}

function RevertMessage(props: {
  count: number
  files: ReadonlyArray<{
    readonly file: string
    readonly status: "added" | "modified" | "deleted"
    readonly additions: number
    readonly deletions: number
  }>
}) {
  const ctx = use()
  const theme = useTheme("elevated")
  const route = useRouteData("session")
  const client = useClient()
  const toast = useToast()
  const renderer = useRenderer()
  const [hover, setHover] = createSignal(false)
  const redoKey = Keymap.useShortcut("session.redo")
  return (
    <box
      onMouseOver={() => setHover(true)}
      onMouseOut={() => setHover(false)}
      onMouseUp={() => {
        if (renderer.getSelection()?.getSelectedText()) return
        void (async () => {
          const error = await client.api.session.revert.clear({ sessionID: route.sessionID }).then(
            () => undefined,
            (error) => error,
          )
          if (error) toast.show({ message: errorMessage(error), variant: "error", duration: 5000 })
        })()
      }}
      flexShrink={0}
      marginTop={1}
      border={["left"]}
      customBorderChars={SplitBorder.customBorderChars}
      borderColor={theme.background.default}
    >
      <box
        paddingTop={1}
        paddingBottom={1}
        paddingLeft={2}
        backgroundColor={hover() ? theme.raise(theme.background.default) : theme.background.default}
      >
        <text fg={theme.text.subdued}>
          {props.count} message{props.count === 1 ? "" : "s"} reverted
        </text>
        <Show when={props.files.length > 0}>
          <box paddingTop={1} paddingBottom={1} flexDirection="column">
            <For each={props.files}>
              {(file) => (
                <box flexDirection="row" gap={1} flexShrink={0}>
                  <text fg={theme.text.subdued}>{statusLabel(file.status)}</text>
                  <FilePath
                    value={file.file}
                    maxWidth={Math.max(
                      2,
                      ctx.width -
                        5 -
                        (file.additions > 0 ? stringWidth(`+${file.additions}`) + 1 : 0) -
                        (file.deletions > 0 ? stringWidth(`-${file.deletions}`) + 1 : 0),
                    )}
                    fg={theme.text.default}
                  />
                  <Show when={file.additions > 0}>
                    <text fg={theme.diff.text.added}>+{file.additions}</text>
                  </Show>
                  <Show when={file.deletions > 0}>
                    <text fg={theme.diff.text.removed}>-{file.deletions}</text>
                  </Show>
                </box>
              )}
            </For>
          </box>
        </Show>
        <text fg={theme.text.subdued}>
          <span style={{ fg: theme.text.default }}>{redoKey()}</span> or /redo to restore
        </text>
      </box>
    </box>
  )
}

function ShellMessage(props: { message: Extract<SessionMessageInfo, { type: "shell" }> }) {
  const error = createMemo(() => {
    if (props.message.status === "killed") return "Command cancelled"
    if (props.message.status === "timeout") return "Command timed out"
    if (props.message.exit !== undefined && props.message.exit !== 0)
      return `Command exited with code ${props.message.exit}`
  })

  return (
    <ShellDisplay
      shellID={props.message.shellID}
      command={props.message.command}
      status={props.message.status === "running" ? "running" : "completed"}
      output={props.message.output?.output}
      error={error()}
    />
  )
}

function UserMessage(props: { message: SessionMessageUser }) {
  const ctx = use()
  const data = useData()
  const local = useLocal()
  const files = createMemo(() => deduplicateVisibleImages(props.message.files ?? []))
  const skills = createMemo(() => props.message.skills ?? [])
  const images = createMemo(() =>
    files().flatMap((file) =>
      file.mime.startsWith("image/") ? [{ uri: `data:${file.mime};base64,${file.data}` }] : [],
    ),
  )
  const themes = useThemes()
  const theme = useTheme("elevated")
  const mode = themes.mode
  const [hover, setHover] = createSignal(false)
  const color = createMemo(() => local.agent.color(data.session.get(ctx.sessionID)?.agent ?? "build"))
  const delivery = createMemo(() => ctx.pendingDelivery(props.message.id))
  const dialog = useDialog()
  const renderer = useRenderer()
  const promptRef = usePromptRef()

  const updatePendingSteer = async (action: "queue" | "cancel") => {
    if (await ctx.mutatePending(action, props.message.id)) dialog.clear()
  }

  return (
    <Show when={props.message.text.trim() || files().length || skills().length}>
      <box
        border={["left"]}
        borderColor={delivery() ? theme.border.default : color()}
        customBorderChars={SplitBorder.customBorderChars}
        backgroundColor={theme.background.default}
      >
        <SessionImages images={images()} paddingLeft={2} />
        <box
          onMouseOver={() => {
            setHover(true)
          }}
          onMouseOut={() => {
            setHover(false)
          }}
          onMouseUp={() => {
            if (renderer.getSelection()?.getSelectedText()) return
            if (delivery() === "steer") {
              dialog.replace(() => (
                <DialogSelect
                  title="Pending steer"
                  options={[
                    { title: "Move to queue", value: "queue" as const },
                    { title: "Delete", value: "cancel" as const },
                  ]}
                  onSelect={(option) => {
                    void updatePendingSteer(option.value)
                  }}
                />
              ))
              return
            }
            dialog.replace(() => (
              <DialogMessage
                messageID={props.message.id}
                sessionID={ctx.sessionID}
                setPrompt={(value) => promptRef.current?.set(value)}
              />
            ))
          }}
          paddingTop={1}
          paddingBottom={1}
          paddingLeft={2}
          backgroundColor={hover() ? theme.raise(theme.background.default) : theme.background.default}
          flexShrink={0}
        >
          <text fg={theme.text.default}>{props.message.text}</text>
          <Show when={skills().length}>
            <box flexDirection="row" paddingTop={1} gap={1} flexWrap="wrap">
              <For each={skills()}>
                {(skill) => (
                  <text fg={theme.text.default}>
                    <span
                      style={{
                        bg: theme.hue.accent[mode() === "light" ? 700 : 200],
                        fg: theme.background.default,
                        bold: true,
                      }}
                    >
                      {" skill "}
                    </span>
                    <span style={{ bg: theme.raise(theme.background.default), fg: theme.text.subdued }}>
                      {` ${skill.name} `}
                    </span>
                  </text>
                )}
              </For>
            </box>
          </Show>
          <Show when={files().length}>
            <box flexDirection="row" paddingTop={1} gap={1} flexWrap="wrap">
              <For each={files()}>
                {(file) => {
                  const label = file.mime === "application/x-directory" ? "dir" : "file"
                  return (
                    <text fg={theme.text.default}>
                      <span
                        style={{
                          bg: theme.hue.accent[mode() === "light" ? 700 : 200],
                          fg: theme.background.default,
                          bold: true,
                        }}
                      >
                        {` ${label} `}
                      </span>
                      <span style={{ bg: theme.raise(theme.background.default), fg: theme.text.subdued }}>
                        {" "}
                        {file.name ?? (file.source.type === "uri" ? file.source.uri : "attachment")}{" "}
                      </span>
                    </text>
                  )
                }}
              </For>
            </box>
          </Show>
        </box>
      </box>
    </Show>
  )
}

function QueuedPromptDock(props: { prompts: { id: string; text: string }[]; onOpen: () => void }) {
  const theme = useTheme("elevated")
  const [hover, setHover] = createSignal(false)
  const next = createMemo(() => props.prompts[0]?.text.replaceAll("\n", " "))

  return (
    <box
      border={["left"]}
      borderColor={theme.border.default}
      customBorderChars={SplitBorder.customBorderChars}
      onMouseOver={() => setHover(true)}
      onMouseOut={() => setHover(false)}
      onMouseUp={props.onOpen}
    >
      <box
        width="100%"
        paddingTop={1}
        paddingBottom={1}
        paddingLeft={2}
        paddingRight={1}
        backgroundColor={hover() ? theme.raise(theme.background.default) : theme.background.default}
        flexDirection="row"
      >
        <text fg={theme.text.subdued} wrapMode="none" truncate flexGrow={1} flexShrink={1} minWidth={0}>
          <span style={{ fg: theme.text.default }}>{props.prompts.length} queued</span>
          <Show when={next()}>{(text) => <> · {text()}</>}</Show>
        </text>
      </box>
    </box>
  )
}

function AssistantRetry(props: { retry: SessionMessageAssistant["retry"] }) {
  const theme = useTheme()
  const [seconds, setSeconds] = createSignal(0)
  createEffect(() => {
    const at = props.retry?.at
    if (at === undefined) return
    const update = () => setSeconds(Math.max(0, Math.ceil((at - Date.now()) / 1_000)))
    if (update() === 0) return
    const timer = setInterval(() => {
      if (update() === 0) clearInterval(timer)
    }, 1_000)
    onCleanup(() => clearInterval(timer))
  })
  return (
    <Show when={props.retry}>
      {(retry) => (
        <box paddingLeft={3}>
          <text fg={theme.text.feedback.warning.default}>
            ⚠ {seconds() > 0 ? `Retrying in ${seconds()}s` : "Retry due"} · attempt {retry().attempt} ·{" "}
            {retry().error.message}
          </text>
        </box>
      )}
    </Show>
  )
}

// Pending messages moved to individual tool pending functions

function ToolPart(props: { part: SessionMessageAssistantTool; images?: boolean }) {
  const display = createMemo(() => toolDisplay(props.part.name))

  const toolprops = {
    get metadata() {
      return toolDisplayMetadata(props.part.state)
    },
    get input() {
      return typeof props.part.state.input === "string" ? {} : props.part.state.input
    },
    get output() {
      if (props.part.state.status === "streaming") return undefined
      return toolDisplayContent(props.part.state)
        .flatMap((content) => (content.type === "text" ? [content.text] : [content.name ?? content.uri]))
        .join("\n")
    },
    get tool() {
      return props.part.name
    },
    get part() {
      return props.part
    },
  }

  const content = (
    <Switch>
      <Match when={display() === "shell"}>
        <Shell {...toolprops} />
      </Match>
      <Match when={display() === "glob"}>
        <Glob {...toolprops} />
      </Match>
      <Match when={display() === "read"}>
        <Read {...toolprops} />
      </Match>
      <Match when={display() === "grep"}>
        <Grep {...toolprops} />
      </Match>
      <Match when={display() === "webfetch"}>
        <WebFetch {...toolprops} />
      </Match>
      <Match when={display() === "websearch"}>
        <WebSearch {...toolprops} />
      </Match>
      <Match when={display() === "write"}>
        <Write {...toolprops} />
      </Match>
      <Match when={display() === "edit"}>
        <Edit {...toolprops} />
      </Match>
      <Match when={display() === "subagent"}>
        <Subagent {...toolprops} />
      </Match>
      <Match when={display() === "execute"}>
        <Execute {...toolprops} />
      </Match>
      <Match when={display() === "patch"}>
        <ApplyPatch {...toolprops} />
      </Match>
      <Match when={display() === "question"}>
        <Question {...toolprops} />
      </Match>
      <Match when={display() === "skill"}>
        <Skill {...toolprops} />
      </Match>
      <Match when={true}>
        <GenericTool {...toolprops} />
      </Match>
    </Switch>
  )
  return [
    content,
    <Show when={props.images !== false}>
      <ToolImages parts={[props.part]} />
    </Show>,
  ]
}

function ToolImages(props: { parts: readonly SessionMessageAssistantTool[] }) {
  const images = createMemo(() => props.parts.flatMap(inlineToolImages))
  return <SessionImages images={images()} />
}

function SessionImages(props: { images: readonly { uri: string }[]; paddingLeft?: number }) {
  const ctx = use()
  const dialog = useDialog()
  const images = createMemo(() => (ctx.config.session?.image_preview ? props.images : []))
  const height = createMemo(() => Math.max(4, Math.min(8, Math.floor(ctx.terminal.height / 4))))
  const visible = createMemo(() => images().slice(0, 3))

  return (
    <Show when={visible().length > 0}>
      <box
        flexDirection="row"
        flexShrink={0}
        paddingTop={1}
        paddingLeft={props.paddingLeft ?? 3}
        paddingRight={2}
        paddingBottom={1}
        gap={1}
      >
        <For each={visible()}>
          {(image, index) => {
            const [failed, setFailed] = createSignal(false)
            return (
              <box
                width={height() * 2}
                height={height()}
                flexBasis={height() * 2}
                flexShrink={1}
                alignItems="center"
                justifyContent="center"
                onMouseUp={(event: MouseEvent) => {
                  if (event.button !== 0) return
                  event.stopPropagation()
                  dialog.replace(() => <DialogImagePreview images={images()} initial={index()} />)
                }}
              >
                <Show when={!failed()} fallback={<text>No preview</text>}>
                  <image
                    source={image.uri}
                    fit="cover"
                    protocol="auto"
                    width="100%"
                    height="100%"
                    onError={() => setFailed(true)}
                  />
                </Show>
              </box>
            )
          }}
        </For>
        <Show when={images().length > visible().length}>
          <box width={8} height={height()} flexShrink={1} alignItems="center" justifyContent="center">
            <text wrapMode="none" truncate>
              +{images().length - visible().length} more
            </text>
          </box>
        </Show>
      </box>
    </Show>
  )
}

function inlineToolImages(part: SessionMessageAssistantTool) {
  return toolDisplayContent(part.state).flatMap((content) =>
    content.type === "file" && content.mime.startsWith("image/") && content.uri.startsWith("data:image/")
      ? [{ uri: content.uri }]
      : [],
  )
}

type ToolProps = {
  input: Record<string, unknown>
  metadata: Record<string, unknown>
  tool: string
  output?: string
  part: SessionMessageAssistantTool
}
function GenericTool(props: ToolProps) {
  const theme = useTheme()
  const output = createMemo(() => props.output?.trim() ?? "")
  const input = createMemo(() => Object.entries(props.input))
  const [expanded, setExpanded] = createSignal(false)
  const expandable = createMemo(() => input().length > 0 || output().length > 0)
  const loading = createMemo(() => props.part.state.status === "streaming" || props.part.state.status === "running")

  return (
    <>
      <InlineTool
        icon={props.part.state.status === "error" ? "✗" : "✓"}
        complete={props.part.state.status === "completed"}
        pending={props.tool}
        spinner={loading()}
        part={props.part}
        onClick={expandable() ? () => setExpanded((value) => !value) : undefined}
      >
        {genericToolSummary(props.tool, props.input)}
      </InlineTool>
      <Show when={expanded()}>
        <box paddingLeft={3 + INLINE_TOOL_ICON_WIDTH}>
          <For each={input()}>
            {([key, value]) => (
              <box flexDirection="row">
                <text flexShrink={0} fg={theme.text.subdued}>
                  {key}:{" "}
                </text>
                <text flexGrow={1} wrapMode="word" fg={theme.text.default}>
                  {typeof value === "string" ? value : JSON.stringify(value, null, 2)}
                </text>
              </box>
            )}
          </For>
          <Show when={output()}>
            {(value) => (
              <box flexDirection="row">
                <text flexShrink={0} fg={theme.text.subdued}>
                  output:{" "}
                </text>
                <text flexGrow={1} fg={theme.text.default} wrapMode="word">
                  {value()}
                </text>
              </box>
            )}
          </Show>
        </box>
      </Show>
    </>
  )
}

export function genericToolSummary(tool: string, input: Record<string, unknown>) {
  const args = primitiveInputSummary(input).replace(/\s+/g, " ")
  return `${tool}${args ? ` ${args}` : ""}`
}

function useToolPermission(part: () => SessionMessageAssistantTool | undefined) {
  const ctx = use()
  const data = useData()
  const local = useLocal()
  return createMemo(() => {
    if (local.permission.mode === "autoaccept") return false
    const request = data.session.permission.list(ctx.sessionID)?.[0]
    return request?.source?.type === "tool" && request.source.id === part()?.id
  })
}

function InlineTool(props: {
  icon: string
  iconColor?: RGBA
  color?: RGBA
  complete: unknown
  pending: string
  failure?: string
  spinner?: boolean
  running?: boolean
  status?: JSX.Element
  children: JSX.Element
  part: SessionMessageAssistantTool
  onClick?: () => void
}) {
  const theme = useTheme()
  const renderer = useRenderer()
  const [hover, setHover] = createSignal(false)
  const [errorExpanded, setErrorExpanded] = createSignal(false)
  const permission = useToolPermission(() => props.part)

  const error = createMemo(() =>
    !props.running && props.part.state.status === "error" ? props.part.state.error.message : undefined,
  )

  const denied = createMemo(
    () =>
      error()?.includes("QuestionRejectedError") ||
      error()?.includes("rejected permission") ||
      error()?.includes("specified a rule") ||
      error()?.includes("user dismissed"),
  )

  const failed = createMemo(() => Boolean(error() && !denied()))
  const clickable = createMemo(() => Boolean(props.onClick || failed()))
  const fg = createMemo(() => {
    if (props.color) return props.color
    if (permission()) return theme.text.feedback.warning.default
    if (failed()) return theme.text.feedback.error.default
    if (hover() && props.onClick) return theme.text.default
    return theme.text.subdued
  })

  return (
    <InlineToolRow
      icon={props.icon}
      iconColor={props.iconColor}
      color={fg()}
      errorColor={theme.text.feedback.error.default}
      failed={failed()}
      denied={Boolean(denied())}
      error={error()}
      errorExpanded={errorExpanded()}
      complete={props.complete}
      pending={props.pending}
      failure={props.failure}
      spinner={props.spinner}
      status={props.status}
      onMouseOver={() => clickable() && setHover(true)}
      onMouseOut={() => setHover(false)}
      onMouseUp={() => {
        if (renderer.getSelection()?.getSelectedText()) return
        if (failed()) {
          setErrorExpanded((value) => !value)
          return
        }
        props.onClick?.()
      }}
    >
      {props.children}
    </InlineToolRow>
  )
}

function StatusBadge(props: { children: string }) {
  const theme = useTheme()
  return (
    <text flexShrink={0} bg={theme.raise(theme.background.default)} fg={theme.text.subdued}>
      {" "}
      {props.children}{" "}
    </text>
  )
}

type BlockToolProps = {
  title?: string
  path?: { label: string; value: string }
  headerColor?: RGBA
  children?: JSX.Element
  onClick?: () => void
  part?: SessionMessageAssistantTool
  spinner?: boolean
  error?: string
  errorColor?: RGBA
}

function BlockTool(props: BlockToolProps) {
  const parentTheme = useTheme()
  return (
    <ThemeContextProvider context="elevated">
      <BlockToolContent {...props} borderColor={parentTheme.background.default} />
    </ThemeContextProvider>
  )
}

function BlockToolContent(props: BlockToolProps & { borderColor: RGBA }) {
  const theme = useTheme()
  const ctx = use()
  const renderer = useRenderer()
  const [hover, setHover] = createSignal(false)
  const error = createMemo(
    () => props.error ?? (props.part?.state.status === "error" ? props.part.state.error.message : undefined),
  )
  const permission = useToolPermission(() => props.part)
  return (
    <box
      border={["left"]}
      paddingTop={1}
      paddingBottom={1}
      paddingLeft={2}
      gap={1}
      backgroundColor={hover() ? theme.raise(theme.background.default) : theme.background.default}
      customBorderChars={SplitBorder.customBorderChars}
      borderColor={props.borderColor}
      onMouseOver={() => props.onClick && setHover(true)}
      onMouseOut={() => setHover(false)}
      onMouseUp={() => {
        if (renderer.getSelection()?.getSelectedText()) return
        props.onClick?.()
      }}
    >
      <Show
        when={props.path}
        fallback={
          <Show when={props.title}>
            {(title) => (
              <Show
                when={props.spinner}
                fallback={
                  <text
                    fg={permission() ? theme.text.feedback.warning.default : (props.headerColor ?? theme.text.subdued)}
                  >
                    {title()}
                  </text>
                }
              >
                <Spinner color={permission() ? theme.text.feedback.warning.default : theme.text.subdued}>
                  {title().replace(/^# /, "")}
                </Spinner>
              </Show>
            )}
          </Show>
        }
      >
        {(path) => (
          <box flexDirection="row" gap={1} minWidth={0}>
            <Show
              when={props.spinner}
              fallback={
                <text
                  flexShrink={0}
                  fg={permission() ? theme.text.feedback.warning.default : (props.headerColor ?? theme.text.subdued)}
                >
                  {path().label}
                </text>
              }
            >
              <Spinner color={permission() ? theme.text.feedback.warning.default : theme.text.subdued}>
                {path().label.replace(/^# /, "")}
              </Spinner>
            </Show>
            <FilePath
              value={path().value}
              maxWidth={Math.max(2, ctx.width - 4 - stringWidth(path().label) - (props.spinner ? 2 : 0))}
              fg={permission() ? theme.text.feedback.warning.default : (props.headerColor ?? theme.text.subdued)}
            />
          </box>
        )}
      </Show>
      {props.children}
      <Show when={error()}>
        <text fg={props.errorColor ?? theme.text.feedback.error.default}>{error()}</text>
      </Show>
    </box>
  )
}

const SHELL_DISPLAY_LIMIT = 1024 * 1024

function Shell(props: ToolProps) {
  return (
    <ShellDisplay
      part={props.part}
      shellID={stringValue(props.metadata.shellID)}
      command={stringValue(props.input.command)}
      workdir={stringValue(props.input.workdir)}
      status={props.part.state.status}
      background={Boolean(stringValue(props.metadata.shellID)) && props.part.state.status !== "running"}
      output={stringValue(props.metadata.shellID) ? undefined : props.output}
    />
  )
}

function ShellDisplay(props: {
  part?: SessionMessageAssistantTool
  shellID?: string
  command?: string
  workdir?: string
  status: SessionMessageAssistantTool["state"]["status"]
  background?: boolean
  output?: string
  error?: string
}) {
  const theme = useTheme()
  const ctx = use()
  const client = useClient()
  const data = useData()
  const pathFormatter = usePathFormatter()
  // A Session can move while its shell is still running in the original Location.
  const location = data.shell.get(props.shellID ?? "")?.location ?? data.session.get(ctx.sessionID)?.location
  const permission = useToolPermission(() => props.part)
  const color = createMemo(() => (permission() ? theme.text.feedback.warning.default : theme.text.default))
  const backgroundRunning = createMemo(() => {
    const id = props.shellID
    return Boolean(id && data.shell.get(id))
  })
  const isRunning = createMemo(() => props.status === "running" || backgroundRunning())
  const workdir = createMemo(() => pathFormatter.format(props.workdir))
  const [expanded, setExpanded] = createSignal(false)
  const [backgroundOutput, setBackgroundOutput] = createSignal("")
  const [outputTruncated, setOutputTruncated] = createSignal(false)
  let loading = false
  let drainRequested = false
  let cursor = 0
  let wasRunning = false
  const loadBackgroundOutput = async (drain = false) => {
    if (props.status === "completed" && props.output !== undefined) return
    const id = props.shellID
    if (!id) return
    if (loading) {
      if (drain) drainRequested = true
      return
    }
    loading = true
    do {
      const response = await client.api.shell
        .output({
          id,
          cursor,
          limit: SHELL_DISPLAY_LIMIT,
          location: location ? { directory: location.directory, workspace: location.workspaceID } : undefined,
        })
        .catch(() => undefined)
      if (!response) break
      if (response.data.output)
        setBackgroundOutput((output) => {
          const next = stripAnsi(output + response.data.output)
          if (next.length <= SHELL_DISPLAY_LIMIT) return next
          setOutputTruncated(true)
          return next.slice(-SHELL_DISPLAY_LIMIT)
        })
      if (response.data.cursor <= cursor) break
      cursor = response.data.cursor
      if (!drain || cursor >= response.data.size) break
      const tail = Math.max(cursor, response.data.size - SHELL_DISPLAY_LIMIT)
      if (tail > cursor) {
        cursor = tail
        setOutputTruncated(true)
      }
    } while (true)
    loading = false
    if (drainRequested) {
      drainRequested = false
      void loadBackgroundOutput(true)
    }
  }
  createEffect(() => {
    const running = backgroundRunning()
    if (!running) {
      if (wasRunning) void loadBackgroundOutput(true)
      wasRunning = false
      return
    }
    wasRunning = true
    if (props.background && !expanded()) return
    void loadBackgroundOutput()
    const interval = setInterval(() => void loadBackgroundOutput(), 1_000)
    onCleanup(() => clearInterval(interval))
  })
  const output = createMemo(() => {
    if (props.status === "streaming") return ""
    if (props.shellID) {
      if (props.background && !expanded()) return ""
      if (props.status === "completed" && props.output !== undefined) return stripAnsi(props.output.trim())
      const text = stripAnsi((backgroundOutput() || props.output || "").trim())
      return outputTruncated() ? `[earlier output omitted]\n${text}` : text
    }
    return stripAnsi(props.output?.trim() ?? "")
  })
  const maxLines = 10
  const maxChars = createMemo(() => maxLines * Math.max(20, ctx.width - 6))
  const prefix = createMemo(() => (workdir() && workdir() !== "." ? `cd ${workdir()} && ` : ""))
  const input = createMemo(() => (props.command ? `${isRunning() ? "" : "$ "}${prefix()}${props.command}` : ""))
  const content = createMemo(() => [input(), output()].filter(Boolean).join("\n\n"))
  const collapsed = createMemo(() => collapseToolOutput(content(), maxLines, maxChars()))
  const limited = createMemo(() => {
    if (expanded() || !collapsed().overflow) return content()
    return collapsed().output
  })
  const limitedInput = createMemo(() => limited().slice(0, input().length))
  const limitedOutput = createMemo(() => limited().slice(Math.min(limited().length, input().length + 2)))
  const expandable = createMemo(() => Boolean(props.shellID) || collapsed().overflow)
  const toggle = () => {
    const next = !expanded()
    setExpanded(next)
    if (next) void loadBackgroundOutput(!backgroundRunning())
  }

  return (
    <BlockTool part={props.part} error={props.error} onClick={expandable() ? toggle : undefined}>
      <box gap={1}>
        <Show
          when={props.command}
          fallback={
            isRunning() || props.status === "streaming" ? (
              <Spinner color={color()}>Writing command…</Spinner>
            ) : (
              <text fg={theme.text.subdued}>Writing command…</text>
            )
          }
        >
          <Show when={isRunning()} fallback={<text fg={theme.text.default}>{limitedInput()}</text>}>
            <Spinner color={color()}>{limitedInput()}</Spinner>
          </Show>
          <Show when={limitedOutput()}>
            <text fg={theme.text.subdued}>{limitedOutput()}</text>
          </Show>
        </Show>
        <Show when={props.background}>
          <StatusBadge>Background</StatusBadge>
        </Show>
      </box>
    </BlockTool>
  )
}

function Write(props: ToolProps) {
  const theme = useTheme()
  const { currentSyntax: syntax } = useThemes()
  const pathFormatter = usePathFormatter()
  const code = createMemo(() => {
    return stringValue(props.input.content) ?? ""
  })

  return (
    <Switch>
      <Match when={props.part.state.status === "completed"}>
        <BlockTool
          path={{ label: "# Wrote", value: pathFormatter.format(stringValue(props.input.path)) }}
          part={props.part}
        >
          <line_number fg={theme.text.subdued} minWidth={3} paddingRight={1}>
            <code
              conceal={false}
              fg={theme.text.default}
              filetype={filetype(stringValue(props.input.path))}
              syntaxStyle={syntax()}
              content={code()}
            />
          </line_number>
          <Diagnostics diagnostics={props.metadata.diagnostics} filePath={stringValue(props.input.path) ?? ""} />
        </BlockTool>
      </Match>
      <Match when={true}>
        <InlineTool icon="←" pending="Preparing write…" complete={stringValue(props.input.path)} part={props.part}>
          Write {pathFormatter.format(stringValue(props.input.path))}
        </InlineTool>
      </Match>
    </Switch>
  )
}

function Glob(props: ToolProps) {
  const pathFormatter = usePathFormatter()
  return (
    <InlineTool icon="✱" pending="Finding files…" complete={stringValue(props.input.pattern)} part={props.part}>
      Glob "{stringValue(props.input.pattern)}"{" "}
      <Show when={stringValue(props.input.path)}>in {pathFormatter.format(stringValue(props.input.path))} </Show>
      <Show when={finiteNumber(props.metadata.count)}>
        ({finiteNumber(props.metadata.count)} {finiteNumber(props.metadata.count) === 1 ? "match" : "matches"})
      </Show>
    </InlineTool>
  )
}

function Read(props: ToolProps) {
  const theme = useTheme()
  const pathFormatter = usePathFormatter()
  const isRunning = createMemo(() => props.part.state.status === "running")
  const loaded = createMemo(() => {
    if (props.part.state.status !== "completed") return []
    const value = props.metadata.loaded
    if (!value || !Array.isArray(value)) return []
    return value.filter((p): p is string => typeof p === "string")
  })
  return (
    <>
      <InlineTool
        icon="→"
        pending="Reading file…"
        complete={stringValue(props.input.path)}
        spinner={isRunning()}
        part={props.part}
      >
        Read {pathFormatter.format(stringValue(props.input.path))}
      </InlineTool>
      <For each={loaded()}>
        {(filepath) => (
          <box paddingLeft={3}>
            <text paddingLeft={3} fg={theme.text.subdued}>
              ↳ Loaded {pathFormatter.format(filepath)}
            </text>
          </box>
        )}
      </For>
    </>
  )
}

function Grep(props: ToolProps) {
  const pathFormatter = usePathFormatter()
  return (
    <InlineTool icon="✱" pending="Searching content…" complete={stringValue(props.input.pattern)} part={props.part}>
      Grep "{stringValue(props.input.pattern)}"{" "}
      <Show when={stringValue(props.input.path)}>in {pathFormatter.format(stringValue(props.input.path))} </Show>
      <Show when={finiteNumber(props.metadata.matches)}>
        ({finiteNumber(props.metadata.matches)} {finiteNumber(props.metadata.matches) === 1 ? "match" : "matches"})
      </Show>
    </InlineTool>
  )
}

function WebFetch(props: ToolProps) {
  return (
    <InlineTool icon="%" pending="Fetching from the web…" complete={stringValue(props.input.url)} part={props.part}>
      WebFetch {stringValue(props.input.url)}
    </InlineTool>
  )
}

function WebSearch(props: ToolProps) {
  const ctx = use()
  const provider = createMemo(() => stringValue(props.metadata.provider))
  return (
    <InlineTool icon="◈" pending="Searching web…" complete={stringValue(props.input.query)} part={props.part}>
      <Show when={provider()} fallback="Web Search">
        {(value) => (
          <>
            Web Search via{" "}
            <RetryProvider
              value={{
                id: `${ctx.sessionID}:${props.part.time.created}:${props.part.id}`,
                provider: value(),
                running: props.part.state.status === "running",
              }}
              enabled={ctx.config.animations ?? true}
            />
          </>
        )}
      </Show>{" "}
      "{stringValue(props.input.query)}"
    </InlineTool>
  )
}

function Subagent(props: ToolProps) {
  const { navigate } = useRoute()
  const data = useData()
  const sessionID = createMemo(() => stringValue(props.metadata.sessionID) ?? stringValue(props.metadata.sessionId))
  const description = createMemo(() => stringValue(props.input.description))
  const continuation = createMemo(() => Boolean(stringValue(props.input.sessionID)))
  const isRunning = createMemo(() => {
    const id = sessionID()
    return props.part.state.status === "running" || Boolean(id && data.session.status(id) === "running")
  })

  return (
    <InlineTool
      icon={continuation() ? "↳" : isRunning() ? "│" : props.part.state.status === "completed" ? "✓" : "│"}
      spinner={!continuation() && isRunning()}
      running={isRunning()}
      complete={description()}
      pending="Delegating…"
      part={props.part}
      onClick={() => {
        const id = sessionID()
        if (id) navigate({ type: "session", sessionID: id })
      }}
      status={
        isBackgroundSubagent(props.metadata, props.part.state.status) ? (
          <StatusBadge>Background</StatusBadge>
        ) : undefined
      }
    >
      {continuation()
        ? `Continue subagent — ${description() ?? "Subagent"}`
        : `${Locale.titlecase(stringValue(props.input.agent) ?? stringValue(props.input.subagent_type) ?? "General")} Subagent — ${description() ?? "Subagent"}`}
    </InlineTool>
  )
}

export function isBackgroundSubagent(
  metadata: Record<string, unknown>,
  status: SessionMessageAssistantTool["state"]["status"],
) {
  return status === "completed" && metadata.status === "running"
}

type ExecuteCall = { tool: string; status: "running" | "completed" | "error"; input?: Record<string, unknown> }

function executeCalls(value: unknown): ExecuteCall[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((call) => {
    const item = recordValue(call)
    const tool = stringValue(item?.tool)
    const status = stringValue(item?.status)
    if (!tool || !status || !["running", "completed", "error"].includes(status)) return []
    return [{ tool, status: status as ExecuteCall["status"], input: recordValue(item?.input) }]
  })
}

export function executeCallSummary(call: ExecuteCall) {
  const args = primitiveInputSummary(call.input ?? {}).replace(/\s+/g, " ")
  return `${call.tool}${args ? ` ${args}` : ""}`
}

function ExecuteCallView(props: { call: Accessor<ExecuteCall> }) {
  const theme = useTheme()
  const renderer = useRenderer()
  const [expanded, setExpanded] = createSignal(false)
  const [hover, setHover] = createSignal(false)
  const input = createMemo(() => Object.entries(props.call().input ?? {}))
  const expandable = createMemo(() => input().length > 0)
  const expandedColor = createMemo(() => theme.raise(theme.text.subdued))
  const color = createMemo(() => {
    if (props.call().status === "error") return theme.text.feedback.error.default
    if (hover()) return theme.text.default
    return expanded() ? expandedColor() : theme.text.subdued
  })

  return (
    <box
      paddingLeft={3}
      onMouseOver={() => expandable() && setHover(true)}
      onMouseOut={() => setHover(false)}
      onMouseUp={() => {
        if (!expandable() || renderer.getSelection()?.getSelectedText()) return
        setExpanded((value) => !value)
      }}
    >
      <box flexDirection="row">
        <box width={INLINE_TOOL_ICON_WIDTH} flexShrink={0}>
          <text fg={color()}>{props.call().status === "error" ? "✗" : "›"}</text>
        </box>
        <text flexGrow={1} wrapMode="none" truncate fg={color()}>
          {expanded() ? props.call().tool : executeCallSummary(props.call())}
        </text>
      </box>
      <Show when={expanded()}>
        <box paddingLeft={1} border={["left"]} borderColor={expandedColor()}>
          <For each={input()}>
            {([key, value]) => (
              <box flexDirection="row">
                <text flexShrink={0} fg={theme.text.subdued}>
                  {key}:{" "}
                </text>
                <text flexGrow={1} wrapMode="word" fg={theme.text.default}>
                  {typeof value === "string" ? value : JSON.stringify(value, null, 2)}
                </text>
              </box>
            )}
          </For>
        </box>
      </Show>
    </box>
  )
}

// The `execute` tool streams child tool calls through metadata, not a child session like Task.
function Execute(props: ToolProps) {
  const ctx = use()
  const theme = useTheme()
  const isLoading = createMemo(() => props.part.state.status === "streaming" || props.part.state.status === "running")
  const calls = createMemo(() => executeCalls(props.metadata.toolCalls))
  const output = createMemo(() => stripAnsi(props.output?.trim() ?? ""))
  const hasRuntimeError = createMemo(() => props.metadata.error === true || props.part.state.status === "error")
  const outputPreview = createMemo(() => collapseToolOutput(output(), 4, 4 * Math.max(20, ctx.width - 6)).output)
  const showOutput = createMemo(() => output() && hasRuntimeError())

  return (
    <>
      <InlineTool
        icon={hasRuntimeError() ? "✗" : props.part.state.status === "completed" ? "✓" : "│"}
        color={hasRuntimeError() ? theme.text.feedback.error.default : undefined}
        spinner={isLoading()}
        pending="execute"
        complete={true}
        part={props.part}
      >
        execute
      </InlineTool>
      <Index each={calls()}>{(call) => <ExecuteCallView call={call} />}</Index>
      <Show when={showOutput()}>
        <box paddingLeft={3}>
          <For each={outputPreview().split("\n")}>
            {(line, index) => (
              <text paddingLeft={3} fg={theme.text.feedback.error.default}>
                {index() === 0 ? "↳ " : "  "}
                {line}
              </text>
            )}
          </For>
        </box>
      </Show>
    </>
  )
}

function Edit(props: ToolProps) {
  const ctx = use()
  const theme = useTheme()
  const { currentSyntax: syntax } = useThemes()
  const pathFormatter = usePathFormatter()

  const view = createMemo(() => {
    const diffView = ctx.config.diffs?.view
    if (diffView === "unified") return "unified"
    if (diffView === "split") return "split"
    // Default to "auto" behavior
    return ctx.width > 120 ? "split" : "unified"
  })

  const file = createMemo(() => parseApplyPatchFiles(props.metadata.files)[0])
  const path = createMemo(() => file()?.relativePath ?? stringValue(props.input.path))

  return (
    <Switch>
      <Match when={file()}>
        {(item) => (
          <BlockTool path={{ label: "← Edit", value: pathFormatter.format(path()) }} part={props.part}>
            <box paddingLeft={1}>
              <PatchDiff
                diff={item().patch}
                hunkFg={theme.diff.text.hunkHeader}
                view={view()}
                filetype={filetype(path())}
                syntaxStyle={syntax()}
                showLineNumbers={true}
                width="100%"
                wrapMode={ctx.diffWrapMode()}
                fg={theme.text.default}
                addedBg={theme.diff.background.added}
                removedBg={theme.diff.background.removed}
                contextBg={theme.diff.background.context}
                addedSignColor={theme.diff.highlight.added}
                removedSignColor={theme.diff.highlight.removed}
                lineNumberFg={theme.diff.lineNumber.text}
                lineNumberBg={theme.diff.background.context}
                addedLineNumberBg={theme.diff.lineNumber.background.added}
                removedLineNumberBg={theme.diff.lineNumber.background.removed}
              />
            </box>
            <Diagnostics diagnostics={props.metadata.diagnostics} filePath={stringValue(props.input.path) ?? ""} />
          </BlockTool>
        )}
      </Match>
      <Match when={true}>
        <BlockTool
          path={
            stringValue(props.input.path)
              ? { label: "← Edit", value: pathFormatter.format(stringValue(props.input.path)) }
              : undefined
          }
          title={stringValue(props.input.path) ? undefined : "# Preparing edit…"}
          part={props.part}
          spinner={props.part.state.status === "streaming"}
        />
      </Match>
    </Switch>
  )
}

function ApplyPatch(props: ToolProps) {
  const ctx = use()
  const theme = useTheme()
  const { currentSyntax: syntax } = useThemes()
  const pathFormatter = usePathFormatter()
  const files = createMemo(() => parseApplyPatchFiles(props.metadata.files))
  const targets = createMemo(() => {
    const patch = stringValue(props.input.patchText)
    if (!patch) return []
    return [...patch.matchAll(/\*\*\* (?:Add|Update|Delete) File: ([^\r\n]+)/g)].map((match) => match[1].trim())
  })
  const applied = createMemo(() => {
    const applied = props.metadata.applied
    if (!Array.isArray(applied)) return []
    return applied.flatMap((value) => {
      const item = recordValue(value)
      const type = stringValue(item?.type)
      const resource = stringValue(item?.resource)
      return type && resource ? [{ type, resource }] : []
    })
  })
  const view = createMemo(() => {
    if (ctx.config.diffs?.view === "unified") return "unified"
    if (ctx.config.diffs?.view === "split") return "split"
    return ctx.width > 120 ? "split" : "unified"
  })

  return (
    <Switch>
      <Match when={files().length > 0}>
        <box flexDirection="column" gap={1}>
          <For each={files()}>
            {(file) => (
              <BlockTool
                path={{
                  label: file.type === "add" ? "# Created" : file.type === "delete" ? "# Deleted" : "← Patched",
                  value: pathFormatter.format(file.relativePath),
                }}
                part={props.part}
              >
                <Show
                  when={file.type !== "delete"}
                  fallback={
                    <text fg={theme.diff.text.removed}>
                      -{file.deletions} line{file.deletions !== 1 ? "s" : ""}
                    </text>
                  }
                >
                  <box paddingLeft={1}>
                    <PatchDiff
                      diff={file.patch}
                      hunkFg={theme.diff.text.hunkHeader}
                      view={view()}
                      filetype={filetype(file.relativePath)}
                      syntaxStyle={syntax()}
                      showLineNumbers={true}
                      width="100%"
                      wrapMode={ctx.diffWrapMode()}
                      fg={theme.text.default}
                      addedBg={theme.diff.background.added}
                      removedBg={theme.diff.background.removed}
                      contextBg={theme.diff.background.context}
                      addedSignColor={theme.diff.highlight.added}
                      removedSignColor={theme.diff.highlight.removed}
                      lineNumberFg={theme.diff.lineNumber.text}
                      lineNumberBg={theme.diff.background.context}
                      addedLineNumberBg={theme.diff.lineNumber.background.added}
                      removedLineNumberBg={theme.diff.lineNumber.background.removed}
                    />
                  </box>
                </Show>
              </BlockTool>
            )}
          </For>
        </box>
      </Match>
      <Match when={applied().length > 0}>
        <box flexDirection="column" gap={1}>
          <For each={applied()}>
            {(file) => (
              <BlockTool
                path={{
                  label: file.type === "add" ? "# Created" : file.type === "delete" ? "# Deleted" : "← Patched",
                  value: pathFormatter.format(file.resource),
                }}
                part={props.part}
              >
                <FilePath
                  value={file.resource}
                  maxWidth={Math.max(2, ctx.width - 3)}
                  fg={file.type === "delete" ? theme.diff.text.removed : theme.text.subdued}
                />
              </BlockTool>
            )}
          </For>
        </box>
      </Match>
      <Match when={true}>
        <BlockTool
          path={
            targets().length === 1
              ? {
                  label: props.part.state.status === "error" ? "# Patch failed" : "Patching",
                  value: pathFormatter.format(targets()[0]),
                }
              : undefined
          }
          title={
            targets().length === 1 ? undefined : props.part.state.status === "error" ? "# Patch failed" : "Patching"
          }
          part={props.part}
          spinner={props.part.state.status === "streaming" || props.part.state.status === "running"}
          headerColor={props.part.state.status === "error" ? theme.text.feedback.error.default : undefined}
          errorColor={props.part.state.status === "error" ? theme.text.subdued : undefined}
        />
      </Match>
    </Switch>
  )
}

function Question(props: ToolProps) {
  const theme = useTheme()
  const questions = createMemo(() => parseQuestions(props.input.questions))
  const answers = createMemo(() => parseQuestionAnswers(props.metadata.answers))
  const count = createMemo(() => questions().length)

  function format(answer?: ReadonlyArray<string>) {
    if (!answer?.length) return "(no answer)"
    return answer.join(", ")
  }

  return (
    <Switch>
      <Match when={answers()}>
        <BlockTool title="# Questions" part={props.part}>
          <box gap={1}>
            <For each={questions()}>
              {(q, i) => (
                <box flexDirection="column">
                  <text fg={theme.text.subdued}>{q.question}</text>
                  <text fg={theme.text.default}>{format(answers()?.[i()])}</text>
                </box>
              )}
            </For>
          </box>
        </BlockTool>
      </Match>
      <Match when={true}>
        <InlineTool icon="→" pending="Asking questions…" complete={count()} part={props.part}>
          Asked {count()} question{count() !== 1 ? "s" : ""}
        </InlineTool>
      </Match>
    </Switch>
  )
}

function Skill(props: ToolProps) {
  const name = createMemo(() => stringValue(props.metadata.name) ?? stringValue(props.input.id))
  return (
    <InlineTool icon="→" pending="Loading skill…" complete={name()} part={props.part}>
      Skill "{name()}"
    </InlineTool>
  )
}

function Diagnostics(props: { diagnostics: unknown; filePath: string }) {
  const theme = useTheme()
  const terminalEnvironment = useTuiTerminalEnvironment()
  const errors = createMemo(() => {
    const normalized = normalizePath(
      typeof props.filePath === "string" ? props.filePath : "",
      terminalEnvironment.platform,
    )
    return parseDiagnostics(props.diagnostics, normalized)
  })

  return (
    <Show when={errors().length}>
      <box>
        <For each={errors()}>
          {(diagnostic) => (
            <text fg={theme.text.feedback.error.default}>
              Error [{diagnostic.range.start.line + 1}:{diagnostic.range.start.character + 1}] {diagnostic.message}
            </text>
          )}
        </For>
      </box>
    </Show>
  )
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : undefined
}

const toolDisplays = new Set([
  "shell",
  "glob",
  "read",
  "grep",
  "webfetch",
  "websearch",
  "write",
  "edit",
  "subagent",
  "execute",
  "patch",
  "question",
  "skill",
])

export function toolDisplay(tool: string) {
  const normalized = canonicalToolName(tool)
  return toolDisplays.has(normalized) ? normalized : "generic"
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined
}

function formatSessionTranscript(session: SessionInfo, messages: SessionMessageInfo[], thinking: boolean, tools = true) {
  const body = messages.flatMap((message) => {
    if (message.type === "user") return [`## User\n\n${message.text}`]
    if (message.type === "shell")
      return [`## Shell\n\n\`\`\`\n$ ${message.command}\n${message.output?.output ?? ""}\n\`\`\``]
    if (message.type !== "assistant") return []
    const content = message.content.flatMap((item) => {
      if (item.type === "text") return [item.text]
      if (item.type === "reasoning") return thinking ? [`_Thinking:_\n\n${item.text}`] : []
      if (!tools) return []
      const input = typeof item.state.input === "string" ? item.state.input : JSON.stringify(item.state.input, null, 2)
      const output =
        item.state.status === "error"
          ? item.state.error.message
          : item.state.status === "streaming"
            ? ""
            : toolDisplayContent(item.state)
                .flatMap((entry) => (entry.type === "text" ? [entry.text] : [entry.name ?? entry.uri]))
                .join("\n")
      return [`**Tool: ${item.name}**\n\n**Input:**\n\`\`\`json\n${input}\n\`\`\`\n\n${output}`]
    })
    if (content.length === 0) return []
    return [`## Assistant\n\n${content.join("\n\n")}`]
  })
  return `# ${withTimestampedFallback(session)}\n\n**Session ID:** ${session.id}\n**Created:** ${new Date(session.time.created).toLocaleString()}\n**Updated:** ${new Date(session.time.updated).toLocaleString()}\n\n---\n\n${body.join("\n\n---\n\n")}\n`
}

export function parseApplyPatchFiles(value: unknown) {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    const file = recordValue(item)
    if (!file) return []
    const status = stringValue(file.status)
    const type =
      stringValue(file.type) ??
      (status === "added" ? "add" : status === "deleted" ? "delete" : status === "modified" ? "update" : undefined)
    const relativePath = stringValue(file.file) ?? stringValue(file.relativePath)
    const filePath = stringValue(file.filePath) ?? relativePath
    const patch = stringValue(file.patch)
    const additions = finiteNumber(file.additions)
    const deletions = finiteNumber(file.deletions)
    if (
      !type ||
      !relativePath ||
      !filePath ||
      patch === undefined ||
      additions === undefined ||
      deletions === undefined
    )
      return []
    return [{ type, relativePath, filePath, patch, additions, deletions, movePath: stringValue(file.movePath) }]
  })
}

export function parseQuestions(value: unknown) {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    const question = stringValue(recordValue(item)?.question)
    return question ? [{ question }] : []
  })
}

export function parseQuestionAnswers(value: unknown) {
  if (!Array.isArray(value)) return
  return value.map((answer) =>
    Array.isArray(answer) ? answer.filter((item): item is string => typeof item === "string") : [],
  )
}

export function parseDiagnostics(value: unknown, filePath: string) {
  const diagnostics = recordValue(value)?.[filePath]
  if (!Array.isArray(diagnostics)) return []
  return diagnostics
    .flatMap((item) => {
      const diagnostic = recordValue(item)
      const start = recordValue(recordValue(diagnostic?.range)?.start)
      const line = finiteNumber(start?.line)
      const character = finiteNumber(start?.character)
      const message = stringValue(diagnostic?.message)
      if (diagnostic?.severity !== 1 || line === undefined || character === undefined || !message) return []
      return [{ range: { start: { line, character } }, message }]
    })
    .slice(0, 3)
}
