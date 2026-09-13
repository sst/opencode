import { expect } from "bun:test"
import { Effect } from "effect"
import { HttpServer, HttpServerError, HttpServerResponse } from "effect/unstable/http"
import { it } from "../../core/test/lib/effect"
import { ServerProcess } from "../src/process"

it.live("authenticates API and frontend requests while allowing browser preflight", () =>
  Effect.gen(function* () {
    const fallback = "fallback".repeat(256)
    const server = yield* ServerProcess.start<never, never>(
      {
        hostname: "127.0.0.1",
        port: 0,
        password: "secret",
        cors: ["http://192.168.1.10:3001", "https://example.com"],
        app: { version: "test-version" },
        database: { path: ":memory:" },
      },
      undefined,
      (api) =>
        api.pipe(
          Effect.catchIf(
            (error) => error instanceof HttpServerError.HttpServerError && error.reason._tag === "RouteNotFound",
            () => Effect.succeed(HttpServerResponse.raw(fallback, { contentType: "text/plain" })),
          ),
        ),
    )
    const response = yield* Effect.promise(() =>
      fetch(new URL("/api/health", HttpServer.formatAddress(server.address)), {
        method: "OPTIONS",
        headers: {
          origin: "http://localhost:3000",
          "access-control-request-method": "GET",
          "access-control-request-headers": "authorization",
        },
      }),
    )

    expect(response.status).toBe(204)
    expect(response.headers.get("access-control-allow-origin")).toBe("http://localhost:3000")
    expect(response.headers.get("access-control-allow-headers")).toBe("authorization")

    const health = yield* Effect.promise(() =>
      fetch(new URL("/api/health", HttpServer.formatAddress(server.address)), {
        headers: {
          authorization: `Basic ${btoa("opencode:secret")}`,
          origin: "http://localhost:3000",
        },
      }),
    )

    expect(health.status).toBe(200)
    expect(health.headers.get("access-control-allow-origin")).toBe("http://localhost:3000")
    expect(yield* Effect.promise(() => health.json())).toMatchObject({ version: "test-version" })

    yield* Effect.forEach(
      ["http://192.168.1.10:3001", "https://example.com", "https://untrusted.example.com"],
      (origin) =>
        Effect.gen(function* () {
          const allowed = origin === "https://untrusted.example.com" ? null : origin
          const preflight = yield* Effect.promise(() =>
            fetch(new URL("/api/health", HttpServer.formatAddress(server.address)), {
              method: "OPTIONS",
              headers: {
                origin,
                "access-control-request-method": "GET",
                "access-control-request-headers": "authorization",
              },
            }),
          )
          expect(preflight.status).toBe(204)
          expect(preflight.headers.get("access-control-allow-origin")).toBe(allowed)

          const health = yield* Effect.promise(() =>
            fetch(new URL("/api/health", HttpServer.formatAddress(server.address)), {
              headers: { origin, authorization: `Basic ${btoa("opencode:secret")}` },
            }),
          )
          expect(health.status).toBe(200)
          expect(health.headers.get("access-control-allow-origin")).toBe(allowed)
          yield* Effect.promise(() => health.arrayBuffer())

          const denied = yield* Effect.promise(() =>
            fetch(new URL("/api/health", HttpServer.formatAddress(server.address)), { headers: { origin } }),
          )
          expect(denied.status).toBe(401)
          expect(denied.headers.get("access-control-allow-origin")).toBe(allowed)
          yield* Effect.promise(() => denied.arrayBuffer())
        }),
    )

    const event = yield* Effect.promise(() =>
      fetch(new URL("/api/event", HttpServer.formatAddress(server.address)), {
        headers: {
          "accept-encoding": "br",
          authorization: `Basic ${btoa("opencode:secret")}`,
        },
      }),
    )
    expect(event.status).toBe(200)
    expect(event.headers.get("content-encoding")).toBeNull()
    const body = event.body
    if (!body) return yield* Effect.die(new Error("Event response has no body"))
    const reader = body.getReader()
    yield* Effect.promise(() => readUntil(reader, "server.connected"))
    yield* server.updateAvailable("2.0.0")
    yield* Effect.promise(() => readUntil(reader, "installation.update-available"))
    yield* server.updated("2.0.0")
    yield* Effect.promise(() => readUntil(reader, "installation.updated"))
    yield* Effect.promise(() => reader.cancel())

    const missing = yield* Effect.promise(() =>
      fetch(new URL("/missing", HttpServer.formatAddress(server.address)), {
        headers: {
          "accept-encoding": "br",
          authorization: `Basic ${btoa("opencode:secret")}`,
        },
      }),
    )
    expect(missing.status).toBe(200)
    expect(missing.headers.get("content-encoding")).toBe("br")
    expect(missing.headers.get("content-type")).toBe("text/plain")
    expect(missing.headers.get("vary")?.toLowerCase()).toContain("accept-encoding")
    expect(yield* Effect.promise(() => missing.text())).toBe(fallback)

    yield* Effect.forEach(["/api", "/api/missing", "/openapi.json"], (pathname) =>
      Effect.gen(function* () {
        const response = yield* Effect.promise(() => fetch(new URL(pathname, HttpServer.formatAddress(server.address))))
        expect(response.status).toBe(401)
        expect(yield* Effect.promise(() => response.text())).toBe("")
      }),
    )

    yield* Effect.forEach(["/", "/workspace/example", "/_assets/app.js", "/icons/icon.svg", "/sw.js"], (pathname) =>
      Effect.gen(function* () {
        yield* Effect.forEach(["GET", "HEAD"], (method) =>
          Effect.gen(function* () {
            yield* Effect.forEach([undefined, `Basic ${btoa("opencode:wrong")}`], (authorization) =>
              Effect.gen(function* () {
                const response = yield* Effect.promise(() =>
                  fetch(new URL(pathname, HttpServer.formatAddress(server.address)), {
                    method,
                    headers: authorization ? { authorization } : undefined,
                  }),
                )
                expect(response.status).toBe(401)
                expect(response.headers.get("www-authenticate")).toBe('Basic realm="Secure Area"')
                expect(yield* Effect.promise(() => response.text())).toBe("")
              }),
            )
            const response = yield* Effect.promise(() =>
              fetch(new URL(pathname, HttpServer.formatAddress(server.address)), {
                method,
                headers: { authorization: `Basic ${btoa("opencode:secret")}` },
              }),
            )
            expect(response.status).toBe(200)
            expect(yield* Effect.promise(() => response.text())).toBe(method === "HEAD" ? "" : fallback)
          }),
        )
      }),
    )
  }),
)

async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, expected: string) {
  while (true) {
    const next = await reader.read()
    if (next.done) throw new Error(`Event stream ended before ${expected}`)
    if (new TextDecoder().decode(next.value).includes(expected)) return
  }
}
