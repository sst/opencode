// RunFooter -- the mutable control surface for direct interactive mode.
//
// In the split-footer architecture, scrollback is immutable (append-only)
// and the footer is the only region that can repaint. RunFooter owns both
// sides of that boundary:
//
//   Scrollback: append() queues StreamCommit entries and flush() drains them
//   through retained scrollback surfaces. Commits coalesce in a microtask
//   queue so direct-mode transcript updates still preserve ordering without
//   rebuilding the session model.
//
//   Footer: event() updates the SolidJS signal-backed FooterState, which
//   drives the reactive footer view (prompt, status, permission, form).
//   present() swaps the active footer view and resizes the footer region.
//
// Lifecycle:
//   - close() flushes pending commits and notifies listeners (the prompt
//     queue uses this to know when to stop).
//   - destroy() does the same plus tears down event listeners and clears
//     internal state.
//   - The renderer's DESTROY event triggers destroy() so the footer
//     doesn't outlive the renderer.
//
// Ctrl-c clears a live prompt draft first; otherwise interrupt and exit use a
// two-press pattern where the first press shows a hint and the second press
// within 5 seconds actually fires the action.
import { CliRenderEvents, type CliRenderer, type CliRendererExternalOutputEvent } from "@opentui/core"
import { render } from "@opentui/solid"
import { batch, createComponent, createSignal, type Accessor, type Setter } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { Keymap } from "../context/keymap"
import { Locale } from "../util/locale"
import { RUN_SUBAGENT_PANEL_ROWS, footerPanelLayout } from "./footer.command"
import { SUBAGENT_INSPECTOR_ROWS } from "./footer.subagent"
import { TEXTAREA_MIN_ROWS, footerPromptLayout } from "./footer.prompt"
import { RunFooterView } from "./footer.view"
import { monoSnapshot } from "./mono"
import { RunScrollbackStream } from "./scrollback.surface"
import { resolveRunTheme, type RunTheme } from "./theme"
import { modelInfo } from "./variant.shared"
import { entrySplash } from "./splash"
import { SEED_LAUNCH } from "../ui/one-cell-motion"
import type {
  FooterApi,
  FooterEvent,
  FooterPatch,
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
  StreamCommit,
} from "./types"

type CycleResult = {
  modelLabel?: string
  status?: string
  variant?: string | undefined
  variants?: string[]
}

type RunFooterOptions = {
  directory: () => string
  findFiles: (query: string) => Promise<string[]>
  agents: RunAgent[]
  references: RunReference[]
  wrote?: boolean
  startup?: { version: string; detail: string }
  agent: string | undefined
  modelLabel: string
  model: RunInput["model"]
  variant: string | undefined
  first: boolean
  history?: RunPrompt[]
  theme: RunTheme
  tuiConfig: RunTuiConfig
  miniSettings: {
    current: MiniSettings
    update?: (change: MiniSettingChange) => Promise<MiniSettings>
  }
  onMonoChange?: (mono: boolean) => void
  onPermissionReply: (input: PermissionReply) => void | Promise<void>
  onFormReply: (input: FormReply) => void | Promise<void>
  onFormCancel: (input: FormCancel) => void | Promise<void>
  onCycleVariant?: () => CycleResult | void
  onAgentSelect?: (agent: string) => void
  onModelSelect?: (model: NonNullable<RunInput["model"]>) => CycleResult | void | Promise<CycleResult | void>
  onVariantSelect?: (variant: string | undefined) => CycleResult | void | Promise<CycleResult | void>
  onInterrupt?: () => void
  onBackground?: () => void
  onQueuedPromptAction?: (action: QueuedPromptAction, inboxID: string) => Promise<void>
  onEditorOpen: (input: { value: string }) => Promise<string | undefined>
  onSubagentSelect?: (sessionID: string | undefined) => void
  onSubagentInterrupt?: (sessionID: string) => void
  subscribeThemeSignal: (listener: () => void) => () => void
}

export function resolveRunAgent(agents: RunAgent[], current: string | undefined) {
  const selectable = agents.filter((agent) => agent.mode !== "subagent" && !agent.hidden)
  if (current === undefined) return selectable.at(0)
  return selectable.find((agent) => agent.id === current)
}

const PERMISSION_ROWS = 12
const FORM_ROWS = 14
const SUBAGENT_ROWS = RUN_SUBAGENT_PANEL_ROWS
const NOTICE_DURATION = 3000
const THEME_REFRESH_DELAYS = [1000, 1000] as const

