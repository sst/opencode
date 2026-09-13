import { expect, it } from "bun:test"
import { Schema } from "effect"
import { ProviderPolicyMatcher } from "../src/opencode-policy-matcher.js"

const cases = Schema.decodeUnknownSync(
  Schema.Array(
    Schema.Struct({
      name: Schema.String,
      rules: Schema.Array(
        Schema.Struct({
          action: Schema.Literal("provider.use"),
          effect: Schema.Literals(["allow", "deny"]),
          resource: Schema.String,
        }),
      ),
      resource: Schema.String,
      unix: Schema.Literals(["allow", "deny", "inherit"]),
      windows: Schema.Literals(["allow", "deny", "inherit"]),
      index: Schema.NullOr(Schema.Int),
    }),
  ),
)(await Bun.file(new URL("./opencode-policy-cases.json", import.meta.url)).json())

for (const scenario of cases) {
  it(scenario.name, () => {
    for (const windows of [false, true]) {
      const effect = windows ? scenario.windows : scenario.unix
      expect(ProviderPolicyMatcher.evaluate(scenario.rules, scenario.resource, windows)).toEqual({
        effect,
        index: effect === "inherit" ? null : scenario.index,
      })
    }
  })
}
