// Footer layout
//
// Renders the footer region as a compact vertical stack:
//   1. Single-line composer or active footer body
//   2. Optional autocomplete/menu panels below the composer
//   3. A statusline-style footer row carrying state, hints, and model info
//
// All state comes from the parent RunFooter through SolidJS signals.
// The view itself is stateless except for derived memos.
/** @jsxImportSource @opentui/solid */
import { useRenderer, useTerminalDimensions } from "@opentui/solid"
import { TextBuffer, TextBufferView } from "@opentui/core"
import { For, Match, Show, Switch, createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import { OneCellSpinner } from "../component/one-cell-spinner"
import { WORK_SPINNERS, SEED_LAUNCH, SEED_MONO } from "../ui/one-cell-motion"
import { entrySplashLayout } from "./splash"
import {
  RUN_SUBAGENT_PANEL_ROWS,
  RunAgentSelectBody,
  RunCommandMenuBody,
  RunModelSelectBody,
  RunQueuedPromptSelectBody,
  RunSettingsBody,
  RunSkillSelectBody,
  RunSubagentSelectBody,
  RunVariantSelectBody,
} from "./footer.command"
import { FOOTER_MENU_ROWS, RunFooterMenu } from "./footer.menu"
import { RunFooterSubagentBody } from "./footer.subagent"
import { RunPromptBody, createPromptState } from "./footer.prompt"
import { RunPermissionBody } from "./footer.permission"
import { RunFormBody } from "./footer.form"
import { createFormBodyState, type FormBodyState } from "./form.shared"
import { footerStatuslinePolicy } from "./footer.width"
import { Keymap } from "../context/keymap"
import type { ClipboardService } from "../context/clipboard"
import { modelInfo } from "./variant.shared"
import { monoShortcut } from "./mono"
import { stringWidth } from "../util/string-width"
import { formatContextUsage } from "../util/session"
import { errorMessage } from "../util/error"
import { createSingleFlight } from "../util/single-flight"

import type {
  FooterPromptRoute,
  FooterQueuedPrompt,
  FooterState,
  FooterSubagentState,
  FooterView,
  FormCancel,
  FormReply,
  MiniSettingChange,
  MiniSettings,
  PermissionReply,
  QueuedPromptAction,
  RunAgent,
  RunCommand,
  RunInput,
  RunPrompt,
  RunProvider,
  RunReference,
  RunTuiConfig,
} from "./types"
import type { RunTheme } from "./theme"

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" })

const EMPTY_BORDER = {
  topLeft: "",
  bottomLeft: "",
  vertical: "",
  topRight: "",
  bottomRight: "",
  horizontal: " ",
  bottomT: "",
  topT: "",
  cross: "",
  leftT: "",
  rightT: "",
}

type RunFooterViewProps = {
  directory: () => string
  findFiles: (query: string) => Promise<string[]>
  agents: () => RunAgent[]
  references: () => RunReference[]
  commands: () => RunCommand[] | undefined
  providers: () => RunProvider[] | undefined
  currentAgent: () => string
  currentAgentID: () => string | undefined
  currentModel: () => RunInput["model"]
  variants: () => string[]
  currentVariant: () => string | undefined
  state: () => FooterState
  startup?: () => { version: string; detail: string } | undefined
  view?: () => FooterView
  subagent?: () => FooterSubagentState
  queuedPrompts?: () => FooterQueuedPrompt[]
  theme: () => RunTheme
  tuiConfig: RunTuiConfig
  mono: boolean
  miniSettings: () => MiniSettings
  history?: () => RunPrompt[]
  clipboard?: Pick<ClipboardService, "read">
  onSubmit: (input: RunPrompt) => boolean | Promise<boolean>
  onPermissionReply: (input: PermissionReply) => void | Promise<void>
  onFormReply: (input: FormReply) => void | Promise<void>
  onFormCancel: (input: FormCancel) => void | Promise<void>
  onCycle: () => void
  onInterrupt: () => boolean
  onBackground?: () => void
  onQueuedPromptAction?: (action: QueuedPromptAction, inboxID: string) => Promise<void>
  onEditorOpen: (input: { value: string }) => Promise<string | undefined>
  onInputClear: () => void
  onExitRequest?: () => boolean
  onRequestExit?: (fn: (() => boolean) | undefined) => void
  onExit: () => void
  onAgentSelect: (agent: string) => void
  onModelSelect: (model: NonNullable<RunInput["model"]>) => void
  onVariantSelect: (variant: string | undefined) => void
  onRows: (rows: number) => void
  onLayout: (input: { route: FooterPromptRoute; subagentRows: number }) => void
  onStatus: (text: string) => void
  onMiniSettingChange: (change: MiniSettingChange) => void | Promise<void>
  onSubagentSelect?: (sessionID: string | undefined) => void
  onSubagentInterrupt?: (sessionID: string) => void
}

export function RunFooterView(props: RunFooterViewProps) {
  const renderer = useRenderer()
  const term = useTerminalDimensions()
  const width = createMemo(() => term().width)
  const startup = createMemo(() => {
    const value = props.startup?.()
    return value ? entrySplashLayout({ ...value, width: width(), mono: props.mono }) : undefined
  })
  const active = createMemo<FooterView>(() => props.view?.() ?? { type: "prompt" })
  const subagent = createMemo<FooterSubagentState>(() => {
    return (
      props.subagent?.() ?? {
        tabs: [],
        details: {},
        permissions: [],
        forms: [],
      }
    )
  })
  const [route, setRoute] = createSignal<FooterPromptRoute>({ type: "composer" })
  const [subagentMenuRows, setSubagentMenuRows] = createSignal(RUN_SUBAGENT_PANEL_ROWS)
  const queuedPrompts = createMemo(() => props.queuedPrompts?.() ?? [])
  const queue = createMemo(() => queuedPrompts().filter((item) => item.delivery === "queue"))
  const skills = createMemo(() => (props.commands() ?? []).filter((item) => item.source === "skill"))
  const prompt = createMemo(() => active().type === "prompt" && route().type === "composer")
  const selectingSubagent = createMemo(() => active().type === "prompt" && route().type === "subagent-menu")
  const selectingQueued = createMemo(() => active().type === "prompt" && route().type === "queued-menu")
  const inspecting = createMemo(() => active().type === "prompt" && route().type === "subagent")
  const commanding = createMemo(() => active().type === "prompt" && route().type === "command")
  const skilling = createMemo(() => active().type === "prompt" && route().type === "skill")
  const agenting = createMemo(() => active().type === "prompt" && route().type === "agent")
  const modeling = createMemo(() => active().type === "prompt" && route().type === "model")
  const varianting = createMemo(() => active().type === "prompt" && route().type === "variant")
  const setting = createMemo(() => active().type === "prompt" && route().type === "settings")
  const panel = createMemo(
    () =>
      active().type === "permission" ||
      active().type === "form" ||
      selectingQueued() ||
      selectingSubagent() ||
      commanding() ||
      skilling() ||
      agenting() ||
      modeling() ||
      varianting() ||
      setting(),
  )
  const selected = createMemo(() => {
    const current = route()
    return current.type === "subagent" ? current.sessionID : undefined
  })
  const tabs = createMemo(() => subagent().tabs)
  const activeTabs = createMemo(() => tabs().filter((item) => item.status === "running"))
  const selectedTab = createMemo(() => tabs().find((item) => item.sessionID === selected()))
  const selectedIndex = createMemo(() => {
    const sessionID = selected()
    if (!sessionID) {
      return 0
    }

    return tabs().findIndex((item) => item.sessionID === sessionID) + 1
  })
  const foregroundSubagents = createMemo(() => activeTabs().some((item) => !item.background))
  const model = createMemo(() => {
    const current = props.currentModel()
    return current ? modelInfo(props.providers(), current) : undefined
  })
  const detail = createMemo(() => {
    const current = route()
    return current.type === "subagent" ? subagent().details[current.sessionID] : undefined
  })
  const shortcuts = Keymap.useShortcuts()
  const shortcut = (id: string) => monoShortcut(shortcuts.get(id) ?? "", props.mono)
  const command = () => shortcut("command.palette.show")
  const subagentShortcut = () => shortcut("session.child.first")
  const queuedShortcut = () => shortcut("session.queued_prompts")
  const backgroundShortcut = () => shortcut("session.background")
  const subagentInterruptShortcut = () => shortcut("composer.subagent.interrupt")
  const interrupt = () => shortcut("session.interrupt")
  const variantCycle = () => monoShortcut(shortcuts.all("variant.cycle") ?? "", props.mono)
  const clearShortcut = () => shortcut("prompt.clear")
  const busy = createMemo(() => props.state().phase === "running")
  const started = createMemo(() => (busy() ? performance.now() : undefined))
  const statusWidth = createMemo(() => Math.max(1, width() - (busy() ? 2 : 0)))
  const armed = createMemo(() => props.state().interrupt > 0)
  const exiting = createMemo(() => props.state().exit > 0)
  const usage = createMemo(() => props.state().usage)
  const contextUsage = createMemo(() => {
    const current = usage()
    return current && current.tokens > 0 ? formatContextUsage(current.tokens, current.percent) : ""
  })
  const cost = createMemo(() => (usage()?.cost ? money.format(usage()!.cost!) : ""))
  const takeover = createMemo(() => exiting() || (busy() && armed()) || !!props.state().notice.trim())
  const footerDetails = createMemo(() => props.miniSettings().footer === "show" && !takeover())
  const interruptLabel = createMemo(() => {
    if (!interrupt()) {
      return
    }

    return interrupt() === "escape" ? "esc" : interrupt()
  })
  const runTheme = createMemo(() => props.theme())
  const theme = createMemo(() => runTheme().footer)
  const agentColor = createMemo(() => {
    const colors = theme().categorical
    const index = props
      .agents()
      .filter((agent) => !agent.hidden)
      .findIndex((agent) => agent.id === props.currentAgentID())
    return colors[Math.max(0, index) % colors.length]!
  })
  const block = createMemo(() => runTheme().block)
  const footerStatus = createMemo(() => {
    const current = model()?.model ?? props.state().model.trim()
    const variant = props.currentVariant()
    const details = [busy() ? "running" : "idle", `agent ${props.currentAgent()}`]
    if (current) details.push(variant ? `${current} ${variant}` : current)
    if (contextUsage()) details.push(contextUsage())
    if (cost()) details.push(cost())
    if (queuedPrompts().length > 0) details.push(`${queuedPrompts().length} pending`)
    if (activeTabs().length > 0) details.push(`${activeTabs().length} subagent${activeTabs().length === 1 ? "" : "s"}`)
    return details.join(props.mono ? " - " : " · ")
  })
  const permission = createMemo<Extract<FooterView, { type: "permission" }> | undefined>(() => {
    const view = active()
    return view.type === "permission" ? view : undefined
  })
  const form = createMemo<Extract<FooterView, { type: "form" }> | undefined>(() => {
    const view = active()
    return view.type === "form" ? view : undefined
  })
  const formStates = new Map<string, FormBodyState>()
  const settledForms = new Set<string>()
  let formsAbsent = true

  createEffect(() => {
    const view = active()
    if (view.type === "form") {
      formsAbsent = false
      return
    }
    if (view.type === "permission") return
    formsAbsent = true
    formStates.clear()
    settledForms.clear()
  })
  const promptView = createMemo(() => {
    if (active().type !== "prompt") {
      return active().type
    }

    const current = route()
    return current.type === "composer" ? "prompt" : current.type
  })

  const openRoute = (next: FooterPromptRoute) => {
    setRoute(next)
    props.onSubagentSelect?.(undefined)
  }

  const openCommand = () => {
    openRoute({ type: "command" })
  }

  const openModel = () => {
    openRoute({ type: "model" })
  }

  const openAgent = () => {
    openRoute({ type: "agent" })
  }

  const openSkillMenu = () => {
    if (props.commands() && skills().length === 0) {
      return
    }

    openRoute({ type: "skill" })
  }

  const openVariant = () => {
    openRoute({ type: "variant" })
  }

  const openSettings = () => {
    openRoute({ type: "settings" })
  }

  const openSubagentMenu = () => {
    if (tabs().length === 0) {
      return
    }

    openRoute({ type: "subagent-menu" })
  }

  const openQueuedMenu = () => {
    if (queuedPrompts().length === 0) return
    openRoute({ type: "queued-menu" })
  }

  const closePanel = () => {
    setRoute({ type: "composer" })
  }

  const runQueuedAction = createSingleFlight<string>()
  const queuedPromptAction = async (action: QueuedPromptAction, inboxID: string) => {
    const run = props.onQueuedPromptAction
    if (!run) return false
    const result = await runQueuedAction(inboxID, async () => {
      const error = await run(action, inboxID).then(
        () => undefined,
        (error) => error,
      )
      if (!error) return true
      props.onStatus(`failed to ${action === "cancel" ? "delete" : action} pending prompt: ${errorMessage(error)}`)
      return false
    })
    return result ?? false
  }

  const openTab = (sessionID: string) => {
    setRoute({ type: "subagent", sessionID })
    props.onSubagentSelect?.(sessionID)
  }

  const closeTab = () => {
    openRoute({ type: "composer" })
  }

  const cycleTab = (dir: -1 | 1) => {
    if (tabs().length === 0) {
      return
    }

    const routeState = route()
    const current =
      routeState.type === "subagent" ? tabs().findIndex((item) => item.sessionID === routeState.sessionID) : -1
    const index = current === -1 ? 0 : (current + dir + tabs().length) % tabs().length
    const next = tabs()[index]
    if (!next) {
      return
    }

    openTab(next.sessionID)
  }
  const [promptRows, setPromptRows] = createSignal(1)
  const composer = createPromptState({
    directory: props.directory,
    findFiles: props.findFiles,
    agents: props.agents,
    references: props.references,
    commands: props.commands,
    state: props.state,
    view: promptView,
    prompt,
    width,
    statusRows: () => (menu() ? 0 : statusRows()),
    theme,
    mono: () => props.mono,
    imagePreview: props.tuiConfig.prompt?.image_preview,
    clipboard: props.clipboard,
    history: props.history,
    queuedPrompts: queue,
    onQueuedPromptSteer: (inboxID) => queuedPromptAction("steer", inboxID),
    onSubmit: props.onSubmit,
    onCycle: props.onCycle,
    onInterrupt: props.onInterrupt,
    onEditorOpen: props.onEditorOpen,
    onInputClear: props.onInputClear,
    onExitRequest: props.onExitRequest,
    onExit: props.onExit,
    onSkillMenu: openSkillMenu,
    onSettings: openSettings,
    onRows: setPromptRows,
    onStatus: props.onStatus,
  })
  const shell = createMemo(() => prompt() && composer.shell())
  const menu = createMemo(() => prompt() && composer.visible())
  const stateStatus = createMemo(() => props.state().status.trim())
  const notice = createMemo(() => props.state().notice.trim())
  const statusText = createMemo(() => {
    if (exiting() || (busy() && armed())) {
      const key = exiting() ? clearShortcut() : interruptLabel()
      const action = exiting() ? "exit" : "stop"
      if (!key) return exiting() ? "Exit pending" : "Stop pending"
      const phrases = [
        `Press ${key} again to ${exiting() ? "exit" : "interrupt"}`,
        `${key} again to ${exiting() ? "exit" : "interrupt"}`,
        `${key} again: ${action}`,
        `${key} ${action}`,
      ]
      return phrases.find((text) => stringWidth(text) <= statusWidth()) ?? phrases[phrases.length - 1]!
    }

    if (notice()) return notice()
    if (!footerDetails()) return shell() ? "Shell" : ""
    if (busy()) {
      return interruptLabel() ? `${interruptLabel()} stop` : "Running"
    }
    return stateStatus() || (shell() ? "Shell" : "")
  })
  const agentStatus = createMemo(() => {
    if (!footerDetails() || !prompt() || shell()) return undefined
    return props.currentAgent()
  })
  const modelStatus = createMemo(() => {
    const current = model()?.model ?? props.state().model.trim()
    if (!footerDetails() || !prompt() || shell() || !current) return
    return {
      model: current,
      provider: model()?.provider,
      variant: props.currentVariant(),
    }
  })
  const statusColor = createMemo(() => {
    if (exiting()) {
      return theme().error
    }

    if (armed()) {
      return theme().warning
    }

    if (busy() || notice().length > 0 || stateStatus().length > 0) {
      return theme().text
    }

    return theme().muted
  })
  const contextHintCandidates = createMemo(() => {
    if (!footerDetails() || !prompt() || shell()) {
      return []
    }

    const items: Array<{ id: "queued" | "subagents" | "background"; key: string; label: string; expanded?: string }> =
      []
    if (queuedPrompts().length > 0 && queuedShortcut()) {
      items.push({ id: "queued", key: queuedShortcut(), label: `${queuedPrompts().length} pending` })
    }
    if (activeTabs().length > 0 && subagentShortcut()) {
      items.push({
        id: "subagents",
        key: subagentShortcut(),
        label: `${activeTabs().length} sub`,
        expanded: `${activeTabs().length} subagent${activeTabs().length === 1 ? "" : "s"}`,
      })
    }
    if (foregroundSubagents() && backgroundShortcut()) {
      items.push({ id: "background", key: backgroundShortcut(), label: "bg", expanded: "background" })
    }
    return items
  })
  const commandHint = createMemo(() => {
    if (!prompt() || takeover() || shell()) return
    if (command()) {
      return { key: command(), label: "menu" }
    }
  })
  const statuslineLayout = createMemo(() => {
    const info = modelStatus()
    return footerStatuslinePolicy({
      width: width(),
      mono: props.mono,
      status: {
        text: statusText(),
        expanded: footerDetails() && busy() && interruptLabel() ? `${interruptLabel()} interrupt` : undefined,
      },
      escape: shell() && !takeover() ? { key: "esc", label: "normal" } : undefined,
      work: contextHintCandidates(),
      model: info ? { name: info.model, variant: info.variant } : undefined,
      agent: agentStatus(),
      context:
        footerDetails() && contextUsage()
          ? {
              compact: usage()?.percent === undefined ? contextUsage() : `${usage()!.percent}% ctx`,
              full: contextUsage(),
            }
          : undefined,
      cost: footerDetails() ? cost() : undefined,
      provider: info?.provider,
      menu: commandHint(),
      spinner: busy() ? (props.mono ? "*" : "\u25aa") : undefined,
    })
  })
  const statusSections = createMemo(() => statuslineLayout().groups.filter((group) => group.id !== "spinner"))
  const statusColors = createMemo(() => ({
    text: theme().text,
    muted: theme().muted,
    agent: agentColor(),
    status: statusColor(),
  }))
  const statusRows = createMemo(() => {
    const text = statusSections()
      .map((group) => group.parts.map((part) => part.text).join(""))
      .join(props.mono ? " - " : " \u00b7 ")
    if (stringWidth(text) <= statusWidth() && !text.includes("\n")) return 1
    // Measure outside the clipped footer so wrapped required controls can grow it.
    const buffer = TextBuffer.create(renderer.widthMethod)
    const view = TextBufferView.create(buffer)
    buffer.setText(text)
    view.setWrapMode("word")
    view.setWrapWidth(statusWidth())
    const rows = Math.max(1, view.getVirtualLineCount())
    view.destroy()
    buffer.destroy()
    return rows
  })
  createEffect(() => {
    props.onRows(promptRows() + (!panel() && !menu() && !inspecting() ? statusRows() : 0) - 1)
  })

  createEffect(() => {
    props.onRequestExit?.(composer.requestExit)
  })

  onCleanup(() => {
    props.onRequestExit?.(undefined)
  })

  const clearScreen = () => {
    if (renderer.isDestroyed) return
    if (renderer.screenMode !== "split-footer") return
    if (renderer.externalOutputMode !== "capture-stdout") return
    if (renderer.currentControlState === "explicit_suspended") return
    // Home, erase the visible display, keep terminal scrollback, then repaint the footer.
    renderer.resetSplitFooterForReplay({ clearSavedLines: false })
  }

  Keymap.createLayer(() => ({
    commands: [
      {
        id: "app.clear",
        title: "Clear screen",
        group: "System",
        run: clearScreen,
      },
    ],
  }))

  Keymap.createLayer(() => ({
    enabled: active().type === "prompt" && route().type === "composer" && !composer.visible(),
    commands: [
      {
        id: "command.palette.show",
        title: "Open command palette",
        group: "Prompt",
        run: openCommand,
      },
      {
        id: "variant.cycle",
        title: "Cycle model variant",
        group: "Model",
        run: props.onCycle,
      },
    ],
  }))

  Keymap.createLayer(() => ({
    enabled: active().type === "prompt" && route().type === "composer" && foregroundSubagents() && !!props.onBackground,
    priority: 1,
    commands: [
      {
        id: "session.background",
        title: "Background subagents",
        group: "Session",
        run: () => props.onBackground?.(),
      },
    ],
  }))

  Keymap.createLayer(() => ({
    enabled: active().type === "prompt" && route().type === "composer" && tabs().length > 0,
    commands: [
      {
        id: "session.child.first",
        title: "View subagents",
        group: "Session",
        run: openSubagentMenu,
      },
    ],
  }))

  Keymap.createLayer(() => ({
    enabled: active().type === "prompt" && route().type === "composer" && queuedPrompts().length > 0,
    commands: [
      {
        id: "session.queued_prompts",
        title: "View pending prompts",
        group: "Prompt",
        run: openQueuedMenu,
      },
    ],
  }))

  Keymap.createLayer(() => ({
    enabled:
      active().type === "prompt" &&
      route().type === "subagent" &&
      selectedTab()?.status === "running" &&
      !!props.onSubagentInterrupt,
    priority: 1,
    commands: [
      {
        id: "composer.subagent.interrupt",
        title: "Interrupt subagent",
        group: "Session",
        run: () => {
          const current = selectedTab()
          if (current?.status !== "running") {
            return
          }

          props.onSubagentInterrupt?.(current.sessionID)
        },
      },
    ],
  }))

  createEffect(() => {
    const current = route()
    if (current.type !== "subagent") {
      return
    }

    if (tabs().some((item) => item.sessionID === current.sessionID)) {
      return
    }

    closeTab()
  })

  createEffect(() => {
    if (route().type !== "subagent-menu") {
      return
    }

    if (tabs().length > 0) {
      return
    }

    closePanel()
  })

  createEffect(() => {
    if (route().type !== "queued-menu" || queuedPrompts().length > 0) return
    closePanel()
  })

  createEffect(() => {
    if (active().type === "prompt") {
      return
    }

    const current = route()
    if (
      current.type !== "command" &&
      current.type !== "skill" &&
      current.type !== "agent" &&
      current.type !== "model" &&
      current.type !== "variant" &&
      current.type !== "settings" &&
      current.type !== "queued-menu" &&
      current.type !== "subagent-menu"
    ) {
      return
    }

    closePanel()
  })

  createEffect(() => {
    props.onLayout({
      route: route(),
      subagentRows: subagentMenuRows(),
    })
  })

  return (
    <box
      width="100%"
      height="100%"
      border={false}
      backgroundColor="transparent"
      flexDirection="column"
      gap={0}
      padding={0}
    >
      {/* The renderer seeds the leading blank row that entrySplash includes in scrollback. */}
      <Show when={startup()}>
        {(layout) => (
          <box id="mini-startup" height={1} flexShrink={0} flexDirection="row">
            <Show when={layout().label.startsWith("\u25aa")}>
              <OneCellSpinner
                animation={SEED_LAUNCH}
                color={runTheme().splash.right}
                animations={props.tuiConfig.animations}
              />
            </Show>
            <text fg={runTheme().splash.right} wrapMode="none">
              {layout().label.startsWith("\u25aa") ? layout().label.slice(1) : layout().label}
              <span style={{ fg: runTheme().splash.left }}>{layout().metadata}</span>
            </text>
          </box>
        )}
      </Show>
      <Show when={panel() || inspecting()}>
        <box width="100%" height={1} flexShrink={0} backgroundColor="transparent" />
      </Show>

      <Show
        when={inspecting()}
        fallback={
          <box width="100%" flexDirection="column" gap={0}>
            <For each={[promptView()]}>
              {() => (
                <box
                  width="100%"
                  flexShrink={0}
                  border={panel() || prompt() ? false : ["left"]}
                  borderColor={panel() || prompt() ? undefined : theme().border}
                  customBorderChars={
                    panel() || prompt()
                      ? undefined
                      : {
                          ...EMPTY_BORDER,
                          vertical: props.mono ? "|" : "█",
                        }
                  }
                >
                  <box
                    width="100%"
                    flexGrow={1}
                    paddingLeft={0}
                    paddingRight={0}
                    paddingTop={0}
                    flexDirection="column"
                    backgroundColor={panel() || prompt() ? "transparent" : theme().surface}
                    gap={0}
                  >
                    <box width="100%" flexGrow={1} flexShrink={1} flexDirection="column">
                      <Switch>
                        <Match when={active().type === "prompt" && route().type === "composer"}>
                          <RunPromptBody
                            theme={theme}
                            cursorStyle={props.tuiConfig.cursor}
                            background={() => runTheme().background}
                            rail={() => (shell() ? theme().formfieldFocusedText : agentColor())}
                            mono={props.mono}
                            placeholder={composer.placeholder}
                            onSubmit={composer.onSubmit}
                            onKeyDown={composer.onKeyDown}
                            onPaste={composer.onPaste}
                            images={composer.images}
                            layout={composer.layout}
                            onContentChange={composer.onContentChange}
                            onSizeChange={composer.onSizeChange}
                            bind={composer.bind}
                          />
                        </Match>
                        <Match when={selectingSubagent()}>
                          <RunSubagentSelectBody
                            theme={theme}
                            tabs={tabs}
                            current={selected}
                            onClose={closePanel}
                            onSelect={openTab}
                            onRows={setSubagentMenuRows}
                            mono={props.mono}
                          />
                        </Match>
                        <Match when={selectingQueued()}>
                          <RunQueuedPromptSelectBody
                            theme={theme}
                            prompts={queuedPrompts}
                            onClose={closePanel}
                            onSelect={async (item) => {
                              if (
                                await queuedPromptAction(item.delivery === "queue" ? "steer" : "queue", item.messageID)
                              )
                                closePanel()
                            }}
                            onDelete={(item) => {
                              void queuedPromptAction("cancel", item.messageID)
                            }}
                            onRows={setSubagentMenuRows}
                            mono={props.mono}
                          />
                        </Match>
                        <Match when={commanding()}>
                          <RunCommandMenuBody
                            theme={theme}
                            commands={props.commands}
                            subagents={tabs}
                            queued={queuedPrompts}
                            variants={props.variants}
                            variantCycle={variantCycle()}
                            onClose={closePanel}
                            onAgent={openAgent}
                            onModel={openModel}
                            onEditor={() => {
                              closePanel()
                              void composer.openEditor()
                            }}
                            onSkill={openSkillMenu}
                            onSubagent={openSubagentMenu}
                            onQueued={openQueuedMenu}
                            onVariant={openVariant}
                            onSettings={openSettings}
                            onVariantCycle={() => {
                              props.onCycle()
                              closePanel()
                            }}
                            onStatus={() => {
                              props.onStatus(footerStatus())
                              closePanel()
                            }}
                            onCommand={(name) => {
                              composer.submitText(`/${name}`)
                              closePanel()
                            }}
                            onNew={() => {
                              composer.submitText("/new")
                              closePanel()
                            }}
                            onClear={() => {
                              closePanel()
                              clearScreen()
                            }}
                            onExit={props.onExit}
                            clearShortcut={shortcut("app.clear")}
                            mono={props.mono}
                          />
                        </Match>
                        <Match when={skilling()}>
                          <RunSkillSelectBody
                            theme={theme}
                            commands={props.commands}
                            onClose={closePanel}
                            onSelect={(name) => {
                              composer.replacePrompt({
                                text: `/${name} `,
                                parts: [],
                                command: {
                                  name,
                                  arguments: "",
                                  source: "skill",
                                },
                              })
                              closePanel()
                            }}
                            mono={props.mono}
                          />
                        </Match>
                        <Match when={agenting()}>
                          <RunAgentSelectBody
                            theme={theme}
                            agents={props.agents}
                            current={props.currentAgentID}
                            onClose={closePanel}
                            onSelect={(agent) => {
                              props.onAgentSelect(agent)
                              closePanel()
                            }}
                            mono={props.mono}
                          />
                        </Match>
                        <Match when={modeling()}>
                          <RunModelSelectBody
                            theme={theme}
                            providers={props.providers}
                            current={props.currentModel}
                            onClose={closePanel}
                            onSelect={(model) => {
                              props.onModelSelect(model)
                              closePanel()
                            }}
                            mono={props.mono}
                          />
                        </Match>
                        <Match when={varianting()}>
                          <RunVariantSelectBody
                            theme={theme}
                            variants={props.variants}
                            current={props.currentVariant}
                            onClose={closePanel}
                            onSelect={(variant) => {
                              props.onVariantSelect(variant)
                              closePanel()
                            }}
                            mono={props.mono}
                          />
                        </Match>
                        <Match when={setting()}>
                          <RunSettingsBody
                            theme={theme}
                            settings={props.miniSettings}
                            onClose={closePanel}
                            onChange={props.onMiniSettingChange}
                            mono={props.mono}
                            animations={props.tuiConfig.animations}
                          />
                        </Match>
                        <Match when={active().type === "permission"}>
                          <RunPermissionBody
                            request={permission()!.request}
                            directory={props.directory}
                            theme={theme()}
                            block={block()}
                            onReply={props.onPermissionReply}
                            mono={props.mono}
                          />
                        </Match>
                        <Match when={active().type === "form"}>
                          <For each={form() ? [form()!] : []}>
                            {(value) => (
                              <RunFormBody
                                request={value.request}
                                theme={theme()}
                                state={formStates.get(value.request.id) ?? createFormBodyState(value.request)}
                                onState={(state) => {
                                  if (!formsAbsent && !settledForms.has(state.formID))
                                    formStates.set(state.formID, state)
                                }}
                                onReply={async (input) => {
                                  await props.onFormReply(input)
                                  settledForms.add(input.formID)
                                  formStates.delete(input.formID)
                                }}
                                onCancel={async (input) => {
                                  await props.onFormCancel(input)
                                  settledForms.add(input.formID)
                                  formStates.delete(input.formID)
                                }}
                                mono={props.mono}
                              />
                            )}
                          </For>
                        </Match>
                      </Switch>
                    </box>
                  </box>
                </box>
              )}
            </For>

            <Show when={!panel() && menu()}>
              <RunFooterMenu
                theme={theme}
                items={composer.options}
                selected={composer.selected}
                offset={composer.offset}
                rows={composer.rows}
                limit={FOOTER_MENU_ROWS}
                border={false}
                paddingLeft={2}
                paddingRight={2}
                mono={props.mono}
              />
            </Show>

            <Show when={!panel() && !menu()}>
              <box
                id="mini-statusline"
                width="100%"
                flexDirection="row"
                gap={1}
                flexShrink={0}
                backgroundColor="transparent"
              >
                <Show when={busy()}>
                  <box id="mini-work-spinner" width={1} flexShrink={0}>
                    <OneCellSpinner
                      animation={props.mono ? SEED_MONO : WORK_SPINNERS[props.miniSettings().work_spinner]}
                      color={agentColor()}
                      animations={props.tuiConfig.animations}
                      glow={!props.mono}
                      still={props.mono ? "*" : undefined}
                      age={performance.now() - (started() ?? performance.now())}
                    />
                  </box>
                </Show>
                <Show when={statusSections().length > 0}>
                  <text fg={statusColor()} wrapMode="word" width={statusWidth()} flexShrink={0} height={statusRows()}>
                    <For each={statusSections()}>
                      {(section, index) => (
                        <>
                          <Show when={index() > 0}>
                            <span style={{ fg: theme().muted }}>{props.mono ? " - " : " · "}</span>
                          </Show>
                          <For each={section.parts}>
                            {(part) => <span style={{ fg: statusColors()[part.tone] }}>{part.text}</span>}
                          </For>
                        </>
                      )}
                    </For>
                  </text>
                </Show>
              </box>
            </Show>
          </box>
        }
      >
        <box
          width="100%"
          flexGrow={1}
          flexShrink={1}
          border={["left"]}
          borderColor={theme().border}
          customBorderChars={{
            ...EMPTY_BORDER,
            vertical: props.mono ? "|" : "┃",
          }}
        >
          <RunFooterSubagentBody
            active={inspecting}
            theme={runTheme}
            tab={selectedTab}
            index={selectedIndex}
            total={() => tabs().length}
            detail={detail}
            onCycle={cycleTab}
            onClose={closeTab}
            interrupt={() => subagentInterruptShortcut() || undefined}
            shellOutput={() => props.miniSettings().shell_output === "show"}
            mono={props.mono}
          />
        </box>
      </Show>
    </box>
  )
}
