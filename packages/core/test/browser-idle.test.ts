import { expect } from "bun:test"
import { Context, Deferred, Effect, Fiber, RcMap, Stream } from "effect"
import { Browser } from "@opencode/plugin-browser/rpc"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { Global } from "@opencode/util/global"
import { Bus } from "@opencode/core/bus"
import { Database } from "@opencode/core/database/database"
import { Location } from "@opencode/core/location"
import { LocationActivity } from "@opencode/core/location-activity"
import { LocationServiceMap } from "@opencode/core/location-services"
import { Plugin } from "@opencode/core/plugin"
import { Rpc } from "@opencode/core/rpc"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionExecution } from "@opencode/core/session/execution"
import { SessionStore } from "@opencode/core/session/store"
import { tempGlobalLayer } from "./fixture/global"
import { offlineModels } from "./fixture/models"
import { tmpdirScoped } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, Bus.node, Session.node, LocationServiceMap.node, LocationActivity.node]),
    [
      Global.node.replace(tempGlobalLayer),
      offlineModels,
      LocationActivity.node.replace(
        makeGlobalNode({
          service: LocationActivity.Service,
          layer: LocationActivity.layer({ timeToLive: "2 seconds", sweepInterval: "100 millis" }),
          deps: [Bus.node, LocationServiceMap.node, SessionExecution.node, SessionStore.node],
        }),
      ),
    ],
  ),
)

it.live(
  "idle eviction ends the browser attachment and permits a fresh attachment",
  () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const ref = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
      const locations = yield* LocationServiceMap.Service
      const context = yield* locations.contextEffect(ref).pipe(Effect.scoped)
      yield* Plugin.awaitActivation.pipe(Effect.provideContext(context))
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ location: ref })
      const rpc = Context.get(context, Rpc.Service).client(Browser.Definition)
      const attachment = { sessionID: session.id, connectionID: crypto.randomUUID() }
      const attached = yield* Deferred.make<void>()
      yield* rpc.events.subscribe("control").pipe(
        Stream.runForEach((event) =>
          event.data.type === "attached" ? Deferred.succeed(attached, undefined) : Effect.void,
        ),
        Effect.forkScoped({ startImmediately: true }),
      )
      const pending = yield* rpc
        .attach({ ...attachment, version: 4 })
        .pipe(Effect.provide(locations.get(ref)), Effect.flip, Effect.forkScoped)
      yield* Deferred.await(attached)
      const state = { ...attachment, state: { tabs: [], focusedTabID: null } }
      yield* rpc.state(state)

      // Real idle cleanup must end the long-lived request, not leave a second registry behind it.
      expect(yield* Fiber.join(pending).pipe(Effect.timeout("10 seconds"))).toMatchObject({ type: "rpc.unavailable" })
      expect(yield* RcMap.has(locations.rcMap, LocationServiceMap.canonical(ref))).toBe(false)
      expect(yield* rpc.state(state).pipe(Effect.flip)).toMatchObject({ type: "rpc.unavailable" })

      const replacement = yield* locations.contextEffect(ref)
      yield* Plugin.awaitActivation.pipe(Effect.provideContext(replacement))
      const fresh = Context.get(replacement, Rpc.Service).client(Browser.Definition)
      const restored = yield* Deferred.make<void>()
      yield* fresh.events.subscribe("control").pipe(
        Stream.runForEach((event) =>
          event.data.type === "attached" ? Deferred.succeed(restored, undefined) : Effect.void,
        ),
        Effect.forkScoped({ startImmediately: true }),
      )
      const resumed = yield* fresh.attach({ ...attachment, version: 4 }).pipe(Effect.forkScoped)
      yield* Deferred.await(restored)
      yield* fresh.state(state)
      expect(resumed.pollUnsafe()).toBeUndefined()
      yield* Fiber.interrupt(resumed)
    }),
  30_000,
)
