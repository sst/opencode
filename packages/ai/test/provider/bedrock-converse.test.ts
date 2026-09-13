import { EventStreamCodec } from "@smithy/eventstream-codec"
import { fromUtf8, toUtf8 } from "@smithy/util-utf8"
import { describe, expect } from "bun:test"
import { Effect, Encoding, Ref, Schema, Stream } from "effect"
import { HttpClientRequest } from "effect/unstable/http"
import {
  CacheHint,
  GenerationOptions,
  type LanguageModel,
  LLM,
  LLMEvent,
  LLMRequest,
  Message,
  Tool,
  ToolCallPart,
  ToolChoice,
  ToolDefinition,
  ToolRuntime,
} from "../../src/index.js"
import { LLMClient } from "../../src/route.js"
import { compileRequest } from "../../src/route/client.js"
import { AmazonBedrock } from "../../src/providers.js"
import * as BedrockConverse from "../../src/protocols/bedrock-converse.js"
import { it } from "../lib/effect.js"
import { withProcessEnv } from "../lib/env.js"
import { dynamicResponse, fixedResponse } from "../lib/http.js"
import {
  eventSummary,
  expectWeatherToolLoop,
  runWeatherToolLoop,
  weatherTool,
  weatherToolLoopRequest,
  weatherToolName,
} from "../recorded-scenarios.js"
import { recordedTests } from "../recorded-test.js"

const codec = new EventStreamCodec(toUtf8, fromUtf8)
const utf8Encoder = new TextEncoder()

// Build a single AWS event-stream frame for a Converse stream event. Each
// frame carries `:message-type=event` + `:event-type=<name>` headers and a
// JSON payload body.
const eventFrame = (type: string, payload: object) =>
  codec.encode({
    headers: {
      ":message-type": { type: "string", value: "event" },
      ":event-type": { type: "string", value: type },
      ":content-type": { type: "string", value: "application/json" },
    },
    body: utf8Encoder.encode(JSON.stringify(payload)),
  })

const exceptionFrame = (type: string, payload: object) =>
  codec.encode({
    headers: {
      ":message-type": { type: "string", value: "exception" },
      ":exception-type": { type: "string", value: type },
      ":content-type": { type: "string", value: "application/json" },
    },
    body: utf8Encoder.encode(JSON.stringify(payload)),
  })

const errorFrame = (code: string, message: string) =>
  codec.encode({
    headers: {
      ":message-type": { type: "string", value: "error" },
      ":error-code": { type: "string", value: code },
      ":error-message": { type: "string", value: message },
    },
    body: new Uint8Array(),
  })

const concat = (frames: ReadonlyArray<Uint8Array>) => {
  const total = frames.reduce((sum, frame) => sum + frame.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const frame of frames) {
    out.set(frame, offset)
    offset += frame.length
  }
  return out
}

const eventStreamBody = (...payloads: ReadonlyArray<readonly [string, object]>) =>
  concat(payloads.map(([type, payload]) => eventFrame(type, payload)))

// Override the default SSE content-type with the binary event-stream type so
// the cassette layer treats the body as bytes when recording.
const fixedBytes = (bytes: Uint8Array) =>
  fixedResponse(bytes.slice().buffer, { headers: { "content-type": "application/vnd.amazon.eventstream" } })

const fixedByteChunks = (...chunks: ReadonlyArray<Uint8Array>) =>
  fixedResponse(
    new ReadableStream<Uint8Array>({
      start(controller) {
        chunks.forEach((chunk) => controller.enqueue(chunk))
        controller.close()
      },
    }),
    { headers: { "content-type": "application/vnd.amazon.eventstream" } },
  )

// Clears every input the AWS default chain reads so tests do not pick up the
// developer's profiles, SSO cache, or instance metadata.
const noAmbientAWS = {
  AWS_ACCESS_KEY_ID: undefined,
  AWS_SECRET_ACCESS_KEY: undefined,
  AWS_SESSION_TOKEN: undefined,
  AWS_BEARER_TOKEN_BEDROCK: undefined,
  AWS_PROFILE: undefined,
  AWS_REGION: undefined,
  AWS_DEFAULT_REGION: undefined,
  AWS_WEB_IDENTITY_TOKEN_FILE: undefined,
  AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: undefined,
  AWS_CONTAINER_CREDENTIALS_FULL_URI: undefined,
  AWS_EC2_METADATA_DISABLED: "true",
}

const captureHeaders = (target: LanguageModel) =>
  Effect.gen(function* () {
    const seen: Array<Headers> = []
    yield* LLMClient.generate(LLMRequest.update(baseRequest, { model: target })).pipe(
      Effect.provide(
        dynamicResponse((input) =>
          Effect.gen(function* () {
            const request = yield* HttpClientRequest.toWeb(input.request)
            seen.push(request.headers)
            return input.respond(eventStreamBody(["messageStop", { stopReason: "end_turn" }]), {
              headers: { "content-type": "application/vnd.amazon.eventstream" },
            })
          }),
        ),
      ),
    )
    return seen[0]!
  })

const model = AmazonBedrock.configure({
  baseURL: "https://bedrock-runtime.test",
  apiKey: "test-bearer",
}).model("anthropic.claude-sonnet-4-5-20250929-v1:0")

const baseRequest = LLM.request({
  id: "req_1",
  model,
  system: "You are concise.",
  prompt: "Say hello.",
  // Wire-shape assertions in this file predate the `cache: "auto"` default;
  // pin the policy off so they only exercise the lowering path itself.
  cache: "none",
  generation: { maxTokens: 64, temperature: 0 },
})

