export * as ProviderPolicy from "./provider-policy.js"

import { ConfigPolicy } from "@opencode/schema/config/policy"
import { Event } from "@opencode/schema/config"
import { Catalog } from "@opencode/schema/catalog"
import { ProviderPolicyMatcher } from "@opencode/util/opencode-policy-matcher"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { Context, Effect, Layer, Schema, Stream } from "effect"
import { Bus } from "./bus.js"
import { Config } from "./config.js"
import { Credential } from "./credential.js"
import { Integration } from "./integration.js"
import { IntegrationConnection } from "./integration/connection.js"

export class Unavailable extends Schema.TaggedError<Unavailable>()("ProviderPolicy.Unavailable", {}) {
  override get message() {
    return "Workspace policy unavailable. Reconnect to OpenCode Console and try again."
  }
}
export class Denied extends Schema.TaggedError<Denied>()("ProviderPolicy.Denied", { providerID: Schema.String }) {
  override get message() {
    return `Provider ${this.providerID} is denied by your OpenCode provider policy.`
  }
}

export const Descriptor = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  workspaceID: Schema.String.check(Schema.isNonEmpty()),
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
})

export type Managed = {
  readonly identity: string
  readonly descriptor: typeof Descriptor.Type
  readonly statements: readonly ConfigPolicy.Info[]
  readonly stale: boolean
}
export type Snapshot = {
  readonly status: "disconnected" | "ready" | "stale" | "unavailable"
  readonly statements: readonly ConfigPolicy.Info[]
  readonly workspaceID?: string
  readonly revision?: number
}
export interface Interface {
  readonly read: () => Effect.Effect<Snapshot>
  readonly set: (value: Managed | undefined) => Effect.Effect<void>
  readonly assert: (providerID?: string) => Effect.Effect<void, Unavailable | Denied>
}
export class Service extends Context.Service<Service, Interface>()("@opencode/ProviderPolicy") {}

// Internal connection binding; this value can contain a service key and must never be logged or exposed.
export function identity(
  connection: Pick<IntegrationConnection.Info, "type"> & { readonly id?: string; readonly name?: string },
  credential: Credential.Value,
) {
  return JSON.stringify([
    connection.type,
    connection.id ?? connection.name,
    credential.metadata?.server ?? "https://opencode.ai/console",
    credential.metadata?.orgID,
    credential.type === "key" ? credential.key : undefined,
  ])
}

export function allows(snapshot: Snapshot, providerID: string) {
  return (
    snapshot.status !== "unavailable" &&
    ProviderPolicyMatcher.evaluate(snapshot.statements, providerID, process.platform === "win32").effect !== "deny"
  )
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const integrations = yield* Integration.Service
    const credentials = yield* Credential.Service
    const bus = yield* Bus.Service
    let managed: Managed | undefined
    const read = Effect.fn("ProviderPolicy.read")(function* () {
      const statements = (yield* config.entries())
        .filter((entry) => entry.type === "document")
        .toReversed()
        .flatMap((entry) => entry.info.experimental?.policies ?? [])
      const connection = yield* integrations.connection.active(Integration.ID.make("opencode"))
      if (!connection) return { status: "disconnected", statements } as const
      const credential =
        connection.type === "credential"
          ? (yield* credentials.get(connection.id))?.value
          : process.env[connection.name]
            ? Credential.Key.make({ type: "key", key: process.env[connection.name]! })
            : undefined
      if (!credential || !managed || managed.identity !== identity(connection, credential))
        return { status: "unavailable", statements } as const
      return {
        status: managed.stale ? "stale" : "ready",
        statements: [...statements, ...managed.statements],
        workspaceID: managed.descriptor.workspaceID,
        revision: managed.descriptor.revision,
      } as const
    })
    yield* bus.subscribe(Event.Updated).pipe(
      Stream.runForEach(() => bus.publish(Catalog.Event.Updated, {})),
      Effect.forkScoped({ startImmediately: true }),
    )
    return Service.of({
      read,
      set: (value) =>
        Effect.sync(() => {
          managed = value
        }),
      assert: Effect.fn("ProviderPolicy.assert")(function* (providerID) {
        const snapshot = yield* read()
        if (snapshot.status === "unavailable") return yield* new Unavailable()
        if (providerID !== undefined && !allows(snapshot, providerID)) return yield* new Denied({ providerID })
      }),
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Config.node, Integration.node, Credential.node, Bus.node],
})