function createEmptySubagentState(): FooterSubagentState {
  return {
    tabs: [],
    details: {},
    permissions: [],
    forms: [],
  }
}

function eventPatch(next: FooterEvent): FooterPatch | undefined {
  if (next.type === "first") {
    return { first: next.first }
  }

  if (next.type === "model") {
    return { model: next.model }
  }

  if (next.type === "turn.send") {
    return {
      phase: "running",
      status: "sending prompt",
      interrupt: 0,
      exit: 0,
    }
  }

  if (next.type === "turn.idle") {
    return {
      phase: "idle",
      status: "",
    }
  }

  if (next.type === "stream.patch") {
    return next.patch
  }

  return undefined
}

export class RunFooter implements FooterApi {
  private closed = false
  private destroyed = false
  private prompts = new Set<(input: RunPrompt) => void>()
  private closes = new Set<() => void>()
  // Microtask-coalesced commit queue. Flushed on next microtask or on close/destroy.
  private queue: StreamCommit[] = []
  private pending = false
  private flushing: Promise<void> = Promise.resolve()
  private flushError: unknown
  // Fixed portion of footer height above the textarea.
  private base: number
  private rows = TEXTAREA_MIN_ROWS
  private agents: Accessor<RunAgent[]>
  private setAgents: Setter<RunAgent[]>
  private references: Accessor<RunReference[]>
  private setReferences: Setter<RunReference[]>
  private commands: Accessor<RunCommand[] | undefined>
  private setCommands: Setter<RunCommand[] | undefined>
  private providers: Accessor<RunProvider[] | undefined>
  private setProviders: Setter<RunProvider[] | undefined>
  private currentAgent: Accessor<string>
  private currentAgentID: Accessor<string | undefined>
  private setCurrentAgentID: Setter<string | undefined>
  private currentModel: Accessor<RunInput["model"]>
  private setCurrentModel: Setter<RunInput["model"]>
  private variants: Accessor<string[]>
  private setVariants: Setter<string[]>
  private currentVariant: Accessor<string | undefined>
  private setCurrentVariant: Setter<string | undefined>
  private theme: Accessor<RunTheme>
  private setTheme: Setter<RunTheme>
  private state: Accessor<FooterState>
  private setState: Setter<FooterState>
  private view: Accessor<FooterView>
  private setView: Setter<FooterView>
  private subagent: Accessor<FooterSubagentState>
  private setSubagent: (next: FooterSubagentState) => void
  private queuedPrompts: Accessor<FooterQueuedPrompt[]>
  private setQueuedPrompts: Setter<FooterQueuedPrompt[]>
  private history: Accessor<RunPrompt[]>
  private setHistory: Setter<RunPrompt[]>
  private miniSettings: Accessor<MiniSettings>
  private setMiniSettings: Setter<MiniSettings>
  private promptRoute: FooterPromptRoute = { type: "composer" }
  private subagentMenuRows = SUBAGENT_ROWS
  private interruptTimeout: NodeJS.Timeout | undefined
  private exitTimeout: NodeJS.Timeout | undefined
  private noticeTimeout: NodeJS.Timeout | undefined
  private turnAgent: string | undefined
  private requestExitHandler: (() => boolean) | undefined
  private startup: Accessor<RunFooterOptions["startup"]>
  private setStartup: Setter<RunFooterOptions["startup"]>
  private startupTimer: ReturnType<typeof setTimeout> | undefined
  private scrollback: RunScrollbackStream
  private themes: RunTheme[]
  private paletteRefreshRunning = false
  private paletteRefreshQueued = false
  private themeRefreshTimeouts: NodeJS.Timeout[] = []
  private unsubscribeThemeSignal = () => {}

  private createScrollback(wrote: boolean): RunScrollbackStream {
    return new RunScrollbackStream(this.renderer, this.theme(), {
      wrote,
      onThemeRelease: (theme) => {
        void this.renderer
          .idle()
          .catch(() => {})
          .finally(() => this.destroyTheme(theme))
      },
      shellOutput: () => this.miniSettings().shell_output === "show",
      mono: this.miniSettings().mono,
      imagePreview: this.options.tuiConfig.session?.image_preview,
    })
  }

