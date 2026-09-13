import { createEffect, type Accessor } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { useFilteredList } from "@opencode/ui/hooks"
import { createComposerAttachments, type ComposerAttachmentConfig } from "../attachments/attachments"
import { createComposerEditorActions, type ComposerStateStoreInput } from "./actions"
import type {
  ComposerAttachment,
  ComposerComment,
  ComposerHistory,
  ComposerHistoryEntry,
  ComposerOption,
  ComposerPersistedState,
  ComposerSuggestion,
} from "../types"
import {
  createComposerInteractionState,
  transitionComposer,
  type ComposerInteractionCommand,
  type ComposerInteractionEvent,
} from "../suggestions/machine"
import { clonePrompt, promptLength } from "../prompt-parts"
import type { ComposerQueue } from "../adapter"

export type ComposerSelectControl = {
  options: Accessor<ComposerOption[]>
  current: Accessor<string>
  onSelect: (id: string) => void
  keybind?: Accessor<string[]>
}

export type ComposerEditorView = {
  draftOnly?: boolean
  placeholder?: Accessor<string>
  add?: {
    onAttach: () => void
  }
  agent?: ComposerSelectControl
  variant?: ComposerSelectControl
  submit: {
    available?: Accessor<boolean>
    stopping: Accessor<boolean>
    working?: Accessor<boolean>
    queue?: ComposerQueue
    onSubmit: (options?: { alternate?: boolean; interrupt?: boolean }) => void
    onStop: () => void
  }
  shell?: {
    onOpen: () => void
    onClose: () => void
  }
}

export function createComposerEditorState(mode: "normal" | "shell" = "normal") {
  return createStore({ ...createComposerInteractionState(), mode })
}

