# AI Package Guide

## Effect

- Prefer `HttpClient.HttpClient` / `HttpClientResponse.HttpClientResponse` over web `fetch` / `Response` at package boundaries.
- Use `Stream.Stream` for streaming data flow. Avoid ad hoc async generators or manual web reader loops unless an Effect `Stream` API cannot model the behavior.
- Use Effect Schema codecs for JSON encode/decode (`Schema.fromJsonString(...)`) instead of direct `JSON.parse` / `JSON.stringify` in implementation code.
- In `Effect.gen`, yield yieldable errors directly (`return yield* new MyError(...)`) instead of `Effect.fail(new MyError(...))`.
- Use `Effect.void` instead of `Effect.succeed(undefined)` when the successful value is intentionally void.

## Conventions

Per-type constructors live on the type, not as top-level re-exports. Use `Message.system(...)`, `Message.user(...)`, `Message.assistant(...)`, `Message.tool(...)`, `LanguageModel.make(...)`, `ToolDefinition.make(...)`, `ToolCallPart.make(...)`, `ToolResultPart.make(...)`, `ToolChoice.make(...)`, `ToolChoice.named(...)`, `SystemPart.make(...)`, and `GenerationOptions.make(...)` directly. The top-level `LLM` namespace is reserved for request-shaped call APIs: `LLM.request`, `LLM.generate`, `LLM.stream`, and `LLM.generateObject`. Use `LLMRequest.update(...)` when deriving canonical request data; do not add a duplicate `LLM.updateRequest(...)` path. Two ways to construct the same thing is one too many.

- Keep provider-defined string enums forward-compatible. Expose known values for autocomplete while accepting future values with `Known | (string & {})`; use `Schema.String` at runtime unless rejecting unknown values is required for correctness.
- Order reasoning-effort values from lowest to highest: `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. Provider-specific subsets follow the same relative order in types, schemas, option lists, and tests.

## Tests

- Use `testEffect(...)` from `test/lib/effect.ts` for tests requiring Effect layers.
- Keep provider tests fixture-first. Live provider calls must stay behind `RECORD=true` and required API-key checks.

## Errors

- `AIError` wraps a union of tagged reason errors. It stores only `reason`, derives `message` from the reason, and exposes the reason as its `cause`.
- Each reason owns its readable `message`, category-specific fields, and optional `body`, `http`, and underlying exception in `cause`.
- `reason.body` is the sole original-response or triggering-event payload field. Preserve original text before schema decoding removes fields; do not replace the complete event with only its nested error.
- `reason.http` describes an observed HTTP response with required `url`, `status`, and response `headers`. Do not invent status codes or derive a separate request ID from headers.
- Reclassification and transport recovery must preserve the reason's body, HTTP context, and underlying cause. Error `message` and `cause` are non-enumerable: copy them explicitly when constructing an enriched reason with its constructor or `AIErrorReason.make`.

## Architecture

This package is an Effect Schema-first LLM core. The Schema classes in `src/schema/` are the canonical runtime data model. Convenience functions in `src/llm.ts` are thin constructors that return those same Schema class instances; they should improve callsites without creating a second model.

Session integration lives in `packages/core/src/session`: `runner/llm.ts` owns orchestration, `model-request.ts` lowers Session state into `LLMRequest`, and `model-transport.ts` selects transport behavior.

Keep this package independent of Session concerns. Session auth, permissions, plugins, telemetry headers, and runtime selection belong in Core.

### Request Flow

The intended callsite is:

```ts
const request = LLM.request({
  model: OpenAI.configure({ apiKey }).responses("gpt-4o-mini"),
  system: "You are concise.",
  prompt: "Say hello.",
})

