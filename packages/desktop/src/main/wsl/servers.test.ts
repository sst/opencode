import { expect, test } from "bun:test"
import type { WslServerConfig } from "@opencode/app/wsl/types"
import { Effect, FileSystem, Path } from "effect"
import { NodeServices } from "@effect/platform-node"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { testEffect } from "../../../../core/test/lib/effect"
import { wslCliInstallCommand } from "./runtime"
import { createWslServersController } from "./servers"

type ControllerOptions = Parameters<typeof createWslServersController>[0]

let persistedServers: WslServerConfig[] = []

const it = testEffect(NodeServices.layer)
// Execute the Linux-side installer fixture locally rather than requiring a WSL distro.
const posix = process.platform === "win32" ? it.live.skip : it.live

posix(
  "installs a local build through the managed installer, including shell PATH setup",
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "wsl-cli-install-" })
    const binary = path.join(dir, "local build ' cli")
    yield* fs.writeFileString(binary, "#!/bin/sh\nprintf 'OpenCode v0.0.0-dev-16365\\n'\n", { mode: 0o755 })
    yield* fs.writeFileString(path.join(dir, ".bashrc"), "# existing config\n")
    yield* fs.writeFileString(path.join(dir, "installer"), yield* fs.readFileString(path.resolve("../../install")))
    yield* fs.writeFileString(path.join(dir, "curl"), '#!/bin/sh\ncat "$HOME/installer"\n', { mode: 0o755 })
    yield* fs.writeFileString(
      path.join(dir, "wslpath"),
      '#!/bin/sh\n[ "$1" = "-a" ] || exit 1\nprintf "%s" "$2" > "$HOME/wslpath-input"\nprintf "%s\\n" "$LOCAL_BINARY"\n',
      { mode: 0o755 },
    )
    const windows = "C:\\local build's\\opencode"
    const command = wslCliInstallCommand({ version: "0.0.0-dev-16365", binary: windows })
    expect(
      yield* spawner.exitCode(
        ChildProcess.make("bash", ["-c", command], {
          env: { HOME: dir, PATH: `${dir}:/usr/bin:/bin`, LOCAL_BINARY: binary, SHELL: "/bin/bash" },
        }),
      ),
    ).toBe(0)
    expect(yield* fs.readFileString(path.join(dir, "wslpath-input"))).toBe(windows)
    expect(yield* fs.readFileString(path.join(dir, ".opencode/bin/opencode"))).toContain("0.0.0-dev-16365")
    expect((yield* fs.readDirectory(path.join(dir, ".opencode/bin"))).toSorted()).toEqual(["opencode", "opencode2"])
    expect(yield* fs.readFileString(path.join(dir, ".bashrc"))).toContain(`export PATH=${dir}/.opencode/bin:$PATH`)
  }),
)

test("installs and verifies the bundled CLI version", async () => {
  persistedServers = []
  const installs: string[][] = []
  const controller = await Effect.runPromise(
    createWslServersController(
      testControllerOptions({
        installCli: async (distro, cli) => {
          installs.push([distro, cli.version])
        },
        resolveCli: async () => "/home/me/.opencode/bin/opencode",
      }),
    ),
  )

  await controller.installOpencode("Debian")

  expect(installs).toEqual([["Debian", "0.0.0-dev-16365"]])
  expect(controller.getState().opencodeChecks.Debian?.matchesDesktop).toBe(true)
})

test("rejects a WSL CLI version that differs from the bundled version", async () => {
  persistedServers = []
  const controller = await Effect.runPromise(
    createWslServersController(
      testControllerOptions({
        installCli: async () => undefined,
        resolveCli: async () => "/home/me/.opencode/bin/opencode",
        readCliVersion: async () => "0.0.0-dev-older",
      }),
    ),
  )

  await expect(controller.installOpencode("Debian")).rejects.toThrow(
    "OpenCode update finished but Debian still reports 0.0.0-dev-older; expected 0.0.0-dev-16365",
  )
})

test("stops a running WSL server before replacing its CLI", async () => {
  persistedServers = [{ id: "wsl:Debian", distro: "Debian" }]
  const events: string[] = []
  const controller = await Effect.runPromise(
    createWslServersController(
      testControllerOptions({
        spawnSidecar: async () => {
          events.push("start")
          return {
            stop: async () => {
              events.push("stop")
            },
            onExit: () => undefined,
            url: "http://127.0.0.1:4096",
            password: "secret",
          }
        },
        installCli: async () => {
          events.push("install")
        },
      }),
    ),
  )
  controller.startConfiguredServers()
  await waitFor(() => controller.getState().servers[0]?.runtime.kind === "ready")
  expect(controller.getState().servers[0]?.runtime).toEqual({
    kind: "ready",
    url: "http://127.0.0.1:4096",
    password: "secret",
  })

  await controller.installOpencode("Debian")

  expect(events).toEqual(["start", "stop", "install", "start"])
  await controller.stopServers()
})

