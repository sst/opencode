import { describe, expect } from "bun:test"
import { LLM, Message } from "@opencode/ai"
import { LLMClient, RequestExecutor } from "@opencode/ai/route"
import { Money } from "@opencode/schema/money"
import { Effect, Layer, Stream } from "effect"
import { TestClock } from "effect/testing"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { Catalog } from "@opencode/core/catalog"
import { Credential } from "@opencode/core/credential"
import { Integration } from "@opencode/core/integration"
import { Model } from "@opencode/core/model"
import { ModelResolver } from "@opencode/core/model-resolver"
import { Plugin } from "@opencode/core/plugin"
import { PluginHost } from "@opencode/core/plugin/host"
import { OpencodePlugin } from "@opencode/core/plugin/provider/opencode"
import { Provider } from "@opencode/core/provider"
import { WebSearch } from "@opencode/core/websearch"
import { withEnv } from "../fixture/env"
import { drain } from "../lib/clock"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const it = testEffect(PluginTestLayer)

const addPlugin = Effect.fn(function* () {
  const plugin = yield* Plugin.Service
  const host = yield* PluginHost.make(plugin)
  yield* OpencodePlugin.effect(host)
})

function consoleServer(orgID: string | null | undefined, unavailable = false) {
  const config: { authorization: string | null; orgID: string | null }[] = []
  const requests: string[] = []
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const path = new URL(request.url).pathname
      requests.push(path)
      if (path === "/auth/device/code") {
        expect(await request.json()).toEqual({ client_id: "opencode-cli", supports_org_scope: true })
        return Response.json({
          device_code: "device",
          user_code: "user",
          verification_uri_complete: "/device?user_code=user",
          expires_in: 60,
          interval: 0,
        })
      }
      if (path === "/auth/device/token") {
        return Response.json({ access_token: "access", refresh_token: "refresh", expires_in: 600, org_id: orgID })
      }
      if (unavailable && (path === "/api/user" || path === "/api/orgs")) {
        return new Response("Unavailable", { status: 503 })
      }
      if (path === "/api/user") return Response.json({ id: "user", email: "user@example.com" })
      if (path === "/api/orgs") {
        return Response.json([
          { id: "org-z", name: "Zebra" },
          { id: "org-a", name: "Alpha" },
        ])
      }
      if (path === "/api/v2/config") {
        config.push({ authorization: request.headers.get("authorization"), orgID: request.headers.get("x-org-id") })
        if (orgID === "org-missing") return new Response("Forbidden", { status: 403 })
        return Response.json({ providers: {} })
      }
      return new Response("Not found", { status: 404 })
    },
  })
  return { server, config, requests }
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected value")
  return value
}

function eventually<A>(
  effect: Effect.Effect<A>,
  predicate: (value: A) => boolean,
  remaining = 1000,
): Effect.Effect<A, Error> {
  return Effect.gen(function* () {
    const value = yield* effect
    if (predicate(value)) return value
    if (remaining === 0) return yield* Effect.fail(new Error("Timed out waiting for value"))
    yield* Effect.promise(() => Bun.sleep(1))
    return yield* eventually(effect, predicate, remaining - 1)
  })
}

const cost = (input: number, output = 0) => [
  {
    input: Money.USDPerMillionTokens.make(input),
    output: Money.USDPerMillionTokens.make(output),
    cache: {
      read: Money.USDPerMillionTokens.zero,
      write: Money.USDPerMillionTokens.zero,
    },
  },
]

