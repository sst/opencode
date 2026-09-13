import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { FileIcon } from "@opencode/ui/file-icon"
import { Icon } from "@opencode/ui/icon"
import { IconButton } from "@opencode/ui/icon-button"
import { createAnimatedPresence } from "@/runtime/animated-presence"
import { ProviderIcon } from "@opencode/ui/provider-icon"
import { useI18n } from "@opencode/ui/context/i18n"
import { Button } from "@opencode/ui/button"
import { Keybind } from "@opencode/ui/keybind"
import { Menu } from "@opencode/ui/menu"
import { Tooltip } from "@opencode/ui/tooltip"
import { ScrollView } from "@opencode/ui/scroll-view"
import { AttachmentCard } from "@opencode/session-ui/attachment-card"
import { CommentCard } from "@opencode/session-ui/comment-card"
import { typeLabel } from "@opencode/session-ui/message-file"
import { Skill } from "@opencode/schema/skill"
import type {
  ComposerAttachment,
  ComposerComment,
  ComposerOption,
  ComposerPersistedState,
  ComposerPrompt,
  ComposerSuggestion,
} from "../types"
import type { ComposerEditorModel, ComposerSelectControl } from "./interaction"
import { handleComposerKeyDown, type ComposerKeybinds } from "./keybind"
import "../attachments/attachments.css"
import "./editor.css"

export type {
  ComposerAttachment,
  ComposerComment,
  ComposerOption,
  ComposerPersistedState,
  ComposerSuggestion,
} from "../types"

export type ComposerMode = "normal" | "shell"

export type ComposerEditorProps = {
  controller: ComposerEditorModel
  disabled?: boolean
  readOnly?: boolean
  borderUnderlay?: boolean
  class?: string
  modelControl?: JSX.Element
  modelControlsVisible?: boolean
  attachKeybind?: string[]
  attachShortcut?: string
  alternateKeybind?: string[]
  exitShellKeybind?: string[]
  keybinds?: ComposerKeybinds
  submitKeybind?: string[]
}

