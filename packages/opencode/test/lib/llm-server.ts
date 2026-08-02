import { NodeHttpServer, NodeHttpServerRequest } from "@effect/platform-node"
import * as Http from "node:http"
import { Deferred, Effect, Layer, Context, Stream } from "effect"
import * as HttpServer from "effect/unstable/http/HttpServer"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"

export type Usage = { input: number; output: number }

type Line = Record<string, unknown>

type Flow =
  | { type: "text"; text: string }
  | { type: "reason"; text: string }
  | { type: "tool-start"; id: string; name: string }
  | { type: "tool-args"; text: string }
  | { type: "usage"; usage: Usage }

type Hit = {
  url: URL
  body: Record<string, unknown>
}

type Match = (hit: Hit) => boolean

type Queue = {
  item: Item
  match?: Match
}

type Wait = {
  count: number
  ready: Deferred.Deferred<void>
}

type Sse = {
  type: "sse"
  head: unknown[]
  tail: unknown[]
  wait?: PromiseLike<unknown>
  hang?: boolean
  error?: unknown
  reset?: boolean
}

type HttpError = {
  type: "http-error"
  status: number
  body: unknown
}

export type Item = Sse | HttpError

const done = Symbol("done")

function line(input: unknown) {
  if (input === done) return "data: [DONE]\n\n"
  return `data: ${JSON.stringify(input)}\n\n`
}

function tokens(input?: Usage) {
  if (!input) return
  return {
    prompt_tokens: input.input,
    completion_tokens: input.output,
    total_tokens: input.input + input.output,
  }
}

function chunk(input: { delta?: Record<string, unknown>; finish?: string; usage?: Usage }) {
  return {
    id: "chatcmpl-test",
    object: "chat.completion.chunk",
    choices: [
      {
        delta: input.delta ?? {},
        ...(input.finish ? { finish_reason: input.finish } : {}),
      },
    ],
    ...(input.usage ? { usage: tokens(input.usage) } : {}),
  } satisfies Line
}

function role() {
  return chunk({ delta: { role: "assistant" } })
}

function textLine(value: string) {
  return chunk({ delta: { content: value } })
}

function reasonLine(value: string) {
  return chunk({ delta: { reasoning_content: value } })
}

function finishLine(reason: string, usage?: Usage) {
  return chunk({ finish: reason, usage })
}

function toolStartLine(id: string, name: string) {
  return chunk({
    delta: {
      tool_calls: [
        {
          index: 0,
          id,
          type: "function",
          function: {
            name,
            arguments: "",
          },
        },
      ],
    },
  })
}

function toolArgsLine(value: string) {
  return chunk({
    delta: {
      tool_calls: [
        {
          index: 0,
          function: {
            arguments: value,
          },
        },
      ],
    },
  })
}

function bytes(input: Iterable<unknown>) {
  return Stream.fromIterable([...input].map(line)).pipe(Stream.encodeText)
}

function responseCreated(model: string) {
  return {
    type: "response.created",
    sequence_number: 1,
    response: {
      id: "resp_test",
      created_at: Math.floor(Date.now() / 1000),
      model,
      service_tier: null,
    },
  }
}

function responseCompleted(input: { seq: number; usage?: Usage }) {
  return {
    type: "response.completed",
    sequence_number: input.seq,
    response: {
      incomplete_details: null,
      service_tier: null,
      usage: {
        input_tokens: input.usage?.input ?? 0,
        input_tokens_details: { cached_tokens: null },
        output_tokens: input.usage?.output ?? 0,
        output_tokens_details: { reasoning_tokens: null },
      },
    },
  }
}

function responseMessage(id: string, seq: number) {
  return {
    type: "response.output_item.added",
    sequence_number: seq,
    output_index: 0,
    item: { type: "message", id },
  }
}

function responseText(id: string, text: string, seq: number) {
  return {
    type: "response.output_text.delta",
    sequence_number: seq,
    item_id: id,
    delta: text,
    logprobs: null,
  }
}

function responseMessageDone(id: string, seq: number) {
  return {
    type: "response.output_item.done",
    sequence_number: seq,
    output_index: 0,
    item: { type: "message", id },
  }
}

function responseReason(id: string, seq: number) {
  return {
    type: "response.output_item.added",
    sequence_number: seq,
    output_index: 0,
    item: { type: "reasoning", id, encrypted_content: null },
  }
}

function responseReasonPart(id: string, seq: number) {
  return {
    type: "response.reasoning_summary_part.added",
    sequence_number: seq,
    item_id: id,
    summary_index: 0,
  }
}

