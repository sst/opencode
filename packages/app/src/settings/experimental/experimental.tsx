import { Component, Show } from "solid-js"
import { Select } from "@opencode/ui/select"
import { Switch } from "@opencode/ui/switch"
import { useLanguage } from "@/runtime/i18n/language"
import { usePlatform } from "@/runtime/platform/platform"
import { SettingsList } from "@/settings/list"
import { useSettings } from "@/settings/model"
import { SettingsRow } from "@/settings/row"
import "@/settings/settings.css"

const tabLayoutOptions: ("horizontal" | "vertical")[] = ["horizontal", "vertical"]

export const SettingsExperimental: Component = () => {
  const language = useLanguage()
  const settings = useSettings()
  const platform = usePlatform()

  return (
    <>
      <div class="settings-tab-header">
        <div class="settings-tab-header-row">
          <div class="flex flex-col gap-1">
            <h2 class="settings-tab-title">{language.t("settings.tab.experimental")}</h2>
            <span class="text-11-regular text-v2-text-text-muted">
              {language.t("settings.experimental.description")}
            </span>
          </div>
        </div>
      </div>

      <div class="settings-tab-body">
        <div class="settings-section">
          <SettingsList>
            <SettingsRow
              title={language.t("settings.appearance.row.tabs.title")}
              description={language.t("settings.appearance.row.tabs.description")}
            >
              <Select
                data-action="settings-tab-layout"
                options={tabLayoutOptions}
                current={tabLayoutOptions.find((option) => option === settings.appearance.tabLayout())}
                placement="bottom-end"
                gutter={6}
                label={(option) =>
                  option === "horizontal"
                    ? language.t("settings.appearance.row.tabs.horizontal")
                    : language.t("settings.appearance.row.tabs.vertical")
                }
                onSelect={(option) => option && settings.appearance.setTabLayout(option)}
              />
            </SettingsRow>
            <Show when={platform.browserPane}>
              <SettingsRow
                title={language.t("settings.general.row.browserPane.title")}
                description={language.t("settings.general.row.browserPane.description")}
              >
                <div data-action="settings-experimental-browser">
                  <Switch
                    checked={settings.general.experimentalBrowser()}
                    onChange={settings.general.setExperimentalBrowser}
                    hideLabel
                  >
                    {language.t("settings.general.row.browserPane.title")}
                  </Switch>
                </div>
              </SettingsRow>
            </Show>
            <SettingsRow
              title={language.t("settings.appearance.row.projectName.title")}
              description={language.t("settings.appearance.row.projectName.description")}
            >
              <div data-action="settings-show-project-name">
                <Switch
                  checked={settings.appearance.showProjectName()}
                  onChange={settings.appearance.setShowProjectName}
                  hideLabel
                >
                  {language.t("settings.appearance.row.projectName.title")}
                </Switch>
              </div>
            </SettingsRow>
            <Show when={import.meta.env.VITE_OPENCODE_CHANNEL !== "prod"}>
              <SettingsRow
                title={language.t("settings.general.row.showProjectIcon.title")}
                description={language.t("settings.general.row.showProjectIcon.description")}
              >
                <div data-action="settings-show-project-icon">
                  <Switch
                    checked={settings.general.showProjectIcon()}
                    onChange={settings.general.setShowProjectIcon}
                    hideLabel
                  >
                    {language.t("settings.general.row.showProjectIcon.title")}
                  </Switch>
                </div>
              </SettingsRow>
            </Show>
          </SettingsList>
        </div>
      </div>
    </>
  )
}