describe("Bedrock Converse route", () => {
  it.effect("prepares Converse target with system, inference config, and messages", () =>
    Effect.gen(function* () {
      const prepared = yield* compileRequest(baseRequest)

      expect(prepared.body).toEqual({
        modelId: "anthropic.claude-sonnet-4-5-20250929-v1:0",
        system: [{ text: "You are concise." }],
        messages: [{ role: "user", content: [{ text: "Say hello." }] }],
        inferenceConfig: { maxTokens: 64, temperature: 0 },
      })
    }),
  )

  it.effect("omits empty initial system blocks", () =>
    Effect.gen(function* () {
      const empty = yield* compileRequest(LLM.request({ model, system: "", prompt: "hello" }))
      const cachedEmpty = yield* compileRequest(
        LLM.request({
          model,
          system: [{ type: "text", text: "", cache: new CacheHint({ type: "ephemeral" }) }],
          prompt: "hello",
          cache: "none",
        }),
      )

      expect(empty.body.system).toBeUndefined()
      expect(cachedEmpty.body.system).toBeUndefined()
    }),
  )

  it.effect("omits empty system blocks while preserving order and cache hints", () =>
    Effect.gen(function* () {
      const cache = new CacheHint({ type: "ephemeral" })
      const prepared = yield* compileRequest(
        LLM.request({
          model,
          system: [
            { type: "text", text: "", cache },
            { type: "text", text: "First." },
            { type: "text", text: " " },
            { type: "text", text: "" },
            { type: "text", text: "Second.", cache },
          ],
          prompt: "hello",
          cache: "none",
        }),
      )

      expect(prepared.body.system).toEqual([
        { text: "First." },
        { text: " " },
        { text: "Second." },
        { cachePoint: { type: "default" } },
      ])
    }),
  )

  it.effect("passes topK through additionalModelRequestFields as top_k", () =>
    Effect.gen(function* () {
      const prepared = yield* compileRequest(
        LLMRequest.update(baseRequest, {
          generation: GenerationOptions.make({ maxTokens: 64, temperature: 0, topK: 40 }),
        }),
      )

      // Converse's inferenceConfig has no topK; Anthropic/Nova read it from
      // additionalModelRequestFields as top_k.
      expect(prepared.body.inferenceConfig).toEqual({ maxTokens: 64, temperature: 0 })
      expect(prepared.body.additionalModelRequestFields).toEqual({ top_k: 40 })
    }),
  )

  it.effect("omits additionalModelRequestFields when topK is unset", () =>
    Effect.gen(function* () {
      const prepared = yield* compileRequest(baseRequest)
      expect(prepared.body.additionalModelRequestFields).toBeUndefined()
    }),
  )

  it.effect("lowers chronological system updates to wrapped user text in order", () =>
    Effect.gen(function* () {
      const prepared = yield* compileRequest(
        LLM.request({
          model,
          messages: [Message.user("Before."), Message.system("Update."), Message.assistant("After.")],
          cache: "none",
        }),
      )

      expect(prepared.body.messages).toEqual([
        { role: "user", content: [{ text: "Before." }, { text: "<system-update>\nUpdate.\n</system-update>" }] },
        { role: "assistant", content: [{ text: "After." }] },
      ])
    }),
  )

  it.effect("prepares tool config with toolSpec and toolChoice", () =>
    Effect.gen(function* () {
      const prepared = yield* compileRequest(
        LLMRequest.update(baseRequest, {
          tools: [
            ToolDefinition.make({
              name: "lookup",
              description: "Lookup data",
              inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
            }),
          ],
          toolChoice: ToolChoice.make({ type: "required" }),
        }),
      )

      expect(prepared.body).toMatchObject({
        toolConfig: {
          tools: [
            {
              toolSpec: {
                name: "lookup",
                description: "Lookup data",
                inputSchema: {
                  json: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
                },
              },
            },
          ],
          toolChoice: { any: {} },
        },
      })
    }),
  )
  ;["", " \t\r\n"].forEach((description) => {
    it.effect(`omits blank tool description ${JSON.stringify(description)}`, () =>
      Effect.gen(function* () {
        const prepared = yield* compileRequest(
          LLMRequest.update(baseRequest, {
            tools: [
              ToolDefinition.make({
                name: "lookup",
                description,
                inputSchema: { type: "object", properties: { query: { type: "string" } } },
              }),
            ],
          }),
        )

        expect(prepared.body.toolConfig.tools).toEqual([
          {
            toolSpec: {
              name: "lookup",
              inputSchema: { json: { type: "object", properties: { query: { type: "string" } } } },
            },
          },
        ])
        expect(prepared.body.toolConfig.tools[0].toolSpec).not.toHaveProperty("description")
      }),
    )
  })

  it.effect("preserves meaningful tool descriptions including surrounding whitespace", () =>
    Effect.gen(function* () {
      const description = " \tLookup data.\n"
      const prepared = yield* compileRequest(
        LLMRequest.update(baseRequest, {
          tools: [
            ToolDefinition.make({
              name: "lookup",
              description,
              inputSchema: { type: "object" },
            }),
          ],
        }),
      )

      expect(prepared.body.toolConfig.tools[0].toolSpec.description).toBe(description)
    }),
  )

  it.effect("keeps tools and omits the unsupported choice when tool choice is none", () =>
    Effect.gen(function* () {
      const prepared = yield* compileRequest(
        LLMRequest.update(baseRequest, {
          tools: [
            ToolDefinition.make({
              name: "lookup",
              description: "Lookup data",
              inputSchema: { type: "object", properties: { query: { type: "string" } } },
            }),
          ],
          toolChoice: ToolChoice.make({ type: "none" }),
        }),
      )

      expect(prepared.body.toolConfig).toMatchObject({
        tools: [
          {
            toolSpec: {
              name: "lookup",
              description: "Lookup data",
              inputSchema: { json: { type: "object", properties: { query: { type: "string" } } } },
            },
          },
        ],
      })
      expect(prepared.body.toolConfig?.toolChoice).toBeUndefined()
    }),
  )

  it.effect("lowers assistant tool-call + tool-result message history", () =>
    Effect.gen(function* () {
      const prepared = yield* compileRequest(
        LLM.request({
          id: "req_history",
          model,
          messages: [
            Message.user("What is the weather?"),
            Message.assistant([ToolCallPart.make({ id: "tool_1", name: "lookup", input: { query: "weather" } })]),
            Message.tool({ id: "tool_1", name: "lookup", result: { forecast: "sunny" } }),
          ],
          cache: "none",
        }),
      )

      expect(prepared.body).toMatchObject({
        messages: [
          { role: "user", content: [{ text: "What is the weather?" }] },
          {
            role: "assistant",
            content: [{ toolUse: { toolUseId: "tool_1", name: "lookup", input: { query: "weather" } } }],
          },
          {
            role: "user",
            content: [
              {
                toolResult: {
                  toolUseId: "tool_1",
                  content: [{ json: { forecast: "sunny" } }],
                  status: "success",
                },
              },
            ],
          },
        ],
      })
    }),
  )
  ;[
    { name: "browser.tabs.open", expected: "browser_tabs_open" },
    { name: "$lookup", expected: "_lookup" },
    { name: "", expected: "_" },
    { name: "   ", expected: "___" },
    { name: "a".repeat(65), expected: "a".repeat(64) },
    { name: "lookup_123-ABC", expected: "lookup_123-ABC" },
    { name: "a".repeat(64), expected: "a".repeat(64) },
  ].forEach((item) => {
    it.effect(`replays historical tool name ${JSON.stringify(item.name)} within Bedrock constraints`, () =>
      Effect.gen(function* () {
        const call = ToolCallPart.make({ id: "call_unknown", name: item.name, input: { query: "weather" } })
        const error = `No tool named "${item.name}" is currently available. Please use a tool from the available tool list.`
        const request = LLM.request({
          model,
          cache: "none",
          tools: [ToolDefinition.make({ name: "execute", description: "Run code", inputSchema: { type: "object" } })],
          messages: [
            Message.user("Check the weather"),
            Message.assistant([call]),
            Message.tool({ id: call.id, name: call.name, result: error, resultType: "error" }),
            Message.user("Say OK"),
          ],
        })
        const prepared = yield* compileRequest(request)

        expect(prepared.body.messages[1].content).toEqual([
          { toolUse: { toolUseId: call.id, name: item.expected, input: call.input } },
        ])
        expect(prepared.body.messages[2].content).toEqual([
          { toolResult: { toolUseId: call.id, content: [{ text: error }], status: "error" } },
          { text: "Say OK" },
        ])
        expect(prepared.body.toolConfig.tools.map((tool) => tool.toolSpec.name)).toEqual(["execute"])
        expect(request.messages[1].content[0]).toEqual(call)
        expect(call.name).toBe(item.name)
      }),
    )
  })

  it.effect("removes empty keys recursively from outbound tool inputs without mutating history", () =>
    Effect.gen(function* () {
      const input = {
        path: "file.ts",
        edits: [
          { oldText: "a", newText: "b", "": "" },
          null,
          true,
          7,
          "text",
          ["kept", { "": false, nested: { "": null, value: "ok" } }],
        ],
        nested: { "": "drop", empty: {}, onlyEmpty: { "": 1 } },
        " ": "preserve whitespace key",
        "": "drop",
      }
      const original = structuredClone(input)
      const call = ToolCallPart.make({ id: "tool_1", name: "edit", input })
      const prepared = yield* compileRequest(
        LLM.request({ model, messages: [Message.assistant([call])], cache: "none" }),
      )

      expect(prepared.body.messages).toEqual([
        {
          role: "assistant",
          content: [
            {
              toolUse: {
                toolUseId: "tool_1",
                name: "edit",
                input: {
                  path: "file.ts",
                  edits: [{ oldText: "a", newText: "b" }, null, true, 7, "text", ["kept", { nested: { value: "ok" } }]],
                  nested: { empty: {}, onlyEmpty: {} },
                  " ": "preserve whitespace key",
                },
              },
            },
          ],
        },
      ])
      expect(input).toEqual(original)
      expect(call.input).toBe(input)
    }),
  )

  it.effect("keeps empty tool inputs and empties inputs containing only empty keys", () =>
    Effect.gen(function* () {
      const prepared = yield* compileRequest(
        LLM.request({
          model,
          messages: [
            Message.assistant([
              ToolCallPart.make({ id: "tool_empty_key", name: "first", input: { "": { value: true } } }),
              ToolCallPart.make({ id: "tool_empty_object", name: "second", input: {} }),
            ]),
          ],
          cache: "none",
        }),
      )

      expect(prepared.body.messages).toEqual([
        {
          role: "assistant",
          content: [
            { toolUse: { toolUseId: "tool_empty_key", name: "first", input: {} } },
            { toolUse: { toolUseId: "tool_empty_object", name: "second", input: {} } },
          ],
        },
      ])
    }),
  )

  it.effect("merges parallel tool results into one user message", () =>
    Effect.gen(function* () {
      const prepared = yield* compileRequest(
        LLM.request({
          id: "req_parallel_history",
          model,
          messages: [
            Message.user("Compare the weather."),
            Message.assistant([
              ToolCallPart.make({ id: "tool_paris", name: "lookup", input: { city: "Paris" } }),
              ToolCallPart.make({ id: "tool_london", name: "lookup", input: { city: "London" } }),
            ]),
            Message.tool({ id: "tool_paris", name: "lookup", result: { forecast: "sunny" } }),
            Message.tool({ id: "tool_london", name: "lookup", result: { forecast: "rainy" } }),
          ],
          cache: "none",
        }),
      )

      expect(prepared.body.messages).toEqual([
        { role: "user", content: [{ text: "Compare the weather." }] },
        {
          role: "assistant",
          content: [
            { toolUse: { toolUseId: "tool_paris", name: "lookup", input: { city: "Paris" } } },
            { toolUse: { toolUseId: "tool_london", name: "lookup", input: { city: "London" } } },
          ],
        },
        {
          role: "user",
          content: [
            {
              toolResult: {
                toolUseId: "tool_paris",
                content: [{ json: { forecast: "sunny" } }],
                status: "success",
              },
            },
            {
              toolResult: {
                toolUseId: "tool_london",
                content: [{ json: { forecast: "rainy" } }],
                status: "success",
              },
            },
          ],
        },
      ])
    }),
  )

  it.effect("lowers image content in tool-result messages", () =>
    Effect.gen(function* () {
      const prepared = yield* compileRequest(
        LLM.request({
          id: "req_tool_image",
          model,
          messages: [
            Message.user("Capture the screen."),
            Message.assistant([ToolCallPart.make({ id: "tool_1", name: "screenshot", input: {} })]),
            Message.tool({
              id: "tool_1",
              name: "screenshot",
              result: {
                type: "content",
                value: [
                  { type: "text", text: "Screenshot captured." },
                  { type: "file", uri: "data:image/png;base64,AAAA", mime: "image/png" },
                ],
              },
            }),
          ],
          cache: "none",
        }),
      )

      expect(prepared.body).toMatchObject({
        messages: [
          { role: "user", content: [{ text: "Capture the screen." }] },
          {
            role: "assistant",
            content: [{ toolUse: { toolUseId: "tool_1", name: "screenshot", input: {} } }],
          },
          {
            role: "user",
            content: [
              {
                toolResult: {
                  toolUseId: "tool_1",
                  content: [{ text: "Screenshot captured." }, { image: { format: "png", source: { bytes: "AAAA" } } }],
                  status: "success",
                },
              },
            ],
          },
        ],
      })
    }),
  )

  it.effect("decodes text-delta + messageStop + metadata usage from binary event stream", () =>
    Effect.gen(function* () {
      const body = eventStreamBody(
        ["messageStart", { role: "assistant" }],
        ["contentBlockDelta", { contentBlockIndex: 0, delta: { text: "Hello" } }],
        ["contentBlockDelta", { contentBlockIndex: 0, delta: { text: "!" } }],
        ["contentBlockStop", { contentBlockIndex: 0 }],
        ["messageStop", { stopReason: "end_turn" }],
        ["metadata", { usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 } }],
      )
      const response = yield* LLMClient.generate(baseRequest).pipe(Effect.provide(fixedBytes(body)))

      expect(response.text).toBe("Hello!")
      const finishes = response.events.filter((event) => event.type === "finish")
      // Bedrock splits the finish across `messageStop` (carries reason) and
      // `metadata` (carries usage). We consolidate them into a single
      // terminal `finish` event with both.
      expect(finishes).toHaveLength(1)
      expect(finishes[0]).toMatchObject({
        type: "finish",
        reason: { normalized: "stop", raw: "end_turn" },
      })
      expect(response.usage).toMatchObject({
        inputTokens: 5,
        outputTokens: 2,
        totalTokens: 7,
      })
    }),
  )

  it.effect("rejects truncated event-stream frames after message stop", () =>
    Effect.gen(function* () {
      const partialFrames = [
        eventFrame("metadata", { usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 } }).subarray(0, 3),
        exceptionFrame("modelStreamErrorException", { originalMessage: "Upstream model failed" }).subarray(0, -1),
      ]

      for (const partial of partialFrames) {
        const error = yield* LLMClient.generate(baseRequest).pipe(
          Effect.provide(fixedBytes(concat([eventFrame("messageStop", { stopReason: "end_turn" }), partial]))),
          Effect.flip,
        )

        expect(error).toMatchObject({
          reason: { _tag: "InvalidProviderOutput", classification: "incomplete-stream" },
          message: `Incomplete Bedrock Converse event-stream frame: ${partial.length} buffered bytes remain at end of stream`,
        })
        expect(error.reason.body).toBe(Encoding.encodeBase64(partial))
      }
    }),
  )

  it.effect("decodes frames split across transport chunks through exact-boundary EOF", () =>
    Effect.gen(function* () {
      const body = eventStreamBody(
        ["messageStart", { role: "assistant" }],
        ["contentBlockDelta", { contentBlockIndex: 0, delta: { text: "Hello" } }],
        ["messageStop", { stopReason: "end_turn" }],
      )
      const response = yield* LLMClient.generate(baseRequest).pipe(
        Effect.provide(fixedByteChunks(body.subarray(0, 2), body.subarray(2, 17), body.subarray(17))),
      )

      expect(response.text).toBe("Hello")
      expect(response.finishReason).toEqual({ normalized: "stop", raw: "end_turn" })
    }),
  )

  it.effect("maps model context window exhaustion to length", () =>
    Effect.gen(function* () {
      const response = yield* LLMClient.generate(baseRequest).pipe(
        Effect.provide(fixedBytes(eventStreamBody(["messageStop", { stopReason: "model_context_window_exceeded" }]))),
      )

      expect(response.finishReason).toEqual({
        normalized: "length",
        raw: "model_context_window_exceeded",
      })
    }),
  )

  it.effect("fails malformed output stop reasons", () =>
    Effect.gen(function* () {
      for (const reason of ["malformed_model_output", "malformed_tool_use"] as const) {
        const events = yield* Ref.make<ReadonlyArray<LLMEvent>>([])
        const error = yield* LLMClient.stream(baseRequest).pipe(
          Stream.tap((event) => Ref.update(events, (current) => [...current, event])),
          Stream.runDrain,
          Effect.provide(fixedBytes(eventStreamBody(["messageStop", { stopReason: reason }]))),
          Effect.flip,
        )

        expect(error).toMatchObject({
          reason: { _tag: "InvalidProviderOutput" },
          message: `Bedrock Converse stopped with ${reason}`,
        })
        expect(JSON.parse(error.reason.body ?? "")).toMatchObject({
          headers: { ":event-type": { value: "messageStop" } },
          body: JSON.stringify({ stopReason: reason }),
        })
        expect((yield* Ref.get(events)).some((event) => event.type === "finish")).toBeFalse()
      }
    }),
  )

  it.effect("adds cache reads and writes to Bedrock input usage", () =>
    Effect.gen(function* () {
      const body = eventStreamBody(
        ["messageStart", { role: "assistant" }],
        ["contentBlockDelta", { contentBlockIndex: 0, delta: { text: "Hello" } }],
        ["contentBlockStop", { contentBlockIndex: 0 }],
        ["messageStop", { stopReason: "end_turn" }],
        [
          "metadata",
          {
            usage: {
              inputTokens: 5,
              outputTokens: 2,
              totalTokens: 12,
              cacheReadInputTokens: 3,
              cacheWriteInputTokens: 2,
            },
          },
        ],
      )
      const response = yield* LLMClient.generate(baseRequest).pipe(Effect.provide(fixedBytes(body)))

      expect(response.usage).toMatchObject({
        inputTokens: 10,
        nonCachedInputTokens: 5,
        cacheReadInputTokens: 3,
        cacheWriteInputTokens: 2,
        outputTokens: 2,
        totalTokens: 12,
      })
    }),
  )

  it.effect("preserves usage across later metadata events without usage", () =>
    Effect.gen(function* () {
      const body = eventStreamBody(
        ["messageStop", { stopReason: "end_turn" }],
        ["metadata", { usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 } }],
        ["metadata", { metrics: { latencyMs: 100 } }],
      )
      const response = yield* LLMClient.generate(baseRequest).pipe(Effect.provide(fixedBytes(body)))

      expect(response.events.filter((event) => event.type === "finish")).toHaveLength(1)
      expect(response.usage).toMatchObject({ inputTokens: 5, outputTokens: 2, totalTokens: 7 })
    }),
  )

  it.effect("retains metadata usage that arrives before messageStop", () =>
    Effect.gen(function* () {
      const body = eventStreamBody(
        ["metadata", { usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 } }],
        ["messageStop", { stopReason: "end_turn" }],
      )
      const response = yield* LLMClient.generate(baseRequest).pipe(Effect.provide(fixedBytes(body)))

      expect(response.events.filter((event) => event.type === "finish")).toHaveLength(1)
      expect(response.finishReason).toEqual({ normalized: "stop", raw: "end_turn" })
      expect(response.usage).toMatchObject({ inputTokens: 5, outputTokens: 2, totalTokens: 7 })
    }),
  )

  it.effect("rejects metadata-only streams as incomplete with HTTP context", () =>
    Effect.gen(function* () {
      const error = yield* LLMClient.generate(baseRequest).pipe(
        Effect.provide(
          fixedBytes(eventStreamBody(["metadata", { usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 } }])),
        ),
        Effect.flip,
      )

      expect(error.reason).toMatchObject({
        _tag: "InvalidProviderOutput",
        classification: "incomplete-stream",
        http: {
          status: 200,
          headers: { "content-type": "application/vnd.amazon.eventstream" },
        },
      })
    }),
  )

  it.effect("assembles streamed tool call input", () =>
    Effect.gen(function* () {
      const body = eventStreamBody(
        ["messageStart", { role: "assistant" }],
        [
          "contentBlockStart",
          {
            contentBlockIndex: 0,
            start: { toolUse: { toolUseId: "tool_1", name: "lookup" } },
          },
        ],
        ["contentBlockDelta", { contentBlockIndex: 0, delta: { toolUse: { input: '{"query"' } } }],
        ["contentBlockDelta", { contentBlockIndex: 0, delta: { toolUse: { input: ':"weather"}' } } }],
        ["contentBlockStop", { contentBlockIndex: 0 }],
        ["messageStop", { stopReason: "tool_use" }],
      )
      const response = yield* LLMClient.generate(
        LLMRequest.update(baseRequest, {
          tools: [ToolDefinition.make({ name: "lookup", description: "Lookup", inputSchema: { type: "object" } })],
        }),
      ).pipe(Effect.provide(fixedBytes(body)))

      expect(response.toolCalls).toEqual([
        { type: "tool-call", id: "tool_1", name: "lookup", input: { query: "weather" } },
      ])
      const events = response.events.filter((event) => event.type === "tool-input-delta")
      expect(events).toEqual([
        { type: "tool-input-delta", id: "tool_1", name: "lookup", text: '{"query"', input: {} },
        {
          type: "tool-input-delta",
          id: "tool_1",
          name: "lookup",
          text: ':"weather"}',
          input: { query: "weather" },
        },
      ])
      expect(response.events.at(-1)).toMatchObject({
        type: "finish",
        reason: { normalized: "tool-calls", raw: "tool_use" },
      })
    }),
  )

  it.effect("rejects a provider-emitted dotted name before normalizing its replay", () =>
    Effect.gen(function* () {
      const response = yield* LLMClient.generate(baseRequest).pipe(
        Effect.provide(
          fixedBytes(
            eventStreamBody(
              [
                "contentBlockStart",
                { contentBlockIndex: 0, start: { toolUse: { toolUseId: "call_unknown", name: "browser.tabs.open" } } },
              ],
              ["contentBlockDelta", { contentBlockIndex: 0, delta: { toolUse: { input: "{}" } } }],
              ["contentBlockStop", { contentBlockIndex: 0 }],
              ["messageStop", { stopReason: "tool_use" }],
            ),
          ),
        ),
      )
      const call = response.toolCalls[0]
      if (!call) throw new Error("Expected a tool call")
      expect(call.name).toBe("browser.tabs.open")
      const dispatched = yield* ToolRuntime.dispatch(
        {
          browser_tabs_open: Tool.make({
            description: "Open a tab",
            parameters: Schema.Struct({}),
            success: Schema.String,
            execute: () => Effect.die("A normalized replay name must not select an executor"),
          }),
        },
        call,
      )
      expect(dispatched.result).toEqual({
        type: "error",
        value:
          'No tool named "browser.tabs.open" is currently available. Please use a tool from the available tool list.',
      })

      const prepared = yield* compileRequest(
        LLM.request({
          model,
          cache: "none",
          messages: [response.message, Message.tool({ id: call.id, name: call.name, result: dispatched.result })],
        }),
      )
      expect(prepared.body.messages[0].content).toEqual([
        { toolUse: { toolUseId: call.id, name: "browser_tabs_open", input: {} } },
      ])
      expect(response.toolCalls[0]?.name).toBe("browser.tabs.open")
    }),
  )

  it.effect("ignores tool deltas without an open tool block", () =>
    Effect.gen(function* () {
      const body = eventStreamBody(
        ["contentBlockDelta", { contentBlockIndex: 5, delta: { toolUse: { input: "{}" } } }],
        [
          "contentBlockStart",
          {
            contentBlockIndex: 0,
            start: { toolUse: { toolUseId: "tool_1", name: "lookup" } },
          },
        ],
        ["contentBlockDelta", { contentBlockIndex: 0, delta: { toolUse: { input: '{"query":"weather"}' } } }],
        ["contentBlockStop", { contentBlockIndex: 0 }],
        ["contentBlockDelta", { contentBlockIndex: 0, delta: { toolUse: { input: '{"late":true}' } } }],
        ["messageStop", { stopReason: "tool_use" }],
      )
      const response = yield* LLMClient.generate(baseRequest).pipe(Effect.provide(fixedBytes(body)))

      expect(response.toolCalls).toEqual([
        { type: "tool-call", id: "tool_1", name: "lookup", input: { query: "weather" } },
      ])
      expect(response.events.filter((event) => event.type === "tool-input-delta")).toEqual([
        {
          type: "tool-input-delta",
          id: "tool_1",
          name: "lookup",
          text: '{"query":"weather"}',
          input: { query: "weather" },
        },
      ])
    }),
  )

  it.effect("recovers incomplete tool input at finalization", () =>
    Effect.gen(function* () {
      const body = eventStreamBody(
        ["messageStart", { role: "assistant" }],
        [
          "contentBlockStart",
          {
            contentBlockIndex: 0,
            start: { toolUse: { toolUseId: "tool_1", name: "lookup" } },
          },
        ],
        ["contentBlockDelta", { contentBlockIndex: 0, delta: { toolUse: { input: '{"query":"partial' } } }],
        ["contentBlockStop", { contentBlockIndex: 0 }],
        ["messageStop", { stopReason: "end_turn" }],
      )
      const response = yield* LLMClient.generate(baseRequest).pipe(Effect.provide(fixedBytes(body)))

      expect(response.events.find((event) => event.type === "tool-call")).toMatchObject({
        id: "tool_1",
        name: "lookup",
        input: { query: "partial" },
      })
      expect(response.finishReason).toEqual({ normalized: "tool-calls", raw: "end_turn" })
    }),
  )

  it.effect("decodes reasoning deltas", () =>
    Effect.gen(function* () {
      const body = eventStreamBody(
        ["messageStart", { role: "assistant" }],
        ["contentBlockDelta", { contentBlockIndex: 0, delta: { reasoningContent: { text: "Let me think." } } }],
        ["contentBlockStop", { contentBlockIndex: 0 }],
        ["messageStop", { stopReason: "end_turn" }],
      )
      const response = yield* LLMClient.generate(baseRequest).pipe(Effect.provide(fixedBytes(body)))

      expect(response.reasoning).toBe("Let me think.")
    }),
  )

  for (const signature of [undefined, "", "   "]) {
    for (const cache of ["none", "auto"] as const) {
      it.effect(`demotes unsigned reasoning to text (${JSON.stringify(signature)}, cache: ${cache})`, () =>
        Effect.gen(function* () {
          const prepared = yield* compileRequest(
            LLM.request({
              model,
              messages: [
                Message.user("Think"),
                Message.assistant([
                  {
                    type: "reasoning",
                    text: "Partial thought",
                    providerMetadata: signature === undefined ? undefined : { bedrock: { signature } },
                    cache: new CacheHint({ type: "ephemeral" }),
                  },
                ]),
                Message.user("Continue"),
              ],
              cache,
            }),
          )
          expect(prepared.body.messages[1]).toEqual({
            role: "assistant",
            content: [{ text: "Partial thought" }, { cachePoint: { type: "default" } }],
          })
        }),
      )
    }
  }

  it.effect("omits empty unsigned reasoning without leaving an empty or cache-only assistant", () =>
    Effect.gen(function* () {
      const cache = new CacheHint({ type: "ephemeral" })
      const prepared = yield* compileRequest(
        LLM.request({
          model,
          messages: [
            Message.user("Think"),
            Message.assistant([
              { type: "reasoning", text: "", cache },
              { type: "reasoning", text: "  ", providerMetadata: { bedrock: { signature: "" } }, cache },
            ]),
            Message.user([{ type: "text", text: "Continue", cache }]),
          ],
          cache: "none",
        }),
      )
      expect(prepared.body.messages).toEqual([
        {
          role: "user",
          content: [{ text: "Think" }, { text: "Continue" }, { cachePoint: { type: "default" } }],
        },
      ])
    }),
  )

  it.effect("demotes foreign reasoning while preserving signed, redacted, text, and tool blocks", () =>
    Effect.gen(function* () {
      const cache = new CacheHint({ type: "ephemeral" })
      const prepared = yield* compileRequest(
        LLM.request({
          model,
          messages: [
            Message.assistant([
              { type: "reasoning", text: "Foreign thought", providerMetadata: { anthropic: { signature: "old" } } },
              {
                type: "reasoning",
                text: "Signed thought",
                providerMetadata: { bedrock: { signature: "sig_1" } },
                cache,
              },
              { type: "reasoning", text: "", encrypted: "sig_2", cache },
              { type: "reasoning", text: "", providerMetadata: { bedrock: { redactedData: "cmVkYWN0ZWQ=" } }, cache },
              { type: "text", text: "Checking" },
              ToolCallPart.make({ id: "call_1", name: "lookup", input: {} }),
            ]),
          ],
          tools: [{ name: "lookup", description: "Lookup data", inputSchema: { type: "object" } }],
          cache: "none",
        }),
      )
      expect(prepared.body.messages).toEqual([
        {
          role: "assistant",
          content: [
            { text: "Foreign thought" },
            { reasoningContent: { reasoningText: { text: "Signed thought", signature: "sig_1" } } },
            { reasoningContent: { reasoningText: { text: "", signature: "sig_2" } } },
            { reasoningContent: { redactedContent: "cmVkYWN0ZWQ=" } },
            { text: "Checking" },
            { toolUse: { toolUseId: "call_1", name: "lookup", input: {} } },
          ],
        },
      ])
    }),
  )

  it.effect("preserves streamed reasoning signatures for continuation lowering", () =>
    Effect.gen(function* () {
      const body = eventStreamBody(
        ["messageStart", { role: "assistant" }],
        ["contentBlockDelta", { contentBlockIndex: 0, delta: { reasoningContent: { text: "Let me think." } } }],
        ["contentBlockDelta", { contentBlockIndex: 0, delta: { reasoningContent: { signature: "sig_1" } } }],
        ["contentBlockStop", { contentBlockIndex: 0 }],
        ["messageStop", { stopReason: "end_turn" }],
      )
      const response = yield* LLMClient.generate(baseRequest).pipe(Effect.provide(fixedBytes(body)))
      const reasoning = response.events.find((event) => event.type === "reasoning-end")

      expect(reasoning).toEqual({
        type: "reasoning-end",
        id: "reasoning-0",
        providerMetadata: { bedrock: { signature: "sig_1" } },
      })

      const prepared = yield* compileRequest(
        LLM.request({
          model,
          messages: [
            Message.assistant([
              { type: "reasoning", text: "Let me think.", providerMetadata: reasoning?.providerMetadata },
            ]),
          ],
          cache: "none",
        }),
      )
      expect(prepared.body.messages).toEqual([
        {
          role: "assistant",
          content: [{ reasoningContent: { reasoningText: { text: "Let me think.", signature: "sig_1" } } }],
        },
      ])
    }),
  )

  it.effect("round-trips reassigned provider reasoning and usage metadata in its own namespace", () =>
    Effect.gen(function* () {
      const compatible = model.route.with({ provider: "custom-bedrock" }).model({ id: model.id })
      const redactedData = "cmVkYWN0ZWQtdGhpbmtpbmc="
      const response = yield* LLMClient.generate(LLMRequest.update(baseRequest, { model: compatible })).pipe(
        Effect.provide(
          fixedBytes(
            eventStreamBody(
              ["messageStart", { role: "assistant" }],
              ["contentBlockDelta", { contentBlockIndex: 0, delta: { reasoningContent: { text: "Let me think." } } }],
              ["contentBlockDelta", { contentBlockIndex: 0, delta: { reasoningContent: { signature: "custom_sig" } } }],
              ["contentBlockStop", { contentBlockIndex: 0 }],
              [
                "contentBlockDelta",
                { contentBlockIndex: 1, delta: { reasoningContent: { redactedContent: redactedData } } },
              ],
              ["contentBlockStop", { contentBlockIndex: 1 }],
              ["messageStop", { stopReason: "end_turn" }],
              ["metadata", { usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 } }],
            ),
          ),
        ),
      )

      expect(response.message.content).toEqual([
        {
          type: "reasoning",
          text: "Let me think.",
          providerMetadata: { "custom-bedrock": { signature: "custom_sig" } },
        },
        { type: "reasoning", text: "", providerMetadata: { "custom-bedrock": { redactedData } } },
      ])
      expect(response.usage?.providerMetadata).toEqual({
        "custom-bedrock": { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
      })

      const prepared = yield* compileRequest(
        LLM.request({ model: compatible, messages: [response.message], cache: "none" }),
      )
      expect(prepared.body.messages).toEqual([
        {
          role: "assistant",
          content: [
            { reasoningContent: { reasoningText: { text: "Let me think.", signature: "custom_sig" } } },
            { reasoningContent: { redactedContent: redactedData } },
          ],
        },
      ])
    }),
  )

  it.effect("preserves reasoning signatures when contentBlockStop is missing", () =>
    Effect.gen(function* () {
      const response = yield* LLMClient.generate(baseRequest).pipe(
        Effect.provide(
          fixedBytes(
            eventStreamBody(
              ["messageStart", { role: "assistant" }],
              ["contentBlockDelta", { contentBlockIndex: 0, delta: { reasoningContent: { text: "Let me think." } } }],
              ["contentBlockDelta", { contentBlockIndex: 0, delta: { reasoningContent: { signature: "sig_1" } } }],
              ["messageStop", { stopReason: "end_turn" }],
            ),
          ),
        ),
      )

      expect(response.events.find((event) => event.type === "reasoning-delta" && event.text === "")).toEqual({
        type: "reasoning-delta",
        id: "reasoning-0",
        text: "",
        providerMetadata: { bedrock: { signature: "sig_1" } },
      })
      expect(response.message.content).toEqual([
        {
          type: "reasoning",
          text: "Let me think.",
          providerMetadata: { bedrock: { signature: "sig_1" } },
        },
      ])

      const prepared = yield* compileRequest(LLM.request({ model, messages: [response.message], cache: "none" }))
      expect(prepared.body.messages).toEqual([
        {
          role: "assistant",
          content: [{ reasoningContent: { reasoningText: { text: "Let me think.", signature: "sig_1" } } }],
        },
      ])
    }),
  )

  it.effect("preserves signature-only reasoning blocks", () =>
    Effect.gen(function* () {
      const body = eventStreamBody(
        ["messageStart", { role: "assistant" }],
        ["contentBlockDelta", { contentBlockIndex: 0, delta: { reasoningContent: { signature: "sig_1" } } }],
        ["contentBlockStop", { contentBlockIndex: 0 }],
        ["messageStop", { stopReason: "end_turn" }],
      )
      const response = yield* LLMClient.generate(baseRequest).pipe(Effect.provide(fixedBytes(body)))

      expect(response.message.content).toEqual([
        { type: "reasoning", text: "", providerMetadata: { bedrock: { signature: "sig_1" } } },
      ])
    }),
  )

  it.effect("accepts Vercel-compatible redacted reasoning data deltas", () =>
    Effect.gen(function* () {
      const redactedData = "cmVkYWN0ZWQtdGhpbmtpbmc="
      const body = eventStreamBody(
        ["messageStart", { role: "assistant" }],
        ["contentBlockDelta", { contentBlockIndex: 0, delta: { reasoningContent: { data: redactedData } } }],
        ["contentBlockStop", { contentBlockIndex: 0 }],
        ["messageStop", { stopReason: "end_turn" }],
      )
      const response = yield* LLMClient.generate(baseRequest).pipe(Effect.provide(fixedBytes(body)))

      expect(response.events.find((event) => event.type === "reasoning-delta" && event.text === "")).toEqual({
        type: "reasoning-delta",
        id: "reasoning-0",
        text: "",
        providerMetadata: { bedrock: { redactedData } },
      })
      expect(response.message.content).toEqual([
        { type: "reasoning", text: "", providerMetadata: { bedrock: { redactedData } } },
      ])
    }),
  )

  it.effect("round-trips streamed redacted reasoning with tool use into a continuation request", () =>
    Effect.gen(function* () {
      // Bedrock represents redactedContent blobs as base64 strings on its JSON
      // wire. The provider owns the payload and requires byte-exact replay.
      const redactedData = "AQID"
      const response = yield* LLMClient.generate(
        LLMRequest.update(baseRequest, {
          tools: [ToolDefinition.make({ name: "lookup", description: "Lookup data", inputSchema: { type: "object" } })],
        }),
      ).pipe(
        Effect.provide(
          fixedBytes(
            eventStreamBody(
              ["messageStart", { role: "assistant" }],
              ["contentBlockDelta", { contentBlockIndex: 0, delta: { reasoningContent: { redactedContent: "AQ==" } } }],
              ["contentBlockDelta", { contentBlockIndex: 0, delta: { reasoningContent: { redactedContent: "AgM=" } } }],
              ["contentBlockStop", { contentBlockIndex: 0 }],
              [
                "contentBlockStart",
                {
                  contentBlockIndex: 1,
                  start: { toolUse: { toolUseId: "tool_1", name: "lookup" } },
                },
              ],
              ["contentBlockDelta", { contentBlockIndex: 1, delta: { toolUse: { input: '{"query":"weather"}' } } }],
              ["contentBlockStop", { contentBlockIndex: 1 }],
              ["messageStop", { stopReason: "tool_use" }],
            ),
          ),
        ),
      )
      expect(response.events.filter((event) => event.type === "reasoning-delta" && event.text === "").at(-1)).toEqual({
        type: "reasoning-delta",
        id: "reasoning-0",
        text: "",
        providerMetadata: { bedrock: { redactedData } },
      })
      expect(response.events.find((event) => event.type === "reasoning-end")).toEqual({
        type: "reasoning-end",
        id: "reasoning-0",
        providerMetadata: { bedrock: { redactedData } },
      })
      const prepared = yield* compileRequest(
        LLM.request({
          model,
          messages: [
            Message.user("Say hello."),
            response.message,
            Message.tool({ id: "tool_1", name: "lookup", result: "sunny", resultType: "text" }),
          ],
          tools: [{ name: "lookup", description: "Lookup data", inputSchema: { type: "object" } }],
          cache: "none",
        }),
      )

      expect(prepared.body.messages).toEqual([
        { role: "user", content: [{ text: "Say hello." }] },
        {
          role: "assistant",
          content: [
            { reasoningContent: { redactedContent: redactedData } },
            { toolUse: { toolUseId: "tool_1", name: "lookup", input: { query: "weather" } } },
          ],
        },
        {
          role: "user",
          content: [{ toolResult: { toolUseId: "tool_1", content: [{ text: "sunny" }], status: "success" } }],
        },
      ])
    }),
  )

  it.effect("keeps redacted reasoning accumulation separate by content block index", () =>
    Effect.gen(function* () {
      const response = yield* LLMClient.generate(baseRequest).pipe(
        Effect.provide(
          fixedBytes(
            eventStreamBody(
              ["messageStart", { role: "assistant" }],
              ["contentBlockDelta", { contentBlockIndex: 2, delta: { reasoningContent: { redactedContent: "AQ==" } } }],
              ["contentBlockDelta", { contentBlockIndex: 2, delta: { reasoningContent: { redactedContent: "Ag==" } } }],
              ["contentBlockStop", { contentBlockIndex: 2 }],
              ["contentBlockDelta", { contentBlockIndex: 7, delta: { reasoningContent: { redactedContent: "Aw==" } } }],
              ["contentBlockDelta", { contentBlockIndex: 7, delta: { reasoningContent: { redactedContent: "BA==" } } }],
              ["contentBlockStop", { contentBlockIndex: 7 }],
              ["messageStop", { stopReason: "end_turn" }],
            ),
          ),
        ),
      )

      expect(response.message.content).toEqual([
        { type: "reasoning", text: "", providerMetadata: { bedrock: { redactedData: "AQI=" } } },
        { type: "reasoning", text: "", providerMetadata: { bedrock: { redactedData: "AwQ=" } } },
      ])
    }),
  )

  it.effect("preserves split redacted reasoning when contentBlockStop is missing", () =>
    Effect.gen(function* () {
      const response = yield* LLMClient.generate(baseRequest).pipe(
        Effect.provide(
          fixedBytes(
            eventStreamBody(
              ["messageStart", { role: "assistant" }],
              ["contentBlockDelta", { contentBlockIndex: 0, delta: { reasoningContent: { redactedContent: "AQ==" } } }],
              ["contentBlockDelta", { contentBlockIndex: 0, delta: { reasoningContent: { redactedContent: "AgM=" } } }],
              ["messageStop", { stopReason: "end_turn" }],
            ),
          ),
        ),
      )

      expect(response.message.content).toEqual([
        { type: "reasoning", text: "", providerMetadata: { bedrock: { redactedData: "AQID" } } },
      ])
    }),
  )

  it.effect("rejects invalid redacted reasoning base64 with the triggering event", () =>
    Effect.gen(function* () {
      const payload = { contentBlockIndex: 0, delta: { reasoningContent: { redactedContent: "%%==" } } }
      const error = yield* LLMClient.generate(baseRequest).pipe(
        Effect.provide(fixedBytes(eventStreamBody(["contentBlockDelta", payload]))),
        Effect.flip,
      )

      expect(error).toMatchObject({
        reason: { _tag: "InvalidProviderOutput" },
        message: "Bedrock Converse reasoningContent.redactedContent contains invalid base64 data",
      })
      expect(JSON.parse(error.reason.body ?? "")).toMatchObject({
        headers: { ":event-type": { value: "contentBlockDelta" } },
        body: JSON.stringify(payload),
      })
      expect(error.reason.cause).toBeInstanceOf(Error)
    }),
  )

  it.effect("ignores unknown normal stream events", () =>
    Effect.gen(function* () {
      const body = concat([
        eventFrame("messageStart", { role: "assistant" }),
        eventFrame("futureEvent", { message: "Ignore this" }),
        eventFrame("messageStop", { stopReason: "end_turn" }),
      ])
      const response = yield* LLMClient.generate(baseRequest).pipe(Effect.provide(fixedBytes(body)))

      expect(response.finishReason).toEqual({ normalized: "stop", raw: "end_turn" })
    }),
  )

  it.effect("fails unknown stream exceptions after message stop", () =>
    Effect.gen(function* () {
      const body = concat([
        eventFrame("messageStart", { role: "assistant" }),
        eventFrame("messageStop", { stopReason: "end_turn" }),
        exceptionFrame("futureException", { message: "A future provider failure" }),
      ])
      const error = yield* LLMClient.generate(baseRequest).pipe(Effect.provide(fixedBytes(body)), Effect.flip)

      expect(error).toMatchObject({ reason: { _tag: "UnknownProvider" }, message: "A future provider failure" })
    }),
  )

  it.effect("classifies throttlingException as a rate limit", () =>
    Effect.gen(function* () {
      const payload = { message: "Slow down", details: { opaque: [1, 2] }, trace: "outer", p: "padding" }
      const body = concat([
        eventFrame("messageStart", { role: "assistant" }),
        exceptionFrame("throttlingException", payload),
      ])
      const error = yield* LLMClient.generate(baseRequest).pipe(Effect.provide(fixedBytes(body)), Effect.flip)

      expect(error).toMatchObject({ reason: { _tag: "RateLimit" }, message: "Slow down" })
      expect(JSON.parse(error.reason.body ?? "")).toEqual({
        headers: {
          ":message-type": { type: "string", value: "exception" },
          ":exception-type": { type: "string", value: "throttlingException" },
          ":content-type": { type: "string", value: "application/json" },
        },
        body: JSON.stringify(payload),
      })
      expect(error.reason.http).toMatchObject({
        status: 200,
        headers: { "content-type": "application/vnd.amazon.eventstream" },
      })
    }),
  )

  it.effect("classifies input-too-long validation exceptions", () =>
    Effect.gen(function* () {
      const error = yield* LLMClient.generate(baseRequest).pipe(
        Effect.provide(
          fixedBytes(exceptionFrame("validationException", { message: "Input is too long for requested model" })),
        ),
        Effect.flip,
      )

      expect(error).toMatchObject({
        reason: { _tag: "InvalidRequest", classification: "context-overflow" },
        message: "Input is too long for requested model",
      })
    }),
  )

  it.effect("uses originalMessage from model stream exception frames", () =>
    Effect.gen(function* () {
      const error = yield* LLMClient.generate(baseRequest).pipe(
        Effect.provide(
          fixedBytes(
            exceptionFrame("modelStreamErrorException", {
              originalMessage: "Upstream model failed",
              originalStatusCode: 500,
            }),
          ),
        ),
        Effect.flip,
      )

      expect(error).toMatchObject({ reason: { _tag: "ProviderInternal" }, message: "Upstream model failed" })
    }),
  )

  it.effect("fails unmodeled AWS event-stream errors", () =>
    Effect.gen(function* () {
      const error = yield* LLMClient.generate(baseRequest).pipe(
        Effect.provide(fixedBytes(errorFrame("BadStream", "Stream failed"))),
        Effect.flip,
      )

      expect(error).toMatchObject({
        reason: { _tag: "InvalidProviderOutput" },
        message: "BadStream: Stream failed",
      })
      expect(JSON.parse(error.reason.body ?? "")).toMatchObject({
        headers: { ":error-code": { value: "BadStream" } },
        body: "",
      })
    }),
  )

  it.effect("retains malformed AWS payloads with headers and decode cause", () =>
    Effect.gen(function* () {
      const headers = {
        ":message-type": { type: "string" as const, value: "event" },
        ":event-type": { type: "string" as const, value: "messageStart" },
      }
      const body = '{"malformed":'
      const error = yield* LLMClient.generate(baseRequest).pipe(
        Effect.provide(fixedBytes(codec.encode({ headers, body: utf8Encoder.encode(body) }))),
        Effect.flip,
      )
      expect(error.reason._tag).toBe("InvalidProviderOutput")
      expect(JSON.parse(error.reason.body ?? "")).toEqual({ headers, body })
      expect(error.reason.cause).toBeInstanceOf(Error)
      expect(error.reason.http?.status).toBe(200)
    }),
  )

  it.effect("fails with an authentication error when the default chain cannot resolve credentials", () =>
    Effect.gen(function* () {
      const unsignedModel = AmazonBedrock.configure({
        baseURL: "https://bedrock-runtime.test",
        profile: "opencode-test-missing-profile",
      }).model("anthropic.claude-3-5-sonnet-20240620-v1:0")
      const error = yield* LLMClient.generate(LLMRequest.update(baseRequest, { model: unsignedModel })).pipe(
        Effect.provide(fixedBytes(eventStreamBody(["messageStop", { stopReason: "end_turn" }]))),
        Effect.flip,
      )

      expect(error.reason._tag).toBe("Authentication")
      expect(error.message).toContain("AWS default credential chain failed")
    }).pipe(withProcessEnv(noAmbientAWS)),
  )

  it.effect("signs with static credentials using the configured region for the SigV4 scope", () =>
    Effect.gen(function* () {
      const signed = AmazonBedrock.configure({
        baseURL: "https://bedrock-runtime.test",
        region: "eu-west-1",
        credentials: {
          region: "us-east-1",
          accessKeyId: "AKIAIOSFODNN7EXAMPLE",
          secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
        },
      }).model("anthropic.claude-3-5-sonnet-20240620-v1:0")
      const headers = yield* captureHeaders(signed)

      expect(headers.get("authorization")).toContain("Credential=AKIAIOSFODNN7EXAMPLE/")
      expect(headers.get("authorization")).toContain("/eu-west-1/bedrock/aws4_request")
      expect(headers.get("x-amz-security-token")).toBeNull()
    }).pipe(withProcessEnv(noAmbientAWS)),
  )

  it.effect("resolves SigV4 credentials through the AWS default chain on every request", () =>
    Effect.gen(function* () {
      const chained = AmazonBedrock.configure({ baseURL: "https://bedrock-runtime.test", region: "us-west-2" }).model(
        "anthropic.claude-3-5-sonnet-20240620-v1:0",
      )
      const headers = yield* captureHeaders(chained)

      expect(headers.get("authorization")).toContain("Credential=AKIACHAINEXAMPLE/")
      expect(headers.get("authorization")).toContain("/us-west-2/bedrock/aws4_request")
      expect(headers.get("x-amz-security-token")).toBe("chain-session-token")
    }).pipe(
      withProcessEnv({
        ...noAmbientAWS,
        AWS_ACCESS_KEY_ID: "AKIACHAINEXAMPLE",
        AWS_SECRET_ACCESS_KEY: "chain-secret",
        AWS_SESSION_TOKEN: "chain-session-token",
      }),
    ),
  )

  it.effect("re-resolves rotated chain credentials on the next request without rebuilding the model", () =>
    Effect.gen(function* () {
      const chained = AmazonBedrock.configure({ baseURL: "https://bedrock-runtime.test", region: "us-west-2" }).model(
        "anthropic.claude-3-5-sonnet-20240620-v1:0",
      )
      const first = yield* captureHeaders(chained)
      const second = yield* captureHeaders(chained).pipe(
        withProcessEnv({ AWS_ACCESS_KEY_ID: "AKIAROTATEDEXAMPLE", AWS_SECRET_ACCESS_KEY: "rotated-secret" }),
      )

      expect(first.get("authorization")).toContain("Credential=AKIACHAINEXAMPLE/")
      expect(second.get("authorization")).toContain("Credential=AKIAROTATEDEXAMPLE/")
    }).pipe(
      withProcessEnv({
        ...noAmbientAWS,
        AWS_ACCESS_KEY_ID: "AKIACHAINEXAMPLE",
        AWS_SECRET_ACCESS_KEY: "chain-secret",
      }),
    ),
  )

  it.effect("prefers AWS_BEARER_TOKEN_BEDROCK over the credential chain", () =>
    Effect.gen(function* () {
      const bearer = AmazonBedrock.configure({ baseURL: "https://bedrock-runtime.test" }).model(
        "anthropic.claude-3-5-sonnet-20240620-v1:0",
      )
      const headers = yield* captureHeaders(bearer)

      expect(headers.get("authorization")).toBe("Bearer env-bearer-token")
    }).pipe(
      withProcessEnv({
        ...noAmbientAWS,
        AWS_BEARER_TOKEN_BEDROCK: "env-bearer-token",
        AWS_ACCESS_KEY_ID: "AKIACHAINEXAMPLE",
        AWS_SECRET_ACCESS_KEY: "chain-secret",
      }),
    ),
  )

  it.effect("auth: sigv4 ignores an ambient bearer token from configure and settings", () =>
    Effect.gen(function* () {
      const configured = AmazonBedrock.configure({ auth: "sigv4", baseURL: "https://bedrock-runtime.test" }).model(
        "anthropic.claude-3-5-sonnet-20240620-v1:0",
      )
      const fromSettings = AmazonBedrock.model("anthropic.claude-3-5-sonnet-20240620-v1:0", {
        auth: "sigv4",
        baseURL: "https://bedrock-runtime.test",
      })

      for (const target of [configured, fromSettings]) {
        const headers = yield* captureHeaders(target)
        expect(headers.get("authorization")).toContain("Credential=AKIACHAINEXAMPLE/")
        expect(headers.get("authorization")).toContain("/ap-southeast-2/bedrock/aws4_request")
      }
      expect(() => AmazonBedrock.configure({ auth: "sigv4", apiKey: "k" })).toThrow(
        expect.objectContaining({
          _tag: "ProviderConfiguration",
          provider: "amazon-bedrock",
          message: "Amazon Bedrock SigV4 auth does not accept apiKey",
        }),
      )
    }).pipe(
      withProcessEnv({
        ...noAmbientAWS,
        AWS_BEARER_TOKEN_BEDROCK: "env-bearer-token",
        AWS_REGION: "ap-southeast-2",
        AWS_ACCESS_KEY_ID: "AKIACHAINEXAMPLE",
        AWS_SECRET_ACCESS_KEY: "chain-secret",
      }),
    ),
  )

  it.effect("derives the endpoint region from AWS_REGION then AWS_DEFAULT_REGION", () =>
    Effect.gen(function* () {
      const fromRegion = AmazonBedrock.configure({ apiKey: "k" }).model("anthropic.claude-3-5-sonnet-20240620-v1:0")
      expect(fromRegion.route.endpoint.baseURL).toBe("https://bedrock-runtime.eu-central-1.amazonaws.com")

      const fromDefault = yield* Effect.sync(() =>
        AmazonBedrock.configure({ apiKey: "k" }).model("anthropic.claude-3-5-sonnet-20240620-v1:0"),
      ).pipe(withProcessEnv({ AWS_REGION: undefined }))
      expect(fromDefault.route.endpoint.baseURL).toBe("https://bedrock-runtime.us-gov-west-1.amazonaws.com")
    }).pipe(withProcessEnv({ ...noAmbientAWS, AWS_REGION: "eu-central-1", AWS_DEFAULT_REGION: "us-gov-west-1" })),
  )

  it.effect("emits cachePoint markers after system, user-text, and assistant-text with cache hints", () =>
    Effect.gen(function* () {
      const cache = new CacheHint({ type: "ephemeral" })
      const prepared = yield* compileRequest(
        LLM.request({
          id: "req_cache",
          model,
          system: [{ type: "text", text: "System prefix.", cache }],
          messages: [
            Message.user([{ type: "text", text: "User prefix.", cache }]),
            Message.assistant([{ type: "text", text: "Assistant prefix.", cache }]),
          ],
          generation: { maxTokens: 16, temperature: 0 },
        }),
      )

      expect(prepared.body).toMatchObject({
        // System: text block followed by cachePoint marker.
        system: [{ text: "System prefix." }, { cachePoint: { type: "default" } }],
        messages: [
          {
            role: "user",
            content: [{ text: "User prefix." }, { cachePoint: { type: "default" } }],
          },
          {
            role: "assistant",
            content: [{ text: "Assistant prefix." }, { cachePoint: { type: "default" } }],
          },
        ],
      })
    }),
  )

  it.effect("does not emit cachePoint when no cache hint is set", () =>
    Effect.gen(function* () {
      const prepared = yield* compileRequest(baseRequest)
      expect(prepared.body).toMatchObject({
        system: [{ text: "You are concise." }],
        messages: [{ role: "user", content: [{ text: "Say hello." }] }],
      })
    }),
  )

  it.effect("lowers image media into Bedrock image blocks", () =>
    Effect.gen(function* () {
      const prepared = yield* compileRequest(
        LLM.request({
          id: "req_image",
          model,
          messages: [
            Message.user([
              { type: "text", text: "What is in this image?" },
              { type: "media", mediaType: "image/png", data: "AAAA" },
              { type: "media", mediaType: "image/jpeg", data: "BBBB" },
              { type: "media", mediaType: "image/jpg", data: "CCCC" },
              { type: "media", mediaType: "image/webp", data: "DDDD" },
            ]),
          ],
          cache: "none",
        }),
      )

      expect(prepared.body).toMatchObject({
        messages: [
          {
            role: "user",
            content: [
              { text: "What is in this image?" },
              { image: { format: "png", source: { bytes: "AAAA" } } },
              { image: { format: "jpeg", source: { bytes: "BBBB" } } },
              // image/jpg is a non-standard alias; we map it to jpeg.
              { image: { format: "jpeg", source: { bytes: "CCCC" } } },
              { image: { format: "webp", source: { bytes: "DDDD" } } },
            ],
          },
        ],
      })
    }),
  )

  it.effect("base64-encodes Uint8Array image bytes", () =>
    Effect.gen(function* () {
      const prepared = yield* compileRequest(
        LLM.request({
          id: "req_image_bytes",
          model,
          messages: [Message.user([{ type: "media", mediaType: "image/png", data: new Uint8Array([1, 2, 3, 4, 5]) }])],
        }),
      )

      // Buffer.from([1,2,3,4,5]).toString("base64") === "AQIDBAU="
      expect(prepared.body).toMatchObject({
        messages: [
          {
            role: "user",
            content: [{ image: { format: "png", source: { bytes: "AQIDBAU=" } } }],
          },
        ],
      })
    }),
  )

  it.effect("rejects image media that is not valid base64", () =>
    Effect.gen(function* () {
      const error = yield* compileRequest(
        LLM.request({
          model,
          messages: [Message.user({ type: "media", mediaType: "image/png", data: "https://example.test/image.png" })],
        }),
      ).pipe(Effect.flip)

      expect(error).toMatchObject({ reason: { _tag: "InvalidRequest" } })
      expect(error.message).toContain("Bedrock Converse media data must be valid base64")
    }),
  )

  it.effect("lowers document media into Bedrock document blocks with format and name", () =>
    Effect.gen(function* () {
      const prepared = yield* compileRequest(
        LLM.request({
          id: "req_doc",
          model,
          cache: "none",
          messages: [
            Message.user([
              { type: "text", text: "Summarize these documents." },
              { type: "media", mediaType: "application/pdf", data: "UERGREFUQQ==", filename: "report.pdf" },
              { type: "media", mediaType: "text/csv", data: "Q1NWREFUQQ==", filename: "data.csv" },
            ]),
          ],
        }),
      )

      expect(prepared.body).toMatchObject({
        messages: [
          {
            role: "user",
            content: [
              { text: "Summarize these documents." },
              { text: 'Attached file "report.pdf" has document label "report".' },
              { document: { format: "pdf", name: "report", source: { bytes: "UERGREFUQQ==" } } },
              { text: 'Attached file "data.csv" has document label "data".' },
              { document: { format: "csv", name: "data", source: { bytes: "Q1NWREFUQQ==" } } },
            ],
          },
        ],
      })
    }),
  )
  ;[
    {
      label: "filename punctuation",
      filename: "report_v1.2?.pdf",
      expected: "report v1 2",
      duplicate: "report v1 2 2",
    },
    {
      label: "repeated whitespace",
      filename: "  Quarterly\t \n report.txt",
      expected: "Quarterly report",
      duplicate: "Quarterly report 2",
    },
    {
      label: "allowed characters",
      filename: "Report - Final (v2) [2026]",
      expected: "Report - Final (v2) [2026]",
      duplicate: "Report - Final (v2) [2026] 2",
    },
    { label: "accented filename", filename: "résumé.pdf", expected: "r sum", duplicate: "r sum 2" },
    { label: "non-Latin filename", filename: "報告書.pdf", expected: "document", duplicate: "document 2" },
    { label: "missing filename", filename: undefined, expected: "document", duplicate: "document 2" },
    { label: "empty filename", filename: "", expected: "document", duplicate: "document 2" },
    { label: "blank filename", filename: " \t\n", expected: "document", duplicate: "document 2" },
    { label: "extension-only filename", filename: ".pdf", expected: "document", duplicate: "document 2" },
    { label: "symbols-only filename", filename: "@@@.pdf", expected: "document", duplicate: "document 2" },
    {
      label: "overlong filename",
      filename: `${"a".repeat(201)}.txt`,
      expected: "a".repeat(200),
      duplicate: `${"a".repeat(198)} 2`,
    },
    {
      label: "maximum-length label",
      filename: "a".repeat(200),
      expected: "a".repeat(200),
      duplicate: `${"a".repeat(198)} 2`,
    },
    {
      label: "whitespace at truncation",
      filename: `${"a".repeat(199)} b.txt`,
      expected: "a".repeat(199),
      duplicate: `${"a".repeat(198)} 2`,
    },
  ].forEach((item) => {
    it.effect(`normalizes ${item.label} in user and tool-result documents`, () =>
      Effect.gen(function* () {
        const request = LLM.request({
          model,
          cache: "none",
          messages: [
            Message.user([
              { type: "text", text: "Read this document" },
              { type: "media", mediaType: "application/pdf", data: "UERGREFUQQ==", filename: item.filename },
            ]),
            Message.assistant([ToolCallPart.make({ id: "call_read", name: "read", input: {} })]),
            Message.tool({
              id: "call_read",
              name: "read",
              result: {
                type: "content",
                value: [
                  { type: "text", text: "Read successfully" },
                  {
                    type: "file",
                    uri: "data:application/pdf;base64,UERGREFUQQ==",
                    mime: "application/pdf",
                    name: item.filename,
                  },
                ],
              },
            }),
          ],
        })
        const original = JSON.stringify(request.messages)
        const first = yield* compileRequest(request)
        const second = yield* compileRequest(request)
        const expected = { format: "pdf", name: item.expected, source: { bytes: "UERGREFUQQ==" } }

        expect(first.body.messages[0].content.find((part) => "document" in part)?.document).toEqual(expected)
        expect(
          first.body.messages[2].content[0].toolResult.content.find((part) => "document" in part)?.document,
        ).toEqual({
          ...expected,
          name: item.duplicate,
        })
        expect(second.body).toEqual(first.body)
        expect(JSON.stringify(request.messages)).toBe(original)
      }),
    )
  })

  it.effect("keeps colliding document labels distinct within a request", () =>
    Effect.gen(function* () {
      const prepared = yield* compileRequest(
        LLM.request({
          model,
          cache: "none",
          messages: [
            Message.user([
              { type: "text", text: "Read these documents" },
              ...["report_v1.txt", "report#v1.txt", "report v1 2.txt", "report v1.txt"].map((filename) => ({
                type: "media" as const,
                mediaType: "text/plain",
                data: "SGVsbG8=",
                filename,
              })),
            ]),
          ],
        }),
      )
      expect(prepared.body.messages[0].content.slice(1)).toEqual([
        { text: 'Attached file "report_v1.txt" has document label "report v1".' },
        { document: { format: "txt", name: "report v1", source: { bytes: "SGVsbG8=" } } },
        { text: 'Attached file "report#v1.txt" has document label "report v1 2".' },
        { document: { format: "txt", name: "report v1 2", source: { bytes: "SGVsbG8=" } } },
        { text: 'Attached file "report v1 2.txt" has document label "report v1 2 2".' },
        { document: { format: "txt", name: "report v1 2 2", source: { bytes: "SGVsbG8=" } } },
        { text: 'Attached file "report v1.txt" has document label "report v1 3".' },
        { document: { format: "txt", name: "report v1 3", source: { bytes: "SGVsbG8=" } } },
      ])
    }),
  )

  it.effect("annotates renamed document-only messages with their original filename", () =>
    Effect.gen(function* () {
      const prepared = yield* compileRequest(
        LLM.request({
          model,
          cache: "none",
          messages: [
            Message.user({
              type: "media",
              mediaType: "application/pdf",
              data: "UERGREFUQQ==",
              filename: "report.pdf",
            }),
          ],
        }),
      )

      expect(prepared.body.messages).toEqual([
        {
          role: "user",
          content: [
            { text: 'Attached file "report.pdf" has document label "report".' },
            { document: { format: "pdf", name: "report", source: { bytes: "UERGREFUQQ==" } } },
          ],
        },
      ])
    }),
  )

  it.effect("quotes original filenames in annotations and omits redundant mappings", () =>
    Effect.gen(function* () {
      const prepared = yield* compileRequest(
        LLM.request({
          model,
          cache: "none",
          messages: [
            Message.user([
              { type: "text", text: "Read these documents" },
              ...["report", undefined, 'report "final"\n.pdf'].map((filename) => ({
                type: "media" as const,
                mediaType: "text/plain",
                data: "SGVsbG8=",
                filename,
              })),
            ]),
          ],
        }),
      )
      expect(prepared.body.messages[0].content).toEqual([
        { text: "Read these documents" },
        { document: { format: "txt", name: "report", source: { bytes: "SGVsbG8=" } } },
        { document: { format: "txt", name: "document", source: { bytes: "SGVsbG8=" } } },
        { text: 'Attached file "report \\"final\\"\\n.pdf" has document label "report final".' },
        { document: { format: "txt", name: "report final", source: { bytes: "SGVsbG8=" } } },
      ])
    }),
  )

  it.effect("lowers document media in tool results", () =>
    Effect.gen(function* () {
      const prepared = yield* compileRequest(
        LLM.request({
          model,
          cache: "none",
          messages: [
            Message.assistant([ToolCallPart.make({ id: "call_1", name: "read", input: { path: "report.pdf" } })]),
            Message.tool({
              id: "call_1",
              name: "read",
              result: {
                type: "content",
                value: [
                  { type: "text", text: "Read successfully" },
                  {
                    type: "file",
                    uri: "data:application/pdf;base64,UERGREFUQQ==",
                    mime: "application/pdf",
                    name: "report.pdf",
                  },
                ],
              },
            }),
          ],
        }),
      )

      expect(prepared.body.messages).toEqual([
        {
          role: "assistant",
          content: [{ toolUse: { toolUseId: "call_1", name: "read", input: { path: "report.pdf" } } }],
        },
        {
          role: "user",
          content: [
            {
              toolResult: {
                toolUseId: "call_1",
                status: "success",
                content: [
                  { text: "Read successfully" },
                  { text: 'Attached file "report.pdf" has document label "report".' },
                  { document: { format: "pdf", name: "report", source: { bytes: "UERGREFUQQ==" } } },
                ],
              },
            },
          ],
        },
      ])
    }),
  )

  it.effect("rejects remote media URLs in tool results", () =>
    Effect.gen(function* () {
      const error = yield* compileRequest(
        LLM.request({
          model,
          messages: [
            Message.assistant([ToolCallPart.make({ id: "call_1", name: "read", input: {} })]),
            Message.tool({
              id: "call_1",
              name: "read",
              result: {
                type: "content",
                value: [
                  {
                    type: "file",
                    uri: "https://example.test/report.pdf",
                    mime: "application/pdf",
                    name: "report.pdf",
                  },
                ],
              },
            }),
          ],
        }),
      ).pipe(Effect.flip)

      expect(error).toMatchObject({ reason: { _tag: "InvalidRequest" } })
      expect(error.message).toContain("Bedrock Converse media data must be valid base64")
    }),
  )

  it.effect("rejects unsupported image media types", () =>
    Effect.gen(function* () {
      const error = yield* compileRequest(
        LLM.request({
          id: "req_bad_image",
          model,
          messages: [Message.user([{ type: "media", mediaType: "image/svg+xml", data: "x" }])],
        }),
      ).pipe(Effect.flip)

      expect(error.message).toContain("Bedrock Converse does not support image media type image/svg+xml")
    }),
  )

  it.effect("rejects unsupported document media types", () =>
    Effect.gen(function* () {
      const error = yield* compileRequest(
        LLM.request({
          id: "req_bad_doc",
          model,
          messages: [Message.user([{ type: "media", mediaType: "application/x-tar", data: "x", filename: "a.tar" }])],
        }),
      ).pipe(Effect.flip)

      expect(error.message).toContain("Bedrock Converse does not support media type application/x-tar")
    }),
  )

  it.effect("maps ttlSeconds >= 3600 to cachePoint ttl: '1h'", () =>
    Effect.gen(function* () {
      const cache = new CacheHint({ type: "ephemeral", ttlSeconds: 3600 })
      const prepared = yield* compileRequest(
        LLM.request({
          model,
          system: [{ type: "text", text: "system", cache }],
          prompt: "hi",
        }),
      )

      expect(prepared.body).toMatchObject({
        system: [{ text: "system" }, { cachePoint: { type: "default", ttl: "1h" } }],
      })
    }),
  )

  it.effect("appends cachePoint after marked tool definitions and tool-result blocks", () =>
    Effect.gen(function* () {
      const cache = new CacheHint({ type: "ephemeral" })
      const prepared = yield* compileRequest(
        LLM.request({
          model,
          tools: [{ name: "lookup", description: "lookup", inputSchema: { type: "object", properties: {} }, cache }],
          messages: [
            Message.user("What's the weather?"),
            Message.assistant([ToolCallPart.make({ id: "call_1", name: "lookup", input: {} })]),
            Message.tool({ id: "call_1", name: "lookup", result: { temp: 72 }, cache }),
          ],
          cache: "none",
        }),
      )

      expect(prepared.body).toMatchObject({
        toolConfig: {
          tools: [{ toolSpec: { name: "lookup" } }, { cachePoint: { type: "default" } }],
        },
        messages: [
          { role: "user", content: [{ text: "What's the weather?" }] },
          { role: "assistant", content: [{ toolUse: { toolUseId: "call_1" } }] },
          {
            role: "user",
            content: [{ toolResult: { toolUseId: "call_1" } }, { cachePoint: { type: "default" } }],
          },
        ],
      })
    }),
  )

  it.effect("drops cachePoint markers past the 4-per-request cap", () =>
    Effect.gen(function* () {
      const cache = new CacheHint({ type: "ephemeral" })
      const prepared = yield* compileRequest(
        LLM.request({
          model,
          system: [
            { type: "text", text: "a", cache },
            { type: "text", text: "b", cache },
            { type: "text", text: "c", cache },
            { type: "text", text: "d", cache },
            { type: "text", text: "e", cache },
            { type: "text", text: "f", cache },
          ],
          prompt: "hi",
        }),
      )

      const system = (prepared.body as { system: Array<{ cachePoint?: unknown }> }).system
      expect(system.filter((part) => "cachePoint" in part)).toHaveLength(4)
    }),
  )
})

