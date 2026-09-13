import { createMemo, createResource, onMount, type Accessor } from "solid-js"
import type { ConfigPreferences, ConfigUpdatePreferencesInput } from "@opencode/client/promise"
import type { ColorScheme } from "@opencode/ui/theme/context"
import { useTheme } from "@opencode/ui/theme/context"
import {
  monoDefault,
  monoFontFamily,
  monoInput,
  sansDefault,
  sansFontFamily,
  sansInput,
  terminalDefault,
  terminalFontFamily,
  terminalInput,
  useSettings,
} from "@/settings/model"
import { playSoundById, SOUND_OPTIONS } from "@/shell/notifications/sound"
import { createSoundPreviewController } from "./behavior"
import { ServerConnection } from "@/runtime/server/registry"
import { useServerCtx } from "@/runtime/server/runtime"
import { useLanguage } from "@/runtime/i18n/language"
import { showToast } from "@/shell/notifications/toast"

export { createShellOptions, createSoundPreviewController } from "./behavior"
export type { ShellOption, ShellSelectOption } from "./behavior"

export function createServerPreferencesController(server: Accessor<ServerConnection.Any>) {
  const language = useLanguage()
  const serverCtx = useServerCtx(server)
  const source = () => ServerConnection.key(server())
  const [preferences, preferencesActions] = createResource<ConfigPreferences, ServerConnection.Key>(
    source,
    () =>
      serverCtx()
        .sdk.api.config.preferences()
        .catch(() => ({})),
    { initialValue: {} },
  )
  const [shells] = createResource(
    source,
    () =>
      serverCtx()
        .sdk.api.config.shells()
        .catch(() => []),
    { initialValue: [] },
  )
  const [providers] = createResource(
    source,
    () =>
      serverCtx()
        .sdk.api.websearch.providers()
        .then((result) => result.data)
        .catch(() => []),
    { initialValue: [] },
  )

  const update = async (patch: ConfigUpdatePreferencesInput) => {
    const context = serverCtx()
    const previous = preferences.latest
    preferencesActions.mutate({
      ...previous,
      ...(patch.shell === undefined ? {} : { shell: patch.shell ?? undefined }),
      ...(patch.websearch === undefined ? {} : { websearch: patch.websearch ?? undefined }),
    })
    await context.sdk.api.config
      .updatePreferences(patch)
      .then(preferencesActions.mutate)
      .catch((error: unknown) => {
        preferencesActions.mutate(previous)
        showToast({
          variant: "error",
          title: language.t("common.requestFailed"),
          description: error instanceof Error ? error.message : language.t("common.requestFailed"),
        })
      })
  }

  const websearchOptions = createMemo(() => {
    const options = providers.latest.map((provider) => ({ value: provider.id, label: provider.name }))
    const selected = preferences.latest.websearch
    const configured = selected && selected.provider !== "random" ? selected.provider : undefined
    return [
      { value: "random" as const, label: language.t("session.websearch.any") },
      ...options,
      ...(configured && !options.some((option) => option.value === configured)
        ? [{ value: configured, label: configured }]
        : []),
      { value: false as const, label: language.t("session.websearch.disable") },
    ]
  })
  const websearchCurrent = createMemo(() => {
    const selection = preferences.latest.websearch
    const value = selection === false ? false : (selection?.provider ?? "random")
    return websearchOptions().find((option) => option.value === value) ?? websearchOptions()[0]
  })

  return {
    shell: {
      shells: () => shells.latest,
      current: () => preferences.latest.shell ?? "",
      select: (value: string) => {
        if (value === (preferences.latest.shell ?? "")) return
        void update({ shell: value || null })
      },
    },
    websearch: {
      options: websearchOptions,
      current: websearchCurrent,
      select: (value: string | false) => {
        void update({ websearch: value === false ? false : { provider: value } })
      },
    },
  }
}

export function createAppearanceSettingsController() {
  const settings = useSettings()
  const theme = useTheme()
  const themes = createMemo(() => theme.ids().map((id) => ({ id, name: theme.name(id) })))

  onMount(() => void theme.loadThemes())

  return {
    scheme: {
      current: theme.colorScheme,
      select: (value: ColorScheme) => theme.setColorScheme(value),
    },
    theme: {
      options: themes,
      current: createMemo(() => themes().find((option) => option.id === theme.themeId())),
      select: (option: { id: string } | null) => option && theme.setTheme(option.id),
    },
    fonts: {
      ui: createMemo(() => ({
        value: sansInput(settings.appearance.uiFont()),
        family: sansFontFamily(settings.appearance.uiFont()),
        placeholder: sansDefault,
      })),
      code: createMemo(() => ({
        value: monoInput(settings.appearance.font()),
        family: monoFontFamily(settings.appearance.font()),
        placeholder: monoDefault,
      })),
      terminal: createMemo(() => ({
        value: terminalInput(settings.appearance.terminalFont()),
        family: terminalFontFamily(settings.appearance.terminalFont()),
        placeholder: terminalDefault,
      })),
      setUI: (value: string) => settings.appearance.setUIFont(value),
      setCode: (value: string) => settings.appearance.setFont(value),
      setTerminal: (value: string) => settings.appearance.setTerminalFont(value),
    },
  }
}

const noneSound = { id: "none", label: "sound.option.none" } as const
export const soundOptions = [noneSound, ...SOUND_OPTIONS]
export type SoundSelectOption = (typeof soundOptions)[number]

export function createSoundSettingsController() {
  const settings = useSettings()
  const preview = createSoundPreviewController(playSoundById)
  const channel = (
    enabled: Accessor<boolean>,
    current: Accessor<string>,
    setEnabled: (value: boolean) => void,
    set: (id: string) => void,
  ) => ({
    current: createMemo(() =>
      enabled() ? (soundOptions.find((option) => option.id === current()) ?? noneSound) : noneSound,
    ),
    highlight: (option: SoundSelectOption | undefined) => {
      if (!option) return
      preview.play(option.id === "none" ? undefined : option.id)
    },
    select: (option: SoundSelectOption | null) => {
      if (!option) return
      if (option.id === "none") {
        setEnabled(false)
        preview.stop()
        return
      }
      setEnabled(true)
      set(option.id)
      preview.play(option.id)
    },
  })

  return {
    agent: channel(
      settings.sounds.agentEnabled,
      settings.sounds.agent,
      (value) => settings.sounds.setAgentEnabled(value),
      (id) => settings.sounds.setAgent(id),
    ),
    permissions: channel(
      settings.sounds.permissionsEnabled,
      settings.sounds.permissions,
      (value) => settings.sounds.setPermissionsEnabled(value),
      (id) => settings.sounds.setPermissions(id),
    ),
    errors: channel(
      settings.sounds.errorsEnabled,
      settings.sounds.errors,
      (value) => settings.sounds.setErrorsEnabled(value),
      (id) => settings.sounds.setErrors(id),
    ),
  }
}

export type ShellSettingsController = ReturnType<typeof createServerPreferencesController>["shell"]
export type AppearanceSettingsController = ReturnType<typeof createAppearanceSettingsController>
export type SoundSettingsController = ReturnType<typeof createSoundSettingsController>