export function ComposerEditor(props: ComposerEditorProps) {
  const i18n = useI18n()
  const state = props.controller.state
  const view = props.controller.view
  let editor: HTMLDivElement | undefined
  let viewport: HTMLDivElement | undefined
  let controlsViewport!: HTMLDivElement
  let controlsContent!: HTMLDivElement
  const [overflow, setOverflow] = createStore({ start: false, end: false })
  const updateOverflow = () => {
    const offset = Math.abs(controlsViewport.scrollLeft)
    setOverflow({
      start: offset > 1,
      end: controlsViewport.scrollWidth - controlsViewport.clientWidth - offset > 1,
    })
  }
  onMount(() => {
    const observer = new ResizeObserver(updateOverflow)
    observer.observe(controlsViewport)
    observer.observe(controlsContent)
    updateOverflow()
    onCleanup(() => observer.disconnect())
  })
  let localInput = false
  let composing = false
  const updateCursor = () => {
    if (!editor || !window.getSelection()?.isCollapsed) return
    props.controller.onCursor(composerCursor(editor))
  }
  const mode = createMemo(() => state.mode)
  const buttons = createMemo(() => ({
    opacity: mode() === "normal" ? 1 : 0,
    "pointer-events": mode() === "normal" ? ("auto" as const) : ("none" as const),
    transition: "opacity 200ms ease",
  }))
  createEffect(() => {
    const parts = props.controller.parts()
    if (!editor) return
    if (localInput) {
      localInput = false
      return
    }
    renderComposerEditor(editor, parts)
  })

  return (
    <div class={`relative size-full flex flex-col gap-0 ${props.class ?? ""}`}>
      <input
        ref={props.controller.setFileInput}
        type="file"
        multiple
        accept="image/png,image/jpeg,image/gif,image/webp,application/pdf,text/*,application/json,application/ld+json,application/toml,application/x-toml,application/x-yaml,application/xml,application/yaml,.c,.cc,.cjs,.conf,.cpp,.css,.csv,.cts,.env,.go,.gql,.graphql,.h,.hh,.hpp,.htm,.html,.ini,.java,.js,.json,.jsx,.log,.md,.mdx,.mjs,.mts,.py,.rb,.rs,.sass,.scss,.sh,.sql,.toml,.ts,.tsx,.txt,.xml,.yaml,.yml,.zsh"
        class="hidden"
        onChange={(event) => {
          const list = event.currentTarget.files
          if (list) props.controller.addAttachments(Array.from(list))
          event.currentTarget.value = ""
        }}
      />
      <Show when={!view.draftOnly && state.popover.type !== "closed"}>
        <ComposerEditorPopover
          emptyLabel={i18n.t("ui.promptInput.noMatchingItems")}
          items={props.controller.suggestions()}
          activeID={state.popover.type === "closed" ? undefined : state.popover.activeID}
          search={
            state.popover.type === "command-menu"
              ? {
                  value: state.popover.query,
                  label: i18n.t("ui.promptInput.commands"),
                  placeholder: "/",
                  onValueChange: props.controller.setQuery,
                  onKeyDown: props.controller.onKeyDown,
                }
              : undefined
          }
          onActiveChange={(item) => props.controller.dispatch({ type: "popover.active", id: item.id })}
          onSelect={(item) => props.controller.dispatch({ type: "popover.select", item })}
        />
      </Show>
      <form
        data-component="composer"
        data-dock-border-underlay={props.borderUnderlay ? "true" : undefined}
        class="group/composer relative min-h-[96px] w-full overflow-clip rounded-xl bg-v2-background-bg-base"
        classList={{
          "shadow-[var(--v2-elevation-raised)]": !props.borderUnderlay,
        }}
        onSubmit={(event) => {
          event.preventDefault()
          if (!props.disabled) props.controller.submit()
        }}
        onDragEnter={props.controller.onDragEnter}
        onDragOver={props.controller.onDragOver}
        onDragLeave={props.controller.onDragLeave}
        onDrop={props.controller.onDrop}
      >
        <Show when={state.mode === "normal"}>
          <ComposerAttachments
            attachments={props.controller.attachments()}
            comments={props.controller.comments()}
            activeCommentID={state.activeContextID}
            removeLabel={i18n.t("ui.promptInput.removeAttachment")}
            onAttachmentClick={props.controller.openAttachment}
            onAttachmentRemove={(attachment) => props.controller.removeAttachment(attachment.id)}
            onCommentClick={(comment) => props.controller.toggleContext(comment.key)}
            onCommentRemove={(comment) => props.controller.removeContext(comment.key)}
          />
        </Show>

        <ScrollView
          data-component="composer-scroll"
          class="min-h-[60px] max-h-[180px]"
          viewportRef={(element) => {
            viewport = element
            element.tabIndex = -1
          }}
        >
          <div
            ref={(element) => {
              editor = element
              props.controller.setEditor(element)
            }}
            data-component="composer-editor"
            role="textbox"
            aria-multiline="true"
            aria-label={i18n.t("ui.promptInput.label")}
            dir={state.mode === "normal" ? "auto" : "ltr"}
            contenteditable={!props.disabled && !props.readOnly}
            autocapitalize={state.mode === "normal" ? "sentences" : "off"}
            autocorrect={state.mode === "normal" ? "on" : "off"}
            spellcheck={state.mode === "normal"}
            // @ts-expect-error
            autocomplete="off"
            class="relative z-10 block min-h-[60px] w-full whitespace-pre-wrap bg-transparent px-4 pt-4 pb-2 text-[13px] font-[440] leading-5 text-v2-text-text-base focus:outline-none [&_[data-mention=file]]:text-syntax-property [&_[data-mention=agent]]:text-syntax-type [&_[data-mention=reference]]:text-syntax-keyword"
            classList={{ "font-mono!": state.mode === "shell", "opacity-50": props.disabled }}
            style={{
              "unicode-bidi": state.mode === "normal" ? "plaintext" : undefined,
              "text-align": "start",
            }}
            onInput={(event) => {
              const cursor = composerCursor(event.currentTarget)
              const prompt = parseComposerEditor(event.currentTarget)
              const images = props.controller.parts().filter((part) => part.type === "image")
              localInput = true
              props.controller.onInput(prompt.map((part) => part.content).join(""), [...prompt, ...images], cursor)
            }}
            onKeyDown={(event) => {
              handleComposerKeyDown({
                event,
                keybinds: props.keybinds,
                composing,
                selectSuggestion: () => {
                  const popover = state.popover
                  if (popover.type === "closed") return false
                  const item = props.controller.suggestions().find((entry) => entry.id === popover.activeID)
                  if (item) props.controller.dispatch({ type: "popover.select", item })
                  return true
                },
                handleController: () => !view.draftOnly && props.controller.onKeyDown(event),
                editFirst: view.submit.queue?.editFirst,
                insertNewline: props.controller.insertNewline,
                submit: (alternate) => props.controller.submit(alternate ? { alternate: true } : undefined),
              })
            }}
            onCompositionStart={() => (composing = true)}
            onCompositionEnd={() => (composing = false)}
            onKeyUp={updateCursor}
            onPointerUp={updateCursor}
            onPaste={(event) => {
              props.controller.onPaste(event)
              // Programmatic multiline insertion does not reliably reveal the caret.
              requestAnimationFrame(() => {
                const selection = window.getSelection()
                if (!editor || !viewport || !selection?.isCollapsed || !selection.rangeCount) return
                if (!editor.contains(selection.anchorNode)) return
                const caret = selection.getRangeAt(0).getBoundingClientRect()
                if (!caret.height) return
                const bounds = viewport.getBoundingClientRect()
                if (caret.bottom > bounds.bottom - 8) viewport.scrollTop += caret.bottom - bounds.bottom + 8
                if (caret.top < bounds.top + 8) viewport.scrollTop += caret.top - bounds.top - 8
              })
            }}
            onFocus={() => props.controller.dispatch({ type: "focus.editor" })}
          />
          <Show when={!props.controller.value()}>
            <div
              dir={state.mode === "normal" ? "auto" : "ltr"}
              class="pointer-events-none absolute inset-x-0 top-0 px-4 pt-4 text-[13px] font-[440] leading-5 text-v2-text-text-faint"
              classList={{ "font-mono!": state.mode === "shell" }}
              style={{ "unicode-bidi": state.mode === "normal" ? "plaintext" : undefined, "text-align": "start" }}
            >
              {view.placeholder?.() ??
                (state.mode === "shell"
                  ? i18n.t("ui.promptInput.placeholder.shell")
                  : i18n.t("ui.promptInput.placeholder.normal", { slash: "/", at: "@" }))}
            </div>
          </Show>
        </ScrollView>

        <div class="flex h-11 items-center px-2">
          <div
            class="flex shrink-0 items-center"
            aria-hidden={state.mode === "shell"}
            inert={state.mode === "shell" ? true : undefined}
            style={buttons()}
          >
            <ComposerEditorAddMenu
              disabled={view.draftOnly || state.mode === "shell"}
              title={i18n.t("ui.promptInput.add")}
              keybind={props.attachKeybind ?? ["Mod", "U"]}
              attachLabel={i18n.t("ui.promptInput.attachments")}
              attachShortcut={props.attachShortcut ?? "Mod+U"}
              commandsLabel={i18n.t("ui.promptInput.commands")}
              contextLabel={i18n.t("ui.promptInput.context")}
              shellLabel={i18n.t("ui.promptInput.shell")}
              onAttach={props.controller.attach}
              onCommands={props.controller.openCommands}
              onContext={props.controller.openContext}
              onShell={props.controller.openShell}
            />
          </div>
          <div
            ref={controlsViewport}
            data-slot="composer-controls"
            data-overflow-start={overflow.start}
            data-overflow-end={overflow.end}
            class="ms-1 me-3 h-full min-w-0 flex-1 overflow-x-auto overscroll-x-contain no-scrollbar"
            onScroll={updateOverflow}
            aria-hidden={state.mode === "shell"}
            inert={state.mode === "shell" ? true : undefined}
            style={buttons()}
          >
            <div ref={controlsContent} class="flex h-full w-max min-w-full items-center gap-1">
              <Show when={view.agent} keyed>
                {(control) => (
                  <ComposerEditorConfiguredSelect
                    title={i18n.t("ui.promptInput.chooseAgent")}
                    keybind={["Mod", "."]}
                    control={control}
                  />
                )}
              </Show>
              <Show when={props.modelControlsVisible ?? true}>
                {props.modelControl}
                <Show when={view.variant} keyed>
                  {(control) => (
                    <Show when={control.options().length > 1}>
                      <ComposerEditorConfiguredSelect
                        title={i18n.t("ui.promptInput.chooseVariant")}
                        keybind={["Shift", "Mod", "D"]}
                        control={control}
                        class={control.current() === "default" ? "composer-variant-default" : undefined}
                      />
                    </Show>
                  )}
                </Show>
              </Show>
            </div>
          </div>
          <div data-slot="composer-actions" class="flex shrink-0 items-center">
            <Show when={state.mode === "normal"}>
              <ComposerEditorAlternateDelivery
                controller={props.controller}
                keybind={props.alternateKeybind ?? ["Mod", "Enter"]}
              />
            </Show>
            <Show when={state.mode === "shell"}>
              <Button
                data-action="composer-exit-shell"
                type="button"
                variant="ghost-faint"
                size="small"
                class="me-3 gap-1.5 px-1.5"
                onClick={() => {
                  props.controller.dispatch({ type: "mode.normal" })
                  props.controller.restoreFocus()
                }}
              >
                {i18n.t("ui.promptInput.exitShell")}
                <span class="hidden sm:block">
                  <Keybind keys={props.exitShellKeybind ?? ["ESC"]} variant="neutral" />
                </span>
              </Button>
            </Show>
            <ComposerEditorSubmitButton
              mode={state.mode}
              stopping={view.submit.stopping()}
              disabled={!props.controller.canSubmit()}
              sendLabel={i18n.t("ui.promptInput.send")}
              stopLabel={i18n.t("ui.promptInput.stop")}
              sendKeybind={props.submitKeybind}
              onSubmit={() => props.controller.submit()}
              onStop={props.controller.stop}
            />
          </div>
        </div>
      </form>
    </div>
  )
}

