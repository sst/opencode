export * as Mcp from "./index.js"

import { Mcp } from "@opencode/schema/mcp"
import { McpEvent } from "@opencode/schema/mcp-event"
import { ephemeral } from "@opencode/schema/event"
import type { Session } from "@opencode/schema/session"
import { createHash } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import { Cause, Context, Effect, Exit, FiberSet, Latch, Layer, Schema, Scope, Semaphore, Stream, Types } from "effect"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { Credential } from "../credential.js"
import { Bus } from "../bus.js"
import { Environment } from "../environment/index.js"
import { Form } from "../form.js"
import { Integration } from "../integration.js"
import { KeyedMutex } from "../effect/keyed-mutex.js"
import { Location } from "../location.js"
import { waitForAbort } from "@opencode/util/process"
import { State } from "../state.js"
import type { McpClient } from "./client.js"

export const ServerName = Schema.String.pipe(Schema.brand("MCP.ServerName"))
export const PromptsChanged = ephemeral({ type: "mcp.prompts.changed", schema: { server: Schema.String } })
export type ServerName = typeof ServerName.Type

// The status union is a public wire contract, so it lives in @opencode/schema and is re-exported here.
export const Status = Mcp.Status
export type Status = Mcp.Status

export class ServerInfo extends Schema.Class<ServerInfo>("MCP.ServerInfo")({
  name: ServerName,
  status: Status,
  integrationID: Integration.ID.pipe(Schema.optional),
}) {}

export class ServerInstructions extends Schema.Class<ServerInstructions>("MCP.ServerInstructions")({
  server: ServerName,
  instructions: Schema.String,
}) {}

export class Tool extends Schema.Class<Tool>("MCP.Tool")({
  server: ServerName,
  name: Schema.String,
  codemode: Schema.Boolean.pipe(Schema.optional),
  description: Schema.String.pipe(Schema.optional),
  inputSchema: Schema.Unknown.pipe(Schema.optional),
  outputSchema: Schema.Unknown.pipe(Schema.optional),
}) {}

export const ToolResultContent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
  Schema.Struct({ type: Schema.Literal("media"), data: Schema.String, mimeType: Schema.String }),
]).pipe(Schema.toTaggedUnion("type"))
export type ToolResultContent = typeof ToolResultContent.Type

export class ToolResult extends Schema.Class<ToolResult>("MCP.ToolResult")({
  server: ServerName,
  tool: Schema.String,
  isError: Schema.Boolean,
  structured: Schema.Unknown.pipe(Schema.optional),
  content: Schema.Array(ToolResultContent),
}) {}

export class PromptArgument extends Schema.Class<PromptArgument>("MCP.PromptArgument")({
  name: Schema.String,
  description: Schema.String.pipe(Schema.optional),
  required: Schema.Boolean.pipe(Schema.optional),
}) {}

export class Prompt extends Schema.Class<Prompt>("MCP.Prompt")({
  server: ServerName,
  name: Schema.String,
  description: Schema.String.pipe(Schema.optional),
  arguments: Schema.Array(PromptArgument).pipe(Schema.optional),
}) {}

export class PromptMessage extends Schema.Class<PromptMessage>("MCP.PromptMessage")({
  role: Schema.String,
  content: Schema.Unknown,
}) {}

export class PromptResult extends Schema.Class<PromptResult>("MCP.PromptResult")({
  server: ServerName,
  name: Schema.String,
  messages: Schema.Array(PromptMessage),
}) {}

export const Resource = Mcp.Resource
export type Resource = Mcp.Resource
export const ResourceTemplate = Mcp.ResourceTemplate
export type ResourceTemplate = Mcp.ResourceTemplate
export const ResourceCatalog = Mcp.ResourceCatalog
export type ResourceCatalog = Mcp.ResourceCatalog
export const ResourceContentPart = Mcp.ResourceContentPart
export type ResourceContentPart = Mcp.ResourceContentPart
export const ResourceContent = Mcp.ResourceContent
export type ResourceContent = Mcp.ResourceContent

export class NotFoundError extends Schema.TaggedError<NotFoundError>()("MCP.NotFoundError", {
  server: ServerName,
}) {
  override get message() {
    return `MCP server not found: ${this.server}`
  }
}

export class ToolCallError extends Schema.TaggedError<ToolCallError>()("MCP.ToolCallError", {
  server: ServerName,
  tool: Schema.String,
  message: Schema.String,
}) {}

type ServerEntry = {
  readonly config: Mcp.ServerConfig
  status: Status
  readonly startup: Latch.Latch
  scope?: Scope.Closeable
  client?: McpClient.Connection
  tools?: ReadonlyArray<Tool>
  prompts?: ReadonlyArray<Prompt>
  // Set when a remote server is registered as an OAuth integration; the credential lives in the global store.
  integrationID?: Integration.ID
  registration?: State.Registration
}

