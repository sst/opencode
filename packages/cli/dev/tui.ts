import { createRequire } from "node:module"
import path from "node:path"
import { Effect, Exit, Fiber } from "effect"
import { createRunnableDevEnvironment, createServer, isRunnableDevEnvironment } from "vite"
import solid from "vite-plugin-solid"
import refresh from "solid-refresh/babel"
import { host, type Run } from "./host.js"

const require = createRequire(import.meta.url)

export const run: Run = Effect.fn("Tui.vite")(function* (input: Parameters<Run>[0]) {
  const fork = Effect.runForkWith(yield* Effect.context<Effect.Services<ReturnType<Run>>>())
  const finished = Promise.withResolvers<Exit.Exit<void, unknown>>()
  let initial = true
  let recoverable = false
  host.route = undefined
  host.settle = () => {
    recoverable = false
  }
  host.stop = async () => {
    const fiber = host.active
    host.active = undefined
    if (fiber) await Effect.runPromise(Fiber.interrupt(fiber))
  }
  host.mount = async (app) => {
    await host.stop?.()
    const fiber = fork(
      app({
        ...input,
        args: initial
          ? input.args
          : { ...input.args, prompt: undefined, sessionID: undefined, continue: false, fork: false },
        terminalHandoff: initial ? input.terminalHandoff : undefined,
      }),
    )
    initial = false
    host.active = fiber
    fiber.addObserver((exit) => {
      if (host.active !== fiber) return
      host.active = undefined
      finished.resolve(exit)
    })
  }

  const server = yield* Effect.acquireRelease(
    Effect.tryPromise(() =>
      createServer({
        root: path.resolve(import.meta.dirname, "../../tui"),
        configFile: false,
        appType: "custom",
        clearScreen: false,
        logLevel: "error",
        server: { middlewareMode: true, ws: false },
        resolve: {
          alias: [
            { find: /^solid-js(?:\/dist\/solid.js)?$/, replacement: require.resolve("solid-js/dist/dev.js") },
            {
              find: /^solid-js\/store(?:\/dist\/store.js)?$/,
              replacement: require.resolve("solid-js/store/dist/dev.js"),
            },
          ],
        },
        plugins: [
          {
            name: "tui-refresh-boundaries",
            enforce: "pre",
            async resolveId(source, importer) {
              if (importer === path.join(import.meta.dirname, "route.tsx")) return
              if (!source.endsWith("/route") && !source.endsWith("/route.tsx")) return
              const resolved = await this.resolve(source, importer, { skipSelf: true })
              if (resolved?.id === path.resolve(import.meta.dirname, "../../tui/src/context/route.tsx"))
                return path.join(import.meta.dirname, "route.tsx")
            },
            load(id) {
              if (id === "/@solid-refresh")
                return `export * from ${JSON.stringify(path.join(import.meta.dirname, "refresh.ts"))}`
            },
          },
          solid({
            hot: false,
            dev: true,
            solid: { generate: "universal", moduleName: "@opentui/solid" },
            // Enable the existing refresh plugin in Vite's non-browser environment.
            babel: { plugins: [[refresh, { bundler: "vite" }]] },
          }),
          {
            name: "tui-recovery",
            hotUpdate() {
              if (this.environment.name !== "native") return
              recoverable = Boolean(host.active)
              if (host.active) return
              this.environment.moduleGraph.invalidateAll()
              this.environment.hot.send({ type: "full-reload" })
              return []
            },
          },
        ],
        environments: {
          native: {
            consumer: "server",
            resolve: {
              conditions: ["bun", "development", "module"],
              externalConditions: ["bun", "node"],
              noExternal: [
                "solid-js",
                "solid-refresh",
                "@opentui/solid",
                "@opentui/keymap",
                "opentui-spinner",
                /^@solid-primitives\//,
                "@opencode/plugin",
                "@opencode/client",
                "@opencode/latex",
                "@opencode/merman",
              ],
              // Exact subpaths are needed for workspace TypeScript exports.
              external: [
                "@opentui/core",
                "@opentui/core/testing",
                "effect",
                "@opencode/cli/vite-host",
                "@opencode/client",
                "@opencode/client/effect/service",
                "@opencode/client/promise",
                "@opencode/core/util/slug",
                "@opencode/schema",
                "@opencode/schema/event",
                "@opencode/schema/project",
                "@opencode/schema/session-id",
                "@opencode/schema/session-inbox",
                "@opencode/schema/session-message",
                "@opencode/schema/skill",
                "@opencode/schema/token-usage",
                "@opencode/schema/vcs",
                "@opencode/schema/worktree",
                "@opencode/simulation/frontend",
                "@opencode/simulation/protocol",
                "@opencode/theme/tui",
                "@opencode/theme/tui/v1",
                "@opencode/util/activity-calendar",
                "@opencode/util/flock",
                "@opencode/util/global",
                "@opencode/util/hash",
                "@opencode/util/session-title-fallback",
              ],
            },
            optimizeDeps: { noDiscovery: true, include: [] },
            dev: {
              createEnvironment: (name, config) =>
                createRunnableDevEnvironment(name, config, {
                  runnerOptions: {
                    sourcemapInterceptor: false,
                    hmr: { logger: { debug() {}, error: (error) => console.error(error) } },
                  },
                }),
            },
          },
        },
      }),
    ),
    (server) =>
      Effect.promise(async () => {
        await host.stop?.()
        await server.close()
      }),
  )
  const environment = server.environments.native
  if (!isRunnableDevEnvironment(environment)) return yield* Effect.die(new Error("Expected a runnable environment"))
  host.reset = () => {
    recoverable = false
    environment.runner.clearCache()
  }
  host.recover = () => {
    if (!recoverable) return false
    recoverable = false
    queueMicrotask(() => {
      input.log?.("warn", "TUI hot update failed; reloading", {})
      environment.moduleGraph.invalidateAll()
      environment.hot.send({ type: "full-reload" })
    })
    return true
  }
  yield* Effect.promise(() =>
    environment.runner.import(path.join(import.meta.dirname, "entry.ts")).catch(console.error),
  )
  const exit = yield* Effect.promise(() => finished.promise)
  if (Exit.isFailure(exit)) return yield* Effect.failCause(exit.cause)
}, Effect.scoped)
