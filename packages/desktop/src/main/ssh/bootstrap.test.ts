import { expect, test } from "bun:test"
import { Effect, FileSystem, Path, Stream } from "effect"
import { NodeServices } from "@effect/platform-node"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { testEffect } from "../../../../core/test/lib/effect"
import { binaryPath, discoverScript, startScript, parseRegistration } from "./bootstrap"

const it = testEffect(NodeServices.layer)
// Bootstrap runs on the POSIX SSH host; these fixtures execute its shell locally.
const posix = process.platform === "win32" ? it.live.skip : it.live

posix(
  "starts a staged CLI, rediscovers it, and restarts only for an explicit update",
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "ssh-beta-test-" })
    const version = "0.0.0-beta-19059"
    const bin = path.join(dir, ".opencode/desktop-ssh", version)
    yield* fs.makeDirectory(bin, { recursive: true })
    yield* fs.writeFileString(
      path.join(bin, "opencode"),
      `#!/bin/sh
set -eu
case "$1 $2" in
  "service start"|"service restart")
    printf '%s\\n' "$2" >> "$HOME/actions"
    mkdir -p "$XDG_STATE_HOME/opencode"
    printf '%s' '{"url":"http://127.0.0.1:12345","password":"fixture","version":"${version}","pid":1234}' > "$XDG_STATE_HOME/opencode/service.json"
    ;;
  "service status")
    if [ -f "$XDG_STATE_HOME/opencode/service.json" ]; then printf 'http://127.0.0.1:12345\\n'; else printf 'stopped\\n'; fi
    ;;
  *) exit 66 ;;
esac
`,
      { mode: 0o755 },
    )
    const run = (script: string) =>
      spawner.string(
        ChildProcess.make("sh", ["-c", script], {
          env: { HOME: dir, PATH: "/usr/bin:/bin", XDG_STATE_HOME: path.join(dir, "state") },
        }),
      )
    expect(parseRegistration(yield* run(discoverScript))).toBeUndefined()
    const started = parseRegistration(yield* run(startScript(version)))
    expect(started?.version).toBe(version)
    expect(started?.url).toBe("http://127.0.0.1:12345")
    expect(parseRegistration(yield* run(discoverScript))).toEqual(started)
    expect(parseRegistration(yield* run(startScript(version, true)))).toEqual(started)
    expect(yield* fs.readFileString(path.join(dir, "actions"))).toBe("start\nrestart\n")
  }),
)

posix(
  "finds an existing service through the released CLI",
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "ssh-discovery-test-" })
    const expected = {
      url: "http://0.0.0.0:49374",
      password: 'private"credential',
      version: "0.0.0-beta-19059",
      pid: 1234,
    }
    yield* fs.makeDirectory(path.join(dir, ".opencode/bin"), { recursive: true })
    yield* fs.makeDirectory(path.join(dir, "state/opencode"), { recursive: true })
    yield* fs.writeFileString(
      path.join(dir, ".opencode/bin/opencode"),
      '#!/bin/sh\n[ "$1 $2" = "service status" ] || exit 66\nprintf "http://0.0.0.0:49374\\n"\n',
      { mode: 0o755 },
    )
    yield* fs.writeFileString(path.join(dir, "state/opencode/service.json"), JSON.stringify(expected, null, 2))
    yield* fs.writeFileString(
      path.join(dir, "state/opencode/service-local.json"),
      JSON.stringify({ ...expected, url: "http://127.0.0.1:7777", password: "other" }),
    )
    const child = yield* spawner.spawn(
      ChildProcess.make("sh", ["-c", discoverScript], {
        env: { HOME: dir, PATH: "/usr/bin:/bin", XDG_STATE_HOME: path.join(dir, "state") },
      }),
    )
    const output = yield* child.stdout.pipe(Stream.decodeText(), Stream.mkString)
    expect(yield* child.exitCode).toBe(0)
    expect(parseRegistration(output)).toEqual(expected)
  }),
)

test("ignores stopped services and registrations that do not match the healthy endpoint", () => {
  const registration = { url: "http://127.0.0.1:1234", password: "secret", version: "2.0.0", pid: 42 }
  const frame = `OPENCODE_SSH_REGISTRATION_BEGIN\n${JSON.stringify(registration)}\nOPENCODE_SSH_REGISTRATION_END\n`
  expect(parseRegistration(`OPENCODE_SSH_STATUS=stopped\n${frame}`)).toBeUndefined()
  expect(parseRegistration(`OPENCODE_SSH_STATUS=http://127.0.0.1:9999\n${frame}`)).toBeUndefined()
  expect(
    parseRegistration(
      `OPENCODE_SSH_STATUS=${registration.url}\nOPENCODE_SSH_REGISTRATION_BEGIN\ninvalid\nOPENCODE_SSH_REGISTRATION_END\n`,
    ),
  ).toBeUndefined()
})

test("rejects unsafe versions in SSH installation paths", () => {
  expect(() => binaryPath('2.0.0"; whoami')).toThrow()
})
