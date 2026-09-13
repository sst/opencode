/** @jsxImportSource @opentui/solid */
import { TextAttributes, type InputRenderable, type KeyEvent } from "@opentui/core"
import { useKeyboard, useRenderer, useTerminalDimensions, type JSX } from "@opentui/solid"
import fuzzysort from "fuzzysort"
import { createEffect, createMemo, createSignal, type Accessor } from "solid-js"
import { Keymap } from "../context/keymap"
import { Config } from "../config"
import { OneCellSpinner } from "../component/one-cell-spinner"
import { SEED_MONO, WORK_SPINNERS } from "../ui/one-cell-motion"
import {
  FOOTER_COMPACT_WIDTH,
  RunFooterMenu,
  createFooterMenuState,
  footerMenuText,
  type RunFooterMenuItem,
} from "./footer.menu"
import { stringWidth } from "../util/string-width"
import { monoShortcut } from "./mono"
import type { RunFooterTheme } from "./theme"
import type {
  FooterQueuedPrompt,
  FooterSubagentTab,
  MiniSettingChange,
  MiniSettings,
  RunAgent,
  RunCommand,
  RunInput,
  RunProvider,
} from "./types"
import { matchMiniVerbosity, verbosityChange, verbosityLabel } from "./verbosity"

type PanelEntry = RunFooterMenuItem & {
  category: string
  keywords?: string
}

type CommandEntry =
  | (PanelEntry & { action: "agent" })
  | (PanelEntry & { action: "model" })
  | (PanelEntry & { action: "editor" })
  | (PanelEntry & { action: "skill" })
  | (PanelEntry & { action: "queued" })
  | (PanelEntry & { action: "subagent" })
  | (PanelEntry & { action: "status" })
  | (PanelEntry & { action: "variant.cycle" })
  | (PanelEntry & { action: "variant.list" })
  | (PanelEntry & { action: "settings" })
  | (PanelEntry & { action: "slash"; name: string })
  | (PanelEntry & { action: "clear" })
  | (PanelEntry & { action: "exit" })

type ModelEntry = PanelEntry & {
  providerID: string
  modelID: string
  providerName: string
  current: boolean
}

type AgentEntry = PanelEntry & {
  id: string
  current: boolean
}

type VariantEntry = PanelEntry & {
  variant: string | undefined
  current: boolean
}

type SkillEntry = PanelEntry & {
  name: string
}

type QueuedPromptEntry = PanelEntry & {
  prompt: FooterQueuedPrompt
}

type SubagentEntry = PanelEntry & {
  sessionID: string
  current: boolean
}

type SettingEntry = PanelEntry & {
  key: keyof MiniSettings | "verbosity"
}

const PANEL_PAD = 2
const panelPad = (mono?: boolean) => (mono ? 1 : PANEL_PAD)
const PANEL_LIST_ROWS = 10
const PANEL_FRAME_ROWS = 6
export const RUN_COMMAND_PANEL_ROWS = PANEL_LIST_ROWS + PANEL_FRAME_ROWS
const SUBAGENT_LIST_ROWS = 12
export const RUN_SUBAGENT_PANEL_ROWS = SUBAGENT_LIST_ROWS + PANEL_FRAME_ROWS
export function footerPanelLayout(height: number, limit = PANEL_LIST_ROWS) {
  const available = Math.max(3, height - 1)
  const compact = available < limit + PANEL_FRAME_ROWS
  const frame = compact ? 2 : PANEL_FRAME_ROWS
  return { compact, frame, limit: Math.max(1, Math.min(limit, available - frame)) }
}
const HALF_BLOCK_BORDER = {
  topLeft: "",
  bottomLeft: "",
  vertical: "",
  topRight: "",
  bottomRight: "",
  horizontal: "▀",
  bottomT: "",
  topT: "",
  cross: "",
  leftT: "",
  rightT: "",
}

function countLabel(count: number, total: number, query: string) {
  if (!query.trim()) {
    return `${total}`
  }

  return `${count}/${total}`
}

function subagentStatusLabel(status: FooterSubagentTab["status"]) {
  if (status === "completed") {
    return "done"
  }

  if (status === "cancelled") {
    return "cancelled"
  }

  if (status === "error") {
    return "error"
  }

  return "running"
}

function match<T extends PanelEntry>(query: string, entries: T[]) {
  const text = query.trim()
  if (!text) {
    return entries
  }

  return fuzzysort
    .go(text, entries, { keys: ["display", "category", "description", "keywords"] })
    .map((item) => item.obj)
}

