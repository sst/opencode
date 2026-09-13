import type { IntegrationOAuthMethodRegistration } from "@opencode/plugin/effect/integration"
import { define } from "@opencode/plugin/effect/plugin"
import { Clock, Effect, Option, Schema } from "effect"
import { App } from "../../app.js"
import { Credential } from "../../credential.js"
import { Integration } from "../../integration.js"
import { Provider } from "../../provider.js"

const clientID = "b1a00492-073a-47ea-816f-4c329264a828"
const issuer = "https://auth.x.ai/oauth2"
const deviceGrant = "urn:ietf:params:oauth:grant-type:device_code"
const scope = "openid profile email offline_access grok-cli:access api:access"
const pollingSafetyMargin = 3000
const browserMethodID = Integration.MethodID.make("browser")
const deviceMethodID = Integration.MethodID.make("device")
const providerID = Provider.ID.make("xai")

const Token = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.optional(Schema.String),
  expires_in: Schema.optional(Schema.Number),
})
type Token = typeof Token.Type

const Device = Schema.Struct({
  device_code: Schema.String,
  user_code: Schema.String,
  verification_uri: Schema.String,
  verification_uri_complete: Schema.optional(Schema.String),
  expires_in: Schema.optional(Schema.Number),
  interval: Schema.optional(Schema.Number),
})

const DeviceError = Schema.Struct({
  error: Schema.optional(Schema.String),
  error_description: Schema.optional(Schema.String),
})
const decodeDeviceError = Schema.decodeUnknownOption(Schema.fromJsonString(DeviceError))

const device = (app: App.Info) =>
  ({
    integrationID: Integration.ID.make("xai"),
    method: {
      id: deviceMethodID,
      type: "oauth",
      label: "SuperGrok Subscription",
    },
    authorize: () =>
      request(
        `${issuer}/device/code`,
        {
          method: "POST",
          headers: headers(app),
          body: new URLSearchParams({ client_id: clientID, scope, referrer: "opencode" }).toString(),
        },
        Device,
      ).pipe(
        Effect.flatMap((value) =>
          Clock.currentTimeMillis.pipe(
            Effect.map((created) => {
              const lifetime = positiveSeconds(value.expires_in, 0)
              return {
                mode: "auto" as const,
                url: value.verification_uri_complete ?? value.verification_uri,
                instructions: `Open ${value.verification_uri} on any device and enter code: ${value.user_code}`,
                ...(lifetime ? { expiresAt: created + lifetime * 1000 } : {}),
                callback: poll(value, app).pipe(Effect.flatMap((tokens) => credential(deviceMethodID, tokens))),
              }
            }),
          ),
        ),
      ),
    refresh: (value) => refresh(deviceMethodID, Credential.OAuth.make({ ...value, methodID: deviceMethodID }), app),
  }) satisfies IntegrationOAuthMethodRegistration

export const XAIPlugin = define({
  id: "opencode.provider.xai",
  effect: Effect.fn(function* (ctx) {
    const credentials = yield* Credential.Service
    yield* Effect.forEach(
      yield* credentials.list(Integration.ID.make("xai")),
      (credential) => {
        if (credential.value.type !== "oauth" || credential.value.methodID !== browserMethodID) return Effect.void
        return credentials.update(credential.id, {
          value: Credential.OAuth.make({ ...credential.value, methodID: deviceMethodID }),
        })
      },
      { discard: true },
    )

    yield* ctx.integration.transform((editor) => {
      editor.update("xai", (integration) => {
        integration.name = "xAI"
      })
      editor.method.update(device(ctx.app))
      editor.method.update({ integrationID: "xai", method: { type: "key", label: "Manually enter API Key" } })
    })
    yield* ctx.catalog.transform((catalog) => {
      const provider = catalog.provider.get(providerID)
      if (!provider) return
      for (const model of provider.models.values()) {
        catalog.model.update(providerID, model.id, (draft) => {
          draft.capabilities.responsesWebsockets = true
          draft.websocket = true
        })
      }
    })
  }),
})

function refresh(methodID: Integration.MethodID, value: Credential.OAuth, app: App.Info) {
  return request(
    `${issuer}/token`,
    {
      method: "POST",
      headers: headers(app),
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: value.refresh,
        client_id: clientID,
      }).toString(),
    },
    Token,
  ).pipe(Effect.flatMap((tokens) => credential(methodID, tokens, value.refresh, value.metadata)))
}