  constructor(
    private renderer: CliRenderer,
    private options: RunFooterOptions,
  ) {
    const [state, setState] = createSignal<FooterState>({
      phase: "idle",
      status: "",
      notice: "",
      model: options.modelLabel,
      usage: undefined,
      first: options.first,
      interrupt: 0,
      exit: 0,
    })
    this.state = state
    this.setState = setState
    const [view, setView] = createSignal<FooterView>({ type: "prompt" })
    this.view = view
    this.setView = setView
    const [agents, setAgents] = createSignal(options.agents)
    this.agents = agents
    this.setAgents = setAgents
    const [references, setReferences] = createSignal(options.references)
    this.references = references
    this.setReferences = setReferences
    const [commands, setCommands] = createSignal<RunCommand[] | undefined>()
    this.commands = commands
    this.setCommands = setCommands
    const [providers, setProviders] = createSignal<RunProvider[] | undefined>()
    this.providers = providers
    this.setProviders = setProviders
    const [selectedAgentID, setCurrentAgentID] = createSignal(options.agent)
    const currentAgent = () => resolveRunAgent(this.agents(), selectedAgentID())
    this.currentAgentID = () => currentAgent()?.id ?? selectedAgentID()
    this.setCurrentAgentID = setCurrentAgentID
    this.currentAgent = () => {
      const agent = currentAgent()
      if (agent) return agent.name
      const selected = selectedAgentID()
      return selected ? Locale.titlecase(selected) : "Default"
    }
    const [currentModel, setCurrentModel] = createSignal<RunInput["model"]>(options.model)
    this.currentModel = currentModel
    this.setCurrentModel = setCurrentModel
    const [variants, setVariants] = createSignal<string[]>([])
    this.variants = variants
    this.setVariants = setVariants
    const [currentVariant, setCurrentVariant] = createSignal(options.variant)
    this.currentVariant = currentVariant
    this.setCurrentVariant = setCurrentVariant
    const [theme, setTheme] = createSignal(options.theme)
    this.theme = theme
    this.setTheme = setTheme
    this.themes = [options.theme]
    const [subagent, setSubagent] = createStore<FooterSubagentState>(createEmptySubagentState())
    this.subagent = () => subagent
    this.setSubagent = (next) => {
      setSubagent("tabs", reconcile(next.tabs, { key: "sessionID" }))
      setSubagent("details", reconcile(next.details))
      setSubagent("permissions", reconcile(next.permissions, { key: "id" }))
      setSubagent("forms", reconcile(next.forms, { key: "id" }))
    }
    const [queuedPrompts, setQueuedPrompts] = createSignal<FooterQueuedPrompt[]>([])
    this.queuedPrompts = queuedPrompts
    this.setQueuedPrompts = setQueuedPrompts
    const [history, setHistory] = createSignal(options.history ?? [])
    this.history = history
    this.setHistory = setHistory
    const [miniSettings, setMiniSettings] = createSignal(options.miniSettings.current)
    this.miniSettings = miniSettings
    this.setMiniSettings = setMiniSettings
    const [startup, setStartup] = createSignal(options.startup)
    this.startup = startup
    this.setStartup = setStartup
    this.base = Math.max(1, renderer.footerHeight - TEXTAREA_MIN_ROWS)
    this.scrollback = this.createScrollback(options.wrote ?? false)

    this.renderer.on(CliRenderEvents.DESTROY, this.handleDestroy)
    this.renderer.on(CliRenderEvents.RESIZE, this.handleResize)
    this.renderer.on(CliRenderEvents.EXTERNAL_OUTPUT, this.handleExternalOutput)
    this.renderer.on(CliRenderEvents.PALETTE, this.handlePalette)
    this.renderer.on(CliRenderEvents.THEME_MODE, this.handleThemeRefresh)
    this.renderer.prependInputHandler(this.handleThemeNotification)
    this.unsubscribeThemeSignal = options.subscribeThemeSignal(this.handleThemeSignal)

    const footer = this
    void render(
      () =>
        createComponent(Keymap.Provider, {
          config: options.tuiConfig,
          get children() {
            return createComponent(RunFooterView, {
              directory: options.directory,
              state: footer.state,
              startup: footer.startup,
              view: footer.view,
              subagent: footer.subagent,
              queuedPrompts: footer.queuedPrompts,
              findFiles: options.findFiles,
              agents: footer.agents,
              references: footer.references,
              commands: footer.commands,
              providers: footer.providers,
              currentAgent: footer.currentAgent,
              currentAgentID: footer.currentAgentID,
              currentModel: footer.currentModel,
              variants: footer.variants,
              currentVariant: footer.currentVariant,
              theme: footer.theme,
              tuiConfig: options.tuiConfig,
              get mono() {
                return footer.miniSettings().mono
              },
              miniSettings: footer.miniSettings,
              history: footer.history,
              onSubmit: footer.handlePrompt,
              onPermissionReply: footer.handlePermissionReply,
              onFormReply: footer.handleFormReply,
              onFormCancel: footer.handleFormCancel,
              onCycle: footer.handleCycle,
              onInterrupt: footer.handleInterrupt,
              onBackground: options.onBackground,
              onQueuedPromptAction: options.onQueuedPromptAction,
              onEditorOpen: (input) => {
                footer.finishStartup()
                return options.onEditorOpen(input)
              },
              onInputClear: footer.handleInputClear,
              onExitRequest: footer.handleExit,
              onRequestExit: footer.setRequestExitHandler,
              onExit: () => footer.close(),
              onAgentSelect: footer.handleAgentSelect,
              onModelSelect: footer.handleModelSelect,
              onVariantSelect: footer.handleVariantSelect,
              onRows: footer.syncRows,
              onLayout: footer.syncLayout,
              onStatus: footer.setStatus,
              onMiniSettingChange: footer.handleMiniSettingChange,
              onSubagentSelect: options.onSubagentSelect,
              onSubagentInterrupt: options.onSubagentInterrupt,
            })
          },
        }),
      this.renderer,
    ).catch(() => {
      if (!this.isGone) {
        this.close()
      }
    })
    if (options.startup)
      this.startupTimer = setTimeout(() => this.finishStartup(), (SEED_LAUNCH.frames.length - 1) * SEED_LAUNCH.interval)
  }

