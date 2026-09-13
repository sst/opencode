import { expect, test } from "bun:test"
import { ConfigProvider, Effect } from "effect"
import { Headers } from "effect/unstable/http"
import { Auth, LLM, LLMClient, LLMRequest, Message, ReasoningPart, ToolDefinition } from "../../src/index.js"
import { Alibaba } from "../../src/providers.js"
import { compileRequest } from "../../src/route/client.js"
import { Endpoint } from "../../src/route/endpoint.js"
import { it } from "../lib/effect.js"
import { dynamicResponse } from "../lib/http.js"
import { sseEvents } from "../lib/sse.js"

const tool = ToolDefinition.make({
  name: "lookup",
  description: "Look up a value",
  inputSchema: { type: "object", properties: { key: { type: "string" } } },
})
const paths = {
  chat: "/compatible-mode/v1/chat/completions",
  messages: "/apps/anthropic/v1/messages",
  responses: "/compatible-mode/v1/responses",
}

it.effect("Alibaba owns regional shared and workspace-specific endpoints", () =>
  Effect.gen(function* () {
    for (const region of [
      "ap-southeast-1",
      "cn-beijing",
      "cn-hongkong",
      "us-east-1",
      "eu-central-1",
      "ap-northeast-1",
    ]) {
      const provider = Alibaba.configure({ region, workspaceID: "llm-fixture", apiKey: "fixture" })
      expect(provider.model).toBe(provider.chat)
      for (const api of ["chat", "messages", "responses"] as const) {
        const model = provider[api]("qwen-plus-us")
        const request = LLM.request({ model, prompt: "Hello" })
        const compiled = yield* compileRequest(request)
        expect(Endpoint.render(model.route.endpoint, { request, body: compiled.body }).toString()).toBe(
          `https://llm-fixture.${region}.maas.aliyuncs.com${paths[api]}`,
        )
        expect(model.provider).toBe("alibaba")
        expect(model.route.id).toBe(`alibaba-${api}`)
        expect(compiled.body.model).toBe("qwen-plus-us")
        for (const field of [
          "thinking",
          "enable_thinking",
          "thinking_budget",
          "preserve_thinking",
          "reasoning_effort",
          "reasoning",
          "output_config",
          "store",
          "tool_stream",
        ])
          expect(compiled.body[field]).toBeUndefined()
      }
    }
    for (const [region, host] of [
      ["ap-southeast-1", "dashscope-intl.aliyuncs.com"],
      ["cn-beijing", "dashscope.aliyuncs.com"],
      ["cn-hongkong", "cn-hongkong.dashscope.aliyuncs.com"],
      ["us-east-1", "dashscope-us.aliyuncs.com"],
    ]) {
      const provider = Alibaba.configure({ region, apiKey: "fixture" })
      for (const api of ["chat", "messages", "responses"] as const) {
        const request = LLM.request({ model: provider[api]("qwen3.8-max") })
        const compiled = yield* compileRequest(request)
        expect(Endpoint.render(request.model.route.endpoint, { request, body: compiled.body }).toString()).toBe(
          `https://${host}${paths[api]}`,
        )
      }
    }
  }),
)

test("Alibaba requires explicit placement and supports complete base URL overrides", () => {
  for (const region of ["eu-central-1", "ap-northeast-1", "future-region"])
    expect(() => Alibaba.configure({ region })).toThrow(
      expect.objectContaining({
        _tag: "ProviderConfiguration",
        provider: "alibaba",
        message: `Alibaba region ${region} requires workspaceID or baseURL`,
      }),
    )
  for (const config of [
    { baseURL: "https://gateway.example/prefix" },
    { region: "future-region", workspaceID: "ignored", baseURL: "https://gateway.example/prefix" },
  ]) {
    const provider = Alibaba.configure(config)
    for (const api of ["chat", "messages", "responses"] as const)
      expect(provider[api]("unchanged-id").route.endpoint.baseURL).toBe(config.baseURL)
  }
  expect(
    Alibaba.configure({ region: "future-region", workspaceID: "llm-fixture" }).chat("new-model").route.endpoint.baseURL,
  ).toBe("https://llm-fixture.future-region.maas.aliyuncs.com/compatible-mode/v1")
})

