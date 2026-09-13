import { useDialog } from "@opencode/ui/context/dialog"
import { Tooltip } from "@opencode/ui/tooltip"
import { Icon } from "@opencode/ui/icon"
import { Show, Suspense, createMemo, createSignal, lazy } from "solid-js"
import { createStore } from "solid-js/store"
import { Schema } from "effect"
import createPresence from "solid-presence"
import { Composer } from "@/composer/composer"
import { ComposerDropzone } from "@/composer/dropzone"
import type { ComposerModel } from "@/composer/model"
import { PromptGitStatus, PromptWorkspaceSelector } from "@/new-session/workspace/selector"
import {
  PromptProjectAddButton,
  PromptProjectSelector,
  type PromptProjectController,
} from "@/new-session/project/selector"
import { useLanguage } from "@/runtime/i18n/language"
import { useWorkspaceLocation } from "@/workspaces/location"
import { useProviders } from "@/providers/catalog/providers"
import { useIntegrations } from "@/providers/catalog/integrations"
import { NEW_SESSION_CONTENT_WIDTH } from "@/new-session/layout"
import { Persist, persisted } from "@/runtime/persistence/storage"
import { Persistence } from "@/runtime/persistence/schema"
import type { NewSessionWorkspaceController } from "./workspace/controller"
import { NewSessionWordmark } from "./wordmark"
import { SummaryPopover } from "@/session/summary/popover"
import type { DraftMcpControls } from "./mcp"
import { ProviderSetup } from "@/providers/connect/setup"
import { usePlatform } from "@/runtime/platform/platform"

const NewSessionSummary = lazy(async () => {
  const { NewSessionSummary } = await import("./summary")
  return { default: NewSessionSummary }
})

const providerTipDismissalDuration = 30 * 24 * 60 * 60 * 1000

export const WorkspaceOnboardingSchema = Persistence.struct({
  used: Schema.Boolean,
})

export const ProviderTipSchema = Persistence.struct({
  dismissedAt: Schema.Finite,
})

export const WorkspaceTipSchema = ProviderTipSchema

export function NewSessionView(props: {
  composer: ComposerModel
  project: PromptProjectController
  workspace: NewSessionWorkspaceController
  mcp: DraftMcpControls
}) {
  const [store, setStore] = createStore({ summary: false })
  const platform = usePlatform()
  const sdk = useWorkspaceLocation()
  const providers = useProviders(() => sdk().directory)
  const setup = () => platform.platform === "desktop" && providers.ready() && !providers.usable()
  const [onboarding, setOnboarding, , onboardingReady] = persisted(
    Persist.global("workspace-onboarding"),
    WorkspaceOnboardingSchema,
    { used: false },
  )
  const select = (value: string) => {
    props.workspace.selection.set(value)
    if (value !== "main") setOnboarding("used", true)
  }

  return (
    <div class="@container relative flex flex-col min-h-0 h-full flex-1">
      <div
        data-component="new-session"
        class="relative flex-1 min-h-0 overflow-hidden rounded-[10px] bg-v2-background-bg-base shadow-[var(--v2-elevation-raised)]"
      >
        <ComposerDropzone
          active={props.composer.state.drag === "active"}
          input={props.composer.model.selection.current()?.capabilities.input}
        />
        <div
          data-slot="new-session-summary"
          class="absolute inset-x-0 top-0 z-20 flex h-12 items-center justify-end px-3"
        >
          <SummaryPopover open={store.summary} onOpenChange={(open) => setStore("summary", open)}>
            <Suspense>
              <NewSessionSummary
                project={props.project.selected()}
                workspace={props.workspace}
                mcp={props.mcp}
                shown={store.summary}
                onChooseProject={() => {
                  setStore("summary", false)
                  props.project.add()
                }}
              />
            </Suspense>
          </SummaryPopover>
        </div>
        <div
          class="absolute inset-x-0 top-[25.375%] flex justify-center px-6"
          classList={{ "bottom-12 overflow-y-auto": setup() }}
        >
          <div class={NEW_SESSION_CONTENT_WIDTH}>
            <NewSessionWordmark />
            <div class="mt-8 flex flex-col gap-8">
              <Composer model={props.composer} />
              <ProviderSetup
                visible={setup()}
                directory={sdk().directory}
                selection={props.composer.model.selection}
                onDone={props.composer.restoreFocus}
              />
              <Show when={props.project.empty()}>
                <PromptProjectAddButton controller={props.project} />
              </Show>
              <Show when={props.project.selected()}>
                <div class="flex min-h-7 min-w-0 flex-col items-center justify-center gap-0 text-v2-text-text-faint sm:flex-row">
                  <PromptProjectSelector controller={props.project} placement="bottom" />
                  <Show
                    when={props.workspace.bar.visible()}
                    fallback={
                      <PromptGitStatus
                        branch={props.workspace.bar.branch()}
                        noGit={!props.workspace.project.git()}
                        class="ms-1"
                      />
                    }
                  >
                    <PromptWorkspaceSelector
                      value={props.workspace.selection.value()}
                      projectRoot={props.workspace.project.root()}
                      workspaces={props.workspace.project.workspaces()}
                      branches={props.workspace.project.branches()}
                      branch={props.workspace.bar.branch()}
                      onboarding={onboardingReady() && !onboarding.used}
                      onChange={select}
                      onCreate={props.workspace.selection.create}
                      onSearch={props.workspace.project.searchBranches}
                      onDone={props.composer.restoreFocus}
                      onViewAll={props.workspace.project.openAll}
                    />
                  </Show>
                </div>
              </Show>
            </div>
          </div>
        </div>
        <NewSessionTips
          composer={props.composer}
          workspaceEligible={
            !!props.project.selected() &&
            props.workspace.bar.visible() &&
            props.workspace.selection.value() !== "create" &&
            props.workspace.project.managed() === 0
          }
          onWorkspace={() => select("create")}
        />
      </div>
    </div>
  )
}

