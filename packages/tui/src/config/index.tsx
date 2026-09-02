export * as TuiConfig from "."

import { createBindingLookup } from "@opentui/keymap/extras"
import { Schema } from "effect"
import { createContext, type JSX, useContext } from "solid-js"
import { TuiKeybind } from "./keybind"

export const AttentionSoundName = Schema.Literals([
  "default",
  "question",
  "permission",
  "error",
  "done",
  "subagent_done",
])
export type AttentionSoundName = Schema.Schema.Type<typeof AttentionSoundName>

export const PluginOptions = Schema.Record(Schema.String, Schema.Unknown)
export const PluginSpec = Schema.Union([Schema.String, Schema.mutable(Schema.Tuple([Schema.String, PluginOptions]))])

export const LeaderTimeoutDefault = 2000
export const SidebarWidthDefault = 42
export const LeaderTimeout = Schema.Int.check(Schema.isGreaterThan(0)).annotate({
  description: "Leader key timeout in milliseconds",
})

export const ScrollSpeed = Schema.Number.check(Schema.isGreaterThanOrEqualTo(0.001))
export const ScrollAcceleration = Schema.Struct({
  enabled: Schema.Boolean.annotate({ description: "Enable scroll acceleration" }),
}).annotate({ description: "Scroll acceleration settings" })
export const DiffStyle = Schema.Literals(["auto", "stacked"]).annotate({
  description: "Control diff rendering style: 'auto' adapts to terminal width, 'stacked' always shows single column",
})
export const Cursor = Schema.Struct({
  style: Schema.optional(Schema.Literals(["block", "underline", "line", "default"])).annotate({
    description: "Cursor shape. Use 'default' to preserve the terminal setting",
  }),
  blinking: Schema.optional(Schema.Boolean).annotate({
    description: "Whether the cursor blinks. Has no effect when style is 'default'",
  }),
}).annotate({ description: "Terminal cursor settings" })

export const AttentionSounds = Schema.Record(AttentionSoundName, Schema.optionalKey(Schema.String))
export type AttentionSoundPaths = Schema.Schema.Type<typeof AttentionSounds>
export const Attention = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean),
  notifications: Schema.optional(Schema.Boolean),
  sound: Schema.optional(Schema.Boolean),
  volume: Schema.optional(Schema.Number.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(1))),
  sound_pack: Schema.optional(Schema.String),
  sounds: Schema.optional(AttentionSounds),
}).annotate({ description: "Attention notification and sound settings" })

const PromptSize = Schema.Int.check(Schema.isGreaterThan(0))
const SidebarWidth = Schema.Int.check(Schema.isGreaterThan(0))
export const Prompt = Schema.Struct({
  max_height: Schema.optional(PromptSize).annotate({ description: "Prompt textarea max height" }),
  max_width: Schema.optional(Schema.Union([PromptSize, Schema.Literal("auto")])).annotate({
    description: "Home prompt max width: a positive integer for a fixed cap, or 'auto' to scale with terminal width",
  }),
}).annotate({ description: "Prompt size settings" })

export const Info = Schema.Struct({
  $schema: Schema.optional(Schema.String),
  theme: Schema.optional(Schema.String),
  keybinds: Schema.optional(TuiKeybind.KeybindOverrides),
  plugin: Schema.optional(Schema.Array(PluginSpec)),
  plugin_enabled: Schema.optional(Schema.Record(Schema.String, Schema.Boolean)),
  leader_timeout: Schema.optional(LeaderTimeout),
  attention: Schema.optional(Attention),
  prompt: Schema.optional(Prompt),
  scroll_speed: Schema.optional(ScrollSpeed).annotate({ description: "TUI scroll speed" }),
  scroll_acceleration: Schema.optional(ScrollAcceleration),
  diff_style: Schema.optional(DiffStyle),
  cursor: Schema.optional(Cursor),
  mouse: Schema.optional(Schema.Boolean).annotate({ description: "Enable or disable mouse capture (default: true)" }),
  sidebar: Schema.optional(Schema.Literals(["auto", "collapsed", "hide"])).annotate({
    description: "Sidebar visibility mode",
  }),
  sidebar_width: Schema.optional(SidebarWidth).annotate({ description: "Sidebar width in columns (default: 42)" }),
})
export type Info = Schema.Schema.Type<typeof Info>

export type Resolved = Omit<Info, "attention" | "keybinds" | "leader_timeout" | "mouse" | "cursor" | "sidebar_width"> & {
  attention: {
    enabled: boolean
    notifications: boolean
    sound: boolean
    volume: number
    sound_pack: string
    sounds: AttentionSoundPaths
  }
  keybinds: TuiKeybind.BindingLookupView
  leader_timeout: number
  mouse: boolean
  sidebar_width: number
  cursor?: {
    style: "block" | "underline" | "line" | "default"
    blinking: boolean
  }
}

export const ResolveOptions = Schema.Struct({
  terminalSuspend: Schema.Boolean,
})
export type ResolveOptions = Schema.Schema.Type<typeof ResolveOptions>

export function resolve(input: Info, options: ResolveOptions): Resolved {
  const keybinds: TuiKeybind.KeybindOverrides = { ...input.keybinds }
  if (!options.terminalSuspend) {
    keybinds.terminal_suspend = "none"
    if (keybinds.input_undo === undefined) {
      const inputUndo = TuiKeybind.defaultValue("input_undo")
      keybinds.input_undo = ["ctrl+z", ...(typeof inputUndo === "string" ? inputUndo.split(",") : [])]
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
      commandMap: TuiKeybind.CommandMap,
      bindingDefaults: TuiKeybind.bindingDefaults(),
    }),
    leader_timeout: input.leader_timeout ?? LeaderTimeoutDefault,
    mouse: input.mouse ?? true,
    sidebar_width: input.sidebar_width ?? SidebarWidthDefault,
    cursor: input.cursor
      ? {
          style: input.cursor.style ?? "block",
          blinking: input.cursor.blinking ?? true,
        }
      : undefined,
  }
}

const ConfigContext = createContext<Resolved>()

export function TuiConfigProvider(props: { config: Resolved; children: JSX.Element }) {
  return <ConfigContext.Provider value={props.config}>{props.children}</ConfigContext.Provider>
}

export function useTuiConfig() {
  const value = useContext(ConfigContext)
  if (!value) throw new Error("TuiConfigProvider is missing")
  return value
}
