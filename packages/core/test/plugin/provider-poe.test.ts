import { LLM } from "@opencode/ai"
import { LLMClient, RequestExecutor } from "@opencode/ai/route"
import { Catalog } from "@opencode/core/catalog"
import { Credential } from "@opencode/core/credential"
import { Integration } from "@opencode/core/integration"
import { Model } from "@opencode/core/model"
import { ModelResolver } from "@opencode/core/model-resolver"
import { Plugin } from "@opencode/core/plugin"
import { PluginHost } from "@opencode/core/plugin/host"
import { ProviderPlugins } from "@opencode/core/plugin/provider"
import { PoePlugin } from "@opencode/core/plugin/provider/poe"
import { Provider } from "@opencode/core/provider"
import { expect } from "bun:test"
import { Clock, Deferred, Effect, Fiber, Layer, Schedule, Stream } from "effect"
import { TestClock } from "effect/testing"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const it = testEffect(PluginTestLayer)
const integrationID = Integration.ID.make("poe")
const providerID = Provider.ID.make("poe")
const methodID = Integration.MethodID.make("browser")
const modelID = Model.ID.make("test-model")

const fixture = Effect.gen(function* () {
  const requests: Request[] = []
  const replies: (Response | Effect.Effect<Response>)[] = []
  const http = HttpClient.make((request) =>
    Effect.gen(function* () {
      requests.push(yield* HttpClientRequest.toWeb(request).pipe(Effect.orDie))
      const response = replies.shift()
      if (!response) throw new Error(`Unexpected request: ${request.url}`)
      return HttpClientResponse.fromWeb(request, yield* Effect.isEffect(response) ? response : Effect.succeed(response))
    }),
  )
  const integrations = yield* Integration.Service
  const credentials = yield* Credential.Service
  const catalog = yield* Catalog.Service
  yield* integrations.transform((editor) => {
    editor.method.update({ integrationID, method: { type: "key" } })
    editor.method.update({ integrationID, method: { type: "env", names: ["POE_API_KEY"] } })
  })
  yield* catalog.transform((editor) => {
    editor.provider.update(providerID, (provider) => {
      provider.package = Provider.aisdk("@ai-sdk/openai-compatible")
      provider.settings = { baseURL: "https://api.poe.com/v1" }
    })
    editor.model.update(providerID, modelID, () => {})
  })
  const plugin = yield* Plugin.Service
  const host = yield* PluginHost.make(plugin)
  yield* PoePlugin.effect(host).pipe(Effect.provideService(HttpClient.HttpClient, http))
  const status = (attemptID: Integration.AttemptID) =>
    integrations.oauth.status({ integrationID, attemptID }).pipe(
      Effect.repeat({
        until: (value) => value.status !== "pending",
        schedule: Schedule.spaced("1 millis"),
        times: 100,
      }),
    )
  const connect = Effect.gen(function* () {
    const attempt = yield* integrations.oauth.connect({ integrationID, methodID, label: "Poe browser" })
    const url = new URL(attempt.url)
    const callback = new URL(url.searchParams.get("redirect_uri") ?? "")
    callback.searchParams.set("state", url.searchParams.get("state") ?? "")
    callback.searchParams.set("code", "auth-code")
    return { attempt, url, callback }
  })
  const send = Effect.gen(function* () {
    const resolver = yield* ModelResolver.Service
    const resolved = yield* resolver.resolve(Model.Ref.make({ providerID, id: modelID }))
    if (!resolved) throw new Error("Expected Poe model")
    expect(resolved.model.route.id).toBe("openai-compatible-chat")
    return yield* LLMClient.stream(LLM.request({ model: resolved.model, prompt: "Hello" })).pipe(
      Stream.runCollect,
      Effect.provide(LLMClient.layer.pipe(Layer.provide(RequestExecutor.layer), Layer.fresh)),
      Effect.provideService(HttpClient.HttpClient, http),
    )
  }).pipe(Effect.provide(ModelResolver.layer))
  return { requests, replies, integrations, credentials, status, connect, send }
})

