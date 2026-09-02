import { describe, expect, test } from "bun:test"
import { SidebarWidthMin } from "../../src/util/sidebar-width"
import {
  SIDEBAR_WIDTH_STEP,
  nextSidebarState,
  resolveSidebarWidth,
  sidebarDragEnd,
  sidebarDragMove,
  sidebarDragStart,
  sidebarLayout,
  sidebarWidthFromDrag,
  sidebarWidthStep,
} from "../../src/util/sidebar-rail"

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
    for (const override of [undefined, "50", 0, -3, NaN, Infinity, 2.5]) {
      expect(resolveSidebarWidth(override, 42)).toBe(42)
    }
  })

  test("steps the width by SIDEBAR_WIDTH_STEP", () => {
    expect(sidebarWidthStep(42, SIDEBAR_WIDTH_STEP, 200)).toBe(46)
    expect(sidebarWidthStep(22, -SIDEBAR_WIDTH_STEP, 200)).toBe(20)
  })
})

describe("sidebar drag reducer", () => {
  test("starts a gesture at the start width without movement", () => {
    expect(sidebarDragStart(100, 42)).toStrictEqual({ startX: 100, startWidth: 42, width: 42, moved: false })
  })

  test("narrows a right-docked sidebar when the gesture moves right", () => {
    const drag = sidebarDragMove(sidebarDragStart(100, 42), 108, 200)
    expect(drag.width).toBe(34)
    expect(drag.moved).toBe(true)
  })

  test("widens a right-docked sidebar when the gesture moves left", () => {
    expect(sidebarDragMove(sidebarDragStart(100, 42), 92, 200).width).toBe(50)
  })

  test("stays moved when the gesture returns to the start column", () => {
    const moved = sidebarDragMove(sidebarDragStart(100, 42), 108, 200)
    expect(sidebarDragMove(moved, 100, 200)).toStrictEqual({ startX: 100, startWidth: 42, width: 42, moved: true })
  })

  test("follows a collapsed gesture from the floor width", () => {
    expect(sidebarDragMove(sidebarDragStart(79, SidebarWidthMin), 69, 200).width).toBe(30)
  })

  test("clamps to the narrow terminal ceiling mid-gesture", () => {
    expect(sidebarDragMove(sidebarDragStart(100, 42), 40, 130).width).toBe(90)
  })

  test("clamps a grown gesture against a shrunken terminal", () => {
    const grown = sidebarDragMove(sidebarDragStart(100, 42), 20, 200)
    expect(grown.width).toBe(100)
    expect(sidebarDragMove(grown, 10, 130).width).toBe(90)
  })

  test("persists the final width after movement", () => {
    const moved = sidebarDragMove(sidebarDragStart(100, 42), 92, 200)
    expect(sidebarDragEnd(moved)).toStrictEqual({ persist: 50 })
  })

  test("expands when the gesture ends without movement", () => {
    expect(sidebarDragEnd(sidebarDragStart(100, 42))).toStrictEqual({ expand: true })
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
      rail: 2,
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