// MCP elicitations are Location-scoped, not Session-scoped: the server cannot attribute them to a
// persisted session row, so their forms are owned by this opaque sentinel session identifier.
const GLOBAL_ELICITATION_SESSION_ID = "global"
const URL_ELICITATION_FIELD_KEY = "elicitation"

type Data = {
  servers: Map<ServerName, Types.DeepMutable<Mcp.ServerConfig>>
  removed: Set<ServerName>
}

export type Editor = {
  list: () => readonly [ServerName, Types.DeepMutable<Mcp.ServerConfig>][]
  get: (server: ServerName | string) => Types.DeepMutable<Mcp.ServerConfig> | undefined
  set: (server: ServerName | string, config: Mcp.ServerConfig) => void
  update: (server: ServerName | string, update: (config: Types.DeepMutable<Mcp.ServerConfig>) => void) => void
  remove: (server: ServerName | string) => void
}

const cloneConfig = (config: Mcp.ServerConfig) => structuredClone(config) as Types.DeepMutable<Mcp.ServerConfig>

export interface Interface extends State.Transformable<Editor> {
  readonly servers: () => Effect.Effect<ServerInfo[]>
  readonly add: (server: ServerName | string, config: Mcp.ServerConfig) => Effect.Effect<void>
  readonly connect: (server: ServerName | string) => Effect.Effect<void, NotFoundError>
  readonly disconnect: (server: ServerName | string) => Effect.Effect<void, NotFoundError>
  readonly remove: (server: ServerName | string) => Effect.Effect<void, NotFoundError>
  readonly tools: () => Effect.Effect<Tool[]>
  readonly callTool: (input: {
    readonly server: ServerName | string
    readonly name: string
    readonly args?: Record<string, unknown>
    readonly sessionID?: Session.ID
  }) => Effect.Effect<ToolResult, NotFoundError | ToolCallError>
  readonly instructions: () => Effect.Effect<ServerInstructions[]>
  readonly prompts: () => Effect.Effect<Prompt[]>
  readonly prompt: (input: {
    readonly server: ServerName | string
    readonly name: string
    readonly args?: Record<string, string>
  }) => Effect.Effect<PromptResult | undefined, NotFoundError>
  readonly resourceCatalog: () => Effect.Effect<ResourceCatalog>
  readonly readResource: (input: {
    readonly server: ServerName | string
    readonly uri: string
  }) => Effect.Effect<ResourceContent | undefined, NotFoundError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/MCP") {}

export const Options = Schema.Struct({
  clientInfo: Schema.optional(
    Schema.Struct({
      name: Schema.String,
      version: Schema.String,
    }),
  ),
})
export type Options = typeof Options.Type

export const layer = (options?: Options) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const location = yield* Location.Service
      const environment = yield* Environment.Service
      const bus = yield* Bus.Service
      const forms = yield* Form.Service
      const integration = yield* Integration.Service
      const credentials = yield* Credential.Service
      const root = yield* Effect.scope
      const fork = yield* FiberSet.makeRuntime<never, void, never>()

      // Materialized definitions and live connections are kept separate so operational additions
      // survive unrelated definition reloads.
      const entries = new Map<ServerName, ServerEntry>()
      // Serializes lifecycle operations per server. Anything taking this lock from a connection
      // callback must stay forked: lifecycle operations close scopes while holding it, firing onClose.
      const locks = KeyedMutex.makeUnsafe<ServerName>()
      const urlElicitations = new Map<string, Form.ID>()

      // Register every remote server as an OAuth integration so credentials live in the global store
      // rather than in committed config. Servers that connect anonymously simply never use the method.
      const owned = new Set<Integration.ID>()
      const register = Effect.fnUntraced(function* (name: ServerName, entry: ServerEntry) {
        if (entry.config.type !== "remote" || entry.config.oauth === false) return
        const remote = entry.config
        // Key identity on name + url, not url alone: two configs for the same url under different names are
        // distinct logical servers that may hold different accounts, so they must not share a credential row.
        const suffix =
          "mcp_" +
          createHash("sha1")
            .update(name + "\u0000" + remote.url)
            .digest("hex")
            .slice(0, 16)
        const integrationID = Integration.ID.make(suffix)
        entry.integrationID = integrationID
        owned.add(integrationID)
        const methodID = Integration.MethodID.make(suffix)
        // Each registration gets its own child scope so disposal detaches it from the root scope
        // entirely; registering directly on root would accumulate a dead finalizer per replaced or
        // removed server for the lifetime of the layer.
        const scope = yield* Scope.fork(root)
        entry.registration = { dispose: Scope.close(scope, Exit.void) }
        yield* integration
          .transform((editor) => {
            editor.update(integrationID, (ref) => {
              ref.name = name
              ref.metadata = { source: "mcp" }
            })
            editor.method.update({
              integrationID,
              method: { id: methodID, type: "oauth", label: name },
              authorize: () =>
                Effect.gen(function* () {
                  const { McpOAuth } = yield* Effect.promise(() => import("./oauth.js"))
                  return yield* McpOAuth.authorize({ name, config: remote, methodID })
                }),
            })
          })
          .pipe(Scope.provide(scope))
      })
      const requireServer = Effect.fnUntraced(function* (server: ServerName | string) {
        const name = ServerName.make(server)
        const entry = entries.get(name)
        if (!entry) return yield* new NotFoundError({ server: name })
        return { name, entry }
      })

