export * as ConfigProviderPlugin from "./provider.js"

import { define } from "@opencode/plugin/effect/plugin"
import { Document, type Entry } from "@opencode/schema/config"
import { Money } from "@opencode/schema/money"
import { Effect } from "effect"
import { Config } from "../../config.js"
import { Provider } from "../../provider.js"
import { ConfigEntryObserver } from "./entry-observer.js"

export const Plugin = define({
  id: "opencode.config.provider",
  effect: Effect.fn(function* (ctx) {
    const config = yield* Config.Service
    const loaded = yield* ConfigEntryObserver.observe(
      config,
      ctx.event,
      ctx.integration.reload().pipe(Effect.andThen(ctx.catalog.reload())),
    )
    yield* ctx.integration.transform((integrations) => {
      for (const [id, provider] of configuredProviders(loaded.entries)) {
        const integrationID = id
        if (!integrations.get(integrationID)) {
          integrations.method.update({
            integrationID,
            method: { type: "key", label: "Manually enter API Key" },
          })
        }
        integrations.update(integrationID, (integration) => {
          integration.name = provider.name ?? integration.name
        })
        if (provider.env !== undefined) {
          integrations.method.update({
            integrationID,
            method: { type: "env", names: [...provider.env] },
          })
        }
      }
    })

    yield* ctx.catalog.transform((catalog) => {
      const configuredDefault = Config.latest(loaded.entries, "model")
      if (configuredDefault !== undefined)
        catalog.model.default.set(configuredDefault.providerID, configuredDefault.model)
      for (const [id, item] of configuredProviders(loaded.entries)) {
        const providerID = id
        const current = catalog.provider.get(providerID)
        const source = catalog.provider.get(item.canonical ?? current?.provider.canonical ?? providerID)
        const changed = item.canonical !== undefined && item.canonical !== current?.provider.canonical
        catalog.provider.update(providerID, (provider) => {
          if (changed && source && source.provider !== provider)
            Object.assign(provider, structuredClone(source.provider), {
              id: provider.id,
              integrationID: provider.integrationID,
            })
          provider.activation = "enabled"
          if (item.canonical !== undefined) provider.canonical = item.canonical
          if (item.name !== undefined) provider.name = item.name
          if (item.package !== undefined) provider.package = item.package
          if (item.compaction !== undefined) provider.compaction = { ...item.compaction }
          if (item.websocket !== undefined) provider.websocket = item.websocket
          if (item.settings !== undefined) provider.settings = Provider.mergeOverlay(provider.settings, item.settings)
          if (item.headers !== undefined) provider.headers = Provider.mergeHeaders(provider.headers, item.headers)
          if (item.body !== undefined) provider.body = Provider.mergeOverlay(provider.body, item.body)
        })
        for (const [id, config] of Object.entries(item.models ?? {})) {
          const base = source?.models.get(config.modelID ?? id) ?? source?.models.get(id)
          const inherit = changed || !catalog.model.get(providerID, id)
          catalog.model.update(providerID, id, (model) => {
            if (inherit && base) {
              Object.assign(model, structuredClone(base))
              if (item.package !== undefined) model.package = undefined
              if (item.settings?.baseURL !== undefined && model.settings) delete model.settings.baseURL
            }
            if (config.family !== undefined) model.family = config.family
            if (config.name !== undefined) model.name = config.name
            if (config.modelID !== undefined) model.modelID = config.modelID
            if (config.compatibility !== undefined)
              model.compatibility = { ...model.compatibility, ...config.compatibility }
            if (config.package !== undefined) model.package = config.package
            if (config.compaction !== undefined) model.compaction = { ...config.compaction }
            if (config.websocket !== undefined) model.websocket = config.websocket
            if (config.settings !== undefined) model.settings = Provider.mergeOverlay(model.settings, config.settings)
            if (config.headers !== undefined) model.headers = Provider.mergeHeaders(model.headers, config.headers)
            if (config.body !== undefined) model.body = Provider.mergeOverlay(model.body, config.body)
            if (config.capabilities !== undefined) {
              model.capabilities = {
                tools: config.capabilities.tools,
                input: [...config.capabilities.input],
                output: [...config.capabilities.output],
              }
            }
            if (config.variants !== undefined) {
              model.variants ??= []
              for (const variant of config.variants) {
                let existing = model.variants.find((item) => item.id === variant.id)
                if (!existing) {
                  existing = { id: variant.id }
                  model.variants.push(existing)
                }
                if (variant.settings !== undefined)
                  existing.settings = Provider.mergeOverlay(existing.settings, variant.settings)
                if (variant.headers !== undefined)
                  existing.headers = Provider.mergeHeaders(existing.headers, variant.headers)
                if (variant.body !== undefined) existing.body = Provider.mergeOverlay(existing.body, variant.body)
              }
            }
            if (config.cost !== undefined) {
              model.cost = (Array.isArray(config.cost) ? config.cost : [config.cost]).map((cost) => ({
                tier: cost.tier && { ...cost.tier },
                input: cost.input,
                output: cost.output,
                cache: {
                  read: cost.cache?.read ?? Money.USDPerMillionTokens.zero,
                  write: cost.cache?.write ?? Money.USDPerMillionTokens.zero,
                },
              }))
            }
            if (config.disabled !== undefined) model.enabled = !config.disabled
            if (config.limit !== undefined) model.limit = { ...model.limit, ...config.limit }
          })
        }
      }
    })
  }),
})

function configuredProviders(entries: readonly Entry[]) {
  return entries
    .filter((entry): entry is Document => entry.type === "document")
    .flatMap((file) => Object.entries(file.info.providers ?? {}))
}