function responseReasonText(id: string, text: string, seq: number) {
  return {
    type: "response.reasoning_summary_text.delta",
    sequence_number: seq,
    item_id: id,
    summary_index: 0,
    delta: text,
  }
}

function responseReasonDone(id: string, seq: number) {
  return {
    type: "response.output_item.done",
    sequence_number: seq,
    output_index: 0,
    item: { type: "reasoning", id, encrypted_content: null },
  }
}

function responseTool(id: string, item: string, name: string, seq: number) {
  return {
    type: "response.output_item.added",
    sequence_number: seq,
    output_index: 0,
    item: {
      type: "function_call",
      id: item,
      call_id: id,
      name,
      arguments: "",
      status: "in_progress",
    },
  }
}

function responseToolArgs(id: string, text: string, seq: number) {
  return {
    type: "response.function_call_arguments.delta",
    sequence_number: seq,
    output_index: 0,
    item_id: id,
    delta: text,
  }
}

function responseToolArgsDone(id: string, args: string, seq: number) {
  return {
    type: "response.function_call_arguments.done",
    sequence_number: seq,
    output_index: 0,
    item_id: id,
    arguments: args,
  }
}

function responseToolDone(tool: { id: string; item: string; name: string; args: string }, seq: number) {
  return {
    type: "response.output_item.done",
    sequence_number: seq,
    output_index: 0,
    item: {
      type: "function_call",
      id: tool.item,
      call_id: tool.id,
      name: tool.name,
      arguments: tool.args,
      status: "completed",
    },
  }
}

function choices(part: unknown) {
  if (!part || typeof part !== "object") return
  if (!("choices" in part) || !Array.isArray(part.choices)) return
  const choice = part.choices[0]
  if (!choice || typeof choice !== "object") return
  return choice
}

function flow(item: Sse) {
  const out: Flow[] = []
  for (const part of [...item.head, ...item.tail]) {
    const choice = choices(part)
    const delta =
      choice && "delta" in choice && choice.delta && typeof choice.delta === "object" ? choice.delta : undefined

    if (delta && "content" in delta && typeof delta.content === "string") {
      out.push({ type: "text", text: delta.content })
    }

    if (delta && "reasoning_content" in delta && typeof delta.reasoning_content === "string") {
      out.push({ type: "reason", text: delta.reasoning_content })
    }

    if (delta && "tool_calls" in delta && Array.isArray(delta.tool_calls)) {
      for (const tool of delta.tool_calls) {
        if (!tool || typeof tool !== "object") continue
        const fn = "function" in tool && tool.function && typeof tool.function === "object" ? tool.function : undefined
        if ("id" in tool && typeof tool.id === "string" && fn && "name" in fn && typeof fn.name === "string") {
          out.push({ type: "tool-start", id: tool.id, name: fn.name })
        }
        if (fn && "arguments" in fn && typeof fn.arguments === "string" && fn.arguments) {
          out.push({ type: "tool-args", text: fn.arguments })
        }
      }
    }

    if (part && typeof part === "object" && "usage" in part && part.usage && typeof part.usage === "object") {
      const raw = part.usage as Record<string, unknown>
      if (typeof raw.prompt_tokens === "number" && typeof raw.completion_tokens === "number") {
        out.push({
          type: "usage",
          usage: { input: raw.prompt_tokens, output: raw.completion_tokens },
        })
      }
    }
  }
  return out
}

function responses(item: Sse, model: string) {
  let seq = 1
  let msg: string | undefined
  let reason: string | undefined
  let hasMsg = false
  let hasReason = false
  let call:
    | {
        id: string
        item: string
        name: string
        args: string
      }
    | undefined
  let usage: Usage | undefined
  const lines: unknown[] = [responseCreated(model)]

  for (const part of flow(item)) {
    if (part.type === "text") {
      msg ??= "msg_1"
      if (!hasMsg) {
        hasMsg = true
        seq += 1
        lines.push(responseMessage(msg, seq))
      }
      seq += 1
      lines.push(responseText(msg, part.text, seq))
      continue
    }

    if (part.type === "reason") {
      reason ||= "rs_1"
      if (!hasReason) {
        hasReason = true
        seq += 1
        lines.push(responseReason(reason, seq))
        seq += 1
        lines.push(responseReasonPart(reason, seq))
      }
      seq += 1
      lines.push(responseReasonText(reason, part.text, seq))
      continue
    }

    if (part.type === "tool-start") {
      call ||= { id: part.id, item: "fc_1", name: part.name, args: "" }
      seq += 1
      lines.push(responseTool(call.id, call.item, call.name, seq))
      continue
    }

    if (part.type === "tool-args") {
      if (!call) continue
      call.args += part.text
      seq += 1
      lines.push(responseToolArgs(call.item, part.text, seq))
      continue
    }

    usage = part.usage
  }

  if (msg) {
    seq += 1
    lines.push(responseMessageDone(msg, seq))
  }
  if (reason) {
    seq += 1
    lines.push(responseReasonDone(reason, seq))
  }
  if (call && !item.hang && !item.error) {
    seq += 1
    lines.push(responseToolArgsDone(call.item, call.args, seq))
    seq += 1
    lines.push(responseToolDone(call, seq))
  }
  if (!item.hang && !item.error) lines.push(responseCompleted({ seq: seq + 1, usage }))
  return { ...item, head: lines, tail: [] } satisfies Sse
}

