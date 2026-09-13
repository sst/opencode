import { Duration, Effect, Equal, Schema, Semaphore, Stream } from "effect"
import type { Scope } from "effect"
import type { IntegrationOAuthMethodRegistration } from "@opencode/plugin/effect/integration"
import { define } from "@opencode/plugin/effect/plugin"
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { Bus } from "../../bus.js"
import { Credential } from "../../credential.js"
import { Integration } from "../../integration.js"
import { Provider } from "../../provider.js"
import { WebSearch } from "../../websearch.js"
import { ConfigProvider } from "@opencode/schema/config/provider"
import { Money } from "@opencode/schema/money"
import { ConfigPolicy } from "@opencode/schema/config/policy"
import { ProviderPolicy } from "../../provider-policy.js"

const defaultServer = "https://opencode.ai/console"
const clientID = "opencode-cli"
const methodID = Integration.MethodID.make("device")
const RemoteResponse = Schema.Struct({
  providers: Schema.Record(Schema.String, ConfigProvider.Info),
  websearch: Schema.Struct({
    providerID: WebSearch.ID,
  }).pipe(Schema.optional),
  experimental: Schema.Unknown,
  managedPolicy: Schema.Unknown,
})
const RemotePolicy = Schema.Struct({
  experimental: Schema.Struct({
    policies: Schema.Array(ConfigPolicy.Info).check(
      Schema.makeFilter((statements) =>
        statements.every(
          (statement) =>
            statement.resource.length > 0 &&
            statement.resource.length <= 256 &&
            statement.resource.trim() === statement.resource,
        ),
      ),
    ),
  }),
  managedPolicy: ProviderPolicy.Descriptor,
})
class RemoteFailure extends Schema.TaggedError<RemoteFailure>()("OpenCode.RemoteConfigFailure", {
  transient: Schema.Boolean,
}) {}
const Device = Schema.Struct({
  device_code: Schema.String,
  user_code: Schema.String,
  verification_uri_complete: Schema.String,
  expires_in: Schema.Number,
  interval: Schema.Number,
})
const Token = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.String,
  expires_in: Schema.Number,
  org_id: Schema.optional(Schema.NullOr(Schema.String)),
})
const TokenPending = Schema.Struct({ error: Schema.String })
const DeviceToken = Schema.Union([Token, TokenPending])
const User = Schema.Struct({ id: Schema.String, email: Schema.String })
const Org = Schema.Struct({ id: Schema.String, name: Schema.String })

function oauth(http: HttpClient.HttpClient) {
  return {
    integrationID: Integration.ID.make("opencode"),
    method: {
      id: methodID,
      type: "oauth",
      label: "OpenCode Console account",
    },
    authorize: (answer) =>
      Effect.gen(function* () {
        const server = yield* normalizeServer(answer.server ?? defaultServer)
        const device = yield* post(
          http,
          `${server}/auth/device/code`,
          { client_id: clientID, supports_org_scope: true },
          Device,
        )
        const verification = yield* Effect.try({
          try: () => {
            const url = new URL(device.verification_uri_complete, `${server}/`)
            if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("expected HTTP(S)")
            return url
          },
          catch: (cause) =>
            new Error(`Invalid device verification URL: ${cause instanceof Error ? cause.message : String(cause)}`),
        })
        return {
          mode: "auto" as const,
          url: verification.href,
          instructions: `Enter code: ${device.user_code}`,
          callback: poll(http, server, device.device_code, Duration.seconds(device.interval)),
        }
      }),
    refresh: (credential) =>
      Effect.gen(function* () {
        const token = yield* post(
          http,
          `${serverUrl(credential)}/auth/device/token`,
          { grant_type: "refresh_token", refresh_token: credential.refresh, client_id: clientID },
          Token,
        )
        // Persist rotated tokens without depending on discovery requests.
        return {
          ...credential,
          access: token.access_token,
          refresh: token.refresh_token,
          expires: Date.now() + token.expires_in * 1000,
          metadata:
            token.org_id == null
              ? credential.metadata
              : {
                  ...credential.metadata,
                  orgID: token.org_id,
                  orgName:
                    credential.metadata?.orgID === token.org_id && typeof credential.metadata.orgName === "string"
                      ? credential.metadata.orgName
                      : token.org_id,
                },
        }
      }),
    label: (credential) => (typeof credential.metadata?.orgName === "string" ? credential.metadata.orgName : undefined),
  } satisfies IntegrationOAuthMethodRegistration
}

