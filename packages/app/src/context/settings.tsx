import { createStore, reconcile } from "solid-js/store"
import { batch, createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { persisted } from "@/utils/persist"
import { usePlatform } from "@/context/platform"

export interface NotificationSettings {
  agent: boolean
  permissions: boolean
  errors: boolean
}

export interface SoundSettings {
  agentEnabled: boolean
  agent: string
  permissionsEnabled: boolean
  permissions: string
  errorsEnabled: boolean
  errors: string
}

export interface Settings {
  general: {
    autoSave: boolean
    releaseNotes: boolean
    followup: "queue" | "steer"
    showFileTree: boolean
    showNavigation: boolean
    showSearch: boolean
    showStatus: boolean
    showTerminal: boolean
    showReasoningSummaries: boolean
    shellToolPartsExpanded: boolean
    editToolPartsExpanded: boolean
    showCustomAgents: boolean
    mobileTitlebarPosition: "top" | "bottom"
    newLayoutDesigns?: boolean
    layoutTransitionEligible?: boolean
    agentVisibilityInitialized?: boolean
    newInterfaceNoticeDismissed?: boolean
    shouldDisplayTabsToast?: boolean
  }
  appearance: {
    fontSize: number
    mono: string
    sans: string
    terminal: string
    wordDiffHighlighting: boolean
  }
  keybinds: Record<string, string>
  permissions: {
    autoApprove: boolean
  }
  notifications: NotificationSettings
  sounds: SoundSettings
}

export const monoDefault = "System Mono"
export const sansDefault = "System Sans"
export const terminalDefault = "JetBrainsMono Nerd Font Mono"
export const wordDiffHighlightingDefault = false
const legacyNewLayoutDesignsDefault = import.meta.env.VITE_OPENCODE_CHANNEL !== "prod"
export const newLayoutDesignsDefault = true
// Existing users can switch layouts until local midnight on this date. Set new Date(YYYY, M-1, D) to show.
export const oldInterfaceSunset = new Date(2026, 8, 14)
const newLayoutDesignsUpgradeCutoff = "1.17.19"

function compareVersions(a: string, b: string) {
  const parse = (version: string) => {
    const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/i.exec(version.trim())
    if (!match) return
    return match.slice(1).map(Number)
  }
  const left = parse(a)
  const right = parse(b)
  if (!left || !right) return
  const index = left.findIndex((part, index) => part !== right[index])
  return index === -1 ? 0 : left[index]! - right[index]!
}

export function isAppUpgrade(previous: string | undefined, current: string | undefined) {
  if (!previous || !current) return false
  const comparison = compareVersions(current, previous)
  return comparison !== undefined && comparison > 0
}

export function shouldDisplayTabsToast(
  previous: string | undefined,
  current: string | undefined,
  existingInstall: boolean,
) {
  return isAppUpgrade(previous, current) || (!previous && existingInstall)
}

export function hasExistingWebState(settings: Promise<string> | string | null, previousVersion: string | undefined) {
  return settings !== null || previousVersion !== undefined
}

export function initialAgentVisibility(initialized: boolean | undefined, existing: boolean, previousVersion?: string) {
  if (initialized === true) return
  return existing || previousVersion !== undefined
}

export function shouldEnableNewLayout(previous: string | undefined, current: string | undefined) {
  if (!current) return false
  const currentComparison = compareVersions(current, newLayoutDesignsUpgradeCutoff)
  if (!previous) return currentComparison !== undefined && currentComparison > 0
  if (!isAppUpgrade(previous, current)) return false
  const previousComparison = compareVersions(previous, newLayoutDesignsUpgradeCutoff)
  return (
    previousComparison !== undefined &&
    currentComparison !== undefined &&
    previousComparison <= 0 &&
    currentComparison > 0
  )
}

export function layoutTransitionState(scheduled: boolean, eligible: boolean, retired: boolean, dismissed: boolean) {
  return {
    available: scheduled && eligible && !retired,
    notice: scheduled && eligible && retired && !dismissed,
  }
}

export const maximumSunsetTimeout = 2_147_483_647

export function nextSunsetCheckDelay(sunset: number, now: number) {
  return Math.min(Math.max(0, sunset - now), maximumSunsetTimeout)
}

export function resolveNewLayoutDesigns(retired: boolean, preference: boolean | undefined, fallback = true) {
  if (retired) return true
  return preference ?? fallback
}

const monoFallback =
  'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace'
const sansFallback = 'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
const terminalFallback =
  '"JetBrainsMono Nerd Font Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace'

const monoBase = monoFallback
const sansBase = sansFallback
const terminalBase = terminalFallback

function input(font: string | undefined) {
  return font ?? ""
}

function family(font: string) {
  if (/^[\w-]+$/.test(font)) return font
  return `"${font.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`
}

function stack(font: string | undefined, base: string) {
  const value = font?.trim() ?? ""
  if (!value) return base
  return `${family(value)}, ${base}`
}

export function monoInput(font: string | undefined) {
  return input(font)
}

export function sansInput(font: string | undefined) {
  return input(font)
}

export function monoFontFamily(font: string | undefined) {
  return stack(font, monoBase)
}

export function sansFontFamily(font: string | undefined) {
  return stack(font, sansBase)
}

export function terminalInput(font: string | undefined) {
  return input(font)
}

export function terminalFontFamily(font: string | undefined) {
  return stack(font, terminalBase)
}

const defaultSettings: Settings = {
  general: {
    autoSave: true,
    releaseNotes: true,
    followup: "steer",
    showFileTree: false,
    showNavigation: false,
    showSearch: false,
    showStatus: false,
    showTerminal: false,
    showReasoningSummaries: false,
    shellToolPartsExpanded: false,
    editToolPartsExpanded: false,
    showCustomAgents: false,
    mobileTitlebarPosition: "top",
  },
  appearance: {
    fontSize: 14,
    mono: "",
    sans: "",
    terminal: "",
    wordDiffHighlighting: wordDiffHighlightingDefault,
  },
  keybinds: {},
  permissions: {
    autoApprove: false,
  },
  notifications: {
    agent: true,
    permissions: true,
    errors: false,
  },
  sounds: {
    agentEnabled: true,
    agent: "staplebops-01",
    permissionsEnabled: true,
    permissions: "staplebops-02",
    errorsEnabled: true,
    errors: "nope-03",
  },
}

function withFallback<T>(read: () => T | undefined, fallback: T) {
  return createMemo(() => read() ?? fallback)
}

export const { use: useSettings, provider: SettingsProvider } = createSimpleContext({
  name: "Settings",
  gate: false,
  init: () => {
    const platform = usePlatform()
    const [store, setStore, settingsInit, ready] = persisted("settings.v3", createStore<Settings>(defaultSettings))
    const [launch, setLaunch, , launchReady] = persisted(
      "app-version.v1",
      createStore<{ version?: string }>({ version: undefined }),
    )
    const [launchState, setLaunchState] = createStore({
      classified: false,
      migrationApplied: false,
      previous: undefined as string | undefined,
    })
    const showFileTree = withFallback(() => store.general?.showFileTree, defaultSettings.general.showFileTree)
    const showSearch = withFallback(() => store.general?.showSearch, defaultSettings.general.showSearch)
    const showStatus = withFallback(() => store.general?.showStatus, defaultSettings.general.showStatus)
    const showCustomAgents = withFallback(
      () => store.general?.showCustomAgents,
      defaultSettings.general.showCustomAgents,
    )
    const sunset = oldInterfaceSunset
    const [oldInterfaceRetired, setOldInterfaceRetired] = createSignal(sunset ? Date.now() >= sunset.getTime() : false)
    const layoutTransitionClassified = createMemo(() => typeof store.general?.layoutTransitionEligible === "boolean")
    const layoutTransitionEligible = withFallback(() => store.general?.layoutTransitionEligible, false)
    const newInterfaceNoticeDismissed = withFallback(() => store.general?.newInterfaceNoticeDismissed, false)
    const layoutUpgrade = createMemo(() =>
      launchState.classified && !launchState.migrationApplied
        ? shouldEnableNewLayout(launchState.previous, platform.version)
        : false,
    )
    const layoutTransition = createMemo(() =>
      layoutTransitionState(!!sunset, layoutTransitionEligible(), oldInterfaceRetired(), newInterfaceNoticeDismissed()),
    )
    const newLayoutDesigns = createMemo(() => {
      if (layoutUpgrade()) return true
      if (!ready() && !oldInterfaceRetired()) return legacyNewLayoutDesignsDefault
      if (!layoutTransitionClassified()) {
        return resolveNewLayoutDesigns(
          oldInterfaceRetired(),
          store.general?.newLayoutDesigns,
          legacyNewLayoutDesignsDefault,
        )
      }
      return resolveNewLayoutDesigns(
        oldInterfaceRetired(),
        store.general?.newLayoutDesigns,
        layoutTransitionEligible() ? legacyNewLayoutDesignsDefault : newLayoutDesignsDefault,
      )
    })
    const visible = (preference: () => boolean) => createMemo(() => !newLayoutDesigns() || preference())
    const initializeAgentVisibility = (existing: boolean) => {
      const initial = initialAgentVisibility(store.general?.agentVisibilityInitialized, existing, launchState.previous)
      if (initial === undefined) return
      batch(() => {
        setStore("general", "showCustomAgents", initial)
        setStore("general", "agentVisibilityInitialized", true)
      })
    }

    if (sunset && !oldInterfaceRetired()) {
      const timeout = { current: undefined as ReturnType<typeof setTimeout> | undefined }
      const checkSunset = () => {
        if (Date.now() >= sunset.getTime()) {
          setOldInterfaceRetired(true)
          return
        }
        timeout.current = setTimeout(checkSunset, nextSunsetCheckDelay(sunset.getTime(), Date.now()))
      }
      checkSunset()
      onCleanup(() => {
        if (timeout.current !== undefined) clearTimeout(timeout.current)
      })
    }

    createEffect(() => {
      if (!launchReady() || launchState.classified) return
      setLaunchState({
        classified: true,
        previous: launch.version,
      })
      if (!platform.version || launch.version === platform.version) return
      setLaunch("version", platform.version)
    })

    createEffect(() => {
      if (!ready() || !launchState.classified || platform.platform !== "web") return
      const existing = hasExistingWebState(settingsInit, launchState.previous)
      if (!layoutTransitionClassified()) setStore("general", "layoutTransitionEligible", existing)
      initializeAgentVisibility(existing)
    })

    createEffect(() => {
      if (!ready() || !launchState.classified || launchState.migrationApplied) return
      if (layoutUpgrade() && store.general?.newLayoutDesigns !== true) {
        setStore("general", "newLayoutDesigns", true)
      }
      setLaunchState("migrationApplied", true)
    })

    createEffect(() => {
      if (!ready() || !launchState.classified) return
      if (typeof store.general?.shouldDisplayTabsToast === "boolean") return
      if (!launchState.previous && !layoutTransitionClassified()) return
      setStore(
        "general",
        "shouldDisplayTabsToast",
        shouldDisplayTabsToast(launchState.previous, platform.version, layoutTransitionEligible()),
      )
    })

    createEffect(() => {
      if (!ready() || !oldInterfaceRetired()) return
      if (store.general?.newLayoutDesigns === true) return
      setStore("general", "newLayoutDesigns", true)
    })

    createEffect(() => {
      if (typeof document === "undefined") return
      const root = document.documentElement
      root.style.setProperty("--font-family-mono", monoFontFamily(store.appearance?.mono))
      root.style.setProperty("--font-family-sans", sansFontFamily(store.appearance?.sans))
    })

    createEffect(() => {
      if (store.general?.followup !== "queue") return
      setStore("general", "followup", "steer")
    })

    return {
      ready,
      get current() {
        return store
      },
      general: {
        autoSave: withFallback(() => store.general?.autoSave, defaultSettings.general.autoSave),
        setAutoSave(value: boolean) {
          setStore("general", "autoSave", value)
        },
        releaseNotes: withFallback(() => store.general?.releaseNotes, defaultSettings.general.releaseNotes),
        setReleaseNotes(value: boolean) {
          setStore("general", "releaseNotes", value)
        },
        followup: withFallback(
          () => (store.general?.followup === "queue" ? "steer" : store.general?.followup),
          defaultSettings.general.followup,
        ),
        setFollowup(value: "queue" | "steer") {
          setStore("general", "followup", value === "queue" ? "steer" : value)
        },
        showFileTree,
        setShowFileTree(value: boolean) {
          setStore("general", "showFileTree", value)
        },
        showNavigation: withFallback(() => store.general?.showNavigation, defaultSettings.general.showNavigation),
        setShowNavigation(value: boolean) {
          setStore("general", "showNavigation", value)
        },
        showSearch,
        setShowSearch(value: boolean) {
          setStore("general", "showSearch", value)
        },
        showStatus,
        setShowStatus(value: boolean) {
          setStore("general", "showStatus", value)
        },
        showTerminal: withFallback(() => store.general?.showTerminal, defaultSettings.general.showTerminal),
        setShowTerminal(value: boolean) {
          setStore("general", "showTerminal", value)
        },
        showReasoningSummaries: withFallback(
          () => store.general?.showReasoningSummaries,
          defaultSettings.general.showReasoningSummaries,
        ),
        setShowReasoningSummaries(value: boolean) {
          setStore("general", "showReasoningSummaries", value)
        },
        shellToolPartsExpanded: withFallback(
          () => store.general?.shellToolPartsExpanded,
          defaultSettings.general.shellToolPartsExpanded,
        ),
        setShellToolPartsExpanded(value: boolean) {
          setStore("general", "shellToolPartsExpanded", value)
        },
        editToolPartsExpanded: withFallback(
          () => store.general?.editToolPartsExpanded,
          defaultSettings.general.editToolPartsExpanded,
        ),
        setEditToolPartsExpanded(value: boolean) {
          setStore("general", "editToolPartsExpanded", value)
        },
        showCustomAgents,
        setShowCustomAgents(value: boolean) {
          setStore("general", "showCustomAgents", value)
        },
        mobileTitlebarPosition: withFallback(
          () => store.general?.mobileTitlebarPosition,
          defaultSettings.general.mobileTitlebarPosition,
        ),
        setMobileTitlebarPosition(value: "top" | "bottom") {
          setStore("general", "mobileTitlebarPosition", value)
        },
        newLayoutDesigns,
        setNewLayoutDesigns(value: boolean) {
          const next = oldInterfaceRetired() ? true : value
          if (newLayoutDesigns() === next) return
          setStore("general", "newLayoutDesigns", next)
          if (typeof window !== "undefined") setTimeout(() => window.location.reload())
        },
        layoutTransitionClassified,
        setOldLayoutEligible(eligible: boolean) {
          const current = store.general?.layoutTransitionEligible
          if (typeof current === "boolean") return
          setStore("general", "layoutTransitionEligible", eligible)
        },
        initializeAgentVisibility,
        layoutTransitionAvailable: createMemo(() => ready() && layoutTransition().available),
        newInterfaceNoticeVisible: createMemo(() => ready() && layoutTransition().notice),
        dismissNewInterfaceNotice() {
          setStore("general", "newInterfaceNoticeDismissed", true)
        },
        shouldDisplayTabsToast: withFallback(() => store.general?.shouldDisplayTabsToast, false),
        dismissTabsToast() {
          setStore("general", "shouldDisplayTabsToast", false)
        },
      },
      visibility: {
        fileTree: visible(showFileTree),
        search: visible(showSearch),
        status: visible(showStatus),
        customAgents: visible(showCustomAgents),
      },
      appearance: {
        fontSize: withFallback(() => store.appearance?.fontSize, defaultSettings.appearance.fontSize),
        setFontSize(value: number) {
          setStore("appearance", "fontSize", value)
        },
        font: withFallback(() => store.appearance?.mono, defaultSettings.appearance.mono),
        setFont(value: string) {
          setStore("appearance", "mono", value.trim() ? value : "")
        },
        uiFont: withFallback(() => store.appearance?.sans, defaultSettings.appearance.sans),
        setUIFont(value: string) {
          setStore("appearance", "sans", value.trim() ? value : "")
        },
        terminalFont: withFallback(() => store.appearance?.terminal, defaultSettings.appearance.terminal),
        setTerminalFont(value: string) {
          setStore("appearance", "terminal", value.trim() ? value : "")
        },
        wordDiffHighlighting: withFallback(
          () => store.appearance?.wordDiffHighlighting,
          defaultSettings.appearance.wordDiffHighlighting,
        ),
        setWordDiffHighlighting(value: boolean) {
          setStore("appearance", "wordDiffHighlighting", value)
        },
      },
      keybinds: {
        get: (action: string) => store.keybinds?.[action],
        set(action: string, keybind: string) {
          setStore("keybinds", action, keybind)
        },
        reset(action: string) {
          setStore("keybinds", (current) => {
            if (!Object.prototype.hasOwnProperty.call(current, action)) return current
            const next = { ...current }
            delete next[action]
            return next
          })
        },
        resetAll() {
          setStore("keybinds", reconcile({}))
        },
      },
      permissions: {
        autoApprove: withFallback(() => store.permissions?.autoApprove, defaultSettings.permissions.autoApprove),
        setAutoApprove(value: boolean) {
          setStore("permissions", "autoApprove", value)
        },
      },
      notifications: {
        agent: withFallback(() => store.notifications?.agent, defaultSettings.notifications.agent),
        setAgent(value: boolean) {
          setStore("notifications", "agent", value)
        },
        permissions: withFallback(() => store.notifications?.permissions, defaultSettings.notifications.permissions),
        setPermissions(value: boolean) {
          setStore("notifications", "permissions", value)
        },
        errors: withFallback(() => store.notifications?.errors, defaultSettings.notifications.errors),
        setErrors(value: boolean) {
          setStore("notifications", "errors", value)
        },
      },
      sounds: {
        agentEnabled: withFallback(() => store.sounds?.agentEnabled, defaultSettings.sounds.agentEnabled),
        setAgentEnabled(value: boolean) {
          setStore("sounds", "agentEnabled", value)
        },
        agent: withFallback(() => store.sounds?.agent, defaultSettings.sounds.agent),
        setAgent(value: string) {
          setStore("sounds", "agent", value)
        },
        permissionsEnabled: withFallback(
          () => store.sounds?.permissionsEnabled,
          defaultSettings.sounds.permissionsEnabled,
        ),
        setPermissionsEnabled(value: boolean) {
          setStore("sounds", "permissionsEnabled", value)
        },
        permissions: withFallback(() => store.sounds?.permissions, defaultSettings.sounds.permissions),
        setPermissions(value: string) {
          setStore("sounds", "permissions", value)
        },
        errorsEnabled: withFallback(() => store.sounds?.errorsEnabled, defaultSettings.sounds.errorsEnabled),
        setErrorsEnabled(value: boolean) {
          setStore("sounds", "errorsEnabled", value)
        },
        errors: withFallback(() => store.sounds?.errors, defaultSettings.sounds.errors),
        setErrors(value: string) {
          setStore("sounds", "errors", value)
        },
      },
    }
  },
})
