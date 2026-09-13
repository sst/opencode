export * as PluginHost from "./host.js"

import { Plugin } from "@opencode/plugin/effect"
import type { IntegrationMethodRegistration } from "@opencode/plugin/effect/integration"
import { EventManifest } from "@opencode/schema/event-manifest"
import type { Event } from "@opencode/schema/event"
import { ServerConfig } from "@opencode/schema/mcp"
import { App } from "../app.js"
import { Effect, Schema, Stream } from "effect"
import { Agent } from "../agent.js"
import { AISDK } from "../aisdk.js"
import { Catalog } from "../catalog.js"
import { Command } from "../command.js"
import { Credential } from "../credential.js"
import { Bus } from "../bus.js"
import { Integration } from "../integration.js"
import { KV } from "../kv.js"
import { Location } from "../location.js"
import { LocationServiceMap } from "../location-service-map.js"
import { Model } from "../model.js"
import { Mcp } from "../mcp/index.js"
import { Session } from "../session.js"
import { PersistentPty } from "../persistent-pty.js"
import { Provider } from "../provider.js"
import { Reference } from "../reference.js"
import { Rpc } from "../rpc.js"
import { AbsolutePath, type DeepMutable } from "../schema.js"
import { Skill } from "../skill.js"
import { Tool } from "../tool.js"
import { Workspace } from "../workspace.js"
import { Vcs } from "../vcs.js"
import { WebSearch } from "../websearch.js"
import { Worktree } from "../worktree.js"
import { WorktreeInventory } from "../worktree/inventory.js"
import { Generate } from "../generate.js"
import { Permission } from "../permission.js"
import { PluginHooks } from "./hooks.js"
import type { Interface } from "../plugin.js"
import { LayerNode } from "@opencode/util/effect/layer-node"

