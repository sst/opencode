export * as Config from "."

import { createBindingLookup } from "@opentui/keymap/extras"
import { Vcs } from "@opencode/schema/vcs"
import { Schema } from "effect"
import { createContext, onCleanup, type JSX, useContext } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { watch } from "fs"
import path from "path"
import { TuiKeybind } from "./keybind"

export interface Interface {
  readonly path?: string
  readonly get: () => Promise<Info>
  readonly update: (update: (draft: any) => void) => Promise<Info>
}

export const AttentionSoundName = Schema.Literals([
  "default",
  "question",
  "permission",
  "error",
  "done",
  "subagent_done",
])
export type AttentionSoundName = Schema.Schema.Type<typeof AttentionSoundName>
export type AttentionSoundPaths = Partial<Record<AttentionSoundName, string>>

export const MiniWorkSpinner = Schema.Literals([
  "block-soft-slide",
  "block-soft-sweep",
  "block-low-comet",
  "block-low-duet",
  "block-shuttle",
  "block-bridge",
  "block-squeeze",
  "small-toggle",
  "square-toggle",
  "grow-shrink",
  "quadrant-orbit",
  "crosshatch",
  "density-wave",
  "seed",
])
export type MiniWorkSpinner = Schema.Schema.Type<typeof MiniWorkSpinner>

export const Plugin = Schema.Union([
  Schema.String,
  Schema.Struct({
    package: Schema.String.annotate({ description: "Plugin package name or path" }),
    options: Schema.optional(Schema.Record(Schema.String, Schema.Any)).annotate({
      description: "Options passed to the plugin",
    }),
  }),
])

export const Cursor = Schema.Struct({
  style: Schema.optional(Schema.Literals(["block", "underline", "line", "default"])).annotate({
    description: "Cursor shape. Use 'default' to preserve the terminal setting",
  }),
  blinking: Schema.optional(Schema.Boolean).annotate({
    description: "Whether the cursor blinks. Has no effect when style is 'default'",
  }),
}).annotate({ description: "Terminal cursor settings" })

