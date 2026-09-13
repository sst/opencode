// Top-level orchestrator for `opencode mini`.
//
// Wires the boot sequence, lifecycle (renderer + footer), stream transport,
// and prompt queue together into a single session loop. The frontend paints
// before resolving its Session, then:
//   1. resolves TUI config, model info, and session history,
//   2. creates the split-footer lifecycle (renderer + RunFooter),
//   3. starts the stream transport (SDK event subscription), lazily for fresh
//      local sessions,
//   4. runs the prompt queue until the footer closes.
import { SessionMessage } from "@opencode/schema/session-message"
import type { LocationRef } from "@opencode/client/promise"
import type { Config } from "../config"
import { newSessionLocation } from "../config/new-session-location"
import { loadRunAgents, loadRunCommands, loadRunReferences } from "./catalog.shared"
import {
  resolveMiniSettings,
  resolveModelInfo,
  resolveModelInfoStrict,
  resolveRunTuiConfig,
  resolveSessionInfo,
} from "./runtime.boot"
import { createRuntimeLifecycle } from "./runtime.lifecycle"
import { cycleVariant, formatModelLabel, resolveVariant } from "./variant.shared"
import { verbosityPreset } from "./verbosity"
import type {
  LocalReplayRow,
  MiniHost,
  MiniSettings,
  RunInput,
  RunPrompt,
  RunProvider,
  RunTuiConfig,
  StreamCommit,
} from "./types"

type BootContext = Pick<RunInput, "sdk" | "agent" | "model" | "variant"> & {
  location: LocationRef
}

type CreateSessionInput = {
  location: LocationRef
  agent: string | undefined
  model: RunInput["model"]
  variant: string | undefined
}

type CreateSession = (sdk: RunInput["sdk"], input: CreateSessionInput, signal?: AbortSignal) => Promise<ResolvedSession>
type Reconnect = (signal: AbortSignal) => Promise<RunInput["sdk"]>

type RunRuntimeInput = {
  host: MiniHost
  directory: string
  boot: () => Promise<BootContext>
  resolveSession: (sdk: RunInput["sdk"], signal: AbortSignal) => Promise<ResolvedSession>
  createSession?: CreateSession
  reconnect?: Reconnect
  files: RunInput["files"]
  initialInput?: string
  thinking?: boolean
  replay?: boolean
  replayLimit?: number
  demo?: RunInput["demo"]
  tuiConfig?: RunTuiConfig | Promise<RunTuiConfig>
  config?: Pick<Config.Interface, "update">
}

export type RunDeferredInput = {
  host: MiniHost
  sdk: RunInput["sdk"]
  reconnect?: Reconnect
  directory: string
  target: (sdk: RunInput["sdk"], signal: AbortSignal) => Promise<ResolvedSession>
  createSession?: CreateSession
  agent: RunInput["agent"]
  model: RunInput["model"]
  variant: RunInput["variant"]
  files: RunInput["files"]
  initialInput?: string
  thinking?: boolean
  replay?: boolean
  replayLimit?: number
  demo?: RunInput["demo"]
  tuiConfig?: RunTuiConfig | Promise<RunTuiConfig>
  config?: Pick<Config.Interface, "update">
}

type StreamTransportModule = Pick<
  Awaited<typeof import("./stream-v2.transport")>,
  "createSessionTransport" | "formatUnknownError"
>

export type RunRuntimeDeps = {
  createRuntimeLifecycle?: typeof createRuntimeLifecycle
  streamTransport?: Promise<StreamTransportModule>
}

type StreamState = {
  mod: StreamTransportModule
  handle: Awaited<ReturnType<StreamTransportModule["createSessionTransport"]>>
}

type RunDemo = ReturnType<(typeof import("./demo"))["createRunDemo"]>

type ResolvedSession = {
  sdk?: RunInput["sdk"]
  sessionID: string
  sessionTitle?: string
  location: RunInput["location"]
  model: RunInput["model"]
  variant: string | undefined
  agent?: string | undefined
  resume?: boolean
}

type RuntimeState = {
  sdk: RunInput["sdk"]
  shown: boolean
  model: RunInput["model"]
  defaultModel: RunInput["model"]
  providers: RunProvider[]
  variants: string[]
  activeVariant: string | undefined
  sessionID: string
  history: RunPrompt[]
  localRows: LocalReplayRow[]
  sessionTitle?: string
  agent: string | undefined
  location: LocationRef
  switching?: Promise<void>
  demo?: RunDemo
  selectSubagent?: (sessionID: string | undefined) => void
  session?: Promise<void>
  stream?: Promise<StreamState>
}

