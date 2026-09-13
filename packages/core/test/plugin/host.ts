import { Plugin } from "@opencode/plugin/effect"
import type { IntegrationMethod } from "@opencode/plugin/effect/integration"
import { Agent } from "@opencode/core/agent"
import { Catalog } from "@opencode/core/catalog"
import { Credential } from "@opencode/core/credential"
import { Integration } from "@opencode/core/integration"
import { Location } from "@opencode/core/location"
import { Model } from "@opencode/core/model"
import { Project } from "@opencode/core/project"
import { Provider } from "@opencode/core/provider"
import { AbsolutePath } from "@opencode/core/schema"
import { WebSearch } from "@opencode/core/websearch"
import { Effect, Stream } from "effect"

type Overrides = Partial<Omit<Plugin.Context, "options" | "session">> & {
  readonly session?: Partial<Plugin.Context["session"]>
}
export function host(overrides: Overrides = {}): Plugin.Context {
  return {
    app: overrides.app ?? { name: "test", version: "test", channel: "test" },
    location:
      overrides.location ??
      new Location.Info({
        directory: AbsolutePath.make("/workspace"),
        project: {
          id: Project.ID.global,
          directory: AbsolutePath.make("/workspace"),
          canonical: AbsolutePath.make("/workspace"),
        },
      }),
    options: {},
    rpc:
      overrides.rpc ??
      Object.assign(
        () => {
          throw new Error("unused rpc.client")
        },
        { register: () => Effect.die("unused rpc.register") },
      ),
    agent: overrides.agent ?? {
      get: () => Effect.die("unused agent.get"),
      list: () => Effect.die("unused agent.list"),
      transform: () => Effect.die("unused agent.transform"),
      reload: () => Effect.die("unused agent.reload"),
    },
    aisdk: overrides.aisdk ?? {
      hook: () => Effect.die("unused aisdk.hook"),
    },
    catalog: overrides.catalog ?? {
      provider: {
        list: () => Effect.die("unused catalog.provider.list"),
        get: () => Effect.die("unused catalog.provider.get"),
      },
      model: {
        list: () => Effect.die("unused catalog.model.list"),
        default: () => Effect.die("unused catalog.model.default"),
      },
      transform: () => Effect.die("unused catalog.transform"),
      reload: () => Effect.die("unused catalog.reload"),
    },
    command: overrides.command ?? {
      list: () => Effect.die("unused command.list"),
      transform: () => Effect.die("unused command.transform"),
      reload: () => Effect.die("unused command.reload"),
    },
    event: overrides.event ?? {
      subscribe: () => Stream.empty,
    },
    experimental: overrides.experimental ?? {
      terminal: {
        read: () => Effect.die("unused experimental.terminal.read"),
      },
    },
    generate: overrides.generate ?? {
      text: () => Effect.die("unused generate.text"),
    },
    integration: overrides.integration ?? {
      list: () => Effect.die("unused integration.list"),
      get: () => Effect.die("unused integration.get"),
      connect: {
        key: () => Effect.die("unused integration.connect.key"),
      },
      oauth: {
        connect: () => Effect.die("unused integration.oauth.connect"),
        status: () => Effect.die("unused integration.oauth.status"),
        complete: () => Effect.die("unused integration.oauth.complete"),
        cancel: () => Effect.die("unused integration.oauth.cancel"),
      },
      command: {
        connect: () => Effect.die("unused integration.command.connect"),
        status: () => Effect.die("unused integration.command.status"),
        cancel: () => Effect.die("unused integration.command.cancel"),
      },
      transform: () => Effect.die("unused integration.transform"),
      reload: () => Effect.die("unused integration.reload"),
      connection: {
        active: () => Effect.die("unused integration.connection.active"),
        resolve: () => Effect.die("unused integration.connection.resolve"),
      },
    },
    mcp: overrides.mcp ?? {
      list: () => Effect.die("unused mcp.list"),
      transform: () => Effect.die("unused mcp.transform"),
      reload: () => Effect.die("unused mcp.reload"),
    },
    permission: overrides.permission ?? {
      hook: () => Effect.die("unused permission.hook"),
      list: () => Effect.die("unused permission.list"),
      get: () => Effect.die("unused permission.get"),
      reply: () => Effect.die("unused permission.reply"),
      rules: () => Effect.die("unused permission.rules"),
    },
    plugin: overrides.plugin ?? {
      list: () => Effect.die("unused plugin.list"),
    },
    reference: overrides.reference ?? {
      list: () => Effect.die("unused reference.list"),
      transform: () => Effect.die("unused reference.transform"),
      reload: () => Effect.die("unused reference.reload"),
    },
    skill: overrides.skill ?? {
      list: () => Effect.die("unused skill.list"),
      transform: () => Effect.die("unused skill.transform"),
      reload: () => Effect.die("unused skill.reload"),
    },
    storage: overrides.storage ?? {
      get: () => Effect.die("unused storage.get"),
      set: () => Effect.die("unused storage.set"),
      remove: () => Effect.die("unused storage.remove"),
      scan: () => Effect.die("unused storage.scan"),
    },
    shell: overrides.shell ?? {
      hook: () => Effect.die("unused shell.hook"),
    },
    tool: overrides.tool ?? {
      transform: () => Effect.die("unused tool.transform"),
      reload: () => Effect.die("unused tool.reload"),
      hook: () => Effect.die("unused tool.hook"),
    },
    vcs: overrides.vcs ?? {
      base: () => Effect.die("unused vcs.base"),
      get: () => Effect.die("unused vcs.get"),
      branches: () => Effect.die("unused vcs.branches"),
      status: () => Effect.die("unused vcs.status"),
      diff: () => Effect.die("unused vcs.diff"),
      transform: () => Effect.die("unused vcs.transform"),
      reload: () => Effect.die("unused vcs.reload"),
    },
    worktree: overrides.worktree ?? {
      list: () => Effect.die("unused worktree.list"),
      create: () => Effect.die("unused worktree.create"),
      remove: () => Effect.die("unused worktree.remove"),
      refresh: () => Effect.die("unused worktree.refresh"),
      transform: () => Effect.die("unused worktree.transform"),
      reload: () => Effect.die("unused worktree.reload"),
    },
    websearch: overrides.websearch ?? {
      providers: () => Effect.die("unused websearch.providers"),
      query: () => Effect.die("unused websearch.query"),
      transform: () => Effect.die("unused websearch.transform"),
      reload: () => Effect.die("unused websearch.reload"),
    },
    session: {
      hook: overrides.session?.hook ?? (() => Effect.die("unused session.hook")),
      create: overrides.session?.create ?? (() => Effect.die("unused session.create")),
      fork: overrides.session?.fork ?? (() => Effect.die("unused session.fork")),
      get: overrides.session?.get ?? (() => Effect.die("unused session.get")),
      switchAgent: overrides.session?.switchAgent ?? (() => Effect.die("unused session.switchAgent")),
      switchModel: overrides.session?.switchModel ?? (() => Effect.die("unused session.switchModel")),
      prompt: overrides.session?.prompt ?? (() => Effect.die("unused session.prompt")),
      generate: overrides.session?.generate ?? (() => Effect.die("unused session.generate")),
      command: overrides.session?.command ?? (() => Effect.die("unused session.command")),
      rename: overrides.session?.rename ?? (() => Effect.die("unused session.rename")),
      move: overrides.session?.move ?? (() => Effect.die("unused session.move")),
      synthetic: overrides.session?.synthetic ?? (() => Effect.die("unused session.synthetic")),
      interrupt: overrides.session?.interrupt ?? (() => Effect.die("unused session.interrupt")),
      wait: overrides.session?.wait ?? (() => Effect.die("unused session.wait")),
      context: overrides.session?.context ?? (() => Effect.die("unused session.context")),
    },
  }
}

