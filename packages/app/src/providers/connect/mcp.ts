import { useMutation } from "@tanstack/solid-query"
import type { Accessor } from "solid-js"
import { useLanguage } from "@/runtime/i18n/language"
import { useData } from "@/runtime/server/current"
import { useServerSDK } from "@/runtime/server/client"
import { usePlatform } from "@/runtime/platform/platform"
import { showToast } from "@/shell/notifications/toast"

export type McpControls = {
  readonly preview: boolean
  readonly states: Readonly<Record<string, boolean>>
  readonly pending: boolean
  change: (name: string, enabled: boolean) => void
}

export function useMcpToggle(directory?: Accessor<string | undefined>, onSuccess?: () => unknown) {
  const data = useData()
  const serverSDK = useServerSDK()
  const platform = usePlatform()
  const language = useLanguage()
  const location = () => {
    const value = directory ? directory() : data.location.default().directory
    return value ? { directory: value } : undefined
  }

  return useMutation(() => ({
    mutationFn: async (input: string | { name: string; enabled: boolean; directory?: string }) => {
      const name = typeof input === "string" ? input : input.name
      const ref = typeof input !== "string" && input.directory ? { directory: input.directory } : location()
      const server = (await serverSDK.api.mcp.list({ location: ref })).data.find((item) => item.name === name)
      if (!server || (server.status.status === "pending" && typeof input === "string")) return
      const enabled = typeof input === "string" ? server.status.status !== "connected" : input.enabled
      if (!enabled) {
        await serverSDK.api.mcp.disconnect({ server: name, location: ref })
      }
      if (enabled && server.status.status !== "needs_auth") {
        await serverSDK.api.mcp.connect({ server: name, location: ref })
      }
      data.location.mcp.server.invalidate(ref)
      await data.location.mcp.server.sync(ref)
      const current = data.location.mcp.server.list(ref)?.find((item) => item.name === name)
      if (enabled && current?.status.status === "needs_auth" && current.integrationID) {
        const integration = await serverSDK.api.integration.get({ integrationID: current.integrationID, location: ref })
        const method = integration.data?.methods.find((item) => item.type === "oauth" && !item.form?.length)
        if (!method || method.type !== "oauth") throw new Error(language.t("mcp.auth.interactiveForm", { name }))
        const attempt = await serverSDK.api.integration.oauth.connect({
          integrationID: current.integrationID,
          methodID: method.id,
          location: ref,
        })
        platform.openExternal(attempt.data.url)
      }
      data.location.mcp.resource.invalidate(ref)
      await Promise.all([data.location.mcp.resource.sync(ref), onSuccess?.()])
      // A successful HTTP response can still leave the MCP connection in a failed state.
      const status = current?.status
      if (status?.status === "failed") throw new Error(`${name}: ${status.error}`)
    },
    onError: (error) =>
      showToast({
        variant: "error",
        title: language.t("common.requestFailed"),
        description: error instanceof Error ? error.message : String(error),
      }),
  }))
}
