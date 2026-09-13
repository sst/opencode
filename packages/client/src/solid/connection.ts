import { batch, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import type { OpenCodeClient, OpenCodeEvent } from "../promise"

export type ClientConnectionStatus = "connected" | "connecting" | "reconnecting"
export type ClientConnectionEvent = {
  readonly type: "client.connection"
  readonly created: number
  readonly data: {
    readonly status: "connecting" | "connected" | "disconnected" | "reconnecting"
    readonly attempt: number
    readonly error?: string
  }
}

export type ClientConnectionOptions = {
  readonly reconnect?: (signal: AbortSignal) => Promise<OpenCodeClient>
  readonly onEvent: (event: OpenCodeEvent) => void
  readonly flushInterval?: number
  readonly pageLifecycle?: boolean
  /**
   * Base delay between reconnect attempts. Streams that never connected
   * successfully scale this up per attempt (see `reconnectBackoffDelay`).
   */
  readonly reconnectDelayMs?: number
  /**
   * Abort and reconnect a stream that receives no bytes for this long. The server writes a keepalive
   * comment every 15 seconds, so a quiet but healthy stream never trips this.
   */
  readonly idleTimeout?: number
  readonly log?: {
    readonly debug?: (message: string, data?: Readonly<Record<string, unknown>>) => void
    readonly info?: (message: string, data?: Readonly<Record<string, unknown>>) => void
  }
}

const connectTimeout = 2_000
const reconnectDelay = 1_000
const maxReconnectBackoff = 30_000
const connectionHistoryLimit = 50

/**
 * Delay before the next reconnect attempt. Streams that never connected
 * successfully (bad credentials, server still booting) scale the delay up so a
 * failing endpoint is not hammered every second; streams that connected and
 * later dropped reset the attempt counter and keep the base delay.
 */
export const reconnectBackoffDelay = (attempt: number, baseDelay: number) =>
  Math.min(baseDelay * Math.max(attempt, 1), maxReconnectBackoff)
export const defaultIdleTimeout = 45_000
// Longer than one server keepalive interval: a stream that is silent this long when the page
// returns to the foreground is probably half-open after the device slept.
export const foregroundIdleThreshold = 20_000

export function createClientConnection(initialApi: OpenCodeClient, options: ClientConnectionOptions) {
  const abort = new AbortController()
  const history: ClientConnectionEvent[] = []
  const idleTimeout = options.idleTimeout ?? defaultIdleTimeout
  const [connection, setConnection] = createStore<{
    status: ClientConnectionStatus
    attempt: number
    error?: string
  }>({ status: "connecting", attempt: 0 })
  let api = initialApi
  let pending: OpenCodeEvent[] = []
  let flushTimer: ReturnType<typeof setTimeout> | undefined
  let stream: AbortController | undefined
  let current: AbortController | undefined
  let run: Promise<void> | undefined
  let started = false
  let generation = 0
  let lastActivity = 0
  let forced = false

  function record(status: ClientConnectionEvent["data"]["status"], attempt: number, error?: string) {
    history.push({ type: "client.connection", created: Date.now(), data: { status, attempt, error } })
    if (history.length > connectionHistoryLimit) history.shift()
  }

  function publish(event: OpenCodeEvent) {
    pending.push(event)
    if (flushTimer) return
    flushTimer = setTimeout(() => {
      flushTimer = undefined
      const events = pending
      pending = []
      batch(() => events.forEach(options.onEvent))
    }, options.flushInterval ?? 10)
  }

  async function connect(signal: AbortSignal, attempt: number) {
    let connectedAt: number | undefined
    const request = new AbortController()
    current = request
    const cancel = () => request.abort(signal.reason)
    const timeout = setTimeout(() => request.abort(new Error("Timed out connecting to server")), connectTimeout)
    signal.addEventListener("abort", cancel, { once: true })

    // Any received bytes, including keepalive comments, push the stall deadline out. A timer whose
    // deadline passed while the page was suspended fires as soon as the page resumes.
    let watchdog: ReturnType<typeof setTimeout> | undefined
    const touch = () => {
      lastActivity = Date.now()
      if (connectedAt === undefined) return
      clearTimeout(watchdog)
      watchdog = setTimeout(() => request.abort(new Error("Event stream stalled")), idleTimeout)
    }

    try {
      record(attempt === 0 ? "connecting" : "reconnecting", attempt)
      options.log?.info?.("event stream connecting", { attempt })
      const iterator = api.event.subscribe({ signal: request.signal, onActivity: touch })[Symbol.asyncIterator]()
      const first = await iterator.next()
      if (signal.aborted) return { error: undefined, connectedAt }
      if (first.done)
        return {
          error:
            request.signal.reason instanceof Error ? request.signal.reason : new Error("Event stream disconnected"),
          connectedAt,
        }
      if (first.value.type !== "server.connected")
        return { error: new Error("Event stream did not start with server.connected"), connectedAt }

      clearTimeout(timeout)
      record("connected", attempt)
      connectedAt = Date.now()
      touch()
      options.log?.info?.("event stream connected")
      publish(first.value)
      setConnection({ status: "connected", attempt: 0, error: undefined })

      while (!signal.aborted) {
        const event = await iterator.next()
        if (signal.aborted) return { error: undefined, connectedAt }
        if (event.done)
          return {
            error:
              request.signal.reason instanceof Error ? request.signal.reason : new Error("Event stream disconnected"),
            connectedAt,
          }
        touch()
        if ("durable" in event.value && event.value.durable)
          options.log?.debug?.("event", {
            type: event.value.type,
            aggregateID: event.value.durable.aggregateID,
            seq: event.value.durable.seq,
          })
        publish(event.value)
      }
      return { error: undefined, connectedAt }
    } catch (error) {
      return { error, connectedAt }
    } finally {
      request.abort()
      if (current === request) current = undefined
      clearTimeout(timeout)
      clearTimeout(watchdog)
      signal.removeEventListener("abort", cancel)
    }
  }

  async function runStream(active: number) {
    let attempt = 0
    while (!abort.signal.aborted && started && generation === active) {
      setConnection({ status: attempt === 0 ? "connecting" : "reconnecting", attempt })
      const controller = new AbortController()
      stream = controller
      const cancel = () => controller.abort(abort.signal.reason)
      abort.signal.addEventListener("abort", cancel)
      const result = await connect(controller.signal, attempt)
      abort.signal.removeEventListener("abort", cancel)
      if (abort.signal.aborted || !started || generation !== active) return
      if (result.connectedAt !== undefined && Date.now() - result.connectedAt >= reconnectDelay) attempt = 0
      attempt += 1
      const message = errorMessage(result.error)
      record("disconnected", attempt, message)
      options.log?.info?.("event stream disconnected", { attempt, error: message })
      setConnection({ status: "reconnecting", attempt, error: message })

      if (options.reconnect) {
        const next = await options.reconnect(controller.signal).catch((error) => {
          if (!controller.signal.aborted)
            options.log?.info?.("server resolution failed", { attempt, error: errorMessage(error) })
        })
        if (abort.signal.aborted || controller.signal.aborted || !started || generation !== active) return
        if (next) {
          api = next
          if (attempt === 1) continue
        }
      }
      // A deliberate resync already knows the old socket is gone; reconnect without backing off.
      if (forced) {
        forced = false
        continue
      }
      await wait(reconnectBackoffDelay(attempt, options.reconnectDelayMs ?? reconnectDelay), controller.signal)
    }
  }

  function start() {
    if (started) return run
    started = true
    forced = false
    const active = ++generation
    const previous = run
    const current = (async () => {
      if (previous) await previous
      await runStream(active)
    })().finally(() => {
      if (run !== current) return
      run = undefined
    })
    run = current
    return run
  }

  function stop() {
    if (!started) return
    started = false
    generation += 1
    stream?.abort()
    // Nothing is listening once stopped, so consumers must treat their data as stale until start() reconnects.
    setConnection({ status: "connecting", attempt: 0, error: undefined })
  }

  // Drop the live request so the reconnect loop replaces it now instead of waiting for the idle watchdog.
  function resync(reason: string) {
    if (!started || connection.status !== "connected") return
    options.log?.info?.("event stream resync", { reason, idle: Date.now() - lastActivity })
    forced = true
    current?.abort(new Error(reason))
  }

  if (options.pageLifecycle) {
    const pagehide = () => stop()
    const pageshow = () => void start()
    // Locking a phone or switching apps hides the document without a pagehide; the socket usually
    // dies while the page is suspended, and the browser may never report that on the hung read.
    const visibility = () => {
      if (document.visibilityState !== "visible") return
      if (Date.now() - lastActivity < foregroundIdleThreshold) return
      resync("Page returned to the foreground after the event stream went quiet")
    }
    const online = () => resync("Network connection restored")
    window.addEventListener("pagehide", pagehide)
    window.addEventListener("pageshow", pageshow)
    window.addEventListener("online", online)
    document.addEventListener("visibilitychange", visibility)
    onCleanup(() => {
      window.removeEventListener("pagehide", pagehide)
      window.removeEventListener("pageshow", pageshow)
      window.removeEventListener("online", online)
      document.removeEventListener("visibilitychange", visibility)
    })
  }
  void start()

  onCleanup(() => {
    stop()
    abort.abort()
    if (flushTimer) clearTimeout(flushTimer)
    pending = []
  })

  return {
    status: () => connection.status,
    attempt: () => connection.attempt,
    error: () => connection.error,
    internal: {
      history: () => history.slice(),
      resync,
    },
  }
}

function errorMessage(error: unknown) {
  if (error === undefined) return undefined
  if (error instanceof Error) return error.message
  return String(error)
}

function wait(delay: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(done, delay)
    signal.addEventListener("abort", done, { once: true })
    function done() {
      clearTimeout(timer)
      signal.removeEventListener("abort", done)
      resolve()
    }
  })
}
