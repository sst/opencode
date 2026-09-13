import {
  ErrorBoundary,
  Show,
  Match,
  Switch,
  Suspense,
  lazy,
  createMemo,
  createEffect,
  createComputed,
  on,
  onMount,
} from "solid-js"
import { createStore } from "solid-js/store"
import { makeEventListener } from "@solid-primitives/event-listener"
import { debounce } from "@solid-primitives/scheduled"
import { ResizeHandle } from "@opencode/ui/resize-handle"
import { MessageTimeline } from "@/session/timeline/message-timeline"
import { useServer } from "@/runtime/server/current"
import { projectForSession } from "@/shell/layout/helpers"
import { ComposerDropzone } from "@/composer/dropzone"
import type { SessionModel } from "@/session/model"
import { SESSION_PANEL_WIDTH_MIN } from "@/session/session-panel-width"
import { SessionPanelFrame } from "@/session/session-frame"
import { TerminalPanel } from "@/session/terminal/panel"
import { useUsageExceededDialogs } from "./usage-exceeded-dialogs"
import { SessionErrorFallback } from "./route-error"
import { createSessionScreenLayout } from "./screen-layout"
import { createSessionReview } from "./review/model"
import { SessionDesktopReview, SessionMobileReview, SessionMobileViewTabs } from "./review/view"
import { SessionContextTab } from "./files/session-context-tab"
import { createSessionTimelineInteraction } from "./timeline/interaction"
import { createTimelineSearchController } from "./timeline/search-controller"
import { TimelineSearchBar } from "./timeline/search-bar"
import { ActiveSessionComposerRegion, createActiveSessionRegion } from "./composer/region"
import { SessionIdentityHeader } from "./session-identity-header"
import { SessionReviewToggle } from "./header/session-header-actions"
import { createAnimatedPresence } from "@/runtime/animated-presence"
import { createSessionBrowser } from "./browser/model"
import { createTimelineCache } from "./timeline/cache"

const SessionMobileFiles = lazy(async () => {
  const { SessionMobileFiles } = await import("./files/session-mobile-files")
  return { default: SessionMobileFiles }
})

const SessionSummaryPanel = lazy(async () => {
  const { SessionSummaryPanel } = await import("./summary/panel")
  return { default: SessionSummaryPanel }
})