const response = yield * LLMClient.generate(request)
```

`LLM.request(...)` builds an `LLMRequest`. `LLMClient.generate(...)` reads the executable route carried by `request.model.route`, builds the provider-native body, asks the route's transport for a real `HttpClientRequest.HttpClientRequest`, sends it through `RequestExecutor.Service`, parses the provider stream into common `LLMEvent`s, and finally returns an `LLMResponse`.

Use `LLMClient.stream(request)` when callers want incremental `LLMEvent`s. Use `LLMClient.generate(request)` when callers want those same events collected into an `LLMResponse`.

Filter or narrow `LLMEvent` streams with `LLMEvent.is.*` (camelCase guards, e.g. `events.filter(LLMEvent.is.toolCall)`). The kebab-case `LLMEvent.guards["tool-call"]` form also works but prefer `is.*` in new code.

### Routes

A route is the runnable composition of four orthogonal pieces:

- **`Protocol`** (`src/route/protocol.ts`) — semantic API contract. Owns request body construction (`body.from`), the body schema (`body.schema`), the streaming-event schema (`stream.event`), and the event-to-`LLMEvent` state machine (`stream.step`). `Route.make(...)` validates and JSON-encodes the body from `body.schema` and decodes frames with `stream.event`. Examples: `OpenAIChat.protocol`, `OpenResponses.protocol`, `OpenAIResponses.protocol`, `AnthropicMessages.protocol`, `Gemini.protocol`, `BedrockConverse.protocol`.
- **`Endpoint`** (`src/route/endpoint.ts`) — URL construction. The host, path, and route query live on the endpoint. `Endpoint.path("/chat/completions", { baseURL })` is the common case; pass a function for paths that embed the model id or a body field (e.g. `Endpoint.path(({ body }) => `/model/${body.modelId}/converse-stream`)`).
- **`Auth`** (`src/route/auth.ts`) — per-request transport authentication. Provider facades configure credentials onto the route before model selection, usually via `Auth.bearer(apiKey)` or `Auth.header(name, apiKey)`. Routes that need per-request signing (Bedrock SigV4, future Vertex IAM, Azure AAD) implement `Auth` as a function that signs the body and merges signed headers into the result.
- **`Framing`** (`src/route/framing.ts`) — bytes → frames. SSE (`Framing.sse`) is shared; Bedrock keeps its AWS event-stream framing as a typed `Framing<object>` value alongside its protocol.

Compose them via `Route.make(...)`:

```ts
export const route = Route.make({
  id: "openai-chat",
  provider: "openai",
  protocol: OpenAIChat.protocol,
  endpoint: Endpoint.path("/chat/completions", {
    baseURL: "https://api.openai.com/v1",
  }),
  auth: Auth.bearer(Auth.config("OPENAI_API_KEY")),
  framing: Framing.sse,
})
```

Route defaults are request-shaping defaults such as `headers`, `limits`, `generation`, `providerOptions`, and `http`. Endpoint host/query belongs on the route endpoint. Selected `LanguageModel` values carry only model id, provider id, and the configured route value. Model capability/catalog metadata lives outside this package; protocol support is enforced by request lowering and typed `AIError`s.

The four-axis decomposition is the reason DeepSeek, TogetherAI, Cerebras, Baseten, Fireworks, and DeepInfra all reuse `OpenAIChat.protocol` verbatim — each provider owns a small `Route.make(...)` composition instead of a protocol clone. Bug fixes in one protocol propagate to every consumer of that protocol in a single commit.

When a provider supports multiple physical transports, selection remains execution policy below its semantic route. `OpenResponsesChannel.transport(...)` owns the provider-neutral Responses WebSocket concept: it prepares one final request, executes HTTP by default, strips WebSocket-disallowed fields, and passes a generic channel exchange to a per-call `WebSocketChannelExecutor` when supplied. Provider-specific Responses routes opt in with handshake and connection-age policy. `Route.streamPrepared` owns decoding and acknowledges channel completion only after successful full consumption.

### URL Construction

`Endpoint` owns `{ baseURL, path, query }`. Each protocol route includes a canonical endpoint when the provider has one (e.g. `https://api.openai.com/v1`); provider helpers override endpoint fields by configuring the route before selecting a model. Generic OpenAI-compatible routes have no canonical URL and require configuration before execution.

For providers where the URL is derived from typed inputs (Azure resource name, Bedrock region), the provider helper configures the route endpoint before calling `.model(...)`. Use `AtLeastOne<T>` from `route/auth-options.ts` for inputs that accept either of two derivation paths (Azure: `resourceName` or `baseURL`).

### Provider Facades

Provider-facing APIs are configured facades over route values. Endpoint/auth/resource/API-version setup happens before model selection, and model selectors accept only a model or deployment id:

```ts
const openai = OpenAI.configure({ apiKey, baseURL })
const model = openai.responses("gpt-4o-mini")

const azure = Azure.configure({ resourceName, apiKey, apiVersion: "v1" })
const deployment = azure.responses("my-deployment")

const gateway = CloudflareAIGateway.configure({ accountId, gatewayId, gatewayApiKey, apiKey })
const proxied = gateway.model("openai/gpt-4o-mini")
```

Keep provider facades small and explicit:

