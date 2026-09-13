import { describe, expect, test } from "bun:test"
import { Content } from "@opencode/schema/tool"
import { Effect, Schema, Stream } from "effect"
import {
  GenerationOptions,
  LLM,
  LLMEvent,
  LLMRequest,
  LLMResponse,
  ToolCallPart,
  ToolChoice,
  ToolOutput,
  toDefinitions,
} from "../src/index.js"
import { Auth, LLMClient } from "../src/route.js"
import * as AnthropicMessages from "../src/protocols/anthropic-messages.js"
import * as OpenAIChat from "../src/protocols/openai-chat.js"
import * as OpenAIResponses from "../src/protocols/openai-responses.js"
import { Tool, ToolFailure, type ToolExecuteContext } from "../src/tool.js"
import { ToolRuntime } from "../src/tool-runtime.js"
import { it } from "./lib/effect.js"
import * as TestToolRuntime from "./lib/tool-runtime.js"
import { dynamicResponse, scriptedResponses } from "./lib/http.js"
import { deltaChunk, finishChunk, toolCallChunk } from "./lib/openai-chunks.js"
import { sseEvents } from "./lib/sse.js"

const model = OpenAIChat.route
  .with({ endpoint: { baseURL: "https://api.openai.test/v1/" }, auth: Auth.bearer("test") })
  .model({ id: "gpt-4o-mini" })
const Json = Schema.fromJsonString(Schema.Unknown)
const decodeJson = Schema.decodeUnknownSync(Json)

const baseRequest = LLM.request({
  id: "req_1",
  model,
  prompt: "Use the tool.",
})
const weatherFailureCause = new Error("weather lookup denied")

test("dispatches namespaced calls by qualified identity", async () => {
  let context: ToolExecuteContext | undefined
  const lookup = Tool.make({
    description: "Look up a customer.",
    parameters: Schema.Struct({}),
    success: Schema.String,
    execute: (_, value) => {
      context = value
      return Effect.succeed("customer")
    },
  })
  const call = ToolCallPart.make({ id: "call_1", namespace: "crm", name: "lookup", input: {} })
  const result = await Effect.runPromise(
    ToolRuntime.dispatch({ "crm.lookup": lookup, lookup: schema_only_weather }, call),
  )

  expect(result.result).toEqual({ type: "text", value: "customer" })
  expect(context).toEqual({ id: "call_1", namespace: "crm", name: "lookup" })
  expect(result.events).toEqual([expect.objectContaining({ type: "tool-result", namespace: "crm", name: "lookup" })])
})

const get_weather = Tool.make({
  description: "Get current weather for a city.",
  parameters: Schema.Struct({ city: Schema.String }),
  success: Schema.Struct({ temperature: Schema.Number, condition: Schema.String }),
  execute: ({ city }) =>
    Effect.gen(function* () {
      if (city === "FAIL")
        return yield* new ToolFailure({ message: `Weather lookup failed for ${city}`, error: weatherFailureCause })
      return { temperature: 22, condition: "sunny" }
    }),
})

const schema_only_weather = Tool.make({
  description: "Get current weather for a city.",
  parameters: Schema.Struct({ city: Schema.String }),
  success: Schema.Struct({ temperature: Schema.Number, condition: Schema.String }),
})

