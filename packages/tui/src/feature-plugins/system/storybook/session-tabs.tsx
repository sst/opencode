import { Plugin } from "@opencode/plugin/tui"
import { useTerminalDimensions } from "@opentui/solid"
import { batch, createSignal, For, Show } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import {
  EMPTY_SESSION_TAB_STATUS,
  SessionTabs,
  TAB_SPINNERS,
  TAB_UNREAD_MARKERS,
  type SessionTabsController,
  type TabSpinner,
  type TabUnreadMarker,
} from "../../../component/session-tabs"
import { closeSessionTab, cycleSessionTab, moveSessionTab } from "../../../context/session-tabs-model"
import { StoryFooter } from "./footer"
import { DialogPrompt } from "../../../ui/dialog-prompt"
import { useDialog } from "../../../ui/dialog"
import { DialogSelect } from "../../../ui/dialog-select"
import {
  clampSessionTabsWidth,
  sessionTabsFitVertically,
  SESSION_SIDEBAR_WIDTH,
  SESSION_TABS_COMPACT_BREAKPOINT,
  SESSION_TABS_COMPACT_WIDTH,
} from "../../../ui/layout"
import { createPaneResize } from "../../../ui/pane-resize"
import { PaneResizeHandle } from "../../../ui/pane-resize-handle"
import type { Story } from "./index"

type FixtureStatus = ReturnType<SessionTabsController["status"]>

const FIXTURE_TABS = [
  { sessionID: "fixture-1", title: "Implement session tabs", project: "opencode" },
  { sessionID: "fixture-2", title: "Investigate rendering", project: "opencode" },
  { sessionID: "fixture-3", title: "A deliberately long session title for truncation", project: "opencode-slack" },
  { sessionID: "fixture-4", title: "Fix provider state", project: "opencode" },
  { sessionID: "fixture-5", title: "Review animation", project: "opencode-slack" },
  { sessionID: "fixture-6", title: "Untitled behavior", project: "opencode-drive" },
  { sessionID: "fixture-7", title: "Queue follow-up work", project: "opencode" },
  { sessionID: "fixture-8", title: "Check narrow layout", project: "opencode-drive" },
  { sessionID: "fixture-9", title: "Profile terminal output", project: "opencode" },
  { sessionID: "fixture-10", title: "Handle permission", project: "opencode-slack" },
  { sessionID: "fixture-11", title: "Run focused tests", project: "opencode" },
  { sessionID: "fixture-12", title: "Prepare review", project: "opencode-drive" },
]

const FIXTURE_STATUSES: Record<string, FixtureStatus> = {
  "fixture-2": { ...EMPTY_SESSION_TAB_STATUS, busy: true },
  "fixture-3": { ...EMPTY_SESSION_TAB_STATUS, busy: true, attention: "question" },
  "fixture-4": { ...EMPTY_SESSION_TAB_STATUS, busy: true, attention: "permission" },
  "fixture-5": { ...EMPTY_SESSION_TAB_STATUS, unread: "activity" },
  "fixture-6": { ...EMPTY_SESSION_TAB_STATUS, unread: "error" },
}
const FIXTURE_OUTCOMES = { "fixture-5": "completed", "fixture-6": "failed" } as const

// Plausible targets for the fake transcript's tool calls, picked per fixture index.
const TRANSCRIPT_FILES = [
  "packages/tui/src/component/session-tabs.tsx",
  "packages/tui/src/component/tab-pulse.tsx",
  "packages/tui/src/context/session-tabs-model.ts",
  "packages/core/src/session/runner.ts",
  "packages/server/src/routes/session.ts",
  "packages/tui/src/ui/animation.ts",
]

