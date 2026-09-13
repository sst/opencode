import { For, Show } from "solid-js"
import { AppIcon } from "@opencode-ai/ui/app-icon"
import { Icon } from "@opencode-ai/ui/icon"
import { Spinner } from "@opencode-ai/ui/spinner"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { MenuV2 } from "@opencode-ai/ui/v2/menu-v2"
import { SplitButtonV2, SplitButtonV2Action, SplitButtonV2MenuTrigger } from "@opencode-ai/ui/v2/split-button-v2"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { useLanguage } from "@/context/language"
import { type OpenApp, useOpenInApp } from "@/components/session/open-in-app"

export function OpenInAppV2(props: { directory: () => string }) {
  const language = useLanguage()
  const state = useOpenInApp(props)

  return (
    <Show when={props.directory() && state.canOpen()}>
      <SplitButtonV2 class="session-review-v2-open-in-app" onPointerDown={(event) => event.stopPropagation()}>
        <TooltipV2
          placement="bottom"
          value={language.t("session.header.open.ariaLabel", { app: state.current().label })}
          class="flex items-center"
        >
          <SplitButtonV2Action
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation()
              if (state.opening()) return
              state.openDir(state.current().id)
            }}
            disabled={state.opening()}
            aria-label={language.t("session.header.open.ariaLabel", { app: state.current().label })}
          >
            <Show
              when={state.opening()}
              fallback={<AppIcon id={state.current().icon} style={{ width: "20px", height: "20px" }} />}
            >
              <Spinner class="size-3.5" />
            </Show>
          </SplitButtonV2Action>
        </TooltipV2>
        <MenuV2
          gutter={4}
          modal={false}
          placement="bottom-end"
          open={state.menu.open}
          onOpenChange={(open) => state.setMenu("open", open)}
        >
          <MenuV2.Trigger
            as={SplitButtonV2MenuTrigger}
            disabled={state.opening()}
            aria-label={language.t("session.header.open.menu")}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <IconV2 name="chevron-down" size="small" />
          </MenuV2.Trigger>
          <MenuV2.Portal>
            <MenuV2.Content class="open-in-app-v2-menu">
              <MenuV2.Group>
                <MenuV2.GroupLabel>{language.t("session.header.openIn")}</MenuV2.GroupLabel>
                <MenuV2.RadioGroup
                  value={state.current().id}
                  onChange={(value) => {
                    state.selectApp(value as OpenApp)
                  }}
                >
                  <For each={state.options()}>
                    {(option) => (
                      <MenuV2.RadioItem
                        value={option.id}
                        disabled={state.opening()}
                        onSelect={() => {
                          state.selectApp(option.id)
                          state.setMenu("open", false)
                          state.openDir(option.id)
                        }}
                      >
                        <AppIcon id={option.icon} />
                        {option.label}
                      </MenuV2.RadioItem>
                    )}
                  </For>
                </MenuV2.RadioGroup>
              </MenuV2.Group>
              <MenuV2.Separator />
              <MenuV2.Item
                onSelect={() => {
                  state.setMenu("open", false)
                  state.copyPath()
                }}
              >
                <Icon name="copy" size="small" class="text-icon-weak" />
                {language.t("session.header.open.copyPath")}
              </MenuV2.Item>
            </MenuV2.Content>
          </MenuV2.Portal>
        </MenuV2>
      </SplitButtonV2>
    </Show>
  )
}
