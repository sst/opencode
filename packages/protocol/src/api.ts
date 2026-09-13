import { Context } from "effect"
import { HttpApi, HttpApiGroup, HttpApiMiddleware, OpenApi } from "effect/unstable/httpapi"
import { SchemaErrorMiddleware } from "./middleware/schema-error.js"
import { GenerateGroup } from "./groups/generate.js"
import { MessageGroup } from "./groups/message.js"
import { ModelGroup } from "./groups/model.js"
import { ProviderGroup } from "./groups/provider.js"
import { makeSessionGroup } from "./groups/session.js"
import { makePermissionGroup } from "./groups/permission.js"
import { FileSystemGroup } from "./groups/fs.js"
import { makeFormGroup } from "./groups/form.js"
import { CommandGroup } from "./groups/command.js"
import { SkillGroup } from "./groups/skill.js"
import { RpcGroup } from "./groups/rpc.js"
import { EventGroup, makeEventGroup } from "./groups/event.js"
import type { Definition } from "@opencode/schema/event"
import { AgentGroup } from "./groups/agent.js"
import { PluginGroup } from "./groups/plugin.js"
import { HealthGroup } from "./groups/health.js"
import { ServerGroup } from "./groups/server.js"
import { DebugGroup } from "./groups/debug.js"
import { PtyGroup } from "./groups/pty.js"
import { PersistentPtyGroup } from "./groups/persistent-pty.js"
import { ShellGroup } from "./groups/shell.js"
import { ReferenceGroup } from "./groups/reference.js"
import { Authorization } from "./middleware/authorization.js"
import { LocationGroup } from "./groups/location.js"
import { IntegrationGroup } from "./groups/integration.js"
import { WebSearchGroup } from "./groups/websearch.js"
import { McpGroup } from "./groups/mcp.js"
import { CredentialGroup } from "./groups/credential.js"
import { ProjectGroup } from "./groups/project.js"
import { makeWorktreeGroup } from "./groups/worktree.js"
import { VcsGroup } from "./groups/vcs.js"
import { MigrationGroup } from "./groups/migration.js"
import { ConfigGroup } from "./groups/config.js"
import { WorkspaceGroup } from "./groups/workspace.js"

type LocationGroups<LocationId extends HttpApiMiddleware.AnyId> =
  | HttpApiGroup.AddMiddleware<typeof LocationGroup, LocationId>
  | HttpApiGroup.AddMiddleware<typeof AgentGroup, LocationId>
  | HttpApiGroup.AddMiddleware<typeof PluginGroup, LocationId>
  | HttpApiGroup.AddMiddleware<typeof ModelGroup, LocationId>
  | HttpApiGroup.AddMiddleware<typeof ProviderGroup, LocationId>
  | HttpApiGroup.AddMiddleware<typeof IntegrationGroup, LocationId>
  | HttpApiGroup.AddMiddleware<typeof WebSearchGroup, LocationId>
  | HttpApiGroup.AddMiddleware<typeof McpGroup, LocationId>
  | HttpApiGroup.AddMiddleware<typeof CredentialGroup, LocationId>
  | HttpApiGroup.AddMiddleware<typeof ProjectGroup, LocationId>
  | HttpApiGroup.AddMiddleware<typeof FileSystemGroup, LocationId>
  | HttpApiGroup.AddMiddleware<typeof CommandGroup, LocationId>
  | HttpApiGroup.AddMiddleware<typeof SkillGroup, LocationId>
  | HttpApiGroup.AddMiddleware<typeof RpcGroup, LocationId>
  | HttpApiGroup.AddMiddleware<typeof PtyGroup, LocationId>
  | HttpApiGroup.AddMiddleware<typeof ShellGroup, LocationId>
  | HttpApiGroup.AddMiddleware<typeof ReferenceGroup, LocationId>
  | HttpApiGroup.AddMiddleware<typeof VcsGroup, LocationId>
  | HttpApiGroup.AddMiddleware<typeof ConfigGroup, LocationId>

type SessionGroups<SessionLocationId extends HttpApiMiddleware.AnyId, SessionLocationService> =
  | ReturnType<typeof makeSessionGroup<SessionLocationId, SessionLocationService>>
  | typeof MessageGroup

type FormGroups<
  LocationId extends HttpApiMiddleware.AnyId,
  LocationService,
  FormLocationId extends HttpApiMiddleware.AnyId,
  FormLocationService,
> = ReturnType<typeof makeFormGroup<LocationId, LocationService, FormLocationId, FormLocationService>>

type MixedMiddlewareGroups<
  LocationId extends HttpApiMiddleware.AnyId,
  LocationService,
  SessionLocationId extends HttpApiMiddleware.AnyId,
  SessionLocationService,
> = ReturnType<typeof makePermissionGroup<LocationId, LocationService, SessionLocationId, SessionLocationService>>

type ApiGroups<
  LocationId extends HttpApiMiddleware.AnyId,
  LocationService,
  FormLocationId extends HttpApiMiddleware.AnyId,
  FormLocationService,
  SessionLocationId extends HttpApiMiddleware.AnyId,
  SessionLocationService,
  Event extends HttpApiGroup.Constraint,
> =
  | typeof HealthGroup
  | typeof ServerGroup
  | typeof DebugGroup
  | typeof MigrationGroup
  | typeof WorkspaceGroup
  | typeof GenerateGroup
  | typeof PersistentPtyGroup
  | ReturnType<typeof makeWorktreeGroup<LocationId, LocationService>>
  | LocationGroups<LocationId>
  | FormGroups<LocationId, LocationService, FormLocationId, FormLocationService>
  | SessionGroups<SessionLocationId, SessionLocationService>
  | MixedMiddlewareGroups<LocationId, LocationService, SessionLocationId, SessionLocationService>
  | Event