// Live recorded integration tests. Run with `RECORD=true AWS_ACCESS_KEY_ID=...
// AWS_SECRET_ACCESS_KEY=... [AWS_SESSION_TOKEN=...] bun run test ...` to refresh
// cassettes; replay is the default and works without credentials.
//
// Region is pinned to us-east-1 in tests so the request URL is stable across
// machines on replay. If you need to record from a different region (e.g. your
// account has access elsewhere), pass `BEDROCK_RECORDING_REGION=eu-west-1` —
// but then commit the resulting cassette and others should record from the
// same region too.
const RECORDING_REGION = process.env.BEDROCK_RECORDING_REGION ?? "us-east-1"

const recordedModel = () =>
  AmazonBedrock.configure({
    // Most newer Anthropic models on Bedrock require a cross-region inference
    // profile (`us.` prefix). Nova does not require an Anthropic use-case form
    // and is on-demand-throughput accessible by default for most accounts.
    credentials: {
      region: RECORDING_REGION,
      accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "fixture",
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "fixture",
      sessionToken: process.env.AWS_SESSION_TOKEN,
    },
  }).model(process.env.BEDROCK_MODEL_ID ?? "us.amazon.nova-micro-v1:0")

const recorded = recordedTests({
  prefix: "bedrock-converse",
  provider: "amazon-bedrock",
  protocol: "bedrock-converse",
  requires: ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"],
})