const mentionParts = new WeakMap<HTMLElement, Exclude<ComposerPrompt[number], ComposerAttachment | { type: "text" }>>()

function renderComposerEditor(editor: HTMLDivElement, prompt: ComposerPrompt) {
  const active = document.activeElement === editor
  editor.replaceChildren(
    ...prompt.flatMap<Node>((part) => {
      if (part.type === "image") return []
      if (part.type === "text") return [document.createTextNode(part.content)]
      const mention = document.createElement("span")
      mentionParts.set(mention, part)
      mention.textContent = part.content
      mention.contentEditable = "false"
      mention.dir = "auto"
      mention.style.unicodeBidi = "isolate"
      mention.dataset.mention =
        part.type === "file" && part.mime === "application/x-directory" ? "reference" : part.type
      if (part.type === "agent") mention.dataset.name = part.name
      if (part.type === "skill") {
        mention.dataset.id = part.id
        mention.dataset.name = part.name
      }
      if (part.type === "file") {
        mention.dataset.path = part.path
        if (part.mime) mention.dataset.mime = part.mime
        if (part.filename) mention.dataset.filename = part.filename
      }
      return [mention]
    }),
  )
  if (!active) return
  const selection = window.getSelection()
  const range = document.createRange()
  range.selectNodeContents(editor)
  range.collapse(false)
  selection?.removeAllRanges()
  selection?.addRange(range)
}

