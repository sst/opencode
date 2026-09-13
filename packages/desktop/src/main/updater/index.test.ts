import { afterEach, describe, expect, test } from "bun:test"
import { Effect, ManagedRuntime } from "effect"
import { type Dependencies, layerWith, Service } from "./index"

const dispose: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(dispose.splice(0).map((run) => run()))
})

// Drives the updater the way the app does: start or check, then install like a button click. `calls` records the platform
// operations in order; downloads record whether a differential download was allowed and installs record the staged
// version they would apply.
function setup(input?: {
  currentVersion?: string
  ready?: { version: string }
  latest?: () => string
  stage?: () => Promise<void>
  install?: () => Promise<never>
}) {
  const calls: string[] = []
  let ready = input?.ready
  const dependencies: Dependencies = {
    currentVersion: input?.currentVersion ?? "1.0.0",
    platform: {
      checkForUpdate: Effect.try({
        try: () => {
          calls.push("check")
          return input?.latest?.() ?? "2.0.0"
        },
        catch: (error) => error,
      }),
      stageUpdate: (options) =>
        Effect.tryPromise(async () => {
          calls.push(options.differential ? "download" : "download:full")
          await input?.stage?.()
        }),
      installAndRestart: Effect.suspend(() => {
        calls.push(`install:${ready?.version}`)
        return Effect.tryPromise({
          try: () => input?.install?.() ?? new Promise<never>(() => {}),
          catch: (error) => error,
        })
      }),
      dispose: () => {},
    },
    prepareToRestart: Effect.sync(() => {
      calls.push("prepare")
    }),
    persistence: {
      get: Effect.sync(() => ready),
      set: (value) =>
        Effect.sync(() => {
          ready = value
        }),
      clear: Effect.sync(() => {
        ready = undefined
      }),
    },
  }
  const runtime = ManagedRuntime.make(layerWith(dependencies))
  dispose.push(() => runtime.dispose())
  const run = <A, E>(effect: (updater: Service) => Effect.Effect<A, E>) =>
    runtime.runPromise(Service.pipe(Effect.flatMap(effect)))
  const updater = {
    start: () => run((updater) => updater.started),
    check: () => run((updater) => updater.check),
    install: () => run((updater) => updater.install),
    installFork: () => runtime.runFork(Service.pipe(Effect.flatMap((updater) => updater.install))),
    getState: () => run((updater) => updater.state),
  }
  return { updater, calls, getReady: () => ready }
}