describe("Bedrock Converse recorded", () => {
  recorded.effect("streams text", () =>
    Effect.gen(function* () {
      const llm = yield* LLMClient.Service
      const response = yield* llm.generate(
        LLM.request({
          id: "recorded_bedrock_text",
          model: recordedModel(),
          system: "Reply with the single word 'Hello'.",
          prompt: "Say hello.",
          cache: "none",
          generation: { maxTokens: 16, temperature: 0 },
        }),
      )

      expect(eventSummary(response.events)).toEqual([
        { type: "text", value: "Hello" },
        { type: "finish", reason: "stop", usage: { inputTokens: 12, outputTokens: 2, totalTokens: 14 } },
      ])
    }),
  )

  recorded.effect.with("streams a tool call", { tags: ["tool"] }, () =>
    Effect.gen(function* () {
      const llm = yield* LLMClient.Service
      const response = yield* llm.generate(
        LLM.request({
          id: "recorded_bedrock_tool_call",
          model: recordedModel(),
          system: "Call tools exactly as requested.",
          prompt: "Call get_weather with city exactly Paris.",
          tools: [weatherTool],
          toolChoice: ToolChoice.make(weatherTool),
          cache: "none",
          generation: { maxTokens: 80, temperature: 0 },
        }),
      )

      expect(eventSummary(response.events)).toEqual([
        { type: "tool-call", name: weatherToolName, input: { city: "Paris" } },
        { type: "finish", reason: "tool-calls", usage: { inputTokens: 419, outputTokens: 16, totalTokens: 435 } },
      ])
    }),
  )

  recorded.effect.with("drives a tool loop", { tags: ["tool", "tool-loop", "golden"] }, () =>
    Effect.gen(function* () {
      expectWeatherToolLoop(
        yield* runWeatherToolLoop(
          weatherToolLoopRequest({
            id: "recorded_bedrock_tool_loop",
            model: recordedModel(),
          }),
        ),
      )
    }),
  )

  recorded.effect.with("continues after parallel tool results", { tags: ["tool", "tool-loop", "parallel"] }, () =>
    Effect.gen(function* () {
      const response = yield* LLMClient.generate(
        LLM.request({
          id: "recorded_bedrock_parallel_tool_results",
          model: recordedModel(),
          system: "After receiving both tool results, reply exactly: Paris is sunny; London is rainy.",
          messages: [
            Message.user("Compare the weather in Paris and London."),
            Message.assistant([
              ToolCallPart.make({ id: "weather_paris", name: weatherToolName, input: { city: "Paris" } }),
              ToolCallPart.make({ id: "weather_london", name: weatherToolName, input: { city: "London" } }),
            ]),
            Message.tool({
              id: "weather_paris",
              name: weatherToolName,
              result: { temperature: 22, condition: "sunny" },
            }),
            Message.tool({
              id: "weather_london",
              name: weatherToolName,
              result: { temperature: 14, condition: "rainy" },
            }),
          ],
          tools: [weatherTool],
          cache: "none",
          generation: { maxTokens: 40, temperature: 0 },
        }),
      )

      expect(response.text.trim()).toBe("Paris is sunny; London is rainy.")
      expect(response.finishReason?.normalized).toBe("stop")
    }),
  )
})
