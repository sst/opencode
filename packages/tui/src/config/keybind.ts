export * as TuiKeybind from "./keybind"

import type { KeyEvent, Renderable } from "@opentui/core"
import type { Binding } from "@opentui/keymap"
import type { BindingCommandMap, BindingConfig, BindingDefaults } from "@opentui/keymap/extras"
import { Schema } from "effect"

const KeyStroke = Schema.Struct({
  name: Schema.String,
  ctrl: Schema.optional(Schema.Boolean),
  shift: Schema.optional(Schema.Boolean),
  meta: Schema.optional(Schema.Boolean),
  super: Schema.optional(Schema.Boolean),
  hyper: Schema.optional(Schema.Boolean),
})

const BindingObject = Schema.StructWithRest(
  Schema.Struct({
    key: Schema.Union([Schema.String, KeyStroke]),
    event: Schema.optional(Schema.Literals(["press", "release"])),
    preventDefault: Schema.optional(Schema.Boolean),
    fallthrough: Schema.optional(Schema.Boolean),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
)

const BindingItem = Schema.Union([Schema.String, KeyStroke, BindingObject])
export const BindingValueSchema = Schema.Union([
  Schema.Literal(false),
  Schema.Literal("none"),
  BindingItem,
  Schema.Array(BindingItem),
])
export type BindingValueSchema = Schema.Schema.Type<typeof BindingValueSchema>

type Definition = {
  default: BindingValueSchema
  description: string
}

export const LeaderDefault = "ctrl+x"

const keybind = (value: Definition["default"], description: string): Definition => ({ default: value, description })

export const Definitions = {
  leader: keybind(LeaderDefault, "Leader key for keybind combinations"),

  app_exit: keybind("ctrl+c,ctrl+d,<leader>q", "Exit the application"),
  app_debug: keybind("none", "Toggle debug panel"),
  app_console: keybind("none", "Toggle console"),
  app_heap_snapshot: keybind("none", "Write heap snapshot"),
  app_toggle_animations: keybind("none", "Toggle animations"),
  app_toggle_file_context: keybind("none", "Toggle file context"),
  app_toggle_diffwrap: keybind("none", "Toggle diff wrapping"),
  app_toggle_paste_summary: keybind("none", "Toggle paste summary"),
  app_toggle_session_directory_filter: keybind("none", "Toggle session directory filtering"),
  command_list: keybind("ctrl+p", "List available commands"),
  help_show: keybind("none", "Open help dialog"),
  docs_open: keybind("none", "Open documentation"),
  diff_open: keybind("none", "Open diff viewer"),
  diff_close: keybind("escape,q", "Close diff viewer"),
  diff_toggle: keybind("enter,space", "Toggle diff viewer item"),
  diff_expand: keybind("right", "Expand diff viewer item"),
  diff_expand_all: keybind("E", "Expand all diff viewer folders"),
  diff_collapse: keybind("left", "Collapse diff viewer item"),
  diff_switch_focus: keybind("tab", "Switch diff viewer focus"),
  diff_next_hunk: keybind("]", "Jump to next diff hunk"),
  diff_previous_hunk: keybind("[", "Jump to previous diff hunk"),
  diff_next_file: keybind("n", "Jump to next diff file"),
  diff_previous_file: keybind("p", "Jump to previous diff file"),
  diff_toggle_file_tree: keybind("b", "Toggle diff viewer file tree"),
  diff_single_patch: keybind("s", "Toggle single patch view"),
  diff_switch_source: keybind("d", "Switch diff viewer source"),
  diff_toggle_view: keybind("v", "Toggle diff viewer split or unified view"),
  diff_help: keybind("?", "Show more diff viewer shortcuts"),

  editor_open: keybind("<leader>e", "Open external editor"),
  theme_list: keybind("<leader>t", "List available themes"),
  theme_switch_mode: keybind("none", "Switch between light and dark theme mode"),
  theme_mode_lock: keybind("none", "Lock or unlock theme mode"),
  sidebar_toggle: keybind("<leader>b", "Toggle sidebar"),
  scrollbar_toggle: keybind("none", "Toggle session scrollbar"),
  status_view: keybind("<leader>s", "View status"),
  debug_view: keybind("none", "View debug info"),

  session_export: keybind("<leader>x", "Export session to editor"),
  session_copy: keybind("none", "Copy session transcript"),
  session_move: keybind("none", "Move session"),
  session_new: keybind("<leader>n", "Create a new session"),
  session_list: keybind("<leader>l", "List all sessions"),
  session_timeline: keybind("<leader>g", "Show session timeline"),
  session_fork: keybind("none", "Fork session from message"),
  session_rename: keybind("ctrl+r", "Rename session"),
  session_delete: keybind("ctrl+d", "Delete session"),
  session_share: keybind("none", "Share current session"),
  session_unshare: keybind("none", "Unshare current session"),
  session_interrupt: keybind("escape", "Interrupt current session"),
  session_subagent_interrupt: keybind("escape", "Interrupt subagent session"),
  session_background: keybind("ctrl+b", "Background synchronous subagents"),
  session_compact: keybind("<leader>c", "Compact the session"),
  session_toggle_timestamps: keybind("none", "Toggle message timestamps"),
  session_toggle_generic_tool_output: keybind("none", "Toggle generic tool output"),
  session_queued_prompts: keybind("<leader>q", "Manage queued prompts"),
  session_child_first: keybind("<leader>down", "Go to first child session"),
  session_child_cycle: keybind("right", "Go to next child session"),
  session_child_cycle_reverse: keybind("left", "Go to previous child session"),
  session_parent: keybind("up", "Go to parent session"),
  session_pin_toggle: keybind("ctrl+f", "Pin or unpin session in the session list"),
  session_quick_switch_1: keybind("<leader>1", "Switch to session in quick slot 1"),
  session_quick_switch_2: keybind("<leader>2", "Switch to session in quick slot 2"),
  session_quick_switch_3: keybind("<leader>3", "Switch to session in quick slot 3"),
  session_quick_switch_4: keybind("<leader>4", "Switch to session in quick slot 4"),
  session_quick_switch_5: keybind("<leader>5", "Switch to session in quick slot 5"),
  session_quick_switch_6: keybind("<leader>6", "Switch to session in quick slot 6"),
  session_quick_switch_7: keybind("<leader>7", "Switch to session in quick slot 7"),
  session_quick_switch_8: keybind("<leader>8", "Switch to session in quick slot 8"),
  session_quick_switch_9: keybind("<leader>9", "Switch to session in quick slot 9"),

  stash_delete: keybind("ctrl+d", "Delete stash entry"),
  model_provider_list: keybind("ctrl+a", "Open provider list from model dialog"),
  model_favorite_toggle: keybind("ctrl+f", "Toggle model favorite status"),
  model_list: keybind("<leader>m", "List available models"),
  model_cycle_recent: keybind("f2", "Next recently used model"),
  model_cycle_recent_reverse: keybind("shift+f2", "Previous recently used model"),
  model_cycle_favorite: keybind("none", "Next favorite model"),
  model_cycle_favorite_reverse: keybind("none", "Previous favorite model"),
  mcp_list: keybind("none", "List MCP servers"),
  provider_connect: keybind("none", "Connect provider"),
  console_org_switch: keybind("none", "Switch console organization"),
  agent_list: keybind("<leader>a", "List agents"),
  agent_cycle: keybind("tab", "Next agent"),
  agent_cycle_reverse: keybind("shift+tab", "Previous agent"),
  variant_cycle: keybind("ctrl+t", "Cycle model variants"),
  variant_list: keybind("none", "List model variants"),

  messages_page_up: keybind("pageup,ctrl+alt+b", "Scroll messages up by one page"),
  messages_page_down: keybind("pagedown,ctrl+alt+f", "Scroll messages down by one page"),
  messages_line_up: keybind("ctrl+alt+y", "Scroll messages up by one line"),
  messages_line_down: keybind("ctrl+alt+e", "Scroll messages down by one line"),
  messages_half_page_up: keybind("ctrl+alt+u", "Scroll messages up by half page"),
  messages_half_page_down: keybind("ctrl+alt+d", "Scroll messages down by half page"),
  messages_first: keybind("ctrl+g,home", "Navigate to first message"),
  messages_last: keybind("ctrl+alt+g,end", "Navigate to last message"),
  messages_next: keybind("none", "Navigate to next message"),
  messages_previous: keybind("none", "Navigate to previous message"),
  messages_last_user: keybind("none", "Navigate to last user message"),
  messages_copy: keybind("<leader>y", "Copy message"),
  messages_undo: keybind("<leader>u", "Undo message"),
  messages_redo: keybind("<leader>r", "Redo message"),
  messages_toggle_conceal: keybind("<leader>h", "Toggle code block concealment in messages"),
  tool_details: keybind("none", "Toggle tool details visibility"),
  display_thinking: keybind("none", "Toggle thinking blocks visibility"),

  prompt_submit: keybind("none", "Submit prompt"),
  prompt_editor_context_clear: keybind("none", "Clear editor context"),
  prompt_skills: keybind("none", "Open skill selector"),
  prompt_stash: keybind("none", "Stash prompt"),
  prompt_stash_pop: keybind("none", "Pop stashed prompt"),
  prompt_stash_list: keybind("none", "List stashed prompts"),
  workspace_set: keybind("none", "Set workspace"),

  input_clear: keybind("ctrl+c", "Clear input field"),
  input_paste: keybind({ key: "ctrl+v", preventDefault: false }, "Paste from clipboard"),
  input_submit: keybind("return", "Submit input"),
  input_newline: keybind("shift+return,ctrl+return,alt+return,ctrl+j", "Insert newline in input"),
  input_move_left: keybind("left,ctrl+b", "Move cursor left in input"),
  input_move_right: keybind("right,ctrl+f", "Move cursor right in input"),
  input_move_up: keybind("up", "Move cursor up in input"),
  input_move_down: keybind("down", "Move cursor down in input"),
  input_select_left: keybind("shift+left", "Select left in input"),
  input_select_right: keybind("shift+right", "Select right in input"),
  input_select_up: keybind("shift+up", "Select up in input"),
  input_select_down: keybind("shift+down", "Select down in input"),
  input_line_home: keybind("ctrl+a", "Move to start of line in input"),
  input_line_end: keybind("ctrl+e", "Move to end of line in input"),
  input_select_line_home: keybind("ctrl+shift+a", "Select to start of line in input"),
  input_select_line_end: keybind("ctrl+shift+e", "Select to end of line in input"),
  input_visual_line_home: keybind("alt+a", "Move to start of visual line in input"),
  input_visual_line_end: keybind("alt+e", "Move to end of visual line in input"),
  input_select_visual_line_home: keybind("alt+shift+a", "Select to start of visual line in input"),
  input_select_visual_line_end: keybind("alt+shift+e", "Select to end of visual line in input"),
  input_buffer_home: keybind("home", "Move to start of buffer in input"),
  input_buffer_end: keybind("end", "Move to end of buffer in input"),
  input_select_buffer_home: keybind("shift+home", "Select to start of buffer in input"),
  input_select_buffer_end: keybind("shift+end", "Select to end of buffer in input"),
  input_delete_line: keybind("ctrl+shift+d", "Delete line in input"),
  input_delete_to_line_end: keybind("ctrl+k", "Delete to end of line in input"),
  input_delete_to_line_start: keybind("ctrl+u", "Delete to start of line in input"),
  input_backspace: keybind("backspace,shift+backspace", "Backspace in input"),
  input_delete: keybind("ctrl+d,delete,shift+delete", "Delete character in input"),
  input_undo: keybind("ctrl+-,super+z", "Undo in input"),
  input_redo: keybind("ctrl+.,super+shift+z", "Redo in input"),
  input_word_forward: keybind("alt+f,alt+right,ctrl+right", "Move word forward in input"),
  input_word_backward: keybind("alt+b,alt+left,ctrl+left", "Move word backward in input"),
  input_select_word_forward: keybind("alt+shift+f,alt+shift+right", "Select word forward in input"),
  input_select_word_backward: keybind("alt+shift+b,alt+shift+left", "Select word backward in input"),
  input_delete_word_forward: keybind("alt+d,alt+delete,ctrl+delete", "Delete word forward in input"),
  input_delete_word_backward: keybind("ctrl+w,ctrl+backspace,alt+backspace", "Delete word backward in input"),
  input_select_all: keybind("super+a", "Select all in input"),
  history_previous: keybind("up", "Previous history item"),
  history_next: keybind("down", "Next history item"),

  "dialog.select.prev": keybind("up,ctrl+p", "Move to previous dialog item"),
  "dialog.select.next": keybind("down,ctrl+n", "Move to next dialog item"),
  "dialog.select.page_up": keybind("pageup", "Move up one page in dialog"),
  "dialog.select.page_down": keybind("pagedown", "Move down one page in dialog"),
  "dialog.select.home": keybind("home", "Move to first dialog item"),
  "dialog.select.end": keybind("end", "Move to last dialog item"),
  "dialog.select.submit": keybind("return", "Submit selected dialog item"),
  "dialog.prompt.submit": keybind("return", "Submit dialog prompt"),
  "dialog.mcp.toggle": keybind("space", "Toggle MCP in MCP dialog"),
  "dialog.move_session.new": keybind("ctrl+m", "New project copy"),
  "dialog.move_session.delete": keybind("ctrl+d", "Delete project copy"),
  "dialog.move_session.refresh": keybind("ctrl+r", "Refresh project copies"),
  "prompt.autocomplete.prev": keybind("up,ctrl+p", "Move to previous autocomplete item"),
  "prompt.autocomplete.next": keybind("down,ctrl+n", "Move to next autocomplete item"),
  "prompt.autocomplete.hide": keybind("escape", "Hide autocomplete"),
  "prompt.autocomplete.select": keybind("return", "Select autocomplete item"),
  "prompt.autocomplete.complete": keybind("tab", "Complete autocomplete item"),
  "permission.prompt.fullscreen": keybind("ctrl+f", "Toggle permission prompt fullscreen"),
  "plugins.toggle": keybind("space", "Toggle plugin"),
  "dialog.plugins.install": keybind("shift+i", "Install plugin from plugin dialog"),

  terminal_suspend: keybind("ctrl+z", "Suspend terminal"),
  terminal_title_toggle: keybind("none", "Toggle terminal title"),
  tips_toggle: keybind("<leader>h", "Toggle tips on home screen"),
  plugin_manager: keybind("none", "Open plugin manager dialog"),
  plugin_install: keybind("none", "Install plugin"),

  which_key_toggle: keybind("ctrl+alt+k", "Toggle which-key panel"),
  which_key_layout_toggle: keybind("ctrl+alt+shift+k", "Switch which-key layout"),
  which_key_pending_toggle: keybind("ctrl+alt+shift+p", "Toggle which-key pending preview"),
  which_key_group_previous: keybind("ctrl+alt+left,ctrl+alt+[", "Previous which-key group"),
  which_key_group_next: keybind("ctrl+alt+right,ctrl+alt+]", "Next which-key group"),
  which_key_scroll_up: keybind("ctrl+alt+up,ctrl+alt+p", "Scroll which-key up"),
  which_key_scroll_down: keybind("ctrl+alt+down,ctrl+alt+n", "Scroll which-key down"),
  which_key_page_up: keybind("ctrl+alt+pageup", "Page which-key up"),
  which_key_page_down: keybind("ctrl+alt+pagedown", "Page which-key down"),
  which_key_home: keybind("ctrl+alt+home", "Jump to first which-key binding"),
  which_key_end: keybind("ctrl+alt+end", "Jump to last which-key binding"),
} satisfies Record<string, Definition>

type KeybindName = keyof typeof Definitions
const KeybindNames = new Set<string>(Object.keys(Definitions))

export const KeybindOverrides = Schema.Struct(
  Object.fromEntries(
    Object.entries(Definitions).map(([name, item]) => [
      name,
      Schema.optional(BindingValueSchema).annotate({ description: item.description }),
    ]),
  ),
).annotate({ description: "TUI keybinding overrides" })
export const Descriptions = Object.fromEntries(
  Object.entries(Definitions).map(([name, item]) => [name, item.description]),
) as Record<KeybindName, string>
export const CommandMap = {
  app_exit: "app.exit",
  app_debug: "app.debug",
  app_console: "app.console",
  app_heap_snapshot: "app.heap_snapshot",
  app_toggle_animations: "app.toggle.animations",
  app_toggle_file_context: "app.toggle.file_context",
  app_toggle_diffwrap: "app.toggle.diffwrap",
  app_toggle_paste_summary: "app.toggle.paste_summary",
  app_toggle_session_directory_filter: "app.toggle.session_directory_filter",
  command_list: "command.palette.show",
  help_show: "help.show",
  docs_open: "docs.open",
  diff_open: "diff.open",
  diff_close: "diff.close",
  diff_toggle: "diff.toggle",
  diff_expand: "diff.expand",
  diff_expand_all: "diff.expand_all",
  diff_collapse: "diff.collapse",
  diff_switch_focus: "diff.switch_focus",
  diff_next_hunk: "diff.next_hunk",
  diff_previous_hunk: "diff.previous_hunk",
  diff_next_file: "diff.next_file",
  diff_previous_file: "diff.previous_file",
  diff_toggle_file_tree: "diff.toggle_file_tree",
  diff_single_patch: "diff.single_patch",
  diff_switch_source: "diff.switch_source",
  diff_toggle_view: "diff.toggle_view",
  diff_help: "diff.help",
  editor_open: "prompt.editor",
  theme_list: "theme.switch",
  theme_switch_mode: "theme.switch_mode",
  theme_mode_lock: "theme.mode.lock",
  sidebar_toggle: "session.sidebar.toggle",
  scrollbar_toggle: "session.toggle.scrollbar",
  status_view: "opencode.status",
  debug_view: "opencode.debug",
  session_export: "session.export",
  session_copy: "session.copy",
  session_move: "session.move",
  session_new: "session.new",
  session_list: "session.list",
  session_timeline: "session.timeline",
  session_fork: "session.fork",
  session_rename: "session.rename",
  session_delete: "session.delete",
  session_share: "session.share",
  session_unshare: "session.unshare",
  session_interrupt: "session.interrupt",
  session_subagent_interrupt: "session.subagent.interrupt",
  session_background: "session.background",
  session_compact: "session.compact",
  session_toggle_timestamps: "session.toggle.timestamps",
  session_toggle_generic_tool_output: "session.toggle.generic_tool_output",
  session_queued_prompts: "session.queued_prompts",
  session_child_first: "session.child.first",
  session_child_cycle: "session.child.next",
  session_child_cycle_reverse: "session.child.previous",
  session_parent: "session.parent",
  session_pin_toggle: "session.pin.toggle",
  session_quick_switch_1: "session.quick_switch.1",
  session_quick_switch_2: "session.quick_switch.2",
  session_quick_switch_3: "session.quick_switch.3",
  session_quick_switch_4: "session.quick_switch.4",
  session_quick_switch_5: "session.quick_switch.5",
  session_quick_switch_6: "session.quick_switch.6",
  session_quick_switch_7: "session.quick_switch.7",
  session_quick_switch_8: "session.quick_switch.8",
  session_quick_switch_9: "session.quick_switch.9",
  stash_delete: "stash.delete",
  model_provider_list: "model.dialog.provider",
  model_favorite_toggle: "model.dialog.favorite",
  model_list: "model.list",
  model_cycle_recent: "model.cycle_recent",
  model_cycle_recent_reverse: "model.cycle_recent_reverse",
  model_cycle_favorite: "model.cycle_favorite",
  model_cycle_favorite_reverse: "model.cycle_favorite_reverse",
  mcp_list: "mcp.list",
  provider_connect: "provider.connect",
  console_org_switch: "console.org.switch",
  agent_list: "agent.list",
  agent_cycle: "agent.cycle",
  agent_cycle_reverse: "agent.cycle.reverse",
  variant_cycle: "variant.cycle",
  variant_list: "variant.list",
  messages_page_up: "session.page.up",
  messages_page_down: "session.page.down",
  messages_line_up: "session.line.up",
  messages_line_down: "session.line.down",
  messages_half_page_up: "session.half.page.up",
  messages_half_page_down: "session.half.page.down",
  messages_first: "session.first",
  messages_last: "session.last",
  messages_next: "session.message.next",
  messages_previous: "session.message.previous",
  messages_last_user: "session.messages_last_user",
  messages_copy: "messages.copy",
  messages_undo: "session.undo",
  messages_redo: "session.redo",
  messages_toggle_conceal: "session.toggle.conceal",
  tool_details: "session.toggle.actions",
  display_thinking: "session.toggle.thinking",
  prompt_submit: "prompt.submit",
  prompt_editor_context_clear: "prompt.editor_context.clear",
  prompt_skills: "prompt.skills",
  prompt_stash: "prompt.stash",
  prompt_stash_pop: "prompt.stash.pop",
  prompt_stash_list: "prompt.stash.list",
  workspace_set: "workspace.set",
  input_clear: "prompt.clear",
  input_paste: "prompt.paste",
  input_submit: "input.submit",
  input_newline: "input.newline",
  input_move_left: "input.move.left",
  input_move_right: "input.move.right",
  input_move_up: "input.move.up",
  input_move_down: "input.move.down",
  input_select_left: "input.select.left",
  input_select_right: "input.select.right",
  input_select_up: "input.select.up",
  input_select_down: "input.select.down",
  input_line_home: "input.line.home",
  input_line_end: "input.line.end",
  input_select_line_home: "input.select.line.home",
  input_select_line_end: "input.select.line.end",
  input_visual_line_home: "input.visual.line.home",
  input_visual_line_end: "input.visual.line.end",
  input_select_visual_line_home: "input.select.visual.line.home",
  input_select_visual_line_end: "input.select.visual.line.end",
  input_buffer_home: "input.buffer.home",
  input_buffer_end: "input.buffer.end",
  input_select_buffer_home: "input.select.buffer.home",
  input_select_buffer_end: "input.select.buffer.end",
  input_delete_line: "input.delete.line",
  input_delete_to_line_end: "input.delete.to.line.end",
  input_delete_to_line_start: "input.delete.to.line.start",
  input_backspace: "input.backspace",
  input_delete: "input.delete",
  input_undo: "input.undo",
  input_redo: "input.redo",
  input_word_forward: "input.word.forward",
  input_word_backward: "input.word.backward",
  input_select_word_forward: "input.select.word.forward",
  input_select_word_backward: "input.select.word.backward",
  input_delete_word_forward: "input.delete.word.forward",
  input_delete_word_backward: "input.delete.word.backward",
  input_select_all: "input.select.all",
  history_previous: "prompt.history.previous",
  history_next: "prompt.history.next",
  terminal_suspend: "terminal.suspend",
  terminal_title_toggle: "terminal.title.toggle",
  tips_toggle: "tips.toggle",
  plugin_manager: "plugins.list",
  plugin_install: "plugins.install",
  which_key_toggle: "which-key.toggle",
  which_key_layout_toggle: "which-key.layout.toggle",
  which_key_pending_toggle: "which-key.pending.toggle",
  which_key_group_previous: "which-key.group.previous",
  which_key_group_next: "which-key.group.next",
  which_key_scroll_up: "which-key.scroll.up",
  which_key_scroll_down: "which-key.scroll.down",
  which_key_page_up: "which-key.page.up",
  which_key_page_down: "which-key.page.down",
  which_key_home: "which-key.home",
  which_key_end: "which-key.end",
} satisfies BindingCommandMap
const CommandDescriptions = Object.fromEntries(
  Object.entries(Definitions).map(([name, item]) => [
    CommandMap[name as keyof typeof CommandMap] ?? name,
    item.description,
  ]),
) as Record<string, string>

export type Keybinds = { [K in KeybindName]: BindingValueSchema }
export type KeybindOverrides = Partial<Keybinds>
export type BindingLookupView = {
  readonly bindings: readonly Binding<Renderable, KeyEvent>[]
  get(command: string): readonly Binding<Renderable, KeyEvent>[]
  has(command: string): boolean
  gather(name: string, commands: readonly string[]): readonly Binding<Renderable, KeyEvent>[]
  pick(name: string, commands: readonly string[]): Binding<Renderable, KeyEvent>[]
  omit(name: string, commands: readonly string[]): Binding<Renderable, KeyEvent>[]
}

export function toBindingConfig(keybinds: Keybinds): BindingConfig<Renderable, KeyEvent> {
  return Object.fromEntries(Object.entries(keybinds)) as BindingConfig<Renderable, KeyEvent>
}

const decodeBindingValue = Schema.decodeUnknownSync(BindingValueSchema)

export function defaultValue(name: KeybindName) {
  return Definitions[name].default
}

export function parse(keybinds: KeybindOverrides): Keybinds {
  const invalid = unknownKeys(keybinds)
  if (invalid.length) throw new Error(`Unrecognized keybind${invalid.length === 1 ? "" : "s"}: ${invalid.join(", ")}`)
  return Object.fromEntries(
    Object.entries(Definitions).map(([name, item]) => [
      name,
      decodeBindingValue(keybinds[name as KeybindName] ?? item.default),
    ]),
  ) as Keybinds
}

export const Keybinds = { parse }

export function unknownKeys(input: object) {
  return Object.keys(input).filter((key) => !KeybindNames.has(key))
}

export function bindingDefaults(): BindingDefaults<Renderable, KeyEvent> {
  return ({ command, binding }) => {
    if (binding.desc !== undefined) return
    return { desc: CommandDescriptions[command] }
  }
}
