import { z } from "zod"
import { eq, and } from "drizzle-orm"
import { Database } from "./drizzle"
import { ModelTable } from "./schema/model.sql"
import { Identifier } from "./identifier"
import { fn } from "./util/fn"
import { Actor } from "./actor"
import { Resource } from "@opencode-ai/console-resource"

export namespace ZenData {
  const FormatSchema = z.enum(["anthropic", "google", "openai", "oa-compat"])
  export type Format = z.infer<typeof FormatSchema>

  const ModelCostSchema = z.object({
    input: z.number(),
    output: z.number(),
    cacheRead: z.number().optional(),
    cacheWrite5m: z.number().optional(),
    cacheWrite1h: z.number().optional(),
  })

  // Long-context tier. The flip threshold defaults to 200_000 for backward
  // compatibility with existing ZEN_MODELS secrets.
  const ModelCostTierSchema = ModelCostSchema.extend({
    threshold: z.number().default(200_000),
  })

  const ModelSchema = z.object({
    name: z.string(),
    cost: ModelCostSchema,
    costMultiplier: z.number().default(1),
    cost200K: ModelCostTierSchema.optional(),
    costPeak: ModelCostSchema.optional(),
    allowAnonymous: z.boolean().optional(),
    byokProvider: z.enum(["openai", "anthropic", "google"]).optional(),
    stickyProvider: z.enum(["strict", "prefer"]).optional(),
    trialProvider: z.string().optional(),
    trialEnded: z.boolean().optional(),
    fallbackProvider: z.string().optional(),
    rateLimit: z.number().optional(),
    providers: z.array(
      z.object({
        id: z.string(),
        model: z.string(),
        priority: z.number().optional(),
        tpmLimit: z.number().optional(),
        tpsGoal: z.number().optional(),
        budgetPriority: z.number().optional(),
        budgetContribution: z.number().optional(),
        weight: z.number().optional(),
        disabled: z.boolean().optional(),
        storeModel: z.string().optional(),
        payloadModifier: z.record(z.string(), z.any()).optional(),
      }),
    ),
  })

  const ProviderSchema = z.object({
    displayName: z.string().optional(),
    api: z.string(),
    apiKey: z.union([z.string(), z.record(z.string(), z.string())]),
    format: FormatSchema.optional(),
    headerModifier: z.record(z.string(), z.any()).optional(),
    payloadModifier: z.record(z.string(), z.any()).optional(),
    adjustCacheUsage: z.boolean().optional(),
    budget: z.number().optional(),
  })

  const ModelsSchema = z.object({
    zenModels: z.record(
      z.string(),
      z.union([ModelSchema, z.array(ModelSchema.extend({ formatFilter: FormatSchema }))]),
    ),
    liteModels: z.record(
      z.string(),
      z.union([ModelSchema, z.array(ModelSchema.extend({ formatFilter: FormatSchema }))]),
    ),
    providers: z.record(z.string(), ProviderSchema),
  })

  export const validate = fn(ModelsSchema, (input) => {
    return input
  })