function NewSessionTips(props: { composer: ComposerModel; workspaceEligible: boolean; onWorkspace: () => void }) {
  const language = useLanguage()
  const dialog = useDialog()
  const sdk = useWorkspaceLocation()
  const providers = useProviders(() => sdk().directory)
  const integrations = useIntegrations(() => sdk().directory)
  const [providerState, setProviderState, , providerReady] = persisted(
    Persist.global("new-session.provider-tip-v3"),
    ProviderTipSchema,
    { dismissedAt: 0 },
  )
  const [workspaceState, setWorkspaceState, , workspaceReady] = persisted(
    Persist.global("new-session.workspace-tip"),
    WorkspaceTipSchema,
    { dismissedAt: 0 },
  )
  const workspaceVisible = createMemo(
    () =>
      props.workspaceEligible &&
      workspaceReady() &&
      Date.now() - workspaceState.dismissedAt >= providerTipDismissalDuration,
  )
  const providerVisible = createMemo(
    () =>
      providers.ready() &&
      providerReady() &&
      !integrations.list().some((integration) => integration.connections.length > 0) &&
      !providers
        .connected()
        .some((provider) => provider.id !== "opencode" && Object.keys(provider.models).length > 0) &&
      Date.now() - providerState.dismissedAt >= providerTipDismissalDuration,
  )
  const tip = createMemo<"workspace" | "provider" | undefined>(() => {
    if (providerVisible()) return "provider"
    if (workspaceVisible()) return "workspace"
  })
  const displayed = createMemo<"workspace" | "provider" | undefined>((previous) => tip() ?? previous)
  const [ref, setRef] = createSignal<HTMLDivElement>()
  const presence = createPresence({
    show: () => tip() !== undefined,
    element: () => ref() ?? null,
  })
  const open = async () => {
    const current = tip()
    if (!current) return
    if (current === "workspace") {
      setWorkspaceState("dismissedAt", Date.now())
      props.onWorkspace()
      return
    }
    const { DialogConnectProvider } = await import("@/providers/connect/dialog")
    void dialog.show(() => (
      <DialogConnectProvider
        directory={sdk().directory}
        selection={props.composer.model.selection}
        onDone={props.composer.restoreFocus}
      />
    ))
  }
  const dismiss = () => {
    const current = tip()
    if (!current) return
    if (current === "workspace") {
      setWorkspaceState("dismissedAt", Date.now())
      return
    }
    setProviderState("dismissedAt", Date.now())
  }

  return (
    <Show when={presence.present()}>
      <div class="pointer-events-none absolute inset-x-0 bottom-4 flex justify-center px-10">
        <div
          ref={setRef}
          data-component="new-session-tip"
          data-visible={tip() !== undefined}
          class="group/new-session-tip pointer-events-auto relative flex h-6 max-w-full items-center transition-[opacity,transform] duration-[250ms] ease-[cubic-bezier(0.215,0.61,0.355,1)] motion-reduce:transition-none"
          classList={{ "data-[visible=false]:animate-out fade-out slide-out-to-bottom-4": true }}
        >
          <button
            type="button"
            class="flex h-6 min-w-0 items-center rounded-[4px] pl-1.5 text-[13px] leading-text-compact tracking-[-0.04px] text-v2-text-text-faint transition-[background-color,color] duration-150 ease-in-out hover:bg-v2-overlay-simple-overlay-hover hover:text-v2-text-text-muted focus-visible:bg-v2-overlay-simple-overlay-hover focus-visible:text-v2-text-text-muted focus-visible:outline-none"
            onClick={open}
          >
            <span class="truncate">
              {language.t(displayed() === "workspace" ? "home.workspaceTip" : "home.providerTip")}
            </span>
            <span class="flex size-6 shrink-0 items-center justify-center" aria-hidden="true">
              <Icon name="chevron-down" size="small" class="-rotate-90" />
            </span>
          </button>
          <Tooltip
            class="hover-reveal absolute left-full top-0 flex h-6 w-7 items-center justify-end delay-0 duration-0 group-hover/new-session-tip:delay-[250ms] group-hover/new-session-tip:duration-150 group-hover/new-session-tip:opacity-100 focus-within:delay-0 focus-within:duration-0 focus-within:opacity-100"
            placement="top"
            openDelay={1000}
            value={language.t("common.dismiss")}
          >
            <button
              type="button"
              class="flex size-6 items-center justify-center rounded-[4px] text-v2-icon-icon-muted transition-[background-color,color] duration-150 ease-in-out hover:bg-v2-overlay-simple-overlay-hover hover:text-v2-icon-icon-base focus-visible:bg-v2-overlay-simple-overlay-hover focus-visible:text-v2-icon-icon-base focus-visible:outline-none"
              aria-label={language.t("common.dismiss")}
              onClick={dismiss}
            >
              <Icon name="xmark-small" />
            </button>
          </Tooltip>
        </div>
      </div>
    </Show>
  )
}