export const OpencodePlugin = define<HttpClient.HttpClient | Bus.Service | ProviderPolicy.Service | Scope.Scope>({
  id: "opencode.provider.opencode",
  effect: Effect.fn(function* (ctx) {
    const bus = yield* Bus.Service
    const http = yield* HttpClient.HttpClient
    const policies = yield* ProviderPolicy.Service
    const loading = Semaphore.makeUnsafe(1)
    type ActiveConnection = Effect.Success<ReturnType<typeof ctx.integration.connection.active>>
    let snapshot: {
      config: Effect.Success<ReturnType<typeof fetchConfig>> | undefined
      connection: ActiveConnection
      identity?: string
      stale: boolean
    } = { config: undefined, connection: undefined, stale: false }

    const load = Effect.fn("OpencodePlugin.load")(function* () {
      const connection = yield* ctx.integration.connection.active("opencode")
      const credential = connection
        ? yield* ctx.integration.connection.resolve(connection).pipe(Effect.orElseSucceed(() => undefined))
        : undefined
      const identity = connection && credential ? ProviderPolicy.identity(connection, credential) : undefined
      const config = credential
        ? yield* fetchConfig(http, credential).pipe(
            Effect.catch((cause) =>
              Effect.logWarning("Failed to load workspace provider policy", { transient: cause.transient }).pipe(
                Effect.as(
                  cause.transient && identity !== undefined && snapshot.identity === identity && snapshot.config
                    ? { ...snapshot.config, stale: true }
                    : undefined,
                ),
              ),
            ),
          )
        : undefined
      return { config, connection, identity, stale: config?.stale ?? false }
    })

    yield* ctx.integration.transform((editor) => {
      editor.update("opencode", (integration) => {
        integration.name = "OpenCode"
      })
      editor.method.update(oauth(http))
      editor.method.update({ integrationID: "opencode", method: { type: "key", label: "API key (service account)" } })
    })

    snapshot = yield* load()
    yield* policies.set(
      snapshot.config && snapshot.identity
        ? {
            identity: snapshot.identity,
            descriptor: snapshot.config.managedPolicy,
            statements: snapshot.config.experimental.policies,
            stale: snapshot.stale,
          }
        : undefined,
    )
    yield* ctx.catalog.transform((catalog) => {
      for (const [providerID, item] of Object.entries(snapshot.config?.providers ?? {})) {
        const source = catalog.provider.get(item.canonical ?? providerID)
        catalog.provider.update(providerID, (provider) => {
          if (source && source.provider !== provider)
            Object.assign(provider, structuredClone(source.provider), { id: provider.id })
          provider.integrationID = Integration.ID.make("opencode")
          if (item.canonical !== undefined) provider.canonical = item.canonical
          if (item.name !== undefined) provider.name = item.name
          provider.package = item.package ?? provider.package
          provider.settings = Provider.mergeOverlay(
            withoutCredentials(provider.settings),
            withoutCredentials(item.settings),
          )
          provider.headers = Provider.mergeHeaders(provider.headers, item.headers)
          provider.body = Provider.mergeOverlay(provider.body, item.body)
        })

        for (const [modelID, config] of Object.entries(item.models ?? {})) {
          const base = source?.models.get(config.modelID ?? modelID) ?? source?.models.get(modelID)
          catalog.model.update(providerID, modelID, (model) => {
            Object.assign(model, structuredClone(base ?? model))
            if (config.family !== undefined) model.family = config.family
            if (config.name !== undefined) model.name = config.name
            if (config.modelID !== undefined) model.modelID = config.modelID
            if (config.compatibility !== undefined)
              model.compatibility = { ...model.compatibility, ...config.compatibility }
            model.package = config.package ?? (item.package !== undefined ? undefined : model.package)
            if (item.settings?.baseURL !== undefined && model.settings) delete model.settings.baseURL
            if (config.capabilities !== undefined)
              model.capabilities = {
                ...config.capabilities,
                input: [...config.capabilities.input],
                output: [...config.capabilities.output],
              }
            model.settings = Provider.mergeOverlay(
              withoutCredentials(model.settings),
              withoutCredentials(config.settings),
            )
            model.headers = Provider.mergeHeaders(model.headers, config.headers)
            model.body = Provider.mergeOverlay(model.body, config.body)
            for (const variant of config.variants ?? []) {
              let existing = model.variants.find((item) => item.id === variant.id)
              if (!existing) {
                existing = { id: variant.id }
                model.variants.push(existing)
              }
              if (variant.settings !== undefined)
                existing.settings = Provider.mergeOverlay(existing.settings, withoutCredentials(variant.settings))
              if (variant.headers !== undefined)
                existing.headers = Provider.mergeHeaders(existing.headers, variant.headers)
              if (variant.body !== undefined) existing.body = Provider.mergeOverlay(existing.body, variant.body)
            }
            if (config.cost !== undefined)
              model.cost = (Array.isArray(config.cost) ? config.cost : [config.cost]).map((cost) => ({
                tier: cost.tier && { ...cost.tier },
                input: cost.input,
                output: cost.output,
                cache: {
                  read: cost.cache?.read ?? Money.USDPerMillionTokens.zero,
                  write: cost.cache?.write ?? Money.USDPerMillionTokens.zero,
                },
              }))
            model.enabled = !config.disabled
            if (config.limit !== undefined) model.limit = { ...model.limit, ...config.limit }
          })
        }
      }

      const item = catalog.provider.get(Provider.ID.opencode)
      if (!item) return
      const hasKey = Boolean(process.env.OPENCODE_API_KEY || snapshot.connection || item.provider.settings?.apiKey)
      catalog.provider.update(item.provider.id, (provider) => {
        if (!hasKey) {
          provider.activation = "enabled"
          provider.settings = { ...provider.settings, apiKey: "public" }
        }
      })
      if (hasKey) return
      for (const model of item.models.values()) {
        if (!model.cost.some((cost) => cost.input > 0)) continue
        catalog.model.update(item.provider.id, model.id, (draft) => {
          draft.enabled = false
        })
      }
    })

    yield* ctx.websearch.transform((editor) => {
      const descriptor = snapshot.config?.websearch
      const connection = snapshot.connection
      if (!descriptor || !connection) return
      editor.add({
        id: descriptor.providerID,
        name: "OpenCode Web Search",
        execute: (input) =>
          Effect.gen(function* () {
            const active = yield* ctx.integration.connection.active("opencode")
            if (
              !active ||
              (connection.type === "credential"
                ? active.type !== "credential" || active.id !== connection.id
                : active.type !== "env" || active.name !== connection.name)
            ) {
              return yield* Effect.fail(new Error("OpenCode Console connection changed"))
            }
            const credential = yield* ctx.integration.connection.resolve(active)
            if (!credential) return yield* Effect.fail(new Error("OpenCode Console is not connected"))
            const metadata = credential.metadata
            const orgID = typeof metadata?.orgID === "string" ? metadata.orgID : undefined
            const token = credential.type === "oauth" ? credential.access : credential.key
            const server = yield* normalizeServer(serverUrl(credential))
            const request = yield* HttpClientRequest.post(`${server}/api/websearch`).pipe(
              HttpClientRequest.acceptJson,
              HttpClientRequest.bearerToken(token),
              HttpClientRequest.setHeaders(orgID ? { "x-org-id": orgID } : {}),
              HttpClientRequest.schemaBodyJson(WebSearch.Input)({
                query: input.query,
                providerID: descriptor.providerID,
              }),
            )
            const response = yield* HttpClient.withScope(HttpClient.filterStatusOk(http))
              .execute(request)
              .pipe(
                Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
                Effect.flatMap(HttpClientResponse.schemaBodyJson(WebSearch.Response)),
                Effect.scoped,
                Effect.timeoutOrElse({
                  duration: Duration.seconds(25),
                  orElse: () => Effect.fail(new Error("OpenCode web search request timed out")),
                }),
              )
            if (response.providerID !== descriptor.providerID) {
              return yield* Effect.fail(
                new Error(
                  `OpenCode web search returned provider ${response.providerID} instead of ${descriptor.providerID}`,
                ),
              )
            }
            return response.results
          }),
      })
      editor.default.set(descriptor.providerID)
    })

    const apply = Effect.fn("OpencodePlugin.apply")(function* (next: typeof snapshot) {
      snapshot = next
      yield* policies.set(
        next.config && next.identity
          ? {
              identity: next.identity,
              descriptor: next.config.managedPolicy,
              statements: next.config.experimental.policies,
              stale: next.stale,
            }
          : undefined,
      )
      yield* Effect.all([ctx.catalog.reload(), ctx.websearch.reload()], { concurrency: 2, discard: true })
    })
    const refresh = () => loading.withPermit(load().pipe(Effect.andThen(apply)))
    yield* bus.subscribe(Credential.Event.Switched).pipe(
      Stream.filter((event) => event.data.integrationID === Integration.ID.make("opencode")),
      Stream.runForEach(refresh),
      Effect.forkScoped({ startImmediately: true }),
    )

    // Console config can change independently of local credential activity, so re-fetch
    // periodically and only rebuild the catalog and search providers when the snapshot differs.
    yield* Effect.sleep(Duration.minutes(10)).pipe(
      Effect.andThen(
        loading.withPermit(
          load().pipe(Effect.flatMap((next) => (Equal.equals(snapshot, next) ? Effect.void : apply(next)))),
        ),
      ),
      Effect.forever,
      Effect.forkScoped,
    )
  }),
})

