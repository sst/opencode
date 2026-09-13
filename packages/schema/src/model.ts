export * as Model from "./model.js"

import { Schema } from "effect"
import { optional, statics } from "./schema.js"
import { Provider } from "./provider.js"
import { Money } from "./money.js"

export const ID = Schema.String.pipe(Schema.brand("Model.ID"))
export type ID = typeof ID.Type

export const VariantID = Schema.String.pipe(Schema.brand("Model.VariantID"))
export type VariantID = typeof VariantID.Type

export const Ref = Schema.Struct({
  id: ID,
  providerID: Provider.ID,
  variant: VariantID.pipe(optional),
})
  .annotate({ identifier: "Model.Ref" })
  .pipe(
    statics((schema) => ({
      parse: (input: string) => {
        const providerEnd = input.indexOf("/")
        if (providerEnd <= 0) throw new Error(`Invalid model reference: ${input}`)
        const providerID = input.slice(0, providerEnd)
        const variantStart = input.indexOf("#", providerEnd + 1)
        const id = input.slice(providerEnd + 1, variantStart === -1 ? undefined : variantStart)
        const variant = variantStart === -1 ? undefined : input.slice(variantStart + 1)
        if (!id || providerID.includes("#") || (variant !== undefined && (!variant || variant.includes("#"))))
          throw new Error(`Invalid model reference: ${input}`)
        return schema.make({
          providerID: Provider.ID.make(providerID),
          id: ID.make(id),
          ...(variant ? { variant: VariantID.make(variant) } : {}),
        })
      },
    })),
  )
export interface Ref extends Schema.Schema.Type<typeof Ref> {}

export const Family = Schema.String.pipe(Schema.brand("Model.Family"))
export type Family = typeof Family.Type

export type ReasoningField = "reasoning" | "reasoning_content" | "reasoning_text" | (string & {})
export const ReasoningField: Schema.Codec<ReasoningField> = Schema.Union([
  Schema.Literals(["reasoning", "reasoning_content", "reasoning_text"]),
  Schema.String,
]).annotate({ identifier: "Model.ReasoningField" })

export const MaxTokensField = Schema.Literals(["max_completion_tokens", "max_tokens"]).annotate({
  identifier: "Model.MaxTokensField",
})
export type MaxTokensField = typeof MaxTokensField.Type

export interface Compatibility extends Schema.Schema.Type<typeof Compatibility> {}
export const Compatibility = Schema.Struct({
  reasoningField: ReasoningField.pipe(optional),
  /** Require every assistant message to include its reasoning field, even when empty. */
  requireReasoning: Schema.Boolean.pipe(optional),
  maxTokensField: MaxTokensField.pipe(optional),
  requireFinishReason: Schema.Boolean.pipe(optional),
  requireAssistantAfterTool: Schema.Boolean.pipe(optional),
}).annotate({ identifier: "Model.Compatibility" })

export interface Capabilities extends Schema.Schema.Type<typeof Capabilities> {}
export const Capabilities = Schema.Struct({
  tools: Schema.Boolean,
  input: Schema.Array(Schema.String),
  output: Schema.Array(Schema.String),
  responsesWebsockets: Schema.Boolean.pipe(optional),
})
  .annotate({ identifier: "Model.Capabilities" })
  .pipe(
    statics(() => ({
      default: () => ({ tools: true, input: ["text", "image"], output: ["text"] }) satisfies Capabilities,
    })),
  )

export interface Cost extends Schema.Schema.Type<typeof Cost> {}
export const Cost = Schema.Struct({
  tier: Schema.Struct({
    type: Schema.tag("context"),
    size: Schema.Int,
  }).pipe(optional),
  input: Money.USDPerMillionTokens,
  output: Money.USDPerMillionTokens,
  cache: Schema.Struct({
    read: Money.USDPerMillionTokens,
    write: Money.USDPerMillionTokens,
  }),
}).annotate({ identifier: "Model.Cost" })

export interface Variant extends Schema.Schema.Type<typeof Variant> {}
export const Variant = Schema.Struct({
  id: VariantID,
  ...Provider.Overlays,
}).annotate({ identifier: "Model.Variant" })

export interface Info extends Schema.Schema.Type<typeof Info> {}
export const Info = Schema.Struct({
  id: ID,
  modelID: ID,
  providerID: Provider.ID,
  canonical: Provider.ID.pipe(optional),
  family: Family.pipe(optional),
  name: Schema.String,
  compatibility: Compatibility.pipe(optional),
  package: Provider.Package.pipe(optional),
  compaction: Provider.Compaction.pipe(optional),
  /** Session WebSocket policy; omitted inherits the provider policy, then defaults to disabled. */
  websocket: Schema.Boolean.pipe(optional),
  ...Provider.Overlays,
  capabilities: Capabilities,
  variants: Schema.Array(Variant),
  time: Schema.Struct({
    released: Schema.Finite,
  }),
  cost: Schema.Array(Cost),
  status: Schema.Literals(["alpha", "beta", "deprecated", "active"]),
  enabled: Schema.Boolean,
  limit: Schema.Struct({
    context: Schema.Int,
    input: Schema.Int.pipe(optional),
    output: Schema.Int,
  }),
})
  .annotate({ identifier: "Model.Info" })
  .pipe(
    statics(() => ({
      default: (providerID: Provider.ID, id: ID) =>
        ({
          id,
          modelID: id,
          providerID,
          name: id,
          capabilities: Capabilities.default(),
          variants: [],
          time: { released: 0 },
          cost: [],
          status: "active",
          enabled: true,
          limit: { context: 200_000, output: 32_000 },
        }) satisfies Info,
    })),
  )
