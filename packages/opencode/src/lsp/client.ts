import path from "path"
import { pathToFileURL, fileURLToPath } from "url"
import { createMessageConnection, StreamMessageReader, StreamMessageWriter } from "vscode-jsonrpc/node"
import type { Diagnostic as VSCodeDiagnostic } from "vscode-languageserver-types"
import { Process } from "@/util/process"
import { LANGUAGE_EXTENSIONS } from "./language"
import { Effect, Schema } from "effect"
import type * as LSPServer from "./server"
import { withTimeout } from "../util/timeout"
import { Filesystem } from "@/util/filesystem"
import type { InstanceContext } from "@/project/instance-context"

const DIAGNOSTICS_DEBOUNCE_MS = 150
const DIAGNOSTICS_DOCUMENT_WAIT_TIMEOUT_MS = 5_000
const DIAGNOSTICS_FULL_WAIT_TIMEOUT_MS = 10_000
const DIAGNOSTICS_REQUEST_TIMEOUT_MS = 3_000

const INITIALIZE_TIMEOUT_MS = 45_000

// LSP spec constants
const FILE_CHANGE_CREATED = 1
const FILE_CHANGE_CHANGED = 2
const TEXT_DOCUMENT_SYNC_INCREMENTAL = 2

export type Info = NonNullable<Awaited<ReturnType<typeof create>>>

export type Diagnostic = VSCodeDiagnostic

