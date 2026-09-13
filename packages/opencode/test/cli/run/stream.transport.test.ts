import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import { OpencodeClient, type AssistantMessage, type GlobalEvent } from "@opencode-ai/sdk/v2"
import { createSessionTransport } from "@/cli/cmd/run/stream.transport"
import type { FooterApi, FooterEvent, LocalReplayRow, RunFilePart, StreamCommit } from "@/cli/cmd/run/types"

type EventStream = Awaited<ReturnType<OpencodeClient["event"]["subscribe"]>>["stream"]
type GlobalEventStream = Awaited<ReturnType<OpencodeClient["global"]["event"]>>["stream"]
type SdkEvent = EventStream extends AsyncGenerator<infer T, unknown, unknown> ? T : never
type SessionMessage = NonNullable<Awaited<ReturnType<OpencodeClient["session"]["messages"]>>["data"]>[number]
type SessionChild = NonNullable<Awaited<ReturnType<OpencodeClient["session"]["children"]>>["data"]>[number]
type SessionToolPart = Extract<SessionMessage["parts"][number], { type: "tool" }>
type SessionStatusMap = NonNullable<Awaited<ReturnType<OpencodeClient["session"]["status"]>>["data"]>
type TextPart = Extract<SessionMessage["parts"][number], { type: "text" }>
type ReasoningPart = Extract<SessionMessage["parts"][number], { type: "reasoning" }>

afterEach(() => {
  mock.restore()
})

function defer<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (error?: unknown) => void
  const promise = new Promise<T>((next, fail) => {
    resolve = next
    reject = fail
  })

  return { promise, resolve, reject }
}

async function waitFor<T>(check: () => T | undefined, timeout = 1_000): Promise<T> {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    const value = check()
    if (value !== undefined) {
      return value
    }

    await Bun.sleep(10)
  }

  throw new Error("timed out waiting for value")
}

function busy(sessionID = "session-1") {
  return {
    id: `evt-${sessionID}-busy`,
    type: "session.status",
    properties: {
      sessionID,
      status: {
        type: "busy",
      },
    },
  } satisfies SdkEvent
}

function idle(sessionID = "session-1") {
  return {
    id: `evt-${sessionID}-idle`,
    type: "session.status",
    properties: {
      sessionID,
      status: {
        type: "idle",
      },
    },
  } satisfies SdkEvent
}

function retry(sessionID: string, attempt: number, message: string) {
  return {
    id: `evt-${sessionID}-retry-${attempt}`,
    type: "session.status",
    properties: {
      sessionID,
      status: {
        type: "retry",
        attempt,
        message,
        next: 1,
      },
    },
  } satisfies SdkEvent
}

function assistant(id: string) {
  return {
    id: `evt-${id}`,
    type: "message.updated",
    properties: {
      sessionID: "session-1",
      info: assistantMessage({
        sessionID: "session-1",
        id,
        parts: [],
      }).info,
    },
  } satisfies SdkEvent
}

const StreamClosed = undefined as never

function feed<T, R = never>(returnValue: R = StreamClosed) {
  const list: T[] = []
  let done = false
  let wake: (() => void) | undefined

  const wrapped = (async function* (): AsyncGenerator<T, R, unknown> {
    while (!done || list.length > 0) {
      if (list.length === 0) {
        await new Promise<void>((resolve) => {
          wake = resolve
        })
        continue
      }

      const next = list.shift()
      if (!next) {
        continue
      }

      yield next
    }
    return returnValue as R
  })()

  return {
    stream: wrapped,
    push(value: T) {
      list.push(value)
      wake?.()
      wake = undefined
    },
    close() {
      done = true
      wake?.()
      wake = undefined
    },
  }
}

function eventFeed() {
  return feed<SdkEvent>()
}

function globalFeed() {
  return feed<GlobalEvent>()
}

function emptyStream(): EventStream {
  return (async function* (): AsyncGenerator<SdkEvent> {})()
}

function ok<T>(data: T) {
  return Promise.resolve({
    data,
    error: undefined,
    request: new Request("https://opencode.test"),
    response: new Response(),
  })
}

function sse(stream: EventStream) {
  return Promise.resolve({ stream })
}

function globalSse(stream: GlobalEventStream) {
  return Promise.resolve({ stream })
}

function wrapGlobalStream(stream: EventStream): GlobalEventStream {
  return (async function* (): GlobalEventStream {
    for await (const event of stream) {
      yield globalEvent(event)
    }
    return StreamClosed
  })()
}

function statusMap(busy: boolean): SessionStatusMap {
  if (busy) {
    return { "session-1": { type: "busy" } }
  }

  return {}
}

function assistantMessage(input: { sessionID: string; id: string; parts: SessionMessage["parts"] }): SessionMessage {
  return {
    info: {
      id: input.id,
      sessionID: input.sessionID,
      role: "assistant",
      time: {
        created: 1,
      },
      parentID: "msg-user-1",
      modelID: "gpt-5",
      providerID: "openai",
      mode: "chat",
      agent: "build",
      path: {
        cwd: "/tmp",
        root: "/tmp",
      },
      cost: 0,
      tokens: {
        input: 1,
        output: 1,
        reasoning: 0,
        cache: {
          read: 0,
          write: 0,
        },
      },
    },
    parts: input.parts,
  }
}

function commandResponse() {
  return {
    info: assistantMessage({ sessionID: "session-1", id: "msg-command", parts: [] }).info as AssistantMessage,
    parts: [],
  }
}

function runningTool(input: {
  sessionID: string
  messageID: string
  id: string
  callID: string
  tool: string
  body: Record<string, unknown>
  metadata?: Record<string, unknown>
}): SessionToolPart {
  return {
    id: input.id,
    sessionID: input.sessionID,
    messageID: input.messageID,
    type: "tool",
    callID: input.callID,
    tool: input.tool,
    state: {
      status: "running",
      input: input.body,
      ...(input.metadata ? { metadata: input.metadata } : {}),
      time: {
        start: 1,
      },
    },
  }
}

function completedTool(input: {
  sessionID: string
  messageID: string
  id: string
  callID: string
  tool: string
  body: Record<string, unknown>
  output?: string
  metadata?: Record<string, unknown>
}): SessionToolPart {
  return {
    id: input.id,
    sessionID: input.sessionID,
    messageID: input.messageID,
    type: "tool",
    callID: input.callID,
    tool: input.tool,
    state: {
      status: "completed",
      input: input.body,
      output: input.output ?? "",
      title: input.tool,
      metadata: input.metadata ?? {},
      time: {
        start: 1,
        end: 2,
      },
    },
  }
}

function textPart(id: string, messageID: string, text: string, sessionID = "session-1"): TextPart {
  return {
    id,
    sessionID,
    messageID,
    type: "text",
    text,
  }
}

function textUpdated(part: TextPart): SdkEvent {
  return {
    id: `evt-${part.id}-updated`,
    type: "message.part.updated",
    properties: {
      sessionID: part.sessionID,
      part,
      time: 1,
    },
  }
}

function reasoningPart(id: string, messageID: string, text: string): ReasoningPart {
  return {
    id,
    sessionID: "session-1",
    messageID,
    type: "reasoning",
    text,
    time: { start: 1 },
  }
}

function reasoningUpdated(part: ReasoningPart): SdkEvent {
  return {
    id: `evt-${part.id}-updated`,
    type: "message.part.updated",
    properties: {
      sessionID: part.sessionID,
      part,
      time: 1,
    },
  }
}

function toolUpdated(part: SessionToolPart): SdkEvent {
  return {
    id: `evt-${part.id}-updated`,
    type: "message.part.updated",
    properties: {
      sessionID: part.sessionID,
      part,
      time: 1,
    },
  }
}

