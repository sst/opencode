import { SessionReviewEmptyChangesV2 } from "@opencode/session-ui/v2/session-review-empty-changes-v2"
import { SessionReviewV2SidebarToggle } from "@opencode/session-ui/v2/session-review-v2"
import { Select } from "@opencode/ui/select"
import { Tabs } from "@opencode/ui/tabs"
import { Icon } from "@opencode/ui/icon"
import { IconButton } from "@opencode/ui/icon-button"
import { Menu } from "@opencode/ui/menu"
import { For, Match, Show, Suspense, Switch, lazy, createEffect, onCleanup, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/runtime/i18n/language"
import { useSettings } from "@/settings/model"
import { SessionSidePanel } from "../files/session-side-panel"
import { ReviewPanel } from "./panel"
import { SessionReviewTab } from "./review-tab"
import type { ChangeMode, SessionReviewModel } from "./model"
import type { createSessionBrowser } from "../browser/model"

const MobilePanelDrawer = lazy(async () => {
  const { MobilePanelDrawer } = await import("@/shell/mobile-panel-drawer")
  return { default: MobilePanelDrawer }
})

export function SessionMobileViewTabs(props: {
  current: "session" | "changes" | "files" | "usage" | "terminal"
  onSelect: (view: "session" | "changes" | "files" | "usage" | "terminal") => void
  details?: (close: () => void) => JSX.Element
  onDetailsOpenChange?: (open: boolean) => void
}) {
  const language = useLanguage()
  const [store, setStore] = createStore({
    menu: false,
    details: false,
    detailsLoaded: false,
    pending: false,
  })
  createEffect(() => props.onDetailsOpenChange?.(store.details))
  onCleanup(() => props.onDetailsOpenChange?.(false))
  let trigger: HTMLButtonElement | undefined
  return (
    <div
      class="relative flex shrink-0 items-center before:pointer-events-none before:absolute before:inset-x-0 before:bottom-0 before:h-px before:bg-v2-border-border-base before:content-['']"
      data-slot="session-mobile-view-navigation"
    >
      <Tabs value={props.current} variant="line" class="!h-auto min-w-0 flex-1" data-slot="session-mobile-view-tabs">
        <Tabs.List aria-label={language.t("session.view.select")} class="!h-9 !gap-0 !px-0 before:!hidden">
          <For each={["session", "changes", "files", "terminal"] as const}>
            {(view) => (
              <Tabs.Trigger
                value={view}
                class="min-w-0 flex-1"
                classes={{ button: "w-full justify-center" }}
                onClick={() => props.onSelect(view)}
              >
                {view === "session"
                  ? language.t("session.tab.session")
                  : view === "changes"
                    ? language.plural("session.review.change", 0)
                    : view === "files"
                      ? language.t("session.tab.files")
                      : language.t("terminal.title")}
              </Tabs.Trigger>
            )}
          </For>
        </Tabs.List>
      </Tabs>
      <Menu
        appearance="standard"
        modal={false}
        placement="bottom-end"
        gutter={4}
        open={store.menu}
        onOpenChange={(open) => setStore("menu", open)}
      >
        <Menu.Trigger
          as={IconButton}
          ref={(element: HTMLButtonElement) => {
            trigger = element
          }}
          icon={<Icon name="menu" />}
          variant="ghost-muted"
          size="normal"
          class="mx-1.5 shrink-0"
          state={props.current === "usage" || store.menu ? "pressed" : undefined}
          aria-label={language.t("common.moreOptions")}
        />
        <Menu.Portal>
          <Menu.Content
            onCloseAutoFocus={(event) => {
              if (!store.pending) return
              event.preventDefault()
              setStore({ details: true, detailsLoaded: true, pending: false })
            }}
          >
            <Menu.Item onSelect={() => props.onSelect("usage")}>{language.t("session.tab.usage")}</Menu.Item>
            <Show when={props.details}>
              <Menu.Item onSelect={() => setStore({ pending: true, menu: false })}>
                {language.t("session.summary.title")}
              </Menu.Item>
            </Show>
          </Menu.Content>
        </Menu.Portal>
      </Menu>
      <Show when={store.detailsLoaded}>
        <Suspense>
          <MobilePanelDrawer
            title={language.t("session.summary.title")}
            open={store.details}
            onOpenChange={(open) => setStore("details", open)}
            returnFocus={() => trigger}
          >
            {props.details?.(() => setStore("details", false))}
          </MobilePanelDrawer>
        </Suspense>
      </Show>
    </div>
  )
}

export function SessionMobileReview(props: { review: SessionReviewModel }) {
  return (
    <div class="relative h-full overflow-hidden">
      <ReviewContent review={props.review} />
    </div>
  )
}

export function SessionDesktopReview(props: {
  review: SessionReviewModel
  browser: ReturnType<typeof createSessionBrowser>
  present?: boolean
}) {
  return (
    <Suspense>
      <SessionSidePanel
        canReview={props.review.canReview()}
        diffs={props.review.diffs()}
        diffsReady={props.review.ready()}
        hasReview={props.review.hasChanges()}
        reviewHasFocusableContent={props.review.hasChanges() || props.review.panelState.sidebarOpened()}
        reviewCount={props.review.count()}
        reviewPanel={() => <ReviewPanelContent review={props.review} />}
        reviewSidebarToggle={(disabled) => (
          <SessionReviewV2SidebarToggle
            opened={props.review.panelState.sidebarOpened()}
            disabled={disabled}
            onToggle={props.review.panelState.toggleSidebar}
          />
        )}
        fileBrowserState={props.review.panelState}
        activeDiff={props.review.activeFile()}
        focusReviewDiff={props.review.focusFile}
        reviewPresent={props.present}
        size={props.review.screen.size}
        stacked={props.review.screen.side.layout().stacked}
        browser={props.browser}
      />
    </Suspense>
  )
}

function ReviewContent(props: { review: SessionReviewModel }) {
  const settings = useSettings()
  return (
    <Show when={!props.review.deferRender()}>
      <SessionReviewTab
        title={<ReviewTitle review={props.review} />}
        empty={<ReviewEmpty review={props.review} loadingClass="px-2 py-2 text-text-weak" />}
        diffs={props.review.diffs()}
        view={props.review.view()}
        diffStyle="unified"
        changeSummary
        disableLineNumbers={false}
        overflow={settings.general.mobileDiffWrap() ? "wrap" : "scroll"}
        onViewFile={(file) => {
          props.review.openFile(file)
          props.review.mobile.setTab("files")
        }}
        onScrollRef={props.review.setScroll}
        focusedFile={props.review.activeFile()}
        onLineComment={props.review.comments.add}
        onLineCommentUpdate={props.review.comments.update}
        onLineCommentDelete={props.review.comments.remove}
        lineCommentActions={props.review.comments.actions()}
        commentMentions={{ items: props.review.comments.mentions }}
        comments={props.review.comments.all()}
        focusedComment={props.review.comments.focus()}
        onFocusedCommentChange={props.review.comments.setFocus}
        classes={{
          root: "[&_[data-slot=session-review-list]]:pb-0 [&_[data-slot=accordion-trigger]]:!rounded-none [&_[data-slot=accordion-trigger]]:!border-x-0 [&_[data-slot=accordion-item]:first-child_[data-slot=accordion-trigger]]:!border-t-0 [&_[data-slot=accordion-item]:last-child:not([data-expanded])_[data-slot=accordion-trigger]]:!border-b-0 [&_[data-slot=accordion-item]:last-child_[data-slot=accordion-content]]:!border-b-0 [&_[data-slot=accordion-item]:last-child_[data-slot=session-review-diff-placeholder]]:!border-b-0 [&_[data-slot=accordion-content]]:!rounded-none [&_[data-slot=accordion-content]]:!border-x-0 [&_[data-slot=session-review-diff-placeholder]]:!rounded-none [&_[data-slot=session-review-diff-placeholder]]:!border-x-0",
          header:
            "!px-2 !h-10 !pb-0 relative before:pointer-events-none before:absolute before:inset-x-0 before:bottom-0 before:h-px before:bg-v2-border-border-base before:content-['']",
          container: "!px-0",
        }}
      />
    </Show>
  )
}

function ReviewPanelContent(props: { review: SessionReviewModel }) {
  return (
    <div class="flex flex-col h-full overflow-hidden bg-v2-background-bg-base contain-strict">
      <Show when={props.review.panelRendered()}>
        <ReviewPanel
          title={<ReviewTitle review={props.review} />}
          empty={<ReviewPanelEmpty review={props.review} />}
          diffs={props.review.diffs()}
          diffsReady={props.review.ready()}
          diffVersion={props.review.diffVersion()}
          loadDiff={props.review.loadDiff}
          activeFile={props.review.activeFile()}
          onSelectFile={props.review.focusFile}
          diffStyle={props.review.diffStyle.current()}
          onDiffStyleChange={props.review.diffStyle.set}
          state={props.review.panelState}
          onLineComment={props.review.comments.add}
          onLineCommentUpdate={props.review.comments.update}
          onLineCommentDelete={props.review.comments.remove}
          lineCommentActions={props.review.comments.actions()}
          comments={props.review.comments.all()}
          focusedComment={props.review.comments.focus()}
          onFocusedCommentChange={props.review.comments.changeFocus}
        />
      </Show>
    </div>
  )
}

function ReviewTitle(props: { review: SessionReviewModel }) {
  const language = useLanguage()
  const label = (option: ChangeMode) => {
    if (option === "git") return language.t("ui.sessionReview.title.git")
    if (option === "branch") return language.t("ui.sessionReview.title.branch")
    return language.t("ui.sessionReview.title.lastTurn")
  }
  return (
    <Show when={props.review.canReview()}>
      <Select
        options={props.review.options()}
        current={props.review.mode()}
        label={label}
        placement="bottom-start"
        gutter={6}
        onSelect={(option) => option && props.review.setMode(option)}
      />
    </Show>
  )
}

function ReviewEmpty(props: { review: SessionReviewModel; loadingClass: string }) {
  const language = useLanguage()
  const loading = () => (props.review.mode() === "git" || props.review.mode() === "branch") && !props.review.ready()
  const noGit = () => props.review.mode() === "turn" && props.review.noGit()
  const text = () => {
    if (props.review.mode() === "git") return language.t("session.review.noUncommittedChanges")
    if (props.review.mode() === "branch") return language.t("session.review.noBranchChanges")
    return language.t("session.review.noChanges")
  }
  return (
    <Switch>
      <Match when={loading()}>
        <div class={props.loadingClass}>{language.t("session.review.loadingChanges")}</div>
      </Match>
      <Match when={noGit()}>
        <div class="h-full pb-64 -mt-4 flex flex-col items-center justify-center text-center gap-6">
          <div class="flex flex-col gap-3">
            <div class="text-14-medium text-text-strong">{language.t("session.review.noVcs.createGit.title")}</div>
            <div class="text-14-regular text-text-base max-w-md" style={{ "line-height": "var(--line-height-normal)" }}>
              {language.t("session.review.noVcs.createGit.description")}
            </div>
          </div>
        </div>
      </Match>
      <Match when={true}>
        <div class="h-full pb-64 -mt-4 flex flex-col items-center justify-center text-center gap-6">
          <div class="text-14-regular text-text-weak max-w-56">{text()}</div>
        </div>
      </Match>
    </Switch>
  )
}

function ReviewPanelEmpty(props: { review: SessionReviewModel }) {
  const language = useLanguage()
  const loading = () => (props.review.mode() === "git" || props.review.mode() === "branch") && !props.review.ready()
  const noGit = () => props.review.mode() === "turn" && props.review.noGit()
  return (
    <Switch>
      <Match when={loading()}>
        <div class="px-6 py-4 text-text-weak">{language.t("session.review.loadingChanges")}</div>
      </Match>
      <Match when={noGit()}>
        <div class="h-full pb-64 -mt-4 flex flex-col items-center justify-center text-center gap-6">
          <div class="text-14-regular text-text-weak max-w-56">
            {language.t("session.review.noVcs.createGit.description")}
          </div>
        </div>
      </Match>
      <Match when={true}>
        <SessionReviewEmptyChangesV2 />
      </Match>
    </Switch>
  )
}
