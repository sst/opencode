import type {
  AgentInfo,
  CommandInfo,
  FormCancelInput,
  FormInfo,
  FormReplyInput,
  IntegrationInfo,
  LocationRef,
  McpResource,
  McpServer,
  ModelInfo,
  OpenCodeClient,
  OpenCodeEvent,
  PermissionSavedInfo,
  PermissionRequest,
  Project,
  ProviderInfo,
  ReferenceInfo,
  SessionInfo,
  SessionMessageInfo,
  SessionInboxInfo,
  ShellInfo,
  SkillInfo,
  VcsInfo,
} from "@opencode/client"
import type { ResolvedTheme } from "@opencode/theme/tui"
import type { CliRenderer, KeyEvent, MarkdownCodeBlockRenderer, Renderable } from "@opentui/core"
import type { JSX } from "@opentui/solid"
import type { Store } from "solid-js/store"

export interface Storage {
  /**
   * Durable JSON state: persisted to disk, survives hot reloads and TUI
   * restarts, and stays live-synced across running TUI instances.
   */
  store<Value extends object>(
    key: string,
    options: {
      readonly initial: Value
    },
  ): readonly [Store<Value>, (mutation: (draft: Value) => void) => Promise<void>]
  /**
   * Ephemeral in-memory state: survives plugin hot reloads (old and new
   * generations share the same live store) and is gone when the TUI exits.
   * Updates are synchronous and values need not be JSON-serializable.
   */
  memory<Value extends object>(
    key: string,
    options: {
      readonly initial: Value
    },
  ): readonly [Store<Value>, (mutation: (draft: Value) => void) => void]
}

interface LocationCollection<Value> {
  list(location?: LocationRef): Value[] | undefined
  sync(location?: LocationRef): Promise<void>
  invalidate(location?: LocationRef): void
}

type OpenCodeEventMap = { [Type in OpenCodeEvent["type"]]: Extract<OpenCodeEvent, { type: Type }> }

export interface Data {
  readonly on: <Type extends OpenCodeEvent["type"]>(
    type: Type,
    handler: (event: OpenCodeEventMap[Type]) => void,
  ) => () => void
  readonly listen: (handler: (event: { details: OpenCodeEvent }) => void) => () => void
  readonly session: {
    list(): SessionInfo[]
    get(sessionID: string): SessionInfo | undefined
    root(sessionID: string): string
    family(sessionID: string): string[]
    cost(sessionID: string): number
    status(sessionID: string): "idle" | "running"
    readonly pending: {
      list(sessionID: string): SessionInboxInfo[]
      sync(sessionID: string): Promise<void>
      invalidate(sessionID: string): void
    }
    sync(sessionID: string): Promise<void>
    invalidate(sessionID: string): void
    readonly message: {
      list(sessionID: string): SessionMessageInfo[]
      get(sessionID: string, messageID: string): SessionMessageInfo | undefined
      sync(sessionID: string): Promise<void>
      invalidate(sessionID: string): void
    }
    readonly permission: {
      list(sessionID: string): PermissionRequest[] | undefined
      sync(sessionID: string): Promise<void>
      invalidate(sessionID: string): void
    }
    readonly form: {
      list(sessionID: string, location?: LocationRef): Array<FormInfo & { readonly location?: LocationRef }> | undefined
      sync(sessionID: string, location?: LocationRef): Promise<void>
      invalidate(sessionID: string, location?: LocationRef): void
      reply(input: FormReplyInput, location?: LocationRef): Promise<void>
      cancel(input: FormCancelInput, location?: LocationRef): Promise<void>
    }
  }
  readonly project: {
    list(): Project[]
    get(projectID: string): Project | undefined
    sync(): Promise<void>
    invalidate(): void
    readonly permission: {
      list(projectID: string): PermissionSavedInfo[] | undefined
      sync(projectID: string): Promise<void>
      invalidate(projectID: string): void
    }
  }
  readonly shell: {
    list(location?: LocationRef): ShellInfo[]
    get(id: string): ShellInfo | undefined
    sync(location?: LocationRef): Promise<void>
    invalidate(location?: LocationRef): void
  }
  readonly location: {
    default(): LocationRef
    sync(location?: LocationRef): Promise<void>
    invalidate(location?: LocationRef): void
    readonly vcs: {
      info(location?: LocationRef): VcsInfo | undefined
      sync(location?: LocationRef): Promise<void>
      invalidate(location?: LocationRef): void
    }
    readonly agent: LocationCollection<AgentInfo>
    readonly command: LocationCollection<CommandInfo>
    readonly integration: LocationCollection<IntegrationInfo>
    readonly mcp: {
      readonly server: LocationCollection<McpServer>
      readonly resource: LocationCollection<McpResource>
    }
    readonly model: LocationCollection<ModelInfo>
    readonly provider: LocationCollection<ProviderInfo>
    readonly reference: LocationCollection<ReferenceInfo>
    readonly skill: LocationCollection<SkillInfo>
  }
}

