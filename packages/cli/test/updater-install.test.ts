import { NodeServices } from "@effect/platform-node"
import { Global } from "@opencode/util/global"
import { AppProcess } from "@opencode/util/process"
import { expect, spyOn, test } from "bun:test"
import { Effect, FileSystem, PlatformError, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { existsSync } from "node:fs"
import path from "node:path"
import { Updater } from "../src/services/updater"
import { testEffect } from "../../core/test/lib/effect"

const it = testEffect(NodeServices.layer)

declare const OPENCODE_CLI_NAME: string | undefined

function fixture(
  respond: (command: ChildProcess.StandardCommand) => Partial<AppProcess.RunResult> & {
    error?: AppProcess.AppProcessError
  } = () => ({}),
  name = "@opencode/cli",
  failCleanup = false,
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "opencode-updater-" })
    const executable = path.join(root, "package", "bin", "opencode")
    yield* fs.makeDirectory(path.dirname(executable), { recursive: true })
    yield* fs.writeFileString(
      path.join(root, "package", "package.json"),
      JSON.stringify({ name, bin: { opencode: "bin/opencode" } }),
    )
    // The updater uses global fetch; scope this replacement to each install test.
    yield* Effect.acquireRelease(
      Effect.sync(() =>
        spyOn(globalThis, "fetch").mockImplementation(
          Object.assign(async () => Response.json({ version: "2.3.4", metadata: { package: name } }), {
            preconnect: fetch.preconnect,
          }),
        ),
      ),
      (request) => Effect.sync(() => request.mockRestore()),
    )
    const global = Global.make({
      home: path.join(root, "home"),
      data: path.join(root, "data"),
      cache: path.join(root, "cache"),
      config: path.join(root, "config"),
      state: path.join(root, "state"),
      tmp: path.join(root, "tmp"),
      bin: path.join(root, "bin"),
      log: path.join(root, "log"),
      repos: path.join(root, "repos"),
    })
    const commands: string[][] = []
    const updater = yield* Updater.Service.pipe(
      Effect.provide(Updater.layer),
      Effect.provideService(Global.Service, global),
      Effect.provideService(FileSystem.FileSystem, {
        ...fs,
        remove: (target, options) =>
          failCleanup && target.startsWith(global.cache)
            ? Effect.fail(
                PlatformError.systemError({
                  _tag: "PermissionDenied",
                  module: "FileSystem",
                  method: "remove",
                  pathOrDescriptor: target,
                }),
              )
            : fs.remove(target, options),
        realPath: (input) => (input === process.execPath ? Effect.succeed(executable) : fs.realPath(input)),
      }),
      Effect.provideService(
        AppProcess.Service,
        AppProcess.Service.of({
          ...spawner,
          run: (command) =>
            Effect.suspend(() => {
              if (command._tag !== "StandardCommand") return Effect.die("Unexpected piped install command")
              commands.push([command.command, ...command.args])
              const result = respond(command)
              if (result.error) return Effect.fail(result.error)
              return Effect.succeed({
                command: command.command,
                exitCode: 0,
                stdout: Buffer.alloc(0),
                stderr: Buffer.alloc(0),
                stdoutTruncated: false,
                stderrTruncated: false,
                ...result,
              })
            }),
          runStream: () => Stream.die("Unexpected streaming install command"),
        }),
      ),
    )
    return { updater, commands, global, fs }
  })
}

const installs = [
  { method: "npm", command: ["npm", "install", "--global", "--force", "@opencode/cli@2.3.4-beta.1"] },
  {
    method: "pnpm",
    command: ["pnpm", "add", "--global", "--allow-build=@opencode/cli", "@opencode/cli@2.3.4-beta.1"],
  },
  { method: "yarn", command: ["yarn", "global", "add", "@opencode/cli@2.3.4-beta.1"] },
] as const

installs.forEach(({ method, command }) => {
  it.live(`${method} installs the explicit V2 package version without a leading v`, () =>
    Effect.gen(function* () {
      const test = yield* fixture()
      yield* test.updater.upgrade(method, "v2.3.4-beta.1")
      expect(test.commands).toEqual([[...command]])
    }),
  )
})
;[0, 1].forEach((exitCode) => {
  it.live(`bun isolates and removes its install cache after exit ${exitCode}`, () =>
    Effect.gen(function* () {
      const test = yield* fixture((command) => {
        expect(command.command).toBe("bun")
        expect(existsSync(command.args[4])).toBe(true)
        return { exitCode, stderr: Buffer.from("bun install failed") }
      })
      const result = yield* test.updater.upgrade("bun", "v2.3.4-beta.1").pipe(Effect.flip, Effect.option)
      const cache = test.commands[0]?.[5]
      expect(cache).toStartWith(path.join(test.global.cache, "update-"))
      expect(test.commands).toEqual([
        ["bun", "install", "--global", "--trust", "--cache-dir", cache, "@opencode/cli@2.3.4-beta.1"],
      ])
      expect(yield* test.fs.readDirectory(test.global.cache)).toEqual([])
      expect(result._tag).toBe(exitCode === 0 ? "None" : "Some")
      if (result._tag === "Some") expect(result.value.message).toBe("bun install failed")
    }),
  )
})