export const Info = Schema.Struct({
  theme: Schema.optional(
    Schema.Struct({
      name: Schema.optional(Schema.String).annotate({ description: "Theme name" }),
      mode: Schema.optional(Schema.Literals(["system", "dark", "light"])).annotate({
        description: "Color mode; 'system' follows the terminal",
      }),
    }),
  ).annotate({ description: "Color theme settings" }),
  keybinds: Schema.optional(TuiKeybind.KeybindOverrides).annotate({ description: "Custom key bindings" }),
  plugins: Schema.optional(Schema.Array(Plugin)).annotate({
    description: "Ordered plugin enablement directives and external package declarations",
  }),
  leader: Schema.optional(
    Schema.Struct({
      timeout: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))).annotate({
        description: "Time in milliseconds to wait for a key after the leader key",
      }),
    }),
  ).annotate({ description: "Leader key behavior" }),
  scroll: Schema.optional(
    Schema.Struct({
      speed: Schema.optional(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0.001))).annotate({
        description: "Distance scrolled per input tick",
      }),
      acceleration: Schema.optional(Schema.Boolean).annotate({
        description: "Accelerate scrolling from repeated input",
      }),
    }),
  ).annotate({ description: "Scrolling behavior" }),
  attention: Schema.optional(
    Schema.Struct({
      enabled: Schema.optional(Schema.Boolean).annotate({ description: "Enable attention alerts" }),
      notifications: Schema.optional(Schema.Boolean).annotate({ description: "Show system notifications" }),
      sound: Schema.optional(Schema.Boolean).annotate({ description: "Play attention sounds" }),
      volume: Schema.optional(
        Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(1)),
      ).annotate({ description: "Attention sound volume from 0 to 1" }),
      sound_pack: Schema.optional(Schema.String).annotate({ description: "Active attention sound pack ID" }),
      sounds: Schema.optional(Schema.Record(AttentionSoundName, Schema.optionalKey(Schema.String))).annotate({
        description: "Sound file overrides by attention event",
      }),
    }),
  ).annotate({ description: "System notification and sound settings" }),
  diffs: Schema.optional(
    Schema.Struct({
      source: Schema.optional(Vcs.Mode).annotate({
        description: "Initial diff source; defaults to 'branch' (branch and uncommitted changes)",
      }),
      wrap: Schema.optional(Schema.Literals(["word", "none"])).annotate({
        description: "Line wrapping behavior in diff output",
      }),
      tree: Schema.optional(Schema.Boolean).annotate({ description: "Show the diff file tree" }),
      single: Schema.optional(Schema.Boolean).annotate({ description: "Show only the selected file patch" }),
      view: Schema.optional(Schema.Literals(["auto", "split", "unified"])).annotate({
        description: "Diff layout; 'auto' selects a layout from the available width",
      }),
    }),
  ).annotate({ description: "Diff presentation settings" }),
  terminal: Schema.optional(
    Schema.Struct({
      title: Schema.optional(Schema.Boolean).annotate({ description: "Update the terminal window title" }),
      copy: Schema.optional(Schema.Literals(["manual", "select"])).annotate({
        description: "Copy text manually or immediately after selecting it",
      }),
    }),
  ).annotate({ description: "Terminal integration settings" }),
  prompt: Schema.optional(
    Schema.Struct({
      editor: Schema.optional(Schema.Boolean).annotate({
        description: "Include the active editor file or selection as prompt context",
      }),
      paste: Schema.optional(Schema.Literals(["compact", "full"])).annotate({
        description: "Display large pastes as compact placeholders or full text",
      }),
      image_preview: Schema.optional(Schema.Boolean).annotate({
        description: "Show image attachment previews above the prompt input",
      }),
    }),
  ).annotate({ description: "Prompt input behavior" }),
  session: Schema.optional(
    Schema.Struct({
      sidebar: Schema.optional(Schema.Literals(["auto", "hide"])).annotate({
        description: "Session sidebar visibility; 'auto' shows it when space permits",
      }),
      terminal: Schema.optional(Schema.Boolean).annotate({ description: "Enable persistent session terminal panes" }),
      scrollbar: Schema.optional(Schema.Boolean).annotate({ description: "Show the session transcript scrollbar" }),
      thinking: Schema.optional(Schema.Literals(["show", "hide"])).annotate({
        description: "Show or hide model reasoning by default",
      }),
      grouping: Schema.optional(Schema.Literals(["auto", "none"])).annotate({
        description: "Group related transcript items automatically or render each item separately",
      }),
      image_preview: Schema.optional(Schema.Boolean).annotate({
        description: "Show user attachment and tool-result images in the session transcript",
      }),
      tps: Schema.optional(Schema.Boolean).annotate({
        description: "Show average request throughput (including reasoning) in assistant footers",
      }),
      markdown: Schema.optional(Schema.Literals(["source", "rendered"])).annotate({
        description: "Show Markdown syntax markers or conceal them in rendered transcript content",
      }),
      new_location: Schema.optional(Schema.Literals(["launch", "inherit"])).annotate({
        description: "Start new sessions in the TUI launch directory or inherit the active session location",
      }),
      permissions: Schema.optional(Schema.Literals(["prompt", "autoaccept"])).annotate({
        description: "Prompt for permission requests or accept them automatically",
      }),
    }),
  ).annotate({ description: "Session transcript presentation settings" }),
  tabs: Schema.optional(
    Schema.Struct({
      enabled: Schema.optional(Schema.Boolean).annotate({
        description: "Use a persistent tab strip instead of pinned quick-switch sessions",
      }),
      scope: Schema.optional(Schema.Literals(["global", "cwd"])).annotate({
        description: "Share tabs globally or keep a separate set for each working directory",
      }),
      layout: Schema.optional(Schema.Literals(["horizontal", "vertical"])).annotate({
        description: "Show tabs in a horizontal strip or vertical sidebar",
      }),
      indicators: Schema.optional(Schema.Literals(["status", "numbers"])).annotate({
        description: "Show status icons or always show tab numbers",
      }),
    }),
  ).annotate({ description: "Tab strip settings" }),
  mini: Schema.optional(
    Schema.Struct({
      thinking: Schema.optional(Schema.Literals(["show", "hide"])).annotate({
        description: "Show or hide model reasoning",
      }),
      tools: Schema.optional(Schema.Literals(["show", "hide"])).annotate({
        description: "Show or hide tool calls and the assistant text that precedes them",
      }),
      shell_output: Schema.optional(Schema.Literals(["show", "hide"])).annotate({
        description: "Show or hide raw shell tool output",
      }),
      turn_summary: Schema.optional(Schema.Literals(["show", "hide"])).annotate({
        description: "Show or hide the agent, model, and duration summary in scrollback",
      }),
      footer: Schema.optional(Schema.Literals(["show", "hide"])).annotate({
        description: "Show or hide persistent activity, model, usage, and context details in the footer",
      }),
      splash: Schema.optional(Schema.Literals(["show", "hide"])).annotate({
        description: "Show or hide the entry and exit splash banners",
      }),
      work_spinner: Schema.optional(MiniWorkSpinner).annotate({
        description: "Work spinner animation in the Mini footer (default: block-soft-slide)",
      }),
      mono: Schema.optional(Schema.Boolean).annotate({
        description: "Use monochrome ASCII output",
      }),
      replay: Schema.optional(Schema.Boolean).annotate({
        description: "Restore session history on resume and terminal resize",
      }),
      replay_limit: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))).annotate({
        description: "Maximum number of newest messages restored during replay",
      }),
    }),
  ).annotate({ description: "Mini transcript presentation settings" }),
  debug: Schema.optional(
    Schema.Struct({
      devtools: Schema.optional(Schema.Boolean).annotate({ description: "Show the DevTools debug bar" }),
      timing: Schema.optional(Schema.Boolean).annotate({ description: "Show time-to-first-draw diagnostics" }),
      turn_tokens: Schema.optional(Schema.Union([Schema.Boolean, Schema.Literal("verbose")])).annotate({
        description: "Show per-turn token usage diagnostics, optionally with tool call inputs",
      }),
    }),
  ).annotate({ description: "Debugging settings" }),
  experimental: Schema.optional(Schema.Record(Schema.String, Schema.Boolean)).annotate({
    description: "Experimental features that may change or be removed at any time",
  }),
  animations: Schema.optional(Schema.Boolean).annotate({ description: "Enable interface animations" }),
  mouse: Schema.optional(Schema.Boolean).annotate({ description: "Enable terminal mouse capture" }),
  cursor: Schema.optional(Cursor),
})
export type Info = Schema.Schema.Type<typeof Info>