export type Route =
  | { readonly type: "home" }
  | { readonly type: "session"; readonly sessionID: string }
  | {
      readonly type: "plugin"
      readonly id: string
      readonly name: string
      readonly data?: Record<string, any>
    }

export type Destination = Route | Omit<Extract<Route, { readonly type: "plugin" }>, "id">

export interface Page {
  readonly name: string
  readonly render: (input: { readonly data?: Record<string, any> }) => JSX.Element
}

type PromptFooterInput = {
  readonly sessionID?: string
  readonly mode: "normal" | "shell"
  readonly showDetails: boolean
}

export type PanelPresentation = "panel" | "fullscreen"

/** Client-local state of the selected session panel. The host owns its layout and input scope. */
export interface PanelInput {
  /** Selected content name, set by ui.panel.open. Contributions decide whether to render it. */
  readonly name: string
  readonly sessionID: string
  readonly width: number
  readonly presentation: PanelPresentation
  readonly focused: boolean
  readonly focus: () => void
  readonly close: () => void
  readonly toggleFullscreen: () => void
}

/**
 * The host UI's slot tree. Every path is one slot: a named boundary a plugin
 * may render around, inside, or take over. Paths are absolute and
 * dot-separated, and a path contains every path it prefixes — replacing
 * `prompt.footer` owns everything under `prompt.footer.*`.
 *
 * Each slot publishes an input: reactive props passed to every claim render
 * targeting it. Inputs carry only what the SDK cannot answer — instance
 * identity and client-local state. Paths and their inputs are documented
 * API: coarse, few, and kept stable across host refactors.
 */
export interface SlotMap {
  readonly app: Readonly<Record<string, never>>
  readonly "home.footer": Readonly<Record<string, never>>
  readonly "prompt.footer": PromptFooterInput
  readonly "prompt.footer.status": PromptFooterInput
  readonly "prompt.footer.file": PromptFooterInput
  readonly "session.composer.top": { readonly sessionID: string }
  readonly "session.panel": PanelInput
  readonly "sidebar.content": { readonly sessionID: string }
  readonly "sidebar.footer": { readonly sessionID: string }
}
export type SlotPath = keyof SlotMap

/**
 * One contribution to the slot tree. Exactly one placement key names an
 * absolute target path:
 * - `prepend` / `append`: first/last inside the target's boundary
 * - `before` / `after`: siblings adjacent to the target, outside its boundary
 * - `replace`: take over the target. The boundary itself survives — siblings
 *   anchored `before`/`after` it still compose — but the original content and
 *   every claim inside the boundary are suppressed and recorded, never
 *   silently dropped. At the same target the last-enabled claim wins; an
 *   ancestor replacement beats a descendant one regardless of enable order.
 *
 * A claim aimed at a path the host no longer publishes degrades: additive
 * claims append to the nearest surviving ancestor, replacements are
 * suppressed. Several claims at one anchor coexist in plugin enable order.
 *
 * `render` receives the target slot's input, reactively. The `?: never`
 * fields make the variants mutually exclusive: a claim with two placement
 * keys is a type error, not a silent priority pick.
 */
export type SlotClaim<Path extends SlotPath = SlotPath> = Path extends SlotPath
  ? { readonly render: (input: SlotMap[Path]) => JSX.Element } & (
      | {
          readonly prepend: Path
          readonly append?: never
          readonly before?: never
          readonly after?: never
          readonly replace?: never
        }
      | {
          readonly append: Path
          readonly prepend?: never
          readonly before?: never
          readonly after?: never
          readonly replace?: never
        }
      | {
          readonly before: Path
          readonly prepend?: never
          readonly append?: never
          readonly after?: never
          readonly replace?: never
        }
      | {
          readonly after: Path
          readonly prepend?: never
          readonly append?: never
          readonly before?: never
          readonly replace?: never
        }
      | {
          readonly replace: Path
          readonly prepend?: never
          readonly append?: never
          readonly before?: never
          readonly after?: never
        }
    )
  : never