function createSearchablePanelController<T extends PanelEntry>(input: {
  entries: Accessor<T[]>
  limit: number
  onClose: () => void
  onSelect: (item: T) => void
  isCurrent?: (item: T) => boolean
  closeOnFirstUp?: boolean
  onKey?: (event: KeyEvent, item: T | undefined) => boolean
  onRows?: (rows: number) => void
}) {
  const renderer = useRenderer()
  const term = useTerminalDimensions()
  const layout = createMemo(() => {
    term()
    // The panel mounts before the footer expands, so its initial render height is stale.
    return footerPanelLayout(renderer.terminalHeight, input.limit)
  })
  let field: InputRenderable | undefined
  const [query, setQuery] = createSignal("")
  const items = createMemo<T[]>(() => match(query(), input.entries()))
  const menu = createFooterMenuState({ count: () => items().length, limit: () => layout().limit })
  const selected = () => items()[menu.selected()]

  createEffect(() => {
    query()
    menu.reset()
  })

  createEffect(() => {
    if (!input.isCurrent || query().trim()) {
      return
    }

    const index = items().findIndex(input.isCurrent)
    if (index !== -1) {
      menu.reveal(index)
    }
  })

  createEffect(() => {
    input.onRows?.(menu.rows() + layout().frame)
  })

  useKeyboard((event) => {
    if (event.defaultPrevented) {
      return
    }

    if (input.onKey?.(event, selected())) {
      return
    }

    const name = event.name.toLowerCase()
    if (input.closeOnFirstUp && name === "up" && menu.selected() === 0) {
      event.preventDefault()
      input.onClose()
      return
    }

    const ctrl = event.ctrl && !event.meta && !event.shift && !event.super
    if (name === "escape" || (ctrl && name === "c")) {
      event.preventDefault()
      input.onClose()
      return
    }

    if (name === "up" || (ctrl && name === "p")) {
      event.preventDefault()
      menu.move(-1)
      return
    }

    if (name === "down" || (ctrl && name === "n")) {
      event.preventDefault()
      menu.move(1)
      return
    }

    if (name === "pageup") {
      event.preventDefault()
      menu.reveal(menu.selected() - Math.max(1, menu.limit() - 1))
      return
    }

    if (name === "pagedown") {
      event.preventDefault()
      menu.reveal(menu.selected() + Math.max(1, menu.limit() - 1))
      return
    }

    if (name === "home") {
      event.preventDefault()
      menu.reveal(0)
      return
    }

    if (name === "end") {
      event.preventDefault()
      menu.reveal(Number.POSITIVE_INFINITY)
      return
    }

    if (name === "return") {
      event.preventDefault()
      const item = selected()
      if (item) {
        input.onSelect(item)
      }
      return
    }

    if (ctrl && name === "u") {
      event.preventDefault()
      setQuery("")
      field?.setText("")
    }
  })

  return {
    query,
    setQuery,
    items,
    menu,
    layout,
    inputRef(input: InputRenderable) {
      field = input
    },
  }
}

