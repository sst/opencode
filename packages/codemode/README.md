# @opencode/codemode

This is our take on code mode: a lightweight, pure interpreter for a JavaScript-like language built around calling
tools. It supports familiar JavaScript syntax with a few key differences and limitations. See the
[interpreter support checklist](./interpreter-support.md) for more details.

Rather than trying to sandbox arbitrary JavaScript, CodeMode only runs the language features we implement. Programs
cannot directly access the network, filesystem, processes, or application APIs. They can interact with the outside
world only through tools provided by the host, which can also limit execution time, tool calls, output size, and data.

The idea of code mode was originally introduced by Cloudflare. See
[their post](https://blog.cloudflare.com/code-mode/) to learn more about the concept and their isolate-based approach.

## How it differs from JavaScript

- **Only supported APIs are available.** Programs can use the provided tools and supported JavaScript built-ins. APIs
  such as `fetch`, timers, `process`, filesystem access, imports, and modules are unavailable.
- **Unfinished work is interrupted.** Tool calls and async functions start when called. When the program finishes,
  anything still running is interrupted. Unhandled rejections from un-awaited promises are returned as warnings.
- **REPL-style results.** Without an explicit `return`, the final top-level expression becomes the result. `undefined`
  becomes `null`.

Unsupported syntax returns an `UnsupportedSyntax` diagnostic with a source location. Current gaps are tracked in the
[interpreter support checklist](./interpreter-support.md).

## Quick Start

```ts
import { CodeMode, Namespace, Tool } from "@opencode/codemode"
import { Effect, Schema } from "effect"

const lookupOrder = Tool.make({
  description: "Look up an order by ID",
  input: Schema.Struct({ id: Schema.String }),
  output: Schema.Struct({ id: Schema.String, status: Schema.String }),
  execute: ({ id }) => Effect.succeed({ id, status: "open" }),
})

const runtime = CodeMode.make({
  tools: { orders: { lookup: lookupOrder } },
})

const result = await Effect.runPromise(
  runtime.execute(`
    const order = await tools.orders.lookup({ id: "order_42" })
    return { id: order.id, needsAttention: order.status !== "complete" }
  `),
)
```

`result` is always a [`CodeMode.Result`](#results).

## API

### `Tool.make`

`input` and `output` accept either an Effect Schema or a render-only JSON Schema document. Effect Schema input is
decoded before `execute`; Effect Schema output is decoded and safely copied before the program sees it. JSON Schemas
only shape the model-visible signature. Without `output`, the signature uses `Promise<void>`.

Descriptions and schemas are model-visible contracts. Authorization belongs in `execute`.

Nested records are the shorthand for ordinary namespaces. Use `Namespace.make` when a namespace needs a description:

```ts
const runtime = CodeMode.make({
  tools: {
    orders: Namespace.make({
      description: "Purchases, fulfillment, and shipment tracking",
      tools: { lookup: lookupOrder },
    }),
  },
})
```

Namespace descriptions are optional and participate in search matching for every descendant tool. Names still come
from record keys, so the wrapper does not repeat `orders`. Dots in keys create nested paths; other characters use
bracket notation, such as `tools.context7["resolve-library-id"](...)`.

### `CodeMode.execute` and `CodeMode.make`

`CodeMode.execute({ ...options, code })` runs once. `CodeMode.make(options)` creates a reusable runtime:

```ts
const runtime = CodeMode.make({ tools, limits: { timeoutMs: 30_000 } })

runtime.catalog() // structured tool descriptions
runtime.execute(source) // Effect<CodeMode.Result, never, ToolServices>
```

The Effect environment is inferred from the supplied tools. `onToolCallStart` observes admitted calls with decoded
input; `onToolCallEnd` observes settled outcomes and duration. Both hooks return Effects and must not fail.

### `Values`

`Values` exports the runtime's non-JSON value classes: `Values.URL`, `Values.URLSearchParams`, `Values.Date`,
`Values.RegExp`, `Values.Map`, `Values.Set`, and `Values.Promise`. The interpreter recognizes these by class; a
program's `new URL(...)` is a `Values.URL` wrapping the host `URL`. `Values.isValue` narrows to the data-like kinds.

### OpenAPI tools

`OpenAPI.fromSpec` converts an OpenAPI 3.x document into one tool per supported operation. Dotted `operationId` values
create namespaces:

```ts
const api = OpenAPI.fromSpec({ spec, auth: { resolve } })
const runtime = CodeMode.make({ tools: { opencode: api.tools } })
```

The synchronous result is `{ tools, skipped }`. Operations with unsupported parameter encodings, request bodies
without JSON content, WebSocket or SSE semantics, or binary responses are reported in `skipped`.

Authentication is resolved by the host and never shown to the model. Generated tools require `HttpClient.HttpClient`.
Request signatures omit `readOnly` properties; response signatures omit `writeOnly` properties. These JSON Schemas
shape model-visible signatures but do not filter runtime values: nested JSON body properties and decoded server
responses pass through unchanged. See `src/openapi/types.ts` for option details.

## Results

Every execution returns:

```ts
type Result =
  | {
      readonly ok: true
      readonly value: CodeMode.DataValue
      readonly warnings?: ReadonlyArray<CodeMode.Diagnostic>
      readonly logs?: ReadonlyArray<string>
      readonly truncated?: boolean
      readonly toolCalls: ReadonlyArray<CodeMode.ToolCall>
    }
  | {
      readonly ok: false
      readonly error: CodeMode.Diagnostic
      readonly logs?: ReadonlyArray<string>
      readonly truncated?: boolean
      readonly toolCalls: ReadonlyArray<CodeMode.ToolCall>
    }
```

`value` is JSON-safe. `warnings` are non-fatal diagnostics, `logs` contain program console output, and `truncated`
indicates that retained output was cut by `maxOutputBytes`. `toolCalls` retains admitted calls in order, including after
failure.

Diagnostic kinds:

| Kind                    | Meaning                                                                                        |
| ----------------------- | ---------------------------------------------------------------------------------------------- |
| `ParseError`            | Source is empty or cannot be parsed.                                                           |
| `UnsupportedSyntax`     | Parsed JavaScript is outside the supported subset.                                             |
| `UnknownTool`           | The program referenced an unavailable tool.                                                    |
| `InvalidToolInput`      | Tool input failed schema decoding or safe-data copying.                                        |
| `InvalidToolOutput`     | Tool output failed schema decoding or safe-data copying.                                       |
| `InvalidDataValue`      | Program data violated the plain-data contract.                                                 |
| `ToolCallLimitExceeded` | The program exceeded `maxToolCalls`.                                                           |
| `TimeoutExceeded`       | Execution timed out; as a warning, background work was interrupted after the program returned. |
| `ToolFailure`           | A tool refused or failed.                                                                      |
| `ExecutionFailure`      | The program threw or another execution error occurred.                                         |
| `Truncated`             | Warning only: additional warnings were omitted by `maxOutputBytes`.                            |

Host failures and defects report their messages and underlying causes. Invalid outputs include the validation or
copying error. Interruption propagates without becoming an error diagnostic.

## Discovery

`runtime.catalog()` returns structured descriptors — exact path, description, and generated TypeScript signature — for
every visible tool. Hosts render their own model-facing instructions from these descriptors; `CodeMode.searchSignature`
and `CodeMode.toolExpression(path)` supply the exact callable forms.

The synchronous `search(...)` built-in is always available. It supports exact-path lookup, namespace-scoped search,
empty-query browsing, and pagination, and returns callable paths with full signatures. Search counts toward
`maxToolCalls`. Search also matches descriptions from enclosing `Namespace` values.

## Execution Limits

| Limit            | Default   | Controls                        |
| ---------------- | --------- | ------------------------------- |
| `timeoutMs`      | unlimited | Total execution time.           |
| `maxToolCalls`   | unlimited | Admitted tool calls.            |
| `maxOutputBytes` | unlimited | Retained result value and logs. |

Execution limits have no default values.

Invalid limit configuration throws `RangeError`. Warnings receive a separate budget equal to `maxOutputBytes`.
Truncation does not fail execution; an oversized value becomes a string with an in-band marker. Timeouts interrupt
tool calls and busy loops, while a result returned before cleanup times out remains successful with a
`TimeoutExceeded` warning. Tool-call concurrency is unrestricted. Boundary data is limited to 32 nested levels.
