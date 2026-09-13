import { define } from "@opencode/plugin/effect/plugin"
import { Clock, Deferred, Effect, Option, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import type { ServerResponse } from "node:http"
import { Credential } from "../../credential.js"
import { Integration } from "../../integration.js"
import { OauthCallbackPage } from "../../oauth/page.js"

const integrationID = Integration.ID.make("poe")
const methodID = Integration.MethodID.make("browser")
const clientID = "client_728290227fc048cc9262091a1ea197ea"
const issuer = "https://poe.com"
const maxExpiry = 8_640_000_000_000_000
const Token = Schema.Struct({
  api_key: Schema.Trim.check(Schema.isNonEmpty(), Schema.isPattern(/^\S+$/)),
  api_key_expires_in: Schema.optional(Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)))),
})
const decodeError = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({ error: Schema.optional(Schema.String), error_description: Schema.optional(Schema.String) }),
  ),
)

export const PoePlugin = define({
  id: "opencode.provider.poe",
  effect: Effect.fn(function* (ctx) {
    const http = yield* HttpClient.HttpClient
    yield* ctx.integration.transform((editor) => {
      editor.method.update({
        integrationID,
        method: { id: methodID, type: "oauth", label: "Login with Poe (browser)" },
        // Poe-issued API keys remain usable until expiry, then require another login.
        refresh: (value) =>
          Clock.currentTimeMillis.pipe(
            Effect.flatMap((now) =>
              value.expires > now
                ? Effect.succeed(value)
                : Effect.fail(new Error("Poe API key expired. Log in with Poe again.")),
            ),
          ),
        authorize: () =>
          Effect.gen(function* () {
            const verifier = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")
            const challenge = Buffer.from(
              yield* Effect.promise(() => crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))),
            ).toString("base64url")
            const state = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")
            const callback = yield* Deferred.make<{ code: string; response: ServerResponse }, Error>()
            const { createServer } = yield* Effect.promise(() => import("node:http"))
            const { EventEmitter } = yield* Effect.promise(() => import("node:events"))
            const server = createServer((request, response) => {
              const url = new URL(request.url ?? "/", "http://127.0.0.1")
              if (request.method !== "GET" || url.pathname !== "/callback") {
                response.writeHead(404).end()
                return
              }
              const error = callbackError(url.searchParams, state)
              if (error) {
                response
                  .writeHead(400, { "Content-Type": "text/html" })
                  .end(OauthCallbackPage.error(error, { provider: "Poe" }))
                Effect.runSync(Deferred.fail(callback, new Error(error)))
                return
              }
              if (!Effect.runSync(Deferred.succeed(callback, { code: url.searchParams.get("code") ?? "", response })))
                response.writeHead(409).end("OAuth callback already received")
            })
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                server.close()
                server.closeAllConnections()
              }),
            )
            yield* Effect.tryPromise(() => EventEmitter.once(server.listen(0, "127.0.0.1"), "listening"))
            const address = server.address()
            if (!address || typeof address === "string")
              return yield* Effect.fail(new Error("Missing OAuth callback port"))
            const redirect = `http://127.0.0.1:${address.port}/callback`
            return {
              mode: "auto" as const,
              url: `${issuer}/oauth/authorize?${new URLSearchParams({
                response_type: "code",
                client_id: clientID,
                redirect_uri: redirect,
                scope: "apikey:create",
                code_challenge: challenge,
                code_challenge_method: "S256",
                state,
              }).toString()}`,
              instructions: "Complete authorization in your browser. This window will close automatically.",
              callback: Effect.gen(function* () {
                const request = yield* Deferred.await(callback)
                const respond = (error?: string) =>
                  Effect.sync(() =>
                    request.response
                      .writeHead(error ? 400 : 200, { "Content-Type": "text/html" })
                      .end(
                        error
                          ? OauthCallbackPage.error(error, { provider: "Poe" })
                          : OauthCallbackPage.success({ provider: "Poe" }),
                      ),
                  )
                return yield* exchangeCode(http, { code: request.code, redirect, verifier }).pipe(
                  Effect.tap(() => respond()),
                  Effect.tapError((error) => respond(error.message)),
                  // Bun's server.closeAllConnections() leaves an unanswered callback response pending.
                  Effect.onInterrupt(() => Effect.sync(() => request.response.destroy())),
                )
              }),
            }
          }),
      })
    })
  }),
})

function callbackError(params: URLSearchParams, state: string) {
  if (params.get("state") !== state) return "Invalid OAuth state"
  // Poe's client pins this issuer but does not require iss; its documented callbacks may omit it.
  if (params.has("iss") && params.get("iss") !== issuer) return "Invalid OAuth issuer"
  if (params.has("error")) {
    const detail = params.get("error_description") || params.get("error") || "Authorization denied"
    return detail.includes(state) ? "Poe authorization failed" : detail
  }
  return params.get("code")?.trim() ? undefined : "Missing authorization code"
}

function exchangeCode(http: HttpClient.HttpClient, input: { code: string; redirect: string; verifier: string }) {
  return Effect.gen(function* () {
    const response = yield* http
      .execute(
        HttpClientRequest.post("https://api.poe.com/token").pipe(
          HttpClientRequest.bodyUrlParams({
            grant_type: "authorization_code",
            client_id: clientID,
            code: input.code,
            redirect_uri: input.redirect,
            code_verifier: input.verifier,
          }),
        ),
      )
      .pipe(Effect.mapError(() => new Error("Poe token exchange request failed")))
    if (response.status < 200 || response.status >= 300) {
      const error = Option.getOrUndefined(decodeError(yield* response.text.pipe(Effect.orElseSucceed(() => ""))))
      const detail = error?.error_description || error?.error
      return yield* Effect.fail(
        new Error(
          detail && ![input.code, input.verifier].some((secret) => detail.includes(secret))
            ? `Poe token exchange failed: ${detail}`
            : `Poe token exchange failed (${response.status})`,
        ),
      )
    }
    const token = yield* HttpClientResponse.schemaBodyJson(Token)(response).pipe(
      Effect.mapError(() => new Error("Invalid Poe token response")),
    )
    const expires =
      token.api_key_expires_in == null ? maxExpiry : (yield* Clock.currentTimeMillis) + token.api_key_expires_in * 1000
    if (!Number.isSafeInteger(expires) || expires > maxExpiry)
      return yield* Effect.fail(new Error("Invalid Poe API key expiry"))
    return Credential.OAuth.make({ type: "oauth", methodID, access: token.api_key, refresh: "", expires })
  })
}
