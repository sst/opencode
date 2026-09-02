import { clampSidebarWidth } from "./sidebar-width"

export type SidebarState = "auto" | "collapsed" | "hide"

// Coarse steps so a few presses span the useful range without drag precision.
export const SIDEBAR_WIDTH_STEP = 4

export function nextSidebarState(state: SidebarState): SidebarState {
  return state === "auto" ? "collapsed" : "auto"
}

export function resolveSidebarWidth(override: unknown, configured: number): number {
  if (typeof override === "number" && Number.isInteger(override) && override > 0) return override
  return configured
}

export type SidebarInline = "expanded" | "collapsed" | undefined

export function sidebarLayout(input: {
  parentID?: string | undefined
  wide: boolean
  sidebarOpen: boolean
  state: SidebarState
}): { inline: SidebarInline; visible: boolean; rail: number } {
  if (input.parentID) return { inline: undefined, visible: false, rail: 0 }
  const inline: SidebarInline = !input.wide
    ? undefined
    : input.state === "auto"
      ? "expanded"
      : input.state === "collapsed"
        ? "collapsed"
        : undefined
  return {
    inline,
    visible: input.sidebarOpen || inline === "expanded",
    rail: inline === "collapsed" ? 2 : inline ? 1 : 0,
  }
}

/**
 * Applies rail movement to a sidebar width, where positive movement is to the
 * right — it narrows a right-docked sidebar and widens a left-docked one.
 */
export function sidebarWidthFromDrag(
  startWidth: number,
  deltaX: number,
  terminalWidth: number,
  direction: "left" | "right",
) {
  const width = direction === "right" ? startWidth - deltaX : startWidth + deltaX
  return clampSidebarWidth(width, terminalWidth)
}

export type SidebarDrag = { startX: number; startWidth: number; width: number; moved: boolean }

export function sidebarDragStart(x: number, startWidth: number): SidebarDrag {
  return { startX: x, startWidth, width: startWidth, moved: false }
}

export function sidebarDragMove(drag: SidebarDrag, x: number, terminalWidth: number): SidebarDrag {
  return {
    ...drag,
    width: sidebarWidthFromDrag(drag.startWidth, x - drag.startX, terminalWidth, "right"),
    moved: drag.moved || x !== drag.startX,
  }
}

export function sidebarDragEnd(drag: SidebarDrag): { persist: number } | { expand: true } {
  return drag.moved ? { persist: drag.width } : { expand: true }
}

export function sidebarWidthStep(currentWidth: number, delta: number, terminalWidth: number) {
  return clampSidebarWidth(currentWidth + delta, terminalWidth)
}