const mutable = <T>(value: T) => value as DeepMutable<T>
type RpcEvent = Event.Payload & {
  readonly type: `rpc.${string}`
  readonly location: Location.Ref
  readonly data: Readonly<Record<string, unknown>>
}
const isRpcEvent = (event: Event.Payload): event is RpcEvent => event.type.startsWith("rpc.")
export const make = Effect.fn("PluginHost.make")(function* (
  plugin: Pick<Interface, "list">,
  pluginID: string = "test",
) {
  const app = yield* App.Metadata
  const agents = yield* Agent.Service
  const aisdk = yield* AISDK.Service
  const catalog = yield* Catalog.Service
  const commands = yield* Command.Service
  const bus = yield* Bus.Service
  const integration = yield* Integration.Service
  const kv = yield* KV.Service
  const mcp = yield* Mcp.Service
  const location = yield* Location.Service
  const reference = yield* Reference.Service
  const rpc = yield* Rpc.Service
  const skill = yield* Skill.Service
  const tools = yield* Tool.Service
  const vcs = yield* Vcs.Service
  const websearch = yield* WebSearch.Service
  const generate = yield* Generate.Service
  const permission = yield* Permission.Service
  const hooks = yield* PluginHooks.Service
  const sessions = yield* Session.Service
  const persistentPty = yield* PersistentPty.Service
  const locations = yield* LocationServiceMap.Service
  const worktrees = yield* Worktree.Service
  const worktreeInventory = yield* WorktreeInventory.Service
  const locationInfo = () =>
    new Location.Info({
      directory: location.directory,
      workspaceID: location.workspaceID,
      project: location.project,
    })
  const locationRef = (input?: { readonly location?: { readonly directory?: string; readonly workspace?: string } }) =>
    input?.location === undefined
      ? undefined
      : Location.Ref.make({
          directory: AbsolutePath.make(input.location.directory ?? location.directory),
          workspaceID:
            input.location.workspace === undefined ? location.workspaceID : Workspace.ID.make(input.location.workspace),
        })
  const isCurrentLocation = (ref: Location.Ref) =>
    ref.directory === location.directory && ref.workspaceID === location.workspaceID
  const response = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.map((data) => ({ location: locationInfo(), data })))

  const atWorktree = <A, E>(
    ref: Location.Ref | undefined,
    run: (service: Worktree.Interface) => Effect.Effect<A, E>,
  ) => {
    if (ref?.workspaceID) return Effect.fail(new Worktree.UnsupportedLocationError({ directory: ref.directory }))
    if (!ref || isCurrentLocation(ref)) return run(worktrees)
    return Effect.gen(function* () {
      // Defer this import: Plugin's construction depends on this host. Same-location setup calls never wait on themselves.
      const { Plugin } = yield* Effect.promise(() => import("../plugin.js"))
      const plugins = yield* Plugin.Service
      const target = yield* Worktree.Service
      yield* plugins.awaitActivation
      return yield* run(target)
    }).pipe(Effect.provide(locations.get(ref)))
  }
  const decodeWorktree = Schema.decodeUnknownEffect(Worktree.Info)
  const decodeWorktrees = Schema.decodeUnknownEffect(Schema.Array(Worktree.ListEntry))

  const listAgents = Effect.fn("PluginHost.listAgents")((ref: Location.Ref) =>
    Effect.gen(function* () {
      const location = yield* Location.Service
      const agents = yield* Agent.Service
      return {
        location: new Location.Info({
          directory: location.directory,
          workspaceID: location.workspaceID,
          project: location.project,
        }),
        data: yield* agents.list(),
      }
    }).pipe(Effect.provide(locations.get(ref)), Effect.orDie),
  )

  // Keep the instance graph's inferred types independent of Session handles.
  const context: Plugin.Context = {
    app,
    location: locationInfo(),
    options: {},
    rpc: Object.assign(rpc.client, { register: rpc.register }),
    agent: {
      get: (input) => {
        const ref = locationRef(input)
        const output =
          ref && !isCurrentLocation(ref)
            ? listAgents(ref).pipe(
                Effect.map((result) => ({
                  ...result,
                  data: result.data.find((agent) => agent.id === input.agentID),
                })),
              )
            : response(agents.get(input.agentID))
        return output.pipe(
          Effect.flatMap((result) =>
            result.data
              ? Effect.succeed({ ...result, data: result.data })
              : Effect.fail(new Error(`Agent not found: ${input.agentID}`)),
          ),
        )
      },
      list: (input) => {
        const ref = locationRef(input)
        if (ref && !isCurrentLocation(ref)) return listAgents(ref)
        return response(agents.list())
      },
      reload: agents.reload,
      transform: (callback) =>
        agents.transform((editor) => {
          callback({
            list: () => mutable(editor.list()),
            get: (id) => mutable(editor.get(Agent.ID.make(id))),
            default: (id) => editor.default(id === undefined ? undefined : Agent.ID.make(id)),
            update: (id, update) => editor.update(Agent.ID.make(id), update),
            remove: (id) => editor.remove(Agent.ID.make(id)),
          })
        }),
    },
    aisdk: {
      hook: (name, callback, options) => {
        if (name === "sdk") {
          return aisdk.hook.sdk((event) => {
            if (options?.providerID !== undefined && options.providerID !== event.model.providerID) return Effect.void
            const output = {
              model: mutable(event.model),
              package: event.package,
              options: event.options,
              sdk: event.sdk,
            }
            return Reflect.apply(callback, undefined, [output]).pipe(
              Effect.tap(() => Effect.sync(() => (event.sdk = output.sdk))),
            )
          })
        }
        return aisdk.hook.language((event) => {
          if (options?.providerID !== undefined && options.providerID !== event.model.providerID) return Effect.void
          const output = {
            model: mutable(event.model),
            options: event.options,
            sdk: event.sdk,
            language: event.language,
          }
          return Reflect.apply(callback, undefined, [output]).pipe(
            Effect.tap(() => Effect.sync(() => (event.language = output.language))),
          )
        })
      },
    },
    catalog: {
      provider: {
        list: () => response(catalog.provider.available()),
        get: (input) =>
          catalog.provider
            .get(Provider.ID.make(input.providerID))
            .pipe(
              Effect.flatMap((provider) =>
                provider === undefined
                  ? Effect.fail(new Error(`Provider not found: ${input.providerID}`))
                  : response(Effect.succeed(provider)),
              ),
            ),
      },
      model: {
        list: () => response(catalog.model.available()),
        default: () => response(catalog.model.default()),
      },
      reload: catalog.reload,
      transform: (callback) =>
        catalog.transform((editor) => {
          callback({
            provider: {
              list: () => mutable(editor.provider.list()),
              get: (id) => mutable(editor.provider.get(Provider.ID.make(id))),
              update: (id, update) => editor.provider.update(Provider.ID.make(id), update),
              remove: (id) => editor.provider.remove(Provider.ID.make(id)),
            },
            model: {
              get: (providerID, modelID) =>
                mutable(editor.model.get(Provider.ID.make(providerID), Model.ID.make(modelID))),
              update: (providerID, modelID, update) =>
                editor.model.update(Provider.ID.make(providerID), Model.ID.make(modelID), update),
              remove: (providerID, modelID) =>
                editor.model.remove(Provider.ID.make(providerID), Model.ID.make(modelID)),
              default: {
                get: editor.model.default.get,
                set: (providerID, modelID) =>
                  editor.model.default.set(Provider.ID.make(providerID), Model.ID.make(modelID)),
              },
            },
          })
        }),
    },
    command: {
      list: () => response(commands.list()),
      reload: commands.reload,
      transform: commands.transform,
    },
    event: {
      subscribe: () =>
        bus
          .subscribe()
          .pipe(
            Stream.filter(
              (event): event is EventManifest.ServerEvent | RpcEvent =>
                EventManifest.isServer(event) || isRpcEvent(event),
            ),
          ),
    },
    experimental: {
      terminal: {
        read: (input) => persistentPty.read(input.sessionID, input.lines),
      },
    },
    generate: {
      text: (input) => generate.text(input).pipe(Effect.map((text) => ({ text }))),
    },
    integration: {
      list: () => response(integration.list()),
      get: (input) => response(integration.get(Integration.ID.make(input.integrationID))),
      connect: {
        key: (input) =>
          integration.connection.key({
            integrationID: Integration.ID.make(input.integrationID),
            key: input.key,
            answer: input.answer,
            label: input.label,
          }),
      },
      oauth: {
        connect: (input) =>
          response(
            integration.oauth.connect({
              integrationID: Integration.ID.make(input.integrationID),
              methodID: Integration.MethodID.make(input.methodID),
              answer: input.answer,
              label: input.label,
            }),
          ),
        status: (input) =>
          response(
            integration.oauth.status({
              integrationID: Integration.ID.make(input.integrationID),
              attemptID: Integration.AttemptID.make(input.attemptID),
            }),
          ),
        complete: (input) =>
          integration.oauth.complete({
            integrationID: Integration.ID.make(input.integrationID),
            attemptID: Integration.AttemptID.make(input.attemptID),
            code: input.code,
          }),
        cancel: (input) =>
          integration.oauth.cancel({
            integrationID: Integration.ID.make(input.integrationID),
            attemptID: Integration.AttemptID.make(input.attemptID),
          }),
      },
      command: {
        connect: (input) =>
          response(
            integration.command.connect({
              integrationID: Integration.ID.make(input.integrationID),
              methodID: Integration.MethodID.make(input.methodID),
              label: input.label,
            }),
          ),
        status: (input) =>
          response(
            integration.command.status({
              integrationID: Integration.ID.make(input.integrationID),
              attemptID: Integration.AttemptID.make(input.attemptID),
            }),
          ),
        cancel: (input) =>
          integration.command.cancel({
            integrationID: Integration.ID.make(input.integrationID),
            attemptID: Integration.AttemptID.make(input.attemptID),
          }),
      },
      reload: integration.reload,
      connection: {
        active: (id) => integration.connection.active(Integration.ID.make(id)),
        resolve: (connection) =>
          integration.connection.resolve(
            connection.type === "credential" ? { ...connection, id: Credential.ID.make(connection.id) } : connection,
          ),
      },
      transform: (callback) =>
        integration.transform((editor) => {
          callback({
            list: () => mutable(editor.list()),
            get: (id) => mutable(editor.get(Integration.ID.make(id))),
            update: (id, update) => editor.update(Integration.ID.make(id), update),
            remove: (id) => editor.remove(Integration.ID.make(id)),
            method: {
              list: (id) => editor.method.list(Integration.ID.make(id)),
              update: (input) => editor.method.update(methodImplementation(input)),
              remove: (id, method) =>
                editor.method.remove(Integration.ID.make(id), Schema.decodeUnknownSync(Integration.Method)(method)),
            },
          })
        }),
    },
    mcp: {
      list: (input) => {
        const ref = locationRef(input)
        if (ref && !isCurrentLocation(ref))
          return Effect.gen(function* () {
            const location = yield* Location.Service
            const mcp = yield* Mcp.Service
            return {
              location: new Location.Info({
                directory: location.directory,
                workspaceID: location.workspaceID,
                project: location.project,
              }),
              data: yield* mcp.servers(),
            }
          }).pipe(Effect.provide(locations.get(ref)))
        return response(mcp.servers())
      },
      reload: mcp.reload,
      transform: (callback) =>
        mcp.transform((editor) => {
          callback({
            list: () => editor.list().map(([name, config]) => [name, mutable(config)]),
            get: (name) => mutable(editor.get(name)),
            set: (name, config) => editor.set(name, Schema.decodeUnknownSync(ServerConfig)(config)),
            update: editor.update,
            remove: editor.remove,
          })
        }),
    },
    permission: {
      hook: (name, callback) => hooks.register("permission", name, callback),
      list: (input) => permission.forSession(input.sessionID),
      get: (input) =>
        permission
          .get(input.requestID)
          .pipe(
            Effect.flatMap((request) =>
              request?.sessionID === input.sessionID
                ? Effect.succeed(request)
                : Effect.fail(new Error(`Permission request not found: ${input.requestID}`)),
            ),
          ),
      reply: (input) =>
        permission
          .get(input.requestID)
          .pipe(
            Effect.flatMap((request) =>
              request?.sessionID === input.sessionID
                ? permission.reply({ requestID: input.requestID, reply: input.reply, message: input.message })
                : Effect.fail(new Error(`Permission request not found: ${input.requestID}`)),
            ),
          ),
      rules: sessions.setPermissions,
    },
    plugin: {
      list: () => response(plugin.list()),
    },
    reference: {
      list: () => response(reference.list()),
      reload: reference.reload,
      transform: (callback) =>
        reference.transform((editor) => {
          callback({
            add: (name, source) => editor.add(name, Schema.decodeUnknownSync(Reference.Source)(source)),
            remove: editor.remove,
            list: editor.list,
            get: editor.get,
          })
        }),
    },
    skill: {
      list: () => response(skill.list()),
      reload: skill.reload,
      transform: (callback) =>
        skill.transform((editor) => {
          callback({
            list: () => mutable(editor.list()),
            get: editor.get,
            add: (value) => editor.add(Schema.decodeUnknownSync(Skill.Info)(value)),
            update: editor.update,
            remove: editor.remove,
          })
        }),
    },
    storage: storage(kv, pluginID),
    shell: {
      hook: (name, callback) => hooks.register("shell", name, callback),
    },
    tool: {
      transform: tools.transform,
      reload: tools.reload,
      hook: (name, callback) => hooks.register("tool", name, callback),
    },
    vcs: {
      get: () => response(vcs.info()),
      base: () => response(vcs.base()),
      branches: (input) => response(vcs.branches({ search: input?.search, limit: input?.limit })),
      status: () => response(vcs.status()),
      diff: (input) => response(vcs.diff(input.mode, { context: input.context, base: input.base })),
      transform: vcs.transform,
      reload: vcs.reload,
    },
    websearch: {
      providers: () => response(websearch.providers()),
      query: (input) =>
        response(
          websearch.query({
            query: input.query,
            providerID: input.providerID === undefined ? undefined : WebSearch.ID.make(input.providerID),
          }),
        ),
      reload: websearch.reload,
      transform: (callback) =>
        websearch.transform((editor) => {
          callback({
            add: (definition) =>
              editor.add({
                id: WebSearch.ID.make(definition.id),
                name: definition.name,
                execute: definition.execute,
              }),
            default: {
              get: editor.default.get,
              set: (selection) =>
                editor.default.set(
                  selection === false || selection === "random" ? selection : WebSearch.ID.make(selection),
                ),
            },
          })
        }),
    },
    worktree: {
      inventory: worktreeInventory.list,
      list: (input) => atWorktree(locationRef(input), (service) => service.list()),
      create: (input) => atWorktree(locationRef(input), (service) => service.create(input)),
      refresh: (input) => atWorktree(locationRef(input), (service) => service.refresh()).pipe(Effect.asVoid),
      remove: (input) => atWorktree(locationRef(input), (service) => service.remove(input)),
      reload: worktrees.reload,
      transform: (callback) =>
        worktrees.transform((editor) =>
          callback({
            add: (definition) =>
              editor.add({
                id: Worktree.StrategyID.make(definition.id),
                create: (input) => definition.create(input).pipe(Effect.flatMap(decodeWorktree)),
                remove: (input) => definition.remove(input),
                list: (directory) => definition.list(directory).pipe(Effect.flatMap(decodeWorktrees)),
              }),
          }),
        ),
    },
    session: {
      hook: (name, callback, options) => hooks.register("session", name, callback, options),
      create: (input) =>
        sessions.create({
          id: input?.id,
          title: input?.title,
          agent: input?.agent,
          model: input?.model,
          metadata: input?.metadata,
          permissions: input?.permissions,
          location:
            input?.location ?? Location.Ref.make({ directory: location.directory, workspaceID: location.workspaceID }),
        }),
      get: (input) => sessions.get(input.sessionID),
      switchAgent: sessions.switchAgent,
      switchModel: sessions.switchModel,
      prompt: sessions.prompt,
      generate: (input) => sessions.generate(input).pipe(Effect.map((text) => ({ text }))),
      command: sessions.command,
      rename: sessions.rename,
      move: sessions.move,
      synthetic: sessions.synthetic,
      interrupt: (input) =>
        sessions
          .interrupt(input.sessionID, { continue: input.continue })
          .pipe(Effect.map((interrupted) => ({ interrupted }))),
      wait: (input) => sessions.wait(input.sessionID),
      context: (input) => sessions.context(input.sessionID),
    },
  }
  return context
})

