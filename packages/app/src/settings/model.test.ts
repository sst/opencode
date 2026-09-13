import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { timelinePresets } from "@opencode/session-ui/timeline/detail"
import { Persistence } from "@/runtime/persistence/schema"
import {
  settingsSchema,
  settingsPersistence,
  defaultSettings,
  monoDefault,
  monoFontFamily,
  sansDefault,
  sansFontFamily,
  terminalFontFamily,
} from "./model"

const schema = Persistence.withInitial(settingsPersistence, defaultSettings)
const decode = Schema.decodeUnknownSync(schema)
const encode = Schema.encodeSync(schema)

describe("settings timeline detail migration", () => {
  test("migrates saved switches and round trips the current settings", () => {
    const settings = decode({
      general: { shellToolPartsExpanded: true, editToolPartsExpanded: false, showReasoningSummaries: true },
      appearance: { fontSize: 16 },
    })
    expect(settings.general.timelineDetail).toEqual({
      ...timelinePresets[2].value,
      shell: { placement: "separate", details: "expanded" },
      thinking: { placement: "separate", details: "expanded" },
    })
    expect(settings.appearance.fontSize).toBe(16)
    expect(decode(encode(settings))).toEqual(settings)
  })
})

describe("settings schema", () => {
  test("restores summary expansion and discards the retired status preference", () => {
    const settings = decode({
      general: { showStatus: true, showSearch: true },
      sessionSummary: { projectExpanded: false, serverExpanded: true },
    })
    expect(settings.general.showSearch).toBe(true)
    expect(settings.general).not.toHaveProperty("showStatus")
    expect(settings.sessionSummary).toEqual({ projectExpanded: false, serverExpanded: true })
    expect(decode(encode(settings)).sessionSummary).toEqual(settings.sessionSummary)
  })

  test("uses the supplied initial values independently of the current schema", () => {
    const initial = {
      ...defaultSettings,
      general: { ...defaultSettings.general, timelineDetail: timelinePresets[4].value, autoSave: false },
      appearance: { ...defaultSettings.appearance, fontSize: 20 },
    }
    const restore = Schema.decodeUnknownSync(Persistence.withInitial(settingsPersistence, initial))
    expect(restore({})).toEqual(initial)
    expect(restore({ general: { reasoningMode: "invalid", showReasoningSummaries: true } })).toEqual(initial)
    expect(restore({ general: { showReasoningSummaries: true } }).general.timelineDetail.thinking).toEqual({
      placement: "separate",
      details: "expanded",
    })
    expect(() => Schema.decodeUnknownSync(settingsSchema)({})).toThrow()
  })

  test("supplies the existing defaults for an empty document", () => {
    expect(decode({})).toEqual({
      general: {
        autoSave: true,
        releaseNotes: true,
        showFileTree: false,
        showNavigation: false,
        showSearch: false,
        showProjectIcon: false,
        showTerminal: false,
        timelineDetail: timelinePresets[2].value,
        showCustomAgents: false,
        mobileTitlebarPosition: "top",
        mobileDiffWrap: true,
        terminalPlacement: "side",
        followUpBehavior: "steer",
        experimentalBrowser: false,
      },
      sessionSummary: { projectExpanded: true, serverExpanded: true },
      appearance: {
        fontSize: 14,
        mono: "",
        sans: "",
        terminal: "",
        tabLayout: "horizontal",
        showProjectName: false,
      },
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
    })
  })

  test("defaults invalid preferences locally while retaining valid siblings", () => {
    const settings = decode({
      general: {
        showTerminal: true,
        autoSave: false,
        releaseNotes: undefined,
        reasoningMode: 3,
        followUpBehavior: "invalid",
      },
      appearance: { fontSize: "large", mono: "Custom Mono", tabLayout: "vertical", showProjectName: true },
      permissions: { autoApprove: true },
      workspaces: { defaultDestination: "new", lastUsed: { good: "workspace", bad: true } },
      keybinds: { good: "ctrl+k", bad: 3 },
      notifications: { agent: false, permissions: "yes", errors: true },
      sounds: { agent: "custom", agentEnabled: false, permissions: 3 },
    })
    expect(settings.general).toMatchObject({
      showTerminal: true,
      autoSave: false,
      releaseNotes: true,
      timelineDetail: timelinePresets[2].value,
      followUpBehavior: "steer",
    })
    expect(settings.appearance).toEqual({
      fontSize: 14,
      mono: "Custom Mono",
      sans: "",
      terminal: "",
      tabLayout: "vertical",
      showProjectName: true,
    })
    expect(settings.permissions.autoApprove).toBe(true)
    expect(settings.workspaces).toEqual({ defaultDestination: "new", lastUsed: { good: "workspace" } })
    expect(settings.keybinds).toEqual({ good: "ctrl+k" })
    expect(settings.notifications).toEqual({ agent: false, permissions: true, errors: true })
    expect(settings.sounds).toMatchObject({ agent: "custom", agentEnabled: false, permissions: "staplebops-02" })
    expect(decode(encode(settings))).toEqual(settings)
  })

  test("browser attachment is opt-in and preserves an explicit choice", () => {
    expect(decode({}).general.experimentalBrowser).toBe(false)
    expect(decode({ general: { experimentalBrowser: true } }).general.experimentalBrowser).toBe(true)
    expect(decode({ general: { experimentalBrowser: false } }).general.experimentalBrowser).toBe(false)
  })

  test.each([undefined, null, false, 7, "invalid", []].map((invalid) => [invalid]))(
    "defaults malformed sections without losing other sections: %j",
    (invalid) => {
      const defaults = decode({})
      expect(
        decode({
          general: invalid,
          appearance: { fontSize: 18 },
          keybinds: invalid,
          permissions: invalid,
          workspaces: invalid,
          notifications: invalid,
          sounds: invalid,
        }),
      ).toEqual({
        ...defaults,
        appearance: { ...defaults.appearance, fontSize: 18 },
      })
    },
  )

  test("does not silently repair invalid values during encoding", () => {
    expect(() =>
      Schema.encodeUnknownSync(settingsSchema)({ ...decode({}), appearance: { fontSize: "large" } }),
    ).toThrow()
  })
})

describe("settings font families", () => {
  test("defaults normal text to Inter", () => {
    expect(sansDefault).toBe("Inter")
    expect(sansFontFamily(undefined)).toStartWith('"Inter", ')
    expect(sansFontFamily("")).toStartWith('"Inter", ')
    expect(sansFontFamily("   ")).toStartWith('"Inter", ')
  })

  test("keeps custom normal fonts ahead of the default", () => {
    expect(sansFontFamily("Custom Sans")).toStartWith('"Custom Sans", "Inter", ')
  })

  test("defaults monospace text to IBM Plex Mono", () => {
    expect(monoDefault).toBe("IBM Plex Mono")
    expect(monoFontFamily(undefined)).toStartWith('"IBM Plex Mono", ')
    expect(monoFontFamily("")).toStartWith('"IBM Plex Mono", ')
    expect(monoFontFamily("   ")).toStartWith('"IBM Plex Mono", ')
  })

  test("keeps custom monospace fonts ahead of the default", () => {
    expect(monoFontFamily("Custom Mono")).toStartWith('"Custom Mono", "IBM Plex Mono", ')
  })

  test("preserves the separate terminal font default", () => {
    expect(terminalFontFamily(undefined)).toStartWith('"JetBrainsMono Nerd Font Mono", ')
  })
})
