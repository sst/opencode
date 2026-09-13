import {
  BoxRenderable,
  CliRenderEvents,
  RGBA,
  ScrollBoxRenderable,
  TextAttributes,
  type MouseEvent,
} from "@opentui/core"
import {
  For,
  Index,
  Match,
  Show,
  Switch,
  createComputed,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  untrack,
} from "solid-js"
import { Portal, useRenderer, useTerminalDimensions } from "@opentui/solid"
import { useConfig } from "../config"
import { useSessionTabs } from "../context/session-tabs"
import { useData } from "../context/data"
import { useTheme } from "../context/theme"
import {
  adaptiveSessionTabLayout,
  moveSessionTab,
  NEW_SESSION_TAB_TITLE,
  sessionTabComplete,
  sessionTabDetail,
  sessionTabNumberLabel,
  seedSessionTabMotion,
  sessionTabOverflowWidth,
  type SessionTab,
  type SessionTabUnread,
} from "../context/session-tabs-model"
import { createAnimatable, spring, tween } from "../ui/animation"
import { Locale } from "../util/locale"
import { TabPulse, unreadGlowIntensity } from "./tab-pulse"
import { tint } from "../theme/color"
import { SESSION_SIDEBAR_WIDTH, SESSION_TABS_COMPACT_BREAKPOINT } from "../ui/layout"
import { projectName } from "../util/project"
import { marqueeCycleWidth, marqueeOverflows, marqueeTextParts } from "../util/marquee"
import { useDialog } from "../ui/dialog"
import { DialogSessionRename } from "./dialog-session-rename"
import { Keymap } from "../context/keymap"
import { registerOpencodeSpinner } from "./register-spinner"
import { SPINNER_FRAMES } from "./spinner-frames"
import { SessionTabsRailControls, SessionTabHalfRow } from "./session-tabs-rail"
import "./title-shimmer"

registerOpencodeSpinner()

export const TAB_SPINNERS = {
  dots: { frames: SPINNER_FRAMES, interval: 80 },
  arcs: { frames: ["◜", "◝", "◞", "◟"], interval: 120 },
  quadrants: { frames: ["◴", "◷", "◶", "◵"], interval: 120 },
  line: { frames: ["|", "/", "-", "\\"], interval: 120 },
}
export type TabSpinner = keyof typeof TAB_SPINNERS

export const TAB_UNREAD_MARKERS = {
  "small-dot": "•",
  dot: "●",
  square: "▪",
  "large-square": "■",
}
export type TabUnreadMarker = keyof typeof TAB_UNREAD_MARKERS

// A long title fades out over its last cells instead of cutting hard.
const FADE_WIDTH = 4
// The add button renders as " + " at the end of the strip, so the tab layout leaves it room.
const ADD_TAB_WIDTH = 3
const MARQUEE_DELAY = 600
const MARQUEE_INTERVAL = 80
const CONTEXT_MENU_WIDTH = 16
const MIDDLE_MOUSE_BUTTON = 1
const RIGHT_MOUSE_BUTTON = 2
const MOUSE_CLOSE_HOLD_MS = 5_000

type MouseCloseHold = {
  items: string[]
  ids: string[]
  widths: number[]
  closed: string
  target: string
  x: number
}

type TabContextMenuState = {
  x: number
  y: number
  sessionID?: string
  title?: string
}

type ContextController = ReturnType<typeof useSessionTabs>
export type SessionTabsStatus = Omit<ReturnType<ContextController["status"]>, "unread"> & {
  unread: SessionTabUnread | undefined
}
export const EMPTY_SESSION_TAB_STATUS: SessionTabsStatus = {
  unread: undefined,
  promptPulse: 0,
  attention: false,
  busy: false,
  renaming: false,
}
export type SessionTabsController = Pick<ContextController, "tabs" | "current" | "select" | "close" | "move"> & {
  newTab?: () => boolean
  add?: () => void
  detail?: (sessionID: string) => string | undefined
  rename?: (sessionID: string) => void
  search?: () => void
  status(sessionID: string): SessionTabsStatus
}
const NEW_SESSION_TAB: SessionTab = { sessionID: "new", title: NEW_SESSION_TAB_TITLE }
const glowTextColor = (base: RGBA, glow: RGBA, index: number, width: number, level = 1) =>
  tint(base, glow, 0.12 * unreadGlowIntensity(index, width) * level)

function tabFeedbackColor(status: SessionTabsStatus, theme: ReturnType<typeof useTheme>) {
  if (status.attention) return theme.text.status[status.attention]
  if (status.unread === "error") return theme.text.feedback.error.default
  return undefined
}

function TabIndicator(props: {
  status: SessionTabsStatus
  label: string
  idleLabel?: string
  width: number
  centered?: boolean
  color: RGBA
  unreadColor: RGBA
  backgroundColor: RGBA
  flashColor: RGBA
  animations: boolean
  numbers: boolean
  selected?: boolean
  spinner?: TabSpinner
  unreadMarker?: TabUnreadMarker
  attributes?: number
}) {
  const runs = () => props.status.busy && !props.status.attention
  const pending = createMemo(() => props.status.busy || Boolean(props.status.attention))
  const unread = createMemo(() => Boolean(props.status.unread) && !pending())
  const unreadColor = createMemo<RGBA>((previous) => (unread() ? props.unreadColor : previous), props.unreadColor)
  const fade = createAnimatable(
    { opacity: unread() ? 1 : 0 },
    { enabled: () => props.animations, transition: tween({ duration: 0.18 }) },
  )
  createComputed(() => {
    if (unread()) return fade.jump({ opacity: 1 })
    if (pending()) return fade.jump({ opacity: 0 })
    fade.animate({ opacity: 0 })
  })
  const fading = () => !props.status.unread && fade.value().opacity > 0
  const color = () => {
    if (props.numbers || props.selected) return props.color
    if (unread()) return props.unreadColor
    if (!fading()) return props.color
    const opacity = fade.value().opacity
    // Brighten during the first fifth, then dissolve into the tab background.
    const flash = Math.max(0, 1 - Math.abs(opacity - 0.8) / 0.2)
    return tint(props.backgroundColor, tint(unreadColor(), props.flashColor, flash * 0.3), Math.min(1, opacity / 0.8))
  }
  const spinner = () => TAB_SPINNERS[props.spinner ?? "dots"]
  const label = () => {
    if (props.numbers) return props.label
    if (props.status.attention === "permission") return "!"
    if (props.status.attention === "question") return "?"
    if (runs()) return spinner().frames[0]
    if (props.label === "+") return "+"
    if (props.status.unread || fading()) return TAB_UNREAD_MARKERS[props.unreadMarker ?? "small-dot"]
    return props.idleLabel ?? ""
  }
  return (
    <box
      width={props.width + (props.centered ? 0 : 1)}
      height={props.centered ? 1 : undefined}
      flexShrink={0}
      flexDirection="row"
      justifyContent={props.centered ? "center" : "flex-end"}
      paddingRight={props.centered ? 0 : 1}
    >
      <Show
        when={runs() && props.animations && !props.numbers}
        fallback={
          <text fg={color()} selectable={false} attributes={props.attributes}>
            {label()}
          </text>
        }
      >
        <spinner frames={spinner().frames} interval={spinner().interval} color={props.color} />
      </Show>
    </box>
  )
}

function createGlowLevel(dimmed: () => boolean, animations: () => boolean) {
  const motion = createAnimatable(
    { level: dimmed() ? 0.7 : 1 },
    { enabled: animations, transition: tween({ duration: 0.2 }) },
  )
  createEffect(() => motion.animate({ level: dimmed() ? 0.7 : 1 }))
  return () => motion.value().level
}

function createNumberIgnition(runs: () => boolean, prompt: () => number, animations: () => boolean) {
  const ignition = createAnimatable({ level: 0 }, { enabled: animations, transition: tween({ duration: 0.7 }) })
  let wasRunning = runs()
  let promptPulse = prompt()
  createEffect(() => {
    const running = runs()
    const nextPromptPulse = prompt()
    if (running !== wasRunning || nextPromptPulse !== promptPulse) {
      ignition.jump({ level: 0.85 })
      ignition.animate({ level: 0 })
    }
    wasRunning = running
    promptPulse = nextPromptPulse
  })
  return ignition
}

