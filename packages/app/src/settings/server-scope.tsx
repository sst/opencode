import { type ParentProps } from "solid-js"
import { ModelsProvider } from "@/providers/models/models"
import { ServerProvider } from "@/runtime/server/current"
import { ServerConnection } from "@/runtime/server/registry"

export function SettingsServerDataScope(props: ParentProps<{ server: ServerConnection.Any; directory?: string }>) {
  return (
    <ServerProvider conn={props.server}>
      <ModelsProvider directory={props.directory}>{props.children}</ModelsProvider>
    </ServerProvider>
  )
}
