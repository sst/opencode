import type {
  AgentPart,
  OpencodeClient,
  Event,
  FilePart,
  LspStatus,
  McpStatus,
  Todo,
  Message,
  Part,
  Provider,
  PermissionRequest,
  QuestionRequest,
  Session,
  SessionStatus,
  TextPart,
  Config as SdkConfig,
} from "@opencode-ai/sdk/v2"
import type { CliRenderer, KeyEvent, RGBA, Renderable, SlotMode } from "@opentui/core"
import type { Binding, Keymap } from "@opentui/keymap"
import {
  createBindingLookup as createKeymapBindingLookup,
  type BindingConfig,
  type CreateBindingLookupOptions,
  type KeySequenceFormatPart,
  type SequenceBindingLike,
} from "@opentui/keymap/extras"
import type { JSX, SolidPlugin } from "@opentui/solid"
import type { Config as PluginConfig, PluginOptions } from "./index.js"

export type { CliRenderer, KeyEvent, Renderable, SlotMode } from "@opentui/core"
export { stringifyKeySequence, stringifyKeyStroke } from "@opentui/keymap"
export type { Binding, KeyLike, KeySequencePart, KeyStringifyInput, StringifyOptions } from "@opentui/keymap"
export { formatCommandBindings, formatKeySequence } from "@opentui/keymap/extras"
export type {
  BindingConfig,
  BindingLookup,
  BindingValue,
  CreateBindingLookupOptions,
  FormatCommandBindingsOptions,
  FormatKeySequenceOptions,
  KeySequenceFormatPart,
  SequenceBindingLike,
} from "@opentui/keymap/extras"

export function createBindingLookup(
  config: BindingConfig<Renderable, KeyEvent> | undefined,
  options?: CreateBindingLookupOptions<Renderable, KeyEvent>,
) {
  return createKeymapBindingLookup<Renderable, KeyEvent>(config ?? {}, options)
}

export type TuiRouteCurrent =
  | {
      name: "home"
    }
  | {
      name: "session"
      params: {
        sessionID: string
        prompt?: unknown
      }
    }
  | {
      name: string
      params?: Record<string, unknown>
    }

export type TuiRouteDefinition = {
  name: string
  render: (input: { params?: Record<string, unknown> }) => JSX.Element
}

export type TuiKeys = {
  formatSequence: (parts: readonly KeySequenceFormatPart[] | undefined) => string
  formatBindings: (bindings: readonly SequenceBindingLike[] | undefined) => string | undefined
}

export type TuiKeymap = Keymap<Renderable, KeyEvent>

export type TuiModeApi = {
  current: () => string
  push: (mode: string) => () => void
}

/**
 * Legacy `api.command` shape kept so v1 plugins can initialize. Remove in v2.
 *
 * @deprecated Use `api.keymap.registerLayer({ commands, bindings })` instead.
 */
export type TuiCommand = {
  title: string
  value: string
  description?: string
  category?: string
  keybind?: string
  suggested?: boolean
  hidden?: boolean
  enabled?: boolean
  slash?: {
    name: string
    aliases?: string[]
  }
  onSelect?: (dialog?: TuiDialogStack) => void | Promise<void>
}

/**
 * Legacy `api.command` API kept so v1 plugins can initialize. Remove in v2.
 *
 * @deprecated Use `api.keymap.registerLayer`, `api.keymap.dispatchCommand`, and
 * `api.keymap.dispatchCommand("command.palette.show")` instead.
 */
export type TuiCommandApi = {
  /** @deprecated Use `api.keymap.registerLayer({ commands, bindings })` instead. */
  register: (cb: () => TuiCommand[]) => () => void
  /** @deprecated Use `api.keymap.dispatchCommand(name)` instead. */
  trigger: (value: string) => void
  /** @deprecated Use `api.keymap.dispatchCommand("command.palette.show")` instead. */
  show: () => void
}

export type TuiDialogProps = {
  size?: "medium" | "large" | "xlarge"
  onClose: () => void
  children?: JSX.Element
}

export type TuiDialogStack = {
  replace: (render: () => JSX.Element, onClose?: () => void) => void
  clear: () => void
  setSize: (size: "medium" | "large" | "xlarge") => void
  readonly size: "medium" | "large" | "xlarge"
  readonly depth: number
  readonly open: boolean
}

export type TuiDialogAlertProps = {
  title: string
  message: string
  onConfirm?: () => void
}

export type TuiDialogConfirmProps = {
  title: string
  message: string
  onConfirm?: () => void
  onCancel?: () => void
}

export type TuiDialogPromptProps = {
  title: string
  description?: () => JSX.Element
  placeholder?: string
  value?: string
  busy?: boolean
  busyText?: string
  onConfirm?: (value: string) => void
  onCancel?: () => void
}