      // Builds the connect-time auth provider for a remote OAuth-integration server. The SDK presents and
      // refreshes stored tokens, persisting refreshes back to the same credential row. The provider never
      // opens a browser, so an auth-gated connect ends in UnauthorizedError -> needs_auth rather than a redirect.
      const connectProvider = Effect.fnUntraced(function* (entry: ServerEntry) {
        if (entry.config.type !== "remote" || !entry.integrationID) return undefined
        const { McpOAuth } = yield* Effect.promise(() => import("./oauth.js"))
        const remote = entry.config
        const oauth = remote.oauth || undefined
        const run = Effect.runPromiseWith(yield* Effect.context())
        const base = {
          redirectUrl: oauth?.redirect_uri ?? "http://127.0.0.1/callback",
          scope: oauth?.scope,
          client: oauth?.client_id ? { id: oauth.client_id, secret: oauth.client_secret } : undefined,
          // No browser during connect: an auth-gated server surfaces needs_auth instead of opening a browser.
          onRedirect: () => run(Effect.logInfo("mcp oauth authorization required")),
        }
        const found = (yield* credentials.list(entry.integrationID)).at(-1)
        if (!found || found.value.type !== "oauth") {
          // No stored credential yet: an empty in-memory store still lets the SDK run the auth handshake, which
          // ends in UnauthorizedError -> needs_auth. Returning no provider instead would let the transport throw
          // a raw HTTP error, hiding the auth requirement behind a generic failed status. Anonymous servers are
          // unaffected: tokens() returns undefined, so no auth header is sent and the SDK never calls auth().
          yield* Effect.logInfo("mcp oauth credential unavailable", {
            integrationID: entry.integrationID,
            reason: found ? "not_oauth" : "missing",
          })
          return McpOAuth.provider({ ...base, store: McpOAuth.memoryStore() })
        }
        const credentialID = found.id
        const methodID = found.value.methodID
        const fields = { credentialID, integrationID: entry.integrationID }
        yield* Effect.logInfo("mcp oauth credential loaded", {
          ...fields,
          hasRefreshToken: Boolean(found.value.refresh),
          hasClientInformation: Boolean(McpOAuth.clientFromCredential(found.value)),
          expiresAt: found.value.expires,
          expired: found.value.expires !== 0 && found.value.expires <= Date.now(),
        })
        // Tracks the refresh token this provider last presented, so invalidate can tell whether the SDK
        // rejected the currently-stored credential or a snapshot another connection has already rotated past.
        let presented = found.value.refresh
        const bound = McpOAuth.issuerFromCredential(found.value)
        let issuer: string | undefined
        const readOAuthCredential = async () => {
          const stored = await run(credentials.get(credentialID))
          return stored?.value.type === "oauth" ? stored.value : undefined
        }
        return McpOAuth.provider({
          ...base,
          onDiscovery: async (discovery) => {
            issuer = discovery.authorizationServerMetadata?.issuer
            if (bound && issuer && bound !== issuer)
              await run(Effect.logWarning("mcp oauth issuer changed", { ...fields, expected: bound, actual: issuer }))
          },
          // Drop a credential the SDK rejected so the next connect cleanly reports needs_auth — but only if it is
          // still the stored one. Rotating servers hand out a fresh refresh token per use, so a concurrent
          // connection may have already replaced ours; deleting then would discard the newer valid credential and
          // strand every connection in needs_auth until a manual re-auth. Credential deletion notifies all locations;
          // reconnects remain serialized by the server lock.
          invalidate: async (scope) => {
            if (scope === "verifier" || scope === "discovery") {
              await run(
                Effect.logDebug("mcp oauth invalidation skipped", { ...fields, scope, reason: "not_credentials" }),
              )
              return
            }
            const oauth = await readOAuthCredential()
            if (!oauth || oauth.refresh !== presented) {
              await run(
                Effect.logInfo("mcp oauth invalidation skipped", {
                  ...fields,
                  scope,
                  reason: oauth ? "token_rotated" : "credential_missing",
                }),
              )
              return
            }
            await run(Effect.logWarning("mcp oauth credential invalidation requested", { ...fields, scope }))
            await run(credentials.remove(credentialID))
          },
          // Always read the latest stored tokens instead of caching at connect time: with refresh-token rotation,
          // a cached snapshot goes stale the moment another connection refreshes, and re-presenting the consumed
          // token fails with invalid_grant.
          store: {
            tokens: async () => {
              const oauth = await readOAuthCredential()
              if (!oauth) return undefined
              presented = oauth.refresh
              return McpOAuth.toTokens(oauth, issuer)
            },
            saveTokens: async (tokens) => {
              const previous = await readOAuthCredential()
              const value = McpOAuth.toCredential({
                methodID,
                serverUrl: remote.url,
                tokens,
                client: previous ? McpOAuth.clientFromCredential(previous) : undefined,
                issuer: (previous && McpOAuth.issuerFromCredential(previous)) || issuer,
              })
              presented = value.refresh
              await run(
                Effect.logInfo("mcp oauth tokens received", {
                  ...fields,
                  credentialPresent: Boolean(previous),
                  refreshRotated: Boolean(previous && previous.refresh !== value.refresh),
                  hasRefreshToken: Boolean(value.refresh),
                  expiresAt: value.expires,
                }),
              )
              await run(credentials.update(credentialID, { value }))
            },
            clientInformation: async () => {
              const oauth = await readOAuthCredential()
              return oauth ? McpOAuth.clientFromCredential(oauth) : undefined
            },
            saveClientInformation: async () => {},
            codeVerifier: async () => undefined,
            saveCodeVerifier: async () => {},
          },
        })
      })

