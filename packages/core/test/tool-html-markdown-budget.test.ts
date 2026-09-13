import { expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import { MAX_MARKDOWN_BYTES } from "../src/tool/html-markdown"

const budget = MAX_MARKDOWN_BYTES - 64 * 1024

test.each([
  ["exhausted budget", budget, "x", "", false],
  ["one byte short of an empty fence", budget - 13, "x", "", false],
  ["small fitting block", 64, "x", "\n\n```\nx\n```", false],
  ["last payload byte fits", budget - 15, "x", "\n\n```\nx\n```", false],
  ["only an empty fence fits", budget - 14, "x", "\n\n```\n\n```", false],
  ["Unicode payload truncates at a code point", budget - 18, "😀é", "\n\n```\n😀\n```", false],
  ["quoted payload fits", budget - 23, "x", "\n\n> ```\n> x\n> ```", true],
  ["only an empty quoted fence fits", budget - 22, "x", "\n\n> ```\n> \n> ```", true],
  ["one byte short of an empty quoted fence", budget - 21, "x", "", true],
] as const)(
  "finishes bounded code conversion: %s",
  async (_name, count, payload, suffix, quoted) => {
    const code = `<pre>${payload}</pre>`
    const html = `<p>${"x".repeat(count)}</p>${quoted ? `<blockquote>${code}</blockquote>` : code}`
    expect(Buffer.byteLength(html)).toBeLessThanOrEqual(MAX_MARKDOWN_BYTES)
    const child = Bun.spawn({
      cmd: [process.execPath, fileURLToPath(new URL("./fixture/html-markdown.ts", import.meta.url))],
      stdin: new Blob([html]),
      stdout: "pipe",
      stderr: "pipe",
    })
    let ready = false
    let timeout: "startup" | "conversion" | undefined
    let timer = setTimeout(() => {
      timeout = "startup"
      child.kill("SIGKILL")
    }, 10_000)
    const stdout = (async () => {
      let output = ""
      for await (const chunk of child.stdout.pipeThrough(new TextDecoderStream())) {
        output += chunk
        if (ready || !output.startsWith("ready\n")) continue
        ready = true
        clearTimeout(timer)
        // This watchdog runs outside the possibly stuck synchronous converter.
        timer = setTimeout(() => {
          timeout = "conversion"
          child.kill("SIGKILL")
        }, 3_000)
      }
      return output.slice("ready\n".length)
    })()
    const stderr = new Response(child.stderr).text()
    try {
      const exitCode = await child.exited
      const output = await stdout
      expect({ ready, timeout, exitCode, stderr: await stderr }).toEqual({
        ready: true,
        timeout: undefined,
        exitCode: 0,
        stderr: "",
      })
      expect(Buffer.byteLength(output)).toBeLessThanOrEqual(MAX_MARKDOWN_BYTES)
      expect(output).toBe("x".repeat(Math.min(count, budget - 2)) + suffix)
    } finally {
      clearTimeout(timer)
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
      await child.exited
    }
  },
  15_000,
)
