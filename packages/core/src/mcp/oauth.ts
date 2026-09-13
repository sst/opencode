export * as McpOAuth from "./oauth.js"

import {
  auth,
  discoverOAuthServerInfo,
  parseErrorResponse,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  type OAuthServerInfo,
} from "@modelcontextprotocol/sdk/client/auth.js"
import type { OAuthClientInformationMixed, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js"
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js"
import { Cause, Deferred, Effect } from "effect"
import { Credential } from "@opencode/schema/credential"
import { ConfigMCP } from "@opencode/schema/config/mcp"
import { OauthCallbackPage } from "../oauth/page.js"
import type { Integration } from "../integration.js"
import { ErrorSummary } from "../util/error-summary.js"

/**
 * opencode's OAuth Client ID Metadata Document. Authorization servers that support CIMD accept this URL as the
 * client_id and fetch it to learn our name and redirect URIs, so no per-server dynamic registration is needed.
 */
export const CLIENT_METADATA_URL = "https://opencode.ai/oauth/opencode/client.json"

/** Observe OAuth failures before the SDK handles them by invalidating credentials or redirecting. */
export const loggedFetch = (fields: { readonly server: string; readonly directory?: string }) =>
  Effect.gen(function* () {
    const run = Effect.runPromiseWith(yield* Effect.context())
    const request: FetchLike = (url, init) => {
      const grant = init?.body instanceof URLSearchParams ? init.body.get("grant_type") : undefined
      const operation = grant === "refresh_token" ? "refresh" : grant === "authorization_code" ? "exchange" : undefined
      const started = Date.now()
      return run(
        Effect.gen(function* () {
          if (operation) yield* Effect.logInfo("mcp oauth request started")
          const response = yield* Effect.tryPromise({ try: () => fetch(url, init), catch: (error) => error })
          const result = { status: response.status, durationMs: Date.now() - started }
          if (operation && !response.ok) {
            // Only retain the SDK's standard error code. Descriptions and raw bodies can echo credentials.
            const error = yield* Effect.tryPromise(async () => parseErrorResponse(await response.clone().text())).pipe(
              Effect.map((error) => error.errorCode),
              Effect.orElseSucceed(() => "unreadable_response"),
            )
            yield* Effect.logWarning("mcp oauth request rejected", { ...result, error })
          }
          if (operation && response.ok) {
            yield* Effect.logInfo("mcp oauth request succeeded", result)
          }
          if (!operation && (response.status === 401 || response.status === 403)) {
            yield* Effect.logWarning("mcp http authentication rejected", result)
          }
          return response
        }).pipe(
          Effect.onError((cause) => {
            if (init?.signal?.aborted) return Effect.logDebug("mcp http request aborted")
            return Effect.logWarning("mcp http request failed", {
              errors: ErrorSummary.from(Cause.squash(cause)),
              durationMs: Date.now() - started,
            })
          }),
          Effect.annotateLogs({
            ...fields,
            requestID: crypto.randomUUID(),
            origin: new URL(url).origin,
            method: init?.method ?? "GET",
            ...(operation ? { operation } : {}),
          }),
        ),
      )
    }
    return request
  })

/** Persists the OAuth artifacts for one MCP server session: DCR client info, PKCE verifier, and tokens. */
export interface Store {
  readonly tokens: () => Promise<OAuthTokens | undefined>
  readonly saveTokens: (tokens: OAuthTokens) => Promise<void>
  readonly clientInformation: () => Promise<OAuthClientInformationMixed | undefined>
  readonly saveClientInformation: (info: OAuthClientInformationMixed) => Promise<void>
  readonly codeVerifier: () => Promise<string | undefined>
  readonly saveCodeVerifier: (verifier: string) => Promise<void>
}

export interface Options {
  /** Loopback URL the authorization server redirects back to after the user approves. */
  readonly redirectUrl: string
  /** Space-delimited OAuth scopes to request when the server requires specific ones. */
  readonly scope?: string
  /** CSRF state embedded in the authorization request; required by the spec and enforced by some servers.
   * The caller is responsible for validating the value echoed back to the redirect. */
  readonly state?: string
  /** Statically pre-registered client credentials from config; when set, the SDK skips dynamic registration. */
  readonly client?: { readonly id: string; readonly secret?: string }
  /** Use opencode's Client ID Metadata Document as the client_id instead of registering dynamically. */
  readonly clientMetadataUrl?: string
  /** Pre-fetched authorization server discovery so the SDK does not repeat it. */
  readonly discovery?: OAuthServerInfo
  /** Receives the SDK's discovery result before it refreshes or authorizes. */
  readonly onDiscovery?: (discovery: OAuthDiscoveryState) => void | Promise<void>
  /** Invoked by the SDK to drop credentials it has determined are invalid (e.g. a rejected refresh token). */
  readonly invalidate?: (scope: "all" | "client" | "tokens" | "verifier" | "discovery") => void | Promise<void>
  /** Receives the authorization URL so the caller can open a browser and capture the eventual code. */
  readonly onRedirect: (url: URL) => void | Promise<void>
  readonly store: Store
}

/**
 * Builds the MCP SDK's OAuthClientProvider. The SDK drives dynamic client registration, PKCE, and
 * token refresh through these callbacks; we only persist whatever it hands back via `store`.
 */
export const provider = (options: Options): OAuthClientProvider => {
  const state = options.state
  const client = options.client
  return {
    redirectUrl: options.redirectUrl,
    ...(options.clientMetadataUrl ? { clientMetadataUrl: options.clientMetadataUrl } : {}),
    ...(options.discovery ? { discoveryState: () => options.discovery } : {}),
    ...(options.onDiscovery ? { saveDiscoveryState: options.onDiscovery } : {}),
    clientMetadata: {
      redirect_uris: [options.redirectUrl],
      client_name: "opencode",
      client_uri: "https://opencode.ai",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: client?.secret ? "client_secret_post" : "none",
      ...(options.scope ? { scope: options.scope } : {}),
    },
    // Only advertise state when the caller supplied one (the interactive flow); the connect-time
    // provider has no redirect to validate, so it omits it.
    ...(state !== undefined ? { state: () => state } : {}),
    // Static client config short-circuits dynamic registration; otherwise the SDK registers and we persist.
    clientInformation: () =>
      client ? { client_id: client.id, client_secret: client.secret } : options.store.clientInformation(),
    saveClientInformation: (info) => options.store.saveClientInformation(info),
    tokens: () => options.store.tokens(),
    saveTokens: (tokens) => options.store.saveTokens(tokens),
    redirectToAuthorization: (url) => options.onRedirect(url),
    ...(options.invalidate ? { invalidateCredentials: options.invalidate } : {}),
    saveCodeVerifier: (verifier) => options.store.saveCodeVerifier(verifier),
    // The SDK only reads the verifier back after saving one earlier in the same flow; a miss means
    // the flow was resumed without its session state, which the SDK surfaces as an auth failure.
    codeVerifier: async () => {
      const verifier = await options.store.codeVerifier()
      if (!verifier) throw new Error("Missing PKCE code verifier for MCP OAuth flow")
      return verifier
    },
  }
}

/** A Store that keeps OAuth artifacts in memory for the duration of one interactive login attempt. */
export const memoryStore = (): Store => {
  let tokens: OAuthTokens | undefined
  let client: OAuthClientInformationMixed | undefined
  let verifier: string | undefined
  return {
    tokens: async () => tokens,
    saveTokens: async (value) => {
      tokens = value
    },
    clientInformation: async () => client,
    saveClientInformation: async (value) => {
      client = value
    },
    codeVerifier: async () => verifier,
    saveCodeVerifier: async (value) => {
      verifier = value
    },
  }
}

/** Reads the dynamically-registered client info we stash in a credential's metadata, for token refresh. */
export const clientFromCredential = (credential: Credential.OAuth) =>
  credential.metadata?.client as OAuthClientInformationMixed | undefined

/** Reads the authorization server issuer recorded when the credential was obtained. */
export const issuerFromCredential = (credential: Credential.OAuth) => {
  const issuer = credential.metadata?.issuer
  return typeof issuer === "string" ? issuer : undefined
}

/** Folds SDK tokens (plus client info, issuer, and the server URL) into a storable credential. */
export const toCredential = (input: {
  readonly methodID: Integration.MethodID
  readonly serverUrl: string
  readonly tokens: OAuthTokens
  readonly client: OAuthClientInformationMixed | undefined
  readonly issuer?: string
}) =>
  Credential.OAuth.make({
    type: "oauth",
    methodID: input.methodID,
    access: input.tokens.access_token,
    refresh: input.tokens.refresh_token ?? "",
    // 0 marks an unknown/non-expiring token; toTokens then omits expires_in so the SDK won't force a refresh.
    expires: input.tokens.expires_in ? Date.now() + input.tokens.expires_in * 1000 : 0,
    metadata: {
      serverUrl: input.serverUrl,
      tokenType: input.tokens.token_type,
      ...(input.tokens.scope ? { scope: input.tokens.scope } : {}),
      ...(input.client ? { client: input.client } : {}),
      ...(input.issuer ? { issuer: input.issuer } : {}),
    },
  })

/**
 * Reconstructs SDK tokens from a stored credential so the connect-time provider can present them. The refresh
 * token is withheld when `issuer` differs from the one recorded at login, so the SDK re-authorizes instead of
 * sending it to an authorization server that did not issue it.
 */
export const toTokens = (credential: Credential.OAuth, issuer?: string): OAuthTokens => {
  const metadata = credential.metadata ?? {}
  const bound = issuerFromCredential(credential)
  const refresh = credential.refresh && (!bound || !issuer || bound === issuer)
  return {
    access_token: credential.access,
    token_type: typeof metadata.tokenType === "string" ? metadata.tokenType : "Bearer",
    ...(refresh ? { refresh_token: credential.refresh } : {}),
    ...(credential.expires ? { expires_in: Math.max(0, Math.floor((credential.expires - Date.now()) / 1000)) } : {}),
    ...(typeof metadata.scope === "string" ? { scope: metadata.scope } : {}),
  }
}

/**
 * Runs the interactive OAuth login for one remote MCP server. Stands up a loopback callback server,
 * lets the SDK drive DCR + PKCE to produce an authorization URL, and returns an attempt whose callback
 * exchanges the redirect code for a storable credential. Scoped: the callback server closes with the scope.
 */
export const authorize = (input: {
  readonly name: string
  readonly config: typeof ConfigMCP.Remote.Type
  readonly methodID: Integration.MethodID
}) =>
  Effect.gen(function* () {
    const fields = { server: input.name, methodID: input.methodID, oauthAttemptID: crypto.randomUUID() }
    const context = yield* Effect.context()
    const run = Effect.runPromiseWith(context)
    const runFork = Effect.runForkWith(context)
    const fetchFn = yield* loggedFetch({ server: input.name }).pipe(Effect.annotateLogs(fields))
    yield* Effect.logInfo("mcp oauth authorization started", fields)
    const oauth = input.config.oauth || undefined
    const store = memoryStore()
    const code = yield* Deferred.make<string, Error>()
    const redirect = oauth?.redirect_uri ? new URL(oauth.redirect_uri) : undefined
    const redirectPath = redirect?.pathname ?? "/callback"
    const state = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")

    // Lazy so runtimes without a loopback listener (workerd) never evaluate node:http.
    const { createServer } = yield* Effect.promise(() => import("node:http"))
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1")
      if (url.pathname !== redirectPath) {
        response.writeHead(404).end("Not found")
        return
      }
      const fail = (reason: string, failure: string) => {
        runFork(Effect.logWarning("mcp oauth callback rejected", { ...fields, reason: failure }))
        Effect.runFork(Deferred.fail(code, new Error(reason)))
        response
          .writeHead(400, { "Content-Type": "text/html" })
          .end(OauthCallbackPage.error(reason, { provider: input.name }))
      }
      const error = url.searchParams.get("error_description") ?? url.searchParams.get("error")
      if (error) return fail(error, "authorization_error")
      // Reject a redirect whose state does not match what we issued: this is the CSRF defense the
      // state parameter exists for, so an attacker can't inject their own authorization code.
      if (url.searchParams.get("state") !== state) return fail("OAuth state mismatch", "state_mismatch")
      const value = url.searchParams.get("code")
      if (!value) return fail("Missing authorization code", "missing_code")
      Effect.runFork(Deferred.succeed(code, value))
      response.writeHead(200, { "Content-Type": "text/html" }).end(OauthCallbackPage.success({ provider: input.name }))
    })

    // Bind the port the redirect will actually arrive on: an explicit callback_port wins, else the port
    // pinned by redirect_uri, else an ephemeral port. Binding ephemerally while redirect_uri names a fixed
    // port would send the browser somewhere nothing is listening, hanging the attempt until it expires.
    const redirectPort = Number(redirect?.port) || undefined
    const port = yield* Effect.callback<number, Error>((resume) => {
      server.once("error", (error) => resume(Effect.fail(error)))
      server.listen(oauth?.callback_port ?? redirectPort ?? 0, "127.0.0.1", () => {
        const address = server.address()
        resume(
          address && typeof address === "object"
            ? Effect.succeed(address.port)
            : Effect.fail(new Error("Could not determine MCP OAuth callback port")),
        )
      })
    })
    yield* Effect.addFinalizer(() => Effect.sync(() => server.close()))

    // Discover the authorization server up front so we can decide how to identify ourselves. CIMD only works
    // when the server advertises it, accepts public clients (our document declares no client secret), and the
    // redirect is our own loopback URL (a user-configured redirect_uri is not in the published document).
    // A configured client_id is pre-registered and always wins.
    const discovery = yield* Effect.tryPromise({
      try: () => discoverOAuthServerInfo(input.config.url, { fetchFn }),
      catch: (error) => (error instanceof Error ? error : new Error(String(error))),
    })
    const cimd =
      !oauth?.client_id &&
      !oauth?.redirect_uri &&
      discovery.authorizationServerMetadata?.client_id_metadata_document_supported === true &&
      (discovery.authorizationServerMetadata.token_endpoint_auth_methods_supported?.includes("none") ?? false)
    yield* Effect.logInfo("mcp oauth client registration selected", {
      ...fields,
      registration: oauth?.client_id ? "static" : cimd ? "cimd" : "dcr",
    })

    let authorizationUrl: URL | undefined
    const oauthProvider = provider({
      redirectUrl: oauth?.redirect_uri ?? `http://127.0.0.1:${port}${redirectPath}`,
      scope: oauth?.scope,
      state,
      client: oauth?.client_id ? { id: oauth.client_id, secret: oauth.client_secret } : undefined,
      clientMetadataUrl: cimd ? CLIENT_METADATA_URL : undefined,
      discovery,
      onRedirect: (url) => {
        authorizationUrl = url
        return run(Effect.logInfo("mcp oauth awaiting authorization", fields))
      },
      store,
    })

    const finalize = Effect.gen(function* () {
      const tokens = yield* Effect.promise(() => store.tokens())
      if (!tokens) return yield* Effect.fail(new Error(`MCP server "${input.name}" did not return OAuth tokens`))
      const client = yield* Effect.promise(() => store.clientInformation())
      yield* Effect.logInfo("mcp oauth authorization completed", {
        ...fields,
        hasRefreshToken: Boolean(tokens.refresh_token),
        expiresIn: tokens.expires_in,
      })
      return toCredential({
        methodID: input.methodID,
        serverUrl: input.config.url,
        tokens,
        client,
        issuer: discovery.authorizationServerMetadata?.issuer,
      })
    })

    yield* Effect.tryPromise({
      try: () => auth(oauthProvider, { serverUrl: input.config.url, scope: oauth?.scope, fetchFn }),
      catch: (error) => (error instanceof Error ? error : new Error(String(error))),
    })

    if (!authorizationUrl)
      return yield* Effect.fail(new Error(`MCP server "${input.name}" did not provide an authorization URL`))

    return {
      url: authorizationUrl.toString(),
      instructions: `Authorize ${input.name} in your browser. This window will close automatically.`,
      mode: "auto" as const,
      callback: Deferred.await(code).pipe(
        Effect.flatMap((value) =>
          Effect.tryPromise({
            try: () =>
              auth(oauthProvider, {
                serverUrl: input.config.url,
                authorizationCode: value,
                scope: oauth?.scope,
                fetchFn,
              }),
            catch: (error) => (error instanceof Error ? error : new Error(String(error))),
          }),
        ),
        Effect.flatMap(() => finalize),
        Effect.onError((cause) =>
          Effect.logWarning("mcp oauth authorization failed", { errors: ErrorSummary.from(Cause.squash(cause)) }),
        ),
        Effect.annotateLogs(fields),
      ),
    }
  }).pipe(
    Effect.onError((cause) =>
      Effect.logWarning("mcp oauth authorization setup failed", {
        server: input.name,
        methodID: input.methodID,
        errors: ErrorSummary.from(Cause.squash(cause)),
      }),
    ),
  )
