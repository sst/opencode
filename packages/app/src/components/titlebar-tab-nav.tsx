import { createEffect, createMemo, createSignal, onCleanup, Show, type Ref } from "solid-js"
import { createStore } from "solid-js/store"
import { makeEventListener } from "@solid-primitives/event-listener"
import { createResizeObserver } from "@solid-primitives/resize-observer"
import { createMutation } from "@tanstack/solid-query"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { MenuV2 } from "@opencode-ai/ui/v2/menu-v2"
import { useGlobal } from "@/context/global"
import { useLanguage } from "@/context/language"
import { ServerConnection, serverName } from "@/context/server"
import { displayName, projectForSession } from "@/pages/layout/helpers"
import { SessionTabAvatar } from "@/pages/layout/session-tab-avatar"
import type { Session } from "@opencode-ai/sdk/v2"
import { canOpenTabRename, forwardTabRef } from "./titlebar-tab-gesture"
import { TabPreviewPopover } from "./titlebar-tab-popover"
import "./titlebar-tab-nav.css"

// MouseEvent.button uses 1 for the middle/wheel button.
const MIDDLE_MOUSE_BUTTON = 1

export function TabNavItem(props: {
  ref?: Ref<HTMLDivElement>
  href: string
  server: ServerConnection.Key
  session: () => Session | undefined
  fallbackTitle?: string
  onRename: (title: string) => Promise<void>
  onClose: () => void
  onNavigate: () => void
  active?: boolean
  forceTruncate?: boolean
  suppressNavigation?: () => boolean
  dragging?: boolean
  pressed?: boolean
  hidden?: boolean
}) {
  const language = useLanguage()
  const [menu, setMenu] = createStore({ open: false, rename: false })
  const [editing, setEditing] = createSignal(false)
  const [titleOverflowing, setTitleOverflowing] = createSignal(false)
  let tabRoot!: HTMLDivElement
  let titleEl!: HTMLSpanElement
  let measureFrame: number | undefined
  const rename = createMutation(() => ({ mutationFn: props.onRename }))

  const closeTab = (event: MouseEvent) => {
    event.preventDefault()
    event.stopPropagation()
    props.onClose()
  }
  const global = useGlobal()
  const serverCtx = createMemo(() => {
    const conn = global.servers.list().find((item) => ServerConnection.key(item) === props.server)
    if (conn) return global.ensureServerCtx(conn)
  })
  const project = createMemo(() => {
    const session = props.session()
    if (!session) return
    return projectForSession(session, serverCtx()?.projects.list() ?? [])
  })
  const title = createMemo(() => props.session()?.title ?? props.fallbackTitle)

  const projectName = createMemo(() => {
    const session = props.session()
    if (!session) return
    return displayName(project() ?? { worktree: session.directory })
  })
  const previewPath = createMemo(() => {
    const session = props.session()
    if (!session) return
    const home = serverCtx()?.sync.data.path.home
    return home ? session.directory.replace(home, "~") : session.directory
  })
  // Only label the server when multiple servers are connected.
  const serverLabel = createMemo(() => {
    if (global.servers.list().length <= 1) return
    const conn = global.servers.list().find((item) => ServerConnection.key(item) === props.server)
    return conn ? serverName(conn) : undefined
  })

  const [popoverOpen, setPopoverOpen] = createSignal(false)
  const previewBlocked = () => !!props.dragging || editing() || menu.open || !!props.pressed || !props.session()

  const measureTitleOverflow = () => {
    if (!titleEl || editing()) {
      setTitleOverflowing(false)
      return
    }
    setTitleOverflowing(titleEl.scrollWidth > titleEl.clientWidth)
  }

  const scheduleTitleOverflow = () => {
    if (measureFrame !== undefined) return
    measureFrame = requestAnimationFrame(() => {
      measureFrame = undefined
      measureTitleOverflow()
    })
  }

  createEffect(() => {
    title()
    props.forceTruncate
    editing()
    scheduleTitleOverflow()
  })

  createResizeObserver(() => tabRoot, scheduleTitleOverflow)
  onCleanup(() => {
    if (measureFrame !== undefined) cancelAnimationFrame(measureFrame)
  })

  const selectTitle = () => {
    const range = document.createRange()
    range.selectNodeContents(titleEl)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
  }

  const closeRename = async (save: boolean) => {
    if (rename.isPending || !editing()) return

    const original = props.session()?.title ?? ""
    const next = (titleEl.textContent ?? "").trim()

    titleEl.scrollLeft = 0
    setEditing(false)

    if (!save || !next || next === original) {
      return
    }

    await rename.mutateAsync(next)
  }

  createEffect(() => {
    if (editing()) return
    if (!titleEl) return
    const value = title()
    if (value === undefined) return
    titleEl.textContent = value
  })

  const openRename = (event?: MouseEvent) => {
    event?.preventDefault()
    event?.stopPropagation()
    if (!canOpenTabRename(props.dragging, editing(), rename.isPending)) return
    const session = props.session()
    if (!session) return
    titleEl.textContent = session.title
    setEditing(true)

    requestAnimationFrame(() => {
      titleEl.focus()
      selectTitle()
    })
  }

  createEffect(() => {
    if (!editing()) return

    const cleanup = makeEventListener(
      document,
      "pointerdown",
      (event) => {
        const target = event.target
        if (!(target instanceof Node)) return
        if (tabRoot.contains(target)) return
        void closeRename(true)
      },
      { capture: true },
    )

    onCleanup(cleanup)
  })

  const tab = () => (
    <div
      ref={(el) => {
        tabRoot = el
        forwardTabRef(props.ref, el)
      }}
      data-titlebar-tab
      data-slot="titlebar-tab-item"
      data-title-overflow={titleOverflowing()}
      data-editing={editing()}
      class="group relative flex h-7 w-full min-w-0 select-none flex-row items-center gap-1.5 overflow-hidden whitespace-nowrap rounded-[6px] px-1.5 [container-type:inline-size]"
      classList={{ invisible: props.hidden }}
      data-active={props.active}
      data-dragging={props.dragging}
      data-state={props.active || props.pressed ? "pressed" : undefined}
      onMouseDown={(event) => {
        if (event.button !== MIDDLE_MOUSE_BUTTON) return
        event.preventDefault()
        event.stopPropagation()
      }}
      onAuxClick={(event) => {
        if (event.button !== MIDDLE_MOUSE_BUTTON) return
        closeTab(event)
      }}
    >
      <MenuV2.Context.Trigger
        as="a"
        disabled={editing() || props.dragging}
        aria-haspopup="menu"
        aria-expanded={menu.open}
        data-slot="tab-link"
        data-titlebar-tab-link
        href={props.href}
        draggable={false}
        onDragStart={(event) => {
          event.preventDefault()
          event.stopPropagation()
        }}
        onMouseDown={(event) => {
          // Navigate on mousedown to shave the press-release delay off tab switches.
          if (event.button !== 0) return
          if (editing()) return
          if (props.suppressNavigation?.()) return
          props.onNavigate()
        }}
        onClick={(event) => {
          event.preventDefault()
          // Mouse navigation already happened on mousedown; detail 0 means keyboard activation.
          if (event.detail > 0) return
          if (editing()) return
          if (props.suppressNavigation?.()) return
          props.onNavigate()
        }}
        class="flex h-full min-w-0 flex-1 flex-row items-center gap-1.5 text-[13px] font-medium text-v2-text-text-faint group-data-[active='true']:text-v2-text-text-base group-data-[editing='true']:text-v2-text-text-base [-webkit-user-drag:none]"
      >
        <span data-slot="project-avatar-slot" class="flex size-4 shrink-0 items-center justify-center">
          <Show
            when={props.session()}
            keyed
            fallback={
              <span class="block size-4 rounded-[3px] border border-v2-border-border-muted" aria-hidden="true" />
            }
          >
            {(session) => (
              <SessionTabAvatar
                project={project()}
                directory={session.directory}
                sessionId={session.id}
                server={props.server}
              />
            )}
          </Show>
        </span>
        <span
          ref={(el) => {
            titleEl = el
            titleEl.textContent = title() ?? ""
          }}
          data-slot="tab-title"
          data-titlebar-tab-title
          class="min-w-0 flex-1 outline-none leading-4"
          classList={{
            "overflow-hidden text-clip whitespace-nowrap": !editing(),
            "select-text": editing(),
          }}
          contenteditable={editing() ? true : undefined}
          onDblClick={openRename}
          onKeyDown={(event) => {
            event.stopPropagation()
            if (event.key === "Enter") {
              event.preventDefault()
              void closeRename(true)
              return
            }
            if (event.key !== "Escape") return
            event.preventDefault()
            titleEl.textContent = props.session()?.title ?? ""
            void closeRename(false)
          }}
          onBlur={() => void closeRename(true)}
          onPointerDown={(event) => {
            if (!editing()) return
            event.stopPropagation()
          }}
          onClick={(event) => {
            if (!editing()) return
            event.preventDefault()
          }}
        />
      </MenuV2.Context.Trigger>

      <div data-slot="tab-close">
        <IconButtonV2
          size="small"
          variant="ghost-muted"
          class="hover-reveal relative z-10 group-hover:opacity-100 group-data-[active=true]:opacity-100 group-data-[editing=true]:opacity-100"
          onPointerDown={(event) => {
            event.preventDefault()
            event.stopPropagation()
          }}
          onClick={closeTab}
          icon={<IconV2 name="xmark-small" />}
          aria-label={language.t("common.closeTab")}
        />
      </div>
    </div>
  )

  return (
    <MenuV2.Context
      onOpenChange={(open) => {
        setMenu("open", open)
        if (open) setPopoverOpen(false)
      }}
    >
      <TabPreviewPopover
        trigger={tab()}
        open={popoverOpen() && !previewBlocked()}
        onOpenChange={(value) => {
          if (value && previewBlocked()) return
          setPopoverOpen(value)
        }}
        data={{
          projectName: projectName(),
          title: props.session()?.title,
          path: previewPath(),
          serverName: serverLabel(),
        }}
      />
      <MenuV2.Context.Portal>
        <MenuV2.Context.Content
          onCloseAutoFocus={(event) => {
            if (!menu.rename) return
            event.preventDefault()
            setMenu("rename", false)
            openRename()
          }}
        >
          <MenuV2.Item disabled={!props.session() || rename.isPending} onSelect={() => setMenu("rename", true)}>
            {language.t("common.rename")}
          </MenuV2.Item>
          <MenuV2.Item onSelect={props.onClose}>{language.t("common.closeTab")}</MenuV2.Item>
        </MenuV2.Context.Content>
      </MenuV2.Context.Portal>
    </MenuV2.Context>
  )
}

