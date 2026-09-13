export * as ProviderPolicyMatcher from "./opencode-policy-matcher.js"

// Shared verbatim with OpenCode packages/util/src/opencode-policy-matcher.ts.
// Keep the paired conformance check passing when changing these semantics.
export type Statement = {
  readonly action: "provider.use"
  readonly resource: string
  readonly effect: "allow" | "deny"
}

export function match(input: string, pattern: string, windows: boolean) {
  const normalized = input.replaceAll("\\", "/")
  const escaped = pattern
    .replaceAll("\\", "/")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".")
  const expression = escaped.endsWith(" .*") ? escaped.slice(0, -3) + "( .*)?" : escaped
  return new RegExp("^" + expression + "$", windows ? "si" : "s").test(normalized)
}

export function evaluate(statements: readonly Statement[], resource: string, windows: boolean) {
  const index = statements.findLastIndex((statement) => match(resource, statement.resource, windows))
  return { effect: index === -1 ? ("inherit" as const) : statements[index]!.effect, index: index === -1 ? null : index }
}
