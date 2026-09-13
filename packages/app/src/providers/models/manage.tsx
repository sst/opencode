import { Button } from "@opencode/ui/button"
import { Dialog, DialogBody, DialogHeader, DialogTitleGroup } from "@opencode/ui/dialog"
import { Icon } from "@opencode/ui/icon"
import { IconButton } from "@opencode/ui/icon-button"
import { ProviderIcon } from "@opencode/ui/provider-icon"
import { Switch } from "@opencode/ui/switch"
import { TextInput } from "@opencode/ui/text-input"
import { useFilteredList } from "@opencode/ui/hooks"
import { For, Show, type Component } from "solid-js"
import { createStore } from "solid-js/store"
import { useLocal, type ModelSelection } from "@/providers/models/selection"
import { popularProviders } from "@/providers/catalog/providers"
import { useLanguage } from "@/runtime/i18n/language"
import { useDialog } from "@opencode/ui/context/dialog"
import { DialogConnectProvider } from "@/providers/connect/dialog"
import { decode64 } from "@/runtime/persistence/base64"
import { SettingsList } from "@/settings/list"
import { SettingsRow } from "@/settings/row"
import "@/settings/settings.css"

type ModelItem = ReturnType<ReturnType<typeof useLocal>["model"]["list"]>[number]

export const DialogManageModels: Component<{ model?: ModelSelection; onDone?: () => void }> = (props) => {
  const local = useLocal()
  const language = useLanguage()
  const dialog = useDialog()
  const [store, setStore] = createStore({ collapsed: {} as Record<string, boolean> })
  const directory = () => decode64(local.slug())

  const handleConnectProvider = () => {
    void dialog.show(() => (
      <DialogConnectProvider directory={directory()} selection={props.model ?? local.model} onDone={props.onDone} />
    ))
  }
  const providerList = (providerID: string) => local.model.list().filter((x) => x.provider.id === providerID)
  const providerVisible = (providerID: string) =>
    providerList(providerID).every((x) => local.model.visible({ modelID: x.id, providerID: x.provider.id }))
  const setProviderVisibility = (providerID: string, checked: boolean) => {
    providerList(providerID).forEach((x) => {
      local.model.setVisibility({ modelID: x.id, providerID: x.provider.id }, checked)
    })
  }
  const setModelVisibility = (item: ModelItem, checked: boolean) => {
    local.model.setVisibility({ modelID: item.id, providerID: item.provider.id }, checked)
  }
  const list = useFilteredList<ModelItem>({
    items: () => local.model.list(),
    key: (x) => `${x.provider.id}:${x.id}`,
    filterKeys: ["provider.name", "name", "id"],
    sortBy: (a, b) => a.name.localeCompare(b.name),
    groupBy: (x) => x.provider.id,
    sortGroupsBy: (a, b) => {
      const aRank = popularProviders.indexOf(a.category)
      const bRank = popularProviders.indexOf(b.category)
      const aPopular = aRank >= 0
      const bPopular = bRank >= 0
      if (aPopular && !bPopular) return -1
      if (!aPopular && bPopular) return 1
      return aRank - bRank
    },
  })

  return (
    <Dialog size="large" variant="settings" class="settings-manage-models-dialog">
      <DialogHeader hideClose={true} closeLabel={language.t("common.close")}>
        <DialogTitleGroup
          title={language.t("dialog.model.manage")}
          description={language.t("dialog.model.manage.description")}
        />
        <Button variant="neutral" icon="plus" onClick={handleConnectProvider}>
          {language.t("command.provider.connect")}
        </Button>
      </DialogHeader>
      <DialogBody class="flex min-h-0 flex-1 flex-col">
        <div class="px-4 pt-px pb-3">
          <div class="relative">
            <TextInput
              type="search"
              appearance="base"
              class="!w-full self-stretch"
              value={list.filter()}
              onInput={(event) => list.onInput(event.currentTarget.value)}
              placeholder={language.t("dialog.model.search.placeholder")}
              spellcheck={false}
              autocorrect="off"
              autocomplete="off"
              autocapitalize="off"
              autofocus
              aria-label={language.t("dialog.model.search.placeholder")}
            />
            <Show when={list.filter()}>
              <IconButton
                type="button"
                variant="ghost-muted"
                size="small"
                class="settings-tab-search-clear"
                icon={<Icon name="close" size="large" class="text-v2-icon-icon-muted" />}
                onClick={() => list.clear()}
                aria-label={language.t("common.clear")}
              />
            </Show>
          </div>
        </div>
        <div data-slot="manage-models-scroll" class="relative min-h-0 flex-1">
          <div class="settings-panel settings-models h-full px-4 pt-4 pb-4">
            <Show
              when={!list.grouped.loading}
              fallback={
                <div class="settings-models-status">
                  {language.t("common.loading")}
                  {language.t("common.loading.ellipsis")}
                </div>
              }
            >
              <Show
                when={list.flat().length > 0}
                fallback={
                  <div class="settings-models-status">
                    <span>{language.t("dialog.model.empty")}</span>
                    <Show when={list.filter()}>
                      <span class="settings-models-status-filter">&quot;{list.filter()}&quot;</span>
                    </Show>
                  </div>
                }
              >
                <For each={list.grouped.latest}>
                  {(group) => {
                    const searching = () => list.filter().length > 0
                    const expanded = () => searching() || !store.collapsed[group.category]

                    return (
                      <div
                        class="settings-section"
                        data-component="settings-models-provider"
                        data-expanded={expanded() ? "" : undefined}
                      >
                        <div class="settings-models-group-header justify-between">
                          <button
                            type="button"
                            class="settings-models-group-trigger"
                            aria-expanded={expanded()}
                            disabled={searching()}
                            onClick={() => setStore("collapsed", group.category, expanded())}
                          >
                            <span class="settings-models-group-chevron">
                              <Icon
                                name="chevron-down"
                                size="small"
                                classList={{ "-rotate-90 rtl:rotate-90": !expanded() }}
                              />
                            </span>
                            <span class="settings-models-group-label">
                              <ProviderIcon id={group.category} width={16} height={16} class="shrink-0" />
                              <span class="settings-models-group-title">{group.items[0].provider.name}</span>
                            </span>
                          </button>
                          <Switch
                            class="me-6"
                            checked={providerVisible(group.category)}
                            onChange={(checked) => setProviderVisibility(group.category, checked)}
                            hideLabel
                          >
                            {group.items[0].provider.name}
                          </Switch>
                        </div>
                        <Show when={expanded()}>
                          <SettingsList variant="catalog">
                            <For each={group.items}>
                              {(item) => (
                                <SettingsRow title={item.name} description="">
                                  <div>
                                    <Switch
                                      checked={local.model.visible({ modelID: item.id, providerID: item.provider.id })}
                                      onChange={(checked) => setModelVisibility(item, checked)}
                                      hideLabel
                                    >
                                      {item.name}
                                    </Switch>
                                  </div>
                                </SettingsRow>
                              )}
                            </For>
                          </SettingsList>
                        </Show>
                      </div>
                    )
                  }}
                </For>
              </Show>
            </Show>
          </div>
        </div>
      </DialogBody>
    </Dialog>
  )
}
