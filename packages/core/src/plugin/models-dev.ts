import { define } from "@opencode/plugin/effect/plugin"
import { Integration } from "@opencode/schema/integration"
import { Provider } from "@opencode/schema/provider"
import { Effect, Stream } from "effect"
import { Bus } from "../bus.js"
import { ModelsDev } from "../models-dev.js"

// These catalog entries require inference profiles on Bedrock Runtime.
// Opus/Sonnet 4.6 support in-region calls in eu-west-2 and must remain available.
const BEDROCK_PROFILE_ONLY_IDS = [
  "amazon.nova-2-lite-v1:0",
  "anthropic.claude-fable-5",
  "anthropic.claude-fable-5-1",
  "anthropic.claude-haiku-4-5-20251001-v1:0",
  "anthropic.claude-opus-4-1-20250805-v1:0",
  "anthropic.claude-opus-4-5-20251101-v1:0",
  "anthropic.claude-opus-4-7",
  "anthropic.claude-opus-4-8",
  "anthropic.claude-opus-5",
  "anthropic.claude-sonnet-4-5-20250929-v1:0",
  "anthropic.claude-sonnet-5",
  "deepseek.r1-v1:0",
  "mistral.pixtral-large-2502-v1:0",
]

export const ModelsDevPlugin = define({
  id: "opencode.models.dev",
  effect: Effect.fn(function* (ctx) {
    const modelsDev = yield* ModelsDev.Service
    const bus = yield* Bus.Service
    // The normalized snapshot is shared by every Location and only read here; the catalog
    // receives copies below, so retaining a second copy per Location is unnecessary.
    const loaded = { data: snapshots(yield* modelsDev.get()) }
    yield* ctx.integration.transform((integrations) => {
      for (const provider of loaded.data) {
        if (provider.environment.length === 0) continue
        const integrationID = provider.info.id
        integrations.update(integrationID, (integration) => (integration.name = provider.info.name))
        integrations.method.update({
          integrationID,
          method: { type: "key" },
        })
        integrations.method.update({
          integrationID,
          method: {
            type: "env",
            names: environmentNames(provider),
          },
        })
      }
    })
    yield* ctx.catalog.transform((catalog) => {
      for (const provider of loaded.data) {
        catalog.provider.update(provider.info.id, (draft) => {
          Object.assign(draft, copy(provider.info))
          draft.integrationID = Integration.ID.make(provider.info.id)
        })
        for (const model of provider.models) {
          if (model.status === "deprecated") continue
          if (
            provider.info.id === Provider.ID.amazonBedrock &&
            BEDROCK_PROFILE_ONLY_IDS.includes(model.modelID ?? model.id)
          )
            continue
          catalog.model.update(provider.info.id, model.id, (draft) => Object.assign(draft, copy(model)))
        }
      }
    })
    yield* bus.subscribe(ModelsDev.Event.Refreshed).pipe(
      Stream.runForEach(() =>
        modelsDev.get().pipe(
          Effect.tap((data) => Effect.sync(() => (loaded.data = snapshots(data)))),
          Effect.andThen(ctx.integration.reload()),
          Effect.andThen(ctx.catalog.reload()),
        ),
      ),
      Effect.forkScoped({ startImmediately: true }),
    )
  }),
})

function environmentNames(provider: ModelsDev.Snapshot) {
  if (provider.info.id === Provider.ID.azure)
    return [...provider.environment.filter((name) => name.endsWith("_API_KEY")), "AZURE_COGNITIVE_SERVICES_API_KEY"]
  // models.dev advertises project, location, and the ADC credentials file path for
  // Vertex. Those configure Google auth rather than carrying a key, so only the
  // Express Mode key may become a credential; GoogleVertexPlugin handles activation.
  if (provider.info.id === Provider.ID.googleVertex) return ["GOOGLE_VERTEX_API_KEY"]
  return [...provider.environment]
}

function snapshots(data: readonly ModelsDev.Snapshot[]) {
  return data.filter(
    // These deprecated aliases are replaced by the canonical Azure and Google Vertex providers.
    (provider) => provider.info.id !== "azure-cognitive-services" && provider.info.id !== "google-vertex-anthropic",
  )
}

// The catalog owns and mutates its provider and model records in place, so every rebuild
// needs fresh copies of the thousands of shared snapshot records. Snapshot data is plain
// JSON, and a direct copy is an order of magnitude faster than structuredClone's general
// graph walk on the startup path.
function copy<T>(value: T): T {
  if (Array.isArray(value)) return value.map(copy) as T
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {}
    for (const key of Object.keys(value)) {
      const copied = copy((value as Record<string, unknown>)[key])
      // Assigning this key would set the prototype rather than an own property, unlike structuredClone.
      if (key === "__proto__")
        Object.defineProperty(result, key, { value: copied, enumerable: true, writable: true, configurable: true })
      else result[key] = copied
    }
    return result as T
  }
  return value
}