      const elicitation = {
        create: (input: {
          readonly server: string
          readonly params: McpClient.ElicitationParams
          readonly signal: AbortSignal
        }) =>
          Effect.gen(function* () {
            if (input.params.mode === "url") {
              const formID = Form.ID.create()
              const key = input.server + "\u0000" + input.params.elicitationId
              urlElicitations.set(key, formID)
              return yield* forms
                .ask({
                  id: formID,
                  sessionID: GLOBAL_ELICITATION_SESSION_ID,
                  title: `${input.server} is requesting input`,
                  metadata: {
                    kind: "mcp-elicitation",
                    server: input.server,
                    elicitationID: input.params.elicitationId,
                    message: input.params.message,
                  },
                  fields: [{ key: URL_ELICITATION_FIELD_KEY, type: "external", url: input.params.url }],
                })
                .pipe(
                  Effect.raceFirst(waitForAbort(input.signal)),
                  Effect.ensuring(Effect.sync(() => urlElicitations.delete(key))),
                  Effect.map(
                    (state): McpClient.ElicitationResult => ({
                      action: state.status === "answered" ? "accept" : "cancel",
                    }),
                  ),
                )
            }
            const params = input.params
            const [field, ...fields] = Object.entries(params.requestedSchema.properties).map(([key, property]) =>
              toElicitationField(key, property, params.requestedSchema.required?.includes(key) === true),
            )
            if (!field) return { action: "accept", content: {} }
            return yield* forms
              .ask({
                sessionID: GLOBAL_ELICITATION_SESSION_ID,
                title: `${input.server} is requesting input`,
                metadata: { kind: "mcp-elicitation", server: input.server, message: params.message },
                fields: [field, ...fields],
              })
              .pipe(
                Effect.raceFirst(waitForAbort(input.signal)),
                Effect.map((state): McpClient.ElicitationResult => {
                  if (state.status !== "answered") return { action: "cancel" }
                  return {
                    action: "accept",
                    content: Object.fromEntries(
                      Object.entries(state.answer).map(
                        ([key, value]): [string, NonNullable<McpClient.ElicitationResult["content"]>[string]] =>
                          typeof value === "object" ? [key, Array.from(value)] : [key, value],
                      ),
                    ),
                  }
                }),
              )
          }),
        complete: (input: { readonly server: string; readonly elicitationID: string }) =>
          Effect.gen(function* () {
            const formID = urlElicitations.get(input.server + "\u0000" + input.elicitationID)
            if (!formID) return
            yield* forms.reply({ id: formID, answer: { [URL_ELICITATION_FIELD_KEY]: true } }).pipe(Effect.ignore)
          }),
      } satisfies McpClient.ElicitationHandler

      const toTool = (server: ServerName, entry: ServerEntry, def: McpClient.ToolDefinition) =>
        new Tool({
          server,
          name: def.name,
          codemode: entry.config.codemode,
          description: def.description,
          inputSchema: def.inputSchema,
          outputSchema: def.outputSchema,
        })

      const toPrompt = (server: ServerName, def: McpClient.PromptDefinition) =>
        new Prompt({
          server,
          name: def.name,
          description: def.description,
          arguments: def.arguments?.map(
            (argument) =>
              new PromptArgument({
                name: argument.name,
                description: argument.description,
                required: argument.required,
              }),
          ),
        })

