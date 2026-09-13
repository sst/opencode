import { describe, expect, test } from "bun:test"
import { runPromptQueue } from "@/cli/cmd/run/runtime.queue"
import type { FooterApi, FooterEvent, RunPrompt, StreamCommit } from "@/cli/cmd/run/types"

function footer() {
  const prompts = new Set<(input: RunPrompt) => void>()
  const queuedRemoves = new Set<(messageID: string) => void>()
  const closes = new Set<() => void>()
  const events: FooterEvent[] = []
  const commits: StreamCommit[] = []
  let closed = false

  const api: FooterApi = {
    get isClosed() {
      return closed
    },
    onPrompt(fn) {
      prompts.add(fn)
      return () => {
        prompts.delete(fn)
      }
    },
    onQueuedRemove(fn) {
      queuedRemoves.add(fn)
      return () => {
        queuedRemoves.delete(fn)
      }
    },
    onClose(fn) {
      if (closed) {
        fn()
        return () => {}
      }

      closes.add(fn)
      return () => {
        closes.delete(fn)
      }
    },
    event(next) {
      events.push(next)
    },
    append(next) {
      commits.push(next)
    },
    idle() {
      return Promise.resolve()
    },
    close() {
      if (closed) {
        return
      }

      closed = true
      for (const fn of [...closes]) {
        fn()
      }
    },
    destroy() {
      api.close()
      prompts.clear()
      closes.clear()
    },
  }

  return {
    api,
    events,
    commits,
    submit(text: string, mode?: RunPrompt["mode"]) {
      const next = mode ? { text, parts: [] as RunPrompt["parts"], mode } : { text, parts: [] as RunPrompt["parts"] }
      for (const fn of [...prompts]) {
        fn(next)
      }
    },
    removeQueued(messageID: string) {
      for (const fn of [...queuedRemoves]) fn(messageID)
    },
    submitPrompt(prompt: RunPrompt) {
      for (const fn of [...prompts]) {
        fn(prompt)
      }
    },
  }
}

