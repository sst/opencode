import { ProviderHelper, CommonRequest, CommonResponse, CommonChunk } from "./provider"

type Usage = {
  input_tokens?: number
  input_tokens_details?: {
    cached_tokens?: number
    cache_write_tokens?: number
  }
  output_tokens?: number
  output_tokens_details?: {
    reasoning_tokens?: number
  }
  total_tokens?: number
}

export const openaiHelper: ProviderHelper = ({ workspaceID }) => ({
  format: "openai",
  modifyUrl: (providerApi: string) => providerApi + "/responses",
  modifyHeaders: (headers: Headers, apiKey: string, _stickyId: string) => {
    headers.set("authorization", `Bearer ${apiKey}`)
  },
  modifyBody: (body: Record<string, any>) => body,
  createBinaryStreamDecoder: () => undefined,
  createUsageParser: () => {
    let usage: Usage

    return {
      parse: (chunk: string) => {
        const [event, data] = chunk.split("\n")
        if (event !== "event: response.completed") return
        if (!data.startsWith("data: ")) return

        let json
        try {
          json = JSON.parse(data.slice(6)) as { response?: { usage?: Usage } }
        } catch {
          return
        }

        if (!json.response?.usage) return
        usage = json.response.usage
      },
      retrieve: () => usage,
    }
  },
  extractUsage: (response: any) => response.usage ?? response.response?.usage,
  normalizeUsage: (usage: Usage) => {
    const inputTokens = usage.input_tokens ?? 0
    const outputTokens = usage.output_tokens ?? 0
    const reasoningTokens = usage.output_tokens_details?.reasoning_tokens ?? undefined
    const cacheReadTokens = usage.input_tokens_details?.cached_tokens ?? undefined
    const cacheWriteTokens = usage.input_tokens_details?.cache_write_tokens ?? undefined
    return {
      // OpenAI's input_tokens includes both cached_tokens and cache_write_tokens;
      // each is billed separately at its own rate. Clamp to zero so a provider
      // reporting overlapping detail fields cannot drive input cost negative.
      inputTokens: Math.max(0, inputTokens - (cacheReadTokens ?? 0) - (cacheWriteTokens ?? 0)),
      outputTokens,
      reasoningTokens,
      cacheReadTokens,
      cacheWrite5mTokens: cacheWriteTokens,
      cacheWrite1hTokens: undefined,
    }
  },
})