- Use branded `ProviderID.make(...)` and `ModelID.make(...)` where ids are constructed directly.
- Use `model` for the default API path and named methods for provider-native alternatives such as OpenAI `responses` and `chat`.
- Put provider-specific setup on `.configure(...)`; do not add `model(id, overrides)` as a duplicate construction path.
- Export lower-level `routes` arrays separately only when advanced internal wiring needs them.
- Prefer `apiKey` as provider-specific sugar and `auth` as the explicit override; keep them mutually exclusive in provider option types with `ProviderAuthOption`.
- Resolve `apiKey` → `Auth` with `AuthOptions.bearer(options, "<PROVIDER>_API_KEY")` (it honors an explicit `auth` override and falls back to `Auth.config(envVar)` so missing keys surface a typed `Authentication` error rather than a runtime crash).
- Use separate top-level facades for products with different required setup, such as `CloudflareAIGateway` and `CloudflareWorkersAI`.
- Give every named provider its own file and top-level export. Keep its endpoint, auth defaults, and route setup in that file. Compose shared protocols directly; do not nest named provider presets under generic compatible facades or keep their endpoints in a shared provider profile registry.

`Provider.make(...)` remains available for simple static provider definitions, but new built-in providers should prefer plain configured facades unless a helper removes real duplication without adding runtime behavior.

### Provider Package Entrypoints

Catalog-selected native providers use package-like export paths from `@opencode/ai`. They are internal entrypoints in one npm package, not separately published provider packages. Every entrypoint implements `ProviderPackage.Definition` and exposes `model(modelID, settings)`, where settings are one flat serializable object: the connection keys the entrypoint declares (`apiKey`, `baseURL`, `region`, …), the common `headers` and `body` overlays, and the protocol's request options (`reasoningEffort`, `thinking`, …) side by side. Each entrypoint destructures its own connection keys and passes the rest to the route as `providerOptions`; there is no nested `providerOptions` at the entrypoint.

```ts
import { model } from "@opencode/ai/providers/openai/responses"

const selected = model("gpt-5", {
  apiKey,
  reasoningEffort: "high",
})
```

Keep semantic APIs as separate entrypoints, such as OpenAI `chat` and `responses`. Transport is execution policy: OpenAI Responses uses HTTP by default and may receive a per-call WebSocket channel executor through `StreamOptions` without changing model or route identity.

Do not expose `Route` in provider package settings. Route composition stays an implementation detail behind `model(...)`.

The dependency arrow points down: `providers/*.ts` files import protocol routes and auth-option utilities; protocol modules import `endpoint`, `auth`, `framing`, and transport pieces. Protocols do not import provider facades. Lower-level modules know nothing about provider catalog metadata. `OpenAIResponses` composes the provider-neutral `OpenResponses` protocol; the baseline never imports the OpenAI extension.

### Shared protocol helpers

`ProviderShared` exports a small toolkit used inside protocol implementations to keep them focused on provider-native shapes:

- `joinText(parts)` — joins an array of `TextPart` (or anything with a `.text`) with newlines. Use this anywhere a protocol flattens text content into a single string for a provider field.
- `parseToolInput(route, name, raw)` — Schema-decodes a tool-call argument string with the canonical "Invalid JSON input for `<route>` tool call `<name>`" error message. Treats empty input as `{}`.
- `parseJson(route, raw, message)` — generic JSON-via-Schema decode for non-tool bodies.
- `eventError(route, message, ...)` — typed `InvalidProviderOutput` constructor for stream-time decode failures.
- `validateWith(decoder)` — maps Schema decode errors to `InvalidRequest`. `Route.make(...)` uses this for body validation; lower-level routes can reuse it.
- `matchToolChoice(provider, choice, branches)` — branches over `LLMRequest["toolChoice"]` for provider-specific lowering.

If you find yourself copying a 3-to-5-line snippet between two protocols, lift it into `ProviderShared` next to these helpers rather than duplicating.

### Chronological System Updates

`LLMRequest.system` is the initial privileged prompt that applies ahead of the conversation. `Message.system(...)` is a separate, provider-neutral chronological operator update inside `LLMRequest.messages`; it applies only from its position in history onward and accepts text content only.

Native chronological system messages are route/model-specific. Open Responses lowers them to standard `developer` messages, while Anthropic Messages lowers them to native system messages for Claude Opus 4.8 (`claude-opus-4-8`). Other routes and models intentionally lower the update in place into ordinary user-compatible text using this stable escaped representation:

```text
<system-update>
...
</system-update>
```

The wrapped-user fallback preserves ordering while visibly lowering authority. Never silently pass a raw chronological `role: "system"` through a route that might reject it. Do not insert raw retrieved documents, tool output, or web content into privileged chronological system updates; keep untrusted content in ordinary user/tool channels.