describe("run runtime queue", () => {
  test("ignores empty prompts", async () => {
    const ui = footer()
    let calls = 0

    const task = runPromptQueue({
      footer: ui.api,
      run: async () => {
        calls += 1
      },
    })

    ui.submit("   ")
    ui.api.close()
    await task

    expect(calls).toBe(0)
  })

  test("treats /exit as a close command", async () => {
    const ui = footer()
    let calls = 0

    const task = runPromptQueue({
      footer: ui.api,
      run: async () => {
        calls += 1
      },
    })

    ui.submit("/exit")
    await task

    expect(calls).toBe(0)
  })

  test("treats /new as a local session command", async () => {
    const ui = footer()
    const seen: string[] = []
    let created = 0

    const task = runPromptQueue({
      footer: ui.api,
      onNewSession: async () => {
        created += 1
      },
      run: async (input) => {
        seen.push(input.text)
        ui.api.close()
      },
    })

    ui.submit("/new")
    ui.submit("hello")
    await task

    expect(created).toBe(1)
    expect(seen).toEqual(["hello"])
    expect(ui.commits).toEqual([
      {
        kind: "user",
        text: "hello",
        phase: "start",
        source: "system",
        messageID: expect.any(String),
      },
    ])
  })

  test("shell mode submits /exit as a shell command", async () => {
    const ui = footer()
    const seen: RunPrompt[] = []

    const task = runPromptQueue({
      footer: ui.api,
      run: async (input) => {
        seen.push(input)
        ui.api.close()
      },
    })

    ui.submit("/exit", "shell")
    await task

    expect(seen).toEqual([{ text: "/exit", parts: [], mode: "shell" }])
    expect(ui.commits).toEqual([])
  })

  test("shell mode submits /new instead of creating a session", async () => {
    const ui = footer()
    const seen: RunPrompt[] = []
    let created = 0

    const task = runPromptQueue({
      footer: ui.api,
      onNewSession: async () => {
        created += 1
      },
      run: async (input) => {
        seen.push(input)
        ui.api.close()
      },
    })

    ui.submit("/new", "shell")
    await task

    expect(created).toBe(0)
    expect(seen).toEqual([{ text: "/new", parts: [], mode: "shell" }])
    expect(ui.commits).toEqual([])
  })

  test("shell mode does not append a synthetic user row", async () => {
    const ui = footer()

    const task = runPromptQueue({
      footer: ui.api,
      run: async () => {
        expect(ui.commits).toEqual([])
        ui.api.close()
      },
    })

    ui.submit("ls", "shell")
    await task
  })

  test("shell mode does not emit a turn duration summary", async () => {
    const ui = footer()

    const task = runPromptQueue({
      footer: ui.api,
      run: async () => {
        ui.api.close()
      },
    })

    ui.submit("ls", "shell")
    await task

    expect(ui.events.some((event) => event.type === "turn.duration")).toBe(false)
  })

  test("preserves whitespace for initial input", async () => {
    const ui = footer()
    const seen: string[] = []

    await runPromptQueue({
      footer: ui.api,
      initialInput: "  hello  ",
      run: async (input) => {
        seen.push(input.text)
        ui.api.close()
      },
    })

    expect(seen).toEqual(["  hello  "])
    expect(ui.commits).toEqual([
      {
        kind: "user",
        text: "  hello  ",
        phase: "start",
        source: "system",
        messageID: expect.any(String),
      },
    ])
  })

  test("passes prompts to onSend", async () => {
    const ui = footer()
    const seen: string[] = []

    await runPromptQueue({
      footer: ui.api,
      initialInput: "  hello  ",
      onSend: (input) => {
        seen.push(input.text)
      },
      run: async () => {
        ui.api.close()
      },
    })

    expect(seen).toEqual(["  hello  "])
  })

  test("marks queue-minted message IDs as local and preserves caller IDs", async () => {
    const ui = footer()
    const seen: RunPrompt[] = []
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })

    const task = runPromptQueue({
      footer: ui.api,
      initialInput: "generated",
      run: async (input) => {
        seen.push(input)
        if (seen.length === 1) {
          await gate
          return
        }

        ui.api.close()
      },
    })

    await Promise.resolve()
    ui.submitPrompt({ messageID: "msg-explicit", text: "explicit", parts: [] })
    release()
    await task

    expect(seen[0]).toEqual(
      expect.objectContaining({
        messageID: expect.any(String),
        localMessageID: true,
      }),
    )
    expect(seen[1]).toEqual(
      expect.objectContaining({
        messageID: "msg-explicit",
        localMessageID: undefined,
      }),
    )
  })

  test("appends the user row before the turn starts", async () => {
    const ui = footer()

    await runPromptQueue({
      footer: ui.api,
      initialInput: "/fmt bash",
      run: async () => {
        expect(ui.commits).toEqual([
          {
            kind: "user",
            text: "/fmt bash",
            phase: "start",
            source: "system",
            messageID: expect.any(String),
          },
        ])
        ui.api.close()
      },
    })
  })

  test("runs queued prompts in order", async () => {
    const ui = footer()
    const seen: string[] = []
    let wake: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      wake = resolve
    })

    const task = runPromptQueue({
      footer: ui.api,
      run: async (input) => {
        seen.push(input.text)
        if (seen.length === 1) {
          await gate
          return
        }

        ui.api.close()
      },
    })

    ui.submit("one")
    ui.submit("two")
    await Promise.resolve()
    expect(seen).toEqual(["one"])

    wake?.()
    await task

    expect(seen).toEqual(["one", "two"])
  })

  test("exposes ordinary in-flight prompts for removal before sending", async () => {
    const ui = footer()
    const turns: RunPrompt[] = []
    let wake: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      wake = resolve
    })

    const task = runPromptQueue({
      footer: ui.api,
      run: async (input) => {
        turns.push(input)
        await gate
      },
    })

    ui.submit("one")
    ui.submit("two")
    await Promise.resolve()
    await Promise.resolve()

    expect(turns.map((item) => item.text)).toEqual(["one"])
    expect(turns[0]?.messageID).toEqual(expect.any(String))
    expect(ui.commits.map((item) => item.text)).toEqual(["one"])
    const first = ui.events.find((item) => item.type === "queued.prompts")
    const event = ui.events.findLast((item) => item.type === "queued.prompts")
    expect(first?.type === "queued.prompts" ? first.prompts : []).toEqual([])
    expect(
      first?.type === "queued.prompts" && event?.type === "queued.prompts" ? first.prompts === event.prompts : true,
    ).toBe(false)
    expect(ui.events.findLast((item) => item.type === "queue")).toEqual({ type: "queue", queue: 1 })
    expect(event?.type === "queued.prompts" ? event.prompts.map((item) => item.prompt.text) : []).toEqual(["two"])
    if (event?.type === "queued.prompts") ui.removeQueued(event.prompts[0]!.messageID)
    await Promise.resolve()

    wake?.()
    ui.api.close()
    await task
    expect(turns.map((item) => item.text)).toEqual(["one"])
  })

  test("removing one managed queued prompt preserves the others", async () => {
    const ui = footer()
    const turns: string[] = []
    let wake: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      wake = resolve
    })

    const task = runPromptQueue({
      footer: ui.api,
      run: async (input) => {
        turns.push(input.text)
        if (input.text === "active") await gate
        if (input.text === "queued three") ui.api.close()
      },
    })

    ui.submit("active")
    ui.submit("queued one")
    ui.submit("queued two")
    ui.submit("queued three")
    await Promise.resolve()
    await Promise.resolve()

    const event = ui.events.findLast((item) => item.type === "queued.prompts")
    if (event?.type === "queued.prompts") {
      const second = event.prompts.find((item) => item.prompt.text === "queued two")
      if (second) ui.removeQueued(second.messageID)
    }

    wake?.()
    await task
    expect(turns).toEqual(["active", "queued one", "queued three"])
  })

  test("drains a prompt queued during an in-flight turn", async () => {
    const ui = footer()
    const seen: string[] = []
    let wake: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      wake = resolve
    })

    const task = runPromptQueue({
      footer: ui.api,
      run: async (input) => {
        seen.push(input.text)
        if (seen.length === 1) {
          await gate
          return
        }

        ui.api.close()
      },
    })

    ui.submit("one")
    await Promise.resolve()
    expect(seen).toEqual(["one"])

    wake?.()
    await Promise.resolve()
    ui.submit("two")
    await task

    expect(seen).toEqual(["one", "two"])
  })

  test("close aborts the active run and drops pending queued work", async () => {
    const ui = footer()
    const seen: string[] = []
    let hit = false

    const task = runPromptQueue({
      footer: ui.api,
      run: async (input, signal) => {
        seen.push(input.text)
        await new Promise<void>((resolve) => {
          if (signal.aborted) {
            hit = true
            resolve()
            return
          }

          signal.addEventListener(
            "abort",
            () => {
              hit = true
              resolve()
            },
            { once: true },
          )
        })
      },
    })

    ui.submit("one")
    await Promise.resolve()
    ui.submit("two")
    ui.api.close()
    await task

    expect(hit).toBe(true)
    expect(seen).toEqual(["one"])
  })

  test("propagates run errors", async () => {
    const ui = footer()

    const task = runPromptQueue({
      footer: ui.api,
      run: async () => {
        throw new Error("boom")
      },
    })

    ui.submit("one")
    await expect(task).rejects.toThrow("boom")
  })
})
