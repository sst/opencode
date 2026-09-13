import { Component, Show, createMemo, createResource } from "solid-js"
import { createMediaQuery } from "@solid-primitives/media"
import { Button } from "@opencode/ui/button"
import { Select } from "@opencode/ui/select"
import { Switch } from "@opencode/ui/switch"
import { TextInput } from "@opencode/ui/text-input"
import { TimelineDetailControl } from "@/settings/timeline-detail"
import { useLanguage } from "@/runtime/i18n/language"
import { usePlatform } from "@/runtime/platform/platform"
import { useUpdaterAction } from "@/shell/updates/action"
import {
  type FollowUpBehavior,
  type TerminalPlacement,
  type WorkspaceDefaultDestination,
  useSettings,
} from "@/settings/model"
import { formatKeybind } from "@/shell/commands/command"
import { ExternalLink } from "@/runtime/platform/external-link"
import { SettingsList } from "@/settings/list"
import { SettingsRow } from "@/settings/row"
import {
  createAppearanceSettingsController,
  createShellOptions,
  type AppearanceSettingsController,
  type ShellSettingsController,
} from "./controllers"
import "@/settings/settings.css"

const schemeOptions: ("system" | "light" | "dark")[] = ["system", "light", "dark"]
const fontSettings = {
  ui: {
    action: "settings-ui-font",
    title: "settings.general.row.uiFont.title",
    description: "settings.general.row.uiFont.description",
    font: "ui",
    input: "setUI",
  },
  code: {
    action: "settings-code-font",
    title: "settings.general.row.font.title",
    description: "settings.general.row.font.description",
    font: "code",
    input: "setCode",
  },
  terminal: {
    action: "settings-terminal-font",
    title: "settings.general.row.terminalFont.title",
    description: "settings.general.row.terminalFont.description",
    font: "terminal",
    input: "setTerminal",
  },
} as const
const AutoApprovePermissionsSetting: Component = () => {
  const language = useLanguage()
  const settings = useSettings()
  return (
    <SettingsRow
      title={language.t("command.permissions.autoaccept.enable")}
      description={language.t("toast.permissions.autoaccept.on.description")}
    >
      <div data-action="settings-auto-accept-permissions">
        <Switch
          checked={settings.permissions.autoApprove()}
          onChange={(checked) => settings.permissions.setAutoApprove(checked)}
        />
      </div>
    </SettingsRow>
  )
}

const WorkspaceDestinationSetting: Component = () => {
  const language = useLanguage()
  const settings = useSettings()
  const options = createMemo((): { value: WorkspaceDefaultDestination; label: string }[] => [
    { value: "last-used", label: language.t("settings.workspaces.default.lastUsed") },
    { value: "local", label: language.t("settings.workspaces.default.local") },
    { value: "new", label: language.t("settings.workspaces.default.new") },
  ])

  return (
    <SettingsRow
      title={language.t("settings.workspaces.default.title")}
      description={language.t("settings.workspaces.default.description")}
    >
      <Select
        data-action="settings-workspace-destination"
        options={options()}
        current={options().find((option) => option.value === settings.workspaces.defaultDestination())}
        value={(option) => option.value}
        label={(option) => option.label}
        placement="bottom-end"
        gutter={6}
        onSelect={(option) => option && settings.workspaces.setDefaultDestination(option.value)}
      />
    </SettingsRow>
  )
}

export const ShellSetting: Component<{ controller: ShellSettingsController }> = (props) => {
  const language = useLanguage()
  const options = createMemo(() =>
    createShellOptions({
      shells: props.controller.shells(),
      current: props.controller.current(),
    }),
  )
  return (
    <SettingsRow
      title={language.t("settings.general.row.shell.title")}
      description={language.t("settings.general.row.shell.description")}
    >
      <Select
        data-action="settings-shell"
        options={options()}
        current={options().find((option) => option.value === props.controller.current()) ?? options()[0]}
        placement="bottom-end"
        gutter={6}
        value={(option) => option.id}
        label={(option) => {
          if (option.id === "auto") return language.t("settings.general.row.shell.autoDefault")
          if (!option.terminalOnly) return option.name
          return `${option.name} (${language.t("settings.general.row.shell.terminalOnly")})`
        }}
        onSelect={(option) => option && props.controller.select(option.value)}
      />
    </SettingsRow>
  )
}

