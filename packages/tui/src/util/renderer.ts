import type { CliRenderer } from "@opentui/core"

// Written synchronously so it can also run from `process.on("exit")`, where
// async renderer teardown is not guaranteed to have flushed before exit.
// Prevents ConPTY stacks (e.g. Alacritty + zellij) being left with leaked
// raw-mode escape sequences (opencode #45938 / #48776).
const TERMINAL_RESET = [
  "\x1b[0m",
  "\x1b[?25h",
  "\x1b[?1l",
  "\x1b[?1000l",
  "\x1b[?1002l",
  "\x1b[?1003l",
  "\x1b[?1006l",
  "\x1b[<u",
  "\x1b[?1049l",
].join("")

function stdoutIsTty(): boolean {
  try {
    return typeof process.stdout.write === "function" && process.stdout.isTTY
  } catch {
    return false
  }
}

export function terminalReset(): void {
  if (!stdoutIsTty()) return
  try {
    process.stdout.write(TERMINAL_RESET)
  } catch {
    // best-effort teardown; never let the reset throw across exit paths
  }
}

export function destroyRenderer(renderer: Pick<CliRenderer, "isDestroyed" | "setTerminalTitle" | "destroy">) {
  renderer.setTerminalTitle("")
  if (renderer.isDestroyed) return
  renderer.destroy()
  terminalReset()
}