it.effect("registers Poe browser OAuth alongside generic key and environment methods without fetching", () =>
  Effect.gen(function* () {
    const test = yield* fixture
    expect(ProviderPlugins).toContain(PoePlugin)
    expect((yield* test.integrations.get(integrationID))?.methods).toEqual([
      { type: "key" },
      { type: "env", names: ["POE_API_KEY"] },
      { id: methodID, type: "oauth", label: "Login with Poe (browser)" },
    ])
    expect(test.requests).toHaveLength(0)
  }),
)

for (const expiry of [3600, null, undefined]) {
  it.live(`exchanges a PKCE code for a native Poe credential (expiry: ${expiry})`, () =>
    Effect.gen(function* () {
      const test = yield* fixture
      yield* test.integrations.connection.key({ integrationID, key: "previous-key", label: "Previous account" })
      const previous = yield* test.integrations.connection.active(integrationID)
      const login = yield* test.connect
      expect(yield* test.integrations.connection.active(integrationID)).toEqual(previous)
      const url = login.url
      expect(url.origin + url.pathname).toBe("https://poe.com/oauth/authorize")
      expect(Object.fromEntries(url.searchParams)).toMatchObject({
        response_type: "code",
        client_id: "client_728290227fc048cc9262091a1ea197ea",
        scope: "apikey:create",
        code_challenge_method: "S256",
      })
      const callback = login.callback
      expect(callback.hostname).toBe("127.0.0.1")
      expect(callback.pathname).toBe("/callback")
      expect(url.searchParams.get("state")).toBeTruthy()
      // Both issuer-bearing and documented issuer-less callbacks must work.
      if (expiry != null) callback.searchParams.set("iss", "https://poe.com")
      test.replies.push(Response.json({ api_key: " poe-key ", api_key_expires_in: expiry }))
      const now = Date.now()
      expect((yield* Effect.promise(() => fetch(callback, { headers: { Connection: "close" } }))).status).toBe(200)
      expect((yield* test.status(login.attempt.attemptID)).status).toBe("complete")
      const exchange = test.requests[0]
      expect(exchange.url).toBe("https://api.poe.com/token")
      expect(exchange.headers.get("content-type")).toContain("application/x-www-form-urlencoded")
      const form = new URLSearchParams(yield* Effect.promise(() => exchange.text()))
      expect(Object.fromEntries(form)).toMatchObject({
        grant_type: "authorization_code",
        client_id: "client_728290227fc048cc9262091a1ea197ea",
        code: "auth-code",
        redirect_uri: url.searchParams.get("redirect_uri"),
      })
      expect(url.searchParams.get("code_challenge")).toBe(
        Buffer.from(
          yield* Effect.promise(() =>
            crypto.subtle.digest("SHA-256", new TextEncoder().encode(form.get("code_verifier") ?? "")),
          ),
        ).toString("base64url"),
      )
      const records = yield* test.credentials.list(integrationID)
      const active = records.find((credential) => credential.label === "Poe browser")
      expect(records).toHaveLength(2)
      expect(yield* test.integrations.connection.active(integrationID)).toMatchObject({
        type: "credential",
        id: active?.id,
        label: "Poe browser",
      })
      const saved = active?.value
      if (saved?.type !== "oauth") throw new Error("Expected OAuth credential")
      expect(saved.access).toBe("poe-key")
      expect(saved.refresh).toBe("")
      if (expiry == null) expect(saved.expires).toBe(8_640_000_000_000_000)
      if (expiry != null) {
        expect(saved.expires).toBeGreaterThanOrEqual(now + expiry * 1000)
        expect(saved.expires).toBeLessThanOrEqual(Date.now() + expiry * 1000)
      }
      test.replies.push(
        new Response(
          'data: {"choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
          {
            headers: { "Content-Type": "text/event-stream" },
          },
        ),
      )
      expect(yield* test.send).toContainEqual(expect.objectContaining({ type: "text-delta", text: "Hello" }))
      expect(test.requests[1].url).toBe("https://api.poe.com/v1/chat/completions")
      expect(test.requests[1].headers.get("authorization")).toBe("Bearer poe-key")
      yield* test.integrations.oauth.complete({ integrationID, attemptID: login.attempt.attemptID })
      expect(yield* test.credentials.list(integrationID)).toEqual(records)
      expect(test.requests).toHaveLength(2)
    }),
  )
}