function PanelShell(props: {
  title: string
  countVisible?: boolean
  query: string
  count: number
  total: number
  placeholder: string
  theme: Accessor<RunFooterTheme>
  inputRef: (input: InputRenderable) => void
  onQuery: (query: string) => void
  children: JSX.Element
  hint?: string
  mono?: boolean
  background?: boolean
  layout: ReturnType<typeof footerPanelLayout>
}) {
  const term = useTerminalDimensions()
  const pad = () => (term().width < FOOTER_COMPACT_WIDTH ? 1 : panelPad(props.mono))
  const header = createMemo(() => {
    const width = Math.max(0, term().width - pad() * 2 - 4)
    const title = footerMenuText(props.title, width, props.mono)
    const count = countLabel(props.count, props.total, props.query)
    const showCount = props.countVisible !== false && stringWidth(props.title) + stringWidth(count) + 1 <= width
    const hint =
      props.hint &&
      stringWidth(props.title) + (showCount ? stringWidth(count) + 1 : 0) + stringWidth(props.hint) + 3 <= width
    return { title, count: showCount ? count : undefined, hint: hint ? props.hint : undefined }
  })
  const background = () => (props.background === false ? "transparent" : props.theme().shade)
  const content = (
    <>
      <box height={props.layout.compact ? 0 : 1} flexShrink={0} backgroundColor={background()} />
      <box
        width="100%"
        height={1}
        paddingLeft={pad()}
        paddingRight={pad()}
        flexDirection="row"
        gap={0}
        flexShrink={0}
        backgroundColor={background()}
      >
        <text fg={props.theme().text} attributes={TextAttributes.BOLD} wrapMode="none" flexShrink={0}>
          {header().title}
        </text>
        {header().count ? (
          <text fg={props.theme().muted} wrapMode="none" flexShrink={0}>
            {" " + header().count}
          </text>
        ) : null}
        <box minWidth={1} flexGrow={1} flexShrink={1} backgroundColor="transparent" />
        <text fg={props.theme().muted} wrapMode="none" flexShrink={0}>
          {header().hint ? `${header().hint} ${props.mono ? "-" : "·"} ` : ""}esc
        </text>
      </box>
      <box height={props.layout.compact ? 0 : 1} flexShrink={0} backgroundColor={background()} />
      <box
        width="100%"
        height={1}
        paddingLeft={pad()}
        paddingRight={pad()}
        flexShrink={0}
        backgroundColor={background()}
      >
        <input
          width="100%"
          focusedBackgroundColor={props.background === false ? "transparent" : props.theme().formfieldFocusedBg}
          focusedTextColor={
            props.background === false ? props.theme().formfieldText : props.theme().formfieldFocusedText
          }
          placeholder={props.placeholder}
          placeholderColor={props.theme().muted}
          cursorColor={props.background === false ? props.theme().formfieldText : props.theme().formfieldFocusedText}
          onInput={props.onQuery}
          ref={(input) => {
            props.inputRef(input)
            input.traits = { status: "FILTER" }
            queueMicrotask(() => {
              if (!input.isDestroyed) {
                input.focus()
              }
            })
          }}
        />
      </box>
      <box height={props.layout.compact ? 0 : 1} flexShrink={0} backgroundColor={background()} />
      <box width="100%" flexDirection="column" flexShrink={0} backgroundColor={background()}>
        {props.children}
      </box>
    </>
  )
  return (
    <box width="100%" flexDirection="column" border={false} backgroundColor="transparent" flexShrink={0}>
      <box width="100%" flexDirection="column" border={false} backgroundColor="transparent" flexShrink={0}>
        {content}
      </box>
      <box
        width="100%"
        height={props.layout.compact ? 0 : 1}
        border={false}
        backgroundColor="transparent"
        flexShrink={0}
      >
        {props.layout.compact || props.mono || props.background === false ? null : (
          <box
            width="100%"
            height={1}
            border={["bottom"]}
            borderColor={background()}
            backgroundColor="transparent"
            customBorderChars={HALF_BLOCK_BORDER}
          />
        )}
      </box>
    </box>
  )
}