  export const list = fn(z.enum(["lite", "full"]), (modelList) => {
    const json = JSON.parse(
      Resource.ZEN_MODELS1.value +
        Resource.ZEN_MODELS2.value +
        Resource.ZEN_MODELS3.value +
        Resource.ZEN_MODELS4.value +
        Resource.ZEN_MODELS5.value +
        Resource.ZEN_MODELS6.value +
        Resource.ZEN_MODELS7.value +
        Resource.ZEN_MODELS8.value +
        Resource.ZEN_MODELS9.value +
        Resource.ZEN_MODELS10.value +
        Resource.ZEN_MODELS11.value +
        Resource.ZEN_MODELS12.value +
        Resource.ZEN_MODELS13.value +
        Resource.ZEN_MODELS14.value +
        Resource.ZEN_MODELS15.value +
        Resource.ZEN_MODELS16.value +
        Resource.ZEN_MODELS17.value +
        Resource.ZEN_MODELS18.value +
        Resource.ZEN_MODELS19.value +
        Resource.ZEN_MODELS20.value +
        Resource.ZEN_MODELS21.value +
        Resource.ZEN_MODELS22.value +
        Resource.ZEN_MODELS23.value +
        Resource.ZEN_MODELS24.value +
        Resource.ZEN_MODELS25.value +
        Resource.ZEN_MODELS26.value +
        Resource.ZEN_MODELS27.value +
        Resource.ZEN_MODELS28.value +
        Resource.ZEN_MODELS29.value +
        Resource.ZEN_MODELS30.value,
    )
    const { zenModels, liteModels, providers } = ModelsSchema.parse(json)
    const compositeProviders = Object.fromEntries(
      Object.entries(providers).map(([id, provider]) => [
        id,
        typeof provider.apiKey === "string"
          ? [{ id: id, key: provider.apiKey }]
          : Object.entries(provider.apiKey).map(([kid, key]) => ({
              id: `${id}.${kid}`,
              key,
            })),
      ]),
    )
    return {
      providers: Object.fromEntries(
        Object.entries(providers).flatMap(([providerId, provider]) =>
          compositeProviders[providerId].map((p) => [p.id, { ...provider, apiKey: p.key }]),
        ),
      ),
      models: (() => {
        const normalize = (model: z.infer<typeof ModelSchema>) => {
          const providers = model.providers.map((p) => ({
            ...p,
            priority: p.priority ?? Infinity,
            weight: p.weight ?? 1,
          }))
          const composite = providers.find((p) => compositeProviders[p.id].length > 1)
          if (!composite)
            return {
              trialProvider: model.trialProvider ? [model.trialProvider] : undefined,
              providers,
            }

          const weightMulti = compositeProviders[composite.id].length

          return {
            trialProvider: (() => {
              if (!model.trialProvider) return undefined
              if (model.trialProvider === composite.id) return compositeProviders[composite.id].map((p) => p.id)
              return [model.trialProvider]
            })(),
            providers: providers.flatMap((p) =>
              p.id === composite.id
                ? compositeProviders[p.id].map((sub) => ({
                    ...p,
                    id: sub.id,
                  }))
                : [
                    {
                      ...p,
                      weight: p.weight * weightMulti,
                    },
                  ],
            ),
          }
        }

        return Object.fromEntries(
          Object.entries(modelList === "lite" ? liteModels : zenModels).map(([modelId, model]) => {
            const n = Array.isArray(model)
              ? model.map((m) => ({ ...m, ...normalize(m) }))
              : { ...model, ...normalize(model) }
            return [modelId, n]
          }),
        )
      })(),
    }
  })
}

export namespace Model {
  export const enable = fn(z.object({ model: z.string() }), ({ model }) => {
    Actor.assertAdmin()
    return Database.use((db) =>
      db.delete(ModelTable).where(and(eq(ModelTable.workspaceID, Actor.workspace()), eq(ModelTable.model, model))),
    )
  })

  export const disable = fn(z.object({ model: z.string() }), ({ model }) => {
    Actor.assertAdmin()
    return Database.use((db) =>
      db
        .insert(ModelTable)
        .values({
          id: Identifier.create("model"),
          workspaceID: Actor.workspace(),
          model: model,
        })
        .onDuplicateKeyUpdate({
          set: {
            timeDeleted: null,
          },
        }),
    )
  })

  export const listDisabled = fn(z.void(), () => {
    return Database.use((db) =>
      db
        .select({ model: ModelTable.model })
        .from(ModelTable)
        .where(eq(ModelTable.workspaceID, Actor.workspace()))
        .then((rows) => rows.map((row) => row.model)),
    )
  })

  export const isDisabled = fn(
    z.object({
      model: z.string(),
    }),
    ({ model }) => {
      return Database.use(async (db) => {
        const result = await db
          .select()
          .from(ModelTable)
          .where(and(eq(ModelTable.workspaceID, Actor.workspace()), eq(ModelTable.model, model)))
          .limit(1)

        return result.length > 0
      })
    },
  )
}
