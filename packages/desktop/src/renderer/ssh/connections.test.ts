import { expect, test } from "bun:test"
import { createSshConnections } from "./connections"
import type { SshItem } from "@opencode/app/ssh"

test("SSH progress stays reactive on the same connection until ready or stopped", () => {
  const connections = createSshConnections({ resolve: async () => null })
  const config = { id: "progress", target: "ssh devbox", name: "" }
  const stages: SshItem["stage"][] = ["connecting", "checking", "downloading", "uploading", "starting"]
  const first = connections({ servers: [{ config, saved: true, stage: "disconnected", detail: "" }] })[0]
  expect(first?.connecting).toBe(false)
  for (const stage of stages) {
    const next = connections({ servers: [{ config, saved: true, stage, detail: "" }] })[0]
    expect(next).toBe(first)
    expect(next?.connecting).toBe(true)
  }
  const settled: SshItem["stage"][] = ["ready", "authentication", "failed", "incompatible", "disconnected"]
  for (const stage of settled) {
    const next = connections({ servers: [{ config, saved: true, stage, detail: "" }] })[0]
    expect(next).toBe(first)
    expect(next?.connecting).toBe(false)
    expect(next?.authenticationRequired).toBe(stage === "authentication")
  }
})

test("progress and endpoint changes preserve the connection object used by routes", () => {
  const connections = createSshConnections({ resolve: async () => null })
  const config = { id: "fixture", target: "devbox", name: "Devbox" }
  const first = connections({ servers: [{ config, saved: true, stage: "disconnected", detail: "" }] })[0]
  const next = connections({
    servers: [
      { config, saved: true, stage: "ready", detail: "", http: { url: "http://127.0.0.1:12345", password: "secret" } },
    ],
  })[0]
  expect(next).toBe(first)
  expect(next?.http.url).toBe("http://127.0.0.1:12345")
  expect(connections({ servers: [] })).toEqual([])
})

test("authentication owned by another window is presented as pending", () => {
  const connections = createSshConnections({ resolve: async () => null })
  const config = { id: "fixture", target: "devbox", name: "Devbox" }
  const item = { config, saved: true, stage: "authentication" as const, detail: "", authenticatingElsewhere: true }
  const connection = connections({ servers: [item] })[0]
  expect(connection?.connecting).toBe(true)
  expect(connection?.authenticationRequired).toBe(false)
  expect(connections({ servers: [{ ...item, authenticatingElsewhere: false }] })[0]).toBe(connection)
  expect(connection?.connecting).toBe(false)
  expect(connection?.authenticationRequired).toBe(true)
})

test("existing unnamed connections show the hostname and preserve identity when renamed", () => {
  const connections = createSshConnections({ resolve: async () => null })
  const config = { id: "fixture", target: "ssh -p 2222 anomaly@brendan-box.exe.xyz", name: "" }
  const item = { config, saved: true, stage: "disconnected" as const, detail: "" }
  const first = connections({ servers: [item] })[0]
  expect(first?.host).toBe("brendan-box.exe.xyz")
  expect(first?.displayName).toBe("brendan-box.exe.xyz")
  const renamed = connections({ servers: [{ ...item, config: { ...config, name: "Development" } }] })[0]
  expect(renamed).toBe(first)
  expect(renamed?.displayName).toBe("Development")
  expect(renamed?.host).toBe("brendan-box.exe.xyz")
})

test("aborting reconnect does not wait for a pending IPC promise", async () => {
  const called = Promise.withResolvers<void>()
  const pending = Promise.withResolvers<null>()
  const connections = createSshConnections({
    resolve: () => {
      called.resolve()
      return pending.promise
    },
  })
  const connection = connections({
    servers: [
      { config: { id: "fixture", target: "devbox", name: "" }, saved: true, stage: "disconnected", detail: "" },
    ],
  })[0]
  if (!connection) throw new Error("missing connection")
  const abort = new AbortController()
  const reconnect = connection.reconnect(abort.signal)
  await called.promise
  abort.abort()
  await expect(reconnect).rejects.toThrow()
  pending.resolve(null)
})