      const toResource = (server: ServerName, def: McpClient.ResourceDefinition) =>
        Resource.make({
          server,
          name: def.name,
          uri: def.uri,
          description: def.description,
          mimeType: def.mimeType,
        })

      const toResourceTemplate = (server: ServerName, def: McpClient.ResourceTemplateDefinition) =>
        ResourceTemplate.make({
          server,
          name: def.name,
          uriTemplate: def.uriTemplate,
          description: def.description,
          mimeType: def.mimeType,
        })

      const refreshTools = (name: ServerName, entry: ServerEntry, connection: McpClient.Connection) =>
        connection.tools().pipe(
          Effect.map((defs) => {
            entry.tools = defs.map((def) => toTool(name, entry, def))
          }),
        )

      const refreshPrompts = (name: ServerName, entry: ServerEntry, connection: McpClient.Connection) =>
        connection.prompts().pipe(
          Effect.orElseSucceed(() => []),
          Effect.map((defs) => {
            entry.prompts = defs.map((def) => toPrompt(name, def))
          }),
          Effect.andThen(bus.publish(PromptsChanged, { server: name })),
        )

      // Runs a connection callback under the server lock, dropping it if the connection is no longer
      // the entry's live client, so late SDK callbacks cannot commit obsolete state.
      const whenLive =
        (name: ServerName, entry: ServerEntry, connection: McpClient.Connection) =>
        <E>(effect: Effect.Effect<void, E>) =>
          fork(
            Effect.suspend(() => (entry.client === connection ? effect : Effect.void)).pipe(
              locks.withLock(name),
              Effect.ignore,
            ),
          )

      const watch = (name: ServerName, entry: ServerEntry, connection: McpClient.Connection) => {
        const live = whenLive(name, entry, connection)
        connection.onClose(() =>
          live(
            Effect.gen(function* () {
              entry.status = { status: "failed", error: "Connection closed" }
              yield* stopServer(name, entry)
              yield* bus.publish(McpEvent.StatusChanged, { server: name })
            }),
          ),
        )
        connection.onLog((message) => fork(serverLog(name, message)))
        connection.onToolsChanged(() =>
          live(
            refreshTools(name, entry, connection).pipe(
              Effect.andThen(bus.publish(McpEvent.ToolsChanged, { server: name })),
            ),
          ),
        )
        connection.onPromptsChanged(() => live(refreshPrompts(name, entry, connection)))
        connection.onResourcesChanged(() => live(bus.publish(McpEvent.ResourcesChanged, { server: name })))
      }

      const serverLog = (server: ServerName, message: McpClient.LogMessage) => {
        const fields = { server, logger: message.logger, level: message.level, data: message.data }
        switch (message.level) {
          case "debug":
            return Effect.logDebug("MCP server log", fields)
          case "info":
          case "notice":
            return Effect.logInfo("MCP server log", fields)
          case "warning":
            return Effect.logWarning("MCP server log", fields)
          case "error":
          case "critical":
          case "alert":
          case "emergency":
            return Effect.logError("MCP server log", fields)
        }
      }

      const startServer = (name: ServerName, entry: ServerEntry) =>
        Effect.gen(function* () {
          // Announce the handshake so connect() and credential reconnects don't show a stale
          // disabled/failed status for the duration of the connection attempt.
          entry.status = { status: "pending" }
          yield* bus.publish(McpEvent.StatusChanged, { server: name })
          const scope = yield* Scope.fork(root)
          entry.scope = scope
          const authProvider = yield* connectProvider(entry)
          const { McpClient } = yield* Effect.promise(() => import("./client.js"))
          // List tools as part of connect so a failure here marks the server failed rather than
          // leaving it connected with a silently empty tool list and no path to recover.
          const result = yield* McpClient.connect(
            name,
            entry.config,
            location.directory,
            authProvider,
            elicitation,
            options?.clientInfo,
          ).pipe(
            Effect.flatMap((connection) => connection.tools().pipe(Effect.map((tools) => ({ connection, tools })))),
            // A stdio server is spawned on this location's execution plane, not the host's.
            Effect.provideService(Environment.Service, environment),
            Scope.provide(scope),
            Effect.exit,
          )
          if (Exit.isSuccess(result)) {
            entry.client = result.value.connection
            entry.tools = result.value.tools.map((def) => toTool(name, entry, def))
            entry.prompts = []
            entry.status = { status: "connected" }
            watch(name, entry, result.value.connection)
            yield* Effect.logInfo("mcp connected", { server: name, tools: entry.tools.length })
            // Announce the new tool set so the tool registry registers it. A server that finishes connecting
            // after the initial registration sweep and emits no list-changed notification would otherwise
            // stay invisible to the model.
            yield* bus.publish(McpEvent.ToolsChanged, { server: name })
            yield* bus.publish(McpEvent.ResourcesChanged, { server: name })
            yield* bus.publish(McpEvent.StatusChanged, { server: name })
            whenLive(name, entry, result.value.connection)(refreshPrompts(name, entry, result.value.connection))
            return
          }
          yield* Scope.close(scope, Exit.void)
          entry.scope = undefined
          const error = Cause.squash(result.cause)
          entry.status =
            error instanceof McpClient.NeedsAuthError
              ? { status: "needs_auth" }
              : { status: "failed", error: error instanceof Error ? error.message : String(error) }
          yield* Effect.logWarning("mcp connect failed", { server: name, status: entry.status })
          yield* bus.publish(McpEvent.StatusChanged, { server: name })
        }).pipe(
          Effect.ensuring(entry.startup.open),
          Effect.annotateLogs({ server: name, directory: location.directory, connectionID: crypto.randomUUID() }),
        )

