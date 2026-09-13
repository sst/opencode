import { describe, expect, test } from "bun:test"
import { Effect, FileSystem, Path, PlatformError } from "effect"
import { NodeServices } from "@effect/platform-node"
import { testEffect } from "../../../../core/test/lib/effect"
import { parseTarget, quote, sshHosts, sshArgs, tunnelArgs, commandFailureDetail, SshFailure } from "./command"

const it = testEffect(NodeServices.layer)

describe("SSH connection commands", () => {
  test("classifies a missing SSH executable from the platform error", () => {
    const error = PlatformError.systemError({
      _tag: "NotFound",
      module: "ChildProcessSpawner",
      method: "spawn",
      pathOrDescriptor: "ssh",
    })
    expect(SshFailure.from(error).code).toBe("ssh-missing")
  })
  test("forwarding overrides bootstrap persistence before reusing the control socket", () => {
    const args = tunnelArgs(
      {
        host: "devbox",
        args: ["-o", "ControlMaster=auto", "-o", "ControlPersist=60", "-o", "ControlPath=/test/socket"],
      },
      1234,
      { host: "127.0.0.1", port: 5678 },
    )
    expect(args.slice(0, 4)).toEqual(["-o", "ControlMaster=no", "-o", "ControlPersist=no"])
    expect(args).toContain("ControlPath=/test/socket")
    expect(args.slice(-4)).toEqual(["-L", "127.0.0.1:1234:127.0.0.1:5678", "devbox", "sh -c 'exec cat >/dev/null'"])
  })
  test("retains CLI stdout failures without exposing private connection details", () => {
    expect(
      commandFailureDetail(1, {
        stdout:
          'OPENCODE_SSH_REGISTRATION_BEGIN\n{"password":"secret"}\nOPENCODE_SSH_REGISTRATION_END\nFailed to read next file',
        stderr: "",
      }),
    ).toBe("Failed to read next file")
    expect(
      commandFailureDetail(1, {
        stdout: 'OPENCODE_SSH_REGISTRATION_BEGIN\n{"password":"secret"}',
        stderr: "read interrupted",
      }),
    ).toBe("read interrupted")
    expect(commandFailureDetail(1, { stdout: "Server process terminated by SIGKILL\n", stderr: "" })).toBe(
      "Server process terminated by SIGKILL",
    )
    expect(commandFailureDetail(255, { stdout: "", stderr: "" })).toBe('{"exitCode":255}')
  })
  test("preserves aliases and connection options without invoking a shell", () => {
    expect(parseTarget('ssh -p 2222 -i "~/.ssh/work key" -J gateway user@devbox')).toEqual({
      host: "user@devbox",
      args: ["-p", "2222", "-i", "~/.ssh/work key", "-J", "gateway"],
    })
    expect(parseTarget("devbox")).toEqual({ host: "devbox", args: [] })
    expect(parseTarget("ssh user@[::1]").host).toBe("user@[::1]")
    expect(sshArgs(parseTarget("devbox"))).toContain("PermitLocalCommand=no")
  })
  test("rejects remote commands, shell syntax, and transport overrides", () => {
    for (const input of [
      "",
      "ssh host whoami",
      "host;whoami",
      "ssh user:password@host",
      "ssh -t host",
      "ssh -o RemoteCommand=whoami host",
      "ssh -L 1234:x:80 host",
      "ssh -p 70000 host",
      'ssh -i "key host',
      "host\nwhoami",
    ]) {
      expect(() => parseTarget(input)).toThrow()
    }
    expect(quote("a'b")).toBe("'a'\\''b'")
  })
  it.live(
    "discovers Include aliases without wildcards or recursion",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "ssh-config-test-" })
      yield* fs.makeDirectory(path.join(dir, "hosts"))
      yield* fs.writeFileString(path.join(dir, "config"), "Host work other\nHost * !excluded\nInclude hosts/*\n")
      yield* fs.writeFileString(path.join(dir, "hosts", "extra"), "Host deploy\nInclude ../config\n")
      expect(yield* sshHosts(path.join(dir, "config"))).toEqual(["deploy", "other", "work"])
    }),
  )
})
