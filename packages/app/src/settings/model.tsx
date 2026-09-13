import { reconcile, unwrap } from "solid-js/store"
import { createEffect, createMemo } from "solid-js"
import { Effect, Option, Schema, SchemaGetter } from "effect"
import { createSimpleContext } from "@opencode/ui/context"
import { timelinePresets, type TimelineCategory, type TimelineDetail } from "@opencode/session-ui/timeline/detail"
import { persisted } from "@/runtime/persistence/storage"
import { Persistence } from "@/runtime/persistence/schema"
import { ScopedKey, type ServerScope } from "@/runtime/server/scope"

export type Settings = typeof settingsSchema.Type
export type WorkspaceDefaultDestination = Settings["workspaces"]["defaultDestination"]
export type WorkspaceLastUsed = Settings["workspaces"]["lastUsed"][string]
export type TerminalPlacement = Settings["general"]["terminalPlacement"]
export type FollowUpBehavior = Settings["general"]["followUpBehavior"]
export type TabLayout = Settings["appearance"]["tabLayout"]
export type NotificationSettings = Settings["notifications"]
export type SoundSettings = Settings["sounds"]

export const monoDefault = "IBM Plex Mono"
export const sansDefault = "Inter"
export const terminalDefault = "JetBrainsMono Nerd Font Mono"
const monoFallback =
  '"IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace'
const sansFallback = '"Inter", ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
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

const placementSchema = Schema.Literals(["separate", "grouped", "hidden"])
const detailsSchema = Schema.Literals(["collapsed", "expanded"])
const activitySchema = Persistence.struct({ placement: placementSchema, details: detailsSchema })
const placementOnlySchema = Persistence.struct({ placement: placementSchema })

const generalSchema = Persistence.struct({
  autoSave: Schema.Boolean,
  releaseNotes: Schema.Boolean,
  showFileTree: Schema.Boolean,
  showNavigation: Schema.Boolean,
  showSearch: Schema.Boolean,
  showProjectIcon: Schema.Boolean,
  showTerminal: Schema.Boolean,
  timelineDetail: Persistence.struct({
    shell: activitySchema,
    edit: activitySchema,
    thinking: activitySchema,
    subagents: placementOnlySchema,
    notices: placementOnlySchema,
    tools: placementOnlySchema,
  }),
  showCustomAgents: Schema.Boolean,
  mobileTitlebarPosition: Schema.Literals(["top", "bottom"]),
  mobileDiffWrap: Schema.Boolean,
  terminalPlacement: Schema.Literals(["side", "bottom"]),
  followUpBehavior: Schema.Literals(["queue", "steer"]),
  experimentalBrowser: Schema.Boolean,
})

const appearanceSchema = Persistence.struct({
  fontSize: Schema.Number,
  mono: Schema.String,
  sans: Schema.String,
  terminal: Schema.String,
  tabLayout: Schema.Literals(["horizontal", "vertical"]),
  showProjectName: Schema.Boolean,
})

const permissionsSchema = Persistence.struct({
  autoApprove: Schema.Boolean,
})

const workspacesSchema = Persistence.struct({
  defaultDestination: Schema.Literals(["last-used", "local", "new"]),
  lastUsed: Persistence.record(
    Schema.Literals(["local", "workspace"]).pipe(Schema.catchDecoding(() => Effect.succeed(Option.none()))),
  ),
})

const notificationsSchema = Persistence.struct({
  agent: Schema.Boolean,
  permissions: Schema.Boolean,
  errors: Schema.Boolean,
})

const soundsSchema = Persistence.struct({
  agentEnabled: Schema.Boolean,
  agent: Schema.String,
  permissionsEnabled: Schema.Boolean,
  permissions: Schema.String,
  errorsEnabled: Schema.Boolean,
  errors: Schema.String,
})

export const settingsSchema = Persistence.struct({
  general: generalSchema,
  sessionSummary: Persistence.struct({ projectExpanded: Schema.Boolean, serverExpanded: Schema.Boolean }),
  appearance: appearanceSchema,
  keybinds: Persistence.record(Schema.String.pipe(Schema.catchDecoding(() => Effect.succeed(Option.none())))),
  permissions: permissionsSchema,
  workspaces: workspacesSchema,
  notifications: notificationsSchema,
  sounds: soundsSchema,
})