export function agentHost(agent: Agent.Interface): Plugin.Context["agent"] {
  return {
    get: (input) =>
      agent.get(input.agentID).pipe(
        Effect.flatMap((value) =>
          value
            ? Effect.succeed({
                location: new Location.Info({
                  directory: AbsolutePath.make("/"),
                  project: {
                    id: Project.ID.make("test"),
                    directory: AbsolutePath.make("/"),
                    canonical: AbsolutePath.make("/"),
                  },
                }),
                data: agentInfo(value),
              })
            : Effect.fail(new Error(`Agent not found: ${input.agentID}`)),
        ),
      ),
    list: () => Effect.die("unused agent.list"),
    reload: agent.reload,
    transform: (callback) =>
      agent.transform((editor) =>
        callback({
          list: () => editor.list().map(agentInfo),
          get: (id) => {
            const value = editor.get(Agent.ID.make(id))
            return value && agentInfo(value)
          },
          default: (id) => editor.default(id === undefined ? undefined : Agent.ID.make(id)),
          update: (id, update) =>
            editor.update(Agent.ID.make(id), (value) => {
              const current = agentInfo(value)
              update(current)
              Object.assign(value, current, { id: Agent.ID.make(current.id) })
            }),
          remove: (id) => editor.remove(Agent.ID.make(id)),
        }),
      ),
  }
}