function modelFrom(body: unknown) {
  if (!body || typeof body !== "object") return "test-model"
  if (!("model" in body) || typeof body.model !== "string") return "test-model"
  return body.model
}

function send(item: Sse) {
  const head = bytes(item.head)
  const tail = bytes([...item.tail, ...(item.hang || item.error ? [] : [done])])
  const empty = Stream.fromIterable<Uint8Array>([])
  const wait = item.wait
  const body: Stream.Stream<Uint8Array, unknown> = wait
    ? Stream.concat(head, Stream.fromEffect(Effect.promise(() => wait)).pipe(Stream.flatMap(() => tail)))
    : Stream.concat(head, tail)
  let end: Stream.Stream<Uint8Array, unknown> = empty
  if (item.error) end = Stream.concat(empty, Stream.fail(item.error))
  else if (item.hang) end = Stream.concat(empty, Stream.never)

  return HttpServerResponse.stream(Stream.concat(body, end), { contentType: "text/event-stream" })
}

const reset = Effect.fn("TestLLMServer.reset")(function* (item: Sse) {
  const req = yield* HttpServerRequest.HttpServerRequest
  const res = NodeHttpServerRequest.toServerResponse(req)
  yield* Effect.sync(() => {
    res.writeHead(200, { "content-type": "text/event-stream" })
    for (const part of item.head) res.write(line(part))
    for (const part of item.tail) res.write(line(part))
    res.destroy(new Error("connection reset"))
  })
  return yield* Effect.never
})

function fail(item: HttpError) {
  return HttpServerResponse.text(JSON.stringify(item.body), {
    status: item.status,
    contentType: "application/json",
  })
}

export class Reply {
  #head: unknown[] = [role()]
  #tail: unknown[] = []
  #usage: Usage | undefined
  #finish: string | undefined
  #wait: PromiseLike<unknown> | undefined
  #hang = false
  #error: unknown
  #reset = false
  #seq = 0

  #id() {
    this.#seq += 1
    return `call_${this.#seq}`
  }

  text(value: string) {
    this.#tail = [...this.#tail, textLine(value)]
    return this
  }

  reason(value: string) {
    this.#tail = [...this.#tail, reasonLine(value)]
    return this
  }

  usage(value: Usage) {
    this.#usage = value
    return this
  }

  wait(value: PromiseLike<unknown>) {
    this.#wait = value
    return this
  }

  stop() {
    this.#finish = "stop"
    this.#hang = false
    this.#error = undefined
    this.#reset = false
    return this
  }

  length() {
    this.#finish = "length"
    this.#hang = false
    this.#error = undefined
    this.#reset = false
    return this
  }

  contentFilter() {
    this.#finish = "content_filter"
    this.#hang = false
    this.#error = undefined
    this.#reset = false
    return this
  }

  toolCalls() {
    this.#finish = "tool_calls"
    this.#hang = false
    this.#error = undefined
    this.#reset = false
    return this
  }

  tool(name: string, input: unknown) {
    const id = this.#id()
    const args = JSON.stringify(input)
    this.#tail = [...this.#tail, toolStartLine(id, name), toolArgsLine(args)]
    return this.toolCalls()
  }

  pendingTool(name: string, input: unknown) {
    const id = this.#id()
    const args = JSON.stringify(input)
    const size = Math.max(1, Math.floor(args.length / 2))
    this.#tail = [...this.#tail, toolStartLine(id, name), toolArgsLine(args.slice(0, size))]
    return this
  }

  hang() {
    this.#finish = undefined
    this.#hang = true
    this.#error = undefined
    this.#reset = false
    return this
  }

  streamError(error: unknown = "boom") {
    this.#finish = undefined
    this.#hang = false
    this.#error = error
    this.#reset = false
    return this
  }

  reset() {
    this.#finish = undefined
    this.#hang = false
    this.#error = undefined
    this.#reset = true
    return this
  }

  item(): Item {
    return {
      type: "sse",
      head: this.#head,
      tail: this.#finish ? [...this.#tail, finishLine(this.#finish, this.#usage)] : this.#tail,
      wait: this.#wait,
      hang: this.#hang,
      error: this.#error,
      reset: this.#reset,
    }
  }
}