const fetchConfig = Effect.fn("OpenCode.fetchConfig")(function* (http: HttpClient.HttpClient, value: Credential.Value) {
  const metadata = value.metadata
  const orgID = typeof metadata?.orgID === "string" ? metadata.orgID : undefined
  const token = value.type === "oauth" ? value.access : value.key
  const server = yield* normalizeServer(serverUrl(value)).pipe(
    Effect.mapError(() => new RemoteFailure({ transient: false })),
  )
  return yield* http
    .execute(
      HttpClientRequest.get(`${server}/api/v2/config`).pipe(
        HttpClientRequest.acceptJson,
        HttpClientRequest.bearerToken(token),
        HttpClientRequest.setHeaders(orgID ? { "x-org-id": orgID } : {}),
      ),
    )
    .pipe(
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
      Effect.mapError(() => new RemoteFailure({ transient: true })),
      Effect.flatMap((response) => {
        if (response.status < 200 || response.status >= 300)
          return Effect.fail(new RemoteFailure({ transient: response.status >= 500 || response.status === 429 }))
        return Effect.succeed(response).pipe(
          Effect.flatMap(HttpClientResponse.schemaBodyJson(RemoteResponse)),
          Effect.flatMap((config) =>
            Schema.decodeUnknownEffect(RemotePolicy, { onExcessProperty: "error" })({
              experimental: config.experimental,
              managedPolicy: config.managedPolicy,
            }).pipe(Effect.map((policy) => ({ ...config, ...policy, stale: false }))),
          ),
          Effect.flatMap((config) =>
            orgID !== undefined && config.managedPolicy.workspaceID !== orgID
              ? Effect.fail(new RemoteFailure({ transient: false }))
              : Effect.succeed(config),
          ),
          Effect.mapError(() => new RemoteFailure({ transient: false })),
        )
      }),
      Effect.timeoutOrElse({
        duration: Duration.seconds(20),
        orElse: () => Effect.fail(new RemoteFailure({ transient: true })),
      }),
    )
})

