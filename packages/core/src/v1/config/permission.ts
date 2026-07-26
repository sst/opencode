export * as ConfigPermissionV1 from "./permission"

import { Schema, SchemaGetter } from "effect"

export const Action = Schema.Literals(["ask", "allow", "deny"]).annotate({ identifier: "PermissionActionConfig" })
export type Action = Schema.Schema.Type<typeof Action>

export const Object = Schema.Record(Schema.String, Action).annotate({ identifier: "PermissionObjectConfig" })
export type Object = Schema.Schema.Type<typeof Object>

export const Rule = Schema.Union([Action, Object]).annotate({ identifier: "PermissionRuleConfig" })
export type Rule = Schema.Schema.Type<typeof Rule>

// Known permission keys get explicit types in the Effect schema for generated
// docs/types. Runtime config parsing uses Effect's `propertyOrder: "original"`
// parse option so user key order is preserved for permission precedence.
const InputObject = Schema.StructWithRest(
  Schema.Struct({
    read: Schema.optional(Rule),
    edit: Schema.optional(Rule),
    glob: Schema.optional(Rule),
    grep: Schema.optional(Rule),
    list: Schema.optional(Rule),
    bash: Schema.optional(Rule),
    task: Schema.optional(Rule),
    external_directory: Schema.optional(Rule),
    todowrite: Schema.optional(Action),
    question: Schema.optional(Action),
    interrupt: Schema.optional(Action),
    webfetch: Schema.optional(Action),
    websearch: Schema.optional(Action),
    lsp: Schema.optional(Rule),
    doom_loop: Schema.optional(Action),
    skill: Schema.optional(Rule),
  }),
  [Schema.Record(Schema.String, Rule)],
)

const InputSchema = Schema.Union([Action, InputObject])

const normalizeInput = (input: Schema.Schema.Type<typeof InputSchema>): Schema.Schema.Type<typeof InputObject> =>
  typeof input === "string" ? { "*": input } : input

export const Info = InputSchema.pipe(
  Schema.decodeTo(InputObject, {
    decode: SchemaGetter.transform(normalizeInput),
    encode: SchemaGetter.passthrough({ strict: false }),
  }),
).annotate({ identifier: "PermissionConfig" })
type _Info = Schema.Schema.Type<typeof InputObject>
export type Info = { -readonly [K in keyof _Info]: _Info[K] }