function storedTimelineCategory(category: TimelineCategory) {
  return Persistence.optional(
    Schema.Union([
      Schema.Struct({
        placement: Persistence.optional(placementSchema),
        details: Persistence.optional(detailsSchema),
      }),
      Schema.Literals(["expanded", "collapsed", "hidden", "visible"]),
    ]).pipe(
      Schema.decode({
        decode: SchemaGetter.transform((value) => {
          if (typeof value !== "string") return value
          return {
            placement:
              value === "hidden"
                ? "hidden"
                : category === "subagents"
                  ? "separate"
                  : category === "tools"
                    ? "grouped"
                    : value === "expanded"
                      ? "separate"
                      : value === "collapsed"
                        ? "grouped"
                        : undefined,
            details: value === "expanded" ? "expanded" : "collapsed",
          }
        }),
        encode: SchemaGetter.passthrough(),
      }),
    ),
  )
}

function legacyTimelineActivity(value: boolean | "hidden" | "compact" | "full" | null | undefined) {
  if (value === undefined || value === null) return
  const expanded = value === true || value === "full"
  return {
    placement: value === "hidden" ? "hidden" : expanded ? "separate" : "grouped",
    details: expanded ? "expanded" : "collapsed",
  } as const
}

export const settingsPersistence = Persistence.migrate(
  settingsSchema,
  Schema.Struct({
    general: Persistence.optional(
      Schema.Struct({
        // Keep invalid explicit values distinct from absent values so legacy preferences cannot replace them.
        timelineDetail: Schema.optional(
          Schema.NullOr(
            Schema.Struct({
              shell: storedTimelineCategory("shell"),
              edit: storedTimelineCategory("edit"),
              thinking: storedTimelineCategory("thinking"),
              subagents: storedTimelineCategory("subagents"),
              notices: storedTimelineCategory("notices"),
              tools: storedTimelineCategory("tools"),
            }),
          ),
        ).pipe(Schema.catchDecoding(() => Effect.succeed(Option.some(null)))),
        reasoningMode: Schema.optional(Schema.NullOr(Schema.Literals(["hidden", "compact", "full"]))).pipe(
          Schema.catchDecoding(() => Effect.succeed(Option.some(null))),
        ),
        showReasoningSummaries: Persistence.optional(Schema.Boolean),
        shellToolPartsExpanded: Persistence.optional(Schema.Boolean),
        editToolPartsExpanded: Persistence.optional(Schema.Boolean),
      }),
    ),
  }).pipe(
    Schema.decode({
      decode: SchemaGetter.transform((value) => {
        const general = value.general
        if (!general || general.timelineDetail !== undefined) return value
        return {
          ...value,
          general: {
            ...general,
            timelineDetail: {
              shell: legacyTimelineActivity(general.shellToolPartsExpanded),
              edit: legacyTimelineActivity(general.editToolPartsExpanded),
              thinking: legacyTimelineActivity(
                general.reasoningMode === undefined ? general.showReasoningSummaries : general.reasoningMode,
              ),
            },
          },
        }
      }),
      encode: SchemaGetter.transform((value) => value),
    }),
  ),
)

