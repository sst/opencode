import { sampledChecksum } from "@opencode-ai/core/util/encode"
import {
  areFilesEqual,
  areOptionsEqual,
  DEFAULT_VIRTUAL_FILE_METRICS,
  type DiffLineAnnotation,
  type FileContents,
  type FileDiffMetadata,
  File as PierreFile,
  type FileDiffOptions,
  FileDiff,
  type FileOptions,
  type LineAnnotation,
  type SelectedLineRange,
  type VirtualFileMetrics,
  VirtualizedFile,
  VirtualizedFileDiff,
  Virtualizer,
} from "@pierre/diffs"
import { type PreloadFileDiffResult, type PreloadMultiFileDiffResult } from "@pierre/diffs/ssr"
import { createMediaQuery } from "@solid-primitives/media"
import { makeEventListener } from "@solid-primitives/event-listener"
import { ComponentProps, createEffect, createMemo, createSignal, onCleanup, onMount, Show, splitProps } from "solid-js"
import { createDefaultOptions, styleVariables } from "../pierre"
import { markCommentedDiffLines, markCommentedFileLines } from "../pierre/commented-lines"
import { fixDiffSelection, findDiffSide, type DiffSelectionSide } from "../pierre/diff-selection"
import { createFileFind } from "../pierre/file-find"
import {
  applyViewerScheme,
  clearReadyWatcher,
  createReadyWatcher,
  getViewerHost,
  getViewerRoot,
  notifyShadowReady,
  observeViewerScheme,
} from "../pierre/file-runtime"
import {
  findCodeSelectionSide,
  findDiffLineNumber,
  findElement,
  findFileLineNumber,
  readShadowLineSelection,
} from "../pierre/file-selection"
import { createLineNumberSelectionBridge, restoreShadowTextSelection } from "../pierre/selection-bridge"
import { acquireVirtualizer, virtualMetrics } from "../pierre/virtualizer"
import { getWorkerPool } from "../pierre/worker"
import { FileMedia, type FileMediaOptions } from "./file-media"
import { FileSearchBar } from "./file-search"

const VIRTUALIZE_BYTES = 500_000

const codeMetrics = {
  ...DEFAULT_VIRTUAL_FILE_METRICS,
  lineHeight: 24,
  spacing: 0,
} satisfies Partial<VirtualFileMetrics>

type SharedProps<T> = {
  annotations?: LineAnnotation<T>[] | DiffLineAnnotation<T>[]
  selectedLines?: SelectedLineRange | null
  commentedLines?: SelectedLineRange[]
  onLineNumberSelectionEnd?: (selection: SelectedLineRange | null) => void
  onRendered?: () => void
  class?: string
  classList?: ComponentProps<"div">["classList"]
  media?: FileMediaOptions
  search?: FileSearchControl
}

export type FileSearchHandle = {
  focus: () => void
}

export type FileSearchControl = {
  register: (handle: FileSearchHandle | null) => void
}

export type TextFileProps<T = {}> = FileOptions<T> &
  SharedProps<T> & {
    mode: "text"
    file: FileContents
    annotations?: LineAnnotation<T>[]
    preloadedDiff?: PreloadMultiFileDiffResult<T>
  }

type DiffPreload<T> = PreloadMultiFileDiffResult<T> | PreloadFileDiffResult<T>

type DiffBaseProps<T> = FileDiffOptions<T> &
  SharedProps<T> & {
    mode: "diff"
    annotations?: DiffLineAnnotation<T>[]
    preloadedDiff?: DiffPreload<T>
    virtualize?: boolean
  }

type DiffPairProps<T> = DiffBaseProps<T> & {
  before: FileContents
  after: FileContents
  fileDiff?: undefined
}

type DiffPatchProps<T> = DiffBaseProps<T> & {
  fileDiff: FileDiffMetadata
  before?: undefined
  after?: undefined
}

export type DiffFileProps<T = {}> = DiffPairProps<T> | DiffPatchProps<T>

export type FileProps<T = {}> = TextFileProps<T> | DiffFileProps<T>

const sharedKeys = [
  "mode",
  "media",
  "class",
  "classList",
  "annotations",
  "selectedLines",
  "commentedLines",
  "search",
  "onLineSelected",
  "onLineSelectionEnd",
  "onLineNumberSelectionEnd",
  "onRendered",
  "preloadedDiff",
] as const

const textKeys = ["file", ...sharedKeys] as const
const diffKeys = ["fileDiff", "before", "after", "virtualize", ...sharedKeys] as const

// ---------------------------------------------------------------------------
// Shared viewer hook
// ---------------------------------------------------------------------------