it.effect("Alibaba resolves explicit auth, API keys, and regional environment credentials", () =>
  Effect.gen(function* () {
    for (const item of [
      {
        config: {},
        env: { DASHSCOPE_API_KEY: "primary", ALIBABA_API_KEY: "fallback" },
        headers: { authorization: "Bearer primary" },
      },
      { config: {}, env: { ALIBABA_API_KEY: "fallback" }, headers: { authorization: "Bearer fallback" } },
      {
        config: { apiKey: "explicit" },
        env: { DASHSCOPE_API_KEY: "primary" },
        headers: { authorization: "Bearer explicit" },
      },
      {
        config: { auth: Auth.header("x-custom-key", "custom") },
        env: { DASHSCOPE_API_KEY: "primary" },
        headers: { "x-custom-key": "custom" },
      },
    ]) {
      const provider = Alibaba.configure({ region: "ap-southeast-1", ...item.config })
      for (const api of ["chat", "messages", "responses"] as const) {
        const request = LLM.request({ model: provider[api]("qwen3.8-max") })
        const headers = yield* request.model.route.auth
          .apply({ request, method: "POST", url: "https://fixture", body: "{}", headers: Headers.empty })
          .pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: item.env }))))
        expect(headers).toEqual(expect.objectContaining(item.headers))
      }
    }
  }),
)

it.effect("Alibaba keeps native reasoning controls and future efforts on their selected API", () =>
  Effect.gen(function* () {
    const provider = Alibaba.configure({ region: "ap-southeast-1", apiKey: "fixture" })
    for (const effort of ["none", "minimal", "low", "medium", "high", "xhigh", "max", "future-effort"]) {
      const chat = yield* compileRequest(
        LLM.request({ model: provider.chat("qwen3.8-max"), providerOptions: { reasoningEffort: effort } }),
      )
      const messages = yield* compileRequest(
        LLM.request({ model: provider.messages("qwen3.8-max"), providerOptions: { effort } }),
      )
      const responses = yield* compileRequest(
        LLM.request({ model: provider.responses("qwen3.8-max"), providerOptions: { reasoningEffort: effort } }),
      )
      expect(chat.body.reasoning_effort).toBe(effort)
      expect(messages.body.output_config).toEqual({ effort })
      expect(responses.body.reasoning).toEqual({ effort })
      for (const result of [chat, messages, responses]) {
        expect(result.body.thinking).toBeUndefined()
        expect(result.body.enable_thinking).toBeUndefined()
      }
    }
    for (const enableThinking of [true, false]) {
      const chat = yield* compileRequest(
        LLM.request({
          model: provider.chat("qwen3.7-plus"),
          tools: [tool],
          generation: { maxTokens: 1234, topK: 20 },
          providerOptions: {
            enableThinking,
            thinkingBudget: 512,
            preserveThinking: false,
            clearThinking: false,
            toolStream: false,
            parallelToolCalls: false,
            repetitionPenalty: 1.1,
            responseFormat: { type: "json_object" },
            enableSearch: true,
            searchOptions: { forced_search: true, search_strategy: "future-strategy", enable_search_extension: false },
          },
        }),
      )
      expect(chat.body).toMatchObject({
        enable_thinking: enableThinking,
        thinking_budget: 512,
        preserve_thinking: false,
        clear_thinking: false,
        tool_stream: false,
        parallel_tool_calls: false,
        repetition_penalty: 1.1,
        max_completion_tokens: 1234,
        top_k: 20,
        response_format: { type: "json_object" },
        enable_search: true,
        search_options: { forced_search: true, search_strategy: "future-strategy", enable_search_extension: false },
      })
      expect(chat.body.max_tokens).toBeUndefined()
      expect(chat.body.tools).toEqual([
        expect.objectContaining({ function: expect.not.objectContaining({ strict: expect.anything() }) }),
      ])
      const responses = yield* compileRequest(
        LLM.request({
          model: provider.responses("qwen3.7-plus"),
          providerOptions: { enableThinking, store: false, previousResponseId: "resp_previous" },
        }),
      )
      expect(responses.body).toMatchObject({
        enable_thinking: enableThinking,
        store: false,
        previous_response_id: "resp_previous",
      })
    }
    for (const thinking of [
      { type: "enabled" },
      { type: "disabled" },
      { type: "enabled", budgetTokens: 512 },
      { type: "future", budget_tokens: 4096 },
    ]) {
      const messages = yield* compileRequest(
        LLM.request({ model: provider.messages("qwen3.7-plus"), providerOptions: { thinking } }),
      )
      expect(messages.body.thinking).toEqual({
        type: thinking.type,
        budget_tokens: thinking.budgetTokens ?? thinking.budget_tokens,
      })
    }
  }),
)

it.effect("Alibaba validates malformed options before execution", () =>
  Effect.gen(function* () {
    const provider = Alibaba.configure({ region: "ap-southeast-1", apiKey: "fixture" })
    for (const [api, providerOptions] of [
      ["chat", { preserveThinking: "false" }],
      ["messages", { thinking: { type: "enabled", budgetTokens: "512" } }],
      ["responses", { enableThinking: "false" }],
    ] as const) {
      const model = provider[api]("qwen3.8-max").route.with({ providerOptions }).model({ id: "qwen3.8-max" })
      const error = yield* compileRequest(LLM.request({ model })).pipe(Effect.flip)
      expect(error.reason._tag).toBe("InvalidRequest")
    }
  }),
)

