import { createMemo } from "solid-js"
import { createStore } from "solid-js/store"
import { useMcpToggle, type McpControls } from "@/providers/connect/mcp"
import { useLanguage } from "@/runtime/i18n/language"
import { useServerSDK } from "@/runtime/server/client"
import { useServer } from "@/runtime/server/current"
import { useTabs } from "@/shell/tabs/tabs"
import { showToast } from "@/shell/notifications/toast"
import { useWorkspaceLocation } from "@/workspaces/location"

export function createDraftMcpControls(input: { draftID: string; worktree: () => string }) {
  const tabs = useTabs()
  const location = useWorkspaceLocation()
  const server = useServer()
  const sdk = useServerSDK()
  const language = useLanguage()
  const [store, setStore] = createStore<{
    preparing: boolean
    pending: Record<string, Promise<boolean> | undefined>
  }>({ preparing: false, pending: {} })
  const key = (worktree: string) => JSON.stringify([server.key, location().directory, worktree])
  const target = createMemo(() => key(input.worktree()))
  const preview = () => input.worktree() === "create"
  const directory = createMemo(() => {
    const selected = input.worktree()
    return selected === "main" || selected === "create" ? location().directory : selected
  })
  const states = createMemo(() => {
    const draft = tabs.store.find((tab) => tab.type === "draft" && tab.draftID === input.draftID)
    return draft?.type === "draft" && draft.mcp?.target === target() ? draft.mcp.states : {}
  })
  const toggle = useMcpToggle(directory)
  const controls: McpControls = {
    get preview() {
      return preview()
    },
    get states() {
      return states()
    },
    get pending() {
      return store.preparing || (!preview() && store.pending[directory()] !== undefined)
    },
    change(name, enabled) {
      if (controls.pending) return
      tabs.updateDraft(input.draftID, { mcp: { target: target(), states: { ...states(), [name]: enabled } } })
      if (preview()) return
      const current = directory()
      const request = toggle.mutateAsync({ name, enabled, directory: current }).then(
        () => true,
        () => false,
      )
      setStore("pending", current, request)
      void request.finally(() => setStore("pending", current, undefined))
    },
  }

  const apply = async (directory: string, states: Readonly<Record<string, boolean>>) => {
    const pending = store.pending[directory]
    if (pending && !(await pending)) return false
    const entries = Object.entries(states)
    if (entries.length === 0) return true
    const catalog = await sdk.api.mcp.list({ location: { directory } })
    const missing = entries.find(([name, enabled]) => enabled && !catalog.data.some((server) => server.name === name))
    if (missing) throw new Error(language.t("session.summary.mcp.unavailable", { name: missing[0] }))
    const results = await Promise.all(
      entries
        .filter(([name, enabled]) => {
          const server = catalog.data.find((server) => server.name === name)
          return server && (enabled ? server.status.status !== "connected" : server.status.status !== "disabled")
        })
        .map(([name, enabled]) =>
          toggle.mutateAsync({ name, enabled, directory }).then(
            () => true,
            () => false,
          ),
        ),
    )
    if (results.some((success) => !success)) return false
    const current = await sdk.api.mcp.list({ location: { directory } })
    const unresolved = entries.find(([name, enabled]) => {
      const status = current.data.find((server) => server.name === name)?.status.status
      return enabled ? status !== "connected" : status !== undefined && status !== "disabled"
    })
    if (!unresolved) return true
    const status = current.data.find((server) => server.name === unresolved[0])?.status.status
    throw new Error(
      language.t(status === "needs_auth" ? "session.summary.mcp.signInBeforeSend" : "session.summary.mcp.notReady", {
        name: unresolved[0],
      }),
    )
  }

  return {
    controls,
    directory,
    capture: () => ({ ...states() }),
    remember(directory: string, states: Readonly<Record<string, boolean>>) {
      tabs.updateDraft(input.draftID, { mcp: { target: key(directory), states: { ...states } } })
    },
    async prepare(directory: string, states: Readonly<Record<string, boolean>>) {
      if (!store.pending[directory] && !Object.keys(states).length) return true
      setStore("preparing", true)
      return apply(directory, states)
        .catch((error) => {
          showToast({
            variant: "error",
            title: language.t("session.summary.mcp.prepareFailed"),
            description: error instanceof Error ? error.message : String(error),
          })
          return false
        })
        .finally(() => setStore("preparing", false))
    },
  }
}

export type DraftMcpControls = ReturnType<typeof createDraftMcpControls>