type MouseHit = {
  line: number | undefined
  numberColumn: boolean
  side?: DiffSelectionSide
}

type ViewerConfig = {
  enableLineSelection: () => boolean
  selectedLines: () => SelectedLineRange | null | undefined
  commentedLines: () => SelectedLineRange[]
  onLineSelectionEnd: (range: SelectedLineRange | null) => void

  // mode-specific callbacks
  lineFromMouseEvent: (event: MouseEvent) => MouseHit
  setSelectedLines: (range: SelectedLineRange | null, preserve?: { root: ShadowRoot; text: Range }) => void
  updateSelection: (preserveTextSelection: boolean) => void
  buildDragSelection: () => SelectedLineRange | undefined
  buildClickSelection: () => SelectedLineRange | undefined
  onDragStart: (hit: MouseHit) => void
  onDragMove: (hit: MouseHit) => void
  onDragReset: () => void
  markCommented: (root: ShadowRoot, ranges: SelectedLineRange[]) => void
}

function useFileViewer(config: ViewerConfig) {
  let wrapper!: HTMLDivElement
  let container!: HTMLDivElement
  let overlay!: HTMLDivElement
  let selectionFrame: number | undefined
  let dragFrame: number | undefined
  let dragStart: number | undefined
  let dragEnd: number | undefined
  let dragMoved = false
  let lastSelection: SelectedLineRange | null = null
  let pendingSelectionEnd = false

  const ready = createReadyWatcher()
  const bridge = createLineNumberSelectionBridge()
  const [rendered, setRendered] = createSignal(0)

  const getRoot = () => getViewerRoot(container)
  const getHost = () => getViewerHost(container)

  const find = createFileFind({
    wrapper: () => wrapper,
    overlay: () => overlay,
    getRoot,
  })

  // -- selection scheduling --

  const scheduleSelectionUpdate = () => {
    if (selectionFrame !== undefined) return
    selectionFrame = requestAnimationFrame(() => {
      selectionFrame = undefined
      const finishing = pendingSelectionEnd
      config.updateSelection(finishing)
      if (!pendingSelectionEnd) return
      pendingSelectionEnd = false
      config.onLineSelectionEnd(lastSelection)
    })
  }

  const scheduleDragUpdate = () => {
    if (dragFrame !== undefined) return
    dragFrame = requestAnimationFrame(() => {
      dragFrame = undefined
      const selected = config.buildDragSelection()
      if (selected) config.setSelectedLines(selected)
    })
  }

  // -- mouse handlers --

  const handleMouseDown = (event: MouseEvent) => {
    if (!config.enableLineSelection()) return
    if (event.button !== 0) return

    const hit = config.lineFromMouseEvent(event)
    if (hit.numberColumn) {
      bridge.begin(true, hit.line)
      return
    }
    if (hit.line === undefined) return

    bridge.begin(false, hit.line)
    dragStart = hit.line
    dragEnd = hit.line
    dragMoved = false
    config.onDragStart(hit)
  }

  const handleMouseMove = (event: MouseEvent) => {
    if (!config.enableLineSelection()) return

    const hit = config.lineFromMouseEvent(event)
    if (bridge.track(event.buttons, hit.line)) return
    if (dragStart === undefined) return

    if ((event.buttons & 1) === 0) {
      dragStart = undefined
      dragEnd = undefined
      dragMoved = false
      config.onDragReset()
      bridge.finish()
      return
    }

    if (hit.line === undefined) return
    dragEnd = hit.line
    dragMoved = true
    config.onDragMove(hit)
    scheduleDragUpdate()
  }

  const handleMouseUp = () => {
    if (!config.enableLineSelection()) return
    if (bridge.finish() === "numbers") return
    if (dragStart === undefined) return

    if (!dragMoved) {
      pendingSelectionEnd = false
      const selected = config.buildClickSelection()
      const next =
        selected &&
        lastSelection?.start === selected.start &&
        lastSelection.end === selected.end &&
        lastSelection.side === selected.side &&
        (lastSelection.endSide ?? lastSelection.side) === (selected.endSide ?? selected.side)
          ? null
          : selected
      if (next !== undefined) config.setSelectedLines(next)
      config.onLineSelectionEnd(next === undefined ? lastSelection : next)
      dragStart = undefined
      dragEnd = undefined
      dragMoved = false
      config.onDragReset()
      return
    }

    pendingSelectionEnd = true
    scheduleDragUpdate()
    scheduleSelectionUpdate()

    dragStart = undefined
    dragEnd = undefined
    dragMoved = false
    config.onDragReset()
  }

  const handleSelectionChange = () => {
    if (!config.enableLineSelection()) return
    if (dragStart === undefined) return
    const selection = window.getSelection()
    if (!selection || selection.isCollapsed) return
    scheduleSelectionUpdate()
  }

  // -- shared effects --

  onMount(() => {
    onCleanup(observeViewerScheme(getHost))
  })

  createEffect(() => {
    rendered()
    const ranges = config.commentedLines()
    const root = getRoot()
    if (!root) return
    if (ranges.length === 0) {
      config.markCommented(root, ranges)
      return
    }

    let frame: number | undefined
    const mark = () => {
      if (frame !== undefined) cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        frame = undefined
        config.markCommented(root, ranges)
      })
    }
    const observer = new MutationObserver(mark)

    observer.observe(root, { childList: true, subtree: true })
    mark()

    onCleanup(() => {
      observer.disconnect()
      if (frame !== undefined) cancelAnimationFrame(frame)
    })
  })

  createEffect(() => {
    config.setSelectedLines(config.selectedLines() ?? null)
  })

  createEffect(() => {
    if (!config.enableLineSelection()) return

    makeEventListener(container, "mousedown", handleMouseDown)
    makeEventListener(container, "mousemove", handleMouseMove)
    makeEventListener(window, "mouseup", handleMouseUp)
    makeEventListener(document, "selectionchange", handleSelectionChange)
  })

  onCleanup(() => {
    clearReadyWatcher(ready)

    if (selectionFrame !== undefined) cancelAnimationFrame(selectionFrame)
    if (dragFrame !== undefined) cancelAnimationFrame(dragFrame)

    selectionFrame = undefined
    dragFrame = undefined
    dragStart = undefined
    dragEnd = undefined
    dragMoved = false
    bridge.reset()
    lastSelection = null
    pendingSelectionEnd = false
  })

  return {
    get wrapper() {
      return wrapper
    },
    set wrapper(v: HTMLDivElement) {
      wrapper = v
    },
    get container() {
      return container
    },
    set container(v: HTMLDivElement) {
      container = v
    },
    get overlay() {
      return overlay
    },
    set overlay(v: HTMLDivElement) {
      overlay = v
    },
    get dragStart() {
      return dragStart
    },
    get dragEnd() {
      return dragEnd
    },
    get lastSelection() {
      return lastSelection
    },
    set lastSelection(v: SelectedLineRange | null) {
      lastSelection = v
    },
    ready,
    bridge,
    rendered,
    setRendered,
    getRoot,
    getHost,
    find,
    scheduleSelectionUpdate,
  }
}