it.live("bun ignores install cache cleanup failures", () =>
  Effect.gen(function* () {
    const test = yield* fixture(() => ({}), "@opencode/cli", true)
    yield* test.updater.upgrade("bun", "v2.3.4-beta.1")
    expect(test.commands).toHaveLength(1)
  }),
)
;["success", "download", "install"].forEach((failure) => {
  it.live(`curl uses the V2 installer and cleans its directory: ${failure}`, () =>
    Effect.gen(function* () {
      const test = yield* fixture((command) => {
        const installer = command.command === "curl" ? command.args[2] : command.args[0]
        expect(existsSync(path.dirname(installer))).toBe(true)
        return {
          exitCode: command.command === (failure === "download" ? "curl" : failure === "install" ? "bash" : "") ? 1 : 0,
          stderr: Buffer.from(`${failure} failed`),
        }
      })
      const result = yield* test.updater.upgrade("curl", "v2.3.4-beta.1").pipe(Effect.flip, Effect.option)
      const installer = test.commands[0]?.[3]
      expect(installer).toStartWith(path.join(test.global.cache, "update-"))
      expect(test.commands).toEqual([
        ["curl", "-fsSL", "-o", installer, "https://opencode.ai/v2/install"],
        ...(failure === "download" ? [] : [["bash", installer, "--version", "2.3.4-beta.1", "--no-modify-path"]]),
      ])
      expect(yield* test.fs.readDirectory(test.global.cache)).toEqual([])
      expect(result._tag).toBe(failure === "success" ? "None" : "Some")
      if (result._tag === "Some") expect(result.value.message).toBe(`${failure} failed`)
    }),
  )
})

it.live("invalid version targets never execute a command or create a cache", () =>
  Effect.gen(function* () {
    const test = yield* fixture()
    yield* Effect.forEach(Updater.methods, (method) =>
      Effect.forEach(
        ["", "latest", "2.3", "01.2.3", "vv2.3.4", "2.3.4; echo unsafe", "--global", "v2.3.4\n--force"],
        (version) =>
          Effect.gen(function* () {
            const error = yield* test.updater.upgrade(method, version).pipe(Effect.flip)
            expect(error.message).toBe(`Invalid version: ${version}`)
          }),
      ),
    )
    expect(test.commands).toEqual([])
    expect(yield* test.fs.exists(test.global.cache)).toBe(false)
  }),
)

it.live("install failures expose stderr and process errors do not report success", () =>
  Effect.gen(function* () {
    const failed = yield* fixture(() => ({ exitCode: 1, stderr: Buffer.from("  registry denied access\n") }))
    const error = yield* failed.updater.upgrade("npm", "2.3.4").pipe(Effect.flip)
    expect(error.message).toBe("registry denied access")
    const missing = yield* fixture(() => ({ error: new AppProcess.AppProcessError({ command: "npm" }) }))
    const unavailable = yield* missing.updater.upgrade("npm", "2.3.4").pipe(Effect.flip)
    expect(unavailable.message).toBe("Failed to update with npm")
    expect(failed.commands).toHaveLength(1)
    expect(missing.commands).toHaveLength(1)
  }),
)
;(["npm", "pnpm", "bun", "yarn", undefined] as const).forEach((method) => {
  it.live(`method detection identifies ${method ?? "an unknown installation"} using the V2 package`, () =>
    Effect.gen(function* () {
      const test = yield* fixture((command) => ({
        stdout: Buffer.from(command.command === method ? "@opencode/cli@2.3.4" : "opencode-ai@1.0.0"),
      }))
      expect(yield* test.updater.method()).toBe(method)
      expect(test.commands).toEqual([
        ["npm", "list", "-g", "--depth=0", "@opencode/cli"],
        ["pnpm", "list", "-g", "--depth=0", "@opencode/cli"],
        ["bun", "pm", "ls", "-g"],
        ["yarn", "global", "list"],
      ])
    }),
  )
})

it.live("method detection tolerates unavailable package managers", () =>
  Effect.gen(function* () {
    const test = yield* fixture((command) =>
      command.command === "yarn"
        ? { stdout: Buffer.from("@opencode/cli@2.3.4") }
        : { error: new AppProcess.AppProcessError({ command: command.command }) },
    )
    expect(yield* test.updater.method()).toBe("yarn")
    expect(test.commands).toHaveLength(4)
  }),
)

test("Node distribution honors the compile-time CLI name", async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      "test",
      import.meta.path,
      "--define",
      'OPENCODE_CLI_NAME="opencode2-node"',
      "--test-name-pattern",
      "^Node distribution resolves the published npm package$",
    ],
    {
      cwd: path.join(import.meta.dir, ".."),
      stdout: "ignore",
      stderr: "pipe",
      // Bun 1.4 can reuse cached modules compiled with different --define values.
      env: { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" },
    },
  )
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
  expect(code, stderr).toBe(0)
  expect(stderr).toContain("1 pass")
})

if (typeof OPENCODE_CLI_NAME === "string" && OPENCODE_CLI_NAME === "opencode2-node") {
  it.live("Node distribution resolves the published npm package", () =>
    Effect.gen(function* () {
      const test = yield* fixture(
        (command) => ({
          stdout: Buffer.from(command.command === "npm" ? "@opencode/cli-node@2.3.4" : ""),
        }),
        "@opencode/cli-node",
      )
      expect(yield* test.updater.method()).toBe("npm")
      yield* test.updater.upgrade("npm", "v2.3.4")
      yield* test.updater.upgrade("pnpm", "v2.3.4")
      expect(test.commands).toEqual([
        ["npm", "list", "-g", "--depth=0", "@opencode/cli-node"],
        ["pnpm", "list", "-g", "--depth=0", "@opencode/cli-node"],
        ["bun", "pm", "ls", "-g"],
        ["yarn", "global", "list"],
        ["npm", "install", "--global", "@opencode/cli-node@2.3.4"],
        ["pnpm", "add", "--global", "--allow-build=@opencode/cli-node", "@opencode/cli-node@2.3.4"],
      ])
    }),
  )
}