describe("OpencodePlugin", () => {
  it.effect("registers account and service account methods", () =>
    Effect.gen(function* () {
      yield* addPlugin()
      const integrations = yield* Integration.Service
      expect((yield* integrations.get(Integration.ID.make("opencode")))?.methods).toEqual([
        {
          id: Integration.MethodID.make("device"),
          type: "oauth",
          label: "OpenCode Console account",
        },
        { type: "key", label: "API key (service account)" },
      ])
    }),
  )

  it.live("uses a canonical custom server throughout device authorization", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const requests: string[] = []
        const server = Bun.serve({
          port: 0,
          fetch: (request) => {
            const url = new URL(request.url)
            requests.push(`${request.method} ${url.pathname}`)
            if (url.pathname.endsWith("/auth/device/code")) {
              return Response.json({
                device_code: "device",
                user_code: "user",
                verification_uri_complete: "/console/device?user_code=user&client_id=opencode-cli",
                expires_in: 60,
                interval: 0,
              })
            }
            if (url.pathname.endsWith("/auth/device/token")) {
              return Response.json({ access_token: "access", refresh_token: "refresh", expires_in: 600 })
            }
            if (url.pathname.endsWith("/api/user")) return Response.json({ id: "user", email: "user@example.com" })
            if (url.pathname.endsWith("/api/orgs")) return Response.json([{ id: "org", name: "Org" }])
            return new Response("Not found", { status: 404 })
          },
        })
        return { requests, server }
      }),
      ({ requests, server }) =>
        Effect.gen(function* () {
          yield* addPlugin()
          const integrations = yield* Integration.Service
          const integrationID = Integration.ID.make("opencode")
          const attempt = yield* integrations.oauth.connect({
            integrationID,
            methodID: Integration.MethodID.make("device"),
            answer: { server: `${server.url.origin}/console///?ignored=true#ignored` },
          })
          expect(attempt.url).toBe(`${server.url.origin}/console/device?user_code=user&client_id=opencode-cli`)
          yield* eventually(
            integrations.oauth.status({ integrationID, attemptID: attempt.attemptID }),
            (status) => status.status === "complete",
          )

          expect(requests).toContain("POST /console/auth/device/code")
          expect(requests).toContain("POST /console/auth/device/token")
          expect(requests).toContain("GET /console/api/user")
          expect(requests).toContain("GET /console/api/orgs")
          const credentials = yield* Credential.Service
          expect((yield* credentials.list(Integration.ID.make("opencode")))[0]?.value).toMatchObject({
            metadata: { server: `${server.url.origin}/console` },
          })
        }),
      ({ server }) => Effect.promise(() => server.stop(true)),
    ),
  )

  it.live("rejects malformed device verification URLs", () =>
    Effect.acquireUseRelease(
      Effect.sync(() =>
        Bun.serve({
          port: 0,
          fetch: () =>
            Response.json({
              device_code: "device",
              user_code: "user",
              verification_uri_complete: "http://[::1",
              expires_in: 60,
              interval: 0,
            }),
        }),
      ),
      (server) =>
        Effect.gen(function* () {
          yield* addPlugin()
          const integrations = yield* Integration.Service
          const error = yield* integrations.oauth
            .connect({
              integrationID: Integration.ID.make("opencode"),
              methodID: Integration.MethodID.make("device"),
              answer: { server: server.url.origin },
            })
            .pipe(Effect.flip)
          expect(error).toBeInstanceOf(Integration.AuthorizationError)
          expect(String(error.cause)).toContain("Invalid device verification URL")
        }),
      (server) => Effect.promise(() => server.stop(true)),
    ),
  )

  for (const orgID of ["org-z", undefined, null, "org-missing"]) {
    it.live(`uses the device token organization during authorization: ${orgID}`, () =>
      Effect.acquireUseRelease(
        Effect.sync(() => consoleServer(orgID)),
        ({ server, config }) =>
          Effect.gen(function* () {
            yield* addPlugin()
            const integrations = yield* Integration.Service
            const credentials = yield* Credential.Service
            const integrationID = Integration.ID.make("opencode")
            const attempt = yield* integrations.oauth.connect({
              integrationID,
              methodID: Integration.MethodID.make("device"),
              answer: { server: server.url.origin },
            })
            const status = yield* eventually(
              integrations.oauth.status({ integrationID, attemptID: attempt.attemptID }),
              (status) => status.status !== "pending",
            )
            if (orgID === "org-missing") {
              expect(status).toMatchObject({
                status: "failed",
                message: "OpenCode organization not found: org-missing",
              })
              expect(yield* credentials.list(integrationID)).toEqual([])
              expect(config).toEqual([])
              return
            }
            expect(status.status).toBe("complete")
            expect((yield* credentials.list(integrationID))[0]).toMatchObject({
              label: orgID === "org-z" ? "Zebra" : "Alpha",
              value: {
                type: "oauth",
                access: "access",
                refresh: "refresh",
                metadata: {
                  server: server.url.origin,
                  accountID: "user",
                  email: "user@example.com",
                  orgID: orgID ?? "org-a",
                  orgName: orgID === "org-z" ? "Zebra" : "Alpha",
                },
              },
            })
            yield* eventually(
              Effect.sync(() => config.length),
              (count) => count > 0,
            )
            expect(config).toEqual([{ authorization: "Bearer access", orgID: orgID ?? "org-a" }])
          }),
        ({ server }) => Effect.promise(() => server.stop(true)),
      ),
    )
  }

  for (const scenario of [
    { orgID: "org-z" },
    { orgID: undefined },
    { orgID: null },
    { orgID: "org-missing" },
    { orgID: "org-z", unavailable: true },
    { orgID: "org-a", unavailable: true },
  ]) {
    it.live(
      `persists rotated credentials for ${scenario.orgID}${scenario.unavailable ? " with discovery unavailable" : ""}`,
      () =>
        Effect.acquireUseRelease(
          Effect.sync(() => consoleServer(scenario.orgID, scenario.unavailable)),
          ({ server, config, requests }) =>
            Effect.gen(function* () {
              const credentials = yield* Credential.Service
              const initial = yield* credentials.create({
                integrationID: Integration.ID.make("opencode"),
                label: "Custom label",
                value: Credential.OAuth.make({
                  type: "oauth",
                  methodID: Integration.MethodID.make("device"),
                  access: "expired-access",
                  refresh: "old-refresh",
                  expires: 0,
                  metadata: { server: server.url.origin, orgID: "org-a", orgName: "Alpha", custom: "preserved" },
                }),
              })
              yield* addPlugin()
              const stored = required(yield* credentials.get(initial.id))
              expect(stored).toMatchObject({
                label: "Custom label",
                value: {
                  access: "access",
                  refresh: "refresh",
                  metadata: {
                    server: server.url.origin,
                    orgID: scenario.orgID ?? "org-a",
                    orgName: scenario.orgID === "org-a" ? "Alpha" : (scenario.orgID ?? "Alpha"),
                    custom: "preserved",
                  },
                },
              })
              if (stored.value.type !== "oauth") throw new Error("Expected OAuth credential")
              expect(stored.value.expires).toBeGreaterThan(Date.now())
              if (scenario.orgID == null) expect(stored.value.metadata).toEqual(initial.value.metadata)
              expect(config).toEqual([{ authorization: "Bearer access", orgID: scenario.orgID ?? "org-a" }])
              const integrations = yield* Integration.Service
              expect(
                yield* integrations.connection.resolve({ type: "credential", id: initial.id, label: initial.label }),
              ).toEqual(stored.value)
              expect(requests).toEqual(["/auth/device/token", "/api/v2/config"])
            }),
          ({ server }) => Effect.promise(() => server.stop(true)),
        ),
    )
  }

  it.effect("rejects non-HTTP OpenCode servers", () =>
    Effect.gen(function* () {
      yield* addPlugin()
      const integrations = yield* Integration.Service
      const error = yield* integrations.oauth
        .connect({
          integrationID: Integration.ID.make("opencode"),
          methodID: Integration.MethodID.make("device"),
          answer: { server: "ftp://console.example.com" },
        })
        .pipe(Effect.flip)
      expect(error).toBeInstanceOf(Integration.AuthorizationError)
      expect(String(error.cause)).toContain("Invalid OpenCode server URL: expected HTTP(S)")
    }),
  )

  it.effect("rejects non-string OpenCode servers", () =>
    Effect.gen(function* () {
      yield* addPlugin()
      const integrations = yield* Integration.Service
      const error = yield* integrations.oauth
        .connect({
          integrationID: Integration.ID.make("opencode"),
          methodID: Integration.MethodID.make("device"),
          answer: { server: true },
        })
        .pipe(Effect.flip)
      expect(error).toBeInstanceOf(Integration.AuthorizationError)
      expect(String(error.cause)).toContain("Invalid OpenCode server URL: expected string")
    }),
  )

  it.live("loads native V2 providers and models from the connected OpenCode server", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const authorization: Array<string | null> = []
        const requests: string[] = []
        return {
          authorization,
          requests,
          server: Bun.serve({
            port: 0,
            fetch: (request) => {
              authorization.push(request.headers.get("authorization"))
              requests.push(`${request.method} ${new URL(request.url).pathname}`)
              const origin = new URL(request.url).origin
              return Response.json({
                providers: {
                  remote: {
                    canonical: "openai",
                    name: "Remote",
                    package: "aisdk:@ai-sdk/openai-compatible",
                    env: ["REMOTE_API_KEY"],
                    settings: {
                      baseURL: `${origin}/v1`,
                      apiKey: "{env:REMOTE_API_KEY}",
                      authToken: "provider-auth",
                      accessToken: "provider-access",
                      custom: "value",
                    },
                    headers: { "x-org-id": "org" },
                    models: {
                      model: {
                        modelID: "api-model",
                        name: "Remote Model",
                        family: "remote",
                        capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
                        settings: {
                          apiKey: "model-secret",
                          authToken: "model-auth",
                          accessToken: "model-access",
                          temperature: 0.5,
                        },
                        variants: [
                          {
                            id: "high",
                            settings: {
                              apiKey: "variant-secret",
                              authToken: "variant-auth",
                              accessToken: "variant-access",
                              temperature: 0.2,
                            },
                            headers: { "x-variant": "high" },
                          },
                        ],
                        cost: { input: 1, output: 2, cache: { read: 0.1 } },
                        limit: { context: 1000, output: 100 },
                      },
                      override: {
                        name: "Override",
                        package: "aisdk:@ai-sdk/anthropic",
                        settings: { baseURL: `${origin}/anthropic` },
                      },
                      disabled: { name: "Disabled", disabled: true },
                    },
                  },
                },
              })
            },
          }),
        }
      }),
      ({ authorization, requests, server }) =>
        Effect.gen(function* () {
          const credentials = yield* Credential.Service
          const catalog = yield* Catalog.Service
          const integrations = yield* Integration.Service
          yield* catalog.transform((editor) => {
            editor.provider.update(Provider.ID.openai, (provider) => {
              provider.package = Provider.aisdk("@ai-sdk/openai")
              provider.integrationID = Integration.ID.make("openai")
            })
            editor.model.update(Provider.ID.openai, Model.ID.make("api-model"), (model) => {
              model.package = Provider.aisdk("@ai-sdk/openai")
              model.settings = { baseURL: "https://upstream.example/v1" }
              model.variants = [
                {
                  id: Model.VariantID.make("custom"),
                  settings: {},
                  headers: { "x-custom": "true" },
                  body: { custom: true },
                },
              ]
            })
            editor.model.update(Provider.ID.make("remote"), Model.ID.make("stale"), () => {})
          })
          const initial = yield* credentials.create({
            integrationID: Integration.ID.make("opencode"),
            value: Credential.Key.make({
              type: "key",
              key: "secret",
              metadata: { server: server.url.origin },
            }),
          })

          yield* addPlugin()
          expect(authorization).toEqual(["Bearer secret"])
          expect(requests).toEqual(["GET /api/v2/config"])

          const provider = required(yield* catalog.provider.get(Provider.ID.make("remote")))
          expect(provider).toMatchObject({
            id: "remote",
            canonical: "openai",
            name: "Remote",
            integrationID: "opencode",
            package: Provider.aisdk("@ai-sdk/openai-compatible"),
            settings: { baseURL: `${server.url.origin}/v1`, custom: "value" },
            headers: { "x-org-id": "org" },
          })
          expect(yield* integrations.get(Integration.ID.make("remote"))).toBeUndefined()

          const model = required(yield* catalog.model.get(Provider.ID.make("remote"), Model.ID.make("model")))
          expect(model).toMatchObject({
            id: "model",
            modelID: "api-model",
            providerID: "remote",
            canonical: "openai",
            name: "Remote Model",
            family: "remote",
            capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
            cost: [{ input: 1, output: 2, cache: { read: 0.1, write: 0 } }],
            limit: { context: 1000, output: 100 },
            package: Provider.aisdk("@ai-sdk/openai-compatible"),
            settings: { baseURL: `${server.url.origin}/v1`, custom: "value", temperature: 0.5 },
            headers: { "x-org-id": "org" },
          })
          expect(model.settings).toEqual({ baseURL: `${server.url.origin}/v1`, custom: "value", temperature: 0.5 })
          const override = required(yield* catalog.model.get(Provider.ID.make("remote"), Model.ID.make("override")))
          expect(override.package).toBe(Provider.aisdk("@ai-sdk/anthropic"))
          expect(override.settings?.baseURL).toBe(`${server.url.origin}/anthropic`)
          expect(model.variants).toEqual([
            {
              id: Model.VariantID.make("custom"),
              settings: {},
              headers: { "x-custom": "true" },
              body: { custom: true },
            },
            {
              id: Model.VariantID.make("high"),
              settings: { temperature: 0.2 },
              headers: { "x-variant": "high" },
            },
          ])
          expect(
            required(yield* catalog.model.get(Provider.ID.make("remote"), Model.ID.make("disabled"))).enabled,
          ).toBe(false)
          expect(yield* catalog.model.get(Provider.ID.make("remote"), Model.ID.make("stale"))).toBeDefined()
          expect((yield* catalog.model.get(Provider.ID.openai, Model.ID.make("api-model")))?.settings?.baseURL).toBe(
            "https://upstream.example/v1",
          )

          yield* credentials.update(initial.id, { label: "Renamed" })
          yield* Effect.yieldNow
          expect(authorization).toEqual(["Bearer secret"])

          const replacement = yield* credentials.create({
            integrationID: Integration.ID.make("opencode"),
            value: Credential.Key.make({
              type: "key",
              key: "replacement",
              metadata: { server: server.url.origin },
            }),
          })
          yield* eventually(
            Effect.sync(() => authorization.length),
            (count) => count === 2,
          )
          expect(authorization).toEqual(["Bearer secret", "Bearer replacement"])
          expect(requests).toEqual(["GET /api/v2/config", "GET /api/v2/config"])

          yield* credentials.remove(initial.id)
          yield* Effect.yieldNow
          expect(authorization).toEqual(["Bearer secret", "Bearer replacement"])
          expect((yield* credentials.list(Integration.ID.make("opencode"))).at(-1)?.id).toBe(replacement.id)
        }),
      ({ server }) => Effect.promise(() => server.stop(true)),
    ),
  )

  it.effect("refreshes organization routes and replaces the previous organization's catalog", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const state = { advertised: false, disabled: false, alias: "coding", name: "Coding", requests: 0 }
        const inference: Array<{ body: unknown; authorization: string | null; orgID: string | null }> = []
        const server = Bun.serve({
          port: 0,
          fetch: async (request) => {
            if (new URL(request.url).pathname === "/route/openai/v1/responses") {
              inference.push({
                body: await request.json(),
                authorization: request.headers.get("authorization"),
                orgID: request.headers.get("x-opencode-org-id"),
              })
              const events = [
                {
                  type: "response.output_item.done",
                  item: {
                    type: "message",
                    id: "msg_route",
                    role: "assistant",
                    content: [{ type: "output_text", text: "Hello" }],
                    provider_metadata: { protocol: "anthropic-messages", connection_id: "conn_first" },
                  },
                },
                { type: "response.completed", response: { id: "resp_route" } },
              ]
              return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
                headers: { "content-type": "text/event-stream" },
              })
            }
            state.requests++
            const orgID = request.headers.get("x-org-id")
            return Response.json({
              providers: state.advertised
                ? {
                    [`opencode-routes-${orgID}`]: {
                      name: `${orgID} / Routes`,
                      package: "@opencode/ai/providers/organization-routes",
                      settings: {
                        baseURL: `${new URL(request.url).origin}/route/openai/v1`,
                        provider: `opencode-routes-${orgID}`,
                      },
                      headers: { "x-opencode-org-id": orgID },
                      models: {
                        route_1: {
                          name: state.name,
                          modelID: state.alias,
                          capabilities: { tools: true, input: ["text"], output: ["text"] },
                          cost: [],
                          limit: { context: 0, output: 0 },
                          disabled: state.disabled,
                        },
                      },
                    },
                  }
                : {},
            })
          },
        })
        return { server, state, inference }
      }),
      ({ server, state, inference }) =>
        Effect.gen(function* () {
          const credentials = yield* Credential.Service
          const catalog = yield* Catalog.Service
          const firstID = Provider.ID.make("opencode-routes-org_first")
          const secondID = Provider.ID.make("opencode-routes-org_second")
          const routeID = Model.ID.make("route_1")
          yield* catalog.transform((editor) => {
            editor.model.update(Provider.ID.openai, Model.ID.make("coding"), (model) => {
              model.name = "Upstream coding model"
              model.cost = cost(10)
            })
          })
          const first = yield* credentials.create({
            integrationID: Integration.ID.make("opencode"),
            value: Credential.Key.make({
              type: "key",
              key: "first-key",
              metadata: { server: server.url.origin, orgID: "org_first" },
            }),
          })
          yield* addPlugin()
          yield* drain
          expect(yield* catalog.provider.get(firstID)).toBeUndefined()

          state.advertised = true
          yield* TestClock.adjust("10 minutes")
          yield* drain
          expect(yield* catalog.provider.get(firstID)).toMatchObject({
            id: firstID,
            name: "org_first / Routes",
            integrationID: "opencode",
          })
          const route = required(yield* catalog.model.get(firstID, routeID))
          expect(route).toMatchObject({
            id: "route_1",
            modelID: "coding",
            name: "Coding",
            providerID: firstID,
            package: "@opencode/ai/providers/organization-routes",
            cost: [],
            limit: { context: 0, output: 0 },
            headers: { "x-opencode-org-id": "org_first" },
          })
          expect(route.canonical).toBeUndefined()
          expect((yield* catalog.model.available()).some((model) => model.providerID === firstID)).toBe(true)
          const firstModel = yield* ModelResolver.resolveModel(route, undefined, first.value)
          expect(String(firstModel.provider)).toBe(String(firstID))
          expect(firstModel.route.providerMetadataKey).toBe(firstID)
          const reply = yield* LLMClient.generate(LLM.request({ model: firstModel, prompt: "Hello" })).pipe(
            Effect.provide(LLMClient.layer.pipe(Layer.provide(RequestExecutor.layer))),
          )
          expect(inference[0]).toMatchObject({
            authorization: "Bearer first-key",
            orgID: "org_first",
            body: { model: "coding", stream: true, store: false },
          })
          expect(reply.message.content).toMatchObject([
            {
              type: "text",
              providerMetadata: { [firstID]: { providerMetadata: { protocol: "anthropic-messages" } } },
            },
          ])

          state.alias = "coding-renamed"
          state.name = "Renamed route"
          yield* TestClock.adjust("10 minutes")
          yield* drain
          expect(yield* catalog.model.get(firstID, routeID)).toMatchObject({
            id: "route_1",
            modelID: "coding-renamed",
            name: "Renamed route",
          })
          expect(yield* catalog.model.get(firstID, Model.ID.make("coding"))).toBeUndefined()

          state.disabled = true
          yield* TestClock.adjust("10 minutes")
          yield* drain
          expect((yield* catalog.model.available()).some((model) => model.providerID === firstID)).toBe(false)

          state.advertised = false
          yield* TestClock.adjust("10 minutes")
          yield* drain
          expect(yield* catalog.model.get(firstID, routeID)).toBeUndefined()
          expect(yield* catalog.provider.get(firstID)).toBeUndefined()

          state.advertised = true
          state.disabled = false
          yield* TestClock.adjust("10 minutes")
          yield* drain
          expect(yield* catalog.model.get(firstID, routeID)).toBeDefined()
          const requests = state.requests
          const second = yield* credentials.create({
            integrationID: Integration.ID.make("opencode"),
            value: Credential.Key.make({
              type: "key",
              key: "second-key",
              metadata: { server: server.url.origin, orgID: "org_second" },
            }),
          })
          yield* eventually(catalog.model.get(secondID, routeID), (model) => model !== undefined)
          expect(state.requests).toBe(requests + 1)
          expect(yield* catalog.provider.get(firstID)).toBeUndefined()
          expect(yield* catalog.model.get(firstID, routeID)).toBeUndefined()
          expect(yield* catalog.model.get(secondID, routeID)).toMatchObject({
            providerID: secondID,
            headers: { "x-opencode-org-id": "org_second" },
          })

          const secondModel = yield* ModelResolver.resolveModel(
            required(yield* catalog.model.get(secondID, routeID)),
            undefined,
            second.value,
          )
          expect(String(secondModel.provider)).toBe(String(secondID))
          expect(secondModel.route.providerMetadataKey).toBe(secondID)
          yield* LLMClient.generate(
            LLM.request({ model: secondModel, messages: [reply.message, Message.user("Continue")] }),
          ).pipe(Effect.provide(LLMClient.layer.pipe(Layer.provide(RequestExecutor.layer))))
          expect(inference[1]).toMatchObject({
            authorization: "Bearer second-key",
            orgID: "org_second",
            body: {
              model: "coding-renamed",
              input: [
                { role: "assistant", content: [{ type: "output_text", text: "Hello" }] },
                { role: "user", content: [{ type: "input_text", text: "Continue" }] },
              ],
            },
          })
          expect(JSON.stringify(inference[1].body)).not.toContain("conn_first")

          yield* credentials.remove(first.id)
          yield* credentials.remove(second.id)
          yield* eventually(catalog.provider.get(secondID), (provider) => provider === undefined)
          expect(yield* catalog.model.get(secondID, routeID)).toBeUndefined()
          expect(yield* catalog.model.get(Provider.ID.openai, Model.ID.make("coding"))).toMatchObject({
            name: "Upstream coding model",
            cost: cost(10),
          })
        }),
      ({ server }) => Effect.promise(() => server.stop(true)),
    ),
  )

  it.effect("refreshes hosted search with Console config and skips unchanged snapshots", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const state = { advertised: false, requests: 0 }
        const server = Bun.serve({
          port: 0,
          fetch: () => {
            state.requests++
            return Response.json({
              providers: {},
              ...(state.advertised ? { websearch: { providerID: "opencode" } } : {}),
            })
          },
        })
        return { server, state }
      }),
      ({ server, state }) =>
        Effect.gen(function* () {
          const credentials = yield* Credential.Service
          const catalog = yield* Catalog.Service
          const websearch = yield* WebSearch.Service
          const rebuilds = { catalog: 0, websearch: 0 }
          yield* credentials.create({
            integrationID: Integration.ID.make("opencode"),
            value: Credential.Key.make({ type: "key", key: "secret", metadata: { server: server.url.origin } }),
          })
          yield* catalog.transform(() => {
            rebuilds.catalog++
          })
          yield* websearch.transform(() => {
            rebuilds.websearch++
          })
          yield* addPlugin()
          yield* drain
          const initial = { ...rebuilds }
          expect(state.requests).toBe(1)
          expect(yield* websearch.default()).toBeUndefined()

          state.advertised = true
          yield* TestClock.adjust("9 minutes")
          yield* drain
          expect(state.requests).toBe(1)
          expect(rebuilds).toEqual(initial)
          expect(yield* websearch.default()).toBeUndefined()

          yield* TestClock.adjust("1 minute")
          yield* drain
          expect(state.requests).toBe(2)
          expect(rebuilds).toEqual({ catalog: initial.catalog + 1, websearch: initial.websearch + 1 })
          expect(yield* websearch.default()).toEqual({ id: WebSearch.ID.make("opencode"), name: "OpenCode Web Search" })

          yield* TestClock.adjust("10 minutes")
          yield* drain
          expect(state.requests).toBe(3)
          expect(rebuilds).toEqual({ catalog: initial.catalog + 1, websearch: initial.websearch + 1 })
          expect(yield* websearch.default()).toEqual({ id: WebSearch.ID.make("opencode"), name: "OpenCode Web Search" })

          state.advertised = false
          yield* TestClock.adjust("10 minutes")
          yield* drain
          expect(state.requests).toBe(4)
          expect(rebuilds).toEqual({ catalog: initial.catalog + 2, websearch: initial.websearch + 2 })
          expect(yield* websearch.providers()).toEqual([])
          expect(yield* websearch.default()).toBeUndefined()
        }),
      ({ server }) => Effect.promise(() => server.stop(true)),
    ),
  )

  it.live("loads and executes hosted web search from the connected OpenCode server", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const requests: Array<{
          method: string
          path: string
          authorization: string | null
          orgID: string | null
          body?: unknown
        }> = []
        const gate = Promise.withResolvers<void>()
        const state = { advertised: true, providerID: "opencode", waitForConfig: false }
        const server = Bun.serve({
          port: 0,
          fetch: async (request) => {
            const path = new URL(request.url).pathname
            const body = request.method === "POST" ? await request.json() : undefined
            requests.push({
              method: request.method,
              path,
              authorization: request.headers.get("authorization"),
              orgID: request.headers.get("x-org-id"),
              ...(body === undefined ? {} : { body }),
            })
            if (path === "/api/v2/config") {
              if (state.waitForConfig) await gate.promise
              return Response.json({
                providers: {},
                ...(state.advertised
                  ? {
                      websearch: {
                        providerID: "opencode",
                      },
                    }
                  : {}),
              })
            }
            if (path === "/api/websearch" || path === "/other/api/websearch") {
              return Response.json({
                providerID: state.providerID,
                results: [
                  {
                    url: "https://github.com/anomalyco/opencode",
                    title: "OpenCode",
                    content: "Open source AI coding agent.",
                    time: { published: 1_700_000_000_000 },
                  },
                ],
              })
            }
            return new Response("Not found", { status: 404 })
          },
        })
        return { gate, requests, server, state }
      }),
      ({ gate, requests, server, state }) =>
        Effect.gen(function* () {
          const credentials = yield* Credential.Service
          const websearch = yield* WebSearch.Service
          const account = (access: string, serverURL = server.url.origin, orgID = "org_test") =>
            Credential.OAuth.make({
              type: "oauth",
              methodID: Integration.MethodID.make("device"),
              access,
              refresh: "refresh",
              expires: Date.now() + 600_000,
              metadata: { server: serverURL, orgID },
            })
          const initial = yield* credentials.create({
            integrationID: Integration.ID.make("opencode"),
            value: account("secret"),
          })

          yield* addPlugin()
          expect(yield* websearch.providers()).toContainEqual({
            id: WebSearch.ID.make("opencode"),
            name: "OpenCode Web Search",
          })
          expect(yield* websearch.default()).toEqual({ id: WebSearch.ID.make("opencode"), name: "OpenCode Web Search" })
          expect(yield* websearch.query({ query: "effect web search" })).toEqual(
            new WebSearch.Response({
              providerID: WebSearch.ID.make("opencode"),
              results: [
                {
                  url: "https://github.com/anomalyco/opencode",
                  title: "OpenCode",
                  content: "Open source AI coding agent.",
                  time: { published: 1_700_000_000_000 },
                },
              ],
            }),
          )
          expect(requests).toEqual([
            {
              method: "GET",
              path: "/api/v2/config",
              authorization: "Bearer secret",
              orgID: "org_test",
            },
            {
              method: "POST",
              path: "/api/websearch",
              authorization: "Bearer secret",
              orgID: "org_test",
              body: { query: "effect web search", providerID: "opencode" },
            },
          ])

          yield* credentials.update(initial.id, {
            value: account("replacement"),
          })
          yield* websearch.query({ query: "fresh credential" })
          expect(requests.at(-1)).toMatchObject({
            method: "POST",
            authorization: "Bearer replacement",
            body: { query: "fresh credential", providerID: "opencode" },
          })

          yield* credentials.update(initial.id, {
            value: account("moved", `${server.url.origin}/other///?ignored=true#ignored`),
          })
          yield* websearch.query({ query: "updated server" })
          expect(requests.at(-1)).toMatchObject({
            method: "POST",
            path: "/other/api/websearch",
            authorization: "Bearer moved",
            orgID: "org_test",
            body: { query: "updated server", providerID: "opencode" },
          })
          yield* credentials.update(initial.id, {
            value: account("replacement"),
          })

          state.providerID = "unexpected"
          expect((yield* websearch.query({ query: "wrong provider" }).pipe(Effect.flip))._tag).toBe("WebSearch.Request")

          state.advertised = false
          state.waitForConfig = true
          const searchCount = requests.filter((request) => request.path === "/api/websearch").length
          yield* credentials.create({
            integrationID: Integration.ID.make("opencode"),
            value: account("switched", server.url.origin, "org_switched"),
          })
          yield* eventually(
            Effect.sync(() => requests),
            (requests) => requests.some((request) => request.authorization === "Bearer switched"),
          )
          expect((yield* websearch.query({ query: "switch race" }).pipe(Effect.flip))._tag).toBe("WebSearch.Request")
          expect(requests.filter((request) => request.path === "/api/websearch")).toHaveLength(searchCount)
          gate.resolve()
          yield* eventually(websearch.providers(), (providers) =>
            providers.every((provider) => provider.id !== WebSearch.ID.make("opencode")),
          )
          expect(yield* websearch.default()).toBeUndefined()
          expect(requests.at(-1)).toMatchObject({
            method: "GET",
            path: "/api/v2/config",
            authorization: "Bearer switched",
            orgID: "org_switched",
          })
        }),
      ({ gate, server }) =>
        Effect.sync(() => gate.resolve()).pipe(Effect.andThen(Effect.promise(() => server.stop(true)))),
    ),
  )

  it.live("derives hosted search identity and the default Console endpoint locally", () =>
    Effect.acquireUseRelease(
      Effect.sync(() =>
        Bun.serve({
          port: 0,
          fetch: (request) => {
            if (new URL(request.url).pathname === "/console/api/v2/config") {
              return Response.json({
                providers: {},
                websearch: {
                  providerID: "managed-search",
                  name: "Remote name",
                  url: "https://example.invalid/search",
                },
              })
            }
            return Response.json({ providerID: "managed-search", results: [] })
          },
        }),
      ),
      (server) =>
        Effect.gen(function* () {
          const credentials = yield* Credential.Service
          const websearch = yield* WebSearch.Service
          const http = yield* HttpClient.HttpClient
          const requests: string[] = []
          yield* credentials.create({
            integrationID: Integration.ID.make("opencode"),
            value: Credential.Key.make({ type: "key", key: "secret" }),
          })
          yield* addPlugin().pipe(
            Effect.provideService(
              HttpClient.HttpClient,
              http.pipe(
                HttpClient.mapRequest((request) => {
                  requests.push(request.url)
                  return HttpClientRequest.setUrl(request, `${server.url.origin}${new URL(request.url).pathname}`)
                }),
              ),
            ),
          )

          expect(yield* websearch.default()).toEqual({
            id: WebSearch.ID.make("managed-search"),
            name: "OpenCode Web Search",
          })
          expect(yield* websearch.query({ query: "default Console" })).toEqual(
            new WebSearch.Response({ providerID: WebSearch.ID.make("managed-search"), results: [] }),
          )
          expect(requests).toEqual([
            "https://opencode.ai/console/api/v2/config",
            "https://opencode.ai/console/api/websearch",
          ])
        }),
      (server) => Effect.promise(() => server.stop(true)),
    ),
  )

  it.live("does not forward hosted search credentials through redirects", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const requests: string[] = []
        const state = { crossOrigin: false }
        const server = Bun.serve({
          port: 0,
          fetch: (request) => {
            const url = new URL(request.url)
            requests.push(url.pathname)
            if (url.pathname === "/console/api/v2/config") {
              return Response.json({
                providers: {},
                websearch: {
                  providerID: "opencode",
                },
              })
            }
            if (url.pathname === "/console/api/websearch") {
              if (state.crossOrigin) url.hostname = "127.0.0.1"
              return Response.redirect(`${url.origin}/outside-console`, 307)
            }
            return Response.json({ providerID: "opencode", results: [] })
          },
        })
        return { requests, server, state }
      }),
      ({ requests, server, state }) =>
        Effect.gen(function* () {
          const credentials = yield* Credential.Service
          const websearch = yield* WebSearch.Service
          yield* credentials.create({
            integrationID: Integration.ID.make("opencode"),
            value: Credential.Key.make({
              type: "key",
              key: "secret",
              metadata: { server: `${server.url.origin}/console`, orgID: "org_test" },
            }),
          })
          yield* addPlugin()

          expect((yield* websearch.query({ query: "private search" }).pipe(Effect.flip))._tag).toBe("WebSearch.Request")
          expect(requests).toEqual(["/console/api/v2/config", "/console/api/websearch"])

          state.crossOrigin = true
          expect((yield* websearch.query({ query: "private search" }).pipe(Effect.flip))._tag).toBe("WebSearch.Request")
          expect(requests).toEqual(["/console/api/v2/config", "/console/api/websearch", "/console/api/websearch"])
        }),
      ({ server }) => Effect.promise(() => server.stop(true)),
    ),
  )

  it.live("closes a rejected hosted search response without waiting for its body", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const state = { cancelled: false }
        const server = Bun.serve({
          port: 0,
          fetch: (request) => {
            const url = new URL(request.url)
            if (url.pathname === "/api/v2/config") {
              return Response.json({
                providers: {},
                websearch: {
                  providerID: "opencode",
                },
              })
            }
            return new Response(
              new ReadableStream({
                start(controller) {
                  controller.enqueue(new TextEncoder().encode("temporarily unavailable"))
                },
                cancel() {
                  state.cancelled = true
                },
              }),
              { status: 503 },
            )
          },
        })
        return { server, state }
      }),
      ({ server, state }) =>
        Effect.gen(function* () {
          const credentials = yield* Credential.Service
          const websearch = yield* WebSearch.Service
          yield* credentials.create({
            integrationID: Integration.ID.make("opencode"),
            value: Credential.Key.make({
              type: "key",
              key: "secret",
              metadata: { server: server.url.origin, orgID: "org_test" },
            }),
          })
          yield* addPlugin()

          const error = yield* websearch.query({ query: "rejected search" }).pipe(Effect.flip)
          expect(error._tag).toBe("WebSearch.Request")
          yield* eventually(
            Effect.sync(() => state.cancelled),
            (cancelled) => cancelled,
          )
          // Callers can retain errors, so response cleanup must not depend on garbage collection.
          expect(error).toBeInstanceOf(WebSearch.RequestError)
        }),
      ({ server }) => Effect.promise(() => server.stop(true)),
    ),
  )

  it.live("preserves native Console OpenAI variant bodies in inference requests", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const variants = [
          {
            id: "effort-only",
            body: { reasoning: { effort: "low" } },
          },
          {
            id: "summary-only",
            body: { reasoning: { summary: "detailed" } },
          },
          {
            id: "native",
            body: { reasoning: { effort: "high", summary: "auto" } },
          },
          { id: "plain", body: {} },
        ]
        const models = {
          astra: {
            modelID: "api-astra",
            variants: variants.map((variant) => ({
              id: variant.id,
              headers: { "x-variant": variant.id },
              body: {
                ...variant.body,
                include: ["reasoning.encrypted_content"],
                metadata: { custom: "unchanged" },
              },
            })),
          },
        }
        const requests: { body: unknown; variant: string | null }[] = []
        return {
          variants,
          requests,
          server: Bun.serve({
            port: 0,
            fetch: async (request) => {
              if (new URL(request.url).pathname === "/responses") {
                requests.push({ body: await request.json(), variant: request.headers.get("x-variant") })
                return new Response('data: {"type":"response.completed","response":{"id":"resp_test"}}\n\n', {
                  headers: { "content-type": "text/event-stream" },
                })
              }
              return Response.json({
                providers: {
                  remote: {
                    canonical: "openai",
                    package: "aisdk:@ai-sdk/openai",
                    settings: { baseURL: new URL(request.url).origin },
                    models: {
                      ...models,
                      override: { ...models.astra, package: "aisdk:@ai-sdk/openai-compatible" },
                    },
                  },
                  compatible: {
                    canonical: "openai",
                    package: "aisdk:@ai-sdk/openai-compatible",
                    models,
                  },
                },
              })
            },
          }),
        }
      }),
      ({ variants, requests, server }) =>
        Effect.gen(function* () {
          const credentials = yield* Credential.Service
          const catalog = yield* Catalog.Service
          const credential = Credential.Key.make({
            type: "key",
            key: "secret",
            metadata: { server: server.url.origin },
          })
          yield* credentials.create({ integrationID: Integration.ID.make("opencode"), value: credential })
          yield* addPlugin()
          const model = required(yield* catalog.model.get(Provider.ID.make("remote"), Model.ID.make("astra")))
          expect(model.canonical).toBe(Provider.ID.openai)
          yield* Effect.forEach(variants, (variant, index) =>
            Effect.gen(function* () {
              const projected = required(model.variants.find((item) => item.id === variant.id))
              expect(projected.body).toEqual({
                ...variant.body,
                include: ["reasoning.encrypted_content"],
                metadata: { custom: "unchanged" },
              })
              expect(projected.settings).toBeUndefined()
              const resolved = yield* ModelResolver.resolveModel(model, Model.VariantID.make(variant.id), credential)
              yield* LLMClient.stream(LLM.request({ model: resolved, prompt: "Hello" })).pipe(
                Stream.runDrain,
                Effect.provide(LLMClient.layer.pipe(Layer.provide(RequestExecutor.layer))),
              )
              expect(requests).toHaveLength(index + 1)
              const request = required(requests.at(-1))
              expect(request.variant).toBe(variant.id)
              expect(request.body).toMatchObject({
                ...variant.body,
                model: "api-astra",
                include: ["reasoning.encrypted_content"],
                metadata: { custom: "unchanged" },
              })
              expect(request.body).not.toHaveProperty("reasoningEffort")
              expect(request.body).not.toHaveProperty("reasoningSummary")
              if (variant.id === "plain") expect(request.body).not.toHaveProperty("reasoning")
            }),
          )
          const compatible = required(yield* catalog.model.get(Provider.ID.make("compatible"), Model.ID.make("astra")))
          const override = required(yield* catalog.model.get(Provider.ID.make("remote"), Model.ID.make("override")))
          for (const model of [compatible, override]) {
            expect(model.variants.find((variant) => variant.id === "native")?.body).toEqual({
              reasoning: { effort: "high", summary: "auto" },
              include: ["reasoning.encrypted_content"],
              metadata: { custom: "unchanged" },
            })
          }
        }),
      ({ server }) => Effect.promise(() => server.stop(true)),
    ),
  )

  it.effect("uses a public key and disables paid models without credentials", () =>
    withEnv({ OPENCODE_API_KEY: undefined }, () =>
      Effect.gen(function* () {
        const catalog = yield* Catalog.Service
        yield* catalog.transform((catalog) => {
          catalog.provider.update(Provider.ID.opencode, () => {})
          catalog.model.update(Provider.ID.opencode, Model.ID.make("paid"), (draft) => {
            draft.cost = cost(1)
          })
        })
        yield* addPlugin()
        expect(required(yield* catalog.provider.get(Provider.ID.opencode)).settings?.apiKey).toBe("public")
        expect(required(yield* catalog.model.get(Provider.ID.opencode, Model.ID.make("paid"))).enabled).toBe(false)
      }),
    ),
  )

  it.effect("keeps free models without credentials", () =>
    withEnv({ OPENCODE_API_KEY: undefined }, () =>
      Effect.gen(function* () {
        const catalog = yield* Catalog.Service
        yield* catalog.transform((catalog) => {
          catalog.provider.update(Provider.ID.opencode, () => {})
          catalog.model.update(Provider.ID.opencode, Model.ID.make("free"), (draft) => {
            draft.cost = cost(0)
          })
        })
        yield* addPlugin()
        expect(required(yield* catalog.provider.get(Provider.ID.opencode)).settings?.apiKey).toBe("public")
        expect(required(yield* catalog.provider.get(Provider.ID.opencode)).activation).toBe("enabled")
        expect((yield* catalog.provider.available()).map((provider) => provider.id)).toContain(Provider.ID.opencode)
        expect(required(yield* catalog.model.get(Provider.ID.opencode, Model.ID.make("free"))).enabled).toBe(true)
      }),
    ),
  )

  it.effect("treats output-only cost as free without credentials", () =>
    withEnv({ OPENCODE_API_KEY: undefined }, () =>
      Effect.gen(function* () {
        const catalog = yield* Catalog.Service
        yield* catalog.transform((catalog) => {
          catalog.provider.update(Provider.ID.opencode, () => {})
          catalog.model.update(Provider.ID.opencode, Model.ID.make("output-only"), (draft) => {
            draft.cost = cost(0, 1)
          })
        })
        yield* addPlugin()
        expect(required(yield* catalog.provider.get(Provider.ID.opencode)).settings?.apiKey).toBe("public")
        expect(required(yield* catalog.model.get(Provider.ID.opencode, Model.ID.make("output-only"))).enabled).toBe(
          true,
        )
      }),
    ),
  )

  it.effect("uses OPENCODE_API_KEY as credentials", () =>
    withEnv({ OPENCODE_API_KEY: "secret" }, () =>
      Effect.gen(function* () {
        const catalog = yield* Catalog.Service
        yield* catalog.transform((catalog) => {
          catalog.provider.update(Provider.ID.opencode, () => {})
          catalog.model.update(Provider.ID.opencode, Model.ID.make("paid"), (draft) => {
            draft.cost = cost(1)
          })
        })
        yield* addPlugin()
        expect(required(yield* catalog.provider.get(Provider.ID.opencode)).settings?.apiKey).toBeUndefined()
        expect(required(yield* catalog.model.get(Provider.ID.opencode, Model.ID.make("paid"))).enabled).toBe(true)
      }),
    ),
  )

  it.effect("uses configured provider env vars as credentials", () =>
    withEnv({ OPENCODE_API_KEY: undefined, CUSTOM_OPENCODE_API_KEY: "secret" }, () =>
      Effect.gen(function* () {
        const catalog = yield* Catalog.Service
        const integrations = yield* Integration.Service
        yield* integrations.transform((editor) => {
          editor.method.update({
            integrationID: Integration.ID.make("opencode"),
            method: { type: "env", names: ["CUSTOM_OPENCODE_API_KEY"] },
          })
        })
        yield* catalog.transform((catalog) => {
          catalog.provider.update(Provider.ID.opencode, () => {})
          catalog.model.update(Provider.ID.opencode, Model.ID.make("paid"), (draft) => {
            draft.cost = cost(1)
          })
        })
        // An env credential has no server metadata, so the plugin would ask the
        // default Console for remote config; answer 404 (no remote config) locally.
        yield* addPlugin().pipe(
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.make((request) =>
              Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status: 404 }))),
            ),
          ),
        )
        expect(required(yield* catalog.provider.get(Provider.ID.opencode)).settings?.apiKey).toBeUndefined()
        expect(required(yield* catalog.model.get(Provider.ID.opencode, Model.ID.make("paid"))).enabled).toBe(true)
      }),
    ),
  )

  it.effect("uses configured apiKey as credentials", () =>
    withEnv({ OPENCODE_API_KEY: undefined }, () =>
      Effect.gen(function* () {
        const catalog = yield* Catalog.Service
        yield* catalog.transform((catalog) => {
          catalog.provider.update(Provider.ID.opencode, (draft) => {
            draft.package = Provider.aisdk("test-provider")
            draft.settings = { apiKey: "configured" }
          })
          catalog.model.update(Provider.ID.opencode, Model.ID.make("paid"), (draft) => {
            draft.cost = cost(1)
          })
        })
        yield* addPlugin()
        expect(required(yield* catalog.provider.get(Provider.ID.opencode)).settings?.apiKey).toBe("configured")
        expect(required(yield* catalog.model.get(Provider.ID.opencode, Model.ID.make("paid"))).enabled).toBe(true)
      }),
    ),
  )

  it.effect("ignores non-opencode providers and models", () =>
    withEnv({ OPENCODE_API_KEY: undefined }, () =>
      Effect.gen(function* () {
        const catalog = yield* Catalog.Service
        yield* catalog.transform((catalog) => {
          catalog.provider.update(Provider.ID.openai, () => {})
          catalog.model.update(Provider.ID.openai, Model.ID.make("paid"), (draft) => {
            draft.cost = cost(1)
          })
        })
        yield* addPlugin()
        expect(required(yield* catalog.provider.get(Provider.ID.openai)).settings?.apiKey).toBeUndefined()
        expect(required(yield* catalog.model.get(Provider.ID.openai, Model.ID.make("paid"))).enabled).toBe(true)
      }),
    ),
  )
})
