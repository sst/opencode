import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import { RGBA, type CliRenderer } from "@opentui/core"
import type { HostPluginApi } from "@opencode-ai/tui/plugin/slots"
import { createTuiResolvedConfig } from "./tui-runtime"

type Count = {
  event_add: number
  event_drop: number
  route_add: number
  route_drop: number
  command_add: number
  command_drop: number
}

type AttentionOpts = Partial<Omit<HostPluginApi["attention"], "soundboard">> & {
  soundboard?: Partial<HostPluginApi["attention"]["soundboard"]>
}

function themeCurrent(): HostPluginApi["theme"]["current"] {
  const a = RGBA.fromInts(0, 120, 240)
  const b = RGBA.fromInts(120, 120, 120)
  const c = RGBA.fromInts(230, 230, 230)
  const d = RGBA.fromInts(120, 30, 30)
  const e = RGBA.fromInts(140, 100, 40)
  const f = RGBA.fromInts(20, 140, 80)
  const g = RGBA.fromInts(20, 80, 160)
  const h = RGBA.fromInts(40, 40, 40)
  const i = RGBA.fromInts(60, 60, 60)
  const j = RGBA.fromInts(80, 80, 80)
  return {
    primary: a,
    secondary: b,
    accent: a,
    error: d,
    warning: e,
    success: f,
    info: g,
    text: c,
    textMuted: b,
    selectedListItemText: h,
    background: h,
    backgroundPanel: h,
    backgroundElement: i,
    backgroundMenu: i,
    border: j,
    borderActive: c,
    borderSubtle: i,
    diffAdded: f,
    diffRemoved: d,
    diffContext: b,
    diffHunkHeader: b,
    diffHighlightAdded: f,
    diffHighlightRemoved: d,
    diffAddedBg: h,
    diffRemovedBg: h,
    diffContextBg: h,
    diffLineNumber: b,
    diffAddedLineNumberBg: h,
    diffRemovedLineNumberBg: h,
    markdownText: c,
    markdownHeading: c,
    markdownLink: a,
    markdownLinkText: g,
    markdownCode: f,
    markdownBlockQuote: e,
    markdownEmph: e,
    markdownStrong: c,
    markdownHorizontalRule: b,
    markdownListItem: a,
    markdownListEnumeration: g,
    markdownImage: a,
    markdownImageText: g,
    markdownCodeBlock: c,
    syntaxComment: b,
    syntaxKeyword: a,
    syntaxFunction: g,
    syntaxVariable: c,
    syntaxString: f,
    syntaxNumber: e,
    syntaxType: a,
    syntaxOperator: a,
    syntaxPunctuation: c,
    thinkingOpacity: 0.6,
  }
}

type Opts = {
  client?: HostPluginApi["client"] | (() => HostPluginApi["client"])
  renderer?: HostPluginApi["renderer"]
  attention?: AttentionOpts
  event?: HostPluginApi["event"]
  mode?: HostPluginApi["mode"]
  count?: Count
  keymap?: HostPluginApi["keymap"]
  tuiConfig?: Partial<HostPluginApi["tuiConfig"]>
  app?: Partial<HostPluginApi["app"]>
  state?: {
    ready?: HostPluginApi["state"]["ready"]
    config?: HostPluginApi["state"]["config"]
    provider?: HostPluginApi["state"]["provider"]
    path?: HostPluginApi["state"]["path"]
    vcs?: HostPluginApi["state"]["vcs"]
    session?: Partial<HostPluginApi["state"]["session"]>
    part?: HostPluginApi["state"]["part"]
    lsp?: HostPluginApi["state"]["lsp"]
    mcp?: HostPluginApi["state"]["mcp"]
    scrollToMessage?: HostPluginApi["state"]["scrollToMessage"]
    scrollToBottom?: HostPluginApi["state"]["scrollToBottom"]
  }
  theme?: {
    selected?: string
    has?: HostPluginApi["theme"]["has"]
    set?: HostPluginApi["theme"]["set"]
    install?: HostPluginApi["theme"]["install"]
    mode?: HostPluginApi["theme"]["mode"]
    ready?: boolean
    current?: HostPluginApi["theme"]["current"]
  }
}

function tuiConfig(input?: Partial<HostPluginApi["tuiConfig"]>): HostPluginApi["tuiConfig"] {
  return {
    ...createTuiResolvedConfig(),
    ...input,
  }
}