it.live("isolates overlapping login attempts and closes cancelled listeners", () =>
  Effect.gen(function* () {
    const test = yield* fixture
    const first = yield* test.connect
    const next = yield* test.connect
    expect(first.callback.origin).not.toBe(next.callback.origin)
    expect(first.url.searchParams.get("code_challenge")).not.toBe(next.url.searchParams.get("code_challenge"))
    expect(first.url.searchParams.get("state")).not.toBe(next.url.searchParams.get("state"))
    first.callback.searchParams.set("state", next.url.searchParams.get("state") ?? "")
    expect((yield* Effect.promise(() => fetch(first.callback, { headers: { Connection: "close" } }))).status).toBe(400)
    expect(yield* test.status(first.attempt.attemptID)).toMatchObject({
      status: "failed",
      message: "Invalid OAuth state",
    })
    expect((yield* test.integrations.oauth.status({ integrationID, attemptID: next.attempt.attemptID })).status).toBe(
      "pending",
    )
    yield* test.integrations.oauth.cancel({ integrationID, attemptID: next.attempt.attemptID })
    expect((yield* Effect.tryPromise(() => fetch(next.callback)).pipe(Effect.exit))._tag).toBe("Failure")
    expect(test.requests).toHaveLength(0)
    expect(yield* test.credentials.list(integrationID)).toEqual([])
  }),
)

for (const invalid of [
  { params: { state: "" }, message: "Invalid OAuth state" },
  { params: { iss: "https://other.example", error: "access_denied" }, message: "Invalid OAuth issuer" },
  { params: { iss: "https://poe.com/" }, message: "Invalid OAuth issuer" },
  { params: { iss: "" }, message: "Invalid OAuth issuer" },
  { params: { code: "" }, message: "Missing authorization code" },
  { params: { error: "access_denied", error_description: "User declined access" }, message: "User declined access" },
]) {
  it.live(`rejects invalid or denied callbacks (${JSON.stringify(invalid.params)})`, () =>
    Effect.gen(function* () {
      const test = yield* fixture
      const login = yield* test.connect
      Object.entries(invalid.params).forEach(([key, value]) => login.callback.searchParams.set(key, value))
      const response = yield* Effect.promise(() => fetch(login.callback, { headers: { Connection: "close" } }))
      expect(response.status).toBe(400)
      expect(yield* Effect.promise(() => response.text())).toContain("Authorization failed")
      expect(yield* test.status(login.attempt.attemptID)).toMatchObject({ status: "failed", message: invalid.message })
      expect(test.requests).toHaveLength(0)
      expect(yield* test.credentials.list(integrationID)).toEqual([])
    }),
  )
}

