import { describe, expect, test } from "bun:test"
import { createWindowRegistry } from "./registry"

function setup(initial: unknown = []) {
  const state = { stored: initial }
  const registry = createWindowRegistry<{ name: string }>({
    read: () => state.stored,
    write: (ids) => {
      state.stored = ids
    },
  })
  return { registry, state }
}

describe("window registry", () => {
  test("restores persisted ids and ignores malformed entries", () => {
    expect(setup(["a", "", 42, "b"]).registry.persisted()).toEqual(["a", "b"])
    expect(setup("junk").registry.persisted()).toEqual([])
    expect(setup(undefined).registry.persisted()).toEqual([])
  })

  test("registers windows and persists each id once", () => {
    const app = setup()
    app.registry.register("a", { name: "a" })
    app.registry.register("a", { name: "a" })
    app.registry.register("b", { name: "b" })
    expect(app.state.stored).toEqual(["a", "b"])
    expect(app.registry.get("a")).toEqual({ name: "a" })
    expect(app.registry.get("missing")).toBeUndefined()
  })

  test("forgets a deliberately closed window while others remain open", () => {
    const app = setup()
    app.registry.register("a", { name: "a" })
    app.registry.register("b", { name: "b" })
    expect(app.registry.closed("a")).toBe(true)
    expect(app.state.stored).toEqual(["b"])
  })

  test("keeps the id when the last window closes so relaunch restores it", () => {
    const app = setup()
    app.registry.register("a", { name: "a" })
    expect(app.registry.closed("a")).toBe(false)
    expect(app.state.stored).toEqual(["a"])

    const restarted = createWindowRegistry<{ name: string }>({
      read: () => app.state.stored,
      write: (ids) => {
        app.state.stored = ids
      },
    })
    expect(restarted.persisted()).toEqual(["a"])
  })

  test("keeps every id when windows close during quit", () => {
    const app = setup()
    app.registry.register("a", { name: "a" })
    app.registry.register("b", { name: "b" })
    app.registry.setQuitting()
    expect(app.registry.closed("a")).toBe(false)
    expect(app.registry.closed("b")).toBe(false)
    expect(app.state.stored).toEqual(["a", "b"])
  })

  test("tracks the last focused window and falls back on close", () => {
    const app = setup()
    app.registry.register("a", { name: "a" })
    app.registry.register("b", { name: "b" })
    app.registry.focused("a")
    expect(app.registry.lastFocused()).toEqual({ name: "a" })
    app.registry.closed("a")
    expect(app.registry.lastFocused()).toEqual({ name: "b" })
    app.registry.closed("b")
    expect(app.registry.lastFocused()).toBeUndefined()
  })

  test("resumes forgetting closed windows after the quit flag resets", () => {
    const app = setup()
    app.registry.register("a", { name: "a" })
    app.registry.register("b", { name: "b" })
    app.registry.setQuitting()
    app.registry.setQuitting(false)
    expect(app.registry.closed("a")).toBe(true)
    expect(app.state.stored).toEqual(["b"])
  })
})