function textDelta(messageID: string, partID: string, delta: string, sessionID = "session-1"): SdkEvent {
  return {
    id: `evt-${partID}-delta`,
    type: "message.part.delta",
    properties: {
      sessionID,
      messageID,
      partID,
      field: "text",
      delta,
    },
  }
}

function child(id: string): SessionChild {
  return {
    id,
    slug: id,
    projectID: "project-1",
    directory: "/tmp",
    title: id,
    version: "1",
    time: {
      created: 1,
      updated: 1,
    },
  }
}

function globalEvent(payload: GlobalEvent["payload"]): GlobalEvent {
  return {
    directory: "/tmp",
    project: "project-1",
    payload,
  }
}

function footer(fn?: (commit: StreamCommit) => void) {
  const commits: StreamCommit[] = []
  const events: FooterEvent[] = []
  let closed = false
  let idleCalls = 0

  const api: FooterApi = {
    get isClosed() {
      return closed
    },
    onPrompt: () => () => {},
    onQueuedRemove: () => () => {},
    onClose: () => () => {},
    event(next) {
      events.push(next)
    },
    append(next) {
      commits.push(next)
      fn?.(next)
    },
    idle() {
      idleCalls += 1
      return Promise.resolve()
    },
    close() {
      closed = true
    },
    destroy() {
      closed = true
    },
  }

  return {
    api,
    commits,
    events,
    get idleCalls() {
      return idleCalls
    },
  }
}

function sdk(
  input: {
    stream?: EventStream
    globalStream?: GlobalEventStream
    subscribe?: OpencodeClient["event"]["subscribe"]
    globalEvent?: OpencodeClient["global"]["event"]
    promptAsync?: OpencodeClient["session"]["promptAsync"]
    command?: OpencodeClient["session"]["command"]
    status?: OpencodeClient["session"]["status"]
    messages?: OpencodeClient["session"]["messages"]
    children?: OpencodeClient["session"]["children"]
    permissions?: OpencodeClient["permission"]["list"]
    questions?: OpencodeClient["question"]["list"]
  } = {},
) {
  const client = new OpencodeClient()

  const subscribe: OpencodeClient["event"]["subscribe"] = input.subscribe ?? (() => sse(input.stream ?? emptyStream()))
  const globalEvent: OpencodeClient["global"]["event"] =
    input.globalEvent ?? (() => globalSse(input.globalStream ?? wrapGlobalStream(input.stream ?? emptyStream())))
  const promptAsync: OpencodeClient["session"]["promptAsync"] = input.promptAsync ?? (() => ok(undefined))
  const status: OpencodeClient["session"]["status"] = input.status ?? (() => ok({}))
  const messages: OpencodeClient["session"]["messages"] = input.messages ?? (() => ok([]))
  const children: OpencodeClient["session"]["children"] = input.children ?? (() => ok([]))
  const permissions: OpencodeClient["permission"]["list"] = input.permissions ?? (() => ok([]))
  const questions: OpencodeClient["question"]["list"] = input.questions ?? (() => ok([]))

  spyOn(client.event, "subscribe").mockImplementation(subscribe)
  spyOn(client.global, "event").mockImplementation(globalEvent)
  spyOn(client.session, "promptAsync").mockImplementation(promptAsync)
  if (input.command) {
    spyOn(client.session, "command").mockImplementation(input.command)
  }
  spyOn(client.session, "status").mockImplementation(status)
  spyOn(client.session, "messages").mockImplementation(messages)
  spyOn(client.session, "children").mockImplementation(children)
  spyOn(client.permission, "list").mockImplementation(permissions)
  spyOn(client.question, "list").mockImplementation(questions)

  return client
}

