import { describe, expect } from "bun:test"
import { Catalog } from "@opencode/core/catalog"
import { Credential } from "@opencode/core/credential"
import { Integration } from "@opencode/core/integration"
import { Plugin } from "@opencode/core/plugin"
import { PluginHost } from "@opencode/core/plugin/host"
import { OpencodePlugin } from "@opencode/core/plugin/provider/opencode"
import { Provider } from "@opencode/core/provider"
import { ProviderPolicy } from "@opencode/core/provider-policy"
import { Effect } from "effect"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const it = testEffect(PluginTestLayer)

// Run from Console's policy E2E with a freshly issued local service-account key.
describe.skipIf(!process.env.OPENCODE_CONSOLE_POLICY_URL)("Published Console policy", () => {
  it.live("loads the real managed config and enforces the policy published in the browser", () =>
    Effect.gen(function* () {
      const credentials = yield* Credential.Service
      const catalog = yield* Catalog.Service
      const policies = yield* ProviderPolicy.Service
      yield* catalog.transform((editor) => {
        editor.provider.update(Provider.ID.openai, () => {})
        editor.provider.update(Provider.ID.make("company-prod"), () => {})
      })
      yield* credentials.create({
        integrationID: Integration.ID.make("opencode"),
        value: Credential.Key.make({
          type: "key",
          key: process.env.OPENCODE_CONSOLE_POLICY_KEY!,
          metadata: {
            server: process.env.OPENCODE_CONSOLE_POLICY_URL!,
            orgID: process.env.OPENCODE_CONSOLE_POLICY_ORG!,
          },
        }),
      })
      const plugin = yield* Plugin.Service
      const host = yield* PluginHost.make(plugin)
      yield* OpencodePlugin.effect(host)
      expect(yield* policies.read()).toMatchObject({
        status: "ready",
        workspaceID: process.env.OPENCODE_CONSOLE_POLICY_ORG,
        revision: 1,
      })
      expect(yield* catalog.provider.get(Provider.ID.openai)).toBeUndefined()
      expect(yield* catalog.provider.get(Provider.ID.make("company-prod"))).toBeDefined()
      expect(yield* policies.assert("openai").pipe(Effect.flip)).toBeInstanceOf(ProviderPolicy.Denied)
    }),
  )
})
