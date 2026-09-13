import { ImagePreview } from "@opencode/ui/image-preview"
import { useDialog } from "@opencode/ui/context/dialog"
import type { ReferenceInfo } from "@opencode/client/promise"
import { createComponent, createEffect, createMemo, on } from "solid-js"
import type { ComposerSuggestion } from "./types"
import { createComposerEditor, createComposerEditorState, type ComposerEditorModel } from "./editor/interaction"
import { selectionFromLines, type SelectedLineRange, useFile } from "@/workspaces/files/model"
import { useComments } from "@/composer/comments"
import { useCommand } from "@/shell/commands/command"
import { useLanguage } from "@/runtime/i18n/language"
import { useLayout } from "@/shell/state/layout"
import { usePlatform } from "@/runtime/platform/platform"
import { useWorkspaceLocation } from "@/workspaces/location"
import { useData, useServer } from "@/runtime/server/current"
import { createSessionTabs } from "@/session/helpers"
import { showToast } from "@/shell/notifications/toast"
import { formatServerError } from "@/runtime/server/errors"
import { Skill } from "@opencode/schema/skill"
import type { ComposerAdapter, ComposerControls, ComposerQueue } from "./adapter"
import type { ImageAttachmentPart } from "./state"
import type { PromptHistoryComment } from "./history/entry"
import { createComposerHistory } from "./history/store"
import { composerPlaceholder } from "./placeholder"
import { createComposerSubmit, withSlashSkill } from "./submit"

export type ComposerModel = ComposerEditorModel & {
  readonly model: ComposerControls["model"]
}

