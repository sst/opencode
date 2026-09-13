export * as EventManifest from "./event-manifest"

import { Catalog } from "./catalog"
import { Durable } from "./durable-event-manifest"
import { Event } from "./event"
import { FileSystem } from "./filesystem"
import { FileSystemWatcher } from "./filesystem-watcher"
import { InstallationEvent } from "./installation-event"
import { Integration } from "./integration"
import { InterruptEvent } from "./interrupt-event"
import { LegacyEvent } from "./legacy-event"
import { LspEvent } from "./lsp-event"
import { McpEvent } from "./mcp-event"
import { ModelsDev } from "./models-dev"
import { Permission } from "./permission"
import { PermissionV1 } from "./permission-v1"
import { Plugin } from "./plugin"
import { Project } from "./project"
import { ProjectDirectories } from "./project-directories"
import { Pty } from "./pty"
import { Question } from "./question"
import { QuestionV1 } from "./question-v1"
import { Reference } from "./reference"
import { ServerEvent } from "./server-event"
import { SessionCompactionEvent } from "./session-compaction-event"
import { SessionEvent } from "./session-event"
import { SessionStatusEvent } from "./session-status-event"
import { SessionTodo } from "./session-todo"
import { SessionV1 } from "./session-v1"
import { TuiEvent } from "./tui-event"
import { VcsEvent } from "./vcs-event"
import { WorkspaceEvent } from "./workspace-event"
import { WorktreeEvent } from "./worktree-event"

const sessionV1DurableDefinitions = SessionV1.Event.Definitions.filter((definition) => definition.durable !== undefined)
const sessionV1LiveDefinitions = SessionV1.Event.Definitions.filter((definition) => definition.durable === undefined)

const coreDefinitions = Event.inventory(...sessionV1DurableDefinitions, ...SessionEvent.Definitions)

const foundationDefinitions = Event.inventory(
  ...ModelsDev.Event.Definitions,
  ...Integration.Event.Definitions,
  ...Catalog.Event.Definitions,
  ...coreDefinitions,
)

const featureDefinitions = Event.inventory(
  ...FileSystem.Event.Definitions,
  ...Reference.Event.Definitions,
  ...Permission.Event.Definitions,
  ...Plugin.Event.Definitions,
  ...ProjectDirectories.Event.Definitions,
  ...FileSystemWatcher.Event.Definitions,
  ...Pty.Event.Definitions,
  ...Question.Event.Definitions,
  ...InterruptEvent.Definitions,
)

export const ServerDefinitions = Event.inventory(
  ...foundationDefinitions,
  ...featureDefinitions,
  ...SessionTodo.Event.Definitions,
)

export const Definitions = Event.inventory(
  ...foundationDefinitions,
  ...sessionV1LiveDefinitions,
  ...InstallationEvent.Definitions,
  ...featureDefinitions,
  ...SessionTodo.Event.Definitions,
  ...LspEvent.Definitions,
  ...PermissionV1.Event.Definitions,
  ...TuiEvent.Definitions,
  ...McpEvent.Definitions,
  ...LegacyEvent.Definitions,
  ...Project.Event.Definitions,
  ...SessionStatusEvent.Definitions,
  ...QuestionV1.Event.Definitions,
  ...SessionCompactionEvent.Definitions,
  ...VcsEvent.Definitions,
  ...WorkspaceEvent.Definitions,
  ...WorktreeEvent.Definitions,
  ...ServerEvent.Definitions,
)
export const Latest = Event.latest(Definitions)
export { Durable }
