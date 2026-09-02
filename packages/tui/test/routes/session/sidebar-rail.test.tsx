/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { tmpdir } from "../../fixture/fixture"
import { mount, wait } from "../../cli/cmd/tui/sync-fixture"

describe("kv.delete", () => {
  test("removes the key from the store and the persisted snapshot", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, kv } = await mount(undefined, tmp.path)
    const file = `${tmp.path}/kv.json`

    try {
      kv.set("sidebar_width", 56)
      expect(kv.get("sidebar_width")).toBe(56)
      await wait(() => readFileSync(file, "utf8").includes("sidebar_width"))

      kv.delete("sidebar_width")
      expect(kv.get("sidebar_width", 42)).toBe(42)
      await wait(() => !readFileSync(file, "utf8").includes("sidebar_width"))
      expect(JSON.parse(readFileSync(file, "utf8"))).not.toHaveProperty("sidebar_width")
    } finally {
      app.renderer.destroy()
    }
  })
})