export type Resolved = Omit<Info, "attention" | "cursor" | "keybinds" | "leader" | "mouse" | "session" | "tabs"> & {
  attention: {
    enabled: boolean
    notifications: boolean
    sound: boolean
    volume: number
    sound_pack: string
    sounds: AttentionSoundPaths
  }
  keybinds: TuiKeybind.BindingLookupView
  leader: { timeout: number }
  mouse: boolean
  cursor?: {
    style: "block" | "underline" | "line" | "default"
    blinking: boolean
  }
  session: Omit<NonNullable<Info["session"]>, "new_location" | "permissions" | "tps"> & {
    new_location: "launch" | "inherit"
    permissions: "prompt" | "autoaccept"
    tps: boolean
  }
  tabs: {
    enabled: boolean
    scope: "global" | "cwd"
    layout: "horizontal" | "vertical"
    indicators: "status" | "numbers"
  }
}

export function resolve(input: Info, options: { terminalSuspend: boolean }): Resolved {
  const keybinds: TuiKeybind.KeybindOverrides = { ...input.keybinds }
  if (!options.terminalSuspend) {
    keybinds["terminal.suspend"] = "none"
    if (keybinds["input.undo"] === undefined) {
      const inputUndo = TuiKeybind.defaultValue("input.undo")
      keybinds["input.undo"] = ["ctrl+z", ...(typeof inputUndo === "string" ? inputUndo.split(",") : [])]
        .filter((value, index, values) => values.indexOf(value) === index)
        .join(",")
    }
  }

  return {
    ...input,
    attention: {
      enabled: input.attention?.enabled ?? false,
      notifications: input.attention?.notifications ?? true,
      sound: input.attention?.sound ?? true,
      volume: input.attention?.volume ?? 0.4,
      sound_pack: input.attention?.sound_pack ?? "opencode.default",
      sounds: input.attention?.sounds ?? {},
    },
    keybinds: createBindingLookup(TuiKeybind.toBindingConfig(TuiKeybind.parse(keybinds)), {
      bindingDefaults: TuiKeybind.bindingDefaults(),
    }),
    leader: { timeout: input.leader?.timeout ?? 2000 },
    mouse: input.mouse ?? true,
    cursor: input.cursor
      ? {
          style: input.cursor.style ?? "block",
          blinking: input.cursor.blinking ?? true,
        }
      : undefined,
    session: {
      ...input.session,
      new_location: input.session?.new_location ?? "launch",
      permissions: input.session?.permissions ?? "prompt",
      // Persistent terminal panes need the opencode-pty daemon, which does not ship Windows binaries.
      terminal: input.session?.terminal ?? process.platform !== "win32",
      tps: input.session?.tps ?? true,
    },
    tabs: {
      ...input.tabs,
      enabled: input.tabs?.enabled ?? true,
      scope: input.tabs?.scope ?? "cwd",
      layout: input.tabs?.layout ?? "horizontal",
      indicators: input.tabs?.indicators ?? "status",
    },
  }
}

const ConfigContext = createContext<{
  data: Resolved
  path?: string
  update: Interface["update"]
}>()

export function ConfigProvider(props: {
  config: Resolved
  service?: Interface
  options?: { terminalSuspend: boolean }
  children: JSX.Element
}) {
  const [config, setConfig] = createStore(props.config)
  const host = props.service
  const apply = (info: Info) => setConfig(reconcile(resolve(info, props.options ?? { terminalSuspend: true })))
  const update = async (update: (draft: any) => void) => {
    if (!host) throw new Error("Config updates are not available")
    const info = await host.update(update)
    apply(info)
    return info
  }
  let reload = Promise.resolve()
  const watcher = host?.path
    ? watch(path.dirname(host.path), () => {
        reload = reload
          .then(() => host.get())
          .then(apply)
          .catch(() => {})
      })
    : undefined
  onCleanup(() => watcher?.close())
  return (
    <ConfigContext.Provider value={{ data: config, path: host?.path, update }}>{props.children}</ConfigContext.Provider>
  )
}

export function useConfig() {
  const value = useContext(ConfigContext)
  if (!value) throw new Error("ConfigProvider is missing")
  return value
}