export function RunCommandMenuBody(props: {
  theme: Accessor<RunFooterTheme>
  commands: Accessor<RunCommand[] | undefined>
  subagents: Accessor<FooterSubagentTab[]>
  queued: Accessor<FooterQueuedPrompt[]>
  variants: Accessor<string[]>
  variantCycle: string
  onClose: () => void
  onAgent: () => void
  onModel: () => void
  onEditor: () => void
  onSkill: () => void
  onSubagent: () => void
  onQueued: () => void
  onVariant: () => void
  onVariantCycle: () => void
  onStatus: () => void
  onSettings: () => void
  onCommand: (name: string) => void
  onNew: () => void
  onClear?: () => void
  onExit: () => void
  clearShortcut?: string
  mono?: boolean
}) {
  const skills = createMemo(() => (props.commands() ?? []).filter((item) => item.source === "skill"))
  const activeSubagentCount = createMemo(() => props.subagents().filter((item) => item.status === "running").length)
  const entries = createMemo<CommandEntry[]>(() => {
    const session: CommandEntry[] = [
      {
        action: "editor",
        category: "Session",
        display: "Open editor",
        footer: "/editor",
        keywords: "editor compose draft external editor",
      },
      {
        action: "status",
        category: "Session",
        display: "Show status",
        keywords: "status activity model context usage footer",
      },
      ...(props.subagents().length > 0
        ? [
            {
              action: "subagent" as const,
              category: "Session",
              display: "View subagents",
              footer:
                activeSubagentCount() > 0 ? `${activeSubagentCount()} active` : `${props.subagents().length} recent`,
              keywords: props
                .subagents()
                .map((item) => `${item.label} ${item.description} ${item.title ?? ""}`)
                .join(" "),
            },
          ]
        : []),
      {
        action: "slash",
        category: "Session",
        name: "compact",
        display: "Compact session",
        footer: "/compact",
        keywords: "compact session context",
      },
      {
        action: "slash",
        category: "Session",
        name: "new",
        display: "New session",
        footer: "/new",
        keywords: "new session clear",
      },
    ]
    const prompt: CommandEntry[] =
      props.commands() === undefined || skills().length > 0
        ? [
            {
              action: "skill" as const,
              category: "Prompt",
              display: "Skills",
              footer: "/skills",
              keywords: `skill skills ${skills()
                .map((item) => `${item.name} ${item.description ?? ""}`)
                .join(" ")}`.trim(),
            },
          ]
        : []
    const agent: CommandEntry[] = [
      {
        action: "agent",
        category: "Agent",
        display: "Switch agent",
      },
      {
        action: "model",
        category: "Agent",
        display: "Switch model",
      },
      ...(props.queued().length > 0
        ? [
            {
              action: "queued" as const,
              category: "Agent",
              display: "View pending prompts",
              footer: `${props.queued().length} pending`,
              keywords: props
                .queued()
                .map((item) => item.prompt.text)
                .join(" "),
            },
          ]
        : []),
      {
        action: "variant.cycle",
        category: "Agent",
        display: "Variant cycle",
        footer: props.variantCycle,
        keywords: "variant cycle",
      },
      ...(props.variants().length > 0
        ? [
            {
              action: "variant.list" as const,
              category: "Agent",
              display: "Switch model variant",
              keywords: `variant variants ${props.variants().join(" ")}`,
            },
          ]
        : []),
    ]
    return [
      ...session,
      ...prompt,
      ...agent,
      {
        action: "clear",
        category: "System",
        display: "Clear screen",
        footer: props.clearShortcut,
        keywords: "clear screen cls redraw",
      },
      {
        action: "settings",
        category: "System",
        display: "Settings",
        footer: "/settings",
        keywords: "/settings settings preferences configuration",
      },
      { action: "exit", category: "System", display: "Exit", footer: "/exit", keywords: "/exit exit" },
    ]
  })
  const pick = (item: CommandEntry) => {
    if (item.action === "agent") {
      props.onAgent()
      return
    }

    if (item.action === "model") {
      props.onModel()
      return
    }

    if (item.action === "editor") {
      props.onEditor()
      return
    }

    if (item.action === "skill") {
      props.onSkill()
      return
    }

    if (item.action === "subagent") {
      props.onSubagent()
      return
    }

    if (item.action === "queued") {
      props.onQueued()
      return
    }

    if (item.action === "variant.cycle") {
      props.onVariantCycle()
      return
    }

    if (item.action === "variant.list") {
      props.onVariant()
      return
    }

    if (item.action === "status") {
      props.onStatus()
      return
    }

    if (item.action === "settings") {
      props.onSettings()
      return
    }

    if (item.action === "clear") {
      props.onClear?.()
      return
    }

    if (item.action === "exit") {
      props.onExit()
      return
    }

    if (item.name === "new") {
      props.onNew()
      return
    }

    props.onCommand(item.name)
  }
  const controller = createSearchablePanelController({
    entries,
    limit: PANEL_LIST_ROWS,
    onClose: props.onClose,
    onSelect: pick,
  })

  return (
    <PanelShell
      title="Commands"
      layout={controller.layout()}
      countVisible={false}
      query={controller.query()}
      count={controller.items().length}
      total={entries().length}
      placeholder="Search"
      theme={props.theme}
      inputRef={controller.inputRef}
      onQuery={controller.setQuery}
      mono={props.mono}
    >
      <RunFooterMenu
        theme={props.theme}
        items={controller.items}
        selected={controller.menu.selected}
        offset={controller.menu.offset}
        rows={controller.menu.limit}
        limit={controller.menu.limit()}
        compact={controller.layout().compact}
        empty="No results found"
        border={false}
        paddingLeft={panelPad(props.mono)}
        paddingRight={panelPad(props.mono)}
        grouped={!controller.query().trim()}
        background
        headerColor={props.theme().muted}
        mono={props.mono}
      />
    </PanelShell>
  )
}