      const stopServer = Effect.fnUntraced(function* (name: ServerName, entry: ServerEntry) {
        const scope = entry.scope
        if (!scope) return
        entry.scope = undefined
        entry.client = undefined
        entry.tools = undefined
        entry.prompts = undefined
        yield* Scope.close(scope, Exit.void)
        yield* bus.publish(McpEvent.ToolsChanged, { server: name })
        yield* bus.publish(McpEvent.ResourcesChanged, { server: name })
        yield* bus.publish(PromptsChanged, { server: name })
      })

      const disposeServer = Effect.fnUntraced(function* (name: ServerName, entry: ServerEntry) {
        yield* stopServer(name, entry)
        if (entry.integrationID) owned.delete(entry.integrationID)
        if (entry.registration) yield* entry.registration.dispose
      })

      const replaceServer = Effect.fnUntraced(function* (name: ServerName, serverConfig: Mcp.ServerConfig) {
        const previous = entries.get(name)
        if (previous) yield* disposeServer(name, previous)
        const entry: ServerEntry = {
          config: serverConfig,
          status: { status: "pending" },
          startup: Latch.makeUnsafe(),
        }
        entries.set(name, entry)
        yield* Effect.gen(function* () {
          yield* register(name, entry)
          if (serverConfig.disabled) {
            entry.status = { status: "disabled" }
            yield* bus.publish(McpEvent.StatusChanged, { server: name })
            return
          }
          yield* startServer(name, entry)
        }).pipe(
          // Settle startup even when registration fails or replacement is interrupted, so readers cannot hang.
          Effect.ensuring(entry.startup.open),
        )
      })

      const removeServer = Effect.fnUntraced(function* (name: ServerName) {
        const entry = entries.get(name)
        if (!entry) return
        yield* disposeServer(name, entry)
        // Credentials are keyed by name + URL and intentionally survive removal for a later re-add.
        entries.delete(name)
        yield* bus.publish(McpEvent.StatusChanged, { server: name })
      })

      let applied: Map<ServerName, Mcp.ServerConfig> | undefined
      const overrides = new Map<ServerName, Mcp.ServerConfig | false>()
      const reconcileLock = Semaphore.makeUnsafe(1)
      const reconcile = Effect.fnUntraced(function* () {
        const servers = state.get().servers
        if (!applied && entries.size === 0) {
          for (const [name, server] of servers) {
            entries.set(name, {
              config: server,
              status: { status: "pending" },
              startup: Latch.makeUnsafe(),
            })
          }
          yield* Effect.forEach(entries, ([name, entry]) => register(name, entry), { discard: true })
          applied = servers

          // Initial connections stay asynchronous so one slow server does not block Location startup.
          for (const [name, entry] of entries) {
            if (entry.config.disabled) {
              entry.status = { status: "disabled" }
              entry.startup.openUnsafe()
              yield* bus.publish(McpEvent.StatusChanged, { server: name })
              continue
            }
            fork(startServer(name, entry).pipe(locks.withLock(name)))
          }
          return
        }

        const names = new Set([...(applied?.keys() ?? []), ...servers.keys()])
        for (const name of names) {
          const previous = applied?.get(name)
          const updated = servers.get(name)
          if (isDeepStrictEqual(previous, updated)) continue
          if (!updated) {
            yield* removeServer(name).pipe(locks.withLock(name))
            continue
          }
          yield* replaceServer(name, updated).pipe(locks.withLock(name))
        }
        applied = servers
      })