  public finishStartup(): void {
    const startup = this.startup()
    if (!startup) return
    clearTimeout(this.startupTimer)
    this.startupTimer = undefined
    this.setStartup(undefined)
    if (this.isGone) return
    this.applyHeight()
    this.renderer.writeToScrollback(
      entrySplash({
        ...startup,
        theme: this.theme().splash,
        mono: this.miniSettings().mono,
      }),
    )
    this.renderer.requestRender()
  }

  public get isClosed(): boolean {
    return this.closed || this.isGone
  }

  private get isGone(): boolean {
    return this.destroyed || this.renderer.isDestroyed
  }

  public onPrompt(fn: (input: RunPrompt) => void): () => void {
    this.prompts.add(fn)
    return () => {
      this.prompts.delete(fn)
    }
  }

  public onClose(fn: () => void): () => void {
    if (this.isClosed) {
      fn()
      return () => {}
    }

    this.closes.add(fn)
    return () => {
      this.closes.delete(fn)
    }
  }

  public event(next: FooterEvent): void {
    if (next.type === "history") {
      this.setHistory(next.history)
      return
    }

    if (next.type === "agent") {
      this.setCurrentAgentID(next.agent)
      return
    }

    if (next.type === "model") {
      this.setCurrentModel(next.selection)
    }

    if (next.type === "turn.duration") {
      this.finishStartup()
      const agent = this.turnAgent ?? this.currentAgent()
      this.turnAgent = undefined
      if (this.miniSettings().turn_summary === "hide") return
      const current = this.currentModel()
      this.flush()
      this.flushing = this.flushing
        .then(() =>
          this.scrollback.writeTurnSummary({
            agent,
            model: current ? modelInfo(this.providers(), current).model : this.state().model,
            duration: next.duration,
          }),
        )
        .catch((error) => {
          this.flushError = error
        })
      return
    }

    if (next.type === "catalog") {
      if (this.isGone) {
        return
      }

      this.setAgents(next.agents)
      this.setReferences(next.references)
      if (next.commands !== undefined) {
        this.setCommands(next.commands)
      }
      return
    }

    if (next.type === "models") {
      if (this.isGone) {
        return
      }

      this.setProviders(next.providers)
      return
    }

    if (next.type === "variants") {
      if (this.isGone) {
        return
      }

      this.setVariants(next.variants)
      this.setCurrentVariant(next.current)
      return
    }

    if (next.type === "queued.prompts") {
      if (this.isGone) {
        return
      }

      this.setQueuedPrompts(next.prompts)
      return
    }

    const patch = eventPatch(next)
    if (patch) {
      if (typeof patch.status === "string") {
        this.clearNoticeTimer()
        patch.notice = ""
      }
      if (next.type === "turn.send") {
        this.turnAgent = this.currentAgent()
        this.clearInterruptTimer()
        this.clearExitTimer()
      }
      this.patch(patch)
      return
    }

    if (next.type === "stream.subagent") {
      if (this.isGone) {
        return
      }

      this.setSubagent(next.state)
      this.applyHeight()
      return
    }

    if (next.type === "stream.view") {
      this.present(next.view)
    }
  }