type ClientAttempt = {
  sdk: RunInput["sdk"]
  generation: number
  signal: AbortSignal
}

function variantsFor(providers: RunProvider[], model: RunInput["model"]) {
  if (!model) {
    return []
  }

  return Object.keys(providers.find((item) => item.id === model.providerID)?.models?.[model.modelID]?.variants ?? {})
}

function formRequestOptions(location: LocationRef | undefined) {
  if (!location) return
  return {
    headers: {
      "x-opencode-directory": encodeURIComponent(location.directory),
      ...(location.workspaceID ? { "x-opencode-workspace": location.workspaceID } : {}),
    },
  }
}

function formAlreadySettled(error: unknown) {
  return !!error && typeof error === "object" && Reflect.get(error, "_tag") === "FormAlreadySettledError"
}

const RESIZE_DELAY = 250
const LOCAL_REPLAY_ROW_LIMIT = 100

function abortable<A>(task: Promise<A>, signal: AbortSignal): Promise<A | undefined> {
  if (signal.aborted) return Promise.resolve(undefined)
  return new Promise((resolve) => {
    const abort = () => {
      signal.removeEventListener("abort", abort)
      resolve(undefined)
    }
    signal.addEventListener("abort", abort, { once: true })
    void task.then(
      (value) => {
        signal.removeEventListener("abort", abort)
        resolve(value)
      },
      () => {
        signal.removeEventListener("abort", abort)
        resolve(undefined)
      },
    )
  })
}