export class InitializeError extends Schema.TaggedErrorClass<InitializeError>()("LSPInitializeError", {
  serverID: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

type DocumentDiagnosticReport = {
  items?: Diagnostic[]
  relatedDocuments?: Record<string, DocumentDiagnosticReport>
}

type WorkspaceDiagnosticReport = {
  items?: {
    uri?: string
    items?: Diagnostic[]
  }[]
}

type DiagnosticRequestResult = {
  handled: boolean
  matched: boolean
  byFile: Map<string, Diagnostic[]>
}

type CapabilityRegistration = {
  id: string
  method: string
  registerOptions?: {
    identifier?: string
    workspaceDiagnostics?: boolean
  }
}

type ServerCapabilities = {
  textDocumentSync?:
    | number
    | {
        change?: number
      }
  diagnosticProvider?: unknown
  [key: string]: unknown
}

function getFilePath(uri: string) {
  if (!uri.startsWith("file://")) return
  return Filesystem.normalizePath(fileURLToPath(uri))
}

function getSyncKind(capabilities?: ServerCapabilities) {
  if (!capabilities) return
  const sync = capabilities.textDocumentSync
  if (typeof sync === "number") return sync
  return sync?.change
}

function endPosition(text: string) {
  const lines = text.split(/\r\n|\r|\n/)
  return {
    line: lines.length - 1,
    character: lines.at(-1)?.length ?? 0,
  }
}

function dedupeDiagnostics(items: Diagnostic[]) {
  const seen = new Set<string>()
  return items.filter((item) => {
    const key = JSON.stringify({
      code: item.code,
      severity: item.severity,
      message: item.message,
      source: item.source,
      range: item.range,
    })
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function configurationValue(settings: unknown, section?: string) {
  if (!section) return settings ?? null
  const result = section.split(".").reduce<unknown>((acc, key) => {
    if (!acc || typeof acc !== "object" || !(key in acc)) return undefined
    return (acc as Record<string, unknown>)[key]
  }, settings)
  return result ?? null
}

// TypeScript's built-in LSP pushes diagnostics aggressively on first open.
// We seed the push cache on the very first publish so waitForFreshPush can
// resolve immediately instead of waiting for a second debounced push.
function shouldSeedDiagnosticsOnFirstPush(serverID: string) {
  return serverID === "typescript"
}

export async function create(input: {
  serverID: string
  server: LSPServer.Handle
  root: string
  directory: string
  instance: InstanceContext
}) {
  const instance = input.instance

  const connection = createMessageConnection(
    new StreamMessageReader(input.server.process.stdout as any),
    new StreamMessageWriter(input.server.process.stdin as any),
  )
  input.server.process.stderr?.resume()
  let alive = true
  let shuttingDown = false
  const deadListeners = new Set<() => void>()
  const markDead = () => {
    if (!alive || shuttingDown) return
    alive = false
    for (const listener of [...deadListeners]) listener()
    emitRegistrationChange()
  }
  connection.onClose(markDead)
  connection.onError(markDead)
  input.server.process.stdout?.on("end", markDead)
  input.server.process.stdout?.on("error", markDead)
  input.server.process.once("exit", markDead)
  // --- Connection state ---

  const pushDiagnostics = new Map<string, Diagnostic[]>()
  const pullDiagnostics = new Map<string, Diagnostic[]>()
  const published = new Map<string, { at: number; version?: number }>()
  const diagnosticRegistrations = new Map<string, CapabilityRegistration>()
  const registrationListeners = new Set<() => void>()
  const diagnosticListeners = new Set<(input: { path: string; serverID: string }) => void>()
  const mergedDiagnostics = (filePath: string) =>
    dedupeDiagnostics([...(pushDiagnostics.get(filePath) ?? []), ...(pullDiagnostics.get(filePath) ?? [])])
  const updatePushDiagnostics = (filePath: string, next: Diagnostic[]) => {
    pushDiagnostics.set(filePath, next)
    for (const listener of diagnosticListeners) listener({ path: filePath, serverID: input.serverID })
  }
  const updatePullDiagnostics = (filePath: string, next: Diagnostic[]) => {
    pullDiagnostics.set(filePath, next)
  }
  const emitRegistrationChange = () => {
    for (const listener of [...registrationListeners]) listener()
  }

  // --- LSP connection handlers ---

  connection.onNotification("textDocument/publishDiagnostics", (params) => {
    const filePath = getFilePath(params.uri)
    if (!filePath) return
    published.set(filePath, {
      at: Date.now(),
      version: typeof params.version === "number" ? params.version : undefined,
    })
    if (shouldSeedDiagnosticsOnFirstPush(input.serverID) && !pushDiagnostics.has(filePath)) {
      pushDiagnostics.set(filePath, params.diagnostics)
      return
    }
    updatePushDiagnostics(filePath, params.diagnostics)
  })
  connection.onRequest("window/workDoneProgress/create", (params) => {
    return null
  })
  connection.onRequest("workspace/configuration", async (params) => {
    const items = (params as { items?: { section?: string }[] }).items ?? []
    return items.map((item) => configurationValue(input.server.initialization, item.section))
  })
  connection.onRequest("client/registerCapability", async (params) => {
    const registrations = (params as { registrations?: CapabilityRegistration[] }).registrations ?? []
    let changed = false
    for (const registration of registrations) {
      if (registration.method !== "textDocument/diagnostic") continue
      diagnosticRegistrations.set(registration.id, registration)
      changed = true
    }
    if (changed) emitRegistrationChange()
  })
  connection.onRequest("client/unregisterCapability", async (params) => {
    const registrations = (params as { unregisterations?: { id: string; method: string }[] }).unregisterations ?? []
    let changed = false
    for (const registration of registrations) {
      if (registration.method !== "textDocument/diagnostic") continue
      diagnosticRegistrations.delete(registration.id)
      changed = true
    }
    if (changed) emitRegistrationChange()
  })
  connection.onRequest("workspace/workspaceFolders", async () => [
    {
      name: "workspace",
      uri: pathToFileURL(input.root).href,
    },
  ])
  connection.onRequest("workspace/diagnostic/refresh", async () => null)
  connection.listen()

  // --- Initialize handshake ---

  const initialized = await withTimeout(
    connection.sendRequest<{ capabilities?: ServerCapabilities }>("initialize", {
      rootUri: pathToFileURL(input.root).href,
      processId: input.server.process.pid,
      workspaceFolders: [
        {
          name: "workspace",
          uri: pathToFileURL(input.root).href,
        },
      ],
      initializationOptions: {
        ...input.server.initialization,
      },
      capabilities: {
        window: {
          workDoneProgress: true,
        },
        workspace: {
          configuration: true,
          didChangeWatchedFiles: {
            dynamicRegistration: true,
          },
          diagnostics: {
            refreshSupport: false,
          },
        },
        textDocument: {
          synchronization: {
            didOpen: true,
            didChange: true,
          },
          diagnostic: {
            dynamicRegistration: true,
            relatedDocumentSupport: true,
          },
          publishDiagnostics: {
            versionSupport: false,
          },
        },
      },
    }),
    INITIALIZE_TIMEOUT_MS,
  ).catch((err) => {
    throw new InitializeError({ serverID: input.serverID, cause: err })
  })

  const syncKind = getSyncKind(initialized.capabilities)
  const hasStaticPullDiagnostics = Boolean(initialized.capabilities?.diagnosticProvider)

  await connection.sendNotification("initialized", {})

  if (input.server.initialization) {
    await connection.sendNotification("workspace/didChangeConfiguration", {
      settings: input.server.initialization,
    })
  }

  const files: Record<string, { version: number; text: string }> = {}

  // --- Diagnostic helpers ---

  const mergeResults = (filePath: string, results: DiagnosticRequestResult[]) => {
    const handled = results.some((result) => result.handled)
    const matched = results.some((result) => result.matched)
    if (!handled) return { handled: false, matched: false }

    const merged = new Map<string, Diagnostic[]>()
    for (const result of results) {
      for (const [target, items] of result.byFile.entries()) {
        const existing = merged.get(target) ?? []
        merged.set(target, existing.concat(items))
      }
    }

    if (matched && !merged.has(filePath)) merged.set(filePath, [])
    for (const [target, items] of merged.entries()) {
      updatePullDiagnostics(target, dedupeDiagnostics(items))
    }

    return { handled, matched }
  }

  async function requestDiagnosticReport(filePath: string, identifier?: string): Promise<DiagnosticRequestResult> {
    const report = await withTimeout(
      connection.sendRequest<DocumentDiagnosticReport | null>("textDocument/diagnostic", {
        ...(identifier ? { identifier } : {}),
        textDocument: {
          uri: pathToFileURL(filePath).href,
        },
      }),
      DIAGNOSTICS_REQUEST_TIMEOUT_MS,
    ).catch(() => null)
    if (!report) return { handled: false, matched: false, byFile: new Map<string, Diagnostic[]>() }

    const byFile = new Map<string, Diagnostic[]>()
    const push = (target: string, items: Diagnostic[]) => {
      const existing = byFile.get(target) ?? []
      byFile.set(target, existing.concat(items))
    }

    let handled = false
    let matched = false
    if (Array.isArray(report.items)) {
      push(filePath, report.items)
      handled = true
      matched = true
    }
    for (const [uri, related] of Object.entries(report.relatedDocuments ?? {})) {
      const relatedPath = getFilePath(uri)
      if (!relatedPath || !Array.isArray(related.items)) continue
      push(relatedPath, related.items)
      handled = true
      matched = matched || relatedPath === filePath
    }

    return { handled, matched, byFile }
  }

  async function requestWorkspaceDiagnosticReport(
    filePath: string,
    identifier?: string,
  ): Promise<DiagnosticRequestResult> {
    const report = await withTimeout(
      connection.sendRequest<WorkspaceDiagnosticReport | null>("workspace/diagnostic", {
        ...(identifier ? { identifier } : {}),
        previousResultIds: [],
      }),
      DIAGNOSTICS_REQUEST_TIMEOUT_MS,
    ).catch(() => null)
    if (!report) return { handled: false, matched: false, byFile: new Map<string, Diagnostic[]>() }

    const byFile = new Map<string, Diagnostic[]>()
    let matched = false
    for (const item of report.items ?? []) {
      const relatedPath = item.uri ? getFilePath(item.uri) : undefined
      if (!relatedPath || !Array.isArray(item.items)) continue
      const existing = byFile.get(relatedPath) ?? []
      byFile.set(relatedPath, existing.concat(item.items))
      matched = matched || relatedPath === filePath
    }

    return { handled: true, matched, byFile }
  }

  function documentPullState() {
    const documentRegistrations = [...diagnosticRegistrations.values()].filter(
      (registration) => registration.registerOptions?.workspaceDiagnostics !== true,
    )
    return {
      documentIdentifiers: [
        ...new Set(documentRegistrations.flatMap((registration) => registration.registerOptions?.identifier ?? [])),
      ],
      supported: hasStaticPullDiagnostics || documentRegistrations.length > 0,
    }
  }

  function workspacePullState() {
    const workspaceRegistrations = [...diagnosticRegistrations.values()].filter(
      (registration) => registration.registerOptions?.workspaceDiagnostics === true,
    )
    return {
      workspaceIdentifiers: [
        ...new Set(workspaceRegistrations.flatMap((registration) => registration.registerOptions?.identifier ?? [])),
      ],
      supported: workspaceRegistrations.length > 0,
    }
  }

  const hasCurrentFileDiagnostics = (filePath: string, results: DiagnosticRequestResult[]) =>
    results.some((result) => (result.byFile.get(filePath)?.length ?? 0) > 0)

  async function requestDiagnostics(
    filePath: string,
    requests: Promise<DiagnosticRequestResult>[],
    done: (results: DiagnosticRequestResult[]) => boolean,
  ) {
    if (!requests.length) return { handled: false, matched: false }

    const results: DiagnosticRequestResult[] = []
    return new Promise<{ handled: boolean; matched: boolean }>((resolve) => {
      let pending = requests.length
      let resolved = false
      const finish = (merged: { handled: boolean; matched: boolean }, force = false) => {
        if (resolved) return
        if (!force && !done(results)) return
        resolved = true
        resolve(merged)
      }

      for (const request of requests) {
        request.then((result) => {
          results.push(result)
          pending -= 1
          const merged = mergeResults(filePath, results)
          finish(merged)
          if (pending === 0) finish(merged, true)
        })
      }
    })
  }

  // LATENCY-CRITICAL: dispatch identifier pulls in parallel and unblock once one
  // batch already produced diagnostics for the current file. Let slower pulls keep
  // merging in the background; do not sequence identifier-by-identifier, and do
  // not add a post-match settle/debounce delay. See PR #23771.
  async function requestDocumentDiagnostics(filePath: string) {
    const state = documentPullState()
    if (!state.supported) return { handled: false, matched: false }
    return requestDiagnostics(
      filePath,
      [
        requestDiagnosticReport(filePath),
        ...state.documentIdentifiers.map((identifier) => requestDiagnosticReport(filePath, identifier)),
      ],
      (results) => hasCurrentFileDiagnostics(filePath, results),
    )
  }

  async function requestFullDiagnostics(filePath: string) {
    const documentState = documentPullState()
    const workspaceState = workspacePullState()
    if (!documentState.supported && !workspaceState.supported) return { handled: false, matched: false }
    return mergeResults(
      filePath,
      await Promise.all([
        ...(documentState.supported ? [requestDiagnosticReport(filePath)] : []),
        ...documentState.documentIdentifiers.map((identifier) => requestDiagnosticReport(filePath, identifier)),
        ...(workspaceState.supported ? [requestWorkspaceDiagnosticReport(filePath)] : []),
        ...workspaceState.workspaceIdentifiers.map((identifier) =>
          requestWorkspaceDiagnosticReport(filePath, identifier),
        ),
      ]),
    )
  }

  function waitForRegistrationChange(timeout: number) {
    if (timeout <= 0) return Promise.resolve(false)
    return new Promise<boolean>((resolve) => {
      let finished = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const finish = (result: boolean) => {
        if (finished) return
        finished = true
        if (timer) clearTimeout(timer)
        registrationListeners.delete(listener)
        resolve(result)
      }
      const listener = () => finish(true)
      registrationListeners.add(listener)
      timer = setTimeout(() => finish(false), timeout)
    })
  }

  function waitForFreshPush(request: { path: string; version: number; after: number; timeout: number }) {
    if (request.timeout <= 0) return Promise.resolve(false)
    return new Promise<boolean>((resolve) => {
      let finished = false
      let debounceTimer: ReturnType<typeof setTimeout> | undefined
      let timeoutTimer: ReturnType<typeof setTimeout> | undefined
      let unsub: (() => void) | undefined
      const finish = (result: boolean) => {
        if (finished) return
        finished = true
        if (debounceTimer) clearTimeout(debounceTimer)
        if (timeoutTimer) clearTimeout(timeoutTimer)
        unsub?.()
        resolve(result)
      }
      const schedule = () => {
        const hit = published.get(request.path)
        if (!hit) return
        if (typeof hit.version === "number" && hit.version !== request.version) return
        if (hit.at < request.after && hit.version !== request.version) return
        if (debounceTimer) clearTimeout(debounceTimer)
        debounceTimer = setTimeout(() => finish(true), Math.max(0, DIAGNOSTICS_DEBOUNCE_MS - (Date.now() - hit.at)))
      }

      timeoutTimer = setTimeout(() => finish(false), request.timeout)
      const listener = (event: { path: string; serverID: string }) => {
        if (event.path !== request.path || event.serverID !== input.serverID) return
        schedule()
      }
      diagnosticListeners.add(listener)
      unsub = () => diagnosticListeners.delete(listener)
      schedule()
    })
  }

  async function waitForDocumentDiagnostics(request: { path: string; version: number; after?: number }) {
    if (!alive) return
    const startedAt = request.after ?? Date.now()
    const pushWait = waitForFreshPush({
      path: request.path,
      version: request.version,
      after: startedAt,
      timeout: DIAGNOSTICS_DOCUMENT_WAIT_TIMEOUT_MS,
    })

    while (Date.now() - startedAt < DIAGNOSTICS_DOCUMENT_WAIT_TIMEOUT_MS) {
      if (!alive) return
      const result = await requestDocumentDiagnostics(request.path)
      if (result.matched) return
      const remaining = DIAGNOSTICS_DOCUMENT_WAIT_TIMEOUT_MS - (Date.now() - startedAt)
      if (remaining <= 0) return
      const next = await Promise.race([
        pushWait.then((ready) => (ready ? "push" : ("timeout" as const))),
        waitForRegistrationChange(remaining).then((changed) => (changed ? "registration" : ("timeout" as const))),
      ])
      if (next !== "registration") return
    }
  }

  async function waitForFullDiagnostics(request: { path: string; version: number; after?: number }) {
    if (!alive) return
    const startedAt = request.after ?? Date.now()
    const pushWait = waitForFreshPush({
      path: request.path,
      version: request.version,
      after: startedAt,
      timeout: DIAGNOSTICS_FULL_WAIT_TIMEOUT_MS,
    })

    while (Date.now() - startedAt < DIAGNOSTICS_FULL_WAIT_TIMEOUT_MS) {
      if (!alive) return
      const result = await requestFullDiagnostics(request.path)
      if (result.handled || result.matched) return
      const remaining = DIAGNOSTICS_FULL_WAIT_TIMEOUT_MS - (Date.now() - startedAt)
      if (remaining <= 0) return
      const next = await Promise.race([
        pushWait.then((ready) => (ready ? "push" : ("timeout" as const))),
        waitForRegistrationChange(remaining).then((changed) => (changed ? "registration" : ("timeout" as const))),
      ])
      if (next !== "registration") return
    }
  }

  // --- Public API ---

  const result = {
    root: input.root,
    get serverID() {
      return input.serverID
    },
    get isAlive() {
      return alive
    },
    onDead(listener: () => void) {
      if (!alive) {
        listener()
        return () => {}
      }
      deadListeners.add(listener)
      return () => deadListeners.delete(listener)
    },
    get connection() {
      return connection
    },
    notify: {
      async open(request: { path: string }) {
        request.path = Filesystem.normalizePath(
          path.isAbsolute(request.path) ? request.path : path.resolve(input.directory, request.path),
        )
        const text = await Filesystem.readText(request.path)
        const extension = path.extname(request.path)
        const languageId = LANGUAGE_EXTENSIONS[extension] ?? "plaintext"

        const document = files[request.path]
        if (document !== undefined) {
          // Do not wipe diagnostics on didChange. Some servers (e.g. clangd) only
          // re-emit diagnostics when the content actually changes, so clearing
          // here would lose errors for no-op touchFile calls. Let the server's
          // next push/pull overwrite naturally.
          await connection.sendNotification("workspace/didChangeWatchedFiles", {
            changes: [
              {
                uri: pathToFileURL(request.path).href,
                type: FILE_CHANGE_CHANGED,
              },
            ],
          })

          const next = document.version + 1
          files[request.path] = { version: next, text }
          await connection.sendNotification("textDocument/didChange", {
            textDocument: {
              uri: pathToFileURL(request.path).href,
              version: next,
            },
            contentChanges:
              syncKind === TEXT_DOCUMENT_SYNC_INCREMENTAL
                ? [
                    {
                      range: {
                        start: { line: 0, character: 0 },
                        end: endPosition(document.text),
                      },
                      text,
                    },
                  ]
                : [{ text }],
          })
          return next
        }

        await connection.sendNotification("workspace/didChangeWatchedFiles", {
          changes: [
            {
              uri: pathToFileURL(request.path).href,
              type: FILE_CHANGE_CREATED,
            },
          ],
        })

        pushDiagnostics.delete(request.path)
        pullDiagnostics.delete(request.path)
        await connection.sendNotification("textDocument/didOpen", {
          textDocument: {
            uri: pathToFileURL(request.path).href,
            languageId,
            version: 0,
            text,
          },
        })
        files[request.path] = { version: 0, text }
        return 0
      },
    },
    get diagnostics() {
      const result = new Map<string, Diagnostic[]>()
      for (const key of new Set([...pushDiagnostics.keys(), ...pullDiagnostics.keys()])) {
        result.set(key, mergedDiagnostics(key))
      }
      return result
    },
    async waitForDiagnostics(request: { path: string; version: number; mode?: "document" | "full"; after?: number }) {
      const normalizedPath = Filesystem.normalizePath(
        path.isAbsolute(request.path) ? request.path : path.resolve(input.directory, request.path),
      )
      if (request.mode === "document") {
        await waitForDocumentDiagnostics({ path: normalizedPath, version: request.version, after: request.after })
        return
      }
      await waitForFullDiagnostics({ path: normalizedPath, version: request.version, after: request.after })
    },
    async shutdown() {
      shuttingDown = true
      alive = false
      connection.end()
      connection.dispose()
      await Process.stop(input.server.process)
    },
  }

  return result
}

export * as LSPClient from "./client"
