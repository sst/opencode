import { createMemo, createResource } from "solid-js"
import { useGlobal } from "@/runtime/server/runtime"
import { useLanguage } from "@/runtime/i18n/language"
import { usePlatform } from "@/runtime/platform/platform"
import { ServerConnection, useServers } from "@/runtime/server/registry"
import { useTabs } from "@/shell/tabs/tabs"
import { type ServerHealth } from "@/runtime/server/health"
import { showToast } from "@/shell/notifications/toast"
import { useSsh } from "../ssh/context"

function showRequestError(language: ReturnType<typeof useLanguage>, err: unknown) {
  showToast({
    variant: "error",
    title: language.t("common.requestFailed"),
    description: err instanceof Error ? err.message : String(err),
  })
}

function useDefaultServer() {
  const language = useLanguage()
  const platform = usePlatform()
  const [defaultKey, defaultKeyActions] = createResource(
    async () => {
      try {
        return (await platform.getDefaultServer?.()) ?? null
      } catch (err) {
        showRequestError(language, err)
        return null
      }
    },
    { initialValue: null },
  )

  const set = async (key: ServerConnection.Key | null) => {
    try {
      await platform.setDefaultServer?.(key)
      defaultKeyActions.mutate(key)
    } catch (err) {
      showRequestError(language, err)
    }
  }

  return {
    key: () => defaultKey.latest,
    available: createMemo(() => !!platform.getDefaultServer && !!platform.setDefaultServer),
    set,
  }
}

export function sortServerConnections(input: {
  servers: ServerConnection.Any[]
  health: Record<string, ServerHealth | undefined>
  defaultKey: ServerConnection.Key | null
}) {
  const order = new Map(input.servers.map((item, index) => [item, index] as const))
  const rank = (value?: ServerHealth) => {
    if (value?.healthy === true) return 0
    if (value?.healthy === false) return 2
    return 1
  }
  return input.servers.slice().sort((a, b) => {
    const preferred =
      Number(ServerConnection.key(b) === input.defaultKey) - Number(ServerConnection.key(a) === input.defaultKey)
    if (preferred !== 0) return preferred
    const health = rank(input.health[ServerConnection.key(a)]) - rank(input.health[ServerConnection.key(b)])
    if (health !== 0) return health
    return (order.get(a) ?? 0) - (order.get(b) ?? 0)
  })
}

export function useServerActionsController() {
  const server = useServers()
  const ssh = useSsh()
  const tabs = useTabs()
  const platform = usePlatform()
  const language = useLanguage()
  const defaults = useDefaultServer()

  const remove = async (key: ServerConnection.Key) => {
    try {
      if (key.startsWith("wsl:")) await platform.wslServers?.removeServer(key)
      if (key.startsWith("ssh:")) await ssh.forget(key.slice(4))
      tabs.removeServer(key)
      server.remove(key)
      if ((await platform.getDefaultServer?.()) === key) await defaults.set(null)
    } catch (err) {
      showRequestError(language, err)
    }
  }

  return {
    defaults,
    connection: {
      canRemove: server.canRemove,
      remove,
      canHide: (key: ServerConnection.Key) => {
        const conn = server.list.find((item) => ServerConnection.key(item) === key)
        return server.visible.length > 1 && !!conn && ServerConnection.builtin(conn)
      },
      isHidden: (key: ServerConnection.Key) => server.isHidden(key),
      setHidden: (key: ServerConnection.Key, hidden: boolean) => server.setHidden(key, hidden),
    },
  }
}

export type ServerActionsController = ReturnType<typeof useServerActionsController>

export function useServerCollectionController() {
  const server = useServers()
  const global = useGlobal()
  const actions = useServerActionsController()

  const items = createMemo(() => server.list)
  const sorted = createMemo(() =>
    sortServerConnections({
      servers: items(),
      health: global.servers.health,
      defaultKey: actions.defaults.key(),
    }),
  )

  return {
    collection: {
      items: sorted,
      health: () => global.servers.health,
    },
    ...actions,
  }
}

export type ServerCollectionController = ReturnType<typeof useServerCollectionController>
