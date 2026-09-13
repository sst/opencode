export * as Provider from "./provider.js"

import { Effect, Schema, Struct } from "effect"
import { Provider } from "@opencode/schema/provider"
import type { ProviderPackageDefinition } from "@opencode/ai"
import { isRecord } from "@opencode/ai/utils/record"
import { Npm } from "@opencode/util/npm"
import type { DeepMutable } from "./schema.js"
import { importModule, resolveModule } from "@opencode/util/runtime-import"

export const ID = Provider.ID
export type ID = typeof ID.Type

export const AISDK_PREFIX = "aisdk:"
export const isAISDK = (value: string | undefined): value is string => value?.startsWith(AISDK_PREFIX) ?? false
export const aisdk = (value: string) => (isAISDK(value) ? value : `${AISDK_PREFIX}${value}`)
export function packageName(value: string): string
export function packageName(value: undefined): undefined
export function packageName(value: string | undefined): string | undefined
export function packageName(value: string | undefined) {
  // Native provider entrypoints can persist in user configuration across the npm scope migration.
  if (value?.startsWith("@opencode-ai/ai/")) return value.replace("@opencode-ai/", "@opencode/")
  if (value === undefined || !isAISDK(value)) return value
  return value.slice(AISDK_PREFIX.length)
}

type Json = Schema.Schema.Type<typeof Schema.Json>
const JsonRecord = Schema.Record(Schema.String, Schema.Json)
const decodeJsonRecord = Schema.decodeUnknownSync(JsonRecord)

export class LoadError extends Schema.TaggedError<LoadError>()("Provider.LoadError", {
  package: Schema.String,
  cause: Schema.Defect(),
}) {}
export type ProviderPackage = ProviderPackageDefinition

const packages = new Map<string, Promise<unknown>>()
const builtins = new Map<string, () => Promise<unknown>>([
  ["@opencode/ai/providers/amazon-bedrock", () => import("@opencode/ai/providers/amazon-bedrock")],
  ["@opencode/ai/providers/amazon-bedrock/mantle", () => import("@opencode/ai/providers/amazon-bedrock/mantle")],
  [
    "@opencode/ai/providers/amazon-bedrock/mantle/chat",
    () => import("@opencode/ai/providers/amazon-bedrock/mantle/chat"),
  ],
  [
    "@opencode/ai/providers/amazon-bedrock/mantle/responses",
    () => import("@opencode/ai/providers/amazon-bedrock/mantle/responses"),
  ],
  ["@opencode/ai/providers/anthropic", () => import("@opencode/ai/providers/anthropic")],
  ["@opencode/ai/providers/azure", () => import("@opencode/ai/providers/azure")],
  ["@opencode/ai/providers/azure/chat", () => import("@opencode/ai/providers/azure/chat")],
  ["@opencode/ai/providers/azure/responses", () => import("@opencode/ai/providers/azure/responses")],
  ["@opencode/ai/providers/baseten", () => import("@opencode/ai/providers/baseten")],
  ["@opencode/ai/providers/cerebras", () => import("@opencode/ai/providers/cerebras")],
  ["@opencode/ai/providers/cloudflare-ai-gateway", () => import("@opencode/ai/providers/cloudflare-ai-gateway")],
  ["@opencode/ai/providers/cloudflare-workers-ai", () => import("@opencode/ai/providers/cloudflare-workers-ai")],
  ["@opencode/ai/providers/deepinfra", () => import("@opencode/ai/providers/deepinfra")],
  ["@opencode/ai/providers/deepseek", () => import("@opencode/ai/providers/deepseek")],
  ["@opencode/ai/providers/fireworks", () => import("@opencode/ai/providers/fireworks")],
  ["@opencode/ai/providers/google", () => import("@opencode/ai/providers/google")],
  ["@opencode/ai/providers/google-vertex", () => import("@opencode/ai/providers/google-vertex")],
  ["@opencode/ai/providers/google-vertex/gemini", () => import("@opencode/ai/providers/google-vertex/gemini")],
  ["@opencode/ai/providers/google-vertex/chat", () => import("@opencode/ai/providers/google-vertex/chat")],
  ["@opencode/ai/providers/google-vertex/responses", () => import("@opencode/ai/providers/google-vertex/responses")],
  ["@opencode/ai/providers/google-vertex/messages", () => import("@opencode/ai/providers/google-vertex/messages")],
  ["@opencode/ai/providers/groq", () => import("@opencode/ai/providers/groq")],
  ["@opencode/ai/providers/mistral", () => import("@opencode/ai/providers/mistral")],
  ["@opencode/ai/providers/openai", () => import("@opencode/ai/providers/openai")],
  ["@opencode/ai/providers/openai/chat", () => import("@opencode/ai/providers/openai/chat")],
  ["@opencode/ai/providers/openai/responses", () => import("@opencode/ai/providers/openai/responses")],
  ["@opencode/ai/providers/openai-compatible", () => import("@opencode/ai/providers/openai-compatible")],
  ["@opencode/ai/providers/organization-routes", () => import("@opencode/ai/providers/organization-routes")],
  ["@opencode/ai/providers/openrouter", () => import("@opencode/ai/providers/openrouter")],
  ["@opencode/ai/providers/togetherai", () => import("@opencode/ai/providers/togetherai")],
  ["@opencode/ai/providers/xai", () => import("@opencode/ai/providers/xai")],
])