  private patch(next: FooterPatch): void {
    if (this.isGone) {
      return
    }

    const prev = this.state()
    const state = {
      phase: next.phase ?? prev.phase,
      status: typeof next.status === "string" ? next.status : prev.status,
      notice: typeof next.notice === "string" ? next.notice : prev.notice,
      model: typeof next.model === "string" ? next.model : prev.model,
      usage: "usage" in next ? next.usage : prev.usage,
      first: typeof next.first === "boolean" ? next.first : prev.first,
      interrupt:
        typeof next.interrupt === "number" && Number.isFinite(next.interrupt)
          ? Math.max(0, Math.floor(next.interrupt))
          : prev.interrupt,
      exit:
        typeof next.exit === "number" && Number.isFinite(next.exit) ? Math.max(0, Math.floor(next.exit)) : prev.exit,
    }

    if (state.phase === "idle") {
      state.interrupt = 0
    }

    this.setState(state)

    if (prev.phase === "running" && state.phase === "idle") {
      this.flush()
      this.completeScrollback()
    }
  }

  private completeScrollback(): void {
    this.flushing = this.flushing
      .then(() => this.scrollback.complete())
      .catch((error) => {
        this.flushError = error
      })
  }

  private present(view: FooterView): void {
    if (this.isGone) {
      return
    }

    if (view.type !== "prompt") this.finishStartup()
    this.setView(view)
    this.applyHeight()
  }

  // Queues a scrollback commit. Consecutive progress chunks for the same
  // part coalesce by appending text, reducing the number of retained-surface
  // updates. Actual flush happens on the next microtask, so a burst of events
  // from one reducer pass becomes a single ordered drain.
  public append(commit: StreamCommit): void {
    if (this.isGone) {
      return
    }

    this.finishStartup()
    if (this.miniSettings().tools === "hide" && toolTranscript(commit)) return
    const last = this.queue.at(-1)
    const merged = last ? coalesceProgressCommit(last, commit) : undefined
    if (merged) this.queue[this.queue.length - 1] = merged
    else this.queue.push(commit)

    if (this.pending) {
      return
    }

    this.pending = true
    queueMicrotask(() => {
      this.pending = false
      this.flush()
    })
  }

  public idle(): Promise<void> {
    if (this.isGone) {
      return Promise.resolve()
    }

    this.flush()
    if (this.state().phase === "idle") {
      this.completeScrollback()
    }

    return this.flushing.then(async () => {
      if (this.flushError !== undefined) {
        const error = this.flushError
        this.flushError = undefined
        throw error
      }

      if (this.isGone) {
        return
      }

      if (this.queue.length > 0) {
        return this.idle()
      }

      await this.renderer.idle().catch(() => {})
    })
  }

  public resetForReplay(wrote: boolean): void {
    if (this.isGone) {
      return
    }

    this.finishStartup()
    this.scrollback.destroy()
    this.scrollback = this.createScrollback(wrote)
  }

  public currentTheme(): RunTheme {
    return this.theme()
  }

  public currentMiniSettings(): MiniSettings {
    return this.miniSettings()
  }

  private destroyTheme(theme: RunTheme): void {
    const index = this.themes.indexOf(theme)
    if (index === -1) {
      return
    }

    this.themes.splice(index, 1)
    theme.block.syntax?.destroy()
  }

  public close(): void {
    if (this.closed) {
      return
    }

    this.finishStartup()
    this.flush()
    this.notifyClose()
  }

  public requestExit(): boolean {
    return this.requestExitHandler?.() ?? this.handleExit()
  }

  public destroy(): void {
    this.handleDestroy()
  }

  private notifyClose(): void {
    if (this.closed) {
      return
    }

    this.closed = true
    for (const fn of [...this.closes]) {
      fn()
    }
  }

  private setStatus = (status: string): void => {
    this.setNotice(status)
  }

  private setNotice(status: string): void {
    this.clearNoticeTimer()
    this.patch({ notice: status })
    if (!status) return

    this.noticeTimeout = setTimeout(() => {
      this.noticeTimeout = undefined
      this.patch({ notice: "" })
    }, NOTICE_DURATION)
  }

