import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import path from "path"
import { tool, type ModelMessage } from "ai"
import { Cause, Effect, Exit, Fiber, Layer, Stream } from "effect"
import { InstanceRef } from "../../src/effect/instance-ref"
import { HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import z from "zod"
import { LLM } from "../../src/session/llm"
import { LLMClient, RequestExecutor } from "@opencode-ai/llm/route"
import { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import { ModelsDev } from "@opencode-ai/core/models-dev"

import { testEffect } from "../lib/effect"
import type { Agent } from "../../src/agent/agent"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionID, MessageID } from "../../src/session/schema"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Permission } from "@/permission"
import { LLMAISDK } from "@/session/llm/ai-sdk"
import { Session as SessionNs } from "@/session/session"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { LayerNodePlatform } from "@opencode-ai/core/effect/app-node-platform"
import { ProviderError } from "@/provider/error"

type ConfigModel = NonNullable<NonNullable<ConfigV1.Info["provider"]>[string]["models"]>[string]

const openAIConfig = (model: ModelsDev.Provider["models"][string], baseURL: string): Partial<ConfigV1.Info> => {
  const { experimental: _experimental, ...configModel } = model
  return {
    enabled_providers: ["openai"],
    provider: {
      openai: {
        name: "OpenAI",
        env: ["OPENAI_API_KEY"],
        npm: "@ai-sdk/openai",
        api: "https://api.openai.com/v1",
        models: {
          [model.id]: JSON.parse(JSON.stringify(configModel)) as ConfigModel,
        },
        options: {
          apiKey: "test-openai-key",
          baseURL,
        },
      },
    },
  }
}

const it = testEffect(AppNodeBuilder.build(LayerNode.group([LLM.node, Provider.node])))

// LLM.stream returns a Stream, not an Effect, so we can't use the serviceUse proxy.
const drain = (input: LLM.StreamInput) => LLM.Service.use((svc) => svc.stream(input).pipe(Stream.runDrain))

// drainWith builds an isolated runtime so custom replacements fully own LLM and
// its transitive deps.
const drainWith = (layer: Layer.Layer<LLM.Service>, input: LLM.StreamInput) =>
  Effect.gen(function* () {
    const ctx = yield* InstanceRef
    if (!ctx) return yield* Effect.die("InstanceRef not provided")
    return yield* Effect.promise(() =>
      Effect.runPromise(
        LLM.Service.use((svc) => svc.stream(input).pipe(Stream.runDrain)).pipe(
          Effect.provide(layer),
          Effect.provideService(InstanceRef, ctx),
        ),
      ),
    )
  })

function llmLayerWithExecutor(
  options: {
    executor?: Layer.Layer<RequestExecutor.Service>
    flags?: Partial<RuntimeFlags.Info>
  } = {},
) {
  return AppNodeBuilder.build(LLM.node, [
    [RuntimeFlags.node, RuntimeFlags.layer(options.flags)],
    ...(options.executor ? ([[LayerNodePlatform.requestExecutor, options.executor]] as const) : []),
  ])
}

describe("session.llm.hasToolCalls", () => {
  test("returns false for empty messages array", () => {
    expect(LLM.hasToolCalls([])).toBe(false)
  })

  test("returns false for messages with only text content", () => {
    const messages: ModelMessage[] = [
      {
        role: "user",
        content: [{ type: "text", text: "Hello" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Hi there" }],
      },
    ]
    expect(LLM.hasToolCalls(messages)).toBe(false)
  })

  test("returns true when messages contain tool-call", () => {
    const messages = [
      {
        role: "user",
        content: [{ type: "text", text: "Run a command" }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-123",
            toolName: "bash",
          },
        ],
      },
    ] as ModelMessage[]
    expect(LLM.hasToolCalls(messages)).toBe(true)
  })

  test("returns true when messages contain tool-result", () => {
    const messages = [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-123",
            toolName: "bash",
          },
        ],
      },
    ] as ModelMessage[]
    expect(LLM.hasToolCalls(messages)).toBe(true)
  })

  test("returns false for messages with string content", () => {
    const messages: ModelMessage[] = [
      {
        role: "user",
        content: "Hello world",
      },
      {
        role: "assistant",
        content: "Hi there",
      },
    ]
    expect(LLM.hasToolCalls(messages)).toBe(false)
  })

  test("returns true when tool-call is mixed with text content", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "Let me run that command" },
          {
            type: "tool-call",
            toolCallId: "call-456",
            toolName: "read",
          },
        ],
      },
    ] as ModelMessage[]
    expect(LLM.hasToolCalls(messages)).toBe(true)
  })
})