      // Bring a server online (or back to needs_auth) when its integration's credential changes, so an
      // OAuth login takes effect without a restart. Only fires for the integrations we registered.
      const reconnect = (integrationID: Integration.ID) =>
        Effect.gen(function* () {
          const match = Array.from(entries).find(([, entry]) => entry.integrationID === integrationID)
          if (!match) return
          const name = match[0]
          yield* Effect.gen(function* () {
            // add() or remove() may have replaced or deleted the entry while we waited for the lock.
            const entry = entries.get(name)
            if (!entry || entry.integrationID !== integrationID) return
            if (entry.status.status === "disabled") return
            yield* stopServer(name, entry)
            yield* startServer(name, entry)
          }).pipe(locks.withLock(name))
        })
      fork(
        bus.subscribe(Credential.Event.Switched).pipe(
          Stream.filter((event) => owned.has(event.data.integrationID)),
          Stream.runForEach((event) => Effect.sync(() => fork(reconnect(event.data.integrationID)))),
        ),
      )
      const state: State.Interface<Data, Editor> = State.create<Data, Editor>({
        name: "mcp",
        initial: () => ({
          servers: new Map(
            Array.from(overrides).flatMap(([name, config]) =>
              config === false ? [] : [[name, cloneConfig(config)] as const],
            ),
          ),
          removed: new Set(Array.from(overrides).flatMap(([name, config]) => (config === false ? [name] : []))),
        }),
        editor: (editor) => ({
          list: () => Array.from(editor.servers),
          get: (server) => editor.servers.get(ServerName.make(server)),
          set: (server, serverConfig) => {
            const name = ServerName.make(server)
            if (editor.removed.has(name)) return
            editor.servers.set(name, cloneConfig(serverConfig))
          },
          update: (server, update) => {
            const current = editor.servers.get(ServerName.make(server))
            if (!current) return
            update(current)
          },
          remove: (server) => editor.servers.delete(ServerName.make(server)),
        }),
        notify: () => State.reconcile(root, fork, () => reconcileLock.withPermit(reconcile())),
      })

      // Suspend so each await sees current entries; a bare Map iterator is exhausted after one run.
      const whenAllReady = Effect.suspend(() =>
        Effect.forEach(Array.from(entries.values()), (entry) => entry.startup.await, {
          concurrency: "unbounded",
          discard: true,
        }),
      )
      return Service.of({
        transform: state.transform,
        reload: state.reload,
        servers: Effect.fn("MCP.servers")(function* () {
          return Array.from(entries)
            .toSorted(([a], [b]) => a.localeCompare(b))
            .map(([name, entry]) => new ServerInfo({ name, status: entry.status, integrationID: entry.integrationID }))
        }),
        add: Effect.fn("MCP.add")(function* (server, config) {
          const name = ServerName.make(server)
          overrides.set(name, config)
          yield* state.reload()
        }),
        connect: Effect.fn("MCP.connect")(function* (server) {
          const name = ServerName.make(server)
          yield* Effect.gen(function* () {
            const target = yield* requireServer(name)
            yield* stopServer(name, target.entry)
            yield* startServer(name, target.entry)
          }).pipe(locks.withLock(name))
        }),
        disconnect: Effect.fn("MCP.disconnect")(function* (server) {
          const name = ServerName.make(server)
          yield* Effect.gen(function* () {
            const target = yield* requireServer(name)
            yield* stopServer(name, target.entry)
            target.entry.status = { status: "disabled" }
            yield* bus.publish(McpEvent.StatusChanged, { server: name })
          }).pipe(locks.withLock(name))
        }),
        remove: Effect.fn("MCP.remove")(function* (server) {
          const name = ServerName.make(server)
          yield* requireServer(name)
          overrides.set(name, false)
          yield* state.reload()
        }),
        tools: Effect.fn("MCP.tools")(function* () {
          yield* whenAllReady
          return Array.from(entries.values())
            .flatMap((entry) => entry.tools ?? [])
            .toSorted((a, b) => a.server.localeCompare(b.server) || a.name.localeCompare(b.name))
        }),
        callTool: Effect.fn("MCP.callTool")(function* (input) {
          const target = yield* requireServer(input.server)
          yield* target.entry.startup.await
          if (!target.entry.client)
            return yield* new ToolCallError({
              server: target.name,
              tool: input.name,
              message: "MCP server is not connected",
            })
          const result = yield* target.entry.client
            .callTool({ name: input.name, args: input.args, sessionID: input.sessionID })
            .pipe(
              Effect.mapError(
                (error) => new ToolCallError({ server: target.name, tool: input.name, message: error.message }),
              ),
            )
          return new ToolResult({
            server: target.name,
            tool: input.name,
            isError: result.isError,
            structured: result.structured,
            content: result.content,
          })
        }),
        instructions: Effect.fn("MCP.instructions")(function* () {
          yield* whenAllReady
          return Array.from(entries)
            .flatMap(([server, entry]) => {
              const instructions = entry.client?.instructions
              if (!instructions) return []
              return [new ServerInstructions({ server, instructions })]
            })
            .toSorted((a, b) => a.server.localeCompare(b.server))
        }),
        prompts: Effect.fn("MCP.prompts")(function* () {
          return Array.from(entries.values())
            .flatMap((entry) => entry.prompts ?? [])
            .toSorted((a, b) => a.server.localeCompare(b.server) || a.name.localeCompare(b.name))
        }),
        prompt: Effect.fn("MCP.prompt")(function* (input) {
          const target = yield* requireServer(input.server)
          yield* target.entry.startup.await
          if (!target.entry.client) return undefined
          const result = yield* target.entry.client
            .prompt({ name: input.name, args: input.args })
            .pipe(Effect.orElseSucceed(() => undefined))
          if (!result) return undefined
          return new PromptResult({
            server: target.name,
            name: input.name,
            messages: result.messages.map(
              (message) => new PromptMessage({ role: message.role, content: message.content }),
            ),
          })
        }),
        resourceCatalog: Effect.fn("MCP.resourceCatalog")(function* () {
          yield* whenAllReady
          const catalogs = yield* Effect.forEach(
            Array.from(entries),
            ([name, entry]) => {
              if (!entry.client) return Effect.succeed({ resources: [], templates: [] })
              return Effect.all(
                {
                  resources: entry.client.resources().pipe(Effect.orElseSucceed(() => [])),
                  templates: entry.client.resourceTemplates().pipe(Effect.orElseSucceed(() => [])),
                },
                { concurrency: "unbounded" },
              ).pipe(
                Effect.map((catalog) => ({
                  resources: catalog.resources.map((def) => toResource(name, def)),
                  templates: catalog.templates.map((def) => toResourceTemplate(name, def)),
                })),
              )
            },
            { concurrency: "unbounded" },
          )
          return ResourceCatalog.make({
            resources: catalogs
              .flatMap((catalog) => catalog.resources)
              .toSorted(
                (a, b) =>
                  a.server.localeCompare(b.server) || a.name.localeCompare(b.name) || a.uri.localeCompare(b.uri),
              ),
            templates: catalogs
              .flatMap((catalog) => catalog.templates)
              .toSorted(
                (a, b) =>
                  a.server.localeCompare(b.server) ||
                  a.name.localeCompare(b.name) ||
                  a.uriTemplate.localeCompare(b.uriTemplate),
              ),
          })
        }),
        readResource: Effect.fn("MCP.readResource")(function* (input) {
          const target = yield* requireServer(input.server)
          yield* target.entry.startup.await
          if (!target.entry.client) return undefined
          const result = yield* target.entry.client
            .readResource({ uri: input.uri })
            .pipe(Effect.orElseSucceed(() => undefined))
          if (!result) return undefined
          return ResourceContent.make({
            server: target.name,
            uri: input.uri,
            contents: result.contents,
          })
        }),
      })
    }),
  )

