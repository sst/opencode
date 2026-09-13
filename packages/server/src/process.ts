export * as ServerProcess from "./process"

import { NodeHttpServer } from "@effect/platform-node"
import { Bus } from "@opencode/core/bus"
import { SessionRestart } from "@opencode/core/session/execution/restart"
import { InstallationEvent } from "@opencode/schema/installation-event"
import { hasPtyConnectTicketURL } from "@opencode/protocol/groups/pty"
import { hasPersistentPtyConnectTicketURL } from "@opencode/protocol/groups/persistent-pty"
import { Cause, Context, Effect, Exit, Latch, Layer, Option, Ref, Scope } from "effect"
import {
  HttpMiddleware,
  HttpPlatform,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http"
import { createServer } from "node:http"
import { ServerAuth } from "./auth"
import { isAllowedCorsOrigin } from "./cors"
import { authorizedRequest } from "./middleware/authorization"
import { withoutParentSpan } from "./request-tracing"
import { createRoutes } from "./routes"
import { ServerInfo } from "./server-info"
import { Status } from "./service-status"
import type { ServerOptions } from "./options"

export interface Lifecycle<E = never, R = never> {
  readonly onListen: (
    address: HttpServer.Address,
    shutdown: Effect.Effect<void>,
  ) => Effect.Effect<Effect.Effect<void>, E, R>
}

type App = Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  unknown,
  HttpServerRequest.HttpServerRequest | Scope.Scope
>

export type Transform = (app: App) => App

const errorResponseLogger = HttpMiddleware.make((app) =>
  HttpMiddleware.logger(
    Effect.tap(app, (response) =>
      response.status < 400 ? HttpMiddleware.withLoggerDisabled(Effect.void) : Effect.void,
    ),
  ),
)

export const start = Effect.fn("ServerProcess.start")(function* <E, R>(
  options: ServerOptions,
  lifecycle?: Lifecycle<E, R>,
  transform?: Transform,
) {
  const password = options.password
  if (!password) return yield* Effect.fail(new Error("Missing server password"))
  const hostname = options.hostname ?? "127.0.0.1"
  const port = Option.fromNullishOr(options.port)
  const shutdown = yield* Latch.make()
  const status = yield* Status.make()
  const bound = yield* listen({ hostname, port })
  const application = yield* Ref.make(Option.none<App>())
  // Request fibers may continue inbound trace context, but must not inherit the server startup parent.
  yield* bound.http
    .serve(
      dispatch(password, status, application, options.app?.version ?? "unknown").pipe(
        HttpMiddleware.cors({ allowedOrigins: (origin) => isAllowedCorsOrigin(origin, options), maxAge: 86_400 }),
      ),
      errorResponseLogger,
    )
    .pipe(withoutParentSpan)
  if (lifecycle)
    yield* lifecycle.onListen(bound.http.address, shutdown.open.pipe(Effect.asVoid)).pipe(
      Effect.flatMap((cleanup) =>
        Effect.addFinalizer(() => Scope.close(bound.scope, Exit.void).pipe(Effect.andThen(cleanup))),
      ),
      Effect.uninterruptible,
    )

  const parentScope = yield* Scope.Scope
  const applicationScope = yield* Scope.fork(parentScope)
  yield* Effect.addFinalizer(() =>
    status.beginStopping.pipe(
      Effect.andThen(Ref.set(application, Option.none())),
      Effect.andThen(Effect.sync(() => bound.server.closeAllConnections())),
    ),
  )

  const boot = Effect.gen(function* () {
    const context = yield* Layer.buildWithScope(
      createRoutes(
        {
          ...options,
          password,
        },
        () => {
          const address = bound.server.address()
          if (address === null || typeof address === "string") return []
          const host = address.family === "IPv6" ? `[${address.address}]` : address.address
          return ServerInfo.connectionURLs(`http://${host}:${address.port}`, hostname)
        },
      ).pipe(Layer.provideMerge(NodeHttpServer.layerHttpServices)),
      applicationScope,
    )
    if (lifecycle) {
      yield* installRestartContinuity(Context.get(context, SessionRestart.Service)).pipe(
        Effect.provideService(Scope.Scope, applicationScope),
      )
    }
    const app = Context.get(context, HttpRouter.HttpRouter)
      .asHttpEffect()
      .pipe(
        HttpMiddleware.compression(),
        Effect.provideService(HttpPlatform.HttpPlatform, Context.get(context, HttpPlatform.HttpPlatform)),
      )
    yield* Ref.set(application, Option.some(transform ? transform(app) : app))
    yield* status.ready
    const bus = Context.get(context, Bus.Service)
    return {
      address: bound.http.address,
      shutdown: shutdown.await,
      updateAvailable: (version: string) =>
        bus.publish(InstallationEvent.UpdateAvailable, { version }).pipe(Effect.asVoid),
      updated: (version: string) => bus.publish(InstallationEvent.Updated, { version }).pipe(Effect.asVoid),
    }
  }).pipe(
    Effect.catchCause((cause) => {
      if (!lifecycle || Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause)
      return status.fail.pipe(
        Effect.andThen(
          Scope.close(applicationScope, Exit.failCause(cause)).pipe(
            Effect.catchCause((cleanupCause) =>
              Effect.logError("failed to clean up background service boot", { cause: cleanupCause }),
            ),
          ),
        ),
        Effect.andThen(Effect.logError("background service boot failed", { cause })),
        Effect.andThen(Effect.never),
      )
    }),
  )
  if (!lifecycle) return yield* boot
  return yield* Effect.raceFirst(boot, shutdown.await.pipe(Effect.andThen(Effect.interrupt)))
})

function listen(options: { readonly hostname: string; readonly port: Option.Option<number> }) {
  if (Option.isSome(options.port)) return bind(options.hostname, options.port.value)
  const next = (port: number): ReturnType<typeof bind> =>
    bind(options.hostname, port).pipe(
      Effect.catch((error) => (port < 65_535 && addressInUse(error) ? next(port + 1) : Effect.fail(error))),
    )
  return next(4096)
}

function bind(hostname: string, port: number) {
  return Effect.gen(function* () {
    const parentScope = yield* Scope.Scope
    const serverScope = yield* Scope.fork(parentScope)
    const server = createServer()
    return yield* Effect.gen(function* () {
      const http = yield* NodeHttpServer.make(() => server, { port, host: hostname })
      yield* Effect.addFinalizer(() => Effect.sync(() => server.closeAllConnections()))
      return { http, server, scope: serverScope }
    }).pipe(
      Effect.provideService(Scope.Scope, serverScope),
      Effect.onError((cause) => Scope.close(serverScope, Exit.failCause(cause))),
    )
  })
}

function addressInUse(error: unknown) {
  if (typeof error !== "object" || error === null || !("cause" in error)) return false
  const cause = error.cause
  return typeof cause === "object" && cause !== null && "code" in cause && cause.code === "EADDRINUSE"
}

function dispatch(
  password: string,
  status: Status.Interface,
  application: Ref.Ref<Option.Option<App>>,
  version: string,
): App {
  const auth = ServerAuth.Config.of({ password: Option.some(password), username: "opencode" })
  return Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const url = new URL(request.url, "http://localhost")
    if (request.method === "GET" && url.pathname === "/api/health") {
      if (!(yield* authorizedRequest(request, auth))) return unauthorized()
      return yield* healthResponse(status, version)
    }
    const state = yield* status.current
    const app = yield* Ref.get(application)
    const ready = state.type === "ready" && Option.isSome(app)
    if (
      (!ready || (!hasPtyConnectTicketURL(url) && !hasPersistentPtyConnectTicketURL(url))) &&
      !(yield* authorizedRequest(request, auth))
    )
      return unauthorized()
    if (ready) return yield* app.value
    return unavailable(state)
  })
}

