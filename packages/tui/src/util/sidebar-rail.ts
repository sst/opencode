import { clampSidebarWidth } from "./sidebar-width"

/**
 * Applies rail movement to a sidebar width, where positive movement is toward
 * the docked side and therefore narrows a right-docked sidebar or widens a
 * left-docked sidebar.
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

export function sidebarWidthStep(currentWidth: number, delta: number, terminalWidth: number) {
  return clampSidebarWidth(currentWidth + delta, terminalWidth)
}