export function RunAgentSelectBody(props: {
  theme: Accessor<RunFooterTheme>
  agents: Accessor<RunAgent[]>
  current: Accessor<string | undefined>
  onClose: () => void
  onSelect: (agent: string) => void
  mono?: boolean
}) {
  const entries = createMemo<AgentEntry[]>(() =>
    props
      .agents()
      .filter((agent) => agent.mode !== "subagent" && !agent.hidden)
      .map((agent) => ({
        category: "",
        display: agent.id,
        description: agent.description,
        footer: props.current() === agent.id ? "current" : undefined,
        footerTone: "selection" as const,
        keywords: `${agent.id} ${agent.name} ${agent.description ?? ""}`,
        id: agent.id,
        current: props.current() === agent.id,
      })),
  )
  const controller = createSearchablePanelController({
    entries,
    limit: PANEL_LIST_ROWS,
    onClose: props.onClose,
    onSelect: (item) => props.onSelect(item.id),
    isCurrent: (item) => item.current,
  })

  return (
    <PanelShell
      title="Select agent"
      layout={controller.layout()}
      query={controller.query()}
      count={controller.items().length}
      total={entries().length}
      placeholder="Search"
      theme={props.theme}
      inputRef={controller.inputRef}
      onQuery={controller.setQuery}
      mono={props.mono}
    >
      <RunFooterMenu
        theme={props.theme}
        items={controller.items}
        selected={controller.menu.selected}
        offset={controller.menu.offset}
        rows={controller.menu.limit}
        limit={controller.menu.limit()}
        compact={controller.layout().compact}
        empty="No agents found"
        border={false}
        paddingLeft={panelPad(props.mono)}
        paddingRight={panelPad(props.mono)}
        grouped={false}
        background
        mono={props.mono}
      />
    </PanelShell>
  )
}

export function RunSettingsBody(props: {
  theme: Accessor<RunFooterTheme>
  settings: Accessor<MiniSettings>
  onClose: () => void
  onChange: (change: MiniSettingChange) => void | Promise<void>
  mono?: boolean
  animations?: boolean
}) {
  const [saving, setSaving] = createSignal<SettingEntry["key"]>()
  const entries = createMemo<SettingEntry[]>(() => [
    {
      category: "Transcript",
      display: "Verbosity",
      footer: saving() === "verbosity" ? "saving" : verbosityLabel(matchMiniVerbosity(props.settings())),
      footerTone: saving() === "verbosity" ? "running" : "selection",
      keywords: `verbosity quiet default everything custom noise ${verbosityLabel(matchMiniVerbosity(props.settings()))}`,
      key: "verbosity",
    },
    {
      category: "Transcript",
      display: "Thinking",
      footer: saving() === "thinking" ? "saving" : props.settings().thinking,
      footerTone: saving() === "thinking" ? "running" : "selection",
      keywords: `thinking reasoning ${props.settings().thinking}`,
      key: "thinking",
    },
    {
      category: "Transcript",
      display: "Tools",
      footer: saving() === "tools" ? "saving" : props.settings().tools,
      footerTone: saving() === "tools" ? "running" : "selection",
      keywords: `tools files skills activity work steps intermediate ${props.settings().tools}`,
      key: "tools",
    },
    {
      category: "Transcript",
      display: "Shell",
      footer: saving() === "shell_output" ? "saving" : props.settings().shell_output,
      footerTone: saving() === "shell_output" ? "running" : "selection",
      keywords: `shell tool command output ${props.settings().shell_output}`,
      key: "shell_output",
    },
    {
      category: "Transcript",
      display: "Turn summary",
      footer: saving() === "turn_summary" ? "saving" : props.settings().turn_summary,
      footerTone: saving() === "turn_summary" ? "running" : "selection",
      keywords: `turn summary agent model duration ${props.settings().turn_summary}`,
      key: "turn_summary",
    },
    {
      category: "Terminal",
      display: "Footer details",
      footer: saving() === "footer" ? "saving" : props.settings().footer,
      footerTone: saving() === "footer" ? "running" : "selection",
      keywords: `footer status activity model context usage ${props.settings().footer}`,
      key: "footer",
    },
    {
      category: "Terminal",
      display: "Splash",
      footer: saving() === "splash" ? "saving" : props.settings().splash,
      footerTone: saving() === "splash" ? "running" : "selection",
      keywords: `splash entry exit banner ${props.settings().splash}`,
      key: "splash",
    },
    {
      category: "Terminal",
      display: "Monochrome UI",
      footer: saving() === "mono" ? "saving" : props.settings().mono ? "on" : "off",
      footerTone: saving() === "mono" ? "running" : "selection",
      keywords: `mono monochrome ascii legacy compat terminal ${props.settings().mono ? "on" : "off"}`,
      key: "mono",
    },
    {
      category: "Terminal",
      display: "Work spinner",
      icon: (color) => (
        <OneCellSpinner
          animation={props.mono ? SEED_MONO : WORK_SPINNERS[props.settings().work_spinner]}
          color={color}
          animations={props.animations}
          glow={!props.mono}
          still={props.mono ? "*" : undefined}
        />
      ),
      footer:
        saving() === "work_spinner"
          ? "saving"
          : props.settings().work_spinner.replace("block-", "").replaceAll("-", " "),
      footerTone: saving() === "work_spinner" ? "running" : "selection",
      keywords: `work spinner animation ${props.settings().work_spinner}`,
      key: "work_spinner",
    },
  ])
  const change = (item: SettingEntry, direction = 1) => {
    if (saving()) return
    const spinners = Config.MiniWorkSpinner.literals
    const next: MiniSettingChange | undefined =
      item.key === "verbosity"
        ? verbosityChange(props.settings(), direction < 0 ? -1 : 1)
        : item.key === "work_spinner"
          ? {
              key: "work_spinner",
              value:
                spinners[
                  (spinners.indexOf(props.settings().work_spinner) + direction + spinners.length) % spinners.length
                ]!,
            }
          : item.key === "mono"
            ? { key: "mono", value: !props.settings().mono }
            : { key: item.key, value: props.settings()[item.key] === "show" ? "hide" : "show" }
    if (!next) return
    setSaving(item.key)
    void Promise.resolve(props.onChange(next))
      .catch(() => {})
      .finally(() => setSaving())
  }
  const controller = createSearchablePanelController({
    entries,
    limit: PANEL_LIST_ROWS,
    onClose: props.onClose,
    onSelect: change,
    onKey(event, item) {
      const name = event.name.toLowerCase()
      if (name !== "left" && name !== "right") return false
      event.preventDefault()
      if (item) change(item, name === "left" ? -1 : 1)
      return true
    },
  })

  return (
    <PanelShell
      title="Settings"
      layout={controller.layout()}
      countVisible={false}
      query={controller.query()}
      count={controller.items().length}
      total={entries().length}
      placeholder="Search"
      theme={props.theme}
      inputRef={controller.inputRef}
      onQuery={controller.setQuery}
      hint="left/right change"
      mono={props.mono}
    >
      <RunFooterMenu
        theme={props.theme}
        items={controller.items}
        selected={controller.menu.selected}
        offset={controller.menu.offset}
        rows={controller.menu.limit}
        limit={controller.menu.limit()}
        compact={controller.layout().compact}
        empty="No settings found"
        border={false}
        paddingLeft={panelPad(props.mono)}
        paddingRight={panelPad(props.mono)}
        grouped={!controller.query().trim()}
        background
        headerColor={props.theme().muted}
        mono={props.mono}
      />
    </PanelShell>
  )
}