type Viewer = ReturnType<typeof useFileViewer>

type ModeAdapter = Omit<ViewerConfig, "enableLineSelection" | "selectedLines" | "commentedLines" | "onLineSelectionEnd">

type ModeConfig = {
  enableLineSelection: () => boolean
  selectedLines: () => SelectedLineRange | null | undefined
  commentedLines: () => SelectedLineRange[] | undefined
  onLineSelectionEnd: (range: SelectedLineRange | null) => void
}

type RenderTarget = {
  cleanUp: () => void
}

type AnnotationTarget<A> = {
  setLineAnnotations: (annotations: A[]) => void
  rerender: () => void
}

type VirtualStrategy = {
  get: () => Virtualizer | undefined
  cleanup: () => void
}

function useModeViewer(config: ModeConfig, adapter: ModeAdapter) {
  return useFileViewer({
    enableLineSelection: config.enableLineSelection,
    selectedLines: config.selectedLines,
    commentedLines: () => config.commentedLines() ?? [],
    onLineSelectionEnd: config.onLineSelectionEnd,
    ...adapter,
  })
}

function useSearchHandle(opts: {
  search: () => FileSearchControl | undefined
  find: ReturnType<typeof createFileFind>
}) {
  createEffect(() => {
    const search = opts.search()
    if (!search) return

    const handle = {
      focus: () => opts.find.focus(),
    } satisfies FileSearchHandle

    search.register(handle)
    onCleanup(() => search.register(null))
  })
}

function createLineCallbacks(opts: {
  viewer: Viewer
  normalize?: (range: SelectedLineRange | null) => SelectedLineRange | null | undefined
  onLineSelected?: (range: SelectedLineRange | null) => void
  onLineSelectionEnd?: (range: SelectedLineRange | null) => void
  onLineNumberSelectionEnd?: (selection: SelectedLineRange | null) => void
}) {
  const select = (range: SelectedLineRange | null) => {
    if (!opts.normalize) return range
    const next = opts.normalize(range)
    if (next !== undefined) return next
    return range
  }

  return {
    onLineSelected: (range: SelectedLineRange | null) => {
      const next = select(range)
      opts.viewer.lastSelection = next
      opts.onLineSelected?.(next)
    },
    onLineSelectionEnd: (range: SelectedLineRange | null) => {
      const next = select(range)
      opts.viewer.lastSelection = next
      opts.onLineSelectionEnd?.(next)
      if (!opts.viewer.bridge.consume(next)) return
      requestAnimationFrame(() => opts.onLineNumberSelectionEnd?.(next))
    },
  }
}

