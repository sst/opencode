import { describe, expect, test } from "bun:test"
import { sidebarWidthFromDrag, sidebarWidthStep } from "../../src/util/sidebar-rail"

describe("util.sidebar-rail", () => {
  test("increases a right-docked sidebar when the rail moves toward content", () => {
    expect(sidebarWidthFromDrag(42, -8, 200, "right")).toBe(50)
  })

  test("decreases a right-docked sidebar when the rail moves toward the sidebar edge", () => {
    expect(sidebarWidthFromDrag(42, 8, 200, "right")).toBe(34)
  })

  test("increases a left-docked sidebar when the rail moves toward content", () => {
    expect(sidebarWidthFromDrag(42, 8, 200, "left")).toBe(50)
  })

  test("decreases a left-docked sidebar when the rail moves left", () => {
    expect(sidebarWidthFromDrag(42, -8, 200, "left")).toBe(34)
  })

  test("clamps dragged widths at the minimum", () => {
    expect(sidebarWidthFromDrag(25, 20, 200, "right")).toBe(20)
  })

  test("clamps dragged widths at the maximum", () => {
    expect(sidebarWidthFromDrag(95, -20, 200, "right")).toBe(100)
  })

  test("uses the supplied collapsed width as the drag origin", () => {
    expect(sidebarWidthFromDrag(20, -12, 200, "right")).toBe(32)
  })

  test("clamps dragged widths to a narrow terminal ceiling", () => {
    expect(sidebarWidthFromDrag(70, -30, 120, "right")).toBe(80)
  })

  test("steps the sidebar width by the requested delta", () => {
    expect(sidebarWidthStep(42, 4, 200)).toBe(46)
  })

  test("clamps stepped widths at the minimum", () => {
    expect(sidebarWidthStep(22, -4, 200)).toBe(20)
  })

  test("clamps stepped widths at the narrow terminal ceiling", () => {
    expect(sidebarWidthStep(78, 4, 120)).toBe(80)
  })
})