  private setRequestExitHandler = (fn?: () => boolean): void => {
    this.requestExitHandler = fn
  }

  private handleInputClear = (): void => {
    this.clearInterruptTimer()
    this.clearExitTimer()
    if (this.state().interrupt === 0 && this.state().exit === 0) {
      return
    }

    this.patch({ interrupt: 0, exit: 0 })
  }

  private handleResize = (): void => {
    if (!this.isGone) this.applyHeight()
  }

  private applyHeight(): void {
    const type = this.view().type
    const route = this.promptRoute.type
    const panel = footerPanelLayout(this.renderer.terminalHeight)
    const prompt = footerPromptLayout(this.renderer.terminalHeight)
    const desired =
      type === "permission"
        ? this.base + PERMISSION_ROWS
        : type === "form"
          ? this.base + FORM_ROWS
          : ["command", "skill", "agent", "model", "variant", "settings"].includes(route)
            ? 1 + panel.frame + panel.limit
            : route === "queued-menu" || route === "subagent-menu"
              ? 1 + this.subagentMenuRows
              : route === "subagent"
                ? this.base + SUBAGENT_INSPECTOR_ROWS
                : prompt.padding * 2 + 1 + this.rows
    const height = Math.max(
      1,
      Math.min(
        desired + (this.startup() ? 1 : 0),
        this.renderer.terminalHeight - (type === "prompt" && route === "composer" ? 1 : 0),
      ),
    )

    if (height !== this.renderer.footerHeight) {
      this.renderer.footerHeight = height
    }
  }

  private syncRows = (value: number): void => {
    if (this.isGone) {
      return
    }

    const rows = Math.max(TEXTAREA_MIN_ROWS, value)
    if (rows === this.rows) {
      return
    }

    this.rows = rows
    if (this.view().type === "prompt") {
      this.applyHeight()
    }
  }

  private syncLayout = (next: { route: FooterPromptRoute; subagentRows: number }): void => {
    if (next.route.type !== "composer") this.finishStartup()
    this.promptRoute = next.route
    this.subagentMenuRows = next.subagentRows
    if (this.view().type === "prompt") {
      this.applyHeight()
    }
  }

  private handlePrompt = (input: RunPrompt): boolean => {
    if (this.isClosed) {
      return false
    }

    if (this.state().first) {
      this.patch({ first: false })
    }

    if (this.prompts.size === 0) {
      this.setNotice("input queue unavailable")
      return false
    }

    for (const fn of [...this.prompts]) {
      fn(input)
    }

    return true
  }

  private handlePermissionReply = async (input: PermissionReply): Promise<void> => {
    if (this.isClosed) {
      return
    }

    await this.options.onPermissionReply(input)
  }

  private handleFormReply = async (input: FormReply): Promise<void> => {
    if (this.isClosed) return
    await this.options.onFormReply(input)
  }

  private handleFormCancel = async (input: FormCancel): Promise<void> => {
    if (this.isClosed) return
    await this.options.onFormCancel(input)
  }

  private handleCycle = (): void => {
    const result = this.options.onCycleVariant?.()
    if (!result) {
      this.setNotice("no variants available")
      return
    }

    this.applySelectionResult(result)
    if (result.status === undefined) this.setNotice("variant updated")
  }

  private handleModelSelect = (model: NonNullable<RunInput["model"]>): void => {
    if (this.isClosed) {
      return
    }

    const previous = this.currentModel()
    this.setCurrentModel(model)
    if (!previous || previous.providerID !== model.providerID || previous.modelID !== model.modelID) {
      this.setCurrentVariant(undefined)
    }
    void Promise.resolve()
      .then(() => this.options.onModelSelect?.(model))
      .then((result) => {
        const current = this.currentModel()
        if (
          !result ||
          this.isClosed ||
          !current ||
          current.providerID !== model.providerID ||
          current.modelID !== model.modelID
        ) {
          return
        }
        this.applySelectionResult(result)
      })
      .catch(() => {})
  }

  private handleAgentSelect = (agent: string): void => {
    if (this.isClosed || this.currentAgentID() === agent) return
    this.setCurrentAgentID(agent)
    this.options.onAgentSelect?.(agent)
    this.setNotice(`agent ${this.currentAgent()}`)
  }