function fadeTitleColor(color: RGBA, background: RGBA, index: number, length: number, leading: number) {
  const fade = (position: number) => (position <= 0 ? 0 : 0.2 + 0.72 * ((position - 1) / Math.max(1, FADE_WIDTH - 1)))
  const start = index < FADE_WIDTH ? FADE_WIDTH - index : 0
  const end = index - (length - FADE_WIDTH) + 1
  const opacity = Math.max(fade(start) * leading, fade(end))
  return opacity === 0 ? color : tint(color, background, opacity)
}

function heldSessionTabLayout(hold: MouseCloseHold, tabs: readonly SessionTab[]) {
  const ids = tabs.map((tab) => tab.sessionID)
  const expected = hold.items.filter((id) => id !== hold.closed)
  const unchanged = ids.length === hold.items.length && ids.every((id, index) => id === hold.items[index])
  const removed = ids.length === expected.length && ids.every((id, index) => id === expected[index])
  if (!unchanged && !removed) return undefined

  const visibleIDs = hold.ids.filter((id) => ids.includes(id))
  if (removed && !visibleIDs.includes(hold.target)) {
    visibleIDs.push(hold.target)
    visibleIDs.sort((a, b) => ids.indexOf(a) - ids.indexOf(b))
  }
  const positions = visibleIDs.map((id) => ids.indexOf(id))
  const start = positions[0]
  if (start === undefined || positions.some((position, index) => position !== start + index)) return undefined
  const visible = visibleIDs.flatMap((id) => tabs.find((tab) => tab.sessionID === id) ?? [])
  if (visible.length !== visibleIDs.length) return undefined

  const widths = visibleIDs.map((id) => hold.widths[hold.ids.indexOf(id)] ?? 1)
  if (removed) {
    const index = visibleIDs.indexOf(hold.target)
    if (index === -1) return undefined
    const leading = start > 0 ? sessionTabOverflowWidth(start) : 0
    const preceding = widths.slice(0, index).reduce((sum, width) => sum + width, 0)
    // The close glyph sits one cell in from the right edge: x = tab start + width - 2.
    const width = hold.x - leading - preceding + 2
    if (width < 1) return undefined
    widths[index] = width
  }
  return {
    tabs: visible,
    widths,
    before: start,
    after: tabs.length - start - visible.length,
    start,
    total: widths.reduce((sum, width) => sum + width, 0),
  }
}

export function createMarquee(animations: () => boolean) {
  const [offset, setOffset] = createSignal(0)
  const [active, setActive] = createSignal<string>()
  const leading = createAnimatable({ opacity: 0 }, { enabled: animations, transition: tween({ duration: 0.25 }) })
  let delay: ReturnType<typeof setTimeout> | undefined
  let interval: ReturnType<typeof setInterval> | undefined
  let cycleWidth = 0

  const clear = () => {
    if (delay) clearTimeout(delay)
    if (interval) clearInterval(interval)
    delay = undefined
    interval = undefined
  }
  const scroll = () => {
    interval = setInterval(
      () =>
        setOffset((value) => {
          if (value + 1 < cycleWidth) return value + 1
          clear()
          leading.animate({ opacity: 0 })
          return 0
        }),
      MARQUEE_INTERVAL,
    )
  }
  const enter = (sessionID: string, title: string, width: number) => {
    if (!marqueeOverflows(title, width)) {
      reset()
      return
    }
    if (active() === sessionID) return
    clear()
    cycleWidth = marqueeCycleWidth(title)
    setActive(sessionID)
    setOffset(0)
    leading.jump({ opacity: 0 })
    delay = setTimeout(() => {
      setOffset(1)
      leading.animate({ opacity: 1 })
      scroll()
    }, MARQUEE_DELAY)
  }
  const leave = (sessionID: string) => {
    if (active() !== sessionID) return
    reset()
  }
  const reset = () => {
    clear()
    setActive(undefined)
    setOffset(0)
    leading.jump({ opacity: 0 })
  }
  onCleanup(clear)

  return { offset, active, enter, leave, reset, leading: () => leading.value().opacity }
}

export function createTabMarquee(animations: () => boolean) {
  const [hovered, setHovered] = createSignal<string>()
  const marquee = createMarquee(animations)
  let hoverClear: ReturnType<typeof setTimeout> | undefined

  const enter = (sessionID: string, title: string, width: number) => {
    if (hoverClear) clearTimeout(hoverClear)
    setHovered(sessionID)
    marquee.enter(sessionID, title, width)
  }
  const leave = (sessionID: string) => {
    if (hoverClear) clearTimeout(hoverClear)
    hoverClear = setTimeout(() => {
      if (hovered() !== sessionID) return
      setHovered(undefined)
      marquee.leave(sessionID)
    })
  }
  const leaveHovered = () => {
    const sessionID = hovered()
    if (sessionID) leave(sessionID)
  }
  const reset = () => {
    if (hoverClear) clearTimeout(hoverClear)
    hoverClear = undefined
    setHovered(undefined)
    marquee.reset()
  }
  onCleanup(() => {
    if (hoverClear) clearTimeout(hoverClear)
  })

  return { ...marquee, hovered, enter, leave, leaveHovered, reset }
}

function TabContextMenu(props: { state: TabContextMenuState; tabs: SessionTabsController; onClose: () => void }) {
  const dimensions = useTerminalDimensions()
  const theme = useTheme("elevated")
  const dialog = useDialog()
  onCleanup(Keymap.use().mode.push("menu"))
  Keymap.createLayer(() => ({
    mode: "menu",
    commands: [{ bind: "escape,ctrl+c", title: "Close tab menu", group: "Tabs", run: props.onClose }],
  }))
  const actions = createMemo(() => {
    const sessionID = props.state.sessionID
    const title = props.state.title
    return [
      ...(props.tabs.add ? [{ title: "New tab", run: () => props.tabs.add?.() }] : []),
      ...(sessionID
        ? [
            {
              title: "Rename",
              run: () =>
                props.tabs.rename ? props.tabs.rename(sessionID) : DialogSessionRename.show(dialog, sessionID, title),
            },
            { title: "Close", run: () => props.tabs.close(sessionID) },
          ]
        : []),
    ]
  })
  const [selected, setSelected] = createSignal<number>()
  const top = () => Math.max(0, Math.min(props.state.y + 1, dimensions().height - actions().length))
  const left = () => Math.max(0, Math.min(props.state.x, dimensions().width - CONTEXT_MENU_WIDTH))
  const run = (index: number) => {
    const action = actions()[index]
    props.onClose()
    action?.run()
  }

  return (
    <Portal
      ref={(container) => {
        if (!(container instanceof BoxRenderable)) return
        // Portal's wrapper otherwise follows the full-height app in root layout.
        container.position = "absolute"
        container.left = 0
        container.top = 0
        container.zIndex = 2500
      }}
    >
      <box
        position="absolute"
        left={0}
        top={0}
        width={dimensions().width}
        height={dimensions().height}
        zIndex={2500}
        onMouseDown={(event) => {
          props.onClose()
          event.preventDefault()
          event.stopPropagation()
        }}
      >
        <box
          position="absolute"
          left={left()}
          top={top()}
          height={actions().length}
          width={CONTEXT_MENU_WIDTH}
          flexDirection="column"
          backgroundColor={theme.background.default}
          onMouseDown={(event) => {
            if (event.button === RIGHT_MOUSE_BUTTON) props.onClose()
            event.preventDefault()
            event.stopPropagation()
          }}
        >
          <For each={actions()}>
            {(action, index) => (
              <box
                width="100%"
                paddingLeft={1}
                paddingRight={1}
                backgroundColor={selected() === index() ? theme.background.action.primary.hovered : undefined}
                onMouseOver={() => setSelected(index())}
                onMouseOut={() => setSelected(undefined)}
                onMouseUp={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                  if (event.button === RIGHT_MOUSE_BUTTON) return
                  run(index())
                }}
              >
                <text fg={theme.text.default} selectable={false}>
                  {action.title}
                </text>
              </box>
            )}
          </For>
        </box>
      </box>
    </Portal>
  )
}