function SessionTabsStory(props: { context: Plugin.Context }) {
  const dimensions = useTerminalDimensions()
  const theme = props.context.theme
  const dialog = useDialog()
  // A keyed store mirrors production: retitles mutate rows in place instead of remounting them.
  const [tabStore, setTabStore] = createStore<{ items: { sessionID: string; title?: string }[] }>({
    items: FIXTURE_TABS.slice(0, 6).map((tab) => ({ ...tab })),
  })
  const tabs = () => tabStore.items
  const setItems = (next: { sessionID: string; title?: string }[]) =>
    setTabStore("items", reconcile(next, { key: "sessionID" }))
  const [active, setActive] = createSignal<string | undefined>("fixture-1")
  const [lastEvent, setLastEvent] = createSignal("idle / working / question / permission / complete / error")
  const [statuses, setStatuses] = createSignal<Record<string, FixtureStatus>>(FIXTURE_STATUSES)
  const [orientation, setOrientation] = createSignal<"horizontal" | "vertical">("vertical")
  const [width, setWidth] = createSignal(SESSION_SIDEBAR_WIDTH)
  const resize = createPaneResize({
    value: width,
    defaultValue: () => SESSION_SIDEBAR_WIDTH,
    clamp: (width) => clampSessionTabsWidth(width, dimensions().width),
    fromMouse: (event) => event.x + 1,
    contains: (event, width) => event.x >= width - 1 && event.x <= width,
    onCommit: setWidth,
  })
  const vertical = () => orientation() === "vertical" && sessionTabsFitVertically(dimensions().width, resize.size())
  const [indicators, setIndicators] = createSignal<"status" | "numbers">("status")
  const railCompact = () => resize.size() < SESSION_TABS_COMPACT_BREAKPOINT
  const spinners = Object.keys(TAB_SPINNERS) as TabSpinner[]
  const [spinner, setSpinner] = createSignal<TabSpinner>("dots")
  const markers = Object.keys(TAB_UNREAD_MARKERS) as TabUnreadMarker[]
  const [marker, setMarker] = createSignal<TabUnreadMarker>("small-dot")
  const [animations, setAnimations] = createSignal(true)
  // Unread clears on select, so the transcript remembers how each session's last run ended.
  const [outcomes, setOutcomes] = createSignal<Record<string, "completed" | "failed">>(FIXTURE_OUTCOMES)
  const number = (sessionID: string) => tabs().findIndex((tab) => tab.sessionID === sessionID) + 1

  function finishRun(sessionID: string, failed = Math.random() >= 0.75) {
    if (!tabs().some((item) => item.sessionID === sessionID)) return
    const unread = active() === sessionID ? undefined : failed ? ("error" as const) : ("activity" as const)
    batch(() => {
      setOutcomes((current) => ({ ...current, [sessionID]: failed ? "failed" : "completed" }))
      setStatuses((current) => ({
        ...current,
        [sessionID]: { ...(current[sessionID] ?? EMPTY_SESSION_TAB_STATUS), busy: false, attention: false, unread },
      }))
      // An untitled session earns its title after its first completed run, like a real summarization.
      const index = number(sessionID) - 1
      const fixture = FIXTURE_TABS.find((tab) => tab.sessionID === sessionID)
      if (!failed && fixture && tabs()[index]?.title === undefined) setTabStore("items", index, "title", fixture.title)
    })
    setLastEvent(
      `tab ${number(sessionID)} ${failed ? "failed" : "completed"}${unread ? " (unread)" : " while selected"}`,
    )
  }

  const select = (sessionID: string) => {
    const status = statuses()[sessionID]
    batch(() => {
      setActive(sessionID)
      if (status?.unread) setStatuses((current) => ({ ...current, [sessionID]: { ...status, unread: undefined } }))
    })
  }

  const addTab = () => {
    const next = FIXTURE_TABS.find((fixture) => !tabs().some((tab) => tab.sessionID === fixture.sessionID))
    if (!next) {
      setLastEvent("all fixture tabs are open")
      return
    }
    setItems([...tabs().map((tab) => ({ ...tab })), { sessionID: next.sessionID }])
    select(next.sessionID)
    setLastEvent(`tab ${number(next.sessionID)} opened untitled; run it to earn its title`)
  }

  const controller = {
    tabs,
    current: active,
    add: addTab,
    search() {
      dialog.replace(() => (
        <DialogSelect
          title="Sessions (fixture)"
          current={active()}
          options={FIXTURE_TABS.map((tab) => ({ title: tab.title, value: tab.sessionID, description: tab.project }))}
          onSelect={(option) => {
            if (!tabs().some((tab) => tab.sessionID === option.value)) {
              setItems([...tabs(), { ...FIXTURE_TABS.find((tab) => tab.sessionID === option.value)! }])
            }
            select(option.value)
            dialog.clear()
          }}
        />
      ))
    },
    detail(sessionID) {
      return FIXTURE_TABS.find((tab) => tab.sessionID === sessionID)?.project
    },
    status(sessionID) {
      return statuses()[sessionID] ?? EMPTY_SESSION_TAB_STATUS
    },
    select,
    rename(sessionID: string) {
      dialog.replace(() => (
        <DialogPrompt
          title="Rename fixture tab"
          value={tabs().find((tab) => tab.sessionID === sessionID)?.title}
          onConfirm={(title) => {
            if (!title.trim()) return
            setTabStore("items", (tab) => tab.sessionID === sessionID, "title", title.trim())
            dialog.clear()
          }}
        />
      ))
    },
    move(sessionID: string, index: number) {
      const next = moveSessionTab(tabs(), sessionID, index)
      if (next === tabs()) return
      setItems(next.map((tab) => ({ ...tab })))
    },
    close(sessionID?: string) {
      const target = sessionID ?? active()
      if (!target) return
      const result = closeSessionTab(tabs(), target)
      if (result.tabs === tabs()) return
      batch(() => {
        setItems(result.tabs.map((tab) => ({ ...tab })))
        setStatuses((current) => {
          const updated = { ...current }
          delete updated[target]
          return updated
        })
        if (active() === target && result.next) select(result.next)
        if (active() === target && !result.next) setActive(undefined)
      })
    },
  } satisfies SessionTabsController

  const cycle = (direction: 1 | -1) => {
    const tab = cycleSessionTab(tabs(), active(), direction)
    if (tab) select(tab.sessionID)
  }
  const startRun = (sessionID: string) => {
    setStatuses((current) => ({
      ...current,
      [sessionID]: {
        ...(current[sessionID] ?? EMPTY_SESSION_TAB_STATUS),
        busy: true,
        attention: false,
        unread: undefined,
      },
    }))
    setOutcomes((current) => {
      const next = { ...current }
      delete next[sessionID]
      return next
    })
    setLastEvent(`tab ${number(sessionID)} running`)
  }
  const prompt = (sessionID: string) => {
    const wasBusy = controller.status(sessionID).busy
    setStatuses((current) => {
      const status = current[sessionID] ?? EMPTY_SESSION_TAB_STATUS
      return {
        ...current,
        [sessionID]: {
          ...status,
          busy: true,
          unread: undefined,
          promptPulse: status.promptPulse + 1,
        },
      }
    })
    setLastEvent(`prompt sent to tab ${number(sessionID)}${wasBusy ? " while running" : ""}`)
  }
  const randomInactiveTab = () => {
    const candidates = tabs().filter((tab) => {
      const status = controller.status(tab.sessionID)
      return !status.busy && !status.unread && !status.attention
    })
    // Untitled sessions run first so their title arrival is easy to trigger.
    const untitled = candidates.filter((tab) => tab.title === undefined)
    const pool = untitled.length > 0 ? untitled : candidates
    return pool[Math.floor(Math.random() * pool.length)]
  }
  const randomRunningTab = () => {
    const candidates = tabs().filter((tab) => {
      const status = controller.status(tab.sessionID)
      return status.busy && !status.attention
    })
    return candidates[Math.floor(Math.random() * candidates.length)]
  }
  // A fake transcript for the selected session so tab switches feel like moving between real
  // sessions; the tail line tracks the live status of the current run.
  const transcript = () => {
    const current = active()
    if (!current) return [{ text: "no session selected", color: theme.text.subdued }]
    const index = Math.max(
      0,
      FIXTURE_TABS.findIndex((fixture) => fixture.sessionID === current),
    )
    const fixture = FIXTURE_TABS[index]
    const status = controller.status(current)
    const outcome = outcomes()[current]
    const file = TRANSCRIPT_FILES[index % TRANSCRIPT_FILES.length]
    const lines = [
      { text: `> ${fixture.title}`, color: theme.text.default },
      { text: "", color: theme.text.default },
    ]
    if (!status.busy && !status.attention && outcome === undefined) {
      lines.push({ text: "no activity yet — press s to run this session", color: theme.text.subdued })
      return lines
    }
    lines.push(
      { text: "● Taking a look — reading the relevant code first.", color: theme.text.default },
      { text: "", color: theme.text.default },
      { text: `  ✱ Read ${file}`, color: theme.text.subdued },
      { text: `  ✱ Edit ${file}`, color: theme.text.subdued },
      { text: `  ✱ Bash bun run test`, color: theme.text.subdued },
      { text: "", color: theme.text.default },
    )
    if (status.attention === "question")
      lines.push({ text: "? Which approach should I take?", color: theme.text.status.question })
    else if (status.attention === "permission")
      lines.push({ text: "! Waiting for permission to run the command", color: theme.text.status.permission })
    else if (status.busy) lines.push({ text: "● Working…", color: theme.text.status.running })
    else if (outcome === "failed")
      lines.push({
        text: `✗ bun run test failed — 3 tests failing in ${file}`,
        color: theme.text.feedback.error.default,
      })
    else
      lines.push({
        text: `✓ Done — updated ${file} and the tests pass.`,
        color: theme.text.feedback.success.default,
      })
    return lines
  }

  const stateSummary = () => {
    const values = tabs().map((tab) => controller.status(tab.sessionID))
    const running = values.filter((status) => status.busy && !status.attention).length
    const waiting = values.filter((status) => status.attention).length
    const unread = values.filter((status) => status.unread !== undefined).length
    return [`selected ${number(active() ?? "")}`, `${running} running`, `${waiting} waiting`, `${unread} unread`].join(
      "  ·  ",
    )
  }

  const reset = (showcase = false) => {
    batch(() => {
      setItems(FIXTURE_TABS.slice(0, 6).map((tab) => ({ ...tab })))
      setStatuses(showcase ? FIXTURE_STATUSES : {})
      setOutcomes(showcase ? FIXTURE_OUTCOMES : {})
      setActive("fixture-1")
      setSpinner("dots")
      setMarker("small-dot")
      setAnimations(true)
      setOrientation("vertical")
      setWidth(SESSION_SIDEBAR_WIDTH)
      setIndicators("status")
    })
    setLastEvent(showcase ? "all six states are visible" : "reset; all tabs idle")
  }

  props.context.keymap.layer(() => ({
    commands: [
      {
        bind: "escape",
        title: "Back to storybook",
        group: "Storybook",
        run() {
          props.context.ui.router.navigate({ type: "plugin", name: "storybook" })
        },
      },
      { bind: "up,k,left,h", title: "Previous tab", group: "Storybook", run: () => cycle(-1) },
      { bind: "down,j,right,l", title: "Next tab", group: "Storybook", run: () => cycle(1) },
      ...Array.from({ length: 10 }, (_, index) => ({
        bind: `${(index + 1) % 10},ctrl+${(index + 1) % 10}`,
        title: `Select tab ${index + 1}`,
        group: "Storybook",
        run() {
          const tab = tabs()[index]
          if (tab) select(tab.sessionID)
        },
      })),
      {
        bind: "space",
        title: "Start a random tab",
        group: "Storybook",
        run() {
          const tab = randomInactiveTab()
          if (!tab) {
            setLastEvent("every tab is busy or unread; select tabs to read them, or press r")
            return
          }
          startRun(tab.sessionID)
        },
      },
      {
        bind: "e",
        title: "End a random running tab",
        group: "Storybook",
        run() {
          const tab = randomRunningTab()
          if (!tab) {
            setLastEvent("no tabs are running; press space to start one")
            return
          }
          finishRun(tab.sessionID)
        },
      },
      {
        bind: "p",
        title: "Prompt selected tab",
        group: "Storybook",
        run() {
          const current = active()
          if (!current) return
          prompt(current)
        },
      },
      {
        // Random runs may select any eligible tab; this command guarantees the edge flash
        // and running sweep can be watched under the cursor.
        bind: "s",
        title: "Run selected tab",
        group: "Storybook",
        run() {
          const current = active()
          if (!current) return
          if (controller.status(current).busy && !controller.status(current).attention) {
            setLastEvent(`tab ${number(current)} is already running`)
            return
          }
          startRun(current)
        },
      },
      ...(
        [
          { bind: "q", title: "Ask a question", attention: "question" },
          { bind: "a", title: "Request permission", attention: "permission" },
          { bind: "i", title: "Set idle", attention: false },
        ] as const
      ).map((state) => ({
        bind: state.bind,
        title: state.title,
        group: "Storybook",
        run() {
          const current = active()
          if (!current) return
          startRun(current)
          setStatuses((statuses) => ({
            ...statuses,
            [current]: { ...EMPTY_SESSION_TAB_STATUS, busy: Boolean(state.attention), attention: state.attention },
          }))
          setLastEvent(`tab ${number(current)} ${state.attention || "idle"}`)
        },
      })),
      ...(
        [
          { bind: "f", title: "Complete selected tab", failed: false },
          { bind: "x", title: "Fail selected tab", failed: true },
        ] as const
      ).map((state) => ({
        bind: state.bind,
        title: state.title,
        group: "Storybook",
        run() {
          const current = active()
          if (!current) return
          // Leave the result unread so its indicator can be inspected before selecting it again.
          cycle(1)
          finishRun(current, state.failed)
        },
      })),
      {
        bind: "c",
        title: "Cycle spinner shape",
        group: "Storybook",
        run: () => setSpinner((value) => spinners[(spinners.indexOf(value) + 1) % spinners.length]),
      },
      {
        bind: "u",
        title: "Cycle unread marker",
        group: "Storybook",
        run: () => setMarker((value) => markers[(markers.indexOf(value) + 1) % markers.length]),
      },
      { bind: "m", title: "Toggle animations", group: "Storybook", run: () => setAnimations((value) => !value) },
      {
        bind: "g",
        title: "Toggle status icons or numbers",
        group: "Storybook",
        run: () => setIndicators((value) => (value === "status" ? "numbers" : "status")),
      },
      { bind: "t", title: "Add tab", group: "Storybook", run: addTab },
      { bind: "d", title: "Close tab", group: "Storybook", run: () => controller.close() },
      {
        bind: "b",
        title: "Switch minimum or default width",
        group: "Storybook",
        run: () => setWidth(railCompact() ? SESSION_SIDEBAR_WIDTH : SESSION_TABS_COMPACT_WIDTH),
      },
      {
        bind: "n",
        title: "Cycle tab count",
        group: "Storybook",
        run() {
          const count = tabs().length < 6 ? 6 : tabs().length < 12 ? 12 : 3
          setItems(FIXTURE_TABS.slice(0, count).map((tab) => ({ ...tab })))
          if (!tabs().some((tab) => tab.sessionID === active())) setActive("fixture-1")
        },
      },
      {
        bind: "o",
        title: "Toggle tab orientation",
        group: "Storybook",
        run() {
          setOrientation((value) => (value === "vertical" ? "horizontal" : "vertical"))
        },
      },
      { bind: "r,shift+r", title: "Reset to idle", group: "Storybook", run: () => reset() },
      { bind: "v", title: "Show all states", group: "Storybook", run: () => reset(true) },
    ],
  }))

  return (
    <box
      width={dimensions().width}
      height={dimensions().height}
      flexDirection="column"
      backgroundColor={theme.background.default}
    >
      <box
        flexGrow={1}
        minHeight={0}
        flexDirection={vertical() ? "row" : "column"}
        onMouseDrag={resize.onMouseDrag}
        onMouseDragEnd={resize.onMouseDragEnd}
        onMouseUp={resize.onMouseUp}
      >
        <SessionTabs
          controller={controller}
          orientation={vertical() ? "vertical" : "horizontal"}
          width={resize.size()}
          spinner={spinner()}
          unreadMarker={marker()}
          animations={animations()}
          indicators={indicators()}
        />
        <box flexGrow={1} minWidth={0} paddingLeft={2} paddingRight={2} paddingTop={1} flexDirection="column">
          <For each={transcript()}>
            {(line) => (
              <text fg={line.color} wrapMode="none" selectable={false}>
                {line.text || " "}
              </text>
            )}
          </For>
        </box>
        <Show when={vertical()}>
          <PaneResizeHandle resize={resize} left={resize.size() - 1} />
        </Show>
      </box>
      <StoryFooter
        context={props.context}
        title="storybook / tabs"
        details={[
          vertical() ? `${railCompact() ? "compact rail" : "expanded rail"} · ${resize.size()} cols` : "top strip",
          spinner(),
          indicators(),
          `${TAB_UNREAD_MARKERS[marker()]} ${marker()}`,
          animations() ? "animated" : "still",
        ]}
        status={stateSummary()}
        message={lastEvent()}
        controls={[
          { shortcut: "b", label: "min/default width" },
          { shortcut: "n", label: "3/6/12 tabs" },
          { shortcut: "s", label: "work" },
          { shortcut: "space/e", label: "random work" },
          { shortcut: "p", label: "prompt" },
          { shortcut: "q", label: "question" },
          { shortcut: "a", label: "permission" },
          { shortcut: "i", label: "idle" },
          { shortcut: "f/x", label: "complete/fail" },
          { shortcut: "t/d", label: "add/close" },
          { shortcut: "c", label: "spinner" },
          { shortcut: "g", label: "status/numbers" },
          { shortcut: "u", label: "unread marker" },
          { shortcut: "m", label: "motion" },
          { shortcut: "↑/↓", label: "select" },
          { shortcut: "o", label: "layout" },
          { shortcut: "drag edge", label: "resize / double-click reset" },
          { shortcut: "r", label: "reset idle" },
          { shortcut: "v", label: "all states" },
          { shortcut: "esc", label: "back" },
        ]}
      />
    </box>
  )
}

export const sessionTabsStory: Story = {
  id: "session-tabs",
  title: "Tabs",
  render: (context) => <SessionTabsStory context={context} />,
}
