import { Context, Duration, Effect, Exit, Layer, LayerMap, MutableHashMap, Option } from "effect"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Instance } from "./instance.js"
import { Location } from "./location.js"
import { LocationServiceMap } from "./location-service-map.js"
import { Rpc } from "./rpc.js"

export { LocationServiceMap } from "./location-service-map.js"

export type LocationServices = Instance.Services
export type LocationError = Instance.Error

export function buildLocationServiceMap(
  replacements: LayerNode.Replacements = [],
): Layer.Layer<LocationServiceMap.Service> {
  return Layer.effect(
    LocationServiceMap.Service,
    Effect.gen(function* () {
      const owner = yield* Effect.scope
      const builds = MutableHashMap.empty<Location.Ref, { close?: Effect.Effect<void> }>()
      const inner: LayerMap.LayerMap<Location.Ref, LocationServices> = yield* LayerMap.make(
        (ref: Location.Ref) => {
          const build: { close?: Effect.Effect<void> } = {}
          MutableHashMap.set(builds, ref, build)
          return Layer.fromBuild((memoMap, scope) =>
            Effect.suspend(() =>
              Layer.buildWithMemoMap(Instance.layer(ref, { replacements: bindings }), memoMap, scope),
            ).pipe(
              Effect.onExit((exit) => {
                const finish = Effect.suspend(() => {
                  // An explicitly invalidated build must not evict its replacement.
                  if (Option.getOrUndefined(MutableHashMap.get(builds, ref)) !== build) return Effect.void
                  if (Exit.isSuccess(exit)) {
                    build.close = Context.get(exit.value, Rpc.Service).close
                    return Effect.void
                  }
                  MutableHashMap.remove(builds, ref)
                  // Evict once per failed build, before its result reaches borrowers.
                  return Exit.isFailure(exit) ? inner.invalidate(ref) : Effect.void
                })
                // With no borrowers, invalidation closes the entry's scope and
                // joins this lookup fiber. Let the owner finish that cleanup.
                return Exit.isFailure(exit)
                  ? finish.pipe(Effect.forkIn(owner, { startImmediately: true }), Effect.asVoid)
                  : finish
              }),
            ),
          )
        },
        // Retain healthy graphs. Boot failures, not local filesystem probes,
        // decide whether a location (including workspace placement) can retry.
        { idleTimeToLive: Duration.infinity },
      )
      const map = {
        ...inner,
        get: (ref: Location.Ref) => inner.get(LocationServiceMap.canonical(ref)),
        contextEffect: (ref: Location.Ref) => inner.contextEffect(LocationServiceMap.canonical(ref)),
        contextEffectOption: (ref: Location.Ref) => inner.contextEffectOption(LocationServiceMap.canonical(ref)),
        invalidate: (ref: Location.Ref) =>
          Effect.suspend(() => {
            const key = LocationServiceMap.canonical(ref)
            const build = Option.getOrUndefined(MutableHashMap.get(builds, key))
            MutableHashMap.remove(builds, key)
            // Detach routing first, then end pending RPCs that still borrow the old graph.
            // Do not await a boot here: failed/in-flight builds have their own cleanup path.
            return inner.invalidate(key).pipe(Effect.andThen(build?.close ?? Effect.void))
          }),
      }
      // Cached instances borrow their owner instead of retaining its Layer scope.
      const bindings: LayerNode.Replacements = [
        Instance.node.replace(
          Layer.succeed(Instance.Service, {
            provide: (session) => Effect.provide(map.get(session.location)),
          }),
        ),
        ...replacements,
        LocationServiceMap.node.replace(Layer.succeed(LocationServiceMap.Service, map)),
      ]
      return map
    }),
  )
}