export function SessionTabs(
  props: {
    controller?: SessionTabsController
    animations?: boolean
    spinner?: TabSpinner
    unreadMarker?: TabUnreadMarker
    indicators?: "status" | "numbers"
    orientation?: "horizontal" | "vertical"
    width?: number
  } = {},
) {
  const config = useConfig().data

  return (
    <Switch>
      <Match when={props.orientation === "vertical"}>
        <VerticalSessionTabs
          controller={props.controller}
          animations={props.animations}
          spinner={props.spinner}
          unreadMarker={props.unreadMarker}
          numbers={(props.indicators ?? config.tabs.indicators) === "numbers"}
          width={props.width}
        />
      </Match>
      <Match when={true}>
        <HorizontalSessionTabs
          controller={props.controller}
          animations={props.animations}
          spinner={props.spinner}
          unreadMarker={props.unreadMarker}
          numbers={(props.indicators ?? config.tabs.indicators) === "numbers"}
        />
      </Match>
    </Switch>
  )
}

function VerticalSessionTabs(props: {
  controller?: SessionTabsController
  animations?: boolean
  numbers: boolean
  spinner?: TabSpinner
  unreadMarker?: TabUnreadMarker
  width?: number
}) {
  const tabs: SessionTabsController = props.controller ?? useSessionTabs()
  const data = props.controller ? undefined : useData()
  const dimensions = useTerminalDimensions()
  const renderer = useRenderer()
  const theme = useTheme("elevated")
  const base = useTheme()
  const config = useConfig().data
  const animations = () => props.animations ?? config.animations ?? true
  const width = () => props.width ?? SESSION_SIDEBAR_WIDTH
  const compact = createMemo(() => width() < SESSION_TABS_COMPACT_BREAKPOINT)
  const tooltipWidth = () => Math.min(54, dimensions().width - width())
  const stride = () => (compact() ? 2 : 3)
  const unreadColor = () => theme.text.status.unread
  const activeNumber = () => theme.text.status.running
  const idleNumber = () => tint(theme.text.formfield.default, theme.background.default, 0.55)
  const separatorUpperPulseColor = createMemo(() => tint(theme.background.default, theme.text.default, 0.04))
  const separatorLowerPulseColor = createMemo(() => tint(theme.background.default, theme.text.default, 0.05))
  const [addHovered, setAddHovered] = createSignal(false)
  const marquee = createTabMarquee(animations)
  const hovered = marquee.hovered
  createEffect(() => {
    compact()
    untrack(marquee.reset)
  })
  const [hoverY, setHoverY] = createSignal(0)
  const [scrollTop, setScrollTop] = createSignal(0)
  const detail = (sessionID: string) => {
    const fixture = tabs.detail?.(sessionID)
    if (fixture !== undefined) return fixture
    const session = data?.session.get(sessionID)
    const project = session ? data?.project.get(session.projectID) : undefined
    const vcs = session ? data?.location.vcs.info(session.location) : undefined
    const location = session ? data?.location.info(session.location) : undefined
    return sessionTabDetail(
      projectName(project, session?.location.directory) ?? "",
      vcs?.branch.current,
      vcs?.branch.default,
      !!location && location.project.directory !== location.project.canonical,
    )
  }
  // OpenTUI captures the first drag target, which may differ from the tab pressed on a fast move.
  const [dragging, setDragging] = createSignal<string>()
  const [preview, setPreview] = createSignal<{ sessionID: string; index: number }>()
  const [contextMenu, setContextMenu] = createSignal<TabContextMenuState>()
  const newTab = () => tabs.newTab?.() ?? false
  const activeID = createMemo(() => (newTab() ? undefined : tabs.current()))
  const ordered = createMemo(() => {
    const pending = preview()
    if (!pending) return tabs.tabs()
    return moveSessionTab(tabs.tabs(), pending.sessionID, pending.index)
  })
  const items = ordered
  const highlightColor = createMemo(() =>
    tint(theme.background.default, theme.background.action.primary.hovered, theme.background.action.primary.hovered.a),
  )
  const highlighted = (sessionID: string | undefined) =>
    sessionID !== undefined && (activeID() === sessionID || hovered() === sessionID || dragging() === sessionID)
  const addHighlighted = () => newTab() || addHovered()
  const belowHighlighted = createMemo(() => {
    const tab = items()[Math.floor(scrollTop() / stride())]
    return tab ? highlighted(tab.sessionID) : addHighlighted()
  })
  createEffect(() => {
    const active = marquee.active()
    if (active && !items().some((tab) => tab.sessionID === active)) marquee.reset()
  })
  const statuses = createMemo(
    () =>
      new Map(
        items().map((tab) => {
          const status = tabs.status(tab.sessionID)
          return [
            tab.sessionID,
            {
              ...status,
              complete: sessionTabComplete(status.unread, status.busy),
              runs: status.busy && !status.attention,
              glows: Boolean(
                status.attention || (tab.sessionID !== activeID() && !status.busy && status.unread !== undefined),
              ),
            },
          ] as const
        }),
      ),
  )
  const itemStatus = (tab: SessionTab) => statuses().get(tab.sessionID)!
  let rail: { screenX: number; screenY: number } | undefined
  let scroll: ScrollBoxRenderable | undefined
  const updateScroll = () => setScrollTop(scroll?.scrollTop ?? 0)
  onCleanup(() => scroll?.verticalScrollBar.off("change", updateScroll))
  let didDrag = false
  let addPressed = false
  // A captured drag ends with a synthetic up on its drop target; do not turn that into a click.
  let suppressClick = false

  createEffect(() => {
    const pending = preview()
    if (!pending || dragging()) return
    const index = tabs.tabs().findIndex((tab) => tab.sessionID === pending.sessionID)
    if (index === -1 || index === Math.min(pending.index, tabs.tabs().length - 1)) setPreview(undefined)
  })

  createEffect(() => {
    if (!scroll) return
    dimensions()
    const index = newTab() ? items().length : items().findIndex((tab) => tab.sessionID === activeID())
    if (index === -1) return
    const top = index * stride()
    const height = compact() ? 3 : newTab() ? 1 : 2
    // Scroll after layout: newly opened tabs do not contribute to the scroll range yet.
    const reveal = () => {
      if (!scroll) return
      if (top < scroll.scrollTop) return scroll.scrollTo(top)
      if (top + height > scroll.scrollTop + scroll.viewport.height) {
        scroll.scrollTo(top + height - scroll.viewport.height)
      }
    }
    renderer.once(CliRenderEvents.FRAME, reveal)
    renderer.requestRender()
    onCleanup(() => renderer.off(CliRenderEvents.FRAME, reveal))
  })

  const release = () => {
    const source = dragging()
    if (!source) return
    if (didDrag) suppressClick = true
    setDragging(undefined)
    const pending = preview()
    if (pending?.sessionID === source) tabs.move(pending.sessionID, pending.index)
    tabs.select(source)
  }

  const drag = (event: MouseEvent) => {
    if (!rail) return
    const source = dragging()
    if (!source) return
    didDrag = true
    const target = Math.max(
      0,
      Math.min(
        tabs.tabs().length - 1,
        Math.floor(
          (event.y - (scroll?.viewport.screenY ?? rail.screenY + 1) - (compact() ? 1 : 0) + (scroll?.scrollTop ?? 0)) /
            stride(),
        ),
      ),
    )
    const sourceIndex = items().findIndex((item) => item.sessionID === source)
    if (target !== sourceIndex && preview()?.index !== target) setPreview({ sessionID: source, index: target })
  }

  return (
    <box
      ref={(element) => (rail = element)}
      width={width()}
      height="100%"
      flexShrink={0}
      flexDirection="column"
      position="relative"
      paddingTop={1}
      backgroundColor={theme.background.default}
      onMouseOut={marquee.leaveHovered}
      onMouseUp={(event) => {
        if (event.button === RIGHT_MOUSE_BUTTON) return
        release()
        if (!didDrag) return
        didDrag = false
        queueMicrotask(() => (suppressClick = false))
      }}
      onMouseDrag={drag}
      onMouseDragEnd={release}
    >
      <Show when={compact()}>
        <SessionTabsRailControls width={width()} tabs={tabs} belowHighlighted={belowHighlighted()} />
      </Show>
      <scrollbox
        ref={(element) => {
          scroll = element
          scroll.verticalScrollBar.on("change", updateScroll)
          updateScroll()
        }}
        flexGrow={1}
        minHeight={0}
        backgroundColor={theme.background.default}
        scrollbarOptions={{ visible: false }}
      >
        <box flexShrink={0} flexDirection="column" gap={1} paddingY={compact() ? 1 : 0}>
          <For each={items()}>
            {(tab, index) => {
              const selected = () => activeID() === tab.sessionID
              const status = createMemo(() => itemStatus(tab))
              const [sweepLevel, setSweepLevel] = createSignal(0)
              const [closeHovered, setCloseHovered] = createSignal(false)
              const session = createMemo(() => data?.session.get(tab.sessionID))
              const numberWidth = () => Math.max(2, String(items().length).length)
              const prefixWidth = () => numberWidth() + 1
              const restingTitleWidth = () => Math.max(1, width() - prefixWidth() - 1)
              const hoveredTitleWidth = () => Math.max(1, restingTitleWidth() - 1)
              const titleWidth = () => (hovered() === tab.sessionID ? hoveredTitleWidth() : restingTitleWidth())
              const title = () => (props.controller ? undefined : session()?.title) ?? tab.title ?? "Untitled session"
              const scrolling = () => marquee.active() === tab.sessionID
              const visibleTitleParts = createMemo(() =>
                scrolling()
                  ? marqueeTextParts(title(), titleWidth(), marquee.offset())
                  : Locale.graphemes(Locale.takeWidth(title(), titleWidth())).map((value) => ({
                      value,
                      separator: false,
                    })),
              )
              const visibleTitle = createMemo(() =>
                visibleTitleParts()
                  .map((part) => part.value)
                  .join(""),
              )
              const titleFades = createMemo(() => marqueeOverflows(title(), titleWidth()) && titleWidth() > FADE_WIDTH)
              const tabDetail = createMemo(() => detail(tab.sessionID))
              const visibleDetail = createMemo(() => Locale.takeWidth(tabDetail(), titleWidth()))
              const visibleDetailParts = createMemo(() => Locale.graphemes(visibleDetail()))
              const detailFades = createMemo(
                () => marqueeOverflows(tabDetail(), titleWidth()) && titleWidth() > FADE_WIDTH,
              )
              const background = createMemo(() => {
                if (selected() && !compact()) return theme.background.action.primary.selected
                if ((compact() && selected()) || hovered() === tab.sessionID || dragging() === tab.sessionID)
                  return theme.background.action.primary.hovered
                return theme.background.default
              })
              const pulseBackground = createMemo(() => tint(theme.background.default, background(), background().a))
              const runs = () => status().runs
              const numberIgnition = createNumberIgnition(runs, () => status().promptPulse, animations)
              const numberColor = () => {
                const base =
                  hovered() === tab.sessionID && !selected()
                    ? foreground()
                    : tint(idleNumber(), tint(theme.text.default, pulseBackground(), 0.25), Number(selected()))
                const color = tabFeedbackColor(status(), theme) ?? tint(base, glowHue(), numberGlow.value().level)
                const runningColor = runs() ? activeNumber() : color
                return sweepLevel() === 0
                  ? tint(runningColor, theme.text.default, numberIgnition.value().level)
                  : tint(runningColor, theme.text.default, Math.max(numberIgnition.value().level, 0.35 * sweepLevel()))
              }
              const foreground = () => {
                if (hovered() === tab.sessionID) return theme.text.default
                return selected() ? theme.text.default : theme.text.subdued
              }
              const complete = () => status().complete
              // Latched so a resolving glow fades out in the hue it lit with instead of snapping to the unread color.
              let lastGlowHue: RGBA | undefined
              const glowHue = () => {
                const feedback = tabFeedbackColor(status(), theme)
                if (feedback) return (lastGlowHue = feedback)
                if (status().unread !== undefined) return (lastGlowHue = unreadColor())
                return lastGlowHue ?? unreadColor()
              }
              const pulseColor = createMemo(() => tint(pulseBackground(), theme.text.default, 0.25))
              const flashColor = createMemo(() => tint(pulseBackground(), theme.text.default, 0.7))
              const glowLevel = createGlowLevel(() => selected() && Boolean(status().attention), animations)
              const glowColor = createMemo(() => tint(pulseBackground(), glowHue(), 0.45 * glowLevel()))
              const detailPulseColor = createMemo(() => tint(pulseBackground(), theme.text.default, 0.13))
              const detailFlashColor = createMemo(() => tint(pulseBackground(), theme.text.default, 0.42))
              const detailGlowColor = createMemo(() => tint(pulseBackground(), glowHue(), 0.25 * glowLevel()))
              const detailColor = createMemo(() => tint(theme.text.subdued, pulseBackground(), 0.35))
              const detailTextColor = (index: number) =>
                detailFades()
                  ? fadeTitleColor(detailColor(), pulseBackground(), index, visibleDetailParts().length, 0)
                  : detailColor()
              const glows = () => status().glows
              // Text tints ride an eased level so they diffuse away with the background glow instead of snapping.
              const titleGlow = createAnimatable(
                { level: 0 },
                { enabled: animations, transition: tween({ duration: 0.4 }) },
              )
              createEffect(() => titleGlow.animate({ level: glows() ? 1 : 0 }))
              const numberGlow = createAnimatable(
                { level: 0 },
                { enabled: animations, transition: tween({ duration: 0.4 }) },
              )
              createEffect(() =>
                numberGlow.animate({
                  level: status().attention || status().unread === "error" || complete() ? 1 : 0,
                }),
              )
              const previous = createMemo(() => items()[index() - 1])
              const previousStatus = createMemo(() => {
                const tab = previous()
                return tab
                  ? itemStatus(tab)
                  : { ...EMPTY_SESSION_TAB_STATUS, complete: false, runs: false, glows: false }
              })
              const previousGlows = () => previousStatus().glows
              const previousRuns = () => previousStatus().runs
              const previousGlowLevel = createGlowLevel(
                () => previous()?.sessionID === activeID() && Boolean(previousStatus().attention),
                animations,
              )
              const indicatorWidth = 10
              let lastPreviousGlowHue: RGBA | undefined
              const previousGlowHue = () => {
                const feedback = tabFeedbackColor(previousStatus(), theme)
                if (feedback) return (lastPreviousGlowHue = feedback)
                if (previousStatus().unread !== undefined) return (lastPreviousGlowHue = unreadColor())
                return lastPreviousGlowHue ?? unreadColor()
              }
              const separatorUpperColor = createMemo(() =>
                tint(theme.background.default, previousGlowHue(), 0.1 * previousGlowLevel()),
              )
              const separatorLowerColor = createMemo(() =>
                tint(theme.background.default, glowHue(), 0.12 * glowLevel()),
              )
              const titleColor = (index: number, separator: boolean) => {
                const level = titleGlow.value().level
                const color =
                  level === 0
                    ? foreground()
                    : glowTextColor(foreground(), glowColor(), 1 + numberWidth() + index, width(), level)
                const faded = titleFades()
                  ? fadeTitleColor(
                      color,
                      pulseBackground(),
                      index,
                      visibleTitleParts().length,
                      scrolling() ? marquee.leading() : 0,
                    )
                  : color
                return separator ? tint(faded, pulseBackground(), 0.55) : faded
              }
              return (
                <box
                  height={compact() ? 1 : 2}
                  width="100%"
                  position="relative"
                  flexDirection="column"
                  backgroundColor={background()}
                  onMouseOver={(event) => {
                    setHoverY(event.y)
                    marquee.enter(tab.sessionID, title(), compact() ? Infinity : hoveredTitleWidth())
                  }}
                  onMouseOut={() => marquee.leave(tab.sessionID)}
                  onMouseDown={(event) => {
                    if (event.button === MIDDLE_MOUSE_BUTTON) {
                      didDrag = false
                      setDragging(undefined)
                      tabs.close(tab.sessionID)
                      event.preventDefault()
                      event.stopPropagation()
                      return
                    }
                    if (event.button === RIGHT_MOUSE_BUTTON) {
                      didDrag = false
                      setDragging(undefined)
                      if (!rail) return
                      setContextMenu({
                        x: event.x,
                        y: event.y,
                        sessionID: tab.sessionID,
                        title: tab.title,
                      })
                      event.preventDefault()
                      event.stopPropagation()
                      return
                    }
                    didDrag = false
                    marquee.enter(tab.sessionID, title(), compact() ? Infinity : hoveredTitleWidth())
                    setDragging(tab.sessionID)
                  }}
                >
                  <Show when={compact()}>
                    <Show when={highlighted(tab.sessionID)}>
                      <SessionTabHalfRow
                        top={-1}
                        edge="top"
                        width={width()}
                        color={pulseBackground()}
                        background={
                          highlighted(items()[index() - 1]?.sessionID) ? highlightColor() : theme.background.default
                        }
                      />
                      <SessionTabHalfRow
                        top={1}
                        edge="bottom"
                        width={width()}
                        color={pulseBackground()}
                        background={
                          (
                            index() === items().length - 1
                              ? addHighlighted()
                              : highlighted(items()[index() + 1]?.sessionID)
                          )
                            ? highlightColor()
                            : theme.background.default
                        }
                      />
                    </Show>
                    <box height={1} flexDirection="row" justifyContent="center">
                      <TabIndicator
                        centered
                        selected={selected()}
                        width={width()}
                        status={status()}
                        label={sessionTabNumberLabel(index())}
                        idleLabel={Locale.graphemes(title().trimStart())[0] ?? "U"}
                        color={
                          selected()
                            ? theme.text.default
                            : props.numbers
                              ? numberColor()
                              : (tabFeedbackColor(status(), theme) ?? (runs() ? activeNumber() : foreground()))
                        }
                        unreadColor={tabFeedbackColor(status(), theme) ?? unreadColor()}
                        backgroundColor={pulseBackground()}
                        flashColor={theme.text.default}
                        animations={animations()}
                        numbers={props.numbers}
                        spinner={props.spinner}
                        unreadMarker={props.unreadMarker}
                        attributes={selected() ? TextAttributes.BOLD : undefined}
                      />
                    </box>
                  </Show>
                  <Show when={!compact()}>
                    <TabPulse
                      top={-1}
                      edge="above"
                      enabled={animations()}
                      active={runs()}
                      outerActive={previousRuns()}
                      promptPulse={status().promptPulse}
                      outerPromptPulse={previousStatus().promptPulse}
                      complete={complete() && !status().attention}
                      outerComplete={previousStatus().complete && !previousStatus().attention}
                      glow={glows()}
                      outerGlow={previousGlows()}
                      color={separatorLowerPulseColor()}
                      width={indicatorWidth}
                      outerColor={separatorUpperPulseColor()}
                      flashColor={tint(theme.background.default, theme.text.default, 0.22)}
                      outerFlashColor={tint(theme.background.default, theme.text.default, 0.18)}
                      flashTail={8}
                      glowColor={separatorLowerColor()}
                      outerGlowColor={separatorUpperColor()}
                      glowTail={8}
                      outerGlowTail={5}
                      completionColor={separatorLowerColor()}
                      outerCompletionColor={separatorUpperColor()}
                      backgroundColor={theme.background.default}
                    />
                    <Show when={index() === items().length - 1}>
                      <TabPulse
                        top={2}
                        edge="below"
                        enabled={animations()}
                        active={runs()}
                        outerActive={false}
                        promptPulse={status().promptPulse}
                        outerPromptPulse={0}
                        complete={complete() && !status().attention}
                        outerComplete={false}
                        glow={glows()}
                        outerGlow={false}
                        color={tint(theme.background.default, theme.text.default, 0.04)}
                        width={indicatorWidth}
                        outerColor={tint(theme.background.default, theme.text.default, 0.006)}
                        flashColor={tint(theme.background.default, theme.text.default, 0.18)}
                        flashTail={8}
                        glowColor={tint(theme.background.default, glowHue(), 0.1 * glowLevel())}
                        outerGlowColor={theme.background.default}
                        glowTail={8}
                        outerGlowTail={5}
                        completionColor={tint(theme.background.default, glowHue(), 0.1 * glowLevel())}
                        outerCompletionColor={theme.background.default}
                        backgroundColor={theme.background.default}
                      />
                    </Show>
                    <box height={1} width="100%" flexDirection="row" position="relative">
                      <TabPulse
                        enabled={animations()}
                        active={runs()}
                        promptPulse={status().promptPulse}
                        complete={complete() && !status().attention}
                        glow={glows()}
                        color={pulseColor()}
                        width={indicatorWidth}
                        glowColor={glowColor()}
                        flashColor={flashColor()}
                        flashTail={8}
                        completionColor={glowColor()}
                        backgroundColor={pulseBackground()}
                        onLevel={setSweepLevel}
                      />
                      <box zIndex={1} width="100%" flexDirection="row" paddingRight={1}>
                        <TabIndicator
                          status={status()}
                          label={sessionTabNumberLabel(index())}
                          width={numberWidth()}
                          color={numberColor()}
                          unreadColor={tabFeedbackColor(status(), theme) ?? unreadColor()}
                          backgroundColor={pulseBackground()}
                          flashColor={theme.text.default}
                          animations={animations()}
                          numbers={props.numbers}
                          spinner={props.spinner}
                          unreadMarker={props.unreadMarker}
                          attributes={selected() ? TextAttributes.BOLD : undefined}
                        />
                        <title_shimmer
                          width={titleWidth()}
                          height={1}
                          fg={foreground()}
                          rename={{ pending: status().renaming, title: title() }}
                          enabled={animations()}
                          backdrop={pulseBackground()}
                          wrapMode="none"
                          selectable={false}
                          attributes={
                            status().renaming && !animations()
                              ? TextAttributes.DIM
                              : selected()
                                ? TextAttributes.BOLD
                                : undefined
                          }
                        >
                          <Show
                            when={scrolling() || titleGlow.value().level > 0 || titleFades()}
                            fallback={visibleTitle()}
                          >
                            <Index each={visibleTitleParts()}>
                              {(part, index) => (
                                <span style={{ fg: titleColor(index, part().separator) }}>{part().value}</span>
                              )}
                            </Index>
                          </Show>
                        </title_shimmer>
                        <text
                          position="absolute"
                          right={1}
                          zIndex={2}
                          width={1}
                          fg={closeHovered() ? theme.text.default : theme.text.subdued}
                          selectable={false}
                          onMouseOver={() => setCloseHovered(true)}
                          onMouseOut={() => setCloseHovered(false)}
                          onMouseDown={(event) => {
                            if (event.button === RIGHT_MOUSE_BUTTON || hovered() !== tab.sessionID) return
                            didDrag = false
                            event.stopPropagation()
                          }}
                          onMouseUp={(event) => {
                            if (event.button === RIGHT_MOUSE_BUTTON) return
                            if (suppressClick) return
                            if (hovered() !== tab.sessionID) return
                            event.stopPropagation()
                            tabs.close(tab.sessionID)
                          }}
                        >
                          {hovered() === tab.sessionID ? "✕" : ""}
                        </text>
                      </box>
                    </box>
                    <box height={1} width="100%" position="relative" flexDirection="row">
                      <TabPulse
                        enabled={animations()}
                        active={runs()}
                        promptPulse={status().promptPulse}
                        complete={complete() && !status().attention}
                        glow={glows()}
                        color={detailPulseColor()}
                        width={indicatorWidth}
                        glowColor={detailGlowColor()}
                        glowTail={10}
                        flashColor={detailFlashColor()}
                        flashTail={8}
                        completionColor={detailGlowColor()}
                        backgroundColor={pulseBackground()}
                      />
                      <box zIndex={1} width="100%" flexDirection="row" paddingLeft={prefixWidth()} paddingRight={2}>
                        <text fg={detailColor()} wrapMode="none" selectable={false}>
                          <Show when={detailFades()} fallback={visibleDetail()}>
                            <For each={visibleDetailParts()}>
                              {(character, index) => <span style={{ fg: detailTextColor(index()) }}>{character}</span>}
                            </For>
                          </Show>
                        </text>
                      </box>
                    </box>
                  </Show>
                </box>
              )
            }}
          </For>
          {/* One slot with two states: a subdued affordance that promotes in place into the
              active new-session tab, instead of spawning a separate pseudo tab above itself. */}
          <Show when={tabs.add || newTab()}>
            <box
              height={1}
              width="100%"
              position="relative"
              flexDirection="row"
              paddingLeft={compact() ? 0 : 1}
              justifyContent={compact() ? "center" : "flex-start"}
              alignItems="center"
              backgroundColor={
                newTab() && !compact()
                  ? theme.background.action.primary.selected
                  : addHovered() || (compact() && newTab())
                    ? theme.background.action.primary.hovered
                    : theme.background.default
              }
              onMouseOver={() => setAddHovered(true)}
              onMouseOut={() => setAddHovered(false)}
              onMouseDown={(event: MouseEvent) => {
                didDrag = false
                setDragging(undefined)
                addPressed = event.button !== RIGHT_MOUSE_BUTTON
                if (addPressed) return
                if (!rail) return
                setContextMenu({ x: event.x, y: event.y })
                event.preventDefault()
                event.stopPropagation()
              }}
              onMouseUp={(event: MouseEvent) => {
                if (event.button === RIGHT_MOUSE_BUTTON) return
                if (suppressClick) return
                if (!addPressed) return
                addPressed = false
                if (!newTab()) tabs.add?.()
              }}
              onMouseDragEnd={() => (addPressed = false)}
            >
              <Show when={compact() && addHighlighted()}>
                <SessionTabHalfRow
                  top={-1}
                  edge="top"
                  width={width()}
                  color={highlightColor()}
                  background={highlighted(items().at(-1)?.sessionID) ? highlightColor() : theme.background.default}
                />
                <SessionTabHalfRow
                  top={1}
                  edge="bottom"
                  width={width()}
                  color={highlightColor()}
                  background={theme.background.default}
                />
              </Show>
              <text
                width={compact() ? 1 : 2}
                fg={newTab() || addHovered() ? theme.text.default : idleNumber()}
                selectable={false}
                attributes={newTab() ? TextAttributes.BOLD : undefined}
              >
                +
              </text>
              <Show when={!compact()}>
                <text
                  fg={newTab() || addHovered() ? theme.text.default : theme.text.subdued}
                  wrapMode="none"
                  selectable={false}
                  attributes={newTab() ? TextAttributes.BOLD : undefined}
                >
                  {NEW_SESSION_TAB_TITLE}
                </text>
              </Show>
              <Show when={newTab() && !compact()}>
                <text
                  position="absolute"
                  right={1}
                  zIndex={2}
                  width={1}
                  fg={theme.text.subdued}
                  selectable={false}
                  onMouseUp={(event) => {
                    if (event.button === RIGHT_MOUSE_BUTTON) return
                    if (suppressClick) return
                    if (!addHovered()) return
                    event.stopPropagation()
                    tabs.close()
                  }}
                >
                  {addHovered() ? "×" : ""}
                </text>
              </Show>
            </box>
          </Show>
        </box>
      </scrollbox>
      <Show when={compact() && !dragging() && !contextMenu() && hovered()}>
        {(sessionID) => (
          <box
            position="absolute"
            left={width()}
            top={Math.max(0, Math.min(hoverY() - 1, dimensions().height - 4) - (rail?.screenY ?? 0))}
            width={tooltipWidth()}
            height={4}
            paddingY={1}
            zIndex={2000}
          >
            <SessionTabHalfRow
              top={0}
              edge="top"
              width={tooltipWidth()}
              color={theme.background.default}
              background={base.background.default}
            />
            <box height={2} paddingX={1} backgroundColor={theme.background.default}>
              <text fg={theme.text.default} wrapMode="none" selectable={false}>
                {Locale.truncateWidth(
                  data?.session.get(sessionID())?.title ??
                    items().find((tab) => tab.sessionID === sessionID())?.title ??
                    "Untitled session",
                  tooltipWidth() - 2,
                )}
              </text>
              <text fg={theme.text.subdued} wrapMode="none" selectable={false}>
                {Locale.takeWidth(detail(sessionID()), tooltipWidth() - 2)}
              </text>
            </box>
            <SessionTabHalfRow
              top={3}
              edge="bottom"
              width={tooltipWidth()}
              color={theme.background.default}
              background={base.background.default}
            />
          </box>
        )}
      </Show>
      <Show when={contextMenu()}>
        {(state) => <TabContextMenu state={state()} tabs={tabs} onClose={() => setContextMenu(undefined)} />}
      </Show>
    </box>
  )
}