describe("LLMClient tools", () => {
  it.effect("uses the selected model route when adding runtime tools", () =>
    Effect.gen(function* () {
      const layer = scriptedResponses([
        sseEvents(deltaChunk({ role: "assistant", content: "Done." }), finishChunk("stop")),
      ])

      const events = Array.from(
        yield* TestToolRuntime.runTools({ request: baseRequest, tools: { get_weather } }).pipe(
          Stream.runCollect,
          Effect.provide(layer),
        ),
      )

      expect(LLMResponse.text({ events })).toBe("Done.")
    }),
  )

  it.effect("sends tool-call history and request options on the follow-up request", () =>
    Effect.gen(function* () {
      const bodies: unknown[] = []
      const responses = [
        sseEvents(toolCallChunk("call_1", "get_weather", '{"city":"Paris"}'), finishChunk("tool_calls")),
        sseEvents(deltaChunk({ role: "assistant", content: "It's sunny in Paris." }), finishChunk("stop")),
      ]
      const layer = dynamicResponse((input) =>
        Effect.sync(() => {
          bodies.push(decodeJson(input.text))
          return input.respond(responses[bodies.length - 1] ?? responses[responses.length - 1], {
            headers: { "content-type": "text/event-stream" },
          })
        }),
      )

      yield* TestToolRuntime.runTools({
        request: LLMRequest.update(baseRequest, {
          generation: GenerationOptions.make({ maxTokens: 50 }),
          toolChoice: ToolChoice.make("auto"),
        }),
        tools: { get_weather },
      }).pipe(Stream.runCollect, Effect.provide(layer))

      const second = bodies[1]
      if (!second || typeof second !== "object") throw new Error("Expected second request body")
      const messages = Reflect.get(second, "messages")
      const tools = Reflect.get(second, "tools")

      expect(Reflect.get(second, "max_completion_tokens")).toBe(50)
      expect(Reflect.get(second, "tool_choice")).toBe("auto")
      expect(tools).toHaveLength(1)
      expect(
        Array.isArray(messages)
          ? messages.map((message) =>
              message && typeof message === "object" ? Reflect.get(message, "role") : undefined,
            )
          : undefined,
      ).toEqual(["user", "assistant", "tool"])
      expect(Array.isArray(messages) ? messages[1] : undefined).toMatchObject({
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call_1", type: "function", function: { name: "get_weather" } }],
      })
      expect(Array.isArray(messages) ? messages[2] : undefined).toMatchObject({
        role: "tool",
        tool_call_id: "call_1",
        content: '{"temperature":22,"condition":"sunny"}',
      })
    }),
  )

  it.effect("dispatches a tool call, appends results, and resumes streaming", () =>
    Effect.gen(function* () {
      const layer = scriptedResponses([
        sseEvents(toolCallChunk("call_1", "get_weather", '{"city":"Paris"}'), finishChunk("tool_calls")),
        sseEvents(deltaChunk({ role: "assistant", content: "It's sunny in Paris." }), finishChunk("stop")),
      ])

      const events = Array.from(
        yield* TestToolRuntime.runTools({ request: baseRequest, tools: { get_weather } }).pipe(
          Stream.runCollect,
          Effect.provide(layer),
        ),
      )

      const result = events.find(LLMEvent.is.toolResult)
      expect(result).toMatchObject({
        type: "tool-result",
        id: "call_1",
        name: "get_weather",
        result: { type: "json", value: { temperature: 22, condition: "sunny" } },
      })
      expect(events.at(-1)?.type).toBe("finish")
      expect(LLMResponse.text({ events })).toBe("It's sunny in Paris.")
    }),
  )

  it.effect("projects encoded typed tool success into canonical model content", () =>
    Effect.gen(function* () {
      const calls: unknown[] = []
      const projected = Tool.make({
        description: "Project an encoded success.",
        parameters: Schema.Struct({ prefix: Schema.String }),
        success: Schema.Struct({ count: Schema.NumberFromString }),
        execute: () => Effect.succeed({ count: 2 }),
        toModelOutput: (input) => {
          calls.push(input)
          return [{ type: "text", text: `${input.parameters.prefix}:${input.output.count}` }]
        },
      })

      const dispatched = yield* ToolRuntime.dispatch(
        { projected },
        LLMEvent.toolCall({ id: "call_projected", name: "projected", input: { prefix: "count" } }),
      )

      expect(calls).toEqual([{ id: "call_projected", parameters: { prefix: "count" }, output: { count: "2" } }])
      expect(dispatched.result).toEqual({ type: "text", value: "count:2" })
      expect(dispatched.output).toEqual({ structured: { count: "2" }, content: [{ type: "text", text: "count:2" }] })
      expect(dispatched.events).toEqual([
        LLMEvent.toolResult({
          id: "call_projected",
          name: "projected",
          result: { type: "text", value: "count:2" },
          output: { structured: { count: "2" }, content: [{ type: "text", text: "count:2" }] },
        }),
      ])
    }),
  )

  it.effect("preserves provider metadata on dispatched tool results", () =>
    Effect.gen(function* () {
      const tool = Tool.make({
        description: "Return text.",
        parameters: Schema.Struct({}),
        success: Schema.String,
        execute: () => Effect.succeed("hello"),
      })
      const providerMetadata = { google: { thoughtSignature: "provider_sig" } }
      const dispatched = yield* ToolRuntime.dispatch(
        { tool },
        LLMEvent.toolCall({ id: "call_1", name: "tool", input: {}, providerMetadata }),
      )

      expect(dispatched.events).toEqual([
        LLMEvent.toolResult({
          id: "call_1",
          name: "tool",
          result: { type: "text", value: "hello" },
          output: { structured: "hello", content: [{ type: "text", text: "hello" }] },
          providerMetadata,
        }),
      ])

      const failed = yield* ToolRuntime.dispatch(
        {},
        LLMEvent.toolCall({ id: "call_2", name: "missing", input: {}, providerMetadata }),
      )
      expect(failed.events).toEqual([
        LLMEvent.toolError({
          id: "call_2",
          name: "missing",
          message: 'No tool named "missing" is currently available. Please use a tool from the available tool list.',
          providerMetadata,
        }),
        LLMEvent.toolResult({
          id: "call_2",
          name: "missing",
          result: {
            type: "error",
            value: 'No tool named "missing" is currently available. Please use a tool from the available tool list.',
          },
          providerMetadata,
        }),
      ])
    }),
  )

  it.effect("uses the narrow default projection for encoded typed success", () =>
    Effect.gen(function* () {
      const text = Tool.make({
        description: "Return text.",
        parameters: Schema.Struct({}),
        success: Schema.String,
        execute: () => Effect.succeed("hello"),
      })
      const json = Tool.make({
        description: "Return JSON.",
        parameters: Schema.Struct({}),
        success: Schema.Struct({ ok: Schema.Boolean }),
        execute: () => Effect.succeed({ ok: true }),
      })

      expect(
        (yield* ToolRuntime.dispatch({ text }, LLMEvent.toolCall({ id: "call_text", name: "text", input: {} }))).output,
      ).toEqual({ structured: "hello", content: [{ type: "text", text: "hello" }] })
      expect(
        (yield* ToolRuntime.dispatch({ json }, LLMEvent.toolCall({ id: "call_json", name: "json", input: {} }))).output,
      ).toEqual({ structured: { ok: true }, content: [] })
    }),
  )

  it.effect("can retain model media while redacting duplicated structured payloads", () =>
    Effect.gen(function* () {
      const image = Tool.make({
        description: "Return an image.",
        parameters: Schema.Struct({}),
        success: Schema.Struct({ mime: Schema.String, data: Schema.String }),
        execute: () => Effect.succeed({ mime: "image/png", data: "AAECAw==" }),
        toStructuredOutput: (output) => ({ mime: output.mime }),
        toModelOutput: ({ output }) => [
          { type: "file", uri: `data:${output.mime};base64,${output.data}`, mime: output.mime },
        ],
      })

      const dispatched = yield* ToolRuntime.dispatch(
        { image },
        LLMEvent.toolCall({ id: "call_image", name: "image", input: {} }),
      )

      expect(dispatched.output).toEqual({
        structured: { mime: "image/png" },
        content: [{ type: "file", uri: "data:image/png;base64,AAECAw==", mime: "image/png" }],
      })
    }),
  )

  test("models canonical tool files with URIs", () => {
    const decode = Schema.decodeUnknownSync(Content)

    expect(decode({ type: "file", uri: "data:image/png;base64,AAAA", mime: "image/png" })).toEqual({
      type: "file",
      uri: "data:image/png;base64,AAAA",
      mime: "image/png",
    })
    expect(decode({ type: "file", uri: "https://example.test/image.png", mime: "image/png" })).toEqual({
      type: "file",
      uri: "https://example.test/image.png",
      mime: "image/png",
    })
    expect(decode({ type: "file", uri: "file:///tmp/image.png", mime: "image/png" })).toEqual({
      type: "file",
      uri: "file:///tmp/image.png",
      mime: "image/png",
    })
  })

  test("preserves canonical tool file URIs", () => {
    expect(
      ToolOutput.toResultValue(
        ToolOutput.make({}, [{ type: "file", uri: "data:image/png;base64,AAAA", mime: "image/png" }]),
      ),
    ).toEqual({
      type: "content",
      value: [{ type: "file", uri: "data:image/png;base64,AAAA", mime: "image/png" }],
    })
    expect(
      ToolOutput.toResultValue(
        ToolOutput.make({}, [{ type: "file", uri: "https://example.test/image.png", mime: "image/png" }]),
      ),
    ).toEqual({
      type: "content",
      value: [{ type: "file", uri: "https://example.test/image.png", mime: "image/png" }],
    })
    expect(
      ToolOutput.toResultValue(
        ToolOutput.make({}, [{ type: "file", uri: "file:///tmp/image.png", mime: "image/png" }]),
      ),
    ).toEqual({
      type: "content",
      value: [{ type: "file", uri: "file:///tmp/image.png", mime: "image/png" }],
    })
    expect(
      ToolOutput.fromResultValue({
        type: "content",
        value: [{ type: "file", uri: "https://example.test/image.png", mime: "image/png" }],
      }),
    ).toEqual({
      structured: {},
      content: [{ type: "file", uri: "https://example.test/image.png", mime: "image/png" }],
    })
  })

  it.effect("settles projected URL files as canonical tool results", () =>
    Effect.gen(function* () {
      const remote = Tool.make({
        description: "Return a remote file.",
        parameters: Schema.Struct({}),
        success: Schema.Struct({ ok: Schema.Boolean }),
        execute: () => Effect.succeed({ ok: true }),
        toModelOutput: () => [{ type: "file", uri: "https://example.test/image.png", mime: "image/png" }],
      })

      const dispatched = yield* ToolRuntime.dispatch(
        { remote },
        LLMEvent.toolCall({ id: "call_remote", name: "remote", input: {} }),
      )

      expect(dispatched.output).toEqual({
        structured: { ok: true },
        content: [{ type: "file", uri: "https://example.test/image.png", mime: "image/png" }],
      })
      expect(dispatched.result).toEqual({
        type: "content",
        value: [{ type: "file", uri: "https://example.test/image.png", mime: "image/png" }],
      })
      expect(dispatched.events.map((event) => event.type)).toEqual(["tool-result"])
    }),
  )

  test("derives typed output schemas and preserves dynamic output schemas", () => {
    const [typed] = toDefinitions({ get_weather })
    const schema = { type: "object", properties: { result: { type: "string" } } } as const
    const [dynamic] = toDefinitions({
      dynamic: Tool.make({ description: "Dynamic tool.", jsonSchema: { type: "object" }, outputSchema: schema }),
    })

    expect(typed?.outputSchema).toMatchObject({
      type: "object",
      properties: { condition: { type: "string" } },
      required: ["temperature", "condition"],
      additionalProperties: false,
    })
    expect(Reflect.get(Reflect.get(typed?.outputSchema ?? {}, "properties") as object, "temperature")).toBeDefined()
    expect(dynamic?.outputSchema).toEqual(schema)
  })

  it.effect("preserves content tool results from dynamic tools", () =>
    Effect.gen(function* () {
      const screenshot = Tool.make({
        description: "Capture a screenshot.",
        jsonSchema: { type: "object", properties: {} },
        execute: () =>
          Effect.succeed({
            type: "content" as const,
            value: [
              { type: "text" as const, text: "Screenshot captured." },
              { type: "file" as const, uri: "data:image/png;base64,AAAA", mime: "image/png" },
            ],
          }),
      })

      const events = Array.from(
        yield* TestToolRuntime.runTools({ request: baseRequest, tools: { screenshot }, maxSteps: 1 }).pipe(
          Stream.runCollect,
          Effect.provide(
            scriptedResponses([sseEvents(toolCallChunk("call_1", "screenshot", "{}"), finishChunk("tool_calls"))]),
          ),
        ),
      )

      expect(events.find(LLMEvent.is.toolResult)).toMatchObject({
        type: "tool-result",
        id: "call_1",
        name: "screenshot",
        result: {
          type: "content",
          value: [
            { type: "text", text: "Screenshot captured." },
            { type: "file", uri: "data:image/png;base64,AAAA", mime: "image/png" },
          ],
        },
      })
    }),
  )

  it.effect("does not mistake dynamic tool output fields for dispatcher state", () =>
    Effect.gen(function* () {
      const callerOwned = { type: "json" as const, value: { ok: true }, events: ["caller-owned"] }
      const eventful = Tool.make({
        description: "Return an events field.",
        jsonSchema: { type: "object", properties: {} },
        execute: () => Effect.succeed(callerOwned),
      })

      const dispatched = yield* ToolRuntime.dispatch(
        { eventful },
        LLMEvent.toolCall({ id: "call_1", name: "eventful", input: {} }),
      )

      expect(dispatched.result).toEqual(callerOwned)
      expect(dispatched.events).toEqual([
        LLMEvent.toolResult({
          id: "call_1",
          name: "eventful",
          result: callerOwned,
          output: { structured: { ok: true }, content: [] },
        }),
      ])
    }),
  )

  it.effect("projects malformed tagged dynamic output as opaque JSON", () =>
    Effect.gen(function* () {
      const malformed = { type: "content", value: [{ type: "text" }] }
      const dynamic = Tool.make({
        description: "Return caller-defined JSON.",
        jsonSchema: { type: "object", properties: {} },
        execute: () => Effect.succeed(malformed),
      })

      const dispatched = yield* ToolRuntime.dispatch(
        { dynamic },
        LLMEvent.toolCall({ id: "call_1", name: "dynamic", input: {} }),
      )

      expect(dispatched.result).toEqual({ type: "json", value: malformed })
      expect(dispatched.output).toEqual({ structured: malformed, content: [] })
      expect(dispatched.events).toEqual([
        LLMEvent.toolResult({
          id: "call_1",
          name: "dynamic",
          result: { type: "json", value: malformed },
          output: { structured: malformed, content: [] },
        }),
      ])
    }),
  )

  it.effect("executes tool calls for one step without looping by default", () =>
    Effect.gen(function* () {
      const layer = scriptedResponses([
        sseEvents(toolCallChunk("call_1", "get_weather", '{"city":"Paris"}'), finishChunk("tool_calls")),
        sseEvents(deltaChunk({ role: "assistant", content: "Should not run." }), finishChunk("stop")),
      ])

      const events = Array.from(
        yield* TestToolRuntime.runTools({ request: baseRequest, tools: { get_weather }, maxSteps: 1 }).pipe(
          Stream.runCollect,
          Effect.provide(layer),
        ),
      )

      expect(events.filter(LLMEvent.is.finish)).toHaveLength(1)
      expect(events.find(LLMEvent.is.toolResult)).toMatchObject({ type: "tool-result", id: "call_1" })
    }),
  )

  it.effect("passes tool call context to execute", () =>
    Effect.gen(function* () {
      let context: ToolExecuteContext | undefined
      const contextual = Tool.make({
        description: "Capture tool context.",
        parameters: Schema.Struct({ value: Schema.String }),
        success: Schema.Struct({ ok: Schema.Boolean }),
        execute: (_params, ctx) =>
          Effect.sync(() => {
            context = ctx
            return { ok: true }
          }),
      })
      const events = Array.from(
        yield* TestToolRuntime.runTools({ request: baseRequest, tools: { contextual } }).pipe(
          Stream.runCollect,
          Effect.provide(
            scriptedResponses([
              sseEvents(toolCallChunk("call_ctx", "contextual", '{"value":"x"}'), finishChunk("tool_calls")),
            ]),
          ),
        ),
      )

      expect(events.some(LLMEvent.is.toolResult)).toBe(true)
      expect(context).toEqual({ id: "call_ctx", name: "contextual" })
    }),
  )

  it.effect("can expose tool schemas without executing tool calls", () =>
    Effect.gen(function* () {
      const layer = scriptedResponses([
        sseEvents(toolCallChunk("call_1", "get_weather", '{"city":"Paris"}'), finishChunk("tool_calls")),
      ])

      const events = Array.from(
        yield* LLMClient.stream(
          LLMRequest.update(baseRequest, { tools: toDefinitions({ get_weather: schema_only_weather }) }),
        ).pipe(Stream.runCollect, Effect.provide(layer)),
      )

      expect(events.find(LLMEvent.is.toolCall)).toMatchObject({ type: "tool-call", id: "call_1" })
      expect(events.find(LLMEvent.is.toolResult)).toBeUndefined()
    }),
  )

  it.effect("preserves provider metadata when folding streamed assistant content into follow-up history", () =>
    Effect.gen(function* () {
      const bodies: unknown[] = []
      const layer = dynamicResponse((input) =>
        Effect.sync(() => {
          bodies.push(decodeJson(input.text))
          return input.respond(
            bodies.length === 1
              ? sseEvents(
                  { type: "message_start", message: { usage: { input_tokens: 5 } } },
                  { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
                  { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "thinking" } },
                  { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig_1" } },
                  { type: "content_block_stop", index: 0 },
                  {
                    type: "content_block_start",
                    index: 1,
                    content_block: { type: "tool_use", id: "call_1", name: "get_weather" },
                  },
                  {
                    type: "content_block_delta",
                    index: 1,
                    delta: { type: "input_json_delta", partial_json: '{"city":"Paris"}' },
                  },
                  { type: "content_block_stop", index: 1 },
                  { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } },
                  { type: "message_stop" },
                )
              : sseEvents(
                  { type: "message_start", message: { usage: { input_tokens: 5 } } },
                  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
                  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Done." } },
                  { type: "content_block_stop", index: 0 },
                  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
                  { type: "message_stop" },
                ),
            { headers: { "content-type": "text/event-stream" } },
          )
        }),
      )

      yield* TestToolRuntime.runTools({
        request: LLMRequest.update(baseRequest, {
          model: AnthropicMessages.route
            .with({ auth: Auth.header("x-api-key", "test") })
            .model({ id: "claude-sonnet-4-5" }),
        }),
        tools: { get_weather },
      }).pipe(Stream.runCollect, Effect.provide(layer))

      expect(bodies[1]).toMatchObject({
        messages: [
          { role: "user" },
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "thinking", signature: "sig_1" },
              { type: "tool_use", id: "call_1", name: "get_weather", input: { city: "Paris" } },
            ],
          },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1" }] },
        ],
      })
    }),
  )

  it.effect("replays encrypted OpenAI reasoning items with tool outputs", () =>
    Effect.gen(function* () {
      const bodies: unknown[] = []
      const layer = dynamicResponse((input) =>
        Effect.sync(() => {
          bodies.push(decodeJson(input.text))
          return input.respond(
            bodies.length === 1
              ? sseEvents(
                  {
                    type: "response.output_item.added",
                    item: { type: "reasoning", id: "rs_1", encrypted_content: null },
                  },
                  { type: "response.reasoning_summary_part.added", item_id: "rs_1", summary_index: 0 },
                  { type: "response.reasoning_summary_part.done", item_id: "rs_1", summary_index: 0 },
                  {
                    type: "response.output_item.done",
                    item: { type: "reasoning", id: "rs_1", encrypted_content: "encrypted-state" },
                  },
                  {
                    type: "response.output_item.added",
                    item: {
                      type: "function_call",
                      id: "item_1",
                      call_id: "call_1",
                      name: "get_weather",
                      arguments: "",
                    },
                  },
                  { type: "response.function_call_arguments.delta", item_id: "item_1", delta: '{"city":"Paris"}' },
                  {
                    type: "response.output_item.done",
                    item: {
                      type: "function_call",
                      id: "item_1",
                      call_id: "call_1",
                      name: "get_weather",
                      arguments: '{"city":"Paris"}',
                    },
                  },
                  { type: "response.completed", response: {} },
                )
              : sseEvents(
                  { type: "response.output_text.delta", item_id: "msg_1", delta: "Done." },
                  { type: "response.completed", response: {} },
                ),
            { headers: { "content-type": "text/event-stream" } },
          )
        }),
      )

      yield* TestToolRuntime.runTools({
        request: LLM.request({
          model: OpenAIResponses.route
            .with({ endpoint: { baseURL: "https://api.openai.test/v1/" }, auth: Auth.bearer("test") })
            .model({ id: "gpt-5.5" }),
          prompt: "Use the tool.",
          providerOptions: { store: false, include: ["reasoning.encrypted_content"] },
        }),
        tools: { get_weather },
      }).pipe(Stream.runCollect, Effect.provide(layer))

      expect(bodies[1]).toMatchObject({
        include: ["reasoning.encrypted_content"],
        input: [
          { role: "user" },
          { type: "reasoning", summary: [], encrypted_content: "encrypted-state" },
          { type: "function_call", call_id: "call_1", name: "get_weather" },
          { type: "function_call_output", call_id: "call_1" },
        ],
      })
    }),
  )

  it.effect("emits tool-error for unknown tools so the model can self-correct", () =>
    Effect.gen(function* () {
      const layer = scriptedResponses([
        sseEvents(toolCallChunk("call_1", "missing_tool", "{}"), finishChunk("tool_calls")),
        sseEvents(deltaChunk({ role: "assistant", content: "Sorry." }), finishChunk("stop")),
      ])

      const events = Array.from(
        yield* TestToolRuntime.runTools({ request: baseRequest, tools: { get_weather } }).pipe(
          Stream.runCollect,
          Effect.provide(layer),
        ),
      )

      const toolError = events.find(LLMEvent.is.toolError)
      expect(toolError).toMatchObject({ type: "tool-error", id: "call_1", name: "missing_tool" })
      expect(toolError?.message).toBe(
        'No tool named "missing_tool" is currently available. Please use a tool from the available tool list.',
      )
      expect(events.find(LLMEvent.is.toolResult)).toMatchObject({
        type: "tool-result",
        id: "call_1",
        name: "missing_tool",
        result: {
          type: "error",
          value: 'No tool named "missing_tool" is currently available. Please use a tool from the available tool list.',
        },
      })
    }),
  )

  it.effect("emits tool-error when the LLM input fails the parameters schema", () =>
    Effect.gen(function* () {
      const layer = scriptedResponses([
        sseEvents(toolCallChunk("call_1", "get_weather", '{"city":42}'), finishChunk("tool_calls")),
        sseEvents(deltaChunk({ role: "assistant", content: "Done." }), finishChunk("stop")),
      ])

      const events = Array.from(
        yield* TestToolRuntime.runTools({ request: baseRequest, tools: { get_weather } }).pipe(
          Stream.runCollect,
          Effect.provide(layer),
        ),
      )

      const toolError = events.find(LLMEvent.is.toolError)
      expect(toolError).toMatchObject({ type: "tool-error", id: "call_1", name: "get_weather" })
      expect(toolError?.message).toContain("Invalid tool input")
    }),
  )

  it.effect("emits tool-error when the handler returns a ToolFailure", () =>
    Effect.gen(function* () {
      const layer = scriptedResponses([
        sseEvents(toolCallChunk("call_1", "get_weather", '{"city":"FAIL"}'), finishChunk("tool_calls")),
        sseEvents(deltaChunk({ role: "assistant", content: "Sorry." }), finishChunk("stop")),
      ])

      const events = Array.from(
        yield* TestToolRuntime.runTools({ request: baseRequest, tools: { get_weather } }).pipe(
          Stream.runCollect,
          Effect.provide(layer),
        ),
      )

      const toolError = events.find(LLMEvent.is.toolError)
      expect(toolError).toMatchObject({ type: "tool-error", id: "call_1", name: "get_weather" })
      expect(toolError?.message).toBe("Weather lookup failed for FAIL")
      expect(toolError?.error).toBe(weatherFailureCause)
    }),
  )

  it.effect("stops when the model finishes without requesting more tools", () =>
    Effect.gen(function* () {
      const layer = scriptedResponses([
        sseEvents(deltaChunk({ role: "assistant", content: "Done." }), finishChunk("stop")),
      ])

      const events = Array.from(
        yield* TestToolRuntime.runTools({ request: baseRequest, tools: { get_weather } }).pipe(
          Stream.runCollect,
          Effect.provide(layer),
        ),
      )

      expect(events.map((event) => event.type)).toEqual([
        "step-start",
        "text-start",
        "text-delta",
        "text-end",
        "step-finish",
        "finish",
      ])
      expect(LLMResponse.text({ events })).toBe("Done.")
    }),
  )

  it.effect("respects maxSteps and stops the loop", () =>
    Effect.gen(function* () {
      // Every script entry asks for another tool call. With maxSteps: 2 the
      // runtime should run at most two model rounds and then exit even though
      // the model still wants to keep going.
      const toolCallStep = sseEvents(
        toolCallChunk("call_x", "get_weather", '{"city":"Paris"}'),
        finishChunk("tool_calls"),
      )
      const layer = scriptedResponses([toolCallStep, toolCallStep, toolCallStep])

      const events = Array.from(
        yield* TestToolRuntime.runTools({ request: baseRequest, tools: { get_weather }, maxSteps: 2 }).pipe(
          Stream.runCollect,
          Effect.provide(layer),
        ),
      )

      expect(events.filter(LLMEvent.is.finish)).toHaveLength(1)
      expect(events.filter(LLMEvent.is.stepStart).map((event) => event.index)).toEqual([0, 1])
      expect(events.filter(LLMEvent.is.stepFinish).map((event) => event.index)).toEqual([0, 1])
    }),
  )

  it.effect("does not dispatch provider-executed tool calls", () =>
    Effect.gen(function* () {
      let streams = 0
      const layer = dynamicResponse((input) =>
        Effect.sync(() => {
          streams++
          return input.respond(
            sseEvents(
              { type: "message_start", message: { usage: { input_tokens: 5 } } },
              {
                type: "content_block_start",
                index: 0,
                content_block: { type: "server_tool_use", id: "srvtoolu_abc", name: "web_search" },
              },
              {
                type: "content_block_delta",
                index: 0,
                delta: { type: "input_json_delta", partial_json: '{"query":"x"}' },
              },
              { type: "content_block_stop", index: 0 },
              {
                type: "content_block_start",
                index: 1,
                content_block: {
                  type: "web_search_tool_result",
                  tool_use_id: "srvtoolu_abc",
                  content: [{ type: "web_search_result", url: "https://example.com", title: "Example" }],
                },
              },
              { type: "content_block_stop", index: 1 },
              { type: "content_block_start", index: 2, content_block: { type: "text", text: "" } },
              { type: "content_block_delta", index: 2, delta: { type: "text_delta", text: "Done." } },
              { type: "content_block_stop", index: 2 },
              { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 8 } },
              { type: "message_stop" },
            ),
            { headers: { "content-type": "text/event-stream" } },
          )
        }),
      )
      const events = Array.from(
        yield* TestToolRuntime.runTools({
          request: LLMRequest.update(baseRequest, {
            model: AnthropicMessages.route
              .with({ auth: Auth.header("x-api-key", "test") })
              .model({ id: "claude-sonnet-4-5" }),
          }),
          tools: {},
        }).pipe(Stream.runCollect, Effect.provide(layer)),
      )

      expect(streams).toBe(1)
      expect(events.find(LLMEvent.is.toolError)).toBeUndefined()
      expect(events.filter(LLMEvent.is.toolCall)).toEqual([
        {
          type: "tool-call",
          id: "srvtoolu_abc",
          name: "web_search",
          input: { query: "x" },
          providerExecuted: true,
        },
      ])
      expect(LLMResponse.text({ events })).toBe("Done.")
    }),
  )

  it.effect("dispatches multiple tool calls in one step concurrently", () =>
    Effect.gen(function* () {
      const layer = scriptedResponses([
        sseEvents(
          deltaChunk({
            role: "assistant",
            tool_calls: [
              { index: 0, id: "c1", function: { name: "get_weather", arguments: '{"city":"Paris"}' } },
              { index: 1, id: "c2", function: { name: "get_weather", arguments: '{"city":"Tokyo"}' } },
            ],
          }),
          finishChunk("tool_calls"),
        ),
        sseEvents(deltaChunk({ role: "assistant", content: "Both done." }), finishChunk("stop")),
      ])

      const events = Array.from(
        yield* TestToolRuntime.runTools({ request: baseRequest, tools: { get_weather } }).pipe(
          Stream.runCollect,
          Effect.provide(layer),
        ),
      )

      const results = events.filter(LLMEvent.is.toolResult)
      expect(results).toHaveLength(2)
      expect(results.map((event) => event.id).toSorted()).toEqual(["c1", "c2"])
    }),
  )
})