export const loadPackage = Effect.fn("Provider.loadPackage")(function* (input: string, npm?: Npm.Interface) {
  const specifier = packageName(input)
  const builtin = builtins.get(specifier)
  if (builtin) return yield* importPackage(specifier, specifier, builtin)
  const resolved = yield* Effect.sync(() => {
    if (specifier.startsWith("file://") || specifier.startsWith("@opencode/ai/")) return specifier
    try {
      return import.meta.resolve(specifier)
    } catch {
      return undefined
    }
  })
  if (resolved) return yield* importPackage(specifier, resolved)
  if (!npm) {
    return yield* new LoadError({
      package: specifier,
      cause: new Error(`Provider package ${specifier} is not installed`),
    })
  }
  const parts = specifier.split("/")
  const root = specifier.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? specifier)
  const installed = yield* npm.add(root).pipe(Effect.mapError((cause) => new LoadError({ package: specifier, cause })))
  const entrypoint = yield* Effect.try({
    try: () => resolveModule(specifier, installed.directory),
    catch: (cause) => new LoadError({ package: specifier, cause }),
  })
  return yield* importPackage(specifier, entrypoint)
})

/** opencode transport settings consumed in aisdk.ts; native packages never receive them. */
const TRANSPORT_KEYS = ["chunkTimeout", "fetch", "timeout"] as const

export function nativeSettings(settings: Settings): Settings {
  return Struct.omit(settings, TRANSPORT_KEYS)
}

export function mergeOverlay(
  base: Readonly<Record<string, unknown>> | undefined,
  overlay: Readonly<Record<string, unknown>> | undefined,
): Record<string, Json> | undefined {
  if (base === undefined) return overlay && decodeJsonRecord({ ...overlay })
  if (overlay === undefined) return decodeJsonRecord({ ...base })
  return decodeJsonRecord(
    Object.fromEntries(
      new Set([...Object.keys(base), ...Object.keys(overlay)]).values().map((key): [string, unknown] => {
        const left = base[key]
        const right = overlay[key]
        if (right === undefined) return [key, left]
        if (isRecord(left) && isRecord(right)) return [key, mergeOverlay(left, right) ?? {}]
        return [key, right]
      }),
    ),
  )
}

export function mergeHeaders(
  base: Readonly<Record<string, string>> | undefined,
  overlay: Readonly<Record<string, string>> | undefined,
) {
  if (base === undefined) return overlay && { ...overlay }
  if (overlay === undefined) return { ...base }
  return Object.fromEntries(
    [...Object.entries(base), ...Object.entries(overlay)]
      .reduce((result, entry) => {
        result.set(entry[0].toLowerCase(), entry)
        return result
      }, new Map<string, [string, string]>())
      .values(),
  )
}

export const Request = Provider.Request
export type Request = Provider.Request

export const Settings = Provider.Settings
export type Settings = Provider.Settings

export const Info = Provider.Info
export type Info = Provider.Info

export type MutableInfo = DeepMutable<Info>

const importPackage = Effect.fn("Provider.importPackage")(function* (
  specifier: string,
  entrypoint: string,
  load = () => importModule(entrypoint),
) {
  const module = yield* Effect.tryPromise({
    try: () => {
      const existing = packages.get(entrypoint)
      if (existing) return existing
      const loaded = load()
      packages.set(entrypoint, loaded)
      return loaded
    },
    catch: (cause) => new LoadError({ package: specifier, cause }),
  })
  if (typeof module !== "object" || module === null || typeof (module as { model?: unknown }).model !== "function") {
    return yield* new LoadError({
      package: specifier,
      cause: new Error(`Provider package ${specifier} does not export model(modelID, settings)`),
    })
  }
  return module as ProviderPackageDefinition
})