function unauthorized() {
  return HttpServerResponse.empty({
    status: 401,
    headers: { "www-authenticate": 'Basic realm="Secure Area"' },
  })
}

const healthResponse = Effect.fnUntraced(function* (status: Status.Interface, version: string) {
  const state = yield* status.current
  return HttpServerResponse.jsonUnsafe(
    { healthy: true, version, pid: process.pid },
    {
      status: state.type === "ready" ? 200 : state.type === "failed" ? 500 : 503,
      headers: state.type === "starting" || state.type === "stopping" ? { "retry-after": "1" } : undefined,
    },
  )
})

function unavailable(status: Status.State) {
  if (status.type === "failed")
    return HttpServerResponse.jsonUnsafe(
      {
        code: "service_failed",
        message: "The background service could not start.",
        action: "Run `opencode service restart` after checking the service logs.",
      },
      { status: 503 },
    )
  return HttpServerResponse.jsonUnsafe(
    { code: status.type === "stopping" ? "service_stopping" : "service_starting" },
    { status: 503, headers: { "retry-after": "1" } },
  )
}

/**
 * The managed server owns restart continuity: at boot it resumes Sessions whose execution claim was
 * never released. Claims are written when execution starts (see SessionExecution), so recovery covers
 * graceful restarts and unclean deaths alike — no shutdown hook participates.
 */
const installRestartContinuity = Effect.fnUntraced(function* (restart: SessionRestart.Interface) {
  yield* Effect.forkScoped(restart.resumeSuspendedSessions)
})
