import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { pathToFileURL } from "node:url"
import {
  OpenCode,
  type EventSubscribeOutput,
  type FormInfo,
  type MessageListOutput,
  type OpenCodeClient,
  type PermissionRequest,
  type SessionInboxInfo,
  type ToolContent,
} from "@opencode/client/promise"
import { createSessionTransport } from "../../src/mini/stream-v2.transport"
import { runPromptQueue } from "../../src/mini/runtime.queue"
import { entryBody } from "../../src/mini/entry.body"
import type { StreamCommit } from "../../src/mini/types"
import { createFooterApiFixture } from "./fixture/footer-api"
import { canonicalToolPart } from "./fixture/tool-part"
import { tmpdir } from "../fixture/fixture"

type RunV2Event = EventSubscribeOutput

function feed() {
  const values: RunV2Event[] = []
  let closed = false
  let wake: (() => void) | undefined
  const stream = (async function* (): AsyncGenerator<RunV2Event, void, unknown> {
    while (!closed || values.length > 0) {
      if (values.length === 0) {
        await new Promise<void>((resolve) => {
          wake = resolve
        })
        continue
      }
      const value = values.shift()
      if (value) yield value
    }
  })()
  return {
    stream,
    push(value: RunV2Event) {
      values.push(value)
      wake?.()
      wake = undefined
    },
    close() {
      closed = true
      wake?.()
      wake = undefined
    },
  }
}

function ok<T>(data: T) {
  return Promise.resolve(data)
}

function defer<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function connected(id = "evt_connected") {
  return { id, type: "server.connected", data: {} } satisfies RunV2Event
}

function durable(sessionID: string, seq?: number): { aggregateID: string; seq: number; version: 1 }
function durable<const Version extends 1 | 2>(
  sessionID: string,
  seq: number,
  version: Version,
): { aggregateID: string; seq: number; version: Version }
function durable(sessionID: string, seq = 0, version: 1 | 2 = 1) {
  return { aggregateID: sessionID, seq, version }
}

function promptAdmission(input: Parameters<OpenCodeClient["session"]["prompt"]>[0], sessionID = "ses_1") {
  return {
    id: input.id ?? "msg_prompt",
    sessionID,
    type: "user" as const,
    payload: {
      text: input.text,
      files: input.files,
      agents: input.agents,
      metadata: input.metadata,
    },
    delivery: input.delivery ?? ("steer" as const),
    timeCreated: 2,
  }
}

function footer() {
  return createFooterApiFixture()
}

type SessionMessages = MessageListOutput["data"]

const image = {
  data: "cG5n",
  mime: "image/png",
  source: { type: "inline" },
  name: "image.png",
  description: "Diagram",
  mention: { start: 5, end: 14, text: "[Image 1]" },
} as const

function compaction(status: "running" | "completed", summary: string): SessionMessages[number] {
  const message = {
    id: "msg_compaction",
    type: "compaction" as const,
    reason: "auto" as const,
    summary,
    recent: "",
    time: { created: 1 },
  }
  if (status === "running") return { ...message, status }
  return { ...message, status }
}

function form(id: string, sessionID: string, title = id): FormInfo {
  return {
    id,
    sessionID,
    title,
    fields: [
      {
        key: "answer",
        type: "string",
        options: [{ value: "yes", label: "Yes" }],
        custom: true,
      },
    ],
  }
}

function eventForm(info: FormInfo): Extract<RunV2Event, { type: "form.created" }>["data"]["form"] {
  return info as Extract<RunV2Event, { type: "form.created" }>["data"]["form"]
}

function sdk(input: {
  streams: ReturnType<typeof feed>[]
  active?: () => Record<string, { type: "running" }>
  messages?: Record<string, SessionMessages>
  sessions?: Array<{ id: string; parentID?: string; title?: string; agent?: string; time: { updated: number } }>
  forms?: Record<string, FormInfo[]>
  globals?: FormInfo[]
  globalLocation?: { directory: string; workspaceID?: string }
  permissions?: Record<string, PermissionRequest[]>
  pending?: Record<string, Awaited<ReturnType<OpenCodeClient["session"]["inbox"]["list"]>>>
  wait?: () => Promise<void>
}) {
  const client = OpenCode.make({ baseUrl: "https://opencode.test" })
  let subscription = 0
  spyOn(client.event, "subscribe").mockImplementation(() => input.streams[subscription++]?.stream ?? feed().stream)
  spyOn(client.message, "list").mockImplementation((request) =>
    ok({
      data: input.messages?.[request.sessionID] ?? [
        {
          id: "msg_old",
          type: "user" as const,
          text: "previous prompt",
          files: [],
          agents: [],
          time: { created: 1 },
        },
      ],
      cursor: {},
    }),
  )
  spyOn(client.permission, "list").mockImplementation((request) => ok(input.permissions?.[request.sessionID] ?? []))
  spyOn(client.form, "list").mockImplementation((request) => ok(input.forms?.[request.sessionID] ?? []))
  spyOn(client.form.request, "list").mockImplementation(() =>
    ok({
      location: {
        directory: input.globalLocation?.directory ?? "/tmp",
        workspaceID: input.globalLocation?.workspaceID,
        project: {
          id: "proj_1",
          directory: input.globalLocation?.directory ?? "/tmp",
          canonical: input.globalLocation?.directory ?? "/tmp",
        },
      },
      data: input.globals ?? [],
    }),
  )
  spyOn(client.session, "active").mockImplementation(() => ok(input.active?.() ?? {}))
  spyOn(client.session.inbox, "list").mockImplementation((request) => ok(input.pending?.[request.sessionID] ?? []))
  spyOn(client.session, "wait").mockImplementation(() => input.wait?.() ?? ok(undefined))
  spyOn(client.session, "message").mockImplementation((request) => {
    const message = input.messages?.[request.sessionID]?.find((item) => item.id === request.messageID)
    return message ? (ok(message) as never) : Promise.reject(new Error(`message not found: ${request.messageID}`))
  })
  spyOn(client.session, "switchAgent").mockImplementation(() => ok(undefined))
  spyOn(client.session, "switchModel").mockImplementation(() => ok(undefined))
  // The generated methods have conditional return types for throwOnError; the
  // minimal shapes below are enough for family discovery and model fallback.
  spyOn(client.session, "list").mockImplementation((request) => {
    const parentID = request?.parentID
    return ok({
      location: { directory: "/tmp", project: { id: "proj_1", directory: "/tmp" } },
      data:
        input.sessions?.filter((session) =>
          parentID === undefined
            ? true
            : parentID === null
              ? session.parentID === undefined
              : session.parentID === parentID,
        ) ?? [],
    }) as never
  })
  spyOn(client.model, "default").mockImplementation(
    () =>
      ok({
        location: { directory: "/tmp", project: { id: "proj_1", directory: "/tmp" } },
        data: undefined,
      }) as never,
  )
  return client
}

afterEach(() => {
  mock.restore()
})

