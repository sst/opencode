import { expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createStore } from "solid-js/store"
import { createSshRestore } from "../src/servers/ssh/restore-state"
import type { SshItem, SshStart, SshState } from "../src/servers/ssh/types"

const server = (id: string, stage: SshItem["stage"] = "disconnected", saved = true): SshItem => ({
  config: { id, target: `ssh ${id}`, name: "" },
  saved,
  stage,
  detail: "",
})

test("restores every saved server after loading without tabs or a default server", () => {
  const starts: SshStart[] = []
  const fixture = createRoot((dispose) => {
    const [state, setState] = createStore<{ current?: SshState }>({})
    createSshRestore({
      state: () => state.current,
      start: (input) => {
        starts.push(input)
        return Promise.resolve()
      },
    })
    return { dispose, setState }
  })
  try {
    expect(starts).toEqual([])
    fixture.setState("current", {
      servers: [server("devbox"), server("buildbox"), server("draft", "disconnected", false)],
    })
    expect(starts).toEqual([
      { ...server("devbox").config, background: true },
      { ...server("buildbox").config, background: true },
    ])
    fixture.setState("current", "servers", 0, "stage", "connecting")
    fixture.setState("current", "servers", 0, "stage", "disconnected")
    expect(starts).toHaveLength(2)
  } finally {
    fixture.dispose()
  }
})

test("does not restart active connections or authentication prompts after state updates", () => {
  const starts: SshStart[] = []
  const fixture = createRoot((dispose) => {
    const [state, setState] = createStore<SshState>({
      servers: [server("ready", "ready"), server("busy", "connecting"), server("prompt", "authentication")],
    })
    createSshRestore({
      state: () => state,
      start: (input) => {
        starts.push(input)
        return Promise.resolve()
      },
    })
    return { dispose, setState }
  })
  try {
    expect(starts).toEqual([])
    fixture.setState("servers", 0, "stage", "disconnected")
    fixture.setState("servers", 1, "stage", "failed")
    fixture.setState("servers", 2, "stage", "disconnected")
    expect(starts).toEqual([])
  } finally {
    fixture.dispose()
  }
})
