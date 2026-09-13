import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { Effect, FileSystem, Path } from "effect"

const execFileAsync = promisify(execFile)

export const buildLocalWslCli = Effect.fn("Wsl.buildLocalCli")(function* (input: {
  version: string
  script: string
  output: string
}) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const directory = yield* fs.makeTempDirectory({ prefix: "opencode-wsl-cli-" })
  const build = Effect.gen(function* () {
    const root = path.join(path.dirname(input.script), "../../..")
    const packageManager = (
      JSON.parse(yield* fs.readFileString(path.join(root, "package.json"))) as {
        packageManager: string
      }
    ).packageManager
    const target = `linux-${process.arch}`
    yield* Effect.tryPromise(() =>
      execFileAsync("bunx", [packageManager, "install", "--os=*", "--cpu=*", "--frozen-lockfile"], {
        cwd: root,
        env: process.env,
        windowsHide: true,
      }),
    )
    yield* Effect.tryPromise(() =>
      execFileAsync(
        "bunx",
        [
          packageManager,
          input.script,
          `--target=opencode-${target}`,
          "--skip-install",
          "--skip-web-ui",
          `--outdir=${directory}`,
        ],
        { cwd: root, env: { ...process.env, OPENCODE_VERSION: input.version }, windowsHide: true },
      ),
    )
    yield* fs.copyFile(path.join(directory, `cli-${target}`, "bin", "opencode"), input.output)
    return input.output
  })
  return yield* build.pipe(Effect.ensuring(fs.remove(directory, { recursive: true, force: true }).pipe(Effect.orDie)))
})