export type TuiDialogSelectOption<Value = unknown> = {
  title: string
  value: Value
  description?: string
  footer?: JSX.Element | string
  category?: string
  disabled?: boolean
  onSelect?: () => void
}

export type TuiDialogSelectProps<Value = unknown> = {
  title: string
  placeholder?: string
  options: TuiDialogSelectOption<Value>[]
  flat?: boolean
  onMove?: (option: TuiDialogSelectOption<Value>) => void
  onFilter?: (query: string) => void
  onSelect?: (option: TuiDialogSelectOption<Value>) => void
  skipFilter?: boolean
  current?: Value
}

export type TuiPromptInfo = {
  input: string
  mode?: "normal" | "shell"
  parts: (
    | Omit<FilePart, "id" | "messageID" | "sessionID">
    | Omit<AgentPart, "id" | "messageID" | "sessionID">
    | (Omit<TextPart, "id" | "messageID" | "sessionID"> & {
        source?: {
          text: {
            start: number
            end: number
            value: string
          }
        }
      })
  )[]
}

export type TuiPromptRef = {
  focused: boolean
  current: TuiPromptInfo
  set(prompt: TuiPromptInfo): void
  reset(): void
  blur(): void
  focus(): void
  submit(): void
}

export type TuiPromptProps = {
  sessionID?: string
  visible?: boolean
  disabled?: boolean
  onSubmit?: () => void
  ref?: (ref: TuiPromptRef | undefined) => void
  hint?: JSX.Element
  right?: JSX.Element
  showPlaceholder?: boolean
  placeholders?: {
    normal?: string[]
    shell?: string[]
  }
}

export type TuiToast = {
  variant?: "info" | "success" | "warning" | "error"
  title?: string
  message: string
  duration?: number
}

export type TuiAttentionWhen = "always" | "focused" | "blurred"

export const TuiAttentionSoundNames = ["default", "question", "permission", "error", "done", "subagent_done"] as const
export type TuiAttentionSoundName = (typeof TuiAttentionSoundNames)[number]

export type TuiAttentionSound =
  | boolean
  | {
      name?: TuiAttentionSoundName
      volume?: number
      when?: TuiAttentionWhen
    }

export type TuiAttentionNotification =
  | boolean
  | {
      when?: TuiAttentionWhen
    }

export type TuiAttentionSoundPack = {
  id: string
  name?: string
  sounds: Partial<Record<TuiAttentionSoundName, string>>
}

export type TuiAttentionSoundPackInfo = {
  id: string
  name?: string
  active: boolean
  builtin: boolean
}

export type TuiAttentionSoundboardActivateOptions = {
  persist?: boolean
}

export type TuiAttentionSoundboard = {
  registerPack(pack: TuiAttentionSoundPack): () => void
  activate(id: string, options?: TuiAttentionSoundboardActivateOptions): boolean
  current(): string
  list(): ReadonlyArray<TuiAttentionSoundPackInfo>
}

export type TuiAttentionNotifyInput = {
  title?: string
  message: string
  notification?: TuiAttentionNotification
  sound?: TuiAttentionSound
}

export type TuiAttentionNotifySkipReason =
  | "attention_disabled"
  | "empty_message"
  | "blurred"
  | "focused"
  | "focus_unknown"
  | "renderer_destroyed"

export type TuiAttentionNotifyResult = {
  ok: boolean
  notification: boolean
  sound: boolean
  skipped?: TuiAttentionNotifySkipReason
}

export type TuiAttention = {
  notify(input: TuiAttentionNotifyInput): Promise<TuiAttentionNotifyResult>
  soundboard: TuiAttentionSoundboard
}

export type TuiThemeCurrent = {
  readonly primary: RGBA
  readonly secondary: RGBA
  readonly accent: RGBA
  readonly error: RGBA
  readonly warning: RGBA
  readonly success: RGBA
  readonly info: RGBA
  readonly text: RGBA
  readonly textMuted: RGBA
  readonly selectedListItemText: RGBA
  readonly background: RGBA
  readonly backgroundPanel: RGBA
  readonly backgroundElement: RGBA
  readonly backgroundMenu: RGBA
  readonly border: RGBA
  readonly borderActive: RGBA
  readonly borderSubtle: RGBA
  readonly diffAdded: RGBA
  readonly diffRemoved: RGBA
  readonly diffContext: RGBA
  readonly diffHunkHeader: RGBA
  readonly diffHighlightAdded: RGBA
  readonly diffHighlightRemoved: RGBA
  readonly diffAddedBg: RGBA
  readonly diffRemovedBg: RGBA
  readonly diffContextBg: RGBA
  readonly diffLineNumber: RGBA
  readonly diffAddedLineNumberBg: RGBA
  readonly diffRemovedLineNumberBg: RGBA
  readonly markdownText: RGBA
  readonly markdownHeading: RGBA
  readonly markdownLink: RGBA
  readonly markdownLinkText: RGBA
  readonly markdownCode: RGBA
  readonly markdownBlockQuote: RGBA
  readonly markdownEmph: RGBA
  readonly markdownStrong: RGBA
  readonly markdownHorizontalRule: RGBA
  readonly markdownListItem: RGBA
  readonly markdownListEnumeration: RGBA
  readonly markdownImage: RGBA
  readonly markdownImageText: RGBA
  readonly markdownCodeBlock: RGBA
  readonly syntaxComment: RGBA
  readonly syntaxKeyword: RGBA
  readonly syntaxFunction: RGBA
  readonly syntaxVariable: RGBA
  readonly syntaxString: RGBA
  readonly syntaxNumber: RGBA
  readonly syntaxType: RGBA
  readonly syntaxOperator: RGBA
  readonly syntaxPunctuation: RGBA
  readonly thinkingOpacity: number
}

