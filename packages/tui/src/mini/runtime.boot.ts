// Boot-time resolution for direct interactive mode.
//
// These functions run concurrently at startup to gather everything the runtime
// needs before the first frame: TUI keymap config, model catalog, and session history for the prompt
// history ring. All are async because they read config or hit the SDK, but
// none block each other.
import type { LocationRef } from "@opencode/client/promise"
import { resolve } from "../config"
import { loadRunProviders } from "./catalog.shared"
import { resolveCurrentSession, sessionHistory } from "./session.shared"
import type { MiniSettings, RunInput, RunPrompt, RunProvider, RunTuiConfig } from "./types"
import { pickVariant } from "./variant.shared"

export type ModelInfo = {
  providers: RunProvider[]
}

export type SessionInfo = {
  first: boolean
  history: RunPrompt[]
  model?: NonNullable<RunInput["model"]>
  variant: string | undefined
}

function emptyModelInfo(): ModelInfo {
  return {
    providers: [],
  }
}

function emptySessionInfo(): SessionInfo {
  return {
    first: true,
    history: [],
    variant: undefined,
  }
}

function defaultRunTuiConfig(platform: NodeJS.Platform): RunTuiConfig {
  return resolve({}, { terminalSuspend: platform !== "win32" })
}

async function loadModelInfo(sdk: RunInput["sdk"], location: LocationRef, signal?: AbortSignal): Promise<ModelInfo> {
  return { providers: await loadRunProviders(sdk, location, signal) }
}

// Fetches available providers and variants.
export async function resolveModelInfo(
  sdk: RunInput["sdk"],
  location: LocationRef,
  signal?: AbortSignal,
): Promise<ModelInfo> {
  return loadModelInfo(sdk, location, signal).catch(() => emptyModelInfo())
}

export function resolveModelInfoStrict(sdk: RunInput["sdk"], location: LocationRef, signal?: AbortSignal) {
  return loadModelInfo(sdk, location, signal)
}

// Fetches session messages to determine if this is the first turn and build prompt history.
export async function resolveSessionInfo(
  sdk: RunInput["sdk"],
  sessionID: string,
  model: RunInput["model"],
  signal?: AbortSignal,
): Promise<SessionInfo> {
  return resolveCurrentSession(sdk, sessionID, signal)
    .then((session) => ({
      first: session.first,
      history: sessionHistory(session),
      model: session.model,
      variant: pickVariant(model ?? session.model, session),
    }))
    .catch(() => emptySessionInfo())
}

// Reads TUI config once for direct mode keymap setup and display preferences.
export async function resolveRunTuiConfig(
  config?: RunTuiConfig | Promise<RunTuiConfig>,
  platform: NodeJS.Platform = "linux",
): Promise<RunTuiConfig> {
  return Promise.resolve(config)
    .then((value) => value ?? defaultRunTuiConfig(platform))
    .catch(() => defaultRunTuiConfig(platform))
}

export function resolveMiniSettings(config?: { mini?: Partial<MiniSettings> }): MiniSettings {
  return {
    thinking: config?.mini?.thinking ?? "show",
    tools: config?.mini?.tools ?? "hide",
    shell_output: config?.mini?.shell_output ?? "hide",
    turn_summary: config?.mini?.turn_summary ?? "show",
    footer: config?.mini?.footer ?? "show",
    splash: config?.mini?.splash ?? "show",
    work_spinner: config?.mini?.work_spinner ?? "block-soft-slide",
    mono: config?.mini?.mono ?? false,
  }
}