export function fromOpenaiRequest(body: any): CommonRequest {
  if (!body || typeof body !== "object") return body

  const toImg = (p: any) => {
    if (!p || typeof p !== "object") return undefined
    if ((p as any).type === "image_url" && (p as any).image_url)
      return { type: "image_url", image_url: (p as any).image_url }
    if ((p as any).type === "input_image" && (p as any).image_url)
      return { type: "image_url", image_url: (p as any).image_url }
    const s = (p as any).source
    if (!s || typeof s !== "object") return undefined
    if ((s as any).type === "url" && typeof (s as any).url === "string")
      return { type: "image_url", image_url: { url: (s as any).url } }
    if (
      (s as any).type === "base64" &&
      typeof (s as any).media_type === "string" &&
      typeof (s as any).data === "string"
    )
      return {
        type: "image_url",
        image_url: { url: `data:${(s as any).media_type};base64,${(s as any).data}` },
      }
    return undefined
  }

  const msgs: any[] = []

  const inMsgs = Array.isArray(body.input) ? body.input : Array.isArray(body.messages) ? body.messages : []

  for (const m of inMsgs) {
    if (!m) continue

    // Responses API items without role:
    if (!(m as any).role && (m as any).type) {
      if ((m as any).type === "function_call") {
        const name = (m as any).name
        const a = (m as any).arguments
        const args = typeof a === "string" ? a : JSON.stringify(a ?? {})
        msgs.push({
          role: "assistant",
          tool_calls: [{ id: (m as any).id, type: "function", function: { name, arguments: args } }],
        })
      }
      if ((m as any).type === "function_call_output") {
        const id = (m as any).call_id
        const out = (m as any).output
        const content = typeof out === "string" ? out : JSON.stringify(out)
        msgs.push({ role: "tool", tool_call_id: id, content })
      }
      continue
    }

    if ((m as any).role === "system" || (m as any).role === "developer") {
      const c = (m as any).content
      if (typeof c === "string" && c.length > 0) msgs.push({ role: "system", content: c })
      if (Array.isArray(c)) {
        const t = c.find((p: any) => p && typeof p.text === "string")
        if (t && typeof t.text === "string" && t.text.length > 0) msgs.push({ role: "system", content: t.text })
      }
      continue
    }

    if ((m as any).role === "user") {
      const c = (m as any).content
      if (typeof c === "string") {
        msgs.push({ role: "user", content: c })
      } else if (Array.isArray(c)) {
        const parts: any[] = []
        for (const p of c) {
          if (!p || !(p as any).type) continue
          if (((p as any).type === "text" || (p as any).type === "input_text") && typeof (p as any).text === "string")
            parts.push({ type: "text", text: (p as any).text })
          const ip = toImg(p)
          if (ip) parts.push(ip)
          if ((p as any).type === "tool_result") {
            const id = (p as any).tool_call_id
            const content =
              typeof (p as any).content === "string" ? (p as any).content : JSON.stringify((p as any).content)
            msgs.push({ role: "tool", tool_call_id: id, content })
          }
        }
        if (parts.length === 1 && parts[0].type === "text") msgs.push({ role: "user", content: parts[0].text })
        else if (parts.length > 0) msgs.push({ role: "user", content: parts })
      }
      continue
    }

    if ((m as any).role === "assistant") {
      const c = (m as any).content
      const out: any = { role: "assistant" }
      if (typeof c === "string" && c.length > 0) out.content = c
      if (Array.isArray((m as any).tool_calls)) out.tool_calls = (m as any).tool_calls
      msgs.push(out)
      continue
    }

    if ((m as any).role === "tool") {
      msgs.push({
        role: "tool",
        tool_call_id: (m as any).tool_call_id,
        content: (m as any).content,
      })
      continue
    }
  }

  const tcIn = body.tool_choice
  const tc = (() => {
    if (!tcIn) return undefined
    if (tcIn === "auto") return "auto"
    if (tcIn === "required") return "required"
    if ((tcIn as any).type === "function" && (tcIn as any).function?.name)
      return { type: "function" as const, function: { name: (tcIn as any).function.name } }
    return undefined
  })()

  const stop = (() => {
    const v = body.stop_sequences ?? body.stop
    if (!v) return undefined
    if (Array.isArray(v)) return v.length === 1 ? v[0] : v
    if (typeof v === "string") return v
    return undefined
  })()

  return {
    model: body.model,
    max_tokens: body.max_output_tokens ?? body.max_tokens,
    temperature: body.temperature,
    top_p: body.top_p,
    stop,
    messages: msgs,
    stream: !!body.stream,
    tools: Array.isArray(body.tools) ? body.tools : undefined,
    tool_choice: tc,
  }
}

