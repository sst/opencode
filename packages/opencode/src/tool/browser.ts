import { Effect, Schema } from "effect"
import { existsSync } from "node:fs"
import { mkdtemp, rm } from "fs/promises"
import * as os from "os"
import * as path from "path"
import * as Tool from "./tool"
import DESCRIPTION from "./browser.txt"

const DEFAULT_WIDTH = 1280
const DEFAULT_HEIGHT = 800
const COMMAND_TIMEOUT = 30_000
const NAVIGATION_TIMEOUT = 15_000
const IDLE_TIMEOUT = 10 * 60 * 1000

export const Parameters = Schema.Struct({
  action: Schema.Literals([
    "open",
    "screenshot",
    "click",
    "type",
    "press",
    "scroll",
    "read",
    "back",
    "forward",
    "reload",
    "close",
  ]).annotate({ description: "The action to perform" }),
  url: Schema.optional(Schema.String).annotate({
    description: "URL to open. Required for `open`; missing schemes default to http://",
  }),
  selector: Schema.optional(Schema.String).annotate({
    description: "CSS selector, used by `click`, `type`, `scroll`, and `read`",
  }),
  x: Schema.optional(Schema.Number).annotate({ description: "Viewport x coordinate for `click`" }),
  y: Schema.optional(Schema.Number).annotate({ description: "Viewport y coordinate for `click`" }),
  text: Schema.optional(Schema.String).annotate({ description: "Text to enter with `type`" }),
  key: Schema.optional(Schema.String).annotate({
    description: "Key or combination to press, e.g. `Enter`, `Escape`, `Meta+A`, `Control+Shift+K`",
  }),
  submit: Schema.optional(Schema.Boolean).annotate({ description: "Press Enter after `type`" }),
  fullPage: Schema.optional(Schema.Boolean).annotate({
    description: "Capture the full scrollable page with `screenshot`",
  }),
  headless: Schema.optional(Schema.Boolean).annotate({
    description:
      "Hide the browser window. Defaults to false when a display is available, true otherwise. `OPENCODE_BROWSER_HEADLESS=1` forces headless.",
  }),
  deltaX: Schema.optional(Schema.Number).annotate({ description: "Horizontal scroll amount for `scroll`" }),
  deltaY: Schema.optional(Schema.Number).annotate({
    description: "Vertical scroll amount for `scroll` (default 500)",
  }),
})

type Params = Schema.Schema.Type<typeof Parameters>

interface Pending {
  resolve(value: unknown): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout>
}

interface Connection {
  socket: WebSocket
  nextId: number
  pending: Map<number, Pending>
  closed: boolean
}

interface Browser {
  process: Bun.Subprocess
  directory: string
  connection: Connection
  session: string
  headless: boolean
  idle: ReturnType<typeof setTimeout> | undefined
}

let current: Browser | undefined
let launching: Promise<Browser> | undefined

