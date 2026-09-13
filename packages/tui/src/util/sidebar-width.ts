import { SidebarWidthDefault } from "../config"

export function clampSidebarWidth(configured: number | undefined, terminalWidth: number) {
  return Math.max(20, Math.min(configured ?? SidebarWidthDefault, terminalWidth - 40, 100))
}
