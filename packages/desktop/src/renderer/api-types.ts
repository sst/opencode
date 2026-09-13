import type { BrowserPaneEvent } from "@opencode/app/desktop"
import type { DesktopMenuAction } from "@opencode/app/desktop-menu"
import type { DesktopNativeBundle } from "@opencode/app/i18n/desktop-native"
import type { UpdaterState } from "@opencode/app/updater"
import type { WslServersPlatform } from "@opencode/app/wsl/types"
import type { SshPlatform } from "@opencode/app/ssh"
import type { BrowserPaneRequest } from "../shared/ipc-rpc/browser"
import type {
  ClipboardImage,
  DirectoryPickerOptions,
  FatalRendererError,
  FilePickerOptions,
  PickedFiles,
  SaveFilePickerOptions,
  ServerReadyData,
  TitlebarTheme,
} from "../shared/ipc-contract"

export type WslServersAPI = WslServersPlatform
export type UpdaterAPI = {
  subscribe(cb: (state: UpdaterState) => void): Promise<() => void>
  check(): Promise<UpdaterState>
  install(): Promise<void>
}

export type ElectronAPI = {
  awaitInitialization(): Promise<ServerReadyData>
  reconnectService(): Promise<ServerReadyData>
  browserPane: {
    request(request: BrowserPaneRequest): Promise<void>
    send(request: BrowserPaneRequest): void
    onEvent(callback: (value: { readonly bindingID: string; readonly event: BrowserPaneEvent }) => void): () => void
  }
  wslServers: WslServersAPI
  sshServers: SshPlatform
  updater: UpdaterAPI
  consumeInitialDeepLinks(): Promise<string[]>
  getDefaultServerUrl(): Promise<string | null>
  setDefaultServerUrl(url: string | null): Promise<void>
  isFirstLaunchOnboardingPending(): Promise<boolean>
  finishFirstLaunchOnboarding(createDefaultProject: boolean): Promise<string | null>
  checkAppExists(appName: string): Promise<boolean>
  resolveAppPath(appName: string): Promise<string | null>
  storeItems(name: string): Promise<{ items: Record<string, string>; revision: number }>
  storeUpdate(name: string, insert: Record<string, string>, remove: string[]): Promise<number>
  storeClear(name: string): Promise<void>
  onStoreChanged(
    cb: (name: string, insert: Record<string, string>, remove: string[], revision: number) => void,
  ): () => void
  draftGet(key: string): Promise<string | null>
  draftSet(key: string, value: string, strict: boolean): Promise<string[]>
  draftDelete(key: string): Promise<void>
  draftBlobPut(data: ArrayBuffer): Promise<string>
  draftBlobGet(id: string): Promise<ArrayBuffer | null>
  getWindowID(): string
  themeReady(): Promise<void>
  onMenuCommand(cb: (id: string) => void): () => void
  onDeepLink(cb: (urls: string[]) => void): () => void
  openDirectoryPicker(opts?: DirectoryPickerOptions): Promise<string | string[] | null>
  openFilePicker(opts?: FilePickerOptions): Promise<PickedFiles | null>
  readPickedFile(token: string, path: string): Promise<ArrayBuffer>
  releasePickedFiles(token: string): Promise<void>
  getPathForFile(file: File): string
  saveFile(opts: SaveFilePickerOptions, content: string): Promise<boolean>
  openExternal(url: string): void
  openBrowser(url: string): Promise<boolean>
  openLocalFile(url: string): void
  openPath(path: string, app?: string): Promise<string | undefined>
  revealPath(path: string): Promise<boolean>
  readClipboardImage(): Promise<ClipboardImage | null>
  writeClipboardText(text: string): Promise<void>
  getWindowFocused(): Promise<boolean>
  getWindowFullscreen(): Promise<boolean>
  onWindowFullscreenChanged(cb: (fullscreen: boolean) => void): () => void
  setWindowFocus(): Promise<void>
  showWindow(): Promise<void>
  relaunch(): void
  getZoomFactor(): Promise<number>
  setZoomFactor(factor: number): Promise<void>
  getPinchZoomEnabled(): Promise<boolean>
  setPinchZoomEnabled(enabled: boolean): Promise<void>
  onPinchZoomEnabledChanged(cb: (enabled: boolean) => void): () => void
  onZoomFactorChanged(cb: (factor: number) => void): () => void
  setTitlebar(theme: TitlebarTheme): Promise<void>
  runDesktopMenuAction(action: DesktopMenuAction): Promise<void>
  setBackgroundColor(color: string): Promise<void>
  exportDebugLogs(): Promise<string>
  setForceFocus(enabled: boolean): Promise<void>
  recordFatalRendererError(error: FatalRendererError): Promise<void>
  setNativeTranslations(bundle: DesktopNativeBundle): Promise<void>
}
