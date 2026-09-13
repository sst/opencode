import { describe, expect, test } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { existsSync } from "node:fs"
import path from "path"
import { Effect } from "effect"
import { Agent } from "../../src/agent/agent"
import { Truncate } from "@/tool/truncate"
import { BrowserTool, browserCandidates, normalizeUrl, parseKey, resolveHeadless } from "../../src/tool/browser"
import { MessageID, SessionID } from "../../src/session/schema"
import type { Tool } from "../../src/tool/tool"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([Truncate.node, Agent.node])))

const hasBrowser = browserCandidates().some((candidate) =>
  candidate.includes(path.sep) ? existsSync(candidate) : Boolean(Bun.which(candidate)),
)

const ctx: Tool.Context = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

describe("tool.browser", () => {
  test("normalizeUrl keeps explicit schemes", () => {
    expect(normalizeUrl("https://example.com")).toBe("https://example.com")
    expect(normalizeUrl("http://localhost:5173")).toBe("http://localhost:5173")
    expect(normalizeUrl("file:///tmp/index.html")).toBe("file:///tmp/index.html")
  })

  test("normalizeUrl defaults bare hosts to http and paths to file URLs", () => {
    expect(normalizeUrl("localhost:5173")).toBe("http://localhost:5173")
    expect(normalizeUrl("example.com")).toBe("http://example.com")
    expect(normalizeUrl("/tmp/index.html")).toBe("file:///tmp/index.html")
    expect(normalizeUrl("  localhost:3000  ")).toBe("http://localhost:3000")
  })

  test("normalizeUrl rejects empty input", () => {
    expect(() => normalizeUrl("")).toThrow()
  })

  test("parseKey returns key metadata for named keys", () => {
    expect(parseKey("Enter")).toEqual({ key: "Enter", code: "Enter", keyCode: 13, modifiers: 0, text: "\r" })
    expect(parseKey("Escape")).toEqual({ key: "Escape", code: "Escape", keyCode: 27, modifiers: 0, text: undefined })
    expect(parseKey("ArrowDown")).toEqual({
      key: "ArrowDown",
      code: "ArrowDown",
      keyCode: 40,
      modifiers: 0,
      text: undefined,
    })
  })

  test("parseKey maps modifiers", () => {
    expect(parseKey("Meta+A")).toEqual({ key: "A", code: "KeyA", keyCode: 65, modifiers: 4, text: undefined })
    expect(parseKey("Control+Shift+K")).toEqual({
      key: "K",
      code: "KeyK",
      keyCode: 75,
      modifiers: 2 | 8,
      text: undefined,
    })
    expect(parseKey("Shift+Enter")).toEqual({
      key: "Enter",
      code: "Enter",
      keyCode: 13,
      modifiers: 8,
      text: "\r",
    })
  })

  test("parseKey types plain characters and rejects unknown keys", () => {
    expect(parseKey("a")).toEqual({ key: "a", code: "KeyA", keyCode: 65, modifiers: 0, text: "a" })
    expect(parseKey("1")).toEqual({ key: "1", code: "Digit1", keyCode: 49, modifiers: 0, text: "1" })
    expect(() => parseKey("Nope")).toThrow()
    expect(() => parseKey("Hyper+A")).toThrow()
  })

  test("browserCandidates prefers OPENCODE_BROWSER_PATH", () => {
    const env = { OPENCODE_BROWSER_PATH: "/opt/custom/chrome" }
    expect(browserCandidates("darwin", env)[0]).toBe("/opt/custom/chrome")
    expect(browserCandidates("linux", env)[0]).toBe("/opt/custom/chrome")
    expect(browserCandidates("win32", env)[0]).toBe("/opt/custom/chrome")
  })

  test("browserCandidates includes platform-specific locations", () => {
    expect(browserCandidates("darwin", {})).toContain("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
    expect(browserCandidates("linux", {})).toContain("google-chrome")
    expect(browserCandidates("win32", { PROGRAMFILES: "C:\\Program Files" })).toContain(
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    )
  })

  test("resolveHeadless prefers the explicit argument", () => {
    expect(resolveHeadless(true, {})).toBe(true)
    expect(resolveHeadless(false, { OPENCODE_BROWSER_HEADLESS: "1" })).toBe(false)
  })

  test("resolveHeadless honors the environment override", () => {
    expect(resolveHeadless(undefined, { OPENCODE_BROWSER_HEADLESS: "1" })).toBe(true)
    expect(resolveHeadless(undefined, { OPENCODE_BROWSER_HEADLESS: "0" })).toBe(false)
    expect(resolveHeadless(undefined, { OPENCODE_BROWSER_HEADLESS: "false" })).toBe(false)
  })

  test("resolveHeadless shows the window when a display is available", () => {
    expect(resolveHeadless(undefined, {}, "darwin")).toBe(false)
    expect(resolveHeadless(undefined, { DISPLAY: ":0" }, "linux")).toBe(false)
    expect(resolveHeadless(undefined, { WAYLAND_DISPLAY: "wayland-0" }, "linux")).toBe(false)
    expect(resolveHeadless(undefined, {}, "linux")).toBe(true)
  })

  const integration = hasBrowser ? it.instance : it.instance.skip
  integration(
    "opens a page, reads it, and captures screenshots",
    () =>
      Effect.gen(function* () {
        const info = yield* BrowserTool
        const tool = yield* info.init()
        const page = "data:text/html,<title>Hello</title><h1>Hi there</h1><a href=%22about:blank%22>link</a>"
        const opened = yield* tool.execute({ action: "open", url: page, headless: true }, ctx)
        expect(opened.attachments?.length).toBe(1)
        expect(opened.attachments?.[0].mime).toBe("image/jpeg")
        expect(opened.attachments?.[0].url.startsWith("data:image/jpeg;base64,")).toBe(true)

        const read = yield* tool.execute({ action: "read", selector: "h1" }, ctx)
        expect(read.output).toContain("Hi there")

        const clicked = yield* tool.execute({ action: "click", selector: "a" }, ctx)
        expect(clicked.attachments?.length).toBe(1)

        yield* tool.execute({ action: "close" }, ctx)
      }),
    { timeout: 60_000 },
  )
})