test("stops a sidecar that finishes starting after shutdown", async () => {
  persistedServers = [{ id: "wsl:Debian", distro: "Debian" }]
  const stopped: string[] = []
  let resolveSidecar: ((sidecar: Awaited<ReturnType<ControllerOptions["spawnSidecar"]>>) => void) | undefined
  const controller = await Effect.runPromise(
    createWslServersController(
      testControllerOptions({
        spawnSidecar: () => new Promise((resolve) => (resolveSidecar = resolve)),
      }),
    ),
  )
  controller.startConfiguredServers()
  await waitFor(() => controller.getState().servers[0]?.runtime.kind === "starting")

  await controller.stopServers()
  resolveSidecar?.({
    stop: async () => {
      stopped.push("stop")
    },
    onExit: () => undefined,
    url: "http://127.0.0.1:4096",
    password: "secret",
  })
  await waitFor(() => stopped.length === 1)

  expect(stopped).toEqual(["stop"])
})

test("probes addable distros in parallel before checking OpenCode", async () => {
  persistedServers = []
  const started: string[] = []
  const release = new Map<string, () => void>()
  const opencode: string[] = []
  const controller = await Effect.runPromise(
    createWslServersController(
      testControllerOptions({
        spawnSidecar: pendingSidecar,
        probeDistro: async (distro) => {
          started.push(distro)
          await new Promise<void>((resolve) => release.set(distro, resolve))
          return { name: distro, canExecute: true, hasBash: true, hasCurl: true, error: null }
        },
        resolveCli: async (distro) => {
          opencode.push(distro)
          return "/home/me/.opencode/bin/opencode"
        },
      }),
    ),
  )

  const task = controller.probeAddable(["Debian", "Ubuntu"])
  await waitFor(() => started.length === 2)
  expect(started).toEqual(["Debian", "Ubuntu"])
  expect(opencode).toEqual([])
  release.get("Debian")?.()
  release.get("Ubuntu")?.()
  await task

  expect(Object.keys(controller.getState().distroProbes)).toEqual(["Debian", "Ubuntu"])
  expect(opencode).toEqual(["Debian", "Ubuntu"])
  expect(Object.keys(controller.getState().opencodeChecks)).toEqual(["Debian", "Ubuntu"])
})

test("does not check OpenCode in addable distros that cannot execute commands", async () => {
  persistedServers = []
  const opencode: string[] = []
  const controller = await Effect.runPromise(
    createWslServersController(
      testControllerOptions({
        spawnSidecar: pendingSidecar,
        probeDistro: async (distro) => ({
          name: distro,
          canExecute: distro === "Debian",
          hasBash: distro === "Debian",
          hasCurl: distro === "Debian",
          error: distro === "Debian" ? null : "Open Ubuntu once to finish setup",
        }),
        resolveCli: async (distro) => {
          opencode.push(distro)
          return "/home/me/.opencode/bin/opencode"
        },
      }),
    ),
  )

  await controller.probeAddable(["Debian", "Ubuntu"])

  expect(Object.keys(controller.getState().distroProbes)).toEqual(["Debian", "Ubuntu"])
  expect(opencode).toEqual(["Debian"])
  expect(Object.keys(controller.getState().opencodeChecks)).toEqual(["Debian"])
})

async function waitFor(check: () => boolean) {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error("Timed out waiting for condition")
}

function testControllerOptions(overrides: Partial<ControllerOptions> = {}): ControllerOptions {
  return {
    cli: { version: "0.0.0-dev-16365" },
    installCli: async () => undefined,
    installDistro: async () => undefined,
    spawnSidecar: async () => ({
      stop: async () => undefined,
      onExit: () => undefined,
      url: "http://127.0.0.1:4096",
      password: "secret",
    }),
    readServers: () => persistedServers,
    writeServers: (servers: WslServerConfig[]) => {
      persistedServers = servers
    },
    readCliVersion: async () => "0.0.0-dev-16365",
    resolveCli: async () => "/home/me/.opencode/bin/opencode",
    ...overrides,
  }
}

const pendingSidecar = async () => new Promise<never>(() => undefined)
