import { describe, expect } from "bun:test"
import { Catalog } from "@opencode/core/catalog"
import { Config } from "@opencode/core/config"
import { Credential } from "@opencode/core/credential"
import { Integration } from "@opencode/core/integration"
import { ModelResolver } from "@opencode/core/model-resolver"
import { Model } from "@opencode/core/model"
import { Plugin } from "@opencode/core/plugin"
import { PluginHost } from "@opencode/core/plugin/host"
import { OpencodePlugin } from "@opencode/core/plugin/provider/opencode"
import { Provider } from "@opencode/core/provider"
import { ProviderPolicy } from "@opencode/core/provider-policy"
import { Document, Info } from "@opencode/schema/config"
import { Effect, Schema } from "effect"
import { TestClock } from "effect/testing"
import { drain } from "../lib/clock"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const it = testEffect(PluginTestLayer)
const rule = (effect: "allow" | "deny", resource: string) => ({ action: "provider.use" as const, effect, resource })
const document = (policies: ReturnType<typeof rule>[], workspaceID = "org_policy", revision = 1) => ({
  providers: {},
  experimental: { policies },
  managedPolicy: { schemaVersion: 1, workspaceID, revision },
})
const activate = Effect.gen(function* () {
  const plugin = yield* Plugin.Service
  const host = yield* PluginHost.make(plugin)
  yield* OpencodePlugin.effect(host)
})
const refresh = TestClock.adjust("10 minutes").pipe(Effect.andThen(drain))

