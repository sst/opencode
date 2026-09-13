import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { OPENCODE_VERSION } from "../src/version"
import { isolatedEnv } from "./fixture/environment"
import { tmpdir } from "./fixture/tmpdir"

describe("version queries", () => {
  test.each(["--version", "-v"])("%s does not initialize application directories", async (flag) => {
    await using root = await tmpdir()
    const result = await cli(root.path, [flag])

    expect(result).toEqual({ exitCode: 0, stdout: `opencode v${OPENCODE_VERSION}\n`, stderr: "" })
    expect(await fs.readdir(root.path)).toEqual([])
  })

  test("does not require a writable configuration directory", async () => {
    await using root = await tmpdir()
    const config = path.join(root.path, "config")
    await fs.writeFile(config, "not a directory")

    expect(await cli(root.path, ["--version"])).toEqual({
      exitCode: 0,
      stdout: `opencode v${OPENCODE_VERSION}\n`,
      stderr: "",
    })
    expect(await fs.readdir(root.path)).toEqual(["config"])
    expect(await fs.readFile(config, "utf8")).toBe("not a directory")
  })

  test("still initializes directories for a regular command", async () => {
    await using root = await tmpdir()
    const result = await cli(root.path, ["debug", "paths"])

    expect({ exitCode: result.exitCode, stderr: result.stderr }).toEqual({ exitCode: 0, stderr: "" })
    expect(result.stdout).toContain(path.join(root.path, "data", "opencode"))
    expect((await fs.stat(path.join(root.path, "data", "opencode"))).isDirectory()).toBe(true)
  })

  test("does not interpret a positional version string as a version query", async () => {
    await using root = await tmpdir()
    const result = await cli(root.path, ["debug", "paths", "--", "--version"])

    expect(result.stdout).not.toBe(`opencode v${OPENCODE_VERSION}\n`)
  })
})

async function cli(root: string, args: string[]) {
  const child = Bun.spawn([process.execPath, "run", path.join(import.meta.dir, "../src/index.ts"), ...args], {
    cwd: path.join(import.meta.dir, ".."),
    env: isolatedEnv(root, {
      TMPDIR: root,
      TMP: root,
      TEMP: root,
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
      OPENCODE_SSH_ASKPASS_PORT: undefined,
      OPENCODE_PRINT_LOGS: undefined,
      OTEL_EXPORTER_OTLP_ENDPOINT: undefined,
    }),
    stdout: "pipe",
    stderr: "pipe",
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { exitCode, stdout, stderr }
}