export function createTuiPluginApi(opts: Opts = {}): HostPluginApi {
  const kv: Record<string, unknown> = {}
  const count = opts.count
  const ctrl = new AbortController()
  const own = createOpencodeClient({
    baseUrl: "http://localhost:4096",
  })
  const fallback = () => own
  const read =
    typeof opts.client === "function"
      ? opts.client
      : opts.client
        ? () => opts.client as HostPluginApi["client"]
        : fallback
  const client = () => read()
  let depth = 0
  let size: "medium" | "large" | "xlarge" = "medium"
  const has = opts.theme?.has ?? (() => false)
  let selected = opts.theme?.selected ?? "opencode"
  const set =
    opts.theme?.set ??
    ((name: string) => {
      if (!has(name)) return false
      selected = name
      return true
    })
  const renderer: CliRenderer = opts.renderer ?? {
    ...Object.create(null),
    once(this: CliRenderer) {
      return this
    },
  }
  const keymap =
    opts.keymap ??
    ({
      acquireResource(_key: symbol, setup: () => () => void) {
        const dispose = setup()
        return () => {
          dispose()
        }
      },
      registerLayer() {
        if (count) count.command_add += 1
        return () => {
          if (!count) return
          count.command_drop += 1
        }
      },
      runCommand() {
        return { ok: true } as const
      },
    } as unknown as HostPluginApi["keymap"])

  function kvGet(name: string): unknown
  function kvGet<Value>(name: string, fallback: Value): Value
  function kvGet(name: string, fallback?: unknown) {
    const value = kv[name]
    if (value === undefined) return fallback
    return value
  }

  return {
    app: {
      get version() {
        return opts.app?.version ?? "0.0.0-test"
      },
    },
    attention: {
      async notify(input) {
        return opts.attention?.notify?.(input) ?? { ok: false, notification: false, sound: false }
      },
      soundboard: {
        registerPack: (pack) => opts.attention?.soundboard?.registerPack?.(pack) ?? (() => {}),
        activate: (id, options) => opts.attention?.soundboard?.activate?.(id, options) ?? false,
        current: () => opts.attention?.soundboard?.current?.() ?? "opencode.default",
        list: () => opts.attention?.soundboard?.list?.() ?? [],
      },
    },
    keys: {
      formatSequence: () => "",
      formatBindings: () => undefined,
    },
    get client() {
      return client()
    },
    event: opts.event ?? {
      on: () => {
        if (count) count.event_add += 1
        return () => {
          if (!count) return
          count.event_drop += 1
        }
      },
    },
    renderer,
    slots: {
      register: () => "fixture-slot",
    },
    plugins: {
      list: () => [],
      activate: async () => false,
      deactivate: async () => false,
      add: async () => false,
      install: async () => ({
        ok: false,
        message: "not implemented in fixture",
      }),
    },
    lifecycle: {
      signal: ctrl.signal,
      onDispose() {
        return () => {}
      },
    },
    keymap,
    mode: opts.mode ?? {
      current: () => "base",
      push: () => () => {},
    },
    route: {
      register: () => {
        if (count) count.route_add += 1
        return () => {
          if (!count) return
          count.route_drop += 1
        }
      },
      navigate: () => {},
      get current() {
        return { name: "home" }
      },
    },
    ui: {
      Dialog: () => null,
      DialogAlert: () => null,
      DialogConfirm: () => null,
      DialogPrompt: () => null,
      DialogSelect: () => null,
      Slot: () => null,
      Prompt: () => null,
      toast: () => {},
      dialog: {
        replace: () => {
          depth = 1
        },
        clear: () => {
          depth = 0
          size = "medium"
        },
        setSize: (next) => {
          size = next
        },
        get size() {
          return size
        },
        get depth() {
          return depth
        },
        get open() {
          return depth > 0
        },
      },
    },
    tuiConfig: tuiConfig(opts.tuiConfig),
    kv: {
      get: kvGet,
      set(name, value) {
        kv[name] = value
      },
      get ready() {
        return true
      },
    },
    state: {
      get ready() {
        return opts.state?.ready ?? true
      },
      get config() {
        return opts.state?.config ?? {}
      },
      get provider() {
        return opts.state?.provider ?? []
      },
      get path() {
        return opts.state?.path ?? { home: "", state: "", config: "", worktree: "", directory: "" }
      },
      get vcs() {
        return opts.state?.vcs
      },
      session: {
        count: opts.state?.session?.count ?? (() => 0),
        get: opts.state?.session?.get ?? (() => undefined),
        diff: opts.state?.session?.diff ?? (() => []),
        todo: opts.state?.session?.todo ?? (() => []),
        messages: opts.state?.session?.messages ?? (() => []),
        status: opts.state?.session?.status ?? (() => undefined),
        permission: opts.state?.session?.permission ?? (() => []),
        question: opts.state?.session?.question ?? (() => []),
      },
      part: opts.state?.part ?? (() => []),
      lsp: opts.state?.lsp ?? (() => []),
      mcp: opts.state?.mcp ?? (() => []),
      scrollToMessage: opts.state?.scrollToMessage ?? (() => false),
      scrollToBottom: opts.state?.scrollToBottom ?? (() => false),
    },
    theme: {
      get current() {
        return opts.theme?.current ?? themeCurrent()
      },
      get selected() {
        return selected
      },
      has(name) {
        return has(name)
      },
      set(name) {
        return set(name)
      },
      async install(file) {
        if (opts.theme?.install) return opts.theme.install(file)
        throw new Error("base theme.install should not run")
      },
      mode() {
        if (opts.theme?.mode) return opts.theme.mode()
        return "dark"
      },
      get ready() {
        return opts.theme?.ready ?? true
      },
    },
  }
}