function useAnnotationRerender<A>(opts: {
  viewer: Viewer
  current: () => AnnotationTarget<A> | undefined
  annotations: () => A[]
}) {
  const applied = new WeakSet<AnnotationTarget<A>>()
  createEffect(() => {
    opts.viewer.rendered()
    const active = opts.current()
    if (!active) return
    const annotations = opts.annotations()
    // renderViewer always draws with empty annotations, so skip the extra rerender
    // when this instance has nothing applied and nothing to apply.
    if (annotations.length === 0 && !applied.has(active)) return
    if (annotations.length === 0) applied.delete(active)
    else applied.add(active)
    active.setLineAnnotations(annotations)
    active.rerender()
    requestAnimationFrame(() => opts.viewer.find.refresh({ reset: true }))
  })
}

function notifyRendered(opts: {
  viewer: Viewer
  isReady: (root: ShadowRoot) => boolean
  settleFrames?: number
  onReady: () => void
}) {
  notifyShadowReady({
    state: opts.viewer.ready,
    container: opts.viewer.container,
    getRoot: opts.viewer.getRoot,
    isReady: opts.isReady,
    settleFrames: opts.settleFrames,
    onReady: opts.onReady,
  })
}

function renderViewer<I extends RenderTarget>(opts: {
  viewer: Viewer
  current: I | undefined
  reset?: boolean
  create: () => I
  update?: (value: I) => void
  assign: (value: I) => void
  draw: (value: I) => void
  onReady: () => void
}) {
  clearReadyWatcher(opts.viewer.ready)
  const reset = opts.reset === true && opts.current !== undefined
  if (reset) opts.current?.cleanUp()
  const next = reset || !opts.current ? opts.create() : opts.current
  if (reset || !opts.current) {
    opts.viewer.container.innerHTML = ""
    opts.assign(next)
  } else {
    opts.update?.(next)
  }

  opts.draw(next)

  applyViewerScheme(opts.viewer.getHost())
  opts.viewer.setRendered((value) => value + 1)
  opts.onReady()
}

function preserve(viewer: Viewer) {
  const root = scrollParent(viewer.wrapper)
  if (!root) return () => {}

  const high = viewer.container.getBoundingClientRect().height
  if (!high) return () => {}

  const top = viewer.wrapper.getBoundingClientRect().top - root.getBoundingClientRect().top
  const prev = viewer.container.style.minHeight
  viewer.container.style.minHeight = `${Math.ceil(high)}px`

  let done = false
  return () => {
    if (done) return
    done = true
    viewer.container.style.minHeight = prev

    const next = viewer.wrapper.getBoundingClientRect().top - root.getBoundingClientRect().top
    const delta = next - top
    if (delta) root.scrollTop += delta
  }
}

function scrollParent(el: HTMLElement): HTMLElement | undefined {
  let parent = el.parentElement
  while (parent) {
    const style = getComputedStyle(parent)
    if (style.overflowY === "auto" || style.overflowY === "scroll") return parent
    parent = parent.parentElement
  }
}

function createLocalVirtualStrategy(host: () => HTMLDivElement | undefined, enabled: () => boolean): VirtualStrategy {
  let virtualizer: Virtualizer | undefined
  let root: Document | HTMLElement | undefined

  const release = () => {
    virtualizer?.cleanUp()
    virtualizer = undefined
    root = undefined
  }

  return {
    get: () => {
      if (!enabled()) {
        release()
        return
      }
      if (typeof document === "undefined") return

      const wrapper = host()
      if (!wrapper) return

      const next = scrollParent(wrapper) ?? document
      if (virtualizer && root === next) return virtualizer

      release()
      virtualizer = new Virtualizer()
      root = next
      virtualizer.setup(next, next instanceof Document ? undefined : wrapper)
      return virtualizer
    },
    cleanup: release,
  }
}

function createSharedVirtualStrategy(host: () => HTMLDivElement | undefined, enabled: () => boolean): VirtualStrategy {
  let shared: NonNullable<ReturnType<typeof acquireVirtualizer>> | undefined

  const release = () => {
    shared?.release()
    shared = undefined
  }

  return {
    get: () => {
      if (!enabled()) {
        release()
        return
      }
      if (shared) return shared.virtualizer

      const container = host()
      if (!container) return

      const result = acquireVirtualizer(container)
      if (!result) return
      shared = result
      return result.virtualizer
    },
    cleanup: release,
  }
}