export function toOpenaiRequest(body: CommonRequest) {
  if (!body || typeof body !== "object") return body

  const msgsIn = Array.isArray(body.messages) ? body.messages : []
  const input: any[] = []

  const toPart = (p: any) => {
    if (!p || typeof p !== "object") return undefined
    if ((p as any).type === "text" && typeof (p as any).text === "string")
      return { type: "input_text", text: (p as any).text }
    if ((p as any).type === "image_url" && (p as any).image_url)
      return { type: "input_image", image_url: (p as any).image_url }
    const s = (p as any).source
    if (!s || typeof s !== "object") return undefined
    if ((s as any).type === "url" && typeof (s as any).url === "string")
      return { type: "input_image", image_url: { url: (s as any).url } }
    if (
      (s as any).type === "base64" &&
      typeof (s as any).media_type === "string" &&
      typeof (s as any).data === "string"
    )
      return {
        type: "input_image",
        image_url: { url: `data:${(s as any).media_type};base64,${(s as any).data}` },
      }
    return undefined
  }

  for (const m of msgsIn) {
    if (!m || !(m as any).role) continue

    if ((m as any).role === "system") {
      const c = (m as any).content
      if (typeof c === "string") input.push({ role: "system", content: c })
      continue
    }

    if ((m as any).role === "user") {
      const c = (m as any).content
      if (typeof c === "string") {
        input.push({ role: "user", content: [{ type: "input_text", text: c }] })
      } else if (Array.isArray(c)) {
        const parts: any[] = []
        for (const p of c) {
          const op = toPart(p)
          if (op) parts.push(op)
        }
        if (parts.length > 0) input.push({ role: "user", content: parts })
      }
      continue
    }

    if ((m as any).role === "assistant") {
      const c = (m as any).content
      if (typeof c === "string" && c.length > 0) {
        input.push({ role: "assistant", content: [{ type: "output_text", text: c }] })
      }
      if (Array.isArray((m as any).tool_calls)) {
        for (const tc of (m as any).tool_calls) {
          if ((tc as any).type === "function" && (tc as any).function) {
            const name = (tc as any).function.name
            const a = (tc as any).function.arguments
            const args = typeof a === "string" ? a : JSON.stringify(a)
            input.push({ type: "function_call", call_id: (tc as any).id, name, arguments: args })
          }
        }
      }
      continue
    }

    if ((m as any).role === "tool") {
      const out = typeof (m as any).content === "string" ? (m as any).content : JSON.stringify((m as any).content)
      input.push({ type: "function_call_output", call_id: (m as any).tool_call_id, output: out })
      continue
    }
  }

  const stop_sequences = (() => {
    const v = body.stop
    if (!v) return undefined
    if (Array.isArray(v)) return v
    if (typeof v === "string") return [v]
    return undefined
  })()

  const tcIn = body.tool_choice
  const tool_choice = (() => {
    if (!tcIn) return undefined
    if (tcIn === "auto") return "auto"
    if (tcIn === "required") return "required"
    if ((tcIn as any).type === "function" && (tcIn as any).function?.name)
      return { type: "function", function: { name: (tcIn as any).function.name } }
    return undefined
  })()

  const tools = (() => {
    if (!Array.isArray(body.tools)) return undefined
    return body.tools.map((tool: any) => {
      if (tool.type === "function") {
        return {
          type: "function",
          name: tool.function?.name,
          description: tool.function?.description,
          parameters: tool.function?.parameters,
          strict: tool.function?.strict,
        }
      }
      return tool
    })
  })()

  return {
    model: body.model,
    input,
    max_output_tokens: body.max_tokens,
    top_p: body.top_p,
    stop_sequences,
    stream: !!body.stream,
    tools,
    tool_choice,
    include: Array.isArray((body as any).include) ? (body as any).include : undefined,
    truncation: (body as any).truncation,
    metadata: (body as any).metadata,
    store: (body as any).store,
    user: (body as any).user,
    text: { verbosity: body.model === "gpt-5-codex" ? "medium" : "low" },
    reasoning: { effort: "medium" },
  }
}