export function reply() {
  return new Reply()
}

export function httpError(status: number, body: unknown): Item {
  return {
    type: "http-error",
    status,
    body,
  }
}

export function raw(input: {
  chunks?: unknown[]
  head?: unknown[]
  tail?: unknown[]
  wait?: PromiseLike<unknown>
  hang?: boolean
  error?: unknown
  reset?: boolean
}): Item {
  return {
    type: "sse",
    head: input.head ?? input.chunks ?? [],
    tail: input.tail ?? [],
    wait: input.wait,
    hang: input.hang,
    error: input.error,
    reset: input.reset,
  }
}

function item(input: Item | Reply) {
  return input instanceof Reply ? input.item() : input
}

function hit(url: string, body: unknown) {
  return {
    url: new URL(url, "http://localhost"),
    body: body && typeof body === "object" ? (body as Record<string, unknown>) : {},
  } satisfies Hit
}

function isTitleRequest(body: unknown): boolean {
  if (!body || typeof body !== "object") return false
  return JSON.stringify(body).includes("Generate a title for this conversation")
}

namespace TestLLMServer {
  export interface Service {
    readonly url: string
    readonly push: (...input: (Item | Reply)[]) => Effect.Effect<void>
    readonly pushMatch: (match: Match, ...input: (Item | Reply)[]) => Effect.Effect<void>
    readonly textMatch: (match: Match, value: string, opts?: { usage?: Usage }) => Effect.Effect<void>
    readonly toolMatch: (match: Match, name: string, input: unknown) => Effect.Effect<void>
    readonly text: (value: string, opts?: { usage?: Usage }) => Effect.Effect<void>
    readonly tool: (name: string, input: unknown) => Effect.Effect<void>
    readonly toolHang: (name: string, input: unknown) => Effect.Effect<void>
    readonly reason: (value: string, opts?: { text?: string; usage?: Usage }) => Effect.Effect<void>
    readonly fail: (message?: unknown) => Effect.Effect<void>
    readonly error: (status: number, body: unknown) => Effect.Effect<void>
    readonly hang: Effect.Effect<void>
    readonly hold: (value: string, wait: PromiseLike<unknown>) => Effect.Effect<void>
    readonly reset: Effect.Effect<void>
    readonly hits: Effect.Effect<Hit[]>
    readonly calls: Effect.Effect<number>
    readonly wait: (count: number) => Effect.Effect<void>
    readonly inputs: Effect.Effect<Record<string, unknown>[]>
    readonly pending: Effect.Effect<number>
    readonly misses: Effect.Effect<Hit[]>
  }
}