function parseComposerEditor(editor: HTMLDivElement) {
  const parts: Exclude<ComposerPrompt[number], ComposerAttachment>[] = []
  let buffer = ""
  let position = 0

  const flush = () => {
    if (!buffer) return
    parts.push({ type: "text", content: buffer, start: position, end: position + buffer.length })
    position += buffer.length
    buffer = ""
  }
  const mention = (element: HTMLElement) => {
    flush()
    const content = element.textContent ?? ""
    const original = mentionParts.get(element)
    if (element.dataset.mention === "agent") {
      parts.push({
        ...(original?.type === "agent" ? original : {}),
        type: "agent",
        name: element.dataset.name ?? content.slice(1),
        content,
        start: position,
        end: position + content.length,
      })
      position += content.length
      return
    }
    if (element.dataset.mention === "skill") {
      parts.push({
        ...(original?.type === "skill" ? original : {}),
        type: "skill",
        id: Skill.ID.make(element.dataset.id ?? content.slice(1)),
        name: Skill.Name.make(element.dataset.name ?? content.slice(1)),
        content,
        start: position,
        end: position + content.length,
      })
      position += content.length
      return
    }
    parts.push({
      ...(original?.type === "file" ? original : {}),
      type: "file",
      path: element.dataset.path ?? content.slice(1),
      content,
      start: position,
      end: position + content.length,
      ...(element.dataset.mime ? { mime: element.dataset.mime } : {}),
      ...(element.dataset.filename ? { filename: element.dataset.filename } : {}),
    })
    position += content.length
  }
  const visit = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      buffer += node.textContent ?? ""
      return
    }
    if (!(node instanceof HTMLElement)) return
    if (node.dataset.mention) {
      mention(node)
      return
    }
    if (node.tagName === "BR") {
      buffer += "\n"
      return
    }
    Array.from(node.childNodes).forEach(visit)
  }

  Array.from(editor.childNodes).forEach((node, index, nodes) => {
    visit(node)
    if (node instanceof HTMLElement && ["DIV", "P"].includes(node.tagName) && index < nodes.length - 1) buffer += "\n"
  })
  flush()
  if (
    parts.every((part) => part.type === "text") &&
    parts.every((part) => part.content.replace(/[\n\u200B]/g, "") === "")
  ) {
    return [{ type: "text" as const, content: "", start: 0, end: 0 }]
  }
  if (parts.length > 0) return parts
  return [{ type: "text" as const, content: "", start: 0, end: 0 }]
}

