export * as Updater from "./index"

import type { WebContents } from "electron"
import { Context, Deferred, Effect, Exit, Fiber, Layer } from "effect"
import type { UpdaterState } from "@opencode/app/updater"
import { UpdaterStateChanged } from "../../shared/ipc-rpc/events"
import { emitIpcEvent } from "../ipc-events"

export type Platform = {
  readonly checkForUpdate: Effect.Effect<string | undefined, unknown>
  readonly stageUpdate: (options: { readonly differential: boolean }) => Effect.Effect<unknown, unknown>
  readonly installAndRestart: Effect.Effect<never, unknown>
  readonly dispose: () => void
}

export type Dependencies = {
  readonly currentVersion: string
  readonly platform?: Platform
  readonly prepareToRestart: Effect.Effect<void, unknown>
  readonly persistence: {
    readonly get: Effect.Effect<{ version: string } | undefined, unknown>
    readonly set: (value: { version: string }) => Effect.Effect<void, unknown>
    readonly clear: Effect.Effect<void, unknown>
  }
  readonly show?: (
    check: Effect.Effect<UpdaterState>,
    install: Effect.Effect<void, unknown>,
  ) => Effect.Effect<void, unknown>
}

export interface Interface {
  readonly subscribe: (sender: WebContents) => Effect.Effect<void>
  readonly unsubscribe: (id: number) => Effect.Effect<void>
  readonly check: Effect.Effect<UpdaterState>
  readonly install: Effect.Effect<void>
  readonly show: Effect.Effect<void>
  readonly state: Effect.Effect<UpdaterState>
  readonly started: Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("opencode/desktop/Updater") {}

export const layerWith = (dependencies: Dependencies) => Layer.effect(Service, make(dependencies))

export const make = Effect.fn("Updater.make")(function* (dependencies: Dependencies) {
  const runFork = Effect.runForkWith(yield* Effect.context())
  let state: UpdaterState = dependencies.platform ? { status: "idle" } : { status: "disabled" }
  let pending: Deferred.Deferred<UpdaterState> | undefined
  let installing: Deferred.Deferred<void, unknown> | undefined
  const listeners = new Set<(state: UpdaterState) => void>()
  const subscriptions = new Map<number, () => void>()
  const transition = (next: UpdaterState) => {
    runFork(Effect.logInfo("updater state changed", { from: state.status, to: next.status }))
    state = next
    listeners.forEach((listener) => listener(state))
    return state
  }
  // electron-updater builds NSIS deltas against the installer of the running version but reads the "old" blockmap from
  // the last download. Once a release is staged without installing, the two no longer match and every later delta fails
  // its checksum before falling back to a full download, so remember which release the cache holds and skip the attempt.
  let downloaded: string | undefined
  const stage = (platform: Platform, version: string) =>
    Effect.gen(function* () {
      if (downloaded)
        yield* Effect.logInfo("skipping differential download, updater cache is stale", {
          current: dependencies.currentVersion,
          staged: downloaded,
          version,
        })
      yield* platform.stageUpdate({ differential: !downloaded })
      downloaded = version
      yield* dependencies.persistence.set({ version })
    })
  const findAndStage = (platform: Platform) =>
    Effect.gen(function* () {
      yield* Effect.sync(() => transition({ status: "checking" }))
      const version = yield* platform.checkForUpdate
      if (!version || version === dependencies.currentVersion) {
        yield* dependencies.persistence.clear
        return transition({ status: "up-to-date" })
      }
      transition({ status: "downloading", version })
      yield* stage(platform, version)
      return transition({ status: "ready", version })
    }).pipe(
      Effect.catch((error) =>
        Effect.sync(() =>
          transition({ status: "error", message: error instanceof Error ? error.message : String(error) }),
        ),
      ),
    )
  const refreshStaged = (platform: Platform, staged: string) =>
    Effect.gen(function* () {
      const version = yield* platform.checkForUpdate
      if (!version || version === staged || version === dependencies.currentVersion) return state
      yield* stage(platform, version)
      return transition({ status: installing ? "installing" : "ready", version })
    }).pipe(
      Effect.catch((error) =>
        Effect.sync(() => {
          runFork(
            Effect.logWarning("updater refresh failed, keeping staged update", {
              staged,
              message: error instanceof Error ? error.message : String(error),
            }),
          )
          return state
        }),
      ),
    )
  const check = Effect.suspend(() => {
    const platform = dependencies.platform
    if (!platform || state.status === "installing") return Effect.succeed(state)
    if (pending) return Deferred.await(pending)
    const deferred = Deferred.makeUnsafe<UpdaterState>()
    pending = deferred
    return (state.status === "ready" ? refreshStaged(platform, state.version) : findAndStage(platform)).pipe(
      Effect.tap((result) => Deferred.succeed(deferred, result)),
      Effect.ensuring(Effect.sync(() => (pending = undefined))),
    )
  })
  const install = Effect.suspend(() => {
    if (installing) return Deferred.await(installing)
    const platform = dependencies.platform
    if (!platform || state.status !== "ready") return Effect.fail(new Error("Update is not ready to install"))
    const staged = state.version
    transition({ status: "installing", version: staged })
    const deferred = Deferred.makeUnsafe<void, unknown>()
    installing = deferred
    return Effect.gen(function* () {
      yield* pending ? Deferred.await(pending) : refreshStaged(platform, staged)
      yield* dependencies.prepareToRestart
      return yield* platform.installAndRestart
    }).pipe(
      Effect.exit,
      Effect.flatMap((exit) =>
        Deferred.done(deferred, exit).pipe(
          Effect.andThen(
            Effect.sync(() => {
              installing = undefined
              if (Exit.isFailure(exit) && state.status === "installing") {
                transition({ status: "ready", version: state.version })
              }
            }),
          ),
          Effect.andThen(Deferred.await(deferred)),
        ),
      ),
    )
  })
  const start = Effect.gen(function* () {
    const ready = yield* dependencies.persistence.get
    if (ready?.version === dependencies.currentVersion) yield* dependencies.persistence.clear
    // Any other persisted target was downloaded by an earlier launch and never installed, so its blockmap is cached.
    if (ready && ready.version !== dependencies.currentVersion) downloaded = ready.version
    yield* check
  })
  const unsubscribe = (id: number) => {
    subscriptions.get(id)?.()
    subscriptions.delete(id)
  }
  const starting = yield* start.pipe(Effect.forkScoped)
  yield* Effect.gen(function* () {
    yield* Effect.sleep("10 minutes")
    yield* check
  }).pipe(Effect.forever, Effect.forkScoped)
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      dependencies.platform?.dispose()
      subscriptions.forEach((dispose) => dispose())
      subscriptions.clear()
    }),
  )

  return Service.of({
    subscribe: (sender) =>
      Effect.sync(() => {
        const id = sender.id
        subscriptions.get(id)?.()
        subscriptions.set(
          id,
          (() => {
            const listener = (state: UpdaterState) => {
              if (sender.isDestroyed()) return unsubscribe(id)
              emitIpcEvent(sender, new UpdaterStateChanged({ state }))
            }
            listeners.add(listener)
            listener(state)
            return () => listeners.delete(listener)
          })(),
        )
        sender.once("destroyed", () => unsubscribe(id))
      }),
    unsubscribe: (id) => Effect.sync(() => unsubscribe(id)),
    check,
    install: install.pipe(Effect.orDie),
    show: dependencies.show ? dependencies.show(check, install).pipe(Effect.orDie) : Effect.void,
    state: Effect.sync(() => state),
    started: Fiber.join(starting).pipe(Effect.orDie),
  })
})
