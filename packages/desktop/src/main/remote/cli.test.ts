import { expect, test } from "bun:test"
import { Effect, FileSystem, Path } from "effect"
import { NodeServices } from "@effect/platform-node"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { testEffect } from "../../../../core/test/lib/effect"
import { RemoteCli } from "./cli"

const it = testEffect(NodeServices.layer)
// These scripts execute on the POSIX remote host, not the Windows desktop.
const posix = process.platform === "win32" ? it.live.skip : it.live

it.live(
  "resolves the beta channel and rejects unavailable or invalid metadata",
  Effect.gen(function* () {
    for (const response of [
      Response.json({ version: "0.0.0-beta-19059" }),
      Response.json({ version: "2.0.0-local-123" }),
      Response.json({ version: "0.0.0-beta-19059" }, { status: 503 }),
    ]) {
      const result = yield* RemoteCli.latestBeta().pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request) => {
            expect(request.url).toBe("https://registry.npmjs.org/@opencode%2fcli/beta")
            return Effect.succeed(HttpClientResponse.fromWeb(request, response))
          }),
        ),
        Effect.result,
      )
      if (response.status === 200 && result._tag === "Success") expect(result.success).toBe("0.0.0-beta-19059")
      else expect(result._tag).toBe("Failure")
    }
  }),
)

posix(
  "discovers the managed CLI by default and uses PATH only when requested",
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "remote-cli-" })
    const home = path.join(dir, "home with ' quotes")
    yield* fs.makeDirectory(path.join(home, ".opencode/bin"), { recursive: true })
    yield* fs.makeDirectory(path.join(dir, "bin"))
    const managed = path.join(home, ".opencode/bin/opencode")
    const external = path.join(dir, "bin/opencode")
    yield* fs.writeFileString(managed, "#!/bin/sh\nprintf 'OpenCode v2.0.0\\n'\n", { mode: 0o755 })
    yield* fs.writeFileString(external, "#!/bin/sh\nprintf 'OpenCode v2.1.0\\n'\n", { mode: 0o755 })
    const run = (script: string) =>
      spawner.string(
        ChildProcess.make("sh", ["-c", script], {
          env: { HOME: home, PATH: `${path.join(dir, "bin")}:/usr/bin:/bin` },
        }),
      )
    expect((yield* run(RemoteCli.discoverScript())).trim()).toBe(managed)
    expect((yield* run(RemoteCli.discoverScript({ fromPath: true }))).trim()).toBe(external)
    expect(RemoteCli.parseVersion(yield* run(RemoteCli.versionScript(RemoteCli.quote(managed))))).toBe("2.0.0")
    yield* fs.remove(managed)
    expect((yield* run(RemoteCli.discoverScript())).trim()).toBe("")
    expect(RemoteCli.parseVersion(yield* run(RemoteCli.versionScript(RemoteCli.quote(managed))))).toBeNull()
  }),
)

test("pins platform-specific artifacts and rejects unsafe inputs", () => {
  expect(RemoteCli.archiveUrl("linux-x64-baseline-musl", "2.0.0-beta.1")).toBe(
    "https://registry.npmjs.org/@opencode/cli-linux-x64-baseline-musl/-/cli-linux-x64-baseline-musl-2.0.0-beta.1.tgz",
  )
  expect(() => RemoteCli.installScript({ version: '2.0.0"; whoami', source: { type: "installer" } })).toThrow()
  expect(() => RemoteCli.archiveUrl("linux-x64;whoami", "2.0.0")).toThrow()
})

posix(
  "downloads or uploads the same archive into managed and version-specific locations",
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "remote-install-" })
    yield* fs.makeDirectory(path.join(dir, "package/bin"), { recursive: true })
    yield* fs.writeFileString(path.join(dir, "package/bin/opencode"), "#!/bin/sh\nprintf 'OpenCode v2.0.0\\n'\n", {
      mode: 0o755,
    })
    const archive = path.join(dir, "archive.tgz")
    expect(
      yield* spawner.exitCode(ChildProcess.make("tar", ["-czf", archive, "-C", dir, "package"], { extendEnv: true })),
    ).toBe(0)
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response(Bun.file(archive)),
    })
    yield* Effect.addFinalizer(() => Effect.sync(() => server.stop(true)))
    const run = (input: Parameters<typeof RemoteCli.installScript>[0]) =>
      spawner.exitCode(
        ChildProcess.make("sh", ["-c", RemoteCli.installScript(input)], {
          env: { HOME: dir },
          extendEnv: true,
          stdin: fs.stream(archive),
        }),
      )
    expect(yield* run({ version: "2.0.0", source: { type: "download", url: server.url.href } })).toBe(0)
    expect(yield* fs.readFileString(path.join(dir, ".opencode/bin/opencode"))).toContain("2.0.0")
    expect(
      yield* run({ version: "2.0.0", directory: ".opencode/desktop-ssh/2.0.0", source: { type: "archive" } }),
    ).toBe(0)
    expect(yield* fs.readFileString(path.join(dir, ".opencode/desktop-ssh/2.0.0/opencode"))).toContain("2.0.0")
    expect(yield* run({ version: "2.1.0", source: { type: "archive" } })).not.toBe(0)
    expect(yield* fs.readFileString(path.join(dir, ".opencode/bin/opencode"))).toContain("2.0.0")
    expect(yield* fs.readDirectory(path.join(dir, ".opencode/bin"))).toEqual(["opencode"])
  }),
)
