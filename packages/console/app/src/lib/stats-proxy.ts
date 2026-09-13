import type { APIEvent } from "@solidjs/start/server"
import { Resource, waitUntil } from "@opencode-ai/console-resource"
import { LOCALE_HEADER, cookie, localeFromRequest, route, tag } from "~/lib/language"

const dataPath = "/data"
const statsCacheParam = "__opencode_stats_locale"

export async function statsProxy(evt: APIEvent) {
  const req = evt.request.clone()
  const locale = localeFromRequest(req)
  const redirect = redirectToLocalizedData(req, new URL(req.url), locale)
  if (redirect) return redirect

  const cache = defaultCache(caches)
  const cacheKey = statsCacheKey(req, locale)
  if (cacheKey) {
    const cached = await cache.match(cacheKey)
    if (cached) return withStatsCacheStatus(cached, "HIT")
  }

  const targetUrl = new URL(req.url)
  targetUrl.protocol = "https:"
  targetUrl.hostname = Resource.App.stage === "production" ? "stats.opencode.ai" : "stats.dev.opencode.ai"
  targetUrl.port = ""

  if (
    targetUrl.pathname.startsWith(`${dataPath}/_build/`) ||
    targetUrl.pathname === `${dataPath}/banner.jpg` ||
    targetUrl.pathname === `${dataPath}/banner.png` ||
    targetUrl.pathname === `${dataPath}/sitemap.xml`
  ) {
    targetUrl.pathname = targetUrl.pathname.slice(dataPath.length)
  }

  const requestHeaders = new Headers(req.headers)
  requestHeaders.set(LOCALE_HEADER, locale)
  requestHeaders.set("accept-language", tag(locale))

  const response = await fetch(targetUrl, {
    method: req.method,
    headers: requestHeaders,
    body: req.body,
  })

  if (!response.headers.get("content-type")?.includes("text/html")) return response

  const headers = new Headers(response.headers)
  headers.delete("content-encoding")
  headers.delete("content-length")
  headers.delete("etag")
  headers.delete("set-cookie")
  appendVary(headers, "Accept-Language", "Cookie", LOCALE_HEADER)

  const result = new Response(rewriteStatsHtml(await response.text()), {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
  if (!cacheKey || !response.ok) return result

  void waitUntil(cache.put(cacheKey, result.clone()))
  return withStatsCacheStatus(result, "MISS")
}

export function statsRedirect(evt: APIEvent) {
  const url = new URL(evt.request.url)
  url.pathname = `${dataPath}${url.pathname.slice("/stats".length)}`
  return new Response(null, {
    status: 308,
    headers: {
      Location: url.toString(),
    },
  })
}

function rewriteStatsHtml(html: string) {
  return html.replaceAll('"/_build/', `"${dataPath}/_build/`).replaceAll("'/_build/", `'${dataPath}/_build/`)
}

function statsCacheKey(request: Request, locale: ReturnType<typeof localeFromRequest>): Request | undefined {
  if (request.method !== "GET") return undefined
  if (!acceptsHtml(request)) return undefined
  if (isDataBypassPath(new URL(request.url).pathname)) return undefined

  const url = new URL(request.url)
  const additionalModels = url.searchParams.get("add")
  url.search = ""
  if (additionalModels) url.searchParams.set("add", additionalModels)
  url.searchParams.set(statsCacheParam, locale)
  return new Request(url)
}

function defaultCache(storage: CacheStorage) {
  if (!isCloudflareCacheStorage(storage)) throw new Error("Cloudflare default cache is unavailable")
  return storage.default
}

function isCloudflareCacheStorage(storage: CacheStorage): storage is CacheStorage & { default: Cache } {
  return "default" in storage
}

function withStatsCacheStatus(response: Response, status: "HIT" | "MISS") {
  const headers = new Headers(response.headers)
  headers.set("x-opencode-stats-cache", status)
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}

function redirectToLocalizedData(request: Request, url: URL, locale: ReturnType<typeof localeFromRequest>) {
  if (locale === "en") return null
  if (request.headers.get(LOCALE_HEADER)) return null
  if (request.method !== "GET" && request.method !== "HEAD") return null
  if (!acceptsHtml(request)) return null
  if (!url.pathname.startsWith(`${dataPath}/`) && url.pathname !== dataPath) return null
  if (isDataBypassPath(url.pathname)) return null

  const next = new URL(url)
  next.pathname = route(locale, url.pathname)

  const headers = new Headers({
    Location: next.toString(),
  })
  headers.append("set-cookie", cookie(locale))
  appendVary(headers, "Accept-Language", "Cookie", LOCALE_HEADER)

  return new Response(null, {
    status: 308,
    headers,
  })
}

function acceptsHtml(request: Request) {
  const accept = request.headers.get("accept")
  return !accept || accept.includes("text/html") || accept.includes("*/*")
}

function isDataBypassPath(pathname: string) {
  return (
    pathname.startsWith(`${dataPath}/_build/`) ||
    pathname.startsWith(`${dataPath}/api/`) ||
    pathname.startsWith(`${dataPath}/_server`) ||
    pathname === `${dataPath}/banner.jpg` ||
    pathname === `${dataPath}/banner.png` ||
    pathname === `${dataPath}/sitemap.xml`
  )
}

function appendVary(headers: Headers, ...values: string[]) {
  const existing = headers
    .get("vary")
    ?.split(",")
    .map((value) => value.trim())
    .filter(Boolean)

  headers.set(
    "vary",
    values
      .reduce(
        (result, value) =>
          result.some((item) => item.toLowerCase() === value.toLowerCase()) ? result : [...result, value],
        existing ?? [],
      )
      .join(", "),
  )
}
