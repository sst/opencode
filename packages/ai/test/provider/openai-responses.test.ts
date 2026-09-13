import { describe, expect } from "bun:test"
import { ConfigProvider, Effect, Layer, Ref, Schema, Stream } from "effect"
import { Headers, HttpClientRequest } from "effect/unstable/http"
import {
  LLM,
  AIError,
  HttpContext,
  HttpOptions,
  LLMEvent,
  LLMRequest,
  Message,
  LanguageModel,
  ToolCallPart,
  ToolDefinition,
  ToolNamespace,
  ToolResultPart,
  TransportError,
  Usage,
} from "../../src/index.js"
import {
  Auth,
  LLMClient,
  RequestExecutor,
  WebSocketTransport,
  type ChannelObservation,
  type WebSocketChannelDriver,
} from "../../src/route.js"
import { compileRequest } from "../../src/route/client.js"
import * as Azure from "../../src/providers/azure.js"
import * as OpenAI from "../../src/providers/openai.js"
import * as XAI from "../../src/providers/xai.js"
import * as OpenAIResponses from "../../src/protocols/openai-responses.js"
import { OpenResponses } from "../../src/protocols/open-responses.js"
import { OpenResponsesContinuation } from "../../src/protocols/open-responses-continuation.js"
import * as ProviderShared from "../../src/protocols/shared.js"
import { continuationRequest, nativeOpenAIResponsesContinuation } from "../continuation-scenarios.js"
import { it } from "../lib/effect.js"
import { dynamicResponse, fixedResponse } from "../lib/http.js"
import { sseEvents } from "../lib/sse.js"

const model = OpenAIResponses.route
  .with({ endpoint: { baseURL: "https://api.openai.test/v1/" }, auth: Auth.bearer("test") })
  .model({ id: "gpt-4.1-mini" })

const xaiModel = XAI.configure({ apiKey: "test", baseURL: "https://api.x.ai/v1" }).responses("grok-4.5")

const baseChannelDriver = (message: string): WebSocketChannelDriver => ({
  create: () => Effect.succeed({ message, mode: "full" }),
  observe: (_create, frame): Effect.Effect<ChannelObservation, AIError> => {
    const event = ProviderShared.decodeJson(frame)
    if (!ProviderShared.isRecord(event)) return Effect.die("Expected event")
    if (event.type === "response.completed") return Effect.succeed({ type: "completed", frame })
    if (event.type === "response.incomplete") return Effect.succeed({ type: "incomplete", frame })
    if (event.type === "error" || event.type === "response.failed")
      return Effect.succeed({
        type: "provider-failure",
        error: new AIError({
          reason: new TransportError({
            message: "provider rejected request",
            body: frame,
            cause: new Error("provider cause"),
            http: new HttpContext({ url: "https://provider.test", status: 200, headers: { "x-trace": "trace-1" } }),
            transport: "websocket",
            operation: "read",
            phase: "receive",
          }),
        }),
      })
    return Effect.succeed({ type: "frame", frame })
  },
})

/** Classifies error frames the way the production channel does, so recovery can read the canonical reason. */
const classifyingChannelDriver = (message: string): WebSocketChannelDriver => {
  const base = baseChannelDriver(message)
  const decodeEvent = Schema.decodeUnknownSync(OpenResponses.protocol.stream.event)
  return {
    ...base,
    observe: (create, frame) =>
      base.observe(create, frame).pipe(
        Effect.map((observation) =>
          observation.type === "provider-failure"
            ? {
                ...observation,
                error: OpenResponses.providerFailure(decodeEvent(frame), "stream error", frame),
              }
            : observation,
        ),
      ),
  }
}

const continuationDriver = (
  request: Readonly<Record<string, unknown>>,
  base = baseChannelDriver,
  continuation?: OpenResponsesContinuation.Shape,
) => {
  const message = ProviderShared.encodeJson(request)
  return OpenResponsesContinuation.driver({
    id: "openai-responses",
    name: "OpenAI Responses",
    request,
    message,
    base: base(message),
    continuation,
  })
}

const checkpoint = (observation: ChannelObservation) => {
  if (observation.type !== "completed" || !observation.checkpoint) throw new Error("Expected checkpoint")
  return observation.checkpoint
}

const request = LLM.request({
  id: "req_1",
  model,
  system: "You are concise.",
  prompt: "Say hello.",
  generation: { maxTokens: 20, temperature: 0 },
})

const configEnv = (env: Record<string, string>) => Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env })))

type OpenAIToolOutput = Extract<
  OpenAIResponses.OpenAIResponsesBody["input"][number],
  { readonly type: "function_call_output" }
>

const expectToolOutput = (body: OpenAIResponses.OpenAIResponsesBody): OpenAIToolOutput => {
  const output = body.input.find(
    (item): item is OpenAIToolOutput => "type" in item && item.type === "function_call_output",
  )
  expect(output).toBeDefined()
  return output!
}

