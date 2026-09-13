import { For, Show, createEffect, createMemo, on, onCleanup, type Component } from "solid-js"
import { createStore } from "solid-js/store"
import { Icon } from "@opencode/ui/icon"
import { TextInput } from "@opencode/ui/text-input"
import { useLanguage } from "@/runtime/i18n/language"
import { useGlobal } from "@/runtime/server/runtime"
import { ServerConnection } from "@/runtime/server/registry"
import { displayName } from "@/shell/layout/helpers"
import { ProjectIcon } from "@/shell/layout/project-icon"
import type { LocalProject } from "@/shell/state/layout"
import { settingsProjects } from "../servers/inventory"
import "@/settings/settings.css"

export const SettingsProjects: Component<{
  server: ServerConnection.Any
  active?: boolean
  autofocus?: boolean
  onOpenProject: (project: LocalProject) => void
}> = (props) => {
  const language = useLanguage()
  const global = useGlobal()
  const [store, setStore] = createStore({ filter: "" })
  let search: HTMLInputElement | undefined
  const projects = createMemo(() => settingsProjects(global.ensureServerCtx(props.server)))
  const searchable = createMemo(() => projects().length > 7)
  const filtered = createMemo(() => {
    const query = searchable() ? store.filter.trim().toLowerCase() : ""
    return query ? projects().filter((project) => displayName(project).toLowerCase().includes(query)) : projects()
  })
  createEffect(
    on(
      () => (props.active ?? true) && searchable(),
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
  createEffect(() => {
    if (!searchable()) setStore("filter", "")
  })

  return (
    <>
      <div class="settings-tab-header" classList={{ "settings-tab-header--stacked": searchable() }}>
        <div class="settings-tab-header-row">
          <div class="flex flex-col gap-1">
            <h2 class="settings-tab-title">{language.t("settings.projects.title")}</h2>
            <span class="text-11-regular text-v2-text-text-muted">{language.t("settings.projects.description")}</span>
          </div>
        </div>
        <Show when={searchable()}>
          <div class="settings-tab-search">
            <TextInput
              ref={search}
              type="search"
              appearance="base"
              value={store.filter}
              onInput={(event) => setStore("filter", event.currentTarget.value)}
              placeholder={language.t("settings.projects.search.placeholder")}
              aria-label={language.t("settings.projects.search.placeholder")}
              showClearButton={!!store.filter}
              onClearClick={() => {
                setStore("filter", "")
                search?.focus({ preventScroll: true })
              }}
              spellcheck={false}
              autocorrect="off"
              autocomplete="off"
              autocapitalize="off"
            />
          </div>
        </Show>
      </div>

      <div class="settings-tab-body">
        <Show
          when={filtered().length > 0}
          fallback={
            <div class="py-12 text-center text-v2-text-text-muted text-13-regular">
              {language.t("settings.projects.empty")}
            </div>
          }
        >
          <div class="flex w-full flex-col gap-2">
            <For each={filtered()}>
              {(project) => (
                <button
                  type="button"
                  aria-label={displayName(project)}
                  class="group mx-px flex items-center justify-between gap-5 px-4 py-2.5 rounded-lg bg-v2-background-bg-base shadow-[var(--v2-elevation-raised)] transition-[background-color] hover:bg-v2-background-bg-layer-01 text-start"
                  onClick={() => props.onOpenProject(project)}
                >
                  <span class="flex items-center gap-2.5 min-w-0 flex-1">
                    <ProjectIcon project={project} class="shrink-0" />
                    <bdi class="text-13-medium text-v2-text-text-base truncate">{displayName(project)}</bdi>
                  </span>
                  <Icon
                    name="chevron-right"
                    size="small"
                    class="shrink-0 text-v2-icon-icon-muted opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
                  />
                </button>
              )}
            </For>
          </div>
        </Show>
      </div>
    </>
  )
}
