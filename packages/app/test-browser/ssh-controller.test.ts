import { expect, test } from "bun:test"
import { createEffect, createRoot } from "solid-js"
import { createStore } from "solid-js/store"
import { createSshController } from "../src/servers/ssh/controller"
import type { SshItem } from "../src/servers/ssh/types"

function fixture() {
  return createRoot((dispose) => {
    const config = { id: "host", target: "ssh linuxbook", name: "" }
    const [state, setState] = createStore<{ items: SshItem[]; busy: boolean }>({
      items: [{ config, stage: "disconnected", saved: true, detail: "" }],
      busy: false,
    })
    const calls = { starts: 0, responses: 0, cancels: 0, forgets: 0, prompts: 0, errors: 0, connected: 0 }
    const admission = Promise.withResolvers<void>()
    const refresh = Promise.withResolvers<void>()
    const response = Promise.withResolvers<void>()
    const cancelled = Promise.withResolvers<void>()
    const ssh = createSshController({
      items: () => state.items,
      api: {
        start: () => {
          calls.starts++
          return admission.promise
        },
        respond: () => {
          calls.responses++
          return calls.responses === 1 ? response.promise : Promise.resolve()
        },
        cancel: async () => {
          calls.cancels++
          setState("items", 0, { stage: "disconnected", prompt: undefined })
          cancelled.resolve()
        },
        forget: async () => {
          calls.forgets++
          setState("items", [])
        },
        disconnect: async () => {},
      },
      refresh: () => refresh.promise,
      error: () => calls.errors++,
    })
    createEffect(() => {
      const item = ssh.dialog.next()
      if (!item || state.busy) return
      ssh.dialog.opened(item.config.id)
      calls.prompts++
    })
    const admitted = async () => {
      admission.resolve()
      refresh.resolve()
      await refresh.promise
      await Promise.resolve()
      await Promise.resolve()
    }
    return { dispose, config, setState, calls, admission, refresh, response, cancelled, admitted, ssh }
  })
}

test("key-based reconnect stays pending through admission and refetch without opening a dialog", async () => {
  const app = fixture()
  try {
    app.ssh.connect(app.config, { onConnected: () => app.calls.connected++ })
    app.ssh.connect(app.config)
    expect(app.ssh.pending("host")).toBe(true)
    app.admission.resolve()
    await app.admission.promise
    await Promise.resolve()
    expect(app.ssh.pending("host")).toBe(true)
    expect(app.calls.starts).toBe(1)
    app.setState("items", 0, "stage", "connecting")
    await app.admitted()
    expect(app.ssh.pending("host")).toBe(true)
    expect(app.calls.prompts).toBe(0)
    app.setState("items", 0, "stage", "ready")
    await Promise.resolve()
    expect(app.ssh.pending("host")).toBe(false)
    expect(app.calls.connected).toBe(1)
  } finally {
    app.dispose()
  }
})

test("reconnect waits for an available dialog and opens only once across SSH challenges", async () => {
  const app = fixture()
  try {
    app.setState("busy", true)
    app.ssh.connect(app.config)
    app.setState("items", 0, { stage: "authentication", prompt: { id: "password", text: "Password:", confirm: false } })
    await app.admitted()
    expect(app.calls.prompts).toBe(0)
    app.setState("busy", false)
    expect(app.calls.prompts).toBe(1)
    app.setState("items", 0, "prompt", { id: "otp", text: "Code:", confirm: false })
    expect(app.calls.prompts).toBe(1)
    expect(app.calls.starts).toBe(1)
  } finally {
    app.dispose()
  }
})

test("a connection form owns its challenges and reports request failures inline", async () => {
  const app = fixture()
  try {
    app.ssh.connect(app.config, { dialog: true })
    app.admission.reject(new Error("IPC unavailable"))
    await app.admission.promise.catch(() => {})
    await Promise.resolve()
    expect(app.ssh.error("host")).toBe(true)
    expect(app.ssh.submitting("host")).toBe(false)
    expect(app.calls.errors).toBe(0)
    expect(app.calls.prompts).toBe(0)
  } finally {
    app.dispose()
  }
})