type EventGroupFor<Definitions extends ReadonlyArray<Definition>> = ReturnType<typeof makeEventGroup<Definitions>>

export type Api<
  LocationId extends HttpApiMiddleware.AnyId,
  LocationService,
  FormLocationId extends HttpApiMiddleware.AnyId,
  FormLocationService,
  SessionLocationId extends HttpApiMiddleware.AnyId,
  SessionLocationService,
  Event extends HttpApiGroup.Constraint,
> = HttpApi.HttpApi<
  "server",
  HttpApiGroup.AddMiddleware<
    HttpApiGroup.AddMiddleware<
      ApiGroups<
        LocationId,
        LocationService,
        FormLocationId,
        FormLocationService,
        SessionLocationId,
        SessionLocationService,
        Event
      >,
      Authorization
    >,
    SchemaErrorMiddleware
  >
>

// Protocol owns middleware placement, while Server injects concrete keys so Core service identities stay downstream.
const makeApiFromGroup = <
  const Group extends HttpApiGroup.Constraint,
  LocationId extends HttpApiMiddleware.AnyId,
  LocationService,
  FormLocationId extends HttpApiMiddleware.AnyId,
  FormLocationService,
  SessionLocationId extends HttpApiMiddleware.AnyId,
  SessionLocationService,
>(
  eventGroup: Group,
  locationMiddleware: Context.Key<LocationId, LocationService>,
  formLocationMiddleware: Context.Key<FormLocationId, FormLocationService>,
  sessionLocationMiddleware: Context.Key<SessionLocationId, SessionLocationService>,
): Api<
  LocationId,
  LocationService,
  FormLocationId,
  FormLocationService,
  SessionLocationId,
  SessionLocationService,
  Group
> =>
  HttpApi.make("server")
    .add(HealthGroup)
    .add(ServerGroup)
    .add(LocationGroup.middleware(locationMiddleware))
    .add(AgentGroup.middleware(locationMiddleware))
    .add(PluginGroup.middleware(locationMiddleware))
    .add(makeSessionGroup(sessionLocationMiddleware))
    .add(MessageGroup)
    .add(ModelGroup.middleware(locationMiddleware))
    .add(GenerateGroup)
    .add(ProviderGroup.middleware(locationMiddleware))
    .add(IntegrationGroup.middleware(locationMiddleware))
    .add(McpGroup.middleware(locationMiddleware))
    .add(CredentialGroup.middleware(locationMiddleware))
    .add(ProjectGroup.middleware(locationMiddleware))
    .add(makeFormGroup(locationMiddleware, formLocationMiddleware))
    .add(makePermissionGroup(locationMiddleware, sessionLocationMiddleware))
    .add(FileSystemGroup.middleware(locationMiddleware))
    .add(CommandGroup.middleware(locationMiddleware))
    .add(SkillGroup.middleware(locationMiddleware))
    .add(RpcGroup.middleware(locationMiddleware))
    .add(eventGroup)
    .add(PtyGroup.middleware(locationMiddleware))
    .add(PersistentPtyGroup)
    .add(ShellGroup.middleware(locationMiddleware))
    .add(ReferenceGroup.middleware(locationMiddleware))
    .add(makeWorktreeGroup(locationMiddleware))
    .add(WorkspaceGroup)
    .add(VcsGroup.middleware(locationMiddleware))
    .add(DebugGroup)
    .add(MigrationGroup)
    .add(WebSearchGroup.middleware(locationMiddleware))
    .add(ConfigGroup.middleware(locationMiddleware))
    .annotateMerge(
      OpenApi.annotations({
        title: "opencode HttpApi",
        version: "0.0.1",
        description: "Experimental HttpApi surface for selected instance routes.",
      }),
    )
    .middleware(Authorization)
    .middleware(SchemaErrorMiddleware)

export const makeApi = <
  const Definitions extends ReadonlyArray<Definition>,
  LocationId extends HttpApiMiddleware.AnyId,
  LocationService,
  FormLocationId extends HttpApiMiddleware.AnyId,
  FormLocationService,
  SessionLocationId extends HttpApiMiddleware.AnyId,
  SessionLocationService,
>(options: {
  readonly definitions: Definitions
  readonly locationMiddleware: Context.Key<LocationId, LocationService>
  readonly formLocationMiddleware: Context.Key<FormLocationId, FormLocationService>
  readonly sessionLocationMiddleware: Context.Key<SessionLocationId, SessionLocationService>
}): Api<
  LocationId,
  LocationService,
  FormLocationId,
  FormLocationService,
  SessionLocationId,
  SessionLocationService,
  EventGroupFor<Definitions>
> =>
  makeApiFromGroup(
    makeEventGroup(options.definitions),
    options.locationMiddleware,
    options.formLocationMiddleware,
    options.sessionLocationMiddleware,
  )

export const makeDefaultApi = <
  LocationId extends HttpApiMiddleware.AnyId,
  LocationService,
  FormLocationId extends HttpApiMiddleware.AnyId,
  FormLocationService,
  SessionLocationId extends HttpApiMiddleware.AnyId,
  SessionLocationService,
>(options: {
  readonly locationMiddleware: Context.Key<LocationId, LocationService>
  readonly formLocationMiddleware: Context.Key<FormLocationId, FormLocationService>
  readonly sessionLocationMiddleware: Context.Key<SessionLocationId, SessionLocationService>
}): Api<
  LocationId,
  LocationService,
  FormLocationId,
  FormLocationService,
  SessionLocationId,
  SessionLocationService,
  typeof EventGroup
> =>
  makeApiFromGroup(
    EventGroup,
    options.locationMiddleware,
    options.formLocationMiddleware,
    options.sessionLocationMiddleware,
  )
