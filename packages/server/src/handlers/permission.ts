import { Instance } from "@opencode/core/instance/service"
import { Location } from "@opencode/core/location"
import { Permission } from "@opencode/core/permission"
import { PermissionSaved } from "@opencode/core/permission/saved"
import { Session } from "@opencode/core/session"
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiSchema } from "effect/unstable/httpapi"
import { Api } from "../api"
import { PermissionNotFoundError } from "@opencode/protocol/errors"
import { response, sessionInfo } from "../location"
import { missingSession } from "./session-error"

function missingRequest(id: Permission.ID) {
  return new PermissionNotFoundError({ requestID: id, message: `Permission request not found: ${id}` })
}

export const PermissionHandler = HttpApiBuilder.group(Api, "server.permission", (handlers) =>
  Effect.gen(function* () {
    const instances = yield* Instance.Service
    const sessions = yield* Session.Service
    const requireOwnedRequest = Effect.fnUntraced(function* (
      sessionID: Permission.Request["sessionID"],
      requestID: Permission.ID,
    ) {
      const permission = yield* Permission.Service
      const request = yield* permission.get(requestID)
      if (!request || request.sessionID !== sessionID) return yield* missingRequest(requestID)
      return { permission, request }
    })

    return handlers
      .handle(
        "permission.request.list",
        Effect.fn(function* () {
          const permission = yield* Permission.Service
          return yield* response(permission.list())
        }),
      )
      .handle(
        "session.permission.create",
        Effect.fn(function* (ctx) {
          const permission = yield* Permission.Service
          return {
            data: yield* permission
              .ask({
                id: ctx.payload.id,
                sessionID: ctx.params.sessionID,
                action: ctx.payload.action,
                resources: ctx.payload.resources,
                save: ctx.payload.save,
                metadata: ctx.payload.metadata,
                source: ctx.payload.source,
                agent: ctx.payload.agent,
              })
              .pipe(Effect.catchTag("Session.NotFoundError", missingSession)),
          }
        }),
      )
      .handle(
        "session.permission.list",
        Effect.fn(function* (ctx) {
          const session = yield* sessionInfo(sessions, ctx.params.sessionID)
          const requests = yield* Permission.Service.use((permission) =>
            permission.forSession(ctx.params.sessionID),
          ).pipe(instances.provide(session))
          return { data: requests }
        }),
      )
      .handle(
        "session.permission.get",
        Effect.fn(function* (ctx) {
          const owned = yield* requireOwnedRequest(ctx.params.sessionID, ctx.params.requestID)
          return { data: owned.request }
        }),
      )
      .handle(
        "session.permission.reply",
        Effect.fn(function* (ctx) {
          const owned = yield* requireOwnedRequest(ctx.params.sessionID, ctx.params.requestID)
          yield* owned.permission
            .reply({ requestID: ctx.params.requestID, reply: ctx.payload.reply, message: ctx.payload.message })
            .pipe(Effect.catchTag("Permission.NotFoundError", () => missingRequest(ctx.params.requestID)))
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.permission.rules",
        Effect.fn(function* (ctx) {
          yield* sessions
            .setPermissions({ sessionID: ctx.params.sessionID, permissions: ctx.payload.permissions })
            .pipe(Effect.catchTag("Session.NotFoundError", missingSession))
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "permission.saved.list",
        Effect.fn(function* (ctx) {
          const location = yield* Location.Service
          const saved = yield* PermissionSaved.Service
          return {
            data: yield* saved.list({
              projectID: ctx.query.projectID ?? location.project.id,
            }),
          }
        }),
      )
      .handle(
        "permission.saved.remove",
        Effect.fn(function* (ctx) {
          const saved = yield* PermissionSaved.Service
          yield* saved.remove(ctx.params.id)
          return HttpApiSchema.NoContent.make()
        }),
      )
  }),
)