export const defaultSettings: Settings = {
  general: {
    autoSave: true,
    releaseNotes: true,
    showFileTree: false,
    showNavigation: false,
    showSearch: false,
    showProjectIcon: false,
    showTerminal: false,
    timelineDetail: { ...timelinePresets[2].value },
    showCustomAgents: false,
    mobileTitlebarPosition: "top",
    mobileDiffWrap: true,
    terminalPlacement: "side",
    followUpBehavior: "steer",
    experimentalBrowser: false,
  },
  sessionSummary: { projectExpanded: true, serverExpanded: true },
  appearance: { fontSize: 14, mono: "", sans: "", terminal: "", tabLayout: "horizontal", showProjectName: false },
  keybinds: {},
  permissions: { autoApprove: false },
  workspaces: { defaultDestination: "last-used", lastUsed: {} },
  notifications: { agent: true, permissions: true, errors: false },
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
    const [store, setStore, , ready] = persisted({ key: "settings.v3" }, settingsPersistence, defaultSettings)
    const showFileTree = withFallback(() => store.general?.showFileTree, defaultSettings.general.showFileTree)
    const showSearch = withFallback(() => store.general?.showSearch, defaultSettings.general.showSearch)
    const showCustomAgents = withFallback(
      () => store.general?.showCustomAgents,
      defaultSettings.general.showCustomAgents,
    )
    createEffect(() => {
      if (typeof document === "undefined") return
      const root = document.documentElement
      const mono = monoFontFamily(store.appearance?.mono)
      root.style.setProperty("--font-family-mono", mono)
      root.style.setProperty("--font-family-sans", sansFontFamily(store.appearance?.sans))
      // Inline code can first appear during history backfill. Load its selected
      // face with the shell so that font discovery does not resize that mount.
      void document.fonts?.load(`440 13px ${mono}`).catch(() => undefined)
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
        showProjectIcon: withFallback(() => store.general?.showProjectIcon, defaultSettings.general.showProjectIcon),
        setShowProjectIcon(value: boolean) {
          setStore("general", "showProjectIcon", value)
        },
        showTerminal: withFallback(() => store.general?.showTerminal, defaultSettings.general.showTerminal),
        setShowTerminal(value: boolean) {
          setStore("general", "showTerminal", value)
        },
        timelineDetail: withFallback(() => store.general?.timelineDetail, defaultSettings.general.timelineDetail),
        setTimelineDetail(value: TimelineDetail) {
          setStore("general", "timelineDetail", structuredClone(unwrap(value)))
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
        mobileDiffWrap: withFallback(() => store.general?.mobileDiffWrap, defaultSettings.general.mobileDiffWrap),
        setMobileDiffWrap(value: boolean) {
          setStore("general", "mobileDiffWrap", value)
        },
        terminalPlacement: withFallback(
          () => store.general?.terminalPlacement,
          defaultSettings.general.terminalPlacement,
        ),
        setTerminalPlacement(value: TerminalPlacement) {
          setStore("general", "terminalPlacement", value)
        },
        followUpBehavior: withFallback(() => store.general?.followUpBehavior, defaultSettings.general.followUpBehavior),
        setFollowUpBehavior(value: FollowUpBehavior) {
          setStore("general", "followUpBehavior", value)
        },
        experimentalBrowser: withFallback(
          () => store.general?.experimentalBrowser,
          defaultSettings.general.experimentalBrowser,
        ),
        setExperimentalBrowser(value: boolean) {
          setStore("general", "experimentalBrowser", value)
        },
      },
      sessionSummary: {
        projectExpanded: withFallback(
          () => store.sessionSummary?.projectExpanded,
          defaultSettings.sessionSummary.projectExpanded,
        ),
        serverExpanded: withFallback(
          () => store.sessionSummary?.serverExpanded,
          defaultSettings.sessionSummary.serverExpanded,
        ),
        setProjectExpanded(value: boolean) {
          setStore("sessionSummary", "projectExpanded", value)
        },
        setServerExpanded(value: boolean) {
          setStore("sessionSummary", "serverExpanded", value)
        },
      },
      visibility: {
        fileTree: showFileTree,
        search: showSearch,
        customAgents: showCustomAgents,
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
        tabLayout: withFallback(() => store.appearance?.tabLayout, defaultSettings.appearance.tabLayout),
        setTabLayout(value: TabLayout) {
          setStore("appearance", "tabLayout", value)
        },
        showProjectName: withFallback(
          () => store.appearance?.showProjectName,
          defaultSettings.appearance.showProjectName,
        ),
        setShowProjectName(value: boolean) {
          setStore("appearance", "showProjectName", value)
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
            return reconcile(next)(current)
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
      workspaces: {
        defaultDestination: withFallback(
          () => store.workspaces?.defaultDestination,
          defaultSettings.workspaces.defaultDestination,
        ),
        setDefaultDestination(value: WorkspaceDefaultDestination) {
          setStore("workspaces", (current) => ({
            ...defaultSettings.workspaces,
            ...current,
            defaultDestination: value,
          }))
        },
        lastUsed(scope: ServerScope, projectID: string) {
          return store.workspaces?.lastUsed?.[ScopedKey.from(scope, projectID)]
        },
        setLastUsed(scope: ServerScope, projectID: string, value: WorkspaceLastUsed) {
          setStore("workspaces", (current) => ({
            ...defaultSettings.workspaces,
            ...current,
            lastUsed: { ...current?.lastUsed, [ScopedKey.from(scope, projectID)]: value },
          }))
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