### Tools

Tool loops are represented in common messages and events:

```ts
const call = ToolCallPart.make({ id: "call_1", name: "lookup", input: { query: "weather" } })
const result = Message.tool({ id: "call_1", name: "lookup", result: { forecast: "sunny" } })

const followUp = LLM.request({
  model,
  messages: [Message.user("Weather?"), Message.assistant([call]), result],
})
```

Routes lower these into provider-native assistant tool-call messages and tool-result messages. Streaming providers should emit `tool-input-delta` events while arguments arrive, then a final `tool-call` event with parsed input.

### Tool dispatch

`LLM.stream(request)` and `LLM.generate(request)` each run exactly one model call. Add tool schemas to `request.tools` with `Tool.toDefinitions(tools)`. When a caller wants the package's typed one-call execution behavior, pass each canonical local `tool-call` event to `ToolRuntime.dispatch(tools, call)`.

```ts
const get_weather = Tool.make({
  description: "Get current weather for a city",
  parameters: Schema.Struct({ city: Schema.String }),
  success: Schema.Struct({ temperature: Schema.Number, condition: Schema.String }),
  execute: (input) =>
    Effect.gen(function* () {
      const data = yield* WeatherApi.fetch(input.city)
      return { temperature: data.temp, condition: data.cond }
    }),
})

const tools = { get_weather, get_time, ... }
const events = yield* LLM.stream(
  LLMRequest.update(request, { tools: Tool.toDefinitions(tools) }),
).pipe(Stream.runCollect)

const call = Array.from(events).find(LLMEvent.is.toolCall)
if (call && !call.providerExecuted) {
  const dispatched = yield* ToolRuntime.dispatch(tools, call)
  // Persist call + dispatched.result, then construct the next request explicitly.
}
```

The dispatcher:

- On `tool-call`: looks up the named tool, decodes input against `parameters` Schema, dispatches to the typed `execute`, encodes the result against `success` Schema, and returns canonical `tool-result` events.
- Does not stream providers, construct Session events, schedule fibers, append history, count steps, or continue model rounds.
- Leaves persistence and continuation to the enclosing product flow.

Handler dependencies (services, permissions, plugin hooks, abort handling) are closed over by the consumer at tool-construction time. Build the tools record inside an `Effect.gen` once and reuse it across many dispatches.

Errors must be expressed as `ToolFailure`. The runtime catches it and emits a `tool-error` event, then a `tool-result` of `type: "error"`, so the model can self-correct on the next step. Anything that is not a `ToolFailure` is treated as a defect and fails the stream. Three recoverable error paths produce `tool-error` events:

- The model called an unknown tool name.
- Input failed the `parameters` Schema.
- The handler returned a `ToolFailure`.

Provider-defined / hosted tools (Anthropic `web_search` / `code_execution` / `web_fetch`, OpenAI Responses `web_search_call` / `file_search_call` / `code_interpreter_call` / `mcp_call` / `image_generation_call` / `computer_use_call`) pass through the runtime untouched:

- Routes surface the model's call as a `tool-call` event with `providerExecuted: true`, and the provider's result as a matching `tool-result` event with `providerExecuted: true`.
- Callers detect `providerExecuted` on `tool-call` and **skip local dispatch** — no handler is invoked and no `tool-error` is raised for "unknown tool". The provider already executed it.
- Callers that continue should retain both events in explicit history when the protocol requires it. Anthropic encodes them back as `server_tool_use` + `web_search_tool_result` (or `code_execution_tool_result` / `web_fetch_tool_result`) blocks; OpenAI Responses callers typically use `previous_response_id` instead of resending hosted-tool items.

Add provider-defined tools to `request.tools` (no runtime entry needed). The matching route must know how to lower the tool definition into the provider-native shape; right now Anthropic accepts `web_search` / `code_execution` / `web_fetch` and OpenAI Responses accepts the hosted tool names listed above.

## Protocol File Style

Protocol files should look self-similar. Provider quirks belong behind named helpers so a new route can be reviewed by comparing the same sections across files.

### Section order

Use this order for every protocol module:

1. Public model input
2. Request body schema
3. Streaming event schema
4. Parser state
5. Request body construction (`fromRequest`)
6. Stream parsing (`step` and per-event handlers)
7. Protocol and route
8. Protocol route export

### Rules

