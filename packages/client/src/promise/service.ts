import { readFile, rm } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import type { DiscoverOptions, Endpoint, Info, EnsureOptions, StopOptions } from "../service.js"
import {
  contenderFailure,
  contenderFinished,
  type ServiceContender,
  spawnServiceContender,
} from "../service-contender.js"
import { defaultEnsureTiming, ensureTiming, type EnsureTiming } from "../service-timing.js"
import { matchesVersion } from "../service-version.js"
import { PtyHandoff } from "../pty-handoff.js"
import type { ServiceHealth } from "./generated/types.js"

export * from "../service.js"

// Find, start, and stop the local opencode background service.
//
// The registration file is the complete discovery contract. This module is
// intentionally implemented with Node APIs so Promise clients do not need
// Effect or @effect/platform-node at runtime.

/** Discover a healthy, compatible local service without starting one. */
export async function discover(options: DiscoverOptions = {}) {
  const found = (await registered(options.file)).service
  if (found?.state !== "ready") return undefined
  if (!matchesVersion(found.version, options)) return undefined
  return found.endpoint
}

/** Ensure a healthy, compatible local service is running. */
export async function ensure(options: EnsureOptions = {}): Promise<Endpoint> {
  const timing = ensureTiming(options)
  const deadline = Date.now() + timing.promiseTimeout
  const contenders = new Set<ServiceContender>()
  let timeouts: { readonly info: Info; readonly count: number } | undefined
  let lastFailure: Error | undefined
  let announced = false
  let lastSpawn = 0
  let spawnDelay = timing.spawnDelay

  const announce = (reason: "missing" | "version-mismatch", previousVersion?: string) => {
    if (announced) return
    announced = true
    options.onStart?.(reason, previousVersion)
  }
  const spawnContender = async () => {
    const [command, ...args] = options.command ?? ["opencode", "serve", "--service"]
    if (command === undefined) throw new Error("Missing service command")
    try {
      return spawnServiceContender(command, args, await PtyHandoff.environment(options.file ?? fallback(), options.env))
    } catch (cause) {
      throw new Error("Failed to start server", { cause })
    }
  }

  try {
    while (true) {
      if (Date.now() >= deadline) {
        if (lastFailure !== undefined) throw lastFailure
        throw new Error("Timed out waiting for the background service to start")
      }
      const registration = await registered(options.file, true, timing.requestTimeout)
      if (registration.timedOut && registration.info !== undefined) {
        timeouts = {
          info: registration.info,
          count: timeouts !== undefined && same(timeouts.info, registration.info) ? timeouts.count + 1 : 1,
        }
        if (timeouts.count >= 3) {
          announce("missing")
          console.warn("Background service is unresponsive; recovery cannot preserve persistent terminals")
          await PtyHandoff.clear(options.file ?? fallback())
          await terminate(registration.info, options, timing)
          timeouts = undefined
          lastSpawn = Date.now() - spawnDelay
        }
      } else timeouts = undefined

      if (registration.service !== undefined) {
        spawnDelay = timing.spawnDelay
        const service = registration.service
        const compatible = !service.legacy && matchesVersion(service.version, options)
        if (compatible && service.state === "ready") {
          await PtyHandoff.complete(options.file ?? fallback(), service.info)
          return service.endpoint
        }
        if (compatible && service.state === "failed") throw new Error("Background service failed to start")
        if (!compatible) {
          announce("version-mismatch", service.version)
          if (!service.legacy && service.state !== "ready")
            console.warn("Background service is not ready; replacement cannot preserve persistent terminals")
          await stop({
            file: options.file,
            pty: !service.legacy && service.state === "ready" ? "handoff" : "clear",
          }).catch(() => undefined)
          lastSpawn = 0
        }
      } else {
        if (lastSpawn === 0 && registration.info !== undefined) lastSpawn = Date.now()
        const finished = [...contenders].filter(contenderFinished)
        const failure = finished.map(contenderFailure).find((error) => error !== undefined)
        if (failure !== undefined) lastFailure = failure
        if (finished.some((item) => item.child.exitCode === 0)) {
          spawnDelay = Math.min(spawnDelay * 2, timing.maxSpawnDelay)
        }
        finished.forEach((item) => contenders.delete(item))
        if (lastFailure !== undefined && contenders.size === 0) throw lastFailure
        // Keep one candidate plus one lock probe so a pre-lock stall cannot block recovery.
        if (lastFailure === undefined && contenders.size < 2 && Date.now() - lastSpawn >= spawnDelay) {
          announce("missing")
          contenders.add(await spawnContender())
          lastSpawn = Date.now()
        }
      }
      await delay(timing.pollInterval)
    }
  } finally {
    contenders.forEach((contender) => contender.release())
  }
}

