import { useCommand, type CommandOption } from "@/shell/commands/command"
import { useDialog } from "@opencode/ui/context/dialog"
import { previewSelectedLines } from "@opencode/session-ui/pierre/selection-bridge"
import { useFile, selectionFromLines, type FileSelection, type SelectedLineRange } from "@/workspaces/files/model"
import { useLanguage } from "@/runtime/i18n/language"
import { useLayout } from "@/shell/state/layout"
import { useComposerState } from "@/composer/persistence"
import { useServerSDK } from "@/runtime/server/client"
import { useSettings } from "@/settings/model"
import { useTerminal } from "@/session/terminal/context"
import { showToast } from "@/shell/notifications/toast"
import { fetchSessionExport, saveSessionExport, sessionExportFilename } from "@/session/commands/export"
import { usePlatform } from "@/runtime/platform/platform"
import type { SessionModel } from "@/session/model"
import type { SessionRevert } from "@/session/revert"
import { useData } from "@/runtime/server/current"

type SessionCommandSource = {
  identity: SessionModel["identity"]
  data: Pick<SessionModel["data"], "info" | "revertMessageID">
  history: Pick<SessionModel["history"], "visibleUserMessages">
  layout: SessionModel["layout"]
  ownership: SessionModel["ownership"]
  tabs: Pick<SessionModel["tabs"], "activeFileTab" | "closableTab">
}

export type SessionCommandContext = {
  session: SessionCommandSource
  background: {
    blocking: () => boolean
    move: () => Promise<void>
  }
  navigateMessageByOffset: (offset: number) => void
  revert: Pick<SessionRevert, "undo" | "redo">
  focusInput: () => void
}

const withCategory = (category: string) => {
  return (option: Omit<CommandOption, "category">): CommandOption => ({
    ...option,
    category,
  })
}

