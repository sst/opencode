import { expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createStore } from "solid-js/store"
import { createSshAuthentication } from "../src/servers/ssh/authentication-state"
import type { SshItem } from "../src/servers/ssh/types"

test("background authentication stays quiet; selecting a tab prompts once and cancellation is respected", () => {
  const opened: string[] = []
  const fixture = createRoot((dispose) => {
    const [state, setState] = createStore<{ selection?: string; busy: boolean; item: SshItem }>({
      busy: false,
      item: { config: { id: "host", target: "linuxbook", name: "" }, stage: "authentication", saved: true, detail: "" },
    })
    createSshAuthentication({
      selection: () => state.selection,
      item: () => state.item,
      busy: () => state.busy,
      open: (item) => {
        opened.push(item.config.id)
        setState("busy", true)
      },
    })
    return { dispose, setState }
  })
  try {
    expect(opened).toEqual([])
    fixture.setState("selection", "session-1")
    expect(opened).toEqual(["host"])
    fixture.setState("busy", false)
    fixture.setState("item", "detail", "new status")
    expect(opened).toHaveLength(1)
    fixture.setState("selection", undefined)
    fixture.setState("selection", "session-1")
    expect(opened).toHaveLength(2)
  } finally {
    fixture.dispose()
  }
})

test("a selected tab waits for authentication and other dialogs before offering a prompt", () => {
  const opened: string[] = []
  const fixture = createRoot((dispose) => {
    const [state, setState] = createStore<{ busy: boolean; item: SshItem }>({
      busy: true,
      item: { config: { id: "host", target: "linuxbook", name: "" }, stage: "connecting", saved: true, detail: "" },
    })
    createSshAuthentication({
      selection: () => "draft-1",
      item: () => state.item,
      busy: () => state.busy,
      open: (item) => {
        opened.push(item.config.id)
      },
    })
    return { dispose, setState }
  })
  try {
    expect(opened).toEqual([])
    fixture.setState("item", "stage", "authentication")
    expect(opened).toEqual([])
    fixture.setState("busy", false)
    expect(opened).toEqual(["host"])
    fixture.setState("item", "stage", "connecting")
    fixture.setState("item", "stage", "authentication")
    expect(opened).toHaveLength(1)
  } finally {
    fixture.dispose()
  }
})

test("selecting a tab waits for another window to release authentication", () => {
  const opened: string[] = []
  const fixture = createRoot((dispose) => {
    const [state, setState] = createStore<{ item: SshItem }>({
      item: {
        config: { id: "host", target: "linuxbook", name: "" },
        stage: "authentication",
        authenticatingElsewhere: true,
        saved: true,
        detail: "",
      },
    })
    createSshAuthentication({
      selection: () => "session-1",
      item: () => state.item,
      busy: () => false,
      open: (item) => opened.push(item.config.id),
    })
    return { dispose, setState }
  })
  try {
    expect(opened).toEqual([])
    fixture.setState("item", "detail", "still waiting in another window")
    expect(opened).toEqual([])
    fixture.setState("item", "authenticatingElsewhere", false)
    expect(opened).toEqual(["host"])
  } finally {
    fixture.dispose()
  }
})
