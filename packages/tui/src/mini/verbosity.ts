import type { MiniSettingChange, MiniSettings, MiniVerbosity } from "./types"

const levels: readonly MiniVerbosity[] = ["quiet", "default", "everything"]

const knobs = ["thinking", "tools", "shell_output", "turn_summary", "footer"] as const

type VerbosityKnobs = Pick<MiniSettings, (typeof knobs)[number]>

const presets = {
  quiet: {
    thinking: "hide",
    tools: "hide",
    shell_output: "hide",
    turn_summary: "hide",
    footer: "hide",
  },
  default: {
    thinking: "show",
    tools: "hide",
    shell_output: "hide",
    turn_summary: "show",
    footer: "show",
  },
  everything: {
    thinking: "show",
    tools: "show",
    shell_output: "show",
    turn_summary: "show",
    footer: "show",
  },
} as const satisfies Record<MiniVerbosity, VerbosityKnobs>

const labels = {
  quiet: "Quiet",
  default: "Default",
  everything: "Everything",
  custom: "Custom",
} as const

export function verbosityPreset(level: MiniVerbosity): VerbosityKnobs {
  return { ...presets[level] }
}

export function verbosityLabel(level: MiniVerbosity | "custom") {
  return labels[level]
}

export function matchMiniVerbosity(settings: MiniSettings): MiniVerbosity | "custom" {
  for (const level of levels) {
    if (knobs.every((key) => settings[key] === presets[level][key])) return level
  }
  return "custom"
}

export function cycleMiniVerbosity(settings: MiniSettings, direction: 1 | -1): MiniVerbosity {
  const current = matchMiniVerbosity(settings)
  const index = current === "custom" ? nearestMiniVerbosity(settings) : levels.indexOf(current)
  const next = index + direction
  if (next < 0) return levels[0]!
  if (next >= levels.length) return levels[levels.length - 1]!
  return levels[next]!
}

export function verbosityChange(settings: MiniSettings, direction: 1 | -1): MiniSettingChange | undefined {
  const value = cycleMiniVerbosity(settings, direction)
  if (matchMiniVerbosity(settings) === value) return
  return { key: "verbosity", value }
}

export function applyMiniSettingChange(settings: MiniSettings, change: MiniSettingChange): MiniSettings {
  if (change.key === "verbosity") return { ...settings, ...verbosityPreset(change.value) }
  return { ...settings, [change.key]: change.value }
}

function nearestMiniVerbosity(settings: MiniSettings) {
  return levels.reduce((best, level, index) => {
    if (verbosityDistance(settings, level) < verbosityDistance(settings, levels[best]!)) return index
    return best
  }, 0)
}

function verbosityDistance(settings: MiniSettings, level: MiniVerbosity) {
  return knobs.filter((key) => settings[key] !== presets[level][key]).length
}
