import { queryOptions, useQueryClient } from "@tanstack/solid-query"
import type { Accessor } from "solid-js"
import type { ServerConnection } from "@/runtime/server/registry"
import { useServerCtx, type ServerCtx } from "@/runtime/server/runtime"
import { normalizeProjectInfo } from "@/runtime/server/global-sync/utils"

export function workspaceInventoryQuery(context: ServerCtx) {
  return queryOptions({
    queryKey: [context.sdk.scope, "settings-workspace-inventory"],
    // One stored-inventory read. Location-scoped worktree.list performs live discovery and boots plugins.
    queryFn: async ({ signal }) =>
      (await context.sdk.api.worktree.inventory({ signal })).map((entry) =>
        normalizeProjectInfo({ ...entry.project, worktrees: entry.worktrees }),
      ),
    staleTime: 30_000,
  })
}

export function useWorkspacesPrefetch(server: Accessor<ServerConnection.Any | undefined>) {
  const client = useQueryClient()
  const context = useServerCtx(server)
  return () => {
    const current = context()
    if (!current || current.sdk.connection.status() !== "connected") return
    void client.prefetchQuery(workspaceInventoryQuery(current))
  }
}