export const useSessionCommands = (actions: SessionCommandContext) => {
  const command = useCommand()
  const dialog = useDialog()
  const file = useFile()
  const language = useLanguage()
  const prompt = useComposerState()
  const serverSDK = useServerSDK()
  const settings = useSettings()
  const terminal = useTerminal()
  const platform = usePlatform()
  const layout = useLayout()
  const data = useData()
  const openDialog = async <T,>(load: () => Promise<T>, show: (value: T) => void) => {
    const owner = actions.session.ownership.capture()
    const value = await load()
    owner.run(() => show(value))
  }
  const shown = settings.visibility.fileTree

  const showAllFiles = () => {
    if (layout.fileTree.tab() !== "changes") return
    layout.fileTree.setTab("all")
  }

  const selectionPreview = (path: string, selection: FileSelection) => {
    const content = file.get(path)?.content?.content
    if (!content) return undefined
    return previewSelectedLines(content, { start: selection.startLine, end: selection.endLine })
  }

  const addSelectionToContext = (path: string, selection: FileSelection) => {
    const preview = selectionPreview(path, selection)
    prompt.context.add({ type: "file", path, selection, preview })
  }

  const canAddSelectionContext = () => {
    const tab = actions.session.tabs.activeFileTab()
    if (!tab) return false
    const path = file.pathFromTab(tab)
    if (!path) return false
    return file.selectedLines(path) != null
  }

  const navigateMessageByOffset = actions.navigateMessageByOffset
  const focusInput = actions.focusInput

  const sessionCommand = withCategory(language.t("command.category.session"))
  const projectCommand = withCategory(language.t("command.category.project"))
  const fileCommand = withCategory(language.t("command.category.file"))
  const contextCommand = withCategory(language.t("command.category.context"))
  const viewCommand = withCategory(language.t("command.category.view"))
  const terminalCommand = withCategory(language.t("command.category.terminal"))
  const mcpCommand = withCategory(language.t("command.category.mcp"))
  const permissionsCommand = withCategory(language.t("command.category.permissions"))

  const exportSession = async () => {
    const sessionID = actions.session.identity.params.id
    if (!sessionID) return
    try {
      const data = await fetchSessionExport({
        sessionID,
        api: serverSDK.api,
      })
      const filename = sessionExportFilename(data.info)
      if (!(await saveSessionExport(filename, data, platform))) return
      showToast({
        variant: "success",
        icon: "circle-check",
        title: language.t("toast.session.export.success.title"),
        description: language.t("toast.session.export.success.description", { filename }),
      })
    } catch (err) {
      showToast({
        variant: "error",
        title: language.t("toast.session.export.failed.title"),
        description: err instanceof Error ? err.message : language.t("toast.session.export.failed.description"),
      })
    }
  }

  const copySessionID = async () => {
    const sessionID = actions.session.identity.params.id
    if (!sessionID) return
    try {
      await (platform.writeClipboardText?.(sessionID) ?? navigator.clipboard.writeText(sessionID))
      showToast({
        variant: "success",
        icon: "circle-check",
        title: language.t("common.copied"),
        description: sessionID,
      })
    } catch (err) {
      showToast({
        variant: "error",
        title: language.t("toast.session.copyID.failed.title"),
        description: err instanceof Error ? err.message : language.t("toast.session.copyID.failed.description"),
      })
    }
  }

  const copyProjectID = async () => {
    const projectID = actions.session.data.info()?.projectID
    if (!projectID) return
    try {
      await (platform.writeClipboardText?.(projectID) ?? navigator.clipboard.writeText(projectID))
      showToast({
        variant: "success",
        icon: "circle-check",
        title: language.t("common.copied"),
        description: projectID,
      })
    } catch (err) {
      showToast({
        variant: "error",
        title: language.t("toast.project.copyID.failed.title"),
        description: err instanceof Error ? err.message : language.t("toast.project.copyID.failed.description"),
      })
    }
  }

  const openFile = () => {
    void openDialog(
      () => import("@/shell/commands/dialog"),
      (x) => dialog.show(() => <x.DialogCommandPalette onOpenFile={showAllFiles} />),
    )
  }

  const closeTab = () => {
    const tab = actions.session.tabs.closableTab()
    if (!tab) return
    actions.session.layout.tabs().close(tab)
  }

  const addSelection = () => {
    const tab = actions.session.tabs.activeFileTab()
    if (!tab) return

    const path = file.pathFromTab(tab)
    if (!path) return

    const range = file.selectedLines(path) as SelectedLineRange | null | undefined
    if (!range) {
      showToast({
        title: language.t("toast.context.noLineSelection.title"),
        description: language.t("toast.context.noLineSelection.description"),
      })
      return
    }

    addSelectionToContext(path, selectionFromLines(range))
  }

  const openTerminal = () => {
    actions.session.layout.view().terminal.open()
    if (terminal.all().length > 0) terminal.new()
    if (terminal.all().length === 0) terminal.requestFocus()
  }

  const closeTerminal = () => {
    const id = terminal.active()
    if (!id) return
    const last = terminal.all().length === 1
    void terminal.close(id)
    if (last) actions.session.layout.view().terminal.close()
  }

  const chooseMcp = () => {
    void openDialog(
      () => import("@/providers/connect/mcp-dialog"),
      (x) => dialog.show(() => <x.DialogSelectMcp />),
    )
  }

  const toggleAutoAccept = () => {
    const active = !settings.permissions.autoApprove()
    settings.permissions.setAutoApprove(active)
    showToast({
      title: active
        ? language.t("toast.permissions.autoaccept.on.title")
        : language.t("toast.permissions.autoaccept.off.title"),
      description: active
        ? language.t("toast.permissions.autoaccept.on.description")
        : language.t("toast.permissions.autoaccept.off.description"),
    })
  }

  const undo = actions.revert.undo
  const redo = actions.revert.redo
  const hasUserHistory = () => {
    const id = actions.session.identity.params.id
    return !!id && (actions.session.history.visibleUserMessages().length > 0 || data.session.message.more(id))
  }

  const compact = async () => {
    const sessionID = actions.session.identity.params.id
    if (!sessionID) return

    await serverSDK.api.session.compact({ sessionID })
  }

  const fork = () => {
    const sessionID = actions.session.identity.params.id
    if (!sessionID) return
    void openDialog(
      () => import("@/session/commands/fork-dialog"),
      (x) => dialog.show(() => <x.DialogFork />),
    )
  }

  const sessionCmds = () => [
    sessionCommand({
      id: "session.new",
      title: language.t("command.session.new"),
      keybind: "mod+shift+s",
      slash: "new",
      onSelect: (source) => command.trigger("tab.new", source),
    }),
    sessionCommand({
      id: "session.undo",
      title: language.t("command.session.undo"),
      description: language.t("command.session.undo.description"),
      slash: "undo",
      disabled: !hasUserHistory(),
      onSelect: undo,
    }),
    sessionCommand({
      id: "session.redo",
      title: language.t("command.session.redo"),
      description: language.t("command.session.redo.description"),
      slash: "redo",
      disabled: !actions.session.identity.params.id || !actions.session.data.revertMessageID(),
      onSelect: redo,
    }),
    sessionCommand({
      id: "session.compact",
      title: language.t("command.session.compact"),
      description: language.t("command.session.compact.description"),
      slash: "compact",
      disabled: !hasUserHistory(),
      onSelect: compact,
    }),
    sessionCommand({
      id: "session.background",
      title: language.t("command.session.background"),
      keybind: "ctrl+b",
      disabled: !actions.background.blocking(),
      onSelect: actions.background.move,
    }),
    sessionCommand({
      id: "session.fork",
      title: language.t("command.session.fork"),
      description: language.t("command.session.fork.description"),
      slash: "fork",
      disabled: !hasUserHistory(),
      onSelect: fork,
    }),
    sessionCommand({
      id: "session.export",
      title: language.t("command.session.export"),
      description: language.t("command.session.export.description"),
      slash: "export",
      disabled: !actions.session.identity.params.id,
      onSelect: exportSession,
    }),
    sessionCommand({
      id: "session.copyID",
      title: language.t("command.session.copyID"),
      disabled: !actions.session.identity.params.id,
      onSelect: copySessionID,
    }),
  ]

  const fileCmds = () => {
    const tab = actions.session.tabs.closableTab()
    return [
      fileCommand({
        id: "file.open",
        title: language.t("command.file.open"),
        description: language.t("palette.search.placeholder"),
        keybind: "mod+p",
        slash: "open",
        onSelect: openFile,
      }),
      tab &&
        fileCommand({
          id: "file.close",
          title: language.t("command.tab.close"),
          keybind: settings.keybinds.get("tab.close") ?? "mod+w",
          when: (event) => !(event.target instanceof Element && event.target.closest('[data-component="terminal"]')),
          onSelect: closeTab,
        }),
    ].filter((v) => !!v)
  }

  const projectCmds = () => [
    projectCommand({
      id: "project.copyID",
      title: language.t("command.project.copyID"),
      disabled: !actions.session.data.info()?.projectID,
      onSelect: copyProjectID,
    }),
  ]

  const contextCmds = () => [
    contextCommand({
      id: "context.addSelection",
      title: language.t("command.context.addSelection"),
      description: language.t("command.context.addSelection.description"),
      keybind: "mod+shift+l",
      disabled: !canAddSelectionContext(),
      onSelect: addSelection,
    }),
  ]

  const viewCmds = () => [
    viewCommand({
      id: "terminal.toggle",
      title: language.t("command.terminal.toggle"),
      keybind: "ctrl+`",
      slash: "terminal",
      onSelect: () => {
        if (actions.session.layout.view().terminal.opened()) {
          terminal.cancelFocus()
          actions.session.layout.view().terminal.close()
          return
        }
        actions.session.layout.view().terminal.open()
        terminal.requestFocus(terminal.active())
      },
    }),
    viewCommand({
      id: "review.toggle",
      title: language.t("command.review.toggle"),
      keybind: "mod+shift+r",
      onSelect: () => actions.session.layout.view().reviewPanel.toggle(),
    }),
    ...(shown()
      ? [
          viewCommand({
            id: "fileTree.toggle",
            title: language.t("command.fileTree.toggle"),
            keybind: "mod+\\",
            onSelect: () => layout.fileTree.toggle(),
          }),
        ]
      : []),
    viewCommand({
      id: "input.focus",
      title: language.t("command.input.focus"),
      keybind: "ctrl+l",
      onSelect: focusInput,
    }),
  ]

  const terminalCmds = () => [
    terminalCommand({
      id: "terminal.close",
      title: language.t("terminal.close"),
      keybind: "mod+w",
      hidden: true,
      when: (event) => event.target instanceof Element && !!event.target.closest('[data-component="terminal"]'),
      onSelect: closeTerminal,
    }),
    terminalCommand({
      id: "terminal.new",
      title: language.t("command.terminal.new"),
      description: language.t("command.terminal.new.description"),
      keybind: "ctrl+alt+t",
      onSelect: openTerminal,
    }),
  ]

  const messageCmds = () => [
    sessionCommand({
      id: "message.previous",
      title: language.t("command.message.previous"),
      description: language.t("command.message.previous.description"),
      keybind: "mod+alt+[",
      disabled: !actions.session.identity.params.id,
      onSelect: () => navigateMessageByOffset(-1),
    }),
    sessionCommand({
      id: "message.next",
      title: language.t("command.message.next"),
      description: language.t("command.message.next.description"),
      keybind: "mod+alt+]",
      disabled: !actions.session.identity.params.id,
      onSelect: () => navigateMessageByOffset(1),
    }),
  ]

  const mcpCmds = () => [
    mcpCommand({
      id: "mcp.toggle",
      title: language.t("command.mcp.toggle"),
      description: language.t("command.mcp.toggle.description"),
      keybind: "mod+;",
      slash: "mcp",
      onSelect: chooseMcp,
    }),
  ]

  const permissionsCmds = () => [
    permissionsCommand({
      id: "permissions.autoaccept",
      title: settings.permissions.autoApprove()
        ? language.t("command.permissions.autoaccept.disable")
        : language.t("command.permissions.autoaccept.enable"),
      keybind: "mod+shift+a",
      disabled: false,
      onSelect: toggleAutoAccept,
    }),
  ]

  command.register("session", () => [
    ...sessionCmds(),
    ...projectCmds(),
    ...fileCmds(),
    ...contextCmds(),
    ...viewCmds(),
    ...terminalCmds(),
    ...messageCmds(),
    ...mcpCmds(),
    ...permissionsCmds(),
  ])
}