export function DraftTabItem(props: {
  ref?: Ref<HTMLDivElement>
  href: string
  title: string
  active?: boolean
  onNavigate: () => void
  onClose: () => void
  suppressNavigation?: () => boolean
  dragging?: boolean
  pressed?: boolean
  hidden?: boolean
}) {
  const language = useLanguage()
  const closeTab = (event: MouseEvent) => {
    event.preventDefault()
    event.stopPropagation()
    props.onClose()
  }
  return (
    <div
      ref={(el) => forwardTabRef(props.ref, el)}
      data-titlebar-tab
      data-slot="titlebar-tab-item"
      data-active={props.active}
      data-dragging={props.dragging}
      data-state={props.active || props.pressed ? "pressed" : undefined}
      class="group relative flex h-7 w-full min-w-0 flex-row items-center gap-1.5 overflow-hidden rounded-[6px] px-1.5 [container-type:inline-size] whitespace-nowrap"
      classList={{ invisible: props.hidden }}
      onMouseDown={(event) => {
        if (event.button !== MIDDLE_MOUSE_BUTTON) return
        event.preventDefault()
        event.stopPropagation()
      }}
      onAuxClick={(event) => {
        if (event.button !== MIDDLE_MOUSE_BUTTON) return
        closeTab(event)
      }}
    >
      <a
        data-slot="tab-link"
        data-titlebar-tab-link
        href={props.href}
        draggable={false}
        onDragStart={(event) => {
          event.preventDefault()
          event.stopPropagation()
        }}
        onMouseDown={(event) => {
          // Navigate on mousedown to shave the press-release delay off tab switches.
          if (event.button !== 0) return
          if (props.suppressNavigation?.()) return
          props.onNavigate()
        }}
        onClick={(event) => {
          event.preventDefault()
          // Mouse navigation already happened on mousedown; detail 0 means keyboard activation.
          if (event.detail > 0) return
          if (props.suppressNavigation?.()) return
          props.onNavigate()
        }}
        class="flex h-full min-w-0 flex-1 flex-row items-center gap-1.5 text-[13px] font-medium text-v2-text-text-faint group-data-[active='true']:text-v2-text-text-base [-webkit-user-drag:none]"
      >
        <span class="flex size-4 shrink-0 items-center justify-center">
          <IconV2 name="edit" />
        </span>
        <span
          data-titlebar-tab-title
          class="min-w-0 flex-1 overflow-hidden text-clip whitespace-nowrap outline-none leading-4"
        >
          {props.title}
        </span>
      </a>
      <div data-slot="tab-close">
        <IconButtonV2
          size="small"
          variant="ghost-muted"
          onPointerDown={(event) => {
            event.preventDefault()
            event.stopPropagation()
          }}
          onMouseDown={(event) => {
            event.preventDefault()
            event.stopPropagation()
          }}
          class="hover-reveal relative z-10 group-hover:opacity-100 group-data-[active=true]:opacity-100 group-data-[editing=true]:opacity-100"
          onClick={closeTab}
          icon={<IconV2 name="xmark-small" />}
          aria-label={language.t("common.closeTab")}
        />
      </div>
    </div>
  )
}
