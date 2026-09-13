export * as RemoteCli from "./cli"

import { Effect, Schema } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { parseCliVersion } from "../service/cli-version"

export class Failure extends Schema.TaggedError<Failure>()("RemoteCliFailure", {
  code: Schema.Literals(["platform", "version", "install"]),
  detail: Schema.String,
}) {
  override get message() {
    return this.detail
  }
}

export function quote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`
}

export function requireVersion(version: string) {
  if (version !== "local" && !/^[0-9][a-zA-Z0-9.+-]*$/.test(version))
    throw new Failure({ code: "version", detail: version })
  return version
}

export function discoverScript(options: { fromPath?: boolean; cache?: { directory: string; prefix: string } } = {}) {
  return `cli=${options.fromPath ? "$(command -v opencode || true)" : '""'}
if [ -z "$cli" ] && [ -x "$HOME/.opencode/bin/opencode" ]; then cli="$HOME/.opencode/bin/opencode"; fi
${
  options.cache
    ? `if [ -z "$cli" ]; then
  for binary in "$HOME"/${quote(options.cache.directory)}/${quote(options.cache.prefix)}*/opencode; do
    if [ -x "$binary" ]; then cli="$binary"; fi
  done
fi
`
    : ""
}if [ -n "$cli" ]; then printf '%s\\n' "$cli"; fi
`
}

// Adapters supply a quoted shell expression, including remote HOME or wslpath expansion.
export function versionScript(command: string) {
  return `if [ -x ${command} ]; then ${command} --version 2>/dev/null || true; fi\n`
}

export function parseVersion(output: string) {
  const line = output
    .split(/\r?\n/)
    .find((line) => line.trim())
    ?.trim()
  return line ? parseCliVersion(line) : null
}

export const probeScript = `set -eu
os=$(uname -s | tr '[:upper:]' '[:lower:]')
arch=$(uname -m)
case "$os" in linux|darwin) ;; *) exit 2 ;; esac
case "$arch" in x86_64|amd64) arch=x64 ;; aarch64|arm64) arch=arm64 ;; *) exit 2 ;; esac
target="$os-$arch"
if [ "$arch" = x64 ]; then target="$target-baseline"; fi
if [ "$os" = linux ]; then
  if [ -f /etc/alpine-release ] || (ldd --version 2>&1 | grep -qi musl); then target="$target-musl"; fi
fi
printf 'OPENCODE_REMOTE_TARGET=%s\\n' "$target"
`

export function archiveUrl(target: string, version: string) {
  if (!/^(linux|darwin)-(x64-baseline|arm64)(-musl)?$/.test(target))
    throw new Failure({ code: "platform", detail: target })
  return `https://registry.npmjs.org/@opencode/cli-${target}/-/cli-${target}-${requireVersion(version)}.tgz`
}

type Source = { type: "download"; url: string } | { type: "archive" } | { type: "installer"; binary?: string }

export function installScript(input: { version: string; directory?: string; source: Source }) {
  const version = requireVersion(input.version)
  // The managed CLI installer also configures the user's shell PATH. Private
  // installations use archives so their destination and shell setup stay isolated.
  if (input.source.type === "installer")
    return `set -eu
curl -fsSL https://raw.githubusercontent.com/anomalyco/opencode/v2/install | bash -s -- ${input.source.binary ? `--binary ${input.source.binary}` : `--version ${quote(version)}`}
${verifyScript('"$HOME/.opencode/bin/opencode"', version)}
`
  return `set -eu
umask 077
destination="$HOME"/${quote(`${input.directory ?? ".opencode/bin"}/opencode`)}
mkdir -p "$(dirname "$destination")"
stage=$(mktemp -d "$(dirname "$destination")/.install-XXXXXX")
trap 'rm -rf "$stage"' EXIT
${stageBinary(input.source)}
chmod 755 "$stage/package/bin/opencode"
${verifyScript('"$stage/package/bin/opencode"', version)}
mv "$stage/package/bin/opencode" "$destination"
`
}

function stageBinary(source: Exclude<Source, { type: "installer" }>) {
  if (source.type === "archive") return 'cat > "$stage/archive.tgz"\ntar -xzf "$stage/archive.tgz" -C "$stage"'
  return `url=${quote(source.url)}
if command -v curl >/dev/null 2>&1; then
  curl -fsSL --connect-timeout 15 --max-time 180 "$url" -o "$stage/archive.tgz"
else
  wget -T 180 -O "$stage/archive.tgz" "$url"
fi
tar -xzf "$stage/archive.tgz" -C "$stage"`
}

function verifyScript(command: string, version: string) {
  return `test "$(${command} --version | awk '{print $NF}' | sed 's/^v//')" = ${quote(version)}`
}

const Beta = Schema.Struct({ version: Schema.String.check(Schema.isPattern(/^0\.0\.0-beta-\d+(?:\.\d+)?$/)) })

export const latestBeta = Effect.fn("RemoteCli.latestBeta")(function* () {
  const http = yield* HttpClient.HttpClient
  const metadata = yield* http.get("https://registry.npmjs.org/@opencode%2fcli/beta").pipe(
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap(HttpClientResponse.schemaBodyJson(Beta)),
    Effect.timeout("30 seconds"),
    Effect.mapError(
      () => new Failure({ code: "install", detail: "https://registry.npmjs.org/@opencode%2fcli/beta" }),
    ),
  )
  return metadata.version
})
