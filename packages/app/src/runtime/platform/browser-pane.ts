import type { Browser } from "@opencode/plugin-browser/rpc"

export type BrowserPaneEndpoint = Readonly<{ url: string; username?: string; password?: string }>
export type BrowserPaneTarget = Readonly<{
  serverKey: string
  sessionID: string
  endpoint: BrowserPaneEndpoint
  restore?: Browser.State
}>
export type BrowserPaneLayout = {
  tabID: Browser.TabID
  visible: boolean
  bounds?: { x: number; y: number; width: number; height: number }
  background?: readonly [number, number, number, number]
  radius?: number
}

export type BrowserPaneCommand = Browser.Action
export type BrowserPaneState = Browser.State | null
export type BrowserPaneEvent =
  | { type: "focus"; tabID: Browser.TabID }
  | { type: "state"; state: BrowserPaneState; error?: string }

export type BrowserPaneRegistration = {
  setLayout(layout?: BrowserPaneLayout): void
  command(command: BrowserPaneCommand): Promise<void>
  close(): void
}

export type BrowserPanePlatform = {
  register(target: BrowserPaneTarget, listener: (event: BrowserPaneEvent) => void): BrowserPaneRegistration
}
