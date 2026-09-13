import { createSimpleContext } from "@opencode/ui/context"
import { useDialog } from "@opencode/ui/context/dialog"
import { queryOptions, useQuery, useQueryClient } from "@tanstack/solid-query"
import { createEffect, onCleanup, untrack, type ParentProps } from "solid-js"
import { usePlatform } from "@/runtime/platform/platform"
import { useLanguage } from "@/runtime/i18n/language"
import { showToast } from "@/shell/notifications/toast"
import { createSshController } from "./controller"
import { DialogSsh } from "./dialog"
import type { SshState } from "./types"

const key = ["platform", "sshServers"] as const
const context = createSimpleContext({
  name: "Ssh",
  init: () => {
    const platform = usePlatform()
    const client = useQueryClient()
    const language = useLanguage()
    const query = useQuery(() =>
      queryOptions<SshState>({
        queryKey: key,
        queryFn: () => platform.sshServers?.getState() ?? Promise.resolve({ servers: [] }),
        staleTime: Infinity,
      }),
    )
    createEffect(() => {
      const off = platform.sshServers?.subscribe((state) => client.setQueryData(key, state))
      if (off) onCleanup(off)
    })
    return {
      get servers() {
        return query.data?.servers ?? []
      },
      get loading() {
        return query.isLoading
      },
      ...createSshController({
        items: () => query.data?.servers ?? [],
        api: platform.sshServers,
        refresh: () => query.refetch({ throwOnError: true }),
        error: () => showToast({ variant: "error", title: language.t("common.requestFailed") }),
      }),
    }
  },
})

export const useSsh = () => context.use()

export function SshProvider(props: ParentProps) {
  return (
    <context.provider>
      <SshDialogs />
      {props.children}
    </context.provider>
  )
}

function SshDialogs() {
  const ssh = useSsh()
  // Capture an owner inside the SSH context, independent of transient rows and menus.
  const dialog = useDialog()
  createEffect(() => {
    const item = ssh.dialog.next()
    if (!item || dialog.active) return
    ssh.dialog.opened(item.config.id)
    untrack(() => void dialog.push(() => <DialogSsh config={item.config} promptOnly />))
  })
  return null
}