export function SessionScreen(props: { session: SessionModel }) {
  const session = props.session
  const server = useServer()
  const detailsProject = createMemo(() => {
    const info = session.data.info()
    return info ? projectForSession(info, server.ctx.sync.data.project) : undefined
  })
  const isDesktop = session.isDesktop
  const browser = createSessionBrowser(session)
  const screen = createSessionScreenLayout(session)
  const timeline = createSessionTimelineInteraction(session)
  const timelineSearch = createTimelineSearchController({
    sessionID: session.identity.sessionID,
    scrollRef: timeline.scroller,
    revealMessage: timeline.actions.revealMessage,
    pauseAutoScroll: timeline.view.unpin,
  })
  const messagesReady = timeline.ready
  const [store, setStore] = createStore({
    deferRender: false,
    bottomTerminalCached: false,
    sideWidthMotion: false,
    timelineScrollbarHidden: false,
    sideHeightMotion: false,
    sideRegionPresent: false,
    sideReviewPresent: false,
    sideTerminalPresent: false,
    mobileTerminalCached: false,
    mobileMoveDismissed: false,
    summaryResizeTranslate: undefined as string | undefined,
  })
  const [elements, setElements] = createStore<{
    chat?: HTMLDivElement
    side?: HTMLDivElement
    bottomTerminal?: HTMLDivElement
  }>({})
  const finishWindowResize = debounce(() => setStore("summaryResizeTranslate", undefined), 150)
  onMount(() => {
    makeEventListener(window, "resize", () => {
      if (store.summaryResizeTranslate === undefined) {
        const content = elements.chat?.querySelector("[data-timeline-virtual-content]")
        // Freeze the painted offset, including an in-flight slide, until resizing settles.
        setStore("summaryResizeTranslate", content ? getComputedStyle(content).translate : "none")
      }
      finishWindowResize()
    })
  })
  const sideVisible = createMemo(() => isDesktop() && screen.side.layout().visible)
  const sideTerminalVisible = createMemo(() => isDesktop() && screen.terminal.side() && screen.terminal.open())
  const bottomTerminalVisible = createMemo(() => isDesktop() && screen.terminal.open() && screen.terminal.bottom())
  const sidePresence = createAnimatedPresence(
    () => sideVisible() || undefined,
    () => elements.side ?? null,
    session.layout.tabKey,
  )
  const bottomTerminalPresence = createAnimatedPresence(
    () => bottomTerminalVisible() || undefined,
    () => elements.bottomTerminal ?? null,
    session.layout.tabKey,
  )
  const sideMotion = createMemo<{
    key?: string
    region: boolean
    terminal: boolean
    animateRegion: boolean
    animateTerminal: boolean
  }>((previous) => {
    const key = session.layout.tabKey()
    const region = screen.side.region.open()
    const terminal = sideTerminalVisible()
    const sameTab = previous?.key === key
    return {
      key,
      region,
      terminal,
      animateRegion: !!previous && sameTab && previous.region !== region,
      animateTerminal: !!previous && sameTab && previous.terminal !== terminal,
    }
  })
  const paneAnimating = () =>
    sidePresence.animate() ||
    sideMotion().animateRegion ||
    sideMotion().animateTerminal ||
    bottomTerminalPresence.animate()
  const trackSideWidthMotion = (event: TransitionEvent) => {
    if (event.currentTarget !== event.target || event.propertyName !== "width") return
    setStore("sideWidthMotion", event.type === "transitionrun")
  }
  const hideTimelineScrollbar = () => setStore("timelineScrollbarHidden", true)
  const revealTimelineScrollbar = (event: Event) => {
    if (!store.timelineScrollbarHidden || store.sideWidthMotion) return
    if (!(event.target instanceof Element) || !event.target.closest('[data-slot="session-timeline-scroll"]')) return
    setStore("timelineScrollbarHidden", false)
  }
  createEffect(() => {
    if (sideTerminalVisible()) setStore("sideTerminalPresent", true)
    if (bottomTerminalVisible()) setStore("bottomTerminalCached", true)
    if (!sideVisible()) setStore("sideHeightMotion", false)
  })
  createEffect(() => {
    if (!isDesktop() || screen.terminal.bottom()) setStore("sideTerminalPresent", false)
    if (isDesktop() && screen.terminal.side()) setStore("bottomTerminalCached", false)
  })
  createEffect(() => {
    if (screen.side.region.open()) setStore("sideRegionPresent", true)
    if (screen.review.panelOpen()) setStore("sideReviewPresent", true)
  })

  createComputed((prev) => {
    const key = session.identity.sessionKey()
    if (key !== prev) {
      setStore("mobileMoveDismissed", false)
      setStore("deferRender", true)
      const owner = session.ownership.capture()
      requestAnimationFrame(() => {
        setTimeout(() => owner.run(() => setStore("deferRender", false)), 0)
      })
    }
    return key
  })
  const review = createSessionReview({ session, screen, deferRender: () => store.deferRender })
  const mobileView = createMemo(() => (screen.terminal.open() ? "terminal" : review.mobile.tab()))
  const conversationVisible = createMemo(() => isDesktop() || mobileView() === "session")
  createEffect(() => {
    if (!isDesktop() && screen.terminal.open()) setStore("mobileTerminalCached", true)
  })
  const composer = createActiveSessionRegion({
    session,
    screen,
    timeline,
    visible: conversationVisible,
  })
  useUsageExceededDialogs()

  const sessionErrorFallback = (error: unknown, reset: () => void) => {
    createEffect(on(session.identity.sessionKey, reset, { defer: true }))
    return <SessionErrorFallback error={error} sessionID={session.identity.params.id} />
  }

  const mobileTabs = () => (
    <Show when={session.identity.sessionKey()} keyed>
      {(_key) => (
        <SessionMobileViewTabs
          current={mobileView()}
          onDetailsOpenChange={review.details.setOpen}
          details={
            !session.data.isChild() && detailsProject()
              ? (close) => (
                  <Show when={detailsProject()}>
                    {(project) => (
                      <SessionSummaryPanel
                        mobile
                        project={project()}
                        directory={session.workspace.directory()}
                        local={!session.workspace.current()}
                        branch={
                          session.shared.data.location.vcs.info({ directory: session.workspace.directory() })?.branch
                            .current
                        }
                        baseBranch={
                          session.shared.data.location.vcs.info({ directory: project().worktree })?.branch.current
                        }
                        diffs={project().vcs ? review.details.diffs() : []}
                        sessionID={session.identity.params.id ?? ""}
                        moveEligible={composer.workspaceMoveEligible()}
                        moveDismissed={store.mobileMoveDismissed}
                        onMoveDismiss={() => setStore("mobileMoveDismissed", true)}
                        onReview={() => {
                          close()
                          review.mobile.setTab("changes")
                          session.layout.view().terminal.close()
                        }}
                        backgroundTasks={composer.requests.background.tasks()}
                      />
                    )}
                  </Show>
                )
              : undefined
          }
          onSelect={(view) => {
            if (view === "terminal") {
              session.layout.view().terminal.open()
              return
            }
            review.mobile.setTab(view)
            session.layout.view().terminal.close()
          }}
        />
      )}
    </Show>
  )

  const timelineView = createTimelineCache(
    session,
    (source, active) => (
      <MessageTimeline
        active={active()}
        hideHeader={!isDesktop()}
        session={source}
        background={composer.requests.background}
        actions={composer.actions.timeline}
        scroll={timeline.scroll}
        onResumeScroll={timeline.actions.resume}
        setScrollRef={timeline.view.setScrollRef}
        onScheduleScrollState={timeline.view.scheduleScrollState}
        onPin={timeline.view.pin}
        onUnpin={timeline.view.unpin}
        onUserScroll={timeline.view.markUserScroll}
        onHistoryScroll={timeline.view.onHistoryScroll}
        onSelectionInteraction={timeline.view.selectionInteraction}
        pinned={timeline.view.pinned()}
        centered={screen.centered()}
        reserveReviewToggle={!sideVisible()}
        setContentRef={timeline.view.setContentRef}
        diffs={review.details.diffs}
        onReview={review.open}
        workspaceMoveEligible={composer.workspaceMoveEligible()}
        onSummaryOpenChange={review.details.setOpen}
        anchor={timeline.view.anchor}
        setRevealMessage={timeline.view.setRevealMessage}
        setScrollToEnd={timeline.view.setScrollToEnd}
        search={
          <Show when={active()}>
            <TimelineSearchBar controller={timelineSearch} />
          </Show>
        }
      />
    ),
    () => conversationVisible() && messagesReady(),
  )

  const sessionPanelContent = () => (
    <>
      <ComposerDropzone
        active={composer.drop.active()}
        input={composer.drop.input()}
        identity={session.layout.tabKey}
      />
      <Show when={!isDesktop() && !!session.identity.params.id}>{mobileTabs()}</Show>
      {/* Surface query errors without suspending session metadata while messages load. */}
      <Show when={timeline.resource.error}>
        {(error) => {
          throw error()
        }}
      </Show>
      <div class="relative flex-1 min-h-0 overflow-hidden">
        <Show when={!isDesktop() && store.mobileTerminalCached}>
          <div class="absolute inset-0" classList={{ invisible: mobileView() !== "terminal" }}>
            <TerminalPanel fill embedded present contentHeight="100%" />
          </div>
        </Show>
        <Switch>
          <Match when={!isDesktop() && mobileView() === "terminal"}>
            <></>
          </Match>
          <Match when={!isDesktop() && mobileView() === "usage"}>
            <SessionContextTab />
          </Match>
          <Match when={!isDesktop() && mobileView() === "files"}>
            <Suspense>
              <SessionMobileFiles />
            </Suspense>
          </Match>
          <Match when={session.identity.params.id && review.mobile.changes()}>
            <SessionMobileReview review={review} />
          </Match>
          <Match when={session.identity.params.id}>
            <Show when={isDesktop() && !messagesReady()}>
              <SessionIdentityHeader sessionID={session.identity.params.id ?? ""} session={session.data.info()} />
            </Show>
            <Show when={messagesReady() && session.identity.params.id}>{timelineView()}</Show>
          </Match>
        </Switch>
      </div>

      <Show when={composer.active()} keyed>
        {(model) => <ActiveSessionComposerRegion model={model} />}
      </Show>
    </>
  )

  return (
    <>
      <div class="flex-1 min-h-0 flex flex-col gap-2 px-2 pb-[var(--shell-bottom-inset,8px)] pt-[var(--shell-top-inset,8px)]">
        <div ref={screen.panel.ref} class="relative flex-1 min-h-0 flex flex-col md:flex-row gap-2">
          {/* Keep the control outside panel animations; the terminal's 52px header includes a 1px divider. */}
          <Show when={isDesktop() && messagesReady() && session.identity.params.id}>
            <div
              class="absolute end-3 top-0 z-30 flex items-center"
              classList={{ "h-[51px]": sideTerminalVisible(), "h-12": !sideTerminalVisible() }}
              data-slot="session-review-toggle"
              onPointerDown={hideTimelineScrollbar}
              onClick={hideTimelineScrollbar}
            >
              <SessionReviewToggle />
            </div>
          </Show>
          <div
            classList={{
              "@container relative z-10 min-w-0 shrink-0 flex flex-col min-h-0 h-full flex-1 md:flex-none transition-[width]": true,
              "duration-[240ms] ease-[cubic-bezier(0.4,0,0.2,1)] will-change-[width] motion-reduce:transition-none":
                !screen.size.active() && sidePresence.animate(),
              "transition-none": screen.size.active() || !sidePresence.animate(),
            }}
            data-slot="session-chat-panel"
            ref={(element) => setElements("chat", element)}
            data-summary-open={isDesktop() && review.details.open()}
            data-summary-resizing={store.summaryResizeTranslate !== undefined}
            data-width-animating={store.sideWidthMotion}
            data-scrollbar-hidden={store.timelineScrollbarHidden || store.sideWidthMotion}
            onPointerMove={revealTimelineScrollbar}
            onPointerDown={revealTimelineScrollbar}
            onWheel={revealTimelineScrollbar}
            onKeyDown={revealTimelineScrollbar}
            onTransitionRun={trackSideWidthMotion}
            onTransitionEnd={trackSideWidthMotion}
            onTransitionCancel={trackSideWidthMotion}
            style={{
              width: screen.panel.width(),
              "--session-summary-resize-translate": store.summaryResizeTranslate,
            }}
          >
            <Show when={!!session.identity.params.id}>
              <SessionPanelFrame raised>
                <ErrorBoundary fallback={sessionErrorFallback}>{sessionPanelContent()}</ErrorBoundary>
              </SessionPanelFrame>
            </Show>

            <Show when={screen.panel.resizable()}>
              <div onPointerDown={() => screen.size.start()}>
                <ResizeHandle
                  class="-end-1"
                  direction="horizontal"
                  size={screen.panel.resizedWidth()}
                  min={SESSION_PANEL_WIDTH_MIN}
                  max={screen.panel.max()}
                  onResize={(width) => {
                    screen.size.touch()
                    session.layout.view().reviewPanel.resize(width)
                  }}
                />
              </div>
            </Show>
          </div>

          <Show when={sidePresence.present() || store.sideReviewPresent || store.sideTerminalPresent}>
            <div
              ref={(element) => setElements("side", element)}
              data-slot="session-side-panel-presence"
              data-opened={sidePresence.animate() ? sidePresence.show() : undefined}
              onAnimationEnd={(event) => {
                if (event.currentTarget !== event.target) return
                if (event.animationName !== "side-region-presence-in" || !sideVisible()) return
                setStore("sideHeightMotion", true)
              }}
              classList={{
                "relative z-0 min-w-0 h-full flex-1 overflow-visible": sidePresence.present(),
                "absolute inset-y-0 end-0 z-0 w-0 invisible pointer-events-none overflow-visible":
                  !sidePresence.present(),
              }}
            >
              <div
                data-slot="session-side-panel-content"
                class="absolute inset-y-0 start-0 size-full"
                style={{ "--session-side-content-width": screen.side.contentWidth() }}
              >
                <div
                  data-slot="session-side-region"
                  classList={{
                    "absolute inset-x-0 top-0 min-h-0 overflow-visible transition-[height] duration-[240ms] ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none": true,
                    "will-change-[height]": !screen.size.active() && store.sideHeightMotion && paneAnimating(),
                    "transition-none": screen.size.active() || !store.sideHeightMotion || !paneAnimating(),
                  }}
                  style={{ height: sideVisible() ? screen.side.region.height() : "100%" }}
                >
                  <Show when={store.sideRegionPresent}>
                    <div
                      data-slot="session-side-region-presence"
                      data-opened={sideMotion().animateRegion ? sideMotion().region : undefined}
                      class="absolute inset-0"
                      onAnimationEnd={(event) => {
                        if (event.currentTarget !== event.target) return
                        if (event.animationName !== "side-region-presence-out") return
                        if (screen.side.region.open()) return
                        if (sideTerminalVisible()) return
                        setStore("sideRegionPresent", false)
                        setStore("sideReviewPresent", false)
                      }}
                    >
                      <SessionDesktopReview review={review} browser={browser} present={store.sideReviewPresent} />
                    </div>
                  </Show>
                </div>
                <div class="absolute start-0 bottom-0 flex flex-col" style={{ width: screen.side.contentWidth() }}>
                  <div
                    data-slot="session-side-panel-gap"
                    classList={{
                      "relative z-0 shrink-0 overflow-visible bg-v2-background-bg-deep transition-[height] duration-[40ms] ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none": true,
                      "delay-0": !screen.side.gap.closing(),
                      "delay-[200ms]": screen.side.gap.closing(),
                      "transition-none": !paneAnimating(),
                    }}
                    style={{ height: screen.side.gap.height() }}
                    onPointerDown={() => screen.size.start()}
                  >
                    <Show when={screen.side.layout().stacked}>
                      <ResizeHandle
                        class="!relative !inset-auto !h-full !w-full !transform-none"
                        direction="vertical"
                        size={session.layout.view().terminal.height()}
                        min={100}
                        max={typeof window === "undefined" ? 600 : window.innerHeight * 0.6}
                        collapseThreshold={50}
                        onResize={(height) => {
                          screen.size.touch()
                          session.layout.view().terminal.resize(height)
                        }}
                        onCollapse={() => session.layout.view().terminal.close()}
                      />
                    </Show>
                  </div>
                  <div
                    data-slot="session-side-terminal-region"
                    classList={{
                      "relative z-10 min-h-0 shrink-0 overflow-visible transition-[height] duration-[240ms] ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none": true,
                      "will-change-[height]": !screen.size.active() && store.sideHeightMotion && paneAnimating(),
                      "transition-none": screen.size.active() || !store.sideHeightMotion || !paneAnimating(),
                    }}
                    style={{ height: screen.side.terminal.height() }}
                  >
                    <Show when={store.sideTerminalPresent}>
                      <div
                        data-slot="side-terminal-panel-presence"
                        data-opened={sideMotion().animateTerminal ? sideMotion().terminal : undefined}
                        class="absolute inset-0 rounded-[10px] bg-v2-background-bg-base shadow-[var(--v2-elevation-raised)]"
                      >
                        <div data-slot="side-terminal-panel-clip" class="size-full overflow-clip rounded-[10px]">
                          <TerminalPanel
                            fill
                            framed={false}
                            present={store.sideTerminalPresent}
                            animate={sidePresence.animate() || sideMotion().animateTerminal}
                            contentHeight={screen.side.terminal.contentHeight()}
                            reserveReviewToggle={!screen.side.region.open()}
                          />
                        </div>
                      </div>
                    </Show>
                  </div>
                </div>
              </div>
            </div>
          </Show>
        </div>

        <Show when={isDesktop() && (bottomTerminalPresence.present() || store.bottomTerminalCached)}>
          <div
            ref={(element) => setElements("bottomTerminal", element)}
            data-slot="terminal-panel-presence"
            data-opened={bottomTerminalPresence.animate() ? bottomTerminalPresence.show() : undefined}
            classList={{
              hidden: !bottomTerminalPresence.present(),
              "relative min-h-0 shrink-0": isDesktop(),
            }}
          >
            <Show when={isDesktop()}>
              <div class="absolute z-10 -top-1 left-0 right-0 h-2" onPointerDown={() => screen.size.start()}>
                <ResizeHandle
                  class="!relative !inset-auto !h-full !w-full !transform-none"
                  direction="vertical"
                  size={session.layout.view().terminal.height()}
                  min={100}
                  max={typeof window === "undefined" ? 600 : window.innerHeight * 0.6}
                  collapseThreshold={50}
                  onResize={(height) => {
                    screen.size.touch()
                    session.layout.view().terminal.resize(height)
                  }}
                  onCollapse={() => session.layout.view().terminal.close()}
                />
              </div>
            </Show>
            <TerminalPanel
              stacked={isDesktop()}
              present={store.bottomTerminalCached}
              animate={bottomTerminalPresence.animate()}
            />
          </div>
        </Show>
      </div>
    </>
  )
}
