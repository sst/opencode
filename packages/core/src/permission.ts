export * as Permission from "./permission.js"

import { makeLocationNode } from "@opencode/util/effect/app-node"
import { Context, Deferred, Effect, Layer, Schema } from "effect"
import { Permission } from "@opencode/schema/permission"
import { Bus } from "./bus.js"
import { Location } from "./location.js"
import { Agent } from "./agent.js"
import { SessionErrors } from "./session/error.js"
import { SessionSchema } from "./session/schema.js"
import { SessionStore } from "./session/store.js"
import { Wildcard } from "./util/wildcard.js"
import { PermissionSaved } from "./permission/saved.js"
import { PluginHooks } from "./plugin/hooks.js"

const PermissionEffect = Permission.Effect
export { PermissionEffect as Effect }
export { Rule, Ruleset } from "@opencode/schema/permission"
const missingAgentPermissions: Permission.Ruleset = [{ action: "*", resource: "*", effect: "deny" }]

export const ID = Permission.ID
export type ID = typeof ID.Type

export const Source = Permission.Source
export type Source = typeof Source.Type

const RequestFields = {
  sessionID: Permission.Request.fields.sessionID,
  action: Permission.Request.fields.action,
  resources: Permission.Request.fields.resources,
  save: Permission.Request.fields.save,
  metadata: Permission.Request.fields.metadata,
  source: Permission.Request.fields.source,
}

export const Request = Permission.Request
export type Request = typeof Request.Type

export const Reply = Permission.Reply
export type Reply = typeof Reply.Type

export const AssertInput = Schema.Struct({
  id: ID.pipe(Schema.optional),
  ...RequestFields,
  agent: Agent.ID.pipe(Schema.optional),
}).annotate({ identifier: "Permission.AssertInput" })
export type AssertInput = typeof AssertInput.Type

export const ReplyInput = Schema.Struct({
  requestID: ID,
  reply: Reply,
  message: Schema.String.pipe(Schema.optional),
}).annotate({ identifier: "Permission.ReplyInput" })
export type ReplyInput = typeof ReplyInput.Type

export const AskResult = Schema.Struct({
  id: ID,
  effect: Permission.Effect,
}).annotate({ identifier: "Permission.AskResult" })
export type AskResult = typeof AskResult.Type

export { Event } from "@opencode/schema/permission"

export class DeclinedError extends Schema.TaggedError<DeclinedError>()("Permission.DeclinedError", {}) {}

export class CorrectedError extends Schema.TaggedError<CorrectedError>()("Permission.CorrectedError", {
  feedback: Schema.String,
}) {}

export class BlockedError extends Schema.TaggedError<BlockedError>()("Permission.BlockedError", {
  rules: Permission.Ruleset,
  permission: Schema.String,
  resources: Schema.Array(Schema.String),
  reason: Schema.String.pipe(Schema.optional),
}) {
  override get message() {
    return this.reason ?? `Permission denied: ${this.permission}`
  }
}

export class NotFoundError extends Schema.TaggedError<NotFoundError>()("Permission.NotFoundError", {
  requestID: ID,
}) {}

export type Error = BlockedError | CorrectedError

export function evaluate(action: string, resource: string, ...rulesets: Permission.Ruleset[]): Permission.Rule {
  return (
    rulesets
      .flat()
      .findLast((rule) => Wildcard.match(action, rule.action) && Wildcard.match(resource, rule.resource)) ?? {
      action,
      resource: "*",
      effect: "ask",
    }
  )
}

export function merge(...rulesets: Permission.Ruleset[]): Permission.Ruleset {
  return rulesets.flat()
}

export interface Interface {
  readonly ask: (input: AssertInput) => Effect.Effect<AskResult, SessionErrors.NotFoundError>
  readonly assert: (input: AssertInput) => Effect.Effect<void, Error | SessionErrors.NotFoundError>
  readonly reply: (input: ReplyInput) => Effect.Effect<void, NotFoundError>
  readonly get: (id: ID) => Effect.Effect<Request | undefined>
  readonly forSession: (sessionID: SessionSchema.ID) => Effect.Effect<ReadonlyArray<Request>>
  readonly list: () => Effect.Effect<ReadonlyArray<Request>>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Permission") {}

interface Pending {
  readonly request: Request
  readonly agent?: Agent.ID
  readonly deferred: Deferred.Deferred<void, DeclinedError | CorrectedError>
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const location = yield* Location.Service
    const agents = yield* Agent.Service
    const sessions = yield* SessionStore.Service
    const saved = yield* PermissionSaved.Service
    const hooks = yield* PluginHooks.Service
    const pending = new Map<ID, Pending>()

