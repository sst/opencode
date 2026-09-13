import { $ } from "bun"
import { chmod, copyFile, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const CLI_VERSION = "dev"

export type Channel = "dev" | "beta" | "prod"

export function resolveChannel(): Channel {
  const raw = Bun.env.OPENCODE_CHANNEL
  if (raw === "dev" || raw === "beta" || raw === "prod") return raw
  if (raw === "latest") return "prod"
  return "dev"
}

export const CLI_BINARIES: Array<{ target: string; package: string; os: string; cpu: string }> = [
  {
    target: "aarch64-apple-darwin",
    package: "@opencode/cli-darwin-arm64",
    os: "darwin",
    cpu: "arm64",
  },
  {
    target: "x86_64-apple-darwin",
    package: "@opencode/cli-darwin-x64-baseline",
    os: "darwin",
    cpu: "x64",
  },
  {
    target: "aarch64-pc-windows-msvc",
    package: "@opencode/cli-windows-arm64",
    os: "win32",
    cpu: "arm64",
  },
  {
    target: "x86_64-pc-windows-msvc",
    package: "@opencode/cli-windows-x64-baseline",
    os: "win32",
    cpu: "x64",
  },
  {
    target: "x86_64-unknown-linux-gnu",
    package: "@opencode/cli-linux-x64-baseline",
    os: "linux",
    cpu: "x64",
  },
  {
    target: "aarch64-unknown-linux-gnu",
    package: "@opencode/cli-linux-arm64",
    os: "linux",
    cpu: "arm64",
  },
]

export const CLI_TARGET = Bun.env.OPENCODE_CLI_TARGET

function nativeTarget() {
  const { platform, arch } = process
  if (platform === "darwin") return arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin"
  if (platform === "win32") return arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc"
  if (platform === "linux") return arch === "arm64" ? "aarch64-unknown-linux-gnu" : "x86_64-unknown-linux-gnu"
  throw new Error(`Unsupported platform: ${platform}/${arch}`)
}

export function getCurrentCli(target = CLI_TARGET ?? nativeTarget()) {
  const binaryConfig = CLI_BINARIES.find((item) => item.target === target)
  if (!binaryConfig) throw new Error(`CLI configuration not available for target '${target}'`)

  return binaryConfig
}

export async function downloadCliToResources(version = CLI_VERSION, dest = windowsify("resources/opencode-cli")) {
  const cli = getCurrentCli()
  const directory = await mkdtemp(join(tmpdir(), "opencode-cli-"))
  try {
    await $`bun install --no-save --cwd ${directory} ${`${cli.package}@${version}`} ${`--os=${cli.os}`} ${`--cpu=${cli.cpu}`}`
    await copyCliToResources(
      join(directory, "node_modules", cli.package, "bin", cli.os === "win32" ? "opencode.exe" : "opencode"),
      dest,
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }

  console.log(`Copied ${cli.package}@${version} to ${dest}`)
}

export async function copyBuiltCliToResources(root: string, dest = windowsify("resources/opencode-cli")) {
  const cli = getCurrentCli()
  const directory = cli.package.replace("@opencode/", "")
  await copyCliToResources(join(root, directory, "bin", cli.os === "win32" ? "opencode.exe" : "opencode"), dest)
}

async function copyCliToResources(source: string, dest: string) {
  await copyFile(source, dest)
  await prepareCli(dest)
}

async function prepareCli(dest: string) {
  if (process.platform !== "win32") await chmod(dest, 0o755)
  if (process.platform === "win32" && process.env.GITHUB_ACTIONS === "true") {
    await $`pwsh -NoLogo -NoProfile -ExecutionPolicy Bypass -File ../../script/sign-windows.ps1 ${dest}`
  }
  if (process.platform === "darwin") await $`codesign --force --sign - ${dest}`
}

export function windowsify(path: string) {
  if (path.endsWith(".exe")) return path
  return `${path}${process.platform === "win32" ? ".exe" : ""}`
}
