import { usePlatform } from "@/runtime/platform/platform"
import { ServerConnection } from "@/runtime/server/registry"
import { authTokenFromCredentials } from "./api"
import { ClientError, OpenCode } from "@opencode/client"
import { Accessor, createEffect, onCleanup } from "solid-js"
import { createStore, reconcile } from "solid-js/store"

export type ServerHealth = { healthy: boolean; version?: string; incompatible?: boolean; checking?: boolean }

interface CheckServerHealthOptions {
  timeoutMs?: number
  signal?: AbortSignal
  retryCount?: number
  retryDelayMs?: number
}

const defaultTimeoutMs = 30_000
const defaultRetryCount = 2
const defaultRetryDelayMs = 100
const cacheMs = 750
const healthCache = new Map<
  string,
  { at: number; done: boolean; fetch: typeof globalThis.fetch; promise: Promise<ServerHealth> }
>()

function cacheKey(server: ServerConnection.HttpBase) {
  return `${server.url}\n${server.password ?? ""}`
}

function timeoutSignal(timeoutMs: number) {
  const timeout = (AbortSignal as unknown as { timeout?: (ms: number) => AbortSignal }).timeout
  if (timeout) {
    try {
      return {
        signal: timeout.call(AbortSignal, timeoutMs),
        clear: undefined as (() => void) | undefined,
      }
    } catch {}
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  return { signal: controller.signal, clear: () => clearTimeout(timer) }
}

function wait(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new DOMException("Aborted", "AbortError"))
    }
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

function retryable(error: unknown, signal?: AbortSignal) {
  if (signal?.aborted) return false
  if (error instanceof ClientError) return error.reason === "Transport"
  if (!(error instanceof Error)) return false
  if (error.name === "AbortError" || error.name === "TimeoutError") return false
  if (error instanceof TypeError) return true
  return /network|fetch|econnreset|econnrefused|enotfound|timedout/i.test(error.message)
}

export async function checkServerHealth(
  server: ServerConnection.HttpBase,
  fetch: typeof globalThis.fetch,
  opts?: CheckServerHealthOptions,
): Promise<ServerHealth> {
  const timeout = opts?.signal ? undefined : timeoutSignal(opts?.timeoutMs ?? defaultTimeoutMs)
  const signal = opts?.signal ?? timeout?.signal
  const retryCount = opts?.retryCount ?? defaultRetryCount
  const retryDelayMs = opts?.retryDelayMs ?? defaultRetryDelayMs
  const headers = server.password
    ? {
        Authorization: `Basic ${authTokenFromCredentials({ password: server.password })}`,
      }
    : undefined
  const next = (count: number, error: unknown) => {
    if (count >= retryCount || !retryable(error, signal)) return Promise.resolve({ healthy: false } as const)
    return wait(retryDelayMs * (count + 1), signal)
      .then(() => attempt(count + 1))
      .catch(() => ({ healthy: false }))
  }
  const attempt = async (count: number): Promise<ServerHealth> => {
    const current = await OpenCode.make({
      baseUrl: server.url,
      fetch,
      headers,
    })
      .health.get({ signal })
      .then(async (x) => {
        if (typeof x.healthy !== "boolean") return { error: new Error("Invalid health response") }
        if (x.healthy && typeof x.version !== "string") {
          const legacy = await fetch(new URL("/global/health", server.url), { headers, signal })
            .then((response) => response.json())
            .catch(() => undefined)
          const version =
            typeof legacy === "object" && legacy !== null && "version" in legacy && typeof legacy.version === "string"
              ? legacy.version
              : "1"
          return { data: { healthy: false, version, incompatible: true } }
        }
        return { data: { healthy: x.healthy, version: x.version } }
      })
      .catch((error) => ({ error }))
    if ("data" in current && current.data) return current.data
    if (signal?.aborted) return { healthy: false }

    return next(count, current.error)
  }
  return attempt(0).finally(() => timeout?.clear?.())
}

const pollMs = 10_000

export function useCheckServerHealth() {
  const platform = usePlatform()
  const fetcher = platform.fetch ?? globalThis.fetch

  return (http: ServerConnection.HttpBase) => {
    const key = cacheKey(http)
    const hit = healthCache.get(key)
    const now = Date.now()
    if (hit && hit.fetch === fetcher && (!hit.done || now - hit.at < cacheMs)) return hit.promise
    const promise = checkServerHealth(http, fetcher).finally(() => {
      const next = healthCache.get(key)
      if (!next || next.promise !== promise) return
      next.done = true
      next.at = Date.now()
    })
    healthCache.set(key, { at: now, done: false, fetch: fetcher, promise })
    return promise
  }
}

export const useServerHealth = (servers: Accessor<ServerConnection.Any[]>, enabled: Accessor<boolean>) => {
  return createServerHealth(servers, enabled, useCheckServerHealth())
}

export function createServerHealth(
  servers: Accessor<ServerConnection.Any[]>,
  enabled: Accessor<boolean>,
  check: (http: ServerConnection.HttpBase) => Promise<ServerHealth>,
) {
  const [status, setStatus] = createStore({} as Record<ServerConnection.Key, ServerHealth | undefined>)
  const endpoints = new Map<ServerConnection.Key, string>()

  createEffect(() => {
    if (!enabled()) {
      endpoints.clear()
      setStatus(reconcile({}))
      return
    }
    // Snapshot transport fields synchronously so a newly established SSH tunnel
    // invalidates both the old result and any probe still using the old endpoint.
    const list = servers().map((conn) => ({
      key: ServerConnection.key(conn),
      type: conn.type,
      http: conn.http,
      stage: conn.type === "ssh" ? conn.stage : undefined,
    }))
    for (const conn of list) {
      if (conn.stage && conn.stage !== "ready") {
        endpoints.delete(conn.key)
        setStatus(
          conn.key,
          reconcile(
            conn.stage === "failed"
              ? { healthy: false }
              : conn.stage === "incompatible"
                ? { healthy: false, incompatible: true }
                : undefined,
          ),
        )
        continue
      }
      const endpoint = cacheKey(conn.http)
      if (conn.type === "ssh" && endpoints.get(conn.key) !== endpoint) {
        setStatus(conn.key, reconcile({ healthy: false, checking: true }))
      }
      endpoints.set(conn.key, endpoint)
    }
    for (const key of endpoints.keys()) {
      if (!list.some((conn) => conn.key === key)) endpoints.delete(key)
    }
    let dead = false

    const refresh = async () => {
      const results: Record<string, ServerHealth | undefined> = {}
      await Promise.all(
        list.map(async (conn) => {
          if (conn.stage && conn.stage !== "ready") {
            results[conn.key] =
              conn.stage === "failed"
                ? { healthy: false }
                : conn.stage === "incompatible"
                  ? { healthy: false, incompatible: true }
                  : undefined
            return
          }
          const result = await check(conn.http)
          results[conn.key] = result
          if (!dead) setStatus(conn.key, reconcile(result))
        }),
      )
      if (dead) return
      setStatus(reconcile(results))
    }

    void refresh()
    const id = setInterval(() => void refresh(), pollMs)
    onCleanup(() => {
      dead = true
      clearInterval(id)
    })
  })

  return status
}