export const requirements = LayerNode.group([
  App.node,
  Agent.node,
  AISDK.node,
  Catalog.node,
  Command.node,
  Bus.node,
  Integration.node,
  KV.node,
  Mcp.node,
  Location.node,
  Reference.node,
  Rpc.node,
  Skill.node,
  Tool.node,
  Vcs.node,
  WebSearch.node,
  Worktree.node,
  WorktreeInventory.node,
  Generate.node,
  Permission.node,
  PluginHooks.node,
  Session.node,
  PersistentPty.node,
  LocationServiceMap.node,
])

export function storage(kv: KV.Interface, pluginID: string): Plugin.Context["storage"] {
  const namespace = `plugin:${pluginID
    .split("")
    .map((value) => value.charCodeAt(0).toString(16).padStart(4, "0"))
    .join("")}:`
  return {
    get: (key) => kv.get(namespace + key),
    set: (key, value) => kv.set(namespace + key, value),
    remove: (key) => kv.remove(namespace + key),
    scan: (options) =>
      kv
        .scan({
          prefix: namespace + options.prefix,
          after: options.after === undefined ? undefined : namespace + options.after,
          limit: options.limit,
        })
        .pipe(
          Effect.map((result) => {
            const entries = result.entries.map((entry) => ({
              key: entry.key.slice(namespace.length),
              value: entry.value,
            }))
            if (result.next === undefined) return { entries }
            return { entries, next: result.next.slice(namespace.length) }
          }),
        ),
  }
}