describe("session.llm.ai-sdk adapter", () => {
  type AISDKAdapterEvent = Parameters<typeof LLMAISDK.toLLMEvents>[1]

  const adapt = (events: ReadonlyArray<AISDKAdapterEvent>) => {
    const state = LLMAISDK.adapterState()
    return Effect.runPromise(
      Effect.forEach(events, (event) => LLMAISDK.toLLMEvents(state, event)).pipe(Effect.map((items) => items.flat())),
    )
  }
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- tests defensive adapter branches outside AI SDK's current typed surface
  const uncheckedAdapterEvent = (input: unknown) => input as AISDKAdapterEvent

  test("maps AI SDK stream chunks without losing session-visible fields", async () => {
    const metadata = { openai: { itemID: "item-1" } }
    const events = await adapt([
      { type: "start" },
      { type: "start-step", request: {}, warnings: [] },
      { type: "text-start", id: "text-1", providerMetadata: metadata },
      { type: "text-delta", id: "text-1", text: "Hel", providerMetadata: { openai: { delta: 1 } } },
      { type: "text-delta", id: "text-1", text: "lo", providerMetadata: { openai: { delta: 2 } } },
      { type: "text-end", id: "text-1", providerMetadata: { openai: { done: true } } },
      { type: "reasoning-start", id: "reasoning-1", providerMetadata: metadata },
      { type: "reasoning-delta", id: "reasoning-1", text: "Think", providerMetadata: { openai: { delta: 3 } } },
      { type: "reasoning-end", id: "reasoning-1", providerMetadata: { openai: { done: true } } },
      { type: "tool-input-start", id: "call-1", toolName: "lookup", providerMetadata: metadata },
      { type: "tool-input-delta", id: "call-1", delta: '{"query":' },
      { type: "tool-input-delta", id: "call-1", delta: '"weather"}' },
      { type: "tool-input-end", id: "call-1", providerMetadata: { openai: { inputDone: true } } },
      {
        type: "tool-call",
        toolCallId: "call-1",
        toolName: "lookup",
        input: { query: "weather" },
        providerExecuted: true,
        providerMetadata: { openai: { called: true } },
      },
      {
        type: "tool-result",
        toolCallId: "call-1",
        toolName: "lookup",
        input: { query: "weather" },
        output: { title: "Lookup", output: "sunny", metadata: { ok: true } },
        providerExecuted: true,
        providerMetadata: { openai: { result: true } },
      },
      {
        type: "finish-step",
        response: { id: "response-1", timestamp: new Date(0), modelId: "gpt-test" },
        finishReason: "other",
        rawFinishReason: "other",
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          totalTokens: 15,
          inputTokenDetails: { noCacheTokens: 5, cacheReadTokens: 3, cacheWriteTokens: 2 },
          outputTokenDetails: { textTokens: 4, reasoningTokens: 1 },
        },
        providerMetadata: { openai: { step: true } },
      },
      {
        type: "finish",
        finishReason: "other",
        rawFinishReason: "other",
        totalUsage: {
          inputTokens: 11,
          outputTokens: 6,
          totalTokens: 17,
          cachedInputTokens: 4,
          reasoningTokens: 2,
          inputTokenDetails: { noCacheTokens: 7, cacheReadTokens: 4, cacheWriteTokens: undefined },
          outputTokenDetails: { textTokens: 4, reasoningTokens: 2 },
        },
      },
    ])

    expect(events).toMatchObject([
      { type: "step-start", index: 0 },
      { type: "text-start", id: "text-1", providerMetadata: metadata },
      { type: "text-delta", id: "text-1", text: "Hel", providerMetadata: { openai: { delta: 1 } } },
      { type: "text-delta", id: "text-1", text: "lo", providerMetadata: { openai: { delta: 2 } } },
      { type: "text-end", id: "text-1", providerMetadata: { openai: { done: true } } },
      { type: "reasoning-start", id: "reasoning-1", providerMetadata: metadata },
      { type: "reasoning-delta", id: "reasoning-1", text: "Think", providerMetadata: { openai: { delta: 3 } } },
      { type: "reasoning-end", id: "reasoning-1", providerMetadata: { openai: { done: true } } },
      { type: "tool-input-start", id: "call-1", name: "lookup", providerMetadata: metadata },
      { type: "tool-input-delta", id: "call-1", name: "lookup", text: '{"query":' },
      { type: "tool-input-delta", id: "call-1", name: "lookup", text: '"weather"}' },
      { type: "tool-input-end", id: "call-1", name: "lookup", providerMetadata: { openai: { inputDone: true } } },
      {
        type: "tool-call",
        id: "call-1",
        name: "lookup",
        input: { query: "weather" },
        providerExecuted: true,
        providerMetadata: { openai: { called: true } },
      },
      {
        type: "tool-result",
        id: "call-1",
        name: "lookup",
        result: { type: "json", value: { title: "Lookup", output: "sunny", metadata: { ok: true } } },
        providerExecuted: true,
        providerMetadata: { openai: { result: true } },
      },
      {
        type: "step-finish",
        index: 0,
        reason: "unknown",
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          totalTokens: 15,
          reasoningTokens: 1,
          cacheReadInputTokens: 3,
          cacheWriteInputTokens: 2,
        },
        providerMetadata: { openai: { step: true } },
      },
      {
        type: "finish",
        reason: "unknown",
        usage: {
          inputTokens: 11,
          outputTokens: 6,
          totalTokens: 17,
          reasoningTokens: 2,
          cacheReadInputTokens: 4,
        },
      },
    ])
  })

  test("creates stable block ids when AI SDK omits them", async () => {
    const events = await adapt([
      uncheckedAdapterEvent({ type: "text-delta", text: "implicit text" }),
      uncheckedAdapterEvent({ type: "text-end" }),
      uncheckedAdapterEvent({ type: "reasoning-delta", text: "implicit reasoning" }),
      uncheckedAdapterEvent({ type: "reasoning-end" }),
    ])

    expect(events).toMatchObject([
      { type: "text-delta", id: "text-0", text: "implicit text" },
      { type: "text-end", id: "text-0" },
      { type: "reasoning-delta", id: "reasoning-0", text: "implicit reasoning" },
      { type: "reasoning-end", id: "reasoning-0" },
    ])
  })

  test("explicitly ignores non-session-visible AI SDK chunks", async () => {
    expect(
      await adapt([
        uncheckedAdapterEvent({ type: "abort" }),
        uncheckedAdapterEvent({ type: "source" }),
        uncheckedAdapterEvent({ type: "file" }),
        uncheckedAdapterEvent({ type: "raw" }),
        uncheckedAdapterEvent({ type: "tool-output-denied" }),
        uncheckedAdapterEvent({ type: "tool-approval-request" }),
      ]),
    ).toEqual([])
  })

  test("preserves tool-error cause", async () => {
    const error = new PermissionV1.RejectedError()
    const events = await Effect.runPromise(
      LLMAISDK.toLLMEvents(LLMAISDK.adapterState(), {
        type: "tool-error",
        toolCallId: "call_123",
        toolName: "bash",
        input: {},
        error,
      }),
    )

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: "tool-error",
      id: "call_123",
      name: "bash",
      message: error.message,
      error,
    })
  })

  test("emits undefined usage when every AI SDK usage field is missing", async () => {
    // If every numeric field is undefined the translator should signal "no usage info"
    // by emitting undefined, not by polluting the event with usage: {}. Downstream cost
    // telemetry distinguishes "missing" from "zero," so emitting an empty object causes
    // false positives ("usage was tracked, just empty") instead of correct nulls.
    const events = await adapt([
      {
        type: "finish-step",
        response: { id: "response-1", timestamp: new Date(0), modelId: "gpt-test" },
        finishReason: "stop",
        rawFinishReason: "stop",
        providerMetadata: undefined,
        usage: {
          inputTokens: undefined,
          outputTokens: undefined,
          totalTokens: undefined,
          reasoningTokens: undefined,
          cachedInputTokens: undefined,
          inputTokenDetails: { noCacheTokens: undefined, cacheReadTokens: undefined, cacheWriteTokens: undefined },
          outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
        },
      },
    ])

    expect(events).toHaveLength(1)
    const stepFinish = events[0]
    if (stepFinish.type !== "step-finish") throw new Error("expected step-finish")
    expect(stepFinish.usage).toBeUndefined()
  })

  test("reuses adapter state cleanly across streams once finish has fired", async () => {
    // adapterState() is meant to be per-stream, but the only thing finish currently clears
    // is toolNames — step, text counters, and the current text/reasoning IDs all leak
    // forward. A caller that reuses a state across two streams sees text-1/reasoning-1/
    // step index 1 on the second stream's first events. The test pins the intended
    // contract: after finish, the same state can be reused and starts fresh.
    const state = LLMAISDK.adapterState()
    const run = (events: ReadonlyArray<AISDKAdapterEvent>) =>
      Effect.runPromise(
        Effect.forEach(events, (event) => LLMAISDK.toLLMEvents(state, event)).pipe(Effect.map((items) => items.flat())),
      )

    await run([
      { type: "start-step", request: {}, warnings: [] },
      uncheckedAdapterEvent({ type: "text-delta", text: "first" }),
      uncheckedAdapterEvent({ type: "text-end" }),
      uncheckedAdapterEvent({ type: "reasoning-delta", text: "first reasoning" }),
      uncheckedAdapterEvent({ type: "reasoning-end" }),
      {
        type: "finish-step",
        response: { id: "r1", timestamp: new Date(0), modelId: "gpt-test" },
        finishReason: "stop",
        rawFinishReason: "stop",
        providerMetadata: undefined,
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          totalTokens: 2,
          inputTokenDetails: { noCacheTokens: undefined, cacheReadTokens: undefined, cacheWriteTokens: undefined },
          outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
        },
      },
      {
        type: "finish",
        finishReason: "stop",
        rawFinishReason: "stop",
        totalUsage: {
          inputTokens: 1,
          outputTokens: 1,
          totalTokens: 2,
          inputTokenDetails: { noCacheTokens: undefined, cacheReadTokens: undefined, cacheWriteTokens: undefined },
          outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
        },
      },
    ])

    const secondStream = await run([
      { type: "start-step", request: {}, warnings: [] },
      uncheckedAdapterEvent({ type: "text-delta", text: "second" }),
      uncheckedAdapterEvent({ type: "text-end" }),
      uncheckedAdapterEvent({ type: "reasoning-delta", text: "second reasoning" }),
      uncheckedAdapterEvent({ type: "reasoning-end" }),
    ])

    expect(secondStream).toMatchObject([
      { type: "step-start", index: 0 },
      { type: "text-delta", id: "text-0", text: "second" },
      { type: "text-end", id: "text-0" },
      { type: "reasoning-delta", id: "reasoning-0", text: "second reasoning" },
      { type: "reasoning-end", id: "reasoning-0" },
    ])
  })

  // Anthropic emits cache write counts in providerMetadata.anthropic.cacheCreationInputTokens
  // rather than usage.inputTokenDetails.cacheWriteTokens. Session.getUsage falls back to the
  // metadata path — but only if the adapter preserves providerMetadata on step-finish.
  test("preserves providerMetadata on step-finish so Anthropic cache writes survive getUsage", async () => {
    const events = await adapt([
      {
        type: "finish-step",
        response: { id: "msg_test", timestamp: new Date(0), modelId: "claude-3-5-sonnet" },
        finishReason: "stop",
        rawFinishReason: "stop",
        // Anthropic's AI SDK shape: cacheWriteTokens is NOT in usage, it arrives via providerMetadata.
        usage: {
          inputTokens: 1000,
          outputTokens: 500,
          totalTokens: 1500,
          inputTokenDetails: { noCacheTokens: 800, cacheReadTokens: 200, cacheWriteTokens: undefined },
          outputTokenDetails: { textTokens: 500, reasoningTokens: undefined },
        },
        providerMetadata: { anthropic: { cacheCreationInputTokens: 300 } },
      },
    ])

    expect(events).toHaveLength(1)
    const stepFinish = events[0]
    if (stepFinish.type !== "step-finish") throw new Error("expected step-finish")
    expect(stepFinish.providerMetadata).toEqual({ anthropic: { cacheCreationInputTokens: 300 } })
    expect(stepFinish.usage?.cacheWriteInputTokens).toBeUndefined()
    expect(stepFinish.usage?.cacheReadInputTokens).toBe(200)

    // End-to-end: with the metadata preserved, getUsage extracts cache.write from the fallback path.
    const result = SessionNs.getUsage({
      model: {
        id: "claude-3-5-sonnet",
        providerID: "anthropic",
        name: "Claude",
        limit: { context: 200_000, output: 8_000 },
        cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
        capabilities: {
          toolcall: true,
          attachment: false,
          reasoning: false,
          temperature: true,
          input: { text: true, image: false, audio: false, video: false },
          output: { text: true, image: false, audio: false, video: false },
        },
        api: { npm: "@ai-sdk/anthropic" },
        options: {},
      } as never,
      usage: stepFinish.usage!,
      metadata: stepFinish.providerMetadata,
    })
    expect(result.tokens.cache.write).toBe(300)
    expect(result.tokens.cache.read).toBe(200)
  })

  test("captures Copilot billed usage from raw Anthropic message deltas per step", async () => {
    const events = await adapt([
      uncheckedAdapterEvent({
        type: "raw",
        rawValue: {
          type: "message_delta",
          copilot_usage: { total_nano_aiu: 4_473_525_000 },
        },
      }),
      {
        type: "finish-step",
        response: { id: "msg_test", timestamp: new Date(0), modelId: "claude-sonnet-4.6" },
        finishReason: "stop",
        rawFinishReason: "end_turn",
        usage: {
          inputTokens: 11_774,
          outputTokens: 39,
          totalTokens: 11_813,
          inputTokenDetails: { noCacheTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 11_771 },
          outputTokenDetails: { textTokens: 39, reasoningTokens: undefined },
        },
        providerMetadata: { anthropic: { cacheCreationInputTokens: 11_771 } },
      },
      {
        type: "finish-step",
        response: { id: "msg_follow_up", timestamp: new Date(0), modelId: "claude-sonnet-4.6" },
        finishReason: "stop",
        rawFinishReason: "end_turn",
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          totalTokens: 2,
          inputTokenDetails: { noCacheTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
          outputTokenDetails: { textTokens: 1, reasoningTokens: undefined },
        },
        providerMetadata: { anthropic: {} },
      },
    ])

    expect(events[0]).toMatchObject({
      type: "step-finish",
      providerMetadata: {
        anthropic: { cacheCreationInputTokens: 11_771 },
        copilot: { totalNanoAiu: 4_473_525_000 },
      },
    })
    expect(events[1]).toMatchObject({ type: "step-finish", providerMetadata: { anthropic: {} } })
    if (events[1].type !== "step-finish") throw new Error("expected step-finish")
    expect(events[1].providerMetadata?.copilot).toBeUndefined()
  })
})

