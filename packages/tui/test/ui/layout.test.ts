import { expect, test } from "bun:test"
import {
  clampSessionTabsWidth,
  sessionTabsFitVertically,
  SESSION_SIDEBAR_MAX_WIDTH,
  SESSION_SIDEBAR_WIDTH,
  SESSION_TABS_COMPACT_WIDTH,
} from "../../src/ui/layout"

test("vertical tabs match the session sidebar and preserve compact content width", () => {
  expect(SESSION_SIDEBAR_WIDTH).toBe(42)
  expect(sessionTabsFitVertically(86)).toBe(true)
  expect(sessionTabsFitVertically(85)).toBe(false)
})

test("vertical tabs account for a resized width", () => {
  expect(sessionTabsFitVertically(104, 60)).toBe(true)
  expect(sessionTabsFitVertically(103, 60)).toBe(false)
})

test("vertical tab width preserves minimum rail and content widths", () => {
  expect(clampSessionTabsWidth(0, 120)).toBe(SESSION_TABS_COMPACT_WIDTH)
  expect(clampSessionTabsWidth(11, 120)).toBe(11)
  expect(clampSessionTabsWidth(12, 120)).toBe(12)
  expect(clampSessionTabsWidth(50, 120)).toBe(50)
  expect(clampSessionTabsWidth(100, 120)).toBe(SESSION_SIDEBAR_MAX_WIDTH)
  expect(clampSessionTabsWidth(100, 100)).toBe(56)
  expect(clampSessionTabsWidth(42, 54)).toBe(10)
  expect(sessionTabsFitVertically(49, SESSION_TABS_COMPACT_WIDTH)).toBe(true)
  expect(sessionTabsFitVertically(48, SESSION_TABS_COMPACT_WIDTH)).toBe(false)
})
