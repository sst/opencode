/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { tmpdir } from "../../fixture/fixture"
import { mount, wait } from "../../cli/cmd/tui/sync-fixture"
import {
  SIDEBAR_WIDTH_STEP,
  nextSidebarState,
  resolveSidebarWidth,
  sidebarLayout,
  sidebarWidthStep,
} from "../../../src/util/sidebar-rail"

describe("util.sidebar-rail state", () => {
  test("cycles auto to collapsed and back", () => {
    expect(nextSidebarState("auto")).toBe("collapsed")
    expect(nextSidebarState("collapsed")).toBe("auto")
    expect(nextSidebarState("hide")).toBe("auto")
  })

  test("never returns hide", () => {
    for (const state of ["auto", "collapsed", "hide"] as const) {
      expect(nextSidebarState(state)).not.toBe("hide")
    }
  })

  test("prefers a finite positive integer width override", () => {
    expect(resolveSidebarWidth(56, 42)).toBe(56)
  })

  test("falls back to the configured width for invalid overrides", () => {
    for (const override of [undefined, "50", 0, -3, NaN, 2.5]) {
      expect(resolveSidebarWidth(override, 42)).toBe(42)
    }
  })

  test("steps the width by SIDEBAR_WIDTH_STEP", () => {
    expect(sidebarWidthStep(42, SIDEBAR_WIDTH_STEP, 200)).toBe(46)
    expect(sidebarWidthStep(22, -SIDEBAR_WIDTH_STEP, 200)).toBe(20)
  })
})

describe("sidebar layout", () => {
  test("child sessions render no sidebar or rail", () => {
    expect(sidebarLayout({ parentID: "s1", wide: true, sidebarOpen: true, state: "auto" })).toStrictEqual({
      inline: undefined,
      visible: false,
      rail: 0,
    })
  })

  test("narrow terminals show the sidebar only as an overlay", () => {
    expect(sidebarLayout({ wide: false, sidebarOpen: true, state: "auto" })).toStrictEqual({
      inline: undefined,
      visible: true,
      rail: 0,
    })
  })

  test("wide terminals expand the sidebar beside a rail", () => {
    expect(sidebarLayout({ wide: true, sidebarOpen: false, state: "auto" })).toStrictEqual({
      inline: "expanded",
      visible: true,
      rail: 1,
    })
  })

  test("wide terminals collapse the sidebar to a rail", () => {
    expect(sidebarLayout({ wide: true, sidebarOpen: false, state: "collapsed" })).toStrictEqual({
      inline: "collapsed",
      visible: false,
      rail: 1,
    })
  })

  test("hidden state renders nothing", () => {
    expect(sidebarLayout({ wide: true, sidebarOpen: false, state: "hide" })).toStrictEqual({
      inline: undefined,
      visible: false,
      rail: 0,
    })
  })
})

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