describe("OpenAI Responses route", () => {
  it.effect("prepares OpenAI Responses target", () =>
    Effect.gen(function* () {
      const prepared = yield* compileRequest(request)

      expect(prepared.body).toEqual({
        model: "gpt-4.1-mini",
        input: [{ role: "user", content: [{ type: "input_text", text: "Say hello." }] }],
        instructions: "You are concise.",
        store: false,
        include: ["reasoning.encrypted_content"],
        stream: true,
        max_output_tokens: 20,
        temperature: 0,
      })
    }),
  )

  it.effect("lowers the hosted OpenAI image generation tool", () =>
    Effect.gen(function* () {
      const prepared = yield* compileRequest(
        LLM.request({
          model,
          prompt: "Show me a rooftop garden.",
          tools: [OpenAI.imageGeneration({ action: "generate", quality: "high", size: "1024x1024" })],
          toolChoice: "image_generation",
        }),
      )

      expect(prepared.body.tools).toEqual([
        { type: "image_generation", action: "generate", quality: "high", size: "1024x1024" },
      ])
      expect(prepared.body.tool_choice).toEqual({ type: "image_generation" })
    }),
  )

  it.effect("lowers tool namespaces without flattening leaf names", () =>
    Effect.gen(function* () {
      const prepared = yield* compileRequest(
        LLM.request({
          model,
          prompt: "Find a customer and their orders.",
          tools: [
            ToolNamespace.make({
              name: "crm",
              description: "Customer management",
              tools: [
                ToolDefinition.make({ name: "lookup", description: "Look up a customer", inputSchema: {} }),
                ToolDefinition.make({ name: "orders", description: "List customer orders", inputSchema: {} }),
              ],
            }),
          ],
        }),
      )

      expect(prepared.body.tools).toEqual([
        {
          type: "namespace",
          name: "crm",
          description: "Customer management",
          tools: [
            { type: "function", name: "lookup", description: "Look up a customer", parameters: {}, strict: false },
            { type: "function", name: "orders", description: "List customer orders", parameters: {}, strict: false },
          ],
        },
      ])
    }),
  )

  it.effect("flattens nested levels within a native tool namespace", () =>
    Effect.gen(function* () {
      const prepared = yield* compileRequest(
        LLM.request({
          model,
          tools: [
            {
              type: "namespace",
              name: "crm",
              description: "Customer management",
              tools: [
                {
                  type: "namespace",
                  name: "orders",
                  description: "Order management",
                  tools: [ToolDefinition.make({ name: "list", description: "List orders", inputSchema: {} })],
                },
              ],
            },
          ],
        }),
      )

      expect(prepared.body.tools).toEqual([
        {
          type: "namespace",
          name: "crm",
          description: "Customer management",
          tools: [{ type: "function", name: "orders_list", description: "List orders", parameters: {}, strict: false }],
        },
      ])
    }),
  )

  it.effect("defaults tool namespace descriptions", () =>
    Effect.gen(function* () {
      const prepared = yield* compileRequest(
        LLM.request({
          model,
          tools: [
            {
              type: "namespace",
              name: "crm",
              tools: [ToolDefinition.make({ name: "lookup", description: "Look up a customer", inputSchema: {} })],
            },
          ],
        }),
      )

      expect(prepared.body.tools).toEqual([
        expect.objectContaining({ type: "namespace", name: "crm", description: "Tools in the crm namespace." }),
      ])
    }),
  )

  it.effect("rejects invalid hosted image generation options locally", () =>
    Effect.gen(function* () {
      const error = yield* compileRequest(
        LLM.request({
          model,
          prompt: "Show me a rooftop garden.",
          tools: [OpenAI.imageGeneration({ outputCompression: -1, partialImages: 4, size: "bogus" })],
        }),
      ).pipe(Effect.flip)

      expect(error.reason._tag).toBe("InvalidRequest")
      expect(error.message).toContain("image generation tool options are invalid")
    }),
  )

  it.effect("lowers semantic service tier options", () =>
    Effect.gen(function* () {
      const input = LLMRequest.update(request, { providerOptions: { serviceTier: "priority" } })
      expect(input.providerOptions).toEqual({ serviceTier: "priority" })
      const prepared = yield* compileRequest(input)

      expect(prepared.body).toMatchObject({ service_tier: "priority" })
      expect(prepared.body).not.toHaveProperty("serviceTier")
    }),
  )

  it.effect("passes through custom OpenAI reasoning effort strings", () =>
    Effect.gen(function* () {
      const prepared = yield* compileRequest(
        LLMRequest.update(request, { providerOptions: { reasoningEffort: "experimental" } }),
      )

      expect(prepared.body.reasoning).toEqual({ effort: "experimental" })
    }),
  )

  it.effect("passes through custom OpenAI text verbosity strings", () =>
    Effect.gen(function* () {
      const prepared = yield* compileRequest(
        LLMRequest.update(request, { providerOptions: { textVerbosity: "verbose" } }),
      )

      expect(prepared.body.text).toEqual({ verbosity: "verbose" })
    }),
  )

  it.effect("passes through provider-defined service tiers", () =>
    Effect.gen(function* () {
      const prepared = yield* compileRequest(LLMRequest.update(request, { providerOptions: { serviceTier: "scale" } }))

      expect(prepared.body.service_tier).toBe("scale")
    }),
  )

  it.effect("preserves function schemas", () =>
    Effect.gen(function* () {
      const prepared = yield* compileRequest(
        LLMRequest.update(request, {
          tools: [
            ToolDefinition.make({
              name: "read",
              description: "Read a path or resource.",
              inputSchema: {
                type: "object",
                anyOf: [
                  {
                    type: "object",
                    properties: {
                      path: { type: "string" },
                      reference: { anyOf: [{ type: "string" }, { type: "null" }] },
                      limit: { type: "integer", maximum: 2000 },
                    },
                    required: ["path"],
                  },
                  {
                    type: "object",
                    properties: { resource: { type: "string" }, limit: { type: "integer", maximum: 51200 } },
                    required: ["resource"],
                  },
                ],
              },
            }),
          ],
        }),
      )

      expect(prepared.body.tools).toEqual([
        {
          type: "function",
          name: "read",
          description: "Read a path or resource.",
          strict: false,
          parameters: {
            type: "object",
            anyOf: [
              {
                type: "object",
                properties: {
                  path: { type: "string" },
                  reference: { anyOf: [{ type: "string" }, { type: "null" }] },
                  limit: { type: "integer", maximum: 2000 },
                },
                required: ["path"],
              },
              {
                type: "object",
                properties: { resource: { type: "string" }, limit: { type: "integer", maximum: 51200 } },
                required: ["resource"],
              },
            ],
          },
        },
      ])
    }),
  )

  it.effect("maps the canonical parallel tool setting with provider-option precedence", () =>
    Effect.gen(function* () {
      const disabled = yield* compileRequest(
        LLMRequest.update(request, {
          toolChoice: { type: "auto", disableParallelToolUse: true },
        }),
      )
      const enabled = yield* compileRequest(
        LLMRequest.update(request, {
          toolChoice: { type: "auto", disableParallelToolUse: false },
        }),
      )
      const overridden = yield* compileRequest(
        LLMRequest.update(request, {
          toolChoice: { type: "auto", disableParallelToolUse: true },
          providerOptions: { parallelToolCalls: true },
        }),
      )

      expect(disabled.body.parallel_tool_calls).toBe(false)
      expect(enabled.body.parallel_tool_calls).toBe(true)
      expect(overridden.body.parallel_tool_calls).toBe(true)
    }),
  )

  it.effect("lowers chronological system updates to developer messages in order", () =>
    Effect.gen(function* () {
      const prepared = yield* compileRequest(
        LLM.request({
          model,
          messages: [Message.user("Before."), Message.system("Operator update."), Message.assistant("After.")],
        }),
      )

      expect(prepared.body.input).toEqual([
        { role: "user", content: [{ type: "input_text", text: "Before." }] },
        { role: "developer", content: "Operator update." },
        { type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "After." }] },
      ])
    }),
  )

  it.effect("prepares one OpenAI Responses route for either transport", () =>
    Effect.gen(function* () {
      const prepared = yield* compileRequest(
        LLMRequest.update(request, {
          model: OpenAIResponses.route
            .with({ endpoint: { baseURL: "https://api.openai.test/v1/" }, auth: Auth.bearer("test") })
            .model({ id: "gpt-4.1-mini" }),
        }),
      )

      expect(prepared.route).toBe("openai-responses")
      expect(prepared.protocol).toBe("openai-responses")
      expect(prepared.metadata).toEqual({ transport: "http-json" })
      expect(prepared.body).toMatchObject({
        model: "gpt-4.1-mini",
        store: false,
        include: ["reasoning.encrypted_content"],
        stream: true,
      })
    }),
  )

  it.effect("streams OpenAI Responses over WebSocket", () =>
    Effect.gen(function* () {
      const sent: string[] = []
      const opened: Array<{
        readonly url: string
        readonly authorization: string | undefined
        readonly protocol: string | undefined
      }> = []
      let closed = false
      const deps = Layer.succeed(
        RequestExecutor.Service,
        RequestExecutor.Service.of({
          execute: () => Effect.die("unexpected HTTP request"),
        }),
      )
      const webSocket = WebSocketTransport.makeDirect({
        open: (input) =>
          Effect.succeed({
            sendText: (message) =>
              Effect.sync(() => {
                opened.push({
                  url: input.url,
                  authorization: input.headers.authorization,
                  protocol: input.headers["openai-beta"],
                })
                sent.push(message)
              }),
            messages: Stream.fromArray([
              ProviderShared.encodeJson({ type: "response.created", response: { id: "resp_ws" } }),
              ProviderShared.encodeJson({
                type: "response.output_item.added",
                item: { type: "message", id: "msg_1" },
              }),
              ProviderShared.encodeJson({ type: "response.output_text.delta", item_id: "msg_1", delta: "Hi" }),
              ProviderShared.encodeJson({ type: "response.completed", response: { id: "resp_ws" } }),
            ]),
            close: Effect.sync(() => {
              closed = true
            }),
          }),
      })
      const response = yield* LLMClient.generate(
        LLM.request({
          model: OpenAI.configure({
            baseURL: "https://api.openai.test/v1/",
            apiKey: "test",
            headers: { "openai-beta": "custom-protocol" },
          }).responses("gpt-4.1-mini"),
          prompt: "Say hello.",
        }),
        { webSocket },
      ).pipe(Effect.provide(LLMClient.layer.pipe(Layer.provide(deps))))

      expect(response.text).toBe("Hi")
      expect(opened).toEqual([
        {
          url: "wss://api.openai.test/v1/responses",
          authorization: "Bearer test",
          protocol: "custom-protocol",
        },
      ])
      expect(closed).toBe(true)
      expect(sent).toHaveLength(1)
      expect(JSON.parse(sent[0])).toEqual({
        type: "response.create",
        model: "gpt-4.1-mini",
        input: [{ role: "user", content: [{ type: "input_text", text: "Say hello." }] }],
        store: false,
        include: ["reasoning.encrypted_content"],
      })
    }),
  )

  it.effect("rejects out-of-order and mismatched WebSocket response events", () =>
    Effect.gen(function* () {
      const streams = [
        Stream.fromArray([
          ProviderShared.encodeJson({ type: "response.output_text.delta", item_id: "late", delta: "Late" }),
          ProviderShared.encodeJson({ type: "response.completed", response: { id: "resp_old" } }),
        ]),
        Stream.fromArray([
          ProviderShared.encodeJson({ type: "response.created", response: { id: "resp_new" } }),
          ProviderShared.encodeJson({ type: "response.completed", response: { id: "resp_old" } }),
        ]),
      ]
      const webSocket = WebSocketTransport.makeDirect({
        open: () =>
          Effect.succeed({
            sendText: () => Effect.void,
            messages: streams.shift() ?? Stream.die("unexpected WebSocket open"),
            close: Effect.void,
          }),
      })
      const deps = Layer.succeed(
        RequestExecutor.Service,
        RequestExecutor.Service.of({ execute: () => Effect.die("unexpected HTTP request") }),
      )
      const model = OpenAI.configure({ baseURL: "https://api.openai.test/v1/", apiKey: "test" }).responses(
        "gpt-4.1-mini",
      )

      const errors = yield* Effect.forEach(["late", "mismatch"], (prompt) =>
        LLMClient.generate(LLM.request({ model, prompt }), { webSocket }).pipe(
          Effect.provide(LLMClient.layer.pipe(Layer.provide(deps))),
          Effect.flip,
        ),
      )

      expect(errors.map((error) => error.reason._tag)).toEqual(["InvalidProviderOutput", "InvalidProviderOutput"])
      expect(errors[0]?.message).toContain("before response.created")
      expect(errors[1]?.message).toContain("response ID changed")
    }),
  )

  it.effect("tolerates keepalive and provider notifications before response.created", () =>
    Effect.gen(function* () {
      const webSocket = WebSocketTransport.makeDirect({
        open: () =>
          Effect.succeed({
            sendText: () => Effect.void,
            messages: Stream.fromArray([
              ProviderShared.encodeJson({ type: "keepalive", sequence_number: 0 }),
              ProviderShared.encodeJson({ type: "codex.rate_limits" }),
              ProviderShared.encodeJson({ type: "response.created", response: { id: "resp_alive" } }),
              ProviderShared.encodeJson({
                type: "response.completed",
                response: { id: "resp_alive", usage: { input_tokens: 1, output_tokens: 1 } },
              }),
            ]),
            close: Effect.void,
          }),
      })
      const deps = Layer.succeed(
        RequestExecutor.Service,
        RequestExecutor.Service.of({ execute: () => Effect.die("unexpected HTTP request") }),
      )
      const model = OpenAI.configure({ baseURL: "https://api.openai.test/v1/", apiKey: "test" }).responses(
        "gpt-4.1-mini",
      )

      const response = yield* LLMClient.generate(LLM.request({ model, prompt: "hi" }), { webSocket }).pipe(
        Effect.provide(LLMClient.layer.pipe(Layer.provide(deps))),
      )
      expect(response.finishReason?.normalized).toBe("stop")
    }),
  )

  it.effect("continues a streamed tool call with only the new tool output", () =>
    Effect.forEach([undefined, []], (output) =>
      Effect.gen(function* () {
        const firstRequest = {
          type: "response.create",
          model: "gpt-5.2",
          store: false,
          input: [{ role: "user", content: [{ type: "input_text", text: "Weather?" }] }],
        }
        const first = continuationDriver(firstRequest)
        const firstCreate = yield* first.create(undefined)
        yield* first.observe(
          firstCreate,
          ProviderShared.encodeJson({
            type: "response.output_item.done",
            item: {
              type: "function_call",
              id: "fc_1",
              status: "completed",
              call_id: "call_1",
              name: "weather",
              arguments: '{ "city": "Paris" }',
            },
          }),
        )
        const saved = checkpoint(
          yield* first.observe(
            firstCreate,
            ProviderShared.encodeJson({ type: "response.completed", response: { id: "resp_1", output } }),
          ),
        )
        const second = continuationDriver({
          ...firstRequest,
          input: [
            ...firstRequest.input,
            { type: "function_call", call_id: "call_1", name: "weather", arguments: '{"city":"Paris"}' },
            { type: "function_call_output", call_id: "call_1", output: '{"temperature":22}' },
          ],
        })

        const create = yield* second.create(saved)

        expect(create.mode).toBe("incremental")
        expect(ProviderShared.decodeJson(create.message)).toMatchObject({
          previous_response_id: "resp_1",
          input: [{ type: "function_call_output", call_id: "call_1", output: '{"temperature":22}' }],
        })
      }),
    ),
  )

  it.effect("continues a tool call from authoritative completed response output", () =>
    Effect.gen(function* () {
      const firstRequest = {
        type: "response.create",
        model: "gpt-5.2",
        store: false,
        input: [{ role: "user", content: [{ type: "input_text", text: "Weather?" }] }],
      }
      const first = continuationDriver(firstRequest)
      const firstCreate = yield* first.create(undefined)
      const saved = checkpoint(
        yield* first.observe(
          firstCreate,
          ProviderShared.encodeJson({
            type: "response.completed",
            response: {
              id: "resp_1",
              output: [
                {
                  type: "function_call",
                  id: "fc_1",
                  status: "completed",
                  call_id: "call_1",
                  name: "weather",
                  arguments: '{ "city": "Paris" }',
                },
              ],
            },
          }),
        ),
      )
      const second = continuationDriver({
        ...firstRequest,
        input: [
          ...firstRequest.input,
          { type: "function_call", call_id: "call_1", name: "weather", arguments: '{"city":"Paris"}' },
          { type: "function_call_output", call_id: "call_1", output: '{"temperature":22}' },
        ],
      })

      const create = yield* second.create(saved)

      expect(create.mode).toBe("incremental")
      expect(ProviderShared.decodeJson(create.message)).toMatchObject({
        previous_response_id: "resp_1",
        input: [{ type: "function_call_output", call_id: "call_1", output: '{"temperature":22}' }],
      })
    }),
  )

  it.effect("continues a promoted steer after assistant output with response-only text metadata", () =>
    Effect.forEach([undefined, []], (output) =>
      Effect.gen(function* () {
        const firstInput = [{ role: "user", content: [{ type: "input_text", text: "First" }] }]
        const first = continuationDriver({ type: "response.create", model: "gpt-5.2", store: false, input: firstInput })
        const create = yield* first.create(undefined)
        yield* first.observe(
          create,
          ProviderShared.encodeJson({
            type: "response.output_item.done",
            item: {
              type: "message",
              id: "msg_1",
              status: "completed",
              role: "assistant",
              content: [{ type: "output_text", text: "Hello", annotations: [], logprobs: [] }],
            },
          }),
        )
        const saved = checkpoint(
          yield* first.observe(
            create,
            ProviderShared.encodeJson({ type: "response.completed", response: { id: "resp_1", output } }),
          ),
        )
        const steer = { role: "user", content: [{ type: "input_text", text: "Actually, be brief" }] }
        const next = continuationDriver({
          type: "response.create",
          model: "gpt-5.2",
          store: false,
          input: [...firstInput, { role: "assistant", content: [{ type: "output_text", text: "Hello" }] }, steer],
        })

        const continued = yield* next.create(saved)

        expect(continued.mode).toBe("incremental")
        expect(ProviderShared.decodeJson(continued.message)).toMatchObject({
          previous_response_id: "resp_1",
          input: [steer],
        })
      }),
    ),
  )

  it.effect("continues streamed reasoning when completion re-encrypts the same item", () =>
    Effect.gen(function* () {
      const firstInput = [{ role: "user", content: [{ type: "input_text", text: "Think" }] }]
      const request = { type: "response.create", model: "gpt-5.2", store: false, input: firstInput }
      const reasoning = {
        type: "reasoning",
        id: "rs_1",
        summary: [{ type: "summary_text", text: "Thought" }],
        encrypted_content: "encrypted",
      }
      const first = continuationDriver(request)
      const create = yield* first.create(undefined)
      yield* first.observe(
        create,
        ProviderShared.encodeJson({
          type: "response.output_item.done",
          item: reasoning,
        }),
      )
      const saved = checkpoint(
        yield* first.observe(
          create,
          ProviderShared.encodeJson({
            type: "response.completed",
            response: { id: "resp_1", output: [{ ...reasoning, encrypted_content: "terminal-encrypted" }] },
          }),
        ),
      )
      const next = continuationDriver({
        ...request,
        input: [...firstInput, reasoning, { role: "user", content: [{ type: "input_text", text: "Continue" }] }],
      })

      const continued = yield* next.create(saved)

      expect(continued.mode).toBe("incremental")
      expect(ProviderShared.decodeJson(continued.message)).toMatchObject({
        previous_response_id: "resp_1",
        input: [{ role: "user", content: [{ type: "input_text", text: "Continue" }] }],
      })
      const edited = yield* continuationDriver({
        ...request,
        input: [...firstInput, { ...reasoning, encrypted_content: "edited" }, { role: "user", content: "Continue" }],
      }).create(saved)
      expect(edited.mode).toBe("full")
    }),
  )

  it.effect("uses a full request when any non-input invariant changes", () =>
    Effect.gen(function* () {
      const request = {
        type: "response.create",
        model: "gpt-5.2",
        store: false,
        metadata: { source: "one" },
        input: [{ role: "user", content: [{ type: "input_text", text: "First" }] }],
      }
      const first = continuationDriver(request)
      const create = yield* first.create(undefined)
      const saved = checkpoint(
        yield* first.observe(
          create,
          ProviderShared.encodeJson({ type: "response.completed", response: { id: "resp_1" } }),
        ),
      )
      const appended = [...request.input, { role: "user", content: [{ type: "input_text", text: "Second" }] }]
      const changes = [
        { ...request, model: "gpt-5.3", input: appended },
        { ...request, instructions: "Changed", input: appended },
        { ...request, tools: [{ type: "function", name: "other" }], input: appended },
        { ...request, temperature: 0.5, input: appended },
        { ...request, metadata: { source: "two" }, input: appended },
        {
          ...request,
          input: [{ role: "user", content: [{ type: "input_text", text: "Rewritten history" }] }, appended[1]],
        },
      ]

      const creates = yield* Effect.forEach(changes, (changed) => continuationDriver(changed).create(saved))

      expect(creates.map((item) => item.mode)).toEqual(changes.map(() => "full"))
      expect(
        creates
          .map((item) => ProviderShared.decodeJson(item.message))
          .every((item) => ProviderShared.isRecord(item) && !("previous_response_id" in item)),
      ).toBe(true)
    }),
  )

  it.effect("stages no checkpoint for incomplete or ID-less completion", () =>
    Effect.gen(function* () {
      const driver = continuationDriver({ type: "response.create", model: "gpt-5.2", input: [] })
      const create = yield* driver.create(undefined)

      const completed = yield* driver.observe(
        create,
        ProviderShared.encodeJson({ type: "response.completed", response: {} }),
      )
      expect(completed).toMatchObject({ type: "completed" })
      expect(completed).not.toHaveProperty("checkpoint")
      expect(
        yield* driver.observe(create, ProviderShared.encodeJson({ type: "response.incomplete", response: {} })),
      ).toMatchObject({ type: "incomplete" })
    }),
  )

  it.effect("classifies explicit continuation rejection for runner-owned recovery", () =>
    Effect.gen(function* () {
      const driver = continuationDriver({ type: "response.create", model: "gpt-5.2", input: [] })
      const create = yield* driver.create(undefined)
      const missing = yield* driver.observe(
        create,
        ProviderShared.encodeJson({
          type: "error",
          error: { code: "previous_response_not_found", message: "Missing response" },
        }),
      )
      const limit = yield* driver.observe(
        create,
        ProviderShared.encodeJson({
          type: "error",
          error: { code: "websocket_connection_limit_reached", message: "Rotate" },
        }),
      )

      expect(missing).toMatchObject({
        type: "rejected",
        recovery: "retry-full",
        error: { reason: { _tag: "Transport", delivery: "rejected", recovery: "retry-full" } },
      })
      expect(limit).toMatchObject({
        type: "rejected",
        recovery: "rotate-and-retry-full",
        error: {
          reason: { _tag: "Transport", delivery: "rejected", recovery: "rotate-and-retry-full" },
        },
      })
      for (const observation of [missing, limit]) {
        expect(observation.type).toBe("rejected")
        if (observation.type !== "rejected") continue
        expect(observation.error.message).toBe("provider rejected request")
        expect(observation.error.reason.cause).toBeInstanceOf(Error)
        expect(observation.error.reason.cause).toMatchObject({ message: "provider cause" })
        expect(observation.error.reason.http).toMatchObject({ status: 200, headers: { "x-trace": "trace-1" } })
        expect(ProviderShared.decodeJson(observation.error.reason.body ?? "")).toMatchObject({
          type: "error",
          error: { code: expect.any(String) },
        })
      }
    }),
  )

  it.effect("retries an incremental send in full when the provider rejects it without a code", () =>
    Effect.gen(function* () {
      const firstRequest = {
        type: "response.create",
        model: "gpt-5.2",
        store: false,
        input: [{ role: "user", content: [{ type: "input_text", text: "First" }] }],
      }
      const first = continuationDriver(firstRequest, classifyingChannelDriver)
      const saved = checkpoint(
        yield* first.observe(
          yield* first.create(undefined),
          ProviderShared.encodeJson({ type: "response.completed", response: { id: "resp_1" } }),
        ),
      )
      const second = continuationDriver(
        {
          ...firstRequest,
          input: [...firstRequest.input, { role: "user", content: [{ type: "input_text", text: "Second" }] }],
        },
        classifyingChannelDriver,
      )
      // Codex reports a stale previous_response_id as a plain invalid_request_error.
      const stale = ProviderShared.encodeJson({
        type: "error",
        error: { type: "invalid_request_error", message: "Invalid `previous_response_id`." },
      })
      const incremental = yield* second.create(saved)
      expect(incremental.mode).toBe("incremental")
      expect(yield* second.observe(incremental, stale)).toMatchObject({ type: "rejected", recovery: "retry-full" })

      // A full send has no continuation to blame, so the same error stays a provider failure.
      const full = yield* second.create(undefined)
      expect(yield* second.observe(full, stale)).toMatchObject({ type: "provider-failure" })

      // A classified failure keeps its runner-owned recovery instead of resending the whole context.
      const overflow = ProviderShared.encodeJson({
        type: "error",
        error: { type: "invalid_request_error", code: "context_length_exceeded", message: "Too long" },
      })
      expect(yield* second.observe(yield* second.create(saved), overflow)).toMatchObject({
        type: "provider-failure",
        error: { reason: { _tag: "InvalidRequest", classification: "context-overflow" } },
      })

      // A retryable failure stays one: the runner retries it, and the transport has already dropped the
      // checkpoint, so that retry is a full send. xAI reports every rejection this way.
      const internal = ProviderShared.encodeJson({
        type: "error",
        error: { type: "api_error", message: "gRPC error: Response with id=resp_1 not found" },
      })
      expect(yield* second.observe(yield* second.create(saved), internal)).toMatchObject({
        type: "provider-failure",
        error: { reason: { _tag: "ProviderInternal" } },
      })
    }),
  )

  it.effect("shapes the incremental send with the route continuation", () =>
    Effect.gen(function* () {
      const firstRequest = {
        type: "response.create",
        model: "grok-4.6",
        store: true,
        instructions: "You are terse.",
        input: [{ role: "user", content: [{ type: "input_text", text: "First" }] }],
      }
      const secondRequest = {
        ...firstRequest,
        input: [...firstRequest.input, { role: "user", content: [{ type: "input_text", text: "Second" }] }],
      }
      const saved = checkpoint(
        yield* continuationDriver(firstRequest).observe(
          yield* continuationDriver(firstRequest).create(undefined),
          ProviderShared.encodeJson({ type: "response.completed", response: { id: "resp_1" } }),
        ),
      )

      const trimmed = yield* continuationDriver(
        secondRequest,
        baseChannelDriver,
        ({ instructions: _, ...rest }) => rest,
      ).create(saved)
      expect(trimmed.mode).toBe("incremental")
      expect(JSON.parse(trimmed.message)).toEqual({
        type: "response.create",
        model: "grok-4.6",
        store: true,
        previous_response_id: "resp_1",
        input: [{ role: "user", content: [{ type: "input_text", text: "Second" }] }],
      })

      // Declining the continuation sends the step in full and never sends a previous_response_id.
      const declined = yield* continuationDriver(secondRequest, baseChannelDriver, () => undefined).create(saved)
      expect(declined.mode).toBe("full")
      expect(JSON.parse(declined.message)).toEqual(secondRequest)
    }),
  )

  it.effect("builds WebSocket and HTTP fallback from the same final request", () =>
    Effect.gen(function* () {
      const attempts = yield* Ref.make(0)
      const message = yield* Ref.make("")
      const body = yield* Ref.make("")
      const response = yield* LLMClient.generate(
        LLM.request({
          model: OpenAI.configure({ baseURL: "https://api.openai.test/v1/", apiKey: "test" }).responses("gpt-4.1-mini"),
          prompt: "Say hello.",
          http: {
            body: {
              model: "overlaid-model",
              metadata: { source: "overlay" },
              stream_options: { include_usage: true },
              background: true,
            },
            headers: { "x-request": "request" },
            query: { mode: "test" },
          },
        }),
        {
          webSocket: {
            execute: (exchange) =>
              Effect.gen(function* () {
                expect(exchange.connect.rotateAfterMs).toBe(55 * 60 * 1000)
                expect(exchange.connect.headers["openai-beta"]).toBe("responses_websockets=2026-02-06")
                expect(exchange.connect.headers["content-length"]).toBeUndefined()
                yield* exchange.driver
                  .create(undefined)
                  .pipe(Effect.flatMap((create) => Ref.set(message, create.message)))
                return { frames: exchange.fallback(), complete: Effect.void }
              }),
          },
        },
      ).pipe(
        Effect.provide(
          dynamicResponse((input) =>
            Effect.gen(function* () {
              yield* Ref.update(attempts, (value) => value + 1)
              yield* Ref.set(body, input.text)
              expect(input.request.url).toBe("https://api.openai.test/v1/responses?mode=test")
              expect(input.request.headers.authorization).toBe("Bearer test")
              expect(input.request.headers["x-request"]).toBe("request")
              return input.respond(sseEvents({ type: "response.completed", response: {} }), {
                headers: { "content-type": "text/event-stream" },
              })
            }),
          ),
        ),
      )

      const httpBody = JSON.parse(yield* Ref.get(body))
      const { stream: _stream, stream_options: _streamOptions, background: _background, ...shared } = httpBody
      expect(response.finishReason?.normalized).toBe("stop")
      expect(yield* Ref.get(attempts)).toBe(1)
      expect(JSON.parse(yield* Ref.get(message))).toEqual({ type: "response.create", ...shared })
      expect(httpBody).toMatchObject({
        model: "overlaid-model",
        metadata: { source: "overlay" },
        stream: true,
        stream_options: { include_usage: true },
        background: true,
      })
    }),
  )

  it.effect("sanitizes outbound WebSocket requests and HTTP fallback bodies", () =>
    Effect.gen(function* () {
      const message = yield* Ref.make("")
      const body = yield* Ref.make("")
      yield* LLMClient.generate(
        LLM.request({
          model: OpenAI.configure({ baseURL: "https://api.openai.test/v1/", apiKey: "test" }).responses("gpt-4.1-mini"),
          prompt: "Say \uD800hello \u{1F600}.",
          http: { body: { metadata: { source: "overlay\uDC00" } } },
        }),
        {
          webSocket: {
            execute: (exchange) =>
              Effect.gen(function* () {
                yield* exchange.driver
                  .create(undefined)
                  .pipe(Effect.flatMap((create) => Ref.set(message, create.message)))
                return { frames: exchange.fallback(), complete: Effect.void }
              }),
          },
        },
      ).pipe(
        Effect.provide(
          dynamicResponse((input) =>
            Effect.gen(function* () {
              yield* Ref.set(body, input.text)
              return input.respond(sseEvents({ type: "response.completed", response: {} }), {
                headers: { "content-type": "text/event-stream" },
              })
            }),
          ),
        ),
      )

      const expected = {
        input: [{ role: "user", content: [{ type: "input_text", text: "Say \uFFFDhello \u{1F600}." }] }],
        metadata: { source: "overlay\uFFFD" },
      }
      expect(JSON.parse(yield* Ref.get(message))).toMatchObject(expected)
      expect(JSON.parse(yield* Ref.get(body))).toMatchObject(expected)
    }),
  )

  it.effect("builds xAI WebSocket requests without OpenAI handshake headers", () =>
    Effect.gen(function* () {
      const deps = Layer.succeed(
        RequestExecutor.Service,
        RequestExecutor.Service.of({ execute: () => Effect.die("unexpected HTTP request") }),
      )
      const response = yield* LLMClient.generate(LLM.request({ model: xaiModel, prompt: "Say hello." }), {
        webSocket: {
          execute: (exchange) =>
            Effect.gen(function* () {
              expect(exchange.connect.url).toBe("wss://api.x.ai/v1/responses")
              expect(exchange.connect.rotateAfterMs).toBe(24 * 60 * 1000)
              expect(exchange.connect.headers.authorization).toBe("Bearer test")
              expect(exchange.connect.headers["openai-beta"]).toBeUndefined()
              expect(JSON.parse((yield* exchange.driver.create(undefined)).message)).toMatchObject({
                type: "response.create",
                model: "grok-4.5",
                store: false,
              })
              return {
                frames: Stream.make(
                  JSON.stringify({ type: "response.created", response: { id: "resp_xai" } }),
                  JSON.stringify({ type: "response.completed", response: { id: "resp_xai" } }),
                ),
                complete: Effect.void,
              }
            }),
        },
      }).pipe(Effect.provide(LLMClient.layer.pipe(Layer.provide(deps))))

      expect(response.finishReason.normalized).toBe("stop")
    }),
  )

  it.effect("builds Azure WebSocket requests with v1 URLs and bearer auth", () =>
    Effect.gen(function* () {
      const deps = Layer.succeed(
        RequestExecutor.Service,
        RequestExecutor.Service.of({ execute: () => Effect.die("unexpected HTTP request") }),
      )
      const cases = [
        {
          model: Azure.configure({ resourceName: "opencode-test", apiKey: "azure-key" }).responses("deployment"),
          authorization: "Bearer azure-key",
        },
        {
          model: Azure.configure({ resourceName: "opencode-test", auth: Auth.bearer("entra-token") }).responses(
            "deployment",
          ),
          authorization: "Bearer entra-token",
        },
      ]

      yield* Effect.forEach(cases, (item) =>
        LLMClient.generate(LLM.request({ model: item.model, prompt: "Say hello." }), {
          webSocket: {
            execute: (exchange) =>
              Effect.gen(function* () {
                expect(exchange.connect.url).toBe("wss://opencode-test.openai.azure.com/openai/v1/responses")
                expect(exchange.connect.rotateAfterMs).toBe(55 * 60 * 1000)
                expect(exchange.connect.headers.authorization).toBe(item.authorization)
                expect(exchange.connect.headers["api-key"]).toBeUndefined()
                expect(exchange.connect.headers["openai-beta"]).toBeUndefined()
                expect(JSON.parse((yield* exchange.driver.create(undefined)).message)).toMatchObject({
                  type: "response.create",
                  model: "deployment",
                  store: false,
                })
                return {
                  frames: Stream.make(
                    JSON.stringify({ type: "response.created", response: { id: "resp_azure" } }),
                    JSON.stringify({ type: "response.completed", response: { id: "resp_azure" } }),
                  ),
                  complete: Effect.void,
                }
              }),
          },
        }).pipe(Effect.provide(LLMClient.layer.pipe(Layer.provide(deps)))),
      )
    }),
  )

  it.effect("keeps unsupported Azure endpoints and API versions on HTTP", () =>
    Effect.gen(function* () {
      const cases = [
        {
          model: Azure.configure({
            resourceName: "opencode-test",
            apiKey: "azure-key",
            apiVersion: "2025-04-01-preview",
          }).responses("deployment"),
          url: "https://opencode-test.openai.azure.com/openai/v1/responses?api-version=2025-04-01-preview",
        },
        {
          model: Azure.configure({
            resourceName: "opencode-test",
            apiKey: "azure-key",
            useDeploymentBasedUrls: true,
          }).responses("deployment"),
          url: "https://opencode-test.openai.azure.com/openai/deployments/deployment/responses?api-version=v1",
        },
        {
          model: Azure.configure({ baseURL: "https://gateway.example/azure", apiKey: "azure-key" }).responses(
            "deployment",
          ),
          url: "https://gateway.example/azure/responses",
        },
      ]

      yield* Effect.forEach(cases, (item) =>
        LLMClient.generate(LLM.request({ model: item.model, prompt: "Say hello." }), {
          webSocket: { execute: () => Effect.die("unexpected WebSocket request") },
        }).pipe(
          Effect.provide(
            dynamicResponse((input) =>
              Effect.gen(function* () {
                expect(input.request.url).toBe(item.url)
                return input.respond(sseEvents({ type: "response.completed", response: {} }), {
                  headers: { "content-type": "text/event-stream" },
                })
              }),
            ),
          ),
        ),
      )
    }),
  )

  it.effect("uses exactly one HTTP request when no WebSocket executor is supplied", () =>
    Effect.gen(function* () {
      const attempts = yield* Ref.make(0)
      yield* LLMClient.generate(
        LLMRequest.update(request, { http: new HttpOptions({ body: { input: "raw-http-input" } }) }),
      ).pipe(
        Effect.provide(
          dynamicResponse((input) =>
            Effect.gen(function* () {
              yield* Ref.update(attempts, (value) => value + 1)
              expect(JSON.parse(input.text).input).toBe("raw-http-input")
              return input.respond(sseEvents({ type: "response.completed", response: {} }), {
                headers: { "content-type": "text/event-stream" },
              })
            }),
          ),
        ),
      )

      expect(yield* Ref.get(attempts)).toBe(1)
    }),
  )

  it.effect("closes a direct WebSocket execution after partial consumption", () =>
    Effect.gen(function* () {
      const closed = yield* Ref.make(false)
      const webSocket = WebSocketTransport.makeDirect({
        open: () =>
          Effect.succeed({
            sendText: () => Effect.void,
            messages: Stream.fromArray([
              ProviderShared.encodeJson({ type: "response.created", response: { id: "resp_ws" } }),
              ProviderShared.encodeJson({ type: "response.output_text.delta", item_id: "msg_1", delta: "Hi" }),
              ProviderShared.encodeJson({ type: "response.completed", response: { id: "resp_ws" } }),
            ]),
            close: Ref.set(closed, true),
          }),
      })

      yield* LLMClient.stream(
        LLM.request({
          model: OpenAI.configure({ baseURL: "https://api.openai.test/v1/", apiKey: "test" }).responses("gpt-4.1-mini"),
          prompt: "Say hello.",
        }),
        { webSocket },
      ).pipe(
        Stream.take(1),
        Stream.runDrain,
        Effect.provide(
          LLMClient.layer.pipe(
            Layer.provide(
              Layer.succeed(
                RequestExecutor.Service,
                RequestExecutor.Service.of({ execute: () => Effect.die("unexpected HTTP request") }),
              ),
            ),
          ),
        ),
      )

      expect(yield* Ref.get(closed)).toBe(true)
    }),
  )

  it.effect("terminates WebSocket control events without waiting for the socket to close", () =>
    Effect.gen(function* () {
      const events = [
        { type: "error", error: { code: "slow_down", message: "Try later" } },
        {
          type: "error",
          status_code: 429,
          message: "Rate limited",
          headers: { "retry-after": 1, "x-request-id": "request", cached: false, invalid: [] },
        },
        {
          type: "response.failed",
          response: { error: { code: "server_error", message: "Unavailable" } },
        },
        { type: "error", status: "not-a-status", message: "Malformed status" },
      ]

      const errors = yield* Effect.forEach(events, (event) =>
        LLMClient.generate(
          LLM.request({
            model: OpenAI.configure({ baseURL: "https://api.openai.test/v1/", apiKey: "test" }).responses(
              "gpt-4.1-mini",
            ),
            prompt: "Say hello.",
          }),
          {
            webSocket: WebSocketTransport.makeDirect({
              open: () =>
                Effect.succeed({
                  sendText: () => Effect.void,
                  messages: Stream.make(ProviderShared.encodeJson(event)).pipe(Stream.concat(Stream.never)),
                  close: Effect.void,
                }),
            }),
          },
        ).pipe(
          Effect.provide(
            LLMClient.layer.pipe(
              Layer.provide(
                Layer.succeed(
                  RequestExecutor.Service,
                  RequestExecutor.Service.of({ execute: () => Effect.die("unexpected HTTP request") }),
                ),
              ),
            ),
          ),
          Effect.flip,
        ),
      )

      expect(errors.map((error) => error.reason._tag)).toEqual([
        "ProviderInternal",
        "RateLimit",
        "ProviderInternal",
        "UnknownProvider",
      ])
    }),
  )

  it.effect("marks post-send WebSocket failures with delivery state", () =>
    Effect.gen(function* () {
      const failure = new AIError({
        reason: new TransportError({
          message: "socket closed",
          transport: "websocket",
          operation: "read",
          phase: "close",
        }),
      })
      const streams = [
        Stream.fail(failure),
        Stream.make(ProviderShared.encodeJson({ type: "response.created", response: { id: "resp_observed" } })).pipe(
          Stream.concat(Stream.fail(failure)),
        ),
      ]
      const deps = Layer.succeed(
        RequestExecutor.Service,
        RequestExecutor.Service.of({ execute: () => Effect.die("unexpected HTTP request") }),
      )
      const webSocket = WebSocketTransport.makeDirect({
        open: () =>
          Effect.succeed({
            sendText: () => Effect.void,
            messages: streams.shift() ?? Stream.die("unexpected WebSocket open"),
            close: Effect.void,
          }),
      })
      const model = OpenAI.configure({ baseURL: "https://api.openai.test/v1/", apiKey: "test" }).responses(
        "gpt-4.1-mini",
      )

      const errors = yield* Effect.forEach(["first", "second"], (prompt) =>
        LLMClient.generate(LLM.request({ model, prompt }), { webSocket }).pipe(
          Effect.provide(LLMClient.layer.pipe(Layer.provide(deps))),
          Effect.flip,
        ),
      )

      expect(errors.map((error) => error.reason)).toEqual([
        expect.objectContaining({ _tag: "Transport", phase: "close", delivery: "ambiguous" }),
        expect.objectContaining({ _tag: "Transport", phase: "close", delivery: "accepted" }),
      ])
    }),
  )

  it.effect("fails immediately when WebSocket is already closed", () =>
    Effect.gen(function* () {
      const error = yield* WebSocketTransport.fromWebSocket(
        // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- fromWebSocket reads readyState before touching WebSocket methods on this branch.
        { readyState: globalThis.WebSocket.CLOSED } as globalThis.WebSocket,
        { url: "wss://api.openai.test/v1/responses", headers: Headers.empty },
      ).pipe(Effect.flip)

      expect(error.message).toContain("closed before opening")
      expect(error.reason).toMatchObject({ _tag: "Transport", phase: "connect", delivery: "not-sent" })
    }),
  )

  it.effect("adds native query params to the Responses URL", () =>
    Effect.gen(function* () {
      yield* LLMClient.generate(
        LLMRequest.update(request, {
          model: LanguageModel.update(model, {
            route: model.route.with({ endpoint: { query: { "api-version": "v1" } } }),
          }),
        }),
      ).pipe(
        Effect.provide(
          dynamicResponse((input) =>
            Effect.gen(function* () {
              const web = yield* HttpClientRequest.toWeb(input.request).pipe(Effect.orDie)
              expect(web.url).toBe("https://api.openai.test/v1/responses?api-version=v1")
              return input.respond(sseEvents({ type: "response.completed", response: {} }), {
                headers: { "content-type": "text/event-stream" },
              })
            }),
          ),
        ),
      )
    }),
  )

  it.effect("uses Azure api-key header for static OpenAI Responses keys", () =>
    Effect.gen(function* () {
      yield* LLMClient.generate(
        LLMRequest.update(request, {
          model: Azure.configure({
            baseURL: "https://opencode-test.openai.azure.com/openai/",
            apiKey: "azure-key",
            headers: { authorization: "Bearer stale" },
          }).responses("gpt-4.1-mini"),
        }),
      ).pipe(
        Effect.provide(
          dynamicResponse((input) =>
            Effect.gen(function* () {
              const web = yield* HttpClientRequest.toWeb(input.request).pipe(Effect.orDie)
              expect(web.url).toBe("https://opencode-test.openai.azure.com/openai/v1/responses?api-version=v1")
              expect(web.headers.get("api-key")).toBe("azure-key")
              expect(web.headers.get("authorization")).toBeNull()
              return input.respond(sseEvents({ type: "response.completed", response: {} }), {
                headers: { "content-type": "text/event-stream" },
              })
            }),
          ),
        ),
      )
    }),
  )

  it.effect("loads OpenAI default auth from Effect Config", () =>
    LLMClient.generate(
      LLMRequest.update(request, {
        model: OpenAI.configure({ baseURL: "https://api.openai.test/v1/" }).responses("gpt-4.1-mini"),
      }),
    ).pipe(
      configEnv({ OPENAI_API_KEY: "env-key" }),
      Effect.provide(
        dynamicResponse((input) =>
          Effect.gen(function* () {
            const web = yield* HttpClientRequest.toWeb(input.request).pipe(Effect.orDie)
            expect(web.headers.get("authorization")).toBe("Bearer env-key")
            return input.respond(sseEvents({ type: "response.completed", response: {} }), {
              headers: { "content-type": "text/event-stream" },
            })
          }),
        ),
      ),
    ),
  )

  it.effect("lets explicit auth override OpenAI default API key auth", () =>
    LLMClient.generate(
      LLMRequest.update(request, {
        model: OpenAI.configure({
          baseURL: "https://api.openai.test/v1/",
          auth: Auth.bearer("oauth-token"),
        }).responses("gpt-4.1-mini"),
      }),
    ).pipe(
      Effect.provide(
        dynamicResponse((input) =>
          Effect.gen(function* () {
            const web = yield* HttpClientRequest.toWeb(input.request).pipe(Effect.orDie)
            expect(web.headers.get("authorization")).toBe("Bearer oauth-token")
            return input.respond(sseEvents({ type: "response.completed", response: {} }), {
              headers: { "content-type": "text/event-stream" },
            })
          }),
        ),
      ),
    ),
  )

  it.effect("prepares function call and function output input items", () =>
    Effect.gen(function* () {
      const prepared = yield* compileRequest(
        LLM.request({
          id: "req_tool_result",
          model,
          messages: [
            Message.user("What is the weather?"),
            Message.assistant([ToolCallPart.make({ id: "call_1", name: "lookup", input: { query: "weather" } })]),
            Message.tool({ id: "call_1", name: "lookup", result: { forecast: "sunny" } }),
          ],
        }),
      )

      expect(prepared.body).toEqual({
        model: "gpt-4.1-mini",
        input: [
          { role: "user", content: [{ type: "input_text", text: "What is the weather?" }] },
          { type: "function_call", call_id: "call_1", name: "lookup", arguments: '{"query":"weather"}' },
          { type: "function_call_output", call_id: "call_1", output: '{"forecast":"sunny"}' },
        ],
        store: false,
        include: ["reasoning.encrypted_content"],
        stream: true,
        max_output_tokens: undefined,
        temperature: undefined,
        tool_choice: undefined,
        tools: undefined,
        top_p: undefined,
      })
    }),
  )

  it.effect("preserves structured tool errors for the model", () =>
    Effect.gen(function* () {
      const error = {
        error: { type: "unknown", message: "Tool execution interrupted" },
        content: [],
        structured: {},
      }
      const prepared = yield* compileRequest(
        LLM.request({
          model,
          messages: [
            Message.assistant([ToolCallPart.make({ id: "call_1", name: "bash", input: { command: "sleep 10" } })]),
            Message.tool({
              id: "call_1",
              name: "bash",
              resultType: "error",
              result: error,
            }),
          ],
        }),
      )

      expect(expectToolOutput(prepared.body).output).toBe(ProviderShared.encodeJson(error))
    }),
  )

  it.effect("keeps primitive tool errors as plain text", () =>
    Effect.gen(function* () {
      const prepared = yield* compileRequest(
        LLM.request({
          model,
          messages: [
            Message.assistant([ToolCallPart.make({ id: "call_1", name: "bash", input: {} })]),
            Message.tool({ id: "call_1", name: "bash", resultType: "error", result: 503 }),
          ],
        }),
      )

      expect(expectToolOutput(prepared.body).output).toBe("503")
    }),
  )

  it.effect("keeps non-JSON tool errors as plain text", () =>
    Effect.gen(function* () {
      const prepared = yield* compileRequest(
        LLM.request({
          model,
          messages: [
            Message.assistant([ToolCallPart.make({ id: "call_1", name: "bash", input: {} })]),
            Message.tool({ id: "call_1", name: "bash", resultType: "error", result: new Error("boom") }),
          ],
        }),
      )

      expect(expectToolOutput(prepared.body).output).toBe("Error: boom")
    }),
  )

  // Regression: screenshot/read tool results must stay structured so base64
  // image data is not JSON-stringified into `function_call_output.output`.
  it.effect("lowers image tool-result content as structured input_image items", () =>
    Effect.gen(function* () {
      const prepared = yield* compileRequest(
        LLM.request({
          id: "req_tool_result_image",
          model,
          messages: [
            Message.user("Show me the screenshot."),
            Message.assistant([ToolCallPart.make({ id: "call_1", name: "read", input: { filePath: "shot.png" } })]),
            Message.tool({
              id: "call_1",
              name: "read",
              resultType: "content",
              result: [
                { type: "text", text: "Image read successfully" },
                { type: "file", uri: "data:image/png;base64,AAECAw==", mime: "image/png" },
              ],
            }),
          ],
        }),
      )

      expect(expectToolOutput(prepared.body).output).toEqual([
        { type: "input_text", text: "Image read successfully" },
        { type: "input_image", image_url: "data:image/png;base64,AAECAw==" },
      ])
    }),
  )

  it.effect("lowers single-image tool-result content as structured input_image array", () =>
    Effect.gen(function* () {
      const prepared = yield* compileRequest(
        LLM.request({
          id: "req_tool_result_image_only",
          model,
          messages: [
            Message.assistant([ToolCallPart.make({ id: "call_1", name: "screenshot", input: {} })]),
            Message.tool({
              id: "call_1",
              name: "screenshot",
              resultType: "content",
              result: [{ type: "file", uri: "data:image/png;base64,AAECAw==", mime: "image/png" }],
            }),
          ],
        }),
      )

      expect(expectToolOutput(prepared.body).output).toEqual([
        { type: "input_image", image_url: "data:image/png;base64,AAECAw==" },
      ])
    }),
  )

  it.effect("lowers PDF tool-result content as structured input_file array", () =>
    Effect.gen(function* () {
      const prepared = yield* compileRequest(
        LLM.request({
          id: "req_tool_result_pdf",
          model,
          messages: [
            Message.assistant([ToolCallPart.make({ id: "call_1", name: "read", input: {} })]),
            Message.tool({
              id: "call_1",
              name: "read",
              resultType: "content",
              result: [
                {
                  type: "file",
                  uri: "data:application/pdf;base64,JVBERi0xLjQ=",
                  mime: "application/pdf",
                  name: "report.pdf",
                },
              ],
            }),
          ],
        }),
      )

      expect(expectToolOutput(prepared.body).output).toEqual([
        {
          type: "input_file",
          filename: "report.pdf",
          file_data: "data:application/pdf;base64,JVBERi0xLjQ=",
        },
      ])
    }),
  )

  it.effect("passes large PDF tool-result content through", () =>
    Effect.gen(function* () {
      const base64 = "A".repeat(8_125_844)
      const dataUrl = `data:application/pdf;base64,${base64}`
      const prepared = yield* compileRequest(
        LLM.request({
          id: "req_tool_result_large_pdf",
          model,
          messages: [
            Message.assistant([ToolCallPart.make({ id: "call_1", name: "read", input: {} })]),
            Message.tool({
              id: "call_1",
              name: "read",
              resultType: "content",
              result: [{ type: "file", uri: dataUrl, mime: "application/pdf", name: "report.pdf" }],
            }),
          ],
        }),
      )

      expect(expectToolOutput(prepared.body).output).toEqual([
        { type: "input_file", filename: "report.pdf", file_data: dataUrl },
      ])
    }),
  )

  it.effect("uses standard inline file encoding for xAI PDF tool results", () =>
    Effect.gen(function* () {
      const prepared = yield* compileRequest(
        LLM.request({
          model: xaiModel,
          messages: [
            Message.assistant([ToolCallPart.make({ id: "call_1", name: "read", input: {} })]),
            Message.tool({
              id: "call_1",
              name: "read",
              resultType: "content",
              result: [
                {
                  type: "file",
                  uri: "data:application/pdf;base64,JVBERi0xLjQ=",
                  mime: "application/pdf",
                  name: "report.pdf",
                },
              ],
            }),
          ],
        }),
      )

      expect(expectToolOutput(prepared.body).output).toEqual([
        {
          type: "input_file",
          filename: "report.pdf",
          file_data: "data:application/pdf;base64,JVBERi0xLjQ=",
        },
      ])
    }),
  )

  it.effect("passes non-image tool-result content through as an input file", () =>
    Effect.gen(function* () {
      const prepared = yield* compileRequest(
        LLM.request({
          id: "req_tool_result_unsupported_media",
          model,
          messages: [
            Message.assistant([ToolCallPart.make({ id: "call_1", name: "fetch", input: {} })]),
            Message.tool({
              id: "call_1",
              name: "fetch",
              resultType: "content",
              result: [{ type: "file", uri: "data:audio/mpeg;base64,AAECAw==", mime: "audio/mpeg" }],
            }),
          ],
        }),
      )

      expect(expectToolOutput(prepared.body).output).toEqual([
        { type: "input_file", filename: "file", file_data: "data:audio/mpeg;base64,AAECAw==" },
      ])
    }),
  )

  it.effect("lowers remote tool-result media URLs without base64 wrapping", () =>
    Effect.gen(function* () {
      const prepared = yield* compileRequest(
        LLM.request({
          model,
          messages: [
            Message.assistant([ToolCallPart.make({ id: "call_1", name: "fetch", input: {} })]),
            Message.tool({
              id: "call_1",
              name: "fetch",
              resultType: "content",
              result: [
                { type: "file", uri: "https://example.com/image.png", mime: "image/png" },
                { type: "file", uri: "https://example.com/report.pdf", mime: "application/pdf", name: "report.pdf" },
              ],
            }),
          ],
        }),
      )

      expect(expectToolOutput(prepared.body).output).toEqual([
        { type: "input_image", image_url: "https://example.com/image.png" },
        { type: "input_file", filename: "report.pdf", file_url: "https://example.com/report.pdf" },
      ])
    }),
  )

  it.effect("lowers tool-result videos as input_video", () =>
    Effect.gen(function* () {
      const prepared = yield* compileRequest(
        LLM.request({
          model,
          messages: [
            Message.assistant([ToolCallPart.make({ id: "call_1", name: "record", input: {} })]),
            Message.tool({
              id: "call_1",
              name: "record",
              resultType: "content",
              result: [
                { type: "file", uri: "data:video/mp4;base64,AAECAw==", mime: "video/mp4" },
                { type: "file", uri: "https://example.com/demo.mp4", mime: "video/mp4" },
              ],
            }),
          ],
        }),
      )

      expect(expectToolOutput(prepared.body).output).toEqual([
        { type: "input_video", video_url: "data:video/mp4;base64,AAECAw==" },
        { type: "input_video", video_url: "https://example.com/demo.mp4" },
      ])
    }),
  )

  it.effect("prepares the composed native continuation request", () =>
    Effect.gen(function* () {
      const prepared = yield* compileRequest(
        continuationRequest({
          id: "req_native_continuation_openai",
          model,
          features: nativeOpenAIResponsesContinuation,
        }),
      )

      expect(prepared.body).toMatchObject({
        instructions: "You are concise. Continue from the provided history.",
        input: [
          {
            role: "user",
            content: [
              { type: "input_text", text: "What is shown here?" },
              { type: "input_image", image_url: "data:image/png;base64,AAECAw==" },
            ],
          },
          {
            type: "reasoning",
            encrypted_content: "encrypted-continuation-state",
            summary: [{ type: "summary_text", text: "I inspected the previous turn." }],
          },
          { role: "assistant", content: [{ type: "output_text", text: "It shows a small test image." }] },
          { role: "user", content: [{ type: "input_text", text: "Check the weather in Paris before continuing." }] },
          { type: "function_call", call_id: "call_weather_1", name: "get_weather", arguments: '{"city":"Paris"}' },
          { type: "function_call_output", call_id: "call_weather_1", output: '{"temperature":22}' },
          { role: "assistant", content: [{ type: "output_text", text: "Paris is 22 degrees." }] },
          {
            role: "user",
            content: [{ type: "input_text", text: "Continue from this conversation in one short sentence." }],
          },
        ],
        include: ["reasoning.encrypted_content"],
        store: false,
      })
      expect(prepared.body.tools).toEqual([expect.objectContaining({ type: "function", name: "get_weather" })])
    }),
  )

  it.effect("maps OpenAI provider options to Responses options", () =>
    Effect.gen(function* () {
      const prepared = yield* compileRequest(
        LLM.request({
          model: OpenAI.configure({ baseURL: "https://api.openai.test/v1/", apiKey: "test" }).model("gpt-5.2"),
          prompt: "think",
          promptCacheKey: "session_123",
          generation: { presencePenalty: 0.25, frequencyPenalty: -0.25 },
          tools: [
            ToolDefinition.make({ name: "read", description: "Read a file", inputSchema: { type: "object" } }),
            ToolDefinition.make({ name: "grep", description: "Search files", inputSchema: { type: "object" } }),
          ],
          toolChoice: "none",
          providerOptions: {
            reasoningEffort: "high",
            reasoningSummary: "auto",
            include: ["reasoning.encrypted_content"],
            metadata: { environment: "test", tenant: "acme" },
            safetyIdentifier: "user_123",
            streamOptions: { includeObfuscation: false },
            topLogprobs: 5,
            truncation: "disabled",
            allowedTools: { toolNames: ["read", "grep"], mode: "required" },
            maxToolCalls: 4,
            parallelToolCalls: false,
          },
        }),
      )

      expect(prepared.body.store).toBe(false)
      expect(prepared.body.prompt_cache_key).toBe("session_123")
      expect(prepared.body.include).toEqual(["reasoning.encrypted_content"])
      expect(prepared.body.reasoning).toEqual({ effort: "high", summary: "auto" })
      expect(prepared.body.text).toEqual({ verbosity: "low" })
      expect(prepared.body.metadata).toEqual({ environment: "test", tenant: "acme" })
      expect(prepared.body.safety_identifier).toBe("user_123")
      expect(prepared.body.stream_options).toEqual({ include_obfuscation: false })
      expect(prepared.body.top_logprobs).toBe(5)
      expect(prepared.body.presence_penalty).toBe(0.25)
      expect(prepared.body.frequency_penalty).toBe(-0.25)
      expect(prepared.body.truncation).toBe("disabled")
      expect(prepared.body.tool_choice).toEqual({
        type: "allowed_tools",
        mode: "required",
        tools: [
          { type: "function", name: "read" },
          { type: "function", name: "grep" },
        ],
      })
      expect(prepared.body.max_tool_calls).toBe(4)
      expect(prepared.body.parallel_tool_calls).toBe(false)
    }),
  )

  it.effect("accepts the full ResponseIncludable union", () =>
    Effect.gen(function* () {
      const prepared = yield* compileRequest(
        LLM.request({
          model,
          prompt: "hi",
          providerOptions: {
            include: ["reasoning.encrypted_content", "code_interpreter_call.outputs", "web_search_call.results"],
          },
        }),
      )

      expect(prepared.body.include).toEqual([
        "reasoning.encrypted_content",
        "code_interpreter_call.outputs",
        "web_search_call.results",
      ])
    }),
  )

  it.effect("passes forward-compatible includable values through", () =>
    Effect.gen(function* () {
      const prepared = yield* compileRequest(
        LLM.request({
          model,
          prompt: "hi",
          providerOptions: { include: ["reasoning.encrypted_content", "bogus.thing"] },
        }),
      )

      expect(prepared.body.include).toEqual(["reasoning.encrypted_content", "bogus.thing"])
    }),
  )

  it.effect("treats an explicit empty include as no include at all", () =>
    Effect.gen(function* () {
      const prepared = yield* compileRequest(LLM.request({ model, prompt: "hi", providerOptions: { include: [] } }))

      expect(prepared.body.include).toBeUndefined()
    }),
  )

  it.effect("passes an unknown includable value through", () =>
    Effect.gen(function* () {
      const prepared = yield* compileRequest(
        LLM.request({ model, prompt: "hi", providerOptions: { include: ["bogus.thing"] } }),
      )

      expect(prepared.body.include).toEqual(["bogus.thing"])
    }),
  )

  it.effect("requests encrypted reasoning by default", () =>
    Effect.gen(function* () {
      const prepared = yield* compileRequest(LLM.request({ model, prompt: "hi", providerOptions: { store: false } }))

      expect(prepared.body.include).toEqual(["reasoning.encrypted_content"])
    }),
  )

  it.effect("requests encrypted reasoning by default for GPT-5 reasoning models", () =>
    Effect.gen(function* () {
      // The native OpenAI facade configures GPT-5 stateless (store: false) with
      // reasoningSummary: "auto" by default. Without `include`, a follow-up
      // turn cannot replay reasoning state, so the facade also opts into
      // `reasoning.encrypted_content` automatically.
      const prepared = yield* compileRequest(
        LLM.request({
          model: OpenAI.configure({ baseURL: "https://api.openai.test/v1/", apiKey: "test" }).responses("gpt-5.2"),
          prompt: "hi",
        }),
      )

      expect(prepared.body.store).toBe(false)
      expect(prepared.body.include).toEqual(["reasoning.encrypted_content"])
      expect(prepared.body.reasoning).toEqual({ effort: "medium", summary: "auto" })
    }),
  )

  it.effect("lets callers opt out of the GPT-5 default include", () =>
    Effect.gen(function* () {
      const prepared = yield* compileRequest(
        LLM.request({
          model: OpenAI.configure({ baseURL: "https://api.openai.test/v1/", apiKey: "test" }).responses("gpt-5.2"),
          prompt: "hi",
          providerOptions: { include: [] },
        }),
      )

      expect(prepared.body.include).toBeUndefined()
    }),
  )

  it.effect("maps the request prompt cache key", () =>
    Effect.gen(function* () {
      const prepared = yield* compileRequest(
        LLM.request({
          model: OpenAI.configure({
            baseURL: "https://api.openai.test/v1/",
            apiKey: "test",
          }).model("gpt-4.1-mini"),
          prompt: "no cache",
          promptCacheKey: "request_cache",
        }),
      )

      expect(prepared.body.prompt_cache_key).toBe("request_cache")
    }),
  )

  it.effect("omits the prompt cache key when caching is disabled", () =>
    Effect.gen(function* () {
      const prepared = yield* compileRequest(
        LLM.request({
          model,
          prompt: "Hello",
          promptCacheKey: "request_cache",
          cache: "none",
        }),
      )

      expect(prepared.body).not.toHaveProperty("prompt_cache_key")
    }),
  )

  it.effect("parses text and usage stream fixtures", () =>
    Effect.gen(function* () {
      const body = sseEvents(
        { type: "response.output_item.added", item: { type: "message", id: "msg_1" } },
        { type: "response.output_text.delta", item_id: "msg_1", delta: "Hello" },
        { type: "response.output_text.delta", item_id: "msg_1", delta: "!" },
        {
          type: "response.completed",
          response: {
            id: "resp_1",
            service_tier: "default",
            usage: {
              input_tokens: 5,
              output_tokens: 2,
              total_tokens: 7,
              input_tokens_details: { cached_tokens: 1, cache_write_tokens: 2 },
              output_tokens_details: { reasoning_tokens: 0 },
            },
          },
        },
      )
      const response = yield* LLMClient.generate(request).pipe(Effect.provide(fixedResponse(body)))
      const usage = new Usage({
        inputTokens: 5,
        outputTokens: 2,
        nonCachedInputTokens: 2,
        cacheReadInputTokens: 1,
        cacheWriteInputTokens: 2,
        reasoningTokens: 0,
        totalTokens: 7,
        providerMetadata: {
          openai: {
            input_tokens: 5,
            output_tokens: 2,
            total_tokens: 7,
            input_tokens_details: { cached_tokens: 1, cache_write_tokens: 2 },
            output_tokens_details: { reasoning_tokens: 0 },
          },
        },
      })

      expect(response.text).toBe("Hello!")
      expect(response.events).toEqual([
        { type: "step-start", index: 0 },
        { type: "text-start", id: "msg_1", providerMetadata: { openai: { itemId: "msg_1" } } },
        { type: "text-delta", id: "msg_1", text: "Hello" },
        { type: "text-delta", id: "msg_1", text: "!" },
        { type: "text-end", id: "msg_1" },
        {
          type: "step-finish",
          index: 0,
          reason: { normalized: "stop", raw: undefined },
          providerMetadata: { openai: { responseId: "resp_1", serviceTier: "default" } },
          usage,
        },
        {
          type: "finish",
          reason: { normalized: "stop", raw: undefined },
          providerMetadata: { openai: { responseId: "resp_1", serviceTier: "default" } },
          usage,
        },
      ])
    }),
  )

  it.effect("preserves standard refusal content as ordinary assistant text", () =>
    Effect.gen(function* () {
      const response = yield* LLMClient.generate(request).pipe(
        Effect.provide(
          fixedResponse(
            sseEvents(
              {
                type: "response.output_item.added",
                output_index: 0,
                item: { type: "message", id: "msg_refusal", content: [] },
              },
              {
                type: "response.content_part.added",
                item_id: "msg_refusal",
                output_index: 0,
                content_index: 0,
                part: { type: "refusal", refusal: "" },
              },
              {
                type: "response.refusal.delta",
                item_id: "msg_refusal",
                output_index: 0,
                content_index: 0,
                delta: "I can't",
              },
              {
                type: "response.refusal.delta",
                item_id: "msg_refusal",
                output_index: 0,
                content_index: 0,
                delta: " help with that.",
              },
              {
                type: "response.refusal.done",
                item_id: "msg_refusal",
                output_index: 0,
                content_index: 0,
                refusal: "I can't help with that.",
              },
              {
                type: "response.content_part.done",
                item_id: "msg_refusal",
                output_index: 0,
                content_index: 0,
                part: { type: "refusal", refusal: "I can't help with that." },
              },
              {
                type: "response.output_item.done",
                output_index: 0,
                item: {
                  type: "message",
                  id: "msg_refusal",
                  phase: "final_answer",
                  content: [{ type: "refusal", refusal: "I can't help with that." }],
                },
              },
              { type: "response.completed", response: { id: "resp_1" } },
            ),
          ),
        ),
      )

      expect(response.text).toBe("I can't help with that.")
      expect(response.finishReason).toEqual({ normalized: "stop", raw: undefined })
      expect(response.message.content).toEqual([
        {
          type: "text",
          text: "I can't help with that.",
          providerMetadata: { openai: { itemId: "msg_refusal", phase: "final_answer" } },
        },
      ])

      const prepared = yield* compileRequest(LLM.request({ model, messages: [response.message] }))
      expect(prepared.body.input).toEqual([
        {
          type: "message",
          id: "msg_refusal",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "I can't help with that." }],
          phase: "final_answer",
        },
      ])
    }),
  )

  it.effect("rejects malformed refusal events", () =>
    Effect.gen(function* () {
      const events = [
        { type: "response.refusal.delta", output_index: 0, content_index: 0, delta: "missing item" },
        { type: "response.refusal.delta", item_id: "msg_1", output_index: 0, content_index: 0 },
        { type: "response.refusal.done", item_id: "msg_1", output_index: 0, content_index: 0 },
      ]
      for (const event of events) {
        const error = yield* LLMClient.generate(request).pipe(
          Effect.provide(fixedResponse(sseEvents(event))),
          Effect.flip,
        )
        expect(error.reason._tag).toBe("InvalidProviderOutput")
      }
    }),
  )

  it.effect("preserves and replays assistant message phases", () =>
    Effect.gen(function* () {
      const response = yield* LLMClient.generate(request).pipe(
        Effect.provide(
          fixedResponse(
            sseEvents(
              {
                type: "response.output_item.added",
                item: { type: "message", id: "msg_commentary" },
              },
              { type: "response.output_text.delta", item_id: "msg_commentary", delta: "Checking." },
              { type: "response.output_text.done", item_id: "msg_commentary" },
              {
                type: "response.output_item.done",
                item: { type: "message", id: "msg_commentary", phase: "commentary" },
              },
              {
                type: "response.output_item.added",
                item: { type: "message", id: "msg_final", phase: "final_answer" },
              },
              { type: "response.output_text.done", item_id: "msg_final", text: "Finished." },
              {
                type: "response.output_item.done",
                item: { type: "message", id: "msg_final", phase: "final_answer" },
              },
              { type: "response.output_item.added", item: { type: "message", id: "msg_null", phase: null } },
              { type: "response.output_text.delta", item_id: "msg_null", delta: "Unclassified." },
              { type: "response.output_item.done", item: { type: "message", id: "msg_null", phase: null } },
              { type: "response.completed", response: { id: "resp_1" } },
            ),
          ),
        ),
      )

      expect(response.message.content).toEqual([
        {
          type: "text",
          text: "Checking.",
          providerMetadata: { openai: { itemId: "msg_commentary", phase: "commentary" } },
        },
        {
          type: "text",
          text: "Finished.",
          providerMetadata: { openai: { itemId: "msg_final", phase: "final_answer" } },
        },
        {
          type: "text",
          text: "Unclassified.",
          providerMetadata: { openai: { itemId: "msg_null", phase: null } },
        },
      ])

      const prepared = yield* compileRequest(LLM.request({ model, messages: [response.message] }))
      expect(prepared.body.input).toEqual([
        {
          type: "message",
          id: "msg_commentary",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "Checking." }],
          phase: "commentary",
        },
        {
          type: "message",
          id: "msg_final",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "Finished." }],
          phase: "final_answer",
        },
        {
          type: "message",
          id: "msg_null",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "Unclassified." }],
          phase: null,
        },
      ])
    }),
  )

  it.effect("routes assistant text by output index when its item id disagrees", () =>
    Effect.gen(function* () {
      const response = yield* LLMClient.generate(request).pipe(
        Effect.provide(
          fixedResponse(
            sseEvents(
              { type: "response.output_item.added", output_index: 2, item: { type: "message", id: "msg_1" } },
              { type: "response.output_text.delta", output_index: 2, item_id: "wrong_message", delta: "Indexed" },
              { type: "response.output_item.done", output_index: 2, item: { type: "message", id: "msg_1" } },
              { type: "response.completed", response: { id: "resp_1" } },
            ),
          ),
        ),
      )

      expect(response.text).toBe("Indexed")
      expect(response.message.content).toEqual([
        { type: "text", text: "Indexed", providerMetadata: { openai: { itemId: "msg_1" } } },
      ])
    }),
  )

  it.effect("routes interleaved function calls by output index", () =>
    Effect.gen(function* () {
      const first = { type: "function_call", id: "fc_1", call_id: "call_1", name: "first", arguments: "" }
      const second = { type: "function_call", id: "fc_2", call_id: "call_2", name: "second", arguments: "" }
      const response = yield* LLMClient.generate(request).pipe(
        Effect.provide(
          fixedResponse(
            sseEvents(
              { type: "response.output_item.added", output_index: 1, item: first },
              { type: "response.output_item.added", output_index: 3, item: second },
              { type: "response.function_call_arguments.delta", output_index: 1, item_id: "fc_2", delta: '{"a":' },
              { type: "response.function_call_arguments.delta", output_index: 3, item_id: "fc_1", delta: '{"b":' },
              {
                type: "response.function_call_arguments.done",
                output_index: 3,
                item_id: "fc_1",
                arguments: '{"b":2}',
              },
              {
                type: "response.function_call_arguments.done",
                output_index: 1,
                item_id: "fc_2",
                arguments: '{"a":1}',
              },
              { type: "response.output_item.done", output_index: 1, item: { ...first, arguments: '{"a":1}' } },
              { type: "response.output_item.done", output_index: 3, item: { ...second, arguments: '{"b":2}' } },
              { type: "response.completed", response: { id: "resp_1" } },
            ),
          ),
        ),
      )

      expect(response.events.filter((event) => event.type === "tool-input-delta")).toMatchObject([
        { id: "call_1", text: '{"a":' },
        { id: "call_2", text: '{"b":' },
        { id: "call_2", text: "2}" },
        { id: "call_1", text: "1}" },
      ])
      expect(response.events.filter(LLMEvent.is.toolCall)).toEqual([
        expect.objectContaining({ id: "call_1", name: "first", input: { a: 1 } }),
        expect.objectContaining({ id: "call_2", name: "second", input: { b: 2 } }),
      ])
    }),
  )

  it.effect("preserves tool namespaces through streaming and history replay", () =>
    Effect.gen(function* () {
      const item = {
        type: "function_call",
        id: "fc_1",
        call_id: "call_1",
        namespace: "crm",
        name: "lookup",
        arguments: "",
      }
      const response = yield* LLMClient.generate(request).pipe(
        Effect.provide(
          fixedResponse(
            sseEvents(
              { type: "response.output_item.added", output_index: 0, item },
              {
                type: "response.function_call_arguments.delta",
                output_index: 0,
                item_id: "fc_1",
                delta: '{"id":"123"}',
              },
              {
                type: "response.output_item.done",
                output_index: 0,
                item: { ...item, arguments: '{"id":"123"}' },
              },
              { type: "response.completed", response: { id: "resp_1" } },
            ),
          ),
        ),
      )

      const toolEvents = response.events.filter((event) => event.type.startsWith("tool-"))
      expect(toolEvents).toEqual([
        expect.objectContaining({ type: "tool-input-start", name: "lookup", namespace: "crm" }),
        expect.objectContaining({ type: "tool-input-delta", name: "lookup", namespace: "crm" }),
        expect.objectContaining({ type: "tool-input-end", name: "lookup", namespace: "crm" }),
        expect.objectContaining({ type: "tool-call", name: "lookup", namespace: "crm", input: { id: "123" } }),
      ])
      expect(response.message.content).toEqual([
        expect.objectContaining({ type: "tool-call", name: "lookup", namespace: "crm", input: { id: "123" } }),
      ])

      const prepared = yield* compileRequest(
        LLM.request({
          model,
          messages: [
            response.message,
            Message.tool({ id: "call_1", name: "lookup", namespace: "crm", result: { customer: "Ada" } }),
          ],
        }),
      )
      expect(prepared.body.input).toEqual([
        {
          type: "function_call",
          id: "fc_1",
          call_id: "call_1",
          namespace: "crm",
          name: "lookup",
          arguments: '{"id":"123"}',
        },
        { type: "function_call_output", call_id: "call_1", output: '{"customer":"Ada"}' },
      ])
    }),
  )
  it.effect("routes reasoning summary events by output index", () =>
    Effect.gen(function* () {
      const response = yield* LLMClient.generate(request).pipe(
        Effect.provide(
          fixedResponse(
            sseEvents(
              {
                type: "response.output_item.added",
                output_index: 4,
                item: { type: "reasoning", id: "rs_1" },
              },
              {
                type: "response.reasoning_summary_part.added",
                output_index: 4,
                item_id: "wrong_reasoning",
                summary_index: 0,
              },
              {
                type: "response.reasoning_summary_text.delta",
                output_index: 4,
                item_id: "wrong_reasoning",
                summary_index: 0,
                delta: "Thinking",
              },
              {
                type: "response.reasoning_summary_part.done",
                output_index: 4,
                item_id: "wrong_reasoning",
                summary_index: 0,
              },
              {
                type: "response.output_item.done",
                output_index: 4,
                item: { type: "reasoning", id: "rs_1", encrypted_content: "state" },
              },
              { type: "response.completed", response: { id: "resp_1" } },
            ),
          ),
        ),
      )

      expect(response.reasoning).toBe("Thinking")
      expect(response.message.content).toEqual([
        {
          type: "reasoning",
          text: "Thinking",
          providerMetadata: { openai: { itemId: "rs_1", reasoningEncryptedContent: "state" } },
        },
      ])
    }),
  )

  it.effect("routes native reasoning text deltas by output index", () =>
    Effect.gen(function* () {
      const response = yield* LLMClient.generate(request).pipe(
        Effect.provide(
          fixedResponse(
            sseEvents(
              { type: "response.output_item.added", output_index: 1, item: { type: "reasoning", id: "rs_1" } },
              { type: "response.reasoning_text.delta", output_index: 1, item_id: "wrong_reasoning", delta: "Raw" },
              { type: "response.output_item.done", output_index: 1, item: { type: "reasoning", id: "rs_1" } },
              { type: "response.completed", response: { id: "resp_1" } },
            ),
          ),
        ),
      )

      expect(response.reasoning).toBe("Raw")
    }),
  )

  it.effect("accepts empty IDs for native reasoning text deltas", () =>
    Effect.gen(function* () {
      const response = yield* LLMClient.generate(request).pipe(
        Effect.provide(
          fixedResponse(
            sseEvents(
              { type: "response.output_item.added", output_index: 1, item: { type: "reasoning", id: "" } },
              { type: "response.reasoning_text.delta", output_index: 1, item_id: "", delta: "Raw" },
              {
                type: "response.output_item.done",
                output_index: 1,
                item: { type: "reasoning", id: "", encrypted_content: "state" },
              },
              { type: "response.completed", response: { id: "resp_1" } },
            ),
          ),
        ),
      )

      expect(response.message.content).toEqual([
        {
          type: "reasoning",
          text: "Raw",
          providerMetadata: { openai: { itemId: "", reasoningEncryptedContent: "state" } },
        },
      ])
    }),
  )

  it.effect("falls back to item ids when an output index was not registered", () =>
    Effect.gen(function* () {
      const response = yield* LLMClient.generate(request).pipe(
        Effect.provide(
          fixedResponse(
            sseEvents(
              { type: "response.output_item.added", item: { type: "message", id: "msg_1" } },
              { type: "response.output_text.delta", output_index: 9, item_id: "msg_1", delta: "Fallback" },
              { type: "response.output_item.done", item: { type: "message", id: "msg_1" } },
              { type: "response.completed", response: { id: "resp_1" } },
            ),
          ),
        ),
      )

      expect(response.text).toBe("Fallback")
    }),
  )

  it.effect("rejects output text events without the spec-required item id", () =>
    Effect.gen(function* () {
      const error = yield* LLMClient.generate(request).pipe(
        Effect.provide(
          fixedResponse(
            sseEvents(
              { type: "response.output_text.delta", delta: "orphaned" },
              { type: "response.completed", response: { id: "resp_1" } },
            ),
          ),
        ),
        Effect.flip,
      )

      expect(error.reason._tag).toBe("InvalidProviderOutput")
      expect(error.message).toContain("response.output_text.delta is missing item_id")
    }),
  )

  it.effect("requires item ids even when their output index is known", () =>
    Effect.gen(function* () {
      const error = yield* LLMClient.generate(request).pipe(
        Effect.provide(
          fixedResponse(
            sseEvents(
              { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_1" } },
              { type: "response.output_text.delta", output_index: 0, delta: "Missing item ID" },
            ),
          ),
        ),
        Effect.flip,
      )

      expect(error.reason._tag).toBe("InvalidProviderOutput")
      expect(error.message).toContain("response.output_text.delta is missing item_id")
    }),
  )

  it.effect("ignores deltas without a matching output item", () =>
    Effect.gen(function* () {
      const response = yield* LLMClient.generate(request).pipe(
        Effect.provide(
          fixedResponse(
            sseEvents(
              { type: "response.output_text.delta", item_id: "msg_missing", delta: "orphaned text" },
              { type: "response.refusal.delta", item_id: "refusal_missing", delta: "orphaned refusal" },
              {
                type: "response.reasoning_summary_text.delta",
                item_id: "rs_missing",
                summary_index: 0,
                delta: "orphaned reasoning",
              },
              {
                type: "response.reasoning_summary_part.added",
                item_id: "rs_still_missing",
                summary_index: 0,
              },
              {
                type: "response.reasoning_summary_text.delta",
                item_id: "rs_still_missing",
                summary_index: 0,
                delta: "still orphaned reasoning",
              },
              {
                type: "response.function_call_arguments.delta",
                item_id: "fc_missing",
                delta: '{"orphaned":true}',
              },
              {
                type: "response.function_call_arguments.done",
                item_id: "fc_missing",
                arguments: '{"orphaned":true}',
              },
              { type: "response.completed", response: { id: "resp_1" } },
            ),
          ),
        ),
      )

      expect(response.text).toBe("")
      expect(response.message.content).toEqual([])
      expect(response.events.some(LLMEvent.is.toolCall)).toBeFalse()
    }),
  )

  it.effect("rejects function argument events without the spec-required item id", () =>
    Effect.gen(function* () {
      const events = [
        { type: "response.function_call_arguments.delta", output_index: 0, delta: "{}" },
        { type: "response.function_call_arguments.done", output_index: 0, arguments: "{}" },
      ]

      for (const event of events) {
        const error = yield* LLMClient.generate(request).pipe(
          Effect.provide(
            fixedResponse(
              sseEvents(
                {
                  type: "response.output_item.added",
                  output_index: 0,
                  item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "lookup", arguments: "" },
                },
                event,
                { type: "response.completed", response: { id: "resp_1" } },
              ),
            ),
          ),
          Effect.flip,
        )

        expect(error.reason._tag).toBe("InvalidProviderOutput")
        expect(error.message).toContain(`${event.type} is missing item_id`)
      }
    }),
  )

  it.effect("rejects reasoning events without the spec-required item id", () =>
    Effect.gen(function* () {
      const events = [
        { type: "response.reasoning_summary_part.added", summary_index: 0 },
        { type: "response.reasoning_summary_part.done", summary_index: 0 },
        { type: "response.reasoning_text.done" },
      ]

      for (const event of events) {
        const error = yield* LLMClient.generate(request).pipe(
          Effect.provide(fixedResponse(sseEvents(event, { type: "response.completed", response: { id: "resp_1" } }))),
          Effect.flip,
        )
        expect(error.reason._tag).toBe("InvalidProviderOutput")
        expect(error.message).toContain(`${event.type} is missing item_id`)
      }
    }),
  )

  it.effect("maps incomplete response reasons", () =>
    Effect.gen(function* () {
      const generate = (incompleteDetails: object) =>
        LLMClient.generate(request).pipe(
          Effect.provide(
            fixedResponse(
              sseEvents({
                type: "response.incomplete",
                response: { id: "resp_incomplete", incomplete_details: incompleteDetails },
              }),
            ),
          ),
        )

      const length = yield* generate({ reason: "max_output_tokens" })
      const contentFilter = yield* generate({ reason: "content_filter" })
      const unknown = yield* generate({})
      const custom = yield* generate({ reason: "provider_limit" })

      expect([length.finishReason, contentFilter.finishReason, unknown.finishReason, custom.finishReason]).toEqual([
        { normalized: "length", raw: "max_output_tokens" },
        { normalized: "content-filter", raw: "content_filter" },
        { normalized: "unknown", raw: undefined },
        { normalized: "unknown", raw: "provider_limit" },
      ])
    }),
  )

  // OpenAI's documented stream orders output text within one message item; no
  // provider-valid same-kind overlap is evidenced, so done boundaries close it.
  it.effect("closes sequential output messages before starting the next", () =>
    Effect.gen(function* () {
      const response = yield* LLMClient.generate(request).pipe(
        Effect.provide(
          fixedResponse(
            sseEvents(
              { type: "response.output_item.added", item: { type: "message", id: "msg_1" } },
              { type: "response.output_text.delta", item_id: "msg_1", delta: "First" },
              { type: "response.output_item.done", item: { type: "message", id: "msg_1" } },
              { type: "response.output_item.added", item: { type: "message", id: "msg_2" } },
              { type: "response.output_text.delta", item_id: "msg_2", delta: "Second" },
              { type: "response.output_item.done", item: { type: "message", id: "msg_2" } },
              { type: "response.completed", response: { id: "resp_1" } },
            ),
          ),
        ),
      )

      expect(response.events.filter((event) => event.type.startsWith("text-"))).toEqual([
        { type: "text-start", id: "msg_1", providerMetadata: { openai: { itemId: "msg_1" } } },
        { type: "text-delta", id: "msg_1", text: "First", providerMetadata: undefined },
        { type: "text-end", id: "msg_1", providerMetadata: { openai: { itemId: "msg_1" } } },
        { type: "text-start", id: "msg_2", providerMetadata: { openai: { itemId: "msg_2" } } },
        { type: "text-delta", id: "msg_2", text: "Second", providerMetadata: undefined },
        { type: "text-end", id: "msg_2", providerMetadata: { openai: { itemId: "msg_2" } } },
      ])
    }),
  )

  it.effect("parses reasoning summary stream fixtures", () =>
    Effect.gen(function* () {
      const body = sseEvents(
        { type: "response.output_item.added", item: { type: "reasoning", id: "rs_1" } },
        { type: "response.reasoning_summary_text.delta", item_id: "rs_1", delta: "thinking" },
        { type: "response.output_item.added", item: { type: "message", id: "msg_1" } },
        { type: "response.output_text.delta", item_id: "msg_1", delta: "Hello" },
        { type: "response.reasoning_summary_text.done", item_id: "rs_1" },
        { type: "response.completed", response: { id: "resp_1" } },
      )

      const response = yield* LLMClient.generate(request).pipe(Effect.provide(fixedResponse(body)))

      expect(response.reasoning).toBe("thinking")
      expect(response.text).toBe("Hello")
      expect(response.events).toMatchObject([
        { type: "step-start", index: 0 },
        { type: "reasoning-start", id: "rs_1:0" },
        { type: "reasoning-delta", id: "rs_1:0", text: "thinking" },
        { type: "text-start", id: "msg_1" },
        { type: "text-delta", id: "msg_1", text: "Hello" },
        { type: "reasoning-end", id: "rs_1:0" },
        { type: "text-end", id: "msg_1" },
        { type: "step-finish", index: 0, reason: { normalized: "stop", raw: undefined } },
        { type: "finish", reason: { normalized: "stop", raw: undefined } },
      ])
      expect(response.events.filter((event) => event.type === "finish")).toHaveLength(1)
      expect(response.message.content).toEqual([
        {
          type: "reasoning",
          text: "thinking",
          providerMetadata: { openai: { itemId: "rs_1", reasoningEncryptedContent: null } },
        },
        { type: "text", text: "Hello", providerMetadata: { openai: { itemId: "msg_1" } } },
      ])
    }),
  )

  it.effect("preserves encrypted reasoning metadata for continuation", () =>
    Effect.gen(function* () {
      const response = yield* LLMClient.generate(request).pipe(
        Effect.provide(
          fixedResponse(
            sseEvents(
              { type: "response.output_item.added", item: { type: "reasoning", id: "rs_1" } },
              { type: "response.reasoning_summary_text.delta", item_id: "rs_1", delta: "thinking" },
              {
                type: "response.output_item.done",
                item: {
                  type: "reasoning",
                  id: "rs_1",
                  encrypted_content: "encrypted-state",
                  summary: [{ type: "summary_text", text: "thinking" }],
                },
              },
              { type: "response.completed", response: { id: "resp_1" } },
            ),
          ),
        ),
      )

      expect(response.events).toContainEqual(
        expect.objectContaining({
          type: "reasoning-end",
          id: "rs_1:0",
          providerMetadata: { openai: { itemId: "rs_1", reasoningEncryptedContent: "encrypted-state" } },
        }),
      )
    }),
  )

  it.effect("ignores terminal reasoning output when item completion is missing", () =>
    Effect.gen(function* () {
      const response = yield* LLMClient.generate(
        LLMRequest.update(request, { providerOptions: { store: false } }),
      ).pipe(
        Effect.provide(
          fixedResponse(
            sseEvents(
              {
                type: "response.output_item.added",
                item: { type: "reasoning", id: "rs_1", encrypted_content: null },
              },
              { type: "response.reasoning_summary_part.added", item_id: "rs_1", summary_index: 0 },
              {
                type: "response.reasoning_summary_text.delta",
                item_id: "rs_1",
                summary_index: 0,
                delta: "Checked the diff.",
              },
              { type: "response.reasoning_summary_part.done", item_id: "rs_1", summary_index: 0 },
              {
                type: "response.completed",
                response: {
                  id: "resp_1",
                  output: [
                    {
                      type: "reasoning",
                      id: "rs_1",
                      encrypted_content: "terminal-state",
                      summary: [{ type: "summary_text", text: "Checked the diff." }],
                    },
                  ],
                },
              },
            ),
          ),
        ),
      )

      expect(response.reasoning).toBe("Checked the diff.")
      expect(response.events.filter((event) => event.type === "reasoning-end")).toEqual([
        { type: "reasoning-end", id: "rs_1:0" },
      ])
      expect(response.message.content).toContainEqual({
        type: "reasoning",
        text: "Checked the diff.",
        providerMetadata: { openai: { itemId: "rs_1", reasoningEncryptedContent: null } },
      })
    }),
  )

  it.effect("does not repeat reasoning already finalized by an output item", () =>
    Effect.gen(function* () {
      const item = { type: "reasoning", id: "rs_1", encrypted_content: "encrypted-state" }
      const response = yield* LLMClient.generate(request).pipe(
        Effect.provide(
          fixedResponse(
            sseEvents(
              { type: "response.output_item.added", item: { ...item, encrypted_content: null } },
              { type: "response.reasoning_summary_text.delta", item_id: "rs_1", delta: "Thinking" },
              { type: "response.output_item.done", item },
              { type: "response.completed", response: { output: [item] } },
            ),
          ),
        ),
      )

      expect(response.events.filter((event) => event.type === "reasoning-start")).toHaveLength(1)
      expect(response.events.filter((event) => event.type === "reasoning-end")).toHaveLength(1)
      expect(response.message.content.filter((part) => part.type === "reasoning")).toHaveLength(1)
      expect(response.reasoning).toBe("Thinking")
    }),
  )

  it.effect("recovers pending function calls without reconciling terminal reasoning", () =>
    Effect.gen(function* () {
      const response = yield* LLMClient.generate(
        LLMRequest.update(request, { providerOptions: { store: false } }),
      ).pipe(
        Effect.provide(
          fixedResponse(
            sseEvents(
              {
                type: "response.output_item.added",
                item: { type: "reasoning", id: "rs_1", encrypted_content: null },
              },
              { type: "response.reasoning_summary_text.delta", item_id: "rs_1", delta: "Thinking" },
              {
                type: "response.output_item.added",
                item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "lookup", arguments: "" },
              },
              { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '{"query":"wea' },
              {
                type: "response.completed",
                response: {
                  output: [
                    { type: "reasoning", id: "rs_1", encrypted_content: "terminal-state" },
                    {
                      type: "function_call",
                      id: "fc_1",
                      call_id: "call_1",
                      name: "lookup",
                      arguments: '{"query":"weather"}',
                    },
                  ],
                },
              },
            ),
          ),
        ),
      )

      expect(response.events.find((event) => event.type === "reasoning-end")).toEqual({
        type: "reasoning-end",
        id: "rs_1:0",
      })
      expect(response.events.filter(LLMEvent.is.toolCall)).toEqual([
        expect.objectContaining({ id: "call_1", input: { query: "weather" } }),
      ])
      expect(response.events.findIndex(LLMEvent.is.toolCall)).toBeLessThan(
        response.events.findIndex((event) => event.type === "reasoning-end"),
      )
      expect(response.finishReason.normalized).toBe("tool-calls")
    }),
  )

  it.effect("streams each reasoning summary part as a separate block", () =>
    Effect.gen(function* () {
      const response = yield* LLMClient.generate(
        LLMRequest.update(request, { providerOptions: { store: false } }),
      ).pipe(
        Effect.provide(
          fixedResponse(
            sseEvents(
              {
                type: "response.output_item.added",
                item: { type: "reasoning", id: "rs_1", encrypted_content: null },
              },
              { type: "response.reasoning_summary_part.added", item_id: "rs_1", summary_index: 0 },
              { type: "response.reasoning_summary_text.delta", item_id: "rs_1", summary_index: 0, delta: "First" },
              { type: "response.reasoning_summary_part.done", item_id: "rs_1", summary_index: 0 },
              { type: "response.reasoning_summary_part.added", item_id: "rs_1", summary_index: 1 },
              { type: "response.reasoning_summary_text.delta", item_id: "rs_1", summary_index: 1, delta: "Second" },
              { type: "response.reasoning_summary_part.done", item_id: "rs_1", summary_index: 1 },
              {
                type: "response.output_item.done",
                item: { type: "reasoning", id: "rs_1", encrypted_content: "encrypted-state" },
              },
              { type: "response.completed", response: { id: "resp_1" } },
            ),
          ),
        ),
      )

      expect(response.reasoning).toBe("FirstSecond")
      expect(response.events).toMatchObject([
        { type: "step-start", index: 0 },
        {
          type: "reasoning-start",
          id: "rs_1:0",
          providerMetadata: { openai: { itemId: "rs_1", reasoningEncryptedContent: null } },
        },
        { type: "reasoning-delta", id: "rs_1:0", text: "First" },
        { type: "reasoning-end", id: "rs_1:0", providerMetadata: { openai: { itemId: "rs_1" } } },
        {
          type: "reasoning-start",
          id: "rs_1:1",
          providerMetadata: { openai: { itemId: "rs_1", reasoningEncryptedContent: null } },
        },
        { type: "reasoning-delta", id: "rs_1:1", text: "Second" },
        {
          type: "reasoning-end",
          id: "rs_1:1",
          providerMetadata: { openai: { itemId: "rs_1", reasoningEncryptedContent: "encrypted-state" } },
        },
        { type: "step-finish", index: 0, reason: { normalized: "stop", raw: undefined } },
        { type: "finish", reason: { normalized: "stop", raw: undefined } },
      ])
    }),
  )

  it.effect("concludes reasoning at implicit summary boundaries", () =>
    Effect.gen(function* () {
      const response = yield* LLMClient.generate(
        LLMRequest.update(request, { providerOptions: { store: false } }),
      ).pipe(
        Effect.provide(
          fixedResponse(
            sseEvents(
              {
                type: "response.output_item.added",
                item: { type: "reasoning", id: "rs_1", encrypted_content: null },
              },
              { type: "response.reasoning_summary_part.added", item_id: "rs_1", summary_index: 0 },
              { type: "response.reasoning_summary_text.delta", item_id: "rs_1", summary_index: 0, delta: "First" },
              // The next part is enough to conclude the previous one even when
              // its done event is delayed.
              { type: "response.reasoning_summary_part.added", item_id: "rs_1", summary_index: 1 },
              { type: "response.reasoning_summary_part.done", item_id: "rs_1", summary_index: 0 },
              { type: "response.reasoning_summary_text.delta", item_id: "rs_1", summary_index: 1, delta: "Second" },
              { type: "response.reasoning_summary_part.done", item_id: "rs_1", summary_index: 1 },
              // Some compatible providers begin the next part with its first delta.
              { type: "response.reasoning_summary_text.delta", item_id: "rs_1", summary_index: 2, delta: "Third" },
              {
                type: "response.output_item.done",
                item: { type: "reasoning", id: "rs_1", encrypted_content: "encrypted-state" },
              },
              { type: "response.completed", response: { id: "resp_1" } },
            ),
          ),
        ),
      )

      expect(response.reasoning).toBe("FirstSecondThird")
      expect(response.events.filter((event) => event.type.startsWith("reasoning-"))).toEqual([
        {
          type: "reasoning-start",
          id: "rs_1:0",
          providerMetadata: { openai: { itemId: "rs_1", reasoningEncryptedContent: null } },
        },
        { type: "reasoning-delta", id: "rs_1:0", text: "First", providerMetadata: undefined },
        { type: "reasoning-end", id: "rs_1:0", providerMetadata: { openai: { itemId: "rs_1" } } },
        {
          type: "reasoning-start",
          id: "rs_1:1",
          providerMetadata: { openai: { itemId: "rs_1", reasoningEncryptedContent: null } },
        },
        { type: "reasoning-delta", id: "rs_1:1", text: "Second", providerMetadata: undefined },
        {
          type: "reasoning-end",
          id: "rs_1:1",
          providerMetadata: { openai: { itemId: "rs_1" } },
        },
        {
          type: "reasoning-start",
          id: "rs_1:2",
          providerMetadata: { openai: { itemId: "rs_1", reasoningEncryptedContent: null } },
        },
        { type: "reasoning-delta", id: "rs_1:2", text: "Third", providerMetadata: undefined },
        {
          type: "reasoning-end",
          id: "rs_1:2",
          providerMetadata: { openai: { itemId: "rs_1", reasoningEncryptedContent: "encrypted-state" } },
        },
      ])
    }),
  )

  it.effect("rejects a reasoning item that starts before the previous item ends", () =>
    Effect.gen(function* () {
      const error = yield* LLMClient.generate(request).pipe(
        Effect.provide(
          fixedResponse(
            sseEvents(
              { type: "response.output_item.added", item: { type: "reasoning", id: "rs_1" } },
              { type: "response.reasoning_summary_text.delta", item_id: "rs_1", summary_index: 0, delta: "First" },
              { type: "response.output_item.added", item: { type: "reasoning", id: "rs_2" } },
            ),
          ),
        ),
        Effect.flip,
      )

      expect(error.reason._tag).toBe("InvalidProviderOutput")
      expect(error.message).toContain("started reasoning before the previous item ended")
    }),
  )

  it.effect("concludes text at implicit message boundaries", () =>
    Effect.gen(function* () {
      const response = yield* LLMClient.generate(request).pipe(
        Effect.provide(
          fixedResponse(
            sseEvents(
              // An item that never streams text is untracked at the boundary too.
              { type: "response.output_item.added", item: { type: "message", id: "msg_0" } },
              { type: "response.output_item.added", item: { type: "message", id: "msg_1" } },
              { type: "response.output_text.delta", item_id: "msg_1", delta: "First" },
              // The previous message's done event is missing; the next message
              // item is the boundary for its open text.
              { type: "response.output_item.added", item: { type: "message", id: "msg_2" } },
              // Late deltas for concluded or untracked messages must stay no-ops.
              { type: "response.output_text.delta", item_id: "msg_1", delta: " late" },
              { type: "response.output_text.delta", item_id: "msg_0", delta: " stale" },
              { type: "response.output_text.delta", item_id: "msg_2", delta: "Second" },
              { type: "response.output_item.done", item: { type: "message", id: "msg_2" } },
              { type: "response.completed", response: { id: "resp_1" } },
            ),
          ),
        ),
      )

      expect(response.text).toBe("FirstSecond")
      expect(response.events.filter((event) => event.type.startsWith("text-"))).toMatchObject([
        { type: "text-start", id: "msg_1" },
        { type: "text-delta", id: "msg_1", text: "First" },
        { type: "text-end", id: "msg_1" },
        { type: "text-start", id: "msg_2" },
        { type: "text-delta", id: "msg_2", text: "Second" },
        { type: "text-end", id: "msg_2" },
      ])
    }),
  )

  it.effect("opens the tool lifecycle for a done-only function call", () =>
    Effect.gen(function* () {
      const response = yield* LLMClient.generate(request).pipe(
        Effect.provide(
          fixedResponse(
            sseEvents(
              // No output_item.added: the call arrives only as a completed item.
              {
                type: "response.output_item.done",
                item: {
                  type: "function_call",
                  id: "fc_1",
                  call_id: "call_1",
                  name: "lookup",
                  arguments: '{"query":"weather"}',
                },
              },
              { type: "response.completed", response: { id: "resp_1" } },
            ),
          ),
        ),
      )

      expect(response.events.filter((event) => event.type.startsWith("tool-"))).toMatchObject([
        { type: "tool-input-start", id: "call_1", name: "lookup" },
        { type: "tool-input-end", id: "call_1", name: "lookup" },
        { type: "tool-call", id: "call_1", name: "lookup", input: { query: "weather" } },
      ])
      expect(response.finishReason.normalized).toBe("tool-calls")
    }),
  )

  it.effect("ignores duplicate item start events", () =>
    Effect.gen(function* () {
      const response = yield* LLMClient.generate(request).pipe(
        Effect.provide(
          fixedResponse(
            sseEvents(
              { type: "response.output_item.added", item: { type: "reasoning", id: "rs_1" } },
              // Duplicate added for a known item is not overlap and must no-op.
              { type: "response.output_item.added", item: { type: "reasoning", id: "rs_1" } },
              { type: "response.reasoning_summary_text.delta", item_id: "rs_1", summary_index: 0, delta: "Think" },
              { type: "response.output_item.done", item: { type: "reasoning", id: "rs_1" } },
              {
                type: "response.output_item.added",
                item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "lookup", arguments: "" },
              },
              {
                type: "response.output_item.added",
                item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "lookup", arguments: "" },
              },
              { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '{"query":"weather"}' },
              {
                type: "response.output_item.done",
                item: {
                  type: "function_call",
                  id: "fc_1",
                  call_id: "call_1",
                  name: "lookup",
                  arguments: '{"query":"weather"}',
                },
              },
              { type: "response.completed", response: { id: "resp_1" } },
            ),
          ),
        ),
      )

      expect(response.reasoning).toBe("Think")
      expect(response.events.filter((event) => event.type === "reasoning-start")).toHaveLength(1)
      expect(response.events.filter((event) => event.type === "reasoning-end")).toHaveLength(1)
      expect(response.events.filter((event) => event.type === "tool-input-start")).toHaveLength(1)
      expect(response.events.filter(LLMEvent.is.toolCall)).toEqual([
        expect.objectContaining({ id: "call_1", input: { query: "weather" } }),
      ])
    }),
  )

  it.effect("reconciles reasoning summaries that arrive only as finals", () =>
    Effect.gen(function* () {
      const response = yield* LLMClient.generate(
        LLMRequest.update(request, { providerOptions: { store: false } }),
      ).pipe(
        Effect.provide(
          fixedResponse(
            sseEvents(
              {
                type: "response.output_item.added",
                item: { type: "reasoning", id: "rs_1", encrypted_content: null },
              },
              { type: "response.reasoning_summary_part.added", item_id: "rs_1", summary_index: 0 },
              // No `.delta` events at all: the gateway sends the complete
              // summary text in the `.done` final.
              {
                type: "response.reasoning_summary_text.done",
                item_id: "rs_1",
                summary_index: 0,
                text: "Checked the diff.",
              },
              { type: "response.reasoning_summary_part.done", item_id: "rs_1", summary_index: 0 },
              {
                type: "response.output_item.done",
                item: {
                  type: "reasoning",
                  id: "rs_1",
                  summary: [{ type: "summary_text", text: "Checked the diff." }],
                  encrypted_content: "encrypted-state",
                },
              },
              { type: "response.completed", response: { id: "resp_1" } },
            ),
          ),
        ),
      )

      expect(response.reasoning).toBe("Checked the diff.")
      expect(response.events.filter((event) => event.type.startsWith("reasoning-"))).toEqual([
        {
          type: "reasoning-start",
          id: "rs_1:0",
          providerMetadata: { openai: { itemId: "rs_1", reasoningEncryptedContent: null } },
        },
        { type: "reasoning-delta", id: "rs_1:0", text: "Checked the diff.", providerMetadata: undefined },
        {
          type: "reasoning-end",
          id: "rs_1:0",
          text: "Checked the diff.",
          providerMetadata: { openai: { itemId: "rs_1", reasoningEncryptedContent: "encrypted-state" } },
        },
      ])

      const prepared = yield* compileRequest(
        LLM.request({
          model,
          messages: [response.message],
          providerOptions: { store: false, include: ["reasoning.encrypted_content"] },
        }),
      )
      expect(prepared.body.input).toEqual([
        {
          type: "reasoning",
          id: "rs_1",
          summary: [{ type: "summary_text", text: "Checked the diff." }],
          encrypted_content: "encrypted-state",
        },
      ])
    }),
  )

  it.effect("does not duplicate reasoning finals after streamed deltas", () =>
    Effect.gen(function* () {
      const response = yield* LLMClient.generate(request).pipe(
        Effect.provide(
          fixedResponse(
            sseEvents(
              { type: "response.output_item.added", item: { type: "reasoning", id: "rs_1", encrypted_content: null } },
              { type: "response.reasoning_summary_part.added", item_id: "rs_1", summary_index: 0 },
              { type: "response.reasoning_summary_text.delta", item_id: "rs_1", summary_index: 0, delta: "Streamed" },
              // Repeats the complete text, as the spec allows.
              { type: "response.reasoning_summary_text.done", item_id: "rs_1", summary_index: 0, text: "Streamed" },
              { type: "response.reasoning_summary_part.done", item_id: "rs_1", summary_index: 0 },
              {
                type: "response.output_item.done",
                item: { type: "reasoning", id: "rs_1", encrypted_content: "encrypted-state" },
              },
              { type: "response.completed", response: { id: "resp_1" } },
            ),
          ),
        ),
      )

      expect(response.reasoning).toBe("Streamed")
      expect(response.events.filter((event) => event.type === "reasoning-delta")).toEqual([
        { type: "reasoning-delta", id: "rs_1:0", text: "Streamed", providerMetadata: undefined },
      ])
    }),
  )

  it.effect("preserves final reasoning metadata when storage is enabled", () =>
    Effect.gen(function* () {
      const response = yield* LLMClient.generate(LLMRequest.update(request, { providerOptions: { store: true } })).pipe(
        Effect.provide(
          fixedResponse(
            sseEvents(
              {
                type: "response.output_item.added",
                item: { type: "reasoning", id: "rs_1", encrypted_content: null },
              },
              { type: "response.reasoning_summary_part.added", item_id: "rs_1", summary_index: 0 },
              { type: "response.reasoning_summary_text.delta", item_id: "rs_1", summary_index: 0, delta: "First" },
              { type: "response.reasoning_summary_part.done", item_id: "rs_1", summary_index: 0 },
              { type: "response.reasoning_summary_part.added", item_id: "rs_1", summary_index: 1 },
              { type: "response.reasoning_summary_text.delta", item_id: "rs_1", summary_index: 1, delta: "Second" },
              { type: "response.reasoning_summary_part.done", item_id: "rs_1", summary_index: 1 },
              {
                type: "response.output_item.done",
                item: { type: "reasoning", id: "rs_1", encrypted_content: "encrypted-state" },
              },
              { type: "response.completed", response: { id: "resp_1" } },
            ),
          ),
        ),
      )

      expect(response.events.filter((event) => event.type === "reasoning-end")).toEqual([
        { type: "reasoning-end", id: "rs_1:0", providerMetadata: { openai: { itemId: "rs_1" } } },
        {
          type: "reasoning-end",
          id: "rs_1:1",
          providerMetadata: { openai: { itemId: "rs_1", reasoningEncryptedContent: "encrypted-state" } },
        },
      ])
    }),
  )

  it.effect("continues a stateless reasoning conversation", () =>
    Effect.gen(function* () {
      const response = yield* LLMClient.generate(
        LLM.request({
          id: "req_reasoning_continue",
          model,
          messages: [
            Message.user("What changed?"),
            Message.assistant([
              {
                type: "reasoning",
                text: "Checked the previous diff.",
                providerMetadata: {
                  openai: {
                    itemId: "rs_1",
                    reasoningEncryptedContent: "encrypted-state",
                  },
                },
              },
              { type: "text", text: "The parser changed." },
            ]),
            Message.user("Summarize it."),
          ],
          providerOptions: { store: false },
        }),
      ).pipe(
        Effect.provide(
          dynamicResponse((input) =>
            Effect.gen(function* () {
              const web = yield* HttpClientRequest.toWeb(input.request).pipe(Effect.orDie)
              const body = yield* Effect.promise(() => web.json())
              expect(body).toMatchObject({
                input: [
                  { role: "user", content: [{ type: "input_text", text: "What changed?" }] },
                  {
                    type: "reasoning",
                    id: "rs_1",
                    encrypted_content: "encrypted-state",
                    summary: [{ type: "summary_text", text: "Checked the previous diff." }],
                  },
                  { role: "assistant", content: [{ type: "output_text", text: "The parser changed." }] },
                  { role: "user", content: [{ type: "input_text", text: "Summarize it." }] },
                ],
              })
              return input.respond(
                sseEvents(
                  { type: "response.output_item.added", item: { type: "message", id: "msg_1" } },
                  { type: "response.output_text.delta", item_id: "msg_1", delta: "Parser now round-trips reasoning." },
                  { type: "response.completed", response: { id: "resp_1" } },
                ),
                { headers: { "content-type": "text/event-stream" } },
              )
            }),
          ),
        ),
      )

      expect(response.text).toBe("Parser now round-trips reasoning.")
    }),
  )

  it.effect("preserves assistant content order around reasoning items", () =>
    Effect.gen(function* () {
      const prepared = yield* compileRequest(
        LLM.request({
          id: "req_reasoning_order",
          model,
          messages: [
            Message.assistant([
              { type: "text", text: "Before." },
              {
                type: "reasoning",
                text: "Checked order.",
                providerMetadata: {
                  openai: {
                    itemId: "rs_1",
                    reasoningEncryptedContent: "encrypted-state",
                  },
                },
              },
              { type: "text", text: "After." },
            ]),
          ],
          providerOptions: { store: false },
        }),
      )

      expect(prepared.body.input).toEqual([
        {
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "Before." }],
        },
        {
          type: "reasoning",
          id: "rs_1",
          encrypted_content: "encrypted-state",
          summary: [{ type: "summary_text", text: "Checked order." }],
        },
        { type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "After." }] },
      ])
    }),
  )

  it.effect("replays complete reasoning items when storage is enabled", () =>
    Effect.gen(function* () {
      const prepared = yield* compileRequest(
        LLM.request({
          model,
          messages: [
            Message.assistant([
              {
                type: "reasoning",
                text: "Checked the previous diff.",
                providerMetadata: { openai: { itemId: "rs_1", reasoningEncryptedContent: "encrypted-state" } },
              },
            ]),
          ],
          providerOptions: { store: true },
        }),
      )

      expect(prepared.body.input).toEqual([
        {
          type: "reasoning",
          id: "rs_1",
          summary: [{ type: "summary_text", text: "Checked the previous diff." }],
          encrypted_content: "encrypted-state",
        },
      ])
    }),
  )

  it.effect("replays complete hosted tool items when storage is enabled", () =>
    Effect.gen(function* () {
      const item = { type: "web_search_call", id: "ws_1", status: "completed" }
      const prepared = yield* compileRequest(
        LLM.request({
          model,
          messages: [
            Message.assistant([
              ToolCallPart.make({
                id: "ws_1",
                name: "web_search",
                input: { query: "effect 4" },
                providerExecuted: true,
                providerMetadata: { openai: { itemId: "ws_1" } },
              }),
              {
                type: "tool-result",
                id: "ws_1",
                name: "web_search",
                result: { type: "json", value: item },
                providerExecuted: true,
                providerMetadata: { openai: { itemId: "ws_1" } },
              },
            ]),
            Message.user("Continue."),
          ],
          providerOptions: { store: true },
        }),
      )

      expect(prepared.body.input).toEqual([
        item,
        { role: "user", content: [{ type: "input_text", text: "Continue." }] },
      ])
    }),
  )

  it.effect("replays stateless hosted tool results as native provider items", () =>
    Effect.gen(function* () {
      const item = { type: "web_search_call", id: "ws_1", status: "completed" }
      const prepared = yield* compileRequest(
        LLM.request({
          model,
          messages: [
            Message.user("Search."),
            Message.assistant([
              ToolCallPart.make({
                id: "ws_1",
                name: "web_search",
                input: { query: "effect 4" },
                providerExecuted: true,
                providerMetadata: { openai: { itemId: "ws_1" } },
              }),
              {
                type: "tool-result",
                id: "ws_1",
                name: "web_search",
                result: { type: "json", value: item },
                providerExecuted: true,
                providerMetadata: { openai: { itemId: "ws_1" } },
              },
            ]),
            Message.user("Continue."),
          ],
          providerOptions: { store: false },
        }),
      )

      expect(prepared.body.input).toEqual([
        { role: "user", content: [{ type: "input_text", text: "Search." }] },
        { type: "web_search_call", id: "ws_1", status: "completed" },
        { role: "user", content: [{ type: "input_text", text: "Continue." }] },
      ])
    }),
  )

  it.effect("replays OpenAI hosted tool extensions but rejects foreign and unknown items", () =>
    Effect.gen(function* () {
      const items = [
        { type: "computer_call", id: "computer_1", status: "completed", action: { type: "click", x: 1, y: 2 } },
        { type: "x_search_call", id: "x_search_1", status: "completed" },
        { type: "future_call", id: "future_1", status: "completed" },
      ]
      const prepared = yield* compileRequest(
        LLM.request({
          model,
          messages: items.map((item) =>
            Message.assistant({
              type: "tool-result",
              id: item.id,
              name: item.type,
              result: { type: "json", value: item },
              providerExecuted: true,
              providerMetadata: { openai: { itemId: item.id } },
            }),
          ),
        }),
      )

      expect(prepared.body.input).toEqual([
        items[0],
        { role: "user", content: [{ type: "input_text", text: JSON.stringify(items[1]) }] },
        { role: "user", content: [{ type: "input_text", text: JSON.stringify(items[2]) }] },
      ])
    }),
  )

  it.effect("preserves foreign hosted tool results as portable message content when storage is enabled", () =>
    Effect.gen(function* () {
      const item = { type: "web_search_call", id: "ws_1", status: "completed" }
      const prepared = yield* compileRequest(
        LLM.request({
          model: xaiModel,
          messages: [
            Message.assistant([
              ToolCallPart.make({
                id: "ws_1",
                name: "web_search",
                input: { query: "effect 4" },
                providerExecuted: true,
                providerMetadata: { openai: { itemId: "ws_1" } },
              }),
              {
                type: "tool-result",
                id: "ws_1",
                name: "web_search",
                result: { type: "json", value: item },
                providerExecuted: true,
                providerMetadata: { openai: { itemId: "ws_1" } },
              },
            ]),
            Message.user("Continue."),
          ],
          providerOptions: { store: true },
        }),
      )

      expect(prepared.body.input).toEqual([
        {
          role: "user",
          content: [{ type: "input_text", text: '{"type":"web_search_call","id":"ws_1","status":"completed"}' }],
        },
        { role: "user", content: [{ type: "input_text", text: "Continue." }] },
      ])
    }),
  )

  it.effect("does not replay hosted tool items whose result id differs from provider metadata", () =>
    Effect.gen(function* () {
      const prepared = yield* compileRequest(
        LLM.request({
          model,
          messages: [
            Message.assistant([
              {
                type: "tool-result",
                id: "ws_1",
                name: "web_search",
                result: { type: "json", value: { type: "web_search_call", id: "ws_other", status: "completed" } },
                providerExecuted: true,
                providerMetadata: { openai: { itemId: "ws_1" } },
              },
            ]),
          ],
        }),
      )

      expect(prepared.body.input).toEqual([
        {
          role: "user",
          content: [{ type: "input_text", text: '{"type":"web_search_call","id":"ws_other","status":"completed"}' }],
        },
      ])
    }),
  )

  it.effect("preserves provider-issued item ids and removes malformed ids without dropping items", () =>
    Effect.gen(function* () {
      const prepared = yield* compileRequest(
        LLM.request({
          model,
          messages: [
            Message.assistant([
              {
                type: "text",
                text: "Hello",
                providerMetadata: { openai: { itemId: "history_1" } },
              },
              {
                type: "text",
                text: "World",
                providerMetadata: { openai: { itemId: `message_${"a".repeat(64)}` } },
              },
              {
                type: "reasoning",
                text: "Checked the diff.",
                providerMetadata: { openai: { itemId: "thinking_1", reasoningEncryptedContent: "encrypted-state" } },
              },
              {
                type: "reasoning",
                text: "Missing suffix.",
                providerMetadata: { openai: { itemId: "rs_", reasoningEncryptedContent: "another-state" } },
              },
              {
                type: "reasoning",
                text: "No prefix separator.",
                providerMetadata: { openai: { itemId: "550e8400-e29b-41d4-a716-446655440000" } },
              },
              ToolCallPart.make({
                id: "call_1",
                name: "lookup",
                input: { query: "weather" },
                providerMetadata: { openai: { itemId: "toolu_01A" } },
              }),
              ToolCallPart.make({
                id: "call_2",
                name: "lookup",
                input: { query: "news" },
                providerMetadata: { openai: { itemId: "fc_" } },
              }),
            ]),
          ],
        }),
      )

      expect(prepared.body.input).toEqual([
        {
          type: "message",
          id: "history_1",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "Hello" }],
        },
        {
          type: "message",
          id: `message_${"a".repeat(64)}`,
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "World" }],
        },
        {
          type: "reasoning",
          id: "thinking_1",
          summary: [{ type: "summary_text", text: "Checked the diff." }],
          encrypted_content: "encrypted-state",
        },
        {
          type: "reasoning",
          summary: [{ type: "summary_text", text: "Missing suffix." }],
          encrypted_content: "another-state",
        },
        {
          type: "reasoning",
          summary: [{ type: "summary_text", text: "No prefix separator." }],
        },
        {
          type: "function_call",
          id: "toolu_01A",
          call_id: "call_1",
          name: "lookup",
          arguments: '{"query":"weather"}',
        },
        {
          type: "function_call",
          call_id: "call_2",
          name: "lookup",
          arguments: '{"query":"news"}',
        },
      ])
    }),
  )

  it.effect("falls back to portable hosted results when stored item metadata is malformed", () =>
    Effect.gen(function* () {
      const hostedResult = (itemId: string) => {
        const item = { type: "web_search_call", id: itemId, status: "completed" }
        return [
          ToolCallPart.make({
            id: itemId,
            name: "web_search",
            input: { query: "effect 4" },
            providerExecuted: true,
            providerMetadata: { openai: { itemId } },
          }),
          {
            type: "tool-result" as const,
            id: itemId,
            name: "web_search",
            result: { type: "json" as const, value: item },
            providerExecuted: true as const,
            providerMetadata: { openai: { itemId } },
          },
        ]
      }
      const prepared = yield* compileRequest(
        LLM.request({
          model,
          messages: [Message.assistant(hostedResult("ws_1")), Message.assistant(hostedResult("bad ref"))],
          providerOptions: { store: true },
        }),
      )

      expect(prepared.body.input).toEqual([
        { type: "web_search_call", id: "ws_1", status: "completed" },
        {
          role: "user",
          content: [{ type: "input_text", text: '{"type":"web_search_call","id":"bad ref","status":"completed"}' }],
        },
      ])
    }),
  )

  it.effect("continues stateless hosted image generation with the generated image", () =>
    Effect.gen(function* () {
      const imageTool = OpenAI.imageGeneration({ action: "edit" })
      const prepared = yield* compileRequest(
        LLM.request({
          model,
          messages: [
            Message.user("Generate a black triangle."),
            Message.assistant([
              ToolCallPart.make({
                id: "ig_1",
                name: "image_generation",
                input: {},
                providerExecuted: true,
                providerMetadata: { openai: { itemId: "ig_1" } },
              }),
              ToolResultPart.make({
                id: "ig_1",
                name: "image_generation",
                result: {
                  type: "content",
                  value: [{ type: "file", uri: "data:image/png;base64,AQID", mime: "image/png" }],
                },
                providerExecuted: true,
                providerMetadata: { openai: { itemId: "ig_1" } },
              }),
            ]),
            Message.user("Make it blue."),
          ],
          tools: [imageTool],
        }),
      )

      expect(prepared.body.store).toBe(false)
      expect(prepared.body.input).toEqual([
        { role: "user", content: [{ type: "input_text", text: "Generate a black triangle." }] },
        { role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,AQID" }] },
        { role: "user", content: [{ type: "input_text", text: "Make it blue." }] },
      ])
    }),
  )

  it.effect("preserves foreign hosted images as portable image content when storage is enabled", () =>
    Effect.gen(function* () {
      const item = { type: "image_generation_call", id: "ig_1", status: "completed", result: "AQID" }
      const prepared = yield* compileRequest(
        LLM.request({
          model: xaiModel,
          messages: [
            Message.assistant([
              ToolCallPart.make({
                id: "ig_1",
                name: "image_generation",
                input: {},
                providerExecuted: true,
                providerMetadata: { openai: { itemId: "ig_1" } },
              }),
              ToolResultPart.make({
                id: "ig_1",
                name: "image_generation",
                result: {
                  type: "content",
                  value: [{ type: "file", uri: "data:image/png;base64,AQID", mime: "image/png" }],
                },
                providerExecuted: true,
                providerMetadata: { openai: { itemId: "ig_1" } },
              }),
            ]),
          ],
          providerOptions: { store: true },
        }),
      )

      expect(prepared.body.input).toEqual([
        { role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,AQID" }] },
      ])
    }),
  )

  it.effect("joins streamed summary blocks into one continuation reasoning item", () =>
    Effect.gen(function* () {
      const prepared = yield* compileRequest(
        LLM.request({
          id: "req_multi_summary_continuation",
          model,
          messages: [
            Message.assistant([
              {
                type: "reasoning",
                text: "First",
                providerMetadata: { openai: { itemId: "rs_1" } },
              },
              {
                type: "reasoning",
                text: "Second",
                providerMetadata: { openai: { itemId: "rs_1", reasoningEncryptedContent: "encrypted-state" } },
              },
            ]),
          ],
          providerOptions: { store: false },
        }),
      )

      expect(prepared.body.input).toEqual([
        {
          type: "reasoning",
          id: "rs_1",
          encrypted_content: "encrypted-state",
          summary: [
            { type: "summary_text", text: "First" },
            { type: "summary_text", text: "Second" },
          ],
        },
      ])
    }),
  )

  it.effect("replays stateless reasoning without encrypted state", () =>
    Effect.gen(function* () {
      const prepared = yield* compileRequest(
        LLM.request({
          id: "req_reasoning_without_encrypted_state",
          model,
          messages: [
            Message.user("What changed?"),
            Message.assistant([
              {
                type: "reasoning",
                text: "Checked the previous diff.",
                providerMetadata: {
                  openai: {
                    itemId: "rs_1",
                    reasoningEncryptedContent: null,
                  },
                },
              },
              { type: "text", text: "The parser changed." },
            ]),
            Message.user("Summarize it."),
          ],
          providerOptions: { store: false },
        }),
      )

      expect(prepared.body).toMatchObject({
        input: [
          { role: "user", content: [{ type: "input_text", text: "What changed?" }] },
          {
            type: "reasoning",
            id: "rs_1",
            summary: [{ type: "summary_text", text: "Checked the previous diff." }],
            encrypted_content: null,
          },
          { role: "assistant", content: [{ type: "output_text", text: "The parser changed." }] },
          { role: "user", content: [{ type: "input_text", text: "Summarize it." }] },
        ],
        store: false,
      })
    }),
  )

  it.effect("assembles streamed function call input", () =>
    Effect.gen(function* () {
      const body = sseEvents(
        {
          type: "response.output_item.added",
          item: { type: "function_call", id: "fc_item_1", call_id: "call_1", name: "lookup", arguments: "" },
        },
        { type: "response.function_call_arguments.delta", item_id: "fc_item_1", delta: '{"query"' },
        { type: "response.function_call_arguments.delta", item_id: "fc_item_1", delta: ':"weather"}' },
        {
          type: "response.output_item.done",
          item: {
            type: "function_call",
            id: "fc_item_1",
            call_id: "call_1",
            name: "lookup",
            arguments: '{"query":"weather"}',
          },
        },
        { type: "response.completed", response: { usage: { input_tokens: 5, output_tokens: 1 } } },
      )
      const response = yield* LLMClient.generate(
        LLMRequest.update(request, {
          tools: [ToolDefinition.make({ name: "lookup", description: "Lookup data", inputSchema: { type: "object" } })],
        }),
      ).pipe(Effect.provide(fixedResponse(body)))
      const usage = new Usage({
        inputTokens: 5,
        outputTokens: 1,
        nonCachedInputTokens: 5,
        cacheReadInputTokens: undefined,
        reasoningTokens: undefined,
        totalTokens: 6,
        providerMetadata: { openai: { input_tokens: 5, output_tokens: 1 } },
      })

      expect(response.events).toEqual([
        { type: "step-start", index: 0 },
        {
          type: "tool-input-start",
          id: "call_1",
          name: "lookup",
          providerMetadata: { openai: { itemId: "fc_item_1" } },
        },
        {
          type: "tool-input-delta",
          id: "call_1",
          name: "lookup",
          text: '{"query"',
          input: {},
        },
        {
          type: "tool-input-delta",
          id: "call_1",
          name: "lookup",
          text: ':"weather"}',
          input: { query: "weather" },
        },
        {
          type: "tool-input-end",
          id: "call_1",
          name: "lookup",
          providerMetadata: { openai: { itemId: "fc_item_1" } },
        },
        {
          type: "tool-call",
          id: "call_1",
          name: "lookup",
          input: { query: "weather" },
          providerExecuted: undefined,
          providerMetadata: { openai: { itemId: "fc_item_1" } },
        },
        {
          type: "step-finish",
          index: 0,
          reason: { normalized: "tool-calls", raw: undefined },
          usage,
          providerMetadata: undefined,
        },
        {
          type: "finish",
          reason: { normalized: "tool-calls", raw: undefined },
          providerMetadata: undefined,
          usage,
        },
      ])

      const prepared = yield* compileRequest(LLM.request({ model, messages: [response.message] }))
      expect(prepared.body.input).toEqual([
        {
          type: "function_call",
          id: "fc_item_1",
          call_id: "call_1",
          name: "lookup",
          arguments: '{"query":"weather"}',
        },
      ])
    }),
  )

  it.effect("emits only missing function arguments from the arguments done event", () =>
    Effect.gen(function* () {
      const body = sseEvents(
        {
          type: "response.output_item.added",
          item: { type: "function_call", id: "fc_item_1", call_id: "call_1", name: "lookup", arguments: "" },
        },
        { type: "response.function_call_arguments.delta", item_id: "fc_item_1", delta: '{"query"' },
        {
          type: "response.function_call_arguments.done",
          item_id: "fc_item_1",
          arguments: '{"query":"weather"}',
        },
        {
          type: "response.output_item.done",
          item: {
            type: "function_call",
            id: "fc_item_1",
            call_id: "call_1",
            name: "lookup",
            arguments: '{"query":"weather"}',
          },
        },
        { type: "response.completed", response: { id: "resp_1" } },
      )
      const response = yield* LLMClient.generate(request).pipe(Effect.provide(fixedResponse(body)))

      expect(response.events.filter((event) => event.type === "tool-input-delta")).toEqual([
        { type: "tool-input-delta", id: "call_1", name: "lookup", text: '{"query"', input: {} },
        { type: "tool-input-delta", id: "call_1", name: "lookup", text: ':"weather"}', input: { query: "weather" } },
      ])
      expect(response.events.filter(LLMEvent.is.toolInputEnd)).toHaveLength(1)
      expect(response.events.filter(LLMEvent.is.toolCall)).toEqual([
        {
          type: "tool-call",
          id: "call_1",
          name: "lookup",
          input: { query: "weather" },
          providerExecuted: undefined,
          providerMetadata: { openai: { itemId: "fc_item_1" } },
        },
      ])
    }),
  )

  it.effect("streams complete function arguments supplied only by the arguments done event", () =>
    Effect.gen(function* () {
      const body = sseEvents(
        {
          type: "response.output_item.added",
          item: { type: "function_call", id: "fc_item_1", call_id: "call_1", name: "lookup", arguments: "" },
        },
        {
          type: "response.function_call_arguments.done",
          item_id: "fc_item_1",
          arguments: '{"query":"weather"}',
        },
        { type: "response.completed", response: { id: "resp_1" } },
      )
      const response = yield* LLMClient.generate(request).pipe(Effect.provide(fixedResponse(body)))

      expect(response.events.filter((event) => event.type === "tool-input-delta")).toEqual([
        {
          type: "tool-input-delta",
          id: "call_1",
          name: "lookup",
          text: '{"query":"weather"}',
          input: { query: "weather" },
        },
      ])
      expect(response.events.find(LLMEvent.is.toolCall)).toMatchObject({ input: { query: "weather" } })
      expect(response.finishReason.normalized).toBe("tool-calls")
    }),
  )

  it.effect("does not repeat function arguments already supplied by deltas", () =>
    Effect.gen(function* () {
      const body = sseEvents(
        {
          type: "response.output_item.added",
          item: { type: "function_call", id: "fc_item_1", call_id: "call_1", name: "lookup", arguments: "" },
        },
        {
          type: "response.function_call_arguments.delta",
          item_id: "fc_item_1",
          delta: '{"query":"weather"}',
        },
        {
          type: "response.function_call_arguments.done",
          item_id: "fc_item_1",
          arguments: '{"query":"weather"}',
        },
        { type: "response.completed", response: { id: "resp_1" } },
      )
      const response = yield* LLMClient.generate(request).pipe(Effect.provide(fixedResponse(body)))

      expect(response.events.filter((event) => event.type === "tool-input-delta")).toHaveLength(1)
      expect(response.events.find(LLMEvent.is.toolCall)).toMatchObject({ input: { query: "weather" } })
    }),
  )

  it.effect("uses authoritative arguments done input without emitting a mismatched delta", () =>
    Effect.gen(function* () {
      const body = sseEvents(
        {
          type: "response.output_item.added",
          item: { type: "function_call", id: "fc_item_1", call_id: "call_1", name: "lookup", arguments: "" },
        },
        {
          type: "response.function_call_arguments.delta",
          item_id: "fc_item_1",
          delta: '{"query":"streamed"}',
        },
        {
          type: "response.function_call_arguments.done",
          item_id: "fc_item_1",
          arguments: '{"query":"final"}',
        },
        { type: "response.completed", response: { id: "resp_1" } },
      )
      const response = yield* LLMClient.generate(request).pipe(Effect.provide(fixedResponse(body)))

      expect(response.events.filter((event) => event.type === "tool-input-delta")).toEqual([
        {
          type: "tool-input-delta",
          id: "call_1",
          name: "lookup",
          text: '{"query":"streamed"}',
          input: { query: "streamed" },
        },
      ])
      expect(response.events.find(LLMEvent.is.toolCall)).toMatchObject({ input: { query: "final" } })
    }),
  )

  it.effect("lets completed output item arguments override the arguments done event", () =>
    Effect.gen(function* () {
      const body = sseEvents(
        {
          type: "response.output_item.added",
          item: { type: "function_call", id: "fc_item_1", call_id: "call_1", name: "lookup", arguments: "" },
        },
        {
          type: "response.function_call_arguments.done",
          item_id: "fc_item_1",
          arguments: '{"query":"arguments-done"}',
        },
        {
          type: "response.output_item.done",
          item: {
            type: "function_call",
            id: "fc_item_1",
            call_id: "call_1",
            name: "lookup",
            arguments: '{"query":"output-item-done"}',
          },
        },
        { type: "response.completed", response: { id: "resp_1" } },
      )
      const response = yield* LLMClient.generate(request).pipe(Effect.provide(fixedResponse(body)))

      expect(response.events.find(LLMEvent.is.toolCall)).toMatchObject({ input: { query: "output-item-done" } })
      expect(response.events.filter(LLMEvent.is.toolCall)).toHaveLength(1)
    }),
  )

  it.effect("treats empty completed output item arguments as authoritative", () =>
    Effect.gen(function* () {
      const body = sseEvents(
        {
          type: "response.output_item.added",
          item: { type: "function_call", id: "fc_item_1", call_id: "call_1", name: "lookup", arguments: "" },
        },
        { type: "response.function_call_arguments.delta", item_id: "fc_item_1", delta: '{"query":"streamed"}' },
        {
          type: "response.output_item.done",
          item: { type: "function_call", id: "fc_item_1", call_id: "call_1", name: "lookup", arguments: "" },
        },
        { type: "response.completed", response: { id: "resp_1" } },
      )
      const response = yield* LLMClient.generate(request).pipe(Effect.provide(fixedResponse(body)))

      expect(response.events.find(LLMEvent.is.toolCall)).toMatchObject({ input: {} })
      expect(response.events.filter(LLMEvent.is.toolCall)).toHaveLength(1)
    }),
  )

  it.effect("uses completed response output when output item completion is missing", () =>
    Effect.gen(function* () {
      const body = sseEvents(
        {
          type: "response.output_item.added",
          item: { type: "function_call", id: "fc_item_1", call_id: "call_1", name: "lookup", arguments: "" },
        },
        { type: "response.function_call_arguments.delta", item_id: "fc_item_1", delta: '{"query":"wea' },
        {
          type: "response.completed",
          response: {
            id: "resp_1",
            output: [
              {
                type: "function_call",
                id: "fc_item_1",
                call_id: "call_1",
                name: "lookup",
                arguments: '{"query":"weather"}',
              },
            ],
          },
        },
      )
      const response = yield* LLMClient.generate(request).pipe(Effect.provide(fixedResponse(body)))

      expect(response.events.find(LLMEvent.is.toolCall)).toMatchObject({
        id: "call_1",
        input: { query: "weather" },
        providerMetadata: { openai: { itemId: "fc_item_1" } },
      })
      expect(response.events.filter(LLMEvent.is.toolInputEnd)).toHaveLength(1)
      expect(response.events.filter(LLMEvent.is.toolCall)).toHaveLength(1)
      expect(response.finishReason.normalized).toBe("tool-calls")
    }),
  )

  it.effect("lets completed response output override arguments done", () =>
    Effect.gen(function* () {
      const body = sseEvents(
        {
          type: "response.output_item.added",
          item: { type: "function_call", id: "fc_item_1", call_id: "call_1", name: "lookup", arguments: "" },
        },
        {
          type: "response.function_call_arguments.done",
          item_id: "fc_item_1",
          arguments: '{"query":"arguments-done"}',
        },
        {
          type: "response.completed",
          response: {
            output: [
              {
                type: "function_call",
                id: "fc_item_1",
                call_id: "call_1",
                name: "lookup",
                arguments: '{"query":"completed"}',
              },
            ],
          },
        },
      )
      const response = yield* LLMClient.generate(request).pipe(Effect.provide(fixedResponse(body)))

      expect(response.events.find(LLMEvent.is.toolCall)).toMatchObject({ input: { query: "completed" } })
    }),
  )

  it.effect("preserves explicit empty arguments from completed response output", () =>
    Effect.gen(function* () {
      const body = sseEvents(
        {
          type: "response.output_item.added",
          item: { type: "function_call", id: "fc_item_1", call_id: "call_1", name: "lookup", arguments: "" },
        },
        { type: "response.function_call_arguments.delta", item_id: "fc_item_1", delta: '{"query":"streamed"}' },
        {
          type: "response.completed",
          response: {
            output: [{ type: "function_call", id: "fc_item_1", call_id: "call_1", name: "lookup", arguments: "" }],
          },
        },
      )
      const response = yield* LLMClient.generate(request).pipe(Effect.provide(fixedResponse(body)))

      expect(response.events.find(LLMEvent.is.toolCall)).toMatchObject({ input: {} })
    }),
  )

  it.effect("does not repeat function calls already finalized by an output item", () =>
    Effect.gen(function* () {
      const item = {
        type: "function_call",
        id: "fc_item_1",
        call_id: "call_1",
        name: "lookup",
        arguments: '{"query":"weather"}',
      }
      const body = sseEvents(
        { type: "response.output_item.added", item: { ...item, arguments: "" } },
        { type: "response.output_item.done", item },
        { type: "response.completed", response: { output: [item] } },
      )
      const response = yield* LLMClient.generate(request).pipe(Effect.provide(fixedResponse(body)))

      expect(response.events.filter(LLMEvent.is.toolInputEnd)).toHaveLength(1)
      expect(response.events.filter(LLMEvent.is.toolCall)).toHaveLength(1)
    }),
  )

  it.effect("does not finalize pending function calls from incomplete response output", () =>
    Effect.gen(function* () {
      const item = {
        type: "function_call",
        id: "fc_item_1",
        call_id: "call_1",
        name: "lookup",
        arguments: '{"query":"partial',
      }
      const body = sseEvents(
        { type: "response.output_item.added", item: { ...item, arguments: "" } },
        { type: "response.function_call_arguments.delta", item_id: "fc_item_1", delta: item.arguments },
        {
          type: "response.incomplete",
          response: { incomplete_details: { reason: "max_output_tokens" }, output: [item] },
        },
      )
      const response = yield* LLMClient.generate(request).pipe(Effect.provide(fixedResponse(body)))

      expect(response.events.some(LLMEvent.is.toolCall)).toBeFalse()
      expect(response.finishReason.normalized).toBe("length")
    }),
  )

  it.effect("finalizes a pending function call at response completion", () =>
    Effect.gen(function* () {
      const body = sseEvents(
        {
          type: "response.output_item.added",
          item: { type: "function_call", id: "fc_item_1", call_id: "call_1", name: "lookup", arguments: "" },
        },
        { type: "response.completed", response: { usage: { input_tokens: 5, output_tokens: 1 } } },
      )
      const response = yield* LLMClient.generate(request).pipe(Effect.provide(fixedResponse(body)))

      expect(response.events.filter((event) => LLMEvent.is.toolInputEnd(event) || LLMEvent.is.toolCall(event))).toEqual(
        [
          {
            type: "tool-input-end",
            id: "call_1",
            name: "lookup",
            providerMetadata: { openai: { itemId: "fc_item_1" } },
          },
          {
            type: "tool-call",
            id: "call_1",
            name: "lookup",
            input: {},
            providerExecuted: undefined,
            providerMetadata: { openai: { itemId: "fc_item_1" } },
          },
        ],
      )
      expect(response.finishReason.normalized).toBe("tool-calls")
    }),
  )

  it.effect("recovers authoritative incomplete final function arguments", () =>
    Effect.gen(function* () {
      const body = sseEvents(
        {
          type: "response.output_item.added",
          item: { type: "function_call", id: "fc_item_1", call_id: "call_1", name: "lookup", arguments: "" },
        },
        { type: "response.function_call_arguments.delta", item_id: "fc_item_1", delta: '{"query":"streamed"}' },
        {
          type: "response.output_item.done",
          item: {
            type: "function_call",
            id: "fc_item_1",
            call_id: "call_1",
            name: "lookup",
            arguments: '{"query":"partial',
          },
        },
        { type: "response.completed", response: { usage: { input_tokens: 5, output_tokens: 1 } } },
      )
      const response = yield* LLMClient.generate(
        LLMRequest.update(request, {
          tools: [ToolDefinition.make({ name: "lookup", description: "Lookup data", inputSchema: { type: "object" } })],
        }),
      ).pipe(Effect.provide(fixedResponse(body)))

      expect(response.events.find(LLMEvent.is.toolCall)).toMatchObject({
        id: "call_1",
        name: "lookup",
        input: { query: "partial" },
      })
      expect(response.finishReason.normalized).toBe("tool-calls")
      expect(response.events.some(LLMEvent.is.toolInputError)).toBeFalse()
    }),
  )

  it.effect("recovers incomplete function arguments when output_item.added is absent", () =>
    Effect.gen(function* () {
      const body = sseEvents(
        {
          type: "response.output_item.done",
          item: {
            type: "function_call",
            id: "fc_item_1",
            call_id: "call_1",
            name: "lookup",
            arguments: '{"query":"partial',
          },
        },
        { type: "response.completed", response: { usage: { input_tokens: 5, output_tokens: 1 } } },
      )
      const response = yield* LLMClient.generate(request).pipe(Effect.provide(fixedResponse(body)))

      expect(response.events.find(LLMEvent.is.toolCall)).toMatchObject({
        id: "call_1",
        name: "lookup",
        input: { query: "partial" },
      })
      expect(response.finishReason.normalized).toBe("tool-calls")
    }),
  )

  it.effect("retains function call item metadata when output_item.added is absent", () =>
    Effect.gen(function* () {
      const response = yield* LLMClient.generate(request).pipe(
        Effect.provide(
          fixedResponse(
            sseEvents(
              {
                type: "response.output_item.done",
                item: {
                  type: "function_call",
                  id: "fc_item_1",
                  call_id: "call_1",
                  name: "lookup",
                  arguments: '{"query":"weather"}',
                },
              },
              { type: "response.completed", response: { id: "resp_1" } },
            ),
          ),
        ),
      )

      expect(response.events.find(LLMEvent.is.toolCall)).toMatchObject({
        id: "call_1",
        providerMetadata: { openai: { itemId: "fc_item_1" } },
      })
    }),
  )

  it.effect("decodes web_search_call as provider-executed tool-call + tool-result", () =>
    Effect.gen(function* () {
      const item = {
        type: "web_search_call",
        id: "ws_1",
        status: "completed",
        action: { type: "search", query: "effect 4" },
      }
      const body = sseEvents(
        { type: "response.output_item.added", item },
        { type: "response.output_item.done", item },
        { type: "response.completed", response: { usage: { input_tokens: 5, output_tokens: 1 } } },
      )
      const response = yield* LLMClient.generate(request).pipe(Effect.provide(fixedResponse(body)))

      const callsAndResults = response.events.filter(
        (event) => event.type === "tool-call" || event.type === "tool-result",
      )
      expect(callsAndResults).toEqual([
        {
          type: "tool-call",
          id: "ws_1",
          name: "web_search",
          input: { type: "search", query: "effect 4" },
          providerExecuted: true,
          providerMetadata: { openai: { itemId: "ws_1" } },
        },
        {
          type: "tool-result",
          id: "ws_1",
          name: "web_search",
          result: { type: "json", value: item },
          providerExecuted: true,
          providerMetadata: { openai: { itemId: "ws_1" } },
        },
      ])
    }),
  )

  it.effect("decodes computer_call as provider-executed tool-call + tool-result", () =>
    Effect.gen(function* () {
      const item = {
        type: "computer_call",
        id: "computer_1",
        call_id: "call_1",
        status: "completed",
        action: { type: "click", x: 100, y: 200 },
      }
      const response = yield* LLMClient.generate(request).pipe(
        Effect.provide(
          fixedResponse(
            sseEvents(
              { type: "response.output_item.done", item },
              { type: "response.completed", response: { usage: { input_tokens: 5, output_tokens: 1 } } },
            ),
          ),
        ),
      )

      expect(response.events.filter((event) => event.type === "tool-call" || event.type === "tool-result")).toEqual([
        {
          type: "tool-call",
          id: "computer_1",
          name: "computer_use",
          input: { type: "click", x: 100, y: 200 },
          providerExecuted: true,
          providerMetadata: { openai: { itemId: "computer_1" } },
        },
        {
          type: "tool-result",
          id: "computer_1",
          name: "computer_use",
          result: { type: "json", value: item },
          providerExecuted: true,
          providerMetadata: { openai: { itemId: "computer_1" } },
        },
      ])
    }),
  )

  it.effect("replays hosted image results as portable content regardless of storage", () =>
    Effect.gen(function* () {
      const item = {
        type: "image_generation_call",
        id: "ig_1",
        status: "completed",
        result: "AQID",
        action: "generate",
        output_format: "png",
      }
      const response = yield* LLMClient.generate(request).pipe(
        Effect.provide(
          fixedResponse(
            sseEvents(
              { type: "response.output_item.done", item },
              { type: "response.completed", response: { usage: { input_tokens: 5, output_tokens: 1 } } },
            ),
          ),
        ),
      )

      expect(response.events.find(LLMEvent.is.toolCall)).toMatchObject({
        providerMetadata: { openai: { itemId: "ig_1" } },
      })
      expect(response.events.find(LLMEvent.is.toolResult)).toMatchObject({
        id: "ig_1",
        name: "image_generation",
        providerExecuted: true,
        result: {
          type: "content",
          value: [{ type: "file", uri: "data:image/png;base64,AQID", mime: "image/png" }],
        },
        providerMetadata: { openai: { itemId: "ig_1" } },
      })

      const prepared = yield* Effect.forEach([false, true], (store) =>
        compileRequest(LLM.request({ model, messages: [response.message], providerOptions: { store } })),
      )
      expect(prepared.map((request) => request.body.input)).toEqual([
        [{ role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,AQID" }] }],
        [{ role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,AQID" }] }],
      ])
    }),
  )

  it.effect("preserves failed hosted tool results as portable error content", () =>
    Effect.gen(function* () {
      const item = {
        type: "web_search_call",
        id: "ws_failed",
        status: "failed",
        error: { code: "search_failed", message: "Search unavailable" },
      }
      const response = yield* LLMClient.generate(request).pipe(
        Effect.provide(
          fixedResponse(
            sseEvents(
              { type: "response.output_item.done", item },
              { type: "response.completed", response: { id: "resp_1" } },
            ),
          ),
        ),
      )

      expect(response.events.find(LLMEvent.is.toolResult)).toMatchObject({
        result: { type: "error", value: item.error },
        providerMetadata: { openai: { itemId: "ws_failed" } },
      })

      const prepared = yield* compileRequest(
        LLM.request({ model, messages: [response.message], providerOptions: { store: true } }),
      )
      expect(prepared.body.input).toEqual([
        {
          role: "user",
          content: [{ type: "input_text", text: '{"code":"search_failed","message":"Search unavailable"}' }],
        },
      ])
    }),
  )

  it.effect("rejects malformed image generation base64", () =>
    Effect.gen(function* () {
      const error = yield* LLMClient.generate(request).pipe(
        Effect.provide(
          fixedResponse(
            sseEvents(
              {
                type: "response.output_item.done",
                item: { type: "image_generation_call", id: "ig_bad", status: "completed", result: "%%%" },
              },
              { type: "response.completed", response: {} },
            ),
          ),
        ),
        Effect.flip,
      )

      expect(error.reason._tag).toBe("InvalidProviderOutput")
      expect(error.message).toContain("invalid image base64")
    }),
  )

  it.effect("decodes code_interpreter_call as provider-executed events with code input", () =>
    Effect.gen(function* () {
      const item = {
        type: "code_interpreter_call",
        id: "ci_1",
        status: "completed",
        code: "print(1+1)",
        container_id: "cnt_xyz",
        outputs: [{ type: "logs", logs: "2\n" }],
      }
      const body = sseEvents(
        { type: "response.output_item.done", item },
        { type: "response.completed", response: { usage: { input_tokens: 5, output_tokens: 1 } } },
      )
      const response = yield* LLMClient.generate(request).pipe(Effect.provide(fixedResponse(body)))

      const toolCall = response.events.find((event) => event.type === "tool-call")
      expect(toolCall).toEqual({
        type: "tool-call",
        id: "ci_1",
        name: "code_interpreter",
        input: { code: "print(1+1)", container_id: "cnt_xyz" },
        providerExecuted: true,
        providerMetadata: { openai: { itemId: "ci_1" } },
      })
      const toolResult = response.events.find((event) => event.type === "tool-result")
      expect(toolResult).toEqual({
        type: "tool-result",
        id: "ci_1",
        name: "code_interpreter",
        result: { type: "json", value: item },
        providerExecuted: true,
        providerMetadata: { openai: { itemId: "ci_1" } },
      })
    }),
  )

  it.effect("lowers user image and PDF content", () =>
    Effect.gen(function* () {
      const prepared = yield* compileRequest(
        LLM.request({
          id: "req_media",
          model,
          messages: [
            Message.user([
              { type: "media", mediaType: "image/png", data: "AAECAw==" },
              { type: "media", mediaType: "application/pdf", data: "JVBERi0xLjQ=", filename: "report.pdf" },
            ]),
          ],
        }),
      )

      expect(prepared.body.input).toEqual([
        {
          role: "user",
          content: [
            { type: "input_image", image_url: "data:image/png;base64,AAECAw==" },
            {
              type: "input_file",
              filename: "report.pdf",
              file_data: "data:application/pdf;base64,JVBERi0xLjQ=",
            },
          ],
        },
      ])
    }),
  )

  it.effect("uses standard inline file encoding for xAI user PDFs", () =>
    Effect.gen(function* () {
      const prepared = yield* compileRequest(
        LLM.request({
          model: xaiModel,
          messages: [
            Message.user({
              type: "media",
              mediaType: "application/pdf",
              data: "data:application/pdf;base64,JVBERi0xLjQ=",
              filename: "report.pdf",
            }),
          ],
        }),
      )

      expect(prepared.body.input).toEqual([
        {
          role: "user",
          content: [
            {
              type: "input_file",
              filename: "report.pdf",
              file_data: "data:application/pdf;base64,JVBERi0xLjQ=",
            },
          ],
        },
      ])
    }),
  )

  it.effect("passes non-image user media through as an input file", () =>
    Effect.gen(function* () {
      const prepared = yield* compileRequest(
        LLM.request({
          id: "req_media",
          model,
          messages: [Message.user({ type: "media", mediaType: "application/x-tar", data: "AAECAw==" })],
        }),
      )

      expect(prepared.body.input).toEqual([
        {
          role: "user",
          content: [
            {
              type: "input_file",
              filename: "file",
              file_data: "data:application/x-tar;base64,AAECAw==",
            },
          ],
        },
      ])
    }),
  )

  it.effect("lowers remote user media URLs without base64 wrapping", () =>
    Effect.gen(function* () {
      const prepared = yield* compileRequest(
        LLM.request({
          model,
          messages: [
            Message.user([
              { type: "media", mediaType: "image/png", data: "https://example.com/image.png" },
              {
                type: "media",
                mediaType: "application/pdf",
                data: "https://example.com/report.pdf",
                filename: "report.pdf",
              },
            ]),
          ],
        }),
      )

      expect(prepared.body.input).toEqual([
        {
          role: "user",
          content: [
            { type: "input_image", image_url: "https://example.com/image.png" },
            { type: "input_file", filename: "report.pdf", file_url: "https://example.com/report.pdf" },
          ],
        },
      ])
    }),
  )

  it.effect("fails with a typed rate limit for provider error frames", () =>
    Effect.gen(function* () {
      const error = yield* LLMClient.generate(request).pipe(
        Effect.provide(fixedResponse(sseEvents({ type: "error", code: "rate_limit_exceeded", message: "Slow down" }))),
        Effect.flip,
      )

      expect(error).toBeInstanceOf(AIError)
      expect(error).toMatchObject({ reason: { _tag: "RateLimit" }, message: "rate_limit_exceeded: Slow down" })
    }),
  )

  it.effect("falls back to error code when no message is present", () =>
    Effect.gen(function* () {
      const error = yield* LLMClient.generate(request).pipe(
        Effect.provide(fixedResponse(sseEvents({ type: "error", code: "internal_error" }))),
        Effect.flip,
      )

      expect(error).toMatchObject({ reason: { _tag: "ProviderInternal" }, message: "internal_error" })
    }),
  )

  it.effect("falls back to error code when message is empty", () =>
    Effect.gen(function* () {
      const error = yield* LLMClient.generate(request).pipe(
        Effect.provide(fixedResponse(sseEvents({ type: "error", code: "internal_error", message: "" }))),
        Effect.flip,
      )

      expect(error).toMatchObject({ reason: { _tag: "ProviderInternal" }, message: "internal_error" })
    }),
  )

  // Regression: `response.failed` carries the failure details under
  // `response.error`, not at the top level. The previous handler only
  // checked top-level `message`/`code` and so always emitted the bare
  // "OpenAI Responses response failed" string, hiding the real cause.
  it.effect("surfaces response.failed details from response.error", () =>
    Effect.gen(function* () {
      const error = yield* LLMClient.generate(request).pipe(
        Effect.provide(
          fixedResponse(
            sseEvents({
              type: "response.failed",
              response: {
                id: "resp_failed_1",
                error: { code: "server_error", message: "Upstream model unavailable" },
              },
            }),
          ),
        ),
        Effect.flip,
      )

      expect(error).toMatchObject({
        reason: { _tag: "ProviderInternal" },
        message: "server_error: Upstream model unavailable",
      })
    }),
  )

  it.effect("surfaces response.failed code when no nested message is present", () =>
    Effect.gen(function* () {
      const error = yield* LLMClient.generate(request).pipe(
        Effect.provide(
          fixedResponse(
            sseEvents({
              type: "response.failed",
              response: { id: "resp_failed_2", error: { code: "invalid_prompt" } },
            }),
          ),
        ),
        Effect.flip,
      )

      expect(error).toMatchObject({ reason: { _tag: "InvalidRequest" }, message: "invalid_prompt" })
    }),
  )

  it.effect("surfaces error event details nested under response.error", () =>
    Effect.gen(function* () {
      // Some OpenAI-compatible proxies and older SDK versions wrap the
      // top-level error fields into a nested `response.error` payload
      // when they bubble up an HTTP error as an SSE `error` event. Honour
      // both shapes so the user still sees the underlying cause instead
      // of the catch-all string.
      const error = yield* LLMClient.generate(request).pipe(
        Effect.provide(
          fixedResponse(
            sseEvents({
              type: "error",
              response: { error: { code: "context_length_exceeded", message: "prompt too long" } },
            }),
          ),
        ),
        Effect.flip,
      )

      expect(error).toMatchObject({
        reason: { _tag: "InvalidRequest", classification: "context-overflow" },
        message: "context_length_exceeded: prompt too long",
      })
    }),
  )

  it.effect("surfaces error event details nested under error", () =>
    Effect.gen(function* () {
      const error = yield* LLMClient.generate(request).pipe(
        Effect.provide(
          fixedResponse(
            sseEvents({
              type: "error",
              sequence_number: 2,
              error: {
                type: "invalid_request_error",
                code: "context_length_exceeded",
                message: "prompt too long",
                param: "input",
              },
            }),
          ),
        ),
        Effect.flip,
      )

      expect(error).toMatchObject({
        reason: { _tag: "InvalidRequest", classification: "context-overflow" },
        message: "context_length_exceeded: prompt too long",
      })
    }),
  )

  it.effect("accepts nullable fields in spec-compliant error events", () =>
    Effect.gen(function* () {
      const error = yield* LLMClient.generate(request).pipe(
        Effect.provide(
          fixedResponse(
            sseEvents({
              type: "error",
              code: null,
              message: "Something went wrong",
              param: null,
              sequence_number: 1,
            }),
          ),
        ),
        Effect.flip,
      )

      expect(error).toMatchObject({ reason: { _tag: "UnknownProvider" }, message: "Something went wrong" })
    }),
  )

  it.effect("falls back to the raw payload when error is null", () =>
    Effect.gen(function* () {
      const error = yield* LLMClient.generate(request).pipe(
        Effect.provide(fixedResponse(sseEvents({ type: "error", error: null }))),
        Effect.flip,
      )

      expect(error.reason).toMatchObject({ _tag: "UnknownProvider" })
      expect(error.message).toContain('"error":null')
      expect(error.reason.body).toBe(error.message)
    }),
  )

  it.effect("classifies a detail-free error event as a transient provider failure", () =>
    Effect.gen(function* () {
      const error = yield* LLMClient.generate(request).pipe(
        Effect.provide(fixedResponse(sseEvents({ type: "error", sequence_number: 2 }))),
        Effect.flip,
      )

      expect(error.reason).toMatchObject({ _tag: "ProviderInternal" })
      expect(error.message).toContain('"type":"error"')
      expect(error.reason.body).toBe(error.message)
    }),
  )

  it.effect("keeps the raw response payload when response.failed has no error payload", () =>
    Effect.gen(function* () {
      const error = yield* LLMClient.generate(request).pipe(
        Effect.provide(fixedResponse(sseEvents({ type: "response.failed", response: { id: "resp_failed_3" } }))),
        Effect.flip,
      )

      expect(error.reason).toMatchObject({ _tag: "UnknownProvider" })
      expect(error.message).toContain('"resp_failed_3"')
      expect(error.reason.body).toBe(error.message)
    }),
  )

  it.effect("fails HTTP provider errors before stream parsing", () =>
    Effect.gen(function* () {
      const error = yield* LLMClient.generate(request).pipe(
        Effect.provide(
          fixedResponse('{"error":{"type":"invalid_request_error","message":"Bad request"}}', {
            status: 400,
            headers: { "content-type": "application/json" },
          }),
        ),
        Effect.flip,
      )

      expect(error).toBeInstanceOf(AIError)
      expect(error).toMatchObject({ reason: { _tag: "InvalidRequest" }, message: "Bad request" })
    }),
  )
})
