import { useSsh } from "./context"
import type { ServerConnection } from "@/runtime/server/registry"

export function useSshAuthenticate() {
  const ssh = useSsh()
  return (server: ServerConnection.Any, onConnected?: () => void) => {
    if (server.type !== "ssh" || !server.authenticationRequired) return false
    const item = ssh.servers.find((item) => item.config.id === server.id)
    if (!item) return false
    ssh.connect(item.config, { onConnected })
    return true
  }
}
