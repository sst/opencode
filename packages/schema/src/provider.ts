export * as Provider from "./provider.js"

import { Effect, Schema } from "effect"
import { Integration } from "./integration.js"
import { optional, PositiveInt, statics } from "./schema.js"

export const ID = Schema.String.pipe(
  Schema.brand("Provider.ID"),
  statics((schema) => ({
    opencode: schema.make("opencode"),
    anthropic: schema.make("anthropic"),
    openai: schema.make("openai"),
    google: schema.make("google"),
    googleVertex: schema.make("google-vertex"),
    githubCopilot: schema.make("github-copilot"),
    amazonBedrock: schema.make("amazon-bedrock"),
    azure: schema.make("azure"),
    openrouter: schema.make("openrouter"),
    mistral: schema.make("mistral"),
    gitlab: schema.make("gitlab"),
  })),
)
export type ID = typeof ID.Type

export const Package = Schema.String
export type Package = typeof Package.Type

export const Activation = Schema.Literals(["auto", "enabled", "disabled"])
export type Activation = typeof Activation.Type

export type Compaction = typeof Compaction.Type
export const Compaction = Schema.Union([
  Schema.Struct({ mode: Schema.Literal("local") }),
  Schema.Struct({ mode: Schema.Literal("provider"), threshold: PositiveInt.pipe(optional) }),
]).annotate({ identifier: "Provider.Compaction" })

export const Overlays = {
  settings: Schema.Record(Schema.String, Schema.Any).pipe(optional),
  headers: Schema.Record(Schema.String, Schema.String).pipe(optional),
  body: Schema.Record(Schema.String, Schema.Any).pipe(optional),
}

export const Settings = Schema.Record(Schema.String, Schema.Any).annotate({ identifier: "Provider.Settings" })
export type Settings = typeof Settings.Type

export interface Request extends Schema.Schema.Type<typeof Request> {}
export const Request = Schema.Struct({
  settings: Settings.pipe(Schema.withConstructorDefault(Effect.succeed({}))),
  headers: Schema.Record(Schema.String, Schema.String),
  body: Schema.Record(Schema.String, Schema.Any),
}).annotate({ identifier: "Provider.Request" })

export interface Info extends Schema.Schema.Type<typeof Info> {}
export const Info = Schema.Struct({
  id: ID,
  canonical: ID.pipe(optional),
  integrationID: Integration.ID.pipe(optional),
  name: Schema.String,
  activation: Activation,
  package: Package,
  compaction: Compaction.pipe(optional),
  /** Session WebSocket policy for routes that support it; omitted means disabled. */
  websocket: Schema.Boolean.pipe(optional),
  ...Overlays,
})
  .annotate({ identifier: "Provider.Info" })
  .pipe(
    statics(() => ({
      empty: (id: ID): Info => ({ id, name: id, activation: "auto", package: "" }),
    })),
  )
