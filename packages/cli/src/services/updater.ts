import { Global } from "@opencode/util/global"
import { AppProcess } from "@opencode/util/process"
import { OPENCODE_ARTIFACT, OPENCODE_CHANNEL, OPENCODE_LOCAL, OPENCODE_VERSION } from "../version"
import { Context, Duration, Effect, FileSystem, Layer, Ref, Schedule } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { parse, type ParseError } from "jsonc-parser"
import path from "node:path"
import { action, parseReleaseVersion, type Policy } from "./updater-action"

export const methods = ["curl", "npm", "pnpm", "bun", "yarn"] as const
export type Method = (typeof methods)[number]
export type RunResult = { readonly type: "available" | "installed"; readonly version: string }
export type CheckResult = RunResult | { readonly type: "unavailable"; readonly message: string }

export interface Interface {
  readonly run: () => Effect.Effect<RunResult | undefined>
  readonly check: () => Effect.Effect<CheckResult | undefined, Error>
  readonly apply: (version: string) => Effect.Effect<void, Error>
  readonly method: () => Effect.Effect<Method | undefined>
  readonly latest: () => Effect.Effect<string, Error>
  readonly upgrade: (method: Method, version: string) => Effect.Effect<void, Error>
  readonly removal: (method: Method) =>
    | { readonly command: ReadonlyArray<string>; readonly run: Effect.Effect<void, Error> }
    | undefined
}

export const pollUpdates = Effect.fnUntraced(function* (input: {
  readonly check: Effect.Effect<unknown>
  readonly initialDelay?: Duration.Input
  readonly interval?: Duration.Input
}) {
  const interval = input.interval ?? "10 minutes"
  return yield* input.check.pipe(
    Effect.repeat(Schedule.spaced(interval)),
    Effect.delay(input.initialDelay ?? "1 minute"),
  )
})

export class Service extends Context.Service<Service, Interface>()("@opencode/cli/Updater") {}