export interface App {
  readonly version: string
  readonly channel: string
}

export type ToastVariant = "info" | "success" | "warning" | "error"

export interface ToastOptions {
  readonly title?: string
  readonly message: string
  readonly variant?: ToastVariant
  readonly duration?: number
}

export interface Toast {
  show(options: ToastOptions): void
}

export type AttentionWhen = "always" | "focused" | "blurred"
export type AttentionSoundName = "default" | "question" | "permission" | "error" | "done" | "subagent_done"

export type AttentionNotification =
  | boolean
  | {
      readonly when?: AttentionWhen
    }

export type AttentionSound =
  | boolean
  | {
      readonly name?: AttentionSoundName
      readonly volume?: number
      readonly when?: AttentionWhen
    }

export interface AttentionNotifyOptions {
  readonly title?: string
  readonly message: string
  readonly notification?: AttentionNotification
  readonly sound?: AttentionSound
}

export type AttentionNotifySkipReason =
  | "attention_disabled"
  | "empty_message"
  | "blurred"
  | "focused"
  | "focus_unknown"
  | "renderer_destroyed"

export interface AttentionNotifyResult {
  readonly ok: boolean
  readonly notification: boolean
  readonly sound: boolean
  readonly skipped?: AttentionNotifySkipReason
}

export interface Attention {
  notify(options: AttentionNotifyOptions): Promise<AttentionNotifyResult>
}

export type DialogSize = "medium" | "large" | "xlarge"

export interface DialogOptions {
  readonly size?: DialogSize
  readonly centered?: boolean
}

export interface DialogAlertOptions {
  readonly title: string
  readonly message: string
}

export interface DialogConfirmOptions {
  readonly title: string
  readonly message: string
  readonly label?: {
    readonly confirm?: string
    readonly cancel?: string
  }
}

export interface DialogPromptOptions {
  readonly title: string
  readonly description?: string
  readonly placeholder?: string
  readonly value?: string
}

export interface DialogSelectOption<Value> {
  readonly title: string
  readonly value: Value
  readonly description?: string
  readonly footer?: string
  readonly category?: string
  readonly disabled?: boolean
}

export interface DialogSelectShortcut {
  readonly title: string
  readonly key: string
  readonly side?: "left" | "right"
}

export interface DialogSelectOptions<Value> {
  readonly title: string
  readonly placeholder?: string
  /** Shortcut hints shown beneath the options. */
  readonly shortcuts?: readonly DialogSelectShortcut[]
  readonly options: readonly DialogSelectOption<Value>[]
  readonly current?: Value
}

export interface Dialog {
  /** Shows a dialog. */
  show(render: () => JSX.Element, onClose?: () => void): void
  /** Sets the active dialog's presentation options. */
  set(options: DialogOptions): void
  /** Closes the active dialog. */
  clear(): void
  alert(options: DialogAlertOptions): Promise<void>
  confirm(options: DialogConfirmOptions): Promise<boolean | undefined>
  prompt(options: DialogPromptOptions): Promise<string | undefined>
  select<Value>(options: DialogSelectOptions<Value>): Promise<Value | undefined>
}

export interface KeymapCommand {
  /** Stable command and config keybind identifier. Omit for an inline command. */
  readonly id?: string
  /** Optional label used by command discovery and keyboard-help UI. */
  readonly title?: string
  /** Optional longer description. */
  readonly description?: string
  /** Groups the command in discovery and keyboard-help UI. */
  readonly group?: string
  /** Enables or disables the command. */
  readonly enabled?: boolean | (() => boolean)
  /** Configures automatic binding, or disables it for a named command. */
  readonly bind?: false | string
  /** Adds a named command to the command palette. */
  readonly palette?: true
  /** Adds a named command to prompt slash completion. */
  readonly slash?: {
    readonly name: string
    readonly aliases?: string[]
    /** Keeps the slash command in the prompt and passes its raw input to run. */
    readonly arguments?: true
  }
  /** Promotes the command in discovery UI. */
  readonly suggested?: boolean | (() => boolean)
  /** Executes the command. Keyboard dispatch includes its event; programmatic dispatch does not. Return false to continue. */
  readonly run: (input?: string, event?: KeyEvent) => void | false | Promise<void>
}

