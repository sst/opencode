# Provider Policy

Status: **Implemented, including paired Console managed-policy support in the working tree.** Release and deployment are separate; this spec does not name a minimum released client version.

## Purpose

Policies control whether an operation on a named resource is allowed. Statements come from authored configuration and, while connected to Console, an authenticated managed response. A core policy service enforces the combined result at catalog reads and model resolution.

The first policy consumer is provider availability:

```text
action:   provider.use
resource: provider ID, such as openai or company-ai
```

Provider configuration and provider policy remain separate:

- `providers` describes endpoints, options, and model overrides.
- `experimental.policies` determines whether an operation using a provider is allowed.

A provider can be correctly configured and have valid credentials while policy still denies its use.

## Goals

- Replace legacy `enabled_providers` and `disabled_providers`.
- Keep the default experience unchanged when users specify no policy.
- Support wildcard matching for provider-ID resources.
- Support the literal `provider.use` action; other actions require separate implementation.
- Let user policy override repository policy, and organization-managed policy override both.
- Keep evaluation simple: matching statements are applied in order and the last match wins.

## Non-Goals

- Policies do not configure endpoints, credentials, models, or provider options.
- Policies do not make unusable resources usable.
- Policies do not currently provide conditions, principals, approval prompts, or enforced configuration values.
- Policies do not pin a provider's endpoint, require gateway routing, enroll devices, sandbox arbitrary executable plugins, or cancel in-flight requests.

## Statement Shape

```jsonc
{
  "experimental": {
    "policies": [
      {
        "effect": "deny",
        "action": "provider.use",
        "resource": "openai",
      },
    ],
  },
}
```

```ts
interface PolicyInfo {
  effect: "allow" | "deny"
  action: "provider.use"
  resource: string
}
```

`ConfigPolicy` owns the statement schema. `ProviderPolicy` interprets it outside the removable plugin registry. Managed responses validate the complete policy strictly: unknown fields/actions/effects, empty or untrimmed resources, and resources over 256 characters are invalid. Console allows up to 100 custom statements; generated presets may have more.

## Matching

The action must be exactly `provider.use`; `provider.*` is invalid. Resources use anchored `*` (zero or more characters) and `?` (one character) wildcards. Backslashes normalize to slashes. Windows matches case-insensitively; macOS and Linux match case-sensitively. Matching retains the existing optional trailing ` *` behavior. Patterns are not regular expressions or IAM resource names.

Examples:

| Action         | Resource    | Matches                                                   |
| -------------- | ----------- | --------------------------------------------------------- |
| `provider.use` | `openai`    | Only use of provider ID `openai`                          |
| `provider.use` | `company-*` | Use of provider IDs such as `company-us` and `company-eu` |
| `provider.use` | `*`         | Every provider ID                                         |

No pattern-specific precedence exists. A specific resource does not automatically beat a wildcard resource. Written/evaluation order controls the result.

## Evaluation

To evaluate an operation and resource:

1. Start with `allow`.
2. Consider every `provider.use` statement whose resource matches the provider ID.
3. Each matching statement replaces the current decision with its `effect`.
4. The last matching statement determines the result.

Conceptually:

```ts
const decision = ProviderPolicyMatcher.evaluate(statements, providerID, process.platform === "win32")
const allowed = decision.effect !== "deny"
```

The pure matcher returns `allow`, `deny`, or `inherit`, plus the winning statement index. `inherit` permits otherwise usable providers. An active Console connection without a valid compatible managed snapshot is separately gated as unavailable; it never falls back to unrestricted provider use.

## Ordering Within One Config Document

Statements remain in the order written by the user.

To deny all providers except Anthropic:

```jsonc
{
  "experimental": {
    "policies": [
      {
        "effect": "deny",
        "action": "provider.use",
        "resource": "*",
      },
      {
        "effect": "allow",
        "action": "provider.use",
        "resource": "anthropic",
      },
    ],
  },
}
```

Result:

```text
provider.use / anthropic -> allow
provider.use / openai    -> deny
```

To allow internal providers except experimental ones:

```jsonc
{
  "experimental": {
    "policies": [
      { "effect": "deny", "action": "provider.use", "resource": "*" },
      { "effect": "allow", "action": "provider.use", "resource": "company-*" },
      { "effect": "deny", "action": "provider.use", "resource": "company-experimental-*" },
    ],
  },
}
```

Result:

```text
company-stable: allowed
company-experimental-fast: denied
openai: denied
```

## Ordering Across Authored Config Documents

Ordinary settings and policies have different precedence needs:

- Ordinary settings are read forward, so location-specific settings override user-global settings.
- Policies are read by reversing authored config documents, so user-global policy can override repository policy.
- Statements inside each document keep their written order.

At minimum, this means a repository cannot silently re-enable something the user denied globally.

Project config:

```jsonc
{
  "experimental": {
    "policies": [{ "effect": "allow", "action": "provider.use", "resource": "openai" }],
  },
}
```

User-global config:

```jsonc
{
  "experimental": {
    "policies": [{ "effect": "deny", "action": "provider.use", "resource": "openai" }],
  },
}
```

Result:

```text
provider.use / openai -> deny
```

The relative policy precedence of direct project files and `.opencode` files is intentionally deferred until `.opencode` configuration is reviewed.

## Organization-Managed Policy

Organization-managed policy is not ordinary authored config. Managed statements append after the reversed authored statements, before a single final evaluation. This lets an organization allow override a user deny without trying to resurrect a provider already removed by an earlier policy filter.

```text
repository policy -> user-global policy -> organization-managed policy
```

Plugins must not be allowed to add, remove, or override policy statements. Plugins can contribute functionality or configured providers; policy determines whether opencode permits an operation through its managed execution paths.

