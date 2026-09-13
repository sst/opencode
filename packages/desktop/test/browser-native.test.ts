import { test, expect } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "node:os"

// Spawns a real Electron window; CI runners have no display for it.
test.skipIf(!!process.env.CI).each(["native", "idle"])(
  "browser %s suite over authenticated HTTP RPC with separate server and desktop storage",
  async (suite) => {
    const root = await mkdtemp(path.join(tmpdir(), "opencode-browser-suite-"))
    const output = await mkdtemp(path.resolve(import.meta.dir, "../node_modules/.browser-suite-"))
    const names = ["home", "config", "data", "cache", "state", "server-files", "client-files", "electron-data"]
    await Promise.all(names.map((name) => mkdir(path.join(root, name), { recursive: true })))
    const built = await Bun.build({
      entrypoints: [path.join(import.meta.dir, `browser/${suite}.ts`)],
      outdir: output,
      naming: "native.mjs",
      target: "node",
      format: "esm",
      external: ["electron", "lighthouse", "puppeteer-core"],
    })
    if (!built.success) throw new AggregateError(built.logs)
    const environment = {
      ...process.env,
      OPENCODE_TEST_HOME: path.join(root, "home"),
      OPENCODE_CONFIG_DIR: path.join(root, "config"),
      XDG_CONFIG_HOME: path.join(root, "config"),
      XDG_DATA_HOME: path.join(root, "data"),
      XDG_CACHE_HOME: path.join(root, "cache"),
      XDG_STATE_HOME: path.join(root, "state"),
      SMOKE_PASSWORD: crypto.randomUUID(),
      SMOKE_SERVER_FILES: path.join(root, "server-files"),
      SMOKE_ROOT: root,
      ELECTRON_RUN_AS_NODE: undefined,
    }
    const ready = Promise.withResolvers<string>()
    const server = Bun.spawn(
      [process.execPath, path.join(import.meta.dir, suite === "idle" ? "browser/idle-server.ts" : "browser/server.ts")],
      {
        cwd: root,
        env: { ...environment, TMP: path.join(root, "server-files"), TEMP: path.join(root, "server-files") },
        stdout: "inherit",
        stderr: "inherit",
        ipc(message: unknown) {
          if (typeof message === "string") ready.resolve(message)
        },
      },
    )
    void server.exited.then((code) => ready.reject(new Error(`Fixture server exited: ${code}`)))
    let native: ReturnType<typeof Bun.spawn> | undefined
    let proxy: Bun.Server<undefined> | undefined
    let tunnels = 0
    let rejectedStates = 0
    try {
      const url = await Promise.race([
        ready.promise,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Fixture server startup timed out")), 30_000).unref(),
        ),
      ])
      // Exercise the real HTTP boundary with delayed state acknowledgments, as on
      // a remote server. Neither endpoint can rely on synchronous UI/state updates.
      // The first inventory that carries a tab is rejected five times, an outage of almost
      // eight seconds: the desktop must keep resending until the server has it, or the
      // server never learns the tab exists.
      proxy = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        idleTimeout: 0,
        async fetch(request) {
          const incoming = new URL(request.url)
          if (incoming.pathname.endsWith("/tunnel.open")) tunnels++
          if (incoming.pathname.endsWith("/experimental.browser/state")) {
            if (rejectedStates < 5 && (await request.clone().text()).includes('"tab_')) {
              rejectedStates++
              return new Response(null, { status: 503 })
            }
            await new Promise((resolve) => setTimeout(resolve, 75))
          }
          return fetch(new Request(new URL(incoming.pathname + incoming.search, url), request), { decompress: false })
        },
      })
      const electron: unknown = (await import("electron")).default
      if (typeof electron !== "string") throw new Error("Electron binary path is unavailable.")
      native = Bun.spawn([electron, path.join(output, "native.mjs")], {
        cwd: output,
        env: {
          ...environment,
          SMOKE_URL: proxy.url.href,
          TMP: path.join(root, "client-files"),
          TEMP: path.join(root, "client-files"),
        },
        stdout: "inherit",
        stderr: "inherit",
      })
      expect(
        await Promise.race([
          native.exited,
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("Native browser suite timed out")), 140_000).unref(),
          ),
        ]),
      ).toBe(0)
      expect(tunnels).toBeGreaterThan(0)
      expect(rejectedStates).toBe(5)
    } finally {
      if (native?.exitCode === null) {
        native.kill()
        await native.exited
      }
      if (server.exitCode === null) server.send("stop")
      proxy?.stop(true)
      await Promise.race([
        server.exited,
        new Promise<void>((resolve) =>
          setTimeout(() => {
            if (server.exitCode === null) server.kill()
            resolve()
          }, 10_000).unref(),
        ),
      ])
      await Promise.all([rm(root, { recursive: true, force: true }), rm(output, { recursive: true, force: true })])
    }
  },
  180_000,
)