  private handleVariantSelect = (variant: string | undefined): void => {
    if (this.isClosed) {
      return
    }

    const model = this.currentModel()
    void Promise.resolve()
      .then(() => this.options.onVariantSelect?.(variant))
      .then((result) => {
        const current = this.currentModel()
        if (
          !result ||
          this.isClosed ||
          (model && (!current || current.providerID !== model.providerID || current.modelID !== model.modelID))
        ) {
          return
        }
        this.applySelectionResult(result)
      })
      .catch(() => {})
  }

  private applySelectionResult(result: CycleResult): void {
    if ("variants" in result) this.setVariants(result.variants ?? [])
    if ("variant" in result) this.setCurrentVariant(result.variant)
    if (result.modelLabel) this.patch({ model: result.modelLabel })
    if (result.status) this.setNotice(result.status)
  }

  private handleMiniSettingChange = async (change: MiniSettingChange): Promise<void> => {
    if (!this.options.miniSettings.update) {
      this.setNotice("settings are unavailable")
      return
    }

    try {
      const settings = await this.options.miniSettings.update(change)
      if (this.isClosed) return
      if (settings.mono === this.miniSettings().mono) {
        this.setMiniSettings(settings)
        this.setNotice("settings updated")
        return
      }
      const theme = await resolveRunTheme(this.renderer, this.options.tuiConfig.theme, settings.mono)
      this.flush()
      this.flushing = this.flushing.then(async () => {
        if (this.isClosed) {
          theme.block.syntax?.destroy()
          return
        }
        await this.scrollback.setMono(settings.mono)
        batch(() => {
          this.setMiniSettings(settings)
          this.applyTheme(theme)
          this.options.onMonoChange?.(settings.mono)
        })
      })
      await this.flushing
      this.setNotice("settings updated")
    } catch (error) {
      this.setNotice("failed to save settings")
      throw error
    }
  }

  private clearInterruptTimer(): void {
    if (!this.interruptTimeout) {
      return
    }

    clearTimeout(this.interruptTimeout)
    this.interruptTimeout = undefined
  }

  private clearNoticeTimer(): void {
    if (this.noticeTimeout) clearTimeout(this.noticeTimeout)
    this.noticeTimeout = undefined
  }

  private armInterruptTimer(): void {
    this.clearInterruptTimer()
    this.interruptTimeout = setTimeout(() => {
      this.interruptTimeout = undefined
      if (this.isGone || this.state().phase !== "running") {
        return
      }

      this.patch({ interrupt: 0 })
    }, 5000)
  }

  private clearExitTimer(): void {
    if (!this.exitTimeout) {
      return
    }

    clearTimeout(this.exitTimeout)
    this.exitTimeout = undefined
  }

  private armExitTimer(): void {
    this.clearExitTimer()
    this.exitTimeout = setTimeout(() => {
      this.exitTimeout = undefined
      if (this.isGone || this.isClosed) {
        return
      }

      this.patch({ exit: 0 })
    }, 5000)
  }

  // Two-press interrupt: first press shows a hint ("esc again to interrupt"),
  // second press within 5 seconds fires onInterrupt. The timer resets the
  // counter if the user doesn't follow through.
  private handleInterrupt = (): boolean => {
    if (this.isClosed || this.state().phase !== "running") {
      return false
    }

    const next = this.state().interrupt + 1
    this.patch({ interrupt: next })

    if (next < 2) {
      this.armInterruptTimer()
      return true
    }

    this.clearInterruptTimer()
    this.patch({ interrupt: 0 })
    this.setNotice("interrupting")
    this.options.onInterrupt?.()
    return true
  }

  private handleExit = (): boolean => {
    if (this.isClosed) {
      return true
    }

    this.clearInterruptTimer()
    const next = this.state().exit + 1
    this.patch({ exit: next, interrupt: 0 })

    if (next < 2) {
      this.armExitTimer()
      return true
    }

    this.clearExitTimer()
    this.patch({ exit: 0, status: "exiting" })
    this.close()
    return true
  }

  private applyTheme(theme: RunTheme): void {
    if (theme === this.theme()) return
    this.themes.push(theme)
    this.setTheme(theme)
    this.renderer.setBackgroundColor(theme.background)
    this.scrollback.setTheme(theme)
  }

  private handleExternalOutput = (event: CliRendererExternalOutputEvent): void => {
    if (this.miniSettings().mono) monoSnapshot(event)
  }