export class TestLLMServer extends Context.Service<TestLLMServer, TestLLMServer.Service>()("@test/LLMServer") {
  static readonly layer = Layer.effect(
    TestLLMServer,
    Effect.gen(function* () {
      const server = yield* HttpServer.HttpServer
      const router = yield* HttpRouter.HttpRouter

      let hits: Hit[] = []
      let list: Queue[] = []
      let waits: Wait[] = []
      let misses: Hit[] = []

      const queue = (...input: (Item | Reply)[]) => {
        list = [...list, ...input.map((value) => ({ item: item(value) }))]
      }

      const queueMatch = (match: Match, ...input: (Item | Reply)[]) => {
        list = [...list, ...input.map((value) => ({ item: item(value), match }))]
      }

      const notify = Effect.fnUntraced(function* () {
        const ready = waits.filter((item) => hits.length >= item.count)
        if (!ready.length) return
        waits = waits.filter((item) => hits.length < item.count)
        yield* Effect.forEach(ready, (item) => Deferred.succeed(item.ready, void 0))
      })

      const pull = (hit: Hit) => {
        const index = list.findIndex((entry) => !entry.match || entry.match(hit))
        if (index === -1) return
        const first = list[index]
        list = [...list.slice(0, index), ...list.slice(index + 1)]
        return first.item
      }

      const handle = Effect.fn("TestLLMServer.handle")(function* (mode: "chat" | "responses") {
        const req = yield* HttpServerRequest.HttpServerRequest
        const body = yield* req.json.pipe(Effect.orElseSucceed(() => ({})))
        const current = hit(req.originalUrl, body)
        if (isTitleRequest(body)) {
          hits = [...hits, current]
          yield* notify()
          const auto: Sse = { type: "sse", head: [role()], tail: [textLine("E2E Title"), finishLine("stop")] }
          if (mode === "responses") return send(responses(auto, modelFrom(body)))
          return send(auto)
        }
        const next = pull(current)
        if (!next) {
          hits = [...hits, current]
          yield* notify()
          const auto: Sse = { type: "sse", head: [role()], tail: [textLine("ok"), finishLine("stop")] }
          if (mode === "responses") return send(responses(auto, modelFrom(body)))
          return send(auto)
        }
        hits = [...hits, current]
        yield* notify()
        if (next.type !== "sse") return fail(next)
        if (mode === "responses") return send(responses(next, modelFrom(body)))
        if (next.reset) {
          yield* reset(next)
          return HttpServerResponse.empty()
        }
        return send(next)
      })

      yield* router.add("POST", "/v1/chat/completions", handle("chat"))
      yield* router.add("POST", "/v1/responses", handle("responses"))

      yield* server.serve(router.asHttpEffect())

      return TestLLMServer.of({
        url:
          server.address._tag === "TcpAddress"
            ? `http://127.0.0.1:${server.address.port}/v1`
            : `unix://${server.address.path}/v1`,
        push: Effect.fn("TestLLMServer.push")(function* (...input: (Item | Reply)[]) {
          queue(...input)
        }),
        pushMatch: Effect.fn("TestLLMServer.pushMatch")(function* (match: Match, ...input: (Item | Reply)[]) {
          queueMatch(match, ...input)
        }),
        textMatch: Effect.fn("TestLLMServer.textMatch")(function* (
          match: Match,
          value: string,
          opts?: { usage?: Usage },
        ) {
          const out = reply().text(value)
          if (opts?.usage) out.usage(opts.usage)
          queueMatch(match, out.stop().item())
        }),
        toolMatch: Effect.fn("TestLLMServer.toolMatch")(function* (match: Match, name: string, input: unknown) {
          queueMatch(match, reply().tool(name, input).item())
        }),
        text: Effect.fn("TestLLMServer.text")(function* (value: string, opts?: { usage?: Usage }) {
          const out = reply().text(value)
          if (opts?.usage) out.usage(opts.usage)
          queue(out.stop().item())
        }),
        tool: Effect.fn("TestLLMServer.tool")(function* (name: string, input: unknown) {
          queue(reply().tool(name, input).item())
        }),
        toolHang: Effect.fn("TestLLMServer.toolHang")(function* (name: string, input: unknown) {
          queue(reply().pendingTool(name, input).hang().item())
        }),
        reason: Effect.fn("TestLLMServer.reason")(function* (value: string, opts?: { text?: string; usage?: Usage }) {
          const out = reply().reason(value)
          if (opts?.text) out.text(opts.text)
          if (opts?.usage) out.usage(opts.usage)
          queue(out.stop().item())
        }),
        fail: Effect.fn("TestLLMServer.fail")(function* (message: unknown = "boom") {
          queue(reply().streamError(message).item())
        }),
        error: Effect.fn("TestLLMServer.error")(function* (status: number, body: unknown) {
          queue(httpError(status, body))
        }),
        hang: Effect.gen(function* () {
          queue(reply().hang().item())
        }).pipe(Effect.withSpan("TestLLMServer.hang")),
        hold: Effect.fn("TestLLMServer.hold")(function* (value: string, wait: PromiseLike<unknown>) {
          queue(reply().wait(wait).text(value).stop().item())
        }),
        reset: Effect.sync(() => {
          hits = []
          list = []
          waits = []
          misses = []
        }),
        hits: Effect.sync(() => [...hits]),
        calls: Effect.sync(() => hits.length),
        wait: Effect.fn("TestLLMServer.wait")(function* (count: number) {
          if (hits.length >= count) return
          const ready = yield* Deferred.make<void>()
          waits = [...waits, { count, ready }]
          yield* Deferred.await(ready)
        }),
        inputs: Effect.sync(() => hits.map((hit) => hit.body)),
        pending: Effect.sync(() => list.length),
        misses: Effect.sync(() => [...misses]),
      })
    }),
  ).pipe(Layer.provide(HttpRouter.layer), Layer.provide(NodeHttpServer.layer(() => Http.createServer(), { port: 0 })))
}
