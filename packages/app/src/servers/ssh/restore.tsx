import { useSsh } from "./context"
import { createSshRestore } from "./restore-state"

export function SshRestore() {
  const ssh = useSsh()
  createSshRestore({
    state: () => ({ servers: ssh.servers }),
    start: ssh.restore,
  })
  return null
}