function composerCursor(editor: HTMLDivElement) {
  const selection = window.getSelection()
  if (!selection?.rangeCount || !editor.contains(selection.anchorNode)) return editor.textContent?.length ?? 0
  const range = selection.getRangeAt(0).cloneRange()
  range.selectNodeContents(editor)
  range.setEnd(selection.anchorNode!, selection.anchorOffset)
  return range.toString().length
}

export function ComposerAttachments(props: {
  attachments: ComposerAttachment[]
  comments?: ComposerComment[]
  activeCommentID?: string
  removeLabel: string
  onAttachmentClick?: (attachment: ComposerAttachment) => void
  onAttachmentRemove: (attachment: ComposerAttachment) => void
  onCommentClick?: (comment: ComposerComment) => void
  onCommentRemove?: (comment: ComposerComment) => void
}) {
  const i18n = useI18n()
  return (
    <Show when={props.attachments.length > 0 || (props.comments?.length ?? 0) > 0}>
      <div data-component="composer-attachments" data-slot="composer-attachments" class="relative">
        <div
          data-slot="composer-attachments-scroll"
          class="flex flex-nowrap gap-2 overflow-x-auto no-scrollbar px-2 pt-2 pb-1"
        >
          <For each={props.comments ?? []}>
            {(comment) => (
              <div class="relative group shrink-0">
                <Tooltip
                  value={comment.comment}
                  placement="top"
                  openDelay={800}
                  contentClass="max-w-[300px] break-words"
                >
                  <CommentCard
                    comment={comment.comment ?? ""}
                    path={comment.path}
                    selection={comment.selection}
                    active={comment.key === props.activeCommentID}
                    onClick={() => props.onCommentClick?.(comment)}
                  />
                </Tooltip>
                <button
                  type="button"
                  onClick={() => props.onCommentRemove?.(comment)}
                  class="absolute -top-1 -end-1 size-4 rounded-full bg-v2-icon-icon-muted outline-solid outline-1 outline-v2-icon-icon-contrast flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                  aria-label={props.removeLabel}
                >
                  <Icon name="outline-xmark" class="text-v2-icon-icon-contrast" />
                </button>
              </div>
            )}
          </For>
          <For each={props.attachments}>
            {(attachment) => (
              <div class="relative group shrink-0">
                <Tooltip value={attachment.filename} placement="top" contentClass="break-all">
                  <Show
                    when={attachment.mime.startsWith("image/")}
                    fallback={
                      <AttachmentCard title={attachment.filename}>
                        {typeLabel(attachment.filename, attachment.mime, i18n.t("ui.common.file"))}
                      </AttachmentCard>
                    }
                  >
                    <img
                      src={attachment.blob.url}
                      alt={attachment.filename}
                      class="w-[58px] h-[46px] rounded-[6px] object-cover"
                      onClick={() => props.onAttachmentClick?.(attachment)}
                    />
                    <div class="absolute inset-0 rounded-[6px] shadow-[inset_0_0_0_0.5px_var(--v2-border-border-base)] pointer-events-none" />
                  </Show>
                </Tooltip>
                <button
                  type="button"
                  onClick={() => props.onAttachmentRemove(attachment)}
                  class="absolute -top-1 -end-1 size-4 rounded-full bg-v2-icon-icon-muted outline-solid outline-1 outline-v2-icon-icon-contrast flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                  aria-label={props.removeLabel}
                >
                  <Icon name="outline-xmark" class="text-v2-icon-icon-contrast" />
                </button>
              </div>
            )}
          </For>
        </div>
        <div
          data-slot="composer-attachments-fade-left"
          class="pointer-events-none absolute inset-y-0 start-0 z-10 w-6 bg-[linear-gradient(to_right,var(--v2-background-bg-base),transparent)] rtl:bg-[linear-gradient(to_left,var(--v2-background-bg-base),transparent)]"
        />
        <div
          data-slot="composer-attachments-fade-right"
          class="pointer-events-none absolute inset-y-0 end-0 z-10 w-6 bg-[linear-gradient(to_left,var(--v2-background-bg-base),transparent)] rtl:bg-[linear-gradient(to_right,var(--v2-background-bg-base),transparent)]"
        />
      </div>
    </Show>
  )
}

