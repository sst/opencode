import { createEffect, mergeProps, onCleanup, onMount, Show, splitProps, type ComponentProps } from "solid-js"
import { Portal } from "solid-js/web"
import { createResizeObserver } from "@solid-primitives/resize-observer"
import { createStore } from "solid-js/store"
import { useI18n } from "../context/i18n"

export type ScrollViewThumbVisibility = "hover" | "scroll"

export interface ScrollViewProps extends ComponentProps<"div"> {
  viewportRef?: (el: HTMLDivElement) => void
  orientation?: "vertical" | "horizontal" | "both"
  /**
   * `hover`: show while hovered or scrolling. `scroll`: show only while scrolling.
   *
   * In most cases, scrolling a container = hovering over it, so this change has no effect.
   * This is a special case to account for the home page scroll, where scrolling a container != hovering over it
   * */
  thumbVisibility?: ScrollViewThumbVisibility
  /** Mount the thumb into an external track. Scroll metrics still come from this ScrollView. */
  thumbContainer?: HTMLElement
  /** Element whose hover reveals the thumb. Defaults to the ScrollView root when unset. */
  thumbHoverTarget?: HTMLElement
  /** Reconcile native scroll geometry before keyboard or scrollbar navigation reads it. */
  onBeforeScroll?: () => void
  /** Offset/extent correction for a virtualized vertical scrollbar. */
  verticalScrollAdjustment?: number
}

export const scrollKey = (event: Pick<KeyboardEvent, "key" | "altKey" | "ctrlKey" | "metaKey" | "shiftKey">) => {
  if (event.altKey || event.ctrlKey || event.metaKey) return
  if (event.shiftKey && event.key !== " ") return

  switch (event.key) {
    case "PageDown":
      return "page-down"
    case "PageUp":
      return "page-up"
    case "Home":
      return "home"
    case "End":
      return "end"
    case "ArrowUp":
      return "up"
    case "ArrowDown":
      return "down"
    case " ":
      return event.shiftKey ? "page-up" : "page-down"
  }
}

export function canScrollKey(element: HTMLElement, key: NonNullable<ReturnType<typeof scrollKey>>) {
  const up = key === "up" || key === "page-up" || key === "home"
  return up ? element.scrollTop > 0 : element.scrollTop + element.clientHeight < element.scrollHeight
}

export function scrollKeyOwner(
  root: HTMLElement,
  target: EventTarget | null,
  key: NonNullable<ReturnType<typeof scrollKey>>,
) {
  const element = target instanceof Element ? target : undefined
  const owner = element?.closest<HTMLElement>("[data-scrollable]")
  if (!owner || owner === root) return root
  if (!root.contains(owner)) return owner
  return canScrollKey(owner, key) ? owner : root
}

