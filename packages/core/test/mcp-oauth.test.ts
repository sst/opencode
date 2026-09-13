import { afterAll, describe, expect, test } from "bun:test"
import { auth, refreshAuthorization } from "@modelcontextprotocol/sdk/client/auth.js"
import { ConfigMCP } from "@opencode/schema/config/mcp"
import { Credential } from "@opencode/schema/credential"
import { Integration } from "@opencode/core/integration"
import { McpOAuth } from "@opencode/core/mcp/oauth"
import { Effect } from "effect"

const authServer = Bun.serve({ port: 0, fetch: () => new Response(null, { status: 404 }) })
afterAll(() => authServer.stop(true))

const authorize = (redirect_uri?: string) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const authorization = yield* McpOAuth.authorize({
          name: "test",
          config: new ConfigMCP.Remote({
            type: "remote",
            url: authServer.url.href,
            oauth: { client_id: "client", ...(redirect_uri ? { redirect_uri } : {}) },
          }),
          methodID: Integration.MethodID.make("oauth"),
        })
        return new URL(authorization.url).searchParams.get("redirect_uri")
      }),
    ),
  )

describe("MCP OAuth", () => {
  test("completes interactive authorization through the loopback callback", async () => {
    const tokenRequests: URLSearchParams[] = []
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url)
        if (request.method !== "POST" || url.pathname !== "/token") return new Response(null, { status: 404 })
        tokenRequests.push(new URLSearchParams(await request.text()))
        return Response.json({
          access_token: "access",
          token_type: "Bearer",
          refresh_token: "refresh",
          expires_in: 3600,
        })
      },
    })

    const credential = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const authorization = yield* McpOAuth.authorize({
            name: "test",
            config: new ConfigMCP.Remote({
              type: "remote",
              url: server.url.href,
              oauth: { client_id: "client" },
            }),
            methodID: Integration.MethodID.make("oauth"),
          })
          const authorizationUrl = new URL(authorization.url)
          const redirectValue = authorizationUrl.searchParams.get("redirect_uri")
          const state = authorizationUrl.searchParams.get("state")
          if (!redirectValue || !state) throw new Error("Missing OAuth redirect parameters")
          const redirect = new URL(redirectValue)
          redirect.searchParams.set("code", "accepted")
          redirect.searchParams.set("state", state)
          expect((yield* Effect.promise(() => fetch(redirect))).status).toBe(200)
          return yield* authorization.callback
        }),
      ),
    ).finally(() => server.stop(true))

    expect(credential.access).toBe("access")
    expect(credential.refresh).toBe("refresh")
    expect(tokenRequests).toHaveLength(1)
    expect(tokenRequests[0]?.get("grant_type")).toBe("authorization_code")
    expect(tokenRequests[0]?.get("code")).toBe("accepted")
    expect(tokenRequests[0]?.get("code_verifier")).not.toBeNull()
  })

  test("refreshes tokens loaded from a persisted credential", async () => {
    const tokenRequests: URLSearchParams[] = []
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url)
        if (request.method !== "POST" || url.pathname !== "/token") return new Response(null, { status: 404 })
        tokenRequests.push(new URLSearchParams(await request.text()))
        return Response.json({ access_token: "next", token_type: "Bearer" })
      },
    })
    const store = McpOAuth.memoryStore()
    await store.saveTokens(
      McpOAuth.toTokens(
        Credential.OAuth.make({
          type: "oauth",
          methodID: Integration.MethodID.make("oauth"),
          access: "expired",
          refresh: "refresh",
          expires: Date.now() - 1000,
          metadata: { serverUrl: server.url.href, tokenType: "Bearer" },
        }),
      ),
    )
    const oauthProvider = McpOAuth.provider({
      redirectUrl: "http://127.0.0.1/callback",
      client: { id: "client" },
      onRedirect: () => undefined,
      store,
    })

    const result = await auth(oauthProvider, { serverUrl: server.url.href }).finally(() => server.stop(true))

    expect(result).toBe("AUTHORIZED")
    expect(await store.tokens()).toEqual({ access_token: "next", token_type: "Bearer", refresh_token: "refresh" })
    expect(tokenRequests).toHaveLength(1)
    expect(tokenRequests[0]?.get("grant_type")).toBe("refresh_token")
    expect(tokenRequests[0]?.get("refresh_token")).toBe("refresh")
  })

  test("withholds the refresh token when the authorization server issuer changed", async () => {
    const tokenRequests: unknown[] = []
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url)
        if (url.pathname === "/.well-known/oauth-authorization-server")
          return Response.json({
            issuer: "https://other.example.com",
            authorization_endpoint: `${url.origin}/authorize`,
            token_endpoint: `${url.origin}/token`,
            response_types_supported: ["code"],
          })
        if (request.method === "POST" && url.pathname === "/token") {
          tokenRequests.push(await request.text())
          return Response.json({ access_token: "next", token_type: "Bearer" })
        }
        return new Response(null, { status: 404 })
      },
    })
    const credential = Credential.OAuth.make({
      type: "oauth",
      methodID: Integration.MethodID.make("oauth"),
      access: "expired",
      refresh: "refresh",
      expires: Date.now() - 1000,
      metadata: { serverUrl: server.url.href, tokenType: "Bearer", issuer: server.url.origin },
    })
    let issuer: string | undefined
    const store = McpOAuth.memoryStore()
    const oauthProvider = McpOAuth.provider({
      redirectUrl: "http://127.0.0.1/callback",
      client: { id: "client" },
      onDiscovery: (discovery) => {
        issuer = discovery.authorizationServerMetadata?.issuer
      },
      onRedirect: () => undefined,
      store: { ...store, tokens: async () => McpOAuth.toTokens(credential, issuer) },
    })

    const result = await auth(oauthProvider, { serverUrl: server.url.href }).finally(() => server.stop(true))

    expect(result).toBe("REDIRECT")
    expect(tokenRequests).toHaveLength(0)
    expect(McpOAuth.toTokens(credential, server.url.origin).refresh_token).toBe("refresh")
  })

  test("shares concurrent refreshes for the same token", async () => {
    let requests = 0
    const pending = Promise.withResolvers<void>()
    const options = {
      metadata: {
        issuer: "https://auth.example.com",
        authorization_endpoint: "https://auth.example.com/authorize",
        token_endpoint: "https://auth.example.com/token",
        response_types_supported: ["code"],
      },
      clientInformation: { client_id: "client" },
      refreshToken: "refresh",
      fetchFn: async () => {
        requests++
        await pending.promise
        return Response.json({ access_token: "access", token_type: "Bearer", refresh_token: "next" })
      },
    }

    const first = refreshAuthorization(new URL("https://auth.example.com"), options)
    const second = refreshAuthorization(new URL("https://auth.example.com"), options)
    await Promise.resolve()

    expect(requests).toBe(1)
    pending.resolve()
    expect(await Promise.all([first, second])).toEqual([
      { access_token: "access", token_type: "Bearer", refresh_token: "next" },
      { access_token: "access", token_type: "Bearer", refresh_token: "next" },
    ])
  })

  test("generates a loopback redirect URL when none is configured", async () => {
    expect(await authorize()).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/)
  })

  test("preserves a configured redirect URL and fixed port", async () => {
    const reservation = Bun.serve({ port: 0, fetch: () => new Response() })
    const redirect = `http://127.0.0.1:${reservation.port}/fixed-callback`
    reservation.stop(true)

    expect(await authorize(redirect)).toBe(redirect)
  })

  test("rejects an invalid redirect URL", async () => {
    await expect(authorize("not a URL")).rejects.toThrow(TypeError)
  })

  describe("client registration", () => {
    // Serves authorization server metadata with the given capabilities and records DCR + token requests.
    const authorizationServer = (metadata: Record<string, unknown>) => {
      const registrations: unknown[] = []
      const tokenRequests: URLSearchParams[] = []
      const server = Bun.serve({
        port: 0,
        async fetch(request) {
          const url = new URL(request.url)
          if (url.pathname === "/.well-known/oauth-authorization-server")
            return Response.json({
              issuer: url.origin,
              authorization_endpoint: `${url.origin}/authorize`,
              token_endpoint: `${url.origin}/token`,
              registration_endpoint: `${url.origin}/register`,
              response_types_supported: ["code"],
              ...metadata,
            })
          if (request.method === "POST" && url.pathname === "/register") {
            registrations.push(await request.json())
            return Response.json({ client_id: "registered", redirect_uris: [] })
          }
          if (request.method === "POST" && url.pathname === "/token") {
            tokenRequests.push(new URLSearchParams(await request.text()))
            return Response.json({ access_token: "access", token_type: "Bearer" })
          }
          return new Response(null, { status: 404 })
        },
      })
      return { server, registrations, tokenRequests }
    }

    const start = (server: ReturnType<typeof Bun.serve>, oauth?: ConfigMCP.OAuth) =>
      Effect.gen(function* () {
        const authorization = yield* McpOAuth.authorize({
          name: "test",
          config: new ConfigMCP.Remote({ type: "remote", url: server.url.href, ...(oauth ? { oauth } : {}) }),
          methodID: Integration.MethodID.make("oauth"),
        })
        return { authorization, url: new URL(authorization.url) }
      })

    const cimd = { client_id_metadata_document_supported: true, token_endpoint_auth_methods_supported: ["none"] }

    test("uses the client metadata document when the server supports public CIMD clients", async () => {
      const { server, registrations, tokenRequests } = authorizationServer(cimd)
      const credential = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const { authorization, url } = yield* start(server)
            expect(url.searchParams.get("client_id")).toBe(McpOAuth.CLIENT_METADATA_URL)
            const redirect = new URL(url.searchParams.get("redirect_uri")!)
            redirect.searchParams.set("code", "accepted")
            redirect.searchParams.set("state", url.searchParams.get("state")!)
            yield* Effect.promise(() => fetch(redirect))
            return yield* authorization.callback
          }),
        ),
      ).finally(() => server.stop(true))

      expect(registrations).toHaveLength(0)
      expect(tokenRequests[0]?.get("client_id")).toBe(McpOAuth.CLIENT_METADATA_URL)
      expect(McpOAuth.clientFromCredential(credential)).toEqual({ client_id: McpOAuth.CLIENT_METADATA_URL })
      expect(McpOAuth.issuerFromCredential(credential)).toBe(server.url.origin)
    })

    test("registers dynamically when the server does not accept public clients", async () => {
      const { server, registrations } = authorizationServer({
        client_id_metadata_document_supported: true,
        token_endpoint_auth_methods_supported: ["client_secret_post"],
      })
      const { url } = await Effect.runPromise(Effect.scoped(start(server))).finally(() => server.stop(true))
      expect(url.searchParams.get("client_id")).toBe("registered")
      expect(registrations).toHaveLength(1)
    })

    test("registers dynamically when a custom redirect_uri is configured", async () => {
      const { server, registrations } = authorizationServer(cimd)
      const { url } = await Effect.runPromise(
        Effect.scoped(start(server, { redirect_uri: "http://127.0.0.1:0/custom" })),
      ).finally(() => server.stop(true))
      expect(url.searchParams.get("client_id")).toBe("registered")
      expect(registrations).toHaveLength(1)
    })
  })
})