type Capture = {
  url: URL
  headers: Headers
  body: Record<string, unknown>
}

const state = {
  server: null as ReturnType<typeof Bun.serve> | null,
  queue: [] as Array<{
    path: string
    response: Response | ((req: Request, capture: Capture) => Response)
    resolve: (value: Capture) => void
  }>,
}

function deferred<T>() {
  const result = {} as { promise: Promise<T>; resolve: (value: T) => void }
  result.promise = new Promise((resolve) => {
    result.resolve = resolve
  })
  return result
}

function waitRequest(pathname: string, response: Response) {
  const pending = deferred<Capture>()
  state.queue.push({ path: pathname, response, resolve: pending.resolve })
  return pending.promise
}

function timeout(ms: number) {
  return new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms)
  })
}

function waitStreamingRequest(pathname: string) {
  const request = deferred<Capture>()
  const requestAborted = deferred<void>()
  const responseCanceled = deferred<void>()
  const encoder = new TextEncoder()

  state.queue.push({
    path: pathname,
    resolve: request.resolve,
    response(req: Request) {
      req.signal.addEventListener("abort", () => requestAborted.resolve(), { once: true })

      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                [
                  `data: ${JSON.stringify({
                    id: "chatcmpl-abort",
                    object: "chat.completion.chunk",
                    choices: [{ delta: { role: "assistant" } }],
                  })}`,
                ].join("\n\n") + "\n\n",
              ),
            )
          },
          cancel() {
            responseCanceled.resolve()
          },
        }),
        {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        },
      )
    },
  })

  return {
    request: request.promise,
    requestAborted: requestAborted.promise,
    responseCanceled: responseCanceled.promise,
  }
}

beforeAll(() => {
  state.server = Bun.serve({
    port: 0,
    async fetch(req) {
      const next = state.queue.shift()
      if (!next) {
        return new Response("unexpected request", { status: 500 })
      }

      const url = new URL(req.url)
      const body = (await req.json()) as Record<string, unknown>
      next.resolve({ url, headers: req.headers, body })

      if (!url.pathname.endsWith(next.path)) {
        return new Response("not found", { status: 404 })
      }

      return typeof next.response === "function"
        ? next.response(req, { url, headers: req.headers, body })
        : next.response
    },
  })
})

beforeEach(() => {
  state.queue.length = 0
})

afterAll(() => {
  void state.server?.stop()
})

function createChatStream(text: string) {
  const payload =
    [
      `data: ${JSON.stringify({
        id: "chatcmpl-1",
        object: "chat.completion.chunk",
        choices: [{ delta: { role: "assistant" } }],
      })}`,
      `data: ${JSON.stringify({
        id: "chatcmpl-1",
        object: "chat.completion.chunk",
        choices: [{ delta: { content: text } }],
      })}`,
      `data: ${JSON.stringify({
        id: "chatcmpl-1",
        object: "chat.completion.chunk",
        choices: [{ delta: {}, finish_reason: "stop" }],
      })}`,
      "data: [DONE]",
    ].join("\n\n") + "\n\n"

  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(payload))
      controller.close()
    },
  })
}

const MODELS_FIXTURE = JSON.parse(
  await Bun.file(path.join(import.meta.dir, "../tool/fixtures/models-api.json")).text(),
) as Record<string, ModelsDev.Provider>

function loadFixture(providerID: string, modelID: string) {
  const provider = MODELS_FIXTURE[providerID]
  if (!provider) throw new Error(`Missing provider in fixture: ${providerID}`)
  const model = provider.models[modelID]
  if (!model) throw new Error(`Missing model in fixture: ${modelID}`)
  return { provider, model }
}

function configModel(model: ModelsDev.Model) {
  return {
    id: model.id,
    name: model.name,
    family: model.family,
    release_date: model.release_date,
    attachment: model.attachment,
    reasoning: model.reasoning,
    temperature: model.temperature,
    tool_call: model.tool_call,
    interleaved: model.interleaved,
    cost: model.cost ? { ...model.cost, tiers: undefined } : undefined,
    limit: model.limit,
    modalities: model.modalities,
    status: model.status,
    provider: model.provider,
  }
}

function createEventStream(chunks: unknown[], includeDone = false) {
  const lines = chunks.map((chunk) => `data: ${typeof chunk === "string" ? chunk : JSON.stringify(chunk)}`)
  if (includeDone) {
    lines.push("data: [DONE]")
  }
  const payload = lines.join("\n\n") + "\n\n"
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(payload))
      controller.close()
    },
  })
}

function createEventResponse(chunks: unknown[], includeDone = false) {
  return new Response(createEventStream(chunks, includeDone), {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  })
}