for (const response of [
  {
    status: 400,
    body: JSON.stringify({ error: "invalid_grant", error_description: "Code expired" }),
    message: "Poe token exchange failed: Code expired",
  },
  {
    status: 400,
    body: JSON.stringify({ error: "invalid_grant" }),
    message: "Poe token exchange failed: invalid_grant",
  },
  { status: 502, body: "Bad gateway", message: "Poe token exchange failed (502)" },
  {
    status: 400,
    body: JSON.stringify({ error_description: "Rejected auth-code" }),
    message: "Poe token exchange failed (400)",
  },
  ...[
    "{}",
    "{",
    '{"api_key":"   "}',
    '{"api_key":"poe-key","api_key_expires_in":-1}',
    '{"api_key":"poe-key","api_key_expires_in":1.5}',
    '{"api_key":"poe-key","api_key_expires_in":1e309}',
  ].map((body) => ({ status: 200, body, message: "Invalid Poe token response" })),
  {
    status: 200,
    body: '{"api_key":"poe-key","api_key_expires_in":8640000000000}',
    message: "Invalid Poe API key expiry",
  },
]) {
  it.live(`preserves the active connection after a failed token exchange (${response.status}: ${response.body})`, () =>
    Effect.gen(function* () {
      const test = yield* fixture
      yield* test.integrations.connection.key({ integrationID, key: "previous-key" })
      const previous = yield* test.integrations.connection.active(integrationID)
      const saved = yield* test.credentials.list(integrationID)
      const login = yield* test.connect
      test.replies.push(new Response(response.body, { status: response.status }))
      const page = yield* Effect.promise(() => fetch(login.callback, { headers: { Connection: "close" } }))
      expect(page.status).toBe(400)
      expect(yield* Effect.promise(() => page.text())).toContain(response.message)
      expect(yield* test.status(login.attempt.attemptID)).toMatchObject({ status: "failed", message: response.message })
      expect(yield* test.credentials.list(integrationID)).toEqual(saved)
      expect(yield* test.integrations.connection.active(integrationID)).toEqual(previous)
    }),
  )
}

for (const cancel of [false, true]) {
  it.live(`waits for the token exchange and consumes the callback once (cancel: ${cancel})`, () =>
    Effect.gen(function* () {
      const test = yield* fixture
      const login = yield* test.connect
      const started = yield* Deferred.make<void>()
      const token = yield* Deferred.make<Response>()
      test.replies.push(Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(token))))
      const page = yield* Effect.tryPromise(() => fetch(login.callback, { headers: { Connection: "close" } })).pipe(
        Effect.exit,
        Effect.forkScoped,
      )
      yield* Deferred.await(started)
      expect(
        (yield* test.integrations.oauth.status({ integrationID, attemptID: login.attempt.attemptID })).status,
      ).toBe("pending")
      expect(yield* test.credentials.list(integrationID)).toEqual([])
      expect((yield* Effect.promise(() => fetch(login.callback, { headers: { Connection: "close" } }))).status).toBe(
        409,
      )
      expect(test.requests).toHaveLength(1)
      if (cancel) {
        yield* test.integrations.oauth.cancel({ integrationID, attemptID: login.attempt.attemptID })
        yield* Deferred.succeed(token, Response.json({ api_key: "cancelled-key" }))
        expect((yield* Fiber.join(page))._tag).toBe("Failure")
        expect(yield* test.credentials.list(integrationID)).toEqual([])
        return
      }
      yield* Deferred.succeed(token, Response.json({ api_key: "poe-key" }))
      const result = yield* Fiber.join(page)
      const response = yield* result
      expect(response.status).toBe(200)
      expect(yield* Effect.promise(() => response.text())).toContain("Authorization successful")
      expect((yield* test.status(login.attempt.attemptID)).status).toBe("complete")
      expect(yield* test.credentials.list(integrationID)).toHaveLength(1)
    }),
  )
}

it.effect("keeps near-expiry keys usable and requires a new login after expiry", () =>
  Effect.gen(function* () {
    const test = yield* fixture
    const saved = yield* test.credentials.create({
      integrationID,
      value: Credential.OAuth.make({
        type: "oauth",
        methodID,
        access: "poe-key",
        refresh: "",
        expires: (yield* Clock.currentTimeMillis) + 120_000,
      }),
    })
    const connection = { type: "credential" as const, id: saved.id, label: saved.label }
    expect(yield* test.integrations.connection.resolve(connection)).toEqual(saved.value)
    yield* TestClock.adjust("2 minutes")
    const error = yield* test.integrations.connection.resolve(connection).pipe(Effect.flip)
    expect(error.cause).toEqual(new Error("Poe API key expired. Log in with Poe again."))
    yield* test.integrations.connection.key({ integrationID, key: "manual-key" })
    const active = yield* test.integrations.connection.active(integrationID)
    if (!active) throw new Error("Expected key connection")
    expect(yield* test.integrations.connection.resolve(active)).toEqual({ type: "key", key: "manual-key" })
    expect(test.requests).toHaveLength(0)
  }),
)