function parseLine(node: HTMLElement) {
  if (!node.dataset.line) return
  const value = parseInt(node.dataset.line, 10)
  if (Number.isNaN(value)) return
  return value
}

function mouseHit(
  event: MouseEvent,
  line: (node: HTMLElement) => number | undefined,
  side?: (node: HTMLElement) => DiffSelectionSide | undefined,
): MouseHit {
  const path = event.composedPath()
  let numberColumn = false
  let value: number | undefined
  let branch: DiffSelectionSide | undefined

  for (const item of path) {
    if (!(item instanceof HTMLElement)) continue

    numberColumn = numberColumn || item.dataset.columnNumber != null
    if (value === undefined) value = line(item)
    if (branch === undefined && side) branch = side(item)

    if (numberColumn && value !== undefined && (side == null || branch !== undefined)) break
  }

  return {
    line: value,
    numberColumn,
    side: branch,
  }
}

function diffMouseSide(node: HTMLElement) {
  const type = node.dataset.lineType
  if (type === "change-deletion") return "deletions" satisfies DiffSelectionSide
  if (type === "change-addition" || type === "change-additions") return "additions" satisfies DiffSelectionSide
  if (node.dataset.code == null) return
  return node.hasAttribute("data-deletions") ? "deletions" : "additions"
}

function diffSelectionSide(node: Node | null) {
  const el = findElement(node)
  if (!el) return
  return findDiffSide(el)
}

// ---------------------------------------------------------------------------
// Shared JSX shell
// ---------------------------------------------------------------------------

function ViewerShell(props: {
  mode: "text" | "diff"
  viewer: ReturnType<typeof useFileViewer>
  class: string | undefined
  classList: ComponentProps<"div">["classList"] | undefined
}) {
  return (
    <div
      data-component="file"
      data-mode={props.mode}
      dir="ltr"
      style={styleVariables}
      class="relative outline-none"
      classList={{
        ...props.classList,
        [props.class ?? ""]: !!props.class,
      }}
      ref={(el) => (props.viewer.wrapper = el)}
      tabIndex={0}
      onPointerDown={props.viewer.find.onPointerDown}
      onFocus={props.viewer.find.onFocus}
    >
      <Show when={props.viewer.find.open()}>
        <FileSearchBar
          pos={props.viewer.find.pos}
          query={props.viewer.find.query}
          count={props.viewer.find.count}
          index={props.viewer.find.index}
          setInput={props.viewer.find.setInput}
          onInput={props.viewer.find.setQuery}
          onKeyDown={props.viewer.find.onInputKeyDown}
          onClose={props.viewer.find.close}
          onPrev={() => props.viewer.find.next(-1)}
          onNext={() => props.viewer.find.next(1)}
        />
      </Show>
      <div ref={(el) => (props.viewer.container = el)} />
      <div ref={(el) => (props.viewer.overlay = el)} class="pointer-events-none absolute inset-0 z-0" />
    </div>
  )
}

// ---------------------------------------------------------------------------
// TextViewer
// ---------------------------------------------------------------------------

