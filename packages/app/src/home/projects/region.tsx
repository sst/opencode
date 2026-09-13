import type { HomeProjectsController } from "./controller"
import { HomeProjectsView } from "./view"
import type { HomeScrollController } from "../scroll"

export function HomeProjects(props: {
  projects: HomeProjectsController
  scroll: HomeScrollController
  dropdown?: boolean
}) {
  return (
    <HomeProjectsView
      dropdown={props.dropdown}
      language={props.projects.copy.language}
      servers={props.projects.server.list()}
      projects={props.projects.project.list()}
      recentlyClosed={props.projects.project.recentlyClosed()}
      selection={props.projects.selection.value()}
      homedir={props.projects.project.homedir()}
      serverHealth={props.projects.server.health}
      projectsForServer={props.projects.server.projects}
      collapsed={props.projects.server.collapsed}
      canDefaultServer={props.projects.server.canDefault()}
      defaultServerKey={props.projects.server.defaultKey()}
      canRevealProject={props.projects.project.canReveal}
      unseenCount={props.projects.project.unseenCount}
      onWheel={props.scroll.viewport.containWheel}
      onChooseProject={props.projects.project.choose}
      onFocusServer={props.projects.server.focus}
      onAuthenticateServer={props.projects.server.authenticate}
      onToggleCollapsed={props.projects.server.toggleCollapsed}
      onEditServer={props.projects.server.edit}
      onSetDefaultServer={props.projects.server.setDefault}
      canRemoveServer={props.projects.server.canRemove}
      onRemoveServer={props.projects.server.remove}
      canHideServer={props.projects.server.canHide}
      onHideServer={props.projects.server.hide}
      onMoveProject={props.projects.project.move}
      onSelectProject={props.projects.project.select}
      onAddProjects={props.projects.project.add}
      onOpenProjectNewSession={props.projects.project.openNewSession}
      canImportSession={props.projects.project.canImportSession}
      onImportSession={props.projects.project.importSession}
      onEditProject={props.projects.project.edit}
      onRevealProject={props.projects.project.reveal}
      onClearNotifications={props.projects.project.clearNotifications}
      onCloseProject={props.projects.project.close}
      onOpenSettings={props.projects.utility.settings}
      onOpenHelp={props.projects.utility.help}
    />
  )
}
