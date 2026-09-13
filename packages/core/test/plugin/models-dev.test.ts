import path from "path"
import { describe, expect } from "bun:test"
import { Money } from "@opencode/schema/money"
import { Context, Effect, Exit, Layer, Scope } from "effect"
import { TestClock } from "effect/testing"
import { Catalog } from "@opencode/core/catalog"
import { Integration } from "@opencode/core/integration"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Bus } from "@opencode/core/bus"
import { Location } from "@opencode/core/location"
import { Model } from "@opencode/core/model"
import { ModelsDev } from "@opencode/core/models-dev"
import { ModelsDevPlugin } from "@opencode/core/plugin/models-dev"
import { Plugin } from "@opencode/core/plugin"
import { PluginHost } from "@opencode/core/plugin/host"
import { ProviderPlugins } from "@opencode/core/plugin/provider"
import { Provider } from "@opencode/core/provider"
import { AbsolutePath } from "@opencode/core/schema"
import { withEnv } from "../fixture/env"
import { location } from "../fixture/location"
import { testEffect } from "../lib/effect"
import { catalogHost, host, integrationHost } from "./host"
import { PluginTestLayer } from "./fixture"

const locationLayer = Layer.succeed(
  Location.Service,
  Location.Service.of(location({ directory: AbsolutePath.make(import.meta.dir) })),
)
const layer = AppNodeBuilder.build(LayerNode.group([Catalog.node, Integration.node, Bus.node]), [
  Location.node.replace(locationLayer),
])
const it = testEffect(layer)
const real = testEffect(PluginTestLayer)
const isolated = testEffect(Layer.empty)
const models = (file: string) =>
  AppNodeBuilder.build(ModelsDev.node, [ModelsDev.node.replace(ModelsDev.configured({ file, fetch: false }))])

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected value")
  return value
}

// One complete Location graph behind the production plugin host. Two of these stand in for
// two Locations that share a single models.dev snapshot instance.
const owner = Effect.gen(function* () {
  const context = yield* Layer.build(PluginTestLayer)
  const host = yield* PluginHost.make(Context.get(context, Plugin.Service)).pipe(Effect.provideContext(context))
  return {
    context,
    host,
    bus: Context.get(context, Bus.Service),
    catalog: Context.get(context, Catalog.Service),
    integration: Context.get(context, Integration.Service),
  }
})

// Every nested overlay shape the normalized snapshot can carry, so in-place mutation of any
// existing nested value is observable on the source object.
const richSnapshot = (name = "Acme") => {
  const providerID = Provider.ID.make("acme")
  const modelID = Model.ID.make("gpt-5.4")
  const snapshot = [
    {
      info: {
        id: providerID,
        name,
        activation: "auto",
        package: Provider.aisdk("@ai-sdk/openai-compatible"),
        settings: { baseURL: "https://api.acme.test/v1", thinking: { type: "adaptive", display: "summarized" } },
        headers: { "x-acme": "provider" },
        body: { service_tier: "default", tags: ["stable"] },
      },
      environment: ["ACME_API_KEY", "ACME_HOST"],
      models: [
        {
          id: modelID,
          modelID,
          providerID,
          name: "GPT-5.4",
          family: Model.Family.make("gpt"),
          settings: { baseURL: "https://models.acme.test/v1", reasoning: { effort: "low" } },
          headers: { "x-mode": "fast" },
          body: { service_tier: "priority", options: { top_k: 1 }, stop: ["<end>"] },
          capabilities: { tools: true, input: ["text"], output: ["text"] },
          variants: [
            {
              id: Model.VariantID.make("low"),
              settings: { thinking: { type: "adaptive", display: "summarized" }, effort: "low" },
              body: { max_tokens: 1024 },
            },
          ],
          time: { released: Date.parse("2026-01-01") },
          cost: [
            {
              input: Money.USDPerMillionTokens.make(2.5),
              output: Money.USDPerMillionTokens.make(15),
              cache: { read: Money.USDPerMillionTokens.make(0.25), write: Money.USDPerMillionTokens.zero },
            },
            {
              tier: { type: "context", size: 200_000 },
              input: Money.USDPerMillionTokens.make(5),
              output: Money.USDPerMillionTokens.make(22.5),
              cache: { read: Money.USDPerMillionTokens.make(0.5), write: Money.USDPerMillionTokens.zero },
            },
          ],
          status: "active",
          enabled: true,
          limit: { context: 1_050_000, input: 922_000, output: 128_000 },
        },
      ],
    },
  ] satisfies readonly ModelsDev.Snapshot[]
  return { providerID, modelID, snapshot }
}

