import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose"
import type { Pipeline } from "cloudflare:pipelines"
import semver from "semver"
import { stringify } from "yaml"

interface Env {
  DB: D1Database
  EVENTS: Pipeline
}

type ArtifactRow = {
  channel: string
  name: string
  distribution: string
  version: string
  metadata: string
  active: number
  minimum: number
  time_created: number
  time_updated: number
}

type Artifact = Omit<ArtifactRow, "metadata" | "active" | "minimum"> & {
  metadata: unknown
  active: boolean
  minimum: boolean
}

type ArtifactInput = Pick<ArtifactRow, "channel" | "name" | "distribution" | "version"> & {
  metadata: unknown
}

const identifier = /^[a-zA-Z0-9._-]{1,64}$/
const version = /^[a-zA-Z0-9.+_-]{1,128}$/
const select =
  "SELECT channel, name, distribution, version, metadata, active, minimum, time_created, time_updated FROM artifact"
const audience = "https://update.opencode.ai"
const githubKeys = createRemoteJWKSet(new URL("https://token.actions.githubusercontent.com/.well-known/jwks"))

export default {
  async fetch(request: Request, env: Env, ctx: Pick<ExecutionContext, "waitUntil">): Promise<Response> {
    const url = new URL(request.url)
    // The legacy hostname only exposes /admin, covered by its existing Access policy.
    const prefix =
      url.hostname !== "update.opencode.ai" && (url.pathname === "/update" || url.pathname.startsWith("/update/"))
        ? "/update"
        : ""
    const pathname = url.pathname.slice(prefix.length) || "/"
    ctx.waitUntil(
      env.EVENTS.send([
        {
          source: "update",
          type: "request",
          timestamp: new Date().toISOString(),
          payload: {
            method: request.method,
            path: pathname,
            useragent: request.headers.get("user-agent"),
            ip: request.headers.get("cf-connecting-ip"),
            cf_country: request.cf?.country,
            cf_colo: request.cf?.colo,
          },
        },
      ]).catch(() => console.error("Failed to send update request event to the data lake")),
    )

    if (pathname === "/") return json({ service: "opencode-update" })
    if (pathname === "/admin" && request.method === "GET") return admin(request, env, prefix)
    if (pathname === "/admin/activate" && request.method === "POST") return markArtifact(request, env, "active", prefix)
    if (pathname === "/admin/minimum" && request.method === "POST") return markArtifact(request, env, "minimum", prefix)
    if (pathname === "/admin/rollout" && request.method === "POST") return configureRollout(request, env, prefix)
    if (pathname === "/api/publish" && request.method === "POST") return publishArtifact(request, env)
    if (request.method !== "GET") return new Response("Method not allowed", { status: 405 })

    const [root, ...path] = pathname.split("/").filter(Boolean)
    if (root !== "api" || path.length < 1 || path.length > 4 || !path.every(validIdentifier)) {
      return new Response("Not found", { status: 404 })
    }

    const resolved = resolveChannel(path[0])
    const agent = request.headers.get("User-Agent")?.match(/^opencode\/(?:([^/]+)\/([^/]+)\/cli|(.*))$/)
    const current = url.searchParams.get("current") ?? agent?.[2] ?? agent?.[3]
    const source = agent?.[1] ?? current?.match(/^v?0\.0\.0-(.+)-\d+(?:\.\d+)?(?:\+.*)?$/)?.[1]
    const caller = source === undefined || resolveChannel(source) === resolved ? current : undefined
    const rollout = await env.DB.prepare("SELECT duration_hours FROM channel_rollout WHERE channel = ?")
      .bind(resolved)
      .first<{ duration_hours: number }>()
    const ip = request.headers.get("CF-Connecting-IP")
    const hash =
      rollout?.duration_hours && ip
        ? new DataView(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${resolved}:${ip}`))).getUint32(
            0,
          )
        : undefined
    // Missing IPs wait for full rollout. The same IP keeps its position across releases.
    const cutoff =
      Date.now() - (rollout?.duration_hours ?? 0) * 3_600_000 * (hash === undefined ? 1 : (hash + 1) / 2 ** 32)
    if (path.length === 4) {
      if (path[1] !== "desktop" || !/^latest(?:-mac|-linux(?:-arm64)?)?\.yml$/.test(path[3])) {
        return new Response("Not found", { status: 404 })
      }
      return artifactDistribution(env.DB, resolved, path[1], path[2], caller, cutoff, path[3])
    }
    if (path.length === 1) return channel(env.DB, resolved, caller, cutoff)
    if (path.length === 2) return artifactName(env.DB, resolved, path[1], caller, cutoff)
    return artifactDistribution(env.DB, resolved, path[1], path[2], caller, cutoff)
  },
} satisfies ExportedHandler<Env>

async function channel(db: D1Database, channel: string, current: string | undefined, cutoff: number) {
  const result = await db
    .prepare(`${select} WHERE channel = ? AND (active = 1 OR minimum = 1) ORDER BY name, distribution`)
    .bind(channel)
    .all<ArtifactRow>()
  const artifacts = await selectArtifacts(db, result.results, current, cutoff)
  if (!artifacts.length) return json({ error: "Channel not found" }, 404)
  return updateResponse({ channel, artifacts: artifacts.map(decodeArtifact) })
}

async function artifactName(
  db: D1Database,
  channel: string,
  name: string,
  current: string | undefined,
  cutoff: number,
) {
  const result = await db
    .prepare(`${select} WHERE channel = ? AND name = ? AND (active = 1 OR minimum = 1) ORDER BY distribution`)
    .bind(channel, name)
    .all<ArtifactRow>()
  const artifacts = await selectArtifacts(db, result.results, current, cutoff)
  if (!artifacts.length) return json({ error: "Artifact not found" }, 404)
  return updateResponse({ channel, name, artifacts: artifacts.map(decodeArtifact) })
}

async function artifactDistribution(
  db: D1Database,
  channel: string,
  name: string,
  distribution: string,
  current: string | undefined,
  cutoff: number,
  manifest?: string,
) {
  const result = await db
    .prepare(`${select} WHERE channel = ? AND name = ? AND distribution = ? AND (active = 1 OR minimum = 1)`)
    .bind(channel, name, distribution)
    .all<ArtifactRow>()
  const artifact = (await selectArtifacts(db, result.results, current, cutoff))[0]
  if (!artifact) return json({ error: "Artifact not found" }, 404)
  if (manifest) {
    const metadata = decodeMetadata(artifact.metadata)
    const value =
      isRecord(metadata) && isRecord(metadata.manifests)
        ? metadata.manifests[manifest.replace(/^latest/, "desktop")]
        : undefined
    if (!isRecord(value)) return json({ error: "Manifest not found" }, 404)
    return new Response(stringify({ ...value, version: artifact.version }), {
      headers: { "Content-Type": "application/yaml; charset=utf-8", "Cache-Control": "no-store" },
    })
  }
  return updateResponse(decodeArtifact(artifact))
}

async function selectArtifacts(db: D1Database, rows: ArtifactRow[], current: string | undefined, cutoff: number) {
  const caller = current === undefined ? undefined : releaseVersion(current)
  const artifacts = await Promise.all(
    rows
      .filter((row) => row.active === 1)
      .map(async (active) => {
        const minimum = rows.find(
          (row) => row.minimum === 1 && row.name === active.name && row.distribution === active.distribution,
        )
        const floor = minimum && releaseVersion(minimum.version)
        if (current !== undefined && minimum && (!floor || !caller || semver.lt(caller, floor))) return minimum
        if (active.time_created <= cutoff) return active
        const previous = await db
          .prepare(
            `${select} WHERE channel = ? AND name = ? AND distribution = ? AND time_created < ? AND time_created <= ? ORDER BY time_created DESC, version DESC LIMIT 1`,
          )
          .bind(active.channel, active.name, active.distribution, active.time_created, cutoff)
          .first<ArtifactRow>()
        // A rollout must not send an identified client back below its compatibility floor.
        if (current !== undefined && minimum) {
          const version = previous && releaseVersion(previous.version)
          if (!version || !floor || semver.lt(version, floor)) return minimum
        }
        return previous
      }),
  )
  return artifacts.filter((artifact) => artifact !== null)
}

async function configureRollout(request: Request, env: Env, prefix: string) {
  const invalid = validMutation(request)
  if (invalid) return invalid
  const form = await request.formData()
  const channel = form.get("channel")
  const input = form.get("duration_hours")
  const duration = typeof input === "string" && input.trim() ? Number(input) : NaN
  if (
    !validIdentifier(channel) ||
    channel === "next" ||
    !Number.isFinite(duration) ||
    duration < 0 ||
    !Number.isFinite(duration * 3_600_000)
  ) {
    return json({ error: "Channel and a non-negative rollout duration in hours are required" }, 400)
  }
  await env.DB.prepare(
    "INSERT INTO channel_rollout (channel, duration_hours) VALUES (?, ?) ON CONFLICT (channel) DO UPDATE SET duration_hours = excluded.duration_hours",
  )
    .bind(channel, duration)
    .run()
  return Response.redirect(new URL(`${prefix}/admin`, request.url), 303)
}

function releaseVersion(input: string) {
  // Preview builds use a hyphen before the run number. Normalize it to a numeric
  // prerelease identifier, and compare historical next builds in the beta channel.
  return semver.valid(
    input.replace(
      /^(v?0\.0\.0)-(next|beta|dev)-(\d+)(?=\.|$)/,
      (_, core, channel, build) => `${core}-${resolveChannel(channel)}.${build}`,
    ),
  )
}

async function admin(request: Request, env: Env, prefix: string) {
  const url = new URL(request.url)
  const rollouts = await env.DB.prepare(
    `SELECT channels.channel, COALESCE(channel_rollout.duration_hours, 0) AS duration_hours
     FROM (SELECT channel FROM artifact UNION SELECT channel FROM channel_rollout) AS channels
     LEFT JOIN channel_rollout ON channel_rollout.channel = channels.channel
     WHERE channels.channel != 'next' ORDER BY channels.channel`,
  ).all<{ channel: string; duration_hours: number }>()
  const requestedPage = Number.parseInt(url.searchParams.get("page") ?? "1", 10)
  const page = Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1
  const pageSize = 100
  const count = await env.DB.prepare("SELECT COUNT(*) AS total FROM artifact").first<{ total: number }>()
  const pages = Math.max(1, Math.ceil((count?.total ?? 0) / pageSize))
  const currentPage = Math.min(page, pages)
  const result = await env.DB.prepare(`${select} ORDER BY time_created DESC LIMIT ? OFFSET ?`)
    .bind(pageSize, (currentPage - 1) * pageSize)
    .all<ArtifactRow>()
  const rows = result.results
    .map(
      (artifact) => `<tr>
        <td><code>${escape(artifact.channel)}</code></td>
        <td><code>${escape(artifact.name)}</code></td>
        <td><code>${escape(artifact.distribution)}</code></td>
        <td><code>${escape(artifact.version)}</code></td>
        <td>${new Date(artifact.time_created).toISOString()}</td>
        <td>${artifact.active ? '<span class="badge">Active</span>' : '<span class="badge" data-variant="secondary">Inactive</span>'}
          ${artifact.minimum ? '<span class="badge">Minimum</span>' : ""}</td>
        <td>
          ${
            artifact.active
              ? ""
              : `<form action="${prefix}/admin/activate" method="post">
                  <input type="hidden" name="channel" value="${escape(artifact.channel)}">
                  <input type="hidden" name="name" value="${escape(artifact.name)}">
                  <input type="hidden" name="distribution" value="${escape(artifact.distribution)}">
                  <input type="hidden" name="version" value="${escape(artifact.version)}">
                  <button class="btn" data-size="sm" data-variant="outline" type="submit">Activate</button>
                </form>`
          }
          <form action="${prefix}/admin/minimum" method="post">
            <input type="hidden" name="channel" value="${escape(artifact.channel)}">
            <input type="hidden" name="name" value="${escape(artifact.name)}">
            <input type="hidden" name="distribution" value="${escape(artifact.distribution)}">
            <input type="hidden" name="version" value="${escape(artifact.version)}">
            <input type="hidden" name="enabled" value="${artifact.minimum ? "0" : "1"}">
            <button class="btn" data-size="sm" data-variant="outline" type="submit">${artifact.minimum ? "Clear minimum" : "Set minimum"}</button>
          </form>
        </td>
      </tr>`,
    )
    .join("")

  return new Response(
    `<!doctype html>
<html lang="en" class="dark">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>OpenCode Update</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/basecoat-css@1.0.2/dist/basecoat.cdn.min.css">
  <style>
    body { min-height: 100vh; background: var(--background); }
    main { width: min(1180px, calc(100% - 2rem)); margin: 0 auto; padding: 4rem 0; }
    .masthead { display: flex; align-items: end; justify-content: space-between; gap: 1rem; margin-bottom: 2rem; }
    .masthead h1 { font-size: clamp(2.25rem, 6vw, 4.5rem); line-height: .95; letter-spacing: -.055em; }
    .masthead p { color: var(--muted-foreground); }
    .table-wrap { overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; }
    th, td { padding: .8rem 1rem; border-bottom: 1px solid var(--border); text-align: left; white-space: nowrap; }
    th { color: var(--muted-foreground); font-size: .75rem; font-weight: 500; text-transform: uppercase; letter-spacing: .08em; }
    tbody tr:last-child td { border-bottom: 0; }
    td form { margin: 0; display: inline-block; }
    .pagination { display: flex; align-items: center; justify-content: space-between; gap: 1rem; border-top: 1px solid var(--border); padding: 1rem; }
    .pagination p { color: var(--muted-foreground); font-size: .875rem; }
    .pagination nav { display: flex; gap: .5rem; }
    @media (max-width: 760px) { main { padding: 2rem 0; } .masthead { align-items: start; flex-direction: column; } }
  </style>
</head>
<body>
  <main>
    <header class="masthead">
      <div><p>Release control</p><h1>Artifacts</h1></div>
      <span class="badge" data-variant="outline">${escape(request.headers.get("Cf-Access-Authenticated-User-Email") ?? "Cloudflare Access pending")}</span>
    </header>
    <article class="card" style="margin-bottom: 2rem">
      <header><h2>Channel rollouts</h2><p>Hours from publication to full availability. Zero is immediate. Changes apply immediately to existing releases.</p></header>
      <section>
        ${
          rollouts.results
            .map(
              (rollout) => `<form action="${prefix}/admin/rollout" method="post">
          <input type="hidden" name="channel" value="${escape(rollout.channel)}">
          <label>${escape(rollout.channel)} — hours <input class="input" type="number" name="duration_hours" min="0" step="any" required value="${rollout.duration_hours}"></label>
          <button class="btn" type="submit">Save</button>
        </form>`,
            )
            .join("") || "<p>Publish a release to configure its channel.</p>"
        }
      </section>
    </article>
    <article class="card">
      <header><h2>Published builds</h2><p>Every build received from the trusted publishing workflow, newest first.</p></header>
      <section class="table-wrap">
        <table>
          <thead><tr><th>Channel</th><th>Name</th><th>Distribution</th><th>Version</th><th>Created</th><th>Status</th><th></th></tr></thead>
          <tbody>${rows || '<tr><td colspan="7">No builds have been published yet.</td></tr>'}</tbody>
        </table>
      </section>
      <footer class="pagination">
        <p>Page ${currentPage} of ${pages} · ${count?.total ?? 0} builds</p>
        <nav aria-label="Pagination">
          ${currentPage > 1 ? `<a class="btn" data-size="sm" data-variant="outline" href="${prefix}/admin?page=${currentPage - 1}">Previous</a>` : ""}
          ${currentPage < pages ? `<a class="btn" data-size="sm" data-variant="outline" href="${prefix}/admin?page=${currentPage + 1}">Next</a>` : ""}
        </nav>
      </footer>
    </article>
  </main>
</body>
</html>`,
    { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } },
  )
}

async function publishArtifact(request: Request, env: Env) {
  const claims = await verifyGitHub(request)
  if (claims instanceof Response) return claims
  const input: unknown = await request.json().catch(() => undefined)
  const artifact = parseArtifact(isRecord(input) ? input : {})
  if (artifact instanceof Response) return artifact
  if (!channelsForRef(claims.ref).includes(artifact.channel)) return json({ error: "Channel is not allowed" }, 403)
  if (!isRecord(artifact.metadata)) return json({ error: "Metadata must be an object" }, 400)
  await activate(env.DB, [
    {
      ...artifact,
      metadata: {
        ...artifact.metadata,
        github: {
          sha: claims.sha,
          run_id: claims.run_id,
          run_attempt: claims.run_attempt,
          actor: claims.actor,
          ref: claims.ref,
        },
      },
    },
  ])
  return json({ published: true })
}

async function markArtifact(request: Request, env: Env, flag: "active" | "minimum", prefix: string) {
  const invalid = validMutation(request)
  if (invalid) return invalid
  const form = await request.formData()
  const key = parseKey({
    channel: form.get("channel"),
    name: form.get("name"),
    distribution: form.get("distribution"),
    version: form.get("version"),
  })
  if (key instanceof Response) return key
  const enabled = flag === "minimum" && form.get("enabled") === "0" ? 0 : 1
  if (flag === "minimum" && enabled && !releaseVersion(key.version)) {
    return json({ error: "Minimum must have a comparable release version" }, 400)
  }
  const exists = await env.DB.prepare(
    "SELECT 1 FROM artifact WHERE channel = ? AND name = ? AND distribution = ? AND version = ?",
  )
    .bind(key.channel, key.name, key.distribution, key.version)
    .first()
  if (!exists) return json({ error: "Artifact not found" }, 404)
  await env.DB.batch([
    ...(enabled
      ? [
          env.DB.prepare(
            `UPDATE artifact SET ${flag} = 0 WHERE channel = ? AND name = ? AND distribution = ? AND ${flag} = 1`,
          ).bind(key.channel, key.name, key.distribution),
        ]
      : []),
    env.DB.prepare(
      `UPDATE artifact SET ${flag} = ?, time_updated = ? WHERE channel = ? AND name = ? AND distribution = ? AND version = ?`,
    ).bind(enabled, Date.now(), key.channel, key.name, key.distribution, key.version),
  ])
  return Response.redirect(new URL(`${prefix}/admin`, request.url), 303)
}

function activate(db: D1Database, artifacts: ArtifactInput[]) {
  return db.batch(
    artifacts.flatMap((artifact) => {
      const time = Date.now()
      return [
        deactivateStatement(db, artifact),
        db
          .prepare(
            `INSERT INTO artifact (channel, name, distribution, version, metadata, active, time_created, time_updated)
             VALUES (?, ?, ?, ?, ?, 1, ?, ?)
             ON CONFLICT (channel, name, distribution, version) DO UPDATE SET
               metadata = excluded.metadata, active = 1, time_updated = excluded.time_updated`,
          )
          .bind(
            artifact.channel,
            artifact.name,
            artifact.distribution,
            artifact.version,
            JSON.stringify(artifact.metadata),
            time,
            time,
          ),
      ]
    }),
  )
}

function deactivateStatement(db: D1Database, artifact: Pick<ArtifactInput, "channel" | "name" | "distribution">) {
  return db
    .prepare("UPDATE artifact SET active = 0 WHERE channel = ? AND name = ? AND distribution = ? AND active = 1")
    .bind(artifact.channel, artifact.name, artifact.distribution)
}

function parseArtifact(input: Record<string, unknown>): ArtifactInput | Response {
  const key = parseKey(input)
  if (key instanceof Response) return key
  const metadata = typeof input.metadata === "string" ? parseMetadata(input.metadata) : input.metadata
  if (metadata === undefined) return json({ error: "Metadata must be valid JSON" }, 400)
  return { ...key, metadata }
}

function parseKey(input: Record<string, unknown>): Omit<ArtifactInput, "metadata"> | Response {
  if (
    !validIdentifier(input.channel) ||
    input.channel === "next" ||
    !validIdentifier(input.name) ||
    !validIdentifier(input.distribution) ||
    !validVersion(input.version)
  )
    return json({ error: "Invalid artifact" }, 400)
  return {
    channel: input.channel,
    name: input.name,
    distribution: input.distribution,
    version: input.version,
  }
}

function decodeArtifact(row: ArtifactRow): Artifact {
  return { ...row, metadata: decodeMetadata(row.metadata), active: row.active === 1, minimum: row.minimum === 1 }
}

function decodeMetadata(input: string) {
  return parseMetadata(input) ?? null
}

function parseMetadata(input: string): unknown | undefined {
  try {
    return JSON.parse(input)
  } catch {
    return
  }
}

async function verifyGitHub(request: Request) {
  const authorization = request.headers.get("Authorization")
  if (!authorization?.startsWith("Bearer ")) return json({ error: "Unauthorized" }, 401)
  const result = await jwtVerify(authorization.slice("Bearer ".length), githubKeys, {
    issuer: "https://token.actions.githubusercontent.com",
    audience,
  }).catch(() => undefined)
  if (!result || !validGitHubClaims(result.payload)) return json({ error: "Unauthorized" }, 401)
  return result.payload
}

type GitHubClaims = JWTPayload & {
  repository: string
  repository_id: string
  repository_owner_id: string
  workflow_ref: string
  ref: string
  sha: string
  run_id: string
  run_attempt: string
  actor: string
}

export function validGitHubClaims(claims: JWTPayload): claims is GitHubClaims {
  if (claims.repository !== "anomalyco/opencode") return false
  if (claims.repository_id !== "975734319") return false
  if (claims.repository_owner_id !== "66570915") return false
  if (typeof claims.workflow_ref !== "string" || typeof claims.ref !== "string") return false
  if (claims.workflow_ref !== `anomalyco/opencode/.github/workflows/publish.yml@${claims.ref}`) return false
  if (!channelsForRef(claims.ref).length) return false
  return [claims.sha, claims.run_id, claims.run_attempt, claims.actor].every((value) => typeof value === "string")
}

export function channelsForRef(ref: string) {
  if (ref === "refs/heads/dev") return ["dev", "latest"]
  if (ref === "refs/heads/v2") return ["dev", "latest"]
  if (ref === "refs/heads/beta") return ["beta"]
  if (ref === "refs/heads/ci") return ["ci"]
  if (ref === "refs/heads/fix/npm-native-binary-install") return ["fix/npm-native-binary-install"]
  const snapshot = ref.match(/^refs\/heads\/(snapshot-[a-zA-Z0-9._-]+)$/)?.[1]
  return snapshot ? [snapshot] : []
}

export function resolveChannel(channel: string) {
  return channel === "next" ? "beta" : channel
}

function validMutation(request: Request) {
  const origin = request.headers.get("Origin")
  if (origin && origin !== new URL(request.url).origin) return json({ error: "Invalid origin" }, 403)
}

function validIdentifier(input: unknown): input is string {
  return typeof input === "string" && identifier.test(input)
}

function validVersion(input: unknown): input is string {
  return typeof input === "string" && version.test(input)
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input)
}

function updateResponse(value: unknown) {
  return json(value, 200, { "Cache-Control": "no-store" })
}

function json(value: unknown, status = 200, headers?: HeadersInit) {
  return Response.json(value, { status, headers: { "Cache-Control": "no-store", ...headers } })
}

function escape(value: string) {
  return value.replace(/[&<>"']/g, (character) => {
    if (character === "&") return "&amp;"
    if (character === "<") return "&lt;"
    if (character === ">") return "&gt;"
    if (character === '"') return "&quot;"
    return "&#39;"
  })
}
