import { Icon } from "@opencode/ui/icon"
import { Show } from "solid-js"
import { useLanguage } from "@/runtime/i18n/language"
import { ProjectSummaryCard } from "@/session/summary/project-card"
import { SessionServerPanel } from "@/session/summary/server-panel"
import type { PromptProject } from "./project/selector"
import type { DraftMcpControls } from "./mcp"
import type { NewSessionWorkspaceController } from "./workspace/controller"
import { PromptWorkspaceSelector } from "./workspace/selector"

export function NewSessionSummary(props: {
  project?: PromptProject
  workspace: NewSessionWorkspaceController
  mcp: DraftMcpControls
  shown: boolean
  onChooseProject: () => void
}) {
  const language = useLanguage()
  return (
    <div data-component="session-summary-panel">
      <Show
        when={props.project}
        fallback={
          <div class="session-summary-card">
            <button type="button" class="session-summary-row" onClick={props.onChooseProject}>
              <Icon name="folder" class="text-v2-icon-icon-muted" />
              <span class="session-summary-label">{language.t("session.summary.chooseProject")}</span>
            </button>
          </div>
        }
      >
        {(project) => (
          <>
            <ProjectSummaryCard project={project()}>
              <Show
                when={props.workspace.bar.visible()}
                fallback={
                  <div class="session-summary-row">
                    <Icon name="monitor" class="shrink-0 text-v2-icon-icon-muted" />
                    <span class="session-summary-label">{language.t("session.new.git.none")}</span>
                  </div>
                }
              >
                <PromptWorkspaceSelector
                  variant="summary"
                  value={props.workspace.selection.value()}
                  projectRoot={props.workspace.project.root()}
                  workspaces={props.workspace.project.workspaces()}
                  branches={props.workspace.project.branches()}
                  branch={props.workspace.bar.branch()}
                  onChange={props.workspace.selection.set}
                  onCreate={props.workspace.selection.create}
                  onSearch={props.workspace.project.searchBranches}
                  onViewAll={props.workspace.project.openAll}
                />
              </Show>
            </ProjectSummaryCard>
            <SessionServerPanel directory={props.mcp.directory()} shown={props.shown} mcp={props.mcp.controls} />
          </>
        )}
      </Show>
    </div>
  )
}