function serverUrl(value: Credential.Value) {
  return typeof value.metadata?.server === "string" ? value.metadata.server : defaultServer
}

function withoutCredentials<Value>(body: Readonly<Record<string, Value>> | undefined) {
  return (
    body &&
    Object.fromEntries(Object.entries(body).filter(([key]) => !["apiKey", "authToken", "accessToken"].includes(key)))
  )
}

function normalizeServer(input: unknown) {
  return Effect.try({
    try: () => {
      if (typeof input !== "string") throw new Error("expected string")
      const url = new URL(input)
      if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("expected HTTP(S)")
      return `${url.origin}${url.pathname.replace(/\/+$/, "")}`
    },
    catch: (cause) =>
      new Error(`Invalid OpenCode server URL: ${cause instanceof Error ? cause.message : String(cause)}`),
  })
}

function poll(http: HttpClient.HttpClient, server: string, deviceCode: string, interval: Duration.Duration) {
  const loop = (wait: Duration.Duration): Effect.Effect<Credential.OAuth, unknown> =>
    Effect.gen(function* () {
      yield* Effect.sleep(wait)
      const result = yield* post(
        http,
        `${server}/auth/device/token`,
        {
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: deviceCode,
          client_id: clientID,
        },
        DeviceToken,
        false,
      )
      if ("access_token" in result) return yield* credential(http, server, result)
      if (result.error === "authorization_pending") return yield* loop(wait)
      if (result.error === "slow_down") {
        return yield* loop(Duration.sum(wait, Duration.seconds(5)))
      }
      return yield* Effect.fail(new Error(`Device authorization failed: ${result.error}`))
    })
  return loop(interval)
}

