import type { OpenCodeEvent } from "@opencode/client/promise"
import { createClientConnection, createPtyClient, type ClientConnectionStatus } from "@opencode/client/solid"
import { createGlobalEmitter } from "@solid-primitives/event-bus"
import { type Accessor, createEffect, on, onCleanup } from "solid-js"
import { createApiForServer, type ServerApi } from "@/runtime/server/api"
import { usePlatform } from "@/runtime/platform/platform"
import { ServerConnection } from "./registry"
import { createRefCountMap } from "@/runtime/server/refcount"
import { createRequestQueue } from "@/runtime/server/request-queue"
import { ServerScope } from "@/runtime/server/scope"
import { useServer } from "./current"

type OpenCodeEventMap = { [Type in OpenCodeEvent["type"]]: Extract<OpenCodeEvent, { type: Type }> }

export type OpenCodeEventStream = {
  on<Type extends OpenCodeEvent["type"]>(type: Type, handler: (event: OpenCodeEventMap[Type]) => void): VoidFunction
  listen(handler: (event: OpenCodeEvent) => void): VoidFunction
}

type OpenCodeEventSource = OpenCodeEventStream & {
  location(directory: string): OpenCodeEventStream
}

export function createOpenCodeEventSource() {
  const emitter = createGlobalEmitter<OpenCodeEventMap>()

  function stream(directory?: string): OpenCodeEventStream {
    return {
      on(type, handler) {
        return emitter.on(type, (event) => {
          if (directory !== undefined && event.location?.directory !== directory) return
          handler(event)
        })
      },
      listen(handler) {
        return emitter.listen((event) => {
          if (directory !== undefined && event.details.location?.directory !== directory) return
          handler(event.details)
        })
      },
    }
  }

  const event: OpenCodeEventSource = {
    ...stream(),
    location: (directory) => stream(directory),
  }

  onCleanup(() => emitter.clear())

  return {
    event,
    publish(event: OpenCodeEvent) {
      emitter.emit(event.type, event)
    },
  }
}

export type ServerConnectionStatus = ClientConnectionStatus
type ServerSDKBase = {
  server: ServerConnection.Any
  scope: ServerScope
  url: string
  api: ServerApi
  pty: ReturnType<typeof createPtyClient>
  connection: {
    status: Accessor<ServerConnectionStatus>
    attempt: Accessor<number>
    error: Accessor<string | undefined>
  }
  event: OpenCodeEventSource
}

function createServerSdkContextBase(server: ServerConnection.Any, scope: ServerScope): ServerSDKBase {
  const platform = usePlatform()
  const transport = createServerTransport({ http: server.http, fetch: platform.fetch })
  if (server.type === "ssh") {
    createEffect(
      on(
        () => `${server.http.url}\0${server.http.password ?? ""}`,
        () => transport.update(server.http),
        { defer: true },
      ),
    )
  }
  const events = createOpenCodeEventSource()
  const reconnect =
    server.type === "ssh" || (server.type === "sidecar" && server.variant === "base") ? server.reconnect : undefined

  const connection = createClientConnection(transport.api, {
    reconnect: reconnect ? async (signal) => transport.update(await reconnect(signal)) : undefined,
    flushInterval: 16,
    pageLifecycle: true,
    onEvent(event) {
      events.publish(event)
    },
    log: {
      info(message, data) {
        if (message !== "event stream disconnected") return
        console.info("[global-sdk] event stream disconnected", { url: transport.url, managed: !!reconnect, ...data })
      },
    },
  })

  return {
    server,
    scope,
    get url() {
      return transport.url
    },
    get api() {
      return transport.api
    },
    get pty() {
      return transport.pty
    },
    connection,
    event: events.event,
  }
}

export function createServerTransport(input: { http: ServerConnection.HttpBase; fetch?: typeof globalThis.fetch }): {
  update(http: ServerConnection.HttpBase): ServerApi
  readonly url: string
  readonly api: ServerApi
  readonly pty: ReturnType<typeof createPtyClient>
} {
  const queue = createRequestQueue({ fetch: input.fetch ?? globalThis.fetch })
  const build = (http: ServerConnection.HttpBase) => {
    const api = createApiForServer({ server: http, fetch: queue.fetch })
    return { http, api, pty: createPtyClient(api, { url: http.url }) }
  }
  const state = { current: build(input.http) }
  return {
    update(http: ServerConnection.HttpBase) {
      state.current = build(http)
      return state.current.api
    },
    get url() {
      return state.current.http.url
    },
    get api() {
      return state.current.api
    },
    get pty() {
      return state.current.pty
    },
  }
}

export type ServerSDK = ServerSDKBase & {
  ensureDirSdkContext: (directory: string) => ReturnType<typeof createDirSdkContext>
}

export function createServerSdkContext(server: ServerConnection.Any, scope: ServerScope): ServerSDK {
  const sdk = createServerSdkContextBase(server, scope)
  return Object.assign(sdk, {
    ensureDirSdkContext: createRefCountMap((dir) => createDirSdkContext(dir, sdk)),
  })
}

export const useServerSDK = () => {
  const server = useServer()
  return server.ctx.sdk
}

export type LocationContext = {
  directory: string
  event: OpenCodeEventStream
}

function createDirSdkContext(directory: string, serverSDK: ServerSDKBase): LocationContext {
  return {
    directory,
    event: serverSDK.event.location(directory),
  }
}
