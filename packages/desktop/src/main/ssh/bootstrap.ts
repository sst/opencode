import { Effect, Schema } from "effect"
import { HttpClient } from "effect/unstable/http"
import { parseTarget, quote, runSsh, sshArgs, SshFailure } from "./command"
import { RemoteCli } from "../remote/cli"

// Use commands supported by released V2 CLIs. The registration is the service's
// complete private discovery contract; no remote Python/Node runtime is needed.
const registrationScript = `status=$("$cli" service status) || exit 0
if [ "$status" = stopped ]; then exit 0; fi
printf 'OPENCODE_SSH_STATUS=%s\\n' "$status"
for file in "\${XDG_STATE_HOME:-$HOME/.local/state}"/opencode/service*.json; do
  if [ ! -f "$file" ]; then continue; fi
  printf 'OPENCODE_SSH_REGISTRATION_BEGIN\\n'
  cat "$file"
  printf '\\nOPENCODE_SSH_REGISTRATION_END\\n'
done
`

export const discoverScript = `set -eu
${RemoteCli.discoverScript({ fromPath: true, cache: { directory: ".opencode/desktop-ssh", prefix: "0.0.0-beta-" } })}
if [ -z "$cli" ]; then exit 0; fi
${registrationScript}`

export function startScript(version: string, replace = false) {
  return `set -eu
cli="${binaryPath(version)}"
"$cli" service ${replace ? "restart" : "start"}
${registrationScript}`
}

const Registration = Schema.fromJsonString(
  Schema.Struct({
    url: Schema.String,
    password: Schema.String,
    version: Schema.String,
    pid: Schema.Int.check(Schema.isGreaterThan(0)),
  }),
)

export function parseRegistration(output: string) {
  const status = output
    .split(/\r?\n/)
    .findLast((line) => line.startsWith("OPENCODE_SSH_STATUS="))
    ?.slice("OPENCODE_SSH_STATUS=".length)
  if (!status) return undefined
  for (const match of output.matchAll(
    /OPENCODE_SSH_REGISTRATION_BEGIN\r?\n([\s\S]*?)\r?\nOPENCODE_SSH_REGISTRATION_END/g,
  )) {
    const result = Schema.decodeUnknownOption(Registration)(match[1])
    if (result._tag === "Some" && result.value.url === status) return result.value
  }
  return undefined
}

export function binaryPath(version: string) {
  return `$HOME/.opencode/desktop-ssh/${RemoteCli.requireVersion(version)}/opencode`
}

function connectionAddress(address: string, password: string) {
  const url = new URL(address)
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "0.0.0.0", "[::]", "[::1]"].includes(url.hostname))
    throw new SshFailure("service")
  return {
    host: url.hostname === "[::1]" ? "[::1]" : "127.0.0.1",
    port: Number(url.port || 80),
    password,
  }
}

export const bootstrap = Effect.fn("Ssh.bootstrap")(function* (input: {
  target: ReturnType<typeof parseTarget>
  version: string
  development?: boolean
  env: NodeJS.ProcessEnv
  replace?: boolean
  stage: (stage: "checking" | "downloading" | "uploading" | "starting") => Effect.Effect<void>
}) {
  const run = (script: string) =>
    runSsh({
      args: [...sshArgs(input.target), input.target.host, "sh -l -s"],
      env: input.env,
      stdin: script,
    })
  yield* input.stage("checking")
  const registered = parseRegistration(yield* run(discoverScript))
  if (registered && (input.development || registered.version === input.version)) {
    yield* input.stage("starting")
    return yield* Effect.try({
      try: () => connectionAddress(registered.url, registered.password),
      catch: SshFailure.from,
    })
  }
  if (registered && !input.replace) return yield* Effect.fail(new SshFailure("version", registered.version))
  const destination = yield* Effect.try({ try: () => binaryPath(input.version), catch: SshFailure.from })
  const existing = yield* run(RemoteCli.versionScript(`"${destination}"`))
  const staged = RemoteCli.parseVersion(existing) === input.version
  // Source worktree versions are unpublished. Use the installer's beta channel
  // while retaining support for explicitly staged, matching development builds.
  const version =
    input.development && !staged ? yield* RemoteCli.latestBeta().pipe(Effect.mapError(SshFailure.from)) : input.version
  const setup = { version, directory: `.opencode/desktop-ssh/${version}` }
  if (!staged) {
    const output = yield* run(RemoteCli.probeScript).pipe(Effect.mapError(() => new SshFailure("platform")))
    const target = output
      .split(/\r?\n/)
      .findLast((line) => line.startsWith("OPENCODE_REMOTE_TARGET="))
      ?.split("=")[1]
    const url = yield* Effect.try({ try: () => RemoteCli.archiveUrl(target ?? "", version), catch: SshFailure.from })
    yield* input.stage("downloading")
    yield* run(RemoteCli.installScript({ ...setup, source: { type: "download", url } })).pipe(
      Effect.catch(
        Effect.fnUntraced(function* (error) {
          yield* input.stage("uploading")
          const http = yield* HttpClient.HttpClient
          const response = yield* http.get(url).pipe(Effect.mapError(SshFailure.from))
          if (response.status < 200 || response.status >= 300)
            return yield* Effect.fail(
              new SshFailure(
                response.status === 404 ? "unpublished" : "install",
                JSON.stringify({ version, target, url, status: response.status }),
              ),
            )
          const archive = new Uint8Array(yield* response.arrayBuffer.pipe(Effect.mapError(SshFailure.from)))
          // The upload uses stdin; the script itself must be the remote command.
          return yield* runSsh({
            args: [
              ...sshArgs(input.target),
              input.target.host,
              `sh -c ${quote(RemoteCli.installScript({ ...setup, source: { type: "archive" } }))}`,
            ],
            env: input.env,
            stdin: archive,
          }).pipe(Effect.mapError(() => new SshFailure("install", error.message)))
        }),
      ),
    )
  }
  yield* input.stage("starting")
  const registration = parseRegistration(yield* run(startScript(version, input.replace)))
  if (!registration) return yield* Effect.fail(new SshFailure("service"))
  if (!input.development && registration.version !== input.version)
    return yield* Effect.fail(new SshFailure("version", registration.version))
  return yield* Effect.try({
    try: () => connectionAddress(registration.url, registration.password),
    catch: SshFailure.from,
  })
})