export type TuiTheme = {
  readonly current: TuiThemeCurrent
  readonly selected: string
  has: (name: string) => boolean
  set: (name: string) => boolean
  install: (jsonPath: string) => Promise<void>
  mode: () => "dark" | "light"
  readonly ready: boolean
}

export type TuiKV = {
  get: <Value = unknown>(key: string, fallback?: Value) => Value
  set: (key: string, value: unknown) => void
  readonly ready: boolean
}

export type TuiState = {
  readonly ready: boolean
  readonly config: SdkConfig
  readonly provider: ReadonlyArray<Provider>
  readonly path: {
    state: string
    config: string
    worktree: string
    directory: string
  }
  readonly vcs: { branch?: string; default_branch?: string } | undefined
  session: {
    count: () => number
    get: (sessionID: string) => Session | undefined
    diff: (sessionID: string) => ReadonlyArray<TuiSidebarFileItem>
    todo: (sessionID: string) => ReadonlyArray<TuiSidebarTodoItem>
    messages: (sessionID: string) => ReadonlyArray<Message>
    status: (sessionID: string) => SessionStatus | undefined
    permission: (sessionID: string) => ReadonlyArray<PermissionRequest>
    question: (sessionID: string) => ReadonlyArray<QuestionRequest>
  }
  part: (messageID: string) => ReadonlyArray<Part>
  lsp: () => ReadonlyArray<TuiSidebarLspItem>
  mcp: () => ReadonlyArray<TuiSidebarMcpItem>
  scrollToMessage: (messageID: string) => boolean
  scrollToBottom: () => boolean
}

type TuiBindingLookupView = {
  readonly bindings: ReadonlyArray<Binding<Renderable, KeyEvent>>
  get: (command: string) => ReadonlyArray<Binding<Renderable, KeyEvent>>
  has: (command: string) => boolean
  gather: (name: string, commands: readonly string[]) => ReadonlyArray<Binding<Renderable, KeyEvent>>
  pick: (name: string, commands: readonly string[]) => Binding<Renderable, KeyEvent>[]
  omit: (name: string, commands: readonly string[]) => Binding<Renderable, KeyEvent>[]
}

type TuiAttentionConfigView = {
  enabled: boolean
  notifications: boolean
  sound: boolean
  volume: number
  sound_pack: string
  sounds: Partial<Record<TuiAttentionSoundName, string>>
}

type TuiConfigView = Pick<PluginConfig, "$schema" | "theme" | "plugin"> &
  NonNullable<PluginConfig["tui"]> & {
    leader_timeout: number
    attention: TuiAttentionConfigView
    plugin_enabled?: Record<string, boolean>
    keybinds: TuiBindingLookupView
  }

export type TuiApp = {
  readonly version: string
}

type Frozen<Value> = Value extends (...args: never[]) => unknown
  ? Value
  : Value extends ReadonlyArray<infer Item>
    ? ReadonlyArray<Frozen<Item>>
    : Value extends object
      ? { readonly [Key in keyof Value]: Frozen<Value[Key]> }
      : Value

export type TuiSidebarMcpItem = {
  name: string
  status: McpStatus["status"]
  error?: string
}

export type TuiSidebarLspItem = Pick<LspStatus, "id" | "root" | "status">

export type TuiSidebarTodoItem = Pick<Todo, "content" | "status">

export type TuiSidebarFileItem = {
  file: string
  additions: number
  deletions: number
}

export type TuiHostSlotMap = {
  app: {}
  app_bottom: {}
  home_logo: {}
  home_prompt: {
    ref?: (ref: TuiPromptRef | undefined) => void
  }
  home_prompt_right: {}
  session_prompt: {
    session_id: string
    visible?: boolean
    disabled?: boolean
    on_submit?: () => void
    ref?: (ref: TuiPromptRef | undefined) => void
  }
  session_prompt_right: {
    session_id: string
  }
  home_bottom: {}
  home_footer: {}
  sidebar_title: {
    session_id: string
    title: string
    share_url?: string
  }
  sidebar_content: {
    session_id: string
  }
  sidebar_footer: {
    session_id: string
  }
}

