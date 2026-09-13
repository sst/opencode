import { Button } from "@opencode/ui/button"
import { Icon } from "@opencode/ui/icon"
import { Menu } from "@opencode/ui/menu"
import { Tabs } from "@opencode/ui/tabs"
import { For, Show, type ComponentProps, type JSX } from "solid-js"
import { useLanguage } from "@/runtime/i18n/language"
import { useSettingsSurface } from "./surface"
import { SettingsSearch } from "./search"
import "./search.css"

export type SettingsNavItem = {
  value: string
  label: string
  icon: ComponentProps<typeof Icon>["name"]
  disabled?: boolean
  onPrefetch?: () => void
}

export type SettingsNavGroup = {
  label?: string
  action?: JSX.Element
  items: readonly SettingsNavItem[]
}

export function SettingsNavigation(props: {
  value: string
  groups: readonly SettingsNavGroup[]
  backLabel: string
  onBack: () => void
  onChange: (value: string) => void
  mobileAction?: JSX.Element
  children: JSX.Element
}) {
  const surface = useSettingsSurface()
  const searchable = () => surface.view().type === "root"
  const language = useLanguage()
  const back = () => {
    if (!searchable() && surface.search.back()) return
    props.onBack()
  }
  const backLabel = () =>
    !searchable() && surface.search.state.selected ? language.t("settings.backToSettings") : props.backLabel
  const current = () => props.groups.flatMap((group) => group.items).find((item) => item.value === props.value)
  const change = (value: string) => {
    surface.search.clear()
    props.onChange(value)
  }

  return (
    <Tabs orientation="vertical" variant="settings" value={props.value} onChange={change} class="settings">
      <div class="settings-mobile-nav">
        <button type="button" class="settings-back" onClick={back}>
          <Icon name="arrow-left" size="small" class="settings-back-icon" />
          <span>{backLabel()}</span>
        </button>
        <div class="settings-mobile-actions">
          {props.mobileAction}
          <Menu placement="bottom-end" gutter={8}>
            <Menu.Trigger as={Button} size="normal" variant="outline" class="settings-mobile-menu-trigger">
              <span>{current()?.label}</span>
              <Icon name="chevron-down" size="small" />
            </Menu.Trigger>
            <Menu.Portal>
              <Menu.Content class="settings-mobile-menu" onEscapeKeyDown={(event) => event.stopPropagation()}>
                <Menu.RadioGroup value={props.value} onChange={change}>
                  <For each={props.groups}>
                    {(group, index) => (
                      <>
                        <Show when={index() > 0}>
                          <Menu.Separator />
                        </Show>
                        <For each={group.items}>
                          {(item) => (
                            <Menu.RadioItem
                              value={item.value}
                              disabled={item.disabled}
                              closeOnSelect
                              onPointerEnter={(event: PointerEvent) => {
                                if (item.disabled || event.pointerType === "touch") return
                                item.onPrefetch?.()
                              }}
                              onFocus={() => !item.disabled && item.onPrefetch?.()}
                            >
                              <Icon name={item.icon} />
                              {item.label}
                            </Menu.RadioItem>
                          )}
                        </For>
                      </>
                    )}
                  </For>
                </Menu.RadioGroup>
              </Menu.Content>
            </Menu.Portal>
          </Menu>
        </div>
      </div>
      <aside class="settings-sidebar" data-searchable={searchable()}>
        <div class="settings-nav">
          <button type="button" class="settings-back" onClick={back}>
            <Icon name="arrow-left" size="small" class="settings-back-icon" />
            <span>{backLabel()}</span>
          </button>
          <Show when={searchable()}>
            <SettingsSearch />
          </Show>
          <Show when={!searchable() || !surface.search.state.query.trim()}>
            <Tabs.List class="settings-nav-groups">
              <For each={props.groups}>
                {(group) => (
                  <div class="settings-nav-group">
                    <Show when={group.label || group.action}>
                      <div class="settings-nav-group-header" data-component="settings-nav-group-header">
                        <span>{group.label}</span>
                        {group.action}
                      </div>
                    </Show>
                    <For each={group.items}>
                      {(item) => (
                        <Tabs.Trigger
                          value={item.value}
                          disabled={item.disabled}
                          onPointerEnter={(event: PointerEvent) => {
                            if (item.disabled || event.pointerType === "touch") return
                            item.onPrefetch?.()
                          }}
                          onFocus={() => !item.disabled && item.onPrefetch?.()}
                        >
                          <Icon name={item.icon} />
                          {item.label}
                        </Tabs.Trigger>
                      )}
                    </For>
                  </div>
                )}
              </For>
            </Tabs.List>
          </Show>
        </div>
      </aside>
      <div class="settings-content">{props.children}</div>
    </Tabs>
  )
}