    yield* Effect.addFinalizer(() =>
      Effect.forEach(pending.values(), (item) => Deferred.fail(item.deferred, new DeclinedError()), {
        discard: true,
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            pending.clear()
          }),
        ),
      ),
    )

    const savedRules = Effect.fnUntraced(function* () {
      return (yield* saved.list({ projectID: location.project.id })).map(
        (item): Permission.Rule => ({
          action: item.action,
          resource: item.resource,
          effect: "allow",
        }),
      )
    })

    const configured = Effect.fnUntraced(function* (sessionID: SessionSchema.ID, agentID?: Agent.ID) {
      const session = yield* sessions.get(sessionID)
      if (!session) return yield* new SessionErrors.NotFoundError({ sessionID })
      const agent = yield* agents.resolve(agentID ?? session.agent)
      return merge(agent?.permissions ?? missingAgentPermissions, session.permissions ?? [])
    })

    function denied(input: Pick<Request, "action" | "resources">, rules: Permission.Ruleset) {
      return input.resources.some((resource) => evaluate(input.action, resource, rules).effect === "deny")
    }

    function relevant(input: AssertInput, rules: Permission.Ruleset) {
      return rules.filter((rule) => Wildcard.match(input.action, rule.action))
    }

    const evaluateInput = Effect.fnUntraced(function* (input: AssertInput) {
      const rules = yield* configured(input.sessionID, input.agent)
      if (denied(input, rules)) return { effect: "deny" as const, rules }
      const all = [...rules, ...(yield* savedRules())]
      const effects = input.resources.map((resource) => evaluate(input.action, resource, all).effect)
      const effect: Permission.Effect = effects.includes("ask") ? "ask" : "allow"
      const event = yield* hooks.trigger("permission", "evaluate", {
        sessionID: input.sessionID,
        agent: input.agent,
        action: input.action,
        resources: input.resources,
        metadata: input.metadata,
        source: input.source,
        effect,
      })
      return { effect: event.effect, message: event.message, rules: all }
    })

    function request(input: AssertInput, message?: string): Request {
      return {
        id: input.id ?? ID.create(),
        sessionID: input.sessionID,
        action: input.action,
        resources: input.resources,
        save: input.save,
        metadata: input.metadata,
        source: input.source,
        message,
      }
    }

    const create = (request: Request, agent?: Agent.ID) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          const deferred = yield* Deferred.make<void, DeclinedError | CorrectedError>()
          const item = { request, agent, deferred }
          if (pending.has(request.id))
            return yield* Effect.die(new Error(`Duplicate pending permission ID: ${request.id}`))
          pending.set(request.id, item)
          yield* bus
            .publish(Permission.Event.Asked, request)
            .pipe(Effect.onError(() => Effect.sync(() => pending.delete(request.id))))
          return item
        }),
      )

    const ask = Effect.fn("Permission.ask")(function* (input: AssertInput) {
      const result = yield* evaluateInput(input)
      const value = request(input, result.message)
      if (result.effect === "ask") yield* create(value, input.agent)
      return { id: value.id, effect: result.effect }
    })

    const assert = Effect.fn("Permission.assert")((input: AssertInput) =>
      Effect.gen(function* () {
        const result = yield* evaluateInput(input)
        return yield* Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            if (result.effect === "deny") {
              return yield* new BlockedError({
                rules: relevant(input, result.rules),
                permission: input.action,
                resources: input.resources,
                reason: result.message,
              })
            }
            if (result.effect === "allow") return
            const item = yield* create(request(input, result.message), input.agent)
            return yield* restore(Deferred.await(item.deferred)).pipe(
              // Deliberate defect tunnel: leaves wrap execution in blanket `mapError`, which
              // must not convert a user's decline into model-facing tool output. The decline
              // resurfaces as a typed failure at SessionModelRequest.executeTool. A decline
              // WITH feedback (CorrectedError) intentionally stays typed so the leaf can turn
              // it into ToolFailure and the model continues.
              Effect.catchTag("Permission.DeclinedError", (error) => Effect.die(error)),
              Effect.ensuring(
                Effect.sync(() => {
                  pending.delete(item.request.id)
                }),
              ),
            )
          }),
        )
      }),
    )

    const reply = Effect.fn("Permission.reply")((input: ReplyInput) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          const existing = pending.get(input.requestID)
          if (!existing) return yield* new NotFoundError({ requestID: input.requestID })
          yield* bus.publish(Permission.Event.Replied, {
            sessionID: existing.request.sessionID,
            requestID: existing.request.id,
            reply: input.reply,
          })

          if (input.reply === "reject") {
            yield* Deferred.fail(
              existing.deferred,
              input.message ? new CorrectedError({ feedback: input.message }) : new DeclinedError(),
            )
            pending.delete(input.requestID)
            for (const [id, item] of pending) {
              if (item.request.sessionID !== existing.request.sessionID) continue
              yield* bus.publish(Permission.Event.Replied, {
                sessionID: item.request.sessionID,
                requestID: item.request.id,
                reply: "reject",
              })
              yield* Deferred.fail(item.deferred, new DeclinedError())
              pending.delete(id)
            }
            return
          }

          if (input.reply === "always" && existing.request.save?.length) {
            yield* saved.add({
              projectID: location.project.id,
              action: existing.request.action,
              resources: existing.request.save,
            })
          }
          yield* Deferred.succeed(existing.deferred, undefined)
          pending.delete(input.requestID)
          if (input.reply !== "always" || !existing.request.save?.length) return

          for (const [id, item] of pending) {
            const result = yield* evaluateInput({ ...item.request, agent: item.agent }).pipe(
              Effect.catchTag("Session.NotFoundError", () => Effect.undefined),
            )
            if (result?.effect !== "allow") continue
            yield* bus.publish(Permission.Event.Replied, {
              sessionID: item.request.sessionID,
              requestID: item.request.id,
              reply: "always",
            })
            yield* Deferred.succeed(item.deferred, undefined)
            pending.delete(id)
          }
        }),
      ),
    )

    const list = Effect.fn("Permission.list")(function* () {
      return Array.from(pending.values(), (item) => item.request)
    })

    const get = Effect.fn("Permission.get")(function* (id: ID) {
      return pending.get(id)?.request
    })

    const forSession = Effect.fn("Permission.forSession")(function* (sessionID: SessionSchema.ID) {
      return Array.from(pending.values(), (item) => item.request).filter((request) => request.sessionID === sessionID)
    })

    return Service.of({ ask, assert, reply, get, forSession, list })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Bus.node, Location.node, Agent.node, SessionStore.node, PermissionSaved.node, PluginHooks.node],
})
