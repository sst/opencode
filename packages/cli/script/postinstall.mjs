#!/usr/bin/env node

import childProcess from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"

const directory = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const packageJson = JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8"))
const command = Object.keys(packageJson.bin ?? {})[0]
if (!command) throw new Error("OpenCode package does not declare a binary")
const sourceCommand = packageJson.opencodeSourceBinary ?? command

const platform = { darwin: "darwin", linux: "linux", win32: "windows" }[os.platform()] ?? os.platform()
const arch = { x64: "x64", arm64: "arm64", arm: "arm" }[os.arch()] ?? os.arch()
const sourceBinary = platform === "windows" ? `${sourceCommand}.exe` : sourceCommand
const targetBinary = path.resolve(directory, packageJson.bin[command])
const dependencies = packageJson.optionalDependencies ?? {}
const base = Object.keys(dependencies).find((name) => name.endsWith(`-${platform}-${arch}`))
if (!base) throw new Error(`OpenCode does not provide a binary for ${platform}-${arch}`)

function supportsAvx2() {
  if (arch !== "x64") return false
  if (platform === "linux") {
    try {
      return /(^|\s)avx2(\s|$)/i.test(fs.readFileSync("/proc/cpuinfo", "utf8"))
    } catch {
      return false
    }
  }
  if (platform === "darwin") {
    try {
      const result = childProcess.spawnSync("sysctl", ["-n", "hw.optional.avx2_0"], {
        encoding: "utf8",
        timeout: 1500,
      })
      return result.status === 0 && (result.stdout || "").trim() === "1"
    } catch {
      return false
    }
  }
  if (platform === "windows") {
    const script =
      '(Add-Type -MemberDefinition "[DllImport(""kernel32.dll"")] public static extern bool IsProcessorFeaturePresent(int ProcessorFeature);" -Name Kernel32 -Namespace Win32 -PassThru)::IsProcessorFeaturePresent(40)'
    for (const executable of ["powershell.exe", "pwsh.exe", "pwsh", "powershell"]) {
      try {
        const result = childProcess.spawnSync(executable, ["-NoProfile", "-NonInteractive", "-Command", script], {
          encoding: "utf8",
          timeout: 3000,
          windowsHide: true,
        })
        if (result.status !== 0) continue
        const output = (result.stdout || "").trim().toLowerCase()
        if (output === "true" || output === "1") return true
        if (output === "false" || output === "0") return false
      } catch {
        continue
      }
    }
  }
  return false
}

function isMusl() {
  if (platform !== "linux") return false
  try {
    if (fs.existsSync("/etc/alpine-release")) return true
    const result = childProcess.spawnSync("ldd", ["--version"], { encoding: "utf8" })
    return `${result.stdout || ""}${result.stderr || ""}`.toLowerCase().includes("musl")
  } catch {
    return false
  }
}

function packageNames() {
  const baseline = arch === "x64" && !supportsAvx2()
  const names =
    platform === "linux"
      ? isMusl()
        ? arch === "x64"
          ? baseline
            ? [`${base}-baseline-musl`, `${base}-musl`, `${base}-baseline`, base]
            : [`${base}-musl`, `${base}-baseline-musl`, base, `${base}-baseline`]
          : [`${base}-musl`, base]
        : arch === "x64"
          ? baseline
            ? [`${base}-baseline`, base, `${base}-baseline-musl`, `${base}-musl`]
            : [base, `${base}-baseline`, `${base}-musl`, `${base}-baseline-musl`]
          : [base, `${base}-musl`]
      : arch === "x64"
        ? baseline
          ? [`${base}-baseline`, base]
          : [base, `${base}-baseline`]
        : [base]
  return names.filter((name) => dependencies[name])
}

function copyBinary(source) {
  if (!fs.existsSync(source)) throw new Error(`Binary not found at ${source}`)
  fs.mkdirSync(path.dirname(targetBinary), { recursive: true })
  if (fs.existsSync(targetBinary)) {
    try {
      fs.unlinkSync(targetBinary)
    } catch {}
  }
  try {
    fs.linkSync(source, targetBinary)
  } catch {
    fs.copyFileSync(source, targetBinary)
  }
  fs.chmodSync(targetBinary, 0o755)
}

function resolveBinary(name) {
  const packagePath = require.resolve(`${name}/package.json`)
  return path.join(path.dirname(packagePath), "bin", sourceBinary)
}

function installPackage(name) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-install-"))
  try {
    const result = childProcess.spawnSync(
      "npm",
      [
        "install",
        "--ignore-scripts",
        "--no-save",
        "--loglevel=error",
        "--prefix",
        temp,
        `${name}@${dependencies[name]}`,
      ],
      { stdio: "inherit", windowsHide: true },
    )
    if (result.status !== 0) return false
    copyBinary(path.join(temp, "node_modules", name, "bin", sourceBinary))
    return true
  } finally {
    fs.rmSync(temp, { recursive: true, force: true })
  }
}

function verifyBinary() {
  return (
    childProcess.spawnSync(targetBinary, ["--version"], {
      stdio: "ignore",
      windowsHide: true,
    }).status === 0
  )
}

function main() {
  const names = packageNames()
  for (const name of names) {
    try {
      copyBinary(resolveBinary(name))
      if (verifyBinary()) return
    } catch {
      if (installPackage(name) && verifyBinary()) return
    }
  }

  throw new Error(
    `Failed to install OpenCode. Try manually installing ${names.map((name) => JSON.stringify(name)).join(" or ")}.`,
  )
}

try {
  main()
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}