describe("run stream transport", () => {
  test("does not replay persisted main-session history during bootstrap by default", async () => {
    const src = eventFeed()
    const ui = footer()
    const transport = await createSessionTransport({
      sdk: sdk({
        stream: src.stream,
        messages: async ({ sessionID }) =>
          sessionID === "session-1"
            ? ok([
                assistantMessage({
                  sessionID: "session-1",
                  id: "msg-1",
                  parts: [
                    {
                      ...textPart("text-1", "msg-1", "Hello."),
                      time: {
                        start: 1,
                        end: 2,
                      },
                    },
                  ],
                }),
              ])
            : ok([]),
      }),
      sessionID: "session-1",
      thinking: true,
      limits: () => ({}),
      footer: ui.api,
    })

    try {
      expect(ui.commits).toEqual([])
      expect(ui.idleCalls).toBe(0)
    } finally {
      src.close()
      await transport.close()
    }
  })

  test("replays persisted main-session history during bootstrap when enabled", async () => {
    const src = eventFeed()
    const ui = footer()
    const transport = await createSessionTransport({
      sdk: sdk({
        stream: src.stream,
        messages: async ({ sessionID }) =>
          sessionID === "session-1"
            ? ok([
                assistantMessage({
                  sessionID: "session-1",
                  id: "msg-1",
                  parts: [
                    {
                      ...textPart("text-1", "msg-1", "Hello."),
                      time: {
                        start: 1,
                        end: 2,
                      },
                    },
                  ],
                }),
              ])
            : ok([]),
      }),
      sessionID: "session-1",
      thinking: true,
      replay: true,
      limits: () => ({}),
      footer: ui.api,
    })

    try {
      await waitFor(() => ui.commits.find((item) => item.kind === "assistant" && item.text === "Hello."))
      expect(ui.idleCalls).toBeGreaterThan(0)
    } finally {
      src.close()
      await transport.close()
    }
  })

  test("caps replayed bootstrap history to the configured number of messages", async () => {
    const src = eventFeed()
    const ui = footer()
    const transport = await createSessionTransport({
      sdk: sdk({
        stream: src.stream,
        messages: async ({ sessionID }) =>
          ok(
            sessionID === "session-1"
              ? [
                  assistantMessage({
                    sessionID: "session-1",
                    id: "msg-1",
                    parts: [
                      {
                        ...textPart("text-1", "msg-1", "Hello."),
                        time: {
                          start: 1,
                          end: 2,
                        },
                      },
                    ],
                  }),
                  assistantMessage({
                    sessionID: "session-1",
                    id: "msg-2",
                    parts: [
                      {
                        ...textPart("text-2", "msg-2", "World."),
                        time: {
                          start: 3,
                          end: 4,
                        },
                      },
                    ],
                  }),
                ]
              : [],
          ),
      }),
      sessionID: "session-1",
      thinking: true,
      replay: true,
      replayLimit: 1,
      limits: () => ({}),
      footer: ui.api,
    })

    try {
      await waitFor(() => (ui.commits.length > 0 ? ui.commits : undefined))
      expect(ui.commits.filter((item) => item.kind === "assistant")).toEqual([
        expect.objectContaining({
          text: "World.",
        }),
      ])
    } finally {
      src.close()
      await transport.close()
    }
  })

  test("skips buffered pre-bootstrap deltas already covered by replay history", async () => {
    const src = eventFeed()
    const ui = footer()
    const gate = defer<void>()
    let transport: Awaited<ReturnType<typeof createSessionTransport>> | undefined
    const task = createSessionTransport({
      sdk: sdk({
        stream: src.stream,
        messages: async ({ sessionID }) => {
          if (sessionID !== "session-1") {
            return ok([])
          }

          await gate.promise
          return ok([
            assistantMessage({
              sessionID: "session-1",
              id: "msg-1",
              parts: [textPart("text-1", "msg-1", "Hello")],
            }),
          ])
        },
      }),
      sessionID: "session-1",
      thinking: true,
      replay: true,
      limits: () => ({}),
      footer: ui.api,
    })

    try {
      await Promise.resolve()
      src.push(textDelta("msg-1", "text-1", "lo"))
      gate.resolve()
      transport = await task

      await waitFor(() => (ui.commits.length > 0 ? ui.commits : undefined))
      await Bun.sleep(20)
      expect(ui.commits.filter((item) => item.kind === "assistant")).toEqual([
        expect.objectContaining({
          text: "Hello",
        }),
      ])
    } finally {
      src.close()
      await transport?.close()
    }
  })

  test("applies buffered pre-bootstrap deltas not yet persisted", async () => {
    const src = eventFeed()
    const ui = footer()
    const gate = defer<void>()
    let transport: Awaited<ReturnType<typeof createSessionTransport>> | undefined
    const task = createSessionTransport({
      sdk: sdk({
        stream: src.stream,
        messages: async ({ sessionID }) => {
          if (sessionID !== "session-1") {
            return ok([])
          }

          await gate.promise
          return ok([
            assistantMessage({
              sessionID: "session-1",
              id: "msg-1",
              parts: [textPart("text-1", "msg-1", "")],
            }),
          ])
        },
      }),
      sessionID: "session-1",
      thinking: true,
      replay: true,
      limits: () => ({}),
      footer: ui.api,
    })

    try {
      await Promise.resolve()
      src.push(textDelta("msg-1", "text-1", "Hello"))
      gate.resolve()
      transport = await task

      await waitFor(() => (ui.commits.length > 0 ? ui.commits : undefined))
      await Bun.sleep(20)
      expect(ui.commits.filter((item) => item.kind === "assistant")).toEqual([
        expect.objectContaining({
          text: "Hello",
        }),
      ])
    } finally {
      src.close()
      await transport?.close()
    }
  })

  test("preserves running footer state for resumed active sessions", async () => {
    const src = eventFeed()
    const ui = footer()
    const transport = await createSessionTransport({
      sdk: sdk({
        stream: src.stream,
        messages: async ({ sessionID }) =>
          sessionID === "session-1"
            ? ok([
                assistantMessage({
                  sessionID: "session-1",
                  id: "msg-1",
                  parts: [
                    runningTool({
                      sessionID: "session-1",
                      messageID: "msg-1",
                      id: "bash-1",
                      callID: "call-1",
                      tool: "bash",
                      body: {
                        command: "pwd",
                      },
                    }),
                  ],
                }),
              ])
            : ok([]),
      }),
      sessionID: "session-1",
      thinking: true,
      replay: true,
      limits: () => ({}),
      footer: ui.api,
    })

    try {
      const patch = await waitFor(() => {
        const item = ui.events.findLast((event) => event.type === "stream.patch")
        return item?.type === "stream.patch" ? item.patch : undefined
      })

      expect(patch).toEqual(
        expect.objectContaining({
          phase: "running",
          status: "running bash",
        }),
      )
    } finally {
      src.close()
      await transport.close()
    }
  })

  test("rebuilds session output on resize and continues live deltas from replayed state", async () => {
    const src = eventFeed()
    const ui = footer()
    let calls = 0
    const transport = await createSessionTransport({
      sdk: sdk({
        stream: src.stream,
        messages: async () => {
          calls += 1
          if (calls === 1) {
            return ok([])
          }

          return ok([
            assistantMessage({
              sessionID: "session-1",
              id: "msg-1",
              parts: [textPart("text-1", "msg-1", "Hello")],
            }),
          ])
        },
      }),
      sessionID: "session-1",
      thinking: true,
      replay: true,
      limits: () => ({}),
      footer: ui.api,
    })
    const localRows: LocalReplayRow[] = [
      { commit: { kind: "user", text: "pending prompt", phase: "start", source: "system", messageID: "msg-pending" } },
    ]
    const reset = mock(() => {
      localRows.push({
        commit: {
          kind: "user",
          text: "sent during reset",
          phase: "start",
          source: "system",
          messageID: "msg-during-reset",
        },
      })
      return Promise.resolve()
    })

    try {
      expect(
        await transport.replayOnResize({
          localRows: () => localRows,
          reset,
        }),
      ).toBe(true)
      expect(reset).toHaveBeenCalledTimes(1)
      expect(ui.commits).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: "assistant", text: "Hello" }),
          expect.objectContaining({ kind: "user", text: "sent during reset", messageID: "msg-during-reset" }),
        ]),
      )

      src.push(textUpdated(textPart("text-1", "msg-1", "Hello world")))
      await waitFor(() => ui.commits.find((commit) => commit.kind === "assistant" && commit.text === " world"))
      expect(ui.commits.filter((commit) => commit.kind === "assistant").map((commit) => commit.text)).toEqual([
        "Hello",
        " world",
      ])
    } finally {
      src.close()
      await transport.close()
    }
  })

  test("coalesces active resize requests into one trailing replay", async () => {
    const src = eventFeed()
    const ui = footer()
    const firstReset = defer()
    const resetA = mock(() => firstReset.promise)
    const resetB = mock(() => Promise.resolve())
    const resetC = mock(() => Promise.resolve())
    const transport = await createSessionTransport({
      sdk: sdk({ stream: src.stream }),
      sessionID: "session-1",
      thinking: true,
      replay: true,
      limits: () => ({}),
      footer: ui.api,
    })

    try {
      const active = transport.replayOnResize({ localRows: () => [], reset: resetA })
      await waitFor(() => (resetA.mock.calls.length === 1 ? true : undefined))

      expect(await transport.replayOnResize({ localRows: () => [], reset: resetB })).toBe(false)
      expect(await transport.replayOnResize({ localRows: () => [], reset: resetC })).toBe(false)
      expect(resetB).not.toHaveBeenCalled()

      firstReset.resolve()
      expect(await active).toBe(true)
      expect(resetA).toHaveBeenCalledTimes(1)
      expect(resetB).not.toHaveBeenCalled()
      expect(resetC).toHaveBeenCalledTimes(1)
    } finally {
      src.close()
      await transport.close()
    }
  })

  test("keeps coalescing resize requests while buffered events drain", async () => {
    const src = eventFeed()
    const ui = footer()
    const firstReset = defer()
    const statusGate = defer()
    const statusStarted = defer()
    let blockStatus = false
    const trace = mock((_type: string, _data?: unknown) => {})
    const resetA = mock(() => firstReset.promise)
    const resetB = mock(() => Promise.resolve())
    const resetC = mock(() => Promise.resolve())
    const transport = await createSessionTransport({
      sdk: sdk({
        stream: src.stream,
        status: async () => {
          if (blockStatus) {
            statusStarted.resolve()
            await statusGate.promise
          }
          return ok(statusMap(true))
        },
      }),
      sessionID: "session-1",
      thinking: true,
      replay: true,
      limits: () => ({}),
      footer: ui.api,
      trace: { write: trace },
    })
    const turn = transport.runPromptTurn({
      agent: undefined,
      model: undefined,
      variant: undefined,
      prompt: { text: "active", parts: [] },
      files: [],
      includeFiles: false,
    })

    try {
      await waitFor(() => ui.events.find((event) => event.type === "turn.wait"))
      const active = transport.replayOnResize({ localRows: () => [], reset: resetA })
      await waitFor(() => (resetA.mock.calls.length === 1 ? true : undefined))
      blockStatus = true
      src.push(busy())
      src.push(idle())
      await waitFor(() => (trace.mock.calls.filter((call) => call[0] === "recv.event").length >= 2 ? true : undefined))

      expect(await transport.replayOnResize({ localRows: () => [], reset: resetB })).toBe(false)
      firstReset.resolve()
      await Promise.race([
        statusStarted.promise,
        Bun.sleep(1_000).then(() => {
          throw new Error("timed out waiting for buffered status drain")
        }),
      ])

      expect(await transport.replayOnResize({ localRows: () => [], reset: resetC })).toBe(false)
      expect(resetC).not.toHaveBeenCalled()
      blockStatus = false
      statusGate.resolve()

      expect(
        await Promise.race([
          active,
          Bun.sleep(1_000).then(() => {
            throw new Error("timed out waiting for trailing resize replay")
          }),
        ]),
      ).toBe(true)
      expect(resetB).not.toHaveBeenCalled()
      expect(resetC).toHaveBeenCalledTimes(1)
    } finally {
      src.close()
      await transport.close()
      await turn
    }
  })

  test("preserves assistant deltas not yet persisted when replaying during a live stream", async () => {
    const src = eventFeed()
    const ui = footer()
    let calls = 0
    const transport = await createSessionTransport({
      sdk: sdk({
        stream: src.stream,
        messages: async () => {
          calls += 1
          if (calls === 1) {
            return ok([])
          }

          return ok([
            assistantMessage({
              sessionID: "session-1",
              id: "msg-live",
              parts: [textPart("text-live", "msg-live", "")],
            }),
          ])
        },
      }),
      sessionID: "session-1",
      thinking: true,
      replay: true,
      limits: () => ({}),
      footer: ui.api,
    })

    try {
      src.push(assistant("msg-live"))
      src.push(textUpdated(textPart("text-live", "msg-live", "")))
      src.push(textDelta("msg-live", "text-live", "Hello"))
      await waitFor(() => ui.commits.find((commit) => commit.kind === "assistant" && commit.text === "Hello"))
      ui.commits.length = 0

      expect(await transport.replayOnResize({ localRows: () => [], reset: () => Promise.resolve() })).toBe(true)
      src.push(textDelta("msg-live", "text-live", "Hello"))
      src.push(
        textUpdated({
          ...textPart("text-live", "msg-live", "HelloHello"),
          time: { start: 1, end: 2 },
        }),
      )

      await waitFor(() =>
        ui.commits.filter((commit) => commit.kind === "assistant" && commit.text === "Hello").length === 2
          ? true
          : undefined,
      )
      expect(
        ui.commits.filter((commit) => commit.kind === "assistant" && commit.text).map((commit) => commit.text),
      ).toEqual(["Hello", "Hello"])
    } finally {
      src.close()
      await transport.close()
    }
  })

  test("preserves the display prefix for active reasoning restored during replay", async () => {
    const src = eventFeed()
    const ui = footer()
    let calls = 0
    const transport = await createSessionTransport({
      sdk: sdk({
        stream: src.stream,
        messages: async () => {
          calls += 1
          if (calls === 1) {
            return ok([])
          }

          return ok([
            assistantMessage({
              sessionID: "session-1",
              id: "msg-thinking",
              parts: [reasoningPart("thinking-1", "msg-thinking", "")],
            }),
          ])
        },
      }),
      sessionID: "session-1",
      thinking: true,
      replay: true,
      limits: () => ({}),
      footer: ui.api,
    })

    try {
      src.push(assistant("msg-thinking"))
      src.push(reasoningUpdated(reasoningPart("thinking-1", "msg-thinking", "")))
      src.push(textDelta("msg-thinking", "thinking-1", "plan"))
      await waitFor(() => ui.commits.find((commit) => commit.kind === "reasoning" && commit.text === "Thinking: plan"))
      ui.commits.length = 0

      expect(await transport.replayOnResize({ localRows: () => [], reset: () => Promise.resolve() })).toBe(true)
      expect(ui.commits.filter((commit) => commit.kind === "reasoning").map((commit) => commit.text)).toEqual([
        "Thinking: plan",
      ])
    } finally {
      src.close()
      await transport.close()
    }
  })

  test("does not overlay stale active text when persistence completes during replay", async () => {
    const src = eventFeed()
    const ui = footer()
    let calls = 0
    const transport = await createSessionTransport({
      sdk: sdk({
        stream: src.stream,
        messages: async () => {
          calls += 1
          if (calls === 1) {
            return ok([])
          }

          return ok([
            assistantMessage({
              sessionID: "session-1",
              id: "msg-finished",
              parts: [
                {
                  ...textPart("text-finished", "msg-finished", "Hello"),
                  time: { start: 1, end: 2 },
                },
              ],
            }),
          ])
        },
      }),
      sessionID: "session-1",
      thinking: true,
      replay: true,
      limits: () => ({}),
      footer: ui.api,
    })

    try {
      src.push(assistant("msg-finished"))
      src.push(textUpdated(textPart("text-finished", "msg-finished", "")))
      src.push(textDelta("msg-finished", "text-finished", "Hello"))
      await waitFor(() => ui.commits.find((commit) => commit.kind === "assistant" && commit.text === "Hello"))
      ui.commits.length = 0

      expect(await transport.replayOnResize({ localRows: () => [], reset: () => Promise.resolve() })).toBe(true)
      expect(
        ui.commits.filter((commit) => commit.kind === "assistant" && commit.text).map((commit) => commit.text),
      ).toEqual(["Hello"])
    } finally {
      src.close()
      await transport.close()
    }
  })

  test("does not clear the terminal when resize replay snapshot fetch fails", async () => {
    const src = eventFeed()
    const ui = footer()
    let calls = 0
    const transport = await createSessionTransport({
      sdk: sdk({
        stream: src.stream,
        messages: async () => {
          calls += 1
          if (calls === 1) {
            return ok([])
          }

          throw new Error("snapshot failed")
        },
      }),
      sessionID: "session-1",
      thinking: true,
      replay: true,
      limits: () => ({}),
      footer: ui.api,
    })
    const reset = mock(() => Promise.resolve())

    try {
      expect(await transport.replayOnResize({ localRows: () => [], reset })).toBe(false)
      expect(reset).not.toHaveBeenCalled()
      expect(ui.commits).toEqual([])
    } finally {
      src.close()
      await transport.close()
    }
  })

  test("disables resize replay for the session after terminal reset fails", async () => {
    const src = eventFeed()
    const ui = footer()
    const transport = await createSessionTransport({
      sdk: sdk({ stream: src.stream }),
      sessionID: "session-1",
      thinking: true,
      replay: true,
      limits: () => ({}),
      footer: ui.api,
    })
    const reset = mock(() => Promise.reject(new Error("clear failed")))

    try {
      expect(await transport.replayOnResize({ localRows: () => [], reset })).toBe(false)
      expect(await transport.replayOnResize({ localRows: () => [], reset })).toBe(false)
      expect(reset).toHaveBeenCalledTimes(1)
      expect(ui.commits).toContainEqual({
        kind: "error",
        text: "resize replay failed; disabled for this session",
        phase: "start",
        source: "system",
      })
    } finally {
      src.close()
      await transport.close()
    }
  })

  test("disables resize replay when rebuilding scrollback fails after terminal reset", async () => {
    const src = eventFeed()
    const ui = footer()
    let cleared = false
    const idle = ui.api.idle
    ui.api.idle = () => (cleared ? Promise.reject(new Error("render failed")) : idle())
    const transport = await createSessionTransport({
      sdk: sdk({ stream: src.stream }),
      sessionID: "session-1",
      thinking: true,
      replay: true,
      limits: () => ({}),
      footer: ui.api,
    })
    const reset = mock(() => {
      cleared = true
      return Promise.resolve()
    })

    try {
      expect(await transport.replayOnResize({ localRows: () => [], reset })).toBe(false)
      expect(await transport.replayOnResize({ localRows: () => [], reset })).toBe(false)
      expect(reset).toHaveBeenCalledTimes(1)
      expect(ui.commits).toContainEqual({
        kind: "error",
        text: "resize replay failed; disabled for this session",
        phase: "start",
        source: "system",
      })
    } finally {
      src.close()
      await transport.close()
    }
  })

  test("keeps completed historical subagent tabs during bootstrap", async () => {
    const src = eventFeed()
    const ui = footer()
    const transport = await createSessionTransport({
      sdk: sdk({
        stream: src.stream,
        messages: async ({ sessionID }) => {
          if (sessionID !== "session-1") {
            return ok([])
          }

          return ok([
            assistantMessage({
              sessionID: "session-1",
              id: "msg-1",
              parts: [
                completedTool({
                  sessionID: "session-1",
                  messageID: "msg-1",
                  id: "task-1",
                  callID: "call-1",
                  tool: "task",
                  body: {
                    description: "Explore run folder",
                    subagent_type: "explore",
                  },
                  metadata: {
                    sessionId: "child-1",
                  },
                }),
              ],
            }),
          ])
        },
        children: async () => ok([child("child-1")]),
      }),
      sessionID: "session-1",
      thinking: true,
      limits: () => ({}),
      footer: ui.api,
    })

    try {
      const state = await waitFor(() => {
        const item = ui.events.findLast((event) => event.type === "stream.subagent")
        return item?.type === "stream.subagent" ? item.state : undefined
      })

      expect(state.tabs).toEqual([expect.objectContaining({ sessionID: "child-1", status: "completed" })])
      expect(state.details).toEqual({})
    } finally {
      src.close()
      await transport.close()
    }
  })

  test("bootstraps child tabs and resumed blocker input", async () => {
    const src = eventFeed()
    const ui = footer()
    const transport = await createSessionTransport({
      sdk: sdk({
        stream: src.stream,
        messages: async ({ sessionID }) => {
          if (sessionID === "session-1") {
            return ok([
              assistantMessage({
                sessionID: "session-1",
                id: "msg-1",
                parts: [
                  runningTool({
                    sessionID: "session-1",
                    messageID: "msg-1",
                    id: "task-1",
                    callID: "call-1",
                    tool: "task",
                    body: {
                      description: "Explore run folder",
                      subagent_type: "explore",
                    },
                    metadata: {
                      sessionId: "child-1",
                    },
                  }),
                ],
              }),
            ])
          }

          return ok([
            assistantMessage({
              sessionID: "child-1",
              id: "msg-child-1",
              parts: [
                runningTool({
                  sessionID: "child-1",
                  messageID: "msg-child-1",
                  id: "edit-1",
                  callID: "call-edit-1",
                  tool: "edit",
                  body: {
                    filePath: "src/run/subagent-data.ts",
                    diff: "@@ -1 +1 @@",
                  },
                }),
              ],
            }),
          ])
        },
        children: async () => ok([child("child-1")]),
        permissions: async () =>
          ok([
            {
              id: "perm-1",
              sessionID: "child-1",
              permission: "edit",
              patterns: ["src/run/subagent-data.ts"],
              metadata: {},
              always: [],
              tool: {
                messageID: "msg-child-1",
                callID: "call-edit-1",
              },
            },
          ]),
      }),
      sessionID: "session-1",
      thinking: true,
      limits: () => ({}),
      footer: ui.api,
    })

    try {
      const boot = await waitFor(() => {
        const item = ui.events.findLast((event) => event.type === "stream.subagent")
        const state = item?.type === "stream.subagent" ? item.state : undefined
        return state?.tabs.some((tab) => tab.sessionID === "child-1") &&
          state.permissions.some((req) => req.id === "perm-1")
          ? state
          : undefined
      })

      expect(boot.tabs).toEqual([
        expect.objectContaining({
          sessionID: "child-1",
          label: "Explore",
          description: "Pending permission",
          status: "running",
        }),
      ])
      expect(boot.permissions).toEqual([
        expect.objectContaining({
          id: "perm-1",
          sessionID: "child-1",
          metadata: {
            input: {
              filePath: "src/run/subagent-data.ts",
              diff: "@@ -1 +1 @@",
            },
          },
        }),
      ])

      transport.selectSubagent("child-1")

      const selected = await waitFor(() => {
        const item = ui.events.findLast((event) => event.type === "stream.subagent")
        const state = item?.type === "stream.subagent" ? item.state : undefined
        const detail = state?.details["child-1"]
        return detail?.commits.some(
          (commit) => commit.kind === "tool" && commit.tool === "edit" && commit.phase === "start",
        )
          ? state
          : undefined
      })

      expect(selected.details).toEqual({
        "child-1": {
          sessionID: "child-1",
          commits: [
            expect.objectContaining({
              kind: "tool",
              tool: "edit",
              phase: "start",
            }),
          ],
        },
      })

      expect(
        await waitFor(() => {
          const item = ui.events.findLast((event) => event.type === "stream.view")
          return item?.type === "stream.view" && item.view.type === "permission" && item.view.request.id === "perm-1"
            ? item
            : undefined
        }),
      ).toEqual({
        type: "stream.view",
        view: {
          type: "permission",
          request: expect.objectContaining({
            id: "perm-1",
            metadata: {
              input: {
                filePath: "src/run/subagent-data.ts",
                diff: "@@ -1 +1 @@",
              },
            },
          }),
        },
      })
    } finally {
      src.close()
      await transport.close()
    }
  })

  test("bootstraps child session output before selection", async () => {
    const ui = footer()
    const transport = await createSessionTransport({
      sdk: sdk({
        messages: async ({ sessionID }) => {
          if (sessionID === "session-1") {
            return ok([
              assistantMessage({
                sessionID: "session-1",
                id: "msg-1",
                parts: [
                  runningTool({
                    sessionID: "session-1",
                    messageID: "msg-1",
                    id: "task-1",
                    callID: "call-1",
                    tool: "task",
                    body: {
                      description: "Explore run.ts",
                      subagent_type: "explore",
                    },
                    metadata: {
                      sessionId: "child-1",
                    },
                  }),
                ],
              }),
            ])
          }

          return sessionID === "child-1"
            ? ok([
                assistantMessage({
                  sessionID: "child-1",
                  id: "msg-child-1",
                  parts: [textPart("txt-child-1", "msg-child-1", "subagent summary", "child-1")],
                }),
              ])
            : ok([])
        },
        children: async () => ok([child("child-1")]),
      }),
      sessionID: "session-1",
      thinking: true,
      limits: () => ({}),
      footer: ui.api,
    })

    try {
      await waitFor(() => {
        const item = ui.events.findLast((event) => event.type === "stream.subagent")
        return item?.type === "stream.subagent" && item.state.tabs.some((tab) => tab.sessionID === "child-1")
          ? item
          : undefined
      })

      transport.selectSubagent("child-1")

      expect(
        await waitFor(() => {
          const item = ui.events.findLast((event) => event.type === "stream.subagent")
          const detail = item?.type === "stream.subagent" ? item.state.details["child-1"] : undefined
          return detail?.commits.some((commit) => commit.kind === "assistant" && commit.text === "subagent summary")
            ? detail
            : undefined
        }),
      ).toEqual({
        sessionID: "child-1",
        commits: [
          expect.objectContaining({
            kind: "assistant",
            text: "subagent summary",
          }),
        ],
      })
    } finally {
      await transport.close()
    }
  })

  test("does not block startup on child history bootstrap", async () => {
    const pending = defer<Awaited<ReturnType<typeof ok<SessionMessage[]>>>>()
    const ui = footer()
    let transport: Awaited<ReturnType<typeof createSessionTransport>> | undefined

    const task = createSessionTransport({
      sdk: sdk({
        messages: async ({ sessionID }) => {
          if (sessionID === "session-1") {
            return ok([
              assistantMessage({
                sessionID: "session-1",
                id: "msg-1",
                parts: [
                  runningTool({
                    sessionID: "session-1",
                    messageID: "msg-1",
                    id: "task-1",
                    callID: "call-1",
                    tool: "task",
                    body: {
                      description: "Explore run.ts",
                      subagent_type: "explore",
                    },
                    metadata: {
                      sessionId: "child-1",
                    },
                  }),
                ],
              }),
            ])
          }

          if (sessionID === "child-1") {
            return pending.promise
          }

          return ok([])
        },
        children: async () => ok([child("child-1")]),
      }),
      sessionID: "session-1",
      thinking: true,
      limits: () => ({}),
      footer: ui.api,
    }).then((item) => {
      transport = item
      return item
    })

    try {
      const state = await waitFor(() => {
        const item = ui.events.findLast((event) => event.type === "stream.subagent")
        return item?.type === "stream.subagent" && item.state.tabs.some((tab) => tab.sessionID === "child-1")
          ? item.state
          : undefined
      })

      await waitFor(() => transport)

      expect(state).toEqual({
        tabs: [expect.objectContaining({ sessionID: "child-1", status: "running" })],
        details: {},
        permissions: [],
        questions: [],
      })
    } finally {
      pending.resolve(ok([]))
      await task
      await transport?.close()
    }
  })

  test("replays child events buffered during bootstrap once the tab is known", async () => {
    const global = globalFeed()
    const ui = footer()
    const gate = defer<void>()
    let transport: Awaited<ReturnType<typeof createSessionTransport>> | undefined
    const task = createSessionTransport({
      sdk: sdk({
        globalStream: global.stream,
        messages: async ({ sessionID }) => {
          if (sessionID !== "session-1") {
            return ok([])
          }

          await gate.promise
          return ok([])
        },
        children: async () => ok([]),
      }),
      sessionID: "session-1",
      thinking: true,
      limits: () => ({}),
      footer: ui.api,
    })

    try {
      await Promise.resolve()
      global.push(globalEvent(retry("child-1", 1, "retry child")))
      global.push(
        globalEvent({
          id: "evt-child-message",
          type: "message.updated",
          properties: {
            sessionID: "child-1",
            info: assistantMessage({
              sessionID: "child-1",
              id: "msg-child-1",
              parts: [],
            }).info,
          },
        }),
      )
      global.push(globalEvent(textUpdated(textPart("txt-child-1", "msg-child-1", "", "child-1"))))
      global.push(globalEvent(textDelta("msg-child-1", "txt-child-1", "Hello", "child-1")))
      global.push(
        globalEvent(
          toolUpdated(
            runningTool({
              sessionID: "session-1",
              messageID: "msg-1",
              id: "task-1",
              callID: "call-1",
              tool: "task",
              body: {
                description: "Explore run.ts",
                subagent_type: "explore",
              },
              metadata: {
                sessionId: "child-1",
              },
            }),
          ),
        ),
      )
      gate.resolve()
      transport = await task

      await waitFor(() => {
        const item = ui.events.findLast((event) => event.type === "stream.subagent")
        return item?.type === "stream.subagent" && item.state.tabs.some((tab) => tab.sessionID === "child-1")
          ? item
          : undefined
      })

      transport.selectSubagent("child-1")

      const detail = await waitFor(() => {
        const item = ui.events.findLast((event) => event.type === "stream.subagent")
        const next = item?.type === "stream.subagent" ? item.state.details["child-1"] : undefined
        return next?.commits.some((commit) => commit.kind === "error" && commit.text === "retry child") &&
          next.commits.some((commit) => commit.kind === "assistant" && commit.text === "Hello")
          ? next
          : undefined
      })

      expect(detail).toEqual({
        sessionID: "child-1",
        commits: expect.arrayContaining([
          expect.objectContaining({
            kind: "error",
            text: "retry child",
          }),
          expect.objectContaining({
            kind: "assistant",
            text: "Hello",
          }),
        ]),
      })
    } finally {
      global.close()
      await transport?.close()
    }
  })

  test("streams selected subagent output from global events while it is running", async () => {
    const global = globalFeed()
    const ui = footer()
    const transport = await createSessionTransport({
      sdk: sdk({
        globalStream: global.stream,
      }),
      sessionID: "session-1",
      thinking: true,
      limits: () => ({}),
      footer: ui.api,
    })

    try {
      global.push(globalEvent(assistant("msg-1")))
      global.push(
        globalEvent(
          toolUpdated(
            runningTool({
              sessionID: "session-1",
              messageID: "msg-1",
              id: "task-1",
              callID: "call-1",
              tool: "task",
              body: {
                description: "Explore run.ts",
                subagent_type: "explore",
              },
              metadata: {
                sessionId: "child-1",
              },
            }),
          ),
        ),
      )

      await waitFor(() => {
        const item = ui.events.findLast((event) => event.type === "stream.subagent")
        return item?.type === "stream.subagent" && item.state.tabs.some((tab) => tab.sessionID === "child-1")
          ? item
          : undefined
      })

      transport.selectSubagent("child-1")

      global.push(
        globalEvent({
          id: "evt-child-message",
          type: "message.updated",
          properties: {
            sessionID: "child-1",
            info: assistantMessage({
              sessionID: "child-1",
              id: "msg-child-1",
              parts: [],
            }).info,
          },
        }),
      )
      global.push(globalEvent(textUpdated(textPart("txt-child-1", "msg-child-1", "hello", "child-1"))))

      expect(
        await waitFor(() => {
          const item = ui.events.findLast((event) => event.type === "stream.subagent")
          const detail = item?.type === "stream.subagent" ? item.state.details["child-1"] : undefined
          return detail?.commits.some((commit) => commit.kind === "assistant" && commit.text === "hello")
            ? detail
            : undefined
        }),
      ).toEqual({
        sessionID: "child-1",
        commits: [
          expect.objectContaining({
            kind: "assistant",
            text: "hello",
          }),
        ],
      })

      global.push(globalEvent(textUpdated(textPart("txt-child-1", "msg-child-1", "hello world", "child-1"))))

      expect(
        await waitFor(() => {
          const item = ui.events.findLast((event) => event.type === "stream.subagent")
          const detail = item?.type === "stream.subagent" ? item.state.details["child-1"] : undefined
          return detail?.commits.some((commit) => commit.kind === "assistant" && commit.text === "hello world")
            ? detail
            : undefined
        }, 2_000),
      ).toEqual({
        sessionID: "child-1",
        commits: [
          expect.objectContaining({
            kind: "assistant",
            text: "hello world",
          }),
        ],
      })
    } finally {
      global.close()
      await transport.close()
    }
  })

  test("recovers pending questions from question.list when question.asked is missed", async () => {
    const src = eventFeed()
    const ui = footer()
    let questionCalls = 0
    const request = {
      id: "question-1",
      sessionID: "session-1",
      questions: [
        {
          question: "Which area should I inspect first?",
          header: "Area",
          options: [{ label: "CLI", description: "Look at the direct run flow." }],
          multiple: false,
        },
      ],
      tool: {
        messageID: "msg-1",
        callID: "call-question-1",
      },
    }
    const transport = await createSessionTransport({
      sdk: sdk({
        stream: src.stream,
        questions: async () => {
          questionCalls += 1
          return ok(questionCalls > 1 ? [request] : [])
        },
        promptAsync: async () => {
          queueMicrotask(() => {
            src.push(busy())
            src.push(assistant("msg-1"))
            src.push(
              toolUpdated(
                runningTool({
                  sessionID: "session-1",
                  messageID: "msg-1",
                  id: "question-tool-1",
                  callID: "call-question-1",
                  tool: "question",
                  body: {
                    questions: request.questions,
                  },
                }),
              ),
            )
          })
          return ok(undefined)
        },
      }),
      sessionID: "session-1",
      thinking: true,
      limits: () => ({}),
      footer: ui.api,
    })

    const ctrl = new AbortController()

    try {
      const run = transport.runPromptTurn({
        agent: undefined,
        model: undefined,
        variant: undefined,
        prompt: { text: "hello", parts: [] },
        files: [],
        includeFiles: false,
        signal: ctrl.signal,
      })

      const view = await waitFor(() => {
        const item = ui.events.findLast((event) => event.type === "stream.view")
        return item?.type === "stream.view" && item.view.type === "question" ? item.view : undefined
      })

      expect(view).toEqual({
        type: "question",
        request,
      })

      expect(ui.events).toContainEqual({
        type: "stream.patch",
        patch: {
          phase: "running",
          status: "awaiting answer",
        },
      })

      src.push(
        toolUpdated(
          completedTool({
            sessionID: "session-1",
            messageID: "msg-1",
            id: "question-tool-1",
            callID: "call-question-1",
            tool: "question",
            body: {
              questions: request.questions,
            },
            output: "User has answered your questions.",
            metadata: {
              answers: [["CLI"]],
            },
          }),
        ),
      )

      expect(
        await waitFor(() => {
          const item = ui.events.findLast((event) => event.type === "stream.view")
          return item?.type === "stream.view" && item.view.type === "prompt" ? item : undefined
        }),
      ).toEqual({
        type: "stream.view",
        view: { type: "prompt" },
      })

      ctrl.abort()
      await run
    } finally {
      src.close()
      await transport.close()
    }
  })

  test("does not resurrect questions if question.list resolves after tool completion", async () => {
    const src = eventFeed()
    const ui = footer()
    const started = defer()
    const request = {
      id: "question-race-1",
      sessionID: "session-1",
      questions: [
        {
          question: "Which area should I inspect first?",
          header: "Area",
          options: [{ label: "CLI", description: "Look at the direct run flow." }],
          multiple: false,
        },
      ],
      tool: {
        messageID: "msg-1",
        callID: "call-question-race-1",
      },
    }
    const pending = defer<Awaited<ReturnType<typeof ok<(typeof request)[]>>>>()
    let questionCalls = 0
    const transport = await createSessionTransport({
      sdk: sdk({
        stream: src.stream,
        questions: async () => {
          questionCalls += 1
          if (questionCalls === 1) {
            return ok([])
          }

          if (questionCalls === 2) {
            started.resolve()
            return pending.promise
          }

          return ok([])
        },
        promptAsync: async () => {
          queueMicrotask(() => {
            src.push(busy())
            src.push(assistant("msg-1"))
            src.push(
              toolUpdated(
                runningTool({
                  sessionID: "session-1",
                  messageID: "msg-1",
                  id: "question-race-tool-1",
                  callID: "call-question-race-1",
                  tool: "question",
                  body: {
                    questions: request.questions,
                  },
                }),
              ),
            )
          })
          return ok(undefined)
        },
      }),
      sessionID: "session-1",
      thinking: true,
      limits: () => ({}),
      footer: ui.api,
    })

    const ctrl = new AbortController()

    try {
      const run = transport.runPromptTurn({
        agent: undefined,
        model: undefined,
        variant: undefined,
        prompt: { text: "hello", parts: [] },
        files: [],
        includeFiles: false,
        signal: ctrl.signal,
      })

      await started.promise
      src.push(
        toolUpdated(
          completedTool({
            sessionID: "session-1",
            messageID: "msg-1",
            id: "question-race-tool-1",
            callID: "call-question-race-1",
            tool: "question",
            body: {
              questions: request.questions,
            },
            output: "User has answered your questions.",
            metadata: {
              answers: [["CLI"]],
            },
          }),
        ),
      )
      await waitFor(() => {
        const commit = ui.commits.findLast(
          (item) => item.kind === "tool" && item.partID === "question-race-tool-1" && item.toolState === "completed",
        )
        return commit ? true : undefined
      })
      pending.resolve(ok([request]))

      await Bun.sleep(50)

      expect(
        ui.events.some(
          (event) =>
            event.type === "stream.view" && event.view.type === "question" && event.view.request.id === request.id,
        ),
      ).toBe(false)

      ctrl.abort()
      await run
    } finally {
      src.close()
      await transport.close()
    }
  })

  test("respects the includeFiles flag when building prompt payloads", async () => {
    const src = eventFeed()
    const ui = footer()
    const seen: unknown[] = []
    const file: RunFilePart = {
      type: "file",
      url: "file:///tmp/a.ts",
      filename: "a.ts",
      mime: "text/plain",
    }

    const transport = await createSessionTransport({
      sdk: sdk({
        stream: src.stream,
        promptAsync: async (input) => {
          seen.push(input)
          queueMicrotask(() => {
            src.push(busy())
            src.push(idle())
          })
          return ok(undefined)
        },
      }),
      sessionID: "session-1",
      thinking: true,
      limits: () => ({}),
      footer: ui.api,
    })

    try {
      await transport.runPromptTurn({
        agent: undefined,
        model: undefined,
        variant: undefined,
        prompt: { text: "hello", parts: [] },
        files: [file],
        includeFiles: true,
      })

      await transport.runPromptTurn({
        agent: undefined,
        model: undefined,
        variant: undefined,
        prompt: { text: "again", parts: [] },
        files: [file],
        includeFiles: false,
      })

      expect(seen).toEqual([
        expect.objectContaining({
          parts: [file, { type: "text", text: "hello" }],
        }),
        expect.objectContaining({
          parts: [{ type: "text", text: "again" }],
        }),
      ])
    } finally {
      src.close()
      await transport.close()
    }
  })

  test("omits queue-local message IDs from prompt requests", async () => {
    const src = eventFeed()
    const ui = footer()
    let seen: unknown
    const transport = await createSessionTransport({
      sdk: sdk({
        stream: src.stream,
        promptAsync: async (input) => {
          seen = input
          queueMicrotask(() => {
            src.push(busy())
            src.push(idle())
          })
          return ok(undefined)
        },
      }),
      sessionID: "session-1",
      thinking: true,
      limits: () => ({}),
      footer: ui.api,
    })

    try {
      await transport.runPromptTurn({
        agent: undefined,
        model: undefined,
        variant: undefined,
        prompt: { messageID: "msg-local", localMessageID: true, text: "hello", parts: [] },
        files: [],
        includeFiles: false,
      })

      expect(seen).toEqual(expect.objectContaining({ messageID: undefined }))
    } finally {
      src.close()
      await transport.close()
    }
  })

  test("preserves caller message IDs in prompt requests", async () => {
    const src = eventFeed()
    const ui = footer()
    let seen: unknown
    const transport = await createSessionTransport({
      sdk: sdk({
        stream: src.stream,
        promptAsync: async (input) => {
          seen = input
          queueMicrotask(() => {
            src.push(busy())
            src.push(idle())
          })
          return ok(undefined)
        },
      }),
      sessionID: "session-1",
      thinking: true,
      limits: () => ({}),
      footer: ui.api,
    })

    try {
      await transport.runPromptTurn({
        agent: undefined,
        model: undefined,
        variant: undefined,
        prompt: { messageID: "msg-explicit", text: "hello", parts: [] },
        files: [],
        includeFiles: false,
      })

      expect(seen).toEqual(expect.objectContaining({ messageID: "msg-explicit" }))
    } finally {
      src.close()
      await transport.close()
    }
  })

  test("omits queue-local message IDs from command requests", async () => {
    const src = eventFeed()
    const ui = footer()
    let seen: unknown
    const transport = await createSessionTransport({
      sdk: sdk({
        stream: src.stream,
        command: async (input) => {
          seen = input
          queueMicrotask(() => {
            src.push(busy())
            src.push(idle())
          })
          return ok(commandResponse())
        },
      }),
      sessionID: "session-1",
      thinking: true,
      limits: () => ({}),
      footer: ui.api,
    })

    try {
      await transport.runPromptTurn({
        agent: undefined,
        model: undefined,
        variant: undefined,
        prompt: {
          messageID: "msg-local",
          localMessageID: true,
          text: "/skill",
          parts: [],
          command: { name: "skill", arguments: "" },
        },
        files: [],
        includeFiles: false,
      })

      expect(seen).toEqual(expect.objectContaining({ messageID: undefined }))
    } finally {
      src.close()
      await transport.close()
    }
  })

  test("preserves caller message IDs in command requests", async () => {
    const src = eventFeed()
    const ui = footer()
    let seen: unknown
    const transport = await createSessionTransport({
      sdk: sdk({
        stream: src.stream,
        command: async (input) => {
          seen = input
          queueMicrotask(() => {
            src.push(busy())
            src.push(idle())
          })
          return ok(commandResponse())
        },
      }),
      sessionID: "session-1",
      thinking: true,
      limits: () => ({}),
      footer: ui.api,
    })

    try {
      await transport.runPromptTurn({
        agent: undefined,
        model: undefined,
        variant: undefined,
        prompt: {
          messageID: "msg-explicit",
          text: "/skill",
          parts: [],
          command: { name: "skill", arguments: "" },
        },
        files: [],
        includeFiles: false,
      })

      expect(seen).toEqual(expect.objectContaining({ messageID: "msg-explicit" }))
    } finally {
      src.close()
      await transport.close()
    }
  })

  test("falls back to session status polling when idle events are missing", async () => {
    const src = eventFeed()
    const ui = footer()
    let busy = true
    const transport = await createSessionTransport({
      sdk: sdk({
        stream: src.stream,
        promptAsync: async () => {
          queueMicrotask(() => {
            src.push(assistant("msg-1"))
            busy = false
          })
          return ok(undefined)
        },
        status: async () => ok(statusMap(busy)),
      }),
      sessionID: "session-1",
      thinking: true,
      limits: () => ({}),
      footer: ui.api,
    })

    try {
      await Promise.race([
        transport.runPromptTurn({
          agent: undefined,
          model: undefined,
          variant: undefined,
          prompt: { text: "hello", parts: [] },
          files: [],
          includeFiles: false,
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error("turn timed out")), 1_000)),
      ])
    } finally {
      src.close()
      await transport.close()
    }
  })

  test("flushes interrupted output when the active turn aborts", async () => {
    const src = eventFeed()
    const seen = defer()
    const ui = footer((commit) => {
      if (commit.kind === "assistant" && commit.phase === "progress") {
        seen.resolve()
      }
    })
    const transport = await createSessionTransport({
      sdk: sdk({
        stream: src.stream,
        promptAsync: async () => {
          queueMicrotask(() => {
            src.push(busy())
            src.push(assistant("msg-1"))
            src.push(textUpdated(textPart("txt-1", "msg-1", "")))
            src.push(textDelta("msg-1", "txt-1", "unfinished"))
          })
          return ok(undefined)
        },
      }),
      sessionID: "session-1",
      thinking: true,
      limits: () => ({}),
      footer: ui.api,
    })

    const ctrl = new AbortController()

    try {
      const task = transport.runPromptTurn({
        agent: undefined,
        model: undefined,
        variant: undefined,
        prompt: { text: "hello", parts: [] },
        files: [],
        includeFiles: false,
        signal: ctrl.signal,
      })

      await seen.promise
      ctrl.abort()
      await task

      expect(ui.commits).toEqual([
        {
          kind: "assistant",
          text: "unfinished",
          phase: "progress",
          source: "assistant",
          messageID: "msg-1",
          partID: "txt-1",
        },
        {
          kind: "assistant",
          text: "",
          phase: "final",
          source: "assistant",
          messageID: "msg-1",
          partID: "txt-1",
          interrupted: true,
        },
      ])
    } finally {
      src.close()
      await transport.close()
    }
  })

  test("closes an active turn without rejecting it", async () => {
    const src = eventFeed()
    const ui = footer()
    const ready = defer()
    let aborted = false

    const transport = await createSessionTransport({
      sdk: sdk({
        stream: src.stream,
        promptAsync: async (_input, opt) => {
          ready.resolve()
          await new Promise<void>((resolve) => {
            const onAbort = () => {
              aborted = true
              opt?.signal?.removeEventListener("abort", onAbort)
              resolve()
            }

            opt?.signal?.addEventListener("abort", onAbort, { once: true })
          })
          return ok(undefined)
        },
      }),
      sessionID: "session-1",
      thinking: true,
      limits: () => ({}),
      footer: ui.api,
    })

    try {
      const task = transport.runPromptTurn({
        agent: undefined,
        model: undefined,
        variant: undefined,
        prompt: { text: "hello", parts: [] },
        files: [],
        includeFiles: false,
      })

      await ready.promise
      await transport.close()
      await task

      expect(aborted).toBe(true)
    } finally {
      src.close()
      await transport.close()
    }
  })

  test("rejects the active turn when the event stream faults", async () => {
    const ui = footer()
    const ready = defer()

    const transport = await createSessionTransport({
      sdk: sdk({
        globalEvent: () =>
          globalSse(
            (async function* (): AsyncGenerator<GlobalEvent> {
              await ready.promise
              yield globalEvent(busy())
              throw new Error("boom")
            })(),
          ),
        promptAsync: async () => {
          ready.resolve()
          return ok(undefined)
        },
        status: async () => ok({ "session-1": { type: "busy" } }),
      }),
      sessionID: "session-1",
      thinking: true,
      limits: () => ({}),
      footer: ui.api,
    })

    try {
      await expect(
        transport.runPromptTurn({
          agent: undefined,
          model: undefined,
          variant: undefined,
          prompt: { text: "hello", parts: [] },
          files: [],
          includeFiles: false,
        }),
      ).rejects.toThrow("boom")
    } finally {
      await transport.close()
    }
  })

  test("rejects the active turn when the backing instance is disposed", async () => {
    const ui = footer()
    const ready = defer()

    const transport = await createSessionTransport({
      sdk: sdk({
        globalEvent: () =>
          globalSse(
            (async function* (): AsyncGenerator<GlobalEvent> {
              await ready.promise
              yield globalEvent({
                id: "evt-disposed",
                type: "server.instance.disposed",
                properties: {
                  directory: "/tmp",
                },
              })
            })(),
          ),
        promptAsync: async () => {
          ready.resolve()
          return ok(undefined)
        },
        status: async () => ok({}),
      }),
      directory: "/tmp",
      sessionID: "session-1",
      thinking: true,
      limits: () => ({}),
      footer: ui.api,
    })

    try {
      await expect(
        transport.runPromptTurn({
          agent: undefined,
          model: undefined,
          variant: undefined,
          prompt: { text: "hello", parts: [] },
          files: [],
          includeFiles: false,
        }),
      ).rejects.toThrow("instance disposed")
    } finally {
      await transport.close()
    }
  })

  test("rejects concurrent turns", async () => {
    const src = eventFeed()
    const ui = footer()
    const transport = await createSessionTransport({
      sdk: sdk({
        stream: src.stream,
      }),
      sessionID: "session-1",
      thinking: true,
      limits: () => ({}),
      footer: ui.api,
    })

    const ctrl = new AbortController()

    try {
      const task = transport.runPromptTurn({
        agent: undefined,
        model: undefined,
        variant: undefined,
        prompt: { text: "one", parts: [] },
        files: [],
        includeFiles: false,
        signal: ctrl.signal,
      })

      await expect(
        transport.runPromptTurn({
          agent: undefined,
          model: undefined,
          variant: undefined,
          prompt: { text: "two", parts: [] },
          files: [],
          includeFiles: false,
        }),
      ).rejects.toThrow("prompt already running")

      ctrl.abort()
      await task
    } finally {
      src.close()
      await transport.close()
    }
  })
})