export function browserCandidates(
  platform: NodeJS.Platform = process.platform,
  env: Record<string, string | undefined> = process.env,
) {
  if (platform === "darwin")
    return [
      env.OPENCODE_BROWSER_PATH,
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
      "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    ].filter((item): item is string => Boolean(item))
  if (platform === "win32") {
    const programFiles = env.PROGRAMFILES
    const programFilesX86 = env["PROGRAMFILES(X86)"]
    const localAppData = env.LOCALAPPDATA
    return [
      env.OPENCODE_BROWSER_PATH,
      programFiles && path.win32.join(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
      programFilesX86 && path.win32.join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"),
      localAppData && path.win32.join(localAppData, "Google", "Chrome", "Application", "chrome.exe"),
      programFiles && path.win32.join(programFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
      programFilesX86 && path.win32.join(programFilesX86, "Microsoft", "Edge", "Application", "msedge.exe"),
    ].filter((item): item is string => Boolean(item))
  }
  return [
    env.OPENCODE_BROWSER_PATH,
    "google-chrome",
    "google-chrome-stable",
    "chromium",
    "chromium-browser",
    "brave-browser",
    "microsoft-edge",
    "microsoft-edge-stable",
  ].filter((item): item is string => Boolean(item))
}

export function normalizeUrl(input: string) {
  const value = input.trim()
  if (!value) throw new Error("`url` is required for the open action")
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value) || /^(about|data|blob|view-source):/i.test(value)) return value
  if (value.startsWith("/")) return `file://${value}`
  return `http://${value}`
}

export function resolveHeadless(
  input?: boolean,
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
) {
  if (input !== undefined) return input
  const configured = env.OPENCODE_BROWSER_HEADLESS
  if (configured !== undefined) return configured !== "0" && configured.toLowerCase() !== "false"
  if (platform === "linux") return !(env.DISPLAY || env.WAYLAND_DISPLAY)
  return false
}

const KEYS: Record<string, { code: string; keyCode: number; key?: string; text?: string }> = {
  enter: { code: "Enter", keyCode: 13, text: "\r" },
  return: { code: "Enter", keyCode: 13, text: "\r" },
  tab: { code: "Tab", keyCode: 9 },
  escape: { code: "Escape", keyCode: 27 },
  backspace: { code: "Backspace", keyCode: 8 },
  delete: { code: "Delete", keyCode: 46 },
  space: { code: "Space", keyCode: 32, key: " ", text: " " },
  home: { code: "Home", keyCode: 36 },
  end: { code: "End", keyCode: 35 },
  pageup: { code: "PageUp", keyCode: 33 },
  pagedown: { code: "PageDown", keyCode: 34 },
  arrowup: { code: "ArrowUp", keyCode: 38 },
  arrowdown: { code: "ArrowDown", keyCode: 40 },
  arrowleft: { code: "ArrowLeft", keyCode: 37 },
  arrowright: { code: "ArrowRight", keyCode: 39 },
}

export function parseKey(input: string) {
  const parts = input
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean)
  const name = parts.pop()
  if (!name) throw new Error(`Invalid key: ${input}`)

  const modifiers = parts.reduce((mask, part) => {
    switch (part.toLowerCase()) {
      case "alt":
        return mask | 1
      case "control":
      case "ctrl":
        return mask | 2
      case "meta":
      case "command":
      case "cmd":
        return mask | 4
      case "shift":
        return mask | 8
      default:
        throw new Error(`Unsupported modifier in key: ${part}`)
    }
  }, 0)

  const special = KEYS[name.toLowerCase()]
  if (special) {
    return {
      key: special.key ?? special.code,
      code: special.code,
      keyCode: special.keyCode,
      modifiers,
      text: special.text,
    }
  }

  if (name.length !== 1) throw new Error(`Unsupported key: ${input}`)
  const upper = name.toUpperCase()
  return {
    key: name,
    code: /[A-Z]/.test(upper) ? `Key${upper}` : /[0-9]/.test(name) ? `Digit${name}` : undefined,
    keyCode: upper.charCodeAt(0),
    modifiers,
    // Control, Alt, and Meta combinations are shortcuts rather than text input.
    text: (modifiers & (1 | 2 | 4)) === 0 ? name : undefined,
  }
}

function request<T>(connection: Connection, method: string, params: Record<string, unknown> = {}, session?: string) {
  if (connection.closed) return Promise.reject(new Error("Browser connection is closed"))
  const id = connection.nextId++
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      connection.pending.delete(id)
      reject(new Error(`Browser command timed out: ${method}`))
    }, COMMAND_TIMEOUT)
    connection.pending.set(id, { resolve: (value) => resolve(value as T), reject, timer })
    connection.socket.send(JSON.stringify({ id, method, params, ...(session ? { sessionId: session } : {}) }))
  })
}

function page<T>(browser: Browser, method: string, params: Record<string, unknown> = {}) {
  return request<T>(browser.connection, method, params, browser.session)
}