function HorizontalSessionTabs(props: {
  controller?: SessionTabsController
  animations?: boolean
  spinner?: TabSpinner
  unreadMarker?: TabUnreadMarker
  numbers: boolean
}) {
  const tabs = props.controller ?? useSessionTabs()
  const data = props.controller ? undefined : useData()
  const dimensions = useTerminalDimensions()
  const theme = useTheme()
  const config = useConfig().data
  const animations = () => props.animations ?? config.animations ?? true
  const [addHovered, setAddHovered] = createSignal(false)
  const marquee = createTabMarquee(animations)
  const hovered = marquee.hovered
  // OpenTUI captures the first drag target, which may differ from the tab pressed on a fast move.
  const [dragging, setDragging] = createSignal<string>()
  // A drag reorders a local preview and persists one move on release instead of writing
  // per slot crossing; the preview holds after release until the store reflects the move,
  // so the strip never flashes the pre-drag order while the write is in flight.
  const [preview, setPreview] = createSignal<{ sessionID: string; index: number }>()
  const [contextMenu, setContextMenu] = createSignal<TabContextMenuState>()
  const [closeHold, setCloseHold] = createSignal<MouseCloseHold>()
  let strip: { screenX: number; screenY: number; width: number; height: number } | undefined
  let didDrag = false
  let addPressed = false
  let closeHoldTimer: ReturnType<typeof setTimeout> | undefined
  let releasingCloseHold = false
  const clearCloseHold = () => {
    setCloseHold(undefined)
    if (closeHoldTimer) clearTimeout(closeHoldTimer)
    closeHoldTimer = undefined
  }
  const releaseCloseHold = () => {
    if (!closeHold()) return
    releasingCloseHold = true
    clearCloseHold()
  }
  onCleanup(clearCloseHold)
  // A captured drag ends with a synthetic up on its drop target; do not turn that into a click.
  let suppressClick = false
  const unreadColor = () => theme.text.status.unread
  const activeNumber = () => theme.text.status.running
  const idleNumber = () => tint(theme.text.formfield.default, theme.background.default, 0.55)
  const newTab = () => tabs.newTab?.() ?? false
  const activeID = createMemo(() => (newTab() ? NEW_SESSION_TAB.sessionID : tabs.current()))
  const ordered = createMemo(() => {
    const pending = preview()
    if (!pending) return tabs.tabs()
    return moveSessionTab(tabs.tabs(), pending.sessionID, pending.index)
  })
  // The promoted new-session slot joins the strip as the active tab; the idle plus affordance
  // and the promoted slot are mutually exclusive states of one control.
  const items = createMemo(() => (newTab() ? [...ordered(), NEW_SESSION_TAB] : ordered()))
  const showPlus = () => Boolean(tabs.add) && !newTab()
  createEffect(() => {
    const pending = preview()
    if (!pending || dragging()) return
    const index = tabs.tabs().findIndex((tab) => tab.sessionID === pending.sessionID)
    if (index === -1 || index === Math.min(pending.index, tabs.tabs().length - 1)) setPreview(undefined)
  })
  const heldLayout = createMemo(() => {
    const hold = closeHold()
    return hold ? heldSessionTabLayout(hold, items()) : undefined
  })
  const layout = createMemo(
    (previous: ReturnType<typeof adaptiveSessionTabLayout> | undefined) =>
      heldLayout() ??
      adaptiveSessionTabLayout(
        items(),
        activeID(),
        dimensions().width - (showPlus() ? ADD_TAB_WIDTH : 0),
        previous?.start,
      ),
  )
  createEffect(() => {
    if (closeHold() && !heldLayout()) clearCloseHold()
  })
  createEffect(() => {
    const active = marquee.active()
    if (active && !layout().tabs.some((tab) => tab.sessionID === active)) marquee.reset()
  })
  const statuses = createMemo(
    () =>
      new Map(
        layout().tabs.map((tab) => {
          const status = tab === NEW_SESSION_TAB ? EMPTY_SESSION_TAB_STATUS : tabs.status(tab.sessionID)
          return [
            tab.sessionID,
            {
              ...status,
              complete: sessionTabComplete(status.unread, status.busy),
            },
          ] as const
        }),
      ),
  )
  const targets = createMemo(() => ({
    widths: layout().widths,
    selections: layout().tabs.map((tab) => Number(tab.sessionID === activeID())),
    activities: layout().tabs.map((tab) => Number(statuses().get(tab.sessionID)!.complete)),
  }))
  const motion = createAnimatable(targets(), {
    enabled: animations,
    transition: spring({ visualDuration: 0.1 }),
  })
  const identity = createMemo(() =>
    layout()
      .tabs.map((tab) => tab.sessionID)
      .join(":"),
  )
  let signature = ""
  let total = 0
  let terminalWidth = dimensions().width

  // createComputed runs before render effects, so seeded widths are visible on the first frame
  // of a membership change instead of flashing the final layout.
  createComputed(() => {
    const next = targets()
    const nextSignature = identity()
    const changed = Boolean(signature) && signature !== nextSignature
    const resized = Boolean(total) && total !== layout().total
    const terminalResized = terminalWidth !== dimensions().width
    const previous = signature
    signature = nextSignature
    total = layout().total
    terminalWidth = dimensions().width
    const releasing = releasingCloseHold
    releasingCloseHold = false
    if (terminalResized && closeHold()) {
      clearCloseHold()
      return
    }
    if (closeHold() && heldLayout()) {
      const current = untrack(motion.value)
      const seeded = changed
        ? seedSessionTabMotion(
            previous.split(":"),
            layout().tabs.map((tab) => tab.sessionID),
            current,
            next,
          )
        : current
      if (!seeded) return motion.jump(next)
      motion.jump({ ...seeded, widths: next.widths })
      return motion.animate(next)
    }
    if (!changed && !resized) return motion.animate(next)
    // Identity-stable total changes are terminal resizes and still jump.
    if (!changed) return releasing ? motion.animate(next) : motion.jump(next)
    const seeded = seedSessionTabMotion(
      previous.split(":"),
      layout().tabs.map((tab) => tab.sessionID),
      untrack(motion.value),
      next,
    )
    if (!seeded) return motion.jump(next)
    motion.jump(seeded)
    motion.animate(next)
  })

  const activeIndex = createMemo(() => layout().tabs.findIndex((tab) => tab.sessionID === activeID()))
  const visuals = createMemo(() => {
    const current = signature === identity() && total === layout().total ? motion.value() : targets()
    const widths = current.widths.map((width) => Math.max(1, Math.round(width)))
    const active = activeIndex()
    const remainder = layout().total - widths.reduce((sum, width) => sum + width, 0)
    // Absorb only rounding slack; membership animations leave a real gap while widths grow into place.
    if (active !== -1 && Math.abs(remainder) <= layout().tabs.length) widths[active] += remainder
    return new Map(
      layout().tabs.map((tab, index) => [
        tab.sessionID,
        {
          width: widths[index],
          selection: current.selections[index] ?? Number(tab.sessionID === activeID()),
          activity: current.activities[index] ?? Number(statuses().get(tab.sessionID)!.complete),
        },
      ]),
    )
  })

  const holdCloseCell = (sessionID: string, x: number) => {
    if (!strip) return clearCloseHold()
    const current = layout()
    const index = current.tabs.findIndex((tab) => tab.sessionID === sessionID)
    const all = items()
    const itemIndex = all.findIndex((tab) => tab.sessionID === sessionID)
    const target = all[itemIndex + 1] ?? all[itemIndex - 1]
    if (index === -1 || itemIndex === -1 || !target) return clearCloseHold()
    const ids = current.tabs.map((tab) => tab.sessionID)
    const values = ids.map((id) => visuals().get(id))
    if (values.some((value) => !value)) return clearCloseHold()
    setCloseHold({
      items: all.map((tab) => tab.sessionID),
      ids,
      widths: values.map((value) => value!.width),
      closed: sessionID,
      target: target.sessionID,
      x: x - strip.screenX,
    })
    if (closeHoldTimer) clearTimeout(closeHoldTimer)
    closeHoldTimer = setTimeout(releaseCloseHold, MOUSE_CLOSE_HOLD_MS)
  }

  // Map an absolute pointer column to the items index of the visible slot beneath it.
  const slotAt = (x: number) => {
    if (!strip) return undefined
    const stripX = x - strip.screenX
    let edge = layout().before > 0 ? sessionTabOverflowWidth(layout().before) : 0
    for (const [index, width] of layout().widths.entries()) {
      edge += width
      if (stripX < edge) return layout().before + index
    }
    return layout().before + layout().widths.length - 1
  }

  const release = () => {
    const source = dragging()
    if (!source) return
    if (didDrag) suppressClick = true
    setDragging(undefined)
    const pending = preview()
    if (pending?.sessionID === source) tabs.move(pending.sessionID, pending.index)
    if (source === NEW_SESSION_TAB.sessionID) return
    tabs.select(source)
  }

  const drag = (event: MouseEvent) => {
    const source = dragging()
    if (!source || source === NEW_SESSION_TAB.sessionID) return
    didDrag = true
    const slot = slotAt(event.x)
    const target = slot === undefined ? undefined : Math.min(slot, tabs.tabs().length - 1)
    const sourceIndex = items().findIndex((item) => item.sessionID === source)
    if (target !== undefined && target !== sourceIndex && preview()?.index !== target) {
      setPreview({ sessionID: source, index: target })
    }
  }

  return (
    <box
      ref={(element) => (strip = element)}
      height={1}
      flexShrink={0}
      position="relative"
      flexDirection="row"
      zIndex={1}
      onMouseOut={(event) => {
        marquee.leaveHovered()
        if (!strip) return
        if (
          event.x < strip.screenX ||
          event.x >= strip.screenX + strip.width ||
          event.y < strip.screenY ||
          event.y >= strip.screenY + strip.height
        )
          releaseCloseHold()
      }}
      onMouseUp={(event) => {
        if (event.button === RIGHT_MOUSE_BUTTON) return
        release()
        if (!didDrag) return
        didDrag = false
        queueMicrotask(() => (suppressClick = false))
      }}
      onMouseDrag={drag}
      onMouseDragEnd={release}
    >
      <Show when={layout().before > 0}>
        <text width={sessionTabOverflowWidth(layout().before)} fg={theme.text.subdued} selectable={false}>
          ‹{layout().before}
        </text>
      </Show>
      <For each={layout().tabs}>
        {(tab) => {
          const selected = () => activeID() === tab.sessionID
          const status = () => statuses().get(tab.sessionID)!
          const width = () => visuals().get(tab.sessionID)?.width ?? 1
          const selection = () => visuals().get(tab.sessionID)?.selection ?? Number(selected())
          const activity = () => visuals().get(tab.sessionID)?.activity ?? Number(status().complete)
          const dragged = () => dragging() === tab.sessionID
          const background = createMemo(() => {
            const lifted = (hovered() === tab.sessionID || dragged()) && !selected()
            const base = lifted ? theme.background.action.primary.hovered : theme.background.default
            // A dragged tab lifts to full selected elevation while it is held.
            return tint(base, theme.raise(theme.background.surface.offset), dragged() ? 1 : selection())
          })
          const pulseColor = () => tint(background(), theme.text.default, 0.45)
          // The edge flash washes toward a brighter stop on the same background-to-text ramp,
          // so it reads as a lift of the pulse color rather than a different hue.
          const flashColor = () => tint(background(), theme.text.default, 0.65)
          const feedbackColor = () => tabFeedbackColor(status(), theme)
          const glowLevel = createGlowLevel(() => selected() && Boolean(status().attention), animations)
          const glowColor = createMemo(() => tint(background(), feedbackColor() ?? unreadColor(), glowLevel()))
          const glows = () =>
            Boolean(status().attention || (!selected() && !status().busy && status().unread !== undefined))
          const title = () => data?.session.get(tab.sessionID)?.title ?? tab.title ?? "Untitled session"
          const tabNumber = createMemo(() => items().findIndex((item) => item.sessionID === tab.sessionID) + 1)
          const numberWidth = () => Math.max(2, String(items().length).length)
          // Hovering reveals the close mark, so the title's right bound shifts left of it.
          const restingTitleWidth = () => Math.max(1, width() - 1 - numberWidth())
          const hoveredTitleWidth = () => Math.max(1, restingTitleWidth() - 2)
          const availableTitleWidth = () => (hovered() === tab.sessionID ? hoveredTitleWidth() : restingTitleWidth())
          const scrolling = () => marquee.active() === tab.sessionID
          const visibleTitleParts = createMemo(() =>
            scrolling()
              ? marqueeTextParts(title(), availableTitleWidth(), marquee.offset())
              : Locale.graphemes(Locale.takeWidth(title(), availableTitleWidth())).map((value) => ({
                  value,
                  separator: false,
                })),
          )
          const visibleTitle = createMemo(() =>
            visibleTitleParts()
              .map((part) => part.value)
              .join(""),
          )
          const titleFades = createMemo(
            () => marqueeOverflows(title(), availableTitleWidth()) && availableTitleWidth() > FADE_WIDTH,
          )
          const runs = () => status().busy && !status().attention
          const numberIgnition = createNumberIgnition(runs, () => status().promptPulse, animations)
          const foreground = () => {
            if (hovered() === tab.sessionID) return theme.text.default
            return tint(theme.text.subdued, theme.text.default, selection())
          }
          // Title characters sitting over the glow tinge toward its color, following the same
          // spatial falloff as the glow itself; characters beyond the tail stay neutral.
          const characterColor = (index: number, separator: boolean) => {
            const base = foreground()
            const color = glows() ? glowTextColor(base, glowColor(), 1 + numberWidth() + index, width()) : base
            const faded = titleFades()
              ? fadeTitleColor(
                  color,
                  background(),
                  index,
                  visibleTitleParts().length,
                  scrolling() ? marquee.leading() : 0,
                )
              : color
            return separator ? tint(faded, background(), 0.55) : faded
          }
          // The running sweep's level under the number cell, reported by the pulse renderable.
          const [sweepLevel, setSweepLevel] = createSignal(0)
          const [closeHovered, setCloseHovered] = createSignal(false)
          const numberColor = () => {
            const feedback = feedbackColor()
            const base =
              hovered() === tab.sessionID && !selected()
                ? foreground()
                : tint(idleNumber(), tint(theme.text.default, background(), 0.25), selection())
            const color = runs() ? activeNumber() : (feedback ?? tint(base, unreadColor(), activity()))
            // The number brightens faintly as the running sweep passes beneath it.
            return tint(color, theme.text.default, Math.max(numberIgnition.value().level, 0.15 * sweepLevel()))
          }
          const bold = () => (selected() || dragged() ? TextAttributes.BOLD : undefined)
          const closeColor = () => tint(theme.text.subdued, theme.text.default, 0.6)
          return (
            <box
              width={width()}
              position="relative"
              flexDirection="row"
              backgroundColor={background()}
              onMouseOver={() => marquee.enter(tab.sessionID, title(), hoveredTitleWidth())}
              onMouseOut={() => marquee.leave(tab.sessionID)}
              onMouseDown={(event) => {
                if (event.button === MIDDLE_MOUSE_BUTTON) {
                  releaseCloseHold()
                  didDrag = false
                  setDragging(undefined)
                  tabs.close(tab === NEW_SESSION_TAB ? undefined : tab.sessionID)
                  event.preventDefault()
                  event.stopPropagation()
                  return
                }
                if (event.button === RIGHT_MOUSE_BUTTON) {
                  releaseCloseHold()
                  didDrag = false
                  setDragging(undefined)
                  setContextMenu({
                    x: event.x,
                    y: event.y,
                    sessionID: tab === NEW_SESSION_TAB ? undefined : tab.sessionID,
                    title: tab === NEW_SESSION_TAB ? undefined : tab.title,
                  })
                  event.preventDefault()
                  event.stopPropagation()
                  return
                }
                didDrag = false
                releaseCloseHold()
                marquee.enter(tab.sessionID, title(), hoveredTitleWidth())
                setDragging(tab.sessionID)
              }}
            >
              <TabPulse
                enabled={animations()}
                active={status().busy && !status().attention}
                promptPulse={status().promptPulse}
                complete={status().complete && !status().attention}
                glow={glows()}
                color={pulseColor()}
                glowColor={glowColor()}
                flashColor={flashColor()}
                completionColor={unreadColor()}
                backgroundColor={background()}
                onLevel={setSweepLevel}
              />
              <box zIndex={1} width="100%" flexDirection="row">
                <TabIndicator
                  status={status()}
                  label={tab === NEW_SESSION_TAB ? "+" : sessionTabNumberLabel(tabNumber() - 1)}
                  width={numberWidth()}
                  color={numberColor()}
                  unreadColor={feedbackColor() ?? unreadColor()}
                  backgroundColor={background()}
                  flashColor={theme.text.default}
                  animations={animations()}
                  numbers={props.numbers}
                  spinner={props.spinner}
                  unreadMarker={props.unreadMarker}
                  attributes={bold()}
                />
                <title_shimmer
                  width={availableTitleWidth()}
                  height={1}
                  fg={foreground()}
                  rename={{ pending: status().renaming, title: title() }}
                  enabled={animations()}
                  backdrop={background()}
                  wrapMode="none"
                  selectable={false}
                  attributes={status().renaming && !animations() ? TextAttributes.DIM : bold()}
                >
                  <Show when={scrolling() || glows() || titleFades()} fallback={visibleTitle()}>
                    <Index each={visibleTitleParts()}>
                      {(part, index) => (
                        <span style={{ fg: characterColor(index, part().separator) }}>{part().value}</span>
                      )}
                    </Index>
                  </Show>
                </title_shimmer>
                <text
                  position="absolute"
                  right={1}
                  zIndex={2}
                  width={1}
                  fg={closeHovered() ? theme.text.default : closeColor()}
                  selectable={false}
                  onMouseOver={() => setCloseHovered(true)}
                  onMouseOut={() => setCloseHovered(false)}
                  onMouseDown={(event) => {
                    if (event.button === RIGHT_MOUSE_BUTTON || hovered() !== tab.sessionID) return
                    didDrag = false
                    event.stopPropagation()
                  }}
                  onMouseUp={(event) => {
                    if (event.button === RIGHT_MOUSE_BUTTON) return
                    if (suppressClick) return
                    // The close mark only renders while hovered; without motion events a click can
                    // land here first, and must select the tab instead of closing it invisibly.
                    if (hovered() !== tab.sessionID) return
                    event.stopPropagation()
                    holdCloseCell(tab.sessionID, event.x)
                    tabs.close(tab === NEW_SESSION_TAB ? undefined : tab.sessionID)
                  }}
                >
                  {hovered() === tab.sessionID ? "✕" : ""}
                </text>
              </box>
            </box>
          )
        }}
      </For>
      <Show when={layout().after > 0}>
        <text width={sessionTabOverflowWidth(layout().after)} fg={theme.text.subdued} selectable={false}>
          {" " + layout().after}›
        </text>
      </Show>
      <Show when={showPlus()}>
        <text
          width={ADD_TAB_WIDTH}
          fg={addHovered() ? theme.text.default : theme.text.subdued}
          bg={addHovered() ? theme.background.action.primary.hovered : undefined}
          selectable={false}
          onMouseOver={() => setAddHovered(true)}
          onMouseOut={() => setAddHovered(false)}
          onMouseDown={(event) => {
            releaseCloseHold()
            didDrag = false
            setDragging(undefined)
            addPressed = event.button !== RIGHT_MOUSE_BUTTON
            if (addPressed) return
            setContextMenu({ x: event.x, y: event.y })
            event.preventDefault()
            event.stopPropagation()
          }}
          onMouseUp={(event) => {
            if (event.button === RIGHT_MOUSE_BUTTON) return
            if (suppressClick) return
            if (!addPressed) return
            addPressed = false
            tabs.add?.()
          }}
          onMouseDragEnd={() => (addPressed = false)}
        >
          {" + "}
        </text>
      </Show>
      <Show when={contextMenu()}>
        {(state) => <TabContextMenu state={state()} tabs={tabs} onClose={() => setContextMenu(undefined)} />}
      </Show>
    </box>
  )
}