describe("updater", () => {
  test("stages an update found at launch and shows it as ready", async () => {
    const app = setup()

    await app.updater.start()

    expect(app.calls).toEqual(["check", "download"])
    expect(await app.updater.getState()).toEqual({ status: "ready", version: "2.0.0" })
    expect(app.getReady()).toEqual({ version: "2.0.0" })
  })

  test("reports up to date and clears the record once the update is installed", async () => {
    const app = setup({ currentVersion: "2.0.0", ready: { version: "2.0.0" } })

    await app.updater.start()

    expect(await app.updater.getState()).toEqual({ status: "up-to-date" })
    expect(app.calls).toEqual(["check"])
    expect(app.getReady()).toBeUndefined()
  })

  test("revalidates a persisted target through the updater cache on launch without a differential download", async () => {
    const app = setup({ ready: { version: "2.0.0" } })

    await app.updater.start()

    expect(app.calls).toEqual(["check", "download:full"])
    expect(await app.updater.getState()).toEqual({ status: "ready", version: "2.0.0" })
  })

  test("keeps differential downloads after the persisted target was installed", async () => {
    const app = setup({ currentVersion: "2.0.0", ready: { version: "2.0.0" }, latest: () => "3.0.0" })

    await app.updater.start()

    expect(app.calls).toEqual(["check", "download"])
    expect(await app.updater.getState()).toEqual({ status: "ready", version: "3.0.0" })
    expect(app.getReady()).toEqual({ version: "3.0.0" })
  })

  test("downloads newer releases in full once one is staged", async () => {
    let latest = "2.0.0"
    const app = setup({ latest: () => latest })
    await app.updater.start()

    latest = "3.0.0"
    await app.updater.check()

    expect(app.calls).toEqual(["check", "download", "check", "download:full"])
    expect(await app.updater.getState()).toEqual({ status: "ready", version: "3.0.0" })
  })

  test("concurrent checks share one platform check", async () => {
    const app = setup()

    await Promise.all([app.updater.check(), app.updater.check(), app.updater.check()])

    expect(app.calls).toEqual(["check", "download"])
  })

  test("clicking install twice checks once and installs the staged version once", async () => {
    const app = setup()
    await app.updater.start()

    app.updater.installFork()
    app.updater.installFork()

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(app.calls).toEqual(["check", "download", "check", "prepare", "install:2.0.0"])
    expect(await app.updater.getState()).toEqual({ status: "installing", version: "2.0.0" })
  })

  test("ignores checks while an installation is in progress", async () => {
    const app = setup()
    await app.updater.start()
    app.updater.installFork()

    await app.updater.check()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(app.calls).toEqual(["check", "download", "check", "prepare", "install:2.0.0"])
  })

  test("clicking install downloads and installs a newer release", async () => {
    let latest = "2.0.0"
    const app = setup({ latest: () => latest })
    await app.updater.start()

    latest = "3.0.0"
    app.updater.installFork()

    expect(await app.updater.getState()).toEqual({ status: "installing", version: "2.0.0" })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(app.calls).toEqual(["check", "download", "check", "download:full", "prepare", "install:3.0.0"])
    expect(await app.updater.getState()).toEqual({ status: "installing", version: "3.0.0" })
  })

  test("clicking install uses the staged release when the final check fails", async () => {
    let offline = false
    const app = setup({
      latest: () => {
        if (offline) throw new Error("offline")
        return "2.0.0"
      },
    })
    await app.updater.start()

    offline = true
    app.updater.installFork()

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(app.calls).toEqual(["check", "download", "check", "prepare", "install:2.0.0"])
    expect(await app.updater.getState()).toEqual({ status: "installing", version: "2.0.0" })
  })

  test("later checks stay silent while ready and pick up newer versions", async () => {
    let latest = "2.0.0"
    const app = setup({ latest: () => latest })
    await app.updater.start()

    await app.updater.check()
    // Nothing new was published: the install button never hid.

    latest = "3.0.0"
    await app.updater.check()
    expect(await app.updater.getState()).toEqual({ status: "ready", version: "3.0.0" })
    expect(app.getReady()).toEqual({ version: "3.0.0" })
  })

  test("keeps the staged update installable when a silent re-check fails", async () => {
    let offline = false
    const app = setup({
      latest: () => {
        if (offline) throw new Error("offline")
        return "2.0.0"
      },
    })
    await app.updater.start()

    offline = true
    await app.updater.check()

    expect(await app.updater.getState()).toEqual({ status: "ready", version: "2.0.0" })
    expect(app.getReady()).toEqual({ version: "2.0.0" })
  })

  test("install during a silent refresh waits for the download, then installs the newer version", async () => {
    let latest = "2.0.0"
    let slowStage = false
    let releaseStage = () => {}
    const app = setup({
      latest: () => latest,
      stage: () => {
        if (!slowStage) return Promise.resolve()
        return new Promise<void>((resolve) => {
          releaseStage = resolve
        })
      },
    })
    await app.updater.start()

    latest = "3.0.0"
    slowStage = true
    const refresh = app.updater.check()
    await new Promise((resolve) => setTimeout(resolve, 0))

    app.updater.installFork()
    expect(await app.updater.getState()).toEqual({ status: "installing", version: "2.0.0" })

    releaseStage()
    await refresh
    expect(await app.updater.getState()).toEqual({ status: "installing", version: "3.0.0" })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(app.calls).toEqual(["check", "download", "check", "download:full", "prepare", "install:3.0.0"])
  })

  test("returns to ready after a failed installation and allows a retry", async () => {
    let attempts = 0
    const app = setup({
      install() {
        attempts++
        if (attempts === 1) return Promise.reject(new Error("install failed"))
        return new Promise<never>(() => {})
      },
    })
    await app.updater.start()

    await expect(app.updater.install()).rejects.toThrow("install failed")
    expect(await app.updater.getState()).toEqual({ status: "ready", version: "2.0.0" })

    app.updater.installFork()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(attempts).toBe(2)
    expect(await app.updater.getState()).toEqual({ status: "installing", version: "2.0.0" })
  })
})