export function ComposerEditorAddMenu(props: {
  disabled?: boolean
  title: string
  keybind?: string[]
  attachLabel: string
  attachShortcut?: string
  commandsLabel: string
  contextLabel: string
  shellLabel: string
  onAttach: () => void
  onCommands: () => void
  onContext: () => void
  onShell: () => void
}) {
  return (
    <Tooltip
      placement="top"
      value={
        <>
          {props.title}
          <Keybind keys={props.keybind ?? []} variant="neutral" />
        </>
      }
    >
      <Menu gutter={6} modal={false} placement="top-start">
        <Menu.Trigger
          as={IconButton}
          data-action="composer-attach"
          type="button"
          icon={<Icon name="plus" />}
          variant="ghost-muted"
          size="large"
          disabled={props.disabled}
          aria-label={props.title}
        />
        <Menu.Portal>
          <Menu.Content
            class="[&_[data-slot=menu-v2-item-shortcut]]:w-5 [&_[data-slot=menu-v2-item-shortcut]]:justify-center"
            style={{ "min-width": "180px" }}
          >
            <Menu.Item onSelect={props.onAttach} shortcut={props.attachShortcut}>
              {props.attachLabel}
            </Menu.Item>
            <Menu.Separator />
            <Menu.Item onSelect={props.onCommands} shortcut="/">
              {props.commandsLabel}
            </Menu.Item>
            <Menu.Item onSelect={props.onContext} shortcut="@">
              {props.contextLabel}
            </Menu.Item>
            <Menu.Item onSelect={props.onShell} shortcut="!">
              {props.shellLabel}
            </Menu.Item>
          </Menu.Content>
        </Menu.Portal>
      </Menu>
    </Tooltip>
  )
}

