import { DiffChanges } from "@opencode/ui/diff-changes"
import { Icon } from "@opencode/ui/icon"
import { getFilename } from "@opencode/util/path"
import { createMemo, Show, type JSX } from "solid-js"
import { useLanguage } from "@/runtime/i18n/language"
import type { Project } from "@/runtime/server/types"
import { useSettings } from "@/settings/model"
import { containsDirectory, workspaceDirectories } from "@/workspaces/paths"
import { SessionWorkspaceMenu } from "../timeline/session-workspace-menu"
import { BackgroundWorkSummary, type BackgroundTask } from "./background"
import { SessionServerPanel } from "./server-panel"
import { ProjectSummaryCard } from "./project-card"
import "./summary.css"

export function SessionSummaryPanel(props: {
  shown?: boolean
  mobile?: boolean
  project: Project
  avatar?: JSX.Element
  directory: string
  local: boolean
  branch?: string
  baseBranch?: string
  diffs?: { additions: number; deletions: number }[]
  sessionID: string
  moveEligible: boolean
  moveDismissed: boolean
  onMoveDismiss: () => void
  onReview: () => void
  backgroundTasks: BackgroundTask[]
}) {
  const language = useLanguage()
  const settings = useSettings()
  const expanded = settings.sessionSummary.projectExpanded
  const placement = createMemo(() =>
    props.mobile ? "top-end" : language.direction() === "rtl" ? "right-start" : "left-start",
  )
  const location = () => {
    if (props.local) return language.t("session.new.workspace.local")
    const workspace = workspaceDirectories(props.project).find((item) => containsDirectory(item, props.directory))
    return getFilename(workspace ?? props.directory)
  }

  return (
    <div data-component="session-summary-panel" data-mobile={props.mobile || undefined}>
      <div>
        <ProjectSummaryCard project={props.project} avatar={props.avatar}>
          <SessionWorkspaceMenu
            eligible={props.moveEligible}
            sessionID={props.sessionID}
            project={props.project}
            directory={props.directory}
            placement={placement()}
            gutter={4}
            class="session-summary-row"
          >
            <Icon name={props.local ? "monitor" : "outline-worktree"} class="shrink-0 text-v2-icon-icon-muted" />
            <span dir="auto" class="session-summary-label">
              {location()}
            </span>
            <Icon name="fill-triangle-down" class="session-summary-menu-indicator shrink-0 text-v2-icon-icon-muted" />
          </SessionWorkspaceMenu>
          <div class="session-summary-row">
            <Icon name="branch" class="shrink-0 text-v2-icon-icon-muted" />
            <Show
              when={props.branch}
              fallback={
                <span class="flex min-w-0 items-center gap-1.5">
                  <span class="shrink-0 whitespace-nowrap">{language.t("session.summary.noBranch")}</span>
                  <Show when={props.baseBranch}>
                    {(base) => (
                      <>
                        <span class="text-v2-text-text-muted">·</span>
                        <span class="truncate text-v2-text-text-faint">
                          {language.t("session.summary.basedOn", { branch: base() })}
                        </span>
                      </>
                    )}
                  </Show>
                </span>
              }
            >
              <span dir="auto" class="min-w-0 truncate">
                {props.branch}
              </span>
            </Show>
          </div>
          <button type="button" class="session-summary-row" onClick={props.onReview}>
            <Icon name="review" class="shrink-0 text-v2-icon-icon-muted" />
            <span class="session-summary-label flex items-center gap-2">
              <Show
                when={props.diffs}
                fallback={
                  <span class="truncate text-v2-text-text-muted">{language.t("session.review.loadingChanges")}</span>
                }
              >
                {(diffs) => (
                  <Show
                    when={diffs().length > 0}
                    fallback={
                      <span class="truncate text-v2-text-text-muted">{language.t("session.review.noChanges")}</span>
                    }
                  >
                    <span class="min-w-0 truncate">
                      {language.plural("ui.sessionTurn.diffs.changed", diffs().length)}
                    </span>
                    <span class="shrink-0 text-v2-text-text-muted">·</span>
                    <DiffChanges appearance="standard" changes={diffs()} />
                  </Show>
                )}
              </Show>
            </span>
          </button>
          <BackgroundWorkSummary tasks={props.backgroundTasks} mobile={props.mobile} />
        </ProjectSummaryCard>
        <Show when={expanded() && props.local && props.diffs?.length && props.moveEligible && !props.moveDismissed}>
          <div class="session-summary-move">
            <SessionWorkspaceMenu
              eligible={props.moveEligible}
              sessionID={props.sessionID}
              project={props.project}
              directory={props.directory}
              placement={placement()}
              gutter={4}
              class="session-summary-row"
            >
              <Icon name="outline-worktree" class="shrink-0 text-v2-icon-icon-muted" />
              <span class="min-w-0 truncate">{language.t("workspace.move.title")}</span>
            </SessionWorkspaceMenu>
            <button
              type="button"
              class="session-summary-dismiss"
              aria-label={language.t("common.dismiss")}
              onClick={props.onMoveDismiss}
            >
              <Icon name="xmark-small" />
            </button>
          </div>
        </Show>
      </div>
      <SessionServerPanel directory={props.directory} shown={props.shown !== false} mobile={props.mobile} />
    </div>
  )
}
