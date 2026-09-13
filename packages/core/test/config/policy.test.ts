import { describe, expect } from "bun:test"
import { Document, Event, Info, type Entry } from "@opencode/schema/config"
import { Catalog } from "@opencode/core/catalog"
import { Config } from "@opencode/core/config"
import { Bus } from "@opencode/core/bus"
import { Provider } from "@opencode/core/provider"
import { Effect, Schema } from "effect"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "../plugin/fixture"

const it = testEffect(PluginTestLayer)
const decode = Schema.decodeUnknownSync(Info)

const policies = (...items: { effect: "allow" | "deny"; resource: string }[]) =>
  new Document({
    type: "document",
    info: decode({
      experimental: {
        policies: items.map((item) => ({ action: "provider.use", ...item })),
      },
    }),
  })

const setEntries = Effect.fn(function* (entries: Entry[]) {
  const config = yield* Config.Service
  const current = yield* config.entries()
  current.splice(0, current.length, ...entries)
})

describe("Provider policy catalog boundary", () => {
  it.effect("filters plugin-provided providers with ordered wildcard policies", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      yield* catalog.transform((catalog) => {
        catalog.provider.update(Provider.ID.openai, () => {})
        catalog.provider.update(Provider.ID.anthropic, () => {})
        catalog.provider.update(Provider.ID.make("company-internal"), () => {})
      })
      yield* setEntries([
        policies(
          { effect: "deny", resource: "*" },
          { effect: "allow", resource: "anthropic" },
          { effect: "allow", resource: "company-*" },
        ),
      ])

      expect(yield* catalog.provider.get(Provider.ID.openai)).toBeUndefined()
      expect(yield* catalog.provider.get(Provider.ID.anthropic)).toBeDefined()
      expect(yield* catalog.provider.get(Provider.ID.make("company-internal"))).toBeDefined()
    }),
  )

  it.effect("prevents project policy from overriding user-global policy", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      yield* catalog.transform((catalog) => catalog.provider.update(Provider.ID.openai, () => {}))
      yield* setEntries([
        policies({ effect: "deny", resource: "openai" }),
        policies({ effect: "allow", resource: "openai" }),
      ])

      expect(yield* catalog.provider.get(Provider.ID.openai)).toBeUndefined()
    }),
  )

  it.live("reloads changed policies", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const bus = yield* Bus.Service
      yield* catalog.transform((catalog) => catalog.provider.update(Provider.ID.openai, () => {}))
      yield* setEntries([policies({ effect: "deny", resource: "openai" })])
      expect(yield* catalog.provider.get(Provider.ID.openai)).toBeUndefined()

      yield* setEntries([policies({ effect: "allow", resource: "openai" })])
      yield* bus.publish(Event.Updated, {})
      yield* waitUntil(catalog.provider.get(Provider.ID.openai).pipe(Effect.map((provider) => provider !== undefined)))
    }),
  )
})

const waitUntil = Effect.fnUntraced(function* (condition: Effect.Effect<boolean>) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (yield* condition) return
    yield* Effect.sleep("10 millis")
  }
  return yield* Effect.die("Timed out waiting for policy reload")
})