function ComposerEditorConfiguredSelect(props: {
  title: string
  keybind?: string[]
  control: ComposerSelectControl
  model?: boolean
  class?: string
}) {
  const current = () => props.control.current()
  const providerID = () => props.control.options().find((option) => option.id === current())?.providerID
  return (
    <ComposerEditorSelect
      title={props.title}
      class={props.class}
      keybind={props.control.keybind?.() ?? props.keybind}
      options={props.control.options()}
      current={current()}
      currentIcon={
        <Show when={props.model && providerID()}>
          <ProviderIcon id={providerID()!} class="size-4 shrink-0 opacity-60" />
        </Show>
      }
      onSelect={props.control.onSelect}
    />
  )
}

export function ComposerEditorSelect(props: {
  title: string
  keybind?: string[]
  options: ComposerOption[]
  current: string
  currentIcon?: JSX.Element
  class?: string
  onOpenChange?: (open: boolean) => void
  onSelect: (id: string) => void
}) {
  return (
    <Tooltip
      placement="top"
      value={
        <>
          {props.title}
          <Keybind keys={props.keybind ?? []} variant="neutral" />
        </>
      }
    >
      <Menu gutter={6} modal={false} placement="top-start" onOpenChange={props.onOpenChange}>
        <Menu.Trigger
          as={Button}
          variant="ghost-muted"
          size="normal"
          class={`max-w-[220px] justify-start ![font-weight:440] ${props.class ?? ""}`}
          aria-label={props.title}
        >
          {props.currentIcon}
          <span class="truncate capitalize leading-5">
            {props.options.find((option) => option.id === props.current)?.label ?? props.current}
          </span>
          <span class="-ms-0.5 -me-1 flex shrink-0">
            <Icon name="chevron-down" />
          </span>
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Content>
            <Menu.RadioGroup value={props.current} onChange={props.onSelect}>
              <For each={props.options}>
                {(option) => (
                  <Menu.RadioItem value={option.id} class="capitalize" closeOnSelect>
                    {option.label}
                  </Menu.RadioItem>
                )}
              </For>
            </Menu.RadioGroup>
          </Menu.Content>
        </Menu.Portal>
      </Menu>
    </Tooltip>
  )
}

export function ComposerEditorPopover(props: {
  emptyLabel: string
  items: ComposerSuggestion[]
  activeID?: string
  search?: {
    value: string
    label: string
    placeholder: string
    onValueChange: (value: string) => void
    onKeyDown: (event: KeyboardEvent) => void
  }
  onActiveChange: (item: ComposerSuggestion) => void
  onSelect: (item: ComposerSuggestion) => void
}) {
  return (
    <div
      data-component="composer-suggestions"
      class="absolute inset-x-0 -top-2 z-40 flex max-h-80 -translate-y-full flex-col overflow-auto rounded-xl bg-v2-background-bg-base p-2 shadow-[var(--v2-elevation-raised)] no-scrollbar"
      onMouseDown={(event) => event.preventDefault()}
    >
      <Show when={props.search}>
        {(search) => (
          <div class="px-2 py-1">
            <input
              ref={(element) => requestAnimationFrame(() => element.focus())}
              value={search().value}
              aria-label={search().label}
              placeholder={search().placeholder}
              class="w-full bg-transparent text-[13px] leading-5 text-v2-text-text-base outline-none placeholder:text-v2-text-text-faint"
              onInput={(event) => search().onValueChange(event.currentTarget.value)}
              onKeyDown={(event) => search().onKeyDown(event)}
              onMouseDown={(event) => event.stopPropagation()}
            />
          </div>
        )}
      </Show>
      <Show
        when={props.items.length > 0}
        fallback={<div class="px-2 py-1 text-v2-text-text-muted">{props.emptyLabel}</div>}
      >
        <For each={props.items}>
          {(item) => (
            <button
              type="button"
              data-suggestion-id={item.id}
              data-active={props.activeID === item.id ? "" : undefined}
              class="flex w-full items-center gap-2 rounded-md px-2 py-1 text-start hover:bg-v2-overlay-simple-overlay-hover"
              classList={{ "bg-v2-overlay-simple-overlay-hover": props.activeID === item.id }}
              onPointerMove={() => props.onActiveChange(item)}
              onClick={() => props.onSelect(item)}
            >
              <div class="flex min-w-0 flex-1 items-center gap-2">
                <ComposerSuggestionIcon item={item} />
                <bdi dir="auto" class="shrink-0 text-v2-text-text-base">
                  {item.label}
                </bdi>
                <Show when={item.description}>
                  <span class="min-w-0 truncate text-v2-text-text-muted">{item.description}</span>
                </Show>
              </div>
              <Show when={item.keybind?.length}>
                <span class="shrink-0 text-v2-text-text-muted">{item.keybind?.join("+")}</span>
              </Show>
            </button>
          )}
        </For>
      </Show>
    </div>
  )
}

