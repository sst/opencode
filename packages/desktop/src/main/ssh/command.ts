import { Effect, FileSystem, Path, PlatformError, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { homedir } from "node:os"
import { RemoteCli } from "../remote/cli"

export class SshFailure extends Schema.TaggedError<SshFailure>()("SshFailure", {
  code: Schema.Literals([
    "input",
    "connection",
    "platform",
    "version",
    "install",
    "service",
    "unpublished",
    "ssh-missing",
  ]),
  detail: Schema.String,
}) {
  constructor(code: SshFailure["code"], detail = "") {
    super({ code, detail })
  }

  override get message() {
    return this.detail
  }

  static from(this: void, error: unknown) {
    if (error instanceof RemoteCli.Failure) return new SshFailure(error.code, error.detail)
    if (
      error instanceof PlatformError.PlatformError &&
      error.reason._tag === "NotFound" &&
      error.reason.method === "spawn"
    )
      return new SshFailure("ssh-missing", error.message)
    return error instanceof SshFailure
      ? error
      : new SshFailure("connection", error instanceof Error ? error.message : String(error))
  }
}

export function quote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`
}

export function parseTarget(input: string) {
  const tokens: string[] = []
  const state = { word: "", quote: "", started: false }
  for (let i = 0; i < input.length; i++) {
    const c = input[i] ?? ""
    if (c === "\n" || c === "\r" || c === "\0") throw new SshFailure("input")
    if (c === "\\" && state.quote !== "'" && i + 1 < input.length && /[\s\\"']/.test(input[i + 1] ?? "")) {
      state.word += input[++i]
      state.started = true
      continue
    }
    if (state.quote) {
      if (c === state.quote) state.quote = ""
      else state.word += c
      continue
    }
    if (c === "'" || c === '"') {
      state.quote = c
      state.started = true
      continue
    }
    if (/\s/.test(c)) {
      if (state.started) tokens.push(state.word)
      state.word = ""
      state.started = false
      continue
    }
    state.word += c
    state.started = true
  }
  if (state.quote) throw new SshFailure("input")
  if (state.started) tokens.push(state.word)
  if (tokens[0] === "ssh") tokens.shift()
  const args: string[] = []
  const options = new Set([
    "hostname",
    "user",
    "port",
    "identityfile",
    "identityagent",
    "identitiesonly",
    "proxyjump",
    "proxycommand",
    "connecttimeout",
    "addressfamily",
  ])
  while (tokens[0]?.startsWith("-")) {
    const token = tokens.shift() ?? ""
    if (["-4", "-6", "-C", "-A", "-a"].includes(token)) {
      args.push(token)
      continue
    }
    const flag = token.slice(0, 2)
    if (!["-p", "-l", "-i", "-F", "-J", "-o"].includes(flag)) throw new SshFailure("input")
    const value = token.length > 2 ? token.slice(2) : tokens.shift()
    if (!value || value.startsWith("-")) throw new SshFailure("input")
    if (flag === "-p" && (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535))
      throw new SshFailure("input")
    if (flag === "-o" && !options.has((value.split(/[=\s]/)[0] ?? "").toLowerCase())) throw new SshFailure("input")
    args.push(flag, value)
  }
  const host = tokens[0]
  if (tokens.length !== 1 || !host || !/^[a-zA-Z0-9_@.:[\]%-]+$/.test(host) || host.startsWith("-"))
    throw new SshFailure("input")
  if (host.includes("@") && host.slice(0, host.lastIndexOf("@")).includes(":")) throw new SshFailure("input")
  return { host, args }
}

export const sshExecutable = () => (process.platform === "win32" ? "ssh.exe" : "ssh")

export function sshArgs(target: ReturnType<typeof parseTarget>) {
  return [
    "-T",
    "-o",
    "ConnectTimeout=10",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=3",
    "-o",
    "RemoteCommand=none",
    "-o",
    "RequestTTY=no",
    "-o",
    "PermitLocalCommand=no",
    ...target.args,
  ]
}

export function tunnelArgs(
  target: ReturnType<typeof parseTarget>,
  localPort: number,
  remote: { host: string; port: number },
) {
  // A multiplexed `ssh -N` may exit after handing forwarding to its master.
  // Keep a session open on stdin instead; the scoped process owns that pipe.
  return [
    "-o",
    "ControlMaster=no",
    "-o",
    "ControlPersist=no",
    ...sshArgs(target),
    "-o",
    "ExitOnForwardFailure=yes",
    "-L",
    `127.0.0.1:${localPort}:${remote.host}:${remote.port}`,
    target.host,
    "sh -c 'exec cat >/dev/null'",
  ]
}

export const runSsh = Effect.fn("Ssh.run")(function* (input: {
  args: string[]
  env?: NodeJS.ProcessEnv
  stdin?: string | Uint8Array
  timeout?: number
}) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  return yield* Effect.gen(function* () {
    const child = yield* spawner.spawn(
      ChildProcess.make(sshExecutable(), input.args, {
        env: input.env,
        extendEnv: true,
        windowsHide: true,
        killSignal: "SIGTERM",
        forceKillAfter: "2 seconds",
        stdin:
          input.stdin === undefined
            ? "ignore"
            : {
                stream: Stream.make(
                  typeof input.stdin === "string" ? new TextEncoder().encode(input.stdin) : input.stdin,
                ),
                endOnDone: true,
              },
      }),
    )
    const output = yield* Effect.all(
      {
        stdout: child.stdout.pipe(
          Stream.decodeText(),
          Stream.runFold(
            () => "",
            (tail, text) => (tail + text).slice(-1_048_576),
          ),
        ),
        stderr: child.stderr.pipe(
          Stream.decodeText(),
          Stream.runFold(
            () => "",
            (tail, text) => (tail + text).slice(-16_384),
          ),
        ),
        code: child.exitCode,
      },
      { concurrency: "unbounded" },
    )
    if (output.code !== 0)
      return yield* Effect.fail(new SshFailure("connection", commandFailureDetail(output.code, output)))
    return output.stdout
  }).pipe(Effect.scoped, Effect.timeout(input.timeout ?? 600_000), Effect.mapError(SshFailure.from))
})

export function commandFailureDetail(code: number | null, output: { stdout: string; stderr: string }) {
  // The CLI may report failures on stdout. Never include its private bootstrap
  // response in diagnostic text, even if shutdown fails after printing it.
  const stdout = output.stdout
    .replace(/OPENCODE_SSH_REGISTRATION_BEGIN[\s\S]*?(?:OPENCODE_SSH_REGISTRATION_END|$)/g, "")
    .trim()
  return [output.stderr.trim(), stdout].filter(Boolean).join("\n") || JSON.stringify({ exitCode: code })
}

export const sshHosts = Effect.fn("Ssh.hosts")(function* (
  filename?: string,
  seen = new Set<string>(),
): Effect.fn.Return<string[], never, FileSystem.FileSystem | Path.Path> {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const file = filename ?? path.join(homedir(), ".ssh", "config")
  if (seen.has(file) || seen.size >= 100) return []
  seen.add(file)
  const content = yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => ""))
  const lines = content.split(/\r?\n/).map((line) => line.trim().replace(/\s+#.*$/, ""))
  const hosts = lines.flatMap((line) =>
    /^host\s/i.test(line)
      ? line
          .split(/\s+/)
          .slice(1)
          .filter((host) => !/[!*?]/.test(host))
      : [],
  )
  const includes = lines.flatMap((line) => (/^include\s/i.test(line) ? line.split(/\s+/).slice(1) : []))
  for (const include of includes) {
    const pattern = include.startsWith("~/")
      ? path.join(homedir(), include.slice(2))
      : path.resolve(path.dirname(file), include)
    const dir = path.dirname(pattern)
    const match = new RegExp(
      "^" +
        path
          .basename(pattern)
          .replace(/[.+^${}()|[\]\\]/g, "\\$&")
          .replaceAll("*", ".*")
          .replaceAll("?", ".") +
        "$",
    )
    const files = yield* fs.readDirectory(dir).pipe(Effect.orElseSucceed(() => []))
    for (const name of files.filter((name) => match.test(name)))
      hosts.push(...(yield* sshHosts(path.join(dir, name), seen)))
  }
  return [...new Set(hosts)].sort()
})