test("responding suppresses duplicate submissions while allowing the next SSH challenge", async () => {
  const app = fixture()
  try {
    app.ssh.connect(app.config)
    app.setState("items", 0, { stage: "authentication", prompt: { id: "password", text: "Password:", confirm: false } })
    await app.admitted()
    app.ssh.respond("host", "expired", "ignored")
    app.ssh.respond("host", "password", "secret")
    app.ssh.respond("host", "password", "secret")
    expect(app.calls.responses).toBe(1)
    expect(app.ssh.submitting("host")).toBe(true)
    app.response.resolve()
    await app.response.promise
    await Promise.resolve()
    expect(app.ssh.answered("host")).toBe(true)
    app.ssh.respond("host", "password", "secret")
    expect(app.calls.responses).toBe(1)
    app.setState("items", 0, "prompt", { id: "otp", text: "Code:", confirm: false })
    expect(app.ssh.answered("host")).toBe(false)
    app.ssh.respond("host", "otp", "123456")
    expect(app.calls.responses).toBe(2)
  } finally {
    app.dispose()
  }
})

test("failed reconnect becomes retryable without opening a connection form", async () => {
  const app = fixture()
  try {
    app.ssh.connect(app.config)
    app.setState("items", 0, "stage", "connecting")
    await app.admitted()
    app.setState("items", 0, "stage", "failed")
    expect(app.ssh.pending("host")).toBe(false)
    expect(app.calls.prompts).toBe(0)
    app.ssh.connect(app.config)
    expect(app.calls.starts).toBe(2)
  } finally {
    app.dispose()
  }
})

test("a failed response can be retried without losing the reconnect continuation", async () => {
  const app = fixture()
  try {
    app.ssh.connect(app.config, { onConnected: () => app.calls.connected++ })
    app.setState("items", 0, { stage: "authentication", prompt: { id: "password", text: "Password:", confirm: false } })
    await app.admitted()
    app.ssh.respond("host", "password", "secret")
    app.response.reject(new Error("IPC unavailable"))
    await app.response.promise.catch(() => {})
    await Promise.resolve()
    expect(app.ssh.error("host")).toBe(true)
    expect(app.ssh.answered("host")).toBe(false)
    expect(app.calls.errors).toBe(0)
    app.ssh.respond("host", "password", "secret")
    await Promise.resolve()
    expect(app.calls.responses).toBe(2)
    expect(app.ssh.error("host")).toBe(false)
    app.setState("items", 0, "stage", "ready")
    await Promise.resolve()
    expect(app.calls.connected).toBe(1)
  } finally {
    app.dispose()
  }
})

test("cancelling a version-mismatch dialog allows another reconnect", async () => {
  const app = fixture()
  try {
    app.ssh.connect(app.config)
    app.setState("items", 0, "stage", "incompatible")
    await app.admitted()
    expect(app.calls.prompts).toBe(1)
    app.ssh.cancel("host")
    await app.cancelled.promise
    app.ssh.connect(app.config)
    app.setState("items", 0, "stage", "incompatible")
    await app.admitted()
    expect(app.calls.starts).toBe(2)
    expect(app.calls.prompts).toBe(2)
    expect(app.calls.forgets).toBe(0)
  } finally {
    app.dispose()
  }
})

test("updating from the authentication dialog preserves the continuation and invokes it once", async () => {
  const app = fixture()
  try {
    app.ssh.connect(app.config, { onConnected: () => app.calls.connected++ })
    app.setState("items", 0, "stage", "incompatible")
    await app.admitted()
    app.ssh.connect(app.config, { dialog: true, replace: true })
    app.setState("items", 0, "stage", "connecting")
    await app.admitted()
    app.setState("items", 0, "stage", "ready")
    await Promise.resolve()
    app.setState("items", 0, "detail", "updated")
    await Promise.resolve()
    expect(app.calls.connected).toBe(1)
    expect(app.calls.prompts).toBe(1)
  } finally {
    app.dispose()
  }
})

test("cancelling an unsaved connection interrupts admission and forgets it", async () => {
  const app = fixture()
  try {
    app.setState("items", 0, "saved", false)
    app.ssh.connect(app.config, { dialog: true })
    app.ssh.cancel("host")
    await app.cancelled.promise
    await Promise.resolve()
    expect(app.calls.cancels).toBe(1)
    expect(app.calls.forgets).toBe(1)
    expect(app.ssh.item("host")).toBeUndefined()
    expect(app.ssh.submitting("host")).toBe(false)
    app.admission.resolve()
  } finally {
    app.dispose()
  }
})

test("another window's authentication stays pending without starting a competing attempt", () => {
  const app = fixture()
  try {
    app.setState("items", 0, { stage: "authentication", authenticatingElsewhere: true })
    app.ssh.connect(app.config)
    expect(app.ssh.pending("host")).toBe(true)
    expect(app.calls.starts).toBe(0)
    app.setState("items", 0, "authenticatingElsewhere", false)
    app.ssh.connect(app.config)
    expect(app.calls.starts).toBe(1)
  } finally {
    app.dispose()
  }
})