export function catalogHost(catalog: Catalog.Interface): Plugin.Context["catalog"] {
  return {
    provider: {
      list: () => Effect.die("unused catalog.provider.list"),
      get: () => Effect.die("unused catalog.provider.get"),
    },
    model: {
      list: () =>
        catalog.model.available().pipe(
          Effect.map((data) => ({
            location: new Location.Info({
              directory: AbsolutePath.make("/"),
              project: {
                id: Project.ID.make("test"),
                directory: AbsolutePath.make("/"),
                canonical: AbsolutePath.make("/"),
              },
            }),
            data: data.map(modelInfo),
          })),
        ),
      default: () => Effect.die("unused catalog.model.default"),
    },
    reload: catalog.reload,
    transform: (callback) =>
      catalog.transform((editor) =>
        callback({
          provider: {
            list: () =>
              editor.provider.list().map((value) => ({
                provider: providerInfo(value.provider),
                models: new Map(Array.from(value.models, ([id, model]) => [id, modelInfo(model)])),
              })),
            get: (id) => {
              const value = editor.provider.get(Provider.ID.make(id))
              return (
                value && {
                  provider: providerInfo(value.provider),
                  models: new Map(Array.from(value.models, ([id, model]) => [id, modelInfo(model)])),
                }
              )
            },
            update: (id, update) =>
              editor.provider.update(Provider.ID.make(id), (value) => {
                const current = providerInfo(value)
                update(current)
                Object.assign(value, current, { id: Provider.ID.make(current.id) })
              }),
            remove: (id) => editor.provider.remove(Provider.ID.make(id)),
          },
          model: {
            get: (providerID, modelID) => {
              const value = editor.model.get(Provider.ID.make(providerID), Model.ID.make(modelID))
              return value && modelInfo(value)
            },
            update: (providerID, modelID, update) =>
              editor.model.update(Provider.ID.make(providerID), Model.ID.make(modelID), (value) => {
                const current = modelInfo(value)
                update(current)
                Object.assign(value, current, {
                  id: Model.ID.make(current.id),
                  providerID: Provider.ID.make(current.providerID),
                  family: current.family === undefined ? undefined : Model.Family.make(current.family),
                  variants: current.variants?.map((variant) => ({
                    ...variant,
                    id: Model.VariantID.make(variant.id),
                  })),
                })
              }),
            remove: (providerID, modelID) => editor.model.remove(Provider.ID.make(providerID), Model.ID.make(modelID)),
            default: {
              get: () => {
                const value = editor.model.default.get()
                return value && { providerID: value.providerID, modelID: value.modelID }
              },
              set: (providerID, modelID) =>
                editor.model.default.set(Provider.ID.make(providerID), Model.ID.make(modelID)),
            },
          },
        }),
      ),
  }
}