export function RunSubagentSelectBody(props: {
  theme: Accessor<RunFooterTheme>
  tabs: Accessor<FooterSubagentTab[]>
  current: Accessor<string | undefined>
  onClose: () => void
  onSelect: (sessionID: string) => void
  onRows?: (rows: number) => void
  mono?: boolean
}) {
  const [active, setActive] = createSignal(true)
  const entries = createMemo<SubagentEntry[]>(() =>
    props
      .tabs()
      .filter((item) => (active() ? item.status === "running" : item.status !== "running"))
      .map((item) => {
        const title = item.description || item.title || item.label
        return {
          category: "",
          display: title,
          description: title === item.label ? undefined : item.label,
          footer: subagentStatusLabel(item.status),
          footerTone:
            item.status === "running" || item.status === "error"
              ? item.status
              : item.status === "completed"
                ? ("success" as const)
                : undefined,
          keywords: `${item.label} ${item.description} ${item.title ?? ""} ${item.status}`,
          sessionID: item.sessionID,
          current: props.current() === item.sessionID,
        }
      }),
  )
  const controller = createSearchablePanelController({
    entries,
    limit: SUBAGENT_LIST_ROWS,
    onClose: props.onClose,
    onSelect: (item) => props.onSelect(item.sessionID),
    isCurrent: (item) => item.current,
    closeOnFirstUp: true,
    onKey(event) {
      if (event.name.toLowerCase() !== "tab") return false
      event.preventDefault()
      setActive((value) => !value)
      return true
    },
    onRows: props.onRows,
  })

  return (
    <PanelShell
      title="Select subagent"
      layout={controller.layout()}
      query={controller.query()}
      count={controller.items().length}
      total={entries().length}
      placeholder="Search"
      theme={props.theme}
      inputRef={controller.inputRef}
      onQuery={controller.setQuery}
      hint={`tab show ${active() ? "inactive" : "active"}`}
      mono={props.mono}
    >
      <RunFooterMenu
        theme={props.theme}
        items={controller.items}
        selected={controller.menu.selected}
        offset={controller.menu.offset}
        rows={controller.menu.rows}
        limit={controller.menu.limit()}
        compact={controller.layout().compact}
        empty="No subagents found"
        border={false}
        paddingLeft={panelPad(props.mono)}
        paddingRight={panelPad(props.mono)}
        grouped={false}
        background
        mono={props.mono}
      />
    </PanelShell>
  )
}

