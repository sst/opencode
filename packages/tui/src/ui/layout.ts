export const SESSION_SIDEBAR_WIDTH = 42
export const SESSION_TABS_COMPACT_WIDTH = 5
export const SESSION_TABS_COMPACT_BREAKPOINT = 12
export const SESSION_SIDEBAR_MAX_WIDTH = 72
const SESSION_CONTENT_MIN_WIDTH = 44

export function sessionTabsFitVertically(total: number, width = SESSION_SIDEBAR_WIDTH) {
  return total >= width + SESSION_CONTENT_MIN_WIDTH
}

export function clampSessionTabsWidth(width: number, total: number) {
  return Math.max(
    SESSION_TABS_COMPACT_WIDTH,
    Math.min(width, SESSION_SIDEBAR_MAX_WIDTH, total - SESSION_CONTENT_MIN_WIDTH),
  )
}

export function clampSessionPaneWidth(width: number, total: number) {
  const half = Math.max(1, Math.floor(total / 2))
  // Preserve the equal split when there is not enough room for both pane minima.
  return Math.max(Math.min(24, half), Math.min(width, Math.max(half, total - SESSION_CONTENT_MIN_WIDTH)))
}
