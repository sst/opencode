import { MacOSScrollAccel, type ScrollAcceleration, type ScrollBoxRenderable } from "@opentui/core"

export type ScrollConfig = {
  scroll_acceleration?: { enabled?: boolean }
  scroll_speed?: number
}

export class CustomSpeedScroll implements ScrollAcceleration {
  constructor(private speed: number) {}

  tick(_now?: number): number {
    return this.speed
  }

  reset(): void {}
}

export function getScrollAcceleration(tuiConfig?: ScrollConfig): ScrollAcceleration {
  if (tuiConfig?.scroll_acceleration?.enabled) {
    return new MacOSScrollAccel()
  }
  if (tuiConfig?.scroll_speed !== undefined) {
    return new CustomSpeedScroll(tuiConfig.scroll_speed)
  }

  return new CustomSpeedScroll(3)
}

export function scrollToMessageID(scroll: ScrollBoxRenderable, messageID: string): boolean {
  const child = scroll.getChildren().find((child) => child.id === messageID)
  if (!child) return false
  scroll.scrollBy(child.y - scroll.y - 1)
  return true
}