export function integrationHost(integration: Integration.Interface): Plugin.Context["integration"] {
  return {
    list: () => Effect.die("unused integration.list"),
    get: () => Effect.die("unused integration.get"),
    connect: {
      key: () => Effect.die("unused integration.connect.key"),
    },
    oauth: {
      connect: () => Effect.die("unused integration.oauth.connect"),
      status: () => Effect.die("unused integration.oauth.status"),
      complete: () => Effect.die("unused integration.oauth.complete"),
      cancel: () => Effect.die("unused integration.oauth.cancel"),
    },
    command: {
      connect: () => Effect.die("unused integration.command.connect"),
      status: () => Effect.die("unused integration.command.status"),
      cancel: () => Effect.die("unused integration.command.cancel"),
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
      integration.transform((editor) =>
        callback({
          list: () => editor.list().map((value) => ({ id: value.id, name: value.name })),
          get: (id) => {
            const value = editor.get(Integration.ID.make(id))
            return value && { id: value.id, name: value.name }
          },
          update: (id, update) => editor.update(Integration.ID.make(id), update),
          remove: (id) => editor.remove(Integration.ID.make(id)),
          method: {
            list: (id) => editor.method.list(Integration.ID.make(id)),
            update: (input) => {
              if ("authorize" in input) {
                const methodID = Integration.MethodID.make(input.method.id)
                const refresh = input.refresh
                editor.method.update({
                  integrationID: Integration.ID.make(input.integrationID),
                  method: { ...input.method, id: methodID },
                  authorize: (answer) =>
                    input.authorize(answer).pipe(
                      Effect.map((authorization) => {
                        if (authorization.mode === "auto") {
                          return {
                            ...authorization,
                            callback: authorization.callback.pipe(
                              Effect.map((credential) =>
                                Credential.OAuth.make({
                                  ...credential,
                                  methodID: Integration.MethodID.make(credential.methodID),
                                }),
                              ),
                            ),
                          }
                        }
                        return {
                          ...authorization,
                          callback: (code: string) =>
                            authorization.callback(code).pipe(
                              Effect.map((credential) =>
                                Credential.OAuth.make({
                                  ...credential,
                                  methodID: Integration.MethodID.make(credential.methodID),
                                }),
                              ),
                            ),
                        }
                      }),
                    ),
                  ...(refresh
                    ? {
                        refresh: (value: Credential.OAuth) =>
                          refresh(value).pipe(
                            Effect.map((next) =>
                              Credential.OAuth.make({
                                ...next,
                                methodID: Integration.MethodID.make(next.methodID),
                              }),
                            ),
                          ),
                      }
                    : {}),
                  ...(input.label ? { label: input.label } : {}),
                })
                return
              }
              if (input.method.type === "env") {
                editor.method.update({
                  integrationID: Integration.ID.make(input.integrationID),
                  method: input.method,
                })
                return
              }
              if (input.method.type === "command") {
                editor.method.update({
                  integrationID: Integration.ID.make(input.integrationID),
                  method: {
                    ...input.method,
                    id: Integration.MethodID.make(input.method.id),
                  },
                })
                return
              }
              editor.method.update({
                integrationID: Integration.ID.make(input.integrationID),
                method: input.method,
              })
            },
            remove: (id, item) => editor.method.remove(Integration.ID.make(id), internalMethod(item)),
          },
        }),
      ),
  }
}

export function webSearchHost(websearch: WebSearch.Interface): Plugin.Context["websearch"] {
  const location = Location.Info.make({
    directory: AbsolutePath.make("/tmp/websearch-test"),
    project: {
      id: Project.ID.make("websearch-test"),
      directory: AbsolutePath.make("/tmp/websearch-test"),
      canonical: AbsolutePath.make("/tmp/websearch-test"),
    },
  })
  return {
    providers: () => websearch.providers().pipe(Effect.map((data) => ({ location, data }))),
    query: (input) =>
      websearch
        .query({ query: input.query, providerID: input.providerID && WebSearch.ID.make(input.providerID) })
        .pipe(Effect.map((data) => ({ location, data }))),
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
  }
}

function internalMethod(value: IntegrationMethod): Integration.Method {
  if (value.type === "oauth" || value.type === "command") {
    return { ...value, id: Integration.MethodID.make(value.id) }
  }
  return value
}

function agentInfo(value: Agent.Info) {
  return {
    ...value,
    model: value.model && { ...value.model },
    request: {
      settings: { ...value.request.settings },
      headers: { ...value.request.headers },
      body: { ...value.request.body },
    },
    permissions: value.permissions.map((permission) => ({ ...permission })),
  }
}

function providerInfo(value: Provider.MutableInfo) {
  return {
    ...value,
    settings: value.settings && { ...value.settings },
    headers: value.headers && { ...value.headers },
    body: value.body && { ...value.body },
  }
}

function modelInfo(value: Model.Info | Model.MutableInfo) {
  return {
    ...value,
    settings: value.settings && { ...value.settings },
    headers: value.headers && { ...value.headers },
    body: value.body && { ...value.body },
    capabilities: {
      ...value.capabilities,
      input: [...value.capabilities.input],
      output: [...value.capabilities.output],
    },
    variants: value.variants?.map((variant) => ({
      ...variant,
      settings: variant.settings && { ...variant.settings },
      headers: variant.headers && { ...variant.headers },
      body: variant.body && { ...variant.body },
    })),
    time: { ...value.time },
    cost: value.cost.map((cost) => ({ ...cost, tier: cost.tier && { ...cost.tier }, cache: { ...cost.cache } })),
    limit: { ...value.limit },
  }
}