// Steer / Queue action with its configured shortcut: submits with the
// delivery opposite to normal submission. Visible only while the queue
// exposes an alternate (turn running and composer holding a value), so it
// disappears on its own when the current turn ends.
function ComposerEditorAlternateDelivery(props: { controller: ComposerEditorModel; keybind: string[] }) {
  const i18n = useI18n()
  const view = props.controller.view
  const action = createMemo(() => {
    const queue = view.submit.queue
    if (!queue || !props.controller.canSubmit()) return undefined
    if (queue.editing()) return "steer" as const
    return queue.alternate()
  })
  const [button, setButton] = createSignal<HTMLButtonElement>()
  const presence = createAnimatedPresence(action, () => button() ?? null)
  return (
    <Show when={presence.present() && presence.value()} keyed>
      {(delivery) => (
        <Tooltip placement="top" inactive={delivery !== "steer"} value={i18n.t("ui.promptInput.steerHint")}>
          <Button
            ref={setButton}
            data-action="composer-alternate-delivery"
            type="button"
            variant="ghost-faint"
            size="small"
            class="me-3 gap-1.5 px-1.5 ![font-weight:530] duration-150 motion-reduce:animate-none"
            classList={{
              "animate-in fade-in": presence.animate() && presence.show(),
              "animate-out fade-out fill-mode-forwards": presence.animate() && !presence.show(),
            }}
            onClick={() => props.controller.submit({ alternate: true })}
          >
            {delivery === "steer" ? i18n.t("ui.promptInput.steer") : i18n.t("ui.promptInput.queue")}
            <span class="hidden sm:block">
              <Keybind keys={props.keybind} variant="neutral" />
            </span>
          </Button>
        </Tooltip>
      )}
    </Show>
  )
}

export function ComposerEditorSubmitButton(props: {
  mode: ComposerMode
  stopping: boolean
  disabled: boolean
  sendLabel: string
  stopLabel: string
  sendKeybind?: string[]
  onSubmit: () => void
  onStop: () => void
}) {
  return (
    <Tooltip
      placement="top"
      inactive={!props.stopping && props.disabled}
      value={
        props.stopping ? (
          props.stopLabel
        ) : (
          <>
            {props.sendLabel}
            <Show when={props.sendKeybind?.length}>
              <Keybind keys={props.sendKeybind ?? []} variant="neutral" />
            </Show>
          </>
        )
      }
    >
      <IconButton
        data-action="composer-submit"
        type="button"
        disabled={!props.stopping && props.disabled}
        tabIndex={props.mode === "normal" ? undefined : -1}
        icon={<Icon name={props.stopping ? "stop" : props.mode === "shell" ? "arrow-undo-down" : "arrow-up"} />}
        variant="submit"
        class="size-7 rounded-md p-[6px]"
        aria-label={props.stopping ? props.stopLabel : props.sendLabel}
        onClick={(event) => {
          event.preventDefault()
          event.stopPropagation()
          if (props.stopping) {
            props.onStop()
            return
          }
          props.onSubmit()
        }}
      />
    </Tooltip>
  )
}

function ComposerSuggestionIcon(props: { item: ComposerSuggestion }) {
  if (props.item.kind === "agent") return <Icon name="brain" size="small" class="shrink-0 text-icon-info-active" />
  if (props.item.kind === "skill") return <Icon name="post-skill" size="small" class="shrink-0" />
  if (props.item.kind === "command") return null
  return (
    <FileIcon
      node={{ path: props.item.path ?? props.item.label, type: props.item.kind === "reference" ? "directory" : "file" }}
      class="size-4 shrink-0"
    />
  )
}