export function decodePolicy(text: string): Policy | undefined {
  // The CLI only projects this host-level preference instead of initializing
  // the location-scoped server configuration graph.
  const errors: ParseError[] = []
  const input: unknown = parse(text, errors, { allowTrailingComma: true })
  if (errors.length || typeof input !== "object" || input === null) return
  if ("update" in input) {
    const value = input.update
    if (value === "disable" || value === "notify" || value === "auto") return value
    return
  }
  if (!("autoupdate" in input)) return
  if (input.autoupdate === false) return "disable"
  if (input.autoupdate === "notify") return "notify"
  if (input.autoupdate === true) return "auto"
}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const global = yield* Global.Service
  const appProcess = yield* AppProcess.Service
  const installedVersion = yield* Ref.make(OPENCODE_VERSION)
  const channel = OPENCODE_CHANNEL.replace(/[^a-zA-Z0-9._-]/g, "-")
  const installedPackage = yield* Effect.gen(function* () {
    const executable = yield* fs.realPath(process.execPath)
    const directory = path.dirname(path.dirname(executable))
    const manifest: { name: string; bin?: Record<string, string> } = yield* fs
      .readFileString(path.join(directory, "package.json"))
      .pipe(Effect.flatMap((text) => Effect.try(() => JSON.parse(text))))
    // Source invocations run inside Bun or Node, which may themselves be npm packages.
    if (!/^@opencode(?:-ai)?\/cli(?:-node)?$/.test(manifest.name)) return
    if (Object.values(manifest.bin ?? {}).some((bin) => path.resolve(directory, bin) === executable))
      return manifest.name
  }).pipe(Effect.orElseSucceed(() => undefined))

  const readPolicy = Effect.fnUntraced(function* () {
    const values = yield* Effect.forEach(["config.json", "opencode.json", "opencode.jsonc"], (name) =>
      fs.readFileString(path.join(global.config, name)).pipe(
        Effect.map(decodePolicy),
        Effect.orElseSucceed(() => undefined),
      ),
    )
    return values.findLast((value) => value !== undefined) ?? "notify"
  })

  const exec = Effect.fnUntraced(function* (command: string[], timeout: Duration.Input = "10 seconds") {
    return yield* appProcess
      .run(ChildProcess.make(command[0], command.slice(1)), {
        timeout,
        maxOutputBytes: 100_000,
        maxErrorBytes: 100_000,
      })
      .pipe(
        Effect.map((result) => ({
          code: result.exitCode,
          stdout: result.stdout.toString("utf8"),
          stderr: result.stderr.toString("utf8"),
        })),
        Effect.orElseSucceed(() => ({ code: 1, stdout: "", stderr: "" })),
      )
  })

  const method = Effect.fnUntraced(function* () {
    const binary = path.join(
      global.home,
      ".opencode",
      "bin",
      process.platform === "win32" ? "opencode.exe" : "opencode",
    )
    if (path.resolve(process.execPath) === path.resolve(binary)) return "curl"
    if (!installedPackage) return

    const checks: ReadonlyArray<{ method: Method; command: string[] }> = [
      { method: "npm", command: ["npm", "list", "-g", "--depth=0", installedPackage] },
      { method: "pnpm", command: ["pnpm", "list", "-g", "--depth=0", installedPackage] },
      { method: "bun", command: ["bun", "pm", "ls", "-g"] },
      { method: "yarn", command: ["yarn", "global", "list"] },
    ]
    const results = yield* Effect.forEach(
      checks,
      (check) => exec(check.command).pipe(Effect.map((result) => ({ check, result }))),
      { concurrency: "unbounded" },
    )
    return results.find((result) => result.result.stdout.includes(installedPackage))?.check.method
  })

  const removal = (method: Method) => {
    if (method === "curl" || !installedPackage) return undefined
    const commands = {
      npm: ["npm", "uninstall", "--global", installedPackage],
      pnpm: ["pnpm", "remove", "--global", installedPackage],
      bun: ["bun", "remove", "--global", installedPackage],
      yarn: ["yarn", "global", "remove", installedPackage],
    }
    const command = commands[method]
    return {
      command,
      run: exec(command, "5 minutes").pipe(
        Effect.flatMap((result) =>
          result.code === 0
            ? Effect.void
            : Effect.fail(new Error(result.stderr.trim() || `Failed to uninstall with ${method}`)),
        ),
      ),
    }
  }

  const release = Effect.fnUntraced(function* () {
    const response = yield* Effect.tryPromise({
      try: (signal) =>
        fetch(
          `https://opencode.ai/update/api/${encodeURIComponent(channel)}/${encodeURIComponent(OPENCODE_ARTIFACT)}/npm?current=${encodeURIComponent(OPENCODE_VERSION)}`,
          {
            signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
          },
        ),
      catch: (cause) => new Error("Failed to check for updates", { cause }),
    })
    if (!response.ok) return yield* Effect.fail(new Error(`Update check failed with status ${response.status}`))
    const data: { version: string; metadata?: { package?: string } } = yield* Effect.tryPromise({
      try: () => response.json(),
      catch: (cause) => new Error("Failed to read update information", { cause }),
    })
    if (!data.metadata?.package) return yield* Effect.fail(new Error("Update information did not include a package"))
    return { package: data.metadata.package, version: data.version }
  })

  const latest = () => release().pipe(Effect.map((data) => data.version))

  const temporaryDirectory = (prefix: string) =>
    Effect.acquireRelease(fs.makeTempDirectory({ directory: global.cache, prefix }), (directory) =>
      fs.remove(directory, { recursive: true, force: true }).pipe(Effect.ignore),
    )

  const upgrade = Effect.fnUntraced(function* (method: Method, input: string) {
    if (!parseReleaseVersion(input)) return yield* Effect.fail(new Error(`Invalid version: ${input}`))
    const version = input.trim().replace(/^v/, "")
    const packageName = (yield* release()).package
    const target = `${packageName}@${version}`
    if (installedPackage && packageName !== installedPackage && (method === "pnpm" || method === "yarn")) {
      return yield* Effect.fail(new Error(`Reinstall ${target} with ${method} to migrate from ${installedPackage}.`))
    }
    const commands: Record<Exclude<Method, "bun" | "curl">, string[]> = {
      // Keep the old package: uninstalling it can unlink the replacement command.
      npm: [
        "npm",
        "install",
        "--global",
        ...((OPENCODE_ARTIFACT === "cli" && !installedPackage?.endsWith("/cli-node")) ||
        (installedPackage && packageName !== installedPackage)
          ? ["--force"]
          : []),
        target,
      ],
      pnpm: ["pnpm", "add", "--global", `--allow-build=${packageName}`, target],
      yarn: ["yarn", "global", "add", target],
    }
    const result = yield* Effect.scoped(
      Effect.gen(function* () {
        if (method === "bun") {
          // Bun does not prune old versions from its shared package cache.
          yield* fs.makeDirectory(global.cache, { recursive: true })
          const cache = yield* temporaryDirectory("update-")
          return yield* exec(["bun", "install", "--global", "--trust", "--cache-dir", cache, target], "5 minutes")
        }
        if (method === "curl") {
          yield* fs.makeDirectory(global.cache, { recursive: true })
          const directory = yield* temporaryDirectory("update-")
          const installer = path.join(directory, "install")
          const download = yield* exec(
            ["curl", "-fsSL", "-o", installer, "https://opencode.ai/v2/install"],
            "5 minutes",
          )
          if (download.code !== 0) return download
          return yield* exec(["bash", installer, "--version", version, "--no-modify-path"], "5 minutes")
        }
        return yield* exec(commands[method], "5 minutes")
      }),
    ).pipe(Effect.mapError((cause) => new Error(`Failed to update with ${method}`, { cause })))
    if (result.code === 0) return
    return yield* Effect.fail(new Error(result.stderr.trim() || `Failed to update with ${method}`))
  })

  const inspect = Effect.fnUntraced(function* () {
    if (OPENCODE_LOCAL || ["1", "true"].includes(process.env.OPENCODE_DISABLE_AUTOUPDATE?.toLowerCase() ?? "")) {
      yield* Effect.logInfo("update check skipped", {
        reason: OPENCODE_LOCAL ? "local-install" : "disabled",
        version: OPENCODE_VERSION,
        channel: OPENCODE_CHANNEL,
      })
      return undefined
    }
    const policy = yield* readPolicy()
    if (policy === "disable") {
      yield* Effect.logInfo("update check skipped", { reason: "policy-disabled" })
      return undefined
    }

    const current = yield* Ref.get(installedVersion)
    const version = yield* latest()
    yield* Effect.logInfo("update check", {
      current,
      latest: version,
    })
    const next = action(current, version, policy)
    if (next === "none") {
      yield* Effect.logInfo("update check done", { action: "up-to-date" })
      return undefined
    }
    yield* Effect.logInfo("OpenCode update available", { current, latest: version, action: next })
    return { policy, version }
  })

  const install = Effect.fnUntraced(function* (version: string) {
    const detected = yield* method()
    if (!detected) {
      yield* Effect.logWarning("update skipped: installation method not found")
      return false
    }
    const current = yield* Ref.get(installedVersion)
    yield* upgrade(detected, version)
    yield* Ref.set(installedVersion, version)
    yield* Effect.logInfo("updated OpenCode", { from: current, to: version, method: detected })
    return true
  })

  const apply = Effect.fn("cli.updater.apply")(function* (version: string) {
    if (!(yield* install(version))) return yield* Effect.fail(new Error("Installation method not found"))
  })

  const check = Effect.fn("cli.updater.check")(function* () {
    if (OPENCODE_LOCAL)
      return {
        type: "unavailable" as const,
        message: "This build runs from a source checkout. Use an installed OpenCode release to check for updates.",
      }
    const version = yield* latest()
    if (!parseReleaseVersion(version)) return yield* Effect.fail(new Error(`Invalid version: ${version}`))
    const current = yield* Ref.get(installedVersion)
    if (action(current, version, "auto") === "none") {
      // An earlier check may have installed the update while this client is still running.
      return action(OPENCODE_VERSION, current, "auto") === "none"
        ? undefined
        : { type: "installed" as const, version: current }
    }
    return { type: "available" as const, version }
  })

  const run = Effect.fn("cli.updater.run")(
    function* () {
      const result = yield* inspect()
      if (!result) return undefined
      if (result.policy === "notify") return { type: "available" as const, version: result.version }
      if (!(yield* install(result.version))) return yield* Effect.fail(new Error("Installation method not found"))
      return { type: "installed" as const, version: result.version }
    },
    Effect.catch((error) => Effect.logWarning("update check failed", { error }).pipe(Effect.as(undefined))),
  )

  return Service.of({ run, check, apply, method, latest, upgrade, removal })
})

export const layer = Layer.effect(Service, make)

export * as Updater from "./updater"
export { action, type Action, type Policy } from "./updater-action"
