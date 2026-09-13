import { describe, expect, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { mount, wait } from "../fixture/tui-sync"

describe("kv.delete", () => {
  test("removes the key from the store and the persisted snapshot", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, kv } = await mount(undefined, tmp.path)
    const file = `${tmp.path}/kv.json`

    try {
      kv.set("sidebar_width", 56)
      expect(kv.get("sidebar_width")).toBe(56)
      await wait(async () => (await Bun.file(file).text()).includes("sidebar_width"))

      kv.delete("sidebar_width")
      expect(kv.get("sidebar_width", 42)).toBe(42)
      await wait(async () => !(await Bun.file(file).text()).includes("sidebar_width"))
      expect(await Bun.file(file).json()).not.toHaveProperty("sidebar_width")
    } finally {
      app.renderer.destroy()
    }
  })
})

describe("kv.writes", () => {
  test("counts every persisted write, including signal-backed setters", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, kv } = await mount(undefined, tmp.path)

    try {
      expect(kv.writes).toBe(0)
      kv.set("sidebar_width", 56)
      expect(kv.writes).toBe(1)
      kv.set("sidebar_width", 58)
      expect(kv.writes).toBe(2)
      const [visible, setVisible] = kv.signal("visible", false)
      setVisible(() => true)
      expect(kv.writes).toBe(3)
      kv.delete("sidebar_width")
      expect(kv.writes).toBe(4)
      expect(visible()).toBe(true)
    } finally {
      app.renderer.destroy()
    }
  })
})
