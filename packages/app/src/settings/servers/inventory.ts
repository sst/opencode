import { createMemo } from "solid-js"
import { ServerConnection, serverName, useServers } from "@/runtime/server/registry"
import { useWslServers } from "@/servers/wsl/context"
import type { WslServerItem } from "@/servers/wsl/types"
import { useSsh } from "@/servers/ssh/context"
import { sshName, type SshItem } from "@/servers/ssh/types"
import type { ServerCtx } from "@/runtime/server/runtime"
import { pathKey } from "@/workspaces/path-key"

export function settingsProjects(context: ServerCtx) {
  const tracked = context.projects.list()
  const paths = new Set(tracked.map((project) => pathKey(project.worktree)))
  return [
    ...tracked,
    ...context.sync.data.project
      .filter((project) => !paths.has(pathKey(project.worktree)))
      .map((project) => ({ ...project, expanded: false })),
  ]
}

export type SettingsServer = {
  key: ServerConnection.Key
  name: string
  connection?: ServerConnection.Any
  wsl?: WslServerItem
  ssh?: SshItem
}

export function settingsServers(
  connections: readonly ServerConnection.Any[],
  wsl: readonly WslServerItem[],
  ssh: readonly SshItem[],
) {
  const configured = new Map(wsl.map((item) => [item.config.id, item]))
  const saved = new Map(ssh.filter((item) => item.saved).map((item) => [`ssh:${item.config.id}`, item]))
  const connected = new Set(connections.map(ServerConnection.key))
  return [
    ...connections.map((connection): SettingsServer => {
      const key = ServerConnection.key(connection)
      const item = configured.get(key)
      const remote = saved.get(key)
      return {
        key,
        name: item?.config.distro ?? (remote ? sshName(remote.config) : serverName(connection) || key),
        connection:
          (item && item.runtime.kind !== "ready") || (remote && remote.stage !== "ready") ? undefined : connection,
        wsl: item,
        ssh: remote,
      }
    }),
    ...wsl
      .filter((item) => !connected.has(ServerConnection.Key.make(item.config.id)))
      .map(
        (item): SettingsServer => ({
          key: ServerConnection.Key.make(item.config.id),
          name: item.config.distro,
          wsl: item,
        }),
      ),
    ...ssh
      .filter((item) => item.saved && !connected.has(ServerConnection.Key.make(`ssh:${item.config.id}`)))
      .map(
        (item): SettingsServer => ({
          key: ServerConnection.Key.make(`ssh:${item.config.id}`),
          name: sshName(item.config),
          ssh: item,
        }),
      ),
  ]
}

export function useSettingsServers() {
  const servers = useServers()
  const wsl = useWslServers()
  const ssh = useSsh()
  return createMemo(() => settingsServers(servers.list, wsl.data?.servers ?? [], ssh.servers))
}