export function fromOpenaiResponse(resp: any): CommonResponse {
  if (!resp || typeof resp !== "object") return resp
  if (Array.isArray((resp as any).choices)) return resp

  const r = (resp as any).response ?? resp
  if (!r || typeof r !== "object") return resp

  const idIn = (r as any).id
  const id =
    typeof idIn === "string" ? idIn.replace(/^resp_/, "chatcmpl_") : `chatcmpl_${Math.random().toString(36).slice(2)}`
  const model = (r as any).model ?? (resp as any).model

  const out = Array.isArray((r as any).output) ? (r as any).output : []
  const text = out
    .filter((o: any) => o && o.type === "message" && Array.isArray((o as any).content))
    .flatMap((o: any) => (o as any).content)
    .filter((p: any) => p && p.type === "output_text" && typeof p.text === "string")
    .map((p: any) => p.text)
    .join("")

  const tcs = out
    .filter((o: any) => o && o.type === "function_call")
    .map((o: any) => {
      const name = (o as any).name
      const a = (o as any).arguments
      const args = typeof a === "string" ? a : JSON.stringify(a ?? {})
      const tid =
        typeof (o as any).id === "string" && (o as any).id.length > 0
          ? (o as any).id
          : `toolu_${Math.random().toString(36).slice(2)}`
      return { id: tid, type: "function" as const, function: { name, arguments: args } }
    })

  const finish = (r: string | null) => {
    if (r === "stop") return "stop"
    if (r === "tool_call" || r === "tool_calls") return "tool_calls"
    if (r === "length" || r === "max_output_tokens") return "length"
    if (r === "content_filter") return "content_filter"
    return null
  }

  const u = (r as any).usage ?? (resp as any).usage
  const usage = (() => {
    if (!u) return undefined as any
    const pt = typeof (u as any).input_tokens === "number" ? (u as any).input_tokens : undefined
    const ct = typeof (u as any).output_tokens === "number" ? (u as any).output_tokens : undefined
    const total = pt != null && ct != null ? pt + ct : undefined
    const cached = (u as any).input_tokens_details?.cached_tokens
    const details = typeof cached === "number" ? { cached_tokens: cached } : undefined
    return {
      prompt_tokens: pt,
      completion_tokens: ct,
      total_tokens: total,
      ...(details ? { prompt_tokens_details: details } : {}),
    }
  })()

  return {
    id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          ...(text && text.length > 0 ? { content: text } : {}),
          ...(tcs.length > 0 ? { tool_calls: tcs } : {}),
        },
        finish_reason: finish((r as any).stop_reason ?? null),
      },
    ],
    ...(usage ? { usage } : {}),
  }
}

export function toOpenaiResponse(resp: CommonResponse) {
  if (!resp || typeof resp !== "object") return resp
  if (!Array.isArray((resp as any).choices)) return resp

  const choice = (resp as any).choices[0]
  if (!choice) return resp

  const msg = choice.message
  if (!msg) return resp

  const outputItems: any[] = []

  if (typeof msg.content === "string" && msg.content.length > 0) {
    outputItems.push({
      id: `msg_${Math.random().toString(36).slice(2)}`,
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: msg.content, annotations: [], logprobs: [] }],
    })
  }

  if (Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls) {
      if ((tc as any).type === "function" && (tc as any).function) {
        outputItems.push({
          id: (tc as any).id,
          type: "function_call",
          name: (tc as any).function.name,
          call_id: (tc as any).id,
          arguments: (tc as any).function.arguments,
        })
      }
    }
  }

  const stop_reason = (() => {
    const r = choice.finish_reason
    if (r === "stop") return "stop"
    if (r === "tool_calls") return "tool_call"
    if (r === "length") return "max_output_tokens"
    if (r === "content_filter") return "content_filter"
    return null
  })()

  const usage = (() => {
    const u = (resp as any).usage
    if (!u) return undefined
    return {
      input_tokens: u.prompt_tokens,
      output_tokens: u.completion_tokens,
      total_tokens: u.total_tokens,
      ...(u.prompt_tokens_details?.cached_tokens
        ? { input_tokens_details: { cached_tokens: u.prompt_tokens_details.cached_tokens } }
        : {}),
    }
  })()

  return {
    id: (resp as any).id?.replace(/^chatcmpl_/, "resp_") ?? `resp_${Math.random().toString(36).slice(2)}`,
    object: "response",
    model: (resp as any).model,
    output: outputItems,
    stop_reason,
    usage,
  }
}