describe("Managed provider policy", () => {
  it.effect("accepts revision-zero defaults without requiring policy publication", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => Bun.serve({ port: 0, fetch: () => Response.json(document([], "org_policy", 0)) })),
      (server) =>
        Effect.gen(function* () {
          const credentials = yield* Credential.Service
          const catalog = yield* Catalog.Service
          const policies = yield* ProviderPolicy.Service
          yield* catalog.transform((editor) => editor.provider.update(Provider.ID.openai, () => {}))
          yield* credentials.create({
            integrationID: Integration.ID.make("opencode"),
            value: Credential.Key.make({
              type: "key",
              key: "test-key",
              metadata: { server: server.url.origin, orgID: "org_policy" },
            }),
          })
          yield* activate
          expect(yield* policies.read()).toMatchObject({ status: "ready", revision: 0, workspaceID: "org_policy" })
          expect(yield* catalog.provider.get(Provider.ID.openai)).toBeDefined()
          yield* policies.assert("openai")
        }),
      (server) => Effect.promise(() => server.stop(true)),
    ),
  )

  it.effect(
    "composes organization rules last, filters every catalog view, retains only valid same-identity snapshots, and clears explicitly",
    () =>
      Effect.acquireUseRelease(
        Effect.sync(() => {
          const state = { status: 200, body: document([rule("deny", "*"), rule("allow", "remote")]) as unknown }
          const server = Bun.serve({ port: 0, fetch: () => Response.json(state.body, { status: state.status }) })
          return { state, server }
        }),
        ({ state, server }) =>
          Effect.gen(function* () {
            const catalog = yield* Catalog.Service
            const credentials = yield* Credential.Service
            const policies = yield* ProviderPolicy.Service
            const config = yield* Config.Service
            const entries = yield* config.entries()
            entries.push(
              new Document({
                type: "document",
                info: Schema.decodeUnknownSync(Info)({
                  experimental: { policies: [rule("deny", "remote"), rule("allow", "openai")] },
                }),
              }),
            )
            yield* catalog.transform((editor) => {
              for (const id of ["openai", "remote"]) {
                editor.provider.update(Provider.ID.make(id), (provider) => {
                  provider.activation = "enabled"
                })
                editor.model.update(Provider.ID.make(id), Model.ID.make("model"), () => {})
              }
            })
            const previouslySelected = yield* catalog.model.get(Provider.ID.openai, Model.ID.make("model"))
            if (!previouslySelected) return yield* Effect.die("Expected local model")
            const credential = yield* credentials.create({
              integrationID: Integration.ID.make("opencode"),
              value: Credential.Key.make({
                type: "key",
                key: "test-key",
                metadata: { server: server.url.origin, orgID: "org_policy" },
              }),
            })
            expect((yield* policies.read()).status).toBe("unavailable")
            expect(yield* catalog.provider.all()).toEqual([])
            yield* activate
            expect((yield* policies.read()).status).toBe("ready")
            expect(yield* catalog.provider.get(Provider.ID.make("remote"))).toBeDefined()
            expect(yield* catalog.provider.get(Provider.ID.openai)).toBeUndefined()
            expect((yield* catalog.model.all()).map((model) => model.providerID)).toEqual([Provider.ID.make("remote")])
            expect(yield* catalog.model.get(Provider.ID.openai, Model.ID.make("model"))).toBeUndefined()
            expect(yield* catalog.model.small(Provider.ID.openai)).toBeUndefined()
            yield* catalog.transform((editor) =>
              editor.provider.update(Provider.ID.openai, (provider) => {
                provider.activation = "enabled"
              }),
            )
            expect(yield* catalog.provider.get(Provider.ID.openai)).toBeUndefined()
            expect(yield* policies.assert("openai").pipe(Effect.flip)).toBeInstanceOf(ProviderPolicy.Denied)
            const loadError = yield* Effect.gen(function* () {
              const resolver = yield* ModelResolver.Service
              return yield* resolver.resolveModel(previouslySelected).pipe(Effect.flip)
            }).pipe(Effect.provide(ModelResolver.layer))
            expect(loadError).toBeInstanceOf(ProviderPolicy.Denied)
            state.status = 503
            yield* refresh
            expect((yield* policies.read()).status).toBe("stale")
            expect(yield* catalog.provider.get(Provider.ID.make("remote"))).toBeDefined()
            expect(yield* catalog.provider.get(Provider.ID.openai)).toBeUndefined()
            state.status = 200
            state.body = { providers: {} }
            yield* refresh
            expect((yield* policies.read()).status).toBe("unavailable")
            expect(yield* catalog.model.available()).toEqual([])
            expect(yield* policies.assert("remote").pipe(Effect.flip)).toBeInstanceOf(ProviderPolicy.Unavailable)
            state.body = document([], "org_policy", 2)
            yield* refresh
            expect((yield* policies.read()).revision).toBe(2)
            expect(yield* catalog.provider.get(Provider.ID.openai)).toBeDefined()
            expect(yield* catalog.provider.get(Provider.ID.make("remote"))).toBeUndefined()
            state.status = 503
            yield* credentials.update(credential.id, {
              value: Credential.Key.make({
                type: "key",
                key: "other-key",
                metadata: { server: server.url.origin, orgID: "org_other" },
              }),
            })
            yield* drain
            expect((yield* policies.read()).status).toBe("unavailable")
            state.status = 200
            yield* refresh
            expect((yield* policies.read()).status).toBe("unavailable")
            state.body = document([rule("deny", "*")], "org_other", 0)
            yield* refresh
            expect((yield* policies.read()).workspaceID).toBe("org_other")
            expect(yield* catalog.provider.all()).toEqual([])
            yield* credentials.remove(credential.id)
            yield* drain
            expect((yield* policies.read()).status).toBe("disconnected")
            expect(yield* catalog.provider.get(Provider.ID.openai)).toBeDefined()
          }),
        ({ server }) => Effect.promise(() => server.stop(true)),
      ),
  )

  for (const scenario of [
    { name: "missing descriptor", body: { providers: {}, experimental: { policies: [] } }, status: 200 },
    {
      name: "unsupported version",
      body: { ...document([]), managedPolicy: { schemaVersion: 2, workspaceID: "org_policy", revision: 1 } },
      status: 200,
    },
    { name: "unknown conditions", body: document([{ ...rule("allow", "*"), ...{ condition: {} } }]), status: 200 },
    { name: "empty resource", body: document([rule("allow", "")]), status: 200 },
    { name: "absent policies", body: { ...document([]), experimental: {} }, status: 200 },
    { name: "revoked authorization", body: document([]), status: 403 },
    { name: "old Console", body: {}, status: 404 },
    { name: "cold outage", body: {}, status: 503 },
  ]) {
    it.effect(`fails closed on ${scenario.name}`, () =>
      Effect.acquireUseRelease(
        Effect.sync(() =>
          Bun.serve({ port: 0, fetch: () => Response.json(scenario.body, { status: scenario.status }) }),
        ),
        (server) =>
          Effect.gen(function* () {
            const credentials = yield* Credential.Service
            const catalog = yield* Catalog.Service
            const policies = yield* ProviderPolicy.Service
            yield* catalog.transform((editor) => editor.provider.update(Provider.ID.openai, () => {}))
            yield* credentials.create({
              integrationID: Integration.ID.make("opencode"),
              value: Credential.Key.make({
                type: "key",
                key: "test-key",
                metadata: { server: server.url.origin, orgID: "org_policy" },
              }),
            })
            yield* activate
            expect((yield* policies.read()).status).toBe("unavailable")
            expect(yield* catalog.provider.all()).toEqual([])
          }),
        (server) => Effect.promise(() => server.stop(true)),
      ),
    )
  }
})
