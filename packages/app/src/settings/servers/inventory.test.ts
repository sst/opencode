import { describe, expect, test } from "bun:test"
import { ServerConnection } from "@/runtime/server/registry"
import type { SshItem } from "@/servers/ssh/types"
import { settingsServers } from "./inventory"

const ssh: SshItem = {
  config: { id: "build", target: "dev@example.com", name: "Build server" },
  saved: true,
  stage: "disconnected",
  detail: "",
}
const connection: ServerConnection.Ssh = {
  type: "ssh",
  id: ssh.config.id,
  host: ssh.config.target,
  displayName: ssh.config.name,
  http: { url: "http://127.0.0.1:4000", password: "secret" },
}

describe("settings server inventory", () => {
  test("includes saved SSH servers before they connect", () => {
    expect(settingsServers([], [], [ssh])).toEqual([
      {
        key: ServerConnection.Key.make("ssh:build"),
        name: "Build server",
        ssh,
      },
    ])
  })

  test("joins ready SSH state to its live connection", () => {
    const ready = { ...ssh, stage: "ready" as const }
    expect(settingsServers([connection], [], [ready])).toEqual([
      {
        key: ServerConnection.Key.make("ssh:build"),
        name: "Build server",
        connection,
        ssh: ready,
        wsl: undefined,
      },
    ])
  })

  test("omits unsaved SSH state and withholds stale connections while disconnected", () => {
    expect(settingsServers([], [], [{ ...ssh, saved: false }])).toEqual([])
    expect(settingsServers([connection], [], [ssh])[0].connection).toBeUndefined()
  })
})
