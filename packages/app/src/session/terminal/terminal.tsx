import { withAlpha } from "@opencode/ui/theme/color"
import { useTheme } from "@opencode/ui/theme/context"
import { resolveThemeVariant } from "@opencode/ui/theme/resolve"
import { resolveThemeVariantV2 } from "@opencode/ui/theme/v2/resolve"
import type { HexColor, ResolvedV2Theme } from "@opencode/ui/theme/types"
import { showToast } from "@/shell/notifications/toast"
import type { FitAddon, Ghostty, Terminal as Term } from "ghostty-web"
import { type ComponentProps, createEffect, createMemo, onCleanup, onMount, splitProps } from "solid-js"
import { SerializeAddon } from "@/session/terminal/serialize"
import { matchKeybind, parseKeybind } from "@/shell/commands/command"
import { useLanguage } from "@/runtime/i18n/language"
import { usePlatform } from "@/runtime/platform/platform"
import { useWorkspaceLocation } from "@/workspaces/location"
import { useServerSDK } from "@/runtime/server/client"
import { terminalFontFamily, useSettings } from "@/settings/model"
import type { LocalPTY } from "@/session/terminal/context"
import { disposeIfDisposable, getHoveredLinkText, setOptionIfSupported } from "@/session/terminal/runtime-adapters"
import { terminalKeyInput } from "@/session/terminal/terminal-key-event"
import { terminalWriter } from "@/session/terminal/writer"

const TOGGLE_TERMINAL_ID = "terminal.toggle"
const DEFAULT_TOGGLE_TERMINAL_KEYBIND = "ctrl+`"
// Serialization on unmount is a synchronous O(rows x cols) walk on the main thread and the
// result is written to localStorage or desktop state for every terminal in the workspace.
// Persisting the most recent 2k scrollback rows keeps restore fidelity for the history users
// actually scroll back through while capping teardown cost and snapshot size; the live
// terminal keeps its full 10k scrollback while mounted.
const persistedScrollbackRows = 2_000
export interface TerminalProps extends ComponentProps<"div"> {
  pty: LocalPTY
  autoFocus?: boolean
  onAutoFocus?: () => void
  onSubmit?: () => void
  onCleanup?: (pty: Partial<LocalPTY> & { id: string }) => void
  onConnect?: () => void
  onConnectError?: (error: unknown) => void
}

let shared: Promise<{ mod: typeof import("ghostty-web"); ghostty: Ghostty }> | undefined

const loadGhostty = () => {
  if (shared) return shared
  shared = import("ghostty-web")
    .then(async (mod) => ({ mod, ghostty: await mod.Ghostty.load() }))
    .catch((err) => {
      shared = undefined
      throw err
    })
  return shared
}

type TerminalColors = {
  background: string
  foreground: string
  cursor: string
  selectionBackground: string
}

const DEFAULT_TERMINAL_COLORS: Record<"light" | "dark", TerminalColors> = {
  light: {
    background: "#fcfcfc",
    foreground: "#211e1e",
    cursor: "#211e1e",
    selectionBackground: withAlpha("#211e1e", 0.2),
  },
  dark: {
    background: "#191515",
    foreground: "#d4d4d4",
    cursor: "#d4d4d4",
    selectionBackground: withAlpha("#d4d4d4", 0.25),
  },
}

const debugTerminal = (...values: unknown[]) => {
  if (!import.meta.env.DEV) return
  console.debug("[terminal]", ...values)
}

const resolveV2Token = (tokens: ResolvedV2Theme, key: string) => {
  let current = tokens[key]
  for (let i = 0; i < 8 && current; i++) {
    const match = /^var\(--([^)]+)\)$/.exec(current.trim())
    if (!match) {
      const hex = current.trim()
      if (/^#[0-9a-fA-F]{8}$/.test(hex)) return hex.slice(0, 7)
      return hex
    }
    current = tokens[match[1]]
  }
}

