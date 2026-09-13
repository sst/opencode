type Entry = { method: string; url: string; at: number; slow: boolean }

// Chromium allows six connections per origin. The event stream holds one for the life of the
// connection and health probes use their own fetch, so the app's API calls stay below that or
// a burst stalls probes and user actions inside the browser where nothing can observe it.
export const requestQueueLimit = 4

// Endpoints that shell out to git or walk the filesystem take seconds on a large repository. They
// may hold at most this many slots, so a session mount's small reads never queue behind them.
export const requestQueueSlowLimit = 2
export const slowRequestPaths = ["/api/vcs", "/api/worktree"]

// A mount legitimately fires a dozen requests at once; only a request that has waited this long
// for a slot indicates the server is not keeping up.
export const requestStallMs = 2_000

// A socket that dies while the device sleeps can leave fetch waiting for response headers until the
// OS gives up on TCP retransmits, which takes minutes. Bound that so a dead request frees its slot
// instead of wedging every later API call; the body may still stream for as long as it needs.
export const requestHeadersTimeoutMs = 60_000

// Creating a worktree runs the project's setup script (dependency installs, fetches) before the
// server answers, so it needs a budget measured in minutes rather than seconds. Cutting it off
// kills the script midway and leaves a registered but half-initialised worktree behind.
export const setupRequestHeadersTimeoutMs = 10 * 60_000

export function isSlowRequest(pathname: string) {
  if (pathname === "/api/worktree/inventory") return false
  return slowRequestPaths.some((path) => pathname === path || pathname.startsWith(`${path}/`))
}

export function isSetupRequest(method: string, pathname: string) {
  return method === "POST" && pathname === "/api/worktree"
}

export function createRequestQueue(input: {
  fetch: typeof globalThis.fetch
  limit?: number
  slowLimit?: number
  stallMs?: number
  headersTimeoutMs?: number
  setupHeadersTimeoutMs?: number
  log?: (message: string, data: Record<string, unknown>) => void
  now?: () => number
}) {
  const limit = input.limit ?? requestQueueLimit
  const slowLimit = input.slowLimit ?? requestQueueSlowLimit
  const stallMs = input.stallMs ?? requestStallMs
  const headersTimeoutMs = input.headersTimeoutMs ?? requestHeadersTimeoutMs
  const setupHeadersTimeoutMs = input.setupHeadersTimeoutMs ?? setupRequestHeadersTimeoutMs
  // Call the browser fetch unbound; `input.fetch(...)` would make `this` the options object.
  const base = input.fetch
  const now = input.now ?? Date.now
  const log = input.log ?? ((message, data) => console.warn(`[server-request-queue] ${message}`, data))
  const inflight = new Set<Entry>()
  const waiting: Array<{ entry: Entry; start: () => void }> = []
  let warned = -Infinity
  let watcher: ReturnType<typeof setTimeout> | undefined

  const describe = (entry: Entry) => ({ method: entry.method, url: entry.url, ms: now() - entry.at })
  // Debug exports include the console, so list what the server is busy with while requests wait.
  const watch = () => {
    watcher = undefined
    const oldest = waiting[0]?.entry
    if (!oldest) return
    if (now() - oldest.at >= stallMs && now() - warned >= 10_000) {
      warned = now()
      log("server thrashing detected", {
        limit,
        inflight: [...inflight].map(describe),
        queued: waiting.map((item) => describe(item.entry)),
      })
    }
    watcher = setTimeout(watch, stallMs)
  }
  const canStart = (entry: Entry) => {
    if (inflight.size >= limit) return false
    if (!entry.slow) return true
    return [...inflight].filter((item) => item.slow).length < slowLimit
  }
  // FIFO, except a slow request waits its turn behind faster ones while the slow slots are full.
  const release = (entry: Entry) => {
    inflight.delete(entry)
    const index = waiting.findIndex((item) => canStart(item.entry))
    if (index === -1) return
    waiting.splice(index, 1)[0]?.start()
  }
  const acquire = (entry: Entry) => {
    // A free slot must start fetch before the caller's synchronous UI work.
    // Awaiting an already-resolved promise postpones that dispatch until after it.
    if (canStart(entry)) {
      inflight.add(entry)
      return
    }
    return new Promise<void>((resolve) => {
      const start = () => {
        entry.at = now()
        inflight.add(entry)
        resolve()
      }
      waiting.push({ entry, start })
      watcher ??= setTimeout(watch, stallMs)
    })
  }

  const fetch: typeof globalThis.fetch = Object.assign(
    async (resource: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(resource, init)
      const pathname = new URL(request.url).pathname
      // The event stream is long-lived; never count it against the request budget.
      if (pathname === "/api/event") return base(request)
      const entry = { method: request.method, url: request.url, at: now(), slow: isSlowRequest(pathname) }
      const queued = acquire(entry)
      if (queued) await queued
      if (request.signal.aborted) {
        release(entry)
        throw request.signal.reason ?? new DOMException("The operation was aborted.", "AbortError")
      }
      const controller = new AbortController()
      request.signal.addEventListener("abort", () => controller.abort(request.signal.reason), { once: true })
      const timer = setTimeout(
        () => controller.abort(new DOMException("Timed out waiting for the server to respond", "TimeoutError")),
        isSetupRequest(request.method, pathname) ? setupHeadersTimeoutMs : headersTimeoutMs,
      )
      return base(new Request(request, { signal: controller.signal })).finally(() => {
        clearTimeout(timer)
        release(entry)
      })
    },
    // Bun's fetch type carries preconnect; the browser never calls it.
    { preconnect: () => {} },
  )

  return {
    fetch,
    inflight: () => inflight.size,
    queued: () => waiting.length,
  }
}