/** Stop the registered local service. */
export async function stop(options: StopOptions = {}) {
  const info = await read(options.file)
  if (options.pty === "handoff" && info !== undefined)
    await PtyHandoff.prepare(options.file ?? fallback(), info, defaultEnsureTiming.requestTimeout)
  else await PtyHandoff.clear(options.file ?? fallback())
  if (info !== undefined) await terminate(info, options, defaultEnsureTiming)
}

function fallback() {
  return join(process.env["XDG_STATE_HOME"] ?? join(homedir(), ".local", "state"), "opencode", "service.json")
}

/** Create HTTP authentication headers for a service endpoint. */
export function headers(endpoint: Endpoint) {
  if (endpoint.auth === undefined) return undefined
  return {
    authorization: "Basic " + Buffer.from(endpoint.auth.username + ":" + endpoint.auth.password).toString("base64"),
  }
}

async function read(file?: string) {
  const text = await readFile(file ?? fallback(), "utf8").catch(() => undefined)
  if (text === undefined) return undefined
  try {
    return JSON.parse(text) as Info
  } catch {
    return undefined
  }
}

type LocalService = {
  readonly info: Info
  readonly endpoint: Endpoint
  readonly version?: string
  readonly state: "ready" | "waiting" | "failed"
  readonly legacy: boolean
}

async function probeResult(info: Info, allowLegacy = false, timeout = defaultEnsureTiming.requestTimeout) {
  const endpoint = {
    url: info.url,
    auth:
      info.password === undefined
        ? undefined
        : { type: "basic" as const, username: "opencode", password: info.password },
  } satisfies Endpoint
  const signal = AbortSignal.timeout(timeout)
  const result = await fetch(new URL("/api/health", info.url), {
    headers: headers(endpoint),
    signal,
  })
    .then(async (response) => ({
      response,
      body: (await response.json()) as ServiceHealth | { readonly healthy: true },
    }))
    .then(
      (value) => ({ value }),
      (cause: unknown) => ({ cause }),
    )
  if ("cause" in result) return { service: undefined, timedOut: signal.aborted }
  const response = result.value.response
  const body = result.value.body
  if (body !== undefined && "version" in body && "pid" in body) {
    if (body.pid !== info.pid) return { service: undefined, timedOut: false }
    if (info.version !== undefined && body.version !== info.version) return { service: undefined, timedOut: false }
    return {
      service: {
        info,
        endpoint,
        version: body.version,
        state: response.ok ? "ready" : response.status === 500 ? "failed" : "waiting",
        legacy: false,
      } satisfies LocalService,
      timedOut: false,
    }
  }
  if (!allowLegacy || body?.healthy !== true) return { service: undefined, timedOut: false }
  return {
    service: { info, endpoint, state: "ready", legacy: true } satisfies LocalService,
    timedOut: false,
  }
}

async function registered(file?: string, allowLegacy = false, timeout?: number) {
  const info = await read(file)
  if (info === undefined) return { info: undefined, service: undefined, timedOut: false }
  return { info, ...(await probeResult(info, allowLegacy, timeout)) }
}

function signal(pid: number, name: NodeJS.Signals) {
  try {
    process.kill(pid, name)
  } catch {}
}

function stopped(pid: number) {
  try {
    process.kill(pid, 0)
    return false
  } catch {
    return true
  }
}

async function waitUntilStopped(pid: number, timing: EnsureTiming) {
  for (let attempt = 0; attempt <= timing.stopPollAttempts; attempt++) {
    if (stopped(pid)) return true
    if (attempt < timing.stopPollAttempts) await delay(timing.stopPollInterval)
  }
  return false
}

function same(left: Info, right: Info) {
  return left.id === right.id && left.version === right.version && left.url === right.url && left.pid === right.pid
}

async function terminate(info: Info, options: { readonly file?: string }, timing: EnsureTiming) {
  const current = await read(options.file)
  if (current === undefined || !same(current, info)) return
  signal(info.pid, "SIGTERM")
  if (!(await waitUntilStopped(info.pid, timing))) {
    const latest = await read(options.file)
    if (latest === undefined || !same(latest, info)) return
    signal(info.pid, "SIGKILL")
    if (!(await waitUntilStopped(info.pid, timing))) throw new Error(`Server process ${info.pid} is still running`)
  }
  const latest = await read(options.file)
  if (latest === undefined || !same(latest, info)) return
  await rm(options.file ?? fallback(), { force: true })
}

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds))
}

/** Promise-based local service lifecycle operations. */
export const Service = { discover, ensure, stop, headers }
