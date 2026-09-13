import { createPromptProjectController } from "@/new-session/project/selector"
import { useSettingsSurface } from "@/settings/surface"
import { useTabs, type DraftTab } from "@/shell/tabs/tabs"
import { useSettingsServers } from "@/settings/servers/inventory"
import { useSearchParams } from "@solidjs/router"
import { createEffect, createMemo, createResource, untrack } from "solid-js"
import { createComposerModel } from "@/composer/model"
import { useComposerCommands } from "@/composer/commands"
import { createNewSessionComposerAdapter } from "./composer-adapter"
import { NewSessionView } from "./view"
import { createNewSessionWorkspaceController } from "./workspace/controller"
import { useNewSessionCommands } from "./commands"
import { createDraftMcpControls } from "./mcp"

/** The draft-only Session page. Submitting promotes the draft into a real Session. */
export default function NewSessionPage(props: { draftId: string }) {
  const [search, setSearch] = useSearchParams<{ draftId?: string; prompt?: string }>()
  const tabs = useTabs()
  const servers = useSettingsServers()
  const settingsSurface = useSettingsSurface()
  const draftTab = createMemo(() =>
    tabs.store.find((tab): tab is DraftTab => tab.type === "draft" && tab.draftID === search.draftId),
  )
  const openWorkspaces = () => {
    const draft = draftTab()
    if (servers().length > 1 && draft) {
      settingsSurface.openServer(draft.server, "workspaces")
      return
    }
    settingsSurface.open("workspaces")
  }
  const workspace = createNewSessionWorkspaceController({
    selectedWorktree: () => draftTab()?.worktree,
    selectedBranch: () => draftTab()?.branch,
    setSelectedWorktree: (worktree) => {
      if (search.draftId) tabs.updateDraft(search.draftId, { worktree })
    },
    setSelectedBranch: (branch) => {
      if (search.draftId) tabs.updateDraft(search.draftId, { branch })
    },
    onViewAll: openWorkspaces,
  })
  const mcp = createDraftMcpControls({ draftID: props.draftId, worktree: workspace.selection.value })
  const composer = createNewSessionComposerAdapter({
    draftID: props.draftId,
    worktree: workspace.selection.value,
    branch: workspace.bar.branch,
    submitted: workspace.selection.remember,
    mcp,
  })
  const model = createComposerModel(composer.adapter)
  useComposerCommands({ model: composer.model })
  const project = createPromptProjectController({
    controls: composer.project,
    onDone: model.restoreFocus,
  })
  useNewSessionCommands({
    restoreFocus: model.restoreFocus,
    project: {
      empty: project.empty,
      open: () => project.setOpen(true),
    },
  })
  createEffect(() => {
    if (!composer.ready()) return
    model.restoreFocus()
  })
  createEffect(() => {
    if (!composer.ready()) return
    untrack(() => {
      const text = search.prompt
      if (!text) return
      composer.adapter.state.set([{ type: "text", content: text, start: 0, end: text.length }], text.length)
      setSearch({ ...search, prompt: undefined })
    })
  })
  const ready = Promise.resolve()
  const [suspendUntilPromptReady] = createResource(
    () => composer.ready.promise ?? ready,
    (promise) => promise.then(() => true),
  )

  return (
    <div class="relative size-full overflow-hidden flex flex-col">
      {suspendUntilPromptReady()}
      <div class="flex-1 min-h-0 flex flex-col gap-2 px-2 pb-[var(--shell-bottom-inset,8px)] pt-[var(--shell-top-inset,8px)]">
        <NewSessionView composer={model} project={project} workspace={workspace} mcp={mcp} />
      </div>
    </div>
  )
}