The built-in `opencode.provider.opencode` loader remains active under ordinary removal selectors such as `-*`, `-opencode.*`, and `-opencode.provider.opencode`. The policy service is not a removable plugin, and policy mutation is not exposed through the plugin context API. Late catalog transforms still pass through policy checks when read.

Provider policy is not a full sandbox for executable plugins. A denied provider must not be usable through the normal provider/model path, but arbitrary plugin code requires separate governance if that becomes a compliance requirement.

### Console contract

The authenticated `GET /api/v2/config` response includes providers and required managed fields:

```json
{
  "providers": {},
  "experimental": { "policies": [] },
  "managedPolicy": {
    "schemaVersion": 1,
    "workspaceID": "org_example",
    "revision": 7
  }
}
```

The loader validates the policy without silently dropping unsupported fields. Trust comes from the authenticated loader and active connection, not the presence of a descriptor in a local file. Policy and provider data are applied from the same validated response. The descriptor identifies the saved authoring revision; generated preset output can also change when Console connections change. Refresh compares the whole snapshot, not only the revision.

Console offers default access, only workspace provider IDs, and custom ordered rules. Default access denies `opencode` when Console emits no connection with that ID. Managed-only denies `*` then allows each exact emitted ID. Custom `[]` explicitly removes organization overrides. Custom mode replaces the legacy v1 managed-only setting; it is not converted to v1 rules.

An org that has never published policies still receives a valid revision-zero descriptor and rules derived from its existing provider settings, even with Console's publication flag disabled. The client accepts defaults without requiring administrator setup. The current client nevertheless requires a valid response for every connected org: a cold-start outage or old server blocks even a policy-free org because its policy state is not yet known. There is no persisted opt-in exemption before that first fetch.

### Connection and failure behavior

- Disconnected: apply authored local rules.
- Connected before a valid compatible snapshot: block all normal provider/model resolution, including local providers, with an actionable policy-unavailable error.
- Valid response: apply managed rules after local rules.
- Same-identity transient refresh failure (network, timeout, 429, or 5xx): retain the last validated in-memory snapshot and mark it stale internally.
- Missing, malformed, unsupported, wrong-workspace, or authorization-rejected response: mark policy unavailable. Failure never means an empty policy.
- Server, workspace, or service-key switch: require a valid snapshot for the new identity. Never carry the previous identity's rules forward.
- Valid explicit `[]`: clear organization overrides; local rules remain.

Binding includes connection identity, server, selected organization metadata, and the service key where applicable. The response workspace must match organization metadata when present. OAuth access-token refresh does not change this identity. The raw binding stays internal and must never be logged or exposed.

The existing loader polls every ten minutes and refreshes on connection changes. There is no durable offline cache, fleet acknowledgment, or in-flight revocation. Disconnecting Console leaves the scope of this feature.

Deploy Console's required response contract first, release the compatible client next, then enable Console's `opencode-policies` publication flag. A new client connected to an old server intentionally blocks. Older clients may ignore the fields; do not claim enforcement for them. Turning off publication does not remove an already published policy.

## Interaction With Provider Configuration

```jsonc
{
  "providers": {
    "company-ai": {
      "package": "@opencode/ai/providers/openai",
      "settings": { "baseURL": "https://ai.company.example/v1" },
    },
  },
  "experimental": {
    "policies": [
      { "effect": "deny", "action": "provider.use", "resource": "*" },
      { "effect": "allow", "action": "provider.use", "resource": "company-ai" },
    ],
  },
}
```

The provider entry configures `company-ai`; the policy statements make that ID the only provider permitted for use. Credentials and models are still required. Local provider overlays may change an allowed ID's package, endpoint, or other transport fields; a provider-ID allowlist is not endpoint enforcement.

Provider policy applies regardless of how a provider becomes known or usable, including:

- models.dev catalog data
- environment credentials
- saved accounts
- built-in provider plugins
- explicit provider configuration

## Applying Provider Policy

Provider records and model overrides remain in the underlying catalog. Public reads check policy so later provider loading cannot bypass filtering, while a later valid allow can expose an otherwise usable provider again.

Flow:

1. Build provider/model catalog entries.
2. Apply configured provider and model overrides.
3. Read one policy snapshot containing reversed authored rules followed by managed rules.
4. Filter all public provider/model catalog views using the final decision.
5. Assert policy again at model resolution, including resolution of a previously selected model value.

Config updates publish catalog-updated events. Managed refresh updates the policy snapshot before rebuilding catalog/search projections. Session errors distinguish denied/unavailable policy in their messages while using the existing error protocol.

The pure matcher and fixtures are duplicated in Console's shared package and this repository's util package. Console's `scripts/check-opencode-policy-conformance.ts` verifies byte-for-byte equality. Tests cover precedence, platform matching, catalog views, previously selected model resolution, loader protection, failure transitions, and identity changes. An opt-in paired integration test consumes a policy published through Console's real browser/API/database flow. These checks do not establish deployed fleet behavior or successful billable provider requests.

## Legacy Migration

Legacy deny list:

```jsonc
{
  "disabled_providers": ["openai", "google"],
}
```

Equivalent v2 policy:

```jsonc
{
  "experimental": {
    "policies": [
      { "effect": "deny", "action": "provider.use", "resource": "openai" },
      { "effect": "deny", "action": "provider.use", "resource": "google" },
    ],
  },
}
```

Legacy allowlist:

```jsonc
{
  "enabled_providers": ["anthropic", "openai"],
}
```

Equivalent v2 policy:

```jsonc
{
  "experimental": {
    "policies": [
      { "effect": "deny", "action": "provider.use", "resource": "*" },
      { "effect": "allow", "action": "provider.use", "resource": "anthropic" },
      { "effect": "allow", "action": "provider.use", "resource": "openai" },
    ],
  },
}
```