const TerminalPlacementSetting: Component = () => {
  const language = useLanguage()
  const settings = useSettings()
  const options = createMemo((): { value: TerminalPlacement; label: string }[] => [
    { value: "side", label: language.t("settings.general.row.terminalPlacement.side") },
    { value: "bottom", label: language.t("settings.general.row.terminalPlacement.bottom") },
  ])

  return (
    <SettingsRow
      title={language.t("settings.general.row.terminalPlacement.title")}
      description={language.t("settings.general.row.terminalPlacement.description")}
    >
      <Select
        data-action="settings-terminal-placement"
        options={options()}
        current={options().find((option) => option.value === settings.general.terminalPlacement())}
        value={(option) => option.value}
        label={(option) => option.label}
        placement="bottom-end"
        gutter={6}
        onSelect={(option) => option && settings.general.setTerminalPlacement(option.value)}
      />
    </SettingsRow>
  )
}

const FollowUpBehaviorSetting: Component = () => {
  const language = useLanguage()
  const settings = useSettings()
  const options = createMemo((): { value: FollowUpBehavior; label: string }[] => [
    { value: "queue", label: language.t("settings.general.row.followUpBehavior.queue") },
    { value: "steer", label: language.t("settings.general.row.followUpBehavior.steer") },
  ])

  return (
    <SettingsRow
      title={language.t("settings.general.row.followUpBehavior.title")}
      description={language.t("settings.general.row.followUpBehavior.description", {
        keybind: formatKeybind("mod+enter", language.t),
      })}
    >
      <Select
        data-action="settings-follow-up-behavior"
        options={options()}
        current={options().find((option) => option.value === settings.general.followUpBehavior())}
        value={(option) => option.value}
        label={(option) => option.label}
        placement="bottom-end"
        gutter={6}
        onSelect={(option) => option && settings.general.setFollowUpBehavior(option.value)}
      />
    </SettingsRow>
  )
}

const AppearanceSection: Component<{ controller: AppearanceSettingsController }> = (props) => {
  const language = useLanguage()
  return (
    <div class="settings-section">
      <h3 class="settings-section-title">{language.t("settings.general.section.appearance")}</h3>
      <SettingsList>
        <SettingsRow
          title={language.t("settings.general.row.colorScheme.title")}
          description={language.t("settings.general.row.colorScheme.description")}
        >
          <Select
            data-action="settings-color-scheme"
            options={schemeOptions}
            current={schemeOptions.find((option) => option === props.controller.scheme.current())}
            placement="bottom-end"
            gutter={6}
            label={(option) => {
              if (option === "system") return language.t("theme.scheme.system")
              if (option === "light") return language.t("theme.scheme.light")
              return language.t("theme.scheme.dark")
            }}
            onSelect={(option) => option && props.controller.scheme.select(option)}
          />
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.general.row.theme.title")}
          description={
            <>
              {language.t("settings.general.row.theme.description")}{" "}
              <ExternalLink class="settings-link" href="https://opencode.ai/docs/themes/">
                {language.t("common.learnMore")}
              </ExternalLink>
            </>
          }
        >
          <Select
            data-action="settings-theme"
            options={props.controller.theme.options()}
            current={props.controller.theme.current()}
            placement="bottom-end"
            gutter={6}
            value={(option) => option.id}
            label={(option) => option.name}
            onSelect={props.controller.theme.select}
          />
        </SettingsRow>

        <FontSetting kind="ui" fonts={props.controller.fonts} />
        <FontSetting kind="code" fonts={props.controller.fonts} />
        <FontSetting kind="terminal" fonts={props.controller.fonts} />
      </SettingsList>
    </div>
  )
}