function TextViewer<T>(props: TextFileProps<T>) {
  let instance: PierreFile<T> | VirtualizedFile<T> | undefined
  let viewer!: Viewer

  const [local, others] = splitProps(props, textKeys)

  const text = () => {
    const value = local.file.contents as unknown
    if (typeof value === "string") return value
    if (Array.isArray(value)) return value.join("\n")
    if (value == null) return ""
    // oxlint-disable-next-line no-base-to-string -- file contents cast to unknown, coercion is intentional
    return String(value)
  }

  const lineCount = () => {
    const value = text()
    const total = value.split("\n").length - (value.endsWith("\n") ? 1 : 0)
    return Math.max(1, total)
  }

  const bytes = createMemo(() => {
    const value = local.file.contents as unknown
    if (typeof value === "string") return value.length
    if (Array.isArray(value)) {
      return value.reduce(
        // oxlint-disable-next-line no-base-to-string -- array parts coerced intentionally
        (sum, part) => sum + (typeof part === "string" ? part.length + 1 : String(part).length + 1),
        0,
      )
    }
    if (value == null) return 0
    // oxlint-disable-next-line no-base-to-string -- file contents cast to unknown, coercion is intentional
    return String(value).length
  })

  const virtual = createMemo(() => bytes() > VIRTUALIZE_BYTES)

  const virtuals = createLocalVirtualStrategy(() => viewer.wrapper, virtual)

  const lineFromMouseEvent = (event: MouseEvent): MouseHit => mouseHit(event, parseLine)

  const applySelection = (range: SelectedLineRange | null) => {
    const current = instance
    if (!current) return false

    if (virtual()) {
      current.setSelectedLines(range)
      return true
    }

    const root = viewer.getRoot()
    if (!root) return false

    const total = lineCount()
    if (root.querySelectorAll("[data-line]").length < total) return false

    if (!range) {
      current.setSelectedLines(null)
      return true
    }

    const start = Math.min(range.start, range.end)
    const end = Math.max(range.start, range.end)
    if (start < 1 || end > total) {
      current.setSelectedLines(null)
      return true
    }

    if (!root.querySelector(`[data-line="${start}"]`) || !root.querySelector(`[data-line="${end}"]`)) {
      current.setSelectedLines(null)
      return true
    }

    const normalized = (() => {
      if (range.endSide != null) return { start: range.start, end: range.end }
      if (range.side !== "deletions") return range
      if (root.querySelector("[data-deletions]") != null) return range
      return { start: range.start, end: range.end }
    })()

    current.setSelectedLines(normalized)
    return true
  }

  const setSelectedLines = (range: SelectedLineRange | null) => {
    viewer.lastSelection = range
    applySelection(range)
  }

  const adapter: ModeAdapter = {
    lineFromMouseEvent,
    setSelectedLines,
    updateSelection: (preserveTextSelection) => {
      const root = viewer.getRoot()
      if (!root) return

      const selected = readShadowLineSelection({
        root,
        lineForNode: findFileLineNumber,
        sideForNode: findCodeSelectionSide,
        preserveTextSelection,
      })
      if (!selected) return

      setSelectedLines(selected.range)
      if (!preserveTextSelection || !selected.text) return
      restoreShadowTextSelection(root, selected.text)
    },
    buildDragSelection: () => {
      if (viewer.dragStart === undefined || viewer.dragEnd === undefined) return
      return { start: Math.min(viewer.dragStart, viewer.dragEnd), end: Math.max(viewer.dragStart, viewer.dragEnd) }
    },
    buildClickSelection: () => {
      if (viewer.dragStart === undefined) return
      return { start: viewer.dragStart, end: viewer.dragStart }
    },
    onDragStart: () => {},
    onDragMove: () => {},
    onDragReset: () => {},
    markCommented: markCommentedFileLines,
  }

  viewer = useModeViewer(
    {
      enableLineSelection: () => props.enableLineSelection === true,
      selectedLines: () => local.selectedLines,
      commentedLines: () => local.commentedLines,
      onLineSelectionEnd: (range) => local.onLineSelectionEnd?.(range),
    },
    adapter,
  )

  const lineCallbacks = createLineCallbacks({
    viewer,
    onLineSelected: (range) => local.onLineSelected?.(range),
    onLineSelectionEnd: (range) => local.onLineSelectionEnd?.(range),
    onLineNumberSelectionEnd: (range) => local.onLineNumberSelectionEnd?.(range),
  })

  const options = createMemo(() => ({
    ...createDefaultOptions<T>("unified"),
    ...others,
    ...lineCallbacks,
  }))

  const notify = () => {
    notifyRendered({
      viewer,
      isReady: (root) => {
        if (virtual()) return root.querySelector("[data-line]") != null
        return root.querySelectorAll("[data-line]").length >= lineCount()
      },
      onReady: () => {
        applySelection(viewer.lastSelection)
        viewer.find.refresh({ reset: true })
        local.onRendered?.()
      },
    })
  }

  useSearchHandle({
    search: () => local.search,
    find: viewer.find,
  })

  // -- render instance --

  createEffect(() => {
    const opts = options()
    const workerPool = getWorkerPool("none")
    const virtualizer = virtuals.get()

    renderViewer({
      viewer,
      current: instance,
      reset: instance !== undefined,
      create: () =>
        virtualizer
          ? new VirtualizedFile<T>(opts, virtualizer, codeMetrics, workerPool)
          : new PierreFile<T>(opts, workerPool),
      assign: (value) => {
        instance = value
      },
      draw: (value) => {
        const contents = text()
        value.render({
          file: typeof local.file.contents === "string" ? local.file : { ...local.file, contents },
          lineAnnotations: [],
          containerWrapper: viewer.container,
        })
      },
      onReady: notify,
    })
  })

  useAnnotationRerender<LineAnnotation<T>>({
    viewer,
    current: () => instance,
    annotations: () => (local.annotations as LineAnnotation<T>[] | undefined) ?? [],
  })

  // -- cleanup --

  onCleanup(() => {
    instance?.cleanUp()
    instance = undefined
    virtuals.cleanup()
  })

  return <ViewerShell mode="text" viewer={viewer} class={local.class} classList={local.classList} />
}

