import { base64Encode } from "@opencode-ai/core/util/encode"
import { makeEventListener } from "@solid-primitives/event-listener"
import { onMount } from "solid-js"
import {
  collectNewSessionDeepLinks,
  collectOpenProjectDeepLinks,
  deepLinkEvent,
  drainPendingDeepLinks,
} from "./deep-links"

export function useDeepLinks(options: {
  enabled: () => boolean
  openProject: (directory: string) => Promise<void>
  navigate: (href: string) => void
  prepareNewSession?: (link: { directory: string; prompt?: string }) => void
}) {
  function handleDeepLinks(urls: string[]) {
    if (!options.enabled()) return

    for (const directory of collectOpenProjectDeepLinks(urls)) {
      void options.openProject(directory).then(() => {
        options.navigate(`/${base64Encode(directory)}/session`)
      })
    }

    for (const link of collectNewSessionDeepLinks(urls)) {
      void options.openProject(link.directory).then(() => {
        options.prepareNewSession?.(link)
        const slug = base64Encode(link.directory)
        const href = link.prompt
          ? `/${slug}/session?prompt=${encodeURIComponent(link.prompt)}`
          : `/${slug}/session`
        options.navigate(href)
      })
    }
  }

  onMount(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ urls: string[] }>).detail
      handleDeepLinks(detail?.urls ?? [])
    }
    handleDeepLinks(drainPendingDeepLinks(window))
    makeEventListener(window, deepLinkEvent, handler as EventListener)
  })

  return { handleDeepLinks }
}