export interface KeymapLayer {
  /** Limits the layer to one OpenCode input mode. Use global to opt out; defaults to base. */
  readonly mode?: string
  /** Enables or disables the complete layer. */
  readonly enabled?: boolean | (() => boolean)
  /** Limits the layer to a focused renderable. */
  readonly target?: () => Renderable | null | undefined
  /** Resolves conflicts with other active layers. */
  readonly priority?: number
  /** Commands owned by this layer. */
  readonly commands?: readonly KeymapCommand[]
  /** IDs of commands whose configured bindings should be active in this layer. */
  readonly bindings?: readonly string[]
}

export interface KeymapPending {
  readonly key: string
  readonly token?: string
}

export interface KeymapActive {
  readonly key: string
  readonly title?: string
  readonly description?: string
  readonly group?: string
  readonly continues: boolean
}

export interface Keymap {
  /** Creates a reactive keymap layer owned by the calling component. */
  layer(input: () => KeymapLayer): void
  /** Dispatches a reachable command by ID. */
  dispatch(id: string, input?: string): void
  /** Returns every formatted shortcut for a registered command. */
  shortcuts(id: string): readonly string[]
  /** Returns the currently reachable commands. Reactive when read in a Solid computation. */
  commands(): readonly KeymapCommand[]
  /** Returns the pending key sequence. Reactive when read in a Solid computation. */
  pending(): readonly KeymapPending[]
  /** Returns bindings reachable from the pending key sequence. Reactive when read in a Solid computation. */
  active(): readonly KeymapActive[]
  /** Controls mutually exclusive OpenCode input modes. */
  readonly mode: {
    /** Returns the active mode. */
    current(): string
    /** Pushes a mode until the returned cleanup is called. */
    push(mode: string): () => void
  }
}

export interface UI {
  readonly dialog: Dialog
  readonly toast: Toast
  readonly format: {
    path(value: string): string
  }
  readonly router: {
    register(page: Page): () => void
    navigate(destination: Destination): void
    current(): Route
  }
  readonly panel: {
    /** Opens the session.panel slot in the current session. */
    open(name: string, options?: { readonly presentation?: PanelPresentation }): boolean
    /** Closes this plugin's active panel. Other plugins' panels are unaffected. */
    close(): void
    /** This plugin's active panel, if any. Reactive when read in a Solid computation. */
    current(): { readonly name: string; readonly sessionID: string } | undefined
  }
  readonly tabs: {
    /** Returns whether session tabs are enabled for this TUI. */
    enabled(): boolean
    /** Returns the currently open root-session tabs. Reactive when read in a Solid computation. */
    list(): readonly {
      readonly sessionID: string
      readonly title?: string
      readonly active: boolean
      readonly busy: boolean
      readonly attention: boolean
      readonly unread?: "activity" | "error"
    }[]
    /** Opens a tab for a session without focusing it. Returns false when tabs are disabled. */
    open(sessionID: string): boolean
    /** Opens a tab when needed, then focuses it. Returns false when tabs are disabled. */
    focus(sessionID: string): boolean
    /** Moves an open tab to an index and returns false when it is not open. */
    move(sessionID: string, index: number): boolean
    /** Closes an open tab, or the active tab when omitted, and returns false when no tab matched. */
    close(sessionID?: string): boolean
  }
  /** Claims a place in the slot tree; see SlotClaim. */
  readonly slot: (claim: SlotClaim) => () => void
}

export interface Context {
  readonly options: Readonly<Record<string, any>>
  readonly location: LocationRef | undefined
  readonly app: App
  readonly renderer: CliRenderer
  readonly client: OpenCodeClient
  readonly data: Data
  readonly attention: Attention
  readonly theme: ResolvedTheme
  readonly themeMode: "dark" | "light"
  readonly markdown: {
    registerCodeBlockRenderer(language: string, render: MarkdownCodeBlockRenderer): () => void
  }
  readonly keymap: Keymap
  readonly storage: Storage
  readonly ui: UI
}