const FontSetting: Component<{
  kind: "ui" | "code" | "terminal"
  fonts: AppearanceSettingsController["fonts"]
}> = (props) => {
  const language = useLanguage()
  const config = () => fontSettings[props.kind]
  return (
    <SettingsRow title={language.t(config().title)} description={language.t(config().description)}>
      <div class="w-full sm:w-[220px]">
        <TextInput
          data-action={config().action}
          type="text"
          appearance="base"
          value={props.fonts[config().font]().value}
          onInput={(event) => props.fonts[config().input](event.currentTarget.value)}
          placeholder={props.fonts[config().font]().placeholder}
          spellcheck={false}
          autocorrect="off"
          autocomplete="off"
          autocapitalize="off"
          aria-label={language.t(config().title)}
          style={{ "font-family": props.fonts[config().font]().family }}
        />
      </div>
    </SettingsRow>
  )
}

const LanguageSetting = () => {
  const language = useLanguage()
  const options = createMemo(() =>
    language.locales.map((locale) => ({
      value: locale,
      label: language.label(locale),
    })),
  )
  return (
    <SettingsRow
      title={language.t("settings.general.row.language.title")}
      description={language.t("settings.general.row.language.description")}
    >
      <Select
        data-action="settings-language"
        options={options()}
        placement="bottom-end"
        gutter={6}
        current={options().find((option) => option.value === language.locale())}
        value={(option) => option.value}
        label={(option) => option.label}
        onSelect={(option) => option && language.setLocale(option.value)}
      />
    </SettingsRow>
  )
}