const useTerminalUiBindings = (input: {
  container: HTMLDivElement
  term: Term
  cleanups: VoidFunction[]
  handlePointerDown: () => void
  handleLinkClick: (event: MouseEvent) => void
}) => {
  const handleCopy = (event: ClipboardEvent) => {
    const selection = input.term.getSelection()
    if (!selection) return

    const clipboard = event.clipboardData
    if (!clipboard) return

    event.preventDefault()
    clipboard.setData("text/plain", selection)
  }

  const handlePaste = (event: ClipboardEvent) => {
    const clipboard = event.clipboardData
    const text = clipboard?.getData("text/plain") ?? clipboard?.getData("text") ?? ""
    if (!text) return

    event.preventDefault()
    event.stopPropagation()
    input.term.paste(text)
  }

  const handleTextareaFocus = () => {
    input.term.options.cursorBlink = true
  }
  const handleTextareaBlur = () => {
    input.term.options.cursorBlink = false
  }

  input.container.addEventListener("copy", handleCopy, true)
  input.cleanups.push(() => input.container.removeEventListener("copy", handleCopy, true))

  input.container.addEventListener("paste", handlePaste, true)
  input.cleanups.push(() => input.container.removeEventListener("paste", handlePaste, true))

  input.container.addEventListener("pointerdown", input.handlePointerDown)
  input.cleanups.push(() => input.container.removeEventListener("pointerdown", input.handlePointerDown))

  input.container.addEventListener("click", input.handleLinkClick, {
    capture: true,
  })
  input.cleanups.push(() =>
    input.container.removeEventListener("click", input.handleLinkClick, {
      capture: true,
    }),
  )

  input.term.textarea?.addEventListener("focus", handleTextareaFocus)
  input.term.textarea?.addEventListener("blur", handleTextareaBlur)
  input.cleanups.push(() => input.term.textarea?.removeEventListener("focus", handleTextareaFocus))
  input.cleanups.push(() => input.term.textarea?.removeEventListener("blur", handleTextareaBlur))
}

const persistTerminal = (input: {
  term: Term | undefined
  addon: SerializeAddon | undefined
  cursor: number
  id: string
  onCleanup?: (pty: Partial<LocalPTY> & { id: string }) => void
}) => {
  if (!input.addon || !input.onCleanup || !input.term) return
  const buffer = (() => {
    try {
      return input.addon.serialize({ scrollback: persistedScrollbackRows })
    } catch {
      debugTerminal("failed to serialize terminal buffer")
      return ""
    }
  })()

  input.onCleanup({
    id: input.id,
    buffer,
    cursor: input.cursor,
    rows: input.term.rows,
    cols: input.term.cols,
    scrollY: input.term.getViewportY(),
  })
}

