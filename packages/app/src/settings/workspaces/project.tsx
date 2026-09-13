import { Icon } from "@opencode/ui/icon"
import { ProjectAvatar, PROJECT_AVATAR_VARIANTS } from "@opencode/ui/project-avatar"
import { Textarea } from "@opencode/ui/textarea"
import { TextInput } from "@opencode/ui/text-input"
import { For, Show, type Component } from "solid-js"
import { useLanguage } from "@/runtime/i18n/language"
import { getProjectAvatarVariant, type LocalProject } from "@/shell/state/layout"
import { ServerConnection, serverName } from "@/runtime/server/registry"
import { useSettingsServers } from "@/settings/servers/inventory"
import { displayName } from "@/shell/layout/helpers"
import { ProjectIcon } from "@/shell/layout/project-icon"
import { SettingsList } from "@/settings/list"
import { SettingsRow } from "@/settings/row"
import { createEditProjectModel } from "./project-model"
import "./project.css"

export const SettingsProjectGeneral: Component<{
  project: LocalProject
  server: ServerConnection.Any
  onOpenServer: () => void
}> = (props) => {
  const language = useLanguage()
  const model = createEditProjectModel(props)
  const servers = useSettingsServers()

  return (
    <>
      <div class="settings-tab-header">
        <div class="settings-tab-header-row">
          <div class="flex min-w-0 flex-col gap-1">
            <h2 class="settings-tab-title truncate">
              <bdi dir="auto">{model.store.name || displayName(props.project)}</bdi>
            </h2>
            <Show when={servers().length > 1}>
              <button type="button" class="project-settings-server-link" onClick={() => props.onOpenServer()}>
                <bdi dir="auto">{serverName(props.server) || ServerConnection.key(props.server)}</bdi>
              </button>
            </Show>
          </div>
        </div>
      </div>

      <div class="settings-tab-body project-settings-general" aria-busy={model.store.saving > 0}>
        <SettingsList>
          <SettingsRow
            title={language.t("project.settings.name.title")}
            description={language.t("project.settings.name.description")}
          >
            <div class="project-settings-name">
              <TextInput
                data-action="settings-project-name"
                type="text"
                appearance="base"
                value={model.store.name}
                placeholder={model.folderName()}
                aria-label={language.t("project.settings.name.title")}
                onInput={(event) => model.setStore("name", event.currentTarget.value)}
                onBlur={model.saveName}
              />
            </div>
          </SettingsRow>

          <SettingsRow
            title={language.t("dialog.project.edit.icon")}
            description={language.t("project.settings.icon.description")}
          >
            <button
              data-action="settings-project-icon"
              type="button"
              aria-label={language.t("dialog.project.edit.icon.alt")}
              class="project-settings-icon"
              classList={{ "project-settings-icon--active": model.store.dragOver }}
              onMouseEnter={() => model.setStore("iconHover", true)}
              onMouseLeave={() => model.setStore("iconHover", false)}
              onDrop={(event) => model.drop(event)}
              onDragOver={(event) => model.dragOver(event)}
              onDragLeave={() => model.dragLeave()}
              onClick={() => model.iconClick()}
            >
              <ProjectIcon
                project={props.project}
                fallback={model.store.name || model.defaultName()}
                icon={{
                  color: model.store.color,
                  url: props.project.icon?.url,
                  override: model.store.iconOverride,
                }}
                class="!size-8 [&_[data-slot=project-avatar-surface]]:!rounded-[6px] [&_[data-slot=project-avatar-surface]]:!text-[16px]"
              />
              <span classList={{ "project-settings-icon-overlay": true, visible: model.store.iconHover }}>
                <Icon name={model.store.iconOverride ? "close" : "share"} />
              </span>
            </button>
            <input
              ref={(element) => model.setIconInput(element)}
              type="file"
              accept="image/*"
              class="hidden"
              onChange={(event) => model.inputChange(event.currentTarget)}
            />
          </SettingsRow>

          <Show when={!model.store.iconOverride}>
            <SettingsRow
              title={language.t("dialog.project.edit.color")}
              description={language.t("project.settings.color.description")}
            >
              <div class="project-settings-colors" data-action="settings-project-color">
                <For each={PROJECT_AVATAR_VARIANTS}>
                  {(color) => {
                    const selected = () => getProjectAvatarVariant(model.store.color) === color
                    return (
                      <button
                        type="button"
                        aria-label={language.t("dialog.project.edit.color.select", { color })}
                        aria-pressed={selected()}
                        class="project-settings-color"
                        classList={{ "project-settings-color--selected": selected() }}
                        onClick={() => model.setColor(selected() ? undefined : color)}
                      >
                        <ProjectAvatar
                          fallback=""
                          variant={color}
                          class="!size-5 [&_[data-slot=project-avatar-surface]]:!rounded-[6px]"
                        />
                        <Show when={selected()}>
                          <Icon name="check" size="small" class="project-settings-color-check" />
                        </Show>
                      </button>
                    )
                  }}
                </For>
              </div>
            </SettingsRow>
          </Show>

          <div class="project-settings-startup">
            <div class="project-settings-startup-copy">
              <span class="project-settings-startup-title">{language.t("dialog.project.edit.worktree.startup")}</span>
              <span class="project-settings-startup-description">
                {language.t("project.settings.worktree.startup.description")}
              </span>
            </div>
            <Textarea
              class="!w-full [&_[data-slot=textarea-v2-textarea]]:font-mono"
              rows={5}
              value={model.store.startup}
              placeholder={language.t("dialog.project.edit.worktree.startup.placeholder")}
              aria-label={language.t("dialog.project.edit.worktree.startup")}
              spellcheck={false}
              onInput={(event) => model.setStore("startup", event.currentTarget.value)}
              onBlur={model.saveStartup}
            />
            <div class="project-settings-startup-hint flex flex-col">
              <span>{inlineVariables(language.t("project.settings.worktree.startup.hint.base"))}</span>
              <span>{inlineVariables(language.t("project.settings.worktree.startup.hint.new"))}</span>
            </div>
          </div>
        </SettingsList>
      </div>
    </>
  )
}

function inlineVariables(text: string) {
  return text
    .split(/(\$[A-Z][A-Z0-9_]*)/g)
    .map((part, index) => (index % 2 === 0 ? part : <code dir="ltr">{part}</code>))
}
