import { SidebarWidthDefault } from "../config"

export const SidebarWidthMin = 20

export function clampSidebarWidth(configured: number | undefined, terminalWidth: number) {
  return Math.max(SidebarWidthMin, Math.min(configured ?? SidebarWidthDefault, terminalWidth - 40, 100))
}