it.effect("Alibaba preserves unsigned and signed Messages thinking without a budget requirement", () =>
  Effect.gen(function* () {
    const result = yield* compileRequest(
      LLM.request({
        model: Alibaba.configure({ region: "ap-southeast-1", apiKey: "fixture" }).messages("qwen3.8-max"),
        providerOptions: { thinking: { type: "enabled" }, effort: "low" },
        messages: [
          Message.user("Hello"),
          Message.assistant([
            ReasoningPart.make({ type: "reasoning", text: "unsigned" }),
            ReasoningPart.make({
              type: "reasoning",
              text: "signed",
              providerMetadata: { alibaba: { signature: "opaque" } },
            }),
          ]),
        ],
      }),
    )
    expect(result.body.thinking).toEqual({ type: "enabled" })
    expect(result.body.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "assistant",
          content: [
            { type: "thinking", thinking: "unsigned", signature: "" },
            { type: "thinking", thinking: "signed", signature: "opaque" },
          ],
        }),
      ]),
    )
  }),
)

it.effect("Alibaba serializes Messages configuration, per-request controls, and final HTTP overlays", () =>
  LLMClient.generate(
    LLM.request({
      model: Alibaba.configure({
        baseURL: "https://gateway.example/v1",
        apiKey: "fixture",
        providerOptions: { thinking: { type: "enabled", budgetTokens: 512 }, effort: "high" },
      }).messages("qwen3.8-max"),
      prompt: "Hello",
      providerOptions: { effort: "low" },
      http: { body: { output_config: { effort: "medium" }, extension: true } },
    }),
  ).pipe(
    Effect.provide(
      dynamicResponse((input) =>
        Effect.sync(() => {
          expect(input.request.url).toBe("https://gateway.example/v1/messages")
          expect(input.request.headers.authorization).toBe("Bearer fixture")
          expect(input.request.headers["anthropic-version"]).toBe("2023-06-01")
          expect(JSON.parse(input.text)).toMatchObject({
            thinking: { type: "enabled", budget_tokens: 512 },
            output_config: { effort: "medium" },
            extension: true,
          })
          return input.respond(
            sseEvents(
              {
                type: "message_start",
                message: { id: "msg_fixture", content: [], usage: { input_tokens: 1, output_tokens: 0 } },
              },
              { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
              { type: "message_stop" },
            ),
            { headers: { "content-type": "text/event-stream" } },
          )
        }),
      ),
    ),
  ),
)

it.effect("Alibaba Responses lowers hosted tools and named selection using HTTP even with a WebSocket executor", () =>
  Effect.gen(function* () {
    const request = LLM.request({
      model: Alibaba.configure({ region: "ap-southeast-1", apiKey: "fixture" }).responses("qwen3.8-max"),
      tools: [Alibaba.webSearch(), Alibaba.webExtractor(), Alibaba.codeInterpreter(), tool],
      prompt: "Hello",
    })
    const compiled = yield* compileRequest(request)
    expect(compiled.body.tools).toMatchObject([
      { type: "web_search" },
      { type: "web_extractor" },
      { type: "code_interpreter" },
      { type: "function", name: "lookup" },
    ])
    const named = yield* compileRequest(
      LLMRequest.update(request, { tools: [tool], toolChoice: { type: "tool", name: "lookup" } }),
    )
    expect(named.body.tool_choice).toEqual({
      type: "allowed_tools",
      mode: "required",
      tools: [{ type: "function", name: "lookup" }],
    })
    const response = yield* LLMClient.generate(request, {
      webSocket: { execute: () => Effect.die("Unexpected WebSocket") },
    })
    expect(response.toolCalls).toMatchObject([
      {
        name: "web_extractor",
        providerExecuted: true,
        input: { urls: ["https://example.com"], goal: "Read the page" },
      },
    ])
    const replay = yield* compileRequest(
      LLMRequest.update(request, { messages: [...request.messages, response.message, Message.user("Continue")] }),
    )
    expect(replay.body.input).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "web_extractor_call",
          id: "extract_1",
          urls: ["https://example.com"],
          goal: "Read the page",
          result: { text: "fixture" },
        }),
      ]),
    )
  }).pipe(
    Effect.provide(
      dynamicResponse((input) =>
        Effect.sync(() => {
          expect(input.request.url).toBe("https://dashscope-intl.aliyuncs.com/compatible-mode/v1/responses")
          return input.respond(
            sseEvents(
              {
                type: "response.output_item.done",
                output_index: 0,
                item: {
                  type: "web_extractor_call",
                  id: "extract_1",
                  status: "completed",
                  urls: ["https://example.com"],
                  goal: "Read the page",
                  result: { text: "fixture" },
                },
              },
              { type: "response.completed", response: {} },
            ),
            { headers: { "content-type": "text/event-stream" } },
          )
        }),
      ),
    ),
  ),
)