export function RunQueuedPromptSelectBody(props: {
  theme: Accessor<RunFooterTheme>
  prompts: Accessor<FooterQueuedPrompt[]>
  onClose: () => void
  onSelect: (prompt: FooterQueuedPrompt) => void
  onDelete: (prompt: FooterQueuedPrompt) => void
  onRows?: (rows: number) => void
  mono?: boolean
}) {
  const entries = createMemo<QueuedPromptEntry[]>(() =>
    props.prompts().map((prompt) => ({
      category: "",
      display: prompt.prompt.text.replaceAll("\n", " "),
      footer: prompt.delivery === "queue" ? "queued" : "steering",
      keywords: prompt.prompt.text,
      prompt,
    })),
  )
  const controller = createSearchablePanelController({
    entries,
    limit: SUBAGENT_LIST_ROWS,
    onClose: props.onClose,
    onSelect: (item) => props.onSelect(item.prompt),
    onRows: props.onRows,
  })
  const shortcuts = Keymap.useShortcuts()
  const deleteShortcut = () => monoShortcut(shortcuts.get("queued_prompt.delete") ?? "", props.mono ?? false)
  Keymap.createLayer(() => ({
    priority: 1,
    commands: [
      {
        id: "queued_prompt.delete",
        title: "Delete pending prompt",
        group: "Prompt",
        run() {
          const item = controller.items()[controller.menu.selected()]
          if (!item) return false
          props.onDelete(item.prompt)
        },
      },
    ],
  }))

  return (
    <PanelShell
      title="Pending prompts"
      layout={controller.layout()}
      query={controller.query()}
      count={controller.items().length}
      total={entries().length}
      placeholder="Search"
      theme={props.theme}
      inputRef={controller.inputRef}
      onQuery={controller.setQuery}
      hint={[
        controller.items()[controller.menu.selected()]?.prompt.delivery === "steer" ? "enter queue" : "enter steer",
        deleteShortcut() ? `${deleteShortcut()} delete` : undefined,
      ]
        .filter(Boolean)
        .join(" · ")}
      mono={props.mono}
    >
      <RunFooterMenu
        theme={props.theme}
        items={controller.items}
        selected={controller.menu.selected}
        offset={controller.menu.offset}
        rows={controller.menu.rows}
        limit={controller.menu.limit()}
        compact={controller.layout().compact}
        empty="No pending prompts"
        border={false}
        paddingLeft={panelPad(props.mono)}
        paddingRight={panelPad(props.mono)}
        grouped={false}
        background
        mono={props.mono}
      />
    </PanelShell>
  )
}

export function RunSkillSelectBody(props: {
  theme: Accessor<RunFooterTheme>
  commands: Accessor<RunCommand[] | undefined>
  onClose: () => void
  onSelect: (name: string) => void
  mono?: boolean
}) {
  const entries = createMemo<SkillEntry[]>(() =>
    (props.commands() ?? [])
      .filter((item) => item.source === "skill")
      .map((item) => ({
        category: "",
        display: item.name,
        description: item.description?.replace(/\s+/g, " ").trim() || undefined,
        keywords: `skill ${item.name} ${item.description ?? ""}`,
        name: item.name,
      }))
      .sort((a, b) => a.display.localeCompare(b.display)),
  )
  const controller = createSearchablePanelController({
    entries,
    limit: PANEL_LIST_ROWS,
    onClose: props.onClose,
    onSelect: (item) => props.onSelect(item.name),
  })

  return (
    <PanelShell
      title="Skills"
      layout={controller.layout()}
      query={controller.query()}
      count={controller.items().length}
      total={entries().length}
      placeholder="Search"
      theme={props.theme}
      inputRef={controller.inputRef}
      onQuery={controller.setQuery}
      mono={props.mono}
    >
      <RunFooterMenu
        theme={props.theme}
        items={controller.items}
        selected={controller.menu.selected}
        offset={controller.menu.offset}
        rows={controller.menu.limit}
        limit={controller.menu.limit()}
        compact={controller.layout().compact}
        empty={props.commands() ? "No skills found" : "Skills loading"}
        border={false}
        paddingLeft={panelPad(props.mono)}
        paddingRight={panelPad(props.mono)}
        grouped={false}
        background
        mono={props.mono}
      />
    </PanelShell>
  )
}

