export * as TuiKeybind from "./keybind"

import type { KeyEvent, Renderable } from "@opentui/core"
import type { Binding } from "@opentui/keymap"
import type { BindingConfig, BindingDefaults } from "@opentui/keymap/extras"
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
]).annotate({ identifier: "TuiKeybind.BindingValue" })
export type BindingValueSchema = Schema.Schema.Type<typeof BindingValueSchema>

type Definition = {
  default: BindingValueSchema
  description: string
}

export const LeaderDefault = "ctrl+x"

const keybind = (value: Definition["default"], description: string): Definition => ({ default: value, description })

export const Definitions = {
  leader: keybind(LeaderDefault, "Leader key for keybind combinations"),

  "app.exit": keybind("ctrl+c,ctrl+d,<leader>q", "Exit the application"),
  "app.clear": keybind("ctrl+l", "Clear the screen in mini"),
  "app.debug": keybind("none", "Toggle debug panel"),
  "app.console": keybind("none", "Toggle console"),
  "app.scrap": keybind("none", "Open scrap screen"),
  "app.toggle.animations": keybind("none", "Toggle animations"),
  "app.toggle.file_context": keybind("none", "Toggle file context"),
  "app.toggle.diffwrap": keybind("none", "Toggle diff wrapping"),
  "app.toggle.paste_summary": keybind("none", "Toggle paste summary"),
  "command.palette.show": keybind("ctrl+p", "List available commands"),
  "help.show": keybind("none", "Open help dialog"),
  "docs.open": keybind("none", "Open documentation"),
  "opencode.settings": keybind("none", "Open settings"),
  "server.pair": keybind("none", "Pair device"),
  "service.restart": keybind("none", "Restart service"),
  "diff.open": keybind("none", "Open diff viewer"),
  "diff.close": keybind("escape,q", "Close diff viewer"),
  "diff.down": keybind("j,down", "Move diff viewer down"),
  "diff.up": keybind("k,up", "Move diff viewer up"),
  "diff.page.down": keybind("pagedown,ctrl+f", "Page diff viewer down"),
  "diff.page.up": keybind("pageup,ctrl+b", "Page diff viewer up"),
  "diff.half_page.down": keybind("ctrl+d", "Scroll diff viewer down half a page"),
  "diff.half_page.up": keybind("ctrl+u", "Scroll diff viewer up half a page"),
  "diff.first": keybind("gg,home", "Go to the start of the diff"),
  "diff.last": keybind("shift+g,end", "Go to the end of the diff"),
  // Retain shipped configuration names without registering the removed tree navigation commands.
  "diff.toggle": keybind("none", "Deprecated: file tree is mouse-controlled"),
  "diff.expand": keybind("none", "Deprecated: file tree is mouse-controlled"),
  "diff.expand_all": keybind("none", "Deprecated: file tree is mouse-controlled"),
  "diff.collapse": keybind("none", "Deprecated: file tree is mouse-controlled"),
  "diff.switch_focus": keybind("none", "Deprecated: keyboard navigation always controls the diff"),
  "diff.next_hunk": keybind("]", "Jump to next diff hunk"),
  "diff.previous_hunk": keybind("[", "Jump to previous diff hunk"),
  "diff.next_file": keybind("n,alt+down", "Jump to next diff file"),
  "diff.previous_file": keybind("p,alt+up", "Jump to previous diff file"),
  "diff.toggle_file_tree": keybind("b", "Toggle diff viewer file tree"),
  "diff.single_patch": keybind("s", "Toggle single patch view"),
  "diff.switch_source": keybind("d", "Switch diff viewer source"),
  "diff.toggle_view": keybind("v", "Toggle diff viewer split or unified view"),
  "diff.mark_reviewed": keybind("m", "Toggle selected diff file reviewed"),
  "diff.help": keybind("?,shift+?,shift+/", "Show more diff viewer shortcuts"),

  "prompt.editor": keybind("<leader>e", "Open external editor"),
  "theme.switch": keybind("none", "List available themes"),
  "theme.switch_mode": keybind("none", "Switch between light and dark theme mode"),
  "theme.mode.lock": keybind("none", "Lock or unlock theme mode"),
  "session.sidebar.toggle": keybind("<leader>b", "Toggle sidebar"),
  "pane.focus.left": keybind("<leader>left", "Focus session pane"),
  "pane.focus.right": keybind("<leader>right", "Focus right pane"),
  "terminal.select": keybind("<leader>down", "Select terminal"),
  "terminal.toggle": keybind("<leader>t", "Toggle terminal pane"),
  "terminal.close": keybind("<leader>up", "Close terminal pane"),
  "session.toggle.scrollbar": keybind("none", "Toggle session scrollbar"),
  "opencode.status": keybind("<leader>s", "View status"),
  "opencode.debug": keybind("none", "View debug info"),

  "session.export": keybind("<leader>x", "Export session to editor"),
  "session.copy": keybind("none", "Copy session transcript"),
  "session.copy.id": keybind("none", "Copy session ID"),
  "session.move": keybind("none", "Manage workspaces"),
  "session.new": keybind("<leader>n", "Create a new session"),
  "session.list": keybind("<leader>l", "List all sessions"),
  "open.menu": keybind("ctrl+o", "Open recent sessions and projects"),
  "session.tab.next": keybind("ctrl+tab,alt+down", "Switch to next open session tab"),
  "session.tab.previous": keybind("ctrl+shift+tab,alt+up", "Switch to previous open session tab"),
  "session.tab.history.back": keybind("none", "Go back in session tab history"),
  "session.tab.history.forward": keybind("ctrl+i", "Go forward in session tab history"),
  "session.tab.next_unread": keybind("alt+shift+down", "Switch to next unread session tab"),
  "session.tab.previous_unread": keybind("alt+shift+up", "Switch to previous unread session tab"),
  "session.tab.close": keybind("<leader>w", "Close current session tab"),
  "session.tab.reopen": keybind("ctrl+shift+t", "Reopen last closed session tab"),
  "session.timeline": keybind("<leader>g", "Show session timeline"),
  "session.fork": keybind("none", "Fork session from message"),
  "session.rename": keybind("ctrl+r", "Rename session"),
  "session.delete": keybind("ctrl+d", "Delete session"),
  "session.share": keybind("none", "Share current session"),
  "session.unshare": keybind("none", "Unshare current session"),
  "session.interrupt": keybind("escape", "Interrupt current session"),
  "session.background": keybind("ctrl+b", "Background blocking session tools"),
  "session.compact": keybind("<leader>c", "Compact the session"),
  "session.cd": keybind("none", "Change working directory"),
  "session.queued_prompts": keybind("<leader>q", "Manage queued prompts"),
  "queued_prompt.delete": keybind("ctrl+d", "Delete queued prompt"),
  "session.toggle.exploration_grouping": keybind("none", "Toggle related tool call grouping"),
  "session.child.first": keybind("down", "Toggle subagent picker"),
  "session.child.next": keybind("right", "Go to next child session"),
  "session.child.previous": keybind("left", "Go to previous child session"),
  "session.parent": keybind("up", "Go to parent session"),
  "session.pin.toggle": keybind("ctrl+f", "Pin or unpin session in the session list"),
  "session.quick_switch.1": keybind("<leader>1", "Switch to session in quick slot 1"),
  "session.quick_switch.2": keybind("<leader>2", "Switch to session in quick slot 2"),
  "session.quick_switch.3": keybind("<leader>3", "Switch to session in quick slot 3"),
  "session.quick_switch.4": keybind("<leader>4", "Switch to session in quick slot 4"),
  "session.quick_switch.5": keybind("<leader>5", "Switch to session in quick slot 5"),
  "session.quick_switch.6": keybind("<leader>6", "Switch to session in quick slot 6"),
  "session.quick_switch.7": keybind("<leader>7", "Switch to session in quick slot 7"),
  "session.quick_switch.8": keybind("<leader>8", "Switch to session in quick slot 8"),
  "session.quick_switch.9": keybind("<leader>9", "Switch to session in quick slot 9"),
  "session.tab.select.1": keybind("<leader>1,ctrl+1", "Switch to session tab 1"),
  "session.tab.select.2": keybind("<leader>2,ctrl+2", "Switch to session tab 2"),
  "session.tab.select.3": keybind("<leader>3,ctrl+3", "Switch to session tab 3"),
  "session.tab.select.4": keybind("<leader>4,ctrl+4", "Switch to session tab 4"),
  "session.tab.select.5": keybind("<leader>5,ctrl+5", "Switch to session tab 5"),
  "session.tab.select.6": keybind("<leader>6,ctrl+6", "Switch to session tab 6"),
  "session.tab.select.7": keybind("<leader>7,ctrl+7", "Switch to session tab 7"),
  "session.tab.select.8": keybind("<leader>8,ctrl+8", "Switch to session tab 8"),
  "session.tab.select.9": keybind("<leader>9,ctrl+9", "Switch to session tab 9"),
  "session.tab.select.10": keybind("<leader>0,ctrl+0", "Switch to session tab 10"),

  "stash.delete": keybind("ctrl+d", "Delete stash entry"),
  "model.dialog.provider": keybind("ctrl+a", "Open provider list from model dialog"),
  "model.dialog.favorite": keybind("ctrl+f", "Toggle model favorite status"),
  "model.list": keybind("<leader>m", "List available models"),
  "model.cycle_recent": keybind("f2", "Next recently used model"),
  "model.cycle_recent_reverse": keybind("shift+f2", "Previous recently used model"),
  "model.cycle_favorite": keybind("none", "Next favorite model"),
  "model.cycle_favorite_reverse": keybind("none", "Previous favorite model"),
  "mcp.list": keybind("none", "List MCP servers"),
  "provider.connect": keybind("none", "Connect integration"),
  "agent.list": keybind("<leader>a", "List agents"),
  "agent.cycle": keybind("shift+tab", "Next agent"),
  "agent.cycle.reverse": keybind("none", "Previous agent"),
  "variant.cycle": keybind("ctrl+t", "Cycle model variants"),
  "variant.list": keybind("none", "List model variants"),

  "session.page.up": keybind("pageup,ctrl+alt+b", "Scroll messages up by one page"),
  "session.page.down": keybind("pagedown,ctrl+alt+f", "Scroll messages down by one page"),
  "session.line.up": keybind("ctrl+alt+y", "Scroll messages up by one line"),
  "session.line.down": keybind("ctrl+alt+e", "Scroll messages down by one line"),
  "session.half.page.up": keybind("ctrl+alt+u", "Scroll messages up by half page"),
  "session.half.page.down": keybind("ctrl+alt+d", "Scroll messages down by half page"),
  "session.first": keybind("ctrl+g,home,alt+home", "Navigate to first message"),
  "session.last": keybind("ctrl+alt+g,end", "Navigate to last message"),
  "session.message.next": keybind("none", "Navigate to next message"),
  "session.message.previous": keybind("none", "Navigate to previous message"),
  "session.message.user.next": keybind("none", "Navigate to next user message"),
  "session.message.user.previous": keybind("none", "Navigate to previous user message"),
  "session.messages_last_user": keybind("alt+end", "Navigate to last user message"),
  "messages.copy": keybind("<leader>y", "Copy message"),
  "session.undo": keybind("<leader>u", "Undo message"),
  "session.redo": keybind("<leader>r", "Redo message"),
  "session.toggle.thinking": keybind("none", "Toggle thinking blocks visibility"),

  "prompt.submit": keybind("none", "Submit prompt"),
  "prompt.break": keybind("none", "Interrupt with prompt"),
  "prompt.queue": keybind("<leader>return", "Queue prompt"),
  "prompt.editor_context.clear": keybind("none", "Clear editor context"),
  "prompt.images.view": keybind("<leader>i", "View image attachments"),
  "prompt.skills": keybind("none", "Open skill selector"),
  "prompt.stash": keybind("none", "Stash prompt"),
  "prompt.stash.pop": keybind("none", "Pop stashed prompt"),
  "prompt.stash.list": keybind("none", "List stashed prompts"),

  "prompt.clear": keybind("ctrl+c", "Clear input field"),
  "prompt.paste": keybind({ key: "ctrl+v", preventDefault: false }, "Paste from clipboard"),
  "input.submit": keybind("return", "Submit input"),
  "input.newline": keybind("shift+return,ctrl+return,alt+return,ctrl+j", "Insert newline in input"),
  "input.move.left": keybind("left,ctrl+b", "Move cursor left in input"),
  "input.move.right": keybind("right,ctrl+f", "Move cursor right in input"),
  "input.move.up": keybind("up", "Move cursor up in input"),
  "input.move.down": keybind("down", "Move cursor down in input"),
  "input.select.left": keybind("shift+left", "Select left in input"),
  "input.select.right": keybind("shift+right", "Select right in input"),
  "input.select.up": keybind("shift+up", "Select up in input"),
  "input.select.down": keybind("shift+down", "Select down in input"),
  "input.line.home": keybind("ctrl+a", "Move to start of line in input"),
  "input.line.end": keybind("ctrl+e", "Move to end of line in input"),
  "input.select.line.home": keybind("ctrl+shift+a", "Select to start of line in input"),
  "input.select.line.end": keybind("ctrl+shift+e", "Select to end of line in input"),
  "input.visual.line.home": keybind("alt+a", "Move to start of visual line in input"),
  "input.visual.line.end": keybind("alt+e", "Move to end of visual line in input"),
  "input.select.visual.line.home": keybind("alt+shift+a", "Select to start of visual line in input"),
  "input.select.visual.line.end": keybind("alt+shift+e", "Select to end of visual line in input"),
  "input.buffer.home": keybind("none", "Move to start of buffer in input"),
  "input.buffer.end": keybind("none", "Move to end of buffer in input"),
  "input.select.buffer.home": keybind("shift+home", "Select to start of buffer in input"),
  "input.select.buffer.end": keybind("shift+end", "Select to end of buffer in input"),
  "input.delete.line": keybind("ctrl+shift+d", "Delete line in input"),
  "input.delete.to.line.end": keybind("ctrl+k", "Delete to end of line in input"),
  "input.delete.to.line.start": keybind("ctrl+u", "Delete to start of line in input"),
  "input.backspace": keybind("backspace,shift+backspace", "Backspace in input"),
  "input.delete": keybind("ctrl+d,delete,shift+delete", "Delete character in input"),
  "input.undo": keybind("ctrl+-,super+z", "Undo in input"),
  "input.redo": keybind("ctrl+.,super+shift+z", "Redo in input"),
  "input.word.forward": keybind("alt+f,alt+right,ctrl+right", "Move word forward in input"),
  "input.word.backward": keybind("alt+b,alt+left,ctrl+left", "Move word backward in input"),
  "input.select.word.forward": keybind("alt+shift+f,alt+shift+right", "Select word forward in input"),
  "input.select.word.backward": keybind("alt+shift+b,alt+shift+left", "Select word backward in input"),
  "input.delete.word.forward": keybind("alt+d,alt+delete,ctrl+delete", "Delete word forward in input"),
  "input.delete.word.backward": keybind("ctrl+w,ctrl+backspace,alt+backspace", "Delete word backward in input"),
  "input.select.all": keybind("super+a", "Select all in input"),
  "prompt.history.previous": keybind("up", "Previous history item"),
  "prompt.history.next": keybind("down", "Next history item"),

  "composer.subagent.up": keybind("up", "Previous subagent"),
  "composer.subagent.down": keybind("down", "Next subagent"),
  "composer.subagent.select": keybind("return", "Navigate to subagent"),
  "composer.subagent.interrupt": keybind("ctrl+d", "Interrupt subagent"),
  "composer.shell.up": keybind("up", "Previous shell"),
  "composer.shell.down": keybind("down", "Next shell"),
  "composer.shell.select": keybind("return", "View shell output"),
  "composer.shell.kill": keybind("ctrl+d", "Kill shell command"),
  "composer.terminal.up": keybind("up,k", "Previous terminal"),
  "composer.terminal.down": keybind("down,j", "Next terminal"),
  "composer.terminal.select": keybind("return", "Select terminal"),

  "dialog.select.prev": keybind("up,ctrl+p", "Move to previous dialog item"),
  "dialog.select.next": keybind("down,ctrl+n", "Move to next dialog item"),
  "dialog.select.page_up": keybind("pageup", "Move up one page in dialog"),
  "dialog.select.page_down": keybind("pagedown", "Move down one page in dialog"),
  "dialog.select.home": keybind("home", "Move to first dialog item"),
  "dialog.select.end": keybind("end", "Move to last dialog item"),
  "dialog.select.submit": keybind("return", "Submit selected dialog item"),
  "dialog.prompt.submit": keybind("return", "Submit dialog prompt"),
  "dialog.integration.rename": keybind("ctrl+r", "Rename integration account"),
  "dialog.integration.delete": keybind("ctrl+d", "Delete integration account"),
  "dialog.worktree.generate": keybind("tab", "Generate worktree name"),
  "dialog.move_session.new": keybind("ctrl+a", "New worktree"),
  "dialog.move_session.move": keybind("ctrl+m", "Move session to worktree"),
  "dialog.move_session.delete": keybind("ctrl+d", "Delete worktree"),
  "dialog.move_session.refresh": keybind("ctrl+r", "Refresh worktrees"),
  "prompt.autocomplete.prev": keybind("up,ctrl+p", "Move to previous autocomplete item"),
  "prompt.autocomplete.next": keybind("down,ctrl+n", "Move to next autocomplete item"),
  "prompt.autocomplete.hide": keybind("escape", "Hide autocomplete"),
  "prompt.autocomplete.select": keybind("return", "Select autocomplete item"),
  "prompt.autocomplete.complete": keybind("tab", "Complete autocomplete item"),
  "permission.prompt.fullscreen": keybind("ctrl+f", "Toggle permission prompt fullscreen"),
  "plugins.toggle": keybind("return", "Toggle plugin"),
  "dialog.mcp.toggle": keybind("space", "Toggle MCP server"),
  "dialog.plugins.error": keybind("space", "View plugin error"),
  "dialog.plugins.install": keybind("shift+i", "Install plugin from plugin dialog"),
  "dialog.plugins.update": keybind("ctrl+u", "Update plugin from plugin dialog"),
  "dialog.plugins.check": keybind("ctrl+r", "Check for plugin updates from plugin dialog"),

  "terminal.suspend": keybind("ctrl+z", "Suspend terminal"),
  "terminal.title.toggle": keybind("none", "Toggle terminal title"),
  "plugins.list": keybind("none", "Open plugin manager dialog"),
  "plugins.install": keybind("none", "Install plugin"),

  "which-key.toggle": keybind("ctrl+alt+k", "Toggle which-key panel"),
  "which-key.layout.toggle": keybind("ctrl+alt+shift+k", "Switch which-key layout"),
  "which-key.pending.toggle": keybind("ctrl+alt+shift+p", "Toggle which-key pending preview"),
  "which-key.group.previous": keybind("ctrl+alt+left,ctrl+alt+[", "Previous which-key group"),
  "which-key.group.next": keybind("ctrl+alt+right,ctrl+alt+]", "Next which-key group"),
  "which-key.scroll.up": keybind("ctrl+alt+up,ctrl+alt+p", "Scroll which-key up"),
  "which-key.scroll.down": keybind("ctrl+alt+down,ctrl+alt+n", "Scroll which-key down"),
  "which-key.page.up": keybind("ctrl+alt+pageup", "Page which-key up"),
  "which-key.page.down": keybind("ctrl+alt+pagedown", "Page which-key down"),
  "which-key.home": keybind("ctrl+alt+home", "Jump to first which-key binding"),
  "which-key.end": keybind("ctrl+alt+end", "Jump to last which-key binding"),
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
    return { desc: Descriptions[command as KeybindName] }
  }
}