export function createComposerEditor(input: {
  store: ComposerStateStoreInput
  state?: ReturnType<typeof createComposerEditorState>
  history?: ComposerHistory
  commands: Accessor<ComposerSuggestion[]>
  context: Accessor<ComposerSuggestion[]>
  searchContextFiles: (query: string) => ComposerSuggestion[] | Promise<ComposerSuggestion[]>
  openAttachment?: (attachment: ComposerAttachment) => void
  openContext?: (key: string) => void
  onContextRemove?: (item: ComposerComment) => void
  onEditor?: (element: HTMLElement) => void
  onSuggestionSelect?: (item: ComposerSuggestion) => (() => void) | void
  view: ComposerEditorView
  attachments?: ComposerAttachmentConfig
}) {
  let editor: HTMLElement | undefined
  let fileInput: HTMLInputElement | undefined
  const draft = createComposerEditorActions(input.store)
  const [state, setState] = input.state ?? createComposerEditorState(draft.state.mode)
  function addPart(part: ComposerPersistedState["prompt"][number]) {
    if (part.type === "image") return false
    if (part.type === "file" || part.type === "agent") {
      draft.addMention(part)
      return true
    }
    draft.addText(part.content)
    return true
  }
  const attachments = input.attachments
    ? createComposerAttachments({
        ...input.attachments,
        capture: () => ({
          current: () => draft.state.prompt,
          cursor: () => draft.state.cursor,
          set: (prompt, cursor) => draft.setPrompt(prompt, cursor),
        }),
        editor: () => editor,
        focusEditor: () => editor?.focus(),
        addPart,
        setDraggingType: (type) => dispatch({ type: type ? "drag.enter" : "drag.leave" }),
      })
    : undefined
  const attach = () => {
    if (!attachments) {
      input.view.add?.onAttach()
      return
    }
    attachments.pick(() => fileInput?.click())
  }
  const contextList = useFilteredList<ComposerSuggestion>({
    items: async (query) => {
      const fixed = input.context().filter((item) => item.kind !== "file")
      const recent = input.context().filter((item) => item.kind === "file" && item.recent)
      if (!query.trim()) return [...fixed, ...recent]
      const seen = new Set(recent.map((item) => item.id))
      const files = (await input.searchContextFiles(query)).filter((item) => !seen.has(item.id))
      return [...fixed, ...recent, ...files]
    },
    key: (item) => item.id,
    filterKeys: ["label"],
    skipFilter: (item) => item.kind === "file" && !item.recent,
    groupBy: (item) => {
      if (item.kind === "reference") return "reference"
      if (item.kind === "skill") return "skill"
      if (item.kind === "agent") return "agent"
      if (item.kind === "resource") return "resource"
      if (item.recent) return "recent"
      return "file"
    },
    sortGroupsBy: (a, b) => {
      const order = ["reference", "skill", "agent", "resource", "recent", "file"]
      return order.indexOf(a.category) - order.indexOf(b.category)
    },
  })
  const commandList = useFilteredList<ComposerSuggestion>({
    items: () => input.commands(),
    key: (item) => item.id,
    filterKeys: ["trigger", "title"],
  })
  const list = () => (state.popover.type === "context" ? contextList : commandList)
  const suggestions = () => list().flat()

  const execute = (command: ComposerInteractionCommand) => {
    if (command.type === "draft.setText") {
      draft.setText(command.value)
      return
    }
    if (command.type === "draft.addText") {
      draft.addText(command.value)
      return
    }
    if (command.type === "mention.add") {
      if (command.item.mention) draft.addMention(command.item.mention, command.range)
      return
    }
    if (command.type === "popover.filter") {
      ;(command.popover === "command" ? commandList : contextList).onInput(command.query)
      return
    }
    if (command.type === "suggestion.select") {
      const item = suggestions().find((entry) => entry.id === command.id)
      if (item) dispatch({ type: "popover.select", item })
      return
    }
    if (command.type === "focus.editor") requestAnimationFrame(() => editor?.focus())
  }

  function dispatch(event: ComposerInteractionEvent) {
    const mode = state.mode
    const result = transitionComposer(state, event, draft.state)
    const action = event.type === "popover.select" ? input.onSuggestionSelect?.(event.item) : undefined
    if (event.type === "popover.select") {
      if (!action || state.popover.type !== "command-menu") result.commands.forEach(execute)
      if (action && event.item.kind === "command" && state.popover.type !== "command-menu") {
        draft.setPrompt(
          draft.state.prompt.filter((part): part is ComposerAttachment => part.type === "image"),
          0,
        )
      }
    }
    setState(reconcile(result.state))
    if (mode !== result.state.mode) draft.setMode(result.state.mode)
    if (event.type !== "popover.select") result.commands.forEach(execute)
    if (mode !== result.state.mode) {
      if (result.state.mode === "shell") input.view.shell?.onOpen()
      if (result.state.mode === "normal") input.view.shell?.onClose()
    }
    if (event.type === "popover.select") {
      if (!action) return result.handled
      action()
    }
    return result.handled
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (
      state.mode === "normal" &&
      (event.metaKey || event.ctrlKey) &&
      !event.altKey &&
      !event.shiftKey &&
      event.key.toLowerCase() === "u"
    ) {
      event.preventDefault()
      attach()
      return true
    }
    const handled = dispatch({
      type: "key.down",
      key: event.key,
      ctrl: event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey,
      composing: event.isComposing,
      ids: suggestions().map((item) => item.id),
      empty: draft.state.prompt.every((part) => !("content" in part) || part.content.length === 0),
    })
    if (handled) event.preventDefault()
    if (handled && event.key !== "Enter" && event.key !== "Tab" && state.popover.type !== "closed") {
      const activeID = state.popover.activeID ?? ""
      requestAnimationFrame(() =>
        document.querySelector(`[data-suggestion-id="${CSS.escape(activeID)}"]`)?.scrollIntoView({ block: "nearest" }),
      )
    }
    if (handled) return true
    if (event.key === "Escape" && input.view.submit.queue?.editing()) {
      event.preventDefault()
      input.view.submit.queue.cancelEdit()
      return true
    }
    const stop =
      input.view.submit.working?.() &&
      ((event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "g") ||
        event.key === "Escape")
    if (stop) {
      event.preventDefault()
      input.view.submit.onStop()
      return true
    }
    if (
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      (event.key === "ArrowUp" || event.key === "ArrowDown") &&
      navigateHistory(event.key === "ArrowUp" ? "up" : "down")
    ) {
      event.preventDefault()
      return true
    }
    return event.defaultPrevented
  }

  createEffect(() => {
    if (state.popover.type === "closed") return
    const ids = suggestions().map((item) => item.id)
    if (state.popover.activeID ? ids.includes(state.popover.activeID) : ids.length === 0) return
    dispatch({ type: "popover.results", ids })
  })

  const restoreFocus = (cursor = draft.state.cursor ?? promptLength(draft.state.prompt)) => {
    requestAnimationFrame(() => {
      editor?.focus()
      setEditorCursor(editor, cursor)
    })
  }

  const applyHistory = (entry: ComposerHistoryEntry, position: "start" | "end") => {
    input.history?.restore?.(entry.metadata)
    const cursor = position === "start" ? 0 : promptLength(entry.prompt)
    draft.setPrompt(clonePrompt(entry.prompt), cursor)
    restoreFocus(cursor)
  }
  const navigateHistory = (direction: "up" | "down") => {
    if (!input.history || !editor) return false
    const selection = window.getSelection()
    if (!selection?.isCollapsed || !editor.contains(selection.anchorNode)) return false
    const text = draft.state.prompt.map((part) => ("content" in part ? part.content : "")).join("")
    if (!canNavigateHistory(direction, text, editorCursor(editor), state.historyIndex >= 0)) return false
    const entries = input.history.entries(state.mode)
    if (direction === "up") {
      if (entries.length === 0 || state.historyIndex >= entries.length - 1) return false
      if (state.historyIndex === -1) {
        setState("savedHistory", {
          prompt: clonePrompt(draft.state.prompt),
          metadata: input.history.capture?.(),
        })
      }
      const index = state.historyIndex + 1
      setState("historyIndex", index)
      applyHistory(entries[index]!, "start")
      return true
    }
    if (state.historyIndex < 0) return false
    if (state.historyIndex > 0) {
      const index = state.historyIndex - 1
      setState("historyIndex", index)
      applyHistory(entries[index]!, "end")
      return true
    }
    const saved = state.savedHistory ?? { prompt: [{ type: "text", content: "", start: 0, end: 0 }] }
    setState({ historyIndex: -1, savedHistory: undefined })
    applyHistory(saved, "end")
    return true
  }

  return {
    state,
    view: input.view,
    suggestions,
    dispatch,
    onKeyDown,
    value() {
      return draft.state.prompt.map((part) => ("content" in part ? part.content : "")).join("")
    },
    parts() {
      return draft.state.prompt
    },
    contextItem(id: string) {
      return draft.state.context.items.find((item) => item.key === id)
    },
    comments() {
      return draft.state.context.items.filter((item) => !!item.comment?.trim())
    },
    attachments(): ComposerAttachment[] {
      return draft.state.prompt.filter((part): part is ComposerAttachment => part.type === "image")
    },
    toggleContext(id: string) {
      dispatch({ type: "context.active", id })
      input.openContext?.(id)
    },
    removeContext(id: string) {
      const item = draft.state.context.items.find((entry) => entry.key === id)
      if (item) input.onContextRemove?.(item)
      draft.removeContext(id)
      if (state.activeContextID === id) dispatch({ type: "context.active", id })
    },
    openAttachment(attachment: ComposerAttachment) {
      input.openAttachment?.(attachment)
    },
    removeAttachment(id: string) {
      draft.removeAttachment(id)
    },
    canSubmit() {
      if (input.view.submit.available?.() === false) return false
      if (input.view.draftOnly) return false
      const persisted = draft.state
      if (state.mode === "shell") {
        return persisted.prompt.some((part) => "content" in part && !!part.content.trim())
      }
      if (persisted.prompt.some((part) => part.type === "image")) return true
      if (persisted.context.items.some((item) => !!item.comment?.trim())) return true
      return persisted.prompt.some((part) => "content" in part && !!part.content.trim())
    },
    setEditor(element: HTMLElement) {
      editor = element
      input.onEditor?.(element)
    },
    restoreFocus,
    onInput(value: string, prompt?: ComposerPersistedState["prompt"], cursor?: number) {
      if (prompt) draft.setPrompt(prompt, cursor)
      if (input.view.draftOnly) return
      dispatch({ type: "input.changed", value, persist: !prompt })
    },
    onCursor(cursor: number) {
      draft.setCursor(cursor)
    },
    openCommands() {
      dispatch({ type: "commands.open" })
    },
    openContext() {
      dispatch({ type: "context.open" })
    },
    openShell() {
      dispatch({ type: "mode.shell" })
    },
    submit(options?: { alternate?: boolean; interrupt?: boolean }) {
      if (input.view.submit.available?.() === false) return
      if (input.view.draftOnly) return
      input.view.submit.onSubmit(options)
      dispatch({ type: "popover.close" })
    },
    stop() {
      input.view.submit.onStop()
    },
    addHistory(prompt: ComposerPersistedState["prompt"], mode: "normal" | "shell") {
      input.history?.add(prompt, mode)
      setState({ historyIndex: -1, savedHistory: undefined })
    },
    resetHistory() {
      setState({ historyIndex: -1, savedHistory: undefined })
    },
    onPaste(event: ClipboardEvent) {
      const clipboard = event.clipboardData
      if (
        attachments &&
        (Array.from(clipboard?.items ?? []).some((item) => item.kind === "file") || !clipboard?.getData("text/plain"))
      ) {
        void attachments.handlePaste(event)
        return
      }
      const text = clipboard?.getData("text/plain").replace(/\r\n?/g, "\n")
      if (!text) return
      event.preventDefault()
      // insertText emits input events per line, repeatedly parsing and saving the draft.
      // Escaped HTML inserts multiline text once and preserves native selection and undo.
      const multiline = text.includes("\n")
      const value = multiline ? text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;") : text
      if (
        typeof document.execCommand === "function" &&
        document.execCommand(multiline ? "insertHTML" : "insertText", false, value)
      )
        return
      const target = event.currentTarget
      const selection = window.getSelection()
      if (!(target instanceof HTMLElement) || !selection?.rangeCount || !target.contains(selection.anchorNode)) return
      const range = selection.getRangeAt(0)
      range.deleteContents()
      const node = document.createTextNode(text)
      range.insertNode(node)
      range.setStartAfter(node)
      range.collapse(true)
      selection.removeAllRanges()
      selection.addRange(range)
      target.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertFromPaste", data: text }))
    },
    onDragEnter(event: DragEvent) {
      event.preventDefault()
      dispatch({ type: "drag.enter" })
    },
    onDragOver(event: DragEvent) {
      event.preventDefault()
    },
    onDragLeave() {
      dispatch({ type: "drag.leave" })
    },
    onDrop(event: DragEvent) {
      event.preventDefault()
      dispatch({ type: "drag.leave" })
      if (attachments) {
        event.stopPropagation()
        void attachments.handleDrop(event)
        return
      }
    },
    attach,
    setFileInput(element: HTMLInputElement) {
      fileInput = element
    },
    addAttachments(files: File[]) {
      if (attachments) void attachments.addAttachments(files)
    },
    setQuery(value: string) {
      dispatch({ type: "popover.query", value })
    },
  }
}