export function RunVariantSelectBody(props: {
  theme: Accessor<RunFooterTheme>
  variants: Accessor<string[]>
  current: Accessor<string | undefined>
  onClose: () => void
  onSelect: (variant: string | undefined) => void
  mono?: boolean
}) {
  const entries = createMemo<VariantEntry[]>(() => [
    {
      category: "",
      display: "Default",
      footer: props.current() === undefined ? "current" : undefined,
      footerTone: "selection",
      keywords: "default",
      variant: undefined,
      current: props.current() === undefined,
    },
    ...props.variants().map((variant) => ({
      category: "",
      display: variant,
      footer: props.current() === variant ? "current" : undefined,
      footerTone: "selection" as const,
      keywords: variant,
      variant,
      current: props.current() === variant,
    })),
  ])
  const controller = createSearchablePanelController({
    entries,
    limit: PANEL_LIST_ROWS,
    onClose: props.onClose,
    onSelect: (item) => props.onSelect(item.variant),
    isCurrent: (item) => item.current,
  })

  return (
    <PanelShell
      title="Select variant"
      layout={controller.layout()}
      query={controller.query()}
      count={controller.items().length}
      total={entries().length}
      placeholder="Search"
      theme={props.theme}
      inputRef={controller.inputRef}
      onQuery={controller.setQuery}
      mono={props.mono}
    >
      <RunFooterMenu
        theme={props.theme}
        items={controller.items}
        selected={controller.menu.selected}
        offset={controller.menu.offset}
        rows={controller.menu.limit}
        limit={controller.menu.limit()}
        compact={controller.layout().compact}
        empty="No results found"
        border={false}
        paddingLeft={panelPad(props.mono)}
        paddingRight={panelPad(props.mono)}
        grouped={false}
        background
        mono={props.mono}
      />
    </PanelShell>
  )
}

export function RunModelSelectBody(props: {
  theme: Accessor<RunFooterTheme>
  providers: Accessor<RunProvider[] | undefined>
  current: Accessor<RunInput["model"]>
  onClose: () => void
  onSelect: (model: NonNullable<RunInput["model"]>) => void
  mono?: boolean
}) {
  const entries = createMemo<ModelEntry[]>(() =>
    (props.providers() ?? [])
      .flatMap((provider) =>
        Object.entries(provider.models)
          .filter(([, model]) => model.status !== "deprecated")
          .map(([modelID, model]) => {
            const title = model.name ?? modelID
            const current = props.current()?.providerID === provider.id && props.current()?.modelID === modelID
            const footer = current
              ? "current"
              : model.cost?.input === 0 && provider.id === "opencode"
                ? "Free"
                : title !== modelID
                  ? modelID
                  : undefined
            return {
              providerID: provider.id,
              modelID,
              providerName: provider.name,
              category: provider.name,
              display: title,
              footer,
              footerTone: current ? ("selection" as const) : undefined,
              keywords: `${provider.id} ${provider.name} ${modelID} ${title} ${footer ?? ""}`,
              current,
            }
          }),
      )
      .sort((a, b) => {
        const provider = Number(a.providerID !== "opencode") - Number(b.providerID !== "opencode")
        if (provider !== 0) {
          return provider
        }

        const name = a.providerName.localeCompare(b.providerName)
        if (name !== 0) {
          return name
        }

        return a.display.localeCompare(b.display)
      }),
  )
  const controller = createSearchablePanelController({
    entries,
    limit: PANEL_LIST_ROWS,
    onClose: props.onClose,
    onSelect: (item) => props.onSelect({ providerID: item.providerID, modelID: item.modelID }),
    isCurrent: (item) => item.current,
  })

  return (
    <PanelShell
      title="Select model"
      layout={controller.layout()}
      query={controller.query()}
      count={controller.items().length}
      total={entries().length}
      placeholder="Search"
      theme={props.theme}
      inputRef={controller.inputRef}
      onQuery={controller.setQuery}
      mono={props.mono}
      background={false}
    >
      <RunFooterMenu
        theme={props.theme}
        items={() =>
          controller.query().trim() ||
          (controller.layout().compact && new Set(controller.items().map((item) => item.providerID)).size > 1)
            ? controller.items().map((item) => ({ ...item, footer: item.providerName, footerTone: undefined }))
            : controller.items()
        }
        selected={controller.menu.selected}
        offset={controller.menu.offset}
        rows={controller.menu.limit}
        limit={controller.menu.limit()}
        compact={controller.layout().compact}
        empty={props.providers() ? "No results found" : "Models loading"}
        border={false}
        paddingLeft={panelPad(props.mono)}
        paddingRight={panelPad(props.mono)}
        grouped={!controller.query().trim()}
        headerColor={props.theme().muted}
        mono={props.mono}
      />
    </PanelShell>
  )
}