describe("session.llm.stream", () => {
  const vivgridFixture = { providerID: "vivgrid", modelID: "gemini-3.1-pro-preview" }
  const opencodeFixture = { providerID: "opencode-test", modelID: vivgridFixture.modelID }

  it.instance(
    "sends the parent session header for opencode providers",
    () =>
      Effect.gen(function* () {
        const fixture = loadFixture(vivgridFixture.providerID, vivgridFixture.modelID)
        const request = waitRequest(
          "/chat/completions",
          new Response(createChatStream("Hello"), {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          }),
        )
        const resolved = yield* Provider.use.getModel(
          ProviderV2.ID.make(opencodeFixture.providerID),
          ModelV2.ID.make(opencodeFixture.modelID),
        )
        const sessionID = SessionID.make("session-child")
        const parentSessionID = SessionID.make("session-parent")
        const agent = {
          name: "test",
          mode: "primary",
          options: {},
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        } satisfies Agent.Info
        const user = {
          id: MessageID.make("msg_user-parent-header"),
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: agent.name,
          model: {
            providerID: ProviderV2.ID.make(opencodeFixture.providerID),
            modelID: resolved.id,
          },
        } satisfies SessionV1.User

        yield* drain({
          user,
          sessionID,
          parentSessionID,
          model: resolved,
          agent,
          system: ["You are a helpful assistant."],
          messages: [{ role: "user", content: "Hello" }],
          tools: {},
        })

        expect((yield* Effect.promise(() => request)).headers.get("x-parent-session-id")).toBe(parentSessionID)
      }),
    {
      config: () => {
        const fixture = loadFixture(vivgridFixture.providerID, vivgridFixture.modelID)
        return {
          enabled_providers: [opencodeFixture.providerID],
          provider: {
            [opencodeFixture.providerID]: {
              name: "OpenCode Test",
              npm: "@ai-sdk/openai-compatible",
              models: { [fixture.model.id]: configModel(fixture.model) as ConfigModel },
              options: { apiKey: "test-key", baseURL: `${state.server!.url.origin}/v1` },
            },
          },
        }
      },
    },
  )

  it.instance(
    "sends temperature, tokens, and reasoning options for openai-compatible models",
    () =>
      Effect.gen(function* () {
        const fixture = loadFixture(vivgridFixture.providerID, vivgridFixture.modelID)
        const request = waitRequest(
          "/chat/completions",
          new Response(createChatStream("Hello"), {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          }),
        )

        const resolved = yield* Provider.use.getModel(
          ProviderV2.ID.make(vivgridFixture.providerID),
          ModelV2.ID.make(fixture.model.id),
        )
        const sessionID = SessionID.make("session-test-1")
        const agent = {
          name: "test",
          mode: "primary",
          options: {},
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
          temperature: 0.4,
          topP: 0.8,
        } satisfies Agent.Info

        const user = {
          id: MessageID.make("msg_user-1"),
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: agent.name,
          model: { providerID: ProviderV2.ID.make(vivgridFixture.providerID), modelID: resolved.id, variant: "high" },
        } satisfies SessionV1.User

        yield* drain({
          user,
          sessionID,
          model: resolved,
          agent,
          system: ["You are a helpful assistant."],
          messages: [{ role: "user", content: "Hello" }],
          tools: {},
        })

        const capture = yield* Effect.promise(() => request)
        const body = capture.body
        const headers = capture.headers
        const url = capture.url

        expect(url.pathname.startsWith("/v1/")).toBe(true)
        expect(url.pathname.endsWith("/chat/completions")).toBe(true)
        expect(headers.get("Authorization")).toBe("Bearer test-key")

        expect(body.model).toBe(resolved.api.id)
        expect(body.temperature).toBe(0.4)
        expect(body.top_p).toBe(0.8)
        expect(body.stream).toBe(true)

        const maxTokens = (body.max_tokens as number | undefined) ?? (body.max_output_tokens as number | undefined)
        const expectedMaxTokens = ProviderTransform.maxOutputTokens(resolved)
        expect(maxTokens).toBe(expectedMaxTokens)

        const reasoning = (body.reasoningEffort as string | undefined) ?? (body.reasoning_effort as string | undefined)
        expect(reasoning).toBe("high")
      }),
    {
      config: () => ({
        enabled_providers: [vivgridFixture.providerID],
        provider: {
          [vivgridFixture.providerID]: {
            options: { apiKey: "test-key", baseURL: `${state.server!.url.origin}/v1` },
          },
        },
      }),
    },
  )

  it.instance(
    "surfaces network_error finish reasons as retryable stream failures",
    () =>
      Effect.gen(function* () {
        const fixture = loadFixture(vivgridFixture.providerID, vivgridFixture.modelID)
        const request = waitRequest(
          "/chat/completions",
          createEventResponse(
            [
              {
                id: "chatcmpl-network-error",
                object: "chat.completion.chunk",
                choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: "network_error" }],
              },
            ],
            true,
          ),
        )
        const resolved = yield* Provider.use.getModel(
          ProviderV2.ID.make(vivgridFixture.providerID),
          ModelV2.ID.make(fixture.model.id),
        )
        const sessionID = SessionID.make("session-test-network-error")
        const agent = {
          name: "test",
          mode: "primary",
          options: {},
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        } satisfies Agent.Info
        const user = {
          id: MessageID.make("msg_user-network-error"),
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: agent.name,
          model: { providerID: ProviderV2.ID.make(vivgridFixture.providerID), modelID: resolved.id },
        } satisfies SessionV1.User

        const error = yield* drain({
          user,
          sessionID,
          model: resolved,
          agent,
          system: ["You are a helpful assistant."],
          messages: [{ role: "user", content: "Hello" }],
          tools: {},
        }).pipe(Effect.flip)
        yield* Effect.promise(() => request)

        if (!(error instanceof ProviderError.ResponseStreamError)) throw error
        expect(error.message).toBe("Provider finish_reason: network_error")
      }),
    {
      config: () => ({
        enabled_providers: [vivgridFixture.providerID],
        provider: {
          [vivgridFixture.providerID]: {
            options: { apiKey: "test-key", baseURL: `${state.server!.url.origin}/v1` },
          },
        },
      }),
    },
  )

  const cerebrasFixture = { providerID: "cerebras", modelID: "gpt-oss-120b" }
  it.instance(
    "omits Cerebras assistant reasoning when the model does not declare interleaved support",
    () =>
      Effect.gen(function* () {
        const fixture = loadFixture(cerebrasFixture.providerID, cerebrasFixture.modelID)
        const request = waitRequest(
          "/chat/completions",
          new Response(createChatStream("Hello"), {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          }),
        )

        const resolved = yield* Provider.use.getModel(
          ProviderV2.ID.make(cerebrasFixture.providerID),
          ModelV2.ID.make(fixture.model.id),
        )
        const sessionID = SessionID.make("session-test-cerebras-reasoning")
        const agent = {
          name: "test",
          mode: "primary",
          options: {},
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        } satisfies Agent.Info

        const user = {
          id: MessageID.make("msg_user-cerebras-reasoning"),
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: agent.name,
          model: { providerID: ProviderV2.ID.make(cerebrasFixture.providerID), modelID: resolved.id },
        } satisfies SessionV1.User

        yield* drain({
          user,
          sessionID,
          model: resolved,
          agent,
          system: ["You are a helpful assistant."],
          messages: [
            { role: "user", content: "Hello" },
            {
              role: "assistant",
              content: [
                { type: "reasoning", text: "thinking" },
                { type: "text", text: "Previous answer" },
              ],
            },
            { role: "user", content: "Continue" },
          ] satisfies ModelMessage[],
          tools: {},
        })

        const capture = yield* Effect.promise(() => request)
        const messages = capture.body.messages as Array<Record<string, unknown>>
        const assistant = messages.find((msg) => msg.role === "assistant")

        // Cerebras rejects replayed reasoning in any plain-text field
        // ("reasoning_content is unsupported"), so non-interleaved models must
        // not echo it at all — only the text reply survives.
        expect(assistant && "reasoning" in assistant).toBe(false)
        expect(assistant && "reasoning_content" in assistant).toBe(false)
        expect(assistant?.content).toBe("Previous answer")
      }),
    {
      config: () => ({
        enabled_providers: [cerebrasFixture.providerID],
        provider: {
          [cerebrasFixture.providerID]: {
            options: { apiKey: "test-key", baseURL: `${state.server!.url.origin}/v1` },
          },
        },
      }),
    },
  )

  const mistralFixture = { providerID: "mistral", modelID: "mistral-small-latest" }
  it.instance(
    "replays native Mistral reasoning from chat history",
    () =>
      Effect.gen(function* () {
        const fixture = loadFixture(mistralFixture.providerID, mistralFixture.modelID)
        const request = waitRequest(
          "/chat/completions",
          createEventResponse(
            [
              {
                id: "chatcmpl-mistral",
                object: "chat.completion.chunk",
                created: 0,
                model: fixture.model.id,
                choices: [{ index: 0, delta: { role: "assistant", content: "Hello" } }],
              },
              {
                id: "chatcmpl-mistral",
                object: "chat.completion.chunk",
                created: 0,
                model: fixture.model.id,
                choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
              },
            ],
            true,
          ),
        )

        const resolved = yield* Provider.use.getModel(
          ProviderV2.ID.make(mistralFixture.providerID),
          ModelV2.ID.make(fixture.model.id),
        )
        const sessionID = SessionID.make("session-test-mistral-reasoning")
        const agent = {
          name: "test",
          mode: "primary",
          options: {},
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        } satisfies Agent.Info

        const user = {
          id: MessageID.make("msg_user-mistral-reasoning"),
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: agent.name,
          model: { providerID: ProviderV2.ID.make(mistralFixture.providerID), modelID: resolved.id },
        } satisfies SessionV1.User

        const thinking = {
          type: "thinking",
          thinking: [
            { type: "text", text: "thinking" },
            {
              type: "tool_reference",
              tool: "web_search",
              title: "Example result",
              url: "https://example.com/tool",
              favicon: "https://example.com/favicon.ico",
              description: "Example description",
            },
            { type: "reference", reference_ids: [1, "source-2"] },
          ],
          closed: true,
          signature: "sig-123",
        }

        yield* drain({
          user,
          sessionID,
          model: resolved,
          agent,
          system: ["You are a helpful assistant."],
          messages: [
            { role: "user", content: "Hello" },
            {
              role: "assistant",
              content: [
                {
                  type: "reasoning",
                  text: "thinking",
                  providerOptions: { mistral: { thinking } },
                },
                { type: "text", text: "Previous answer" },
              ],
            },
            { role: "user", content: "Continue" },
          ] satisfies ModelMessage[],
          tools: {},
        })

        const capture = yield* Effect.promise(() => request)
        const messages = capture.body.messages as Array<Record<string, unknown>>
        expect(messages.find((message) => message.role === "assistant")).toEqual({
          role: "assistant",
          content: [thinking, { type: "text", text: "Previous answer" }],
        })
      }),
    {
      config: () => ({
        enabled_providers: [mistralFixture.providerID],
        provider: {
          [mistralFixture.providerID]: {
            options: { apiKey: "test-key", baseURL: `${state.server!.url.origin}/v1` },
          },
        },
      }),
    },
  )

  const alibabaQwenFixture = { providerID: "alibaba", modelID: "qwen-plus" }
  it.instance(
    "service stream cancellation cancels provider response body promptly",
    () =>
      Effect.gen(function* () {
        const fixture = loadFixture(alibabaQwenFixture.providerID, alibabaQwenFixture.modelID)
        const pending = waitStreamingRequest("/chat/completions")

        const resolved = yield* Provider.use.getModel(
          ProviderV2.ID.make(alibabaQwenFixture.providerID),
          ModelV2.ID.make(fixture.model.id),
        )
        const sessionID = SessionID.make("session-test-service-abort")
        const agent = {
          name: "test",
          mode: "primary",
          options: {},
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        } satisfies Agent.Info
        const user = {
          id: MessageID.make("msg_user-service-abort"),
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: agent.name,
          model: { providerID: ProviderV2.ID.make(alibabaQwenFixture.providerID), modelID: resolved.id },
        } satisfies SessionV1.User

        const fiber = yield* drain({
          user,
          sessionID,
          model: resolved,
          agent,
          system: ["You are a helpful assistant."],
          messages: [{ role: "user", content: "Hello" }],
          tools: {},
        }).pipe(Effect.exit, Effect.forkScoped)

        yield* Effect.promise(() => pending.request)
        yield* Fiber.interrupt(fiber)

        yield* Effect.promise(() => Promise.race([pending.responseCanceled, timeout(500)]))
        const exit = yield* Fiber.await(fiber)
        // Fiber.await returns an Exit<Exit<...>>. Unwrap once.
        const inner = Exit.isSuccess(exit) ? exit.value : exit
        expect(Exit.isFailure(inner)).toBe(true)
        if (Exit.isFailure(inner)) {
          expect(Cause.hasInterrupts(inner.cause)).toBe(true)
        }
        yield* Effect.promise(() => Promise.race([pending.requestAborted, timeout(500)]).catch(() => undefined))
      }),
    {
      config: () => ({
        enabled_providers: [alibabaQwenFixture.providerID],
        provider: {
          [alibabaQwenFixture.providerID]: {
            options: { apiKey: "test-key", baseURL: `${state.server!.url.origin}/v1` },
          },
        },
      }),
    },
  )

  it.instance(
    "keeps tools enabled by prompt permissions",
    () =>
      Effect.gen(function* () {
        const fixture = loadFixture(alibabaQwenFixture.providerID, alibabaQwenFixture.modelID)
        const request = waitRequest(
          "/chat/completions",
          new Response(createChatStream("Hello"), {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          }),
        )

        const resolved = yield* Provider.use.getModel(
          ProviderV2.ID.make(alibabaQwenFixture.providerID),
          ModelV2.ID.make(fixture.model.id),
        )
        const sessionID = SessionID.make("session-test-tools")
        const agent = {
          name: "test",
          mode: "primary",
          options: {},
          permission: [{ permission: "question", pattern: "*", action: "deny" }],
        } satisfies Agent.Info

        const user = {
          id: MessageID.make("msg_user-tools"),
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: agent.name,
          model: { providerID: ProviderV2.ID.make(alibabaQwenFixture.providerID), modelID: resolved.id },
          tools: { question: true },
        } satisfies SessionV1.User

        yield* drain({
          user,
          sessionID,
          model: resolved,
          agent,
          permission: [{ permission: "question", pattern: "*", action: "allow" }],
          system: ["You are a helpful assistant."],
          messages: [{ role: "user", content: "Hello" }],
          tools: {
            question: tool({
              description: "Ask a question",
              inputSchema: z.object({}),
              execute: async () => ({ output: "" }),
            }),
          },
        })

        const capture = yield* Effect.promise(() => request)
        const tools = capture.body.tools as Array<{ function?: { name?: string } }> | undefined
        expect(tools?.some((item) => item.function?.name === "question")).toBe(true)
      }),
    {
      config: () => ({
        enabled_providers: [alibabaQwenFixture.providerID],
        provider: {
          [alibabaQwenFixture.providerID]: {
            options: { apiKey: "test-key", baseURL: `${state.server!.url.origin}/v1` },
          },
        },
      }),
    },
  )

  it.instance(
    "sends responses API payload for OpenAI models",
    () =>
      Effect.gen(function* () {
        const model = loadFixture("openai", "gpt-5.2").model

        const responseChunks = [
          {
            type: "response.created",
            response: {
              id: "resp-1",
              created_at: Math.floor(Date.now() / 1000),
              model: model.id,
              service_tier: null,
            },
          },
          {
            type: "response.output_item.added",
            output_index: 0,
            item: { type: "message", id: "item-1", status: "in_progress", role: "assistant", content: [] },
          },
          {
            type: "response.content_part.added",
            item_id: "item-1",
            output_index: 0,
            content_index: 0,
            part: { type: "output_text", text: "", annotations: [] },
          },
          {
            type: "response.output_text.delta",
            item_id: "item-1",
            delta: "Hello",
            logprobs: null,
          },
          {
            type: "response.completed",
            response: {
              incomplete_details: null,
              usage: {
                input_tokens: 1,
                input_tokens_details: null,
                output_tokens: 1,
                output_tokens_details: null,
              },
              service_tier: null,
            },
          },
        ]
        const request = waitRequest("/responses", createEventResponse(responseChunks, true))

        const resolved = yield* Provider.use.getModel(ProviderV2.ID.openai, ModelV2.ID.make(model.id))
        const sessionID = SessionID.make("session-test-2")
        const agent = {
          name: "test",
          mode: "primary",
          options: { reasoningMode: "pro" },
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
          temperature: 0.2,
        } satisfies Agent.Info

        const user = {
          id: MessageID.make("msg_user-2"),
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: agent.name,
          model: { providerID: ProviderV2.ID.make("openai"), modelID: resolved.id, variant: "high" },
        } satisfies SessionV1.User

        yield* drain({
          user,
          sessionID,
          model: resolved,
          agent,
          system: ["You are a helpful assistant."],
          messages: [{ role: "user", content: "Hello" }],
          tools: {},
        })

        const capture = yield* Effect.promise(() => request)
        const body = capture.body

        expect(capture.url.pathname.endsWith("/responses")).toBe(true)
        expect(body.model).toBe(resolved.api.id)
        expect(body.stream).toBe(true)
        expect((body.reasoning as { effort?: string } | undefined)?.effort).toBe("high")
        expect((body.reasoning as { mode?: string } | undefined)?.mode).toBe("pro")

        const maxTokens = body.max_output_tokens as number | undefined
        expect(maxTokens).toBe(undefined) // match codex cli behavior
      }),
    { config: () => openAIConfig(loadFixture("openai", "gpt-5.2").model, `${state.server!.url.origin}/v1`) },
  )

  it.instance(
    "keeps supported OpenAI models on AI SDK path when native flag is off",
    () =>
      Effect.gen(function* () {
        const model = loadFixture("openai", "gpt-5.2").model
        const request = waitRequest(
          "/responses",
          createEventResponse(
            [
              {
                type: "response.created",
                response: {
                  id: "resp-flag-off",
                  created_at: Math.floor(Date.now() / 1000),
                  model: model.id,
                  service_tier: null,
                },
              },
              {
                type: "response.output_item.added",
                output_index: 0,
                item: { type: "message", id: "item-flag-off", status: "in_progress", role: "assistant", content: [] },
              },
              {
                type: "response.content_part.added",
                item_id: "item-flag-off",
                output_index: 0,
                content_index: 0,
                part: { type: "output_text", text: "", annotations: [] },
              },
              {
                type: "response.output_text.delta",
                item_id: "item-flag-off",
                delta: "Flag off",
                logprobs: null,
              },
              {
                type: "response.completed",
                response: {
                  incomplete_details: null,
                  usage: {
                    input_tokens: 1,
                    input_tokens_details: null,
                    output_tokens: 1,
                    output_tokens_details: null,
                  },
                  service_tier: null,
                },
              },
            ],
            true,
          ),
        )
        const failingNativeClient = Layer.succeed(
          LLMClient.Service,
          LLMClient.Service.of({
            prepare: () => Effect.die(new Error("native LLM client should not be used when the flag is off")),
            stream: () => Stream.die(new Error("native LLM client should not be used when the flag is off")),
            generate: () => Effect.die(new Error("native LLM client should not be used when the flag is off")),
          }),
        )

        const resolved = yield* Provider.use.getModel(ProviderV2.ID.openai, ModelV2.ID.make(model.id))
        const sessionID = SessionID.make("session-test-native-flag-off")
        const agent = {
          name: "test",
          mode: "primary",
          options: {},
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        } satisfies Agent.Info

        yield* drainWith(
          AppNodeBuilder.build(LLM.node, [
            [LayerNodePlatform.llmClient, failingNativeClient],
            [RuntimeFlags.node, RuntimeFlags.layer({ experimentalNativeLlm: false })],
          ]),
          {
            user: {
              id: MessageID.make("msg_user-native-flag-off"),
              sessionID,
              role: "user",
              time: { created: Date.now() },
              agent: agent.name,
              model: { providerID: ProviderV2.ID.make("openai"), modelID: resolved.id, variant: "high" },
            } satisfies SessionV1.User,
            sessionID,
            model: resolved,
            agent,
            system: ["You are a helpful assistant."],
            messages: [{ role: "user", content: "Hello" }],
            tools: {},
          },
        )

        const capture = yield* Effect.promise(() => request)
        expect(capture.url.pathname.endsWith("/responses")).toBe(true)
        expect(capture.body.model).toBe(resolved.api.id)
      }),
    { config: () => openAIConfig(loadFixture("openai", "gpt-5.2").model, `${state.server!.url.origin}/v1`) },
  )

  it.instance(
    "streams OpenAI through native runtime when opted in",
    () =>
      Effect.gen(function* () {
        const model = loadFixture("openai", "gpt-5.2").model
        const chunks = [
          { type: "response.created", response: { id: "resp-native" } },
          {
            type: "response.output_item.added",
            item: { type: "message", id: "item-native", status: "in_progress" },
          },
          { type: "response.output_text.delta", item_id: "item-native", delta: "Hello native" },
          {
            type: "response.completed",
            response: {
              incomplete_details: null,
              usage: {
                input_tokens: 1,
                input_tokens_details: null,
                output_tokens: 1,
                output_tokens_details: null,
              },
            },
          },
        ]
        const request = waitRequest("/responses", createEventResponse(chunks, true))

        const resolved = yield* Provider.use.getModel(ProviderV2.ID.openai, ModelV2.ID.make(model.id))
        const sessionID = SessionID.make("session-test-native")
        const agent = {
          name: "test",
          mode: "primary",
          options: {},
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
          temperature: 0.2,
        } satisfies Agent.Info

        yield* drainWith(llmLayerWithExecutor({ flags: { experimentalNativeLlm: true } }), {
          user: {
            id: MessageID.make("msg_user-native"),
            sessionID,
            role: "user",
            time: { created: Date.now() },
            agent: agent.name,
            model: { providerID: ProviderV2.ID.make("openai"), modelID: resolved.id, variant: "high" },
          } satisfies SessionV1.User,
          sessionID,
          model: resolved,
          agent,
          system: ["You are a helpful assistant."],
          messages: [{ role: "user", content: "Hello" }],
          tools: {},
        })

        const capture = yield* Effect.promise(() => request)
        expect(capture.url.pathname.endsWith("/responses")).toBe(true)
        expect(capture.headers.get("Authorization")).toBe("Bearer test-openai-key")
        expect(capture.body.model).toBe(model.id)
        expect(capture.body.stream).toBe(true)
        expect((capture.body.reasoning as { effort?: string } | undefined)?.effort).toBe("high")
        expect(capture.body.include).toEqual(["reasoning.encrypted_content"])
        expect(JSON.stringify(capture.body.input)).toContain("You are a helpful assistant.")
        expect(capture.body.input).toContainEqual({ role: "user", content: [{ type: "input_text", text: "Hello" }] })
      }),
    { config: () => openAIConfig(loadFixture("openai", "gpt-5.2").model, `${state.server!.url.origin}/v1`) },
  )

  it.instance(
    "uses injected native request executor for tool calls",
    () =>
      Effect.gen(function* () {
        const model = loadFixture("openai", "gpt-5.2").model
        const chunks = [
          {
            type: "response.output_item.added",
            item: { type: "function_call", id: "item-injected-tool", call_id: "call-injected-tool", name: "lookup" },
          },
          {
            type: "response.function_call_arguments.delta",
            item_id: "item-injected-tool",
            delta: '{"query":"weather"}',
          },
          {
            type: "response.output_item.done",
            item: {
              type: "function_call",
              id: "item-injected-tool",
              call_id: "call-injected-tool",
              name: "lookup",
              arguments: '{"query":"weather"}',
            },
          },
          {
            type: "response.completed",
            response: { incomplete_details: null, usage: { input_tokens: 1, output_tokens: 1 } },
          },
        ]
        let captured: Record<string, unknown> | undefined
        let executed: unknown
        const executor = Layer.succeed(
          RequestExecutor.Service,
          RequestExecutor.Service.of({
            execute: (request) =>
              Effect.gen(function* () {
                const web = yield* HttpClientRequest.toWeb(request).pipe(Effect.orDie)
                captured = (yield* Effect.promise(() => web.json())) as Record<string, unknown>
                return HttpClientResponse.fromWeb(request, createEventResponse(chunks, true))
              }),
          }),
        )

        const resolved = yield* Provider.use.getModel(ProviderV2.ID.openai, ModelV2.ID.make(model.id))
        const sessionID = SessionID.make("session-test-native-injected-tool")
        const agent = {
          name: "test",
          mode: "primary",
          options: {},
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        } satisfies Agent.Info

        yield* drainWith(llmLayerWithExecutor({ executor, flags: { experimentalNativeLlm: true } }), {
          user: {
            id: MessageID.make("msg_user-native-injected-tool"),
            sessionID,
            role: "user",
            time: { created: Date.now() },
            agent: agent.name,
            model: { providerID: ProviderV2.ID.make("openai"), modelID: resolved.id },
          } satisfies SessionV1.User,
          sessionID,
          model: resolved,
          agent,
          system: [],
          messages: [{ role: "user", content: "Use lookup" }],
          tools: {
            lookup: tool({
              description: "Lookup data",
              inputSchema: z.object({ query: z.string() }),
              execute: async (args, options) => {
                executed = { args, toolCallId: options.toolCallId }
                return { output: "looked up" }
              },
            }),
          },
        })

        expect(captured?.model).toBe(model.id)
        expect(captured?.tools).toEqual([
          {
            type: "function",
            name: "lookup",
            description: "Lookup data",
            strict: false,
            parameters: {
              type: "object",
              properties: { query: { type: "string" } },
              required: ["query"],
              additionalProperties: false,
              $schema: "http://json-schema.org/draft-07/schema#",
            },
          },
        ])
        expect(executed).toEqual({ args: { query: "weather" }, toolCallId: "call-injected-tool" })
      }),
    { config: () => openAIConfig(loadFixture("openai", "gpt-5.2").model, "https://injected-openai.test/v1") },
  )

  it.instance(
    "executes OpenAI tool calls through native runtime",
    () =>
      Effect.gen(function* () {
        const model = loadFixture("openai", "gpt-5.2").model
        const chunks = [
          {
            type: "response.output_item.added",
            item: { type: "function_call", id: "item-native-tool", call_id: "call-native-tool", name: "lookup" },
          },
          {
            type: "response.function_call_arguments.delta",
            item_id: "item-native-tool",
            delta: '{"query":"weather"}',
          },
          {
            type: "response.output_item.done",
            item: {
              type: "function_call",
              id: "item-native-tool",
              call_id: "call-native-tool",
              name: "lookup",
              arguments: '{"query":"weather"}',
            },
          },
          {
            type: "response.completed",
            response: { incomplete_details: null, usage: { input_tokens: 1, output_tokens: 1 } },
          },
        ]
        const request = waitRequest("/responses", createEventResponse(chunks, true))
        let executed: unknown

        const resolved = yield* Provider.use.getModel(ProviderV2.ID.openai, ModelV2.ID.make(model.id))
        const sessionID = SessionID.make("session-test-native-tool")
        const agent = {
          name: "test",
          mode: "primary",
          options: {},
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        } satisfies Agent.Info

        yield* drainWith(llmLayerWithExecutor({ flags: { experimentalNativeLlm: true } }), {
          user: {
            id: MessageID.make("msg_user-native-tool"),
            sessionID,
            role: "user",
            time: { created: Date.now() },
            agent: agent.name,
            model: { providerID: ProviderV2.ID.make("openai"), modelID: resolved.id },
          } satisfies SessionV1.User,
          sessionID,
          model: resolved,
          agent,
          system: [],
          messages: [{ role: "user", content: "Use lookup" }],
          tools: {
            lookup: tool({
              description: "Lookup data",
              inputSchema: z.object({ query: z.string() }),
              execute: async (args, options) => {
                executed = { args, toolCallId: options.toolCallId }
                return { output: "looked up" }
              },
            }),
          },
        })

        const capture = yield* Effect.promise(() => request)
        expect(capture.body.tools).toEqual([
          {
            type: "function",
            name: "lookup",
            description: "Lookup data",
            strict: false,
            parameters: {
              type: "object",
              properties: { query: { type: "string" } },
              required: ["query"],
              additionalProperties: false,
              $schema: "http://json-schema.org/draft-07/schema#",
            },
          },
        ])
        expect(executed).toEqual({ args: { query: "weather" }, toolCallId: "call-native-tool" })
      }),
    {
      config: () => {
        const model = loadFixture("openai", "gpt-5.2").model
        return {
          enabled_providers: ["openai"],
          provider: {
            openai: {
              name: "OpenAI",
              env: ["OPENAI_API_KEY"],
              npm: "@ai-sdk/openai",
              api: "https://api.openai.com/v1",
              models: { [model.id]: JSON.parse(JSON.stringify(model)) as ConfigModel },
              options: { apiKey: "test-openai-key", baseURL: `${state.server!.url.origin}/v1` },
            },
          },
        }
      },
    },
  )

  it.instance(
    "accepts user image attachments as data URLs for OpenAI models",
    () =>
      Effect.gen(function* () {
        const model = loadFixture("openai", "gpt-5.2").model
        const chunks = [
          {
            type: "response.created",
            response: {
              id: "resp-data-url",
              created_at: Math.floor(Date.now() / 1000),
              model: model.id,
              service_tier: null,
            },
          },
          {
            type: "response.output_item.added",
            output_index: 0,
            item: { type: "message", id: "item-data-url", status: "in_progress", role: "assistant", content: [] },
          },
          {
            type: "response.content_part.added",
            item_id: "item-data-url",
            output_index: 0,
            content_index: 0,
            part: { type: "output_text", text: "", annotations: [] },
          },
          {
            type: "response.output_text.delta",
            item_id: "item-data-url",
            delta: "Looks good",
            logprobs: null,
          },
          {
            type: "response.completed",
            response: {
              incomplete_details: null,
              usage: {
                input_tokens: 1,
                input_tokens_details: null,
                output_tokens: 1,
                output_tokens_details: null,
              },
              service_tier: null,
            },
          },
        ]
        const request = waitRequest("/responses", createEventResponse(chunks, true))
        const image = `data:image/png;base64,${Buffer.from(
          yield* Effect.promise(() =>
            Bun.file(path.join(import.meta.dir, "../tool/fixtures/large-image.png")).arrayBuffer(),
          ),
        ).toString("base64")}`

        const resolved = yield* Provider.use.getModel(ProviderV2.ID.openai, ModelV2.ID.make(model.id))
        const sessionID = SessionID.make("session-test-data-url")
        const agent = {
          name: "test",
          mode: "primary",
          options: {},
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        } satisfies Agent.Info

        const user = {
          id: MessageID.make("msg_user-data-url"),
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: agent.name,
          model: { providerID: ProviderV2.ID.make("openai"), modelID: resolved.id },
        } satisfies SessionV1.User

        yield* drain({
          user,
          sessionID,
          model: resolved,
          agent,
          system: ["You are a helpful assistant."],
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "Describe this image" },
                { type: "file", mediaType: "image/png", filename: "large-image.png", data: image },
              ],
            },
          ] as ModelMessage[],
          tools: {},
        })

        const capture = yield* Effect.promise(() => request)
        expect(capture.url.pathname.endsWith("/responses")).toBe(true)
      }),
    { config: () => openAIConfig(loadFixture("openai", "gpt-5.2").model, `${state.server!.url.origin}/v1`) },
  )

  const minimaxFixture = { providerID: "minimax", modelID: "MiniMax-M2.5" }
  it.instance(
    "sends messages API payload for Anthropic Compatible models",
    () =>
      Effect.gen(function* () {
        const model = loadFixture(minimaxFixture.providerID, minimaxFixture.modelID).model

        const chunks = [
          {
            type: "message_start",
            message: {
              id: "msg-1",
              model: model.id,
              usage: {
                input_tokens: 3,
                cache_creation_input_tokens: null,
                cache_read_input_tokens: null,
              },
            },
          },
          {
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "Hello" },
          },
          { type: "content_block_stop", index: 0 },
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn", stop_sequence: null, container: null },
            usage: {
              input_tokens: 3,
              output_tokens: 2,
              cache_creation_input_tokens: null,
              cache_read_input_tokens: null,
            },
          },
          { type: "message_stop" },
        ]
        const request = waitRequest("/messages", createEventResponse(chunks))

        const resolved = yield* Provider.use.getModel(
          ProviderV2.ID.make(minimaxFixture.providerID),
          ModelV2.ID.make(model.id),
        )
        const sessionID = SessionID.make("session-test-3")
        const agent = {
          name: "test",
          mode: "primary",
          options: {},
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
          temperature: 0.4,
          topP: 0.9,
        } satisfies Agent.Info

        const user = {
          id: MessageID.make("msg_user-3"),
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: agent.name,
          model: { providerID: ProviderV2.ID.make("minimax"), modelID: ModelV2.ID.make("MiniMax-M2.5") },
        } satisfies SessionV1.User

        yield* drain({
          user,
          sessionID,
          model: resolved,
          agent,
          system: ["You are a helpful assistant."],
          messages: [{ role: "user", content: "Hello" }],
          tools: {},
        })

        const capture = yield* Effect.promise(() => request)
        const body = capture.body

        expect(capture.url.pathname.endsWith("/messages")).toBe(true)
        expect(body.model).toBe(resolved.api.id)
        expect(body.max_tokens).toBe(ProviderTransform.maxOutputTokens(resolved))
        expect(body.temperature).toBe(0.4)
        expect(body.top_p).toBe(0.9)
      }),
    {
      config: () => ({
        enabled_providers: [minimaxFixture.providerID],
        provider: {
          [minimaxFixture.providerID]: {
            options: { apiKey: "test-anthropic-key", baseURL: `${state.server!.url.origin}/v1` },
          },
        },
      }),
    },
  )

  it.instance(
    "sends anthropic tool_use blocks with tool_result immediately after them",
    () =>
      Effect.gen(function* () {
        const model = loadFixture("anthropic", "claude-opus-4-6").model
        const chunks = [
          {
            type: "message_start",
            message: {
              id: "msg-tool-order",
              model: model.id,
              usage: {
                input_tokens: 3,
                cache_creation_input_tokens: null,
                cache_read_input_tokens: null,
              },
            },
          },
          {
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "ok" },
          },
          { type: "content_block_stop", index: 0 },
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn", stop_sequence: null, container: null },
            usage: {
              input_tokens: 3,
              output_tokens: 2,
              cache_creation_input_tokens: null,
              cache_read_input_tokens: null,
            },
          },
          { type: "message_stop" },
        ]
        const request = waitRequest("/messages", createEventResponse(chunks))

        const resolved = yield* Provider.use.getModel(ProviderV2.ID.make("anthropic"), ModelV2.ID.make(model.id))
        const sessionID = SessionID.make("session-test-anthropic-tools")
        const agent = {
          name: "test",
          mode: "primary",
          options: {},
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        } satisfies Agent.Info
        const user = {
          id: MessageID.make("msg_user-anthropic-tools"),
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: agent.name,
          model: { providerID: ProviderV2.ID.make("anthropic"), modelID: resolved.id, variant: "max" },
        } satisfies SessionV1.User

        const input = [
          {
            info: {
              id: "msg_user",
              sessionID,
              role: "user",
              time: { created: 1 },
              agent: "gentleman",
              model: { providerID: "anthropic", modelID: "claude-opus-4-6", variant: "max" },
            },
            parts: [
              {
                id: "p_user",
                sessionID,
                messageID: "msg_user",
                type: "text",
                text: "Can you check whether there are any PDF files in my home directory?",
              },
            ],
          },
          {
            info: {
              id: "msg_call",
              sessionID,
              parentID: "msg_user",
              role: "assistant",
              mode: "gentleman",
              agent: "gentleman",
              variant: "max",
              path: { cwd: "/root", root: "/" },
              cost: 0,
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              modelID: "claude-opus-4-6",
              providerID: "anthropic",
              time: { created: 2, completed: 3 },
              finish: "tool-calls",
            },
            parts: [
              {
                id: "p_step",
                sessionID,
                messageID: "msg_call",
                type: "step-start",
              },
              {
                id: "p_read",
                sessionID,
                messageID: "msg_call",
                type: "tool",
                tool: "read",
                callID: "toolu_01N8mDEzG8DSTs7UPHFtmgCT",
                state: {
                  status: "completed",
                  input: { filePath: "/root" },
                  output: "<path>/root</path>",
                  metadata: {},
                  title: "root",
                  time: { start: 10, end: 11 },
                },
              },
              {
                id: "p_glob",
                sessionID,
                messageID: "msg_call",
                type: "tool",
                tool: "glob",
                callID: "toolu_01APxrADs7VozN8uWzw9WwHr",
                state: {
                  status: "completed",
                  input: { pattern: "**/*.pdf", path: "/root" },
                  output: "No files found",
                  metadata: {},
                  title: "root",
                  time: { start: 12, end: 13 },
                },
              },
              {
                id: "p_text",
                sessionID,
                messageID: "msg_call",
                type: "text",
                text: "I checked your home directory and looked for PDF files.",
                time: { start: 14, end: 15 },
              },
            ],
          },
        ] as any[]

        const modelMessages = yield* Effect.promise(() => MessageV2.toModelMessages(input as any, resolved))
        yield* drain({
          user,
          sessionID,
          model: resolved,
          agent,
          system: [],
          messages: modelMessages,
          tools: {
            read: tool({
              description: "Stub read tool",
              inputSchema: z.object({ filePath: z.string() }),
              execute: async () => ({ output: "stub" }),
            }),
            glob: tool({
              description: "Stub glob tool",
              inputSchema: z.object({ pattern: z.string(), path: z.string().optional() }),
              execute: async () => ({ output: "stub" }),
            }),
          },
        })

        const capture = yield* Effect.promise(() => request)
        const body = capture.body

        expect(capture.url.pathname.endsWith("/messages")).toBe(true)
        const messages = body.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>
        expect(messages[0]?.role).toBe("user")
        expect(messages[0]?.content[0]).toMatchObject({
          type: "text",
          text: "Can you check whether there are any PDF files in my home directory?",
        })
        expect(messages.some((message) => message.content.some((part) => "cache_control" in part))).toBe(true)
        const toolUseIndex = messages.findIndex((message) => message.content.some((part) => part.type === "tool_use"))
        expect(toolUseIndex).toBeGreaterThan(0)
        expect(messages[toolUseIndex].role).toBe("assistant")
        expect(messages[toolUseIndex].content.filter((part) => part.type === "tool_use")).toMatchObject([
          {
            type: "tool_use",
            id: "toolu_01N8mDEzG8DSTs7UPHFtmgCT",
            name: "read",
            input: { filePath: "/root" },
          },
          {
            type: "tool_use",
            id: "toolu_01APxrADs7VozN8uWzw9WwHr",
            name: "glob",
            input: { pattern: "**/*.pdf", path: "/root" },
          },
        ])
        expect(messages[toolUseIndex + 1]).toMatchObject({
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_01N8mDEzG8DSTs7UPHFtmgCT", content: "<path>/root</path>" },
            { type: "tool_result", tool_use_id: "toolu_01APxrADs7VozN8uWzw9WwHr", content: "No files found" },
          ],
        })
      }),
    {
      config: () => {
        const model = loadFixture("anthropic", "claude-opus-4-6").model
        return {
          enabled_providers: ["anthropic"],
          provider: {
            anthropic: {
              name: "Anthropic",
              env: ["ANTHROPIC_API_KEY"],
              npm: "@ai-sdk/anthropic",
              api: "https://api.anthropic.com/v1",
              models: { [model.id]: configModel(model) as ConfigModel },
              options: { apiKey: "test-anthropic-key", baseURL: `${state.server!.url.origin}/v1` },
            },
          },
        }
      },
    },
  )

  const geminiFixture = { providerID: "google", modelID: "gemini-2.5-flash" }
  it.instance(
    "sends Google API payload for Gemini models",
    () =>
      Effect.gen(function* () {
        const model = loadFixture(geminiFixture.providerID, geminiFixture.modelID).model
        const pathSuffix = `/v1beta/models/${model.id}:streamGenerateContent`

        const chunks = [
          {
            candidates: [{ content: { parts: [{ text: "Hello" }] }, finishReason: "STOP" }],
            usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
          },
        ]
        const request = waitRequest(pathSuffix, createEventResponse(chunks))

        const resolved = yield* Provider.use.getModel(
          ProviderV2.ID.make(geminiFixture.providerID),
          ModelV2.ID.make(model.id),
        )
        const sessionID = SessionID.make("session-test-4")
        const agent = {
          name: "test",
          mode: "primary",
          options: {},
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
          temperature: 0.3,
          topP: 0.8,
        } satisfies Agent.Info

        const user = {
          id: MessageID.make("msg_user-4"),
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: agent.name,
          model: { providerID: ProviderV2.ID.make(geminiFixture.providerID), modelID: resolved.id },
        } satisfies SessionV1.User

        yield* drain({
          user,
          sessionID,
          model: resolved,
          agent,
          system: ["You are a helpful assistant."],
          messages: [
            { role: "user", content: "Hello" },
            { role: "assistant", content: [{ type: "reasoning", text: "" }] },
          ],
          tools: {},
        })

        const capture = yield* Effect.promise(() => request)
        const body = capture.body
        const config = body.generationConfig as
          | { temperature?: number; topP?: number; maxOutputTokens?: number }
          | undefined

        expect(capture.url.pathname).toBe(pathSuffix)
        expect(body.contents).toEqual([{ role: "user", parts: [{ text: "Hello" }] }])
        expect(config?.temperature).toBe(0.3)
        expect(config?.topP).toBe(0.8)
        expect(config?.maxOutputTokens).toBe(ProviderTransform.maxOutputTokens(resolved))
      }),
    {
      config: () => ({
        enabled_providers: [geminiFixture.providerID],
        provider: {
          [geminiFixture.providerID]: {
            options: { apiKey: "test-google-key", baseURL: `${state.server!.url.origin}/v1beta` },
          },
        },
      }),
    },
  )
})
