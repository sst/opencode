import { Effect } from "effect"
import { define } from "@opencode/plugin/effect/plugin"
import { Provider } from "../../provider.js"

function resolveProject(options: Record<string, any>) {
  // models.dev advertises GOOGLE_VERTEX_PROJECT for Vertex, while Google SDKs
  // and ADC examples commonly use the broader Google Cloud project aliases.
  return (
    options.project ??
    process.env.GOOGLE_VERTEX_PROJECT ??
    process.env.GOOGLE_CLOUD_PROJECT ??
    process.env.GCP_PROJECT ??
    process.env.GCLOUD_PROJECT
  )
}

function resolveLocation(options: Record<string, any>) {
  return (
    options.location ??
    process.env.GOOGLE_VERTEX_LOCATION ??
    process.env.GOOGLE_CLOUD_LOCATION ??
    process.env.VERTEX_LOCATION ??
    "us-central1"
  )
}

function vertexEndpoint(location: string) {
  if (location === "global") return "aiplatform.googleapis.com"
  return `${location}-aiplatform.googleapis.com`
}

function replaceVertexVars(value: string, project: string | undefined, location: string) {
  // Vertex OpenAI-compatible endpoints are stored as templates in the catalog;
  // expand them after provider config/env project and location have been resolved.
  return value
    .replaceAll("${GOOGLE_VERTEX_PROJECT}", project ?? "${GOOGLE_VERTEX_PROJECT}")
    .replaceAll("${GOOGLE_VERTEX_LOCATION}", location)
    .replaceAll("${GOOGLE_VERTEX_ENDPOINT}", vertexEndpoint(location))
}

function authFetch(fetchWithRuntimeOptions?: unknown) {
  // Native Vertex SDKs handle ADC internally. OpenAI-compatible Vertex endpoints
  // do not, so inject a Google access token into their fetch path.
  return async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const { GoogleAuth } = await import("google-auth-library")
    const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] })
    const client = await auth.getClient()
    const token = await client.getAccessToken()
    const headers = new Headers(init?.headers)
    headers.set("Authorization", `Bearer ${token.token}`)
    return typeof fetchWithRuntimeOptions === "function"
      ? fetchWithRuntimeOptions(input, { ...init, headers })
      : fetch(input, { ...init, headers })
  }
}

export const GoogleVertexPlugin = define({
  id: "opencode.provider.google.vertex",
  effect: Effect.fn(function* (ctx) {
    yield* ctx.catalog.transform((evt) => {
      for (const item of evt.provider.list()) {
        if (!Provider.isAISDK(item.provider.package)) continue
        if (
          Provider.packageName(item.provider.package) !== "@ai-sdk/google-vertex" &&
          !(
            item.provider.id === Provider.ID.googleVertex &&
            Provider.packageName(item.provider.package)?.includes("@ai-sdk/openai-compatible")
          )
        )
          continue
        const project = resolveProject(item.provider.settings ?? {})
        const location = String(resolveLocation(item.provider.settings ?? {}))
        evt.provider.update(item.provider.id, (provider) => {
          // Vertex authenticates through ADC rather than a key credential, so a
          // resolvable project is what makes the provider usable.
          if (project && provider.activation === "auto") provider.activation = "enabled"
          provider.settings = {
            ...provider.settings,
            ...(project ? { project } : {}),
            location,
            ...(typeof provider.settings?.baseURL === "string"
              ? { baseURL: replaceVertexVars(provider.settings.baseURL, project, location) }
              : {}),
          }
        })
      }
    })
    yield* ctx.aisdk.hook(
      "sdk",
      Effect.fn(function* (evt) {
        if (evt.model.providerID === Provider.ID.googleVertex && evt.package.includes("@ai-sdk/openai-compatible")) {
          evt.options.fetch = authFetch(evt.options.fetch)
          return
        }
      }),
    )
    yield* ctx.aisdk.hook(
      "language",
      Effect.fn(function* (evt) {
        if (evt.model.providerID !== Provider.ID.googleVertex) return
        evt.language = evt.sdk.languageModel(String(evt.model.modelID ?? evt.model.id).trim())
      }),
    )
  }),
})
