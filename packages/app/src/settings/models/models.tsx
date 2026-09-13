import { useFilteredList } from "@opencode/ui/hooks"
import { ProviderIcon } from "@opencode/ui/provider-icon"
import { Switch } from "@opencode/ui/switch"
import { Icon } from "@opencode/ui/icon"
import { IconButton } from "@opencode/ui/icon-button"
import { TextInput } from "@opencode/ui/text-input"
import { type Component, createEffect, For, on, onCleanup, Show } from "solid-js"
import { Schema } from "effect"
import { Persistence } from "@/runtime/persistence/schema"
import { useLanguage } from "@/runtime/i18n/language"
import { useModels } from "@/providers/models/models"
import { useServerSDK } from "@/runtime/server/client"
import { popularProviders } from "@/providers/catalog/providers"
import { Persist, persisted } from "@/runtime/persistence/storage"
import { SettingsList } from "@/settings/list"
import { SettingsRow } from "@/settings/row"
import "@/settings/settings.css"

type ModelItem = ReturnType<ReturnType<typeof useModels>["list"]>[number]

const PROVIDER_ICON_SIZE = 16

export const ModelProvidersSchema = Schema.Struct({
  collapsed: Persistence.record(Persistence.fallback(Schema.Boolean, () => false)),
})

export const SettingsModels: Component<{
  active?: boolean
  autofocus?: boolean
  provider?: string
  onReveal?: () => void
}> = (props) => {
  const language = useLanguage()
  const models = useModels()
  const serverSdk = useServerSDK()
  let search: HTMLInputElement | undefined
  createEffect(
    on(
      () => props.active ?? true,
      (active) => {
        if (!active) return
        const frame = requestAnimationFrame(() => {
          if (props.active !== false && props.autofocus !== false && search?.isConnected)
            search.focus({ preventScroll: true })
        })
        onCleanup(() => cancelAnimationFrame(frame))
      },
    ),
  )
  const [store, setStore] = persisted(
    Persist.serverGlobal(serverSdk.scope, "settings-v2.models.providers"),
    ModelProvidersSchema,
    { collapsed: {} },
  )
  const sections = new Map<string, HTMLElement>()

  const list = useFilteredList<ModelItem>({
    items: (_filter) => models.list(),
    key: (x) => `${x.provider.id}:${x.id}`,
    filterKeys: ["provider.name", "name", "id"],
    sortBy: (a, b) => a.name.localeCompare(b.name),
    groupBy: (x) => x.provider.id,
    sortGroupsBy: (a, b) => {
      const aIndex = popularProviders.indexOf(a.category)
      const bIndex = popularProviders.indexOf(b.category)
      const aPopular = aIndex >= 0
      const bPopular = bIndex >= 0

      if (aPopular && !bPopular) return -1
      if (!aPopular && bPopular) return 1
      if (aPopular && bPopular) return aIndex - bIndex

      const aName = a.items[0].provider.name
      const bName = b.items[0].provider.name
      return aName.localeCompare(bName)
    },
  })

  createEffect(() => {
    if (!props.active || !props.provider) return
    const provider = props.provider
    if (list.filter()) {
      list.clear()
      return
    }
    if (!list.grouped.latest.some((group) => group.category === provider)) return
    const section = sections.get(provider)
    if (!section?.isConnected) return
    list.grouped.latest.forEach((group) => setStore("collapsed", group.category, group.category !== provider))
    requestAnimationFrame(() => {
      section.scrollIntoView({ block: "start" })
      section.querySelector<HTMLElement>(".settings-models-group-trigger")?.focus({ preventScroll: true })
      props.onReveal?.()
    })
  })

  return (
    <>
      <div class="settings-tab-header settings-tab-header--stacked">
        <div class="settings-tab-header-row">
          <div class="flex flex-col gap-1">
            <h2 class="settings-tab-title">{language.t("settings.models.title")}</h2>
            <span class="text-11-regular text-v2-text-text-muted">{language.t("settings.models.description")}</span>
          </div>
        </div>
        <div class="settings-tab-search">
          <TextInput
            ref={search}
            type="search"
            appearance="base"
            value={list.filter()}
            onInput={(event) => list.onInput(event.currentTarget.value)}
            placeholder={language.t("dialog.model.search.placeholder")}
            spellcheck={false}
            autocorrect="off"
            autocomplete="off"
            autocapitalize="off"
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
            />
          </Show>
        </div>
      </div>

      <div class="settings-tab-body settings-models">
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
                    ref={(element) => sections.set(group.category, element)}
                    class="settings-section"
                    data-component="settings-models-provider"
                    data-expanded={expanded() ? "" : undefined}
                  >
                    <h3 class="settings-models-group-header">
                      <button
                        type="button"
                        class="settings-models-group-trigger"
                        aria-expanded={expanded()}
                        disabled={searching()}
                        onClick={() => setStore("collapsed", group.category, expanded())}
                      >
                        <span class="settings-models-group-chevron">
                          <Show
                            when={expanded()}
                            fallback={
                              <svg width="5" height="6" viewBox="0 0 5 6" fill="none" aria-hidden="true">
                                <path
                                  d="M0.75194 5.31663C0.41861 5.51103 0 5.27063 0 4.88473V0.500754C0 0.114854 0.41861 -0.125577 0.75194 0.0688635L4.5096 2.26084C4.8404 2.45378 4.8404 2.93168 4.5096 3.12462L0.75194 5.31663Z"
                                  fill="currentColor"
                                />
                              </svg>
                            }
                          >
                            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                              <path
                                d="M5.37624 6.75194C5.18184 6.41861 5.42224 6 5.80814 6H10.1921C10.578 6 10.8184 6.41861 10.624 6.75194L8.43203 10.5096C8.23909 10.8404 7.76119 10.8404 7.56825 10.5096L5.37624 6.75194Z"
                                fill="currentColor"
                              />
                            </svg>
                          </Show>
                        </span>
                        <span class="settings-models-group-label">
                          <ProviderIcon
                            id={group.category}
                            width={PROVIDER_ICON_SIZE}
                            height={PROVIDER_ICON_SIZE}
                            class="settings-models-provider-icon shrink-0"
                          />
                          <span class="settings-models-group-title">{group.items[0].provider.name}</span>
                        </span>
                      </button>
                    </h3>
                    <Show when={expanded()}>
                      <SettingsList variant="catalog">
                        <For each={group.items}>
                          {(item) => {
                            const key = { providerID: item.provider.id, modelID: item.id }
                            return (
                              <SettingsRow title={item.name} description="">
                                <div>
                                  <Switch
                                    checked={models.visible(key)}
                                    onChange={(checked) => {
                                      models.setVisibility(key, checked)
                                    }}
                                    hideLabel
                                  >
                                    {item.name}
                                  </Switch>
                                </div>
                              </SettingsRow>
                            )
                          }}
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
    </>
  )
}
