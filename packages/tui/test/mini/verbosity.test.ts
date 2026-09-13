import { expect, test } from "bun:test"
import { resolveMiniSettings } from "../../src/mini/runtime.boot"
import {
  applyMiniSettingChange,
  cycleMiniVerbosity,
  matchMiniVerbosity,
  verbosityChange,
  verbosityLabel,
  verbosityPreset,
} from "../../src/mini/verbosity"

test("default Mini settings match the default verbosity preset", () => {
  expect(matchMiniVerbosity(resolveMiniSettings())).toBe("default")
})

test("verbosity presets leave splash, spinner, and mono alone", () => {
  const current = resolveMiniSettings({ mini: { splash: "hide", work_spinner: "seed", mono: true } })
  const quiet = applyMiniSettingChange(current, { key: "verbosity", value: "quiet" })
  expect(quiet).toEqual({
    ...current,
    ...verbosityPreset("quiet"),
  })
  expect(quiet.splash).toBe("hide")
  expect(quiet.footer).toBe("hide")
  expect(applyMiniSettingChange(current, { key: "verbosity", value: "everything" }).mono).toBe(true)
  expect(applyMiniSettingChange(current, { key: "thinking", value: "show" }).thinking).toBe("show")
})

test("individual knobs mark verbosity custom until a preset matches again", () => {
  const louder = applyMiniSettingChange(resolveMiniSettings(), { key: "tools", value: "show" })
  expect(matchMiniVerbosity(louder)).toBe("custom")
  expect(verbosityLabel("custom")).toBe("Custom")
  expect(matchMiniVerbosity(applyMiniSettingChange(louder, { key: "verbosity", value: "quiet" }))).toBe("quiet")
})

test("verbosity cycles like a clamped slider", () => {
  const settings = resolveMiniSettings()
  expect(cycleMiniVerbosity(settings, 1)).toBe("everything")
  expect(cycleMiniVerbosity(settings, -1)).toBe("quiet")
  expect(cycleMiniVerbosity({ ...settings, ...verbosityPreset("quiet") }, -1)).toBe("quiet")
  expect(cycleMiniVerbosity({ ...settings, ...verbosityPreset("everything") }, 1)).toBe("everything")
  expect(verbosityChange({ ...settings, ...verbosityPreset("quiet") }, -1)).toBeUndefined()
  expect(verbosityChange(settings, 1)).toEqual({ key: "verbosity", value: "everything" })
  expect(verbosityLabel("quiet")).toBe("Quiet")
  expect(verbosityLabel("everything")).toBe("Everything")
})

test("custom verbosity moves toward the nearest preset", () => {
  const custom = applyMiniSettingChange(resolveMiniSettings(), { key: "tools", value: "show" })
  expect(matchMiniVerbosity(custom)).toBe("custom")
  expect(cycleMiniVerbosity(custom, 1)).toBe("everything")
  expect(cycleMiniVerbosity(custom, -1)).toBe("quiet")
})