function resolveBrowser() {
  for (const candidate of browserCandidates()) {
    if (candidate.includes(path.sep)) {
      if (existsSync(candidate)) return candidate
      continue
    }
    const found = Bun.which(candidate)
    if (found) return found
  }
  throw new Error(
    "No Chrome, Chromium, or Edge installation found. Install one, or point OPENCODE_BROWSER_PATH at the browser binary.",
  )
}

async function waitForPort(child: Bun.Subprocess, directory: string) {
  const file = path.join(directory, "DevToolsActivePort")
  for (let attempt = 0; attempt < 200; attempt++) {
    const text = await Bun.file(file)
      .text()
      .catch(() => undefined)
    if (text) {
      const [port, endpoint] = text.split("\n")
      return { port: Number(port), endpoint }
    }
    if (child.exitCode !== null) throw new Error("Browser exited before the debugging port was ready")
    await Bun.sleep(50)
  }
  throw new Error("Timed out waiting for the browser debugging port")
}

function connect(url: string) {
  return new Promise<WebSocket>((resolve, reject) => {
    const socket = new WebSocket(url)
    const timer = setTimeout(() => {
      socket.close()
      reject(new Error("Timed out connecting to the browser"))
    }, COMMAND_TIMEOUT)
    socket.addEventListener("open", () => {
      clearTimeout(timer)
      resolve(socket)
    })
    socket.addEventListener("error", () => {
      clearTimeout(timer)
      reject(new Error("Failed to connect to the browser"))
    })
  })
}

async function launch(headless: boolean): Promise<Browser> {
  const binary = resolveBrowser()
  const directory = await mkdtemp(path.join(os.tmpdir(), "opencode-browser-"))
  const child = Bun.spawn(
    [
      binary,
      ...(headless ? ["--headless=new"] : []),
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--disable-extensions",
      "--disable-background-networking",
      "--no-first-run",
      "--no-default-browser-check",
      "--hide-scrollbars",
      "--mute-audio",
      "--remote-allow-origins=*",
      "--remote-debugging-port=0",
      `--user-data-dir=${directory}`,
      `--window-size=${DEFAULT_WIDTH},${DEFAULT_HEIGHT}`,
      ...(process.getuid?.() === 0 ? ["--no-sandbox"] : []),
      "about:blank",
    ],
    { stdout: "ignore", stderr: "ignore" },
  )

  const { port, endpoint } = await waitForPort(child, directory)
  const socket = await connect(`ws://127.0.0.1:${port}${endpoint}`)
  const connection: Connection = { socket, nextId: 1, pending: new Map(), closed: false }

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as { id?: number; result?: unknown; error?: { message?: string } }
    if (message.id === undefined) return
    const pending = connection.pending.get(message.id)
    if (!pending) return
    connection.pending.delete(message.id)
    clearTimeout(pending.timer)
    if (message.error) pending.reject(new Error(message.error.message ?? "Browser command failed"))
    else pending.resolve(message.result)
  })

  socket.addEventListener("close", () => {
    connection.closed = true
    for (const pending of connection.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error("Browser connection closed"))
    }
    connection.pending.clear()
  })

  const target = await request<{ targetId: string }>(connection, "Target.createTarget", { url: "about:blank" })
  const attached = await request<{ sessionId: string }>(connection, "Target.attachToTarget", {
    targetId: target.targetId,
    flatten: true,
  })
  const browser: Browser = {
    process: child,
    directory,
    connection,
    session: attached.sessionId,
    headless,
    idle: undefined,
  }
  await page(browser, "Page.enable")
  await page(browser, "Runtime.enable")
  return browser
}

async function ensureBrowser(headless?: boolean): Promise<Browser> {
  // Reuse the running browser unless the caller explicitly asks for a
  // different mode, so a session does not bounce between windowed and hidden.
  if (current && !current.connection.closed && (headless === undefined || current.headless === headless)) {
    touch(current)
    return current
  }
  if (current) await shutdown(current)
  if (!launching) {
    launching = launch(headless ?? resolveHeadless()).finally(() => {
      launching = undefined
    })
  }
  const browser = await launching
  current = browser
  touch(browser)
  return browser
}