describe("V2 mini transport", () => {
  test.each(["steer", "queue"] as const)("cancels the first local %s after attaching while busy", async (delivery) => {
    const events = feed()
    events.push(connected())
    const inbox: SessionInboxInfo[] = []
    const idle = defer()
    const admitted = defer()
    const client = sdk({
      streams: [events],
      active: () => ({ ses_1: { type: "running" } }),
      messages: { ses_1: [] },
      pending: { ses_1: inbox },
      wait: () => idle.promise,
    })
    spyOn(client.session, "prompt").mockImplementation((request) => {
      const item = { ...promptAdmission(request), payload: { text: request.text } }
      inbox.push(item)
      return ok(item) as never
    })
    const ui = footer()
    const live: StreamCommit[] = []
    const transport = await createSessionTransport({
      sdk: client,
      sessionID: "ses_1",
      thinking: false,
      replay: true,
      footer: ui.api,
      onCommit: (commit) => live.push(commit),
    })
    const queue = runPromptQueue({
      footer: ui.api,
      onSend: (_prompt, emittedUser) => {
        if (emittedUser) live.push(ui.commits.at(-1)!)
      },
      run: (prompt, signal, onAdmitted) =>
        transport.runPromptTurn(
          { agent: undefined, model: undefined, variant: undefined, prompt, files: [], includeFiles: false, signal },
          () => {
            onAdmitted()
            admitted.resolve()
          },
        ),
      admit: async () => {
        throw new Error("unexpected follow-up")
      },
      settle: () => transport.waitForIdle(),
    })
    try {
      ui.submit("cancel before delivery", undefined, delivery)
      await admitted.promise
      expect(ui.events.findLast((event) => event.type === "queued.prompts")?.prompts).toHaveLength(1)
      expect(ui.commits).toEqual([])
      const item = inbox.shift()!
      events.push({
        id: "evt_cancelled",
        created: 3,
        type: "session.inbox.cancelled",
        durable: durable("ses_1", 1),
        data: { sessionID: "ses_1", inboxID: item.id },
      })
      while (ui.events.findLast((event) => event.type === "queued.prompts")?.prompts.length !== 0) await Bun.sleep(0)
      await transport.replayOnResize({
        localRows: () => live.map((commit) => ({ commit })),
        reset: async () => {
          ui.commits.length = 0
        },
      })
      expect(ui.events.findLast((event) => event.type === "stream.patch")?.patch.phase).toBe("running")
      expect(ui.commits).toEqual([])
      expect(live).toEqual([])
    } finally {
      idle.resolve()
      ui.api.close()
      await queue
      await transport.close()
    }
  })

  test.each(["admission", "delivery", "projection"])("renders user content once (%s first)", async (first) => {
    const events = feed()
    events.push(connected())
    const requested = defer()
    const ack = defer()
    const admitted = defer()
    const idle = defer()
    const messages: SessionMessages = []
    const client = sdk({ streams: [events], messages: { ses_1: messages }, wait: () => idle.promise })
    const ui = footer()
    const live: StreamCommit[] = []
    const files = [
      { ...image, data: "c2VydmVy", name: "remote.png", source: { type: "uri" as const, uri: "file:///remote.png" } },
      image,
    ]
    const pending = {
      id: "msg_prompt",
      sessionID: "ses_1",
      type: "user",
      payload: { text: "look [Image 1]", files },
      delivery: "steer",
      timeCreated: 1,
    } satisfies SessionInboxInfo
    const prompt = spyOn(client.session, "prompt").mockImplementation(() => {
      requested.resolve()
      return ack.promise.then(() => pending) as never
    })
    const transport = await createSessionTransport({
      sdk: client,
      sessionID: "ses_1",
      thinking: false,
      replay: true,
      footer: ui.api,
      onCommit: (commit) => live.push(commit),
    })
    const turn = transport.runPromptTurn(
      {
        agent: undefined,
        model: undefined,
        variant: undefined,
        prompt: {
          messageID: pending.id,
          text: pending.payload.text,
          parts: [
            {
              type: "file",
              url: "data:image/png;base64,cG5n",
              filename: image.name,
              mime: image.mime,
              description: image.description,
              source: { type: "file", text: { start: 5, end: 14, value: "[Image 1]" } },
            },
          ],
        },
        files: [{ type: "file", url: "file:///remote.png", filename: "remote.png", mime: "image/png" }],
        includeFiles: true,
      },
      admitted.resolve,
    )
    await requested.promise
    if (first === "admission") {
      ack.resolve()
      await admitted.promise
    }
    expect(ui.commits).toEqual([])
    events.push({
      id: "evt_delivered",
      created: 1,
      type: "session.inbox.delivered",
      durable: durable("ses_1"),
      data: { sessionID: "ses_1", inboxID: pending.id },
    })
    while (!ui.events.some((event) => event.type === "stream.patch" && event.patch.status === "waiting for assistant"))
      await Bun.sleep(0)
    messages.push({ id: pending.id, type: "user", ...pending.payload, time: { created: 1 } })
    if (first === "projection") {
      await transport.replayOnResize({ localRows: () => [], reset: async () => {} })
    }
    ack.resolve()
    await admitted.promise

    expect(prompt).toHaveBeenCalledWith(
      expect.objectContaining({
        files: [
          { uri: "file:///remote.png", name: "remote.png" },
          {
            uri: "data:image/png;base64,cG5n",
            name: image.name,
            description: image.description,
            mention: image.mention,
          },
        ],
      }),
      expect.anything(),
    )
    const expected = [
      {
        kind: "user",
        source: "system",
        text: pending.payload.text,
        messageID: pending.id,
        phase: "start",
      },
      {
        kind: "user",
        source: "system",
        text: "remote.png",
        image: "data:image/png;base64,c2VydmVy",
        messageID: pending.id,
        partID: "image:0",
        phase: "final",
      },
      {
        kind: "user",
        source: "system",
        text: image.name,
        image: "data:image/png;base64,cG5n",
        messageID: pending.id,
        partID: "image:1",
        phase: "final",
      },
    ] satisfies StreamCommit[]
    expect(ui.commits).toEqual(expected)
    idle.resolve()
    await turn

    expect(ui.commits).toEqual(expected)
    await transport.replayOnResize({
      localRows: () => live.map((commit) => ({ commit })),
      reset: async () => {
        ui.commits.length = 0
      },
    })
    expect(ui.commits).toEqual(expected)
    await transport.close()
  })

  test.each([true, false])(
    "preserves visible image identity and suppresses unreplayed images with replay=%s",
    async (replay) => {
      const events = feed()
      events.push(connected())
      const ui = footer()
      const transport = await createSessionTransport({
        sdk: sdk({
          streams: [events],
          messages: {
            ses_1: [
              {
                id: "msg_images",
                type: "user",
                text: "",
                files: [
                  image,
                  image,
                  { ...image, description: "Another diagram" },
                  { ...image, source: { type: "uri", uri: "file:///image.png" } },
                ],
                time: { created: 1 },
              },
            ],
          },
        }),
        sessionID: "ses_1",
        thinking: false,
        replay,
        footer: ui.api,
      })

      await transport.waitForIdle()
      expect(ui.commits).toHaveLength(replay ? 3 : 0)
      expect(ui.commits.every((commit) => commit.image === "data:image/png;base64,cG5n")).toBe(true)
      expect(new Set(ui.commits.map((commit) => commit.partID)).size).toBe(replay ? 3 : 0)
      await transport.close()
    },
  )

  test("renders projected compactions as labeled transcript boundaries", async () => {
    const events = feed()
    events.push(connected())
    const ui = footer()
    const transport = await createSessionTransport({
      sdk: sdk({
        streams: [events],
        messages: {
          ses_1: [compaction("completed", "## Transport")],
        },
      }),
      sessionID: "ses_1",
      thinking: false,
      replay: true,
      footer: ui.api,
    })

    expect(ui.commits).toMatchObject([
      { text: "Compaction", compaction: true, messageID: "msg_compaction" },
      { text: "## Transport", phase: "progress", messageID: "msg_compaction" },
      { text: "", phase: "final", messageID: "msg_compaction" },
    ])
    await transport.close()
  })

  test("shows an active compaction boundary before live summary output without history replay", async () => {
    const events = feed()
    events.push(connected())
    const ui = footer()
    const transport = await createSessionTransport({
      sdk: sdk({
        streams: [events],
        active: () => ({ ses_1: { type: "running" } }),
        messages: {
          ses_1: [compaction("running", "")],
        },
      }),
      sessionID: "ses_1",
      thinking: false,
      footer: ui.api,
    })

    events.push({
      id: "evt_compaction_delta",
      created: 2,
      type: "session.compaction.delta",
      data: { sessionID: "ses_1", text: "Transport" },
    })
    events.push({
      id: "evt_compaction_ended",
      created: 3,
      type: "session.compaction.ended",
      durable: durable("ses_1", 3),
      data: { sessionID: "ses_1", reason: "auto", text: "Transport", recent: "" },
    })

    while (!ui.commits.some((commit) => commit.phase === "final")) await Bun.sleep(0)
    expect(ui.commits).toMatchObject([
      { text: "Compaction", compaction: true, messageID: "msg_compaction" },
      { text: "Transport", phase: "progress", messageID: "msg_compaction" },
      { text: "", phase: "final", messageID: "msg_compaction" },
    ])
    await transport.close()
  })

  test("reports session title changes", async () => {
    const events = feed()
    events.push(connected())
    const titles: string[] = []
    const transport = await createSessionTransport({
      sdk: sdk({ streams: [events] }),
      sessionID: "ses_1",
      thinking: false,
      footer: footer().api,
      onSessionTitle: (title) => titles.push(title),
    })

    events.push({
      id: "evt_renamed",
      created: 1,
      type: "session.renamed",
      durable: durable("ses_1", 1),
      data: { sessionID: "ses_1", title: "Greeting" },
    })

    while (titles.length === 0) await Bun.sleep(0)
    expect(titles).toEqual(["Greeting"])
    await transport.close()
  })

  test("preserves numeric footer tokens, context percentage, and cost-only usage", async () => {
    const events = feed()
    events.push(connected())
    const ui = footer()
    const transport = await createSessionTransport({
      sdk: sdk({ streams: [events] }),
      sessionID: "ses_1",
      thinking: false,
      footer: ui.api,
      contextLimit: (model) => (model.providerID === "test" && model.modelID === "model" ? 160_000 : undefined),
    })

    events.push({
      id: "evt_step_started",
      created: 1,
      type: "session.step.started",
      durable: durable("ses_1", 1),
      data: {
        sessionID: "ses_1",
        assistantMessageID: "msg_assistant",
        agent: "build",
        model: { providerID: "test", id: "model" },
      },
    })
    events.push({
      id: "evt_step_ended",
      created: 2,
      type: "session.step.ended",
      durable: durable("ses_1", 2),
      data: {
        sessionID: "ses_1",
        assistantMessageID: "msg_assistant",
        finish: "stop",
        cost: 0,
        tokens: { input: 7_000, output: 500, reasoning: 8, cache: { read: 0, write: 0 } },
      },
    })

    while (!ui.events.some((event) => event.type === "stream.patch" && event.patch.usage)) await Bun.sleep(0)
    expect(ui.events).toContainEqual({ type: "stream.patch", patch: { usage: { tokens: 7_508, percent: 5 } } })

    events.push({
      id: "evt_cost_only",
      created: 3,
      type: "session.step.ended",
      durable: durable("ses_1", 3),
      data: {
        sessionID: "ses_1",
        assistantMessageID: "msg_cost_only",
        finish: "stop",
        cost: 0.1234,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      },
    })
    while (!ui.events.some((event) => event.type === "stream.patch" && event.patch.usage?.cost)) await Bun.sleep(0)
    expect(ui.events).toContainEqual({
      type: "stream.patch",
      patch: { usage: { tokens: 0, percent: undefined, cost: 0.1234 } },
    })
    await transport.close()
  })

  test("hides tool-side assistant narration when tools are disabled", async () => {
    const events = feed()
    events.push(connected())
    const ui = footer()
    const transport = await createSessionTransport({
      sdk: sdk({ streams: [events], messages: { ses_1: [] } }),
      sessionID: "ses_1",
      thinking: false,
      tools: false,
      footer: ui.api,
    })
    const tokens = { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }

    events.push({
      id: "evt_work_text",
      created: 1,
      type: "session.text.delta",
      data: {
        sessionID: "ses_1",
        assistantMessageID: "msg_work",
        ordinal: 0,
        delta: "I'll check.",
      },
    })
    events.push({
      id: "evt_tool_start",
      created: 2,
      type: "session.tool.input.started",
      durable: durable("ses_1", 1),
      data: { sessionID: "ses_1", assistantMessageID: "msg_work", id: "call_read", name: "read" },
    })
    events.push({
      id: "evt_tool_called",
      created: 3,
      type: "session.tool.called",
      durable: durable("ses_1", 2),
      data: { sessionID: "ses_1", assistantMessageID: "msg_work", id: "call_read", input: {}, executed: true },
    })
    events.push({
      id: "evt_work_step",
      created: 4,
      type: "session.step.ended",
      durable: durable("ses_1", 3),
      data: {
        sessionID: "ses_1",
        assistantMessageID: "msg_work",
        finish: "tool-calls",
        cost: 0,
        tokens,
      },
    })
    events.push({
      id: "evt_final_text",
      created: 5,
      type: "session.text.delta",
      data: {
        sessionID: "ses_1",
        assistantMessageID: "msg_final",
        ordinal: 0,
        delta: "Done.",
      },
    })
    events.push({
      id: "evt_final_step",
      created: 6,
      type: "session.step.ended",
      durable: durable("ses_1", 4),
      data: {
        sessionID: "ses_1",
        assistantMessageID: "msg_final",
        finish: "stop",
        cost: 0,
        tokens,
      },
    })

    while (!ui.commits.some((commit) => commit.text === "Done.")) await Bun.sleep(0)
    expect(ui.commits.filter((commit) => commit.kind === "assistant" || commit.kind === "tool").map((commit) => commit.text)).toEqual([
      "Done.",
    ])
    await transport.close()
  })

  test("hides tool-side assistant narration from hydrated history when tools are disabled", async () => {
    const events = feed()
    events.push(connected())
    const ui = footer()
    const transport = await createSessionTransport({
      sdk: sdk({
        streams: [events],
        messages: {
          ses_1: [
            {
              id: "msg_final",
              type: "assistant",
              agent: "build",
              model: { providerID: "test", id: "model" },
              content: [{ type: "text", text: "Done." }],
              time: { created: 4, completed: 5 },
            },
            {
              id: "msg_work",
              type: "assistant",
              agent: "build",
              model: { providerID: "test", id: "model" },
              content: [
                { type: "text", text: "I'll check." },
                canonicalToolPart("read", { status: "completed", input: {}, content: [{ type: "text", text: "file" }] }),
              ],
              time: { created: 2, completed: 3 },
            },
            { id: "msg_user", type: "user", text: "what happened", files: [], agents: [], time: { created: 1 } },
          ],
        },
      }),
      sessionID: "ses_1",
      thinking: false,
      tools: false,
      replay: true,
      footer: ui.api,
    })

    while (!ui.commits.some((commit) => commit.text === "Done.")) await Bun.sleep(0)
    expect(
      ui.commits.filter((commit) => commit.kind === "user" || commit.kind === "assistant" || commit.kind === "tool").map((commit) => commit.text),
    ).toEqual(["what happened", "Done."])
    await transport.close()
  })

  test("recursively hydrates blockers for direct and transitive descendants", async () => {
    const events = feed()
    events.push(connected())
    const client = sdk({
      streams: [events],
      sessions: [
        { id: "ses_child", parentID: "ses_1", title: "Child", time: { updated: 2 } },
        { id: "ses_grandchild", parentID: "ses_child", title: "Grandchild", time: { updated: 1 } },
      ],
      forms: {
        ses_child: [form("frm_child", "ses_child")],
        ses_grandchild: [form("frm_grandchild", "ses_grandchild")],
      },
    })
    const ui = footer()
    const transport = await createSessionTransport({
      sdk: client,
      sessionID: "ses_1",
      thinking: false,
      footer: ui.api,
    })
    const snapshots = ui.events.flatMap((event) => (event.type === "stream.subagent" ? [event.state] : []))

    expect(snapshots.at(-1)?.tabs.map((item) => item.sessionID)).toEqual(["ses_child", "ses_grandchild"])
    expect(snapshots.at(-1)?.forms.map((item) => item.id)).toEqual(["frm_child", "frm_grandchild"])
    expect(
      ui.events.find(
        (event) => event.type === "stream.view" && event.view.type === "form" && event.view.request.id === "frm_child",
      ),
    ).toMatchObject({
      type: "stream.view",
      view: { type: "form", request: { id: "frm_child", sessionID: "ses_child" } },
    })
    transport.settleForm?.("ses_child", "frm_child")
    expect(ui.events.at(-1)).toMatchObject({
      type: "stream.view",
      view: { type: "form", request: { id: "frm_grandchild", sessionID: "ses_grandchild" } },
    })
    await transport.close()
  })

  test("resolves a pre-existing child permission from its exact source message at startup", async () => {
    const events = feed()
    events.push(connected())
    const sourceMessage = {
      id: "msg_child_source",
      type: "assistant" as const,
      agent: "build",
      model: { providerID: "test", id: "model" },
      content: [
        canonicalToolPart(
          "shell",
          {
            status: "running" as const,
            input: { command: "git status --short" },
            metadata: {},
          },
          "call_child_source",
        ),
      ],
      time: { created: 1 },
    }
    const permission: PermissionRequest = {
      id: "per_child_startup",
      sessionID: "ses_child",
      action: "shell",
      resources: ["git status --short"],
      source: { type: "tool", messageID: "msg_child_source", id: "call_child_source" },
    }
    const client = sdk({
      streams: [events],
      sessions: [{ id: "ses_child", parentID: "ses_1", title: "Child", time: { updated: 1 } }],
      permissions: { ses_child: [permission] },
      messages: {
        ses_child: [sourceMessage],
      },
    })
    const releaseSource = defer<void>()
    let sourceLookups = 0
    spyOn(client.session, "message").mockImplementation(async () => {
      sourceLookups++
      if (sourceLookups === 1) throw new Error("source temporarily unavailable")
      await releaseSource.promise
      return sourceMessage as never
    })
    const ui = footer()
    const transport = await createSessionTransport({
      sdk: client,
      sessionID: "ses_1",
      thinking: false,
      footer: ui.api,
    })

    while (sourceLookups < 2) await Bun.sleep(0)
    expect(
      ui.events.some(
        (event) =>
          event.type === "stream.view" && event.view.type === "permission" && event.view.request.id === permission.id,
      ),
    ).toBe(false)
    releaseSource.resolve()
    while (
      !ui.events.some(
        (event) =>
          event.type === "stream.view" && event.view.type === "permission" && event.view.request.id === permission.id,
      )
    )
      await Bun.sleep(0)

    expect(client.session.message).toHaveBeenCalledWith(
      { sessionID: "ses_child", messageID: "msg_child_source" },
      { signal: expect.any(AbortSignal) },
    )
    expect(
      ui.events.find(
        (event) =>
          event.type === "stream.view" && event.view.type === "permission" && event.view.request.id === permission.id,
      ),
    ).toMatchObject({
      view: {
        request: {
          tool: {
            id: "call_child_source",
            name: "shell",
            state: { status: "running", input: { command: "git status --short" } },
          },
        },
      },
    })
    expect(client.message.list).not.toHaveBeenCalledWith(
      expect.objectContaining({ sessionID: "ses_child" }),
      expect.anything(),
    )
    await transport.close()
  })

  test("reduces nested form owners idempotently and filters global events by complete location", async () => {
    const events = feed()
    events.push(connected())
    const client = sdk({
      streams: [events],
      sessions: [{ id: "ses_child", parentID: "ses_1", title: "Child", time: { updated: 1 } }],
      globalLocation: { directory: "/work", workspaceID: "wrk_1" },
    })
    const ui = footer()
    const transport = await createSessionTransport({
      sdk: client,
      location: { directory: "/work", workspaceID: "wrk_1" },
      sessionID: "ses_1",
      thinking: false,
      footer: ui.api,
    })
    const child = form("frm_child_live", "ses_child")
    events.push({ id: "evt_child_form", created: 1, type: "form.created", data: { form: eventForm(child) } })
    events.push({ id: "evt_child_form_retry", created: 2, type: "form.created", data: { form: eventForm(child) } })
    while (
      !ui.events.some(
        (event) => event.type === "stream.view" && event.view.type === "form" && event.view.request.id === child.id,
      )
    )
      await Bun.sleep(0)
    const childSnapshots = ui.events.flatMap((event) => (event.type === "stream.subagent" ? [event.state] : []))
    expect(childSnapshots.at(-1)?.forms.filter((item) => item.id === child.id)).toHaveLength(1)

    events.push({
      id: "evt_child_form_done",
      created: 3,
      type: "form.replied",
      data: { id: child.id, sessionID: "ses_child", answer: { answer: "yes" } },
    })
    const global = form("frm_global_live", "global")
    events.push({
      id: "evt_global_wrong",
      created: 4,
      type: "form.created",
      location: { directory: "/work", workspaceID: "wrk_other" },
      data: { form: eventForm(global) },
    })
    await Bun.sleep(0)
    expect(
      ui.events.some(
        (event) => event.type === "stream.view" && event.view.type === "form" && event.view.request.id === global.id,
      ),
    ).toBe(false)
    events.push({
      id: "evt_global_right",
      created: 5,
      type: "form.created",
      location: { directory: "/work", workspaceID: "wrk_1" },
      data: { form: eventForm(global) },
    })
    while (
      !ui.events.some(
        (event) => event.type === "stream.view" && event.view.type === "form" && event.view.request.id === global.id,
      )
    )
      await Bun.sleep(0)
    expect(ui.events.at(-1)).toMatchObject({
      type: "stream.view",
      view: {
        type: "form",
        request: { id: "frm_global_live", location: { directory: "/work", workspaceID: "wrk_1" } },
      },
    })
    const beforeCancel = ui.events.filter((event) => event.type === "stream.view").length
    events.push({
      id: "evt_global_done",
      created: 6,
      type: "form.cancelled",
      location: { directory: "/work", workspaceID: "wrk_1" },
      data: { id: global.id, sessionID: "global" },
    })
    while (ui.events.filter((event) => event.type === "stream.view").length === beforeCancel) await Bun.sleep(0)
    expect(ui.events.filter((event) => event.type === "stream.view").at(-1)).toEqual({
      type: "stream.view",
      view: { type: "prompt" },
    })
    await transport.close()
  })

  test("waits authoritatively and reconciles the projected terminal suffix", async () => {
    const events = feed()
    events.push(connected())
    const settled = defer()
    const messages: SessionMessages = []
    const client = sdk({
      streams: [events],
      messages: { ses_1: messages },
      wait: () => settled.promise,
    })
    const ui = footer()
    const transport = await createSessionTransport({
      sdk: client,
      sessionID: "ses_1",
      thinking: false,
      footer: ui.api,
    })

    let admitted = false
    spyOn(client.session, "prompt").mockImplementation((request) => {
      admitted = true
      return ok(promptAdmission(request)) as never
    })

    const turn = transport.runPromptTurn({
      agent: undefined,
      model: undefined,
      variant: undefined,
      prompt: { messageID: "msg_prompt", text: "hello", parts: [] },
      files: [],
      includeFiles: true,
    })
    while (!admitted) await Bun.sleep(0)
    events.push({
      id: "evt_prompted",
      created: 0,
      type: "session.inbox.delivered",
      durable: durable("ses_1"),
      data: {
        sessionID: "ses_1",
        inboxID: "msg_prompt",
      },
    })
    events.push({
      id: "evt_text",
      created: 0,
      type: "session.text.delta",
      data: {
        sessionID: "ses_1",
        assistantMessageID: "msg_assistant",
        ordinal: 0,
        delta: "ans",
      },
    })
    events.push({
      id: "evt_settled",
      created: 0,
      type: "session.execution.succeeded",
      durable: durable("ses_1"),
      data: { sessionID: "ses_1" },
    })
    let done = false
    void turn.then(() => {
      done = true
    })
    await Bun.sleep(0)
    expect(done).toBe(false)
    messages.push(
      { id: "msg_prompt", type: "user", text: "hello", time: { created: 2 } },
      {
        id: "msg_assistant",
        type: "assistant",
        agent: "build",
        model: { providerID: "test", id: "model" },
        content: [{ type: "text", text: "answer" }],
        time: { created: 3, completed: 4 },
      },
    )
    settled.resolve()
    await turn

    expect(ui.commits.map((item) => item.text)).toEqual(["hello", "ans", "wer"])
    await transport.close()
  })

  test.each(["queue", "steer"] as const)("keeps pending %s out of scrollback until delivery", async (delivery) => {
    const events = feed()
    events.push(connected())
    const client = sdk({
      streams: [events],
      pending: {
        ses_1: [
          {
            id: "msg_queued",
            sessionID: "ses_1",
            timeCreated: 1,
            type: "user",
            payload: {
              text: "follow up",
              files: [image],
              skills: [
                { id: "effect", name: "Effect", text: "Use Effect services" },
                { id: "effect", name: "Effect" },
              ],
            },
            delivery: "queue",
          },
          {
            id: "msg_cancelled",
            sessionID: "ses_1",
            timeCreated: 2,
            type: "user",
            payload: { text: "remove me", files: [image] },
            delivery,
          },
        ],
      },
    })
    const ui = footer()
    const transport = await createSessionTransport({
      sdk: client,
      sessionID: "ses_1",
      thinking: false,
      footer: ui.api,
    })
    const pending = () =>
      ui.events
        .findLast((item) => item.type === "queued.prompts")
        ?.prompts.map((item) => [item.messageID, item.delivery])

    expect(pending()).toEqual([
      ["msg_queued", "queue"],
      ["msg_cancelled", delivery],
    ])
    events.push({
      id: "evt_steered",
      created: 3,
      type: "session.inbox.delivery.changed",
      durable: durable("ses_1", 2),
      data: { sessionID: "ses_1", inboxID: "msg_queued", delivery: "steer" },
    })
    while (pending()?.[0]?.[1] !== "steer") await Bun.sleep(0)

    expect(pending()).toEqual([
      ["msg_queued", "steer"],
      ["msg_cancelled", delivery],
    ])
    expect(ui.commits).toEqual([])
    events.push({
      id: "evt_queued",
      created: 4,
      type: "session.inbox.delivery.changed",
      durable: durable("ses_1", 3),
      data: { sessionID: "ses_1", inboxID: "msg_queued", delivery: "queue" },
    })
    while (pending()?.[0]?.[1] !== "queue") await Bun.sleep(0)
    expect(pending()).toEqual([
      ["msg_queued", "queue"],
      ["msg_cancelled", delivery],
    ])
    events.push({
      id: "evt_cancelled",
      created: 5,
      type: "session.inbox.cancelled",
      durable: durable("ses_1", 4),
      data: { sessionID: "ses_1", inboxID: "msg_cancelled" },
    })
    while (pending()?.length !== 1) await Bun.sleep(0)
    expect(pending()).toEqual([["msg_queued", "queue"]])
    expect(ui.commits).toEqual([])
    events.push({
      id: "evt_promoted",
      created: 6,
      type: "session.inbox.delivered",
      durable: durable("ses_1", 5),
      data: { sessionID: "ses_1", inboxID: "msg_queued" },
    })
    while (pending()?.length !== 0) await Bun.sleep(0)
    expect(ui.commits.filter((item) => item.messageID === "msg_queued")).toHaveLength(3)
    expect(ui.commits.filter((commit) => !commit.image)).toEqual([
      expect.objectContaining({ kind: "system", partID: "skill:effect", text: '→ Skill "Effect"' }),
      expect.objectContaining({ kind: "user", text: "follow up" }),
    ])
    expect(ui.commits.filter((commit) => commit.image)).toEqual([
      expect.objectContaining({ kind: "user", messageID: "msg_queued", image: "data:image/png;base64,cG5n" }),
    ])
    const prompt = spyOn(client.session, "prompt").mockImplementation(
      (request) => ok(promptAdmission(request)) as never,
    )
    await transport.admitPromptTurn(
      {
        agent: "review",
        model: { providerID: "test", modelID: "next" },
        variant: "high",
        prompt: { messageID: "msg_next", text: "another", parts: [] },
        files: [],
        includeFiles: false,
      },
      delivery,
    )
    expect(client.session.switchAgent).toHaveBeenCalledWith({ sessionID: "ses_1", agent: "review" }, expect.anything())
    expect(client.session.switchModel).toHaveBeenCalledWith(
      { sessionID: "ses_1", model: { providerID: "test", id: "next", variant: "high" } },
      expect.anything(),
    )
    expect(prompt).toHaveBeenCalledWith(expect.objectContaining({ delivery }), expect.anything())
    expect(pending()).toEqual([["msg_next", delivery]])
    expect(ui.commits.some((commit) => commit.messageID === "msg_next")).toBe(false)
    events.push({
      id: "evt_earlier_admission",
      created: 3,
      type: "session.inbox.enqueued",
      durable: durable("ses_1", 1),
      data: {
        sessionID: "ses_1",
        inboxID: "msg_earlier",
        item: { type: "user", payload: { text: "earlier" }, delivery: "steer" },
      },
    })
    await Bun.sleep(10)
    expect(pending()).toEqual([
      ["msg_next", delivery],
      ["msg_earlier", "steer"],
    ])
    expect(ui.commits.some((commit) => commit.messageID === "msg_earlier")).toBe(false)
    await transport.close()
  })

  test("reports an observed execution failure before prompt promotion", async () => {
    const events = feed()
    events.push(connected())
    const idle = defer()
    const client = sdk({ streams: [events], messages: { ses_1: [] }, wait: () => idle.promise })
    const ui = footer()
    const transport = await createSessionTransport({
      sdk: client,
      sessionID: "ses_1",
      thinking: false,
      footer: ui.api,
    })
    let admitted = false
    spyOn(client.session, "prompt").mockImplementation((request) => {
      admitted = true
      return ok(promptAdmission(request)) as never
    })

    const turn = transport.runPromptTurn({
      agent: undefined,
      model: undefined,
      variant: undefined,
      prompt: { messageID: "msg_prompt", text: "hello", parts: [] },
      files: [],
      includeFiles: false,
    })
    while (!admitted) await Bun.sleep(0)
    events.push({
      id: "evt_failed",
      created: 2,
      type: "session.execution.failed",
      durable: durable("ses_1", 2),
      data: { sessionID: "ses_1", error: { type: "unknown", message: "instructions unavailable" } },
    })
    await Bun.sleep(0)
    idle.resolve()

    await turn
    expect(ui.commits).toContainEqual(
      expect.objectContaining({ kind: "error", messageID: "msg_prompt", text: "instructions unavailable" }),
    )
    await transport.close()
  })

  test("attributes an execution-only failure to the latest promoted prompt", async () => {
    const events = feed()
    events.push(connected())
    const idle = defer()
    const messages: SessionMessages = []
    const client = sdk({ streams: [events], messages: { ses_1: messages }, wait: () => idle.promise })
    const ui = footer()
    const transport = await createSessionTransport({
      sdk: client,
      sessionID: "ses_1",
      thinking: false,
      footer: ui.api,
    })
    let admitted = false
    spyOn(client.session, "prompt").mockImplementation((request) => {
      admitted = true
      return ok(promptAdmission(request)) as never
    })

    const turn = transport.runPromptTurn({
      agent: undefined,
      model: undefined,
      variant: undefined,
      prompt: { messageID: "msg_prompt", text: "hello", parts: [] },
      files: [],
      includeFiles: false,
    })
    while (!admitted) await Bun.sleep(0)
    events.push({
      id: "evt_prompt_promoted",
      created: 2,
      type: "session.inbox.delivered",
      durable: durable("ses_1", 2),
      data: { sessionID: "ses_1", inboxID: "msg_prompt" },
    })
    await transport.admitPromptTurn(
      {
        agent: undefined,
        model: undefined,
        variant: undefined,
        prompt: { messageID: "msg_queued", text: "follow up", parts: [] },
        files: [],
        includeFiles: false,
      },
      "queue",
    )
    events.push({
      id: "evt_queued_promoted",
      created: 3,
      type: "session.inbox.delivered",
      durable: durable("ses_1", 3),
      data: { sessionID: "ses_1", inboxID: "msg_queued" },
    })
    events.push({
      id: "evt_failed",
      created: 4,
      type: "session.execution.failed",
      durable: durable("ses_1", 4),
      data: { sessionID: "ses_1", error: { type: "unknown", message: "model unavailable" } },
    })
    await Bun.sleep(0)
    messages.push(
      { id: "msg_prompt", type: "user", text: "hello", time: { created: 2 } },
      { id: "msg_queued", type: "user", text: "follow up", time: { created: 3 } },
    )
    idle.resolve()

    await turn
    expect(ui.commits).toContainEqual(
      expect.objectContaining({ kind: "error", messageID: "msg_queued", text: "model unavailable" }),
    )
    await transport.close()
  })

  test("sends local file and directory mentions as structured prompt files", async () => {
    await using tmp = await tmpdir()
    const filePath = path.join(tmp.path, "note.ts")
    const contextPath = path.join(tmp.path, "context.txt")
    const directoryPath = path.join(tmp.path, "docs")
    await Bun.write(filePath, "export const answer = 42\n")
    await Bun.write(contextPath, "context body")
    await fs.mkdir(directoryPath)
    await Bun.write(path.join(directoryPath, "README.md"), "# hello\n")

    const events = feed()
    events.push(connected())
    const client = sdk({ streams: [events] })
    const ui = footer()
    const transport = await createSessionTransport({
      sdk: client,
      readTextFile: (url) => fs.readFile(new URL(url), "utf8"),
      sessionID: "ses_1",
      thinking: false,
      footer: ui.api,
    })
    let request: Parameters<OpenCodeClient["session"]["prompt"]>[0] | undefined
    spyOn(client.session, "prompt").mockImplementation((input) => {
      request = input
      queueMicrotask(() => {
        events.push({
          id: "evt_prompted",
          created: 0,
          type: "session.inbox.delivered",
          durable: durable("ses_1"),
          data: {
            sessionID: "ses_1",
            inboxID: "msg_prompt",
          },
        })
        events.push({
          id: "evt_settled",
          created: 0,
          type: "session.execution.succeeded",
          durable: durable("ses_1"),
          data: { sessionID: "ses_1" },
        })
      })
      return ok({ data: promptAdmission(input) }) as never
    })

    await transport.runPromptTurn({
      agent: undefined,
      model: undefined,
      variant: undefined,
      prompt: {
        messageID: "msg_prompt",
        text: "Review @note.ts and @docs",
        parts: [
          {
            type: "file",
            url: pathToFileURL(filePath).href,
            mime: "text/plain",
            filename: "note.ts",
            source: { type: "file", path: "note.ts", text: { start: 7, end: 15, value: "@note.ts" } },
          },
          {
            type: "file",
            url: pathToFileURL(`${directoryPath}${path.sep}`).href,
            mime: "application/x-directory",
            filename: "docs",
            source: { type: "file", path: "docs/", text: { start: 20, end: 25, value: "@docs" } },
          },
        ],
      },
      files: [
        { type: "file", url: pathToFileURL(contextPath).href, filename: "context.txt", mime: "text/plain" },
        { type: "file", url: "file:///tmp/image.png", filename: "image.png", mime: "image/png" },
      ],
      includeFiles: true,
    })

    expect(request?.text).toBe('Review @note.ts and @docs\n\n<file name="context.txt">\ncontext body\n</file>')
    expect(request?.files).toEqual([
      { uri: "file:///tmp/image.png", name: "image.png" },
      {
        uri: pathToFileURL(filePath).href,
        name: "note.ts",
        mention: { start: 7, end: 15, text: "@note.ts" },
      },
      {
        uri: pathToFileURL(`${directoryPath}${path.sep}`).href,
        name: "docs",
        mention: { start: 20, end: 25, text: "@docs" },
      },
    ])
    await transport.close()
  })

  test("sends attached file mentions as structured prompt files without reading them", async () => {
    const events = feed()
    events.push(connected())
    const client = sdk({ streams: [events] })
    const ui = footer()
    const remoteRead = spyOn(client.file, "read")
    const remoteList = spyOn(client.file, "list")
    const transport = await createSessionTransport({
      sdk: client,
      location: { directory: "/remote/project" },
      sessionID: "ses_1",
      thinking: false,
      footer: ui.api,
    })
    let request: Parameters<OpenCodeClient["session"]["prompt"]>[0] | undefined
    // The generated method has conditional return types for throwOnError; this mock represents the successful branch.
    // @ts-expect-error successful SDK response is valid for both modes at runtime
    spyOn(client.session, "prompt").mockImplementation((input) => {
      request = input
      queueMicrotask(() => {
        events.push({
          id: "evt_prompted",
          created: 0,
          type: "session.inbox.delivered",
          durable: durable("ses_1"),
          data: {
            sessionID: "ses_1",
            inboxID: "msg_prompt",
          },
        })
        events.push({
          id: "evt_settled",
          created: 0,
          type: "session.execution.succeeded",
          durable: durable("ses_1"),
          data: { sessionID: "ses_1" },
        })
      })
      return ok({ data: promptAdmission(input) })
    })

    await transport.runPromptTurn({
      agent: undefined,
      model: undefined,
      variant: undefined,
      prompt: {
        messageID: "msg_prompt",
        text: "Review @note.ts and @docs",
        parts: [
          {
            type: "file",
            url: "file:///remote/project/note.ts",
            mime: "text/plain",
            filename: "note.ts",
            source: { type: "file", path: "note.ts", text: { start: 7, end: 15, value: "@note.ts" } },
          },
          {
            type: "file",
            url: "file:///remote/project/docs",
            mime: "application/x-directory",
            filename: "docs",
            source: { type: "file", path: "docs", text: { start: 20, end: 25, value: "@docs" } },
          },
        ],
      },
      files: [],
      includeFiles: true,
    })

    expect(remoteRead).not.toHaveBeenCalled()
    expect(remoteList).not.toHaveBeenCalled()
    expect(request?.text).toBe("Review @note.ts and @docs")
    expect(request?.files).toEqual([
      {
        uri: "file:///remote/project/note.ts",
        name: "note.ts",
        mention: { start: 7, end: 15, text: "@note.ts" },
      },
      {
        uri: "file:///remote/project/docs",
        name: "docs",
        mention: { start: 20, end: 25, text: "@docs" },
      },
    ])
    await transport.close()
  })

  test("sends local media mentions as structured prompt files", async () => {
    await using tmp = await tmpdir()
    const filePath = path.join(tmp.path, "diagram.png")
    await Bun.write(filePath, Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00))

    const events = feed()
    events.push(connected())
    const client = sdk({ streams: [events] })
    const ui = footer()
    const transport = await createSessionTransport({
      sdk: client,
      sessionID: "ses_1",
      thinking: false,
      footer: ui.api,
    })
    let request: Parameters<OpenCodeClient["session"]["prompt"]>[0] | undefined
    // The generated method has conditional return types for throwOnError; this mock represents the successful branch.
    // @ts-expect-error successful SDK response is valid for both modes at runtime
    spyOn(client.session, "prompt").mockImplementation((input) => {
      request = input
      queueMicrotask(() => {
        events.push({
          id: "evt_prompted",
          created: 0,
          type: "session.inbox.delivered",
          durable: durable("ses_1"),
          data: {
            sessionID: "ses_1",
            inboxID: "msg_prompt",
          },
        })
        events.push({
          id: "evt_settled",
          created: 0,
          type: "session.execution.succeeded",
          durable: durable("ses_1"),
          data: { sessionID: "ses_1" },
        })
      })
      return ok({ data: promptAdmission(input) })
    })

    await transport.runPromptTurn({
      agent: undefined,
      model: undefined,
      variant: undefined,
      prompt: {
        messageID: "msg_prompt",
        text: "Review @diagram.png",
        parts: [
          {
            type: "file",
            url: pathToFileURL(filePath).href,
            mime: "text/plain",
            filename: "diagram.png",
            source: { type: "file", path: "diagram.png", text: { start: 7, end: 19, value: "@diagram.png" } },
          },
        ],
      },
      files: [],
      includeFiles: true,
    })

    expect(request?.text).toBe("Review @diagram.png")
    expect(request?.files).toEqual([
      {
        name: "diagram.png",
        uri: pathToFileURL(filePath).href,
        mention: { start: 7, end: 19, text: "@diagram.png" },
      },
    ])
    await transport.close()
  })

  test("shows V2 blockers and replies through the runtime-owned session API", async () => {
    const events = feed()
    events.push(connected())
    const client = sdk({ streams: [events] })
    const ui = footer()
    const transport = await createSessionTransport({
      sdk: client,
      sessionID: "ses_1",
      thinking: false,
      footer: ui.api,
    })
    events.push({
      id: "evt_permission",
      created: 0,
      type: "permission.asked",
      data: { id: "per_1", sessionID: "ses_1", action: "read", resources: ["/tmp/file"] },
    })

    await Bun.sleep(0)
    expect(ui.events).toContainEqual({
      type: "stream.view",
      view: {
        type: "permission",
        request: {
          id: "per_1",
          sessionID: "ses_1",
          action: "read",
          resources: ["/tmp/file"],
        },
      },
    })
    await transport.close()
  })

  test("reconnects and hydrates without completing before session.wait", async () => {
    const first = feed()
    const second = feed()
    first.push(connected("evt_connected_1"))
    second.push(connected("evt_connected_2"))
    const idle = defer()
    let running = true
    const client = sdk({
      streams: [first, second],
      active: () => {
        const active: Record<string, { type: "running" }> = {}
        if (running) active.ses_1 = { type: "running" }
        return active
      },
      wait: () => idle.promise,
    })
    let projected = false
    spyOn(client.message, "list").mockImplementation(() =>
      ok({
        data: projected
          ? [
              {
                id: "msg_prompt",
                type: "user",
                text: "hello",
                files: [],
                agents: [],
                time: { created: 2 },
              },
            ]
          : [],
        cursor: {},
      }),
    )
    const ui = footer()
    const transport = await createSessionTransport({
      sdk: client,
      sessionID: "ses_1",
      thinking: false,
      footer: ui.api,
    })
    let admitted = false
    // The generated method has conditional return types for throwOnError; this mock represents the successful branch.
    // @ts-expect-error successful SDK response is valid for both modes at runtime
    spyOn(client.session, "prompt").mockImplementation((request) => {
      admitted = true
      return ok({ data: promptAdmission(request) })
    })

    const turn = transport.runPromptTurn({
      agent: undefined,
      model: undefined,
      variant: undefined,
      prompt: { messageID: "msg_prompt", text: "hello", parts: [] },
      files: [],
      includeFiles: true,
    })
    while (!admitted) await Bun.sleep(0)
    projected = true
    running = false
    second.push({
      id: "evt_prior_failed",
      created: 1,
      type: "session.execution.failed",
      durable: durable("ses_1", 1),
      data: { sessionID: "ses_1", error: { type: "unknown", message: "prior execution failed" } },
    })
    second.push({
      id: "evt_prompted",
      created: 2,
      type: "session.inbox.delivered",
      durable: durable("ses_1", 2),
      data: { sessionID: "ses_1", inboxID: "msg_prompt" },
    })
    first.close()
    while (!ui.events.some((event) => event.type === "stream.patch" && event.patch.status === "reconnecting"))
      await Bun.sleep(0)
    idle.resolve()
    await turn
    await transport.close()
  })

  test("renders the user row once when reconnect hydration recovers a missed delivery", async () => {
    const first = feed()
    const second = feed()
    first.push(connected("evt_connected_1"))
    second.push(connected("evt_connected_2"))
    const idle = defer()
    let running = true
    let projected = false
    const client = sdk({
      streams: [first, second],
      wait: () => idle.promise,
      active: () => {
        const active: Record<string, { type: "running" }> = {}
        if (running) active.ses_1 = { type: "running" }
        return active
      },
    })
    spyOn(client.message, "list").mockImplementation(() =>
      ok({
        data: projected
          ? [
              {
                id: "msg_prompt",
                type: "user",
                text: "hello",
                files: [image],
                agents: [],
                time: { created: 2 },
              },
            ]
          : [],
        cursor: {},
      }),
    )
    const ui = footer()
    const transport = await createSessionTransport({
      sdk: client,
      sessionID: "ses_1",
      thinking: false,
      footer: ui.api,
    })
    let admitted = false
    spyOn(client.session, "prompt").mockImplementation((request) => {
      admitted = true
      return ok(promptAdmission(request)) as never
    })

    const turn = transport.runPromptTurn({
      agent: undefined,
      model: undefined,
      variant: undefined,
      prompt: { messageID: "msg_prompt", text: "hello", parts: [] },
      files: [],
      includeFiles: true,
    })
    while (!admitted) await Bun.sleep(0)
    projected = true
    running = false
    first.close()
    while (!ui.commits.some((commit) => commit.image)) await Bun.sleep(0)
    idle.resolve()
    await turn

    expect(
      ui.commits.filter((item) => item.kind === "user" && !item.image && item.messageID === "msg_prompt"),
    ).toHaveLength(1)
    expect(ui.commits.filter((item) => item.image)).toEqual([
      expect.objectContaining({ kind: "user", messageID: "msg_prompt", image: "data:image/png;base64,cG5n" }),
    ])
    await transport.close()
  })

  test("replaces the client for buffered hydration, descendants, turns, and interrupts", async () => {
    const firstEvents = feed()
    const secondEvents = feed()
    firstEvents.push(connected("evt_connected_1"))
    secondEvents.push(connected("evt_connected_2"))
    const first = sdk({ streams: [firstEvents] })
    const second = sdk({
      streams: [secondEvents],
      sessions: [{ id: "ses_child", parentID: "ses_1", title: "Child", time: { updated: 2 } }],
      forms: { ses_child: [form("frm_child", "ses_child")] },
    })
    const firstPrompt = spyOn(first.session, "prompt")
    const firstInterrupt = spyOn(first.session, "interrupt")
    spyOn(first.message, "list").mockImplementation(() =>
      ok({
        data: [
          {
            id: "msg_assistant",
            type: "assistant",
            agent: "build",
            model: { providerID: "test", id: "model" },
            content: [{ type: "text", text: "partial" }],
            time: { created: 1 },
          },
        ],
        cursor: {},
      }),
    )
    let releaseHydration!: () => void
    let replacementHydrating = false
    const hydration = new Promise<void>((resolve) => {
      releaseHydration = resolve
    })
    let releaseCatalog!: () => void
    let refreshes = 0
    const catalog = new Promise<void>((resolve) => {
      releaseCatalog = resolve
    })
    spyOn(second.message, "list").mockImplementation(async (request) => {
      if (request.sessionID !== "ses_1") return ok({ data: [], cursor: {} })
      replacementHydrating = true
      await hydration
      return ok({
        data: [
          {
            id: "msg_assistant",
            type: "assistant",
            agent: "build",
            model: { providerID: "test", id: "model" },
            content: [{ type: "text", text: "partial replacement" }],
            time: { created: 1 },
          },
        ],
        cursor: {},
      })
    })
    const current: OpenCodeClient[] = []
    const ui = footer()
    const transport = await createSessionTransport({
      sdk: first,
      reconnect: async () => second,
      onClient: (client) => current.push(client),
      sessionID: "ses_1",
      thinking: false,
      replay: true,
      footer: ui.api,
      onCatalogRefresh: () => {
        refreshes++
        if (refreshes === 2) return catalog
      },
    })

    firstEvents.close()
    while (!replacementHydrating) await Bun.sleep(0)
    await expect(
      transport.runPromptTurn({
        agent: undefined,
        model: undefined,
        variant: undefined,
        prompt: { messageID: "msg_blocked", text: "blocked", parts: [] },
        files: [],
        includeFiles: true,
      }),
    ).rejects.toThrow("Event stream is reconnecting")
    secondEvents.push({
      id: "evt_buffered_text",
      created: 2,
      type: "session.text.delta",
      data: {
        sessionID: "ses_1",
        assistantMessageID: "msg_assistant",
        ordinal: 0,
        delta: " replacement",
      },
    })
    let resized = false
    const resize = transport.replayOnResize({
      localRows: () => [],
      reset: async () => {
        resized = true
      },
    })
    releaseHydration()
    while (
      !ui.events.some(
        (event) => event.type === "stream.view" && event.view.type === "form" && event.view.request.id === "frm_child",
      )
    )
      await Bun.sleep(0)
    while (refreshes < 2) await Bun.sleep(0)
    await resize
    expect(resized).toBe(false)
    await expect(
      transport.runPromptTurn({
        agent: undefined,
        model: undefined,
        variant: undefined,
        prompt: { messageID: "msg_catalog_blocked", text: "blocked", parts: [] },
        files: [],
        includeFiles: true,
      }),
    ).rejects.toThrow("Event stream is reconnecting")
    releaseCatalog()
    await Bun.sleep(0)

    expect(current).toEqual([second])
    expect(first.event.subscribe).toHaveBeenCalledTimes(1)
    expect(second.event.subscribe).toHaveBeenCalledTimes(1)
    expect(second.session.list).toHaveBeenCalled()
    expect(second.form.list).toHaveBeenCalledWith({ sessionID: "ses_child" }, { signal: expect.any(AbortSignal) })
    expect(ui.commits.filter((commit) => commit.messageID === "msg_assistant").map((commit) => commit.text)).toEqual([
      "partial",
      " replacement",
    ])

    const prompt = spyOn(second.session, "prompt").mockImplementation((request) => {
      queueMicrotask(() => {
        secondEvents.push({
          id: "evt_replacement_prompt",
          created: 3,
          type: "session.inbox.delivered",
          durable: durable("ses_1", 1),
          data: { sessionID: "ses_1", inboxID: "msg_replacement" },
        })
        secondEvents.push({
          id: "evt_replacement_settled",
          created: 4,
          type: "session.execution.succeeded",
          durable: durable("ses_1", 2),
          data: { sessionID: "ses_1" },
        })
      })
      return ok({ data: promptAdmission(request) }) as never
    })
    await transport.runPromptTurn({
      agent: undefined,
      model: undefined,
      variant: undefined,
      prompt: { messageID: "msg_replacement", text: "replacement prompt", parts: [] },
      files: [],
      includeFiles: true,
    })
    const interrupt = spyOn(second.session, "interrupt").mockImplementation(() => ok({ interrupted: true }))
    await transport.interruptActiveTurn()

    expect(prompt).toHaveBeenCalled()
    expect(interrupt).toHaveBeenCalledWith({ sessionID: "ses_1", continue: true })
    expect(firstPrompt).not.toHaveBeenCalled()
    expect(firstInterrupt).not.toHaveBeenCalled()
    await transport.close()
  })

  test("reconciles buffered deltas already present in a resize snapshot", async () => {
    const events = feed()
    events.push(connected())
    const client = sdk({ streams: [events] })
    const ui = footer()
    const transport = await createSessionTransport({
      sdk: client,
      sessionID: "ses_1",
      thinking: false,
      replay: true,
      footer: ui.api,
    })
    spyOn(client.message, "list").mockImplementation(() =>
      ok({
        data: [
          {
            id: "msg_assistant",
            type: "assistant",
            agent: "build",
            model: { providerID: "test", id: "model" },
            content: [{ type: "text", text: "the answer" }],
            time: { created: 2, completed: 3 },
          },
        ],
        cursor: {},
      }),
    )
    let reset!: () => void
    const resetting = new Promise<void>((resolve) => {
      reset = resolve
    })
    const replay = transport.replayOnResize({ localRows: () => [], reset: () => resetting })
    events.push({
      id: "evt_text_started",
      created: 0,
      type: "session.text.started",
      durable: durable("ses_1"),
      data: {
        sessionID: "ses_1",
        assistantMessageID: "msg_assistant",
        ordinal: 0,
      },
    })
    events.push({
      id: "evt_text",
      created: 0,
      type: "session.text.delta",
      data: {
        sessionID: "ses_1",
        assistantMessageID: "msg_assistant",
        ordinal: 0,
        delta: "answer",
      },
    })
    await Bun.sleep(0)
    reset()
    await replay

    expect(ui.commits.filter((item) => item.text === "the answer")).toHaveLength(1)
    expect(ui.commits.some((item) => item.text === "answer")).toBe(false)
    await transport.close()
  })

  test("replays live assistant text missing from the resize projection", async () => {
    const events = feed()
    events.push(connected())
    const client = sdk({ streams: [events] })
    spyOn(client.message, "list").mockImplementation(() =>
      ok({
        data: [
          {
            id: "msg_assistant",
            type: "assistant",
            agent: "build",
            model: { providerID: "test", id: "model" },
            content: [{ type: "text", text: "partial" }],
            time: { created: 2, completed: 3 },
          },
        ],
        cursor: {},
      }),
    )
    const ui = footer()
    const live: StreamCommit[] = []
    const transport = await createSessionTransport({
      sdk: client,
      sessionID: "ses_1",
      thinking: false,
      replay: true,
      footer: ui.api,
      onCommit: (commit) => live.push(commit),
    })
    events.push({
      id: "evt_text",
      created: 0,
      type: "session.text.delta",
      data: {
        sessionID: "ses_1",
        assistantMessageID: "msg_assistant",
        ordinal: 0,
        delta: " suffix",
      },
    })
    await Bun.sleep(0)
    expect(live.map((commit) => commit.text)).toEqual(["partial suffix"])

    await transport.replayOnResize({
      localRows: () => [
        { commit: live[0]! },
        {
          commit: {
            ...live[0]!,
            partID: "text:1",
            text: "entirely local",
          },
        },
      ],
      reset: async () => {},
    })

    expect(ui.commits.filter((commit) => commit.messageID === "msg_assistant").map((commit) => commit.text)).toEqual([
      "partial",
      " suffix",
      "partial",
      " suffix",
      "entirely local",
    ])
    await transport.close()
  })

  test("does not replay a resize-buffered suffix twice", async () => {
    const events = feed()
    events.push(connected())
    const client = sdk({ streams: [events] })
    spyOn(client.message, "list").mockImplementation(() =>
      ok({
        data: [
          {
            id: "msg_assistant",
            type: "assistant",
            agent: "build",
            model: { providerID: "test", id: "model" },
            content: [{ type: "text", text: "partial" }],
            time: { created: 2, completed: 3 },
          },
        ],
        cursor: {},
      }),
    )
    const ui = footer()
    const live: StreamCommit[] = []
    const transport = await createSessionTransport({
      sdk: client,
      sessionID: "ses_1",
      thinking: false,
      replay: true,
      footer: ui.api,
      onCommit: (commit) => live.push(commit),
    })
    let reset!: () => void
    const resetting = new Promise<void>((resolve) => {
      reset = resolve
    })
    const replay = transport.replayOnResize({
      localRows: () => live.map((commit) => ({ commit })),
      reset: () => resetting,
    })
    events.push({
      id: "evt_text",
      created: 0,
      type: "session.text.delta",
      data: {
        sessionID: "ses_1",
        assistantMessageID: "msg_assistant",
        ordinal: 0,
        delta: " suffix",
      },
    })
    await Bun.sleep(0)
    reset()
    await replay

    expect(ui.commits.filter((commit) => commit.messageID === "msg_assistant").map((commit) => commit.text)).toEqual([
      "partial",
      "partial",
      " suffix",
    ])
    expect(live.map((commit) => commit.text)).toEqual(["partial suffix"])
    await transport.close()
  })

  test("preserves active text and reasoning across resize before terminal projection", async () => {
    const events = feed()
    events.push(connected())
    const client = sdk({ streams: [events] })
    spyOn(client.message, "list").mockImplementation(() => ok({ data: [], cursor: {} }))
    const ui = footer()
    const live: StreamCommit[] = []
    const transport = await createSessionTransport({
      sdk: client,
      sessionID: "ses_1",
      thinking: true,
      replay: true,
      footer: ui.api,
      onCommit: (commit) => live.push(commit),
    })
    events.push({
      id: "evt_text",
      created: 0,
      type: "session.text.delta",
      data: {
        sessionID: "ses_1",
        assistantMessageID: "msg_assistant",
        ordinal: 0,
        delta: "hello",
      },
    })
    events.push({
      id: "evt_reasoning",
      created: 0,
      type: "session.reasoning.delta",
      data: {
        sessionID: "ses_1",
        assistantMessageID: "msg_assistant",
        ordinal: 0,
        delta: "thought",
      },
    })
    await Bun.sleep(0)
    expect(live.map((commit) => commit.text)).toEqual(["hello", "Thinking: thought"])

    await transport.replayOnResize({
      localRows: () => live.map((commit) => ({ commit })),
      reset: async () => {},
    })

    expect(ui.commits.slice(-2).map((commit) => commit.text)).toEqual(["hello", "Thinking: thought"])
    await transport.close()
  })

  test("serializes and coalesces overlapping resize replays", async () => {
    const events = feed()
    events.push(connected())
    const client = sdk({ streams: [events] })
    const ui = footer()
    const transport = await createSessionTransport({
      sdk: client,
      sessionID: "ses_1",
      thinking: false,
      replay: true,
      footer: ui.api,
    })
    let release!: () => void
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const order: string[] = []
    const first = transport.replayOnResize({
      localRows: () => [],
      reset: async () => {
        order.push("first:start")
        await blocked
        order.push("first:end")
      },
    })
    await Bun.sleep(0)
    const second = transport.replayOnResize({
      localRows: () => [],
      reset: async () => {
        order.push("second")
      },
    })
    release()
    await Promise.all([first, second])

    expect(second).toBe(first)
    expect(order).toEqual(["first:start", "first:end", "second"])
    await transport.close()
  })

  test("restores local output and drains buffered events when resize hydration fails", async () => {
    const events = feed()
    events.push(connected())
    const client = sdk({ streams: [events] })
    const ui = footer()
    const live: StreamCommit[] = []
    const transport = await createSessionTransport({
      sdk: client,
      sessionID: "ses_1",
      thinking: false,
      replay: true,
      footer: ui.api,
      onCommit: (commit) => live.push(commit),
    })
    events.push({
      id: "evt_text_1",
      created: 0,
      type: "session.text.delta",
      data: {
        sessionID: "ses_1",
        assistantMessageID: "msg_assistant",
        ordinal: 0,
        delta: "hello",
      },
    })
    await Bun.sleep(0)
    spyOn(client.message, "list").mockImplementation(() => Promise.reject(new Error("projection failed")))

    const replay = transport.replayOnResize({
      localRows: () => live.map((commit) => ({ commit })),
      reset: async () => {},
    })
    events.push({
      id: "evt_text_2",
      created: 0,
      type: "session.text.delta",
      data: {
        sessionID: "ses_1",
        assistantMessageID: "msg_assistant",
        ordinal: 0,
        delta: " world",
      },
    })
    await expect(replay).rejects.toThrow("projection failed")

    expect(ui.commits.slice(-2).map((commit) => commit.text)).toEqual(["hello", " world"])
    expect(live.at(-1)?.text).toBe("hello world")
    await transport.close()
  })

  test("dedupes a projected step failure from live redelivery", async () => {
    const events = feed()
    events.push(connected())
    const client = sdk({ streams: [events] })
    spyOn(client.message, "list").mockImplementation(() =>
      ok({
        data: [
          {
            id: "msg_assistant",
            type: "assistant",
            agent: "build",
            model: { providerID: "test", id: "model" },
            content: [],
            error: { type: "provider.transport", message: "provider failed" },
            time: { created: 2, completed: 3 },
          },
        ],
        cursor: {},
      }),
    )
    const ui = footer()
    const transport = await createSessionTransport({
      sdk: client,
      sessionID: "ses_1",
      thinking: false,
      replay: true,
      footer: ui.api,
    })
    events.push({
      id: "evt_step_failed",
      created: 2,
      type: "session.step.failed",
      durable: durable("ses_1", 1),
      data: {
        sessionID: "ses_1",
        assistantMessageID: "msg_assistant",
        error: { type: "provider.transport", message: "provider failed" },
      },
    })
    await Bun.sleep(0)

    expect(ui.commits.filter((commit) => commit.kind === "error" && commit.text === "provider failed")).toHaveLength(1)
    await transport.close()
  })

  test("dedupes a retained live step failure from resize projection", async () => {
    const events = feed()
    events.push(connected())
    const client = sdk({ streams: [events] })
    const ui = footer()
    const live: StreamCommit[] = []
    const transport = await createSessionTransport({
      sdk: client,
      sessionID: "ses_1",
      thinking: false,
      replay: true,
      footer: ui.api,
      onCommit: (commit) => live.push(commit),
    })
    events.push({
      id: "evt_step_failed",
      created: 2,
      type: "session.step.failed",
      durable: durable("ses_1", 1),
      data: {
        sessionID: "ses_1",
        assistantMessageID: "msg_assistant",
        error: { type: "provider.transport", message: "provider failed" },
      },
    })
    await Bun.sleep(0)
    expect(live[0]?.messageID).toBe("msg_assistant")
    spyOn(client.message, "list").mockImplementation(() =>
      ok({
        data: [
          {
            id: "msg_assistant",
            type: "assistant",
            agent: "build",
            model: { providerID: "test", id: "model" },
            content: [],
            error: { type: "provider.transport", message: "provider failed" },
            time: { created: 2, completed: 3 },
          },
        ],
        cursor: {},
      }),
    )

    await transport.replayOnResize({
      localRows: () => live.map((commit) => ({ commit })),
      reset: async () => {},
    })

    expect(ui.commits.filter((commit) => commit.kind === "error" && commit.text === "provider failed")).toHaveLength(2)
    await transport.close()
  })

  test("preserves an execution-only local error beside its projected prompt", async () => {
    const events = feed()
    events.push(connected())
    const client = sdk({ streams: [events] })
    const ui = footer()
    const transport = await createSessionTransport({
      sdk: client,
      sessionID: "ses_1",
      thinking: false,
      replay: true,
      footer: ui.api,
    })
    spyOn(client.message, "list").mockImplementation(() =>
      ok({
        data: [
          {
            id: "msg_prompt",
            type: "user",
            text: "hello",
            files: [],
            agents: [],
            time: { created: 2 },
          },
        ],
        cursor: {},
      }),
    )

    await transport.replayOnResize({
      localRows: () => [
        {
          commit: {
            kind: "error",
            source: "system",
            text: "model unavailable",
            phase: "start",
            messageID: "msg_prompt",
          },
        },
      ],
      reset: async () => {},
    })

    expect(ui.commits.some((commit) => commit.kind === "error" && commit.text === "model unavailable")).toBe(true)
    await transport.close()
  })

  test("scopes text and reasoning ordinals by assistant message", async () => {
    const events = feed()
    events.push(connected())
    const client = sdk({ streams: [events] })
    spyOn(client.message, "list").mockImplementation(() =>
      ok({
        data: [
          {
            id: "msg_b",
            type: "assistant",
            agent: "build",
            model: { providerID: "test", id: "model" },
            content: [
              { type: "reasoning", text: "second thought" },
              { type: "text", text: "second answer" },
            ],
            time: { created: 4, completed: 5 },
          },
          {
            id: "msg_a",
            type: "assistant",
            agent: "build",
            model: { providerID: "test", id: "model" },
            content: [
              { type: "reasoning", text: "first thought" },
              { type: "text", text: "first answer" },
            ],
            time: { created: 2, completed: 3 },
          },
        ],
        cursor: {},
      }),
    )

    const ui = footer()
    const transport = await createSessionTransport({
      sdk: client,
      sessionID: "ses_1",
      thinking: true,
      replay: true,
      footer: ui.api,
    })

    expect(ui.commits.map((item) => item.text)).toEqual([
      "Thinking: first thought",
      "first answer",
      "Thinking: second thought",
      "second answer",
    ])
    await transport.close()
  })

  test("renders full reasoning when only the ended event is observed", async () => {
    const events = feed()
    events.push(connected())
    const client = sdk({ streams: [events] })
    const ui = footer()
    const transport = await createSessionTransport({
      sdk: client,
      sessionID: "ses_1",
      thinking: true,
      footer: ui.api,
    })
    events.push({
      id: "evt_reasoning",
      created: 0,
      type: "session.reasoning.ended",
      durable: durable("ses_1"),
      data: {
        sessionID: "ses_1",
        assistantMessageID: "msg_assistant",
        ordinal: 0,
        text: "considering",
      },
    })
    await Bun.sleep(0)

    expect(ui.commits.at(-1)?.text).toBe("Thinking: considering")
    await transport.close()
  })

  test("tracks repeated root call IDs independently across assistant messages", async () => {
    const events = feed()
    events.push(connected())
    const client = sdk({ streams: [events] })
    const ui = footer()
    const transport = await createSessionTransport({
      sdk: client,
      sessionID: "ses_1",
      thinking: false,
      footer: ui.api,
    })

    for (const [index, messageID] of ["msg_tool_one", "msg_tool_two"].entries()) {
      events.push({
        id: `evt_repeated_input_${index}`,
        created: index * 3 + 1,
        type: "session.tool.input.started",
        durable: durable("ses_1", index * 3),
        data: { sessionID: "ses_1", assistantMessageID: messageID, id: "call_repeated", name: "read" },
      })
      events.push({
        id: `evt_repeated_called_${index}`,
        created: index * 3 + 2,
        type: "session.tool.called",
        durable: durable("ses_1", index * 3 + 1),
        data: {
          sessionID: "ses_1",
          assistantMessageID: messageID,
          id: "call_repeated",
          input: { path: `${index + 1}.txt` },
          executed: true,
        },
      })
      events.push({
        id: `evt_repeated_success_${index}`,
        created: index * 3 + 3,
        type: "session.tool.success",
        durable: durable("ses_1", index * 3 + 2, 2),
        data: {
          sessionID: "ses_1",
          assistantMessageID: messageID,
          id: "call_repeated",
          metadata: {},
          content: [{ type: "text", text: "" }],
          executed: true,
        },
      })
    }
    await Bun.sleep(0)

    const commits = ui.commits.filter((item) => item.part?.id === "call_repeated")
    expect(commits.map((item) => [item.messageID, item.phase])).toEqual([
      ["msg_tool_one", "start"],
      ["msg_tool_one", "final"],
      ["msg_tool_two", "start"],
      ["msg_tool_two", "final"],
    ])
    expect(
      commits
        .filter((item) => item.phase === "final")
        .map((item) => (item.part?.state.status === "streaming" ? undefined : item.part?.state.input)),
    ).toEqual([{ path: "1.txt" }, { path: "2.txt" }])
    await transport.close()
  })

  test("reduces root tool progress and preserves it on failure", async () => {
    const events = feed()
    events.push(connected())
    const client = sdk({ streams: [events] })
    const ui = footer()
    const transport = await createSessionTransport({
      sdk: client,
      sessionID: "ses_1",
      thinking: false,
      footer: ui.api,
    })
    events.push({
      id: "evt_progress_input",
      created: 1,
      type: "session.tool.input.started",
      durable: durable("ses_1"),
      data: {
        sessionID: "ses_1",
        assistantMessageID: "msg_progress",
        id: "call_progress",
        name: "shell",
      },
    })
    events.push({
      id: "evt_progress_called",
      created: 2,
      type: "session.tool.called",
      durable: durable("ses_1", 1),
      data: {
        sessionID: "ses_1",
        assistantMessageID: "msg_progress",
        id: "call_progress",
        input: { command: "printf partial && false" },
        executed: true,
      },
    })
    events.push({
      id: "evt_progress",
      created: 3,
      type: "session.tool.progress",
      data: {
        sessionID: "ses_1",
        assistantMessageID: "msg_progress",
        id: "call_progress",
        metadata: { checkpoint: 1 },
      },
    })
    events.push({
      id: "evt_progress_failed",
      created: 4,
      type: "session.tool.failed",
      durable: durable("ses_1", 3, 2),
      data: {
        sessionID: "ses_1",
        assistantMessageID: "msg_progress",
        id: "call_progress",
        error: { type: "unknown", message: "boom" },
        metadata: { checkpoint: 1 },
        content: [{ type: "text", text: "partial" }],
        executed: true,
      },
    })
    await Bun.sleep(0)

    const commits = ui.commits.filter((item) => item.part?.id === "call_progress")
    expect(commits.map((item) => [item.phase, item.text, item.toolState])).toEqual([
      ["start", "running shell", "running"],
      ["progress", "partial", "running"],
      ["final", "boom", "error"],
    ])
    expect(commits.at(-1)?.part?.state).toMatchObject({
      status: "error",
      metadata: { checkpoint: 1 },
      content: [{ type: "text", text: "partial" }],
    })
    await transport.close()
  })

  test.each(["completed", "error"] as const)(
    "renders only terminal inline tool images for %s results across resize",
    async (status) => {
      const events = feed()
      events.push(connected())
      const messages: SessionMessages = []
      const client = sdk({ streams: [events], messages: { ses_1: messages } })
      const ui = footer()
      const live: StreamCommit[] = []
      const transport = await createSessionTransport({
        sdk: client,
        sessionID: "ses_1",
        thinking: false,
        replay: true,
        footer: ui.api,
        onCommit: (commit) => live.push(commit),
      })
      const content = [
        { type: "text", text: "Captured screenshot" },
        { type: "file", mime: "image/png", uri: "data:image/png;base64,cG5n" },
        { type: "file", mime: "image/png", uri: "https://example.com/remote.png" },
        { type: "file", mime: "text/plain", uri: "data:text/plain;base64,dGV4dA==" },
        { type: "file", mime: "application/pdf", uri: "data:image/png;base64,cG5n" },
      ] satisfies [ToolContent, ...ToolContent[]]
      const error = { type: "unknown", message: "Tool failed after capturing image" } as const
      const data = { sessionID: "ses_1", assistantMessageID: "msg_tool", id: "call_image", executed: true, content }
      const terminal: RunV2Event =
        status === "completed"
          ? { id: "evt_result", created: 3, type: "session.tool.success", durable: durable("ses_1", 3, 2), data }
          : {
              id: "evt_result",
              created: 3,
              type: "session.tool.failed",
              durable: durable("ses_1", 3, 2),
              data: { ...data, error },
            }
      events.push({
        id: "evt_input",
        created: 1,
        type: "session.tool.input.started",
        durable: durable("ses_1", 1),
        data: { sessionID: "ses_1", assistantMessageID: "msg_tool", id: "call_image", name: "read" },
      })
      events.push({
        id: "evt_called",
        created: 2,
        type: "session.tool.called",
        durable: durable("ses_1", 2),
        data: {
          sessionID: "ses_1",
          assistantMessageID: "msg_tool",
          id: "call_image",
          input: { file_path: "image.png" },
          executed: true,
        },
      })
      while (!ui.commits.some((commit) => commit.toolState === "running")) await Bun.sleep(0)
      expect(ui.commits.some((commit) => commit.image)).toBe(false)
      events.push(terminal)
      events.push(terminal)
      while (!ui.commits.some((commit) => commit.image)) await Bun.sleep(0)
      const images = ui.commits.filter((commit) => commit.image)
      expect(images).toEqual([
        {
          kind: "tool",
          source: "tool",
          text: "[Image 1]",
          image: "data:image/png;base64,cG5n",
          messageID: "msg_tool",
          partID: "prt_call_image:image:0",
          phase: "final",
        },
      ])

      const message = {
        id: "msg_tool",
        type: "assistant" as const,
        agent: "build",
        model: { providerID: "test", id: "model" },
        content: [
          canonicalToolPart(
            "read",
            status === "completed" ? { status, input: {}, content } : { status, input: {}, content, error },
            "call_image",
          ),
        ],
        time: { created: 1 },
      }
      messages.push({ ...message, content: [] })
      await transport.replayOnResize({
        localRows: () => live.map((commit) => ({ commit })),
        reset: async () => {
          ui.commits.length = 0
        },
      })
      expect(ui.commits.filter((commit) => commit.image)).toEqual(images)
      messages[0] = message
      await transport.replayOnResize({
        localRows: () => live.map((commit) => ({ commit })),
        reset: async () => {
          ui.commits.length = 0
        },
      })
      expect(ui.commits.filter((commit) => commit.image)).toEqual(images)
      await transport.close()
    },
  )

  test("waits for the attempted web search provider before rendering its title", async () => {
    const events = feed()
    events.push(connected())
    const client = sdk({ streams: [events] })
    const ui = footer()
    const transport = await createSessionTransport({
      sdk: client,
      sessionID: "ses_1",
      thinking: false,
      footer: ui.api,
    })
    events.push({
      id: "evt_websearch_input",
      created: 1,
      type: "session.tool.input.started",
      durable: durable("ses_1"),
      data: {
        sessionID: "ses_1",
        assistantMessageID: "msg_websearch",
        id: "call_websearch",
        name: "websearch",
      },
    })
    events.push({
      id: "evt_websearch_called",
      created: 2,
      type: "session.tool.called",
      durable: durable("ses_1", 1),
      data: {
        sessionID: "ses_1",
        assistantMessageID: "msg_websearch",
        id: "call_websearch",
        input: { query: "effect" },
        executed: true,
      },
    })
    await Bun.sleep(0)
    expect(ui.commits.filter((item) => item.part?.id === "call_websearch")).toEqual([])

    events.push({
      id: "evt_websearch_progress",
      created: 3,
      type: "session.tool.progress",
      data: {
        sessionID: "ses_1",
        assistantMessageID: "msg_websearch",
        id: "call_websearch",
        metadata: { provider: "exa" },
      },
    })
    events.push({
      id: "evt_websearch_failed",
      created: 4,
      type: "session.tool.failed",
      durable: durable("ses_1", 2, 2),
      data: {
        sessionID: "ses_1",
        assistantMessageID: "msg_websearch",
        id: "call_websearch",
        error: { type: "tool.execution", message: "Web search request failed (HTTP 403)" },
        metadata: { provider: "exa" },
        executed: true,
      },
    })
    await Bun.sleep(0)

    const commits = ui.commits.filter((item) => item.part?.id === "call_websearch")
    expect(commits.map((item) => item.phase)).toEqual(["start", "final"])
    const start = commits[0]
    if (!start) throw new Error("Expected web search start commit")
    expect(entryBody(start)).toEqual({ type: "text", content: '◈ Web Search via Exa "effect"' })
    await transport.close()
  })

  test("falls back to the default model when selecting a variant on a fresh session", async () => {
    const events = feed()
    events.push(connected())
    const client = sdk({ streams: [events] })
    const ui = footer()
    const transport = await createSessionTransport({
      sdk: client,
      location: { directory: "/project", workspaceID: "wrk_1" },
      sessionID: "ses_1",
      thinking: false,
      footer: ui.api,
    })
    spyOn(client.session, "get").mockImplementation(() => ok({ model: undefined }) as never)
    const defaultModel = spyOn(client.model, "default").mockImplementation(
      () =>
        ok({
          location: { directory: "/tmp", project: { id: "proj_1", directory: "/tmp" } },
          data: { id: "gpt-5", providerID: "openai" },
        }) as never,
    )
    const switched = spyOn(client.session, "switchModel").mockImplementation(() => ok(undefined))
    let admitted = false
    // The generated method has conditional return types for throwOnError; this mock represents the successful branch.
    // @ts-expect-error successful SDK response is valid for both modes at runtime
    spyOn(client.session, "prompt").mockImplementation((request) => {
      admitted = true
      return ok({ data: promptAdmission(request) })
    })

    const turn = transport.runPromptTurn({
      agent: undefined,
      model: undefined,
      variant: "high",
      prompt: { messageID: "msg_prompt", text: "hello", parts: [] },
      files: [],
      includeFiles: true,
    })
    while (!admitted) await Bun.sleep(0)
    events.push({
      id: "evt_prompted",
      created: 0,
      type: "session.inbox.delivered",
      durable: durable("ses_1"),
      data: {
        sessionID: "ses_1",
        inboxID: "msg_prompt",
      },
    })
    events.push({
      id: "evt_settled",
      created: 0,
      type: "session.execution.succeeded",
      durable: durable("ses_1"),
      data: { sessionID: "ses_1" },
    })
    await turn

    expect(switched).toHaveBeenCalledWith(
      { sessionID: "ses_1", model: { providerID: "openai", id: "gpt-5", variant: "high" } },
      { signal: undefined },
    )
    expect(defaultModel).toHaveBeenCalledWith(
      { location: { directory: "/project", workspace: "wrk_1" } },
      { signal: undefined },
    )
    await transport.close()
  })

  test("interrupts the current Session when an active turn is aborted", async () => {
    const events = feed()
    events.push(connected())
    const idle = defer()
    const client = sdk({ streams: [events], wait: () => idle.promise })
    const ui = footer()
    const transport = await createSessionTransport({
      sdk: client,
      sessionID: "ses_1",
      thinking: false,
      footer: ui.api,
    })
    let admitted = false
    // The generated method has conditional return types for throwOnError; this mock represents the successful branch.
    // @ts-expect-error successful SDK response is valid for both modes at runtime
    spyOn(client.session, "prompt").mockImplementation((request) => {
      admitted = true
      return ok({ data: promptAdmission(request) })
    })
    const interrupted = spyOn(client.session, "interrupt").mockImplementation(() => ok({ interrupted: true }))
    const controller = new AbortController()
    const turn = transport.runPromptTurn({
      agent: undefined,
      model: undefined,
      variant: undefined,
      prompt: { messageID: "msg_prompt", text: "hello", parts: [] },
      files: [],
      includeFiles: true,
      signal: controller.signal,
    })
    while (!admitted) await Bun.sleep(0)
    events.push({
      id: "evt_prompted",
      created: 0,
      type: "session.inbox.delivered",
      durable: durable("ses_1"),
      data: {
        sessionID: "ses_1",
        inboxID: "msg_prompt",
      },
    })
    await Bun.sleep(0)
    controller.abort()
    idle.resolve()
    await turn

    expect(interrupted).toHaveBeenCalledWith({ sessionID: "ses_1", continue: true })
    await transport.close()
  })

  test("runs a shell turn through v2.session.shell and renders live output", async () => {
    const events = feed()
    events.push(connected())
    const client = sdk({ streams: [events] })
    const ui = footer()
    const transport = await createSessionTransport({
      sdk: client,
      sessionID: "ses_1",
      thinking: false,
      footer: ui.api,
    })
    let request: Parameters<OpenCodeClient["session"]["shell"]>[0] | undefined
    spyOn(client.session, "shell").mockImplementation((input) => {
      request = input
      queueMicrotask(() => {
        events.push({
          id: input.id ?? "evt_missing",
          created: 0,
          type: "session.shell.started",
          durable: durable("ses_1"),
          data: {
            sessionID: "ses_1",
            shell: {
              id: "sh_shell",
              status: "running",
              command: "ls",
              cwd: "/tmp",
              shell: "/bin/sh",
              file: "/tmp/opencode-shell",
              metadata: {},
              time: { started: 0 },
            },
          },
        })
        events.push({
          id: "evt_shell_end",
          created: 0,
          type: "session.shell.ended",
          durable: durable("ses_1", 1),
          data: {
            sessionID: "ses_1",
            shell: {
              id: "sh_shell",
              status: "exited",
              command: "ls",
              cwd: "/tmp",
              shell: "/bin/sh",
              file: "/tmp/opencode-shell",
              exit: 0,
              metadata: {},
              time: { started: 0, completed: 1 },
            },
            output: { output: "file.txt", cursor: 8, size: 8, truncated: false },
          },
        })
      })
      return ok(undefined) as never
    })

    await transport.runPromptTurn({
      agent: undefined,
      model: undefined,
      variant: undefined,
      prompt: { text: "ls", parts: [], mode: "shell" },
      files: [],
      includeFiles: true,
    })

    expect(request).toMatchObject({ sessionID: "ses_1", command: "ls", id: expect.stringMatching(/^evt_/) })
    expect(ui.commits.filter((item) => item.shell)).toMatchObject([
      { phase: "start", partID: "shell:sh_shell", tool: "shell", toolState: "running", shell: { command: "ls" } },
      {
        phase: "progress",
        partID: "shell:sh_shell",
        text: "file.txt",
        toolState: "completed",
        shell: { command: "ls" },
      },
    ])
    expect(ui.events).toContainEqual({ type: "stream.patch", patch: { phase: "running", status: "running shell" } })
    await transport.close()
  })

  test("aborts an active shell turn without interrupting the session", async () => {
    const events = feed()
    events.push(connected())
    const client = sdk({ streams: [events] })
    const ui = footer()
    const transport = await createSessionTransport({
      sdk: client,
      sessionID: "ses_1",
      thinking: false,
      footer: ui.api,
    })
    let started = false
    let aborted = false
    spyOn(client.session, "shell").mockImplementation(
      (_input, options) =>
        new Promise((_, reject) => {
          started = true
          options?.signal?.addEventListener("abort", () => {
            aborted = true
            reject(new Error("aborted"))
          })
        }) as never,
    )
    const interrupted = spyOn(client.session, "interrupt").mockImplementation(() => ok({ interrupted: true }))

    const turn = transport.runPromptTurn({
      agent: undefined,
      model: undefined,
      variant: undefined,
      prompt: { text: "sleep 100", parts: [], mode: "shell" },
      files: [],
      includeFiles: true,
    })
    while (!started) await Bun.sleep(0)
    await transport.interruptActiveTurn()
    await turn

    expect(aborted).toBe(true)
    expect(interrupted).not.toHaveBeenCalled()
    await transport.close()
  })

  test("does not resolve an owned shell output wait from an unrelated shell", async () => {
    const events = feed()
    events.push(connected())
    const client = sdk({ streams: [events] })
    const ui = footer()
    const transport = await createSessionTransport({
      sdk: client,
      sessionID: "ses_1",
      thinking: false,
      footer: ui.api,
    })
    let request: Parameters<OpenCodeClient["session"]["shell"]>[0] | undefined
    let complete!: () => void
    spyOn(client.session, "shell").mockImplementation((input) => {
      request = input
      return new Promise<void>((resolve) => {
        complete = resolve
      }) as never
    })

    let done = false
    const turn = transport
      .runPromptTurn({
        agent: undefined,
        model: undefined,
        variant: undefined,
        prompt: { text: "pwd", parts: [], mode: "shell" },
        files: [],
        includeFiles: true,
      })
      .then(() => {
        done = true
      })
    while (!request) await Bun.sleep(0)
    events.push({
      id: "evt_unrelated_shell",
      created: 0,
      type: "session.shell.started",
      durable: durable("ses_1"),
      data: {
        sessionID: "ses_1",
        shell: {
          id: "sh_unrelated",
          status: "running",
          command: "other",
          cwd: "/tmp",
          shell: "/bin/sh",
          file: "/tmp/unrelated",
          metadata: {},
          time: { started: 0 },
        },
      },
    })
    events.push({
      id: "evt_unrelated_end",
      created: 0,
      type: "session.shell.ended",
      durable: durable("ses_1", 1),
      data: {
        sessionID: "ses_1",
        shell: {
          id: "sh_unrelated",
          status: "exited",
          command: "other",
          cwd: "/tmp",
          shell: "/bin/sh",
          file: "/tmp/unrelated",
          exit: 0,
          metadata: {},
          time: { started: 0, completed: 1 },
        },
        output: { output: "wrong", cursor: 5, size: 5, truncated: false },
      },
    })
    await Bun.sleep(0)
    complete()
    await Bun.sleep(0)
    expect(done).toBe(false)

    events.push({
      id: request.id ?? "evt_missing",
      created: 0,
      type: "session.shell.started",
      durable: durable("ses_1", 2),
      data: {
        sessionID: "ses_1",
        shell: {
          id: "sh_owned",
          status: "running",
          command: "pwd",
          cwd: "/tmp",
          shell: "/bin/sh",
          file: "/tmp/owned",
          metadata: {},
          time: { started: 0 },
        },
      },
    })
    events.push({
      id: "evt_owned_end",
      created: 0,
      type: "session.shell.ended",
      durable: durable("ses_1", 3),
      data: {
        sessionID: "ses_1",
        shell: {
          id: "sh_owned",
          status: "exited",
          command: "pwd",
          cwd: "/tmp",
          shell: "/bin/sh",
          file: "/tmp/owned",
          exit: 0,
          metadata: {},
          time: { started: 0, completed: 1 },
        },
        output: { output: "/tmp", cursor: 4, size: 4, truncated: false },
      },
    })
    await turn

    expect(request.id).toMatch(/^evt_/)
    expect(ui.commits.some((item) => item.partID === "shell:sh_owned" && item.text === "/tmp")).toBe(true)
    await transport.close()
  })

  test("hydrates projected shell transcripts once and dedupes live redelivery", async () => {
    const events = feed()
    events.push(connected())
    const client = sdk({
      streams: [events],
      messages: {
        ses_1: [
          {
            id: "msg_shell",
            type: "shell" as const,
            shellID: "sh_1",
            status: "exited",
            command: "ls",
            exit: 0,
            output: { output: "file.txt", cursor: 8, size: 8, truncated: false },
            time: { created: 1, completed: 2 },
          },
        ],
      },
    })
    const ui = footer()
    const transport = await createSessionTransport({
      sdk: client,
      sessionID: "ses_1",
      thinking: false,
      replay: true,
      footer: ui.api,
    })
    events.push({
      id: "evt_shell_end",
      created: 0,
      type: "session.shell.ended",
      durable: durable("ses_1", 1),
      data: {
        sessionID: "ses_1",
        shell: {
          id: "sh_1",
          status: "exited",
          command: "ls",
          cwd: "/tmp",
          shell: "/bin/sh",
          file: "/tmp/opencode-shell",
          exit: 0,
          metadata: {},
          time: { started: 0, completed: 1 },
        },
        output: { output: "file.txt", cursor: 8, size: 8, truncated: false },
      },
    })
    await Bun.sleep(0)
    await Bun.sleep(0)

    expect(ui.commits.filter((item) => item.shell)).toMatchObject([
      { phase: "start", partID: "shell:sh_1", shell: { command: "ls" } },
      { phase: "progress", partID: "shell:sh_1", text: "file.txt", toolState: "completed" },
    ])
    await transport.close()
  })

  test("renders failed projected shells as errors and marks truncated live output", async () => {
    const events = feed()
    events.push(connected())
    const client = sdk({
      streams: [events],
      messages: {
        ses_1: [
          {
            id: "msg_failed_shell",
            type: "shell" as const,
            shellID: "sh_failed",
            status: "exited",
            command: "false",
            exit: 7,
            output: { output: "failure output", cursor: 14, size: 14, truncated: false },
            time: { created: 1, completed: 2 },
          },
        ],
      },
    })
    const ui = footer()
    const transport = await createSessionTransport({
      sdk: client,
      sessionID: "ses_1",
      thinking: false,
      replay: true,
      footer: ui.api,
    })
    events.push({
      id: "evt_truncated_start",
      created: 0,
      type: "session.shell.started",
      durable: durable("ses_1"),
      data: {
        sessionID: "ses_1",
        shell: {
          id: "sh_truncated",
          status: "running",
          command: "long",
          cwd: "/tmp",
          shell: "/bin/sh",
          file: "/tmp/truncated",
          metadata: {},
          time: { started: 0 },
        },
      },
    })
    events.push({
      id: "evt_truncated_end",
      created: 0,
      type: "session.shell.ended",
      durable: durable("ses_1", 1),
      data: {
        sessionID: "ses_1",
        shell: {
          id: "sh_truncated",
          status: "exited",
          command: "long",
          cwd: "/tmp",
          shell: "/bin/sh",
          file: "/tmp/truncated",
          exit: 0,
          metadata: {},
          time: { started: 0, completed: 1 },
        },
        output: { output: "partial", cursor: 7, size: 20, truncated: false },
      },
    })
    await Bun.sleep(0)

    expect(ui.commits).toContainEqual(
      expect.objectContaining({ toolState: "error", toolError: "Shell exited with code 7" }),
    )
    expect(ui.commits).toContainEqual(expect.objectContaining({ text: "partial\n[output truncated]" }))
    await transport.close()
  })

  test("routes command prompts through v2.session.command", async () => {
    const events = feed()
    events.push(connected())
    const client = sdk({ streams: [events] })
    const ui = footer()
    const transport = await createSessionTransport({
      sdk: client,
      sessionID: "ses_1",
      thinking: false,
      footer: ui.api,
    })
    let request: Parameters<OpenCodeClient["session"]["command"]>[0] | undefined
    spyOn(client.session, "command").mockImplementation((input) => {
      request = input
      queueMicrotask(() => {
        events.push({
          id: "evt_prompted",
          created: 0,
          type: "session.inbox.delivered",
          durable: durable("ses_1"),
          data: {
            sessionID: "ses_1",
            inboxID: "msg_cmd",
          },
        })
        events.push({
          id: "evt_settled",
          created: 0,
          type: "session.execution.succeeded",
          durable: durable("ses_1"),
          data: { sessionID: "ses_1" },
        })
      })
      return ok(undefined)
    })

    await transport.runPromptTurn({
      agent: "build",
      model: { providerID: "test", modelID: "model" },
      variant: undefined,
      prompt: {
        messageID: "msg_cmd",
        text: "/deploy prod /api-design",
        parts: [
          {
            type: "file",
            url: "file:///tmp/mentioned.txt",
            filename: "mentioned.txt",
            source: { type: "file", text: { start: 8, end: 12, value: "prod" } },
          },
          {
            type: "skill",
            id: "api-design",
            source: { start: 13, end: 24, value: "/api-design" },
          },
        ],
        command: { name: "deploy", arguments: "prod" },
      },
      files: [{ type: "file", url: "file:///tmp/context.txt", filename: "context.txt", mime: "text/plain" }],
      includeFiles: true,
    })

    expect(request).toMatchObject({
      sessionID: "ses_1",
      command: "deploy",
      text: "prod",
      files: [
        { uri: "file:///tmp/context.txt", name: "context.txt" },
        {
          uri: "file:///tmp/mentioned.txt",
          name: "mentioned.txt",
          mention: { start: 8, end: 12, text: "prod" },
        },
      ],
      skills: [{ id: "api-design", mention: { start: 13, end: 24, text: "/api-design" } }],
      delivery: "steer",
    })
    expect(client.session.switchAgent).not.toHaveBeenCalled()
    expect(client.session.switchModel).not.toHaveBeenCalled()
    await transport.close()
  })

  test("routes skill prompts through v2.session.skill and settles without promotion", async () => {
    const events = feed()
    events.push(connected())
    const client = sdk({ streams: [events] })
    const ui = footer()
    const transport = await createSessionTransport({
      sdk: client,
      sessionID: "ses_1",
      thinking: false,
      footer: ui.api,
    })
    let request: Parameters<OpenCodeClient["session"]["skill"]>[0] | undefined
    const command = spyOn(client.session, "command")
    const prompt = spyOn(client.session, "prompt")
    spyOn(client.session, "skill").mockImplementation((input) => {
      request = input
      queueMicrotask(() => {
        events.push({
          id: "evt_skill",
          created: 0,
          type: "session.skill.activated",
          durable: durable("ses_1"),
          data: {
            sessionID: "ses_1",
            id: input.skill ?? "tigerstyle",
            name: input.skill ?? "tigerstyle",
            text: "skill instructions",
          },
        })
        events.push({
          id: "evt_settled",
          created: 0,
          type: "session.execution.succeeded",
          durable: durable("ses_1"),
          data: { sessionID: "ses_1" },
        })
      })
      return ok(undefined) as never
    })

    await transport.runPromptTurn({
      agent: "review",
      model: undefined,
      variant: undefined,
      prompt: {
        messageID: "msg_skill",
        text: "/tigerstyle",
        parts: [],
        command: { name: "tigerstyle", arguments: "", source: "skill" },
      },
      files: [],
      includeFiles: true,
    })

    expect(client.session.switchAgent).toHaveBeenCalledWith({ sessionID: "ses_1", agent: "review" }, expect.anything())
    expect(request).toMatchObject({ sessionID: "ses_1", id: "msg_skill", skill: "tigerstyle" })
    expect(command).not.toHaveBeenCalled()
    expect(prompt).not.toHaveBeenCalled()
    expect(ui.commits).toContainEqual(
      expect.objectContaining({ kind: "system", text: '→ Skill "tigerstyle"', messageID: "msg_skill" }),
    )
    await transport.close()
  })

  test("sends inline skill attachments with a normal prompt", async () => {
    const events = feed()
    events.push(connected())
    const client = sdk({ streams: [events] })
    const ui = footer()
    const transport = await createSessionTransport({
      sdk: client,
      sessionID: "ses_1",
      thinking: false,
      footer: ui.api,
    })
    let request: Parameters<OpenCodeClient["session"]["prompt"]>[0] | undefined
    spyOn(client.session, "prompt").mockImplementation((input) => {
      request = input
      queueMicrotask(() => {
        events.push({
          id: "evt_prompted",
          created: 0,
          type: "session.inbox.delivered",
          durable: durable("ses_1"),
          data: { sessionID: "ses_1", inboxID: "msg_skill_attachment" },
        })
        events.push({
          id: "evt_settled",
          created: 0,
          type: "session.execution.succeeded",
          durable: durable("ses_1"),
          data: { sessionID: "ses_1" },
        })
      })
      return ok({
        id: input.id ?? "msg_skill_attachment",
        sessionID: "ses_1",
        type: "user" as const,
        payload: { text: input.text },
        delivery: "steer" as const,
        timeCreated: 2,
      })
    })

    await transport.runPromptTurn({
      agent: undefined,
      model: undefined,
      variant: undefined,
      prompt: {
        messageID: "msg_skill_attachment",
        text: "Review this /api-design",
        parts: [
          {
            type: "skill",
            id: "api-design",
            source: { start: 12, end: 23, value: "/api-design" },
          },
        ],
      },
      files: [],
      includeFiles: false,
    })

    expect(request).toMatchObject({
      sessionID: "ses_1",
      id: "msg_skill_attachment",
      text: "Review this /api-design",
      skills: [{ id: "api-design", mention: { start: 12, end: 23, text: "/api-design" } }],
      delivery: "steer",
    })
    await transport.close()
  })

  test("refreshes catalogs on connection, location-scoped invalidations, and global credential switches", async () => {
    const events = feed()
    events.push(connected())
    const client = sdk({ streams: [events] })
    const ui = footer()
    let refreshes = 0
    const transport = await createSessionTransport({
      sdk: client,
      location: {
        directory: "/project",
        workspaceID: "work-1",
      },
      sessionID: "ses_1",
      thinking: false,
      footer: ui.api,
      onCatalogRefresh: () => refreshes++,
    })
    expect(refreshes).toBe(1)

    for (const type of [
      "catalog.updated",
      "integration.updated",
      "agent.updated",
      "command.updated",
      "skill.updated",
      "reference.updated",
    ] as const)
      events.push({
        id: `evt_${type}`,
        created: 0,
        type,
        location: { directory: "/project", workspaceID: "work-1" },
        data: {},
      })
    events.push({
      id: "evt_credential.updated",
      created: 0,
      type: "credential.updated",
      data: {},
    })
    for (const credentialID of ["credential", null])
      events.push({
        id: `evt_credential.switched.${credentialID}`,
        created: 0,
        type: "credential.switched",
        data: { credentialID, integrationID: "integration" },
      })
    events.push({
      id: "evt_foreign_catalog",
      created: 0,
      type: "catalog.updated",
      location: { directory: "/other" },
      data: {},
    })
    events.push({
      id: "evt_foreign_workspace_catalog",
      created: 0,
      type: "catalog.updated",
      location: { directory: "/project", workspaceID: "work-2" },
      data: {},
    })
    while (refreshes < 9) await Bun.sleep(0)
    await Bun.sleep(0)

    expect(refreshes).toBe(9)
    await transport.close()
  })

  test("hydrates skill activation messages once and dedupes live redelivery", async () => {
    const events = feed()
    events.push(connected())
    const client = sdk({
      streams: [events],
      messages: {
        ses_1: [
          {
            id: "msg_skill",
            type: "skill" as const,
            skill: "tigerstyle",
            name: "tigerstyle",
            text: "skill instructions",
            time: { created: 2 },
          },
        ],
      },
    })
    const ui = footer()
    const transport = await createSessionTransport({
      sdk: client,
      sessionID: "ses_1",
      thinking: false,
      replay: true,
      footer: ui.api,
    })
    events.push({
      id: "evt_skill",
      created: 0,
      type: "session.skill.activated",
      durable: durable("ses_1"),
      data: {
        sessionID: "ses_1",
        id: "tigerstyle",
        name: "tigerstyle",
        text: "skill instructions",
      },
    })
    await Bun.sleep(0)
    await Bun.sleep(0)

    expect(ui.commits.filter((item) => item.text === '→ Skill "tigerstyle"')).toHaveLength(1)
    await transport.close()
  })

  test("discovers a subagent from its terminal failure snapshot", async () => {
    const events = feed()
    events.push(connected())
    const client = sdk({ streams: [events], messages: { ses_child_failed: [] } })
    const ui = footer()
    const transport = await createSessionTransport({
      sdk: client,
      sessionID: "ses_1",
      thinking: false,
      footer: ui.api,
    })
    const states = () => ui.events.flatMap((event) => (event.type === "stream.subagent" ? [event.state] : []))
    events.push({
      id: "evt_failed_subagent_input",
      created: 1,
      type: "session.tool.input.started",
      durable: durable("ses_1"),
      data: {
        sessionID: "ses_1",
        assistantMessageID: "msg_failed_subagent",
        id: "call_failed_subagent",
        name: "subagent",
      },
    })
    events.push({
      id: "evt_failed_subagent_called",
      created: 2,
      type: "session.tool.called",
      durable: durable("ses_1", 1),
      data: {
        sessionID: "ses_1",
        assistantMessageID: "msg_failed_subagent",
        id: "call_failed_subagent",
        input: { agent: "explore", description: "Inspect failure", prompt: "inspect" },
        executed: true,
      },
    })
    events.push({
      id: "evt_failed_subagent",
      created: 3,
      type: "session.tool.failed",
      durable: durable("ses_1", 2, 2),
      data: {
        sessionID: "ses_1",
        assistantMessageID: "msg_failed_subagent",
        id: "call_failed_subagent",
        error: { type: "unknown", message: "subagent failed" },
        metadata: { sessionID: "ses_child_failed", status: "running" },
        executed: true,
      },
    })

    while (!states().some((state) => state.tabs.some((tab) => tab.sessionID === "ses_child_failed"))) await Bun.sleep(0)
    expect(states().at(-1)?.tabs).toMatchObject([
      {
        sessionID: "ses_child_failed",
        label: "Explore",
        description: "Inspect failure",
      },
    ])
    await transport.close()
  })

  test("discovers current subagents from progress and reduces descendant tool state", async () => {
    const events = feed()
    events.push(connected())
    const client = sdk({ streams: [events], messages: { ses_child_progress: [] } })
    const ui = footer()
    const transport = await createSessionTransport({
      sdk: client,
      sessionID: "ses_1",
      thinking: false,
      footer: ui.api,
    })
    const states = () => ui.events.flatMap((event) => (event.type === "stream.subagent" ? [event.state] : []))
    events.push({
      id: "evt_subagent_input",
      created: 1,
      type: "session.tool.input.started",
      durable: durable("ses_1"),
      data: {
        sessionID: "ses_1",
        assistantMessageID: "msg_subagent",
        id: "call_subagent",
        name: "subagent",
      },
    })
    events.push({
      id: "evt_subagent_called",
      created: 2,
      type: "session.tool.called",
      durable: durable("ses_1", 1),
      data: {
        sessionID: "ses_1",
        assistantMessageID: "msg_subagent",
        id: "call_subagent",
        input: { agent: "explore", description: "Inspect progress", prompt: "inspect" },
        executed: true,
      },
    })
    events.push({
      id: "evt_subagent_progress",
      created: 3,
      type: "session.tool.progress",
      data: {
        sessionID: "ses_1",
        assistantMessageID: "msg_subagent",
        id: "call_subagent",
        metadata: { sessionID: "ses_child_progress", status: "running" },
      },
    })
    while (!states().some((state) => state.tabs.some((tab) => tab.sessionID === "ses_child_progress")))
      await Bun.sleep(0)
    expect(states().at(-1)?.tabs).toMatchObject([
      {
        sessionID: "ses_child_progress",
        label: "Explore",
        description: "Inspect progress",
        status: "running",
        background: undefined,
      },
    ])

    transport.selectSubagent("ses_child_progress")
    while (!states().at(-1)?.details.ses_child_progress) await Bun.sleep(0)
    events.push({
      id: "evt_child_tool_input",
      created: 4,
      type: "session.tool.input.started",
      durable: durable("ses_child_progress"),
      data: {
        sessionID: "ses_child_progress",
        assistantMessageID: "msg_child_tool",
        id: "call_child_shell",
        name: "shell",
      },
    })
    events.push({
      id: "evt_child_tool_called",
      created: 5,
      type: "session.tool.called",
      durable: durable("ses_child_progress", 1),
      data: {
        sessionID: "ses_child_progress",
        assistantMessageID: "msg_child_tool",
        id: "call_child_shell",
        input: { command: "printf child && false" },
        executed: true,
      },
    })
    events.push({
      id: "evt_child_tool_progress",
      created: 6,
      type: "session.tool.progress",
      data: {
        sessionID: "ses_child_progress",
        assistantMessageID: "msg_child_tool",
        id: "call_child_shell",
        metadata: { checkpoint: "child" },
      },
    })
    events.push({
      id: "evt_child_permission",
      created: 7,
      type: "permission.asked",
      data: {
        id: "per_child",
        sessionID: "ses_child_progress",
        action: "shell",
        resources: ["printf child && false"],
        source: { type: "tool", messageID: "msg_child_tool", id: "call_child_shell" },
      },
    })
    events.push({
      id: "evt_child_tool_failed",
      created: 8,
      type: "session.tool.failed",
      durable: durable("ses_child_progress", 3, 2),
      data: {
        sessionID: "ses_child_progress",
        assistantMessageID: "msg_child_tool",
        id: "call_child_shell",
        error: { type: "unknown", message: "child boom" },
        metadata: { checkpoint: "child" },
        content: [
          { type: "text", text: "child partial" },
          { type: "file", mime: "image/png", uri: "data:image/png;base64,cG5n" },
        ],
        executed: true,
      },
    })
    while (
      !states()
        .at(-1)
        ?.details.ses_child_progress?.commits.some(
          (item) => item.part?.id === "call_child_shell" && item.toolState === "error",
        )
    )
      await Bun.sleep(0)

    const commits = states().at(-1)?.details.ses_child_progress?.commits ?? []
    expect(
      commits
        .filter((item) => item.part?.id === "call_child_shell")
        .map((item) => [item.phase, item.text, item.toolState]),
    ).toEqual([
      ["progress", "child partial", "running"],
      ["final", "child boom", "error"],
    ])
    expect(
      commits.find((item) => item.part?.id === "call_child_shell" && item.toolState === "error")?.part?.state,
    ).toMatchObject({
      status: "error",
      metadata: { checkpoint: "child" },
      content: [
        { type: "text", text: "child partial" },
        { type: "file", mime: "image/png", uri: "data:image/png;base64,cG5n" },
      ],
    })
    expect(commits.filter((commit) => commit.image)).toEqual([
      expect.objectContaining({
        kind: "tool",
        messageID: "msg_child_tool",
        image: "data:image/png;base64,cG5n",
        phase: "final",
      }),
    ])
    expect(
      ui.events.find(
        (event) =>
          event.type === "stream.view" && event.view.type === "permission" && event.view.request.id === "per_child",
      ),
    ).toMatchObject({
      view: {
        request: {
          sessionID: "ses_child_progress",
          tool: { id: "call_child_shell", state: { input: { command: "printf child && false" } } },
        },
      },
    })
    await transport.close()
  })

  test("discovers a live child session and tracks its tab and selected detail", async () => {
    const events = feed()
    events.push(connected())
    const client = sdk({
      streams: [events],
      messages: {
        ses_child: [
          {
            id: "msg_task",
            type: "user" as const,
            text: "task prompt",
            files: [],
            agents: [],
            time: { created: 1 },
          },
          {
            id: "msg_child_a",
            type: "assistant" as const,
            agent: "explore",
            model: { providerID: "test", id: "model" },
            content: [{ type: "text" as const, text: "child answer" }],
            time: { created: 2 },
          },
        ],
      },
    })
    spyOn(client.session, "get").mockImplementation(
      () =>
        ok({
          id: "ses_child",
          parentID: "ses_1",
          projectID: "proj_1",
          agent: "explore",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 1, updated: 1 },
          title: "Find files",
          location: { directory: "/tmp" },
        }) as never,
    )
    const ui = footer()
    const transport = await createSessionTransport({
      sdk: client,
      sessionID: "ses_1",
      thinking: false,
      footer: ui.api,
    })
    const states = () => ui.events.flatMap((event) => (event.type === "stream.subagent" ? [event.state] : []))
    transport.selectSubagent("ses_child")

    events.push({
      id: "evt_child_step",
      created: 0,
      type: "session.step.started",
      durable: durable("ses_child"),
      data: {
        sessionID: "ses_child",
        assistantMessageID: "msg_child_a",
        agent: "explore",
        model: { providerID: "test", id: "model" },
      },
    })
    while (!states().some((state) => state.details.ses_child?.commits.some((item) => item.text === "task prompt")))
      await Bun.sleep(0)
    expect(states().at(-1)?.tabs).toMatchObject([
      { sessionID: "ses_child", label: "Explore", title: "Find files", status: "running" },
    ])

    expect(
      states()
        .at(-1)
        ?.details.ses_child?.commits.filter((item) => item.text === "child answer"),
    ).toHaveLength(1)

    events.push({
      id: "evt_child_text_replayed",
      created: 0,
      type: "session.text.delta",
      data: {
        sessionID: "ses_child",
        assistantMessageID: "msg_child_a",
        ordinal: 0,
        delta: "answer",
      },
    })
    await Bun.sleep(0)
    expect(
      states()
        .at(-1)
        ?.details.ses_child?.commits.filter((item) => item.text === "child answer"),
    ).toHaveLength(1)

    events.push({
      id: "evt_child_text_suffix",
      created: 0,
      type: "session.text.delta",
      data: {
        sessionID: "ses_child",
        assistantMessageID: "msg_child_a",
        ordinal: 0,
        delta: " suffix",
      },
    })
    while (
      !states().some((state) => state.details.ses_child?.commits.some((item) => item.text === "child answer suffix"))
    )
      await Bun.sleep(0)

    events.push({
      id: "evt_child_settled",
      created: 0,
      type: "session.execution.succeeded",
      durable: durable("ses_child"),
      data: { sessionID: "ses_child" },
    })
    while (!states().some((state) => state.tabs.some((tab) => tab.status === "completed"))) await Bun.sleep(0)
    await transport.close()
  })

  test("reveals an admitted child prompt only when it is promoted after hydration", async () => {
    const events = feed()
    events.push(connected())
    const client = sdk({
      streams: [events],
      messages: { ses_child: [] },
      sessions: [{ id: "ses_child", parentID: "ses_1", time: { updated: 1 } }],
    })
    const ui = footer()
    const transport = await createSessionTransport({
      sdk: client,
      sessionID: "ses_1",
      thinking: false,
      footer: ui.api,
    })
    const states = () => ui.events.flatMap((event) => (event.type === "stream.subagent" ? [event.state] : []))
    transport.selectSubagent("ses_child")
    while (!states().some((state) => state.details.ses_child)) await Bun.sleep(0)

    events.push({
      id: "evt_child_admitted",
      created: 1,
      type: "session.inbox.enqueued",
      durable: durable("ses_child"),
      data: {
        sessionID: "ses_child",
        inboxID: "msg_child_prompt",
        item: { type: "user", payload: { text: "actual child prompt", files: [image] }, delivery: "steer" },
      },
    })
    await Bun.sleep(0)
    expect(
      states()
        .at(-1)
        ?.details.ses_child?.commits.some((item) => item.messageID === "msg_child_prompt"),
    ).toBe(false)

    events.push({
      id: "evt_child_promoted",
      created: 2,
      type: "session.inbox.delivered",
      durable: durable("ses_child", 1),
      data: { sessionID: "ses_child", inboxID: "msg_child_prompt" },
    })
    while (
      !states()
        .at(-1)
        ?.details.ses_child?.commits.some(
          (item) => item.messageID === "msg_child_prompt" && item.text === "actual child prompt",
        )
    )
      await Bun.sleep(0)

    expect(
      states()
        .at(-1)
        ?.details.ses_child?.commits.filter((commit) => commit.image),
    ).toEqual([
      expect.objectContaining({ kind: "user", messageID: "msg_child_prompt", image: "data:image/png;base64,cG5n" }),
    ])
    await transport.close()
  })

  test("hydrates child images and keeps pending attachments hidden until delivery", async () => {
    const events = feed()
    events.push(connected())
    const ui = footer()
    const transport = await createSessionTransport({
      sdk: sdk({
        streams: [events],
        sessions: [{ id: "ses_child", parentID: "ses_1", time: { updated: 1 } }],
        messages: {
          ses_child: [
            { id: "msg_old_image", type: "user", text: "", files: [image, image], time: { created: 1 } },
            {
              id: "msg_child_tool",
              type: "assistant",
              agent: "build",
              model: { providerID: "test", id: "model" },
              content: [
                canonicalToolPart("read", {
                  status: "completed",
                  input: {},
                  content: [{ type: "file", mime: "image/png", uri: "data:image/png;base64,cG5n" }],
                }),
              ],
              time: { created: 2 },
            },
          ],
        },
        pending: {
          ses_child: [
            {
              id: "msg_pending_image",
              sessionID: "ses_child",
              type: "user",
              payload: { text: "", files: [image] },
              delivery: "queue",
              timeCreated: 3,
            },
          ],
        },
      }),
      sessionID: "ses_1",
      thinking: false,
      footer: ui.api,
    })
    const images = () =>
      ui.events
        .flatMap((event) => (event.type === "stream.subagent" ? [event.state] : []))
        .at(-1)
        ?.details.ses_child?.commits.filter((commit) => commit.image) ?? []
    transport.selectSubagent("ses_child")
    while (images().length < 2) await Bun.sleep(0)
    expect(
      images()
        .map((commit) => commit.kind)
        .sort(),
    ).toEqual(["tool", "user"])
    expect(images().some((commit) => commit.messageID === "msg_pending_image")).toBe(false)
    const delivered: RunV2Event = {
      id: "evt_child_image_delivered",
      created: 3,
      type: "session.inbox.delivered",
      durable: durable("ses_child", 3),
      data: { sessionID: "ses_child", inboxID: "msg_pending_image" },
    }
    events.push(delivered)
    events.push(delivered)
    while (images().length < 3) await Bun.sleep(0)
    expect(images().filter((commit) => commit.messageID === "msg_pending_image")).toHaveLength(1)
    await transport.close()
  })

  test("preserves a pre-hydration admission promoted during stale hydration", async () => {
    const events = feed()
    events.push(connected())
    const client = sdk({
      streams: [events],
      sessions: [{ id: "ses_child", parentID: "ses_1", time: { updated: 1 } }],
    })
    let childHydrating = false
    let releaseHydration!: () => void
    const hydration = new Promise<void>((resolve) => {
      releaseHydration = resolve
    })
    spyOn(client.message, "list").mockImplementation(async (request) => {
      if (request.sessionID === "ses_child") {
        childHydrating = true
        await hydration
      }
      return ok({ data: [], cursor: {} })
    })
    const ui = footer()
    const transport = await createSessionTransport({
      sdk: client,
      sessionID: "ses_1",
      thinking: false,
      footer: ui.api,
    })
    const states = () => ui.events.flatMap((event) => (event.type === "stream.subagent" ? [event.state] : []))
    events.push({
      id: "evt_child_admitted_race",
      created: 1,
      type: "session.inbox.enqueued",
      durable: durable("ses_child"),
      data: {
        sessionID: "ses_child",
        inboxID: "msg_child_race",
        item: {
          type: "user",
          payload: { text: "prompt admitted before hydration", files: [image] },
          delivery: "steer",
        },
      },
    })
    await Bun.sleep(0)
    transport.selectSubagent("ses_child")
    while (!childHydrating) await Bun.sleep(0)
    events.push({
      id: "evt_child_promoted_race",
      created: 2,
      type: "session.inbox.delivered",
      durable: durable("ses_child", 1),
      data: { sessionID: "ses_child", inboxID: "msg_child_race" },
    })
    await Bun.sleep(0)
    releaseHydration()
    await Bun.sleep(0)
    await Bun.sleep(0)
    while (
      !states()
        .at(-1)
        ?.details.ses_child?.commits.some(
          (item) => item.messageID === "msg_child_race" && item.text === "prompt admitted before hydration",
        )
    )
      await Bun.sleep(0)

    expect(
      states()
        .at(-1)
        ?.details.ses_child?.commits.filter((commit) => commit.image),
    ).toEqual([
      expect.objectContaining({ kind: "user", messageID: "msg_child_race", image: "data:image/png;base64,cG5n" }),
    ])
    await transport.close()
  })

  test("retries child hydration after a bounded live-event overflow", async () => {
    const events = feed()
    events.push(connected())
    const client = sdk({
      streams: [events],
      sessions: [{ id: "ses_child", parentID: "ses_1", time: { updated: 1 } }],
    })
    let childRequests = 0
    let releaseStale!: () => void
    let releaseRetry!: () => void
    const stale = new Promise<void>((resolve) => {
      releaseStale = resolve
    })
    const retry = new Promise<void>((resolve) => {
      releaseRetry = resolve
    })
    spyOn(client.message, "list").mockImplementation(async (request) => {
      if (request.sessionID !== "ses_child") return ok({ data: [], cursor: {} })
      childRequests++
      if (childRequests === 1) {
        await stale
        return ok({ data: [], cursor: {} })
      }
      await retry
      return ok({
        data: [
          {
            id: "msg_overflow_assistant",
            type: "assistant" as const,
            agent: "explore",
            model: { providerID: "test", id: "model" },
            content: [{ type: "text" as const, id: "txt_overflow_64", text: "live 64" }],
            time: { created: 2, completed: 3 },
          },
          {
            id: "msg_overflow_baseline",
            type: "user" as const,
            text: "baseline history",
            files: [],
            agents: [],
            time: { created: 1 },
          },
        ],
        cursor: {},
      })
    })
    const ui = footer()
    const transport = await createSessionTransport({
      sdk: client,
      sessionID: "ses_1",
      thinking: false,
      footer: ui.api,
    })
    const states = () => ui.events.flatMap((event) => (event.type === "stream.subagent" ? [event.state] : []))
    transport.selectSubagent("ses_child")
    while (childRequests < 1) await Bun.sleep(0)

    for (let index = 0; index < 65; index++)
      events.push({
        id: `evt_overflow_${index}`,
        created: index,
        type: "session.text.delta",
        data: {
          sessionID: "ses_child",
          assistantMessageID: "msg_overflow_assistant",
          ordinal: index,
          delta: `live ${index}`,
        },
      })
    while (
      !states()
        .at(-1)
        ?.details.ses_child?.commits.some((item) => item.text === "live 64")
    )
      await Bun.sleep(0)
    releaseStale()
    while (childRequests < 2) await Bun.sleep(0)
    expect(
      states()
        .at(-1)
        ?.details.ses_child?.commits.some((item) => item.text === "live 64"),
    ).toBe(true)

    releaseRetry()
    while (
      !states()
        .at(-1)
        ?.details.ses_child?.commits.some((item) => item.text === "baseline history")
    )
      await Bun.sleep(0)
    expect(
      states()
        .at(-1)
        ?.details.ses_child?.commits.some((item) => item.text === "live 64"),
    ).toBe(true)
    expect(childRequests).toBe(2)
    await transport.close()
  })

  test("reconciles pre-hydration tool metadata without downgrading projected completion", async () => {
    const events = feed()
    events.push(connected())
    const client = sdk({
      streams: [events],
      sessions: [{ id: "ses_child", parentID: "ses_1", time: { updated: 1 } }],
    })
    let childHydrating = false
    let releaseHydration!: () => void
    const hydration = new Promise<void>((resolve) => {
      releaseHydration = resolve
    })
    spyOn(client.message, "list").mockImplementation(async (request) => {
      if (request.sessionID !== "ses_child") return ok({ data: [], cursor: {} })
      childHydrating = true
      await hydration
      return ok({
        data: [
          {
            id: "msg_tool_projected",
            type: "assistant" as const,
            agent: "explore",
            model: { providerID: "test", id: "model" },
            content: [
              {
                type: "tool" as const,
                id: "call_overlap",
                name: "shell",
                state: {
                  status: "completed" as const,
                  input: { command: "projected" },
                  content: [{ type: "text" as const, text: "projected result" }],
                  metadata: {},
                },
                time: { created: 1, ran: 1, completed: 2 },
              },
            ],
            time: { created: 1, completed: 2 },
          },
        ],
        cursor: {},
      })
    })
    const ui = footer()
    const transport = await createSessionTransport({
      sdk: client,
      sessionID: "ses_1",
      thinking: false,
      footer: ui.api,
    })
    const states = () => ui.events.flatMap((event) => (event.type === "stream.subagent" ? [event.state] : []))
    const inputStarted = (id: string, name: string, seq: number) =>
      events.push({
        id: `evt_started_${id}`,
        created: seq,
        type: "session.tool.input.started",
        durable: durable("ses_child", seq),
        data: { sessionID: "ses_child", assistantMessageID: "msg_tool_projected", id, name },
      })
    const called = (id: string, input: Record<string, unknown>, seq: number) =>
      events.push({
        id: `evt_called_${id}`,
        created: seq,
        type: "session.tool.called",
        durable: durable("ses_child", seq),
        data: {
          sessionID: "ses_child",
          assistantMessageID: "msg_tool_projected",
          id,
          input,
          executed: true,
        },
      })

    inputStarted("call_terminal", "grep", 0)
    called("call_terminal", { pattern: "needle" }, 1)
    await Bun.sleep(0)
    transport.selectSubagent("ses_child")
    while (!childHydrating) await Bun.sleep(0)
    events.push({
      id: "evt_success_terminal",
      created: 2,
      type: "session.tool.success",
      durable: durable("ses_child", 2, 2),
      data: {
        sessionID: "ses_child",
        assistantMessageID: "msg_tool_projected",
        id: "call_terminal",
        metadata: {},
        content: [{ type: "text", text: "found" }],
        executed: true,
      },
    })
    inputStarted("call_overlap", "shell", 3)
    called("call_overlap", { command: "stale" }, 4)
    await Bun.sleep(0)
    const beforeHydration = states().length
    releaseHydration()
    while (states().length === beforeHydration) await Bun.sleep(0)
    await Bun.sleep(0)

    const commits = states().at(-1)?.details.ses_child?.commits ?? []
    expect(commits.find((item) => item.partID === "prt_call_terminal")).toMatchObject({
      tool: "grep",
      toolState: "completed",
      part: { state: { input: { pattern: "needle" } } },
    })
    expect(commits.find((item) => item.partID === "prt_call_overlap")).toMatchObject({
      tool: "shell",
      toolState: "completed",
      part: { state: { input: { command: "projected" } } },
    })
    await transport.close()
  })

  test("keeps child terminal state observed during discovery", async () => {
    const events = feed()
    events.push(connected())
    const client = sdk({ streams: [events] })
    let resolveGet: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      resolveGet = resolve
    })
    spyOn(client.session, "get").mockImplementation(async () => {
      await gate
      return ok({
        id: "ses_child",
        parentID: "ses_1",
        projectID: "proj_1",
        agent: "explore",
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: 1, updated: 1 },
        title: "Find files",
        location: { directory: "/tmp" },
      }) as never
    })
    const ui = footer()
    const transport = await createSessionTransport({
      sdk: client,
      sessionID: "ses_1",
      thinking: false,
      footer: ui.api,
    })
    const states = () => ui.events.flatMap((event) => (event.type === "stream.subagent" ? [event.state] : []))

    // Both events arrive while session.get is still in flight.
    events.push({
      id: "evt_child_step",
      created: 0,
      type: "session.step.started",
      durable: durable("ses_child"),
      data: {
        sessionID: "ses_child",
        assistantMessageID: "msg_child_a",
        agent: "explore",
        model: { providerID: "test", id: "model" },
      },
    })
    events.push({
      id: "evt_child_settled",
      created: 0,
      type: "session.execution.interrupted",
      durable: durable("ses_child"),
      data: { sessionID: "ses_child", reason: "user" },
    })
    await Bun.sleep(0)
    resolveGet?.()
    while (!states().some((state) => state.tabs.some((tab) => tab.status === "cancelled"))) await Bun.sleep(0)
    await transport.close()
  })

  test("does not resurrect a settled child from stale discovery buffer", async () => {
    const events = feed()
    events.push(connected())
    const client = sdk({ streams: [events] })
    let resolveGet: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      resolveGet = resolve
    })
    spyOn(client.session, "get").mockImplementation(async () => {
      await gate
      return ok({
        id: "ses_child",
        parentID: "ses_1",
        projectID: "proj_1",
        agent: "explore",
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: 1, updated: 1 },
        title: "Find files",
        location: { directory: "/tmp" },
      }) as never
    })
    const ui = footer()
    const transport = await createSessionTransport({
      sdk: client,
      sessionID: "ses_1",
      thinking: false,
      footer: ui.api,
    })
    const states = () => ui.events.flatMap((event) => (event.type === "stream.subagent" ? [event.state] : []))

    // Child event arrives first and gets buffered behind the gated session.get.
    events.push({
      id: "evt_child_step",
      created: 0,
      type: "session.step.started",
      durable: durable("ses_child"),
      data: {
        sessionID: "ses_child",
        assistantMessageID: "msg_child_a",
        agent: "explore",
        model: { providerID: "test", id: "model" },
      },
    })
    // Parent's background subagent tool.success adopts the child mid-discovery.
    events.push({
      id: "evt_parent_input",
      created: 0,
      type: "session.tool.input.started",
      durable: durable("ses_1"),
      data: {
        sessionID: "ses_1",
        assistantMessageID: "msg_parent_a",
        id: "call_sub",
        name: "subagent",
      },
    })
    events.push({
      id: "evt_parent_call",
      created: 0,
      type: "session.tool.called",
      durable: durable("ses_1"),
      data: {
        sessionID: "ses_1",
        assistantMessageID: "msg_parent_a",
        id: "call_sub",
        input: { agent: "explore", description: "Find things", prompt: "go", background: true },
        executed: true,
      },
    })
    events.push({
      id: "evt_parent_success",
      created: 0,
      type: "session.tool.success",
      durable: durable("ses_1", 1, 2),
      data: {
        sessionID: "ses_1",
        assistantMessageID: "msg_parent_a",
        id: "call_sub",
        metadata: { sessionID: "ses_child", status: "running", output: "" },
        content: [{ type: "text", text: "" }],
        executed: true,
      },
    })
    // The settled event arrives after adoption, so it applies directly.
    events.push({
      id: "evt_child_settled",
      created: 0,
      type: "session.execution.interrupted",
      durable: durable("ses_child"),
      data: { sessionID: "ses_child", reason: "shutdown" },
    })
    while (!states().some((state) => state.tabs.some((tab) => tab.status === "cancelled"))) await Bun.sleep(0)

    // Resolving discovery must not replay the buffered step.started over the
    // terminal status.
    const before = states().length
    resolveGet?.()
    while (states().length === before) await Bun.sleep(0)
    await Bun.sleep(0)
    await Bun.sleep(0)
    expect(states().at(-1)?.tabs).toMatchObject([{ sessionID: "ses_child", status: "cancelled" }])
    await transport.close()
  })

  test("adopts historical children from the session family list", async () => {
    const events = feed()
    events.push(connected())
    const client = sdk({
      streams: [events],
      sessions: [
        { id: "ses_child_old", parentID: "ses_1", title: "Earlier subagent", agent: "explore", time: { updated: 9 } },
        { id: "ses_unrelated", title: "Different session", time: { updated: 5 } },
        { id: "ses_sibling", parentID: "ses_2", title: "Someone else's child", time: { updated: 4 } },
      ],
    })
    const ui = footer()
    const transport = await createSessionTransport({
      sdk: client,
      sessionID: "ses_1",
      thinking: false,
      footer: ui.api,
    })
    const states = ui.events.flatMap((event) => (event.type === "stream.subagent" ? [event.state] : []))
    expect(client.session.list).toHaveBeenCalledWith(
      { parentID: "ses_1", limit: 100, order: "desc" },
      { signal: expect.any(AbortSignal) },
    )
    expect(states.at(-1)?.tabs).toMatchObject([
      {
        sessionID: "ses_child_old",
        label: "Explore",
        title: "Earlier subagent",
        status: "completed",
      },
    ])
    await transport.close()
  })

  test("hydrates completed subagent children from projected tool output", async () => {
    const events = feed()
    events.push(connected())
    const client = sdk({
      streams: [events],
      messages: {
        ses_1: [
          {
            id: "msg_parent",
            type: "assistant" as const,
            agent: "build",
            model: { providerID: "test", id: "model" },
            time: { created: 1, completed: 3 },
            content: [
              {
                type: "tool" as const,
                id: "call_sub",
                name: "subagent",
                state: {
                  status: "completed" as const,
                  input: { agent: "explore", description: "Find things", prompt: "go" },
                  content: [{ type: "text" as const, text: "done" }],
                  metadata: { sessionID: "ses_child", status: "completed", output: "done" },
                },
                time: { created: 1, ran: 1, completed: 2 },
              },
            ],
          },
        ],
      },
    })
    const ui = footer()
    const transport = await createSessionTransport({
      sdk: client,
      sessionID: "ses_1",
      thinking: false,
      footer: ui.api,
    })
    const states = ui.events.flatMap((event) => (event.type === "stream.subagent" ? [event.state] : []))
    expect(states.at(-1)?.tabs).toMatchObject([
      {
        sessionID: "ses_child",
        label: "Explore",
        description: "Find things",
        status: "completed",
      },
    ])
    await transport.close()
  })
})