export function createComposerModel(adapter: ComposerAdapter, options?: { queue?: ComposerQueue }): ComposerModel {
  const sdk = useWorkspaceLocation()
  const data = useData()
  const server = useServer()
  const available = () => server.conn.type !== "ssh" || server.ctx.sdk.connection.status() === "connected"
  const files = useFile()
  const layout = useLayout()
  const comments = useComments()
  const dialog = useDialog()
  const command = useCommand()
  const language = useLanguage()
  const platform = usePlatform()
  const prompt = adapter.state
  let editor: HTMLDivElement | undefined

  const interaction = createComposerEditorState(prompt.mode.current())
  createEffect(
    on(
      () => (adapter.ready() ? prompt.mode.current() : undefined),
      (mode) => {
        if (!mode) return
        // Project external draft changes without another mode write clearing restored retry metadata.
        interaction[1](mode === "shell" ? { mode, popover: { type: "closed" } } : { mode })
      },
    ),
  )
  const mode = () => interaction[0].mode
  const history = createComposerHistory()
  const tabs = () => adapter.controls().session.tabs
  const activeFileTab = createSessionTabs({
    tabs,
    pathFromTab: files.pathFromTab,
    normalizeTab: (tab) => (tab.startsWith("file://") ? files.tab(tab) : tab),
  }).activeFileTab
  const recent = createMemo(() => {
    const all = tabs().all()
    const active = activeFileTab()
    const order = active ? [active, ...all.filter((tab) => tab !== active)] : all
    return order.reduce<string[]>((result, tab) => {
      const path = files.pathFromTab(tab)
      if (!path || result.includes(path)) return result
      return [...result, path]
    }, [])
  })
  const attachments = createMemo(() =>
    prompt.current().filter((part): part is ImageAttachmentPart => part.type === "image"),
  )
  const commentCount = createMemo(() => {
    if (mode() === "shell") return 0
    return prompt.context.items().filter((item) => !!item.comment?.trim()).length
  })
  const blank = createMemo(() => {
    const text = prompt
      .current()
      .map((part) => ("content" in part ? part.content : ""))
      .join("")
    return text.trim().length === 0 && attachments().length === 0 && commentCount() === 0
  })
  const stopping = createMemo(() => adapter.working() && blank())
  const placeholder = () =>
    composerPlaceholder(
      mode(),
      (key, params) => language.t(key as Parameters<typeof language.t>[0], params as never),
      adapter.working() || (options?.queue?.count() ?? 0) > 0,
    )

  const historyComments = () => {
    const byID = new Map(comments.all().map((item) => [`${item.file}\n${item.id}`, item] as const))
    return prompt.context.items().flatMap((item) => {
      const comment = item.comment?.trim()
      if (!comment) return []
      const selection = item.commentID ? byID.get(`${item.path}\n${item.commentID}`)?.selection : undefined
      const nextSelection =
        selection ??
        (item.selection
          ? ({ start: item.selection.startLine, end: item.selection.endLine } satisfies SelectedLineRange)
          : undefined)
      if (!nextSelection) return []
      return [
        {
          id: item.commentID ?? item.key,
          path: item.path,
          selection: { ...nextSelection },
          comment,
          time: item.commentID ? (byID.get(`${item.path}\n${item.commentID}`)?.time ?? Date.now()) : Date.now(),
          origin: item.commentOrigin,
          preview: item.preview,
        } satisfies PromptHistoryComment,
      ]
    })
  }
  const restoreHistoryComments = (items: PromptHistoryComment[]) => {
    comments.replace(
      items.map((item) => ({
        id: item.id,
        file: item.path,
        selection: { ...item.selection },
        comment: item.comment,
        time: item.time,
      })),
    )
    prompt.context.replaceComments(
      items.map((item) => ({
        type: "file",
        path: item.path,
        selection: selectionFromLines(item.selection),
        comment: item.comment,
        commentID: item.id,
        commentOrigin: item.origin,
        preview: item.preview,
      })),
    )
  }

  const referenceDescription = (reference: ReferenceInfo) =>
    reference.source.type === "git" ? reference.source.repository : reference.source.path
  const references = createMemo(() =>
    (data.location.reference.list({ directory: sdk().directory }) ?? [])
      .filter((reference) => !reference.hidden)
      .map((reference) => ({
        id: `reference:${reference.name}`,
        kind: "reference" as const,
        label: `@${reference.name}`,
        path: reference.path,
        description: reference.description ?? referenceDescription(reference),
        mention: {
          type: "file" as const,
          path: reference.path,
          content: `@${reference.name}`,
          start: 0,
          end: 0,
          mime: "application/x-directory",
          filename: reference.name,
        },
      })),
  )
  const resources = createMemo(() =>
    (data.location.mcp.resource.list({ directory: sdk().directory }) ?? []).map((resource) => ({
      id: `resource:${resource.server}:${resource.uri}`,
      kind: "resource" as const,
      label: `@${resource.name}`,
      path: resource.uri,
      description: resource.description,
      mention: {
        type: "file" as const,
        path: resource.uri,
        content: `@${resource.name}`,
        start: 0,
        end: 0,
        mime: resource.mimeType ?? "text/plain",
        filename: resource.name,
        url: resource.uri,
        source: {
          type: "resource" as const,
          text: { value: `@${resource.name}`, start: 0, end: resource.name.length + 1 },
          clientName: resource.server,
          uri: resource.uri,
        },
      },
      resource,
    })),
  )
  const skills = createMemo(() => data.location.skill.list({ directory: sdk().directory }) ?? [])
  const context = createMemo<ComposerSuggestion[]>(() => [
    ...references(),
    ...skills().map((skill) => ({
      id: `skill:${skill.id}`,
      kind: "skill" as const,
      label: `@${skill.id}`,
      description: skill.description,
      mention: {
        type: "skill" as const,
        id: Skill.ID.make(skill.id),
        name: Skill.Name.make(skill.name),
        content: `@${skill.id}`,
        start: 0,
        end: 0,
      },
    })),
    ...adapter
      .controls()
      .agents.available.filter((agent) => !agent.hidden && agent.mode !== "primary")
      .map((agent) => ({
        id: `agent:${agent.name}`,
        kind: "agent" as const,
        label: `@${agent.name}`,
        mention: { type: "agent" as const, name: agent.name, content: `@${agent.name}`, start: 0, end: 0 },
      })),
    ...resources(),
    ...recent().map((path) => ({
      id: `file:${path}`,
      kind: "file" as const,
      label: path,
      path,
      recent: true,
      mention: { type: "file" as const, path, content: `@${path}`, start: 0, end: 0 },
    })),
  ])
  const slashCommands = createMemo(() => [
    ...(data.location.command.list({ directory: sdk().directory }) ?? []).map((item) => ({
      id: `custom.${item.name}`,
      trigger: item.name,
      title: item.name,
      description: item.description,
      type: "custom" as const,
    })),
    ...command.options
      .filter((item) => !item.disabled && !item.id.startsWith("suggested.") && item.slash)
      .map((item) => ({
        id: item.id,
        trigger: item.slash!,
        title: item.title,
        description: item.description,
        type: "builtin" as const,
      })),
  ])
  const slashSkills = createMemo(() =>
    skills().filter((skill) => skill.slash !== false && !slashCommands().some((item) => item.trigger === skill.id)),
  )
  const commands = createMemo<ComposerSuggestion[]>(() => [
    ...slashCommands().map((item) => ({
      id: item.id,
      kind: "command" as const,
      label: `/${item.trigger}`,
      trigger: item.trigger,
      title: item.title,
      description: item.description,
      keybind: command.keybindParts(item.id),
    })),
    ...slashSkills().map((skill) => ({
      id: `skill:${skill.id}`,
      kind: "skill" as const,
      label: `/${skill.id}`,
      trigger: skill.id,
      title: skill.name,
      description: skill.description,
      mention: {
        type: "skill" as const,
        id: Skill.ID.make(skill.id),
        name: Skill.Name.make(skill.name),
        content: `/${skill.id}`,
        start: 0,
        end: 0,
      },
    })),
  ])
  const variants = createMemo(() => ["default", ...adapter.controls().model.selection.variant.list()])
  const submission = createComposerSubmit({
    adapter,
    mode,
    commands: () => data.location.command.list({ directory: sdk().directory }),
    skills: slashSkills,
    editor: () => editor,
    queueScroll: () => requestAnimationFrame(() => editor?.scrollIntoView({ block: "nearest" })),
    addToHistory: (value, mode) => controller.addHistory(value, mode),
    resetHistory: () => controller.resetHistory(),
    setMode: (next) => controller.dispatch({ type: next === "shell" ? "mode.shell" : "mode.normal" }),
    closePopover: () => controller.dispatch({ type: "popover.close" }),
    delivery: (alternate) => {
      const queue = options?.queue
      if (!queue) return "steer"
      return (alternate ? queue.alternate() : queue.delivery()) ?? "steer"
    },
    notify: {
      missingSelection: () =>
        showToast({
          title: language.t("prompt.toast.modelAgentRequired.title"),
          description: language.t("prompt.toast.modelAgentRequired.description"),
        }),
      failed: (kind, error) =>
        showToast({
          title: language.t(
            kind === "shell"
              ? "prompt.toast.shellSendFailed.title"
              : kind === "command"
                ? "prompt.toast.commandSendFailed.title"
                : "prompt.toast.promptSendFailed.title",
          ),
          description:
            kind === "command"
              ? formatServerError(error, language.t, language.t("common.requestFailed"))
              : composerErrorMessage(language, error),
        }),
    },
    comments: {
      capture: historyComments,
      clear: comments.clear,
      restore: restoreHistoryComments,
    },
  })
  const controller = createComposerEditor({
    store: prompt.store,
    state: interaction,
    history: {
      entries: (mode) => history.entries(mode).map((entry) => ({ prompt: entry.prompt, metadata: entry.comments })),
      add: (value, mode) => history.add(value, mode, mode === "shell" ? [] : historyComments()),
      capture: historyComments,
      restore: (metadata) => restoreHistoryComments(metadata as PromptHistoryComment[]),
    },
    commands,
    context,
    searchContextFiles: async (query) =>
      (await files.searchFilesAndDirectories(query)).map((path) => ({
        id: `file:${path}`,
        kind: "file",
        label: path,
        path,
        mention: { type: "file", path, content: `@${path}`, start: 0, end: 0 },
      })),
    onContextRemove(item) {
      if (item?.commentID) comments.remove(item.path, item.commentID)
    },
    openAttachment: (attachment) =>
      dialog.show(() => createComponent(ImagePreview, { src: attachment.blob.url, alt: attachment.filename })),
    openContext(key) {
      const item = controller.contextItem(key)
      if (item) openComment(item, adapter.controls(), layout, files, comments)
    },
    onEditor(element) {
      editor = element as HTMLDivElement
      if (adapter.kind === "active-session") adapter.setEditor(editor)
    },
    onSuggestionSelect(item) {
      if (item.kind !== "command") return
      const selected = slashCommands().find((entry) => entry.id === item.id)
      if (!selected || selected.type === "custom") return
      return () => command.trigger(selected.id, "slash")
    },
    attachments: {
      picker: platform.openAttachmentPickerDialog,
      directory: () => sdk().directory,
      isDialogActive: () => !!dialog.active,
      warn: () =>
        showToast({
          title: language.t("prompt.toast.pasteUnsupported.title"),
          description: language.t("prompt.toast.pasteUnsupported.description"),
        }),
      duplicate: () => showToast({ title: language.t("prompt.toast.attachmentDuplicate.title") }),
      onError: (error) =>
        showToast({
          variant: "error",
          title: language.t("common.requestFailed"),
          description: error instanceof Error ? error.message : String(error),
        }),
      readClipboardImage: platform.readClipboardImage,
      getPathForFile: platform.getPathForFile,
      onDragCancel: platform.onDragCancel,
      store: platform.draftStore?.putBlob,
    },
    view: {
      placeholder,
      get agent() {
        const agents = adapter.controls().agents
        return agents.visible && agents.options.length > 0
          ? {
              options: () => adapter.controls().agents.options.map((name) => ({ id: name, label: name })),
              current: () => adapter.controls().agents.current,
              onSelect: (value: string) => adapter.controls().agents.select(value),
              keybind: () => command.keybindParts("agent.cycle"),
            }
          : undefined
      },
      variant: {
        options: () => variants().map((value) => ({ id: value, label: value })),
        current: () => adapter.controls().model.selection.variant.current() ?? "default",
        onSelect: (value) => adapter.controls().model.selection.variant.set(value === "default" ? undefined : value),
        keybind: () => command.keybindParts("model.variant.cycle"),
      },
      submit: {
        available,
        stopping,
        working: adapter.working,
        queue: options?.queue,
        onSubmit: (submitOptions) => {
          if (!available()) return
          const queue = options?.queue
          // Confirming an edit re-admits the queued prompt instead of sending
          // the composer value as a new prompt. Enter keeps it queued in
          // place; the alternate action sends it as a steer.
          if (queue?.editing()) {
            prompt.set(withSlashSkill(prompt.current(), slashSkills()))
            queue.confirmEdit(submitOptions?.alternate ? "steer" : "queue")
            return
          }
          void submission.submit(new Event("submit"), submitOptions)
        },
        onStop: () => void submission.stop(),
      },
    },
  })
  Object.defineProperty(controller, "model", { get: () => adapter.controls().model })

  command.register("composer-editor", () => [
    {
      id: "file.attach",
      title: language.t("prompt.action.attachFile"),
      category: language.t("command.category.file"),
      keybind: "mod+u",
      disabled: controller.state.mode !== "normal",
      onSelect: () => controller.attach(),
    },
    {
      id: "prompt.mode.shell",
      title: language.t("command.prompt.mode.shell"),
      category: language.t("command.category.session"),
      keybind: "mod+shift+x",
      disabled: controller.state.mode === "shell",
      onSelect: () => controller.dispatch({ type: "mode.shell" }),
    },
    {
      id: "prompt.mode.normal",
      title: language.t("command.prompt.mode.normal"),
      category: language.t("command.category.session"),
      keybind: "mod+shift+e",
      disabled: controller.state.mode === "normal",
      onSelect: () => controller.dispatch({ type: "mode.normal" }),
    },
  ])

  return controller as ComposerModel
}

