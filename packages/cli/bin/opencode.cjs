#!/usr/bin/env node

const childProcess = require("child_process")
const fs = require("fs")
const path = require("path")
const os = require("os")

const forwardedSignals =
  process.platform === "win32" ? ["SIGINT", "SIGTERM", "SIGHUP"] : ["SIGINT", "SIGTERM", "SIGHUP", "SIGUSR1"]

function run(target) {
  const child = childProcess.spawn(target, process.argv.slice(2), { stdio: "inherit" })
  child.on("error", (error) => {
    console.error(error.message)
    process.exit(1)
  })
  const forwarders = {}
  for (const signal of forwardedSignals) {
    forwarders[signal] = () => {
      try {
        child.kill(signal)
      } catch {}
    }
    process.on(signal, forwarders[signal])
  }
  child.on("exit", (code, signal) => {
    for (const forwardedSignal of forwardedSignals) process.removeListener(forwardedSignal, forwarders[forwardedSignal])
    if (signal) return process.kill(process.pid, signal)
    process.exit(typeof code === "number" ? code : 0)
  })
}

const envPath = process.env.OPENCODE_BIN_PATH
const scriptDir = path.dirname(fs.realpathSync(__filename))
const command = path.basename(__filename).replace(/\.cjs$/, "")
const nodeBuild = command === "opencode-node"
const sourceCommand = nodeBuild ? "opencode2-node" : "opencode"
const cached = path.join(scriptDir, `.${command}`)
const platform = { darwin: "darwin", linux: "linux", win32: "windows" }[os.platform()] || os.platform()
const arch = { x64: "x64", arm64: "arm64", arm: "arm" }[os.arch()] || os.arch()
const base = `@opencode/cli${nodeBuild ? "-node" : ""}-` + platform + "-" + arch
const binary = platform === "windows" ? `${sourceCommand}.exe` : sourceCommand

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
      const result = childProcess.spawnSync("sysctl", ["-n", "hw.optional.avx2_0"], { encoding: "utf8", timeout: 1500 })
      return result.status === 0 && (result.stdout || "").trim() === "1"
    } catch {
      return false
    }
  }
  if (platform === "windows") {
    const command =
      '(Add-Type -MemberDefinition "[DllImport(""kernel32.dll"")] public static extern bool IsProcessorFeaturePresent(int ProcessorFeature);" -Name Kernel32 -Namespace Win32 -PassThru)::IsProcessorFeaturePresent(40)'
    for (const executable of ["powershell.exe", "pwsh.exe", "pwsh", "powershell"]) {
      try {
        const result = childProcess.spawnSync(executable, ["-NoProfile", "-NonInteractive", "-Command", command], {
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

const names = (() => {
  if (nodeBuild) return [base]
  const baseline = arch === "x64" && !supportsAvx2()
  if (platform === "linux") {
    const musl = (() => {
      try {
        if (fs.existsSync("/etc/alpine-release")) return true
        const result = childProcess.spawnSync("ldd", ["--version"], { encoding: "utf8" })
        return ((result.stdout || "") + (result.stderr || "")).toLowerCase().includes("musl")
      } catch {
        return false
      }
    })()
    if (musl)
      return arch === "x64"
        ? baseline
          ? [`${base}-baseline-musl`, `${base}-musl`, `${base}-baseline`, base]
          : [`${base}-musl`, `${base}-baseline-musl`, base, `${base}-baseline`]
        : [`${base}-musl`, base]
    return arch === "x64"
      ? baseline
        ? [`${base}-baseline`, base, `${base}-baseline-musl`, `${base}-musl`]
        : [base, `${base}-baseline`, `${base}-musl`, `${base}-baseline-musl`]
      : [base, `${base}-musl`]
  }
  return arch === "x64" ? (baseline ? [`${base}-baseline`, base] : [base, `${base}-baseline`]) : [base]
})()

function findBinary(startDir) {
  let current = startDir
  for (;;) {
    const modules = path.join(current, "node_modules")
    if (fs.existsSync(modules))
      for (const name of names) {
        const candidate = path.join(modules, name, "bin", binary)
        if (fs.existsSync(candidate)) return candidate
      }
    const parent = path.dirname(current)
    if (parent === current) return
    current = parent
  }
}

const resolved = envPath || (fs.existsSync(cached) ? cached : findBinary(scriptDir))
if (!resolved) {
  console.error(
    `It seems that your package manager failed to install the right ${command} CLI package. Try manually installing ` +
      names.map((name) => `"${name}"`).join(" or ") +
      " package",
  )
  process.exit(1)
}
run(resolved)