export function isScrollKeyTarget(target: EventTarget | null, key: NonNullable<ReturnType<typeof scrollKey>>) {
  const element = target instanceof HTMLElement ? target : undefined
  if (!element) return true
  if (["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName) || element.isContentEditable) return false
  if ((key === "page-up" || key === "page-down") && element.closest('button, a[href], [role="button"]')) return false
  return true
}

export function scrollTopFromThumbPointer(input: {
  pointer: number
  viewportTop: number
  grabOffset: number
  clientHeight: number
  scrollHeight: number
  thumbHeight: number
  /** Viewport height used for max scroll. Defaults to `clientHeight` (track == viewport). */
  scrollClientHeight?: number
}) {
  return scrollOffsetFromThumbPointer({
    pointer: input.pointer,
    viewportStart: input.viewportTop,
    grabOffset: input.grabOffset,
    clientSize: input.clientHeight,
    scrollSize: input.scrollHeight,
    thumbSize: input.thumbHeight,
    scrollClientSize: input.scrollClientHeight,
  })
}

export function scrollOffsetFromThumbPointer(input: {
  pointer: number
  viewportStart: number
  grabOffset: number
  clientSize: number
  scrollSize: number
  thumbSize: number
  scrollClientSize?: number
  reverse?: boolean
}) {
  const padding = 8
  const maxThumbStart = input.clientSize - padding * 2 - input.thumbSize
  if (maxThumbStart <= 0) return 0
  const thumbStart = Math.max(
    0,
    Math.min(input.pointer - input.viewportStart - padding - input.grabOffset, maxThumbStart),
  )
  const progress = input.reverse ? 1 - thumbStart / maxThumbStart : thumbStart / maxThumbStart
  return progress * Math.max(0, input.scrollSize - (input.scrollClientSize ?? input.clientSize))
}

export function ScrollView(props: ScrollViewProps) {
  const i18n = useI18n()
  const merged = mergeProps({ orientation: "vertical", thumbVisibility: "hover" }, props)
  const [local, events, rest] = splitProps(
    merged,
    [
      "class",
      "children",
      "viewportRef",
      "orientation",
      "thumbVisibility",
      "thumbContainer",
      "thumbHoverTarget",
      "onBeforeScroll",
      "verticalScrollAdjustment",
      "style",
    ],
    [
      "onScroll",
      "onWheel",
      "onTouchStart",
      "onTouchMove",
      "onTouchEnd",
      "onTouchCancel",
      "onPointerDown",
      "onClick",
      "onKeyDown",
    ],
  )

  let rootRef!: HTMLDivElement
  let viewportRef!: HTMLDivElement
  let verticalThumbRef!: HTMLDivElement
  let horizontalThumbRef!: HTMLDivElement

  const thumbMount = () => local.thumbContainer
  const thumbHover = () => local.thumbHoverTarget
  const hoverRoot = () => !local.thumbHoverTarget && !local.thumbContainer

  const [state, setState] = createStore({
    isHovered: false,
    dragging: undefined as "vertical" | "horizontal" | undefined,
    isScrolling: false,
    verticalThumbSize: 0,
    verticalThumbStart: 0,
    showVerticalThumb: false,
    horizontalThumbSize: 0,
    horizontalThumbStart: 0,
    showHorizontalThumb: false,
  })
  const isHovered = () => state.isHovered
  const isDragging = () => state.dragging !== undefined
  const isScrolling = () => state.isScrolling
  const vertical = () => local.orientation === "vertical" || local.orientation === "both"
  const horizontal = () => local.orientation === "horizontal" || local.orientation === "both"

  let scrollIdleTimer: ReturnType<typeof setTimeout> | undefined

  const markScrolling = () => {
    setState("isScrolling", true)
    if (scrollIdleTimer !== undefined) clearTimeout(scrollIdleTimer)
    scrollIdleTimer = setTimeout(() => setState("isScrolling", false), 800)
  }

  const thumbVisible = () => {
    if (isDragging()) return true
    if (isScrolling()) return true
    return local.thumbVisibility === "hover" && isHovered()
  }

  onCleanup(() => {
    if (scrollIdleTimer !== undefined) clearTimeout(scrollIdleTimer)
  })

  const updateThumb = () => {
    if (!viewportRef) return
    const trackPadding = 8
    const minThumbSize = 32

    if (vertical()) {
      const adjustment = local.verticalScrollAdjustment ?? 0
      const scrollHeight = viewportRef.scrollHeight + adjustment
      const trackSize = Math.max(0, (thumbMount()?.clientHeight || viewportRef.clientHeight) - trackPadding * 2)
      const size = trackSize
        ? Math.min(trackSize, Math.max((viewportRef.clientHeight / scrollHeight) * trackSize, minThumbSize))
        : 0
      const maxScroll = scrollHeight - viewportRef.clientHeight
      const maxStart = trackSize - size
      setState("showVerticalThumb", maxScroll > 0)
      setState("verticalThumbSize", size)
      setState(
        "verticalThumbStart",
        trackPadding + (maxScroll > 0 ? ((viewportRef.scrollTop + adjustment) / maxScroll) * maxStart : 0),
      )
    } else {
      setState("showVerticalThumb", false)
    }

    if (horizontal()) {
      const trackSize = Math.max(0, (thumbMount()?.clientWidth || viewportRef.clientWidth) - trackPadding * 2)
      const size = trackSize
        ? Math.min(trackSize, Math.max((viewportRef.clientWidth / viewportRef.scrollWidth) * trackSize, minThumbSize))
        : 0
      const maxScroll = viewportRef.scrollWidth - viewportRef.clientWidth
      const maxStart = trackSize - size
      const rtl = getComputedStyle(viewportRef).direction === "rtl"
      const offset = Math.max(0, Math.min(rtl ? -viewportRef.scrollLeft : viewportRef.scrollLeft, maxScroll))
      const start = maxScroll > 0 ? (offset / maxScroll) * maxStart : 0
      setState("showHorizontalThumb", maxScroll > 0)
      setState("horizontalThumbSize", size)
      setState("horizontalThumbStart", trackPadding + (rtl ? maxStart - start : start))
    } else {
      setState("showHorizontalThumb", false)
    }
  }

  onMount(() => {
    if (local.viewportRef) {
      local.viewportRef(viewportRef)
    }

    createResizeObserver(
      () => [viewportRef, viewportRef.firstElementChild, thumbMount()].filter(Boolean) as HTMLElement[],
      updateThumb,
    )

    updateThumb()
  })

  createEffect(() => {
    thumbMount()
    updateThumb()
  })

  createEffect(() => {
    if (!horizontal() || !viewportRef) return
    const observer = new MutationObserver(updateThumb)
    observer.observe(viewportRef, { childList: true, subtree: true, characterData: true })
    onCleanup(() => observer.disconnect())
  })

  createEffect(() => {
    const target = thumbHover()
    if (!target) return

    const enter = () => setState("isHovered", true)
    const leave = () => setState("isHovered", false)
    target.addEventListener("pointerenter", enter)
    target.addEventListener("pointerleave", leave)
    onCleanup(() => {
      target.removeEventListener("pointerenter", enter)
      target.removeEventListener("pointerleave", leave)
      setState("isHovered", false)
    })
  })

  const prepareScroll = () => {
    if (local.onBeforeScroll) {
      local.onBeforeScroll()
      updateThumb()
    }
  }

  const onThumbPointerDown = (axis: "vertical" | "horizontal", e: PointerEvent) => {
    e.preventDefault()
    e.stopPropagation()
    prepareScroll()
    setState("dragging", axis)
    const thumb = axis === "vertical" ? verticalThumbRef : horizontalThumbRef
    const grabOffset =
      axis === "vertical"
        ? e.clientY - thumb.getBoundingClientRect().top
        : e.clientX - thumb.getBoundingClientRect().left
    const track = thumbMount() ?? viewportRef

    thumb.setPointerCapture(e.pointerId)

    const onPointerMove = (e: PointerEvent) => {
      prepareScroll()
      const vertical = axis === "vertical"
      const rtl = !vertical && getComputedStyle(viewportRef).direction === "rtl"
      const offset = scrollOffsetFromThumbPointer({
        pointer: vertical ? e.clientY : e.clientX,
        viewportStart: vertical ? track.getBoundingClientRect().top : track.getBoundingClientRect().left,
        grabOffset,
        clientSize: vertical ? track.clientHeight : track.clientWidth,
        scrollClientSize: vertical ? viewportRef.clientHeight : viewportRef.clientWidth,
        scrollSize: vertical ? viewportRef.scrollHeight : viewportRef.scrollWidth,
        thumbSize: vertical ? state.verticalThumbSize : state.horizontalThumbSize,
        reverse: rtl,
      })
      if (vertical) {
        viewportRef.scrollTop = offset
        return
      }
      viewportRef.scrollLeft = rtl ? -offset : offset
    }

    const done = (e: PointerEvent) => {
      setState("dragging", undefined)
      thumb.releasePointerCapture(e.pointerId)
      thumb.removeEventListener("pointermove", onPointerMove)
      thumb.removeEventListener("pointerup", done)
      thumb.removeEventListener("pointercancel", done)
    }

    thumb.addEventListener("pointermove", onPointerMove)
    thumb.addEventListener("pointerup", done)
    thumb.addEventListener("pointercancel", done)
  }

  const renderVerticalThumb = () => (
    <div
      ref={(el) => {
        verticalThumbRef = el
      }}
      onPointerDown={(event) => onThumbPointerDown("vertical", event)}
      class="scroll-view__thumb"
      data-orientation="vertical"
      data-visible={thumbVisible()}
      data-dragging={state.dragging === "vertical"}
      style={{
        height: `${state.verticalThumbSize}px`,
        transform: `translateY(${state.verticalThumbStart}px)`,
        "z-index": 100, // ensure it displays over content
      }}
    />
  )

  const renderHorizontalThumb = () => (
    <div
      ref={(el) => {
        horizontalThumbRef = el
      }}
      onPointerDown={(event) => onThumbPointerDown("horizontal", event)}
      class="scroll-view__thumb"
      data-orientation="horizontal"
      data-visible={thumbVisible()}
      data-dragging={state.dragging === "horizontal"}
      style={{
        width: `${state.horizontalThumbSize}px`,
        transform: `translateX(${state.horizontalThumbStart}px)`,
        "z-index": 100,
      }}
    />
  )

  // Keybinds implementation
  // We ensure the viewport has a tabindex so it can receive focus
  // We can also explicitly catch PageUp/Down if we want smooth scroll or specific behavior,
  // but native usually handles this perfectly. Let's explicitly ensure it behaves well.
  const onKeyDown = (e: KeyboardEvent) => {
    // If user is focused on an input inside the scroll view, don't hijack keys
    if (document.activeElement && ["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement.tagName)) {
      return
    }
    const next = scrollKey(e)
    // Modified navigation (for example Ctrl+Home) stays native, but must read
    // the same reconciled geometry as the keys handled by this component.
    const intent =
      next ??
      scrollKey({
        key: e.key,
        shiftKey: e.key === " " && e.shiftKey,
        altKey: false,
        ctrlKey: false,
        metaKey: false,
      })
    if (!intent) return
    if (!isScrollKeyTarget(e.target, intent)) return
    if (scrollKeyOwner(viewportRef, e.target, intent) !== viewportRef) return

    prepareScroll()
    if (!next) return
    const scrollAmount = viewportRef.clientHeight * 0.8
    const lineAmount = 40

    switch (next) {
      case "page-down":
        e.preventDefault()
        viewportRef.scrollBy({ top: scrollAmount, behavior: "smooth" })
        break
      case "page-up":
        e.preventDefault()
        viewportRef.scrollBy({ top: -scrollAmount, behavior: "smooth" })
        break
      case "home":
        e.preventDefault()
        viewportRef.scrollTo({ top: 0, behavior: "smooth" })
        break
      case "end":
        e.preventDefault()
        viewportRef.scrollTo({ top: viewportRef.scrollHeight, behavior: "smooth" })
        break
      case "up":
        e.preventDefault()
        viewportRef.scrollBy({ top: -lineAmount, behavior: "smooth" })
        break
      case "down":
        e.preventDefault()
        viewportRef.scrollBy({ top: lineAmount, behavior: "smooth" })
        break
    }
  }

  return (
    <div
      ref={rootRef}
      class={`scroll-view ${local.class || ""}`}
      data-orientation={local.orientation}
      style={local.style}
      onPointerEnter={() => {
        if (hoverRoot()) setState("isHovered", true)
      }}
      onPointerLeave={() => {
        if (hoverRoot()) setState("isHovered", false)
      }}
      {...rest}
    >
      {/* Viewport */}
      <div
        ref={viewportRef}
        class="scroll-view__viewport"
        data-scrollable
        onScroll={(e) => {
          updateThumb()
          markScrolling()
          if (typeof events.onScroll === "function") events.onScroll(e as any)
        }}
        onWheel={(e) => {
          markScrolling()
          const handler = events.onWheel
          if (typeof handler === "function") handler(e as any)
          if (Array.isArray(handler)) handler[0](handler[1], e as any)
        }}
        onTouchStart={events.onTouchStart as any}
        onTouchMove={events.onTouchMove as any}
        onTouchEnd={events.onTouchEnd as any}
        onTouchCancel={events.onTouchCancel as any}
        onPointerDown={events.onPointerDown as any}
        onClick={events.onClick as any}
        tabIndex={0}
        role="region"
        aria-label={i18n.t("ui.scrollView.ariaLabel")}
        onKeyDown={(e) => {
          onKeyDown(e)
          if (typeof events.onKeyDown === "function") events.onKeyDown(e as any)
        }}
      >
        {local.children}
      </div>

      {/* Thumb Overlay — optionally portaled into an external track */}
      <Show when={state.showVerticalThumb}>
        <Show when={thumbMount()} fallback={renderVerticalThumb()}>
          {(mount) => <Portal mount={mount()}>{renderVerticalThumb()}</Portal>}
        </Show>
      </Show>
      <Show when={state.showHorizontalThumb}>
        <Show when={thumbMount()} fallback={renderHorizontalThumb()}>
          {(mount) => <Portal mount={mount()}>{renderHorizontalThumb()}</Portal>}
        </Show>
      </Show>
    </div>
  )
}