  private handlePalette = (): Promise<void> | undefined => {
    if (this.isGone || this.paletteRefreshRunning) return
    const mono = this.miniSettings().mono
    return resolveRunTheme(this.renderer, this.options.tuiConfig.theme, mono).then((theme) => {
      this.flushing = this.flushing
        .then(() => {
          if (this.isGone || mono !== this.miniSettings().mono) {
            theme.block.syntax?.destroy()
            return
          }
          this.applyTheme(theme)
        })
        .catch((error) => {
          this.flushError = error
        })
      return this.flushing
    })
  }

  private handleThemeNotification = (sequence: string): boolean => {
    if (sequence !== "\x1b[?997;1n" && sequence !== "\x1b[?997;2n") {
      return false
    }

    // OpenTUI clears its palette cache only when dark/light mode changes.
    // Refresh for same-mode terminal theme swaps too.
    queueMicrotask(this.handleThemeRefresh)
    return false
  }

  private handleThemeRefresh = (): Promise<void> | undefined => {
    if (this.isGone) {
      return
    }
    if (this.miniSettings().mono) return this.handlePalette()

    if (this.paletteRefreshRunning) {
      this.paletteRefreshQueued = true
      return
    }

    this.paletteRefreshRunning = true
    const retry = this.renderer.paletteDetectionStatus === "detecting"
    this.renderer.clearPaletteCache()
    return this.renderer
      .getPalette({ size: 256 })
      .catch(() => {})
      .then(() => {
        this.paletteRefreshRunning = false
        if (!retry && !this.paletteRefreshQueued) {
          // Theme files can change without a new terminal palette.
          return this.handlePalette()
        }

        this.paletteRefreshQueued = false
        return this.handleThemeRefresh()
      })
  }

  public refreshTheme() {
    return this.handleThemeRefresh()
  }

  private handleThemeSignal = (): void => {
    // Omarchy signals immediately after requesting a terminal config reload.
    for (const timeout of this.themeRefreshTimeouts) clearTimeout(timeout)
    this.themeRefreshTimeouts = THEME_REFRESH_DELAYS.map((delay) =>
      setTimeout(() => {
        this.handleThemeRefresh()
      }, delay),
    )
  }

  private handleDestroy = (): void => {
    if (this.destroyed) {
      return
    }

    clearTimeout(this.startupTimer)
    this.startupTimer = undefined
    this.flush()
    this.destroyed = true
    this.notifyClose()
    this.clearInterruptTimer()
    this.clearExitTimer()
    this.clearNoticeTimer()
    this.renderer.off(CliRenderEvents.DESTROY, this.handleDestroy)
    this.renderer.off(CliRenderEvents.RESIZE, this.handleResize)
    this.renderer.off(CliRenderEvents.EXTERNAL_OUTPUT, this.handleExternalOutput)
    this.renderer.off(CliRenderEvents.PALETTE, this.handlePalette)
    this.renderer.off(CliRenderEvents.THEME_MODE, this.handleThemeRefresh)
    this.renderer.removeInputHandler(this.handleThemeNotification)
    this.unsubscribeThemeSignal()
    for (const timeout of this.themeRefreshTimeouts) clearTimeout(timeout)
    this.themeRefreshTimeouts.length = 0
    this.prompts.clear()
    this.closes.clear()
    this.scrollback.destroy()
    for (const theme of [...this.themes]) this.destroyTheme(theme)
  }

  // Drains the commit queue to scrollback. The surface manager owns grouping,
  // spacing, and progressive markdown/code settling so direct mode can append
  // immutable transcript rows without rewriting history.
  private flush(): void {
    if (this.isGone || this.queue.length === 0) {
      this.queue.length = 0
      return
    }

    const batch = this.queue.splice(0)
    this.flushing = this.flushing
      .then(async () => {
        for (const item of batch) {
          await this.scrollback.append(item)
        }
      })
      .catch((error) => {
        this.flushError = error
      })
  }
}

function toolTranscript(commit: StreamCommit) {
  return commit.kind === "tool" || commit.partID?.startsWith("skill:")
}

/** @internal Exported for queue identity regression tests. */
export function coalesceProgressCommit(previous: StreamCommit, current: StreamCommit): StreamCommit | undefined {
  if (
    previous.phase !== "progress" ||
    current.phase !== "progress" ||
    previous.kind !== current.kind ||
    previous.source !== current.source ||
    previous.messageID !== current.messageID ||
    previous.partID !== current.partID ||
    previous.tool !== current.tool ||
    previous.toolState !== current.toolState
  )
    return
  return { ...current, text: previous.text + current.text }
}
