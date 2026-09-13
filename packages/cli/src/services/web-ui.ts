import { FSUtil } from "@opencode/util/fs-util"
import { Effect, FileSystem } from "effect"
import { HttpServerError, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { createHash } from "node:crypto"
import { load, type AssetMap } from "../app-assets"

export const handler = Effect.fn("cli.web-ui.handler")(function* (options?: { readonly assets?: AssetMap }) {
  const fileSystem = yield* FileSystem.FileSystem
  const assets = options?.assets
    ? Effect.succeed(options.assets)
    : yield* Effect.cached(load().pipe(Effect.provideService(FileSystem.FileSystem, fileSystem)))
  return <E, R>(api: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
    api.pipe(
      Effect.catchIf(isRouteNotFound, () =>
        HttpServerRequest.HttpServerRequest.pipe(
          Effect.flatMap((request) => {
            const url = new URL(request.url, "http://localhost")
            if (url.pathname === "/api" || url.pathname.startsWith("/api/"))
              return Effect.succeed(HttpServerResponse.empty({ status: 404 }))
            return assets.pipe(Effect.flatMap((files) => serveUI(request, url, files)))
          }),
        ),
      ),
    )
})

function serveUI(request: HttpServerRequest.HttpServerRequest, url: URL, assets: AssetMap) {
  const key = url.pathname.replace(/^\//, "")
  if ((key.startsWith("_assets/") || key.startsWith("icons/")) && assets[key] === undefined)
    return Effect.succeed(HttpServerResponse.empty({ status: 404, headers: { "cache-control": "no-store" } }))
  const name = assets[key] !== undefined ? key : "index.html"
  const file = assets[name]
  if (!file) return Effect.succeed(HttpServerResponse.empty({ status: 404 }))
  if (request.method !== "GET" && request.method !== "HEAD")
    return Effect.succeed(HttpServerResponse.empty({ status: 405 }))
  const html = name === "index.html"
  const revalidate = html || name === "sw.js" || name === "registerSW.js"
  const headers = {
    "content-type": FSUtil.mimeType(name),
    "cache-control": revalidate ? "no-cache" : "public, max-age=31536000, immutable",
    "content-security-policy": html
      ? cspForHtml(typeof file === "string" ? file : Buffer.from(file).toString())
      : csp(),
    "x-content-type-options": "nosniff",
  }
  return Effect.succeed(
    request.method === "HEAD"
      ? HttpServerResponse.empty({ status: 200, headers })
      : HttpServerResponse.raw(file, { headers, contentType: headers["content-type"] }),
  )
}

function isRouteNotFound(error: unknown) {
  return error instanceof HttpServerError.HttpServerError && error.reason._tag === "RouteNotFound"
}

function csp(hashes: string[] = []) {
  return `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'${hashes.map((hash) => ` 'sha256-${hash}'`).join("")}; style-src 'self' 'unsafe-inline'; img-src 'self' data: https: blob:; font-src 'self' data:; media-src 'self' data:; connect-src * data: blob:`
}

function cspForHtml(body: string) {
  const scripts = body.matchAll(
    /<script\b(?![^>]*\bsrc\s*=)[^>]*\bid=(["'])oc-(?:theme-preload|ios-input-zoom)-script\1[^>]*>([\s\S]*?)<\/script>/gi,
  )
  return csp(Array.from(scripts, (match) => createHash("sha256").update(match[2]).digest("base64")))
}

export * as WebUi from "./web-ui"