// ---------------------------------------------------------------------------
// DiffViewer
// ---------------------------------------------------------------------------

function DiffViewer<T>(props: DiffFileProps<T>) {
  let instance: FileDiff<T> | undefined
  let instanceVirtualizer: Virtualizer | undefined
  let instanceWorkerPool: ReturnType<typeof getWorkerPool>
  let instanceVirtualHunkSeparators: FileDiffOptions<T>["hunkSeparators"] | undefined
  let instanceFileDiff: FileDiffMetadata | undefined
  let instanceBefore: FileContents | undefined
  let instanceAfter: FileContents | undefined
  let dragSide: DiffSelectionSide | undefined
  let dragEndSide: DiffSelectionSide | undefined
  let viewer!: Viewer

  const [local, others] = splitProps(props, diffKeys)

  const mobile = createMediaQuery("(max-width: 640px)")

  const lineFromMouseEvent = (event: MouseEvent): MouseHit => mouseHit(event, findDiffLineNumber, diffMouseSide)

  const setSelectedLines = (range: SelectedLineRange | null, preserve?: { root: ShadowRoot; text: Range }) => {
    const active = instance
    if (!active) return

    const fixed = fixDiffSelection(viewer.getRoot(), range)
    if (fixed === undefined) {
      viewer.lastSelection = range
      return
    }

    viewer.lastSelection = fixed
    active.setSelectedLines(fixed)
    restoreShadowTextSelection(preserve?.root, preserve?.text)
  }

  const adapter: ModeAdapter = {
    lineFromMouseEvent,
    setSelectedLines,
    updateSelection: (preserveTextSelection) => {
      const root = viewer.getRoot()
      if (!root) return

      const selected = readShadowLineSelection({
        root,
        lineForNode: findDiffLineNumber,
        sideForNode: diffSelectionSide,
        preserveTextSelection,
      })
      if (!selected) return

      if (selected.text) {
        setSelectedLines(selected.range, { root, text: selected.text })
        return
      }

      setSelectedLines(selected.range)
    },
    buildDragSelection: () => {
      if (viewer.dragStart === undefined || viewer.dragEnd === undefined) return
      const selected: SelectedLineRange = { start: viewer.dragStart, end: viewer.dragEnd }
      if (dragSide) selected.side = dragSide
      if (dragEndSide && dragSide && dragEndSide !== dragSide) selected.endSide = dragEndSide
      return selected
    },
    buildClickSelection: () => {
      if (viewer.dragStart === undefined) return
      const selected: SelectedLineRange = { start: viewer.dragStart, end: viewer.dragStart }
      if (dragSide) selected.side = dragSide
      return selected
    },
    onDragStart: (hit) => {
      dragSide = hit.side
      dragEndSide = hit.side
    },
    onDragMove: (hit) => {
      dragEndSide = hit.side
    },
    onDragReset: () => {
      dragSide = undefined
      dragEndSide = undefined
    },
    markCommented: markCommentedDiffLines,
  }

  viewer = useModeViewer(
    {
      enableLineSelection: () => props.enableLineSelection === true,
      selectedLines: () => local.selectedLines,
      commentedLines: () => local.commentedLines,
      onLineSelectionEnd: (range) => local.onLineSelectionEnd?.(range),
    },
    adapter,
  )

  const virtuals = createSharedVirtualStrategy(
    () => viewer.container,
    () => local.virtualize !== false,
  )

  const large = createMemo(() => {
    if (local.fileDiff) {
      const before = local.fileDiff.deletionLines.join("")
      const after = local.fileDiff.additionLines.join("")
      return Math.max(before.length, after.length) > 500_000
    }

    const before = typeof local.before?.contents === "string" ? local.before.contents : ""
    const after = typeof local.after?.contents === "string" ? local.after.contents : ""
    return Math.max(before.length, after.length) > 500_000
  })

  const largeOptions = {
    lineDiffType: "none",
    maxLineDiffLength: 0,
    tokenizeMaxLineLength: 1,
  } satisfies Pick<FileDiffOptions<T>, "lineDiffType" | "maxLineDiffLength" | "tokenizeMaxLineLength">

  const lineCallbacks = createLineCallbacks({
    viewer,
    normalize: (range) => fixDiffSelection(viewer.getRoot(), range),
    onLineSelected: (range) => local.onLineSelected?.(range),
    onLineSelectionEnd: (range) => local.onLineSelectionEnd?.(range),
    onLineNumberSelectionEnd: (range) => local.onLineNumberSelectionEnd?.(range),
  })

  const options = createMemo<FileDiffOptions<T>>(() => {
    const base = {
      ...createDefaultOptions(props.diffStyle),
      ...others,
      ...lineCallbacks,
    }

    const perf = large() ? { ...base, ...largeOptions } : base
    if (!mobile()) return perf
    return { ...perf, disableLineNumbers: true }
  })

  const notify = (done?: VoidFunction) => {
    notifyRendered({
      viewer,
      isReady: (root) => root.querySelector("[data-line]") != null,
      settleFrames: 1,
      onReady: () => {
        done?.()
        setSelectedLines(viewer.lastSelection)
        viewer.find.refresh({ reset: true })
        local.onRendered?.()
      },
    })
  }

  useSearchHandle({
    search: () => local.search,
    find: viewer.find,
  })

  // -- render instance --

  createEffect(() => {
    const opts = options()
    const workerPool = getWorkerPool(opts.lineDiffType)
    const virtualizer = virtuals.get()
    const beforeContents = typeof local.before?.contents === "string" ? local.before.contents : ""
    const afterContents = typeof local.after?.contents === "string" ? local.after.contents : ""
    const done = preserve(viewer)

    onCleanup(done)

    const cacheKey = (contents: string) => {
      if (!large()) return sampledChecksum(contents, contents.length)
      return sampledChecksum(contents)
    }

    const before = local.before
      ? { ...local.before, contents: beforeContents, cacheKey: cacheKey(beforeContents) }
      : undefined
    const after = local.after
      ? { ...local.after, contents: afterContents, cacheKey: cacheKey(afterContents) }
      : undefined
    const targetChanged =
      local.fileDiff !== undefined
        ? instanceFileDiff !== local.fileDiff
        : instanceFileDiff !== undefined ||
          before === undefined ||
          after === undefined ||
          instanceBefore === undefined ||
          instanceAfter === undefined ||
          !areFilesEqual(instanceBefore, before) ||
          !areFilesEqual(instanceAfter, after)
    // Pierre beta virtualized instances retain their first diff target and resolve separator metrics at construction.
    // Plain timeline diffs can retain the instance as content streams; virtualized viewers reset only when that is unsafe.
    const reset =
      instance !== undefined &&
      (instanceVirtualizer !== virtualizer ||
        instanceWorkerPool !== workerPool ||
        (virtualizer !== undefined && (instanceVirtualHunkSeparators !== opts.hunkSeparators || targetChanged)))
    const forceRender = !reset && instance !== undefined && !areOptionsEqual(instance.options, opts)

    renderViewer({
      viewer,
      current: instance,
      reset,
      create: () =>
        virtualizer
          ? new VirtualizedFileDiff<T>(opts, virtualizer, virtualMetrics, workerPool)
          : new FileDiff<T>(opts, workerPool),
      update: (value) => value.setOptions(opts),
      assign: (value) => {
        instance = value
        instanceVirtualizer = virtualizer
        instanceWorkerPool = workerPool
        instanceVirtualHunkSeparators = virtualizer ? opts.hunkSeparators : undefined
        instanceFileDiff = local.fileDiff
        instanceBefore = before
        instanceAfter = after
      },
      draw: (value) => {
        if (local.fileDiff) {
          value.render({
            fileDiff: local.fileDiff,
            forceRender,
            lineAnnotations: [],
            containerWrapper: viewer.container,
          })
          return
        }

        if (!before || !after) return

        value.render({
          oldFile: before,
          newFile: after,
          forceRender,
          lineAnnotations: [],
          containerWrapper: viewer.container,
        })
      },
      onReady: () => notify(done),
    })
  })

  useAnnotationRerender<DiffLineAnnotation<T>>({
    viewer,
    current: () => instance,
    annotations: () => (local.annotations as DiffLineAnnotation<T>[] | undefined) ?? [],
  })

  // -- cleanup --

  onCleanup(() => {
    instance?.cleanUp()
    instance = undefined
    instanceVirtualizer = undefined
    instanceWorkerPool = undefined
    instanceVirtualHunkSeparators = undefined
    instanceFileDiff = undefined
    instanceBefore = undefined
    instanceAfter = undefined
    virtuals.cleanup()
    dragSide = undefined
    dragEndSide = undefined
  })

  return <ViewerShell mode="diff" viewer={viewer} class={local.class} classList={local.classList} />
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function File<T>(props: FileProps<T>) {
  if (props.mode === "text") {
    return <FileMedia media={props.media} fallback={() => TextViewer(props)} />
  }

  return <FileMedia media={props.media} fallback={() => DiffViewer(props)} />
}