describe("ModelsDevPlugin", () => {
  isolated.effect("shares one snapshot between Locations while each catalog mutates only its own copies", () =>
    Effect.gen(function* () {
      const { providerID, modelID, snapshot } = richSnapshot()
      const pristine = JSON.stringify(snapshot)
      const source = ModelsDev.Service.of({ get: () => Effect.succeed(snapshot), refresh: () => Effect.void })
      const first = yield* owner
      const second = yield* owner
      for (const each of [first, second])
        yield* ModelsDevPlugin.effect(each.host).pipe(
          Effect.provideService(ModelsDev.Service, source),
          Effect.provideContext(each.context),
        )

      // The stored environment method must own its names array; the source array is shared.
      let names: readonly string[] | undefined
      yield* first.integration.transform((draft) => {
        names = draft.method
          .list(Integration.ID.make(providerID))
          .flatMap((method) => (method.type === "env" ? [method.names] : []))[0]
      })
      expect(names).toEqual(snapshot[0].environment)
      expect(names).not.toBe(snapshot[0].environment)

      // Catalog-owned provider records are copies, not the source's nested objects.
      const stored = required(yield* first.catalog.provider.get(providerID))
      expect(stored.settings).toEqual(snapshot[0].info.settings)
      expect(stored.settings).not.toBe(snapshot[0].info.settings)
      expect(stored.headers).not.toBe(snapshot[0].info.headers)
      expect(stored.body).not.toBe(snapshot[0].info.body)

      // A later plugin in the first Location mutates existing nested values in place through the
      // production host, the way the Bedrock, Azure, and config provider plugins do.
      const scope = yield* Scope.make()
      yield* first.host.catalog
        .transform((catalog) => {
          catalog.provider.update(providerID, (provider) => {
            required(provider.settings).baseURL = "https://override.acme.test/v1"
            required(provider.settings).thinking.type = "disabled"
            required(provider.headers)["x-acme"] = "override"
            required(provider.body).service_tier = "priority"
            required(provider.body).tags.push("override")
          })
          catalog.model.update(providerID, modelID, (model) => {
            required(model.settings).reasoning.effort = "high"
            required(model.headers)["x-mode"] = "slow"
            required(model.body).options.top_k = 7
            required(model.body).stop.push("<stop>")
            const variant = required(model.variants[0])
            required(variant.settings).thinking.type = "disabled"
            required(variant.body).max_tokens = 4096
            model.capabilities.input.push("image")
            required(model.cost[0]).cache.read = Money.USDPerMillionTokens.make(9)
            required(required(model.cost[1]).tier).size = 1
            required(model.cost[1]).input = Money.USDPerMillionTokens.make(42)
            model.limit.context = 1
            model.time.released = 5
          })
        })
        .pipe(Scope.provide(scope))

      const mutatedProvider = required(yield* first.catalog.provider.get(providerID))
      const mutated = required(yield* first.catalog.model.get(providerID, modelID))
      expect(mutatedProvider.settings).toEqual({
        baseURL: "https://override.acme.test/v1",
        thinking: { type: "disabled", display: "summarized" },
      })
      expect(mutatedProvider.headers).toEqual({ "x-acme": "override" })
      expect(mutatedProvider.body).toEqual({ service_tier: "priority", tags: ["stable", "override"] })
      expect(mutated.settings).toEqual({
        baseURL: "https://models.acme.test/v1",
        thinking: { type: "disabled", display: "summarized" },
        reasoning: { effort: "high" },
      })
      expect(mutated.headers).toEqual({ "x-acme": "override", "x-mode": "slow" })
      expect(mutated.body).toEqual({
        service_tier: "priority",
        tags: ["stable", "override"],
        options: { top_k: 7 },
        stop: ["<end>", "<stop>"],
      })
      expect(mutated.variants).toEqual([
        {
          id: Model.VariantID.make("low"),
          settings: { thinking: { type: "disabled", display: "summarized" }, effort: "low" },
          body: { max_tokens: 4096 },
        },
      ])
      expect(mutated.capabilities.input).toEqual(["text", "image"])
      expect(mutated.cost[0]?.cache.read).toBe(Money.USDPerMillionTokens.make(9))
      expect(mutated.cost[1]).toMatchObject({ tier: { type: "context", size: 1 }, input: 42 })
      expect(mutated.limit.context).toBe(1)
      expect(mutated.time.released).toBe(5)

      // The sibling Location and the shared source are untouched.
      const sibling = required(yield* second.catalog.model.get(providerID, modelID))
      expect(sibling.settings).toEqual({
        baseURL: "https://models.acme.test/v1",
        thinking: { type: "adaptive", display: "summarized" },
        reasoning: { effort: "low" },
      })
      expect(sibling.headers).toEqual({ "x-acme": "provider", "x-mode": "fast" })
      expect(sibling.body).toEqual({
        service_tier: "priority",
        tags: ["stable"],
        options: { top_k: 1 },
        stop: ["<end>"],
      })
      expect(sibling.variants).toEqual(snapshot[0].models[0].variants)
      expect(sibling.capabilities.input).toEqual(["text"])
      expect(sibling.cost).toEqual(snapshot[0].models[0].cost)
      expect(sibling.limit).toEqual(snapshot[0].models[0].limit)
      expect(sibling.time).toEqual(snapshot[0].models[0].time)
      expect(required(yield* second.catalog.provider.get(providerID)).settings).toEqual(snapshot[0].info.settings)
      expect(JSON.stringify(snapshot)).toBe(pristine)

      // Removing the mutating transform rebuilds the first catalog from the shared source.
      yield* Scope.close(scope, Exit.void)
      expect(yield* first.catalog.model.get(providerID, modelID)).toEqual(sibling)
      expect(required(yield* first.catalog.provider.get(providerID)).settings).toEqual(snapshot[0].info.settings)
      expect(JSON.stringify(snapshot)).toBe(pristine)
    }),
  )

  isolated.effect("replaces its snapshot reference on refresh without touching the sibling Location", () =>
    Effect.gen(function* () {
      const initial = richSnapshot("Acme")
      const refreshed = richSnapshot("Acme Refreshed")
      const pristine = JSON.stringify(initial.snapshot)
      const current = { snapshot: initial.snapshot }
      const source = ModelsDev.Service.of({
        get: () => Effect.sync(() => current.snapshot),
        refresh: () => Effect.void,
      })
      const first = yield* owner
      const second = yield* owner
      for (const each of [first, second])
        yield* ModelsDevPlugin.effect(each.host).pipe(
          Effect.provideService(ModelsDev.Service, source),
          Effect.provideContext(each.context),
        )
      expect(required(yield* first.catalog.provider.get(initial.providerID)).name).toBe("Acme")

      current.snapshot = refreshed.snapshot
      yield* first.bus.publish(ModelsDev.Event.Refreshed, {})
      // Integration and catalog reloads are debounced sequentially.
      yield* TestClock.adjust("500 millis")
      yield* TestClock.adjust("500 millis")
      yield* TestClock.adjust("500 millis")

      expect(required(yield* first.catalog.provider.get(initial.providerID)).name).toBe("Acme Refreshed")
      expect(required(yield* second.catalog.provider.get(initial.providerID)).name).toBe("Acme")
      expect(JSON.stringify(initial.snapshot)).toBe(pristine)
      expect(JSON.stringify(refreshed.snapshot)).toBe(JSON.stringify(richSnapshot("Acme Refreshed").snapshot))
    }),
  )

  real.effect("keeps the retained model seed unchanged across catalog replay", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const plugins = yield* Plugin.Service
      const providerID = Provider.ID.make("acme")
      const modelID = Model.ID.make("model")
      const modelsDev = ModelsDev.Service.of({
        get: () =>
          Effect.succeed([
            {
              info: {
                id: providerID,
                name: "Acme",
                activation: "auto",
                package: Provider.aisdk("@ai-sdk/openai-compatible"),
              },
              environment: [],
              models: [
                {
                  id: modelID,
                  modelID,
                  providerID,
                  name: "Model",
                  capabilities: { tools: true, input: [], output: [] },
                  variants: [],
                  time: { released: Date.parse("2026-01-01") },
                  cost: [],
                  status: "active",
                  enabled: true,
                  limit: { context: 128_000, output: 32_000 },
                },
              ],
            },
          ] satisfies readonly ModelsDev.Snapshot[]),
        refresh: () => Effect.void,
      })
      const pluginHost = yield* PluginHost.make(plugins)
      yield* ModelsDevPlugin.effect(pluginHost).pipe(Effect.provideService(ModelsDev.Service, modelsDev))

      const scope = yield* Scope.make()
      yield* catalog
        .transform((editor) =>
          editor.model.update(providerID, modelID, (model) => {
            model.variants ??= []
            model.variants.push({ id: Model.VariantID.make("configured") })
          }),
        )
        .pipe(Scope.provide(scope))
      expect((yield* catalog.model.get(providerID, modelID))?.variants).toEqual([
        { id: Model.VariantID.make("configured") },
      ])

      yield* Scope.close(scope, Exit.void)
      expect((yield* catalog.model.get(providerID, modelID))?.variants).toEqual([])
    }),
  )

  it.effect("keeps the shared models.dev snapshot pristine while catalog transforms mutate records in place", () =>
    Effect.gen(function* () {
      const integrations = yield* Integration.Service
      const catalog = yield* Catalog.Service
      const providerID = Provider.ID.make("acme")
      const modelID = Model.ID.make("gpt-5.4")
      const snapshot = [
        {
          info: {
            id: providerID,
            name: "Acme",
            activation: "auto",
            package: Provider.aisdk("@ai-sdk/openai-compatible"),
            settings: { baseURL: "https://api.acme.test/v1" },
            headers: { "x-acme": "provider" },
          },
          environment: ["ACME_API_KEY"],
          models: [
            {
              id: modelID,
              modelID,
              providerID,
              name: "GPT-5.4",
              settings: { baseURL: "https://models.acme.test/v1" },
              capabilities: { tools: true, input: ["text"], output: ["text"] },
              variants: [],
              time: { released: Date.parse("2026-01-01") },
              cost: [],
              status: "active",
              enabled: true,
              limit: { context: 1_050_000, output: 128_000 },
            },
          ],
        },
      ] satisfies readonly ModelsDev.Snapshot[]
      const pristine = JSON.stringify(snapshot)
      // The plugin receives the same snapshot instance every Location shares.
      yield* ModelsDevPlugin.effect(
        host({
          catalog: catalogHost(catalog),
          integration: integrationHost(integrations),
        }),
      ).pipe(
        Effect.provideService(
          ModelsDev.Service,
          ModelsDev.Service.of({ get: () => Effect.succeed(snapshot), refresh: () => Effect.void }),
        ),
      )

      // Later plugins mutate nested provider and model records in place, as the Bedrock provider does.
      yield* catalog.transform((draft) => {
        draft.provider.update(providerID, (provider) => {
          if (provider.settings) provider.settings.baseURL = "https://override.acme.test/v1"
          if (provider.headers) provider.headers["x-acme"] = "override"
        })
        draft.model.update(providerID, modelID, (model) => {
          if (model.settings) model.settings.baseURL = "https://override.models.acme.test/v1"
          model.variants.push({ id: Model.VariantID.make("configured") })
          model.capabilities.input.push("image")
        })
      })

      const provider = yield* catalog.provider.get(providerID)
      const model = yield* catalog.model.get(providerID, modelID)
      expect(provider?.settings?.baseURL).toBe("https://override.acme.test/v1")
      expect(provider?.headers).toEqual({ "x-acme": "override" })
      expect(model?.settings?.baseURL).toBe("https://override.models.acme.test/v1")
      expect(model?.variants).toEqual([{ id: Model.VariantID.make("configured") }])
      expect(model?.capabilities.input).toEqual(["text", "image"])
      expect(JSON.stringify(snapshot)).toBe(pristine)
    }),
  )

  it.effect("projects normalized models.dev snapshots into the catalog", () =>
    Effect.gen(function* () {
      const integrations = yield* Integration.Service
      const catalog = yield* Catalog.Service
      const providerID = Provider.ID.make("acme")
      const modelID = Model.ID.make("gpt-5.4")
      const models = ModelsDev.Service.of({
        get: () =>
          Effect.succeed([
            {
              info: {
                id: providerID,
                name: "Acme",
                activation: "auto",
                package: Provider.aisdk("@ai-sdk/openai-compatible"),
                settings: { baseURL: "https://api.acme.test/v1" },
              },
              environment: [],
              models: [
                {
                  id: modelID,
                  modelID,
                  providerID,
                  name: "GPT-5.4",
                  family: Model.Family.make("gpt"),
                  capabilities: { tools: true, input: [], output: [] },
                  variants: [],
                  time: { released: Date.parse("2026-01-01") },
                  cost: [
                    {
                      input: Money.USDPerMillionTokens.make(2.5),
                      output: Money.USDPerMillionTokens.make(15),
                      cache: {
                        read: Money.USDPerMillionTokens.zero,
                        write: Money.USDPerMillionTokens.zero,
                      },
                    },
                    {
                      tier: { type: "context", size: 272_000 },
                      input: Money.USDPerMillionTokens.make(3),
                      output: Money.USDPerMillionTokens.make(18),
                      cache: {
                        read: Money.USDPerMillionTokens.make(0.25),
                        write: Money.USDPerMillionTokens.zero,
                      },
                    },
                    {
                      tier: { type: "context", size: 200_000 },
                      input: Money.USDPerMillionTokens.make(5),
                      output: Money.USDPerMillionTokens.make(22.5),
                      cache: {
                        read: Money.USDPerMillionTokens.make(0.5),
                        write: Money.USDPerMillionTokens.zero,
                      },
                    },
                  ],
                  status: "active",
                  enabled: true,
                  limit: { context: 1_050_000, input: 922_000, output: 128_000 },
                },
                {
                  id: Model.ID.make("gpt-5.4-fast"),
                  modelID,
                  providerID,
                  name: "GPT-5.4 Fast",
                  family: Model.Family.make("gpt"),
                  package: Provider.aisdk("@ai-sdk/openai-compatible"),
                  settings: { baseURL: "https://api.acme.test/v1" },
                  headers: { "x-mode": "fast" },
                  body: { service_tier: "priority" },
                  capabilities: { tools: true, input: [], output: [] },
                  variants: [],
                  time: { released: Date.parse("2026-01-01") },
                  cost: [
                    {
                      input: Money.USDPerMillionTokens.make(5),
                      output: Money.USDPerMillionTokens.make(30),
                      cache: {
                        read: Money.USDPerMillionTokens.make(0.5),
                        write: Money.USDPerMillionTokens.zero,
                      },
                    },
                    {
                      tier: { type: "context", size: 272_000 },
                      input: Money.USDPerMillionTokens.make(3),
                      output: Money.USDPerMillionTokens.make(18),
                      cache: {
                        read: Money.USDPerMillionTokens.make(0.25),
                        write: Money.USDPerMillionTokens.zero,
                      },
                    },
                    {
                      tier: { type: "context", size: 200_000 },
                      input: Money.USDPerMillionTokens.make(5),
                      output: Money.USDPerMillionTokens.make(22.5),
                      cache: {
                        read: Money.USDPerMillionTokens.make(0.5),
                        write: Money.USDPerMillionTokens.zero,
                      },
                    },
                  ],
                  status: "active",
                  enabled: true,
                  limit: { context: 1_050_000, input: 922_000, output: 128_000 },
                },
              ],
            },
          ] satisfies readonly ModelsDev.Snapshot[]),
        refresh: () => Effect.void,
      })

      yield* ModelsDevPlugin.effect(
        host({
          catalog: catalogHost(catalog),
          integration: integrationHost(integrations),
        }),
      ).pipe(Effect.provideService(ModelsDev.Service, models))

      const base = yield* catalog.model.get(providerID, Model.ID.make("gpt-5.4"))
      const fast = yield* catalog.model.get(providerID, Model.ID.make("gpt-5.4-fast"))

      expect(base?.variants).toEqual([])
      expect(base?.body).toBeUndefined()
      expect(fast).toMatchObject({
        id: "gpt-5.4-fast",
        modelID: "gpt-5.4",
        providerID: "acme",
        name: "GPT-5.4 Fast",
        package: Provider.aisdk("@ai-sdk/openai-compatible"),
        settings: { baseURL: "https://api.acme.test/v1" },
        headers: { "x-mode": "fast" },
        body: { service_tier: "priority" },
        variants: [],
      })
      expect(fast?.cost).toEqual([
        {
          input: Money.USDPerMillionTokens.make(5),
          output: Money.USDPerMillionTokens.make(30),
          cache: {
            read: Money.USDPerMillionTokens.make(0.5),
            write: Money.USDPerMillionTokens.zero,
          },
        },
        {
          tier: { type: "context", size: 272_000 },
          input: Money.USDPerMillionTokens.make(3),
          output: Money.USDPerMillionTokens.make(18),
          cache: {
            read: Money.USDPerMillionTokens.make(0.25),
            write: Money.USDPerMillionTokens.zero,
          },
        },
        {
          tier: { type: "context", size: 200_000 },
          input: Money.USDPerMillionTokens.make(5),
          output: Money.USDPerMillionTokens.make(22.5),
          cache: {
            read: Money.USDPerMillionTokens.make(0.5),
            write: Money.USDPerMillionTokens.zero,
          },
        },
      ])
    }),
  )

  it.effect("omits deprecated models from the catalog", () =>
    Effect.gen(function* () {
      const integrations = yield* Integration.Service
      const catalog = yield* Catalog.Service
      const providerID = Provider.ID.make("acme")
      const activeID = Model.ID.make("current")
      const deprecatedID = Model.ID.make("legacy")
      const model = {
        modelID: activeID,
        providerID,
        name: "Current",
        capabilities: { tools: true, input: [], output: [] },
        variants: [],
        time: { released: Date.parse("2026-01-01") },
        cost: [],
        status: "active",
        enabled: true,
        limit: { context: 128_000, output: 32_000 },
      } satisfies Omit<Model.Info, "id">
      const snapshots = [
        {
          info: {
            id: providerID,
            name: "Acme",
            activation: "auto",
            package: Provider.aisdk("@ai-sdk/openai-compatible"),
          },
          environment: [],
          models: [
            { id: activeID, ...model },
            {
              id: deprecatedID,
              ...model,
              modelID: deprecatedID,
              name: "Legacy",
              status: "deprecated" as const,
            },
          ],
        },
      ] satisfies readonly ModelsDev.Snapshot[]

      yield* ModelsDevPlugin.effect(
        host({
          catalog: catalogHost(catalog),
          integration: integrationHost(integrations),
        }),
      ).pipe(
        Effect.provideService(
          ModelsDev.Service,
          ModelsDev.Service.of({
            get: () => Effect.succeed(snapshots),
            refresh: () => Effect.void,
          }),
        ),
      )

      expect(yield* catalog.model.get(providerID, activeID)).toBeDefined()
      expect(yield* catalog.model.get(providerID, deprecatedID)).toBeUndefined()
    }),
  )

  it.effect("registers key methods for providers with environment variables", () =>
    Effect.gen(function* () {
      const integrations = yield* Integration.Service
      const catalog = yield* Catalog.Service
      yield* ModelsDevPlugin.effect(
        host({
          catalog: catalogHost(catalog),
          integration: integrationHost(integrations),
        }),
      )
      expect(yield* integrations.list()).toEqual([
        Integration.Info.make({
          id: Integration.ID.make("acme"),
          name: "Acme",
          methods: [
            { type: "key" },
            {
              type: "env",
              names: ["ACME_API_KEY"],
            },
          ],
          connections: [],
        }),
      ])
    }).pipe(Effect.provide(models(path.join(import.meta.dir, "fixtures", "models-dev.json")))),
  )

  it.effect("preserves provider and model URL templates in the catalog", () =>
    withEnv(
      {
        ACME_HOST: "api.acme.test",
        ACME_MODEL_PATH: undefined,
        UNDECLARED_HOST: "private.example",
      },
      () =>
        Effect.gen(function* () {
          const integrations = yield* Integration.Service
          const catalog = yield* Catalog.Service
          const providerID = Provider.ID.make("acme")
          const modelID = Model.ID.make("gpt-5.4")
          yield* ModelsDevPlugin.effect(
            host({
              catalog: catalogHost(catalog),
              integration: integrationHost(integrations),
            }),
          ).pipe(
            Effect.provideService(
              ModelsDev.Service,
              ModelsDev.Service.of({
                get: () =>
                  Effect.succeed([
                    {
                      info: {
                        id: providerID,
                        name: "Acme",
                        activation: "auto",
                        package: Provider.aisdk("@ai-sdk/openai-compatible"),
                        settings: { baseURL: "https://${ACME_HOST}/${UNDECLARED_HOST}/v1" },
                      },
                      environment: ["ACME_HOST", "ACME_MODEL_PATH", "ACME_API_KEY"],
                      models: [
                        {
                          id: modelID,
                          modelID,
                          providerID,
                          name: "GPT-5.4",
                          settings: { baseURL: "https://${ACME_HOST}/${ACME_MODEL_PATH}/v1" },
                          capabilities: { tools: true, input: [], output: [] },
                          variants: [],
                          time: { released: Date.parse("2026-01-01") },
                          cost: [],
                          status: "active",
                          enabled: true,
                          limit: { context: 1_050_000, output: 128_000 },
                        },
                      ],
                    },
                  ] satisfies readonly ModelsDev.Snapshot[]),
                refresh: () => Effect.void,
              }),
            ),
          )

          expect((yield* catalog.provider.get(providerID))?.settings?.baseURL).toBe(
            "https://${ACME_HOST}/${UNDECLARED_HOST}/v1",
          )
          expect((yield* catalog.model.get(providerID, modelID))?.settings?.baseURL).toBe(
            "https://${ACME_HOST}/${ACME_MODEL_PATH}/v1",
          )
        }),
    ),
  )

  it.effect("copies model request bodies without reinterpreting literal __proto__ keys", () =>
    Effect.gen(function* () {
      const integrations = yield* Integration.Service
      const catalog = yield* Catalog.Service
      const providerID = Provider.ID.make("acme")
      const modelID = Model.ID.make("gpt-5.4")
      // A JSON body may legitimately contain a "__proto__" key; both copy stages must keep it as an own property.
      const body = JSON.parse('{"__proto__":{"service_tier":"priority"},"keep":true}') as Record<string, unknown>
      const snapshot = {
        info: {
          id: providerID,
          name: "Acme",
          activation: "auto",
          package: Provider.aisdk("@ai-sdk/openai-compatible"),
        },
        environment: [],
        models: [
          {
            id: modelID,
            modelID,
            providerID,
            name: "GPT-5.4",
            capabilities: { tools: true, input: [], output: [] },
            variants: [],
            time: { released: Date.parse("2026-01-01") },
            cost: [],
            status: "active",
            enabled: true,
            limit: { context: 1_050_000, output: 128_000 },
            body,
          },
        ],
      } satisfies ModelsDev.Snapshot
      yield* ModelsDevPlugin.effect(
        host({
          catalog: catalogHost(catalog),
          integration: integrationHost(integrations),
        }),
      ).pipe(
        Effect.provideService(
          ModelsDev.Service,
          ModelsDev.Service.of({ get: () => Effect.succeed([snapshot]), refresh: () => Effect.void }),
        ),
      )

      const copied = (yield* catalog.model.get(providerID, modelID))?.body
      expect(copied).not.toBe(body)
      expect(Object.hasOwn(copied ?? {}, "__proto__")).toBe(true)
      expect(Object.keys(copied ?? {})).toEqual(["__proto__", "keep"])
      expect(JSON.stringify(copied)).toBe(JSON.stringify(body))
      expect(copied).not.toHaveProperty("service_tier")
    }),
  )

  it.effect("omits legacy provider aliases", () =>
    Effect.gen(function* () {
      const integrations = yield* Integration.Service
      const catalog = yield* Catalog.Service
      const snapshots = [
        ["azure", "Azure", "AZURE_API_KEY", "@ai-sdk/azure"],
        ["azure-cognitive-services", "Azure Cognitive Services", "AZURE_COGNITIVE_SERVICES_API_KEY", "@ai-sdk/azure"],
        ["google-vertex", "Google Vertex", "GOOGLE_APPLICATION_CREDENTIALS", "@ai-sdk/google-vertex"],
        [
          "google-vertex-anthropic",
          "Google Vertex Anthropic",
          "GOOGLE_APPLICATION_CREDENTIALS",
          "@ai-sdk/google-vertex/anthropic",
        ],
      ].map(([id, name, environment, packageName]) => ({
        info: {
          id: Provider.ID.make(id),
          name,
          activation: "auto",
          package: Provider.aisdk(packageName),
        },
        environment: id === "azure" ? ["AZURE_RESOURCE_NAME", environment] : [environment],
        models: [],
      })) satisfies readonly ModelsDev.Snapshot[]

      yield* ModelsDevPlugin.effect(
        host({
          catalog: catalogHost(catalog),
          integration: integrationHost(integrations),
        }),
      ).pipe(
        Effect.provideService(
          ModelsDev.Service,
          ModelsDev.Service.of({
            get: () => Effect.succeed(snapshots),
            refresh: () => Effect.void,
          }),
        ),
      )

      expect(yield* catalog.provider.get(Provider.ID.azure)).toBeDefined()
      expect(yield* catalog.provider.get(Provider.ID.make("google-vertex"))).toBeDefined()
      expect(yield* catalog.provider.get(Provider.ID.make("azure-cognitive-services"))).toBeUndefined()
      expect(yield* catalog.provider.get(Provider.ID.make("google-vertex-anthropic"))).toBeUndefined()
      expect(yield* integrations.get(Integration.ID.make("azure"))).toBeDefined()
      expect(yield* integrations.get(Integration.ID.make("azure"))).toMatchObject({
        methods: [{ type: "key" }, { type: "env", names: ["AZURE_API_KEY", "AZURE_COGNITIVE_SERVICES_API_KEY"] }],
      })
      expect(yield* integrations.get(Integration.ID.make("google-vertex"))).toBeDefined()
      expect(yield* integrations.get(Integration.ID.make("azure-cognitive-services"))).toBeUndefined()
      expect(yield* integrations.get(Integration.ID.make("google-vertex-anthropic"))).toBeUndefined()
      expect(ProviderPlugins.map((plugin) => plugin.id)).not.toContain("opencode.provider.azure.cognitive.services")
      expect(ProviderPlugins.map((plugin) => plugin.id)).not.toContain("opencode.provider.google.vertex.anthropic")
    }),
  )

  it.effect("advertises only key-bearing Google Vertex environment variables", () =>
    Effect.gen(function* () {
      const integrations = yield* Integration.Service
      const catalog = yield* Catalog.Service

      yield* ModelsDevPlugin.effect(
        host({
          catalog: catalogHost(catalog),
          integration: integrationHost(integrations),
        }),
      ).pipe(
        Effect.provideService(
          ModelsDev.Service,
          ModelsDev.Service.of({
            get: () =>
              Effect.succeed([
                {
                  info: {
                    id: Provider.ID.make("google-vertex"),
                    name: "Google Vertex",
                    activation: "auto",
                    package: Provider.aisdk("@ai-sdk/google-vertex"),
                  },
                  environment: ["GOOGLE_VERTEX_PROJECT", "GOOGLE_VERTEX_LOCATION", "GOOGLE_APPLICATION_CREDENTIALS"],
                  models: [],
                },
              ] satisfies readonly ModelsDev.Snapshot[]),
            refresh: () => Effect.void,
          }),
        ),
      )

      // Vertex authenticates through ADC; project, location, and the credentials
      // file path are configuration, not API keys.
      expect(yield* integrations.get(Integration.ID.make("google-vertex"))).toMatchObject({
        methods: [{ type: "key" }, { type: "env", names: ["GOOGLE_VERTEX_API_KEY"] }],
      })
    }),
  )

  it.effect("converts reasoning options into settings variants", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const integrations = yield* Integration.Service
      yield* ModelsDevPlugin.effect(
        host({
          catalog: catalogHost(catalog),
          integration: integrationHost(integrations),
        }),
      )

      const model = yield* catalog.model.get(Provider.ID.openai, Model.ID.make("gpt-reasoning"))
      expect(model?.variants?.map((variant) => variant.id)).toEqual([
        Model.VariantID.make("low"),
        Model.VariantID.make("high"),
      ])
      expect(model?.variants).toContainEqual({
        id: Model.VariantID.make("low"),
        settings: {
          reasoningEffort: "low",
          reasoningSummary: "auto",
          include: ["reasoning.encrypted_content"],
        },
      })
      expect(model?.variants).toContainEqual({
        id: Model.VariantID.make("high"),
        settings: {
          reasoningEffort: "high",
          reasoningSummary: "auto",
          include: ["reasoning.encrypted_content"],
        },
      })

      const mode = yield* catalog.model.get(Provider.ID.openai, Model.ID.make("gpt-reasoning-high"))
      expect(mode).toMatchObject({
        id: "gpt-reasoning-high",
        name: "GPT Reasoning High",
        headers: { "x-mode": "high" },
        body: { service_tier: "priority" },
      })
      expect(mode?.variants?.map((variant) => variant.id)).toEqual([
        Model.VariantID.make("low"),
        Model.VariantID.make("high"),
      ])

      const pro = yield* catalog.model.get(Provider.ID.openai, Model.ID.make("gpt-reasoning-pro"))
      expect(pro).toMatchObject({
        id: "gpt-reasoning-pro",
        body: { reasoning: { mode: "pro" } },
      })

      const budgetModel = yield* catalog.model.get(Provider.ID.anthropic, Model.ID.make("claude-budget"))
      expect(budgetModel?.variants).toContainEqual({
        id: Model.VariantID.make("high"),
        settings: { thinking: { type: "enabled", budgetTokens: 16000 } },
      })
      expect(budgetModel?.variants).toContainEqual({
        id: Model.VariantID.make("max"),
        settings: { thinking: { type: "enabled", budgetTokens: 31999 } },
      })

      const anthropicEffortModel = yield* catalog.model.get(Provider.ID.anthropic, Model.ID.make("claude-opus-4.7"))
      expect(anthropicEffortModel?.variants).toEqual([
        { id: Model.VariantID.make("none"), settings: { thinking: { type: "disabled" } } },
        {
          id: Model.VariantID.make("low"),
          settings: { thinking: { type: "adaptive", display: "summarized" }, effort: "low" },
        },
      ])

      const anthropicToggleModel = yield* catalog.model.get(Provider.ID.anthropic, Model.ID.make("claude-toggle"))
      expect(anthropicToggleModel?.variants).toEqual([
        { id: Model.VariantID.make("none"), settings: { thinking: { type: "disabled" } } },
        {
          id: Model.VariantID.make("thinking"),
          settings: { thinking: { type: "adaptive", display: "summarized" } },
        },
      ])

      const opus45 = yield* catalog.model.get(Provider.ID.anthropic, Model.ID.make("claude-opus-4-5"))
      expect(opus45?.variants).toEqual([
        { id: Model.VariantID.make("low"), settings: { effort: "low" } },
        { id: Model.VariantID.make("high"), settings: { effort: "high" } },
      ])

      const grok = yield* catalog.model.get(Provider.ID.make("xai"), Model.ID.make("grok-4.5"))
      expect(grok?.variants).toEqual(
        ["low", "medium", "high"].map((id) => ({
          id: Model.VariantID.make(id),
          settings: { reasoningEffort: id },
        })),
      )

      const minimax = yield* catalog.model.get(Provider.ID.make("opencode-go"), Model.ID.make("minimax-m3"))
      expect(minimax?.variants).toEqual([
        { id: Model.VariantID.make("none"), settings: { thinking: { type: "disabled" } } },
        {
          id: Model.VariantID.make("thinking"),
          settings: { thinking: { type: "adaptive", display: "summarized" } },
        },
      ])

      const toggle = yield* catalog.model.get(Provider.ID.make("alibaba"), Model.ID.make("toggle-only"))
      expect(toggle?.variants).toEqual([
        { id: Model.VariantID.make("none"), settings: { enableThinking: false } },
        { id: Model.VariantID.make("thinking"), settings: { enableThinking: true } },
      ])

      const combined = yield* catalog.model.get(Provider.ID.make("alibaba"), Model.ID.make("toggle-budget"))
      expect(combined?.variants).toEqual([
        { id: Model.VariantID.make("none"), settings: { enableThinking: false } },
        {
          id: Model.VariantID.make("high"),
          settings: { enableThinking: true, thinkingBudget: 8000 },
        },
        {
          id: Model.VariantID.make("max"),
          settings: { enableThinking: true, thinkingBudget: 16000 },
        },
      ])

      const gateway = yield* catalog.model.get(Provider.ID.make("vercel"), Model.ID.make("alibaba/qwen-toggle"))
      expect(gateway?.variants).toEqual([
        { id: Model.VariantID.make("none"), settings: { enableThinking: false } },
        {
          id: Model.VariantID.make("high"),
          settings: { enableThinking: true, thinkingBudget: 8000 },
        },
        {
          id: Model.VariantID.make("max"),
          settings: { enableThinking: true, thinkingBudget: 16000 },
        },
      ])

      const gatewayNova = yield* catalog.model.get(Provider.ID.make("vercel"), Model.ID.make("amazon/nova-2-lite"))
      expect(gatewayNova?.variants).toEqual([
        {
          id: Model.VariantID.make("none"),
          settings: { additionalModelRequestFields: { reasoningConfig: { type: "disabled" } } },
        },
        {
          id: Model.VariantID.make("low"),
          settings: { reasoningConfig: { type: "enabled", maxReasoningEffort: "low" } },
        },
        {
          id: Model.VariantID.make("high"),
          settings: { reasoningConfig: { type: "enabled", maxReasoningEffort: "high" } },
        },
      ])

      const gatewayFallback = yield* catalog.model.get(
        Provider.ID.make("vercel"),
        Model.ID.make("deepseek/deepseek-toggle"),
      )
      expect(gatewayFallback?.variants).toEqual([
        {
          id: Model.VariantID.make("none"),
          settings: { reasoning: { enabled: false } },
        },
        {
          id: Model.VariantID.make("low"),
          settings: { reasoningEffort: "low" },
        },
        {
          id: Model.VariantID.make("high"),
          settings: { reasoningEffort: "high" },
        },
      ])

      const openrouter = yield* catalog.model.get(Provider.ID.make("openrouter"), Model.ID.make("openrouter-toggle"))
      expect(openrouter?.variants).toEqual([
        { id: Model.VariantID.make("none"), settings: { reasoning: { enabled: false } } },
        { id: Model.VariantID.make("thinking"), settings: { reasoning: { enabled: true } } },
      ])

      const google = yield* catalog.model.get(Provider.ID.make("google"), Model.ID.make("gemini-2.5-flash"))
      expect(google?.variants).toEqual([
        {
          id: Model.VariantID.make("none"),
          settings: { thinkingConfig: { includeThoughts: false, thinkingBudget: 0 } },
        },
        {
          id: Model.VariantID.make("high"),
          settings: { thinkingConfig: { includeThoughts: true, thinkingBudget: 8000 } },
        },
        {
          id: Model.VariantID.make("max"),
          settings: { thinkingConfig: { includeThoughts: true, thinkingBudget: 16000 } },
        },
      ])

      const vertex = yield* catalog.model.get(Provider.ID.make("google-vertex"), Model.ID.make("gemini-2.5-flash-lite"))
      expect(vertex?.variants).toEqual([
        {
          id: Model.VariantID.make("none"),
          settings: { thinkingConfig: { includeThoughts: false, thinkingBudget: 0 } },
        },
        {
          id: Model.VariantID.make("high"),
          settings: { thinkingConfig: { includeThoughts: true, thinkingBudget: 8000 } },
        },
        {
          id: Model.VariantID.make("max"),
          settings: { thinkingConfig: { includeThoughts: true, thinkingBudget: 16000 } },
        },
      ])

      const bedrock = yield* catalog.model.get(
        Provider.ID.make("amazon-bedrock"),
        Model.ID.make("us.amazon.nova-2-lite-v1:0"),
      )
      expect(bedrock?.variants).toEqual([
        {
          id: Model.VariantID.make("none"),
          settings: { additionalModelRequestFields: { reasoningConfig: { type: "disabled" } } },
        },
        {
          id: Model.VariantID.make("low"),
          settings: { reasoningConfig: { type: "enabled", maxReasoningEffort: "low" } },
        },
        {
          id: Model.VariantID.make("high"),
          settings: { reasoningConfig: { type: "enabled", maxReasoningEffort: "high" } },
        },
      ])

      const sapGemini = yield* catalog.model.get(Provider.ID.make("sap-ai-core"), Model.ID.make("gemini-2.5-flash"))
      expect(sapGemini?.variants).toEqual([
        {
          id: Model.VariantID.make("none"),
          settings: { modelParams: { thinkingConfig: { includeThoughts: false, thinkingBudget: 0 } } },
        },
        {
          id: Model.VariantID.make("high"),
          settings: { modelParams: { thinkingConfig: { includeThoughts: true, thinkingBudget: 8000 } } },
        },
        {
          id: Model.VariantID.make("max"),
          settings: { modelParams: { thinkingConfig: { includeThoughts: true, thinkingBudget: 16000 } } },
        },
      ])

      const sapNova = yield* catalog.model.get(Provider.ID.make("sap-ai-core"), Model.ID.make("amazon--nova-lite"))
      expect(sapNova?.variants).toEqual([
        {
          id: Model.VariantID.make("none"),
          settings: {
            modelParams: { additionalModelRequestFields: { thinking: { type: "disabled" } } },
          },
        },
        {
          id: Model.VariantID.make("low"),
          settings: {
            modelParams: { additionalModelRequestFields: { output_config: { effort: "low" } } },
          },
        },
        {
          id: Model.VariantID.make("high"),
          settings: {
            modelParams: { additionalModelRequestFields: { output_config: { effort: "high" } } },
          },
        },
      ])

      const sapCohere = yield* catalog.model.get(
        Provider.ID.make("sap-ai-core"),
        Model.ID.make("cohere--command-a-reasoning"),
      )
      expect(sapCohere?.variants).toEqual([
        {
          id: Model.VariantID.make("none"),
          settings: { modelParams: { thinking: { type: "disabled" } } },
        },
        {
          id: Model.VariantID.make("low"),
          settings: { modelParams: { reasoning_effort: "low" } },
        },
        {
          id: Model.VariantID.make("high"),
          settings: { modelParams: { reasoning_effort: "high" } },
        },
      ])

      const sapAnthropicEffort = yield* catalog.model.get(
        Provider.ID.make("sap-ai-core"),
        Model.ID.make("anthropic--claude-4.7-opus"),
      )
      expect(sapAnthropicEffort?.variants).toEqual([
        {
          id: Model.VariantID.make("low"),
          settings: {
            modelParams: {
              additionalModelRequestFields: {
                thinking: { type: "adaptive", display: "summarized" },
                output_config: { effort: "low" },
              },
            },
          },
        },
      ])

      const sapAnthropicBudget = yield* catalog.model.get(
        Provider.ID.make("sap-ai-core"),
        Model.ID.make("anthropic--claude-4-sonnet"),
      )
      expect(sapAnthropicBudget?.variants).toEqual([
        {
          id: Model.VariantID.make("high"),
          settings: {
            modelParams: {
              additionalModelRequestFields: { thinking: { type: "enabled", budget_tokens: 8000 } },
            },
          },
        },
        {
          id: Model.VariantID.make("max"),
          settings: {
            modelParams: {
              additionalModelRequestFields: { thinking: { type: "enabled", budget_tokens: 16000 } },
            },
          },
        },
      ])
    }).pipe(Effect.provide(models(path.join(import.meta.dir, "fixtures", "models-dev-reasoning.json")))),
  )
})