function poll(device: typeof Device.Type, app: App.Info): Effect.Effect<Token, unknown> {
  return Effect.gen(function* () {
    const started = yield* Clock.currentTimeMillis
    const expires = started + positiveSeconds(device.expires_in, 300) * 1000
    const loop = (interval: number): Effect.Effect<Token, unknown> =>
      Effect.gen(function* () {
        if ((yield* Clock.currentTimeMillis) >= expires) {
          return yield* Effect.fail(new Error("xAI device authorization timed out"))
        }
        const response = yield* send(`${issuer}/token`, {
          method: "POST",
          headers: headers(app),
          body: new URLSearchParams({
            grant_type: deviceGrant,
            client_id: clientID,
            device_code: device.device_code,
          }).toString(),
        })
        if (response.ok) return yield* decode(response, Token)
        const error = yield* Effect.promise(() => response.text()).pipe(
          Effect.map((body) => Option.getOrUndefined(decodeDeviceError(body))),
          Effect.orElseSucceed(() => undefined),
        )
        if (error?.error === "authorization_pending") {
          return yield* Effect.sleep(interval + pollingSafetyMargin).pipe(Effect.andThen(loop(interval)))
        }
        if (error?.error === "slow_down") {
          const next = interval + 5000
          return yield* Effect.sleep(next + pollingSafetyMargin).pipe(Effect.andThen(loop(next)))
        }
        if (error?.error === "access_denied" || error?.error === "authorization_denied") {
          return yield* Effect.fail(new Error("xAI device authorization was denied"))
        }
        if (error?.error === "expired_token") {
          return yield* Effect.fail(new Error("xAI device code expired - please re-run login"))
        }
        const detail = error?.error_description ?? error?.error
        return yield* Effect.fail(
          new Error(`xAI device token exchange failed (${response.status})${detail ? `: ${detail}` : ""}`),
        )
      })
    return yield* loop(Math.max(positiveSeconds(device.interval, 5) * 1000, 1000))
  })
}

function request<S extends Schema.Decoder<unknown>>(url: string, init: RequestInit, schema: S) {
  return send(url, init).pipe(
    Effect.flatMap((response) => {
      if (response.ok) return decode(response, schema)
      return Effect.promise(() => response.text()).pipe(
        Effect.flatMap((detail) =>
          Effect.fail(new Error(`xAI request failed (${response.status})${detail ? `: ${detail}` : ""}`)),
        ),
      )
    }),
  )
}

function send(url: string, init: RequestInit) {
  return Effect.tryPromise({
    try: (signal) => fetch(url, { ...init, signal }),
    catch: (cause) => cause,
  })
}

function decode<S extends Schema.Decoder<unknown>>(response: Response, schema: S) {
  return Effect.promise(() => response.json()).pipe(Effect.map(Schema.decodeUnknownSync(schema)))
}

function credential(
  methodID: Integration.MethodID,
  tokens: Token,
  currentRefresh?: string,
  metadata?: Readonly<Record<string, unknown>>,
) {
  const refresh = tokens.refresh_token ?? currentRefresh
  if (!refresh) return Effect.fail(new Error("xAI token response is missing refresh_token"))
  return Effect.succeed(
    Credential.OAuth.make({
      type: "oauth",
      methodID,
      refresh,
      access: tokens.access_token,
      expires: tokenExpiration(tokens),
      metadata,
    }),
  )
}

function tokenExpiration(tokens: Token) {
  if (tokens.expires_in) return Date.now() + positiveSeconds(tokens.expires_in, 3600) * 1000
  const payload = tokens.access_token.split(".")[1]
  if (!payload) return Date.now() + 3600 * 1000
  const claims = Schema.decodeUnknownOption(
    Schema.fromJsonString(Schema.Struct({ exp: Schema.optional(Schema.Number) })),
  )(Buffer.from(payload, "base64url").toString())
  const expiration = Option.getOrUndefined(claims)?.exp
  return expiration ? expiration * 1000 : Date.now() + 3600 * 1000
}

function headers(app: App.Info) {
  return {
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
    "User-Agent": App.useragent(app),
  }
}

function positiveSeconds(value: unknown, fallback: number) {
  const seconds = Number(value)
  return Number.isFinite(seconds) && seconds > 0 ? seconds : fallback
}