export function configured(options?: Options) {
  return makeLocationNode({
    service: Service,
    layer: layer(options),
    deps: [Location.node, Environment.node, Bus.node, Form.node, Integration.node, Credential.node],
  })
}

export const node = configured()

// Schema `optional` strips undefined-valued properties on encode, so fields can assign
// optional properties directly instead of conditionally spreading them.
function toElicitationField(key: string, property: ElicitationProperty, required: boolean): Form.Field {
  // Some servers emit machine titles like "string with format email"; prefer description/key over those.
  const machineTitle = /^(boolean|string|number|integer|array|object)(\s+with\b.*|\s+in\b.*)?$/i
  const title =
    property.title && !machineTitle.test(property.title.trim()) ? property.title : (property.description ?? key)
  const base = {
    key,
    title,
    description: property.description === title ? undefined : property.description,
    required: required || undefined,
  }
  switch (property.type) {
    case "boolean":
      return { ...base, type: "boolean", default: property.default }
    case "number":
    case "integer":
      return {
        ...base,
        type: property.type,
        minimum: property.minimum,
        maximum: property.maximum,
        default: property.default,
      }
    case "array":
      return {
        ...base,
        type: "multiselect",
        options:
          "anyOf" in property.items
            ? property.items.anyOf.map((option) => ({ value: option.const, label: option.title }))
            : property.items.enum.map((value) => ({ value, label: value })),
        custom: false,
        minItems: property.minItems,
        maxItems: property.maxItems,
        default: property.default,
      }
    case "string": {
      const options =
        "oneOf" in property
          ? property.oneOf.map((option) => ({ value: option.const, label: option.title }))
          : "enum" in property
            ? property.enum.map((value, index) => ({
                value,
                label: ("enumNames" in property ? property.enumNames?.[index] : undefined) ?? value,
              }))
            : undefined
      return {
        ...base,
        type: "string",
        format: "format" in property ? property.format : undefined,
        minLength: "minLength" in property ? property.minLength : undefined,
        maxLength: "maxLength" in property ? property.maxLength : undefined,
        default: property.default,
        options,
        custom: options ? false : undefined,
      }
    }
  }
}

type ElicitationProperty = McpClient.ElicitationFormParams["requestedSchema"]["properties"][string]