function touch(browser: Browser) {
  if (browser.idle) clearTimeout(browser.idle)
  browser.idle = setTimeout(() => void shutdown(browser), IDLE_TIMEOUT)
  browser.idle.unref?.()
}

async function shutdown(browser: Browser) {
  if (current === browser) current = undefined
  if (browser.idle) clearTimeout(browser.idle)
  if (!browser.connection.closed) browser.connection.socket.close()
  browser.process.kill()
  await rm(browser.directory, { recursive: true, force: true }).catch(() => {})
}

process.once("exit", () => {
  if (!current) return
  current.connection.socket.close()
  current.process.kill()
})

async function evaluate<T>(browser: Browser, expression: string): Promise<T> {
  const result = await page<{
    result: { value?: unknown }
    exceptionDetails?: { text: string; exception?: { description?: string } }
  }>(browser, "Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })
  if (result.exceptionDetails)
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
  return result.result.value as T
}

async function waitForReady(browser: Browser) {
  const started = Date.now()
  while (Date.now() - started < NAVIGATION_TIMEOUT) {
    const state = await evaluate<string>(browser, "document.readyState").catch(() => undefined)
    if (state === "complete") return
    await Bun.sleep(100)
  }
}

async function pressKey(browser: Browser, input: string) {
  const key = parseKey(input)
  const event = {
    key: key.key,
    code: key.code,
    windowsVirtualKeyCode: key.keyCode,
    modifiers: key.modifiers,
  }
  await page(browser, "Input.dispatchKeyEvent", { type: "keyDown", ...event, text: key.text })
  await page(browser, "Input.dispatchKeyEvent", { type: "keyUp", ...event })
}

async function elementCenter(browser: Browser, selector: string) {
  const point = await evaluate<{ x: number; y: number } | null>(
    browser,
    `(() => {
      const element = document.querySelector(${JSON.stringify(selector)})
      if (!element) return null
      element.scrollIntoView({ block: "center", inline: "center" })
      const rect = element.getBoundingClientRect()
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
    })()`,
  )
  if (!point) throw new Error(`No element matched selector: ${selector}`)
  return point
}

async function screenshot(browser: Browser, note: string, fullPage = false): Promise<Tool.ExecuteResult> {
  const shot = await page<{ data: string }>(browser, "Page.captureScreenshot", {
    format: "jpeg",
    quality: 80,
    fromSurface: true,
    captureBeyondViewport: fullPage,
  })
  const info = await evaluate<{ url: string; title: string }>(
    browser,
    "({ url: location.href, title: document.title })",
  )
  return {
    title: info.title || info.url || note,
    output: `${note}\nURL: ${info.url}\nTitle: ${info.title}\nA screenshot of the page is attached.`,
    metadata: { url: info.url, title: info.title },
    attachments: [
      {
        type: "file" as const,
        mime: "image/jpeg",
        url: `data:image/jpeg;base64,${shot.data}`,
      },
    ],
  }
}

async function execute(browser: Browser, params: Params): Promise<Tool.ExecuteResult> {
  switch (params.action) {
    case "open": {
      const url = normalizeUrl(params.url ?? "")
      const result = await page<{ errorText?: string }>(browser, "Page.navigate", { url })
      if (result.errorText) throw new Error(`Could not open ${url}: ${result.errorText}`)
      await waitForReady(browser)
      await Bun.sleep(250)
      return screenshot(browser, `Opened ${url}`)
    }

    case "screenshot":
      return screenshot(browser, "Screenshot", params.fullPage)

    case "click": {
      if (params.x === undefined && !params.selector) throw new Error("`selector` or `x`/`y` are required for click")
      const point =
        params.x !== undefined && params.y !== undefined
          ? { x: params.x, y: params.y }
          : await elementCenter(browser, params.selector ?? "")
      await page(browser, "Input.dispatchMouseEvent", {
        type: "mousePressed",
        x: point.x,
        y: point.y,
        button: "left",
        buttons: 1,
        clickCount: 1,
      })
      await page(browser, "Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: point.x,
        y: point.y,
        button: "left",
        buttons: 0,
        clickCount: 1,
      })
      await Bun.sleep(300)
      return screenshot(browser, params.selector ? `Clicked ${params.selector}` : `Clicked ${point.x},${point.y}`)
    }

    case "type": {
      if (params.text === undefined) throw new Error("`text` is required for type")
      if (params.selector) {
        const selector = params.selector
        const focused = await evaluate<boolean>(
          browser,
          `(() => {
            const element = document.querySelector(${JSON.stringify(selector)})
            if (!element) return false
            element.focus()
            return true
          })()`,
        )
        if (!focused) throw new Error(`No element matched selector: ${selector}`)
      }
      await page(browser, "Input.insertText", { text: params.text })
      if (params.submit) await pressKey(browser, "Enter")
      await Bun.sleep(300)
      return screenshot(browser, params.submit ? "Typed text and pressed Enter" : "Typed text")
    }

    case "press": {
      if (!params.key) throw new Error("`key` is required for press")
      await pressKey(browser, params.key)
      await Bun.sleep(300)
      return screenshot(browser, `Pressed ${params.key}`)
    }

    case "scroll": {
      if (params.selector) {
        await elementCenter(browser, params.selector)
      } else {
        const viewport = await evaluate<{ width: number; height: number }>(
          browser,
          "({ width: innerWidth, height: innerHeight })",
        )
        await page(browser, "Input.dispatchMouseEvent", {
          type: "mouseWheel",
          x: viewport.width / 2,
          y: viewport.height / 2,
          deltaX: params.deltaX ?? 0,
          deltaY: params.deltaY ?? 500,
        })
      }
      await Bun.sleep(300)
      return screenshot(browser, "Scrolled")
    }

    case "read": {
      const text = await evaluate<string>(
        browser,
        params.selector
          ? `document.querySelector(${JSON.stringify(params.selector)})?.innerText ?? ""`
          : `document.body?.innerText ?? ""`,
      )
      const info = await evaluate<{ url: string; title: string }>(
        browser,
        "({ url: location.href, title: document.title })",
      )
      return {
        title: info.title || info.url || "Page content",
        output: `URL: ${info.url}\nTitle: ${info.title}\n\n${text || "(no text content)"}`,
        metadata: { url: info.url, title: info.title },
      }
    }

    case "back":
    case "forward":
    case "reload": {
      const expression =
        params.action === "back"
          ? "history.back()"
          : params.action === "forward"
            ? "history.forward()"
            : "location.reload()"
      // Navigation destroys the execution context, so an evaluate error here is
      // expected; the page state is checked by `waitForReady` instead.
      await evaluate(browser, expression).catch(() => {})
      await waitForReady(browser)
      await Bun.sleep(250)
      return screenshot(
        browser,
        params.action === "back" ? "Went back" : params.action === "forward" ? "Went forward" : "Reloaded",
      )
    }

    case "close":
      if (current === browser) await shutdown(browser)
      return { title: "Browser closed", output: "Closed the browser.", metadata: {} }
  }

  throw new Error("Unsupported browser action")
}

export const BrowserTool = Tool.define(
  "browser",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Params, ctx: Tool.Context) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: "browser",
            patterns: [params.action],
            always: ["*"],
            metadata: {
              action: params.action,
              url: params.url,
              selector: params.selector,
            },
          })
          return yield* Effect.tryPromise({
            try: async () => {
              if (params.action === "close" && !current) {
                return { title: "Browser closed", output: "No browser was running.", metadata: {} }
              }
              const browser = await ensureBrowser(params.headless)
              return execute(browser, params)
            },
            catch: (error) => (error instanceof Error ? error : new Error(String(error))),
          })
        }).pipe(Effect.orDie),
    }
  }),
)
