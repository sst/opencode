import { NodeFileSystem, NodeHttpServer } from "@effect/platform-node"
import { afterAll, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { HttpServer, HttpServerError, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { createHash } from "node:crypto"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import path from "node:path"
import { WebUi } from "../src/services/web-ui"

const root = await mkdtemp(path.join(tmpdir(), "opencode-web-ui-"))
afterAll(() => rm(root, { recursive: true, force: true }))

describe("web UI", () => {
  test("falls back from API routes to assets and the SPA index", async () => {
    const index = path.join(root, "index.html")
    const asset = path.join(root, "app.js")
    const inline = ["theme()", "iosInputZoom()"]
    await writeFile(
      index,
      `<html><head><script id="oc-theme-preload-script">${inline[0]}</script><script id="oc-ios-input-zoom-script">${inline[1]}</script></head><body>embedded</body></html>`,
    )
    await writeFile(asset, "console.log('embedded')")
    const assets = {
      "index.html": await Bun.file(index).text(),
      "_assets/app.js": await Bun.file(asset).text(),
      "sw.js": "service worker",
      "registerSW.js": "registration",
      "font.woff2": new Uint8Array([0, 1, 2, 255]),
    }

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const transform = yield* WebUi.handler({ assets })
          const http = yield* NodeHttpServer.make(createServer, { host: "127.0.0.1", port: 0 })
          yield* http.serve(
            transform(
              Effect.gen(function* () {
                const request = yield* HttpServerRequest.HttpServerRequest
                const pathname = new URL(request.url, "http://localhost").pathname
                if (pathname === "/api/health") return HttpServerResponse.jsonUnsafe({ healthy: true })
                return yield* Effect.fail(
                  new HttpServerError.HttpServerError({
                    reason: new HttpServerError.RouteNotFound({ request }),
                  }),
                )
              }),
            ),
          )
          const origin = HttpServer.formatAddress(http.address)

          const health = yield* Effect.promise(() => fetch(`${origin}/api/health`))
          expect(yield* Effect.promise(() => health.json())).toEqual({ healthy: true })

          const missing = yield* Effect.promise(() => fetch(`${origin}/api/missing`))
          expect(missing.status).toBe(404)
          expect(yield* Effect.promise(() => missing.text())).toBe("")

          yield* Effect.forEach(["/_assets/old.js", "/_assets/old.css", "/_assets/missing"], (pathname) =>
            Effect.gen(function* () {
              const missing = yield* Effect.promise(() => fetch(`${origin}${pathname}`))
              expect(missing.status).toBe(404)
              expect(missing.headers.get("cache-control")).toBe("no-store")
              expect(yield* Effect.promise(() => missing.text())).toBe("")
            }),
          )

          const script = yield* Effect.promise(() => fetch(`${origin}/_assets/app.js`))
          expect(yield* Effect.promise(() => script.text())).toBe("console.log('embedded')")
          expect(script.headers.get("content-type")).toContain("javascript")
          expect(script.headers.get("cache-control")).toBe("public, max-age=31536000, immutable")

          const worker = yield* Effect.promise(() => fetch(`${origin}/sw.js`))
          expect(worker.headers.get("cache-control")).toBe("no-cache")

          const registration = yield* Effect.promise(() => fetch(`${origin}/registerSW.js`))
          expect(registration.headers.get("cache-control")).toBe("no-cache")

          const font = yield* Effect.promise(() => fetch(`${origin}/font.woff2`))
          expect(font.headers.get("content-type")).toBe("font/woff2")
          expect(new Uint8Array(yield* Effect.promise(() => font.arrayBuffer()))).toEqual(
            new Uint8Array([0, 1, 2, 255]),
          )

          const fallback = yield* Effect.promise(() => fetch(`${origin}/workspace/example`))
          expect(yield* Effect.promise(() => fallback.text())).toContain("embedded")
          expect(fallback.headers.get("content-security-policy")).toContain("default-src 'self'")
          expect(fallback.headers.get("content-security-policy")).toContain("connect-src * data: blob:")
          inline.forEach((script) =>
            expect(fallback.headers.get("content-security-policy")).toContain(
              `'sha256-${createHash("sha256").update(script).digest("base64")}'`,
            ),
          )

          const dotted = yield* Effect.promise(() => fetch(`${origin}/workspace/example.js`))
          expect(dotted.status).toBe(200)
          expect(yield* Effect.promise(() => dotted.text())).toContain("embedded")

          const legacy = yield* Effect.promise(() => fetch(`${origin}/assets/missing.js`))
          expect(legacy.status).toBe(200)
          expect(yield* Effect.promise(() => legacy.text())).toContain("embedded")
        }),
      ).pipe(Effect.provide(NodeFileSystem.layer)),
    )
  })
})
