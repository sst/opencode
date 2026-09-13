import { expect, test } from "bun:test"
import type { SessionMessageInfo } from "@opencode/client/promise"
import { batch, createMemo, createRoot, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { ServerScope, SessionRouteKey, SessionStateKey } from "../src/runtime/server/scope"
import { createTimelineCache } from "../src/session/timeline/cache"

function setup() {
  return createRoot((dispose) => {
    const [state, setState] = createStore({
      id: "ses_a",
      directory: "/repo",
      visible: true,
      messages: {
        ses_a: [{ id: "msg_a", type: "user", text: "First session", time: { created: 1 } }],
        ses_b: [{ id: "msg_b", type: "user", text: "Second session", time: { created: 2 } }],
      } as Record<string, SessionMessageInfo[]>,
    })
    const views = new Map<
      string,
      { active: () => boolean; messages: () => SessionMessageInfo[]; element: HTMLDivElement }
    >()
    const disposed: string[] = []
    const cache = createTimelineCache(
      {
        identity: {
          params: {
            get id() {
              return state.id
            },
            serverKey: "local",
          },
          sessionID: () => state.id,
          workspaceKey: () => SessionStateKey.from(ServerScope.local, SessionRouteKey.fromRoute(state.directory)),
          sessionKey: () =>
            SessionStateKey.from(ServerScope.local, SessionRouteKey.fromRoute(state.directory, state.id)),
        },
        data: {
          info: createMemo(() => ({
            id: state.id,
            projectID: "project",
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            time: { created: 1, updated: 1 },
            location: { directory: state.directory },
          })),
          parent: () => undefined,
          parentID: () => undefined,
          status: () => ({ type: "idle" }),
        },
        history: { messages: () => state.messages[state.id] ?? [] },
      },
      (source, active) => {
        const id = source.identity.sessionID()!
        const element = document.createElement("div")
        createMemo(() =>
          element.setAttribute(
            "data-messages",
            source.history
              .messages()
              .map((message) => message.id)
              .join(","),
          ),
        )
        views.set(id, { active, messages: source.history.messages, element })
        onCleanup(() => disposed.push(id))
        return element
      },
      () => state.visible,
    )
    return { state, setState, cache, views, disposed, dispose }
  })
}

test("reuses a session view and refreshes its own history when selected again", () => {
  const input = setup()
  try {
    const first = input.cache()
    input.setState("id", "ses_b")
    const second = input.cache()
    expect(second).not.toBe(first)
    expect(input.views.get("ses_a")!.active()).toBe(false)
    expect(input.views.get("ses_a")!.element.dataset.messages).toBe("msg_a")
    expect(input.views.get("ses_b")!.element.dataset.messages).toBe("msg_b")

    input.setState("messages", "ses_a", [
      { id: "msg_c", type: "user", text: "Updated while inactive", time: { created: 3 } },
    ])
    input.setState("id", "ses_a")
    expect(input.cache()).toBe(first)
    expect(input.views.get("ses_a")!.active()).toBe(true)
    expect(input.views.get("ses_a")!.element.dataset.messages).toBe("msg_c")
    expect(input.views.get("ses_b")!.element.dataset.messages).toBe("msg_b")
    expect(input.disposed).toEqual([])
  } finally {
    input.dispose()
  }
  expect(input.disposed.sort()).toEqual(["ses_a", "ses_b"])
})

test("suspends a detached mobile view and reuses it when the conversation returns", () => {
  const input = setup()
  try {
    const first = input.cache()
    input.setState("visible", false)
    expect(input.views.get("ses_a")!.active()).toBe(false)
    input.setState("visible", true)
    expect(input.cache()).toBe(first)
    expect(input.views.get("ses_a")!.active()).toBe(true)
  } finally {
    input.dispose()
  }
})

test("disposes views whose Location-scoped providers no longer match", () => {
  const input = setup()
  try {
    const first = input.cache()
    input.setState("directory", "/other")
    expect(input.cache()).not.toBe(first)
    expect(input.disposed).toEqual(["ses_a"])
    input.setState("directory", "/repo")
    expect(input.cache()).not.toBe(first)
    expect(input.disposed).toEqual(["ses_a", "ses_a"])
  } finally {
    input.dispose()
  }
  expect(input.disposed).toHaveLength(3)
})

test("disposes views on workspace changes while the destination is not rendered", () => {
  const input = setup()
  try {
    const first = input.cache()
    input.setState("visible", false)
    input.setState("directory", "/other")
    expect(input.disposed).toEqual(["ses_a"])
    input.setState("directory", "/repo")
    input.setState("visible", true)
    expect(input.cache()).not.toBe(first)
  } finally {
    input.dispose()
  }
  expect(input.disposed).toEqual(["ses_a", "ses_a"])
})

for (const order of ["session-first", "workspace-first"] as const) {
  test(`keeps views live across five workspaces when updates are ${order}`, () => {
    const input = setup()
    const render = createRoot((dispose) => ({ selected: createMemo(input.cache), dispose }))
    const visited = ["ses_a"]
    try {
      ;["ses_b", "ses_c", "ses_d", "ses_e", "ses_a", "ses_c", "ses_b", "ses_e", "ses_d", "ses_a"].forEach(
        (id, index) => {
          batch(() => {
            if (order === "workspace-first") input.setState("directory", `/repo/${id}`)
            input.setState("id", id)
            if (order === "session-first") input.setState("directory", `/repo/${id}`)
          })
          expect(input.disposed).toEqual(visited)
          input.setState("messages", id, [
            { id: `msg_live_${index}`, type: "user", text: "Live update", time: { created: index + 3 } },
          ])
          expect((render.selected() as HTMLDivElement).dataset.messages).toBe(`msg_live_${index}`)
          expect(input.views.get(id)!.active()).toBe(true)
          visited.push(id)
        },
      )
    } finally {
      render.dispose()
      input.dispose()
    }
  })
}

test("evicts the least recently selected view and disposes all retained owners", () => {
  const input = setup()
  try {
    const first = input.cache()
    Array.from({ length: 15 }, (_, index) => `ses_${index}`).forEach((id) => {
      input.setState("id", id)
      input.cache()
    })
    input.setState("id", "ses_a")
    expect(input.cache()).toBe(first)
    input.setState("id", "ses_last")
    input.cache()
    expect(input.disposed).toEqual(["ses_0"])
    input.setState("id", "ses_0")
    input.cache()
    expect(input.disposed).toEqual(["ses_0", "ses_1"])
  } finally {
    input.dispose()
  }
  expect(input.disposed).toHaveLength(18)
})
