import { describe, expect, test } from "bun:test"
import { clampSidebarWidth } from "../../src/util/sidebar-width"

describe("util.sidebar-width", () => {
  test("passes through a configured width within bounds", () => {
    expect(clampSidebarWidth(48, 120)).toBe(48)
  })

  test("clamps widths below the minimum to 20", () => {
    expect(clampSidebarWidth(12, 120)).toBe(20)
  })

  test("clamps widths above the terminal content limit", () => {
    expect(clampSidebarWidth(90, 120)).toBe(80)
  })

  test("clamps widths above the hard cap to 100", () => {
    expect(clampSidebarWidth(120, 200)).toBe(100)
  })

  test("keeps the minimum when terminal bounds are inverted", () => {
    expect(clampSidebarWidth(30, 55)).toBe(20)
  })

  test("defaults absent configuration to 42", () => {
    expect(clampSidebarWidth(undefined, 120)).toBe(42)
  })
})