- Keep protocol files focused on the protocol. Move provider-specific projection, signing, media normalization, or other bulky transformations into `src/protocols/utils/*`.
- Use `Effect.fn("Provider.fromRequest")` for request body construction entrypoints. Use `Effect.fn(...)` for event handlers that yield effects; keep purely synchronous handlers as plain functions returning a `StepResult` that the dispatcher lifts via `Effect.succeed(...)`.
- Parser state owns terminal information. The state machine records finish reason, usage, and pending tool calls; emit one terminal `finish` event (or `provider-error`) for each completed response. If a provider splits reason and usage across events, merge them in parser state before flushing.
- Emit exactly one terminal `finish` event for a completed response, normally after a matching `step-finish`. Use `stream.terminal` to stop reading when the provider has a completion sentinel; use `stream.onHalt` when the final event must be flushed after the framed stream ends.
- Use shared helpers for repeated protocol policy such as text joining, usage totals, JSON parsing, and tool-call accumulation. `ToolStream` (`protocols/utils/tool-stream.ts`) accumulates streamed tool-call arguments uniformly.
- Make intentional provider differences explicit in helper names or comments. If two protocol files differ visually, the reason should be obvious from the names.
- Prefer dispatched per-event handlers (`onMessageStart`, `onContentBlockDelta`, ...) called from a small top-level `step` switch over a long if-chain. The dispatcher keeps the event surface visible at a glance.
- Keep tests in the same conceptual order as the protocol: basic prepare, tools prepare, unsupported lowering, text/usage parsing, tool streaming, finish reasons, provider errors.

### Review checklist

- Can the file be skimmed side-by-side with `openai-chat.ts` without hunting for equivalent sections?
- Are provider quirks named, isolated, and covered by focused tests?
- Does request body construction validate unsupported common content at the protocol boundary?
- Does stream parsing emit stable common events without leaking provider event order to callers?
- Does `toolChoice: "none"` behavior read as intentional?

## Recording Tests

Recorded tests use one cassette file per scenario. A cassette holds an ordered array of `{ request, response }` interactions, so multi-step flows (tool loops, retries, polling) record into a single file. Use `recordedTests({ prefix, requires })` and let the helper derive cassette names from test names:

```ts
const recorded = recordedTests({ prefix: "openai-chat", requires: ["OPENAI_API_KEY"] })

recorded.effect("streams text", () =>
  Effect.gen(function* () {
    // test body
  }),
)
```

Replay is the default. `RECORD=true` records fresh cassettes locally and requires the listed env vars; unset `CI` before recording because CI always forces replay. Cassettes are written as pretty-printed JSON so multi-interaction diffs stay reviewable.

Pass `provider`, `protocol`, and optional `tags` to `recordedTests(...)` / `recorded.effect.with(...)` so cassettes carry searchable metadata. Use recorded-test filters to replay or record a narrow subset without rewriting a whole file:

- `RECORDED_PROVIDER=openai` matches tests tagged with `provider:openai`; comma-separated values are allowed.
- `RECORDED_PREFIX=openai-chat` matches cassette groups by `recordedTests({ prefix })`; comma-separated values are allowed.
- `RECORDED_TAGS=tool` requires all listed tags to be present, e.g. `RECORDED_TAGS=provider:togetherai,tool`.
- `RECORDED_TEST="streams text"` matches by test name, kebab-case test id, or cassette path.

Filters apply in replay and record mode. Combine them with `RECORD=true` when refreshing only one provider or scenario.

**Binary response bodies.** Most providers stream text (SSE, JSON). The recorder treats known textual media types (`text/*`, JSON/XML structured types, JavaScript, forms, YAML, and SVG) as text and stores every other response as base64 with `bodyEncoding: "base64"`. This preserves binary formats such as AWS event-stream frames without a lossy UTF-8 round trip.

**Matching strategy.** A runtime request atomically claims the first unused recorded interaction that matches its method, URL, allow-listed headers, and canonical JSON body. Distinct requests may replay in any order or concurrently. Repeated identical requests consume their matching responses in cassette order, preserving deterministic retry and polling behavior. `scriptedResponses` (in `test/lib/http.ts`) is the deterministic counterpart for tests that don't need a live provider; it scripts response bodies in order without reading from disk.

Do not blanket re-record an entire test file when adding one cassette. `RECORD=true` rewrites every recorded case that runs, and provider streams contain volatile IDs, timestamps, fingerprints, and obfuscation fields. Prefer deleting the one cassette you intend to refresh, or run a focused test pattern that only registers the scenario you want to record. Keep stable existing cassettes unchanged unless their request shape or expected behavior changed.
