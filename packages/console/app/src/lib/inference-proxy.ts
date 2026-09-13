import { Resource } from "@opencode-ai/console-resource"
import { and, Database, eq, isNull, sql } from "@opencode-ai/console-core/drizzle/index.js"
import { KeyTable } from "@opencode-ai/console-core/schema/key.sql.js"
import { ProviderTable } from "@opencode-ai/console-core/schema/provider.sql.js"
import { WorkspaceTable } from "@opencode-ai/console-core/schema/workspace.sql.js"

const paths: Record<string, string | undefined> = {
  "POST /zen/v1/chat/completions": "/openai/v1/chat/completions",
  "POST /zen/v1/responses": "/openai/v1/responses",
  "POST /zen/v1/messages": "/anthropic/v1/messages",
  "POST /zen/go/v1/chat/completions": "/go/openai/v1/chat/completions",
  "POST /zen/go/v1/responses": "/go/openai/v1/responses",
  "POST /zen/go/v1/messages": "/go/anthropic/v1/messages",
  "GET /zen/v1/models": "/v1/models",
  "GET /zen/go/v1/models": "/go/v1/models",
  "GET /zen/go/v1/usage": "/go/v1/usage",
}

export async function proxyInference(
  request: Request,
  generation?: {
    provider?: "openai" | "anthropic" | "google"
    /** The provider's native model ID, not the public Zen alias. */
    model?: string
    body: (model?: string) => ReadableStream<Uint8Array>
  },
): Promise<Response | undefined> {
  const url = new URL(request.url)
  const path =
    paths[`${request.method} ${url.pathname}`] ??
    (request.method === "POST" &&
    /^\/zen\/v1\/models\/[^/]+:(?:generateContent|streamGenerateContent)$/.test(url.pathname)
      ? url.pathname.replace("/zen/v1/models/", "/google/v1beta/models/")
      : undefined)
  if (!path) return undefined

  const go = url.pathname.startsWith("/zen/go/")
  const key = url.pathname.endsWith("/messages")
    ? request.headers.get("x-api-key")
    : path.startsWith("/google/")
      ? request.headers.get("x-goog-api-key")
      : request.headers.get("authorization")?.split(" ")[1]
  if (!key || key === "public") return undefined

  // Routing only; the destination owns authentication and revocation after cutover.
  const workspace = await Database.use((tx) =>
    tx
      .select({
        id: WorkspaceTable.id,
        migratedAt: WorkspaceTable.migrated_at,
        provider: ProviderTable.provider,
      })
      .from(KeyTable)
      .innerJoin(WorkspaceTable, eq(WorkspaceTable.id, KeyTable.workspaceID))
      .leftJoin(
        ProviderTable,
        !go && generation?.provider
          ? and(
              eq(ProviderTable.workspaceID, KeyTable.workspaceID),
              eq(ProviderTable.provider, generation.provider),
              isNull(ProviderTable.timeDeleted),
              sql`length(${ProviderTable.credentials}) > 0`,
            )
          : sql`false`,
      )
      .where(eq(KeyTable.key, key))
      .limit(1)
      .then((rows) => rows[0]),
  )
  if (!workspace?.migratedAt) return undefined
  const model = workspace.provider ? generation?.model : undefined
  if (workspace.provider && !model) throw new Error("Legacy BYOK model mapping is unavailable")

  const destination = new URL(Resource.ConsoleMigration.inferenceUrl)
  // Imported connections must use this same workspace/provider-derived ID.
  const target = model
    ? `/custom/conn_${workspace.id.slice(4)}_${workspace.provider}${
        path.startsWith("/google/")
          ? `/models/${encodeURIComponent(model)}${url.pathname.slice(url.pathname.lastIndexOf(":"))}`
          : url.pathname.slice("/zen/v1".length)
      }`
    : path
  destination.pathname = `${destination.pathname.replace(/\/$/, "")}${target}`
  destination.search = url.search
  destination.hash = ""

  // Model extraction has already read part of the body; forward its replay stream.
  const forwarded = new Request(
    destination,
    generation ? new Request(request, { method: request.method, body: generation.body(model) }) : request,
  )
  // Migrated requests use ordinary destination authentication and accounting.
  for (const name of [
    "x-zen",
    "x-zen-model",
    "x-zen-ip",
    "cf-access-client-id",
    "cf-access-client-secret",
    "host",
    "content-length",
  ])
    forwarded.headers.delete(name)
  forwarded.headers.set("authorization", `Bearer ${key}`)
  const ip = request.headers.get("cf-connecting-ip")
  if (ip) forwarded.headers.set("x-real-ip", ip)
  const requestID = request.headers.get("x-opencode-request-id") ?? request.headers.get("x-opencode-request")
  if (requestID) forwarded.headers.set("x-opencode-request-id", requestID)

  return fetch(forwarded, { redirect: "manual" })
}

export function inferenceUnavailable() {
  return Response.json(
    { error: { type: "api_error", message: "Inference routing is unavailable. Please retry later." } },
    { status: 503, headers: { "Cache-Control": "no-store" } },
  )
}