export type ComposerEditorModel = ReturnType<typeof createComposerEditor>

function canNavigateHistory(direction: "up" | "down", text: string, cursor: number, inHistory: boolean) {
  const position = Math.max(0, Math.min(cursor, text.length))
  if (inHistory) return position === 0 || position === text.length
  if (direction === "up") return position === 0 && text.length === 0
  return position === text.length
}

function editorCursor(editor: HTMLElement) {
  const selection = window.getSelection()
  if (!selection?.rangeCount || !editor.contains(selection.anchorNode)) return editor.textContent?.length ?? 0
  const range = selection.getRangeAt(0).cloneRange()
  range.selectNodeContents(editor)
  range.setEnd(selection.anchorNode!, selection.anchorOffset)
  return range.toString().length
}

function setEditorCursor(editor: HTMLElement | undefined, cursor: number) {
  if (!editor) return
  const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT)
  let remaining = cursor
  let node = walker.nextNode()
  while (node) {
    const length = node.textContent?.length ?? 0
    if (remaining <= length) {
      const range = document.createRange()
      range.setStart(node, remaining)
      range.collapse(true)
      const selection = window.getSelection()
      selection?.removeAllRanges()
      selection?.addRange(range)
      return
    }
    remaining -= length
    node = walker.nextNode()
  }
}