function composerErrorMessage(language: ReturnType<typeof useLanguage>, error: unknown) {
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") {
    return error.message
  }
  if (error && typeof error === "object" && "data" in error) {
    const data = (error as { data?: { message?: string } }).data
    if (data?.message) return data.message
  }
  return language.t("common.requestFailed")
}

function openComment(
  item: { path: string; commentID?: string; commentOrigin?: "review" | "file" },
  controls: ComposerControls,
  layout: ReturnType<typeof useLayout>,
  files: ReturnType<typeof useFile>,
  comments: ReturnType<typeof useComments>,
) {
  if (!item.commentID) return
  const focus = { file: item.path, id: item.commentID }
  comments.setActive(focus)
  const queueFocus = (attempts = 6) => {
    requestAnimationFrame(() => {
      comments.setFocus({ ...focus })
      if (attempts <= 0) return
      requestAnimationFrame(() => {
        const current = comments.focus()
        if (current?.file === focus.file && current.id === focus.id) queueFocus(attempts - 1)
      })
    })
  }
  const review = item.commentOrigin === "review"
  if (!controls.session.reviewPanel.opened()) controls.session.reviewPanel.open()
  if (review) {
    layout.fileTree.setTab("changes")
    controls.session.tabs.setActive("review")
    queueFocus()
    return
  }
  layout.fileTree.setTab("all")
  const tab = files.tab(item.path)
  void controls.session.tabs.open(tab)
  controls.session.tabs.setActive(tab)
  void Promise.resolve(files.load(item.path)).finally(() => queueFocus())
}