export const Terminal = (props: TerminalProps) => {
  const platform = usePlatform()
  const sdk = useWorkspaceLocation()
  const serverSDK = useServerSDK()
  const settings = useSettings()
  const theme = useTheme()
  const language = useLanguage()
  // Intentional mount-time capture: the imperative xterm/WebSocket lifecycle needs stable values, and Terminal remounts when the SDK scope changes.
  const directory = sdk().directory
  let container!: HTMLDivElement
  const [local, others] = splitProps(props, [
    "pty",
    "class",
    "classList",
    "autoFocus",
    "onAutoFocus",
    "onConnect",
    "onConnectError",
  ])
  const id = local.pty.id
  const restore = typeof local.pty.buffer === "string" ? local.pty.buffer : ""
  const restoreSize =
    restore &&
    typeof local.pty.cols === "number" &&
    Number.isSafeInteger(local.pty.cols) &&
    local.pty.cols > 0 &&
    typeof local.pty.rows === "number" &&
    Number.isSafeInteger(local.pty.rows) &&
    local.pty.rows > 0
      ? { cols: local.pty.cols, rows: local.pty.rows }
      : undefined
  const scrollY = typeof local.pty.scrollY === "number" ? local.pty.scrollY : undefined
  let ws: WebSocket | undefined
  let term: Term | undefined
  let _ghostty: Ghostty
  let serializeAddon: SerializeAddon
  let fitAddon: FitAddon
  let handleResize: () => void
  let fitFrame: number | undefined
  let sizeTimer: ReturnType<typeof setTimeout> | undefined
  let pendingSize: { cols: number; rows: number } | undefined
  let lastSize: { cols: number; rows: number } | undefined
  let disposed = false
  const cleanups: VoidFunction[] = []
  const start =
    typeof local.pty.cursor === "number" && Number.isSafeInteger(local.pty.cursor) ? local.pty.cursor : undefined
  let cursor = start ?? 0
  let seek = start !== undefined ? start : restore ? -1 : 0
  let output: ReturnType<typeof terminalWriter> | undefined
  let drop: VoidFunction | undefined
  let reconn: ReturnType<typeof setTimeout> | undefined
  let tries = 0
  let revealed = false

  const reveal = () => {
    if (revealed) return
    if (!serializeAddon.serializeAsText({ trimWhitespace: true })) return
    revealed = true
    container.style.opacity = "1"
  }

  const cleanup = () => {
    if (!cleanups.length) return
    const fns = cleanups.splice(0).reverse()
    for (const fn of fns) {
      try {
        fn()
      } catch (err) {
        debugTerminal("cleanup failed", err)
      }
    }
  }

  const pushSize = async (cols: number, rows: number) => {
    return serverSDK.api.pty
      .update({
        ptyID: id,
        location: { directory },
        size: { cols, rows },
      })
      .catch((err) => {
        debugTerminal("failed to sync terminal size", err)
      })
  }

  const getTerminalColors = (): TerminalColors => {
    const mode = theme.mode() === "dark" ? "dark" : "light"
    const fallback = DEFAULT_TERMINAL_COLORS[mode]
    const currentTheme = theme.themes()[theme.themeId()]
    if (!currentTheme) return fallback
    const variant = mode === "dark" ? currentTheme.dark : currentTheme.light
    if (!variant?.seeds && !variant?.palette) return fallback
    const resolved = resolveThemeVariant(variant, mode === "dark")
    const text = resolved["text-stronger"] ?? fallback.foreground
    const background =
      resolveV2Token(resolveThemeVariantV2(variant, mode === "dark"), "v2-background-bg-base") ?? fallback.background
    const alpha = mode === "dark" ? 0.25 : 0.2
    const base = text.startsWith("#") ? (text as HexColor) : (fallback.foreground as HexColor)
    const selectionBackground = withAlpha(base, alpha)
    return {
      background,
      foreground: text,
      cursor: text,
      selectionBackground,
    }
  }

  const terminalColors = createMemo(getTerminalColors)

  const scheduleFit = () => {
    if (disposed) return
    if (!fitAddon) return
    if (fitFrame !== undefined) return

    fitFrame = requestAnimationFrame(() => {
      fitFrame = undefined
      if (disposed) return
      fitAddon.fit()
    })
  }

  const scheduleSize = (cols: number, rows: number) => {
    if (disposed) return
    if (lastSize?.cols === cols && lastSize?.rows === rows) {
      pendingSize = undefined
      if (sizeTimer !== undefined) clearTimeout(sizeTimer)
      sizeTimer = undefined
      return
    }

    pendingSize = { cols, rows }

    if (!lastSize) {
      lastSize = pendingSize
      void pushSize(cols, rows)
      return
    }

    if (sizeTimer !== undefined) return
    sizeTimer = setTimeout(() => {
      sizeTimer = undefined
      const next = pendingSize
      if (!next) return
      pendingSize = undefined
      if (disposed) return
      if (lastSize?.cols === next.cols && lastSize?.rows === next.rows) return
      lastSize = next
      void pushSize(next.cols, next.rows)
    }, 100)
  }

  createEffect(() => {
    const colors = terminalColors()
    const mode = theme.mode() === "dark" ? "dark" : "light"
    if (!term) return
    setOptionIfSupported(term, "theme", colors)
    setOptionIfSupported(term, "colorScheme", mode)
  })

  createEffect(() => {
    const font = terminalFontFamily(settings.appearance.terminalFont())
    if (!term) return
    setOptionIfSupported(term, "fontFamily", font)
    scheduleFit()
  })

  let zoom = platform.webviewZoom?.()
  createEffect(() => {
    const next = platform.webviewZoom?.()
    if (next === undefined) return
    if (next === zoom) return
    zoom = next
    scheduleFit()
  })

  const focusTerminal = () => {
    const t = term
    if (!t) return
    const focus = () => (t.textarea ? t.textarea.focus({ preventScroll: true }) : t.focus())
    focus()
    setTimeout(focus, 0)
  }
  const handlePointerDown = () => {
    const activeElement = document.activeElement
    if (activeElement instanceof HTMLElement && activeElement !== container && !container.contains(activeElement)) {
      activeElement.blur()
    }
    focusTerminal()
  }

  const handleLinkClick = (event: MouseEvent) => {
    if (!event.shiftKey && !event.ctrlKey && !event.metaKey) return
    if (event.altKey) return
    if (event.button !== 0) return

    const t = term
    if (!t) return

    const text = getHoveredLinkText(t)
    if (!text) return

    event.preventDefault()
    event.stopImmediatePropagation()
    if (URL.canParse(text) && new URL(text).protocol === "file:" && platform.openLocalFile) {
      platform.openLocalFile(text)
      return
    }
    platform.openExternal(text)
  }

  onMount(() => {
    const run = async () => {
      const loaded = await loadGhostty()
      if (disposed) return

      const mod = loaded.mod
      const g = loaded.ghostty

      const t = new mod.Terminal({
        cursorBlink: true,
        cursorStyle: "bar",
        cols: restoreSize?.cols,
        rows: restoreSize?.rows,
        fontSize: 14,
        fontFamily: terminalFontFamily(settings.appearance.terminalFont()),
        allowTransparency: false,
        convertEol: false,
        theme: terminalColors(),
        scrollback: 10_000,
        ghostty: g,
      })
      cleanups.push(() => t.dispose())
      if (disposed) {
        cleanup()
        return
      }
      _ghostty = g
      term = t
      setOptionIfSupported(t, "colorScheme", theme.mode() === "dark" ? "dark" : "light")
      output = terminalWriter((data, done) =>
        t.write(data, () => {
          done?.()
        }),
      )

      t.attachCustomKeyEventHandler((event) => {
        const key = event.key.toLowerCase()

        const input = terminalKeyInput(event)
        if (input) {
          t.input(input, true)
          return true
        }

        if (event.ctrlKey && event.shiftKey && !event.metaKey && key === "c") {
          document.execCommand("copy")
          return true
        }

        // allow for toggle terminal keybinds in parent
        const config = settings.keybinds.get(TOGGLE_TERMINAL_ID) ?? DEFAULT_TOGGLE_TERMINAL_KEYBIND
        const keybinds = parseKeybind(config)

        return matchKeybind(keybinds, event)
      })

      const fit = new mod.FitAddon()
      const serializer = new SerializeAddon()
      cleanups.push(() => disposeIfDisposable(fit))
      t.loadAddon(serializer)
      t.loadAddon(fit)
      fitAddon = fit
      serializeAddon = serializer

      const active = document.activeElement
      t.open(container)
      useTerminalUiBindings({
        container,
        term: t,
        cleanups,
        handlePointerDown,
        handleLinkClick,
      })

      if (local.autoFocus === true) {
        focusTerminal()
        local.onAutoFocus?.()
      }
      if (local.autoFocus !== true) {
        const restoreFocus = () => {
          const current = document.activeElement
          if (current !== container && !container.contains(current)) return
          t.blur()
          t.textarea?.blur()
          if (active instanceof HTMLElement && active.isConnected) active.focus()
        }
        restoreFocus()
        const timer = setTimeout(restoreFocus, 0)
        cleanups.push(() => clearTimeout(timer))
      }

      if (typeof document !== "undefined" && document.fonts) {
        void document.fonts.ready.then(scheduleFit)
      }

      const onResize = t.onResize((size) => {
        scheduleSize(size.cols, size.rows)
      })
      cleanups.push(() => disposeIfDisposable(onResize))
      const onData = t.onData((data) => {
        if (ws?.readyState === WebSocket.OPEN) ws.send(data)
      })
      cleanups.push(() => disposeIfDisposable(onData))
      const onKey = t.onKey((key) => {
        if (key.key == "Enter") {
          props.onSubmit?.()
        }
      })
      cleanups.push(() => disposeIfDisposable(onKey))

      const startResize = () => {
        fit.observeResize()
        handleResize = scheduleFit
        window.addEventListener("resize", handleResize)
        cleanups.push(() => window.removeEventListener("resize", handleResize))
      }

      const write = (data: string) =>
        new Promise<void>((resolve) => {
          if (!output) {
            resolve()
            return
          }
          output.push(data)
          output.flush(resolve)
        })

      if (restore && restoreSize) {
        await write(restore)
        reveal()
        fit.fit()
        scheduleSize(t.cols, t.rows)
        if (scrollY !== undefined) t.scrollToLine(scrollY)
        startResize()
      } else {
        fit.fit()
        scheduleSize(t.cols, t.rows)
        if (restore) {
          await write(restore)
          reveal()
          if (scrollY !== undefined) t.scrollToLine(scrollY)
        }
        startResize()
      }

      const once = { value: false }
      const decoder = new TextDecoder()

      const fail = (err: unknown) => {
        if (disposed) return
        if (once.value) return
        once.value = true
        local.onConnectError?.(err)
      }

      const gone = async () => {
        return serverSDK.api.pty
          .get({ ptyID: id, location: { directory } })
          .then((result) => result.data.status === "exited")
          .catch((err) => {
            if (err && typeof err === "object" && "_tag" in err && err._tag === "PtyNotFoundError") return true
            debugTerminal("failed to inspect terminal session", err)
            return false
          })
      }

      const retry = (err: unknown) => {
        if (disposed) return
        if (reconn !== undefined) return

        const ms = Math.min(250 * 2 ** Math.min(tries, 4), 4_000)
        reconn = setTimeout(async () => {
          reconn = undefined
          if (disposed) return
          if (await gone()) {
            if (disposed) return
            fail(err)
            return
          }
          if (disposed) return
          tries += 1
          open()
        }, ms)
      }

      const open = async () => {
        if (disposed) return
        drop?.()

        const socket = await serverSDK.pty
          .connect({
            ptyID: id,
            location: { directory },
            cursor: seek,
          })
          .catch((err) => {
            fail(err)
            return undefined
          })
        if (!socket || once.value) return
        if (disposed) {
          socket.close(1000)
          return
        }
        ws = socket

        const handleOpen = () => {
          if (disposed) return
          tries = 0
          local.onConnect?.()
          scheduleSize(t.cols, t.rows)
          if (t.getMode(2031)) t.write("\x1b[?996n")
        }

        const handleMessage = (event: MessageEvent) => {
          if (disposed) return
          if (event.data instanceof ArrayBuffer) {
            const bytes = new Uint8Array(event.data)
            if (bytes[0] !== 0) return
            const json = decoder.decode(bytes.subarray(1))
            try {
              const meta = JSON.parse(json) as { cursor?: unknown }
              const next = meta?.cursor
              if (typeof next === "number" && Number.isSafeInteger(next) && next >= 0) {
                cursor = next
                seek = next
              }
            } catch (err) {
              debugTerminal("invalid websocket control frame", err)
            }
            return
          }

          const data = typeof event.data === "string" ? event.data : ""
          if (!data) return
          output?.push(data)
          if (!revealed) output?.flush(reveal)
          cursor += data.length
          seek = cursor
        }

        const handleError = (error: Event) => {
          if (disposed) return
          debugTerminal("websocket error", error)
        }

        const stop = () => {
          socket.removeEventListener("open", handleOpen)
          socket.removeEventListener("message", handleMessage)
          socket.removeEventListener("error", handleError)
          socket.removeEventListener("close", handleClose)
          if (ws === socket) ws = undefined
          if (drop === stop) drop = undefined
          if (socket.readyState !== WebSocket.CLOSED && socket.readyState !== WebSocket.CLOSING) socket.close(1000)
        }

        const handleClose = (event: CloseEvent) => {
          if (ws === socket) ws = undefined
          if (drop === stop) drop = undefined
          socket.removeEventListener("open", handleOpen)
          socket.removeEventListener("message", handleMessage)
          socket.removeEventListener("error", handleError)
          socket.removeEventListener("close", handleClose)
          if (disposed) return
          if (event.code === 1000) return
          retry(new Error(language.t("terminal.connectionLost.abnormalClose", { code: event.code })))
        }

        drop = stop
        socket.addEventListener("open", handleOpen)
        socket.addEventListener("message", handleMessage)
        socket.addEventListener("error", handleError)
        socket.addEventListener("close", handleClose)
      }

      open()
    }

    void run().catch((err) => {
      if (disposed) return
      showToast({
        variant: "error",
        title: language.t("terminal.connectionLost.title"),
        description: err instanceof Error ? err.message : language.t("terminal.connectionLost.description"),
      })
      local.onConnectError?.(err)
    })
  })

  onCleanup(() => {
    disposed = true
    if (fitFrame !== undefined) cancelAnimationFrame(fitFrame)
    if (sizeTimer !== undefined) clearTimeout(sizeTimer)
    if (reconn !== undefined) clearTimeout(reconn)
    drop?.()
    if (ws && ws.readyState !== WebSocket.CLOSED && ws.readyState !== WebSocket.CLOSING) ws.close(1000)

    const finalize = () => {
      persistTerminal({ term, addon: serializeAddon, cursor, id, onCleanup: props.onCleanup })
      cleanup()
    }

    if (!output) {
      finalize()
      return
    }

    output.flush(finalize)
  })

  return (
    <div
      ref={container}
      data-component="terminal"
      dir="ltr"
      data-prevent-autofocus
      tabIndex={-1}
      style={{ "background-color": terminalColors().background, "caret-color": "transparent", opacity: 0 }}
      classList={{
        ...local.classList,
        "select-text": true,
        "size-full px-6 py-3 font-mono relative overflow-hidden": true,
        [local.class ?? ""]: !!local.class,
      }}
      {...others}
    />
  )
}