function methodImplementation(input: IntegrationMethodRegistration): Integration.Implementation {
  if ("authorize" in input) {
    const refresh = input.refresh
    return {
      integrationID: Integration.ID.make(input.integrationID),
      method: { ...input.method, id: Integration.MethodID.make(input.method.id) },
      authorize: (answer) =>
        input.authorize(answer).pipe(
          Effect.map((authorization) => {
            if (authorization.mode === "auto") {
              return {
                ...authorization,
                callback: authorization.callback.pipe(Effect.map(credential)),
              }
            }
            return {
              ...authorization,
              callback: (code: string) => authorization.callback(code).pipe(Effect.map(credential)),
            }
          }),
        ),
      ...(refresh ? { refresh: (value: Credential.OAuth) => refresh(value).pipe(Effect.map(credential)) } : {}),
      ...(input.label ? { label: input.label } : {}),
    }
  }
  if (input.method.type === "env") {
    return {
      integrationID: Integration.ID.make(input.integrationID),
      method: input.method,
    }
  }
  if (input.method.type === "command") {
    return {
      integrationID: Integration.ID.make(input.integrationID),
      method: { ...input.method, id: Integration.MethodID.make(input.method.id) },
    }
  }
  return {
    integrationID: Integration.ID.make(input.integrationID),
    method: input.method,
  }
}

function credential(value: Credential.OAuth) {
  return Credential.OAuth.make({ ...value, methodID: Integration.MethodID.make(value.methodID) })
}