// Core runtime loop. Boot resolves the SDK context, then we set up the
// lifecycle (renderer + footer), wire the stream transport for SDK events,
// and feed prompts through the queue until the user exits.
//
// Files only attach on the first prompt turn -- after that, includeFiles
// flips to false so subsequent turns don't re-send attachments.
async function runInteractiveRuntime(input: RunRuntimeInput, deps: RunRuntimeDeps = {}): Promise<void> {
  const start = input.host.startup.now()
  const log = input.host.diagnostics.trace
  const config = input.config
  const configState: { current: MiniSettings } = { current: resolveMiniSettings() }
  const tuiConfigTask = resolveRunTuiConfig(input.tuiConfig, input.host.platform).then((tuiConfig) => {
    configState.current = resolveMiniSettings(tuiConfig)
    return tuiConfig
  })
  const ctx = await input.boot()
  const runtimeController = new AbortController()
  const session = {
    first: true,
    history: [] as RunPrompt[],
    model: undefined as RunInput["model"],
    variant: undefined as string | undefined,
  }
  const savedVariant = await input.host.preferences.resolveVariant(ctx.model)
  const state: RuntimeState = {
    sdk: ctx.sdk,
    shown: !session.first,
    model: ctx.model ?? session.model,
    defaultModel: undefined,
    providers: [],
    variants: [],
    activeVariant: resolveVariant(ctx.variant, session.variant, savedVariant, []),
    sessionID: "",
    history: [...session.history],
    localRows: [],
    agent: ctx.agent,
    location: ctx.location,
  }
  const settleForm = async (sessionID: string, formID: string) => {
    if (!state.stream) return
    const stream = await state.stream
    stream.handle.settleForm?.(sessionID, formID)
  }
  const shell = await (deps.createRuntimeLifecycle ?? createRuntimeLifecycle)({
    host: input.host,
    getDirectory: () => state.location.directory,
    findFiles: (query) =>
      state.sdk.file
        .find({
          query,
          type: "file",
          location: { directory: state.location.directory, workspace: state.location.workspaceID },
        })
        .then((result) => result.data.map((file) => file.path))
        .catch(() => []),
    agents: [],
    references: [],
    sessionID: state.sessionID,
    sessionTitle: state.sessionTitle,
    getSessionID: () => state.sessionID,
    first: session.first,
    history: state.history,
    agent: state.agent,
    model: state.model,
    variant: state.activeVariant,
    tuiConfig: tuiConfigTask,
    onMiniSettingChange: config
      ? async (change) => {
          const info = await config.update((draft) => {
            if (!draft.mini || typeof draft.mini !== "object") draft.mini = {}
            if (change.key === "verbosity") {
              Object.assign(draft.mini, verbosityPreset(change.value))
              return
            }
            draft.mini[change.key] = change.value
          })
          configState.current = resolveMiniSettings(info)
          return configState.current
        }
      : undefined,
    onPermissionReply: async (next) => {
      if (state.demo?.permission(next)) {
        return
      }

      log?.write("send.permission.reply", next)
      await state.sdk.permission.reply(next)
    },
    onFormReply: async (next) => {
      if (state.demo?.formReply(next)) return
      try {
        await state.sdk.form.reply(next, formRequestOptions(next.sessionID === "global" ? next.location : undefined))
      } catch (error) {
        if (!formAlreadySettled(error)) throw error
      }
      await settleForm(next.sessionID, next.formID)
    },
    onFormCancel: async (next) => {
      if (state.demo?.formCancel(next)) return
      try {
        await state.sdk.form.cancel(next, formRequestOptions(next.sessionID === "global" ? next.location : undefined))
      } catch (error) {
        if (!formAlreadySettled(error)) throw error
      }
      await settleForm(next.sessionID, next.formID)
    },
    onCycleVariant: () => {
      const model = state.model ?? state.defaultModel
      if (!model || state.variants.length === 0) {
        return {
          status: "no variants available",
        }
      }

      if (!state.model) state.model = model
      state.activeVariant = cycleVariant(state.activeVariant, state.variants)
      void input.host.preferences.saveVariant(model, state.activeVariant)
      return {
        status: state.activeVariant ? `variant ${state.activeVariant}` : "variant default",
        modelLabel: formatModelLabel(model, state.activeVariant, state.providers),
        variant: state.activeVariant,
      }
    },
    onAgentSelect: (agent) => {
      state.agent = agent
    },
    onModelSelect: async (model) => {
      if (state.model?.providerID === model.providerID && state.model.modelID === model.modelID) {
        return
      }

      state.model = model
      state.activeVariant = undefined
      state.variants = variantsFor(state.providers, model)
      const switching = input.host.preferences.resolveVariant(model).then((saved) => {
        const current = state.model
        if (!current || current.providerID !== model.providerID || current.modelID !== model.modelID) {
          return
        }

        state.activeVariant = resolveVariant(undefined, undefined, saved, state.variants)
      })
      state.switching = switching
      await switching
      if (state.switching === switching) {
        state.switching = undefined
      }

      const current = state.model
      if (!current || current.providerID !== model.providerID || current.modelID !== model.modelID) {
        return
      }

      return {
        modelLabel: formatModelLabel(model, state.activeVariant, state.providers),
        status: `model ${model.modelID}`,
        variant: state.activeVariant,
        variants: state.variants,
      }
    },
    onVariantSelect: async (variant) => {
      const model = state.model ?? state.defaultModel
      if (!model || state.variants.length === 0) {
        return {
          status: "no variants available",
        }
      }

      if (variant && !state.variants.includes(variant)) {
        return {
          status: `variant ${variant} unavailable`,
        }
      }

      if (!state.model) state.model = model
      state.activeVariant = variant
      void input.host.preferences.saveVariant(model, state.activeVariant)
      return {
        status: state.activeVariant ? `variant ${state.activeVariant}` : "variant default",
        modelLabel: formatModelLabel(model, state.activeVariant, state.providers),
        variant: state.activeVariant,
        variants: state.variants,
      }
    },
    onInterrupt: () => {
      if (state.demo?.interrupt()) return true
      if (!state.sessionID) {
        return false
      }

      // No in-flight guard: interruption acknowledges immediately server-side and repeating
      // it is an idempotent no-op, so repeated presses are never swallowed.
      void (
        state.stream
          ? state.stream.then((item) => item.handle.interruptActiveTurn())
          : state.sdk.session.interrupt({ sessionID: state.sessionID, continue: true })
      ).catch(() => {})
      return true
    },
    onBackground: () => {
      if (!state.sessionID) {
        return
      }

      log?.write("send.background", { sessionID: state.sessionID })
      void state.sdk.session.background({ sessionID: state.sessionID }).catch(() => {})
    },
    onQueuedPromptAction: async (action, inboxID) => {
      if (!state.sessionID) return
      log?.write(`send.pending.${action}`, { sessionID: state.sessionID, inboxID })
      await state.sdk.session.inbox[action]({ sessionID: state.sessionID, inboxID })
    },
    onSubagentInterrupt: (sessionID) => {
      log?.write("send.subagent.interrupt", { sessionID })
      void state.sdk.session.interrupt({ sessionID }).catch(() => {})
    },
    onSubagentSelect: (sessionID) => {
      state.selectSubagent?.(sessionID)
      log?.write("subagent.select", {
        sessionID,
      })
    },
  })
  await tuiConfigTask
  const thinking = () => input.thinking ?? configState.current.thinking === "show"
  const footer = shell.footer
  const firstPaint = footer.idle().catch(() => {})
  const offRuntimeClose = footer.onClose(() => {
    state.demo?.interrupt()
    runtimeController.abort()
  })
  let clientGeneration = 0
  let clientController = new AbortController()
  let modelAttempt: AbortController | undefined
  let modelLoad: Promise<void> | undefined
  let modelLoadQueued = false
  let modelLoadStarted = false

  const updateClient = (sdk: RunInput["sdk"]) => {
    if (state.sdk === sdk) return
    state.sdk = sdk
    clientGeneration++
    clientController.abort()
    clientController = new AbortController()
    modelAttempt?.abort()
    if (modelLoadStarted && !state.model) void requestModelLoad()
  }

  const clientAttempt = (signal?: AbortSignal): ClientAttempt => ({
    sdk: state.sdk,
    generation: clientGeneration,
    signal: AbortSignal.any(
      signal
        ? [runtimeController.signal, clientController.signal, signal]
        : [runtimeController.signal, clientController.signal],
    ),
  })

  const currentClient = (attempt: ClientAttempt) =>
    !footer.isClosed && !attempt.signal.aborted && attempt.generation === clientGeneration && attempt.sdk === state.sdk

  const ensureSession = () => {
    if (state.sessionID) {
      return Promise.resolve()
    }

    if (state.session) {
      return state.session
    }

    const task = input
      .resolveSession(state.sdk, runtimeController.signal)
      .then(async (next) => {
        if (next.sdk) updateClient(next.sdk)
        if (footer.isClosed || runtimeController.signal.aborted) return
        state.sessionID = next.sessionID
        state.sessionTitle = next.sessionTitle ?? state.sessionTitle
        shell.setTitle(state.sessionTitle)
        state.agent = next.agent
        state.location = next.location
        state.model = next.model
        state.activeVariant = next.variant
        footer.event({ type: "agent", agent: state.agent })
        if (!next.resume) return
        const resumed = await resolveSessionInfo(state.sdk, next.sessionID, next.model, runtimeController.signal)
        if (footer.isClosed || runtimeController.signal.aborted) return
        session.first = resumed.first
        session.history = resumed.history
        session.model = resumed.model
        session.variant = resumed.variant
        state.shown = !resumed.first
        state.history = [...resumed.history]
        state.model = next.model ?? resumed.model
        const resumedSavedVariant = state.model ? await input.host.preferences.resolveVariant(state.model) : undefined
        state.activeVariant = resolveVariant(next.variant, resumed.variant, resumedSavedVariant, [])
        session.variant = state.activeVariant
        footer.event({ type: "history", history: resumed.history })
        footer.event({ type: "first", first: resumed.first })
        if (footer.isClosed || runtimeController.signal.aborted) return
        await shell.resetForReplay()
      })
      .catch((error) => {
        if (footer.isClosed || runtimeController.signal.aborted) return
        throw error
      })
    state.session = task
    void task.catch(() => {
      if (state.session === task) state.session = undefined
    })
    return task
  }

  const currentModelLoad = (generation: number, sdk: RunInput["sdk"]) =>
    !footer.isClosed && !runtimeController.signal.aborted && generation === clientGeneration && sdk === state.sdk

  const loadCurrentModel = async () => {
    const generation = clientGeneration
    const sdk = state.sdk
    const selected = state.model
    const controller = new AbortController()
    const signal = AbortSignal.any([runtimeController.signal, controller.signal])
    modelAttempt = controller
    try {
      const info = await abortable(resolveModelInfo(sdk, state.location, signal), signal)
      if (
        !info ||
        !currentModelLoad(generation, sdk) ||
        (selected && (state.model?.providerID !== selected.providerID || state.model.modelID !== selected.modelID))
      )
        return
      applyModelInfo(
        info,
        selected ? session.variant : state.activeVariant,
        { sdk, generation, signal },
        !!selected,
        savedVariant,
      )
    } finally {
      if (modelAttempt === controller) modelAttempt = undefined
    }
  }

  function requestModelLoad(): Promise<void> {
    modelLoadQueued = true
    if (modelLoad || footer.isClosed) return modelLoad ?? Promise.resolve()
    const task = (async () => {
      while (modelLoadQueued && !footer.isClosed) {
        modelLoadQueued = false
        await loadCurrentModel()
      }
    })()
    modelLoad = task
    const cleanup = () => {
      if (modelLoad === task) modelLoad = undefined
      if (modelLoadQueued && !footer.isClosed) void requestModelLoad()
    }
    void task.then(cleanup, cleanup)
    return task
  }

  const modelTask = firstPaint.then(async () => {
    if (footer.isClosed) return
    await ensureSession()
    if (footer.isClosed) return
    modelLoadStarted = true
    return requestModelLoad()
  })
  const rememberLocal = (commit: StreamCommit) => {
    const last = state.localRows.at(-1)
    if (
      last &&
      (commit.kind === "assistant" || commit.kind === "reasoning") &&
      last.commit.kind === commit.kind &&
      last.commit.source === commit.source &&
      last.commit.messageID === commit.messageID &&
      last.commit.partID === commit.partID &&
      last.commit.tool === commit.tool
    ) {
      state.localRows = [...state.localRows.slice(0, -1), { commit }]
      return
    }
    state.localRows = [...state.localRows, { commit }].slice(-LOCAL_REPLAY_ROW_LIMIT)
  }

  const applyCatalog = (
    catalog: {
      agents: Awaited<ReturnType<typeof loadRunAgents>>
      references: Awaited<ReturnType<typeof loadRunReferences>>
      commands: Awaited<ReturnType<typeof loadRunCommands>>
    },
    attempt: ClientAttempt,
  ) => {
    if (!currentClient(attempt)) return
    footer.event({
      type: "catalog",
      agents: catalog.agents,
      references: catalog.references,
      commands: catalog.commands,
    })
  }

  const fetchCatalog = async (attempt: ClientAttempt) => {
    const [agents, references, commands] = await Promise.all([
      loadRunAgents(attempt.sdk, state.location, attempt.signal),
      loadRunReferences(attempt.sdk, state.location, attempt.signal),
      loadRunCommands(attempt.sdk, state.location, attempt.signal),
    ])
    return { agents, references, commands }
  }

  const loadCatalog = async (attempt: ClientAttempt) => {
    const catalog = await abortable(
      Promise.all([
        loadRunAgents(attempt.sdk, state.location, attempt.signal).catch(() => []),
        loadRunReferences(attempt.sdk, state.location, attempt.signal).catch(() => []),
        loadRunCommands(attempt.sdk, state.location, attempt.signal).catch(() => []),
      ]).then(([agents, references, commands]) => ({ agents, references, commands })),
      attempt.signal,
    )
    if (catalog) applyCatalog(catalog, attempt)
  }

  function applyModelInfo(
    info: Awaited<ReturnType<typeof resolveModelInfo>>,
    current: string | undefined,
    attempt: ClientAttempt,
    boot = false,
    saved = savedVariant,
  ) {
    if (!currentClient(attempt)) return
    state.providers = info.providers
    const model = state.model ?? state.defaultModel
    state.variants = variantsFor(state.providers, model)
    state.activeVariant = boot
      ? resolveVariant(ctx.variant, current, saved, state.variants)
      : current && !state.variants.includes(current)
        ? undefined
        : current
    if (footer.isClosed) return
    footer.event({ type: "models", providers: info.providers })
    footer.event({ type: "variants", variants: state.variants, current: state.activeVariant })
    if (model)
      footer.event({
        type: "model",
        model: formatModelLabel(model, state.activeVariant, state.providers),
        selection: model,
      })
  }

  let catalogRefresh:
    | {
        attempt: ClientAttempt
        source: AbortSignal | undefined
        queued: boolean
        task: Promise<void>
      }
    | undefined
  let defaultModelLoad: Promise<void> | undefined
  let defaultModelQueued = false
  const loadDefaultModel = (attempt: ClientAttempt) => {
    if (state.model || !currentClient(attempt)) return
    if (defaultModelLoad) {
      defaultModelQueued = true
      return
    }
    defaultModelQueued = false
    defaultModelLoad = attempt.sdk.model
      .default(
        {
          location: {
            directory: state.location.directory,
            workspace: state.location.workspaceID,
          },
        },
        { signal: attempt.signal },
      )
      .then(async (result) => {
        if (!result.data || state.model || !currentClient(attempt)) return
        const model = { providerID: result.data.providerID, modelID: result.data.id }
        const changed =
          state.defaultModel?.providerID !== model.providerID || state.defaultModel.modelID !== model.modelID
        const saved = changed ? await input.host.preferences.resolveVariant(model) : undefined
        if (state.model || !currentClient(attempt)) return
        state.defaultModel = model
        state.variants = variantsFor(state.providers, model)
        if (changed) state.activeVariant = resolveVariant(ctx.variant, state.activeVariant, saved, state.variants)
        if (state.activeVariant) state.model = model
        footer.event({ type: "variants", variants: state.variants, current: state.activeVariant })
        footer.event({
          type: "model",
          model: formatModelLabel(model, state.activeVariant, state.providers),
          selection: model,
        })
      })
      .catch(() => {})
      .finally(() => {
        defaultModelLoad = undefined
        if (defaultModelQueued) loadDefaultModel(clientAttempt())
      })
  }
  const requestCatalogRefresh = (signal?: AbortSignal): Promise<void> => {
    const attempt = clientAttempt(signal)
    if (!currentClient(attempt)) return Promise.resolve()
    const running = catalogRefresh
    if (
      running &&
      !running.attempt.signal.aborted &&
      running.attempt.generation === attempt.generation &&
      running.attempt.sdk === attempt.sdk
    ) {
      running.queued = true
      return running.task
    }

    const refresh = {
      attempt,
      source: signal,
      queued: true,
      task: Promise.resolve(),
    }
    const task = (async () => {
      await Promise.all([abortable(modelTask, attempt.signal), abortable(initialCatalog, attempt.signal)])
      while (refresh.queued && currentClient(attempt)) {
        refresh.queued = false
        const [catalog, info] = await Promise.all([
          abortable(fetchCatalog(attempt), attempt.signal),
          abortable(resolveModelInfoStrict(attempt.sdk, state.location, attempt.signal), attempt.signal),
        ])
        if (!currentClient(attempt)) return
        if (catalog) applyCatalog(catalog, attempt)
        if (info) applyModelInfo(info, state.activeVariant, attempt)
        loadDefaultModel(attempt)
      }
    })()
    refresh.task = task
    catalogRefresh = refresh
    const cleanup = () => {
      if (catalogRefresh !== refresh) return
      catalogRefresh = undefined
      if (refresh.queued && currentClient(attempt)) void requestCatalogRefresh(refresh.source)
    }
    void task.then(cleanup, cleanup)
    return task
  }

  const initialCatalog = firstPaint
    .then(() => (footer.isClosed ? undefined : ensureSession()))
    .then(() => (footer.isClosed ? undefined : loadCatalog(clientAttempt())))
    .catch(() => {})
  void initialCatalog

  if (input.host.startup.showTiming) {
    void firstPaint.then(() => {
      if (footer.isClosed) return
      footer.append({
        kind: "system",
        text: `startup ${Math.max(0, Math.round(input.host.startup.now() - start))}ms`,
        phase: "final",
        source: "system",
      })
    })
  }

  const createDemo = async () => {
    const { createRunDemo } = await import("./demo")
    return createRunDemo({
      footer,
      sessionID: state.sessionID,
      thinking: thinking(),
    })
  }

  if (input.demo) {
    await firstPaint
    if (!footer.isClosed) {
      await ensureSession()
      state.demo = await createDemo()
    }
  }

  let streamTask = deps.streamTransport
  const loadStreamTransport = () => {
    if (streamTask) return streamTask
    streamTask = import("./stream-v2.transport")
    return streamTask
  }
  const ensureStream = () => {
    if (state.stream) {
      return state.stream
    }

    // Share eager prewarm and first-turn boot through one in-flight promise,
    // but clear it if transport creation fails so a later prompt can retry.
    const next = (async () => {
      await ensureSession()
      if (footer.isClosed) {
        throw new Error("runtime closed")
      }

      const mod = await loadStreamTransport()
      if (footer.isClosed) {
        throw new Error("runtime closed")
      }

      const handle = await mod.createSessionTransport({
        sdk: state.sdk,
        reconnect: input.reconnect,
        onClient: updateClient,
        readTextFile: input.host.files.readText,
        location: state.location,
        sessionID: state.sessionID,
        thinking: thinking(),
        tools: configState.current.tools === "show",
        replay: input.replay,
        replayLimit: input.replayLimit,
        footer,
        onCommit: rememberLocal,
        onSessionTitle: (title) => {
          state.sessionTitle = title
          shell.setTitle(title)
        },
        trace: log,
        onCatalogRefresh: requestCatalogRefresh,
        contextLimit: (model) =>
          state.providers.find((provider) => provider.id === model.providerID)?.models[model.modelID]?.limit?.context,
      })
      if (footer.isClosed) {
        await handle.close()
        throw new Error("runtime closed")
      }

      state.selectSubagent = (sessionID) => handle.selectSubagent(sessionID)
      return { mod, handle }
    })()
    state.stream = next
    void next.catch(() => {
      if (state.stream === next) {
        state.stream = undefined
      }
    })
    return next
  }

  let resizeTimer: ReturnType<typeof setTimeout> | undefined
  const offResize = shell.onResize(() => {
    if (resizeTimer) {
      clearTimeout(resizeTimer)
    }

    resizeTimer = setTimeout(() => {
      resizeTimer = undefined
      if (footer.isClosed) {
        return
      }

      shell.refreshTheme()
      if (!input.replay || !state.stream) {
        return
      }

      void state.stream
        .then((item) =>
          item.handle.replayOnResize({
            localRows: () => state.localRows,
            reset: () => shell.resetForReplay(),
          }),
        )
        .catch(() => {})
    }, RESIZE_DELAY)
  })

  const renderPromptError = async (prompt: RunPrompt, error: unknown, signal?: AbortSignal) => {
    if (signal?.aborted || footer.isClosed) return
    const text =
      (await state.stream?.then((item) => item.mod).catch(() => undefined))?.formatUnknownError(error) ??
      (error instanceof Error ? error.message : String(error))
    const commit = {
      kind: "error",
      text,
      phase: "start",
      source: "system",
      messageID: prompt.messageID,
    } as const
    rememberLocal(commit)
    footer.append(commit)
  }

  const runQueue = async () => {
    await firstPaint
    if (footer.isClosed) return
    await ensureSession()
    if (footer.isClosed) return
    await modelTask
    if (footer.isClosed) return
    let includeFiles = true
    if (state.demo) {
      await state.demo.start()
    }

    const mod = await import("./runtime.queue")
    const createSession = input.createSession
    await mod.runPromptQueue({
      footer,
      initialInput: input.initialInput,
      trace: log,
      onSend: (prompt, emittedUser) => {
        state.shown = true
        state.history.push({ ...prompt, delivery: undefined })
        // Pending inputs can still be cancelled; only replay rows already printed.
        if (emittedUser) {
          rememberLocal({
            kind: "user",
            text: prompt.text,
            phase: "start",
            source: "system",
            messageID: prompt.messageID,
          })
        }
      },
      admit: async (prompt, delivery, signal) => {
        await state.switching?.catch(() => {})
        const next = await ensureStream()
        await next.handle.admitPromptTurn(
          {
            agent: state.agent,
            model: state.model,
            variant: state.activeVariant,
            prompt,
            files: input.files,
            includeFiles: false,
            signal,
          },
          delivery,
        )
      },
      onAdmissionError: renderPromptError,
      onCompact: async () => {
        await state.sdk.session.compact({ sessionID: state.sessionID }, formRequestOptions(state.location))
      },
      settle: async () => {
        const next = await ensureStream()
        await next.handle.waitForIdle()
      },
      onNewSession: createSession
        ? async () => {
            try {
              await state.switching?.catch(() => {})
              const created = await createSession(
                state.sdk,
                {
                  location: newSessionLocation(
                    (await tuiConfigTask).session.new_location,
                    input.directory,
                    state.location,
                  ),
                  agent: state.agent,
                  model: state.model,
                  variant: state.activeVariant,
                },
                runtimeController.signal,
              )
              if (!created.sessionID) throw new Error("Failed to create session")
              await footer.idle().catch(() => {})
              await state.stream?.then((item) => item.handle.close()).catch(() => {})
              state.stream = undefined
              state.session = undefined
              state.selectSubagent = undefined
              state.shown = false
              state.sessionID = created.sessionID
              state.sessionTitle = created.sessionTitle
              shell.setTitle(state.sessionTitle)
              state.agent = created.agent ?? state.agent
              state.location = created.location
              state.model = created.model
              state.activeVariant = created.variant
              footer.event({ type: "agent", agent: state.agent })
              state.history = []
              state.localRows = []
              includeFiles = true
              state.demo = input.demo ? await createDemo() : undefined
              log?.write("session.new", {
                sessionID: state.sessionID,
              })
              footer.event({
                type: "stream.subagent",
                state: {
                  tabs: [],
                  details: {},
                  permissions: [],
                  forms: [],
                },
              })
              footer.event({ type: "stream.view", view: { type: "prompt" } })
              footer.event({ type: "queued.prompts", prompts: [] })
              footer.event({
                type: "stream.patch",
                patch: {
                  phase: "idle",
                  usage: undefined,
                  first: true,
                },
              })
              footer.append({
                kind: "system",
                text: `new session ${state.sessionID}`,
                phase: "final",
                source: "system",
              })
              await state.demo?.start()
            } catch (error) {
              footer.event({
                type: "stream.patch",
                patch: {
                  phase: "idle",
                  status: "failed to start new session",
                },
              })
              const commit = {
                kind: "error",
                text: error instanceof Error ? error.message : String(error),
                phase: "start",
                source: "system",
                messageID: SessionMessage.ID.create(),
              } as const
              rememberLocal(commit)
              footer.append(commit)
            }
          }
        : undefined,
      run: async (prompt, signal, admitted) => {
        if (state.demo && (await state.demo.prompt(prompt, signal))) {
          return
        }

        await state.switching?.catch(() => {})

        try {
          const next = await ensureStream()
          await next.handle.runPromptTurn(
            {
              agent: state.agent,
              model: state.model,
              variant: state.activeVariant,
              prompt,
              files: input.files,
              includeFiles,
              signal,
            },
            admitted,
          )
          if (prompt.messageID) {
            state.localRows = state.localRows.filter(
              (row) => row.commit.kind !== "user" || row.commit.messageID !== prompt.messageID,
            )
          }
          // Shell and skill turns never send CLI file attachments; keep them
          // pending for the next prompt-shaped turn.
          if (prompt.mode !== "shell" && prompt.command?.source !== "skill") includeFiles = false
        } catch (error) {
          await renderPromptError(prompt, error, signal)
        }
      },
    })
  }

  try {
    if (input.demo) {
      await firstPaint
      if (footer.isClosed) return
      await ensureStream()
    } else {
      void firstPaint
        .then(() => {
          if (footer.isClosed) {
            return
          }

          return ensureStream()
        })
        .catch(() => {})
    }

    try {
      await runQueue()
    } finally {
      if (resizeTimer) {
        clearTimeout(resizeTimer)
      }
      offResize()
      await state.stream?.then((item) => item.handle.close()).catch(() => {})
    }
  } finally {
    runtimeController.abort()
    offRuntimeClose()

    await shell.close({
      showExit: state.shown && !!state.sessionID,
      sessionTitle: state.sessionTitle,
      sessionID: state.sessionID,
      history: state.history,
    })
  }
}

// Deferred mode paints before session resolution. The caller may back the
// generated client with a transport that is still acquiring a daemon.
export async function runInteractiveDeferredMode(input: RunDeferredInput, deps?: RunRuntimeDeps): Promise<void> {
  const sdk = input.sdk

  return runInteractiveRuntime(
    {
      host: input.host,
      directory: input.directory,
      files: input.files,
      initialInput: input.initialInput,
      thinking: input.thinking,
      replay: input.replay,
      replayLimit: input.replayLimit,
      demo: input.demo,
      tuiConfig: input.tuiConfig,
      config: input.config,
      reconnect: input.reconnect,
      resolveSession: input.target,
      createSession: input.createSession,
      boot: async () => {
        return {
          sdk,
          location: { directory: input.directory },
          agent: input.agent,
          model: input.model,
          variant: input.variant,
        }
      },
    },
    deps,
  )
}