export function fromOpenaiChunk(chunk: string): CommonChunk | string {
  const lines = chunk.split("\n")
  const ev = lines[0]
  const dl = lines[1]
  if (!ev || !dl || !dl.startsWith("data: ")) return chunk

  let json: any
  try {
    json = JSON.parse(dl.slice(6))
  } catch {
    return chunk
  }

  const respObj = json.response ?? {}

  const out: CommonChunk = {
    id: respObj.id ?? json.id ?? "",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: respObj.model ?? json.model ?? "",
    choices: [],
  }

  const e = ev.replace("event: ", "").trim()

  if (e === "response.output_text.delta") {
    const d = (json as any).delta ?? (json as any).text ?? (json as any).output_text_delta
    if (typeof d === "string" && d.length > 0)
      out.choices.push({ index: 0, delta: { content: d }, finish_reason: null })
  }

  if (e === "response.output_item.added" && (json as any).item?.type === "function_call") {
    const name = (json as any).item?.name
    const id = (json as any).item?.id
    if (typeof name === "string" && name.length > 0) {
      out.choices.push({
        index: 0,
        delta: {
          tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: "" } }],
        },
        finish_reason: null,
      })
    }
  }

  if (e === "response.function_call_arguments.delta") {
    const a = (json as any).delta ?? (json as any).arguments_delta
    if (typeof a === "string" && a.length > 0) {
      out.choices.push({
        index: 0,
        delta: { tool_calls: [{ index: 0, function: { arguments: a } }] },
        finish_reason: null,
      })
    }
  }

  if (e === "response.completed") {
    const fr = (() => {
      const sr = (respObj as any).stop_reason ?? (json as any).stop_reason
      if (sr === "stop") return "stop"
      if (sr === "tool_call" || sr === "tool_calls") return "tool_calls"
      if (sr === "length" || sr === "max_output_tokens") return "length"
      if (sr === "content_filter") return "content_filter"
      return null
    })()
    out.choices.push({ index: 0, delta: {}, finish_reason: fr })

    const u = (respObj as any).usage ?? (json as any).response?.usage
    if (u) {
      out.usage = {
        prompt_tokens: u.input_tokens,
        completion_tokens: u.output_tokens,
        total_tokens: (u.input_tokens || 0) + (u.output_tokens || 0),
        ...(u.input_tokens_details?.cached_tokens
          ? { prompt_tokens_details: { cached_tokens: u.input_tokens_details.cached_tokens } }
          : {}),
      }
    }
  }

  return out
}

export function toOpenaiChunk(chunk: CommonChunk): string {
  if (!chunk.choices || !Array.isArray(chunk.choices) || chunk.choices.length === 0) {
    return ""
  }

  const choice = chunk.choices[0]
  const d = choice.delta
  if (!d) return ""

  const id = chunk.id
  const model = chunk.model

  if (d.content) {
    const data = {
      id,
      type: "response.output_text.delta",
      delta: d.content,
      response: { id, model },
    }
    return `event: response.output_text.delta\ndata: ${JSON.stringify(data)}`
  }

  if (d.tool_calls) {
    for (const tc of d.tool_calls) {
      if (tc.function?.name) {
        const data = {
          type: "response.output_item.added",
          output_index: 0,
          item: {
            id: tc.id,
            type: "function_call",
            name: tc.function.name,
            call_id: tc.id,
            arguments: "",
          },
        }
        return `event: response.output_item.added\ndata: ${JSON.stringify(data)}`
      }
      if (tc.function?.arguments) {
        const data = {
          type: "response.function_call_arguments.delta",
          output_index: 0,
          delta: tc.function.arguments,
        }
        return `event: response.function_call_arguments.delta\ndata: ${JSON.stringify(data)}`
      }
    }
  }

  if (choice.finish_reason) {
    const u = chunk.usage
    const usage = u
      ? {
          input_tokens: u.prompt_tokens,
          output_tokens: u.completion_tokens,
          total_tokens: u.total_tokens,
          ...(u.prompt_tokens_details?.cached_tokens
            ? { input_tokens_details: { cached_tokens: u.prompt_tokens_details.cached_tokens } }
            : {}),
        }
      : undefined

    const data: any = {
      id,
      type: "response.completed",
      response: { id, model, ...(usage ? { usage } : {}) },
    }
    return `event: response.completed\ndata: ${JSON.stringify(data)}`
  }

  return ""
}