export const SettingsGeneral: Component = () => {
  const language = useLanguage()
  const platform = usePlatform()
  const settings = useSettings()
  const mobile = createMediaQuery("(max-width: 767px)")
  const updater = useUpdaterAction()
  const desktop = createMemo(() => platform.platform === "desktop")

  const [pinchZoom, { mutate: setPinchZoom }] = createResource(
    () => desktop() && "getPinchZoomEnabled" in platform,
    () => Promise.resolve(platform.getPinchZoomEnabled?.() ?? false).catch(() => false),
    { initialValue: false },
  )

  const onPinchZoomChange = (checked: boolean) => {
    setPinchZoom(checked)
    const update = platform.setPinchZoomEnabled?.(checked)
    if (!update) return
    void update.catch(() => setPinchZoom(!checked))
  }

  const GeneralSection = () => (
    <div class="settings-section">
      <h3 class="settings-section-title">{language.t("settings.general.section.general")}</h3>
      <SettingsList>
        <LanguageSetting />

        <WorkspaceDestinationSetting />
        <AutoApprovePermissionsSetting />

        <SettingsRow
          title={language.t("settings.general.row.showCustomAgents.title")}
          description={language.t("settings.general.row.showCustomAgents.description")}
        >
          <div data-action="settings-show-custom-agents">
            <Switch
              checked={settings.general.showCustomAgents()}
              onChange={(checked) => settings.general.setShowCustomAgents(checked)}
            />
          </div>
        </SettingsRow>

        <TerminalPlacementSetting />
        <FollowUpBehaviorSetting />

        <Show when={desktop()}>
          <SettingsRow
            title={language.t("settings.general.row.pinchZoom.title")}
            description={language.t("settings.general.row.pinchZoom.description")}
          >
            <div data-action="settings-pinch-zoom">
              <Switch checked={pinchZoom.latest} onChange={onPinchZoomChange} />
            </div>
          </SettingsRow>
        </Show>

        <SettingsRow
          title={language.t("session.review.wrapLines")}
          description={language.t("settings.general.row.mobileDiffWrap.description")}
        >
          <div data-action="settings-mobile-diff-wrap">
            <Switch
              aria-label={language.t("session.review.wrapLines")}
              checked={settings.general.mobileDiffWrap()}
              onChange={settings.general.setMobileDiffWrap}
              hideLabel
            >
              {language.t("session.review.wrapLines")}
            </Switch>
          </div>
        </SettingsRow>

        <Show when={mobile() && import.meta.env.VITE_OPENCODE_CHANNEL !== "prod"}>
          <SettingsRow
            title={language.t("settings.general.row.mobileTitlebarBottom.title")}
            description={language.t("settings.general.row.mobileTitlebarBottom.description")}
          >
            <div data-action="settings-mobile-titlebar-bottom">
              <Switch
                checked={settings.general.mobileTitlebarPosition() === "bottom"}
                onChange={(checked) => settings.general.setMobileTitlebarPosition(checked ? "bottom" : "top")}
              />
            </div>
          </SettingsRow>
        </Show>
      </SettingsList>
    </div>
  )

  const NotificationsSection = () => (
    <div class="settings-section">
      <h3 class="settings-section-title">{language.t("settings.general.section.notifications")}</h3>

      <SettingsList>
        <SettingsRow
          title={language.t("settings.general.notifications.agent.title")}
          description={language.t("settings.general.notifications.agent.description")}
        >
          <div data-action="settings-notifications-agent">
            <Switch
              checked={settings.notifications.agent()}
              onChange={(checked) => settings.notifications.setAgent(checked)}
            />
          </div>
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.general.notifications.permissions.title")}
          description={language.t("settings.general.notifications.permissions.description")}
        >
          <div data-action="settings-notifications-permissions">
            <Switch
              checked={settings.notifications.permissions()}
              onChange={(checked) => settings.notifications.setPermissions(checked)}
            />
          </div>
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.general.notifications.errors.title")}
          description={language.t("settings.general.notifications.errors.description")}
        >
          <div data-action="settings-notifications-errors">
            <Switch
              checked={settings.notifications.errors()}
              onChange={(checked) => settings.notifications.setErrors(checked)}
            />
          </div>
        </SettingsRow>
      </SettingsList>
    </div>
  )

  const UpdatesSection = () => (
    <div class="settings-section">
      <h3 class="settings-section-title">{language.t("settings.general.section.updates")}</h3>

      <SettingsList>
        <SettingsRow
          title={language.t("settings.general.row.releaseNotes.title")}
          description={language.t("settings.general.row.releaseNotes.description")}
        >
          <div data-action="settings-release-notes">
            <Switch
              checked={settings.general.releaseNotes()}
              onChange={(checked) => settings.general.setReleaseNotes(checked)}
            />
          </div>
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.updates.row.check.title")}
          description={language.t("settings.updates.row.check.description")}
        >
          <Button
            data-action="settings-check-updates"
            size="normal"
            variant="neutral"
            disabled={!updater.action().run}
            onClick={() => updater.run()}
          >
            {language.t(updater.action().label)}
          </Button>
        </SettingsRow>
      </SettingsList>
    </div>
  )

  return (
    <>
      <div class="settings-tab-header">
        <div class="settings-tab-header-row">
          <div class="flex flex-col gap-1">
            <h2 class="settings-tab-title">{language.t("settings.tab.preferences")}</h2>
            <span class="text-11-regular text-v2-text-text-muted">
              {language.t("settings.preferences.description")}
            </span>
          </div>
        </div>
      </div>
      <div class="settings-tab-body settings-tab-body--sectioned">
        <GeneralSection />

        <section class="settings-section" aria-label={language.t("settings.timeline.title")}>
          <h3 class="settings-section-title">{language.t("settings.timeline.title")}</h3>
          <SettingsList>
            <div class="py-5">
              <TimelineDetailControl
                value={settings.general.timelineDetail()}
                onChange={settings.general.setTimelineDetail}
              />
            </div>
          </SettingsList>
        </section>

        <Show when={desktop()}>
          <UpdatesSection />
        </Show>
      </div>
    </>
  )
}