function credential(http: HttpClient.HttpClient, server: string, token: typeof Token.Type) {
  return Effect.gen(function* () {
    const [user, orgs] = yield* Effect.all(
      [
        get(http, `${server}/api/user`, token.access_token, User),
        get(http, `${server}/api/orgs`, token.access_token, Schema.Array(Org)),
      ],
      { concurrency: 2 },
    )
    const org =
      token.org_id == null
        ? orgs.toSorted((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))[0]
        : orgs.find((org) => org.id === token.org_id)
    if (token.org_id != null && !org) {
      return yield* Effect.fail(new Error(`OpenCode organization not found: ${token.org_id}`))
    }
    return Credential.OAuth.make({
      type: "oauth" as const,
      methodID,
      access: token.access_token,
      refresh: token.refresh_token,
      expires: Date.now() + token.expires_in * 1000,
      metadata: {
        server,
        accountID: user.id,
        email: user.email,
        orgID: org?.id,
        orgName: org?.name,
      },
    })
  })
}

function get<S extends Schema.Top>(http: HttpClient.HttpClient, url: string, token: string, schema: S) {
  return HttpClient.filterStatusOk(http)
    .execute(HttpClientRequest.get(url).pipe(HttpClientRequest.acceptJson, HttpClientRequest.bearerToken(token)))
    .pipe(Effect.flatMap(HttpClientResponse.schemaBodyJson(schema)))
}

function post<S extends Schema.Top>(
  http: HttpClient.HttpClient,
  url: string,
  body: Record<string, string | boolean>,
  schema: S,
  statusOk = true,
) {
  return HttpClientRequest.post(url).pipe(
    HttpClientRequest.acceptJson,
    HttpClientRequest.schemaBodyJson(Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Boolean])))(body),
    Effect.flatMap((request) => http.execute(request)),
    Effect.flatMap((response) => (statusOk ? HttpClientResponse.filterStatusOk(response) : Effect.succeed(response))),
    Effect.flatMap(HttpClientResponse.schemaBodyJson(schema)),
  )
}
