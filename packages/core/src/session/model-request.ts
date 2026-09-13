export * as SessionModelRequest from "./model-request.js"

import {
  GenerationOptions,
  type GenerationOptionsFields,
  HttpOptions,
  LanguageModel,
  LLM,
  LLMRequest,
  Message,
  SystemPart,
} from "@opencode/ai"
import type { StreamOptions } from "@opencode/ai/route"
import type {
  SessionCompaction,
  SessionContext,
  SessionGenerate,
  SessionRequest,
  SessionRequestKind,
  SessionTitle,
} from "@opencode/plugin/effect/session"
import type { Agent } from "@opencode/schema/agent"
import type { Model } from "@opencode/schema/model"
import type { Content } from "@opencode/schema/tool"
import { Cause, Context, Effect, Layer, Result, Stream } from "effect"
import { HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { App } from "../app.js"
import { Permission } from "../permission.js"
import { PluginHooks } from "../plugin/hooks.js"
import { QuestionTool } from "../tool/plugin/question.js"
import { Tool } from "../tool.js"
import { SessionModelTransport } from "./model-transport.js"
import { SessionProviderContext } from "./provider-context.js"
import { SessionRunnerModel } from "./runner/model.js"
import { SessionSchema } from "./schema.js"
import { SessionSystemPrompt } from "./system-prompt.js"
import { toLLMMessages } from "./runner/to-llm-message.js"
import type { SessionMessage } from "./message.js"

const IMAGE_BYTES_TRIGGER = 25 * 1024 * 1024 // 25 MiB
const IMAGE_BYTES_TARGET = 15 * 1024 * 1024 // 15 MiB
const IMAGE_REMOVED =
  "[This image was removed to reduce the request size and is no longer visible. Do not make claims about its contents from memory. If needed, retrieve it again with an available tool or ask the user to attach it again.]"
const GENERATION_KEYS = new Set(Object.keys(GenerationOptions.fields))

/** Tool errors, plus the user declining a permission or dismissing a question. */
export type ExecuteError = Tool.Error | Permission.DeclinedError | QuestionTool.CancelledError

export interface Prepared<Event = SessionRequest> {
  readonly event: Event
  readonly request: LLMRequest
  readonly options: StreamOptions
  readonly retry: (event: PluginHooks.Domains["session"]["retry"]) => Effect.Effect<void>
  /** Runs a tool call against the tools this request advertised. */
  readonly executeTool: (
    input: Parameters<Tool.Snapshot["execute"]>[0],
  ) => Effect.Effect<Tool.NormalizedResult, ExecuteError>
}

export interface Input {
  readonly session: SessionSchema.Info
  readonly agent: Agent.ID
  readonly model: SessionRunnerModel.Resolved
  readonly tools?: Tool.Snapshot
  readonly system: Array<SystemPart>
  readonly messages: Array<Message>
  readonly toolChoice?: LLM.RequestInput["toolChoice"]
  /** Only the durable runner may use a stateful WebSocket. */
  readonly webSocket?: "session"
}

export const baseTranscript = (input: {
  readonly agent: Agent.Info
  readonly model: SessionRunnerModel.Resolved
  readonly tools: Tool.Snapshot
  readonly initial: string
  readonly messages: ReadonlyArray<SessionMessage.Info>
}) => {
  const providerMetadataKey = input.model.model.route.providerMetadataKey ?? input.model.model.provider
  return {
    providerMetadataKey,
    system: [
      input.agent.system
        ? input.agent.system
        : SessionSystemPrompt.make(input.tools.definitions.map((tool) => tool.name)),
      input.initial,
    ]
      .filter((part) => part.length > 0)
      .map(SystemPart.make),
    messages: toLLMMessages(input.messages, input.model.ref, providerMetadataKey),
  }
}

const mimeToModality = (mime: string) => {
  if (mime.startsWith("image/")) return "image"
  if (mime.startsWith("audio/")) return "audio"
  if (mime.startsWith("video/")) return "video"
  if (mime === "application/pdf") return "pdf"
}

const unsupportedMedia = (mime: string, name: string | undefined, capabilities: Model.Capabilities) => {
  const modality = mimeToModality(mime)
  if (!modality || capabilities.input.some((item) => item.startsWith(modality))) return
  return {
    type: "text" as const,
    text: `ERROR: Cannot read ${name ? `"${name}"` : modality} (this model does not support ${modality} input). Inform the user.`,
  }
}

export const unsupportedParts = (messages: LLMRequest["messages"], capabilities: Model.Capabilities) =>
  messages.map((message) =>
    Message.make({
      ...message,
      content: message.content.map((part) => {
        if (part.type === "media") {
          return unsupportedMedia(part.mediaType, part.filename, capabilities) ?? part
        }
        if (part.type !== "tool-result" || part.result.type !== "content") return part
        return {
          ...part,
          result: {
            ...part.result,
            value: part.result.value.map((item: Content) => {
              if (item.type !== "file") return item
              return unsupportedMedia(item.mime, item.name, capabilities) ?? item
            }),
          },
        }
      }),
    }),
  )

export const boundImages = (messages: LLMRequest["messages"]) => {
  const isImage = (mime: string) => mime.toLowerCase().startsWith("image/")
  const size = (data: string | Uint8Array) =>
    typeof data === "string" ? Buffer.byteLength(data) : Math.ceil(data.byteLength / 3) * 4
  const imageBytes = messages.reduce(
    (total, message) =>
      total +
      message.content.reduce((sum, part) => {
        if (part.type === "media" && isImage(part.mediaType)) return sum + size(part.data)
        if (part.type !== "tool-result" || part.result.type !== "content") return sum
        return (
          sum +
          part.result.value.reduce(
            (bytes: number, item: Content) =>
              bytes + (item.type === "file" && isImage(item.mime) ? Buffer.byteLength(item.uri) : 0),
            0,
          )
        )
      }, 0),
    0,
  )
  if (imageBytes <= IMAGE_BYTES_TRIGGER) return messages

  let removed = 0
  return messages.map((message) =>
    Message.make({
      ...message,
      content: message.content.map((part) => {
        if (part.type === "media" && isImage(part.mediaType) && imageBytes - removed > IMAGE_BYTES_TARGET) {
          removed += size(part.data)
          return Message.text(IMAGE_REMOVED)
        }
        if (part.type !== "tool-result" || part.result.type !== "content") return part
        return {
          ...part,
          result: {
            ...part.result,
            value: part.result.value.map((item: Content) => {
              if (item.type !== "file" || !isImage(item.mime) || imageBytes - removed <= IMAGE_BYTES_TARGET) return item
              removed += Buffer.byteLength(item.uri)
              return { type: "text" as const, text: IMAGE_REMOVED }
            }),
          },
        }
      }),
    }),
  )
}

type Definitions = PluginHooks.Domains["session"]["context"]["tools"]

/** Builds the model request for each session flow. Each entry runs its own plugin hook. */
export interface Interface {
  readonly primary: (input: Input) => Effect.Effect<Prepared<SessionContext>>
  readonly compaction: (input: Input) => Effect.Effect<Prepared<SessionCompaction>>
  readonly generate: (input: Input) => Effect.Effect<Prepared<SessionGenerate>>
  readonly title: (input: Input) => Effect.Effect<Prepared<SessionTitle>>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionModelRequest") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const hooks = yield* PluginHooks.Service
    const transport = yield* SessionModelTransport.Service
    const app = yield* App.Metadata
    const prepare = Effect.fn("SessionModelRequest.prepare")(function* <
      S extends SessionRequest & { tools?: Definitions },
    >(kind: SessionRequestKind, input: Input, shape: (draft: SessionRequest, tools: Definitions) => Effect.Effect<S>) {
      const session = input.session
      const model = input.model
      const scope = { sessionID: session.id, agent: input.agent, model: model.ref, kind }
      const tools = input.tools ?? {
        definitions: [],
        execute: () => new Tool.Error({ message: "Tools are not available for this request" }),
      }
      // Remember which tool each definition object came from. Hooks rename a tool by moving
      // its definition to a new key, so after the hook we find the tool by object identity.
      const given = new Map(
        tools.definitions.map((t) => [{ description: t.description, input: { ...t.inputSchema } }, t] as const),
      )
      const shaped = yield* shape(
        { sessionID: session.id, model: model.ref, system: input.system, messages: input.messages, options: {} },
        Object.fromEntries(Array.from(given, ([d, t]) => [t.name, d])),
      )
      // Match by identity first, then by key. Entries matching neither were invented by a
      // hook and are dropped. `t.name` stays the real name so execution can map renames back.
      const byName = new Map(tools.definitions.map((t) => [t.name, t]))
      const hooked = new Map(
        Object.entries(shaped.tools ?? {}).flatMap(([name, d]) => {
          const t = given.get(d) ?? byName.get(name)
          return t ? [[name, { ...t, description: d.description, inputSchema: d.input }] as const] : []
        }),
      )
      const entries = Object.entries(shaped.options)
      const generation = Object.fromEntries(entries.filter(([k]) => GENERATION_KEYS.has(k))) as GenerationOptionsFields
      const providerOptions = Object.fromEntries(entries.filter(([k]) => !GENERATION_KEYS.has(k)))
      const root = session.fork?.sessionID ?? session.id
      const base = LLM.request({
        model: model.model,
        http: {
          headers: {
            "x-session-affinity": session.id,
            "X-Session-Id": session.id,
            ...(session.parentID ? { "x-parent-session-id": session.parentID } : {}),
            "User-Agent": App.useragent(app),
            "x-opencode-project": session.projectID,
            "x-opencode-session": session.id,
            "x-opencode-client": app.name,
          },
        },
        // TODO: Persist cache lineage so nested forks reuse the root session's cache key.
        promptCacheKey: /^ses_[0-9a-f]{64}$/.test(root) ? root.slice(4) : root,
        system: shaped.system,
        messages: boundImages(unsupportedParts(shaped.messages, model.capabilities)),
        tools: Array.from(hooked, ([name, t]) => ({ ...t, name })),
        toolChoice: input.toolChoice,
        generation: Object.keys(generation).length === 0 ? undefined : generation,
        providerOptions: Object.keys(providerOptions).length === 0 ? undefined : providerOptions,
      })

      const baseURL = base.model.route.endpoint.baseURL
      const modelHook = yield* hooks.trigger("session", "model.request", {
        ...scope,
        baseURL: typeof baseURL === "string" ? baseURL : undefined,
        headers: { ...base.http?.headers },
      })
      const route =
        modelHook.baseURL !== undefined && modelHook.baseURL !== baseURL
          ? base.model.route.with({ endpoint: { baseURL: modelHook.baseURL } })
          : base.model.route
      const request = LLMRequest.update(base, {
        model: route === base.model.route ? base.model : LanguageModel.update(base.model, { route }),
        http: new HttpOptions({
          body: base.http?.body,
          headers: Object.keys(modelHook.headers).length === 0 ? undefined : modelHook.headers,
          query: base.http?.query,
        }),
      })
      // History selects native windows against the catalog route before hooks run. A newly installed
      // routing hook must not send an existing opaque window to another deployment; `prepare` has no
      // error channel, so like hook failures this surfaces as a defect.
      const selected = SessionProviderContext.provenance(model)
      if (
        selected &&
        !SessionProviderContext.compatible(
          selected,
          SessionProviderContext.provenance({ model: request.model, ref: model.ref }),
        ) &&
        request.messages.some((message) => message.content.some((part) => part.type === "compaction"))
      )
        return yield* Effect.die(
          new Error("Provider context is incompatible with the route selected by model request hooks"),
        )

      const hasHttpHooks =
        (yield* hooks.has("session", "http.request", model.ref.providerID)) ||
        (yield* hooks.has("session", "http.response", model.ref.providerID))
      const http: StreamOptions["http"] = hasHttpHooks
        ? (req, handler) =>
            Effect.gen(function* () {
              const before = yield* hooks.trigger("session", "http.request", {
                ...scope,
                request: yield* HttpClientRequest.toWeb(req),
              })
              let sent = HttpClientRequest.fromWeb(before.request)
              if (before.request.body)
                sent = HttpClientRequest.bodyUint8Array(
                  sent,
                  new Uint8Array(yield* Effect.promise(() => before.request.clone().arrayBuffer())),
                  before.request.headers.get("content-type") ?? undefined,
                )
              const res = yield* handler(sent)
              const after = yield* hooks.trigger("session", "http.response", {
                ...scope,
                request: before.request,
                response: new Response(
                  [204, 205, 304].includes(res.status) ? null : yield* Stream.toReadableStreamEffect(res.stream),
                  { status: res.status, headers: res.headers },
                ),
              })
              return HttpClientResponse.fromWeb(sent, after.response)
            }).pipe(Effect.mapError((cause) => (cause instanceof Error ? cause : new Error(String(cause)))))
        : undefined
      // HTTP hooks must observe every request, so they keep the provider on HTTP.
      const webSocket =
        input.webSocket === "session" &&
        !hasHttpHooks &&
        model.capabilities.responsesWebsockets === true &&
        model.websocket

      return {
        event: shaped,
        request,
        options: { ...(http ? { http } : {}), ...(webSocket ? { webSocket: transport.bind(session.id) } : {}) },
        retry: (event: Parameters<Prepared["retry"]>[0]) =>
          hooks.trigger("session", "retry", event).pipe(Effect.asVoid),
        // Permission.assert and the question tool throw declines as defects so tools cannot
        // catch them and turn a "no" into model-visible output. Recover them here as failures.
        executeTool: (call: Parameters<Prepared["executeTool"]>[0]) =>
          tools.execute({ ...call, definitions: hooked }).pipe(
            Effect.catchCauseFilter(
              (cause) => {
                const decline = cause.reasons.flatMap((r) =>
                  Cause.isDieReason(r) &&
                  (r.defect instanceof Permission.DeclinedError || r.defect instanceof QuestionTool.CancelledError)
                    ? [r.defect]
                    : [],
                )[0]
                return decline ? Result.succeed(decline) : Result.fail(cause)
              },
              (decline) => Effect.fail(decline),
            ),
          ),
      }
    })

    const agentHook =
      (name: "context" | "compaction" | "generate", agent: Agent.ID) => (draft: SessionRequest, tools: Definitions) =>
        hooks.trigger("session", name, { ...draft, agent, tools })

    return Service.of({
      primary: (input) => prepare("primary", input, agentHook("context", input.agent)),
      compaction: (input) => prepare("compaction", input, agentHook("compaction", input.agent)),
      generate: (input) => prepare("generate", input, agentHook("generate", input.agent)),
      title: (input) => prepare("title", input, (draft) => hooks.trigger("session", "title", draft)),
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [PluginHooks.node, SessionModelTransport.node, App.node],
})
