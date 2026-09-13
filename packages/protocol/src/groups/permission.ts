import { Agent } from "@opencode/schema/agent"
import { Location } from "@opencode/schema/location"
import { Permission } from "@opencode/schema/permission"
import { PermissionSaved } from "@opencode/schema/permission-saved"
import { Project } from "@opencode/schema/project"
import { Session } from "@opencode/schema/session"
import { Context, Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { PermissionNotFoundError, SessionNotFoundError } from "../errors.js"
import { LocationQuery, locationQueryOpenApi } from "./location.js"

export const makePermissionGroup = <
  LocationId extends HttpApiMiddleware.AnyId,
  LocationService,
  SessionLocationId extends HttpApiMiddleware.AnyId,
  SessionLocationService,
>(
  locationMiddleware: Context.Key<LocationId, LocationService>,
  sessionLocationMiddleware: Context.Key<SessionLocationId, SessionLocationService>,
) =>
  HttpApiGroup.make("server.permission")
    .add(
      HttpApiEndpoint.get("permission.request.list", "/api/permission/request", {
        query: LocationQuery,
        success: Location.response(Schema.Array(Permission.Request)),
      })
        .annotateMerge(locationQueryOpenApi)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.permission.request.list",
            summary: "List pending permission requests",
            description: "Retrieve pending permission requests for a location.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.get("permission.saved.list", "/api/permission/saved", {
        query: Schema.Struct({ projectID: Project.ID.pipe(Schema.optional) }),
        success: Schema.Struct({ data: Schema.Array(PermissionSaved.Info) }),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "v2.permission.saved.list",
          summary: "List saved permissions",
          description: "Retrieve saved permissions, optionally filtered by project.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.delete("permission.saved.remove", "/api/permission/saved/:id", {
        params: { id: PermissionSaved.ID },
        success: HttpApiSchema.NoContent,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "v2.permission.saved.remove",
          summary: "Remove saved permission",
          description: "Remove a saved permission by ID.",
        }),
      ),
    )
    // Effect applies group middleware only to endpoints already added; session endpoints use session placement below.
    .middleware(locationMiddleware)
    .add(
      HttpApiEndpoint.post("session.permission.create", "/api/session/:sessionID/permission", {
        params: { sessionID: Session.ID },
        payload: Schema.Struct({
          id: Permission.ID.pipe(Schema.optional),
          action: Permission.Request.fields.action,
          resources: Permission.Request.fields.resources,
          save: Permission.Request.fields.save,
          metadata: Permission.Request.fields.metadata,
          source: Permission.Request.fields.source,
          agent: Agent.ID.pipe(Schema.optional),
        }),
        success: Schema.Struct({
          data: Schema.Struct({ id: Permission.ID, effect: Permission.Effect }),
        }),
        error: SessionNotFoundError,
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.permission.create",
            summary: "Create permission request",
            description: "Evaluate and, when approval is required, create a permission request for a session.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.get("session.permission.list", "/api/session/:sessionID/permission", {
        params: { sessionID: Session.ID },
        success: Schema.Struct({ data: Schema.Array(Permission.Request) }),
        error: SessionNotFoundError,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "v2.session.permission.list",
          summary: "List session permission requests",
          description: "Retrieve pending permission requests owned by a session.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.get("session.permission.get", "/api/session/:sessionID/permission/:requestID", {
        params: { sessionID: Session.ID, requestID: Permission.ID },
        success: Schema.Struct({ data: Permission.Request }),
        error: [SessionNotFoundError, PermissionNotFoundError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.permission.get",
            summary: "Get permission request",
            description: "Retrieve a pending permission request owned by a session.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("session.permission.reply", "/api/session/:sessionID/permission/:requestID/reply", {
        params: { sessionID: Session.ID, requestID: Permission.ID },
        payload: Schema.Struct({
          reply: Permission.Reply,
          message: Schema.String.pipe(Schema.optional),
        }),
        success: HttpApiSchema.NoContent,
        error: [SessionNotFoundError, PermissionNotFoundError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.permission.reply",
            summary: "Reply to pending permission request",
            description: "Respond to a pending permission request owned by a session.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.put("session.permission.rules", "/api/session/:sessionID/permission/rules", {
        params: { sessionID: Session.ID },
        payload: Schema.Struct({ permissions: Permission.Ruleset }),
        success: HttpApiSchema.NoContent,
        error: SessionNotFoundError,
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.permission.rules",
            summary: "Replace session permission rules",
            description:
              "Replace the session-scoped permission rules. Rules are evaluated after the agent's rules, and the last matching rule wins.",
          }),
        ),
    )
    .annotateMerge(OpenApi.annotations({ title: "permission", description: "Experimental permission routes." }))