export type TuiSlotMap<Slots extends Record<string, object> = {}> = TuiHostSlotMap & Slots

type TuiSlotShape<Name extends string, Slots extends Record<string, object>> = Name extends keyof TuiHostSlotMap
  ? TuiHostSlotMap[Name]
  : Name extends keyof Slots
    ? Slots[Name]
    : Record<string, unknown>

export type TuiSlotProps<Name extends string = string, Slots extends Record<string, object> = {}> = {
  name: Name
  mode?: SlotMode
  children?: JSX.Element
} & TuiSlotShape<Name, Slots>

export type TuiSlotContext = {
  theme: TuiTheme
}

type SlotCore<Slots extends Record<string, object> = {}> = SolidPlugin<TuiSlotMap<Slots>, TuiSlotContext>

export type TuiSlotPlugin<Slots extends Record<string, object> = {}> = Omit<SlotCore<Slots>, "id"> & {
  id?: never
}

export type TuiSlots = {
  register: {
    (plugin: TuiSlotPlugin): string
    <Slots extends Record<string, object>>(plugin: TuiSlotPlugin<Slots>): string
  }
}

export type TuiEventBus = {
  on: <Type extends Event["type"]>(type: Type, handler: (event: Extract<Event, { type: Type }>) => void) => () => void
}

export type TuiDispose = () => void | Promise<void>

export type TuiLifecycle = {
  readonly signal: AbortSignal
  onDispose: (fn: TuiDispose) => () => void
}

export type TuiPluginState = "first" | "updated" | "same"

export type TuiPluginEntry = {
  id: string
  source: "file" | "npm" | "internal"
  spec: string
  target: string
  requested?: string
  version?: string
  modified?: number
  first_time: number
  last_time: number
  time_changed: number
  load_count: number
  fingerprint: string
}

export type TuiPluginMeta = TuiPluginEntry & {
  state: TuiPluginState
}

export type TuiPluginStatus = {
  id: string
  source: TuiPluginEntry["source"]
  spec: string
  target: string
  enabled: boolean
  active: boolean
}

export type TuiPluginInstallOptions = {
  global?: boolean
}

export type TuiPluginInstallResult =
  | {
      ok: true
      dir: string
      tui: boolean
    }
  | {
      ok: false
      message: string
      missing?: boolean
    }

export type TuiWorkspace = {
  current: () => string | undefined
  set: (workspaceID?: string) => void
}

export type TuiPluginApi = {
  app: TuiApp
  attention: TuiAttention
  /**
   * Legacy `api.command` API kept so v1 plugins can initialize. Remove in v2.
   *
   * @deprecated Use `api.keymap.registerLayer`, `api.keymap.dispatchCommand`, and
   * `api.keymap.dispatchCommand("command.palette.show")` instead.
   */
  command?: TuiCommandApi
  keys: TuiKeys
  keymap: TuiKeymap
  mode: TuiModeApi
  route: {
    register: (routes: TuiRouteDefinition[]) => () => void
    navigate: (name: string, params?: Record<string, unknown>) => void
    readonly current: TuiRouteCurrent
  }
  ui: {
    Dialog: (props: TuiDialogProps) => JSX.Element
    DialogAlert: (props: TuiDialogAlertProps) => JSX.Element
    DialogConfirm: (props: TuiDialogConfirmProps) => JSX.Element
    DialogPrompt: (props: TuiDialogPromptProps) => JSX.Element
    DialogSelect: <Value = unknown>(props: TuiDialogSelectProps<Value>) => JSX.Element
    Slot: <Name extends string>(props: TuiSlotProps<Name>) => JSX.Element | null
    Prompt: (props: TuiPromptProps) => JSX.Element
    toast: (input: TuiToast) => void
    dialog: TuiDialogStack
  }
  readonly tuiConfig: Frozen<TuiConfigView>
  kv: TuiKV
  state: TuiState
  theme: TuiTheme
  client: OpencodeClient
  event: TuiEventBus
  renderer: CliRenderer
  slots: TuiSlots
  plugins: {
    list: () => ReadonlyArray<TuiPluginStatus>
    activate: (id: string) => Promise<boolean>
    deactivate: (id: string) => Promise<boolean>
    add: (spec: string) => Promise<boolean>
    install: (spec: string, options?: TuiPluginInstallOptions) => Promise<TuiPluginInstallResult>
  }
  lifecycle: TuiLifecycle
}

export type TuiPlugin = (api: TuiPluginApi, options: PluginOptions | undefined, meta: TuiPluginMeta) => Promise<void>

export type TuiPluginModule = {
  id?: string
  tui: TuiPlugin
  server?: never
}
