#!/usr/bin/env bun
import { Script } from "@opencode/script"
import { $ } from "bun"
import { mkdir, rm } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { UpdateArtifact } from "../../../script/update-artifact"

if (Script.channel !== "beta") throw new Error("AUR publishing requires the beta channel")
const name = "opencode-beta"
const command = "opencode"
if (!/^\d+\.\d+\.\d+-beta[.-]\d+(?:\.\d+)?$/.test(Script.version)) throw new Error("Expected a beta release version")

const dir = fileURLToPath(new URL("..", import.meta.url))
const root = path.resolve(process.env.OPENCODE_CLI_DIST ?? path.join(dir, "dist"))
const outdir = path.join(root, `aur-${name}`)
const dryRun = process.argv.includes("--dry-run")
const pkgver = Script.version.replaceAll("-", ".")
const license = Bun.file(path.join(dir, "..", "..", "LICENSE"))
const shim = `#!/bin/sh
exec "$(dirname "$0")/opencode" "$@"
`

await rm(outdir, { recursive: true, force: true })
await mkdir(path.dirname(outdir), { recursive: true })
if (dryRun) await mkdir(outdir)
if (!dryRun) {
  await $`git clone ${`ssh://aur@aur.archlinux.org/${name}.git`} ${outdir}`
  await $`git checkout -B master`.cwd(outdir)
}

const sources = await Promise.all(
  [
    { arch: "x86_64", target: "linux-x64-baseline" },
    { arch: "aarch64", target: "linux-arm64" },
  ].map(async (item) => {
    const directory = path.join(root, `cli-${item.target}`)
    const pkg: { name: string; version: string } = await Bun.file(path.join(directory, "package.json")).json()
    if (pkg.version !== Script.version) throw new Error(`Unexpected version for ${pkg.name}: ${pkg.version}`)
    const archive = Bun.file(path.join(directory, `${pkg.name.replace("@", "").replace("/", "-")}-${pkg.version}.tgz`))
    const filename = `${name}-${pkgver}-${item.arch}.tgz`
    const url = `https://registry.npmjs.org/${pkg.name}/-/${pkg.name.split("/").at(-1)}-${pkg.version}.tgz`
    const sha256 = new Bun.CryptoHasher("sha256").update(await archive.arrayBuffer()).digest("hex")
    return [`source_${item.arch}=('${filename}::${url}')`, `sha256sums_${item.arch}=('${sha256}')`].join("\n")
  }),
)

await Bun.write(path.join(outdir, "LICENSE"), license)
await Bun.write(path.join(outdir, "opencode2"), shim)
await Bun.write(
  path.join(outdir, "PKGBUILD"),
  [
    "# Maintainer: Dax <mail@thdxr.com>",
    `pkgname=${name}`,
    `pkgver=${pkgver}`,
    "pkgrel=1",
    "pkgdesc='OpenCode beta - the AI coding agent for the terminal'",
    "url='https://github.com/anomalyco/opencode'",
    "arch=('x86_64' 'aarch64')",
    "license=('MIT')",
    "depends=('glibc' 'gcc-libs' 'ripgrep')",
    `provides=('${command}' 'opencode2')`,
    `conflicts=('${command}' 'opencode2')`,
    // Stripping a compiled Bun executable can damage its embedded application.
    "options=('!strip' '!debug')",
    "source=('LICENSE' 'opencode2')",
    `sha256sums=('${new Bun.CryptoHasher("sha256").update(await license.arrayBuffer()).digest("hex")}' '${new Bun.CryptoHasher("sha256").update(shim).digest("hex")}')`,
    ...sources,
    "",
    "package() {",
    `  install -Dm755 "$srcdir/package/bin/opencode" "$pkgdir/usr/bin/${command}"`,
    '  install -Dm755 "$srcdir/opencode2" "$pkgdir/usr/bin/opencode2"',
    '  install -Dm644 "$srcdir/LICENSE" "$pkgdir/usr/share/licenses/$pkgname/LICENSE"',
    "}",
    "",
  ].join("\n"),
)
await Bun.write(path.join(outdir, ".SRCINFO"), await $`makepkg --printsrcinfo`.cwd(outdir).text())
console.log(`Prepared ${name} ${pkgver} in ${outdir}`)
if (dryRun) process.exit(0)

await $`git add PKGBUILD .SRCINFO LICENSE opencode2`.cwd(outdir)
if ((await $`git diff --cached --quiet`.cwd(outdir).nothrow()).exitCode !== 0) {
  await $`git commit -m ${`chore: update ${name} to ${pkgver}`}`.cwd(outdir)
  await $`git push origin master`.cwd(outdir)
}
await UpdateArtifact.publish({
  channel: Script.channel,
  name: "cli",
  distribution: "aur",
  version: Script.version,
  metadata: { package: name },
})
