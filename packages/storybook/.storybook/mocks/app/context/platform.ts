import type { Platform } from "../../../../../app/src/runtime/platform/platform"
import { createComponent, createContext, useContext, type ParentProps } from "solid-js"

const value: Platform = {
  platform: "web",
  openExternal() {},
  restart: async () => {},
  notify: async () => {},
  fetch: globalThis.fetch.bind(globalThis),
}

const Context = createContext<Platform>(value)

export function PlatformProvider(props: ParentProps<{ value: Platform }>) {
  return createComponent(Context.Provider, {
    value: props.value,
    get children() {
      return props.children
    },
  })
}

export function usePlatform() {
  return useContext(Context)
}
